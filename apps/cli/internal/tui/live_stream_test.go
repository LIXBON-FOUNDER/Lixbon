package tui

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// heldReply manda la primera parte, espera a release y manda el resto.
func heldReply(first, rest string, release chan struct{}) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		send := func(text string) {
			chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}})
			io.WriteString(w, "data: "+string(chunk)+"\n\n")
			w.(http.Flusher).Flush()
		}
		send(first)
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		send(rest)
		io.WriteString(w, "data: [DONE]\n\n")
	}
}

func TestTheAnswerIsWrittenWhileItArrives(t *testing.T) {
	release := make(chan struct{})
	h := newHarness(t, nil, heldReply("La carpeta tiene tres archivos", " y una carpeta de imágenes.", release))
	h.send("¿qué hay?")
	h.pump(func() bool { return strings.Contains(h.view(), "La carpeta tiene tres archivos") })
	if !h.m.running {
		t.Fatal("la respuesta se ve mientras el turno sigue en marcha")
	}
	close(release)
	h.settle()
	view := h.view()
	contains(t, view, "tres archivos y una carpeta de imágenes.")
	if n := strings.Count(view, "La carpeta tiene tres archivos"); n != 1 {
		t.Fatalf("la respuesta sale una vez, no %d:\n%s", n, view)
	}
}

func TestAtMenuSeesFilesChangedOutsideTheCLI(t *testing.T) {
	fileIndexTTL = 0
	t.Cleanup(func() { fileIndexTTL = 2 * time.Second })
	h := newHarness(t, nil)
	writeTree(t, h.chat.Workspace, "viejo.txt")
	h.typeText("@")
	contains(t, h.view(), "viejo.txt")
	h.key("backspace")

	if err := os.Remove(filepath.Join(h.chat.Workspace, "viejo.txt")); err != nil {
		t.Fatal(err)
	}
	writeTree(t, h.chat.Workspace, "nuevo.js")
	h.typeText("@")
	view := h.view()
	contains(t, view, "nuevo.js")
	notContains(t, view, "viejo.txt")
}

func TestAtMenuSkipsTrackedFilesDeletedFromDisk(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("sin git")
	}
	h := newHarness(t, nil)
	root := h.chat.Workspace
	writeTree(t, root, "conversacion.md", "app.js")
	for _, args := range [][]string{{"init", "-q"}, {"add", "."}, {"-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "x"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	if err := os.Remove(filepath.Join(root, "conversacion.md")); err != nil {
		t.Fatal(err)
	}
	h.m.files = nil
	h.typeText("@")
	view := h.view()
	contains(t, view, "app.js")
	notContains(t, view, "conversacion.md")
}
