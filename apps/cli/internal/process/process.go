// Package process ejecuta comandos de shell del agente: con timeout real,
// cancelación por contexto, muerte de todo el árbol de procesos y captura de
// salida de memoria acotada.
package process

import (
	"context"
	"errors"
	"os/exec"
	"regexp"
	"time"
	"unicode/utf8"

	"lixbon.com/cli/internal/textutil"
)

const (
	MaxTimeout    = 600
	MaxOutput     = 8000
	headCap       = 32 << 10
	tailCap       = 32 << 10
	waitDelay     = 2 * time.Second
	truncatedMark = "\n…[salida recortada]…\n"
)

type Result struct {
	Output   string
	ExitCode int
	TimedOut bool
}

var ansi = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z]`)

// DecodeOutput es UTF-8 si lo es; si no, la página de códigos de la consola
// (en Windows cmd habla OEM). Quita secuencias ANSI y espacios de los bordes.
func DecodeOutput(raw []byte) string {
	text := ""
	if utf8.Valid(raw) {
		text = string(raw)
	} else {
		text = decodeLegacy(raw)
	}
	return textutil.Strip(ansi.ReplaceAllString(text, ""))
}

// capture conserva el inicio y el final de la salida y cuenta lo demás.
type capture struct {
	head    []byte
	tail    []byte
	dropped bool
}

func (c *capture) Write(p []byte) (int, error) {
	n := len(p)
	if room := headCap - len(c.head); room > 0 {
		take := min(room, len(p))
		c.head = append(c.head, p[:take]...)
		p = p[take:]
	}
	if len(p) > 0 {
		c.tail = append(c.tail, p...)
		if len(c.tail) > 2*tailCap {
			c.tail = append([]byte(nil), c.tail[len(c.tail)-tailCap:]...)
			c.dropped = true
		}
	}
	return n, nil
}

// summary aplica el recorte de Python: por encima de 8000 caracteres se
// conservan los primeros y los últimos 4000.
func (c *capture) summary() string {
	if !c.dropped && len(c.tail) <= tailCap {
		return Trim(DecodeOutput(append(append([]byte(nil), c.head...), c.tail...)))
	}
	tail := c.tail
	if len(tail) > tailCap {
		tail = tail[len(tail)-tailCap:]
	}
	head := []rune(DecodeOutput(c.head))
	rest := []rune(DecodeOutput(tail))
	return string(head[:min(len(head), MaxOutput/2)]) + truncatedMark + string(rest[max(0, len(rest)-MaxOutput/2):])
}

func (c *capture) lastChars(n int) string {
	tail := c.tail
	if len(tail) > tailCap {
		tail = tail[len(tail)-tailCap:]
	}
	data := tail
	if !c.dropped && len(c.tail) <= tailCap {
		data = append(append([]byte(nil), c.head...), c.tail...)
	}
	runes := []rune(DecodeOutput(data))
	return string(runes[max(0, len(runes)-n):])
}

// Trim recorta una salida larga dejando principio y final.
func Trim(output string) string {
	runes := []rune(output)
	if len(runes) <= MaxOutput {
		return output
	}
	return string(runes[:MaxOutput/2]) + truncatedMark + string(runes[len(runes)-MaxOutput/2:])
}

// Run ejecuta command en dir y espera. Si expira el timeout mata el árbol y
// devuelve TimedOut con la última salida en Output; si se cancela ctx mata el
// árbol y devuelve el error del contexto.
func Run(ctx context.Context, dir, command string, timeout time.Duration) (Result, error) {
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := shellCommand(runCtx, dir, command)
	cmd.Cancel = func() error { killTree(cmd.Process.Pid); return nil }
	cmd.WaitDelay = waitDelay
	out := &capture{}
	cmd.Stdout, cmd.Stderr = out, out

	if err := cmd.Start(); err != nil {
		return Result{}, err
	}
	err := cmd.Wait()
	if ctx.Err() != nil {
		return Result{}, ctx.Err()
	}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return Result{Output: out.lastChars(2000), ExitCode: -1, TimedOut: true}, nil
	}
	code := cmd.ProcessState.ExitCode()
	var exitErr *exec.ExitError
	if err != nil && !errors.As(err, &exitErr) && !errors.Is(err, exec.ErrWaitDelay) {
		return Result{}, err
	}
	return Result{Output: out.summary(), ExitCode: code}, nil
}
