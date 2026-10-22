package tui

// Resumen del arranque (LXO-106): trabajo activo y Attention del Core de
// Lixbon Desktop, en una nota al abrir el chat. Va aparte del aviso de versión
// nueva (selfupdate.go): son cosas distintas y no se mezclan.

import (
	"context"
	"errors"
	"os"
	"path/filepath"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/orch"
)

// SummaryDisableEnv desactiva el resumen del arranque sin tocar la configuración.
const SummaryDisableEnv = "LIXBON_NO_STARTUP_SUMMARY"

var fetchSummary = orch.Summary

type coreSummaryMsg struct {
	lines []string
	err   error
}

// SummaryEnabled dice si el chat pide el resumen al abrir: sí por defecto;
// "startup_summary": false en config.json o LIXBON_NO_STARTUP_SUMMARY lo apagan.
func SummaryEnabled(cfg config.Config) bool {
	return os.Getenv(SummaryDisableEnv) == "" && cfg.ExtraBool("startup_summary", true)
}

// coreSummary devuelve la consulta del arranque, o nil si está desactivada.
func coreSummary(cfg config.Config, configPath string) func(context.Context) ([]string, error) {
	if !SummaryEnabled(cfg) {
		return nil
	}
	dir := filepath.Dir(configPath)
	return func(ctx context.Context) ([]string, error) { return fetchSummary(ctx, dir) }
}

// coreSummaryCmd corre en su propia goroutine (tea.Batch en Init): el chat
// acepta texto desde el primer momento y la consulta tiene plazo propio.
func (m *Model) coreSummaryCmd() tea.Cmd {
	fetch := m.opts.CoreSummary
	if fetch == nil {
		return nil
	}
	return func() tea.Msg {
		lines, err := fetch(context.Background())
		if errors.Is(err, orch.ErrSummaryOff) {
			return nil // Desktop cerrado o dentro de una tarea: nada que decir
		}
		return coreSummaryMsg{lines: lines, err: err}
	}
}

// onCoreSummary pinta el resumen. Si el Core no contesta lo dice en una nota,
// sin tratarlo como error del CLI.
func (m *Model) onCoreSummary(msg coreSummaryMsg) {
	switch {
	case errors.Is(msg.err, orch.ErrSummarySlow):
		m.add(note("Lixbon Desktop no respondió a tiempo: resumen del arranque omitido (lxo summary para verlo)."))
	case msg.err != nil:
		m.add(note("No se pudo leer el resumen de Lixbon Desktop (lxo summary para ver por qué)."))
	default:
		for _, line := range msg.lines {
			m.add(note(line))
		}
	}
}
