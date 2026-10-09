// Package remote es el host del control remoto (/remote): la sesión del CLI se
// controla desde la app móvil o la web. El gateway solo releva; este proceso
// sigue siendo quien ejecuta todo.
//
// Transporte: bajada por SSE de larga duración (comandos del móvil) y subida
// por POST de lotes de eventos cada 250 ms. No hay entrega exactamente una
// vez: tras un corte largo se descartan los eventos menos importantes y se
// reenvía un snapshot del historial.
package remote

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"lixbon.com/cli/internal/api"
)

// Variables solo para que las pruebas no esperen segundos de verdad.
var (
	flushEvery   = 250 * time.Millisecond
	reconnectMin = 2 * time.Second
	reconnectMax = 30 * time.Second
)

const (
	maxBatchEvents   = 200
	closeTimeout     = 5 * time.Second
	maxCommandLine   = 1 << 20
	commandQueueSize = 64

	// MaxQueuedBytes acota lo que se acumula si el servidor no responde.
	MaxQueuedBytes = 1 << 20
	// ResultChars es el tamaño máximo del resumen de un resultado de herramienta.
	ResultChars = 600
)

// Relay es el servidor al que habla el host; *api.Client lo implementa.
type Relay interface {
	RemoteCreate(ctx context.Context, source, title, machine string) (api.RemoteSession, error)
	RemoteEvents(ctx context.Context, sessionID string, events []map[string]any) error
	RemoteEnd(ctx context.Context, sessionID string) error
	RemoteQR(ctx context.Context, data string) (string, error)
	RemoteCommands(ctx context.Context, sessionID string) (io.ReadCloser, error)
}

// CommandSpec es un comando que el host acepta desde la app, publicado en el
// `hello` para que el móvil pueda ofrecerlo. Solo entran los que se resuelven
// con un argumento: en remoto no hay teclado para un selector.
type CommandSpec struct{ Name, Args, Description string }

var Commands = []CommandSpec{
	{"help", "", "Ver los comandos disponibles aquí"},
	{"new", "", "Empezar una conversación nueva"},
	{"model", "[nombre]", "Ver o cambiar el modelo"},
	{"mode", "[ask|agent|delegate]", "Ver o cambiar el modo de trabajo"},
	{"approve", "[on|off]", "Auto-aprobar herramientas del agente"},
	{"web", "[on|off]", "Búsqueda web durante las respuestas"},
	{"status", "", "Estado de la sesión y del host"},
	{"cost", "", "Tokens y contexto consumidos"},
	{"workspace", "", "Carpeta de trabajo del agente"},
}

// Command es lo que el móvil o la web le pide al host: un mensaje, cancelar el
// turno o terminar. Las aprobaciones y los snapshots los resuelve el propio
// enlace.
type Command struct {
	Type   string `json:"type"`
	Text   string `json:"text"`
	Reason string `json:"reason"`
}

type Link struct {
	Relay   Relay
	Source  string
	Title   string
	Machine string
	// Snapshot devuelve el historial renderizable para un controller que se une.
	Snapshot func() []map[string]any
	// Inbox entrega prompt, interrupt y bye. Se cierra al terminar el enlace.
	Inbox <-chan Command

	inbox chan Command

	sessionID string
	shareURL  string

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	done   chan struct{}
	ended  atomic.Bool
	stop   sync.Once

	// flushMu serializa los vaciados: dos lotes a la vez llegarían desordenados.
	flushMu      sync.Mutex
	mu           sync.Mutex
	queue        []queued
	queuedBytes  int
	needSnapshot bool
	approvals    map[string]chan string
}

type queued struct {
	event    map[string]any
	size     int
	priority int
}

func NewLink(relay Relay, source, title, machine string) *Link {
	inbox := make(chan Command, commandQueueSize)
	return &Link{
		Relay: relay, Source: source, Title: title, Machine: machine,
		inbox: inbox, Inbox: inbox,
		done:      make(chan struct{}),
		approvals: map[string]chan string{},
	}
}

func (l *Link) ShareURL() string  { return l.shareURL }
func (l *Link) SessionID() string { return l.sessionID }

// Done se cierra cuando la sesión termina, por cualquiera de los dos lados.
func (l *Link) Done() <-chan struct{} { return l.done }
func (l *Link) Ended() bool           { return l.ended.Load() }

