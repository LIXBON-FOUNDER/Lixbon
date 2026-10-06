package clipboard

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type dibCase struct {
	Name   string  `json:"name"`
	DIB    string  `json:"dib"`
	Width  int     `json:"width"`
	Height int     `json:"height"`
	RGB    *string `json:"rgb"`
}

func TestDIBToPNGMatchesPython(t *testing.T) {
	raw, err := os.ReadFile("../../../validation/fixtures/documents_corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		DIB []dibCase `json:"dib"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if len(corpus.DIB) == 0 {
		t.Fatal("el corpus no trae casos DIB")
	}
	for _, tc := range corpus.DIB {
		t.Run(tc.Name, func(t *testing.T) {
			dib, _ := base64.StdEncoding.DecodeString(tc.DIB)
			data, ok := DIBToPNG(dib)
			if tc.RGB == nil {
				if ok {
					t.Fatal("Python rechaza este DIB y Go lo aceptó")
				}
				return
			}
			if !ok {
				t.Fatal("Go rechazó un DIB que Python convierte")
			}
			img, err := png.Decode(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			if b := img.Bounds(); b.Dx() != tc.Width || b.Dy() != tc.Height {
				t.Fatalf("tamaño %dx%d, esperaba %dx%d", b.Dx(), b.Dy(), tc.Width, tc.Height)
			}
			want, _ := base64.StdEncoding.DecodeString(*tc.RGB)
			var got []byte
			for y := 0; y < tc.Height; y++ {
				for x := 0; x < tc.Width; x++ {
					r, g, b, a := img.At(x, y).RGBA()
					if a != 0xffff {
						t.Fatalf("el alfa debe descartarse: %d", a)
					}
					got = append(got, byte(r>>8), byte(g>>8), byte(b>>8))
				}
			}
			if !bytes.Equal(got, want) {
				t.Fatalf("píxeles distintos\n got: %v\nwant: %v", got, want)
			}
		})
	}
}

func fakePNG() []byte { return append(append([]byte(nil), pngSignature...), "datos"...) }

func found(string) (string, error)    { return "/usr/bin/x", nil }
func notFound(string) (string, error) { return "", errors.New("no está") }

func TestHelpersTakeTheFirstPNG(t *testing.T) {
	dir := t.TempDir()
	var tried []string
	path, problem := fromHelpers(dir, found, func(name string, _ ...string) ([]byte, error) {
		tried = append(tried, name)
		if name == "wl-paste" {
			return nil, errors.New("sin imagen")
		}
		return fakePNG(), nil
	})
	if problem != "" || filepath.Dir(path) != dir || !strings.HasSuffix(path, ".png") {
		t.Fatalf("path=%q problem=%q", path, problem)
	}
	if strings.Join(tried, ",") != "wl-paste,xclip" {
		t.Fatalf("orden de helpers: %v", tried)
	}
	if data, _ := os.ReadFile(path); !isPNG(data) {
		t.Fatal("el archivo guardado no es un PNG")
	}
}

func TestHelpersReportMissingToolOrEmptyClipboard(t *testing.T) {
	run := func(string, ...string) ([]byte, error) { return []byte("texto"), nil }
	if _, problem := fromHelpers(t.TempDir(), notFound, run); !strings.Contains(problem, "instala") {
		t.Fatalf("sin helpers: %q", problem)
	}
	if _, problem := fromHelpers(t.TempDir(), found, run); problem != "el portapapeles no tiene ninguna imagen" {
		t.Fatalf("portapapeles sin imagen: %q", problem)
	}
}

func TestPruneKeepsTheNewestPastes(t *testing.T) {
	dir := t.TempDir()
	base := time.Now().Add(-time.Hour)
	for i := 0; i < keepPastes+5; i++ {
		path := filepath.Join(dir, "paste-"+strings.Repeat("a", i+1)+".png")
		os.WriteFile(path, fakePNG(), 0o600)
		os.Chtimes(path, base.Add(time.Duration(i)*time.Second), base.Add(time.Duration(i)*time.Second))
	}
	os.WriteFile(filepath.Join(dir, "otro.txt"), nil, 0o600)
	prune(dir)
	left, _ := filepath.Glob(filepath.Join(dir, "paste-*.png"))
	if len(left) != keepPastes {
		t.Fatalf("quedan %d capturas", len(left))
	}
	if _, err := os.Stat(filepath.Join(dir, "paste-a.png")); err == nil {
		t.Fatal("la más antigua debía borrarse")
	}
	if _, err := os.Stat(filepath.Join(dir, "otro.txt")); err != nil {
		t.Fatal("solo se podan las capturas")
	}
}
