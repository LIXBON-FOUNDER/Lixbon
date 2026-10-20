package tui

import (
	"fmt"
	"strings"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/tools"
)

// askAnswers son las respuestas de una tanda de ask_user: van debajo de su
// fila «Preguntar» del riel, también al reabrir la conversación.
type askAnswers struct {
	rows      []tools.Answer
	cancelled bool
}

func (a *askAnswers) render(width int) []string {
	if a == nil {
		return nil
	}
	labelWidth := 0
	for _, r := range a.rows {
		labelWidth = max(labelWidth, ansi.StringWidth(r.Label))
	}
	labelWidth = min(labelWidth, max(8, width/3))
	var out []string
	missing := 0
	for _, r := range a.rows {
		if r.Missing {
			missing++
			continue
		}
		left := pad
		if r.Label != "" {
			label := ansi.Truncate(r.Label, labelWidth, glyphEllipsis)
			left += sDim.Render(label+strings.Repeat(" ", labelWidth-ansi.StringWidth(label))) + "  "
		} else {
			left += sDim.Render(glyphArrow) + " "
		}
		out = append(out, left+sInk.Render(ansi.Truncate(r.Text, max(8, width-ansi.StringWidth(left)-1), glyphEllipsis)))
	}
	switch {
	case a.cancelled && len(out) == 0:
		out = append(out, pad+sDim.Render("sin respuesta "+glyphSep+" lo decide el agente"))
	case missing == 1:
		out = append(out, pad+sDim.Render("la otra la decide el agente"))
	case missing > 1:
		out = append(out, pad+sDim.Render(fmt.Sprintf("las otras %d las decide el agente", missing)))
	}
	return out
}

// newAskAnswers junta preguntas y respuestas en lo que enseña el riel.
func newAskAnswers(qs []tools.Question, answers []string, ok bool) *askAnswers {
	a := &askAnswers{cancelled: !ok}
	for i, q := range qs {
		label := q.Header
		if label == "" && len(qs) > 1 {
			label = fmt.Sprintf("Pregunta %d", i+1)
		}
		text := ""
		if i < len(answers) {
			text = strings.TrimSpace(answers[i])
		}
		a.rows = append(a.rows, tools.Answer{Label: label, Text: text, Missing: text == ""})
	}
	return a
}

// askForm es el panel de una tanda de preguntas: una pestaña por pregunta y,
// si son varias, «Enviar» para repasar. Lo marcado se guarda al cambiar de
// pestaña; esc dentro de «Otra respuesta» vuelve a las opciones y fuera
// cierra la tanda entera.
type askForm struct {
	qs         []tools.Question
	tab        int
	cursor     []int
	picked     [][]bool
	other      []string
	editing    bool
	input      textinput.Model
	sendCursor int
	done       func(answers []string, ok bool) tea.Cmd
}

func newAskForm(qs []tools.Question, done func([]string, bool) tea.Cmd) *picker {
	f := &askForm{qs: qs, cursor: make([]int, len(qs)), picked: make([][]bool, len(qs)), other: make([]string, len(qs)), done: done}
	for i, q := range qs {
		f.picked[i] = make([]bool, len(q.Options))
	}
	f.input = field("").input
	title := "Preguntas del agente"
	if len(qs) == 1 {
		title = qs[0].Text
	}
	p := &picker{title: title, ask: f, done: func(string, bool) tea.Cmd { return nil }}
	p.tone = pal.warn
	return p
}

// tabs: con varias preguntas hay pestañas y una más para enviar.
func (f *askForm) tabs() bool { return len(f.qs) > 1 }

func (f *askForm) onSend() bool { return f.tabs() && f.tab == len(f.qs) }

func (f *askForm) answer(i int) string {
	var parts []string
	for j, on := range f.picked[i] {
		if on {
			parts = append(parts, f.qs[i].Options[j].Label)
		}
	}
	if other := strings.TrimSpace(f.other[i]); other != "" {
		parts = append(parts, other)
	}
	return strings.Join(parts, ", ")
}

func (f *askForm) answers() []string {
	out := make([]string, len(f.qs))
	for i := range f.qs {
		out[i] = f.answer(i)
	}
	return out
}

