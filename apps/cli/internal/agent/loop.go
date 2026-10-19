package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"lixbon.com/cli/internal/history"
	"lixbon.com/cli/internal/orch"
	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/toolparse"
	"lixbon.com/cli/internal/tools"
	"lixbon.com/cli/internal/toolspec"
)

const (
	repeatedMessage = "El agente se detuvo: repetía la misma acción sin avanzar. Dile cómo seguir."
	noAnswerMessage = "El modelo terminó sin responder ni actuar, también al reintentarlo. " +
		"Escribe «continúa» para volver a intentarlo o cambia de modelo con /model."
	stalledMessage = "El modelo se quedó razonando sin responder ni actuar. " +
		"Escribe «continúa» para volver a intentarlo, o usa /model para cambiar a un modelo sin «thinking»."
	planBlockedMessage = "[modo plan] No puedes modificar archivos ni ejecutar comandos ahora. Termina de " +
		"explorar y responde con el plan numerado para que el usuario lo apruebe."
	planBlockedMCPMessage = "[modo plan] No puedes usar herramientas externas ahora; termina el plan."
	cancelledMessage      = "Ejecución cancelada por el usuario"
	maxImageBytes         = 8 << 20
	maxEmptyRetries       = 2
)

// Turn ejecuta un turno del agente: pide al modelo, ejecuta lo que pida con
// aprobación y repite hasta que deja de pedir herramientas. No pinta nada:
// cuenta lo que ocurre por Emit.
type Turn struct {
	S      *Session
	Stream Streamer
	Emit   func(Event)

	readOnly bool
	// failed: la última acción ejecutada terminó en error.
	failed bool
}

func (t *Turn) emit(e Event) {
	if e.Failed {
		t.failed = true
	}
	if t.Emit != nil {
		t.Emit(e)
	}
}

func (t *Turn) note(text string) { t.emit(Event{Kind: EventNote, Text: text}) }

// tokensText es «92.1k»: los tokens en las notas de la compactación.
func tokensText(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1_000)
	}
	return fmt.Sprint(n)
}

type apiError interface{ APIStatus() int }

func isAPIError(err error) bool {
	_, ok := err.(apiError)
	return ok
}

// stream pide un paso al modelo. Si rechaza las herramientas nativas, el
// turno pasa al protocolo de texto el resto de la sesión.
func (t *Turn) stream(ctx context.Context, messages []history.Message, toolList []map[string]any) (StreamResult, error) {
	res, err := t.Stream(ctx, messages, toolList)
	if err != nil && ctx.Err() == nil && len(toolList) > 0 && isAPIError(err) &&
		strings.Contains(strings.ToLower(err.Error()), "tool") {
		t.S.NativeTools = false
		name := t.S.Model
		if name == "" {
			name = "el modelo"
		}
		t.note(fmt.Sprintf("%s no soporta herramientas nativas: el agente pasa al protocolo de texto.", name))
		return t.Stream(ctx, SanitizeForPlainChat(messages), nil)
	}
	return res, err
}

func (t *Turn) systemMessage(native bool) (history.Message, []map[string]any) {
	s := t.S
	content := TextSystemPrompt(s.Workspace)
	if native {
		content = NativeSystemPrompt(s.Workspace)
		if s.TextCalls {
			content += NativeFormatPrompt
		}
	}
	if s.ProjectContext != "" {
		content += "\n\n=== CONTEXTO DEL PROYECTO (LIXBON.md) ===\n" + s.ProjectContext
	}
	content += TodoPrompt + AskFirstPrompt + CurrentDataPrompt(time.Now()) + ResearchPrompt
	if !s.PlanMode {
		content += DeleteManyPrompt + RequirementsPrompt
	}
	if s.BrowserEnabled() {
		if native {
			content += BrowserPrompt
		} else {
			content += BrowserTextPrompt(!s.NoVision)
		}
		content += s.BrowserResume()
	}
	content += "\n\n" + StylePrompt
	if s.PlanMode {
		content += PlanModePrompt
	} else if info := s.OrchInfo(); info.Available() {
		content += orch.PromptSection(info)
	}
	var extra []json.RawMessage
	catalog, byServer := s.catalog()
	switch {
	case byServer:
		servers := catalog.Summary()
		for _, info := range servers {
			if s.MCPLoaded[info.Name] && info.Err == "" {
				extra = append(extra, catalog.ServerSchemas(info.Name)...)
			}
		}
		content += mcpCatalogPrompt(servers, s.MCPLoaded, native)
	case s.MCP != nil:
		extra = s.MCP.ToolSchemas()
	}
	if len(extra) > 0 && !native {
		content += MCPTextPrompt(extra)
	}
	var toolList []map[string]any
	if native {
		for _, schema := range toolspec.Schemas() {
			if fn, _ := schema["function"].(map[string]any); s.ToolAllowed(pyStr(fn["name"])) {
				toolList = append(toolList, schema)
			}
		}
		for _, raw := range extra {
			var schema map[string]any
			if json.Unmarshal(raw, &schema) == nil {
				toolList = append(toolList, schema)
			}
		}
		if byServer && anyUp(catalog.Summary()) {
			toolList = append(toolList, mcpToolsSchema())
		}
	}
	return history.Message{Role: "system", Content: content}, toolList
}

