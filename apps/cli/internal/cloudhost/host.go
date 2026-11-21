// Package cloudhost es `lixbon host`: el CLI sin interfaz que corre dentro del
// entorno aislado de una sesión de Coding y hace de host de su sesión /remote.
//
// No hay pantalla ni terminal: la web es el único mando. El gateway creó la
// sesión; aquí se clona el repo (por el proxy git del gateway, con el token
// acotado de la sesión), se crea la rama lixbon/<tema> con el primer mensaje
// y se atienden los mensajes y comandos que llegan por el relay.
package cloudhost

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/remote"
	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/toolparse"
	"lixbon.com/cli/internal/tools"
)

// Options llegan por el entorno del contenedor (core/sandbox/runner.py).
type Options struct {
	Gateway       string
	Token         string
	SessionID     string
	Repo          string
	DefaultBranch string
	Mode          string // auto | manual | ask | plan
	Model         string
	Root          string // /workspace
}

var sessionIDRe = regexp.MustCompile(`^[0-9a-f]{12}$`)

// OptionsFromEnv lee la configuración que el gateway le pasa al contenedor.
func OptionsFromEnv() (Options, error) {
	o := Options{
		Gateway:       strings.TrimRight(os.Getenv("LIXBON_GATEWAY"), "/"),
		Token:         os.Getenv("LIXBON_SESSION_TOKEN"),
		SessionID:     os.Getenv("LIXBON_SESSION_ID"),
		Repo:          os.Getenv("LIXBON_REPO"),
		DefaultBranch: firstNonEmpty(os.Getenv("LIXBON_DEFAULT_BRANCH"), "main"),
		Mode:          firstNonEmpty(os.Getenv("LIXBON_MODE"), "manual"),
		Model:         os.Getenv("LIXBON_MODEL"),
		Root:          firstNonEmpty(os.Getenv("LIXBON_WORKSPACE"), "/workspace"),
	}
	switch {
	case o.Gateway == "" || o.Token == "":
		return o, errors.New("faltan LIXBON_GATEWAY o LIXBON_SESSION_TOKEN: lixbon host solo corre dentro de un entorno de Coding")
	case !sessionIDRe.MatchString(o.SessionID):
		return o, errors.New("LIXBON_SESSION_ID no es válido")
	case !strings.Contains(o.Repo, "/"):
		return o, errors.New("LIXBON_REPO no es válido")
	}
	return o, nil
}

// Host es el estado de una sesión en marcha.
type Host struct {
	opts   Options
	client *api.Client
	link   *remote.Link
	chat   *chat.Chat
	dir    string
	branch string

	mu        sync.Mutex
	log       []map[string]any
	questions map[string]chan string
	lastCtx   string

	turnMu sync.Mutex
	cancel context.CancelFunc
	busy   bool
	queue  []remote.Command
	live   *sink
	first  bool
	// resumed: hay conversación de antes de una pausa (el contenedor es nuevo).
	resumed bool
}

// Run conecta con la sesión, prepara el repo y atiende hasta que la sesión
// termine o se cancele ctx (el contenedor se para al pausar).
func Run(ctx context.Context, o Options) error {
	h := &Host{opts: o, questions: map[string]chan string{}, first: true}
	h.client = api.New(o.Gateway+"/v1", o.Token)
	h.dir = filepath.Join(o.Root, repoName(o.Repo))
	// Sin título: en la nube lo pone la web (primer mensaje o renombrar).
	h.link = remote.NewLink(h.client, "cloud", "", "Nube")
	h.link.Snapshot = h.snapshot

	stopPreview, err := startPreview(ctx, tools.PreviewBase)
	if err != nil {
		h.fail(ctx, "No se pudo abrir la vista previa: "+err.Error())
		return err
	}
	defer stopPreview()

	if _, err := h.client.CodingHost(ctx, o.SessionID, map[string]any{"estado": "clonando"}); err != nil {
		return fmt.Errorf("el gateway no acepta el host: %w", err)
	}
	remoteURL := o.Gateway + "/api/coding/sessions/" + o.SessionID + "/git"
	if err := clone(ctx, remoteURL, h.dir); err != nil {
		h.fail(ctx, "No se pudo clonar "+o.Repo+": "+textutil.Head(err.Error(), 200))
		return err
	}
	if err := h.openChat(ctx); err != nil {
		h.fail(ctx, "No se pudo preparar el agente: "+err.Error())
		return err
	}
	defer h.chat.Close()
	// Reanudada: el agente recuerda la conversación de antes de la pausa.
	h.resumed = h.loadMemory()
	h.refreshContext()

	if b := currentBranch(ctx, h.dir); strings.HasPrefix(b, branchPrefix) {
		h.branch = b // sesión reanudada: ya tiene su rama
		h.first = false
	}
	h.link.Attach(o.SessionID, h.hello())
	defer h.link.Stop(false) // pausar no termina la sesión

	payload := map[string]any{"estado": "activa"}
	if h.branch != "" {
		payload["branch"] = h.branch
	}
	reply, err := h.client.CodingHost(ctx, o.SessionID, payload)
	if err != nil {
		return err
	}
	var pending []remote.Command
	if len(reply.Pending) > 0 {
		_ = json.Unmarshal(reply.Pending, &pending)
	}
	for _, cmd := range pending {
		h.onCommand(ctx, cmd)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-h.link.Done():
			return nil
		case cmd, ok := <-h.link.Inbox:
			if !ok {
				return nil
			}
			if cmd.Type == "bye" {
				return nil
			}
			h.onCommand(ctx, cmd)
		}
	}
}

