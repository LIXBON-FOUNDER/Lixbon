// Package weblogin inicia sesión con la cuenta de lixbon.com a través del
// navegador: PKCE sobre un servidor de bucle local (el mismo flujo que la app
// de escritorio, /ide/connect con client=cli). El CLI nunca ve el correo ni la
// contraseña; recibe un token de un solo uso que canjea por su API key.
package weblogin

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Timeout es cuánto se espera a que el navegador vuelva.
const Timeout = 5 * time.Minute

var (
	ErrCancelled = errors.New("cancelaste el inicio de sesión en el navegador")
	ErrState     = errors.New("la dirección no corresponde a este inicio de sesión")
	ErrNoToken   = errors.New("la dirección no trae el token de acceso")
	ErrTimeout   = errors.New("el navegador no volvió a tiempo")
)

func randomURLSafe(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// challenge es el S256 de PKCE: base64url sin relleno del SHA-256, que es lo
// que comprueba el gateway.
func challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// Session es un inicio de sesión en curso.
type Session struct {
	Verifier string
	State    string
	URL      string

	ln     net.Listener
	srv    *http.Server
	result chan result
	once   sync.Once
}

type result struct {
	token string
	err   error
}

// Start abre el servidor local y prepara la dirección de lixbon.com que hay
// que visitar. server es la raíz del gateway (sin /v1).
func Start(server string) (*Session, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("no se pudo abrir el puerto local: %w", err)
	}
	s := &Session{
		Verifier: randomURLSafe(32),
		State:    randomURLSafe(24),
		ln:       ln,
		result:   make(chan result, 1),
	}
	redirect := fmt.Sprintf("http://127.0.0.1:%d/callback", ln.Addr().(*net.TCPAddr).Port)
	q := url.Values{}
	q.Set("client", "cli")
	q.Set("redirect_uri", redirect)
	q.Set("state", s.State)
	q.Set("challenge", challenge(s.Verifier))
	q.Set("method", "S256")
	s.URL = strings.TrimRight(server, "/") + "/ide/connect?" + q.Encode()

	mux := http.NewServeMux()
	mux.HandleFunc("/callback", s.callback)
	mux.Handle("/fonts/", http.FileServerFS(assets))
	s.srv = &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go s.srv.Serve(ln)
	return s, nil
}

func (s *Session) deliver(r result) { s.once.Do(func() { s.result <- r }) }

// callback recibe la vuelta del navegador. Una petición con otro state no
// interrumpe la espera: podría venir de cualquier página.
func (s *Session) callback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if q.Get("state") != s.State {
		writePage(w, http.StatusBadRequest, toneErr, "Esta dirección no es de este inicio de sesión", "Vuelve a la terminal y empieza de nuevo.")
		return
	}
	if q.Get("error") != "" {
		writePage(w, http.StatusOK, toneWarn, "Inicio de sesión cancelado", "Puedes cerrar esta pestaña y volver a la terminal.")
		s.deliver(result{err: ErrCancelled})
		return
	}
	token := q.Get("token")
	if token == "" {
		writePage(w, http.StatusBadRequest, toneErr, "Falta el token de acceso", "Vuelve a la terminal y empieza de nuevo.")
		return
	}
	writePage(w, http.StatusOK, toneOK, "Ya puedes volver a la terminal", "El CLI de Lixbon termina de iniciar sesión solo. Puedes cerrar esta pestaña.")
	s.deliver(result{token: token})
}

// Wait espera a que el navegador vuelva con el token (o a que se cancele).
func (s *Session) Wait(ctx context.Context) (string, error) {
	select {
	case r := <-s.result:
		return r.token, r.err
	case <-ctx.Done():
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", ErrTimeout
		}
		return "", ctx.Err()
	}
}

func (s *Session) Close() {
	if s.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = s.srv.Shutdown(ctx)
	}
}

// ParseCallbackURL saca el token de la dirección a la que volvió el navegador,
// pegada a mano cuando no puede llegar a esta máquina (SSH, otro equipo).
func ParseCallbackURL(raw, state string) (string, error) {
	raw = strings.Trim(strings.TrimSpace(raw), `"'<>`)
	u, err := url.Parse(raw)
	if err != nil || u.RawQuery == "" {
		return "", ErrNoToken
	}
	q := u.Query()
	if q.Get("error") != "" {
		return "", ErrCancelled
	}
	if got := q.Get("state"); got != "" && got != state {
		return "", ErrState
	}
	token := q.Get("token")
	if token == "" {
		return "", ErrNoToken
	}
	return token, nil
}

// OpenBrowser abre url en el navegador del sistema.
func OpenBrowser(target string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	case "darwin":
		cmd = exec.Command("open", target)
	default:
		cmd = exec.Command("xdg-open", target)
	}
	return cmd.Start()
}
