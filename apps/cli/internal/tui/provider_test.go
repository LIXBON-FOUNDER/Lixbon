package tui

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
)

func withExternalProvider(t *testing.T, steps ...func(http.ResponseWriter, *http.Request)) (*gateway, string, func(*config.Config)) {
	t.Helper()
	external, client := newGateway(t, steps...)
	profile := config.Profile{BaseURL: client.BaseURL, Model: "llama", ContextWindow: 8192, Generic: true}
	return external, client.BaseURL, func(cfg *config.Config) {
		if err := cfg.AddProfile("local", profile); err != nil {
			t.Fatal(err)
		}
	}
}

func TestProviderCommandSwitchesToAnExternalServerAndBack(t *testing.T) {
	external, _, add := withExternalProvider(t, textReply("desde fuera"))
	h := newHarness(t, add)

	h.send("/provider local")
	h.settle()
	contains(t, h.out(), "Proveedor: local")
	contains(t, h.out(), "Modelo: Llama")
	if !h.chat.Client.Generic || h.chat.Model != "llama" || h.chat.Cfg.ActiveProfile() != "local" {
		t.Fatalf("estado: generic=%v modelo=%q activo=%q", h.chat.Client.Generic, h.chat.Model, h.chat.Cfg.ActiveProfile())
	}
	contains(t, h.view(), "local")
	if got := configLoad(h.chat.ConfigPath).ActiveProfile(); got != "local" {
		t.Fatalf("el cambio debe quedar guardado: %q", got)
	}

	h.send("hola")
	h.settle()
	if body := external.bodyAt(0); body["model"] != "llama" || body["conversation_id"] != nil {
		t.Fatalf("cuerpo enviado al proveedor externo: %v", body)
	}

	h.send("/provider lixbon")
	h.settle()
	if h.chat.Client.Generic || h.chat.Model != "qwen" || h.chat.Cfg.APIKey != "k" {
		t.Fatalf("no se restauró lixbon: generic=%v modelo=%q clave=%q", h.chat.Client.Generic, h.chat.Model, h.chat.Cfg.APIKey)
	}
}

func TestProviderPickerMarksTheActiveOneAndSwitches(t *testing.T) {
	_, _, add := withExternalProvider(t)
	h := newHarness(t, add)
	h.send("/provider")
	for _, want := range []string{"Proveedor de modelos", "lixbon", "activo", "local", "Añadir proveedor"} {
		contains(t, h.view(), want)
	}
	h.key("down")
	h.key("enter")
	h.pump(func() bool { return h.chat.Cfg.ActiveProfile() == "local" && h.m.busy == "" })
	if !h.chat.Client.Generic {
		t.Fatal("el selector debe cambiar al proveedor elegido")
	}
}

func TestProviderAddFlowCreatesAndActivatesAGenericProvider(t *testing.T) {
	_, url, _ := withExternalProvider(t)
	h := newHarness(t, nil)

	openCustomProviderPrompt(h)
	for _, want := range []string{"Nombre", "URL base", "API key", "opcional"} {
		contains(t, h.view(), want)
	}
	h.send("Mi-Local")
	h.send(url)
	h.key("enter")
	h.pump(func() bool { return !h.formOpen() && h.m.picker != nil && h.m.busy == "" })

	notContains(t, h.out(), "Nombre del proveedor")
	contains(t, h.view(), "Modelo")
	p := h.chat.Cfg.Profiles()["mi-local"]
	if !p.Generic || p.BaseURL != url || p.APIKey != "" || p.ContextWindow != config.DefaultGenericContext {
		t.Fatalf("perfil: %+v", p)
	}
	if h.chat.Cfg.ActiveProfile() != "mi-local" || !h.chat.Client.Generic {
		t.Fatal("el proveedor nuevo debe quedar activo")
	}
	h.key("enter")
	h.pump(func() bool { return h.m.picker == nil })
	if h.chat.Model == "" {
		t.Fatal("el selector de modelo debe fijar uno")
	}
}

func TestProviderAddFlowRejectsBadInput(t *testing.T) {
	h := newHarness(t, nil)
	openCustomProviderPrompt(h)
	h.send("con espacios")
	h.send("http://localhost:1234/v1")
	h.key("enter")
	contains(t, h.view(), "Nombre no válido")
	if !h.formOpen() {
		t.Fatal("un dato inválido se explica en el formulario, que sigue abierto")
	}
	h.key("esc")

	openCustomProviderPrompt(h)
	h.send("ok")
	h.send("localhost:1234")
	h.key("enter")
	contains(t, h.view(), "La URL debe empezar por http")
	if len(h.chat.Cfg.Profiles()) != 1 {
		t.Fatal("no debe crearse ningún perfil")
	}
}

