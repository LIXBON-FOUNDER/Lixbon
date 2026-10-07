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
	noticeInterval = 24 * time.Hour
	noticeTimeout  = 3 * time.Second
	noticeStamp    = "update_check"
)

// NoticeEnabled dice si el chat puede consultar el gateway en busca de una
// versión nueva: un proveedor genérico no publica binarios.
func NoticeEnabled(cfg config.Config) bool {
	return os.Getenv(DisableEnv) == "" && !cfg.IsGeneric() && cfg.ExtraBool("update_check", true)
}

// CheckNotice devuelve la versión más nueva si la hay, como mucho una vez cada
// 24 horas. La marca se escribe antes de consultar: un gateway caído no se
// reintenta en cada arranque. No envía nada del usuario, solo el User-Agent.
func CheckNotice(ctx context.Context, u *Updater, dir string, now time.Time) (string, bool) {
	if u.Current == config.DevVersion {
		return "", false
	}
	stamp := filepath.Join(dir, noticeStamp)
	if raw, err := os.ReadFile(stamp); err == nil {
		if last, err := time.Parse(time.RFC3339, strings.TrimSpace(string(raw))); err == nil {
			if elapsed := now.Sub(last); elapsed >= 0 && elapsed < noticeInterval {
				return "", false
			}
		}
	}
	_ = os.WriteFile(stamp, []byte(now.UTC().Format(time.RFC3339)), 0o644)
	ctx, cancel := context.WithTimeout(ctx, noticeTimeout)
	defer cancel()
	rel, err := u.Check(ctx)
	if err != nil || !rel.Newer {
		return "", false
	}
	return rel.Version, true
}
