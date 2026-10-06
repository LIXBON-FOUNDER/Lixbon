package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/tools"
)

// fakeModel devuelve las respuestas que se le den, en orden, y recuerda lo
// que recibió.
type fakeModel struct {
	replies   []StreamResult
	errs      map[int]error
	calls     [][]history.Message
	toolLists [][]map[string]any
}

func (f *fakeModel) stream(ctx context.Context, messages []history.Message, toolList []map[string]any) (StreamResult, error) {
	n := len(f.calls)
	f.calls = append(f.calls, append([]history.Message{}, messages...))
	f.toolLists = append(f.toolLists, toolList)
	if err := f.errs[n]; err != nil {
		return StreamResult{}, err
	}
	if len(f.replies) == 0 {
		return StreamResult{}, nil
	}
	reply := f.replies[0]
	f.replies = f.replies[1:]
	return reply, nil
}

func say(texts ...string) []StreamResult {
	out := make([]StreamResult, len(texts))
	for i, t := range texts {
		out[i] = StreamResult{Text: t}
	}
	return out
}

type fakeApprover struct {
	decisions []Decision
	asked     []Approval
	err       error
}

func (a *fakeApprover) Approve(ctx context.Context, req Approval) (Decision, error) {
	a.asked = append(a.asked, req)
	if a.err != nil {
		return Deny, a.err
	}
	if len(a.decisions) == 0 {
		return Deny, nil
	}
	d := a.decisions[0]
	a.decisions = a.decisions[1:]
	return d, nil
}

type rig struct {
	t      *testing.T
	root   string
	model  *fakeModel
	turn   *Turn
	events []Event
}

func newRig(t *testing.T, replies []StreamResult) *rig {
	t.Helper()
	root := t.TempDir()
	tb := tools.NewToolbox(root)
	t.Cleanup(tb.Close)
	session := NewSession(root, tb)
	session.AutoApprove = true
	session.ContextWindow = 8192
	model := &fakeModel{replies: replies, errs: map[int]error{}}
	r := &rig{t: t, root: root, model: model}
	r.turn = &Turn{S: session, Stream: model.stream, Emit: func(e Event) { r.events = append(r.events, e) }}
	return r
}

func (r *rig) run(prompt string) (string, []history.Message) {
	r.t.Helper()
	answer, working, err := r.turn.Run(context.Background(), []history.Message{history.User(prompt)})
	if err != nil {
		r.t.Fatalf("Run: %v", err)
	}
	return answer, working
}

func (r *rig) write(rel, content string) {
	r.t.Helper()
	path := filepath.Join(r.root, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
}

func (r *rig) read(rel string) string {
	data, err := os.ReadFile(filepath.Join(r.root, rel))
	if err != nil {
		return "<no existe>"
	}
	return string(data)
}

func (r *rig) notes() string {
	var sb strings.Builder
	for _, e := range r.events {
		if e.Kind == EventNote {
			sb.WriteString(e.Text + "\n")
		}
	}
	return sb.String()
}

func nativeCall(id, name string, args map[string]any) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{"id": id, "function": map[string]any{"name": name, "arguments": args}})
	return raw
}

func agentHistory(pairs int) []history.Message {
	msgs := []history.Message{history.User("arregla el login")}
	for i := 0; i < pairs; i++ {
		id := "c" + strconv.Itoa(i)
		msgs = append(msgs,
			history.Message{Role: "assistant", ToolCalls: []json.RawMessage{nativeCall(id, "read_file", map[string]any{"path": "a.py"})}},
			history.Message{Role: "tool", Content: strings.Repeat("x", 8000), ToolCallID: id, Name: "read_file"})
	}
	return msgs
}

// ── el turno nunca acaba en silencio (portados de test_agent_context.py) ────

func TestEmptyReplyIsRetriedFreeingContext(t *testing.T) {
	r := newRig(t, say("", "", "Ya está: corregido el login."))
	answer, _, err := r.turn.Run(context.Background(), agentHistory(20))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.model.calls) != 3 || !strings.Contains(answer, "corregido el login") {
		t.Fatalf("calls=%d answer=%q", len(r.model.calls), answer)
	}
}

