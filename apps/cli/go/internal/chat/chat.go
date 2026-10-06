// Package chat es el estado y la lógica de una conversación con el gateway,
// sin interfaz: modelo, modo, historial, sesión del agente y turnos ask,
// agent y delegate. La consumen `chat --once` y la interfaz de terminal.
package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/session"
	"lixbon.com/cli/internal/sse"
	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/tools"
	"lixbon.com/cli/internal/workspace"
)

const (
	ModeAsk      = "ask"
	ModeAgent    = "agent"
	ModeDelegate = "delegate"

	interruptedMark = "\n[respuesta interrumpida por el usuario]"
	maxTitleWait    = 30 * time.Second
)

// Sink recibe lo que ocurre durante un turno. Se llama desde la goroutine del
// turno, así que la implementación debe ser segura para uso concurrente con
// la interfaz.
type Sink interface {
	// Delta es texto que llega del modelo: contenido o razonamiento.
	Delta(kind sse.Kind, text string)
	Event(e agent.Event)
	Note(text string)
	// Title avisa de que el servidor puso título a la conversación.
	Title(title string)
}

type nopSink struct{}

func (nopSink) Delta(sse.Kind, string) {}
func (nopSink) Event(agent.Event)      {}
func (nopSink) Note(string)            {}
func (nopSink) Title(string)           {}

type Options struct {
	ConfigPath string
	// Model sobrescribe el modelo por defecto (--model).
	Model    string
	ClientID string
	Title    string
	// Workspace vacío usa la carpeta actual.
	Workspace string
	AutoRun   bool
	// Autotitle pide al servidor el título tras el primer intercambio.
	Autotitle bool
}

type anchor struct{ tokens, chars int }

type Chat struct {
	Cfg        config.Config
	ConfigPath string
	Client     *api.Client
	Store      *session.Store
	Session    *agent.Session
	Toolbox    *tools.Toolbox

	Model          string
	Mode           string
	ClientID       string
	Workspace      string
	WebMode        string
	ConversationID string
	History        []history.Message
	SessionTokens  int
	TurnTokens     int
	Sources        []map[string]any
	ProjectContext string
	Custom         map[string]workspace.Command

	reserved  []string
	mu        sync.Mutex
	persistMu sync.Mutex
	title     string
	autotitle bool
	titling   bool
	anchor    *anchor
}

// New prepara la conversación a partir de la configuración. No hace red.
func New(cfg config.Config, client *api.Client, opts Options) (*Chat, error) {
	root := opts.Workspace
	if root == "" {
		var err error
		if root, err = os.Getwd(); err != nil {
			return nil, err
		}
	}
	if real, err := filepath.EvalSymlinks(root); err == nil {
		root = real
	}
	toolbox := tools.NewToolbox(root)
	toolbox.Web = client

	c := &Chat{
		Cfg:            cfg,
		ConfigPath:     opts.ConfigPath,
		Client:         client,
		Store:          session.NewStore(filepath.Dir(opts.ConfigPath)),
		Toolbox:        toolbox,
		Model:          firstNonEmpty(cfg.KeyModel, opts.Model, cfg.Model),
		Mode:           firstNonEmpty(cfg.Mode, ModeAsk),
		ClientID:       firstNonEmpty(opts.ClientID, "cli-client"),
		Workspace:      root,
		WebMode:        cfg.WebMode(),
		ConversationID: newUUID(),
		ProjectContext: workspace.ProjectContext(root),
		title:          opts.Title,
		autotitle:      opts.Autotitle,
	}
	s := agent.NewSession(root, toolbox)
	s.AutoApprove = cfg.AutoApproveTools
	s.AutoRunCommands = opts.AutoRun || cfg.ExtraBool("auto_run_commands", false)
	s.NativeTools = cfg.ExtraBool("native_tools", true)
	s.AutoCheck = cfg.ExtraBool("auto_check", true)
	s.AllowedCommands = cfg.ExtraStringList("allowed_commands")
	s.ContextWindow = cfg.ContextWindow
	s.ProjectContext = c.ProjectContext
	s.OnAllowedCommands = c.saveAllowedCommands
	s.Ask = c.AskQuiet
	s.Model = c.Model
	c.Session = s
	return c, nil
}

