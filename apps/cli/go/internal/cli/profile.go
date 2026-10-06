package cli

import (
	"fmt"
	"strings"

	"lixbon.com/cli/internal/config"
)

const profileUsage = `Proveedores de modelos (lixbon.com, LM Studio, Ollama, OpenAI, OpenRouter…):
  lixbon profile                       Listar los proveedores
  lixbon profile add NOMBRE --base-url URL|preset [--api-key K] [--model M]
                                       [--context-window N] [--gateway] [--use]
  lixbon profile use NOMBRE            Cambiar de proveedor
  lixbon profile remove NOMBRE         Eliminar un proveedor

Presets: %s
Sin --gateway, el proveedor se trata como un servidor compatible con OpenAI:
no se le envían campos propios de Lixbon y la clave es opcional.
`

func (a *App) profile(args []string) int {
	if len(args) == 0 {
		return a.profileList()
	}
	switch name, rest := args[0], args[1:]; name {
	case "list", "ls":
		return a.profileList()
	case "add":
		return a.profileAdd(rest)
	case "use":
		return a.profileUse(rest)
	case "remove", "rm":
		return a.profileRemove(rest)
	case "-h", "--help", "help":
		fmt.Fprintf(a.Stdout, profileUsage, strings.Join(config.PresetNames(), ", "))
		return 0
	default:
		fmt.Fprintf(a.Stderr, "profile: subcomando desconocido %q\n\n"+profileUsage, name, strings.Join(config.PresetNames(), ", "))
		return 2
	}
}

func (a *App) profileList() int {
	cfg := config.Load(a.ConfigPath)
	profiles := cfg.Profiles()
	fmt.Fprintln(a.Stdout, "Proveedores:")
	for _, name := range cfg.ProfileNames() {
		p := profiles[name]
		marker, kind := " ", "gateway "
		if name == cfg.ActiveProfile() {
			marker = "*"
		}
		if p.Generic {
			kind = "genérico"
		}
		model := p.Model
		if model == "" {
			model = "-"
		}
		fmt.Fprintf(a.Stdout, "%s %-14s %s  %-44s modelo: %s\n", marker, name, kind, p.BaseURL, model)
	}
	return 0
}

func (a *App) profileAdd(args []string) int {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		fmt.Fprintf(a.Stderr, "profile add: falta el nombre\n\n"+profileUsage, strings.Join(config.PresetNames(), ", "))
		return 2
	}
	name, err := config.NormalizeProfileName(args[0])
	if err != nil {
		fmt.Fprintf(a.Stderr, "profile add: %v\n", err)
		return 2
	}
	fs := a.flagSet("profile add")
	baseURL := fs.String("base-url", "", "URL base o preset")
	apiKey := fs.String("api-key", "", "API key (opcional en servidores locales)")
	model := fs.String("model", "", "modelo por defecto")
	contextWindow := fs.Int("context-window", 0, "ventana de contexto (tokens)")
	gateway := fs.Bool("gateway", false, "es un gateway Lixbon, no un servidor genérico")
	use := fs.Bool("use", false, "activarlo al crearlo")
	if code, stop := parseFlags(fs, args[1:]); stop {
		return code
	}
	target := *baseURL
	if target == "" {
		target = name
	}
	url, err := config.NormalizeBaseURL(target)
	if err != nil {
		fmt.Fprintf(a.Stderr, "profile add: %v\n", err)
		return 2
	}
	window := *contextWindow
	switch {
	case window > 0:
		window = max(1024, window)
	case !*gateway:
		window = config.DefaultGenericContext
	}

	cfg := config.Load(a.ConfigPath)
	p := config.Profile{
		BaseURL: url, APIKey: strings.TrimSpace(*apiKey), Model: strings.TrimSpace(*model),
		ContextWindow: window, Generic: !*gateway,
	}
	if err := cfg.AddProfile(name, p); err != nil {
		fmt.Fprintf(a.Stderr, "profile add: %v\n", err)
		return 1
	}
	if *use {
		if err := cfg.UseProfile(name); err != nil {
			fmt.Fprintf(a.Stderr, "profile add: %v\n", err)
			return 1
		}
	}
	if err := config.Save(a.ConfigPath, cfg); err != nil {
		fmt.Fprintf(a.Stderr, "No se pudo guardar la configuración: %v\n", err)
		return 1
	}
	fmt.Fprintf(a.Stdout, "Proveedor «%s» añadido (%s).\n", name, url)
	if *use {
		fmt.Fprintf(a.Stdout, "Ahora usas «%s».\n", name)
	} else {
		fmt.Fprintf(a.Stdout, "Actívalo con: lixbon profile use %s\n", name)
	}
	return 0
}

func (a *App) profileUse(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(a.Stderr, "Uso: lixbon profile use NOMBRE")
		return 2
	}
	cfg := config.Load(a.ConfigPath)
	if err := cfg.UseProfile(strings.ToLower(strings.TrimSpace(args[0]))); err != nil {
		fmt.Fprintf(a.Stderr, "profile use: %v\n", err)
		return 1
	}
	if err := config.Save(a.ConfigPath, cfg); err != nil {
		fmt.Fprintf(a.Stderr, "No se pudo guardar la configuración: %v\n", err)
		return 1
	}
	fmt.Fprintf(a.Stdout, "Ahora usas «%s» (%s).\n", cfg.ActiveProfile(), cfg.BaseURL)
	return 0
}

func (a *App) profileRemove(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(a.Stderr, "Uso: lixbon profile remove NOMBRE")
		return 2
	}
	cfg := config.Load(a.ConfigPath)
	name := strings.ToLower(strings.TrimSpace(args[0]))
	if err := cfg.RemoveProfile(name); err != nil {
		fmt.Fprintf(a.Stderr, "profile remove: %v\n", err)
		return 1
	}
	if err := config.Save(a.ConfigPath, cfg); err != nil {
		fmt.Fprintf(a.Stderr, "No se pudo guardar la configuración: %v\n", err)
		return 1
	}
	fmt.Fprintf(a.Stdout, "Proveedor «%s» eliminado.\n", name)
	return 0
}
