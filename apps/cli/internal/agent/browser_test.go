package agent

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"lixbon.com/cli/internal/browser"
	"lixbon.com/cli/internal/history"
)

type fakeBrowser struct {
	origin string
	calls  []string
	urls   []string
	resume string
}

func (f *fakeBrowser) Run(ctx context.Context, tool string, args map[string]any) (string, [][]byte, error) {
	f.calls = append(f.calls, tool)
	switch tool {
	case "browser_navigate":
		f.urls = append(f.urls, stringArg(args, "url"))
		u, _ := browser.NormalizeURL(stringArg(args, "url"))
		f.origin = browser.Origin(u)
	case "browser_screenshot":
		return "Captura adjunta", [][]byte{[]byte("jpeg")}, nil
	}
	return tool + " hecho\n" + browser.PageOpen + "\n[e1] button «OK»\n" + browser.PageClose, nil, nil
}

func (f *fakeBrowser) Origin(ctx context.Context, tool string, args map[string]any) (string, error) {
	if tool == "browser_navigate" {
		u, err := browser.NormalizeURL(stringArg(args, "url"))
		return browser.Origin(u), err
	}
	return f.origin, nil
}

func (f *fakeBrowser) Describe(ref string) (string, bool) {
	if ref == "e9" {
		return "textbox «Contraseña»", true
	}
	return "button «OK»", false
}

func (f *fakeBrowser) Release()       {}
func (f *fakeBrowser) Resume() string { return f.resume }
func (f *fakeBrowser) Close()         {}

func browserRig(t *testing.T, replies []StreamResult, decisions ...Decision) (*rig, *fakeBrowser, *fakeApprover) {
	t.Helper()
	r := newRig(t, replies)
	fb := &fakeBrowser{}
	approver := &fakeApprover{decisions: decisions}
	s := r.turn.S
	s.Tools.Browser = fb
	s.BrowserMode = "on"
	s.Approver = approver
	return r, fb, approver
}

func calls(steps ...json.RawMessage) []StreamResult {
	out := make([]StreamResult, 0, len(steps)+1)
	for _, step := range steps {
		out = append(out, StreamResult{ToolCalls: []json.RawMessage{step}})
	}
	return append(out, StreamResult{Text: "listo"})
}

func TestBrowserAsksOncePerSiteAndAutoApproveDoesNotCoverIt(t *testing.T) {
	r, fb, approver := browserRig(t, calls(
		nativeCall("c1", "browser_navigate", map[string]any{"url": "tienda.com"}),
		nativeCall("c2", "browser_click", map[string]any{"ref": "e1"}),
		nativeCall("c3", "browser_navigate", map[string]any{"url": "otra.com"}),
	), AllowPrefix, Deny)
	r.run("compra")
	if len(approver.asked) != 2 {
		t.Fatalf("preguntas: %+v", approver.asked)
	}
	first := approver.asked[0]
	if first.Kind != ApproveBrowser || first.Prefix != "https://tienda.com" || first.Detail != "tienda.com" {
		t.Fatalf("primera aprobación: %+v", first)
	}
	if approver.asked[1].Prefix != "https://otra.com" {
		t.Fatalf("un sitio nuevo vuelve a preguntar: %+v", approver.asked[1])
	}
	if !slices.Equal(fb.calls, []string{"browser_navigate", "browser_click"}) {
		t.Fatalf("el rechazo no ejecuta: %v", fb.calls)
	}
	if !slices.Equal(r.turn.S.BrowserOrigins, []string{"https://tienda.com"}) || r.turn.S.AutoBrowser {
		t.Fatalf("origenes: %v auto=%v", r.turn.S.BrowserOrigins, r.turn.S.AutoBrowser)
	}
}

func TestBrowserLoopbackAndReadsDoNotAsk(t *testing.T) {
	r, fb, approver := browserRig(t, calls(
		nativeCall("c1", "browser_navigate", map[string]any{"url": "localhost:3000"}),
		nativeCall("c2", "browser_click", map[string]any{"ref": "e1"}),
		nativeCall("c3", "browser_snapshot", map[string]any{}),
	))
	r.run("prueba mi app")
	if len(approver.asked) != 0 || len(fb.calls) != 3 {
		t.Fatalf("preguntas %v, llamadas %v", approver.asked, fb.calls)
	}
}

