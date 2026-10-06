package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"lixbon.com/cli/internal/config"
)

type fakeGateway struct {
	srv        *httptest.Server
	chatHits   atomic.Int32
	chatBody   map[string]any
	modelsCode int
	keyCode    int
	roleModel  string
	chat       http.HandlerFunc
}

func newFakeGateway(t *testing.T) *fakeGateway {
	t.Helper()
	g := &fakeGateway{modelsCode: 200, keyCode: 200}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if g.modelsCode != 200 {
			w.WriteHeader(g.modelsCode)
			io.WriteString(w, `{"detail":"no autorizado"}`)
			return
		}
		io.WriteString(w, `{"data":[{"id":"qwen","name":"Qwen"},{"id":"llama"}]}`)
	})
	mux.HandleFunc("/api/model-roles", func(w http.ResponseWriter, r *http.Request) {
		if g.roleModel == "" {
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, `{"roles":{"chat":{"model":"`+g.roleModel+`"}}}`)
	})
	mux.HandleFunc("/api/key/info", func(w http.ResponseWriter, r *http.Request) {
		if g.keyCode != 200 {
			w.WriteHeader(g.keyCode)
			io.WriteString(w, `{"detail":"no autorizado"}`)
			return
		}
		io.WriteString(w, `{"plan":{"name":"Pro"}}`)
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		g.chatHits.Add(1)
		g.chatBody = nil
		json.NewDecoder(r.Body).Decode(&g.chatBody)
		g.chat(w, r)
	})
	g.srv = httptest.NewServer(mux)
	t.Cleanup(g.srv.Close)
	return g
}

func sseHandler(events ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, ev := range events {
			io.WriteString(w, "data: "+ev+"\n\n")
		}
		io.WriteString(w, "data: [DONE]\n\n")
	}
}

func delta(text string) string {
	b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}})
	return string(b)
}

type harness struct {
	app    *App
	out    *bytes.Buffer
	errOut *bytes.Buffer
	path   string
}

