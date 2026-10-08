package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func fakeSpec(name, mode string, env map[string]string) Spec {
	if env == nil {
		env = map[string]string{}
	}
	env["LIXBON_MCP_FAKE"] = mode
	return Spec{Name: name, Command: os.Args[0], Env: env, Cwd: os.TempDir()}
}

func startRegistry(t *testing.T, specs ...Spec) *Registry {
	t.Helper()
	r := NewRegistry(specs)
	t.Cleanup(r.Close)
	go r.Start()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if !r.Wait(ctx) {
		t.Fatal("el arranque no terminó")
	}
	return r
}

func toolNames(r *Registry) []string {
	var names []string
	for _, info := range r.Tools() {
		names = append(names, info.Name)
	}
	return names
}

func TestStdioListsPagedToolsAndCalls(t *testing.T) {
	r := startRegistry(t, fakeSpec("demo", "run", nil))
	want := []string{"mcp__demo__echo", "mcp__demo__fail", "mcp__demo__slow", "mcp__demo__pinged", "mcp__demo__flood", "mcp__demo__exit"}
	if got := toolNames(r); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("herramientas = %v", got)
	}
	if !r.IsMCPTool("mcp__demo__echo") || r.IsMCPTool("write_file") {
		t.Fatal("IsMCPTool")
	}
	if info := r.Summary()[0]; info.Err != "" || info.Tools != 6 || info.Starting {
		t.Fatalf("summary = %+v", info)
	}
	ctx := context.Background()
	if got := r.Call(ctx, "mcp__demo__echo", map[string]any{"alfa": "hola"}); got != "eco: hola" {
		t.Fatalf("echo = %q", got)
	}
	if got := r.Call(ctx, "mcp__demo__fail", nil); got != "[ERROR] roto" {
		t.Fatalf("fail = %q", got)
	}
	if got := r.Call(ctx, "mcp__demo__pinged", nil); got != "true" {
		t.Fatalf("el ping del servidor no se respondió: %q", got)
	}
	if got := r.Call(ctx, "mcp__demo__nada", nil); !strings.HasPrefix(got, "[ERROR] Herramienta MCP desconocida") {
		t.Fatalf("desconocida = %q", got)
	}
}

func TestSchemasKeepPropertyOrderAndPrefixDescription(t *testing.T) {
	r := startRegistry(t, fakeSpec("demo", "run", nil))
	var schema struct {
		Function struct {
			Name        string          `json:"name"`
			Description string          `json:"description"`
			Parameters  json.RawMessage `json:"parameters"`
		} `json:"function"`
	}
	if err := json.Unmarshal(r.ToolSchemas()[0], &schema); err != nil {
		t.Fatal(err)
	}
	if schema.Function.Name != "mcp__demo__echo" || schema.Function.Description != "[MCP demo] Devuelve el texto" {
		t.Fatalf("schema = %+v", schema.Function)
	}
	if params := string(schema.Function.Parameters); strings.Index(params, "zeta") > strings.Index(params, "alfa") {
		t.Fatalf("el orden de propiedades cambió: %s", params)
	}
	var withoutSchema struct {
		Function struct {
			Parameters json.RawMessage `json:"parameters"`
		} `json:"function"`
	}
	_ = json.Unmarshal(r.ToolSchemas()[2], &withoutSchema)
	if string(withoutSchema.Function.Parameters) != `{"type":"object","properties":{}}` {
		t.Fatalf("sin inputSchema: %s", withoutSchema.Function.Parameters)
	}
}

func TestCancelSendsNotificationAndServerSurvives(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "cancel.log")
	r := startRegistry(t, fakeSpec("demo", "run", map[string]string{"LIXBON_MCP_LOG": logPath}))

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond)
		cancel()
	}()
	if got := r.Call(ctx, "mcp__demo__slow", nil); got != "[ERROR] context canceled" {
		t.Fatalf("cancelada = %q", got)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		raw, _ := os.ReadFile(logPath)
		if strings.Contains(string(raw), `"requestId"`) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("el servidor no recibió notifications/cancelled")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if got := r.Call(context.Background(), "mcp__demo__echo", map[string]any{"alfa": "otra"}); got != "eco: otra" {
		t.Fatalf("tras cancelar = %q", got)
	}
}

func TestServerExitIsReportedWithStderr(t *testing.T) {
	r := startRegistry(t, fakeSpec("demo", "run", nil))
	got := r.Call(context.Background(), "mcp__demo__exit", nil)
	if !strings.HasPrefix(got, "[ERROR] el servidor «demo» terminó") || !strings.Contains(got, "me voy") {
		t.Fatalf("exit = %q", got)
	}
	if got := r.Call(context.Background(), "mcp__demo__echo", nil); got != "[ERROR] El servidor MCP «demo» no está en marcha" {
		t.Fatalf("tras morir = %q", got)
	}
}

