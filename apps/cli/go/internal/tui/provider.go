package tui

import (
	"context"
	"fmt"
	"net/url"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
)

const (
	addProviderValue = "\x00add"
	customValue      = "\x00custom"
	// addArg empieza por «-», que un nombre de proveedor nunca puede tener.
	addArg = "--add"
)

// gatewayOnly son los comandos que dependen de endpoints del gateway Lixbon.
var gatewayOnly = []string{"usage", "nodes", "key", "login", "logout", "web", "visual", "remote"}

func providerHost(baseURL string) string {
	if u, err := url.Parse(baseURL); err == nil && u.Host != "" {
		return u.Host
	}
	return baseURL
}

func (m *Model) cmdProvider(arg string) tea.Cmd {
	if name, ok := strings.CutPrefix(arg, "key "); ok {
		return m.cmdProviderKey(name)
	}
	if arg == addArg {
		m.pickPresetToAdd()
		return nil
	}
	if name, ok := strings.CutPrefix(arg, addArg+" "); ok {
		return m.addPreset(name)
	}
	if arg != "" {
		return m.switchProvider(strings.ToLower(arg))
	}
	cfg := m.chat.Cfg
	profiles := cfg.Profiles()
	var options []option
	cursor := 0
	for i, name := range cfg.ProfileNames() {
		p := profiles[name]
		kind := "gateway Lixbon"
		if p.Generic {
			kind = "compatible OpenAI"
		}
		o := option{Label: name, Value: name, Desc: providerHost(p.BaseURL) + " " + glyphSep + " " + kind}
		if name == cfg.ActiveProfile() {
			o.Badge, cursor = "activo", i
		}
		options = append(options, o)
	}
	options = append(options, option{Label: "Añadir proveedor…", Value: addProviderValue,
		Desc: "OpenRouter, OpenAI, Kilo, LM Studio, Ollama u otro servidor compatible"})
	p := newPicker("Proveedor de modelos", options, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled:
			return nil
		case value == addProviderValue:
			return func() tea.Msg { return runCommandMsg{name: "provider", arg: addArg} }
		}
		return func() tea.Msg { return runCommandMsg{name: "provider", arg: value} }
	})
	p.cursor = cursor
	m.picker = p
	return nil
}

func (m *Model) pickPresetToAdd() {
	saved := m.chat.Cfg.Profiles()
	var options []option
	for _, name := range config.PresetNames() {
		if _, exists := saved[name]; exists {
			continue
		}
		options = append(options, option{Label: name, Value: name, Desc: providerHost(config.Presets[name])})
	}
	options = append(options, option{Label: "otro…", Value: customValue, Desc: "servidor compatible con OpenAI: nombre y URL"})
	m.picker = newPicker("Añadir proveedor", options, func(value string, cancelled bool) tea.Cmd {
		switch {
		case cancelled:
			return nil
		case value == customValue:
			return promptCmd("Nombre del proveedor", m.askProviderURL)
		}
		return func() tea.Msg { return runCommandMsg{name: "provider", arg: addArg + " " + value} }
	})
}

func (m *Model) addPreset(name string) tea.Cmd {
	baseURL, ok := config.Presets[name]
	if !ok {
		m.print(errLine(fmt.Sprintf("No existe el preset «%s».", name)))
		return nil
	}
	if slices.Contains(config.LocalPresets, name) {
		return m.addProvider(name, baseURL, "")
	}
	m.promptFor("API key de «"+name+"» (escribe - si el servidor no la pide)", func(key string) tea.Cmd {
		return m.addProvider(name, baseURL, strings.TrimSpace(key))
	})
	return nil
}

func promptCmd(label string, onSubmit func(string) tea.Cmd) tea.Cmd {
	return func() tea.Msg { return promptMsg{label, onSubmit} }
}

func (m *Model) askProviderURL(text string) tea.Cmd {
	name, err := config.NormalizeProfileName(text)
	if err != nil {
		m.print(errLine(err.Error()))
		return nil
	}
	if _, exists := m.chat.Cfg.Profiles()[name]; exists {
		m.print(errLine(fmt.Sprintf("Ya existe el proveedor «%s».", name)))
		return nil
	}
	label := "URL base o preset (" + strings.Join(config.PresetNames(), ", ") + ")"
	if preset, ok := config.Presets[name]; ok {
		label += " " + glyphSep + " escribe " + name + " para " + preset
	}
	return promptCmd(label, func(text string) tea.Cmd { return m.askProviderKey(name, text) })
}

func (m *Model) askProviderKey(name, text string) tea.Cmd {
	baseURL, err := config.NormalizeBaseURL(text)
	if err != nil {
		m.print(errLine(err.Error()))
		return nil
	}
	return promptCmd("API key (escribe - si el servidor no la pide)", func(key string) tea.Cmd {
		return m.addProvider(name, baseURL, strings.TrimSpace(key))
	})
}

