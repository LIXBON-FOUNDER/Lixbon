package tools

import (
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestShowImageTellsTheInterface(t *testing.T) {
	tb := newBox(t)
	f, err := os.Create(filepath.Join(tb.Root, "foto.png"))
	if err != nil {
		t.Fatal(err)
	}
	png.Encode(f, image.NewRGBA(image.Rect(0, 0, 30, 20)))
	f.Close()
	var shown []ShownImage
	tb.OnImage = func(img ShownImage) { shown = append(shown, img) }

	out := tb.run("show_image", map[string]any{"path": "foto.png", "caption": " la portada "})
	if out != "Imagen enseñada al usuario: foto.png (30×20). Ya la ve: no la describas si no te lo pide." {
		t.Fatalf("resultado: %q", out)
	}
	if len(shown) != 1 || shown[0].Name != "foto.png" || shown[0].Mime != "image/png" || shown[0].W != 30 || shown[0].Caption != "la portada" {
		t.Fatalf("imagen: %+v", shown)
	}

	os.WriteFile(filepath.Join(tb.Root, "notas.txt"), []byte("hola"), 0o644)
	for path, want := range map[string]string{"notas.txt": "no es una imagen", "nada.png": "no existe", ".": "es una carpeta"} {
		if out := tb.run("show_image", map[string]any{"path": path}); !strings.HasPrefix(out, "[ERROR]") || !strings.Contains(out, want) {
			t.Errorf("%s: %q", path, out)
		}
	}
	if len(shown) != 1 {
		t.Fatal("un fallo no enseña nada")
	}
}

// Con una URL, show_image descarga la imagen él mismo: sin curl de por medio.
func TestShowImageDownloadsAURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/texto" {
			w.Write([]byte("<html>no</html>"))
			return
		}
		png.Encode(w, image.NewRGBA(image.Rect(0, 0, 12, 8)))
	}))
	defer srv.Close()
	tb := newBox(t)
	var shown []ShownImage
	tb.OnImage = func(img ShownImage) { shown = append(shown, img) }

	out := tb.run("show_image", map[string]any{"path": srv.URL + "/fotos/dados.png"})
	if !strings.HasPrefix(out, "Imagen enseñada al usuario: 127.0.0.1") || !strings.Contains(out, "/fotos/dados.png (12×8)") {
		t.Fatalf("resultado: %q", out)
	}
	if len(shown) != 1 || filepath.Ext(shown[0].Path) != ".png" || shown[0].Mime != "image/png" {
		t.Fatalf("imagen: %+v", shown)
	}
	defer os.Remove(shown[0].Path)
	if out := tb.run("show_image", map[string]any{"path": srv.URL + "/texto"}); !strings.Contains(out, "no es una imagen") {
		t.Fatalf("una página no es una imagen: %q", out)
	}
}

func TestScreenshotsAreSavedForShowImage(t *testing.T) {
	path, err := saveScreenshot([]byte{0xff, 0xd8, 0xff})
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	if filepath.Dir(path) != ScreenshotDir() || ImageMime(path) != "image/jpeg" {
		t.Fatalf("captura: %s", path)
	}
}
