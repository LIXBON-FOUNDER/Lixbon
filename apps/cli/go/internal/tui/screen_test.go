package tui

import (
	"context"
	"fmt"
	"io"
	"runtime"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

// screenRig ejecuta el programa real contra un emulador de terminal estándar
// para ver lo que el usuario vería: filas, posiciones y restos de fotogramas.
type screenRig struct {
	t    *testing.T
	emu  *vt.SafeEmulator
	in   *io.PipeWriter
	end  chan error
	rows int
}

func startScreen(t *testing.T, h *harness, cols, rows int) *screenRig {
	t.Helper()
	emu := vt.NewSafeEmulator(cols, rows)
	// Sin un TTY real, en Unix Bubble Tea emite LF sin CR esperando que el
	// terminal lo traduzca; el emulador necesita el modo LNM para hacerlo. En
	// Windows no traduce y usa el LF puro para bajar de fila: con LNM se rompe.
	if runtime.GOOS != "windows" {
		emu.WriteString("\x1b[20h")
	}
	go io.Copy(io.Discard, emu)
	pr, pw := io.Pipe()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	rig := &screenRig{t: t, emu: emu, in: pw, end: make(chan error, 1), rows: rows}
	go func() {
		rig.end <- runProgram(ctx, h.m, false, false, pr, emu, tea.WithWindowSize(cols, rows))
	}()
	return rig
}

func (r *screenRig) type_(s string) {
	io.WriteString(r.in, s)
	time.Sleep(200 * time.Millisecond)
}

func (r *screenRig) lines() []string {
	var out []string
	for _, l := range strings.Split(ansi.Strip(r.emu.Render()), "\n") {
		out = append(out, strings.TrimRight(l, " "))
	}
	return out
}

func (r *screenRig) screen() string { return strings.Join(r.lines(), "\n") }

func (r *screenRig) until(what string, cond func() bool) {
	r.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			r.t.Fatalf("no se cumplió: %s%s", what, r.dump())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (r *screenRig) waitFor(text string) {
	r.t.Helper()
	r.until(text, func() bool { return strings.Contains(r.screen(), text) })
}

func (r *screenRig) waitGone(text string) {
	r.t.Helper()
	r.until("que desaparezca "+text, func() bool { return !strings.Contains(r.screen(), text) })
}

func (r *screenRig) rowOf(text string) int {
	for i, l := range r.lines() {
		if strings.Contains(l, text) {
			return i
		}
	}
	return -1
}

func (r *screenRig) count(text string) int { return strings.Count(r.screen(), text) }

func (r *screenRig) dump() string { return fmt.Sprintf("\n%s", r.screen()) }

func TestInputBarStaysPinnedAndNeverDuplicates(t *testing.T) {
	h := newHarness(t, func(c *configT) { c.Model = "" })
	rig := startScreen(t, h, 100, 30)
	rig.waitFor("Lixbon CLI")
	rig.waitFor("sin modelo")

	status := rig.rowOf("sin modelo  ·  API key")
	box := rig.rowOf("╭")
	if status != rig.rows-1 || box != rig.rows-4 {
		t.Fatalf("la barra debe ir en las últimas filas: caja=%d estado=%d%s", box, status, rig.dump())
	}

	for _, step := range []string{"/", "c", "l", "\x7f", "\x7f", "\x7f", "/", "c", "o", "\x7f", "\x7f", "\x7f"} {
		rig.type_(step)
		if got := rig.count("╭"); got != 1 {
			t.Fatalf("tras %q hay %d cajas de entrada%s", step, got, rig.dump())
		}
		if rig.rowOf("╭") != box || rig.rowOf("sin modelo  ·  API key") != status {
			t.Fatalf("tras %q la barra se movió%s", step, rig.dump())
		}
	}
	rig.type_("/")
	if rig.rowOf("/clear") < 0 || rig.rowOf("/clear") >= box {
		t.Fatalf("el menú debe abrirse sobre la caja%s", rig.dump())
	}
}

func TestLogoAndHeaderAreAtTheTop(t *testing.T) {
	h := newHarness(t, nil)
	rig := startScreen(t, h, 100, 30)
	rig.waitFor("Lixbon CLI")
	if row := rig.rowOf("Lixbon CLI"); row < 1 || row > 4 {
		t.Fatalf("la cabecera va arriba: fila %d%s", row, rig.dump())
	}
	if !strings.ContainsAny(rig.screen(), "▀▄") {
		t.Fatalf("falta el logo%s", rig.dump())
	}
}

func TestTranscriptScrollsWithPageKeys(t *testing.T) {
	h := newHarness(t, nil)
	for i := 1; i <= 100; i++ {
		h.m.print(fmt.Sprintf("línea %03d", i))
	}
	rig := startScreen(t, h, 100, 30)
	rig.waitFor("línea 100")
	if rig.count("línea 001") != 0 {
		t.Fatalf("lo antiguo no cabe en pantalla%s", rig.dump())
	}
	for i := 0; i < 6; i++ {
		rig.type_("\x1b[5~")
	}
	if rig.rowOf("línea 100") >= 0 || rig.rowOf("línea 001") < 0 && rig.rowOf("línea 04") < 0 {
		t.Fatalf("RePág debe subir por el transcript%s", rig.dump())
	}
	rig.type_("hola")
	rig.type_("\x7f\x7f\x7f\x7f")
	for i := 0; i < 6; i++ {
		rig.type_("\x1b[6~")
	}
	rig.waitFor("línea 100")
}
