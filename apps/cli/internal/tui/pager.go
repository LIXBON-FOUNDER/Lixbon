package tui

import (
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// pager es el visor del transcript (Ctrl+T): muestra la conversación, las
// herramientas ejecutadas y, mientras el modelo trabaja, lo que lleva escrito
// completo, sin el recorte de la vista normal.
type pager struct {
	// fromEnd son las filas que el visor está desplazado hacia arriba desde el final.
	fromEnd int
}

func (m *Model) pagerActive() bool { return m.pager != nil && m.picker == nil }

func (m *Model) pageRows() int { return max(1, m.height-1) }

func (m *Model) pagerScroll(rows int) {
	m.pager.fromEnd = max(0, min(m.pager.fromEnd+rows, max(0, len(m.pagerLines())-m.pageRows())))
}

func (m *Model) pagerLines() []string {
	lines := slices.Clone(m.log.wrapped)
	if !m.running {
		return lines
	}
	lines = append(lines, "", sAccent.Render(glyphDot)+sDim.Render(" en curso"))
	for _, part := range []struct {
		text  string
		style lipgloss.Style
	}{{m.live.reasoning.String(), sDim2}, {m.live.content.String(), sPrimary}} {
		text := strings.TrimSpace(part.text)
		if text == "" {
			continue
		}
		for _, l := range strings.Split(ansi.Wrap(text, max(20, m.width-2), ""), "\n") {
			lines = append(lines, "  "+part.style.Render(l))
		}
	}
	return lines
}

func (m *Model) handlePagerKey(msg tea.KeyPressMsg) {
	page := max(1, m.pageRows()-1)
	switch msg.String() {
	case "q", "esc", "ctrl+t", "ctrl+c":
		m.pager = nil
	case "up", "k":
		m.pagerScroll(1)
	case "down", "j", "enter":
		m.pagerScroll(-1)
	case "pgup", "b":
		m.pagerScroll(page)
	case "pgdown", "space", "f":
		m.pagerScroll(-page)
	case "home", "g":
		m.pagerScroll(len(m.pagerLines()))
	case "end", "G":
		m.pager.fromEnd = 0
	}
}

func (m *Model) pagerView() tea.View {
	rows := m.pageRows()
	m.pagerScroll(0)
	all := m.pagerLines()
	end := len(all) - m.pager.fromEnd
	lines := slices.Clone(all[max(0, end-rows):end])
	for len(lines) < rows {
		lines = append(lines, "")
	}
	for i, line := range lines {
		lines[i] = ansi.Truncate(line, max(m.width, 1), "")
	}
	hint := "↑↓ RePág/AvPág Inicio/Fin desplazan  " + glyphSep + "  q, Esc o Ctrl+T cierran"
	if m.pager.fromEnd > 0 {
		hint = "▲ " + hint
	}
	footer := ansi.Truncate(" "+sDim.Render(hint), max(m.width, 1), "")

	v := tea.NewView(strings.Join(append(lines, footer), "\n"))
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	v.WindowTitle = m.windowTitle()
	return v
}
