package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/sse"
)

func newGateway(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New(srv.URL+"/v1", "lixbon_sk_test")
}

func TestFriendlyDetail(t *testing.T) {
	cases := map[string]string{
		`{"detail":"Cuota agotada"}`:                       "Cuota agotada",
		`{"detail":{"message":"Sin créditos","code":402}}`: "Sin créditos",
		`{"detail":{"code":1}}`:                            `{"code":1}`,
		`{"otro":1}`:                                       `{"otro":1}`,
		"error code: 1010":                                 "Conexión bloqueada por el filtro del servidor (error code: 1010).",
		"<html>502</html>":                                 "<html>502</html>",
	}
	for body, want := range cases {
		if got := friendlyDetail(body); got != want {
			t.Errorf("friendlyDetail(%s) = %q, want %q", body, got, want)
		}
	}
	long := strings.Repeat("é", 400)
	if got := friendlyDetail(long); len([]rune(got)) != 300 {
		t.Errorf("truncado a %d runas", len([]rune(got)))
	}
}

func TestModelsDetailFiltersAndNames(t *testing.T) {
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer lixbon_sk_test" {
			http.Error(w, "mal", 400)
			return
		}
		if r.Header.Get("User-Agent") != config.UserAgent {
			http.Error(w, "ua", 400)
			return
		}
		io.WriteString(w, `{"data":[{"id":"a","name":"Alfa"},{"id":"b"},{"id":"error:x"},{"name":"sin id"}]}`)
	})
	models, err := c.ModelsDetail(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 || models[0] != (Model{"a", "Alfa"}) || models[1] != (Model{"b", "b"}) {
		t.Fatalf("modelos: %+v", models)
	}
}

func TestHTTPErrorsCarryStatusAndDetail(t *testing.T) {
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusPaymentRequired)
		io.WriteString(w, `{"detail":{"message":"Límite de la sesión alcanzado"}}`)
	})
	_, err := c.ModelsDetail(context.Background())
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 402 || apiErr.Message != "Límite de la sesión alcanzado" {
		t.Fatalf("error: %#v", err)
	}
	if IsAuth(err) {
		t.Fatal("402 no es de autenticación")
	}
}

func TestConnectionErrorHasZeroStatus(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	_, err := New(url+"/v1", "k").ModelsDetail(context.Background())
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 0 || !strings.HasPrefix(apiErr.Message, "Error de conexión") {
		t.Fatalf("error: %#v", err)
	}
}

