package tools

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"lixbon.com/cli/internal/documents"
)

const truncatedLineMark = "…[línea truncada]"

// ReadFile lee un archivo de texto en una sola pasada y con memoria acotada:
// solo conserva el rango pedido o los primeros 120.000 caracteres.
//
// Diferencias deliberadas con Python: un end_line negativo se trata como
// ausente, y un rango que superaría los 120.000 caracteres se corta con aviso.
func ReadFile(ctx context.Context, root, relPath string, startLine, endLine int) (string, error) {
	target, _, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		return "Archivo no encontrado: " + relPath, nil
	}
	switch ext := strings.ToLower(pySuffix(info.Name())); ext {
	case ".png", ".jpg", ".jpeg", ".webp":
		return fmt.Sprintf("[imagen] %s (%d kB): se te adjunta como imagen en el siguiente mensaje para que la veas directamente.",
			info.Name(), info.Size()/1024), nil
	case ".pdf", ".docx":
		text, err := documentText(target, ext)
		if err != nil {
			return "", err
		}
		return readLines(ctx, strings.NewReader(text), startLine, endLine)
	}
	if isBinary(target) {
		return fmt.Sprintf("[binario] %s (%s): no es texto ni un formato que sepa leer (pdf, docx, png/jpg/webp).",
			info.Name(), fmtSize(info.Size())), nil
	}
	f, err := os.Open(target)
	if err != nil {
		return "", err
	}
	defer f.Close()
	return readLines(ctx, f, startLine, endLine)
}

func documentText(path, ext string) (string, error) {
	if ext == ".pdf" {
		return documents.PDFText(path)
	}
	return documents.DocxText(path)
}

func readLines(ctx context.Context, r io.Reader, startLine, endLine int) (string, error) {
	reader := newLineReader(r, maxLineBytes, true)
	if startLine != 0 || endLine != 0 {
		return readRange(ctx, reader, startLine, endLine)
	}
	return readWhole(ctx, reader)
}

func readWhole(ctx context.Context, reader *lineReader) (string, error) {
	var kept strings.Builder
	chars, total := 0, 0
	overflow := false
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		line, truncated, ok := reader.next()
		if !ok {
			break
		}
		total++
		if overflow {
			continue
		}
		if total > 1 {
			kept.WriteByte('\n')
			chars++
		}
		kept.WriteString(line)
		chars += utf8.RuneCountInString(line)
		if truncated || chars > maxReadChars {
			overflow = true
		}
	}
	if reader.err != nil {
		return "", reader.err
	}
	if !overflow {
		return kept.String(), nil
	}
	return fmt.Sprintf("(archivo grande: %d líneas; pide rangos con start_line/end_line)\n", total) +
		headRunes(kept.String(), maxReadChars), nil
}

func readRange(ctx context.Context, reader *lineReader, startLine, endLine int) (string, error) {
	start := max(1, startLine)
	if endLine < 0 {
		endLine = 0
	}
	var picked []string
	chars, total := 0, 0
	cut := false
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		line, truncated, ok := reader.next()
		if !ok {
			break
		}
		total++
		if total < start || (endLine != 0 && total > endLine) || cut {
			continue
		}
		if truncated {
			line += truncatedLineMark
		}
		chars += utf8.RuneCountInString(line) + 1
		if chars > maxReadChars {
			cut = true
			continue
		}
		picked = append(picked, line)
	}
	if reader.err != nil {
		return "", reader.err
	}
	end := total
	if endLine != 0 {
		end = min(total, endLine)
	}
	out := fmt.Sprintf("(líneas %d-%d de %d)\n", start, end, total) + strings.Join(picked, "\n")
	if cut {
		out += fmt.Sprintf("\n…[rango truncado a %d caracteres; pide menos líneas]", maxReadChars)
	}
	return out, nil
}

func headRunes(s string, n int) string {
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}
