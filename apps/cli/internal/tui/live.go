package tui

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/chat"
)

const (
	liveThinkRows = 3
	ctxWarn       = 60.0
	ctxFull       = 85.0
)

// reducedMotion apaga el destello animado y el brillo de la etiqueta.
func reducedMotion() bool { return os.Getenv("LIXBON_REDUCED_MOTION") == "1" }

// liveLabel dice qué está haciendo el turno ahora mismo.
func (m *Model) liveLabel() (string, bool) {
	if m.interrupted {
		return "interrumpiendo…", true
	}
	if m.picker != nil && m.openTool != nil {
		return "Esperando tu respuesta…", false
	}
	if b := askBlock(m.askEntry); b != nil && b.state == toolWaiting {
		return "Esperando tus respuestas…", false
	}
	if m.autoCompacting {
		return "Compactando la conversación…", false
	}
	if b := m.currentTool(); b != nil {
		if b.state == toolRunning {
			target := ansi.Truncate(b.target, 32, glyphEllipsis)
			return strings.TrimSpace(b.gerund+" "+target) + "…", false
		}
	}
	if c, ok := m.writingCall(); ok {
		return callLabel(c), false
	}
	if m.live.content.Len() > 0 {
		if m.turnMode == chat.ModeAgent && m.live.prose == "" {
			return "Preparando acciones…", false
		}
		return "Escribiendo la respuesta…", false
	}
	if m.live.reasoning.Len() > 0 {
		return "Pensando…", false
	}
	return brilloVerbs[m.spin/brilloVerbTicks%len(brilloVerbs)] + "…", false
}

// parseCall lee el avance «nombre\tdestino\tcaracteres» que manda el chat.
func parseCall(text string) (callProgress, bool) {
	parts := strings.SplitN(text, "\t", 3)
	if len(parts) != 3 {
		return callProgress{}, false
	}
	n, _ := strconv.Atoi(parts[2])
	return callProgress{tool: parts[0], target: parts[1], chars: n}, true
}

// trackCall apunta el avance de la llamada que llega por tool_calls nativas:
// «nombre\tdestino\tcaracteres». Lo escrito cuenta para los tokens de abajo.
func (m *Model) trackCall(text string) {
	c, ok := parseCall(text)
	if !ok {
		return
	}
	m.liveChars += max(0, c.chars-m.live.calling.chars)
	m.live.calling = c
}

// textCallStart encuentra una llamada escrita en el texto (modelos sin tools
// nativas): {"tool":"write_file","args":{….
var textCallStart = regexp.MustCompile(`\{\s*"tool"\s*:\s*"([A-Za-z0-9_]+)"`)

// writingCall es la llamada que el modelo está escribiendo, nativa o en el
// texto. Sin ella, una acción larga deja la etiqueta quieta minutos.
func (m *Model) writingCall() (callProgress, bool) {
	if c := m.live.calling; c.tool != "" {
		return c, true
	}
	if m.turnMode != chat.ModeAgent || m.live.content.Len() == 0 {
		return callProgress{}, false
	}
	return textCall(m.live.content.String())
}

// textCall es la llamada a medio escribir al final del texto del modelo.
func textCall(raw string) (callProgress, bool) {
	locs := textCallStart.FindAllStringSubmatchIndex(raw, -1)
	if len(locs) == 0 {
		return callProgress{}, false
	}
	last := locs[len(locs)-1]
	call := raw[last[0]:]
	if json.Valid([]byte(call)) {
		return callProgress{}, false
	}
	return callProgress{tool: raw[last[2]:last[3]], target: chat.CallTarget(call), chars: len(call)}, true
}

