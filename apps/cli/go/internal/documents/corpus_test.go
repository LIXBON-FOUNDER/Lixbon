package documents

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

const corpusPath = "../../../validation/fixtures/documents_corpus.json"

type extraction struct {
	Name        string   `json:"name"`
	Kind        string   `json:"kind"`
	File        string   `json:"file"`
	DocumentXML string   `json:"document_xml"`
	Compare     string   `json:"compare"`
	Contains    []string `json:"contains"`
	Expected    string   `json:"expected"`
	Error       string   `json:"error"`
	KnownGap    string   `json:"known_gap"`
}

type corpus struct {
	MaxPDFPages   int                        `json:"max_pdf_pages"`
	MaxImageBytes int                        `json:"max_image_bytes"`
	MaxTextAttach int                        `json:"max_text_attachment_bytes"`
	Files         map[string]json.RawMessage `json:"files"`
	DocxTemplate  string                     `json:"docx_template"`
	Extraction    []extraction               `json:"extraction"`
	Attachments   []attachmentCase           `json:"attachments"`
	Blocks        []blockCase                `json:"blocks"`
	EncodeImage   []encodeCase               `json:"encode_image"`
	Markers       []markerCase               `json:"markers"`
}

type attachmentCase struct {
	Name     string `json:"name"`
	Text     string `json:"text"`
	Expected struct {
		Clean  string      `json:"clean"`
		Images []string    `json:"images"`
		Files  [][2]string `json:"files"`
		Errors []string    `json:"errors"`
	} `json:"expected"`
}

type blockCase struct {
	Files    [][2]string `json:"files"`
	Expected string      `json:"expected"`
}

type encodeCase struct {
	Name     string            `json:"name"`
	Files    map[string]string `json:"files"`
	Path     string            `json:"path"`
	Expected string            `json:"expected"`
	Error    string            `json:"error"`
}

type markerCase struct {
	Text     string   `json:"text"`
	Expected []string `json:"expected"`
}

