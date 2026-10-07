package remote

import (
	"context"
	"errors"
	"fmt"
	"io"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"lixbon.com/cli/internal/api"
)

type fakeRelay struct {
	mu       sync.Mutex
	events   []map[string]any
	batches  int
	failures int // lotes que rechazar con error transitorio
	status   int // si no es 0, RemoteEvents falla con este estado HTTP
	ended    bool
	opened   int
	writer   *io.PipeWriter
	connect  chan struct{}
}

func newRelay() *fakeRelay { return &fakeRelay{connect: make(chan struct{}, 16)} }

func (f *fakeRelay) RemoteCreate(context.Context, string, string, string) (api.RemoteSession, error) {
	return api.RemoteSession{ID: "s1", ShareURL: "https://lixbon.test/remote/tok"}, nil
}

func (f *fakeRelay) RemoteEvents(_ context.Context, _ string, events []map[string]any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.status != 0 {
		return &api.Error{Status: f.status, Message: "gone"}
	}
	if f.failures > 0 {
		f.failures--
		return &api.Error{Status: 503, Message: "caído"}
	}
	f.batches++
	f.events = append(f.events, events...)
	return nil
}

func (f *fakeRelay) RemoteEnd(context.Context, string) error {
	f.mu.Lock()
	f.ended = true
	f.mu.Unlock()
	return nil
}

func (f *fakeRelay) RemoteQR(context.Context, string) (string, error) { return "▀▄ QR", nil }

func (f *fakeRelay) RemoteCommands(ctx context.Context, _ string) (io.ReadCloser, error) {
	pr, pw := io.Pipe()
	f.mu.Lock()
	f.opened++
	f.writer = pw
	f.mu.Unlock()
	go func() {
		<-ctx.Done()
		pw.CloseWithError(ctx.Err())
	}()
	f.connect <- struct{}{}
	return pr, nil
}

func (f *fakeRelay) send(t *testing.T, line string) {
	t.Helper()
	f.mu.Lock()
	w := f.writer
	f.mu.Unlock()
	if _, err := io.WriteString(w, line+"\n\n"); err != nil {
		t.Fatal(err)
	}
}

func (f *fakeRelay) types() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.events))
	for i, e := range f.events {
		out[i], _ = e["type"].(string)
	}
	return out
}

func (f *fakeRelay) find(eventType string) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, e := range f.events {
		if e["type"] == eventType {
			return e
		}
	}
	return nil
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no ocurrió a tiempo: %s", what)
}

func fast(t *testing.T) {
	flush, min, max := flushEvery, reconnectMin, reconnectMax
	flushEvery, reconnectMin, reconnectMax = 5*time.Millisecond, 10*time.Millisecond, 40*time.Millisecond
	t.Cleanup(func() { flushEvery, reconnectMin, reconnectMax = flush, min, max })
}

func started(t *testing.T) (*Link, *fakeRelay) {
	t.Helper()
	fast(t)
	relay := newRelay()
	link := NewLink(relay, "cli", "proyecto", "mi-pc")
	link.Snapshot = func() []map[string]any { return []map[string]any{{"role": "user", "content": "hola"}} }
	if err := link.Start(context.Background(), "agent", "qwen"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { link.Stop(false) })
	<-relay.connect
	return link, relay
}

func TestStartPublishesHelloWithTheCommandCatalog(t *testing.T) {
	link, relay := started(t)
	eventually(t, "hello", func() bool { return relay.find("hello") != nil })
	hello := relay.find("hello")
	if hello["source"] != "cli" || hello["title"] != "proyecto" || hello["machine"] != "mi-pc" || hello["mode"] != "agent" || hello["model"] != "qwen" {
		t.Fatalf("hello: %v", hello)
	}
	if cmds, _ := hello["commands"].([]map[string]string); len(cmds) != len(Commands) || cmds[0]["name"] != "help" {
		t.Fatalf("comandos: %v", hello["commands"])
	}
	if link.ShareURL() != "https://lixbon.test/remote/tok" || link.QR(context.Background()) != "▀▄ QR" {
		t.Fatal("enlace y QR")
	}
}

