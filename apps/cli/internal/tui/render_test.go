package tui

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/agent"
)

var updateGoldens = flag.Bool("update", false, "reescribe los goldens de testdata/blocks")

var goldenWidths = []int{40, 80, 120}

// golden pinta b a 40, 80 y 120 columnas sin color y lo compara con
// testdata/blocks/<name>.golden. Además, ninguna fila puede pasarse del ancho.
func golden(t *testing.T, name string, b block, open bool) {
	t.Helper()
	var parts []string
	for _, w := range goldenWidths {
		out := b.render(w, open)
		for _, line := range strings.Split(out, "\n") {
			if got := ansi.StringWidth(line); got > w {
				t.Errorf("%s a %d columnas: una fila mide %d: %q", name, w, got, ansi.Strip(line))
			}
		}
		parts = append(parts, fmt.Sprintf("── %d ──\n%s", w, strings.TrimRight(ansi.Strip(out), " ")))
	}
	got := strings.Join(parts, "\n") + "\n"
	path := filepath.Join("testdata", "blocks", name+".golden")
	if *updateGoldens {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (go test -run Golden -update los crea)", err)
	}
	if want := strings.ReplaceAll(string(raw), "\r\n", "\n"); got != want {
		t.Errorf("%s no coincide con su golden.\n--- se obtuvo ---\n%s--- se esperaba ---\n%s", name, got, want)
	}
}

func outputLines(n int) string {
	lines := make([]string, n)
	for i := range lines {
		lines[i] = fmt.Sprintf("línea %d", i+1)
	}
	return strings.Join(lines, "\n")
}

func TestGoldenBlocks(t *testing.T) {
	spin := 0
	read := newToolBlock(agent.Event{Tool: "read_file", Text: "src/app.py", ReadOnly: true, Meta: "128 líneas"}, &spin)
	read.state = toolDone

	running := newToolBlock(agent.Event{Tool: "run_command", Change: &agent.Change{Kind: "command", Detail: "go test ./..."}}, &spin)

	waiting := newToolBlock(agent.Event{Tool: "write_file", Change: &agent.Change{Kind: "create", Path: "nuevo.txt", NewText: "hola\n"}, Adds: 1}, &spin)
	waiting.state = toolWaiting

	edit := newToolBlock(agent.Event{Tool: "edit_file", Change: &agent.Change{Kind: "update", Path: "session.go",
		OldText: "func New() *S {\n\treturn &S{}\n}\n", NewText: "func New() *S {\n\ts := &S{created: time.Now()}\n\treturn s\n}\n"}, Adds: 2, Dels: 1}, &spin)
	edit.finish(agent.Event{Summary: "1 reemplazo", Check: "gofmt: sin errores", Elapsed: 300 * time.Millisecond})

	failed := newToolBlock(agent.Event{Tool: "edit_file", Change: &agent.Change{Kind: "update", Path: "a.go"}}, &spin)
	failed.finish(agent.Event{Summary: "old_text no coincide con el archivo", Failed: true})

	long := newToolBlock(agent.Event{Tool: "run_command", Change: &agent.Change{Kind: "command", Detail: "go test ./internal/..."}}, &spin)
	long.finish(agent.Event{Result: "[EXIT 0] " + outputLines(11), Elapsed: 3400 * time.Millisecond})

	broken := newToolBlock(agent.Event{Tool: "run_command", Change: &agent.Change{Kind: "command", Detail: "npm test"}}, &spin)
	broken.finish(agent.Event{Result: "[EXIT 1] FAIL src/app.test.js\n1 failed", Failed: true, Elapsed: 2 * time.Second})

	timeout := newToolBlock(agent.Event{Tool: "run_command", Change: &agent.Change{Kind: "command", Detail: "sleep 99"}}, &spin)
	timeout.finish(agent.Event{Result: "[TIMEOUT] El comando superó 30 s.", Failed: true})

	shell := &toolBlock{shell: true, verb: "Ejecutar", target: "git status", state: toolDone}
	shell.setOutput("[EXIT 0] On branch main\nnothing to commit")

	mcp := newToolBlock(agent.Event{Tool: "MCP", Text: "git › status  {\"path\":\".\"}"}, &spin)
	mcp.finish(agent.Event{Summary: "limpio"})

	group := &readGroupBlock{items: []readItem{
		{tool: "read_file", target: "src/auth/session.go", meta: "128 líneas"},
		{tool: "search", target: "«FromConfig» en src/", meta: "6 coincidencias"},
		{tool: "read_file", target: "falta.go", failed: true, summary: "no existe el archivo"},
	}, elapsed: 800 * time.Millisecond}

	big := make([]agent.DiffRow, 45)
	for i := range big {
		big[i] = agent.DiffRow{Kind: "add", NewNo: i + 1, Text: fmt.Sprintf("x := %d", i)}
	}
	bigEdit := &toolBlock{verb: "Crear", target: "big.go", adds: 45, counts: true, state: toolDone, diff: &diffView{rows: big, path: "big.go"}}

	cases := []struct {
		name string
		b    block
		open bool
	}{
		{"user", userBlock{text: "refactoriza el login para usar el nuevo cliente y añade pruebas [IMG#1]",
			chips: []imageChip{{n: 1, name: "captura.png", w: 1280, h: 720, size: 188416}}}, false},
		{"echo_key", echoBlock("/key lixbon_sk_1234567890abcdef"), false},
		{"think_closed", thinkBlock{text: "Primero miro cómo se usa el cliente.", secs: 4.2}, false},
		{"think_open", thinkBlock{text: "Primero miro cómo se usa el cliente.\nLuego separo NewSession.", secs: 4.2}, true},
		{"tool_read", read, false},
		{"tool_running", running, false},
		{"tool_waiting", waiting, false},
		{"tool_edit", edit, false},
		{"tool_failed", failed, false},
		{"command_folded", long, false},
		{"command_open", long, true},
		{"command_exit1", broken, false},
		{"command_timeout", timeout, false},
		{"shell", shell, false},
		{"mcp", mcp, false},
		{"reads_closed", group, false},
		{"reads_open", group, true},
		{"diff_folded", bigEdit, false},
		{"todo", &todoBlock{items: []todoItem{{Text: "Leer el cliente", Status: "done"}, {Text: "Añadir pruebas", Status: "doing"}, {Text: "Revisar el CI", Status: "pending"}}}, false},
		{"answer", answerBlock{text: "Listo. Separé la creación de la sesión.\nLas pruebas cubren los dos casos."}, false},
		{"summary", summaryBlock{actions: 3, files: 1, adds: 4, dels: 1, secs: 9.8}, false},
		{"notices", composite{note("nota al margen"), okLine("Modelo: Qwen"), errLine("Comando desconocido"), warnLine("Hay una versión nueva"),
			infoLine("LIXBON.md encontrado", "se usa como contexto"), askLine("¿Qué base de datos?"), separator("conversación nueva")}, false},
		{"sources", sourcesBlock{"https://go.dev/doc", "Effective Go"}, false},
		{"interrupted", interruptedBlock{}, false},
		{"report", reportBlock{title: "Estado de la sesión", rows: [][2]string{{"Modelo", "qwen"}, {"Ventana de contexto", "16384 tokens"}}, foot: []string{"pie"}}, false},
	}
	for _, c := range cases {
		golden(t, c.name, c.b, c.open)
	}
}

