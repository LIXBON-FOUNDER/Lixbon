package tui

import (
	"net/http"
	"testing"

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

	h.send("/provider")
	h.key("down")
	h.key("enter")
	h.pump(func() bool { return h.m.prompt != nil })
	h.send("Mi-Local")
	h.pump(func() bool { return h.m.prompt != nil })
	h.send(url)
	h.pump(func() bool { return h.m.prompt != nil })
	h.send("-")
	h.pump(func() bool { return h.m.picker != nil && h.m.busy == "" })

	contains(t, h.out(), "Proveedor «mi-local» añadido")
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
	h.send("/provider")
	h.key("down")
	h.key("enter")
	h.pump(func() bool { return h.m.prompt != nil })
	h.send("con espacios")
	contains(t, h.out(), "Nombre no válido")
	if h.m.prompt != nil {
		t.Fatal("un nombre inválido cancela el alta")
	}

	h.send("/provider")
	h.key("down")
	h.key("enter")
	h.pump(func() bool { return h.m.prompt != nil })
	h.send("ok")
	h.pump(func() bool { return h.m.prompt != nil })
	h.send("localhost:1234")
	contains(t, h.out(), "La URL debe empezar por http")
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
