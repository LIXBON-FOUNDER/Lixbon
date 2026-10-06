package tui

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"lixbon.com/cli/internal/mcp"
)

func TestMCPCommandWithoutServersExplainsHowToDeclareThem(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/mcp")
	contains(t, h.out(), "Sin servidores MCP")
	contains(t, h.out(), ".lixbon/mcp.json")
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
	out := h.out()
	contains(t, out, "demo: 1 herramienta")
	contains(t, out, "mcp__demo__saludar")
	contains(t, out, "Saluda a alguien")
	contains(t, out, "caido: no se pudo conectar")
	notContains(t, out, "secreto")
}
