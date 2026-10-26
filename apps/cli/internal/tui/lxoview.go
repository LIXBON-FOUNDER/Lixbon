package tui

// lxoview.go — `! lxo …` dentro del chat (LXO-106).
//
// El chat sabe dónde está lxo (orch.json de Lixbon Desktop), así que `! lxo …` funciona aunque lxo no esté
// en el PATH. Los comandos de lectura del Core (attention, tasks, task show, projects y summary) no se
// enseñan como salida cruda de terminal: el chat pide su `--json` y lo pinta con los estilos del CLI. El
// resto de comandos de lxo, o con --json / --help / --follow, se ejecutan tal cual con la ruta resuelta.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/history"
)

var lxoStyledCommands = map[string]bool{"attention": true, "tasks": true, "task": true, "projects": true, "summary": true}

// isLxoCommand: la línea tras «!» empieza por `lxo`.
func isLxoCommand(command string) bool {
	fields := strings.Fields(command)
	return len(fields) > 0 && strings.EqualFold(fields[0], "lxo")
}

// lxoStyled dice si la orden se pinta con los estilos del chat (y no como salida de terminal).
func lxoStyled(args []string) bool {
	if len(args) == 0 || !lxoStyledCommands[args[0]] {
		return false
	}
	for _, a := range args[1:] {
		switch {
		// --schema elige otra forma del --json (LXO-125): sale tal cual, como con --json.
		case a == "--json", a == "--help", a == "-h", a == "help", strings.HasPrefix(a, "--follow"), strings.HasPrefix(a, "--schema"):
			return false
		}
	}
	return true
}

func quoteArg(s string) string {
	if strings.ContainsAny(s, " \t\"") {
		return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
	}
	return s
}

// lxoPassthrough: la orden tal cual, con `lxo` cambiado por su ruta (no hace falta tenerlo en el PATH).
func lxoPassthrough(command, lxo string) string {
	command = strings.TrimSpace(command)
	fields := strings.Fields(command)
	rest := strings.TrimSpace(strings.TrimPrefix(command, fields[0]))
	return strings.TrimSpace(quoteArg(lxo) + " " + rest)
}

func (m *Model) lxoShell(command string) tea.Cmd {
	fields := strings.Fields(command)
	info := m.chat.Session.OrchInfo()
	if info.Lxo == "" {
		m.add(errLine("No se encontró lxo: viaja junto a Lixbon Desktop. Abre Lixbon o apunta LXO_BIN a su ruta."))
		return nil
	}
	args := fields[1:]
	if !lxoStyled(args) {
		return m.execShell(lxoPassthrough(command, info.Lxo))
	}
	m.gap()
	m.add(echoBlock("! " + strings.Join(fields, " ")))
	dir := m.chat.Workspace
	shown := "lxo " + strings.Join(args, " ")
	return m.async("consultando lxo", func(ctx context.Context) cmdDoneMsg {
		out, err := lxoRun(ctx, info.Lxo, dir, append(append([]string{}, args...), "--json")...)
		if err != nil {
			return cmdDoneMsg{lines: append(lxoFailure(out, err), textBlock(""))}
		}
		var names map[string]string
		if args[0] != "projects" && args[0] != "summary" {
			if pout, perr := lxoRun(ctx, info.Lxo, dir, "projects", "--all", "--json"); perr == nil {
				names = lxoProjectNames(pout)
			}
		}
		lines := renderLxo(args, out, names, time.Now())
		return cmdDoneMsg{
			lines: append(lines, textBlock("")),
			apply: func(m *Model) {
				// El modelo ve el mismo resultado que con cualquier `!`: el JSON de lxo, recortado.
				text := out
				if r := []rune(text); len(r) > 6000 {
					text = string(r[:6000])
				}
				m.chat.History = append(m.chat.History, history.User(fmt.Sprintf("TOOL_RESULT run_command `%s --json` (EXIT 0):\n%s", shown, text)))
			},
		}
	})
}

// ── Datos ────────────────────────────────────────────────────────────────

type jsonMap = map[string]any

