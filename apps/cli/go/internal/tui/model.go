package tui

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/glamour/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/tools"
)

// Options configura la interfaz.
type Options struct {
	// HistoryFile es el historial de lo tecleado (formato de prompt_toolkit).
	HistoryFile string
	Version     string
	// Account es el resultado de sondear la cuenta al arrancar.
	Account chat.Account
	Offline bool
	// Warning se imprime bajo la cabecera (p. ej. que el servidor no publica modelos).
	Warning string
	// Notes se imprimen bajo la cabecera: por qué no hay sesión o proveedor y qué hacer.
	Notes []string
	// UpdateNotice consulta en segundo plano si hay una versión nueva; nil la desactiva.
	UpdateNotice func(ctx context.Context) (version string, ok bool)
}

type liveState struct {
	content          strings.Builder
	reasoning        strings.Builder
	reasoningStarted time.Time
	reasoningSecs    float64
	spoke            bool
	lastProse        string
	usedTools        bool
}

// promptState captura el siguiente Enter como respuesta a una pregunta de
// texto libre (ask_user, el mensaje de un commit, una API key…).
type promptState struct {
	label    string
	onSubmit func(text string) tea.Cmd
	onCancel func()
}

// Model es el modelo de Bubble Tea del chat interactivo. Su estado solo lo
// toca la goroutine de la interfaz; el turno corre en otra y le habla por
// mensajes.
type Model struct {
	chat *chat.Chat
	opts Options

	input         textarea.Model
	width, height int

	send    func(tea.Msg)
	observe func(string)

	log transcript
	// out lleva lo impreso al scrollback de la terminal; es nil sin programa
	// (pruebas), donde el transcript es lo único que se conserva.
	out          *printer
	pager        *pager
	printHeld    bool
	resumeQueued bool
	// onReady corre con el primer tamaño de ventana conocido, cuando ya se
	// puede dibujar la cabecera al ancho real.
	onReady func() tea.Cmd

	running     bool
	interrupted bool
	turn        int
	cancel      context.CancelFunc
	started     time.Time
	live        liveState
	queue       []string
	spin        int

	remote     *remoteHost
	picker     *picker
	prompt     *promptState
	busy       string
	todo       []tools.TodoItem
	menu       []Spec
	menuCursor int
	menuHidden bool

	hist     *inputHistory
	histPos  int
	draft    string
	quitHint time.Time
	quitting bool

	lastAnswer string
	ctxTokens  int
	ctxPct     float64
	online     bool
	notice     string

	md      *glamour.TermRenderer
	mdWidth int
}

func New(c *chat.Chat, opts Options) *Model {
	ta := textarea.New()
	ta.ShowLineNumbers = false
	ta.Placeholder = placeholderFor(c)
	ta.DynamicHeight = true
	ta.MinHeight = 1
	ta.MaxHeight = 8
	ta.CharLimit = 0
	ta.SetVirtualCursor(true)
	ta.SetPromptFunc(2, func(info textarea.PromptInfo) string {
		if info.LineNumber == 0 {
			return glyphDot + " "
		}
		return "  "
	})
	ta.KeyMap.InsertNewline = key.NewBinding(key.WithKeys("alt+enter", "ctrl+j", "shift+enter"))
	styles := textarea.DefaultDarkStyles()
	styles.Focused.CursorLine = styles.Focused.Text
	ta.SetStyles(styles)
	ta.SetWidth(76)
	ta.Focus()

	m := &Model{
		chat:   c,
		opts:   opts,
		input:  ta,
		width:  80,
		height: 24,
		hist:   loadInputHistory(opts.HistoryFile),
		online: !opts.Offline,
		send:   func(tea.Msg) {},
	}
	m.log.resize(m.width)
	m.histPos = len(m.hist.entries)
	m.refreshContext()
	return m
}

// Wire conecta la interfaz con el programa: send entrega mensajes desde otras
// goroutines; observe (opcional) ve cada texto que entra en el transcript.
func (m *Model) Wire(send func(tea.Msg), observe func(string)) {
	m.send, m.observe = send, observe
	m.chat.Session.Approver = &uiApprover{send: send}
	m.chat.Toolbox.AskUser = askUser(send)
	m.chat.Toolbox.OnTodo = func(items, previous []tools.TodoItem) { send(todoMsg{items, previous}) }
}

// print añade texto al transcript y lo manda al scrollback de la terminal, de
// modo que la rueda, la selección y la copia son las de la propia terminal.
func (m *Model) print(text string) {
	m.emit(m.log.add(text))
	if m.observe != nil {
		m.observe(text)
	}
}

// printDynamic imprime una entrada que se redibuja al cambiar el ancho en el
// visor del transcript; en el scrollback queda como se dibujó.
func (m *Model) printDynamic(render func(width int) string) {
	rows := m.log.addDynamic(render)
	m.emit(rows)
	if m.observe != nil {
		m.observe(strings.Join(rows, "\n"))
	}
}

func (m *Model) emit(rows []string) {
	if m.out == nil {
		return
	}
	// insertAbove ignora el texto vacío; una fila en blanco ha de llevar algo.
	text := strings.Join(rows, "\n")
	if text == "" {
		text = " "
	}
	m.out.put(tea.Println(text)())
}

// clearScreen vacía la pantalla, el scrollback y el transcript, para que la rueda
// no enseñe conversaciones anteriores; la cabecera la
// reimprime quien llama.
func (m *Model) clearScreen() {
	m.log.reset()
	if m.out == nil {
		return
	}
	m.out.put(tea.Raw(ansi.EraseEntireScreen + ansi.EraseEntireDisplay + ansi.CursorHomePosition)())
	m.out.put(tea.ClearScreen())
	m.out.put(firstFrameDelay)
}

func placeholderFor(c *chat.Chat) string {
	switch {
	case c.Session.PlanMode:
		return "modo plan: el agente explora y propone, sin tocar nada"
	case c.Mode == chat.ModeAgent:
		return "describe qué hacer en el workspace, o / para los comandos"
	case c.Mode == chat.ModeDelegate:
		return "escribe, o pulsa / para los comandos"
	}
	return "pregunta lo que quieras, o / para los comandos"
}

func (m *Model) refreshContext() {
	m.ctxTokens, m.ctxPct = m.chat.ContextUsage()
	m.input.Placeholder = placeholderFor(m.chat)
}

// modeName es el modo que se muestra: plan es un modo del agente.
func (m *Model) modeName() string {
	if m.chat.Mode == chat.ModeAgent && m.chat.Session.PlanMode {
		return "plan"
	}
	return m.chat.Mode
}

func (m *Model) Init() tea.Cmd { return tea.Batch(m.input.Focus(), m.updateNoticeCmd()) }

func (m *Model) markdown(text string) string {
	width := max(40, m.width-4)
	if m.md == nil || m.mdWidth != width {
		style := os.Getenv("GLAMOUR_STYLE")
		if style == "" {
			style = "dark"
		}
		renderer, err := glamour.NewTermRenderer(glamour.WithStandardStyle(style), glamour.WithWordWrap(width))
		if err != nil {
			return text
		}
		m.md, m.mdWidth = renderer, width
	}
	out, err := m.md.Render(text)
	if err != nil {
		return text
	}
	return strings.Trim(out, "\n")
}

func (m *Model) saveConfig() { _ = config.Save(m.chat.ConfigPath, m.chat.Cfg) }

func (m *Model) historyFile() string {
	if m.opts.HistoryFile != "" {
		return m.opts.HistoryFile
	}
	return filepath.Join(filepath.Dir(m.chat.ConfigPath), "history")
}

type todoItem = tools.TodoItem
