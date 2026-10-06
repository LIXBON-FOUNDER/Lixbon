// Package tools implementa las herramientas locales del agente. Sin UI: cada
// herramienta devuelve el texto que se entrega al modelo. Contrato fijado por
// validation/fixtures/workspace_corpus.json.
package tools

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"lixbon.com/cli/internal/toolspec"
)

const (
	MaxResultLines = 300
	maxReadChars   = 120000
	maxLineBytes   = 1 << 20
	maxSearchFiles = 5000
)

var ErrOutsideWorkspace = errors.New("Ruta fuera del workspace permitido")

var ignoredTreeDirs = map[string]bool{
	".git": true, "node_modules": true, "__pycache__": true, ".venv": true, "venv": true,
	"dist": true, "build": true, "target": true, ".next": true, ".idea": true,
	".vscode": true, ".mypy_cache": true, ".pytest_cache": true,
}

// Execute ejecuta una herramienta y devuelve su resultado. Los fallos llegan
// como texto "[ERROR] …", igual que en el CLI Python.
func Execute(ctx context.Context, root, name string, args map[string]any) string {
	result, err := dispatch(ctx, root, name, args)
	if err != nil {
		return "[ERROR] " + err.Error()
	}
	return result
}

func Failed(result string) bool {
	return strings.HasPrefix(result, "[ERROR]") || strings.HasPrefix(result, "[TIMEOUT]") ||
		(strings.HasPrefix(result, "[EXIT ") && !strings.HasPrefix(result, "[EXIT 0]"))
}

func dispatch(ctx context.Context, root, name string, args map[string]any) (string, error) {
	switch name {
	case "list_files":
		path, err := textArg(args, "path", ".")
		if err != nil {
			return "", err
		}
		return ListFiles(ctx, root, path, truthy(args["recursive"]))
	case "find_files":
		pattern, err := textArg(args, "pattern", "")
		if err != nil {
			return "", err
		}
		return FindFiles(ctx, root, pattern)
	case "outline":
		path, err := textArg(args, "path", "")
		if err != nil {
			return "", err
		}
		return Outline(ctx, root, path)
	case "read_file":
		path, err := textArg(args, "path", "")
		if err != nil {
			return "", err
		}
		start, err := intArg(args, "start_line")
		if err != nil {
			return "", err
		}
		end, err := intArg(args, "end_line")
		if err != nil {
			return "", err
		}
		return ReadFile(ctx, root, path, start, end)
	case "search":
		pattern, err := textArg(args, "pattern", "")
		if err != nil {
			return "", err
		}
		path := "."
		if truthy(args["path"]) {
			if path, err = textArg(args, "path", "."); err != nil {
				return "", err
			}
		}
		glob := ""
		if truthy(args["glob"]) {
			if glob, err = textArg(args, "glob", ""); err != nil {
				return "", err
			}
		}
		return Search(ctx, root, pattern, path, glob, truthy(args["ignore_case"]), truthy(args["regex"]))
	}
	if slicesContains(toolspec.Names(), name) {
		return "", fmt.Errorf("Herramienta aún no disponible en el CLI Go: %s", name)
	}
	return "", fmt.Errorf("Herramienta no soportada: %s", name)
}

func slicesContains(list []string, item string) bool {
	for _, v := range list {
		if v == item {
			return true
		}
	}
	return false
}

// truthy replica la veracidad de Python sobre valores JSON.
func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case float64:
		return x != 0
	case string:
		return x != ""
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}

func textArg(args map[string]any, key, def string) (string, error) {
	v, present := args[key]
	if !present {
		return def, nil
	}
	switch x := v.(type) {
	case string:
		return x, nil
	case nil:
		return "", fmt.Errorf("%s debe ser texto", key)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64), nil
	case bool:
		return strconv.FormatBool(x), nil
	}
	return "", fmt.Errorf("%s debe ser texto", key)
}

// intArg replica int(args.get(key) or 0).
func intArg(args map[string]any, key string) (int, error) {
	v := args[key]
	if !truthy(v) {
		return 0, nil
	}
	switch x := v.(type) {
	case float64:
		return int(x), nil
	case int:
		return x, nil
	case bool:
		return 1, nil
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		if err != nil {
			return 0, fmt.Errorf("invalid literal for int() with base 10: '%s'", x)
		}
		return n, nil
	}
	return 0, fmt.Errorf("%s debe ser un número", key)
}

func fmtSize(size int64) string {
	switch {
	case size >= 1_000_000:
		return fmt.Sprintf("%.1f MB", float64(size)/1_000_000)
	case size >= 1000:
		return fmt.Sprintf("%.1f kB", float64(size)/1000)
	}
	return fmt.Sprintf("%d B", size)
}

func capLines(lines []string, total int) string {
	if total > MaxResultLines {
		return strings.Join(lines[:MaxResultLines], "\n") + fmt.Sprintf("\n…[%d líneas más]", total-MaxResultLines)
	}
	return strings.Join(lines, "\n")
}

// pySuffix replica Path.suffix: ".gitignore" y "a." no tienen extensión.
func pySuffix(name string) string {
	if i := strings.LastIndex(name, "."); i > 0 && i < len(name)-1 {
		return name[i:]
	}
	return ""
}

func isBinary(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	head := make([]byte, 8192)
	n, _ := f.Read(head)
	for _, b := range head[:n] {
		if b == 0 {
			return true
		}
	}
	return false
}

func hasIgnoredPart(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if ignoredTreeDirs[part] {
			return true
		}
	}
	return false
}

func relPosix(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return filepath.ToSlash(rel)
}

func lower(s string) string { return strings.ToLower(s) }
