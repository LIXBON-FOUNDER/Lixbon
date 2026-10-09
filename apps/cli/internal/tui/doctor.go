package tui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
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
		lines := []string{""}
		render := func(c check) string {
			icon := sDim2.Render(glyphSep)
			switch {
			case c.ok != nil && *c.ok:
				icon = sOK.Render("✓")
			case c.ok != nil:
				icon = sWarn.Render("✗")
			}
			return "  " + icon + " " + sDim.Render(fmt.Sprintf("%-22s", c.label)) + " " + sPrimary.Render(c.detail)
		}
		for _, c := range checks {
			lines = append(lines, render(c))
		}
		if err != nil {
			reason := fmt.Sprintf("%v [sin respuesta]", err)
			if api.IsAuth(err) {
				reason = "la sesión no es válida (/login)"
			} else if apiErr := new(api.Error); errors.As(err, &apiErr) && apiErr.Status != 0 {
				reason = fmt.Sprintf("%v [%d]", err, apiErr.Status)
			}
			lines = append(lines, "  "+sErr.Render("✗")+" "+sDim.Render(fmt.Sprintf("%-22s", "Modelos"))+" "+sErr.Render(reason))
			return cmdDoneMsg{lines: append(lines, "")}
		}
		lines = append(lines, "  "+sOK.Render("✓")+" "+sDim.Render(fmt.Sprintf("%-22s", "Modelos"))+" "+
			sPrimary.Render(fmt.Sprintf("%d disponibles", len(models)))+sDim2.Render(fmt.Sprintf(" %dms", elapsed)))
		return cmdDoneMsg{lines: append(lines, ""), apply: func(m *Model) {
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
		{Label: "Cerrar ajustes", Value: ""},
	}
	m.picker = newPicker("Ajustes", entries, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled || value == "":
			return nil
		case value == "messages":
			return func() tea.Msg { return promptMsg{"Mensajes de historial que se envían (2-50)", m.setMessages} }
		case value == "context-window":
			return func() tea.Msg {
				return promptMsg{"Tokens de la ventana de contexto", func(v string) tea.Cmd { m.cmdContextWindow(v); return nil }}
			}
		case value == "workspace":
			return func() tea.Msg {
				return promptMsg{"Ruta del workspace", func(v string) tea.Cmd { m.cmdWorkspace(v); return nil }}
			}
		}
		return func() tea.Msg { return runCommandMsg{name: value} }
	})
	m.picker.hint = fmt.Sprintf("↑↓ mover %s ↵ cambiar %s esc salir", glyphSep, glyphSep)
	return nil
}

// promptMsg abre una pregunta de texto desde un selector ya cerrado.
type promptMsg struct {
	label    string
	onSubmit func(string) tea.Cmd
}

func (m *Model) setMessages(text string) tea.Cmd {
	n, err := strconv.Atoi(strings.TrimSpace(text))
	if err != nil {
		m.print(errLine("Valor no válido."))
		return nil
	}
	n = max(2, min(50, n))
	m.chat.Cfg.MaxContextMessages = n
	m.saveConfig()
	m.refreshContext()
	m.print(okLine(fmt.Sprintf("Se enviarán los últimos %d mensajes", n)))
	return nil
}
