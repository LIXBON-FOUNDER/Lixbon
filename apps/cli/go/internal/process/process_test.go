package process

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestMain convierte el binario de pruebas en un proceso auxiliar cuando
// LXB_HELPER está definido: así los tests lanzan árboles de procesos reales
// sin depender de utilidades del sistema.
func TestMain(m *testing.M) {
	switch os.Getenv("LXB_HELPER") {
	case "":
		os.Exit(m.Run())
	case "sleep":
		time.Sleep(time.Minute)
	case "spawn":
		child := exec.Command(os.Args[0])
		child.Env = append(os.Environ(), "LXB_HELPER=sleep")
		if err := child.Start(); err != nil {
			os.Exit(2)
		}
		_ = os.WriteFile(os.Getenv("LXB_PIDFILE"), []byte(strconv.Itoa(child.Process.Pid)), 0o644)
		time.Sleep(time.Minute)
	case "flood":
		fmt.Println("HEAD-MARK")
		line := strings.Repeat("x", 99) + "\n"
		for i := 0; i < 500_000; i++ {
			fmt.Print(line)
		}
		fmt.Println("TAIL-MARK")
	case "tick":
		fmt.Println("tick")
		time.Sleep(time.Minute)
	}
	os.Exit(0)
}

func helperCommand(t *testing.T, mode string) string {
	t.Helper()
	t.Setenv("LXB_HELPER", mode)
	return `"` + os.Args[0] + `"`
}

