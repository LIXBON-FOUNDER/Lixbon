package tui

import (
	"fmt"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// pager es el visor del transcript (Ctrl+T): la conversación con todo
// desplegado y, mientras el modelo trabaja, lo que lleva escrito completo,
// sin el recorte de la vista normal.
type pager struct {
	// fromEnd son las filas que el visor está desplazado hacia arriba desde el final.
	fromEnd int
}

func (m *Model) pagerActive() bool { return m.pager != nil && m.picker == nil }

func (m *Model) pageRows() int { return max(1, m.height-2) }

func (m *Model) pagerScroll(rows int) {
	m.pager.fromEnd = max(0, min(m.pager.fromEnd+rows, max(0, len(m.pagerLines())-m.pageRows())))
}

func (m *Model) pagerLines() []string {
	lines := m.log.expanded()
	if !m.running {
		return lines
	}
	lines = append(lines, "", mark(m.spinFrame(), sAccent)+sDim.Render("en curso"))
	if think := strings.TrimSpace(m.live.reasoning.String()); think != "" {
		for _, l := range wrapText(think, max(20, m.width-6)) {
			lines = append(lines, pad+sDim2.Render(glyphThinkRail)+" "+sDim.Italic(true).Render(l))
		}
	}
	if text := strings.TrimSpace(m.live.content.String()); text != "" {
		for _, l := range wrapText(text, max(20, m.width-4)) {
			lines = append(lines, pad+sPrimary.Render(l))
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
	width := max(m.width, 1)
	rows := m.pageRows()
	m.pagerScroll(0)
	all := m.pagerLines()
	end := len(all) - m.pager.fromEnd
	lines := slices.Clone(all[max(0, end-rows):end])
	for len(lines) < rows {
		lines = append(lines, "")
	}
	head := mark(glyphBrand, sAccent) + sBold.Render("Transcript completo") + sDim2.Render(" "+glyphSep+" ") + sDim.Render(fmt.Sprintf("%d filas", len(all)))
	hint := keyHints([2]string{"↑↓ RePág AvPág", "desplazan"}, [2]string{"Inicio Fin", "saltan"}, [2]string{"q, Esc o Ctrl+T", "cierran"})
	if m.pager.fromEnd > 0 {
		hint = sAccent.Render("▲") + " " + hint
	}
	screen := append([]string{head}, lines...)
	screen = append(screen, " "+hint)
	for i, line := range screen {
		screen[i] = ansi.Truncate(line, width, "")
	}
	v := tea.NewView(strings.Join(screen, "\n"))
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	v.WindowTitle = m.windowTitle()
	return v
}
