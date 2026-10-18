package agent

import (
	"context"
	"fmt"
	"strings"

	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/toolparse"
)

// El turno no tiene tope de pasos: lo que se corta es lo que no avanza. Una
// acción que falla MaxRepeatedCalls veces se deja de intentar y el agente
// sigue con lo demás; una llamada idéntica a la anterior repetida tantas
// veces seguidas no se vuelve a ejecutar. Lo descartado se cuenta al final.

const (
	giveUpPrompt = "[Esta acción ya falló %d veces. No la repitas: déjala, sigue con lo demás y, en la " +
		"respuesta final, di qué no pudiste hacer y por qué.]"
	droppedPrompt = "[No se ejecutó: esta acción ya falló %d veces (último error: %s). No la repitas: " +
		"sigue con lo demás y menciónalo en la respuesta final.]"
	loopingPrompt = "[No se ejecutó: es la misma llamada que acabas de hacer %d veces seguidas y su resultado " +
		"ya está arriba. No la repitas: sigue con el siguiente paso o responde.]"
)

// skippedCall es una acción que se dejó de intentar.
type skippedCall struct {
	label, reason string
}

// retries lleva la cuenta de las acciones de un turno.
type retries struct {
	failures map[string]int
	lastErr  map[string]string
	skipped  []skippedCall
	// refused cuenta los pasos seguidos en los que no se ejecutó nada porque
	// todo lo pedido ya estaba descartado: el modelo no sale del bucle.
	refused int
}

func newRetries() *retries {
	return &retries{failures: map[string]int{}, lastErr: map[string]string{}}
}

func (g *retries) dropped(sig string) bool { return g.failures[sig] >= MaxRepeatedCalls }

func (g *retries) anyDropped(calls []toolparse.Call) bool {
	for _, c := range calls {
		if g.dropped(CallSignature(c.Tool, c.Args)) {
			return true
		}
	}
	return false
}

// attempt ejecuta una llamada salvo que ya esté descartada o sea la misma que
// el modelo repite sin avanzar. skipped dice que no se ejecutó.
func (t *Turn) attempt(ctx context.Context, g *retries, tool string, args map[string]any, sig string, looping bool) (result string, skipped bool, err error) {
	switch {
	case g.dropped(sig):
		return fmt.Sprintf(droppedPrompt, MaxRepeatedCalls, g.lastErr[sig]), true, nil
	case looping:
		return fmt.Sprintf(loopingPrompt, MaxRepeatedCalls), true, nil
	}
	t.failed = false
	result, err = t.approveAndRun(ctx, tool, args)
	if err != nil || !t.failed {
		return result, false, err
	}
	g.failures[sig]++
	reason := textutil.Head(firstLine(result), 120)
	g.lastErr[sig] = reason
	if g.dropped(sig) {
		label := strings.TrimSpace(tool + " " + ArgsSummary(tool, args))
		g.skipped = append(g.skipped, skippedCall{label: label, reason: reason})
		t.note(fmt.Sprintf("Se deja de intentar «%s»: falló %d veces (%s). El agente sigue con lo demás.", label, MaxRepeatedCalls, reason))
		result += "\n\n" + fmt.Sprintf(giveUpPrompt, MaxRepeatedCalls)
	}
	return result, false, nil
}

// step cuenta un paso: si no se ejecutó nada, suma un rechazo seguido.
// Devuelve true cuando el modelo lleva demasiados pasos sin salir del bucle.
func (g *retries) step(calls, skipped int) bool {
	if calls > 0 && skipped == calls {
		g.refused++
	} else {
		g.refused = 0
	}
	return g.refused >= MaxRepeatedCalls
}

// report es el informe de lo que no se pudo hacer en el turno.
func (g *retries) report() string {
	if len(g.skipped) == 0 {
		return ""
	}
	lines := []string{"No se pudo hacer:"}
	for _, s := range g.skipped {
		lines = append(lines, fmt.Sprintf("· %s — %s (%d intentos)", s.label, s.reason, MaxRepeatedCalls))
	}
	return strings.Join(lines, "\n")
}
