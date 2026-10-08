package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

type dirEntry struct {
	name   string
	path   string
	isDir  bool
	isFile bool
}

// sortedEntries ordena carpetas antes que archivos, sin distinguir mayúsculas.
// Sigue los enlaces simbólicos al clasificar, como pathlib.
func sortedEntries(dir string) []dirEntry {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	out := make([]dirEntry, 0, len(entries))
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		entry := dirEntry{name: e.Name(), path: full}
		if info, err := os.Stat(full); err == nil {
			entry.isDir = info.IsDir()
			entry.isFile = info.Mode().IsRegular()
		}
		out = append(out, entry)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].isFile != out[j].isFile {
			return !out[i].isFile
		}
		return lower(out[i].name) < lower(out[j].name)
	})
	return out
}

func ListFiles(ctx context.Context, root, relPath string, recursive bool) (string, error) {
	target, realRoot, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil {
		return "No existe: " + relPath, nil
	}
	if !info.IsDir() {
		return fmt.Sprintf("[F] %s (%s)", relPosix(realRoot, target), fmtSize(info.Size())), nil
	}

	var lines []string
	var walk func(dir string, depth int) error
	walk = func(dir string, depth int) error {
		for _, e := range sortedEntries(dir) {
			if err := ctx.Err(); err != nil {
				return err
			}
			if len(lines) > MaxResultLines {
				return nil
			}
			rel := relPosix(realRoot, e.path)
			if e.isDir {
				if ignoredTreeDirs[e.name] {
					lines = append(lines, fmt.Sprintf("[D] %s/ (omitida)", rel))
					continue
				}
				lines = append(lines, fmt.Sprintf("[D] %s/ (%d entradas)", rel, len(sortedEntries(e.path))))
				if recursive && depth < 6 {
					if err := walk(e.path, depth+1); err != nil {
						return err
					}
				}
				continue
			}
			if st, err := os.Stat(e.path); err == nil {
				lines = append(lines, fmt.Sprintf("[F] %s (%s)", rel, fmtSize(st.Size())))
			} else {
				lines = append(lines, fmt.Sprintf("[F] %s", rel))
			}
		}
		return nil
	}
	if err := walk(target, 1); err != nil {
		return "", err
	}
	if len(lines) == 0 {
		return "(vacío)", nil
	}
	return capLines(lines, len(lines)), nil
}