// Run ejecuta el turno sobre hist y devuelve la respuesta final y el
// historial de trabajo actualizado. No hay tope de pasos: el turno termina
// cuando el modelo deja de pedir herramientas o cuando se detecta que está
// atascado, y en ese caso lo dice. Lo que se dejó de intentar por fallar
// demasiadas veces se cuenta al final.
func (t *Turn) Run(ctx context.Context, hist []history.Message) (string, []history.Message, error) {
	g := newRetries()
	answer, working, err := t.loop(ctx, hist, g)
	if report := g.report(); report != "" && ctx.Err() == nil {
		t.note(report)
	}
	return answer, working, err
}

func (t *Turn) loop(ctx context.Context, hist []history.Message, g *retries) (string, []history.Message, error) {
	s := t.S
	working := append([]history.Message{}, hist...)
	window := s.ContextWindow
	if window == 0 {
		window = 8192
	}
	est := s.Estimator
	if est == nil {
		est = &history.Estimator{}
	}

	nudged, prunedWarned, usedTools := false, false, false
	emptyRetries, repeated, stalled := 0, 0, 0
	lastSignature := ""
	// nudgeAt es dónde va el recordatorio de aplicar código y nudgeAnswer, la
	// respuesta que lo provocó: si el modelo no aplica nada, el recordatorio se
	// retira y queda esa respuesta, no un «OK».
	nudgeAt, nudgeAnswer := -1, ""
	var next StepOptions

	for {
		if err := ctx.Err(); err != nil {
			return "", working, err
		}
		opts := next
		next = StepOptions{}
		s.Working = working
		if s.Ask != nil && est.NeedsCompaction(working, window) {
			before := est.EstimateTokens(working)
			t.emit(Event{Kind: EventNote, Compacting: true, Text: fmt.Sprintf(
				"El contexto llegó al %d %% de la ventana: compactando la conversación…", min(100, before*100/window))})
			compacted, err := history.CompactMessages(working, func(m []history.Message) (string, error) {
				return s.Ask(ctx, m)
			}, history.CompactKeepRecent)
			if err != nil {
				if ctx.Err() != nil {
					return "", working, ctx.Err()
				}
				t.note(fmt.Sprintf("No se pudo compactar (%v); se recortarán los pasos antiguos.", err))
			} else {
				working = compacted
				s.Working = working
				t.note(fmt.Sprintf("Conversación compactada: de ~%s a ~%s tokens. Un resumen sustituye a lo anterior.",
					tokensText(before), tokensText(est.EstimateTokens(working))))
			}
		}

		native := s.NativeTools
		system, toolList := t.systemMessage(native)
		body := working
		if !native {
			body = SanitizeForPlainChat(working)
		}
		budget := est.PromptBudget(window, toolList, est.EstimateTokens([]history.Message{system}))
		body, pruned := est.FitHistory(body, budget, history.KeepRecent)
		if pruned && !prunedWarned {
			prunedWarned = true
			t.note("La conversación llenaba la ventana de contexto: se han recortado los pasos más antiguos para poder seguir.")
		}

		messages := append([]history.Message{system}, body...)
		res, err := t.stream(WithStep(ctx, opts), messages, toolList)
		if err != nil {
			return "", working, err
		}
		assistant := toolparse.TruncateFabricated(res.Text)

		if opts.Quiet && len(res.ToolCalls) == 0 && len(toolparse.ExtractAll(assistant)) == 0 {
			return nudgeAnswer, working[:nudgeAt], nil
		}

		if len(res.ToolCalls) > 0 {
			emptyRetries, stalled, usedTools = 0, 0, true
			calls := make([]toolparse.Call, len(res.ToolCalls))
			signatures := make([]string, len(res.ToolCalls))
			for i, raw := range res.ToolCalls {
				var call map[string]any
				_ = json.Unmarshal(raw, &call)
				calls[i] = toolparse.Native(call)
				signatures[i] = CallSignature(calls[i].Tool, calls[i].Args)
			}
			signature := strings.Join(signatures, "|")
			if signature == lastSignature && !repeatable(callTools(calls)) {
				repeated++
			} else {
				repeated = 0
			}
			lastSignature = signature
			looping := repeated >= MaxRepeatedCalls
			working = append(working, history.Message{Role: "assistant", Content: assistant, ToolCalls: res.ToolCalls, Thinking: res.Reasoning})
			skipped := 0
			for i, call := range calls {
				result, skip, err := t.attempt(ctx, g, call.Tool, call.Args, signatures[i], looping)
				if err != nil {
					return "", working, err
				}
				if skip {
					skipped++
				}
				var meta struct {
					ID string `json:"id"`
				}
				_ = json.Unmarshal(res.ToolCalls[i], &meta)
				working = append(working, history.Message{
					Role: "tool",
					// Al modelo le va una versión acotada del resultado; el
					// usuario ha visto la salida completa en pantalla.
					Content:    history.ClipToolOutput(result, history.MaxToolOutputChars),
					ToolCallID: meta.ID,
					Name:       call.Tool,
				})
			}
			collapseOldSnapshots(working)
			if images := s.popToolImages(); len(images) > 0 {
				dropOldImages(working, maxLiveImageGroups-1)
				working = append(working, history.Message{Role: "user", Content: ToolImagesPrompt, Images: images})
			}
			if g.step(len(calls), skipped) {
				return t.wrapUp(ctx, working, repeatedMessage)
			}
			continue
		}

		toolCalls := toolparse.ExtractAll(assistant)

		if len(toolCalls) == 0 && textutil.Strip(assistant) == "" {
			// Sin texto y sin llamadas: antes de darlo por perdido hay que mirar el
			// razonamiento, donde los modelos thinking suelen dejar la llamada.
			reasoning := res.Reasoning
			if rescued := toolparse.ExtractAll(reasoning); len(rescued) > 0 {
				toolCalls = rescued
				lines := make([]string, len(rescued))
				for i, c := range rescued {
					raw, _ := json.Marshal(struct {
						Tool string         `json:"tool"`
						Args map[string]any `json:"args"`
					}{c.Tool, c.Args})
					lines[i] = string(raw)
				}
				// El historial guarda la llamada rescatada, no un turno vacío:
				// el modelo tiene que ver lo que pidió para leer bien el resultado.
				assistant = strings.Join(lines, "\n")
				t.emit(Event{Kind: EventRescued, Text: "llamada recuperada del razonamiento"})
			} else if textutil.Strip(reasoning) != "" {
				// Se quedó pensando sin responder: se repite el paso tal cual
				// pero sin razonar, sin meterle prisa con un mensaje. Si vuelve
				// a pasar, responde con lo que ya tiene.
				if stalled++; stalled > 1 {
					return t.wrapUp(ctx, working, stalledMessage)
				}
				next.NoThinking = true
				continue
			} else if emptyRetries < maxEmptyRetries {
				emptyRetries++
				// Nada en absoluto: huele a ventana desbordada. Se recorta lo
				// que se ENVÍA, no el historial del usuario, y sin anunciarlo.
				working = history.ShrinkOldResults(working, 2, history.MaxOldToolOutputChar)
				continue
			} else {
				return "", working, &Stopped{Reason: noAnswerMessage}
			}
		}
		emptyRetries, stalled = 0, 0

		working = append(working, history.Assistant(assistant))

		if len(toolCalls) == 0 {
			if !nudged && toolparse.HasUnclosed(assistant) {
				nudged = true
				working = append(working, history.User(TruncatedPrompt))
				continue
			}
			// Solo si respondió pegando código sin haber tocado nada: un árbol de
			// carpetas o una salida en un bloque no es código por aplicar.
			if !nudged && !usedTools && pastesCode(assistant) {
				nudged = true
				prompt := NudgePrompt
				if native {
					prompt = NativeNudgePrompt
				}
				nudgeAt, nudgeAnswer = len(working), assistant
				working = append(working, history.User(prompt))
				next.Quiet = true
				continue
			}
			return assistant, working, nil
		}
		usedTools = true
		if native {
			s.TextCalls = true
		}

		signatures := make([]string, len(toolCalls))
		for i, c := range toolCalls {
			signatures[i] = CallSignature(c.Tool, c.Args)
		}
		signature := strings.Join(signatures, "|")
		if signature == lastSignature && !repeatable(callTools(toolCalls)) {
			repeated++
		} else {
			repeated = 0
		}
		lastSignature = signature
		looping := repeated >= MaxRepeatedCalls

		var combined []string
		skipped := 0
		for _, group := range groupReads(toolCalls) {
			var results []string
			if len(group) > 1 && !looping && !g.anyDropped(group) {
				results = t.runReadGroup(ctx, group)
			} else {
				for _, call := range group {
					result, skip, err := t.attempt(ctx, g, call.Tool, call.Args, CallSignature(call.Tool, call.Args), looping)
					if err != nil {
						return "", working, err
					}
					if skip {
						skipped++
					}
					results = append(results, result)
				}
			}
			if err := ctx.Err(); err != nil {
				return "", working, err
			}
			for i, call := range group {
				combined = append(combined, fmt.Sprintf("TOOL_RESULT %s: %s", call.Tool,
					history.ClipToolOutput(results[i], history.MaxToolOutputChars)))
			}
		}
		results := history.User(strings.Join(combined, "\n"))
		if results.Images = s.popToolImages(); len(results.Images) > 0 {
			dropOldImages(working, maxLiveImageGroups-1)
		}
		working = append(working, results)
		collapseOldSnapshots(working)
		if g.step(len(toolCalls), skipped) {
			return t.wrapUp(ctx, working, repeatedMessage)
		}
	}
}

