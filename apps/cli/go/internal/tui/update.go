package tui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/sse"
)

const (
	quitWindow  = 2 * time.Second
	tickEvery   = 120 * time.Millisecond
	menuVisible = 8
)

func tickCmd() tea.Cmd {
	return tea.Tick(tickEvery, func(time.Time) tea.Msg { return tickMsg{} })
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.input.SetWidth(max(10, msg.Width-4))
		m.log.resize(msg.Width)
		return m, nil

	case tea.MouseWheelMsg:
		switch msg.Button {
		case tea.MouseWheelUp:
			m.scrollBy(wheelStep)
		case tea.MouseWheelDown:
			m.scrollBy(-wheelStep)
		}
		return m, nil

	case tea.KeyPressMsg:
		return m.handleKey(msg)

	case tea.PasteMsg:
		if m.picker != nil {
			return m, nil
		}
		m.input.InsertString(strings.ReplaceAll(strings.ReplaceAll(msg.Content, "\r\n", "\n"), "\r", "\n"))
		m.refreshMenu()
		return m, nil

	case tickMsg:
		if !m.running {
			return m, nil
		}
		m.spin++
		return m, tickCmd()

	case deltaMsg:
		if msg.turn != m.turn {
			return m, nil
		}
		switch msg.kind {
		case sse.Content:
			m.live.content.WriteString(msg.text)
		case sse.Reasoning:
			if m.live.reasoning.Len() == 0 {
				m.live.reasoningStarted = time.Now()
			}
			m.live.reasoning.WriteString(msg.text)
			m.live.reasoningSecs = time.Since(m.live.reasoningStarted).Seconds()
		}
		return m, nil

	case eventMsg:
		if msg.turn == m.turn {
			m.handleEvent(msg.e)
		}
		return m, nil

	case noteMsg:
		if msg.turn == m.turn {
			m.flushLive()
			m.print(note(msg.text))
		}
		return m, nil

	case titleMsg:
		m.notice = ""
		return m, nil

	case todoMsg:
		m.printTodo(msg.items, msg.previous)
		return m, nil

	case approvalMsg:
		return m, m.openApproval(msg)

	case askMsg:
		return m, m.openAsk(msg)

	case cmdDoneMsg:
		return m, m.finishAsync(msg)

	case runCommandMsg:
		return m, m.runCommand(msg.name, msg.arg)

	case promptMsg:
		m.promptFor(msg.label, msg.onSubmit)
		return m, nil

	case doneMsg:
		if msg.turn != m.turn {
			return m, nil
		}
		return m, m.finishTurn(msg)
	}
	return m, nil
}

const wheelStep = 3

func (m *Model) scrollBy(rows int) {
	m.scroll = max(0, m.scroll+rows)
}

