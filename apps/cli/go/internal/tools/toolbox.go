package tools

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"lixbon.com/cli/internal/process"
	"lixbon.com/cli/internal/textutil"
)

const (
	defaultCommandTimeout = 30
	maxWait               = 60
)

// WebSearcher es el buscador del gateway (api.Client lo implementa).
type WebSearcher interface {
	WebSearch(ctx context.Context, query string, limit int) ([]map[string]any, error)
}

type TodoItem struct {
	Text   string
	Status string
}

// Toolbox reúne las herramientas con estado (procesos en segundo plano, lista
// de pasos) y sus dependencias. Un Toolbox por sesión; se usa de forma
// secuencial, como el bucle del agente.
type Toolbox struct {
	Root  string
	Procs *process.Manager
	Web   WebSearcher
	HTTP  *http.Client

	// AskUser abre la pregunta al usuario; nil si la sesión no es interactiva.
	AskUser func(ctx context.Context, question string, options []string) (answer string, ok bool)
	// Remote desactiva ask_user cuando conduce el móvil.
	Remote bool
	// OnTodo avisa a la interfaz de que la lista de pasos cambió.
	OnTodo func(items, previous []TodoItem)

	todo []TodoItem
}

func NewToolbox(root string) *Toolbox {
	return &Toolbox{Root: root, Procs: process.NewManager()}
}

// Close termina los procesos en segundo plano.
func (tb *Toolbox) Close() { tb.Procs.StopAll() }

// Execute despacha cualquier herramienta del catálogo. Los fallos llegan como
// texto "[ERROR] …".
func (tb *Toolbox) Execute(ctx context.Context, name string, args map[string]any) string {
	result, err := tb.dispatch(ctx, name, args)
	if err != nil {
		return "[ERROR] " + err.Error()
	}
	return result
}

func (tb *Toolbox) dispatch(ctx context.Context, name string, args map[string]any) (string, error) {
	switch name {
	case "run_command":
		command, err := textArg(args, "command", "")
		if err != nil {
			return "", err
		}
		if truthy(args["background"]) {
			return tb.runBackground(ctx, command)
		}
		timeout, err := intArg(args, "timeout")
		if err != nil {
			return "", err
		}
		return tb.runCommand(ctx, command, timeout)
	case "read_output":
		id, err := textArg(args, "id", "")
		if err != nil {
			return "", err
		}
		wait, err := intArg(args, "wait")
		if err != nil {
			return "", err
		}
		return tb.readOutput(ctx, id, wait)
	case "stop_command":
		id, err := textArg(args, "id", "")
		if err != nil {
			return "", err
		}
		return tb.stopCommand(id)
	case "fetch_url":
		url, err := textArg(args, "url", "")
		if err != nil {
			return "", err
		}
		return tb.fetchURL(ctx, url)
	case "web_search":
		query, err := textArg(args, "query", "")
		if err != nil {
			return "", err
		}
		limit, err := intArg(args, "limit")
		if err != nil {
			return "", err
		}
		return tb.webSearch(ctx, query, limit)
	case "todo":
		return tb.updateTodo(args["items"]), nil
	case "ask_user":
		question, _ := textArg(args, "question", "")
		return tb.askUser(ctx, question, args["options"]), nil
	}
	return dispatch(ctx, tb.Root, name, args)
}

func (tb *Toolbox) runCommand(ctx context.Context, command string, timeoutArg int) (string, error) {
	if textutil.Strip(command) == "" {
		return "[ERROR] Falta command", nil
	}
	timeout := defaultCommandTimeout
	if timeoutArg != 0 {
		timeout = timeoutArg
	}
	timeout = max(1, min(timeout, process.MaxTimeout))
	res, err := process.Run(ctx, realPath(tb.Root), command, time.Duration(timeout)*time.Second)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "[ERROR] " + err.Error(), nil
	}
	if res.TimedOut {
		out := fmt.Sprintf("[TIMEOUT] El comando superó %ds y se mató (con sus procesos hijos).", timeout)
		if res.Output != "" {
			out += "\nÚltima salida:\n" + res.Output
		}
		return out, nil
	}
	output := res.Output
	if output == "" {
		output = "(sin salida)"
	}
	return fmt.Sprintf("[EXIT %d] %s", res.ExitCode, output), nil
}

