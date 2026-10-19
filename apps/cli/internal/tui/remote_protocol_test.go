package tui

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/history"
)

func agentRemote(t *testing.T, steps ...func(http.ResponseWriter, *http.Request)) (*harness, *fakeRelay) {
	t.Helper()
	h, relay := remoteHarness(t, func(c *config.Config) { c.AutoApproveTools = true; c.Mode = "agent" }, steps...)
	h.chat.Session.AutoRunCommands = true
	startRemote(t, h, relay)
	return h, relay
}

func TestRemoteSendsWhatTheModelThoughtAndHowLong(t *testing.T) {
	h, relay := remoteHarness(t, nil, reasoningReply("miro la carpeta", "Hay dos archivos."))
	startRemote(t, h, relay)
	relay.push(prompt("¿qué hay?"))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })

	if d := relay.find("reasoning_delta"); d == nil || !strings.Contains(d["text"].(string), "miro") {
		t.Fatalf("el razonamiento llega mientras se escribe: %v", d)
	}
	thought := relay.find("reasoning")
	if thought == nil || thought["text"] != "miro la carpeta" || thought["ms"] == nil {
		t.Fatalf("reasoning: %v", thought)
	}
	if done := relay.find("assistant_done"); done["ms"] == nil {
		t.Fatalf("el turno dice cuánto duró: %v", done)
	}
	ctx := relay.last("context")
	if ctx == nil || ctx["window"] == nil || ctx["auto"] != float64(70) {
		t.Fatalf("context: %v", ctx)
	}
	relay.push(`{"type":"request_snapshot"}`)
	h.waitFor("snapshot con lo pensado", func() bool {
		messages, _ := relay.last("snapshot")["messages"].([]any)
		for _, msg := range messages {
			if m := msg.(map[string]any); m["role"] == "thinking" && m["content"] == "miro la carpeta" {
				return true
			}
		}
		return false
	})
	h.m.remote.link.Stop(true)
}

func TestRemoteCommandStreamsItsOutputAndExitCode(t *testing.T) {
	h, relay := agentRemote(t,
		toolReply("t1", "run_command", map[string]any{"command": "echo uno && echo dos"}),
		textReply("listo"))
	relay.push(prompt("ejecuta algo"))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })

	var output strings.Builder
	for _, e := range relay.all("tool_output") {
		output.WriteString(e["text"].(string))
	}
	if !strings.Contains(output.String(), "uno") || !strings.Contains(output.String(), "dos") {
		t.Fatalf("salida en vivo: %q", output.String())
	}
	var result map[string]any
	for _, e := range relay.all("tool_result") {
		if e["tool"] == "run_command" {
			result = e
		}
	}
	if result == nil || result["exit"] != float64(0) || result["ms"] == nil || strings.HasPrefix(result["result"].(string), "[EXIT") {
		t.Fatalf("tool_result: %v", result)
	}
	if relay.find("tool_output")["id"] != result["id"] {
		t.Fatalf("la salida va con el id de su herramienta: %v / %v", relay.find("tool_output"), result)
	}
	h.m.remote.link.Stop(true)
}

func TestRemoteEditCarriesNumberedRowsWithoutTheWholeFile(t *testing.T) {
	var lines []string
	for i := 1; i <= 40; i++ {
		lines = append(lines, fmt.Sprintf("linea %d", i))
	}
	old := strings.Join(lines, "\n") + "\n"
	lines[4], lines[34] = "cambio arriba", "cambio abajo"
	h, relay := agentRemote(t,
		toolReply("t1", "write_file", map[string]any{"path": "a.txt", "content": strings.Join(lines, "\n") + "\n"}),
		textReply("hecho"))
	if err := os.WriteFile(filepath.Join(h.root, "a.txt"), []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	relay.push(prompt("cambia a.txt"))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })

	rows, _ := relay.find("tool_use")["rows"].([]any)
	got := map[string]bool{}
	for _, r := range rows {
		row := r.([]any)
		got[fmt.Sprint(row...)] = true
	}
	for _, want := range []string{"d5linea 5", "a5cambio arriba", "c4linea 4", "c6linea 6", "g27", "d35linea 35", "a35cambio abajo"} {
		if !got[want] {
			t.Errorf("falta la fila %q en %v", want, rows)
		}
	}
	if len(rows) > 12 {
		t.Fatalf("solo lo cambiado y una línea de contexto, no %d filas", len(rows))
	}
	h.m.remote.link.Stop(true)
}