func newHarness(t *testing.T, g *fakeGateway, cfg map[string]any) *harness {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	if cfg != nil {
		if _, ok := cfg["mode"]; !ok {
			cfg["mode"] = "ask"
		}
		if g != nil {
			cfg["base_url"] = g.srv.URL + "/v1"
		}
		raw, _ := json.Marshal(cfg)
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	h := &harness{out: &bytes.Buffer{}, errOut: &bytes.Buffer{}, path: path}
	h.app = &App{Stdout: h.out, Stderr: h.errOut, ConfigPath: path, Hostname: "test-host"}
	return h
}

func (h *harness) run(args ...string) int {
	return h.app.Run(context.Background(), args)
}

func TestStatus(t *testing.T) {
	h := newHarness(t, nil, map[string]any{"api_key": "lixbon_sk_abcdefghijklmn", "model": "qwen", "account_email": "a@b.c"})
	if code := h.run("status"); code != 0 {
		t.Fatalf("code %d", code)
	}
	for _, want := range []string{
		"lixbon CLI v" + config.Version, "- API key:             lixbon_sk_…klmn", "- Cuenta:              a@b.c",
		"- Modelo por defecto:  qwen", "- Ventana de contexto: 16384 tokens",
	} {
		if !strings.Contains(h.out.String(), want) {
			t.Errorf("falta %q en:\n%s", want, h.out)
		}
	}
}

func TestInitPreservesUnknownFieldsAndClamps(t *testing.T) {
	h := newHarness(t, nil, map[string]any{"plan_name": "Pro", "web_search": "on"})
	if code := h.run("init", "--api-key", " k ", "--model", "m", "--context-window", "10", "--max-context-messages", "0", "--mode", "ask", "--base-url", "http://x/v1/"); code != 0 {
		t.Fatalf("code %d: %s", code, h.errOut)
	}
	cfg := config.Load(h.path)
	if cfg.APIKey != "k" || cfg.Model != "m" || cfg.ContextWindow != 1024 || cfg.MaxContextMessages != 2 || cfg.Mode != "ask" || cfg.BaseURL != "http://x/v1" {
		t.Fatalf("cfg: %+v", cfg)
	}
	if cfg.ExtraString("plan_name") != "Pro" || cfg.WebMode() != "on" {
		t.Fatalf("extras perdidos: %v", cfg.Extra)
	}
	if code := h.run("init", "--mode", "otro"); code != 2 {
		t.Fatalf("modo inválido debe dar 2, dio %d", code)
	}
}

func TestModels(t *testing.T) {
	g := newFakeGateway(t)
	h := newHarness(t, g, map[string]any{"api_key": "k"})
	if code := h.run("models"); code != 0 {
		t.Fatalf("code %d", code)
	}
	if h.out.String() != "Modelos disponibles:\n- qwen\n- llama\n" {
		t.Fatalf("salida: %q", h.out)
	}
	g.modelsCode = 401
	h.out.Reset()
	if code := h.run("models"); code != 1 || !strings.Contains(h.out.String(), "No se pudieron listar los modelos: no autorizado") {
		t.Fatalf("code=%d salida=%q", code, h.out)
	}
	noKey := newHarness(t, g, map[string]any{})
	if code := noKey.run("models"); code != 1 || !strings.Contains(noKey.out.String(), "Primero inicia sesión") {
		t.Fatalf("sin key: %q", noKey.out)
	}
}

func TestChatOncePrintsStreamAndSendsContract(t *testing.T) {
	g := newFakeGateway(t)
	g.chat = sseHandler(delta("hola "), delta("mundo"),
		`{"lixbon_sources":[{"url":"https://a.test"},{"title":"B"},{}]}`)
	h := newHarness(t, g, map[string]any{"api_key": "k", "model": "qwen", "web_search": true})
	if code := h.run("chat", "--once", "saluda", "--client-id", "mi-pc", "--title", "T"); code != 0 {
		t.Fatalf("code %d: %s", code, h.errOut)
	}
	if want := "hola mundo\nfuentes  https://a.test  ·  B  ·  ?\n"; h.out.String() != want {
		t.Fatalf("stdout %q, want %q", h.out, want)
	}
	body := g.chatBody
	if body["model"] != "qwen" || body["client_id"] != "mi-pc" || body["title"] != "T" || body["web_search"] != true ||
		body["stream"] != true || body["source"] != "cli" || body["num_ctx"] != float64(16384) {
		t.Fatalf("payload: %v", body)
	}
	if id, _ := body["conversation_id"].(string); len(id) != 36 {
		t.Fatalf("conversation_id: %v", body["conversation_id"])
	}
	msgs := body["messages"].([]any)
	if len(msgs) != 1 || msgs[0].(map[string]any)["content"] != "saluda" {
		t.Fatalf("messages: %v", msgs)
	}
}

func TestChatOnceModelPrecedence(t *testing.T) {
	g := newFakeGateway(t)
	g.chat = sseHandler(delta("ok"))
	h := newHarness(t, g, map[string]any{"api_key": "k", "model": "cfg-model"})
	h.run("chat", "--once", "x", "--model", "flag-model")
	if g.chatBody["model"] != "flag-model" {
		t.Fatalf("--model debe ganar a config: %v", g.chatBody["model"])
	}
	h = newHarness(t, g, map[string]any{"api_key": "k", "model": "cfg-model", "key_model": "fija"})
	h.run("chat", "--once", "x", "--model", "flag-model")
	if g.chatBody["model"] != "fija" {
		t.Fatalf("key_model debe ganar a todo: %v", g.chatBody["model"])
	}
}

func TestChatOnceUsesServerRoleModelAndSavesIt(t *testing.T) {
	g := newFakeGateway(t)
	g.roleModel = "llama"
	g.chat = sseHandler(delta("ok"))
	h := newHarness(t, g, map[string]any{"api_key": "k"})
	if code := h.run("chat", "--once", "x"); code != 0 {
		t.Fatalf("code %d: %s", code, h.errOut)
	}
	if g.chatBody["model"] != "llama" || config.Load(h.path).Model != "llama" {
		t.Fatalf("modelo: %v / %q", g.chatBody["model"], config.Load(h.path).Model)
	}
}

func TestChatOnceWithoutModelFails(t *testing.T) {
	g := newFakeGateway(t)
	g.chat = sseHandler(delta("ok"))
	h := newHarness(t, g, map[string]any{"api_key": "k"})
	if code := h.run("chat", "--once", "x"); code != 1 || g.chatHits.Load() != 0 {
		t.Fatalf("code=%d hits=%d", code, g.chatHits.Load())
	}
}

func TestChatOnceRevokedKeyClearsSession(t *testing.T) {
	g := newFakeGateway(t)
	g.modelsCode, g.keyCode = 401, 401
	g.chat = sseHandler(delta("ok"))
	h := newHarness(t, g, map[string]any{"api_key": "k", "key_model": "m", "account_email": "a@b.c"})
	if code := h.run("chat", "--once", "x"); code != 1 {
		t.Fatalf("code %d", code)
	}
	cfg := config.Load(h.path)
	if cfg.APIKey != "" || cfg.KeyModel != "" || cfg.ExtraString("account_email") != "" {
		t.Fatalf("sesión no limpiada: %+v", cfg)
	}
	if g.chatHits.Load() != 0 || !strings.Contains(h.errOut.String(), "Tu sesión ya no es válida") {
		t.Fatalf("hits=%d stderr=%q", g.chatHits.Load(), h.errOut)
	}
}

func TestChatOnceErrorMessages(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   string
	}{
		{402, `{"detail":{"message":"Límite de la sesión alcanzado"}}`, "Sin créditos disponibles: Límite de la sesión alcanzado"},
		{429, `{"detail":"x"}`, "Demasiadas peticiones seguidas"},
		{403, `{"detail":"x"}`, "Tu sesión ya no es válida"},
		{500, `{"detail":"boom"}`, "boom"},
	}
	for _, c := range cases {
		g := newFakeGateway(t)
		g.chat = func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(c.status)
			io.WriteString(w, c.body)
		}
		h := newHarness(t, g, map[string]any{"api_key": "k", "model": "m"})
		if code := h.run("chat", "--once", "x"); code != 1 || !strings.Contains(h.errOut.String(), c.want) {
			t.Errorf("status %d: code=%d stderr=%q", c.status, code, h.errOut)
		}
		if g.chatHits.Load() != 1 {
			t.Errorf("status %d: POST enviado %d veces", c.status, g.chatHits.Load())
		}
	}
}

