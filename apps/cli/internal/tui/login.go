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
	// provider: se eligió entrar con otro proveedor; el chat abre /provider.
	provider bool
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
		n := len(l.methods())
		switch k {
		case "up", "k", "shift+tab":
			l.cursor = (l.cursor + n - 1) % n
		case "down", "j", "tab":
			l.cursor = (l.cursor + 1) % n
		case "1", "2", "3":
			if i := int(k[0] - '1'); i < n {
				l.cursor = i
				return l.choose()
			}
		case "enter":
			return l.choose()
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
		case "o":
			if l.session != nil {
				url := l.session.URL
				return func() tea.Msg { _ = l.open(url); return nil }, loginPending
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

// choose sigue por la forma de entrar elegida.
func (l *loginView) choose() (tea.Cmd, loginOutcome) {
	switch l.cursor {
	case 0:
		return l.startBrowser(), loginPending
	case 1:
		l.step = stepAPIKey
		return l.newInput(true), loginPending
	}
	l.provider = true
	return nil, loginSkipped
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

// loginScreen es lo que enseña un paso: título y subtítulo centrados, el
// cuerpo en una columna, una nota al pie de la columna y las teclas abajo.
type loginScreen struct {
	title, sub string
	body       []string
	note       string
	hints      [][2]string
}

// methods son las formas de entrar; la del proveedor solo desde el chat.
func (l *loginView) methods() [][2]string {
	out := [][2]string{{"Con el navegador", "recomendado"}, {"Con una API key", "lixbon_sk_…"}}
	if l.place != loginStandalone {
		out = append(out, [2]string{"Con otro proveedor", "OpenRouter, Ollama…"})
	}
	return out
}

// choice es una opción del login: la elegida en banda con la señal ›.
func choice(on bool, label, note string, width int) string {
	if !on {
		return "    " + fitRight(sSoft.Render(label), sDim.Render(note), max(1, width-4))
	}
	return padRow(fitRight(sAccent.Render(glyphPrompt)+" "+sInk.Render(label), sDim.Render(note), max(1, width-3)), pal.surf2, width)
}

// loginField es la caja de texto del login: una banda con la señal delante.
func loginField(input, right string, width int) string {
	return padRow(fitRight(sAccent.Render(glyphPrompt)+" "+input, right, max(1, width-3)), pal.surf2, width)
}

func (l *loginView) screen(width int) loginScreen {
	l.input.SetWidth(max(4, width-16))
	mid := func(s string) string { return center(s, width) }
	switch l.step {
	case stepMethod:
		s := loginScreen{title: "Entra en lixbon", sub: "para usar tu plan, tus modelos y tus conversaciones",
			note: "Aquí nunca te pediremos el correo ni la contraseña."}
		for i, m := range l.methods() {
			s.body = append(s.body, choice(l.cursor == i, m[0], m[1], width))
		}
		esc := "salir"
		switch l.place {
		case loginStartup:
			esc = "entrar sin sesión"
		case loginCommand:
			esc = "volver"
		}
		s.hints = [][2]string{{"↑↓", "elegir"}, {"enter", "seguir"}, {"esc", esc}}
		return s
	case stepBrowser:
		s := loginScreen{title: "Termina en el navegador", sub: "abrimos lixbon.com en tu navegador para que autorices este equipo"}
		if l.openErr != nil {
			s.sub = "no se pudo abrir el navegador: entra tú en el enlace"
		}
		url := "preparando el enlace…"
		if l.session != nil {
			url = l.session.URL
		}
		s.body = []string{mid(sDim.Render("enlace")), mid(sSoft.Render(ansi.Truncate(url, max(4, width), glyphEllipsis))), ""}
		clock := ""
		if !l.deadline.IsZero() {
			rest := max(0, time.Until(l.deadline))
			clock = sDim.Render(fmt.Sprintf("   %d:%02d", int(rest.Minutes()), int(rest.Seconds())%60))
		}
		status := sAccent.Render(l.frame()) + " " + sSoft.Render("esperando") + clock
		if time.Since(l.copied) < 1600*time.Millisecond {
			status = sOK.Render(glyphs.check) + " " + sSoft.Render("enlace copiado")
		}
		s.body = append(s.body, mid(status))
		s.note = "Si el navegador no puede volver aquí (por SSH, por ejemplo), pulsa p."
		s.hints = [][2]string{{"c", "copiar el enlace"}, {"o", "abrirlo otra vez"}, {"p", "pegar la dirección"}, {"esc", "volver"}}
		return s
	case stepPaste:
		return loginScreen{title: "Pega la dirección final", sub: "la que enseña el navegador tras autorizar",
			body:  []string{loginField(l.input.View(), "", width)},
			hints: [][2]string{{"enter", "seguir"}, {"esc", "volver"}}}
	case stepAPIKey, stepValidating, stepFailed:
		s := loginScreen{title: "Con una API key", sub: "créala en lixbon.com › Cuenta › Claves",
			note: "Se guarda en ~/.lixbon/config.json, legible solo por tu usuario."}
		fromKey := l.back == stepAPIKey || l.step != stepFailed
		if !fromKey {
			s = loginScreen{title: "No se pudo iniciar sesión", sub: "vuelve a intentarlo o entra con una API key"}
		}
		if fromKey {
			count := ""
			if n := len([]rune(l.input.Value())); n > 0 {
				count = sDim.Render(fmt.Sprintf("%d car.", n))
			}
			s.body = []string{loginField(l.input.View(), count, width)}
		}
		switch l.step {
		case stepValidating:
			s.body = append(s.body, "", mid(sAccent.Render(l.frame())+" "+sSoft.Render("verificando")))
			s.hints = [][2]string{{"", "un momento"}}
		case stepFailed:
			s.body = append(s.body, "", mid(sErr.Render(glyphs.cross)+" "+sSoft.Render(ansi.Truncate(l.errMsg, max(4, width-2), glyphEllipsis))))
			s.hints = [][2]string{{"enter", "reintentar"}, {"esc", "volver"}}
		default:
			s.hints = [][2]string{{"enter", "verificar"}, {"esc", "volver"}}
		}
		return s
	}
	// stepDone
	sub := "clave verificada"
	if l.result.email != "" {
		sub = "sesión iniciada como " + l.result.email
	}
	detail := "guardada en ~/.lixbon/config.json"
	if l.result.web {
		detail = "la sesión de este equipo queda en ~/.lixbon/sessions.json"
	}
	if l.result.plan != "" {
		detail = "Plan " + l.result.plan + "   " + detail
	}
	next := "Abrir el chat"
	if l.place == loginStandalone {
		next = "Continuar"
	}
	return loginScreen{title: sOK.Render(glyphs.check) + " " + sInk.Render("Todo listo"), sub: sub,
		body:  []string{mid(sDim.Render(detail)), "", choice(true, next, "", width)},
		hints: [][2]string{{"enter", strings.ToLower(next)}}}
}

// view es la pantalla del login, propia y centrada: el prisma, el título, el
// cuerpo y una nota, y las teclas al pie.
func (l *loginView) view(width, height int) string {
	width, height = max(width, 1), max(height, 1)
	colW := min(58, width-4)
	if l.step == stepBrowser {
		colW = min(72, width-4)
	}
	s := l.screen(max(10, colW))

	var block []string
	title := s.title
	if !strings.Contains(title, "\x1b[") {
		title = sInk.Render(title)
	}
	block = append(block, center(title, width), center(sSoft.Render(s.sub), width))
	if l.notice != "" {
		block = append(block, center(sWarn.Render(glyphWarn+" ")+sSoft.Render(ansi.Truncate(l.notice, max(1, width-4), glyphEllipsis)), width))
	}
	block = append(block, "", "")
	pad := strings.Repeat(" ", max(0, (width-colW)/2))
	for _, b := range s.body {
		block = append(block, pad+b)
	}
	if s.note != "" {
		block = append(block, "", "", center(sDim.Render(s.note), width))
	}
	var keys []string
	for _, k := range s.hints {
		if k[0] == "" {
			keys = append(keys, sDim.Render(k[1]))
			continue
		}
		keys = append(keys, keyHint(k[0], k[1]))
	}
	hints := center(strings.Join(keys, "      "), width)

	// El prisma grande si cabe; si no, el de la tarjeta; si tampoco, nada.
	room := height - len(block) - 2
	var logo []string
	for _, size := range []int{logoSize, cardLogoSize} {
		if rows := renderLogo(size); len(rows) > 0 && len(rows)+2 <= room-2 {
			for _, r := range rows {
				logo = append(logo, center(r, width))
			}
			logo = append(logo, "", "")
			break
		}
	}
	content := append(logo, block...)
	top := max(0, (height-2-len(content))/2)
	lines := make([]string, 0, height)
	for range top {
		lines = append(lines, "")
	}
	lines = append(lines, content...)
	for len(lines) < height-2 {
		lines = append(lines, "")
	}
	lines = append(lines, hints, "")
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
		place, provider := m.login.place, m.login.provider
		m.login = nil
		if provider {
			return tea.Batch(cmd, m.dispatch("/provider"))
		}
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