func repoName(repo string) string {
	_, name, _ := strings.Cut(repo, "/")
	return firstNonEmpty(name, "repo")
}

// fail avisa al gateway (la web enseña el error con «Reintentar»).
func (h *Host) fail(ctx context.Context, msg string) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	_, _ = h.client.CodingHost(ctx, h.opts.SessionID, map[string]any{"estado": "error", "error": msg})
}

// ---------------------------------------------------------------- agente

const codingContext = `
=== SESIÓN DE CODING EN LA NUBE ===
Trabajas en un entorno aislado (un contenedor Linux sin pantalla), no en el equipo del usuario. El repo %s está clonado en %s.
- Trabajas en la rama %s. Haz commits ahí cuando termines un cambio; NUNCA cambies a la rama por defecto (%s) ni subas a ella: el servidor lo rechaza.
- Para subir los cambios: git push -u origin HEAD. Para abrir el PR cuando el usuario lo pida: lixbon pr --title "…" --body "…" (sube la rama y abre el PR contra %s).
- La salida a internet está limitada (GitHub, npm, PyPI, Go). Si una instalación falla por red, díselo al usuario.
- Para ver lo que construyes usa el navegador (browser_navigate a http://127.0.0.1:<puerto>). Si el usuario pide ver la app o la interfaz, arranca el servidor de desarrollo en segundo plano con la ruta base de $LIXBON_PREVIEW_BASE (sustituye {port}; Vite: --base, Next: basePath) y llama a show_preview.
`

func (h *Host) openChat(ctx context.Context) error {
	cfgDir := filepath.Join(os.TempDir(), "lixbon")
	if err := os.MkdirAll(cfgDir, 0o700); err != nil {
		return err
	}
	cfg := config.Load(filepath.Join(cfgDir, "config.json"))
	cfg.BaseURL, cfg.APIKey = h.opts.Gateway+"/v1", h.opts.Token
	cfg.Mode = chat.ModeAgent
	if h.opts.Mode == "ask" {
		cfg.Mode = chat.ModeAsk
	}
	c, err := chat.New(cfg, h.client, chat.Options{
		ConfigPath: filepath.Join(cfgDir, "config.json"), Model: h.opts.Model,
		ClientID: "lixbon-coding", Workspace: h.dir, Ephemeral: true,
	})
	if err != nil {
		return err
	}
	if c.Model == "" {
		models, err := h.client.ModelsDetail(ctx)
		if err != nil || len(models) == 0 {
			return errors.New("no hay modelos disponibles en el gateway")
		}
		c.SetModel(models[0].ID)
	}
	c.Session.Approver = &approver{link: h.link}
	h.chat = c
	h.applyMode(h.opts.Mode)
	tb := c.Toolbox
	tb.AskUser = h.ask
	tb.OnImage = h.showImage
	tb.OnPreview = func(p tools.ShownPreview) {
		h.emit("preview_shown", map[string]any{"port": p.Port, "path": p.Path})
	}
	tb.OnOutput = func(chunk []byte) {
		h.turnMu.Lock()
		live := h.live
		h.turnMu.Unlock()
		if live != nil {
			live.outputChunk(chunk)
		}
	}
	h.refreshContext()
	return nil
}

