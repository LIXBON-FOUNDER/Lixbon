package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"
)

// rosa fluorescente del tema oscuro (#FF4FD8) en una secuencia de color de 24 bits.
const shellPink = "38;2;255;79;216"

func TestShellCommandsStandOutInTheShellColor(t *testing.T) {
	applyTheme(darkPalette)
	t.Cleanup(func() { applyTheme(darkPalette) })

	echo := echoBlock("! lxo task show t4").render(80, false)
	if !strings.Contains(echo, shellPink) {
		t.Fatalf("el eco de «!» va en el color de shell: %q", echo)
	}
	if plain := echoBlock("hola").render(80, false); strings.Contains(plain, shellPink) {
		t.Fatalf("un mensaje normal no va en el color de shell: %q", plain)
	}

	shell := &toolBlock{shell: true, verb: "Ejecutar", target: "git status", command: true, state: toolDone, tone: toneCommand}
	head := shell.header(80)
	if !strings.Contains(head, shellPink) || !strings.Contains(ansi.Strip(head), "!       git status") {
		t.Fatalf("la cabecera de una orden del usuario lleva «!» y la orden en el color de shell: %q", head)
	}
	model := &toolBlock{verb: "Ejecutar", target: "go test", command: true, state: toolDone, tone: toneCommand}
	if h := model.header(80); strings.Contains(h, shellPink) || !strings.Contains(ansi.Strip(h), "$       go test") {
		t.Fatalf("una orden del modelo sigue con «$» y sin el color de shell: %q", h)
	}

	if lightPalette.shell == "" || lightPalette.shell == darkPalette.shell {
		t.Fatal("el tema claro tiene su propio tono, legible sobre fondo claro")
	}
}

func TestThePromptTurnsShellColoredWhileTypingABang(t *testing.T) {
	applyTheme(darkPalette)
	h := newHarness(t, nil)
	h.m.input.SetValue("!git status")
	if view := h.m.input.View(); !strings.Contains(view, shellPink) {
		t.Fatalf("con «!» el prompt toma el color de shell: %q", view)
	}
	h.m.input.SetValue("hola")
	if view := h.m.input.View(); strings.Contains(view, shellPink) {
		t.Fatalf("sin «!» el prompt sigue con su color: %q", view)
	}
}
