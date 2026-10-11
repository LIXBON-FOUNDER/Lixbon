package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/weblogin"
)

// Dos caminos y ninguno pide correo ni contraseña en la terminal: el
// navegador con la sesión de lixbon.com (PKCE) o una API key enmascarada.

type loginStep int

const (
	stepMethod loginStep = iota
	stepBrowser
	stepPaste
	stepAPIKey
	stepValidating
	stepFailed
	stepDone
)

// loginPlace es desde dónde se abrió: al arrancar sin sesión (Esc sigue sin
// sesión), con /login o /key (Esc vuelve al chat) o con lixbon setup.
type loginPlace int

const (
	loginStartup loginPlace = iota
	loginCommand
	loginStandalone
)

type loginOutcome int

const (
	loginPending loginOutcome = iota
	loginFinished
	loginSkipped
)

type loginResult struct {
	key, keyModel, email, plan string
	web                        bool
	tokens                     api.Tokens
}

// adoptLogin pone en el cliente la credencial recién obtenida: la sesión del
// navegador o la API key, que deja sin efecto una sesión anterior.
func adoptLogin(client *api.Client, cfg config.Config, res loginResult) error {
	if res.web {
		return client.StartSession(cfg, res.tokens)
	}
	client.SetKey(res.key)
	return config.RemoveSession(cfg.SessionFile(), cfg.ActiveProfile())
}

type (
	loginStartedMsg struct {
		session *weblogin.Session
		err     error
		openErr error
	}
	loginTokenMsg struct {
		session *weblogin.Session
		token   string
		err     error
	}
	loginKeyMsg struct {
		res loginResult
		err error
	}
)

type loginView struct {
	place      loginPlace
	step       loginStep
	back       loginStep
	cursor     int
	notice     string
	client     api.Client
	version    string
	spin       *int
	session    *weblogin.Session
	cancelWait context.CancelFunc
	deadline   time.Time
	openErr    error
	copied     time.Time
	input      textinput.Model
	errMsg     string
	result     loginResult
	copyText   func(string) error
	open       func(string) error
	// entry es el paso con el que se abrió: Esc en él cierra el login.
	entry loginStep
}

func newLoginView(place loginPlace, client api.Client, version string, spin *int) *loginView {
	return &loginView{place: place, client: client, version: version, spin: spin, copyText: copyToClipboard, open: weblogin.OpenBrowser}
}

func (l *loginView) frame() string {
	if l.spin == nil || reducedMotion() {
		return glyphSpark
	}
	return glyphs.spin[*l.spin%len(glyphs.spin)]
}

func (l *loginView) newInput(secret bool) tea.Cmd {
	ti := textinput.New()
	ti.Prompt = ""
	if secret {
		ti.EchoMode = textinput.EchoPassword
		ti.EchoCharacter = '•'
		ti.Placeholder = "lixbon_sk_…"
	} else {
		ti.Placeholder = "http://127.0.0.1:…/callback?token=…"
	}
	ti.SetWidth(48)
	styles := textinput.DefaultStyles(pal.dark)
	styles.Focused.Text, styles.Focused.Placeholder = sInk, sDim2
	ti.SetStyles(styles)
	l.input = ti
	return l.input.Focus()
}

func (l *loginView) stopWaiting() {
	if l.cancelWait != nil {
		l.cancelWait()
		l.cancelWait = nil
	}
	if l.session != nil {
		l.session.Close()
		l.session = nil
	}
}

func (l *loginView) fail(back loginStep, err error) {
	l.step, l.back, l.errMsg = stepFailed, back, err.Error()
	var apiErr *api.Error
	if errors.As(err, &apiErr) && apiErr.Status == 401 {
		l.errMsg = "La clave no es válida o fue revocada."
	}
}

func (l *loginView) startBrowser() tea.Cmd {
	l.step, l.openErr, l.copied = stepBrowser, nil, time.Time{}
	server, open := l.client.Server, l.open
	return func() tea.Msg {
		s, err := weblogin.Start(server)
		if err != nil {
			return loginStartedMsg{err: err}
		}
		return loginStartedMsg{session: s, openErr: open(s.URL)}
	}
}