func waitDead(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for processAlive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("el proceso %d sigue vivo", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func readPID(t *testing.T, file string) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(file); err == nil && len(data) > 0 {
			pid, _ := strconv.Atoi(string(data))
			return pid
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("el proceso auxiliar no escribió su pid")
	return 0
}

func TestRunCapturesOutputAndExitCode(t *testing.T) {
	res, err := Run(context.Background(), t.TempDir(), "echo hola && exit 3", 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if res.Output != "hola" || res.ExitCode != 3 || res.TimedOut {
		t.Fatalf("%+v", res)
	}
}

func TestRunMergesStderr(t *testing.T) {
	res, err := Run(context.Background(), t.TempDir(), "echo fuera && echo dentro 1>&2", 10*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Output, "fuera") || !strings.Contains(res.Output, "dentro") {
		t.Fatalf("%q", res.Output)
	}
}

func TestRunUsesWorkingDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "marca.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	list := "ls"
	if os.PathSeparator == '\\' {
		list = "dir /b"
	}
	res, err := Run(context.Background(), dir, list, 10*time.Second)
	if err != nil || !strings.Contains(res.Output, "marca.txt") {
		t.Fatalf("%+v %v", res, err)
	}
}

func TestTimeoutKillsTheWholeTree(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	t.Setenv("LXB_PIDFILE", pidFile)
	start := time.Now()
	res, err := Run(context.Background(), t.TempDir(), helperCommand(t, "spawn"), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !res.TimedOut {
		t.Fatalf("no expiró: %+v", res)
	}
	if elapsed := time.Since(start); elapsed > 8*time.Second {
		t.Fatalf("tardó %s", elapsed)
	}
	waitDead(t, readPID(t, pidFile))
}

func TestCancelKillsTheWholeTree(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	t.Setenv("LXB_PIDFILE", pidFile)
	ctx, cancel := context.WithCancel(context.Background())
	command := helperCommand(t, "spawn")
	done := make(chan error, 1)
	go func() {
		_, err := Run(ctx, t.TempDir(), command, time.Minute)
		done <- err
	}()
	pid := readPID(t, pidFile)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error: %v", err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("Run no volvió tras cancelar")
	}
	waitDead(t, pid)
}

func TestHugeOutputKeepsHeadAndTailOnly(t *testing.T) {
	res, err := Run(context.Background(), t.TempDir(), helperCommand(t, "flood"), 60*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(res.Output, "HEAD-MARK") || !strings.HasSuffix(res.Output, "TAIL-MARK") {
		t.Fatalf("cabeza/cola perdidas: %.40q … %.40q", res.Output, res.Output[len(res.Output)-40:])
	}
	if !strings.Contains(res.Output, "…[salida recortada]…") {
		t.Fatal("falta el aviso de recorte")
	}
	if n := len([]rune(res.Output)); n > MaxOutput+40 {
		t.Fatalf("salida de %d caracteres", n)
	}
}

func TestCaptureMemoryIsBounded(t *testing.T) {
	c := &capture{}
	chunk := []byte(strings.Repeat("y", 4096))
	for i := 0; i < 20_000; i++ {
		c.Write(chunk)
	}
	if got := len(c.head) + len(c.tail); got > headCap+2*tailCap {
		t.Fatalf("buffers de %d bytes tras 80 MB de salida", got)
	}
	if !c.dropped {
		t.Fatal("debía haber descartado datos")
	}
}

func TestTrimAndDecode(t *testing.T) {
	if got := DecodeOutput([]byte("\x1b[31mrojo\x1b[0m  \n")); got != "rojo" {
		t.Errorf("ANSI: %q", got)
	}
	short := strings.Repeat("a", MaxOutput)
	if Trim(short) != short {
		t.Error("una salida en el límite no se recorta")
	}
	long := strings.Repeat("a", MaxOutput*3)
	if got := Trim(long); len(got) >= len(long) || !strings.Contains(got, "recortada") {
		t.Errorf("no se recortó: %d", len(got))
	}
}

func TestBackgroundLifecycle(t *testing.T) {
	m := NewManager()
	t.Cleanup(m.StopAll)
	bg, err := m.Start(t.TempDir(), helperCommand(t, "tick"))
	if err != nil {
		t.Fatal(err)
	}
	if bg.ID != "p1" || !bg.Alive() {
		t.Fatalf("estado inicial: %+v", bg)
	}
	deadline := time.Now().Add(5 * time.Second)
	var first string
	for first == "" && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
		first = bg.ReadNew()
	}
	if first != "tick" {
		t.Fatalf("primera lectura: %q", first)
	}
	if again := bg.ReadNew(); again != "" {
		t.Fatalf("la segunda lectura debe estar vacía: %q", again)
	}
	if ids := m.IDs(); len(ids) != 1 || ids[0] != "p1" {
		t.Fatalf("ids: %v", ids)
	}
	pid := bg.cmd.Process.Pid
	command, err := m.Stop("p1")
	if err != nil || command != helperCommand(t, "tick") {
		t.Fatalf("Stop: %q %v", command, err)
	}
	if bg.Alive() {
		t.Fatal("sigue vivo tras Stop")
	}
	waitDead(t, pid)
	if _, err := m.Stop("p1"); !errors.Is(err, ErrNoSuchProcess) {
		t.Fatalf("segundo Stop: %v", err)
	}
	if len(m.IDs()) != 0 {
		t.Fatal("Stop debe olvidar el proceso")
	}
}

func TestBackgroundBufferDropsOldestAndAdjustsCursor(t *testing.T) {
	bg := &Background{}
	bg.Write([]byte(strings.Repeat("a", backgroundBuffer-10)))
	bg.ReadNew()
	bg.Write([]byte(strings.Repeat("b", 100)))
	if got := bg.ReadNew(); got != strings.Repeat("b", 100) {
		t.Fatalf("lectura tras descartar: %d bytes", len(got))
	}
	if len(bg.buf) > backgroundBuffer {
		t.Fatalf("buffer de %d bytes", len(bg.buf))
	}
}

func TestBackgroundFinishedProcessReportsExit(t *testing.T) {
	m := NewManager()
	t.Cleanup(m.StopAll)
	bg, err := m.Start(t.TempDir(), "echo listo && exit 5")
	if err != nil {
		t.Fatal(err)
	}
	bg.Wait(context.Background(), 5*time.Second)
	if bg.Alive() || bg.ExitCode() != 5 || bg.ReadNew() != "listo" {
		t.Fatalf("alive=%v code=%d", bg.Alive(), bg.ExitCode())
	}
}
