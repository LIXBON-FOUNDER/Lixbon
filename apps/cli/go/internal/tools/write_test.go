package tools

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

type treeFile struct {
	Text string `json:"text"`
	B64  string `json:"b64"`
}

func (f treeFile) bytes(t *testing.T) []byte {
	if f.B64 == "" {
		return []byte(f.Text)
	}
	b, err := base64.StdEncoding.DecodeString(f.B64)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type tree struct {
	Files map[string]treeFile `json:"files"`
	Dirs  []string            `json:"dirs"`
}

func snapshotTree(t *testing.T, root string) (files map[string]string, dirs []string) {
	t.Helper()
	files = map[string]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		switch {
		case rel == ".":
		case d.IsDir():
			dirs = append(dirs, rel)
		default:
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			files[rel] = string(data)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(dirs)
	return files, dirs
}

func TestEditCorpus(t *testing.T) {
	raw, err := os.ReadFile("../../../validation/fixtures/edit_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Cases []struct {
			Name  string              `json:"name"`
			Files map[string]treeFile `json:"files"`
			Tool  string              `json:"tool"`
			Args  map[string]any      `json:"args"`
			Out   string              `json:"output"`
			After tree                `json:"after"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.Cases) == 0 {
		t.Fatal("corpus vacío")
	}
	for _, c := range corpus.Cases {
		t.Run(c.Name, func(t *testing.T) {
			root := t.TempDir()
			for rel, f := range c.Files {
				writeFile(t, filepath.Join(root, rel), f.bytes(t))
			}
			got := Execute(context.Background(), root, c.Tool, c.Args)
			if got != c.Out {
				t.Fatalf("salida distinta\n got: %q\nwant: %q", got, c.Out)
			}
			files, dirs := snapshotTree(t, root)
			want := map[string]string{}
			for rel, f := range c.After.Files {
				want[rel] = string(f.bytes(t))
			}
			if !reflect.DeepEqual(files, want) {
				t.Errorf("archivos distintos\n got: %q\nwant: %q", files, want)
			}
			wantDirs := append([]string(nil), c.After.Dirs...)
			if len(dirs) != len(wantDirs) || (len(dirs) > 0 && !reflect.DeepEqual(dirs, wantDirs)) {
				t.Errorf("carpetas distintas\n got: %v\nwant: %v", dirs, wantDirs)
			}
		})
	}
}

func run(t *testing.T, root, tool string, args map[string]any) string {
	t.Helper()
	return Execute(context.Background(), root, tool, args)
}

func TestEditRefusesInvalidUTF8(t *testing.T) {
	root := t.TempDir()
	original := []byte("ok \xff\xfe fin\n")
	writeFile(t, filepath.Join(root, "a.txt"), original)
	for _, tool := range []string{"edit_file", "insert_at_line"} {
		got := run(t, root, tool, map[string]any{"path": "a.txt", "old_text": "ok", "new_text": "no", "line": 1, "content": "x"})
		if !strings.Contains(got, "no es UTF-8 válido") {
			t.Errorf("%s: %q", tool, got)
		}
	}
	if data, _ := os.ReadFile(filepath.Join(root, "a.txt")); string(data) != string(original) {
		t.Fatalf("el archivo cambió: %q", data)
	}
}

func TestDeleteRefusesWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.txt"), []byte("x"))
	for _, path := range []string{".", "", "sub/.."} {
		if got := run(t, root, "delete_file", map[string]any{"path": path}); !strings.Contains(got, "raíz del workspace") {
			t.Errorf("delete_file(%q) = %q", path, got)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "a.txt")); err != nil {
		t.Fatalf("se borró contenido del workspace: %v", err)
	}
}

func TestMultiEditOnMissingFileIsNotReportedAsSuccess(t *testing.T) {
	got := run(t, t.TempDir(), "multi_edit", map[string]any{
		"path": "nada.txt", "edits": []any{map[string]any{"old_text": "a", "new_text": "b"}}})
	if got != "Archivo no encontrado: nada.txt" {
		t.Fatalf("got %q", got)
	}
}

func TestWriteThroughFileAsDirectoryFails(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "a.txt"), []byte("x"))
	if got := run(t, root, "write_file", map[string]any{"path": "a.txt/b.txt", "content": "x"}); !strings.HasPrefix(got, "[ERROR]") {
		t.Fatalf("got %q", got)
	}
}

func TestWriteKeepsBytesAndMode(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "a.sh")
	writeFile(t, path, []byte("viejo"))
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
	run(t, root, "write_file", map[string]any{"path": "a.sh", "content": "uno\r\ndos\n"})
	data, _ := os.ReadFile(path)
	if string(data) != "uno\r\ndos\n" {
		t.Fatalf("los saltos de línea se alteraron: %q", data)
	}
	if info, _ := os.Stat(path); info.Mode().Perm()&0o100 == 0 && filepath.Separator == '/' {
		t.Fatalf("se perdió el bit ejecutable: %v", info.Mode())
	}
	if entries, _ := os.ReadDir(root); len(entries) != 1 {
		t.Fatalf("quedaron temporales: %v", entries)
	}
}