func jstr(m jsonMap, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func jnum(m jsonMap, key string) int64 {
	if v, ok := m[key].(float64); ok {
		return int64(v)
	}
	return 0
}

func jobj(m jsonMap, key string) jsonMap {
	if v, ok := m[key].(map[string]any); ok {
		return v
	}
	return jsonMap{}
}

func jlist(m jsonMap, key string) []jsonMap {
	raw, _ := m[key].([]any)
	out := make([]jsonMap, 0, len(raw))
	for _, v := range raw {
		if o, ok := v.(map[string]any); ok {
			out = append(out, o)
		}
	}
	return out
}

func lxoProjectNames(out string) map[string]string {
	var doc jsonMap
	if json.Unmarshal([]byte(out), &doc) != nil {
		return nil
	}
	names := map[string]string{}
	for _, p := range jlist(doc, "projects") {
		names[jstr(p, "id")] = jstr(p, "name")
	}
	return names
}

func lxoProject(id string, names map[string]string) string {
	if id == "" {
		return "sin proyecto"
	}
	if n := names[id]; n != "" {
		return n
	}
	if r := []rune(id); len(r) > 8 {
		return "proyecto " + string(r[:8]) + glyphEllipsis
	}
	return "proyecto " + id
}

// lxoFailure traduce el error de lxo (`{"ok":false,"code","error"}` por stderr con --json).
func lxoFailure(out string, err error) []block {
	var e struct {
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "{") && json.Unmarshal([]byte(line), &e) == nil && e.Code != "" {
			break
		}
	}
	switch e.Code {
	case "core_unavailable":
		return []block{warnLine("Lixbon Desktop no está abierto o el orquestador está desactivado (Ajustes → Orquestador).")}
	case "":
		return []block{errLine("lxo falló: " + firstNonEmpty(strings.TrimSpace(out), err.Error()))}
	}
	return []block{errLine(firstNonEmpty(e.Error, e.Code))}
}

// ── Pintado ──────────────────────────────────────────────────────────────

var (
	categoryLabel = map[string]string{
		"question": "Pregunta", "approval": "Aprobación", "review_ready": "Lista para revisar", "conflict": "Conflicto",
		"failed": "Fallo", "environment_blocked": "Entorno bloqueado", "risk": "Riesgo",
	}
	severityLabel = map[string]string{"critical": "crítica", "high": "alta", "medium": "media", "low": "baja"}
	statusLabel   = map[string]string{
		"starting": "arrancando", "running": "en curso", "waiting": "esperando", "awaiting_terminal_approval": "espera aprobación",
		"done": "terminada", "failed": "fallida", "stopped": "detenida", "exited": "cerrada",
	}
	projectStatusLabel = map[string]string{"failed": "con fallos", "attention": "pide atención", "active": "en curso", "idle": "en reposo"}
	categoryOrder      = []string{"question", "approval", "review_ready", "conflict", "failed", "environment_blocked", "risk"}
)

func lxoLabel(m map[string]string, code string) string {
	if v := m[code]; v != "" {
		return v
	}
	return code
}

func lxoSeverityStyle(code string) lipgloss.Style {
	switch code {
	case "critical":
		return sErr
	case "high":
		return sWarn
	case "medium":
		return sPlan
	}
	return sDim
}

func lxoStatusMark(code string) string {
	switch code {
	case "done":
		return sOK.Render(glyphDone)
	case "failed":
		return sErr.Render(glyphs.cross)
	case "stopped", "exited":
		return sDim.Render(glyphMinus)
	case "waiting", "awaiting_terminal_approval":
		return sWarn.Render(glyphDot)
	}
	return sOK.Render(glyphDot)
}

func lxoProjectStyle(code string) lipgloss.Style {
	switch code {
	case "failed":
		return sErr
	case "attention":
		return sWarn
	case "active":
		return sOK
	}
	return sDim
}

func lxoStatusStyle(code string) lipgloss.Style {
	switch code {
	case "failed":
		return sErr
	case "waiting", "awaiting_terminal_approval":
		return sWarn
	case "done", "running", "starting":
		return sOK
	}
	return sDim
}

