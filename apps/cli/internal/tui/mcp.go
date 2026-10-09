package tui

import (
	"fmt"
	"strings"

	"lixbon.com/cli/internal/textutil"
)

const mcpToolDescriptionWidth = 90

func (m *Model) cmdMCP() {
	reg := m.chat.MCP
	if reg == nil {
		m.print(strings.Join([]string{
			note("Sin servidores MCP. Declara alguno en .lixbon/mcp.json (proyecto) o ~/.lixbon/mcp.json:"),
			note(`{"servers": {"nombre": {"command": "npx", "args": ["-y", "@paquete/servidor"], "env": {}}}}`),
		}, "\n"))
		return
	}
	var lines []string
	starting := false
	for _, s := range reg.Summary() {
		switch {
		case s.Err != "":
			lines = append(lines, errLine(s.Name+": "+s.Err))
		case s.Starting:
			starting = true
			lines = append(lines, "  "+sDim2.Render(s.Name+": arrancando…"))
		default:
			lines = append(lines, okLine(fmt.Sprintf("%s: %d %s  (%s)", s.Name, s.Tools,
				plural(s.Tools, "herramienta", "herramientas"), s.Target)))
		}
	}
	for _, t := range reg.Tools() {
		lines = append(lines, "  "+sBold.Render(t.Name)+"  "+sDim.Render(textutil.Head(t.Description, mcpToolDescriptionWidth)))
	}
	if starting {
		lines = append(lines, note("Algunos servidores todavía están arrancando; vuelve a ejecutar /mcp en un momento."))
	}
	m.print(strings.Join(lines, "\n"))
}
