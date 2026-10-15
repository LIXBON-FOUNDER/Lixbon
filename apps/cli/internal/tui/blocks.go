package tui

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/agent"
)

// Rejilla del transcript: marcador en la columna 2 y contenido en la 4.
const pad = "   "

func mark(glyph string, st lipgloss.Style) string { return " " + st.Render(glyph) + " " }

// fitRight pone right pegado al margen derecho dejando una columna libre.
func fitRight(left, right string, width int) string {
	if right == "" {
		return left
	}
	return twoCol(left, right, max(1, width-1))
}

func wrapText(text string, width int) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		out = append(out, strings.Split(ansi.Wrap(line, max(1, width), ""), "\n")...)
	}
	return out
}

func noun(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

func counts(adds, dels int) string {
	return sOK.Render(fmt.Sprintf("+%d", adds)) + " " + sErr.Render(fmt.Sprintf("%s%d", glyphMinus, dels))
}

func seconds(d time.Duration) string {
	if d < 100*time.Millisecond {
		return ""
	}
	return fmt.Sprintf("%.1f s", d.Seconds())
}

// ── avisos ───────────────────────────────────────────────────────────────

type noticeKind int

const (
	kindNote noticeKind = iota
	kindOK
	kindErr
	kindWarn
	kindInfo
	kindSep
	kindAsk
)

type noticeBlock struct {
	kind   noticeKind
	text   string
	detail string
}

func note(text string) block     { return noticeBlock{kind: kindNote, text: text} }
func okLine(text string) block   { return noticeBlock{kind: kindOK, text: text} }
func errLine(text string) block  { return noticeBlock{kind: kindErr, text: text} }
func warnLine(text string) block { return noticeBlock{kind: kindWarn, text: text} }
func infoLine(text, detail string) block {
	return noticeBlock{kind: kindInfo, text: text, detail: detail}
}
func separator(label string) block { return noticeBlock{kind: kindSep, text: label} }

// askLine es una pregunta que espera respuesta en la caja (ask_user, una clave…).
func askLine(text string) block { return noticeBlock{kind: kindAsk, text: text} }

func (b noticeBlock) render(width int, _ bool) string {
	if b.kind == kindSep {
		label := glyphs.rule + glyphs.rule + " " + b.text + " "
		return sDim2.Render(label + strings.Repeat(glyphs.rule, max(3, width-ansi.StringWidth(label)-1)))
	}
	head, style := pad, sPrimary
	switch b.kind {
	case kindNote:
		style = sDim
	case kindOK:
		head = mark(glyphDot, sOK)
	case kindErr:
		head = mark(glyphDot, sErr)
	case kindWarn:
		head = mark("!", sWarn.Bold(true))
	case kindInfo:
		head = mark(glyphInfo, sDim2)
	case kindAsk:
		head, style = mark("?", sWarn.Bold(true)), sBold
	}
	lines := wrapText(b.text, width-4)
	for i, l := range lines {
		if i == 0 {
			lines[i] = head + style.Render(l)
		} else {
			lines[i] = pad + style.Render(l)
		}
	}
	if b.detail != "" {
		tail := " " + glyphSep + " " + b.detail
		if last := lines[len(lines)-1]; ansi.StringWidth(last+tail) <= width-1 {
			lines[len(lines)-1] = last + sDim.Render(tail)
		} else {
			lines = append(lines, pad+sDim.Render(ansi.Truncate(b.detail, max(1, width-4), glyphEllipsis)))
		}
	}
	return strings.Join(lines, "\n")
}

// ── usuario y eco ────────────────────────────────────────────────────────

var imgMarker = regexp.MustCompile(`\s*\[IMG#\d+\]`)

type imageChip struct {
	n          int
	name       string
	w, h       int
	size       int64
	visionless bool
}

func (c imageChip) label() string {
	parts := []string{c.name}
	if c.w > 0 && c.h > 0 {
		parts = append(parts, fmt.Sprintf("%d×%d", c.w, c.h))
	}
	if c.size > 0 {
		parts = append(parts, fmtBytes(c.size))
	}
	return glyphChip + " " + strings.Join(parts, " "+glyphSep+" ")
}

func fmtBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%d KB", n>>10)
	}
	return fmt.Sprintf("%d B", n)
}

