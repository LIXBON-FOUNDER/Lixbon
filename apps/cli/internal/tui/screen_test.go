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

// promptRow es la fila de la caja de entrada: la última que empieza por la
// señal ›, ya que la caja va abajo; -1 si no hay caja.
func promptRow(lines []string) int {
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.HasPrefix(lines[i], "  "+glyphPrompt+" ") {
			return i
		}
	}
	return -1
}

// prompts cuenta las filas que parecen una caja de entrada: empiezan por la
// señal y no tienen columnas (la fila elegida de un menú sí las tiene).
func prompts(lines []string) int {
	n := 0
	for _, l := range lines {
		if strings.HasPrefix(l, "  "+glyphPrompt+" ") && !strings.Contains(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(l), "? atajos")), "  ") {
			n++
		}
	}
	return n
}

func TestInputBarStaysPinnedAndNeverDuplicates(t *testing.T) {
	h := newHarness(t, func(c *configT) { c.Model = "" })
	rig := startScreen(t, h, 100, 30)
	rig.waitFor("carpeta  ")
	rig.waitFor("sin modelo")

	status := rig.rowOf("contexto  ")
	box := promptRow(rig.lines())
	if status != rig.rows-1 || box != rig.rows-4 {
		t.Fatalf("la barra debe ir en las últimas filas: caja=%d estado=%d%s", box, status, rig.dump())
	}

	for _, step := range []string{"/", "c", "l", "\x7f", "\x7f", "\x7f", "/", "c", "o", "\x7f", "\x7f", "\x7f"} {
		rig.type_(step)
		if got := prompts(rig.lines()); got != 1 {
			t.Fatalf("tras %q hay %d cajas de entrada%s", step, got, rig.dump())
		}
		if promptRow(rig.lines()) != box || rig.rowOf("contexto  ") != status {
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
	rig.waitFor("carpeta  ")
	if row := rig.rowOf("carpeta  "); row < 1 || row > 10 {
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

func TestLogoAndHeaderShowTheWorkspaceFolder(t *testing.T) {
	h := newHarness(t, nil)
	rig := startScreen(t, h, 100, 30)
	rig.waitFor("carpeta  ")
	if !strings.Contains(rig.screen(), shortPath(h.chat.Workspace)) {
		t.Fatalf("la cabecera muestra la carpeta de trabajo%s", rig.dump())
	}
}

func TestClearKeepsTheHeaderAndDropsTheConversation(t *testing.T) {
	h := newHarness(t, nil, textReply("respuesta vieja"))
	rig := startScreen(t, h, 100, 30)
	rig.waitFor("carpeta  ")
	rig.type_("mensaje viejo\r")
	rig.waitFor("respuesta vieja")
	rig.waitGone("esc para")

	rig.type_("/clear\r")
	rig.waitFor("contexto limpio")
	screen := rig.screen()
	if strings.Contains(screen, "respuesta vieja") || strings.Contains(screen, "mensaje viejo") {
		t.Fatalf("/clear debe borrar la conversación de la pantalla%s", rig.dump())
	}
	for _, want := range []string{"carpeta  ", shortPath(h.chat.Workspace)} {
		if !strings.Contains(screen, want) {
			t.Fatalf("tras /clear debe seguir viéndose %q%s", want, rig.dump())
		}
	}
	if !strings.ContainsAny(screen, "▀▄") {
		t.Fatalf("tras /clear debe seguir el logo%s", rig.dump())
	}
	if promptRow(rig.lines()) != rig.rows-4 {
		t.Fatalf("la caja debe seguir fija abajo%s", rig.dump())
	}
}

func TestCtrlTShowsTheTranscriptViewer(t *testing.T) {
	h := newHarness(t, nil)
	for i := 1; i <= 100; i++ {
		h.m.print(fmt.Sprintf("línea %03d", i))
	}
	rig := startScreen(t, h, 100, 30)
	rig.waitFor("línea 100")

	rig.type_("\x14")
	rig.waitFor("Ctrl+T cierran")
	if prompts(rig.lines()) != 0 {
		t.Fatalf("el visor ocupa toda la pantalla%s", rig.dump())
	}
	rig.type_("\x1b[5~")
	if rig.rowOf("línea 100") >= 0 {
		t.Fatalf("RePág debe subir por el transcript%s", rig.dump())
	}
	rig.type_("g")
	rig.waitFor("línea 001")
	rig.type_("G")
	rig.waitFor("línea 100")
	rig.type_("q")
	rig.waitGone("Ctrl+T cierran")
	rig.until("la caja vuelve", func() bool { return promptRow(rig.lines()) >= 0 })
}

func TestWheelScrollsWithoutAnyCommand(t *testing.T) {
	h := newHarness(t, nil)
	for i := 1; i <= 100; i++ {
		h.m.print(fmt.Sprintf("línea %03d", i))
	}
	rig := startScreen(t, h, 100, 30)
	rig.waitFor("línea 100")
	for i := 0; i < 10; i++ {
		rig.type_("\x1b[<64;10;5M")
	}
	if rig.rowOf("línea 100") >= 0 {
		t.Fatalf("la rueda debe subir por el transcript%s", rig.dump())
	}
	for i := 0; i < 20; i++ {
		rig.type_("\x1b[<65;10;5M")
	}
	rig.waitFor("línea 100")
}

func TestDraggingSelectsAndCopiesTranscriptText(t *testing.T) {
	h := newHarness(t, nil)
	h.m.print("alfa beta gamma")
	h.m.print("segunda fila")
	rig := startScreen(t, h, 100, 30)
	rig.waitFor("segunda fila")
	row := rig.rowOf("alfa beta gamma")

	rig.type_(fmt.Sprintf("\x1b[<0;%d;%dM", 6, row+1))
	rig.type_(fmt.Sprintf("\x1b[<32;%d;%dM", 9, row+1))
	rig.type_(fmt.Sprintf("\x1b[<0;%d;%dm", 9, row+1))
	rig.waitFor("4 caracteres copiados")
	waitFor(t, "texto en el portapapeles", func() bool {
		h.mu.Lock()
		defer h.mu.Unlock()
		return len(h.copied) == 1 && h.copied[0] == "beta"
	})
}
