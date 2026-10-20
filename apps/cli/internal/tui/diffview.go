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

// diffFoldedRows son las líneas cambiadas que se ven con el diff plegado.
const diffFoldedRows = 5

// changed son los índices de las filas añadidas o borradas.
func (d *diffView) changed() []int {
	var out []int
	for i, r := range d.rows {
		if r.Kind == "add" || r.Kind == "del" {
			out = append(out, i)
		}
	}
	return out
}

// folds: plegado se ven solo las líneas cambiadas, hasta diffFoldedRows; si
// hay contexto o más cambios, ctrl+o enseña el diff entero.
func (d *diffView) folds() bool {
	changed := 0
	for _, r := range d.rows {
		if r.Kind == "add" || r.Kind == "del" {
			changed++
		} else if r.Kind != "gap" {
			return true
		}
	}
	return changed > diffFoldedRows
}

func (d *diffView) render(width int, open bool) []string {
	if len(d.rows) == 0 {
		return nil
	}
	number := 0
	for _, r := range d.rows {
		number = max(number, max(r.OldNo, r.NewNo))
	}
	numWidth := max(2, len(strconv.Itoa(number)))
	// Todas las filas del tramo miden lo mismo: lo que ocupa la más larga, con
	// aire, sin llegar al borde.
	longest := 0
	for _, r := range d.rows {
		longest = max(longest, ansi.StringWidth(strings.ReplaceAll(r.Text, "\t", "    ")))
	}
	rowWidth := min(max(10, width-len(pad)-1), max(40, numWidth+3+longest+3))
	idx := make([]int, 0, len(d.rows))
	for i := range d.rows {
		idx = append(idx, i)
	}
	more := 0
	if !open {
		changed := d.changed()
		idx = changed[:min(len(changed), diffFoldedRows)]
		more = len(changed) - len(idx)
	}
	var out []string
	for _, i := range idx {
		r := d.rows[i]
		if r.Kind == "gap" {
			out = append(out, pad+sDim.Render(strings.Repeat(" ", numWidth+1)+glyphGap))
			continue
		}
		bg, sign, fg := pal.surf, " ", pal.soft
		switch r.Kind {
		case "add":
			bg, sign, fg = pal.addBg, "+", pal.ink
		case "del":
			bg, sign, fg = pal.delBg, glyphMinus, pal.ink
		}
		n := r.NewNo
		if n == 0 {
			n = r.OldNo
		}
		text := fmt.Sprintf(" %*d %s %s", numWidth, n, sign, strings.ReplaceAll(r.Text, "\t", "    "))
		text = ansi.Truncate(text, rowWidth, glyphEllipsis)
		text += strings.Repeat(" ", max(0, rowWidth-ansi.StringWidth(text)))
		style := lipgloss.NewStyle().Foreground(lipgloss.Color(fg)).Background(lipgloss.Color(bg))
		out = append(out, pad+style.Render(text))
	}
	if more > 0 {
		out = append(out, pad+sDim.Render(fmt.Sprintf("%s %s más   ctrl+o", glyphEllipsis, noun(more, "línea", "líneas"))))
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
