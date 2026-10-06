package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// option es una fila de un selector.
type option struct {
	Label    string
	Value    string
	Desc     string
	Badge    string
	Disabled bool
}

// picker es un menú modal con flechas (o filtro al teclear): se usa para las
// aprobaciones y para los comandos que piden elegir (/model, /mode, /history…).
type picker struct {
	title    string
	detail   string
	hint     string
	options  []option
	cursor   int
	filter   string
	search   bool
	maxShown int
	// cancel es el valor que devuelve Esc («no» en las aprobaciones).
	cancel string
	// done recibe el valor elegido; cancelled indica que se cerró con Esc.
	done func(value string, cancelled bool) tea.Cmd
}

func newPicker(title string, options []option, done func(string, bool) tea.Cmd) *picker {
	p := &picker{title: title, options: options, maxShown: 12, done: done,
		hint: fmt.Sprintf("↑↓ mover %s ↵ elegir %s esc cancelar", glyphSep, glyphSep)}
	p.moveToEnabled(1)
	return p
}

func (p *picker) visible() []option {
	if p.filter == "" {
		return p.options
	}
	needle := strings.ToLower(p.filter)
	var out []option
	for _, o := range p.options {
		if strings.Contains(strings.ToLower(o.Label), needle) || strings.Contains(strings.ToLower(o.Desc), needle) {
			out = append(out, o)
		}
	}
	return out
}

func (p *picker) moveToEnabled(step int) {
	opts := p.visible()
	if len(opts) == 0 {
		p.cursor = 0
		return
	}
	p.cursor = max(0, min(p.cursor, len(opts)-1))
	for i := 0; i < len(opts) && opts[p.cursor].Disabled; i++ {
		p.cursor = (p.cursor + step + len(opts)) % len(opts)
	}
}

func (p *picker) move(step int) {
	opts := p.visible()
	if len(opts) == 0 {
		return
	}
	p.cursor = (p.cursor + step + len(opts)) % len(opts)
	p.moveToEnabled(step)
}

// key procesa una tecla; devuelve el comando resultante y si el selector se cerró.
func (p *picker) key(msg tea.KeyPressMsg) (cmd tea.Cmd, closed bool) {
	switch msg.String() {
	case "up", "ctrl+p", "shift+tab":
		p.move(-1)
	case "down", "ctrl+n", "tab":
		p.move(1)
	case "home":
		p.cursor = 0
		p.moveToEnabled(1)
	case "end":
		p.cursor = max(0, len(p.visible())-1)
		p.moveToEnabled(-1)
	case "enter":
		opts := p.visible()
		if len(opts) == 0 || opts[p.cursor].Disabled {
			return nil, false
		}
		return p.done(opts[p.cursor].Value, false), true
	case "esc", "ctrl+c":
		return p.done(p.cancel, true), true
	case "backspace":
		if p.search && p.filter != "" {
			r := []rune(p.filter)
			p.filter = string(r[:len(r)-1])
			p.cursor = 0
			p.moveToEnabled(1)
		}
	default:
		if p.search && msg.Key().Text != "" && len(msg.Key().Text) > 0 {
			p.filter += msg.Key().Text
			p.cursor = 0
			p.moveToEnabled(1)
		}
	}
	return nil, false
}

// view pinta el selector dentro del canal, con el detalle a la derecha del título.
func (p *picker) view(width int) string {
	var lines []string
	title := rail(true) + sBold.Render(p.title)
	if p.detail != "" {
		title = twoCol(title, sDim2.Render(p.detail), width)
	}
	lines = append(lines, title)
	if p.search {
		query := p.filter
		if query == "" {
			query = sDim2.Render("escribe para filtrar")
		}
		lines = append(lines, rail(true)+sDim2.Render("/ ")+query)
	}
	opts := p.visible()
	start := 0
	if len(opts) > p.maxShown {
		start = max(0, min(p.cursor-p.maxShown/2, len(opts)-p.maxShown))
	}
	end := min(len(opts), start+p.maxShown)
	labelWidth := 0
	for _, o := range opts[start:end] {
		labelWidth = max(labelWidth, ansi.StringWidth(o.Label))
	}
	for i := start; i < end; i++ {
		o := opts[i]
		label := o.Label + strings.Repeat(" ", labelWidth-ansi.StringWidth(o.Label))
		switch {
		case o.Disabled:
			lines = append(lines, rail(true)+sDim2.Render("  "+o.Label))
		case i == p.cursor:
			row := sAccent.Render(glyphEdge+" ") + sBold.Render(label)
			if o.Badge != "" {
				row += " " + sAccent.Render(o.Badge)
			}
			if o.Desc != "" {
				row += "  " + sDim.Render(o.Desc)
			}
			lines = append(lines, rail(true)+row)
		default:
			row := "  " + sPrimary.Render(label)
			if o.Badge != "" {
				row += " " + sDim2.Render(o.Badge)
			}
			if o.Desc != "" {
				row += "  " + sDim2.Render(o.Desc)
			}
			lines = append(lines, rail(true)+row)
		}
	}
	if len(opts) == 0 {
		lines = append(lines, rail(true)+sDim2.Render("  sin coincidencias"))
	}
	if len(opts) > p.maxShown {
		lines = append(lines, rail(true)+sDim2.Render(fmt.Sprintf("  %d de %d", p.cursor+1, len(opts))))
	}
	lines = append(lines, "  "+sDim2.Render(p.hint))
	for i, l := range lines {
		if ansi.StringWidth(l) > width {
			lines[i] = ansi.Truncate(l, width, glyphEllipsis)
		}
	}
	return strings.Join(lines, "\n")
}
