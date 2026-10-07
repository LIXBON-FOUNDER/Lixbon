package tui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
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
	if cfg.APIKey == "" && !cfg.IsGeneric() {
		fmt.Fprintln(stderr, "No hay sesión. Configúrala con: lixbon init --api-key <clave>")
		return 1
	}
	opts.ConfigPath = configPath
	opts.Autotitle = true
	c, err := chat.New(cfg, api.FromConfig(cfg), opts)
	if err != nil {
		fmt.Fprintln(stderr, "Error:", err)
		return 1
	}
	defer c.Close()

	fmt.Fprintln(stdout, sDim2.Render("conectando con "+providerHost(cfg.BaseURL)+"…"))
	acc := c.Probe(ctx)
	switch acc.State {
	case chat.AccountAuth:
		if acc.Generic {
			fmt.Fprintln(stderr, providerHost(cfg.BaseURL)+" rechazó la clave. Cámbiala con: lixbon profile add (o lixbon init --api-key <clave>)")
			return 1
		}
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
	c.StartMCP()

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
	all := slices.Concat(Specs, GoSpecs)
	names := make([]string, len(all))
	for i, s := range all {
		names[i] = s.Name
	}
	return names
}

func dimAll(lines []string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = sDim2.Render(l)
	}
	return out
}

const (
	logoGap     = 3
	logoMargin  = 1
	minLogoRoom = logoSize + 2*logoMargin
)

// headerLayout pone el texto junto al logo si cabe y, si no, debajo; en una
// terminal más estrecha que el logo lo omite. Nunca parte una fila del logo.
func headerLayout(logo, text []string, width int) string {
	var lines []string
	pad := strings.Repeat(" ", logoMargin)
	fit := func(s string, room int) string { return ansi.Truncate(s, max(room, 1), glyphEllipsis) }
	switch {
	case width >= minLogoRoom+logoGap+40:
		for i, row := range logo {
			line := pad + row
			if i < len(text) && text[i] != "" {
				line += strings.Repeat(" ", logoGap) + fit(text[i], width-minLogoRoom-logoGap)
			}
			lines = append(lines, line)
		}
	case width >= minLogoRoom:
		for _, row := range logo {
			lines = append(lines, pad+row)
		}
		for _, l := range text {
			if l != "" {
				lines = append(lines, pad+fit(l, width-2*logoMargin))
			}
		}
	default:
		for _, l := range text {
			if l != "" {
				lines = append(lines, fit(l, width))
			}
		}
	}
	return strings.Join(lines, "\n")
}

func (m *Model) printHeader() {
	c := m.chat
	title := sBold.Render("Lixbon CLI") + sDim.Render(" v"+m.opts.Version)
	if plan := c.Cfg.ExtraString("plan_name"); plan != "" && !c.Client.Generic {
		title += sDim2.Render("  " + glyphSep + "  plan " + plan)
	}
	parts := []string{firstNonEmpty(m.modelLabel(c.Model), "sin modelo"), c.Mode, shortPath(c.Workspace)}
	if profile := c.Cfg.ActiveProfile(); profile != config.DefaultProfile {
		parts = slices.Insert(parts, 0, profile)
	}
	info := sDim.Render(strings.Join(parts, " "+glyphSep+" "))
	tips := []string{
		"/ comandos  " + glyphSep + "  ! shell  " + glyphSep + "  Enter envía",
		"Alt+Enter nueva línea  " + glyphSep + "  Esc interrumpe",
		"Mayús+Tab cambia de modo  " + glyphSep + "  RePág/AvPág desplazan",
	}
	text := append([]string{"", title, info, ""}, dimAll(tips)...)
	m.print("")
	m.printDynamic(func(width int) string { return headerLayout(renderLogo(), text, width) })
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
