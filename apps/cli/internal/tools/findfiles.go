package tools

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"lixbon.com/cli/internal/textutil"
)

var errEnough = errors.New("suficientes resultados")

var driveLetter = regexp.MustCompile(`^[A-Za-z]:`)

// FindFiles busca por nombre con patrones glob estilo pathlib (`*`, `?`,
// `[…]` y `**`). Poda las carpetas ignoradas en vez de recorrerlas.
func FindFiles(ctx context.Context, root, pattern string) (string, error) {
	pattern = strings.ReplaceAll(textutil.Strip(pattern), `\`, "/")
	if pattern == "" {
		return "[ERROR] Falta pattern", nil
	}
	if !strings.Contains(pattern, "/") {
		pattern = "**/" + pattern
	}
	if strings.HasPrefix(pattern, "/") || driveLetter.MatchString(pattern) {
		return "", errors.New("el patrón debe ser relativo al workspace")
	}
	var segments []string
	for _, seg := range strings.Split(pattern, "/") {
		switch seg {
		case "", ".":
		case "..":
			return "", ErrOutsideWorkspace
		default:
			segments = append(segments, seg)
		}
	}
	if len(segments) == 0 {
		return "(sin resultados)", nil
	}
	if segments[len(segments)-1] == "**" {
		segments = append(segments, "*")
	}

	matchers := make([]*regexp.Regexp, len(segments))
	for i, seg := range segments {
		if seg != "**" {
			matchers[i] = translateFnmatch(seg)
		}
	}

	realRoot := realPath(root)
	seen := map[string]bool{}
	var hits []string
	var walk func(dir string, i int) error
	walk = func(dir string, i int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if segments[i] == "**" {
			if err := walk(dir, i+1); err != nil {
				return err
			}
			entries, _ := os.ReadDir(dir)
			for _, e := range entries {
				if e.IsDir() && !ignoredTreeDirs[e.Name()] {
					if err := walk(filepath.Join(dir, e.Name()), i); err != nil {
						return err
					}
				}
			}
			return nil
		}
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			name := e.Name()
			if ignoredTreeDirs[name] || !matchers[i].MatchString(name) {
				continue
			}
			full := filepath.Join(dir, name)
			if i == len(segments)-1 {
				rel := relPosix(realRoot, full)
				if info, err := os.Stat(full); err == nil && info.IsDir() {
					rel += "/"
				}
				if !seen[rel] {
					seen[rel] = true
					hits = append(hits, rel)
					if len(hits) > MaxResultLines {
						return errEnough
					}
				}
				continue
			}
			if info, err := os.Stat(full); err == nil && info.IsDir() {
				if err := walk(full, i+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(realRoot, 0); err != nil && !errors.Is(err, errEnough) {
		return "", err
	}
	if len(hits) == 0 {
		return "(sin resultados)", nil
	}
	sort.Strings(hits)
	return capLines(hits, len(hits)), nil
}
