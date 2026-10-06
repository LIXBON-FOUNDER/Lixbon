package tools

import "strings"

const (
	MaxTreeEntries = 150
	maxTreeDepth   = 4
)

// WorkspaceTree es el listado compacto que va en el system prompt: da al
// modelo visión inmediata del proyecto sin que llame a list_files. Se trunca
// para no comerse la ventana de contexto.
func WorkspaceTree(root string, maxEntries int) string {
	realRoot := realPath(root)
	var entries []string
	truncated := false

	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if truncated || depth > maxTreeDepth {
			return
		}
		for _, e := range sortedEntries(dir) {
			if len(entries) >= maxEntries {
				truncated = true
				return
			}
			rel := relPosix(realRoot, e.path)
			if e.isDir {
				if ignoredTreeDirs[e.name] {
					continue
				}
				entries = append(entries, rel+"/")
				walk(e.path, depth+1)
				continue
			}
			entries = append(entries, rel)
		}
	}
	walk(realRoot, 1)

	if len(entries) == 0 {
		return "(workspace vacío)"
	}
	tree := strings.Join(entries, "\n")
	if truncated {
		tree += "\n… (hay más archivos; usa list_files para explorar)"
	}
	return tree
}
