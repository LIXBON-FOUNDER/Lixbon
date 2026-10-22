package tui

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/glamour/v2"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/tools"
	"lixbon.com/cli/internal/update"
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
	UpdateNotice func(ctx context.Context) (update.Outcome, bool)
	// CoreSummary pide al abrir el resumen del trabajo activo y la Attention del
	// Core (LXO-106); nil lo desactiva. Va aparte del aviso de versión.
	CoreSummary func(ctx context.Context) ([]string, error)
}

type liveState struct {
	content          strings.Builder
	reasoning        strings.Builder
	reasoningStarted time.Time
	reasoningSecs    float64
	spoke            bool
	lastProse        string
	usedTools        bool
	// prose es content ya limpio del JSON de las llamadas; answer, la
	// respuesta que se va escribiendo en el transcript, y drawn, lo pintado.
	prose  string
	answer *entry
	drawn  string
	drawAt time.Time
	// calling es la llamada que el modelo está escribiendo (herramienta,
	// destino y caracteres de argumentos).
	calling callProgress
}

type callProgress struct {
	tool, target string
	chars        int
}

// promptState captura el siguiente Enter como respuesta a una pregunta de
// texto libre (ask_user, el mensaje de un commit, una API key…).
type promptState struct {
	label    string
	onSubmit func(text string) tea.Cmd
	onCancel func()
	token    any
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
	// gfx pinta las imágenes con Sixel encima de sus miniaturas; nil sin
	// terminal (pruebas).
	gfx *graphics

	log    transcript
	scroll int
	pager  *pager
	sel    *selection
	// copyText escribe en el portapapeles del sistema; las pruebas lo sustituyen.
	copyText func(string) error
	// winTop y winRows describen la ventana del transcript del último fotograma:
	// con ellas el ratón se traduce a filas del transcript.
	winTop, winRows int
	// winY es la fila de pantalla donde empieza el transcript (tras la barra
	// superior); panelY, donde empieza el panel abierto (-1 si no hay).
	winY, panelY int
	// Rectángulo del panel anclado a un botón y el botón recién pulsado.
	panelX, panelW, panelH int
	clickAnchor            *anchor
	// turnMode es el modo con el que arrancó el turno en curso: el de la
	// sesión se puede cambiar mientras el agente trabaja.
	turnMode string
	// Zonas clicables del último fotograma.
	barShown           bool
	barPlan, footModel span
	footMode           span

	// alwaysAllowed avisa en el pie de que no se pregunta más.
	alwaysAllowed bool
	// autoRunDefault es si el agente ejecuta comandos sin preguntar al
	// arrancar (configuración o --auto-run): el modo agente vuelve a él.
	autoRunDefault bool
	// inputTop es la fila de la caja en la que empieza el texto; inputY, la de
	// la pantalla (-1 si la caja no se ve).
	inputTop, inputY int

	// liveReal son los tokens reales de los pasos terminados; liveChars y
	// charsPerToken estiman el paso en curso.
	liveChars     int
	liveReal      int
	charsPerToken float64

	running     bool
	interrupted bool
	turn        int
	cancel      context.CancelFunc
	started     time.Time
	live        liveState
	// autoCompacting: el agente está compactando el contexto por su cuenta.
	autoCompacting bool
	// pendingThought es lo pensado en el turno que aún espera la acción a la
	// que se pega.
	pendingThought thinkBlock
	// updateReady es la versión ya instalada que espera a que se reinicie.
	updateReady string
	queue       []string
	spin        int
	tickOn      bool
	relayoutGen int

	// Bloques del turno que todavía cambian: la herramienta en marcha, el
	// grupos de lecturas y del navegador en curso y el plan.
	openTool *entry
	// askEntry es la fila «Preguntar» de la última ask_user: sus respuestas
	// van debajo.
	askEntry *entry
	// imageEntry es la fila «Mostrar» abierta; pendingImage, la imagen que
	// llegó antes que su fila.
	imageEntry   *entry
	// liveTools son los pasos que dejaron un comando en segundo plano: se
	// repintan cuando cambia cuántos siguen vivos (● pasa a ✓).
	liveTools []*entry
	liveSeen  int
	pendingImage *tools.ShownImage
	readGroup    *entry
	browserGroup *entry
	todoEntry    *entry
	todoTurn     int
	// El riel del turno (rail.go): dónde empieza el turno en el transcript,
	// su cabecera, el último paso del riel y si lo que se añade cuelga de él.
	turnStart          int
	turnHead, railTail *entry
	railing            bool

	// chips son las imágenes en cola, en el orden de las de chat: el marcador
	// [IMG#n] apunta a la n-ésima.
	chips []imageChip

	remote     *remoteHost
	compacting *compactState
	// folding es la conversación plegándose tras compactarla.
	folding *foldState
	// answerEntry es la última respuesta del turno; anchorTop, la que el
	// siguiente fotograma debe dejar arriba de la ventana.
	answerEntry, anchorTop *entry
	// footY es la fila del pie en el último fotograma: con un transcript
	// corto no es la última de la pantalla.
	footY int
	// moreY es la fila del botón «↓ n líneas más» (-1 si no está).
	moreY   int
	moreBtn span
	// remoteOrigin: el turno que arranca lo pidió el móvil o la web.
	remoteOrigin  bool
	login         *loginView
	picker        *picker
	prompt        *promptState
	busy          string
	todo          []tools.TodoItem
	menu          []menuItem
	menuFiles     bool
	menuQuery     string
	menuCursor    int
	menuHidden    bool
	files         *fileIndex
	shortcutsOpen bool

	hist     *inputHistory
	histPos  int
	draft    string
	quitHint time.Time
	quitting bool

	lastAnswer string
	// sessionTokens y ctxTokens son copias que hace refreshContext: View no
	// lee m.chat, que el turno modifica desde otra goroutine.
	sessionTokens int
	ctxTokens     int
	ctxPct        float64
	online        bool
	branch        string
	notice        string

	// capturing recoge lo que imprimen los comandos de ajuste o consulta para
	// mostrarlo en el pie o en un panel; asyncQuiet es el título del panel de
	// un comando así que sigue en segundo plano.
	capturing  *[]block
	asyncQuiet string
	toastText  string
	toastGen   int
	header     *entry
	headerKey  string
	repoRoot   string
	quota      *quotaState
	footProcs  span
	footEffort span
	barBranch  span
	// hoverX y hoverY son dónde está el ratón: las zonas clicables se iluminan.
	hoverX, hoverY int

	md      *glamour.TermRenderer
	mdWidth int
	mdTheme int
}

