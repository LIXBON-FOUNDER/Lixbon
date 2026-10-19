package tui

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/tools"
)

const (
	maxFileEntries = 5000
	maxFileItems   = 50
	maxLinesSize   = 1 << 20
)

// La carpeta puede cambiar por fuera del CLI (explorador, editor, git): el
// índice de «@» se rehace si tiene más de esto.
var fileIndexTTL = 2 * time.Second

// menuItem es una fila de los menús «/» y «@».
type menuItem struct {
	group  string
	label  string
	args   string
	desc   string
	insert string
	dir    bool
	pos    []int
	score  int
}

// fuzzy puntúa text contra query: primero lo que empieza igual, después lo
// que lo contiene y por último lo que tiene sus letras en orden. Devuelve las
// posiciones (en runas) que casan.
func fuzzy(text, query string) (score int, pos []int, ok bool) {
	t, q := []rune(strings.ToLower(text)), []rune(strings.ToLower(query))
	if len(q) == 0 {
		return 0, nil, true
	}
	if i := strings.Index(string(t), string(q)); i >= 0 {
		start := len([]rune(string(t)[:i]))
		for k := range q {
			pos = append(pos, start+k)
		}
		if start == 0 {
			return 3000 - len(t), pos, true
		}
		return 2000 - start, pos, true
	}
	j := 0
	for i := 0; i < len(t) && j < len(q); i++ {
		if t[i] == q[j] {
			pos = append(pos, i)
			j++
		}
	}
	if j < len(q) {
		return 0, nil, false
	}
	return 1000 - (pos[len(pos)-1] - pos[0]), pos, true
}

func slashQuery(value string) (string, bool) {
	if !strings.HasPrefix(value, "/") || strings.ContainsAny(value, " \n") {
		return "", false
	}
	return value[1:], true
}

// atQuery es la palabra que empieza por @ justo antes del cursor.
func (m *Model) atQuery() (query string, start int, ok bool) {
	lines := strings.Split(m.input.Value(), "\n")
	row := m.input.Line()
	if row >= len(lines) {
		return "", 0, false
	}
	before := []rune(lines[row])
	before = before[:min(m.input.Column(), len(before))]
	for i := len(before) - 1; i >= 0; i-- {
		switch before[i] {
		case ' ', '\t':
			return "", 0, false
		case '@':
			if i == 0 || before[i-1] == ' ' || before[i-1] == '\t' {
				return string(before[i+1:]), i, true
			}
			return "", 0, false
		}
	}
	return "", 0, false
}

func (m *Model) refreshMenu() {
	var query string
	var items []menuItem
	switch {
	case !m.hasQuery():
		m.menu, m.menuHidden, m.menuQuery = nil, false, ""
		return
	case m.menuHidden:
		return
	}
	if q, ok := slashQuery(m.input.Value()); ok {
		query, items, m.menuFiles = "/"+q, m.slashItems(q), false
	} else {
		q, _, _ := m.atQuery()
		query, items, m.menuFiles = "@"+q, m.fileItems(q), true
	}
	m.menu = items
	if query != m.menuQuery {
		m.menuQuery, m.menuCursor = query, 0
		best := -1
		for i, it := range items {
			if best < 0 || it.score > items[best].score {
				best = i
			}
		}
		m.menuCursor = max(0, best)
	}
	m.menuCursor = max(0, min(m.menuCursor, len(items)-1))
}

func (m *Model) hasQuery() bool {
	if _, ok := slashQuery(m.input.Value()); ok {
		return true
	}
	_, _, ok := m.atQuery()
	return ok
}

// slashItems son los comandos que casan, agrupados por tema y, dentro, del que
// mejor casa al que peor.
func (m *Model) slashItems(query string) []menuItem {
	groups := append(append([]string{}, Groups...), "custom")
	var out []menuItem
	for _, group := range groups {
		var in []menuItem
		for _, s := range m.allSpecs() {
			if s.Group != group {
				continue
			}
			score, pos, ok := fuzzy(s.Name, query)
			if !ok {
				continue
			}
			for i := range pos {
				pos[i]++
			}
			in = append(in, menuItem{group: group, label: "/" + s.Name, args: s.Args, desc: s.Desc,
				insert: "/" + s.Name, pos: pos, score: score})
		}
		if query != "" {
			sort.SliceStable(in, func(a, b int) bool { return in[a].score > in[b].score })
		}
		out = append(out, in...)
	}
	return out
}

