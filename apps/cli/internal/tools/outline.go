package tools

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"

	"lixbon.com/cli/internal/textutil"
)

var outlinePatterns = func() map[string][]*regexp.Regexp {
	js := []*regexp.Regexp{
		matchStart(`^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+\w+|class\s+\w+).*`),
		matchStart(`^(\s*)(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>.*`),
		matchStart(`^(\s{2,})(?:static\s+|async\s+)*\w+\s*\([^)]*\)\s*\{\s*$`),
	}
	java := []*regexp.Regexp{
		matchStart(`^(\s*)(?:public|private|protected|static|final|abstract|\s)*\s*(?:class|interface|enum|record)\s+\w+.*`),
		matchStart(`^(\s{2,})(?:public|private|protected|static|final|synchronized|\s)+[\w<>\[\],\s]+\s+\w+\s*\([^)]*\)\s*(?:throws[^{]*)?\{?\s*$`),
	}
	patterns := map[string][]*regexp.Regexp{
		".py":   {matchStart(`^(\s*)(?:async\s+)?(?:def|class)\s+\w+.*?(?::|$)`)},
		".go":   {matchStart(`^(\s*)(?:func|type)\s+.*`)},
		".rs":   {matchStart(`^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\s+.*`)},
		".md":   {matchStart(`^(#{1,6})\s+.*`)},
		".css":  {matchStart(`^(\s*)[^\s{}/][^{}]*\{\s*$`)},
		".js":   js,
		".java": java,
	}
	for _, ext := range []string{".jsx", ".ts", ".tsx", ".mjs", ".cjs"} {
		patterns[ext] = js
	}
	for _, ext := range []string{".kt", ".cs", ".scala"} {
		patterns[ext] = java
	}
	return patterns
}()

// Outline lista funciones, clases y encabezados con su número de línea.
// Recorre el archivo línea a línea; solo guarda las primeras 300 coincidencias.
func Outline(ctx context.Context, root, relPath string) (string, error) {
	target, _, err := resolveSafe(root, relPath)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		return "Archivo no encontrado: " + relPath, nil
	}
	suffix := pySuffix(info.Name())
	patterns := outlinePatterns[strings.ToLower(suffix)]
	if patterns == nil {
		kind := suffix
		if kind == "" {
			kind = "este tipo"
		}
		return fmt.Sprintf("(sin esqueleto para %s; usa read_file)", kind), nil
	}
	f, err := os.Open(target)
	if err != nil {
		return "", err
	}
	defer f.Close()

	reader := newLineReader(f, maxLineBytes, false)
	var shown []string
	matched, total := 0, 0
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		line, _, ok := reader.next()
		if !ok {
			break
		}
		total++
		for _, p := range patterns {
			if p.MatchString(line) {
				matched++
				if len(shown) <= MaxResultLines {
					shown = append(shown, fmt.Sprintf("%5d  %s", total, textutil.Head(textutil.RStrip(line), 140)))
				}
				break
			}
		}
	}
	if reader.err != nil {
		return "", reader.err
	}
	if matched == 0 {
		return fmt.Sprintf("(sin funciones ni clases reconocibles en %d líneas)", total), nil
	}
	return fmt.Sprintf("%s: %d líneas\n", relPath, total) + capLines(shown, matched), nil
}