func TestRetryDoesNotDeleteTheConversation(t *testing.T) {
	r := newRig(t, say("", "Listo."))
	hist := agentHistory(20)
	_, working, err := r.turn.Run(context.Background(), hist)
	if err != nil {
		t.Fatal(err)
	}
	if working[0].Content != hist[0].Content || len(working) < len(hist) {
		t.Fatalf("working perdió la conversación: %d mensajes", len(working))
	}
}

func TestCallHiddenInReasoningIsRescued(t *testing.T) {
	r := newRig(t, []StreamResult{
		{Text: "", Reasoning: `Debería mirar el archivo: {"tool":"read_file","args":{"path":"index.html"}}`},
		{Text: "Ya lo he leído."},
	})
	r.turn.S.NativeTools = false
	r.write("index.html", "<h1>hola</h1>")
	answer, working := r.run("lee el html")
	if !strings.Contains(answer, "leído") {
		t.Fatalf("answer=%q", answer)
	}
	var result string
	for _, m := range working {
		if strings.HasPrefix(m.Content, "TOOL_RESULT") {
			result = m.Content
		}
	}
	if !strings.Contains(result, "hola") {
		t.Fatalf("resultado: %q", result)
	}
	rescued := false
	for _, m := range working {
		if m.Role == "assistant" && strings.Contains(m.Content, `"tool":"read_file"`) {
			rescued = true
		}
	}
	if !rescued {
		t.Fatal("el historial debe guardar la llamada rescatada, no un turno vacío")
	}
}

func TestReasoningWithoutAnswerAsksForTheConcreteStep(t *testing.T) {
	r := newRig(t, []StreamResult{
		{Text: "", Reasoning: "Mmm, déjame pensar cómo abordarlo…"},
		{Text: "Hecho."},
	})
	r.turn.S.NativeTools = false
	answer, _ := r.run("arregla el css")
	last := r.model.calls[1][len(r.model.calls[1])-1]
	if last.Role != "user" || !strings.Contains(last.Content, "NO vuelvas a razonar") || answer != "Hecho." {
		t.Fatalf("last=%+v answer=%q", last, answer)
	}
}

func TestPersistentEmptyReplySaysSo(t *testing.T) {
	r := newRig(t, []StreamResult{{Reasoning: "pienso"}, {Reasoning: "pienso"}, {Reasoning: "pienso"}, {Reasoning: "pienso"}})
	answer, _ := r.run("haz algo")
	if strings.TrimSpace(answer) == "" || !strings.Contains(strings.ToLower(answer), "responder") {
		t.Fatalf("answer=%q", answer)
	}
}

func TestRepeatedCallIsCutWithExplanation(t *testing.T) {
	repeated := `{"tool":"list_files","args":{"path":"."}}`
	r := newRig(t, say(repeated, repeated, repeated, repeated, repeated, repeated, repeated, repeated, repeated, repeated))
	r.turn.S.NativeTools = false
	answer, _ := r.run("lista")
	if !strings.Contains(strings.ToLower(answer), "repitiendo") || len(r.model.calls) >= 10 {
		t.Fatalf("answer=%q calls=%d", answer, len(r.model.calls))
	}
}

func TestPromptFitsTheWindowWithSystemPrompt(t *testing.T) {
	r := newRig(t, say("Listo."))
	r.write("app.py", "print('hola')")
	if _, _, err := r.turn.Run(context.Background(), agentHistory(40)); err != nil {
		t.Fatal(err)
	}
	sent := r.model.calls[0]
	if sent[0].Role != "system" {
		t.Fatalf("el system prompt no sobrevive: %q", sent[0].Role)
	}
	if tokens := (&history.Estimator{}).EstimateTokens(sent); tokens >= 8192 {
		t.Fatalf("el prompt enviado ocupa %d tokens", tokens)
	}
}

func TestStepCapIsWideAndExplained(t *testing.T) {
	if MaxSteps < 30 {
		t.Fatalf("MaxSteps = %d", MaxSteps)
	}
	replies := make([]StreamResult, 200)
	for i := range replies {
		replies[i] = StreamResult{Text: `{"tool":"list_files","args":{"path":".","n":` + strconv.Itoa(i) + `}}`}
	}
	r := newRig(t, replies)
	r.turn.S.NativeTools = false
	answer, _ := r.run("explora")
	if len(r.model.calls) != MaxSteps || !strings.Contains(strings.ToLower(answer), "continúa") {
		t.Fatalf("calls=%d answer=%q", len(r.model.calls), answer)
	}
}

