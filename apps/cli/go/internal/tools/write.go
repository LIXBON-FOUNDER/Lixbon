package tools

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unicode/utf8"
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
		return ApplyEdit("", relPath, oldText, newText, replaceAll).Failure, nil
	}
	content, err := readText(target)
	if err != nil {
		return "", err
	}
	res := ApplyEdit(content, relPath, oldText, newText, replaceAll)
	if !res.OK() {
		return res.Failure, nil
	}
	if err := writeAtomic(target, []byte(res.Updated)); err != nil {
		return "", err
	}
	return res.Message, nil
}

// MultiEdit aplica las ediciones en orden; si una falla, las anteriores ya
// quedaron escritas y el mensaje lo dice.
func MultiEdit(ctx context.Context, root, relPath string, edits any) (string, error) {
	target, _, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	if list, _ := edits.([]any); len(list) == 0 {
		return ApplyMultiEdit("", relPath, edits).Failure, nil
	}
	if !regularFile(target) {
		return "Archivo no encontrado: " + relPath, nil
	}
	content, err := readText(target)
	if err != nil {
		return "", err
	}
	res := ApplyMultiEdit(content, relPath, edits)
	if res.Applied > 0 {
		if err := writeAtomic(target, []byte(res.Updated)); err != nil {
			return "", err
		}
	}
	if !res.OK() {
		return res.Failure, nil
	}
	return res.Message, nil
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
	updated, inserted, position := ApplyInsert(original, line, content)
	if err := writeAtomic(target, []byte(updated)); err != nil {
		return "", err
	}
	return fmt.Sprintf("Archivo editado: %s (%d líneas insertadas en la línea %d)", relPath, inserted, position), nil
}
