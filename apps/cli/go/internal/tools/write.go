package tools

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"lixbon.com/cli/internal/textutil"
)

var errNotUTF8 = errors.New("el archivo no es UTF-8 válido; no se edita para no corromperlo")

// writeAtomic escribe en un temporal del mismo directorio y lo renombra, de
// modo que un corte a mitad de escritura no deja el archivo truncado. Si el
// renombrado falla (archivo abierto en Windows) cae a escritura directa.
func writeAtomic(path string, data []byte) error {
	perm := os.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		perm = info.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".lxb-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		os.Remove(tmpName)
		return errors.Join(werr, cerr)
	}
	if err := os.Chmod(tmpName, perm); err == nil {
		if err := os.Rename(tmpName, path); err == nil {
			return nil
		}
	}
	os.Remove(tmpName)
	return os.WriteFile(path, data, perm)
}

// readText lee un archivo exacto (sin traducir saltos de línea) y rechaza lo
// que no sea UTF-8, para no sustituir bytes por U+FFFD al reescribirlo.
func readText(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(data) {
		return "", errNotUTF8
	}
	return string(data), nil
}

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func WriteFile(ctx context.Context, root, relPath, content string) (string, error) {
	target, realRoot, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	_, statErr := os.Stat(target)
	isNew := statErr != nil
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := writeAtomic(target, []byte(content)); err != nil {
		return "", err
	}
	action := "actualizado"
	if isNew {
		action = "creado"
	}
	return fmt.Sprintf("Archivo %s: %s (%d chars)", action, relPosix(realRoot, target), utf8.RuneCountInString(content)), nil
}