func TestSystemPromptCarriesPlanModeAndTodo(t *testing.T) {
	r := newRig(t, say("Plan: 1) x"))
	r.turn.S.PlanMode = true
	r.run("mejora el login")
	system := r.model.calls[0][0].Content
	if !strings.Contains(system, "MODO PLAN") || !strings.Contains(system, "`todo`") {
		t.Fatal("falta MODO PLAN o la guía de todo")
	}
	r2 := newRig(t, say("ok"))
	r2.run("x")
	if strings.Contains(r2.model.calls[0][0].Content, "MODO PLAN") {
		t.Fatal("MODO PLAN sin activar")
	}
}

// ── herramientas nativas ───────────────────────────────────────────────────

func TestNativeToolCallsRoundTrip(t *testing.T) {
	r := newRig(t, []StreamResult{
		{ToolCalls: []json.RawMessage{
			nativeCall("c1", "write_file", map[string]any{"path": "a.txt", "content": "hola\n"}),
			nativeCall("c2", "read_file", map[string]any{"path": "a.txt"}),
		}},
		{Text: "Listo."},
	})
	answer, working := r.run("crea a.txt")
	if answer != "Listo." || r.read("a.txt") != "hola\n" {
		t.Fatalf("answer=%q file=%q", answer, r.read("a.txt"))
	}
	if len(r.model.toolLists[0]) != 20 {
		t.Fatalf("herramientas enviadas: %d", len(r.model.toolLists[0]))
	}
	var toolMsgs []history.Message
	for _, m := range working {
		if m.Role == "tool" {
			toolMsgs = append(toolMsgs, m)
		}
	}
	if len(toolMsgs) != 2 || toolMsgs[0].ToolCallID != "c1" || toolMsgs[0].Name != "write_file" ||
		toolMsgs[1].ToolCallID != "c2" || toolMsgs[1].Content != "hola\n" {
		t.Fatalf("mensajes de herramienta: %+v", toolMsgs)
	}
	assistant := working[1]
	if assistant.Role != "assistant" || len(assistant.ToolCalls) != 2 {
		t.Fatalf("el assistant debe conservar sus tool_calls: %+v", assistant)
	}
}

func TestToolResultsAreClippedForTheModel(t *testing.T) {
	r := newRig(t, []StreamResult{
		{ToolCalls: []json.RawMessage{nativeCall("c1", "read_file", map[string]any{"path": "big.txt"})}},
		{Text: "ok"},
	})
	r.write("big.txt", strings.Repeat("línea\n", 5000))
	_, working := r.run("lee")
	for _, m := range working {
		if m.Role == "tool" && len([]rune(m.Content)) > history.MaxToolOutputChars+100 {
			t.Fatalf("el resultado no se recortó: %d", len([]rune(m.Content)))
		}
	}
}

func TestRepeatedNativeCallsAreCut(t *testing.T) {
	call := nativeCall("c", "list_files", map[string]any{"path": "."})
	replies := make([]StreamResult, 10)
	for i := range replies {
		replies[i] = StreamResult{ToolCalls: []json.RawMessage{call}}
	}
	r := newRig(t, replies)
	answer, _ := r.run("lista")
	if !strings.Contains(answer, "repitiendo") || len(r.model.calls) > MaxRepeatedCalls+2 {
		t.Fatalf("answer=%q calls=%d", answer, len(r.model.calls))
	}
}

type apiFailure struct{ msg string }

func (e apiFailure) Error() string  { return e.msg }
func (e apiFailure) APIStatus() int { return 400 }

func TestModelWithoutNativeToolsFallsBackToText(t *testing.T) {
	r := newRig(t, say("Hecho."))
	r.model.errs[0] = apiFailure{`registry.ollama.ai/x does not support tools`}
	r.turn.S.Model = "mini"
	answer, _ := r.run("hola")
	if answer != "Hecho." || r.turn.S.NativeTools {
		t.Fatalf("answer=%q native=%v", answer, r.turn.S.NativeTools)
	}
	if r.model.toolLists[1] != nil {
		t.Fatal("el reintento no debe enviar herramientas")
	}
	if !strings.Contains(r.notes(), "mini no soporta herramientas nativas") {
		t.Fatalf("notas: %q", r.notes())
	}
}