func New(c *chat.Chat, opts Options) *Model {
	ta := textarea.New()
	ta.ShowLineNumbers = false
	ta.Placeholder = placeholderFor(c)
	ta.DynamicHeight = true
	ta.MinHeight = 1
	ta.MaxHeight = 8
	ta.CharLimit = 0
	ta.SetVirtualCursor(false)
	ta.SetPromptFunc(2, func(info textarea.PromptInfo) string {
		if info.LineNumber == 0 {
			return glyphPrompt + " "
		}
		return "  "
	})
	ta.KeyMap.InsertNewline = key.NewBinding(key.WithKeys("alt+enter", "ctrl+j", "shift+enter"))
	ta.SetStyles(inputStyles())
	ta.SetWidth(76)
	ta.Focus()

	m := &Model{
		chat:     c,
		opts:     opts,
		input:    ta,
		width:    80,
		height:   24,
		hist:     loadInputHistory(opts.HistoryFile),
		copyText: copyToClipboard,
		online:   !opts.Offline,
		send:     func(tea.Msg) {},
		hoverX:   -1,
		hoverY:   -1,
		moreY:    -1,
	}
	m.log.resize(m.width)
	m.histPos = len(m.hist.entries)
	m.autoRunDefault = c.Session.AutoRunCommands
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
	m.chat.Toolbox.OnImage = func(img tools.ShownImage) { send(imageShownMsg{img}) }
}

// imageShownMsg: el agente enseñó una imagen (show_image).
type imageShownMsg struct{ img tools.ShownImage }

// attachImage pone la imagen bajo la fila «Mostrar»; si la fila aún no llegó,
// espera a que llegue.
func (m *Model) attachImage(img tools.ShownImage) {
	b, ok := m.imageEntryBlock()
	if !ok {
		m.pendingImage = &img
		return
	}
	b.image = &shownImage{path: img.Path, caption: img.Caption, thumb: newThumb(img.Path)}
	b.meta = "clic la abre"
	if img.W > 0 {
		b.meta = fmt.Sprintf("%d×%d   clic la abre", img.W, img.H)
	}
	m.pendingImage = nil
	m.refresh(m.imageEntry)
}

func (m *Model) imageEntryBlock() (*toolBlock, bool) {
	if m.imageEntry == nil {
		return nil, false
	}
	b, ok := m.imageEntry.b.(*toolBlock)
	return b, ok && b.image == nil
}

// print añade texto ya pintado al transcript.
func (m *Model) print(text string) *entry { return m.add(textBlock(text)) }

// printDynamic imprime una entrada que se redibuja cuando cambia el ancho.
func (m *Model) printDynamic(render func(width int) string) *entry { return m.add(funcBlock(render)) }

