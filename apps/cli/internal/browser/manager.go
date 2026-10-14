package browser

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed inject.js
var injectJS string

var ErrNoBrowser = errors.New("no hay navegador abierto: empieza con browser_navigate")

const (
	loadTimeout     = 15 * time.Second
	navStartWait    = 400 * time.Millisecond
	maxScreenshot   = 1500 << 10
	textChunk       = 5500
	maxWaitSeconds  = 10
	screenshotWidth = 1280
	unchangedNote   = "La página no cambió (el snapshot anterior sigue valiendo)."
	cursorGlide     = 420 * time.Millisecond
	hoverWait       = 200 * time.Millisecond
)

type tab struct {
	targetID  string
	sessionID string
	contextID int
	auraID    string
	console   bool
}

type targetInfo struct {
	TargetID string `json:"targetId"`
	Type     string `json:"type"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	OpenerID string `json:"openerId"`
}

// Manager es el navegador de una sesión del CLI. Se abre al primer
// browser_navigate y se cierra con Close. Lo usa un turno cada vez.
type Manager struct {
	opts Options

	mu       sync.Mutex
	conn     *conn
	proc     *process
	owned    bool
	tabs     map[string]*tab
	order    []string
	cur      *tab
	labels   map[string]label
	nextRef  int
	lastSent string
	// Última posición del cursor visible, para que siga desde ahí tras navegar.
	cursorX, cursorY float64
	hasCursor        bool
	// active: el agente lo está usando en este turno y se ve el aviso.
	active bool

	// evMu protege lo que escriben los eventos desde el lector del websocket,
	// que no puede esperar a mu (mu se tiene mientras se espera una respuesta).
	evMu    sync.Mutex
	notices []string
	popups  []targetInfo
	gone    []string
	resume  string
	// console son los errores de JavaScript de las páginas locales.
	console     []string
	consoleMore int
}

func New(opts Options) *Manager {
	return &Manager{opts: opts, tabs: map[string]*tab{}, labels: map[string]label{}, nextRef: 1}
}

func (m *Manager) Options() Options { return m.opts }

// Run ejecuta una herramienta browser_*. Las capturas vuelven aparte del texto.
func (m *Manager) Run(ctx context.Context, tool string, args map[string]any) (string, [][]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var (
		out string
		err error
	)
	switch tool {
	case "browser_navigate":
		out, err = m.navigate(ctx, strArg(args, "url"), boolArg(args, "new_tab"))
	case "browser_snapshot":
		out, err = m.snapshotTool(ctx, boolArg(args, "all"))
	case "browser_click":
		out, err = m.click(ctx, normRef(strArg(args, "ref")))
	case "browser_type":
		clear := true
		if _, ok := args["clear"]; ok {
			clear = boolArg(args, "clear")
		}
		out, err = m.typeText(ctx, normRef(strArg(args, "ref")), strArg(args, "text"), boolArg(args, "submit"), clear)
	case "browser_press_key":
		out, err = m.pressKey(ctx, strArg(args, "key"))
	case "browser_scroll":
		out, err = m.scroll(ctx, strArg(args, "direction"), normRef(strArg(args, "ref")))
	case "browser_screenshot":
		var img []byte
		out, img, err = m.screenshot(ctx)
		if err == nil {
			return out, [][]byte{img}, nil
		}
	case "browser_get_text":
		out, err = m.getText(ctx, intArg(args, "offset"))
	case "browser_tabs":
		out, err = m.tabsTool(ctx, strArg(args, "action"), intArg(args, "index"), strArg(args, "url"))
	case "browser_wait":
		out, err = m.wait(ctx, strArg(args, "text"), intArg(args, "seconds"))
	case "browser_back":
		out, err = m.back(ctx)
	default:
		err = fmt.Errorf("herramienta de navegador desconocida: %s", tool)
	}
	if errors.Is(err, errDisconnected) {
		err = errors.New("se cerró el navegador; vuelve a abrir la página con browser_navigate")
	}
	return out, nil, err
}

// Origin es el origen sobre el que actuará la herramienta: la URL de destino
// al navegar y la página actual en el resto. Sirve para pedir permiso.
func (m *Manager) Origin(ctx context.Context, tool string, args map[string]any) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	switch tool {
	case "browser_navigate":
		u, err := NormalizeURL(strArg(args, "url"))
		return Origin(u), err
	case "browser_tabs":
		switch strings.ToLower(strings.TrimSpace(strArg(args, "action"))) {
		case "new":
			raw := strArg(args, "url")
			if raw == "" {
				return "", nil
			}
			u, err := NormalizeURL(raw)
			return Origin(u), err
		case "close":
			return m.tabOriginAt(ctx, intArg(args, "index"))
		}
	case "browser_back":
		t, err := m.page(ctx, false)
		if err != nil {
			return "", err
		}
		entries, idx, err := m.history(ctx, t)
		if err != nil {
			return "", err
		}
		if idx <= 0 {
			return "", errors.New("no hay página anterior en esta pestaña")
		}
		return Origin(entries[idx-1].URL), nil
	}
	t, err := m.page(ctx, false)
	if err != nil {
		return "", err
	}
	return m.tabOrigin(ctx, t)
}

// Describe da la etiqueta de una ref del último snapshot («button «Pagar»»)
// y si es un campo sensible (contraseña, tarjeta, código).
func (m *Manager) Describe(ref string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	l, ok := m.labels[normRef(ref)]
	if !ok {
		return "", false
	}
	return l.Text, l.Sensitive
}

func (m *Manager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conn != nil && m.conn.alive()
}

// Status resume el estado para /browser.
func (m *Manager) Status(ctx context.Context) string {
	lines := []string{"Navegador: " + m.opts.Executable, "Perfil: " + m.opts.ProfileDir}
	// La interfaz lo llama en su goroutine: si el agente lo está usando, no
	// se espera.
	if !m.mu.TryLock() {
		return strings.Join(append(lines, "Estado: en uso por el agente"), "\n")
	}
	defer m.mu.Unlock()
	if m.conn == nil || !m.conn.alive() {
		return strings.Join(append(lines, "Estado: cerrado (se abre con la primera página que pida el agente)"), "\n")
	}
	state := "abierto por esta sesión"
	if !m.owned {
		state = "abierto por otra sesión (adjunto)"
	}
	lines = append(lines, "Estado: "+state)
	if pages, err := m.pages(ctx); err == nil {
		for i, p := range pages {
			mark := ""
			if m.cur != nil && p.TargetID == m.cur.targetID {
				mark = " (actual)"
			}
			lines = append(lines, fmt.Sprintf("  %d. %s · %s%s", i+1, oneLine(p.Title, 60), oneLine(p.URL, 100), mark))
		}
	}
	return strings.Join(lines, "\n")
}

// Close cierra el navegador si lo abrió esta sesión (o lo adoptó porque su
// dueño murió); si solo estaba adjunta, se desconecta y lo deja abierto.
func (m *Manager) Close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.conn == nil {
		return
	}
	if m.owned && !m.opts.KeepOpen {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = m.conn.call(ctx, "", "Browser.close", nil, nil)
		cancel()
		if m.proc != nil {
			select {
			case <-m.proc.exited:
			case <-time.After(3 * time.Second):
				_ = m.proc.cmd.Process.Kill()
			}
		}
		_ = os.Remove(filepath.Join(m.opts.ProfileDir, markerFile))
	} else {
		m.clearAura()
	}
	m.conn.close()
	m.reset()
}

// Release suelta el navegador al acabar el turno: quita el aviso (el agente
// ya no lo usa) y apunta la pestaña en la que quedó, para retomarla después.
func (m *Manager) Release() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.active || m.conn == nil || !m.conn.alive() {
		return
	}
	m.active = false
	m.clearAura()
	if m.cur == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	rememberTab(m.opts.ProfileDir, m.cur.targetID)
	pages, err := m.pages(ctx)
	if err != nil {
		return
	}
	for i, p := range pages {
		if p.TargetID == m.cur.targetID {
			// Solo la URL: el título lo pone la página y esto va al prompt de sistema.
			text := fmt.Sprintf("Navegador: sigue abierto; al terminar tu último turno con él quedaste en la pestaña %d/%d (%s). "+
				"Si la tarea continúa ahí, empieza con browser_snapshot en vez de volver a abrirla.", i+1, len(pages), sanitize(oneLine(p.URL, 120)))
			m.evMu.Lock()
			m.resume = text
			m.evMu.Unlock()
			return
		}
	}
}

// Resume dice dónde quedó el agente en el navegador, o "" si no hay nada
// que retomar. No espera al turno en curso.
func (m *Manager) Resume() string {
	if m.mu.TryLock() {
		alive := m.conn != nil && m.conn.alive()
		m.mu.Unlock()
		if !alive {
			return ""
		}
	}
	m.evMu.Lock()
	defer m.evMu.Unlock()
	return m.resume
}

// clearAura quita el aviso de las pestañas: el agente ya no las usa.
func (m *Manager) clearAura() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for _, t := range m.tabs {
		if t.auraID != "" {
			_ = m.conn.call(ctx, t.sessionID, "Page.removeScriptToEvaluateOnNewDocument", map[string]any{"identifier": t.auraID}, nil)
			t.auraID = ""
		}
		_ = m.evaluate(ctx, t, "unaura()", nil)
	}
}

// arm enseña el aviso en la pestaña que va a usar el agente, también en cada
// documento que cargue, hasta Release.
func (m *Manager) arm(ctx context.Context, t *tab) {
	m.active = true
	if t.auraID != "" {
		return
	}
	var script struct {
		Identifier string `json:"identifier"`
	}
	if m.conn.call(ctx, t.sessionID, "Page.addScriptToEvaluateOnNewDocument",
		map[string]any{"source": auraScript(), "worldName": "lixbon"}, &script) == nil {
		t.auraID = script.Identifier
	}
	_ = m.evaluate(ctx, t, "aura()", nil)
}

func (m *Manager) reset() {
	m.conn, m.proc, m.owned, m.cur, m.active = nil, nil, false, nil, false
	m.tabs, m.order, m.lastSent = map[string]*tab{}, nil, ""
	m.evMu.Lock()
	m.resume = ""
	m.evMu.Unlock()
}

func (m *Manager) ensure(ctx context.Context, mayLaunch bool) error {
	if m.conn != nil && m.conn.alive() {
		return nil
	}
	if m.conn != nil {
		m.reset()
	}
	dir := m.opts.ProfileDir
	if c, err := attachExisting(ctx, dir); err == nil {
		m.conn = c
		if m.owned = orphaned(dir); m.owned {
			adoptMarker(dir)
		}
	} else {
		if !mayLaunch {
			return ErrNoBrowser
		}
		proc, url, err := launch(ctx, m.opts)
		if err != nil {
			return err
		}
		c, err := dial(ctx, url)
		if err != nil {
			_ = proc.cmd.Process.Kill()
			return fmt.Errorf("no pude conectar con el navegador: %w", err)
		}
		m.conn, m.proc, m.owned = c, proc, true
	}
	m.conn.setHandler(m.onEvent(m.conn))
	_ = m.conn.call(ctx, "", "Target.setDiscoverTargets", map[string]any{"discover": true}, nil)
	_ = m.conn.call(ctx, "", "Browser.setDownloadBehavior", map[string]any{"behavior": "deny"}, nil)
	return nil
}

// onEvent corre en el lector del websocket: no puede llamar a c.call ahí
// mismo (esperaría a su propio lector), así que lo hace en otra goroutine.
func (m *Manager) onEvent(c *conn) func(session, method string, params json.RawMessage) {
	return func(session, method string, params json.RawMessage) {
		switch method {
		case "Page.javascriptDialogOpening":
			var d struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			}
			_ = json.Unmarshal(params, &d)
			accept := d.Type == "alert" || d.Type == "beforeunload"
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = c.call(ctx, session, "Page.handleJavaScriptDialog", map[string]any{"accept": accept}, nil)
			}()
			verb := "lo cancelé"
			if accept {
				verb = "lo acepté"
			}
			m.notice(fmt.Sprintf("La página mostró un diálogo (%s) «%s» y %s.", d.Type, oneLine(d.Message, 120), verb))
		case "Runtime.exceptionThrown", "Runtime.consoleAPICalled", "Log.entryAdded":
			if text := consoleEvent(method, params); text != "" {
				m.consoleError(text)
			}
		case "Target.targetCreated":
			var p struct {
				TargetInfo targetInfo `json:"targetInfo"`
			}
			if json.Unmarshal(params, &p) == nil && p.TargetInfo.Type == "page" && p.TargetInfo.OpenerID != "" {
				m.evMu.Lock()
				m.popups = append(m.popups, p.TargetInfo)
				m.evMu.Unlock()
			}
		case "Target.targetDestroyed", "Target.detachedFromTarget":
			var p struct {
				TargetID string `json:"targetId"`
			}
			if json.Unmarshal(params, &p) == nil && p.TargetID != "" {
				m.evMu.Lock()
				m.gone = append(m.gone, p.TargetID)
				m.evMu.Unlock()
			}
		}
	}
}

func (m *Manager) notice(text string) {
	m.evMu.Lock()
	m.notices = append(m.notices, text)
	m.evMu.Unlock()
}

func (m *Manager) takeNotices() []string {
	m.evMu.Lock()
	defer m.evMu.Unlock()
	n := m.notices
	if len(m.console) > 0 {
		lines := []string{"Errores en la consola de la página:"}
		for _, c := range m.console {
			lines = append(lines, "- "+c)
		}
		if m.consoleMore > 0 {
			lines = append(lines, fmt.Sprintf("- (y %d más)", m.consoleMore))
		}
		n = append(n, strings.Join(lines, "\n"))
	}
	m.notices, m.console, m.consoleMore = nil, nil, 0
	return n
}

const maxConsoleErrors = 6

// consoleError apunta un error de JavaScript de una página local, sin
// repetir: un fallo en un listener de scroll sale en cada evento.
func (m *Manager) consoleError(text string) {
	text = sanitize(oneLine(text, 200))
	m.evMu.Lock()
	defer m.evMu.Unlock()
	switch {
	case slices.Contains(m.console, text):
	case len(m.console) >= maxConsoleErrors:
		m.consoleMore++
	default:
		m.console = append(m.console, text)
	}
}

// watchConsole activa la consola solo en páginas locales (lo que construye
// el agente o el localhost del usuario). En webs ajenas se queda apagada:
// Runtime.enable es de lo primero que buscan los detectores de bots.
func (m *Manager) watchConsole(ctx context.Context, t *tab, local bool) {
	if local == t.console {
		return
	}
	verb := ".disable"
	if local {
		verb = ".enable"
	}
	for _, domain := range []string{"Runtime", "Log"} {
		_ = m.conn.call(ctx, t.sessionID, domain+verb, nil, nil)
	}
	t.console = local
	if local {
		// Al activarse llegan mensajes viejos de la página anterior.
		sleep(ctx, 50*time.Millisecond)
		m.evMu.Lock()
		m.console, m.consoleMore = nil, 0
		m.evMu.Unlock()
	}
}

type remoteObject struct {
	Type        string          `json:"type"`
	Value       json.RawMessage `json:"value"`
	Description string          `json:"description"`
}

func (o remoteObject) String() string {
	if o.Description != "" {
		return o.Description
	}
	var s string
	if json.Unmarshal(o.Value, &s) == nil {
		return s
	}
	return string(o.Value)
}

// consoleEvent traduce los eventos de consola de CDP a una línea legible.
func consoleEvent(method string, params json.RawMessage) string {
	where := func(url string, line int) string {
		if url == "" {
			return ""
		}
		if i := strings.LastIndex(url, "/"); i >= 0 {
			url = url[i+1:]
		}
		if url == "" {
			url = "el HTML"
		}
		return fmt.Sprintf(" (%s, línea %d)", url, line+1)
	}
	switch method {
	case "Runtime.exceptionThrown":
		var p struct {
			Details struct {
				Text      string        `json:"text"`
				URL       string        `json:"url"`
				Line      int           `json:"lineNumber"`
				Exception *remoteObject `json:"exception"`
			} `json:"exceptionDetails"`
		}
		if json.Unmarshal(params, &p) != nil {
			return ""
		}
		d := p.Details
		msg := d.Text
		if d.Exception != nil && d.Exception.Description != "" {
			msg, _, _ = strings.Cut(d.Exception.Description, "\n")
		}
		return msg + where(d.URL, d.Line)
	case "Runtime.consoleAPICalled":
		var p struct {
			Type string         `json:"type"`
			Args []remoteObject `json:"args"`
		}
		if json.Unmarshal(params, &p) != nil || (p.Type != "error" && p.Type != "assert") {
			return ""
		}
		parts := make([]string, len(p.Args))
		for i, a := range p.Args {
			parts[i] = a.String()
		}
		return "console.error: " + strings.Join(parts, " ")
	case "Log.entryAdded":
		var p struct {
			Entry struct {
				Level string `json:"level"`
				Text  string `json:"text"`
				URL   string `json:"url"`
			} `json:"entry"`
		}
		// El navegador pide /favicon.ico por su cuenta: su 404 no es un fallo de la página.
		if json.Unmarshal(params, &p) != nil || p.Entry.Level != "error" || strings.HasSuffix(p.Entry.URL, "/favicon.ico") {
			return ""
		}
		text := p.Entry.Text
		if p.Entry.URL != "" {
			text += " → " + p.Entry.URL
		}
		return text
	}
	return ""
}

func (m *Manager) sync() {
	m.evMu.Lock()
	gone := m.gone
	m.gone = nil
	m.evMu.Unlock()
	for _, id := range gone {
		delete(m.tabs, id)
		m.order = slices.DeleteFunc(m.order, func(s string) bool { return s == id })
		if m.cur != nil && m.cur.targetID == id {
			m.cur = nil
		}
	}
}

// adoptPopup pasa a la pestaña que acaba de abrir la actual (target=_blank,
// window.open): es lo que el usuario vería.
func (m *Manager) adoptPopup(ctx context.Context) {
	m.evMu.Lock()
	popups := m.popups
	m.popups = nil
	m.evMu.Unlock()
	if m.cur == nil {
		return
	}
	for _, p := range popups {
		if p.OpenerID != m.cur.targetID {
			continue
		}
		if t, err := m.attach(ctx, p.TargetID); err == nil {
			m.cur = t
			m.notice("Se abrió una pestaña nueva y pasé a ella.")
			loaded, stop := m.conn.on(t.sessionID, "Page.loadEventFired")
			waitEvent(ctx, loaded, 5*time.Second, nil)
			stop()
		}
		return
	}
}

func (m *Manager) pages(ctx context.Context) ([]targetInfo, error) {
	var res struct {
		TargetInfos []targetInfo `json:"targetInfos"`
	}
	if err := m.conn.call(ctx, "", "Target.getTargets", nil, &res); err != nil {
		return nil, err
	}
	byID := map[string]targetInfo{}
	for _, t := range res.TargetInfos {
		if t.Type == "page" && !internalPage(t.URL) {
			byID[t.TargetID] = t
		}
	}
	m.order = slices.DeleteFunc(m.order, func(id string) bool { _, ok := byID[id]; return !ok })
	for _, t := range res.TargetInfos {
		if _, ok := byID[t.TargetID]; ok && !slices.Contains(m.order, t.TargetID) {
			m.order = append(m.order, t.TargetID)
		}
	}
	out := make([]targetInfo, len(m.order))
	for i, id := range m.order {
		out[i] = byID[id]
	}
	return out, nil
}

// page es la pestaña actual, con el navegador ya abierto (o adjunto).
func (m *Manager) page(ctx context.Context, mayLaunch bool) (*tab, error) {
	if err := m.ensure(ctx, mayLaunch); err != nil {
		return nil, err
	}
	m.sync()
	if m.cur != nil {
		m.arm(ctx, m.cur)
		return m.cur, nil
	}
	pages, err := m.pages(ctx)
	if err != nil {
		return nil, err
	}
	if len(pages) == 0 {
		return m.newTab(ctx)
	}
	target := pages[len(pages)-1].TargetID
	if mk, ok := readMarker(m.opts.ProfileDir); ok && slices.ContainsFunc(pages, func(p targetInfo) bool { return p.TargetID == mk.Tab }) {
		target = mk.Tab
	}
	return m.attach(ctx, target)
}

func (m *Manager) newTab(ctx context.Context) (*tab, error) {
	var res struct {
		TargetID string `json:"targetId"`
	}
	if err := m.conn.call(ctx, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &res); err != nil {
		return nil, err
	}
	m.order = append(m.order, res.TargetID)
	return m.attach(ctx, res.TargetID)
}

func (m *Manager) attach(ctx context.Context, targetID string) (*tab, error) {
	if t := m.tabs[targetID]; t != nil {
		m.cur = t
		m.arm(ctx, t)
		return t, nil
	}
	var res struct {
		SessionID string `json:"sessionId"`
	}
	if err := m.conn.call(ctx, "", "Target.attachToTarget", map[string]any{"targetId": targetID, "flatten": true}, &res); err != nil {
		return nil, err
	}
	t := &tab{targetID: targetID, sessionID: res.SessionID}
	// Sin Runtime.enable: varios detectores de bots lo buscan, y los
	// contextos caducados se notan por el error al evaluar.
	if err := m.conn.call(ctx, t.sessionID, "Page.enable", nil, nil); err != nil {
		return nil, err
	}
	m.tabs[targetID] = t
	m.cur = t
	m.arm(ctx, t)
	return t, nil
}

func (m *Manager) tabOrigin(ctx context.Context, t *tab) (string, error) {
	var res struct {
		TargetInfo targetInfo `json:"targetInfo"`
	}
	if err := m.conn.call(ctx, "", "Target.getTargetInfo", map[string]any{"targetId": t.targetID}, &res); err != nil {
		return "", err
	}
	return Origin(res.TargetInfo.URL), nil
}

// actPage es la pestaña sobre la que se va a actuar, comprobando que sigue en
// el origen que el usuario aprobó.
func (m *Manager) actPage(ctx context.Context) (*tab, error) {
	t, err := m.page(ctx, false)
	if err != nil {
		return nil, err
	}
	if want, ok := expectedOrigin(ctx); ok {
		got, err := m.tabOrigin(ctx, t)
		if err != nil {
			return nil, err
		}
		if got != want {
			return nil, fmt.Errorf("la página cambió a %s desde que se aprobó la acción; vuelve a mirar el snapshot", got)
		}
	}
	return t, nil
}

// evaluate llama a __lx.<call> en un mundo aislado: la página no ve sus
// variables ni puede falsear las refs. Si una navegación destruyó el mundo,
// se crea otro y se reintenta.
func (m *Manager) evaluate(ctx context.Context, t *tab, call string, out any) error {
	expr := fmt.Sprintf("((globalThis.__lx ??= %s).seed(%d), globalThis.__lx).%s", strings.TrimSpace(injectJS), m.nextRef, call)
	for range 3 {
		if t.contextID == 0 {
			var w struct {
				ExecutionContextID int `json:"executionContextId"`
			}
			err := m.conn.call(ctx, t.sessionID, "Page.createIsolatedWorld",
				map[string]any{"frameId": t.targetID, "worldName": "lixbon", "grantUniveralAccess": true}, &w)
			if err != nil {
				if isContextLost(err) {
					sleep(ctx, 200*time.Millisecond)
					continue
				}
				return err
			}
			t.contextID = w.ExecutionContextID
		}
		var res struct {
			Result struct {
				Value json.RawMessage `json:"value"`
			} `json:"result"`
			ExceptionDetails *struct {
				Text      string `json:"text"`
				Exception *struct {
					Description string `json:"description"`
				} `json:"exception"`
			} `json:"exceptionDetails"`
		}
		err := m.conn.call(ctx, t.sessionID, "Runtime.evaluate", map[string]any{
			"expression": expr, "contextId": t.contextID, "returnByValue": true, "awaitPromise": true,
		}, &res)
		if isContextLost(err) {
			t.contextID = 0
			sleep(ctx, 150*time.Millisecond)
			continue
		}
		if err != nil {
			return err
		}
		if d := res.ExceptionDetails; d != nil {
			msg := d.Text
			if d.Exception != nil && d.Exception.Description != "" {
				msg = d.Exception.Description
			}
			if isContextLost(errors.New(msg)) {
				t.contextID = 0
				continue
			}
			return fmt.Errorf("error al leer la página: %s", oneLine(msg, 200))
		}
		if out != nil && len(res.Result.Value) > 0 {
			return json.Unmarshal(res.Result.Value, out)
		}
		return nil
	}
	return errors.New("la página se recargó mientras la leía; vuelve a intentarlo")
}

func (m *Manager) settle(ctx context.Context, t *tab) {
	sctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_ = m.evaluate(sctx, t, "settle(250, 2000)", nil)
}

// afterAction ejecuta una acción que puede navegar y espera a que la página
// cargue y se calme antes del snapshot.
func (m *Manager) afterAction(ctx context.Context, t *tab, action func() error) error {
	started, stopStarted := m.conn.on(t.sessionID, "Page.frameStartedLoading")
	// Al volver desde la bfcache no hay loadEventFired, pero sí frameStoppedLoading.
	stopped, stopStopped := m.conn.on(t.sessionID, "Page.frameStoppedLoading")
	defer stopStarted()
	defer stopStopped()
	if err := action(); err != nil {
		return err
	}
	mainFrame := func(p json.RawMessage) bool {
		var f struct {
			FrameID string `json:"frameId"`
		}
		_ = json.Unmarshal(p, &f)
		return f.FrameID == t.targetID
	}
	if waitEvent(ctx, started, navStartWait, mainFrame) && !waitEvent(ctx, stopped, loadTimeout, mainFrame) {
		m.notice("La página sigue cargando; el snapshot puede estar incompleto.")
	}
	m.sync()
	m.adoptPopup(ctx)
	if m.cur == nil {
		if _, err := m.page(ctx, false); err != nil {
			return err
		}
	}
	m.settle(ctx, m.cur)
	return ctx.Err()
}

func (m *Manager) snapshot(ctx context.Context, t *tab, all bool) (rendered, error) {
	var d snapshotData
	opts, _ := json.Marshal(map[string]any{"all": all})
	if err := m.evaluate(ctx, t, "snapshot("+string(opts)+")", &d); err != nil {
		return rendered{}, err
	}
	m.nextRef = max(m.nextRef, d.Next)
	r := render(d, all)
	m.labels = r.Labels
	return r, nil
}

// pageResult arma el resultado de una herramienta: qué pasó, avisos y el
// snapshot. sameShort: si la página no cambió desde el último snapshot
// enviado, solo se dice eso (sirve también para saber que el clic no hizo nada).
func (m *Manager) pageResult(ctx context.Context, t *tab, outcome string, all, sameShort bool) (string, error) {
	r, err := m.snapshot(ctx, t, all)
	if err != nil {
		return "", err
	}
	var lines []string
	if outcome != "" {
		lines = append(lines, outcome)
	}
	lines = append(lines, m.takeNotices()...)
	if len(m.order) > 1 {
		if i := slices.Index(m.order, t.targetID); i >= 0 {
			r.Header = fmt.Sprintf("Pestaña %d/%d · %s", i+1, len(m.order), r.Header)
		}
	}
	page := r.String()
	if sameShort && page == m.lastSent {
		return strings.Join(append(lines, unchangedNote), "\n"), nil
	}
	m.lastSent = page
	return strings.Join(append(lines, page), "\n"), nil
}

func (m *Manager) navigate(ctx context.Context, raw string, inNewTab bool) (string, error) {
	u, err := NormalizeURL(raw)
	if err != nil {
		return "", err
	}
	t, err := m.page(ctx, true)
	if err != nil {
		return "", err
	}
	if inNewTab {
		if t, err = m.newTab(ctx); err != nil {
			return "", err
		}
	}
	m.watchConsole(ctx, t, IsLoopback(Origin(u)))
	loaded, stop := m.conn.on(t.sessionID, "Page.loadEventFired")
	defer stop()
	var nav struct {
		LoaderID  string `json:"loaderId"`
		ErrorText string `json:"errorText"`
	}
	if err := m.conn.call(ctx, t.sessionID, "Page.navigate", map[string]any{"url": u}, &nav); err != nil {
		return "", err
	}
	if nav.ErrorText != "" {
		return "", fmt.Errorf("no se pudo abrir %s: %s", u, nav.ErrorText)
	}
	if nav.LoaderID != "" && !waitEvent(ctx, loaded, loadTimeout, nil) {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		m.notice("La página sigue cargando; el snapshot puede estar incompleto.")
	}
	_ = m.conn.call(ctx, "", "Target.activateTarget", map[string]any{"targetId": t.targetID}, nil)
	m.settle(ctx, t)
	return m.pageResult(ctx, t, "Abrí "+u, false, false)
}

func (m *Manager) snapshotTool(ctx context.Context, all bool) (string, error) {
	t, err := m.page(ctx, false)
	if err != nil {
		return "", err
	}
	return m.pageResult(ctx, t, "", all, false)
}

type point struct {
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
	Cover string  `json:"cover"`
	Err   string  `json:"err"`
	// Exp es aria-expanded antes del clic ("" si el elemento no lo tiene).
	Exp string `json:"exp"`
	// Close son los botones de la capa que tapa al elemento.
	Close []control `json:"close"`
}

type control struct {
	Ref  string `json:"ref"`
	Role string `json:"role"`
	Name string `json:"name"`
}

// refError explica por qué no se pudo usar ref. Si la página se redibujó,
// acompaña el snapshot nuevo: así el modelo elige la ref buena sin otro paso.
func (m *Manager) refError(ctx context.Context, t *tab, ref, code string) error {
	switch code {
	case "stale":
		snap, err := m.pageResult(ctx, t, "", false, false)
		if err != nil {
			return fmt.Errorf("la ref %s ya no existe en la página (cambió o navegó): mira un browser_snapshot nuevo", ref)
		}
		return fmt.Errorf("la ref %s ya no existe: la página se redibujó y sus elementos tienen refs nuevas. "+
			"Usa las de este snapshot:\n%s", ref, snap)
	case "hidden":
		return fmt.Errorf("%s no está visible ahora; desplázate o abre el menú que lo contiene", ref)
	}
	return fmt.Errorf("%s: %s", ref, code)
}

// coverError dice qué tapa a ref y con qué botones se cierra: «ciérralo» a
// secas no basta, el modelo seguía intentando el clic de detrás.
func (m *Manager) coverError(ref string, p point) error {
	msg := fmt.Sprintf("no hice clic: %s%s está tapado por «%s».", ref, m.labelOf(ref), sanitize(oneLine(p.Cover, 80)))
	if len(p.Close) == 0 {
		return errors.New(msg + " Ciérralo (busca su botón en el snapshot o prueba browser_press_key Escape) o desplázate")
	}
	return errors.New(msg + " Ciérralo primero con " + m.controlList(p.Close) + " (o browser_press_key Escape) y repite el clic")
}

func (m *Manager) controlList(cs []control) string {
	var parts []string
	for _, c := range cs {
		l := elementLabel(snapNode{Role: c.Role, Name: c.Name})
		m.labels[c.Ref] = label{Text: l}
		parts = append(parts, "["+c.Ref+"] "+l)
	}
	return strings.Join(parts, " · ")
}

func (m *Manager) labelOf(ref string) string {
	if l, ok := m.labels[ref]; ok {
		return " (" + l.Text + ")"
	}
	return ""
}

func (m *Manager) locate(ctx context.Context, t *tab, ref string) (point, error) {
	var p point
	if err := m.evaluate(ctx, t, "point("+quote(ref)+")", &p); err != nil {
		return p, err
	}
	if p.Err != "" {
		return p, m.refError(ctx, t, ref, p.Err)
	}
	return p, nil
}

func (m *Manager) click(ctx context.Context, ref string) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", errors.New("falta ref (p. ej. e12, del snapshot)")
	}
	t, err := m.actPage(ctx)
	if err != nil {
		return "", err
	}
	p, err := m.locate(ctx, t, ref)
	if err != nil {
		return "", err
	}
	if p.Cover != "" {
		return "", m.coverError(ref, p)
	}
	outcome := "Clic en " + ref + m.labelOf(ref)
	hoverOpened := false
	err = m.afterAction(ctx, t, func() error {
		target, err := m.aim(ctx, t, ref, p)
		if err != nil {
			return err
		}
		// Muchos menús se abren al pasar el ratón y el clic los alterna: pulsar
		// después de abrirlos los cerraría, también a una persona.
		if p.Exp == "false" && sleep(ctx, hoverWait) && m.expanded(ctx, t, ref) == "true" {
			hoverOpened = true
			return nil
		}
		return m.press(ctx, t, target.X, target.Y)
	})
	if err != nil {
		return "", err
	}
	switch now := m.expanded(ctx, m.cur, ref); {
	case hoverOpened:
		outcome += " → se desplegó al pasar el ratón (no pulsé: el clic lo habría vuelto a plegar)"
	case p.Exp == "" || now == "":
	case now == "true":
		outcome += " → desplegado"
	case p.Exp == "true":
		outcome += " → plegado"
	default:
		outcome += " → sigue plegado"
	}
	return m.pageResult(ctx, m.cur, outcome, false, true)
}

func (m *Manager) expanded(ctx context.Context, t *tab, ref string) string {
	var exp *string
	if m.evaluate(ctx, t, "expanded("+quote(ref)+")", &exp) != nil || exp == nil {
		return ""
	}
	return *exp
}

// auraScript pinta el aviso en cada documento nuevo de la pestaña, en cuanto
// el DOM existe; solo en el marco principal.
func auraScript() string {
	return "(() => { if (window !== window.top) return; const lx = (globalThis.__lx ??= " + strings.TrimSpace(injectJS) + ");" +
		" if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => lx.aura(), { once: true });" +
		" else lx.aura(); })()"
}

// aim lleva el ratón hasta ref y espera a que el elemento se quede quieto:
// mover el ratón puede cerrar un menú abierto por hover y desplazar la
// página, y el clic caería en otro elemento.
func (m *Manager) aim(ctx context.Context, t *tab, ref string, p point) (point, error) {
	for range 4 {
		if err := m.moveTo(ctx, t, p.X, p.Y); err != nil {
			return p, err
		}
		sleep(ctx, 60*time.Millisecond)
		q, err := m.locate(ctx, t, ref)
		if err != nil {
			return p, err
		}
		if q.Cover != "" {
			return q, m.coverError(ref, q)
		}
		if math.Abs(q.X-p.X) < 1 && math.Abs(q.Y-p.Y) < 1 {
			return q, nil
		}
		p = q
	}
	return p, fmt.Errorf("%s%s no deja de moverse (animación o carga); espera con browser_wait y reinténtalo", ref, m.labelOf(ref))
}

// moveTo desliza el cursor visible del agente hasta (x, y), para que el
// usuario vea adónde va, y luego mueve allí el ratón de la página.
func (m *Manager) moveTo(ctx context.Context, t *tab, x, y float64) error {
	if !m.opts.Headless {
		from := "undefined, undefined"
		if m.hasCursor {
			from = fmt.Sprintf("%g, %g", m.cursorX, m.cursorY)
		}
		_ = m.evaluate(ctx, t, fmt.Sprintf("cursor(%g, %g, %s)", x, y, from), nil)
		sleep(ctx, cursorGlide)
	}
	m.cursorX, m.cursorY, m.hasCursor = x, y, true
	return m.conn.call(ctx, t.sessionID, "Input.dispatchMouseEvent", map[string]any{"type": "mouseMoved", "x": x, "y": y}, nil)
}

// press pulsa y suelta en (x, y) y deja una marca donde pulsó.
func (m *Manager) press(ctx context.Context, t *tab, x, y float64) error {
	_ = m.evaluate(ctx, t, fmt.Sprintf("ripple(%g, %g)", x, y), nil)
	steps := []map[string]any{
		{"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1},
		{"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1},
	}
	for _, s := range steps {
		if err := m.conn.call(ctx, t.sessionID, "Input.dispatchMouseEvent", s, nil); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) dispatchKey(ctx context.Context, t *tab, def keyDef, mods int) error {
	down := map[string]any{
		"type": "rawKeyDown", "modifiers": mods, "key": def.Key, "code": def.Code,
		"windowsVirtualKeyCode": def.KeyCode, "nativeVirtualKeyCode": def.KeyCode,
	}
	if def.Text != "" {
		down["type"], down["text"], down["unmodifiedText"] = "keyDown", def.Text, def.Text
	}
	if err := m.conn.call(ctx, t.sessionID, "Input.dispatchKeyEvent", down, nil); err != nil {
		return err
	}
	return m.conn.call(ctx, t.sessionID, "Input.dispatchKeyEvent", map[string]any{
		"type": "keyUp", "modifiers": mods, "key": def.Key, "code": def.Code,
		"windowsVirtualKeyCode": def.KeyCode, "nativeVirtualKeyCode": def.KeyCode,
	}, nil)
}

func (m *Manager) typeText(ctx context.Context, ref, text string, submit, clear bool) (string, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return "", errors.New("falta ref (p. ej. e12, del snapshot)")
	}
	t, err := m.actPage(ctx)
	if err != nil {
		return "", err
	}
	shown := oneLine(text, 60)
	if l, ok := m.labels[ref]; ok && l.Sensitive {
		shown = "••••"
	}
	var f struct {
		Kind   string   `json:"kind"`
		Filled bool     `json:"filled"`
		Err    string   `json:"err"`
		Chosen string   `json:"chosen"`
		Opts   []string `json:"options"`
	}
	if err := m.evaluate(ctx, t, "focus("+quote(ref)+", false)", &f); err != nil {
		return "", err
	}
	if f.Err != "" {
		return "", m.refError(ctx, t, ref, f.Err)
	}
	if f.Kind == "select" {
		if err := m.evaluate(ctx, t, "choose("+quote(ref)+", "+quote(text)+")", &f); err != nil {
			return "", err
		}
		switch f.Err {
		case "":
		case "nooption":
			return "", fmt.Errorf("%s no tiene la opción «%s»; opciones: %s", ref, shown, strings.Join(f.Opts, " | "))
		default:
			return "", m.refError(ctx, t, ref, f.Err)
		}
		return m.pageResult(ctx, t, fmt.Sprintf("Elegí «%s» en %s%s", f.Chosen, ref, m.labelOf(ref)), false, true)
	}
	// Un clic real enfoca como lo haría el usuario (algunos campos solo se
	// activan así); si algo lo tapa, basta el foco por script.
	if p, err := m.locate(ctx, t, ref); err == nil && p.Cover == "" {
		if target, err := m.aim(ctx, t, ref, p); err == nil {
			if err := m.press(ctx, t, target.X, target.Y); err != nil {
				return "", err
			}
		}
	}
	if err := m.evaluate(ctx, t, "focus("+quote(ref)+", "+strconv.FormatBool(clear)+")", &f); err != nil {
		return "", err
	}
	if f.Err != "" {
		return "", m.refError(ctx, t, ref, f.Err)
	}
	if clear && f.Filled {
		def, _, _ := parseKey("Backspace")
		if err := m.dispatchKey(ctx, t, def, 0); err != nil {
			return "", err
		}
	}
	if text != "" {
		if err := m.conn.call(ctx, t.sessionID, "Input.insertText", map[string]any{"text": text}, nil); err != nil {
			return "", err
		}
	}
	outcome := fmt.Sprintf("Escribí «%s» en %s%s", shown, ref, m.labelOf(ref))
	if !submit {
		return outcome + ". Sin enviar: usa submit, browser_press_key Enter o el botón del formulario.", nil
	}
	enter, _, _ := parseKey("Enter")
	if err := m.afterAction(ctx, t, func() error { return m.dispatchKey(ctx, t, enter, 0) }); err != nil {
		return "", err
	}
	return m.pageResult(ctx, m.cur, outcome+" y pulsé Enter", false, true)
}

func (m *Manager) pressKey(ctx context.Context, key string) (string, error) {
	def, mods, err := parseKey(key)
	if err != nil {
		return "", err
	}
	t, err := m.actPage(ctx)
	if err != nil {
		return "", err
	}
	if err := m.afterAction(ctx, t, func() error { return m.dispatchKey(ctx, t, def, mods) }); err != nil {
		return "", err
	}
	return m.pageResult(ctx, m.cur, "Pulsé "+strings.TrimSpace(key), false, true)
}

func (m *Manager) scroll(ctx context.Context, direction, ref string) (string, error) {
	t, err := m.page(ctx, false)
	if err != nil {
		return "", err
	}
	if ref = strings.TrimSpace(ref); ref != "" {
		var r struct {
			Err string `json:"err"`
		}
		if err := m.evaluate(ctx, t, "scrollTo("+quote(ref)+")", &r); err != nil {
			return "", err
		}
		if r.Err != "" {
			return "", m.refError(ctx, t, ref, r.Err)
		}
		sleep(ctx, 200*time.Millisecond)
		return m.pageResult(ctx, t, "Desplacé hasta "+ref+m.labelOf(ref), false, true)
	}
	var vp struct {
		W float64 `json:"w"`
		H float64 `json:"h"`
	}
	if err := m.evaluate(ctx, t, "metrics()", &vp); err != nil {
		return "", err
	}
	delta := vp.H * 0.8
	word := "abajo"
	if strings.EqualFold(strings.TrimSpace(direction), "up") || strings.EqualFold(strings.TrimSpace(direction), "arriba") {
		delta, word = -delta, "arriba"
	}
	err = m.conn.call(ctx, t.sessionID, "Input.dispatchMouseEvent", map[string]any{
		"type": "mouseWheel", "x": vp.W / 2, "y": vp.H / 2, "deltaX": 0, "deltaY": delta,
	}, nil)
	if err != nil {
		return "", err
	}
	sleep(ctx, 350*time.Millisecond)
	m.settle(ctx, t)
	out, err := m.pageResult(ctx, t, "Desplacé hacia "+word, false, true)
	if err == nil && strings.HasSuffix(out, unchangedNote) {
		edge := "final"
		if delta < 0 {
			edge = "principio"
		}
		return "No se movió: ya estás al " + edge + " de la página (o esa zona no se desplaza).", nil
	}
	return out, err
}

func (m *Manager) screenshot(ctx context.Context) (string, []byte, error) {
	t, err := m.page(ctx, false)
	if err != nil {
		return "", nil, err
	}
	var lm struct {
		Viewport struct {
			PageX        float64 `json:"pageX"`
			PageY        float64 `json:"pageY"`
			ClientWidth  float64 `json:"clientWidth"`
			ClientHeight float64 `json:"clientHeight"`
		} `json:"cssVisualViewport"`
	}
	if err := m.conn.call(ctx, t.sessionID, "Page.getLayoutMetrics", nil, &lm); err != nil {
		return "", nil, err
	}
	var met struct {
		DPR float64 `json:"dpr"`
	}
	_ = m.evaluate(ctx, t, "metrics()", &met)
	if met.DPR <= 0 {
		met.DPR = 1
	}
	vp := lm.Viewport
	scale := 1.0
	if px := vp.ClientWidth * met.DPR; px > screenshotWidth {
		scale = screenshotWidth / px
	}
	var data []byte
	for _, quality := range []int{65, 45} {
		var res struct {
			Data string `json:"data"`
		}
		err := m.conn.call(ctx, t.sessionID, "Page.captureScreenshot", map[string]any{
			"format": "jpeg", "quality": quality,
			"clip": map[string]any{"x": vp.PageX, "y": vp.PageY, "width": vp.ClientWidth, "height": vp.ClientHeight, "scale": scale},
		}, &res)
		if err != nil {
			return "", nil, err
		}
		if data, err = base64.StdEncoding.DecodeString(res.Data); err != nil {
			return "", nil, err
		}
		if len(data) <= maxScreenshot {
			break
		}
	}
	w := int(vp.ClientWidth * met.DPR * scale)
	h := int(vp.ClientHeight * met.DPR * scale)
	var info struct {
		TargetInfo targetInfo `json:"targetInfo"`
	}
	_ = m.conn.call(ctx, "", "Target.getTargetInfo", map[string]any{"targetId": t.targetID}, &info)
	return fmt.Sprintf("Captura adjunta (%d×%d, %d KB) de «%s» · %s", w, h, len(data)>>10,
		sanitize(oneLine(info.TargetInfo.Title, 80)), sanitize(oneLine(info.TargetInfo.URL, 120))), data, nil
}

func (m *Manager) getText(ctx context.Context, offset int) (string, error) {
	t, err := m.page(ctx, false)
	if err != nil {
		return "", err
	}
	var r struct {
		Total int    `json:"total"`
		Text  string `json:"text"`
		Title string `json:"title"`
		URL   string `json:"url"`
	}
	offset = max(0, offset)
	if err := m.evaluate(ctx, t, fmt.Sprintf("readable(%d, %d)", offset, textChunk), &r); err != nil {
		return "", err
	}
	end := offset + len([]rune(r.Text))
	lines := []string{
		fmt.Sprintf("«%s» · %s · caracteres %d–%d de %d", sanitize(r.Title), sanitize(r.URL), offset, end, r.Total),
		PageOpen,
		strings.NewReplacer("<<<", "‹‹‹", ">>>", "›››").Replace(r.Text),
		PageClose,
	}
	if end < r.Total {
		lines = append(lines, fmt.Sprintf(`(sigue: browser_get_text {"offset":%d})`, end))
	}
	return strings.Join(lines, "\n"), nil
}

func (m *Manager) wait(ctx context.Context, text string, seconds int) (string, error) {
	t, err := m.page(ctx, false)
	if err != nil {
		return "", err
	}
	text = strings.TrimSpace(text)
	if seconds <= 0 {
		seconds = 2
		if text != "" {
			seconds = maxWaitSeconds
		}
	}
	seconds = min(seconds, maxWaitSeconds)
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	outcome := fmt.Sprintf("Esperé %d s", seconds)
	if text != "" {
		outcome = fmt.Sprintf("No apareció «%s» en %d s", oneLine(text, 60), seconds)
		for time.Now().Before(deadline) {
			var found bool
			if err := m.evaluate(ctx, t, "has("+quote(text)+")", &found); err == nil && found {
				outcome = fmt.Sprintf("Apareció «%s»", oneLine(text, 60))
				break
			}
			if !sleep(ctx, 300*time.Millisecond) {
				return "", ctx.Err()
			}
		}
	} else if !sleep(ctx, time.Until(deadline)) {
		return "", ctx.Err()
	}
	m.sync()
	m.adoptPopup(ctx)
	if m.cur == nil {
		if t, err = m.page(ctx, false); err != nil {
			return "", err
		}
	}
	return m.pageResult(ctx, m.cur, outcome, false, true)
}

type historyEntry struct {
	ID  int    `json:"id"`
	URL string `json:"url"`
}

func (m *Manager) history(ctx context.Context, t *tab) ([]historyEntry, int, error) {
	var h struct {
		CurrentIndex int            `json:"currentIndex"`
		Entries      []historyEntry `json:"entries"`
	}
	err := m.conn.call(ctx, t.sessionID, "Page.getNavigationHistory", nil, &h)
	return h.Entries, h.CurrentIndex, err
}

func (m *Manager) back(ctx context.Context) (string, error) {
	t, err := m.page(ctx, false)
	if err != nil {
		return "", err
	}
	entries, idx, err := m.history(ctx, t)
	if err != nil {
		return "", err
	}
	if idx <= 0 || idx > len(entries) {
		return "", errors.New("no hay página anterior en esta pestaña")
	}
	prev := entries[idx-1]
	if want, ok := expectedOrigin(ctx); ok && Origin(prev.URL) != want {
		return "", errors.New("el historial cambió desde que se aprobó la acción; vuelve a intentarlo")
	}
	err = m.afterAction(ctx, t, func() error {
		return m.conn.call(ctx, t.sessionID, "Page.navigateToHistoryEntry", map[string]any{"entryId": prev.ID}, nil)
	})
	if err != nil {
		return "", err
	}
	return m.pageResult(ctx, m.cur, "Volví a "+oneLine(prev.URL, 120), false, false)
}

func (m *Manager) tabsTool(ctx context.Context, action string, index int, raw string) (string, error) {
	action = strings.ToLower(strings.TrimSpace(action))
	switch action {
	case "new":
		if raw == "" {
			raw = "about:blank"
		}
		return m.navigate(ctx, raw, true)
	case "", "list", "select", "close":
	default:
		return "", fmt.Errorf("action debe ser list, new, select o close (no %s)", action)
	}
	if err := m.ensure(ctx, false); err != nil {
		return "", err
	}
	m.sync()
	pages, err := m.pages(ctx)
	if err != nil {
		return "", err
	}
	pick := func() (targetInfo, error) {
		if index < 1 || index > len(pages) {
			return targetInfo{}, fmt.Errorf("index debe estar entre 1 y %d", len(pages))
		}
		return pages[index-1], nil
	}
	switch action {
	case "select":
		p, err := pick()
		if err != nil {
			return "", err
		}
		t, err := m.attach(ctx, p.TargetID)
		if err != nil {
			return "", err
		}
		_ = m.conn.call(ctx, "", "Target.activateTarget", map[string]any{"targetId": t.targetID}, nil)
		return m.pageResult(ctx, t, fmt.Sprintf("Pasé a la pestaña %d", index), false, false)
	case "close":
		if index == 0 && m.cur != nil {
			index = slices.Index(m.order, m.cur.targetID) + 1
		}
		p, err := pick()
		if err != nil {
			return "", err
		}
		if want, ok := expectedOrigin(ctx); ok && Origin(p.URL) != want {
			return "", errors.New("las pestañas cambiaron desde que se aprobó la acción; vuelve a listarlas")
		}
		if err := m.conn.call(ctx, "", "Target.closeTarget", map[string]any{"targetId": p.TargetID}, nil); err != nil {
			return "", err
		}
		delete(m.tabs, p.TargetID)
		if m.cur != nil && m.cur.targetID == p.TargetID {
			m.cur = nil
		}
		if pages, err = m.pages(ctx); err != nil {
			return "", err
		}
	}
	if len(pages) == 0 {
		return "No quedan pestañas abiertas.", nil
	}
	lines := []string{fmt.Sprintf("%d pestañas:", len(pages))}
	for i, p := range pages {
		mark := ""
		if m.cur != nil && p.TargetID == m.cur.targetID {
			mark = " (actual)"
		}
		lines = append(lines, fmt.Sprintf("%d. «%s» · %s%s", i+1, sanitize(oneLine(p.Title, 60)), sanitize(oneLine(p.URL, 120)), mark))
	}
	return strings.Join(lines, "\n"), nil
}

// tabOriginAt es el origen de la pestaña index (1-based), o de la actual con 0.
func (m *Manager) tabOriginAt(ctx context.Context, index int) (string, error) {
	if err := m.ensure(ctx, false); err != nil {
		return "", err
	}
	m.sync()
	pages, err := m.pages(ctx)
	if err != nil {
		return "", err
	}
	if index == 0 {
		if m.cur == nil {
			return "", nil
		}
		index = slices.Index(m.order, m.cur.targetID) + 1
	}
	if index < 1 || index > len(pages) {
		return "", fmt.Errorf("index debe estar entre 1 y %d", len(pages))
	}
	return Origin(pages[index-1].URL), nil
}

// internalPage: diálogos propios del navegador (p. ej. el de sincronización
// de Edge) que no son pestañas del usuario ni del agente.
func internalPage(u string) bool {
	for _, p := range []string{"devtools://", "chrome-extension://", "chrome://", "chrome-untrusted://", "edge://", "brave://"} {
		if strings.HasPrefix(u, p) {
			return true
		}
	}
	return false
}

func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return true
	}
	select {
	case <-time.After(d):
		return true
	case <-ctx.Done():
		return false
	}
}

// normRef acepta la ref como la escriba el modelo: «e12», «[e12]», «E12».
func normRef(s string) string {
	return strings.ToLower(strings.Trim(strings.TrimSpace(s), "[]\"'` "))
}

func quote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func oneLine(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

func strArg(args map[string]any, key string) string {
	switch v := args[key].(type) {
	case string:
		return v
	case nil:
		return ""
	default:
		return fmt.Sprint(v)
	}
}

func boolArg(args map[string]any, key string) bool {
	switch v := args[key].(type) {
	case bool:
		return v
	case string:
		b, _ := strconv.ParseBool(strings.TrimSpace(v))
		return b
	case float64:
		return v != 0
	}
	return false
}

func intArg(args map[string]any, key string) int {
	switch v := args[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(v))
		return n
	}
	return 0
}
