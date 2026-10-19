package tui

import (
	"slices"
	"strings"

	"github.com/charmbracelet/x/ansi"
)

// block es una entrada del transcript: sabe pintarse a cualquier ancho y, si
// se pliega, distinta abierta que cerrada.
type block interface {
	render(width int, open bool) string
}

// folder lo cumplen los bloques plegables (pensamiento, salida larga, diff):
// un clic en su cabecera o ctrl+o los abren.
type folder interface{ folds() bool }

type textBlock string

func (b textBlock) render(int, bool) string { return string(b) }

type funcBlock func(width int) string

func (b funcBlock) render(width int, _ bool) string { return b(width) }

// lazier lo cumplen los bloques caros de pintar (markdown): al redimensionar
// se reenvuelve lo ya pintado y se repintan después, con calma.
type lazier interface{ lazy() bool }

type entry struct {
	b     block
	open  bool
	text  string
	rows  []string
	dirty bool
	// detached: la entrada se mostró fuera del transcript (pie o panel).
	detached bool
	// rail: la entrada es un paso del agente y cuelga del riel de su turno.
	rail railMark
}

type railMark int

const (
	railNone railMark = iota
	railMid
	railEnd // el último paso: el riel se cierra en él
)

func (e *entry) folds() bool {
	f, ok := e.b.(folder)
	return ok && f.folds()
}

// transcript guarda las entradas con sus filas ya envueltas al ancho vigente.
// flat y owner son la vista plana (fila → entrada); se rehacen a demanda
// cuando una entrada de en medio cambia de alto.
type transcript struct {
	entries []*entry
	width   int
	detail  bool
	flat    []string
	owner   []int
	stale   bool
}

func (t *transcript) wrapLine(line string) []string {
	if t.width <= 0 {
		return []string{line}
	}
	return strings.Split(ansi.Hardwrap(line, t.width, true), "\n")
}

// render pinta la entrada; un paso del riel se pinta dos columnas más
// estrecho y con el riel delante.
func (t *transcript) render(e *entry, open bool) string {
	if e.rail == railNone {
		return e.b.render(t.width, open)
	}
	return withRail(e.b.render(max(10, t.width-2), open), e.rail == railEnd)
}

func (t *transcript) paint(e *entry) {
	e.text = t.render(e, e.open || t.detail)
	e.dirty = false
	t.rewrap(e)
}

func (t *transcript) rewrap(e *entry) {
	var rows []string
	for _, line := range strings.Split(e.text, "\n") {
		rows = append(rows, t.wrapLine(line)...)
	}
	e.rows = rows
}

func (t *transcript) add(b block) *entry { return t.addRail(b, railNone) }

func (t *transcript) addRail(b block, rail railMark) *entry {
	e := &entry{b: b, rail: rail}
	t.paint(e)
	t.entries = append(t.entries, e)
	if !t.stale {
		t.flat = append(t.flat, e.rows...)
		for range e.rows {
			t.owner = append(t.owner, len(t.entries)-1)
		}
	}
	return e
}

// insert mete un bloque en la posición i (la cabecera de un turno, que se
// sabe que hace falta cuando ya hay pasos debajo).
func (t *transcript) insert(i int, b block) *entry {
	e := &entry{b: b}
	t.paint(e)
	t.entries = slices.Insert(t.entries, i, e)
	t.stale = true
	return e
}

func (t *transcript) index(e *entry) int { return slices.Index(t.entries, e) }

func (t *transcript) flatten() {
	if !t.stale {
		return
	}
	t.flat, t.owner = nil, nil
	for i, e := range t.entries {
		t.flat = append(t.flat, e.rows...)
		for range e.rows {
			t.owner = append(t.owner, i)
		}
	}
	t.stale = false
}

func (t *transcript) lines() []string {
	t.flatten()
	return t.flat
}

func (t *transcript) total() int { return len(t.lines()) }

func (t *transcript) start(e *entry) int {
	start := 0
	for _, x := range t.entries {
		if x == e {
			break
		}
		start += len(x.rows)
	}
	return start
}

