package tui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/orch"
)

const (
	pApp  = "01a16268-a413-7f3a-a4d3-422c1554f516"
	pDocs = "01a16268-a414-7d8e-bd07-d865b5ebd953"
)

var lxoNow = time.UnixMilli(1_800_000_000_000)

const projectsJSON = `{"v":1,"filters":{"archived":"include","machine":null},"total":3,"projects":[
 {"id":"01a16268-a415","name":"api-pagos","state":"active","status":"idle","counts":{"tasks":0,"active":0,"failed":0,"attention":{"total":0,"by_category":{}}},"locations":[{"machine":"dev-pc","path":"C:/repos/api-pagos","primary":true,"state":"ok"}]},
 {"id":"` + pDocs + `","name":"docs-web","state":"active","status":"attention","counts":{"tasks":3,"active":1,"failed":0,"attention":{"total":2,"by_category":{"risk":1,"environment_blocked":1}}},"locations":[{"machine":"dev-pc","path":"C:/repos/docs-web","primary":true,"state":"ok"}]},
 {"id":"` + pApp + `","name":"lixbon-app","state":"active","status":"failed","counts":{"tasks":5,"active":3,"failed":1,"attention":{"total":5,"by_category":{}}},"locations":[{"machine":"dev-pc","path":"C:/repos/lixbon-app","primary":true,"state":"ok"}]}],
 "unassigned":{"tasks":1,"active":1,"failed":0,"attention":{"total":0,"by_category":{}}}}`

const attentionJSON = `{"v":1,"items":[
 {"id":"att_risk","category":"risk","severity":"low","status":"active","target_kind":"task","target_id":"t13","project_id":"` + pDocs + `","occurrence":1,"created_at":1799992800000},
 {"id":"att_conflict","category":"conflict","severity":"critical","status":"active","target_kind":"task","target_id":"t3","project_id":"` + pApp + `","occurrence":1,"created_at":1799999880000},
 {"id":"att_run","category":"approval","severity":"high","status":"active","target_kind":"spawn_request","target_id":"sp1","project_id":"desconocido-0123456789","occurrence":3,"created_at":1799999990000}
],"next_cursor":null,"has_more":false,"limit":100}`

const tasksJSON = `{"v":1,"task_model":"legacy","tasks":[
 {"id":"t2","title":"Coordinar Supervisar móvil","project_id":"` + pApp + `","run_id":"r1","parent_id":null,"status":"running","final":false,"provider":"claude","model":"claude-opus-5-5","branch":null,"shared_checkout":false,"origin":"external"},
 {"id":"t3","title":"Relé core_task","project_id":"` + pApp + `","run_id":"r1","parent_id":"t2","status":"running","final":false,"provider":"codex","model":"gpt-5","branch":"lxo/rele","shared_checkout":false,"origin":"external"},
 {"id":"t4","title":"Pantalla de Atención","project_id":"` + pApp + `","run_id":"r1","parent_id":"t2","status":"failed","final":true,"provider":"claude","model":null,"branch":"lxo/bandeja","shared_checkout":false,"origin":"lixbon"},
 {"id":"t6","title":"Revisar traductor","project_id":"` + pApp + `","run_id":"r1","parent_id":"t2","status":"done","final":true,"provider":"gemini","model":null,"branch":null,"shared_checkout":true,"origin":"lixbon"},
 {"id":"t18","title":"Limpiar descargas","project_id":null,"run_id":"r17","parent_id":null,"status":"running","final":false,"provider":"claude","model":null,"branch":null,"shared_checkout":false,"origin":"external"}
]}`

