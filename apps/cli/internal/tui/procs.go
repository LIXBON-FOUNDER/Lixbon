package tui

import (
	"context"
	"fmt"
	"time"

	tea "charm.land/bubbletea/v2"
)

// liveProcs cuenta los comandos del agente que siguen en segundo plano.
func (m *Model) liveProcs() int {
	n := 0
	for _, p := range m.chat.Toolbox.Procs.List() {
		if p.Alive {
			n++
		}
	}
	return n
}

func runningFor(d time.Duration) string {
	d = d.Round(time.Second)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm %02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh %02dm", int(d.Hours()), int(d.Minutes())%60)
}

// openProcs es el panel de los comandos en segundo plano: cuánto llevan y,
// al elegir uno, pararlo.
func (m *Model) openProcs() tea.Cmd {
	procs := m.chat.Toolbox.Procs.List()
	if len(procs) == 0 {
		m.add(note("No hay comandos en segundo plano."))
		return nil
	}
	options := make([]option, 0, len(procs))
	for _, p := range procs {
		state, meta := sOK.Render("en marcha"), sDim.Render(runningFor(time.Since(p.Started)))
		if !p.Alive {
			state, meta = sDim.Render("terminado"), ""
		}
		options = append(options, option{Label: truncateRunes(p.Command, 60), Value: p.ID, Desc: p.ID, Extra: state, Meta: meta})
	}
	p := newPicker(fmt.Sprintf("Comandos en segundo plano (%d)", len(procs)), options, func(value string, cancelled bool) tea.Cmd {
		if cancelled {
			return nil
		}
		m.add(okLine(m.chat.Toolbox.Execute(context.Background(), "stop_command", map[string]any{"id": value})))
		return nil
	})
	p.keys = [][2]string{{"↑↓", "mover"}, {"↵", "detener"}, {"esc", "cerrar"}}
	m.picker = p
	return nil
}
