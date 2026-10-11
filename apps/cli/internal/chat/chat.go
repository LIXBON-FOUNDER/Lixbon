// Package chat es el estado y la lógica de una conversación con el gateway,
// sin interfaz: modelo, modo, historial, sesión del agente y turnos ask,
// agent y delegate. La consumen `chat --once` y la interfaz de terminal.
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/mcp"
	"lixbon.com/cli/internal/session"
	"lixbon.com/cli/internal/sse"
	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/toolparse"
	"lixbon.com/cli/internal/tools"
	"lixbon.com/cli/internal/toolspec"
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

type Chat struct {
	Cfg        config.Config
	ConfigPath string
	Client     *api.Client
	Store      *session.Store
	Session    *agent.Session
	Toolbox    *tools.Toolbox
	// MCP es nil mientras no haya servidores MCP configurados.
	MCP *mcp.Registry

	Model     string
	Mode      string
	ClientID  string
	Workspace string
	WebMode   string
	// Effort es el razonamiento pedido con /effort: "" (lo decide el CLI),
	// off, on, low, medium o high.
	Effort         string
	ConversationID string
	History        []history.Message
	SessionTokens  int
	TurnTokens     int
	Sources        []map[string]any
	ProjectContext string
	Custom         map[string]workspace.Command

	reserved      []string
	pendingImages []string
	mu            sync.Mutex
	persistMu     sync.Mutex
	title         string
	autotitle     bool
	titling       bool
	anchor        *anchor
	overhead      map[string]overhead
}

// anchor son los tokens reales de la conversación en la última petición:
// prompt_tokens del servidor menos lo que ocupan sistema y herramientas.
type anchor struct {
	agent         bool
	tokens, chars int
}

// overhead es lo que ocupan el prompt de sistema (también el que añade el
// gateway, que el CLI no ve) y las herramientas. Se mide restando la
// conversación estimada al prompt real, y se queda la medición hecha con la
// conversación más corta, que es la de menos error.
type overhead struct{ tokens, convChars int }

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
		Effort:         cfg.ExtraString("effort"),
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
	c.StopMCP()
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
	// Generic: el proveedor no es un gateway Lixbon.
	Generic bool
	// PlanName es el plan de la cuenta según el gateway ("" si no se supo).
	PlanName string
}

// Probe distingue sesión válida, clave rechazada y servidor inalcanzable, y
// deja el plan cacheado en la configuración.
func (c *Chat) Probe(ctx context.Context) Account {
	acc := c.QueryAccount(ctx)
	c.ApplyAccount(acc)
	return acc
}

// QueryAccount es Probe sin tocar el estado: se puede llamar fuera de la
// goroutine de la interfaz y aplicar el resultado después con ApplyAccount.
func (c *Chat) QueryAccount(ctx context.Context) Account {
	var acc Account
	authFailed := false
	models, err := c.Client.ModelsDetail(ctx)
	if err != nil {
		authFailed = api.IsAuth(err)
	}
	acc.Models, acc.ModelsErr = models, err
	acc.Generic = c.Client.Generic
	if acc.Generic {
		// Un servidor externo puede no pedir clave (LM Studio, Ollama) y no
		// tiene plan ni roles: solo importa si responde.
		switch {
		case authFailed:
			acc.State = AccountAuth
		case err != nil:
			acc.State = AccountOffline
		}
		return acc
	}
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
	acc.PlanName = plan
	if authFailed {
		acc.State = AccountAuth
	}
	return acc
}

// ApplyAccount guarda en la configuración el plan que trajo QueryAccount.
func (c *Chat) ApplyAccount(acc Account) {
	if acc.PlanName != "" && acc.PlanName != c.Cfg.ExtraString("plan_name") {
		c.Cfg.SetExtraString("plan_name", acc.PlanName)
		_ = c.SaveConfig()
	}
}

