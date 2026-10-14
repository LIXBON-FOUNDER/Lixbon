package chat

import (
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"lixbon.com/cli/internal/agent"
)

func TestGatewayErrorMidTurnKeepsWhatTheAgentDid(t *testing.T) {
	g, client := newGateway(t)
	g.chat = func(n int, w http.ResponseWriter) {
		if n == 0 {
			reply(`{"tool":"list_files","args":{"path":"."}}`)(w)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		io.WriteString(w, `{"detail":"El nodo se desconectó"}`)
	}
	c := newChat(t, client, nil, Options{})
	c.Mode = ModeAgent
	_, err := c.Send(context.Background(), "haz la web", nil)
	var kept *Interrupted
	if !errors.As(err, &kept) {
		t.Fatalf("el error del gateway tras actuar se marca como turno interrumpido: %v", err)
	}
	if len(c.History) < 3 || c.History[0].Content != "haz la web" {
		t.Fatalf("el mensaje y los pasos hechos siguen en el historial: %+v", c.History)
	}
	if list := c.Store.List(10); len(list) != 1 || list[0].Messages != len(c.History) {
		t.Fatalf("la sesión se guarda aunque el turno acabara en error: %+v", list)
	}
}

func TestGatewayErrorBeforeAnyActionDropsTheMessage(t *testing.T) {
	g, client := newGateway(t)
	g.chat = func(n int, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		io.WriteString(w, `{"detail":"El nodo se desconectó"}`)
	}
	c := newChat(t, client, nil, Options{})
	c.Mode = ModeAgent
	_, err := c.Send(context.Background(), "haz la web", nil)
	var kept *Interrupted
	if err == nil || errors.As(err, &kept) || len(c.History) != 0 {
		t.Fatalf("sin nada hecho no hay turno que conservar: %v %+v", err, c.History)
	}
}

func TestSilentModelEndsTheTurnWithAnErrorAndKeepsTheMessage(t *testing.T) {
	g, client := newGateway(t)
	g.chat = func(n int, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: [DONE]\n\n")
	}
	c := newChat(t, client, nil, Options{})
	c.Mode = ModeAgent
	answer, err := c.Send(context.Background(), "arregla el login", nil)
	var stop *agent.Stopped
	if !errors.As(err, &stop) || answer != "" {
		t.Fatalf("sin respuesta del modelo el turno acaba en error, no en una respuesta inventada: %q %v", answer, err)
	}
	if len(c.History) == 0 || c.History[0].Content != "arregla el login" {
		t.Fatalf("el mensaje del usuario sigue en el historial para poder decir «continúa»: %+v", c.History)
	}
	for _, m := range c.History {
		if m.Role == "assistant" {
			t.Fatalf("el CLI no habla como si fuera el modelo: %q", m.Content)
		}
	}
}
