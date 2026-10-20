package tui

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/agent"
)

// Un turno con acciones se pinta como una pieza: «◆ Lixbon» con sus totales
// y, debajo, cada paso del agente colgando del riel ┃ hasta ┗. La respuesta
// final queda fuera del riel, en tinta plena; lo que el agente cuenta entre
// acciones va dentro, en gris.

// withRail pone el riel delante de cada fila de un paso. Las filas de los
// bloques empiezan con un espacio (la columna del marcador), así que el
// marcador queda en la columna 3 y el contenido en la 5. El último paso
// cierra el riel con ┗ en una fila propia, y la respuesta va debajo.
func withRail(text string, end bool) string {
	rail := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.rail))
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = " " + rail.Render(glyphs.turnRail) + l
	}
	if end {
		lines = append(lines, " "+rail.Render(glyphs.turnEnd))
	}
	return strings.Join(lines, "\n")
}

// turnHeadBlock abre el turno del agente: quién trabaja y cuánto lleva. El ◆
// va siempre en la señal; mientras el turno sigue, «Lixbon» también.
type turnHeadBlock struct {
	actions, adds, dels, fails int
	secs                       float64
	live                       bool
}

func (b *turnHeadBlock) render(width int, _ bool) string {
	name := sInk
	if b.live {
		name = sAccent
	}
	left := mark(glyphBrand, sAccent) + name.Render("Lixbon")
	var parts []string
	if b.actions > 0 {
		parts = append(parts, sDim.Render(noun(b.actions, "acción", "acciones")))
	}
	if b.fails > 0 {
		parts = append(parts, sErr.Render(noun(b.fails, "fallo", "fallos")))
	}
	if b.adds != 0 || b.dels != 0 {
		parts = append(parts, counts(b.adds, b.dels))
	}
	if b.secs >= 0.1 {
		parts = append(parts, sDim.Render(duration(b.secs)))
	}
	return fitRight(left, strings.Join(parts, "   "), width)
}

// duration es «12 s», «1 min 12 s» o «1 h 5 min».
func duration(secs float64) string {
	s := int(secs + 0.5)
	switch {
	case secs < 10:
		return fmt.Sprintf("%.1f s", secs)
	case s < 60:
		return fmt.Sprintf("%d s", s)
	case s < 3600:
		return fmt.Sprintf("%d min %d s", s/60, s%60)
	}
	return fmt.Sprintf("%d h %d min", s/3600, s%3600/60)
}

// narrationBlock es lo que el modelo dijo entre acciones: no es la respuesta,
// así que va sin marcador, pero en tinta clara: es lo que se lee del turno.
type narrationBlock struct {
	text string
	md   func(text string, width int) string
}

func (narrationBlock) lazy() bool { return true }

func (b narrationBlock) render(width int, _ bool) string {
	lines := wrapText(strings.TrimSpace(b.text), max(10, width-4))
	code := false
	for i, l := range lines {
		lines[i] = " " + inlineCode(strings.TrimRight(l, " "), &code)
	}
	return strings.Join(lines, "\n")
}

// inlineCode pinta un texto en el cuerpo y lo que va entre comillas
// invertidas en tinta sobre la hoja; code dice si la fila empieza dentro de
// un trozo de código (uno partido entre dos filas).
func inlineCode(line string, code *bool) string {
	line = strings.ReplaceAll(line, "**", "")
	codeStyle := sInk.Background(lipgloss.Color(pal.surf))
	var b strings.Builder
	for i, part := range strings.Split(line, "`") {
		if i > 0 {
			*code = !*code
		}
		if part == "" {
			continue
		}
		if *code {
			b.WriteString(codeStyle.Render(part))
		} else {
			b.WriteString(sPrimary.Render(part))
		}
	}
	return b.String()
}

// systemBlock es un aviso del sistema dentro de un turno (contexto recortado,
// compactado…): una raya a todo el ancho, fuera del riel, para que no parezca
// el resultado de una acción.
type systemBlock string

func (b systemBlock) render(width int, _ bool) string {
	rule := glyphs.rule + glyphs.rule + " "
	lines := wrapText(string(b), max(10, width-ansi.StringWidth(rule)-5))
	for i, l := range lines {
		lead := strings.Repeat(" ", ansi.StringWidth(rule))
		if i == 0 {
			lead = rule
		}
		lines[i] = sDim2.Render(lead) + sDim.Render(l)
	}
	last := lines[len(lines)-1]
	if fill := width - 2 - ansi.StringWidth(last); fill >= 3 {
		lines[len(lines)-1] = last + " " + sDim2.Render(strings.Repeat(glyphs.rule, fill))
	}
	return strings.Join(lines, "\n")
}

// ── etiquetas ────────────────────────────────────────────────────────────

// chipTone colorea la etiqueta según el tipo de herramienta.
type chipTone int

const (
	toneOther chipTone = iota
	toneRead
	toneChange
	toneCommand
	toneBrowser
)

