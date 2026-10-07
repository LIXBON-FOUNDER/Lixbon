package chat

import (
	"encoding/json"
	"fmt"
	"strings"
)

// toolCallAssembler junta los tool_calls de un stream. Los proveedores
// compatibles con OpenAI (OpenAI, OpenRouter, Kilo…) parten cada llamada en
// fragmentos: el primero trae id y nombre y los siguientes, solo trozos de los
// argumentos, unidos por index. El gateway de Lixbon envía llamadas completas.
type toolCallAssembler struct {
	pending []*pendingCall
	byIndex map[int]*pendingCall
}

type pendingCall struct {
	id, kind, name string
	args           strings.Builder
	objectArgs     json.RawMessage
	extra          map[string]json.RawMessage
}

type toolCallDelta struct {
	Index    *int   `json:"index"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
}

func (a *toolCallAssembler) add(batch []json.RawMessage) {
	for _, raw := range batch {
		var delta toolCallDelta
		if json.Unmarshal(raw, &delta) != nil {
			continue
		}
		call := a.target(delta)
		call.merge(delta, raw)
	}
}

func (a *toolCallAssembler) target(d toolCallDelta) *pendingCall {
	if d.Index != nil {
		if call, ok := a.byIndex[*d.Index]; ok && !call.startsAnother(d) {
			return call
		}
		call := a.open()
		if a.byIndex == nil {
			a.byIndex = map[int]*pendingCall{}
		}
		a.byIndex[*d.Index] = call
		return call
	}
	if d.ID == "" && d.Function.Name == "" && len(a.pending) > 0 {
		return a.pending[len(a.pending)-1]
	}
	return a.open()
}

func (a *toolCallAssembler) open() *pendingCall {
	call := &pendingCall{}
	a.pending = append(a.pending, call)
	return call
}

// startsAnother detecta un servidor que reutiliza el mismo index para llamadas
// distintas: otro id, o un nombre nuevo cuando la anterior ya está completa.
func (c *pendingCall) startsAnother(d toolCallDelta) bool {
	if d.ID != "" && c.id != "" && d.ID != c.id {
		return true
	}
	return d.Function.Name != "" && c.name != "" && c.args.Len() > 0 && json.Valid([]byte(c.args.String()))
}

func (c *pendingCall) merge(d toolCallDelta, raw json.RawMessage) {
	if c.id == "" {
		c.id = d.ID
	}
	if c.kind == "" {
		c.kind = d.Type
	}
	if c.name == "" {
		c.name = d.Function.Name
	}
	switch trimmed := strings.TrimSpace(string(d.Function.Arguments)); {
	case strings.HasPrefix(trimmed, `"`):
		var fragment string
		if json.Unmarshal(d.Function.Arguments, &fragment) == nil {
			c.args.WriteString(fragment)
		}
	case strings.HasPrefix(trimmed, "{"):
		c.objectArgs = d.Function.Arguments
	}
	// Campos que el protocolo no define (p. ej. extra_content de Gemini) hay
	// que devolverlos tal cual en el siguiente turno.
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) == nil {
		for key, value := range fields {
			switch key {
			case "index", "id", "type", "function":
			default:
				if c.extra == nil {
					c.extra = map[string]json.RawMessage{}
				}
				c.extra[key] = value
			}
		}
	}
}

// calls devuelve las llamadas completas. Un fragmento sin nombre no se puede
// ejecutar y se descarta.
func (a *toolCallAssembler) calls() []json.RawMessage {
	var out []json.RawMessage
	for i, c := range a.pending {
		if c.name == "" {
			continue
		}
		args := c.args.String()
		if args == "" && c.objectArgs != nil {
			args = string(c.objectArgs)
		}
		if strings.TrimSpace(args) == "" {
			args = "{}"
		}
		id := c.id
		if id == "" {
			id = fmt.Sprintf("call_%d", i+1)
		}
		kind := c.kind
		if kind == "" {
			kind = "function"
		}
		call := map[string]any{
			"id":       id,
			"type":     kind,
			"function": map[string]any{"name": c.name, "arguments": args},
		}
		for key, value := range c.extra {
			call[key] = value
		}
		if encoded, err := json.Marshal(call); err == nil {
			out = append(out, encoded)
		}
	}
	return out
}
