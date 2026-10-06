package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const (
	// startTimeout deja margen a la primera ejecución de npx, que descarga el paquete.
	startTimeout   = 60 * time.Second
	callTimeout    = 120 * time.Second
	closeGrace     = 3 * time.Second
	maxResultChars = 20000
	maxListPages   = 50
	requestedProto = "2025-06-18"
)

var supportedProtocols = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

// Tool es una herramienta anunciada por un servidor.
type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

type rpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

type rpcResponse struct {
	Result json.RawMessage `json:"result"`
	Error  *rpcError       `json:"error"`
}

func (e *rpcError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("error %d", e.Code)
}

// transport mueve mensajes JSON-RPC ya serializados; no conoce el protocolo.
type transport interface {
	// exchange envía la petición id y espera su respuesta o el fin del contexto.
	exchange(ctx context.Context, id int64, msg []byte) (rpcResponse, error)
	notify(ctx context.Context, msg []byte) error
	setProtocol(version string)
	alive() bool
	close()
}

// Server es una conexión con un servidor MCP.
type Server struct {
	Spec Spec

	seq atomic.Int64

	mu      sync.Mutex
	tp      transport
	tools   []Tool
	err     string
	ready   bool
	closed  bool
	version string
}

func NewServer(spec Spec) *Server { return &Server{Spec: spec} }

func (s *Server) Tools() []Tool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.tools)
}

// Err es el motivo por el que el servidor no arrancó, vacío si va bien.
func (s *Server) Err() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.err
}

// Ready indica que el servidor completó el arranque y sus herramientas están listadas.
func (s *Server) Ready() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ready
}

func (s *Server) Alive() bool {
	s.mu.Lock()
	tp := s.tp
	s.mu.Unlock()
	return tp != nil && tp.alive()
}

// Start conecta, negocia el protocolo y lista las herramientas. Un fallo se
// guarda en Err y se devuelve; el servidor queda cerrado.
func (s *Server) Start(ctx context.Context) error {
	err := s.start(ctx)
	if err != nil {
		s.mu.Lock()
		s.err = err.Error()
		tp := s.tp
		s.tp = nil
		s.mu.Unlock()
		if tp != nil {
			tp.close()
		}
	}
	return err
}

func (s *Server) start(ctx context.Context) error {
	tp, err := newTransport(ctx, s.Spec)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		tp.close()
		return errors.New("cerrado antes de arrancar")
	}
	s.tp = tp
	s.mu.Unlock()

	result, err := s.request(ctx, "initialize", map[string]any{
		"protocolVersion": requestedProto,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "lixbon-cli", "version": "1"},
	}, startTimeout)
	if err != nil {
		return err
	}
	var init struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(result, &init)
	if init.ProtocolVersion != "" && !slices.Contains(supportedProtocols, init.ProtocolVersion) {
		return fmt.Errorf("«%s» usa el protocolo %s, que este cliente no soporta", s.Spec.Name, init.ProtocolVersion)
	}
	version := init.ProtocolVersion
	if version == "" {
		version = requestedProto
	}
	tp.setProtocol(version)
	if err := s.notify(ctx, "notifications/initialized", nil); err != nil {
		return err
	}
	tools, err := s.listTools(ctx)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.version, s.tools, s.ready = version, tools, true
	s.mu.Unlock()
	return nil
}

func (s *Server) listTools(ctx context.Context) ([]Tool, error) {
	var tools []Tool
	cursor := ""
	for page := 0; page < maxListPages; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		raw, err := s.request(ctx, "tools/list", params, startTimeout)
		if err != nil {
			return nil, err
		}
		var list struct {
			Tools      []Tool `json:"tools"`
			NextCursor string `json:"nextCursor"`
		}
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, fmt.Errorf("«%s» devolvió una lista de herramientas inválida", s.Spec.Name)
		}
		tools = append(tools, list.Tools...)
		if list.NextCursor == "" || list.NextCursor == cursor {
			return tools, nil
		}
		cursor = list.NextCursor
	}
	return tools, nil
}

func (s *Server) transport() (transport, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tp == nil || s.closed {
		return nil, fmt.Errorf("el servidor «%s» no está en marcha", s.Spec.Name)
	}
	return s.tp, nil
}

func (s *Server) request(ctx context.Context, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	tp, err := s.transport()
	if err != nil {
		return nil, err
	}
	id := s.seq.Add(1)
	msg, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	resp, err := tp.exchange(reqCtx, id, msg)
	if err != nil {
		if reqCtx.Err() != nil {
			s.cancelRequest(tp, id, method)
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("«%s» no respondió a %s en %.0fs", s.Spec.Name, method, timeout.Seconds())
		}
		return nil, err
	}
	if resp.Error != nil {
		return nil, resp.Error
	}
	return resp.Result, nil
}

