package tui

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/process"
	"lixbon.com/cli/internal/remote"
	"lixbon.com/cli/internal/sse"
	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/toolparse"
	"lixbon.com/cli/internal/tools"
	"lixbon.com/cli/internal/workspace"
)

type (
	remoteMsg struct {
		link *remote.Link
		cmd  remote.Command
	}
	remoteClosedMsg struct{ link *remote.Link }
)

// remoteCapabilities es lo que la app puede mandarle a este host y lo que
// este host le cuenta además del transcript (razonamiento, contexto, compact,
// preguntas del agente con respuesta libre).
var remoteCapabilities = []string{"attachments", "images", "mentions", "files", "config", "reasoning", "context", "compact", "questions"}

// remoteBlocked son los comandos que desde la app dejarían la sesión sin host
// o actúan sobre cosas del equipo que el móvil no ve.
var remoteBlocked = map[string]string{
	"exit":     "cerraría el CLI y con él esta sesión remota",
	"remote":   "el control remoto ya está activo",
	"login":    "la sesión se inicia en la terminal",
	"logout":   "cerraría la sesión que usa el control remoto",
	"key":      "la API key se cambia en la terminal",
	"provider": "cambiar de proveedor cortaría el control remoto",
	"update":   "la actualización reinicia el CLI",
	"config":   "el menú de ajustes se maneja en la terminal",
	"copy":     "usa el portapapeles del equipo",
	"paste":    "usa el portapapeles del equipo",
}

const (
	remoteWidth     = 64
	remoteDiffChars = 6000
	remoteLogMax    = 300
	remoteFileHits  = 30
	remoteImageDir  = "lixbon-remote"
	remoteImageTTL  = 24 * time.Hour
	remoteThinkMax  = 6000
	remoteListLines = 20
	remoteDiffRows  = 240
)

// internalPrompts son mensajes de usuario que el agente se inyecta a sí mismo:
// en el móvil parecerían escritos por la persona.
var internalPrompts = []string{
	agent.NudgePrompt, agent.NativeNudgePrompt, agent.NoOutputPrompt,
	agent.TruncatedPrompt, agent.ToolImagesPrompt,
}

// remoteHost es el control remoto activo. Lo que ve el móvil se guarda aquí
// (log) para reenviarlo entero a un controller que se une: el historial del
// chat no tiene las herramientas ni los avisos.
type remoteHost struct {
	link     *remote.Link
	approver agent.Approver
	askUser  func(ctx context.Context, question string, options []string) (string, bool)
	onTodo   func(items, previous []tools.TodoItem)

	mu        sync.Mutex
	base      []map[string]any
	log       []map[string]any
	questions map[string]chan string
	lastCtx   string

	// live es el sink del turno en curso: la salida de los comandos llega
	// desde la goroutine del proceso.
	live atomic.Pointer[remoteSink]

	// Solo los toca la goroutine de la interfaz.
	helloKey string
	choices  map[string]*picker
	pending  *[2]string // nombre y argumentos del comando remoto en segundo plano
	carry    []*entry
	next     remotePrompt
	queued   []remotePrompt
	sink     *remoteSink
}

// remotePrompt es un mensaje del móvil ya preparado: message es lo que va al
// modelo (con documentos y menciones) y text, lo que escribió la persona.
type remotePrompt struct {
	text, message string
	images        []string
	mentions      []string
	chips         []imageChip
}

func (h *remoteHost) snapshotNow() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	messages := slices.Concat(h.base, h.log)
	return messages[max(0, len(messages)-150):]
}

func (h *remoteHost) reset() {
	h.mu.Lock()
	h.base, h.log = nil, nil
	h.mu.Unlock()
}

// emit publica un evento y lo apunta en el log si forma parte del transcript.
func (h *remoteHost) emit(kind string, fields map[string]any) {
	h.link.Emit(kind, fields)
	h.record(kind, fields)
}

func (h *remoteHost) record(kind string, fields map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	str := func(k string) string { s, _ := fields[k].(string); return s }
	var item map[string]any
	switch kind {
	case "user_msg":
		item = map[string]any{"role": "user", "content": str("text"), "images": fields["images"], "mentions": fields["mentions"]}
	case "assistant_done", "assistant_prose":
		if strings.TrimSpace(str("text")) != "" {
			item = map[string]any{"role": "assistant", "content": str("text")}
			if kind == "assistant_done" {
				item["final"], item["ms"], item["interrupted"] = true, fields["ms"], fields["interrupted"]
			}
		}
	case "reasoning":
		item = map[string]any{"role": "thinking", "content": str("text"), "ms": fields["ms"]}
	case "question_answered":
		item = map[string]any{"role": "qa", "question": str("question"), "content": str("answer")}
	case "compacted":
		item = map[string]any{"role": "compacted", "content": str("summary"), "before": fields["before"], "after": fields["after"]}
	case "notice":
		item = map[string]any{"role": "notice", "content": str("text")}
	case "error":
		item = map[string]any{"role": "error", "content": str("message")}
	case "command_result":
		item = map[string]any{"role": "command", "name": fields["name"], "args": fields["args"], "rows": fields["rows"], "text": fields["text"], "diff": fields["diff"]}
	case "tool_use":
		item = map[string]any{"role": "tool", "pending": true}
		for k, v := range fields {
			item[k] = v
		}
	case "tool_result":
		for i := len(h.log) - 1; i >= 0; i-- {
			if h.log[i]["role"] == "tool" && h.log[i]["id"] == fields["id"] {
				h.log[i]["pending"] = false
				h.log[i]["content"] = fields["result"]
				h.log[i]["ok"] = fields["error"] != true
				for _, k := range []string{"ms", "exit", "lines", "meta"} {
					if v, ok := fields[k]; ok {
						h.log[i][k] = v
					}
				}
				return
			}
		}
	}
	if item != nil {
		h.log = append(h.log, item)
		if len(h.log) > remoteLogMax {
			h.log = h.log[len(h.log)-remoteLogMax:]
		}
	}
}