// Close termina los procesos en segundo plano y guarda la conversación.
func (c *Chat) Close() {
	c.Persist()
	c.Toolbox.Close()
}

func (c *Chat) Title() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.title
}

func (c *Chat) SetTitle(title string) {
	c.mu.Lock()
	c.title = title
	c.mu.Unlock()
}

// SetWorkspace cambia la carpeta de trabajo para esta sesión (no se guarda):
// recarga LIXBON.md y los comandos propios del proyecto.
func (c *Chat) SetWorkspace(path string) {
	c.Workspace = path
	c.Toolbox.Root = path
	c.Session.Workspace = path
	c.ProjectContext = workspace.ProjectContext(path)
	c.Session.ProjectContext = c.ProjectContext
	if c.Custom != nil {
		reserved := make([]string, 0, len(c.reserved))
		reserved = append(reserved, c.reserved...)
		c.LoadCustomCommands(reserved)
	}
}

// LoadCustomCommands lee los comandos propios del usuario y del proyecto.
// reserved son los nombres de los comandos del CLI, que nunca se pisan.
func (c *Chat) LoadCustomCommands(reserved []string) {
	c.reserved = reserved
	c.Custom = workspace.LoadCommands(c.Workspace, filepath.Dir(c.ConfigPath), reserved)
}

func (c *Chat) saveAllowedCommands(list []string) {
	c.Cfg.SetExtraStringList("allowed_commands", list)
	_ = config.Save(c.ConfigPath, c.Cfg)
}

// SaveConfig persiste la configuración (modelo, modo, búsqueda web…).
func (c *Chat) SaveConfig() error { return config.Save(c.ConfigPath, c.Cfg) }

// ── cuenta ──────────────────────────────────────────────────────────────

type AccountState int

const (
	AccountOK AccountState = iota
	AccountAuth
	AccountOffline
)

type Account struct {
	State         AccountState
	Models        []api.Model
	RoleChatModel string
	ModelsErr     error
}

// Probe distingue sesión válida, clave rechazada y servidor inalcanzable, y
// deja el plan cacheado en la configuración.
func (c *Chat) Probe(ctx context.Context) Account {
	var acc Account
	authFailed := false
	models, err := c.Client.ModelsDetail(ctx)
	if err != nil {
		authFailed = api.IsAuth(err)
	}
	acc.Models, acc.ModelsErr = models, err
	acc.RoleChatModel = c.Client.RoleChatModel(ctx)
	if c.Cfg.APIKey == "" {
		acc.State = AccountAuth
		return acc
	}
	plan, err := c.Client.PlanName(ctx)
	if err != nil {
		switch {
		case api.IsAuth(err), authFailed:
			acc.State = AccountAuth
		case len(acc.Models) > 0:
			acc.State = AccountOK
		default:
			acc.State = AccountOffline
		}
		return acc
	}
	if plan != "" && plan != c.Cfg.ExtraString("plan_name") {
		c.Cfg.SetExtraString("plan_name", plan)
		_ = c.SaveConfig()
	}
	if authFailed {
		acc.State = AccountAuth
	}
	return acc
}

// ClearSession olvida la sesión local (logout o clave rechazada).
func (c *Chat) ClearSession() {
	c.Cfg.APIKey = ""
	c.Cfg.KeyModel = ""
	c.Cfg.SetExtraString("account_email", "")
	c.Cfg.SetExtraString("plan_name", "")
	_ = c.SaveConfig()
	c.Client.APIKey = ""
}

// SetModel cambia de modelo y lo recuerda como predeterminado.
func (c *Chat) SetModel(model string) {
	c.Model = model
	c.Session.Model = model
	c.Cfg.Model = model
	_ = c.SaveConfig()
}

