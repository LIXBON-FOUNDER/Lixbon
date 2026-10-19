package tui

import (
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

// panelRow es una fila de un panel; con bg se pinta la fila entera (la
// elegida de un selector).
type panelRow struct {
	text string
	bg   string
}

// panel dibuja una caja redondeada de ancho width con el borde del color dado
// y un título opcional en la línea de arriba.
func panel(rows []panelRow, width int, border, title string) []string {
	b := lipgloss.NewStyle().Foreground(lipgloss.Color(border))
	if width < 4 {
		out := make([]string, len(rows))
		for i, r := range rows {
			out[i] = ansi.Truncate(r.text, max(1, width), "")
		}
		return out
	}
	inner := width - 4
	top := b.Render(glyphs.boxTL + strings.Repeat(glyphs.boxH, width-2) + glyphs.boxTR)
	if title != "" && width > 8 {
		t := ansi.Truncate(" "+title+" ", width-5, glyphEllipsis)
		top = b.Render(glyphs.boxTL+glyphs.boxH) + sBold.Render(t) +
			b.Render(strings.Repeat(glyphs.boxH, max(0, width-3-ansi.StringWidth(t)))+glyphs.boxTR)
	}
	out := []string{top}
	for _, r := range rows {
		// Un \r (salida de un programa de Windows) devolvería el cursor al
		// borde y pisaría la fila.
		text := ansi.Truncate(strings.ReplaceAll(r.text, "\r", ""), inner, "")
		fill := strings.Repeat(" ", max(0, inner-ansi.StringWidth(text)))
		if r.bg != "" {
			bg := lipgloss.NewStyle().Background(lipgloss.Color(r.bg))
			out = append(out, b.Render(glyphs.boxV)+bg.Render(" ")+withBackground(text, r.bg)+bg.Render(fill+" ")+b.Render(glyphs.boxV))
			continue
		}
		out = append(out, b.Render(glyphs.boxV)+" "+text+fill+" "+b.Render(glyphs.boxV))
	}
	return append(out, b.Render(glyphs.boxBL+strings.Repeat(glyphs.boxH, width-2)+glyphs.boxBR))
}

// withBackground repinta el fondo de un texto ya estilado: cada reset de
// lipgloss se lo llevaría, así que se vuelve a poner tras cada secuencia.
func withBackground(text, bg string) string {
	seq := lipgloss.NewStyle().Background(lipgloss.Color(bg)).Render("\x00")
	open, _, _ := strings.Cut(seq, "\x00")
	if open == "" {
		return text
	}
	text = strings.ReplaceAll(text, "\x1b[0m", "\x1b[m")
	return open + strings.ReplaceAll(text, "\x1b[m", "\x1b[m"+open) + "\x1b[m"
}

// key pinta una pista de teclado: la tecla destacada y lo que hace atenuado.
func keyHint(k, label string) string { return sSoft.Render(k) + sDim.Render(" "+label) }

func keyHints(pairs ...[2]string) string {
	parts := make([]string, len(pairs))
	for i, p := range pairs {
		parts[i] = keyHint(p[0], p[1])
	}
	return strings.Join(parts, sDim2.Render(" "+glyphSep+" "))
}

// inputBox es la caja de entrada: borde del color del modo (ámbar cuando
// responde a una pregunta), chips de imagen arriba y una pista a la derecha.
func (m *Model) inputBox() []string {
	width := max(4, m.width)
	inner := max(1, width-4)
	border, title := modeBorder(m.modeName()), ""
	if m.remote != nil {
		border, title = pal.acc, "Remote activo "+glyphSep+" ctrl+c con la caja vacía lo termina"
	}
	if m.prompt != nil {
		border, title = pal.warn, m.prompt.label
	}
	var rows []panelRow
	if len(m.chips) > 0 {
		rows = append(rows, panelRow{text: m.chipsRow(inner)})
	}
	lines := strings.Split(m.input.View(), "\n")
	hint := ""
	switch {
	case m.prompt != nil:
	case strings.TrimSpace(m.input.Value()) == "":
		hint = sDim2.Render("? atajos")
	case m.input.LineCount() > 1:
		hint = sDim2.Render("alt+↵ nueva línea")
	}
	if hint != "" {
		last := len(lines) - 1
		value := strings.Split(m.input.Value(), "\n")
		used := 2 + ansi.StringWidth(value[len(value)-1])
		if strings.TrimSpace(m.input.Value()) == "" {
			used = 2 + ansi.StringWidth(m.input.Placeholder)
		}
		if room := inner - ansi.StringWidth(hint) - 2; used <= room {
			lines[last] = ansi.Truncate(lines[last], room, "") + strings.Repeat(" ", max(0, room-ansi.StringWidth(ansi.Truncate(lines[last], room, ""))))
			lines[last] += "  " + hint
		}
	}
	for _, l := range lines {
		rows = append(rows, panelRow{text: l})
	}
	return panel(rows, width, border, title)
}

// chipsRow son las imágenes en cola, como fichas, con cómo pegar otra.
func (m *Model) chipsRow(inner int) string {
	chip := lipgloss.NewStyle().Background(lipgloss.Color(pal.surf2))
	var parts []string
	for _, c := range m.chips {
		dims := ""
		if c.w > 0 && c.h > 0 {
			dims = " " + sDim.Render(strconv.Itoa(c.w)+"×"+strconv.Itoa(c.h))
		}
		parts = append(parts, withBackground(" "+sSoft.Render(glyphChip+" "+c.name)+dims+" ", pal.surf2)+chip.Render(""))
	}
	return fitRight(strings.Join(parts, "  "), sDim2.Render("alt+v pegar"), inner+1)
}
