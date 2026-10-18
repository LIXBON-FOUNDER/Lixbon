package update

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"lixbon.com/cli/internal/config"
)

const (
	// DisableEnv apaga el aviso de versión nueva sin tocar la configuración.
	DisableEnv     = "LIXBON_NO_UPDATE_CHECK"
	noticeInterval = 6 * time.Hour
	noticeTimeout  = 3 * time.Second
	installTimeout = 5 * time.Minute
	noticeStamp    = "update_check"
	// installedStamp guarda la versión que ya se instaló y espera a que se
	// reinicie lixbon.
	installedStamp = "update_installed"
)

// NoticeEnabled dice si el chat puede consultar si hay una versión nueva. Con
// un proveedor genérico se consulta el gateway por defecto, que es el que
// publica los binarios.
func NoticeEnabled(cfg config.Config) bool {
	return os.Getenv(DisableEnv) == "" && cfg.ExtraBool("update_check", true)
}

// AutoEnabled dice si la versión nueva se instala sola (auto_update, sí por
// defecto) o solo se avisa.
func AutoEnabled(cfg config.Config) bool { return cfg.ExtraBool("auto_update", true) }

// Outcome es lo que encontró la comprobación del arranque.
type Outcome struct {
	Version string
	// Installed: la versión nueva ya está en disco; se usa al reiniciar.
	Installed bool
	// Err: había versión nueva pero no se pudo instalar sola.
	Err error
}

// AutoUpdate comprueba como CheckNotice y, si hay una versión nueva, la
// descarga, la verifica y la instala. El proceso en marcha sigue con la
// versión vieja hasta que se reinicia. Si otra ventana o una sesión anterior
// ya la instaló, lo dice sin volver a descargarla.
func AutoUpdate(ctx context.Context, u *Updater, dir string, now time.Time) (Outcome, bool) {
	if u.Current == config.DevVersion {
		return Outcome{}, false
	}
	installed := filepath.Join(dir, installedStamp)
	if raw, err := os.ReadFile(installed); err == nil {
		version := strings.TrimSpace(string(raw))
		if order, err := compareVersions(version, u.Current); err == nil && order > 0 {
			return Outcome{Version: version, Installed: true}, true
		}
		_ = os.Remove(installed)
	}
	if !due(dir, now) {
		return Outcome{}, false
	}
	checkCtx, cancel := context.WithTimeout(ctx, noticeTimeout)
	rel, err := u.Check(checkCtx)
	cancel()
	if err != nil || !rel.Newer {
		return Outcome{}, false
	}
	applyCtx, cancel := context.WithTimeout(ctx, installTimeout)
	defer cancel()
	if err := u.Apply(applyCtx, rel); err != nil {
		return Outcome{Version: rel.Version, Err: err}, true
	}
	_ = os.WriteFile(installed, []byte(rel.Version), 0o644)
	return Outcome{Version: rel.Version, Installed: true}, true
}

// due dice si toca consultar y, si toca, lo anota antes de hacerlo: un
// gateway caído no se reintenta en cada arranque.
func due(dir string, now time.Time) bool {
	stamp := filepath.Join(dir, noticeStamp)
	if raw, err := os.ReadFile(stamp); err == nil {
		if last, err := time.Parse(time.RFC3339, strings.TrimSpace(string(raw))); err == nil {
			if elapsed := now.Sub(last); elapsed >= 0 && elapsed < noticeInterval {
				return false
			}
		}
	}
	_ = os.WriteFile(stamp, []byte(now.UTC().Format(time.RFC3339)), 0o644)
	return true
}

// CheckNotice devuelve la versión más nueva si la hay, como mucho una vez cada
// noticeInterval. No envía nada del usuario, solo el User-Agent.
func CheckNotice(ctx context.Context, u *Updater, dir string, now time.Time) (string, bool) {
	if u.Current == config.DevVersion || !due(dir, now) {
		return "", false
	}
	ctx, cancel := context.WithTimeout(ctx, noticeTimeout)
	defer cancel()
	rel, err := u.Check(ctx)
	if err != nil || !rel.Newer {
		return "", false
	}
	return rel.Version, true
}
