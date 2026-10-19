package tools

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
)

// Browser es el navegador del agente (browser.Manager lo implementa).
type Browser interface {
	Run(ctx context.Context, tool string, args map[string]any) (string, [][]byte, error)
	// Origin es el origen sobre el que actuará tool, para pedir permiso.
	Origin(ctx context.Context, tool string, args map[string]any) (string, error)
	// Describe da la etiqueta de una ref del último snapshot y si el campo es
	// sensible (contraseña, tarjeta, código).
	Describe(ref string) (label string, sensitive bool)
	// Release quita el aviso al acabar el turno; Resume dice en qué pestaña
	// quedó el agente para retomarla.
	Release()
	Resume() string
	Close()
}

var errBrowserOff = errors.New("el navegador del agente está desactivado (actívalo con /browser on)")

func isBrowserTool(name string) bool { return strings.HasPrefix(name, "browser_") }

func (tb *Toolbox) runBrowser(ctx context.Context, name string, args map[string]any) (string, error) {
	if tb.Browser == nil {
		return "", errBrowserOff
	}
	out, images, err := tb.Browser.Run(ctx, name, args)
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", err
	}
	tb.images = append(tb.images, images...)
	// La captura también queda en un archivo para que el agente pueda
	// enseñársela al usuario con show_image.
	if name == "browser_screenshot" && len(images) > 0 {
		if path, err := saveScreenshot(images[0]); err == nil {
			out += "\nGuardada en " + path + " (show_image se la enseña al usuario)."
		}
	}
	return out, nil
}

// TakeImages devuelve (en base64) y olvida las imágenes que adjuntaron las
// herramientas desde la última llamada: no caben en el resultado de texto.
func (tb *Toolbox) TakeImages() []string {
	out := make([]string, len(tb.images))
	for i, img := range tb.images {
		out[i] = base64.StdEncoding.EncodeToString(img)
	}
	tb.images = nil
	return out
}
