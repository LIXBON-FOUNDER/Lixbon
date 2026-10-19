package tui

import (
	"context"
	"errors"
	"fmt"
	"math"
	"slices"
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

// foldTime es lo que tarda la conversación en plegarse en su resumen.
const foldTime = time.Second

// compactState es una compactación en curso: primero el modelo lee la
// conversación (no hay forma de medir ese avance) y luego escribe el resumen.
type compactState struct {
	started  time.Time
	messages int
	tokens   int
	written  int
	// text es lo que lleva escrito el resumen.
	text string
	// from es la primera fila del transcript que entra en el resumen: lo de
	// antes es la tarjeta de bienvenida.
	from int
	// stop lo cierra esc para cancelar; finished: el resumen ya está y la
	// barra se llena antes de plegar.
	stop      chan struct{}
	cancelled bool
	finished  bool
}

type compactProgressMsg struct{ text string }

// compactFoldMsg pliega la conversación cuando la barra ya se vio llena.
type compactFoldMsg struct {
	done           compactBlock
	fromPct, toPct float64
	summary        string
}

// fillPause es lo que se ve la barra llena antes de plegar.
const fillPause = 400 * time.Millisecond

// cancelCompact para la compactación en curso; la conversación queda igual.
func (m *Model) cancelCompact() {
	if c := m.compacting; c != nil && !c.cancelled && !c.finished {
		c.cancelled = true
		close(c.stop)
	}
}

func (m *Model) cmdCompact() tea.Cmd {
	if len(m.chat.History) < 4 {
		m.add(note("La conversación aún es corta; nada que compactar."))
		return nil
	}
	before, beforePct := m.chat.ContextUsage()
	state := &compactState{started: time.Now(), messages: len(m.chat.History), tokens: before, from: m.conversationStart(), stop: make(chan struct{})}
	m.compacting = state
	if h := m.remote; h != nil {
		h.link.Emit("compact", map[string]any{"phase": "start", "messages": state.messages, "before": int(beforePct + 0.5), "estimate": m.compactEstimate()})
	}
	send := m.send
	return m.async("compactando", func(ctx context.Context) cmdDoneMsg {
		ctx, cancel := context.WithCancel(ctx)
		defer cancel()
		go func() {
			select {
			case <-state.stop:
				cancel()
			case <-ctx.Done():
			}
		}()
		err := m.chat.CompactWithProgress(ctx, 2, func(text string) { send(compactProgressMsg{text}) })
		secs := time.Since(state.started).Seconds()
		if err != nil {
			line := errLine("No se pudo generar el resumen: " + err.Error())
			if errors.Is(err, context.Canceled) {
				line = note("Compactación cancelada: la conversación sigue igual.")
			}
			return cmdDoneMsg{lines: []block{line},
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
		return cmdDoneMsg{
			// El resumen ya está: la barra se llena y, tras una pausa, se pliega.
			apply: func(m *Model) { state.finished = true },
			then: func(m *Model) tea.Cmd {
				// finishAsync ya puso el contexto nuevo: hasta el pliegue se
				// queda el de antes, que baja con él.
				m.ctxPct = beforePct
				return tea.Tick(fillPause, func(time.Time) tea.Msg {
					return compactFoldMsg{done: done, fromPct: beforePct, toPct: afterPct, summary: summary}
				})
			},
		}
	})
}

// finishCompact pliega la conversación en su resumen y se lo cuenta a la app.
func (m *Model) finishCompact(msg compactFoldMsg) {
	m.compacting = nil
	m.foldConversation(msg.done, msg.fromPct, msg.toPct)
	if h := m.remote; h != nil {
		h.emit("compacted", map[string]any{"before": int(msg.fromPct + 0.5), "after": int(msg.toPct + 0.5), "summary": textutil.Head(msg.summary, 4000), "secs": int(msg.done.secs + 0.5)})
		h.emitContext(remoteContext(m.chat))
	}
}

// conversationStart es el primer elemento del transcript tras la tarjeta de
// bienvenida y la fila en la que empieza.
func (m *Model) conversationStart() int {
	i := 0
	if m.header != nil {
		i = m.log.index(m.header) + 1
	}
	if i <= 0 || i >= len(m.log.entries) {
		return m.log.total()
	}
	return m.log.start(m.log.entries[i])
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

// readTo es hasta qué fila del transcript ha leído el modelo. Leer no da
// avance, así que la franja se acerca al final sin llegar mientras no empiece
// a escribir; entonces ya lo ha leído todo.
func (c *compactState) readTo(total int) int {
	if c.written > 0 || total <= c.from {
		return total
	}
	p := 1 - math.Exp(-time.Since(c.started).Seconds()/4)
	return c.from + int(p*float64(total-c.from))
}

// compactWindow apaga lo que el modelo ya leyó y pone la franja en la fila
// que lee ahora.
func (m *Model) compactWindow(window []string) {
	c := m.compacting
	if c == nil {
		return
	}
	at := c.readTo(m.log.total())
	for y, line := range window {
		switch row := m.winTop + y; {
		case row < c.from:
		case row < at:
			window[y] = dimRow(line)
		case row == at && c.written == 0:
			window[y] = withBackground(padRight(line, m.width), pal.surf)
		}
	}
}

// dimRow deja una fila en la tinta del riel, sin color ni fondo.
func dimRow(line string) string { return sTrack.Render(ansi.Strip(line)) }

func padRight(line string, width int) string {
	return line + strings.Repeat(" ", max(0, width-ansi.StringWidth(line)))
}

// compactView es el avance encima de la caja: qué fase va, cuánto lleva y,
// mientras escribe, el resumen apareciendo.
func (m *Model) compactView() []string {
	c := m.compacting
	width := max(10, m.width)
	elapsed := sDim.Render(fmt.Sprintf("%.0f s", time.Since(c.started).Seconds()))
	head := " " + sAccent.Render(m.spinFrame()) + " " + m.shimmer("Compactando la conversación")
	const cells = 24
	var bar, step, typed string
	if c.written == 0 {
		bar = sweep(m.spin, cells)
		step = sSoft.Render("1/2  ") + sDim.Render(fmt.Sprintf("lee %d mensajes con %s tokens", c.messages, fmtTokens(c.tokens)))
	} else {
		pct := min(95, float64(c.written)*100/summaryChars)
		if c.finished {
			pct = 100
		}
		filled := int(pct*cells/100 + 0.5)
		bar = sAccent.Render(strings.Repeat(glyphMeterOn, filled)) + sTrack.Render(strings.Repeat(glyphMeterOff, cells-filled))
		step = sSoft.Render("2/2  ") + sDim.Render(fmt.Sprintf("escribe el resumen  %.0f %%", pct))
		text := strings.Join(strings.Fields(c.text), " ")
		room := max(4, width-6)
		if r := []rune(text); len(r) > room {
			text = glyphEllipsis + string(r[len(r)-room+1:])
		}
		typed = pad + sDim.Render(text) + withBackground(" ", pal.muted)
	}
	right := elapsed
	if !c.finished && !c.cancelled {
		right += "      " + keyHint("esc", "cancela")
	}
	return []string{
		twoCol(head, right+" ", width),
		ansi.Truncate(pad+bar+"   "+step, width, glyphEllipsis),
		typed,
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

// foldState es la conversación plegándose en su resumen: lo de arriba se va
// recogiendo y el contexto baja hasta lo que queda.
type foldState struct {
	started        time.Time
	rows           []string
	fromPct, toPct float64
	entry          *entry
}

// progress va de 0 a 1 en foldTime.
func (f *foldState) progress() float64 {
	return min(1, float64(time.Since(f.started))/float64(foldTime))
}

// foldingBlock son las filas de la conversación que aún no se han plegado.
type foldingBlock struct{ f *foldState }

// render deja una fila en blanco entre «Conversación compactada» y lo que
// aún se pliega.
func (b foldingBlock) render(width int, _ bool) string {
	rows := b.f.rows[int(b.f.progress()*float64(len(b.f.rows))):]
	out := []string{""}
	for _, r := range rows {
		out = append(out, ansi.Truncate(r, width, ""))
	}
	return strings.Join(out, "\n")
}

// foldConversation recoge lo hablado en la fila «Conversación compactada»:
// sale del transcript, se apaga y se pliega de arriba abajo mientras el
// contexto baja.
func (m *Model) foldConversation(done compactBlock, fromPct, toPct float64) {
	start := len(m.log.entries)
	if m.header != nil {
		start = m.log.index(m.header) + 2
	}
	old := slices.Clone(m.log.entries[min(start, len(m.log.entries)):])
	var rows []string
	for _, e := range old {
		for _, r := range e.rows {
			rows = append(rows, dimRow(r))
		}
		m.log.remove(e)
		if m.openTool == e {
			m.openTool = nil
		}
	}
	m.scroll = 0
	m.add(done)
	if reducedMotion() || len(rows) == 0 {
		return
	}
	f := &foldState{started: time.Now(), rows: rows, fromPct: fromPct, toPct: toPct}
	f.entry = m.add(foldingBlock{f})
	m.folding = f
	m.ctxPct = fromPct
}

// stepFold avanza el pliegue en cada fotograma; al acabar quita las filas
// que quedaban y deja el contexto real.
func (m *Model) stepFold() {
	f := m.folding
	if f == nil {
		return
	}
	k := f.progress()
	if k >= 1 {
		m.log.remove(f.entry)
		m.folding = nil
		m.refreshContext()
		return
	}
	m.log.refresh(f.entry)
	m.ctxPct = f.fromPct + (f.toPct-f.fromPct)*k
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
	var data []string
	if b.before > 0 {
		data = append(data, fmt.Sprintf("%s %s %s tokens", fmtTokens(b.before), glyphArrow, fmtTokens(b.after)))
	}
	if b.secs > 0 {
		data = append(data, fmt.Sprintf("%.0f s", b.secs))
	}
	out := sSoft.Render("Conversación compactada")
	if len(data) > 0 {
		out += sDim.Render("   " + strings.Join(data, "   "))
	}
	return out
}

func (b compactBlock) render(width int, open bool) string {
	hint := ""
	if b.summary != "" {
		hint = "clic para ver el resumen"
		if open {
			hint = "clic para ocultarlo"
		}
	}
	out := []string{fitRight(mark(glyphDot, sOK)+b.headline(), sDim.Render(hint), width)}
	if open {
		for _, l := range wrapText(b.summary, width-6) {
			out = append(out, pad+sTrack.Render(glyphs.turnRail)+" "+sPrimary.Render(l))
		}
	}
	return strings.Join(out, "\n")
}
