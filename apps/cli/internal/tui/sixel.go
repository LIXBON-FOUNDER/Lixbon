package tui

import (
	"bytes"
	"image"
	"image/color"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/ansi/sixel"
	"golang.org/x/image/draw"
)

// Sixel: en las terminales que lo admiten (Windows Terminal 1.22+, WezTerm,
// foot, xterm…) cada miniatura que se ve entera recibe encima la imagen con
// sus píxeles. La miniatura de medios bloques sigue debajo: es lo que se ve
// mientras el transcript se mueve y en las terminales sin Sixel.
//
// Bubble Tea no sabe de imágenes, así que la imagen va aparte: View busca en
// la pantalla las miniaturas enteras y, cuando la pantalla lleva un rato
// quieta, gfxOut escribe cada imagen sobre su miniatura entre dos fotogramas.
// Si una imagen ya pintada se mueve o se tapa, la pantalla se borra entera
// (el renderer no sabe que hay píxeles encima de sus celdas) y se repinta.

// imageSettle es lo que la pantalla tiene que estar quieta para pintar las
// imágenes: al hacer scroll se ve la miniatura y luego la imagen.
const imageSettle = 150 * time.Millisecond

// placement es una miniatura entera en pantalla: x, y en celdas.
type placement struct {
	t          *thumb
	cols, rows int
	x, y       int
}

// graphics es el estado de las imágenes de la sesión. nil sin terminal.
type graphics struct {
	out          *gfxOut
	sixel        bool
	cellW, cellH int
	want         []placement
	gen          int64
}

func (g *graphics) ready() bool {
	return g != nil && g.sixel && g.cellW > 0 && g.cellH > 0 && canDrawImages()
}

// queryGraphics pregunta a la terminal el tamaño de la celda en píxeles y sus
// capacidades (el 4 de DA1 es Sixel). DA1 va última: las terminales contestan
// en orden, así que con su respuesta ya llegó la del tamaño, si la hay.
func queryGraphics() tea.Cmd {
	return tea.Raw("\x1b[16t" + ansi.RequestPrimaryDeviceAttributes)
}

// onDeviceAttributes activa Sixel si la terminal lo admite. Sin respuesta al
// tamaño de celda solo se fía de Windows Terminal, que pinta Sixel en celdas
// virtuales de 10×20 píxeles.
func (g *graphics) onDeviceAttributes(attrs []int) {
	if g == nil || !slices.Contains(attrs, 4) {
		return
	}
	if g.cellW == 0 || g.cellH == 0 {
		if os.Getenv("WT_SESSION") == "" {
			return
		}
		g.cellW, g.cellH = 10, 20
	}
	g.sixel = true
}

type clearImagesMsg struct{}

type settleImagesMsg struct{ gen int64 }

// placeImages mira qué miniaturas se ven enteras en screen y, si cambiaron,
// programa el repintado de sus imágenes.
func (m *Model) placeImages(screen []string) {
	g := m.gfx
	if !g.ready() || m.send == nil {
		return
	}
	want := findPlacements(screen)
	if slices.Equal(want, g.want) {
		return
	}
	g.want = want
	g.gen++
	gen, send := g.gen, m.send
	g.out.gen.Store(gen)
	stale := g.out.stale(want)
	go func() {
		if stale {
			send(clearImagesMsg{})
		}
		time.Sleep(imageSettle)
		send(settleImagesMsg{gen})
	}()
}

// settleImages pinta las imágenes si la pantalla sigue como cuando se
// pidieron.
func (m *Model) settleImages(gen int64) tea.Cmd {
	g := m.gfx
	if !g.ready() || gen != g.gen || len(g.want) == 0 {
		return nil
	}
	want, out, cw, ch := slices.Clone(g.want), g.out, g.cellW, g.cellH
	return func() tea.Msg {
		out.draw(gen, want, cw, ch)
		return nil
	}
}

// findPlacements busca las miniaturas que se ven enteras: la fila que acaba
// en la primera línea de una miniatura y las siguientes en las demás.
func findPlacements(screen []string) []placement {
	var out []placement
	for y := 0; y < len(screen); y++ {
		row := screen[y]
		if !strings.Contains(row, "▀") {
			continue
		}
		if p, ok := placementAt(screen, y); ok {
			out = append(out, p)
			y += p.rows - 1
		}
	}
	return out
}

