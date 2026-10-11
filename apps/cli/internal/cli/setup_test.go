package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"lixbon.com/cli/internal/config"
)

type accountGateway struct {
	srv       *httptest.Server
	usage     string
	keyInfo   string
	role      string
	exchanged map[string]any
}

func newAccountGateway(t *testing.T) *accountGateway {
	t.Helper()
	g := &accountGateway{keyInfo: `{"plan":{"name":"Pro"}}`}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/account/usage", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer k" {
			w.WriteHeader(401)
			io.WriteString(w, `{"detail":"sin sesión"}`)
			return
		}
		io.WriteString(w, g.usage)
	})
	mux.HandleFunc("/api/auth/ide/exchange", func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&g.exchanged)
		io.WriteString(w, `{"api_key":"lixbon_sk_web","user":{"email":"ana@ejemplo.com","plan_name":"Pro"}}`)
	})
	mux.HandleFunc("/api/key/info", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer lixbon_sk_buena" {
			w.WriteHeader(401)
			io.WriteString(w, `{"detail":"clave inválida"}`)
			return
		}
		io.WriteString(w, g.keyInfo)
	})
	mux.HandleFunc("/api/model-roles", func(w http.ResponseWriter, r *http.Request) {
		if g.role == "" {
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, `{"roles":{"chat":{"model":"`+g.role+`"}}}`)
	})
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") == "Bearer lixbon_sk_mala" {
			w.WriteHeader(401)
			io.WriteString(w, `{"detail":"clave inválida"}`)
			return
		}
		io.WriteString(w, `{"data":[{"id":"qwen"},{"id":"llama"}]}`)
	})
	g.srv = httptest.NewServer(mux)
	t.Cleanup(g.srv.Close)
	return g
}

func (g *accountGateway) config(extra map[string]any) map[string]any {
	cfg := map[string]any{"base_url": g.srv.URL + "/v1"}
	for k, v := range extra {
		cfg[k] = v
	}
	return cfg
}

func TestUsageMatchesPythonOutput(t *testing.T) {
	g := newAccountGateway(t)
	g.usage = `{"plan":{"name":"Advance"},"buckets":{"session":{"percent":30},"week":{"unlimited":true}}}`
	h := newHarness(t, nil, g.config(map[string]any{"api_key": "k"}))
	if code := h.run("usage"); code != 0 {
		t.Fatalf("code %d: %s", code, h.out)
	}
	want := "Plan Advance\n\n" +
		"Sesion (4h)\n  [#######.................]  30% usado\n\n" +
		"Semana (todos los modelos)\n  [########################]  ilimitado\n"
	if h.out.String() != want {
		t.Fatalf("salida\n got: %q\nwant: %q", h.out, want)
	}
}

func TestUsageBarRoundsLikePython(t *testing.T) {
	g := newAccountGateway(t)
	cases := map[string]string{
		`{"percent":99.5}`: "  [########################]  100% usado",
		`{"percent":0.5}`:  "  [........................]  0% usado",
		`{"percent":2.5}`:  "  [........................]  2% usado",
		`{"percent":133}`:  "  [########################]  100% usado",
	}
	for bucket, want := range cases {
		g.usage = `{"plan":{"name":"x"},"buckets":{"session":` + bucket + `,"week":{}}}`
		h := newHarness(t, nil, g.config(map[string]any{"api_key": "k"}))
		h.run("usage")
		if !strings.Contains(h.out.String(), want+"\n") {
			t.Errorf("%s: %q", bucket, h.out)
		}
	}
}

func TestUsageResetLine(t *testing.T) {
	g := newAccountGateway(t)
	g.usage = `{"plan":{"name":"x"},"buckets":{"session":{"percent":10,"reset_at":"2999-01-01T00:00:00Z"},"week":{}}}`
	h := newHarness(t, nil, g.config(map[string]any{"api_key": "k"}))
	h.run("usage")
	if !strings.Contains(h.out.String(), "  Se reinicia en ") {
		t.Fatalf("falta la línea de reinicio: %q", h.out)
	}
}

func TestUsageFailureAndGenericProvider(t *testing.T) {
	g := newAccountGateway(t)
	h := newHarness(t, nil, g.config(map[string]any{"api_key": "mala"}))
	if code := h.run("usage"); code != 1 || !strings.Contains(h.out.String(), "No se pudo obtener el uso. Verifica tu sesión. Error: sin sesión") {
		t.Fatalf("code %d: %q", code, h.out)
	}

	h = newHarness(t, nil, g.config(map[string]any{
		"api_key": "k", "profile": "local",
		"profiles": map[string]any{"local": map[string]any{"base_url": g.srv.URL + "/v1", "generic": true}},
	}))
	if code := h.run("usage"); code != 1 || !strings.Contains(h.out.String(), "no es un gateway Lixbon") {
		t.Fatalf("proveedor genérico: code %d %q", code, h.out)
	}
}

