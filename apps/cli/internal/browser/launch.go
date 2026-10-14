package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	portFile     = "DevToolsActivePort"
	markerFile   = "lixbon-browser.json"
	launchWait   = 20 * time.Second
	attachWait   = 1500 * time.Millisecond
	windowWidth  = 1280
	windowHeight = 900
)

type Options struct {
	Executable string
	ProfileDir string
	Headless   bool
	// KeepOpen deja el navegador abierto al salir; el próximo CLI se adjunta.
	KeepOpen bool
}

type marker struct {
	CLIPID     int `json:"cli_pid"`
	BrowserPID int `json:"browser_pid"`
	// Tab es la pestaña en la que quedó el agente: otra sesión la retoma.
	Tab string `json:"tab,omitempty"`
}

func launchArgs(opts Options) []string {
	args := []string{
		"--remote-debugging-port=0",
		"--user-data-dir=" + opts.ProfileDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-search-engine-choice-screen",
		fmt.Sprintf("--window-size=%d,%d", windowWidth, windowHeight),
	}
	if opts.Headless {
		args = append(args, "--headless=new")
	}
	return append(args, "about:blank")
}

type process struct {
	cmd    *exec.Cmd
	exited chan struct{}
}

// launch arranca el navegador y devuelve la URL de su websocket. Usa
// exec.Command y no CommandContext: el navegador sobrevive a cancelar un turno.
func launch(ctx context.Context, opts Options) (*process, string, error) {
	if err := os.MkdirAll(opts.ProfileDir, 0o700); err != nil {
		return nil, "", err
	}
	_ = os.Remove(filepath.Join(opts.ProfileDir, portFile))
	markExitedCleanly(opts.ProfileDir)
	cmd := exec.Command(opts.Executable, launchArgs(opts)...)
	cmd.SysProcAttr = procAttr()
	if err := cmd.Start(); err != nil {
		return nil, "", fmt.Errorf("no pude abrir %s: %w", filepath.Base(opts.Executable), err)
	}
	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()
	deadline := time.Now().Add(launchWait)
	for time.Now().Before(deadline) {
		if url, err := readPortFile(opts.ProfileDir); err == nil {
			writeMarker(opts.ProfileDir, marker{CLIPID: os.Getpid(), BrowserPID: cmd.Process.Pid})
			return &process{cmd: cmd, exited: exited}, url, nil
		}
		select {
		case <-exited:
			return nil, "", errors.New("el navegador se cerró al arrancar: puede que el perfil de Lixbon esté abierto en otra ventana sin depuración, " +
				"o que una política de la empresa bloquee la depuración remota")
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return nil, "", ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	_ = cmd.Process.Kill()
	return nil, "", errors.New("el navegador no abrió el puerto de depuración a tiempo")
}

// readPortFile lee DevToolsActivePort: puerto en la primera línea y ruta del
// websocket del navegador en la segunda.
func readPortFile(dir string) (string, error) {
	data, err := os.ReadFile(filepath.Join(dir, portFile))
	if err != nil {
		return "", err
	}
	return parsePortFile(string(data))
}

func parsePortFile(data string) (string, error) {
	lines := strings.Split(strings.ReplaceAll(data, "\r\n", "\n"), "\n")
	if len(lines) < 2 {
		return "", errors.New("DevToolsActivePort incompleto")
	}
	port, err := strconv.Atoi(strings.TrimSpace(lines[0]))
	path := strings.TrimSpace(lines[1])
	if err != nil || port <= 0 || port > 65535 || !strings.HasPrefix(path, "/devtools/browser/") {
		return "", errors.New("DevToolsActivePort inválido")
	}
	return fmt.Sprintf("ws://127.0.0.1:%d%s", port, path), nil
}

// attachExisting se conecta a un navegador ya abierto con este perfil (otro
// CLI, o uno que sobrevivió a un cierre). Un archivo de puerto que no responde
// es de una sesión muerta y se borra.
func attachExisting(ctx context.Context, dir string) (*conn, error) {
	url, err := readPortFile(dir)
	if err != nil {
		return nil, err
	}
	dctx, cancel := context.WithTimeout(ctx, attachWait)
	defer cancel()
	c, err := dial(dctx, url)
	if err != nil {
		_ = os.Remove(filepath.Join(dir, portFile))
		return nil, err
	}
	return c, nil
}

// orphaned dice si el CLI que abrió el navegador ya no existe: entonces este lo
// adopta y lo cierra al salir.
func orphaned(dir string) bool {
	m, ok := readMarker(dir)
	if !ok || m.CLIPID == 0 {
		return false
	}
	return m.CLIPID != os.Getpid() && !processAlive(m.CLIPID)
}

func writeMarker(dir string, m marker) {
	data, _ := json.Marshal(m)
	_ = os.WriteFile(filepath.Join(dir, markerFile), data, 0o600)
}

func readMarker(dir string) (marker, bool) {
	var m marker
	data, err := os.ReadFile(filepath.Join(dir, markerFile))
	return m, err == nil && json.Unmarshal(data, &m) == nil
}

func adoptMarker(dir string) {
	if m, ok := readMarker(dir); ok {
		m.CLIPID = os.Getpid()
		writeMarker(dir, m)
	}
}

func rememberTab(dir, targetID string) {
	if m, ok := readMarker(dir); ok && m.Tab != targetID {
		m.Tab = targetID
		writeMarker(dir, m)
	}
}

// markExitedCleanly evita la burbuja «¿Restaurar páginas?» que Chrome muestra
// si la sesión anterior terminó con kill.
func markExitedCleanly(dir string) {
	path := filepath.Join(dir, "Default", "Preferences")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var prefs map[string]any
	if json.Unmarshal(data, &prefs) != nil {
		return
	}
	profile, _ := prefs["profile"].(map[string]any)
	if profile == nil {
		return
	}
	if profile["exit_type"] == "Normal" && profile["exited_cleanly"] == true {
		return
	}
	profile["exit_type"] = "Normal"
	profile["exited_cleanly"] = true
	if out, err := json.Marshal(prefs); err == nil {
		_ = os.WriteFile(path, out, 0o600)
	}
}
