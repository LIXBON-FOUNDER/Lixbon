package chat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"lixbon.com/cli/internal/config"
)

// Con un proveedor externo, web_search va por la cuenta Lixbon guardada en
// otro perfil: el proveedor no tiene búsqueda y el gateway sí.
func TestWebSearchWithAGenericProviderGoesThroughTheLixbonAccount(t *testing.T) {
	var auth string
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/websearch" {
			http.NotFound(w, r)
			return
		}
		auth = r.Header.Get("Authorization")
		io.WriteString(w, `{"results":[{"title":"Go 1.26","url":"https://go.dev/doc","snippet":"notas"}]}`)
	}))
	t.Cleanup(gw.Close)

	s := newExternalServer(t)
	c := genericChat(t, s, func(cfg *config.Config) {
		profiles, _ := json.Marshal(map[string]config.Profile{
			"local":  {Generic: true},
			"lixbon": {BaseURL: gw.URL + "/v1", APIKey: "lixbon_sk_guardada"},
		})
		cfg.Extra["profiles"] = profiles
	})
	got := c.Toolbox.Execute(context.Background(), "web_search", map[string]any{"query": "go 1.26"})
	if !strings.Contains(got, "go.dev/doc") || auth != "Bearer lixbon_sk_guardada" {
		t.Fatalf("resultado %q, autorización %q", got, auth)
	}
	if s.hitLixbonEndpoints() {
		t.Fatalf("el proveedor externo no recibe la búsqueda: %v", s.paths)
	}
}

// Sin cuenta Lixbon guardada, el error dice qué falta en vez de «no es un
// gateway».
func TestWebSearchWithoutALixbonAccountSaysHowToGetOne(t *testing.T) {
	c := genericChat(t, newExternalServer(t), nil)
	got := c.Toolbox.Execute(context.Background(), "web_search", map[string]any{"query": "go"})
	if !strings.Contains(got, "/login") || strings.Contains(got, "no es un gateway") {
		t.Fatalf("error: %q", got)
	}
}
