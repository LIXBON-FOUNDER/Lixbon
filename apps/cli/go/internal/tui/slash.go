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
	lines []string
	apply func(*Model)
}

// async ejecuta un trabajo lento fuera de la goroutine de la interfaz. Mientras
// dura, lo que se escriba queda en cola.
func (m *Model) async(label string, work func(ctx context.Context) cmdDoneMsg) tea.Cmd {
	m.busy = label
	m.notice = label + "…"
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		return work(ctx)
	}
}

func (m *Model) busyNow() bool { return m.running || m.busy != "" }

func (m *Model) finishAsync(msg cmdDoneMsg) tea.Cmd {
	m.busy, m.notice = "", ""
	for _, l := range msg.lines {
		m.print(l)
	}
	if msg.apply != nil {
		msg.apply(m)
	}
	m.refreshContext()
	if len(m.queue) > 0 && !m.running {
		next := m.queue[0]
		m.queue = m.queue[1:]
		return m.dispatch(next)
	}
	return nil
}

func (m *Model) runCommand(name, arg string) tea.Cmd {
	if m.chat.Client.Generic && slices.Contains(gatewayOnly, name) {
		m.print(note(fmt.Sprintf("«/%s» solo funciona con un gateway Lixbon (proveedor actual: %s). /provider cambia de proveedor.", name, m.chat.Cfg.ActiveProfile())))
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
		m.print(note("Conversación nueva: contexto vacío. La anterior queda en /history."))
	case "clear":
		m.newConversation("contexto limpio")
	case "compact":
		return m.cmdCompact()
	case "history":
		return m.cmdHistory(arg)
	case "web":
		return m.cmdWeb(arg)
	case "copy":
		m.cmdCopy()
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
		m.cmdWorkspace(arg)
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
		return m.cmdKey("")
	case "logout":
		return m.cmdLogout()
	case "mcp":
		m.cmdMCP()
	case "provider":
		return m.cmdProvider(arg)
	case "doctor":
		return m.cmdDoctor()
	case "config":
		return m.cmdConfig()
	case "bar":
		m.print(note("La barra de estado de la versión Go va siempre al pie; /bar no hace falta."))
	case "exit":
		m.print(note("Hasta pronto."))
		return m.quit()
	default:
		m.print(warnLine("«/" + name + "» aún no está disponible en el CLI Go."))
	}
	return nil
}

// ── ayuda ────────────────────────────────────────────────────────────────