// ResolveModel decide el modelo sin preguntar: el de la clave, el pedido o el
// configurado y, si no hay, el que el servidor usa para chat. needsPick indica
// que hay que elegir uno de acc.Models.
func (c *Chat) ResolveModel(acc Account) (needsPick bool, err error) {
	if c.Model != "" {
		return false, nil
	}
	if len(acc.Models) == 0 {
		return false, acc.NoModelsError()
	}
	for _, m := range acc.Models {
		if m.ID == acc.RoleChatModel {
			c.SetModel(m.ID)
			return false, nil
		}
	}
	return true, nil
}

func (a Account) NoModelsError() error {
	if a.ModelsErr != nil {
		return fmt.Errorf("No se pudieron obtener los modelos: %v", a.ModelsErr)
	}
	return fmt.Errorf("El servidor no tiene modelos disponibles ahora (¿nodos apagados?). Prueba más tarde.")
}

// ── persistencia ────────────────────────────────────────────────────────

// Persist guarda la conversación en el historial local; nunca falla el turno.
func (c *Chat) Persist() {
	// Serializado: el guardado del turno y el del autotítulo pueden solaparse
	// y el más antiguo no debe pisar al nuevo.
	c.persistMu.Lock()
	defer c.persistMu.Unlock()
	_ = c.Store.Save(c.ConversationID, c.History, session.SaveOptions{
		Title: c.Title(), Model: c.Model, Mode: c.Mode, Workspace: c.Workspace, Tokens: c.SessionTokens,
	})
}

// NewConversation guarda la actual y empieza otra de verdad: nuevo id y
// contexto vacío.
func (c *Chat) NewConversation() {
	c.Persist()
	c.History = nil
	c.anchor = nil
	c.SessionTokens = 0
	c.ConversationID = newUUID()
	c.SetTitle("")
	c.Session.Working = nil
}

// Open reabre una conversación guardada; false si ya no está.
func (c *Chat) Open(id string) bool {
	record, ok := c.Store.Load(id)
	if !ok {
		return false
	}
	c.Persist()
	c.History = record.Messages
	c.anchor = nil
	c.ConversationID = firstNonEmpty(record.ID, id)
	c.SetTitle(record.Title)
	c.SessionTokens = record.Tokens
	return true
}

func (c *Chat) maybeAutotitle(sink Sink) {
	c.mu.Lock()
	if !c.autotitle || c.title != "" || len(c.History) < 2 || c.titling {
		c.mu.Unlock()
		return
	}
	c.titling = true
	id := c.ConversationID
	c.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), maxTitleWait)
		defer cancel()
		title, _ := c.Client.GenerateTitle(ctx, id)
		c.mu.Lock()
		c.titling = false
		apply := title != "" && c.title == "" && c.ConversationID == id
		if apply {
			c.title = title
		}
		c.mu.Unlock()
		if apply {
			c.Persist()
			sink.Title(title)
		}
	}()
}

// ── envío ───────────────────────────────────────────────────────────────

// Send ejecuta un turno completo con el mensaje del usuario y devuelve la
// respuesta final. Si ctx se cancela a mitad de un paso del modelo, la
// respuesta parcial se conserva marcada como interrumpida.
func (c *Chat) Send(ctx context.Context, text string, sink Sink) (string, error) {
	if sink == nil {
		sink = nopSink{}
	}
	c.TurnTokens = 0
	c.Sources = nil
	c.History = append(c.History, history.User(text))
	prior := len(c.History) - 1

	var answer string
	var err error
	switch c.Mode {
	case ModeDelegate:
		answer, err = c.delegateTurn(ctx, text, sink)
	case ModeAgent:
		answer, err = c.agentTurn(ctx, sink)
	default:
		answer, err = c.askTurn(ctx, sink)
	}
	if err != nil && ctx.Err() == nil {
		// Un error del gateway no deja el mensaje a medias en el historial.
		c.History = c.History[:prior]
		return "", err
	}
	c.maybeAutotitle(sink)
	c.Persist()
	return answer, err
}

