package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf16"

	"runtime"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/session"
	"lixbon.com/cli/internal/toolparse"
	"lixbon.com/cli/internal/tools"
	"lixbon.com/cli/internal/toolspec"
	"lixbon.com/cli/internal/workspace"
)

// cmdDoneMsg cierra un trabajo asíncrono de un comando: imprime sus líneas y
// aplica los cambios de estado en la goroutine de la interfaz.
type cmdDoneMsg struct {
	lines []block
	apply func(*Model)
	// then arranca lo que sigue al comando, p. ej. el turno que prepara /visual.
	then func(*Model) tea.Cmd
}

// async ejecuta un trabajo lento fuera de la goroutine de la interfaz. Mientras
// dura, lo que se escriba queda en cola.
func (m *Model) async(label string, work func(ctx context.Context) cmdDoneMsg) tea.Cmd {
	m.busy = label
	m.notice = label + "…"
	return tea.Batch(func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		return work(ctx)
	}, m.startTick())
}

func (m *Model) busyNow() bool { return m.running || m.busy != "" }

func (m *Model) finishAsync(msg cmdDoneMsg) tea.Cmd {
	m.busy, m.notice = "", ""
	show := func() tea.Cmd {
		for _, b := range msg.lines {
			m.add(b)
		}
		if msg.apply != nil {
			msg.apply(m)
		}
		return nil
	}
	var cmds []tea.Cmd
	if cmd, ok := m.finishRemoteAsync(show); ok {
		cmds = append(cmds, cmd)
	} else if title := m.asyncQuiet; title != "" {
		m.asyncQuiet = ""
		cmds = append(cmds, m.captured(title, show))
	} else {
		show()
	}
	m.refreshContext()
	switch {
	case msg.then != nil:
		cmds = append(cmds, msg.then(m))
	case len(m.queue) > 0 && !m.running:
		cmds = append(cmds, m.dispatchQueued())
	}
	return tea.Batch(cmds...)
}

func (m *Model) runCommand(name, arg string) tea.Cmd {
	if m.chat.Client.Generic && slices.Contains(gatewayOnly, name) {
		m.add(note(fmt.Sprintf("«/%s» solo funciona con un gateway Lixbon (proveedor actual: %s). /provider cambia de proveedor.", name, m.chat.Cfg.ActiveProfile())))
		return nil
	}
	switch name {
	case "help":
		return m.cmdHelp(arg)
	case "model":
		return m.cmdModel(arg)
	case "mode":
		return m.cmdMode(arg)
	case "new":
		m.newConversation("conversación nueva")
		m.add(note("Conversación nueva: contexto vacío. La anterior queda en /history."))
	case "clear":
		m.log.reset()
		m.scroll, m.sel = 0, nil
		m.printHeader()
		m.newConversation("contexto limpio")
	case "compact":
		return m.cmdCompact()
	case "history":
		return m.cmdHistory(arg)
	case "web":
		return m.cmdWeb(arg)
	case "copy":
		m.cmdCopy()
	case "remote":
		return m.cmdRemote(arg)
	case "visual":
		return m.cmdVisual(arg)
	case "image":
		m.cmdImage(arg)
	case "paste":
		m.pasteImage()
	case "save":
		m.cmdSave(arg)
	case "approve":
		return m.cmdApprove(arg)
	case "plan":
		m.cmdPlan(arg)
	case "todo":
		m.cmdTodo()
	case "tools":
		m.cmdTools()
	case "diff":
		return m.cmdDiff(arg)
	case "undo":
		return m.cmdUndo()
	case "ps":
		return m.cmdPs()
	case "check":
		return m.cmdCheck(arg)
	case "allow":
		return m.cmdAllow(arg)
	case "workspace":
		return m.cmdWorkspace(arg)
	case "branch":
		return m.cmdBranch(arg)
	case "effort":
		return m.cmdEffort(arg)
	case "status":
		return m.cmdStatus()
	case "cost":
		m.cmdCost()
	case "usage":
		return m.cmdUsage()
	case "nodes":
		return m.cmdNodes()
	case "context-window":
		m.cmdContextWindow(arg)
	case "run":
		return m.cmdRun(arg)
	case "commit":
		return m.cmdCommit(arg)
	case "init":
		return m.cmdInit()
	case "key":
		return m.cmdKey(arg)
	case "login":
		return m.openLogin(loginCommand, stepMethod, "")
	case "logout":
		return m.cmdLogout()
	case "mcp":
		m.cmdMCP()
	case "provider":
		return m.cmdProvider(arg)
	case "orquestar":
		return m.cmdOrquestar(arg)
	case "orquestador":
		return m.cmdOrquestador()
	case "doctor":
		return m.cmdDoctor()
	case "update":
		return m.cmdUpdate()
	case "config":
		return m.cmdConfig()
	case "theme":
		return m.cmdTheme(arg)
	case "bar":
		m.add(note("La barra de estado de la versión Go va siempre al pie; /bar no hace falta."))
	case "exit":
		m.add(note("Hasta pronto."))
		return m.quit()
	default:
		m.add(warnLine("«/" + name + "» aún no está disponible en el CLI Go."))
	}
	return nil
}

// ── ayuda ────────────────────────────────────────────────────────────────

func (m *Model) cmdHelp(arg string) tea.Cmd {
	if arg == "plain" || arg == "list" {
		for _, group := range append(append([]string{}, Groups...), "propios") {
			report := reportBlock{title: group, keys: true}
			for _, s := range m.allSpecs() {
				if s.Group == group {
					report.rows = append(report.rows, [2]string{strings.TrimSpace("/" + s.Name + " " + s.Args), sDim.Render(s.Desc)})
				}
			}
			if len(report.rows) > 0 {
				m.add(report)
			}
		}
		return nil
	}
	var options []option
	for _, group := range append(append([]string{}, Groups...), "propios") {
		var rows []option
		for _, s := range m.allSpecs() {
			if s.Group == group {
				rows = append(rows, option{Label: strings.TrimSpace("/" + s.Name + " " + s.Args), Value: s.Name, Desc: s.Desc})
			}
		}
		if len(rows) > 0 {
			options = append(options, option{Label: group, Disabled: true})
			options = append(options, rows...)
		}
	}
	p := newPicker("Comandos", options, func(value string, cancelled bool) tea.Cmd {
		if cancelled {
			return nil
		}
		spec, ok := lookup(value)
		if ok && strings.HasPrefix(spec.Args, "<") && value != "key" {
			m.add(note(fmt.Sprintf("Uso: /%s %s %s %s", spec.Name, spec.Args, glyphSep, spec.Desc)))
			return nil
		}
		return m.dispatch("/" + value)
	})
	p.search, p.maxShown = true, 14
	p.keys = [][2]string{{"escribe", "filtra"}, {"↑↓", "mover"}, {"↵", "ejecutar"}, {"esc", "salir"}}
	m.picker = p
	return nil
}

