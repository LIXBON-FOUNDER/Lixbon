package tui

import (
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"
)

const (
	upValue     = "\x01up"
	maxDirsShow = 1000
)

func samePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// within dice si path está dentro de root (o es root).
func within(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	if runtime.GOOS == "windows" && !strings.EqualFold(filepath.VolumeName(path), filepath.VolumeName(root)) {
		return false
	}
	return rel == "." || !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

// subdirs son las carpetas visibles de dir, sin las ocultas ni las de sistema.
func subdirs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || strings.HasPrefix(name, "$") {
			continue
		}
		if !e.IsDir() {
			if e.Type()&os.ModeSymlink == 0 {
				continue
			}
			if info, err := os.Stat(filepath.Join(dir, name)); err != nil || !info.IsDir() {
				continue
			}
		}
		out = append(out, name)
		if len(out) == maxDirsShow {
			break
		}
	}
	slices.SortFunc(out, func(a, b string) int { return strings.Compare(strings.ToLower(a), strings.ToLower(b)) })
	return out
}

func isRepo(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".git"))
	return err == nil
}

// resolveDir entiende ~, rutas absolutas y relativas al workspace o, si ahí
// no existe, a la carpeta personal («desktop/proyecto» desde cualquier sitio).
func (m *Model) resolveDir(arg string) (string, bool) {
	path := expandHome(arg)
	candidates := []string{path}
	if !filepath.IsAbs(path) {
		candidates = []string{filepath.Join(m.chat.Workspace, path)}
		if home, err := os.UserHomeDir(); err == nil {
			candidates = append(candidates, filepath.Join(home, path))
		}
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			return c, true
		}
	}
	for _, c := range candidates {
		if found, ok := foldPath(c); ok {
			return found, true
		}
	}
	return "", false
}

// foldPath busca path sin distinguir mayúsculas tramo a tramo: en Linux
// «desktop/lixbon» también encuentra «Desktop/Lixbon».
func foldPath(path string) (string, bool) {
	path = filepath.Clean(path)
	vol := filepath.VolumeName(path)
	rest := strings.TrimPrefix(path[len(vol):], string(filepath.Separator))
	current := vol + string(filepath.Separator)
	if !filepath.IsAbs(path) {
		return "", false
	}
	for _, part := range strings.Split(rest, string(filepath.Separator)) {
		if part == "" {
			continue
		}
		next := filepath.Join(current, part)
		if _, err := os.Stat(next); err != nil {
			entries, err := os.ReadDir(current)
			if err != nil {
				return "", false
			}
			next = ""
			for _, e := range entries {
				if strings.EqualFold(e.Name(), part) {
					next = filepath.Join(current, e.Name())
					break
				}
			}
			if next == "" {
				return "", false
			}
		}
		current = next
	}
	info, err := os.Stat(current)
	return current, err == nil && info.IsDir()
}

func (m *Model) cmdWorkspace(arg string) tea.Cmd {
	if arg != "" {
		path, ok := m.resolveDir(arg)
		if !ok {
			m.add(errLine("«" + arg + "» no es una carpeta. /workspace sin nada abre el navegador de carpetas."))
			return nil
		}
		m.applyWorkspace(path)
		return nil
	}
	p := newPicker("", nil, func(value string, cancelled bool) tea.Cmd {
		if !cancelled && value != upValue {
			m.applyWorkspace(value)
		}
		return nil
	})
	p.search, p.maxShown = true, 14
	p.keys = [][2]string{{"↑↓", "mover"}, {"→", "abrir"}, {"←", "subir"}, {"↵", "usar"}, {"escribe", "filtra"}, {"esc", "salir"}}
	dir := m.chat.Workspace
	browse := func(to, from string) {
		dir = to
		m.browse(p, to, from)
	}
	up := func() {
		if parent := filepath.Dir(dir); parent != dir {
			browse(parent, dir)
		}
	}
	browse(dir, "")
	p.onKey = func(p *picker, msg tea.KeyPressMsg) (tea.Cmd, bool, bool) {
		current := ""
		if opts := p.visible(); p.cursor < len(opts) {
			current = opts[p.cursor].Value
		}
		switch msg.String() {
		case "left":
			up()
		case "backspace":
			if p.filter != "" {
				return nil, false, false
			}
			up()
		case "right":
			if current == "" || current == upValue {
				up()
			} else if !samePath(current, dir) {
				browse(current, "")
			}
		case "enter":
			if current != upValue {
				return nil, false, false
			}
			up()
		default:
			return nil, false, false
		}
		return nil, true, false
	}
	m.picker = p
	return nil
}

// browse llena el navegador con las carpetas de dir; from es la carpeta de la
// que se viene, para dejar el cursor encima.
func (m *Model) browse(p *picker, dir, from string) {
	p.title, p.filter = "Workspace "+glyphSep+" "+shortPath(dir), ""
	options := []option{{Label: "usar esta carpeta", Value: dir, Desc: shortPath(dir)}}
	if samePath(dir, m.chat.Workspace) {
		options[0].Badge = "actual"
	}
	if parent := filepath.Dir(dir); parent != dir {
		options = append(options, option{Label: "..", Value: upValue, Desc: shortPath(parent)})
	}
	cursor := 0
	for _, name := range subdirs(dir) {
		full := filepath.Join(dir, name)
		o := option{Label: name + string(filepath.Separator), Value: full}
		if isRepo(full) {
			o.Meta = sDim.Render("git")
		}
		if samePath(full, m.chat.Workspace) {
			o.Badge = "actual"
		}
		if from != "" && samePath(full, from) {
			cursor = len(options)
		}
		options = append(options, o)
	}
	p.options, p.cursor = options, cursor
	p.moveToEnabled(1)
}

// applyWorkspace cambia de carpeta. Las conversaciones son de una carpeta: si
// la actual tiene mensajes, se guarda y se empieza otra con contexto vacío.
func (m *Model) applyWorkspace(path string) {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	if samePath(path, m.chat.Workspace) {
		m.add(note("Ya trabajas en " + shortPath(path) + "."))
		return
	}
	fresh := len(m.chat.History) > 0
	if fresh {
		m.uncaptured(func() tea.Cmd {
			m.newConversation(shortPath(path))
			return nil
		})
	}
	m.chat.SetWorkspace(path)
	m.refreshGit()
	m.files = nil
	m.refreshContext()
	line := "Workspace: " + shortPath(path)
	if fresh {
		line += " " + glyphSep + " conversación nueva"
	}
	if m.chat.ProjectContext != "" {
		line += " " + glyphSep + " LIXBON.md"
	}
	m.add(okLine(line))
}
