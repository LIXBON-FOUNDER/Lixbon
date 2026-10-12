package tui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// option es una fila de un selector. Meta va pegado a la derecha (ya pintado)
// y Extra detrás de la descripción (p. ej. las capacidades de un modelo).
type option struct {
	Label    string
	Value    string
	Desc     string
	Badge    string
	Meta     string
	Extra    string
	Disabled bool
}

// picker es un panel modal con flechas, números o filtro al teclear: se usa
// para las aprobaciones, las preguntas y los comandos que piden elegir.
type picker struct {
	title    string
	body     []string
	keys     [][2]string
	options  []option
	cursor   int
	filter   string
	search   bool
	maxShown int
	// tone es el color del borde: ámbar en aprobaciones y preguntas.
	tone string
	// cancel es el valor que devuelve Esc («no» en las aprobaciones).
	cancel string
	// done recibe el valor elegido; cancelled indica que se cerró con Esc.
	done func(value string, cancelled bool) tea.Cmd
	// onKey atiende antes que el selector las teclas propias de un panel (las
	// flechas laterales del navegador de carpetas); handled corta el resto.
	onKey func(p *picker, msg tea.KeyPressMsg) (cmd tea.Cmd, handled, closed bool)
	// content convierte el panel en uno informativo: sin opciones, con el
	// texto que devuelve a ese ancho y desplazable con las flechas.
	content func(width int) []string
	scroll  int
	// quiet: lo que imprima done va al pie o a un panel, no al transcript.
	quiet bool
	// token identifica a quién responde el panel (la aprobación en curso).
	token any
	// anchor: el panel lo abrió un botón y se pinta pegado a él.
	anchor *anchor

	// Lo que pintó el último view, para traducir clics a filas.
	start, optionTop, shown int
}