func (c *Chat) delegateTurn(ctx context.Context, text string, sink Sink) (string, error) {
	result, err := c.Client.Delegate(ctx, text)
	if err != nil {
		return "", err
	}
	sink.Note(fmt.Sprintf("delegó a %s [%s] · %d ms", firstNonEmpty(result.Model, "?"), firstNonEmpty(result.Type, "PLAN"), result.ExecutionTimeMS))
	var parts []string
	for _, pair := range [][2]string{{"intent", "intent"}, {"complejidad", "complexity"}, {"dominio", "domain"}, {"riesgo", "riskLevel"}} {
		value := "?"
		if v, ok := result.Classification[pair[1]]; ok {
			value = fmt.Sprint(v)
		}
		parts = append(parts, pair[0]+":"+value)
	}
	sink.Note(strings.Join(parts, "  "))
	response := result.Response
	if response == "" {
		response = "(sin respuesta)"
	}
	sink.Delta(sse.Content, response)
	c.History = append(c.History, history.Assistant(result.Response))
	return response, nil
}

func (c *Chat) agentTurn(ctx context.Context, sink Sink) (string, error) {
	c.Session.BeginTurn()
	turn := &agent.Turn{S: c.Session, Stream: c.streamer(sink, true), Emit: sink.Event}
	answer, working, err := turn.Run(ctx, c.History)
	c.Session.Working = nil
	c.Session.EndTurn()
	if err != nil {
		if ctx.Err() != nil {
			c.History = working
		}
		return "", err
	}
	c.History = working
	if n := len(c.History); n == 0 || c.History[n-1].Role != "assistant" || c.History[n-1].Content != answer {
		c.History = append(c.History, history.Assistant(answer))
	}
	return answer, nil
}

func (c *Chat) askTurn(ctx context.Context, sink Sink) (string, error) {
	c.autoCompact(ctx, sink)
	res, err := c.streamer(sink, false)(ctx, c.contextMessages(), nil)
	if err != nil {
		return "", err
	}
	c.History = append(c.History, history.Assistant(res.Text))
	return res.Text, nil
}

// contextMessages son los últimos max_context_messages del historial, sin el
// round-trip de herramientas (recortado quedaría descolgado y rompería el
// template del modelo), más el LIXBON.md del proyecto.
func (c *Chat) contextMessages() []history.Message {
	messages := agent.SanitizeForPlainChat(c.History)
	if limit := c.Cfg.MaxContextMessages; limit > 0 && len(messages) > limit {
		messages = messages[len(messages)-limit:]
	}
	if c.ProjectContext != "" {
		system := history.Message{Role: "system", Content: "Contexto del proyecto (LIXBON.md):\n" + c.ProjectContext}
		return append([]history.Message{system}, messages...)
	}
	return messages
}

// autoCompact, en modo ask, resume la conversación cuando se acerca a la
// ventana (en agent lo hace el propio bucle, paso a paso).
func (c *Chat) autoCompact(ctx context.Context, sink Sink) {
	window := c.Cfg.ContextWindow
	if window == 0 {
		window = 8192
	}
	if !c.Session.Estimator.NeedsCompaction(c.History, window) {
		return
	}
	sink.Note("La conversación llena la ventana de contexto: compactando…")
	if err := c.Compact(ctx, history.CompactKeepRecent); err != nil {
		sink.Note(fmt.Sprintf("No se pudo compactar (%v).", err))
	}
}

// Compact sustituye lo antiguo del historial por un resumen del modelo y
// conserva los últimos keepRecent mensajes.
func (c *Chat) Compact(ctx context.Context, keepRecent int) error {
	compacted, err := history.CompactMessages(c.History, func(m []history.Message) (string, error) {
		return c.AskQuiet(ctx, m)
	}, keepRecent)
	if err != nil {
		return err
	}
	c.History = compacted
	c.anchor = nil
	return nil
}

// AskQuiet es un chat sin streaming ni historial, para trabajo interno.
func (c *Chat) AskQuiet(ctx context.Context, messages []history.Message) (string, error) {
	return c.Client.Chat(ctx, c.Model, toMaps(messages), c.ClientID)
}