func (m *Model) cmdHelp(arg string) tea.Cmd {
	if arg == "plain" || arg == "list" {
		var lines []string
		lines = append(lines, "")
		for _, group := range append(append([]string{}, Groups...), "propios") {
			var rows []string
			for _, s := range m.allSpecs() {
				if s.Group == group {
					cmd := strings.TrimSpace("/" + s.Name + " " + s.Args)
					rows = append(rows, "    "+sAccent.Render(fmt.Sprintf("%-26s", cmd))+" "+sDim.Render(s.Desc))
				}
			}
			if len(rows) > 0 {
				lines = append(lines, "  "+sDim2.Render(group))
				lines = append(lines, rows...)
			}
		}
		m.print(strings.Join(lines, "\n"))
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
		if ok && strings.HasPrefix(spec.Args, "<") {
			m.print(note(fmt.Sprintf("Uso: /%s %s %s %s", spec.Name, spec.Args, glyphSep, spec.Desc)))
			return nil
		}
		m.print(renderCommandEcho("/" + value))
		return m.dispatch("/" + value)
	})
	p.search, p.maxShown = true, 14
	p.hint = fmt.Sprintf("escribe para filtrar %s ↑↓ mover %s ↵ ejecutar %s esc salir", glyphSep, glyphSep, glyphSep)
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
		m.print(errLine("Modelo fijo por la API key: " + m.chat.Cfg.KeyModel))
		return nil
	}
	models := m.opts.Account.Models
	if arg == "" {
		if len(models) == 0 {
			m.print(errLine(m.opts.Account.NoModelsError().Error()))
			return nil
		}
		options := make([]option, 0, len(models))
		cursor := 0
		for i, mod := range models {
			o := option{Label: mod.Name, Value: mod.ID}
			if mod.Name != mod.ID {
				o.Desc = mod.ID
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

func (m *Model) chooseModel(id string) {
	m.chat.SetModel(id)
	m.print(okLine("Modelo: " + m.modelLabel(id)))
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
			m.print(note("Workspace del agente: " + shortPath(m.chat.Workspace)))
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
	m.lastAnswer = ""
	m.todo = nil
	m.print("\n" + sDim2.Render(strings.Repeat("─", 3)+" "+label+" "+strings.Repeat("─", max(3, m.width-len(label)-8))))
}

func (m *Model) cmdCompact() tea.Cmd {
	if len(m.chat.History) < 4 {
		m.print(note("La conversación aún es corta; nada que compactar."))
		return nil
	}
	before, _ := m.chat.ContextUsage()
	return m.async("compactando conversación", func(ctx context.Context) cmdDoneMsg {
		if err := m.chat.Compact(ctx, 2); err != nil {
			return cmdDoneMsg{lines: []string{errLine("No se pudo generar el resumen: " + err.Error())}}
		}
		after, _ := m.chat.ContextUsage()
		return cmdDoneMsg{lines: []string{okLine(fmt.Sprintf("Conversación compactada: %s %s %s tokens", fmtTokens(before), glyphArrow, fmtTokens(after)))}}
	})
}

func (m *Model) cmdHistory(arg string) tea.Cmd {
	if slices.Contains([]string{"mensajes", "messages", "msg"}, strings.ToLower(arg)) {
		return m.historyMessages()
	}
	m.chat.Persist()
	items := m.chat.Store.List(50)
	if len(items) == 0 {
		m.print(note("Todavía no hay conversaciones guardadas. Al primer mensaje empieza a guardarse sola."))
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
	}
	p := newPicker("Conversaciones", options, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled:
		case value == m.chat.ConversationID:
			m.print(note("Ya estás en esa conversación."))
		case !m.chat.Open(value):
			m.print(errLine("Esa conversación ya no está disponible."))
		default:
			m.replayTranscript()
			m.print(okLine("Conversación reabierta: " + firstNonEmpty(m.chat.Title(), "sin título")))
			m.refreshContext()
		}
		return nil
	})
	p.search = true
	p.hint = fmt.Sprintf("escribe para filtrar  ↑↓ mover  ↵ abrir  esc salir")
	m.picker = p
	return nil
}

func (m *Model) historyMessages() tea.Cmd {
	var mine []string
	for _, msg := range m.chat.History {
		if msg.Role == "user" && !strings.HasPrefix(msg.Content, "TOOL_RESULT") {
			mine = append(mine, strings.Join(strings.Fields(msg.Content), " "))
		}
	}
	if len(mine) == 0 {
		m.print(note("Todavía no has enviado ningún mensaje en esta conversación."))
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
	m.print("\n" + sDim2.Render("─── "+firstNonEmpty(m.chat.Title(), "conversación")+" ───"))
	for _, msg := range m.chat.History {
		content := strings.TrimSpace(msg.Content)
		switch msg.Role {
		case "user":
			if strings.HasPrefix(content, "TOOL_RESULT") {
				continue
			}
			m.print("\n" + renderUserMessage(content, m.width))
		case "assistant":
			for _, raw := range msg.ToolCalls {
				call := toolparse.Native(rawToMap(raw))
				name := firstNonEmpty(call.Tool, "herramienta")
				m.print("\n" + renderAction(agent.Event{Tool: name, ReadOnly: true}, m.width))
			}
			prose := content
			if m.chat.Mode == chat.ModeAgent {
				prose = toolparse.CleanProse(content)
			}
			if prose != "" {
				m.print("\n" + renderSpeaker("", m.width))
				m.print(m.markdown(prose))
			}
		}
	}
	m.print("\n" + sDim2.Render("─── continúa la conversación ───"))
}

func (m *Model) cmdWeb(arg string) tea.Cmd {
	apply := func(mode string) {
		m.chat.WebMode = mode
		m.chat.Cfg.Extra["web_search"] = []byte(`"` + mode + `"`)
		m.saveConfig()
		m.refreshContext()
		m.print(okLine("Búsqueda web: " + mode))
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
		m.print(note("No hay una respuesta para copiar."))
		return
	}
	if err := copyToClipboard(text); err != nil {
		m.print(errLine("No se pudo copiar: " + err.Error()))
		return
	}
	m.print(okLine("Respuesta copiada al portapapeles"))
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
		m.print(note("La conversación está vacía."))
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
		m.print(errLine("No se pudo guardar: " + err.Error()))
		return
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		m.print(errLine("No se pudo guardar: " + err.Error()))
		return
	}
	m.print(okLine("Conversación guardada en " + shortPath(path)))
}

// ── agente ───────────────────────────────────────────────────────────────

func (m *Model) cmdApprove(arg string) tea.Cmd {
	apply := func(on bool) {
		m.chat.Session.AutoApprove = on
		m.chat.Cfg.AutoApproveTools = on
		m.saveConfig()
		m.print(okLine("Auto-aprobar: " + onOff(on)))
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
		m.print(okLine("Modo plan: el agente explora y propone; no toca archivos ni ejecuta nada. /plan off para que ejecute el plan."))
	} else {
		m.print(okLine("Modo plan desactivado: el agente vuelve a poder editar y ejecutar."))
	}
	m.refreshContext()
}

func (m *Model) cmdTodo() {
	if len(m.todo) == 0 {
		m.print(note("El agente no tiene lista de pasos en este momento."))
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
	lines := []string{"", "  " + sDim2.Render(fmt.Sprintf("herramientas del modo agent %s workspace %s", glyphSep, shortPath(m.chat.Workspace)))}
	for _, spec := range toolspec.Specs() {
		var left, permission string
		if toolspec.IsReadOnly(spec.Name) {
			left = "  " + sDim2.Render("○ ")
			permission = sDim2.Render("solo lectura")
		} else {
			left = "  " + sAccent.Render(glyphDot+" ")
			if spec.Name == "run_command" {
				permission = sWarn.Render(commands)
			} else {
				permission = sBeige.Render(approve)
			}
		}
		left += sBold.Render(fmt.Sprintf("%-14s", spec.Name)) + sDim2.Render(spec.Args)
		lines = append(lines, twoCol(left, permission, m.width), "      "+sDim.Render(spec.Description))
	}
	protocol := "nativo (el modelo recibe las funciones)"
	if !s.NativeTools {
		protocol = "texto (el modelo no soporta herramientas nativas)"
	}
	lines = append(lines, "", "  "+sDim2.Render("○ solo lectura   "+glyphDot+" modifica tu disco"),
		"  "+sDim.Render("Protocolo:")+" "+sBeige.Render(protocol), "")
	m.print(strings.Join(lines, "\n"))
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
			return cmdDoneMsg{lines: []string{note(shortPath(m.chat.Workspace) + " no es un repositorio git.")}}
		}
		target := []string{}
		if arg = strings.TrimSpace(arg); arg != "" {
			target = []string{arg}
		}
		_, status := m.git(ctx, 20*time.Second, "status", "--short")
		if strings.TrimSpace(status) == "" {
			return cmdDoneMsg{lines: []string{okLine("El workspace está limpio: no hay cambios sin confirmar.")}}
		}
		_, stat := m.git(ctx, 20*time.Second, append([]string{"diff", "--stat", "--"}, target...)...)
		_, body := m.git(ctx, 20*time.Second, append([]string{"diff", "--unified=2", "--"}, target...)...)

		lines := []string{"", sDim2.Render("─── cambios sin confirmar ───")}
		for _, l := range firstLines(strings.TrimRight(status, "\n"), 40) {
			lines = append(lines, "  "+sBeige.Render(l))
		}
		if strings.TrimSpace(body) != "" {
			lines = append(lines, "")
			for _, l := range firstLines(strings.TrimRight(body, "\n"), 220) {
				style := sDim
				switch {
				case strings.HasPrefix(l, "+++"), strings.HasPrefix(l, "---"):
					style = sDim2
				case strings.HasPrefix(l, "+"):
					style = sAddNum
				case strings.HasPrefix(l, "-"):
					style = sDelNum
				case strings.HasPrefix(l, "@@"):
					style = sPlan
				}
				lines = append(lines, "  "+style.Render(l))
			}
		}
		if s := strings.TrimSpace(stat); s != "" {
			rows := strings.Split(s, "\n")
			lines = append(lines, "", "  "+sDim.Render(rows[len(rows)-1]))
		}
		return cmdDoneMsg{lines: append(lines, "")}
	})
}

