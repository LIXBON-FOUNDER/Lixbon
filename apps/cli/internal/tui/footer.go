package tui

import (
	"fmt"

	"github.com/charmbracelet/x/ansi"
)

// footer es la fila de abajo: el modo, el razonamiento, los comandos en
// segundo plano y los avisos a la izquierda; el contexto de esta conversación
// a la derecha. Con un selector abierto, la izquierda son sus teclas. En una
// terminal estrecha se van soltando detalles en vez de partir la fila.
func (m *Model) footer() string {
	width := max(1, m.width)
	sep := sDim2.Render(" " + glyphSep + " ")
	mode := " " + m.lit(sAccent.Render(glyphPrompt)+" "+modeStyle(m.modeName()).Bold(true).Render(m.modeName()), m.height-1, m.footMode)

	var hint string
	switch {
	case m.picker != nil:
		hint = m.picker.hints()
	case m.running:
		hint = sDim2.Render("esc interrumpe")
	case m.prompt != nil:
		hint = sDim2.Render("↵ responder " + glyphSep + " esc cancela")
	default:
		hint = sDim2.Render("shift+tab")
	}
	var effort, procs string
	if m.picker == nil {
		if l := m.effortLabel(); l != "" {
			effort = sDim.Render("razonamiento ") + sSoft.Render(l)
		}
		if n := m.liveProcs(); n > 0 {
			procs = sAccent.Render(fmt.Sprintf("[%d]", n)) + " " + sSoft.Render(plural(n, "comando", "comandos"))
		}
	}
	var notices []string
	switch {
	case m.busy != "":
		notices = append(notices, sAccent.Render(m.spinFrame())+" "+sSoft.Render(m.busy+"…"))
	case m.toastText != "":
		notices = append(notices, m.toastText)
	case m.notice != "":
		notices = append(notices, sAccent.Render(m.notice))
	}
	if n := len(m.queue); n > 0 {
		notices = append(notices, sSoft.Render(fmt.Sprintf("%d en cola", n)))
	}
	if w := m.visionWarning(); w != "" {
		notices = append(notices, sWarn.Bold(true).Render("!")+" "+sWarn.Render(w)+sDim.Render(" "+glyphSep+" ")+sSoft.Render("/model"))
	}
	if m.alwaysAllowed {
		notices = append(notices, sWarn.Render("sin preguntar"))
	}

	type layout struct {
		hint          bool
		effort, procs bool
		notices       int
	}
	layouts := []layout{
		{true, true, true, len(notices)},
		{false, true, true, len(notices)},
		{false, true, true, min(1, len(notices))},
		{false, false, true, min(1, len(notices))},
		{false, false, true, 0},
		{false, false, false, 0},
	}
	build := func(l layout) (string, span, span) {
		left := mode
		if m.picker != nil {
			left = " " + hint
		} else if l.hint {
			left += "  " + hint
		}
		var effortAt, procsAt span
		if l.effort && effort != "" {
			left += sep
			effortAt = span{ansi.StringWidth(left), ansi.StringWidth(left) + ansi.StringWidth(effort)}
			left += m.lit(effort, m.height-1, m.footEffort)
		}
		if l.procs && procs != "" {
			left += sep
			procsAt = span{ansi.StringWidth(left), ansi.StringWidth(left) + ansi.StringWidth(procs)}
			left += m.lit(procs, m.height-1, m.footProcs)
		}
		for _, n := range notices[:l.notices] {
			left += sep + n
		}
		if l.notices == 1 && len(notices) > 0 {
			left = ansi.Truncate(left, max(1, width-6), glyphEllipsis)
		}
		return left, effortAt, procsAt
	}

	pct := fmt.Sprintf(" %.0f%%", m.ctxPct)
	pctStyle := sSoft
	switch {
	case m.ctxPct >= ctxFull:
		pctStyle = sErr
	case m.ctxPct >= ctxWarn:
		pctStyle = sWarn
	}
	bar := meter(m.ctxPct, contextCells) + pctStyle.Render(pct)
	tokens := sDim.Render(fmtTokens(m.ctxTokens) + " tok")
	compact := ""
	if m.ctxPct >= ctxFull {
		compact = sep + sWarn.Render("/compact")
	}
	rights := []string{
		sDim.Render("ctx ") + bar + sep + tokens + compact + "  ",
		sDim.Render("ctx ") + bar + compact + "  ",
		bar + " ",
		pctStyle.Render(fmt.Sprintf("%.0f%%", m.ctxPct)) + " ",
		"",
	}
	for _, l := range layouts {
		left, effortAt, procsAt := build(l)
		for _, r := range rights {
			if ansi.StringWidth(left)+ansi.StringWidth(r)+2 <= width || r == "" && ansi.StringWidth(left) <= width {
				m.footMode = span{1, ansi.StringWidth(mode)}
				m.footEffort, m.footProcs = effortAt, procsAt
				return twoCol(left, r, width)
			}
		}
	}
	m.footMode, m.footEffort, m.footProcs = span{}, span{}, span{}
	return ansi.Truncate(mode, width, "")
}

// visionWarning avisa si hay imágenes en cola y el modelo dice que no las ve.
// Si el servidor no publica capacidades, no se sabe y no se avisa.
func (m *Model) visionWarning() string {
	if len(m.chips) == 0 {
		return ""
	}
	for _, mod := range m.opts.Account.Models {
		if mod.ID == m.chat.Model && mod.Capabilities != nil && !mod.HasCapability("vision") {
			return m.modelLabel(mod.ID) + " no ve imágenes"
		}
	}
	return ""
}
