package cloudhost

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/history"
)

func TestBranchName(t *testing.T) {
	cases := map[string]string{
		"Añade códigos de descuento al carrito": "lixbon/anade-codigos-de-descuento-al-carrito",
		"  ¡Arregla los TESTS que fallan!  ":    "lixbon/arregla-los-tests-que-fallan",
		"":                                      "",
		"refs/heads/main; rm -rf / && echo ../../etc": "lixbon/refs-heads-main-rm-rf-echo-etc",
	}
	for in, want := range cases {
		got := branchName(in)
		if want == "" {
			if !strings.HasPrefix(got, "lixbon/sesion-") {
				t.Errorf("%q → %q", in, got)
			}
			continue
		}
		if got != want {
			t.Errorf("%q → %q, esperaba %q", in, got, want)
		}
		if len(got) > len(branchPrefix)+40 || strings.Contains(got, "..") {
			t.Errorf("rama no válida: %q", got)
		}
	}
}

// servidor de desarrollo de mentira en un puerto local.
func devServer(t *testing.T, handler http.HandlerFunc) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: handler}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return ln.Addr().(*net.TCPAddr).Port
}

func get(t *testing.T, h http.Handler, path string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	body, _ := io.ReadAll(rec.Result().Body)
	return rec.Code, string(body)
}

func TestPreviewConRutaBase(t *testing.T) {
	prefix := func(port int) string { return "/api/coding/sessions/0123456789ab/preview/" + strconv.Itoa(port) + "/" }
	var port int
	port = devServer(t, func(w http.ResponseWriter, r *http.Request) {
		// Vite arrancado con --base: solo responde bajo el prefijo.
		if !strings.HasPrefix(r.URL.Path, prefix(port)) {
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, "vite:"+strings.TrimPrefix(r.URL.Path, prefix(port)))
	})
	h := previewHandler(prefix)
	code, body := get(t, h, "/"+strconv.Itoa(port)+prefix(port)+"src/main.jsx")
	if code != 200 || body != "vite:src/main.jsx" {
		t.Fatalf("%d %q", code, body)
	}
}

func TestPreviewSinRutaBaseReintentaSinPrefijo(t *testing.T) {
	prefix := func(port int) string { return "/api/coding/sessions/0123456789ab/preview/" + strconv.Itoa(port) + "/" }
	port := devServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/index.html" {
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, "estatico")
	})
	code, body := get(t, previewHandler(prefix), "/"+strconv.Itoa(port)+prefix(port)+"index.html")
	if code != 200 || body != "estatico" {
		t.Fatalf("%d %q", code, body)
	}
}

