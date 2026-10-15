package tools

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

// browsable son las extensiones que el navegador sabe mostrar o ejecutar.
var browsable = map[string]string{
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
	".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
	".ico": "image/x-icon", ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8", ".xml": "application/xml", ".mp4": "video/mp4", ".webm": "video/webm",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
}

var subresource = map[string]bool{
	".css": true, ".js": true, ".mjs": true, ".json": true, ".wasm": true, ".woff": true, ".woff2": true, ".ttf": true,
}

// pagesNear sugiere los HTML de la carpeta del archivo: « (web/index.html, web/about.html)».
func pagesNear(root, target string) string {
	var pages []string
	dir := filepath.Dir(target)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if ext := strings.ToLower(filepath.Ext(e.Name())); !e.IsDir() && (ext == ".html" || ext == ".htm") && !hidden(e.Name()) {
			rel, _ := filepath.Rel(root, filepath.Join(dir, e.Name()))
			pages = append(pages, filepath.ToSlash(rel))
		}
	}
	if len(pages) == 0 {
		return ""
	}
	if len(pages) > 5 {
		pages = pages[:5]
	}
	return " (" + strings.Join(pages, ", ") + ")"
}

// preview sirve el workspace en 127.0.0.1 para que el navegador del agente
// abra lo que construye como una web de verdad: con file:// no funcionan los
// módulos ES ni fetch de archivos vecinos.
type preview struct {
	mu   sync.Mutex
	root string
	ln   net.Listener
	srv  *http.Server
}

// PreviewURL convierte una ruta del workspace (index.html, docs/, ./a.svg o
// file:///…) en la dirección local con la que abrirla en el navegador. ok es
// false si raw no es una ruta del workspace, sino una URL normal.
func (tb *Toolbox) PreviewURL(raw string) (string, bool, error) {
	p, ok := workspacePath(raw)
	if !ok {
		return "", false, nil
	}
	// «lixbon.com» es la web aunque haya una carpeta con ese nombre; para
	// abrir la carpeta se escribe ./lixbon.com.
	if !strings.ContainsAny(p, `/\`) && strings.Contains(strings.TrimPrefix(p, "."), ".") && !looksLikeFile(p) {
		if info, err := os.Stat(filepath.Join(tb.Root, p)); err != nil || info.IsDir() {
			return "", false, nil
		}
	}
	target, root, err := resolveSafe(tb.Root, p)
	if err != nil {
		return "", true, fmt.Errorf("%s queda fuera del workspace: solo se abren archivos del proyecto", raw)
	}
	info, err := os.Stat(target)
	if err != nil {
		if !looksLikeFile(p) {
			return "", false, nil
		}
		return "", true, fmt.Errorf("no existe %s en el workspace", p)
	}
	rel, _ := filepath.Rel(root, target)
	rel = filepath.ToSlash(rel)
	if hidden(rel) {
		return "", true, fmt.Errorf("%s es un archivo oculto: no se sirve al navegador", p)
	}
	if !info.IsDir() {
		ext := strings.ToLower(filepath.Ext(target))
		if _, ok := browsable[ext]; !ok {
			return "", true, fmt.Errorf("el navegador no abre archivos %s; abre el .html que lo usa%s", filepath.Ext(target), pagesNear(root, target))
		}
		// Los modelos abren cada archivo que crean, también el CSS y el JS, que
		// solos no enseñan nada: se sirven a la página pero no se abren.
		if subresource[ext] {
			return "", true, fmt.Errorf("%s no es una página: se carga desde el HTML que lo usa, ábrelo a él%s. "+
				"Para leer su contenido usa read_file", p, pagesNear(root, target))
		}
	}
	base, err := tb.preview().start(root)
	if err != nil {
		return "", true, err
	}
	u := base + "/" + (&url.URL{Path: rel}).EscapedPath()
	if rel == "." {
		u = base + "/"
	} else if info.IsDir() {
		u += "/"
	}
	return u, true, nil
}

func (tb *Toolbox) preview() *preview {
	tb.previewOnce.Do(func() { tb.previewSrv = &preview{} })
	return tb.previewSrv
}

// workspacePath reconoce lo que el modelo escribe como ruta local: sin
// esquema (index.html, ./web/, C:\proyecto\a.html) o con file://. «lixbon.com»
// también va sin esquema; se decide al ver si existe en el workspace.
func workspacePath(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", false
	}
	if strings.HasPrefix(strings.ToLower(raw), "file:") {
		u, err := url.Parse(raw)
		if err != nil {
			return "", false
		}
		p := u.Path
		// file:///C:/x llega como /C:/x.
		if len(p) > 2 && p[0] == '/' && p[2] == ':' {
			p = p[1:]
		}
		return filepath.FromSlash(p), true
	}
	if filepath.IsAbs(raw) || (len(raw) > 2 && raw[1] == ':') {
		return raw, true
	}
	if strings.Contains(raw, "://") || strings.HasPrefix(raw, "about:") {
		return "", false
	}
	if host, _, _ := strings.Cut(raw, "/"); strings.HasPrefix(host, "localhost") || net.ParseIP(strings.Split(host, ":")[0]) != nil {
		return "", false
	}
	return raw, true
}

func looksLikeFile(p string) bool {
	_, ok := browsable[strings.ToLower(filepath.Ext(p))]
	return ok
}

func hidden(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if strings.HasPrefix(part, ".") && part != "." {
			return true
		}
	}
	return false
}

func (p *preview) start(root string) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ln != nil && p.root == root {
		return "http://" + p.ln.Addr().String(), nil
	}
	p.stopLocked()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", fmt.Errorf("no pude abrir el servidor local para la vista previa: %w", err)
	}
	host := ln.Addr().String()
	files := http.FileServer(http.Dir(root))
	p.root, p.ln = root, ln
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Otra web abierta en el navegador podría apuntar aquí con un dominio
		// propio que resuelva a 127.0.0.1: solo se atiende al host exacto.
		if r.Host != host {
			http.Error(w, "host no permitido", http.StatusForbidden)
			return
		}
		rel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if hidden(rel) {
			http.NotFound(w, r)
			return
		}
		if ct, ok := browsable[strings.ToLower(path.Ext(rel))]; ok {
			// En Windows el tipo sale del registro y a veces da text/plain
			// para .js, y el navegador rechaza el módulo.
			w.Header().Set("Content-Type", ct)
		}
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})}
	p.srv = srv
	// Con la copia local: si stop() llega antes de que arranque la goroutine,
	// p.srv ya es nil y Serve entraría en pánico.
	go func() { _ = srv.Serve(ln) }()
	return "http://" + host, nil
}

func (p *preview) stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stopLocked()
}

func (p *preview) stopLocked() {
	if p.srv != nil {
		_ = p.srv.Close()
	}
	p.srv, p.ln, p.root = nil, nil, ""
}
