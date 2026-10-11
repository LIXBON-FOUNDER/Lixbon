package tui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
)

// runCommandMsg ejecuta un comando desde un selector ya cerrado: el selector
// se retira justo después de llamar a done, así que un comando que abre otro
// selector no puede hacerlo desde ahí.
type runCommandMsg struct{ name, arg string }

func (m *Model) cmdDoctor() tea.Cmd {
	terminal := os.Getenv("TERM_PROGRAM")
	if terminal == "" {
		terminal = firstNonEmpty(os.Getenv("WT_SESSION"), os.Getenv("TERM"), "consola nativa")
		if os.Getenv("WT_SESSION") != "" {
			terminal = "Windows Terminal"
		}
	}
	type check struct {
		ok            *bool
		label, detail string
	}
	yes := true
	checks := []check{
		{&yes, "CLI", fmt.Sprintf("v%s %s Go %s %s %s/%s", config.Version, glyphSep, strings.TrimPrefix(runtime.Version(), "go"), glyphSep, runtime.GOOS, runtime.GOARCH)},
		{nil, "Tamaño", fmt.Sprintf("%dx%d %s %s", m.width, m.height, glyphSep, terminal)},
		{nil, "Config", m.chat.ConfigPath},
		{nil, "Servidor", m.chat.Client.BaseURL},
		{nil, "Workspace", m.chat.Workspace},
	}
	return m.async("probando el servidor", func(ctx context.Context) cmdDoneMsg {
		started := time.Now()
		models, err := m.chat.Client.ModelsDetail(ctx)
		elapsed := time.Since(started).Milliseconds()
		report := reportBlock{title: "Diagnóstico"}
		for _, c := range checks {
			icon := sDim2.Render(glyphSep)
			if c.ok != nil && *c.ok {
				icon = sOK.Render(glyphs.check)
			}
			report.rows = append(report.rows, [2]string{c.label, icon + " " + sPrimary.Render(c.detail)})
		}
		if err != nil {
			reason := fmt.Sprintf("%v [sin respuesta]", err)
			if api.IsAuth(err) {
				reason = "la sesión no es válida (/login)"
			} else if apiErr := new(api.Error); errors.As(err, &apiErr) && apiErr.Status != 0 {
				reason = fmt.Sprintf("%v [%d]", err, apiErr.Status)
			}
			report.rows = append(report.rows, [2]string{"Modelos", sErr.Render(glyphs.cross + " " + reason)})
			return cmdDoneMsg{lines: []block{report}}
		}
		report.rows = append(report.rows, [2]string{"Modelos", sOK.Render(glyphs.check) + " " +
			sPrimary.Render(fmt.Sprintf("%d disponibles", len(models))) + sDim2.Render(fmt.Sprintf(" %dms", elapsed))})
		return cmdDoneMsg{lines: []block{report}, apply: func(m *Model) {
			m.opts.Account.Models = models
			m.online = true
		}}
	})
}

func (m *Model) cmdConfig() tea.Cmd {
	cfg := m.chat.Cfg
	entries := []option{
		{Label: "Modelo", Value: "model", Desc: firstNonEmpty(m.chat.Model, "sin modelo")},
		{Label: "Modo de trabajo", Value: "mode", Desc: m.chat.Mode},
		{Label: "Auto-aprobar cambios", Value: "approve", Desc: onOff(m.chat.Session.AutoApprove)},
		{Label: "Búsqueda web", Value: "web", Desc: m.chat.WebMode},
		{Label: "Ventana de contexto", Value: "context-window", Desc: fmt.Sprintf("%d tokens", cfg.ContextWindow)},
		{Label: "Mensajes enviados", Value: "messages", Desc: strconv.Itoa(cfg.MaxContextMessages)},
		{Label: "Workspace", Value: "workspace", Desc: shortPath(m.chat.Workspace)},
		{Label: "Tema", Value: "theme", Desc: themeLabel(cfg.ExtraString("theme"))},
		{Label: "Cerrar ajustes", Value: ""},
	}
	m.picker = newPicker("Ajustes", entries, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled || value == "":
			return nil
		case value == "messages":
			return func() tea.Msg {
				return promptMsg{label: "Mensajes de historial que se envían (2-50)", onSubmit: m.setMessages}
			}
		case value == "context-window":
			return func() tea.Msg {
				return promptMsg{label: "Tokens de la ventana de contexto", onSubmit: func(v string) tea.Cmd { m.cmdContextWindow(v); return nil }}
			}
		case value == "workspace":
			return func() tea.Msg {
				return promptMsg{label: "Ruta del workspace", onSubmit: func(v string) tea.Cmd { m.cmdWorkspace(v); return nil }}
			}
		}
		return func() tea.Msg { return runCommandMsg{name: value} }
	})
	m.picker.keys = [][2]string{{"↑↓", "mover"}, {"↵", "cambiar"}, {"esc", "salir"}}
	return nil
}

func themeLabel(value string) string {
	switch value {
	case "dark":
		return "oscuro"
	case "light":
		return "claro"
	}
	return "automático"
}

// cmdTheme elige el tema. En automático se pregunta el color de fondo a la
// terminal a través de Bubble Tea: con el programa en marcha no se puede leer
// stdin por fuera.
func (m *Model) cmdTheme(arg string) tea.Cmd {
	apply := func(value string) tea.Cmd {
		m.chat.Cfg.SetExtraString("theme", value)
		m.saveConfig()
		m.add(okLine("Tema: " + themeLabel(value)))
		if value == "auto" {
			return tea.RequestBackgroundColor
		}
		m.setTheme(value == "dark")
		return nil
	}
	if slices.Contains([]string{"auto", "dark", "light"}, arg) {
		return apply(arg)
	}
	options := []option{
		{Label: "automático", Value: "auto", Desc: "según el fondo de la terminal"},
		{Label: "oscuro", Value: "dark", Desc: "texto claro sobre fondo oscuro"},
		{Label: "claro", Value: "light", Desc: "texto oscuro sobre fondo claro"},
	}
	p := newPicker("Tema", options, func(value string, cancelled bool) tea.Cmd {
		if cancelled {
			return nil
		}
		return apply(value)
	})
	for i, o := range options {
		if o.Value == firstNonEmpty(m.chat.Cfg.ExtraString("theme"), "auto") {
			p.cursor = i
		}
	}
	m.picker = p
	return nil
}

// setTheme cambia los colores y repinta el transcript entero.
func (m *Model) setTheme(dark bool) {
	if dark == pal.dark {
		return
	}
	applyTheme(paletteFor(dark))
	m.input.SetStyles(inputStyles())
	m.log.relayout()
	m.sel = nil
}

// promptMsg abre una pregunta de texto desde un selector ya cerrado.
type promptMsg struct {
	label    string
	onSubmit func(string) tea.Cmd
	secret   bool
}

func (m *Model) setMessages(text string) tea.Cmd {
	n, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil {
		m.add(errLine("Valor no válido."))
		return nil
	}
	n = max(2, min(50, n))
	m.chat.Cfg.MaxContextMessages = n
	m.saveConfig()
	m.refreshContext()
	m.add(okLine(fmt.Sprintf("Se enviarán los últimos %d mensajes", n)))
	return nil
}