// completeMenu escribe en la caja lo elegido: el comando (con un espacio si
// lleva argumentos) o la ruta tras la @.
func (m *Model) completeMenu() {
	if len(m.menu) == 0 {
		return
	}
	chosen := m.menu[m.menuCursor]
	if !m.menuFiles {
		m.input.SetValue(chosen.insert)
		if chosen.args != "" {
			m.input.InsertString(" ")
		}
		m.input.MoveToEnd()
		m.refreshMenu()
		return
	}
	_, start, ok := m.atQuery()
	if !ok {
		return
	}
	lines := strings.Split(m.input.Value(), "\n")
	row := m.input.Line()
	runes := []rune(lines[row])
	col := min(m.input.Column(), len(runes))
	token := "@" + chosen.insert
	if !chosen.dir {
		token += " "
	}
	lines[row] = string(runes[:start]) + token + string(runes[col:])
	m.input.SetValue(strings.Join(lines, "\n"))
	for i := len(lines) - 1; i > row; i-- {
		m.input.CursorUp()
	}
	m.input.SetCursorColumn(start + len([]rune(token)))
	m.menuQuery = ""
	m.refreshMenu()
}

// ── archivos ─────────────────────────────────────────────────────────────

type fileIndex struct {
	root     string
	paths    []string
	dirs     map[string]int
	modified map[string]bool
	lines    map[string]int
	loaded   time.Time
}

// loadFiles lista el workspace respetando .gitignore (git ls-files) y, sin
// git, recorriéndolo con la lista de carpetas que se saltan siempre.
func loadFiles(root string) *fileIndex {
	idx := &fileIndex{root: root, dirs: map[string]int{}, modified: map[string]bool{}, lines: map[string]int{}, loaded: time.Now()}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "ls-files", "--cached", "--others", "--exclude-standard")
	cmd.Dir = root
	if out, err := cmd.Output(); err == nil {
		// --cached sigue listando lo borrado del disco hasta el próximo commit.
		deleted := map[string]bool{}
		gone := exec.CommandContext(ctx, "git", "ls-files", "--deleted")
		gone.Dir = root
		if out, err := gone.Output(); err == nil {
			for _, l := range strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n") {
				deleted[strings.TrimSpace(l)] = true
			}
		}
		for _, l := range strings.Split(strings.ReplaceAll(string(out), "\r\n", "\n"), "\n") {
			if l = strings.TrimSpace(l); l != "" && !deleted[l] && len(idx.paths) < maxFileEntries {
				idx.paths = append(idx.paths, l)
			}
		}
		status := exec.CommandContext(ctx, "git", "status", "--porcelain")
		status.Dir = root
		if out, err := status.Output(); err == nil {
			for _, l := range strings.Split(string(bytes.ReplaceAll(out, []byte("\r\n"), []byte("\n"))), "\n") {
				if len(l) > 3 {
					idx.modified[strings.Trim(l[3:], `"`)] = true
				}
			}
		}
	} else {
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil || p == root {
				return nil
			}
			if d.IsDir() {
				if tools.IgnoredDir(d.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			if len(idx.paths) >= maxFileEntries {
				return filepath.SkipAll
			}
			if rel, err := filepath.Rel(root, p); err == nil {
				idx.paths = append(idx.paths, filepath.ToSlash(rel))
			}
			return nil
		})
	}
	for _, p := range idx.paths {
		for d := path.Dir(p); d != "." && d != "/"; d = path.Dir(d) {
			idx.dirs[d]++
		}
	}
	return idx
}

func (m *Model) fileItems(query string) []menuItem {
	if m.files == nil || m.files.root != m.chat.Workspace || time.Since(m.files.loaded) > fileIndexTTL {
		m.files = loadFiles(m.chat.Workspace)
	}
	var out []menuItem
	add := func(p string, dir bool) {
		score, pos, ok := fuzzy(p, query)
		if !ok {
			return
		}
		if base := path.Base(p); query != "" && strings.Contains(strings.ToLower(base), strings.ToLower(query)) {
			score += 500
		}
		if dir {
			score -= 50
		}
		insert := p
		if dir {
			insert += "/"
		}
		out = append(out, menuItem{label: insert, insert: insert, dir: dir, pos: pos, score: score})
	}
	for d := range m.files.dirs {
		add(d, true)
	}
	for _, p := range m.files.paths {
		add(p, false)
	}
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].score != out[b].score {
			return out[a].score > out[b].score
		}
		return out[a].label < out[b].label
	})
	return out[:min(len(out), maxFileItems)]
}

// fileMeta es lo que se ve a la derecha de una ruta: líneas, carpeta o si cambió.
func (m *Model) fileMeta(it menuItem) string {
	if m.files == nil {
		return ""
	}
	if it.dir {
		return "carpeta " + glyphSep + " " + noun(m.files.dirs[strings.TrimSuffix(it.insert, "/")], "archivo", "archivos")
	}
	n, ok := m.files.lines[it.insert]
	if !ok {
		n = -1
		if info, err := os.Stat(filepath.Join(m.files.root, filepath.FromSlash(it.insert))); err == nil && info.Size() < maxLinesSize {
			if data, err := os.ReadFile(filepath.Join(m.files.root, filepath.FromSlash(it.insert))); err == nil {
				n = bytes.Count(data, []byte("\n"))
				if len(data) > 0 && data[len(data)-1] != '\n' {
					n++
				}
			}
		}
		m.files.lines[it.insert] = n
	}
	meta := ""
	if n >= 0 {
		meta = noun(n, "línea", "líneas")
	}
	if m.files.modified[it.insert] {
		if meta != "" {
			meta += " " + glyphSep + " "
		}
		meta += "modificado"
	}
	return meta
}

