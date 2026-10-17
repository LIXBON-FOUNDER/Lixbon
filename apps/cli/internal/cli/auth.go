package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
)

const authUsage = `Credenciales de los proveedores de modelos:
  lixbon auth login [PROVEEDOR] [--api-key K] [--base-url URL] [--model M]
        Conecta un proveedor y lo activa. PROVEEDOR es un preset (%s),
        uno ya guardado, «lixbon» (inicia sesión con tu cuenta) o un nombre
        nuevo con --base-url. Sin PROVEEDOR se elige de una lista.
  lixbon auth list                 Ver qué proveedores tienen clave
  lixbon auth logout [PROVEEDOR]   Quitar la clave de un proveedor (el activo por defecto)

La clave no se pasa por la línea de comandos si no quieres: sin --api-key se
pide sin mostrarla.
`

const customProviderValue = "\x00custom"

func (a *App) auth(ctx context.Context, args []string) int {
	if len(args) == 0 {
		return a.authList()
	}
	switch name, rest := args[0], args[1:]; name {
	case "login":
		return a.authLogin(ctx, rest)
	case "list", "ls":
		return a.authList()
	case "logout":
		return a.authLogout(rest)
	case "-h", "--help", "help":
		fmt.Fprintf(a.Stdout, authUsage, strings.Join(config.PresetNames(), ", "))
		return 0
	default:
		fmt.Fprintf(a.Stderr, "auth: subcomando desconocido %q\n\n"+authUsage, name, strings.Join(config.PresetNames(), ", "))
		return 2
	}
}

func (a *App) authList() int {
	cfg := config.Load(a.ConfigPath)
	profiles := cfg.Profiles()
	fmt.Fprintln(a.Stdout, "Proveedores:")
	for _, name := range cfg.ProfileNames() {
		p := profiles[name]
		marker := " "
		if name == cfg.ActiveProfile() {
			marker = "*"
		}
		key := config.MaskKey(p.APIKey)
		if p.APIKey == "" && p.Generic {
			key = "sin clave"
		}
		model := p.Model
		if model == "" {
			model = "-"
		}
		fmt.Fprintf(a.Stdout, "%s %-12s clave: %-26s %-40s modelo: %s\n", marker, name, key, hostOf(p.BaseURL), model)
	}
	return 0
}

func hostOf(baseURL string) string {
	if u, err := url.Parse(baseURL); err == nil && u.Host != "" {
		return u.Host
	}
	return baseURL
}

func visited(fs *flag.FlagSet) map[string]bool {
	given := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { given[f.Name] = true })
	return given
}

func (a *App) authLogin(ctx context.Context, args []string) int {
	name := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		name, args = args[0], args[1:]
	}
	fs := a.flagSet("auth login")
	baseURL := fs.String("base-url", "", "URL base o preset (para un proveedor nuevo)")
	apiKey := fs.String("api-key", "", "API key")
	model := fs.String("model", "", "modelo por defecto")
	if code, stop := parseFlags(fs, args); stop {
		return code
	}
	given := visited(fs)
	cfg := config.Load(a.ConfigPath)
	prompts := a.newPrompter()

	if name == "" {
		var ok bool
		if name, ok = a.chooseProvider(prompts, cfg); !ok {
			return 1
		}
		if name == customProviderValue {
			if name, *baseURL, ok = a.askCustomProvider(prompts); !ok {
				return 1
			}
			given["base-url"] = true
		}
	}
	name, err := config.NormalizeProfileName(name)
	if err != nil {
		fmt.Fprintf(a.Stderr, "auth login: %v\n", err)
		return 2
	}

	profile, exists := cfg.Profiles()[name]
	if name == config.DefaultProfile && !exists {
		profile = config.Profile{BaseURL: config.DefaultBaseURL}
		exists = cfg.AddProfile(name, profile) == nil
	}
	if exists && !profile.Generic {
		return a.loginGateway(ctx, cfg, name, given["api-key"], *apiKey)
	}

	if !exists || given["base-url"] {
		target := *baseURL
		if target == "" {
			target = name
		}
		resolved, err := config.NormalizeBaseURL(target)
		if err != nil {
			fmt.Fprintf(a.Stderr, "auth login: %v\n", err)
			return 2
		}
		profile.BaseURL = resolved
	}
	if !exists {
		profile.ContextWindow, profile.Generic = config.DefaultContext(profile.BaseURL), true
	}
	key, ok := a.providerKey(prompts, name, profile.BaseURL, given["api-key"], *apiKey)
	if !ok {
		return 1
	}
	profile.APIKey = key
	if given["model"] {
		profile.Model = strings.TrimSpace(*model)
	}

	if exists {
		err = cfg.UpdateProfile(name, func(p *config.Profile) { *p = profile })
	} else {
		err = cfg.AddProfile(name, profile)
	}
	if err == nil {
		err = cfg.UseProfile(name)
	}
	if err != nil {
		fmt.Fprintf(a.Stderr, "auth login: %v\n", err)
		return 1
	}
	if !a.saveConfig(cfg) {
		return 1
	}
	fmt.Fprintf(a.Stdout, "Proveedor «%s» guardado y activo (%s).\n", name, hostOf(profile.BaseURL))
	if hint := config.KeyHint(profile.BaseURL, key); hint != "" {
		fmt.Fprintln(a.Stderr, hint)
	}
	return a.reportModels(ctx, cfg)
}

