package tui

import (
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"lixbon.com/cli/internal/history"
)

func jsonReply(body string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }
}

func TestHelpPickerGroupsAndRunsACommand(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/help")
	view := h.view()
	contains(t, view, "Comandos")
	contains(t, view, "conversación")
	contains(t, view, "/model [nombre]")
	h.typeText("cost")
	contains(t, h.view(), "/cost")
	notContains(t, h.view(), "/model")
	h.key("enter")
	h.settle()
	contains(t, h.out(), "Tokens de la sesión")

	h.send("/help plain")
	contains(t, h.out(), "agente")
	contains(t, h.out(), "/allow [comando]")
}

func TestHelpWithRequiredArgsExplainsUsage(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/help")
	h.typeText("/run")
	h.key("enter")
	contains(t, h.out(), "Uso: /run <comando>")
}

func TestModelCommand(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/model")
	contains(t, h.view(), "Qwen")
	contains(t, h.view(), "actual")
	h.key("down")
	h.key("enter")
	if h.chat.Model != "llama" || h.chat.Cfg.Model != "llama" {
		t.Fatalf("modelo: %s", h.chat.Model)
	}
	contains(t, h.out(), "Modelo: Llama")

	h.send("/model qw")
	if h.chat.Model != "qwen" {
		t.Fatalf("por coincidencia: %s", h.chat.Model)
	}
	h.send("/model algo-nuevo")
	if h.chat.Model != "algo-nuevo" {
		t.Fatalf("modelo libre: %s", h.chat.Model)
	}
	h.chat.Cfg.KeyModel = "fija"
	h.send("/model qwen")
	contains(t, h.out(), "Modelo fijo por la API key: fija")
}

func TestModeCommand(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/mode agent")
	if h.chat.Mode != "agent" {
		t.Fatal("modo agent")
	}
	contains(t, h.out(), "Workspace del agente:")
	h.send("/mode")
	contains(t, h.view(), "chat normal con el modelo")
	h.key("esc")
	if h.chat.Mode != "agent" {
		t.Fatal("Esc no cambia el modo")
	}
	h.send("/mode delegate")
	if h.chat.Mode != "delegate" || h.chat.Cfg.Mode != "delegate" {
		t.Fatal("delegate")
	}
}

func TestNewAndClearStartFromScratchAndHistoryReopens(t *testing.T) {
	h := newHarness(t, nil, textReply("respuesta uno"), textReply("respuesta dos"))
	h.send("primera conversación")
	h.settle()
	first := h.chat.ConversationID

	h.send("/new")
	contains(t, h.out(), "conversación nueva")
	if len(h.chat.History) != 0 || h.chat.ConversationID == first {
		t.Fatal("/new debe vaciar el contexto")
	}
	h.send("segunda")
	h.settle()

	h.send("/history")
	view := h.view()
	contains(t, view, "Conversaciones")
	contains(t, view, "primera conversación")
	contains(t, view, "actual")
	h.typeText("primera")
	h.key("enter")
	if h.chat.ConversationID != first || len(h.chat.History) != 2 {
		t.Fatalf("no reabrió: id=%s hist=%d", h.chat.ConversationID, len(h.chat.History))
	}
	contains(t, h.out(), "Conversación reabierta")
	contains(t, h.out(), "continúa la conversación")
	contains(t, h.out(), "respuesta uno")

	h.send("/clear")
	contains(t, h.out(), "contexto limpio")
	if len(h.chat.History) != 0 {
		t.Fatal("/clear vacía el historial")
	}
}

func TestHistoryMessagesResendsOne(t *testing.T) {
	h := newHarness(t, nil, textReply("a"), textReply("b"))
	h.send("mensaje original")
	h.settle()
	h.send("/history mensajes")
	contains(t, h.view(), "Reenviar un mensaje")
	h.key("enter")
	h.settle()
	if h.gw.count() != 2 {
		t.Fatalf("peticiones: %d", h.gw.count())
	}
	msgs := h.gw.bodyAt(1)["messages"].([]any)
	if last := msgs[len(msgs)-1].(map[string]any); last["content"] != "mensaje original" {
		t.Fatalf("reenviado: %v", last)
	}
}