type userBlock struct {
	text  string
	chips []imageChip
}

func (b userBlock) render(width int, _ bool) string {
	text := strings.TrimSpace(imgMarker.ReplaceAllString(b.text, ""))
	limit := max(8, width-5)
	var rows []string
	if text != "" {
		rows = wrapText(text, limit)
	}
	var chips []string
	for _, c := range b.chips {
		chips = append(chips, ansi.Truncate(c.label(), limit, glyphEllipsis))
	}
	fill := 0
	for _, r := range append(append([]string{}, rows...), chips...) {
		fill = max(fill, ansi.StringWidth(r))
	}
	bar := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.sand)).Background(lipgloss.Color(pal.surf))
	surf := lipgloss.NewStyle().Background(lipgloss.Color(pal.surf))
	line := func(text string, fg string) string {
		return " " + bar.Render(glyphEdge) + surf.Foreground(lipgloss.Color(fg)).Render(" "+text+strings.Repeat(" ", fill-ansi.StringWidth(text))+" ")
	}
	var out []string
	for _, r := range rows {
		out = append(out, line(r, pal.ink))
	}
	for _, c := range chips {
		out = append(out, line(c, pal.soft))
	}
	return strings.Join(out, "\n")
}

type echoBlock string

var keyArg = regexp.MustCompile(`^(/key\s+)(\S+)`)

func (b echoBlock) render(width int, _ bool) string {
	text := keyArg.ReplaceAllStringFunc(string(b), func(s string) string {
		parts := keyArg.FindStringSubmatch(s)
		return parts[1] + maskKey(parts[2])
	})
	return mark(glyphPrompt, sAccent) + sSoft.Render(ansi.Truncate(text, max(1, width-4), glyphEllipsis))
}

func maskKey(key string) string {
	r := []rune(key)
	if len(r) <= 12 {
		return strings.Repeat("•", len(r))
	}
	return string(r[:10]) + "…" + string(r[len(r)-4:])
}

// ── pensamiento ──────────────────────────────────────────────────────────

type thinkBlock struct {
	text string
	secs float64
}

func (thinkBlock) folds() bool { return true }

func (b thinkBlock) render(width int, open bool) string {
	label := "Pensó"
	if b.secs >= 0.1 {
		label += fmt.Sprintf(" %.1f s", b.secs)
	}
	hint := "ctrl+o ver"
	if open {
		hint = "ctrl+o ocultar"
	}
	italic := sDim.Italic(true)
	out := []string{fitRight(mark(glyphSpark, sDim)+italic.Render(label), sDim2.Render(hint), width)}
	if open {
		for _, l := range wrapText(strings.TrimSpace(b.text), width-6) {
			out = append(out, pad+sDim2.Render(glyphThinkRail)+" "+italic.Render(l))
		}
	}
	return strings.Join(out, "\n")
}

// ── herramientas ─────────────────────────────────────────────────────────

var toolVerbs = map[string][2]string{
	"read_file": {"Leer", "Leyendo"}, "write_file": {"Escribir", "Escribiendo"}, "edit_file": {"Editar", "Editando"},
	"multi_edit": {"Editar", "Editando"}, "insert_at_line": {"Editar", "Editando"}, "append_file": {"Añadir a", "Añadiendo a"},
	"delete_file": {"Eliminar", "Eliminando"}, "rename_file": {"Mover", "Moviendo"}, "mkdir": {"Crear carpeta", "Creando carpeta"},
	"search": {"Buscar", "Buscando"}, "list_files": {"Listar", "Listando"}, "find_files": {"Buscar archivos", "Buscando archivos"},
	"run_command": {"Ejecutar", "Ejecutando"}, "fetch_url": {"Descargar", "Descargando"}, "web_search": {"Buscar en la web", "Buscando en la web"},
	"read_output": {"Leer salida", "Leyendo la salida"}, "stop_command": {"Detener", "Deteniendo"}, "outline": {"Esquematizar", "Esquematizando"},
	"todo": {"Planificar", "Planificando"}, "ask_user": {"Preguntar", "Preguntando"},
	"browser_navigate": {"Abrir", "Abriendo"}, "browser_snapshot": {"Ver página", "Mirando la página"},
	"browser_click": {"Clic en", "Haciendo clic en"}, "browser_type": {"Escribir en", "Escribiendo en"},
	"browser_press_key": {"Pulsar", "Pulsando"}, "browser_scroll": {"Desplazar", "Desplazando"},
	"browser_screenshot": {"Capturar", "Capturando"}, "browser_get_text": {"Leer página", "Leyendo la página"},
	"browser_tabs": {"Pestañas", "Pestañas"}, "browser_wait": {"Esperar", "Esperando"}, "browser_back": {"Volver", "Volviendo"},
}