func TestRoleChatModelDegradesSilently(t *testing.T) {
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	if got := c.RoleChatModel(context.Background()); got != "" {
		t.Fatalf("got %q", got)
	}
	c = newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"roles":{"chat":{"model":"qwen"}}}`)
	})
	if got := c.RoleChatModel(context.Background()); got != "qwen" {
		t.Fatalf("got %q", got)
	}
}

func str(s string) *string { return &s }

func TestChatPayloadContract(t *testing.T) {
	var body map[string]json.RawMessage
	var auth string
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: [DONE]\n\n")
	})
	stream, err := c.ChatStream(context.Background(), ChatRequest{
		Model:     "m",
		Messages:  []map[string]any{{"role": "user", "content": "hola"}},
		ClientID:  "cli-x",
		Title:     str(""),
		WebSearch: "auto",
		NumCtx:    16384,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	for range stream.Events() {
	}
	want := map[string]string{
		"model": `"m"`, "conversation_id": `null`, "client_id": `"cli-x"`, "title": `""`,
		"stream": `true`, "web_search": `"auto"`, "source": `"cli"`, "num_ctx": `16384`,
		"messages": `[{"content":"hola","role":"user"}]`,
	}
	for key, value := range want {
		if got := string(body[key]); got != value {
			t.Errorf("%s = %s, want %s", key, got, value)
		}
	}
	for _, absent := range []string{"tools", "think"} {
		if _, ok := body[absent]; ok {
			t.Errorf("%s no debería enviarse", absent)
		}
	}
	if auth != "Bearer lixbon_sk_test" {
		t.Errorf("Authorization = %q", auth)
	}
}

func TestChatPayloadSendsThinkFalse(t *testing.T) {
	var body map[string]json.RawMessage
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&body)
		io.WriteString(w, "data: [DONE]\n\n")
	})
	stream, err := c.ChatStream(context.Background(), ChatRequest{Model: "m", Think: false, WebSearch: false})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	for range stream.Events() {
	}
	if string(body["think"]) != "false" || string(body["web_search"]) != "false" {
		t.Fatalf("think=%s web_search=%s", body["think"], body["web_search"])
	}
}

func TestChatStreamDeliversFragmentedEvents(t *testing.T) {
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		flusher := w.(http.Flusher)
		for _, piece := range []string{`data: {"choices":[{"delta":{"con`, `tent":"ho"}}]}` + "\r\n\r\n", ": keepalive\n\n", `data: {"choices":[{"delta":{"content":"la"}}]}` + "\n\ndata: [DONE]\n\n"} {
			io.WriteString(w, piece)
			flusher.Flush()
			time.Sleep(10 * time.Millisecond)
		}
	})
	stream, err := c.ChatStream(context.Background(), ChatRequest{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	var text strings.Builder
	var last sse.Kind
	for ev, err := range stream.Events() {
		if err != nil {
			t.Fatal(err)
		}
		text.WriteString(ev.Text)
		last = ev.Kind
	}
	if text.String() != "hola" || last != sse.Done {
		t.Fatalf("text=%q last=%s", text.String(), last)
	}
}

func TestChatPostIsNotRetried(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		conn, _, _ := w.(http.Hijacker).Hijack()
		conn.Close()
	}))
	defer srv.Close()
	_, err := New(srv.URL+"/v1", "k").ChatStream(context.Background(), ChatRequest{Model: "m"})
	var apiErr *Error
	if !errors.As(err, &apiErr) || apiErr.Status != 0 {
		t.Fatalf("error: %#v", err)
	}
	if hits.Load() != 1 {
		t.Fatalf("el POST se envió %d veces", hits.Load())
	}
}

func silentStreamServer(t *testing.T) *Client {
	return newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})
}

func TestCancelInterruptsSilentStream(t *testing.T) {
	c := silentStreamServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	stream, err := c.ChatStream(ctx, ChatRequest{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	time.AfterFunc(100*time.Millisecond, cancel)
	start := time.Now()
	var got error
	for _, err := range stream.Events() {
		got = err
	}
	if !errors.Is(got, context.Canceled) {
		t.Fatalf("error: %v", got)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("tardó %s en cancelar", elapsed)
	}
}

func TestCloseInterruptsSilentStream(t *testing.T) {
	c := silentStreamServer(t)
	stream, err := c.ChatStream(context.Background(), ChatRequest{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	time.AfterFunc(100*time.Millisecond, func() { stream.Close() })
	done := make(chan struct{})
	go func() {
		for range stream.Events() {
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close no liberó la lectura bloqueada")
	}
}

func TestIdleTimeoutEndsSilentStream(t *testing.T) {
	c := silentStreamServer(t)
	c.StreamIdle = 150 * time.Millisecond
	stream, err := c.ChatStream(context.Background(), ChatRequest{Model: "m"})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	var got error
	for _, err := range stream.Events() {
		got = err
	}
	var apiErr *Error
	if !errors.As(got, &apiErr) || !strings.Contains(apiErr.Message, "sin actividad") {
		t.Fatalf("error: %v", got)
	}
}

func TestModelsDetailSurfacesGatewayErrorEntries(t *testing.T) {
	c := newGateway(t, func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"data":[{"id":"error: sin nodos activos"}]}`)
	})
	_, err := c.ModelsDetail(context.Background())
	if err == nil || !strings.Contains(err.Error(), "sin nodos activos") {
		t.Fatalf("el motivo debe llegar al usuario: %v", err)
	}
}
