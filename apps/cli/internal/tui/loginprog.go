package tui

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/term"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/config"
)

type (
	loginTickMsg   struct{}
	loginModelsMsg struct {
		role   string
		models []api.Model
	}
)

// loginProgram es la pantalla de login sola, para lixbon setup y auth login:
// inicia sesión y, si hace falta, elige el modelo por defecto.
type loginProgram struct {
	view          *loginView
	cfg           config.Config
	path          string
	client        *api.Client
	width, height int
	spin          int
	picker        *picker
	done          bool
	model         string
}

func (p *loginProgram) Init() tea.Cmd { return p.tick() }

func (p *loginProgram) tick() tea.Cmd {
	return tea.Tick(tickEvery, func(time.Time) tea.Msg { return loginTickMsg{} })
}

func (p *loginProgram) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		p.width, p.height = msg.Width, msg.Height
		return p, nil
	case loginTickMsg:
		p.spin++
		return p, p.tick()
	case loginModelsMsg:
		return p, p.chooseModel(msg)
	case tea.KeyPressMsg:
		if p.picker != nil {
			cmd, closed := p.picker.key(msg)
			if closed {
				p.picker = nil
				return p, tea.Batch(cmd, tea.Quit)
			}
			return p, cmd
		}
	}
	if p.picker != nil {
		return p, nil
	}
	cmd, outcome := p.view.update(msg)
	switch outcome {
	case loginFinished:
		res := p.view.result
		applyLogin(&p.cfg, res)
		if err := config.Save(p.path, p.cfg); err != nil {
			p.view.fail(stepMethod, err)
			return p, cmd
		}
		p.done = true
		p.client.APIKey = res.key
		if p.cfg.Model != "" || p.cfg.KeyModel != "" {
			return p, tea.Quit
		}
		client := *p.client
		return p, func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if role := client.RoleChatModel(ctx); role != "" {
				return loginModelsMsg{role: role}
			}
			models, _ := client.ModelsDetail(ctx)
			return loginModelsMsg{models: models}
		}
	case loginSkipped:
		return p, tea.Quit
	}
	return p, cmd
}

// chooseModel usa el modelo de chat del servidor o, si no lo fija, abre el
// selector con los que publica.
func (p *loginProgram) chooseModel(msg loginModelsMsg) tea.Cmd {
	save := func(id string) {
		p.cfg.Model, p.model = id, id
		_ = config.Save(p.path, p.cfg)
	}
	switch {
	case msg.role != "":
		save(msg.role)
		return tea.Quit
	case len(msg.models) == 0:
		return tea.Quit
	}
	options := make([]option, len(msg.models))
	for i, mod := range msg.models {
		options[i] = option{Label: mod.Name, Value: mod.ID, Extra: capabilityLabels(mod.Capabilities)}
		if mod.Name != mod.ID {
			options[i].Desc = mod.ID
		}
		if mod.NumCtx > 0 {
			options[i].Meta = sDim.Render(fmtContext(mod.NumCtx))
		}
	}
	p.picker = newPicker("Modelo por defecto", options, func(value string, cancelled bool) tea.Cmd {
		if !cancelled {
			save(value)
		}
		return nil
	})
	p.picker.search = len(options) > 9
	return nil
}

func (p *loginProgram) View() tea.View {
	width, height := max(p.width, 1), max(p.height, 1)
	content := p.view.view(width, height)
	if p.picker != nil {
		var lines []string
		for _, r := range renderWordmark() {
			lines = append(lines, center(r, width))
		}
		lines = append(lines, "", center(sSoft.Render("Elige el modelo que se usará por defecto"), width), "")
		lines = append(lines, p.picker.view(width, max(1, height-12))...)
		lines = append(lines, "", " "+p.picker.hints())
		for len(lines) < height {
			lines = append(lines, "")
		}
		content = strings.Join(lines[:min(len(lines), height)], "\n")
	}
	v := tea.NewView(content)
	v.AltScreen = true
	v.WindowTitle = "lixbon · iniciar sesión"
	return v
}

// Login abre la pantalla de inicio de sesión sola (lixbon setup, auth login).
// Devuelve el código de salida del proceso.
func Login(ctx context.Context, stdout, stderr io.Writer, configPath string) int {
	if !term.IsTerminal(os.Stdin.Fd()) || !term.IsTerminal(os.Stdout.Fd()) {
		fmt.Fprintln(stderr, "La pantalla de login necesita una terminal. Usa: lixbon setup --api-key lixbon_sk_…")
		return 1
	}
	cfg := config.Load(configPath)
	setupAppearance(cfg)
	client := api.FromConfig(cfg)
	p := &loginProgram{cfg: cfg, path: configPath, client: client}
	p.view = newLoginView(loginStandalone, *client, config.Version, &p.spin)
	if _, err := tea.NewProgram(p, tea.WithContext(ctx)).Run(); err != nil &&
		!errors.Is(err, tea.ErrInterrupted) && !errors.Is(err, context.Canceled) {
		fmt.Fprintln(stderr, "Error:", err)
		return 1
	}
	if !p.done {
		lipgloss.Fprintln(stdout, sDim2.Render("No se inició sesión."))
		return 1
	}
	lipgloss.Fprintln(stdout, sOK.Render(glyphs.check)+" "+p.view.result.summary())
	if p.model != "" {
		lipgloss.Fprintln(stdout, sDim.Render("Modelo: "+p.model))
	}
	return 0
}