// browserVerb es el verbo en minúscula para la petición de permiso.
func browserVerb(tool string) string { return strings.ToLower(verbs(tool)[0]) }

var kindVerbs = map[string][2]string{
	"create": {"Crear", "Creando"}, "update": {"Editar", "Editando"}, "delete": {"Eliminar", "Eliminando"},
	"rename": {"Mover", "Moviendo"}, "mkdir": {"Crear carpeta", "Creando carpeta"}, "append": {"Añadir a", "Añadiendo a"},
	"command": {"Ejecutar", "Ejecutando"},
}

func verbs(tool string) [2]string {
	if v, ok := toolVerbs[tool]; ok {
		return v
	}
	return [2]string{tool, tool}
}

type toolState int

const (
	toolRunning toolState = iota
	toolWaiting
	toolDone
	toolFailed
	toolStopped
)

const (
	outputHead2   = 2
	outputTail    = 3
	outputInline  = 6
	diffShownRows = 40
)

// toolBlock es una acción del agente, un !comando del usuario o un cambio:
// cabecera con su estado y, debajo, salida, diff y resultado.
type toolBlock struct {
	shell        bool
	verb, gerund string
	target       string
	meta         string
	adds, dels   int
	counts       bool
	state        toolState
	spin         *int

	result  string
	check   string
	fetch   bool
	command bool
	code    string
	output  []string
	diff    *diffView
}

func newToolBlock(e agent.Event, spin *int) *toolBlock {
	v := verbs(e.Tool)
	b := &toolBlock{verb: v[0], gerund: v[1], target: e.Text, meta: e.Meta, spin: spin, state: toolRunning}
	if e.Change != nil {
		if kv, ok := kindVerbs[e.Change.Kind]; ok {
			b.verb, b.gerund = kv[0], kv[1]
		}
		b.target = e.Change.Path
		switch e.Change.Kind {
		case "rename":
			b.target = e.Change.Path + " " + glyphArrow + " " + e.Change.Detail
		case "command":
			b.target = e.Change.Detail
		}
		if rows := agent.DiffRows(*e.Change, agent.DiffContext); len(rows) > 0 && e.Change.Kind != "command" {
			b.diff = &diffView{rows: rows, path: e.Change.Path}
		}
	}
	if e.Tool == "MCP" {
		label, summary, _ := strings.Cut(e.Text, "  ")
		b.verb, b.gerund, b.target = label, "Usando "+label, summary
	}
	b.command = e.Tool == "run_command"
	b.fetch = e.Tool == "fetch_url"
	b.counts = e.Adds != 0 || e.Dels != 0
	b.adds, b.dels = e.Adds, e.Dels
	return b
}

// finish aplica el resultado de la acción.
func (b *toolBlock) finish(e agent.Event) {
	b.state = toolDone
	if e.Failed {
		b.state = toolFailed
	}
	b.check = e.Check
	if t := seconds(e.Elapsed); t != "" && !b.counts {
		b.meta = t
	}
	if b.command && e.Result != "" {
		b.setOutput(e.Result)
		return
	}
	b.result = e.Summary
}