func (m *Model) addProvider(name, baseURL, key string) tea.Cmd {
	if key == "-" {
		key = ""
	}
	profile := config.Profile{BaseURL: baseURL, APIKey: key, ContextWindow: config.DefaultGenericContext, Generic: true}
	if err := m.chat.Cfg.AddProfile(name, profile); err != nil {
		m.print(errLine(err.Error()))
		return nil
	}
	m.saveConfig()
	m.print(okLine(fmt.Sprintf("Proveedor «%s» añadido (%s)", name, baseURL)))
	return m.switchProvider(name)
}

func (m *Model) switchProvider(name string) tea.Cmd {
	switch {
	case m.busyNow():
		m.print(errLine("Espera a que termine lo que está en marcha antes de cambiar de proveedor."))
		return nil
	case name == m.chat.Cfg.ActiveProfile():
		m.print(note(fmt.Sprintf("Ya usas «%s».", name)))
		return nil
	}
	previousMode := m.chat.Mode
	if err := m.chat.UseProfile(name); err != nil {
		m.print(errLine(err.Error()))
		return nil
	}
	if previousMode != m.chat.Mode {
		m.print(note("El modo delegate solo existe en un gateway Lixbon: pasas al modo ask."))
	}
	return m.connect(name)
}

// connect consulta el proveedor activo y muestra qué se encontró: modelos,
// problema de conexión o clave rechazada.
func (m *Model) connect(name string) tea.Cmd {
	m.opts.Account = chat.Account{Generic: m.chat.Client.Generic}
	m.online = false
	host := providerHost(m.chat.Client.BaseURL)
	return m.async("conectando con "+name, func(ctx context.Context) cmdDoneMsg {
		acc := m.chat.Probe(ctx)
		lines := []string{okLine(fmt.Sprintf("Proveedor: %s %s %s", name, glyphSep, host))}
		switch acc.State {
		case chat.AccountOffline:
			lines = append(lines, warnLine(serverProblem(acc, host)))
		case chat.AccountAuth:
			lines = append(lines, warnLine(host+" rechazó la clave."))
		}
		return cmdDoneMsg{lines: lines, apply: func(m *Model) {
			m.opts.Account = acc
			m.online = acc.State != chat.AccountOffline
			if acc.State == chat.AccountAuth {
				m.offerNewKey(name, acc.Generic)
				return
			}
			m.afterProviderProbe(acc)
		}}
	})
}

func serverProblem(acc chat.Account, host string) string {
	return api.ExplainListError(acc.ModelsErr, host)
}

func (m *Model) offerNewKey(name string, generic bool) {
	if !generic {
		m.print(note("/login inicia sesión de nuevo y /key pega otra API key."))
		return
	}
	m.promptFor("Nueva API key para «"+name+"» (Esc cancela)", func(key string) tea.Cmd {
		return m.setProviderKey(name, strings.TrimSpace(key))
	})
}

func (m *Model) setProviderKey(name, key string) tea.Cmd {
	if key == "" {
		return nil
	}
	if err := m.chat.Cfg.UpdateProfile(name, func(p *config.Profile) { p.APIKey = key }); err != nil {
		m.print(errLine(err.Error()))
		return nil
	}
	m.saveConfig()
	m.print(okLine(fmt.Sprintf("Clave de «%s» actualizada (%s)", name, config.MaskKey(key))))
	if name != m.chat.Cfg.ActiveProfile() {
		return nil
	}
	m.chat.Client.Configure(m.chat.Cfg)
	return m.connect(name)
}

func (m *Model) cmdProviderKey(name string) tea.Cmd {
	name = strings.ToLower(strings.TrimSpace(name))
	profile, ok := m.chat.Cfg.Profiles()[name]
	switch {
	case !ok:
		m.print(errLine(fmt.Sprintf("No existe el proveedor «%s».", name)))
	case !profile.Generic:
		m.print(note("«" + name + "» es un gateway Lixbon: usa /login o /key."))
	default:
		m.offerNewKey(name, true)
	}
	return nil
}

func (m *Model) afterProviderProbe(acc chat.Account) {
	needsPick, err := m.chat.ResolveModel(acc)
	switch {
	case err != nil:
		m.print(warnLine(err.Error()))
	case needsPick:
		m.queueModelPicker()
	case len(acc.Models) > 0 && !slices.ContainsFunc(acc.Models, func(mod api.Model) bool { return mod.ID == m.chat.Model }):
		m.print(warnLine(fmt.Sprintf("El modelo «%s» no está en la lista de este proveedor (%d disponibles). /model elige otro.", m.chat.Model, len(acc.Models))))
		m.queueModelPicker()
	default:
		line := "Modelo: " + m.modelLabel(m.chat.Model)
		if n := len(acc.Models); n > 1 && m.chat.Cfg.KeyModel == "" {
			line += fmt.Sprintf(" %s %d modelos disponibles, /model para cambiar", glyphSep, n)
		}
		m.print(note(line))
	}
}