func TestConsecutiveDeltasAreMergedIntoOneEvent(t *testing.T) {
	link, relay := started(t)
	for _, part := range []string{"ho", "la", " mun", "do"} {
		link.Emit("assistant_delta", map[string]any{"text": part})
	}
	link.Emit("assistant_done", map[string]any{"text": "hola mundo", "interrupted": false})
	eventually(t, "assistant_done", func() bool { return relay.find("assistant_done") != nil })
	var deltas []string
	relay.mu.Lock()
	for _, e := range relay.events {
		if e["type"] == "assistant_delta" {
			deltas = append(deltas, e["text"].(string))
		}
	}
	relay.mu.Unlock()
	if len(deltas) != 1 || deltas[0] != "hola mundo" {
		t.Fatalf("deltas: %q", deltas)
	}
}

func TestEventsKeepTheirOrderAcrossBatches(t *testing.T) {
	link, relay := started(t)
	for i := 0; i < 450; i++ {
		link.Emit("notice", map[string]any{"n": i})
	}
	eventually(t, "450 avisos", func() bool {
		relay.mu.Lock()
		defer relay.mu.Unlock()
		return len(relay.events) >= 451
	})
	relay.mu.Lock()
	defer relay.mu.Unlock()
	next := 0
	for _, e := range relay.events {
		if e["type"] == "notice" {
			if e["n"] != next {
				t.Fatalf("aviso %v fuera de orden, esperaba %d", e["n"], next)
			}
			next++
		}
	}
	if relay.batches < 3 {
		t.Fatalf("el gateway admite 200 eventos por lote: %d lotes", relay.batches)
	}
}

func TestCommandsReachTheInboxAndKeepalivesAreIgnored(t *testing.T) {
	link, relay := started(t)
	relay.send(t, ": connected")
	relay.send(t, ": ping")
	relay.send(t, "data: no es json")
	relay.send(t, `data: {"type":"prompt","text":"hola desde el móvil"}`)
	relay.send(t, `data: {"type":"interrupt"}`)
	if cmd := <-link.Inbox; cmd.Type != "prompt" || cmd.Text != "hola desde el móvil" {
		t.Fatalf("prompt: %+v", cmd)
	}
	if cmd := <-link.Inbox; cmd.Type != "interrupt" {
		t.Fatalf("interrupt: %+v", cmd)
	}
	relay.send(t, `data: {"type":"bye","reason":"ended"}`)
	if cmd := <-link.Inbox; cmd.Type != "bye" || !link.Ended() {
		t.Fatalf("bye: %+v ended=%v", cmd, link.Ended())
	}
}

func TestApprovalRoundTrip(t *testing.T) {
	link, relay := started(t)
	result := make(chan bool, 1)
	go func() {
		result <- link.RequestApproval(context.Background(), "edit_file", "app.py (reemplaza 3 chars)", "edit")
	}()

	eventually(t, "approval_request", func() bool { return relay.find("approval_request") != nil })
	request := relay.find("approval_request")
	if request["tool"] != "edit_file" || request["risk"] != "edit" || request["summary"] != "app.py (reemplaza 3 chars)" {
		t.Fatalf("request: %v", request)
	}
	relay.send(t, fmt.Sprintf(`data: {"type":"approve","id":%q,"decision":"allow"}`, request["id"]))
	if !<-result {
		t.Fatal("la aprobación debía permitir")
	}
	eventually(t, "approval_resolved", func() bool { return relay.find("approval_resolved") != nil })
	if relay.find("approval_resolved")["decision"] != "allow" {
		t.Fatalf("resolved: %v", relay.find("approval_resolved"))
	}
}

func TestApprovalDeniesOnWrongIDCancelAndEnd(t *testing.T) {
	link, relay := started(t)

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan bool, 1)
	go func() { result <- link.RequestApproval(ctx, "run_command", "ls", "command") }()
	eventually(t, "approval_request", func() bool { return relay.find("approval_request") != nil })
	relay.send(t, `data: {"type":"approve","id":"otro","decision":"allow"}`)
	select {
	case <-result:
		t.Fatal("una aprobación con otro id no debe resolver la petición")
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	if <-result {
		t.Fatal("un turno cancelado equivale a denegar")
	}

	go func() { result <- link.RequestApproval(context.Background(), "run_command", "rm", "command") }()
	time.Sleep(20 * time.Millisecond)
	relay.send(t, `data: {"type":"bye"}`)
	if <-result {
		t.Fatal("al terminar la sesión se deniega")
	}
}

func TestRequestSnapshotCommand(t *testing.T) {
	_, relay := started(t)
	relay.send(t, `data: {"type":"request_snapshot"}`)
	eventually(t, "snapshot", func() bool { return relay.find("snapshot") != nil })
	messages := relay.find("snapshot")["messages"].([]map[string]any)
	if len(messages) != 1 || messages[0]["content"] != "hola" {
		t.Fatalf("snapshot: %v", messages)
	}
}

