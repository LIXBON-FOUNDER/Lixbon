// Package tui es la interfaz de terminal del CLI, construida con Bubble Tea.
// Lo ya terminado se imprime sobre la zona viva (scrollback inline); la zona
// viva —respuesta en curso, aprobación, caja de entrada y barra de estado— se
// redibuja debajo.
package tui

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/agent"
)

// Paleta del CLI (la misma que la del CLI Python).
var (
	cCream  = lipgloss.Color("#F6F7ED")
	cAccent = lipgloss.Color("#B4C13A")
	cBeige  = lipgloss.Color("#CBC7A9")
	cDim    = lipgloss.Color("#8A8A80")
	cDim2   = lipgloss.Color("#5C5C55")
	cOK     = lipgloss.Color("#5FB85F")
	cErr    = lipgloss.Color("#E05C5C")
	cWarn   = lipgloss.Color("#D6B44C")
	cPlan   = lipgloss.Color("#7FB8D8")
	cAddBG  = lipgloss.Color("#173A24")
	cDelBG  = lipgloss.Color("#45191D")
	cAddFG  = lipgloss.Color("#8FE39B")
	cDelFG  = lipgloss.Color("#FF9E9E")
	cBubble = lipgloss.Color("#2A2A24")
)

var (
	sDim     = lipgloss.NewStyle().Foreground(cDim)
	sDim2    = lipgloss.NewStyle().Foreground(cDim2)
	sAccent  = lipgloss.NewStyle().Foreground(cAccent)
	sBeige   = lipgloss.NewStyle().Foreground(cBeige)
	sPrimary = lipgloss.NewStyle().Foreground(cCream)
	sBold    = lipgloss.NewStyle().Foreground(cCream).Bold(true)
	sOK      = lipgloss.NewStyle().Foreground(cOK)
	sErr     = lipgloss.NewStyle().Foreground(cErr)
	sWarn    = lipgloss.NewStyle().Foreground(cWarn)
	sPlan    = lipgloss.NewStyle().Foreground(cPlan)
	sAddNum  = lipgloss.NewStyle().Foreground(cAddFG)
	sDelNum  = lipgloss.NewStyle().Foreground(cDelFG)
)

const (
	glyphRail     = "│"
	glyphRailHot  = "┃"
	glyphCorner   = "└"
	glyphSep      = "·"
	glyphArrow    = "→"
	glyphEllipsis = "…"
	glyphDot      = "●"
	glyphSpark    = "✦"
	glyphThink    = "✻"
	glyphEdge     = "▌"
	verbWidth     = 12
	diffMaxRows   = 44
	numMinWidth   = 3
	outputHead    = 3
)

var toolVerb = map[string]string{
	"read_file": "leyó", "write_file": "escribió", "edit_file": "editó", "append_file": "añadió a",
	"delete_file": "eliminó", "rename_file": "movió", "mkdir": "creó carpeta", "search": "buscó",
	"list_files": "listó", "find_files": "buscó archivos", "run_command": "ejecutó", "fetch_url": "descargó",
	"web_search": "buscó en la web", "read_output": "leyó salida", "stop_command": "detuvo",
	"outline": "esquematizó", "todo": "planificó", "ask_user": "preguntó", "multi_edit": "editó",
	"insert_at_line": "editó",
}

var kindVerb = map[string]string{
	"create": "creó", "update": "editó", "delete": "eliminó", "rename": "movió", "mkdir": "creó carpeta",
	"append": "añadió a", "command": "ejecutó",
}

func verbFor(tool string) string {
	if v, ok := toolVerb[tool]; ok {
		return v
	}
	return tool
}

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

