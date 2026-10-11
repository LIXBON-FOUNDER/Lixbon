package tui

import (
	"math"
	"strings"

	"charm.land/lipgloss/v2"
)

// Tamaños del prisma en píxeles: 16 para el login y 12 para la tarjeta de
// bienvenida. Con medios bloques ocupan size columnas por size/2 filas.
const (
	logoSize     = 16
	cardLogoSize = 12
)

// logoPixel evalúa el isotipo en una rejilla de size×size: un rombo en cuatro
// facetas con el destello como cruz de cinco píxeles, que se lee también en
// tamaños pequeños. El punto solo cabe a partir de 16.
func logoPixel(size, c, r int) string {
	k := 32 / float64(size)
	sc, sr := int(math.Floor(19.8/k)), int(math.Floor(19.4/k))
	if (c == sc && abs(r-sr) <= 1) || (r == sr && abs(c-sc) <= 1) {
		return pal.spark
	}
	if size >= 16 && c == int(math.Floor(23.4/k)) && r == int(math.Floor(22.6/k)) {
		return pal.dot
	}
	cx, cy := (float64(c)+0.5)*k-16, (float64(r)+0.5)*k-16
	if math.Abs(cx)+math.Abs(cy) > 12.8 {
		return ""
	}
	switch {
	case cy < 0 && cx < 0:
		return pal.f1
	case cy < 0:
		return pal.f2
	case cx < 0:
		return pal.f3
	}
	return pal.f4
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// renderLogo dibuja el prisma con medios bloques: cada celda lleva dos píxeles.
// Sin medios bloques (ASCII) no hay logo.
func renderLogo(size int) []string {
	if !glyphs.halfBlocks {
		return nil
	}
	var rows []string
	for r := 0; r < size; r += 2 {
		var b strings.Builder
		for c := 0; c < size; c++ {
			top, bottom := logoPixel(size, c, r), logoPixel(size, c, r+1)
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
	return rows
}

// wordmark son las letras LIXBON en mapas de 5×6 píxeles, pintadas con medios
// bloques en tres filas.
var wordmarkGlyphs = map[rune][6]string{
	'L': {"X....", "X....", "X....", "X....", "X....", "XXXXX"},
	'I': {"X", "X", "X", "X", "X", "X"},
	'X': {"X...X", ".X.X.", "..X..", "..X..", ".X.X.", "X...X"},
	'B': {"XXXX.", "X...X", "XXXX.", "X...X", "X...X", "XXXX."},
	'O': {".XXX.", "X...X", "X...X", "X...X", "X...X", ".XXX."},
	'N': {"X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X"},
}

func renderWordmark() []string {
	if !glyphs.halfBlocks {
		return []string{sBold.Render("L I X B O N")}
	}
	ink := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.ivory))
	var rows []string
	for r := 0; r < 6; r += 2 {
		var b strings.Builder
		for i, ch := range "LIXBON" {
			if i > 0 {
				b.WriteString("  ")
			}
			g := wordmarkGlyphs[ch]
			for c := 0; c < len(g[0]); c++ {
				top, bottom := g[r][c] == 'X', g[r+1][c] == 'X'
				switch {
				case top && bottom:
					b.WriteString(ink.Render("█"))
				case top:
					b.WriteString(ink.Render("▀"))
				case bottom:
					b.WriteString(ink.Render("▄"))
				default:
					b.WriteString(" ")
				}
			}
		}
		rows = append(rows, b.String())
	}
	return rows
}