func TestOtherStreamErrorsPropagate(t *testing.T) {
	r := newRig(t, nil)
	r.model.errs[0] = errors.New("boom")
	if _, _, err := r.turn.Run(context.Background(), []history.Message{history.User("x")}); err == nil || err.Error() != "boom" {
		t.Fatalf("err = %v", err)
	}
}

// ── protocolo de texto ────────────────────────────────────────────────────

func TestTextProtocolGroupsConsecutiveReads(t *testing.T) {
	r := newRig(t, say(
		`{"tool":"read_file","args":{"path":"a.txt"}}`+"\n"+`{"tool":"read_file","args":{"path":"src/b.txt"}}`,
		"Leídos."))
	r.turn.S.NativeTools = false
	r.write("a.txt", "uno\ndos\n")
	r.write("src/b.txt", "tres")
	_, working := r.run("lee ambos")
	var groups []Event
	for _, e := range r.events {
		if e.Kind == EventReadGroup {
			groups = append(groups, e)
		}
	}
	if len(groups) != 1 || strings.Join(groups[0].Names, ",") != "a.txt,b.txt" || groups[0].Text != "2 archivos" {
		t.Fatalf("grupos: %+v", groups)
	}
	results := working[len(working)-2].Content
	if !strings.Contains(results, "TOOL_RESULT read_file: uno\ndos") || !strings.Contains(results, "TOOL_RESULT read_file: tres") {
		t.Fatalf("resultados: %q", results)
	}
}

func TestCodeBlockGetsOneNudge(t *testing.T) {
	r := newRig(t, say("```py\nprint(1)\n```", "```py\nprint(1)\n```"))
	answer, working := r.run("haz x")
	if !strings.Contains(answer, "print(1)") || len(r.model.calls) != 2 {
		t.Fatalf("answer=%q calls=%d", answer, len(r.model.calls))
	}
	nudge := working[2]
	if nudge.Role != "user" || nudge.Content != NativeNudgePrompt {
		t.Fatalf("nudge: %+v", nudge)
	}
}

func TestTruncatedCallGetsTruncatedPrompt(t *testing.T) {
	r := newRig(t, say(`Voy a crearlo. {"tool":"write_file","args":{"path":"a.txt","content":"hola`, "ok"))
	r.turn.S.NativeTools = false
	answer, working := r.run("crea")
	if answer != "ok" || working[2].Content != TruncatedPrompt {
		t.Fatalf("answer=%q working[2]=%+v", answer, working[2])
	}
}

func TestFabricatedToolResultIsCut(t *testing.T) {
	r := newRig(t, say("Hecho.\nTOOL_RESULT write_file: ok\nmentira"))
	answer, _ := r.run("x")
	if answer != "Hecho." {
		t.Fatalf("answer=%q", answer)
	}
}

// ── aprobaciones ──────────────────────────────────────────────────────────

func writeCall(rel, content string) StreamResult {
	return StreamResult{ToolCalls: []json.RawMessage{nativeCall("c", "write_file", map[string]any{"path": rel, "content": content})}}
}

func TestDeniedEditLeavesTheFileUntouched(t *testing.T) {
	r := newRig(t, []StreamResult{writeCall("a.txt", "x"), {Text: "vale"}})
	approver := &fakeApprover{decisions: []Decision{Deny}}
	r.turn.S.AutoApprove = false
	r.turn.S.Approver = approver
	_, working := r.run("crea")
	if r.read("a.txt") != "<no existe>" {
		t.Fatal("el archivo se escribió pese al rechazo")
	}
	if len(approver.asked) != 1 || approver.asked[0].Kind != ApproveEdit || approver.asked[0].Change.Kind != "create" {
		t.Fatalf("aprobaciones: %+v", approver.asked)
	}
	if got := working[2].Content; got != "Ejecución cancelada por el usuario" {
		t.Fatalf("resultado para el modelo: %q", got)
	}
}