func (h *harness) feed(text string) { h.app.Stdin = strings.NewReader(text) }

func TestSetupWithAnAPIKeyLinksTheFixedModel(t *testing.T) {
	g := newAccountGateway(t)
	g.keyInfo = `{"plan":{"name":"Pro"},"key_model":"modelo-fijo"}`
	h := newHarness(t, nil, g.config(nil))
	if code := h.run("setup", "--api-key", "lixbon_sk_buena"); code != 0 {
		t.Fatalf("code %d: %s %s", code, h.out, h.errOut)
	}
	cfg := config.Load(h.path)
	if cfg.APIKey != "lixbon_sk_buena" || cfg.KeyModel != "modelo-fijo" || cfg.Model != "modelo-fijo" || cfg.ExtraString("plan_name") != "Pro" {
		t.Fatalf("config: %+v", cfg)
	}
	if !strings.Contains(h.out.String(), "Clave vinculada al modelo modelo-fijo (modelo fijo)") {
		t.Fatalf("salida: %q", h.out)
	}
}

func TestSetupRejectsABadKey(t *testing.T) {
	g := newAccountGateway(t)
	h := newHarness(t, nil, g.config(map[string]any{"model": "qwen"}))
	if code := h.run("setup", "--api-key", "lixbon_sk_mala"); code != 1 || !strings.Contains(h.errOut.String(), "Clave inválida") {
		t.Fatalf("code %d stderr %q", code, h.errOut)
	}
	if config.Load(h.path).APIKey != "" {
		t.Fatal("una clave mala no se guarda")
	}
}

func TestSetupUsesTheLoginScreenWithATerminal(t *testing.T) {
	g := newAccountGateway(t)
	h := newHarness(t, nil, g.config(nil))
	called := false
	h.app.IsTerminal = func() bool { return true }
	h.app.Login = func(context.Context) int { called = true; return 0 }
	if code := h.run("setup"); code != 0 || !called {
		t.Fatalf("code %d, pantalla %v", code, called)
	}
}

func TestSetupWithoutATerminalWaitsForTheBrowser(t *testing.T) {
	g := newAccountGateway(t)
	g.role = "qwen"
	h := newHarness(t, nil, g.config(nil))
	opened := make(chan string, 1)
	h.app.IsTerminal = func() bool { return false }
	h.app.OpenBrowser = func(u string) error { opened <- u; return nil }
	done := make(chan int, 1)
	go func() { done <- h.run("setup") }()
	var link string
	select {
	case link = <-opened:
	case <-time.After(5 * time.Second):
		t.Fatal("no se abrió el navegador")
	}
	u, _ := url.Parse(link)
	q := u.Query()
	if u.Path != "/ide/connect" || q.Get("client") != "cli" || q.Get("method") != "S256" {
		t.Fatalf("dirección: %s", link)
	}
	resp, err := http.Get(q.Get("redirect_uri") + "?token=tok&state=" + url.QueryEscape(q.Get("state")))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("code %d: %s", code, h.errOut)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("setup no terminó tras volver el navegador")
	}
	if g.exchanged["token"] != "tok" || g.exchanged["key_name"] != "lixbon CLI" || g.exchanged["verifier"] == "" {
		t.Fatalf("canje: %v", g.exchanged)
	}
	cfg := config.Load(h.path)
	if cfg.APIKey != "lixbon_sk_web" || cfg.ExtraString("account_email") != "ana@ejemplo.com" || cfg.Model != "qwen" {
		t.Fatalf("config: key=%q email=%q model=%q", cfg.APIKey, cfg.ExtraString("account_email"), cfg.Model)
	}
	if !strings.Contains(h.out.String(), "Sesión iniciada como ana@ejemplo.com · plan Pro") || !strings.Contains(h.errOut.String(), link) {
		t.Fatalf("salida %q / %q", h.out, h.errOut)
	}
	if strings.Contains(h.out.String()+h.errOut.String(), "ontraseña") {
		t.Fatal("el CLI no pide contraseña")
	}
}

func TestSetupRefusesAGenericProvider(t *testing.T) {
	g := newAccountGateway(t)
	h := newHarness(t, nil, g.config(map[string]any{
		"profile": "local", "profiles": map[string]any{"local": map[string]any{"base_url": g.srv.URL + "/v1", "generic": true}},
	}))
	if code := h.run("setup"); code != 1 || !strings.Contains(h.out.String(), "no usa cuentas Lixbon") {
		t.Fatalf("code %d: %q", code, h.out)
	}
}
