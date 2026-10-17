package mcp

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadSpecsPrecedenceKeysAndOrder(t *testing.T) {
	home, ws := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(home, "mcp.json"), "\xef\xbb\xbf"+`{"servers": {
		"github": {"command": "npx", "args": ["-y", "@mcp/github", 8080, true], "env": {"TOKEN": "a", "N": 1, "NADA": null}},
		"remoto": {"url": "https://ej.com/mcp", "headers": {"Authorization": "Bearer x"}},
		"viejo": {"command": "uno"},
		"roto": {"nada": 1},
		"cadena": "no soy un objeto"
	}}`)
	writeFile(t, filepath.Join(ws, ".lixbon", "mcp.json"), `{"mcpServers": {
		"viejo": {"command": "dos", "cwd": "/otra"},
		"nuevo": {"command": "tres"}
	}}`)

	got := LoadSpecs(ws, home)
	want := []Spec{
		{Name: "github", Command: "npx", Args: []string{"-y", "@mcp/github", "8080", "true"}, Env: map[string]string{"TOKEN": "a", "N": "1"}, Cwd: ws},
		{Name: "remoto", URL: "https://ej.com/mcp", Headers: map[string]string{"Authorization": "Bearer x"}},
		{Name: "viejo", Command: "dos", Args: []string{}, Cwd: "/otra"},
		{Name: "nuevo", Command: "tres", Args: []string{}, Cwd: ws},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("specs =\n%+v\nwant\n%+v", got, want)
	}
}

func TestLoadSpecsEmptyServersFallsBackToMcpServers(t *testing.T) {
	ws := t.TempDir()
	writeFile(t, filepath.Join(ws, ".lixbon", "mcp.json"), `{"servers": {}, "mcpServers": {"a": {"command": "x"}}}`)
	if got := LoadSpecs(ws, t.TempDir()); len(got) != 1 || got[0].Name != "a" {
		t.Fatalf("specs = %+v", got)
	}
}

func TestLoadSpecsIgnoresMissingAndInvalidFiles(t *testing.T) {
	home, ws := t.TempDir(), t.TempDir()
	writeFile(t, filepath.Join(home, "mcp.json"), `{no es json`)
	writeFile(t, filepath.Join(ws, ".lixbon", "mcp.json"), `[1, 2]`)
	if got := LoadSpecs(ws, home); len(got) != 0 {
		t.Fatalf("specs = %+v", got)
	}
	if got := LoadSpecs(t.TempDir(), t.TempDir()); len(got) != 0 {
		t.Fatalf("sin archivos = %+v", got)
	}
}

func TestAddServerKeepsTheFileAndAppendsInOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sub", FileName)
	if err := AddServer(path, "uno", map[string]any{"command": "a"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	os.WriteFile(path, append([]byte(`{"nota": 1, `), raw[1:]...), 0o600)
	if err := AddServer(path, "dos", map[string]any{"url": "https://x/mcp"}); err != nil {
		t.Fatal(err)
	}
	if err := AddServer(path, "uno", map[string]any{"command": "b"}); err == nil {
		t.Fatal("un nombre repetido debe rechazarse")
	}
	if err := AddServer(path, "con espacio", map[string]any{"command": "b"}); err == nil {
		t.Fatal("un nombre inválido debe rechazarse")
	}
	specs := LoadSpecs(t.TempDir(), filepath.Dir(path))
	if len(specs) != 2 || specs[0].Name != "uno" || specs[1].Name != "dos" || specs[1].URL != "https://x/mcp" {
		t.Fatalf("servidores: %+v", specs)
	}
	raw, _ = os.ReadFile(path)
	if !strings.Contains(string(raw), `"nota": 1`) {
		t.Fatalf("se perdió una clave del archivo:\n%s", raw)
	}
	os.WriteFile(path, []byte("[1]"), 0o600)
	if err := AddServer(path, "tres", map[string]any{"command": "c"}); err == nil {
		t.Fatal("un archivo que no es un objeto JSON no se pisa")
	}
}
