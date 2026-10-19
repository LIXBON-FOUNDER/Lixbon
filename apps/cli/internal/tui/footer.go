package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/chat"
)

// footer es la fila de abajo: el modelo, el esfuerzo en tramos, el modo y
// los procesos en segundo plano a la izquierda (se pulsan y abren su menú);
// los avisos detrás, y el contexto de esta conversación con su barra a la
// derecha. En una terminal estrecha se van soltando detalles en vez de partir
// la fila.
func (m *Model) footer() string {
	width := max(1, m.width)
	const gap = "     "

	model := sSoft.Render(m.modelLabel(m.chat.Model))
	if m.chat.Model == "" {
		model = sDim.Render("sin modelo")
	}
	effort := m.effortMeter()
	mode := m.modeView()
	var procs string
	n := m.liveProcs()
	if n > 0 {
		procs = sDim.Render(fmt.Sprintf("%d %s", n, plural(n, "proceso", "procesos")))
	}
	if n != m.liveSeen {
		m.liveSeen = n
		for _, e := range m.liveTools {
			m.refresh(e)
		}
	}
	var notices []string
	switch {
	case m.compacting != nil:
		// El avance va encima de la caja.
	case m.busy != "":
		notices = append(notices, sAccent.Render(m.spinFrame())+" "+sSoft.Render(m.busy+"…"))
	case m.toastText != "":
		notices = append(notices, m.toastText)
	case m.notice != "":
		notices = append(notices, sSoft.Render(m.notice))
	}
	if n := len(m.queue); n > 0 {
		notices = append(notices, sSoft.Render(fmt.Sprintf("%d en cola", n)))
	}
	if m.updateReady != "" {
		notices = append(notices, sOK.Render(glyphs.check)+" "+sSoft.Render("v"+m.updateReady+" lista")+sDim.Render("  reinicia"))
	}
	if w := m.visionWarning(); w != "" {
		notices = append(notices, sWarn.Render(glyphWarn)+" "+sSoft.Render(w)+sDim.Render("  ")+sInk.Render("/model"))
	}

	type layout struct {
		effort, mode, procs bool
		notices             int
	}
	layouts := []layout{
		{true, true, true, len(notices)},
		{true, true, true, min(1, len(notices))},
		{true, true, true, 0},
		{true, false, true, 0},
		{false, false, true, 0},
		{false, false, false, 0},
	}
	type zones struct{ model, effort, mode, procs span }
	build := func(l layout) (string, zones) {
		var z zones
		left := " "
		add := func(sep, text string, at *span) {
			left += sep
			*at = span{ansi.StringWidth(left), ansi.StringWidth(left) + ansi.StringWidth(text)}
			left += m.lit(text, m.footY, *at)
		}
		add("", model, &z.model)
		if l.effort && effort != "" {
			add("  ", effort, &z.effort)
		}
		if l.mode {
			add(gap, mode, &z.mode)
		}
		if l.procs && procs != "" {
			add(gap, procs, &z.procs)
		}
		for _, n := range notices[:l.notices] {
			left += gap + n
		}
		if l.notices == 1 && len(notices) > 0 {
			left = ansi.Truncate(left, max(1, width-6), glyphEllipsis)
		}
		return left, z
	}

	pct := fmt.Sprintf("%.0f %%", m.ctxPct)
	compact := ""
	if m.ctxPct >= ctxFull {
		compact = "   " + sInk.Render("/compact")
	}
	rights := []string{
		sDim.Render("contexto  ") + meter(m.ctxPct, contextCells) + "  " + pctStyle(m.ctxPct).Render(pct) + compact + " ",
		meter(m.ctxPct, contextCells) + "  " + pctStyle(m.ctxPct).Render(pct) + " ",
		pctStyle(m.ctxPct).Render(pct) + " ",
		"",
	}
	for _, l := range layouts {
		left, z := build(l)
		for _, r := range rights {
			if ansi.StringWidth(left)+ansi.StringWidth(r)+2 <= width || r == "" && ansi.StringWidth(left) <= width {
				m.footModel, m.footEffort, m.footMode, m.footProcs = z.model, z.effort, z.mode, z.procs
				return twoCol(left, r, width)
			}
		}
	}
	m.footModel, m.footEffort, m.footMode, m.footProcs = span{}, span{}, span{}, span{}
	return ansi.Truncate(" "+model, width, "")
}

// effortMeter es el esfuerzo en el pie: solo la palabra, apagada. Los tramos
// van en los selectores; la señal no decora el pie.
func (m *Model) effortMeter() string {
	name := m.effortLabel()
	if name == "" {
		return ""
	}
	if m.chat.Effort == "" && (m.chat.Mode == chat.ModeAgent || m.chat.Session.PlanMode) {
		name = effortNames["high"]
	}
	return sDim.Render(name)
}

// effortSteps es cuántos tramos enciende un nivel y de cuántos: tres en un
// modelo graduado, dos en uno que solo se enciende o apaga.
func effortSteps(level string, graded bool) (on, of int) {
	of = 2
	if graded {
		of = 3
	}
	switch level {
	case "off":
		return 0, of
	case "low":
		return 1, of
	case "medium":
		return 2, of
	case "high", "on":
		return of, of
	}
	return of / 2, of
}

// effortBars son los tramos de un nivel: en la señal en la fila elegida y en
// gris en las demás, sobre la pista.
func effortBars(on, of int, chosen bool) string {
	lit := sSoft
	if chosen {
		lit = sAccent
	}
	var b strings.Builder
	for i := range of {
		seg := glyphMeterOn + glyphMeterOn + " "
		if i < on {
			b.WriteString(lit.Render(seg))
		} else {
			b.WriteString(sTrack.Render(glyphMeterOff + glyphMeterOff + " "))
		}
	}
	return b.String()
}

// visionWarning avisa si hay imágenes en cola y el modelo dice que no las ve.
// Si el servidor no publica capacidades, no se sabe y no se avisa.
func (m *Model) visionWarning() string {
	if len(m.chips) == 0 || !m.modelLacksVision() {
		return ""
	}
	return m.modelLabel(m.chat.Model) + " no ve imágenes"
}

// modelLacksVision: el servidor dice que el modelo no ve imágenes. Si no
// publica capacidades, no se sabe y se supone que sí.
func (m *Model) modelLacksVision() bool {
	for _, mod := range m.opts.Account.Models {
		if mod.ID == m.chat.Model && mod.Capabilities != nil && !mod.HasCapability("vision") {
			return true
		}
	}
	return false
}
