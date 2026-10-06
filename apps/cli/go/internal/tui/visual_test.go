package tui

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func visualMCP(w http.ResponseWriter, r *http.Request) {
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Arguments map[string]string `json:"arguments"`
		} `json:"params"`
	}
	body, _ := io.ReadAll(r.Body)
	json.Unmarshal(body, &msg)
	if msg.ID == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	switch msg.Method {
	case "initialize":
		result = map[string]any{"protocolVersion": "2025-03-26", "capabilities": map[string]any{}}
	case "tools/list":
		result = map[string]any{"tools": []any{map[string]any{"name": "visual_create", "description": "Crea"}}}
	case "prompts/get":
		text := fmt.Sprintf("Trabaja con las herramientas visual_*. Petición: %s", msg.Params.Arguments["peticion"])
		result = map[string]any{"messages": []any{map[string]any{"content": map[string]any{"type": "text", "text": text}}}}
	}
	payload, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
	w.Header().Set("Content-Type", "application/json")
	w.Write(payload)
}

// localGateway apunta la configuración al servidor de la prueba: el MCP de
// Lixbon se deriva de ella y no debe salir nunca a internet.
func localGateway(h *harness) *harness {
	h.chat.Cfg.BaseURL = h.chat.Client.BaseURL
	return h
}

func TestVisualSendsTheServerPromptToTheAgent(t *testing.T) {
	h := localGateway(newHarness(t, nil, textReply("listo")))
	h.gw.mcp = visualMCP
	h.send("/visual una landing para mi API")
	h.pump(func() bool { return h.gw.count() > 0 })
	h.settle()

	if h.chat.Mode != "agent" || h.chat.Cfg.Mode != "agent" {
		t.Fatalf("/visual pasa a modo agent, modo %q", h.chat.Mode)
	}
	msgs := h.gw.bodyAt(0)["messages"].([]any)
	var found bool
	for _, m := range msgs {
		if c, _ := m.(map[string]any)["content"].(string); strings.Contains(c, "Petición: una landing para mi API") {
			found = true
		}
	}
	if !found {
		t.Fatalf("el prompt del servidor no llegó al modelo: %v", msgs)
	}
	notContains(t, h.out(), "Trabaja con las herramientas")
}

func TestVisualWithoutArgumentsExplainsUsage(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/visual")
	contains(t, h.out(), "Uso: /visual <qué diseñar>")
	contains(t, h.out(), "/visual codigo vis_… react")
	if h.gw.count() != 0 {
		t.Fatal("no debe llamar al modelo")
	}
}

func TestVisualReportsAnUnreachableServer(t *testing.T) {
	h := localGateway(newHarness(t, nil))
	h.send("/visual algo")
	h.settle()
	if h.gw.count() != 0 {
		t.Fatal("sin servidor no se envía nada al modelo")
	}
	out := h.out()
	if !strings.Contains(out, "No hay conexión con Lixbon Visuals") && !strings.Contains(out, "No se pudo preparar el servidor MCP de Lixbon") {
		t.Fatalf("salida: %q", out)
	}
}

func TestVisualNeedsAnAccountAndAGatewayProvider(t *testing.T) {
	h := localGateway(newHarness(t, nil))
	h.chat.Cfg.APIKey = ""
	h.send("/visual algo")
	h.settle()
	contains(t, h.out(), "Visuals necesita tu cuenta de Lixbon")

	h = localGateway(newHarness(t, nil))
	h.chat.Client.Generic = true
	h.send("/visual algo")
	contains(t, h.out(), "solo funciona con un gateway Lixbon")
}
