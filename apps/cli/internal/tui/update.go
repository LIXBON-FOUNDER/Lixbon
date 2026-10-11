package tui

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/sse"
)

const (
	quitWindow    = 2 * time.Second
	tickEvery     = 120 * time.Millisecond
	relayoutDelay = 80 * time.Millisecond
	menuVisible   = 8
)

// relayoutMsg repinta el markdown tras un redimensionado; gen descarta los
// que llegan cuando la ventana ya cambió otra vez.
type relayoutMsg struct{ gen int }

func tickCmd() tea.Cmd {
	return tea.Tick(tickEvery, func(time.Time) tea.Msg { return tickMsg{} })
}

// ticking: el ticker anima el turno y los comandos asíncronos; se para solo.
func (m *Model) ticking() bool { return m.running || m.busy != "" || m.login != nil }

func (m *Model) startTick() tea.Cmd {
	if m.tickOn {
		return nil
	}
	m.tickOn = true
	return tickCmd()
}

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	model, cmd := m.update(msg)
	m.syncRemote()
	return model, cmd
}

func (m *Model) update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if k, ok := msg.(tea.KeyPressMsg); ok && (k.String() == "ctrl+v" || k.String() == "shift+insert") {
		return m, pasteClipboard
	}
	if m.login != nil {
		switch msg.(type) {
		case tea.KeyPressMsg, tea.PasteMsg, loginStartedMsg, loginTokenMsg, loginKeyMsg:
			return m, m.updateLogin(msg)
		case tea.MouseClickMsg, tea.MouseMotionMsg, tea.MouseReleaseMsg, tea.MouseWheelMsg:
			return m, nil
		}
	}
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.input.SetWidth(max(10, msg.Width-4))
		m.log.resize(msg.Width)
		m.relayoutGen++
		gen := m.relayoutGen
		return m, tea.Tick(relayoutDelay, func(time.Time) tea.Msg { return relayoutMsg{gen} })

	case tea.BackgroundColorMsg:
		if m.chat.Cfg.ExtraString("theme") == "auto" {
			m.setTheme(msg.IsDark())
		}
		return m, nil

	case relayoutMsg:
		if msg.gen == m.relayoutGen && m.log.repaintDirty() {
			m.sel = nil
		}
		return m, nil

	case tea.MouseWheelMsg:
		if m.pagerActive() {
			switch msg.Button {
			case tea.MouseWheelUp:
				m.pagerScroll(wheelStep)
			case tea.MouseWheelDown:
				m.pagerScroll(-wheelStep)
			}
		} else {
			m.wheel(msg.Button)
		}
		return m, nil

	case tea.MouseClickMsg:
		if m.pagerActive() {
			return m, nil
		}
		if cmd, ok := m.clickChrome(msg); ok {
			return m, cmd
		}
		m.onMouseDown(msg)
		return m, nil

	case tea.MouseMotionMsg:
		m.hoverX, m.hoverY = msg.X, msg.Y
		if !m.pagerActive() {
			m.onMouseDrag(msg)
		}
		return m, nil

	case tea.MouseReleaseMsg:
		return m, m.onMouseUp()

	case tea.KeyPressMsg:
		m.sel = nil
		if m.pagerActive() {
			m.handlePagerKey(msg)
			return m, nil
		}
		if m.remoteEndKey(msg) {
			return m, nil
		}
		return m.handleKey(msg)

	case remoteMsg:
		return m, m.onRemote(msg)

	case remoteClosedMsg:
		if m.remote != nil && m.remote.link == msg.link {
			m.leaveRemote(false)
		}
		return m, nil

	case tea.PasteMsg:
		if m.secret != nil {
			var cmd tea.Cmd
			*m.secret, cmd = m.secret.Update(msg)
			return m, cmd
		}
		if m.picker != nil {
			return m, nil
		}
		if path, ok := droppedImage(msg.Content, m.chat.Workspace); ok {
			m.stageImage(path)
			return m, nil
		}
		m.input.InsertString(strings.ReplaceAll(strings.ReplaceAll(msg.Content, "\r\n", "\n"), "\r", "\n"))
		m.refreshMenu()
		return m, nil

	case tea.ClipboardMsg:
		return m.Update(tea.PasteMsg{Content: msg.Content})

	case clipboardImageMsg:
		if m.picker == nil && m.secret == nil {
			m.pasteImage()
		}
		return m, nil

	case tickMsg:
		if !m.ticking() {
			m.tickOn = false
			return m, nil
		}
		m.spin++
		if m.openTool != nil {
			m.log.refresh(m.openTool)
		}
		return m, tickCmd()

	case deltaMsg:
		if msg.turn != m.turn {
			return m, nil
		}
		switch msg.kind {
		case sse.Content:
			m.liveChars += utf8.RuneCountInString(msg.text)
			m.live.content.WriteString(msg.text)
		case sse.Reasoning:
			if m.live.reasoning.Len() == 0 {
				m.live.reasoningStarted = time.Now()
			}
			m.liveChars += utf8.RuneCountInString(msg.text)
			m.live.reasoning.WriteString(msg.text)
			m.live.reasoningSecs = time.Since(m.live.reasoningStarted).Seconds()
		case sse.Usage:
			if n, err := strconv.Atoi(msg.text); err == nil {
				m.liveReal += n
				m.liveChars = 0
			}
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
			m.add(note(msg.text))
		}
		return m, nil

	case compactProgressMsg:
		if m.compacting != nil {
			m.compacting.written = msg.written
		}
		return m, nil

	case toastExpiredMsg:
		if msg.gen == m.toastGen {
			m.toastText = ""
		}
		return m, nil

	case quotaMsg:
		m.applyQuota(msg)
		return m, nil

	case titleMsg:
		m.notice = ""
		return m, nil

	case todoMsg:
		m.printTodo(msg.items, msg.previous)
		return m, nil

	case approvalMsg:
		return m, m.openApproval(msg)

	case approvalClosedMsg:
		if m.picker != nil && m.picker.token == any(msg.reply) {
			m.picker = nil
			m.setToolState(toolRunning)
		}
		return m, nil

	case askMsg:
		return m, m.openAsk(msg)

	case cmdDoneMsg:
		return m, m.finishAsync(msg)

	case updateNoticeMsg:
		m.add(note(fmt.Sprintf("Hay una versión nueva (v%s). Ejecuta /update.", msg.version)))
		return m, nil

	case runCommandMsg:
		return m, m.runCommand(msg.name, msg.arg)

	case promptMsg:
		if msg.secret {
			return m, m.promptSecret(msg.label, msg.onSubmit)
		}
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