func (f *askForm) finish(ok bool) (tea.Cmd, bool) {
	f.input.Blur()
	return f.done(f.answers(), ok), true
}

// rowsFor son las filas elegibles de una pregunta: sus opciones y «Otra».
func (f *askForm) rowsFor(i int) int { return len(f.qs[i].Options) + 1 }

func (f *askForm) goTab(i int) {
	n := len(f.qs)
	if f.tabs() {
		n++
	}
	f.tab = (i + n) % n
	f.sendCursor = 0
}

// advance pasa a la siguiente pestaña, o envía si no hay más.
func (f *askForm) advance() (tea.Cmd, bool) {
	if !f.tabs() {
		return f.finish(true)
	}
	f.goTab(f.tab + 1)
	return nil, false
}

func (f *askForm) startEditing() tea.Cmd {
	f.editing = true
	f.input.SetValue(f.other[f.tab])
	f.input.CursorEnd()
	return f.input.Focus()
}

// pick elige la opción j de la pregunta actual: en las de una sola, la deja
// como respuesta y sigue; en las de varias, la marca o desmarca.
func (f *askForm) pick(j int) (tea.Cmd, bool) {
	q := f.qs[f.tab]
	f.cursor[f.tab] = j
	if j == len(q.Options) {
		return f.startEditing(), false
	}
	if q.Multiple {
		f.picked[f.tab][j] = !f.picked[f.tab][j]
		return nil, false
	}
	for k := range f.picked[f.tab] {
		f.picked[f.tab][k] = k == j
	}
	f.other[f.tab] = ""
	return f.advance()
}

func (f *askForm) key(msg tea.KeyPressMsg) (tea.Cmd, bool) {
	k := msg.String()
	if f.editing {
		switch k {
		case "esc":
			f.editing = false
			f.input.Blur()
			return nil, false
		case "ctrl+c":
			return f.finish(false)
		case "enter":
			text := strings.TrimSpace(f.input.Value())
			f.other[f.tab] = text
			f.editing = false
			f.input.Blur()
			if text == "" || f.qs[f.tab].Multiple {
				return nil, false
			}
			for j := range f.picked[f.tab] {
				f.picked[f.tab][j] = false
			}
			return f.advance()
		}
		var cmd tea.Cmd
		f.input, cmd = f.input.Update(msg)
		return cmd, false
	}
	switch k {
	case "esc", "ctrl+c":
		return f.finish(false)
	case "left", "shift+tab":
		if f.tabs() {
			f.goTab(f.tab - 1)
		}
		return nil, false
	case "right", "tab":
		if f.tabs() {
			f.goTab(f.tab + 1)
		}
		return nil, false
	}
	if f.onSend() {
		return f.sendKey(k)
	}
	q := f.qs[f.tab]
	rows := f.rowsFor(f.tab)
	switch k {
	case "up", "ctrl+p":
		f.cursor[f.tab] = (f.cursor[f.tab] - 1 + rows) % rows
	case "down", "ctrl+n":
		f.cursor[f.tab] = (f.cursor[f.tab] + 1) % rows
	case "space":
		return f.pick(f.cursor[f.tab])
	case "enter":
		c := f.cursor[f.tab]
		if !q.Multiple || c == len(q.Options) {
			return f.pick(c)
		}
		if f.answer(f.tab) == "" {
			f.picked[f.tab][c] = true
		}
		return f.advance()
	default:
		if len(k) == 1 && k[0] >= '1' && int(k[0]-'0') <= rows {
			return f.pick(int(k[0] - '1'))
		}
	}
	return nil, false
}

// sendTargets son las filas de «Enviar»: enviar y volver a cada pregunta que
// quedó sin responder.
func (f *askForm) sendTargets() []int {
	targets := []int{-1}
	for i := range f.qs {
		if f.answer(i) == "" {
			targets = append(targets, i)
		}
	}
	return targets
}

func (f *askForm) sendKey(k string) (tea.Cmd, bool) {
	targets := f.sendTargets()
	switch k {
	case "up", "ctrl+p":
		f.sendCursor = (f.sendCursor - 1 + len(targets)) % len(targets)
	case "down", "ctrl+n":
		f.sendCursor = (f.sendCursor + 1) % len(targets)
	case "enter", "space":
		if t := targets[min(f.sendCursor, len(targets)-1)]; t >= 0 {
			f.goTab(t)
			return nil, false
		}
		return f.finish(true)
	}
	return nil, false
}

