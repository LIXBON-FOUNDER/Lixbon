package tui

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
)

type gateway struct {
	mu     sync.Mutex
	bodies []map[string]any
	steps  []func(w http.ResponseWriter, r *http.Request)
	title  string
}

func (g *gateway) bodyAt(i int) map[string]any {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.bodies[i]
}

func (g *gateway) count() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.bodies)
}

func textReply(text string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+string(chunk)+"\n\ndata: [DONE]\n\n")
	}
}

func toolReply(id, name string, args map[string]any) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{
			"tool_calls": []any{map[string]any{"id": id, "function": map[string]any{"name": name, "arguments": args}}},
		}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+string(chunk)+"\n\ndata: [DONE]\n\n")
	}
}

func slowReply(text string, delay time.Duration) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(delay):
		case <-r.Context().Done():
			return
		}
		textReply(text)(w, r)
	}
}

func newGateway(t *testing.T, steps ...func(http.ResponseWriter, *http.Request)) (*gateway, *api.Client) {
	t.Helper()
	g := &gateway{steps: steps, title: "Título"}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"data":[{"id":"qwen","name":"Qwen"},{"id":"llama","name":"Llama"}]}`)
	})
	mux.HandleFunc("/api/model-roles", http.NotFound)
	mux.HandleFunc("/api/key/info", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"plan":{"name":"Pro"}}`) })
	mux.HandleFunc("/api/account/usage", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"plan":{"name":"Pro"},"buckets":{"session":{"percent":30},"week":{"unlimited":true}}}`)
	})
	mux.HandleFunc("/api/conversations/", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"title":"`+g.title+`"}`)
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		g.mu.Lock()
		n := len(g.bodies)
		g.bodies = append(g.bodies, body)
		g.mu.Unlock()
		if n < len(g.steps) {
			g.steps[n](w, r)
			return
		}
		textReply("(sin más pasos)")(w, r)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return g, api.New(srv.URL+"/v1", "k")
}

type harness struct {
	t       *testing.T
	m       *Model
	chat    *chat.Chat
	gw      *gateway
	msgs    chan tea.Msg
	mu      sync.Mutex
	printed []string
	quit    bool
	root    string
}

func newHarness(t *testing.T, mutate func(*config.Config), steps ...func(http.ResponseWriter, *http.Request)) *harness {
	t.Helper()
	gw, client := newGateway(t, steps...)
	cfg := config.Default()
	cfg.APIKey, cfg.Model, cfg.Mode = "k", "qwen", "ask"
	cfg.AutoApproveTools = true
	if mutate != nil {
		mutate(&cfg)
	}
	root := t.TempDir()
	configPath := filepath.Join(t.TempDir(), "config.json")
	c, err := chat.New(cfg, client, chat.Options{ConfigPath: configPath, Workspace: root, Autotitle: false})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Toolbox.Close)
	c.LoadCustomCommands(reservedNames())

	h := &harness{t: t, chat: c, gw: gw, msgs: make(chan tea.Msg, 1024), root: root}
	h.m = New(c, Options{HistoryFile: filepath.Join(t.TempDir(), "history"), Version: "test",
		Account: chat.Account{Models: []api.Model{{ID: "qwen", Name: "Qwen"}, {ID: "llama", Name: "Llama"}}}})
	h.m.Wire(func(msg tea.Msg) { h.msgs <- msg }, func(s string) {
		h.mu.Lock()
		h.printed = append(h.printed, s)
		h.mu.Unlock()
	})
	h.update(tea.WindowSizeMsg{Width: 100, Height: 30})
	return h
}

func (h *harness) update(msg tea.Msg) {
	h.t.Helper()
	_, cmd := h.m.Update(msg)
	h.exec(cmd)
}

// exec ejecuta un comando de Bubble Tea como lo haría el programa: en su
// propia goroutine, devolviendo el mensaje al bucle.
func (h *harness) exec(cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	go func() {
		msg := cmd()
		switch v := msg.(type) {
		case nil:
		case tea.BatchMsg:
			for _, c := range v {
				h.exec(c)
			}
		case tea.QuitMsg:
			h.mu.Lock()
			h.quit = true
			h.mu.Unlock()
		default:
			h.msgs <- msg
		}
	}()
}

// pump procesa los mensajes pendientes hasta que cond se cumple o vence el plazo.
func (h *harness) pump(cond func() bool) {
	h.t.Helper()
	deadline := time.After(8 * time.Second)
	for !cond() {
		select {
		case msg := <-h.msgs:
			if _, isTick := msg.(tickMsg); isTick && !h.m.running {
				continue
			}
			h.update(msg)
		case <-deadline:
			h.t.Fatalf("la condición no se cumplió a tiempo.\nimpreso:\n%s\nvista:\n%s", h.out(), h.view())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func (h *harness) settle() {
	h.t.Helper()
	h.pump(func() bool { return !h.m.running && h.m.busy == "" })
}

func (h *harness) key(s string) {
	h.t.Helper()
	var msg tea.KeyPressMsg
	switch s {
	case "enter":
		msg = tea.KeyPressMsg{Code: tea.KeyEnter}
	case "esc":
		msg = tea.KeyPressMsg{Code: tea.KeyEscape}
	case "tab":
		msg = tea.KeyPressMsg{Code: tea.KeyTab}
	case "up":
		msg = tea.KeyPressMsg{Code: tea.KeyUp}
	case "down":
		msg = tea.KeyPressMsg{Code: tea.KeyDown}
	case "shift+tab":
		msg = tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift}
	case "ctrl+c":
		msg = tea.KeyPressMsg{Code: 'c', Mod: tea.ModCtrl}
	case "ctrl+d":
		msg = tea.KeyPressMsg{Code: 'd', Mod: tea.ModCtrl}
	default:
		h.t.Fatalf("tecla desconocida %q", s)
	}
	h.update(msg)
}

func (h *harness) typeText(s string) {
	h.t.Helper()
	for _, r := range s {
		h.update(tea.KeyPressMsg{Code: r, Text: string(r)})
	}
}

func (h *harness) send(text string) {
	h.t.Helper()
	h.typeText(text)
	h.key("enter")
}

func (h *harness) out() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return ansi.Strip(strings.Join(h.printed, "\n"))
}

func (h *harness) view() string { return ansi.Strip(h.m.View().Content) }

func (h *harness) quitRequested() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.quit
}

func contains(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Fatalf("falta %q en:\n%s", needle, haystack)
	}
}

func notContains(t *testing.T, haystack, needle string) {
	t.Helper()
	if strings.Contains(haystack, needle) {
		t.Fatalf("sobra %q en:\n%s", needle, haystack)
	}
}

type configT = config.Config

func altEnter() tea.Msg { return tea.KeyPressMsg{Code: tea.KeyEnter, Mod: tea.ModAlt} }

func pasteMsg(s string) tea.Msg { return tea.PasteMsg{Content: s} }

func configLoad(path string) config.Config { return config.Load(path) }
