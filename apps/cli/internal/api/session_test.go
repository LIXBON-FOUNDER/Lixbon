package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"lixbon.com/cli/internal/config"
)

// fakeGateway emite access tokens numerados y rota el refresh en cada canje,
// como el gateway real.
type fakeGateway struct {
	t         *testing.T
	mu        sync.Mutex
	valid     string
	refresh   string
	refreshes atomic.Int32
	logouts   []string
	onRefresh func(w http.ResponseWriter) bool
	srv       *httptest.Server
}

func newFakeGateway(t *testing.T) *fakeGateway {
	g := &fakeGateway{t: t, valid: "lixbon_at_1", refresh: "lixbon_rt_1"}
	g.srv = httptest.NewServer(http.HandlerFunc(g.serve))
	t.Cleanup(g.srv.Close)
	return g
}

func (g *fakeGateway) serve(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	switch r.URL.Path {
	case "/api/auth/refresh":
		if g.onRefresh != nil && g.onRefresh(w) {
			return
		}
		var body struct {
			Refresh string `json:"refresh_token"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.Refresh != g.refresh {
			http.Error(w, `{"detail":{"error":"invalid_refresh"}}`, http.StatusUnauthorized)
			return
		}
		n := g.refreshes.Add(1) + 1
		g.valid, g.refresh = fmt.Sprintf("lixbon_at_%d", n), fmt.Sprintf("lixbon_rt_%d", n)
		fmt.Fprintf(w, `{"access_token":%q,"refresh_token":%q,"expires_at":%q}`,
			g.valid, g.refresh, time.Now().Add(30*time.Minute).UTC().Format(time.RFC3339Nano))
	case "/api/auth/logout":
		var body struct {
			Refresh string `json:"refresh_token"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("Authorization") != "" {
			g.t.Error("el logout no lleva Authorization")
		}
		g.logouts = append(g.logouts, body.Refresh)
	default:
		if r.Header.Get("Authorization") != "Bearer "+g.valid {
			http.Error(w, `{"detail":"Sesión inválida o expirada"}`, http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"user":"ana","key_model":null,"plan":{"id":"pro","name":"Pro"}}`)
	}
}

// loggedIn deja un config en disco con una sesión de navegador recién iniciada.
func (g *fakeGateway) loggedIn(t *testing.T, expires time.Time) (*Client, config.Config) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := config.Default()
	cfg.BaseURL = g.srv.URL + "/v1"
	if err := config.Save(path, cfg); err != nil {
		t.Fatal(err)
	}
	cfg = config.Load(path)
	c := FromConfig(cfg)
	if err := c.StartSession(cfg, Tokens{Access: "lixbon_at_1", Refresh: "lixbon_rt_1", ExpiresAt: expires}); err != nil {
		t.Fatal(err)
	}
	return c, cfg
}

func TestAnExpiringAccessIsRenewedBeforeTheRequest(t *testing.T) {
	g := newFakeGateway(t)
	c, cfg := g.loggedIn(t, time.Now().Add(30*time.Second))
	if _, err := c.KeyInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if g.refreshes.Load() != 1 {
		t.Fatalf("refrescos: %d", g.refreshes.Load())
	}
	stored, ok := config.ReadSession(cfg.SessionFile(), cfg.ActiveProfile())
	if !ok || stored.Refresh != "lixbon_rt_2" || stored.Access != "lixbon_at_2" {
		t.Fatalf("sessions.json no guardó la rotación: %+v", stored)
	}
	if again := FromConfig(cfg); again.bearer() != "lixbon_at_2" {
		t.Fatalf("un cliente nuevo lee la sesión renovada: %q", again.bearer())
	}
}

func TestA401RenewsAndRetriesOnce(t *testing.T) {
	g := newFakeGateway(t)
	c, _ := g.loggedIn(t, time.Now().Add(time.Hour))
	g.valid = "lixbon_at_revocado_en_el_servidor"
	if _, err := c.KeyInfo(context.Background()); err != nil {
		t.Fatalf("tras renovar la petición debe salir bien: %v", err)
	}
	if g.refreshes.Load() != 1 {
		t.Fatalf("refrescos: %d", g.refreshes.Load())
	}
}

func TestADeadRefreshSurfacesTheAuthError(t *testing.T) {
	g := newFakeGateway(t)
	c, _ := g.loggedIn(t, time.Now().Add(time.Hour))
	g.valid, g.refresh = "otro", "otro"
	_, err := c.KeyInfo(context.Background())
	if !IsAuth(err) {
		t.Fatalf("sin sesión válida el error es de auth: %v", err)
	}
}

func TestAnotherProcessThatAlreadyRenewedIsAdopted(t *testing.T) {
	g := newFakeGateway(t)
	c, cfg := g.loggedIn(t, time.Now().Add(30*time.Second))
	// Otra terminal con el mismo login ya renovó y guardó el resultado.
	other := FromConfig(cfg)
	if _, err := other.KeyInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.KeyInfo(context.Background()); err != nil {
		t.Fatalf("debe adoptar los tokens de la otra terminal: %v", err)
	}
	if g.refreshes.Load() != 1 {
		t.Fatalf("un solo refresco entre los dos procesos, hubo %d", g.refreshes.Load())
	}
}

func TestARaceAnswered409AdoptsWhatTheWinnerSaved(t *testing.T) {
	g := newFakeGateway(t)
	c, cfg := g.loggedIn(t, time.Now().Add(30*time.Second))
	g.onRefresh = func(w http.ResponseWriter) bool {
		// El otro proceso gana justo antes: guarda su par y el servidor da 409.
		g.valid, g.refresh = "lixbon_at_ganador", "lixbon_rt_ganador"
		_ = config.WriteSession(cfg.SessionFile(), cfg.ActiveProfile(), config.StoredSession{
			Server: config.ServerBase(cfg.BaseURL), Access: g.valid, Refresh: g.refresh,
			ExpiresAt: time.Now().Add(30 * time.Minute),
		})
		g.onRefresh = nil
		http.Error(w, `{"detail":{"error":"refresh_race"}}`, http.StatusConflict)
		return true
	}
	if _, err := c.KeyInfo(context.Background()); err != nil {
		t.Fatalf("tras el 409 se usa lo que guardó el otro: %v", err)
	}
	if c.bearer() != "lixbon_at_ganador" {
		t.Fatalf("token: %q", c.bearer())
	}
}

func TestConcurrentRequestsShareOneRenewal(t *testing.T) {
	g := newFakeGateway(t)
	c, _ := g.loggedIn(t, time.Now().Add(time.Hour))
	g.valid = "caducado"
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.KeyInfo(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if g.refreshes.Load() != 1 {
		t.Fatalf("ocho 401 a la vez deben dar un solo refresco, hubo %d", g.refreshes.Load())
	}
}

func TestCopiesOfTheClientSeeTheRenewedToken(t *testing.T) {
	g := newFakeGateway(t)
	c, _ := g.loggedIn(t, time.Now().Add(30*time.Second))
	copia := *c
	if _, err := copia.KeyInfo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if c.bearer() != copia.bearer() || c.bearer() != "lixbon_at_2" {
		t.Fatalf("original %q copia %q", c.bearer(), copia.bearer())
	}
}

func TestLogoutRevokesTheRefreshAndKeysAreLeftAlone(t *testing.T) {
	g := newFakeGateway(t)
	c, _ := g.loggedIn(t, time.Now().Add(time.Hour))
	if err := c.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	c.SetKey("lixbon_sk_manual")
	if err := c.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(g.logouts) != 1 || g.logouts[0] != "lixbon_rt_1" {
		t.Fatalf("logouts: %v", g.logouts)
	}
	if c.bearer() != "lixbon_sk_manual" {
		t.Fatalf("SetKey abandona la sesión: %q", c.bearer())
	}
}

func TestStartSessionWithAnOlderGatewayUsesTheKey(t *testing.T) {
	g := newFakeGateway(t)
	c, cfg := g.loggedIn(t, time.Now().Add(time.Hour))
	if err := c.StartSession(cfg, Tokens{Access: "lixbon_sk_vieja"}); err != nil {
		t.Fatal(err)
	}
	if c.Session != nil || c.bearer() != "lixbon_sk_vieja" {
		t.Fatalf("session %v bearer %q", c.Session, c.bearer())
	}
	if _, ok := config.ReadSession(cfg.SessionFile(), cfg.ActiveProfile()); ok {
		t.Fatal("la sesión anterior debe borrarse")
	}
}
