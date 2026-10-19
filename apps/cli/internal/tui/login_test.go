package tui

import (
	"net/http"
	"net/url"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/config"
)

func (h *harness) openLogin(step loginStep) {
	h.t.Helper()
	h.m.openLogin(loginCommand, step, "")
	h.m.login.open = func(string) error { return nil }
}

func TestLoginMethodNavigatesWithArrows(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/login")
	if h.m.login == nil || h.m.login.step != stepMethod {
		t.Fatal("/login abre la pantalla de login")
	}
	view := h.view()
	contains(t, view, "Entra en lixbon")
	contains(t, view, "Con el navegador")
	contains(t, view, "Con una API key")
	notContains(t, view, "Contraseña")
	h.key("down")
	if h.m.login.cursor != 1 {
		t.Fatal("↓ baja a la API key")
	}
	h.key("enter")
	if h.m.login.step != stepAPIKey {
		t.Fatal("↵ elige la API key")
	}
	h.key("esc")
	if h.m.login == nil || h.m.login.step != stepMethod {
		t.Fatal("Esc vuelve a los métodos")
	}
	h.key("esc")
	if h.m.login != nil {
		t.Fatal("Esc en los métodos vuelve al chat")
	}
	contains(t, h.out(), "Inicio de sesión cancelado")
}

func TestLoginWithAnAPIKeySavesItWithoutShowingIt(t *testing.T) {
	h := newHarness(t, nil)
	h.chat.Cfg.APIKey = ""
	h.openLogin(stepAPIKey)
	const key = "lixbon_sk_buenisima123"
	h.typeText(key)
	notContains(t, h.view(), "buenisima")
	contains(t, h.view(), "22 car.")
	h.key("enter")
	h.pump(func() bool { return h.m.login.step == stepDone })
	contains(t, h.view(), "clave verificada")
	h.key("enter")
	h.settle()
	if h.m.login != nil || h.chat.Cfg.APIKey != key {
		t.Fatalf("login cerrado=%v clave=%q", h.m.login == nil, h.chat.Cfg.APIKey)
	}
	if saved := config.Load(h.chat.ConfigPath); saved.APIKey != key || saved.ExtraString("plan_name") != "Pro" {
		t.Fatalf("config guardada: %q plan %q", saved.APIKey, saved.ExtraString("plan_name"))
	}
	out := h.out()
	contains(t, out, "Clave verificada")
	notContains(t, out, key)
	for _, e := range h.m.hist.entries {
		if strings.Contains(e, key) {
			t.Fatalf("la clave llegó al historial: %q", e)
		}
	}
}

func TestLoginRejectsABadKeyAndLetsRetry(t *testing.T) {
	h := newHarness(t, nil)
	h.openLogin(stepAPIKey)
	h.typeText("lixbon_sk_mala")
	h.key("enter")
	h.pump(func() bool { return h.m.login.step == stepFailed })
	contains(t, h.view(), "no es válida")
	h.key("enter")
	if h.m.login.step != stepAPIKey {
		t.Fatal("↵ reintenta con la clave")
	}
}

func TestLoginThroughTheBrowser(t *testing.T) {
	h := newHarness(t, nil)
	h.openLogin(stepMethod)
	h.key("enter")
	h.pump(func() bool { return h.m.login.session != nil })
	contains(t, h.view(), "esperando")
	contains(t, h.view(), "/ide/connect")
	s := h.m.login.session
	u, _ := url.Parse(s.URL)
	resp, err := http.Get(u.Query().Get("redirect_uri") + "?token=tok-web&state=" + url.QueryEscape(s.State))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	h.pump(func() bool { return h.m.login.step == stepDone })
	contains(t, h.view(), "ana@estudio.dev")
	h.key("enter")
	h.settle()
	if h.chat.Cfg.APIKey != "lixbon_sk_web" || h.chat.Cfg.ExtraString("account_email") != "ana@estudio.dev" {
		t.Fatalf("clave %q correo %q", h.chat.Cfg.APIKey, h.chat.Cfg.ExtraString("account_email"))
	}
	contains(t, h.out(), "Sesión iniciada como ana@estudio.dev")
}

func TestLoginPastingTheFinalAddress(t *testing.T) {
	h := newHarness(t, nil)
	h.openLogin(stepMethod)
	h.key("enter")
	h.pump(func() bool { return h.m.login.session != nil })
	h.typeText("p")
	if h.m.login.step != stepPaste {
		t.Fatal("p pasa a pegar la dirección")
	}
	h.update(pasteMsg("http://127.0.0.1:1/callback?token=tok-web&state=" + h.m.login.session.State))
	h.key("enter")
	h.pump(func() bool { return h.m.login.step == stepDone })
	contains(t, h.view(), "ana@estudio.dev")
}

func TestLoginAtStartupCanBeSkipped(t *testing.T) {
	h := newHarness(t, nil)
	h.m.login = newLoginView(loginStartup, *h.chat.Client, "test", &h.m.spin)
	contains(t, h.view(), "entrar sin sesión")
	h.key("esc")
	if h.m.login != nil {
		t.Fatal("Esc al arrancar deja el chat sin sesión")
	}
	notContains(t, h.out(), "Inicio de sesión cancelado")
}

func TestLoginScreenFitsAnySize(t *testing.T) {
	h := newHarness(t, nil)
	h.openLogin(stepMethod)
	for width := 4; width <= 140; width += 3 {
		for _, height := range []int{6, 20, 40} {
			lines := strings.Split(h.m.login.view(width, height), "\n")
			if len(lines) != height {
				t.Fatalf("%dx%d: %d filas", width, height, len(lines))
			}
			for i, l := range lines {
				if w := ansiWidth(l); w > width {
					t.Fatalf("%dx%d: la fila %d mide %d", width, height, i, w)
				}
			}
		}
	}
}

func ansiWidth(s string) int { return ansi.StringWidth(s) }
