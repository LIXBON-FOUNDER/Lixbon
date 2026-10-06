package tui

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSendingAMessageShowsItAndTheAnswer(t *testing.T) {
	h := newHarness(t, nil, textReply("Hola, soy **Lixbon**."))
	h.send("buenas")
	h.settle()
	out := h.out()
	contains(t, out, "buenas")
	contains(t, out, "Lixbon")
	contains(t, out, "Hola, soy")
	if h.gw.count() != 1 {
		t.Fatalf("peticiones: %d", h.gw.count())
	}
	if got := h.m.input.Value(); got != "" {
		t.Fatalf("la caja debe vaciarse: %q", got)
	}
	if len(h.chat.History) != 2 {
		t.Fatalf("historial: %d", len(h.chat.History))
	}
	contains(t, h.view(), "qwen")
	contains(t, h.view(), "ask")
}

func TestEmptyMessagesAreIgnored(t *testing.T) {
	h := newHarness(t, nil)
	h.send("   ")
	h.key("enter")
	if h.m.running || h.gw.count() != 0 {
		t.Fatal("no debe enviar nada")
	}
}

func TestMultilineInputWithAltEnter(t *testing.T) {
	h := newHarness(t, nil, textReply("ok"))
	h.typeText("línea uno")
	h.update(altEnter())
	h.typeText("línea dos")
	if got := h.m.input.Value(); got != "línea uno\nlínea dos" {
		t.Fatalf("valor: %q", got)
	}
	h.key("enter")
	h.settle()
	body := h.gw.bodyAt(0)["messages"].([]any)
	if last := body[len(body)-1].(map[string]any); last["content"] != "línea uno\nlínea dos" {
		t.Fatalf("mensaje enviado: %v", last)
	}
}

func TestPastedTextIsInsertedWithoutSending(t *testing.T) {
	h := newHarness(t, nil)
	h.update(pasteMsg("uno\r\ndos\r\n"))
	if got := h.m.input.Value(); got != "uno\ndos\n" || h.m.running {
		t.Fatalf("valor %q running=%v", got, h.m.running)
	}
}

func TestSlashMenuFiltersCompletesAndHides(t *testing.T) {
	h := newHarness(t, nil)
	h.typeText("/mo")
	view := h.view()
	contains(t, view, "/mode")
	contains(t, view, "/model")
	notContains(t, view, "/help")
	h.key("down")
	h.key("tab")
	if got := h.m.input.Value(); got != "/model " {
		t.Fatalf("tras completar: %q", got)
	}
	notContains(t, h.view(), "Cambiar modo de trabajo")

	h.m.input.Reset()
	h.m.refreshMenu()
	h.typeText("/he")
	contains(t, h.view(), "/help")
	h.key("esc")
	notContains(t, h.view(), "Ver todos los comandos")
}

func TestEnterOnAPartialCommandRunsTheSelectedOne(t *testing.T) {
	h := newHarness(t, nil)
	h.typeText("/cos")
	h.key("enter")
	contains(t, h.out(), "Tokens de la sesión")
}

func TestUnknownCommandIsReported(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/inventado")
	contains(t, h.out(), "Comando desconocido: /inventado")
	if h.m.running {
		t.Fatal("un comando desconocido no abre un turno")
	}
}

func TestCustomCommandsRunAsPrompts(t *testing.T) {
	h := newHarness(t, nil, textReply("revisado"))
	dir := filepath.Join(h.root, ".lixbon", "commands")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "review.md"), []byte("# Revisar\nRevisa $ARGUMENTS con cuidado."), 0o644)
	h.chat.LoadCustomCommands(reservedNames())
	h.typeText("/rev")
	contains(t, h.view(), "Revisar")
	h.m.input.Reset()
	h.send("/review el diff")
	h.settle()
	body := h.gw.bodyAt(0)["messages"].([]any)
	if last := body[len(body)-1].(map[string]any); last["content"] != "Revisa el diff con cuidado." {
		t.Fatalf("prompt enviado: %v", last["content"])
	}
}

func TestMessagesTypedDuringATurnAreQueued(t *testing.T) {
	h := newHarness(t, nil, slowReply("primera", 400*time.Millisecond), textReply("segunda"))
	h.send("uno")
	if !h.m.running {
		t.Fatal("debería estar trabajando")
	}
	h.send("dos")
	h.send("tres")
	contains(t, h.view(), "2 en cola")
	if h.gw.count() > 1 {
		t.Fatalf("no debe enviar en paralelo: %d", h.gw.count())
	}
	h.pump(func() bool { return h.gw.count() >= 3 && !h.m.running && len(h.m.queue) == 0 })
	if h.gw.count() != 3 {
		t.Fatalf("peticiones: %d", h.gw.count())
	}
	got := h.chat.History
	if got[0].Content != "uno" || got[2].Content != "dos" || got[4].Content != "tres" {
		t.Fatalf("orden del historial: %+v", got)
	}
}

