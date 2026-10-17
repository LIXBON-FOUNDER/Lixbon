package tui

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"lixbon.com/cli/internal/mcp"
)

func TestMCPCommandWithoutServersOffersToAddOne(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/mcp")
	contains(t, h.view(), "Servidores MCP")
	contains(t, h.view(), "Añadir servidor MCP")
}

func TestMCPCommandListsServersAndTools(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var msg struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &msg)
		if msg.ID == nil {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		result := map[string]any{"protocolVersion": "2025-06-18"}
		if msg.Method == "tools/list" {
			result = map[string]any{"tools": []any{map[string]any{"name": "saludar", "description": "Saluda a alguien"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
	}))
	defer srv.Close()

	h := newHarness(t, nil)
	reg := mcp.NewRegistry([]mcp.Spec{
		{Name: "demo", URL: srv.URL + "/mcp?token=secreto"},
		{Name: "caido", URL: "http://127.0.0.1:1/mcp"},
	})
	t.Cleanup(reg.Close)
	h.chat.MCP = reg
	reg.Start()

	h.send("/mcp")
	view := h.view()
	contains(t, view, "1 herramienta")
	contains(t, view, "caido")
	contains(t, view, "no se pudo conectar")
	notContains(t, view, "secreto")
	h.key("enter")
	contains(t, h.view(), "Herramientas de demo")
	contains(t, h.view(), "saludar")
	contains(t, h.view(), "Saluda a alguien")
}

func TestMCPAddFormDeclaresTheServerAndStartsIt(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/mcp")
	h.key("enter")
	h.pump(h.formOpen)
	h.send("memoria")
	h.send(`lixbon-mcp-que-no-existe -y "con espacios"`)
	h.send("CLAVE=secreta")
	h.key("enter")
	h.pump(func() bool { return !h.formOpen() })
	notContains(t, h.out()+h.view(), "secreta")

	path := h.chat.MCPFile(false)
	specs := mcp.LoadSpecs(t.TempDir(), filepath.Dir(path))
	if len(specs) != 1 || specs[0].Name != "memoria" || specs[0].Command != "lixbon-mcp-que-no-existe" ||
		strings.Join(specs[0].Args, "|") != "-y|con espacios" || specs[0].Env["CLAVE"] != "secreta" {
		t.Fatalf("servidor guardado: %+v", specs)
	}
	if h.chat.MCP == nil {
		t.Fatal("el servidor nuevo debe arrancar sin reiniciar el CLI")
	}
	t.Cleanup(h.chat.StopMCP)

	h.send("/mcp")
	contains(t, h.view(), "memoria")
	h.key("up")
	h.key("enter")
	h.pump(h.formOpen)
	h.send("memoria")
	h.send("https://ejemplo.com/mcp")
	h.key("enter")
	h.key("enter")
	contains(t, h.view(), "Ya hay un servidor «memoria»")
}

func TestMCPEntryParsesCommandsURLsAndPairs(t *testing.T) {
	got, err := mcpEntry("https://x.dev/mcp", "Authorization='Bearer abc'")
	if err != nil || got["url"] != "https://x.dev/mcp" || got["headers"].(map[string]string)["Authorization"] != "Bearer abc" {
		t.Fatalf("url: %v %v", got, err)
	}
	if _, err := mcpEntry("uvx srv", "SIN_IGUAL"); err == nil {
		t.Fatal("una variable sin = debe rechazarse")
	}
}
