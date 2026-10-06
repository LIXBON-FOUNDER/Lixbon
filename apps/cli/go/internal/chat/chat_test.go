package chat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/sse"
)

type gateway struct {
	mu        sync.Mutex
	bodies    []map[string]any
	chat      func(n int, w http.ResponseWriter)
	title     string
	models    string
	roleModel string
	titleHits int
}

func (g *gateway) bodyAt(i int) map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.bodies[i]
}

func newGateway(t *testing.T) (*gateway, *api.Client) {
	t.Helper()
	g := &gateway{models: `{"data":[{"id":"qwen","name":"Qwen"},{"id":"llama"}]}`}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, g.models) })
	mux.HandleFunc("/api/model-roles", func(w http.ResponseWriter, r *http.Request) {
		if g.roleModel == "" {
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, `{"roles":{"chat":{"model":"`+g.roleModel+`"}}}`)
	})
	mux.HandleFunc("/api/key/info", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"plan":{"name":"Pro"}}`) })
	mux.HandleFunc("/api/conversations/", func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		g.titleHits++
		g.mu.Unlock()
		io.WriteString(w, `{"title":"`+g.title+`"}`)
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		g.mu.Lock()
		n := len(g.bodies)
		g.bodies = append(g.bodies, body)
		g.mu.Unlock()
		if g.chat != nil {
			g.chat(n, w)
			return
		}
		reply("respuesta " + string(rune('A'+n)))(w)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return g, api.New(srv.URL+"/v1", "k")
}

func reply(text string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+string(chunk)+"\n\ndata: [DONE]\n\n")
	}
}

func newChat(t *testing.T, client *api.Client, mutate func(*config.Config), opts Options) *Chat {
	t.Helper()
	cfg := config.Default()
	cfg.APIKey, cfg.Model, cfg.Mode = "k", "qwen", ModeAsk
	cfg.Workspace = t.TempDir()
	if mutate != nil {
		mutate(&cfg)
	}
	opts.ConfigPath = filepath.Join(t.TempDir(), "config.json")
	opts.Workspace = t.TempDir()
	c, err := New(cfg, client, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Toolbox.Close)
	return c
}

type recorder struct {
	mu     sync.Mutex
	deltas []string
	notes  []string
	titles []string
	events []agent.Event
}

func (r *recorder) Delta(kind sse.Kind, text string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if kind == sse.Content {
		r.deltas = append(r.deltas, text)
	}
}
func (r *recorder) Event(e agent.Event) { r.mu.Lock(); r.events = append(r.events, e); r.mu.Unlock() }
func (r *recorder) Note(t string)       { r.mu.Lock(); r.notes = append(r.notes, t); r.mu.Unlock() }
func (r *recorder) Title(t string)      { r.mu.Lock(); r.titles = append(r.titles, t); r.mu.Unlock() }

func TestAskKeepsAndTrimsHistory(t *testing.T) {
	g, client := newGateway(t)
	c := newChat(t, client, func(cfg *config.Config) { cfg.MaxContextMessages = 3 }, Options{})
	for _, q := range []string{"uno", "dos", "tres"} {
		if _, err := c.Send(context.Background(), q, nil); err != nil {
			t.Fatal(err)
		}
	}
	if len(c.History) != 6 {
		t.Fatalf("historial: %d mensajes", len(c.History))
	}
	third := g.bodyAt(2)["messages"].([]any)
	if len(third) != 3 {
		t.Fatalf("la ventana debe ser de 3 mensajes, fueron %d", len(third))
	}
	if first := third[0].(map[string]any); first["content"] != "dos" {
		t.Fatalf("la ventana debe conservar los más recientes: %v", third)
	}
	if last := third[2].(map[string]any); last["content"] != "tres" {
		t.Fatalf("último mensaje: %v", last)
	}
}

func TestSendStreamsDeltasToTheSink(t *testing.T) {
	g, client := newGateway(t)
	g.chat = func(_ int, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, part := range []string{"ho", "la", " mundo"} {
			chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": part}}}})
			io.WriteString(w, "data: "+string(chunk)+"\n\n")
		}
		io.WriteString(w, "data: [DONE]\n\n")
	}
	c := newChat(t, client, nil, Options{})
	rec := &recorder{}
	answer, err := c.Send(context.Background(), "x", rec)
	if err != nil || answer != "hola mundo" || strings.Join(rec.deltas, "|") != "ho|la| mundo" {
		t.Fatalf("answer=%q deltas=%v err=%v", answer, rec.deltas, err)
	}
}

func TestFailedSendLeavesHistoryUntouched(t *testing.T) {
	g, client := newGateway(t)
	g.chat = func(_ int, w http.ResponseWriter) {
		if len(g.bodies) == 2 {
			w.WriteHeader(500)
			io.WriteString(w, `{"detail":"boom"}`)
			return
		}
		reply("ok")(w)
	}
	c := newChat(t, client, nil, Options{})
	c.Send(context.Background(), "uno", nil)
	if _, err := c.Send(context.Background(), "dos", nil); err == nil {
		t.Fatal("esperaba error")
	}
	if len(c.History) != 2 || c.History[1].Content != "ok" {
		t.Fatalf("historial tras el fallo: %+v", c.History)
	}
	if list := c.Store.List(10); len(list) != 1 || list[0].Messages != 2 {
		t.Fatalf("sesión guardada: %+v", list)
	}
}

func TestAutotitleRunsInTheBackgroundAndPersists(t *testing.T) {
	g, client := newGateway(t)
	g.title = "Título del servidor"
	c := newChat(t, client, nil, Options{Autotitle: true})
	rec := &recorder{}
	if _, err := c.Send(context.Background(), "hola", rec); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		rec.mu.Lock()
		got := len(rec.titles)
		rec.mu.Unlock()
		if got > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if c.Title() != "Título del servidor" {
		t.Fatalf("título: %q", c.Title())
	}
	if list := c.Store.List(10); len(list) != 1 || list[0].Title != "Título del servidor" {
		t.Fatalf("el título no se persistió: %+v", list)
	}
	c.Send(context.Background(), "otra", rec)
	time.Sleep(100 * time.Millisecond)
	if g.titleHits != 1 {
		t.Fatalf("el título solo se pide una vez, hubo %d peticiones", g.titleHits)
	}
}

func TestFixedTitleIsNeverRequested(t *testing.T) {
	g, client := newGateway(t)
	c := newChat(t, client, nil, Options{Autotitle: true, Title: "Fijo"})
	c.Send(context.Background(), "hola", nil)
	time.Sleep(100 * time.Millisecond)
	if g.titleHits != 0 || c.Title() != "Fijo" {
		t.Fatalf("hits=%d título=%q", g.titleHits, c.Title())
	}
}

func TestNewConversationAndOpen(t *testing.T) {
	_, client := newGateway(t)
	c := newChat(t, client, nil, Options{})
	c.Send(context.Background(), "primera conversación", nil)
	first := c.ConversationID
	c.SessionTokens = 99
	c.NewConversation()
	if len(c.History) != 0 || c.ConversationID == first || c.SessionTokens != 0 || c.Title() != "" {
		t.Fatalf("estado tras /new: %+v", c)
	}
	c.Send(context.Background(), "segunda", nil)
	if list := c.Store.List(10); len(list) != 2 {
		t.Fatalf("sesiones: %d", len(list))
	}
	if !c.Open(first) {
		t.Fatal("no se pudo reabrir la primera")
	}
	if c.ConversationID != first || len(c.History) != 2 || c.History[0].Content != "primera conversación" || c.SessionTokens != 99 {
		t.Fatalf("estado tras reabrir: id=%s hist=%d tokens=%d", c.ConversationID, len(c.History), c.SessionTokens)
	}
	if c.Open("no-existe") {
		t.Fatal("abrir una sesión inexistente debe fallar")
	}
}

func TestAskCompactsWhenTheWindowFills(t *testing.T) {
	g, client := newGateway(t)
	g.chat = func(n int, w http.ResponseWriter) {
		if n == 0 {
			io.WriteString(w, `{"choices":[{"message":{"content":"resumen de lo anterior"}}]}`)
			return
		}
		reply("ok")(w)
	}
	c := newChat(t, client, func(cfg *config.Config) { cfg.ContextWindow = 1000 }, Options{})
	for i := 0; i < 8; i++ {
		c.History = append(c.History, history.User("pregunta "+strings.Repeat("larga ", 60)), history.Assistant("respuesta "+strings.Repeat("larga ", 60)))
	}
	rec := &recorder{}
	if _, err := c.Send(context.Background(), "y ahora?", rec); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(rec.notes, "|"), "compactando") {
		t.Fatalf("notas: %v", rec.notes)
	}
	if !strings.Contains(c.History[0].Content, "resumen de lo anterior") {
		t.Fatalf("primer mensaje: %q", c.History[0].Content)
	}
}

func TestInterruptedStreamKeepsThePartialAnswer(t *testing.T) {
	g, client := newGateway(t)
	g.chat = func(_ int, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "a medias"}}}})
		io.WriteString(w, "data: "+string(chunk)+"\n\n")
		w.(http.Flusher).Flush()
		time.Sleep(3 * time.Second)
	}
	c := newChat(t, client, nil, Options{})
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(300*time.Millisecond, cancel)
	answer, err := c.Send(ctx, "hola", nil)
	if err != nil || !strings.HasPrefix(answer, "a medias") || !strings.Contains(answer, "interrumpida por el usuario") {
		t.Fatalf("answer=%q err=%v", answer, err)
	}
	if last := c.History[len(c.History)-1]; last.Role != "assistant" || !strings.Contains(last.Content, "interrumpida") {
		t.Fatalf("historial: %+v", c.History)
	}
}

func TestContextUsageUsesTheServerCountAsAnchor(t *testing.T) {
	g, client := newGateway(t)
	g.chat = func(_ int, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": "ok"}}}})
		usage, _ := json.Marshal(map[string]any{"usage": map[string]any{"prompt_tokens": 500, "completion_tokens": 20, "total_tokens": 520}})
		io.WriteString(w, "data: "+string(chunk)+"\n\ndata: "+string(usage)+"\n\ndata: [DONE]\n\n")
	}
	c := newChat(t, client, func(cfg *config.Config) { cfg.ContextWindow = 1000 }, Options{})
	before, _ := c.ContextUsage()
	c.Send(context.Background(), strings.Repeat("palabra ", 100), nil)
	tokens, pct := c.ContextUsage()
	if c.SessionTokens != 520 || c.TurnTokens != 520 {
		t.Fatalf("tokens de sesión: %d/%d", c.SessionTokens, c.TurnTokens)
	}
	if tokens < 500 || tokens > 700 || pct < 50 || before >= tokens {
		t.Fatalf("uso de contexto: %d tokens (%.0f%%), antes %d", tokens, pct, before)
	}
	c.History = append(c.History, history.User(strings.Repeat("x", 20000)))
	if _, pct := c.ContextUsage(); pct != 100 {
		t.Fatalf("el porcentaje se limita al 100%%: %.0f", pct)
	}
}

func TestProbeAndResolveModel(t *testing.T) {
	g, client := newGateway(t)
	c := newChat(t, client, func(cfg *config.Config) { cfg.Model = "" }, Options{})
	acc := c.Probe(context.Background())
	if acc.State != AccountOK || len(acc.Models) != 2 {
		t.Fatalf("cuenta: %+v", acc)
	}
	if c.Cfg.ExtraString("plan_name") != "Pro" {
		t.Fatal("el plan debe quedar cacheado en la configuración")
	}
	needsPick, err := c.ResolveModel(acc)
	if err != nil || !needsPick {
		t.Fatalf("sin rol del servidor hay que elegir: %v %v", needsPick, err)
	}
	g.roleModel = "llama"
	acc = c.Probe(context.Background())
	if needsPick, err = c.ResolveModel(acc); err != nil || needsPick || c.Model != "llama" || c.Cfg.Model != "llama" {
		t.Fatalf("modelo del rol: %v %v %q", needsPick, err, c.Model)
	}
	if _, err := (&Chat{}).ResolveModel(Account{}); err == nil {
		t.Fatal("sin modelos debe fallar")
	}
}

func TestModelPrecedence(t *testing.T) {
	_, client := newGateway(t)
	c := newChat(t, client, func(cfg *config.Config) { cfg.Model, cfg.KeyModel = "cfg", "" }, Options{Model: "flag"})
	if c.Model != "flag" {
		t.Fatalf("--model gana a la config: %q", c.Model)
	}
	c = newChat(t, client, func(cfg *config.Config) { cfg.Model, cfg.KeyModel = "cfg", "fija" }, Options{Model: "flag"})
	if c.Model != "fija" {
		t.Fatalf("key_model gana a todo: %q", c.Model)
	}
}

func TestSwitchingFromAgentToAskDropsToolRoundTrips(t *testing.T) {
	g, client := newGateway(t)
	c := newChat(t, client, nil, Options{})
	calls := []json.RawMessage{json.RawMessage(`{"id":"c1","function":{"name":"mkdir","arguments":{"path":"d"}}}`)}
	c.History = []history.Message{history.User("crea d"), {Role: "assistant", ToolCalls: calls},
		{Role: "tool", Content: "ok", ToolCallID: "c1", Name: "mkdir"}, history.Assistant("hecho")}
	c.Send(context.Background(), "gracias", nil)
	for _, m := range g.bodyAt(0)["messages"].([]any) {
		msg := m.(map[string]any)
		if msg["role"] == "tool" || msg["tool_calls"] != nil {
			t.Fatalf("el round-trip de herramientas no debe viajar en modo ask: %v", msg)
		}
	}
}
