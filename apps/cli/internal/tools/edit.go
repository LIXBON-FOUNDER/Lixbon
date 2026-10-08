package tools

import (
	"fmt"
	"strings"

	"lixbon.com/cli/internal/textutil"
)

// Las funciones Apply* calculan el resultado de una edición sobre texto en
// memoria. Las comparten las herramientas (que luego escriben el archivo) y la
// vista previa de aprobación, de modo que lo que el usuario aprueba es
// exactamente lo que se escribe.

// EditResult describe el desenlace de una edición: Failure no vacío es el
// mensaje de error que ve el modelo; si no, Updated es el contenido nuevo y
// Message el resumen de éxito.
type EditResult struct {
	Updated string
	Message string
	Failure string
}

func (r EditResult) OK() bool { return r.Failure == "" }

func ApplyEdit(content, relPath, oldText, newText string, replaceAll bool) EditResult {
	if oldText == "" {
		return EditResult{Failure: "[ERROR] Falta old_text (el fragmento exacto a reemplazar)"}
	}
	count := strings.Count(content, oldText)
	if count == 0 {
		return applyLoose(content, relPath, oldText, newText)
	}
	if count > 1 && !replaceAll {
		return EditResult{Failure: fmt.Sprintf("[ERROR] old_text aparece %d veces en %s; añade más líneas de contexto para que sea único, o pasa \"all\":true para reemplazar todas",
			count, relPath)}
	}
	line := strings.Count(content[:strings.Index(content, oldText)], "\n") + 1
	n := 1
	if replaceAll {
		n = -1
	}
	where := fmt.Sprintf("1 reemplazo en la línea %d", line)
	if count > 1 {
		where = fmt.Sprintf("%d reemplazos", count)
	}
	return EditResult{
		Updated: strings.Replace(content, oldText, newText, n),
		Message: fmt.Sprintf("Archivo editado: %s (%s)", relPath, where),
	}
}

func leadingSpace(line string) string {
	return line[:len(line)-len(strings.TrimLeftFunc(line, textutil.IsSpace))]
}

func findBlock(lines, wanted []string, key func(string) string) []int {
	n := len(wanted)
	mapped := make([]string, n)
	for i, w := range wanted {
		mapped[i] = key(w)
	}
	var hits []int
	for i := 0; i+n <= len(lines); i++ {
		match := true
		for j := 0; j < n; j++ {
			if key(lines[i+j]) != mapped[j] {
				match = false
				break
			}
		}
		if match {
			hits = append(hits, i)
		}
	}
	return hits
}

// applyLoose acepta un old_text que solo difiere en espacios finales o en la
// indentación, siempre que el bloque sea único; new_text hereda la
// indentación real del archivo y se conservan los finales CRLF.
func applyLoose(content, relPath, oldText, newText string) EditResult {
	lines := strings.Split(content, "\n")
	oldLines := strings.Split(strings.Trim(oldText, "\n"), "\n")
	newLines := strings.Split(newText, "\n")
	strategies := []struct {
		key      func(string) string
		reindent bool
	}{{textutil.RStrip, false}, {textutil.Strip, true}}
	for _, s := range strategies {
		hits := findBlock(lines, oldLines, s.key)
		if len(hits) > 1 {
			return EditResult{Failure: fmt.Sprintf("[ERROR] old_text (salvo espacios) aparece %d veces en %s; añade más líneas de contexto para que sea único",
				len(hits), relPath)}
		}
		if len(hits) == 0 {
			continue
		}
		i := hits[0]
		if s.reindent {
			fileWS, oldWS := leadingSpace(lines[i]), leadingSpace(oldLines[0])
			reindented := make([]string, len(newLines))
			for k, l := range newLines {
				if strings.HasPrefix(l, oldWS) && textutil.Strip(l) != "" {
					l = fileWS + l[len(oldWS):]
				}
				reindented[k] = l
			}
			newLines = reindented
		}
		if strings.Contains(content, "\r\n") {
			crlf := make([]string, len(newLines))
			for k, l := range newLines {
				crlf[k] = strings.TrimRight(l, "\r") + "\r"
			}
			newLines = crlf
		}
		updated := append(append(append([]string{}, lines[:i]...), newLines...), lines[i+len(oldLines):]...)
		return EditResult{
			Updated: strings.Join(updated, "\n"),
			Message: fmt.Sprintf("Archivo editado: %s (1 reemplazo en la línea %d; old_text coincidió ignorando espacios e indentación)",
				relPath, i+1),
		}
	}
	return EditResult{Failure: fmt.Sprintf("[ERROR] No se encontró old_text en %s. Debe coincidir con el archivo (usa read_file y copia el fragmento tal cual, con sus líneas completas)",
		relPath)}
}

// MultiEditResult añade cuántas ediciones llegaron a aplicarse: si una falla,
// las anteriores ya forman parte de Updated.
type MultiEditResult struct {
	EditResult
	Applied int
}

// ApplyMultiEdit aplica las ediciones en orden y se detiene en la primera que
// falla, conservando las anteriores.
func ApplyMultiEdit(content, relPath string, edits any) MultiEditResult {
	list, _ := edits.([]any)
	if len(list) == 0 {
		return MultiEditResult{EditResult: EditResult{Updated: content, Failure: "[ERROR] edits debe ser una lista de {old_text, new_text}"}}
	}
	current := content
	done := make([]string, 0, len(list))
	for i, item := range list {
		edit, ok := item.(map[string]any)
		if !ok {
			return MultiEditResult{EditResult: EditResult{Updated: current,
				Failure: fmt.Sprintf("[ERROR] La edición %d no es un objeto {old_text, new_text}", i+1)}, Applied: i}
		}
		res := ApplyEdit(current, relPath, pyStr(edit["old_text"]), pyStr(edit["new_text"]), truthy(edit["all"]))
		if !res.OK() {
			applied := ""
			if i > 0 {
				applied = fmt.Sprintf(" Ya se aplicaron las %d anteriores.", i)
			}
			return MultiEditResult{EditResult: EditResult{Updated: current,
				Failure: fmt.Sprintf("[ERROR] Edición %d de %d: %s.%s", i+1, len(list), strings.TrimPrefix(res.Failure, "[ERROR] "), applied)}, Applied: i}
		}
		current = res.Updated
		detail := res.Message
		if _, after, found := strings.Cut(res.Message, "("); found {
			detail = after
		}
		done = append(done, strings.TrimRight(detail, ")"))
	}
	return MultiEditResult{EditResult: EditResult{Updated: current,
		Message: fmt.Sprintf("Archivo editado: %s (%d ediciones: %s)", relPath, len(list), strings.Join(done, "; "))}, Applied: len(list)}
}

// ApplyInsert inserta content antes de la línea indicada (1-based); line <= 0
// o mayor que el total inserta al final, delante del salto final del archivo.
// Devuelve el contenido nuevo, cuántas líneas se insertaron y la posición.
func ApplyInsert(original string, line int, content string) (updated string, inserted, position int) {
	nl := "\n"
	if strings.Contains(original, "\r\n") {
		nl = "\r\n"
	}
	lines := strings.Split(original, nl)
	if !strings.HasSuffix(content, "\n") {
		content += nl
	}
	fresh := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	fresh = fresh[:len(fresh)-1]

	idx := line - 1
	if line <= 0 || line > len(lines) {
		idx = len(lines)
	}
	if idx == len(lines) && lines[len(lines)-1] == "" {
		idx--
	}
	result := append(append(append([]string{}, lines[:idx]...), fresh...), lines[idx:]...)
	return strings.Join(result, nl), len(fresh), idx + 1
}
