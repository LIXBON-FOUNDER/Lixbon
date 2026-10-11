package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/toolparse"
	"lixbon.com/cli/internal/workspace"
)

// dispatch ejecuta lo que el usuario envió: un comando «/» o un mensaje.
func (m *Model) dispatch(text string) tea.Cmd {
	m.scroll, m.sel = 0, nil
	if command, ok := strings.CutPrefix(text, "!"); ok {
		return m.shell(strings.TrimSpace(command))
	}
	if !strings.HasPrefix(text, "/") {
		return m.startTurn(text, text)
	}
	name, arg, _ := strings.Cut(text[1:], " ")
	name, arg = strings.ToLower(strings.TrimSpace(name)), strings.TrimSpace(arg)
	if name == "" {
		return m.startTurn(text, text)
	}
	m.gap()
	m.add(echoBlock(text))
	if _, ok := lookup(name); ok {
		return m.runCommand(name, arg)
	}
	if custom, ok := m.chat.Custom[name]; ok {
		return m.startTurn(workspace.Expand(custom.Body, arg), "")
	}
	m.add(errLine("Comando desconocido: /" + name + ". /help muestra los disponibles."))
	return nil
}

// shell ejecuta lo que el usuario escribió tras «!» sin pasar por el modelo ni
// pedir confirmación: lo ha escrito él.
func (m *Model) shell(command string) tea.Cmd {
	if command == "" {
		m.add(note("Escribe un comando tras «!», p. ej. !git status. Se ejecuta en el workspace y el modelo ve la salida."))
		return nil
	}
	return m.execShell(command)
}

// startTurn envía un mensaje al modelo. shown es lo que se ve en el eco (vacío
// si ya se imprimió, p. ej. el prompt de un comando propio).
func (m *Model) startTurn(prompt, shown string) tea.Cmd {
	if !m.chat.Client.Generic && m.chat.Cfg.APIKey == "" {
		m.add(errLine(noSessionHint))
		return nil
	}
	if m.chat.Model == "" {
		m.add(errLine("Todavía no hay un modelo elegido. /model abre el selector cuando el servidor publique modelos."))
		return nil
	}
	m.turn++
	id := m.turn
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.running = true
	m.started = time.Now()
	m.live = liveState{}
	m.liveChars, m.liveReal, m.charsPerToken = 0, 0, m.chat.Session.Estimator.CharsPerToken()
	m.notice = ""
	m.openTool, m.readGroup, m.todoEntry = nil, nil, nil
	if shown != "" {
		m.gap()
		m.add(userBlock{text: shown, chips: m.sentChips(shown)})
		m.print("")
	}
	var sink chat.Sink = &uiSink{send: m.send, turn: id}
	if m.remote != nil {
		sink = remoteSink{Sink: sink, link: m.remote.link}
		m.remoteTurnStarted(prompt)
	}
	c := m.chat
	send := m.send
	go func() {
		answer, err := c.Send(ctx, prompt, sink)
		send(doneMsg{turn: id, answer: answer, err: err})
	}()
	return m.startTick()
}

// flushLive pasa al transcript lo que el modelo lleva dicho en el paso
// actual: el razonamiento completo (plegado) y la prosa, sin el JSON de las
// llamadas.
func (m *Model) flushLive() {
	live := &m.live
	if strings.TrimSpace(live.reasoning.String()) != "" {
		m.closeReads()
		m.add(thinkBlock{text: live.reasoning.String(), secs: live.reasoningSecs})
	}
	raw := live.content.String()
	prose := strings.TrimSpace(raw)
	if m.chat.Mode == chat.ModeAgent {
		prose = toolparse.CleanProse(raw)
		// El «OK» con el que contesta al recordatorio de aplicar código es fontanería.
		if strings.EqualFold(strings.Trim(prose, ". "), "ok") {
			prose = ""
		}
	}
	if prose != "" {
		m.printAnswer(prose)
		live.spoke = true
		live.lastProse = prose
	}
	live.content.Reset()
	live.reasoning.Reset()
	live.reasoningSecs = 0
}

