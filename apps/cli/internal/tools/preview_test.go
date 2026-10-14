package tools

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreviewURL(t *testing.T) {
	tb := newBox(t)
	t.Cleanup(tb.Close)
	for path, content := range map[string]string{
		"web/index.html":    `<script type="module" src="app.js"></script>`,
		"web/app.js":        "console.log(1)",
		"logo.svg":          "<svg/>",
		"notes.go":          "package x",
		".env":              "SECRET=1",
		"lixbon.com/a.html": "",
	} {
		full := filepath.Join(tb.Root, filepath.FromSlash(path))
		os.MkdirAll(filepath.Dir(full), 0o755)
		os.WriteFile(full, []byte(content), 0o644)
	}

	page, ok, err := tb.PreviewURL("web/index.html")
	if !ok || err != nil || !strings.HasPrefix(page, "http://127.0.0.1:") || !strings.HasSuffix(page, "/web/index.html") {
		t.Fatalf("archivo del workspace: %q %v %v", page, ok, err)
	}
	base := strings.TrimSuffix(page, "/web/index.html")
	if dir, _, _ := tb.PreviewURL("./web"); dir != base+"/web/" {
		t.Fatalf("carpeta: %q", dir)
	}
	abs := filepath.Join(tb.Root, "logo.svg")
	fileURL := (&url.URL{Scheme: "file", Path: "/" + filepath.ToSlash(abs)}).String()
	for _, raw := range []string{abs, fileURL} {
		if got, ok, err := tb.PreviewURL(raw); !ok || err != nil || got != base+"/logo.svg" {
			t.Fatalf("ruta absoluta o file:// %q: %q %v", raw, got, err)
		}
	}

	if got, ok, _ := tb.PreviewURL("./lixbon.com/a.html"); !ok || !strings.HasSuffix(got, "/lixbon.com/a.html") {
		t.Fatalf("una carpeta con nombre de dominio se abre con su ruta: %q", got)
	}
	for _, raw := range []string{"lixbon.com", "https://lixbon.com", "example.org", "localhost:3000", "127.0.0.1:8080/x", "about:blank"} {
		if _, ok, _ := tb.PreviewURL(raw); ok {
			t.Errorf("%q es una URL, no un archivo", raw)
		}
	}
	for raw, want := range map[string]string{
		"falta.html":                          "no existe",
		"../fuera.html":                       "fuera del workspace",
		".env":                                "oculto",
		"notes.go":                            "no abre archivos .go",
		"web/app.js":                          "no es una página: se carga desde el HTML que lo usa, ábrelo a él (web/index.html)",
		filepath.Join(os.TempDir(), "x.html"): "fuera del workspace",
	} {
		if _, ok, err := tb.PreviewURL(raw); !ok || err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: ok=%v err=%v, se esperaba %q", raw, ok, err, want)
		}
	}

	get := func(u, host string) (*http.Response, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", u, nil)
		if host != "" {
			req.Host = host
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return res, string(body)
	}
	if res, body := get(base+"/web/app.js", ""); res.StatusCode != 200 || body != "console.log(1)" ||
		!strings.HasPrefix(res.Header.Get("Content-Type"), "text/javascript") {
		t.Fatalf("los módulos necesitan text/javascript: %d %q %q", res.StatusCode, res.Header.Get("Content-Type"), body)
	}
	if res, _ := get(base+"/.env", ""); res.StatusCode != 404 {
		t.Fatalf("los archivos ocultos no se sirven: %d", res.StatusCode)
	}
	if res, _ := get(base+"/web/index.html", "evil.test"); res.StatusCode != 403 {
		t.Fatalf("otro Host (rebinding de DNS) se rechaza: %d", res.StatusCode)
	}
	tb.Close()
	if _, err := http.Get(page); err == nil {
		t.Fatal("al cerrar la sesión se apaga el servidor")
	}
}
