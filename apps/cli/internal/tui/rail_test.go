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
	narr := strings.Index(out, "┃ Miro primero el archivo.")
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

// Sin acciones no hay riel, pero el turno abre igual con «◆ Lixbon» y la
// respuesta va debajo, sin ◆ ni fila de aire.
func TestAChatTurnHasNoRail(t *testing.T) {
	h := newHarness(t, nil, textReply("Hola."))
	h.send("buenas")
	h.settle()
	out := ansi.Strip(h.m.log.text())
	contains(t, out, glyphBrand+" Lixbon")
	notContains(t, out, glyphBrand+" Hola.")
	notContains(t, out, glyphs.turnRail)
	notContains(t, out, glyphs.turnEnd)
	lines := strings.Split(out, "\n")
	for i, l := range lines {
		if strings.Contains(l, "Lixbon") {
			if i+1 >= len(lines) || strings.TrimSpace(lines[i+1]) != "Hola." {
				t.Fatalf("la respuesta va justo bajo la cabecera:\n%s", out)
			}
			return
		}
	}
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

// El paso del plan solo se ve mientras es de este turno: uno que quedó «en
// curso» en el anterior no acompaña a lo que se hace ahora.
func TestAPlanFromAnotherTurnIsNotShownLive(t *testing.T) {
	h := newHarness(t, nil)
	m := h.m
	m.running, m.turn = true, 1
	m.printTodo([]todoItem{{Text: "Verificar en navegador", Status: "doing"}}, nil)
	if step, _, _ := m.currentStep(); step == "" {
		t.Fatal("en su turno el paso se ve")
	}
	m.turn = 2
	if step, _, _ := m.currentStep(); step != "" {
		t.Fatalf("en otro turno no: %q", step)
	}
	m.running = false
}

// El riel es continuo: ningún paso deja una fila vacía antes, y la respuesta
// va pegada a ┗.
func TestTheRailHasNoGaps(t *testing.T) {
	h := newHarness(t, nil,
		proseThenTool("Miro primero el archivo.", "c1", "read_file", map[string]any{"path": "a.txt"}),
		textReply("Listo."))
	if err := os.WriteFile(filepath.Join(h.m.chat.Workspace, "a.txt"), []byte("hola\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	h.send("lee a.txt")
	h.settle()
	lines := strings.Split(ansi.Strip(h.m.log.text()), "\n")
	head, end := -1, -1
	for i, l := range lines {
		switch l = strings.TrimSpace(l); {
		case strings.HasPrefix(l, glyphBrand+" Lixbon"):
			head = i
		case l == glyphs.turnEnd:
			end = i
		}
	}
	if head < 0 || end < head || end+1 >= len(lines) || strings.TrimSpace(lines[end+1]) != "Listo." {
		t.Fatalf("cabecera %d, cierre %d:\n%s", head, end, strings.Join(lines, "\n"))
	}
	for _, l := range lines[head+1 : end] {
		if strings.TrimSpace(l) == glyphs.turnRail {
			t.Fatalf("fila vacía en el riel:\n%s", strings.Join(lines, "\n"))
		}
	}
}