const taskShowJSON = `{"v":1,"task_model":"legacy","task":{"id":"t4","title":"Pantalla de Atención","project_id":"` + pApp + `","run_id":"r1","root_id":"t2","parent_id":"t2","status":"failed","final":true,"phase":null,"provider":"claude","model":null,"role":"implementador","branch":"lxo/bandeja","base":"main","worktree":"C:/repos/lixbon-app-wt/bandeja","shared_checkout":false,"origin":"lixbon","updated_at":1799999940000,"failure_reason":"agent_idle_timeout","merged":false,"pr_url":null},"children":[],"activity":{"has_more":true,"items":[{"seq":10,"ts":1799999880000,"kind":"task.created","message_key":"activity.task.created","visual":"info","text":"Se creó la tarea «Pantalla de Atención» para claude (profundidad 1)."},{"seq":11,"ts":1799999900000,"kind":"task.teleported","message_key":"activity.unknown","visual":"info","text":null},{"seq":12,"ts":1799999940000,"kind":"task.status_changed","message_key":"activity.task.failed","visual":"error","text":"La tarea falló."}]}}`

const summaryJSON = `{"v":1,"core":{"version":"2.2.0","health":"ok"},"cursor":42,"projects":{"total":3,"with_work":2,"with_work_complete":true},"active_tasks":5,"attention":{"total":7,"by_category":{"question":1,"approval":1,"review_ready":1,"conflict":1,"failed":1,"environment_blocked":1,"risk":1}}}`

func render(t *testing.T, args []string, out string, width int) string {
	t.Helper()
	names := lxoProjectNames(projectsJSON)
	var b strings.Builder
	for _, bl := range renderLxo(args, out, names, lxoNow) {
		b.WriteString(ansi.Strip(bl.render(width, false)))
		b.WriteString("\n")
	}
	text := b.String()
	for _, line := range strings.Split(text, "\n") {
		if ansi.StringWidth(line) > width {
			t.Errorf("línea de %d columnas en %d: %q", ansi.StringWidth(line), width, line)
		}
	}
	return text
}

func TestLxoCommandDetection(t *testing.T) {
	for cmd, want := range map[string]bool{"lxo attention": true, "  LXO tasks": true, "lxo": true, "lxor": false, "git status": false, "": false} {
		if isLxoCommand(cmd) != want {
			t.Errorf("isLxoCommand(%q) = %v", cmd, !want)
		}
	}
	for args, want := range map[string]bool{
		"attention": true, "attention show att_1": true, "tasks --active": true, "task show t4": true, "projects --all": true, "summary": true,
		"attention --json": false, "tasks --help": false, "events": false, "events --follow": false, "spawn --agent x": false, "": false,
	} {
		if got := lxoStyled(strings.Fields(args)); got != want {
			t.Errorf("lxoStyled(%q) = %v", args, got)
		}
	}
}

func TestLxoPassthroughUsesTheResolvedPath(t *testing.T) {
	if got := lxoPassthrough("lxo events --follow", `C:\Program Files\Lixbon\lxo.exe`); got != `"C:\Program Files\Lixbon\lxo.exe" events --follow` {
		t.Fatalf("passthrough: %s", got)
	}
	if got := lxoPassthrough("lxo", "lxo.exe"); got != "lxo.exe" {
		t.Fatalf("sin argumentos: %s", got)
	}
}

func TestLxoAttentionView(t *testing.T) {
	out := render(t, []string{"attention"}, attentionJSON, 100)
	for _, want := range []string{"Atención", "3 activas", "Conflicto · crítica", "tarea t3 · lixbon-app · att_conflict", "Riesgo · baja", "docs-web", "hace 2 min", "spawn_request sp1", "proyecto desconoc…", "! lxo attention show <id>"} {
		contains(t, out, want)
	}
	notContains(t, out, `"category"`)
	notContains(t, out, pApp)
	empty := render(t, []string{"attention"}, `{"v":1,"items":[],"has_more":false}`, 100)
	contains(t, empty, "Nada pide atención ahora mismo.")
}

