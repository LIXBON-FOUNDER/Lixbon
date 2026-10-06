package tui

import (
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// transcript guarda lo ya impreso como líneas lógicas y las envuelve al ancho
// vigente: al cambiar el tamaño de la ventana se reenvuelve todo.
type transcript struct {
	lines   []string
	wrapped []string
	width   int
}

func (t *transcript) wrapLine(line string) []string {
	if t.width <= 0 {
		return []string{line}
	}
	return strings.Split(ansi.Hardwrap(line, t.width, true), "\n")
}

// add añade texto (puede llevar saltos de línea) y devuelve cuántas filas
// visibles ocupa.
func (t *transcript) add(text string) int {
	before := len(t.wrapped)
	for _, line := range strings.Split(text, "\n") {
		t.lines = append(t.lines, line)
		t.wrapped = append(t.wrapped, t.wrapLine(line)...)
	}
	return len(t.wrapped) - before
}

func (t *transcript) resize(width int) {
	if width == t.width {
		return
	}
	t.width = width
	t.wrapped = t.wrapped[:0]
	for _, line := range t.lines {
		t.wrapped = append(t.wrapped, t.wrapLine(line)...)
	}
}

// window devuelve exactamente rows filas: el final del transcript desplazado
// scroll filas hacia arriba. Si cabe entero, queda pegado arriba.
func (t *transcript) window(rows, scroll int) []string {
	if rows <= 0 {
		return nil
	}
	total := len(t.wrapped)
	scroll = max(0, min(scroll, total-rows))
	end := total - scroll
	start := max(0, end-rows)
	out := append([]string(nil), t.wrapped[start:end]...)
	for len(out) < rows {
		out = append(out, "")
	}
	return out
}

func (t *transcript) reset() { t.lines, t.wrapped = nil, nil }

func (t *transcript) maxScroll(rows int) int { return max(0, len(t.wrapped)-rows) }

func (t *transcript) text() string { return strings.Join(t.lines, "\n") }