func (m *Model) printAnswer(prose string) {
	m.closeReads()
	m.gap()
	m.add(answerBlock{text: prose, md: m.renderMarkdown})
}

func (m *Model) finishTurn(msg doneMsg) tea.Cmd {
	m.flushLive()
	m.running = false
	m.notice = ""
	cancelled := m.interrupted || errors.Is(msg.err, context.Canceled)
	m.interrupted = false
	m.closeTool(toolStopped)
	m.closeReads()
	if m.remote != nil {
		m.remoteTurnDone(msg, cancelled)
	}
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}

	switch {
	case msg.err != nil && !errors.Is(msg.err, context.Canceled):
		m.add(m.reportError(msg.err))
	default:
		if answer := strings.TrimSpace(msg.answer); answer != "" {
			shown := answer
			if m.chat.Mode == chat.ModeAgent {
				shown = toolparse.CleanProse(answer)
			}
			if shown != "" && shown != m.live.lastProse && (!m.live.spoke || m.live.usedTools) {
				m.printAnswer(shown)
			}
		} else if m.chat.Mode != chat.ModeAgent && !m.live.spoke {
			m.add(note("(sin respuesta) " + glyphSep + " el modelo no devolvió texto; /doctor revisa la conexión"))
		}
	}
	if cancelled {
		m.gap()
		m.add(interruptedBlock{})
	}
	if sources := m.chat.Sources; len(sources) > 0 {
		var labels []string
		for _, s := range sources[:min(5, len(sources))] {
			label := "?"
			for _, k := range []string{"url", "title"} {
				if text, _ := s[k].(string); text != "" {
					label = text
					break
				}
			}
			labels = append(labels, label)
		}
		m.add(sourcesBlock(labels))
	}
	if m.chat.Mode == chat.ModeAgent {
		if st := m.chat.Session.Stats; st.Actions > 0 {
			m.add(summaryBlock{actions: st.Actions, files: len(st.Files), adds: st.Adds, dels: st.Dels, secs: time.Since(m.started).Seconds()})
		}
	}
	m.print("")
	if h := m.chat.History; len(h) > 0 && h[len(h)-1].Role == "assistant" {
		m.lastAnswer = h[len(h)-1].Content
	}
	m.refreshContext()
	m.refreshGit()
	m.files = nil

	if len(m.queue) > 0 && !m.quitting {
		next := m.queue[0]
		m.queue = m.queue[1:]
		return m.dispatch(next)
	}
	return nil
}

// reportError traduce un error del gateway a la acción que lo resuelve.
func (m *Model) reportError(err error) block {
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		return errLine(err.Error())
	}
	switch apiErr.Status {
	case 401, 403:
		return errLine("Tu sesión ya no es válida. Usa /login para volver a entrar.")
	case 402:
		return errLine("Sin créditos disponibles: " + apiErr.Message)
	case 429:
		return errLine(apiErr.RateLimitText())
	}
	return errLine(apiErr.Message)
}

// ── aprobaciones y preguntas ─────────────────────────────────────────────