func lxoAgo(ms int64, now time.Time) string {
	if ms <= 0 {
		return ""
	}
	d := now.Sub(time.UnixMilli(ms))
	switch {
	case d < time.Minute:
		return "ahora"
	case d < time.Hour:
		return fmt.Sprintf("hace %d min", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("hace %d h", int(d.Hours()))
	}
	return fmt.Sprintf("hace %d d", int(d.Hours()/24))
}

// title: el encabezado de cada vista, con la marca del chat y un detalle a la derecha.
func lxoTitle(text, right string) block {
	return funcBlock(func(width int) string {
		return fitRight(mark(glyphBrand, sAccent)+sBold.Render(text), sDim.Render(right), width)
	})
}

// item: una fila de dos líneas (cabecera con estado a la derecha y detalle apagado debajo), sangrada.
func lxoItem(indent int, glyph, head, right, detail string) block {
	lead := strings.Repeat("  ", indent)
	return lxoRow(lead, lead+"  ", glyph, head, right, detail)
}

// lxoRow: la fila de un elemento de lista. headLead y detailLead van delante de la cabecera y del detalle
// (sangría y guías del árbol); entre el nombre y el estado de la derecha, una guía de puntos.
func lxoRow(headLead, detailLead, glyph, head, right, detail string) block {
	return funcBlock(func(width int) string {
		line := lxoLeader(pad+headLead+glyph+" "+head, right, width)
		if detail == "" {
			return line
		}
		sub := pad + detailLead + sDim.Render(detail)
		return line + "\n" + ansi.Truncate(sub, max(1, width-1), glyphEllipsis)
	})
}

// lxoLeader: izquierda y derecha unidas por puntos tenues, para seguir la fila con la vista en una
// terminal ancha. Si no caben, como fitRight.
func lxoLeader(left, right string, width int) string {
	if right == "" {
		return left
	}
	w := max(1, width-1)
	gap := w - ansi.StringWidth(left) - ansi.StringWidth(right)
	if gap < 5 {
		return twoCol(left, right, w)
	}
	return left + " " + sDim2.Render(strings.Repeat(glyphSep, gap-2)) + " " + right
}

// lxoGap: la línea en blanco entre dos elementos; lead lleva las guías del árbol que siguen abiertas.
func lxoGap(lead string) block {
	return funcBlock(func(int) string { return strings.TrimRight(pad+lead, " ") })
}

// lxoSpaced: los elementos con una línea en blanco entre uno y otro.
func lxoSpaced(items []block) []block {
	var out []block
	for i, item := range items {
		if i > 0 {
			out = append(out, lxoGap(""))
		}
		out = append(out, item)
	}
	return out
}

// lxoText: texto sangrado que se reenvuelve al ancho de la terminal.
func lxoText(text string) block {
	return funcBlock(func(width int) string {
		lines := wrapText(text, max(10, width-len(pad)-1))
		for i := range lines {
			lines[i] = pad + lines[i]
		}
		return strings.Join(lines, "\n")
	})
}

func lxoHint(text string) block {
	return funcBlock(func(width int) string {
		return ansi.Truncate(pad+sDim.Render(glyphArrow+" "+text), max(1, width-1), glyphEllipsis)
	})
}

func lxoField(label, value string) block {
	return funcBlock(func(width int) string {
		lines := wrapText(value, max(10, width-16))
		out := pad + sDim.Render(fmt.Sprintf("%-11s", label)) + " " + lines[0]
		for _, l := range lines[1:] {
			out += "\n" + pad + strings.Repeat(" ", 12) + l
		}
		return out
	})
}

func lxoJoin(sep string, parts ...string) string {
	kept := parts[:0:0]
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, sep)
}

// renderLxo pinta el `--json` de una orden de lectura de lxo. Puro: probado sin lxo ni terminal.
func renderLxo(args []string, out string, names map[string]string, now time.Time) []block {
	var doc jsonMap
	if json.Unmarshal([]byte(strings.TrimSpace(out)), &doc) != nil {
		return []block{errLine("lxo devolvió algo que este CLI no entiende; actualiza Lixbon.")}
	}
	sep := " " + glyphSep + " "
	// Las tareas se pintan en la forma 1 (`task_model: "legacy"`), la que lxo da por defecto mientras dure la
	// ventana de compatibilidad (docs/core/LXO_CORTE.md). Otra forma no se lee a medias.
	if (args[0] == "tasks" || args[0] == "task") && jnum(doc, "v") != 1 {
		return []block{errLine(fmt.Sprintf("lxo devolvió las tareas en una forma (v%d) que este CLI no pinta; actualiza el CLI o mira ! lxo %s --json.", jnum(doc, "v"), strings.Join(args, " ")))}
	}
	switch {
	case args[0] == "summary":
		return renderSummary(doc, sep)
	case args[0] == "projects":
		return renderProjects(doc, sep)
	case args[0] == "attention" && len(args) > 1 && args[1] == "show":
		return renderAttentionShow(doc, names, now, sep)
	case args[0] == "attention":
		return renderAttention(doc, names, now, sep)
	case args[0] == "task" || (args[0] == "tasks" && len(args) > 1 && args[1] == "show"):
		return renderTaskShow(doc, names, now, sep)
	default:
		return renderTasks(doc, names, sep)
	}
}

