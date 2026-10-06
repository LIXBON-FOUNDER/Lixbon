// Package agent contiene la lógica del agente de código: política de
// aprobación de comandos, prompts, detección de repeticiones y el bucle del
// turno. No depende de ninguna interfaz: emite eventos que la UI consume.
package agent

import (
	"regexp"
	"strings"

	"lixbon.com/cli/internal/textutil"
)

var (
	prefixWord     = regexp.MustCompile(`^[\p{L}\p{N}_.-]+$`)
	commandChainRe = regexp.MustCompile(`&&|\|\||;|\|`)
)

// CommandPrefix es lo que se guarda al decir «siempre para este comando»: el
// programa y su subcomando (`npm test`, `git status`), no la línea entera.
func CommandPrefix(command string) string {
	words := strings.FieldsFunc(command, textutil.IsSpace)
	if len(words) == 0 {
		return ""
	}
	if len(words) >= 2 && prefixWord.MatchString(words[1]) && !strings.HasPrefix(words[1], "-") {
		return words[0] + " " + words[1]
	}
	return words[0]
}

// CommandAllowed exige que TODOS los tramos de un comando encadenado (`&&`,
// `;`, `|`) estén permitidos: «npm test» no cubre «npm test && rm -rf x». Un
// prefijo vacío o solo de espacios no permite nada (Python lo trataba como
// comodín).
func CommandAllowed(command string, allowed []string) bool {
	var segments []string
	for _, seg := range commandChainRe.Split(command, -1) {
		if seg = textutil.Strip(seg); seg != "" {
			segments = append(segments, seg)
		}
	}
	if len(segments) == 0 {
		return false
	}
	for _, seg := range segments {
		words := strings.FieldsFunc(seg, textutil.IsSpace)
		if !coveredByAny(words, allowed) {
			return false
		}
	}
	return true
}

func coveredByAny(words, allowed []string) bool {
	for _, prefix := range allowed {
		parts := strings.FieldsFunc(prefix, textutil.IsSpace)
		if len(parts) == 0 || len(words) < len(parts) {
			continue
		}
		match := true
		for i, p := range parts {
			if words[i] != p {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
