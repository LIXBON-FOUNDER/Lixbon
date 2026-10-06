package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"

	"lixbon.com/cli/internal/config"
)

type recorder struct {
	mu    sync.Mutex
	paths []string
	auth  []string
	body  map[string]any
}

func newRecorder(t *testing.T) (*recorder, string) {
	t.Helper()
	rec := &recorder{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec.mu.Lock()
		rec.paths = append(rec.paths, r.URL.Path)
		rec.auth = append(rec.auth, r.Header.Get("Authorization"))
		if r.Method == http.MethodPost {
			json.NewDecoder(r.Body).Decode(&rec.body)
		}
		rec.mu.Unlock()
		if r.URL.Path == "/v1/chat/completions" {
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":3}}\n\ndata: [DONE]\n\n")
			return
		}
		io.WriteString(w, `{"data":[{"id":"m1"}]}`)
	}))
	t.Cleanup(srv.Close)
	return rec, srv.URL + "/v1"
}

func genericClient(base, key string) *Client {
	cfg := config.Default()
	cfg.BaseURL, cfg.APIKey = base, key
	cfg.SetExtraString("profile", "local")
	cfg.Extra["profiles"] = json.RawMessage(`{"local":{"base_url":"` + base + `","generic":true}}`)
	return FromConfig(cfg)
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func TestGenericChatSendsOnlyOpenAIFields(t *testing.T) {
	rec, base := newRecorder(t)
	c := genericClient(base, "")
	id, title := "conv", "t"
	stream, err := c.ChatStream(context.Background(), ChatRequest{
		Model: "m1", Messages: []map[string]any{{"role": "user", "content": "hola"}},
		ConversationID: &id, ClientID: "cli", Title: &title, WebSearch: "auto", NumCtx: 4096, Think: "high",
		Tools: []map[string]any{{"type": "function"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	for range stream.Events() {
	}
	want := []string{"messages", "model", "stream", "stream_options", "tools"}
	if got := sortedKeys(rec.body); !slices.Equal(got, want) {
		t.Fatalf("campos enviados %v, esperaba %v", got, want)
	}
	if rec.auth[0] != "" {
		t.Fatalf("sin clave no debe enviarse Authorization: %q", rec.auth[0])
	}
}

func TestGenericChatOmitsEmptyToolsAndSendsKey(t *testing.T) {
	rec, base := newRecorder(t)
	c := genericClient(base, "sk-externa")
	stream, err := c.ChatStream(context.Background(), ChatRequest{Model: "m1", Messages: []map[string]any{{"role": "user", "content": "x"}}})
	if err != nil {
		t.Fatal(err)
	}
	stream.Close()
	if _, has := rec.body["tools"]; has {
		t.Fatal("sin herramientas no debe enviarse el campo tools")
	}
	if rec.auth[0] != "Bearer sk-externa" {
		t.Fatalf("Authorization: %q", rec.auth[0])
	}
}

func TestGatewayChatKeepsLixbonFields(t *testing.T) {
	rec, base := newRecorder(t)
	c := New(base, "k")
	id := "conv"
	stream, err := c.ChatStream(context.Background(), ChatRequest{Model: "m1", ConversationID: &id, ClientID: "cli", NumCtx: 4096})
	if err != nil {
		t.Fatal(err)
	}
	stream.Close()
	for _, key := range []string{"conversation_id", "client_id", "source", "web_search", "num_ctx"} {
		if _, ok := rec.body[key]; !ok {
			t.Errorf("el gateway debe seguir recibiendo %q: %v", key, sortedKeys(rec.body))
		}
	}
}

func TestGenericInternalChatIsMinimal(t *testing.T) {
	rec, base := newRecorder(t)
	c := genericClient(base, "")
	c.Chat(context.Background(), "m1", []map[string]any{{"role": "user", "content": "x"}}, "cli")
	if got := sortedKeys(rec.body); !slices.Equal(got, []string{"messages", "model"}) {
		t.Fatalf("campos: %v", got)
	}
}

func TestGenericNeverCallsLixbonEndpoints(t *testing.T) {
	rec, base := newRecorder(t)
	c := genericClient(base, "k")
	ctx := context.Background()
	if _, err := c.PlanName(ctx); err == nil {
		t.Error("PlanName debe fallar")
	}
	if _, err := c.Usage(ctx); err == nil {
		t.Error("Usage debe fallar")
	}
	if _, err := c.Nodes(ctx); err == nil {
		t.Error("Nodes debe fallar")
	}
	if _, err := c.KeyInfo(ctx); err == nil {
		t.Error("KeyInfo debe fallar")
	}
	if _, err := c.WebSearch(ctx, "x", 3); err == nil {
		t.Error("WebSearch debe fallar")
	}
	if _, err := c.Delegate(ctx, "x"); err == nil {
		t.Error("Delegate debe fallar")
	}
	if _, err := c.GenerateTitle(ctx, "id"); err == nil {
		t.Error("GenerateTitle debe fallar")
	}
	if got := c.RoleChatModel(ctx); got != "" {
		t.Errorf("RoleChatModel: %q", got)
	}
	if len(rec.paths) != 0 {
		t.Fatalf("no debe haber ninguna petición al servidor: %v", rec.paths)
	}
	if models, err := c.Models(ctx); err != nil || len(models) != 1 {
		t.Fatalf("/models sí debe funcionar: %v %v", models, err)
	}
}

func TestConfigureSwitchesTheSameClient(t *testing.T) {
	_, base := newRecorder(t)
	c := New("https://lixbon.com/v1", "k")
	cfg := config.Default()
	cfg.BaseURL = base
	cfg.SetExtraString("profile", "local")
	cfg.Extra["profiles"] = json.RawMessage(`{"local":{"generic":true}}`)
	c.Configure(cfg)
	if c.BaseURL != base || c.APIKey != "" || !c.Generic || c.Server != config.ServerBase(base) {
		t.Fatalf("cliente: %+v", c)
	}
}
