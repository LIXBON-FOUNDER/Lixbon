package tui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

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
	warning := ""
	if err != nil {
		warning = err.Error()
	}
	c.LoadCustomCommands(reservedNames())

	m := New(c, Options{
		HistoryFile: filepath.Join(filepath.Dir(configPath), "history"),
		Version:     config.Version,
		Account:     acc,
		Offline:     acc.State == chat.AccountOffline,
		Warning:     warning,
	})
	if err := runProgram(ctx, m, needsPick, acc.State == chat.AccountOffline, nil, nil); err != nil &&
		!errors.Is(err, tea.ErrInterrupted) && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(stderr, "Error:", err)
		return 1
	}
	fmt.Fprintln(stdout, m.log.text())
	fmt.Fprintln(stdout, sDim2.Render("Hasta pronto."))
	return 0
}

// runProgram arranca Bubble Tea con el modelo. in y out son opcionales (para
// pruebas); por defecto usan la terminal.
func runProgram(ctx context.Context, m *Model, pickModel, offline bool, in io.Reader, out io.Writer, extra ...tea.ProgramOption) error {
	opts := append([]tea.ProgramOption{tea.WithContext(ctx)}, extra...)
	if in != nil {
		opts = append(opts, tea.WithInput(in))
	}
	if out != nil {
		opts = append(opts, tea.WithOutput(out))
	}
	program := tea.NewProgram(m, opts...)
	m.Wire(program.Send, nil)

	m.printHeader()
	if offline {
		m.print(warnLine("No se pudo contactar con el servidor; se trabajará con la configuración local."))
	}
	if m.opts.Warning != "" {
		m.print(warnLine(m.opts.Warning + " Puedes explorar la interfaz; /model elegirá uno cuando haya."))
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

func (m *Model) printHeader() {
	c := m.chat
	title := sBold.Render("Lixbon CLI") + sDim.Render(" v"+m.opts.Version)
	if plan := c.Cfg.ExtraString("plan_name"); plan != "" {
		title += sDim2.Render("  " + glyphSep + "  plan " + plan)
	}
	info := sDim.Render(fmt.Sprintf("%s %s %s %s %s",
		firstNonEmpty(m.modelLabel(c.Model), "sin modelo"), glyphSep, c.Mode, glyphSep, shortPath(c.Workspace)))
	tips := []string{
		"/ comandos  " + glyphSep + "  Enter envía",
		"Alt+Enter nueva línea  " + glyphSep + "  Esc interrumpe",
		"Mayús+Tab cambia de modo  " + glyphSep + "  RePág/AvPág desplazan",
	}
	text := []string{"", title, info, ""}
	for _, t := range tips {
		text = append(text, sDim2.Render(t))
	}
	m.print("")
	for i, row := range renderLogo() {
		line := " " + row
		if i < len(text) && text[i] != "" {
			line += "   " + text[i]
		}
		m.print(line)
	}
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
