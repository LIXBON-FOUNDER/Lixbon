package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/sse"
	"lixbon.com/cli/internal/textutil"
)

// mcpStartWait acota cuánto espera `--once` a que arranquen los servidores MCP.
const mcpStartWait = 75 * time.Second

func (a *App) chat(ctx context.Context, args []string) int {
	fs := a.flagSet("chat")
	modelFlag := fs.String("model", "", "sobrescribe el modelo por defecto")
	clientID := fs.String("client-id", a.Hostname, "identificador del cliente")
	title := fs.String("title", "", "título fijo de la conversación")
	once := fs.String("once", "", "enviar un único mensaje y salir")
	autoRun := fs.Bool("auto-run", false, "permitir que el agente ejecute comandos sin preguntar (solo --once)")
	if code, stop := parseFlags(fs, args); stop {
		return code
	}
	opts := chat.Options{ConfigPath: a.ConfigPath, Model: *modelFlag, ClientID: *clientID, Title: *title, AutoRun: *autoRun}
	if *once != "" {
		return a.runOnce(ctx, *once, opts)
	}
	if a.Interactive == nil {
		fmt.Fprintln(a.Stderr, "El chat interactivo necesita una terminal. Usa: lixbon chat --once \"mensaje\"")
		return 1
	}
	return a.Interactive(ctx, opts)
}

// runOnce envía un único mensaje y escribe la respuesta en stdout; el
// registro de acciones y los avisos van a stderr.
func (a *App) runOnce(ctx context.Context, message string, opts chat.Options) int {
	cfg := config.Load(a.ConfigPath)
	if cfg.APIKey == "" && !cfg.IsGeneric() {
		a.printError("No hay sesión. Configúrala con: lixbon init --api-key <clave>")
		return 1
	}
	client := api.FromConfig(cfg)
	c, err := chat.New(cfg, client, opts)
	if err != nil {
		a.printError(err.Error())
		return 1
	}
	defer c.Toolbox.Close()
	defer c.StopMCP()

	acc := c.Probe(ctx)
	if ctx.Err() != nil {
		return a.interrupted()
	}
	switch acc.State {
	case chat.AccountAuth:
		if acc.Generic {
			a.printError("El proveedor rechazó la clave. Cámbiala con: lixbon profile add (o lixbon init --api-key <clave>).")
			return 1
		}
		c.ClearSession()
		a.printError("Tu sesión ya no es válida (se cerró desde otro sitio o la clave fue revocada).")
		return 1
	case chat.AccountOffline:
		a.printError("No se pudo contactar con el servidor; se trabajará con la configuración local.")
	}
	needsPick, err := c.ResolveModel(acc)
	switch {
	case err != nil:
		a.printError(err.Error())
		return 1
	case needsPick:
		a.printError("No hay modelo configurado. Indica uno con --model o lixbon init --model <id>.")
		return 1
	}

	if c.Mode != chat.ModeAsk {
		c.StartMCP()
		waitCtx, cancel := context.WithTimeout(ctx, mcpStartWait)
		c.WaitMCP(waitCtx)
		cancel()
	}
	c.Session.Approver = &headlessApprover{app: a}
	sink := &onceSink{app: a, live: c.Mode != chat.ModeAgent}
	answer, err := c.Send(ctx, message, sink)
	sink.finish()
	if err != nil {
		return a.failure(ctx, err)
	}
	switch {
	case ctx.Err() != nil:
		return a.interrupted()
	case c.Mode == chat.ModeAgent:
		if answer = textutil.Strip(answer); answer == "" {
			a.printError("(sin respuesta) el modelo no devolvió texto.")
		} else {
			fmt.Fprintln(a.Stdout, answer)
		}
	case !sink.wrote:
		a.printError("(sin respuesta) el modelo no devolvió texto.")
	}
	if line := sourcesLine(c.Sources); line != "" {
		fmt.Fprintln(a.Stdout, line)
	}
	if c.Mode == chat.ModeAgent {
		a.printTurnSummary(c.Session.Stats)
	}
	return 0
}

// onceSink escribe en texto plano: el contenido en stdout (en directo salvo en
// modo agent, donde solo interesa la respuesta final) y el resto en stderr.
type onceSink struct {
	app             *App
	live            bool
	wrote           bool
	endsWithNewline bool
}

func (s *onceSink) Delta(kind sse.Kind, text string) {
	if kind != sse.Content || !s.live {
		return
	}
	s.wrote = true
	fmt.Fprint(s.app.Stdout, text)
	s.endsWithNewline = strings.HasSuffix(text, "\n")
}

func (s *onceSink) Event(e agent.Event) { s.app.renderEvent(e) }
func (s *onceSink) Note(text string)    { fmt.Fprintf(s.app.Stderr, "  · %s\n", text) }
func (s *onceSink) Title(string)        {}

func (s *onceSink) finish() {
	if s.wrote && !s.endsWithNewline {
		fmt.Fprintln(s.app.Stdout)
	}
}

func sourcesLine(sources []map[string]any) string {
	if len(sources) == 0 {
		return ""
	}
	var labels []string
	for _, source := range sources[:min(5, len(sources))] {
		label := "?"
		for _, key := range []string{"url", "title"} {
			if text, _ := source[key].(string); text != "" {
				label = text
				break
			}
		}
		labels = append(labels, label)
	}
	return "fuentes  " + strings.Join(labels, "  ·  ")
}

// failure traduce un error del gateway a la acción que lo resuelve.
func (a *App) failure(ctx context.Context, err error) int {
	if ctx.Err() != nil {
		return a.interrupted()
	}
	var apiErr *api.Error
	if !errors.As(err, &apiErr) {
		a.printError(err.Error())
		return 1
	}
	switch apiErr.Status {
	case 401, 403:
		a.printError("Tu sesión ya no es válida. Ejecuta: lixbon init --api-key <clave>")
	case 402:
		a.printError("Sin créditos disponibles: " + apiErr.Message)
	case 429:
		a.printError(apiErr.RateLimitText())
	default:
		a.printError(apiErr.Message)
	}
	return 1
}

// interrupted conserva el código de salida del CLI Python: Ctrl+C durante un
// --once termina con 0.
func (a *App) interrupted() int {
	fmt.Fprintln(a.Stderr, "— interrumpido —")
	return 0
}

func (a *App) printError(message string) {
	fmt.Fprintf(a.Stderr, "Error: %s\n", message)
}
