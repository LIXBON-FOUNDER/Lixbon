package tui

import (
	"fmt"
	"image"
	"image/color"
	_ "image/gif" // las miniaturas leen GIF, JPEG, PNG y WebP
	_ "image/jpeg"
	_ "image/png"
	"os"
	"strings"
	"sync"

	"github.com/charmbracelet/colorprofile"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// drawImages dice si la terminal puede pintar miniaturas: hace falta color de
// 256 o de 24 bits (ColorProfileMsg) y los medios bloques del juego de
// glifos. Sin eso, una imagen es solo su fila con el nombre.
var drawImages = true

func setColorProfile(p colorprofile.Profile) {
	drawImages = p == colorprofile.TrueColor || p == colorprofile.ANSI256
}

func canDrawImages() bool { return drawImages && glyphs.halfBlocks }

// openImage abre la imagen entera en el navegador (viewer.go). Las pruebas lo
// cambian para no abrir nada.
var openImage = openInViewer

// thumb pinta una imagen con medios bloques: cada celda son dos píxeles, el
// de arriba en la tinta de ▀ y el de abajo en su fondo. La imagen se lee una
// vez y cada tamaño pedido se guarda ya pintado.
type thumb struct {
	path string

	once sync.Once
	img  image.Image

	mu     sync.Mutex
	cache  map[[2]int][]string
	sixels map[[2]int]string // por tamaño en píxeles (sixel.go)
}

// cached devuelve la miniatura ya pintada a ese tamaño de celdas, o nil.
func (t *thumb) cached(key [2]int) []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cache[key]
}

func newThumb(path string) *thumb {
	if path == "" {
		return nil
	}
	return &thumb{path: path}
}

func (t *thumb) load() image.Image {
	t.once.Do(func() {
		f, err := os.Open(t.path)
		if err != nil {
			return
		}
		defer f.Close()
		if img, _, err := image.Decode(f); err == nil {
			t.img = img
		}
	})
	return t.img
}

// lines devuelve la miniatura en a lo sumo maxCols×maxRows celdas, o nada si
// la terminal no puede pintarla o la imagen no se puede leer (BMP, SVG…).
func (t *thumb) lines(maxCols, maxRows int) []string {
	if t == nil || !canDrawImages() || maxCols < 4 || maxRows < 1 {
		return nil
	}
	img := t.load()
	if img == nil {
		return nil
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w == 0 || h == 0 {
		return nil
	}
	// Los píxeles de medio bloque son casi cuadrados: una celda es el doble
	// de alta que de ancha.
	cols := min(maxCols, w)
	rows := (cols*h/w + 1) / 2
	if rows > maxRows {
		rows = maxRows
		cols = max(1, min(maxCols, rows*2*w/h))
	}
	rows = max(1, rows)
	key := [2]int{cols, rows}
	t.mu.Lock()
	defer t.mu.Unlock()
	if out, ok := t.cache[key]; ok {
		return out
	}
	out := halfBlocks(img, cols, rows)
	if t.cache == nil {
		t.cache = map[[2]int][]string{}
	}
	t.cache[key] = out
	thumbIndex.add(out[0], thumbRef{t, key})
	return out
}

func halfBlocks(img image.Image, cols, rows int) []string {
	// Se reduce con Catmull-Rom sobre el fondo de la terminal (lo transparente
	// se ve sobre él): con muestras sueltas la miniatura salía con ruido.
	bg := parseHex(pal.bg)
	px := image.NewRGBA(image.Rect(0, 0, cols, rows*2))
	draw.Draw(px, px.Bounds(), image.NewUniform(color.RGBA{uint8(bg[0] >> 8), uint8(bg[1] >> 8), uint8(bg[2] >> 8), 0xff}), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(px, px.Bounds(), img, img.Bounds(), draw.Over, nil)
	out := make([]string, rows)
	for y := range rows {
		var sb strings.Builder
		for x := range cols {
			top, bottom := px.RGBAAt(x, 2*y), px.RGBAAt(x, 2*y+1)
			fmt.Fprintf(&sb, "\x1b[38;2;%d;%d;%dm\x1b[48;2;%d;%d;%dm▀", top.R, top.G, top.B, bottom.R, bottom.G, bottom.B)
		}
		sb.WriteString("\x1b[0m")
		out[y] = sb.String()
	}
	return out
}

// parseHex convierte #RRGGBB a componentes de 16 bits, como color.RGBA().
func parseHex(hex string) [3]uint32 {
	var c color.RGBA
	if _, err := fmt.Sscanf(strings.TrimPrefix(hex, "#"), "%02x%02x%02x", &c.R, &c.G, &c.B); err != nil {
		return [3]uint32{0, 0, 0}
	}
	return [3]uint32{uint32(c.R) * 0x101, uint32(c.G) * 0x101, uint32(c.B) * 0x101}
}

// imageBlock es un bloque con imágenes: devuelve la que pinta en la fila row
// (contada desde su primera fila), para que un clic la abra.
type imageBlock interface {
	imageAt(row, width int) string
}
