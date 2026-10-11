package tui

import (
	"strings"
	"testing"
)

type foldTest struct{ closed, opened string }

func (b foldTest) render(_ int, open bool) string {
	if open {
		return b.opened
	}
	return b.closed
}

func (foldTest) folds() bool { return true }

type growBlock struct{ rows *int }

func (b growBlock) render(int, bool) string {
	return strings.TrimSuffix(strings.Repeat("x\n", *b.rows), "\n")
}

func newLog(width int) *transcript {
	t := &transcript{}
	t.resize(width)
	return t
}

func TestTranscriptAddsWrapsAndWindows(t *testing.T) {
	log := newLog(10)
	log.add(textBlock("uno"))
	log.add(textBlock("abcdefghijklmno"))
	if got := log.lines(); len(got) != 3 || got[2] != "klmno" {
		t.Fatalf("filas = %q", got)
	}
	if w := log.window(2, 0); w[0] != "abcdefghij" || w[1] != "klmno" {
		t.Errorf("ventana = %q", w)
	}
	if w := log.window(5, 0); len(w) != 5 || w[0] != "uno" || w[4] != "" {
		t.Errorf("con sitio de sobra la ventana se pega arriba: %q", w)
	}
	if log.maxScroll(2) != 1 || log.text() != "uno\nabcdefghijklmno" {
		t.Errorf("maxScroll=%d text=%q", log.maxScroll(2), log.text())
	}
	log.resize(5)
	if got := log.total(); got != 4 {
		t.Errorf("al estrechar se reenvuelve: %d filas", got)
	}
}

func TestRefreshKeepsTheFlatViewInSync(t *testing.T) {
	log := newLog(20)
	n := 1
	first := log.add(growBlock{&n})
	log.add(textBlock("fin"))
	n = 3
	start, delta := log.refresh(first)
	if start != 0 || delta != 2 {
		t.Fatalf("start=%d delta=%d", start, delta)
	}
	if got := strings.Join(log.lines(), ","); got != "x,x,x,fin" {
		t.Errorf("filas = %s", got)
	}
	m := 2
	last := log.add(growBlock{&m})
	m = 1
	if start, delta := log.refresh(last); start != 4 || delta != -1 || log.total() != 5 {
		t.Errorf("la última entrada se reescribe en su sitio: start=%d delta=%d total=%d", start, delta, log.total())
	}
}

func TestFoldAtOnlyAnswersOnTheHeaderRow(t *testing.T) {
	log := newLog(40)
	log.add(textBlock("antes"))
	e := log.add(foldTest{closed: "\n✦ Pensó 2 s", opened: "\n✦ Pensó 2 s\n┊ texto"})
	if log.foldAt(1) != nil {
		t.Error("la fila en blanco del bloque no es su cabecera")
	}
	if log.foldAt(2) != e {
		t.Fatal("la cabecera debe devolver el bloque")
	}
	if log.foldAt(0) != nil {
		t.Error("un bloque que no se pliega no responde")
	}
	e.open = true
	log.refresh(e)
	if got := log.lines(); len(got) != 4 || got[3] != "┊ texto" {
		t.Errorf("abierto = %q", got)
	}
}

func TestDetailOpensEveryFoldAndExpandedShowsAll(t *testing.T) {
	log := newLog(40)
	log.add(foldTest{closed: "a", opened: "a\nA"})
	log.add(textBlock("b"))
	if got := strings.Join(log.expanded(), ","); got != "a,A,b" {
		t.Errorf("expanded = %s", got)
	}
	if log.total() != 2 {
		t.Error("expanded no despliega el transcript normal")
	}
	log.setDetail(true)
	if got := strings.Join(log.lines(), ","); got != "a,A,b" {
		t.Errorf("con detalle = %s", got)
	}
	log.setDetail(false)
	if log.total() != 2 {
		t.Error("sin detalle vuelve a plegarse")
	}
}

func TestModelRefreshCompensatesTheScroll(t *testing.T) {
	m := &Model{}
	m.log.resize(20)
	n := 1
	for i := 0; i < 10; i++ {
		m.print("fila")
	}
	tail := m.add(growBlock{&n})
	m.scroll = 3
	n = 4
	m.refresh(tail)
	if m.scroll != 6 {
		t.Errorf("un bloque por debajo de la ventana que crece desplaza el scroll: %d", m.scroll)
	}
	head := m.log.entries[0]
	m.refresh(head)
	if m.scroll != 6 {
		t.Errorf("un bloque por encima no lo toca: %d", m.scroll)
	}
	m.print("nueva")
	if m.scroll != 7 {
		t.Errorf("añadir con el scroll arriba lo mantiene: %d", m.scroll)
	}
}

func TestClickOnAFoldHeaderTogglesIt(t *testing.T) {
	m := &Model{}
	m.log.resize(40)
	e := m.add(foldTest{closed: "cabecera", opened: "cabecera\ndetalle"})
	m.winRows, m.winTop = 10, 0
	m.sel = &selection{anchor: point{0, 3}, head: point{0, 3}, dragging: true}
	m.onMouseUp()
	if !e.open || m.log.total() != 2 {
		t.Fatal("un clic sin arrastre en la cabecera despliega el bloque")
	}
	m.toggleDetail()
	if !m.log.detail {
		t.Error("ctrl+o activa el detalle global")
	}
}
