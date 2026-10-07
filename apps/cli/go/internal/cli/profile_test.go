package cli

import (
	"net/http"
	"strings"
	"testing"

	"lixbon.com/cli/internal/config"
)

func genericConfig(extra map[string]any) map[string]any {
	cfg := map[string]any{
		"model": "qwen", "profile": "local",
		"profiles": map[string]any{"local": map[string]any{"generic": true}},
	}
	for k, v := range extra {
		cfg[k] = v
	}
	return cfg
}

func TestProfileAddUseListRemove(t *testing.T) {
	h := newHarness(t, nil, map[string]any{"api_key": "lixbon_sk_abc", "model": "qwen"})

	if code := h.run("profile"); code != 0 || !strings.Contains(h.out.String(), "* lixbon") {
		t.Fatalf("listado inicial (%d):\n%s", code, h.out)
	}
	if code := h.run("profile", "add", "lmstudio"); code != 0 {
		t.Fatalf("preset por nombre (%d): %s", code, h.errOut)
	}
	cfg := config.Load(h.path)
	got := cfg.Profiles()["lmstudio"]
	if got.BaseURL != "http://localhost:1234/v1" || !got.Generic || got.ContextWindow != config.DefaultGenericContext {
		t.Fatalf("perfil lmstudio: %+v", got)
	}
	if cfg.ActiveProfile() != config.DefaultProfile || cfg.APIKey != "lixbon_sk_abc" {
		t.Fatal("añadir no debe cambiar el proveedor activo")
	}

	code := h.run("profile", "add", "remoto", "--base-url", "http://10.0.0.5:8000/v1/", "--api-key", "sk-x", "--model", "m", "--context-window", "4096", "--use")
	if code != 0 {
		t.Fatalf("add --use (%d): %s", code, h.errOut)
	}
	cfg = config.Load(h.path)
	if cfg.ActiveProfile() != "remoto" || cfg.BaseURL != "http://10.0.0.5:8000/v1" || cfg.APIKey != "sk-x" || cfg.Model != "m" || cfg.ContextWindow != 4096 || !cfg.IsGeneric() {
		t.Fatalf("config activa: %+v", cfg)
	}
	h.out.Reset()
	h.run("status")
	if !strings.Contains(h.out.String(), "- Proveedor:           remoto") {
		t.Fatalf("status debe mostrar el proveedor:\n%s", h.out)
	}

	if code := h.run("profile", "use", "lixbon"); code != 0 {
		t.Fatalf("use (%d): %s", code, h.errOut)
	}
	cfg = config.Load(h.path)
	if cfg.APIKey != "lixbon_sk_abc" || cfg.BaseURL != config.DefaultBaseURL || cfg.IsGeneric() {
		t.Fatalf("no se restauró lixbon: %+v", cfg)
	}
	if code := h.run("profile", "remove", "lmstudio"); code != 0 {
		t.Fatalf("remove (%d): %s", code, h.errOut)
	}
	if _, ok := config.Load(h.path).Profiles()["lmstudio"]; ok {
		t.Fatal("lmstudio debería haberse eliminado")
	}
}

func TestProfileCommandErrors(t *testing.T) {
	h := newHarness(t, nil, map[string]any{"api_key": "k"})
	cases := []struct {
		args []string
		code int
	}{
		{[]string{"profile", "nada"}, 2},
		{[]string{"profile", "add"}, 2},
		{[]string{"profile", "add", "con espacios", "--base-url", "ollama"}, 2},
		{[]string{"profile", "add", "x", "--base-url", "localhost:1234"}, 2},
		{[]string{"profile", "add", "x"}, 2},
		{[]string{"profile", "add", "lixbon", "--base-url", "ollama"}, 1},
		{[]string{"profile", "use", "nada"}, 1},
		{[]string{"profile", "use"}, 2},
		{[]string{"profile", "remove", "lixbon"}, 1},
		{[]string{"profile", "remove", "nada"}, 1},
	}
	for _, c := range cases {
		h.errOut.Reset()
		if code := h.run(c.args...); code != c.code {
			t.Errorf("%v: código %d, esperaba %d (%s)", c.args, code, c.code, h.errOut)
		}
		if h.errOut.Len() == 0 {
			t.Errorf("%v: debe explicar el error", c.args)
		}
	}
}

func TestChatOnceAndModelsWorkWithoutKeyOnAnExternalProvider(t *testing.T) {
	g := newFakeGateway(t)
	g.chat = sseHandler(delta("Hola desde fuera"))
	h := newHarness(t, g, genericConfig(nil))

	if code := h.run("models"); code != 0 || !strings.Contains(h.out.String(), "- qwen") {
		t.Fatalf("models sin clave (%d): %s%s", code, h.out, h.errOut)
	}
	if code := h.run("chat", "--once", "hola"); code != 0 {
		t.Fatalf("chat (%d): %s", code, h.errOut)
	}
	if !strings.Contains(h.out.String(), "Hola desde fuera") {
		t.Fatalf("respuesta: %q", h.out)
	}
	for _, key := range []string{"conversation_id", "client_id", "source", "web_search", "num_ctx", "title"} {
		if _, has := g.chatBody[key]; has {
			t.Errorf("no debe enviarse %q a un proveedor externo", key)
		}
	}
	if g.chatBody["model"] != "qwen" {
		t.Fatalf("modelo: %v", g.chatBody["model"])
	}
}

func TestGatewayStillRequiresAKey(t *testing.T) {
	g := newFakeGateway(t)
	g.chat = sseHandler(delta("x"))
	h := newHarness(t, g, map[string]any{"model": "qwen"})
	if code := h.run("chat", "--once", "hola"); code != 1 || !strings.Contains(h.errOut.String(), "No hay sesión") {
		t.Fatalf("(%d) %s", code, h.errOut)
	}
}

func TestRejectedKeyOnAnExternalProviderIsNotErased(t *testing.T) {
	g := newFakeGateway(t)
	g.modelsCode = http.StatusUnauthorized
	g.chat = sseHandler(delta("x"))
	h := newHarness(t, g, genericConfig(map[string]any{"api_key": "sk-mala"}))
	if code := h.run("chat", "--once", "hola"); code != 1 || !strings.Contains(h.errOut.String(), "rechazó la clave") {
		t.Fatalf("(%d) %s", code, h.errOut)
	}
	if got := config.Load(h.path).APIKey; got != "sk-mala" {
		t.Fatalf("la clave del proveedor externo no debe borrarse: %q", got)
	}
}
