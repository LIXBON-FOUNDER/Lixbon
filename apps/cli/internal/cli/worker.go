package cli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/orch"
	"lixbon.com/cli/internal/textutil"
)

const (
	envTaskID     = "LXO_TASK_ID"
	envReportPath = "LXO_REPORT_PATH"

	maxReportBytes  = 190 * 1024
	maxSummaryRunes = 400
)

var workerProfiles = []string{"explorar", "proponer", "delegar_con_revision"}

const workerUsage = `Uso: lixbon worker --profile explorar|proponer|delegar_con_revision [--provider PERFIL] [--model MODELO] "encargo"

Corre como agente hijo del orquestador de Lixbon Desktop: una sola tarea, sin
interfaz, y entrega su respuesta final como informe a su coordinador. Solo
funciona dentro de una tarea lanzada por el orquestador.
`

func workerBrief(taskID, profile, lxo string) string {
	access := "Puedes leer y buscar en esta carpeta, pero NO editar archivos ni ejecutar comandos. " +
		"Aunque estés en modo plan, tu respuesta final es el informe de lo que encontraste: no pidas aprobación."
	if profile == "delegar_con_revision" {
		access = "Puedes leer, editar archivos de esta carpeta y ejecutar los comandos que tengan permiso; un comando sin permiso se rechaza."
		if lxo != "" {
			access += ` Para avisar de tu avance ejecuta "` + lxo + `" phase "nombre de la fase".`
		}
	}
	return "Eres la tarea " + taskID + " de un equipo de agentes del orquestador de Lixbon. " + access + "\n" +
		"Termina con un informe final en Markdown: qué hiciste o encontraste, en qué archivos y qué queda pendiente. " +
		"Lixbon entrega esa respuesta final a tu coordinador por ti: NO ejecutes lxo report ni lxo done."
}

// lxoReport ejecuta `lxo report`; se sustituye en las pruebas.
var lxoReport = func(ctx context.Context, lxo, stdin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, lxo, args...)
	cmd.Stdin = strings.NewReader(stdin)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (a *App) worker(ctx context.Context, args []string) int {
	// El host lee este texto para saber que el CLI admite `--profile`; el de Go
	// mostraría los flags con un solo guion.
	if slices.ContainsFunc(args, func(arg string) bool { return arg == "-h" || arg == "--help" || arg == "-help" }) {
		fmt.Fprint(a.Stdout, workerUsage)
		return 0
	}
	fs := a.flagSet("worker")
	profile := fs.String("profile", "", "explorar, proponer o delegar_con_revision")
	provider := fs.String("provider", "", "proveedor de modelos (lixbon profile); por defecto el activo")
	model := fs.String("model", "", "modelo; por defecto el del proveedor")
	if code, stop := parseFlags(fs, args); stop {
		return code
	}
	task := strings.TrimSpace(strings.Join(fs.Args(), " "))
	switch {
	case *profile == "autonomia_amplia":
		a.printError("El perfil autonomia_amplia está aplazado: este agente no lo admite.")
		return 2
	case !slices.Contains(workerProfiles, *profile):
		fmt.Fprint(a.Stderr, workerUsage)
		return 2
	case task == "":
		fmt.Fprint(a.Stderr, workerUsage)
		return 2
	}
	taskID := os.Getenv(envTaskID)
	if taskID == "" {
		a.printError("lixbon worker solo corre dentro de una tarea del orquestador (falta LXO_TASK_ID).")
		return 2
	}

	cfg := config.Load(a.ConfigPath)
	if *provider != "" {
		if err := cfg.UseProfile(*provider); err != nil {
			a.printError(err.Error())
			return 2
		}
	}
	cfg.Mode = chat.ModeAgent
	c, code, stop := a.openChat(ctx, cfg, chat.Options{ConfigPath: a.ConfigPath, Model: *model, ClientID: "lixbon-worker", Ephemeral: true}, false)
	if stop {
		if code != 0 {
			a.deliver(ctx, false, "No se pudo abrir la conversación con el modelo.", "", nil)
		}
		return code
	}
	defer c.Toolbox.Close()

	s := c.Session
	lxo := orch.Discover(filepath.Dir(a.ConfigPath)).Lxo
	// Solo se le deja ejecutar lxo (phase); las instrucciones de coordinador no son para él.
	s.Orch = func() orch.Info { return orch.Info{Lxo: lxo} }
	s.Approver = &headlessApprover{app: a}
	s.AutoRunCommands = false
	s.PlanMode = *profile != "delegar_con_revision"
	s.AutoApprove = !s.PlanMode

	sink := &onceSink{app: a}
	answer, err := c.Send(ctx, workerBrief(taskID, *profile, lxo)+"\n\n"+task, sink)
	answer = textutil.Strip(answer)
	var files []string
	for f := range s.Stats.Files {
		files = append(files, f)
	}
	slices.Sort(files)

	switch {
	case ctx.Err() != nil:
		a.printError("Tarea interrumpida: no se entrega informe.")
		return 1
	case err != nil:
		a.printError(err.Error())
		a.deliver(ctx, false, "El modelo falló: "+err.Error(), "", nil)
		return 1
	case answer == "":
		a.printError("El modelo no devolvió ningún informe.")
		a.deliver(ctx, false, "El modelo no devolvió ningún informe.", "", files)
		return 1
	}
	fmt.Fprintln(a.Stdout, answer)
	if !a.deliver(ctx, true, summaryOf(answer), answer, files) {
		return 1
	}
	return 0
}

// deliver entrega el informe al host con `lxo report`, salvo que el propio
// modelo ya lo haya hecho. Devuelve false si no pudo entregarlo.
func (a *App) deliver(ctx context.Context, ok bool, summary, report string, files []string) bool {
	if path := os.Getenv(envReportPath); path != "" {
		if _, err := os.Stat(path); err == nil {
			a.printNote("el informe ya estaba entregado")
			return true
		}
	}
	lxo := orch.Discover(filepath.Dir(a.ConfigPath)).Lxo
	if lxo == "" {
		a.printError("No se encontró lxo: no se puede entregar el informe. Apunta LXO_BIN a su ruta.")
		return false
	}
	args := []string{"report", "--summary", summary, "--report", "-"}
	if !ok {
		args = append(args, "--failed")
	}
	if len(files) > 0 {
		args = append(args, "--files", strings.Join(files, ","))
	}
	out, err := lxoReport(ctx, lxo, clip(report, maxReportBytes), args...)
	if err != nil {
		a.printError("lxo report falló: " + firstNonBlank(out, err.Error()))
		return false
	}
	a.printNote(out)
	return true
}

func (a *App) printNote(text string) {
	if text != "" {
		fmt.Fprintf(a.Stderr, "  · %s\n", text)
	}
}

func firstNonBlank(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// summaryOf es la primera línea con contenido del informe, sin marcas de Markdown.
func summaryOf(report string) string {
	for _, line := range strings.Split(report, "\n") {
		line = strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(line), "#>*-` "))
		if line != "" {
			return clipRunes(line, maxSummaryRunes)
		}
	}
	return "Tarea terminada."
}

func clipRunes(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit-1]) + "…"
}

// clip recorta por bytes sin partir un carácter.
func clip(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + "\n\n… (informe recortado)"
}