// pastesCode dice si la respuesta trae código que parece para un archivo:
// un bloque con lenguaje de programación, o sin lenguaje pero con sintaxis.
func pastesCode(text string) bool {
	parts := strings.Split(text, fence)
	for i := 1; i < len(parts); i += 2 {
		lang, body, _ := strings.Cut(parts[i], "\n")
		switch strings.ToLower(strings.TrimSpace(lang)) {
		case "text", "txt", "plaintext", "plain", "output", "console", "log", "tree", "md", "markdown", "diff":
			continue
		case "":
			if strings.ContainsAny(body, "{;") || strings.Contains(body, "</") ||
				strings.Contains(body, "def ") || strings.Contains(body, "import ") || strings.Contains(body, "=>") {
				return true
			}
		default:
			return true
		}
	}
	return false
}

// wrapUp cierra un turno atascado (se repite o no llega a responder): le pide
// al modelo, sin herramientas ni razonamiento, que conteste con lo que ya sabe.
// fallback es lo que se dice si tampoco así responde.
// Stopped corta el turno sin respuesta del modelo. Lo dice el CLI, no el
// modelo, así que va como error; el trabajo hecho sigue en el historial.
type Stopped struct{ Reason string }

func (e *Stopped) Error() string { return e.Reason }

func (t *Turn) wrapUp(ctx context.Context, working []history.Message, reason string) (string, []history.Message, error) {
	system := history.Message{Role: "system", Content: "Eres un agente de código. Ya no quedan herramientas en este turno: " +
		"responde al usuario con lo que ya sabes por los resultados anteriores, o dile qué te falta para seguir.\n\n" + StylePrompt}
	est := t.S.Estimator
	if est == nil {
		est = &history.Estimator{}
	}
	window := t.S.ContextWindow
	if window == 0 {
		window = 8192
	}
	body, _ := est.FitHistory(PlainHistory(working), est.PromptBudget(window, nil, est.EstimateTokens([]history.Message{system})), history.KeepRecent)
	res, err := t.Stream(WithStep(ctx, StepOptions{NoThinking: true}), append([]history.Message{system}, body...), nil)
	if err != nil {
		if ctx.Err() != nil {
			return "", working, ctx.Err()
		}
		return "", working, &Stopped{Reason: reason}
	}
	answer := toolparse.CleanProse(toolparse.TruncateFabricated(res.Text))
	if answer == "" {
		return "", working, &Stopped{Reason: reason}
	}
	return answer, working, nil
}