// setOutput reparte la salida de run_command: «[EXIT n] …», «[TIMEOUT] …»,
// «[ERROR] …» o «[background id] …».
func (b *toolBlock) setOutput(result string) {
	b.command = true
	body := result
	switch {
	case strings.HasPrefix(body, "[EXIT "):
		rest := strings.TrimPrefix(body, "[EXIT ")
		if n, after, ok := strings.Cut(rest, "]"); ok {
			b.code, body = n, strings.TrimPrefix(after, " ")
		}
	case strings.HasPrefix(body, "[TIMEOUT]"):
		b.code, body = "timeout", strings.TrimSpace(strings.TrimPrefix(body, "[TIMEOUT]"))
	case strings.HasPrefix(body, "[ERROR]"):
		b.code, body = "error", strings.TrimSpace(strings.TrimPrefix(body, "[ERROR]"))
	case strings.HasPrefix(body, "[background "):
		id, after, _ := strings.Cut(strings.TrimPrefix(body, "[background "), "]")
		b.code, body = "bg:"+id, strings.TrimSpace(after)
	}
	body = strings.ReplaceAll(ansi.Strip(body), "\t", "    ")
	b.output = nil
	for _, l := range strings.Split(strings.TrimRight(body, "\n"), "\n") {
		if l = strings.TrimRight(l, " \r"); l != "" || len(b.output) > 0 {
			b.output = append(b.output, l)
		}
	}
	if len(b.output) == 1 && b.output[0] == "(sin salida)" {
		b.output = nil
	}
	if b.code != "" && b.code != "0" && !strings.HasPrefix(b.code, "bg:") {
		b.state = toolFailed
	}
}

func (b *toolBlock) folds() bool {
	return len(b.output) > outputInline || b.diff != nil && len(b.diff.rows) > diffShownRows
}

func (b *toolBlock) dot() string {
	glyph := glyphDot
	if b.shell {
		glyph = "$"
	}
	switch b.state {
	case toolRunning:
		frame := glyphs.spin[0]
		if b.spin != nil {
			frame = glyphs.spin[*b.spin%len(glyphs.spin)]
		}
		if b.shell {
			return sAccent.Bold(true).Render("$")
		}
		return sAccent.Render(frame)
	case toolWaiting:
		return sWarn.Render(glyphWait)
	case toolFailed:
		return sErr.Render(glyph)
	case toolStopped:
		return sDim2.Render(glyph)
	}
	return sOK.Render(glyph)
}

func (b *toolBlock) header(width int) string {
	left := " " + b.dot() + " " + sBold.Render(b.verb)
	switch {
	case b.fetch:
		left = " " + b.dot() + " " + sBold.Render("Fetch") + sDim.Render("(") + sBeige.Render(b.target) + sDim.Render(")")
	case b.target != "":
		left += "  " + sBeige.Render(b.target)
	}
	right := ""
	switch {
	case b.state == toolWaiting:
		right = sWarn.Render("esperando")
	case b.counts:
		right = counts(b.adds, b.dels)
	case b.meta != "":
		right = sDim.Render(b.meta)
	}
	return fitRight(left, right, width)
}

func (b *toolBlock) render(width int, open bool) string {
	out := []string{b.header(width)}
	if b.diff != nil {
		out = append(out, b.diff.render(width, open)...)
	}
	if len(b.output) > 0 {
		rail := pad + sDim2.Render(glyphRail) + " "
		line := func(l string) string { return rail + sPrimary.Render(ansi.Truncate(l, max(1, width-6), glyphEllipsis)) }
		if open || len(b.output) <= outputInline {
			for _, l := range b.output {
				out = append(out, line(l))
			}
		} else {
			for _, l := range b.output[:outputHead2] {
				out = append(out, line(l))
			}
			hidden := len(b.output) - outputHead2 - outputTail
			out = append(out, rail+sDim.Render(fmt.Sprintf("%s %d líneas", glyphEllipsis, hidden))+sDim2.Render(" "+glyphSep+" ctrl+o"))
			for _, l := range b.output[len(b.output)-outputTail:] {
				out = append(out, line(l))
			}
		}
	}
	if footer := b.footer(width); footer != "" {
		out = append(out, footer)
	}
	return strings.Join(out, "\n")
}

