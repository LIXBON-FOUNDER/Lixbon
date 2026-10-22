package tui

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/orch"
)

func withSummary(h *harness, lines []string, err error) {
	h.m.opts.CoreSummary = func(context.Context) ([]string, error) { return lines, err }
}

func TestStartupSummaryShowsTheCoreSummary(t *testing.T) {
	h := newHarness(t, nil)
	withSummary(h, []string{"Lixbon · 2 proyectos con trabajo · 3 tareas activas · 1 pide atención (1 pregunta)", "  → lxo attention para verla"}, nil)
	h.update(h.m.coreSummaryCmd()())
	contains(t, h.out(), "3 tareas activas · 1 pide atención (1 pregunta)")
	contains(t, h.out(), "→ lxo attention para verla")
}

func TestStartupSummaryWithoutAttention(t *testing.T) {
	h := newHarness(t, nil)
	withSummary(h, []string{"Lixbon · sin proyectos con trabajo · 0 tareas activas · nada pide atención"}, nil)
	h.update(h.m.coreSummaryCmd()())
	contains(t, h.out(), "nada pide atención")
	notContains(t, h.out(), "lxo attention")
}

func TestStartupSummaryIsSilentWithDesktopClosed(t *testing.T) {
	h := newHarness(t, nil)
	withSummary(h, nil, orch.ErrSummaryOff)
	if msg := h.m.coreSummaryCmd()(); msg != nil {
		t.Fatalf("con Desktop cerrado no hay mensaje: %v", msg)
	}
}

func TestStartupSummaryReportsASlowCoreWithoutFailing(t *testing.T) {
	h := newHarness(t, nil)
	withSummary(h, nil, orch.ErrSummarySlow)
	h.update(h.m.coreSummaryCmd()())
	contains(t, h.out(), "no respondió a tiempo")
	notContains(t, h.out(), "Error")

	h = newHarness(t, nil)
	withSummary(h, nil, orch.ErrSummaryFailed)
	h.update(h.m.coreSummaryCmd()())
	contains(t, h.out(), "No se pudo leer el resumen")
}

func TestStartupSummaryIsSeparateFromTheUpdateNotice(t *testing.T) {
	h := newHarness(t, nil)
	if h.m.coreSummaryCmd() != nil {
		t.Fatal("sin consulta configurada no hay comando")
	}
	withSummary(h, []string{"Lixbon · 1 tarea activa"}, nil)
	msg := h.m.coreSummaryCmd()()
	if _, ok := msg.(coreSummaryMsg); !ok {
		t.Fatalf("mensaje propio, no el de la versión nueva: %T", msg)
	}
}

func TestStartupSummaryCanBeDisabled(t *testing.T) {
	t.Setenv(SummaryDisableEnv, "")
	path := filepath.Join(t.TempDir(), "config.json")
	if coreSummary(config.Default(), path) == nil {
		t.Fatal("debe estar activo por defecto")
	}
	off := config.Default()
	off.Extra["startup_summary"] = []byte("false")
	if coreSummary(off, path) != nil {
		t.Fatal("startup_summary=false debe desactivarlo")
	}
	t.Setenv(SummaryDisableEnv, "1")
	if coreSummary(config.Default(), path) != nil {
		t.Fatalf("%s debe desactivarlo", SummaryDisableEnv)
	}
}

func TestStartupSummaryUsesTheConfigDir(t *testing.T) {
	t.Setenv(SummaryDisableEnv, "")
	previous := fetchSummary
	t.Cleanup(func() { fetchSummary = previous })
	var asked string
	fetchSummary = func(_ context.Context, dir string) ([]string, error) { asked = dir; return nil, errors.New("x") }
	dir := t.TempDir()
	_, _ = coreSummary(config.Default(), filepath.Join(dir, "config.json"))(context.Background())
	if asked != dir {
		t.Fatalf("orch.json se busca junto a config.json: %q", asked)
	}
}

func TestStartupSummaryWrapsInANarrowTerminal(t *testing.T) {
	line := "Lixbon · 2 proyectos con trabajo · 3 tareas activas · 1 pide atención (1 pregunta)"
	for _, l := range strings.Split(ansi.Strip(note(line).render(40, false)), "\n") {
		if ansi.StringWidth(l) > 40 {
			t.Fatalf("línea de %d columnas en una terminal de 40: %q", ansi.StringWidth(l), l)
		}
	}
}
