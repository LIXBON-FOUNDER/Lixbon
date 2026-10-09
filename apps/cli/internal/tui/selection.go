package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

const wheelStep = 3

var sSelected = lipgloss.NewStyle().Reverse(true)

type point struct{ row, col int }

// selection es lo seleccionado con el ratón en el transcript. Con la rueda
// siempre activa la terminal ya no selecciona sola, así que la app lo hace y
// copia al soltar. Las filas son del transcript, no de la pantalla: sobrevive
// al desplazamiento.
type selection struct {
	anchor, head point
	dragging     bool
}

func (s *selection) empty() bool { return s == nil || s.anchor == s.head }

func (s *selection) bounds() (from, to point) {
	from, to = s.anchor, s.head
	if to.row < from.row || to.row == from.row && to.col < from.col {
		from, to = to, from
	}
	return from, to
}

// span devuelve las columnas [a, b) seleccionadas en una fila de ancho width.
func (s *selection) span(row, width int) (a, b int, ok bool) {
	if s.empty() {
		return 0, 0, false
	}
	from, to := s.bounds()
	if row < from.row || row > to.row {
		return 0, 0, false
	}
	a, b = 0, width
	if row == from.row {
		a = from.col
	}
	if row == to.row {
		b = to.col + 1
	}
	return a, min(b, width), a < min(b, width)
}

func (m *Model) wheel(button tea.MouseButton) {
	switch button {
	case tea.MouseWheelUp:
		m.scrollBy(wheelStep)
	case tea.MouseWheelDown:
		m.scrollBy(-wheelStep)
	}
}

func (m *Model) scrollBy(rows int) {
	m.scroll = max(0, m.scroll+rows)
}

func (m *Model) pointAt(x, y int) (point, bool) {
	if y < 0 || y >= m.winRows {
		return point{}, false
	}
	row := m.winTop + y
	if row >= len(m.log.wrapped) {
		return point{}, false
	}
	return point{row: row, col: max(0, x)}, true
}

func (m *Model) onMouseDown(msg tea.MouseClickMsg) {
	m.sel = nil
	if msg.Button != tea.MouseLeft {
		return
	}
	if p, ok := m.pointAt(msg.X, msg.Y); ok {
		m.sel = &selection{anchor: p, head: p, dragging: true}
	}
}

func (m *Model) onMouseDrag(msg tea.MouseMotionMsg) {
	if m.sel == nil || !m.sel.dragging {
		return
	}
	switch {
	case msg.Y <= 0:
		m.scrollBy(1)
	case msg.Y >= m.winRows-1:
		m.scrollBy(-1)
	}
	y := min(max(msg.Y, 0), m.winRows-1)
	if p, ok := m.pointAt(msg.X, y); ok {
		m.sel.head = p
	}
}

func (m *Model) onMouseUp() tea.Cmd {
	if m.sel == nil || !m.sel.dragging {
		return nil
	}
	m.sel.dragging = false
	if m.sel.empty() {
		m.sel = nil
		return nil
	}
	text := m.selectedText()
	m.notice = fmt.Sprintf("%d caracteres copiados", len([]rune(text)))
	return tea.Batch(tea.SetClipboard(text), func() tea.Msg {
		_ = m.copyText(text)
		return nil
	})
}

func (m *Model) selectedText() string {
	if m.sel.empty() {
		return ""
	}
	from, to := m.sel.bounds()
	var out []string
	for row := from.row; row <= to.row && row < len(m.log.wrapped); row++ {
		plain := ansi.Strip(m.log.wrapped[row])
		a, b, _ := m.sel.span(row, ansi.StringWidth(plain))
		out = append(out, strings.TrimRight(ansi.Cut(plain, a, b), " "))
	}
	return strings.Join(out, "\n")
}

// highlight marca en inverso lo seleccionado de la fila row.
func (m *Model) highlight(row int, line string) string {
	a, b, ok := m.sel.span(row, ansi.StringWidth(line))
	if !ok {
		return line
	}
	return ansi.Cut(line, 0, a) + sSelected.Render(ansi.Strip(ansi.Cut(line, a, b))) + ansi.Cut(line, b, ansi.StringWidth(line))
}
