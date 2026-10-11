package cli

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/charmbracelet/x/term"
)

// prompter lee respuestas de la entrada estándar. ok es false cuando la
// persona cierra la entrada (Ctrl+D) o la interrumpe: el flujo se abandona.
type prompter struct {
	in  *bufio.Reader
	out io.Writer
	fd  uintptr
	tty bool
}

func (a *App) newPrompter() *prompter {
	in := a.Stdin
	if in == nil {
		in = os.Stdin
	}
	p := &prompter{in: bufio.NewReader(in), out: a.Stdout}
	if f, ok := in.(*os.File); ok && term.IsTerminal(f.Fd()) {
		p.fd, p.tty = f.Fd(), true
	}
	return p
}

func (p *prompter) ask(label string, secret bool) (string, bool) {
	fmt.Fprintf(p.out, "  %s: ", label)
	if secret && p.tty {
		raw, err := term.ReadPassword(p.fd)
		fmt.Fprintln(p.out)
		return strings.TrimSpace(string(raw)), err == nil
	}
	line, err := p.in.ReadString('\n')
	if err != nil && line == "" {
		fmt.Fprintln(p.out)
		return "", false
	}
	return strings.TrimSpace(line), true
}

type choice struct{ label, detail, value string }

func (p *prompter) choose(title string, options []choice) (string, bool) {
	fmt.Fprintln(p.out, title)
	for i, o := range options {
		fmt.Fprintf(p.out, "  %d) %s", i+1, o.label)
		if o.detail != "" {
			fmt.Fprintf(p.out, " — %s", o.detail)
		}
		fmt.Fprintln(p.out)
	}
	for {
		answer, ok := p.ask("Elige un número", false)
		if !ok || answer == "" {
			return "", false
		}
		if n, err := strconv.Atoi(answer); err == nil && n >= 1 && n <= len(options) {
			return options[n-1].value, true
		}
		fmt.Fprintf(p.out, "  Escribe un número entre 1 y %d.\n", len(options))
	}
}
