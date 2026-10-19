package tui

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/session"
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

func (m *Model) planLabel() string {
	if m.chat.Client.Generic {
		return ""
	}
	return m.chat.Cfg.ExtraString("plan_name")
}

func (m *Model) hasSession() bool { return m.chat.Client.Generic || m.chat.Cfg.APIKey != "" }

// topBar es la fila fija de arriba: lixbon, la carpeta y la rama a la
// izquierda; el plan y el cupo de la sesión, con su barra, a la derecha. En
// una terminal estrecha suelta piezas de la menos a la más importante.
func (m *Model) topBar(width int) string {
	brandStyle := sInk
	switch {
	case !m.hasSession():
		brandStyle = sDim
	case !m.online:
		brandStyle = sErr
	}
	var plan string
	switch {
	case m.chat.Client.Generic:
		// Con otro proveedor no hay cupo de lixbon: solo su nombre. El host
		// está en la tarjeta de bienvenida y en /provider.
		plan = sDim.Render(m.chat.Cfg.ActiveProfile())
	case !m.hasSession():
		plan = sWarn.Render("sin sesión")
	case m.planLabel() != "":
		plan = sDim.Render(m.planLabel())
	}
	var flags []string
	if m.remote != nil {
		flags = append(flags, sAccent.Render(glyphDot)+" "+sSoft.Render("remote"))
	}
	if m.chat.WebMode == "on" {
		flags = append(flags, sDim.Render("web"))
	}
	if m.chat.ProjectContext != "" {
		flags = append(flags, sDim.Render("LIXBON.md"))
	}
	branch := func(limit int) string {
		if m.branch == "" {
			return ""
		}
		return "   " + m.lit(sDim.Render(glyphBranch+" "+ansi.Truncate(m.branch, limit, glyphEllipsis)), 0, m.barBranch)
	}
	var tail, remoteTail string
	if len(flags) > 0 {
		tail = "     " + strings.Join(flags, "   ")
	}
	if m.remote != nil {
		remoteTail = "   " + flags[0]
	}
	session := func(cells int) string {
		q := m.quota
		if q == nil || m.chat.Client.Generic || q.session.Unlimited {
			return ""
		}
		pct := min(100, q.session.Percent)
		text := sDim.Render("sesión  ") + meter(pct, cells) + "  " + pctStyle(pct).Render(fmt.Sprintf("%.0f %%", pct))
		if cells == 0 {
			text = sDim.Render("sesión ") + pctStyle(pct).Render(fmt.Sprintf("%.0f %%", pct))
		}
		return text
	}
	joinPlan := func(p, q string) string {
		switch {
		case p == "":
			return q
		case q == "":
			return p
		}
		return p + "   " + q
	}
	// El ◆ de la marca va en la señal mientras hay sesión y conexión.
	brand := brandStyle.Render("lixbon")
	if m.hasSession() && m.online {
		brand = sAccent.Render(glyphBrand) + " " + brand
	}
	head := " " + brand + "   " + sDim.Render(filepath.Base(m.chat.Workspace))
	type variant struct{ head, branch, tail, right string }
	variants := []variant{
		{head, branch(40), tail, joinPlan(plan, session(12))},
		{head, branch(24), tail, joinPlan(plan, session(8))},
		{head, branch(16), remoteTail, joinPlan(plan, session(0))},
		{head, branch(10), remoteTail, session(0)},
		{head, "", remoteTail, session(0)},
		{head, "", "", ""},
	}
	for _, v := range variants {
		right := ""
		if v.right != "" {
			right = m.lit(v.right, 0, m.barPlan) + " "
		}
		left := v.head + v.branch + v.tail
		if ansi.StringWidth(left)+ansi.StringWidth(right)+2 <= width || right == "" && ansi.StringWidth(left) <= width {
			m.barPlan = span{}
			if v.right != "" {
				start := width - ansi.StringWidth(right)
				m.barPlan = span{start, start + ansi.StringWidth(v.right)}
			}
			m.barBranch = span{}
			if v.branch != "" {
				x := ansi.StringWidth(v.head) + 3
				m.barBranch = span{x, ansi.StringWidth(v.head) + ansi.StringWidth(v.branch)}
			}
			return twoCol(left, right, width)
		}
	}
	m.barPlan, m.barBranch = span{}, span{}
	return ansi.Truncate(head, max(1, width), "")
}

// pctStyle colorea un porcentaje de uso: tinta hasta el aviso, luego ámbar
// y coral.
func pctStyle(pct float64) lipgloss.Style {
	switch {
	case pct >= ctxFull:
		return sErr
	case pct >= ctxWarn:
		return sWarn
	}
	return sSoft
}