func (b *toolBlock) footer(width int) string {
	corner := pad + sDim2.Render(glyphCorner) + " "
	if b.fetch && b.state == toolRunning {
		return corner + sDim.Render("Descargando"+glyphEllipsis)
	}
	if b.state == toolRunning || b.state == toolWaiting {
		return ""
	}
	extra := ""
	if b.check != "" {
		extra = " " + glyphSep + " " + b.check
	}
	if b.state == toolStopped {
		return corner + sWarn.Render("interrumpido")
	}
	if b.command {
		var status string
		switch {
		case b.code == "timeout":
			status = sWarn.Render("tiempo agotado")
		case b.code == "error":
			status = sErr.Render("error")
		case strings.HasPrefix(b.code, "bg:"):
			status = sDim.Render("en segundo plano " + glyphSep + " " + strings.TrimPrefix(b.code, "bg:"))
		case b.code == "0":
			status = sOK.Render("exit 0")
		case b.code != "":
			status = sErr.Render("exit " + b.code)
		default:
			status = sDim.Render(firstNonEmpty(b.result, "hecho"))
		}
		tail := ""
		if len(b.output) > 0 {
			tail = " " + glyphSep + " " + noun(len(b.output), "línea", "líneas")
		}
		if b.state == toolFailed && b.code != "timeout" {
			return failRow(corner, ansi.Strip(status)+tail+extra, width)
		}
		return corner + status + sDim.Render(tail) + sDim2.Render(extra)
	}
	summary := b.result
	if summary == "" && b.diff != nil {
		summary = "aplicado"
	}
	if summary == "" && b.check == "" {
		return ""
	}
	if b.state == toolFailed {
		return failRow(corner, summary+extra, width)
	}
	return corner + sDim.Render(summary) + sDim2.Render(extra)
}

// failRow pinta un fallo con la fila tintada hasta el margen: es lo único que
// no puede pasar desapercibido.
func failRow(corner, text string, width int) string {
	room := max(4, width-ansi.StringWidth(corner)-1)
	text = ansi.Truncate(text, room, glyphEllipsis)
	text += strings.Repeat(" ", max(0, room-ansi.StringWidth(text)))
	tint := lipgloss.NewStyle().Foreground(lipgloss.Color(pal.delFg)).Background(lipgloss.Color(pal.delBg))
	return corner + tint.Render(text)
}

// ── lecturas agrupadas ───────────────────────────────────────────────────

type readItem struct {
	tool, target, meta string
	failed             bool
	summary            string
	thought            thinkBlock
}

// readGroupBlock reúne las lecturas seguidas. Mientras sigue abierto
// («Explorando») la fila dice cuál fue la última.
type readGroupBlock struct {
	items   []readItem
	elapsed time.Duration
	live    bool
}

func (b *readGroupBlock) folds() bool {
	return len(b.items) > 1 || slices.ContainsFunc(b.items, func(it readItem) bool { return hasThought(it.thought) })
}

func (b *readGroupBlock) render(width int, open bool) string {
	if len(b.items) == 1 {
		it := b.items[0]
		dot := sOK.Render(glyphDot)
		if it.failed {
			dot = sErr.Render(glyphDot)
		}
		left := " " + dot + " " + sBold.Render(verbs(it.tool)[0]) + "  " + sBeige.Render(it.target)
		out := []string{fitRight(left, sDim.Render(it.meta), width)}
		if open {
			out = append(out, thoughtRows(it.thought, pad, width)...)
		}
		if it.failed {
			out = append(out, failRow(pad+sDim2.Render(glyphCorner)+" ", it.summary, width))
		}
		return strings.Join(out, "\n")
	}
	files, searches, other, failed := 0, 0, 0, 0
	for _, it := range b.items {
		switch it.tool {
		case "read_file", "outline", "read_output":
			files++
		case "search", "find_files", "web_search", "list_files":
			searches++
		default:
			other++
		}
		if it.failed {
			failed++
		}
	}
	var parts []string
	if files > 0 {
		parts = append(parts, noun(files, "archivo", "archivos"))
	}
	if searches > 0 {
		parts = append(parts, noun(searches, "búsqueda", "búsquedas"))
	}
	if other > 0 {
		parts = append(parts, noun(other, "consulta", "consultas"))
	}
	summary := sSoft.Render(strings.Join(parts, " "+glyphSep+" "))
	dot := sOK.Render(glyphDot)
	if failed > 0 {
		dot = sErr.Render(glyphDot)
		summary += sErr.Render(" " + glyphSep + " " + noun(failed, "error", "errores"))
	}
	verb := "Exploró"
	if b.live {
		last := b.items[len(b.items)-1]
		verb = "Explorando"
		summary += sDim2.Render("  "+glyphSep+"  ") + sSoft.Render(verbs(last.tool)[0]) + " " + sBeige.Render(last.target)
	}
	out := []string{fitRight(" "+dot+" "+sBold.Render(verb)+"  "+summary, sDim.Render(seconds(b.elapsed)), width)}
	if open {
		for i, it := range b.items {
			rail := glyphRail
			if i == len(b.items)-1 {
				rail = glyphCorner
			}
			out = append(out, thoughtRows(it.thought, pad, width)...)
			verb := verbs(it.tool)[0]
			left := pad + sDim2.Render(rail) + " " + sSoft.Render(fmt.Sprintf("%-9s", verb)) + sBeige.Render(it.target)
			right := sDim.Render(it.meta)
			if it.failed {
				right = sErr.Render(ansi.Truncate(it.summary, 40, glyphEllipsis))
			}
			out = append(out, fitRight(left, right, width))
		}
	}
	return strings.Join(out, "\n")
}

