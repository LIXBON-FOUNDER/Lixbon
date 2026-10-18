package tui

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/history"
)

func TestSettingsCommandsStayOutOfTheTranscript(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/model llama")
	notContains(t, ansi.Strip(h.m.log.text()), "/model")
	notContains(t, ansi.Strip(h.m.log.text()), "Modelo: Llama")
	contains(t, h.view(), "Modelo: Llama")

	h.send("/cost")
	contains(t, h.view(), "Consumo de la sesión")
	notContains(t, ansi.Strip(h.m.log.text()), "Consumo de la sesión")
	h.typeText("x")
	if h.m.picker != nil || h.m.input.Value() != "x" {
		t.Fatalf("escribir debe cerrar el panel y llegar a la caja: picker=%v caja=%q", h.m.picker != nil, h.m.input.Value())
	}
}

func TestWorkspaceBrowserNavigatesAndUpdatesTheHeader(t *testing.T) {
	h := newHarness(t, nil)
	os.MkdirAll(filepath.Join(h.root, "alpha"), 0o755)
	os.MkdirAll(filepath.Join(h.root, "beta", "inner"), 0o755)
	os.MkdirAll(filepath.Join(h.root, ".oculta"), 0o755)
	h.m.printHeader()

	h.send("/workspace")
	view := h.view()
	contains(t, view, "alpha")
	contains(t, view, "beta")
	notContains(t, view, ".oculta")

	h.typeText("bet")
	h.key("right")
	contains(t, h.view(), "inner")
	h.key("left")
	contains(t, h.view(), "alpha")
	h.key("enter")

	want, _ := filepath.EvalSymlinks(filepath.Join(h.root, "beta"))
	if !samePath(h.chat.Workspace, want) {
		t.Fatalf("workspace %q, se esperaba %q", h.chat.Workspace, want)
	}
	contains(t, ansi.Strip(h.m.log.text()), "beta")
}

func TestWorkspaceAcceptsAPathFromHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("USERPROFILE", home)
	t.Setenv("HOME", home)
	os.MkdirAll(filepath.Join(home, "Desktop", "proyecto"), 0o755)
	h := newHarness(t, nil)
	h.send("/workspace desktop/proyecto")
	if !strings.EqualFold(filepath.Base(h.chat.Workspace), "proyecto") {
		t.Fatalf("workspace %q", h.chat.Workspace)
	}
}

func TestChangingFolderStartsAFreshConversationAndHistoryIsPerFolder(t *testing.T) {
	h := newHarness(t, nil, textReply("respuesta"))
	h.send("hola desde la raíz")
	h.settle()
	first := h.chat.ConversationID

	other := t.TempDir()
	h.send("/workspace " + other)
	if h.chat.ConversationID == first || len(h.chat.History) != 0 {
		t.Fatal("al cambiar de carpeta debe empezar otra conversación con el contexto vacío")
	}
	if tok, _ := h.chat.ContextUsage(); tok != 0 {
		t.Fatalf("el contexto es de la conversación: %d", tok)
	}

	h.send("/history")
	contains(t, h.out(), "No hay conversaciones en")
	h.send("/history todas")
	contains(t, h.view(), "Conversaciones de todas las carpetas")
	h.key("enter")
	if h.chat.ConversationID != first {
		t.Fatal("debía reabrir la conversación")
	}
	if want, _ := filepath.EvalSymlinks(h.root); !samePath(h.chat.Workspace, want) {
		t.Fatalf("reabrirla vuelve a su carpeta: %q", h.chat.Workspace)
	}
}

func TestKeyCommandOnlyExistsForAPIKeySessions(t *testing.T) {
	h := newHarness(t, func(c *configT) { c.SetExtraString("account_email", "ana@estudio.dev") })
	for _, s := range h.m.allSpecs() {
		if s.Name == "key" {
			t.Fatal("/key no debe ofrecerse con sesión de cuenta")
		}
	}
	h.send("/key lixbon_sk_otra")
	contains(t, h.view(), "/key es para sesiones con API key")
	if h.chat.Cfg.APIKey != "k" {
		t.Fatal("no debe cambiar la clave")
	}
}

