package tui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/term"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
)

// Interactive abre el chat de terminal con la conversación que describe opts.
// Devuelve el código de salida del proceso.
func Interactive(ctx context.Context, stdout, stderr io.Writer, configPath string, opts chat.Options) int {
	if !term.IsTerminal(os.Stdin.Fd()) || !term.IsTerminal(os.Stdout.Fd()) {
		fmt.Fprintln(stderr, "El chat interactivo necesita una terminal. Usa: lixbon chat --once \"mensaje\"")
		return 1
	}
	cfg := config.Load(configPath)
	if cfg.APIKey == "" {
		fmt.Fprintln(stderr, "No hay sesión. Configúrala con: lixbon init --api-key <clave>")
		return 1
	}
	opts.ConfigPath = configPath
	opts.Autotitle = true
	c, err := chat.New(cfg, api.New(cfg.BaseURL, cfg.APIKey), opts)
	if err != nil {
		fmt.Fprintln(stderr, "Error:", err)
		return 1
	}
	defer c.Close()

	fmt.Fprintln(stdout, sDim2.Render("conectando con Lixbon…"))
	acc := c.Probe(ctx)
	switch acc.State {
	case chat.AccountAuth:
		c.ClearSession()
		fmt.Fprintln(stderr, "Tu sesión ya no es válida (se cerró desde otro sitio o la clave fue revocada).")
		fmt.Fprintln(stderr, "Configúrala de nuevo con: lixbon init --api-key <clave>")
		return 1
	}
	needsPick, err := c.ResolveModel(acc)
	if err != nil {
		fmt.Fprintln(stderr, "Error:", err)
		return 1
	}
	c.LoadCustomCommands(reservedNames())

	m := New(c, Options{
		HistoryFile: filepath.Join(filepath.Dir(configPath), "history"),
		Version:     config.Version,
		Account:     acc,
		Offline:     acc.State == chat.AccountOffline,
	})
	if err := runProgram(ctx, m, needsPick, acc.State == chat.AccountOffline, nil, nil); err != nil &&
		!errors.Is(err, tea.ErrInterrupted) && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(stderr, "Error:", err)
		return 1
	}
	fmt.Fprintln(stdout, sDim2.Render("Hasta pronto."))
	return 0
}

// runProgram arranca Bubble Tea con el modelo. in y out son opcionales (para
// pruebas); por defecto usan la terminal.
func runProgram(ctx context.Context, m *Model, pickModel, offline bool, in io.Reader, out io.Writer) error {
	opts := []tea.ProgramOption{tea.WithContext(ctx)}
	if in != nil {
		opts = append(opts, tea.WithInput(in))
	}
	if out != nil {
		opts = append(opts, tea.WithOutput(out))
	}
	program := tea.NewProgram(m, opts...)
	printer := newPrinter(program.Println)
	defer printer.close()
	m.Wire(program.Send, printer.enqueue)

	m.printHeader()
	if offline {
		m.print(warnLine("No se pudo contactar con el servidor; se trabajará con la configuración local."))
	}
	if pickModel {
		m.queueModelPicker()
	}
	_, err := program.Run()
	return err
}

func reservedNames() []string {
	names := make([]string, len(Specs))
	for i, s := range Specs {
		names[i] = s.Name
	}
	return names
}

// printer entrega las líneas a Program.Println en el orden en que se
// encolaron: los tea.Println devueltos por distintos Update pueden llegar
// desordenados porque cada Cmd corre en su propia goroutine.
type printer struct {
	ch   chan string
	done chan struct{}
	once sync.Once
}

func newPrinter(emit func(...any)) *printer {
	p := &printer{ch: make(chan string, 4096), done: make(chan struct{})}
	go func() {
		defer close(p.done)
		for line := range p.ch {
			emit(line)
		}
	}()
	return p
}

func (p *printer) enqueue(line string) { p.ch <- line }

func (p *printer) close() {
	p.once.Do(func() { close(p.ch) })
}

func (m *Model) printHeader() {
	c := m.chat
	plan := c.Cfg.ExtraString("plan_name")
	title := sAccent.Render(glyphSpark+" ") + sBold.Render("Lixbon CLI") + sDim.Render(" v"+m.opts.Version)
	if plan != "" {
		title += sDim2.Render("  " + glyphSep + "  plan " + plan)
	}
	m.print("")
	m.print(title)
	m.print("  " + sDim.Render(fmt.Sprintf("%s %s %s %s %s",
		firstNonEmpty(m.modelLabel(c.Model), "sin modelo"), glyphSep, c.Mode, glyphSep, shortPath(c.Workspace))))
	var tips []string
	tips = append(tips, "/ comandos", "Enter envía", "Alt+Enter nueva línea", "Esc interrumpe", "Mayús+Tab cambia de modo")
	m.print("  " + sDim2.Render(strings.Join(tips, "  "+glyphSep+"  ")))
	if c.Mode == chat.ModeAsk {
		m.print(note("Modo ask: el modelo solo conversa. /mode agent para que cree y edite archivos."))
	}
	if c.ProjectContext != "" {
		m.print(note("LIXBON.md encontrado: se usará como contexto del proyecto."))
	}
	m.print("")
}

// queueModelPicker abre el selector de modelo al arrancar cuando ni la
// configuración ni el servidor deciden cuál usar.
func (m *Model) queueModelPicker() {
	m.cmdModel("")
}
