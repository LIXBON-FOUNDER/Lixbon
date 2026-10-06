package agent

import (
	"os"
	"sort"
	"unicode/utf8"

	"lixbon.com/cli/internal/textutil"
	"lixbon.com/cli/internal/tools"
)

const (
	DiffContext = 3
	// maxDiffLines acota el coste cuadrático del diff: por encima se muestra
	// el archivo entero como sustituido.
	maxDiffLines = 5000
)

// Change describe el efecto de una herramienta ANTES de ejecutarla, para
// aprobar con contexto. Kind: create | update | delete | rename | mkdir |
// command | append.
type Change struct {
	Kind    string
	Path    string
	OldText string
	NewText string
	Detail  string
}

type DiffRow struct {
	Kind  string // ctx | del | add | gap
	OldNo int
	NewNo int
	Text  string
}

// ── difflib.SequenceMatcher (sin heurística de basura ni autojunk) ──────────

type match struct{ i, j, k int }

type matcher struct {
	a, b []string
	b2j  map[string][]int
}

func newMatcher(a, b []string) *matcher {
	m := &matcher{a: a, b: b, b2j: map[string][]int{}}
	for j, line := range b {
		m.b2j[line] = append(m.b2j[line], j)
	}
	return m
}

func (m *matcher) longestMatch(alo, ahi, blo, bhi int) match {
	besti, bestj, bestsize := alo, blo, 0
	j2len := map[int]int{}
	for i := alo; i < ahi; i++ {
		next := map[int]int{}
		for _, j := range m.b2j[m.a[i]] {
			if j < blo {
				continue
			}
			if j >= bhi {
				break
			}
			k := j2len[j-1] + 1
			next[j] = k
			if k > bestsize {
				besti, bestj, bestsize = i-k+1, j-k+1, k
			}
		}
		j2len = next
	}
	for besti > alo && bestj > blo && m.a[besti-1] == m.b[bestj-1] {
		besti, bestj, bestsize = besti-1, bestj-1, bestsize+1
	}
	for besti+bestsize < ahi && bestj+bestsize < bhi && m.a[besti+bestsize] == m.b[bestj+bestsize] {
		bestsize++
	}
	return match{besti, bestj, bestsize}
}

func (m *matcher) matchingBlocks() []match {
	type span struct{ alo, ahi, blo, bhi int }
	queue := []span{{0, len(m.a), 0, len(m.b)}}
	var blocks []match
	for len(queue) > 0 {
		s := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		x := m.longestMatch(s.alo, s.ahi, s.blo, s.bhi)
		if x.k == 0 {
			continue
		}
		blocks = append(blocks, x)
		if s.alo < x.i && s.blo < x.j {
			queue = append(queue, span{s.alo, x.i, s.blo, x.j})
		}
		if x.i+x.k < s.ahi && x.j+x.k < s.bhi {
			queue = append(queue, span{x.i + x.k, s.ahi, x.j + x.k, s.bhi})
		}
	}
	sort.Slice(blocks, func(p, q int) bool {
		if blocks[p].i != blocks[q].i {
			return blocks[p].i < blocks[q].i
		}
		if blocks[p].j != blocks[q].j {
			return blocks[p].j < blocks[q].j
		}
		return blocks[p].k < blocks[q].k
	})
	var merged []match
	var cur match
	for _, b := range blocks {
		if cur.i+cur.k == b.i && cur.j+cur.k == b.j {
			cur.k += b.k
			continue
		}
		if cur.k > 0 {
			merged = append(merged, cur)
		}
		cur = b
	}
	if cur.k > 0 {
		merged = append(merged, cur)
	}
	return append(merged, match{len(m.a), len(m.b), 0})
}

type opcode struct {
	tag            string // equal | replace | delete | insert
	i1, i2, j1, j2 int
}

func (m *matcher) opcodes() []opcode {
	var ops []opcode
	i, j := 0, 0
	for _, b := range m.matchingBlocks() {
		tag := ""
		switch {
		case i < b.i && j < b.j:
			tag = "replace"
		case i < b.i:
			tag = "delete"
		case j < b.j:
			tag = "insert"
		}
		if tag != "" {
			ops = append(ops, opcode{tag, i, b.i, j, b.j})
		}
		i, j = b.i+b.k, b.j+b.k
		if b.k > 0 {
			ops = append(ops, opcode{"equal", i - b.k, i, j - b.k, j})
		}
	}
	return ops
}

func diffOps(old, new []string) []opcode {
	if len(old) > maxDiffLines || len(new) > maxDiffLines {
		switch {
		case len(old) == 0:
			return []opcode{{"insert", 0, 0, 0, len(new)}}
		case len(new) == 0:
			return []opcode{{"delete", 0, len(old), 0, 0}}
		}
		return []opcode{{"replace", 0, len(old), 0, len(new)}}
	}
	return newMatcher(old, new).opcodes()
}