func TestApprovalWithoutApproverDenies(t *testing.T) {
	r := newRig(t, []StreamResult{writeCall("a.txt", "x"), {Text: "vale"}})
	r.turn.S.AutoApprove = false
	r.run("crea")
	if r.read("a.txt") != "<no existe>" {
		t.Fatal("sin aprobador no se debe escribir")
	}
}

func TestAllowAlwaysStopsAsking(t *testing.T) {
	r := newRig(t, []StreamResult{writeCall("a.txt", "1"), writeCall("b.txt", "2"), {Text: "ok"}})
	approver := &fakeApprover{decisions: []Decision{AllowAlways}}
	r.turn.S.AutoApprove = false
	r.turn.S.Approver = approver
	r.run("crea dos")
	if len(approver.asked) != 1 || !r.turn.S.AutoApprove || r.read("a.txt") != "1" || r.read("b.txt") != "2" {
		t.Fatalf("asked=%d auto=%v a=%q b=%q", len(approver.asked), r.turn.S.AutoApprove, r.read("a.txt"), r.read("b.txt"))
	}
}

func commandCall(command string) StreamResult {
	return StreamResult{ToolCalls: []json.RawMessage{nativeCall("c", "run_command", map[string]any{"command": command})}}
}

func TestAutoApproveDoesNotCoverCommands(t *testing.T) {
	r := newRig(t, []StreamResult{commandCall("echo hola"), {Text: "ok"}})
	approver := &fakeApprover{decisions: []Decision{Deny}}
	r.turn.S.AutoApprove = true
	r.turn.S.Approver = approver
	_, working := r.run("corre")
	if len(approver.asked) != 1 || approver.asked[0].Kind != ApproveCommand || approver.asked[0].Prefix != "echo hola" {
		t.Fatalf("aprobaciones: %+v", approver.asked)
	}
	if working[2].Content != "Ejecución cancelada por el usuario" {
		t.Fatalf("resultado: %q", working[2].Content)
	}
}

func TestAllowPrefixIsRememberedAndPersisted(t *testing.T) {
	r := newRig(t, []StreamResult{commandCall("echo uno"), commandCall("echo dos"), commandCall("echo uno && rm x"), {Text: "ok"}})
	approver := &fakeApprover{decisions: []Decision{AllowPrefix, Deny}}
	var saved []string
	r.turn.S.Approver = approver
	r.turn.S.OnAllowedCommands = func(list []string) { saved = append([]string{}, list...) }
	_, working := r.run("corre")
	if len(saved) != 1 || saved[0] != "echo uno" {
		t.Fatalf("persistido: %v", saved)
	}
	if len(approver.asked) != 3 {
		t.Fatalf("preguntas: %d (echo uno, echo dos, el encadenado)", len(approver.asked))
	}
	var results []string
	for _, m := range working {
		if m.Role == "tool" {
			results = append(results, m.Content)
		}
	}
	if !strings.HasPrefix(results[0], "[EXIT 0] uno") || results[2] != "Ejecución cancelada por el usuario" {
		t.Fatalf("resultados: %q", results)
	}
}

func TestAllowAlwaysForCommandsIsSeparateFromEdits(t *testing.T) {
	r := newRig(t, []StreamResult{commandCall("echo a"), commandCall("echo b"), {Text: "ok"}})
	approver := &fakeApprover{decisions: []Decision{AllowAlways}}
	r.turn.S.Approver = approver
	r.run("corre")
	if len(approver.asked) != 1 || !r.turn.S.AutoRunCommands || r.turn.S.AutoApprove != true {
		t.Fatalf("asked=%d run=%v", len(approver.asked), r.turn.S.AutoRunCommands)
	}
}

func TestApproverErrorAbortsTheTurn(t *testing.T) {
	r := newRig(t, []StreamResult{writeCall("a.txt", "x")})
	r.turn.S.AutoApprove = false
	r.turn.S.Approver = &fakeApprover{err: context.Canceled}
	_, _, err := r.turn.Run(context.Background(), []history.Message{history.User("x")})
	if !errors.Is(err, context.Canceled) || r.read("a.txt") != "<no existe>" {
		t.Fatalf("err=%v", err)
	}
}

