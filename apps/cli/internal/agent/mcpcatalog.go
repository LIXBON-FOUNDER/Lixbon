package agent

import (
	"encoding/json"
	"fmt"
	"strings"

	"lixbon.com/cli/internal/mcp"
	"lixbon.com/cli/internal/textutil"
)

// Las herramientas MCP no viajan todas en cada petición: el modelo ve los
// servidores por nombre, con cuántas herramientas ofrece cada uno y si está
// caído, y carga las de uno con mcp_tools cuando lo necesita. Desde ese
// paso, las de ese servidor van en la lista como cualquier otra.

// MCPToolsTool es la herramienta que carga las de un servidor MCP.
const MCPToolsTool = "mcp_tools"

// mcpCatalog es lo que un MCPClient ofrece para cargarse por servidores.
type mcpCatalog interface {
	Summary() []mcp.ServerInfo
	ServerSchemas(server string) []json.RawMessage
}

func (s *Session) catalog() (mcpCatalog, bool) {
	if s.MCP == nil {
		return nil, false
	}
	c, ok := s.MCP.(mcpCatalog)
	return c, ok && len(c.Summary()) > 0
}

// anyUp: algún servidor funciona o está arrancando; si todos están caídos,
// mcp_tools no sirve de nada y solo queda el aviso del prompt.
func anyUp(servers []mcp.ServerInfo) bool {
	for _, s := range servers {
		if s.Err == "" {
			return true
		}
	}
	return false
}

func toolsCount(n int) string {
	if n == 1 {
		return "1 herramienta"
	}
	return fmt.Sprintf("%d herramientas", n)
}

// mcpToolsSchema es la función mcp_tools para las tools nativas.
func mcpToolsSchema() map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name": MCPToolsTool,
			"description": "Carga las herramientas de un servidor MCP de la lista del prompt y devuelve cuáles son. " +
				"Desde el paso siguiente puedes llamarlas.",
			"parameters": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"server": map[string]any{"type": "string", "description": "Nombre del servidor MCP"},
				},
				"required": []string{"server"},
			},
		},
	}
}

// mcpCatalogPrompt lista los servidores: los cargados, los que se pueden
// cargar y los caídos con su motivo.
func mcpCatalogPrompt(servers []mcp.ServerInfo, loaded map[string]bool, native bool) string {
	lines := []string{"\n\n=== SERVIDORES MCP ==="}
	for _, s := range servers {
		switch {
		case s.Err != "":
			lines = append(lines, fmt.Sprintf("- %s: CAÍDO (%s). Si lo necesitas, dile al usuario que no está disponible "+
				"y sigue con lo demás; no busques otra vía para lo mismo.", s.Name, textutil.Head(s.Err, 160)))
		case s.Starting:
			lines = append(lines, fmt.Sprintf("- %s: arrancando; sus herramientas aún no están listas.", s.Name))
		case loaded[s.Name]:
			lines = append(lines, fmt.Sprintf("- %s: %s, ya cargadas.", s.Name, toolsCount(s.Tools)))
		default:
			lines = append(lines, fmt.Sprintf("- %s: %s.", s.Name, toolsCount(s.Tools)))
		}
	}
	call := "llama a `mcp_tools` con su nombre"
	if !native {
		call = `escribe {"tool":"mcp_tools","args":{"server":"<nombre>"}}`
	}
	lines = append(lines, "Cuando una tarea necesite uno de estos servidores, "+call+
		": te devuelve sus herramientas y desde el paso siguiente puedes usarlas. Carga solo los que necesites.")
	return strings.Join(lines, "\n")
}

// loadMCPServer atiende mcp_tools: marca el servidor como cargado y devuelve
// sus herramientas con sus argumentos.
func (t *Turn) loadMCPServer(args map[string]any) string {
	s := t.S
	server := strings.TrimSpace(stringArg(args, "server"))
	t.emit(Event{Kind: EventAction, Tool: MCPToolsTool, Text: server, ReadOnly: true})
	fail := func(text string) string {
		t.emit(Event{Kind: EventActionResult, Tool: MCPToolsTool, Summary: text, Failed: true})
		return "[ERROR] " + text
	}
	c, ok := s.catalog()
	if !ok {
		return fail("No hay servidores MCP configurados.")
	}
	var names []string
	for _, info := range c.Summary() {
		names = append(names, info.Name)
		if info.Name != server {
			continue
		}
		switch {
		case info.Err != "":
			return fail(fmt.Sprintf("El servidor MCP «%s» está caído: %s", server, info.Err))
		case info.Starting:
			return fail(fmt.Sprintf("El servidor MCP «%s» todavía está arrancando; inténtalo en un momento.", server))
		}
		if s.MCPLoaded == nil {
			s.MCPLoaded = map[string]bool{}
		}
		s.MCPLoaded[server] = true
		s.Stats.Actions++
		schemas := c.ServerSchemas(server)
		return fmt.Sprintf("Herramientas de «%s» (ya disponibles):\n%s", server, strings.Join(mcpToolLines(schemas), "\n"))
	}
	return fail(fmt.Sprintf("No hay ningún servidor MCP llamado «%s». Los que hay: %s.", server, strings.Join(names, ", ")))
}