// ── conversación ─────────────────────────────────────────────────────────

func (m *Model) modelLabel(id string) string {
	for _, mod := range m.opts.Account.Models {
		if mod.ID == id {
			return mod.Name
		}
	}
	return id
}

func (m *Model) cmdModel(arg string) tea.Cmd {
	if m.chat.Cfg.KeyModel != "" {
		m.add(errLine("Modelo fijo por la API key: " + m.chat.Cfg.KeyModel))
		return nil
	}
	models := m.opts.Account.Models
	if arg == "" {
		if len(models) == 0 {
			m.add(errLine(m.opts.Account.NoModelsError().Error()))
			return nil
		}
		options := make([]option, 0, len(models))
		cursor := 0
		for i, mod := range models {
			o := option{Label: mod.Name, Value: mod.ID, Extra: capabilityLabels(mod.Capabilities)}
			if mod.Name != mod.ID {
				o.Desc = mod.ID
			}
			if mod.NumCtx > 0 {
				o.Meta = sDim.Render(fmtContext(mod.NumCtx))
			}
			if mod.ID == m.chat.Model {
				o.Badge, cursor = "actual", i
			}
			options = append(options, o)
		}
		p := newPicker("Modelo", options, func(value string, cancelled bool) tea.Cmd {
			if !cancelled {
				m.chooseModel(value)
			}
			return nil
		})
		p.search = len(options) > 9
		p.cursor = cursor
		m.picker = p
		return nil
	}
	needle := strings.ToLower(arg)
	var matches []string
	for _, mod := range models {
		if strings.Contains(strings.ToLower(mod.ID), needle) || strings.Contains(strings.ToLower(mod.Name), needle) {
			matches = append(matches, mod.ID)
		}
	}
	switch len(matches) {
	case 0:
		m.chooseModel(arg)
	case 1:
		m.chooseModel(matches[0])
	default:
		options := make([]option, len(matches))
		for i, id := range matches {
			options[i] = option{Label: id, Value: id}
		}
		m.picker = newPicker("Coincidencias", options, func(value string, cancelled bool) tea.Cmd {
			if !cancelled {
				m.chooseModel(value)
			}
			return nil
		})
	}
	return nil
}

// capabilityLabels traduce las capacidades de Ollama que interesan al elegir.
func capabilityLabels(caps []string) string {
	names := map[string]string{"vision": "visión", "tools": "herramientas", "thinking": "razona"}
	var parts []string
	for _, c := range []string{"vision", "tools", "thinking"} {
		for _, have := range caps {
			if have != c {
				continue
			}
			style := sDim
			if c == "vision" {
				style = sPlan
			}
			parts = append(parts, style.Render(names[c]))
		}
	}
	return strings.Join(parts, sDim2.Render(" "+glyphSep+" "))
}

func fmtContext(n int) string {
	if n >= 1024 && n%1024 == 0 {
		return fmt.Sprintf("%dk", n/1024)
	}
	if n >= 1000 {
		return fmt.Sprintf("%dk", (n+500)/1000)
	}
	return fmt.Sprint(n)
}

func (m *Model) chooseModel(id string) {
	m.chat.SetModel(id)
	line := "Modelo: " + m.modelLabel(id)
	for _, mod := range m.opts.Account.Models {
		if mod.ID == id && mod.HasCapability("vision") {
			line += " " + glyphSep + " ve imágenes"
		}
	}
	m.add(okLine(line))
}

func (m *Model) setMode(mode string) {
	m.chat.Mode = mode
	m.chat.Cfg.Mode = mode
	m.saveConfig()
	if mode != chat.ModeAgent {
		m.chat.Session.PlanMode = false
	}
	m.refreshContext()
}

func (m *Model) cmdMode(arg string) tea.Cmd {
	apply := func(mode string) {
		m.setMode(mode)
		if mode == chat.ModeAgent {
			m.add(note("Workspace del agente: " + shortPath(m.chat.Workspace)))
		}
	}
	if slices.Contains([]string{"ask", "agent", "delegate"}, arg) {
		apply(arg)
		return nil
	}
	options := []option{
		{Label: "ask", Value: "ask", Desc: "chat normal con el modelo"},
		{Label: "agent", Value: "agent", Desc: "el modelo edita código en tu workspace"},
		{Label: "delegate", Value: "delegate", Desc: "auto-routing inteligente del servidor"},
	}
	p := newPicker("Modo de trabajo", options, func(value string, cancelled bool) tea.Cmd {
		if !cancelled {
			apply(value)
		}
		return nil
	})
	for i, o := range options {
		if o.Value == m.chat.Mode {
			p.cursor = i
		}
	}
	m.picker = p
	return nil
}

func (m *Model) newConversation(label string) {
	m.chat.NewConversation()
	if m.remote != nil {
		m.remote.reset()
	}
	m.lastAnswer = ""
	m.todo = nil
	m.gap()
	m.add(separator(label))
}

func (m *Model) cmdHistory(arg string) tea.Cmd {
	if slices.Contains([]string{"mensajes", "messages", "msg"}, strings.ToLower(arg)) {
		return m.historyMessages()
	}
	m.chat.Persist()
	all := slices.Contains([]string{"todas", "all", "todo"}, strings.ToLower(arg))
	var items []session.Header
	for _, item := range m.chat.Store.List(0) {
		if all || m.ownsConversation(item.Workspace) {
			items = append(items, item)
		}
		if len(items) == 50 {
			break
		}
	}
	if len(items) == 0 {
		if all {
			m.add(note("Todavía no hay conversaciones guardadas. Al primer mensaje empieza a guardarse sola."))
		} else {
			m.add(note("No hay conversaciones en " + shortPath(m.historyScope()) + ". /history todas enseña las de todas las carpetas."))
		}
		return nil
	}
	now := float64(time.Now().UnixNano()) / 1e9
	options := make([]option, len(items))
	for i, item := range items {
		title := item.Title
		if title == "" {
			title = "Sin título"
		}
		if r := []rune(title); len(r) > 60 {
			title = string(r[:60]) + glyphEllipsis
		}
		detail := fmt.Sprintf("%s %s %d mensaje%s", session.RelativeTime(now, item.UpdatedAt), glyphSep, item.Messages, plural(item.Messages, "", "s"))
		if item.Tools > 0 {
			detail += fmt.Sprintf(" %s %d acci%s", glyphSep, item.Tools, plural(item.Tools, "ón", "ones"))
		}
		if item.ID == m.chat.ConversationID {
			detail += " " + glyphSep + " actual"
		}
		options[i] = option{Label: title, Value: item.ID, Desc: detail}
		if all {
			options[i].Meta = sDim.Render(shortPath(item.Workspace))
		}
	}
	heading := "Conversaciones " + glyphSep + " " + shortPath(m.historyScope())
	if all {
		heading = "Conversaciones de todas las carpetas"
	}
	p := newPicker(heading, options, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled:
		case value == m.chat.ConversationID:
			m.add(note("Ya estás en esa conversación."))
		case !m.chat.Open(value):
			m.add(errLine("Esa conversación ya no está disponible."))
		default:
			m.refreshGit()
			m.files = nil
			m.replayTranscript()
			m.add(okLine("Conversación reabierta: " + firstNonEmpty(m.chat.Title(), "sin título")))
			m.refreshContext()
		}
		return nil
	})
	p.search = true
	p.keys = [][2]string{{"escribe", "filtra"}, {"↑↓", "mover"}, {"↵", "abrir"}, {"esc", "salir"}}
	m.picker = p
	return nil
}