func TestPlanModeBlocksWritesAndAllowsReads(t *testing.T) {
	r := newRig(t, nil)
	r.turn.S.PlanMode = true
	r.write("a.txt", "hola")
	ctx := context.Background()
	out, err := r.turn.approveAndRun(ctx, "write_file", map[string]any{"path": "n.txt", "content": "x"})
	if err != nil || !strings.HasPrefix(out, "[modo plan]") || r.read("n.txt") != "<no existe>" {
		t.Fatalf("write: %q %v", out, err)
	}
	out, _ = r.turn.approveAndRun(ctx, "run_command", map[string]any{"command": "echo hola"})
	if !strings.HasPrefix(out, "[modo plan]") {
		t.Fatalf("run_command: %q", out)
	}
	out, _ = r.turn.approveAndRun(ctx, "read_file", map[string]any{"path": "a.txt"})
	if out != "hola" {
		t.Fatalf("read_file: %q", out)
	}
}

// ── checkpoints, undo, verificación, imágenes, cancelación ────────────────

func TestUndoRestoresAndRemoves(t *testing.T) {
	r := newRig(t, []StreamResult{
		{ToolCalls: []json.RawMessage{
			nativeCall("1", "write_file", map[string]any{"path": "existe.txt", "content": "nuevo"}),
			nativeCall("2", "write_file", map[string]any{"path": "creado/n.txt", "content": "n"}),
			nativeCall("3", "rename_file", map[string]any{"src": "mover.txt", "dst": "movido.txt"}),
			nativeCall("4", "delete_file", map[string]any{"path": "borrar.txt"}),
		}},
		{Text: "hecho"},
	})
	r.write("existe.txt", "original")
	r.write("mover.txt", "m")
	r.write("borrar.txt", "b")
	r.turn.S.BeginTurn()
	r.run("haz cosas")
	r.turn.S.EndTurn()
	if r.read("existe.txt") != "nuevo" || r.read("movido.txt") != "m" || r.read("borrar.txt") != "<no existe>" {
		t.Fatal("el turno no aplicó los cambios")
	}
	done, err := r.turn.S.Undo()
	if err != nil {
		t.Fatalf("Undo: %v (%v)", err, done)
	}
	if r.read("existe.txt") != "original" || r.read("mover.txt") != "m" || r.read("borrar.txt") != "b" ||
		r.read("creado/n.txt") != "<no existe>" || r.read("movido.txt") != "<no existe>" {
		t.Fatalf("estado tras undo: %q", done)
	}
	if _, err := r.turn.S.Undo(); !errors.Is(err, ErrNothingToUndo) {
		t.Fatalf("segundo undo: %v", err)
	}
}

func TestUndoStackKeepsTheLastTenTurns(t *testing.T) {
	s := NewSession(t.TempDir(), nil)
	for i := 0; i < 15; i++ {
		s.Checkpoints = []Checkpoint{{Path: "f" + strconv.Itoa(i)}}
		s.EndTurn()
	}
	if len(s.UndoStack) != 10 || s.UndoStack[0][0].Path != "f5" {
		t.Fatalf("pila: %d, primero %q", len(s.UndoStack), s.UndoStack[0][0].Path)
	}
	s.Checkpoints = nil
	s.EndTurn()
	if len(s.UndoStack) != 10 {
		t.Fatal("un turno sin cambios no apila nada")
	}
}

func TestUndoMarksDirectoriesAsIncomplete(t *testing.T) {
	r := newRig(t, []StreamResult{
		{ToolCalls: []json.RawMessage{nativeCall("1", "delete_file", map[string]any{"path": "carpeta"})}},
		{Text: "ok"},
	})
	r.write("carpeta/x.txt", "x")
	r.turn.S.BeginTurn()
	r.run("borra")
	if !r.turn.S.UndoIncomplete {
		t.Fatal("borrar una carpeta debe marcar el undo como incompleto")
	}
}

