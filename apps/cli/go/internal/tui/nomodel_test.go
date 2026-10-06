package tui

import "testing"

func TestWithoutModelMessagesAreRefusedAndCommandsWork(t *testing.T) {
	h := newHarness(t, func(c *configT) { c.Model = "" })
	h.send("hola")
	h.settle()
	contains(t, h.out(), "Todavía no hay un modelo elegido")
	if h.gw.count() != 0 {
		t.Fatalf("no debe llamar al modelo: %d peticiones", h.gw.count())
	}
	if h.m.running {
		t.Fatal("no debe quedar un turno en marcha")
	}

	h.send("/cost")
	contains(t, h.out(), "Tokens de la sesión")

	h.m.opts.Account.Models = nil
	h.send("/model")
	contains(t, h.out(), "El servidor no tiene modelos disponibles")
}
