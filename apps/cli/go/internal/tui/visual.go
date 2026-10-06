package tui

import (
	"context"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/chat"
)

// cmdVisual diseña en Lixbon Visuals con el agente: crear, editar o pasar a
// código. Las instrucciones las da el prompt `visual` del MCP de Lixbon.
func (m *Model) cmdVisual(arg string) tea.Cmd {
	if arg == "" {
		m.print(errLine("Uso: /visual <qué diseñar>"))
		m.print(note("  /visual una landing para mi API             crea un visual nuevo"))
		m.print(note("  /visual vis_… haz el título más grande       edita uno existente (id o enlace)"))
		m.print(note("  /visual codigo vis_… react                   lo implementa en este proyecto"))
		return nil
	}
	return m.async("preparando Lixbon Visuals", func(ctx context.Context) cmdDoneMsg {
		instructions, err := m.chat.VisualPrompt(ctx, arg)
		if err != nil {
			return cmdDoneMsg{lines: []string{errLine(err.Error())}}
		}
		return cmdDoneMsg{then: func(m *Model) tea.Cmd {
			m.chat.Session.PlanMode = false
			m.setMode(chat.ModeAgent)
			return m.startTurn(instructions, "")
		}}
	})
}