func TestPreviewRechazaPuertosRaros(t *testing.T) {
	h := previewHandler(func(int) string { return "" })
	for _, p := range []string{"/7000/x", "/80/x", "/abc/x", "/99999/x"} {
		if code, _ := get(t, h, p); code != http.StatusBadRequest {
			t.Errorf("%s → %d", p, code)
		}
	}
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func TestRamaDiffYArbol(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("sin git")
	}
	ctx := context.Background()
	origen := t.TempDir()
	git(t, origen, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(origen, "a.txt"), []byte("uno\n"), 0o644)
	git(t, origen, "add", ".")
	git(t, origen, "commit", "-qm", "inicio")

	dir := filepath.Join(t.TempDir(), "repo")
	if err := clone(ctx, origen, dir); err != nil {
		t.Fatal(err)
	}
	b, err := ensureBranch(ctx, dir, "Cambia el texto")
	if err != nil || b != "lixbon/cambia-el-texto" {
		t.Fatalf("%q %v", b, err)
	}
	// Reanudar: se queda en la misma rama.
	if again, _ := ensureBranch(ctx, dir, "otra cosa"); again != b {
		t.Fatalf("al reanudar cambió de rama: %q", again)
	}
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("dos\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "nuevo.txt"), []byte("hola\n"), 0o644)
	files, _ := diffFiles(ctx, dir, "main")
	got := map[string]map[string]any{}
	for _, f := range files {
		got[f["path"].(string)] = f
	}
	if got["a.txt"]["adds"] != 1 || got["a.txt"]["dels"] != 1 || !strings.Contains(got["a.txt"]["patch"].(string), "+dos") {
		t.Fatalf("diff de a.txt: %v", got["a.txt"])
	}
	if _, ok := got["nuevo.txt"]; !ok {
		t.Fatalf("falta el archivo nuevo en el diff: %v", files)
	}
	entries, truncated := treeEntries(ctx, dir)
	if truncated || len(entries) != 2 {
		t.Fatalf("árbol: %v", entries)
	}
}

func TestLimpiarNombreRama(t *testing.T) {
	tarea := "Añade códigos de descuento al carrito"
	casos := map[string]string{
		"carrito-descuentos":                 "lixbon/carrito-descuentos",
		"`lixbon/Arreglar-Login-Safari`\n":   "lixbon/arreglar-login-safari",
		"<think>mmm</think>\ndocs-api-pagos": "lixbon/docs-api-pagos",
		"":                                   "lixbon/anade-codigos-de-descuento-al-carrito",
		"Claro, aquí tienes un nombre que describe": "lixbon/anade-codigos-de-descuento-al-carrito",
	}
	for propuesta, want := range casos {
		if got := branchName(limpiarNombreRama(propuesta, tarea)); got != want {
			t.Errorf("%q → %q, quería %q", propuesta, got, want)
		}
	}
}

func TestSlashDe(t *testing.T) {
	casos := []struct {
		in, name, arg string
		ok            bool
	}{
		{"/help", "help", "", true},
		{"  /Commit arregla el login ", "commit", "arregla el login", true},
		{"/run npm test", "run", "npm test", true},
		{"/etc/hosts no existe", "", "", false},
		{"hola /help", "", "", false},
	}
	for _, c := range casos {
		n, a, ok := slashDe(c.in)
		if n != c.name || a != c.arg || ok != c.ok {
			t.Errorf("%q → (%q, %q, %v)", c.in, n, a, ok)
		}
	}
	if len(comandosHello()) != len(comandos) {
		t.Fatal("hello sin todos los comandos")
	}
}

func TestLimpiarLinea(t *testing.T) {
	if got := limpiarLinea("<think>x</think>\n`Añade test del carrito`\n"); got != "Añade test del carrito" {
		t.Fatalf("got %q", got)
	}
}

func TestLeerArchivoSeguro(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hola"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.MkdirAll(filepath.Join(dir, ".git"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, ".git", "config"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "bin.dat"), []byte{1, 0, 2}, 0o644)
	if got := leerArchivo(dir, "a.txt"); got["text"] != "hola" {
		t.Fatalf("a.txt: %v", got)
	}
	for _, mala := range []string{"../fuera", "/etc/passwd", ".git/config", "", "a/../../x"} {
		if got := leerArchivo(dir, mala); got["error"] == nil {
			t.Errorf("%q debería rechazarse: %v", mala, got)
		}
	}
	if got := leerArchivo(dir, "bin.dat"); got["binary"] != true {
		t.Fatalf("binario: %v", got)
	}
}

func TestMemoriaSobreviveALaPausa(t *testing.T) {
	root := t.TempDir()
	cfgPath := filepath.Join(t.TempDir(), "config.json")
	nuevo := func() *Host {
		c, err := chat.New(config.Load(cfgPath), nil, chat.Options{ConfigPath: cfgPath, Workspace: root, Ephemeral: true})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(c.Close)
		return &Host{opts: Options{Root: root, Repo: "acme/tienda"}, chat: c, questions: map[string]chan string{}}
	}

	antes := nuevo()
	if antes.loadMemory() {
		t.Fatal("una sesión nueva no tiene nada que recordar")
	}
	antes.chat.History = []history.Message{
		{Role: "user", Content: "Añade un botón de pago", Images: []string{"QUJD"}},
		{Role: "assistant", Content: "", ToolCalls: []json.RawMessage{json.RawMessage(`{"id":"c1","function":{"name":"read_file","arguments":"{}"}}`)}},
		{Role: "tool", Content: "contenido", ToolCallID: "c1", Name: "read_file"},
		history.Assistant("Hecho: el botón está en Checkout.jsx"),
	}
	antes.chat.SessionTokens = 1234
	antes.log = []map[string]any{
		{"role": "user", "content": "Añade un botón de pago"},
		{"role": "tool", "id": "t9", "pending": true},
	}
	antes.saveMemory()

	path := rutaMemoria(root, "acme/tienda")
	if rel, _ := filepath.Rel(filepath.Join(root, "tienda"), path); !strings.HasPrefix(rel, "..") {
		t.Fatalf("la memoria no puede vivir dentro del repo: %s", path)
	}
	if _, err := os.Stat(path + ".tmp"); err == nil {
		t.Fatal("quedó el archivo temporal")
	}

	despues := nuevo() // contenedor nuevo, mismo volumen
	if !despues.loadMemory() {
		t.Fatal("no recuperó la conversación")
	}
	got := despues.chat.History
	if len(got) != 4 || got[3].Content != "Hecho: el botón está en Checkout.jsx" || got[2].ToolCallID != "c1" || len(got[1].ToolCalls) != 1 {
		t.Fatalf("historial distinto: %+v", got)
	}
	if len(got[0].Images) != 0 {
		t.Fatal("las imágenes no se guardan")
	}
	if despues.chat.SessionTokens != 1234 {
		t.Fatalf("tokens = %d", despues.chat.SessionTokens)
	}
	snap := despues.snapshot()
	if len(snap) != 2 || snap[1]["pending"] != false || snap[1]["ok"] != false {
		t.Fatalf("snapshot = %+v", snap)
	}

	// Un archivo roto o de otra versión se ignora: la sesión arranca limpia.
	if err := os.WriteFile(path, []byte(`{"version":1,"history":[`), 0o600); err != nil {
		t.Fatal(err)
	}
	if nuevo().loadMemory() {
		t.Fatal("aceptó un JSON cortado")
	}
}

func TestMemoriaRecortaSinHuerfanos(t *testing.T) {
	msgs := []history.Message{
		history.User("uno"), history.Assistant("a"),
		{Role: "assistant", Content: ""}, {Role: "tool", Content: "r", ToolCallID: "x"},
		history.User("TOOL_RESULT read_file\n…"), history.User("dos"), history.Assistant("b"),
	}
	got := recortar(msgs)
	if len(got) != 2 || got[0].Content != "dos" {
		t.Fatalf("recorte = %+v", got)
	}
	if rutaMemoria("/workspace", "acme/.lixbon") == filepath.Join("/workspace", ".lixbon", "chat.json") {
		t.Fatal("la memoria pisaría un repo llamado .lixbon")
	}
}