func TestLxoTasksViewIsATree(t *testing.T) {
	out := render(t, []string{"tasks"}, tasksJSON, 100)
	contains(t, out, "Tareas")
	contains(t, out, "5 tareas · 3 activas")
	lines := strings.Split(out, "\n")
	indent := func(title string) int {
		for _, l := range lines {
			if i := strings.Index(l, title); i >= 0 {
				return ansi.StringWidth(l[:i]) // la columna donde empieza el título, con las guías del árbol delante
			}
		}
		t.Fatalf("no está %q en:\n%s", title, out)
		return 0
	}
	if indent("Relé core_task") <= indent("Coordinar Supervisar móvil") {
		t.Fatalf("las hijas van sangradas bajo su raíz:\n%s", out)
	}
	// Guías: «│» une la raíz con sus hijas, «└» marca la última, y una línea en blanco separa las tareas.
	plain := strings.ReplaceAll(strings.ReplaceAll(out, glyphRail, "│"), glyphCorner, "└")
	for _, want := range []string{"│ ● Relé core_task", "└ ✓ Revisar traductor", "│   t3 · lixbon-app", "externa\n   │\n"} {
		contains(t, plain, want)
	}
	if !strings.Contains(out, strings.Repeat(glyphSep, 5)) {
		t.Fatalf("puntos guía entre el título y el estado:\n%s", out)
	}
	for _, want := range []string{"en curso", "fallida", "terminada", "codex (gpt-5)", "⎇ lxo/rele", "checkout compartido", "externa", "sin proyecto", "! lxo task show <id o nombre>"} {
		if !strings.Contains(out, want) && !strings.Contains(out, strings.ReplaceAll(want, "⎇", glyphBranch)) {
			t.Errorf("falta %q en:\n%s", want, out)
		}
	}
}

func TestLxoTaskShowView(t *testing.T) {
	out := render(t, []string{"task", "show", "t4"}, taskShowJSON, 100)
	for _, want := range []string{"Pantalla de Atención", "fallida", "t4 · run r1 · hija de t2", "lixbon-app", "claude · implementador", "lxo/bandeja · base main", "C:/repos/lixbon-app-wt/bandeja", "agent_idle_timeout", "Lixbon", "! lxo attention --task t4"} {
		contains(t, out, want)
	}
	for _, want := range []string{"lo último al final", "lo anterior con ! lxo events --task t4", "Se creó la tarea «Pantalla de Atención»", "Evento task.teleported sin texto", "La tarea falló."} {
		contains(t, out, want)
	}
	if strings.Index(out, "Se creó la tarea") > strings.Index(out, "La tarea falló.") {
		t.Fatalf("la actividad va en orden, lo último al final:\n%s", out)
	}
	none := render(t, []string{"task", "show", "t4"}, strings.Replace(taskShowJSON, `"activity":{`, `"activity":null,"x":{`, 1), 100)
	contains(t, none, "no disponible en este Core")
	empty := render(t, []string{"task", "show", "t4"}, strings.Replace(taskShowJSON, `"has_more":true,"items":[`, `"has_more":false,"items":[],"y":[`, 1), 100)
	contains(t, empty, "sin eventos todavía")
}

func TestLxoProjectsAndSummaryViews(t *testing.T) {
	out := render(t, []string{"projects"}, projectsJSON, 100)
	for _, want := range []string{"Proyectos", "lixbon-app", "con fallos", "3 activas · 1 fallida · 5 piden atención · 5 tareas en total", "pide atención", "en reposo", "Sin proyecto · 1 activa"} {
		contains(t, out, want)
	}
	sum := render(t, []string{"summary"}, summaryJSON, 100)
	for _, want := range []string{"Lixbon", "Core 2.2.0", "2 proyectos con trabajo · 5 tareas activas · 7 piden atención", "1 pregunta · 1 aprobación", "! lxo attention para verla"} {
		contains(t, sum, want)
	}
}

func TestLxoViewsFitANarrowTerminal(t *testing.T) {
	for _, c := range []struct {
		args []string
		doc  string
	}{{[]string{"attention"}, attentionJSON}, {[]string{"tasks"}, tasksJSON}, {[]string{"task", "show", "t4"}, taskShowJSON}, {[]string{"projects"}, projectsJSON}, {[]string{"summary"}, summaryJSON}} {
		render(t, c.args, c.doc, 44) // render falla si alguna línea pasa de 44 columnas
	}
}

