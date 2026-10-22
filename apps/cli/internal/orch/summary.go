package orch

// Resumen del arranque (LXO-106): al abrir el chat, una línea con el trabajo
// activo y la Attention que ve el Core. La da `lxo summary`, que lee la
// snapshot compacta del Core como Person con la credencial CLI del almacén
// seguro del sistema (F1); el CLI no lee credenciales ni habla con el Core.
// Nunca bloquea: el proceso tiene un plazo corto y se mata al vencer.

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"
	"unicode"
)

// SummaryTimeout es lo máximo que el arranque espera al resumen.
const SummaryTimeout = 1500 * time.Millisecond

const (
	summaryMaxLines = 2
	summaryMaxChars = 160
	exitUnavailable = 5
)

var (
	// ErrSummaryOff: no hay resumen que pedir (desactivado, Desktop cerrado o
	// dentro de una tarea del orquestador). No se dice nada.
	ErrSummaryOff = errors.New("resumen no disponible")
	// ErrSummarySlow: el Core no contestó a tiempo.
	ErrSummarySlow = errors.New("el Core no respondió a tiempo")
	// ErrSummaryFailed: lxo contestó con un error (versión, autenticación…).
	ErrSummaryFailed = errors.New("el Core no dio el resumen")
)

// runLxo ejecuta lxo y devuelve su salida estándar y el código de salida.
// Variable para las pruebas.
var runLxo = func(ctx context.Context, lxo string, args ...string) ([]byte, int, error) {
	cmd := exec.CommandContext(ctx, lxo, args...)
	cmd.WaitDelay = 200 * time.Millisecond
	// Sin token de agente: el resumen es de la persona, con la credencial CLI del sistema.
	cmd.Env = withoutAgentToken(os.Environ())
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	code := 0
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		code = exit.ExitCode()
	}
	return out.Bytes(), code, err
}

func withoutAgentToken(env []string) []string {
	out := env[:0:0]
	for _, kv := range env {
		if !strings.HasPrefix(strings.ToUpper(kv), "LXO_CLIENT_TOKEN=") {
			out = append(out, kv)
		}
	}
	return out
}

// Summary devuelve las líneas del resumen del arranque. `dir` es la carpeta
// de orch.json (~/.lixbon). Con Desktop cerrado devuelve ErrSummaryOff.
func Summary(ctx context.Context, dir string) ([]string, error) {
	// Dentro de una tarea del orquestador el CLI es un agente, no la persona.
	if os.Getenv("LXO_CLIENT_TOKEN") != "" {
		return nil, ErrSummaryOff
	}
	info := Discover(dir)
	if !info.Available() {
		return nil, ErrSummaryOff
	}
	ctx, cancel := context.WithTimeout(ctx, SummaryTimeout)
	defer cancel()
	out, code, err := runLxo(ctx, info.Lxo, "summary")
	switch {
	case ctx.Err() != nil:
		return nil, ErrSummarySlow
	case code == exitUnavailable:
		// Desktop se cerró o desactivó el orquestador entre medias: como cerrado.
		return nil, ErrSummaryOff
	case err != nil:
		return nil, ErrSummaryFailed
	}
	lines := summaryLines(out)
	if len(lines) == 0 {
		return nil, ErrSummaryFailed
	}
	return lines, nil
}

// summaryLines limpia la salida de lxo para la terminal: sin caracteres de
// control ni secuencias de escape, como mucho dos líneas cortas.
func summaryLines(raw []byte) []string {
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		line = strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return -1
			}
			return r
		}, line)
		line = strings.TrimRight(line, " ")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if r := []rune(line); len(r) > summaryMaxChars {
			line = string(r[:summaryMaxChars-1]) + "…"
		}
		lines = append(lines, line)
		if len(lines) == summaryMaxLines {
			break
		}
	}
	return lines
}