// historyScope es de dónde son las conversaciones que lista /history: el
// repositorio entero si el workspace está en uno, si no la carpeta.
func (m *Model) historyScope() string { return firstNonEmpty(m.repoRoot, m.chat.Workspace) }

func (m *Model) ownsConversation(workspace string) bool {
	if workspace == "" {
		return false
	}
	if m.repoRoot != "" {
		return within(workspace, m.repoRoot)
	}
	return samePath(workspace, m.chat.Workspace)
}

func (m *Model) historyMessages() tea.Cmd {
	var mine []string
	for _, msg := range m.chat.History {
		if msg.Role == "user" && !strings.HasPrefix(msg.Content, "TOOL_RESULT") && !history.IsSummary(msg) {
			mine = append(mine, strings.Join(strings.Fields(msg.Content), " "))
		}
	}
	if len(mine) == 0 {
		m.add(note("Todavía no has enviado ningún mensaje en esta conversación."))
		return nil
	}
	mine = mine[max(0, len(mine)-30):]
	options := make([]option, len(mine))
	for i, text := range mine {
		label := text
		if r := []rune(label); len(r) > 70 {
			label = string(r[:70]) + glyphEllipsis
		}
		options[i] = option{Label: label, Value: text, Desc: fmt.Sprintf("mensaje %d", i+1)}
	}
	p := newPicker("Reenviar un mensaje", options, func(value string, cancelled bool) tea.Cmd {
		if cancelled {
			return nil
		}
		return m.startTurn(value, value)
	})
	p.cursor = len(options) - 1
	p.search = true
	m.picker = p
	return nil
}

// replayTranscript repinta una conversación reabierta: las herramientas se
// resumen en una línea cada una.
func (m *Model) replayTranscript() {
	m.gap()
	m.add(separator(firstNonEmpty(m.chat.Title(), "conversación")))
	for _, msg := range m.chat.History {
		content := strings.TrimSpace(msg.Content)
		if history.IsSummary(msg) {
			if msg.Role == "user" {
				m.gap()
				m.add(compactBlock{summary: history.SummaryText(msg)})
			}
			continue
		}
		switch msg.Role {
		case "user":
			if strings.HasPrefix(content, "TOOL_RESULT") {
				continue
			}
			m.gap()
			m.add(userBlock{text: content})
			m.print("")
		case "assistant":
			for _, raw := range msg.ToolCalls {
				call := toolparse.Native(rawToMap(raw))
				b := newToolBlock(agent.Event{Tool: firstNonEmpty(call.Tool, "herramienta")}, nil)
				b.state = toolDone
				m.add(b)
			}
			prose := content
			if m.chat.Mode == chat.ModeAgent {
				prose = toolparse.CleanProse(content)
			}
			if prose != "" {
				m.printAnswer(prose)
			}
		}
	}
	m.gap()
	m.add(separator("continúa la conversación"))
}

func (m *Model) cmdWeb(arg string) tea.Cmd {
	apply := func(mode string) {
		m.chat.WebMode = mode
		m.chat.Cfg.Extra["web_search"] = []byte(`"` + mode + `"`)
		m.saveConfig()
		m.refreshContext()
		m.add(okLine("Búsqueda web: " + mode))
	}
	if slices.Contains([]string{"auto", "on", "off"}, arg) {
		apply(arg)
		return nil
	}
	options := []option{
		{Label: "auto", Value: "auto", Desc: "el modelo decide cuándo hace falta buscar"},
		{Label: "on", Value: "on", Desc: "investiga en internet en cada respuesta"},
		{Label: "off", Value: "off", Desc: "solo el conocimiento del modelo"},
	}
	p := newPicker("Búsqueda web", options, func(value string, cancelled bool) tea.Cmd {
		if !cancelled {
			apply(value)
		}
		return nil
	})
	for i, o := range options {
		if o.Value == m.chat.WebMode {
			p.cursor = i
		}
	}
	m.picker = p
	return nil
}

func (m *Model) cmdCopy() {
	text := ""
	for i := len(m.chat.History) - 1; i >= 0; i-- {
		if m.chat.History[i].Role == "assistant" {
			text = m.chat.History[i].Content
			break
		}
	}
	if text == "" {
		m.add(note("No hay una respuesta para copiar."))
		return
	}
	if err := copyToClipboard(text); err != nil {
		m.add(errLine("No se pudo copiar: " + err.Error()))
		return
	}
	m.add(okLine("Respuesta copiada al portapapeles"))
}

func copyToClipboard(text string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// clip.exe interpreta UTF-16 con BOM; así no se pierden los acentos.
		units := utf16.Encode([]rune(text))
		buf := []byte{0xff, 0xfe}
		for _, u := range units {
			buf = append(buf, byte(u), byte(u>>8))
		}
		cmd = exec.Command("clip")
		cmd.Stdin = strings.NewReader(string(buf))
	case "darwin":
		cmd = exec.Command("pbcopy")
		cmd.Stdin = strings.NewReader(text)
	default:
		if _, err := exec.LookPath("wl-copy"); err == nil {
			cmd = exec.Command("wl-copy")
		} else {
			cmd = exec.Command("xclip", "-selection", "clipboard")
		}
		cmd.Stdin = strings.NewReader(text)
	}
	return cmd.Run()
}

