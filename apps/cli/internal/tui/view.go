package tui

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

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
	if m.pagerActive() {
		return m.pagerView()
	}
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
	for i, line := range lower {
		lower[i] = ansi.Truncate(line, max(m.width, 1), "")
	}

	height := max(m.height, 1)
	if len(lower) > height {
		lower = lower[len(lower)-height:]
	}
	rows := height - len(lower)
	m.scroll = min(m.scroll, m.log.maxScroll(rows))
	window := m.log.window(rows, m.scroll)
	m.winRows, m.winTop = rows, max(0, len(m.log.wrapped)-m.scroll-rows)
	if !m.sel.empty() {
		for y, line := range window {
			window[y] = m.highlight(m.winTop+y, line)
		}
	}

	v := tea.NewView(strings.Join(append(window, lower...), "\n"))
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
			width := max(20, m.width-2)
			wrapped := strings.Split(ansi.Wrap(liveTail(text, liveTailRows, width), width, ""), "\n")
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
	if m.remote != nil {
		return m.remoteBanner()
	}
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
// llevas gastado. En una terminal estrecha se van descartando detalles, de los
// menos a los más importantes, en vez de dejar que la fila se parta.
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
	mode := modeStyle.Render(m.modeName())
	left := " " + dot + " " + sBeige.Render(model) + sep + sDim.Render(m.sessionLabel()) + sep + mode
	if m.notice != "" {
		left += sep + sAccent.Render(m.notice)
	}
	lefts := []string{left, " " + dot + " " + sBeige.Render(model) + sep + mode, " " + dot + " " + mode}

	barStyle := sAccent
	switch {
	case m.ctxPct >= ctxFull:
		barStyle = sErr
	case m.ctxPct >= ctxWarn:
		barStyle = sWarn
	}
	percent := sDim.Render(fmt.Sprintf(" %.0f%%", m.ctxPct))
	context := sDim.Render("contexto ") + barStyle.Render(contextBar(m.ctxPct)) + percent
	tokens := sDim.Render(fmtTokens(max(m.chat.SessionTokens, m.ctxTokens)) + " tokens")
	var flags []string
	if m.chat.WebMode == "on" {
		flags = append(flags, "web")
	}
	if m.remote != nil {
		flags = append(flags, "remoto")
	}
	if m.chat.ProjectContext != "" {
		flags = append(flags, "LIXBON.md")
	}
	full := context + sep + tokens
	if len(flags) > 0 {
		full += sep + sBeige.Render(strings.Join(flags, " "))
	}
	if m.ctxPct >= ctxFull {
		full += sep + sWarn.Render("/compact")
	}
	rights := []string{full + " ", context + sep + tokens + " ", context + " ",
		barStyle.Render(contextBar(m.ctxPct)) + percent + " ", barStyle.Render(fmt.Sprintf("%.0f%%", m.ctxPct)) + " ", ""}

	for _, l := range lefts {
		for _, r := range rights {
			if ansi.StringWidth(l)+ansi.StringWidth(r)+2 <= m.width || r == "" && ansi.StringWidth(l) <= m.width {
				return twoCol(l, r, m.width)
			}
		}
	}
	return ansi.Truncate(lefts[len(lefts)-1], max(m.width, 1), "")
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

// liveTail recorta el texto en vivo a lo último que puede verse: las últimas
// rows líneas duras y, si una sola línea es enorme, solo su final. Así envolver
// en cada fragmento cuesta según lo visible y no según todo lo recibido; antes
// se envolvía la respuesta completa en cada View y el costo crecía con el
// cuadrado del tamaño (TERM-02).
func liveTail(text string, rows, width int) string {
	// Cada fila envuelta ocupa como mucho width celdas; 4 bytes por celda
	// cubren UTF-8 y un margen para secuencias de escape.
	budget := (rows + 1) * width * 4
	start, lines := len(text), 0
	for start > 0 && lines < rows {
		i := strings.LastIndexByte(text[:start], '\n')
		if i < 0 {
			start = 0
			break
		}
		start = i
		lines++
	}
	if start > 0 {
		start++ // tras el salto de línea
	}
	if len(text)-start > budget {
		start = len(text) - budget
		for start < len(text) && !utf8.RuneStart(text[start]) {
			start++
		}
		// Empezar en un límite de palabra evita una primera fila partida.
		if i := strings.IndexAny(text[start:], " \n"); i >= 0 && i < width*4 {
			start += i + 1
		}
	}
	return text[start:]
}
