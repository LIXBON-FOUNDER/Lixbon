package tui

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"
)

// Tamaños del prisma en píxeles: 32 para el login y 24 para la tarjeta de
// bienvenida. Con medios bloques ocupan size columnas por size/2 filas.
const (
	logoSize     = 32
	cardLogoSize = 24
)

type rgb [3]float64

func hexRGB(h string) rgb {
	h = strings.TrimPrefix(h, "#")
	var c rgb
	for i := range c {
		v, _ := strconv.ParseUint(h[i*2:i*2+2], 16, 8)
		c[i] = float64(v)
	}
	return c
}

func (c rgb) hex() string {
	b := func(v float64) int { return int(math.Max(0, math.Min(255, math.Round(v)))) }
	return fmt.Sprintf("#%02X%02X%02X", b(c[0]), b(c[1]), b(c[2]))
}

func (c rgb) mix(o rgb, t float64) rgb {
	return rgb{c[0] + (o[0]-c[0])*t, c[1] + (o[1]-c[1])*t, c[2] + (o[2]-c[2])*t}
}

// logoSample es el color del prisma en el punto (u, v) del cuadrado unidad,
// o false fuera de él: cuatro caras con más luz arriba a la izquierda, un
// filo de luz arriba y sombra abajo, costuras entre caras, el destello de
// cuatro puntas con su halo y el punto en la señal.
func logoSample(u, v float64, bg, ink, shade, sig rgb, faces [4]rgb) (rgb, bool) {
	const r, cx, cy = 0.43, 0.5, 0.5
	spkX, spkY, sr := cx+0.105, cy+0.095, 0.13
	satX, satY, satR := cx+0.29, cy+0.27, 0.042
	ds := math.Hypot(u-satX, v-satY)
	if ds <= satR {
		return sig, true
	}
	dx, dy := u-cx, v-cy
	d := math.Abs(dx) + math.Abs(dy)
	if d > r {
		if ds <= satR*2 {
			return bg.mix(sig, 0.22), true
		}
		return rgb{}, false
	}
	star := math.Sqrt(math.Abs(u-spkX)/sr) + math.Sqrt(math.Abs(v-spkY)/sr)
	if star <= 1 {
		return ink, true
	}
	f := 0
	switch {
	case dy < 0 && dx >= 0:
		f = 1
	case dy >= 0 && dx < 0:
		f = 2
	case dy >= 0:
		f = 3
	}
	if math.Min(math.Abs(dx), math.Abs(dy)) < 0.012 {
		return faces[f].mix(bg, 0.75), true
	}
	col := faces[f]
	if g := -(dx + dy) / (2 * r); g > 0 {
		col = col.mix(ink, g*0.35)
	} else {
		col = col.mix(shade, -g*0.45)
	}
	if r-d < 0.03 {
		if f < 2 {
			col = col.mix(ink, 0.35)
		} else {
			col = col.mix(shade, 0.4)
		}
	}
	if star < 2.2 {
		col = col.mix(ink, (2.2-star)/1.2*0.3)
	}
	return col, true
}

// logoGrid supermuestrea el prisma en size×size píxeles (16 muestras por
// píxel) con los colores del tema; "" es un píxel vacío.
func logoGrid(size int) [][]string {
	bg, ink, shade, sig := hexRGB(pal.bg), hexRGB(pal.spark), hexRGB(pal.dot), hexRGB(pal.acc)
	faces := [4]rgb{hexRGB(pal.f1), hexRGB(pal.f2), hexRGB(pal.f3), hexRGB(pal.f4)}
	const ss = 4
	grid := make([][]string, size)
	for y := range size {
		grid[y] = make([]string, size)
		for x := range size {
			var acc rgb
			hit := 0
			for j := range ss {
				for i := range ss {
					u := (float64(x) + (float64(i)+0.5)/ss) / float64(size)
					v := (float64(y) + (float64(j)+0.5)/ss) / float64(size)
					if c, ok := logoSample(u, v, bg, ink, shade, sig, faces); ok {
						acc = rgb{acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]}
						hit++
					}
				}
			}
			cov := float64(hit) / ss / ss
			if cov < 0.12 {
				continue
			}
			mean := rgb{acc[0] / float64(hit), acc[1] / float64(hit), acc[2] / float64(hit)}
			grid[y][x] = bg.mix(mean, cov).hex()
		}
	}
	return grid
}

var logoCache = map[[2]int][]string{}

// renderLogo dibuja el prisma con medios bloques: cada celda lleva dos
// píxeles. Sin medios bloques (ASCII) no hay logo.
func renderLogo(size int) []string {
	if !glyphs.halfBlocks {
		return nil
	}
	key := [2]int{size, themeVersion}
	if rows, ok := logoCache[key]; ok {
		return rows
	}
	grid := logoGrid(size)
	var rows []string
	for r := 0; r < size; r += 2 {
		var b strings.Builder
		for c := 0; c < size; c++ {
			top, bottom := grid[r][c], grid[r+1][c]
			switch {
			case top == "" && bottom == "":
				b.WriteString(" ")
			case bottom == "":
				b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(top)).Render("▀"))
			case top == "":
				b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(bottom)).Render("▄"))
			default:
				b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(top)).Background(lipgloss.Color(bottom)).Render("▀"))
			}
		}
		rows = append(rows, b.String())
	}
	logoCache[key] = rows
	return rows
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
