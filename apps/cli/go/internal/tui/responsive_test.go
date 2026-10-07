package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func assertFits(t *testing.T, h *harness, state string, width, height int) {
	t.Helper()
	lines := strings.Split(h.m.View().Content, "\n")
	if len(lines) != height {
		t.Errorf("%s %dx%d: la pantalla tiene %d filas", state, width, height, len(lines))
	}
	for i, line := range lines {
		if w := ansi.StringWidth(line); w > width {
			t.Errorf("%s %dx%d: la fila %d mide %d columnas: %q", state, width, height, i, w, ansi.Strip(line))
			return
		}
	}
}

func TestEveryRowFitsTheTerminalAtAnyWidth(t *testing.T) {
	h := newHarness(t, nil)
	h.m.printHeader()
	for width := 4; width <= 140; width++ {
		for _, height := range []int{6, 24} {
			h.update(tea.WindowSizeMsg{Width: width, Height: height})
			assertFits(t, h, "reposo", width, height)

			h.input("/")
			h.m.refreshMenu()
			assertFits(t, h, "menú", width, height)
			h.input("")
		}
	}
}

func TestHeaderLogoStaysWholeWhenTheWindowChanges(t *testing.T) {
	h := newHarness(t, nil)
	h.m.printHeader()
	logo := renderLogo()
	for _, width := range []int{120, 70, 40, 30, 18, 12, 90} {
		h.update(tea.WindowSizeMsg{Width: width, Height: 30})
		screen := ansi.Strip(h.m.View().Content)
		if width >= logoSize+4 {
			for i, row := range logo {
				if !strings.Contains(screen, ansi.Strip(row)) {
					t.Fatalf("ancho %d: la fila %d del logo no aparece entera\n%s", width, i, screen)
				}
			}
		}
		if !strings.Contains(screen, "Lixbon CLI") {
			t.Fatalf("ancho %d: falta el título\n%s", width, screen)
		}
	}
}

func (h *harness) input(text string) {
	h.m.input.SetValue(text)
	h.m.refreshMenu()
}

func TestLiveTextAndPickersFitTheTerminal(t *testing.T) {
	h := newHarness(t, nil)
	h.m.running = true
	h.m.live.reasoning.WriteString(strings.Repeat("razonando sobre una frase larga ", 8))
	for width := 4; width <= 100; width += 3 {
		h.update(tea.WindowSizeMsg{Width: width, Height: 20})
		assertFits(t, h, "pensando", width, 20)
	}
	h.m.live.content.WriteString(strings.Repeat("respuesta larga ", 30))
	for width := 4; width <= 100; width += 3 {
		h.update(tea.WindowSizeMsg{Width: width, Height: 20})
		assertFits(t, h, "respondiendo", width, 20)
	}
	h.m.running = false
	h.m.picker = newPicker("Elegir un modelo con un título bastante largo", []option{
		{Label: "una-opción-con-nombre-largo", Desc: "descripción igualmente larga para forzar el recorte", Badge: "nuevo"},
		{Label: "otra", Desc: "corta"},
	}, nil)
	h.m.picker.detail = "detalle"
	for width := 4; width <= 100; width += 3 {
		h.update(tea.WindowSizeMsg{Width: width, Height: 20})
		assertFits(t, h, "selector", width, 20)
	}
}
