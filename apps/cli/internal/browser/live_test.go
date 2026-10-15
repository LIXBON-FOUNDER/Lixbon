package browser

import (
	"bytes"
	"context"
	"fmt"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

const livePage = `<!doctype html><html><head><title>Prueba Lixbon</title></head><body>
<h1>Formulario</h1>
<div onmouseleave="abrir(false)"><button id="prod" aria-expanded="false" onmouseenter="abrir(true)"
 onclick="abrir(this.getAttribute('aria-expanded') !== 'true')">Producto</button>
<div id="panel" hidden><a href="/other">Opción secreta</a></div></div>
<button aria-expanded="false" onclick="this.setAttribute('aria-expanded', this.getAttribute('aria-expanded') !== 'true')">Preguntas</button>
<script>function abrir(v) { prod.setAttribute('aria-expanded', v); panel.hidden = !v; }</script>
<form action="/result"><label>Buscar <input name="q"></label>
<select name="color"><option value="r">Rojo</option><option value="v">Verde</option></select>
<button>Enviar</button></form>
<div id="host"></div>
<iframe src="/frame" width="300" height="80"></iframe>
<a href="/other" target="_blank">Abrir otra</a>
<button onclick="alert('hola')">Alerta</button>
<p>Texto de la página con &lt;&lt;&lt;trampa&gt;&gt;&gt; dentro y <a href="/other">un enlace</a> en medio.</p>
<script>
const root = document.getElementById('host').attachShadow({mode:'open'});
root.innerHTML = '<button id="sb">Sombra</button>';
root.getElementById('sb').onclick = () => { document.title = 'sombra pulsada'; };
</script></body></html>`

// Como el aviso «Novedades» de WhatsApp Web: sin role=dialog, solo una capa
// fija que oscurece la página y una caja con su botón.
const modalPage = `<!doctype html><title>Chats</title><body>
<button id="chat" onclick="this.textContent='Chat abierto'">Presiga</button>
<button id="redraw" onclick="this.replaceWith(Object.assign(document.createElement('button'), {textContent: 'Redibujado'}))">Redibujar</button>
<div id="modal" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center">
 <div style="position:absolute;inset:0;background:rgba(0,0,0,.5)"></div>
 <div style="position:relative;background:#fff;padding:20px"><h2>Novedades en la web</h2><p>Personaliza tus chats</p>
 <button>Más información</button> <button onclick="modal.remove()">Continuar</button></div>
</div></body>`

func TestLiveModal(t *testing.T) {
	if os.Getenv("LIXBON_BROWSER_LIVE") != "1" {
		t.Skip("LIXBON_BROWSER_LIVE=1 para probar con un navegador real")
	}
	exe, err := FindExecutable(SystemEnv(), "")
	if err != nil {
		t.Skip(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, modalPage) }))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	m := New(Options{Executable: exe, ProfileDir: t.TempDir(), Headless: true})
	defer m.Close()
	ref := func(out, name string) string {
		t.Helper()
		mm := regexp.MustCompile(`\[(e\d+)\] \w+ «` + regexp.QuoteMeta(name)).FindStringSubmatch(out)
		if mm == nil {
			t.Fatalf("sin ref para %q en:\n%s", name, out)
		}
		return mm[1]
	}

	snap, _, err := m.Run(ctx, "browser_navigate", map[string]any{"url": srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(snap, "⚠ Hay una ventana abierta encima de la página («Novedades en la web»)") ||
		!strings.Contains(snap, "Ciérrala con ["+ref(snap, "Continuar")+"] button «Continuar»") {
		t.Fatalf("el snapshot avisa de la ventana y ofrece cerrarla:\n%s", snap)
	}
	_, _, err = m.Run(ctx, "browser_click", map[string]any{"ref": ref(snap, "Presiga")})
	if err == nil || !strings.Contains(err.Error(), "tapado por «Novedades en la web»") ||
		!strings.Contains(err.Error(), "Ciérralo primero con ["+ref(snap, "Continuar")+"] button «Continuar»") {
		t.Fatalf("el clic tapado dice con qué botón cerrar: %v", err)
	}
	out, _, err := m.Run(ctx, "browser_click", map[string]any{"ref": "[" + strings.ToUpper(ref(snap, "Continuar")) + "]"})
	if err != nil || strings.Contains(out, "⚠") {
		t.Fatalf("cerrar la ventana (ref con corchetes): %v\n%s", err, out)
	}
	if out, _, err = m.Run(ctx, "browser_click", map[string]any{"ref": ref(snap, "Presiga")}); err != nil || !strings.Contains(out, "Chat abierto") {
		t.Fatalf("sin la ventana, el clic llega: %v\n%s", err, out)
	}
	m.Run(ctx, "browser_click", map[string]any{"ref": ref(snap, "Redibujar")})
	_, _, err = m.Run(ctx, "browser_click", map[string]any{"ref": ref(snap, "Redibujar")})
	if err == nil || !strings.Contains(err.Error(), "se redibujó") || !strings.Contains(err.Error(), "button «Redibujado»") {
		t.Fatalf("una ref caducada trae el snapshot nuevo: %v", err)
	}
}

const brokenPage = `<!doctype html><title>Rota</title><link rel="stylesheet" href="falta.css">
<h1>Mi página</h1><script>console.error('fallo de prueba'); noExiste();</script>
<button onclick="otraFuncion()">Romper</button>`

func TestLiveConsoleErrorsOnLocalPages(t *testing.T) {
	if os.Getenv("LIXBON_BROWSER_LIVE") != "1" {
		t.Skip("LIXBON_BROWSER_LIVE=1 para probar con un navegador real")
	}
	exe, err := FindExecutable(SystemEnv(), "")
	if err != nil {
		t.Skip(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, brokenPage)
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	m := New(Options{Executable: exe, ProfileDir: t.TempDir(), Headless: true})
	defer m.Close()
	out, _, err := m.Run(ctx, "browser_navigate", map[string]any{"url": srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Errores en la consola de la página:", "console.error: fallo de prueba",
		"noExiste is not defined (el HTML, línea 2)", "falta.css"} {
		if !strings.Contains(out, want) {
			t.Fatalf("falta %q en:\n%s", want, out)
		}
	}
	ref := regexp.MustCompile(`\[(e\d+)\] button «Romper»`).FindStringSubmatch(out)
	out, _, err = m.Run(ctx, "browser_click", map[string]any{"ref": ref[1]})
	if err != nil || !strings.Contains(out, "otraFuncion is not defined") || strings.Contains(out, "fallo de prueba") {
		t.Fatalf("el error del clic llega una vez, sin repetir los de la carga: %v\n%s", err, out)
	}
}

// TestLive abre un navegador real (headless). Solo corre con
// LIXBON_BROWSER_LIVE=1 y un navegador Chromium instalado.
func TestLive(t *testing.T) {
	if os.Getenv("LIXBON_BROWSER_LIVE") != "1" {
		t.Skip("LIXBON_BROWSER_LIVE=1 para probar con un navegador real")
	}
	exe, err := FindExecutable(SystemEnv(), "")
	if err != nil {
		t.Skip(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, livePage) })
	mux.HandleFunc("/frame", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<button onclick="parent.document.title='marco pulsado'">Del marco</button>`)
	})
	mux.HandleFunc("/other", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<title>Otra</title><h1>Otra página</h1>`)
	})
	mux.HandleFunc("/result", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `<title>Resultado</title><h1>Buscaste %s en %s</h1>`, r.URL.Query().Get("q"), r.URL.Query().Get("color"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	m := New(Options{Executable: exe, ProfileDir: t.TempDir(), Headless: true})
	defer m.Close()
	run := func(tool string, args map[string]any) string {
		t.Helper()
		out, _, err := m.Run(ctx, tool, args)
		if err != nil {
			t.Fatalf("%s %v: %v", tool, args, err)
		}
		return out
	}
	refOf := func(snapshot, name string) string {
		t.Helper()
		re := regexp.MustCompile(`\[(e\d+)\] \w+ «` + regexp.QuoteMeta(name))
		m := re.FindStringSubmatch(snapshot)
		if m == nil {
			t.Fatalf("sin ref para %q en:\n%s", name, snapshot)
		}
		return m[1]
	}

	if _, _, err := m.Run(ctx, "browser_snapshot", nil); err == nil {
		t.Fatal("snapshot sin navegador abierto debe fallar, no abrirlo")
	}
	snap := run("browser_navigate", map[string]any{"url": srv.URL})
	if !strings.Contains(snap, "«Prueba Lixbon»") || !strings.Contains(snap, "con ‹‹‹trampa››› dentro y\n[e") ||
		!strings.Contains(snap, "«un enlace»\nen medio.") {
		t.Fatalf("snapshot inicial:\n%s", snap)
	}

	out := run("browser_click", map[string]any{"ref": refOf(snap, "Producto")})
	if !strings.Contains(out, "se desplegó al pasar el ratón") || !strings.Contains(out, "Opción secreta") {
		t.Fatalf("menú que se abre con hover:\n%s", out)
	}
	if out = run("browser_click", map[string]any{"ref": refOf(snap, "Preguntas")}); !strings.Contains(out, "→ desplegado") {
		t.Fatalf("botón que despliega con clic:\n%s", out)
	}
	out = run("browser_click", map[string]any{"ref": refOf(snap, "Sombra")})
	if !strings.Contains(out, "«sombra pulsada»") {
		t.Fatalf("clic en shadow DOM:\n%s", out)
	}
	out = run("browser_click", map[string]any{"ref": refOf(snap, "Del marco")})
	if !strings.Contains(out, "«marco pulsado»") {
		t.Fatalf("clic en iframe:\n%s", out)
	}
	out = run("browser_click", map[string]any{"ref": refOf(snap, "Alerta")})
	if !strings.Contains(out, "diálogo (alert) «hola»") {
		t.Fatalf("alert:\n%s", out)
	}

	run("browser_type", map[string]any{"ref": refOf(snap, "Rojo"), "text": "Verde"})
	out = run("browser_type", map[string]any{"ref": refOf(snap, "Buscar"), "text": "gatos", "submit": true})
	if !strings.Contains(out, "Buscaste gatos en v") {
		t.Fatalf("formulario:\n%s", out)
	}

	out = run("browser_back", nil)
	if !strings.Contains(out, "# Formulario") || strings.Contains(out, "sigue cargando") {
		t.Fatalf("back:\n%s", out)
	}
	out = run("browser_click", map[string]any{"ref": refOf(out, "Abrir otra")})
	if !strings.Contains(out, "pestaña nueva") || !strings.Contains(out, "Otra página") {
		t.Fatalf("target=_blank:\n%s", out)
	}
	if out = run("browser_tabs", map[string]any{"action": "list"}); !strings.Contains(out, "2 pestañas") {
		t.Fatalf("tabs:\n%s", out)
	}

	text, imgs, err := m.Run(ctx, "browser_screenshot", nil)
	if err != nil || len(imgs) != 1 {
		t.Fatalf("captura: %v %d", err, len(imgs))
	}
	if _, err := jpeg.Decode(bytes.NewReader(imgs[0])); err != nil {
		t.Fatalf("captura no es JPEG: %v (%s)", err, text)
	}
	if path := os.Getenv("LIXBON_BROWSER_SHOT"); path != "" {
		_ = os.WriteFile(path, imgs[0], 0o644)
	}
	var auraOn bool
	if err := m.evaluate(ctx, m.cur, "aura() !== false", &auraOn); err != nil || !auraOn {
		t.Fatalf("aura: %v %v", auraOn, err)
	}
	if out = run("browser_get_text", nil); !strings.Contains(out, "Otra página") {
		t.Fatalf("get_text:\n%s", out)
	}
	for _, o := range []string{snap, out, run("browser_snapshot", map[string]any{"all": true})} {
		if strings.Contains(o, "usando este navegador") {
			t.Fatalf("el aura no puede llegar al modelo:\n%s", o)
		}
	}

	auraShown := func() bool {
		t.Helper()
		var res struct {
			Result struct {
				Value bool `json:"value"`
			} `json:"result"`
		}
		expr := "!!document.documentElement.querySelector('lixbon-aura:not([data-off])')"
		if err := m.conn.call(ctx, m.cur.sessionID, "Runtime.evaluate", map[string]any{"expression": expr, "returnByValue": true}, &res); err != nil {
			t.Fatal(err)
		}
		return res.Result.Value
	}
	if m.Resume() != "" {
		t.Fatal("sin soltar el navegador no hay nada que retomar")
	}
	m.Release()
	if auraShown() {
		t.Fatal("al soltar el navegador el aviso desaparece")
	}
	if r := m.Resume(); !strings.Contains(r, srv.URL+"/other") || !strings.Contains(r, "pestaña 2/2") {
		t.Fatalf("registro de la pestaña: %q", r)
	}
	if mk, _ := readMarker(m.opts.ProfileDir); mk.Tab != m.cur.targetID {
		t.Fatalf("el marcador apunta a la pestaña del agente: %+v", mk)
	}
	loaded, stop := m.conn.on(m.cur.sessionID, "Page.loadEventFired")
	_ = m.conn.call(ctx, m.cur.sessionID, "Page.navigate", map[string]any{"url": srv.URL + "/other?usuario"}, nil)
	waitEvent(ctx, loaded, 5*time.Second, nil)
	stop()
	if auraShown() {
		t.Fatal("lo que navegue el usuario después no vuelve a mostrar el aviso")
	}
	run("browser_snapshot", nil)
	if !auraShown() {
		t.Fatal("al volver a usarlo el agente, el aviso vuelve")
	}

	second := New(Options{Executable: exe, ProfileDir: m.opts.ProfileDir, Headless: true})
	if out, _, err := second.Run(ctx, "browser_tabs", nil); err != nil || !strings.Contains(out, "2 pestañas") {
		t.Fatalf("segunda sesión adjunta: %v\n%s", err, out)
	}
	second.Close()
	if !m.Running() {
		t.Fatal("cerrar una sesión adjunta no debe cerrar el navegador")
	}
	proc := m.proc
	m.Close()
	select {
	case <-proc.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("Close no cerró el navegador")
	}
}
