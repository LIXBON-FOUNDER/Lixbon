package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

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
	if _, ok := m.spec(name); ok {
		switch {
		case quietCommands[name]:
			return m.captured("/"+name, func() tea.Cmd { return m.runCommand(name, arg) })
		case echoless[name]:
		default:
			m.gap()
			m.add(echoBlock(text))
		}
		return m.uncaptured(func() tea.Cmd { return m.runCommand(name, arg) })
	}
	if name == "key" && m.chat.Cfg.ExtraString("account_email") != "" {
		return m.toast(sSoft.Render("/key es para sesiones con API key; entraste con tu cuenta de lixbon.com"))
	}
	m.gap()
	m.add(echoBlock(text))
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
	m.chat.Session.NoVision = m.modelLacksVision()
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.running = true
	m.turnMode = m.chat.Mode
	m.started = time.Now()
	m.live = liveState{}
	m.liveChars, m.liveReal, m.charsPerToken = 0, 0, m.chat.Session.Estimator.CharsPerToken()
	m.notice = ""
	m.openTool, m.readGroup, m.browserGroup, m.todoEntry = nil, nil, nil, nil
	m.answerEntry = nil
	m.turnHead, m.railTail, m.railing = nil, nil, false
	var chips []imageChip
	if m.remote != nil && m.remoteOrigin {
		chips, m.remote.next.chips = m.remote.next.chips, nil
	} else if shown != "" {
		chips = m.sentChips(shown)
	}
	if shown != "" {
		m.gap()
		m.add(userBlock{text: shown, chips: chips})
		m.print("")
	}
	m.turnStart = len(m.log.entries)
	ui := &uiSink{send: m.send, turn: id}
	measured := m.chat
	ui.measure = func() ctxMsg {
		tokens, pct := measured.ContextUsage()
		return ctxMsg{turn: id, tokens: tokens, pct: pct, session: measured.SessionTokens}
	}
	var sink chat.Sink = ui
	if m.remote != nil {
		c := m.chat
		rs := &remoteSink{Sink: sink, host: m.remote, agent: m.chat.Mode == chat.ModeAgent, started: time.Now(),
			context: func() map[string]any { return remoteContext(c) }}
		m.remote.sink, sink = rs, rs
		m.remote.live.Store(rs)
		m.remoteTurnStarted(prompt, chips)
	}
	c := m.chat
	send := m.send
	go func() {
		answer, err := c.Send(ctx, prompt, sink)
		ui.flush()
		send(doneMsg{turn: id, answer: answer, err: err})
	}()
	return m.startTick()
}

// flushLive pasa al transcript lo que el modelo lleva dicho en el paso
// actual: el razonamiento completo (plegado) y la prosa, sin el JSON de las
// llamadas.
func (m *Model) flushLive() {
	live := &m.live
	m.flushThinking()
	prose := m.liveProse()
	switch {
	case live.answer != nil && prose == "":
		m.remove(live.answer)
	case live.answer != nil:
		m.drawAnswer(prose)
	case prose != "":
		m.printAnswer(prose)
	}
	if prose != "" {
		live.spoke = true
		live.lastProse = prose
	}
	live.answer, live.prose, live.drawn = nil, "", ""
	live.calling = callProgress{}
	live.content.Reset()
}

func (m *Model) flushThinking() {
	live := &m.live
	if text := strings.TrimSpace(live.reasoning.String()); text != "" {
		thought := thinkBlock{text: text, secs: live.reasoningSecs}
		if m.turnMode == chat.ModeAgent {
			// En un turno del agente lo pensado no ocupa fila: va al ✦ de la
			// acción siguiente, que lo enseña con ctrl+o.
			m.pendingThought = joinThoughts(m.pendingThought, thought)
		} else {
			m.closeGroups()
			m.add(thought)
		}
	}
	live.reasoning.Reset()
	live.reasoningSecs = 0
}

// liveProse es lo que el modelo lleva escrito en el paso, sin el JSON de las
// llamadas en modo agent.
func (m *Model) liveProse() string {
	raw := m.live.content.String()
	if m.turnMode != chat.ModeAgent {
		return strings.TrimSpace(raw)
	}
	return toolparse.CleanProse(raw)
}

// answerRedraw limita cuánto se repinta el markdown de la respuesta en curso.
const answerRedraw = 80 * time.Millisecond

// streamAnswer escribe la respuesta en el transcript según llega. Espera a
// unas letras para no enseñar el arranque de una llamada en JSON.
func (m *Model) streamAnswer(tick bool) {
	live := &m.live
	prose := live.prose
	switch {
	case live.answer == nil && utf8.RuneCountInString(prose) < 4:
	case live.answer == nil:
		m.flushThinking()
		m.printAnswer(prose)
		live.answer = m.answerEntry
		live.drawn, live.drawAt = prose, time.Now()
	case prose != live.drawn && (tick || time.Since(live.drawAt) >= answerRedraw):
		m.drawAnswer(prose)
	}
}