// Start crea la sesión en el gateway y arranca el lector y el vaciado de eventos.
func (l *Link) Start(ctx context.Context, mode, model string) error {
	session, err := l.Relay.RemoteCreate(ctx, l.Source, l.Title, l.Machine)
	if err != nil {
		return err
	}
	l.sessionID, l.shareURL = session.ID, session.ShareURL
	l.ctx, l.cancel = context.WithCancel(context.Background())

	commands := make([]map[string]string, len(Commands))
	for i, c := range Commands {
		commands[i] = map[string]string{"name": c.Name, "args": c.Args, "description": c.Description}
	}
	l.Emit("hello", map[string]any{
		"source": l.Source, "title": l.Title, "machine": l.Machine,
		"mode": mode, "model": model, "commands": commands,
	})
	l.wg.Add(2)
	go l.readCommands()
	go l.flushLoop()
	return nil
}

// QR devuelve el QR unicode del enlace, o vacío si el gateway no lo da.
func (l *Link) QR(ctx context.Context) string {
	text, err := l.Relay.RemoteQR(ctx, l.shareURL)
	if err != nil {
		return ""
	}
	return text
}

// Stop corta los hilos, hace un último vaciado y, si endSession, termina la
// sesión en el gateway. Es idempotente y no deja goroutines ni conexiones.
func (l *Link) Stop(endSession bool) {
	l.stop.Do(func() {
		if endSession && !l.ended.Load() && l.ctx != nil {
			l.Emit("bye", map[string]any{"reason": "host_closed"})
			ctx, cancel := context.WithTimeout(context.Background(), closeTimeout)
			l.flush(ctx)
			_ = l.Relay.RemoteEnd(ctx, l.sessionID)
			cancel()
		}
		l.finish()
		if l.cancel != nil {
			l.cancel()
		}
		l.wg.Wait()
		close(l.inbox)
	})
}

// finish marca el fin de la sesión y despierta a quien espera.
func (l *Link) finish() {
	if l.ended.CompareAndSwap(false, true) {
		close(l.done)
	}
}

// ── eventos (host → controllers) ─────────────────────────────────────────

func priority(eventType string) int {
	switch eventType {
	case "assistant_delta":
		return 0
	case "tool_use", "tool_result", "notice":
		return 1
	}
	return 2
}

// Emit encola un evento. Los deltas consecutivos se funden en uno y, si la cola
// se pasa del tope, se tiran primero los menos importantes.
func (l *Link) Emit(eventType string, fields map[string]any) {
	event := map[string]any{"type": eventType}
	for k, v := range fields {
		event[k] = v
	}
	raw, _ := json.Marshal(event)

	l.mu.Lock()
	defer l.mu.Unlock()
	if eventType == "assistant_delta" && len(l.queue) > 0 {
		last := &l.queue[len(l.queue)-1]
		if last.event["type"] == "assistant_delta" {
			joined, _ := last.event["text"].(string)
			extra, _ := event["text"].(string)
			last.event["text"] = joined + extra
			l.queuedBytes += len(extra)
			last.size += len(extra)
			l.trim()
			return
		}
	}
	l.queue = append(l.queue, queued{event: event, size: len(raw), priority: priority(eventType)})
	l.queuedBytes += len(raw)
	l.trim()
}

// trim respeta MaxQueuedBytes descartando, de la prioridad más baja a la más
// alta y del más antiguo al más nuevo. Descartar algo obliga a reenviar un
// snapshot cuando el servidor vuelva.
func (l *Link) trim() {
	for level := 0; level <= 2 && l.queuedBytes > MaxQueuedBytes; level++ {
		kept := l.queue[:0]
		for _, q := range l.queue {
			if l.queuedBytes > MaxQueuedBytes && q.priority == level {
				l.queuedBytes -= q.size
				l.needSnapshot = true
				continue
			}
			kept = append(kept, q)
		}
		l.queue = kept
	}
}

func (l *Link) takeBatch() []queued {
	l.mu.Lock()
	defer l.mu.Unlock()
	n := min(len(l.queue), maxBatchEvents)
	batch := append([]queued(nil), l.queue[:n]...)
	l.queue = append([]queued(nil), l.queue[n:]...)
	for _, q := range batch {
		l.queuedBytes -= q.size
	}
	return batch
}

func (l *Link) requeue(batch []queued) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.queue = append(batch, l.queue...)
	for _, q := range batch {
		l.queuedBytes += q.size
	}
	l.trim()
}

func gone(err error) bool {
	var apiErr *api.Error
	return errors.As(err, &apiErr) && (apiErr.Status == http.StatusNotFound || apiErr.Status == http.StatusGone)
}

