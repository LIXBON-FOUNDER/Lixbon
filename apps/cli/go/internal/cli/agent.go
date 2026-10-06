package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/history"
	sessions "lixbon.com/cli/internal/session"
	"lixbon.com/cli/internal/sse"
	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/tools"
	ws "lixbon.com/cli/internal/workspace"
)

// agentOnce ejecuta un turno completo del agente sobre la carpeta actual y
// escribe la respuesta final en stdout; el registro de acciones va a stderr.
func (a *App) agentOnce(ctx context.Context, client *api.Client, cfg *config.Config, model, message, clientID, title string, autoRun bool) int {
	workspace, err := os.Getwd()
	if err != nil {
		a.printError(err.Error())
		return 1
	}
	if real, err := filepath.EvalSymlinks(workspace); err == nil {
		workspace = real
	}

	toolbox := tools.NewToolbox(workspace)
	toolbox.Web = client
	defer toolbox.Close()

	session := agent.NewSession(workspace, toolbox)
	session.Model = model
	session.AutoApprove = cfg.AutoApproveTools
	session.AutoRunCommands = autoRun || cfg.ExtraBool("auto_run_commands", false)
	session.NativeTools = cfg.ExtraBool("native_tools", true)
	session.AutoCheck = cfg.ExtraBool("auto_check", true)
	session.AllowedCommands = cfg.ExtraStringList("allowed_commands")
	session.ContextWindow = cfg.ContextWindow
	session.Approver = &headlessApprover{app: a}
	session.OnAllowedCommands = func(list []string) {
		cfg.SetExtraStringList("allowed_commands", list)
		_ = config.Save(a.ConfigPath, *cfg)
	}
	session.Ask = func(ctx context.Context, messages []history.Message) (string, error) {
		return client.Chat(ctx, model, toMaps(messages), clientID)
	}

	session.ProjectContext = ws.ProjectContext(workspace)

	conversationID := newUUID()
	var sources []map[string]any
	var tokens int
	turn := &agent.Turn{
		S:      session,
		Stream: a.streamer(client, cfg, model, clientID, title, conversationID, &sources, &tokens),
		Emit:   a.renderEvent,
	}
	session.BeginTurn()
	answer, working, err := turn.Run(ctx, []history.Message{history.User(message)})
	session.EndTurn()
	if err != nil {
		return a.failure(ctx, err)
	}
	if n := len(working); n == 0 || working[n-1].Role != "assistant" || working[n-1].Content != answer {
		working = append(working, history.Assistant(answer))
	}
	a.saveSession(conversationID, working, sessions.SaveOptions{
		Title: title, Model: model, Mode: "agent", Workspace: workspace, Tokens: tokens})
	if answer = textutil.Strip(answer); answer == "" {
		a.printError("(sin respuesta) el modelo no devolvió texto.")
	} else {
		fmt.Fprintln(a.Stdout, answer)
	}
	if line := sourcesLine(sources); line != "" {
		fmt.Fprintln(a.Stdout, line)
	}
	a.printTurnSummary(session.Stats)
	return 0
}

func toMaps(messages []history.Message) []map[string]any {
	out := make([]map[string]any, len(messages))
	for i, m := range messages {
		raw, _ := json.Marshal(m)
		_ = json.Unmarshal(raw, &out[i])
	}
	return out
}

// streamer adapta el cliente del gateway a la interfaz que consume el bucle:
// recoge el texto, el razonamiento y las llamadas nativas de un paso.
func (a *App) streamer(client *api.Client, cfg *config.Config, model, clientID, title, conversationID string, sources *[]map[string]any, tokens *int) agent.Streamer {
	return func(ctx context.Context, messages []history.Message, toolList []map[string]any) (agent.StreamResult, error) {
		req := api.ChatRequest{
			Model:          model,
			Messages:       toMaps(messages),
			ConversationID: &conversationID,
			ClientID:       clientID,
			Title:          &title,
			WebSearch:      webSearchValue(cfg.WebMode()),
			NumCtx:         cfg.ContextWindow,
			Tools:          toolList,
			Think:          "high",
		}
		stream, err := client.ChatStream(ctx, req)
		if err != nil {
			return agent.StreamResult{}, err
		}
		defer stream.Close()

		var text, reasoning strings.Builder
		var calls []json.RawMessage
		for ev, err := range stream.Events() {
			if err != nil {
				return agent.StreamResult{}, err
			}
			switch ev.Kind {
			case sse.Content:
				text.WriteString(ev.Text)
			case sse.Reasoning:
				reasoning.WriteString(ev.Text)
			case sse.ToolCalls:
				var batch []json.RawMessage
				if json.Unmarshal(ev.Value, &batch) == nil {
					calls = append(calls, batch...)
				}
			case sse.Sources:
				var found []map[string]any
				if json.Unmarshal(ev.Value, &found) == nil {
					*sources = found
				}
			case sse.Usage:
				var usage struct {
					TotalTokens int `json:"total_tokens"`
				}
				if json.Unmarshal(ev.Value, &usage) == nil {
					*tokens += usage.TotalTokens
				}
			}
		}
		return agent.StreamResult{Text: text.String(), ToolCalls: calls, Reasoning: textutil.Strip(reasoning.String())}, nil
	}
}

