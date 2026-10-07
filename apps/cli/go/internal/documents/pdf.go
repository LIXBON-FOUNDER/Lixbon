package documents

import (
	"errors"
	"fmt"
	"math"
	"os"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"

	"lixbon.com/cli/internal/textutil"
)

const noPDFText = "(el PDF no tiene texto extraíble: probablemente es un escaneo; conviértelo a imagen para que el modelo lo vea)"

// avgGlyphWidth estima el ancho de un carácter en em: la biblioteca no calcula
// anchos de glifo, solo dónde empieza cada operación de texto.
const avgGlyphWidth = 0.5

// extractionTimeout acota la extracción: una biblioteca PDF puede colgarse con
// un archivo dañado a propósito y el mensaje no debe quedarse esperando.
var extractionTimeout = 30 * time.Second

// PDFText devuelve el texto de un PDF, página a página con un separador para
// que el modelo pueda citar «página N». Un PDF escaneado (solo imágenes)
// devuelve un aviso en lugar de texto. La extracción es local y no usa OCR.
func PDFText(path string) (string, error) {
	type result struct {
		text string
		err  error
	}
	done := make(chan result, 1)
	go func() {
		text, err := extractPDF(path)
		done <- result{text, err}
	}()
	select {
	case r := <-done:
		return r.text, r.err
	case <-time.After(extractionTimeout):
		return "", errors.New("el PDF tardó demasiado en leerse y se abandonó")
	}
}

func extractPDF(path string) (text string, err error) {
	defer func() {
		if r := recover(); r != nil {
			text, err = "", fmt.Errorf("el PDF no se pudo leer: %v", r)
		}
	}()
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	reader, err := pdf.NewReader(file, info.Size())
	if err != nil {
		return "", pdfError(err)
	}

	total := reader.NumPage()
	parts := make([]string, 0, min(total, MaxPDFPages)+1)
	hasText, unreadable := false, 0
	for i := 1; i <= min(total, MaxPDFPages); i++ {
		raw, ok := pageText(reader.Page(i))
		text := textutil.Strip(raw)
		hasText = hasText || text != ""
		if !ok {
			unreadable++
		}
		parts = append(parts, fmt.Sprintf("── página %d ──\n%s", i, text))
	}
	if total > MaxPDFPages {
		parts = append(parts, fmt.Sprintf("…[%d páginas más no extraídas]", total-MaxPDFPages))
	}
	switch {
	case !hasText && unreadable > 0:
		return "", errors.New("no se pudo interpretar el texto del PDF (fuente o codificación no admitida)")
	case !hasText:
		return noPDFText, nil
	}
	return strings.Join(parts, "\n"), nil
}

func pdfError(err error) error {
	switch msg := err.Error(); {
	case strings.Contains(msg, "encrypted"):
		return errors.New("el PDF está cifrado con contraseña")
	case strings.Contains(msg, "not a PDF"):
		return errors.New("el archivo no es un PDF válido o está dañado")
	default:
		return fmt.Errorf("el PDF no se pudo abrir: %s", msg)
	}
}

// pageText ensambla las líneas desde las posiciones de cada operación de
// texto: un salto de Y abre línea nueva y un hueco claro entre dos operaciones
// de la misma línea (celdas de una tabla) pone un espacio. ok es false si la
// biblioteca no logró interpretar la página.
func pageText(page pdf.Page) (out string, ok bool) {
	defer func() {
		if recover() != nil {
			out, ok = "", false
		}
	}()
	var text strings.Builder
	var prev pdf.Text
	var last rune
	opX, opChars := 0.0, 0
	for i, ch := range page.Content().Text {
		size := math.Max(ch.FontSize, 1)
		switch {
		case i == 0:
			opX = ch.X
		case math.Abs(ch.Y-prev.Y) > 0.4*size:
			if last != '\n' {
				text.WriteByte('\n')
			}
			opX, opChars = ch.X, 0
		case ch.X != prev.X:
			previousSize := math.Max(prev.FontSize, 1)
			expected := float64(opChars) * avgGlyphWidth * previousSize
			if ch.X-opX-expected > previousSize && last != ' ' && last != '\n' && ch.S != " " {
				text.WriteByte(' ')
			}
			opX, opChars = ch.X, 0
		}
		text.WriteString(ch.S)
		if r, _ := utf8.DecodeLastRuneInString(ch.S); r != utf8.RuneError {
			last = r
		}
		if ch.S != "\n" {
			opChars++
		}
		prev = ch
	}
	return text.String(), true
}
