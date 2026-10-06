package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// scriptedGateway responde a cada POST de chat con la siguiente función y
// guarda los cuerpos recibidos.
type scriptedGateway struct {
	mu     sync.Mutex
	bodies []map[string]any
	steps  []func(w http.ResponseWriter)
}

func (s *scriptedGateway) handler(w http.ResponseWriter, r *http.Request, body map[string]any) {
	s.mu.Lock()
	n := len(s.bodies)
	s.bodies = append(s.bodies, body)
	s.mu.Unlock()
	if n >= len(s.steps) {
		sseHandler(delta("(sin más pasos)"))(w, r)
		return
	}
	s.steps[n](w)
}

func replyText(text string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+delta(text)+"\n\ndata: [DONE]\n\n")
	}
}

func replyToolCall(id, name string, args map[string]any) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{
			"tool_calls": []any{map[string]any{"id": id, "function": map[string]any{"name": name, "arguments": args}}},
		}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+string(chunk)+"\n\ndata: [DONE]\n\n")
	}
}

func replyError(status int, detail string) func(http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.WriteHeader(status)
		io.WriteString(w, `{"detail":"`+detail+`"}`)
	}
}

func agentHarness(t *testing.T, cfg map[string]any, steps ...func(http.ResponseWriter)) (*harness, *scriptedGateway, string) {
	t.Helper()
	g := newFakeGateway(t)
	script := &scriptedGateway{steps: steps}
	g.chat = func(w http.ResponseWriter, r *http.Request) { script.handler(w, r, g.chatBody) }
	base := map[string]any{"api_key": "k", "model": "qwen", "mode": "agent"}
	for k, v := range cfg {
		base[k] = v
	}
	h := newHarness(t, g, base)
	// El workspace es siempre la carpeta desde la que se lanza el CLI.
	workspace := t.TempDir()
	t.Chdir(workspace)
	real, _ := filepath.EvalSymlinks(workspace)
	return h, script, real
}

func bodyMessages(body map[string]any) []map[string]any {
	var out []map[string]any
	for _, m := range body["messages"].([]any) {
		out = append(out, m.(map[string]any))
	}
	return out
}

func TestAgentOnceWritesFilesAndAnswers(t *testing.T) {
	h, script, ws := agentHarness(t, nil,
		replyToolCall("c1", "write_file", map[string]any{"path": "hola.txt", "content": "hola\n"}),
		replyText("Creé hola.txt."))
	if code := h.run("chat", "--once", "crea hola.txt"); code != 0 {
		t.Fatalf("code %d: %s", code, h.errOut)
	}
	if got, _ := os.ReadFile(filepath.Join(ws, "hola.txt")); string(got) != "hola\n" {
		t.Fatalf("archivo: %q", got)
	}
	if h.out.String() != "Creé hola.txt.\n" {
		t.Fatalf("stdout %q", h.out)
	}
	for _, want := range []string{"▸ write_file hola.txt (5 chars)  +1 -0", "✓ 5 chars", "1 acción(es), 1 archivo(s) tocado(s) +1 -0"} {
		if !strings.Contains(h.errOut.String(), want) {
			t.Errorf("falta %q en stderr:\n%s", want, h.errOut)
		}
	}
	first := script.bodies[0]
	if tools, _ := first["tools"].([]any); len(tools) != 20 || first["think"] != "high" || first["stream"] != true {
		t.Fatalf("primera petición: tools=%d think=%v", len(tools), first["think"])
	}
	msgs := bodyMessages(first)
	if msgs[0]["role"] != "system" || !strings.Contains(msgs[0]["content"].(string), "Workspace: "+ws) {
		t.Fatalf("system prompt: %.120v", msgs[0]["content"])
	}
	second := bodyMessages(script.bodies[1])
	last := second[len(second)-1]
	if last["role"] != "tool" || last["tool_call_id"] != "c1" || last["name"] != "write_file" {
		t.Fatalf("resultado de herramienta enviado al modelo: %v", last)
	}
	if assistant := second[len(second)-2]; assistant["role"] != "assistant" || assistant["tool_calls"] == nil {
		t.Fatalf("el assistant debe conservar sus tool_calls: %v", assistant)
	}
}

func TestAgentOnceDeniesEditsWithoutAutoApprove(t *testing.T) {
	h, script, ws := agentHarness(t, map[string]any{"auto_approve_tools": false},
		replyToolCall("c1", "write_file", map[string]any{"path": "a.txt", "content": "x"}),
		replyText("No pude."))
	if code := h.run("chat", "--once", "crea a.txt"); code != 0 {
		t.Fatalf("code %d", code)
	}
	if _, err := os.Stat(filepath.Join(ws, "a.txt")); err == nil {
		t.Fatal("se escribió sin aprobación")
	}
	if !strings.Contains(h.errOut.String(), "cambio sin aprobar") {
		t.Fatalf("stderr: %s", h.errOut)
	}
	second := bodyMessages(script.bodies[1])
	if last := second[len(second)-1]; last["content"] != "Ejecución cancelada por el usuario" {
		t.Fatalf("resultado: %v", last["content"])
	}
}