// applyMode fija los permisos del agente (los mismos modos que el conector de
// GitHub): auto lo hace todo; manual pide aprobar ediciones y comandos; plan
// solo lee y propone; ask solo lee y responde.
func (h *Host) applyMode(mode string) {
	s := h.chat.Session
	h.opts.Mode = mode
	h.chat.Mode = chat.ModeAgent
	s.PlanMode = false
	switch mode {
	case "auto":
		s.AutoApprove, s.AutoRunCommands = true, true
	case "plan":
		s.AutoApprove, s.AutoRunCommands, s.PlanMode = false, false, true
	case "ask":
		h.chat.Mode = chat.ModeAsk
		s.AutoApprove, s.AutoRunCommands = false, false
	default:
		h.opts.Mode = "manual"
		s.AutoApprove, s.AutoRunCommands = false, false
	}
}

// refreshContext añade al contexto del proyecto las reglas del entorno.
func (h *Host) refreshContext() {
	base := strings.SplitN(h.chat.ProjectContext, "\n=== SESIÓN DE CODING EN LA NUBE ===", 2)[0]
	branch := firstNonEmpty(h.branch, "lixbon/<tema> (se crea con el primer mensaje)")
	ctx := base + fmt.Sprintf(codingContext, h.opts.Repo, h.dir, branch, h.opts.DefaultBranch, h.opts.DefaultBranch)
	if h.resumed {
		ctx += "- La sesión se reanudó tras una pausa en un contenedor nuevo: los archivos del repo siguen, pero los procesos en segundo plano (servidores de desarrollo), el navegador y /tmp de antes ya no existen. Vuelve a arrancar lo que necesites.\n"
	}
	h.chat.ProjectContext = ctx
	h.chat.Session.ProjectContext = ctx
}

func (h *Host) modeLabel() string {
	return map[string]string{"auto": "auto", "manual": "manual", "ask": "ask", "plan": "plan"}[h.opts.Mode]
}

func (h *Host) hello() map[string]any {
	models := []map[string]string{}
	if list, err := h.client.ModelsDetail(context.Background()); err == nil {
		for _, m := range list {
			models = append(models, map[string]string{"value": m.ID, "label": firstNonEmpty(m.Name, m.ID)})
		}
	}
	return map[string]any{
		"agent": "lixbon", "workspace": repoName(h.opts.Repo), "mode": h.modeLabel(),
		"model": h.chat.Model, "model_value": h.chat.Model, "models": models,
		"capabilities": []string{"attachments", "images", "mentions", "files", "config", "reasoning", "context",
			"questions", "preview", "git", "diff", "tree"},
		"commands": comandosHello(), "efforts": []string{}, "effort": "auto",
		"repo": h.opts.Repo, "branch": h.branch, "default_branch": h.opts.DefaultBranch,
	}
}

