package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"lixbon.com/cli/internal/config"
)

const (
	maxBodyBytes  = 32 << 20
	maxRedirects  = 5
	httpCloseWait = 2 * time.Second
)

// httpTransport es el transporte Streamable HTTP: cada mensaje es un POST y la
// respuesta llega como JSON o como un stream SSE. No abre el canal GET del
// servidor, así que no recibe peticiones ni notificaciones suyas.
type httpTransport struct {
	name    string
	url     string
	headers map[string]string
	client  *http.Client

	mu       sync.Mutex
	session  string
	protocol string
	closed   bool
}

func newHTTP(spec Spec) *httpTransport {
	return &httpTransport{
		name:    spec.Name,
		url:     spec.URL,
		headers: spec.Headers,
		client:  &http.Client{CheckRedirect: sameOriginOnly},
	}
}

// sameOriginOnly impide que una redirección lleve las cabeceras de
// autenticación a otro servidor.
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

func (t *httpTransport) setProtocol(version string) {
	t.mu.Lock()
	t.protocol = version
	t.mu.Unlock()
}

func (t *httpTransport) alive() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return !t.closed
}

func (t *httpTransport) newRequest(ctx context.Context, method string, body []byte) (*http.Request, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, t.url, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", config.UserAgent)
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
	}
	t.mu.Lock()
	if t.session != "" {
		req.Header.Set("Mcp-Session-Id", t.session)
	}
	if t.protocol != "" {
		req.Header.Set("MCP-Protocol-Version", t.protocol)
	}
	t.mu.Unlock()
	return req, nil
}

func (t *httpTransport) post(ctx context.Context, body []byte) (*http.Response, error) {
	req, err := t.newRequest(ctx, http.MethodPost, body)
	if err != nil {
		return nil, err
	}
	resp, err := t.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("no se pudo conectar con «%s»: %w", t.name, unwrapURLError(err))
	}
	if id := resp.Header.Get("Mcp-Session-Id"); id != "" {
		t.mu.Lock()
		t.session = id
		t.mu.Unlock()
	}
	if resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
		resp.Body.Close()
		return nil, fmt.Errorf("«%s» respondió %d: %s", t.name, resp.StatusCode, strings.TrimSpace(string(detail)))
	}
	return resp, nil
}

func unwrapURLError(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return urlErr.Err
	}
	return err
}

func (t *httpTransport) exchange(ctx context.Context, id int64, msg []byte) (rpcResponse, error) {
	resp, err := t.post(ctx, msg)
	if err != nil {
		return rpcResponse{}, err
	}
	defer resp.Body.Close()
	body := io.LimitReader(resp.Body, maxBodyBytes)
	if resp.StatusCode == http.StatusAccepted {
		return rpcResponse{}, fmt.Errorf("«%s» no devolvió respuesta", t.name)
	}
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		return readEventStream(body, strconv.FormatInt(id, 10), t.name)
	}
	raw, err := io.ReadAll(body)
	if err != nil {
		return rpcResponse{}, ctxOr(ctx, err)
	}
	var out rpcResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return rpcResponse{}, fmt.Errorf("«%s» devolvió una respuesta que no es JSON", t.name)
	}
	return out, nil
}

func ctxOr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

// readEventStream lee eventos SSE hasta encontrar la respuesta con el id dado.
func readEventStream(r io.Reader, id, name string) (rpcResponse, error) {
	reader := bufio.NewReaderSize(r, 64<<10)
	var data []string
	flush := func() (rpcResponse, bool) {
		if len(data) == 0 {
			return rpcResponse{}, false
		}
		payload := strings.Join(data, "\n")
		data = data[:0]
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			rpcResponse
		}
		if json.Unmarshal([]byte(payload), &msg) != nil || msg.Method != "" {
			return rpcResponse{}, false
		}
		return msg.rpcResponse, strings.TrimSpace(string(msg.ID)) == id
	}
	for {
		line, err := reader.ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "":
			if resp, ok := flush(); ok {
				return resp, nil
			}
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
		if err != nil {
			if resp, ok := flush(); ok {
				return resp, nil
			}
			if err == io.EOF {
				return rpcResponse{}, fmt.Errorf("«%s» cerró el stream sin responder", name)
			}
			return rpcResponse{}, err
		}
	}
}

func (t *httpTransport) notify(ctx context.Context, msg []byte) error {
	resp, err := t.post(ctx, msg)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
	return resp.Body.Close()
}

// close termina la sesión del servidor si tenía una (DELETE); un servidor que
// no lo admite responde 405 y no importa.
func (t *httpTransport) close() {
	t.mu.Lock()
	t.closed = true
	session := t.session
	t.mu.Unlock()
	if session == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), httpCloseWait)
	defer cancel()
	req, err := t.newRequest(ctx, http.MethodDelete, nil)
	if err != nil {
		return
	}
	if resp, err := t.client.Do(req); err == nil {
		resp.Body.Close()
	}
}