func TestRemoteSearchListsWhatItFound(t *testing.T) {
	h, relay := agentRemote(t,
		toolReply("t1", "search", map[string]any{"pattern": "aguja"}),
		textReply("está en b.txt"))
	if err := os.WriteFile(filepath.Join(h.root, "b.txt"), []byte("paja\naguja\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	relay.push(prompt("busca aguja"))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })

	result := relay.find("tool_result")
	found, _ := result["lines"].([]any)
	if len(found) != 1 || !strings.Contains(found[0].(string), "b.txt") || result["meta"] != "1 coincidencia" {
		t.Fatalf("tool_result: %v", result)
	}
	h.m.remote.link.Stop(true)
}

func TestRemoteAgentQuestionIsAnsweredFromThePhone(t *testing.T) {
	h, relay := agentRemote(t,
		toolReply("t1", "ask_user", map[string]any{"question": "¿Hago commit?", "options": []any{"Solo commit", "No por ahora"}}),
		textReply("Vale, lo dejo así."))
	relay.push(prompt("termina"))
	h.waitFor("pregunta en el móvil", func() bool { return relay.find("choice_request") != nil })
	question := relay.find("choice_request")
	if question["kind"] != "question" || question["free"] != true || question["title"] != "¿Hago commit?" || len(question["options"].([]any)) != 2 {
		t.Fatalf("choice_request: %v", question)
	}
	h.waitFor("pregunta en la terminal", func() bool { return h.m.picker != nil })

	relay.push(fmt.Sprintf(`{"type":"approve","id":%q,"decision":"mejor mañana"}`, question["id"]))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })
	h.settle()

	if qa := relay.find("question_answered"); qa["question"] != "¿Hago commit?" || qa["answer"] != "mejor mañana" {
		t.Fatalf("question_answered: %v", qa)
	}
	if relay.find("choice_resolved")["id"] != question["id"] {
		t.Fatalf("la pregunta se retira del móvil: %v", relay.find("choice_resolved"))
	}
	if h.m.picker != nil || h.m.prompt != nil {
		t.Fatal("responder en el móvil cierra la pregunta de la terminal")
	}
	if body := fmt.Sprint(h.gw.bodyAt(1)["messages"]); !strings.Contains(body, "Respuesta del usuario: mejor mañana") {
		t.Fatalf("la respuesta llega al modelo: %s", body)
	}
	h.m.remote.link.Stop(true)
}

