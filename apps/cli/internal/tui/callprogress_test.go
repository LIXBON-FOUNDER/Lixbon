package tui

import (
	"strings"
	"testing"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/sse"
)

// Mientras el modelo escribe una llamada larga (un archivo entero), la
// etiqueta dice qué prepara y cuánto lleva, y los tokens de abajo avanzan:
// no parece trabado.
func TestALongNativeCallShowsItsProgress(t *testing.T) {
	h := newHarness(t, nil)
	m := h.m
	m.running, m.turn, m.turnMode, m.charsPerToken = true, 3, chat.ModeAgent, 4
	h.update(deltaMsg{turn: 3, kind: sse.Content, text: "Escribo la página."})
	h.update(deltaMsg{turn: 3, kind: sse.ToolCalls, text: "write_file\tweb/index.html\t4000"})
	label, _ := m.liveLabel()
	if label != "Escribiendo index.html · 4.0 kB…" {
		t.Fatalf("etiqueta: %q", label)
	}
	before := m.liveTokens()
	h.update(deltaMsg{turn: 3, kind: sse.ToolCalls, text: "write_file\tweb/index.html\t12400"})
	if label, _ := m.liveLabel(); !strings.Contains(label, "12.4 kB") || m.liveTokens() <= before {
		t.Fatalf("el avance crece: %q, tokens %d → %d", label, before, m.liveTokens())
	}
	m.flushLive()
	if label, _ := m.liveLabel(); strings.Contains(label, "index.html") {
		t.Fatalf("al llegar la acción la etiqueta se limpia: %q", label)
	}
	m.running = false
}

func TestACallWrittenInTheTextShowsItsProgress(t *testing.T) {
	h := newHarness(t, nil)
	m := h.m
	m.running, m.turn, m.turnMode = true, 3, chat.ModeAgent
	body := `Creo el estilo. {"tool":"write_file","args":{"path":"css/base.css","content":"` + strings.Repeat("a{}", 300)
	h.update(deltaMsg{turn: 3, kind: sse.Content, text: body})
	if label, _ := m.liveLabel(); !strings.HasPrefix(label, "Escribiendo base.css · ") {
		t.Fatalf("etiqueta: %q", label)
	}
	m.running = false
}

func TestCallTargetReadsHalfWrittenArguments(t *testing.T) {
	for args, want := range map[string]string{
		`{"path":"src/app.js","content":"cons`:  "src/app.js",
		`{"command":"npm test -- --run","timeo`: "npm test -- --run",
		`{"content":"x","path":"a\\b.txt"`:      `a\b.txt`,
		`{"conte`:                               "",
	} {
		if got := chat.CallTarget(args); got != want {
			t.Errorf("%s → %q, quiero %q", args, got, want)
		}
	}
}