func (l *loginView) waitCmd(s *weblogin.Session) tea.Cmd {
	ctx, cancel := context.WithTimeout(context.Background(), weblogin.Timeout)
	l.cancelWait = cancel
	return func() tea.Msg {
		token, err := s.Wait(ctx)
		return loginTokenMsg{session: s, token: token, err: err}
	}
}

func (l *loginView) exchangeCmd(token string) tea.Cmd {
	l.step = stepValidating
	client, verifier := l.client, l.session.Verifier
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		tokens, user, err := client.ExchangeIDEToken(ctx, token, verifier)
		res := loginResult{key: tokens.Access, tokens: tokens, email: user.Email, plan: user.PlanName, web: true}
		return loginKeyMsg{res: res, err: err}
	}
}

// keyCmd verifica una API key. Un gateway antiguo sin /api/key/info se acepta
// si la clave lista los modelos, como hacía lixbon setup.
func (l *loginView) keyCmd(key string) tea.Cmd {
	l.step = stepValidating
	client := l.client
	client.SetKey(key)
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		info, err := client.KeyInfo(ctx)
		if err != nil && !api.IsAuth(err) {
			_, err = client.Models(ctx)
		}
		return loginKeyMsg{res: loginResult{key: key, keyModel: info.KeyModel, plan: info.PlanName}, err: err}
	}
}

// update procesa un mensaje del login; devuelve el comando y si terminó.
func (l *loginView) update(msg tea.Msg) (tea.Cmd, loginOutcome) {
	switch msg := msg.(type) {
	case loginStartedMsg:
		if l.step != stepBrowser {
			if msg.session != nil {
				msg.session.Close()
			}
			return nil, loginPending
		}
		if msg.err != nil {
			l.fail(stepMethod, msg.err)
			return nil, loginPending
		}
		l.session, l.openErr, l.deadline = msg.session, msg.openErr, time.Now().Add(weblogin.Timeout)
		return l.waitCmd(msg.session), loginPending
	case loginTokenMsg:
		if msg.session != l.session || errors.Is(msg.err, context.Canceled) {
			return nil, loginPending
		}
		if msg.err != nil {
			l.fail(stepMethod, msg.err)
			l.stopWaiting()
			return nil, loginPending
		}
		return l.exchangeCmd(msg.token), loginPending
	case loginKeyMsg:
		if msg.err != nil {
			back := stepAPIKey
			if msg.res.web {
				back = stepMethod
			}
			l.fail(back, msg.err)
			l.stopWaiting()
			return nil, loginPending
		}
		l.stopWaiting()
		l.step, l.result = stepDone, msg.res
		return nil, loginPending
	case tea.PasteMsg:
		if l.step == stepPaste || l.step == stepAPIKey {
			var cmd tea.Cmd
			l.input, cmd = l.input.Update(msg)
			return cmd, loginPending
		}
	case tea.KeyPressMsg:
		return l.key(msg)
	}
	return nil, loginPending
}