func hasThought(t thinkBlock) bool { return strings.TrimSpace(t.text) != "" }

// thoughtRows pinta lo pensado antes de un paso dentro de un grupo desplegado.
func thoughtRows(t thinkBlock, lead string, width int) []string {
	if !hasThought(t) {
		return nil
	}
	italic := sDim.Italic(true)
	rail := lead + sDim2.Render(glyphThinkRail) + " "
	label := "Pensó"
	if t.secs >= 0.1 {
		label += fmt.Sprintf(" %.1f s", t.secs)
	}
	out := []string{rail + italic.Render(label)}
	for _, l := range wrapText(t.text, max(10, width-ansi.StringWidth(rail)-1)) {
		out = append(out, rail+italic.Render(l))
	}
	return out
}

// ── navegador ────────────────────────────────────────────────────────────

// browserBlock reúne las acciones seguidas del agente en el navegador en una
// fila que cambia con cada paso; ctrl+o despliega los pasos y lo pensado.
type browserBlock struct {
	steps    []*toolBlock
	thoughts []thinkBlock
	secs     float64
	live     bool
}

func (b *browserBlock) last() *toolBlock { return b.steps[len(b.steps)-1] }

func (b *browserBlock) folds() bool {
	return len(b.steps) > 1 || slices.ContainsFunc(b.thoughts, hasThought)
}

func (b *browserBlock) render(width int, open bool) string {
	cur := b.last()
	verb := cur.verb
	if cur.state == toolRunning {
		verb = cur.gerund
	}
	left := " " + cur.dot() + " " + sBold.Render("Navegador") + sDim2.Render("  "+glyphSep+"  ") +
		sSoft.Render(verb) + "  " + sBeige.Render(cur.target)
	failed := 0
	for _, s := range b.steps {
		if s.state == toolFailed {
			failed++
		}
	}
	var right string
	switch {
	case cur.state == toolWaiting:
		right = sWarn.Render("esperando")
	case len(b.steps) == 1:
		right = sDim.Render(cur.meta)
	default:
		right = sDim.Render(noun(len(b.steps), "acción", "acciones"))
		if failed > 0 && (failed > 1 || cur.state != toolFailed) {
			right += sErr.Render(" " + glyphSep + " " + noun(failed, "error", "errores"))
		}
		if t := seconds(time.Duration(b.secs * float64(time.Second))); t != "" {
			right += sDim.Render(" " + glyphSep + " " + t)
		}
	}
	out := []string{fitRight(left, right, width)}
	if !open {
		if footer := cur.footer(width); footer != "" {
			out = append(out, footer)
		}
		return strings.Join(out, "\n")
	}
	for i, s := range b.steps {
		branch, cont := glyphRail, glyphRail
		if i == len(b.steps)-1 {
			branch, cont = glyphCorner, " "
		}
		out = append(out, thoughtRows(b.thoughts[i], pad, width)...)
		row := pad + sDim2.Render(branch) + " " + sSoft.Render(fmt.Sprintf("%-12s", s.verb)) + sBeige.Render(s.target)
		meta := sDim.Render(s.meta)
		if s.state == toolWaiting {
			meta = sWarn.Render("esperando")
		}
		out = append(out, fitRight(row, meta, width))
		if s.result == "" {
			continue
		}
		lead := pad + sDim2.Render(cont) + " " + sDim2.Render(glyphCorner) + " "
		if s.state == toolFailed {
			out = append(out, failRow(lead, s.result, width))
		} else {
			out = append(out, ansi.Truncate(lead+sDim.Render(s.result), max(1, width-1), glyphEllipsis))
		}
	}
	return strings.Join(out, "\n")
}