// headlessApprover es el aprobador de --once: no hay nadie al teclado, así que
// lo que no está permitido por configuración se rechaza y se explica cómo
// permitirlo.
type headlessApprover struct{ app *App }

func (h *headlessApprover) Approve(ctx context.Context, req agent.Approval) (agent.Decision, error) {
	switch req.Kind {
	case agent.ApproveCommand:
		fmt.Fprintf(h.app.Stderr, "  ✗ comando sin aprobar: %s\n    permítelo con --auto-run, con «lixbon init» (allowed_commands) o desde el chat interactivo\n", req.Summary)
	case agent.ApproveMCP:
		fmt.Fprintf(h.app.Stderr, "  ✗ herramienta externa sin aprobar: %s\n    activa auto_approve_tools en la configuración\n", req.Detail)
	default:
		fmt.Fprintf(h.app.Stderr, "  ✗ cambio sin aprobar: %s\n    activa auto_approve_tools en la configuración\n", req.Detail)
	}
	return agent.Deny, nil
}

// renderEvent escribe el registro de acciones del agente en texto plano.
func (a *App) renderEvent(e agent.Event) {
	w := a.Stderr
	switch e.Kind {
	case agent.EventNote:
		fmt.Fprintf(w, "  · %s\n", e.Text)
	case agent.EventRescued:
		fmt.Fprintf(w, "  · %s\n", e.Text)
	case agent.EventAction:
		line := fmt.Sprintf("  ▸ %s %s", e.Tool, e.Text)
		if e.Adds != 0 || e.Dels != 0 {
			line += fmt.Sprintf("  +%d -%d", e.Adds, e.Dels)
		}
		if e.Meta != "" {
			line += "  (" + e.Meta + ")"
		}
		fmt.Fprintln(w, line)
	case agent.EventReadGroup:
		fmt.Fprintf(w, "  ▸ leyó %s (%s): %s\n", e.Text, e.Meta, strings.Join(e.Names, ", "))
	case agent.EventActionResult:
		mark := "✓"
		if e.Failed {
			mark = "✗"
		}
		line := fmt.Sprintf("    %s %s", mark, e.Summary)
		if e.Check != "" {
			line += "  · " + e.Check
		}
		fmt.Fprintln(w, line)
	}
}

func (a *App) printTurnSummary(stats agent.TurnStats) {
	if stats.Actions == 0 {
		return
	}
	files := ""
	if n := len(stats.Files); n > 0 {
		files = fmt.Sprintf(", %d archivo(s) tocado(s) +%d -%d", n, stats.Adds, stats.Dels)
	}
	fmt.Fprintf(a.Stderr, "  · %d acción(es)%s\n", stats.Actions, files)
}

// delegateOnce envía el mensaje al enrutador del gateway (modo delegate).
func (a *App) delegateOnce(ctx context.Context, client *api.Client, message, model, title string) int {
	result, err := client.Delegate(ctx, message)
	if err != nil {
		return a.failure(ctx, err)
	}
	fmt.Fprintf(a.Stderr, "  · delegó a %s [%s] · %d ms\n", firstNonEmpty(result.Model, "?"), firstNonEmpty(result.Type, "PLAN"), result.ExecutionTimeMS)
	var parts []string
	for _, pair := range [][2]string{{"intent", "intent"}, {"complejidad", "complexity"}, {"dominio", "domain"}, {"riesgo", "riskLevel"}} {
		value := "?"
		if v, ok := result.Classification[pair[1]]; ok {
			value = fmt.Sprint(v)
		}
		parts = append(parts, pair[0]+":"+value)
	}
	fmt.Fprintf(a.Stderr, "  · %s\n", strings.Join(parts, "  "))
	response := result.Response
	if response == "" {
		response = "(sin respuesta)"
	}
	fmt.Fprintln(a.Stdout, response)
	workspace, _ := os.Getwd()
	a.saveSession(newUUID(), []history.Message{history.User(message), history.Assistant(result.Response)},
		sessions.SaveOptions{Title: title, Model: model, Mode: "delegate", Workspace: workspace})
	return 0
}

// saveSession guarda la conversación en el historial local; nunca falla el turno.
func (a *App) saveSession(id string, messages []history.Message, opts sessions.SaveOptions) {
	_ = sessions.NewStore(filepath.Dir(a.ConfigPath)).Save(id, messages, opts)
}
