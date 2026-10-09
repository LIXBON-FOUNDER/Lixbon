package process

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"sync"
	"time"
)

const (
	backgroundBuffer = 400_000
	stopGrace        = 2 * time.Second
)

// Background es un proceso lanzado sin esperar: un buffer acotado recoge su
// salida y ReadNew devuelve solo lo escrito desde la última lectura.
type Background struct {
	ID      string
	Command string

	cmd      *exec.Cmd
	mu       sync.Mutex
	buf      []byte
	cursor   int
	done     chan struct{}
	exitCode int
}

func (b *Background) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if over := len(b.buf) - backgroundBuffer; over > 0 {
		b.buf = append([]byte(nil), b.buf[over:]...)
		b.cursor = max(0, b.cursor-over)
	}
	return len(p), nil
}

func (b *Background) ReadNew() string {
	b.mu.Lock()
	fresh := append([]byte(nil), b.buf[b.cursor:]...)
	b.cursor = len(b.buf)
	b.mu.Unlock()
	return DecodeOutput(fresh)
}

func (b *Background) Alive() bool {
	select {
	case <-b.done:
		return false
	default:
		return true
	}
}

func (b *Background) ExitCode() int { return b.exitCode }

// Wait espera hasta d a que termine el proceso o a que se cancele ctx.
func (b *Background) Wait(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-b.done:
	case <-timer.C:
	case <-ctx.Done():
	}
}

type Manager struct {
	mu    sync.Mutex
	seq   int
	procs map[string]*Background
	order []string
}

func NewManager() *Manager {
	return &Manager{procs: map[string]*Background{}}
}

// Start lanza command en dir. El proceso sobrevive a la llamada que lo creó:
// solo Stop, StopAll o su propio final lo terminan.
func (m *Manager) Start(dir, command string) (*Background, error) {
	cmd := shellCommand(context.Background(), dir, command)
	bg := &Background{Command: command, cmd: cmd, done: make(chan struct{})}
	cmd.Stdout, cmd.Stderr = bg, bg
	cmd.WaitDelay = waitDelay
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.seq++
	bg.ID = fmt.Sprintf("p%d", m.seq)
	m.procs[bg.ID] = bg
	m.order = append(m.order, bg.ID)
	m.mu.Unlock()

	go func() {
		_ = cmd.Wait()
		bg.exitCode = cmd.ProcessState.ExitCode()
		close(bg.done)
	}()
	return bg, nil
}

func (m *Manager) Get(id string) (*Background, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	bg, ok := m.procs[id]
	return bg, ok
}

// IDs devuelve los identificadores activos en orden de creación.
func (m *Manager) IDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.order...)
}

type Info struct {
	ID      string
	Command string
	Alive   bool
}

func (m *Manager) List() []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Info, 0, len(m.order))
	for _, id := range m.order {
		bg := m.procs[id]
		out = append(out, Info{bg.ID, bg.Command, bg.Alive()})
	}
	return out
}

var ErrNoSuchProcess = errors.New("no hay ningún proceso")

// Stop mata el árbol del proceso, lo olvida y devuelve su comando.
func (m *Manager) Stop(id string) (string, error) {
	m.mu.Lock()
	bg, ok := m.procs[id]
	if ok {
		delete(m.procs, id)
		for i, v := range m.order {
			if v == id {
				m.order = append(m.order[:i], m.order[i+1:]...)
				break
			}
		}
	}
	m.mu.Unlock()
	if !ok {
		return "", ErrNoSuchProcess
	}
	if bg.Alive() {
		killTree(bg.cmd.Process.Pid)
		bg.Wait(context.Background(), stopGrace)
	}
	return bg.Command, nil
}

func (m *Manager) StopAll() {
	for _, id := range m.IDs() {
		_, _ = m.Stop(id)
	}
}
