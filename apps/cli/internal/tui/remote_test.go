package tui

import (
	"encoding/json"
	"fmt"
	"github.com/charmbracelet/x/ansi"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"lixbon.com/cli/internal/config"
)

// fakeRelay es el relay del gateway: guarda lo que publica el host y le
// manda por SSE lo que la prueba teclea desde «el móvil».
type fakeRelay struct {
	mu       sync.Mutex
	events   []map[string]any
	ended    bool
	commands chan string
	streams  int
	images   map[string]string // id → Content-Type de lo que subió el host
}

func newFakeRelay() *fakeRelay { return &fakeRelay{commands: make(chan string, 32)} }

func (f *fakeRelay) serve(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/remote/sessions":
		io.WriteString(w, `{"session":{"id":"r1"},"share_url":"https://lixbon.test/remote/tok"}`)
	case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/events"):
		var body struct {
			Events []map[string]any `json:"events"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.events = append(f.events, body.Events...)
		f.mu.Unlock()
		io.WriteString(w, `{}`)
	case r.Method == http.MethodPut && strings.Contains(r.URL.Path, "/images/"):
		io.Copy(io.Discard, r.Body)
		f.mu.Lock()
		if f.images == nil {
			f.images = map[string]string{}
		}
		f.images[r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]] = r.Header.Get("Content-Type")
		f.mu.Unlock()
		io.WriteString(w, `{}`)
	case r.Method == http.MethodDelete:
		f.mu.Lock()
		f.ended = true
		f.mu.Unlock()
		io.WriteString(w, `{"ended":true}`)
	case strings.HasSuffix(r.URL.Path, "/qr"):
		io.WriteString(w, "QR-FILA-1\nQR-FILA-2\n")
	case strings.HasSuffix(r.URL.Path, "/commands"):
		f.mu.Lock()
		f.streams++
		f.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, ": connected\n\n")
		w.(http.Flusher).Flush()
		for {
			select {
			case line := <-f.commands:
				io.WriteString(w, "data: "+line+"\n\n")
				w.(http.Flusher).Flush()
			case <-r.Context().Done():
				return
			}
		}
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeRelay) push(command string) { f.commands <- command }

func (f *fakeRelay) snapshotEvents() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]map[string]any(nil), f.events...)
}

func (f *fakeRelay) find(eventType string) map[string]any {
	for _, e := range f.snapshotEvents() {
		if e["type"] == eventType {
			return e
		}
	}
	return nil
}

func (f *fakeRelay) isEnded() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.ended
}

func (h *harness) waitFor(what string, cond func() bool) {
	h.t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	h.pump(func() bool {
		if cond() {
			return true
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("no ocurrió a tiempo: %s", what)
		}
		return false
	})
}

func prompt(text string) string {
	raw, _ := json.Marshal(map[string]any{"type": "prompt", "text": text})
	return string(raw)
}

func remoteHarness(t *testing.T, mutate func(*config.Config), steps ...func(http.ResponseWriter, *http.Request)) (*harness, *fakeRelay) {
	t.Helper()
	h := newHarness(t, mutate, steps...)
	relay := newFakeRelay()
	h.gw.relay = relay
	h.chat.Cfg.BaseURL = h.chat.Client.BaseURL
	return h, relay
}

func startRemote(t *testing.T, h *harness, relay *fakeRelay) {
	t.Helper()
	h.send("/remote")
	h.settle()
	h.waitFor("hello", func() bool { return relay.find("hello") != nil && relay.find("snapshot") != nil })
}

func TestRemoteShowsLinkAndQRAndKeepsTheKeyboard(t *testing.T) {
	h, relay := remoteHarness(t, nil, textReply("hola desde el modelo"))
	startRemote(t, h, relay)

	contains(t, h.out(), "Control remoto activo")
	contains(t, h.out(), "https://lixbon.test/remote/tok")
	contains(t, h.out(), "Código QR")
	notContains(t, h.out(), "QR-FILA-1")
	h.m.toggleDetail()
	contains(t, ansi.Strip(h.m.log.text()), "QR-FILA-1")
	h.m.toggleDetail()
	contains(t, h.view(), "Remote activo")

	h.send("hola")
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })
	if msg := relay.find("user_msg"); msg["text"] != "hola" || msg["origin"] != "local" {
		t.Fatalf("lo escrito en la terminal también llega al móvil: %v", msg)
	}
	hello := relay.find("hello")
	if hello["source"] != "cli" || hello["mode"] != "ask" || hello["model"] != "qwen" {
		t.Fatalf("hello: %v", hello)
	}
	h.settle()
	h.key("ctrl+c")
	if h.m.remote != nil {
		t.Fatal("ctrl+c con la caja vacía termina el modo remoto")
	}
}

func TestRemotePromptRunsATurnAndStreamsItBack(t *testing.T) {
	h, relay := remoteHarness(t, nil, textReply("hola, soy el modelo"))
	startRemote(t, h, relay)

	relay.push(prompt("hola desde el móvil"))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })

	contains(t, h.out(), "hola desde el móvil")
	var types []string
	for _, e := range relay.snapshotEvents() {
		types = append(types, e["type"].(string))
	}
	order := func(a, b string) bool {
		ia, ib := -1, -1
		for i, ty := range types {
			if ty == a && ia < 0 {
				ia = i
			}
			if ty == b {
				ib = i
			}
		}
		return ia >= 0 && ib > ia
	}
	if !order("user_msg", "assistant_delta") || !order("assistant_delta", "assistant_done") {
		t.Fatalf("orden de eventos: %v", types)
	}
	if relay.find("user_msg")["text"] != "hola desde el móvil" || relay.find("user_msg")["origin"] != "remote" {
		t.Fatalf("user_msg: %v", relay.find("user_msg"))
	}
	if done := relay.find("assistant_done"); done["text"] != "hola, soy el modelo" || done["interrupted"] != false {
		t.Fatalf("assistant_done: %v", done)
	}
	h.waitFor("estado idle", func() bool {
		events := relay.snapshotEvents()
		return len(events) > 0 && events[len(events)-1]["type"] == "status" && events[len(events)-1]["state"] == "idle"
	})
	h.m.remote.link.Stop(true)
}

func TestRemoteApprovalComesFromThePhone(t *testing.T) {
	for _, decision := range []string{"allow", "deny"} {
		t.Run(decision, func(t *testing.T) {
			h, relay := remoteHarness(t, func(c *config.Config) { c.AutoApproveTools = false; c.Mode = "agent" },
				toolReply("t1", "write_file", map[string]any{"path": "nota.txt", "content": "hola"}),
				textReply("hecho"))
			startRemote(t, h, relay)

			relay.push(prompt("crea nota.txt"))
			h.waitFor("approval_request", func() bool { return relay.find("approval_request") != nil })
			request := relay.find("approval_request")
			if request["tool"] != "write_file" || request["risk"] != "edit" {
				t.Fatalf("request: %v", request)
			}
			if _, err := os.Stat(filepath.Join(h.root, "nota.txt")); err == nil {
				t.Fatal("el archivo no debe existir antes de la aprobación")
			}
			relay.push(fmt.Sprintf(`{"type":"approve","id":%q,"decision":%q}`, request["id"], decision))
			h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })

			_, err := os.Stat(filepath.Join(h.root, "nota.txt"))
			if (decision == "allow") != (err == nil) {
				t.Fatalf("decisión %s, archivo creado=%v", decision, err == nil)
			}
			if relay.find("tool_use") == nil || relay.find("approval_resolved")["decision"] != decision {
				t.Fatalf("eventos: %v", relay.snapshotEvents())
			}
			h.m.remote.link.Stop(true)
		})
	}
}

func TestRemoteInterruptCancelsTheTurnWithoutWaitingForTheModel(t *testing.T) {
	h, relay := remoteHarness(t, nil, slowReply("tarde", 30*time.Second))
	startRemote(t, h, relay)

	relay.push(prompt("tarda mucho"))
	h.waitFor("turno en curso", func() bool { return h.m.running && h.gw.count() == 1 })
	relay.push(`{"type":"interrupt"}`)
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })

	if done := relay.find("assistant_done"); done["interrupted"] != true {
		t.Fatalf("assistant_done: %v", done)
	}
	if h.m.running {
		t.Fatal("el turno debía haberse cancelado")
	}
	h.m.remote.link.Stop(true)
}

func (f *fakeRelay) all(eventType string) []map[string]any {
	var out []map[string]any
	for _, e := range f.snapshotEvents() {
		if e["type"] == eventType {
			out = append(out, e)
		}
	}
	return out
}

func (f *fakeRelay) last(eventType string) map[string]any {
	all := f.all(eventType)
	if len(all) == 0 {
		return nil
	}
	return all[len(all)-1]
}

func TestRemoteHelloAnnouncesImagesAndTheWholeCommandCatalog(t *testing.T) {
	h, relay := remoteHarness(t, nil)
	startRemote(t, h, relay)
	hello := relay.find("hello")
	caps, _ := hello["capabilities"].([]any)
	if !slices.Contains(caps, any("images")) || !slices.Contains(caps, any("attachments")) || hello["agent"] != "lixbon" {
		t.Fatalf("hello sin capacidades: %v", hello)
	}
	var names []string
	for _, c := range hello["commands"].([]any) {
		names = append(names, c.(map[string]any)["name"].(string))
	}
	for _, want := range []string{"model", "effort", "mode", "branch", "commit", "diff", "mcp", "plan", "ps", "todo", "tools", "visual", "compact"} {
		if !slices.Contains(names, want) {
			t.Errorf("falta /%s en el catálogo remoto", want)
		}
	}
	for _, blocked := range []string{"exit", "logout", "remote"} {
		if slices.Contains(names, blocked) {
			t.Errorf("/%s no se ofrece en remoto", blocked)
		}
	}
	h.m.remote.link.Stop(true)
}

func TestRemoteSlashCommandsRunTheRealCommand(t *testing.T) {
	h, relay := remoteHarness(t, nil)
	startRemote(t, h, relay)

	relay.push(prompt("/model llama"))
	relay.push(prompt("/approve off"))
	relay.push(prompt("/web on"))
	relay.push(prompt("/nope"))
	relay.push(prompt("/exit"))
	h.waitFor("respuestas", func() bool { return len(relay.all("command_result")) >= 3 && len(relay.all("notice")) >= 2 })

	results := relay.all("command_result")
	for i, want := range []string{"Modelo: Llama", "Auto-aprobar: off", "Búsqueda web: on"} {
		if text, _ := results[i]["text"].(string); !strings.Contains(text, want) {
			t.Errorf("resultado %d = %q, esperaba %q", i, text, want)
		}
	}
	notices := relay.all("notice")
	if !strings.Contains(notices[0]["text"].(string), "Comando desconocido: /nope") || !strings.Contains(notices[1]["text"].(string), "no se puede usar desde la app") {
		t.Fatalf("avisos: %v", notices)
	}
	contains(t, h.out(), "/model llama  [remoto]")
	contains(t, h.out(), "Modelo: Llama")
	h.waitFor("hello con el modelo nuevo", func() bool { return relay.last("hello")["model"] == "llama" })
	if h.chat.Model != "llama" || h.gw.count() != 0 || h.m.quitting {
		t.Fatalf("modelo %q, peticiones al modelo %d, saliendo %v", h.chat.Model, h.gw.count(), h.m.quitting)
	}
	h.m.remote.link.Stop(true)
}

func TestRemoteSelectorIsChosenFromThePhone(t *testing.T) {
	h, relay := remoteHarness(t, nil)
	startRemote(t, h, relay)

	relay.push(prompt("/mode"))
	h.waitFor("choice_request", func() bool { return relay.find("choice_request") != nil })
	choice := relay.find("choice_request")
	options := choice["options"].([]any)
	if choice["title"] != "Modo de trabajo" || len(options) != 3 || options[1].(map[string]any)["value"] != "agent" {
		t.Fatalf("choice: %v", choice)
	}
	if h.m.picker == nil {
		t.Fatal("el selector sigue abierto también en la terminal")
	}
	relay.push(fmt.Sprintf(`{"type":"approve","id":%q,"decision":"agent"}`, choice["id"]))
	h.waitFor("modo agent", func() bool { return h.chat.Mode == "agent" && relay.find("choice_resolved") != nil })
	h.waitFor("hello en agent", func() bool { return relay.last("hello")["mode"] == "agent" })
	if h.m.picker != nil {
		t.Fatal("elegir en el móvil cierra el selector de la terminal")
	}
	if text, _ := relay.last("command_result")["text"].(string); !strings.Contains(text, "Workspace del agente") {
		t.Fatalf("resultado: %v", relay.last("command_result"))
	}

	relay.push(prompt("/mode"))
	h.waitFor("otro selector", func() bool { return len(relay.all("choice_request")) == 2 })
	h.key("esc")
	h.waitFor("retirado del móvil", func() bool {
		return relay.last("choice_resolved")["id"] == relay.last("choice_request")["id"]
	})
	h.m.remote.link.Stop(true)
}

func TestRemoteAsyncCommandResultReachesThePhone(t *testing.T) {
	h, relay := remoteHarness(t, nil)
	startRemote(t, h, relay)
	relay.push(prompt("/diff"))
	h.waitFor("resultado de /diff", func() bool { return relay.find("command_result") != nil })
	if text, _ := relay.find("command_result")["text"].(string); !strings.Contains(text, "no es un repositorio git") {
		t.Fatalf("resultado: %v", relay.find("command_result"))
	}
	h.m.remote.link.Stop(true)
}

// png1x1 es una imagen PNG válida de un píxel.
const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

func TestRemotePhotoAndDocumentReachTheModel(t *testing.T) {
	h, relay := remoteHarness(t, nil, textReply("veo un píxel"))
	startRemote(t, h, relay)
	relay.push(`{"type":"prompt","text":"¿qué ves?","attachments":[{"kind":"image","name":"foto.png","base64":"` + png1x1 + `","mime":"image/png"},{"kind":"doc","name":"notas.txt","text":"contenido del documento"}]}`)
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })

	messages := h.gw.bodyAt(0)["messages"].([]any)
	last := messages[len(messages)-1].(map[string]any)
	if images, _ := last["images"].([]any); len(images) != 1 {
		t.Fatalf("la foto no llegó al modelo: %v", last)
	}
	if content, _ := last["content"].(string); !strings.Contains(content, "contenido del documento") || !strings.Contains(content, "¿qué ves?") {
		t.Fatalf("contenido: %q", content)
	}
	if msg := relay.find("user_msg"); msg["text"] != "¿qué ves?" || msg["images"] != float64(1) || msg["origin"] != "remote" {
		t.Fatalf("user_msg: %v", msg)
	}
	h.m.remote.link.Stop(true)
}

func TestRemoteAgentToolsCarryTheirIDAndDiff(t *testing.T) {
	h, relay := remoteHarness(t, func(c *config.Config) { c.AutoApproveTools = true; c.Mode = "agent" },
		toolReply("t1", "write_file", map[string]any{"path": "nota.txt", "content": "hola\nmundo\n"}),
		textReply("hecho"))
	startRemote(t, h, relay)
	relay.push(prompt("crea nota.txt"))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })

	use, result := relay.find("tool_use"), relay.find("tool_result")
	if use["id"] == "" || use["id"] != result["id"] || use["tool"] != "write_file" {
		t.Fatalf("tool_use %v / tool_result %v", use, result)
	}
	if diff, _ := use["diff"].(string); use["adds"] != float64(2) || !strings.Contains(diff, "+hola") {
		t.Fatalf("diff: %v", use)
	}
	relay.push(`{"type":"request_snapshot"}`)
	h.waitFor("snapshot con herramientas", func() bool {
		messages, _ := relay.last("snapshot")["messages"].([]any)
		for _, msg := range messages {
			if m := msg.(map[string]any); m["role"] == "tool" && m["tool"] == "write_file" && m["pending"] == false {
				return true
			}
		}
		return false
	})
	h.m.remote.link.Stop(true)
}

func reasoningReply(thought, text string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		think, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"reasoning_content": thought}}}})
		say, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}})
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: "+string(think)+"\n\ndata: "+string(say)+"\n\ndata: [DONE]\n\n")
	}
}

func TestRemoteReadsEndOkAndThePhoneSeesWhatTheAgentIsDoing(t *testing.T) {
	h, relay := remoteHarness(t, func(c *config.Config) { c.Mode = "agent" },
		toolReply("t1", "list_files", map[string]any{"path": "."}),
		reasoningReply("miro lo que hay", "Hay un archivo: a.txt."))
	writeTree(t, h.chat.Workspace, "a.txt")
	startRemote(t, h, relay)
	relay.push(prompt("¿qué archivos ves?"))
	h.waitFor("assistant_done", func() bool { return relay.find("assistant_done") != nil })
	h.settle()

	var results []map[string]any
	activities := map[string]bool{}
	for _, e := range relay.snapshotEvents() {
		switch e["type"] {
		case "tool_result":
			results = append(results, e)
		case "status":
			if a, _ := e["activity"].(string); a != "" {
				activities[a] = true
			}
		}
	}
	for _, r := range results {
		if r["error"] == true {
			t.Fatalf("una lectura que salió bien no acaba como interrumpida: %v", results)
		}
	}
	for _, a := range []string{"working", "reasoning", "writing"} {
		if !activities[a] {
			t.Fatalf("el móvil sabe que el agente está %q: %v", a, activities)
		}
	}
	if done := relay.find("assistant_done"); done["text"] != "Hay un archivo: a.txt." {
		t.Fatalf("assistant_done: %v", done)
	}
	h.m.remote.link.Stop(true)
}

func TestCtrlCEndsRemoteAndGivesTheKeyboardBack(t *testing.T) {
	h, relay := remoteHarness(t, nil)
	before := h.chat.Session.Approver
	startRemote(t, h, relay)
	if h.chat.Session.Approver == before {
		t.Fatal("en remoto las aprobaciones van al móvil")
	}

	h.key("ctrl+c")
	h.waitFor("sesión terminada", relay.isEnded)
	if h.m.remote != nil || h.chat.Session.Approver != before {
		t.Fatal("al terminar se restauran el teclado y las aprobaciones locales")
	}
	contains(t, h.out(), "Control remoto terminado")
	if relay.find("bye") == nil || relay.find("bye")["reason"] != "host_closed" {
		t.Fatalf("falta el bye: %v", relay.snapshotEvents())
	}
	h.typeText("hola")
	if h.m.input.Value() != "hola" {
		t.Fatalf("el teclado debe volver: %q", h.m.input.Value())
	}
}

func TestRemoteByeFromTheServerEndsItWithoutClosingTwice(t *testing.T) {
	h, relay := remoteHarness(t, nil)
	startRemote(t, h, relay)
	relay.push(`{"type":"bye","reason":"ended"}`)
	h.waitFor("remoto terminado", func() bool { return h.m.remote == nil })
	contains(t, h.out(), "Control remoto terminado")
	time.Sleep(50 * time.Millisecond)
	if relay.isEnded() {
		t.Fatal("si el servidor ya terminó la sesión, el host no la vuelve a cerrar")
	}
}

func TestRemoteNeedsAnAccount(t *testing.T) {
	h, _ := remoteHarness(t, nil)
	h.chat.Cfg.APIKey = ""
	h.send("/remote")
	contains(t, h.out(), "Necesitas una sesión activa (/login) para usar /remote.")

	_, _, add := withExternalProvider(t)
	h, _ = remoteHarness(t, func(cfg *config.Config) { cfg.APIKey = ""; add(cfg) })
	h.send("/provider local")
	h.settle()
	h.send("/remote")
	contains(t, h.out(), "Necesitas una sesión activa (/login) para usar /remote.")

	h, _ = remoteHarness(t, nil)
	h.send("/remote nada")
	contains(t, h.out(), "Uso: /remote")
}

func TestQuittingWhileRemoteClosesTheSession(t *testing.T) {
	h, relay := remoteHarness(t, nil)
	startRemote(t, h, relay)
	h.m.quit()
	if !relay.isEnded() || h.m.remote != nil {
		t.Fatal("al salir se cierra la sesión remota")
	}
}

func TestRemoteCannotRunShellCommandsWithBang(t *testing.T) {
	h, relay := remoteHarness(t, nil)
	startRemote(t, h, relay)
	relay.push(prompt("!echo no-debe-ejecutarse"))
	h.waitFor("aviso", func() bool { return strings.Contains(h.out(), "Se ignoró un «!»") })
	notContains(t, h.out(), "salida 0")
	for _, m := range h.chat.History {
		if strings.Contains(m.Content, "TOOL_RESULT") {
			t.Fatalf("se ejecutó un comando recibido por remoto: %+v", m)
		}
	}
	h.key("ctrl+c")
	h.waitFor("sesión terminada", relay.isEnded)
}

// Con otro proveedor activo el control remoto pasa por la cuenta Lixbon
// guardada y la sesión se presenta como Lixbon.
func TestRemoteWithAnExternalProviderUsesTheLixbonAccount(t *testing.T) {
	_, _, add := withExternalProvider(t)
	h, relay := remoteHarness(t, add)
	h.send("/provider local")
	h.settle()
	if !h.chat.Client.Generic {
		t.Fatal("el proveedor activo debería ser el externo")
	}
	startRemote(t, h, relay)
	contains(t, h.out(), "Control remoto activo")
	if hello := relay.find("hello"); hello["agent"] != "lixbon" || hello["model"] != h.chat.Model {
		t.Fatalf("hello: %v", hello)
	}
}