// ── plan ─────────────────────────────────────────────────────────────────

type todoBlock struct{ items []todoItem }

func (b *todoBlock) render(width int, _ bool) string {
	done := 0
	for _, it := range b.items {
		if it.Status == "done" {
			done++
		}
	}
	left := mark(glyphDot, sOK) + sBold.Render("Planificar") + "  " + sSoft.Render(noun(len(b.items), "paso", "pasos"))
	out := []string{fitRight(left, sDim.Render(fmt.Sprintf("%d/%d", done, len(b.items))), width)}
	for _, it := range b.items {
		var glyph, text string
		switch it.Status {
		case "done":
			glyph, text = sOK.Render(glyphDone), sDim2.Strikethrough(true).Render(it.Text)
		case "doing":
			glyph, text = sAccent.Render(glyphDoing), sBold.Render(it.Text)
		default:
			glyph, text = sDim2.Render(glyphTodo), sSoft.Render(it.Text)
		}
		out = append(out, ansi.Truncate(pad+glyph+" "+text, max(1, width-1), glyphEllipsis))
	}
	return strings.Join(out, "\n")
}

// ── respuesta ────────────────────────────────────────────────────────────

// answerBlock es prosa del modelo en markdown: ◆ en la primera fila y el resto
// en la columna 4. Pintarla es caro, así que al redimensionar se reenvuelve lo
// ya pintado y se repinta con calma (lazy).
type answerBlock struct {
	text string
	md   func(text string, width int) string
}

func (answerBlock) lazy() bool { return true }

func (b answerBlock) render(width int, _ bool) string {
	body := strings.Join(wrapText(b.text, width-3), "\n")
	if b.md != nil {
		body = renderRich(b.text, max(20, width-3), b.md)
	}
	lines := strings.Split(body, "\n")
	blank := func(s string) bool { return strings.TrimSpace(ansi.Strip(s)) == "" }
	for len(lines) > 0 && blank(lines[0]) {
		lines = lines[1:]
	}
	for len(lines) > 0 && blank(lines[len(lines)-1]) {
		lines = lines[:len(lines)-1]
	}
	for i, l := range lines {
		if i == 0 {
			lines[i] = mark(glyphBrand, sAccent) + l
		} else {
			lines[i] = pad + l
		}
	}
	return strings.Join(lines, "\n")
}

var trailingBlank = regexp.MustCompile(`(?:[ \t]|\x1b\[[0-9;]*m)+$`)
var sgr = regexp.MustCompile(`\x1b\[[0-9;]*m`)

// trimRightANSI quita los espacios con los que glamour rellena cada línea hasta
// el ancho, conservando las secuencias de estilo que cierran la línea.
func trimRightANSI(line string) string {
	loc := trailingBlank.FindStringIndex(line)
	if loc == nil {
		return line
	}
	return line[:loc[0]] + strings.Join(sgr.FindAllString(line[loc[0]:], -1), "")
}

// ── cierre del turno ─────────────────────────────────────────────────────

type summaryBlock struct {
	actions, files, adds, dels int
	secs                       float64
}

