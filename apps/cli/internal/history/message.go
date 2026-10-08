// Package history gestiona la ventana de contexto del agente: estima tokens,
// recorta resultados de herramientas, poda mensajes antiguos sin romper el
// round-trip de tool-calling y compacta con un resumen del modelo. Contrato
// fijado por validation/fixtures/agent_corpus.json (sección history).
package history

import (
	"encoding/json"
	"strings"

	"lixbon.com/cli/internal/textutil"
)

// Message es un mensaje del chat tal y como viaja al gateway.
type Message struct {
	Role       string            `json:"role"`
	Content    string            `json:"content"`
	ToolCalls  []json.RawMessage `json:"tool_calls,omitempty"`
	Images     []string          `json:"images,omitempty"`
	ToolCallID string            `json:"tool_call_id,omitempty"`
	Name       string            `json:"name,omitempty"`
}

// MarshalJSON conserva los campos que el gateway espera: content siempre
// presente y, en los mensajes de herramienta, tool_call_id y name aunque estén
// vacíos.
func (m Message) MarshalJSON() ([]byte, error) {
	out := map[string]any{"role": m.Role, "content": m.Content}
	if len(m.ToolCalls) > 0 {
		out["tool_calls"] = m.ToolCalls
	}
	if len(m.Images) > 0 {
		out["images"] = m.Images
	}
	if m.Role == "tool" {
		out["tool_call_id"] = m.ToolCallID
		out["name"] = m.Name
	}
	return json.Marshal(out)
}

func User(content string) Message      { return Message{Role: "user", Content: content} }
func Assistant(content string) Message { return Message{Role: "assistant", Content: content} }

// IsToolResult cubre los dos protocolos: role "tool" (nativo) y el mensaje de
// usuario "TOOL_RESULT …" (protocolo de texto).
func (m Message) IsToolResult() bool {
	if m.Role == "tool" {
		return true
	}
	return m.Role == "user" && strings.HasPrefix(strings.TrimLeftFunc(m.Content, textutil.IsSpace), "TOOL_RESULT")
}

func equal(a, b []Message) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if x.Role != y.Role || x.Content != y.Content || x.ToolCallID != y.ToolCallID || x.Name != y.Name ||
			len(x.Images) != len(y.Images) || len(x.ToolCalls) != len(y.ToolCalls) {
			return false
		}
		for k := range x.Images {
			if x.Images[k] != y.Images[k] {
				return false
			}
		}
		for k := range x.ToolCalls {
			if string(x.ToolCalls[k]) != string(y.ToolCalls[k]) {
				return false
			}
		}
	}
	return true
}
