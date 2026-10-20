package tui

import (
	"context"
	"fmt"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
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

// openProcs es el panel de los procesos en segundo plano: cuánto llevan, la
// salida del elegido debajo; k lo para y enter enseña la salida entera.
func (m *Model) openProcs() tea.Cmd {
	procs := m.chat.Toolbox.Procs.List()
	if len(procs) == 0 {
		m.add(note("No hay comandos en segundo plano."))
		return nil
	}
	options := make([]option, 0, len(procs))
	live := 0
	for _, p := range procs {
		meta := sDim.Render(runningFor(time.Since(p.Started)))
		if p.Alive {
			live++
		} else {
			meta = sDim.Render("terminó")
		}
		options = append(options, option{Label: truncateRunes(p.Command, 60), Value: p.ID, Meta: meta})
	}
	alive := func(id string) bool {
		for _, p := range m.chat.Toolbox.Procs.List() {
			if p.ID == id {
				return p.Alive
			}
		}
		return false
	}
	p := newPicker("Procesos", options, func(value string, cancelled bool) tea.Cmd {
		if cancelled {
			return nil
		}
		lines := m.procTail(value, 400)
		name := value
		for _, o := range options {
			if o.Value == value {
				name = o.Label
			}
		}
		panel := newInfoPanel("Salida de "+name, func(int) []string {
			if len(lines) == 0 {
				return []string{sDim.Render("sin salida todavía")}
			}
			out := make([]string, len(lines))
			for i, l := range lines {
				out[i] = sSoft.Render(l)
			}
			return out
		})
		panel.scroll = 1 << 30
		m.picker = panel
		return nil
	})
	p.noNumbers = true
	status := fmt.Sprintf("%d en marcha", live)
	if done := len(procs) - live; done > 0 {
		status += fmt.Sprintf("   %d %s", done, plural(done, "terminado", "terminados"))
	}
	p.right = sDim.Render(status)
	p.before = func(o option, _ bool) string {
		if alive(o.Value) {
			return sOK.Render(glyphDot)
		}
		return sDim.Render(glyphTodo)
	}
	p.foot = func(o option, inner int) []string {
		tail := m.procTail(o.Value, 3)
		if len(tail) == 0 {
			return nil
		}
		out := []string{"  " + sDim.Render("salida de "+o.Label)}
		for _, l := range tail {
			out = append(out, "  "+sSoft.Render(ansi.Truncate(l, max(4, inner-2), glyphEllipsis)))
		}
		return out
	}
	p.onKey = func(p *picker, msg tea.KeyPressMsg) (tea.Cmd, bool, bool) {
		if msg.String() != "k" {
			return nil, false, false
		}
		opts := p.visible()
		if p.cursor < len(opts) {
			m.add(okLine(m.chat.Toolbox.Execute(context.Background(), "stop_command", map[string]any{"id": opts[p.cursor].Value})))
		}
		m.picker = nil
		return nil, true, true
	}
	p.keys = [][2]string{{"↑↓", "mover"}, {"enter", "salida completa"}, {"k", "parar"}, {"esc", "cerrar"}}
	m.picker = p
	return nil
}
