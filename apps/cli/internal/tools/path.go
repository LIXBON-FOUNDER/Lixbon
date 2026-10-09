package tools

import (
	"path/filepath"
	"strings"
)

// realPath resuelve enlaces simbólicos del tramo existente de la ruta, como
// Path.resolve() de Python (que no exige que el destino exista).
func realPath(path string) string {
	path = filepath.Clean(path)
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	parent := filepath.Dir(path)
	if parent == path {
		return path
	}
	return filepath.Join(realPath(parent), filepath.Base(path))
}

// resolveSafe devuelve la ruta real de userPath y la raíz real del workspace;
// falla si el destino queda fuera de la raíz, también a través de enlaces.
func resolveSafe(root, userPath string) (target, realRoot string, err error) {
	realRoot = realPath(root)
	candidate := userPath
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(realRoot, candidate)
	}
	target = realPath(candidate)
	rel, relErr := filepath.Rel(realRoot, target)
	if relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", ErrOutsideWorkspace
	}
	return target, realRoot, nil
}