// nombreDeRama: el agente elige el nombre de su rama a partir de la tarea
// (no se copia el primer mensaje). Si el modelo no responde a tiempo, se
// usa el texto de la tarea como antes.
func (h *Host) nombreDeRama(ctx context.Context, tarea string) string {
	if len([]rune(tarea)) > 2000 {
		tarea = string([]rune(tarea)[:2000])
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := h.client.Chat(ctx, h.chat.Model, []map[string]any{
		{"role": "system", "content": "Eres el agente de una sesión de programación y vas a crear tu rama de trabajo. " +
			"Responde SOLO con el nombre: de 2 a 5 palabras en minúsculas separadas por guiones, sin prefijo ni comillas, " +
			"que describan el cambio (por ejemplo: carrito-descuentos, arreglar-login-safari, docs-api-pagos). " +
			"Usa el idioma de la tarea."},
		{"role": "user", "content": tarea},
	}, "lixbon-coding")
	if err != nil {
		return tarea
	}
	return limpiarNombreRama(out, tarea)
}

// ---------------------------------------------------------------- comandos

func (h *Host) onCommand(ctx context.Context, cmd remote.Command) {
	switch cmd.Type {
	case "prompt":
		h.turnMu.Lock()
		if h.busy {
			h.queue = append(h.queue, cmd)
			h.turnMu.Unlock()
			h.notice("Tu mensaje se enviará cuando termine lo que está en marcha.")
			return
		}
		h.busy = true
		h.turnMu.Unlock()
		go h.turn(ctx, cmd)
	case "interrupt":
		h.turnMu.Lock()
		if h.cancel != nil {
			h.cancel()
		}
		h.queue = nil
		h.turnMu.Unlock()
	case "choose":
		h.answer(cmd.ID, cmd.Value)
	case "files":
		h.files(ctx, cmd.Query)
	case "config":
		changed := false
		if cmd.Model != "" {
			h.chat.SetModel(cmd.Model)
			changed = true
		}
		if cmd.Mode != "" {
			// Vale desde el próximo turno: el que está en marcha sigue con el suyo.
			h.applyMode(cmd.Mode)
			changed = true
		}
		if changed {
			h.link.Emit("hello", h.hello())
		}
	case "git_diff":
		go func() {
			files, truncated := diffFiles(ctx, h.dir, h.opts.DefaultBranch)
			h.link.Emit("diff", map[string]any{"files": files, "truncated": truncated,
				"branch": h.branch, "base": h.opts.DefaultBranch})
		}()
	case "tree":
		go func() {
			entries, truncated := treeEntries(ctx, h.dir)
			h.link.Emit("tree", map[string]any{"entries": entries, "truncated": truncated, "branch": h.branch})
		}()
	case "read_file":
		go h.link.Emit("file_content", leerArchivo(h.dir, cmd.Path))
	case "git_log":
		go h.link.Emit("commits", commitsDeRama(ctx, h.dir, h.opts.DefaultBranch))
	case "procs":
		h.emitProcesos()
	case "stop_proc":
		if h.chat != nil && h.chat.Toolbox != nil && h.chat.Toolbox.Procs != nil && cmd.ID != "" {
			_, _ = h.chat.Toolbox.Procs.Stop(cmd.ID)
		}
		h.emitProcesos()
	case "create_pr":
		go h.createPR(ctx, cmd.Title, cmd.Body)
	}
}

func (h *Host) createPR(ctx context.Context, title, body string) {
	if _, err := push(ctx, h.dir); err != nil {
		h.emit("error", map[string]any{"message": "No se pudo subir la rama: " + textutil.Head(err.Error(), 300)})
		return
	}
	if _, err := h.client.CodingHost(ctx, h.opts.SessionID, map[string]any{"pr": map[string]any{"title": title, "body": body}}); err != nil {
		h.emit("error", map[string]any{"message": "No se pudo abrir el PR: " + err.Error()})
	}
}

func (h *Host) files(ctx context.Context, query string) {
	entries, _ := treeEntries(ctx, h.dir)
	q := strings.ToLower(strings.TrimSpace(query))
	items := []map[string]string{}
	for _, e := range entries {
		rel := e["path"]
		if q != "" && !strings.Contains(strings.ToLower(rel), q) {
			continue
		}
		items = append(items, map[string]string{"name": filepath.Base(rel), "rel": rel, "path": filepath.Join(h.dir, rel)})
		if len(items) == 30 {
			break
		}
	}
	h.link.Emit("files", map[string]any{"query": query, "items": items})
}

// ---------------------------------------------------------------- turno

const docsEnd = "\n\n---\n\n"

func (h *Host) turn(ctx context.Context, cmd remote.Command) {
	defer func() {
		h.turnMu.Lock()
		h.busy, h.cancel, h.live = false, nil, nil
		var next *remote.Command
		if len(h.queue) > 0 {
			next = &h.queue[0]
			h.queue = h.queue[1:]
			h.busy = true
		}
		h.turnMu.Unlock()
		// Antes del siguiente turno: una pausa ya no pierde lo hablado.
		h.saveMemory()
		if next != nil {
			go h.turn(ctx, *next)
		}
	}()
	// Comandos «/» (help, status, commit…): responden sin pasar por el modelo.
	if h.slash(ctx, &cmd) {
		return
	}
	message, images, imageIDs := h.prepare(cmd)
	if message == "" {
		return
	}
	// La rama de trabajo nace con el primer mensaje.
	if h.first {
		h.first = false
		if b, err := ensureBranch(ctx, h.dir, h.nombreDeRama(ctx, cmd.Text)); err == nil {
			h.branch = b
			h.refreshContext()
			_, _ = h.client.CodingHost(ctx, h.opts.SessionID, map[string]any{"branch": b})
			h.emit("branch", map[string]any{"name": b, "base": h.opts.DefaultBranch})
			h.link.Emit("hello", h.hello())
		} else {
			h.notice("No se pudo crear la rama de trabajo: " + err.Error())
		}
	}
	h.emit("user_msg", map[string]any{"text": cmd.Text, "origin": "remote", "images": len(images), "image_ids": imageIDs})
	h.link.Emit("status", map[string]any{"state": "thinking"})

	turnCtx, cancel := context.WithCancel(ctx)
	s := &sink{h: h, agent: h.chat.Mode == chat.ModeAgent, started: time.Now()}
	h.turnMu.Lock()
	h.cancel, h.live = cancel, s
	h.turnMu.Unlock()
	defer cancel()

	h.chat.AttachNext(images...)
	answer, err := h.chat.Send(turnCtx, message, s)
	s.finish()
	cancelled := turnCtx.Err() != nil && ctx.Err() == nil
	if err != nil && !cancelled {
		h.emit("error", map[string]any{"message": err.Error()})
	} else {
		display := strings.TrimSpace(answer)
		if s.agent {
			display = toolparse.CleanProse(answer)
		}
		h.emit("assistant_done", map[string]any{"text": s.bubble(display), "interrupted": cancelled,
			"ms": time.Since(s.started).Milliseconds()})
	}
	h.emitContext()
	h.emitProcesos()
	h.link.Emit("status", map[string]any{"state": "idle"})
}

// prepare monta el mensaje: documentos delante, imágenes a disco (el chat
// las adjunta por ruta) y menciones como @"ruta".
func (h *Host) prepare(cmd remote.Command) (string, []string, []string) {
	var docs, images, ids []string
	for _, a := range cmd.Attachments {
		switch a.Kind {
		case "image":
			path, err := saveImage(a)
			if err != nil {
				h.notice("No se pudo usar la imagen " + a.Name + ": " + err.Error())
				continue
			}
			images = append(images, path)
			if id := h.uploadImage(path); id != "" {
				ids = append(ids, id)
			}
		case "doc":
			docs = append(docs, "--- Documento adjunto: "+a.Name+" ---\n"+a.Text)
		}
	}
	message := strings.TrimSpace(cmd.Text)
	for _, m := range cmd.Mentions {
		rel := filepath.ToSlash(m.Rel)
		if rel != "" && filepath.IsLocal(filepath.FromSlash(rel)) {
			message += ` @"` + rel + `"`
		}
	}
	switch {
	case len(docs) > 0:
		message = strings.Join(docs, "\n\n") + docsEnd + firstNonEmpty(strings.TrimSpace(message), "Analiza este documento.")
	case message == "" && len(images) > 0:
		message = "Mira la imagen adjunta."
	}
	return strings.TrimSpace(message), images, ids
}

func saveImage(a remote.Attachment) (string, error) {
	data, err := base64.StdEncoding.DecodeString(a.Base64[strings.IndexByte(a.Base64, ',')+1:])
	if err != nil {
		return "", errors.New("la imagen no llegó entera")
	}
	ext := map[string]string{"image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/jpeg": ".jpg"}[strings.ToLower(a.Mime)]
	if ext == "" {
		ext = ".jpg"
	}
	dir := filepath.Join(os.TempDir(), "lixbon-coding")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	file := filepath.Join(dir, remote.NewID()+ext)
	return file, os.WriteFile(file, data, 0o600)
}

func (h *Host) uploadImage(path string) string {
	mime := tools.ImageMime(path)
	id := remote.ImageID(mime)
	if id == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > tools.MaxShownImage {
		return ""
	}
	h.link.UploadImage(id, mime, data)
	return id
}

func (h *Host) showImage(img tools.ShownImage) {
	if id := h.uploadImage(img.Path); id != "" {
		h.emit("image_shown", map[string]any{"id": id, "name": img.Name, "w": img.W, "h": img.H, "caption": img.Caption})
	}
}

// ---------------------------------------------------------------- transcript

func (h *Host) emit(kind string, fields map[string]any) {
	h.link.Emit(kind, fields)
	h.record(kind, fields)
}

func (h *Host) notice(text string) { h.emit("notice", map[string]any{"text": text}) }

// record guarda lo necesario para el snapshot de un mando que se une tarde.
func (h *Host) record(kind string, fields map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	str := func(k string) string { s, _ := fields[k].(string); return s }
	var item map[string]any
	switch kind {
	case "user_msg":
		item = map[string]any{"role": "user", "content": str("text"), "images": fields["images"], "image_ids": fields["image_ids"]}
	case "assistant_done", "assistant_prose":
		if strings.TrimSpace(str("text")) != "" {
			item = map[string]any{"role": "assistant", "content": str("text")}
			if kind == "assistant_done" {
				item["final"], item["ms"] = true, fields["ms"]
			}
		}
	case "reasoning":
		item = map[string]any{"role": "thinking", "content": str("text"), "ms": fields["ms"]}
	case "notice":
		item = map[string]any{"role": "notice", "content": str("text")}
	case "error":
		item = map[string]any{"role": "error", "content": str("message")}
	case "image_shown":
		item = map[string]any{"role": "image"}
		for k, v := range fields {
			item[k] = v
		}
	case "tool_use":
		item = map[string]any{"role": "tool", "pending": true}
		for k, v := range fields {
			item[k] = v
		}
	case "tool_result":
		for i := len(h.log) - 1; i >= 0; i-- {
			if h.log[i]["role"] == "tool" && h.log[i]["id"] == fields["id"] {
				h.log[i]["pending"] = false
				h.log[i]["content"] = fields["result"]
				h.log[i]["ok"] = fields["error"] != true
				return
			}
		}
	}
	if item != nil {
		h.log = append(h.log, item)
		if len(h.log) > 300 {
			h.log = h.log[len(h.log)-300:]
		}
	}
}

func (h *Host) snapshot() []map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]map[string]any(nil), h.log[max(0, len(h.log)-150):]...)
}