func (m *Model) cmdSave(arg string) {
	if len(m.chat.History) == 0 {
		m.add(note("La conversación está vacía."))
		return
	}
	var path string
	if arg = strings.Trim(strings.TrimSpace(arg), `"`); arg != "" {
		path = expandHome(arg)
		if !filepath.IsAbs(path) {
			path = filepath.Join(m.chat.Workspace, path)
		}
	} else {
		path = filepath.Join(m.chat.Workspace, "lixbon-"+time.Now().Format("20060102-1504")+".md")
	}
	lines := []string{
		fmt.Sprintf("# Conversación Lixbon %s %s", glyphSep, filepath.Base(m.chat.Workspace)),
		"",
		"- Modelo: `" + m.chat.Model + "`",
		"- Modo: `" + m.chat.Mode + "`",
		"- Fecha: " + time.Now().Format("2006-01-02 15:04"),
		"",
	}
	for _, msg := range m.chat.History {
		content := strings.TrimSpace(msg.Content)
		if content == "" || msg.Role == "system" || msg.Role == "tool" {
			continue
		}
		if msg.Role == "user" && strings.HasPrefix(content, "TOOL_RESULT") {
			continue
		}
		heading := "## Lixbon"
		if msg.Role == "user" {
			heading = "## Tú"
		}
		if msg.Role == "assistant" && m.chat.Mode == chat.ModeAgent {
			content = toolparse.CleanProse(content)
		}
		lines = append(lines, heading, "", content, "")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		m.add(errLine("No se pudo guardar: " + err.Error()))
		return
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		m.add(errLine("No se pudo guardar: " + err.Error()))
		return
	}
	m.add(okLine("Conversación guardada en " + shortPath(path)))
}

// ── agente ───────────────────────────────────────────────────────────────

func (m *Model) cmdApprove(arg string) tea.Cmd {
	apply := func(on bool) {
		m.chat.Session.AutoApprove = on
		m.chat.Cfg.AutoApproveTools = on
		m.saveConfig()
		m.add(okLine("Auto-aprobar: " + onOff(on)))
	}
	if arg == "on" || arg == "off" {
		apply(arg == "on")
		return nil
	}
	options := []option{
		{Label: "on", Value: "on", Desc: "aplicar cambios sin preguntar (por defecto; el diff queda en el transcript)"},
		{Label: "off", Value: "off", Desc: "pedir confirmación en cada cambio"},
	}
	p := newPicker("Auto-aprobar herramientas del agente", options, func(value string, cancelled bool) tea.Cmd {
		if !cancelled {
			apply(value == "on")
		}
		return nil
	})
	if !m.chat.Session.AutoApprove {
		p.cursor = 1
	}
	m.picker = p
	return nil
}

func (m *Model) cmdPlan(arg string) {
	s := m.chat.Session
	switch arg {
	case "on":
		s.PlanMode = true
	case "off":
		s.PlanMode = false
	default:
		s.PlanMode = !s.PlanMode
	}
	if s.PlanMode {
		if m.chat.Mode != chat.ModeAgent {
			m.setMode(chat.ModeAgent)
		}
		m.add(okLine("Modo plan: el agente explora y propone; no toca archivos ni ejecuta nada. /plan off para que ejecute el plan."))
	} else {
		m.add(okLine("Modo plan desactivado: el agente vuelve a poder editar y ejecutar."))
	}
	m.refreshContext()
}

func (m *Model) cmdTodo() {
	if len(m.todo) == 0 {
		m.add(note("El agente no tiene lista de pasos en este momento."))
		return
	}
	m.printTodo(m.todo, nil)
}

func (m *Model) cmdTools() {
	s := m.chat.Session
	approve, commands := "pide confirmación", "siempre pregunta"
	if s.AutoApprove {
		approve = "sin preguntar"
	}
	if s.AutoRunCommands {
		commands = "sin preguntar"
	}
	report := reportBlock{title: fmt.Sprintf("Herramientas del modo agent %s workspace %s", glyphSep, shortPath(m.chat.Workspace)), keys: true}
	for _, spec := range toolspec.Specs() {
		permission := sDim2.Render(glyphTodo + " solo lectura")
		if !toolspec.IsReadOnly(spec.Name) {
			permission = sBeige.Render(glyphDot + " " + approve)
			if spec.Name == "run_command" {
				permission = sWarn.Render(glyphDot + " " + commands)
			}
		}
		report.rows = append(report.rows, [2]string{spec.Name, permission + sDim2.Render(" "+glyphSep+" ") + sDim.Render(spec.Description)})
	}
	protocol := "nativo (el modelo recibe las funciones)"
	if !s.NativeTools {
		protocol = "texto (el modelo no soporta herramientas nativas)"
	}
	report.foot = []string{"", sDim2.Render(glyphTodo + " solo lectura   " + glyphDot + " modifica tu disco"),
		sDim.Render("Protocolo:") + " " + sBeige.Render(protocol)}
	m.gap()
	m.add(report)
}

func (m *Model) git(ctx context.Context, timeout time.Duration, args ...string) (int, string) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = m.chat.Workspace
	out, err := cmd.CombinedOutput()
	switch {
	case err == nil:
		return 0, string(out)
	case ctx.Err() != nil:
		return 124, "git tardó demasiado en responder."
	}
	if _, lookErr := exec.LookPath("git"); lookErr != nil {
		return 127, "git no está instalado o no está en el PATH."
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode(), string(out)
	}
	return 1, string(out)
}

func (m *Model) cmdDiff(arg string) tea.Cmd {
	return m.async("leyendo cambios", func(ctx context.Context) cmdDoneMsg {
		if code, _ := m.git(ctx, 10*time.Second, "rev-parse", "--is-inside-work-tree"); code != 0 {
			return cmdDoneMsg{lines: []block{note(shortPath(m.chat.Workspace) + " no es un repositorio git.")}}
		}
		target := []string{}
		if arg = strings.TrimSpace(arg); arg != "" {
			target = []string{arg}
		}
		_, status := m.git(ctx, 20*time.Second, "status", "--short")
		if strings.TrimSpace(status) == "" {
			return cmdDoneMsg{lines: []block{okLine("El workspace está limpio: no hay cambios sin confirmar.")}}
		}
		_, stat := m.git(ctx, 20*time.Second, append([]string{"diff", "--stat", "--"}, target...)...)
		_, body := m.git(ctx, 20*time.Second, append([]string{"diff", "--unified=2", "--"}, target...)...)

		lines := []block{textBlock(""), separator("cambios sin confirmar")}
		changed := reportBlock{}
		for _, l := range firstLines(strings.TrimRight(status, "\n"), 40) {
			if len(l) > 3 {
				changed.rows = append(changed.rows, [2]string{strings.TrimSpace(l[:2]), sBeige.Render(l[3:])})
			}
		}
		lines = append(lines, changed)
		for _, f := range parseUnified(body) {
			lines = append(lines, &toolBlock{verb: "Cambios", target: f.path, adds: f.adds, dels: f.dels, counts: true,
				state: toolDone, diff: &diffView{rows: f.rows, path: f.path}})
		}
		if s := strings.TrimSpace(stat); s != "" {
			rows := strings.Split(s, "\n")
			lines = append(lines, note(strings.TrimSpace(rows[len(rows)-1])))
		}
		return cmdDoneMsg{lines: append(lines, textBlock(""))}
	})
}

