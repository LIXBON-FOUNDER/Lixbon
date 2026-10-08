package documents

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"lixbon.com/cli/internal/textutil"
)

type File struct{ Name, Content string }

// Attachments es lo que un mensaje arrastra con sus @ruta: las imágenes viajan
// aparte y los archivos de texto se anexan, para que el modelo los tenga aunque
// esté en modo ask y no pueda leerlos.
type Attachments struct {
	Clean  string
	Images []string
	Files  []File
	Errors []string
}

const trailingPunctuation = ".,;:!?)]"

// ParseAttachments extrae los @ruta del mensaje. Un @token que no apunta a
// nada del disco se deja tal cual: puede ser un usuario o un handle.
func ParseAttachments(text, baseDir string) Attachments {
	var out Attachments
	var clean strings.Builder
	for pos := 0; pos < len(text); {
		at := strings.IndexByte(text[pos:], '@')
		if at < 0 {
			clean.WriteString(text[pos:])
			break
		}
		at += pos
		raw, end, ok := matchAttachment(text, at)
		if !ok {
			clean.WriteString(text[pos : at+1])
			pos = at + 1
			continue
		}
		clean.WriteString(text[pos:at])
		clean.WriteString(out.resolve(text[at:end], raw, baseDir))
		pos = end
	}
	out.Clean = textutil.Strip(clean.String())
	return out
}

// matchAttachment reconoce `@"ruta con espacios"` o `@ruta`; en la segunda
// forma la puntuación pegada al final («@logo.png,») no forma parte de la ruta.
func matchAttachment(text string, at int) (raw string, end int, ok bool) {
	rest := text[at+1:]
	if strings.HasPrefix(rest, `"`) {
		if close := strings.IndexByte(rest[1:], '"'); close > 0 {
			return rest[1 : 1+close], at + 1 + 1 + close + 1, true
		}
	}
	token := rest
	if i := strings.IndexFunc(rest, textutil.IsSpace); i >= 0 {
		token = rest[:i]
	}
	if token == "" {
		return "", 0, false
	}
	keep := len(strings.TrimRight(token, trailingPunctuation))
	if keep == 0 {
		_, keep = utf8.DecodeRuneInString(token)
	}
	return token[:keep], at + 1 + keep, true
}

func (a *Attachments) resolve(match, raw, baseDir string) string {
	path := raw
	if !filepath.IsAbs(path) {
		path = filepath.Join(baseDir, path)
	}
	if IsImage(path) {
		if _, err := os.Stat(path); err != nil {
			a.Errors = append(a.Errors, "No existe la imagen: "+raw)
			return ""
		}
		a.Images = append(a.Images, resolvePath(path))
		return baseName(path)
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return match
	}
	if IsPDF(path) {
		content, err := PDFText(path)
		if err != nil {
			a.Errors = append(a.Errors, fmt.Sprintf("No se pudo leer el PDF %s: %v", raw, err))
			return raw
		}
		a.Files = append(a.Files, File{raw, content})
		return raw
	}
	if info.Size() > MaxTextAttachmentBytes {
		a.Errors = append(a.Errors, raw+" supera los 64 kB: pide al agente que lo lea por partes")
		return raw
	}
	data, err := os.ReadFile(path)
	switch {
	case err != nil:
		a.Errors = append(a.Errors, fmt.Sprintf("No se pudo leer %s: %v", raw, err))
	case !utf8.Valid(data):
		a.Errors = append(a.Errors, raw+" no es un archivo de texto")
	default:
		a.Files = append(a.Files, File{raw, strings.ReplaceAll(string(data), "\r\n", "\n")})
	}
	return raw
}

func resolvePath(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}

// Block son los archivos adjuntos, listos para ir detrás del mensaje.
func Block(files []File) string {
	parts := make([]string, len(files))
	for i, f := range files {
		fence := "```"
		if strings.Contains(f.Content, "```") {
			fence = "````"
		}
		parts[i] = fmt.Sprintf("Archivo adjunto `%s`:\n%s\n%s\n%s", f.Name, fence, textutil.RStrip(f.Content), fence)
	}
	return strings.Join(parts, "\n\n")
}

var imageMarker = regexp.MustCompile(`(?i)\[IMG#(\d+)\]`)

// ImageMarker es el marcador de una imagen en cola, único al pegar, al
// adjuntar y al enviar.
func ImageMarker(index int) string { return fmt.Sprintf("[IMG#%d]", index) }

// ParseImageMarkers devuelve las imágenes de staged que el texto referencia. El
// marcador ES el adjunto: si el usuario lo borra, la imagen no se envía. El
// orden lo marca el texto, no la cola.
func ParseImageMarkers(text string, staged []string) []string {
	var images []string
	for _, m := range imageMarker.FindAllStringSubmatch(text, -1) {
		index, err := strconv.Atoi(m[1])
		if err != nil || index < 1 || index > len(staged) {
			continue
		}
		if path := staged[index-1]; !contains(images, path) {
			images = append(images, path)
		}
	}
	return images
}

func contains(list []string, item string) bool {
	for _, s := range list {
		if s == item {
			return true
		}
	}
	return false
}
