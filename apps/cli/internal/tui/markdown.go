package tui

import (
	"strings"

	"charm.land/glamour/v2"
	"charm.land/glamour/v2/ansi"
	"github.com/alecthomas/chroma/v2"
	chromastyles "github.com/alecthomas/chroma/v2/styles"
)

const markdownMargin = 0

// El registro de chroma es un mapa sin lock: los estilos se registran una
// sola vez, antes de que nada resalte código.
func init() {
	chromastyles.Register(chromaStyle("lixbon-dark", darkPalette, false))
	chromastyles.Register(chromaStyle("lixbon-light", lightPalette, false))
	chromastyles.Register(chromaStyle("lixbon-dark-cmd", darkPalette, true))
	chromastyles.Register(chromaStyle("lixbon-light-cmd", lightPalette, true))
}

// chromaStyle: con cmd, el texto de un comando de shell va en negrita y en el
// color más claro, para que destaque sobre los comentarios.
func chromaStyle(name string, p palette, cmd bool) *chroma.Style {
	text := p.body
	if cmd {
		text = "bold " + p.ink
	}
	return chroma.MustNewStyle(name, chroma.StyleEntries{
		chroma.Text:                text,
		chroma.Error:               p.err,
		chroma.Comment:             "italic " + p.com,
		chroma.CommentPreproc:      p.com,
		chroma.Keyword:             p.kw,
		chroma.KeywordType:         p.ty,
		chroma.KeywordConstant:     p.num,
		chroma.Operator:            p.soft,
		chroma.Punctuation:         p.soft,
		chroma.Name:                text,
		chroma.NameBuiltin:         p.fn,
		chroma.NameFunction:        p.fn,
		chroma.NameClass:           p.ty,
		chroma.NameTag:             p.kw,
		chroma.NameAttribute:       p.fn,
		chroma.NameDecorator:       p.str,
		chroma.Literal:             p.num,
		chroma.LiteralNumber:       p.num,
		chroma.LiteralString:       p.str,
		chroma.LiteralStringEscape: p.num,
		chroma.GenericDeleted:      p.delFg,
		chroma.GenericInserted:     p.addFg,
		chroma.GenericEmph:         "italic",
		chroma.GenericStrong:       "bold",
		chroma.GenericHeading:      "bold " + p.ink,
		chroma.GenericSubheading:   p.info,
	})
}

func chromaTheme(p palette) string {
	if p.dark {
		return "lixbon-dark"
	}
	return "lixbon-light"
}

// markdownStyle construye el estilo de glamour con los tokens. CodeBlock.Chroma
// queda a nil a propósito: con él puesto glamour fuerza su tema «charm» e
// ignora Theme.
func markdownStyle(p palette, margin uint) ansi.StyleConfig {
	str := func(v string) *string { return &v }
	yes := func() *bool { v := true; return &v }
	num := func(v uint) *uint { return &v }
	block := func(color string, bold bool) ansi.StyleBlock {
		s := ansi.StylePrimitive{Color: str(color)}
		if bold {
			s.Bold = yes()
		}
		return ansi.StyleBlock{StylePrimitive: s}
	}
	bullet := "• "
	if glyphs.prompt == ">" {
		bullet = "- "
	}
	return ansi.StyleConfig{
		Document:   ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: str(p.body)}, Margin: num(margin)},
		BlockQuote: ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: str(p.soft), Italic: yes()}, Indent: num(1), IndentToken: str(glyphs.rail + " ")},
		List:       ansi.StyleList{LevelIndent: 2},
		Heading:    ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{BlockSuffix: "\n", Color: str(p.ink), Bold: yes()}},
		H1:         block(p.ink, true),
		H2:         block(p.ink, true),
		H3:         block(p.ink, true),
		H4:         block(p.soft, true),
		H5:         block(p.soft, true),
		H6:         block(p.muted, true),

		Strikethrough:  ansi.StylePrimitive{CrossedOut: yes()},
		Emph:           ansi.StylePrimitive{Italic: yes()},
		Strong:         ansi.StylePrimitive{Bold: yes(), Color: str(p.ink)},
		HorizontalRule: ansi.StylePrimitive{Color: str(p.faint), Format: "\n" + strings.Repeat(glyphs.rule, 24) + "\n"},

		Item:        ansi.StylePrimitive{BlockPrefix: bullet},
		Enumeration: ansi.StylePrimitive{BlockPrefix: ". "},
		Task:        ansi.StyleTask{Ticked: "[" + glyphs.check + "] ", Unticked: "[ ] "},

		Link:      ansi.StylePrimitive{Color: str(p.info), Underline: yes()},
		LinkText:  ansi.StylePrimitive{Color: str(p.info)},
		Image:     ansi.StylePrimitive{Color: str(p.info), Underline: yes()},
		ImageText: ansi.StylePrimitive{Color: str(p.muted), Format: "imagen: {{.text}} " + glyphs.arrow},

		Code: ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: str(p.code), BackgroundColor: str(p.surf2), Prefix: " ", Suffix: " "}},
		CodeBlock: ansi.StyleCodeBlock{
			StyleBlock: ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: str(p.body)}, Margin: num(2)},
			Theme:      chromaTheme(p),
		},
		Table:                 ansi.StyleTable{StyleBlock: ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: str(p.body)}}},
		DefinitionDescription: ansi.StylePrimitive{BlockPrefix: "\n" + glyphs.arrow + " "},
	}
}

// newMarkdownRenderer respeta GLAMOUR_STYLE como hasta ahora; sin él usa el
// estilo de Lixbon del tema en uso.
func newMarkdownRenderer(width int, glamourStyle string) (*glamour.TermRenderer, error) {
	if glamourStyle != "" {
		return glamour.NewTermRenderer(glamour.WithStandardStyle(glamourStyle), glamour.WithWordWrap(width))
	}
	return glamour.NewTermRenderer(
		glamour.WithStyles(markdownStyle(pal, markdownMargin)),
		glamour.WithChromaFormatter("terminal16m"),
		glamour.WithWordWrap(width),
	)
}