func TestBrokenServerDoesNotBreakTheOthers(t *testing.T) {
	r := startRegistry(t,
		Spec{Name: "malo", Command: "programa-que-no-existe-xyz", Cwd: os.TempDir()},
		fakeSpec("bueno", "run", nil),
		fakeSpec("viejo", "run", map[string]string{"LIXBON_MCP_PROTO": "1999-01-01"}),
	)
	summary := r.Summary()
	if !strings.Contains(summary[0].Err, "no se pudo lanzar") || summary[1].Err != "" || !strings.Contains(summary[2].Err, "protocolo") {
		t.Fatalf("summary = %+v", summary)
	}
	if len(r.Tools()) != 6 || !strings.HasPrefix(r.Tools()[0].Name, "mcp__bueno__") {
		t.Fatalf("herramientas = %v", toolNames(r))
	}
}

func TestCloseKillsAServerThatIgnoresStdin(t *testing.T) {
	r := NewRegistry([]Spec{fakeSpec("terco", "stubborn", nil)})
	go r.Start()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r.Wait(ctx)
	server, _ := r.Server("terco")
	if !server.Alive() {
		t.Fatalf("no arrancó: %s", server.Err())
	}
	started := time.Now()
	r.Close()
	if elapsed := time.Since(started); elapsed > closeGrace+6*time.Second {
		t.Fatalf("Close tardó %v", elapsed)
	}
	if server.Alive() {
		t.Fatal("el servidor sigue vivo tras Close")
	}
}

func TestCloseBeforeStartIsSafe(t *testing.T) {
	r := NewRegistry([]Spec{fakeSpec("demo", "run", nil)})
	r.Close()
	r.Start()
	if info := r.Summary()[0]; info.Tools != 0 || info.Err == "" {
		t.Fatalf("summary = %+v", info)
	}
}

func TestGetPrompt(t *testing.T) {
	r := startRegistry(t, fakeSpec("demo", "run", nil))
	server, _ := r.Server("demo")
	got, err := server.GetPrompt(context.Background(), "visual", map[string]any{"peticion": "x"})
	if err != nil || got != "hola" {
		t.Fatalf("prompt = %q, %v", got, err)
	}
}

func TestResultIsTruncatedByRunes(t *testing.T) {
	r := startRegistry(t, fakeSpec("demo", "run", nil))
	got := r.Call(context.Background(), "mcp__demo__flood", nil)
	if !strings.HasSuffix(got, "\n…[recortado]") || !utf8.ValidString(got) ||
		utf8.RuneCountInString(strings.TrimSuffix(got, "\n…[recortado]")) != maxResultChars {
		t.Fatalf("recorte incorrecto: %d runas", utf8.RuneCountInString(got))
	}
}

func TestFormatToolResult(t *testing.T) {
	cases := map[string]string{
		`{"content":[{"type":"text","text":"a"},{"type":"text","text":""},{"type":"text","text":"b"}]}`: "a\nb",
		`{"content":[{"type":"image","mimeType":"image/png","data":"AA"}]}`:                             "[imagen image/png: no se puede mostrar aquí]",
		`{"content":[{"type":"resource","resource":{"uri":"file:///x","text":"cuerpo"}}]}`:              "cuerpo",
		`{"content":[{"type":"resource","resource":{"uri":"file:///x"}}]}`:                              "[recurso file:///x]",
		`{"content":[]}`: "(sin contenido)",
		`{}`:             "(sin contenido)",
		`{"isError":true,"content":[{"type":"text","text":"mal"}]}`: "[ERROR] mal",
		`{"content":[],"structuredContent":{"n":1}}`:                `{"n":1}`,
		`{"content":[{"type":"text","text":"  \n"}]}`:               "(sin contenido)",
	}
	for raw, want := range cases {
		if got := FormatToolResult(json.RawMessage(raw)); got != want {
			t.Errorf("%s\n got %q\nwant %q", raw, got, want)
		}
	}
}

func TestExposedNames(t *testing.T) {
	taken := map[string]toolRef{}
	first := uniqueName(taken, "my server", "do-it")
	if first != "mcp__my_server__do_it" {
		t.Fatalf("first = %q", first)
	}
	taken[first] = toolRef{}
	if second := uniqueName(taken, "my_server", "do_it"); second != "mcp__my_server__do_it_2" {
		t.Fatalf("colisión = %q", second)
	}
	long := uniqueName(map[string]toolRef{}, strings.Repeat("s", 40), strings.Repeat("t", 40))
	if len(long) > maxFunctionName {
		t.Fatalf("nombre largo = %d", len(long))
	}
	if long == uniqueName(map[string]toolRef{}, strings.Repeat("s", 40), strings.Repeat("t", 41)) {
		t.Fatal("dos herramientas largas distintas dieron el mismo nombre")
	}
	if slug("ñ-á") != "x" || slug("!!!") != "x" {
		t.Fatal("slug")
	}
}

func TestSchemaWithoutTypeGetsObject(t *testing.T) {
	schema, _ := toolSchema("mcp__a__b", "a", Tool{Name: "b", InputSchema: json.RawMessage(`{"properties":{"x":{}}}`)})
	if !strings.Contains(string(schema), `"type":"object"`) {
		t.Fatalf("schema = %s", schema)
	}
}

func TestTargetNeverShowsCredentials(t *testing.T) {
	spec := Spec{Name: "r", URL: "https://user:secreto@ejemplo.com/mcp?token=abc#frag"}
	if got := spec.Target(); got != "https://ejemplo.com/mcp" {
		t.Fatalf("target = %q", got)
	}
}