func renderSummary(doc jsonMap, sep string) []block {
	core, projects, attention := jobj(doc, "core"), jobj(doc, "projects"), jobj(doc, "attention")
	withWork := fmt.Sprint(jnum(projects, "with_work"))
	if b, ok := projects["with_work_complete"].(bool); ok && !b {
		withWork = "≥" + withWork
	}
	right := "Core " + jstr(core, "version")
	if jstr(core, "health") == "read_only" {
		right += sep + "solo lectura"
	}
	total := jnum(attention, "total")
	lines := []block{
		lxoTitle("Lixbon", right),
		lxoText(lxoJoin(sep,
			sInk.Render(withWork)+" "+sDim.Render("proyectos con trabajo"),
			sInk.Render(fmt.Sprint(jnum(doc, "active_tasks")))+" "+sDim.Render("tareas activas"),
			lxoSeverityStyle(map[bool]string{true: "high", false: "low"}[total > 0]).Render(fmt.Sprint(total))+" "+sDim.Render("piden atención"),
		)),
	}
	by := jobj(attention, "by_category")
	var parts []string
	for _, c := range categoryOrder {
		if n := jnum(by, c); n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, strings.ToLower(lxoLabel(categoryLabel, c))))
		}
	}
	if len(parts) > 0 {
		lines = append(lines, lxoText(sDim.Render(strings.Join(parts, sep))))
	}
	if total > 0 {
		lines = append(lines, lxoHint("! lxo attention para verla"))
	} else if jnum(doc, "active_tasks") > 0 {
		lines = append(lines, lxoHint("! lxo tasks --active para verlas"))
	}
	return lines
}

func renderProjects(doc jsonMap, sep string) []block {
	projects := jlist(doc, "projects")
	lines := []block{lxoTitle("Proyectos", noun(len(projects), "proyecto", "proyectos"))}
	var items []block
	if len(projects) == 0 {
		return append(lines, lxoText(sDim.Render("Sin proyectos registrados. Se registran desde Lixbon o al lanzar un run en un repositorio.")))
	}
	for _, p := range projects {
		counts := jobj(p, "counts")
		status := jstr(p, "status")
		st := lxoProjectStyle(status)
		right := st.Render(lxoLabel(projectStatusLabel, status))
		if jstr(p, "state") == "archived" {
			right = sDim.Render("archivado") + sDim.Render(sep) + right
		}
		var loc string
		for _, l := range jlist(p, "locations") {
			if b, _ := l["primary"].(bool); b || loc == "" {
				loc = jstr(l, "path")
			}
		}
		att := jnum(jobj(counts, "attention"), "total")
		detail := lxoJoin(sep,
			noun(int(jnum(counts, "active")), "activa", "activas"),
			noun(int(jnum(counts, "failed")), "fallida", "fallidas"),
			fmt.Sprintf("%d piden atención", att),
			noun(int(jnum(counts, "tasks")), "tarea en total", "tareas en total"),
			loc,
		)
		items = append(items, lxoItem(0, st.Render(glyphDot), sInk.Render(jstr(p, "name")), right, detail))
	}
	un := jobj(doc, "unassigned")
	if jnum(un, "tasks") > 0 {
		items = append(items, lxoText(sDim.Render("Sin proyecto"+sep+noun(int(jnum(un, "active")), "activa", "activas")+sep+noun(int(jnum(un, "failed")), "fallida", "fallidas"))))
	}
	return append(lines, lxoSpaced(items)...)
}

func renderAttention(doc jsonMap, names map[string]string, now time.Time, sep string) []block {
	items := jlist(doc, "items")
	lines := []block{lxoTitle("Atención", noun(len(items), "activa", "activas"))}
	if len(items) == 0 {
		return append(lines, lxoText(sOK.Render(glyphDone)+" "+sDim.Render("Nada pide atención ahora mismo.")))
	}
	var rows []block
	for _, a := range items {
		sev := jstr(a, "severity")
		glyph := lxoSeverityStyle(sev).Render(glyphDot)
		if sev == "critical" {
			glyph = sErr.Render(glyphWarn)
		}
		target := lxoJoin(" ", map[string]string{"task": "tarea"}[jstr(a, "target_kind")], jstr(a, "target_id"))
		if !strings.HasPrefix(target, "tarea") {
			target = jstr(a, "target_kind") + " " + jstr(a, "target_id")
		}
		head := sInk.Render(lxoLabel(categoryLabel, jstr(a, "category"))) + sDim.Render(sep) + lxoSeverityStyle(sev).Render(lxoLabel(severityLabel, sev))
		rows = append(rows, lxoItem(0, glyph, head, sDim.Render(lxoAgo(jnum(a, "created_at"), now)),
			lxoJoin(sep, target, lxoProject(jstr(a, "project_id"), names), jstr(a, "id"))))
	}
	lines = append(lines, lxoSpaced(rows)...)
	if more, _ := doc["has_more"].(bool); more {
		lines = append(lines, lxoText(sWarn.Render("Hay más: filtra con --project, --category o --severity.")))
	}
	lines = append(lines, lxoGap(""))
	return append(lines, lxoHint("! lxo attention show <id> para el detalle"+sep+"! lxo task show <tarea>"))
}

