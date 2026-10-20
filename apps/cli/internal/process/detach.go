package process

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"sync"
	"time"
)

// RunDetachable es RunLive con una salida más: si se cierra detach mientras
// el comando corre, no se mata, sino que sigue como proceso en segundo plano
// del gestor y se devuelve con lo que llevaba escrito. Así un comando largo no
// retiene el turno: el usuario lo manda al fondo con ctrl+b.
func (m *Manager) RunDetachable(ctx context.Context, dir, command string, timeout time.Duration, live io.Writer, detach <-chan struct{}) (Result, *Background, error) {
	// Sin contexto: lo que lo mata mientras no se suelte es este select, y una
	// vez suelto solo Stop.
	cmd := shellCommand(context.Background(), dir, command)
	cmd.WaitDelay = waitDelay
	bg := &Background{Command: command, Started: time.Now(), cmd: cmd, done: make(chan struct{})}
	out := &capture{}
	sink := &detachWriter{out: out, live: live, bg: bg}
	cmd.Stdout, cmd.Stderr = sink, sink
	if err := cmd.Start(); err != nil {
		return Result{}, nil, err
	}
	waited := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		bg.exitCode = cmd.ProcessState.ExitCode()
		close(bg.done)
		waited <- err
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	kill := func() error {
		killTree(cmd.Process.Pid)
		return <-waited
	}
	select {
	case err := <-waited:
		var exitErr *exec.ExitError
		if err != nil && !errors.As(err, &exitErr) && !errors.Is(err, exec.ErrWaitDelay) {
			return Result{}, nil, err
		}
		return Result{Output: out.summary(), ExitCode: bg.exitCode}, nil, nil
	case <-ctx.Done():
		kill()
		return Result{}, nil, ctx.Err()
	case <-timer.C:
		kill()
		return Result{Output: out.lastChars(2000), ExitCode: -1, TimedOut: true}, nil, nil
	case <-detach:
		sink.release()
		m.adopt(bg)
		return Result{Output: out.summary()}, bg, nil
	}
}

// detachWriter copia la salida a la captura y a la vista mientras el comando
// es del turno; el proceso en segundo plano la recoge siempre, para que su
// salida completa empiece desde el principio.
type detachWriter struct {
	mu       sync.Mutex
	out      *capture
	live     io.Writer
	bg       *Background
	released bool
}

func (w *detachWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.bg.Write(p)
	if !w.released {
		w.out.Write(p)
		if w.live != nil {
			w.live.Write(p)
		}
	}
	return len(p), nil
}

// release suelta el comando: lo escrito hasta aquí ya va en el resultado, así
// que read_output solo dará lo nuevo.
func (w *detachWriter) release() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.released = true
	w.bg.mu.Lock()
	w.bg.cursor = len(w.bg.buf)
	w.bg.mu.Unlock()
}
