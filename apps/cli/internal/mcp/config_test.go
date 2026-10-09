package mcp

import (
	"os"
	"path/filepath"
	"reflect"
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