func AppendFile(ctx context.Context, root, relPath, content string) (string, error) {
	target, realRoot, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	f, err := os.OpenFile(target, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	if _, err := f.WriteString(content); err != nil {
		f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return fmt.Sprintf("Archivo actualizado: %s (+%d chars)", relPosix(realRoot, target), utf8.RuneCountInString(content)), nil
}

func Mkdir(ctx context.Context, root, relPath string) (string, error) {
	target, realRoot, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return "", err
	}
	return "Directorio creado/listo: " + relPosix(realRoot, target), nil
}

// DeleteFile elimina un archivo o una carpeta entera. Se niega a borrar la
// raíz del workspace, que resolveSafe sí permite nombrar (".").
func DeleteFile(ctx context.Context, root, relPath string) (string, error) {
	target, realRoot, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil {
		return "No encontrado: " + relPath, nil
	}
	if target == realRoot {
		return "", errors.New("no se puede eliminar la raíz del workspace")
	}
	if info.IsDir() {
		if err := os.RemoveAll(target); err != nil {
			return "", err
		}
		return "Directorio eliminado: " + relPath, nil
	}
	if err := os.Remove(target); err != nil {
		return "", err
	}
	return "Archivo eliminado: " + relPath, nil
}

func RenameFile(ctx context.Context, root, src, dst string) (string, error) {
	source, _, err := resolveSafe(root, src)
	if err != nil {
		return "", err
	}
	dest, _, err := resolveSafe(root, dst)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(source); err != nil {
		return "No encontrado: " + src, nil
	}
	if _, err := os.Stat(dest); err == nil {
		return "[ERROR] Ya existe el destino: " + dst, nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(source, dest); err != nil {
		return "", err
	}
	return fmt.Sprintf("Movido: %s → %s", src, dst), nil
}

func EditFile(ctx context.Context, root, relPath, oldText, newText string, replaceAll bool) (string, error) {
	target, _, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	if !regularFile(target) {
		return "Archivo no encontrado: " + relPath, nil
	}
	if oldText == "" {
		return "[ERROR] Falta old_text (el fragmento exacto a reemplazar)", nil
	}
	content, err := readText(target)
	if err != nil {
		return "", err
	}
	count := strings.Count(content, oldText)
	if count == 0 {
		return editLoose(target, relPath, content, oldText, newText)
	}
	if count > 1 && !replaceAll {
		return fmt.Sprintf("[ERROR] old_text aparece %d veces en %s; añade más líneas de contexto para que sea único, o pasa \"all\":true para reemplazar todas",
			count, relPath), nil
	}
	line := strings.Count(content[:strings.Index(content, oldText)], "\n") + 1
	n := 1
	if replaceAll {
		n = -1
	}
	if err := writeAtomic(target, []byte(strings.Replace(content, oldText, newText, n))); err != nil {
		return "", err
	}
	where := fmt.Sprintf("1 reemplazo en la línea %d", line)
	if count > 1 {
		where = fmt.Sprintf("%d reemplazos", count)
	}
	return fmt.Sprintf("Archivo editado: %s (%s)", relPath, where), nil
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

// editLoose acepta un old_text que solo difiere en espacios finales o en la
// indentación, siempre que el bloque sea único; new_text hereda la
// indentación real del archivo y se conservan los finales CRLF.
func editLoose(target, relPath, content, oldText, newText string) (string, error) {
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
			return fmt.Sprintf("[ERROR] old_text (salvo espacios) aparece %d veces en %s; añade más líneas de contexto para que sea único",
				len(hits), relPath), nil
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
		if err := writeAtomic(target, []byte(strings.Join(updated, "\n"))); err != nil {
			return "", err
		}
		return fmt.Sprintf("Archivo editado: %s (1 reemplazo en la línea %d; old_text coincidió ignorando espacios e indentación)",
			relPath, i+1), nil
	}
	return fmt.Sprintf("[ERROR] No se encontró old_text en %s. Debe coincidir con el archivo (usa read_file y copia el fragmento tal cual, con sus líneas completas)",
		relPath), nil
}

// MultiEdit aplica las ediciones en orden; si una falla, las anteriores ya
// quedaron escritas y el mensaje lo dice.
func MultiEdit(ctx context.Context, root, relPath string, edits any) (string, error) {
	list, _ := edits.([]any)
	if len(list) == 0 {
		return "[ERROR] edits debe ser una lista de {old_text, new_text}", nil
	}
	done := make([]string, 0, len(list))
	for i, item := range list {
		edit, ok := item.(map[string]any)
		if !ok {
			return fmt.Sprintf("[ERROR] La edición %d no es un objeto {old_text, new_text}", i+1), nil
		}
		out, err := EditFile(ctx, root, relPath, pyStr(edit["old_text"]), pyStr(edit["new_text"]), truthy(edit["all"]))
		if err != nil {
			return "", err
		}
		if strings.HasPrefix(out, "[ERROR]") {
			applied := ""
			if i > 0 {
				applied = fmt.Sprintf(" Ya se aplicaron las %d anteriores.", i)
			}
			return fmt.Sprintf("[ERROR] Edición %d de %d: %s.%s", i+1, len(list), strings.TrimPrefix(out, "[ERROR] "), applied), nil
		}
		if strings.HasPrefix(out, "Archivo no encontrado") {
			return out, nil
		}
		detail := out
		if _, after, found := strings.Cut(out, "("); found {
			detail = after
		}
		done = append(done, strings.TrimRight(detail, ")"))
	}
	return fmt.Sprintf("Archivo editado: %s (%d ediciones: %s)", relPath, len(list), strings.Join(done, "; ")), nil
}

func InsertAtLine(ctx context.Context, root, relPath string, line int, content string) (string, error) {
	target, _, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	if !regularFile(target) {
		return "Archivo no encontrado: " + relPath, nil
	}
	original, err := readText(target)
	if err != nil {
		return "", err
	}
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
	updated := append(append(append([]string{}, lines[:idx]...), fresh...), lines[idx:]...)
	if err := writeAtomic(target, []byte(strings.Join(updated, nl))); err != nil {
		return "", err
	}
	return fmt.Sprintf("Archivo editado: %s (%d líneas insertadas en la línea %d)", relPath, len(fresh), idx+1), nil
}