func TestBrowserOpensWorkspaceFilesThroughALocalPreview(t *testing.T) {
	r, fb, approver := browserRig(t, calls(
		nativeCall("c1", "browser_navigate", map[string]any{"url": "web/index.html"}),
		nativeCall("c2", "browser_navigate", map[string]any{"url": "falta.html"}),
	))
	t.Cleanup(r.turn.S.Tools.Close)
	r.write("web/index.html", "<h1>hola</h1>")
	_, working := r.run("crea la página y revísala")
	if len(approver.asked) != 0 || len(fb.urls) != 1 ||
		!strings.HasPrefix(fb.urls[0], "http://127.0.0.1:") || !strings.HasSuffix(fb.urls[0], "/web/index.html") {
		t.Fatalf("la ruta se abre en la vista previa local sin pedir permiso: %v %v", fb.urls, approver.asked)
	}
	if last := working[len(working)-2]; !strings.Contains(last.Content, "no existe falta.html") {
		t.Fatalf("un archivo que no existe da un error claro: %q", last.Content)
	}
}

func TestBrowserSensitiveFieldAlwaysAsks(t *testing.T) {
	r, fb, approver := browserRig(t, calls(
		nativeCall("c1", "browser_type", map[string]any{"ref": "e9", "text": "hunter2"}),
	))
	r.turn.S.AutoBrowser = true
	r.run("entra")
	if len(approver.asked) != 1 || !approver.asked[0].Sensitive || strings.Contains(approver.asked[0].Summary, "hunter2") {
		t.Fatalf("aprobación sensible: %+v", approver.asked)
	}
	if len(fb.calls) != 0 {
		t.Fatal("denegado no escribe")
	}
	for _, e := range r.events {
		if strings.Contains(e.Text, "hunter2") {
			t.Fatalf("el texto sensible se ve en los eventos: %q", e.Text)
		}
	}
}

func TestBrowserPlanModeReadsButDoesNotAct(t *testing.T) {
	r, fb, _ := browserRig(t, calls(
		nativeCall("c1", "browser_snapshot", map[string]any{}),
		nativeCall("c2", "browser_click", map[string]any{"ref": "e1"}),
	))
	r.turn.S.PlanMode = true
	_, working := r.run("mira")
	if !slices.Equal(fb.calls, []string{"browser_snapshot"}) {
		t.Fatalf("llamadas: %v", fb.calls)
	}
	if !slices.ContainsFunc(working, func(m history.Message) bool { return strings.HasPrefix(m.Content, "[modo plan]") }) {
		t.Fatal("el modelo no recibió el bloqueo del modo plan")
	}
}

func TestBrowserAskModeBlocksActions(t *testing.T) {
	r, fb, _ := browserRig(t, nil)
	result, _, _ := r.turn.RunReadOnly(context.Background(), "browser_tabs", map[string]any{"action": "close", "index": 1.0})
	if !strings.Contains(result, "[modo ask]") || len(fb.calls) != 0 {
		t.Fatalf("tabs close en ask: %q %v", result, fb.calls)
	}
	result, _, _ = r.turn.RunReadOnly(context.Background(), "browser_click", map[string]any{"ref": "e1"})
	if !strings.Contains(result, "[modo ask]") {
		t.Fatalf("click en ask: %q", result)
	}
}

