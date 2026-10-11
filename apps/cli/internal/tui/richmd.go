package tui

import (
	"regexp"
	"strings"
	"unicode"

	"charm.land/lipgloss/v2"
	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/formatters"
	"github.com/alecthomas/chroma/v2/lexers"
	chromastyles "github.com/alecthomas/chroma/v2/styles"
	"github.com/charmbracelet/x/ansi"
)

// Las respuestas se parten en trozos: los títulos, los bloques de código y las
// tablas se pintan aquí, con la identidad del CLI; el resto (párrafos, listas,
// citas) lo pinta glamour. Glamour no deja dar fondo a un bloque de código ni
// ajustar una tabla al ancho sin romperla.

type segKind int

const (
	segText segKind = iota
	segHeading
	segCode
	segTable
)

type mdSegment struct {
	kind  segKind
	text  string
	level int
	lang  string
	rows  [][]string
	align []int
}

var (
	fenceRe     = regexp.MustCompile("^\\s{0,3}(`{3,}|~{3,})\\s*([\\w+#.-]*)")
	headingRe   = regexp.MustCompile(`^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$`)
	tableSepRe  = regexp.MustCompile(`^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$`)
	inlineRe    = regexp.MustCompile("`[^`]+`|\\*\\*[^*]+\\*\\*|__[^_]+__|\\[[^\\]]+\\]\\([^)]+\\)")
	linkPartsRe = regexp.MustCompile(`^\[([^\]]+)\]\(([^)]+)\)$`)
)

func splitMarkdown(text string) []mdSegment {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var out []mdSegment
	var prose []string
	flush := func() {
		if strings.TrimSpace(strings.Join(prose, "")) != "" {
			out = append(out, mdSegment{kind: segText, text: strings.Join(prose, "\n")})
		}
		prose = nil
	}
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if m := fenceRe.FindStringSubmatch(line); m != nil {
			flush()
			fence := m[1]
			var body []string
			for i++; i < len(lines); i++ {
				if t := strings.TrimSpace(lines[i]); strings.HasPrefix(t, fence[:3]) && strings.Trim(t, fence[:1]) == "" && len(t) >= len(fence) {
					break
				}
				body = append(body, lines[i])
			}
			out = append(out, mdSegment{kind: segCode, lang: strings.ToLower(m[2]), text: strings.Join(body, "\n")})
			continue
		}
		if m := headingRe.FindStringSubmatch(line); m != nil {
			flush()
			out = append(out, mdSegment{kind: segHeading, level: len(m[1]), text: m[2]})
			continue
		}
		if strings.Contains(line, "|") && i+1 < len(lines) && tableSepRe.MatchString(lines[i+1]) {
			flush()
			seg := mdSegment{kind: segTable, rows: [][]string{tableCells(line)}}
			for _, c := range tableCells(lines[i+1]) {
				c = strings.TrimSpace(c)
				switch {
				case strings.HasPrefix(c, ":") && strings.HasSuffix(c, ":"):
					seg.align = append(seg.align, 1)
				case strings.HasSuffix(c, ":"):
					seg.align = append(seg.align, 2)
				default:
					seg.align = append(seg.align, 0)
				}
			}
			for i += 2; i < len(lines) && strings.Contains(lines[i], "|") && strings.TrimSpace(lines[i]) != ""; i++ {
				seg.rows = append(seg.rows, tableCells(lines[i]))
			}
			i--
			out = append(out, seg)
			continue
		}
		prose = append(prose, line)
	}
	flush()
	return out
}

// tableCells parte una fila por «|», sin contar los escapados ni los que van
// dentro de `código`.
func tableCells(line string) []string {
	line = strings.TrimSpace(line)
	line = strings.TrimPrefix(line, "|")
	if strings.HasSuffix(line, "|") && !strings.HasSuffix(line, "\\|") {
		line = line[:len(line)-1]
	}
	var cells []string
	var cur strings.Builder
	code := false
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case c == '\\' && i+1 < len(line) && line[i+1] == '|':
			cur.WriteByte('|')
			i++
		case c == '`':
			code = !code
			cur.WriteByte(c)
		case c == '|' && !code:
			cells = append(cells, strings.TrimSpace(cur.String()))
			cur.Reset()
		default:
			cur.WriteByte(c)
		}
	}
	return append(cells, strings.TrimSpace(cur.String()))
}

