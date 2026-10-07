package tui

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const tinyPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

func writeImage(t *testing.T, h *harness, name string) {
	t.Helper()
	data, _ := base64.StdEncoding.DecodeString(tinyPNG)
	if err := os.WriteFile(filepath.Join(h.root, name), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func lastMessage(h *harness, request int) map[string]any {
	msgs := h.gw.bodyAt(request)["messages"].([]any)
	return msgs[len(msgs)-1].(map[string]any)
}

func TestImageCommandStagesAMarkerThatTravelsWithTheMessage(t *testing.T) {
	h := newHarness(t, nil, textReply("la veo"))
	writeImage(t, h, "logo.png")

	h.send("/image logo.png")
	if got := h.m.input.Value(); got != "[IMG#1] " {
		t.Fatalf("la caja debe quedar con el marcador, tiene %q", got)
	}
	h.typeText("qué ves")
	h.key("enter")
	h.settle()

	msg := lastMessage(h, 0)
	images, _ := msg["images"].([]any)
	if len(images) != 1 || images[0] != tinyPNG {
		t.Fatalf("la imagen debe viajar en base64 con el mensaje: %v", msg)
	}
	if !strings.Contains(msg["content"].(string), "qué ves") {
		t.Fatalf("contenido: %v", msg["content"])
	}
}

func TestDeletedMarkerMeansNoImage(t *testing.T) {
	h := newHarness(t, nil, textReply("ok"))
	writeImage(t, h, "logo.png")
	h.send("/image logo.png")
	h.typeText("sin imagen")
	h.m.input.SetValue("solo texto")
	h.key("enter")
	h.settle()
	if _, has := lastMessage(h, 0)["images"]; has {
		t.Fatal("sin marcador en el texto no se envía la imagen")
	}
}

func TestBackspaceRemovesTheWholeMarker(t *testing.T) {
	h := newHarness(t, nil)
	writeImage(t, h, "logo.png")
	h.send("/image logo.png")
	h.typeText("[IMG#1]")
	h.m.input.SetValue("[IMG#1]")
	h.m.input.MoveToEnd()
	h.key("backspace")
	if got := h.m.input.Value(); got != "" {
		t.Fatalf("el marcador debía borrarse entero: %q", got)
	}
}

func TestAtPathAttachesTextAndImagesAtSendTime(t *testing.T) {
	h := newHarness(t, nil, textReply("leído"))
	writeImage(t, h, "foto.png")
	os.WriteFile(filepath.Join(h.root, "notas.txt"), []byte("hola desde el archivo\n"), 0o644)

	h.send("mira @notas.txt y @foto.png")
	h.settle()

	msg := lastMessage(h, 0)
	content := msg["content"].(string)
	if !strings.Contains(content, "Archivo adjunto `notas.txt`") || !strings.Contains(content, "hola desde el archivo") {
		t.Fatalf("falta el archivo adjunto: %q", content)
	}
	if images, _ := msg["images"].([]any); len(images) != 1 {
		t.Fatalf("falta la imagen: %v", msg)
	}
	contains(t, h.out(), "adjuntó notas.txt")
}

func TestMessageWithOnlyAFailedAttachmentIsNotSent(t *testing.T) {
	h := newHarness(t, nil)
	h.send("@fantasma.png")
	h.settle()
	if h.gw.count() != 0 {
		t.Fatal("no debe enviarse un mensaje vacío")
	}
	contains(t, h.out(), "No existe la imagen: fantasma.png")
}

func TestImageCommandRejectsBadInput(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/image")
	contains(t, h.out(), "Uso: /image <ruta>")
	h.send("/image nada.png")
	contains(t, h.out(), "No existe la imagen")
	os.WriteFile(filepath.Join(h.root, "x.gif"), []byte("GIF89a"), 0o644)
	h.send("/image x.gif")
	contains(t, h.out(), "Formato no soportado")
}