// flush vacía la cola por lotes; se detiene en el primer fallo.
func (l *Link) flush(ctx context.Context) {
	l.flushMu.Lock()
	defer l.flushMu.Unlock()
	for {
		batch := l.takeBatch()
		if len(batch) == 0 {
			return
		}
		events := make([]map[string]any, len(batch))
		for i, q := range batch {
			events[i] = q.event
		}
		if err := l.Relay.RemoteEvents(ctx, l.sessionID, events); err != nil {
			if gone(err) {
				l.endedByServer("gone")
				return
			}
			l.requeue(batch)
			return
		}
		l.sendSnapshotIfNeeded()
	}
}

func (l *Link) sendSnapshotIfNeeded() {
	l.mu.Lock()
	need := l.needSnapshot
	l.needSnapshot = false
	l.mu.Unlock()
	if need {
		l.EmitSnapshot()
	}
}

func (l *Link) EmitSnapshot() {
	if l.Snapshot == nil {
		return
	}
	l.Emit("snapshot", map[string]any{"messages": l.Snapshot()})
}

func (l *Link) flushLoop() {
	defer l.wg.Done()
	ticker := time.NewTicker(flushEvery)
	defer ticker.Stop()
	for {
		select {
		case <-l.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(l.ctx, 20*time.Second)
			l.flush(ctx)
			cancel()
		}
	}
}

// ── comandos (controllers → host) ────────────────────────────────────────

func (l *Link) endedByServer(reason string) {
	l.finish()
	l.deliver(Command{Type: "bye", Reason: reason})
}

func (l *Link) deliver(cmd Command) {
	select {
	case l.inbox <- cmd:
	default:
		// Una cola llena solo pierde mensajes; un bye nunca debe perderse.
		if cmd.Type == "bye" {
			select {
			case <-l.inbox:
			default:
			}
			select {
			case l.inbox <- cmd:
			default:
			}
		}
	}
}

func (l *Link) readCommands() {
	defer l.wg.Done()
	backoff := reconnectMin
	for l.ctx.Err() == nil && !l.ended.Load() {
		body, err := l.Relay.RemoteCommands(l.ctx, l.sessionID)
		switch {
		case err == nil:
			backoff = reconnectMin
			l.consume(body)
		case gone(err):
			l.endedByServer("gone")
			return
		}
		if l.ctx.Err() != nil || l.ended.Load() {
			return
		}
		select {
		case <-l.ctx.Done():
			return
		case <-l.done:
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, reconnectMax)
	}
}

func (l *Link) consume(body io.ReadCloser) {
	defer body.Close()
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64<<10), maxCommandLine)
	for scanner.Scan() {
		payload, ok := strings.CutPrefix(strings.TrimSpace(scanner.Text()), "data:")
		if !ok {
			continue
		}
		var raw struct {
			Command
			ID       string `json:"id"`
			Decision string `json:"decision"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(payload)), &raw) != nil {
			continue
		}
		l.dispatch(raw.Command, raw.ID, raw.Decision)
	}
}

func (l *Link) dispatch(cmd Command, id, decision string) {
	switch cmd.Type {
	case "prompt", "interrupt":
		l.deliver(cmd)
	case "approve":
		l.mu.Lock()
		waiter := l.approvals[id]
		l.mu.Unlock()
		if waiter != nil {
			if decision == "" {
				decision = "deny"
			}
			select {
			case waiter <- decision:
			default:
			}
		}
	case "request_snapshot":
		l.EmitSnapshot()
	case "bye":
		l.finish()
		l.deliver(cmd)
	}
}

// ── aprobaciones remotas ─────────────────────────────────────────────────

func newID() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// RequestApproval emite approval_request y espera la decisión del móvil o la
// web. Un contexto cancelado o el fin de la sesión equivalen a denegar.
func (l *Link) RequestApproval(ctx context.Context, tool, summary, risk string) bool {
	id := newID()
	waiter := make(chan string, 1)
	l.mu.Lock()
	l.approvals[id] = waiter
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(l.approvals, id)
		l.mu.Unlock()
	}()

	l.Emit("approval_request", map[string]any{"id": id, "tool": tool, "summary": summary, "risk": risk})
	select {
	case decision := <-waiter:
		l.Emit("approval_resolved", map[string]any{"id": id, "decision": decision})
		return decision == "allow"
	case <-ctx.Done():
		return false
	case <-l.done:
		return false
	}
}
