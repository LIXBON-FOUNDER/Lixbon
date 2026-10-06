package cli

import (
	"context"
	"fmt"
	"strings"

	"lixbon.com/cli/internal/agent"
)

// headlessApprover es el aprobador de --once: no hay nadie al teclado, así que
// lo que no está permitido por configuración se rechaza y se explica cómo
// permitirlo.
type headlessApprover struct{ app *App }

func (h *headlessApprover) Approve(ctx context.Context, req agent.Approval) (agent.Decision, error) {
	switch req.Kind {
	case agent.ApproveCommand:
		fmt.Fprintf(h.app.Stderr, "  ✗ comando sin aprobar: %s\n    permítelo con --auto-run, con «lixbon init» (allowed_commands) o desde el chat interactivo\n", req.Summary)
	case agent.ApproveMCP:
		fmt.Fprintf(h.app.Stderr, "  ✗ herramienta externa sin aprobar: %s\n    activa auto_approve_tools en la configuración\n", req.Detail)
	default:
		fmt.Fprintf(h.app.Stderr, "  ✗ cambio sin aprobar: %s\n    activa auto_approve_tools en la configuración\n", req.Detail)
	}
	return agent.Deny, nil
}

// renderEvent escribe el registro de acciones del agente en texto plano.
func (a *App) renderEvent(e agent.Event) {
	w := a.Stderr
	switch e.Kind {
	case agent.EventNote:
		fmt.Fprintf(w, "  · %s\n", e.Text)
	case agent.EventRescued:
		fmt.Fprintf(w, "  · %s\n", e.Text)
	case agent.EventAction:
		line := fmt.Sprintf("  ▸ %s %s", e.Tool, e.Text)
		if e.Adds != 0 || e.Dels != 0 {
			line += fmt.Sprintf("  +%d -%d", e.Adds, e.Dels)
		}
		if e.Meta != "" {
			line += "  (" + e.Meta + ")"
		}
		fmt.Fprintln(w, line)
	case agent.EventReadGroup:
		fmt.Fprintf(w, "  ▸ leyó %s (%s): %s\n", e.Text, e.Meta, strings.Join(e.Names, ", "))
	case agent.EventActionResult:
		mark := "✓"
		if e.Failed {
			mark = "✗"
		}
		line := fmt.Sprintf("    %s %s", mark, e.Summary)
		if e.Check != "" {
			line += "  · " + e.Check
		}
		fmt.Fprintln(w, line)
	}
}

func (a *App) printTurnSummary(stats agent.TurnStats) {
	if stats.Actions == 0 {
		return
	}
	files := ""
	if n := len(stats.Files); n > 0 {
		files = fmt.Sprintf(", %d archivo(s) tocado(s) +%d -%d", n, stats.Adds, stats.Dels)
	}
	fmt.Fprintf(a.Stderr, "  · %d acción(es)%s\n", stats.Actions, files)
}