func (f *askForm) paste(msg tea.PasteMsg) tea.Cmd {
	if !f.editing {
		return nil
	}
	msg.Content = strings.NewReplacer("\r", "", "\n", " ").Replace(msg.Content)
	var cmd tea.Cmd
	f.input, cmd = f.input.Update(msg)
	return cmd
}

func (f *askForm) hints() string {
	switch {
	case f.editing:
		return keyHints([2]string{"enter", "guardar"}, [2]string{"esc", "volver a las opciones"})
	case f.onSend():
		return keyHints([2]string{"←→", "pregunta"}, [2]string{"↑↓", "mover"}, [2]string{"enter", "elegir"}, [2]string{"esc", "que decida lixbon"})
	}
	var pairs [][2]string
	if f.tabs() {
		pairs = append(pairs, [2]string{"←→", "pregunta"})
	}
	pairs = append(pairs, [2]string{"↑↓", "mover"})
	if f.qs[f.tab].Multiple {
		pairs = append(pairs, [2]string{"espacio", "marcar"})
	}
	pairs = append(pairs, [2]string{"enter", "elegir"})
	return keyHints(append(pairs, [2]string{"esc", "que decida lixbon"})...)
}

func (f *askForm) tabLabel(i int) string {
	if h := f.qs[i].Header; h != "" {
		return ansi.Truncate(h, 16, glyphEllipsis)
	}
	return fmt.Sprintf("Pregunta %d", i+1)
}

// tabRows son las pestañas como texto, la de ahora en tinta y subrayada con
// la señal; las respondidas llevan ✓ y van apagadas.
func (f *askForm) tabRows(inner int) []panelRow {
	const gap = "      "
	var top, line strings.Builder
	add := func(label string, style lipgloss.Style, current bool) {
		if top.Len() > 0 {
			top.WriteString(gap)
			line.WriteString(gap)
		}
		top.WriteString(style.Render(label))
		mark := " "
		if current {
			mark = glyphMeterOn
		}
		line.WriteString(sAccent.Render(strings.Repeat(mark, ansi.StringWidth(label))))
	}
	for i := range f.qs {
		label, style := f.tabLabel(i), sSoft
		switch {
		case i == f.tab && !f.onSend():
			style = sInk
		case f.answer(i) != "":
			label, style = glyphs.check+" "+label, sDim
		}
		add(label, style, i == f.tab && !f.onSend())
	}
	style := sSoft
	if f.onSend() {
		style = sInk
	}
	add("Repaso", style, f.onSend())
	return []panelRow{
		{text: ansi.Truncate(top.String(), inner, glyphEllipsis)},
		{text: ansi.Truncate(line.String(), inner, "")},
	}
}