func TestProviderUnknownAndAlreadyActive(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/provider nada")
	contains(t, h.out(), "No existe el proveedor «nada»")
	h.send("/provider lixbon")
	contains(t, h.out(), "Ya usas «lixbon»")
}

func TestGatewayOnlyCommandsAreExplainedOnAnExternalProvider(t *testing.T) {
	h := newHarness(t, nil)
	h.chat.Client.Generic = true
	for _, cmd := range []string{"/usage", "/nodes", "/login", "/logout", "/key abc", "/web on"} {
		h.send(cmd)
	}
	for _, cmd := range []string{"usage", "nodes", "login", "logout", "key", "web"} {
		contains(t, h.out(), "«/"+cmd+"» solo funciona con un gateway Lixbon")
	}
}

func TestStatusShowsTheExternalProvider(t *testing.T) {
	h := newHarness(t, nil)
	h.chat.Client.Generic = true
	h.send("/status")
	h.settle()
	for _, want := range []string{"Proveedor", "proveedor externo", "no aplica"} {
		contains(t, h.out(), want)
	}
}

func TestProviderAppearsInTheCommandMenu(t *testing.T) {
	h := newHarness(t, nil)
	h.typeText("/prov")
	contains(t, h.view(), "/provider")
	contains(t, h.view(), "Cambiar de proveedor")
}

func TestSwitchingToAnExternalProviderLeavesDelegateMode(t *testing.T) {
	_, _, add := withExternalProvider(t)
	h := newHarness(t, func(cfg *config.Config) {
		add(cfg)
		cfg.Mode = "delegate"
	})
	h.send("/provider local")
	h.settle()
	contains(t, h.out(), "pasas al modo ask")
	if h.chat.Mode != "ask" {
		t.Fatalf("modo: %q", h.chat.Mode)
	}
}

func providerServer(t *testing.T, handler http.HandlerFunc) string {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv.URL
}

func serverWithKey(t *testing.T, want string) string {
	return providerServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+want {
			http.Error(w, `{"error":{"message":"clave inválida"}}`, http.StatusUnauthorized)
			return
		}
		io.WriteString(w, `{"data":[{"id":"qwen","name":"Qwen"},{"id":"llama","name":"Llama"}]}`)
	})
}

func TestProviderSwitchShowsTheRealServerErrorInsteadOfAskingIfItIsRunning(t *testing.T) {
	url := providerServer(t, http.NotFound)
	h := newHarness(t, func(cfg *config.Config) {
		if err := cfg.AddProfile("local", config.Profile{BaseURL: url, Generic: true}); err != nil {
			t.Fatal(err)
		}
	})
	h.send("/provider local")
	h.pump(func() bool { return h.m.busy == "" && strings.Contains(h.out(), "HTTP 404") })
	contains(t, h.out(), "Revisa la URL base")
	if strings.Contains(h.out(), "¿Está en marcha") {
		t.Fatalf("un 404 no es un servidor apagado: %s", h.out())
	}
}

func TestProviderRejectedKeyAsksForANewOneAndReconnects(t *testing.T) {
	url := serverWithKey(t, "buena")
	h := newHarness(t, func(cfg *config.Config) {
		if err := cfg.AddProfile("local", config.Profile{BaseURL: url, APIKey: "mala", Model: "llama", Generic: true}); err != nil {
			t.Fatal(err)
		}
	})
	h.send("/provider local")
	h.pump(h.formOpen)
	contains(t, h.view(), "Nueva API key para «local»")

	h.send("buena")
	h.pump(func() bool { return strings.Contains(h.out()+h.view(), "modelos disponibles") })
	if got := configLoad(h.chat.ConfigPath).Profiles()["local"].APIKey; got != "buena" {
		t.Fatalf("clave guardada: %q", got)
	}
}

func TestProviderKeyCommandEditsAnotherProviderWithoutSwitching(t *testing.T) {
	_, _, add := withExternalProvider(t)
	h := newHarness(t, add)
	h.send("/provider key local")
	h.pump(h.formOpen)
	h.send("nueva-clave")
	h.pump(func() bool { return !h.formOpen() })
	cfg := configLoad(h.chat.ConfigPath)
	if cfg.ActiveProfile() != "lixbon" || cfg.Profiles()["local"].APIKey != "nueva-clave" || cfg.APIKey != "k" {
		t.Fatalf("activo=%q local=%+v clave activa=%q", cfg.ActiveProfile(), cfg.Profiles()["local"], cfg.APIKey)
	}

	h.send("/provider key lixbon")
	contains(t, h.out(), "gateway Lixbon: usa /login")
	h.send("/provider key nada")
	contains(t, h.out(), "No existe el proveedor «nada»")
}

