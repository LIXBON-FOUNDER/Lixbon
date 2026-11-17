package cli

import (
	"context"
	"fmt"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/cloudhost"
)

const hostUsage = `Uso: lixbon host

Corre el agente sin interfaz como host de una sesión de Coding en la nube. Solo
funciona dentro del entorno aislado que crea Lixbon: la configuración llega por
entorno (LIXBON_GATEWAY, LIXBON_SESSION_TOKEN, LIXBON_SESSION_ID, LIXBON_REPO…).
`

// host es el punto de entrada del contenedor de Coding (ENTRYPOINT de la imagen).
func (a *App) host(ctx context.Context, args []string) int {
	if len(args) > 0 {
		fmt.Fprint(a.Stdout, hostUsage)
		return 0
	}
	o, err := cloudhost.OptionsFromEnv()
	if err != nil {
		a.printError(err.Error())
		return 2
	}
	if err := cloudhost.Run(ctx, o); err != nil {
		a.printError(err.Error())
		return 1
	}
	return 0
}

// pr sube la rama de la sesión y abre el PR. Lo usa el agente dentro del
// entorno de Coding (run_command): el token de GitHub nunca entra aquí, lo
// pone el gateway.
func (a *App) pr(ctx context.Context, args []string) int {
	fs := a.flagSet("pr")
	title := fs.String("title", "", "título del PR")
	body := fs.String("body", "", "descripción del PR")
	if code, stop := parseFlags(fs, args); stop {
		return code
	}
	o, err := cloudhost.OptionsFromEnv()
	if err != nil {
		a.printError("lixbon pr solo funciona dentro de una sesión de Coding: " + err.Error())
		return 2
	}
	branch, err := cloudhost.PushBranch(ctx, o)
	if err != nil {
		a.printError("No se pudo subir la rama: " + err.Error())
		return 1
	}
	reply, err := api.New(o.Gateway+"/v1", o.Token).CodingHost(ctx, o.SessionID,
		map[string]any{"pr": map[string]any{"title": *title, "body": *body}})
	if err != nil {
		a.printError("No se pudo abrir el PR: " + err.Error())
		return 1
	}
	if reply.PR != nil {
		fmt.Fprintf(a.Stdout, "PR abierto desde %s: %s\n", branch, reply.PR.URL)
	}
	return 0
}