// headerLayout pone el texto junto al logo, centrado en su alto, si cabe y,
// si no, debajo; en una terminal más estrecha que el logo lo omite. Nunca
// parte una fila del logo.
func headerLayout(logo, text []string, logoWidth, width int) string {
	const margin, gap = 2, 3
	pad := strings.Repeat(" ", margin)
	fit := func(s string, room int) string { return ansi.Truncate(s, max(room, 1), glyphEllipsis) }
	var lines []string
	switch {
	case len(logo) > 0 && width >= margin+logoWidth+gap+40:
		top := max(0, (len(logo)-len(text))/2)
		for i := range max(len(logo), top+len(text)) {
			line := pad + strings.Repeat(" ", logoWidth)
			if i < len(logo) {
				line = pad + logo[i]
			}
			if j := i - top; j >= 0 && j < len(text) && text[j] != "" {
				line += strings.Repeat(" ", gap) + fit(text[j], width-margin-logoWidth-gap)
			}
			lines = append(lines, line)
		}
	case len(logo) > 0 && width >= margin+logoWidth+1:
		for _, row := range logo {
			lines = append(lines, pad+row)
		}
		lines = append(lines, "")
		for _, l := range text {
			if l != "" {
				lines = append(lines, pad+fit(l, width-margin))
			}
		}
	default:
		for _, l := range text {
			if l != "" {
				lines = append(lines, fit(pad+l, width))
			}
		}
	}
	return strings.Join(lines, "\n")
}

// printHeader pone la tarjeta de bienvenida al principio del transcript (se
// desplaza con la conversación): el prisma y, a su lado, la versión, la
// carpeta, el modelo y la cuenta; debajo, los atajos y las conversaciones
// recientes de esta carpeta.
func (m *Model) printHeader() {
	m.refreshGit()
	m.print("")
	recent := m.recentConversations(3)
	m.header = m.printDynamic(func(width int) string {
		c := m.chat
		label := func(s string) string { return sDim.Render(s) }
		place := label("carpeta  ") + sInk.Render(shortPath(c.Workspace))
		if m.branch != "" {
			place += label("   " + glyphBranch + " " + m.branch)
		}
		model := label("modelo   ") + sInk.Render(firstNonEmpty(m.modelLabel(c.Model), "sin modelo"))
		if e := m.effortLabel(); e != "" {
			model += label("   " + e)
		}
		var account string
		switch {
		case c.Client.Generic:
			account = sInk.Render(c.Cfg.ActiveProfile()) + label("   "+providerHost(c.Client.BaseURL))
		case !m.hasSession():
			account = sWarn.Render("sin sesión") + label("   /login")
		case m.planLabel() != "":
			account = sInk.Render("Plan " + m.planLabel())
		default:
			account = sInk.Render(m.sessionLabel())
		}
		if profile := c.Cfg.ActiveProfile(); profile != config.DefaultProfile && !c.Client.Generic {
			account += label("   perfil " + profile)
		}
		text := []string{sInk.Render("lixbon") + label("  "+m.opts.Version), "", place, model, label("cuenta   ") + account}
		card := headerLayout(renderLogo(cardLogoSize), text, cardLogoSize, width)

		key := func(k, l string) string { return sInk.Render(k) + sDim.Render(" "+l) }
		tips := "  " + strings.Join([]string{key("/", "comandos"), key("@", "archivos"), key("!", "terminal"), key("ctrl+o", "despliega"), key("alt+v", "pega una imagen")}, "     ")
		out := []string{card, "", "", ansi.Truncate(tips, max(1, width), glyphEllipsis)}
		if len(recent) > 0 {
			out = append(out, "", "", "  "+label("Recientes"))
			for _, r := range recent {
				out = append(out, "  "+twoCol(sSoft.Render(ansi.Truncate(r[0], max(8, width-20), glyphEllipsis)), label(r[1]), max(1, width-4)))
			}
			out = append(out, "  "+sInk.Render("/history")+label(" para verlas todas"))
		}
		return strings.Join(out, "\n")
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

// recentConversations son las últimas n conversaciones de esta carpeta,
// sin la actual: título y hace cuánto.
func (m *Model) recentConversations(n int) [][2]string {
	if m.chat.Store == nil {
		return nil
	}
	now := float64(time.Now().UnixNano()) / 1e9
	var out [][2]string
	for _, item := range m.chat.Store.List(0) {
		if item.ID == m.chat.ConversationID || !m.ownsConversation(item.Workspace) || item.Title == "" {
			continue
		}
		out = append(out, [2]string{item.Title, session.RelativeTime(now, item.UpdatedAt)})
		if len(out) == n {
			break
		}
	}
	return out
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
