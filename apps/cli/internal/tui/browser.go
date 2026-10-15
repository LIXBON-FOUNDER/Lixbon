package tui

import (
	"context"
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/agent"
)

// cmdBrowser: /browser [on|off|auto|close|open <url>].
func (m *Model) cmdBrowser(arg string) tea.Cmd {
	c := m.chat
	verb, rest, _ := strings.Cut(strings.TrimSpace(arg), " ")
	if m.running && (verb == "close" || verb == "off" || verb == "open") {
		m.add(errLine("Espera a que termine el turno del agente."))
		return nil
	}
	switch verb {
	case "on", "off", "auto":
		if err := c.SetBrowserMode(verb); err != nil {
			m.add(errLine("No se pudo guardar la configuración: " + err.Error()))
		}
		m.refreshContext()
		m.browserStatus()
		return nil
	case "close":
		if c.Browser == nil || !c.Browser.Running() {
			m.add(note("El navegador del agente no está abierto."))
			return nil
		}
		c.Browser.Close()
		m.add(okLine("Navegador cerrado. Se volverá a abrir cuando el agente lo necesite."))
		return nil
	case "open":
		if c.Browser == nil {
			m.browserStatus()
			return nil
		}
		url := strings.TrimSpace(rest)
		if url == "" {
			url = "about:blank"
		}
		b := c.Browser
		return m.async("Abriendo el navegador", func(ctx context.Context) cmdDoneMsg {
			_, _, err := b.Run(ctx, "browser_navigate", map[string]any{"url": url})
			// Lo abre el usuario para él: sin el aviso de que lo usa el agente.
			b.Release()
			if err != nil {
				return cmdDoneMsg{lines: []block{errLine("No se pudo abrir: " + err.Error())}}
			}
			return cmdDoneMsg{lines: []block{okLine("Navegador abierto en " + url + "."),
				note("Inicia sesión donde haga falta: el perfil de Lixbon guarda la sesión para el agente.")}}
		})
	case "", "status":
		m.browserStatus()
		return nil
	}
	m.add(errLine("Uso: /browser [on|off|auto|close|open <url>]"))
	m.add(note("Para pedirle algo al agente escríbelo sin /browser, p. ej.: abre lixbon.com y dime qué dice la página"))
	return nil
}

func (m *Model) browserStatus() {
	c := m.chat
	s := c.Session
	m.gap()
	switch {
	case s.BrowserMode == "off":
		m.add(note("Navegador del agente: desactivado. /browser on para activarlo."))
		return
	case c.Browser == nil && c.BrowserErr != nil:
		m.add(errLine("Navegador del agente: " + c.BrowserErr.Error()))
		return
	case !s.BrowserEnabled():
		m.add(note(fmt.Sprintf("Navegador del agente: en auto, pero la ventana de contexto (%d) es menor de %d tokens. "+
			"/browser on para activarlo igualmente.", s.ContextWindow, agent.BrowserMinContext)))
	default:
		mode := "activado"
		if s.BrowserMode == "auto" {
			mode = "activado (auto)"
		}
		m.add(okLine("Navegador del agente: " + mode))
	}
	if c.Browser == nil {
		return
	}
	permission := "pide confirmación en cada sitio nuevo (localhost no pregunta)"
	if s.AutoBrowser {
		permission = "sin preguntar en ningún sitio"
	} else if len(s.BrowserOrigins) > 0 {
		permission += "; aprobados: " + strings.Join(s.BrowserOrigins, ", ")
	}
	lines := strings.Split(c.Browser.Status(context.Background()), "\n")
	lines = append(lines, "Permisos: "+permission,
		"/browser open <url> abre una página para iniciar sesión; /browser close lo cierra.")
	for _, l := range lines {
		m.add(note(l))
	}
}