func TestVerifierErrorsReachTheModel(t *testing.T) {
	r := newRig(t, []StreamResult{
		{ToolCalls: []json.RawMessage{nativeCall("1", "write_file", map[string]any{"path": "c.json", "content": "{rota"})}},
		{Text: "ok"},
	})
	_, working := r.run("crea")
	result := working[2].Content
	if !strings.Contains(result, "[verificación json] el archivo tiene errores; corrígelos:") {
		t.Fatalf("resultado: %q", result)
	}
	var check Event
	for _, e := range r.events {
		if e.Kind == EventActionResult && e.Check != "" {
			check = e
		}
	}
	if !check.Failed || !strings.HasPrefix(check.Check, "json: ") {
		t.Fatalf("evento: %+v", check)
	}
	r.turn.S.AutoCheck = false
	r2 := newRig(t, []StreamResult{
		{ToolCalls: []json.RawMessage{nativeCall("1", "write_file", map[string]any{"path": "c.json", "content": "{rota"})}},
		{Text: "ok"},
	})
	r2.turn.S.AutoCheck = false
	_, working = r2.run("crea")
	if strings.Contains(working[2].Content, "verificación") {
		t.Fatal("con auto_check apagado no se verifica")
	}
}

func TestGoFilesAreSyntaxChecked(t *testing.T) {
	r := newRig(t, []StreamResult{
		{ToolCalls: []json.RawMessage{nativeCall("1", "write_file", map[string]any{"path": "a.go", "content": "package a\nfunc {"})}},
		{Text: "ok"},
	})
	_, working := r.run("crea")
	if !strings.Contains(working[2].Content, "[verificación go/parser]") {
		t.Fatalf("resultado: %q", working[2].Content)
	}
}

func TestReadImageIsAttachedAfterTheResult(t *testing.T) {
	r := newRig(t, []StreamResult{
		{ToolCalls: []json.RawMessage{nativeCall("1", "read_file", map[string]any{"path": "foto.png"})}},
		{Text: "la veo"},
	})
	r.write("foto.png", "\x89PNG0000")
	_, working := r.run("mira la foto")
	var found bool
	for _, m := range working {
		if m.Role == "user" && m.Content == ToolImagesPrompt && len(m.Images) == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("no se adjuntó la imagen: %+v", working)
	}
}

