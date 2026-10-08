package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"lixbon.com/cli/internal/config"
)

type accountGateway struct {
	srv       *httptest.Server
	usage     string
	loginBody map[string]any
	registers int
	logins    int
	loginFail int
	keyInfo   string
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
	mux.HandleFunc("/api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		g.logins++
		json.NewDecoder(r.Body).Decode(&g.loginBody)
		if g.logins <= g.loginFail {
			w.WriteHeader(401)
			io.WriteString(w, `{"detail":"Credenciales incorrectas"}`)
			return
		}
		io.WriteString(w, `{"api_key":"lixbon_sk_nueva"}`)
	})
	mux.HandleFunc("/api/auth/register", func(w http.ResponseWriter, r *http.Request) {
		g.registers++
		io.WriteString(w, `{}`)
	})
	mux.HandleFunc("/api/key/info", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer lixbon_sk_buena" {
			w.WriteHeader(401)
			io.WriteString(w, `{"detail":"clave inválida"}`)
			return
		}
		io.WriteString(w, g.keyInfo)
	})
	mux.HandleFunc("/api/model-roles", http.NotFound)
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

func TestSetupWithCredentialsSavesTheIssuedKey(t *testing.T) {
	g := newAccountGateway(t)
	h := newHarness(t, nil, g.config(map[string]any{"model": "qwen"}))
	h.feed("1\nana@ejemplo.com\nsecreta\n")
	if code := h.run("setup"); code != 0 {
		t.Fatalf("code %d: %s %s", code, h.out, h.errOut)
	}
	if g.loginBody["issue_api_key"] != true || g.loginBody["key_name"] != "lixbon CLI" || g.loginBody["email"] != "ana@ejemplo.com" {
		t.Fatalf("login: %v", g.loginBody)
	}
	cfg := config.Load(h.path)
	if cfg.APIKey != "lixbon_sk_nueva" || cfg.ExtraString("account_email") != "ana@ejemplo.com" || cfg.KeyModel != "" {
		t.Fatalf("config guardada: key=%q email=%q", cfg.APIKey, cfg.ExtraString("account_email"))
	}
	if !strings.Contains(h.out.String(), "Sesión iniciada como ana@ejemplo.com") {
		t.Fatalf("salida: %q", h.out)
	}
}

func TestSetupRetriesAfterBadCredentials(t *testing.T) {
	g := newAccountGateway(t)
	g.loginFail = 1
	h := newHarness(t, nil, g.config(map[string]any{"model": "qwen"}))
	h.feed("1\nana@ejemplo.com\nmala\nana@ejemplo.com\nbuena\n")
	if code := h.run("setup"); code != 0 {
		t.Fatalf("code %d: %s %s", code, h.out, h.errOut)
	}
	if g.logins != 2 || !strings.Contains(h.errOut.String(), "Credenciales incorrectas") {
		t.Fatalf("logins=%d stderr=%q", g.logins, h.errOut)
	}
}

func TestSetupRegisterThenLogin(t *testing.T) {
	g := newAccountGateway(t)
	h := newHarness(t, nil, g.config(map[string]any{"model": "qwen"}))
	h.feed("2\nnueva@ejemplo.com\nsecreta\nAna\nPérez\n")
	if code := h.run("setup"); code != 0 || g.registers != 1 || g.logins != 1 {
		t.Fatalf("code %d registers=%d logins=%d: %s", code, g.registers, g.logins, h.errOut)
	}
}

func TestSetupWithAnAPIKeyLinksTheFixedModel(t *testing.T) {
	g := newAccountGateway(t)
	g.keyInfo = `{"plan":{"name":"Pro"},"key_model":"modelo-fijo"}`
	h := newHarness(t, nil, g.config(nil))
	h.feed("3\nlixbon_sk_buena\n")
	if code := h.run("setup"); code != 0 {
		t.Fatalf("code %d: %s %s", code, h.out, h.errOut)
	}
	cfg := config.Load(h.path)
	if cfg.APIKey != "lixbon_sk_buena" || cfg.KeyModel != "modelo-fijo" || cfg.Model != "modelo-fijo" {
		t.Fatalf("config: %+v", cfg)
	}
	if !strings.Contains(h.out.String(), "Clave vinculada al modelo modelo-fijo (modelo fijo)") {
		t.Fatalf("salida: %q", h.out)
	}
}

func TestSetupRejectsABadKeyThenAcceptsAGoodOne(t *testing.T) {
	g := newAccountGateway(t)
	h := newHarness(t, nil, g.config(map[string]any{"model": "qwen"}))
	h.feed("3\nlixbon_sk_mala\nlixbon_sk_buena\n")
	if code := h.run("setup"); code != 0 {
		t.Fatalf("code %d: %s %s", code, h.out, h.errOut)
	}
	if !strings.Contains(h.errOut.String(), "Clave inválida") || config.Load(h.path).APIKey != "lixbon_sk_buena" {
		t.Fatalf("stderr %q", h.errOut)
	}
}

func TestSetupPicksAModelWhenNoneIsConfigured(t *testing.T) {
	g := newAccountGateway(t)
	h := newHarness(t, nil, g.config(nil))
	h.feed("1\nana@ejemplo.com\nsecreta\n2\n")
	if code := h.run("setup"); code != 0 {
		t.Fatalf("code %d: %s %s", code, h.out, h.errOut)
	}
	if got := config.Load(h.path).Model; got != "llama" {
		t.Fatalf("modelo elegido: %q", got)
	}
}

func TestSetupAbortsWhenInputEnds(t *testing.T) {
	g := newAccountGateway(t)
	for _, input := range []string{"", "1\n", "1\nana@ejemplo.com\n", "9\n"} {
		h := newHarness(t, nil, g.config(nil))
		h.feed(input)
		if code := h.run("setup"); code != 1 || g.logins != 0 {
			t.Fatalf("entrada %q: code %d logins %d", input, code, g.logins)
		}
	}
}

func TestSetupRefusesAGenericProvider(t *testing.T) {
	g := newAccountGateway(t)
	h := newHarness(t, nil, g.config(map[string]any{
		"profile": "local", "profiles": map[string]any{"local": map[string]any{"base_url": g.srv.URL + "/v1", "generic": true}},
	}))
	h.feed("1\n")
	if code := h.run("setup"); code != 1 || !strings.Contains(h.out.String(), "no usa cuentas Lixbon") {
		t.Fatalf("code %d: %q", code, h.out)
	}
}