func (t chipTone) color() string {
	switch t {
	case toneRead:
		return pal.info
	case toneChange:
		return pal.sand
	case toneCommand:
		return pal.acc
	case toneBrowser:
		return pal.ivory
	}
	return pal.soft
}

// chip es el verbo de la herramienta en gris y sin fondo, a lo ancho de
// siete columnas: con el espacio que sigue, los objetivos quedan en fila.
func chip(label string, _ chipTone, _ bool) string {
	return sSoft.Render(label + strings.Repeat(" ", max(0, 7-ansi.StringWidth(label))))
}

var readTools = map[string]bool{
	"read_file": true, "search": true, "list_files": true, "find_files": true, "outline": true,
	"read_output": true, "web_search": true, "fetch_url": true, "mcp_tools": true,
}

func toneFor(e agent.Event) chipTone {
	switch {
	case e.Tool == "run_command" || e.Change != nil && e.Change.Kind == "command":
		return toneCommand
	case e.Change != nil:
		return toneChange
	case readTools[e.Tool]:
		return toneRead
	}
	if _, ok := toolVerbs[e.Tool]; ok && !e.ReadOnly && e.Tool != "todo" && e.Tool != "ask_user" && e.Tool != "stop_command" {
		return toneChange
	}
	return toneOther
}

// thoughtMeta es «✦ 1.2 s»: lo que el modelo pensó antes del paso, que ya no
// ocupa una fila propia. Sin duración medible queda solo el ✦.
func thoughtMeta(thoughts ...thinkBlock) string {
	secs, any := 0.0, false
	for _, t := range thoughts {
		secs += t.secs
		any = any || hasThought(t)
	}
	switch {
	case !any:
		return ""
	case secs < 0.1:
		return sDim2.Render(glyphSpark)
	}
	return sDim2.Render(fmt.Sprintf("%s %.1f s", glyphSpark, secs))
}

// joinMeta junta los datos de la derecha de una fila.
func joinMeta(parts ...string) string {
	var kept []string
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "   ")
}

// ── el riel del turno ────────────────────────────────────────────────────

// openRail cuelga del riel los pasos del turno. La primera vez inserta la
// cabecera delante de lo que el turno ya pintó (lo pensado, lo narrado); si
// el riel se había cerrado ante una respuesta que resultó ser narración, lo
// reabre desde el último paso.
func (m *Model) openRail() {
	if m.railing || m.capturing != nil {
		return
	}
	var from int
	if m.turnHead == nil {
		m.openTurnHead()
		from = m.log.index(m.turnHead) + 1
	} else {
		from = m.log.index(m.turnHead) + 1
		if m.railTail != nil {
			if i := m.log.index(m.railTail); i >= 0 {
				from = i
			}
		}
	}
	for _, e := range m.log.entries[max(0, from):] {
		if a, ok := e.b.(answerBlock); ok {
			e.b = narrationBlock{text: a.text, md: a.md}
			if m.answerEntry == e {
				m.answerEntry = nil
			}
		}
		m.setRail(e, railMid)
	}
	m.railing = true
}

// openTurnHead pone «◆ Lixbon» delante de lo que el turno ya pintó: todo
// turno lo lleva, también el que solo responde texto.
func (m *Model) openTurnHead() {
	if m.turnHead != nil || m.capturing != nil {
		return
	}
	at := min(m.turnStart, len(m.log.entries))
	m.turnHead = m.insertAt(at, &turnHeadBlock{live: m.running})
}

// closeRail cierra el riel en su último paso; las filas en blanco del final
// se quedan fuera.
func (m *Model) closeRail() {
	if !m.railing {
		return
	}
	m.railing = false
	stop := m.log.index(m.turnHead)
	for i := len(m.log.entries) - 1; i > stop; i-- {
		e := m.log.entries[i]
		if e.rail == railNone {
			continue
		}
		if tb, ok := e.b.(textBlock); ok && tb == "" {
			m.setRail(e, railNone)
			continue
		}
		m.setRail(e, railEnd)
		m.railTail = e
		return
	}
}

func (m *Model) setRail(e *entry, r railMark) {
	if e.rail != r {
		e.rail = r
		m.refresh(e)
	}
}

// countStep suma la acción a los totales de la cabecera mientras el turno
// sigue; al terminar, finishTurn pone los definitivos.
func (m *Model) countStep(e agent.Event) {
	h, ok := m.turnHeadBlock()
	if !ok {
		return
	}
	switch e.Kind {
	case agent.EventAction:
		h.actions++
		h.adds += e.Adds
		h.dels += e.Dels
	case agent.EventReadGroup:
		h.actions += len(e.Names)
	default:
		return
	}
	m.refresh(m.turnHead)
}

func (m *Model) turnHeadBlock() (*turnHeadBlock, bool) {
	if m.turnHead == nil {
		return nil, false
	}
	h, ok := m.turnHead.b.(*turnHeadBlock)
	return h, ok
}