func (tb *Toolbox) runBackground(ctx context.Context, command string) (string, error) {
	if textutil.Strip(command) == "" {
		return "[ERROR] Falta command", nil
	}
	bg, err := tb.Procs.Start(realPath(tb.Root), command)
	if err != nil {
		return "[ERROR] " + err.Error(), nil
	}
	// Un fallo inmediato (comando inexistente) se ve ya en la primera lectura.
	bg.Wait(ctx, time.Second)
	state := "en marcha"
	if !bg.Alive() {
		state = fmt.Sprintf("terminó con código %d", bg.ExitCode())
	}
	out := fmt.Sprintf("[background %s] %s", bg.ID, state)
	if fresh := bg.ReadNew(); fresh != "" {
		out += "\n" + fresh
	}
	return out, nil
}

func (tb *Toolbox) readOutput(ctx context.Context, id string, wait int) (string, error) {
	bg, ok := tb.Procs.Get(id)
	if !ok {
		active := strings.Join(tb.Procs.IDs(), ", ")
		if active == "" {
			active = "ninguno"
		}
		return fmt.Sprintf("[ERROR] No hay ningún proceso %s; los activos: %s", id, active), nil
	}
	if wait = max(0, min(wait, maxWait)); wait > 0 {
		bg.Wait(ctx, time.Duration(wait)*time.Second)
	}
	fresh := process.Trim(bg.ReadNew())
	state := "sigue en marcha"
	if !bg.Alive() {
		state = fmt.Sprintf("terminó con código %d", bg.ExitCode())
	}
	if fresh == "" {
		fresh = "(sin salida nueva)"
	}
	return fmt.Sprintf("[%s] %s\n%s", id, state, fresh), nil
}

func (tb *Toolbox) stopCommand(id string) (string, error) {
	command, err := tb.Procs.Stop(id)
	if err != nil {
		return fmt.Sprintf("[ERROR] No hay ningún proceso %s", id), nil
	}
	return fmt.Sprintf("[%s] detenido (%s)", id, textutil.Head(command, 80)), nil
}

func (tb *Toolbox) updateTodo(items any) string {
	list, ok := items.([]any)
	if !ok {
		return "[ERROR] items debe ser una lista de {text, status}"
	}
	var clean []TodoItem
	for _, raw := range list[:min(len(list), 30)] {
		var text, status string
		switch it := raw.(type) {
		case string:
			text, status = it, "pending"
		case map[string]any:
			text = pyStr(it["text"])
			status = "pending"
			if s, present := it["status"]; present {
				status = strings.ToLower(pyStr(s))
			}
		default:
			continue
		}
		if textutil.Strip(text) == "" {
			continue
		}
		if status != "pending" && status != "doing" && status != "done" {
			status = "pending"
		}
		clean = append(clean, TodoItem{Text: textutil.Head(textutil.Strip(text), 200), Status: status})
	}
	previous := tb.todo
	tb.todo = clean
	if tb.OnTodo != nil {
		tb.OnTodo(clean, previous)
	}
	done := 0
	lines := make([]string, len(clean))
	for i, it := range clean {
		if it.Status == "done" {
			done++
		}
		lines[i] = fmt.Sprintf("[%s] %s", it.Status, it.Text)
	}
	return fmt.Sprintf("Lista actualizada: %d/%d hechos.\n%s", done, len(clean), strings.Join(lines, "\n"))
}

func (tb *Toolbox) askUser(ctx context.Context, question string, options any) string {
	if tb.AskUser == nil || tb.Remote {
		return "[ask_user no disponible en esta sesión] Termina el turno formulando la pregunta al " +
			"usuario en tu respuesta y espera su mensaje."
	}
	question = textutil.Strip(question)
	if question == "" {
		return "[ERROR] Falta question"
	}
	var choices []string
	if list, ok := options.([]any); ok {
		for _, o := range list {
			if text := textutil.Strip(pyStr(o)); text != "" {
				choices = append(choices, text)
			}
		}
	}
	if len(choices) > 6 {
		choices = choices[:6]
	}
	answer, ok := tb.AskUser(ctx, question, choices)
	if !ok {
		return "El usuario no respondió (canceló). Sigue con tu mejor criterio o termina el turno."
	}
	return "Respuesta del usuario: " + answer
}
