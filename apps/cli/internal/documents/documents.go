// Package documents lee lo que no es texto plano (PDF y Word), codifica las
// imágenes para el modelo y resuelve los adjuntos @ruta del mensaje. Contrato
// fijado por validation/fixtures/documents_corpus.json.
package documents

import (
	"encoding/base64"
	"fmt"
	"os"
	"strings"
)

const (
	MaxPDFPages            = 200
	MaxImageBytes          = 8 << 20
	MaxTextAttachmentBytes = 64 << 10
)

// Suffix replica Path.suffix: ".gitignore" y "a." no tienen extensión.
func Suffix(name string) string {
	name = name[strings.LastIndexAny(name, `/\`)+1:]
	if i := strings.LastIndex(name, "."); i > 0 && i < len(name)-1 {
		return name[i:]
	}
	return ""
}

func hasSuffix(path string, exts ...string) bool {
	suffix := strings.ToLower(Suffix(path))
	for _, ext := range exts {
		if suffix == ext {
			return true
		}
	}
	return false
}

func IsImage(path string) bool { return hasSuffix(path, ".png", ".jpg", ".jpeg", ".webp") }
func IsPDF(path string) bool   { return hasSuffix(path, ".pdf") }
func IsDocx(path string) bool  { return hasSuffix(path, ".docx") }

// EncodeImage valida una imagen y la devuelve en base64, como la espera el
// campo images de los mensajes.
func EncodeImage(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("No existe la imagen: %s", path)
	}
	if !IsImage(path) {
		return "", fmt.Errorf("Formato no soportado (%s); usa png/jpg/jpeg/webp", Suffix(path))
	}
	if info.Size() > MaxImageBytes {
		return "", fmt.Errorf("La imagen supera el límite de 8 MB: %s", baseName(path))
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("No se pudo leer la imagen %s: %v", baseName(path), err)
	}
	if len(data) > MaxImageBytes {
		return "", fmt.Errorf("La imagen supera el límite de 8 MB: %s", baseName(path))
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

func baseName(path string) string { return path[strings.LastIndexAny(path, `/\`)+1:] }