func TestEscInterruptsTheTurnAndKeepsContext(t *testing.T) {
	h := newHarness(t, nil, slowReply("tarde", 5*time.Second))
	h.send("hola")
	h.key("esc")
	contains(t, h.view(), "interrumpiendo")
	h.settle()
	contains(t, h.out(), "interrumpido")
	contains(t, h.out(), "el contexto se conserva")
	if h.m.running {
		t.Fatal("el turno debe haber terminado")
	}
}

func TestCtrlCBehaviour(t *testing.T) {
	h := newHarness(t, nil, slowReply("tarde", 5*time.Second))
	h.typeText("borrador")
	h.key("ctrl+c")
	if h.m.input.Value() != "" {
		t.Fatal("Ctrl+C borra lo escrito")
	}
	h.key("ctrl+c")
	contains(t, h.view(), "Pulsa Ctrl+C otra vez para salir")
	if h.quitRequested() {
		t.Fatal("no debe salir a la primera")
	}
	h.key("ctrl+c")
	h.pump(h.quitRequested)

	h2 := newHarness(t, nil, slowReply("tarde", 5*time.Second))
	h2.send("hola")
	h2.key("ctrl+c")
	h2.settle()
	if h2.quitRequested() {
		t.Fatal("Ctrl+C durante un turno solo interrumpe")
	}
}

func TestCtrlDQuitsOnlyWithAnEmptyBox(t *testing.T) {
	h := newHarness(t, nil)
	h.typeText("algo")
	h.key("ctrl+d")
	if h.quitRequested() {
		t.Fatal("con texto no sale")
	}
	h.m.input.Reset()
	h.key("ctrl+d")
	h.pump(h.quitRequested)
}

func TestInputHistoryNavigation(t *testing.T) {
	h := newHarness(t, nil, textReply("a"), textReply("b"))
	h.send("primero")
	h.settle()
	h.send("segundo")
	h.settle()
	h.typeText("borrador")
	h.key("up")
	if got := h.m.input.Value(); got != "segundo" {
		t.Fatalf("up: %q", got)
	}
	h.key("up")
	if got := h.m.input.Value(); got != "primero" {
		t.Fatalf("up 2: %q", got)
	}
	h.key("down")
	h.key("down")
	if got := h.m.input.Value(); got != "borrador" {
		t.Fatalf("el borrador debe volver: %q", got)
	}
	data, _ := os.ReadFile(h.m.opts.HistoryFile)
	contains(t, string(data), "+primero")
	contains(t, string(data), "+segundo")
}

func TestShiftTabCyclesModes(t *testing.T) {
	h := newHarness(t, nil)
	if h.m.modeName() != "ask" {
		t.Fatal("empieza en ask")
	}
	h.key("shift+tab")
	if h.m.modeName() != "agent" {
		t.Fatalf("modo: %s", h.m.modeName())
	}
	h.key("shift+tab")
	if h.m.modeName() != "plan" || !h.chat.Session.PlanMode {
		t.Fatalf("modo: %s", h.m.modeName())
	}
	h.key("shift+tab")
	if h.m.modeName() != "ask" || h.chat.Session.PlanMode {
		t.Fatalf("modo: %s", h.m.modeName())
	}
	if h.chat.Cfg.Mode != "ask" {
		t.Fatal("el modo se guarda en la config")
	}
}

// ── agente ──────────────────────────────────────────────────────────────

func agentHarness(t *testing.T, autoApprove bool, steps ...func(http.ResponseWriter, *http.Request)) *harness {
	return newHarness(t, func(c *configT) { c.Mode, c.AutoApproveTools = "agent", autoApprove }, steps...)
}

func TestAgentTurnShowsActionsDiffAndSummary(t *testing.T) {
	h := agentHarness(t, true,
		toolReply("c1", "write_file", map[string]any{"path": "hola.txt", "content": "uno\ndos\n"}),
		textReply("Listo, creé el archivo."))
	h.send("crea hola.txt")
	h.settle()
	out := h.out()
	contains(t, out, "creó")
	contains(t, out, "hola.txt")
	contains(t, out, "+2 -0")
	contains(t, out, "uno")
	contains(t, out, "8 chars")
	contains(t, out, "Listo, creé el archivo.")
	contains(t, out, "1 acción")
	if data, _ := os.ReadFile(filepath.Join(h.root, "hola.txt")); string(data) != "uno\ndos\n" {
		t.Fatalf("archivo: %q", data)
	}
}