func (m *Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if m.picker != nil {
		cmd, closed := m.picker.key(msg)
		if closed {
			m.picker = nil
		}
		return m, cmd
	}
	switch msg.String() {
	case "pgup":
		m.scrollBy(max(1, m.height-6))
		return m, nil
	case "pgdown":
		m.scrollBy(-max(1, m.height-6))
		return m, nil
	case "ctrl+c":
		return m, m.onInterrupt()
	case "esc":
		switch {
		case m.prompt != nil:
			p := m.prompt
			m.prompt = nil
			m.input.Reset()
			if p.onCancel != nil {
				p.onCancel()
			}
			m.print(note("cancelado"))
		case m.running:
			m.cancelTurn()
		case len(m.menu) > 0:
			m.menuHidden = true
			m.menu = nil
		}
		return m, nil
	case "ctrl+d":
		if strings.TrimSpace(m.input.Value()) == "" && !m.running {
			return m, m.quit()
		}
	case "enter":
		return m, m.onEnter()
	case "tab":
		if len(m.menu) > 0 {
			m.completeMenu()
			return m, nil
		}
	case "shift+tab":
		if !m.running {
			m.cycleMode()
		}
		return m, nil
	case "up":
		if len(m.menu) > 0 {
			m.menuCursor = (m.menuCursor + len(m.menu) - 1) % len(m.menu)
			return m, nil
		}
		if m.input.Line() == 0 && m.historyPrev() {
			return m, nil
		}
	case "down":
		if len(m.menu) > 0 {
			m.menuCursor = (m.menuCursor + 1) % len(m.menu)
			return m, nil
		}
		if m.input.Line() == m.input.LineCount()-1 && m.historyNext() {
			return m, nil
		}
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	m.refreshMenu()
	return m, cmd
}

// onInterrupt: Ctrl+C interrumpe el turno; sin turno, borra lo escrito; con la
// caja vacía hace falta pulsarlo dos veces seguidas para salir.
func (m *Model) onInterrupt() tea.Cmd {
	switch {
	case m.running:
		m.cancelTurn()
		return nil
	case strings.TrimSpace(m.input.Value()) != "":
		m.input.Reset()
		m.refreshMenu()
		return nil
	case time.Since(m.quitHint) < quitWindow:
		return m.quit()
	}
	m.quitHint = time.Now()
	m.notice = "Pulsa Ctrl+C otra vez para salir"
	return nil
}

func (m *Model) quit() tea.Cmd {
	m.quitting = true
	return tea.Quit
}

func (m *Model) cancelTurn() {
	m.interrupted = true
	if m.cancel != nil {
		m.cancel()
	}
	m.notice = "interrumpiendo…"
}

func (m *Model) cycleMode() {
	switch {
	case m.chat.Mode == "ask":
		m.setMode("agent")
	case m.chat.Mode == "agent" && !m.chat.Session.PlanMode:
		m.chat.Session.PlanMode = true
	default:
		m.chat.Session.PlanMode = false
		m.setMode("ask")
	}
	m.refreshContext()
}

func (m *Model) onEnter() tea.Cmd {
	if len(m.menu) > 0 && !strings.ContainsAny(m.input.Value(), " \n") {
		m.completeMenu()
	}
	text := strings.TrimRight(m.input.Value(), " \t\r\n")
	m.input.Reset()
	m.refreshMenu()
	m.notice = ""
	if strings.TrimSpace(text) == "" {
		return nil
	}
	if m.prompt != nil {
		p := m.prompt
		m.prompt = nil
		return p.onSubmit(text)
	}
	m.hist.add(text)
	m.histPos = len(m.hist.entries)
	m.draft = ""
	if m.busyNow() {
		m.queue = append(m.queue, text)
		return nil
	}
	return m.dispatch(text)
}

func (m *Model) historyPrev() bool {
	if m.histPos == 0 || len(m.hist.entries) == 0 {
		return false
	}
	if m.histPos == len(m.hist.entries) {
		m.draft = m.input.Value()
	}
	m.histPos--
	m.input.SetValue(m.hist.entries[m.histPos])
	m.input.MoveToEnd()
	m.refreshMenu()
	return true
}

func (m *Model) historyNext() bool {
	if m.histPos >= len(m.hist.entries) {
		return false
	}
	m.histPos++
	if m.histPos == len(m.hist.entries) {
		m.input.SetValue(m.draft)
	} else {
		m.input.SetValue(m.hist.entries[m.histPos])
	}
	m.input.MoveToEnd()
	m.refreshMenu()
	return true
}

// ── menú de comandos ─────────────────────────────────────────────────────

func (m *Model) allSpecs() []Spec {
	specs := Ordered()
	for name, c := range m.chat.Custom {
		specs = append(specs, Spec{Name: name, Desc: c.Description, Group: "propios"})
	}
	return specs
}

func (m *Model) refreshMenu() {
	value := m.input.Value()
	if !strings.HasPrefix(value, "/") || strings.ContainsAny(value, " \n") {
		m.menu, m.menuHidden = nil, false
		return
	}
	if m.menuHidden {
		return
	}
	prefix := strings.ToLower(value[1:])
	var out []Spec
	for _, s := range m.allSpecs() {
		if strings.HasPrefix(s.Name, prefix) {
			out = append(out, s)
		}
	}
	m.menu = out
	m.menuCursor = max(0, min(m.menuCursor, len(out)-1))
}

// completeMenu escribe el comando elegido en la caja.
func (m *Model) completeMenu() {
	if len(m.menu) == 0 {
		return
	}
	chosen := m.menu[m.menuCursor]
	m.input.SetValue("/" + chosen.Name)
	if chosen.Args != "" {
		m.input.InsertString(" ")
	}
	m.input.MoveToEnd()
	m.refreshMenu()
}

// ── turnos ───────────────────────────────────────────────────────────────

func (m *Model) handleEvent(e agent.Event) {
	m.flushLive()
	if e.Kind == agent.EventStep {
		return
	}
	m.live.usedTools = true
	switch e.Kind {
	case agent.EventNote:
		m.print(note(e.Text))
	case agent.EventRescued:
		m.print(renderResult(e.Text, false, "", m.width))
	case agent.EventReadGroup:
		m.print("\n" + renderAction(agent.Event{Tool: e.Tool, Text: e.Text, ReadOnly: true, Meta: e.Meta}, m.width) +
			"\n" + renderLogLine(strings.Join(e.Names, " "+glyphSep+" "), sDim2, "", m.width))
	case agent.EventAction:
		out := "\n" + renderAction(e, m.width)
		if e.Change != nil && !e.ReadOnly {
			rows := agent.DiffRows(*e.Change, agent.DiffContext)
			if len(rows) > 0 {
				out += "\n" + strings.Join(renderDiff(rows, m.width, diffMaxRows), "\n")
			}
		}
		m.print(out)
	case agent.EventActionResult:
		m.print(m.renderActionResult(e))
	}
}

func (m *Model) renderActionResult(e agent.Event) string {
	meta := ""
	if e.Elapsed >= 100*time.Millisecond {
		meta = fmt.Sprintf("%.1f s", e.Elapsed.Seconds())
	}
	if e.Tool != "run_command" || e.Result == "" {
		summary := e.Summary
		if e.Check != "" {
			summary += "  " + glyphSep + "  " + e.Check
		}
		return renderResult(summary, e.Failed, meta, m.width)
	}
	body, code := e.Result, "?"
	if rest, ok := strings.CutPrefix(body, "[EXIT "); ok {
		if n, after, found := strings.Cut(rest, "] "); found {
			code, body = n, after
		} else if n, after, found := strings.Cut(rest, "]"); found {
			code, body = n, after
		}
	}
	lines, last := renderOutput(body, m.width)
	summary := "exit " + code
	if last != "" && last != "(sin salida)" {
		summary = last + "  " + glyphSep + "  exit " + code
	}
	if e.Check != "" {
		summary += "  " + glyphSep + "  " + e.Check
	}
	out := strings.Join(lines, "\n")
	if out != "" {
		out += "\n"
	}
	return out + renderResult(summary, e.Failed, meta, m.width)
}

func (m *Model) printTodo(items, previous []todoItem) {
	m.todo = items
	done := 0
	for _, it := range items {
		if it.Status == "done" {
			done++
		}
	}
	same := previous != nil && len(previous) == len(items)
	if same {
		for i := range items {
			if items[i].Text != previous[i].Text {
				same = false
			}
		}
	}
	if same {
		doing := ""
		for _, it := range items {
			if it.Status == "doing" {
				doing = it.Text
				break
			}
		}
		detail := fmt.Sprintf("%d/%d", done, len(items))
		if doing != "" {
			detail += "  " + glyphArrow + "  " + doing
		}
		m.print("\n" + renderAction(agent.Event{Tool: "todo", Text: detail, ReadOnly: true}, m.width))
		return
	}
	lines := []string{"\n" + renderAction(agent.Event{Tool: "todo", Text: fmt.Sprintf("%d pasos", len(items)), ReadOnly: true}, m.width)}
	for _, it := range items {
		mark, style := "○", sDim
		switch it.Status {
		case "done":
			mark, style = glyphDot, sDim2
		case "doing":
			mark, style = glyphArrow, sPrimary
		}
		lines = append(lines, renderLogLine("  "+mark+" "+it.Text, style, "", m.width))
	}
	m.print(strings.Join(lines, "\n"))
}
