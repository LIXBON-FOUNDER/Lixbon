package browser

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

const responsivePage = `<!doctype html><meta name="viewport" content="width=device-width"><title>Responsive</title>
<script>window.app = {cards: 3};</script><p class="card">a</p><p class="card">b</p>`

// Como con las DevTools: la página se ve a otro tamaño y se puede consultar
// con JavaScript, incluidas las variables de la propia página.
func TestLiveViewportAndEval(t *testing.T) {
	if os.Getenv("LIXBON_BROWSER_LIVE") != "1" {
		t.Skip("LIXBON_BROWSER_LIVE=1 para probar con un navegador real")
	}
	exe, err := FindExecutable(SystemEnv(), "")
	if err != nil {
		t.Skip(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, responsivePage) }))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	m := New(Options{Executable: exe, ProfileDir: t.TempDir(), Headless: true})
	defer m.Close()
	run := func(tool string, args map[string]any) string {
		t.Helper()
		out, _, err := m.Run(ctx, tool, args)
		if err != nil {
			t.Fatalf("%s: %v", tool, err)
		}
		return out
	}
	run("browser_navigate", map[string]any{"url": srv.URL})
	if out := run("browser_viewport", map[string]any{"preset": "mobile"}); !strings.Contains(out, "390×844 (móvil)") {
		t.Fatalf("viewport: %s", out)
	}
	if out := run("browser_eval", map[string]any{"expression": "[innerWidth, matchMedia('(pointer: coarse)').matches]"}); !strings.Contains(out, "[390,true]") {
		t.Fatalf("la página se ve a ancho de móvil y táctil: %s", out)
	}
	if out := run("browser_eval", map[string]any{"expression": "const n = document.querySelectorAll('.card').length; ({n, app: window.app.cards})"}); !strings.Contains(out, `{"app":3,"n":2}`) {
		t.Fatalf("eval ve el DOM y las variables de la página: %s", out)
	}
	run("browser_viewport", map[string]any{"preset": "reset"})
	if out := run("browser_eval", map[string]any{"expression": "innerWidth"}); strings.Contains(out, "390") {
		t.Fatalf("reset vuelve al tamaño de la ventana: %s", out)
	}
	if _, _, err := m.Run(ctx, "browser_eval", map[string]any{"expression": "noExiste()"}); err == nil || !strings.Contains(err.Error(), "noExiste") {
		t.Fatalf("un error de la página vuelve como error: %v", err)
	}
}