// renderAction es una acción del agente dentro del canal:
//
//	│ leyó        src/app.py                          128 líneas
//	┃ editó       src/app.py                              +12 -3
func renderAction(e agent.Event, width int) string {
	verb, target := verbFor(e.Tool), e.Text
	if e.Change != nil {
		verb = kindVerb[e.Change.Kind]
		target = e.Change.Path
		switch e.Change.Kind {
		case "rename":
			target = fmt.Sprintf("%s %s %s", e.Change.Path, glyphArrow, e.Change.Detail)
		case "command":
			target = e.Change.Detail
		}
	}
	if e.Tool == "MCP" {
		verb = "MCP"
	}
	padded := fmt.Sprintf("%-*s", verbWidth, verb)
	var left string
	if e.ReadOnly {
		left = rail(false) + sDim.Render(padded) + sDim2.Render(target)
	} else {
		left = rail(true) + sBold.Render(padded) + sBeige.Render(target)
	}
	right := ""
	switch {
	case e.Adds != 0 || e.Dels != 0:
		right = sAddNum.Render(fmt.Sprintf("+%d", e.Adds)) + " " + sDelNum.Render(fmt.Sprintf("-%d", e.Dels))
	case e.Meta != "":
		right = sDim2.Render(e.Meta)
	}
	return twoCol(left, right, width)
}

// renderResult cuelga de la acción: un fallo se pinta como fila de diff
// eliminado hasta el margen, porque es lo único que no puede pasar desapercibido.
func renderResult(summary string, failed bool, meta string, width int) string {
	if !failed {
		left := rail(false) + sDim2.Render(glyphCorner+" "+summary)
		if meta != "" {
			return twoCol(left, sDim2.Render(meta), width)
		}
		return left
	}
	tail := ""
	if meta != "" {
		tail = meta + " "
	}
	limit := max(6, width-2-ansi.StringWidth(tail))
	body := ansi.Truncate(glyphCorner+" "+summary, limit, glyphEllipsis)
	body += strings.Repeat(" ", max(0, limit-ansi.StringWidth(body)))
	return rail(false) + lipgloss.NewStyle().Foreground(cDelFG).Background(cDelBG).Render(body+tail)
}

func renderLogLine(text string, style lipgloss.Style, meta string, width int) string {
	left := rail(false) + style.Render(text)
	if meta != "" {
		return twoCol(left, sDim2.Render(meta), width)
	}
	return left
}

