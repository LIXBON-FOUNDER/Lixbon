package tui

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/remote"
	"lixbon.com/cli/internal/sse"
	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/toolparse"
	"lixbon.com/cli/internal/tools"
)

type (
	remoteMsg struct {
		link *remote.Link
		cmd  remote.Command
	}
	remoteClosedMsg struct{ link *remote.Link }
)

// remoteHost es el control remoto activo: mientras dura, el teclado local queda
// en pausa y los mensajes y aprobaciones llegan del móvil o la web.
type remoteHost struct {
	link     *remote.Link
	approver agent.Approver
	askUser  func(ctx context.Context, question string, options []string) (string, bool)
	onTodo   func(items, previous []tools.TodoItem)
	snapshot atomic.Pointer[[]map[string]any]
}

func (h *remoteHost) snapshotNow() []map[string]any {
	if s := h.snapshot.Load(); s != nil {
		return *s
	}
	return nil
}

// remoteApprover manda las aprobaciones al móvil y espera allí la decisión.
type remoteApprover struct{ link *remote.Link }

func (a *remoteApprover) Approve(ctx context.Context, req agent.Approval) (agent.Decision, error) {
	risk := "command"
	if req.Kind == agent.ApproveEdit {
		risk = "edit"
	}
	if a.link.RequestApproval(ctx, req.Tool, firstNonEmpty(req.Summary, req.Tool), risk) {
		return agent.Allow, nil
	}
	return agent.Deny, ctx.Err()
}

// remoteSink reenvía al móvil lo que ocurre durante un turno, además de
// pintarlo en la terminal.
type remoteSink struct {
	chat.Sink
	link *remote.Link
}

func (s remoteSink) Delta(kind sse.Kind, text string) {
	s.Sink.Delta(kind, text)
	if kind == sse.Content {
		s.link.Emit("assistant_delta", map[string]any{"text": text})
	}
}

func (s remoteSink) Event(e agent.Event) {
	s.Sink.Event(e)
	result := func() string { return textutil.Head(firstNonEmpty(e.Result, e.Summary), remote.ResultChars) }
	switch e.Kind {
	case agent.EventAction:
		s.link.Emit("tool_use", map[string]any{"tool": e.Tool, "summary": e.Text, "readonly": e.ReadOnly})
	case agent.EventActionResult:
		s.link.Emit("tool_result", map[string]any{"tool": e.Tool, "result": result(), "error": e.Failed})
	case agent.EventReadGroup:
		s.link.Emit("tool_use", map[string]any{"tool": "read_file", "summary": strings.Join(e.Names, ", "), "readonly": true})
		s.link.Emit("tool_result", map[string]any{"tool": "read_file", "result": fmt.Sprintf("%d líneas", e.Lines), "error": false})
	}
}

func (m *Model) cmdRemote(arg string) tea.Cmd {
	switch strings.ToLower(arg) {
	case "", "start":
	case "stop", "status":
		m.print(note("El control remoto se activa con /remote y se termina con Ctrl+C dentro del modo remoto."))
		return nil
	default:
		m.print(errLine("Uso: /remote — inicia el control remoto desde tu app móvil"))
		return nil
	}
	switch {
	case m.remote != nil:
		m.print(note("El control remoto ya está activo."))
		return nil
	case m.chat.Cfg.APIKey == "":
		m.print(errLine("Necesitas una sesión activa (/login) para usar /remote."))
		return nil
	}
	title := firstNonEmpty(filepath.Base(m.chat.Workspace), "workspace")
	machine, _ := os.Hostname()
	machine = firstNonEmpty(machine, "PC")
	link := remote.NewLink(m.chat.Client, "cli", title, machine)
	mode, model := m.chat.Mode, m.chat.Model
	return m.async("creando sesión remota", func(ctx context.Context) cmdDoneMsg {
		if err := link.Start(ctx, mode, model); err != nil {
			return cmdDoneMsg{lines: []string{errLine("No se pudo iniciar el control remoto: " + err.Error())}}
		}
		qr := link.QR(ctx)
		return cmdDoneMsg{apply: func(m *Model) { m.enterRemote(link, title, machine, qr) }}
	})
}