// PlainHistory pasa el historial a texto: los resultados de las herramientas
// como TOOL_RESULT y sin las llamadas, para pedir una respuesta sin tools.
func PlainHistory(messages []history.Message) []history.Message {
	var out []history.Message
	for _, m := range messages {
		switch {
		case m.Role == "tool":
			out = append(out, history.User(fmt.Sprintf("TOOL_RESULT %s: %s", m.Name, m.Content)))
		case len(m.ToolCalls) > 0:
			if textutil.Strip(m.Content) != "" {
				out = append(out, history.Assistant(m.Content))
			}
		default:
			m.Thinking = ""
			out = append(out, m)
		}
	}
	return out
}

func callTools(calls []toolparse.Call) []string {
	names := make([]string, len(calls))
	for i, c := range calls {
		names[i] = c.Tool
	}
	return names
}

// groupReads junta las lecturas seguidas: tres read_file de golpe se cuentan
// como una sola acción.
func groupReads(calls []toolparse.Call) [][]toolparse.Call {
	var groups [][]toolparse.Call
	for _, c := range calls {
		if n := len(groups); n > 0 && c.Tool == "read_file" && groups[n-1][0].Tool == "read_file" {
			groups[n-1] = append(groups[n-1], c)
			continue
		}
		groups = append(groups, []toolparse.Call{c})
	}
	return groups
}

