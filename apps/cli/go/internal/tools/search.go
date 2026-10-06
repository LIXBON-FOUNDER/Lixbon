package tools

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"

	"lixbon.com/cli/internal/textutil"
)

// Search busca texto en el workspace con un recorrido propio (sin depender de
// ripgrep): poda las carpetas ignoradas, lee línea a línea y se detiene al
// superar el límite de resultados. El orden de salida es el léxico del
// recorrido.
func Search(ctx context.Context, root, pattern, relPath, glob string, ignoreCase, isRegex bool) (string, error) {
	if pattern == "" {
		return "[ERROR] Falta pattern", nil
	}
	target, realRoot, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil {
		return "No existe: " + relPath, nil
	}

	source := regexp.QuoteMeta(pattern)
	if isRegex {
		source = translatePy(pattern)
	}
	if ignoreCase {
		source = "(?i)" + source
	}
	matcher, err := regexp.Compile(source)
	if err != nil {
		return "[ERROR] regex inválida: " + err.Error(), nil
	}
	var globMatcher *regexp.Regexp
	if glob != "" {
		globMatcher = translateFnmatch(glob)
	}

	var files []string
	if info.IsDir() {
		files, err = collectFiles(ctx, realRoot, target)
		if err != nil {
			return "", err
		}
	} else {
		files = []string{target}
	}

	var hits []string
	for _, path := range files {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		rel := relPosix(realRoot, path)
		if globMatcher != nil && !globMatcher.MatchString(filepath.Base(path)) && !globMatcher.MatchString(rel) {
			continue
		}
		if isBinary(path) {
			continue
		}
		done, err := searchFile(ctx, path, rel, matcher, &hits)
		if err != nil {
			return "", err
		}
		if done {
			return capLines(hits, len(hits)), nil
		}
	}
	if len(hits) == 0 {
		return "(sin resultados)", nil
	}
	return capLines(hits, len(hits)), nil
}

func collectFiles(ctx context.Context, realRoot, dir string) ([]string, error) {
	var files []string
	errStop := errors.New("tope de archivos")
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if path != dir && ignoredTreeDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if hasIgnoredPart(relPosix(realRoot, path)) {
			return nil
		}
		if info, serr := os.Stat(path); serr != nil || !info.Mode().IsRegular() {
			return nil
		}
		files = append(files, path)
		if len(files) >= maxSearchFiles {
			return errStop
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStop) {
		return nil, err
	}
	return files, nil
}

// searchFile añade las coincidencias del archivo; done=true cuando se supera
// el límite de resultados.
func searchFile(ctx context.Context, path, rel string, matcher *regexp.Regexp, hits *[]string) (done bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		return false, nil
	}
	defer f.Close()
	reader := newLineReader(f, maxLineBytes, false)
	for lineNo := 1; ; lineNo++ {
		if lineNo%1024 == 0 {
			if err := ctx.Err(); err != nil {
				return false, err
			}
		}
		line, _, ok := reader.next()
		if !ok {
			return false, nil
		}
		if matcher.MatchString(line) {
			*hits = append(*hits, fmt.Sprintf("%s:%d:%s", rel, lineNo, textutil.Head(textutil.Strip(line), 240)))
			if len(*hits) > MaxResultLines {
				return true, nil
			}
		}
	}
}
