package api

import (
	"context"
	"errors"
	"io"
	"iter"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"lixbon.com/cli/internal/sse"
)

const defaultStreamIdle = 300 * time.Second

type ChatRequest struct {
	Model          string           `json:"model"`
	Messages       []map[string]any `json:"messages"`
	ConversationID *string          `json:"conversation_id"`
	ClientID       string           `json:"client_id"`
	Title          *string          `json:"title"`
	Stream         bool             `json:"stream"`
	WebSearch      any              `json:"web_search"`
	Source         string           `json:"source"`
	NumCtx         int              `json:"num_ctx,omitempty"`
	Tools          []map[string]any `json:"tools,omitempty"`
	Think          any              `json:"think,omitempty"`
}

// generic es el cuerpo para un servidor compatible con OpenAI: OpenAI y otros
// rechazan los parámetros desconocidos (conversation_id, client_id, source…).
func (r ChatRequest) generic() map[string]any {
	body := map[string]any{
		"model": r.Model, "messages": r.Messages, "stream": true,
		"stream_options": map[string]any{"include_usage": true},
	}
	if len(r.Tools) > 0 {
		body["tools"] = r.Tools
	}
	return body
}

type ChatStream struct {
	body   io.ReadCloser
	cancel context.CancelFunc
	idle   *idleReader
}

// ChatStream abre el stream de chat. El POST se envía una sola vez: no hay
// reintentos automáticos que dupliquen un turno. Cancelar ctx (o llamar a
// Close) interrumpe incluso una lectura bloqueada por un SSE silencioso.
func (c *Client) ChatStream(ctx context.Context, req ChatRequest) (*ChatStream, error) {
	req.Stream = true
	req.Source = "cli"
	ctx, cancel := context.WithCancel(ctx)
	idle := newIdleReader(cancel, c.streamIdle())
	var payload any = req
	if c.Generic {
		payload = req.generic()
	}
	resp, err := c.open(ctx, http.MethodPost, c.BaseURL+"/chat/completions", payload, true)
	if err != nil {
		idle.stop()
		cancel()
		if idle.fired.Load() {
			return nil, idleError()
		}
		return nil, err
	}
	idle.body = resp.Body
	return &ChatStream{body: idle, cancel: cancel, idle: idle}, nil
}

func (s *ChatStream) Events() iter.Seq2[sse.Event, error] {
	return func(yield func(sse.Event, error) bool) {
		for ev, err := range sse.Events(s.body) {
			if err != nil && s.idle.fired.Load() {
				err = idleError()
			}
			if !yield(ev, err) {
				return
			}
		}
	}
}

func (s *ChatStream) Close() error {
	s.idle.stop()
	s.cancel()
	return s.body.Close()
}

func (c *Client) streamIdle() time.Duration {
	if c.StreamIdle > 0 {
		return c.StreamIdle
	}
	return defaultStreamIdle
}

func idleError() error {
	return &Error{Message: "Error de conexión: sin actividad del servidor"}
}

type idleReader struct {
	body  io.ReadCloser
	timer *time.Timer
	d     time.Duration
	fired atomic.Bool
}

func newIdleReader(cancel context.CancelFunc, d time.Duration) *idleReader {
	r := &idleReader{d: d}
	r.timer = time.AfterFunc(d, func() {
		r.fired.Store(true)
		cancel()
	})
	return r
}

func (r *idleReader) Read(p []byte) (int, error) {
	n, err := r.body.Read(p)
	if n > 0 && !errors.Is(err, context.Canceled) {
		r.timer.Reset(r.d)
	}
	return n, err
}

func (r *idleReader) Close() error { return r.body.Close() }

func (r *idleReader) stop() { r.timer.Stop() }

// Chat es una petición sin streaming ni historial, para trabajo interno del
// CLI (compactar el contexto). Devuelve el texto de la primera opción.
func (c *Client) Chat(ctx context.Context, model string, messages []map[string]any, clientID string) (string, error) {
	payload := map[string]any{
		"model": model, "messages": messages, "conversation_id": nil,
		"client_id": clientID, "title": "interno", "source": "cli",
	}
	if c.Generic {
		payload = map[string]any{"model": model, "messages": messages}
	}
	var data struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := c.doJSON(ctx, http.MethodPost, c.BaseURL+"/chat/completions", payload, 300*time.Second, true, &data); err != nil {
		return "", err
	}
	if len(data.Choices) == 0 {
		return "", nil
	}
	return strings.TrimSpace(data.Choices[0].Message.Content), nil
}

type DelegateResult struct {
	Response        string
	Model           string
	Type            string
	ExecutionTimeMS int
	Classification  map[string]any
}

// Delegate envía el mensaje al enrutador del gateway, que elige modelo y plan.
func (c *Client) Delegate(ctx context.Context, userInput string) (DelegateResult, error) {
	var data struct {
		Response string `json:"response"`
		Routing  struct {
			Model string `json:"model"`
			Type  string `json:"type"`
		} `json:"routing"`
		Classification  map[string]any `json:"classification"`
		ExecutionTimeMS int            `json:"execution_time_ms"`
	}
	if err := c.doJSON(ctx, http.MethodPost, c.Server+"/api/delegate", map[string]any{"user_input": userInput},
		180*time.Second, true, &data); err != nil {
		return DelegateResult{}, err
	}
	return DelegateResult{Response: data.Response, Model: data.Routing.Model, Type: data.Routing.Type,
		ExecutionTimeMS: data.ExecutionTimeMS, Classification: data.Classification}, nil
}