func (h *remoteHost) notice(text string) { h.emit("notice", map[string]any{"text": text}) }

// ── aprobaciones ─────────────────────────────────────────────────────────

// remoteApprover manda las aprobaciones al móvil, con el diff si es una
// edición, y espera allí la decisión.
type remoteApprover struct{ link *remote.Link }

func (a *remoteApprover) Approve(ctx context.Context, req agent.Approval) (agent.Decision, error) {
	risk := "command"
	if req.Kind == agent.ApproveEdit {
		risk = "edit"
	}
	request := map[string]any{"tool": req.Tool, "summary": firstNonEmpty(req.Summary, req.Tool), "risk": risk}
	if req.Change != nil {
		for k, v := range changeFields(*req.Change) {
			request[k] = v
		}
	}
	if a.link.RequestApproval(ctx, request) {
		return agent.Allow, nil
	}
	select {
	case <-a.link.Done():
		return agent.Deny, errRemoteGone
	default:
	}
	return agent.Deny, ctx.Err()
}

var errRemoteGone = errors.New("el control remoto se cerró")

// ── preguntas del agente (ask_user) ──────────────────────────────────────

// ask pregunta a la vez en la terminal y en el móvil, como las aprobaciones:
// vale la primera respuesta y la otra pregunta se retira. En el hilo de la
// app queda constancia de lo que se respondió.
func (h *remoteHost) ask(ctx context.Context, question string, options []string) (string, bool) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type reply struct {
		answer string
		ok     bool
	}
	askers := []func(context.Context, string, []string) (string, bool){h.askRemote}
	if h.askUser != nil {
		askers = append(askers, h.askUser)
	}
	replies := make(chan reply, len(askers))
	for _, ask := range askers {
		go func() {
			answer, ok := ask(ctx, question, options)
			replies <- reply{answer, ok}
		}()
	}
	r := <-replies
	if r.ok {
		h.emit("question_answered", map[string]any{"question": question, "answer": r.answer})
	}
	return r.answer, r.ok
}

// askRemote abre la pregunta en la app: elige una opción o escribe otra
// respuesta. Vacío equivale a cancelar.
func (h *remoteHost) askRemote(ctx context.Context, question string, options []string) (string, bool) {
	id := remote.NewID()
	waiter := make(chan string, 1)
	h.mu.Lock()
	h.questions[id] = waiter
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.questions, id)
		h.mu.Unlock()
	}()
	choices := make([]map[string]string, 0, len(options))
	for _, o := range options {
		choices = append(choices, map[string]string{"label": o, "value": o})
	}
	h.link.Emit("choice_request", map[string]any{"id": id, "kind": "question", "title": question, "options": choices, "free": true})
	select {
	case answer := <-waiter:
		h.link.Emit("choice_resolved", map[string]any{"id": id, "value": answer})
		return answer, strings.TrimSpace(answer) != ""
	case <-ctx.Done():
		h.link.Emit("choice_resolved", map[string]any{"id": id})
		return "", false
	case <-h.link.Done():
		return "", false
	}
}

// answer entrega la respuesta del móvil a una pregunta abierta.
func (h *remoteHost) answer(id, value string) bool {
	h.mu.Lock()
	waiter := h.questions[id]
	h.mu.Unlock()
	if waiter == nil {
		return false
	}
	select {
	case waiter <- value:
	default:
	}
	return true
}

// sharedApprover pregunta a la vez en la terminal y en el móvil: vale la
// primera respuesta y la otra pregunta se retira.
type sharedApprover struct{ local, remote agent.Approver }

func (a sharedApprover) Approve(ctx context.Context, req agent.Approval) (agent.Decision, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type answer struct {
		d   agent.Decision
		err error
	}
	answers := make(chan answer, 2)
	for _, ap := range []agent.Approver{a.local, a.remote} {
		go func() {
			d, err := ap.Approve(ctx, req)
			answers <- answer{d, err}
		}()
	}
	first := <-answers
	if first.err != nil && ctx.Err() == nil {
		first = <-answers
	}
	return first.d, first.err
}

// changeFields describe una edición para el móvil: ruta, líneas y diff.
func changeFields(c agent.Change) map[string]any {
	adds, dels := agent.DiffCounts(c)
	var b strings.Builder
	for _, r := range agent.DiffRows(c, 2) {
		switch r.Kind {
		case "add":
			b.WriteString("+" + r.Text + "\n")
		case "del":
			b.WriteString("-" + r.Text + "\n")
		case "gap":
			b.WriteString("@@\n")
		default:
			b.WriteString(" " + r.Text + "\n")
		}
	}
	return map[string]any{"path": c.Path, "adds": adds, "dels": dels, "diff": textutil.Head(b.String(), remoteDiffChars), "rows": diffRows(c)}
}

// diffRows es el diff para la app: solo lo que cambia con una línea de
// contexto a cada lado, cada fila [tipo, nº de línea, texto]. Un salto ("g")
// lleva en el número cuántas líneas sin cambios se omiten.
func diffRows(c agent.Change) [][]any {
	rows := agent.DiffRows(c, 1)
	out := make([][]any, 0, min(len(rows), remoteDiffRows))
	for i, r := range rows {
		if len(out) == remoteDiffRows {
			break
		}
		switch r.Kind {
		case "add":
			out = append(out, []any{"a", r.NewNo, textutil.Head(r.Text, 240)})
		case "del":
			out = append(out, []any{"d", r.OldNo, textutil.Head(r.Text, 240)})
		case "gap":
			skipped := 0
			if i > 0 && i+1 < len(rows) {
				skipped = max(0, rows[i+1].OldNo-rows[i-1].OldNo-1)
			}
			out = append(out, []any{"g", skipped, ""})
		default:
			out = append(out, []any{"c", r.NewNo, textutil.Head(r.Text, 240)})
		}
	}
	return out
}

