package tui

import (
	"fmt"
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
	if m.compacting != nil {
		bottom = append(bottom, m.compactView()...)
	}
	// liveN son las filas de lo que hace el agente ahora (pensando,
	// escribiendo…): con poco escrito suben detrás del último mensaje.
	liveN := len(bottom)
	// Aire entre lo que hace el agente y la caja o el panel de abajo.
	if height >= breathMinHeight {
		bottom = append(bottom, "")
	}
	panelAt := -1
	anchored := m.picker != nil && m.picker.anchor != nil
	if m.picker != nil && !anchored {
		maxRows := height - len(top) - len(bottom) - 1 - m.picker.chrome()
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
	footerShown := len(bottom) <= height
	if len(bottom) > height {
		cut := len(bottom) - height
		bottom = bottom[cut:]
		panelAt -= cut
		liveN = max(0, liveN-cut)
	}
	m.barShown = len(top) > 0
	rows := height - len(top) - len(bottom)
	// Con la vista subida, si la zona de abajo crece o encoge (lo que piensa,
	// la salida en vivo) la ventana conserva su primera fila: lo que se está
	// leyendo no se mueve.
	if m.scroll > 0 && m.winRows > 0 && rows != m.winRows {
		m.scroll = max(0, m.scroll+m.winRows-rows)
	}
	if e := m.anchorTop; e != nil {
		m.anchorTop = nil
		if start, total := m.log.start(e), m.log.total(); total-start > rows {
			m.scroll = total - rows - max(0, start-1)
		}
	}
	m.scroll = min(m.scroll, m.log.maxScroll(rows))
	window := m.log.window(rows, m.scroll)
	m.winY, m.winRows, m.winTop = len(top), rows, max(0, m.log.total()-m.scroll-rows)
	// Mientras el transcript cabe, lo que hace el agente ahora (pensando,
	// escribiendo…) va justo detrás del último mensaje y el hueco queda entre
	// eso y la caja, que sigue abajo con el pie.
	gap := 0
	if total := m.log.total(); liveN > 0 && m.scroll == 0 && total < rows {
		gap = rows - total
		window = window[:total]
		m.winRows = total
	}
	m.footY = height - 1
	if len(bottom) > 0 && footerShown {
		bottom[len(bottom)-1] = ansi.Truncate(m.footer(), width, "")
	}
	m.panelY = -1
	if panelAt >= 0 {
		m.panelY = len(top) + rows + panelAt
	}
	if !m.sel.empty() {
		for y, line := range window {
			window[y] = m.highlight(m.winTop+y, line)
		}
	}
	m.moreY = -1
	if m.scroll > 0 && rows >= 3 {
		m.moreY = len(top) + rows - 1
		window[rows-1] = m.moreButton(width)
	}

	screen := append(append(top, window...), bottom[:liveN]...)
	for range gap {
		screen = append(screen, "")
	}
	screen = append(screen, bottom[liveN:]...)
	if anchored {
		m.popover(screen, width, height)
	}
	v := tea.NewView(strings.Join(screen, "\n"))
	v.AltScreen = true
	// AllMotion y no CellMotion: sin botón pulsado también llega el
	// movimiento, que es lo que ilumina las zonas clicables al pasar por encima.
	v.MouseMode = tea.MouseModeAllMotion
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
	if p := m.picker; p != nil && p.anchor != nil {
		if m.inPopover(msg.X, msg.Y) {
			y := msg.Y - m.panelY
			return m.pickerDo(func(p *picker) (tea.Cmd, bool) { return p.click(y) }), true
		}
		// Fuera del panel lo cierra, como un menú desplegable.
		return m.pickerDo(func(p *picker) (tea.Cmd, bool) { return p.done(p.cancel, true), true }), true
	}
	switch {
	case m.moreY >= 0 && msg.Y == m.moreY && m.moreBtn.has(msg.X):
		m.scroll = 0
		return nil, true
	case m.picker != nil && m.panelY >= 0 && msg.Y >= m.panelY:
		y := msg.Y - m.panelY
		return m.pickerDo(func(p *picker) (tea.Cmd, bool) { return p.click(y) }), true
	// Los botones responden también con el agente trabajando: lo que cambian
	// (modelo, razonamiento, modo) vale desde su siguiente paso.
	case m.barShown && msg.Y == 0 && m.picker == nil:
		switch {
		case m.barModel.has(msg.X):
			return m.openFrom(0, m.barModel, "/model"), true
		case m.barPlan.has(msg.X) && !m.chat.Client.Generic:
			return m.openFrom(0, m.barPlan, "/usage"), true
		case m.barBranch.has(msg.X):
			return m.openFrom(0, m.barBranch, "/branch"), true
		}
	case msg.Y == m.footY && m.picker == nil:
		switch {
		case m.footProcs.has(msg.X):
			return m.openFrom(msg.Y, m.footProcs, "/ps"), true
		case m.footMode.has(msg.X):
			m.cycleMode()
			return nil, true
		case m.footEffort.has(msg.X):
			return m.openFrom(msg.Y, m.footEffort, "/effort"), true
		}
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

// hot dice si el ratón está sobre la zona z de la fila y.
func (m *Model) hot(y int, z span) bool { return m.hoverY == y && z.has(m.hoverX) }

// lit pinta una zona clicable con el fondo de la fila elegida si el ratón está encima.
func (m *Model) lit(text string, y int, z span) string {
	if p := m.picker; p != nil && p.anchor != nil && p.anchor.y == y && p.anchor.zone == z {
		return withBackground(text, pal.olive)
	}
	if !m.hot(y, z) {
		return text
	}
	return withBackground(text, pal.surf2)
}

// moreButton es el botón al pie del transcript cuando hay más por debajo: un
// clic baja al final.
func (m *Model) moreButton(width int) string {
	down := "↓"
	if glyphs.boxH == "-" {
		down = "v"
	}
	label := fmt.Sprintf(" %s %d %s ", down, m.scroll, plural(m.scroll, "línea más", "líneas más"))
	w := ansi.StringWidth(label)
	x := max(0, (width-w)/2)
	m.moreBtn = span{x, x + w}
	style := sSoft
	bg := pal.surf2
	if m.hot(m.moreY, m.moreBtn) {
		style, bg = sInk, pal.rule
	}
	return strings.Repeat(" ", x) + withBackground(style.Render(label), bg)
}
