package mcp

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestRealFilesystemServer necesita red y Node: solo corre con LIXBON_MCP_REAL=1.
func TestRealFilesystemServer(t *testing.T) {
	if os.Getenv("LIXBON_MCP_REAL") == "" {
		t.Skip("define LIXBON_MCP_REAL=1 para probar contra @modelcontextprotocol/server-filesystem")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "hola.txt"), []byte("contenido real"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := NewRegistry([]Spec{{Name: "fs", Command: "npx", Args: []string{"-y", "@modelcontextprotocol/server-filesystem", dir}, Cwd: dir}})
	go r.Start()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if !r.Wait(ctx) {
		t.Fatal("el servidor real no arrancó a tiempo")
	}
	if info := r.Summary()[0]; info.Err != "" || info.Tools == 0 {
		t.Fatalf("summary = %+v", info)
	}
	t.Logf("herramientas: %v", toolNames(r))
	got := r.Call(ctx, "mcp__fs__read_text_file", map[string]any{"path": filepath.Join(dir, "hola.txt")})
	if !strings.Contains(got, "contenido real") {
		t.Fatalf("read_text_file = %q", got)
	}
	started := time.Now()
	r.Close()
	t.Logf("Close tardó %v", time.Since(started))
}