// ── turno ────────────────────────────────────────────────────────────────

// remoteSink reenvía al móvil lo que ocurre durante un turno, además de
// pintarlo en la terminal. En modo agent la prosa llega mezclada con el JSON
// de las llamadas: se manda limpia, como la ve la terminal.
type remoteSink struct {
	chat.Sink
	host    *remoteHost
	agent   bool
	started time.Time
	// context mide la ventana ocupada; se llama desde la goroutine del turno.
	context func() map[string]any

	mu     sync.Mutex
	raw    strings.Builder
	base   string
	sent   string
	toolID string
	// readID es la última lectura: llega ya hecha y solo recibe resultado si
	// falla, así que no queda abierta como toolID.
	readID, readTool string
	activity         string
	thinking         strings.Builder
	thinkSince       time.Time
	// output es la línea a medias de la salida del comando en curso.
	output []byte
}

// setActivity le dice al móvil qué hace ahora el agente (pensando,
// escribiendo, ejecutando algo); solo se manda cuando cambia.
func (s *remoteSink) setActivity(activity, tool, label string) {
	if key := activity + "|" + tool + "|" + label; key != s.activity {
		s.activity = key
		s.host.link.Emit("status", map[string]any{"state": "thinking", "activity": activity, "tool": tool, "label": label})
	}
}

func (s *remoteSink) prose() string {
	text := s.raw.String()
	if s.agent {
		text = toolparse.CleanProse(text)
	}
	if text == "" {
		return strings.TrimSuffix(s.base, "\n\n")
	}
	return s.base + text
}

func (s *remoteSink) Delta(kind sse.Kind, text string) {
	s.Sink.Delta(kind, text)
	s.mu.Lock()
	defer s.mu.Unlock()
	if kind == sse.Reasoning {
		s.setActivity("reasoning", "", "")
		if s.thinking.Len() == 0 {
			s.thinkSince = time.Now()
		}
		if s.thinking.Len() < remoteThinkMax {
			s.thinking.WriteString(text)
			s.host.link.Emit("reasoning_delta", map[string]any{"text": text})
		}
		return
	}
	if kind != sse.Content {
		return
	}
	s.raw.WriteString(text)
	prose := s.prose()
	if prose == s.sent {
		return
	}
	s.endThinking()
	s.setActivity("writing", "", "")
	if rest, ok := strings.CutPrefix(prose, s.sent); ok {
		s.host.link.Emit("assistant_delta", map[string]any{"text": rest})
	} else {
		s.host.link.Emit("assistant_replace", map[string]any{"text": prose})
	}
	s.sent = prose
}

// endThinking cierra el razonamiento del paso con lo que duró: queda en el
// hilo del móvil como «Pensó N s».
func (s *remoteSink) endThinking() {
	text := strings.TrimSpace(s.thinking.String())
	s.thinking.Reset()
	if text == "" {
		return
	}
	s.host.emit("reasoning", map[string]any{"text": textutil.Head(text, remoteThinkMax), "ms": time.Since(s.thinkSince).Milliseconds()})
}

// closeStep cierra la prosa del paso. Antes de una herramienta, la burbuja del
// móvil se cierra (y se apunta para el snapshot); entre pasos sin herramienta,
// lo siguiente continúa la misma burbuja.
func (s *remoteSink) closeStep(beforeTool bool) {
	s.endThinking()
	s.raw.Reset()
	switch {
	case beforeTool && s.sent != "":
		s.host.record("assistant_prose", map[string]any{"text": s.sent})
		s.base, s.sent = "", ""
	case beforeTool:
		s.base = ""
	case s.sent != "":
		s.base = s.sent + "\n\n"
	}
}

func (s *remoteSink) Note(text string) {
	s.Sink.Note(text)
	s.host.notice(text)
}

func (s *remoteSink) Event(e agent.Event) {
	s.Sink.Event(e)
	s.mu.Lock()
	defer s.mu.Unlock()
	switch e.Kind {
	case agent.EventStep:
		s.closeStep(false)
		s.setActivity("working", "", "")
		if s.context != nil {
			s.host.emitContext(s.context())
		}
	case agent.EventNote:
		s.closeStep(true)
		s.host.notice(e.Text)
	case agent.EventAction:
		s.closeStep(true)
		id := remote.NewID()
		fields := map[string]any{"id": id, "tool": e.Tool, "summary": e.Text, "readonly": e.ReadOnly}
		if e.Change != nil {
			for k, v := range changeFields(*e.Change) {
				fields[k] = v
			}
		}
		s.host.emit("tool_use", fields)
		// Las de solo lectura llegan ya hechas: solo traen resultado si fallan.
		if e.ReadOnly {
			result := map[string]any{"id": id, "tool": e.Tool, "result": e.Meta, "meta": e.Meta, "error": false}
			if lines := listLines(e.Tool, e.Result); len(lines) > 0 {
				result["lines"] = lines
			}
			s.host.emit("tool_result", result)
			s.toolID, s.readID, s.readTool = "", id, e.Tool
			s.setActivity("working", "", "")
		} else {
			s.toolID, s.readID, s.output = id, "", nil
			s.setActivity("tool", e.Tool, textutil.Head(e.Text, 120))
		}
	case agent.EventActionResult:
		id := s.toolID
		if id == "" && s.readID != "" && e.Tool == s.readTool {
			id = s.readID
		}
		if id == "" {
			id = remote.NewID()
		}
		s.flushOutput(true)
		s.toolID, s.readID = "", ""
		s.setActivity("working", "", "")
		result := firstNonEmpty(e.Result, e.Summary)
		fields := map[string]any{"id": id, "tool": e.Tool, "error": e.Failed}
		if e.Elapsed > 0 {
			fields["ms"] = e.Elapsed.Milliseconds()
		}
		if e.Tool == "run_command" {
			if code, rest, ok := exitCode(result); ok {
				fields["exit"], result = code, rest
			}
		}
		fields["result"] = textutil.Head(result, remote.ResultChars)
		s.host.emit("tool_result", fields)
	case agent.EventReadGroup:
		s.closeStep(true)
		id := remote.NewID()
		s.host.emit("tool_use", map[string]any{"id": id, "tool": "read_file", "summary": strings.Join(e.Names, ", "), "readonly": true})
		meta := fmt.Sprintf("%d líneas", e.Lines)
		s.host.emit("tool_result", map[string]any{"id": id, "tool": "read_file", "result": meta, "meta": meta, "error": false})
	}
}