func openCustomProviderPrompt(h *harness) {
	h.t.Helper()
	h.send("/provider")
	h.key("down")
	h.key("enter")
	h.pump(func() bool { return h.m.picker != nil && strings.Contains(h.view(), "Añadir proveedor") })
	for range config.PresetNames() {
		h.key("down")
	}
	h.key("enter")
	h.pump(h.formOpen)
}

func TestProviderAddOffersThePresetsAndAsksOnlyForTheKey(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/provider")
	h.key("down")
	h.key("enter")
	h.pump(func() bool { return h.m.picker != nil && strings.Contains(h.view(), "Añadir proveedor") })
	for _, want := range []string{"openrouter", "openai", "kilo", "groq", "otro…"} {
		contains(t, h.view(), want)
	}
	h.key("esc")

	h.send("/provider --add groq")
	h.pump(h.formOpen)
	contains(t, h.view(), "Añadir «groq»")
	contains(t, h.view(), "https://api.groq.com/openai/v1")
	h.key("esc")
	if len(h.chat.Cfg.Profiles()) != 1 {
		t.Fatal("cancelar no debe crear el proveedor")
	}
	h.send("/provider --add inventado")
	contains(t, h.out(), "No existe el preset «inventado»")
}

func TestStartupWithoutSessionStillOpensAndExplainsHowToConnect(t *testing.T) {
	h := newHarness(t, func(cfg *config.Config) { cfg.APIKey = "" })
	var stdout strings.Builder
	acc, notes := startupAccount(context.Background(), h.chat, &stdout)
	if acc.State != chat.AccountAuth || len(notes) != 1 || !strings.Contains(notes[0], "/login") || !strings.Contains(notes[0], "/provider") {
		t.Fatalf("estado=%v notas=%v", acc.State, notes)
	}
	if stdout.Len() != 0 || h.gw.count() != 0 {
		t.Fatal("sin clave no hay nada que sondear")
	}

	h.send("hola")
	contains(t, h.out(), "Sin sesión en lixbon.com")
	if h.gw.count() != 0 {
		t.Fatal("sin sesión no se envía el mensaje")
	}
}

func TestStartupWithARejectedKeyClearsItAndKeepsRunning(t *testing.T) {
	url := serverWithKey(t, "buena")
	cfg := config.Default()
	cfg.BaseURL, cfg.APIKey, cfg.Mode = url, "mala", "ask"
	configPath := filepath.Join(t.TempDir(), "config.json")
	c, err := chat.New(cfg, api.FromConfig(cfg), chat.Options{ConfigPath: configPath, Workspace: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Toolbox.Close)

	acc, notes := startupAccount(context.Background(), c, io.Discard)
	if acc.State != chat.AccountAuth || len(notes) != 1 || !strings.Contains(notes[0], "ya no es válida") {
		t.Fatalf("estado=%v notas=%v", acc.State, notes)
	}
	if got := configLoad(configPath).APIKey; got != "" {
		t.Fatalf("la clave rechazada se borra: %q", got)
	}
}

func TestStartupWithARejectedExternalKeyKeepsItAndPointsToProviderKey(t *testing.T) {
	url := serverWithKey(t, "buena")
	cfg := config.Default()
	cfg.BaseURL = url
	if err := cfg.AddProfile("nube", config.Profile{BaseURL: url, APIKey: "mala", Generic: true}); err != nil {
		t.Fatal(err)
	}
	if err := cfg.UseProfile("nube"); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(t.TempDir(), "config.json")
	c, err := chat.New(cfg, api.FromConfig(cfg), chat.Options{ConfigPath: configPath, Workspace: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Toolbox.Close)

	acc, notes := startupAccount(context.Background(), c, io.Discard)
	if acc.State != chat.AccountAuth || len(notes) != 1 || !strings.Contains(notes[0], "/provider key nube") {
		t.Fatalf("estado=%v notas=%v", acc.State, notes)
	}
	if c.Cfg.APIKey != "mala" {
		t.Fatal("la clave de un proveedor externo no se borra")
	}
}