func (m *Model) cmdUndo() tea.Cmd {
	s := m.chat.Session
	if len(s.UndoStack) == 0 {
		m.add(note("No hay cambios del agente que revertir en esta sesión."))
		return nil
	}
	entries := s.UndoStack[len(s.UndoStack)-1]
	seen := map[string]bool{}
	var files []string
	for _, e := range entries {
		if !seen[e.Path] {
			seen[e.Path] = true
			files = append(files, e.Path)
		}
	}
	slices.Sort(files)
	title := fmt.Sprintf("Revertir el último turno (%d archivo%s)", len(files), plural(len(files), "", "s"))
	list := strings.Join(files, ", ")
	if r := []rune(list); len(r) > 120 {
		list = string(r[:120])
	}
	p := newPicker(title, []option{
		{Label: "Sí, revertir", Value: "yes", Desc: list},
		{Label: "No", Value: "no", Desc: "dejar los archivos como están"},
	}, func(value string, cancelled bool) tea.Cmd {
		if cancelled || value != "yes" {
			return nil
		}
		done, err := s.Undo()
		for _, l := range done {
			m.add(note(l))
		}
		if err != nil {
			m.add(errLine("No se pudo revertir: " + err.Error()))
			return nil
		}
		if s.UndoIncomplete {
			m.add(warnLine("Ese turno también borró o movió carpetas enteras; eso no se revierte solo."))
		}
		m.add(okLine("Cambios revertidos. El modelo no lo sabe: díselo si quieres que continúe desde aquí."))
		m.chat.History = append(m.chat.History, history.User("[El usuario revirtió con /undo los archivos del último turno: "+
			strings.Join(files, ", ")+". Vuelven a estar como antes de ese turno.]"))
		m.refreshContext()
		return nil
	})
	m.picker = p
	return nil
}

func (m *Model) cmdPs() tea.Cmd { return m.openProcs() }

func (m *Model) cmdCheck(arg string) tea.Cmd {
	apply := func(on bool) {
		m.chat.Session.AutoCheck = on
		m.chat.Cfg.Extra["auto_check"] = []byte(fmt.Sprint(on))
		m.saveConfig()
		m.add(okLine("Verificación tras editar: " + onOff(on)))
	}
	if arg == "on" || arg == "off" {
		apply(arg == "on")
		return nil
	}
	options := []option{
		{Label: "on", Value: "on", Desc: "ruff/eslint/node --check/go parser sobre cada archivo que toca el agente"},
		{Label: "off", Value: "off", Desc: "solo cuando el modelo ejecute tests o build"},
	}
	p := newPicker("Verificación tras editar", options, func(value string, cancelled bool) tea.Cmd {
		if !cancelled {
			apply(value == "on")
		}
		return nil
	})
	if !m.chat.Session.AutoCheck {
		p.cursor = 1
	}
	m.picker = p
	return nil
}

func (m *Model) cmdAllow(arg string) tea.Cmd {
	s := m.chat.Session
	save := func() {
		s.OnAllowedCommands(s.AllowedCommands)
	}
	if arg = strings.TrimSpace(arg); arg != "" {
		if i := slices.Index(s.AllowedCommands, arg); i >= 0 {
			s.AllowedCommands = slices.Delete(s.AllowedCommands, i, i+1)
			m.add(okLine("«" + arg + "» vuelve a pedir confirmación."))
		} else {
			s.AllowedCommands = append(s.AllowedCommands, arg)
			m.add(okLine("«" + arg + "» se ejecutará sin preguntar (también en sesiones futuras)."))
		}
		save()
		return nil
	}
	if len(s.AllowedCommands) == 0 {
		m.add(note("Ningún comando permitido sin confirmación. Añade uno: /allow npm test"))
		return nil
	}
	options := make([]option, 0, len(s.AllowedCommands)+1)
	for _, p := range s.AllowedCommands {
		options = append(options, option{Label: p, Value: p, Desc: "se ejecuta sin preguntar"})
	}
	options = append(options, option{Label: "Cerrar", Value: "__close__"})
	p := newPicker("Comandos sin confirmación (elige uno para quitarlo)", options, func(value string, cancelled bool) tea.Cmd {
		if cancelled || value == "__close__" {
			return nil
		}
		if i := slices.Index(s.AllowedCommands, value); i >= 0 {
			s.AllowedCommands = slices.Delete(s.AllowedCommands, i, i+1)
			save()
			m.add(okLine("«" + value + "» vuelve a pedir confirmación."))
		}
		return nil
	})
	p.cursor = len(options) - 1
	m.picker = p
	return nil
}

// execShell ejecuta un comando del usuario en el workspace y deja su salida en
// el historial para que el modelo la vea en el siguiente turno.
func (m *Model) execShell(command string) tea.Cmd {
	m.gap()
	shell := &toolBlock{shell: true, verb: "Ejecutar", gerund: "Ejecutando", target: command, command: true, spin: &m.spin}
	m.openTool = m.add(shell)
	started := time.Now()
	return m.async("ejecutando "+truncateRunes(command, 40), func(ctx context.Context) cmdDoneMsg {
		result := m.chat.Toolbox.Execute(ctx, "run_command", map[string]any{"command": command, "timeout": float64(300)})
		elapsed := time.Since(started)
		body, code := result, "?"
		if rest, ok := strings.CutPrefix(result, "[EXIT "); ok {
			if n, after, found := strings.Cut(rest, "] "); found {
				code, body = n, after
			}
		}
		return cmdDoneMsg{apply: func(m *Model) {
			shell.state = toolDone
			shell.setOutput(result)
			shell.meta = seconds(elapsed)
			if m.openTool != nil && m.openTool.b == block(shell) {
				m.refresh(m.openTool)
				m.openTool = nil
			}
			m.print("")
			text := body
			if r := []rune(text); len(r) > 6000 {
				text = string(r[:6000])
			}
			m.chat.History = append(m.chat.History, history.User(fmt.Sprintf("TOOL_RESULT run_command `%s` (EXIT %s):\n%s", command, code, text)))
		}}
	})

}