func TestChatOnceConnectionDropDoesNotRepeatPost(t *testing.T) {
	g := newFakeGateway(t)
	g.chat = func(w http.ResponseWriter, r *http.Request) {
		conn, _, _ := w.(http.Hijacker).Hijack()
		conn.Close()
	}
	h := newHarness(t, g, map[string]any{"api_key": "k", "model": "m"})
	if code := h.run("chat", "--once", "x"); code != 1 || g.chatHits.Load() != 1 {
		t.Fatalf("code=%d hits=%d stderr=%q", code, g.chatHits.Load(), h.errOut)
	}
}

func TestChatOnceCancelDuringSilentStream(t *testing.T) {
	g := newFakeGateway(t)
	g.chat = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+delta("parcial")+"\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}
	h := newHarness(t, g, map[string]any{"api_key": "k", "model": "m"})
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(300*time.Millisecond, cancel)
	done := make(chan int, 1)
	go func() { done <- h.app.Run(ctx, []string{"chat", "--once", "x"}) }()
	select {
	case code := <-done:
		if code != 0 || h.out.String() != "parcial\n" || !strings.Contains(h.errOut.String(), "interrumpido") {
			t.Fatalf("code=%d stdout=%q stderr=%q", code, h.out, h.errOut)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("--once no salió tras cancelar")
	}
}

func TestChatWithoutOnceAndUnknownCommand(t *testing.T) {
	h := newHarness(t, nil, map[string]any{"api_key": "k"})
	if code := h.run(); code != 1 || !strings.Contains(h.errOut.String(), "--once") {
		t.Fatalf("code=%d stderr=%q", code, h.errOut)
	}
	if code := h.run("nada"); code != 2 {
		t.Fatalf("comando desconocido debe dar 2, dio %d", code)
	}
	if code := h.run("chat", "--no-existe"); code != 2 {
		t.Fatalf("flag desconocida debe dar 2, dio %d", code)
	}
}