func (f *askForm) view(inner int) []panelRow {
	var rows []panelRow
	if f.tabs() {
		rows = append(rows, f.tabRows(inner)...)
		rows = append(rows, panelRow{})
	}
	if f.onSend() {
		return append(rows, f.sendView(inner)...)
	}
	q := f.qs[f.tab]
	if f.tabs() {
		lines := wrapText(q.Text, max(10, inner-10))
		for i, l := range lines {
			text := sInk.Render(l)
			if i == 0 {
				count := fmt.Sprintf("%d de %d", f.tab+1, len(f.qs))
				if q.Multiple {
					count = "varias   " + count
				}
				text = fitRight(text, sDim.Render(count), inner+1)
			}
			rows = append(rows, panelRow{text: text})
		}
		rows = append(rows, panelRow{})
	} else if q.Multiple {
		rows = append(rows, panelRow{text: sDim.Render("puedes marcar varias")}, panelRow{})
	}
	cursor := f.cursor[f.tab]
	for j, o := range q.Options {
		on := j == cursor
		bar, labelStyle, bg := " ", sSoft, ""
		if on {
			bar, labelStyle, bg = sAccent.Render(glyphPrompt), sInk, pal.surf2
		}
		mark := sDim.Render(glyphTodo)
		if f.picked[f.tab][j] {
			mark = sAccent.Render(glyphDot)
		}
		left := bar + " " + mark + " " + labelStyle.Render(ansi.Truncate(o.Label, max(8, inner-8), glyphEllipsis))
		rows = append(rows, panelRow{text: left, bg: bg})
		if o.Description != "" {
			rows = append(rows, panelRow{text: "    " + sDim.Render(ansi.Truncate(o.Description, max(8, inner-6), glyphEllipsis)), bg: bg})
		}
	}
	j := len(q.Options)
	on := cursor == j
	bar, bg := " ", ""
	if on {
		bar, bg = sAccent.Render(glyphPrompt), pal.surf2
	}
	left := bar + " " + sDim.Render(glyphTodo) + " "
	switch {
	case f.editing:
		f.input.SetWidth(max(10, inner-8))
		left += f.input.View()
	case f.other[f.tab] != "":
		left += sInk.Render("«" + ansi.Truncate(f.other[f.tab], max(8, inner-12), glyphEllipsis) + "»")
	case on:
		left += sInk.Render("Otra respuesta…")
	default:
		left += sDim.Render("Otra respuesta…")
	}
	return append(rows, panelRow{text: left, bg: bg})
}

func (f *askForm) sendView(inner int) []panelRow {
	var rows []panelRow
	width := 0
	for i := range f.qs {
		width = max(width, ansi.StringWidth(f.tabLabel(i)))
	}
	for i := range f.qs {
		label := f.tabLabel(i)
		left := sDim.Render(label+strings.Repeat(" ", width-ansi.StringWidth(label))) + "  "
		answer := sDim.Render("lo decide lixbon")
		if a := f.answer(i); a != "" {
			answer = sInk.Render(ansi.Truncate(a, max(8, inner-width-4), glyphEllipsis))
		}
		rows = append(rows, panelRow{text: left + answer})
	}
	rows = append(rows, panelRow{})
	targets := f.sendTargets()
	for n, t := range targets {
		label := "Enviar respuestas"
		if t >= 0 {
			label = "Volver a «" + f.tabLabel(t) + "»"
		}
		on := n == f.sendCursor
		row := panelRow{text: "  " + sSoft.Render(label)}
		if on {
			row = panelRow{text: sAccent.Render(glyphPrompt) + " " + sInk.Render(label), bg: pal.surf2}
		}
		rows = append(rows, row)
	}
	if len(targets) > 1 {
		rows = append(rows, panelRow{}, panelRow{text: sDim.Render("lo que quede sin responder lo decide el agente")})
	}
	return rows
}

// openAsk abre una tanda de ask_user. Una sola pregunta sin opciones se
// contesta en la caja; el resto, en el panel de pestañas. Al responder, las
// respuestas quedan bajo la fila «Preguntar».
func (m *Model) openAsk(msg askMsg) tea.Cmd {
	reply, qs := msg.reply, msg.questions
	entry := m.askEntry
	if b := askBlock(entry); b != nil {
		b.state = toolWaiting
		m.refresh(entry)
	}
	answered := func(answers []string, ok bool) {
		if b := askBlock(entry); b != nil {
			b.state = toolDone
			b.answers = newAskAnswers(qs, answers, ok)
			m.refresh(entry)
		}
		reply <- askReply{answers: answers, ok: ok}
	}
	if len(qs) == 1 && len(qs[0].Options) == 0 {
		if entry == nil {
			m.gap()
			m.add(askLine(qs[0].Text))
		}
		m.prompt = &promptState{
			label:    qs[0].Text,
			onSubmit: func(text string) tea.Cmd { answered([]string{text}, true); return nil },
			onCancel: func() { answered(nil, false) },
			token:    reply,
		}
		return nil
	}
	m.picker = newAskForm(qs, func(answers []string, ok bool) tea.Cmd {
		answered(answers, ok)
		return nil
	})
	m.picker.token = reply
	return nil
}

// askBlock es el bloque «Preguntar» de la tanda en curso, si lo hay.
func askBlock(e *entry) *toolBlock {
	if e == nil {
		return nil
	}
	b, _ := e.b.(*toolBlock)
	return b
}
