package cli

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/x/term"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/weblogin"
)

// setup inicia sesión en el gateway de Lixbon. Con terminal abre la pantalla
// de login (navegador o API key); sin ella imprime la dirección del navegador,
// o usa --api-key. Nunca se pide correo ni contraseña en el CLI.
func (a *App) setup(ctx context.Context, args []string) int {
	fs := a.flagSet("setup")
	key := fs.String("api-key", "", "clave lixbon_sk_… (sin pantalla de login)")
	if code, stop := parseFlags(fs, args); stop {
		return code
	}
	cfg := config.Load(a.ConfigPath)
	if cfg.IsGeneric() {
		fmt.Fprintf(a.Stdout, "El proveedor «%s» no usa cuentas Lixbon. Cambia con: lixbon profile use lixbon\n", cfg.ActiveProfile())
		return 1
	}
	if k := strings.TrimSpace(*key); k != "" {
		return a.loginWithKey(ctx, cfg, k)
	}
	if a.Login != nil && a.isTerminal() {
		return a.Login(ctx)
	}
	return a.loginWithBrowser(ctx, cfg)
}

func (a *App) isTerminal() bool {
	if a.IsTerminal != nil {
		return a.IsTerminal()
	}
	in, ok := a.Stdin.(*os.File)
	out, ok2 := a.Stdout.(*os.File)
	return ok && ok2 && term.IsTerminal(in.Fd()) && term.IsTerminal(out.Fd())
}

func (a *App) saveConfig(cfg config.Config) bool {
	if err := config.Save(a.ConfigPath, cfg); err != nil {
		fmt.Fprintf(a.Stderr, "No se pudo guardar la configuración: %v\n", err)
		return false
	}
	return true
}

// loginWithKey verifica la clave con /api/key/info y, en un gateway antiguo
// que no lo tenga, con la lista de modelos.
func (a *App) loginWithKey(ctx context.Context, cfg config.Config, key string) int {
	client := api.FromConfig(cfg)
	client.SetKey(key)
	info, err := client.KeyInfo(ctx)
	if err != nil && !api.IsAuth(err) {
		_, err = client.Models(ctx)
	}
	if err != nil {
		a.printError("Clave inválida: " + err.Error())
		return 1
	}
	cfg.APIKey, cfg.KeyModel = key, info.KeyModel
	cfg.SetExtraString("account_email", "")
	if info.PlanName != "" {
		cfg.SetExtraString("plan_name", info.PlanName)
	}
	if info.KeyModel != "" {
		cfg.Model = info.KeyModel
		fmt.Fprintf(a.Stdout, "Clave vinculada al modelo %s (modelo fijo)\n", info.KeyModel)
	} else {
		fmt.Fprintln(a.Stdout, "Clave de API verificada")
	}
	if !a.saveConfig(cfg) {
		return 1
	}
	_ = config.RemoveSession(cfg.SessionFile(), cfg.ActiveProfile())
	a.defaultModel(ctx, client, &cfg)
	return 0
}

// loginWithBrowser es el login por navegador sin pantalla: imprime la
// dirección, intenta abrirla y espera a que el navegador vuelva.
func (a *App) loginWithBrowser(ctx context.Context, cfg config.Config) int {
	client := api.FromConfig(cfg)
	session, err := weblogin.Start(client.Server)
	if err != nil {
		a.printError(err.Error())
		return 1
	}
	defer session.Close()
	fmt.Fprintln(a.Stderr, "Abre esta dirección en el navegador para iniciar sesión con tu cuenta de lixbon.com:")
	fmt.Fprintln(a.Stderr, "  "+session.URL)
	fmt.Fprintln(a.Stderr, "Esperando la autorización (5 min)… Con una clave de API: lixbon setup --api-key lixbon_sk_…")
	open := a.OpenBrowser
	if open == nil {
		open = weblogin.OpenBrowser
	}
	_ = open(session.URL)

	wait, cancel := context.WithTimeout(ctx, weblogin.Timeout)
	defer cancel()
	token, err := session.Wait(wait)
	if err != nil {
		a.printError(err.Error())
		return 1
	}
	tokens, user, err := client.ExchangeIDEToken(ctx, token, session.Verifier)
	if err == nil {
		err = client.StartSession(cfg, tokens)
	}
	if err != nil {
		a.printError(err.Error())
		return 1
	}
	cfg.APIKey, cfg.KeyModel = tokens.Access, ""
	cfg.SetExtraString("account_email", user.Email)
	if user.PlanName != "" {
		cfg.SetExtraString("plan_name", user.PlanName)
	}
	if !a.saveConfig(cfg) {
		return 1
	}
	line := "Sesión iniciada"
	if user.Email != "" {
		line += " como " + user.Email
	}
	if user.PlanName != "" {
		line += " · plan " + user.PlanName
	}
	fmt.Fprintln(a.Stdout, line)
	a.defaultModel(ctx, client, &cfg)
	return 0
}

// defaultModel elige el modelo de chat que fija el servidor si aún no hay uno;
// si no lo fija, se elige dentro del chat.
func (a *App) defaultModel(ctx context.Context, client *api.Client, cfg *config.Config) {
	if cfg.Model != "" || cfg.KeyModel != "" {
		return
	}
	if model := client.RoleChatModel(ctx); model != "" {
		cfg.Model = model
		if a.saveConfig(*cfg) {
			fmt.Fprintf(a.Stdout, "Modelo: %s\n", model)
		}
		return
	}
	fmt.Fprintln(a.Stdout, "Elige el modelo dentro del chat con /model.")
}
