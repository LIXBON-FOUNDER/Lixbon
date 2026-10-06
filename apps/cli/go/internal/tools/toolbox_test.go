package tools

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func sleepCommand(seconds int) string {
	if runtime.GOOS == "windows" {
		return "ping -n " + string(rune('0'+seconds/10)) + string(rune('0'+seconds%10)) + " 127.0.0.1 >nul"
	}
	return "sleep " + string(rune('0'+seconds/10)) + string(rune('0'+seconds%10))
}

func newBox(t *testing.T) *Toolbox {
	t.Helper()
	tb := NewToolbox(t.TempDir())
	t.Cleanup(tb.Close)
	return tb
}

func (tb *Toolbox) run(name string, args map[string]any) string {
	return tb.Execute(context.Background(), name, args)
}

func TestRunCommandFormats(t *testing.T) {
	tb := newBox(t)
	cases := []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"command": "echo hola"}, "[EXIT 0] hola"},
		{map[string]any{"command": "echo hola && exit 4"}, "[EXIT 4] hola"},
		{map[string]any{"command": "exit 0"}, "[EXIT 0] (sin salida)"},
		{map[string]any{"command": "   "}, "[ERROR] Falta command"},
		{map[string]any{}, "[ERROR] Falta command"},
	}
	for _, c := range cases {
		if got := tb.run("run_command", c.args); got != c.want {
			t.Errorf("%v = %q, want %q", c.args, got, c.want)
		}
	}
	if !Failed("[EXIT 4] x") || Failed("[EXIT 0] x") || !Failed("[TIMEOUT] x") || !Failed("[ERROR] x") {
		t.Error("Failed clasifica mal")
	}
}

func TestRunCommandRunsInWorkspace(t *testing.T) {
	tb := newBox(t)
	if err := os.WriteFile(tb.Root+"/marca.txt", []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	list := "ls"
	if runtime.GOOS == "windows" {
		list = "dir /b"
	}
	if got := tb.run("run_command", map[string]any{"command": list}); !strings.Contains(got, "marca.txt") {
		t.Fatalf("no corre en el workspace: %q", got)
	}
}

func TestRunCommandTimeout(t *testing.T) {
	tb := newBox(t)
	start := time.Now()
	got := tb.run("run_command", map[string]any{"command": sleepCommand(30), "timeout": 1})
	if !strings.HasPrefix(got, "[TIMEOUT] El comando superó 1s y se mató (con sus procesos hijos).") {
		t.Fatalf("got %q", got)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("tardó %s", time.Since(start))
	}
}

func TestRunCommandCancel(t *testing.T) {
	tb := newBox(t)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(500*time.Millisecond, cancel)
	start := time.Now()
	got := tb.Execute(ctx, "run_command", map[string]any{"command": sleepCommand(30), "timeout": 100})
	if !strings.HasPrefix(got, "[ERROR]") || time.Since(start) > 10*time.Second {
		t.Fatalf("got %q tras %s", got, time.Since(start))
	}
}

func TestBackgroundTools(t *testing.T) {
	tb := newBox(t)
	started := tb.run("run_command", map[string]any{"command": sleepCommand(30), "background": true})
	if !strings.HasPrefix(started, "[background p1] en marcha") {
		t.Fatalf("started: %q", started)
	}
	if got := tb.run("read_output", map[string]any{"id": "p1"}); got != "[p1] sigue en marcha\n(sin salida nueva)" {
		t.Fatalf("read_output: %q", got)
	}
	if got := tb.run("read_output", map[string]any{"id": "p9"}); got != "[ERROR] No hay ningún proceso p9; los activos: p1" {
		t.Fatalf("id desconocido: %q", got)
	}
	if got := tb.run("stop_command", map[string]any{"id": "p1"}); !strings.HasPrefix(got, "[p1] detenido (") {
		t.Fatalf("stop: %q", got)
	}
	if got := tb.run("read_output", map[string]any{"id": "p1"}); got != "[ERROR] No hay ningún proceso p1; los activos: ninguno" {
		t.Fatalf("tras detener: %q", got)
	}
	if got := tb.run("stop_command", map[string]any{"id": "p1"}); got != "[ERROR] No hay ningún proceso p1" {
		t.Fatalf("segundo stop: %q", got)
	}
}

func TestBackgroundImmediateFailureShowsInFirstRead(t *testing.T) {
	tb := newBox(t)
	got := tb.run("run_command", map[string]any{"command": "echo adios && exit 2", "background": true})
	if !strings.HasPrefix(got, "[background p1] terminó con código 2") || !strings.HasSuffix(got, "adios") {
		t.Fatalf("got %q", got)
	}
}

func TestBackgroundReadWaitsForExit(t *testing.T) {
	tb := newBox(t)
	tb.run("run_command", map[string]any{"command": sleepCommand(30), "background": true})
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 600*time.Millisecond)
	defer cancel()
	tb.Execute(ctx, "read_output", map[string]any{"id": "p1", "wait": 30})
	if time.Since(start) > 5*time.Second {
		t.Fatalf("wait ignoró la cancelación: %s", time.Since(start))
	}
}

