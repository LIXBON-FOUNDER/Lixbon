package tui

import (
	"image/color"
	"math"
	"strings"

	"charm.land/lipgloss/v2"
)

const logoSize = 16

var (
	logoTopLeft     = lipgloss.Color("#DCD6BC")
	logoTopRight    = lipgloss.Color("#C7BE9F")
	logoBottomLeft  = lipgloss.Color("#4B5327")
	logoBottomRight = lipgloss.Color("#333A1C")
	logoSpark       = lipgloss.Color("#FCFAEF")
)

// logoPixel evalúa el isotipo en una cuadrícula de 32×32 (la del favicon):
// un rombo en cuatro triángulos con una chispa de cuatro puntas.
func logoPixel(x, y float64) color.Color {
	const sparkX, sparkY, sparkR = 19.8, 19.4, 3.6
	dx, dy := math.Abs(x-sparkX), math.Abs(y-sparkY)
	if math.Sqrt(dx)+math.Sqrt(dy) <= math.Sqrt(sparkR) {
		return logoSpark
	}
	if math.Hypot(x-23.4, y-22.6) <= 1.3 {
		return logoSpark
	}
	cx, cy := x-16, y-16
	if math.Abs(cx)+math.Abs(cy) > 12.8 {
		return nil
	}
	switch {
	case cx < 0 && cy < 0:
		return logoTopLeft
	case cx >= 0 && cy < 0:
		return logoTopRight
	case cx < 0:
		return logoBottomLeft
	}
	return logoBottomRight
}

// renderLogo dibuja el isotipo con medios bloques: cada celda lleva dos
// píxeles, así que ocupa logoSize columnas por logoSize/2 filas.
func renderLogo() []string {
	scale := 32.0 / logoSize
	pixel := func(col, row int) color.Color {
		return logoPixel((float64(col)+0.5)*scale, (float64(row)+0.5)*scale)
	}
	var rows []string
	for row := 0; row < logoSize; row += 2 {
		var b strings.Builder
		for col := 0; col < logoSize; col++ {
			top, bottom := pixel(col, row), pixel(col, row+1)
			switch {
			case top == nil && bottom == nil:
				b.WriteString(" ")
			case bottom == nil:
				b.WriteString(lipgloss.NewStyle().Foreground(top).Render("▀"))
			case top == nil:
				b.WriteString(lipgloss.NewStyle().Foreground(bottom).Render("▄"))
			default:
				b.WriteString(lipgloss.NewStyle().Foreground(top).Background(bottom).Render("▀"))
			}
		}
		rows = append(rows, b.String())
	}
	return rows
}