func newPicker(title string, options []option, done func(string, bool) tea.Cmd) *picker {
	p := &picker{title: title, options: options, maxShown: 12, done: done}
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

// numbered: sin filtro y con pocas opciones, las teclas 1–9 eligen.
func (p *picker) numbered() bool {
	if p.search {
		return false
	}
	n := 0
	for _, o := range p.options {
		if !o.Disabled {
			n++
		}
	}
	return n > 1 && n <= 9
}

// enabledIndex es la posición en visible() de la opción habilitada número n (1…).
func (p *picker) enabledIndex(n int) int {
	for i, o := range p.visible() {
		if o.Disabled {
			continue
		}
		if n--; n == 0 {
			return i
		}
	}
	return -1
}

func (p *picker) choose(i int) (tea.Cmd, bool) {
	opts := p.visible()
	if i < 0 || i >= len(opts) || opts[i].Disabled {
		return nil, false
	}
	p.cursor = i
	return p.done(opts[i].Value, false), true
}

// key procesa una tecla; devuelve el comando resultante y si el selector se cerró.
func (p *picker) key(msg tea.KeyPressMsg) (cmd tea.Cmd, closed bool) {
	if p.onKey != nil {
		if cmd, handled, closed := p.onKey(p, msg); handled {
			return cmd, closed
		}
	}
	if p.content != nil {
		return p.infoKey(msg.String())
	}
	switch k := msg.String(); k {
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
		return p.choose(p.cursor)
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
		if p.numbered() && len(k) == 1 && k[0] >= '1' && k[0] <= '9' {
			return p.choose(p.enabledIndex(int(k[0] - '0')))
		}
		if p.search && msg.Key().Text != "" {
			p.filter += msg.Key().Text
			p.cursor = 0
			p.moveToEnabled(1)
		}
	}
	return nil, false
}

// click elige la fila row del panel (contando desde su borde superior).
func (p *picker) click(row int) (tea.Cmd, bool) {
	if p.content != nil {
		return nil, false
	}
	i := row - p.optionTop
	if i < 0 || i >= p.shown {
		return nil, false
	}
	return p.choose(p.start + i)
}

func (p *picker) hints() string {
	if p.content != nil && len(p.keys) == 0 {
		return keyHints([2]string{"↑↓", "desplazar"}, [2]string{"esc", "cerrar"})
	}
	if len(p.keys) > 0 {
		return keyHints(p.keys...)
	}
	pairs := [][2]string{{"↑↓", "mover"}}
	if p.numbered() {
		pairs = append(pairs, [2]string{fmt.Sprintf("1–%d", p.enabledIndexCount()), "elegir"})
	}
	if p.search {
		pairs = append(pairs, [2]string{"escribe", "filtra"})
	}
	pairs = append(pairs, [2]string{"↵", "elegir"}, [2]string{"esc", "cancelar"})
	return keyHints(pairs...)
}

func (p *picker) enabledIndexCount() int {
	n := 0
	for _, o := range p.options {
		if !o.Disabled {
			n++
		}
	}
	return n
}

// view pinta el panel a lo ancho, con como mucho maxRows filas de opciones.
func (p *picker) view(width, maxRows int) []string {
	inner := max(1, width-4)
	if p.content != nil {
		return p.infoView(width, inner, maxRows)
	}
	var rows []panelRow
	for _, b := range p.body {
		rows = append(rows, panelRow{text: b})
	}
	opts := p.visible()
	if len(p.body) > 0 && len(opts) > 0 {
		rows = append(rows, panelRow{})
	}
	if p.search {
		query := sInk.Render(p.filter) + sAccent.Render(glyphEdge)
		if p.filter == "" {
			query = sAccent.Render(glyphEdge) + sDim2.Render("escribe para filtrar")
		}
		count := sDim.Render(fmt.Sprintf("%d de %d", len(opts), len(p.options)))
		rows = append(rows, panelRow{text: fitRight(sDim2.Render("/ ")+query, count, inner+1)})
	}
	limit := max(1, min(p.maxShown, maxRows))
	start := 0
	if len(opts) > limit {
		start = max(0, min(p.cursor-limit/2, len(opts)-limit))
	}
	end := min(len(opts), start+limit)
	labelWidth := 0
	for _, o := range opts[start:end] {
		if !o.Disabled {
			labelWidth = max(labelWidth, ansi.StringWidth(o.Label))
		}
	}
	labelWidth = min(labelWidth, max(8, inner/2))
	numbers := p.numbered()
	p.start, p.optionTop, p.shown = start, 1+len(rows), end-start
	number := 0
	for i := 0; i < start; i++ {
		if !opts[i].Disabled {
			number++
		}
	}
	for i := start; i < end; i++ {
		o := opts[i]
		if o.Disabled {
			rows = append(rows, panelRow{text: sDim2.Bold(true).Render(strings.ToUpper(o.Label))})
			continue
		}
		number++
		on := i == p.cursor
		bar, labelStyle, descStyle := " ", sPrimary, sDim
		if on {
			bar, labelStyle, descStyle = sAccent.Render(glyphEdge), sBold, sSoft
		}
		left := bar + " "
		if numbers {
			numStyle := sDim2
			if on {
				numStyle = sAccent
			}
			left += numStyle.Render(fmt.Sprintf("%d", number)) + "  "
		}
		label := ansi.Truncate(o.Label, labelWidth, glyphEllipsis)
		left += labelStyle.Render(label + strings.Repeat(" ", labelWidth-ansi.StringWidth(label)))
		if o.Desc != "" {
			left += "  " + descStyle.Render(o.Desc)
		}
		if o.Extra != "" {
			left += "  " + o.Extra
		}
		right := o.Meta
		if o.Badge != "" {
			if right != "" {
				right += "  "
			}
			right += sAccent.Render(o.Badge)
		}
		row := panelRow{text: fitRight(left, right, inner+1)}
		if on {
			row.bg = pal.surf2
		}
		rows = append(rows, row)
	}
	if len(opts) == 0 {
		rows = append(rows, panelRow{text: sDim.Render("  sin coincidencias")})
	}
	if len(opts) > limit {
		rows = append(rows, panelRow{text: sDim2.Render(fmt.Sprintf("  %d de %d", p.cursor+1, len(opts)))})
	}
	tone := p.tone
	if tone == "" {
		tone = pal.faint
	}
	return panel(rows, width, tone, p.title)
}

func newInfoPanel(title string, content func(width int) []string) *picker {
	return &picker{title: title, content: content, done: func(string, bool) tea.Cmd { return nil }}
}

// infoKeys son las teclas de un panel informativo; cualquier otra lo cierra
// y llega a la caja, para seguir escribiendo sin pasar por esc.
var infoKeys = map[string]bool{"up": true, "down": true, "pgup": true, "pgdown": true, "home": true, "end": true,
	"esc": true, "enter": true, "ctrl+c": true}

func (p *picker) infoKey(k string) (tea.Cmd, bool) {
	switch k {
	case "up":
		p.scroll--
	case "down":
		p.scroll++
	case "pgup":
		p.scroll -= 10
	case "pgdown":
		p.scroll += 10
	case "home":
		p.scroll = 0
	case "end":
		p.scroll = 1 << 30
	case "esc", "enter", "ctrl+c":
		return p.done("", true), true
	}
	p.scroll = max(0, p.scroll)
	return nil, false
}

func (p *picker) infoView(width, inner, maxRows int) []string {
	lines := p.content(inner)
	limit := max(1, maxRows)
	var rows []panelRow
	if len(lines) > limit {
		limit = max(1, limit-1)
	}
	p.scroll = min(p.scroll, max(0, len(lines)-limit))
	for _, l := range lines[p.scroll:min(len(lines), p.scroll+limit)] {
		rows = append(rows, panelRow{text: l})
	}
	if len(lines) > limit {
		rows = append(rows, panelRow{text: sDim2.Render(fmt.Sprintf("  %d–%d de %d", p.scroll+1, min(len(lines), p.scroll+limit), len(lines)))})
	}
	return panel(rows, width, pal.faint, p.title)
}