func TestOutageKeepsTheQueueBoundedAndRecoversWithASnapshot(t *testing.T) {
	link, relay := started(t)
	eventually(t, "hello", func() bool { return relay.find("hello") != nil })
	relay.mu.Lock()
	relay.failures = 1 << 30
	relay.mu.Unlock()

	chunk := strings.Repeat("x", 100_000)
	link.Emit("approval_request", map[string]any{"id": "a1", "tool": "edit_file", "summary": "s", "risk": "edit"})
	for i := 0; i < 40; i++ {
		link.Emit("status", map[string]any{"state": "thinking"})
		link.Emit("tool_result", map[string]any{"tool": "search", "result": chunk})
		link.Emit("assistant_delta", map[string]any{"text": chunk})
		link.Emit("notice", map[string]any{"text": "n"})
	}
	link.Emit("assistant_done", map[string]any{"text": "fin", "interrupted": false})
	time.Sleep(60 * time.Millisecond)

	link.mu.Lock()
	bytes, pending := link.queuedBytes, len(link.queue)
	link.mu.Unlock()
	if bytes > MaxQueuedBytes {
		t.Fatalf("la cola acumula %d bytes (tope %d)", bytes, MaxQueuedBytes)
	}
	if pending == 0 {
		t.Fatal("la cola no debe vaciarse mientras el servidor no responde")
	}

	relay.mu.Lock()
	relay.failures = 0
	relay.mu.Unlock()
	eventually(t, "snapshot tras recuperarse", func() bool { return relay.find("snapshot") != nil })
	eventually(t, "assistant_done", func() bool { return relay.find("assistant_done") != nil })
	if relay.find("approval_request") == nil {
		t.Fatalf("los eventos importantes sobreviven al descarte: %v", relay.types())
	}
}

func TestServerGoneEndsTheSession(t *testing.T) {
	link, relay := started(t)
	relay.mu.Lock()
	relay.status = 410
	relay.mu.Unlock()
	link.Emit("status", map[string]any{"state": "idle"})
	select {
	case cmd := <-link.Inbox:
		if cmd.Type != "bye" || cmd.Reason != "gone" {
			t.Fatalf("cmd: %+v", cmd)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("el fin de sesión del servidor debe llegar al inbox")
	}
	<-link.Done()
}

func TestCommandStreamReconnectsAfterADrop(t *testing.T) {
	link, relay := started(t)
	relay.mu.Lock()
	writer := relay.writer
	relay.mu.Unlock()
	writer.CloseWithError(errors.New("conexión cortada"))
	<-relay.connect
	relay.send(t, `data: {"type":"prompt","text":"tras el corte"}`)
	if cmd := <-link.Inbox; cmd.Text != "tras el corte" {
		t.Fatalf("cmd: %+v", cmd)
	}
	relay.mu.Lock()
	defer relay.mu.Unlock()
	if relay.opened != 2 {
		t.Fatalf("conexiones: %d", relay.opened)
	}
}

func TestStopEndsTheSessionAndLeavesNoGoroutines(t *testing.T) {
	fast(t)
	before := runtime.NumGoroutine()
	relay := newRelay()
	link := NewLink(relay, "cli", "p", "m")
	if err := link.Start(context.Background(), "ask", "qwen"); err != nil {
		t.Fatal(err)
	}
	<-relay.connect
	link.Emit("assistant_done", map[string]any{"text": "ok"})
	link.Stop(true)
	link.Stop(true)

	relay.mu.Lock()
	ended := relay.ended
	relay.mu.Unlock()
	if !ended || relay.find("bye") == nil || relay.find("bye")["reason"] != "host_closed" || relay.find("assistant_done") == nil {
		t.Fatalf("ended=%v eventos=%v", ended, relay.types())
	}
	if _, open := <-link.Inbox; open {
		t.Fatal("el inbox debe cerrarse")
	}
	eventually(t, "sin goroutines abandonadas", func() bool { return runtime.NumGoroutine() <= before+1 })
}

func TestStopWithoutEndingTheSessionDoesNotTouchTheServer(t *testing.T) {
	fast(t)
	relay := newRelay()
	link := NewLink(relay, "cli", "p", "m")
	link.Start(context.Background(), "ask", "qwen")
	<-relay.connect
	link.Stop(false)
	relay.mu.Lock()
	defer relay.mu.Unlock()
	if relay.ended {
		t.Fatal("Stop(false) no termina la sesión")
	}
}
