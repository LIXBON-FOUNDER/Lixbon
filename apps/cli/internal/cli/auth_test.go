package cli

import (
	"net/http"
	"strings"
	"testing"

	"lixbon.com/cli/internal/config"
)

func TestAuthLoginAddsAndActivatesAProvider(t *testing.T) {
	g := newFakeGateway(t)
	h := newHarness(t, nil, map[string]any{"api_key": "lixbon_sk_abc", "model": "qwen"})
	url := g.srv.URL + "/v1"

	if code := h.run("auth", "login", "nube", "--base-url", url, "--api-key", "sk-x", "--model", "llama"); code != 0 {
		t.Fatalf("login (%d): %s", code, h.errOut)
	}
	for _, want := range []string{"«nube» guardado y activo", "2 modelos disponibles"} {
		if !strings.Contains(h.out.String(), want) {
			t.Fatalf("falta %q en:\n%s", want, h.out)
		}
	}
	cfg := config.Load(h.path)
	if cfg.ActiveProfile() != "nube" || cfg.BaseURL != url || cfg.APIKey != "sk-x" || cfg.Model != "llama" || !cfg.IsGeneric() {
		t.Fatalf("config activa: %+v", cfg)
	}
	if got := cfg.Profiles()["lixbon"]; got.APIKey != "lixbon_sk_abc" || got.Model != "qwen" {
		t.Fatalf("el proveedor anterior debe conservar su clave y su modelo: %+v", got)
	}
}

func TestAuthLoginAsksForTheKeyAndRequiresOneForRemoteServers(t *testing.T) {
	g := newFakeGateway(t)
	h := newHarness(t, nil, map[string]any{"api_key": "lixbon_sk_abc"})
	h.app.Stdin = strings.NewReader("sk-pedida\n")
	if code := h.run("auth", "login", "nube", "--base-url", g.srv.URL+"/v1"); code != 0 {
		t.Fatalf("login (%d): %s", code, h.errOut)
	}
	if got := config.Load(h.path).APIKey; got != "sk-pedida" {
		t.Fatalf("clave: %q", got)
	}

	h.app.Stdin = strings.NewReader("\n")
	if code := h.run("auth", "login", "remoto", "--base-url", "https://api.ejemplo.invalid/v1"); code != 1 || !strings.Contains(h.errOut.String(), "necesita una API key") {
		t.Fatalf("una clave vacía en un servidor remoto debe fallar (%d): %s", code, h.errOut)
	}
	if _, saved := config.Load(h.path).Profiles()["remoto"]; saved {
		t.Fatal("no debe guardarse un proveedor sin clave")
	}
}

func TestAuthLoginPresetAndRejectedKey(t *testing.T) {
	h := newHarness(t, nil, map[string]any{"api_key": "lixbon_sk_abc"})
	if code := h.run("auth", "login", "lmstudio", "--api-key", ""); code != 0 {
		t.Fatalf("preset local sin servidor no es un error (%d): %s", code, h.errOut)
	}
	if got := config.Load(h.path); got.BaseURL != config.Presets["lmstudio"] || got.ActiveProfile() != "lmstudio" {
		t.Fatalf("preset: %+v", got)
	}

	g := newFakeGateway(t)
	g.modelsCode = http.StatusUnauthorized
	if code := h.run("auth", "login", "nube", "--base-url", g.srv.URL+"/v1", "--api-key", "mala"); code != 1 || !strings.Contains(h.errOut.String(), "rechazó la clave") {
		t.Fatalf("clave rechazada (%d): %s", code, h.errOut)
	}
	if got := config.Load(h.path).Profiles()["nube"].APIKey; got != "mala" {
		t.Fatalf("se guarda igualmente para poder corregirla: %q", got)
	}
}

func TestAuthLoginToTheGatewayKeepsOtherProviders(t *testing.T) {
	g := newFakeGateway(t)
	h := newHarness(t, g, map[string]any{"api_key": "lixbon_sk_abc", "model": "qwen"})
	if code := h.run("profile", "add", "nube", "--base-url", g.srv.URL+"/v1", "--api-key", "sk-x", "--use"); code != 0 {
		t.Fatalf("add (%d): %s", code, h.errOut)
	}
	if code := h.run("auth", "login", "lixbon", "--api-key", "lixbon_sk_nueva"); code != 0 {
		t.Fatalf("login gateway (%d): %s", code, h.errOut)
	}
	cfg := config.Load(h.path)
	if cfg.ActiveProfile() != "lixbon" || cfg.APIKey != "lixbon_sk_nueva" || cfg.IsGeneric() {
		t.Fatalf("config activa: %+v", cfg)
	}
	if cfg.Profiles()["nube"].APIKey != "sk-x" {
		t.Fatal("la clave del otro proveedor no debe cambiar")
	}
}

func TestAuthListAndLogout(t *testing.T) {
	h := newHarness(t, nil, map[string]any{"api_key": "lixbon_sk_abcdefghijklmn", "model": "qwen", "plan_name": "Pro", "account_email": "a@b.c"})
	h.run("profile", "add", "nube", "--base-url", "https://api.ejemplo.invalid/v1", "--api-key", "sk-secreta-muy-larga-1234")
	h.run("profile", "add", "lmstudio")

	h.out.Reset()
	if code := h.run("auth", "list"); code != 0 {
		t.Fatalf("list: %d", code)
	}
	out := h.out.String()
	for _, want := range []string{"* lixbon", "lixbon_sk_…klmn", "nube", "sin clave"} {
		if !strings.Contains(out, want) {
			t.Fatalf("falta %q en:\n%s", want, out)
		}
	}
	if strings.Contains(out, "sk-secreta-muy-larga-1234") {
		t.Fatal("el listado no debe mostrar la clave completa")
	}

	if code := h.run("auth", "logout", "nube"); code != 0 {
		t.Fatalf("logout nube: %d %s", code, h.errOut)
	}
	cfg := config.Load(h.path)
	if p, ok := cfg.Profiles()["nube"]; !ok || p.APIKey != "" || p.BaseURL == "" {
		t.Fatalf("logout quita la clave pero conserva el proveedor: %+v", p)
	}
	if cfg.APIKey != "lixbon_sk_abcdefghijklmn" {
		t.Fatal("cerrar sesión de otro proveedor no toca el activo")
	}

	if code := h.run("auth", "logout"); code != 0 {
		t.Fatalf("logout activo: %d", code)
	}
	cfg = config.Load(h.path)
	if cfg.APIKey != "" || cfg.ExtraString("plan_name") != "" || cfg.ExtraString("account_email") != "" {
		t.Fatalf("la sesión de lixbon debe quedar cerrada: %+v", cfg)
	}
	if code := h.run("auth", "logout", "nada"); code != 1 {
		t.Fatalf("proveedor inexistente: %d", code)
	}
}