func (t *Turn) execute(ctx context.Context, tool string, args map[string]any) (result string, failed bool, elapsed time.Duration) {
	started := time.Now()
	result = t.S.Tools.Execute(ctx, tool, args)
	return result, tools.Failed(result), time.Since(started)
}

func (t *Turn) runReadGroup(ctx context.Context, calls []toolparse.Call) []string {
	results := make([]string, len(calls))
	var names []string
	lines := 0
	for i, call := range calls {
		label := "."
		if truthy(call.Args["path"]) {
			label = pyStr(call.Args["path"])
		}
		result, failed, _ := t.execute(ctx, "read_file", call.Args)
		t.stashImage("read_file", call.Args, failed)
		t.S.Stats.Actions++
		results[i] = result
		if failed {
			t.emit(Event{Kind: EventAction, Tool: "read_file", Text: label, ReadOnly: true})
			t.emit(Event{Kind: EventActionResult, Tool: "read_file", Summary: textutil.Head(firstLine(result), 120), Failed: true})
			continue
		}
		names = append(names, label[strings.LastIndex(label, "/")+1:])
		lines += strings.Count(result, "\n") + 1
	}
	if len(names) > 0 {
		t.emit(Event{Kind: EventReadGroup, Tool: "read_file", Text: fmt.Sprintf("%d archivos", len(names)),
			Meta: fmt.Sprintf("%d líneas", lines), Names: names, Lines: lines})
	}
	return results
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	return line
}

// stashImage guarda la imagen que devolvió un read_file: no cabe en un
// resultado de texto, así que se adjunta al modelo tras el resultado.
func (t *Turn) stashImage(tool string, args map[string]any, failed bool) {
	if tool != "read_file" || failed {
		return
	}
	target, _, err := tools.ResolveSafe(t.S.Workspace, stringArg(args, "path"))
	if err != nil {
		return
	}
	switch strings.ToLower(filepath.Ext(target)) {
	case ".png", ".jpg", ".jpeg", ".webp":
	default:
		return
	}
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxImageBytes {
		return
	}
	if data, err := os.ReadFile(target); err == nil {
		t.S.pendingImages = append(t.S.pendingImages, base64.StdEncoding.EncodeToString(data))
	}
}