func TestLxoUnknownJSONAndFailures(t *testing.T) {
	contains(t, render(t, []string{"tasks"}, "no es json", 80), "no entiende")
	warn := ansi.Strip(lxoFailure(`{"ok":false,"code":"core_unavailable","error":"Lixbon cerrado"}`, errors.New("exit 5"))[0].render(100, false))
	contains(t, warn, "Lixbon Desktop no está abierto")
	other := ansi.Strip(lxoFailure(`{"ok":false,"code":"not_found","error":"No existe la tarea t9"}`, errors.New("exit 6"))[0].render(100, false))
	contains(t, other, "No existe la tarea t9")
}

func TestBangLxoInTheChatIsStyledAndReachesTheModel(t *testing.T) {
	previous := lxoRun
	var calls []string
	lxoRun = func(_ context.Context, lxo, _ string, args ...string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		if args[0] == "projects" {
			return projectsJSON, nil
		}
		return attentionJSON, nil
	}
	t.Cleanup(func() { lxoRun = previous })

	h := newHarness(t, nil)
	h.chat.Session.Orch = orchAvailable()
	h.send("! lxo attention")
	h.settle()
	if len(calls) == 0 || calls[0] != "attention --json" {
		t.Fatalf("pide el JSON a lxo: %v", calls)
	}
	contains(t, h.out(), "Conflicto · crítica")
	notContains(t, h.out(), `"severity"`)
	last := h.chat.History[len(h.chat.History)-1]
	if !strings.Contains(fmt.Sprint(last.Content), "TOOL_RESULT run_command `lxo attention --json`") {
		t.Fatalf("el modelo ve el resultado como cualquier «!»: %q", fmt.Sprint(last.Content))
	}
}

func TestBangLxoWithoutLixbonDesktop(t *testing.T) {
	h := newHarness(t, nil)
	h.chat.Session.Orch = func() orch.Info { return orch.Info{} }
	h.send("! lxo attention")
	h.settle()
	contains(t, h.out(), "No se encontró lxo")
}

func TestStartupSummaryHintSaysWhatToTypeInTheChat(t *testing.T) {
	h := newHarness(t, nil)
	withSummary(h, []string{"Lixbon · 1 tarea activa · 1 pide atención (1 pregunta)", "  → lxo attention para verla"}, nil)
	h.update(h.m.coreSummaryCmd()())
	contains(t, h.out(), "→ ! lxo attention para verla")
}

// lxoFixture lee un snapshot publicado del --json de lxo (docs/core/fixtures/lxo, LXO-125): los genera
// apps/desktop/lxo y fallan allí si cambian sin subir su `v`.
func lxoFixture(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "core", "fixtures", "lxo", name))
	if err != nil {
		t.Fatalf("falta el snapshot de lxo %s: %v", name, err)
	}
	return string(raw)
}

// El chat pinta la forma 1 que publica lxo (la que da por defecto) y no lee a medias la forma 2 del modelo
// Task/Attempt: dice que no la pinta y cómo verla.
func TestLxoViewsReadThePublishedLegacySnapshots(t *testing.T) {
	tasks := render(t, []string{"tasks"}, lxoFixture(t, "tasks.v1.json"), 100)
	for _, want := range []string{"tarea t1", "tarea t2", "tarea t3", "tarea t9", "lxo/t2"} {
		contains(t, tasks, want)
	}
	show := render(t, []string{"task", "show", "t2"}, lxoFixture(t, "task_show.v1.json"), 100)
	for _, want := range []string{"tarea t2", "agent_idle_timeout", "La tarea falló."} {
		contains(t, show, want)
	}
	for _, c := range []struct {
		args []string
		doc  string
	}{{[]string{"tasks"}, "tasks.v2.json"}, {[]string{"task", "show", "t3"}, "task_show.v2.json"}} {
		out := render(t, c.args, lxoFixture(t, c.doc), 100)
		contains(t, out, "forma (v2) que este CLI no pinta")
		if strings.Contains(out, "API de sesiones") {
			t.Fatalf("la forma 2 no se pinta a medias:\n%s", out)
		}
	}
	if lxoStyled([]string{"tasks", "--schema", "2"}) {
		t.Fatal("con --schema, lxo sale tal cual")
	}
}
