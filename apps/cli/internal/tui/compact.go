package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/textutil"
)

// summaryChars es lo que suele ocupar un resumen (el prompt pide ≤ 500
// palabras): sirve para estimar el avance mientras se escribe.
const summaryChars = 2800

// compactState es una compactación en curso: primero el modelo lee la
// conversación (no hay forma de medir ese avance) y luego escribe el resumen.
type compactState struct {
	started  time.Time
	messages int
	tokens   int
	written  int
}

type compactProgressMsg struct{ written int }

func (m *Model) cmdCompact() tea.Cmd {
	if len(m.chat.History) < 4 {
		m.add(note("La conversación aún es corta; nada que compactar."))
		return nil
	}
	before, beforePct := m.chat.ContextUsage()
	state := &compactState{started: time.Now(), messages: len(m.chat.History), tokens: before}
	m.compacting = state
	if h := m.remote; h != nil {
		h.link.Emit("compact", map[string]any{"phase": "start", "messages": state.messages, "before": int(beforePct + 0.5), "estimate": m.compactEstimate()})
	}
	send := m.send
	return m.async("compactando", func(ctx context.Context) cmdDoneMsg {
		err := m.chat.CompactWithProgress(ctx, 2, func(n int) { send(compactProgressMsg{n}) })
		secs := time.Since(state.started).Seconds()
		if err != nil {
			return cmdDoneMsg{lines: []block{errLine("No se pudo generar el resumen: " + err.Error())},
				apply: func(m *Model) {
					m.compacting = nil
					if m.remote != nil {
						m.remote.link.Emit("compact", map[string]any{"phase": "failed", "message": err.Error()})
					}
				}}
		}
		after, afterPct := m.chat.ContextUsage()
		summary := ""
		if len(m.chat.History) > 0 && history.IsSummary(m.chat.History[0]) {
			summary = history.SummaryText(m.chat.History[0])
		}
		done := compactBlock{summary: summary, before: before, after: after, secs: secs}
		return cmdDoneMsg{lines: []block{done}, apply: func(m *Model) {
			m.compacting = nil
			if h := m.remote; h != nil {
				h.emit("compacted", map[string]any{"before": int(beforePct + 0.5), "after": int(afterPct + 0.5), "summary": textutil.Head(summary, 4000), "secs": int(secs + 0.5)})
				h.emitContext(remoteContext(m.chat))
			}
		}}
	})
}

// compactPct es el avance que ve la app: leer la conversación es la primera
// mitad (sin medida) y escribir el resumen, la segunda.
func compactPct(written int) int {
	if written == 0 {
		return 10
	}
	return 40 + int(min(55, float64(written)*55/summaryChars))
}

// compactEstimate es el contexto que quedará: un resumen típico más los
// mensajes recientes que se conservan.
func (m *Model) compactEstimate() int {
	hist := m.chat.History
	keep := hist[max(0, len(hist)-2):]
	est := m.chat.Session.Estimator
	tokens := int(summaryChars/est.CharsPerToken()) + est.EstimateTokens(keep)
	return min(100, int(float64(tokens)*100/float64(max(m.chat.Cfg.ContextWindow, 1))+0.5))
}

// compactView es el avance encima de la caja: qué fase va y cuánto lleva.
func (m *Model) compactView() []string {
	c := m.compacting
	width := max(10, m.width)
	elapsed := sDim.Render(fmt.Sprintf("%.0f s", time.Since(c.started).Seconds()))
	head := " " + sAccent.Render(m.spinFrame()) + " " + m.shimmer("Compactando la conversación")
	const cells = 24
	var bar, step string
	if c.written == 0 {
		bar = sweep(m.spin, cells)
		step = sSoft.Render("1/2 ") + sDim.Render(fmt.Sprintf("el modelo lee %d mensajes (%s tokens)", c.messages, fmtTokens(c.tokens)))
	} else {
		pct := min(95, float64(c.written)*100/summaryChars)
		filled := int(pct*cells/100 + 0.5)
		bar = sAccent.Render(strings.Repeat(glyphMeterOn, filled)) + sTrack.Render(strings.Repeat(glyphMeterOff, cells-filled))
		step = sSoft.Render("2/2 ") + sDim.Render(fmt.Sprintf("escribe el resumen %.0f%%", pct))
	}
	return []string{
		twoCol(head, elapsed+" ", width),
		ansi.Truncate(pad+bar+"  "+step, width, glyphEllipsis),
	}
}

// sweep es una barra indeterminada: un tramo que recorre la barra.
func sweep(frame, cells int) string {
	const span = 5
	pos := frame % (cells + span)
	var b strings.Builder
	for i := range cells {
		if i >= pos-span && i < pos {
			b.WriteString(sAccent.Render(glyphMeterOn))
		} else {
			b.WriteString(sTrack.Render(glyphMeterOff))
		}
	}
	return b.String()
}

// compactBlock deja constancia de la compactación y guarda el resumen
// plegado: es lo que el modelo recuerda a partir de ahora.
type compactBlock struct {
	summary       string
	before, after int
	secs          float64
}

func (b compactBlock) folds() bool { return b.summary != "" }

func (b compactBlock) headline() string {
	text := "Conversación compactada"
	if b.before > 0 {
		text += fmt.Sprintf(" %s %s %s %s tokens", glyphSep, fmtTokens(b.before), glyphArrow, fmtTokens(b.after))
	}
	if b.secs > 0 {
		text += fmt.Sprintf(" %s %.0f s", glyphSep, b.secs)
	}
	return text
}

func (b compactBlock) render(width int, open bool) string {
	hint := ""
	if b.summary != "" {
		hint = "clic para ver el resumen"
		if open {
			hint = "clic para ocultarlo"
		}
	}
	out := []string{fitRight(mark(glyphDot, sOK)+sSoft.Render(b.headline()), sDim2.Render(hint), width)}
	if open {
		for _, l := range wrapText(b.summary, width-6) {
			out = append(out, pad+sDim2.Render(glyphThinkRail)+" "+sDim.Render(l))
		}
	}
	return strings.Join(out, "\n")
}
