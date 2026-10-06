// Package textutil reúne las semánticas de texto de Python que el contrato
// con el CLI actual exige conservar (decodificación con reemplazo, espacios
// Unicode, saltos de línea de str.splitlines).
package textutil

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// DecodeLossy replica el errors="replace" de Python: cada subsecuencia
// inválida máxima se sustituye por un único U+FFFD (strings.ToValidUTF8
// colapsaría rachas de bytes inválidos en uno solo).
func DecodeLossy(b []byte) string {
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		if r == utf8.RuneError && size == 1 {
			sb.WriteRune(utf8.RuneError)
			size = invalidPrefixLen(b)
		} else {
			sb.Write(b[:size])
		}
		b = b[size:]
	}
	return sb.String()
}

func invalidPrefixLen(b []byte) int {
	lo, hi := byte(0x80), byte(0xBF)
	var need int
	switch lead := b[0]; {
	case lead >= 0xC2 && lead <= 0xDF:
		need = 1
	case lead == 0xE0:
		need, lo = 2, 0xA0
	case lead == 0xED:
		need, hi = 2, 0x9F
	case lead >= 0xE1 && lead <= 0xEF:
		need = 2
	case lead == 0xF0:
		need, lo = 3, 0x90
	case lead == 0xF4:
		need, hi = 3, 0x8F
	case lead >= 0xF1 && lead <= 0xF3:
		need = 3
	default:
		return 1
	}
	n := 1
	for i := 1; i <= need && i < len(b); i++ {
		minB, maxB := byte(0x80), byte(0xBF)
		if i == 1 {
			minB, maxB = lo, hi
		}
		if b[i] < minB || b[i] > maxB {
			break
		}
		n++
	}
	return n
}

// IsSpace equivale a str.isspace de Python.
func IsSpace(r rune) bool {
	return unicode.IsSpace(r) || (r >= 0x1c && r <= 0x1f)
}

func Strip(s string) string  { return strings.TrimFunc(s, IsSpace) }
func RStrip(s string) string { return strings.TrimRightFunc(s, IsSpace) }

// Head devuelve los primeros n caracteres (no bytes) de s.
func Head(s string, n int) string {
	if len(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}

func RuneLen(s string) int { return utf8.RuneCountInString(s) }