func TestAgentOnceCommandsNeedAutoRun(t *testing.T) {
	h, script, _ := agentHarness(t, nil,
		replyToolCall("c1", "run_command", map[string]any{"command": "echo hola"}),
		replyText("ok"))
	h.run("chat", "--once", "corre")
	if second := bodyMessages(script.bodies[1]); second[len(second)-1]["content"] != "Ejecución cancelada por el usuario" {
		t.Fatalf("sin --auto-run el comando no debe ejecutarse: %v", second[len(second)-1]["content"])
	}
	if !strings.Contains(h.errOut.String(), "--auto-run") {
		t.Fatalf("stderr debe explicar cómo permitirlo: %s", h.errOut)
	}

	h, script, _ = agentHarness(t, nil,
		replyToolCall("c1", "run_command", map[string]any{"command": "echo hola"}),
		replyText("ok"))
	h.run("chat", "--once", "corre", "--auto-run")
	if second := bodyMessages(script.bodies[1]); second[len(second)-1]["content"] != "[EXIT 0] hola" {
		t.Fatalf("con --auto-run: %v", second[len(second)-1]["content"])
	}
}

func TestAgentOnceAllowedCommandsFromConfig(t *testing.T) {
	h, script, _ := agentHarness(t, map[string]any{"allowed_commands": []string{"echo hola"}},
		replyToolCall("c1", "run_command", map[string]any{"command": "echo hola mundo"}),
		replyText("ok"))
	h.run("chat", "--once", "corre")
	if second := bodyMessages(script.bodies[1]); !strings.HasPrefix(second[len(second)-1]["content"].(string), "[EXIT 0] hola mundo") {
		t.Fatalf("allowed_commands no se aplicó: %v", second[len(second)-1]["content"])
	}
}

func TestAgentOnceFallsBackWhenModelRejectsTools(t *testing.T) {
	h, script, _ := agentHarness(t, nil,
		replyError(400, "registry.ollama.ai/x does not support tools"),
		replyText("Respuesta en texto."))
	if code := h.run("chat", "--once", "hola"); code != 0 {
		t.Fatalf("code %d: %s", code, h.errOut)
	}
	if h.out.String() != "Respuesta en texto.\n" {
		t.Fatalf("stdout %q", h.out)
	}
	if _, has := script.bodies[1]["tools"]; has {
		t.Fatal("el reintento no debe enviar herramientas")
	}
	if !strings.Contains(h.errOut.String(), "no soporta herramientas nativas") {
		t.Fatalf("stderr: %s", h.errOut)
	}
}

func TestAgentOnceReportsGatewayErrors(t *testing.T) {
	h, _, _ := agentHarness(t, nil, replyError(402, "Sin créditos"))
	if code := h.run("chat", "--once", "hola"); code != 1 || !strings.Contains(h.errOut.String(), "Sin créditos disponibles: Sin créditos") {
		t.Fatalf("code=%d stderr=%q", code, h.errOut)
	}
}

func TestAgentOnceTextProtocolAndNativeToolsOff(t *testing.T) {
	h, script, ws := agentHarness(t, map[string]any{"native_tools": false},
		replyText(`{"tool":"write_file","args":{"path":"t.txt","content":"x"}}`),
		replyText("Hecho."))
	h.run("chat", "--once", "crea t.txt")
	if _, has := script.bodies[0]["tools"]; has {
		t.Fatal("con native_tools=false no se envían herramientas")
	}
	if got, _ := os.ReadFile(filepath.Join(ws, "t.txt")); string(got) != "x" {
		t.Fatalf("archivo: %q", got)
	}
	system := bodyMessages(script.bodies[0])[0]["content"].(string)
	if !strings.Contains(system, "=== HERRAMIENTAS DISPONIBLES ===") {
		t.Fatal("falta el prompt del protocolo de texto")
	}
}

func TestDelegateModeUsesTheRouter(t *testing.T) {
	g := newFakeGateway(t)
	g.srv.Config.Handler.(*http.ServeMux).HandleFunc("/api/delegate", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		if body["user_input"] != "haz algo" {
			http.Error(w, "mal", 400)
			return
		}
		io.WriteString(w, `{"response":"Hecho por el router","routing":{"model":"qwen","type":"PLAN"},
			"classification":{"intent":"code","complexity":"low","domain":"web","riskLevel":"safe"},"execution_time_ms":42}`)
	})
	h := newHarness(t, g, map[string]any{"api_key": "k", "model": "qwen", "mode": "delegate"})
	if code := h.run("chat", "--once", "haz algo"); code != 0 {
		t.Fatalf("code %d: %s", code, h.errOut)
	}
	if h.out.String() != "Hecho por el router\n" {
		t.Fatalf("stdout %q", h.out)
	}
	for _, want := range []string{"delegó a qwen [PLAN] · 42 ms", "intent:code  complejidad:low  dominio:web  riesgo:safe"} {
		if !strings.Contains(h.errOut.String(), want) {
			t.Errorf("falta %q en:\n%s", want, h.errOut)
		}
	}
}
