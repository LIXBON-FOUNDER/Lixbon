package tui

import (
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/chat"
)

var effortNames = map[string]string{
	"": "auto", "off": "apagado", "on": "encendido", "low": "bajo", "medium": "medio", "high": "alto",
}

// effortLevels: Ollama solo gradúa el razonamiento de gpt-oss (low, medium,
// high, y no se puede apagar); el resto de modelos con razonamiento solo
// distinguen encendido y apagado.
func effortLevels(model string) []string {
	if strings.Contains(strings.ToLower(model), "gpt-oss") {
		return []string{"", "low", "medium", "high"}
	}
	return []string{"", "on", "off"}
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
	levels := effortLevels(m.chat.Model)
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
	descs := map[string]string{
		"":       "el CLI decide: alto en agent y plan, lo del servidor en ask",
		"off":    "responde directamente, más rápido y con menos contexto",
		"on":     "piensa antes de responder",
		"low":    "piensa poco: respuestas rápidas",
		"medium": "equilibrio entre rapidez y profundidad",
		"high":   "piensa a fondo: más lento, mejor en tareas difíciles",
	}
	options := make([]option, 0, len(levels))
	cursor := 0
	for i, l := range levels {
		o := option{Label: effortNames[l], Value: firstNonEmpty(l, "auto"), Desc: descs[l]}
		if l == m.chat.Effort {
			o.Badge, cursor = "actual", i
		}
		options = append(options, o)
	}
	p := newPicker("Razonamiento de "+m.modelLabel(m.chat.Model), options, func(value string, cancelled bool) tea.Cmd {
		if !cancelled {
			apply(strings.TrimPrefix(value, "auto"))
		}
		return nil
	})
	p.cursor = cursor
	m.picker = p
	return nil
}
