package tui

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// El visor sirve la página y la imagen por su token, y nada más.
func TestViewerServesOnlyItsImages(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, `a&b'.png`)
	if err := os.WriteFile(path, []byte("\x89PNG\r\n\x1a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	v := &viewer{}
	page, err := v.url(path)
	if err != nil {
		t.Fatal(err)
	}
	get := func(u string) (int, string) {
		res, err := http.Get(u)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	code, body := get(page)
	if code != 200 || !strings.Contains(body, "a&amp;b&#39;.png") || strings.Contains(body, "a&b") {
		t.Fatalf("página %d: %s", code, body)
	}
	token := page[strings.LastIndex(page, "/")+1:]
	if code, body := get(v.base + "/i/" + token); code != 200 || !strings.HasPrefix(body, "\x89PNG") {
		t.Fatalf("imagen %d", code)
	}
	if code, _ := get(v.base + "/v/otro"); code != 404 {
		t.Fatalf("token desconocido: %d", code)
	}
}
