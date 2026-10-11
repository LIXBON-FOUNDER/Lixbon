package tui

import (
	"os"
	"path/filepath"
	"strings"
)

// gitBranch lee la rama de .git/HEAD subiendo desde dir, sin lanzar git.
// Entiende los worktrees (.git como archivo «gitdir: …») y el HEAD separado,
// que devuelve como sha corto.
func gitBranch(dir string) string {
	for d := dir; d != ""; {
		dotgit := filepath.Join(d, ".git")
		if info, err := os.Stat(dotgit); err == nil {
			gitDir := dotgit
			if !info.IsDir() {
				raw, err := os.ReadFile(dotgit)
				if err != nil {
					return ""
				}
				target := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(raw)), "gitdir:"))
				if !filepath.IsAbs(target) {
					target = filepath.Join(d, target)
				}
				gitDir = target
			}
			head, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
			if err != nil {
				return ""
			}
			text := strings.TrimSpace(string(head))
			if ref, ok := strings.CutPrefix(text, "ref:"); ok {
				return strings.TrimPrefix(strings.TrimSpace(ref), "refs/heads/")
			}
			return text[:min(7, len(text))]
		}
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
	}
	return ""
}

func (m *Model) refreshGit() {
	m.branch = gitBranch(m.chat.Workspace)
	m.repoRoot = gitRoot(m.chat.Workspace)
	m.syncHeader()
}

// gitRoot es la carpeta del repositorio que contiene dir ("" si no hay).
func gitRoot(dir string) string {
	for d := dir; d != ""; {
		if _, err := os.Stat(filepath.Join(d, ".git")); err == nil {
			return d
		}
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
	}
	return ""
}