// exitCode separa el «[EXIT n]» con que run_command abre su resultado; un
// timeout cuenta como -1.
func exitCode(result string) (int, string, bool) {
	if rest, ok := strings.CutPrefix(result, "[TIMEOUT]"); ok {
		return -1, strings.TrimSpace(rest), true
	}
	rest, ok := strings.CutPrefix(result, "[EXIT ")
	if !ok {
		return 0, result, false
	}
	num, rest, ok := strings.Cut(rest, "]")
	code, err := strconv.Atoi(num)
	if !ok || err != nil {
		return 0, result, false
	}
	return code, strings.TrimSpace(rest), true
}

// listLines son las primeras filas de una búsqueda o un listado, para
// desplegarlas en la app (ruta:línea o el nombre de cada entrada).
func listLines(tool, result string) []string {
	switch tool {
	case "search", "search_codebase", "find_files", "list_files", "grep", "glob":
	default:
		return nil
	}
	var out []string
	for line := range strings.SplitSeq(result, "\n") {
		if line = strings.TrimRight(line, " \r"); strings.TrimSpace(line) == "" {
			continue
		}
		if len(out) == remoteListLines {
			break
		}
		out = append(out, textutil.Head(line, 200))
	}
	return out
}

// outputChunk recibe la salida cruda del comando en curso y manda a la app las
// líneas completas (una barra de progreso con \r se queda con lo último).
func (s *remoteSink) outputChunk(chunk []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.toolID == "" {
		return
	}
	s.output = append(s.output, chunk...)
	s.flushOutput(false)
}

func (s *remoteSink) flushOutput(all bool) {
	data := s.output
	cut := len(data)
	if !all {
		cut = strings.LastIndexByte(string(data), '\n') + 1
	}
	if cut <= 0 || s.toolID == "" {
		if all {
			s.output = nil
		}
		return
	}
	var lines []string
	for line := range strings.SplitSeq(string(data[:cut]), "\n") {
		if i := strings.LastIndexByte(line, '\r'); i >= 0 && i < len(line)-1 {
			line = line[i+1:]
		}
		if text := process.DecodeOutput([]byte(line)); text != "" {
			lines = append(lines, textutil.Head(text, 300))
		}
	}
	s.output = append([]byte(nil), data[cut:]...)
	if len(lines) > 0 {
		s.host.link.Emit("tool_output", map[string]any{"id": s.toolID, "text": strings.Join(lines, "\n") + "\n"})
	}
}

// bubble es el texto final de la última burbuja: lo que ya vio escribirse más
// la respuesta, si esta no salió en vivo (un aviso del propio CLI).
func (s *remoteSink) bubble(answer string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	text := s.sent
	if answer = strings.TrimSpace(answer); answer != "" && !strings.Contains(text, answer) {
		if text != "" {
			text += "\n\n"
		}
		text += answer
	}
	return text
}

// finish cierra el razonamiento y la herramienta que el turno dejó a medias
// (cancelado o error).
func (s *remoteSink) finish() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.endThinking()
	if s.toolID != "" {
		s.host.emit("tool_result", map[string]any{"id": s.toolID, "result": "interrumpido", "error": true})
		s.toolID = ""
	}
}

// emitContext manda la ventana ocupada si cambió el porcentaje entero.
func (h *remoteHost) emitContext(fields map[string]any) {
	key := fmt.Sprint(fields["pct"], "/", fields["window"])
	h.mu.Lock()
	changed := key != h.lastCtx
	h.lastCtx = key
	h.mu.Unlock()
	if changed {
		h.emit("context", fields)
	}
}

// remoteContext es la ventana de contexto ocupada, repartida como la app la
// enseña: conversación, resultados de herramientas y lo fijo (sistema y
// herramientas, que no cuenta para compactar).
func remoteContext(c *chat.Chat) map[string]any {
	tokens, files, system, window := c.ContextParts()
	pct := func(n int) int { return int(float64(n)*100/float64(window) + 0.5) }
	return map[string]any{
		"tokens": tokens, "window": window, "pct": min(100, pct(tokens)),
		"files": files, "system": system, "auto": int(history.AutoCompactRatio * 100),
	}
}

func (m *Model) remoteTurnStarted(prompt string, chips []imageChip) {
	h := m.remote
	text, images, mentions := prompt, len(chips), []string{}
	if m.remoteOrigin && (h.next.text != "" || len(h.next.images) > 0) {
		text, images, mentions = h.next.text, len(h.next.images), h.next.mentions
	}
	h.next = remotePrompt{}
	origin := "local"
	if m.remoteOrigin {
		origin = "remote"
	}
	h.emit("user_msg", map[string]any{"text": text, "origin": origin, "images": images, "mentions": mentions})
	h.link.Emit("status", map[string]any{"state": "thinking"})
}

func (m *Model) remoteTurnDone(msg doneMsg, cancelled bool) {
	h := m.remote
	sink := h.sink
	h.sink = nil
	h.live.Store(nil)
	if sink != nil {
		sink.finish()
	}
	switch {
	case msg.err != nil && !cancelled:
		h.emit("error", map[string]any{"message": msg.err.Error()})
	default:
		display := strings.TrimSpace(msg.answer)
		if m.turnMode == chat.ModeAgent {
			display = toolparse.CleanProse(msg.answer)
		}
		done := map[string]any{"text": display, "interrupted": cancelled}
		if sink != nil {
			done["text"] = sink.bubble(display)
			done["ms"] = time.Since(sink.started).Milliseconds()
		}
		h.emit("assistant_done", done)
	}
	h.emitContext(remoteContext(m.chat))
	h.link.Emit("status", map[string]any{"state": "idle"})
}

