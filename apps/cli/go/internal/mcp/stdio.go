package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"lixbon.com/cli/internal/process"
)

const (
	maxLineBytes  = 8 << 20
	stderrTail    = 2048
	stdioWaitKill = 2 * time.Second
)

func newTransport(ctx context.Context, spec Spec) (transport, error) {
	if spec.Remote() {
		return newHTTP(spec), nil
	}
	return startStdio(spec)
}

type stdioTransport struct {
	name   string
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stderr *tail

	wmu sync.Mutex

	mu      sync.Mutex
	pending map[string]chan rpcResponse

	done chan struct{}
}

func startStdio(spec Spec) (*stdioTransport, error) {
	exe, err := exec.LookPath(spec.Command)
	if err != nil {
		exe = spec.Command
	}
	cmd := process.Command(spec.Cwd, exe, spec.Args...)
	cmd.Env = os.Environ()
	for k, v := range spec.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	t := &stdioTransport{name: spec.Name, cmd: cmd, stderr: &tail{}, pending: map[string]chan rpcResponse{}, done: make(chan struct{})}
	cmd.Stderr = t.stderr
	cmd.WaitDelay = stdioWaitKill
	if t.stdin, err = cmd.StdinPipe(); err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("no se pudo lanzar «%s»: %w", spec.Command, err)
	}
	go t.read(stdout)
	return t, nil
}

// read consume stdout hasta que el servidor termine; después recoge el proceso.
func (t *stdioTransport) read(stdout io.Reader) {
	reader := bufio.NewReaderSize(stdout, 64<<10)
	for {
		line, err := readLine(reader)
		if len(line) > 0 {
			t.dispatch(line)
		}
		if err != nil {
			break
		}
	}
	_ = t.cmd.Wait()
	close(t.done)
}

// readLine devuelve una línea; las que superan maxLineBytes se descartan para
// no acumular memoria sin límite.
func readLine(r *bufio.Reader) ([]byte, error) {
	var line []byte
	overflow := false
	for {
		chunk, isPrefix, err := r.ReadLine()
		if !overflow {
			line = append(line, chunk...)
			overflow = len(line) > maxLineBytes
		}
		if err != nil {
			if overflow {
				return nil, err
			}
			return line, err
		}
		if !isPrefix {
			if overflow {
				return nil, nil
			}
			return line, nil
		}
	}
}

// dispatch reparte una línea: respuestas a quien espera, peticiones del
// servidor (ping, roots…) a su manejador. El ruido que no es JSON se ignora.
func (t *stdioTransport) dispatch(line []byte) {
	var msg struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		rpcResponse
	}
	if json.Unmarshal(line, &msg) != nil {
		return
	}
	id := strings.TrimSpace(string(msg.ID))
	if msg.Method != "" {
		if id != "" && id != "null" {
			t.answerServerRequest(msg.ID, msg.Method)
		}
		return
	}
	t.mu.Lock()
	ch := t.pending[id]
	t.mu.Unlock()
	if ch != nil {
		select {
		case ch <- msg.rpcResponse:
		default:
		}
	}
}

// answerServerRequest responde a lo que el servidor pregunta al cliente: el
// cliente no declara capacidades, así que solo ping tiene respuesta.
func (t *stdioTransport) answerServerRequest(id json.RawMessage, method string) {
	reply := map[string]any{"jsonrpc": "2.0", "id": id}
	if method == "ping" {
		reply["result"] = map[string]any{}
	} else {
		reply["error"] = map[string]any{"code": -32601, "message": "método no soportado: " + method}
	}
	if msg, err := json.Marshal(reply); err == nil {
		_ = t.write(msg)
	}
}

func (t *stdioTransport) write(msg []byte) error {
	select {
	case <-t.done:
		return t.exitError()
	default:
	}
	t.wmu.Lock()
	defer t.wmu.Unlock()
	if _, err := t.stdin.Write(append(bytes.Clone(msg), '\n')); err != nil {
		return t.exitError()
	}
	return nil
}

func (t *stdioTransport) exitError() error {
	msg := fmt.Sprintf("el servidor «%s» terminó", t.name)
	if detail := strings.TrimSpace(t.stderr.String()); detail != "" {
		msg += ": " + detail
	}
	return errors.New(msg)
}

func (t *stdioTransport) exchange(ctx context.Context, id int64, msg []byte) (rpcResponse, error) {
	key := strconv.FormatInt(id, 10)
	ch := make(chan rpcResponse, 1)
	t.mu.Lock()
	t.pending[key] = ch
	t.mu.Unlock()
	defer func() {
		t.mu.Lock()
		delete(t.pending, key)
		t.mu.Unlock()
	}()
	if err := t.write(msg); err != nil {
		return rpcResponse{}, err
	}
	select {
	case resp := <-ch:
		return resp, nil
	case <-t.done:
		select {
		case resp := <-ch:
			return resp, nil
		default:
			return rpcResponse{}, t.exitError()
		}
	case <-ctx.Done():
		return rpcResponse{}, ctx.Err()
	}
}

func (t *stdioTransport) notify(_ context.Context, msg []byte) error { return t.write(msg) }

func (t *stdioTransport) setProtocol(string) {}

func (t *stdioTransport) alive() bool {
	select {
	case <-t.done:
		return false
	default:
		return true
	}
}

// close cierra stdin para que el servidor termine solo; si no lo hace a
// tiempo, mata el árbol de procesos.
func (t *stdioTransport) close() {
	_ = t.stdin.Close()
	select {
	case <-t.done:
		return
	case <-time.After(closeGrace):
	}
	process.KillTree(t.cmd.Process.Pid)
	select {
	case <-t.done:
	case <-time.After(stdioWaitKill + time.Second):
	}
}

// tail conserva los últimos bytes que el servidor escribió por stderr, para
// explicar por qué murió sin acumular su salida.
type tail struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > stderrTail {
		t.buf = t.buf[len(t.buf)-stderrTail:]
	}
	return len(p), nil
}

func (t *tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.ToValidUTF8(string(t.buf), "")
}
