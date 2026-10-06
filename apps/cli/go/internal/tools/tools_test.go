package tools

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"
)

type fileSpec struct {
	Text string `json:"text"`
	B64  string `json:"b64"`
	Gen  *struct {
		Template string `json:"template"`
		Text     string `json:"text"`
		Count    int    `json:"count"`
		Each     bool   `json:"each"`
	} `json:"gen"`
}

type corpusCase struct {
	Name         string         `json:"name"`
	Tool         string         `json:"tool"`
	Args         map[string]any `json:"args"`
	Unordered    bool           `json:"unordered"`
	Output       *string        `json:"output"`
	OutputLen    int            `json:"output_len"`
	OutputSHA256 string         `json:"output_sha256"`
	OutputHead   string         `json:"output_head"`
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func materialize(t *testing.T, root string, files map[string]fileSpec, emptyDirs []string) {
	t.Helper()
	for rel, spec := range files {
		switch {
		case spec.Gen != nil && spec.Gen.Each:
			for i := 1; i <= spec.Gen.Count; i++ {
				name := strings.ReplaceAll(rel, "{i}", fmt.Sprintf("%03d", i))
				writeFile(t, filepath.Join(root, name), []byte(spec.Gen.Text))
			}
		case spec.Gen != nil:
			var sb strings.Builder
			for i := 1; i <= spec.Gen.Count; i++ {
				sb.WriteString(strings.ReplaceAll(spec.Gen.Template, "{i}", fmt.Sprint(i)))
			}
			writeFile(t, filepath.Join(root, rel), []byte(sb.String()))
		case spec.B64 != "":
			data, err := base64.StdEncoding.DecodeString(spec.B64)
			if err != nil {
				t.Fatal(err)
			}
			writeFile(t, filepath.Join(root, rel), data)
		default:
			writeFile(t, filepath.Join(root, rel), []byte(spec.Text))
		}
	}
	for _, dir := range emptyDirs {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func sortedLines(s string) string {
	lines := strings.Split(s, "\n")
	sort.Strings(lines)
	return strings.Join(lines, "\n")
}

func TestWorkspaceCorpus(t *testing.T) {
	raw, err := os.ReadFile("../../../validation/fixtures/workspace_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Files     map[string]fileSpec `json:"files"`
		EmptyDirs []string            `json:"empty_dirs"`
		Cases     []corpusCase        `json:"cases"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.Cases) == 0 {
		t.Fatal("corpus vacío")
	}
	root := t.TempDir()
	materialize(t, root, corpus.Files, corpus.EmptyDirs)

	for _, c := range corpus.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got := Execute(context.Background(), root, c.Tool, c.Args)
			if c.Output != nil {
				want := *c.Output
				if c.Unordered {
					got, want = sortedLines(got), sortedLines(want)
				}
				if got != want {
					t.Fatalf("salida distinta\n got: %q\nwant: %q", got, want)
				}
				return
			}
			sum := sha256.Sum256([]byte(got))
			if n := utf8.RuneCountInString(got); n != c.OutputLen {
				t.Errorf("longitud %d, esperaba %d\ncabeza: %q", n, c.OutputLen, got[:min(len(got), 300)])
			}
			if hex.EncodeToString(sum[:]) != c.OutputSHA256 {
				t.Errorf("sha256 distinto; cabeza obtenida: %q, esperada: %q", got[:min(len(got), 300)], c.OutputHead)
			}
		})
	}
}

func TestSearchAndFindStopAtLimit(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 320; i++ {
		writeFile(t, filepath.Join(root, "d", fmt.Sprintf("f%03d.txt", i)), []byte("hit\n"))
	}
	ctx := context.Background()
	search := Execute(ctx, root, "search", map[string]any{"pattern": "hit"})
	if lines := strings.Split(search, "\n"); len(lines) != MaxResultLines+1 || lines[MaxResultLines] != "…[1 líneas más]" {
		t.Fatalf("search: %d líneas, última %q", len(lines), lines[len(lines)-1])
	}
	find := Execute(ctx, root, "find_files", map[string]any{"pattern": "d/*.txt"})
	if lines := strings.Split(find, "\n"); len(lines) != MaxResultLines+1 || lines[MaxResultLines] != "…[1 líneas más]" {
		t.Fatalf("find_files: %d líneas, última %q", len(lines), lines[len(lines)-1])
	}
}

func TestPathEscapesAreRejected(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	writeFile(t, filepath.Join(outside, "secreto.txt"), []byte("no"))
	ctx := context.Background()
	for _, path := range []string{"../x", filepath.Join(outside, "secreto.txt"), "a/../../x"} {
		for _, tool := range []string{"read_file", "list_files", "outline", "search"} {
			args := map[string]any{"path": path, "pattern": "no"}
			if got := Execute(ctx, root, tool, args); !strings.Contains(got, "Ruta fuera del workspace permitido") {
				t.Errorf("%s(%q) = %q", tool, path, got)
			}
		}
	}
	if got := Execute(ctx, root, "find_files", map[string]any{"pattern": "../*"}); !strings.HasPrefix(got, "[ERROR]") {
		t.Errorf("find_files con ..: %q", got)
	}
	if err := os.Symlink(outside, filepath.Join(root, "enlace")); err != nil {
		t.Skipf("sin permiso para crear enlaces simbólicos: %v", err)
	}
	if got := Execute(ctx, root, "read_file", map[string]any{"path": "enlace/secreto.txt"}); !strings.Contains(got, "Ruta fuera del workspace permitido") {
		t.Errorf("el enlace permitió salir del workspace: %q", got)
	}
}

func TestCancelStopsLongSearch(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 50; i++ {
		writeFile(t, filepath.Join(root, fmt.Sprintf("f%d.txt", i)), []byte(strings.Repeat("x\n", 1000)))
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := Execute(ctx, root, "search", map[string]any{"pattern": "x"}); !strings.HasPrefix(got, "[ERROR]") {
		t.Fatalf("la búsqueda ignoró la cancelación: %.60q", got)
	}
}

func TestLongLineIsBounded(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "ancho.txt"), []byte(strings.Repeat("a", 3<<20)+"\nfin\n"))
	got := Execute(context.Background(), root, "read_file", map[string]any{"path": "ancho.txt", "start_line": 1, "end_line": 1})
	if !strings.Contains(got, truncatedLineMark) && !strings.Contains(got, "rango truncado") {
		t.Fatalf("la línea de 3 MiB no se acotó: %d bytes", len(got))
	}
	if len(got) > 5*maxReadChars {
		t.Fatalf("salida de %d bytes", len(got))
	}
}

func TestUppercaseExtensionAndDotfiles(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "A.PY"), []byte("def f():\n    pass\n"))
	writeFile(t, filepath.Join(root, ".gitignore"), []byte("x\n"))
	ctx := context.Background()
	if got := Execute(ctx, root, "outline", map[string]any{"path": "A.PY"}); !strings.Contains(got, "    1  def f():") {
		t.Errorf("outline .PY: %q", got)
	}
	if got := Execute(ctx, root, "outline", map[string]any{"path": ".gitignore"}); got != "(sin esqueleto para este tipo; usa read_file)" {
		t.Errorf("outline .gitignore: %q", got)
	}
}

func TestUnavailableAndUnknownTools(t *testing.T) {
	ctx := context.Background()
	if got := Execute(ctx, t.TempDir(), "run_command", map[string]any{}); !strings.Contains(got, "aún no disponible") {
		t.Errorf("run_command: %q", got)
	}
	if got := Execute(ctx, t.TempDir(), "inventada", nil); got != "[ERROR] Herramienta no soportada: inventada" {
		t.Errorf("inventada: %q", got)
	}
}

func writeDocx(t *testing.T, path, body string) {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("word/document.xml")
	fmt.Fprintf(w, `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>%s</w:body></w:document>`, body)
	zw.Close()
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadFileExtractsDocxText(t *testing.T) {
	root := t.TempDir()
	writeDocx(t, filepath.Join(root, "informe.docx"),
		`<w:p><w:r><w:t>uno</w:t></w:r></w:p><w:p><w:r><w:t>dos</w:t></w:r></w:p><w:p><w:r><w:t>tres</w:t></w:r></w:p>`)
	got, err := ReadFile(context.Background(), root, "informe.docx", 0, 0)
	if err != nil || got != "uno\ndos\ntres" {
		t.Fatalf("got %q, %v", got, err)
	}
	got, err = ReadFile(context.Background(), root, "informe.docx", 2, 3)
	if err != nil || got != "(líneas 2-3 de 3)\ndos\ntres" {
		t.Fatalf("rango: %q, %v", got, err)
	}
}

func TestReadFileReportsAnUnreadableDocument(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "roto.docx"), []byte("no es un zip"), 0o644)
	os.WriteFile(filepath.Join(root, "roto.pdf"), []byte("no es un pdf"), 0o644)
	for _, name := range []string{"roto.docx", "roto.pdf"} {
		if _, err := ReadFile(context.Background(), root, name, 0, 0); err == nil {
			t.Fatalf("%s: esperaba un error claro", name)
		}
	}
}
