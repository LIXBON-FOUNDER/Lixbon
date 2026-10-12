package tui

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// anchor es el botón de la barra o del pie que abrió un panel: el panel se
// despliega pegado a él, y no abajo del todo, y el botón queda resaltado
// mientras está abierto.
type anchor struct {
	y    int
	zone span
}

// adoptAnchor le da el botón pulsado al panel que abrió su comando. Algunos
// lo abren al terminar una consulta en segundo plano, así que se espera.
func (m *Model) adoptAnchor() {
	a := m.clickAnchor
	switch {
	case a == nil:
	case m.picker != nil:
		if p := m.picker; p.anchor == nil && p.token == nil {
			p.anchor = a
			if p.tone == "" {
				p.tone = pal.acc
			}
		}
		m.clickAnchor = nil
	case m.busy == "":
		m.clickAnchor = nil
	}
}

// openFrom ejecuta el comando de un botón y recuerda el botón para anclar el
// panel que abra.
func (m *Model) openFrom(y int, zone span, command string) tea.Cmd {
	m.clickAnchor = &anchor{y: y, zone: zone}
	return m.dispatch(command)
}

func (p *picker) chrome() int {
	n := 3 + len(p.body)
	if len(p.body) > 0 {
		n++
	}
	if p.search {
		n++
	}
	return n
}

// popover pinta el panel anclado encima de la pantalla ya compuesta: debajo
// del botón si está arriba, encima si está en el pie.
func (m *Model) popover(screen []string, width, height int) {
	p := m.picker
	a := p.anchor
	w := min(width, max(44, min(72, width*3/5)))
	below := a.y < height/2
	avail := a.y
	if below {
		avail = height - a.y - 2
	}
	if avail < 4 {
		return
	}
	lines := p.view(w, max(1, avail-p.chrome()))
	if len(lines) > avail {
		lines = append(lines[:avail-1], lines[len(lines)-1])
	}
	x := a.zone.x0 - 1
	if (a.zone.x0+a.zone.x1)/2 > width/2 {
		x = a.zone.x1 + 1 - w
	}
	x = max(0, min(x, width-w))
	y := a.y - len(lines)
	if below {
		y = a.y + 1
	}
	for i, line := range lines {
		if row := y + i; row >= 0 && row < len(screen) {
			screen[row] = overlay(screen[row], line, x, w)
		}
	}
	m.panelY, m.panelX, m.panelW, m.panelH = y, x, w, len(lines)
}

// overlay pone over (de ancho w) sobre base a partir de la columna x.
func overlay(base, over string, x, w int) string {
	left := ansi.Truncate(base, x, "")
	if gap := x - ansi.StringWidth(left); gap > 0 {
		left += strings.Repeat(" ", gap)
	}
	return left + "\x1b[m" + over + "\x1b[m" + ansi.TruncateLeft(base, x+w, "")
}

func (m *Model) inPopover(x, y int) bool {
	return x >= m.panelX && x < m.panelX+m.panelW && y >= m.panelY && y < m.panelY+m.panelH
}