func (m *Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if m.picker != nil && m.picker.content != nil && !infoKeys[msg.String()] {
		m.picker = nil
	}
	if m.picker != nil {
		return m, m.pickerDo(func(p *picker) (tea.Cmd, bool) { return p.key(msg) })
	}
	if m.secret != nil {
		return m, m.handleSecretKey(msg)
	}
	if m.shortcutsOpen {
		m.shortcutsOpen = false
		if k := msg.String(); k == "esc" || k == "?" {
			return m, nil
		}
	} else if msg.String() == "?" && m.input.Value() == "" && m.prompt == nil {
		m.shortcutsOpen = true
		return m, nil
	}
	// Con el menú @ abierto, Enter completa la ruta; si ya está escrita
	// entera, envía el mensaje.
	if msg.String() == "enter" && m.menuFiles && len(m.menu) > 0 {
		if q, _, _ := m.atQuery(); q != m.menu[m.menuCursor].insert {
			m.completeMenu()
			return m, nil
		}
	}
	switch msg.String() {
	case "pgup":
		m.scrollBy(max(1, m.height-6))
		return m, nil
	case "pgdown":
		m.scrollBy(-max(1, m.height-6))
		return m, nil
	case "ctrl+t":
		m.pager = &pager{}
		return m, nil
	case "ctrl+o":
		m.toggleDetail()
		return m, nil
	case "alt+v":
		m.pasteImage()
		return m, nil
	case "backspace":
		if m.dropMarkerBeforeCursor() {
			return m, nil
		}
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
			m.add(note("cancelado"))
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
		if !m.busyNow() {
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
	if m.remote != nil {
		m.remote.link.Stop(true)
		m.remote = nil
	}
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
	m.notice, m.toastText = "", ""
	if strings.TrimSpace(text) == "" {
		return nil
	}
	if m.prompt != nil {
		p := m.prompt
		m.prompt = nil
		return p.onSubmit(text)
	}
	m.hist.add(keyArg.ReplaceAllStringFunc(text, maskKeyCommand))
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
	m.hideMenuWhileBrowsing()
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
	m.hideMenuWhileBrowsing()
	return true
}

// hideMenuWhileBrowsing evita que una entrada del historial que empieza por «/»
// abra el menú de comandos: el menú se quedaría con las flechas y no dejaría
// seguir recorriendo el historial.
func (m *Model) hideMenuWhileBrowsing() {
	m.refreshMenu()
	m.menu = nil
}

// ── menú de comandos ─────────────────────────────────────────────────────

func (m *Model) allSpecs() []Spec {
	specs := slices.DeleteFunc(order(slices.Concat(Specs, GoSpecs)), func(s Spec) bool { return !m.available(s.Name) })
	for name, c := range m.chat.Custom {
		specs = append(specs, Spec{Name: name, Desc: c.Description, Group: "propios"})
	}
	return specs
}
