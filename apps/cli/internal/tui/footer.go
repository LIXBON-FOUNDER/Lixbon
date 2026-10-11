package tui

import (
	"fmt"

	"github.com/charmbracelet/x/ansi"
)

// footer es la fila de abajo: el modo y los avisos a la izquierda; el
// contexto a la derecha. Con un selector abierto, la izquierda son sus teclas.
// En una terminal estrecha se van soltando detalles en vez de partir la fila.
func (m *Model) footer() string {
	width := max(1, m.width)
	sep := sDim2.Render(" " + glyphSep + " ")
	mode := " " + sAccent.Render(glyphPrompt) + " " + modeStyle(m.modeName()).Bold(true).Render(m.modeName())

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
	var notices []string
	if m.busy != "" {
		notices = append(notices, sAccent.Render(m.spinFrame())+" "+sSoft.Render(m.busy+"…"))
	} else if m.notice != "" {
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

	full := mode
	if m.picker != nil {
		full = " " + hint
	} else {
		full += "  " + hint
	}
	for _, n := range notices {
		full += sep + n
	}
	lefts := []string{full}
	if len(notices) > 0 {
		lefts = append(lefts, mode+sep+notices[0])
	}
	lefts = append(lefts, mode)

	pct := fmt.Sprintf(" %.0f%%", m.ctxPct)
	pctStyle := sSoft
	switch {
	case m.ctxPct >= ctxFull:
		pctStyle = sErr
	case m.ctxPct >= ctxWarn:
		pctStyle = sWarn
	}
	bar := meter(m.ctxPct, contextCells) + pctStyle.Render(pct)
	tokens := sDim.Render(fmtTokens(max(m.sessionTokens, m.ctxTokens)) + " tok")
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
	for _, l := range lefts {
		for _, r := range rights {
			if ansi.StringWidth(l)+ansi.StringWidth(r)+2 <= width || r == "" && ansi.StringWidth(l) <= width {
				m.footMode = span{1, ansi.StringWidth(mode)}
				return twoCol(l, r, width)
			}
		}
	}
	m.footMode = span{}
	return ansi.Truncate(lefts[len(lefts)-1], width, "")
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
