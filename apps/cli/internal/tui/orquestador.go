package tui

import (
	"context"
	"os/exec"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/chat"
)

const lxoListLines = 40

var lxoRun = func(ctx context.Context, lxo, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, lxo, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (m *Model) cmdOrquestar(objective string) tea.Cmd {
	if objective == "" {
		m.add(errLine("Uso: /orchestrate <objetivo>"))
		m.add(note("El agente reparte el objetivo entre agentes hijos en Lixbon Desktop; cada lanzamiento lo apruebas allí."))
		return nil
	}
	info := m.chat.Session.OrchInfo()
	if !info.Available() {
		m.add(errLine(firstNonEmpty(info.Problem, "El orquestador no está disponible.")))
		m.add(note("/orchestrator explica qué falta."))
		return nil
	}
	m.chat.Session.PlanMode = false
	m.setMode(chat.ModeAgent)
	return m.startTurn("/orchestrate "+objective, "")
}

func (m *Model) cmdOrquestador() tea.Cmd {
	info := m.chat.Session.OrchInfo()
	if !info.Available() {
		m.add(warnLine(firstNonEmpty(info.Problem, "El orquestador no está disponible.")))
		if info.Lxo != "" {
			m.add(note("lxo encontrado: " + shortPath(info.Lxo)))
		}
		return nil
	}
	dir := m.chat.Workspace
	return m.async("consultando el orquestador", func(ctx context.Context) cmdDoneMsg {
		out, err := lxoRun(ctx, info.Lxo, dir, "list")
		if err != nil {
			return cmdDoneMsg{lines: []block{errLine("lxo list falló: " + firstNonEmpty(out, err.Error()))}}
		}
		lines := []block{okLine("Orquestador de Lixbon Desktop activo " + glyphSep + " lxo " + shortPath(info.Lxo)), textBlock("")}
		for _, l := range firstLines(out, lxoListLines) {
			lines = append(lines, textBlock("  "+sDim.Render(l)))
		}
		return cmdDoneMsg{lines: append(lines, textBlock(""))}
	})
}