// renderOutput es la salida de un comando colgando de su acción: las primeras
// líneas y cuántas quedan. Devuelve las líneas pintadas y la última, que es
// la que resume («35 passed»).
func renderOutput(text string, width int) (lines []string, last string) {
	var all []string
	for _, l := range strings.Split(strings.TrimSpace(text), "\n") {
		if l = strings.TrimRight(l, " \t\r"); strings.TrimSpace(l) != "" {
			all = append(all, l)
		}
	}
	if len(all) == 0 {
		return nil, ""
	}
	last = truncateRunes(all[len(all)-1], 160)
	body := all[:len(all)-1]
	for _, l := range body[:min(outputHead, len(body))] {
		lines = append(lines, renderLogLine(glyphRail+" "+truncateRunes(l, 160), sDim2, "", width))
	}
	if len(body) > outputHead {
		lines = append(lines, renderLogLine(fmt.Sprintf("%s %s %d líneas más", glyphRail, glyphEllipsis, len(body)-outputHead), sDim2, "", width))
	}
	return lines, last
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// renderDiff pinta las filas del diff con número de línea y la fila entera
// con fondo (verde lo añadido, rojo lo eliminado).
func renderDiff(rows []agent.DiffRow, width, maxRows int) []string {
	if len(rows) == 0 {
		return nil
	}
	numbers := 0
	for _, r := range rows {
		numbers = max(numbers, max(r.OldNo, r.NewNo))
	}
	numWidth := max(numMinWidth, len(fmt.Sprint(numbers)))
	codeWidth := max(8, max(20, width-2-2)-numWidth-2)

	var out []string
	for _, r := range rows[:min(maxRows, len(rows))] {
		if r.Kind == "gap" {
			out = append(out, rail(false)+sDim2.Render(strings.Repeat(" ", numWidth+2)+glyphEllipsis))
			continue
		}
		sign, signStyle, bodyStyle, numStyle := " ", sDim2, sDim, sDim2
		switch r.Kind {
		case "add":
			sign = "+"
			signStyle = lipgloss.NewStyle().Foreground(cAddFG).Background(cAddBG)
			bodyStyle = lipgloss.NewStyle().Foreground(cCream).Background(cAddBG)
			numStyle = lipgloss.NewStyle().Foreground(cDim2).Background(cAddBG)
		case "del":
			sign = "-"
			signStyle = lipgloss.NewStyle().Foreground(cDelFG).Background(cDelBG)
			bodyStyle = lipgloss.NewStyle().Foreground(cCream).Background(cDelBG)
			numStyle = lipgloss.NewStyle().Foreground(cDim2).Background(cDelBG)
		}
		number := r.NewNo
		if number == 0 {
			number = r.OldNo
		}
		code := strings.ReplaceAll(r.Text, "\t", "    ")
		if w := ansi.StringWidth(code); w > codeWidth {
			code = ansi.Truncate(code, codeWidth, "")
		} else {
			code += strings.Repeat(" ", codeWidth-w)
		}
		out = append(out, sDim2.Render(glyphRail)+" "+numStyle.Render(fmt.Sprintf("%*d ", numWidth, number))+
			signStyle.Render(sign)+bodyStyle.Render(code))
	}
	if len(rows) > maxRows {
		out = append(out, twoCol(sDim2.Render(glyphRail+" "+strings.Repeat(" ", numWidth+2)+glyphEllipsis),
			sDim2.Render(fmt.Sprintf("%d líneas más", len(rows)-maxRows)), width))
	}
	return out
}

// renderUserMessage es el eco de lo que escribió el usuario: una burbuja con
// fondo que solo llega hasta donde llega el texto.
func renderUserMessage(text string, width int) string {
	limit := max(20, width-6)
	var lines []string
	for _, raw := range strings.Split(text, "\n") {
		wrapped := ansi.Wrap(raw, limit, "")
		lines = append(lines, strings.Split(wrapped, "\n")...)
	}
	block := 0
	for _, l := range lines {
		block = max(block, ansi.StringWidth(l))
	}
	bubble := lipgloss.NewStyle().Foreground(cCream).Background(cBubble)
	dot := lipgloss.NewStyle().Foreground(cAccent).Background(cBubble)
	var out []string
	for i, l := range lines {
		mark := " "
		if i == 0 {
			mark = glyphDot
		}
		out = append(out, bubble.Render(" ")+dot.Render(mark)+bubble.Render("  "+l+strings.Repeat(" ", block-ansi.StringWidth(l))+" "))
	}
	return strings.Join(out, "\n")
}

func renderCommandEcho(text string) string {
	return sDim2.Render(glyphDot) + "  " + sAccent.Render(text)
}

func renderSpeaker(meta string, width int) string {
	left := sAccent.Render(glyphSpark+" ") + sBold.Render("Lixbon")
	if meta != "" {
		return twoCol(left, sDim2.Render(meta), width)
	}
	return left
}

func renderTurnSummary(actions, files, adds, dels int, seconds float64, width int) string {
	if actions == 0 {
		return ""
	}
	noun := func(n int, one, many string) string {
		if n == 1 {
			return fmt.Sprintf("%d %s", n, one)
		}
		return fmt.Sprintf("%d %s", n, many)
	}
	left := rail(false) + sDim.Render(noun(actions, "acción", "acciones"))
	if files > 0 {
		left += sDim2.Render(" "+glyphSep+" ") + sDim.Render(noun(files, "archivo", "archivos"))
	}
	if adds != 0 || dels != 0 {
		left += sDim2.Render(" "+glyphSep+" ") + sAddNum.Render(fmt.Sprintf("+%d", adds)) + " " + sDelNum.Render(fmt.Sprintf("-%d", dels))
	}
	if seconds > 0 {
		left += sDim2.Render(fmt.Sprintf(" %s %.1f s", glyphSep, seconds))
	}
	return left
}

func note(text string) string    { return "    " + sDim2.Render(text) }
func okLine(text string) string  { return "  " + sOK.Render(glyphDot) + " " + sPrimary.Render(text) }
func errLine(text string) string { return "  " + sErr.Render(glyphDot) + " " + sPrimary.Render(text) }
func warnLine(text string) string {
	return "  " + sWarn.Render("!") + " " + sPrimary.Render(text)
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

const contextCells = 8

func contextBar(pct float64) string {
	pct = max(0, min(100, pct))
	filled := int(pct*contextCells/100 + 0.5)
	return strings.Repeat("▓", filled) + strings.Repeat("░", contextCells-filled)
}
