package tui

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

// writePNG deja en dir una imagen de w×h: rojo arriba y azul abajo.
func writePNG(t *testing.T, dir, name string, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			c := color.RGBA{255, 0, 0, 255}
			if y >= h/2 {
				c = color.RGBA{0, 0, 255, 255}
			}
			img.Set(x, y, c)
		}
	}
	path := filepath.Join(dir, name)
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	return path
}

// withImages deja la terminal en condiciones de pintar miniaturas: otras
// pruebas arrancan programas sin TTY que las apagan.
func withImages(t *testing.T) {
	t.Helper()
	prevDraw, prevGlyphs := drawImages, glyphs
	drawImages = true
	applyGlyphs(richGlyphs)
	t.Cleanup(func() {
		drawImages = prevDraw
		applyGlyphs(prevGlyphs)
	})
}

// Cada celda son dos píxeles: el de arriba es la tinta de ▀ y el de abajo,
// su fondo.
func TestThumbUsesHalfBlocks(t *testing.T) {
	withImages(t)
	path := writePNG(t, t.TempDir(), "a.png", 2, 2)
	lines := newThumb(path).lines(10, 10)
	if len(lines) != 1 || !strings.Contains(lines[0], "38;2;255;0;0") || !strings.Contains(lines[0], "48;2;0;0;255") {
		t.Fatalf("miniatura: %q", lines)
	}
	if ansi.StringWidth(lines[0]) != 2 {
		t.Fatalf("ancho: %d", ansi.StringWidth(lines[0]))
	}
	// Una imagen ancha cabe en el ancho pedido y conserva la proporción.
	wide := newThumb(writePNG(t, t.TempDir(), "b.png", 400, 100)).lines(40, 10)
	if len(wide) != 5 || ansi.StringWidth(wide[0]) != 40 {
		t.Fatalf("proporción: %d filas de %d", len(wide), ansi.StringWidth(wide[0]))
	}
}

func TestThumbIsOffWithoutColorOrReadableImage(t *testing.T) {
	withImages(t)
	path := writePNG(t, t.TempDir(), "a.png", 4, 4)
	drawImages = false
	if lines := newThumb(path).lines(10, 10); lines != nil {
		t.Fatal("sin 256 colores no hay miniatura")
	}
	drawImages = true
	bad := filepath.Join(t.TempDir(), "x.webp")
	os.WriteFile(bad, []byte("RIFF....WEBP"), 0o644)
	if lines := newThumb(bad).lines(10, 10); lines != nil {
		t.Fatal("lo que no se puede leer queda como su fila")
	}
}

// El agente enseña una imagen: la fila «Mostrar» lleva su miniatura y sus
// medidas, un clic la abre y con /remote llega al móvil subida al gateway.
func TestShowImageInTheTerminalAndOnThePhone(t *testing.T) {
	withImages(t)
	h, relay := agentRemote(t,
		toolReply("t1", "show_image", map[string]any{"path": "captura.png", "caption": "La portada"}),
		textReply("Ahí la tienes."))
	writePNG(t, h.root, "captura.png", 64, 32)
	relay.push(prompt("enséñamela"))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })
	h.settle()

	out := h.out()
	plain := ansi.Strip(out)
	contains(t, plain, "Mostrar")
	contains(t, plain, "64×32")
	contains(t, plain, "La portada")
	contains(t, plain, "clic la abre")
	if !strings.Contains(out, "▀") {
		t.Fatal("falta la miniatura")
	}
	shown := relay.find("image_shown")
	id, _ := shown["id"].(string)
	if shown == nil || !strings.HasSuffix(id, ".png") || shown["name"] != "captura.png" || shown["caption"] != "La portada" {
		t.Fatalf("image_shown: %v", shown)
	}
	h.waitFor("subida", func() bool {
		relay.mu.Lock()
		defer relay.mu.Unlock()
		return relay.images[id] == "image/png"
	})

	var opened string
	openImage = func(p string) error { opened = p; return nil }
	defer func() { openImage = nil }()
	for _, e := range h.m.log.entries {
		if b, ok := e.b.(*toolBlock); ok && b.image != nil {
			if got := b.imageAt(1, 80); filepath.Base(got) != "captura.png" {
				t.Fatalf("imageAt: %q", got)
			}
			openImage(b.imageAt(1, 80))
		}
	}
	if opened == "" {
		t.Fatal("la fila Mostrar debe abrir la imagen")
	}
	h.m.remote.link.Stop(true)
}

// Las imágenes que manda el usuario se ven bajo su mensaje.
func TestUserImagesShowAsThumbnails(t *testing.T) {
	withImages(t)
	path := writePNG(t, t.TempDir(), "boton.png", 40, 20)
	b := userBlock{text: "¿por qué es naranja? [IMG#1]", chips: []imageChip{newImageChip(1, path)}}
	out := b.render(80, false)
	if !strings.Contains(out, "▀") || !strings.Contains(ansi.Strip(out), "boton.png") {
		t.Fatalf("mensaje: %q", ansi.Strip(out))
	}
	bubble := strings.Count(b.bubble(80), "\n") + 1
	if b.imageAt(bubble, 80) != path || b.imageAt(0, 80) != "" {
		t.Fatal("un clic en la miniatura abre la imagen; en el texto no")
	}
}
