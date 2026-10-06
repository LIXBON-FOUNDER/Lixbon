// Package api es el cliente HTTP del gateway Lixbon.
package api

import (
	"bytes"
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
	HTTP    *http.Client

	StreamIdle time.Duration
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
		HTTP:    &http.Client{Transport: transport},
	}
}

func (c *Client) open(ctx context.Context, method, url string, payload any, auth bool) (*http.Response, error) {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, &Error{Message: fmt.Sprintf("Error de conexión: %v", err)}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", config.UserAgent)
	if auth && c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
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
		return body
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

type Model struct {
	ID   string
	Name string
}

func (c *Client) ModelsDetail(ctx context.Context) ([]Model, error) {
	var data struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	if err := c.doJSON(ctx, http.MethodGet, c.BaseURL+"/models", nil, 20*time.Second, true, &data); err != nil {
		return nil, err
	}
	var models []Model
	for _, m := range data.Data {
		if m.ID == "" || strings.HasPrefix(m.ID, "error:") {
			continue
		}
		name := m.Name
		if name == "" {
			name = m.ID
		}
		models = append(models, Model{ID: m.ID, Name: name})
	}
	return models, nil
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
