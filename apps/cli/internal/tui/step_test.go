package tui

import (
	"strings"
	"testing"
)

// Un paso sin acciones (el modelo contesta con código y el agente le recuerda
// aplicarlo) no debe fundir su texto con el del paso siguiente.
func TestTextOfConsecutiveStepsIsNotGluedTogether(t *testing.T) {
	h := agentHarness(t, true,
		textReply("Primera parte.\n```\nprint(1)\n```"),
		textReply("Segunda parte."))
	h.send("revisa")
	h.settle()
	out := h.out()
	contains(t, out, "Primera parte.")
	contains(t, out, "Segunda parte.")
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "Segunda parte.") && strings.TrimSpace(line) != "Segunda parte." {
			t.Fatalf("pasos fundidos en una línea: %q", line)
		}
	}
	if h.gw.count() != 2 {
		t.Fatalf("pasos: %d", h.gw.count())
	}
}
