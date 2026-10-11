package tui

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/toolparse"
)

const (
	liveTailRows  = 8
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
	if m.openTool != nil {
		b := m.openTool.b.(*toolBlock)
		if b.state == toolRunning {
			target := ansi.Truncate(b.target, 32, glyphEllipsis)
			return strings.TrimSpace(b.gerund+" "+target) + "…", false
		}
	}
	if m.live.content.Len() > 0 {
		if m.chat.Mode == chat.ModeAgent && toolparse.CleanProse(m.live.content.String()) == "" {
			return "Preparando acciones…", false
		}
		return "Escribiendo…", false
	}
	if m.live.reasoning.Len() > 0 {
		return "Pensando…", false
	}
	return "Trabajando…", false
}

// shimmer recorre la etiqueta con un brillo en acento.
func (m *Model) shimmer(text string) string {
	if reducedMotion() {
		return sSoft.Render(text)
	}
	chars := []rune(text)
	p := m.spin%(len(chars)+8) - 4
	var b strings.Builder
	for i, c := range chars {
		d := abs(i - p)
		switch {
		case d <= 1:
			b.WriteString(sAccent.Render(string(c)))
		case d <= 3:
			b.WriteString(sInk.Render(string(c)))
		default:
			b.WriteString(sSoft.Render(string(c)))
		}
	}
	return b.String()
}

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
	if m.live.content.Len() > 0 {
		text := m.live.content.String()
		if m.chat.Mode == chat.ModeAgent {
			text = toolparse.CleanProse(text)
		}
		if text = strings.TrimSpace(text); text != "" {
			wrapped := wrapText(text, max(10, width-4))
			tail := wrapped[max(0, len(wrapped)-liveTailRows):]
			for i, l := range tail {
				prefix := pad
				if i == 0 && len(wrapped) <= liveTailRows {
					prefix = mark(glyphBrand, sAccent)
				}
				row := prefix + sPrimary.Render(l)
				if i == len(tail)-1 && m.spin%6 < 3 {
					row += sAccent.Render(glyphEdge)
				}
				lines = append(lines, row)
			}
		}
	}

	label, warn := m.liveLabel()
	head := " " + sAccent.Render(m.spinFrame()) + " "
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
		tail := wrapText(strings.TrimSpace(m.live.reasoning.String()), max(10, width-6))
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
	for i, it := range m.todo {
		if it.Status == "doing" {
			return it.Text, len(m.todo), i + 1
		}
	}
	return "", 0, 0
}

func (m *Model) queueLine() string {
	first := strings.Join(strings.Fields(m.queue[0]), " ")
	text := pad + sDim2.Render(glyphInfo) + " " + sSoft.Render(fmt.Sprintf("%d en cola", len(m.queue))) +
		sDim.Render(" "+glyphSep+" «"+first+"»")
	return ansi.Truncate(text, max(1, m.width-1), glyphEllipsis+sDim.Render("»"))
}
