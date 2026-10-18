package tui

import (
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

const toastFor = 5 * time.Second

type toastExpiredMsg struct{ gen int }

// quietCommands son los de ajuste o consulta: no se quedan en el transcript,
// que es para lo que pide el usuario y lo que hace el agente. Su resultado
// sale en el pie (una línea) o en un panel que se cierra con esc.
var quietCommands = map[string]bool{
	"help": true, "model": true, "mode": true, "web": true, "copy": true, "save": true,
	"approve": true, "plan": true, "tools": true, "ps": true, "check": true, "allow": true,
	"workspace": true, "status": true, "cost": true, "usage": true, "nodes": true,
	"key": true, "logout": true, "mcp": true, "provider": true,
	"doctor": true, "config": true, "theme": true, "bar": true, "effort": true, "branch": true,
	"login": true,
}

// echoless no se ecoan pero lo que hacen sí va al transcript (/history repinta
// la conversación que reabre).
var echoless = map[string]bool{"history": true}

// captured ejecuta run desviando lo que imprima: si abre un selector o arranca
// un trabajo en segundo plano, lo que imprimen después se desvía igual.
func (m *Model) captured(title string, run func() tea.Cmd) tea.Cmd {
	if m.capturing != nil {
		return run()
	}
	var got []block
	m.capturing = &got
	before, wasBusy := m.picker, m.busy != ""
	cmd := run()
	m.capturing = nil
	if m.picker != nil && m.picker != before {
		m.picker.quiet = true
	}
	if !wasBusy && m.busy != "" {
		m.asyncQuiet = title
	}
	return tea.Batch(cmd, m.present(title, got))
}

// uncaptured ejecuta run imprimiendo en el transcript aunque se llame desde un
// comando silencioso (p. ej. /help → /history).
func (m *Model) uncaptured(run func() tea.Cmd) tea.Cmd {
	saved := m.capturing
	m.capturing = nil
	defer func() { m.capturing = saved }()
	return run()
}

// present muestra lo capturado: una línea corta en el pie y lo demás en un
// panel. Si el comando dejó abierto un selector, va encima de sus opciones.
func (m *Model) present(title string, blocks []block) tea.Cmd {
	var shown []block
	for _, b := range blocks {
		if t, ok := b.(textBlock); ok && strings.TrimSpace(ansi.Strip(string(t))) == "" {
			continue
		}
		shown = append(shown, b)
	}
	if len(shown) == 0 {
		return nil
	}
	width := max(20, m.width-4)
	if len(shown) == 1 {
		if n, ok := shown[0].(noticeBlock); ok && n.kind != kindSep {
			line := strings.TrimLeft(n.render(1<<12, false), " ")
			if !strings.Contains(line, "\n") && ansi.StringWidth(line) <= max(40, m.width-24) {
				return m.toast(line)
			}
		}
	}
	if m.picker != nil {
		var body []string
		for _, b := range shown {
			body = append(body, strings.Split(b.render(width-2, true), "\n")...)
		}
		m.picker.body = append(body, m.picker.body...)
		return nil
	}
	m.picker = newInfoPanel(title, func(inner int) []string {
		var out []string
		for i, b := range shown {
			if i > 0 && isReport(b) {
				out = append(out, "")
			}
			out = append(out, strings.Split(b.render(inner, true), "\n")...)
		}
		return out
	})
	return nil
}

func isReport(b block) bool {
	_, ok := b.(reportBlock)
	return ok
}

// toast enseña una línea en el pie durante unos segundos.
func (m *Model) toast(line string) tea.Cmd {
	m.toastGen++
	m.toastText = line
	gen := m.toastGen
	return tea.Tick(toastFor, func(time.Time) tea.Msg { return toastExpiredMsg{gen} })
}

// pickerDo aplica una tecla o un clic al selector abierto. Lo que imprima su
// respuesta se desvía si lo abrió un comando silencioso.
func (m *Model) pickerDo(act func(p *picker) (tea.Cmd, bool)) tea.Cmd {
	p := m.picker
	run := func() tea.Cmd {
		cmd, closed := act(p)
		if closed && m.picker == p {
			m.picker = nil
		}
		return cmd
	}
	if p.quiet {
		return m.captured(p.title, run)
	}
	return run()
}
