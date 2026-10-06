package tui

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestArrowsWalkTheWholeHistoryThroughSlashEntries(t *testing.T) {
	h := newHarness(t, nil)
	for _, entry := range []string{"uno", "/clear", "/new", "dos"} {
		h.m.hist.add(entry)
	}
	h.m.histPos = len(h.m.hist.entries)

	for _, want := range []string{"dos", "/new", "/clear", "uno"} {
		h.key("up")
		if got := h.m.input.Value(); got != want {
			t.Fatalf("↑ muestra %q, esperaba %q", got, want)
		}
	}
	for _, want := range []string{"/clear", "/new", "dos", ""} {
		h.key("down")
		if got := h.m.input.Value(); got != want {
			t.Fatalf("↓ muestra %q, esperaba %q", got, want)
		}
	}
}

func TestMenuStillOwnsTheArrowsWhileTypingASlash(t *testing.T) {
	h := newHarness(t, nil)
	h.m.hist.add("antes")
	h.m.histPos = len(h.m.hist.entries)
	h.typeText("/")
	h.key("down")
	if h.m.input.Value() != "/" || h.m.menuCursor != 1 {
		t.Fatalf("el menú debía llevarse la flecha: caja=%q cursor=%d", h.m.input.Value(), h.m.menuCursor)
	}
}

func TestClearWipesTheScreenNotJustTheContext(t *testing.T) {
	h := newHarness(t, nil, textReply("respuesta visible"))
	h.send("hola")
	h.settle()
	contains(t, h.view(), "respuesta visible")

	h.send("/clear")
	notContains(t, h.view(), "respuesta visible")
	notContains(t, h.view(), "hola")
	contains(t, h.view(), "contexto limpio")
	if len(h.chat.History) != 0 {
		t.Fatal("/clear vacía el historial")
	}
}

func TestMouseCaptureIsOffUntilRequested(t *testing.T) {
	h := newHarness(t, nil)
	if got := h.m.View().MouseMode; got != tea.MouseModeNone {
		t.Fatalf("por defecto el terminal debe poder seleccionar texto, modo %v", got)
	}
	h.send("/mouse")
	if got := h.m.View().MouseMode; got != tea.MouseModeCellMotion {
		t.Fatalf("/mouse activa la rueda, modo %v", got)
	}
	h.send("/mouse")
	if got := h.m.View().MouseMode; got != tea.MouseModeNone {
		t.Fatalf("/mouse otra vez la quita, modo %v", got)
	}
}