func TestCancelDuringStreamReturnsContextError(t *testing.T) {
	r := newRig(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	r.turn.Stream = func(ctx context.Context, _ []history.Message, _ []map[string]any) (StreamResult, error) {
		cancel()
		<-ctx.Done()
		return StreamResult{}, ctx.Err()
	}
	_, _, err := r.turn.Run(ctx, []history.Message{history.User("x")})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
}

func TestCancelKillsARunningCommand(t *testing.T) {
	r := newRig(t, []StreamResult{commandCall("ping -n 30 127.0.0.1 >nul || sleep 30"), {Text: "no llega"}})
	r.turn.S.AutoRunCommands = true
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(500*time.Millisecond, cancel)
	start := time.Now()
	_, _, err := r.turn.Run(ctx, []history.Message{history.User("espera")})
	if !errors.Is(err, context.Canceled) || time.Since(start) > 10*time.Second {
		t.Fatalf("err=%v tras %s", err, time.Since(start))
	}
}

func TestCompactionRunsWhenTheWindowFills(t *testing.T) {
	r := newRig(t, say("sigo"))
	r.turn.S.ContextWindow = 1000
	var asked []history.Message
	r.turn.S.Ask = func(ctx context.Context, m []history.Message) (string, error) {
		asked = m
		return "resumen de lo hablado", nil
	}
	hist := []history.Message{}
	for i := 0; i < 8; i++ {
		hist = append(hist, history.User("pregunta "+strings.Repeat("larga ", 60)), history.Assistant("respuesta "+strings.Repeat("larga ", 60)))
	}
	hist = append(hist, history.User("y ahora?"))
	_, working, err := r.turn.Run(context.Background(), hist)
	if err != nil {
		t.Fatal(err)
	}
	if asked == nil || !strings.Contains(r.notes(), "Contexto compactado") {
		t.Fatalf("no compactó. notas: %q", r.notes())
	}
	if !strings.Contains(working[0].Content, "resumen de lo hablado") {
		t.Fatalf("working[0] = %q", working[0].Content)
	}
}

func TestCompactionFailureFallsBackToPruning(t *testing.T) {
	r := newRig(t, say("sigo"))
	r.turn.S.ContextWindow = 1000
	r.turn.S.Ask = func(context.Context, []history.Message) (string, error) { return "", errors.New("gateway caído") }
	hist := []history.Message{}
	for i := 0; i < 8; i++ {
		hist = append(hist, history.User("pregunta "+strings.Repeat("larga ", 60)), history.Assistant("respuesta "+strings.Repeat("larga ", 60)))
	}
	hist = append(hist, history.User("y ahora?"))
	answer, _, err := r.turn.Run(context.Background(), hist)
	if err != nil || answer != "sigo" || !strings.Contains(r.notes(), "No se pudo compactar (gateway caído)") {
		t.Fatalf("answer=%q err=%v notas=%q", answer, err, r.notes())
	}
}

func TestActionEventsCarryTheDiff(t *testing.T) {
	r := newRig(t, []StreamResult{
		{ToolCalls: []json.RawMessage{nativeCall("1", "edit_file", map[string]any{"path": "a.txt", "old_text": "dos", "new_text": "DOS"})}},
		{Text: "ok"},
	})
	r.write("a.txt", "uno\ndos\ntres\n")
	r.run("edita")
	var action, result Event
	for _, e := range r.events {
		switch e.Kind {
		case EventAction:
			action = e
		case EventActionResult:
			result = e
		}
	}
	if action.Change == nil || action.Adds != 1 || action.Dels != 1 || action.Change.Kind != "update" {
		t.Fatalf("acción: %+v", action)
	}
	if result.Summary != "1 reemplazo en la línea 2" || result.Failed || r.read("a.txt") != "uno\nDOS\ntres\n" {
		t.Fatalf("resultado: %+v", result)
	}
	stats := r.turn.S.Stats
	if stats.Actions != 1 || !stats.Files["a.txt"] || stats.Adds != 1 || stats.Dels != 1 {
		t.Fatalf("stats: %+v", stats)
	}
}

// El diff que se aprueba debe ser lo que la herramienta escribe.
func TestPreviewMatchesWhatTheToolWrites(t *testing.T) {
	cases := []struct {
		tool  string
		files map[string]string
		args  map[string]any
	}{
		{"edit_file", map[string]string{"a.txt": "uno\ndos\n"}, map[string]any{"path": "a.txt", "old_text": "dos", "new_text": "2"}},
		{"edit_file", map[string]string{"a.txt": "  uno\n  dos\n"}, map[string]any{"path": "a.txt", "old_text": "uno\ndos", "new_text": "1\n2"}},
		{"edit_file", map[string]string{"a.txt": "x\nx\n"}, map[string]any{"path": "a.txt", "old_text": "x", "new_text": "y"}},
		{"edit_file", map[string]string{"a.txt": "x\nx\n"}, map[string]any{"path": "a.txt", "old_text": "x", "new_text": "y", "all": true}},
		{"insert_at_line", map[string]string{"a.txt": "1\n2\n"}, map[string]any{"path": "a.txt", "line": 0, "content": "X"}},
		{"insert_at_line", map[string]string{"a.txt": "1\n2\n"}, map[string]any{"path": "a.txt", "line": 99, "content": "X\n"}},
		{"insert_at_line", map[string]string{"a.txt": "1\n2"}, map[string]any{"path": "a.txt", "line": 2, "content": "X\n"}},
		{"multi_edit", map[string]string{"a.txt": "a\nb\nc\n"}, map[string]any{"path": "a.txt", "edits": []any{
			map[string]any{"old_text": "a", "new_text": "A"}, map[string]any{"old_text": "zzz", "new_text": "?"}, map[string]any{"old_text": "c", "new_text": "C"}}}},
		{"write_file", map[string]string{"a.txt": "viejo\n"}, map[string]any{"path": "a.txt", "content": "nuevo\n"}},
		{"append_file", map[string]string{"a.txt": "uno\n"}, map[string]any{"path": "a.txt", "content": "dos\n"}},
	}
	for i, c := range cases {
		root := t.TempDir()
		for rel, content := range c.files {
			if err := os.WriteFile(filepath.Join(root, rel), []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		change := ComputeChange(root, c.tool, c.args)
		tb := tools.NewToolbox(root)
		tb.Execute(context.Background(), c.tool, c.args)
		tb.Close()
		after, _ := os.ReadFile(filepath.Join(root, "a.txt"))
		if change == nil || change.NewText != string(after) {
			t.Errorf("caso %d (%s): vista previa %q, archivo %q", i, c.tool, change.NewText, after)
		}
	}
}
