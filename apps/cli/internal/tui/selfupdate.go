package tui

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/update"
)

var newUpdater = update.New

type updateNoticeMsg struct{ update.Outcome }

// updateNotice devuelve la comprobación de versión nueva del arranque, o nil si
// está desactivada. Con auto_update (por defecto) la versión nueva se instala
// sola en segundo plano; sin él, solo se avisa.
func updateNotice(cfg config.Config, configPath string) func(context.Context) (update.Outcome, bool) {
	if !update.NoticeEnabled(cfg) {
		return nil
	}
	manifestURL := update.ManifestURLForConfig(cfg)
	dir := filepath.Dir(configPath)
	auto := update.AutoEnabled(cfg)
	return func(ctx context.Context) (update.Outcome, bool) {
		updater, err := newUpdater(manifestURL)
		if err != nil {
			return update.Outcome{}, false
		}
		if auto {
			return update.AutoUpdate(ctx, updater, dir, time.Now())
		}
		version, ok := update.CheckNotice(ctx, updater, dir, time.Now())
		return update.Outcome{Version: version}, ok
	}
}

func (m *Model) updateNoticeCmd() tea.Cmd {
	check := m.opts.UpdateNotice
	if check == nil {
		return nil
	}
	return func() tea.Msg {
		if out, ok := check(context.Background()); ok {
			return updateNoticeMsg{out}
		}
		return nil
	}
}

// onUpdateNotice cuenta lo que encontró la comprobación del arranque. Una
// versión ya instalada se queda además en el pie hasta que se reinicie.
func (m *Model) onUpdateNotice(out update.Outcome) {
	switch {
	case out.Installed:
		m.updateReady = out.Version
		m.add(okLine(fmt.Sprintf("Se descargó e instaló lixbon v%s. Reinicia lixbon para usarla.", out.Version)))
	case out.Err != nil:
		m.add(note(fmt.Sprintf("Hay una versión nueva (v%s) pero no se pudo instalar sola: %v. Ejecuta /update.", out.Version, out.Err)))
	default:
		m.add(note(fmt.Sprintf("Hay una versión nueva (v%s). Ejecuta /update.", out.Version)))
	}
}

func (m *Model) cmdUpdate() tea.Cmd {
	manifestURL := update.ManifestURLForConfig(m.chat.Cfg)
	return m.async("actualizando lixbon", func(ctx context.Context) cmdDoneMsg {
		updater, err := newUpdater(manifestURL)
		if err != nil {
			return cmdDoneMsg{lines: []block{errLine(err.Error())}}
		}
		message, err := update.Run(ctx, updater, false)
		if err != nil {
			return cmdDoneMsg{lines: []block{errLine(err.Error())}}
		}
		return cmdDoneMsg{lines: []block{okLine(message)}}
	})
}
