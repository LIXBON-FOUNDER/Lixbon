package tui

import (
	"context"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/update"
)

var newUpdater = update.New

func (m *Model) cmdUpdate() tea.Cmd {
	manifestURL := update.ManifestURLForConfig(m.chat.Cfg)
	return m.async("actualizando lixbon", func(ctx context.Context) cmdDoneMsg {
		updater, err := newUpdater(manifestURL)
		if err != nil {
			return cmdDoneMsg{lines: []string{errLine(err.Error())}}
		}
		message, err := update.Run(ctx, updater, false)
		if err != nil {
			return cmdDoneMsg{lines: []string{errLine(err.Error())}}
		}
		return cmdDoneMsg{lines: []string{okLine(message)}}
	})
}