func (b summaryBlock) render(width int, _ bool) string {
	dot := sDim2.Render(" " + glyphSep + " ")
	out := pad + sDim.Render(noun(b.actions, "acción", "acciones"))
	if b.files > 0 {
		out += dot + sDim.Render(noun(b.files, "archivo", "archivos"))
	}
	if b.adds != 0 || b.dels != 0 {
		out += dot + counts(b.adds, b.dels)
	}
	if b.secs >= 0.1 {
		out += dot + sDim.Render(fmt.Sprintf("%.1f s", b.secs))
	}
	return ansi.Truncate(out, max(1, width-1), glyphEllipsis)
}

type sourcesBlock []string

func (b sourcesBlock) render(width int, _ bool) string {
	return ansi.Truncate(pad+sDim.Render("fuentes  ")+sPlan.Render(strings.Join(b, " "+glyphSep+" ")), max(1, width-1), glyphEllipsis)
}

type interruptedBlock struct{}

func (interruptedBlock) render(width int, _ bool) string {
	const rest = "el contexto se conserva: escribe «continúa» para seguir"
	head := mark(glyphWait, sWarn) + sWarn.Render("interrumpido")
	if ansi.StringWidth(head)+3+len([]rune(rest)) <= width-1 {
		return head + sDim.Render(" "+glyphSep+" "+rest)
	}
	lines := []string{head}
	for _, l := range wrapText(rest, width-4) {
		lines = append(lines, pad+sDim.Render(l))
	}
	return strings.Join(lines, "\n")
}

// qrBlock es el QR del control remoto, plegado: la app móvil ya avisa de la
// sesión, así que solo lo despliega quien lo necesite (clic o ctrl+o). Se pinta
// con colores fijos (módulos claros sobre negro) para que se lea con cualquier tema.
type qrBlock string

func (qrBlock) folds() bool { return true }

func (b qrBlock) render(width int, open bool) string {
	hint := "clic para mostrar"
	if open {
		hint = "clic para ocultar"
	}
	out := []string{fitRight(mark(glyphChip, sDim)+sSoft.Render("Código QR")+sDim.Render(" "+glyphSep+" para abrir la sesión desde otro dispositivo"),
		sDim2.Render(hint), width)}
	if open {
		st := lipgloss.NewStyle().Foreground(lipgloss.Color("#FFFFFF")).Background(lipgloss.Color("#000000"))
		for _, r := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
			out = append(out, pad+st.Render(r))
		}
	}
	return strings.Join(out, "\n")
}

// ── informes ─────────────────────────────────────────────────────────────

// reportBlock son los informes de los comandos (/status, /cost…): título y
// filas «etiqueta  valor» con la etiqueta a ancho fijo.
type reportBlock struct {
	title string
	rows  [][2]string
	foot  []string
	// keys pinta las etiquetas en acento (listas de comandos) en vez de atenuadas.
	keys bool
}

func (b reportBlock) render(width int, _ bool) string {
	var out []string
	if b.title != "" {
		out = append(out, mark(glyphDot, sDim)+sBold.Render(b.title))
	}
	labelWidth := 0
	for _, r := range b.rows {
		labelWidth = max(labelWidth, ansi.StringWidth(r[0]))
	}
	for _, r := range b.rows {
		if r[0] == "" && r[1] == "" {
			out = append(out, "")
			continue
		}
		label := r[0] + strings.Repeat(" ", labelWidth-ansi.StringWidth(r[0]))
		style := sDim
		if b.keys {
			style = sAccent
		}
		out = append(out, ansi.Truncate(pad+style.Render(label)+"  "+r[1], max(1, width-1), glyphEllipsis))
	}
	for _, f := range b.foot {
		out = append(out, ansi.Truncate(pad+f, max(1, width-1), glyphEllipsis))
	}
	return strings.Join(out, "\n")
}

// meter es la barra ▰▱ de cells celdas: acento hasta 60 %, ámbar hasta 85 %
// y rojo después.
func meter(pct float64, cells int) string {
	pct = max(0, min(100, pct))
	filled := int(pct*float64(cells)/100 + 0.5)
	style := sAccent
	switch {
	case pct >= ctxFull:
		style = sErr
	case pct >= ctxWarn:
		style = sWarn
	}
	return style.Render(strings.Repeat(glyphMeterOn, filled)) + sDim2.Render(strings.Repeat(glyphMeterOff, cells-filled))
}