func TestCompactCommand(t *testing.T) {
	h := newHarness(t, nil, jsonReply(`{"choices":[{"message":{"content":"resumen corto"}}]}`))
	h.send("/compact")
	contains(t, h.out(), "nada que compactar")
	for i := 0; i < 4; i++ {
		h.chat.History = append(h.chat.History, history.User("pregunta "+strings.Repeat("x", 50)), history.Assistant("respuesta "+strings.Repeat("y", 50)))
	}
	h.send("/compact")
	h.settle()
	contains(t, h.out(), "Conversación compactada:")
	if !strings.Contains(h.chat.History[0].Content, "resumen corto") || len(h.chat.History) != 4 {
		t.Fatalf("historial: %d, primero %q", len(h.chat.History), h.chat.History[0].Content)
	}
}

func TestSettingsCommands(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/web on")
	if h.chat.WebMode != "on" || h.chat.Cfg.WebMode() != "on" {
		t.Fatal("/web on")
	}
	contains(t, h.view(), "web")
	h.send("/approve off")
	if h.chat.Session.AutoApprove || h.chat.Cfg.AutoApproveTools {
		t.Fatal("/approve off")
	}
	h.send("/check off")
	if h.chat.Session.AutoCheck {
		t.Fatal("/check off")
	}
	h.send("/context-window 4096")
	if h.chat.Cfg.ContextWindow != 4096 || h.chat.Session.ContextWindow != 4096 {
		t.Fatal("/context-window")
	}
	h.send("/context-window 10")
	if h.chat.Cfg.ContextWindow != 1024 {
		t.Fatalf("mínimo de 1024: %d", h.chat.Cfg.ContextWindow)
	}
	h.send("/context-window abc")
	contains(t, h.out(), "Uso: /context-window 8192")
	h.send("/plan on")
	if !h.chat.Session.PlanMode || h.chat.Mode != "agent" {
		t.Fatal("/plan on pasa a agent")
	}
	h.send("/plan off")
	if h.chat.Session.PlanMode {
		t.Fatal("/plan off")
	}
	reloaded := configLoad(h.chat.ConfigPath)
	if reloaded.WebMode() != "on" || reloaded.ContextWindow != 1024 || reloaded.AutoApproveTools {
		t.Fatalf("la config no se guardó: %+v", reloaded)
	}
}

func TestAllowCommandAddsListsAndRemoves(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/allow")
	contains(t, h.out(), "Ningún comando permitido")
	h.send("/allow npm test")
	h.send("/allow pytest")
	if got := h.chat.Session.AllowedCommands; len(got) != 2 {
		t.Fatalf("lista: %v", got)
	}
	if got := configLoad(h.chat.ConfigPath).ExtraStringList("allowed_commands"); len(got) != 2 {
		t.Fatalf("no se persistió: %v", got)
	}
	h.send("/allow npm test")
	contains(t, h.out(), "«npm test» vuelve a pedir confirmación.")
	h.send("/allow")
	contains(t, h.view(), "pytest")
	h.key("up")
	h.key("enter")
	if len(h.chat.Session.AllowedCommands) != 0 {
		t.Fatalf("lista tras quitar: %v", h.chat.Session.AllowedCommands)
	}
}

func TestToolsAndCostAndStatusReports(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/tools")
	out := h.out()
	contains(t, out, "herramientas del modo agent")
	contains(t, out, "read_file")
	contains(t, out, "solo lectura")
	contains(t, out, "Protocolo: nativo")
	h.send("/cost")
	contains(t, h.out(), "Chars por token (medido)")
	h.send("/status")
	h.settle()
	contains(t, h.out(), "Cuota")
	contains(t, h.out(), "sesión 30%")
	contains(t, h.out(), "semana ∞")
	h.send("/usage")
	h.settle()
	contains(t, h.out(), "30% usado")
	contains(t, h.out(), "ilimitado")
}

