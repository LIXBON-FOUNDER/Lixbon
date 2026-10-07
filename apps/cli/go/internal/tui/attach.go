package tui

import (
	"path/filepath"
	"regexp"
	"strings"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/clipboard"
)

var markerBeforeCursor = regexp.MustCompile(`(?i)\[IMG#\d+\]$`)

func (m *Model) cmdImage(arg string) {
	arg = strings.Trim(strings.TrimSpace(arg), `"`)
	if arg == "" {
		m.print(errLine("Uso: /image <ruta> — o escribe @ruta dentro del mensaje"))
		return
	}
	if !filepath.IsAbs(arg) {
		arg = filepath.Join(m.chat.Workspace, arg)
	}
	m.stageImage(arg)
}

func (m *Model) pasteImage() {
	path, problem := clipboard.Paste(filepath.Dir(m.chat.ConfigPath))
	if problem != "" {
		m.print(errLine(problem))
		return
	}
	m.stageImage(path)
}

// stageImage deja el marcador [IMG#n] escrito en la caja: la imagen viaja con
// el mensaje que lo conserve.
func (m *Model) stageImage(path string) {
	marker, err := m.chat.StageImage(path)
	if err != nil {
		m.print(errLine(err.Error()))
		return
	}
	m.input.InsertString(marker + " ")
	m.refreshMenu()
}

// dropMarkerBeforeCursor borra de un golpe el marcador de imagen que queda
// justo antes del cursor, y descarta la imagen si era la última en cola.
func (m *Model) dropMarkerBeforeCursor() bool {
	lines := strings.Split(m.input.Value(), "\n")
	row := m.input.Line()
	if row >= len(lines) {
		return false
	}
	runes := []rune(lines[row])
	marker := markerBeforeCursor.FindString(string(runes[:min(m.input.Column(), len(runes))]))
	if marker == "" {
		return false
	}
	for range []rune(marker) {
		m.input, _ = m.input.Update(tea.KeyPressMsg{Code: tea.KeyBackspace})
	}
	m.chat.DropStagedImage(marker)
	m.refreshMenu()
	return true
}