func placementAt(screen []string, y int) (placement, bool) {
	row := screen[y]
	from := 0
	for range 4 {
		i := strings.Index(row[from:], "\x1b[38;2;")
		if i < 0 {
			break
		}
		i += from
		for _, ref := range thumbIndex.lookup(row[i:]) {
			lines := ref.t.cached(ref.key)
			if len(lines) == 0 || y+len(lines) > len(screen) {
				continue
			}
			whole := true
			for k := 1; k < len(lines) && whole; k++ {
				next := screen[y+k]
				whole = len(next) == i+len(lines[k]) && next[i:] == lines[k]
			}
			if whole {
				return placement{t: ref.t, cols: ref.key[0], rows: ref.key[1], x: ansi.StringWidth(row[:i]), y: y}, true
			}
		}
		from = i + 1
	}
	return placement{}, false
}

// thumbRef es una miniatura ya pintada a un tamaño.
type thumbRef struct {
	t   *thumb
	key [2]int
}

// thumbIndex encuentra una miniatura por su primera línea.
var thumbIndex = &thumbLines{byFirst: map[string][]thumbRef{}}

type thumbLines struct {
	mu      sync.Mutex
	byFirst map[string][]thumbRef
}

func (x *thumbLines) add(first string, ref thumbRef) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.byFirst[first] = append(x.byFirst[first], ref)
}

func (x *thumbLines) lookup(first string) []thumbRef {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.byFirst[first]
}

// gfxOut es la salida de la terminal: deja pasar los fotogramas y, entre
// ellos, escribe las imágenes. Embebe el *os.File para que Bubble Tea la
// trate como la terminal que es.
type gfxOut struct {
	*os.File
	mu    sync.Mutex
	drawn []placement
	gen   atomic.Int64
}

func (o *gfxOut) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	// Al borrar la pantalla se van también las imágenes.
	if bytes.Contains(p, []byte(ansi.EraseEntireScreen)) {
		o.drawn = nil
	}
	return o.File.Write(p)
}

// stale dice si alguna imagen pintada ya no está donde estaba.
func (o *gfxOut) stale(want []placement) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, p := range o.drawn {
		if !slices.Contains(want, p) {
			return true
		}
	}
	return false
}

// draw pinta las imágenes de want que faltan, si la pantalla no cambió
// mientras se codificaban.
func (o *gfxOut) draw(gen int64, want []placement, cellW, cellH int) {
	o.mu.Lock()
	var todo []placement
	for _, p := range want {
		if !slices.Contains(o.drawn, p) {
			todo = append(todo, p)
		}
	}
	o.mu.Unlock()
	if len(todo) == 0 {
		return
	}
	data := make([]string, len(todo))
	for i, p := range todo {
		data[i] = p.t.sixel(p.cols*cellW, p.rows*cellH)
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.gen.Load() != gen {
		return
	}
	var b strings.Builder
	b.WriteString(ansi.SaveCursor)
	for i, p := range todo {
		if data[i] == "" || slices.Contains(o.drawn, p) {
			continue
		}
		b.WriteString(ansi.CursorPosition(p.x+1, p.y+1))
		b.WriteString(data[i])
		o.drawn = append(o.drawn, p)
	}
	b.WriteString(ansi.RestoreCursor)
	o.File.WriteString(b.String()) //nolint:errcheck
}

// sixel es la imagen en w×h píxeles, ya en su secuencia Sixel.
func (t *thumb) sixel(w, h int) string {
	img := t.load()
	if img == nil || w <= 0 || h <= 0 {
		return ""
	}
	key := [2]int{w, h}
	t.mu.Lock()
	s, ok := t.sixels[key]
	t.mu.Unlock()
	if ok {
		return s
	}
	bg := parseHex(pal.bg)
	px := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(px, px.Bounds(), image.NewUniform(color.RGBA{uint8(bg[0] >> 8), uint8(bg[1] >> 8), uint8(bg[2] >> 8), 0xff}), image.Point{}, draw.Src)
	draw.CatmullRom.Scale(px, px.Bounds(), img, img.Bounds(), draw.Over, nil)
	var buf bytes.Buffer
	if err := (&sixel.Encoder{}).Encode(&buf, px); err != nil {
		return ""
	}
	s = ansi.SixelGraphics(0, 1, 0, buf.Bytes())
	t.mu.Lock()
	if t.sixels == nil {
		t.sixels = map[[2]int]string{}
	}
	t.sixels[key] = s
	t.mu.Unlock()
	return s
}