func (m *Model) cmdUndo() tea.Cmd {
	s := m.chat.Session
	if len(s.UndoStack) == 0 {
		m.print(note("No hay cambios del agente que revertir en esta sesión."))
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
			m.print(note(l))
		}
		if err != nil {
			m.print(errLine("No se pudo revertir: " + err.Error()))
			return nil
		}
		if s.UndoIncomplete {
			m.print(warnLine("Ese turno también borró o movió carpetas enteras; eso no se revierte solo."))
		}
		m.print(okLine("Cambios revertidos. El modelo no lo sabe: díselo si quieres que continúe desde aquí."))
		m.chat.History = append(m.chat.History, history.User("[El usuario revirtió con /undo los archivos del último turno: "+
			strings.Join(files, ", ")+". Vuelven a estar como antes de ese turno.]"))
		m.refreshContext()
		return nil
	})
	m.picker = p
	return nil
}

func (m *Model) cmdPs() tea.Cmd {
	procs := m.chat.Toolbox.Procs.List()
	if len(procs) == 0 {
		m.print(note("No hay comandos en segundo plano."))
		return nil
	}
	options := make([]option, 0, len(procs)+1)
	for _, p := range procs {
		state := "terminado"
		if p.Alive {
			state = "en marcha"
		}
		m.print(note(fmt.Sprintf("%s  %s  %s", p.ID, state, truncateRunes(p.Command, 90))))
		options = append(options, option{Label: p.ID + "  " + truncateRunes(p.Command, 60), Value: p.ID, Desc: state})
	}
	options = append(options, option{Label: "Ninguno", Value: "none", Desc: "volver"})
	p := newPicker("Detener alguno", options, func(value string, cancelled bool) tea.Cmd {
		if cancelled || value == "none" {
			return nil
		}
		m.print(okLine(m.chat.Toolbox.Execute(context.Background(), "stop_command", map[string]any{"id": value})))
		return nil
	})
	p.cursor = len(options) - 1
	m.picker = p
	return nil
}

