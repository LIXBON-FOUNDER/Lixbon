package cloudhost

import (
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// PreviewPort es donde escucha el proxy de vista previa dentro del contenedor.
// El gateway llega a él por el proxy de entrada (con clave) y nadie más.
const PreviewPort = 7000

// previewHandler reenvía /<puerto>/<ruta> a 127.0.0.1:<puerto>/<ruta>.
//
// El gateway manda la ruta completa (/api/coding/sessions/<sid>/preview/<puerto>/…)
// porque el servidor de desarrollo se arranca con esa ruta base. Si responde 404
// a un GET, se reintenta sin el prefijo: así también funciona un servidor
// estático arrancado sin ruta base.
func previewHandler(prefix func(port int) string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		first, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
		port, err := strconv.Atoi(first)
		if err != nil || port < 1024 || port > 65535 || port == PreviewPort {
			http.Error(w, "puerto no válido", http.StatusBadRequest)
			return
		}
		target := &url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(port)}
		path := "/" + rest
		stripped := ""
		if p := strings.TrimSuffix(prefix(port), "/"); p != "" && strings.HasPrefix(path, p) {
			stripped = "/" + strings.TrimPrefix(strings.TrimPrefix(path, p), "/")
		}
		if r.Method == http.MethodGet && stripped != "" && !isUpgrade(r) {
			if tryProxy(w, r, target, path) {
				return
			}
			path = stripped
		}
		proxyTo(w, r, target, path)
	})
}

func isUpgrade(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Connection"), "upgrade") || r.Header.Get("Upgrade") != ""
}

func proxyTo(w http.ResponseWriter, r *http.Request, target *url.URL, path string) {
	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.URL.Path = path
			pr.Out.URL.RawPath = ""
			pr.Out.Host = target.Host
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "nada responde en ese puerto", http.StatusBadGateway)
		},
	}
	rp.ServeHTTP(w, r)
}

// tryProxy hace el GET con la ruta completa y solo escribe la respuesta si no
// es un 404 (devuelve true). Con 404 el llamador reintenta sin prefijo.
func tryProxy(w http.ResponseWriter, r *http.Request, target *url.URL, path string) bool {
	u := *target
	u.Path, u.RawQuery = path, r.URL.RawQuery
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		return false
	}
	for k, v := range r.Header {
		req.Header[k] = v
	}
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return false
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	for k, v := range resp.Header {
		w.Header()[k] = v
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, bytes.NewReader(body))
	return true
}

// startPreview abre el proxy en 0.0.0.0:7000 (el contenedor no publica
// puertos: solo lo alcanza el proxy de entrada por la red de la sesión).
func startPreview(ctx context.Context, prefix func(port int) string) (func(), error) {
	ln, err := net.Listen("tcp", ":"+strconv.Itoa(PreviewPort))
	if err != nil {
		return nil, err
	}
	srv := &http.Server{Handler: previewHandler(prefix), ReadHeaderTimeout: 15 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	return func() { _ = srv.Close() }, nil
}
