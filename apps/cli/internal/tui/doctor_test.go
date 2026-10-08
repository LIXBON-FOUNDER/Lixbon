package tui

import "testing"

func TestDoctorReportsEnvironmentAndServer(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/doctor")
	h.settle()
	out := h.out()
	contains(t, out, "CLI")
	contains(t, out, "Servidor")
	contains(t, out, h.chat.Client.BaseURL)
	contains(t, out, "Modelos")
	contains(t, out, "2 disponibles")
}

func TestConfigMenuChangesMessagesAndRunsCommands(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/config")
	contains(t, h.view(), "Ajustes")
	contains(t, h.view(), "Ventana de contexto")

	for i := 0; i < 5; i++ {
		h.key("down")
	}
	h.key("enter")
	h.pump(func() bool { return h.m.prompt != nil })
	h.send("7")
	h.pump(func() bool { return h.m.prompt == nil })
	if h.chat.Cfg.MaxContextMessages != 7 {
		t.Fatalf("mensajes: %d", h.chat.Cfg.MaxContextMessages)
	}
	if got := configLoad(h.chat.ConfigPath).MaxContextMessages; got != 7 {
		t.Fatalf("no se guardó: %d", got)
	}
	contains(t, h.out(), "Se enviarán los últimos 7 mensajes")

	h.send("/config")
	for i := 0; i < 2; i++ {
		h.key("down")
	}
	h.key("enter")
	h.pump(func() bool { return h.chat.Session.AutoApprove != true || h.m.picker != nil })
	contains(t, h.view(), "Auto-aprobar herramientas del agente")
	h.key("esc")
	h.pump(func() bool { return h.m.picker == nil })
}

func TestConfigRejectsInvalidMessageCount(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/config")
	for i := 0; i < 5; i++ {
		h.key("down")
	}
	h.key("enter")
	h.pump(func() bool { return h.m.prompt != nil })
	h.send("muchos")
	h.pump(func() bool { return h.m.prompt == nil })
	contains(t, h.out(), "Valor no válido.")
	if h.chat.Cfg.MaxContextMessages != 12 {
		t.Fatalf("no debe cambiar: %d", h.chat.Cfg.MaxContextMessages)
	}
}
