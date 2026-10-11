//go:build windows

package process

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCommandRunsABatchFileFromAPathWithSpacesAndQuotedArgs(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "Program Files", "nodejs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "eco.cmd")
	if err := os.WriteFile(script, []byte("@echo [%1] [%~2]\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := Command(dir, script, "-y", "Authorization:Bearer clave").CombinedOutput()
	if err != nil || strings.TrimSpace(string(out)) != "[-y] [Authorization:Bearer clave]" {
		t.Fatalf("salida %q, error %v", out, err)
	}
}