// composite junta varios bloques para un solo golden.
type composite []block

func (c composite) render(width int, open bool) string {
	parts := make([]string, len(c))
	for i, b := range c {
		parts[i] = b.render(width, open)
	}
	return strings.Join(parts, "\n")
}

func TestToolBlocksFoldOnlyWhenLong(t *testing.T) {
	short := &toolBlock{command: true}
	short.setOutput("[EXIT 0] uno\ndos")
	if short.folds() {
		t.Error("una salida corta no se pliega")
	}
	long := &toolBlock{command: true}
	long.setOutput("[EXIT 0] " + outputLines(7))
	if !long.folds() || long.code != "0" || len(long.output) != 7 {
		t.Errorf("salida larga: folds=%v code=%q líneas=%d", long.folds(), long.code, len(long.output))
	}
	bg := &toolBlock{command: true}
	bg.setOutput("[background b1] en marcha")
	if bg.code != "bg:b1" || bg.state == toolFailed {
		t.Errorf("segundo plano: code=%q state=%v", bg.code, bg.state)
	}
	empty := &toolBlock{command: true}
	empty.setOutput("[EXIT 0] (sin salida)")
	if len(empty.output) != 0 {
		t.Errorf("«(sin salida)» no es salida: %q", empty.output)
	}
}

func TestParseUnifiedSplitsFilesAndNumbersLines(t *testing.T) {
	text := "diff --git a/a.go b/a.go\nindex 1..2 100644\n--- a/a.go\n+++ b/a.go\n@@ -10,3 +10,3 @@ func x() {\n ctx\n-viejo\n+nuevo\n@@ -40 +40,2 @@\n+otra\n" +
		"diff --git a/b.txt b/b.txt\nnew file mode 100644\n--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+hola\n"
	files := parseUnified(text)
	if len(files) != 2 || files[0].path != "a.go" || files[1].path != "b.txt" {
		t.Fatalf("archivos: %+v", files)
	}
	a := files[0]
	if a.adds != 2 || a.dels != 1 || len(a.rows) != 5 || a.rows[3].Kind != "gap" {
		t.Fatalf("a.go: %+v", a)
	}
	if a.rows[0].OldNo != 10 || a.rows[1].OldNo != 11 || a.rows[2].NewNo != 11 || a.rows[4].NewNo != 40 {
		t.Errorf("numeración: %+v", a.rows)
	}
}

func TestFormatting(t *testing.T) {
	for n, want := range map[int]string{0: "0", 999: "999", 1000: "1.0k", 15300: "15.3k", 2_500_000: "2.5M"} {
		if got := fmtTokens(n); got != want {
			t.Errorf("fmtTokens(%d) = %q", n, got)
		}
	}
	for pct, want := range map[float64]string{0: "▱▱▱▱▱▱▱▱", 50: "▰▰▰▰▱▱▱▱", 100: "▰▰▰▰▰▰▰▰", 150: "▰▰▰▰▰▰▰▰", -5: "▱▱▱▱▱▱▱▱"} {
		if got := contextBar(pct); got != want {
			t.Errorf("contextBar(%v) = %q", pct, got)
		}
	}
	if got := maskKey("lixbon_sk_1234567890abcdef"); got != "lixbon_sk_…cdef" {
		t.Errorf("maskKey = %q", got)
	}
}