func (m *Model) cmdRun(arg string) tea.Cmd {
	command := strings.TrimSpace(arg)
	if command == "" {
		m.add(errLine("Uso: /run npm test"))
		return nil
	}
	exec := func() tea.Cmd { return m.execShell(command) }
	if m.chat.Session.AutoRunCommands {
		return exec()
	}
	p := newPicker("Ejecutar «"+command+"»", []option{
		{Label: "Sí", Value: "yes", Desc: "se ejecuta en " + shortPath(m.chat.Workspace)},
		{Label: "Sí, y no preguntar más", Value: "always", Desc: "auto-ejecutar comandos el resto de la sesión"},
		{Label: "No", Value: "no", Desc: "cancelar"},
	}, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled || value == "no":
			return nil
		case value == "always":
			m.chat.Session.AutoRunCommands = true
		}
		return exec()
	})
	p.cancel = "no"
	m.picker = p
	return nil
}

func (m *Model) cmdCommit(arg string) tea.Cmd {
	return m.async("preparando el commit", func(ctx context.Context) cmdDoneMsg {
		code, status := m.git(ctx, 10*time.Second, "status", "--porcelain")
		if code != 0 {
			return cmdDoneMsg{lines: []block{errLine("El workspace no es un repositorio git.")}}
		}
		if strings.TrimSpace(status) == "" {
			return cmdDoneMsg{lines: []block{note("No hay cambios que confirmar.")}}
		}
		_, stat := m.git(ctx, 10*time.Second, "diff", "HEAD", "--stat")
		_, body := m.git(ctx, 20*time.Second, "diff", "HEAD")
		var untracked []string
		var lines []block
		for _, l := range strings.Split(status, "\n") {
			if strings.HasPrefix(l, "??") && len(l) > 3 {
				untracked = append(untracked, l[3:])
			}
		}
		statRows := strings.Split(strings.TrimSpace(stat), "\n")
		for _, l := range statRows[max(0, len(statRows)-12):] {
			if l = strings.TrimSpace(l); l != "" {
				lines = append(lines, note(l))
			}
		}
		if len(untracked) > 0 {
			more := ""
			if len(untracked) > 8 {
				more = glyphEllipsis
			}
			lines = append(lines, note("nuevos: "+strings.Join(untracked[:min(8, len(untracked))], ", ")+more))
		}
		message := strings.TrimSpace(arg)
		if message == "" {
			summary := body
			if r := []rune(summary); len(r) > 12000 {
				summary = string(r[:12000]) + "\n…[diff recortado]"
			}
			none := "ninguno"
			if len(untracked) > 0 {
				none = strings.Join(untracked, ", ")
			}
			text, err := m.chat.AskQuiet(ctx, []history.Message{
				{Role: "system", Content: "Escribe el mensaje de commit para este diff, en el idioma de los comentarios " +
					"del código o en español. Primera línea: tipo(alcance): resumen en imperativo, " +
					"máximo 72 caracteres. Después, si aporta, una línea en blanco y 1-4 viñetas " +
					"con el porqué. Responde SOLO con el mensaje."},
				history.User("Archivos nuevos: " + none + "\n\n" + summary),
			})
			if err != nil {
				return cmdDoneMsg{lines: append(lines, m.reportError(err))}
			}
			message = strings.Trim(strings.TrimSpace(text), "`")
		}
		if message == "" {
			return cmdDoneMsg{lines: append(lines, errLine("No se pudo redactar el mensaje; pásalo tú: /commit tu mensaje"))}
		}
		lines = append(lines, textBlock(""))
		for _, l := range strings.Split(message, "\n") {
			lines = append(lines, note(l))
		}
		return cmdDoneMsg{lines: lines, apply: func(m *Model) { m.confirmCommit(message) }}
	})
}

func (m *Model) confirmCommit(message string) {
	p := newPicker("¿Crear el commit con este mensaje?", []option{
		{Label: "Sí", Value: "yes", Desc: "git add -A && git commit"},
		{Label: "Editar el mensaje", Value: "edit", Desc: "escribirlo a mano"},
		{Label: "No", Value: "no", Desc: "cancelar"},
	}, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled || value == "no":
			return nil
		case value == "edit":
			m.promptFor("Mensaje del commit", func(text string) tea.Cmd {
				if strings.TrimSpace(text) == "" {
					return nil
				}
				return m.doCommit(strings.TrimSpace(text))
			})
			return nil
		}
		return m.doCommit(message)
	})
	m.picker = p
}

func (m *Model) doCommit(message string) tea.Cmd {
	return m.async("creando el commit", func(ctx context.Context) cmdDoneMsg {
		code, out := m.git(ctx, 20*time.Second, "add", "-A")
		if code == 0 {
			code, out = m.git(ctx, 30*time.Second, "commit", "-m", message)
		}
		out = strings.TrimSpace(out)
		if code != 0 {
			if r := []rune(out); len(r) > 400 {
				out = string(r[len(r)-400:])
			}
			return cmdDoneMsg{lines: []block{errLine(firstNonEmpty(out, "git commit falló"))}}
		}
		first, _, _ := strings.Cut(out, "\n")
		return cmdDoneMsg{lines: []block{okLine(firstNonEmpty(first, "Commit creado."))}}
	})
}

func (m *Model) cmdInit() tea.Cmd {
	target := filepath.Join(m.chat.Workspace, "LIXBON.md")
	generate := func() tea.Cmd {
		return m.async("analizando el proyecto", func(ctx context.Context) cmdDoneMsg {
			tree := tools.WorkspaceTree(m.chat.Workspace, 200)
			prompt := "Analiza este proyecto y escribe un LIXBON.md breve (máximo 60 líneas) que sirva " +
				"de contexto permanente para un asistente de código. Incluye: qué es el proyecto, " +
				"stack y estructura, cómo se ejecuta y se prueba, y convenciones que haya que " +
				"respetar. Responde SOLO con el Markdown del archivo, sin explicaciones ni ```.\n\n" +
				"Carpeta: " + filepath.Base(m.chat.Workspace) + "\nÁrbol:\n" + tree
			text, err := m.chat.AskQuiet(ctx, []history.Message{history.User(prompt)})
			if err != nil {
				return cmdDoneMsg{lines: []block{m.reportError(err)}}
			}
			content := strings.TrimSpace(text)
			if content == "" {
				return cmdDoneMsg{lines: []block{errLine("El modelo no devolvió contenido; inténtalo de nuevo.")}}
			}
			if strings.HasPrefix(content, "```") {
				_, rest, _ := strings.Cut(content, "\n")
				if i := strings.LastIndex(rest, "```"); i >= 0 {
					rest = rest[:i]
				}
				content = strings.TrimSpace(rest)
			}
			if err := os.WriteFile(target, []byte(content+"\n"), 0o644); err != nil {
				return cmdDoneMsg{lines: []block{errLine("No se pudo escribir LIXBON.md: " + err.Error())}}
			}
			adds := strings.Count(content, "\n") + 1
			return cmdDoneMsg{
				apply: func(m *Model) {
					m.add(&toolBlock{verb: "Escribir", target: "LIXBON.md", adds: adds, counts: true, state: toolDone})
					m.add(okLine("LIXBON.md creado: se cargará como contexto en cada sesión de esta carpeta."))
					m.chat.ProjectContext = workspace.ProjectContext(m.chat.Workspace)
					m.chat.Session.ProjectContext = m.chat.ProjectContext
				},
			}
		})
	}
	if _, err := os.Stat(target); err != nil {
		return generate()
	}
	p := newPicker("Ya existe LIXBON.md", []option{
		{Label: "Regenerarlo", Value: "yes", Desc: "se sobrescribe con un análisis nuevo"},
		{Label: "Cancelar", Value: "no", Desc: "dejar el archivo como está"},
	}, func(value string, cancelled bool) tea.Cmd {
		if cancelled || value != "yes" {
			return nil
		}
		return generate()
	})
	p.cursor = 1
	m.picker = p
	return nil
}

