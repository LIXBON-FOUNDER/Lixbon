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
	m.scroll = 0
	if !strings.HasPrefix(text, "/") {
		return m.startTurn(text, text)
	}
	name, arg, _ := strings.Cut(text[1:], " ")
	name, arg = strings.ToLower(strings.TrimSpace(name)), strings.TrimSpace(arg)
	if name == "" {
		return m.startTurn(text, text)
	}
	if _, ok := lookup(name); ok {
		m.print(renderCommandEcho(text))
		return m.runCommand(name, arg)
	}
	if custom, ok := m.chat.Custom[name]; ok {
		m.print(renderCommandEcho(text))
		return m.startTurn(workspace.Expand(custom.Body, arg), "")
	}
	m.print(renderCommandEcho(text))
	m.print(errLine("Comando desconocido: /" + name + ". /help muestra los disponibles."))
	return nil
}

// startTurn envía un mensaje al modelo. shown es lo que se ve en el eco (vacío
// si ya se imprimió, p. ej. el prompt de un comando propio).
func (m *Model) startTurn(prompt, shown string) tea.Cmd {
	if m.chat.Model == "" {
		m.print(errLine("Todavía no hay un modelo elegido. /model abre el selector cuando el servidor publique modelos."))
		return nil
	}
	m.turn++
	id := m.turn
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.running = true
	m.started = time.Now()
	m.live = liveState{}
	m.notice = ""
	if shown != "" {
		m.print("\n" + renderUserMessage(shown, m.width))
	}
	sink := &uiSink{send: m.send, turn: id}
	c := m.chat
	send := m.send
	go func() {
		answer, err := c.Send(ctx, prompt, sink)
		send(doneMsg{turn: id, answer: answer, err: err})
	}()
	return tickCmd()
}

// flushLive imprime lo que el modelo lleva dicho en el paso actual: el
// razonamiento resumido en una línea y la prosa (sin el JSON de las llamadas).
func (m *Model) flushLive() {
	live := &m.live
	if live.reasoning.Len() > 0 && live.reasoningSecs > 0.5 {
		m.print(renderLogLine(fmt.Sprintf("%s pensó %.1f s", glyphThink, live.reasoningSecs), sDim2, "", m.width))
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
		if !live.spoke {
			m.print("\n" + renderSpeaker("", m.width))
			live.spoke = true
		} else {
			m.print("")
		}
		m.print(m.markdown(prose))
		live.lastProse = prose
	}
	live.content.Reset()
	live.reasoning.Reset()
	live.reasoningSecs = 0
}

func (m *Model) finishTurn(msg doneMsg) tea.Cmd {
	m.flushLive()
	m.running = false
	m.notice = ""
	cancelled := m.interrupted || errors.Is(msg.err, context.Canceled)
	m.interrupted = false
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}

	switch {
	case msg.err != nil && !errors.Is(msg.err, context.Canceled):
		m.print(m.reportError(msg.err))
	default:
		if answer := strings.TrimSpace(msg.answer); answer != "" {
			shown := answer
			if m.chat.Mode == chat.ModeAgent {
				shown = toolparse.CleanProse(answer)
			}
			if shown != "" && shown != m.live.lastProse && !m.live.spoke {
				m.print("\n" + renderSpeaker("", m.width))
				m.print(m.markdown(shown))
			} else if shown != "" && shown != m.live.lastProse && m.live.usedTools {
				m.print("")
				m.print(m.markdown(shown))
			}
		} else if m.chat.Mode != chat.ModeAgent && !m.live.spoke {
			m.print(renderLogLine("(sin respuesta)  "+glyphSep+"  el modelo no devolvió texto; /doctor revisa la conexión", sDim2, "", m.width))
		}
	}
	if cancelled {
		m.print("\n" + sWarn.Render("— interrumpido —") + sDim2.Render("  el contexto se conserva: escribe «continúa» para seguir"))
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
		m.print(sDim2.Render("fuentes  " + strings.Join(labels, "  "+glyphSep+"  ")))
	}
	if m.chat.Mode == chat.ModeAgent {
		st := m.chat.Session.Stats
		if line := renderTurnSummary(st.Actions, len(st.Files), st.Adds, st.Dels, time.Since(m.started).Seconds(), m.width); line != "" {
			m.print("\n" + line)
		}
	}
	m.print("")
	if h := m.chat.History; len(h) > 0 && h[len(h)-1].Role == "assistant" {
		m.lastAnswer = h[len(h)-1].Content
	}
	m.refreshContext()

	if len(m.queue) > 0 && !m.quitting {
		next := m.queue[0]
		m.queue = m.queue[1:]
		return m.dispatch(next)
	}
	return nil
}

// reportError traduce un error del gateway a la acción que lo resuelve.
func (m *Model) reportError(err error) string {
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
		return errLine("Demasiadas peticiones seguidas; espera unos segundos.")
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
	p := newPicker(title, options, func(value string, cancelled bool) tea.Cmd {
		d := agent.Deny
		if !cancelled {
			switch value {
			case "yes":
				d = agent.Allow
			case "always":
				d = agent.AllowAlways
			case "prefix":
				d = agent.AllowPrefix
			}
		}
		reply <- d
		return nil
	})
	p.cancel = "no"
	p.detail = req.Detail
	if p.detail == "" {
		p.detail = req.Summary
	}
	p.hint = fmt.Sprintf("↑↓ mover %s ↵ elegir %s esc = No", glyphSep, glyphSep)
	m.picker = p
	return nil
}

func (m *Model) openAsk(msg askMsg) tea.Cmd {
	m.print("")
	reply := msg.reply
	freeText := func() {
		m.print(rail(true) + sBold.Render(msg.question))
		m.print(note("escribe tu respuesta y pulsa Enter (Esc cancela)"))
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
	return nil
}
