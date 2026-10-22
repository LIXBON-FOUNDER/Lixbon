package orch

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// TestHelperLxo hace de lxo cuando se ejecuta como subproceso de las pruebas.
func TestHelperLxo(t *testing.T) {
	mode := os.Getenv("LXO_HELPER_MODE")
	if mode == "" {
		return
	}
	switch mode {
	case "ok":
		os.Stdout.WriteString("Lixbon · 2 proyectos con trabajo · 3 tareas activas · 1 pide atención (1 pregunta)\n  → lxo attention para verla\n")
		os.Exit(0)
	case "token":
		if os.Getenv("LXO_CLIENT_TOKEN") != "" {
			os.Exit(3)
		}
		os.Stdout.WriteString("sin token\n")
		os.Exit(0)
	case "slow":
		time.Sleep(30 * time.Second)
		os.Exit(0)
	case "closed":
		os.Exit(5)
	case "version":
		os.Exit(4)
	}
	os.Exit(1)
}

// helperRunner ejecuta este mismo binario de pruebas como si fuera lxo.
func helperRunner(t *testing.T, mode string) {
	t.Helper()
	previous := runLxo
	runLxo = func(ctx context.Context, _ string, args ...string) ([]byte, int, error) {
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestHelperLxo$")
		cmd.WaitDelay = 200 * time.Millisecond
		cmd.Env = append(withoutAgentToken(os.Environ()), "LXO_HELPER_MODE="+mode)
		out, err := cmd.Output()
		code := 0
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		}
		return out, code, err
	}
	t.Cleanup(func() { runLxo = previous })
}

func desktopOpen(t *testing.T) string {
	t.Helper()
	isolate(t, true)
	t.Setenv("LXO_CLIENT_TOKEN", "")
	dir := t.TempDir()
	writeDiscovery(t, dir, discovery{Port: 4000, Lxo: fakeLxo(t)})
	return dir
}

func TestSummaryCoreDisponible(t *testing.T) {
	dir := desktopOpen(t)
	helperRunner(t, "ok")
	lines, err := Summary(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "Lixbon · 2 proyectos") || !strings.Contains(lines[1], "lxo attention") {
		t.Fatalf("líneas: %q", lines)
	}
}

func TestSummaryCoreLentoNoBloqueaElArranque(t *testing.T) {
	dir := desktopOpen(t)
	helperRunner(t, "slow")
	start := time.Now()
	_, err := Summary(context.Background(), dir)
	elapsed := time.Since(start)
	if !errors.Is(err, ErrSummarySlow) {
		t.Fatalf("se esperaba ErrSummarySlow, salió %v", err)
	}
	// Plazo + margen para matar el proceso: nunca los 30 s del lxo colgado.
	if elapsed > SummaryTimeout+2*time.Second {
		t.Fatalf("el arranque esperó %v", elapsed)
	}
}

func TestSummaryDesktopCerradoEsSilencioso(t *testing.T) {
	isolate(t, false)
	t.Setenv("LXO_CLIENT_TOKEN", "")
	if _, err := Summary(context.Background(), t.TempDir()); !errors.Is(err, ErrSummaryOff) {
		t.Fatalf("sin orch.json: %v", err)
	}
	dir := desktopOpen(t)
	helperRunner(t, "closed")
	if _, err := Summary(context.Background(), dir); !errors.Is(err, ErrSummaryOff) {
		t.Fatalf("lxo con código 5 (Core no disponible): %v", err)
	}
}

func TestSummaryErrorDeVersionNoEsFatal(t *testing.T) {
	dir := desktopOpen(t)
	helperRunner(t, "version")
	if _, err := Summary(context.Background(), dir); !errors.Is(err, ErrSummaryFailed) {
		t.Fatalf("se esperaba ErrSummaryFailed, salió %v", err)
	}
}

func TestSummaryDentroDeUnaTareaNoSePide(t *testing.T) {
	dir := desktopOpen(t)
	helperRunner(t, "ok")
	t.Setenv("LXO_CLIENT_TOKEN", "token-de-agente")
	if _, err := Summary(context.Background(), dir); !errors.Is(err, ErrSummaryOff) {
		t.Fatalf("un agente no pide el resumen de la persona: %v", err)
	}
}

func TestSummaryNoPasaElTokenDeAgenteALxo(t *testing.T) {
	env := withoutAgentToken([]string{"PATH=x", "LXO_CLIENT_TOKEN=secreto", "lxo_client_token=otro", "HOME=y"})
	if strings.Contains(strings.Join(env, ";"), "secreto") || strings.Contains(strings.Join(env, ";"), "otro") || len(env) != 2 {
		t.Fatalf("env: %q", env)
	}
}

func TestSummaryLinesLimpiaYRecorta(t *testing.T) {
	raw := "a\x1b[2Jb\tc\r\n\n" + strings.Repeat("x", 300) + "\ntercera\n"
	lines := summaryLines([]byte(raw))
	if len(lines) != 2 {
		t.Fatalf("como mucho dos líneas: %q", lines)
	}
	if lines[0] != "a[2Jbc" {
		t.Fatalf("sin controles: %q", lines[0])
	}
	if n := len([]rune(lines[1])); n != summaryMaxChars || !strings.HasSuffix(lines[1], "…") {
		t.Fatalf("recorte visible a %d: %d %q", summaryMaxChars, n, lines[1][:10])
	}
	if summaryLines([]byte("\n \n")) != nil {
		t.Fatal("salida vacía no es un resumen")
	}
}
