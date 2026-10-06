package cli

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/sse"
)

type sessionState int

const (
	sessionOK sessionState = iota
	sessionAuth
	sessionOffline
)

type account struct {
	state         sessionState
	models        []api.Model
	roleChatModel string
}

// probeAccount distingue sesión válida, clave rechazada y servidor inalcanzable.
func (a *App) probeAccount(ctx context.Context, client *api.Client, cfg *config.Config) account {
	var acc account
	authFailed := false
	models, err := client.ModelsDetail(ctx)
	if err != nil {
		authFailed = api.IsAuth(err)
	}
	acc.models = models
	acc.roleChatModel = client.RoleChatModel(ctx)
	if cfg.APIKey == "" {
		acc.state = sessionAuth
		return acc
	}
	plan, err := client.PlanName(ctx)
	if err != nil {
		switch {
		case api.IsAuth(err), authFailed:
			acc.state = sessionAuth
		case len(acc.models) > 0:
			acc.state = sessionOK
		default:
			acc.state = sessionOffline
		}
		return acc
	}
	if plan != "" && plan != cfg.ExtraString("plan_name") {
		cfg.SetExtraString("plan_name", plan)
		_ = config.Save(a.ConfigPath, *cfg)
	}
	if authFailed {
		acc.state = sessionAuth
	}
	return acc
}

func (a *App) clearSession(cfg *config.Config) {
	cfg.APIKey = ""
	cfg.KeyModel = ""
	cfg.SetExtraString("account_email", "")
	cfg.SetExtraString("plan_name", "")
	_ = config.Save(a.ConfigPath, *cfg)
}

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
	if *once == "" {
		fmt.Fprintln(a.Stderr, "El chat interactivo aún no está disponible en el CLI Go. Usa: lixbon chat --once \"mensaje\"")
		return 1
	}
	return a.runOnce(ctx, *once, *modelFlag, *clientID, *title, *autoRun)
}

func (a *App) runOnce(ctx context.Context, message, modelOverride, clientID, title string, autoRun bool) int {
	cfg := config.Load(a.ConfigPath)
	if cfg.APIKey == "" {
		a.printError("No hay sesión. Configúrala con: lixbon init --api-key <clave>")
		return 1
	}
	client := api.New(cfg.BaseURL, cfg.APIKey)

	acc := a.probeAccount(ctx, client, &cfg)
	if ctx.Err() != nil {
		return a.interrupted()
	}
	switch acc.state {
	case sessionAuth:
		a.clearSession(&cfg)
		a.printError("Tu sesión ya no es válida (se cerró desde otro sitio o la clave fue revocada).")
		return 1
	case sessionOffline:
		a.printError("No se pudo contactar con el servidor; se trabajará con la configuración local.")
	}

	model, ok := a.resolveModel(&cfg, acc, modelOverride)
	if !ok {
		return 1
	}

	switch cfg.Mode {
	case "agent":
		return a.agentOnce(ctx, client, &cfg, model, message, clientID, title, autoRun)
	case "delegate":
		return a.delegateOnce(ctx, client, message)
	}

	conversationID := newUUID()
	request := api.ChatRequest{
		Model:          model,
		Messages:       []map[string]any{{"role": "user", "content": message}},
		ConversationID: &conversationID,
		ClientID:       clientID,
		Title:          &title,
		WebSearch:      webSearchValue(cfg.WebMode()),
		NumCtx:         cfg.ContextWindow,
	}
	stream, err := client.ChatStream(ctx, request)
	if err != nil {
		return a.failure(ctx, err)
	}
	defer stream.Close()
	return a.printStream(ctx, stream)
}

func (a *App) resolveModel(cfg *config.Config, acc account, override string) (string, bool) {
	if model := firstNonEmpty(cfg.KeyModel, override, cfg.Model); model != "" {
		return model, true
	}
	if len(acc.models) == 0 {
		a.printError("El servidor no está publicando modelos ahora mismo.")
		return "", false
	}
	if slices.ContainsFunc(acc.models, func(m api.Model) bool { return m.ID == acc.roleChatModel }) {
		cfg.Model = acc.roleChatModel
		_ = config.Save(a.ConfigPath, *cfg)
		return cfg.Model, true
	}
	a.printError("No hay modelo configurado. Indica uno con --model o lixbon init --model <id>.")
	return "", false
}

func (a *App) printStream(ctx context.Context, stream *api.ChatStream) int {
	var sources []map[string]any
	var body strings.Builder
	var endsWithNewline bool
	for ev, err := range stream.Events() {
		if err != nil {
			a.finishBody(body.Len() > 0, endsWithNewline)
			return a.failure(ctx, err)
		}
		switch ev.Kind {
		case sse.Content:
			body.WriteString(ev.Text)
			fmt.Fprint(a.Stdout, ev.Text)
			endsWithNewline = strings.HasSuffix(ev.Text, "\n")
		case sse.Sources:
			_ = json.Unmarshal(ev.Value, &sources)
		}
	}
	a.finishBody(body.Len() > 0, endsWithNewline)
	if body.Len() == 0 {
		a.printError("(sin respuesta) el modelo no devolvió texto.")
	}
	if line := sourcesLine(sources); line != "" {
		fmt.Fprintln(a.Stdout, line)
	}
	return 0
}

func (a *App) finishBody(hasBody, endsWithNewline bool) {
	if hasBody && !endsWithNewline {
		fmt.Fprintln(a.Stdout)
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
		a.printError("Demasiadas peticiones seguidas; espera unos segundos.")
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

func webSearchValue(mode string) any {
	switch mode {
	case "on":
		return true
	case "off":
		return false
	}
	return "auto"
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
