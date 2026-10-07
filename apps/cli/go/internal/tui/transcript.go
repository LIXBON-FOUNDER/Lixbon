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
	// dynamic guarda cómo volver a dibujar las entradas que dependen del ancho
	// (la cabecera con el logo), indexadas por su posición en lines.
	dynamic map[int]func(width int) string
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

// addDynamic añade una entrada que se redibuja al cambiar el ancho.
func (t *transcript) addDynamic(render func(width int) string) (string, int) {
	if t.dynamic == nil {
		t.dynamic = map[int]func(int) string{}
	}
	text := render(t.width)
	t.dynamic[len(t.lines)] = render
	t.lines = append(t.lines, text)
	before := len(t.wrapped)
	t.wrapped = append(t.wrapped, t.wrapLine(text)...)
	return text, len(t.wrapped) - before
}

func (t *transcript) resize(width int) {
	if width == t.width {
		return
	}
	t.width = width
	t.wrapped = t.wrapped[:0]
	for i, line := range t.lines {
		if render, ok := t.dynamic[i]; ok {
			line = render(width)
			t.lines[i] = line
		}
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

func (t *transcript) reset() { t.lines, t.wrapped, t.dynamic = nil, nil, nil }

func (t *transcript) maxScroll(rows int) int { return max(0, len(t.wrapped)-rows) }

func (t *transcript) text() string { return strings.Join(t.lines, "\n") }