func TestToolboxFallsBackToStatelessTools(t *testing.T) {
	tb := newBox(t)
	tb.run("write_file", map[string]any{"path": "a.txt", "content": "hola\n"})
	if got := tb.run("read_file", map[string]any{"path": "a.txt"}); got != "hola\n" {
		t.Fatalf("got %q", got)
	}
}

func fetchServer(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/page":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			io.WriteString(w, "<html><script>x</script><p>Hola</p><p>mundo</p></html>")
		case "/sniff":
			io.WriteString(w, "<!DOCTYPE html><body><p>sin cabecera html</p></body>")
		case "/json":
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"a":1}`)
		case "/latin1":
			w.Header().Set("Content-Type", "text/plain; charset=iso-8859-1")
			w.Write([]byte("canci\xf3n \x80"))
		case "/cp1252":
			w.Header().Set("Content-Type", "text/plain; charset=windows-1252")
			w.Write([]byte("canci\xf3n \x80"))
		case "/png":
			w.Header().Set("Content-Type", "image/png; x=y")
			w.Write([]byte("\x89PNG"))
		case "/nolength":
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write([]byte("x"))
		case "/big":
			w.Header().Set("Content-Type", "text/plain")
			io.WriteString(w, strings.Repeat("ñ", 12500))
		case "/empty":
			w.Header().Set("Content-Type", "text/plain")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFetchURL(t *testing.T) {
	srv := fetchServer(t)
	tb := newBox(t)
	cases := map[string]string{
		"/page":     "Hola\n\nmundo",
		"/sniff":    "sin cabecera html",
		"/json":     `{"a":1}`,
		"/latin1":   "canción ",
		"/cp1252":   "canción €",
		"/empty":    "(la página no tiene texto)",
		"/missing":  "[ERROR] HTTP 404 al descargar " + srv.URL + "/missing",
		"/png":      "[ERROR] " + srv.URL + "/png no es texto (image/png)",
		"/nolength": "[ERROR] " + srv.URL + "/nolength no es texto (application/octet-stream)",
	}
	for path, want := range cases {
		if got := tb.run("fetch_url", map[string]any{"url": srv.URL + path}); got != want {
			t.Errorf("%s = %q, want %q", path, got, want)
		}
	}
	big := tb.run("fetch_url", map[string]any{"url": srv.URL + "/big"})
	if !strings.HasSuffix(big, "\n…[recortado: 500 caracteres más]") || len([]rune(big)) != 12000+len([]rune("\n…[recortado: 500 caracteres más]")) {
		t.Errorf("recorte: %d runas, final %q", len([]rune(big)), big[len(big)-40:])
	}
	for _, url := range []string{"ftp://x", "file:///etc/passwd", "", "javascript:1"} {
		if got := tb.run("fetch_url", map[string]any{"url": url}); got != "[ERROR] La URL debe empezar por http:// o https://" {
			t.Errorf("%q = %q", url, got)
		}
	}
	if got := tb.run("fetch_url", map[string]any{"url": "HTTP://" + strings.TrimPrefix(srv.URL, "http://") + "/json"}); got != `{"a":1}` {
		t.Errorf("esquema en mayúsculas: %q", got)
	}
}

func TestFetchURLRespectsCancel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer srv.Close()
	tb := newBox(t)
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	if got := tb.Execute(ctx, "fetch_url", map[string]any{"url": srv.URL}); !strings.HasPrefix(got, "[ERROR]") || time.Since(start) > 5*time.Second {
		t.Fatalf("got %q tras %s", got, time.Since(start))
	}
}

func TestHTMLCorpus(t *testing.T) {
	raw, err := os.ReadFile("../../../validation/fixtures/tool_parse_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		HTMLCases []struct {
			Name string `json:"name"`
			HTML string `json:"html"`
			Text string `json:"text"`
		} `json:"html_cases"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil || len(corpus.HTMLCases) == 0 {
		t.Fatalf("corpus: %v (%d casos)", err, len(corpus.HTMLCases))
	}
	for _, c := range corpus.HTMLCases {
		t.Run(c.Name, func(t *testing.T) {
			if got := htmlToText(c.HTML); got != c.Text {
				t.Fatalf("got %q, want %q", got, c.Text)
			}
		})
	}
}

type fakeSearch struct {
	results []map[string]any
	err     error
	query   string
	limit   int
}

