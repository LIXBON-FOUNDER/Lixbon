package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"lixbon.com/cli/internal/events"
)

const eventsUsage = `Uso: lixbon events [--after SEQ] [--limit N] [filtros] [--json] [--follow]

Lee el Event Log durable del Core de Lixbon Desktop (GET /events, contrato v=1)
sin tocar su base de datos. Sin argumentos muestra la primera página (100).
Necesita Lixbon Desktop abierto y LXO_TASK_ID: el Core limita a un agente a los
eventos de su run.

Paginación:
  --after SEQ        cursor exclusivo: solo eventos con seq > SEQ (el cursor es el seq decimal). Defecto 0
  --limit N          eventos por página (defecto 100; el Core recorta a 500)
  Con más páginas, stderr sugiere --after <next_cursor>; con --json ese valor es "next_cursor".

Filtros (los que admite el Core, se combinan con AND):
  --project ID       --run ID           --class state|effect|decision|system
  --entity-kind K    --entity-id ID     (entity-id exige entity-kind: task, run, project, spawn_request, core)
  --kind K           --kind-prefix P    (incompatibles entre sí; el prefijo es literal)

Salida:
  (por defecto)      una línea por evento: seq, hora UTC, kind, entidad, actor, run y proyecto
  --json             sin --follow, el documento "data" del Core tal cual (una línea); con --follow, un evento por línea (NDJSON)
  Los avisos y errores van a stderr; stdout solo lleva eventos.

Seguimiento:
  --follow           sigue el log con sondeo por cursor (el Core aún no ofrece stream). Sin esperar
                     mientras haya más páginas; al llegar al final espera 0,5 s y, si siguen vacías,
                     1 s y 2 s (máximo). Cada cursor confirmado se guarda en ~/.lixbon/events/ y la
                     siguiente ejecución con los mismos filtros continúa desde ahí; --after manda sobre
                     el guardado. Un cursor guardado que el Core ya no reconoce reinicia en 0.
  --max-outage D     cuánto reintentar si el Core no responde, con espera de 1 s a 8 s y releyendo el
                     puerto y el token de Lixbon Desktop (defecto 60s; 0 = no reintentar)
  Ctrl+C termina limpiamente con código 0.

Códigos de salida:
  0 correcto       1 error interno o Event Log no disponible   2 uso o filtro inválido
  3 autenticación o identidad   4 versión o contrato incompatible   5 red o Lixbon Desktop cerrado
  6 cursor inválido o adelantado al Core   130 interrumpido sin --follow
`

type eventsOptions struct {
	json     bool
	follow   bool
	explicit bool
	outage   time.Duration
	query    events.Query
}

func (a *App) events(ctx context.Context, args []string) int {
	if slices.ContainsFunc(args, func(arg string) bool { return arg == "-h" || arg == "--help" || arg == "-help" }) {
		fmt.Fprint(a.Stdout, eventsUsage)
		return 0
	}
	taskID := os.Getenv(envTaskID)
	opts, code, stop := a.parseEvents(args)
	if stop {
		return code
	}
	dir := filepath.Dir(a.ConfigPath)
	client := &events.Client{Dir: dir, TaskID: taskID}
	fail := func(err error) int { return a.eventsFailure(ctx, err, opts.json, taskID, opts.follow) }

	if !opts.follow {
		page, err := client.Fetch(ctx, opts.query)
		if err != nil {
			return fail(err)
		}
		return a.printEventsPage(page, opts, fail)
	}

	follower := &events.Follower{
		Fetcher:   client,
		Store:     events.FileStore{Path: events.StorePath(filepath.Join(dir, "events"), taskID, opts.query.Params)},
		MaxOutage: opts.outage,
		Notify:    func(format string, args ...any) { fmt.Fprintf(a.Stderr, format+"\n", args...) },
		Emit:      func(raw json.RawMessage) error { return a.printEvent(raw, opts.json) },
	}
	if err := follower.Run(ctx, opts.query, opts.explicit); err != nil {
		return fail(err)
	}
	fmt.Fprintln(a.Stderr, "— interrumpido —")
	return events.ExitOK
}