func TestEffortIsSentAndShownInTheFooter(t *testing.T) {
	h := newHarness(t, nil, textReply("ok"))
	h.send("/effort high")
	contains(t, h.view(), "acepta: auto, on, off")
	h.send("/effort off")
	contains(t, h.view(), "razonamiento apagado")
	h.send("hola")
	h.settle()
	if think, ok := h.gw.bodyAt(0)["think"]; !ok || think != false {
		t.Fatalf("think enviado: %v", h.gw.bodyAt(0)["think"])
	}
	if configLoad(h.chat.ConfigPath).ExtraString("effort") != "off" {
		t.Fatal("el esfuerzo debe quedar guardado")
	}
}

func TestQuotaIsAccountWideInTheTopBar(t *testing.T) {
	h := newHarness(t, nil)
	h.update(h.m.fetchQuota()())
	contains(t, h.view(), "sesión 30%")
}

func TestRemoteShowsInTheTopBar(t *testing.T) {
	h := newHarness(t, nil)
	h.m.remote = &remoteHost{}
	contains(t, h.view(), "Remote: conectado")
	h.m.remote = nil
}

func TestBranchPickerSwitchesBranches(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("sin git")
	}
	h := newHarness(t, nil)
	git := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"}, args...)...)
		cmd.Dir = h.root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-q")
	git("commit", "-q", "--allow-empty", "-m", "uno")
	git("branch", "otra")
	h.m.refreshGit()
	h.m.printHeader()

	h.send("/branch")
	h.settle()
	contains(t, h.view(), "otra")
	contains(t, h.view(), "rama nueva")
	h.typeText("otra")
	h.key("enter")
	h.settle()
	if h.m.branch != "otra" {
		t.Fatalf("rama %q", h.m.branch)
	}
	contains(t, h.view(), "otra")
}

func TestFetchShowsURLSizeAndStatus(t *testing.T) {
	b := newToolBlock(agent.Event{Tool: "fetch_url", Text: "https://lixbon.com/docs"}, nil)
	contains(t, ansi.Strip(b.render(80, false)), "Fetch  https://lixbon.com/docs")
	contains(t, ansi.Strip(b.render(80, false)), "Descargando")
	b.finish(agent.Event{Summary: "Recibido 196.6 KB (200 OK)"})
	contains(t, ansi.Strip(b.render(80, false)), "Recibido 196.6 KB (200 OK)")
}

func TestComposerHasRoomAboveIt(t *testing.T) {
	h := newHarness(t, nil)
	lines := strings.Split(h.view(), "\n")
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "╭") {
			if strings.TrimSpace(lines[i-1]) != "" {
				t.Fatalf("falta aire sobre la caja:\n%s", h.view())
			}
			return
		}
	}
	t.Fatal("no se encontró la caja")
}

func TestAgentFetchShowsItsOwnBlock(t *testing.T) {
	page := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, strings.Repeat("x", 2048))
	}))
	defer page.Close()
	h := newHarness(t, func(c *configT) { c.Mode = "agent" },
		toolReply("c1", "fetch_url", map[string]any{"url": page.URL + "/docs"}), textReply("listo"))
	h.send("busca la documentación")
	h.settle()
	out := ansi.Strip(h.m.log.text())
	contains(t, out, "Fetch  "+page.URL+"/docs")
	contains(t, out, "Recibido 2.0 KB (200 OK)")
}

func TestClickableZonesLightUpOnHover(t *testing.T) {
	h := newHarness(t, nil)
	h.m.branch = "main"
	plain := h.m.View().Content
	z := h.m.barBranch
	if z.x1 <= z.x0 {
		t.Fatal("la rama debe ser una zona clicable")
	}
	h.update(tea.MouseMotionMsg{X: z.x0 + 1, Y: 0})
	if lit := h.m.View().Content; lit == plain || ansi.Strip(lit) != ansi.Strip(plain) {
		t.Fatal("al pasar por encima la rama debe iluminarse sin cambiar el texto")
	}
}

type fakeApprover struct {
	d     agent.Decision
	err   error
	block bool
}

func (f fakeApprover) Approve(ctx context.Context, _ agent.Approval) (agent.Decision, error) {
	if f.block {
		<-ctx.Done()
		return agent.Deny, ctx.Err()
	}
	return f.d, f.err
}