func (m *Model) enterRemote(link *remote.Link, title, machine, qr string) {
	host := &remoteHost{
		link: link, approver: m.chat.Session.Approver,
		askUser: m.chat.Toolbox.AskUser, onTodo: m.chat.Toolbox.OnTodo,
	}
	m.remote = host
	link.Snapshot = host.snapshotNow
	m.refreshRemoteSnapshot()

	m.chat.Session.Approver = &remoteApprover{link: link}
	m.chat.Toolbox.AskUser = nil
	m.chat.Toolbox.OnTodo = func(items, previous []tools.TodoItem) {
		host.onTodo(items, previous)
		link.Emit("tool_use", map[string]any{"tool": "todo", "summary": todoSummary(items), "readonly": true})
	}

	lines := []string{"", "  " + sBold.Render(glyphThink+" Control remoto activo"),
		"  " + sDim.Render("Sesión: ") + sPrimary.Render(title) + sDim.Render(" en "+machine),
		"  " + sDim.Render("Link:   ") + sAccent.Render(link.ShareURL())}
	if qr != "" {
		lines = append(lines, "")
		for _, row := range strings.Split(strings.TrimRight(qr, "\n"), "\n") {
			lines = append(lines, "  "+row)
		}
	}
	lines = append(lines, "",
		note("La sesión ya aparece en la sección Remote de tu app Lixbon."),
		note("Sin la app, escanea el QR: abre la sesión en la web (te pedirá iniciar sesión con tu cuenta)."),
		note("Control local en pausa — Ctrl+C para terminar el modo remoto y volver aquí."), "")
	m.print(strings.Join(lines, "\n"))

	link.EmitSnapshot()
	link.Emit("status", map[string]any{"state": "idle"})
	send := m.send
	go func() {
		for cmd := range link.Inbox {
			send(remoteMsg{link, cmd})
		}
		send(remoteClosedMsg{link})
	}()
}

func todoSummary(items []tools.TodoItem) string {
	rows := make([]string, len(items))
	for i, it := range items {
		mark := "[ ]"
		if it.Status == "done" {
			mark = "[x]"
		}
		rows[i] = mark + " " + it.Text
	}
	return textutil.Head(strings.Join(rows, "\n"), remote.ResultChars)
}

// leaveRemote devuelve el teclado a la terminal. Cerrar la sesión puede tardar
// (red), así que no bloquea la interfaz.
func (m *Model) leaveRemote(endSession bool) {
	host := m.remote
	if host == nil {
		return
	}
	m.remote = nil
	m.chat.Session.Approver = host.approver
	m.chat.Toolbox.AskUser = host.askUser
	m.chat.Toolbox.OnTodo = host.onTodo
	go host.link.Stop(endSession)
	m.print("\n" + note("Control remoto terminado; la sesión vuelve a esta terminal."))
}

func (m *Model) onRemote(msg remoteMsg) tea.Cmd {
	if m.remote == nil || m.remote.link != msg.link {
		return nil
	}
	switch msg.cmd.Type {
	case "prompt":
		text := strings.TrimSpace(msg.cmd.Text)
		switch {
		case text == "":
		case strings.HasPrefix(text, "!"):
			m.print(note("Se ignoró un «!» recibido por control remoto: los comandos manuales solo se escriben en esta terminal."))
		case strings.HasPrefix(text, "/"):
			m.print(renderCommandEcho(text + "  [remoto]"))
			m.remoteCommand(text)
		case m.busyNow():
			m.queue = append(m.queue, text)
		default:
			return m.dispatch(text)
		}
	case "interrupt":
		if m.running {
			m.cancelTurn()
		}
	case "bye":
		m.leaveRemote(false)
	}
	return nil
}

// refreshRemoteSnapshot guarda el historial renderizable que recibe un
// controller que se une: sin system, sin resultados internos de herramientas y
// con la prosa del asistente limpia. Se refresca entre turnos para no leer el
// historial mientras el turno lo modifica.
func (m *Model) refreshRemoteSnapshot() {
	if m.remote == nil {
		return
	}
	var messages []map[string]any
	for _, msg := range m.chat.History {
		content := msg.Content
		switch {
		case msg.Role == "system" || msg.Role == "tool":
			continue
		case msg.Role == "user" && strings.HasPrefix(content, "TOOL_RESULT"):
			continue
		case msg.Role == "assistant":
			if content = toolparse.CleanProse(content); content == "" {
				content = textutil.Head(msg.Content, 400)
			}
			if content == "" {
				continue
			}
		}
		messages = append(messages, map[string]any{"role": msg.Role, "content": content})
	}
	messages = messages[max(0, len(messages)-80):]
	m.remote.snapshot.Store(&messages)
}

// remoteTurnStarted y remoteTurnDone cuentan al móvil cómo va el turno.
func (m *Model) remoteTurnStarted(prompt string) {
	m.remote.link.Emit("user_msg", map[string]any{"text": prompt, "origin": "remote"})
	m.remote.link.Emit("status", map[string]any{"state": "thinking"})
}

func (m *Model) remoteTurnDone(msg doneMsg, cancelled bool) {
	link := m.remote.link
	switch {
	case msg.err != nil && !cancelled:
		link.Emit("error", map[string]any{"message": msg.err.Error()})
	default:
		display := strings.TrimSpace(msg.answer)
		if m.chat.Mode == chat.ModeAgent {
			display = toolparse.CleanProse(msg.answer)
		}
		link.Emit("assistant_done", map[string]any{"text": display, "interrupted": cancelled})
	}
	link.Emit("status", map[string]any{"state": "idle"})
	m.refreshRemoteSnapshot()
}