func readMeta(tool, result string) string {
	lines := 0
	if result != "" {
		lines = strings.Count(result, "\n") + 1
	}
	plural := func(n int, one, many string) string {
		if n == 1 {
			return fmt.Sprintf("%d %s", n, one)
		}
		return fmt.Sprintf("%d %s", n, many)
	}
	switch tool {
	case "read_file":
		return fmt.Sprintf("%d líneas", lines)
	case "search":
		return plural(lines, "coincidencia", "coincidencias")
	case "list_files", "find_files":
		return plural(lines, "entrada", "entradas")
	case "outline":
		n := max(0, lines-1)
		if lines == 2 {
			return fmt.Sprintf("%d símbolo", n)
		}
		return fmt.Sprintf("%d símbolos", n)
	case "web_search":
		n := 0
		for _, line := range strings.Split(result, "\n") {
			if i := strings.Index(line, ". "); i > 0 && allDigits(line[:i]) {
				n++
			}
		}
		return plural(n, "resultado", "resultados")
	case "fetch_url":
		if n := len([]rune(result)); n >= 1000 {
			return fmt.Sprintf("%d k caracteres", n/1000)
		} else {
			return fmt.Sprintf("%d caracteres", n)
		}
	}
	return ""
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

func (t *Turn) approve(ctx context.Context, a Approval) (Decision, error) {
	if t.S.Approver == nil {
		return Deny, nil
	}
	return t.S.Approver.Approve(ctx, a)
}

// approveAndRun aplica la política de aprobación y ejecuta la herramienta.
func (t *Turn) approveAndRun(ctx context.Context, tool string, args map[string]any) (string, error) {
	s := t.S
	switch tool {
	case "todo":
		s.Stats.Actions++
		return s.Tools.Execute(ctx, tool, args), nil
	case "ask_user":
		t.emit(Event{Kind: EventAction, Tool: tool, Text: textutil.Head(tools.AskSummary(args), 100), ReadOnly: true})
		s.Stats.Actions++
		return s.Tools.Execute(ctx, tool, args), nil
	case "show_image":
		// Va en su propia fila, no plegada con las lecturas: es para el usuario.
		t.emit(Event{Kind: EventAction, Tool: tool, Text: textutil.Head(pyStr(args["path"]), 200)})
		result, failed, elapsed := t.execute(ctx, tool, args)
		s.Stats.Actions++
		t.emit(Event{Kind: EventActionResult, Tool: tool, Result: result, Summary: textutil.Head(firstLine(result), 120),
			Failed: failed, Elapsed: elapsed})
		return result, nil
	case MCPToolsTool:
		return t.loadMCPServer(args), nil
	}
	if s.MCP != nil && s.MCP.IsMCPTool(tool) {
		return t.runMCP(ctx, tool, args)
	}
	if toolspec.IsBrowser(tool) {
		return t.runBrowser(ctx, tool, args)
	}
	if s.PlanMode && !toolspec.IsReadOnly(tool) {
		t.emit(Event{Kind: EventAction, Tool: tool, Text: ArgsSummary(tool, args)})
		t.emit(Event{Kind: EventActionResult, Tool: tool, Summary: "bloqueado: modo plan", Failed: true})
		return planBlockedMessage, nil
	}
	if tool == "fetch_url" {
		return t.Fetch(ctx, args)
	}
	if toolspec.IsReadOnly(tool) {
		label := "."
		for _, key := range []string{"path", "pattern", "query", "url"} {
			if truthy(args[key]) {
				label = pyStr(args[key])
				break
			}
		}
		result, failed, _ := t.execute(ctx, tool, args)
		if err := ctx.Err(); err != nil {
			return "", err
		}
		t.stashImage(tool, args, failed)
		s.Stats.Actions++
		meta := ""
		if !failed {
			meta = readMeta(tool, result)
		}
		t.emit(Event{Kind: EventAction, Tool: tool, Text: label, ReadOnly: true, Meta: meta, Result: result})
		if failed {
			t.emit(Event{Kind: EventActionResult, Tool: tool, Summary: textutil.Head(firstLine(result), 120), Failed: true})
		}
		return result, nil
	}

	change := ComputeChange(s.Workspace, tool, args)
	adds, dels := 0, 0
	if change != nil && change.Kind != "command" && change.Kind != "rename" && change.Kind != "mkdir" {
		adds, dels = DiffCounts(*change)
	}
	t.emit(Event{Kind: EventAction, Tool: tool, Text: ArgsSummary(tool, args), Change: change, Adds: adds, Dels: dels})

	// Los comandos de shell son irreversibles (no hay snapshot que los
	// deshaga): tienen su propio flag y NO los cubre auto_approve. Responder
	// «siempre» tras una edición no habilita ejecutar comandos.
	if tool == "run_command" {
		command := stringArg(args, "command")
		if !s.AutoRunCommands && !CommandAllowed(command, s.AllowedCommands) && !s.OrchInfo().IsLxoCommand(command) {
			prefix := CommandPrefix(command)
			decision, err := t.approve(ctx, Approval{Kind: ApproveCommand, Tool: tool, Summary: ArgsSummary(tool, args), Prefix: prefix, Change: change})
			if err != nil {
				return "", err
			}
			switch decision {
			case AllowAlways:
				s.AutoRunCommands = true
			case AllowPrefix:
				s.AllowedCommands = append(s.AllowedCommands, prefix)
				if s.OnAllowedCommands != nil {
					s.OnAllowedCommands(s.AllowedCommands)
				}
			case Deny:
				t.emit(Event{Kind: EventActionResult, Tool: tool, Summary: "rechazado por el usuario", Failed: true})
				return cancelledMessage, nil
			}
		}
	} else if !s.AutoApprove {
		detail := ArgsSummary(tool, args)
		if change != nil {
			detail = change.Path
		}
		if adds != 0 || dels != 0 {
			detail = fmt.Sprintf("%s · +%d -%d", detail, adds, dels)
		}
		decision, err := t.approve(ctx, Approval{Kind: ApproveEdit, Tool: tool, Summary: ArgsSummary(tool, args), Detail: detail, Change: change})
		if err != nil {
			return "", err
		}
		switch decision {
		case AllowAlways:
			s.AutoApprove = true
		case Deny:
			t.emit(Event{Kind: EventActionResult, Tool: tool, Summary: "rechazado por el usuario", Failed: true})
			return cancelledMessage, nil
		}
	}

	s.Stats.Actions++
	if change != nil && change.Kind != "command" {
		if s.Stats.Files == nil {
			s.Stats.Files = map[string]bool{}
		}
		if tool == "delete_file" {
			for _, p := range tools.DeletePaths(args) {
				s.Stats.Files[p] = true
			}
		} else {
			s.Stats.Files[change.Path] = true
		}
		s.Stats.Adds += adds
		s.Stats.Dels += dels
	}
	s.SnapshotBefore(tool, args)
	return t.run(ctx, tool, args)
}

// run ejecuta una acción que modifica y la cierra con un evento de resultado:
// lo que pasó, la verificación del archivo y el tiempo.
func (t *Turn) run(ctx context.Context, tool string, args map[string]any) (string, error) {
	result, failed, elapsed := t.execute(ctx, tool, args)
	if err := ctx.Err(); err != nil {
		return "", err
	}
	check, checkFailed := "", false
	if t.S.AutoCheck {
		checker, errs, extended := VerifyAfter(ctx, t.S.Workspace, tool, args, result)
		result = extended
		if checker != "" {
			detail := "sin errores"
			if errs != "" {
				detail = textutil.Head(textutil.Strip(firstLine(errs)), 110)
			}
			check = checker + ": " + detail
			checkFailed = errs != ""
		}
	}
	t.emit(Event{Kind: EventActionResult, Tool: tool, Result: result, Summary: ResultSummary(result),
		Check: check, Failed: failed || checkFailed, Elapsed: elapsed})
	return result, nil
}

// Fetch abre la descarga antes de hacerla, para que se vea en marcha, y la
// cierra con lo recibido y el estado HTTP. El modo ask la usa también.
func (t *Turn) Fetch(ctx context.Context, args map[string]any) (string, error) {
	t.emit(Event{Kind: EventAction, Tool: "fetch_url", Text: textutil.Head(stringArg(args, "url"), 200)})
	result, failed, elapsed := t.execute(ctx, "fetch_url", args)
	if err := ctx.Err(); err != nil {
		return "", err
	}
	t.S.Stats.Actions++
	summary := textutil.Head(strings.TrimSpace(strings.TrimPrefix(firstLine(result), "[ERROR]")), 120)
	if info, ok := t.S.Tools.TakeFetch(); ok && info.Status > 0 {
		summary = info.Summary()
	}
	t.emit(Event{Kind: EventActionResult, Tool: "fetch_url", Result: result, Summary: summary, Failed: failed, Elapsed: elapsed})
	return result, nil
}

// AskTools son las herramientas del modo ask: ver el proyecto e internet y
// preguntar, nunca cambiar nada. En el navegador abre y lee, sin clics.
var AskTools = []string{"list_files", "find_files", "read_file", "outline", "search", "web_search", "fetch_url", "ask_user", "show_image",
	"browser_navigate", "browser_snapshot", "browser_get_text", "browser_screenshot", "browser_scroll", "browser_back",
	"browser_tabs", "browser_wait", "browser_viewport"}

const askBlockedMessage = "[modo ask] Solo puedes leer el proyecto, buscar en internet y preguntar. Para cambiar " +
	"archivos o ejecutar comandos, explica qué harías y pide al usuario que pase al modo agent (/mode agent o Mayús+Tab)."

// RunReadOnly ejecuta una herramienta del modo ask; cualquier otra se rechaza
// sin tocar nada. Devuelve también las imágenes que haya adjuntado read_file.
func (t *Turn) RunReadOnly(ctx context.Context, tool string, args map[string]any) (string, []string, error) {
	if !slices.Contains(AskTools, tool) || !t.S.ToolAllowed(tool) {
		t.emit(Event{Kind: EventAction, Tool: tool, Text: ArgsSummary(tool, args)})
		t.emit(Event{Kind: EventActionResult, Tool: tool, Summary: "bloqueado: modo ask", Failed: true})
		return askBlockedMessage, nil, nil
	}
	t.readOnly = true
	result, err := t.approveAndRun(ctx, tool, args)
	return result, t.S.popToolImages(), err
}

// runMCP: una herramienta MCP no es del CLI y no se sabe si escribe o solo
// lee, así que pide aprobación como una escritura (salvo auto-aprobar).
func (t *Turn) runMCP(ctx context.Context, tool string, args map[string]any) (string, error) {
	s := t.S
	raw, _ := json.Marshal(args)
	summary := textutil.Head(string(raw), 160)
	label := strings.Replace(strings.Replace(tool, "mcp__", "", 1), "__", " › ", 1)
	t.emit(Event{Kind: EventAction, Tool: "MCP", Text: label + "  " + summary})
	if s.PlanMode {
		t.emit(Event{Kind: EventActionResult, Tool: tool, Summary: "bloqueado: modo plan", Failed: true})
		return planBlockedMCPMessage, nil
	}
	if !s.AutoApprove {
		decision, err := t.approve(ctx, Approval{Kind: ApproveMCP, Tool: tool, Summary: summary, Detail: label})
		if err != nil {
			return "", err
		}
		switch decision {
		case AllowAlways:
			s.AutoApprove = true
		case Deny:
			t.emit(Event{Kind: EventActionResult, Tool: tool, Summary: "rechazado por el usuario", Failed: true})
			return cancelledMessage, nil
		}
	}
	s.Stats.Actions++
	started := time.Now()
	result := s.MCP.Call(ctx, tool, args)
	if err := ctx.Err(); err != nil {
		return "", err
	}
	t.emit(Event{Kind: EventActionResult, Tool: tool, Result: result,
		Summary: textutil.Head(firstLine(result), 120), Failed: strings.HasPrefix(result, "[ERROR]"),
		Elapsed: time.Since(started)})
	return result, nil
}
