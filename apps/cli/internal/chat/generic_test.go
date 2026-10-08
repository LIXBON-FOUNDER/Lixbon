package chat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
)

type externalServer struct {
	mu     sync.Mutex
	paths  []string
	bodies []map[string]any
	url    string
}

func newExternalServer(t *testing.T) *externalServer {
	t.Helper()
	s := &externalServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.paths = append(s.paths, r.URL.Path)
		s.mu.Unlock()
		switch r.URL.Path {
		case "/v1/models":
			io.WriteString(w, `{"data":[{"id":"local-m"}]}`)
		case "/v1/chat/completions":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			s.mu.Lock()
			s.bodies = append(s.bodies, body)
			s.mu.Unlock()
			reply("desde fuera")(w)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	s.url = srv.URL + "/v1"
	return s
}

func (s *externalServer) hitLixbonEndpoints() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.ContainsFunc(s.paths, func(p string) bool { return strings.HasPrefix(p, "/api/") })
}

func genericChat(t *testing.T, s *externalServer, mutate func(*config.Config)) *Chat {
	t.Helper()
	cfg := config.Default()
	cfg.BaseURL, cfg.Model, cfg.Mode = s.url, "local-m", ModeAsk
	cfg.SetExtraString("profile", "local")
	cfg.Extra["profiles"] = json.RawMessage(`{"local":{"generic":true}}`)
	if mutate != nil {
		mutate(&cfg)
	}
	c := newChat(t, api.FromConfig(cfg), func(dst *config.Config) { *dst = cfg }, Options{})
	return c
}

func TestGenericProbeNeedsNoKeyAndSkipsLixbonEndpoints(t *testing.T) {
	s := newExternalServer(t)
	c := genericChat(t, s, nil)
	acc := c.Probe(context.Background())
	if acc.State != AccountOK || !acc.Generic || len(acc.Models) != 1 {
		t.Fatalf("cuenta: %+v", acc)
	}
	if s.hitLixbonEndpoints() {
		t.Fatalf("un proveedor genérico no debe recibir peticiones /api: %v", s.paths)
	}
}

func TestGenericProbeOfflineAndEmpty(t *testing.T) {
	down := httptest.NewServer(http.NotFoundHandler())
	url := down.URL + "/v1"
	down.Close()
	c := genericChat(t, &externalServer{url: url}, nil)
	if acc := c.Probe(context.Background()); acc.State != AccountOffline {
		t.Fatalf("servidor caído: %+v", acc)
	}

	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"data":[]}`) }))
	t.Cleanup(empty.Close)
	c = genericChat(t, &externalServer{url: empty.URL + "/v1"}, nil)
	acc := c.Probe(context.Background())
	if acc.State != AccountOK {
		t.Fatalf("un servidor que responde sin modelos no está caído: %+v", acc)
	}
	if err := acc.NoModelsError(); !strings.Contains(err.Error(), "cargado") {
		t.Fatalf("mensaje: %v", err)
	}
}

func TestGenericDelegateIsRefusedWithoutTouchingHistory(t *testing.T) {
	s := newExternalServer(t)
	c := genericChat(t, s, func(cfg *config.Config) { cfg.Mode = ModeDelegate })
	if _, err := c.Send(context.Background(), "hola", nil); err == nil || !strings.Contains(err.Error(), "delegate") {
		t.Fatalf("error: %v", err)
	}
	if len(c.History) != 0 || len(s.paths) != 0 {
		t.Fatalf("historial %d, peticiones %v", len(c.History), s.paths)
	}
}

func TestUseProfileSwitchesProviderModelAndMode(t *testing.T) {
	g, client := newGateway(t)
	_ = g
	external := newExternalServer(t)
	c := newChat(t, client, func(cfg *config.Config) {
		cfg.ContextWindow = 32768
		cfg.Mode = ModeDelegate
		cfg.AddProfile("local", config.Profile{BaseURL: external.url, Model: "local-m", ContextWindow: 8192, Generic: true})
	}, Options{})
	original := c.Client

	if err := c.UseProfile("local"); err != nil {
		t.Fatal(err)
	}
	if c.Client != original || c.Client.BaseURL != external.url || !c.Client.Generic || c.Client.APIKey != "" {
		t.Fatalf("el mismo cliente debe apuntar al nuevo proveedor: %+v", c.Client)
	}
	if c.Model != "local-m" || c.Session.Model != "local-m" || c.Session.ContextWindow != 8192 {
		t.Fatalf("modelo %q, sesión %q, contexto %d", c.Model, c.Session.Model, c.Session.ContextWindow)
	}
	if c.Mode != ModeAsk || c.Cfg.Mode != ModeAsk {
		t.Fatalf("delegate no existe fuera del gateway: %q", c.Mode)
	}
	if loaded := config.Load(c.ConfigPath); loaded.ActiveProfile() != "local" || loaded.BaseURL != external.url {
		t.Fatalf("el cambio debe quedar guardado: %q %q", loaded.ActiveProfile(), loaded.BaseURL)
	}

	if _, err := c.Send(context.Background(), "hola", nil); err != nil {
		t.Fatal(err)
	}
	if got := external.bodies[0]["model"]; got != "local-m" {
		t.Fatalf("modelo enviado: %v", got)
	}
	if _, has := external.bodies[0]["conversation_id"]; has {
		t.Fatal("no deben enviarse campos de Lixbon a un proveedor externo")
	}

	if err := c.UseProfile(config.DefaultProfile); err != nil {
		t.Fatal(err)
	}
	if c.Client.Generic || c.Client.APIKey != "k" || c.Model != "qwen" || c.Session.ContextWindow != 32768 {
		t.Fatalf("no se restauró lixbon: generic=%v key=%q modelo=%q ventana=%d", c.Client.Generic, c.Client.APIKey, c.Model, c.Session.ContextWindow)
	}
	if err := c.UseProfile("nada"); err == nil {
		t.Fatal("un perfil inexistente debe fallar")
	}
}

func TestAskModeTellsAGenericModelHowToGetTools(t *testing.T) {
	s := newExternalServer(t)
	c := genericChat(t, s, nil)
	if _, err := c.Send(context.Background(), "lista mis archivos", nil); err != nil {
		t.Fatal(err)
	}
	messages := s.bodies[0]["messages"].([]any)
	system, _ := messages[0].(map[string]any)
	if system["role"] != "system" {
		t.Fatalf("el primer mensaje debe ser el prompt del modo ask: %v", messages)
	}
	for _, want := range []string{"/mode agent", "!comando"} {
		if !strings.Contains(system["content"].(string), want) {
			t.Fatalf("el prompt del modo ask no menciona %q: %v", want, system["content"])
		}
	}
}

func TestAskModeSendsNoSystemPromptToTheLixbonGateway(t *testing.T) {
	g, client := newGateway(t)
	c := newChat(t, client, nil, Options{})
	if _, err := c.Send(context.Background(), "hola", nil); err != nil {
		t.Fatal(err)
	}
	messages := g.bodyAt(0)["messages"].([]any)
	if len(messages) != 1 {
		t.Fatalf("el contrato con el gateway no lleva mensaje de sistema: %v", messages)
	}
}
