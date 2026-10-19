package tui

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/agent"
)

// replyWithUsage responde un texto con el bloque usage del final.
func replyWithUsage(text string, prompt, completion, cached int) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		content, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}})
		spent, _ := json.Marshal(map[string]any{"choices": []any{}, "usage": map[string]any{
			"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion,
			"prompt_tokens_details": map[string]any{"cached_tokens": cached},
		}})
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+string(content)+"\n\ndata: "+string(spent)+"\n\ndata: [DONE]\n\n")
	}
}

// Lo que gasta cada petición queda apuntado en el equipo y /usage lo enseña
// por proveedor y modelo, también con un proveedor que no es Lixbon.
func TestUsageIsRecordedPerProviderAndModel(t *testing.T) {
	h := newHarness(t, nil, replyWithUsage("hola", 1200, 30, 1000))
	h.send("buenas")
	h.settle()
	sums, err := h.chat.Usage.Summaries(time.Now())
	if err != nil || len(sums) != 1 {
		t.Fatalf("resúmenes: %+v %v", sums, err)
	}
	if s := sums[0]; s.Model != "qwen" || s.Today.Prompt != 1200 || s.Today.Completion != 30 || s.Today.Cached != 1000 {
		t.Fatalf("lo apuntado: %+v", s)
	}
	h.chat.Client.Generic = true
	h.send("/usage")
	h.settle()
	out := ansi.Strip(h.out())
	contains(t, out, "Proveedores y modelos en este equipo")
	contains(t, out, "qwen")
	contains(t, out, "1.2k")
	contains(t, out, "1.0k de caché")
	notContains(t, out, "solo funciona con un gateway")
}

// La barra de contexto sigue al turno: cada paso la mide en la goroutine del
// agente y la interfaz la pinta sin esperar al final.
func TestTheContextBarFollowsTheTurn(t *testing.T) {
	h := newHarness(t, nil)
	h.m.turn = 7
	ui := &uiSink{send: h.m.send, turn: 7, measure: func() ctxMsg { return ctxMsg{turn: 7, tokens: 42000, pct: 33, session: 99000} }}
	ui.Event(agent.Event{Kind: agent.EventStep})
	h.pump(func() bool { return h.m.ctxTokens == 42000 })
	if h.m.ctxTokens != 42000 || h.m.ctxPct != 33 || h.m.sessionTokens != 99000 {
		t.Fatalf("contexto en vivo: %d %.0f %d", h.m.ctxTokens, h.m.ctxPct, h.m.sessionTokens)
	}
	h.update(ctxMsg{turn: 6, tokens: 1})
	if h.m.ctxTokens != 42000 {
		t.Fatal("la medida de un turno anterior no cuenta")
	}
}

// /new y /clear empiezan con la barra de contexto vacía, sin esperar a que
// otro comando la vuelva a medir.
func TestNewAndClearEmptyTheContextBar(t *testing.T) {
	for _, command := range []string{"/new", "/clear"} {
		h := newHarness(t, nil, replyWithUsage("hola", 1200, 30, 1000))
		h.send("buenas")
		h.settle()
		if h.m.ctxTokens == 0 {
			t.Fatal("tras un turno la barra mide algo")
		}
		h.send(command)
		h.settle()
		if h.m.ctxTokens != 0 || h.m.ctxPct != 0 || h.m.sessionTokens != 0 {
			t.Fatalf("%s deja la barra en %d tok (%.0f %%), sesión %d", command, h.m.ctxTokens, h.m.ctxPct, h.m.sessionTokens)
		}
	}
}

// La terminal nunca recibe negrita (PowerShell y CMD la pintan con otra
// fuente) y /usage añade el contexto de la conversación con la barra nueva.
func TestNoBoldAndUsageShowsTheContext(t *testing.T) {
	h := newHarness(t, nil, replyWithUsage("**hecho**\n\n## Resumen\n\nlisto", 1200, 30, 0))
	h.send("buenas")
	h.settle()
	h.send("/usage")
	h.settle()
	h.send("/help")
	for _, frame := range []string{h.view(), h.out()} {
		if bold.MatchString(frame) {
			t.Fatalf("hay negrita en la pantalla:\n%q", frame)
		}
	}
	out := ansi.Strip(h.out())
	contains(t, out, "Contexto")
	contains(t, out, glyphMeterOn)
	contains(t, out, glyphMeterOff)
}

// bold reconoce el SGR 1 solo o dentro de una secuencia con colores.
var bold = regexp.MustCompile(`\x1b\[(?:[0-9;]*;)?1(?:;[0-9;]*)?m`)

// La compactación automática se ve: la etiqueta lo dice mientras dura.
func TestAutoCompactionShowsInTheLiveLabel(t *testing.T) {
	h := newHarness(t, nil)
	h.m.running = true
	h.m.handleEvent(agent.Event{Kind: agent.EventNote, Compacting: true, Text: "compactando…"})
	if label, _ := h.m.liveLabel(); label != "Compactando la conversación…" {
		t.Fatalf("etiqueta: %q", label)
	}
	h.m.handleEvent(agent.Event{Kind: agent.EventNote, Text: "Conversación compactada"})
	if label, _ := h.m.liveLabel(); label == "Compactando la conversación…" {
		t.Fatal("al acabar la etiqueta vuelve a la normal")
	}
}
