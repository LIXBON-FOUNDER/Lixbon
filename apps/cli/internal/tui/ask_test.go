package tui

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/history"
)

var batch = map[string]any{"questions": []any{
	map[string]any{"header": "Estilo", "question": "¿Qué estilo?", "options": []any{
		map[string]any{"label": "Cálido", "description": "tonos tierra"}, map[string]any{"label": "Frío"}}},
	map[string]any{"header": "Secciones", "question": "¿Qué secciones?", "multiple": true, "options": []any{
		map[string]any{"label": "Carta"}, map[string]any{"label": "Reservas"}, map[string]any{"label": "Ubicación"}}},
	map[string]any{"header": "Tipografía", "question": "¿Qué tipografía?"},
}}

// Las preguntas llegan en una tanda con pestañas; se responden todas, se
// repasan en «Enviar» y quedan bajo la fila «Preguntar».
func TestAskUserBatchWithTabs(t *testing.T) {
	h := agentHarness(t, true, toolReply("c1", "ask_user", batch), textReply("hecho"))
	h.send("monta la web")
	h.pump(func() bool { return h.m.picker != nil && h.m.picker.ask != nil })
	view := h.view()
	for _, s := range []string{"Estilo", "Secciones", "Tipografía", "Enviar", "¿Qué estilo?", "tonos tierra", "Otra respuesta…"} {
		contains(t, view, s)
	}
	contains(t, h.view(), "Esperando tus respuestas")

	h.key("enter") // Cálido, y pasa a Secciones
	contains(t, h.view(), "¿Qué secciones?")
	h.key("space") // [x] Carta
	h.key("down")
	h.key("down")
	h.key("space") // [x] Ubicación
	h.key("enter") // siguiente: Tipografía, solo texto libre
	contains(t, h.view(), "¿Qué tipografía?")
	h.key("enter")
	h.typeText("una serif")
	h.key("enter") // guarda y pasa a Enviar
	view = h.view()
	contains(t, view, "Enviar respuestas")
	contains(t, view, "Carta, Ubicación")
	h.key("enter")
	h.settle()

	second := h.gw.bodyAt(1)["messages"].([]any)
	got := second[len(second)-1].(map[string]any)["content"]
	want := "Respuestas del usuario:\n- [Estilo] ¿Qué estilo? → Cálido\n- [Secciones] ¿Qué secciones? → Carta, Ubicación\n- [Tipografía] ¿Qué tipografía? → una serif"
	if got != want {
		t.Fatalf("respuesta al modelo:\n%v", got)
	}
	out := ansi.Strip(h.out())
	contains(t, out, "3 preguntas")
	contains(t, out, "Secciones   Carta, Ubicación")
	contains(t, out, "Tipografía  una serif")
}

// Esc dentro de «Otra respuesta» vuelve a las opciones; ← vuelve a una
// pregunta ya respondida con lo elegido; esc fuera cierra la tanda entera y
// lo respondido se queda.
func TestAskUserEscGoesBackNotForward(t *testing.T) {
	h := agentHarness(t, true, toolReply("c1", "ask_user", batch), textReply("vale"))
	h.send("monta la web")
	h.pump(func() bool { return h.m.picker != nil && h.m.picker.ask != nil })
	h.key("down")
	h.key("down") // Otra respuesta…
	h.key("enter")
	h.typeText("rústico")
	h.key("esc")
	if h.m.picker == nil || h.m.picker.ask.tab != 0 || h.m.picker.ask.editing {
		t.Fatal("esc en «Otra respuesta» vuelve a las opciones de la misma pregunta")
	}
	h.key("enter")
	h.typeText("rústico")
	h.key("enter")
	if h.m.picker.ask.tab != 1 {
		t.Fatal("guardar la otra respuesta pasa a la siguiente")
	}
	h.key("left")
	contains(t, h.view(), "«rústico»")
	h.key("esc")
	h.settle()
	second := h.gw.bodyAt(1)["messages"].([]any)
	got := second[len(second)-1].(map[string]any)["content"].(string)
	if !strings.Contains(got, "[Estilo] ¿Qué estilo? → rústico") || !strings.Contains(got, "[Secciones] ¿Qué secciones? → (sin responder") {
		t.Fatalf("lo respondido antes de cerrar llega al modelo:\n%s", got)
	}
	contains(t, ansi.Strip(h.out()), "las otras 2 las decide el agente")
}

// Al reabrir una conversación, las respuestas vuelven bajo su «Preguntar».
func TestReplayShowsTheAnswers(t *testing.T) {
	h := agentHarness(t, true)
	call := map[string]any{"id": "c1", "type": "function", "function": map[string]any{"name": "ask_user",
		"arguments": `{"questions":[{"header":"Estilo","question":"¿Qué estilo?"},{"header":"Idioma","question":"¿Idioma?"}]}`}}
	raw, _ := json.Marshal(call)
	h.chat.History = []history.Message{
		history.User("monta la web"),
		{Role: "assistant", ToolCalls: []json.RawMessage{raw}},
		{Role: "tool", ToolCallID: "c1", Name: "ask_user", Content: "Respuestas del usuario:\n- [Estilo] ¿Qué estilo? → Cálido\n- [Idioma] ¿Idioma? → español"},
		history.Assistant("listo"),
	}
	h.m.replayTranscript()
	out := ansi.Strip(h.out())
	contains(t, out, "2 preguntas")
	contains(t, out, "Estilo  Cálido")
	contains(t, out, "Idioma  español")
}