// inline pinta lo que cabe en una celda o un título: `código`, **negrita** y
// enlaces; base es el estilo del texto normal.
func inline(text string, base lipgloss.Style) string {
	code := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.code))
	var b strings.Builder
	last := 0
	for _, loc := range inlineRe.FindAllStringIndex(text, -1) {
		b.WriteString(base.Render(text[last:loc[0]]))
		tok := text[loc[0]:loc[1]]
		switch {
		case strings.HasPrefix(tok, "`"):
			b.WriteString(code.Render(strings.Trim(tok, "`")))
		case strings.HasPrefix(tok, "["):
			parts := linkPartsRe.FindStringSubmatch(tok)
			b.WriteString(lipgloss.NewStyle().Foreground(lipgloss.Color(pal.info)).Underline(true).Render(parts[1]))
		default:
			b.WriteString(base.Bold(true).Render(tok[2 : len(tok)-2]))
		}
		last = loc[1]
	}
	b.WriteString(base.Render(text[last:]))
	return b.String()
}

func renderRich(text string, width int, prose func(string, int) string) string {
	var blocks []string
	afterHeading := false
	for i, seg := range splitMarkdown(text) {
		var out string
		switch seg.kind {
		case segText:
			out = trimBlankLines(prose(seg.text, width))
		case segHeading:
			out = renderHeading(seg, width)
		case segCode:
			out = renderCode(seg, width)
		case segTable:
			out = renderTable(seg, width)
		}
		if out == "" {
			continue
		}
		switch {
		case i == 0 || len(blocks) == 0:
		case afterHeading:
			blocks = append(blocks, "\n")
		default:
			blocks = append(blocks, "\n\n")
		}
		blocks = append(blocks, out)
		afterHeading = seg.kind == segHeading
	}
	return strings.Join(blocks, "")
}

func trimBlankLines(text string) string {
	lines := strings.Split(text, "\n")
	blank := func(s string) bool { return strings.TrimSpace(ansi.Strip(s)) == "" }
	for len(lines) > 0 && blank(lines[0]) {
		lines = lines[1:]
	}
	for len(lines) > 0 && blank(lines[len(lines)-1]) {
		lines = lines[:len(lines)-1]
	}
	for i, l := range lines {
		lines[i] = trimRightANSI(l)
	}
	return strings.Join(lines, "\n")
}

// renderHeading: H1 con marca y subrayado, H2 con marca, H3 en arena y el
// resto en negrita suave. Se distinguen del texto sin depender del color solo.
func renderHeading(seg mdSegment, width int) string {
	ink := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.ink)).Bold(true)
	marker := sAccent.Render(glyphEdge) + " "
	seg.text = stripLeadingEmoji(seg.text)
	switch seg.level {
	case 1:
		title := marker + inline(seg.text, ink)
		rule := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.olive)).
			Render(strings.Repeat(glyphs.rule, min(width, ansi.StringWidth(title)+2)))
		return ansi.Truncate(title, width, glyphEllipsis) + "\n" + rule
	case 2:
		return ansi.Truncate(marker+inline(seg.text, ink), width, glyphEllipsis)
	case 3:
		return ansi.Truncate(inline(seg.text, lipgloss.NewStyle().Foreground(lipgloss.Color(pal.sand)).Bold(true)), width, glyphEllipsis)
	}
	return ansi.Truncate(inline(seg.text, lipgloss.NewStyle().Foreground(lipgloss.Color(pal.soft)).Bold(true)), width, glyphEllipsis)
}

var shellLangs = map[string]bool{"bash": true, "sh": true, "shell": true, "zsh": true, "console": true,
	"powershell": true, "ps1": true, "pwsh": true, "cmd": true, "bat": true}

// renderCode es un bloque con fondo propio y el lenguaje arriba: así se ve
// dónde empieza y acaba aunque el tema de la terminal sea del mismo tono.
func renderCode(seg mdSegment, width int) string {
	code := strings.ReplaceAll(strings.TrimRight(seg.text, "\n"), "\t", "    ")
	highlighted := highlight(code, seg.lang)
	inner := max(4, width-4)
	fill := func(s string) string {
		return withBackground(s+strings.Repeat(" ", max(0, width-ansi.StringWidth(s))), pal.surf)
	}
	// El lenguaje es una etiqueta discreta en la esquina: el protagonista es el código.
	label := sDim2.Render(firstNonEmpty(seg.lang, "código") + " ")
	out := []string{fill(strings.Repeat(" ", max(0, width-ansi.StringWidth(label))) + label)}
	for _, line := range strings.Split(highlighted, "\n") {
		for _, part := range strings.Split(ansi.Hardwrap(line, inner, true), "\n") {
			out = append(out, fill("  "+part))
		}
	}
	return strings.Join(append(out, fill("")), "\n")
}