func (m *Model) cmdCheck(arg string) tea.Cmd {
	apply := func(on bool) {
		m.chat.Session.AutoCheck = on
		m.chat.Cfg.Extra["auto_check"] = []byte(fmt.Sprint(on))
		m.saveConfig()
		m.print(okLine("Verificación tras editar: " + onOff(on)))
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
			m.print(okLine("«" + arg + "» vuelve a pedir confirmación."))
		} else {
			s.AllowedCommands = append(s.AllowedCommands, arg)
			m.print(okLine("«" + arg + "» se ejecutará sin preguntar (también en sesiones futuras)."))
		}
		save()
		return nil
	}
	if len(s.AllowedCommands) == 0 {
		m.print(note("Ningún comando permitido sin confirmación. Añade uno: /allow npm test"))
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
			m.print(okLine("«" + value + "» vuelve a pedir confirmación."))
		}
		return nil
	})
	p.cursor = len(options) - 1
	m.picker = p
	return nil
}

func (m *Model) cmdWorkspace(arg string) {
	if arg == "" {
		m.print(note("Workspace actual: " + m.chat.Workspace))
		return
	}
	path := expandHome(arg)
	if !filepath.IsAbs(path) {
		path = filepath.Join(m.chat.Workspace, path)
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		m.print(errLine("Ruta inválida o no es una carpeta."))
		return
	}
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	m.chat.SetWorkspace(path)
	m.print(okLine("Workspace: " + shortPath(path)))
	if m.chat.ProjectContext != "" {
		m.print(note("LIXBON.md encontrado: se usará como contexto del proyecto."))
	}
}