func (f *fakeSearch) WebSearch(ctx context.Context, query string, limit int) ([]map[string]any, error) {
	f.query, f.limit = query, limit
	return f.results, f.err
}

func TestWebSearch(t *testing.T) {
	tb := newBox(t)
	if got := tb.run("web_search", map[string]any{"query": "x"}); got != "[ERROR] La búsqueda web no está disponible en esta sesión" {
		t.Errorf("sin buscador: %q", got)
	}
	fake := &fakeSearch{results: []map[string]any{
		{"title": "Go", "url": "https://go.dev", "snippet": "  El   lenguaje\n Go "},
		{"url": "https://b.test"},
	}}
	tb.Web = fake
	want := "1. Go\n   https://go.dev\n   El lenguaje Go\n\n2. (sin título)\n   https://b.test\n   "
	if got := tb.run("web_search", map[string]any{"query": " go ", "limit": 99}); got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if fake.query != "go" || fake.limit != 10 {
		t.Errorf("query=%q limit=%d", fake.query, fake.limit)
	}
	tb.run("web_search", map[string]any{"query": "x"})
	if fake.limit != 5 {
		t.Errorf("límite por defecto: %d", fake.limit)
	}
	tb.run("web_search", map[string]any{"query": "x", "limit": -3})
	if fake.limit != 1 {
		t.Errorf("límite mínimo: %d", fake.limit)
	}
	if got := tb.run("web_search", map[string]any{"query": "  "}); got != "[ERROR] Falta query" {
		t.Errorf("query vacía: %q", got)
	}
	fake.results = nil
	if got := tb.run("web_search", map[string]any{"query": "x"}); got != "(sin resultados)" {
		t.Errorf("sin resultados: %q", got)
	}
	fake.err = errors.New("502")
	if got := tb.run("web_search", map[string]any{"query": "x"}); got != "[ERROR] Búsqueda web fallida: 502" {
		t.Errorf("fallo: %q", got)
	}
}

func TestTodo(t *testing.T) {
	tb := newBox(t)
	var seenPrev []TodoItem
	tb.OnTodo = func(items, previous []TodoItem) { seenPrev = previous }
	got := tb.run("todo", map[string]any{"items": []any{
		map[string]any{"text": "  uno  ", "status": "DONE"},
		"dos",
		map[string]any{"text": "tres", "status": "raro"},
		map[string]any{"text": "   "},
		42,
	}})
	want := "Lista actualizada: 1/3 hechos.\n[done] uno\n[pending] dos\n[pending] tres"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	tb.run("todo", map[string]any{"items": []any{"a"}})
	if len(seenPrev) != 3 {
		t.Fatalf("previous: %v", seenPrev)
	}
	if got := tb.run("todo", map[string]any{"items": "x"}); got != "[ERROR] items debe ser una lista de {text, status}" {
		t.Fatalf("no lista: %q", got)
	}
	many := make([]any, 40)
	for i := range many {
		many[i] = "paso"
	}
	if got := tb.run("todo", map[string]any{"items": many}); !strings.HasPrefix(got, "Lista actualizada: 0/30 hechos.") {
		t.Fatalf("tope de 30: %.50q", got)
	}
}

func TestAskUser(t *testing.T) {
	tb := newBox(t)
	if got := tb.run("ask_user", map[string]any{"question": "¿a?"}); !strings.HasPrefix(got, "[ask_user no disponible en esta sesión]") {
		t.Fatalf("sin callback: %q", got)
	}
	var gotQuestion string
	var gotOptions []string
	tb.AskUser = func(ctx context.Context, q string, o []string) (string, bool) {
		gotQuestion, gotOptions = q, o
		return "azul", true
	}
	got := tb.run("ask_user", map[string]any{"question": "  ¿color?  ", "options": []any{"rojo", " ", "azul", "a", "b", "c", "d", "e"}})
	if got != "Respuesta del usuario: azul" || gotQuestion != "¿color?" || len(gotOptions) != 6 || gotOptions[1] != "azul" {
		t.Fatalf("got %q q=%q o=%v", got, gotQuestion, gotOptions)
	}
	if got := tb.run("ask_user", map[string]any{"question": " "}); got != "[ERROR] Falta question" {
		t.Fatalf("pregunta vacía: %q", got)
	}
	tb.AskUser = func(context.Context, string, []string) (string, bool) { return "", false }
	if got := tb.run("ask_user", map[string]any{"question": "x"}); !strings.HasPrefix(got, "El usuario no respondió") {
		t.Fatalf("cancelado: %q", got)
	}
	tb.Remote = true
	if got := tb.run("ask_user", map[string]any{"question": "x"}); !strings.HasPrefix(got, "[ask_user no disponible") {
		t.Fatalf("remoto: %q", got)
	}
}
