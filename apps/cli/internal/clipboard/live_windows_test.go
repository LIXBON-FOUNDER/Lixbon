package clipboard

import (
	"image/png"
	"os"
	"testing"
)

// Prueba con el portapapeles real: LIXBON_LIVE_CLIPBOARD=1 tras copiar una imagen.
func TestLiveClipboardImage(t *testing.T) {
	if os.Getenv("LIXBON_LIVE_CLIPBOARD") == "" {
		t.Skip("define LIXBON_LIVE_CLIPBOARD=1 con una imagen copiada")
	}
	path, problem := Paste(t.TempDir())
	if problem != "" {
		t.Fatal(problem)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("imagen pegada: %v", img.Bounds())
	if b := img.Bounds(); b.Dx() != 40 || b.Dy() != 20 {
		t.Fatalf("tamaño inesperado %v", b)
	}
	r, g, b, _ := img.At(5, 5).RGBA()
	if r>>8 != 200 || g>>8 != 30 || b>>8 != 30 {
		t.Fatalf("color %d,%d,%d", r>>8, g>>8, b>>8)
	}
}
