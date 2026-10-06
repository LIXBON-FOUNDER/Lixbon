// Package cli implementa los subcomandos del CLI Go.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
)

type App struct {
	Stdout     io.Writer
	Stderr     io.Writer
	ConfigPath string
	Hostname   string
	// Interactive abre el chat de terminal; nil si no hay interfaz disponible.
	Interactive func(ctx context.Context, opts chat.Options) int
}

func NewApp() (*App, error) {
	path, err := config.DefaultPath()
	if err != nil {
		return nil, err
	}
	hostname := os.Getenv("HOSTNAME")
	if hostname == "" {
		hostname = "cli-client"
	}
	return &App{Stdout: os.Stdout, Stderr: os.Stderr, ConfigPath: path, Hostname: hostname}, nil
}

const usage = `lixbon — asistente de código en tu terminal

Comandos:
  init     Guardar base_url, api_key y modelo
  status   Ver configuración local
  models   Listar modelos disponibles
  chat     Enviar un mensaje con --once "texto" (alias: run, start)
`

func (a *App) Run(ctx context.Context, args []string) int {
	if len(args) == 0 {
		return a.chat(ctx, nil)
	}
	switch name, rest := args[0], args[1:]; name {
	case "init":
		return a.initConfig(rest)
	case "status":
		return a.status()
	case "models":
		return a.models(ctx)
	case "chat", "run", "start":
		return a.chat(ctx, rest)
	case "setup", "usage", "update", "ui-demo":
		fmt.Fprintf(a.Stderr, "«%s» aún no está disponible en el CLI Go.\n", name)
		return 1
	case "-h", "--help", "help":
		fmt.Fprint(a.Stdout, usage)
		return 0
	default:
		fmt.Fprintf(a.Stderr, "lixbon: comando desconocido %q\n\n%s", name, usage)
		return 2
	}
}

func (a *App) flagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(a.Stderr)
	return fs
}

func parseFlags(fs *flag.FlagSet, args []string) (code int, stop bool) {
	err := fs.Parse(args)
	switch {
	case err == nil:
		return 0, false
	case errors.Is(err, flag.ErrHelp):
		return 0, true
	default:
		return 2, true
	}
}

func (a *App) initConfig(args []string) int {
	fs := a.flagSet("init")
	baseURL := fs.String("base-url", "", "URL base del gateway")
	apiKey := fs.String("api-key", "", "API key")
	model := fs.String("model", "", "modelo por defecto")
	maxContext := fs.Int("max-context-messages", -1, "mensajes de contexto")
	contextWindow := fs.Int("context-window", -1, "ventana de contexto (tokens)")
	mode := fs.String("mode", "", "ask, agent o delegate")
	workspace := fs.String("workspace", "", "carpeta de trabajo")
	if code, stop := parseFlags(fs, args); stop {
		return code
	}
	switch *mode {
	case "", "ask", "agent", "delegate":
	default:
		fmt.Fprintf(a.Stderr, "init: --mode debe ser ask, agent o delegate (recibido %q)\n", *mode)
		return 2
	}

	cfg := config.Load(a.ConfigPath)
	if *baseURL != "" {
		cfg.BaseURL = strings.TrimRight(*baseURL, "/")
	}
	if *apiKey != "" {
		cfg.APIKey = strings.TrimSpace(*apiKey)
	}
	if *model != "" {
		cfg.Model = strings.TrimSpace(*model)
	}
	if *maxContext >= 0 {
		cfg.MaxContextMessages = max(2, *maxContext)
	}
	if *contextWindow >= 0 {
		cfg.ContextWindow = max(1024, *contextWindow)
	}
	if *mode != "" {
		cfg.Mode = *mode
	}
	if *workspace != "" {
		abs, err := filepath.Abs(*workspace)
		if err != nil {
			fmt.Fprintf(a.Stderr, "init: %v\n", err)
			return 1
		}
		cfg.Workspace = abs
	}
	if err := config.Save(a.ConfigPath, cfg); err != nil {
		fmt.Fprintf(a.Stderr, "No se pudo guardar la configuración: %v\n", err)
		return 1
	}
	fmt.Fprintf(a.Stdout, "Configuración guardada en: %s\n", a.ConfigPath)
	return 0
}

func (a *App) status() int {
	cfg := config.Load(a.ConfigPath)
	baseURL := cfg.BaseURL
	if baseURL == "" {
		baseURL = config.DefaultBaseURL
	}
	orDefault := func(value, fallback string) string {
		if value == "" {
			return fallback
		}
		return value
	}
	workspace := cfg.Workspace
	if workspace == "" {
		workspace, _ = os.Getwd()
	}
	fmt.Fprintf(a.Stdout, "lixbon CLI v%s\n", config.Version)
	fmt.Fprintf(a.Stdout, "- Config:              %s\n", a.ConfigPath)
	fmt.Fprintf(a.Stdout, "- Base URL:            %s\n", baseURL)
	fmt.Fprintf(a.Stdout, "- API key:             %s\n", config.MaskKey(cfg.APIKey))
	fmt.Fprintf(a.Stdout, "- Cuenta:              %s\n", orDefault(cfg.ExtraString("account_email"), "-"))
	fmt.Fprintf(a.Stdout, "- Modelo por defecto:  %s\n", orDefault(cfg.Model, "no configurado"))
	fmt.Fprintf(a.Stdout, "- Modo:                %s\n", orDefault(cfg.Mode, "ask"))
	fmt.Fprintf(a.Stdout, "- Ventana de contexto: %d tokens\n", cfg.ContextWindow)
	fmt.Fprintf(a.Stdout, "- Workspace:           %s\n", workspace)
	return 0
}