// remoteCommand ejecuta un comando «/» llegado del móvil y contesta con una
// frase. No reutiliza los comandos locales: escriben en la terminal y varios
// abren selectores, que en remoto no tienen teclado.
func (m *Model) remoteCommand(text string) {
	name, arg, _ := strings.Cut(text[1:], " ")
	name, arg = strings.ToLower(strings.TrimSpace(name)), strings.TrimSpace(arg)
	link := m.remote.link
	reply := func(message string) { link.Emit("notice", map[string]any{"text": message}) }

	var known, near []string
	for _, c := range remote.Commands {
		known = append(known, c.Name)
		if strings.HasPrefix(c.Name, name) {
			near = append(near, c.Name)
		}
	}
	if !slices.Contains(known, name) && len(near) == 1 {
		name = near[0]
	}

	switch {
	case name == "help":
		lines := []string{"Comandos disponibles desde la app:"}
		for _, c := range remote.Commands {
			lines = append(lines, strings.TrimSpace("/"+c.Name+" "+c.Args)+" — "+c.Description)
		}
		reply(strings.Join(lines, "\n"))
	case name == "new":
		m.newConversation("conversación nueva")
		m.refreshRemoteSnapshot()
		reply("Conversación nueva: el contexto anterior se descartó.")
	case name == "model":
		reply(m.remoteModel(arg))
	case name == "mode":
		if slices.Contains([]string{"ask", "agent", "delegate"}, arg) {
			m.setMode(arg)
			reply("Modo cambiado a " + arg + ".")
		} else {
			reply("Modo actual: " + m.chat.Mode + ". Usa /mode ask, agent o delegate.")
		}
	case name == "approve":
		if arg == "on" || arg == "off" {
			m.chat.Session.AutoApprove = arg == "on"
		}
		reply("Auto-aprobar herramientas: " + onOff(m.chat.Session.AutoApprove) + ".")
	case name == "web":
		if arg == "on" || arg == "off" {
			m.chat.WebMode = arg
			m.chat.Cfg.Extra["web_search"] = []byte(`"` + arg + `"`)
			m.saveConfig()
		}
		reply("Búsqueda web: " + m.chat.WebMode + ".")
	case name == "workspace":
		reply("Workspace: " + m.chat.Workspace)
	case name == "cost":
		tokens, pct := m.chat.ContextUsage()
		reply(fmt.Sprintf("Contexto: %d de %d tokens (%.0f %%) en %d mensajes.", tokens, m.chat.Cfg.ContextWindow, pct, len(m.chat.History)))
	case name == "status":
		reply(fmt.Sprintf("Modelo: %s\nModo: %s\nWorkspace: %s\nAuto-aprobar: %s\nBúsqueda web: %s",
			firstNonEmpty(m.chat.Model, "sin configurar"), m.chat.Mode, m.chat.Workspace,
			onOff(m.chat.Session.AutoApprove), m.chat.WebMode))
	case len(near) > 1:
		reply("«/" + name + "» es ambiguo: /" + strings.Join(near, " o /") + ".")
	default:
		reply("«/" + name + "» no se puede ejecutar desde la app. Escribe /help para ver los que sí.")
	}
	link.Emit("status", map[string]any{"state": "idle"})
}

func (m *Model) remoteModel(arg string) string {
	switch {
	case arg == "":
		return "Modelo actual: " + firstNonEmpty(m.chat.Model, "sin configurar")
	case m.chat.Cfg.KeyModel != "":
		return "El modelo está fijado por la API key: " + m.chat.Cfg.KeyModel
	}
	var match string
	for _, model := range m.opts.Account.Models {
		if strings.EqualFold(model.ID, arg) {
			match = model.ID
			break
		}
	}
	if match == "" {
		for _, model := range m.opts.Account.Models {
			if strings.Contains(strings.ToLower(model.ID), strings.ToLower(arg)) {
				match = model.ID
				break
			}
		}
	}
	if match == "" {
		return "No hay ningún modelo que coincida con «" + arg + "»."
	}
	m.chat.SetModel(match)
	return "Modelo cambiado a " + match + "."
}

// handleRemoteKey: con el control remoto activo solo Ctrl+C y el desplazamiento
// responden; el resto del teclado queda en pausa.
func (m *Model) handleRemoteKey(msg tea.KeyPressMsg) tea.Cmd {
	switch msg.String() {
	case "ctrl+c":
		if m.running {
			m.cancelTurn()
		}
		m.leaveRemote(true)
	case "pgup":
		m.scrollBy(max(1, m.height-6))
	case "pgdown":
		m.scrollBy(-max(1, m.height-6))
	}
	return nil
}

func (m *Model) remoteBanner() string {
	line := sAccent.Render(glyphDot) + " " + sBold.Render("Control remoto activo") +
		sDim2.Render("  "+glyphSep+"  Ctrl+C termina y devuelve el control a esta terminal")
	return m.borderColor().Width(max(10, m.width-2)).Render(line)
}