// ── cuenta y sistema ─────────────────────────────────────────────────────

func (m *Model) cmdStatus() tea.Cmd {
	generic, online := m.chat.Client.Generic, m.online
	return m.async("consultando la cuenta", func(ctx context.Context) cmdDoneMsg {
		quota := "sin conexión"
		if generic {
			quota = "no aplica"
		} else if u, err := m.chat.Client.Usage(ctx); err == nil {
			pct := func(b api.Bucket) string {
				if b.Unlimited {
					return "∞"
				}
				return fmt.Sprintf("%d%%", min(100, int(b.Percent+0.5)))
			}
			quota = fmt.Sprintf("sesión %s  %s  semana %s", pct(u.Buckets.Session), glyphSep, pct(u.Buckets.Week))
		}
		s := m.chat.Session
		approve, commands := "pide confirmación", "pide confirmación"
		if s.AutoApprove {
			approve = "sin preguntar"
		}
		if s.AutoRunCommands {
			commands = "sin preguntar"
		}
		plan := "desconocido"
		if p := m.chat.Cfg.ExtraString("plan_name"); generic {
			plan = "proveedor externo"
		} else if p != "" {
			plan = "Lixbon " + p
		}
		project := "sin LIXBON.md (/init)"
		if m.chat.ProjectContext != "" {
			project = "LIXBON.md cargado"
		}
		window := fmt.Sprintf("últimos %d mensajes", m.chat.Cfg.MaxContextMessages)
		if m.chat.Mode == chat.ModeAgent {
			window = "se envía el turno entero"
		}
		conn := "conectado"
		if quota == "sin conexión" || generic && !online {
			conn = "sin conexión"
		}
		rows := [][3]string{
			{"Proveedor", m.chat.Cfg.ActiveProfile(), providerHost(m.chat.Client.BaseURL)},
			{"Modelo", firstNonEmpty(m.chat.Model, "no configurado"), ""},
			{"Plan", plan, ""},
			{"Cuota", quota, ""},
			{"Modo", m.chat.Mode, fmt.Sprintf("cambios %s  %s  comandos %s", approve, glyphSep, commands)},
			{"Sesión", m.sessionLabel(), "clave " + config.MaskKey(m.chat.Cfg.APIKey)},
			{"Servidor", m.chat.Client.BaseURL, conn},
			{"Workspace", shortPath(m.chat.Workspace), project},
			{"Ventana de contexto", fmt.Sprintf("%d tokens", m.chat.Cfg.ContextWindow), window},
			{"Extras", "búsqueda web " + m.chat.WebMode, ""},
		}
		report := reportBlock{title: "Estado de la sesión"}
		for _, r := range rows {
			value := sPrimary.Render(r[1])
			if r[2] != "" {
				value += sDim2.Render("  " + glyphSep + "  " + r[2])
			}
			report.rows = append(report.rows, [2]string{r[0], value})
		}
		return cmdDoneMsg{lines: []block{report}}
	})
}

func (m *Model) cmdCost() {
	tokens, pct := m.chat.ContextUsage()
	users, assistants := 0, 0
	for _, msg := range m.chat.History {
		switch msg.Role {
		case "user":
			users++
		case "assistant":
			assistants++
		}
	}
	sent := fmt.Sprintf("últimos %d", m.chat.Cfg.MaxContextMessages)
	if m.chat.Mode == chat.ModeAgent {
		sent = "el turno entero (se poda al llenarse)"
	}
	rows := [][2]string{
		{"Tokens de la sesión", fmtTokens(m.chat.SessionTokens)},
		{"Contexto en uso", fmt.Sprintf("%s / %s  (%.0f%%)", fmtTokens(tokens), fmtTokens(m.chat.Cfg.ContextWindow), pct)},
		{"Turnos", fmt.Sprintf("%d tuyos %s %d del modelo", users, glyphSep, assistants)},
		{"Mensajes que se envían", sent},
		{"Chars por token (medido)", fmt.Sprintf("%.2f", m.chat.Session.Estimator.CharsPerToken())},
	}
	report := reportBlock{title: "Consumo de la sesión"}
	for _, r := range rows {
		report.rows = append(report.rows, [2]string{r[0], sPrimary.Render(r[1])})
	}
	m.gap()
	m.add(report)
	if pct > 75 {
		m.add(warnLine("El contexto va lleno: /compact resume la conversación y libera espacio."))
	}
}

func (m *Model) cmdUsage() tea.Cmd {
	return m.async("consultando uso", func(ctx context.Context) cmdDoneMsg {
		u, err := m.chat.Client.Usage(ctx)
		if err != nil {
			return cmdDoneMsg{lines: []block{errLine("No se pudo obtener el uso. Verifica tu sesión. Error: " + err.Error())}}
		}
		report := reportBlock{title: "Uso de la cuenta", rows: [][2]string{{"Plan", sPrimary.Render(firstNonEmpty(u.Plan.Name, "-"))}}}
		for _, b := range []struct {
			label  string
			bucket api.Bucket
		}{{"Sesión (4h)", u.Buckets.Session}, {"Semana (todos los modelos)", u.Buckets.Week}} {
			if b.bucket.Unlimited {
				report.rows = append(report.rows, [2]string{b.label, sDim2.Render(strings.Repeat(glyphMeterOn, 24)) + "  " + sOK.Render("ilimitado")})
				continue
			}
			pct := min(100, int(b.bucket.Percent+0.5))
			report.rows = append(report.rows, [2]string{b.label, meter(float64(pct), 24) + sPrimary.Render(fmt.Sprintf("  %d%% usado", pct))})
			if reset := api.ResetIn(b.bucket.ResetAt, time.Now()); reset != "" {
				report.rows = append(report.rows, [2]string{"", sDim2.Render("Se reinicia " + reset)})
			} else if b.bucket.ResetAt == "" && b.bucket.Percent == 0 {
				report.rows = append(report.rows, [2]string{"", sDim2.Render("Empieza con tu próximo mensaje")})
			}
		}
		return cmdDoneMsg{lines: []block{report}}
	})
}

