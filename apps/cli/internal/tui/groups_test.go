package tui

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/agent"
)

func TestBrowserActionsShareOneChangingLine(t *testing.T) {
	h := newHarness(t, nil)
	m := h.m
	m.running = true
	think := func(text string) {
		m.live.reasoning.WriteString(text)
		m.live.reasoningSecs = 1.5
	}
	think("abro la página")
	m.handleEvent(agent.Event{Kind: agent.EventAction, Tool: "browser_navigate", Text: "https://lixbon.com"})
	m.handleEvent(agent.Event{Kind: agent.EventActionResult, Tool: "browser_navigate", Summary: "Abrí https://lixbon.com", Elapsed: time.Second})
	think("ahora el menú Product")
	m.handleEvent(agent.Event{Kind: agent.EventAction, Tool: "browser_click", Text: "e193 · button «Product»"})

	view := h.view()
	contains(t, view, "Navegador")
	contains(t, view, "Haciendo clic en  e193 · button «Product»")
	notContains(t, view, "Pensó")
	notContains(t, view, "Abrí https://lixbon.com")
	if label, _ := m.liveLabel(); !strings.HasPrefix(label, "Haciendo clic en e193") {
		t.Fatalf("la etiqueta viva sigue al paso del grupo: %q", label)
	}

	m.handleEvent(agent.Event{Kind: agent.EventActionResult, Tool: "browser_click", Summary: "Clic en e193 → desplegado", Elapsed: time.Second})
	m.handleEvent(agent.Event{Kind: agent.EventAction, Tool: "browser_snapshot", Text: "página", ReadOnly: true, Meta: "40 refs"})
	view = h.view()
	contains(t, view, "Ver página")
	contains(t, view, "3 acciones")
	if n := strings.Count(view, "Navegador"); n != 1 {
		t.Fatalf("los pasos seguidos comparten una sola fila, hay %d:\n%s", n, view)
	}

	g := m.browserGroup.b.(*browserBlock)
	open := ansi.Strip(g.render(120, true))
	for _, want := range []string{"abro la página", "ahora el menú Product", "Abrí https://lixbon.com", "Clic en e193 → desplegado", "Ver página"} {
		contains(t, open, want)
	}

	m.handleEvent(agent.Event{Kind: agent.EventAction, Tool: "read_file", Text: "main.go", ReadOnly: true})
	if m.browserGroup != nil || g.live {
		t.Fatal("otra herramienta cierra el grupo del navegador")
	}
	m.handleEvent(agent.Event{Kind: agent.EventAction, Tool: "browser_click", Text: "e5 · link «Docs»"})
	if n := strings.Count(h.view(), "Navegador"); n != 2 {
		t.Fatalf("tras otra herramienta empieza un grupo nuevo, hay %d", n)
	}
	m.running = false
}

func TestReadGroupAbsorbsThinkingAndNamesTheLastRead(t *testing.T) {
	h := newHarness(t, nil)
	m := h.m
	m.running = true
	for _, f := range []string{"a.go", "b.go"} {
		m.live.reasoning.WriteString("miro " + f)
		m.handleEvent(agent.Event{Kind: agent.EventAction, Tool: "read_file", Text: f, ReadOnly: true})
	}
	view := h.view()
	notContains(t, view, "Pensó")
	contains(t, view, "Explorando 2 archivos")
	contains(t, view, "Leer b.go")
	m.closeGroups()
	view = h.view()
	contains(t, view, glyphs.fold+" Leyó 2 archivos")
	notContains(t, view, "Leer b.go")
	m.running = false
}

func TestGatewayErrorMidTurnTellsHowToContinue(t *testing.T) {
	h := agentHarness(t, true,
		toolReply("c1", "list_files", map[string]any{"path": "."}),
		func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
			io.WriteString(w, `{"detail":"El nodo se desconectó"}`)
		})
	h.send("haz la web")
	h.settle()
	out := h.out()
	contains(t, out, "El nodo se desconectó")
	contains(t, out, "escribe «continúa» para seguir")
	if len(h.chat.History) < 3 {
		t.Fatalf("lo hecho sigue en el historial: %+v", h.chat.History)
	}
}