// callLabel es «Escribiendo index.html · 12.4 kB…»: qué prepara y cuánto
// lleva, que crece mientras el modelo escribe.
func callLabel(c callProgress) string {
	label := verbs(c.tool)[1]
	if c.target != "" {
		target := c.target
		if strings.ContainsAny(target, `/\`) && !strings.Contains(target, " ") {
			target = filepath.Base(target)
		}
		label += " " + ansi.Truncate(target, 40, glyphEllipsis)
	}
	if c.chars >= 200 {
		label += fmt.Sprintf(" %s %.1f kB", glyphSep, float64(c.chars)/1000)
	}
	return label + "…"
}

// brilloVerbs nombran la espera sin nada más concreto que decir; cambian cada
// brilloVerbTicks fotogramas (unos 3 s).
var brilloVerbs = []string{"Tallando", "Puliendo", "Refractando", "Facetando", "Engarzando", "Destellando"}

const brilloVerbTicks = 25

// shimmer recorre la etiqueta con un brillo de arena a destello, como la luz
// sobre una cara del prisma.
func (m *Model) shimmer(text string) string {
	fg := func(hex string) lipgloss.Style { return lipgloss.NewStyle().Foreground(lipgloss.Color(hex)) }
	base := fg(pal.shBase)
	if reducedMotion() {
		return base.Render(text)
	}
	mid, high := fg(pal.shMid), fg(pal.shHigh)
	chars := []rune(text)
	p := m.spin%(len(chars)+6) - 3
	var b strings.Builder
	for i, c := range chars {
		switch d := abs(i - p); {
		case d < 1:
			b.WriteString(high.Render(string(c)))
		case d < 2:
			b.WriteString(mid.Render(string(c)))
		default:
			b.WriteString(base.Render(string(c)))
		}
	}
	return b.String()
}

// spinFrame es el destello que crece de punto a estrella y vuelve.
func (m *Model) spinFrame() string {
	if reducedMotion() {
		return glyphSpark
	}
	return glyphs.spin[m.spin%len(glyphs.spin)]
}

// liveTokens son los tokens recibidos en el turno: los reales de cada paso ya
// terminado (incluido el pensamiento) más una estimación del paso en curso,
// del que el servidor solo da el conteo al final.
func (m *Model) liveTokens() int {
	if m.charsPerToken <= 0 {
		return m.liveReal
	}
	return m.liveReal + int(float64(m.liveChars)/m.charsPerToken)
}

// liveView es la zona viva: la respuesta que se va escribiendo, el destello
// con lo que está haciendo y, debajo, el pensamiento y el paso del plan.
func (m *Model) liveView() []string {
	width := m.width
	var lines []string
	label, warn := m.liveLabel()
	head := " " + sBeige.Render(m.spinFrame()) + " "
	if warn {
		head += sWarn.Render(label)
	} else {
		head += m.shimmer(label)
	}
	elapsed := fmt.Sprintf("%.0f s", time.Since(m.started).Seconds())
	sep := sDim2.Render(" " + glyphSep + " ")
	esc := sSoft.Bold(true).Render("esc") + sDim.Render(" interrumpe")
	rights := []string{sDim.Render(elapsed) + sep + esc + " ", sDim.Render(elapsed) + " ", ""}
	if tok := m.liveTokens(); tok > 0 {
		rights = append([]string{sDim.Render(elapsed) + sep + sDim.Render("↓ "+fmtTokens(tok)+" tok") + sep + esc + " "}, rights...)
	}
	row := ansi.Truncate(head, max(1, width), "")
	for _, r := range rights {
		if ansi.StringWidth(head)+ansi.StringWidth(r)+2 <= width {
			row = twoCol(head, r, width)
			break
		}
	}
	lines = append(lines, row)

	if m.live.reasoning.Len() > 0 && m.live.content.Len() == 0 {
		// Solo el final: envolver todo lo pensado en cada fotograma hacía que
		// la pantalla fuera más lenta cuanto más razonaba el modelo.
		thought := m.live.reasoning.String()
		if keep := liveThinkRows * width * 2; len(thought) > keep {
			thought = strings.ToValidUTF8(thought[len(thought)-keep:], "")
		}
		tail := wrapText(strings.TrimSpace(thought), max(10, width-6))
		for _, l := range tail[max(0, len(tail)-liveThinkRows):] {
			lines = append(lines, pad+sDim2.Render(glyphThinkRail)+" "+sDim.Italic(true).Render(l))
		}
	}
	if step, n, k := m.currentStep(); step != "" {
		lines = append(lines, ansi.Truncate(pad+sAccent.Render(glyphDoing)+" "+sSoft.Bold(true).Render(fmt.Sprintf("%d/%d", k, n))+" "+sDim.Render(step), max(1, width), glyphEllipsis))
	}
	return lines
}

// currentStep es el paso del plan en curso y cuántos van.
func (m *Model) currentStep() (text string, total, current int) {
	// Un plan de un turno anterior no es lo que se hace ahora.
	if m.todoTurn != m.turn {
		return "", 0, 0
	}
	for i, it := range m.todo {
		if it.Status == "doing" {
			return it.Text, len(m.todo), i + 1
		}
	}
	return "", 0, 0
}

func (m *Model) queueLine() string {
	first := strings.Join(strings.Fields(strings.TrimPrefix(m.queue[0], fromRemote)), " ")
	text := pad + sDim2.Render(glyphInfo) + " " + sSoft.Render(fmt.Sprintf("%d en cola", len(m.queue))) +
		sDim.Render(" "+glyphSep+" «"+first+"»")
	return ansi.Truncate(text, max(1, m.width-1), glyphEllipsis+sDim.Render("»"))
}
