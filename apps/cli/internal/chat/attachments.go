package chat

import (
	"fmt"
	"strings"

	"lixbon.com/cli/internal/documents"
	"lixbon.com/cli/internal/history"
)

// AttachmentError impide enviar un mensaje cuyos únicos adjuntos fallaron.
type AttachmentError struct{ Messages []string }

func (e *AttachmentError) Error() string { return strings.Join(e.Messages, "\n") }

// StageImage deja una imagen en cola y devuelve su marcador [IMG#n]. La imagen
// solo viaja con el mensaje que contenga el marcador.
func (c *Chat) StageImage(path string) (string, error) {
	if _, err := documents.EncodeImage(path); err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pendingImages = append(c.pendingImages, path)
	return documents.ImageMarker(len(c.pendingImages)), nil
}

// DropStagedImage descarta la última imagen en cola, la del marcador que el
// usuario acaba de borrar. Borrar uno de en medio no puede descartarla: los
// índices de los que vienen detrás ya están escritos en el mensaje.
func (c *Chat) DropStagedImage(marker string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var index int
	if _, err := fmt.Sscanf(strings.ToUpper(marker), "[IMG#%d]", &index); err == nil && index == len(c.pendingImages) {
		c.pendingImages = c.pendingImages[:index-1]
	}
}

func (c *Chat) takeStagedImages() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	staged := c.pendingImages
	c.pendingImages = nil
	return staged
}

// prepared es el mensaje de usuario con sus adjuntos resueltos.
type prepared struct {
	message history.Message
	text    string
	files   []documents.File
	skipped []string
}

// prepare resuelve los @ruta y los marcadores de imagen. Los adjuntos que
// fallan se omiten y se avisan; si no queda nada que enviar, devuelve error.
func (c *Chat) prepare(text string) (prepared, error) {
	found := documents.ParseAttachments(text, c.Workspace)
	if len(found.Errors) > 0 && found.Clean == "" {
		return prepared{}, &AttachmentError{found.Errors}
	}
	skipped := found.Errors
	images := append(documents.ParseImageMarkers(found.Clean, c.takeStagedImages()), found.Images...)

	var encoded []string
	for _, path := range images {
		data, err := documents.EncodeImage(path)
		if err != nil {
			skipped = append(skipped, err.Error())
			continue
		}
		encoded = append(encoded, data)
	}

	content := found.Clean
	if content == "" {
		content = text
	}
	if len(found.Files) > 0 {
		content += "\n\n" + documents.Block(found.Files)
	}
	message := history.User(content)
	message.Images = encoded
	return prepared{message: message, text: firstNonEmpty(found.Clean, text), files: found.Files, skipped: skipped}, nil
}
