package tui

import (
	"crypto/rand"
	"encoding/hex"
	"html/template"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"

	"lixbon.com/cli/internal/weblogin"
)

// viewer enseña una imagen entera en el navegador, servida en 127.0.0.1. Con
// el visor del sistema Windows pregunta qué aplicación usar cada vez que se
// instala otra que abre ese tipo de archivo; el navegador abre todas.
type viewer struct {
	mu     sync.Mutex
	base   string
	images map[string]string // token → ruta
}

var imageViewer = &viewer{}

// url devuelve la dirección con la que el navegador ve path. Cada imagen
// tiene un token al azar: el servidor no sirve nada más.
func (v *viewer) url(path string) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.base == "" {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return "", err
		}
		v.base = "http://" + ln.Addr().String()
		v.images = map[string]string{}
		go http.Serve(ln, http.HandlerFunc(v.serve)) //nolint:errcheck
	}
	for token, p := range v.images {
		if p == path {
			return v.base + "/v/" + token, nil
		}
	}
	b := make([]byte, 16)
	rand.Read(b)
	token := hex.EncodeToString(b)
	v.images[token] = path
	return v.base + "/v/" + token, nil
}

func (v *viewer) serve(w http.ResponseWriter, r *http.Request) {
	kind, token, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	v.mu.Lock()
	path, ok := v.images[token]
	v.mu.Unlock()
	if !ok {
		http.NotFound(w, r)
		return
	}
	switch kind {
	case "i":
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, path)
	case "v":
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		viewerPage.Execute(w, struct{ Name, Src string }{filepath.Base(path), "/i/" + token}) //nolint:errcheck
	default:
		http.NotFound(w, r)
	}
}

var viewerPage = template.Must(template.New("visor").Parse(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{.Name}}</title>` +
	`<style>html,body{margin:0;height:100%;background:#111;color:#999;font:13px system-ui,sans-serif}` +
	`body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}` +
	`img{max-width:96vw;max-height:90vh;object-fit:contain;cursor:zoom-in;background:repeating-conic-gradient(#1c1c1c 0 25%,#151515 0 50%) 0 0/16px 16px}` +
	`img.full{max-width:none;max-height:none;cursor:zoom-out}</style></head>` +
	`<body><img src="{{.Src}}" alt="{{.Name}}" onclick="this.classList.toggle('full')"><div>{{.Name}}</div></body></html>`))

// openInViewer abre la imagen en el navegador.
func openInViewer(path string) error {
	u, err := imageViewer.url(path)
	if err != nil {
		return err
	}
	return weblogin.OpenBrowser(u)
}
