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
// marcador queda en la columna 3 y el contenido en la 5.
func withRail(text string, end bool) string {
	rail := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.f3))
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		g := glyphs.turnRail
		if end && i == len(lines)-1 {
			g = glyphs.turnEnd
		}
		lines[i] = " " + rail.Render(g) + l
	}
	return strings.Join(lines, "\n")
}

// turnHeadBlock abre el turno del agente: quién trabaja y cuánto lleva.
type turnHeadBlock struct {
	actions, adds, dels int
	secs                float64
}

func (b *turnHeadBlock) render(width int, _ bool) string {
	left := mark(glyphBrand, sBeige) + sBold.Render("Lixbon")
	var parts []string
	if b.actions > 0 {
		parts = append(parts, sDim.Render(noun(b.actions, "acción", "acciones")))
	}
	if b.adds != 0 || b.dels != 0 {
		parts = append(parts, counts(b.adds, b.dels))
	}
	switch {
	case b.secs >= 10:
		parts = append(parts, sDim.Render(fmt.Sprintf("%.0f s", b.secs)))
	case b.secs >= 0.1:
		parts = append(parts, sDim.Render(fmt.Sprintf("%.1f s", b.secs)))
	}
	return fitRight(left, strings.Join(parts, sDim2.Render(" "+glyphSep+" ")), width)
}

// narrationBlock es lo que el modelo dijo entre acciones: no es la respuesta,
// así que va sin marcador, pero en tinta clara: es lo que se lee del turno.
type narrationBlock struct {
	text string
	md   func(text string, width int) string
}

func (narrationBlock) lazy() bool { return true }

func (b narrationBlock) render(width int, _ bool) string {
	lines := wrapText(b.text, max(10, width-4))
	if b.md != nil {
		lines = strings.Split(ansi.Strip(renderRich(b.text, max(20, width-4), b.md)), "\n")
	}
	for len(lines) > 0 && strings.TrimSpace(lines[0]) == "" {
		lines = lines[1:]
	}
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	for i, l := range lines {
		lines[i] = pad + sPrimary.Render(strings.TrimRight(l, " "))
	}
	return strings.Join(lines, "\n")
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

// chip es el nombre de la herramienta como pieza: texto sobre fondo, con un
// fondo de oliva mientras está en marcha.
func chip(label string, tone chipTone, live bool) string {
	bg := pal.surf2
	if live {
		bg = pal.chipLive
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color(tone.color())).Background(lipgloss.Color(bg)).Render(" " + label + " ")
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
	return strings.Join(kept, sDim2.Render("  "+glyphSep+"  "))
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
		at := min(m.turnStart, len(m.log.entries))
		m.turnHead = m.insertAt(at, &turnHeadBlock{})
		from = at + 1
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