func TestSharedApprovalTakesTheFirstAnswerAndIgnoresAClosedLink(t *testing.T) {
	waiting := fakeApprover{block: true}
	if d, _ := (sharedApprover{local: waiting, remote: fakeApprover{d: agent.Allow}}).Approve(t.Context(), agent.Approval{}); d != agent.Allow {
		t.Fatalf("el móvil respondió primero: %v", d)
	}
	gone := fakeApprover{d: agent.Deny, err: errRemoteGone}
	if d, _ := (sharedApprover{local: fakeApprover{d: agent.AllowAlways}, remote: gone}).Approve(t.Context(), agent.Approval{}); d != agent.AllowAlways {
		t.Fatalf("un enlace cerrado no decide: %v", d)
	}
}

func TestClipboardContentIsPastedIntoTheBox(t *testing.T) {
	h := newHarness(t, nil)
	h.update(tea.ClipboardMsg{Content: "hola\r\nmundo"})
	if got := h.m.input.Value(); got != "hola\nmundo" {
		t.Fatalf("caja %q", got)
	}
}

func TestCompactionSummaryIsHiddenFromTheRemoteSnapshotAndReplay(t *testing.T) {
	h := newHarness(t, nil)
	h.chat.History = []history.Message{
		history.User(history.SummaryIntro + "\nlo secreto del resumen"), history.Assistant(history.SummaryAck),
		history.User("sigue"), history.User(agent.NoOutputPrompt), history.Assistant("vale"),
	}
	snap := (&remoteHost{base: remoteHistory(h.chat.History)}).snapshotNow()
	if len(snap) != 2 || snap[0]["content"] != "sigue" {
		t.Fatalf("snapshot: %v", snap)
	}
	h.m.replayTranscript()
	out := ansi.Strip(h.m.log.text())
	contains(t, out, "Conversación compactada")
	notContains(t, out, "lo secreto del resumen")
	notContains(t, out, history.SummaryAck)
}

func TestStreamedTextIsNotShownWhileWriting(t *testing.T) {
	h := newHarness(t, nil)
	h.m.running, h.m.started = true, time.Now()
	h.m.live.content.WriteString("texto a medio escribir")
	view := h.view()
	notContains(t, view, "texto a medio escribir")
	contains(t, view, "Escribiendo la respuesta")
	h.m.running = false
}

func TestALongAnswerIsShownFromItsStart(t *testing.T) {
	long := "# Título de la respuesta\n\n" + strings.Repeat("línea de la respuesta\n\n", 60)
	h := newHarness(t, nil, textReply(long))
	h.send("explícame")
	h.settle()
	view := h.view()
	contains(t, view, "Título de la respuesta")
	contains(t, view, "líneas más")
	for range 10 {
		h.key("pgdown")
	}
	notContains(t, h.view(), "líneas más")
}

func TestRichMarkdownHeadingsCodeAndTables(t *testing.T) {
	text := "# 🚀 Uno\n\n## Dos\n\n```bash\nlixbon update\n```\n\n| A | B |\n|---|--:|\n| `x` | 1 |\n"
	out := ansi.Strip(renderRich(text, 60, func(s string, w int) string { return s }))
	for _, want := range []string{"▌ Uno", "──", "▌ Dos", "bash", "lixbon update", "┌", "│ A", "│ x │", "├", "└"} {
		contains(t, out, want)
	}
	notContains(t, out, "```")
	notContains(t, out, "|---")
}

func TestMoreLinesButtonJumpsToTheEnd(t *testing.T) {
	long := strings.Repeat("línea de la respuesta\n\n", 60)
	h := newHarness(t, nil, textReply(long))
	h.send("explícame")
	h.settle()
	h.view()
	if h.m.moreY < 0 || h.m.scroll == 0 {
		t.Fatal("debe verse el botón de más líneas")
	}
	h.update(tea.MouseClickMsg{Button: tea.MouseLeft, X: h.m.moreBtn.x0 + 1, Y: h.m.moreY})
	if h.m.scroll != 0 {
		t.Fatalf("el botón baja al final: scroll %d", h.m.scroll)
	}
	notContains(t, h.view(), "líneas más")
}
