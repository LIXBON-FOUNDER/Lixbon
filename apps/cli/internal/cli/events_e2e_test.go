package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"lixbon.com/cli/internal/events"
)

// El arnés E2E corre los mismos escenarios contra un Core real (variables
// LIXBON_E2E_*) y contra el Core falso de las pruebas, para que el arnés mismo
// esté verificado antes de apuntarlo a Lixbon Desktop.

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type e2eEnv struct {
	dir     string
	restart func(t *testing.T)
	produce func(t *testing.T)
}

func (e e2eEnv) run(ctx context.Context, args ...string) (code int, stdout, stderr string) {
	var out, errOut syncBuffer
	app := &App{Stdout: &out, Stderr: &errOut, ConfigPath: filepath.Join(e.dir, "config.json")}
	code = app.Run(ctx, append([]string{"events"}, args...))
	return code, out.String(), errOut.String()
}

type eventsDoc struct {
	V          int               `json:"v"`
	Events     []json.RawMessage `json:"events"`
	NextCursor int64             `json:"next_cursor"`
	HasMore    bool              `json:"has_more"`
	HeadSeq    int64             `json:"head_seq"`
}

func seqOfRaw(t *testing.T, raw json.RawMessage) int64 {
	t.Helper()
	var ev struct {
		Seq int64 `json:"seq"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil || ev.Seq < 1 {
		t.Fatalf("evento sin seq: %s (%v)", raw, err)
	}
	return ev.Seq
}

func (e e2eEnv) read(t *testing.T, args ...string) eventsDoc {
	t.Helper()
	code, out, errOut := e.run(context.Background(), append([]string{"--json"}, args...)...)
	if code != 0 {
		t.Fatalf("events %v: code %d, stderr %q", args, code, errOut)
	}
	var doc eventsDoc
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("events %v: salida no JSON %q: %v", args, out, err)
	}
	if doc.V != events.ContractVersion {
		t.Fatalf("v=%d", doc.V)
	}
	return doc
}

func e2eEmpty(t *testing.T, e e2eEnv) {
	doc := e.read(t)
	if len(doc.Events) != 0 || doc.HasMore || doc.HeadSeq != 0 || doc.NextCursor != 0 {
		t.Fatalf("un Core sin eventos debe devolver una página vacía: %+v", doc)
	}
	if code, out, errOut := e.run(context.Background()); code != 0 || out != "" {
		t.Fatalf("humano: code %d, stdout %q, stderr %q", code, out, errOut)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	if code, out, errOut := e.run(ctx, "--follow", "--json"); code != 0 || out != "" {
		t.Fatalf("follow vacío: code %d, stdout %q, stderr %q", code, out, errOut)
	}
}

func e2eHistory(t *testing.T, e e2eEnv, minEvents int) {
	big := e.read(t, "--limit", "500")
	if len(big.Events) < minEvents {
		t.Fatalf("el Core tiene %d eventos y la prueba necesita al menos %d", len(big.Events), minEvents)
	}
	if !big.HasMore && big.NextCursor != big.HeadSeq {
		t.Fatalf("sin más páginas next_cursor debe ser head_seq: %+v", big)
	}

	var paged []json.RawMessage
	var calls int
	cursor := "0"
	for {
		doc := e.read(t, "--limit", "2", "--after", cursor)
		paged = append(paged, doc.Events...)
		cursor = strconv.FormatInt(doc.NextCursor, 10)
		calls++
		if !doc.HasMore {
			if doc.NextCursor != doc.HeadSeq {
				t.Fatalf("última página: next_cursor %d != head_seq %d", doc.NextCursor, doc.HeadSeq)
			}
			break
		}
		if calls > 5000 {
			t.Fatal("paginación sin fin")
		}
	}
	var last int64
	for i, raw := range paged {
		seq := seqOfRaw(t, raw)
		if seq <= last {
			t.Fatalf("seq %d tras %d: la paginación repite o desordena", seq, last)
		}
		last = seq
		if !big.HasMore {
			compactBig, _ := events.CompactJSON(big.Events[i])
			compactPaged, _ := events.CompactJSON(raw)
			if !bytes.Equal(compactBig, compactPaged) {
				t.Fatalf("el evento %d difiere entre lectura paginada y completa:\n%s\n%s", i, compactPaged, compactBig)
			}
		}
	}
	if !big.HasMore && len(paged) != len(big.Events) {
		t.Fatalf("paginado %d eventos, completo %d", len(paged), len(big.Events))
	}

	mid := seqOfRaw(t, big.Events[len(big.Events)/2])
	after := e.read(t, "--after", strconv.FormatInt(mid, 10), "--limit", "500")
	for _, raw := range after.Events {
		if seqOfRaw(t, raw) <= mid {
			t.Fatalf("--after %d devolvió un seq no posterior", mid)
		}
	}

	var first struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(big.Events[0], &first); err != nil || first.Kind == "" {
		t.Fatalf("primer evento sin kind: %s", big.Events[0])
	}
	filtered := e.read(t, "--kind", first.Kind, "--limit", "500")
	if len(filtered.Events) == 0 {
		t.Fatalf("el filtro --kind %s no devolvió su propio evento", first.Kind)
	}
	for _, raw := range filtered.Events {
		var ev struct {
			Kind string `json:"kind"`
		}
		_ = json.Unmarshal(raw, &ev)
		if ev.Kind != first.Kind {
			t.Fatalf("--kind %s devolvió %s", first.Kind, ev.Kind)
		}
	}
	if !filtered.HasMore && filtered.NextCursor != filtered.HeadSeq {
		t.Fatalf("un cliente filtrado debe poder avanzar hasta head_seq: %+v", filtered)
	}

	if code, out, _ := e.run(context.Background(), "--after", strconv.FormatInt(big.HeadSeq+1000, 10)); code != events.ExitCursor || out != "" {
		t.Fatalf("cursor adelantado: code %d, stdout %q", code, out)
	}
}

func waitFor(t *testing.T, what string, within time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("tiempo agotado esperando %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func followedSeqs(t *testing.T, out string) []int64 {
	t.Helper()
	var seqs []int64
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line == "" {
			continue
		}
		var ev struct {
			Seq int64 `json:"seq"`
		}
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("línea de follow inválida %q", line)
		}
		seqs = append(seqs, ev.Seq)
	}
	return seqs
}

func e2eReconnect(t *testing.T, e e2eEnv) {
	head := e.read(t).HeadSeq
	var out, errOut syncBuffer
	app := &App{Stdout: &out, Stderr: &errOut, ConfigPath: filepath.Join(e.dir, "config.json")}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 1)
	go func() { done <- app.Run(ctx, []string{"events", "--follow", "--json"}) }()

	waitFor(t, "el historial inicial", 30*time.Second, func() bool {
		seqs := followedSeqs(t, out.String())
		return int64(len(seqs)) > 0 && seqs[len(seqs)-1] >= head
	})
	e.restart(t)
	e.produce(t)
	waitFor(t, "un evento posterior al reinicio", 120*time.Second, func() bool {
		seqs := followedSeqs(t, out.String())
		return len(seqs) > 0 && seqs[len(seqs)-1] > head
	})
	cancel()
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("follow terminó con %d, stderr %q", code, errOut.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatal("follow no terminó tras cancelar")
	}

	seqs := followedSeqs(t, out.String())
	all := e.read(t, "--limit", "500")
	if all.HasMore {
		t.Skip("más de 500 eventos: la comparación completa necesita paginar")
	}
	if len(seqs) != len(all.Events) {
		t.Fatalf("follow emitió %d eventos y el Core tiene %d: %v", len(seqs), len(all.Events), seqs)
	}
	for i, raw := range all.Events {
		if seqs[i] != seqOfRaw(t, raw) {
			t.Fatalf("posición %d: follow %d, Core %d (salto o duplicado)", i, seqs[i], seqOfRaw(t, raw))
		}
	}

	ctx2, cancel2 := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel2()
	if code, again, errOut := e.run(ctx2, "--follow", "--json"); code != 0 || again != "" {
		t.Fatalf("reanudar con el cursor guardado: code %d, repetidos %q, stderr %q", code, again, errOut)
	}
}

func TestEventsE2EContraElCoreFalso(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		h, _ := newEventsHarness(t)
		e2eEmpty(t, e2eEnv{dir: filepath.Dir(h.path)})
	})
	t.Run("history", func(t *testing.T) {
		h, _ := newEventsHarness(t, 1, 2, 3, 4, 5, 6, 7)
		e2eHistory(t, e2eEnv{dir: filepath.Dir(h.path)}, 5)
	})
	t.Run("reconnect", func(t *testing.T) {
		h, core := newEventsHarness(t, 1, 2, 3)
		e2eReconnect(t, e2eEnv{
			dir:     filepath.Dir(h.path),
			restart: func(*testing.T) { core.restart() },
			produce: func(*testing.T) { core.append(4, 5) },
		})
	})
}

func shell(t *testing.T, command string) {
	t.Helper()
	name, flag := "sh", "-c"
	if runtime.GOOS == "windows" {
		name, flag = "cmd", "/c"
	}
	if out, err := exec.Command(name, flag, command).CombinedOutput(); err != nil {
		t.Fatalf("%q falló: %v\n%s", command, err, out)
	}
}

// TestEventsE2ECoreReal se activa con LIXBON_E2E_DIR (carpeta con el orch.json
// de un Lixbon Desktop vivo) y LXO_TASK_ID de una tarea real:
//
//	LIXBON_E2E_SCENARIO  empty | history | reconnect
//	LIXBON_E2E_MIN_EVENTS  mínimo de eventos para history (defecto 5)
//	LIXBON_E2E_RESTART_CMD reinicia el Core y deja orch.json actualizado (reconnect)
//	LIXBON_E2E_PRODUCE_CMD provoca al menos un evento nuevo tras el reinicio (reconnect)
func TestEventsE2ECoreReal(t *testing.T) {
	dir := os.Getenv("LIXBON_E2E_DIR")
	if dir == "" {
		t.Skip("LIXBON_E2E_DIR no está definido: sin Core real")
	}
	if os.Getenv("LXO_TASK_ID") == "" {
		t.Fatal("LXO_TASK_ID es obligatorio para el E2E contra un Core real")
	}
	e := e2eEnv{dir: dir}
	switch scenario := os.Getenv("LIXBON_E2E_SCENARIO"); scenario {
	case "empty":
		e2eEmpty(t, e)
	case "history":
		min := 5
		if v, err := strconv.Atoi(os.Getenv("LIXBON_E2E_MIN_EVENTS")); err == nil {
			min = v
		}
		e2eHistory(t, e, min)
	case "reconnect":
		restart, produce := os.Getenv("LIXBON_E2E_RESTART_CMD"), os.Getenv("LIXBON_E2E_PRODUCE_CMD")
		if restart == "" || produce == "" {
			t.Fatal("reconnect necesita LIXBON_E2E_RESTART_CMD y LIXBON_E2E_PRODUCE_CMD")
		}
		e.restart = func(t *testing.T) { shell(t, restart) }
		e.produce = func(t *testing.T) { shell(t, produce) }
		e2eReconnect(t, e)
	default:
		t.Fatalf("LIXBON_E2E_SCENARIO debe ser empty, history o reconnect (recibido %q)", scenario)
	}
	fmt.Fprintln(os.Stderr, "E2E ok:", os.Getenv("LIXBON_E2E_SCENARIO"))
}
