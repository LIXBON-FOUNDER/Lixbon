// Package tui es la interfaz de terminal del CLI, construida con Bubble Tea.
// Ocupa la pantalla alternativa: el transcript tiene su propio desplazamiento
// y debajo se redibujan la zona viva, la caja de entrada y la barra de estado.
package tui

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/charmbracelet/x/ansi"
)

// twoCol coloca left a la izquierda y right pegado al margen derecho.
func twoCol(left, right string, width int) string {
	if right == "" {
		return left
	}
	gap := width - ansi.StringWidth(left) - ansi.StringWidth(right)
	if gap < 2 {
		left = ansi.Truncate(left, max(1, width-ansi.StringWidth(right)-2), glyphEllipsis)
		gap = max(2, width-ansi.StringWidth(left)-ansi.StringWidth(right))
	}
	return left + strings.Repeat(" ", gap) + right
}

func rail(hot bool) string {
	if hot {
		return sAccent.Render(glyphRailHot) + " "
	}
	return sDim2.Render(glyphRail) + " "
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

func fmtTokens(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1_000)
	}
	return fmt.Sprint(n)
}

const contextCells = 12

func contextBar(pct float64) string {
	pct = max(0, min(100, pct))
	filled := int(pct*contextCells/100 + 0.5)
	return strings.Repeat(glyphMeterOn, filled) + strings.Repeat(glyphMeterOff, contextCells-filled)
}