func (h *Host) emitContext() {
	if h.chat == nil {
		return
	}
	tokens, files, system, window := h.chat.ContextParts()
	if window <= 0 {
		return
	}
	pct := func(n int) int { return int(float64(n)*100/float64(window) + 0.5) }
	fields := map[string]any{"tokens": tokens, "window": window, "pct": min(100, pct(tokens)),
		"files": files, "system": system, "auto": int(history.AutoCompactRatio * 100)}
	key := fmt.Sprint(fields["pct"], "/", window)
	h.mu.Lock()
	changed := key != h.lastCtx
	h.lastCtx = key
	h.mu.Unlock()
	if changed {
		h.emit("context", fields)
	}
}

// ---------------------------------------------------------------- preguntas y aprobaciones

// ask lleva las preguntas del agente (ask_user) a la web, una a una.
func (h *Host) ask(ctx context.Context, questions []tools.Question) ([]string, bool) {
	answers := make([]string, len(questions))
	for i, q := range questions {
		id := remote.NewID()
		waiter := make(chan string, 1)
		h.mu.Lock()
		h.questions[id] = waiter
		h.mu.Unlock()
		choices := make([]map[string]string, 0, len(q.Options))
		for _, o := range q.Options {
			choices = append(choices, map[string]string{"label": o.Label, "value": o.Label, "description": o.Description})
		}
		h.link.Emit("choice_request", map[string]any{"id": id, "kind": "question", "title": q.Text, "header": q.Header,
			"options": choices, "free": true, "multiple": q.Multiple})
		var answer string
		select {
		case answer = <-waiter:
			h.link.Emit("choice_resolved", map[string]any{"id": id, "value": answer})
		case <-ctx.Done():
			h.link.Emit("choice_resolved", map[string]any{"id": id})
		case <-h.link.Done():
		}
		h.mu.Lock()
		delete(h.questions, id)
		h.mu.Unlock()
		if strings.TrimSpace(answer) == "" {
			return answers, false
		}
		answers[i] = answer
		h.emit("question_answered", map[string]any{"question": q.Text, "answer": answer, "header": q.Header})
	}
	return answers, true
}

func (h *Host) answer(id, value string) {
	h.mu.Lock()
	waiter := h.questions[id]
	h.mu.Unlock()
	if waiter != nil {
		select {
		case waiter <- value:
		default:
		}
	}
}

// approver manda las aprobaciones (modo manual) a la web y espera allí.
type approver struct{ link *remote.Link }

func (a *approver) Approve(ctx context.Context, req agent.Approval) (agent.Decision, error) {
	risk := "command"
	if req.Kind == agent.ApproveEdit {
		risk = "edit"
	}
	request := map[string]any{"tool": req.Tool, "summary": firstNonEmpty(req.Summary, req.Tool), "risk": risk}
	if req.Kind == agent.ApproveBrowser {
		request["summary"] = "Navegador · " + firstNonEmpty(req.Summary, req.Tool) + " en " + req.Detail
	}
	if req.Change != nil {
		for k, v := range changeFields(*req.Change) {
			request[k] = v
		}
	}
	if a.link.RequestApproval(ctx, request) {
		return agent.Allow, nil
	}
	return agent.Deny, ctx.Err()
}