// La tanda llega entera al móvil y la app nueva la responde de una vez; las
// respuestas vuelven con su tanda para que la app las junte en una tarjeta.
func TestRemoteBatchIsAnsweredAtOnceFromThePhone(t *testing.T) {
	h, relay := agentRemote(t,
		toolReply("t1", "ask_user", map[string]any{"questions": []any{
			map[string]any{"header": "Estilo", "question": "¿Qué estilo?", "options": []any{
				map[string]any{"label": "Cálido", "description": "tonos tierra"}, "Sobrio"}},
			map[string]any{"header": "Secciones", "question": "¿Qué secciones?", "options": []any{"Carta", "Ubicación"}, "multiple": true},
			map[string]any{"header": "Idioma", "question": "¿En qué idioma?"},
		}}),
		textReply("Empiezo."))
	relay.push(prompt("monta la web"))
	h.waitFor("tanda en el móvil", func() bool { return relay.find("choice_request") != nil })
	request := relay.find("choice_request")
	batch, _ := request["batch"].([]any)
	if request["title"] != "¿Qué estilo?" || len(batch) != 3 {
		t.Fatalf("choice_request: %v", request)
	}
	second := batch[1].(map[string]any)
	if second["header"] != "Secciones" || second["multiple"] != true || len(second["options"].([]any)) != 2 {
		t.Fatalf("la tanda: %v", second)
	}
	first := batch[0].(map[string]any)["options"].([]any)[0].(map[string]any)
	if first["label"] != "Cálido" || first["description"] != "tonos tierra" {
		t.Fatalf("opciones con descripción: %v", first)
	}

	answer, _ := json.Marshal(map[string]any{"answers": []string{"Cálido", "Carta, Ubicación", ""}})
	relay.push(fmt.Sprintf(`{"type":"approve","id":%q,"decision":%q}`, request["id"], string(answer)))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })
	h.settle()

	if n := len(relay.all("choice_request")); n != 1 {
		t.Fatalf("la app nueva responde todo de una vez: %d preguntas abiertas", n)
	}
	answered := relay.all("question_answered")
	if len(answered) != 2 || answered[0]["header"] != "Estilo" || answered[1]["answer"] != "Carta, Ubicación" ||
		answered[0]["batch"] != answered[1]["batch"] || fmt.Sprint(answered[1]["total"]) != "3" {
		t.Fatalf("question_answered: %v", answered)
	}
	body := fmt.Sprint(h.gw.bodyAt(1)["messages"])
	if !strings.Contains(body, "Carta, Ubicación") || !strings.Contains(body, "decide tú") {
		t.Fatalf("las respuestas llegan al modelo: %s", body)
	}
	h.m.remote.link.Stop(true)
}

// Una app antigua responde solo la primera: el resto le llega de una en una.
func TestRemoteBatchFallsBackToOneByOne(t *testing.T) {
	h, relay := agentRemote(t,
		toolReply("t1", "ask_user", map[string]any{"questions": []any{
			map[string]any{"question": "¿Primera?"}, map[string]any{"question": "¿Segunda?"},
		}}),
		textReply("Hecho."))
	relay.push(prompt("pregunta"))
	h.waitFor("primera", func() bool { return relay.find("choice_request") != nil })
	relay.push(fmt.Sprintf(`{"type":"approve","id":%q,"decision":"uno"}`, relay.find("choice_request")["id"]))
	h.waitFor("segunda", func() bool { return len(relay.all("choice_request")) == 2 })
	second := relay.last("choice_request")
	if second["title"] != "¿Segunda?" || second["batch"] != nil {
		t.Fatalf("la segunda va sola: %v", second)
	}
	relay.push(fmt.Sprintf(`{"type":"approve","id":%q,"decision":"dos"}`, second["id"]))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })
	h.settle()
	if body := fmt.Sprint(h.gw.bodyAt(1)["messages"]); !strings.Contains(body, "uno") || !strings.Contains(body, "dos") {
		t.Fatalf("las dos respuestas llegan al modelo: %s", body)
	}
	h.m.remote.link.Stop(true)
}

func TestRemoteCompactReportsProgressAndTheSummary(t *testing.T) {
	summary := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hablamos de la carpeta.\"}}]}\n\ndata: [DONE]\n\n")
	}
	h, relay := remoteHarness(t, nil, summary)
	h.chat.History = []history.Message{
		history.User("uno"), history.Assistant("respuesta uno"),
		history.User("dos"), history.Assistant("respuesta dos"),
		history.User("tres"), history.Assistant("respuesta tres"),
	}
	startRemote(t, h, relay)
	relay.push(prompt("/compact"))
	h.waitFor("compacted", func() bool { return relay.find("compacted") != nil })

	start := relay.find("compact")
	if start["phase"] != "start" || start["messages"] != float64(6) {
		t.Fatalf("compact: %v", start)
	}
	done := relay.find("compacted")
	if done["summary"] != "Hablamos de la carpeta." || done["before"] == nil || done["after"] == nil {
		t.Fatalf("compacted: %v", done)
	}
	h.m.remote.link.Stop(true)
}