// highlight pinta en acento las runas de text que casaron con la búsqueda.
func highlightMatch(text string, pos []int, base, hit lipgloss.Style) string {
	if len(pos) == 0 {
		return base.Render(text)
	}
	var b strings.Builder
	for i, r := range []rune(text) {
		if slices.Contains(pos, i) {
			b.WriteString(hit.Render(string(r)))
		} else {
			b.WriteString(base.Render(string(r)))
		}
	}
	return b.String()
}

// menuView pinta el menú encima de la caja: cabeceras de grupo (en «/»), la
// fila elegida con la barra y el fondo, y las teclas.
func (m *Model) menuView() []string {
	width := max(1, m.width)
	start := 0
	if len(m.menu) > menuVisible {
		start = max(0, min(m.menuCursor-menuVisible/2, len(m.menu)-menuVisible))
	}
	end := min(len(m.menu), start+menuVisible)
	var lines []string
	if m.menuFiles {
		lines = append(lines, sDim.Render(pad+"archivos"))
	}
	group := ""
	for i := start; i < end; i++ {
		it := m.menu[i]
		if !m.menuFiles && it.group != group {
			group = it.group
			lines = append(lines, sDim.Render(pad+group))
		}
		on := i == m.menuCursor
		labelStyle, descStyle := sBeige, sDim
		if on {
			labelStyle, descStyle = sBold, sSoft
		}
		label := highlightMatch(it.label, it.pos, labelStyle, sAccent)
		left := label
		if m.menuFiles {
			left = label
		} else {
			pad := strings.Repeat(" ", max(0, NameWidth-ansi.StringWidth(it.label)))
			left = label + pad
			if it.args != "" {
				left += sDim2.Render(" " + it.args)
			}
			left += "  " + descStyle.Render(it.desc)
		}
		right := ""
		if m.menuFiles {
			right = descStyle.Render(m.fileMeta(it))
		}
		bar := "   "
		if on {
			bar = " " + sAccent.Render(glyphEdge) + " "
		}
		row := fitRight(bar+left, right, width)
		row = ansi.Truncate(row, max(1, width-1), glyphEllipsis)
		if on {
			row = withBackground(row+strings.Repeat(" ", max(0, width-1-ansi.StringWidth(row))), pal.surf2)
		}
		lines = append(lines, row)
	}
	if len(m.menu) == 0 && m.menuFiles {
		lines = append(lines, sDim.Render(pad+"sin coincidencias"))
	}
	// El menú de comandos va en inglés, como los comandos; el de archivos no.
	keys := [][2]string{{"↑↓", "mover"}, {"tab", "completar"}, {"esc", "cerrar"}}
	if !m.menuFiles {
		keys = [][2]string{{"↑↓", "move"}, {"↵", "run"}, {"tab", "complete"}, {"esc", "close"}}
	}
	lines = append(lines, ansi.Truncate(pad+keyHints(keys...), width, ""))
	return lines
}

// ── atajos ───────────────────────────────────────────────────────────────

var shortcuts = [][2]string{
	{"↵", "enviar"}, {"shift+tab", "cambiar de modo"},
	{"alt+↵", "nueva línea"}, {"ctrl+o", "plegar o desplegar todo"},
	{"/", "comandos"}, {"ctrl+t", "transcript completo"},
	{"@", "adjuntar un archivo"}, {"alt+v", "pegar una imagen"},
	{"!", "ejecutar en la shell"}, {"esc", "interrumpir o cerrar"},
	{"↑ ↓", "historial"}, {"ctrl+c ×2", "salir"},
	{"pgup pgdn", "desplazar"}, {"arrastrar", "copiar"},
}

// shortcutsView es el panel de «?»: dos columnas si caben, una si no.
func (m *Model) shortcutsView() []string {
	width := max(4, m.width)
	inner := width - 4
	var rows []panelRow
	cell := func(k, label string) string {
		return sSoft.Render(fmt.Sprintf("%-10s", k)) + sPrimary.Render(label)
	}
	if inner >= 70 {
		for i := 0; i < len(shortcuts); i += 2 {
			left := cell(shortcuts[i][0], shortcuts[i][1])
			left += strings.Repeat(" ", max(2, 40-ansi.StringWidth(left)))
			rows = append(rows, panelRow{text: left + cell(shortcuts[i+1][0], shortcuts[i+1][1])})
		}
	} else {
		for _, s := range shortcuts {
			rows = append(rows, panelRow{text: cell(s[0], s[1])})
		}
	}
	return panel(rows, width, pal.faint, "Atajos")
}
