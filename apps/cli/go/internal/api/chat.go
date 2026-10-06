package api

import (
	"context"
	"errors"
	"io"
	"iter"
	"net/http"
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
	resp, err := c.open(ctx, http.MethodPost, c.BaseURL+"/chat/completions", req, true)
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
