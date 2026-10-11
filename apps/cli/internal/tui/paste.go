package tui

import (
	"github.com/atotto/clipboard"

	tea "charm.land/bubbletea/v2"
)

// clipboardImageMsg: el portapapeles no tenía texto; se prueba con una imagen.
type clipboardImageMsg struct{}

// pasteClipboard atiende Ctrl+V cuando la terminal no lo convierte en un
// pegado (la mandan como tecla): lee el portapapeles del sistema, porque la
// lectura por OSC 52 que haría la caja no la contesta casi ninguna terminal.
func pasteClipboard() tea.Msg {
	text, err := clipboard.ReadAll()
	if err != nil || text == "" {
		return clipboardImageMsg{}
	}
	return tea.PasteMsg{Content: text}
}
