package tui

import (
	"context"
	"sync"
	"time"

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
	// approvalClosedMsg retira el panel de una aprobación que ya no espera
	// (se respondió en el móvil o se canceló el turno).
	approvalClosedMsg struct{ reply chan agent.Decision }
	// askClosedMsg retira la pregunta que ya se respondió en el móvil.
	askClosedMsg struct{ reply chan askReply }
	tickMsg      struct{}
)

type askReply struct {
	answer string
	ok     bool
}

// deltaEvery agrupa los fragmentos del modelo: llegan de a un token y cada
// mensaje repinta la pantalla entera, así que uno por token encolaba más de lo
// que la interfaz pintaba y la salida aparecía de golpe al final.
var deltaEvery = 40 * time.Millisecond

// uiSink traslada lo que ocurre durante un turno a mensajes de Bubble Tea.
type uiSink struct {
	send func(tea.Msg)
	turn int

	// mu se mantiene durante los envíos para que un evento nunca adelante a
	// los fragmentos que llegaron antes que él.
	mu      sync.Mutex
	pending []deltaMsg
	timer   *time.Timer
}

func (s *uiSink) Delta(kind sse.Kind, text string) {
	if deltaEvery <= 0 {
		s.send(deltaMsg{s.turn, kind, text})
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if n := len(s.pending); n > 0 && s.pending[n-1].kind == kind && kind != sse.Usage {
		s.pending[n-1].text += text
	} else {
		s.pending = append(s.pending, deltaMsg{s.turn, kind, text})
	}
	if s.timer == nil {
		s.timer = time.AfterFunc(deltaEvery, s.flush)
	}
}

func (s *uiSink) flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flushLocked()
}

func (s *uiSink) flushLocked() {
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	batch := s.pending
	s.pending = nil
	for _, d := range batch {
		s.send(d)
	}
}

func (s *uiSink) Event(e agent.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flushLocked()
	s.send(eventMsg{s.turn, e})
}

func (s *uiSink) Note(text string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.flushLocked()
	s.send(noteMsg{s.turn, text})
}

func (s *uiSink) Title(title string) { s.send(titleMsg{title}) }

// uiApprover pide la aprobación a la interfaz y espera la respuesta.
type uiApprover struct{ send func(tea.Msg) }

func (a *uiApprover) Approve(ctx context.Context, req agent.Approval) (agent.Decision, error) {
	reply := make(chan agent.Decision, 1)
	a.send(approvalMsg{req: req, reply: reply})
	select {
	case d := <-reply:
		return d, nil
	case <-ctx.Done():
		a.send(approvalClosedMsg{reply})
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
			send(askClosedMsg{reply})
			return "", false
		}
	}
}
