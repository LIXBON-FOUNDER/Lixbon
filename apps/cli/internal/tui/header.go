package tui

import (
	"path/filepath"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
)

// Alturas a partir de las que se muestran la barra superior y su regla.
const (
	topBarMinHeight = 12
	ruleMinHeight   = 24
	breathMinHeight = 16
)

// span es un tramo clicable de una fila: [x0, x1).
type span struct{ x0, x1 int }

func (s span) has(x int) bool { return x >= s.x0 && x < s.x1 }

func modeStyle(mode string) lipgloss.Style {
	switch mode {
	case "agent":
		return sAccent
	case "plan":
		return sPlan
	case "delegate":
		return sBeige
	}
	return sSoft
}

// modeBorder es el color del borde de la caja según el modo.
func modeBorder(mode string) string {
	switch mode {
	case "agent":
		return pal.olive
	case "plan":
		return pal.info
	case "delegate":
		return pal.sand
	}
	return pal.faint
}

func (m *Model) planLabel() string {
	if m.chat.Client.Generic {
		return ""
	}
	return m.chat.Cfg.ExtraString("plan_name")
}

func (m *Model) hasSession() bool { return m.chat.Client.Generic || m.chat.Cfg.APIKey != "" }

// topBar es la fila fija de arriba: quién y dónde (marca, carpeta, rama y
// marcas activas) a la izquierda; con qué (plan y modelo) a la derecha. En
// una terminal estrecha suelta piezas de la menos a la más importante.
func (m *Model) topBar(width int) string {
	brandStyle := sAccent
	switch {
	case !m.hasSession():
		brandStyle = sDim
	case !m.online:
		brandStyle = sErr
	}
	ivory := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.ivory))
	model := sInk.Render(m.modelLabel(m.chat.Model))
	if m.chat.Model == "" {
		model = sDim2.Render("sin modelo")
	}
	model = m.lit(model, 0, m.barModel)
	var plan string
	switch {
	case m.chat.Client.Generic:
		plan = sSoft.Render(m.chat.Cfg.ActiveProfile()) + sDim2.Render(" "+glyphSep+" ") + sDim.Render(providerHost(m.chat.Client.BaseURL))
	case !m.hasSession():
		plan = sWarn.Render("sin sesión")
	case m.planLabel() != "":
		plan = ivory.Render(m.planLabel())
	}
	var flags []string
	if m.remote != nil {
		flags = append(flags, sAccent.Render(glyphDot)+" "+sSoft.Render("remote"))
	}
	if m.chat.WebMode == "on" {
		flags = append(flags, sSoft.Render("web"))
	}
	if m.chat.ProjectContext != "" {
		flags = append(flags, sSoft.Render("LIXBON.md"))
	}
	branch := func(limit int) string {
		if m.branch == "" {
			return ""
		}
		return "  " + m.lit(sDim2.Render(glyphBranch+" ")+sSoft.Render(ansi.Truncate(m.branch, limit, glyphEllipsis)), 0, m.barBranch)
	}
	dot := sDim2.Render("  " + glyphSep + "  ")
	brand := " " + brandStyle.Render(glyphBrand) + " "
	type variant struct{ head, branch, tail, planText, model string }
	var tail, remoteTail string
	if len(flags) > 0 {
		tail = "    " + strings.Join(flags, sDim2.Render(" "+glyphSep+" "))
	}
	if m.remote != nil {
		remoteTail = "  " + flags[0]
	}
	planFull, planShort := plan, plan
	if plan != "" && !m.chat.Client.Generic && m.hasSession() {
		planFull = sDim.Render("plan ") + plan
	}
	if q := m.quotaLabel(false); q != "" {
		planFull = strings.TrimSpace(planFull + dot + q)
		planShort = strings.TrimSpace(planShort + dot + m.quotaLabel(true))
	}
	variants := []variant{
		{brand + ivory.Render("LIXBON") + "   " + sBeige.Render(shortPath(m.chat.Workspace)), branch(40), tail, planFull, model},
		{brand + ivory.Render("LIXBON") + "   " + sBeige.Render(shortPath(m.chat.Workspace)), branch(24), tail, planShort, model},
		{brand + ivory.Render("LIXBON") + "  " + sBeige.Render(shortPath(m.chat.Workspace)), branch(16), remoteTail, plan, model},
		{brand + sBeige.Render(filepath.Base(m.chat.Workspace)), branch(10), remoteTail, "", model},
		{brand + sBeige.Render(filepath.Base(m.chat.Workspace)), "", remoteTail, "", model},
		{brand + sBeige.Render(filepath.Base(m.chat.Workspace)), "", "", "", model},
	}
	for _, v := range variants {
		right := v.model
		if v.planText != "" {
			right = m.lit(v.planText, 0, m.barPlan) + dot + v.model
		}
		right += " "
		left := v.head + v.branch + v.tail
		if ansi.StringWidth(left)+ansi.StringWidth(right)+2 <= width {
			m.recordBarZones(width, right, v.model, v.planText)
			m.barBranch = span{}
			if v.branch != "" {
				x := ansi.StringWidth(v.head) + 2
				m.barBranch = span{x, ansi.StringWidth(v.head) + ansi.StringWidth(v.branch)}
			}
			return twoCol(left, right, width)
		}
	}
	last := variants[len(variants)-1]
	m.barModel, m.barPlan, m.barBranch = span{}, span{}, span{}
	return ansi.Truncate(last.head, max(1, width), "")
}