// cancelRequest avisa al servidor de que ya no se espera la respuesta; la
// especificación prohíbe cancelar initialize.
func (s *Server) cancelRequest(tp transport, id int64, method string) {
	if method == "initialize" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.notifyOn(ctx, tp, "notifications/cancelled", map[string]any{"requestId": id, "reason": "cancelado por el usuario"})
}

func (s *Server) notify(ctx context.Context, method string, params any) error {
	tp, err := s.transport()
	if err != nil {
		return err
	}
	return s.notifyOn(ctx, tp, method, params)
}

func (s *Server) notifyOn(ctx context.Context, tp transport, method string, params any) error {
	body := map[string]any{"jsonrpc": "2.0", "method": method}
	if params != nil {
		body["params"] = params
	}
	msg, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return tp.notify(ctx, msg)
}

// CallTool ejecuta una herramienta y devuelve su resultado como texto.
func (s *Server) CallTool(ctx context.Context, tool string, args map[string]any) (string, error) {
	if args == nil {
		args = map[string]any{}
	}
	raw, err := s.request(ctx, "tools/call", map[string]any{"name": tool, "arguments": args}, callTimeout)
	if err != nil {
		return "", err
	}
	return FormatToolResult(raw), nil
}

// GetPrompt pide un prompt del servidor y devuelve sus mensajes de texto.
func (s *Server) GetPrompt(ctx context.Context, name string, args map[string]any) (string, error) {
	if args == nil {
		args = map[string]any{}
	}
	raw, err := s.request(ctx, "prompts/get", map[string]any{"name": name, "arguments": args}, callTimeout)
	if err != nil {
		return "", err
	}
	return PromptText(raw), nil
}

// Close cierra la conexión sin esperar más de closeGrace más un margen para
// matar el árbol de procesos.
func (s *Server) Close() {
	s.mu.Lock()
	s.closed = true
	tp := s.tp
	s.tp = nil
	s.mu.Unlock()
	if tp != nil {
		tp.close()
	}
}

// FormatToolResult convierte el resultado de tools/call en texto para el modelo.
func FormatToolResult(raw json.RawMessage) string {
	var result struct {
		Content []struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			MimeType string `json:"mimeType"`
			Resource *struct {
				URI  string `json:"uri"`
				Text string `json:"text"`
			} `json:"resource"`
		} `json:"content"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		IsError           bool            `json:"isError"`
	}
	_ = json.Unmarshal(raw, &result)
	var parts []string
	for _, item := range result.Content {
		switch item.Type {
		case "text":
			parts = append(parts, item.Text)
		case "image":
			parts = append(parts, fmt.Sprintf("[imagen %s: no se puede mostrar aquí]", item.MimeType))
		case "resource":
			if item.Resource == nil {
				parts = append(parts, "[recurso ]")
			} else if item.Resource.Text != "" {
				parts = append(parts, item.Resource.Text)
			} else {
				parts = append(parts, fmt.Sprintf("[recurso %s]", item.Resource.URI))
			}
		}
	}
	text := joinNonEmpty(parts)
	if text == "" && len(result.StructuredContent) > 0 && string(result.StructuredContent) != "null" {
		text = string(result.StructuredContent)
	}
	if text == "" {
		text = "(sin contenido)"
	}
	if utf8.RuneCountInString(text) > maxResultChars {
		text = truncateRunes(text, maxResultChars) + "\n…[recortado]"
	}
	if result.IsError {
		return "[ERROR] " + text
	}
	return text
}

// PromptText concatena los mensajes de texto de un resultado de prompts/get.
func PromptText(raw json.RawMessage) string {
	var result struct {
		Messages []struct {
			Content struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"messages"`
	}
	_ = json.Unmarshal(raw, &result)
	var texts []string
	for _, m := range result.Messages {
		if m.Content.Type == "text" {
			texts = append(texts, m.Content.Text)
		}
	}
	return strings.Join(texts, "\n\n")
}

func joinNonEmpty(parts []string) string {
	kept := parts[:0:0]
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// redactURL deja esquema, host y ruta: quita usuario, query y fragmento, donde
// suelen ir las credenciales.
func redactURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return truncateRunes(raw, 80)
	}
	return truncateRunes(u.Scheme+"://"+u.Host+u.Path, 80)
}
