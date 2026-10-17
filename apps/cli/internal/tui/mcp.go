package tui

import (
	"errors"
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/mcp"
	"lixbon.com/cli/internal/textutil"
)

const (
	mcpToolDescriptionWidth = 90
	addMCPValue             = "\x00add-mcp"
	mcpScopeUser            = "solo para mí"
	mcpScopeProject         = "este proyecto"
)

// cmdMCP abre los servidores MCP: elegir uno enseña sus herramientas y la
// última fila añade otro.
func (m *Model) cmdMCP() {
	var options []option
	if reg := m.chat.MCP; reg != nil {
		for _, s := range reg.Summary() {
			o := option{Label: s.Name, Value: s.Name}
			switch {
			case s.Err != "":
				o.Desc, o.Badge = textutil.Head(s.Err, 70), "error"
			case s.Starting:
				o.Desc = "arrancando…"
			default:
				o.Desc = fmt.Sprintf("%d %s %s %s", s.Tools, plural(s.Tools, "herramienta", "herramientas"), glyphSep, s.Target)
			}
			options = append(options, o)
		}
	}
	options = append(options, option{Label: "Añadir servidor MCP…", Value: addMCPValue,
		Desc: "un comando local (npx, uvx…) o una URL"})
	m.picker = newPicker("Servidores MCP", options, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled:
		case value == addMCPValue:
			m.addMCPForm()
		default:
			m.picker = newInfoPanel("Herramientas de "+value, func(width int) []string { return m.mcpTools(value, width) })
		}
		return nil
	})
}

func (m *Model) mcpTools(server string, width int) []string {
	var lines []string
	if m.chat.MCP != nil {
		if s, ok := m.chat.MCP.Server(server); ok {
			if reason := s.Err(); reason != "" {
				lines = append(lines, sErr.Render(reason))
			}
			for _, t := range s.Tools() {
				lines = append(lines, sPrimary.Render(t.Name)+"  "+sDim.Render(textutil.Head(t.Description, max(10, width-len(t.Name)-2))))
			}
		}
	}
	if len(lines) == 0 {
		lines = append(lines, sDim.Render("Sin herramientas todavía: si está arrancando, vuelve a abrir /mcp en un momento."))
	}
	return lines
}

func (m *Model) addMCPForm() {
	m.picker = newForm("Añadir servidor MCP", []*formField{
		field("Nombre", withHint("sus herramientas se llamarán mcp__nombre__…")),
		field("Comando o URL", withHint("p. ej. npx -y @modelcontextprotocol/server-memory  o  https://servidor/mcp")),
		field("Variables o cabeceras", secretField(), optionalField(),
			withHint("CLAVE=valor separadas por espacios: entorno del comando o cabeceras de la URL")),
		field("Guardar", withChoices(mcpScopeUser, mcpScopeProject),
			withHint("solo para mí: ~/.lixbon/mcp.json · este proyecto: .lixbon/mcp.json del workspace")),
	}, func(v []string) (tea.Cmd, error) {
		if m.busyNow() {
			return nil, errors.New("Espera a que termine lo que está en marcha.")
		}
		server, err := mcpEntry(v[1], v[2])
		if err != nil {
			return nil, err
		}
		path := m.chat.MCPFile(v[3] == mcpScopeProject)
		if err := mcp.AddServer(path, v[0], server); err != nil {
			return nil, err
		}
		m.chat.ReloadMCP()
		m.add(okLine(fmt.Sprintf("Servidor MCP «%s» añadido en %s: arrancando…", v[0], shortPath(path))))
		m.add(note("/mcp enseña sus herramientas cuando termine de arrancar."))
		return nil, nil
	})
}

// mcpEntry traduce lo escrito al formato de mcp.json.
func mcpEntry(target, pairs string) (map[string]any, error) {
	vars := map[string]string{}
	for _, pair := range splitCommandLine(pairs) {
		k, v, ok := strings.Cut(pair, "=")
		if !ok || strings.TrimSpace(k) == "" {
			return nil, fmt.Errorf("«%s» no es CLAVE=valor.", textutil.Head(pair, 20))
		}
		vars[k] = v
	}
	if strings.HasPrefix(target, "http://") || strings.HasPrefix(target, "https://") {
		server := map[string]any{"url": strings.TrimSpace(target)}
		if len(vars) > 0 {
			server["headers"] = vars
		}
		return server, nil
	}
	parts := splitCommandLine(target)
	if len(parts) == 0 {
		return nil, errors.New("Falta el comando.")
	}
	server := map[string]any{"command": parts[0]}
	if len(parts) > 1 {
		server["args"] = parts[1:]
	}
	if len(vars) > 0 {
		server["env"] = vars
	}
	return server, nil
}

// splitCommandLine parte por espacios respetando las comillas simples y dobles.
func splitCommandLine(s string) []string {
	var out []string
	var cur strings.Builder
	var quote rune
	inWord := false
	for _, r := range s {
		switch {
		case quote != 0 && r == quote:
			quote = 0
		case quote != 0:
			cur.WriteRune(r)
		case r == '"' || r == '\'':
			quote, inWord = r, true
		case r == ' ' || r == '\t':
			if inWord {
				out = append(out, cur.String())
				cur.Reset()
				inWord = false
			}
		default:
			cur.WriteRune(r)
			inWord = true
		}
	}
	if inWord {
		out = append(out, cur.String())
	}
	return out
}
