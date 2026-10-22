package tui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
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
	setupAppearance(cfg)
	opts.ConfigPath = configPath
	opts.Autotitle = true
	c, err := chat.New(cfg, api.FromConfig(cfg), opts)
	if err != nil {
		fmt.Fprintln(stderr, "Error:", err)
		return 1
	}
	defer c.Close()

	hadKey := c.Cfg.APIKey != ""
	acc, notes := startupAccount(ctx, c, stdout)
	needsPick, warning := false, ""
	if acc.State != chat.AccountAuth {
		var err error
		if needsPick, err = c.ResolveModel(acc); err != nil {
			warning = err.Error()
		}
	}
	c.LoadCustomCommands(reservedNames())
	c.StartMCP()

	m := New(c, Options{
		HistoryFile: filepath.Join(filepath.Dir(configPath), "history"),
		Version:     config.Version,
		Account:     acc,
		Offline:     acc.State == chat.AccountOffline,
		Warning:     warning,
		Notes:       notes,

		UpdateNotice: updateNotice(cfg, configPath),
		CoreSummary:  coreSummary(cfg, configPath),
	})
	// Sin sesión de lixbon.com se abre la pantalla de login; Esc la cierra y
	// deja el chat sin sesión, desde donde /provider sigue funcionando.
	if acc.State == chat.AccountAuth && !c.Client.Generic {
		notice := ""
		if hadKey {
			notice = "Tu sesión de lixbon.com ya no es válida: vuelve a entrar."
		}
		m.login = newLoginView(loginStartup, *c.Client, config.Version, &m.spin)
		m.login.copyText = m.copyText
		m.login.notice = notice
	}
	if err := runProgram(ctx, m, needsPick, acc.State == chat.AccountOffline, nil, nil); err != nil &&
		!errors.Is(err, tea.ErrInterrupted) && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(stderr, "Error:", err)
		return 1
	}
	lipgloss.Fprintln(stdout, m.log.text())
	lipgloss.Fprintln(stdout, sDim2.Render("Hasta pronto."))
	return 0
}

const noSessionHint = "Sin sesión en lixbon.com. /login inicia sesión; /provider conecta otro proveedor (OpenRouter, OpenAI, Xiaomi MiMo, Kilo, LM Studio, Ollama…)."

// startupAccount sondea el proveedor activo. Sin sesión o con la clave
// rechazada el chat arranca igual: así se puede conectar otro proveedor desde
// dentro cuando el servidor de Lixbon no está disponible.
func startupAccount(ctx context.Context, c *chat.Chat, stdout io.Writer) (chat.Account, []string) {
	if !c.Client.Generic && c.Cfg.APIKey == "" {
		return chat.Account{State: chat.AccountAuth}, []string{noSessionHint}
	}
	host := providerHost(c.Client.BaseURL)
	lipgloss.Fprintln(stdout, sDim2.Render("conectando con "+host+"…"))
	acc := c.Probe(ctx)
	if acc.State != chat.AccountAuth {
		return acc, nil
	}
	if acc.Generic {
		name := c.Cfg.ActiveProfile()
		return acc, []string{host + " rechazó la clave de «" + name + "». /provider key " + name + " la cambia; /provider usa otro proveedor."}
	}
	c.ClearSession()
	return acc, []string{"Tu sesión de lixbon.com ya no es válida (se cerró desde otro sitio o la clave fue revocada). /login vuelve a entrar; /provider usa otro proveedor."}
}

// runProgram arranca Bubble Tea con el modelo. in y out son opcionales (para
// pruebas); por defecto usan la terminal.
func runProgram(ctx context.Context, m *Model, pickModel, offline bool, in io.Reader, out io.Writer, extra ...tea.ProgramOption) error {
	opts := append([]tea.ProgramOption{tea.WithContext(ctx)}, extra...)
	if in != nil {
		opts = append(opts, tea.WithInput(in))
	}
	if out == nil && term.IsTerminal(os.Stdout.Fd()) {
		// Las imágenes Sixel se escriben entre fotogramas (sixel.go).
		g := &gfxOut{File: os.Stdout}
		m.gfx = &graphics{out: g}
		out = g
	}
	if out != nil {
		opts = append(opts, tea.WithOutput(out))
	}
	program := tea.NewProgram(m, opts...)
	m.Wire(program.Send, nil)

	m.printHeader()
	if offline {
		m.add(warnLine(serverProblem(m.opts.Account, providerHost(m.chat.Client.BaseURL)) + " Se trabajará con la configuración local."))
	}
	for _, n := range m.opts.Notes {
		m.add(warnLine(n))
	}
	if m.opts.Warning != "" {
		m.add(warnLine(m.opts.Warning + " Puedes explorar la interfaz; /model elegirá uno cuando haya."))
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
	// Los alias en español también: un comando propio no puede taparlos.
	for alias := range aliases {
		names = append(names, alias)
	}
	slices.Sort(names[len(all):])
	return names
}

// queueModelPicker abre el selector de modelo al arrancar cuando ni la
// configuración ni el servidor deciden cuál usar.
func (m *Model) queueModelPicker() {
	m.cmdModel("")
}
