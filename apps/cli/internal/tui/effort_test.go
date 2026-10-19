package tui

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

// /effort es un deslizador: ←→ cambia el nivel en la fila, enter lo usa y
// esc lo deja como estaba.
func TestEffortSliderMovesWithTheArrows(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/effort")
	contains(t, h.view(), "←→ cambiar")
	contains(t, h.view(), "auto  ·  apagado  ·  encendido")
	h.update(tea.KeyPressMsg{Code: tea.KeyRight})
	contains(t, h.view(), "responde rápido, sin pensar")
	h.update(tea.KeyPressMsg{Code: tea.KeyRight})
	h.key("enter")
	if h.chat.Effort != "on" || h.m.picker != nil {
		t.Fatalf("esfuerzo %q, panel abierto %v", h.chat.Effort, h.m.picker != nil)
	}
	h.send("/effort")
	h.update(tea.KeyPressMsg{Code: tea.KeyLeft})
	h.key("esc")
	if h.chat.Effort != "on" {
		t.Fatalf("esc no cambia el esfuerzo: %q", h.chat.Effort)
	}
}

// Los modelos que gradúan el razonamiento tienen bajo, medio y alto; el
// resto solo apagado y encendido.
func TestGradedModelsHaveEffortLevels(t *testing.T) {
	h := newHarness(t, nil)
	for model, want := range map[string]bool{
		"gpt-oss:120b": true, "openai/o3-mini": true, "gpt-5": true, "o4-mini": true,
		"mimo-v2.6-pro": false, "qwen3:32b": false, "deepseek-r1": false,
	} {
		if got := h.m.graded(model); got != want {
			t.Errorf("%s: graduado %v", model, got)
		}
	}
}

// El cursor de la caja es el de la terminal, en barra, en la fila del texto.
func TestTheInputCursorIsABar(t *testing.T) {
	h := newHarness(t, nil)
	h.input("hola")
	v := h.m.View()
	if v.Cursor == nil || v.Cursor.Shape != tea.CursorBar {
		t.Fatalf("cursor: %+v", v.Cursor)
	}
	if v.Cursor.Position.Y != h.m.inputY || v.Cursor.Position.X != 2+2+4 {
		t.Fatalf("posición %+v, caja en la fila %d", v.Cursor.Position, h.m.inputY)
	}
}
