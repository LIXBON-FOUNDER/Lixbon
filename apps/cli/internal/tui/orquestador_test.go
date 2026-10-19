package tui

import (
	"context"
	"slices"
	"strings"
	"testing"

	"lixbon.com/cli/internal/orch"
)

func orchAvailable() func() orch.Info {
	return func() orch.Info { return orch.Info{Lxo: "lxo", Running: true} }
}

func systemPromptOf(t *testing.T, h *harness, request int) string {
	t.Helper()
	messages := h.gw.bodyAt(request)["messages"].([]any)
	return messages[0].(map[string]any)["content"].(string)
}

func TestOrquestarWithoutObjectiveExplainsUsage(t *testing.T) {
	h := newHarness(t, nil)
	h.send("/orquestar")
	contains(t, h.out(), "Uso: /orchestrate <objetivo>")
	if h.gw.count() != 0 {
		t.Fatal("sin objetivo no se llama al modelo")
	}
}

func TestOrquestarExplainsWhyItCannotStartWithoutTheDesktop(t *testing.T) {
	h := newHarness(t, nil)
	h.chat.Session.Orch = func() orch.Info { return orch.Info{Problem: "Lixbon Desktop no está abierto."} }
	h.send("/orquestar migra el módulo de pagos")
	contains(t, h.out(), "Lixbon Desktop no está abierto.")
	if h.gw.count() != 0 || h.chat.Mode != "ask" {
		t.Fatalf("no debe arrancar ni cambiar de modo: peticiones=%d modo=%s", h.gw.count(), h.chat.Mode)
	}
}

func TestOrquestarSwitchesToAgentAndGivesTheModelTheCoordinatorInstructions(t *testing.T) {
	h := newHarness(t, nil, textReply("planeado"))
	h.chat.Session.Orch = orchAvailable()
	h.send("/orquestar migra el módulo de pagos")
	h.settle()
	if h.chat.Mode != "agent" {
		t.Fatalf("debe pasar a modo agent: %s", h.chat.Mode)
	}
	system := systemPromptOf(t, h, 0)
	contains(t, system, "Orquestador de agentes (Lixbon)")
	contains(t, system, `"lxo" guide coordinator`)
	messages := h.gw.bodyAt(0)["messages"].([]any)
	last := messages[len(messages)-1].(map[string]any)["content"].(string)
	if last != "/orchestrate migra el módulo de pagos" {
		t.Fatalf("el modelo debe recibir el comando tal cual: %q", last)
	}
}

func TestOrchestratorInstructionsAreAbsentWithoutTheDesktopAndInPlanMode(t *testing.T) {
	h := agentHarness(t, true, textReply("uno"), textReply("dos"))
	h.send("hola")
	h.settle()
	notContains(t, systemPromptOf(t, h, 0), "Orquestador de agentes")

	h.chat.Session.Orch = orchAvailable()
	h.chat.Session.PlanMode = true
	h.send("planifica")
	h.settle()
	notContains(t, systemPromptOf(t, h, 1), "Orquestador de agentes")
}

func TestAnLxoCallRunsWithoutAskingButChainedCommandsStillAsk(t *testing.T) {
	h := agentHarness(t, true,
		toolReply("c1", "run_command", map[string]any{"command": "lxo list"}),
		toolReply("c2", "run_command", map[string]any{"command": "lxo list && echo hola"}),
		textReply("hecho"))
	h.chat.Session.Orch = orchAvailable()
	h.send("mira los runs")
	h.pump(func() bool { return h.m.picker != nil })
	if h.gw.count() != 2 {
		t.Fatalf("la primera llamada a lxo debía ejecutarse sin preguntar; peticiones=%d", h.gw.count())
	}
	contains(t, h.view(), "Lixbon quiere ejecutar una orden")
	h.key("esc")
	h.settle()
}

func TestOrquestadorShowsTheRunsFromLxo(t *testing.T) {
	previous := lxoRun
	lxoRun = func(_ context.Context, lxo, _ string, args ...string) (string, error) {
		if lxo != "lxo" || strings.Join(args, " ") != "list" {
			t.Errorf("llamada inesperada: %s %v", lxo, args)
		}
		return "r1 · Migrar pagos · 2 tareas", nil
	}
	t.Cleanup(func() { lxoRun = previous })

	h := newHarness(t, nil)
	h.chat.Session.Orch = orchAvailable()
	h.send("/orquestador")
	h.settle()
	contains(t, h.out(), "Orquestador de Lixbon Desktop activo")
	contains(t, h.out(), "r1 · Migrar pagos · 2 tareas")
}

func TestOrquestadorReportsAFailingLxoAndAMissingDesktop(t *testing.T) {
	previous := lxoRun
	lxoRun = func(context.Context, string, string, ...string) (string, error) {
		return "Lixbon no está abierto", context.DeadlineExceeded
	}
	t.Cleanup(func() { lxoRun = previous })

	h := newHarness(t, nil)
	h.chat.Session.Orch = orchAvailable()
	h.send("/orquestador")
	h.settle()
	contains(t, h.out(), "lxo list falló: Lixbon no está abierto")

	h.chat.Session.Orch = func() orch.Info {
		return orch.Info{Lxo: `C:\Lixbon\lxo.exe`, Problem: "Lixbon Desktop dejó de responder: ábrelo de nuevo."}
	}
	h.send("/orquestador")
	contains(t, h.out(), "dejó de responder")
	contains(t, h.out(), "lxo encontrado")
}

func TestOrchestratorCommandsAreInTheMenuAndReserved(t *testing.T) {
	h := newHarness(t, nil)
	var menu []string
	for _, s := range h.m.allSpecs() {
		menu = append(menu, s.Name)
	}
	reserved := reservedNames()
	for _, name := range []string{"orchestrate", "orchestrator"} {
		if !slices.Contains(menu, name) || !slices.Contains(reserved, name) {
			t.Errorf("/%s debe estar en el menú y reservado", name)
		}
	}
	// Los nombres en español siguen funcionando y reservados, fuera del menú.
	for _, name := range []string{"orquestar", "orquestador"} {
		if slices.Contains(menu, name) || !slices.Contains(reserved, name) {
			t.Errorf("/%s es un alias reservado que no sale en el menú", name)
		}
	}
}
