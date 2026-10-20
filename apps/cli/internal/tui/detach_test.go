package tui

import (
	"runtime"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// ctrl+b manda al fondo el comando que corre: el turno sigue con lo que
// llevaba escrito y el proceso queda vivo en /ps.
func TestCtrlBSendsTheRunningCommandToTheBackground(t *testing.T) {
	wait := "sleep 30"
	if runtime.GOOS == "windows" {
		wait = "ping -n 30 127.0.0.1 >nul"
	}
	h := agentHarness(t, true,
		toolReply("c1", "run_command", map[string]any{"command": wait}),
		textReply("Sigue en el fondo."))
	t.Cleanup(h.m.chat.Toolbox.Procs.StopAll)
	h.send("arranca la espera")
	h.pump(func() bool { return h.m.picker != nil })
	h.key("enter")
	h.pump(h.m.commandRunning)
	contains(t, h.view(), "ctrl+b al fondo")
	h.update(tea.KeyPressMsg{Code: 'b', Mod: tea.ModCtrl})
	h.settle()
	contains(t, h.out(), "en segundo plano")
	contains(t, h.out(), "Sigue en el fondo.")
	h.update(tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl})
	notContains(t, h.out(), "read_output")
	if bg, ok := h.m.chat.Toolbox.Procs.Get("p1"); !ok || !bg.Alive() {
		t.Fatal("el comando debe seguir vivo en segundo plano")
	}
}
