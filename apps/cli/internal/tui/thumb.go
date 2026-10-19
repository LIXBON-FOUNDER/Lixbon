package tui

import (
	"fmt"
	"image"
	"image/color"
	_ "image/gif" // las miniaturas leen GIF, JPEG y PNG
	_ "image/jpeg"
	_ "image/png"
	"os"
	"strings"
	"sync"

	"github.com/charmbracelet/colorprofile"

	"lixbon.com/cli/internal/weblogin"
)

// drawImages dice si la terminal puede pintar miniaturas: hace falta color de
// 256 o de 24 bits (ColorProfileMsg) y los medios bloques del juego de
// glifos. Sin eso, una imagen es solo su fila con el nombre.
var drawImages = true

func setColorProfile(p colorprofile.Profile) {
	drawImages = p == colorprofile.TrueColor || p == colorprofile.ANSI256
}

func canDrawImages() bool { return drawImages && glyphs.halfBlocks }

// openImage abre la imagen entera en el visor del sistema. Las pruebas lo
// cambian para no abrir nada.
var openImage = weblogin.OpenBrowser

// thumb pinta una imagen con medios bloques: cada celda son dos píxeles, el
// de arriba en la tinta de ▀ y el de abajo en su fondo. La imagen se lee una
// vez y cada tamaño pedido se guarda ya pintado.
type thumb struct {
	path string

	once sync.Once
	img  image.Image

	mu    sync.Mutex
	cache map[[2]int][]string
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
// la terminal no puede pintarla o la imagen no se puede leer (WebP, BMP…).
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
	return out
}

func halfBlocks(img image.Image, cols, rows int) []string {
	b := img.Bounds()
	bg := parseHex(pal.bg)
	sample := func(x, y int) [3]uint32 {
		// Media de la caja de píxeles que cae en (x, y) de la rejilla.
		x0 := b.Min.X + x*b.Dx()/cols
		x1 := max(x0+1, b.Min.X+(x+1)*b.Dx()/cols)
		y0 := b.Min.Y + y*b.Dy()/(rows*2)
		y1 := max(y0+1, b.Min.Y+(y+1)*b.Dy()/(rows*2))
		step := max(1, (x1-x0)*(y1-y0)/64)
		var r, g, bl, n uint32
		i := 0
		for py := y0; py < y1; py++ {
			for px := x0; px < x1; px++ {
				if i++; i%step != 0 {
					continue
				}
				cr, cg, cb, ca := img.At(px, py).RGBA()
				// Lo transparente se ve sobre el fondo de la terminal.
				r += (cr + bg[0]*(0xffff-ca)/0xffff) >> 8
				g += (cg + bg[1]*(0xffff-ca)/0xffff) >> 8
				bl += (cb + bg[2]*(0xffff-ca)/0xffff) >> 8
				n++
			}
		}
		if n == 0 {
			return [3]uint32{bg[0] >> 8, bg[1] >> 8, bg[2] >> 8}
		}
		return [3]uint32{r / n, g / n, bl / n}
	}
	out := make([]string, rows)
	for y := range rows {
		var sb strings.Builder
		for x := range cols {
			top, bottom := sample(x, 2*y), sample(x, 2*y+1)
			fmt.Fprintf(&sb, "\x1b[38;2;%d;%d;%dm\x1b[48;2;%d;%d;%dm▀", top[0], top[1], top[2], bottom[0], bottom[1], bottom[2])
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
