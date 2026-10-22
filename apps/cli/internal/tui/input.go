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

// panel es una hoja sin marco: un fondo un punto más claro que la terminal,
// el título arriba y las filas con dos columnas de margen. Un tono ámbar
// (aprobaciones, preguntas) pone ▲ delante del título.
func panel(rows []panelRow, width int, tone, title string) []string {
	return sheet(rows, width, tone, title, "", "")
}

// sheet es panel con un dato a la derecha del título y las teclas al pie.
func sheet(rows []panelRow, width int, tone, title, right, hints string) []string {
	if width < 6 {
		out := make([]string, len(rows))
		for i, r := range rows {
			out[i] = ansi.Truncate(r.text, max(1, width), "")
		}
		return out
	}
	inner := width - 4
	line := func(text, bg string) string { return padRow(text, bg, width) }
	var out []string
	if title != "" || right != "" {
		// El título del panel va en la señal: dice dónde estás.
		head := sAccent.Render(title)
		if tone == pal.warn {
			head = sWarn.Render(glyphWarn+" ") + head
		}
		out = append(out, line(fitRight(head, right, inner+1), pal.surf), line("", pal.surf))
	}
	for _, r := range rows {
		bg := r.bg
		if bg == "" {
			bg = pal.surf
		}
		if noColor && bg == pal.surf2 {
			// Sin color la banda no se ve: la fila elegida va en vídeo inverso.
			text := ansi.Truncate(ansi.Strip(r.text), inner, "")
			out = append(out, "  "+lipgloss.NewStyle().Reverse(true).Render(text+strings.Repeat(" ", max(0, inner-ansi.StringWidth(text))))+"  ")
			continue
		}
		out = append(out, line(r.text, bg))
	}
	if hints != "" {
		out = append(out, line("", pal.surf), line(hints, pal.surf))
	}
	return out
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

// key pinta una pista de teclado sin marco: la tecla en tinta y lo que hace
// apagado.
func keyHint(k, label string) string {
	if k == "↵" {
		k = "enter"
	}
	return sInk.Render(k) + sDim.Render(" "+label)
}

func keyHints(pairs ...[2]string) string {
	parts := make([]string, len(pairs))
	for i, p := range pairs {
		parts[i] = keyHint(p[0], p[1])
	}
	return strings.Join(parts, "     ")
}

// inputBox es la caja de entrada: una banda sin borde con la señal › al
// principio. Encima, en la misma banda, lo que la condiciona (remote, la
// pregunta que responde) y las imágenes en cola; a la derecha, una pista.
func (m *Model) inputBox() []string {
	width := max(4, m.width)
	inner := max(1, width-4)
	var rows []panelRow
	switch {
	case m.prompt != nil:
		rows = append(rows, panelRow{text: sWarn.Render(glyphWarn+" ") + sInk.Render(m.prompt.label)})
	case m.remote != nil:
		rows = append(rows, panelRow{text: sAccent.Render(glyphDot) + " " + sSoft.Render("remote") + sDim.Render("   ctrl+c con la caja vacía lo termina")})
	}
	if len(m.chips) > 0 {
		rows = append(rows, panelRow{text: m.chipsRow(inner)})
	}
	m.input.Placeholder = placeholderFor(m.chat)
	switch {
	case m.compacting != nil:
		// Lo que se escriba queda en cola hasta que termine.
		m.input.Placeholder = "espera a que termine de compactar"
	case m.running:
		m.input.Placeholder = "Guía a lixbon mientras trabaja"
	}
	m.syncInputStyle()
	lines := strings.Split(m.input.View(), "\n")
	hint := ""
	switch {
	case m.prompt != nil:
	case strings.TrimSpace(m.input.Value()) == "":
		hint = sDim.Render("? atajos")
	case m.input.LineCount() > 1:
		hint = sDim.Render("alt+↵ nueva línea")
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
	// La fila de la caja donde empieza el texto (tras la fila vacía de la
	// banda): ahí va el cursor de la terminal.
	m.inputTop = 1 + len(rows)
	for _, l := range lines {
		rows = append(rows, panelRow{text: l})
	}
	return band(rows, width)
}

// band pinta filas sobre el fondo de la banda, con una fila vacía arriba y
// otra abajo: la caja de entrada.
func band(rows []panelRow, width int) []string {
	if width < 6 {
		out := make([]string, len(rows))
		for i, r := range rows {
			out[i] = ansi.Truncate(r.text, max(1, width), "")
		}
		return out
	}
	out := []string{padRow("", pal.surf2, width)}
	for _, r := range rows {
		out = append(out, padRow(r.text, pal.surf2, width))
	}
	return append(out, padRow("", pal.surf2, width))
}

// padRow es una fila de ancho width con dos columnas de margen a cada lado
// y el fondo bg de punta a punta.
func padRow(text, bg string, width int) string {
	inner := max(1, width-4)
	// Un \r (salida de un programa de Windows) devolvería el cursor al
	// borde y pisaría la fila.
	text = ansi.Truncate(strings.ReplaceAll(text, "\r", ""), inner, "")
	fill := strings.Repeat(" ", max(0, inner-ansi.StringWidth(text)))
	return withBackground("  "+text+fill+"  ", bg)
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