func (a *App) parseEvents(args []string) (opts eventsOptions, code int, stop bool) {
	fs := a.flagSet("events")
	fs.Usage = func() { fmt.Fprint(a.Stderr, eventsUsage) }
	after := fs.String("after", "", "")
	fs.BoolVar(&opts.json, "json", false, "")
	fs.BoolVar(&opts.follow, "follow", false, "")
	fs.DurationVar(&opts.outage, "max-outage", events.DefaultOutage, "")
	for _, name := range []string{"limit", "project", "run", "entity-kind", "entity-id", "kind", "kind-prefix", "class"} {
		fs.String(name, "", "")
	}
	if code, stop := parseFlags(fs, args); stop {
		return opts, code, true
	}
	if fs.NArg() > 0 {
		a.printError(fmt.Sprintf("events no admite argumentos sueltos (%q): mira lixbon events --help", fs.Arg(0)))
		return opts, events.ExitUsage, true
	}
	if opts.outage < 0 {
		a.printError("--max-outage no puede ser negativo")
		return opts, events.ExitUsage, true
	}
	opts.query.Params = map[string]string{}
	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "after":
			opts.explicit = true
		case "json", "follow", "max-outage":
		default:
			opts.query.Params[strings.ReplaceAll(f.Name, "-", "_")] = f.Value.String()
		}
	})
	if opts.explicit {
		cursor, err := events.ParseCursor(*after)
		if err != nil {
			return opts, a.eventsFailure(context.Background(), err, opts.json, "", false), true
		}
		opts.query.Cursor = cursor
	}
	return opts, 0, false
}

func (a *App) printEventsPage(page *events.Page, opts eventsOptions, fail func(error) int) int {
	var out bytes.Buffer
	if opts.json {
		data, err := events.CompactJSON(page.Data)
		if err != nil {
			return fail(err)
		}
		out.Write(data)
		out.WriteByte('\n')
	} else {
		for _, raw := range page.Events {
			line, err := events.HumanLine(raw)
			if err != nil {
				return fail(&events.Error{Kind: events.KindVersion, Code: "contract", Message: "contrato roto: evento ilegible: " + err.Error()})
			}
			out.WriteString(line + "\n")
		}
	}
	if _, err := a.Stdout.Write(out.Bytes()); err != nil {
		return fail(err)
	}
	if !opts.json {
		switch {
		case len(page.Events) == 0:
			fmt.Fprintf(a.Stderr, "Sin eventos después del cursor %d (head_seq=%d).\n", opts.query.Cursor, page.HeadSeq)
		case page.HasMore:
			fmt.Fprintf(a.Stderr, "Hay más eventos: repite con --after %d (head_seq=%d).\n", page.NextCursor, page.HeadSeq)
		}
	}
	return events.ExitOK
}

func (a *App) printEvent(raw json.RawMessage, asJSON bool) error {
	var line string
	if asJSON {
		data, err := events.CompactJSON(raw)
		if err != nil {
			return err
		}
		line = string(data)
	} else {
		var err error
		if line, err = events.HumanLine(raw); err != nil {
			return err
		}
	}
	_, err := fmt.Fprintln(a.Stdout, line)
	return err
}

func (a *App) eventsFailure(ctx context.Context, err error, asJSON bool, taskID string, follow bool) int {
	if ctx.Err() != nil && !follow {
		fmt.Fprintln(a.Stderr, "— interrumpido —")
		return events.ExitInterrupted
	}
	var apiErr *events.Error
	if !errors.As(err, &apiErr) {
		apiErr = &events.Error{Kind: events.KindInternal, Code: "internal", Message: err.Error()}
	}
	message := apiErr.Message
	if apiErr.Kind == events.KindAuth && taskID == "" {
		message += " (lixbon events necesita LXO_TASK_ID: solo funciona dentro de una tarea del orquestador)"
	}
	if asJSON {
		raw, _ := json.Marshal(map[string]any{"ok": false, "code": apiErr.Code, "error": message})
		fmt.Fprintf(a.Stderr, "%s\n", raw)
	} else {
		a.printError(message)
	}
	return apiErr.ExitCode()
}
