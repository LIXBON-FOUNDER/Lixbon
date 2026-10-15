package browser

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

// Env es lo que FindExecutable consulta del sistema; inyectable en los tests.
type Env struct {
	GOOS     string
	Getenv   func(string) string
	Exists   func(string) bool
	LookPath func(string) (string, error)
	// DefaultBrowser es la familia del navegador predeterminado del usuario
	// ("chrome", "brave", "edge", "chromium") o "" si no se sabe.
	DefaultBrowser func() string
}

func SystemEnv() Env {
	return Env{
		GOOS:   runtime.GOOS,
		Getenv: os.Getenv,
		Exists: func(p string) bool {
			info, err := os.Stat(p)
			return err == nil && !info.IsDir()
		},
		LookPath:       exec.LookPath,
		DefaultBrowser: defaultBrowser,
	}
}

var ErrNotFound = errors.New("no encontré Chrome, Brave, Chromium ni Edge instalados (define LIXBON_BROWSER con la ruta del ejecutable)")

// families en orden de preferencia. Edge va el último: viene con Windows,
// así que estar instalado no significa que el usuario lo use.
var families = []string{"chrome", "brave", "chromium", "edge"}

// FindExecutable busca el navegador: LIXBON_BROWSER, luego configured
// (browser_path de la config), luego el predeterminado del usuario si es
// Chromium y por último el primero instalado de families.
func FindExecutable(env Env, configured string) (string, error) {
	for _, explicit := range []string{env.Getenv("LIXBON_BROWSER"), configured} {
		if explicit = strings.TrimSpace(explicit); explicit == "" {
			continue
		}
		if env.Exists(explicit) {
			return explicit, nil
		}
		if p, err := env.LookPath(explicit); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("el navegador configurado no existe: %s", explicit)
	}
	order := families
	if env.DefaultBrowser != nil {
		if def := env.DefaultBrowser(); slices.Contains(families, def) {
			order = append([]string{def}, slices.DeleteFunc(slices.Clone(families), func(f string) bool { return f == def })...)
		}
	}
	var snap string
	for _, family := range order {
		for _, p := range candidates(env, family) {
			if env.Exists(p) {
				return p, nil
			}
		}
		if env.GOOS == "windows" || env.GOOS == "darwin" {
			continue
		}
		for _, name := range linuxNames[family] {
			p, err := env.LookPath(name)
			if err != nil {
				continue
			}
			if IsSnap(p) {
				if snap == "" {
					snap = p
				}
				continue
			}
			return p, nil
		}
	}
	if snap != "" {
		return snap, nil
	}
	return "", ErrNotFound
}

var linuxNames = map[string][]string{
	"chrome":   {"google-chrome-stable", "google-chrome"},
	"brave":    {"brave-browser", "brave"},
	"chromium": {"chromium", "chromium-browser"},
	"edge":     {"microsoft-edge-stable", "microsoft-edge"},
}

func candidates(env Env, family string) []string {
	switch env.GOOS {
	case "windows":
		rel := map[string]string{
			"chrome":   `Google\Chrome\Application\chrome.exe`,
			"brave":    `BraveSoftware\Brave-Browser\Application\brave.exe`,
			"chromium": `Chromium\Application\chrome.exe`,
			"edge":     `Microsoft\Edge\Application\msedge.exe`,
		}[family]
		var out []string
		for _, base := range []string{env.Getenv("ProgramFiles"), env.Getenv("ProgramFiles(x86)"), env.Getenv("LOCALAPPDATA")} {
			if base != "" {
				out = append(out, base+`\`+rel)
			}
		}
		return out
	case "darwin":
		app := map[string]string{
			"chrome":   "Google Chrome.app/Contents/MacOS/Google Chrome",
			"brave":    "Brave Browser.app/Contents/MacOS/Brave Browser",
			"chromium": "Chromium.app/Contents/MacOS/Chromium",
			"edge":     "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		}[family]
		out := []string{"/Applications/" + app}
		if home := env.Getenv("HOME"); home != "" {
			out = append(out, home+"/Applications/"+app)
		}
		return out
	}
	return nil
}

// Family deduce la familia del navegador por el nombre de su ejecutable.
func Family(executable string) string {
	name := strings.ToLower(filepath.Base(filepath.ToSlash(executable)))
	switch {
	case strings.Contains(name, "brave"):
		return "brave"
	case strings.Contains(name, "edge"):
		return "edge"
	case strings.Contains(strings.ToLower(executable), "chromium"):
		return "chromium"
	}
	return "chrome"
}

// familyOfProgID traduce el ProgId de Windows del navegador predeterminado.
func familyOfProgID(id string) string {
	id = strings.ToLower(id)
	switch {
	case strings.HasPrefix(id, "brave"):
		return "brave"
	case strings.HasPrefix(id, "chromehtml"):
		return "chrome"
	case strings.HasPrefix(id, "msedge"):
		return "edge"
	case strings.HasPrefix(id, "chromium"):
		return "chromium"
	}
	return ""
}

func IsSnap(path string) bool { return strings.HasPrefix(filepath.ToSlash(path), "/snap/") }

// ProfileDir es la carpeta del perfil dedicado, una por familia: los perfiles
// no se comparten bien entre navegadores, y así cambiar de navegador no se
// adjunta al que quedó abierto con otro. El Chromium de snap no puede leer
// carpetas ocultas del home, así que su perfil va dentro de ~/snap.
func ProfileDir(lixbonDir, executable, home string) string {
	if IsSnap(executable) && home != "" {
		return filepath.Join(home, "snap", "chromium", "common", "lixbon-browser-profile")
	}
	name := "browser-profile"
	if family := Family(executable); family != "chrome" {
		name += "-" + family
	}
	return filepath.Join(lixbonDir, name)
}
