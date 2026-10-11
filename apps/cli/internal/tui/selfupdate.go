package tui

import (
	"context"
	"path/filepath"
	"time"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/config"
	"lixbon.com/cli/internal/update"
)

var newUpdater = update.New

type updateNoticeMsg struct{ version string }

// updateNotice devuelve la comprobación de versión nueva del arranque, o nil si
// está desactivada.
func updateNotice(cfg config.Config, configPath string) func(context.Context) (string, bool) {
	if !update.NoticeEnabled(cfg) {
		return nil
	}
	manifestURL := update.ManifestURLForConfig(cfg)
	dir := filepath.Dir(configPath)
	return func(ctx context.Context) (string, bool) {
		updater, err := newUpdater(manifestURL)
		if err != nil {
			return "", false
		}
		return update.CheckNotice(ctx, updater, dir, time.Now())
	}
}

func (m *Model) updateNoticeCmd() tea.Cmd {
	check := m.opts.UpdateNotice
	if check == nil {
		return nil
	}
	return func() tea.Msg {
		if version, ok := check(context.Background()); ok {
			return updateNoticeMsg{version}
		}
		return nil
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