func renderAttentionShow(a jsonMap, names map[string]string, now time.Time, sep string) []block {
	sev := jstr(a, "severity")
	lines := []block{
		lxoTitle(lxoLabel(categoryLabel, jstr(a, "category")), lxoSeverityStyle(sev).Render(lxoLabel(severityLabel, sev))),
		lxoField("destino", jstr(a, "target_kind")+" "+jstr(a, "target_id")),
		lxoField("proyecto", lxoProject(jstr(a, "project_id"), names)),
		lxoField("estado", jstr(a, "status")),
		lxoField("desde", lxoAgo(jnum(a, "created_at"), now)),
		lxoField("id", jstr(a, "id")),
	}
	if n := jnum(a, "occurrence"); n > 1 {
		lines = append(lines, lxoField("veces", fmt.Sprint(n)))
	}
	if jstr(a, "target_kind") == "task" {
		lines = append(lines, lxoHint("! lxo task show "+jstr(a, "target_id")))
	}
	return lines
}

func lxoAgent(t jsonMap) string {
	agent := jstr(t, "provider")
	if model := jstr(t, "model"); model != "" {
		agent += " (" + model + ")"
	}
	return agent
}

func lxoPlace(t jsonMap) string {
	if b := jstr(t, "branch"); b != "" {
		return glyphBranch + " " + b
	}
	if shared, _ := t["shared_checkout"].(bool); shared {
		return "checkout compartido"
	}
	return ""
}

func renderTasks(doc jsonMap, names map[string]string, sep string) []block {
	tasks := jlist(doc, "tasks")
	active := 0
	for _, t := range tasks {
		if final, _ := t["final"].(bool); !final {
			active++
		}
	}
	lines := []block{lxoTitle("Tareas", fmt.Sprintf("%s%s%d activas", noun(len(tasks), "tarea", "tareas"), sep, active))}
	if len(tasks) == 0 {
		return append(lines, lxoText(sDim.Render("Sin tareas con estos filtros.")))
	}
	byID := map[string]int{}
	depths := make([]int, len(tasks))
	for i, t := range tasks {
		if parent := jstr(t, "parent_id"); parent != "" {
			if pd, ok := byID[parent]; ok {
				depths[i] = pd + 1
			}
		}
		byID[jstr(t, "id")] = depths[i]
	}
	for i, t := range tasks {
		if i > 0 {
			lines = append(lines, lxoGap(lxoGuides(depths, i-1, depths[i-1]+1, -1)))
		}
		d := depths[i]
		status := jstr(t, "status")
		origin := ""
		if jstr(t, "origin") == "external" {
			origin = "externa"
		}
		detail := lxoJoin(sep, jstr(t, "id"), lxoProject(jstr(t, "project_id"), names), lxoAgent(t), lxoPlace(t), origin)
		lines = append(lines, lxoRow(lxoGuides(depths, i, d, d-1), lxoGuides(depths, i, d+1, -1),
			lxoStatusMark(status), sInk.Render(jstr(t, "title")), lxoStatusStyle(status).Render(lxoLabel(statusLabel, status)), detail))
	}
	lines = append(lines, lxoGap(""))
	return append(lines, lxoHint("! lxo task show <id o nombre> para el detalle"))
}

