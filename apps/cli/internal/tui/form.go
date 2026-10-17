package tui

import (
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// formField es un campo de un formulario: texto libre, clave oculta o una
// elección entre unas pocas opciones (choices).
type formField struct {
	label    string
	hint     string
	optional bool
	choices  []string
	choice   int
	input    textinput.Model
}

func (f *formField) value() string {
	if len(f.choices) > 0 {
		return f.choices[f.choice]
	}
	return strings.TrimSpace(f.input.Value())
}

// fieldOption configura un campo al crearlo.
type fieldOption func(*formField)

func secretField() fieldOption {
	return func(f *formField) {
		f.input.EchoMode = textinput.EchoPassword
		f.input.EchoCharacter = '•'
	}
}

func optionalField() fieldOption { return func(f *formField) { f.optional = true } }

func withValue(v string) fieldOption {
	return func(f *formField) { f.input.SetValue(v); f.input.CursorEnd() }
}

func withHint(h string) fieldOption { return func(f *formField) { f.hint = h } }

func withChoices(choices ...string) fieldOption { return func(f *formField) { f.choices = choices } }

func field(label string, opts ...fieldOption) *formField {
	ti := textinput.New()
	ti.Prompt = glyphPrompt + " "
	styles := textinput.DefaultStyles(pal.dark)
	styles.Focused.Prompt = sAccent
	styles.Focused.Text = sInk
	styles.Blurred.Prompt = sDim2
	styles.Blurred.Text = sSoft
	ti.SetStyles(styles)
	f := &formField{label: label, input: ti}
	for _, o := range opts {
		o(f)
	}
	return f
}

// form es un modal para dar de alta o cambiar algo (un proveedor, un servidor
// MCP, una clave): sus campos viven en el panel, no en la caja del chat ni en
// el transcript. submit valida; si devuelve error, el modal sigue abierto y
// lo muestra dentro.
type form struct {
	fields []*formField
	focus  int
	err    string
	submit func(values []string) (tea.Cmd, error)
}

// newForm abre un formulario como panel modal. Esc lo cierra sin cambiar nada.
func newForm(title string, fields []*formField, submit func(values []string) (tea.Cmd, error)) *picker {
	f := &form{fields: fields, submit: submit}
	f.focusField(0)
	return &picker{title: title, form: f, done: func(string, bool) tea.Cmd { return nil }}
}

func (f *form) focusField(i int) tea.Cmd {
	f.focus = (i + len(f.fields)) % len(f.fields)
	var cmd tea.Cmd
	for j, fl := range f.fields {
		if j == f.focus && len(fl.choices) == 0 {
			cmd = fl.input.Focus()
		} else {
			fl.input.Blur()
		}
	}
	return cmd
}

func (f *form) key(msg tea.KeyPressMsg) (tea.Cmd, bool) {
	current := f.fields[f.focus]
	switch msg.String() {
	case "esc", "ctrl+c":
		return nil, true
	case "tab", "down":
		return f.focusField(f.focus + 1), false
	case "shift+tab", "up":
		return f.focusField(f.focus - 1), false
	case "enter":
		if f.focus < len(f.fields)-1 {
			return f.focusField(f.focus + 1), false
		}
		return f.send()
	}
	if len(current.choices) > 0 {
		switch msg.String() {
		case "left", "right", "space":
			step := 1
			if msg.String() == "left" {
				step = -1
			}
			current.choice = (current.choice + step + len(current.choices)) % len(current.choices)
		}
		return nil, false
	}
	f.err = ""
	var cmd tea.Cmd
	current.input, cmd = current.input.Update(msg)
	return cmd, false
}

func (f *form) paste(msg tea.PasteMsg) tea.Cmd {
	current := f.fields[f.focus]
	if len(current.choices) > 0 {
		return nil
	}
	// Una clave pegada trae a veces el salto de línea del final.
	msg.Content = strings.TrimSpace(strings.NewReplacer("\r", "", "\n", "").Replace(msg.Content))
	var cmd tea.Cmd
	current.input, cmd = current.input.Update(msg)
	return cmd
}

func (f *form) send() (tea.Cmd, bool) {
	values := make([]string, len(f.fields))
	for i, fl := range f.fields {
		values[i] = fl.value()
		if values[i] == "" && !fl.optional {
			f.err = "Falta «" + fl.label + "»."
			if fl.label == "" {
				f.err = "Escribe un valor o pulsa esc para cancelar."
			}
			f.focusField(i)
			return nil, false
		}
	}
	cmd, err := f.submit(values)
	if err != nil {
		f.err = err.Error()
		return nil, false
	}
	return cmd, true
}

func (f *form) hints() string {
	pairs := [][2]string{{"tab", "cambiar de campo"}}
	if len(f.fields[f.focus].choices) > 0 {
		pairs = append(pairs, [2]string{"←→", "cambiar"})
	}
	pairs = append(pairs, [2]string{"↵", "guardar"}, [2]string{"esc", "cancelar"})
	if f.focus < len(f.fields)-1 {
		pairs[len(pairs)-2] = [2]string{"↵", "siguiente"}
	}
	return keyHints(pairs...)
}

func (f *form) view(inner int) []panelRow {
	var rows []panelRow
	for i, fl := range f.fields {
		if i > 0 {
			rows = append(rows, panelRow{})
		}
		on := i == f.focus
		label := sSoft.Render(fl.label)
		if on {
			label = sBold.Render(fl.label)
		}
		if fl.optional {
			label += sDim2.Render("  opcional")
		}
		// Un campo solo, sin etiqueta: el título del panel ya dice qué se pide.
		if fl.label != "" {
			rows = append(rows, panelRow{text: label})
		}
		if len(fl.choices) > 0 {
			var parts []string
			for j, c := range fl.choices {
				switch {
				case j == fl.choice && on:
					parts = append(parts, sAccent.Render(glyphEdge+" "+c))
				case j == fl.choice:
					parts = append(parts, sInk.Render(glyphEdge+" "+c))
				default:
					parts = append(parts, sDim.Render("  "+c))
				}
			}
			rows = append(rows, panelRow{text: strings.Join(parts, "   ")})
		} else {
			fl.input.SetWidth(max(10, inner-2))
			row := panelRow{text: fl.input.View()}
			if on {
				row.bg = pal.surf2
			}
			rows = append(rows, row)
		}
		if fl.hint != "" && on {
			for _, line := range strings.Split(ansi.Wordwrap(fl.hint, max(10, inner-2), ""), "\n") {
				rows = append(rows, panelRow{text: sDim.Render("  " + line)})
			}
		}
	}
	if f.err != "" {
		rows = append(rows, panelRow{}, panelRow{text: sErr.Render(f.err)})
	}
	return rows
}
