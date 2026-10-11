package tui

import (
	"fmt"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/agent"
)

// diffView pinta las filas de un diff con numeración, la fila entera tintada
// y la sintaxis solo en el primer plano. Los tokens se calculan una vez y se
// guardan; los colores se aplican al pintar, así que sirven en los dos temas.
type diffView struct {
	rows  []agent.DiffRow
	path  string
	lexed [][]chroma.Token
}

func (d *diffView) tokens(i int) []chroma.Token {
	if d.lexed == nil {
		d.lexed = make([][]chroma.Token, len(d.rows))
		lexer := lexers.Match(d.path)
		if lexer == nil {
			lexer = lexers.Fallback
		}
		lexer = chroma.Coalesce(lexer)
		for j, r := range d.rows {
			if r.Kind == "gap" {
				continue
			}
			text := strings.ReplaceAll(r.Text, "\t", "    ")
			if it, err := lexer.Tokenise(nil, text); err == nil {
				d.lexed[j] = it.Tokens()
			} else {
				d.lexed[j] = []chroma.Token{{Type: chroma.Text, Value: text}}
			}
		}
	}
	return d.lexed[i]
}

func tokenColor(t chroma.TokenType, base string) string {
	switch {
	case t.InCategory(chroma.Comment):
		return pal.com
	case t == chroma.KeywordType, t == chroma.NameClass, t == chroma.NameBuiltinPseudo:
		return pal.ty
	case t.InCategory(chroma.Keyword):
		return pal.kw
	case t == chroma.NameFunction, t == chroma.NameBuiltin, t == chroma.NameFunctionMagic:
		return pal.fn
	case t.InSubCategory(chroma.LiteralString):
		return pal.str
	case t.InSubCategory(chroma.LiteralNumber):
		return pal.num
	case t.InCategory(chroma.Operator), t.InCategory(chroma.Punctuation):
		return pal.soft
	}
	return base
}

func (d *diffView) render(width int, open bool) []string {
	if len(d.rows) == 0 {
		return nil
	}
	number := 0
	for _, r := range d.rows {
		number = max(number, max(r.OldNo, r.NewNo))
	}
	numWidth := max(3, len(strconv.Itoa(number)))
	codeWidth := max(4, width-len(pad)-numWidth-1-2-1)
	shown := d.rows
	if !open && len(shown) > diffShownRows {
		shown = shown[:diffShownRows]
	}
	var out []string
	for i, r := range shown {
		if r.Kind == "gap" {
			out = append(out, pad+sDim2.Render(strings.Repeat(" ", numWidth+1)+glyphGap))
			continue
		}
		bg, sign, signColor, base := "", "  ", pal.faint, pal.soft
		switch r.Kind {
		case "add":
			bg, sign, signColor, base = pal.addBg, "+ ", pal.ok, pal.ink
		case "del":
			bg, sign, signColor, base = pal.delBg, glyphMinus+" ", pal.err, pal.ink
		}
		style := func(fg string) lipgloss.Style {
			s := lipgloss.NewStyle().Foreground(lipgloss.Color(fg))
			if bg != "" {
				s = s.Background(lipgloss.Color(bg))
			}
			return s
		}
		n := r.NewNo
		if n == 0 {
			n = r.OldNo
		}
		var code strings.Builder
		used := 0
		for _, tok := range d.tokens(i) {
			text := strings.TrimRight(tok.Value, "\n")
			if text == "" {
				continue
			}
			if room := codeWidth - used; ansi.StringWidth(text) > room {
				text = ansi.Truncate(text, max(0, room), "")
			}
			used += ansi.StringWidth(text)
			code.WriteString(style(tokenColor(tok.Type, base)).Render(text))
			if used >= codeWidth {
				break
			}
		}
		fill := style(base).Render(strings.Repeat(" ", max(0, codeWidth-used)))
		out = append(out, pad+style(pal.faint).Render(fmt.Sprintf("%*d ", numWidth, n))+style(signColor).Render(sign)+code.String()+fill)
	}
	if len(shown) < len(d.rows) {
		out = append(out, pad+sDim.Render(fmt.Sprintf("%s %d líneas", glyphEllipsis, len(d.rows)-len(shown)))+sDim2.Render(" "+glyphSep+" ctrl+o"))
	}
	return out
}

type fileDiff struct {
	path       string
	rows       []agent.DiffRow
	adds, dels int
}

// parseUnified convierte la salida de git diff en filas por archivo.
func parseUnified(text string) []fileDiff {
	var files []fileDiff
	var cur *fileDiff
	oldNo, newNo := 0, 0
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			files = append(files, fileDiff{})
			cur = &files[len(files)-1]
			if _, b, ok := strings.Cut(line, " b/"); ok {
				cur.path = b
			}
		case cur == nil:
		case strings.HasPrefix(line, "+++ "):
			if p := strings.TrimPrefix(line, "+++ "); p != "/dev/null" {
				cur.path = strings.TrimPrefix(p, "b/")
			}
		case strings.HasPrefix(line, "--- "), strings.HasPrefix(line, "index "), strings.HasPrefix(line, "new file"),
			strings.HasPrefix(line, "deleted file"), strings.HasPrefix(line, "similarity"), strings.HasPrefix(line, "rename "),
			strings.HasPrefix(line, "Binary files"), strings.HasPrefix(line, "old mode"), strings.HasPrefix(line, "new mode"):
		case strings.HasPrefix(line, "@@"):
			var a, c int
			fmt.Sscanf(line, "@@ -%d", &a)
			if _, rest, ok := strings.Cut(line, " +"); ok {
				fmt.Sscanf(rest, "%d", &c)
			}
			if len(cur.rows) > 0 {
				cur.rows = append(cur.rows, agent.DiffRow{Kind: "gap"})
			}
			oldNo, newNo = a, c
		case strings.HasPrefix(line, "+"):
			cur.rows = append(cur.rows, agent.DiffRow{Kind: "add", NewNo: newNo, Text: line[1:]})
			newNo++
			cur.adds++
		case strings.HasPrefix(line, "-"):
			cur.rows = append(cur.rows, agent.DiffRow{Kind: "del", OldNo: oldNo, Text: line[1:]})
			oldNo++
			cur.dels++
		case strings.HasPrefix(line, " "):
			cur.rows = append(cur.rows, agent.DiffRow{Kind: "ctx", OldNo: oldNo, NewNo: newNo, Text: line[1:]})
			oldNo++
			newNo++
		}
	}
	return files
}