func (l *loginView) key(msg tea.KeyPressMsg) (tea.Cmd, loginOutcome) {
	k := msg.String()
	if k == "ctrl+c" {
		l.stopWaiting()
		return nil, loginSkipped
	}
	switch l.step {
	case stepMethod:
		switch k {
		case "up", "k", "shift+tab":
			l.cursor = 0
		case "down", "j", "tab":
			l.cursor = 1
		case "1":
			l.cursor = 0
			return l.startBrowser(), loginPending
		case "2":
			l.cursor, l.step = 1, stepAPIKey
			return l.newInput(true), loginPending
		case "enter":
			if l.cursor == 0 {
				return l.startBrowser(), loginPending
			}
			l.step = stepAPIKey
			return l.newInput(true), loginPending
		case "esc":
			return nil, loginSkipped
		}
	case stepBrowser:
		switch k {
		case "c":
			if l.session != nil {
				l.copied = time.Now()
				url := l.session.URL
				return tea.Batch(tea.SetClipboard(url), func() tea.Msg { _ = l.copyText(url); return nil }), loginPending
			}
		case "p":
			if l.session != nil {
				l.step = stepPaste
				return l.newInput(false), loginPending
			}
		case "esc":
			l.stopWaiting()
			l.step = stepMethod
		}
	case stepPaste:
		switch k {
		case "esc":
			l.step = stepBrowser
		case "enter":
			if l.session == nil {
				return nil, loginPending
			}
			token, err := weblogin.ParseCallbackURL(l.input.Value(), l.session.State)
			if err != nil {
				l.fail(stepPaste, err)
				return nil, loginPending
			}
			if l.cancelWait != nil {
				l.cancelWait()
				l.cancelWait = nil
			}
			return l.exchangeCmd(token), loginPending
		default:
			var cmd tea.Cmd
			l.input, cmd = l.input.Update(msg)
			return cmd, loginPending
		}
	case stepAPIKey:
		switch k {
		case "esc":
			if l.entry == stepAPIKey {
				return nil, loginSkipped
			}
			l.step = stepMethod
		case "enter":
			if key := strings.TrimSpace(l.input.Value()); key != "" {
				return l.keyCmd(key), loginPending
			}
		default:
			var cmd tea.Cmd
			l.input, cmd = l.input.Update(msg)
			return cmd, loginPending
		}
	case stepFailed:
		switch k {
		case "esc":
			l.step = stepMethod
		case "enter":
			switch l.back {
			case stepAPIKey:
				l.step = stepAPIKey
				return l.input.Focus(), loginPending
			case stepPaste:
				l.step = stepPaste
			default:
				l.step = stepMethod
			}
		}
	case stepDone:
		if k == "enter" || k == "esc" {
			return nil, loginFinished
		}
	}
	return nil, loginPending
}

// applyLogin guarda en la configuración la sesión recién iniciada.
func applyLogin(cfg *config.Config, res loginResult) {
	cfg.APIKey, cfg.KeyModel = res.key, res.keyModel
	if res.keyModel != "" {
		cfg.Model = res.keyModel
	}
	cfg.SetExtraString("account_email", res.email)
	if res.plan != "" {
		cfg.SetExtraString("plan_name", res.plan)
	}
}

func (res loginResult) summary() string {
	who := "Clave verificada"
	if res.email != "" {
		who = "Sesión iniciada como " + res.email
	}
	if res.plan != "" {
		who += " " + glyphSep + " plan " + res.plan
	}
	return who
}

// ── pantalla ─────────────────────────────────────────────────────────────

func center(s string, width int) string {
	return strings.Repeat(" ", max(0, (width-ansi.StringWidth(s))/2)) + s
}

