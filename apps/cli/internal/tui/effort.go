package tui

import (
	"regexp"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/chat"
)

var effortNames = map[string]string{
	"": "auto", "off": "apagado", "on": "encendido", "low": "bajo", "medium": "medio", "high": "alto",
}

var effortDescs = map[string]string{
	"":       "alto al editar, lo del servidor al conversar",
	"off":    "responde rápido, sin pensar",
	"on":     "piensa antes de responder",
	"low":    "piensa poco y responde rápido",
	"medium": "piensa lo justo",
	"high":   "piensa más antes de actuar",
}

// gradedName son los modelos que gradúan el razonamiento en bajo, medio y
// alto (reasoning_effort) en vez de solo encenderlo o apagarlo: gpt-oss y los
// razonadores de OpenAI (o1, o3, o4-mini, gpt-5).
var gradedName = regexp.MustCompile(`(?i)gpt-oss|gpt-5|(^|[/:])o[134](-|$)`)

// graded dice si el modelo tiene niveles de esfuerzo: por su nombre o porque
// el servidor publica la capacidad reasoning_effort.
func (m *Model) graded(model string) bool {
	if gradedName.MatchString(model) {
		return true
	}
	for _, mod := range m.opts.Account.Models {
		if mod.ID == model {
			return mod.HasCapability("reasoning_effort")
		}
	}
	return false
}

// effortLevels son los niveles que acepta /effort, auto primero: los
// graduados no se pueden apagar; el resto solo distingue apagado y encendido.
func effortLevels(graded bool) []string {
	if graded {
		return []string{"", "low", "medium", "high"}
	}
	return []string{"", "off", "on"}
}

// thinks dice si el modelo razona; si el servidor no publica capacidades, no
// se sabe y se asume que sí.
func (m *Model) thinks() bool {
	for _, mod := range m.opts.Account.Models {
		if mod.ID == m.chat.Model {
			return mod.Capabilities == nil || mod.HasCapability("thinking")
		}
	}
	return m.chat.Effort != ""
}

// effortLabel es lo que enseña el pie; en auto, el modo agent pide el máximo.
func (m *Model) effortLabel() string {
	if !m.thinks() {
		return ""
	}
	name := effortNames[m.chat.Effort]
	if m.chat.Effort == "" && (m.chat.Mode == chat.ModeAgent || m.chat.Session.PlanMode) {
		name = "auto " + glyphArrow + " alto"
	}
	return name
}

func (m *Model) cmdEffort(arg string) tea.Cmd {
	graded := m.graded(m.chat.Model)
	levels := effortLevels(graded)
	apply := func(level string) {
		m.chat.SetEffort(level)
		m.add(okLine("Razonamiento: " + effortNames[m.chat.Effort]))
	}
	if arg = strings.ToLower(strings.TrimSpace(arg)); arg != "" {
		if arg == "auto" {
			arg = ""
		}
		if !slices.Contains(levels, arg) {
			var valid []string
			for _, l := range levels {
				valid = append(valid, firstNonEmpty(l, "auto"))
			}
			m.add(errLine(m.modelLabel(m.chat.Model) + " acepta: " + strings.Join(valid, ", ")))
			return nil
		}
		apply(arg)
		return nil
	}
	if !m.thinks() {
		m.add(note(m.modelLabel(m.chat.Model) + " no razona antes de responder: /effort no le afecta."))
		return nil
	}
	m.picker = m.effortSlider(levels, graded, apply)
	return nil
}

// effortSlider es el esfuerzo como un deslizador: ←→ recorre los niveles en
// una fila, enter usa el elegido y esc lo deja como estaba.
func (m *Model) effortSlider(levels []string, graded bool, apply func(string)) *picker {
	at := max(0, slices.Index(levels, m.chat.Effort))
	p := newInfoPanel("Esfuerzo", func(width int) []string {
		level := levels[at]
		on, of := effortSteps(level, graded)
		arrow := func(enabled bool, glyph string) string {
			if enabled {
				return sInk.Render(glyph)
			}
			return sTrack.Render(glyph)
		}
		meter := arrow(at > 0, "‹") + "  " + effortBars(on, of, true) + " " + sInk.Render(effortNames[level]) + "  " + arrow(at < len(levels)-1, "›")
		var track []string
		for i, l := range levels {
			if i == at {
				track = append(track, sAccent.Render(effortNames[l]))
			} else {
				track = append(track, sDim.Render(effortNames[l]))
			}
		}
		return []string{
			meter,
			"",
			ansi.Truncate(sSoft.Render(effortDescs[level]), width, glyphEllipsis),
			ansi.Truncate(strings.Join(track, sDim2.Render("  ·  ")), width, glyphEllipsis),
		}
	})
	p.right = sDim.Render(m.modelLabel(m.chat.Model))
	p.keys = [][2]string{{"←→", "cambiar"}, {"enter", "usar"}, {"esc", "cerrar"}}
	p.onKey = func(p *picker, msg tea.KeyPressMsg) (tea.Cmd, bool, bool) {
		switch msg.String() {
		case "left":
			at = max(0, at-1)
		case "right":
			at = min(len(levels)-1, at+1)
		case "home":
			at = 0
		case "end":
			at = len(levels) - 1
		case "enter":
			if levels[at] != m.chat.Effort {
				apply(levels[at])
			}
			return nil, true, true
		case "esc", "ctrl+c":
			return nil, true, true
		}
		return nil, true, false
	}
	return p
}
