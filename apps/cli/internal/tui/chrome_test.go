package tui

import (
	"lixbon.com/cli/internal/sse"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

func TestTopBarDegradesByWidth(t *testing.T) {
	h := newHarness(t, nil)
	home, _ := os.UserHomeDir()
	h.chat.Workspace = filepath.Join(home, "proyectos", "api")
	h.chat.WebMode = "on"
	h.chat.ProjectContext = "contexto"
	h.chat.Cfg.SetExtraString("plan_name", "Pro")
	h.m.branch = "feature/login-web"
	cases := []struct {
		width     int
		want, not []string
	}{
		{120, []string{"LIXBON", "plan Pro", "web", "LIXBON.md", "feature/login-web", "Qwen"}, nil},
		{80, []string{"LIXBON", "Pro", "Qwen"}, []string{"LIXBON.md", "plan Pro"}},
		{50, []string{"Qwen", filepath.Base(h.chat.Workspace)}, []string{"LIXBON ", "Pro"}},
	}
	for _, c := range cases {
		bar := h.m.topBar(c.width)
		if w := ansi.StringWidth(bar); w > c.width {
			t.Fatalf("%d columnas: la barra mide %d", c.width, w)
		}
		plain := ansi.Strip(bar)
		for _, s := range c.want {
			if !strings.Contains(plain, s) {
				t.Errorf("%d columnas: falta %q en %q", c.width, s, plain)
			}
		}
		for _, s := range c.not {
			if strings.Contains(plain, s) {
				t.Errorf("%d columnas: sobra %q en %q", c.width, s, plain)
			}
		}
	}
	for width := 1; width <= 140; width++ {
		if w := ansi.StringWidth(h.m.topBar(width)); w > width {
			t.Fatalf("%d columnas: la barra mide %d", width, w)
		}
	}
}

func TestTopBarShowsTheSessionState(t *testing.T) {
	h := newHarness(t, nil)
	h.chat.Cfg.APIKey = ""
	contains(t, ansi.Strip(h.m.topBar(120)), "sin sesión")
}

func TestClickingTheModelOpensThePicker(t *testing.T) {
	h := newHarness(t, nil)
	h.m.View()
	if h.m.barModel.x1 == 0 {
		t.Fatal("la barra superior debe apuntar dónde está el modelo")
	}
	h.update(tea.MouseClickMsg{X: h.m.barModel.x0, Y: 0, Button: tea.MouseLeft})
	if h.m.picker == nil || h.m.picker.title != "Modelo" {
		t.Fatal("un clic en el modelo abre el selector")
	}
	screen := ansi.Strip(h.m.View().Content)
	if h.m.panelY != 1 || h.m.panelX+h.m.panelW < h.m.barModel.x0 || h.m.panelX > h.m.barModel.x1 {
		t.Fatalf("el selector se despliega bajo el botón: panel x=%d y=%d w=%d, botón %+v", h.m.panelX, h.m.panelY, h.m.panelW, h.m.barModel)
	}
	if rows := strings.Split(screen, "\n"); !strings.Contains(rows[1], "Modelo") {
		t.Fatalf("el borde del selector va justo bajo la barra: %q", rows[1])
	}
	h.update(tea.MouseClickMsg{X: h.m.panelX + 4, Y: h.m.panelY + h.m.picker.optionTop + 1, Button: tea.MouseLeft})
	if h.m.picker != nil || h.chat.Model != "llama" {
		t.Fatalf("un clic en una fila la elige: modelo %q", h.chat.Model)
	}
	h.m.View()
	h.update(tea.MouseClickMsg{X: h.m.footMode.x0 + 1, Y: h.m.height - 1, Button: tea.MouseLeft})
	if h.m.modeName() != "agent" {
		t.Fatalf("un clic en el modo del pie lo cambia: %s", h.m.modeName())
	}
}

func TestChromeButtonsWorkWhileTheAgentRuns(t *testing.T) {
	h := newHarness(t, nil)
	h.m.running = true
	h.m.View()
	h.update(tea.MouseClickMsg{X: h.m.barModel.x0, Y: 0, Button: tea.MouseLeft})
	if h.m.picker == nil || h.m.picker.anchor == nil {
		t.Fatal("con el agente trabajando el botón del modelo abre su selector, anclado")
	}
	h.m.View()
	if !strings.Contains(h.m.topBar(h.m.width), "\x1b[") {
		t.Fatal("la barra se pinta")
	}
	h.update(tea.MouseClickMsg{X: 0, Y: h.m.height / 2, Button: tea.MouseLeft})
	if h.m.picker != nil {
		t.Fatal("un clic fuera del panel lo cierra")
	}
	h.m.View()
	h.update(tea.MouseClickMsg{X: h.m.footMode.x0 + 1, Y: h.m.height - 1, Button: tea.MouseLeft})
	if h.m.modeName() != "agent" {
		t.Fatalf("el modo cambia aunque el agente trabaje: %s", h.m.modeName())
	}
	h.update(tea.MouseClickMsg{X: h.m.footEffort.x0, Y: h.m.height - 1, Button: tea.MouseLeft})
	if h.m.picker == nil || h.m.picker.anchor == nil {
		t.Fatal("el razonamiento abre su selector anclado al pie")
	}
	h.m.View()
	if h.m.panelY+h.m.panelH != h.m.height-1 {
		t.Fatalf("el panel del pie termina justo encima: y=%d h=%d alto=%d", h.m.panelY, h.m.panelH, h.m.height)
	}
}

func TestGitBranchReadsHeadWorktreesAndDetached(t *testing.T) {
	root := t.TempDir()
	write := func(path, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	repo := filepath.Join(root, "repo")
	write(filepath.Join(repo, ".git", "HEAD"), "ref: refs/heads/feature/login\n")
	sub := filepath.Join(repo, "a", "b")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := gitBranch(sub); got != "feature/login" {
		t.Errorf("subcarpeta: %q", got)
	}
	tree := filepath.Join(root, "tree")
	write(filepath.Join(root, "gitdirs", "tree", "HEAD"), "ref: refs/heads/wt\n")
	write(filepath.Join(tree, ".git"), "gitdir: ../gitdirs/tree\n")
	if got := gitBranch(tree); got != "wt" {
		t.Errorf("worktree: %q", got)
	}
	detached := filepath.Join(root, "detached")
	write(filepath.Join(detached, ".git", "HEAD"), "0123456789abcdef\n")
	if got := gitBranch(detached); got != "0123456" {
		t.Errorf("HEAD separado: %q", got)
	}
	if got := gitBranch(t.TempDir()); got != "" {
		t.Errorf("fuera de un repo: %q", got)
	}
}

func TestLiveLabelFollowsTheTurn(t *testing.T) {
	h := newHarness(t, nil)
	h.m.running = true
	label := func() string { l, _ := h.m.liveLabel(); return l }
	if label() != "Trabajando…" {
		t.Errorf("sin nada: %q", label())
	}
	h.m.live.reasoning.WriteString("pienso")
	if label() != "Pensando…" {
		t.Errorf("razonando: %q", label())
	}
	h.m.live.content.WriteString("respuesta")
	if label() != "Escribiendo la respuesta…" {
		t.Errorf("escribiendo: %q", label())
	}
	h.m.live = liveState{}
	b := &toolBlock{verb: "Ejecutar", gerund: "Ejecutando", target: "go test ./...", state: toolRunning}
	h.m.openTool = h.m.add(b)
	if label() != "Ejecutando go test ./...…" {
		t.Errorf("herramienta: %q", label())
	}
	h.m.interrupted = true
	if l, warn := h.m.liveLabel(); l != "interrumpiendo…" || !warn {
		t.Errorf("interrumpiendo: %q %v", l, warn)
	}
	t.Setenv("LIXBON_REDUCED_MOTION", "1")
	if h.m.spinFrame() != glyphSpark || ansi.Strip(h.m.shimmer("hola")) != "hola" {
		t.Error("con movimiento reducido el destello no gira")
	}
	h.m.running = false
}

func TestSecretPromptsNeverLeakTheKey(t *testing.T) {
	h := newHarness(t, nil)
	const secret = "lixbon_sk_supersecreta123"
	var got string
	h.update(promptMsg{label: "API key de «groq»", secret: true, onSubmit: func(v string) tea.Cmd { got = v; return nil }})
	if h.m.secret == nil {
		t.Fatal("las claves se piden enmascaradas")
	}
	h.typeText(secret[:15])
	h.update(pasteMsg(secret[15:]))
	view := h.view()
	notContains(t, view, "super")
	notContains(t, view, "secreta")
	contains(t, view, "•••")
	if got := h.m.input.Value(); got != "" {
		t.Fatalf("la clave no va a la caja normal: %q", got)
	}
	h.key("enter")
	h.settle()
	if got != secret {
		t.Fatalf("la clave llega entera al que la pidió: %q", got)
	}
	notContains(t, h.out(), secret)
	for _, e := range h.m.hist.entries {
		if strings.Contains(e, secret) {
			t.Fatalf("la clave llegó al historial: %q", e)
		}
	}

	h.send("/key " + secret)
	h.settle()
	notContains(t, h.out(), secret)
	last := h.m.hist.entries[len(h.m.hist.entries)-1]
	if strings.Contains(last, secret) || !strings.HasPrefix(last, "/key lixbon_sk_") {
		t.Fatalf("el historial guarda /key enmascarada: %q", last)
	}
}

func TestClickingABlockHeaderUnfoldsIt(t *testing.T) {
	h := newHarness(t, nil)
	e := h.m.add(thinkBlock{text: "primera idea\nsegunda idea", secs: 2})
	h.m.View()
	row := h.m.log.start(e) - h.m.winTop + h.m.winY
	h.update(tea.MouseClickMsg{X: 3, Y: row, Button: tea.MouseLeft})
	h.update(tea.MouseReleaseMsg{X: 3, Y: row, Button: tea.MouseLeft})
	if !e.open {
		t.Fatal("un clic en la cabecera del pensamiento lo despliega")
	}
	contains(t, h.view(), "segunda idea")
}

func TestChromeFitsWhileWorking(t *testing.T) {
	h := newHarness(t, nil)
	h.m.printHeader()
	h.m.running = true
	h.m.live.reasoning.WriteString(strings.Repeat("razonando sobre algo largo ", 6))
	h.m.todo = []todoItem{{Text: "un paso con un nombre bastante largo", Status: "doing"}}
	h.m.queue = []string{"un mensaje en cola con texto de sobra para recortar"}
	for width := 4; width <= 140; width += 3 {
		for _, height := range []int{6, 12, 24} {
			h.update(tea.WindowSizeMsg{Width: width, Height: height})
			assertFits(t, h, "trabajando", width, height)
		}
	}
	h.m.running = false
	h.m.picker = newPicker("¿Ejecutar este comando?", []option{{Label: "Sí", Value: "yes"}, {Label: "No", Value: "no"}}, nil)
	h.m.picker.body = []string{"$ go build ./... && ./bin/migrate --local"}
	h.m.picker.tone = pal.warn
	for width := 4; width <= 140; width += 3 {
		for _, height := range []int{6, 12, 24} {
			h.update(tea.WindowSizeMsg{Width: width, Height: height})
			assertFits(t, h, "aprobación", width, height)
		}
	}
}

func TestLiveTokensSwitchToTheRealCountAtTheEndOfEachStep(t *testing.T) {
	h := newHarness(t, nil)
	m := h.m
	m.turn, m.charsPerToken = 1, 4
	m.Update(deltaMsg{turn: 1, kind: sse.Reasoning, text: strings.Repeat("x", 400)})
	if got := m.liveTokens(); got != 100 {
		t.Fatalf("estimado durante el paso: %d", got)
	}
	m.Update(deltaMsg{turn: 1, kind: sse.Usage, text: "130"})
	m.Update(deltaMsg{turn: 1, kind: sse.Content, text: strings.Repeat("y", 40)})
	if got := m.liveTokens(); got != 140 {
		t.Fatalf("real del paso terminado más el estimado del nuevo: %d", got)
	}
}
