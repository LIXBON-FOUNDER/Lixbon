// Package browser controla un Chromium instalado (Chrome, Edge, Brave…) por
// el protocolo DevTools (CDP), con un perfil propio de Lixbon.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

var errDisconnected = errors.New("se perdió la conexión con el navegador")

type cdpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data"`
}

func (e *cdpError) Error() string {
	if e.Data != "" {
		return e.Message + ": " + e.Data
	}
	return e.Message
}

type message struct {
	ID        int64           `json:"id,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *cdpError       `json:"error,omitempty"`
}

type subKey struct{ session, method string }

// conn es una conexión CDP a nivel de navegador; las pestañas se manejan con
// sesiones planas (flatten) sobre el mismo websocket.
type conn struct {
	ws     *websocket.Conn
	nextID atomic.Int64

	mu      sync.Mutex
	pending map[int64]chan message
	subs    map[subKey][]chan json.RawMessage
	onEvent func(session, method string, params json.RawMessage)

	done chan struct{}
	err  error
}

func dial(ctx context.Context, url string) (*conn, error) {
	// coder/websocket no manda cabecera Origin: Chrome 111+ rechaza las
	// conexiones con Origin salvo que se lance con --remote-allow-origins, y un
	// navegador al que solo nos adjuntamos no lo lleva.
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	// El límite por defecto (32 KB) corta las capturas y los snapshots.
	ws.SetReadLimit(64 << 20)
	c := &conn{
		ws:      ws,
		pending: map[int64]chan message{},
		subs:    map[subKey][]chan json.RawMessage{},
		done:    make(chan struct{}),
	}
	go c.read()
	return c, nil
}

func (c *conn) read() {
	var err error
	for {
		var data []byte
		_, data, err = c.ws.Read(context.Background())
		if err != nil {
			break
		}
		var msg message
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		if msg.ID != 0 {
			c.mu.Lock()
			ch := c.pending[msg.ID]
			delete(c.pending, msg.ID)
			c.mu.Unlock()
			if ch != nil {
				ch <- msg
			}
			continue
		}
		c.mu.Lock()
		subs := append([]chan json.RawMessage(nil), c.subs[subKey{msg.SessionID, msg.Method}]...)
		handler := c.onEvent
		c.mu.Unlock()
		for _, ch := range subs {
			select {
			case ch <- msg.Params:
			default:
			}
		}
		if handler != nil {
			handler(msg.SessionID, msg.Method, msg.Params)
		}
	}
	c.mu.Lock()
	c.err = err
	c.mu.Unlock()
	close(c.done)
}

func (c *conn) alive() bool {
	select {
	case <-c.done:
		return false
	default:
		return true
	}
}

func (c *conn) close() {
	_ = c.ws.Close(websocket.StatusNormalClosure, "")
	<-c.done
}

// call envía method y espera su respuesta; out puede ser nil.
func (c *conn) call(ctx context.Context, session, method string, params, out any) error {
	if params == nil {
		params = struct{}{}
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	id := c.nextID.Add(1)
	data, _ := json.Marshal(message{ID: id, Method: method, Params: raw, SessionID: session})
	reply := make(chan message, 1)
	c.mu.Lock()
	c.pending[id] = reply
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()
	if err := c.ws.Write(ctx, websocket.MessageText, data); err != nil {
		if !c.alive() {
			return errDisconnected
		}
		return err
	}
	select {
	case msg := <-reply:
		if msg.Error != nil {
			return fmt.Errorf("%s: %w", method, msg.Error)
		}
		if out != nil && len(msg.Result) > 0 {
			return json.Unmarshal(msg.Result, out)
		}
		return nil
	case <-c.done:
		return errDisconnected
	case <-ctx.Done():
		return ctx.Err()
	}
}

// on se suscribe a un evento. Hay que suscribirse ANTES de mandar el comando
// que lo provoca; los eventos que no caben en el buffer se descartan.
func (c *conn) on(session, method string) (<-chan json.RawMessage, func()) {
	ch := make(chan json.RawMessage, 16)
	key := subKey{session, method}
	c.mu.Lock()
	c.subs[key] = append(c.subs[key], ch)
	c.mu.Unlock()
	return ch, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		list := c.subs[key]
		for i, s := range list {
			if s == ch {
				c.subs[key] = append(list[:i], list[i+1:]...)
				break
			}
		}
	}
}

func (c *conn) setHandler(h func(session, method string, params json.RawMessage)) {
	c.mu.Lock()
	c.onEvent = h
	c.mu.Unlock()
}

// waitEvent espera un evento ya suscrito hasta timeout; false si no llegó.
func waitEvent(ctx context.Context, ch <-chan json.RawMessage, timeout time.Duration, match func(json.RawMessage) bool) bool {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case params := <-ch:
			if match == nil || match(params) {
				return true
			}
		case <-timer.C:
			return false
		case <-ctx.Done():
			return false
		}
	}
}

func isContextLost(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "Cannot find context") || strings.Contains(msg, "context was destroyed") ||
		strings.Contains(msg, "Execution context was destroyed") || strings.Contains(msg, "No frame with given id")
}