func (l *loginView) card(inner int) (title, boxTitle string, rows []panelRow, border string, hint string) {
	sep := sDim2.Render(" " + glyphSep + " ")
	l.input.SetWidth(max(4, inner-14))
	border = pal.faint
	switch l.step {
	case stepMethod:
		title = "Inicia sesión para empezar"
		opt := func(i int, label, desc string) []panelRow {
			on := l.cursor == i
			bg, bar, labelStyle := "", " ", sPrimary
			if on {
				bg, bar, labelStyle = pal.surf2, sAccent.Render(glyphEdge), sBold
			}
			right := ""
			if on {
				right = sDim.Render("↵")
			}
			return []panelRow{
				{text: fitRight(bar+" "+labelStyle.Render(label), right, inner+1), bg: bg},
				{text: "  " + sDim.Render(desc), bg: bg},
			}
		}
		rows = append(opt(0, "Continuar con lixbon.com", "Abre lixbon.com con tu sesión o entra allí"), panelRow{})
		rows = append(rows, opt(1, "Usar una API key", "Pega una clave lixbon_sk_ creada en Cuenta › Claves")...)
		esc := "salir"
		switch l.place {
		case loginStartup:
			esc = "continuar sin sesión"
		case loginCommand:
			esc = "volver"
		}
		hint = keyHints([2]string{"↑↓", "elegir"}, [2]string{"↵", "continuar"}, [2]string{"esc", esc})
	case stepBrowser:
		title, boxTitle = "Continúa en tu navegador", "Continuar con lixbon.com"
		left := sAccent.Render(l.frame()) + " " + sPrimary.Render("Esperando la autorización en lixbon.com…")
		clock := ""
		if !l.deadline.IsZero() {
			rest := max(0, time.Until(l.deadline))
			clock = sDim.Render(fmt.Sprintf("%d:%02d", int(rest.Minutes()), int(rest.Seconds())%60))
		}
		rows = append(rows, panelRow{text: fitRight(left, clock, inner+1)}, panelRow{})
		if l.openErr != nil {
			rows = append(rows, panelRow{text: "  " + sWarn.Render("No se pudo abrir el navegador; entra tú en:")})
		} else {
			rows = append(rows, panelRow{text: "  " + sDim.Render("Si no se abrió solo, entra en:")})
		}
		url := "preparando el enlace…"
		if l.session != nil {
			url = l.session.URL
		}
		rows = append(rows, panelRow{text: "  " + sPlan.Underline(true).Render(ansi.Truncate(url, max(4, inner-2), glyphEllipsis))}, panelRow{})
		if time.Since(l.copied) < 1600*time.Millisecond {
			rows = append(rows, panelRow{text: "  " + sOK.Render(glyphs.check+" Enlace copiado al portapapeles")})
		} else {
			rows = append(rows, panelRow{text: "  " + keyHint("c", "copiar enlace") + sep + keyHint("p", "pegar la dirección final")})
		}
		hint = keyHints([2]string{"esc", "volver"})
	case stepPaste:
		title, boxTitle = "Pega la dirección a la que volvió el navegador", "Pegar la dirección final"
		rows = append(rows,
			panelRow{text: "  " + sDim.Render("Si el navegador no puede volver a esta terminal, por")},
			panelRow{text: "  " + sDim.Render("ejemplo en SSH, copia aquí la dirección que muestra.")},
			panelRow{},
			panelRow{text: sAccent.Render(glyphPrompt) + " " + l.input.View()})
		hint = keyHints([2]string{"↵", "continuar"}, [2]string{"esc", "volver"})
	case stepAPIKey, stepValidating, stepFailed:
		title, boxTitle = "Usa una clave de API", "Usar una API key"
		if l.step == stepFailed && l.back != stepAPIKey {
			title, boxTitle = "No se pudo iniciar sesión", "Continuar con lixbon.com"
		}
		if l.back == stepAPIKey || l.step != stepFailed {
			rows = append(rows,
				panelRow{text: "  " + sDim.Render("Créala en lixbon.com › Cuenta › Claves. Se guarda en")},
				panelRow{text: "  " + sDim.Render("~/.lixbon/config.json, legible solo por tu usuario.")},
				panelRow{})
			count := ""
			if n := len([]rune(l.input.Value())); n > 0 {
				count = sDim.Render(fmt.Sprintf("%d car.", n))
			}
			rows = append(rows, panelRow{text: fitRight(sAccent.Render(glyphPrompt)+" "+l.input.View(), count, inner+1)})
		}
		switch l.step {
		case stepValidating:
			rows = append(rows, panelRow{}, panelRow{text: sAccent.Render(l.frame()) + " " + sPrimary.Render("Verificando…")})
			hint = sDim.Render("un momento")
		case stepFailed:
			border = pal.err
			rows = append(rows, panelRow{}, panelRow{text: sErr.Render(glyphDot + " " + l.errMsg)})
			hint = keyHints([2]string{"↵", "reintentar"}, [2]string{"esc", "volver"})
		default:
			hint = keyHints([2]string{"↵", "verificar"}, [2]string{"esc", "volver"})
		}
	case stepDone:
		title = "Todo listo"
		detail := "guardada en ~/.lixbon/config.json"
		if l.result.web {
			detail = "sesión de este equipo guardada en ~/.lixbon/sessions.json"
		}
		if l.result.plan != "" {
			detail = "plan " + l.result.plan + " " + glyphSep + " " + detail
		}
		head := sOK.Render(glyphs.check) + " " + sPrimary.Render("Clave verificada")
		if l.result.email != "" {
			head = sOK.Render(glyphs.check) + " " + sPrimary.Render("Sesión iniciada como ") + sBold.Render(l.result.email)
		}
		next := "Abrir el chat"
		if l.place == loginStandalone {
			next = "Continuar"
		}
		rows = append(rows, panelRow{text: head}, panelRow{text: "  " + sDim.Render(detail)}, panelRow{},
			panelRow{text: fitRight(sAccent.Render(glyphEdge)+" "+sBold.Render(next), sDim.Render("↵"), inner+1), bg: pal.surf2})
		hint = keyHints([2]string{"↵", strings.ToLower(next)})
	}
	return title, boxTitle, rows, border, hint
}