// add añade un bloque. Si el usuario había subido con el scroll, la vista se
// queda donde estaba en vez de saltar al final.
func (m *Model) add(b block) *entry {
	if m.capturing != nil {
		*m.capturing = append(*m.capturing, b)
		e := &entry{b: b, detached: true, text: b.render(max(20, m.width-4), true)}
		if m.observe != nil {
			m.observe(e.text)
		}
		return e
	}
	rail := railNone
	if m.railing {
		rail = railMid
	}
	e := m.log.addRail(b, rail)
	if m.scroll > 0 {
		m.scroll += len(e.rows)
	}
	if m.observe != nil {
		m.observe(e.text)
	}
	return e
}

// addOutside añade un bloque fuera del riel aunque el turno lo tenga abierto.
func (m *Model) addOutside(b block) *entry {
	railing := m.railing
	m.railing = false
	defer func() { m.railing = railing }()
	return m.add(b)
}

// insertAt mete un bloque en medio del transcript (la cabecera del turno).
func (m *Model) insertAt(i int, b block) *entry {
	e := m.log.insert(i, b)
	if m.scroll > 0 {
		m.scroll += len(e.rows)
	}
	m.sel = nil
	return e
}

// refresh vuelve a pintar un bloque que cambió (una herramienta que terminó,
// el plan que avanza…). Si queda por debajo de la ventana, el scroll se
// compensa para que lo que se está leyendo no se mueva.
func (m *Model) refresh(e *entry) {
	if e.detached {
		return
	}
	total := m.log.total()
	start, delta := m.log.refresh(e)
	if delta != 0 {
		if m.scroll > 0 && start >= total-m.scroll {
			m.scroll = max(0, m.scroll+delta)
		}
		if m.sel != nil {
			if _, to := m.sel.bounds(); start <= to.row {
				m.sel = nil
			}
		}
	}
	if m.observe != nil {
		m.observe(e.text)
	}
}

// remove quita un bloque que ya no debe verse (una respuesta en curso que
// resultó ser solo fontanería).
func (m *Model) remove(e *entry) {
	if e.detached {
		return
	}
	rows := m.log.remove(e)
	if m.scroll > 0 {
		m.scroll = max(0, m.scroll-rows)
	}
	if m.answerEntry == e {
		m.answerEntry = nil
	}
	if m.anchorTop == e {
		m.anchorTop = nil
	}
	m.sel = nil
}

func (m *Model) toggleDetail() {
	m.log.setDetail(!m.log.detail)
	m.sel = nil
}

func placeholderFor(c *chat.Chat) string {
	switch {
	case c.Session.PlanMode:
		return "Pídele un plan a lixbon"
	case c.Mode == chat.ModeDelegate:
		return "Escribe, o / para los comandos"
	}
	return "Pídele algo a lixbon"
}

func (m *Model) refreshContext() {
	m.ctxTokens, m.ctxPct = m.chat.ContextUsage()
	m.sessionTokens = m.chat.SessionTokens
	m.input.Placeholder = placeholderFor(m.chat)
	m.syncHeader()
}

func (m *Model) Init() tea.Cmd {
	cmds := []tea.Cmd{m.input.Focus(), m.updateNoticeCmd(), m.coreSummaryCmd(), m.fetchQuota()}
	if m.login != nil {
		cmds = append(cmds, m.startTick())
	}
	if m.gfx != nil {
		cmds = append(cmds, queryGraphics())
	}
	return tea.Batch(cmds...)
}

// renderMarkdown pinta markdown al ancho dado; el renderer se reutiliza
// mientras no cambien el ancho ni el tema.
func (m *Model) renderMarkdown(text string, width int) string {
	width = max(20, width)
	if m.md == nil || m.mdWidth != width || m.mdTheme != themeVersion {
		renderer, err := newMarkdownRenderer(width, os.Getenv("GLAMOUR_STYLE"))
		if err != nil {
			return text
		}
		m.md, m.mdWidth, m.mdTheme = renderer, width, themeVersion
	}
	out, err := m.md.Render(text)
	if err != nil {
		return text
	}
	return strings.Trim(out, "\n")
}

func inputStyles() textarea.Styles {
	styles := textarea.DefaultStyles(pal.dark)
	text := sPrimary
	for _, st := range []*textarea.StyleState{&styles.Focused, &styles.Blurred} {
		st.Text = text
		st.CursorLine = text
		st.Placeholder = sDim2
		st.Prompt = sAccent
	}
	// El cursor de la terminal, en barra y del color de la señal.
	styles.Cursor.Shape, styles.Cursor.Color, styles.Cursor.Blink = tea.CursorBar, cAccent, true
	return styles
}

func (m *Model) saveConfig() { _ = config.Save(m.chat.ConfigPath, m.chat.Cfg) }

func (m *Model) historyFile() string {
	if m.opts.HistoryFile != "" {
		return m.opts.HistoryFile
	}
	return filepath.Join(filepath.Dir(m.chat.ConfigPath), "history")
}

type todoItem = tools.TodoItem