// lxoGuides: las guías del árbol de tareas en las primeras cols columnas de la fila del elemento i: «│» en
// la columna k si a ese nivel quedan hermanas por debajo. En elbow (la columna de su propio padre) va «│» o,
// si es la última hija, «└». depths va en el orden del árbol: raíz y luego sus hijas.
func lxoGuides(depths []int, i, cols, elbow int) string {
	more := func(k int) bool {
		for j := i + 1; j < len(depths); j++ {
			if depths[j] <= k {
				return false
			}
			if depths[j] == k+1 {
				return true
			}
		}
		return false
	}
	var b strings.Builder
	for k := 0; k < cols; k++ {
		switch {
		case more(k):
			b.WriteString(sDim2.Render(glyphRail) + " ")
		case k == elbow:
			b.WriteString(sDim2.Render(glyphCorner) + " ")
		default:
			b.WriteString("  ")
		}
	}
	return b.String()
}

func renderTaskShow(doc jsonMap, names map[string]string, now time.Time, sep string) []block {
	t := jobj(doc, "task")
	status := jstr(t, "status")
	id := jstr(t, "id")
	tree := "raíz"
	if parent := jstr(t, "parent_id"); parent != "" {
		tree = "hija de " + parent
		if root := jstr(t, "root_id"); root != "" && root != parent {
			tree += " (raíz " + root + ")"
		}
	}
	var children []string
	raw, _ := doc["children"].([]any)
	for _, c := range raw {
		if s, ok := c.(string); ok {
			children = append(children, s)
		}
	}
	origin := "Lixbon"
	if jstr(t, "origin") == "external" {
		origin = "coordinador externo"
	}
	lines := []block{
		lxoTitle(jstr(t, "title"), lxoStatusMark(status)+" "+lxoStatusStyle(status).Render(lxoLabel(statusLabel, status))),
		lxoField("tarea", lxoJoin(sep, id, "run "+jstr(t, "run_id"), tree)),
		lxoField("proyecto", lxoProject(jstr(t, "project_id"), names)),
		lxoField("agente", lxoJoin(sep, lxoAgent(t), jstr(t, "role"))),
	}
	if place := lxoPlace(t); place != "" {
		lines = append(lines, lxoField("rama", lxoJoin(sep, place, map[bool]string{true: "base " + jstr(t, "base")}[jstr(t, "base") != ""])))
	}
	if wt := jstr(t, "worktree"); wt != "" {
		lines = append(lines, lxoField("worktree", sDim.Render(wt)))
	}
	if phase := jobj(t, "phase"); jstr(phase, "name") != "" {
		state := "en curso"
		if done, _ := phase["done"].(bool); done {
			state = "terminada"
		}
		lines = append(lines, lxoField("fase", jstr(phase, "name")+sep+state))
	}
	lines = append(lines, lxoField("origen", origin))
	if reason := jstr(t, "failure_reason"); reason != "" {
		lines = append(lines, lxoField("fallo", sErr.Render(reason)))
	}
	if merged, _ := t["merged"].(bool); merged {
		lines = append(lines, lxoField("integrada", sOK.Render(glyphDone)+" sí"))
	}
	if pr := jstr(t, "pr_url"); pr != "" {
		lines = append(lines, lxoField("PR", pr))
	}
	if len(children) > 0 {
		lines = append(lines, lxoField("hijas", strings.Join(children, ", ")))
	}
	lines = append(lines, lxoField("actualizada", lxoAgo(jnum(t, "updated_at"), now)))
	lines = append(lines, lxoActivity(doc, id, now, sep)...)
	return append(lines, lxoHint("! lxo attention --task "+id+sep+"! lxo events --task "+id))
}

// lxoActivity: la Activity de la Task que da lxo (proyección del Core, ya traducida), lo último al final.
func lxoActivity(doc jsonMap, id string, now time.Time, sep string) []block {
	activity, ok := doc["activity"].(map[string]any)
	if !ok {
		return []block{lxoField("actividad", sDim.Render("no disponible en este Core"))}
	}
	items := jlist(activity, "items")
	if len(items) == 0 {
		return []block{lxoField("actividad", sDim.Render("sin eventos todavía"))}
	}
	head := "lo último al final"
	if more, _ := activity["has_more"].(bool); more {
		head += sep + "lo anterior con ! lxo events --task " + id
	}
	lines := []block{lxoField("actividad", sDim.Render(head))}
	for _, item := range items {
		text := jstr(item, "text")
		style := sInk
		switch jstr(item, "visual") {
		case "error":
			style = sErr
		case "warning":
			style = sWarn
		case "success":
			style = sOK
		}
		if text == "" {
			text, style = "Evento "+jstr(item, "kind")+" sin texto", sDim
		}
		lines = append(lines, lxoField(lxoAgo(jnum(item, "ts"), now), style.Render(text)))
	}
	return lines
}
