package tui

import (
	"strings"
	"testing"
)

// La comprobación de si había código por aplicar va en silencio: si el modelo
// solo contesta con texto, queda la respuesta del primer paso.
func TestQuietCheckDoesNotShowItsReply(t *testing.T) {
	h := agentHarness(t, true,
		textReply("Primera parte.\n```js\nconst a = 1;\n```"),
		textReply("Segunda parte."))
	h.send("revisa")
	h.settle()
	out := h.out()
	contains(t, out, "Primera parte.")
	if strings.Contains(out, "Segunda parte.") {
		t.Fatalf("la respuesta a la comprobación no se enseña:\n%s", out)
	}
	if h.gw.count() != 2 {
		t.Fatalf("pasos: %d", h.gw.count())
	}
}
