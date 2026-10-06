package tui

import (
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
)

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("no se cumplió: %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Un programa Bubble Tea de verdad, con entrada inyectada y la salida volcada
// a un emulador de terminal: comprueba el cableado completo de principio a fin.
func TestRealProgramEndToEnd(t *testing.T) {
	h := newHarness(t, nil, textReply("Hola desde el modelo."))
	rig := startScreen(t, h, 100, 30)
	rig.waitFor("Lixbon CLI")
	rig.type_("buenas tardes\r")
	rig.waitFor("Hola desde el modelo.")
	screen := rig.screen()
	if i, j := strings.Index(screen, "buenas tardes"), strings.Index(screen, "Hola desde el modelo."); i < 0 || j < 0 || i > j {
		t.Fatalf("el mensaje debe verse antes que la respuesta (%d, %d):\n%s", i, j, screen)
	}
	rig.type_("\x04")
	select {
	case err := <-rig.end:
		if err != nil {
			t.Fatalf("el programa terminó con error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("el programa no salió con Ctrl+D")
	}
	if len(h.chat.History) != 2 {
		t.Fatalf("historial: %d", len(h.chat.History))
	}
	if !strings.Contains(ansi.Strip(h.m.log.text()), "Hola desde el modelo.") {
		t.Fatal("el transcript debe conservar la respuesta para volcarla al salir")
	}
}