func loadCorpus(t *testing.T) corpus {
	t.Helper()
	raw, err := os.ReadFile(corpusPath)
	if err != nil {
		t.Fatal(err)
	}
	var c corpus
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func decode(t *testing.T, b64 string) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func writeFile(t *testing.T, root, rel string, data []byte) string {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func corpusFile(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	var encoded string
	if json.Unmarshal(raw, &encoded) == nil {
		return decode(t, encoded)
	}
	var fill struct {
		Fill string `json:"fill"`
		Size int    `json:"size"`
	}
	if err := json.Unmarshal(raw, &fill); err != nil {
		t.Fatal(err)
	}
	return bytes.Repeat([]byte(fill.Fill), fill.Size)
}

func docxWith(t *testing.T, template []byte, documentXML string) []byte {
	t.Helper()
	src, err := zip.NewReader(bytes.NewReader(template), int64(len(template)))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	dst := zip.NewWriter(&out)
	for _, f := range src.File {
		w, err := dst.Create(f.Name)
		if err != nil {
			t.Fatal(err)
		}
		if f.Name == "word/document.xml" {
			io.WriteString(w, documentXML)
			continue
		}
		r, _ := f.Open()
		io.Copy(w, r)
		r.Close()
	}
	dst.Close()
	return out.Bytes()
}

func words(s string) string { return strings.Join(strings.Fields(s), " ") }

func TestLimitsMatchPython(t *testing.T) {
	c := loadCorpus(t)
	if c.MaxPDFPages != MaxPDFPages || c.MaxImageBytes != MaxImageBytes || c.MaxTextAttach != MaxTextAttachmentBytes {
		t.Fatalf("límites distintos: corpus %+v", c)
	}
}

func TestExtraction(t *testing.T) {
	c := loadCorpus(t)
	template := decode(t, c.DocxTemplate)
	for _, tc := range c.Extraction {
		t.Run(tc.Name, func(t *testing.T) {
			var data []byte
			if tc.DocumentXML != "" {
				data = docxWith(t, template, tc.DocumentXML)
			} else {
				data = decode(t, tc.File)
			}
			path := writeFile(t, t.TempDir(), "documento."+tc.Kind, data)
			var got string
			var err error
			if tc.Kind == "pdf" {
				got, err = PDFText(path)
			} else {
				got, err = DocxText(path)
			}
			if tc.KnownGap != "" {
				t.Logf("límite conocido: %s (err=%v)", tc.KnownGap, err)
				return
			}
			if tc.Error != "" {
				if err == nil {
					t.Fatalf("esperaba error (%s), devolvió %q", tc.Error, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("error inesperado: %v", err)
			}
			switch tc.Compare {
			case "exact":
				if got != tc.Expected {
					t.Fatalf("texto distinto\n got: %q\nwant: %q", got, tc.Expected)
				}
			case "words":
				if words(got) != words(tc.Expected) {
					t.Fatalf("palabras distintas\n got: %q\nwant: %q", words(got), words(tc.Expected))
				}
			case "contains":
				for _, phrase := range tc.Contains {
					if !strings.Contains(words(got), words(phrase)) {
						t.Errorf("falta %q en %q", phrase, words(got))
					}
				}
			default:
				t.Fatalf("modo de comparación %q", tc.Compare)
			}
		})
	}
}

func TestAttachments(t *testing.T) {
	c := loadCorpus(t)
	root := t.TempDir()
	for rel, raw := range c.Files {
		writeFile(t, root, rel, corpusFile(t, raw))
	}
	realRoot := resolvePath(root)
	for _, tc := range c.Attachments {
		t.Run(tc.Name, func(t *testing.T) {
			got := ParseAttachments(tc.Text, root)
			if got.Clean != tc.Expected.Clean {
				t.Errorf("clean: %q, esperaba %q", got.Clean, tc.Expected.Clean)
			}
			images := []string{}
			for _, img := range got.Images {
				rel, err := filepath.Rel(realRoot, img)
				if err != nil {
					t.Fatal(err)
				}
				images = append(images, filepath.ToSlash(rel))
			}
			if !reflect.DeepEqual(images, orEmpty(tc.Expected.Images)) {
				t.Errorf("imágenes: %v, esperaba %v", images, tc.Expected.Images)
			}
			files := [][2]string{}
			for _, f := range got.Files {
				files = append(files, [2]string{f.Name, f.Content})
			}
			if len(files) != len(tc.Expected.Files) || (len(files) > 0 && !reflect.DeepEqual(files, tc.Expected.Files)) {
				t.Errorf("archivos: %q, esperaba %q", files, tc.Expected.Files)
			}
			if strings.Join(got.Errors, "\n") != strings.Join(tc.Expected.Errors, "\n") {
				t.Errorf("errores: %q, esperaba %q", got.Errors, tc.Expected.Errors)
			}
		})
	}
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func TestBlock(t *testing.T) {
	for _, tc := range loadCorpus(t).Blocks {
		files := make([]File, len(tc.Files))
		for i, f := range tc.Files {
			files[i] = File{f[0], f[1]}
		}
		if got := Block(files); got != tc.Expected {
			t.Errorf("Block(%q)\n got: %q\nwant: %q", tc.Files, got, tc.Expected)
		}
	}
}

func TestEncodeImage(t *testing.T) {
	for _, tc := range loadCorpus(t).EncodeImage {
		t.Run(tc.Name, func(t *testing.T) {
			root := t.TempDir()
			for rel, data := range tc.Files {
				writeFile(t, root, rel, decode(t, data))
			}
			got, err := EncodeImage(filepath.Join(root, tc.Path))
			if tc.Error != "" {
				if err == nil {
					t.Fatalf("esperaba error %q", tc.Error)
				}
				want := strings.ReplaceAll(tc.Error, "{ROOT}", root)
				if err.Error() != filepath.FromSlash(strings.ReplaceAll(want, "\\", "/")) && err.Error() != want {
					t.Fatalf("error %q, esperaba %q", err, want)
				}
				return
			}
			if err != nil || got != tc.Expected {
				t.Fatalf("got %q, %v; esperaba %q", got, err, tc.Expected)
			}
		})
	}
}

func TestEncodeImageRejectsOversized(t *testing.T) {
	path := writeFile(t, t.TempDir(), "enorme.png", make([]byte, MaxImageBytes+1))
	if _, err := EncodeImage(path); err == nil || !strings.Contains(err.Error(), "8 MB") {
		t.Fatalf("esperaba el límite de 8 MB, obtuve %v", err)
	}
}

func TestImageMarkers(t *testing.T) {
	staged := []string{"uno.png", "dos.png", "tres.png"}
	for _, tc := range loadCorpus(t).Markers {
		got := ParseImageMarkers(tc.Text, staged)
		if len(got) != len(tc.Expected) || (len(got) > 0 && !reflect.DeepEqual(got, tc.Expected)) {
			t.Errorf("ParseImageMarkers(%q) = %v, esperaba %v", tc.Text, got, tc.Expected)
		}
	}
	if ImageMarker(3) != "[IMG#3]" {
		t.Fatal("formato del marcador")
	}
}

func TestDamagedPDFsNeverPanicOrHang(t *testing.T) {
	previous := extractionTimeout
	extractionTimeout = 10 * time.Second
	t.Cleanup(func() { extractionTimeout = previous })

	var original []byte
	for _, tc := range loadCorpus(t).Extraction {
		if tc.Name == "pdf_navegador" {
			original = decode(t, tc.File)
		}
	}
	if original == nil {
		t.Skip("el corpus no trae el PDF del navegador")
	}
	dir := t.TempDir()
	rng := rand.New(rand.NewSource(7))
	for i := 0; i < 60; i++ {
		data := slices.Clone(original)
		switch i % 3 {
		case 0:
			data = data[:rng.Intn(len(data))]
		case 1:
			for k := 0; k < 20; k++ {
				data[rng.Intn(len(data))] = byte(rng.Intn(256))
			}
		default:
			start := rng.Intn(len(data) - 200)
			copy(data[start:], bytes.Repeat([]byte("0 obj <<"), 25))
		}
		path := writeFile(t, dir, "mutado.pdf", data)
		began := time.Now()
		_, _ = PDFText(path)
		if took := time.Since(began); took > 5*time.Second {
			t.Fatalf("mutación %d tardó %v", i, took)
		}
	}
}