// remove saca e del transcript y devuelve cuántas filas ocupaba.
func (t *transcript) remove(e *entry) int {
	for i, x := range t.entries {
		if x == e {
			t.entries = append(t.entries[:i], t.entries[i+1:]...)
			t.stale = true
			return len(e.rows)
		}
	}
	return 0
}

// refresh vuelve a pintar e y devuelve la fila donde empieza y cuántas filas
// ganó o perdió.
func (t *transcript) refresh(e *entry) (start, delta int) {
	start = t.start(e)
	before := len(e.rows)
	t.paint(e)
	delta = len(e.rows) - before
	if n := len(t.entries); !t.stale && n > 0 && t.entries[n-1] == e {
		t.flat = append(t.flat[:start], e.rows...)
		t.owner = t.owner[:start]
		for range e.rows {
			t.owner = append(t.owner, n-1)
		}
	} else {
		t.stale = true
	}
	return start, delta
}

// foldAt devuelve la entrada plegable cuya cabecera (su primera fila con
// texto) está en row.
func (t *transcript) foldAt(row int) *entry {
	t.flatten()
	if row < 0 || row >= len(t.owner) {
		return nil
	}
	e := t.entries[t.owner[row]]
	if !e.folds() {
		return nil
	}
	head := t.start(e)
	for i, r := range e.rows {
		if strings.TrimSpace(ansi.Strip(r)) != "" {
			head += i
			break
		}
	}
	if row != head {
		return nil
	}
	return e
}

// imageAt devuelve la imagen que se pinta en la fila row, o "".
func (t *transcript) imageAt(row, width int) string {
	t.flatten()
	if row < 0 || row >= len(t.owner) {
		return ""
	}
	e := t.entries[t.owner[row]]
	if b, ok := e.b.(imageBlock); ok {
		return b.imageAt(row-t.start(e), width)
	}
	return ""
}

func (t *transcript) setDetail(on bool) {
	if t.detail == on {
		return
	}
	t.detail = on
	for _, e := range t.entries {
		if e.folds() {
			t.paint(e)
		}
	}
	t.stale = true
}

func (t *transcript) resize(width int) {
	if width == t.width {
		return
	}
	t.width = width
	for _, e := range t.entries {
		if l, ok := e.b.(lazier); ok && l.lazy() && e.rows != nil {
			t.rewrap(e)
			e.dirty = true
			continue
		}
		t.paint(e)
	}
	t.stale = true
}

// repaintDirty repinta las entradas caras que el último resize solo
// reenvolvió. Devuelve si hubo alguna.
func (t *transcript) repaintDirty() bool {
	any := false
	for _, e := range t.entries {
		if e.dirty {
			t.paint(e)
			any = true
		}
	}
	if any {
		t.stale = true
	}
	return any
}

// relayout vuelve a pintar todo, p. ej. tras un cambio de tema.
func (t *transcript) relayout() {
	for _, e := range t.entries {
		t.paint(e)
	}
	t.stale = true
}

// window devuelve exactamente rows filas: el final del transcript desplazado
// scroll filas hacia arriba. Si cabe entero, queda pegado arriba.
func (t *transcript) window(rows, scroll int) []string {
	if rows <= 0 {
		return nil
	}
	all := t.lines()
	total := len(all)
	scroll = max(0, min(scroll, total-rows))
	end := total - scroll
	start := max(0, end-rows)
	out := append([]string(nil), all[start:end]...)
	for len(out) < rows {
		out = append(out, "")
	}
	return out
}

// expanded es el transcript con todo desplegado, para el visor de ctrl+t.
func (t *transcript) expanded() []string {
	var out []string
	for _, e := range t.entries {
		text := e.text
		if e.folds() {
			text = t.render(e, true)
		}
		for _, line := range strings.Split(text, "\n") {
			out = append(out, t.wrapLine(line)...)
		}
	}
	return out
}

func (t *transcript) reset() {
	t.entries, t.flat, t.owner, t.stale = nil, nil, nil, false
}

func (t *transcript) maxScroll(rows int) int { return max(0, t.total()-rows) }

func (t *transcript) text() string {
	texts := make([]string, len(t.entries))
	for i, e := range t.entries {
		texts[i] = e.text
	}
	return strings.Join(texts, "\n")
}