// DiffRows devuelve las filas del diff listas para pintar: contexto, borrado,
// añadido y huecos ("gap") donde se omiten tramos iguales.
func DiffRows(c Change, context int) []DiffRow {
	old, new := textutil.SplitLines(c.OldText), textutil.SplitLines(c.NewText)
	ops := diffOps(old, new)
	var rows []DiffRow
	for index, op := range ops {
		if op.tag == "equal" {
			total := op.i2 - op.i1
			last := index == len(ops)-1
			head, tail := context, context
			if index == 0 {
				head = 0
			}
			if last {
				tail = 0
			}
			if total > head+tail+1 {
				for k := 0; k < head; k++ {
					rows = append(rows, DiffRow{"ctx", op.i1 + k + 1, op.j1 + k + 1, old[op.i1+k]})
				}
				if len(rows) > 0 && !last {
					rows = append(rows, DiffRow{Kind: "gap"})
				}
				for k := total - tail; k < total; k++ {
					rows = append(rows, DiffRow{"ctx", op.i1 + k + 1, op.j1 + k + 1, old[op.i1+k]})
				}
			} else {
				for k := 0; k < total; k++ {
					rows = append(rows, DiffRow{"ctx", op.i1 + k + 1, op.j1 + k + 1, old[op.i1+k]})
				}
			}
			continue
		}
		for k := op.i1; k < op.i2; k++ {
			rows = append(rows, DiffRow{"del", k + 1, 0, old[k]})
		}
		for k := op.j1; k < op.j2; k++ {
			rows = append(rows, DiffRow{"add", 0, k + 1, new[k]})
		}
	}
	return rows
}

// DiffCounts devuelve las líneas añadidas y eliminadas.
func DiffCounts(c Change) (adds, dels int) {
	old, new := textutil.SplitLines(c.OldText), textutil.SplitLines(c.NewText)
	for _, op := range diffOps(old, new) {
		if op.tag != "equal" {
			dels += op.i2 - op.i1
			adds += op.j2 - op.j1
		}
	}
	return adds, dels
}

// ── cálculo del cambio previo a la herramienta ──────────────────────────────

// ComputeChange describe lo que va a hacer una herramienta; nil para las de
// solo lectura. El texto nuevo sale de las mismas funciones que usa la
// herramienta, así que el diff que se aprueba es lo que se escribe.
func ComputeChange(root, tool string, args map[string]any) *Change {
	rel := stringArg(args, "path")
	switch tool {
	case "write_file", "append_file":
		content := stringArg(args, "content")
		old, exists := readOld(root, rel, true)
		switch {
		case tool == "append_file":
			return &Change{Kind: "append", Path: rel, OldText: old, NewText: old + content}
		case !exists:
			return &Change{Kind: "create", Path: rel, NewText: content}
		}
		return &Change{Kind: "update", Path: rel, OldText: old, NewText: content}

	case "edit_file", "multi_edit", "insert_at_line":
		raw, valid := readRaw(root, rel)
		display := textutil.UniversalNewlines(raw)
		updated := raw
		if valid {
			switch tool {
			case "edit_file":
				if res := tools.ApplyEdit(raw, rel, stringArg(args, "old_text"), stringArg(args, "new_text"), truthy(args["all"])); res.OK() {
					updated = res.Updated
				}
			case "multi_edit":
				updated = tools.ApplyMultiEdit(raw, rel, args["edits"]).Updated
			default:
				if raw != "" || fileExists(root, rel) {
					updated, _, _ = tools.ApplyInsert(raw, intArg(args, "line"), stringArg(args, "content"))
				}
			}
		}
		return &Change{Kind: "update", Path: rel, OldText: display, NewText: textutil.UniversalNewlines(updated)}

	case "delete_file":
		old, _ := readOld(root, rel, false)
		return &Change{Kind: "delete", Path: rel, OldText: old}
	case "rename_file":
		return &Change{Kind: "rename", Path: stringArg(args, "src"), Detail: stringArg(args, "dst")}
	case "mkdir":
		return &Change{Kind: "mkdir", Path: rel}
	case "run_command":
		return &Change{Kind: "command", Detail: stringArg(args, "command")}
	}
	return nil
}

func readOld(root, rel string, requireExists bool) (text string, exists bool) {
	target, _, err := tools.ResolveSafe(root, rel)
	if err != nil {
		return "", false
	}
	info, statErr := os.Stat(target)
	if statErr != nil {
		return "", false
	}
	data, ok := tools.ReadTextLossy(target)
	if !ok {
		return "", !info.IsDir() && requireExists
	}
	return textutil.UniversalNewlines(data), true
}

// readRaw devuelve el contenido sin traducir saltos de línea y si es UTF-8
// válido (la herramienta se niega a editar lo que no lo es).
func readRaw(root, rel string) (text string, valid bool) {
	target, _, err := tools.ResolveSafe(root, rel)
	if err != nil {
		return "", false
	}
	info, statErr := os.Stat(target)
	if statErr != nil || !info.Mode().IsRegular() {
		return "", false
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return "", false
	}
	return textutil.DecodeLossy(data), utf8.Valid(data)
}

func fileExists(root, rel string) bool {
	target, _, err := tools.ResolveSafe(root, rel)
	if err != nil {
		return false
	}
	info, err := os.Stat(target)
	return err == nil && info.Mode().IsRegular()
}