func (m *Model) openApproval(msg approvalMsg) tea.Cmd {
	req := msg.req
	var title string
	var options []option
	switch req.Kind {
	case agent.ApproveCommand:
		title = "¿Ejecutar este comando?"
		options = append(options, option{Label: "Sí", Value: "yes", Desc: "ejecutar y seguir"})
		if req.Prefix != "" {
			options = append(options, option{Label: "Sí, y siempre para «" + req.Prefix + "»", Value: "prefix",
				Desc: "se guarda: no volverá a preguntar por ese comando"})
		}
		options = append(options,
			option{Label: "Sí, y no preguntar más", Value: "always", Desc: "auto-ejecutar cualquier comando esta sesión"},
			option{Label: "No", Value: "no", Desc: "rechazar y decirle al agente que no"})
	case agent.ApproveMCP:
		title = "¿Ejecutar esta herramienta externa?"
		options = []option{
			{Label: "Sí", Value: "yes", Desc: "aplicar y seguir"},
			{Label: "Sí, y no preguntar más", Value: "always", Desc: "auto-aprobar el resto de la sesión"},
			{Label: "No", Value: "no", Desc: "rechazar y decirle al agente que no"},
		}
	default:
		title = "¿Aplicar este cambio?"
		options = []option{
			{Label: "Sí", Value: "yes", Desc: "aplicar y seguir"},
			{Label: "Sí, y no preguntar más", Value: "always", Desc: "auto-aprobar el resto de la sesión"},
			{Label: "No", Value: "no", Desc: "rechazar y decirle al agente que no"},
		}
	}
	reply := msg.reply
	m.setToolState(toolWaiting)
	p := newPicker(title, options, func(value string, cancelled bool) tea.Cmd {
		d := agent.Deny
		if !cancelled {
			switch value {
			case "yes":
				d = agent.Allow
			case "always":
				d = agent.AllowAlways
				m.alwaysAllowed = true
			case "prefix":
				d = agent.AllowPrefix
			}
		}
		if d != agent.Deny {
			m.setToolState(toolRunning)
		}
		reply <- d
		return nil
	})
	p.cancel = "no"
	p.tone = pal.warn
	p.body = m.approvalBody(req)
	p.keys = [][2]string{{"↑↓", "mover"}, {fmt.Sprintf("1–%d", len(options)), "elegir"}, {"↵", "confirmar"}, {"esc", "= No"}}
	m.picker = p
	return nil
}

// approvalBody explica en el panel qué se aprueba: el comando con su carpeta,
// el archivo con sus cambios (el diff ya está en el transcript) o la
// herramienta externa.
func (m *Model) approvalBody(req agent.Approval) []string {
	switch req.Kind {
	case agent.ApproveCommand:
		return []string{
			sAccent.Bold(true).Render("$") + " " + sBold.Render(req.Summary),
			sDim.Render("  en " + shortPath(m.chat.Workspace)),
		}
	case agent.ApproveMCP:
		return []string{sBeige.Render(req.Detail), sDim.Render("  " + req.Summary)}
	}
	line := sBeige.Render(firstNonEmpty(req.Detail, req.Summary))
	if req.Change != nil {
		line = sBeige.Render(req.Change.Path)
		if m.openTool != nil {
			if b := m.openTool.b.(*toolBlock); b.counts {
				line += sDim2.Render(" "+glyphSep+" ") + counts(b.adds, b.dels)
			}
		}
		line += sDim.Render(" " + glyphSep + " el diff está justo encima")
	}
	return []string{line}
}

func (m *Model) openAsk(msg askMsg) tea.Cmd {
	m.gap()
	reply := msg.reply
	freeText := func() {
		m.add(askLine(msg.question))
		m.add(note("escribe tu respuesta y pulsa Enter (Esc cancela)"))
		m.prompt = &promptState{
			label:    msg.question,
			onSubmit: func(text string) tea.Cmd { reply <- askReply{answer: text, ok: true}; return nil },
			onCancel: func() { reply <- askReply{} },
		}
	}
	if len(msg.options) == 0 {
		freeText()
		return nil
	}
	options := make([]option, 0, len(msg.options)+1)
	for _, o := range msg.options {
		options = append(options, option{Label: o, Value: o})
	}
	options = append(options, option{Label: "Otra respuesta…", Value: "__other__"})
	m.picker = newPicker(msg.question, options, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled:
			reply <- askReply{}
		case value == "__other__":
			freeText()
		default:
			reply <- askReply{answer: value, ok: true}
		}
		return nil
	})
	m.picker.tone = pal.warn
	return nil
}