func highlight(code, lang string) string {
	lexer := lexers.Get(lang)
	if lexer == nil && lang == "" {
		lexer = lexers.Analyse(code)
	}
	if lexer == nil {
		return sPrimary.Render(code)
	}
	name := chromaTheme(pal)
	if shellLangs[lang] {
		name += "-cmd"
	}
	style := chromastyles.Get(name)
	it, err := chroma.Coalesce(lexer).Tokenise(nil, code)
	if err != nil {
		return sPrimary.Render(code)
	}
	var b strings.Builder
	if formatters.Get("terminal16m").Format(&b, style, it) != nil {
		return sPrimary.Render(code)
	}
	return strings.TrimRight(b.String(), "\n")
}

type tableGlyphs struct{ h, v, tl, tm, tr, ml, mm, mr, bl, bm, br string }

func tableSet() tableGlyphs {
	if glyphs.boxH == "-" {
		return tableGlyphs{"-", "|", "+", "+", "+", "+", "+", "+", "+", "+", "+"}
	}
	return tableGlyphs{"─", "│", "┌", "┬", "┐", "├", "┼", "┤", "└", "┴", "┘"}
}

// renderTable dibuja la tabla con bordes y la ajusta al ancho: si no cabe,
// estrecha las columnas más anchas y parte el texto de sus celdas.
func renderTable(seg mdSegment, width int) string {
	cols := 0
	for _, r := range seg.rows {
		cols = max(cols, len(r))
	}
	if cols == 0 {
		return ""
	}
	head := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.ink)).Bold(true)
	cells := make([][]string, len(seg.rows))
	widths := make([]int, cols)
	for i, r := range seg.rows {
		cells[i] = make([]string, cols)
		for j := range cols {
			text := ""
			if j < len(r) {
				text = r[j]
			}
			style := sPrimary
			if i == 0 {
				style = head
			}
			cells[i][j] = inline(text, style)
			widths[j] = max(widths[j], ansi.StringWidth(cells[i][j]))
		}
	}
	room := width - 3*cols - 1
	for sum(widths) > room {
		widest := 0
		for j, w := range widths {
			if w > widths[widest] {
				widest = j
			}
		}
		if widths[widest] <= 6 {
			break
		}
		widths[widest]--
	}
	g := tableSet()
	border := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.faint))
	line := func(l, m, r string) string {
		parts := make([]string, cols)
		for j, w := range widths {
			parts[j] = strings.Repeat(g.h, w+2)
		}
		return border.Render(l + strings.Join(parts, m) + r)
	}
	var out []string
	out = append(out, line(g.tl, g.tm, g.tr))
	for i, row := range cells {
		wrapped := make([][]string, cols)
		height := 1
		for j, c := range row {
			wrapped[j] = strings.Split(ansi.Wrap(c, max(1, widths[j]), ""), "\n")
			height = max(height, len(wrapped[j]))
		}
		for k := range height {
			var b strings.Builder
			b.WriteString(border.Render(g.v))
			for j := range cols {
				text := ""
				if k < len(wrapped[j]) {
					text = wrapped[j][k]
				}
				gap := max(0, widths[j]-ansi.StringWidth(text))
				align := 0
				if j < len(seg.align) {
					align = seg.align[j]
				}
				switch align {
				case 1:
					text = strings.Repeat(" ", gap/2) + text + strings.Repeat(" ", gap-gap/2)
				case 2:
					text = strings.Repeat(" ", gap) + text
				default:
					text += strings.Repeat(" ", gap)
				}
				b.WriteString(" " + text + " " + border.Render(g.v))
			}
			out = append(out, b.String())
		}
		if i < len(cells)-1 {
			out = append(out, line(g.ml, g.mm, g.mr))
		}
	}
	out = append(out, line(g.bl, g.bm, g.br))
	return strings.Join(out, "\n")
}

func sum(v []int) int {
	t := 0
	for _, x := range v {
		t += x
	}
	return t
}

// stripLeadingEmoji quita los emojis con que los modelos abren los títulos
// («🚀 Usos»): el título ya se distingue por su marca y su color.
func stripLeadingEmoji(text string) string {
	trimmed := strings.TrimLeftFunc(text, func(r rune) bool {
		return unicode.Is(unicode.So, r) || unicode.Is(unicode.Sk, r) || r == 0xFE0F || r == 0x200D || unicode.IsSpace(r)
	})
	if trimmed == "" {
		return text
	}
	return trimmed
}
