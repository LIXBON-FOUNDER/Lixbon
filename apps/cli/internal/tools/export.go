package tools

import (
	"os"

	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/toolspec"
)

// ResolveSafe resuelve una ruta del modelo dentro del workspace y devuelve la
// ruta real del destino y la raíz real; falla si queda fuera de la raíz.
func ResolveSafe(root, userPath string) (target, realRoot string, err error) {
	return resolveSafe(root, userPath)
}

// WriteFileAtomic escribe sin dejar el archivo a medias si algo falla.
func WriteFileAtomic(path string, data []byte) error { return writeAtomic(path, data) }

// ReadTextLossy lee un archivo de texto sustituyendo los bytes inválidos por
// U+FFFD y sin tocar los saltos de línea; ok es false si no es un archivo regular.
func ReadTextLossy(path string) (text string, ok bool) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return textutil.DecodeLossy(data), true
}

// IsMutating indica si la herramienta modifica archivos (candidata a snapshot).
func IsMutating(name string) bool { return toolspec.IsMutating(name) }