// recordBarZones apunta dónde quedaron el plan y el modelo para los clics.
func (m *Model) recordBarZones(width int, right, model, plan string) {
	start := width - ansi.StringWidth(right)
	m.barPlan = span{}
	if plan != "" {
		m.barPlan = span{start, start + ansi.StringWidth(plan)}
	}
	end := width - 1
	m.barModel = span{end - ansi.StringWidth(model), end}
}

// headerLayout pone el texto junto al logo si cabe y, si no, debajo; en una
// terminal más estrecha que el logo lo omite. Nunca parte una fila del logo.
func headerLayout(logo, text []string, logoWidth, width int) string {
	const margin, gap = 3, 4
	pad := strings.Repeat(" ", margin)
	fit := func(s string, room int) string { return ansi.Truncate(s, max(room, 1), glyphEllipsis) }
	var lines []string
	switch {
	case len(logo) > 0 && width >= margin+logoWidth+gap+40:
		for i := range max(len(logo), len(text)) {
			line := pad + strings.Repeat(" ", logoWidth)
			if i < len(logo) {
				line = pad + logo[i]
			}
			if i < len(text) && text[i] != "" {
				line += strings.Repeat(" ", gap) + fit(text[i], width-margin-logoWidth-gap)
			}
			lines = append(lines, line)
		}
	case len(logo) > 0 && width >= margin+logoWidth+1:
		for _, row := range logo {
			lines = append(lines, pad+row)
		}
		for _, l := range text {
			if l != "" {
				lines = append(lines, pad+fit(l, width-margin))
			}
		}
	default:
		for _, l := range text {
			if l != "" {
				lines = append(lines, fit(" "+l, width))
			}
		}
	}
	return strings.Join(lines, "\n")
}

// printHeader pone la tarjeta de bienvenida al principio del transcript (se
// desplaza con la conversación) y los avisos de arranque.
func (m *Model) printHeader() {
	m.refreshGit()
	m.print("")
	m.header = m.printDynamic(func(width int) string {
		c := m.chat
		dot := sDim2.Render(" " + glyphSep + " ")
		info := sSoft.Render(firstNonEmpty(m.modelLabel(c.Model), "sin modelo")) + dot + modeStyle(m.modeName()).Render(m.modeName())
		if plan := m.planLabel(); plan != "" {
			info += dot + sSoft.Render("plan "+plan)
		}
		if profile := c.Cfg.ActiveProfile(); profile != config.DefaultProfile {
			info = sSoft.Render(profile) + dot + info
		}
		place := sBeige.Render(shortPath(c.Workspace))
		if m.branch != "" {
			place += sDim2.Render("  "+glyphBranch+" ") + sSoft.Render(m.branch)
		}
		sep := sDim2.Render("  " + glyphSep + "  ")
		key := func(k, label string) string { return sSoft.Render(k) + sDim.Render(" "+label) }
		tips := key("/", "comandos") + sep + key("!", "shell") + sep + key("@", "archivos") + sep + key("?", "atajos")
		text := []string{"", sBold.Render("LIXBON CLI") + sDim.Render("  "+m.opts.Version), info, place, "", tips}
		return headerLayout(renderLogo(cardLogoSize), text, cardLogoSize, width)
	})
	m.headerKey = m.headerSignature()
	m.print("")
	if m.chat.Mode == chat.ModeAsk {
		m.add(infoLine("Modo ask: el modelo solo conversa", "/mode agent para que cree y edite archivos"))
	}
	if m.chat.ProjectContext != "" {
		m.add(infoLine("LIXBON.md encontrado", "se usa como contexto del proyecto"))
	}
}

func (m *Model) headerSignature() string {
	return strings.Join([]string{m.chat.Workspace, m.branch, m.chat.Model, m.modeName(), m.planLabel(), m.chat.Cfg.ActiveProfile()}, "|")
}

// syncHeader repinta la tarjeta de bienvenida si cambió algo de lo que enseña
// (carpeta, rama, modelo, modo o plan).
func (m *Model) syncHeader() {
	if m.header == nil {
		return
	}
	if key := m.headerSignature(); key != m.headerKey {
		m.headerKey = key
		m.refresh(m.header)
	}
}