// UseProfile cambia de proveedor: guarda el que se deja, apunta el cliente al
// nuevo y recupera su modelo y su ventana de contexto. El modo delegate solo
// existe en un gateway Lixbon, así que pasa a ask en un proveedor genérico.
func (c *Chat) UseProfile(name string) error {
	if err := c.Cfg.UseProfile(name); err != nil {
		return err
	}
	c.Client.Configure(c.Cfg)
	c.Model = firstNonEmpty(c.Cfg.KeyModel, c.Cfg.Model)
	c.Session.Model = c.Model
	c.Session.ContextWindow = c.Cfg.ContextWindow
	if c.Client.Generic && c.Mode == ModeDelegate {
		c.Mode, c.Cfg.Mode = ModeAsk, ModeAsk
	}
	return c.SaveConfig()
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

// ThinkValue traduce el esfuerzo al campo think del gateway, que lo pasa a
// Ollama: los niveles solo los distingue gpt-oss; el resto de modelos con
// razonamiento lo entienden como encendido. nil deja decidir al servidor.
func ThinkValue(effort string) any {
	switch effort {
	case "off":
		return false
	case "on":
		return true
	case "low", "medium", "high":
		return effort
	}
	return nil
}

// SetEffort cambia el razonamiento y lo recuerda.
func (c *Chat) SetEffort(effort string) {
	if effort == "auto" {
		effort = ""
	}
	c.Effort = effort
	c.Cfg.SetExtraString("effort", effort)
	_ = c.SaveConfig()
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
	if a.Generic {
		return fmt.Errorf("El proveedor no ha listado ningún modelo. ¿Hay uno cargado en el servidor?")
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
	c.SessionTokens = 0
	c.ConversationID = newUUID()
	c.SetTitle("")
	c.Session.Working = nil
	c.anchor = nil
}

// Open reabre una conversación guardada; false si ya no está. Si es de otra
// carpeta que sigue existiendo, el workspace vuelve a ella.
func (c *Chat) Open(id string) bool {
	record, ok := c.Store.Load(id)
	if !ok {
		return false
	}
	c.Persist()
	if ws := record.Workspace; ws != "" && ws != c.Workspace {
		if info, err := os.Stat(ws); err == nil && info.IsDir() {
			c.SetWorkspace(ws)
		}
	}
	c.History = record.Messages
	c.ConversationID = firstNonEmpty(record.ID, id)
	c.SetTitle(record.Title)
	c.SessionTokens = record.Tokens
	c.anchor = nil
	return true
}

func (c *Chat) maybeAutotitle(sink Sink) {
	c.mu.Lock()
	if !c.autotitle || c.Client.Generic || c.title != "" || len(c.History) < 2 || c.titling {
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
	message, err := c.prepare(text)
	if err != nil {
		return "", err
	}
	for _, problem := range message.skipped {
		sink.Note("adjunto omitido: " + problem)
	}
	for _, file := range message.files {
		sink.Note(fmt.Sprintf("adjuntó %s · %d líneas", file.Name, strings.Count(file.Content, "\n")+1))
	}
	c.TurnTokens = 0
	c.Sources = nil
	c.History = append(c.History, message.message)
	prior := len(c.History) - 1

	var answer string
	switch c.Mode {
	case ModeDelegate:
		answer, err = c.delegateTurn(ctx, message.text, sink)
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
	if err == nil && c.Mode == ModeAsk && strings.TrimSpace(answer) == "" {
		// Sin respuesta no hubo intercambio: no se reenvía ni cuenta en el contexto.
		c.History = c.History[:prior]
		return "", nil
	}
	c.maybeAutotitle(sink)
	c.Persist()
	return answer, err
}

func (c *Chat) delegateTurn(ctx context.Context, text string, sink Sink) (string, error) {
	if c.Client.Generic {
		return "", fmt.Errorf("El modo delegate necesita un gateway Lixbon; con este proveedor usa el modo ask o agent.")
	}
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

// askTurn conversa sin tocar el workspace, pero puede leer páginas web con
// fetch_url. Lo descargado queda en el historial como TOOL_RESULT para que las
// preguntas siguientes sobre la página tengan el texto delante.
func (c *Chat) askTurn(ctx context.Context, sink Sink) (string, error) {
	c.autoCompact(ctx, sink)
	messages := c.contextMessages()
	var toolList []map[string]any
	if c.Session.NativeTools {
		toolList = []map[string]any{toolspec.Schema("fetch_url")}
	}
	stream := c.streamer(sink, false)
	turn := &agent.Turn{S: c.Session, Emit: sink.Event}
	var fetched []history.Message
	for step := 0; ; step++ {
		if step == maxAskFetches {
			toolList = nil
		}
		res, err := stream(ctx, messages, toolList)
		if err != nil && toolList != nil && ctx.Err() == nil && rejectsTools(err) {
			c.Session.NativeTools, toolList = false, nil
			res, err = stream(ctx, messages, nil)
		}
		if err != nil {
			return "", err
		}
		if len(res.ToolCalls) == 0 {
			c.History = append(c.History, fetched...)
			c.History = append(c.History, history.Assistant(res.Text))
			return res.Text, nil
		}
		messages = append(messages, history.Message{Role: "assistant", Content: res.Text, ToolCalls: res.ToolCalls})
		for _, raw := range res.ToolCalls {
			var call map[string]any
			_ = json.Unmarshal(raw, &call)
			parsed := toolparse.Native(call)
			id, _ := call["id"].(string)
			result := "[ERROR] En el modo ask solo está fetch_url; para el resto, /mode agent."
			if parsed.Tool == "fetch_url" {
				if result, err = turn.Fetch(ctx, parsed.Args); err != nil {
					return "", err
				}
				url, _ := parsed.Args["url"].(string)
				fetched = append(fetched, history.User(fmt.Sprintf("TOOL_RESULT fetch_url %s:\n%s", url,
					history.ClipToolOutput(result, history.MaxToolOutputChars))))
			}
			messages = append(messages, history.Message{Role: "tool", Name: parsed.Tool, ToolCallID: id,
				Content: history.ClipToolOutput(result, history.MaxToolOutputChars)})
		}
	}
}

const maxAskFetches = 3

// rejectsTools: el servidor (o el modelo) no admite herramientas nativas.
func rejectsTools(err error) bool {
	var apiErr *api.Error
	return errors.As(err, &apiErr) && strings.Contains(strings.ToLower(apiErr.Message), "tool")
}

// contextMessages son los últimos max_context_messages del historial, sin el
// round-trip de herramientas (recortado quedaría descolgado y rompería el
// template del modelo), más el LIXBON.md del proyecto.
func (c *Chat) contextMessages() []history.Message {
	messages := agent.SanitizeForPlainChat(c.History)
	if limit := c.Cfg.MaxContextMessages; limit > 0 && len(messages) > limit {
		messages = messages[len(messages)-limit:]
	}
	system := []history.Message{{Role: "system", Content: agent.StylePrompt}}
	if c.Client.Generic {
		system[0].Content = askSystemPrompt + " " + agent.StylePrompt
	}
	if c.ProjectContext != "" {
		system = append(system, history.Message{Role: "system", Content: "Contexto del proyecto (LIXBON.md):\n" + c.ProjectContext})
	}
	return append(system, messages...)
}

// askSystemPrompt evita que un modelo externo conteste «no tengo acceso a tu
// equipo» sin más. Solo va a proveedores genéricos: el gateway Lixbon pone su
// propio prompt y el contrato con él no lleva mensaje de sistema.
const askSystemPrompt = "Eres el asistente de Lixbon CLI, una terminal de programación. Ahora está en modo ask: " +
	"conversas y solo puedes leer páginas web con fetch_url (úsala cuando el usuario nombre una URL o un " +
	"dominio); no puedes leer, crear ni editar archivos ni ejecutar comandos. Si el usuario te pide algo que requiere el equipo o el proyecto, dile que escriba /mode agent " +
	"(o pulse Mayús+Tab) para que trabajes sobre su workspace; no digas que es imposible. " +
	"El usuario puede ejecutar un comando él mismo con !comando (p. ej. !git status); su salida te llega " +
	"como mensaje en la conversación. Responde en el idioma del usuario."

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
	return c.CompactWithProgress(ctx, keepRecent, nil)
}

// CompactWithProgress es Compact contando lo que lleva escrito el resumen:
// progress recibe los caracteres según llegan (desde otra goroutine).
func (c *Chat) CompactWithProgress(ctx context.Context, keepRecent int, progress func(written int)) error {
	compacted, err := history.CompactMessages(c.History, func(m []history.Message) (string, error) {
		if progress == nil {
			return c.AskQuiet(ctx, m)
		}
		return c.summarize(ctx, m, progress)
	}, keepRecent)
	if err != nil {
		return err
	}
	c.History = compacted
	c.anchor = nil
	return nil
}

// summarize pide el resumen en streaming, sin razonamiento ni búsqueda web y
// fuera de la conversación (sin conversation_id), para poder contar el avance.
func (c *Chat) summarize(ctx context.Context, messages []history.Message, progress func(int)) (string, error) {
	title := "interno"
	stream, err := c.Client.ChatStream(ctx, api.ChatRequest{
		Model: c.Model, Messages: toMaps(messages), ClientID: c.ClientID, Title: &title,
		WebSearch: false, NumCtx: c.Cfg.ContextWindow, Think: false,
	})
	if err != nil {
		return "", err
	}
	defer stream.Close()
	var text strings.Builder
	for ev, err := range stream.Events() {
		if err != nil {
			return "", err
		}
		if ev.Kind == sse.Content {
			text.WriteString(ev.Text)
			progress(text.Len())
		}
	}
	return text.String(), nil
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
			Effort:         c.Effort,
		}
		switch think := ThinkValue(c.Effort); {
		case think != nil:
			req.Think = think
		case agentMode || c.Session.PlanMode:
			req.Think = "high"
		}
		sink.Event(agent.Event{Kind: agent.EventStep})

		stream, err := c.Client.ChatStream(ctx, req)
		if err != nil {
			return agent.StreamResult{}, err
		}
		defer stream.Close()

		var text, reasoning strings.Builder
		var assembler toolCallAssembler
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
					assembler.add(batch)
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
		calls := assembler.calls()
		c.registerUsage(agentMode, messages, toolList, usage.PromptTokens, usage.TotalTokens)
		if usage.CompletionTokens > 0 {
			sink.Delta(sse.Usage, strconv.Itoa(usage.CompletionTokens))
		}
		return agent.StreamResult{Text: text.String(), ToolCalls: calls, Reasoning: textutil.Strip(reasoning.String())}, nil
	}
}

// registerUsage suma los tokens reales de la petición y fija el ancla del
// contexto con su prompt_tokens.
func (c *Chat) registerUsage(agentMode bool, messages []history.Message, toolList []map[string]any, prompt, total int) {
	if total > 0 {
		c.SessionTokens += total
		c.TurnTokens += total
	}
	if prompt <= 0 {
		return
	}
	est := c.Session.Estimator
	system, conv := splitSystem(messages)
	images := history.TokensPerImage * history.ImageCount(conv)
	// Ollama no cuenta el prefijo que reutiliza de su caché: un prompt muy por
	// debajo de lo enviado no es un conteo completo.
	sentEst := est.EstimateTokens(messages) + int(float64(history.PayloadChars(nil, toolList))/est.CharsPerToken())
	if float64(prompt) < 0.6*float64(sentEst) {
		return
	}
	convChars := history.PayloadChars(conv, nil)
	key := fmt.Sprintf("%t/%d", agentMode, history.PayloadChars(system, toolList))
	if c.overhead == nil {
		c.overhead = map[string]overhead{}
	}
	o, ok := c.overhead[key]
	switch {
	case !ok:
		est.Calibrate(history.PayloadChars(messages, toolList), prompt-images)
	case convChars > o.convChars && prompt > o.tokens:
		// Con el sistema ya medido, la proporción sale solo de la conversación,
		// sin el prompt del gateway que el CLI no ve.
		est.Calibrate(convChars, prompt-o.tokens-images)
	}
	if !ok || convChars < o.convChars {
		o = overhead{tokens: max(0, prompt-est.EstimateTokens(conv)), convChars: convChars}
		c.overhead[key] = o
	}
	c.anchor = &anchor{agent: agentMode, tokens: max(0, prompt-o.tokens), chars: convChars}
}

func splitSystem(messages []history.Message) (system, conv []history.Message) {
	for _, m := range messages {
		if m.Role == "system" {
			system = append(system, m)
		} else {
			conv = append(conv, m)
		}
	}
	return system, conv
}

// ContextUsage es lo que ocupa la conversación: los mensajes del usuario, las
// respuestas del modelo y lo que hizo con las herramientas, sin el prompt de
// sistema ni los esquemas de herramientas. Parte del conteo real de la última
// petición y solo estima lo añadido después.
func (c *Chat) ContextUsage() (tokens int, percent float64) {
	agentMode := c.Mode == ModeAgent
	var sent []history.Message
	switch {
	case agentMode && c.Session.Working != nil:
		sent = c.Session.Working
	case agentMode:
		sent = c.History
	default:
		sent = agent.SanitizeForPlainChat(c.History)
		if limit := c.Cfg.MaxContextMessages; limit > 0 && len(sent) > limit {
			sent = sent[len(sent)-limit:]
		}
	}
	_, conv := splitSystem(sent)
	if len(conv) == 0 {
		return 0, 0
	}
	est := c.Session.Estimator
	chars := history.PayloadChars(conv, nil)
	if a := c.anchor; a != nil && a.agent == agentMode && float64(chars) >= float64(a.chars)*0.8 {
		tokens = a.tokens + int(float64(max(0, chars-a.chars))/est.CharsPerToken())
	} else {
		tokens = est.EstimateTokens(conv)
	}
	window := max(c.Cfg.ContextWindow, 1)
	return tokens, min(100.0, float64(tokens)*100.0/float64(window))
}
