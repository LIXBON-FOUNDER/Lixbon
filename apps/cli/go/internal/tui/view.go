package tui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/toolparse"
)

var spinFrames = []string{"✻", "✦", "✧", "✦"}

const (
	liveTailRows = 8
	ctxWarn      = 60.0
	ctxFull      = 85.0
)

// View compone la pantalla completa: el transcript arriba y, pegado al borde
// inferior, el texto en vivo, el menú, la caja de entrada y la barra de estado.
// La altura total es siempre la de la terminal.
func (m *Model) View() tea.View {
	var bottom []string
	if m.running {
		bottom = append(bottom, m.liveView())
	}
	if m.picker != nil {
		bottom = append(bottom, m.picker.view(m.width))
	} else {
		if len(m.menu) > 0 {
			bottom = append(bottom, m.menuView())
		}
		if len(m.queue) > 0 {
			bottom = append(bottom, m.queueLine())
		}
		bottom = append(bottom, m.inputBox())
	}
	bottom = append(bottom, m.statusBar())
	lower := strings.Split(strings.Join(bottom, "\n"), "\n")

	height := max(m.height, 1)
	if len(lower) > height {
		lower = lower[len(lower)-height:]
	}
	rows := height - len(lower)
	m.scroll = min(m.scroll, m.log.maxScroll(rows))
	lines := append(m.log.window(rows, m.scroll), lower...)

	v := tea.NewView(strings.Join(lines, "\n"))
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

func (m *Model) queueLine() string {
	n := len(m.queue)
	label := fmt.Sprintf("%d en cola", n)
	return sDim2.Render("  " + glyphDot + " " + label + " " + glyphSep + " se envía al terminar")
}

func (m *Model) liveView() string {
	frame := spinFrames[m.spin%len(spinFrames)]
	elapsed := time.Since(m.started).Seconds()
	label := "trabajando"
	if m.live.reasoning.Len() > 0 && m.live.content.Len() == 0 {
		label = "pensando"
	}
	hint := "Esc interrumpe"
	if m.interrupted {
		hint = "interrumpiendo…"
	}
	lines := []string{"", twoCol(sAccent.Render(frame)+" "+sDim.Render(label+"…"),
		sDim2.Render(fmt.Sprintf("%.0f s %s %s", elapsed, glyphSep, hint)), m.width)}

	if m.live.reasoning.Len() > 0 && m.live.content.Len() == 0 {
		tail := strings.Split(strings.TrimSpace(m.live.reasoning.String()), "\n")
		for _, l := range tail[max(0, len(tail)-3):] {
			lines = append(lines, rail(false)+sDim2.Render(ansi.Truncate(l, max(10, m.width-4), glyphEllipsis)))
		}
	}
	if m.live.content.Len() > 0 {
		text := m.live.content.String()
		if m.chat.Mode == chat.ModeAgent {
			text = toolparse.CleanProse(text)
			if text == "" {
				lines = append(lines, sDim.Render("  "+glyphThink+" preparando acciones…"))
			}
		}
		if text = strings.TrimSpace(text); text != "" {
			wrapped := strings.Split(ansi.Wrap(text, max(20, m.width-2), ""), "\n")
			for _, l := range wrapped[max(0, len(wrapped)-liveTailRows):] {
				lines = append(lines, "  "+sPrimary.Render(l))
			}
		}
	}
	return strings.Join(lines, "\n")
}

func (m *Model) borderColor() lipgloss.Style {
	color := cDim2
	switch m.modeName() {
	case "agent":
		color = cAccent
	case "plan":
		color = cPlan
	}
	if m.prompt != nil {
		color = cWarn
	}
	return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(color).Width(max(20, m.width))
}

func (m *Model) inputBox() string {
	return m.borderColor().Render(m.input.View())
}

func (m *Model) menuView() string {
	start := 0
	if len(m.menu) > menuVisible {
		start = max(0, min(m.menuCursor-menuVisible/2, len(m.menu)-menuVisible))
	}
	end := min(len(m.menu), start+menuVisible)
	var lines []string
	for i := start; i < end; i++ {
		s := m.menu[i]
		label := fmt.Sprintf("%-*s", NameWidth, "/"+s.Name)
		args := ""
		if s.Args != "" {
			args = " " + s.Args
		}
		row := label + sDim2.Render(args) + "  " + sDim.Render(s.Desc)
		if i == m.menuCursor {
			row = sAccent.Render(glyphEdge+" ") + sBold.Render(label) + sDim.Render(args) + "  " + sPrimary.Render(s.Desc)
		} else {
			row = "  " + sBeige.Render(label) + sDim2.Render(args) + "  " + sDim.Render(s.Desc)
		}
		lines = append(lines, ansi.Truncate(row, m.width, glyphEllipsis))
	}
	return strings.Join(lines, "\n")
}

// statusBar: a la izquierda quién eres y con qué trabajas; a la derecha cuánto
// llevas gastado.
func (m *Model) statusBar() string {
	dot := sOK.Render(glyphDot)
	switch {
	case !m.online:
		dot = sErr.Render(glyphDot)
	case m.running:
		dot = sAccent.Render(glyphDot)
	}
	sep := sDim2.Render("  " + glyphSep + "  ")
	model := m.chat.Model
	if model == "" {
		model = "sin modelo"
	}
	modeStyle := sDim
	switch m.modeName() {
	case "agent":
		modeStyle = sAccent
	case "plan":
		modeStyle = sPlan
	}
	left := " " + dot + " " + sBeige.Render(model) + sep + sDim.Render(m.sessionLabel()) + sep + modeStyle.Render(m.modeName())
	if m.notice != "" {
		left += sep + sAccent.Render(m.notice)
	}

	barStyle := sAccent
	switch {
	case m.ctxPct >= ctxFull:
		barStyle = sErr
	case m.ctxPct >= ctxWarn:
		barStyle = sWarn
	}
	right := sDim.Render("contexto ") + barStyle.Render(contextBar(m.ctxPct)) + sDim.Render(fmt.Sprintf(" %.0f%%", m.ctxPct)) +
		sep + sDim.Render(fmtTokens(max(m.chat.SessionTokens, m.ctxTokens))+" tokens")
	var flags []string
	if m.chat.WebMode == "on" {
		flags = append(flags, "web")
	}
	if m.chat.ProjectContext != "" {
		flags = append(flags, "LIXBON.md")
	}
	if len(flags) > 0 {
		right += sep + sBeige.Render(strings.Join(flags, " "))
	}
	if m.ctxPct >= ctxFull {
		right += sep + sWarn.Render("/compact")
	}
	right += " "
	return twoCol(left, right, m.width)
}

func (m *Model) sessionLabel() string {
	if m.chat.Cfg.APIKey == "" {
		return "sin sesión"
	}
	if email := m.chat.Cfg.ExtraString("account_email"); email != "" {
		return email
	}
	return "API key"
}
