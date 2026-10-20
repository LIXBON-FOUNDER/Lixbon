package tui

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"lixbon.com/cli/internal/api"
)

func TestFuzzyRanksPrefixThenSubstringThenSubsequence(t *testing.T) {
	prefix, _, _ := fuzzy("model", "mo")
	sub, _, _ := fuzzy("remote", "mo")
	seq, pos, ok := fuzzy("compact", "cpt")
	if !(prefix > sub && sub > seq) || !ok {
		t.Fatalf("orden: prefijo %d, subcadena %d, subsecuencia %d", prefix, sub, seq)
	}
	if len(pos) != 3 || pos[0] != 0 || pos[2] != 6 {
		t.Errorf("posiciones: %v", pos)
	}
	if _, _, ok := fuzzy("help", "mo"); ok {
		t.Error("help no casa con mo")
	}
}

func TestSlashMenuIsGroupedAndPointsAtTheBestMatch(t *testing.T) {
	h := newHarness(t, nil)
	h.input("/mo")
	var labels []string
	for _, it := range h.m.menu {
		labels = append(labels, it.label)
	}
	if len(labels) < 3 || labels[0] != "/mode" || labels[1] != "/model" || !contains2(labels, "/remote") {
		t.Fatalf("menú: %v", labels)
	}
	if h.m.menu[h.m.menuCursor].label != "/mode" {
		t.Errorf("el cursor va a la mejor coincidencia: %s", h.m.menu[h.m.menuCursor].label)
	}
	view := h.view()
	contains(t, view, "Conversation")
	contains(t, view, "System")
	contains(t, view, "enter run")
}

func contains2(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func writeTree(t *testing.T, root string, files ...string) {
	t.Helper()
	for _, f := range files {
		p := filepath.Join(root, filepath.FromSlash(f))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("uno\ndos\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAtMenuListsFilesAndCompletesThePath(t *testing.T) {
	h := newHarness(t, nil)
	writeTree(t, h.chat.Workspace, "src/auth/session.go", "src/auth/session_test.go", "internal/api/auth.go", "node_modules/x/index.js")
	h.m.files = nil
	h.typeText("revisa @src/au")
	if !h.m.menuFiles || len(h.m.menu) == 0 {
		t.Fatal("la @ abre el menú de archivos")
	}
	for _, it := range h.m.menu {
		if strings.Contains(it.insert, "node_modules") {
			t.Fatalf("las carpetas ignoradas no salen: %s", it.insert)
		}
	}
	view := h.view()
	contains(t, view, "archivos")
	contains(t, view, "src/auth/")
	for h.m.menu[h.m.menuCursor].insert != "src/auth/session.go" {
		h.key("down")
	}
	contains(t, h.view(), "2 líneas")
	h.key("tab")
	if got := h.m.input.Value(); got != "revisa @src/auth/session.go " {
		t.Fatalf("completar: %q", got)
	}
	if len(h.m.menu) != 0 {
		t.Error("tras completar se cierra el menú")
	}
}

func TestAtMenuRespectsGitignore(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("sin git")
	}
	h := newHarness(t, nil)
	root := h.chat.Workspace
	if out, err := exec.Command("git", "-C", root, "init", "-q").CombinedOutput(); err != nil {
		t.Skipf("git init: %v %s", err, out)
	}
	writeTree(t, root, "main.go", "secreto.txt")
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("secreto.txt\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	idx := loadFiles(root)
	if contains2(idx.paths, "secreto.txt") || !contains2(idx.paths, "main.go") {
		t.Fatalf("lista con git: %v", idx.paths)
	}
}

func TestQuestionMarkOpensTheShortcuts(t *testing.T) {
	h := newHarness(t, nil)
	h.typeText("?")
	if !h.m.shortcutsOpen || h.m.input.Value() != "" {
		t.Fatal("con la caja vacía, ? abre los atajos")
	}
	contains(t, h.view(), "Atajos")
	contains(t, h.view(), "ctrl+o")
	h.typeText("h")
	if h.m.shortcutsOpen || h.m.input.Value() != "h" {
		t.Fatalf("cualquier tecla cierra el panel y se escribe: %q", h.m.input.Value())
	}
	h.typeText("?")
	if h.m.shortcutsOpen || h.m.input.Value() != "h?" {
		t.Fatal("con texto, ? se escribe")
	}
}

func TestDroppingAnImagePathAttachesIt(t *testing.T) {
	h := newHarness(t, nil)
	writeImage(t, h, "captura.png")
	path := filepath.Join(h.root, "captura.png")
	h.update(pasteMsg(`& '` + path + `'`))
	if len(h.m.chips) != 1 || h.m.chips[0].name != "captura.png" || h.m.chips[0].w == 0 {
		t.Fatalf("chips: %+v", h.m.chips)
	}
	contains(t, h.m.input.Value(), "[IMG#1]")
	contains(t, h.view(), "captura.png")
	h.update(pasteMsg("no es una ruta"))
	contains(t, h.m.input.Value(), "no es una ruta")

	h.m.opts.Account.Models = []api.Model{{ID: "qwen", Name: "Qwen", Capabilities: []string{"completion", "tools"}}}
	contains(t, h.view(), "no ve imágenes")
	h.m.opts.Account.Models = []api.Model{{ID: "qwen", Name: "Qwen"}}
	notContains(t, h.view(), "no ve imágenes")
}
