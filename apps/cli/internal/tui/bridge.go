package tui

import (
	"context"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/sse"
	"lixbon.com/cli/internal/tools"
)

// Los mensajes llegan desde la goroutine del turno; cada uno lleva el número
// de turno para descartar los de un turno ya cancelado.
type (
	deltaMsg struct {
		turn int
		kind sse.Kind
		text string
	}
	eventMsg struct {
		turn int
		e    agent.Event
	}
	noteMsg struct {
		turn int
		text string
	}
	titleMsg struct{ title string }
	doneMsg  struct {
		turn   int
		answer string
		err    error
	}
	approvalMsg struct {
		req   agent.Approval
		reply chan agent.Decision
	}
	askMsg struct {
		question string
		options  []string
		reply    chan askReply
	}
	todoMsg struct{ items, previous []tools.TodoItem }
	tickMsg struct{}
)

type askReply struct {
	answer string
	ok     bool
}

// uiSink traslada lo que ocurre durante un turno a mensajes de Bubble Tea.
type uiSink struct {
	send func(tea.Msg)
	turn int
}

func (s *uiSink) Delta(kind sse.Kind, text string) { s.send(deltaMsg{s.turn, kind, text}) }
func (s *uiSink) Event(e agent.Event)              { s.send(eventMsg{s.turn, e}) }
func (s *uiSink) Note(text string)                 { s.send(noteMsg{s.turn, text}) }
func (s *uiSink) Title(title string)               { s.send(titleMsg{title}) }

// uiApprover pide la aprobación a la interfaz y espera la respuesta.
type uiApprover struct{ send func(tea.Msg) }

func (a *uiApprover) Approve(ctx context.Context, req agent.Approval) (agent.Decision, error) {
	reply := make(chan agent.Decision, 1)
	a.send(approvalMsg{req: req, reply: reply})
	select {
	case d := <-reply:
		return d, nil
	case <-ctx.Done():
		return agent.Deny, ctx.Err()
	}
}

// askUser implementa la herramienta ask_user: pregunta al usuario y espera.
func askUser(send func(tea.Msg)) func(ctx context.Context, question string, options []string) (string, bool) {
	return func(ctx context.Context, question string, options []string) (string, bool) {
		reply := make(chan askReply, 1)
		send(askMsg{question: question, options: options, reply: reply})
		select {
		case r := <-reply:
			return r.answer, r.ok
		case <-ctx.Done():
			return "", false
		}
	}
}