// ── sesión ───────────────────────────────────────────────────────────────

func (m *Model) cmdRemote(arg string) tea.Cmd {
	switch strings.ToLower(arg) {
	case "", "start":
	case "stop", "status":
		m.add(note("El control remoto se activa con /remote y se termina con Ctrl+C dentro del modo remoto."))
		return nil
	default:
		m.add(errLine("Uso: /remote — inicia el control remoto desde tu app móvil"))
		return nil
	}
	switch {
	case m.remote != nil:
		m.add(note("El control remoto ya está activo."))
		return nil
	case m.chat.Cfg.APIKey == "":
		m.add(errLine("Necesitas una sesión activa (/login) para usar /remote."))
		return nil
	}
	title := firstNonEmpty(filepath.Base(m.chat.Workspace), "workspace")
	machine, _ := os.Hostname()
	machine = firstNonEmpty(machine, "PC")
	link := remote.NewLink(m.chat.Client, "cli", title, machine)
	hello := m.remoteHello()
	return m.async("creando sesión remota", func(ctx context.Context) cmdDoneMsg {
		if err := link.Start(ctx, hello); err != nil {
			return cmdDoneMsg{lines: []block{errLine("No se pudo iniciar el control remoto: " + err.Error())}}
		}
		qr := link.QR(ctx)
		return cmdDoneMsg{apply: func(m *Model) { m.enterRemote(link, title, machine, qr) }}
	})
}

// remoteHello es lo que la app necesita saber del host: comandos, qué puede
// recibir y el modelo, el modo y el razonamiento vigentes.
func (m *Model) remoteHello() map[string]any {
	var commands []map[string]string
	for _, s := range m.allSpecs() {
		if _, blocked := remoteBlocked[s.Name]; blocked {
			continue
		}
		group := s.Group
		if group != "" {
			group = strings.ToUpper(group[:1]) + group[1:]
		}
		commands = append(commands, map[string]string{"name": s.Name, "args": s.Args, "description": s.Desc, "group": group})
	}
	models := []map[string]string{}
	for _, mod := range m.opts.Account.Models {
		models = append(models, map[string]string{"value": mod.ID, "label": firstNonEmpty(mod.Name, mod.ID)})
	}
	efforts := []string{}
	for _, l := range effortLevels(m.chat.Model) {
		efforts = append(efforts, firstNonEmpty(l, "auto"))
	}
	return map[string]any{
		"agent": "lixbon", "workspace": filepath.Base(m.chat.Workspace),
		"mode": m.modeName(), "model": firstNonEmpty(m.chat.Model, "sin modelo"),
		"commands": commands, "capabilities": remoteCapabilities,
		"models": models, "model_value": m.chat.Model,
		"efforts": efforts, "effort": firstNonEmpty(m.chat.Effort, "auto"),
	}
}

// syncRemote republica el hello si cambió el modelo, el modo o el
// razonamiento, y retira del móvil los selectores que ya se cerraron aquí.
func (m *Model) syncRemote() {
	h := m.remote
	if h == nil {
		return
	}
	for id, p := range h.choices {
		if m.picker != p {
			delete(h.choices, id)
			h.link.Emit("choice_resolved", map[string]any{"id": id})
		}
	}
	key := strings.Join([]string{m.modeName(), m.chat.Model, m.chat.Effort, m.chat.Workspace, fmt.Sprint(len(m.chat.Custom))}, "|")
	if key != h.helloKey {
		h.helloKey = key
		h.link.Emit("hello", m.remoteHello())
	}
}

func (m *Model) enterRemote(link *remote.Link, title, machine, qr string) {
	host := &remoteHost{
		link: link, approver: m.chat.Session.Approver,
		askUser: m.chat.Toolbox.AskUser, onTodo: m.chat.Toolbox.OnTodo,
		choices: map[string]*picker{},
	}
	host.base = remoteHistory(m.chat.History)
	host.helloKey = strings.Join([]string{m.modeName(), m.chat.Model, m.chat.Effort, m.chat.Workspace, fmt.Sprint(len(m.chat.Custom))}, "|")
	m.remote = host
	link.Snapshot = host.snapshotNow

	m.chat.Session.Approver = sharedApprover{local: host.approver, remote: &remoteApprover{link: link}}
	host.questions = map[string]chan string{}
	m.chat.Toolbox.AskUser = host.ask
	m.chat.Toolbox.OnOutput = func(chunk []byte) {
		if s := host.live.Load(); s != nil {
			s.outputChunk(chunk)
		}
	}
	m.chat.Toolbox.OnTodo = func(items, previous []tools.TodoItem) {
		host.onTodo(items, previous)
		done := 0
		for _, it := range items {
			if it.Status == "done" {
				done++
			}
		}
		id := remote.NewID()
		host.emit("tool_use", map[string]any{"id": id, "tool": "todo", "summary": fmt.Sprintf("Plan: %d de %d pasos", done, len(items)), "readonly": true})
		host.emit("tool_result", map[string]any{"id": id, "tool": "todo", "result": todoSummary(items), "error": false})
	}

	m.gap()
	m.add(reportBlock{title: "Control remoto activo", rows: [][2]string{
		{"Sesión", sPrimary.Render(title) + sDim.Render(" en "+machine)},
		{"Link", sPlan.Render(link.ShareURL())},
	}})
	if qr != "" {
		m.print("")
		m.add(qrBlock(qr))
	}
	m.print("")
	m.add(note("La sesión ya aparece en la sección Remote de tu app Lixbon."))
	m.add(note("Sin la app, abre el link o despliega el QR: la sesión se abre en la web con tu cuenta."))
	m.add(note("Puedes seguir escribiendo aquí; las aprobaciones se piden en los dos sitios. Ctrl+C con la caja vacía termina el modo remoto."))
	m.print("")

	link.EmitSnapshot()
	host.emitContext(remoteContext(m.chat))
	link.Emit("status", map[string]any{"state": "idle"})
	send := m.send
	go func() {
		for cmd := range link.Inbox {
			send(remoteMsg{link, cmd})
		}
		send(remoteClosedMsg{link})
	}()
}

