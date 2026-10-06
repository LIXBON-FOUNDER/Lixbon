package tui

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
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

func TestRemoteShowsLinkAndQRAndPausesTheKeyboard(t *testing.T) {
	h, relay := remoteHarness(t, nil)
	startRemote(t, h, relay)

	contains(t, h.out(), "Control remoto activo")
	contains(t, h.out(), "https://lixbon.test/remote/tok")
	contains(t, h.out(), "QR-FILA-1")
	contains(t, h.view(), "Control remoto activo")

	h.typeText("hola")
	h.key("enter")
	if h.m.input.Value() != "" || h.gw.count() != 0 {
		t.Fatalf("el teclado local debe quedar en pausa: caja=%q peticiones=%d", h.m.input.Value(), h.gw.count())
	}
	hello := relay.find("hello")
	if hello["source"] != "cli" || hello["mode"] != "ask" || hello["model"] != "qwen" {
		t.Fatalf("hello: %v", hello)
	}
	h.m.remote.link.Stop(true)
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

func TestRemoteSlashCommandsAnswerWithNotices(t *testing.T) {
	h, relay := remoteHarness(t, nil)
	startRemote(t, h, relay)

	relay.push(prompt("/model llama"))
	relay.push(prompt("/mode"))
	relay.push(prompt("/approve off"))
	relay.push(prompt("/web on"))
	relay.push(prompt("/nope"))
	relay.push(prompt("/s"))
	h.waitFor("seis avisos", func() bool {
		n := 0
		for _, e := range relay.snapshotEvents() {
			if e["type"] == "notice" {
				n++
			}
		}
		return n >= 6
	})
	var notices []string
	for _, e := range relay.snapshotEvents() {
		if e["type"] == "notice" {
			notices = append(notices, e["text"].(string))
		}
	}
	want := []string{"Modelo cambiado a llama.", "Modo actual: ask.", "Auto-aprobar herramientas: off.", "Búsqueda web: on.", "no se puede ejecutar desde la app", "Modelo: llama"}
	for i, part := range want {
		if !strings.Contains(notices[i], part) {
			t.Errorf("aviso %d = %q, esperaba %q", i, notices[i], part)
		}
	}
	if h.chat.Model != "llama" || h.gw.count() != 0 {
		t.Fatalf("modelo %q, peticiones al modelo %d", h.chat.Model, h.gw.count())
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

func TestRemoteNeedsAnAccountAndAGatewayProvider(t *testing.T) {
	h, _ := remoteHarness(t, nil)
	h.chat.Cfg.APIKey = ""
	h.send("/remote")
	contains(t, h.out(), "Necesitas una sesión activa (/login) para usar /remote.")

	h, _ = remoteHarness(t, nil)
	h.chat.Client.Generic = true
	h.send("/remote")
	contains(t, h.out(), "solo funciona con un gateway Lixbon")

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