func (m *Model) drawAnswer(prose string) {
	live := &m.live
	live.answer.b = answerBlock{text: prose, md: m.renderMarkdown, bare: m.turnHead != nil}
	m.refresh(live.answer)
	m.answerEntry = live.answer
	live.drawn, live.drawAt = prose, time.Now()
}

// printAnswer escribe prosa del modelo. En un turno con riel lo cierra: la
// respuesta va fuera; si luego llega otra acción, era narración y openRail la
// vuelve a colgar del riel.
func (m *Model) printAnswer(prose string) {
	m.closeGroups()
	m.closeRail()
	m.gap()
	m.answerEntry = m.add(answerBlock{text: prose, md: m.renderMarkdown, bare: m.turnHead != nil})
}

func (m *Model) finishTurn(msg doneMsg) tea.Cmd {
	m.flushLive()
	m.running = false
	m.autoCompacting = false
	m.notice = ""
	cancelled := m.interrupted || errors.Is(msg.err, context.Canceled)
	m.interrupted = false
	m.closeTool(toolStopped)
	m.closeGroups()
	m.closeRail()
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
		if kept := new(chat.Interrupted); errors.As(msg.err, &kept) {
			m.add(note("Lo hecho en este turno quedó guardado: escribe «continúa» para seguir."))
		}
	default:
		if answer := strings.TrimSpace(msg.answer); answer != "" {
			shown := answer
			if m.turnMode == chat.ModeAgent {
				shown = toolparse.CleanProse(answer)
			}
			if shown != "" && shown != m.live.lastProse && (!m.live.spoke || m.live.usedTools) {
				m.printAnswer(shown)
			}
		} else if m.turnMode != chat.ModeAgent && !m.live.spoke {
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
	if h, ok := m.turnHeadBlock(); ok {
		// Las acciones son las del riel (countStep); los cambios, los aplicados.
		st := m.chat.Session.Stats
		h.adds, h.dels, h.secs = st.Adds, st.Dels, time.Since(m.started).Seconds()
		m.refresh(m.turnHead)
	}
	m.print("")
	if h := m.chat.History; len(h) > 0 && h[len(h)-1].Role == "assistant" {
		m.lastAnswer = h[len(h)-1].Content
	}
	m.refreshContext()
	m.refreshGit()
	m.files = nil

	// Una respuesta larga se enseña desde su principio, no desde el final:
	// si no, el usuario tiene que subir a buscar dónde empieza.
	if m.answerEntry != nil && m.scroll == 0 {
		m.anchorTop = m.answerEntry
	}
	quota := m.fetchQuota()
	if len(m.queue) > 0 && !m.quitting {
		return tea.Batch(quota, m.dispatchQueued())
	}
	return quota
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
	case agent.ApproveBrowser:
		title = "¿Permitir esta acción en el navegador?"
		options = append(options, option{Label: "Sí", Value: "yes", Desc: "solo esta vez"})
		if !req.Sensitive {
			if req.Prefix != "" {
				options = append(options, option{Label: "Sí, y siempre en " + req.Detail, Value: "prefix",
					Desc: "no volverá a preguntar en este sitio durante la sesión"})
			}
			options = append(options, option{Label: "Sí, y no preguntar más en el navegador", Value: "always",
				Desc: "cualquier sitio, el resto de la sesión"})
		}
		options = append(options, option{Label: "No", Value: "no", Desc: "rechazar y decirle al agente que no"})
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
				m.alwaysAllowed = req.Kind != agent.ApproveBrowser
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
	p.token = reply
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
	case agent.ApproveBrowser:
		lines := []string{sBeige.Render(browserVerb(req.Tool) + " " + req.Summary), sDim.Render("  en " + req.Detail)}
		if req.Sensitive {
			lines = append(lines, sWarn.Render("  Es un campo sensible (contraseña, tarjeta o código): mejor escríbelo tú en la ventana."))
		}
		return lines
	}
	line := sBeige.Render(firstNonEmpty(req.Detail, req.Summary))
	if req.Change != nil {
		line = sBeige.Render(req.Change.Path)
		if b := m.currentTool(); b != nil && b.counts {
			line += sDim2.Render(" "+glyphSep+" ") + counts(b.adds, b.dels)
		}
		line += sDim.Render(" " + glyphSep + " el diff está justo encima")
	}
	return []string{line}
}