// remoteHistory es la conversación previa al remoto tal como la enseña la
// terminal: sin system, sin resultados internos ni recordatorios del agente.
func remoteHistory(msgs []history.Message) []map[string]any {
	var out []map[string]any
	for _, msg := range msgs {
		content := msg.Content
		switch {
		case msg.Role == "system" || msg.Role == "tool", history.IsSummary(msg):
			continue
		case msg.Role == "user" && (strings.HasPrefix(content, "TOOL_RESULT") || slices.Contains(internalPrompts, content)):
			continue
		case msg.Role == "assistant":
			if content = toolparse.CleanProse(content); content == "" {
				continue
			}
		}
		item := map[string]any{"role": msg.Role, "content": content}
		if len(msg.Images) > 0 {
			item["images"] = len(msg.Images)
		}
		out = append(out, item)
	}
	return out[max(0, len(out)-80):]
}

func todoSummary(items []tools.TodoItem) string {
	rows := make([]string, len(items))
	for i, it := range items {
		mark := "[ ]"
		if it.Status == "done" {
			mark = "[x]"
		}
		rows[i] = mark + " " + it.Text
	}
	return textutil.Head(strings.Join(rows, "\n"), remote.ResultChars)
}

// leaveRemote devuelve el teclado a la terminal. Cerrar la sesión puede tardar
// (red), así que no bloquea la interfaz.
func (m *Model) leaveRemote(endSession bool) {
	host := m.remote
	if host == nil {
		return
	}
	m.remote = nil
	m.chat.Session.Approver = host.approver
	m.chat.Toolbox.AskUser = host.askUser
	m.chat.Toolbox.OnTodo = host.onTodo
	m.chat.Toolbox.OnOutput = nil
	go host.link.Stop(endSession)
	m.gap()
	m.add(note("Control remoto terminado; la sesión vuelve a esta terminal."))
}

func (m *Model) onRemote(msg remoteMsg) tea.Cmd {
	if m.remote == nil || m.remote.link != msg.link {
		return nil
	}
	cmd := msg.cmd
	switch cmd.Type {
	case "prompt":
		return m.remotePrompt(cmd)
	case "files":
		m.remoteFiles(cmd.Query)
	case "config":
		var cmds []tea.Cmd
		if cmd.Model != "" {
			cmds = append(cmds, m.remoteCommand("/model "+cmd.Model))
		}
		if cmd.Effort != "" {
			cmds = append(cmds, m.remoteCommand("/effort "+cmd.Effort))
		}
		return tea.Batch(cmds...)
	case "choose":
		return m.remoteChoose(cmd.ID, cmd.Value)
	case "interrupt":
		if m.running {
			m.cancelTurn()
		}
	case "bye":
		m.leaveRemote(false)
	}
	return nil
}

func (m *Model) remotePrompt(cmd remote.Command) tea.Cmd {
	h := m.remote
	text := strings.TrimSpace(cmd.Text)
	switch {
	case text == "" && len(cmd.Attachments) == 0:
		return nil
	case strings.HasPrefix(text, "!") && len(cmd.Attachments) == 0:
		m.add(note("Se ignoró un «!» recibido por control remoto: los comandos manuales solo se escriben en esta terminal."))
		h.notice("Los comandos «!» solo se escriben en la terminal del equipo; pídeselo al agente o usa /run.")
		return nil
	case strings.HasPrefix(text, "/") && len(cmd.Attachments) == 0:
		if m.busyNow() {
			m.queue = append(m.queue, fromRemote+text)
			h.notice("«" + text + "» se ejecutará cuando termine lo que está en marcha.")
			return nil
		}
		return m.remoteCommand(text)
	}
	p := m.prepareRemotePrompt(text, cmd.Attachments, cmd.Mentions)
	if m.busyNow() {
		h.queued = append(h.queued, p)
		m.queue = append(m.queue, fromRemote+p.message)
		return nil
	}
	return m.startRemotePrompt(p)
}

func (m *Model) startRemotePrompt(p remotePrompt) tea.Cmd {
	m.remote.next = p
	m.chat.AttachNext(p.images...)
	m.remoteOrigin = true
	defer func() { m.remoteOrigin = false }()
	shown := p.message
	if i := strings.Index(shown, remoteDocsEnd); i >= 0 {
		shown = shown[i+len(remoteDocsEnd):]
	}
	cmd := m.startTurn(p.message, shown)
	if !m.running {
		m.chat.DropNextImages()
		m.remote.next = remotePrompt{}
	}
	return cmd
}

const remoteDocsEnd = "\n\n---\n\n"

