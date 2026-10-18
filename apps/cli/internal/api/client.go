// Package api es el cliente HTTP del gateway Lixbon.
package api

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"lixbon.com/cli/internal/config"
)

const maxBodyBytes = 32 << 20

type Error struct {
	Message string
	Status  int
}

func (e *Error) Error() string { return e.Message }

func IsAuth(err error) bool {
	var apiErr *Error
	return errors.As(err, &apiErr) && (apiErr.Status == 401 || apiErr.Status == 403)
}

type Client struct {
	BaseURL string
	Server  string
	APIKey  string
	// Session existe tras un login por navegador y manda sobre APIKey.
	Session *Session
	HTTP    *http.Client
	// Generic es un servidor compatible con OpenAI que no es un gateway
	// Lixbon: solo recibe model, messages, stream y tools, y sus endpoints
	// /api quedan fuera de alcance.
	Generic bool

	StreamIdle time.Duration
}

var errNotGateway = &Error{Message: "Este proveedor no es un gateway Lixbon: esa función no está disponible."}

func FromConfig(cfg config.Config) *Client {
	c := New(cfg.BaseURL, cfg.APIKey)
	c.Generic = cfg.IsGeneric()
	if stored, ok := cfg.ActiveSession(); ok {
		c.Session = newSession(cfg, stored)
	}
	return c
}

// ForProfile es un cliente del perfil name aunque no sea el activo, con su
// sesión de navegador si la tiene.
func ForProfile(cfg config.Config, name string) *Client {
	p := cfg.Profiles()[name]
	c := New(p.BaseURL, p.APIKey)
	c.Generic = p.Generic
	if stored, ok := config.ReadSession(cfg.SessionFile(), name); ok && !p.Generic && stored.Server == c.Server {
		c.Session = &Session{path: cfg.SessionFile(), profile: name, stored: stored}
	}
	return c
}

// Configure apunta el cliente a otro proveedor conservando su identidad: la
// caja de herramientas guarda el mismo puntero.
func (c *Client) Configure(cfg config.Config) {
	fresh := FromConfig(cfg)
	c.BaseURL, c.Server, c.APIKey, c.Generic = fresh.BaseURL, fresh.Server, fresh.APIKey, fresh.Generic
	c.Session = fresh.Session
}

// SetKey usa una API key (o ninguna) y abandona la sesión de navegador.
func (c *Client) SetKey(key string) {
	c.APIKey, c.Session = key, nil
}

// StartSession guarda los tokens de un login por navegador y los usa desde ya.
// Un gateway anterior a las sesiones solo entrega un access, que se usa como key.
func (c *Client) StartSession(cfg config.Config, t Tokens) error {
	if t.Refresh == "" {
		c.SetKey(t.Access)
		return config.RemoveSession(cfg.SessionFile(), cfg.ActiveProfile())
	}
	stored := config.StoredSession{
		Server: config.ServerBase(cfg.BaseURL), Access: t.Access, Refresh: t.Refresh, ExpiresAt: t.ExpiresAt,
	}
	if err := config.WriteSession(cfg.SessionFile(), cfg.ActiveProfile(), stored); err != nil {
		return err
	}
	c.APIKey, c.Session = t.Access, newSession(cfg, stored)
	return nil
}

func (c *Client) bearer() string {
	if c.Session != nil {
		return c.Session.access()
	}
	return c.APIKey
}

// Bearer devuelve la credencial vigente, renovada si estaba a punto de caducar.
func (c *Client) Bearer(ctx context.Context) string {
	c.renewIfDue(ctx)
	return c.bearer()
}

func (c *Client) renewIfDue(ctx context.Context) {
	if c.Session != nil && c.Session.due() {
		_ = c.Session.renew(ctx, c, c.bearer())
	}
}

// New desactiva la compresión transparente: con gzip el transporte podría
// retener eventos SSE hasta llenar un bloque.
func New(baseURL, apiKey string) *Client {
	if baseURL == "" {
		baseURL = config.DefaultBaseURL
	}
	baseURL = strings.TrimRight(baseURL, "/")
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	return &Client{
		BaseURL: baseURL,
		Server:  config.ServerBase(baseURL),
		APIKey:  apiKey,
		HTTP:    &http.Client{Transport: transport, CheckRedirect: sameOriginOnly},
	}
}

const maxRedirects = 5