func TestWorkspaceCommandReloadsProjectContext(t *testing.T) {
	h := newHarness(t, nil)
	other := t.TempDir()
	os.WriteFile(filepath.Join(other, "LIXBON.md"), []byte("Reglas"), 0o644)
	h.send("/workspace")
	contains(t, h.out(), "Workspace actual:")
	h.send("/workspace " + other)
	if h.chat.ProjectContext != "Reglas" || h.chat.Session.ProjectContext != "Reglas" {
		t.Fatalf("contexto: %q", h.chat.ProjectContext)
	}
	contains(t, h.out(), "LIXBON.md encontrado")
	if want, _ := filepath.EvalSymlinks(other); h.chat.Toolbox.Root != want {
		t.Fatalf("la raíz de las herramientas es %s, se esperaba %s", h.chat.Toolbox.Root, want)
	}
	h.send("/workspace /no/existe/seguro")
	contains(t, h.out(), "Ruta inválida o no es una carpeta.")
}

func TestSaveWritesMarkdown(t *testing.T) {
	h := newHarness(t, nil, textReply("Una respuesta"))
	h.send("/save")
	contains(t, h.out(), "La conversación está vacía.")
	h.send("una pregunta")
	h.settle()
	h.send("/save notas/chat.md")
	data, err := os.ReadFile(filepath.Join(h.chat.Workspace, "notas", "chat.md"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{"# Conversación Lixbon", "- Modelo: `qwen`", "## Tú", "una pregunta", "## Lixbon", "Una respuesta"} {
		contains(t, text, want)
	}
}

func TestRunCommandExecutesAndFeedsTheModel(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/run")
	contains(t, h.out(), "Uso: /run npm test")
	h.send("/run echo hola")
	contains(t, h.view(), "Ejecutar «echo hola»")
	h.key("down")
	h.key("enter")
	h.settle()
	contains(t, h.out(), "hola")
	contains(t, h.out(), "salida 0")
	last := h.chat.History[len(h.chat.History)-1]
	if last.Role != "user" || !strings.HasPrefix(last.Content, "TOOL_RESULT run_command `echo hola` (EXIT 0):") {
		t.Fatalf("historial: %+v", last)
	}
	if !h.chat.Session.AutoRunCommands {
		t.Fatal("«no preguntar más»")
	}
	h.send("/run echo otra")
	h.settle()
	contains(t, h.out(), "otra")
}

func TestUndoRevertsLastAgentTurn(t *testing.T) {
	h := agentHarness(t, true,
		toolReply("c1", "write_file", map[string]any{"path": "nuevo.txt", "content": "x"}),
		textReply("hecho"))
	h.send("crea nuevo.txt")
	h.settle()
	h.send("/undo")
	contains(t, h.view(), "Revertir el último turno (1 archivo)")
	h.key("enter")
	if _, err := os.Stat(filepath.Join(h.root, "nuevo.txt")); err == nil {
		t.Fatal("el archivo debía borrarse")
	}
	contains(t, h.out(), "eliminado nuevo.txt")
	contains(t, h.out(), "Cambios revertidos")
	last := h.chat.History[len(h.chat.History)-1]
	if !strings.Contains(last.Content, "revirtió con /undo") {
		t.Fatalf("el modelo debe saberlo: %+v", last)
	}
	h.send("/undo")
	contains(t, h.out(), "No hay cambios del agente que revertir")
}

func TestPsListsAndStopsBackgroundCommands(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/ps")
	contains(t, h.out(), "No hay comandos en segundo plano.")
	sleep := "sleep 30"
	if os.PathSeparator == '\\' {
		sleep = "ping -n 30 127.0.0.1 >nul"
	}
	h.chat.Toolbox.Execute(t.Context(), "run_command", map[string]any{"command": sleep, "background": true})
	h.send("/ps")
	contains(t, h.view(), "Detener alguno")
	h.key("up")
	h.key("enter")
	if len(h.chat.Toolbox.Procs.IDs()) != 0 {
		t.Fatal("el proceso debía detenerse")
	}
	contains(t, h.out(), "detenido")
}

func TestKeyCommandValidatesTheKey(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/key lixbon_sk_nueva")
	h.settle()
	contains(t, h.out(), "API key actualizada")
	if h.chat.Cfg.APIKey != "lixbon_sk_nueva" {
		t.Fatalf("clave: %q", h.chat.Cfg.APIKey)
	}
	h.send("/key")
	contains(t, h.out(), "Pega tu API key")
	if h.m.prompt == nil {
		t.Fatal("debe pedir la clave")
	}
	h.key("esc")
	if h.m.prompt != nil {
		t.Fatal("Esc cancela la pregunta")
	}
}

func TestLogoutAsksForConfirmation(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/logout")
	contains(t, h.view(), "Cerrar la sesión de")
	h.key("esc")
	if h.chat.Cfg.APIKey == "" {
		t.Fatal("Esc no cierra la sesión")
	}
	h.send("/logout")
	h.key("enter")
	if h.chat.Cfg.APIKey != "" || h.chat.Model != "" {
		t.Fatal("la sesión debía cerrarse")
	}
	contains(t, h.out(), "Sesión cerrada")
}

func TestInitWritesProjectContext(t *testing.T) {
	h := newHarness(t, nil, jsonReply("{\"choices\":[{\"message\":{\"content\":\"```md\\n# Proyecto\\nHace cosas.\\n```\"}}]}"))
	os.WriteFile(filepath.Join(h.root, "main.go"), []byte("package main"), 0o644)
	h.send("/init")
	h.settle()
	data, _ := os.ReadFile(filepath.Join(h.chat.Workspace, "LIXBON.md"))
	if string(data) != "# Proyecto\nHace cosas.\n" {
		t.Fatalf("LIXBON.md: %q", data)
	}
	if h.chat.ProjectContext == "" || h.chat.Session.ProjectContext == "" {
		t.Fatal("el contexto debe cargarse")
	}
	prompt := h.gw.bodyAt(0)["messages"].([]any)[0].(map[string]any)["content"].(string)
	contains(t, prompt, "main.go")
	h.send("/init")
	contains(t, h.view(), "Ya existe LIXBON.md")
}

func TestDiffAndCommitNeedGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git no disponible")
	}
	h := newHarness(t, nil, jsonReply(`{"choices":[{"message":{"content":"feat: añade a.txt"}}]}`))
	h.send("/diff")
	h.settle()
	contains(t, h.out(), "no es un repositorio git")

	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = h.chat.Workspace
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	run("config", "user.email", "t@t.t")
	run("config", "user.name", "t")
	h.send("/diff")
	h.settle()
	contains(t, h.out(), "El workspace está limpio")

	os.WriteFile(filepath.Join(h.chat.Workspace, "a.txt"), []byte("hola\n"), 0o644)
	h.send("/diff")
	h.settle()
	contains(t, h.out(), "cambios sin confirmar")
	contains(t, h.out(), "a.txt")

	h.send("/commit")
	h.pump(func() bool { return h.m.picker != nil })
	contains(t, h.view(), "¿Crear el commit con este mensaje?")
	h.key("enter")
	h.settle()
	contains(t, h.out(), "añade a.txt")
	cmd := exec.Command("git", "log", "--oneline")
	cmd.Dir = h.chat.Workspace
	if out, _ := cmd.CombinedOutput(); !strings.Contains(string(out), "feat: añade a.txt") {
		t.Fatalf("git log: %s", out)
	}
	h.send("/commit otro")
	h.settle()
	contains(t, h.out(), "No hay cambios que confirmar.")
}

func TestUnavailableCommandsSayso(t *testing.T) {
	h := newHarness(t, nil)
	for _, name := range []string{"mcp", "remote", "update", "visual", "image", "paste"} {
		h.send("/" + name)
		contains(t, h.out(), "«/"+name+"» aún no está disponible en el CLI Go.")
	}
}

func TestExitQuits(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/exit")
	h.pump(h.quitRequested)
	contains(t, h.out(), "Hasta pronto.")
}
