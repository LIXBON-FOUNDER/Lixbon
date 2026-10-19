package tui

import (
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"

	"lixbon.com/cli/internal/clipboard"
)

var markerBeforeCursor = regexp.MustCompile(`(?i)\[IMG#\d+\]$`)

func (m *Model) cmdImage(arg string) {
	arg = strings.Trim(strings.TrimSpace(arg), `"`)
	if arg == "" {
		m.add(errLine("Uso: /image <ruta> — o escribe @ruta dentro del mensaje"))
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
		m.add(errLine(problem))
		return
	}
	m.stageImage(path)
}

// stageImage deja el marcador [IMG#n] escrito en la caja: la imagen viaja con
// el mensaje que lo conserve.
func (m *Model) stageImage(path string) {
	marker, err := m.chat.StageImage(path)
	if err != nil {
		m.add(errLine(err.Error()))
		return
	}
	m.chips = append(m.chips, newImageChip(len(m.chips)+1, path))
	m.input.InsertString(marker + " ")
	m.refreshMenu()
}

var imageExts = []string{".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

// droppedImage reconoce una imagen arrastrada a la terminal: llega como un
// pegado con su ruta, a veces entre comillas o con el «& '…'» de PowerShell.
func droppedImage(content, workspace string) (string, bool) {
	text := strings.TrimSpace(content)
	if strings.ContainsAny(text, "\r\n") {
		return "", false
	}
	text = strings.TrimSpace(strings.TrimPrefix(text, "& "))
	text = strings.Trim(text, `"'`)
	if text == "" || !slices.Contains(imageExts, strings.ToLower(filepath.Ext(text))) {
		return "", false
	}
	if !filepath.IsAbs(text) {
		text = filepath.Join(workspace, text)
	}
	if info, err := os.Stat(text); err != nil || info.IsDir() {
		return "", false
	}
	return text, true
}

func newImageChip(n int, path string) imageChip {
	c := imageChip{n: n, name: filepath.Base(path), path: path, thumb: newThumb(path)}
	if info, err := os.Stat(path); err == nil {
		c.size = info.Size()
	}
	if f, err := os.Open(path); err == nil {
		if cfg, _, err := image.DecodeConfig(f); err == nil {
			c.w, c.h = cfg.Width, cfg.Height
		}
		f.Close()
	}
	return c
}

// sentChips son los chips de las imágenes que viajan con text; la cola se
// vacía al enviar, igual que la de chat.
func (m *Model) sentChips(text string) []imageChip {
	var out []imageChip
	upper := strings.ToUpper(text)
	for _, c := range m.chips {
		if strings.Contains(upper, fmt.Sprintf("[IMG#%d]", c.n)) {
			out = append(out, c)
		}
	}
	m.chips = nil
	return out
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
	if n := len(m.chips); n > 0 && strings.EqualFold(marker, fmt.Sprintf("[IMG#%d]", m.chips[n-1].n)) {
		m.chips = m.chips[:n-1]
	}
	m.refreshMenu()
	return true
}