// sameOriginOnly impide que una redirección lleve la API key a otro servidor.
// Go solo quita Authorization si cambia el nombre de host, no el puerto.
func sameOriginOnly(req *http.Request, via []*http.Request) error {
	if len(via) >= maxRedirects {
		return errors.New("demasiadas redirecciones")
	}
	first := via[0].URL
	if req.URL.Host != first.Host || req.URL.Scheme != first.Scheme {
		return fmt.Errorf("redirección a otro servidor (%s) no permitida", req.URL.Host)
	}
	return nil
}

// open renueva el access antes de que caduque y, si aun así llega un 401 con
// sesión de navegador, renueva y repite la petición una vez.
func (c *Client) open(ctx context.Context, method, url string, payload any, auth bool) (*http.Response, error) {
	var encoded []byte
	if payload != nil {
		var err error
		if encoded, err = json.Marshal(payload); err != nil {
			return nil, err
		}
	}
	if !auth {
		return c.send(ctx, method, url, encoded, "")
	}
	c.renewIfDue(ctx)
	token := c.bearer()
	resp, err := c.send(ctx, method, url, encoded, token)
	var apiErr *Error
	if c.Session != nil && errors.As(err, &apiErr) && apiErr.Status == 401 && c.Session.renew(ctx, c, token) == nil {
		return c.send(ctx, method, url, encoded, c.bearer())
	}
	return resp, err
}

func (c *Client) send(ctx context.Context, method, url string, encoded []byte, token string) (*http.Response, error) {
	var body io.Reader
	if encoded != nil {
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, &Error{Message: fmt.Sprintf("Error de conexión: %v", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", config.UserAgent)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return nil, err
		}
		return nil, &Error{Message: fmt.Sprintf("Error de conexión: %v", err)}
	}
	if resp.StatusCode >= 400 {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
		return nil, &Error{Message: friendlyDetail(string(raw)), Status: resp.StatusCode}
	}
	return resp, nil
}

func (c *Client) doJSON(ctx context.Context, method, url string, payload any, timeout time.Duration, auth bool, out any) error {
	if c.Generic && strings.HasPrefix(url, c.Server+"/api/") {
		return errNotGateway
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	resp, err := c.open(ctx, method, url, payload, auth)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return &Error{Message: fmt.Sprintf("Error de conexión: %v", err)}
	}
	if out == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return &Error{Message: "Respuesta no válida del servidor."}
	}
	return nil
}

// providerMessage lee el error de los proveedores compatibles con OpenAI, que
// usan "error" o "message" en lugar del "detail" del gateway Lixbon.
func providerMessage(data map[string]json.RawMessage, fallback string) string {
	for _, key := range []string{"message", "error"} {
		var text string
		if json.Unmarshal(data[key], &text) == nil && text != "" {
			return text
		}
		var nested struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(data[key], &nested) == nil && nested.Message != "" {
			return nested.Message
		}
	}
	return fallback
}

func (e *Error) RateLimitText() string {
	text := "Demasiadas peticiones seguidas; espera unos segundos."
	if e.Message != "" {
		text += " Respuesta del servidor: " + e.Message
	}
	return text
}

func friendlyDetail(body string) string {
	if strings.Contains(body, "error code: 10") {
		return fmt.Sprintf("Conexión bloqueada por el filtro del servidor (%s).", truncateRunes(strings.TrimSpace(body), 40))
	}
	var data map[string]json.RawMessage
	if json.Unmarshal([]byte(body), &data) != nil {
		return truncateRunes(body, 300)
	}
	raw, ok := data["detail"]
	if !ok {
		return providerMessage(data, body)
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var detail map[string]json.RawMessage
	if json.Unmarshal(raw, &detail) == nil {
		var message string
		if json.Unmarshal(detail["message"], &message) == nil && message != "" {
			return message
		}
	}
	return string(raw)
}

func truncateRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n])
	}
	return s
}

// Model es un modelo de /v1/models. Capabilities usa los nombres de Ollama
// (completion, tools, vision, thinking…); nil significa que el servidor no
// las publica, no que no tenga ninguna.
type Model struct {
	ID           string
	Name         string
	Capabilities []string
	NumCtx       int
	Description  string
}

func (m Model) HasCapability(name string) bool {
	for _, c := range m.Capabilities {
		if c == name {
			return true
		}
	}
	return false
}

