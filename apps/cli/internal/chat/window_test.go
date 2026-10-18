package chat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
)

// La ventana es la del modelo en uso: la que informa el proveedor al listar
// los modelos, sin que el usuario la configure.
func TestTheWindowComesFromTheModel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"data":[{"id":"grande","context_length":262144},{"id":"sin-dato"},{"id":"otro","context_window":32768}]}`)
	}))
	t.Cleanup(srv.Close)
	cfg := config.Default()
	cfg.BaseURL, cfg.Model, cfg.Mode, cfg.ContextWindow = srv.URL+"/v1", "grande", ModeAsk, 8192
	cfg.SetExtraString("profile", "local")
	cfg.Extra["profiles"] = json.RawMessage(`{"local":{"generic":true}}`)
	c := newChat(t, api.FromConfig(cfg), func(dst *config.Config) { *dst = cfg }, Options{})

	c.Probe(context.Background())
	if c.Cfg.ContextWindow != 262144 || c.Session.ContextWindow != 262144 {
		t.Fatalf("ventana del modelo: %d / %d", c.Cfg.ContextWindow, c.Session.ContextWindow)
	}
	c.SetModel("otro")
	if c.Cfg.ContextWindow != 32768 {
		t.Fatalf("al cambiar de modelo, su ventana: %d", c.Cfg.ContextWindow)
	}
	c.SetModel("sin-dato")
	if c.Cfg.ContextWindow != 32768 {
		t.Fatalf("un modelo sin dato conserva la que había: %d", c.Cfg.ContextWindow)
	}
}