func TestBrowserToolsOnlyWhenEnabled(t *testing.T) {
	r, _, _ := browserRig(t, say("hola"))
	names := func() []string {
		_, list := r.turn.systemMessage(true)
		var out []string
		for _, s := range list {
			out = append(out, s["function"].(map[string]any)["name"].(string))
		}
		return out
	}
	if !slices.Contains(names(), "browser_click") || !slices.Contains(names(), "browser_screenshot") {
		t.Fatal("con el navegador activo se ofrecen sus herramientas")
	}
	r.turn.S.NoVision = true
	if slices.Contains(names(), "browser_screenshot") {
		t.Fatal("sin visión no hay captura")
	}
	r.turn.S.BrowserMode = "auto"
	if slices.Contains(names(), "browser_click") {
		t.Fatal("auto con ventana pequeña no ofrece el navegador")
	}
	r.turn.S.ContextWindow = BrowserMinContext
	if !slices.Contains(names(), "browser_click") {
		t.Fatal("auto con ventana suficiente sí")
	}
}

func TestBrowserResumeTellsWhereTheAgentLeftOff(t *testing.T) {
	r, fb, _ := browserRig(t, say("hola"))
	system := func() string { msg, _ := r.turn.systemMessage(true); return msg.Content }
	if strings.Contains(system(), "quedaste en") {
		t.Fatal("sin turno anterior en el navegador no hay registro")
	}
	fb.resume = "Navegador: sigue abierto; al terminar tu último turno con él quedaste en la pestaña 1/1 (https://lixbon.com/support)."
	if !strings.Contains(system(), "https://lixbon.com/support") {
		t.Fatal("el prompt dice en qué pestaña quedó el agente")
	}
	r.turn.S.BrowserMode = "off"
	if strings.Contains(system(), "quedaste en") {
		t.Fatal("con el navegador apagado no se menciona")
	}
}

func TestBrowserScreenshotGoesAsImageAndOnlyRecentImagesStay(t *testing.T) {
	r, _, _ := browserRig(t, calls(
		nativeCall("c1", "browser_screenshot", map[string]any{}),
		nativeCall("c2", "browser_scroll", map[string]any{}),
		nativeCall("c3", "browser_screenshot", map[string]any{}),
		nativeCall("c4", "browser_screenshot", map[string]any{}),
	))
	_, working := r.run("mira")
	live := 0
	for _, m := range working {
		if len(m.Images) > 0 {
			live++
		}
		if strings.Contains(m.Content, "anB") || (m.Role == "tool" && len(m.Content) > 200) {
			t.Fatalf("la imagen no va en el texto: %q", m.Content)
		}
	}
	if live != maxLiveImageGroups {
		t.Fatalf("imágenes vivas: %d", live)
	}
	for _, e := range r.events {
		if strings.Contains(e.Result, "anBlZw") {
			t.Fatal("base64 en los eventos")
		}
	}
}

func TestCollapseOldSnapshots(t *testing.T) {
	page := func(s string) string {
		return "Clic\n" + browser.PageOpen + "\n" + s + "\n" + browser.PageClose + "\n(3 más)"
	}
	msgs := []history.Message{
		{Role: "tool", Name: "browser_navigate", Content: page("vieja")},
		{Role: "tool", Name: "browser_click", Content: "Clic\n" + unchangedForTest},
		{Role: "tool", Name: "browser_click", Content: page("nueva")},
	}
	collapseOldSnapshots(msgs)
	if strings.Contains(msgs[0].Content, "vieja") || !strings.Contains(msgs[0].Content, snapshotOmitted) ||
		!strings.HasSuffix(msgs[0].Content, "(3 más)") {
		t.Fatalf("vieja: %q", msgs[0].Content)
	}
	if !strings.Contains(msgs[2].Content, "nueva") {
		t.Fatal("la última se conserva")
	}
}

const unchangedForTest = "La página no cambió (el snapshot anterior sigue valiendo)."

func TestRepeatedScrollIsNotStuck(t *testing.T) {
	steps := make([]json.RawMessage, 5)
	for i := range steps {
		steps[i] = nativeCall("c", "browser_scroll", map[string]any{"direction": "down"})
	}
	r, fb, _ := browserRig(t, calls(steps...))
	answer, _ := r.run("baja hasta el final")
	if answer != "listo" || len(fb.calls) != 5 {
		t.Fatalf("respuesta %q, llamadas %d", answer, len(fb.calls))
	}
}