// streamer adapta el cliente del gateway al bucle del agente: recoge el
// texto, el razonamiento y las llamadas nativas de un paso y avisa al sink de
// lo que va llegando.
func (c *Chat) streamer(sink Sink, agentMode bool) agent.Streamer {
	return func(ctx context.Context, messages []history.Message, toolList []map[string]any) (agent.StreamResult, error) {
		title := c.Title()
		id := c.ConversationID
		req := api.ChatRequest{
			Model:          c.Model,
			Messages:       toMaps(messages),
			ConversationID: &id,
			ClientID:       c.ClientID,
			Title:          &title,
			WebSearch:      webSearchValue(c.WebMode),
			NumCtx:         c.Cfg.ContextWindow,
			Tools:          toolList,
		}
		if agentMode || c.Session.PlanMode {
			req.Think = "high"
		}
		sink.Event(agent.Event{Kind: agent.EventStep})
		sentChars := history.PayloadChars(messages, toolList)
		sentImages := history.ImageCount(messages)

		stream, err := c.Client.ChatStream(ctx, req)
		if err != nil {
			return agent.StreamResult{}, err
		}
		defer stream.Close()

		var text, reasoning strings.Builder
		var calls []json.RawMessage
		var usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		}
		for ev, err := range stream.Events() {
			if err != nil {
				if ctx.Err() != nil && (text.Len() > 0 || reasoning.Len() > 0) {
					return agent.StreamResult{Text: text.String() + interruptedMark, Reasoning: textutil.Strip(reasoning.String())}, nil
				}
				return agent.StreamResult{}, err
			}
			switch ev.Kind {
			case sse.Content:
				text.WriteString(ev.Text)
				sink.Delta(sse.Content, ev.Text)
			case sse.Reasoning:
				reasoning.WriteString(ev.Text)
				sink.Delta(sse.Reasoning, ev.Text)
			case sse.ToolCalls:
				var batch []json.RawMessage
				if json.Unmarshal(ev.Value, &batch) == nil {
					calls = append(calls, batch...)
				}
			case sse.Sources:
				var found []map[string]any
				if json.Unmarshal(ev.Value, &found) == nil {
					c.Sources = found
				}
			case sse.Usage:
				_ = json.Unmarshal(ev.Value, &usage)
			}
		}
		c.registerUsage(usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens, sentChars, sentImages, text.Len()+len(fmt.Sprint(calls)))
		return agent.StreamResult{Text: text.String(), ToolCalls: calls, Reasoning: textutil.Strip(reasoning.String())}, nil
	}
}

func (c *Chat) registerUsage(prompt, completion, total, sentChars, sentImages, replyChars int) {
	if total > 0 {
		c.SessionTokens += total
		c.TurnTokens += total
	}
	if prompt > 0 && sentChars > 0 {
		c.Session.Estimator.Calibrate(sentChars, prompt-history.TokensPerImage*sentImages)
		c.anchor = &anchor{tokens: prompt + completion, chars: sentChars + replyChars}
	}
}

// ContextUsage estima cuánto del contexto ocupa lo que se enviaría ahora:
// parte del conteo real del último prompt y solo estima lo añadido después.
func (c *Chat) ContextUsage() (tokens int, percent float64) {
	est := c.Session.Estimator
	var sent []history.Message
	var toolList []map[string]any
	if c.Mode == ModeAgent {
		sent = append(sent, history.Message{Role: "system", Content: agent.NativeSystemPrompt(c.Workspace)})
		if c.Session.Working != nil {
			sent = append(sent, c.Session.Working...)
		} else {
			sent = append(sent, c.History...)
		}
		if c.Session.NativeTools {
			toolList = toolSchemas()
		}
	} else {
		sent = c.contextMessages()
	}
	chars := history.PayloadChars(sent, toolList)
	if a := c.anchor; a != nil && float64(chars) >= float64(a.chars)*0.8 {
		tokens = a.tokens + int(float64(max(0, chars-a.chars))/est.CharsPerToken())
	} else {
		tokens = int(float64(chars) / est.CharsPerToken())
	}
	tokens += history.TokensPerImage * history.ImageCount(sent)
	window := max(c.Cfg.ContextWindow, 1)
	return tokens, min(100.0, float64(tokens)*100.0/float64(window))
}