func (l *loginView) view(width, height int) string {
	width, height = max(width, 1), max(height, 1)
	boxWidth := min(60, width-2)
	title, boxTitle, rows, border, hint := l.card(boxWidth - 4)
	box := panel(rows, boxWidth, border, boxTitle)

	var lines []string
	need := len(box) + 6
	if height >= need+13 {
		lines = append(lines, "", "")
		for _, r := range renderLogo(logoSize) {
			lines = append(lines, center(r, width))
		}
		lines = append(lines, "")
	}
	if height >= need+5 {
		for _, r := range renderWordmark() {
			lines = append(lines, center(r, width))
		}
		lines = append(lines, "")
	}
	lines = append(lines, center(sSoft.Render(title), width))
	if l.notice != "" {
		lines = append(lines, center(sWarn.Render(ansi.Truncate(l.notice, max(1, width-2), glyphEllipsis)), width))
	}
	lines = append(lines, "")
	pad := strings.Repeat(" ", max(0, (width-boxWidth)/2))
	for _, b := range box {
		lines = append(lines, pad+b)
	}
	lines = append(lines, "", center(hint, width))
	for len(lines) < height-1 {
		lines = append(lines, "")
	}
	lines = append(lines, center(sDim2.Render("lixbon.com"+"  "+glyphSep+"  "+"CLI "+l.version), width))
	if len(lines) > height {
		lines = lines[len(lines)-height:]
	}
	for i, line := range lines {
		lines[i] = ansi.Truncate(line, width, "")
	}
	return strings.Join(lines, "\n")
}

// ── dentro del chat ──────────────────────────────────────────────────────

func (m *Model) openLogin(place loginPlace, step loginStep, notice string) tea.Cmd {
	l := newLoginView(place, *m.chat.Client, m.opts.Version, &m.spin)
	l.copyText = m.copyText
	l.notice = notice
	m.login = l
	cmds := []tea.Cmd{m.startTick()}
	if step == stepAPIKey {
		l.step, l.entry = stepAPIKey, stepAPIKey
		cmds = append(cmds, l.newInput(true))
	}
	return tea.Batch(cmds...)
}

func (m *Model) updateLogin(msg tea.Msg) tea.Cmd {
	cmd, outcome := m.login.update(msg)
	switch outcome {
	case loginFinished:
		res := m.login.result
		m.login = nil
		applyLogin(&m.chat.Cfg, res)
		if err := adoptLogin(m.chat.Client, m.chat.Cfg, res); err != nil {
			m.add(errLine("No se pudo guardar la sesión: " + err.Error()))
		}
		if res.keyModel != "" {
			m.chat.SetModel(res.keyModel)
		}
		m.saveConfig()
		m.add(okLine(res.summary()))
		return tea.Batch(cmd, m.connectAfterLogin())
	case loginSkipped:
		place := m.login.place
		m.login = nil
		if place == loginCommand {
			m.add(note("Inicio de sesión cancelado."))
		}
	}
	return cmd
}

// connectAfterLogin sondea la cuenta con la clave nueva y elige modelo como al
// arrancar: el que fije el servidor o, si no se puede decidir, el selector.
func (m *Model) connectAfterLogin() tea.Cmd {
	return m.async("consultando la cuenta", func(ctx context.Context) cmdDoneMsg {
		acc := m.chat.QueryAccount(ctx)
		return cmdDoneMsg{apply: func(m *Model) {
			m.chat.ApplyAccount(acc)
			m.opts.Account = acc
			m.online = acc.State != chat.AccountOffline
			m.afterProviderProbe(acc)
		}}
	})
}
