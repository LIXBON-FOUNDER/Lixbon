package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/charmbracelet/x/term"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
)

// prompter lee respuestas de la entrada estándar. ok es false cuando la
// persona cierra la entrada (Ctrl+D) o la interrumpe: el flujo se abandona.
type prompter struct {
	in  *bufio.Reader
	out io.Writer
	fd  uintptr
	tty bool
}

func (a *App) newPrompter() *prompter {
	in := a.Stdin
	if in == nil {
		in = os.Stdin
	}
	p := &prompter{in: bufio.NewReader(in), out: a.Stdout}
	if f, ok := in.(*os.File); ok && term.IsTerminal(f.Fd()) {
		p.fd, p.tty = f.Fd(), true
	}
	return p
}

func (p *prompter) ask(label string, secret bool) (string, bool) {
	fmt.Fprintf(p.out, "  %s: ", label)
	if secret && p.tty {
		raw, err := term.ReadPassword(p.fd)
		fmt.Fprintln(p.out)
		return strings.TrimSpace(string(raw)), err == nil
	}
	line, err := p.in.ReadString('\n')
	if err != nil && line == "" {
		fmt.Fprintln(p.out)
		return "", false
	}
	return strings.TrimSpace(line), true
}

type choice struct{ label, detail, value string }

func (p *prompter) choose(title string, options []choice) (string, bool) {
	fmt.Fprintln(p.out, title)
	for i, o := range options {
		fmt.Fprintf(p.out, "  %d) %s", i+1, o.label)
		if o.detail != "" {
			fmt.Fprintf(p.out, " — %s", o.detail)
		}
		fmt.Fprintln(p.out)
	}
	for {
		answer, ok := p.ask("Elige un número", false)
		if !ok || answer == "" {
			return "", false
		}
		if n, err := strconv.Atoi(answer); err == nil && n >= 1 && n <= len(options) {
			return options[n-1].value, true
		}
		fmt.Fprintf(p.out, "  Escribe un número entre 1 y %d.\n", len(options))
	}
}

// setup rehace el inicio de sesión: correo y contraseña, cuenta nueva o clave
// de API. Con credenciales el servidor entrega una API key propia.
func (a *App) setup(ctx context.Context) int {
	cfg := config.Load(a.ConfigPath)
	if cfg.IsGeneric() {
		fmt.Fprintf(a.Stdout, "El proveedor «%s» no usa cuentas Lixbon. Cambia con: lixbon profile use lixbon\n", cfg.ActiveProfile())
		return 1
	}
	p := a.newPrompter()
	client := api.FromConfig(cfg)
	fmt.Fprintf(a.Stdout, "lixbon CLI v%s · iniciar sesión\n\n", config.Version)
	fmt.Fprintln(a.Stdout, "No hay una sesión activa. Inicia sesión para continuar.")
	fmt.Fprintln(a.Stdout)

	method, ok := p.choose("Método de acceso", []choice{
		{"Credenciales", "correo y contraseña", "creds"},
		{"Crear cuenta", "registrarse con correo", "register"},
		{"Clave de API", "lixbon_sk_…", "key"},
	})
	if !ok {
		return 1
	}
	switch method {
	case "key":
		ok = a.loginWithKey(ctx, p, client, &cfg)
	default:
		ok = a.loginWithCredentials(ctx, p, client, &cfg, method == "register")
	}
	if !ok {
		return 1
	}
	if cfg.Model == "" && cfg.KeyModel == "" {
		a.pickModel(ctx, p, client, &cfg)
	}
	return 0
}

func (a *App) saveConfig(cfg config.Config) bool {
	if err := config.Save(a.ConfigPath, cfg); err != nil {
		fmt.Fprintf(a.Stderr, "No se pudo guardar la configuración: %v\n", err)
		return false
	}
	return true
}

func (a *App) loginWithCredentials(ctx context.Context, p *prompter, client *api.Client, cfg *config.Config, register bool) bool {
	for {
		email, ok := p.ask("Correo", false)
		if !ok || email == "" {
			return false
		}
		password, ok := p.ask("Contraseña", true)
		if !ok {
			return false
		}
		var first, last string
		if register {
			if first, ok = p.ask("Nombre", false); !ok {
				return false
			}
			if last, ok = p.ask("Apellido", false); !ok {
				return false
			}
			if err := client.Register(ctx, email, password, first, last); err != nil {
				a.printError(err.Error())
				continue
			}
		}
		key, err := client.Login(ctx, email, password)
		if err != nil {
			if ctx.Err() != nil {
				return false
			}
			a.printError(err.Error())
			continue
		}
		if key == "" {
			a.printError("El servidor no entregó una API key. Intenta de nuevo.")
			continue
		}
		cfg.APIKey, cfg.KeyModel = key, ""
		cfg.SetExtraString("account_email", email)
		client.APIKey = key
		if !a.saveConfig(*cfg) {
			return false
		}
		fmt.Fprintf(a.Stdout, "Sesión iniciada como %s\n", email)
		return true
	}
}

func (a *App) loginWithKey(ctx context.Context, p *prompter, client *api.Client, cfg *config.Config) bool {
	previous := client.APIKey
	for {
		raw, ok := p.ask("Pega tu clave (lixbon_sk_…)", true)
		if !ok || raw == "" {
			return false
		}
		client.APIKey = raw
		info, err := client.KeyInfo(ctx)
		if err != nil {
			if _, fallback := client.Models(ctx); fallback != nil {
				a.printError("Clave inválida: " + fallback.Error())
				client.APIKey = previous
				if ctx.Err() != nil {
					return false
				}
				continue
			}
		}
		cfg.APIKey, cfg.KeyModel = raw, info.KeyModel
		cfg.SetExtraString("account_email", "")
		if info.KeyModel != "" {
			cfg.Model = info.KeyModel
			fmt.Fprintf(a.Stdout, "Clave vinculada al modelo %s (modelo fijo)\n", info.KeyModel)
		} else {
			fmt.Fprintln(a.Stdout, "Clave de API verificada")
		}
		return a.saveConfig(*cfg)
	}
}

func (a *App) pickModel(ctx context.Context, p *prompter, client *api.Client, cfg *config.Config) {
	if model := client.RoleChatModel(ctx); model != "" {
		cfg.Model = model
		if a.saveConfig(*cfg) {
			fmt.Fprintf(a.Stdout, "Modelo: %s\n", model)
		}
		return
	}
	models, err := client.Models(ctx)
	if err != nil || len(models) == 0 {
		a.printError("El servidor no está publicando modelos ahora mismo.")
		return
	}
	options := make([]choice, len(models))
	for i, id := range models {
		options[i] = choice{label: id, value: id}
	}
	fmt.Fprintln(a.Stdout)
	model, ok := p.choose("Modelo por defecto", options)
	if !ok {
		return
	}
	cfg.Model = model
	if a.saveConfig(*cfg) {
		fmt.Fprintf(a.Stdout, "Modelo: %s\n", model)
	}
}
