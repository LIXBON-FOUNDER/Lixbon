package tui

import (
	"fmt"

	"lixbon.com/cli/internal/textutil"
)

const mcpToolDescriptionWidth = 90

func (m *Model) cmdMCP() {
	reg := m.chat.MCP
	if reg == nil {
		m.add(note("Sin servidores MCP. Declara alguno en .lixbon/mcp.json (proyecto) o ~/.lixbon/mcp.json:"))
		m.add(note(`{"servers": {"nombre": {"command": "npx", "args": ["-y", "@paquete/servidor"], "env": {}}}}`))
		return
	}
	starting := false
	for _, s := range reg.Summary() {
		switch {
		case s.Err != "":
			m.add(errLine(s.Name + ": " + s.Err))
		case s.Starting:
			starting = true
			m.add(note(s.Name + ": arrancando…"))
		default:
			m.add(okLine(fmt.Sprintf("%s: %d %s  (%s)", s.Name, s.Tools,
				plural(s.Tools, "herramienta", "herramientas"), s.Target)))
		}
	}
	tools := reportBlock{keys: true}
	for _, t := range reg.Tools() {
		tools.rows = append(tools.rows, [2]string{t.Name, sDim.Render(textutil.Head(t.Description, mcpToolDescriptionWidth))})
	}
	if len(tools.rows) > 0 {
		m.add(tools)
	}
	if starting {
		m.add(note("Algunos servidores todavía están arrancando; vuelve a ejecutar /mcp en un momento."))
	}
}