// reportModels comprueba la clave y la URL recién guardadas listando los modelos.
func (a *App) reportModels(ctx context.Context, cfg config.Config) int {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	models, err := api.FromConfig(cfg).ModelsDetail(ctx)
	host := hostOf(cfg.BaseURL)
	switch {
	case api.IsAuth(err):
		fmt.Fprintf(a.Stderr, "%s rechazó la clave. Vuelve a ejecutar: lixbon auth login %s\n", host, cfg.ActiveProfile())
		return 1
	case err != nil:
		fmt.Fprintln(a.Stderr, api.ExplainListError(err, host))
		var apiErr *api.Error
		if errors.As(err, &apiErr) && apiErr.Status > 0 {
			return 1
		}
		return 0
	}
	fmt.Fprintf(a.Stdout, "%d modelos disponibles.", len(models))
	if cfg.Model == "" && len(models) > 0 {
		fmt.Fprint(a.Stdout, " Elige uno dentro del chat con /model.")
	}
	fmt.Fprintln(a.Stdout)
	return 0
}

// providerKey toma la clave de --api-key o la pide sin mostrarla. Vacía solo es
// válido en servidores locales o si se pasó --api-key explícitamente.
func (a *App) providerKey(p *prompter, name, baseURL string, given bool, flagValue string) (string, bool) {
	if given {
		return strings.TrimSpace(flagValue), true
	}
	key, ok := p.ask("API key de «"+name+"» (vacía si el servidor no la pide)", true)
	if !ok {
		return "", false
	}
	if key == "" && !isLocalProvider(name, baseURL) {
		fmt.Fprintf(a.Stderr, "auth login: «%s» necesita una API key. Si no la pide, usa --api-key \"\".\n", name)
		return "", false
	}
	return key, true
}

func isLocalProvider(name, baseURL string) bool {
	if slices.Contains(config.LocalPresets, name) {
		return true
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	host := u.Hostname()
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func (a *App) loginGateway(ctx context.Context, cfg config.Config, name string, keyGiven bool, key string) int {
	if err := cfg.UseProfile(name); err != nil {
		fmt.Fprintf(a.Stderr, "auth login: %v\n", err)
		return 1
	}
	if !a.saveConfig(cfg) {
		return 1
	}
	if !keyGiven {
		return a.setup(ctx, nil)
	}
	client := api.FromConfig(cfg)
	client.SetKey(strings.TrimSpace(key))
	info, err := client.KeyInfo(ctx)
	if err != nil {
		if _, fallback := client.Models(ctx); fallback != nil {
			a.printError("Clave inválida: " + fallback.Error())
			return 1
		}
	}
	cfg.APIKey, cfg.KeyModel = client.APIKey, info.KeyModel
	cfg.SetExtraString("account_email", "")
	if info.KeyModel != "" {
		cfg.Model = info.KeyModel
	}
	if !a.saveConfig(cfg) {
		return 1
	}
	_ = config.RemoveSession(cfg.SessionFile(), name)
	fmt.Fprintf(a.Stdout, "Proveedor «%s» activo con la clave verificada.\n", name)
	return 0
}

func (a *App) chooseProvider(p *prompter, cfg config.Config) (string, bool) {
	profiles := cfg.Profiles()
	var options []choice
	for _, name := range cfg.ProfileNames() {
		options = append(options, choice{label: name, detail: hostOf(profiles[name].BaseURL) + " (guardado)", value: name})
	}
	for _, name := range config.PresetNames() {
		if _, saved := profiles[name]; !saved {
			options = append(options, choice{label: name, detail: hostOf(config.Presets[name]), value: name})
		}
	}
	options = append(options, choice{label: "otro", detail: "servidor compatible con OpenAI, con su URL", value: customProviderValue})
	return p.choose("Proveedor", options)
}

func (a *App) askCustomProvider(p *prompter) (name, baseURL string, ok bool) {
	if name, ok = p.ask("Nombre del proveedor", false); !ok || name == "" {
		return "", "", false
	}
	if baseURL, ok = p.ask("URL base (https://…/v1)", false); !ok || baseURL == "" {
		return "", "", false
	}
	return name, baseURL, true
}

func (a *App) authLogout(args []string) int {
	cfg := config.Load(a.ConfigPath)
	name := cfg.ActiveProfile()
	if len(args) > 1 {
		fmt.Fprintln(a.Stderr, "Uso: lixbon auth logout [PROVEEDOR]")
		return 2
	}
	if len(args) == 1 {
		name = strings.ToLower(strings.TrimSpace(args[0]))
	}
	profile, ok := cfg.Profiles()[name]
	if !ok {
		fmt.Fprintf(a.Stderr, "auth logout: No existe el proveedor «%s».\n", name)
		return 1
	}
	if profile.APIKey == "" {
		fmt.Fprintf(a.Stdout, "«%s» no tiene clave guardada.\n", name)
		return 0
	}
	what := "Clave"
	if s, ok := config.ReadSession(cfg.SessionFile(), name); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = api.New(profile.BaseURL, "").RevokeRefresh(ctx, s.Refresh)
		cancel()
		_ = config.RemoveSession(cfg.SessionFile(), name)
		what = "Sesión"
	}
	if err := cfg.UpdateProfile(name, func(p *config.Profile) { p.APIKey, p.KeyModel = "", "" }); err != nil {
		fmt.Fprintf(a.Stderr, "auth logout: %v\n", err)
		return 1
	}
	if !profile.Generic && name == cfg.ActiveProfile() {
		cfg.SetExtraString("account_email", "")
		cfg.SetExtraString("plan_name", "")
	}
	if !a.saveConfig(cfg) {
		return 1
	}
	fmt.Fprintf(a.Stdout, "%s de «%s» cerrada en este equipo. El proveedor sigue guardado: lixbon auth login %s vuelve a entrar.\n", what, name, name)
	return 0
}