// prepareRemotePrompt guarda las fotos en disco (el chat adjunta imágenes por
// ruta), pone los documentos delante y las menciones como @ruta.
func (m *Model) prepareRemotePrompt(text string, attachments []remote.Attachment, mentions []remote.Mention) remotePrompt {
	p := remotePrompt{text: text, mentions: []string{}}
	var docs []string
	for _, a := range attachments {
		switch a.Kind {
		case "image":
			saved, err := saveRemoteImage(a)
			if err != nil {
				m.remote.notice("No se pudo usar la imagen " + a.Name + ": " + err.Error())
				continue
			}
			p.images = append(p.images, saved)
			p.chips = append(p.chips, newImageChip(len(p.chips)+1, saved))
		case "doc":
			docs = append(docs, "--- Documento adjunto: "+a.Name+" ---\n"+a.Text)
		}
	}
	message := text
	for _, mention := range mentions {
		rel := filepath.ToSlash(mention.Rel)
		if rel == "" || !filepath.IsLocal(filepath.FromSlash(rel)) {
			continue
		}
		p.mentions = append(p.mentions, firstNonEmpty(mention.Name, path.Base(rel)))
		message += ` @"` + rel + `"`
	}
	switch {
	case len(docs) > 0:
		message = strings.Join(docs, "\n\n") + remoteDocsEnd + firstNonEmpty(strings.TrimSpace(message), "Analiza este documento.")
	case strings.TrimSpace(message) == "" && len(p.images) > 0:
		message = "Mira la imagen adjunta."
	}
	p.message = strings.TrimSpace(message)
	return p
}

func saveRemoteImage(a remote.Attachment) (string, error) {
	data, err := base64.StdEncoding.DecodeString(a.Base64[strings.IndexByte(a.Base64, ',')+1:])
	if err != nil {
		return "", errors.New("la imagen no llegó entera")
	}
	dir := filepath.Join(os.TempDir(), remoteImageDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if old, err := os.ReadDir(dir); err == nil {
		for _, e := range old {
			if info, err := e.Info(); err == nil && time.Since(info.ModTime()) > remoteImageTTL {
				os.Remove(filepath.Join(dir, e.Name()))
			}
		}
	}
	ext := map[string]string{"image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/jpeg": ".jpg"}[strings.ToLower(a.Mime)]
	name := strings.TrimSuffix(filepath.Base(a.Name), filepath.Ext(a.Name))
	if ext == "" {
		ext = strings.ToLower(filepath.Ext(a.Name))
		if !slices.Contains(imageExts, ext) {
			ext = ".jpg"
		}
	}
	name = strings.Map(func(r rune) rune {
		if r == '/' || r == '\\' || r == ':' || r < ' ' {
			return '_'
		}
		return r
	}, textutil.Head(firstNonEmpty(name, "foto"), 60))
	file := filepath.Join(dir, remote.NewID()+"-"+name+ext)
	return file, os.WriteFile(file, data, 0o600)
}

// remoteFiles contesta a la búsqueda de @archivos de la app.
func (m *Model) remoteFiles(query string) {
	items := []map[string]string{}
	for _, it := range m.fileItems(query) {
		if it.dir {
			continue
		}
		items = append(items, map[string]string{
			"name": path.Base(it.label), "rel": it.label,
			"path": filepath.Join(m.chat.Workspace, filepath.FromSlash(it.label)),
		})
		if len(items) == remoteFileHits {
			break
		}
	}
	m.remote.link.Emit("files", map[string]any{"query": query, "items": items})
}

// ── comandos ─────────────────────────────────────────────────────────────

// remoteCommand ejecuta un comando «/» llegado del móvil con el mismo código
// que si se escribiera aquí: la terminal lo enseña y su salida vuelve a la
// app. Los selectores se ofrecen en el móvil para elegir desde allí.
func (m *Model) remoteCommand(text string) tea.Cmd {
	h := m.remote
	name, arg, _ := strings.Cut(strings.TrimPrefix(text, "/"), " ")
	name, arg = strings.ToLower(strings.TrimSpace(name)), strings.TrimSpace(arg)

	if _, ok := m.spec(name); !ok && m.chat.Custom[name].Body == "" {
		var near []string
		for _, s := range m.allSpecs() {
			if _, blocked := remoteBlocked[s.Name]; !blocked && strings.HasPrefix(s.Name, name) {
				near = append(near, s.Name)
			}
		}
		switch {
		case len(near) == 1:
			name = near[0]
		case len(near) > 1:
			h.notice("«/" + name + "» es ambiguo: /" + strings.Join(near, ", /") + ".")
			return nil
		default:
			h.notice("Comando desconocido: /" + name + ". /help muestra los disponibles.")
			return nil
		}
	}
	if reason, blocked := remoteBlocked[name]; blocked {
		h.notice("/" + name + " no se puede usar desde la app: " + reason + ".")
		return nil
	}

	label := strings.TrimSpace("/" + name + " " + arg)
	m.gap()
	m.add(echoBlock(label + "  [remoto]"))
	if custom, ok := m.chat.Custom[name]; ok {
		if _, builtin := m.spec(name); !builtin {
			m.remoteOrigin = true
			defer func() { m.remoteOrigin = false }()
			return m.startTurn(workspace.Expand(custom.Body, arg), "")
		}
	}
	return m.remoteRun(name, arg, func() tea.Cmd { return m.runCommand(name, arg) })
}

// remoteRun ejecuta run y manda a la app lo que añadió al transcript: la
// terminal lo pinta como siempre. Si abre un selector se ofrece en el móvil;
// si sigue en segundo plano, el resultado se manda entero al acabar.
func (m *Model) remoteRun(name, arg string, run func() tea.Cmd) tea.Cmd {
	h := m.remote
	start := len(m.log.entries)
	before, wasBusy, wasRunning := m.picker, m.busy != "", m.running
	m.remoteOrigin = true
	cmd := run()
	m.remoteOrigin = false
	if m.remote != h {
		return cmd
	}
	entries := h.carry
	h.carry = nil
	if start <= len(m.log.entries) {
		entries = append(entries, m.log.entries[start:]...)
	}
	if !wasBusy && m.busy != "" {
		h.carry, h.pending = entries, &[2]string{name, arg}
		h.link.Emit("status", map[string]any{"state": "thinking", "activity": "command", "label": strings.TrimSpace("/" + name + " " + arg)})
		return cmd
	}

	result := remoteResult(entries)
	opened := m.picker != nil && m.picker != before
	if opened {
		if p := m.picker; p.content != nil {
			result.text = strings.TrimSpace(strings.Join(append([]string{result.text}, stripLines(p.content(remoteWidth))...), "\n"))
			m.picker = nil
			opened = false
		} else if p.onKey != nil {
			m.picker = nil
			opened = false
			result.text = strings.TrimSpace(result.text + "\nEste selector solo se maneja en la terminal: pásale el valor, p. ej. /" + name + " <valor>.")
		}
	}
	turn := !wasRunning && m.running
	if result.text != "" || len(result.rows) > 0 || (!opened && !turn) {
		if result.text == "" && len(result.rows) == 0 {
			result.text = "Hecho."
		}
		h.emit("command_result", map[string]any{"name": name, "args": arg, "rows": result.rows, "text": result.text, "diff": result.diff})
	}
	if opened {
		m.offerChoice(m.picker)
	}
	if !m.busyNow() {
		h.link.Emit("status", map[string]any{"state": "idle"})
	}
	m.syncRemote()
	return cmd
}

// finishRemoteAsync entrega a la app el final de un comando remoto que siguió
// en segundo plano.
func (m *Model) finishRemoteAsync(show func() tea.Cmd) (tea.Cmd, bool) {
	if m.remote == nil || m.remote.pending == nil {
		return nil, false
	}
	pending := *m.remote.pending
	m.remote.pending = nil
	return m.remoteRun(pending[0], pending[1], show), true
}

// offerChoice manda un selector abierto a la app. Sigue abierto aquí: vale la
// primera respuesta, como en las aprobaciones.
func (m *Model) offerChoice(p *picker) {
	h := m.remote
	id := remote.NewID()
	h.choices[id] = p
	options := make([]map[string]string, 0, len(p.options))
	for _, o := range p.options {
		options = append(options, map[string]string{
			"label": ansi.Strip(o.Label), "value": o.Value,
			"description": ansi.Strip(o.Desc), "badge": ansi.Strip(o.Badge),
		})
	}
	h.link.Emit("choice_request", map[string]any{
		"id": id, "title": ansi.Strip(p.title), "body": strings.Join(stripLines(p.body), "\n"),
		"options": options, "cancel": p.cancel,
	})
}

// remoteChoose aplica la opción elegida en la app al selector que sigue
// abierto en la terminal.
func (m *Model) remoteChoose(id, value string) tea.Cmd {
	h := m.remote
	if h.answer(id, value) {
		return nil
	}
	p := h.choices[id]
	delete(h.choices, id)
	if p == nil || m.picker != p {
		h.link.Emit("choice_resolved", map[string]any{"id": id})
		h.notice("Ese selector ya se cerró en la terminal.")
		return nil
	}
	h.link.Emit("choice_resolved", map[string]any{"id": id, "value": value})
	cancelled := value == ""
	if cancelled {
		value = p.cancel
	}
	return m.remoteRun(ansi.Strip(p.title), "", func() tea.Cmd {
		m.picker = nil
		return p.done(value, cancelled)
	})
}

type remoteOutput struct {
	rows []map[string]string
	text string
	diff bool
}

// remoteResult pasa a texto plano lo que imprimió un comando; las tablas van
// como filas y los diffs con sus +/-.
func remoteResult(entries []*entry) remoteOutput {
	var out remoteOutput
	var lines []string
	for _, e := range entries {
		switch v := e.b.(type) {
		case reportBlock:
			if v.title != "" {
				lines = append(lines, ansi.Strip(v.title))
			}
			for _, r := range v.rows {
				out.rows = append(out.rows, map[string]string{"label": ansi.Strip(r[0]), "detail": ansi.Strip(r[1])})
			}
			lines = append(lines, stripLines(v.foot)...)
		case *toolBlock:
			if v.diff == nil {
				lines = append(lines, stripLines(strings.Split(v.render(remoteWidth, true), "\n"))...)
				continue
			}
			out.diff = true
			lines = append(lines, fmt.Sprintf("%s  +%d -%d", v.target, v.adds, v.dels))
			for _, r := range v.diff.rows {
				switch r.Kind {
				case "add":
					lines = append(lines, "+"+r.Text)
				case "del":
					lines = append(lines, "-"+r.Text)
				case "gap":
					lines = append(lines, "@@")
				default:
					lines = append(lines, " "+r.Text)
				}
			}
		default:
			lines = append(lines, stripLines(strings.Split(e.b.render(remoteWidth, true), "\n"))...)
		}
	}
	out.text = textutil.Head(strings.Trim(strings.Join(lines, "\n"), "\n"), remoteDiffChars*2)
	return out
}

func stripLines(lines []string) []string {
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		out = append(out, strings.TrimRight(ansi.Strip(l), " "))
	}
	return out
}