func (m *Model) cmdNodes() tea.Cmd {
	return m.async("consultando nodos", func(ctx context.Context) cmdDoneMsg {
		nodes, err := m.chat.Client.Nodes(ctx)
		if err != nil {
			return cmdDoneMsg{lines: []block{m.reportError(err)}}
		}
		if len(nodes) == 0 {
			return cmdDoneMsg{lines: []block{note("Sin nodos registrados; se usa el Ollama local del servidor.")}}
		}
		report := reportBlock{title: "Nodos del clúster"}
		for _, n := range nodes {
			icon := sOK.Render(glyphDot)
			if !n.Online {
				icon = sErr.Render(glyphTodo)
			}
			cb := ""
			if n.CircuitBreaker {
				cb = " " + sWarn.Render("[CB]")
			}
			report.rows = append(report.rows, [2]string{firstNonEmpty(n.Name, n.ID),
				icon + " " + sDim.Render(fmt.Sprintf("score %v %s %d modelos", n.Score, glyphSep, len(n.Models))) + cb})
		}
		return cmdDoneMsg{lines: []block{report}}
	})
}

func (m *Model) cmdContextWindow(arg string) {
	var n int
	if _, err := fmt.Sscanf(strings.TrimSpace(arg), "%d", &n); err != nil {
		m.add(errLine("Uso: /context-window 8192"))
		return
	}
	n = max(1024, n)
	m.chat.Cfg.ContextWindow = n
	m.chat.Session.ContextWindow = n
	m.saveConfig()
	m.refreshContext()
	m.add(okLine(fmt.Sprintf("Ventana de contexto: %d tokens", n)))
}

func (m *Model) cmdKey(arg string) tea.Cmd {
	if arg == "" {
		return m.openLogin(loginCommand, stepAPIKey, "")
	}
	return m.applyKey(arg)
}

func (m *Model) applyKey(key string) tea.Cmd {
	if key == "" {
		return nil
	}
	probe := *m.chat.Client
	probe.APIKey = key
	return m.async("verificando la clave", func(ctx context.Context) cmdDoneMsg {
		info, err := probe.KeyInfo(ctx)
		if err != nil {
			return cmdDoneMsg{lines: []block{errLine("Clave inválida: " + err.Error())}}
		}
		return cmdDoneMsg{lines: []block{okLine("API key actualizada")}, apply: func(m *Model) {
			m.chat.Client.APIKey = key
			m.chat.Cfg.APIKey = key
			m.chat.Cfg.KeyModel = info.KeyModel
			m.saveConfig()
			if info.KeyModel != "" {
				m.chat.SetModel(info.KeyModel)
			}
		}, then: func(m *Model) tea.Cmd { return m.refreshAccount() }}
	})
}

// refreshAccount vuelve a sondear la cuenta sin bloquear la interfaz.
func (m *Model) refreshAccount() tea.Cmd {
	return m.async("consultando la cuenta", func(ctx context.Context) cmdDoneMsg {
		acc := m.chat.QueryAccount(ctx)
		return cmdDoneMsg{apply: func(m *Model) {
			m.chat.ApplyAccount(acc)
			m.opts.Account = acc
			m.online = acc.State != chat.AccountOffline
		}}
	})
}

func (m *Model) cmdLogout() tea.Cmd {
	if m.chat.Cfg.APIKey == "" {
		m.add(note("No hay ninguna sesión activa."))
		return nil
	}
	who := m.sessionLabel()
	m.picker = newPicker("Cerrar la sesión de "+who, []option{
		{Label: "Sí, cerrar sesión", Value: "yes", Desc: "se borra la clave guardada en esta máquina"},
		{Label: "No", Value: "no", Desc: "seguir con la sesión actual"},
	}, func(value string, cancelled bool) tea.Cmd {
		if cancelled || value != "yes" {
			return nil
		}
		// La copia conserva la sesión para cerrarla también en el servidor.
		client := *m.chat.Client
		m.chat.ClearSession()
		m.chat.Model = ""
		m.add(okLine("Sesión cerrada. Usa /login para volver a entrar."))
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = client.Logout(ctx)
			return nil
		}
	})
	return nil
}

// ── utilidades ───────────────────────────────────────────────────────────

func (m *Model) promptFor(label string, onSubmit func(string) tea.Cmd) {
	m.add(askLine(label))
	m.prompt = &promptState{label: label, onSubmit: onSubmit}
}

// promptSecret pide una clave: lo escrito sale como • y no llega ni al
// transcript ni al historial.
func (m *Model) promptSecret(label string, onSubmit func(string) tea.Cmd) tea.Cmd {
	m.add(askLine(label))
	m.prompt = &promptState{label: label, onSubmit: onSubmit}
	ti, cmd := newSecretInput(m.width)
	m.secret = ti
	return cmd
}

func (m *Model) handleSecretKey(msg tea.KeyPressMsg) tea.Cmd {
	switch msg.String() {
	case "enter":
		value := strings.TrimSpace(m.secret.Value())
		if value == "" {
			return nil
		}
		p := m.prompt
		m.secret, m.prompt = nil, nil
		return p.onSubmit(value)
	case "esc", "ctrl+c":
		p := m.prompt
		m.secret, m.prompt = nil, nil
		if p != nil && p.onCancel != nil {
			p.onCancel()
		}
		m.add(note("cancelado"))
		return nil
	}
	var cmd tea.Cmd
	*m.secret, cmd = m.secret.Update(msg)
	return cmd
}

func maskKeyCommand(s string) string {
	parts := keyArg.FindStringSubmatch(s)
	return parts[1] + maskKey(parts[2])
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

func onOff(on bool) string {
	if on {
		return "on"
	}
	return "off"
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstLines(text string, n int) []string {
	lines := strings.Split(text, "\n")
	return lines[:min(n, len(lines))]
}

func expandHome(path string) string {
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, path[1:])
		}
	}
	return path
}

// shortPath es una ruta legible: ~ para el home y elisión por el medio si es larga.
func shortPath(path string) string {
	text := path
	if home, err := os.UserHomeDir(); err == nil && strings.HasPrefix(text, home) {
		text = "~" + text[len(home):]
	}
	const limit = 60
	r := []rune(text)
	if len(r) <= limit {
		return text
	}
	keep := limit - 1
	return string(r[:keep/3]) + glyphEllipsis + string(r[len(r)-(keep-keep/3):])
}

func rawToMap(raw []byte) map[string]any {
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}
