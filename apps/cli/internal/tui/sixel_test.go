package tui

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	uv "github.com/charmbracelet/ultraviolet"
	"github.com/charmbracelet/x/ansi"
)

// sixelHarness es una sesión con una terminal que admite Sixel: lo que se
// escribe en ella queda en un archivo.
func sixelHarness(t *testing.T) (*harness, *os.File) {
	t.Helper()
	withImages(t)
	h := newHarness(t, nil, toolReply("t1", "show_image", map[string]any{"path": "dados.png"}), textReply("Ahí está."))
	writePNG(t, h.root, "dados.png", 40, 20)
	f, err := os.Create(filepath.Join(t.TempDir(), "tty"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	h.m.gfx = &graphics{out: &gfxOut{File: f}}
	h.update(uv.CellSizeEvent{Width: 10, Height: 20})
	h.update(uv.PrimaryDeviceAttributesEvent{62, 4, 22})
	return h, f
}

func written(t *testing.T, f *os.File) string {
	t.Helper()
	b, err := os.ReadFile(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Con la pantalla quieta, la imagen se escribe en Sixel justo encima de su
// miniatura, del tamaño de sus celdas.
func TestSixelDrawsOverTheThumbnail(t *testing.T) {
	h, f := sixelHarness(t)
	h.send("enséñame dados.png")
	h.settle()

	lines := strings.Split(h.m.View().Content, "\n")
	want := h.m.gfx.want
	if len(want) != 1 {
		t.Fatalf("miniaturas enteras en pantalla: %d", len(want))
	}
	p := want[0]
	if !strings.Contains(lines[p.y], "▀") || ansi.StringWidth(lines[p.y]) != p.x+p.cols {
		t.Fatalf("la miniatura no está en %d,%d: %q", p.x, p.y, ansi.Strip(lines[p.y]))
	}
	h.pump(func() bool { return strings.Contains(written(t, f), "\x1bP") })
	out := written(t, f)
	if !strings.HasPrefix(out, ansi.SaveCursor+ansi.CursorPosition(p.x+1, p.y+1)+"\x1bP0;1q\"1;1;"+strconv.Itoa(p.cols*10)+";"+strconv.Itoa(p.rows*20)) || !strings.HasSuffix(out, ansi.RestoreCursor) {
		t.Fatalf("Sixel: %q…", out[:min(80, len(out))])
	}

	// Pintada una vez, la misma pantalla no la vuelve a escribir.
	h.m.View()
	time.Sleep(2 * imageSettle)
	h.pump(func() bool { return len(h.msgs) == 0 })
	if strings.Count(written(t, f), "\x1bP") != 1 {
		t.Fatal("la imagen se escribió dos veces")
	}
}

// Si la imagen pintada se mueve, la pantalla se borra (el renderer no sabe de
// sus píxeles) y se vuelve a pintar en su sitio nuevo.
func TestSixelMovesWithTheTranscript(t *testing.T) {
	h, f := sixelHarness(t)
	h.send("enséñame dados.png")
	h.settle()
	h.m.View()
	h.pump(func() bool { return strings.Contains(written(t, f), "\x1bP") })
	before := h.m.gfx.want[0]

	var cleared bool
	// Más estrecha: la miniatura encoge y el texto de encima se reenvuelve.
	h.update(tea.WindowSizeMsg{Width: 40, Height: 30})
	h.m.View()
	deadline := time.After(3 * time.Second)
	for !cleared {
		select {
		case msg := <-h.msgs:
			if _, ok := msg.(clearImagesMsg); ok {
				cleared = true
				// Lo que hace Bubble Tea con tea.ClearScreen: borrar la pantalla.
				h.m.gfx.out.Write([]byte(ansi.EraseEntireScreen))
			}
			h.update(msg)
		case <-deadline:
			t.Fatal("la imagen se movió y la pantalla no se borró")
		}
	}
	after := h.m.gfx.want[0]
	if after == before {
		t.Fatalf("la imagen no cambió: %+v", after)
	}
	h.pump(func() bool { return strings.Count(written(t, f), "\x1bP") == 2 })
	if !strings.Contains(written(t, f), ansi.CursorPosition(after.x+1, after.y+1)+"\x1bP") {
		t.Fatal("la imagen no se pintó en su sitio nuevo")
	}
}

// Sin Sixel (o tapada por un panel) solo queda la miniatura.
func TestNoSixelWithoutSupport(t *testing.T) {
	g := &graphics{out: &gfxOut{}}
	g.onDeviceAttributes([]int{62, 22})
	if g.sixel {
		t.Fatal("sin el 4 de DA1 no hay Sixel")
	}
	t.Setenv("WT_SESSION", "")
	g.onDeviceAttributes([]int{62, 4})
	if g.sixel {
		t.Fatal("sin tamaño de celda solo se fía de Windows Terminal")
	}
	t.Setenv("WT_SESSION", "x")
	g.onDeviceAttributes([]int{62, 4})
	if !g.sixel || g.cellW != 10 || g.cellH != 20 {
		t.Fatalf("Windows Terminal: %+v", g)
	}

	withImages(t)
	th := newThumb(writePNG(t, t.TempDir(), "a.png", 40, 20))
	lines := th.lines(20, 5)
	screen := []string{"cabecera"}
	for _, l := range lines {
		screen = append(screen, "  "+l)
	}
	if got := findPlacements(screen); len(got) != 1 || got[0].x != 2 || got[0].y != 1 {
		t.Fatalf("entera: %+v", got)
	}
	screen[2] = "  panel encima"
	if got := findPlacements(screen); len(got) != 0 {
		t.Fatal("una miniatura tapada no lleva imagen")
	}
	if got := findPlacements(screen[:3]); len(got) != 0 {
		t.Fatal("una miniatura cortada no lleva imagen")
	}
}