// fromRemote marca en la cola los mensajes que llegaron del móvil o la web.
const fromRemote = "\x00remoto\x00"

// dispatchQueued envía el siguiente mensaje de la cola con su origen.
func (m *Model) dispatchQueued() tea.Cmd {
	next := m.queue[0]
	m.queue = m.queue[1:]
	text, fromPhone := strings.CutPrefix(next, fromRemote)
	if !fromPhone || m.remote == nil {
		return m.dispatch(text)
	}
	if strings.HasPrefix(text, "/") {
		return m.remoteCommand(text)
	}
	h := m.remote
	p := remotePrompt{text: text, message: text}
	if len(h.queued) > 0 && h.queued[0].message == text {
		p, h.queued = h.queued[0], h.queued[1:]
	}
	return m.startRemotePrompt(p)
}

// remoteEndKey: con el control remoto activo la terminal sigue escribiendo
// mensajes; Ctrl+C con la caja vacía y sin turno en marcha lo termina.
func (m *Model) remoteEndKey(msg tea.KeyPressMsg) bool {
	if m.remote == nil || msg.String() != "ctrl+c" || m.running || m.picker != nil || m.prompt != nil ||
		strings.TrimSpace(m.input.Value()) != "" {
		return false
	}
	m.leaveRemote(true)
	return true
}
