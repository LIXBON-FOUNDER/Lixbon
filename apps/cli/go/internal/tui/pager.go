package tui

import (
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

const (
	wheelStep   = 3
	resumeDelay = 120 * time.Millisecond
	// Bubble Tea inserta lo impreso suponiendo que el primer fotograma ya se
	// dibujó; si no, el fotograma pisa lo impreso.
	firstFrameDelay = 100 * time.Millisecond
)

type (
	resumePrintMsg struct{}
	readyMsg       struct{}
)

// pager es el visor de pantalla completa del transcript (Ctrl+T). La
// conversación normal vive en el scrollback de la terminal; el visor existe
// para releerla reajustada al ancho actual y moverse con el teclado.
type pager struct {
	// fromEnd son las filas que el visor está desplazado hacia arriba desde el final.
	fromEnd int
}

func (m *Model) pagerActive() bool { return m.pager != nil && m.picker == nil }

func (m *Model) openPager(fromEnd int) {
	m.pager = &pager{fromEnd: fromEnd}
}

func (m *Model) pageRows() int { return max(1, m.height-1) }

func (m *Model) pagerScroll(rows int) {
	m.pager.fromEnd = max(0, min(m.pager.fromEnd+rows, max(0, len(m.pagerLines())-m.pageRows())))
}

// pagerLines es el transcript más, mientras el modelo trabaja, lo que lleva
// escrito hasta ahora completo (la vista normal solo enseña la cola).
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

// syncOutput mantiene retenido lo impreso mientras el visor ocupa la pantalla
// alternativa y lo suelta cuando la terminal ya volvió a la pantalla normal.
func (m *Model) syncOutput() tea.Cmd {
	if m.out == nil {
		return nil
	}
	switch {
	case m.pagerActive() && !m.printHeld:
		m.out.hold(true)
		m.printHeld = true
	case !m.pagerActive() && m.printHeld && !m.resumeQueued:
		m.resumeQueued = true
		return tea.Tick(resumeDelay, func(time.Time) tea.Msg { return resumePrintMsg{} })
	}
	return nil
}

func (m *Model) resumePrint() {
	m.resumeQueued = false
	if m.pagerActive() || !m.printHeld {
		return
	}
	m.out.hold(false)
	m.printHeld = false
}
