package tui

import (
	"slices"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"lixbon.com/cli/internal/chat"
)

// modeCycle son los modos en el orden de shift+tab. agent, auto y plan son
// el mismo modo del chat (agent) con distintos permisos: auto edita y ejecuta
// sin preguntar; plan explora y propone sin tocar nada.
var modeCycle = []string{chat.ModeAsk, chat.ModeAgent, "auto", "plan"}

// modeLook es cómo se ve un modo: su nombre, en su color, y qué hace.
func (m *Model) modeLook(mode string) (name, desc string, style lipgloss.Style) {
	color := func(hex string) lipgloss.Style { return lipgloss.NewStyle().Foreground(lipgloss.Color(hex)) }
	switch mode {
	case chat.ModeAgent:
		desc = "pregunta antes de editar"
		if m.chat.Session.AutoApprove {
			desc = "pregunta antes de ejecutar"
		}
		return "agente", desc, sAccent
	case "auto":
		return "auto", "edita y ejecuta sin preguntar", color(pal.warn)
	case "plan":
		return "plan", "explora y propone, sin tocar nada", color(pal.ty)
	case chat.ModeDelegate:
		return "delega", "el servidor elige el modelo", color(pal.kw)
	}
	return "conversa", "lee y responde, sin editar", color(pal.info)
}

// modeName es el modo que se muestra: plan y auto son el agente con otros
// permisos.
func (m *Model) modeName() string {
	s := m.chat.Session
	if m.chat.Mode == chat.ModeAgent {
		switch {
		case s.PlanMode:
			return "plan"
		case s.AutoApprove && s.AutoRunCommands:
			return "auto"
		}
	}
	return m.chat.Mode
}

// remoteMode es el modo para la app: no conoce auto, que para ella es agent.
func (m *Model) remoteMode() string {
	if mode := m.modeName(); mode != "auto" {
		return mode
	}
	return chat.ModeAgent
}

// modeView es el modo en el pie: el nombre en su color y lo que hace.
func (m *Model) modeView() string {
	name, desc, style := m.modeLook(m.modeName())
	return style.Render(name) + sDim.Render("  "+desc)
}

// applyMode pasa a un modo. auto y plan solo valen para esta sesión: al
// volver a abrir, el agente pregunta como siempre.
func (m *Model) applyMode(mode string) {
	s := m.chat.Session
	switch mode {
	case chat.ModeAsk, chat.ModeDelegate:
		m.setMode(mode)
		s.AutoApprove, s.AutoRunCommands = m.chat.Cfg.AutoApproveTools, m.autoRunDefault
	case chat.ModeAgent, "auto", "plan":
		if m.chat.Mode != chat.ModeAgent {
			m.setMode(chat.ModeAgent)
		}
		s.PlanMode = mode == "plan"
		s.AutoApprove = mode == "auto" || m.chat.Cfg.AutoApproveTools
		s.AutoRunCommands = mode == "auto" || mode == chat.ModeAgent && m.autoRunDefault
	}
	m.refreshContext()
}

func (m *Model) cycleMode() {
	i := slices.Index(modeCycle, m.modeName())
	m.applyMode(modeCycle[(i+1)%len(modeCycle)])
}

func (m *Model) cmdMode(arg string) tea.Cmd {
	modes := append(append([]string{}, modeCycle...), chat.ModeDelegate)
	apply := func(mode string) {
		m.applyMode(mode)
		if m.chat.Mode == chat.ModeAgent {
			m.add(note("Workspace del agente: " + shortPath(m.chat.Workspace)))
		}
	}
	if slices.Contains(modes, arg) {
		apply(arg)
		return nil
	}
	options := make([]option, 0, len(modes))
	for _, mode := range modes {
		name, desc, _ := m.modeLook(mode)
		options = append(options, option{Label: name, Value: mode, Desc: desc})
	}
	p := newPicker("Modo", options, func(value string, cancelled bool) tea.Cmd {
		if !cancelled {
			apply(value)
		}
		return nil
	})
	p.noNumbers = true
	p.right = keyHints([2]string{"shift+tab", "cambia"})
	p.before = func(o option, _ bool) string {
		_, _, style := m.modeLook(o.Value)
		return style.Render(glyphDot)
	}
	p.cursor = max(0, slices.Index(modes, m.modeName()))
	m.picker = p
	return nil
}