func TestApprovalPickerAppliesOrRejects(t *testing.T) {
	h := agentHarness(t, false,
		toolReply("c1", "write_file", map[string]any{"path": "a.txt", "content": "x"}),
		textReply("hecho"))
	h.send("crea a.txt")
	h.pump(func() bool { return h.m.picker != nil })
	view := h.view()
	contains(t, view, "¿Aplicar este cambio?")
	contains(t, view, "Sí, y no preguntar más")
	notContains(t, view, "pregunta lo que quieras") // el selector sustituye a la caja
	h.key("enter")
	h.settle()
	if data, _ := os.ReadFile(filepath.Join(h.root, "a.txt")); string(data) != "x" {
		t.Fatalf("aprobado: %q", data)
	}

	h2 := agentHarness(t, false,
		toolReply("c1", "write_file", map[string]any{"path": "b.txt", "content": "y"}),
		textReply("vale"))
	h2.send("crea b.txt")
	h2.pump(func() bool { return h2.m.picker != nil })
	h2.key("esc")
	h2.settle()
	if _, err := os.Stat(filepath.Join(h2.root, "b.txt")); err == nil {
		t.Fatal("Esc debe rechazar el cambio")
	}
	contains(t, h2.out(), "rechazado por el usuario")
}

func TestApprovalAlwaysStopsAsking(t *testing.T) {
	h := agentHarness(t, false,
		toolReply("c1", "write_file", map[string]any{"path": "a.txt", "content": "1"}),
		toolReply("c2", "write_file", map[string]any{"path": "b.txt", "content": "2"}),
		textReply("hecho"))
	h.send("crea dos")
	h.pump(func() bool { return h.m.picker != nil })
	h.key("down")
	h.key("enter")
	h.settle()
	if !h.chat.Session.AutoApprove {
		t.Fatal("«no preguntar más» activa auto_approve")
	}
	for _, f := range []string{"a.txt", "b.txt"} {
		if _, err := os.Stat(filepath.Join(h.root, f)); err != nil {
			t.Fatalf("falta %s", f)
		}
	}
}

func TestCommandApprovalOffersThePrefix(t *testing.T) {
	h := agentHarness(t, true,
		toolReply("c1", "run_command", map[string]any{"command": "echo hola"}),
		textReply("ok"))
	h.send("corre echo")
	h.pump(func() bool { return h.m.picker != nil })
	contains(t, h.view(), "¿Ejecutar este comando?")
	contains(t, h.view(), "Sí, y siempre para «echo hola»")
	h.key("down")
	h.key("enter")
	h.settle()
	if got := h.chat.Session.AllowedCommands; len(got) != 1 || got[0] != "echo hola" {
		t.Fatalf("prefijo guardado: %v", got)
	}
	contains(t, h.out(), "exit 0")
}

func TestAskUserOptionsAndFreeText(t *testing.T) {
	h := agentHarness(t, true,
		toolReply("c1", "ask_user", map[string]any{"question": "¿SQLite o Postgres?", "options": []any{"SQLite", "Postgres"}}),
		textReply("elegido"))
	h.send("monta la base")
	h.pump(func() bool { return h.m.picker != nil })
	contains(t, h.view(), "¿SQLite o Postgres?")
	contains(t, h.view(), "Otra respuesta…")
	h.key("down")
	h.key("enter")
	h.settle()
	second := h.gw.bodyAt(1)["messages"].([]any)
	last := second[len(second)-1].(map[string]any)
	if last["content"] != "Respuesta del usuario: Postgres" {
		t.Fatalf("respuesta: %v", last["content"])
	}

	h2 := agentHarness(t, true,
		toolReply("c1", "ask_user", map[string]any{"question": "¿Qué nombre?"}),
		textReply("gracias"))
	h2.send("crea el proyecto")
	h2.pump(func() bool { return h2.m.prompt != nil })
	h2.send("miapp")
	h2.settle()
	second = h2.gw.bodyAt(1)["messages"].([]any)
	if last := second[len(second)-1].(map[string]any); last["content"] != "Respuesta del usuario: miapp" {
		t.Fatalf("respuesta libre: %v", last["content"])
	}
}

func TestTodoToolPrintsTheList(t *testing.T) {
	h := agentHarness(t, true,
		toolReply("c1", "todo", map[string]any{"items": []any{
			map[string]any{"text": "leer", "status": "done"}, map[string]any{"text": "editar", "status": "doing"}}}),
		textReply("hecho"))
	h.send("planifica")
	h.settle()
	contains(t, h.out(), "2 pasos")
	contains(t, h.out(), "leer")
	contains(t, h.out(), "editar")
	h.send("/todo")
	h.settle()
	if strings.Count(h.out(), "editar") < 2 {
		t.Fatal("/todo debe volver a mostrar la lista")
	}
}
