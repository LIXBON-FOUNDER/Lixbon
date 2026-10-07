package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeMCP es un servidor MCP HTTP con una herramienta, saludar, que cuenta sus llamadas.
func fakeMCP(t *testing.T) (url string, calls *atomic.Int32) {
	t.Helper()
	calls = &atomic.Int32{}
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
		switch msg.Method {
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{
				"name": "saludar", "description": "Saluda",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"quien": map[string]any{"type": "string"}}},
			}}}
		case "tools/call":
			calls.Add(1)
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "hola desde mcp"}}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
	}))
	t.Cleanup(srv.Close)
	return srv.URL, calls
}

func declareMCP(t *testing.T, workspace, url string) {
	t.Helper()
	dir := filepath.Join(workspace, ".lixbon")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	config := `{"servers": {"demo": {"url": "` + url + `"}}}`
	if err := os.WriteFile(filepath.Join(dir, "mcp.json"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestAgentOnceUsesMCPToolsWithApproval(t *testing.T) {
	url, calls := fakeMCP(t)
	h, script, ws := agentHarness(t, map[string]any{"lixbon_mcp": false, "auto_approve_tools": true},
		replyToolCall("c1", "mcp__demo__saludar", map[string]any{"quien": "mundo"}),
		replyText("Listo."))
	declareMCP(t, ws, url)

	if code := h.run("chat", "--once", "saluda"); code != 0 {
		t.Fatalf("code %d: %s", code, h.errOut)
	}
	if calls.Load() != 1 {
		t.Fatalf("llamadas al servidor MCP = %d", calls.Load())
	}
	first := script.bodies[0]
	tools, _ := first["tools"].([]any)
	if len(tools) != 21 {
		t.Fatalf("el modelo debe recibir las 20 herramientas más la de MCP, recibió %d", len(tools))
	}
	last := tools[len(tools)-1].(map[string]any)["function"].(map[string]any)
	if last["name"] != "mcp__demo__saludar" || last["description"] != "[MCP demo] Saluda" {
		t.Fatalf("herramienta MCP: %v", last)
	}
	second := bodyMessages(script.bodies[1])
	if tail := second[len(second)-1]; tail["role"] != "tool" || tail["content"] != "hola desde mcp" || tail["name"] != "mcp__demo__saludar" {
		t.Fatalf("resultado enviado al modelo: %v", tail)
	}
	if !strings.Contains(h.errOut.String(), "MCP") {
		t.Fatalf("stderr debe registrar la acción MCP:\n%s", h.errOut)
	}
}

func TestAgentOnceDeniesMCPWithoutApproval(t *testing.T) {
	url, calls := fakeMCP(t)
	h, script, ws := agentHarness(t, map[string]any{"lixbon_mcp": false, "auto_approve_tools": false},
		replyToolCall("c1", "mcp__demo__saludar", map[string]any{}),
		replyText("No pude."))
	declareMCP(t, ws, url)

	if code := h.run("chat", "--once", "saluda"); code != 0 {
		t.Fatalf("code %d: %s", code, h.errOut)
	}
	if calls.Load() != 0 {
		t.Fatalf("se llamó a una herramienta MCP sin aprobación (%d)", calls.Load())
	}
	second := bodyMessages(script.bodies[1])
	if tail := second[len(second)-1]; tail["content"] != "Ejecución cancelada por el usuario" {
		t.Fatalf("resultado: %v", tail)
	}
}

func TestAgentOnceSurvivesABrokenMCPServer(t *testing.T) {
	h, script, ws := agentHarness(t, map[string]any{"lixbon_mcp": false}, replyText("Sin MCP."))
	declareMCP(t, ws, "http://127.0.0.1:1/mcp")

	if code := h.run("chat", "--once", "hola"); code != 0 {
		t.Fatalf("code %d: %s", code, h.errOut)
	}
	if tools, _ := script.bodies[0]["tools"].([]any); len(tools) != 20 {
		t.Fatalf("un servidor roto no debe añadir herramientas: %d", len(tools))
	}
}