func (m *Model) cmdRun(arg string) tea.Cmd {
	command := strings.TrimSpace(arg)
	if command == "" {
		m.print(errLine("Uso: /run npm test"))
		return nil
	}
	exec := func() tea.Cmd {
		return m.async("ejecutando "+truncateRunes(command, 40), func(ctx context.Context) cmdDoneMsg {
			result := m.chat.Toolbox.Execute(ctx, "run_command", map[string]any{"command": command, "timeout": float64(300)})
			body, code := result, "?"
			if rest, ok := strings.CutPrefix(result, "[EXIT "); ok {
				if n, after, found := strings.Cut(rest, "] "); found {
					code, body = n, after
				}
			}
			lines := []string{"", renderAction(agent.Event{Tool: "run_command", Change: &agent.Change{Kind: "command", Detail: command}}, m.width)}
			for _, l := range firstLines(body, 80) {
				lines = append(lines, renderLogLine(l, sDim, "", m.width))
			}
			lines = append(lines, renderResult("salida "+code, code != "0", "", m.width), "")
			return cmdDoneMsg{lines: lines, apply: func(m *Model) {
				text := body
				if r := []rune(text); len(r) > 6000 {
					text = string(r[:6000])
				}
				m.chat.History = append(m.chat.History, history.User(fmt.Sprintf("TOOL_RESULT run_command `%s` (EXIT %s):\n%s", command, code, text)))
			}}
		})
	}
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
			return cmdDoneMsg{lines: []string{errLine("El workspace no es un repositorio git.")}}
		}
		if strings.TrimSpace(status) == "" {
			return cmdDoneMsg{lines: []string{note("No hay cambios que confirmar.")}}
		}
		_, stat := m.git(ctx, 10*time.Second, "diff", "HEAD", "--stat")
		_, body := m.git(ctx, 20*time.Second, "diff", "HEAD")
		var untracked, lines []string
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
		lines = append(lines, "")
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
			return cmdDoneMsg{lines: []string{errLine(firstNonEmpty(out, "git commit falló"))}}
		}
		first, _, _ := strings.Cut(out, "\n")
		return cmdDoneMsg{lines: []string{okLine(firstNonEmpty(first, "Commit creado."))}}
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
				return cmdDoneMsg{lines: []string{m.reportError(err)}}
			}
			content := strings.TrimSpace(text)
			if content == "" {
				return cmdDoneMsg{lines: []string{errLine("El modelo no devolvió contenido; inténtalo de nuevo.")}}
			}
			if strings.HasPrefix(content, "```") {
				_, rest, _ := strings.Cut(content, "\n")
				if i := strings.LastIndex(rest, "```"); i >= 0 {
					rest = rest[:i]
				}
				content = strings.TrimSpace(rest)
			}
			if err := os.WriteFile(target, []byte(content+"\n"), 0o644); err != nil {
				return cmdDoneMsg{lines: []string{errLine("No se pudo escribir LIXBON.md: " + err.Error())}}
			}
			return cmdDoneMsg{
				lines: []string{renderAction(agent.Event{Tool: "write_file", Text: "LIXBON.md", Adds: strings.Count(content, "\n") + 1}, m.width),
					okLine("LIXBON.md creado: se cargará como contexto en cada sesión de esta carpeta.")},
				apply: func(m *Model) {
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
		lines := []string{""}
		for _, r := range rows {
			line := "  " + sDim.Render(fmt.Sprintf("%-20s", r[0])) + " " + sPrimary.Render(r[1])
			if r[2] != "" {
				line += sDim2.Render("  " + glyphSep + "  " + r[2])
			}
			lines = append(lines, line)
		}
		return cmdDoneMsg{lines: append(lines, "")}
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
	lines := []string{""}
	for _, r := range rows {
		lines = append(lines, "  "+sDim.Render(fmt.Sprintf("%-26s", r[0]))+" "+sPrimary.Render(r[1]))
	}
	if pct > 75 {
		lines = append(lines, warnLine("El contexto va lleno: /compact resume la conversación y libera espacio."))
	}
	m.print(strings.Join(append(lines, ""), "\n"))
}

func (m *Model) cmdUsage() tea.Cmd {
	return m.async("consultando uso", func(ctx context.Context) cmdDoneMsg {
		u, err := m.chat.Client.Usage(ctx)
		if err != nil {
			return cmdDoneMsg{lines: []string{errLine("No se pudo obtener el uso. Verifica tu sesión. Error: " + err.Error())}}
		}
		plan := firstNonEmpty(u.Plan.Name, "-")
		lines := []string{"", sDim.Render("Plan") + " " + sPrimary.Render(plan), ""}
		for _, b := range []struct {
			label  string
			bucket api.Bucket
		}{{"Sesión (4h)", u.Buckets.Session}, {"Semana (todos los modelos)", u.Buckets.Week}} {
			lines = append(lines, sPrimary.Render(b.label))
			if b.bucket.Unlimited {
				lines = append(lines, "  "+sDim2.Render(strings.Repeat("▓", 24))+"  "+sOK.Render("ilimitado"), "")
				continue
			}
			pct := min(100, int(b.bucket.Percent+0.5))
			style := sAccent
			switch {
			case pct >= ctxFull:
				style = sErr
			case pct >= ctxWarn:
				style = sWarn
			}
			filled := int(float64(24)*float64(pct)/100 + 0.5)
			lines = append(lines, "  "+style.Render(strings.Repeat("▓", filled)+strings.Repeat("░", 24-filled))+fmt.Sprintf("  %d%% usado", pct))
			if reset := api.ResetIn(b.bucket.ResetAt, time.Now()); reset != "" {
				lines = append(lines, "  "+sDim2.Render("Se reinicia "+reset))
			}
			lines = append(lines, "")
		}
		return cmdDoneMsg{lines: lines}
	})
}

func (m *Model) cmdNodes() tea.Cmd {
	return m.async("consultando nodos", func(ctx context.Context) cmdDoneMsg {
		nodes, err := m.chat.Client.Nodes(ctx)
		if err != nil {
			return cmdDoneMsg{lines: []string{m.reportError(err)}}
		}
		if len(nodes) == 0 {
			return cmdDoneMsg{lines: []string{note("Sin nodos registrados; se usa el Ollama local del servidor.")}}
		}
		var lines []string
		for _, n := range nodes {
			icon := sOK.Render(glyphDot)
			if !n.Online {
				icon = sErr.Render("○")
			}
			cb := ""
			if n.CircuitBreaker {
				cb = " " + sWarn.Render("[CB]")
			}
			lines = append(lines, fmt.Sprintf("  %s %s %s%s", icon, sPrimary.Render(firstNonEmpty(n.Name, n.ID)),
				sDim.Render(fmt.Sprintf("score %v %s %d modelos", n.Score, glyphSep, len(n.Models))), cb))
		}
		return cmdDoneMsg{lines: lines}
	})
}

func (m *Model) cmdContextWindow(arg string) {
	var n int
	if _, err := fmt.Sscanf(strings.TrimSpace(arg), "%d", &n); err != nil {
		m.print(errLine("Uso: /context-window 8192"))
		return
	}
	n = max(1024, n)
	m.chat.Cfg.ContextWindow = n
	m.chat.Session.ContextWindow = n
	m.saveConfig()
	m.refreshContext()
	m.print(okLine(fmt.Sprintf("Ventana de contexto: %d tokens", n)))
}

func (m *Model) cmdKey(arg string) tea.Cmd {
	if arg == "" {
		m.promptFor("Pega tu API key (lixbon_sk_…)", func(text string) tea.Cmd { return m.applyKey(strings.TrimSpace(text)) })
		return nil
	}
	return m.applyKey(arg)
}

func (m *Model) applyKey(key string) tea.Cmd {
	if key == "" {
		return nil
	}
	previous := m.chat.Client.APIKey
	m.chat.Client.APIKey = key
	return m.async("verificando la clave", func(ctx context.Context) cmdDoneMsg {
		info, err := m.chat.Client.KeyInfo(ctx)
		if err != nil {
			m.chat.Client.APIKey = previous
			return cmdDoneMsg{lines: []string{errLine("Clave inválida: " + err.Error())}}
		}
		m.chat.Cfg.APIKey = key
		m.chat.Cfg.KeyModel = info.KeyModel
		m.saveConfig()
		return cmdDoneMsg{lines: []string{okLine("API key actualizada")}, apply: func(m *Model) {
			if info.KeyModel != "" {
				m.chat.SetModel(info.KeyModel)
			}
			acc := m.chat.Probe(context.Background())
			m.opts.Account = acc
			m.online = acc.State != chat.AccountOffline
		}}
	})
}

func (m *Model) cmdLogout() tea.Cmd {
	if m.chat.Cfg.APIKey == "" {
		m.print(note("No hay ninguna sesión activa."))
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
		m.chat.ClearSession()
		m.chat.Model = ""
		m.print(okLine("Sesión cerrada. Usa /login para volver a entrar."))
		return nil
	})
	return nil
}

// ── utilidades ───────────────────────────────────────────────────────────

func (m *Model) promptFor(label string, onSubmit func(string) tea.Cmd) {
	m.print(rail(true) + sBold.Render(label))
	m.print(note("escribe y pulsa Enter (Esc cancela)"))
	m.prompt = &promptState{label: label, onSubmit: onSubmit}
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
