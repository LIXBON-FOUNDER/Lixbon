package tui

import (
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// View compone la pantalla: barra superior fija, transcript y, pegado abajo,
// la zona viva, el menú o panel, la caja de entrada y el pie. La altura total
// es siempre la de la terminal.
func (m *Model) View() tea.View {
	if m.pagerActive() {
		return m.pagerView()
	}
	width, height := max(m.width, 1), max(m.height, 1)
	if m.login != nil {
		v := tea.NewView(m.login.view(width, height))
		v.AltScreen = true
		v.WindowTitle = "lixbon · iniciar sesión"
		return v
	}
	var top []string
	if height >= topBarMinHeight {
		top = append(top, m.topBar(width))
		if height >= ruleMinHeight {
			top = append(top, lipgloss.NewStyle().Foreground(lipgloss.Color(pal.rule)).Render(strings.Repeat(glyphs.rule, width)))
		}
	}

	var bottom []string
	if m.running {
		bottom = append(bottom, m.liveView()...)
	}
	panelAt := -1
	if m.picker != nil {
		chrome := 2 + len(m.picker.body) + 1
		if len(m.picker.body) > 0 {
			chrome++
		}
		if m.picker.search {
			chrome++
		}
		maxRows := height - len(top) - len(bottom) - 1 - chrome
		panelAt = len(bottom)
		bottom = append(bottom, m.picker.view(width, max(1, maxRows))...)
	} else {
		switch {
		case m.shortcutsOpen:
			bottom = append(bottom, m.shortcutsView()...)
		case len(m.menu) > 0:
			bottom = append(bottom, m.menuView()...)
		}
		if len(m.queue) > 0 {
			bottom = append(bottom, m.queueLine())
		}
		bottom = append(bottom, m.inputBox()...)
	}
	bottom = append(bottom, m.footer())
	for i, line := range bottom {
		bottom[i] = ansi.Truncate(line, width, "")
	}

	if len(top)+len(bottom) > height {
		top = nil
	}
	if len(bottom) > height {
		cut := len(bottom) - height
		bottom = bottom[cut:]
		panelAt -= cut
	}
	m.barShown = len(top) > 0
	rows := height - len(top) - len(bottom)
	m.scroll = min(m.scroll, m.log.maxScroll(rows))
	window := m.log.window(rows, m.scroll)
	m.winY, m.winRows, m.winTop = len(top), rows, max(0, m.log.total()-m.scroll-rows)
	m.panelY = -1
	if panelAt >= 0 {
		m.panelY = len(top) + rows + panelAt
	}
	if !m.sel.empty() {
		for y, line := range window {
			window[y] = m.highlight(m.winTop+y, line)
		}
	}

	screen := append(append(top, window...), bottom...)
	v := tea.NewView(strings.Join(screen, "\n"))
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	v.WindowTitle = m.windowTitle()
	return v
}

func (m *Model) windowTitle() string {
	if title := m.chat.Title(); title != "" {
		return "lixbon · " + title
	}
	return "lixbon"
}

// clickChrome atiende los clics fuera del transcript: el modelo y el plan de
// la barra superior, el modo del pie y las filas de un panel.
func (m *Model) clickChrome(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	if msg.Button != tea.MouseLeft {
		return nil, false
	}
	switch {
	case m.picker != nil && m.panelY >= 0 && msg.Y >= m.panelY:
		cmd, closed := m.picker.click(msg.Y - m.panelY)
		if closed {
			m.picker = nil
		}
		return cmd, true
	case m.barShown && msg.Y == 0 && m.picker == nil && !m.busyNow():
		switch {
		case m.barModel.has(msg.X):
			return m.cmdModel(""), true
		case m.barPlan.has(msg.X) && !m.chat.Client.Generic:
			return m.runCommand("usage", ""), true
		}
	case msg.Y == m.height-1 && m.footMode.has(msg.X) && m.picker == nil && !m.busyNow():
		m.cycleMode()
		return nil, true
	}
	return nil, false
}

func (m *Model) sessionLabel() string {
	if m.chat.Client.Generic {
		return m.chat.Cfg.ActiveProfile()
	}
	if m.chat.Cfg.APIKey == "" {
		return "sin sesión"
	}
	if email := m.chat.Cfg.ExtraString("account_email"); email != "" {
		return email
	}
	return "API key"
}