func (c *Client) ModelsDetail(ctx context.Context) ([]Model, error) {
	var data struct {
		Data []struct {
			ID           string   `json:"id"`
			Name         string   `json:"name"`
			Capabilities []string `json:"capabilities"`
			NumCtx       int      `json:"num_ctx"`
			Description  string   `json:"description"`
			// Cómo dicen la ventana otros proveedores: OpenRouter y Together
			// (context_length), Groq (context_window), LM Studio
			// (max_context_length), vLLM (max_model_len).
			ContextLength    int `json:"context_length"`
			ContextWindow    int `json:"context_window"`
			MaxContextLength int `json:"max_context_length"`
			MaxModelLen      int `json:"max_model_len"`
		} `json:"data"`
	}
	if err := c.doJSON(ctx, http.MethodGet, c.BaseURL+"/models", nil, 20*time.Second, true, &data); err != nil {
		return nil, err
	}
	var models []Model
	var failures []string
	for _, m := range data.Data {
		if strings.HasPrefix(m.ID, "error:") {
			failures = append(failures, strings.TrimSpace(strings.TrimPrefix(m.ID, "error:")))
			continue
		}
		if m.ID == "" {
			continue
		}
		name := m.Name
		if name == "" {
			name = m.ID
		}
		model := Model{ID: m.ID, Name: name}
		// Un proveedor compatible con OpenAI puede mandar campos con el mismo
		// nombre y otro significado: solo se leen de un gateway Lixbon.
		if !c.Generic {
			model.Capabilities, model.NumCtx, model.Description = m.Capabilities, m.NumCtx, m.Description
		} else {
			model.NumCtx = cmp.Or(m.ContextLength, m.ContextWindow, m.MaxContextLength, m.MaxModelLen)
		}
		models = append(models, model)
	}
	if len(models) == 0 && len(failures) > 0 {
		return nil, &Error{Message: "El servidor no pudo listar los modelos: " + strings.Join(failures, "; ")}
	}
	return models, nil
}

// ExplainListError distingue un servidor que no responde de uno que responde
// con error, p. ej. una URL base sin /v1: decir «¿está en marcha?» despista.
func ExplainListError(err error, host string) string {
	var apiErr *Error
	if errors.As(err, &apiErr) && apiErr.Status > 0 {
		return fmt.Sprintf("%s respondió HTTP %d al listar los modelos: %s. Revisa la URL base (suele terminar en /v1): lixbon profile set NOMBRE --base-url URL", host, apiErr.Status, apiErr.Message)
	}
	return "No se pudo contactar con " + host + ". ¿Está en marcha el servidor?"
}

func (c *Client) Models(ctx context.Context) ([]string, error) {
	detail, err := c.ModelsDetail(ctx)
	ids := make([]string, len(detail))
	for i, m := range detail {
		ids[i] = m.ID
	}
	return ids, err
}

// RoleChatModel devuelve "" ante cualquier error: un gateway antiguo responde
// 404 y no es un fallo del usuario.
func (c *Client) RoleChatModel(ctx context.Context) string {
	var data struct {
		Roles map[string]struct {
			Model string `json:"model"`
		} `json:"roles"`
	}
	if c.doJSON(ctx, http.MethodGet, c.Server+"/api/model-roles", nil, 15*time.Second, true, &data) != nil {
		return ""
	}
	return data.Roles["chat"].Model
}

func (c *Client) PlanName(ctx context.Context) (string, error) {
	var data struct {
		Plan struct {
			Name string `json:"name"`
		} `json:"plan"`
	}
	err := c.doJSON(ctx, http.MethodGet, c.Server+"/api/key/info", nil, 15*time.Second, true, &data)
	return data.Plan.Name, err
}

// WebSearch consulta el buscador del gateway; cada resultado conserva todos
// sus campos (title, url, snippet…).
func (c *Client) WebSearch(ctx context.Context, query string, limit int) ([]map[string]any, error) {
	var data struct {
		Results []map[string]any `json:"results"`
	}
	payload := map[string]any{"query": query, "limit": limit}
	if err := c.doJSON(ctx, http.MethodPost, c.Server+"/api/websearch", payload, 60*time.Second, true, &data); err != nil {
		return nil, err
	}
	return data.Results, nil
}

// APIStatus es el código HTTP del error (0 si no hubo respuesta).
func (e *Error) APIStatus() int { return e.Status }

// GenerateTitle pide al servidor el título de la conversación (el mismo
// endpoint que usan la web y la app) tras el primer intercambio.
func (c *Client) GenerateTitle(ctx context.Context, conversationID string) (string, error) {
	var data struct {
		Title string `json:"title"`
	}
	err := c.doJSON(ctx, http.MethodPost, c.Server+"/api/conversations/"+conversationID+"/generate-title",
		map[string]any{}, 30*time.Second, true, &data)
	return strings.TrimSpace(data.Title), err
}
