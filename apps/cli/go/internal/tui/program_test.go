package tui

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
)

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

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("no se cumplió: %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Un programa Bubble Tea de verdad, con entrada y salida inyectadas: comprueba
// el cableado completo (Wire, cola de impresión, Update, View) de principio a fin.
func TestRealProgramEndToEnd(t *testing.T) {
	h := newHarness(t, nil, textReply("Hola desde el modelo."))
	pr, pw := io.Pipe()
	out := &syncBuffer{}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- runProgram(ctx, h.m, false, false, pr, out) }()

	waitFor(t, "cabecera", func() bool { return strings.Contains(ansi.Strip(out.String()), "Lixbon CLI") })
	io.WriteString(pw, "buenas tardes\r")
	waitFor(t, "respuesta", func() bool { return strings.Contains(ansi.Strip(out.String()), "Hola desde el modelo.") })
	io.WriteString(pw, "\x04") // Ctrl+D con la caja vacía
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("el programa terminó con error: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("el programa no salió con Ctrl+D")
	}
	screen := ansi.Strip(out.String())
	if i, j := strings.Index(screen, "buenas tardes"), strings.Index(screen, "Hola desde el modelo."); i < 0 || j < 0 || i > j {
		t.Fatalf("el mensaje debe verse antes que la respuesta (%d, %d):\n%s", i, j, screen)
	}
	if len(h.chat.History) != 2 {
		t.Fatalf("historial: %d", len(h.chat.History))
	}
}

func TestPrinterKeepsOrder(t *testing.T) {
	var mu sync.Mutex
	var got []string
	p := newPrinter(func(args ...any) {
		mu.Lock()
		got = append(got, args[0].(string))
		mu.Unlock()
	})
	for i := 0; i < 500; i++ {
		p.enqueue(string(rune('a' + i%26)))
	}
	p.close()
	<-p.done
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 500 {
		t.Fatalf("líneas: %d", len(got))
	}
	for i, line := range got {
		if line != string(rune('a'+i%26)) {
			t.Fatalf("desorden en %d: %q", i, line)
		}
	}
}
