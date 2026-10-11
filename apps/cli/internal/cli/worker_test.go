package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type reportCall struct {
	lxo, stdin string
	args       []string
}

type workerEnv struct {
	*harness
	script *scriptedGateway
	ws     string
	lxo    string
	calls  *[]reportCall
	report string
}

func workerHarness(t *testing.T, steps ...func(http.ResponseWriter)) *workerEnv {
	t.Helper()
	h, script, ws := agentHarness(t, map[string]any{"mode": "ask", "auto_approve_tools": false}, steps...)
	lxo := filepath.Join(t.TempDir(), "lxo.exe")
	if err := os.WriteFile(lxo, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	report := filepath.Join(t.TempDir(), "report.json")
	t.Setenv("LXO_TASK_ID", "t7")
	t.Setenv("LXO_BIN", lxo)
	t.Setenv("LXO_REPORT_PATH", report)

	var calls []reportCall
	previous := lxoReport
	lxoReport = func(_ context.Context, lxo, stdin string, args ...string) (string, error) {
		calls = append(calls, reportCall{lxo: lxo, stdin: stdin, args: args})
		return "Informe escrito en " + report, nil
	}
	t.Cleanup(func() { lxoReport = previous })
	return &workerEnv{harness: h, script: script, ws: ws, lxo: lxo, calls: &calls, report: report}
}

func (w *workerEnv) arg(name string) string {
	call := (*w.calls)[0]
	i := slices.Index(call.args, name)
	if i < 0 || i+1 >= len(call.args) {
		return ""
	}
	return call.args[i+1]
}

func TestWorkerDelegarEditsAndDeliversTheFinalAnswerAsTheReport(t *testing.T) {
	w := workerHarness(t,
		replyToolCall("c1", "write_file", map[string]any{"path": "hola.txt", "content": "hola\n"}),
		replyText("## Hecho\nCreé hola.txt con el saludo."))
	if code := w.run("worker", "--profile", "delegar_con_revision", "crea hola.txt"); code != 0 {
		t.Fatalf("code %d: %s", code, w.errOut)
	}
	if got, _ := os.ReadFile(filepath.Join(w.ws, "hola.txt")); string(got) != "hola\n" {
		t.Fatalf("el perfil delegar debe poder editar: %q", got)
	}
	if len(*w.calls) != 1 {
		t.Fatalf("debe entregar un solo informe: %d", len(*w.calls))
	}
	call := (*w.calls)[0]
	if call.lxo != w.lxo || call.args[0] != "report" || w.arg("--report") != "-" {
		t.Fatalf("llamada a lxo: %+v", call)
	}
	if w.arg("--summary") != "Hecho" || !strings.Contains(call.stdin, "Creé hola.txt") {
		t.Fatalf("resumen=%q informe=%q", w.arg("--summary"), call.stdin)
	}
	if !strings.Contains(w.arg("--files"), "hola.txt") || slices.Contains(call.args, "--failed") {
		t.Fatalf("archivos y estado: %v", call.args)
	}
	first := bodyMessages(w.script.bodies[0])
	user := first[len(first)-1]["content"].(string)
	for _, want := range []string{"tarea t7", "NO ejecutes lxo report", "crea hola.txt", `" phase "`} {
		if !strings.Contains(user, want) {
			t.Errorf("falta %q en el encargo:\n%s", want, user)
		}
	}
	if strings.Contains(first[0]["content"].(string), "Orquestador de agentes") {
		t.Error("el worker no debe recibir las instrucciones de coordinador")
	}
}

func TestWorkerReadOnlyProfilesCannotEditButStillReport(t *testing.T) {
	for _, profile := range []string{"explorar", "proponer"} {
		w := workerHarness(t,
			replyToolCall("c1", "write_file", map[string]any{"path": "intruso.txt", "content": "x"}),
			replyText("Revisé el módulo: sin hallazgos graves."))
		if code := w.run("worker", "--profile", profile, "revisa el módulo"); code != 0 {
			t.Fatalf("%s: code %d: %s", profile, code, w.errOut)
		}
		if _, err := os.Stat(filepath.Join(w.ws, "intruso.txt")); err == nil {
			t.Fatalf("%s: un perfil de solo lectura no puede escribir", profile)
		}
		if len(*w.calls) != 1 || !strings.Contains((*w.calls)[0].stdin, "sin hallazgos graves") {
			t.Fatalf("%s: debe entregar el informe: %+v", profile, *w.calls)
		}
		if !strings.Contains(bodyMessages(w.script.bodies[0])[0]["content"].(string), "MODO PLAN") {
			t.Fatalf("%s: debe correr en modo plan", profile)
		}
	}
}

func TestWorkerRunsLxoWithoutAskingButOtherCommandsAreRefused(t *testing.T) {
	w := workerHarness(t,
		func(w http.ResponseWriter) {
			command := `"` + os.Getenv("LXO_BIN") + `" phase "leyendo"`
			replyToolCall("c1", "run_command", map[string]any{"command": command})(w)
		},
		replyToolCall("c2", "run_command", map[string]any{"command": "echo hola"}),
		replyText("Hecho."))
	if code := w.run("worker", "--profile", "delegar_con_revision", "avanza"); code != 0 {
		t.Fatalf("code %d: %s", code, w.errOut)
	}
	stderr := w.errOut.String()
	if strings.Count(stderr, "comando sin aprobar") != 1 || !strings.Contains(stderr, "comando sin aprobar: echo hola") {
		t.Fatalf("solo echo debe rechazarse (no hay nadie al teclado):\n%s", stderr)
	}
}

func TestWorkerNeverTouchesTheUsersConfig(t *testing.T) {
	w := workerHarness(t, replyText("Listo."))
	var saved map[string]any
	raw, _ := os.ReadFile(w.path)
	_ = json.Unmarshal(raw, &saved)
	saved["profiles"] = map[string]any{
		"otro": map[string]any{"base_url": saved["base_url"], "api_key": "k2", "model": "m2", "generic": true, "context_window": 8192},
	}
	raw, _ = json.Marshal(saved)
	if err := os.WriteFile(w.path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(w.path)

	if code := w.run("worker", "--profile", "delegar_con_revision", "--provider", "otro", "--model", "modelo-del-rol", "haz algo"); code != 0 {
		t.Fatalf("code %d: %s", code, w.errOut)
	}
	if after, _ := os.ReadFile(w.path); string(after) != string(before) {
		t.Fatalf("el worker cambió config.json:\nantes:   %s\ndespués: %s", before, after)
	}
	if entries, _ := os.ReadDir(filepath.Dir(w.path)); len(entries) != 1 {
		t.Fatalf("no debe guardar conversaciones: %v", entries)
	}
	if w.script.bodies[0]["model"] != "modelo-del-rol" {
		t.Fatalf("modelo pedido: %v", w.script.bodies[0]["model"])
	}
}

func TestWorkerUsesTheRequestedProviderProfile(t *testing.T) {
	w := workerHarness(t, replyText("Listo."))
	if code := w.run("worker", "--profile", "explorar", "--provider", "no-existe", "x"); code != 2 {
		t.Fatalf("un proveedor inexistente es un error de uso: %d", code)
	}
	if !strings.Contains(w.errOut.String(), "no-existe") || len(w.script.bodies) != 0 || len(*w.calls) != 0 {
		t.Fatalf("stderr=%s peticiones=%d informes=%d", w.errOut, len(w.script.bodies), len(*w.calls))
	}
}

func TestWorkerReportsAModelFailureAsAFailedReport(t *testing.T) {
	w := workerHarness(t, replyError(500, "el nodo se cayó"))
	if code := w.run("worker", "--profile", "delegar_con_revision", "haz algo"); code != 1 {
		t.Fatalf("code %d", code)
	}
	if len(*w.calls) != 1 || !slices.Contains((*w.calls)[0].args, "--failed") || !strings.Contains(w.arg("--summary"), "El modelo falló") {
		t.Fatalf("debe avisar del fallo al coordinador: %+v", *w.calls)
	}
}

func TestWorkerDoesNotReportTwiceWhenTheModelAlreadyDelivered(t *testing.T) {
	w := workerHarness(t, replyText("Todo listo."))
	if err := os.WriteFile(w.report, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := w.run("worker", "--profile", "delegar_con_revision", "haz algo"); code != 0 {
		t.Fatalf("code %d: %s", code, w.errOut)
	}
	if len(*w.calls) != 0 || !strings.Contains(w.errOut.String(), "ya estaba entregado") {
		t.Fatalf("informes=%d stderr=%s", len(*w.calls), w.errOut)
	}
}

func TestWorkerFailsWhenLxoCannotDeliver(t *testing.T) {
	w := workerHarness(t, replyText("Todo listo."))
	lxoReport = func(context.Context, string, string, ...string) (string, error) {
		return "Lixbon no está abierto", os.ErrNotExist
	}
	if code := w.run("worker", "--profile", "delegar_con_revision", "haz algo"); code != 1 {
		t.Fatalf("sin entrega el worker debe terminar con error: %d", code)
	}
	if !strings.Contains(w.errOut.String(), "lxo report falló: Lixbon no está abierto") {
		t.Fatalf("stderr: %s", w.errOut)
	}
}

func TestWorkerRejectsBadUsageWithoutCallingTheModel(t *testing.T) {
	cases := map[string][]string{
		"sin perfil":         {"worker", "haz algo"},
		"perfil inventado":   {"worker", "--profile", "root", "haz algo"},
		"autonomía aplazada": {"worker", "--profile", "autonomia_amplia", "haz algo"},
		"sin encargo":        {"worker", "--profile", "explorar"},
	}
	for name, args := range cases {
		w := workerHarness(t, replyText("no debería llamarse"))
		if code := w.run(args...); code != 2 {
			t.Errorf("%s: code %d", name, code)
		}
		if len(w.script.bodies) != 0 || len(*w.calls) != 0 {
			t.Errorf("%s: no debe llamar al modelo ni entregar", name)
		}
	}

	w := workerHarness(t, replyText("no debería llamarse"))
	t.Setenv("LXO_TASK_ID", "")
	if code := w.run("worker", "--profile", "explorar", "haz algo"); code != 2 || !strings.Contains(w.errOut.String(), "LXO_TASK_ID") {
		t.Errorf("fuera de una tarea: code %d: %s", code, w.errOut)
	}
}

func TestSummaryAndClipHelpers(t *testing.T) {
	if got := summaryOf("\n## Resultado final\nmás detalle"); got != "Resultado final" {
		t.Errorf("resumen: %q", got)
	}
	if got := summaryOf("  \n"); got != "Tarea terminada." {
		t.Errorf("vacío: %q", got)
	}
	if got := summaryOf(strings.Repeat("ñ", 900)); len([]rune(got)) != maxSummaryRunes {
		t.Errorf("el resumen debe caber en %d caracteres: %d", maxSummaryRunes, len([]rune(got)))
	}
	long := strings.Repeat("é", maxReportBytes)
	clipped := clip(long, maxReportBytes)
	if len(clipped) > maxReportBytes+64 || !strings.HasSuffix(clipped, "(informe recortado)") {
		t.Errorf("recorte: %d bytes", len(clipped))
	}
	if strings.ContainsRune(clipped, '�') {
		t.Error("el recorte no debe partir un carácter")
	}
}

func TestProfileListJSONNeverIncludesKeys(t *testing.T) {
	h := newHarness(t, nil, map[string]any{
		"base_url": "https://lixbon.com/v1", "api_key": "lixbon_sk_secreta", "model": "qwen",
		"profile":  "lixbon",
		"profiles": map[string]any{"ollama": map[string]any{"base_url": "http://localhost:11434/v1", "api_key": "clave-privada", "model": "qwen3:8b", "generic": true}},
	})
	if code := h.run("profile", "list", "--json"); code != 0 {
		t.Fatalf("code %d: %s", code, h.errOut)
	}
	out := h.out.String()
	if strings.Contains(out, "secreta") || strings.Contains(out, "privada") {
		t.Fatalf("filtra una clave: %s", out)
	}
	var list []profileInfo
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		t.Fatalf("no es JSON: %v\n%s", err, out)
	}
	byName := map[string]profileInfo{}
	for _, p := range list {
		byName[p.Name] = p
	}
	if p := byName["ollama"]; p.Model != "qwen3:8b" || p.Kind != "generic" || p.Active {
		t.Errorf("ollama: %+v", p)
	}
	if p := byName["lixbon"]; !p.Active || p.Kind != "gateway" {
		t.Errorf("lixbon: %+v", p)
	}
}

func TestWorkerHelpNamesTheFlagsTheHostLooksFor(t *testing.T) {
	h := newHarness(t, nil, nil)
	if code := h.run("worker", "--help"); code != 0 {
		t.Fatalf("code %d", code)
	}
	for _, want := range []string{"--profile", "--provider", "--model", "delegar_con_revision"} {
		if !strings.Contains(h.out.String(), want) {
			t.Errorf("falta %q en la ayuda:\n%s", want, h.out)
		}
	}
}
