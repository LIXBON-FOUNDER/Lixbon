package tui

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

// Un turno con acciones: la cabecera «◆ Lixbon» va antes de lo que el agente
// narró y pensó, todo cuelga del riel hasta ┗ y la respuesta queda fuera.
func TestAnAgentTurnHangsFromItsRail(t *testing.T) {
	h := newHarness(t, nil,
		proseThenTool("Miro primero el archivo.", "c1", "read_file", map[string]any{"path": "a.txt"}),
		textReply("El archivo dice hola."))
	if err := os.WriteFile(filepath.Join(h.m.chat.Workspace, "a.txt"), []byte("hola\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.send("lee a.txt")
	h.settle()
	out := ansi.Strip(h.m.log.text())
	head := strings.Index(out, "◆ Lixbon")
	narr := strings.Index(out, "┃   Miro primero el archivo.")
	end := strings.Index(out, "┗")
	answer := strings.Index(out, "El archivo dice hola.")
	if head < 0 || narr < head || end < narr || answer < end {
		t.Fatalf("orden del turno: cabecera %d, narración %d, cierre %d, respuesta %d\n%s", head, narr, end, answer, out)
	}
	if strings.Contains(out, "◆ El archivo") || strings.Contains(out, "◆ Miro") {
		t.Errorf("con riel, ni la narración ni la respuesta llevan ◆:\n%s", out)
	}
	notContains(t, out, "Pensó")
}

// Sin acciones no hay riel: la respuesta va con su ◆ como siempre.
func TestAChatTurnHasNoRail(t *testing.T) {
	h := newHarness(t, nil, textReply("Hola."))
	h.send("buenas")
	h.settle()
	out := ansi.Strip(h.m.log.text())
	contains(t, out, "◆ Hola.")
	notContains(t, out, "Lixbon  ")
	notContains(t, out, glyphs.turnRail)
}

// proseThenTool responde con algo de prosa y, en el mismo paso, una llamada.
func proseThenTool(prose, id, name string, args map[string]any) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		text, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": prose}}}})
		call, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{
			"tool_calls": []any{map[string]any{"id": id, "function": map[string]any{"name": name, "arguments": args}}},
		}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+string(text)+"\n\ndata: "+string(call)+"\n\ndata: [DONE]\n\n")
	}
}
