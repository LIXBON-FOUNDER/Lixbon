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
		head, style = mark(glyphs.check, sOK), sSoft
	case kindErr:
		head, style = mark(glyphs.cross, sErr), sSoft
	case kindWarn:
		head, style = mark(glyphWarn, sWarn), sSoft
	case kindInfo:
		head, style = mark(glyphInfo, sDim), sSoft
	case kindAsk:
		head, style = mark(glyphWait, sWarn), sInk
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
	path       string
	thumb      *thumb
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

// userThumbs son las miniaturas de las imágenes del mensaje, bajo la burbuja.
func (b userBlock) thumbs(width int) [][]string {
	var out [][]string
	for _, c := range b.chips {
		out = append(out, c.thumb.lines(min(28, width-6), 8))
	}
	return out
}

func (b userBlock) imageAt(row, width int) string {
	row -= strings.Count(b.bubble(width), "\n") + 1
	for i, lines := range b.thumbs(width) {
		if row >= 0 && row < len(lines) {
			return b.chips[i].path
		}
		row -= len(lines)
	}
	return ""
}

func (b userBlock) render(width int, _ bool) string {
	out := []string{b.bubble(width)}
	for _, lines := range b.thumbs(width) {
		for _, l := range lines {
			out = append(out, pad+l)
		}
	}
	return strings.Join(out, "\n")
}

func (b userBlock) bubble(width int) string {
	// Lo que pides va en una banda de punta a punta, con la señal › delante.
	text := strings.TrimSpace(imgMarker.ReplaceAllString(b.text, ""))
	limit := max(8, width-8)
	var rows []string
	if text != "" {
		rows = wrapText(text, limit)
	}
	var out []string
	for i, r := range rows {
		lead := "  "
		if i == 0 {
			lead = sAccent.Render(glyphPrompt) + " "
		}
		out = append(out, padRow(lead+sInk.Render(r), pal.surf2, width))
	}
	for i, c := range b.chips {
		lead := "  "
		if i == 0 && len(rows) == 0 {
			lead = sAccent.Render(glyphPrompt) + " "
		}
		out = append(out, padRow(lead+sSoft.Render(ansi.Truncate(c.label(), limit, glyphEllipsis)), pal.surf2, width))
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
	"todo": {"Planificar", "Planificando"}, "ask_user": {"Preguntar", "Preguntando"}, "show_image": {"Mostrar", "Mostrando"},
	"mcp_tools":        {"Cargar MCP", "Cargando MCP"},
	"browser_navigate": {"Abrir", "Abriendo"}, "browser_snapshot": {"Ver página", "Mirando la página"},
	"browser_click": {"Clic en", "Haciendo clic en"}, "browser_type": {"Escribir en", "Escribiendo en"},
	"browser_press_key": {"Pulsar", "Pulsando"}, "browser_scroll": {"Desplazar", "Desplazando"},
	"browser_screenshot": {"Capturar", "Capturando"}, "browser_get_text": {"Leer página", "Leyendo la página"},
	"browser_tabs": {"Pestañas", "Pestañas"}, "browser_wait": {"Esperar", "Esperando"},
	"browser_viewport": {"Tamaño", "Cambiando el tamaño"}, "browser_eval": {"Ejecutar JS", "Ejecutando JS"}, "browser_back": {"Volver", "Volviendo"},
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
	tone         chipTone
	thought      thinkBlock

	result  string
	check   string
	fetch   bool
	command bool
	code    string
	output  []string
	diff    *diffView
	answers *askAnswers
	image   *shownImage
	// live dice si el comando que dejó en segundo plano sigue vivo: mientras
	// lo esté, su marca es ● y no ✓.
	live func() bool
}

// shownImage es la imagen que el agente enseñó con show_image: su miniatura
// va bajo la fila «Mostrar» y un clic la abre en el navegador.
type shownImage struct {
	path, caption string
	thumb         *thumb
}

func (s *shownImage) render(width int) []string {
	if s == nil {
		return nil
	}
	// Una miniatura, no la imagen: 40 columnas por 7 filas como mucho, para
	// que no empuje el turno. «clic la abre» va a la derecha del paso.
	var out []string
	for _, l := range s.thumb.lines(min(40, width-8), 7) {
		out = append(out, pad+l)
	}
	if s.caption != "" {
		out = append(out, pad+sSoft.Render(ansi.Truncate(s.caption, max(8, width-len(pad)-1), glyphEllipsis)))
	}
	return out
}

func (b *toolBlock) imageAt(int, int) string {
	if b.image == nil {
		return ""
	}
	return b.image.path
}

func newToolBlock(e agent.Event, spin *int) *toolBlock {
	v := verbs(e.Tool)
	b := &toolBlock{verb: v[0], gerund: v[1], target: e.Text, meta: e.Meta, spin: spin, state: toolRunning, tone: toneFor(e)}
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
	if e.Tool == "show_image" || b.image != nil {
		// El resultado de show_image es una nota para el modelo («ya la ve»):
		// el usuario ya tiene la miniatura.
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
		// «en marcha» (o que se mandó al fondo) ya lo dicen ● y «en segundo
		// plano»; la fila es para el modelo. Que terminó sí se enseña.
		if status, rest, _ := strings.Cut(body, "\n"); !strings.HasPrefix(status, "terminó") {
			body = rest
		}
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
	if b.agentCommand() {
		return len(b.output) > 0 || hasThought(b.thought)
	}
	return len(b.output) > outputInline || b.diff != nil && b.diff.folds() || hasThought(b.thought)
}

// agentCommand es un comando del agente: plegado enseña solo cómo terminó y,
// si falló, el final de su salida. Los !comandos del usuario se ven enteros.
func (b *toolBlock) agentCommand() bool { return b.command && !b.shell }

// commandStatus es cómo terminó un comando: «exit 0» en verde, el código de
// error en rojo, tiempo agotado o en segundo plano.
func (b *toolBlock) commandStatus() string {
	switch {
	case b.code == "timeout":
		return sWarn.Render("tiempo agotado")
	case b.code == "error":
		return sErr.Render("error")
	case strings.HasPrefix(b.code, "bg:"):
		return sDim.Render("en segundo plano   " + strings.TrimPrefix(b.code, "bg:"))
	case b.code == "0":
		return sOK.Render("exit 0")
	case b.code != "":
		return sErr.Render("exit " + b.code)
	}
	return sDim.Render(firstNonEmpty(b.result, "hecho"))
}

// dot es el estado delante de la etiqueta: el brillo mientras corre, ✓ hecho,
// ✗ fallido, ◌ esperando y − interrumpido.
func (b *toolBlock) dot() string {
	if b.state == toolDone && b.live != nil && b.live() {
		return sAccent.Render(glyphDot)
	}
	return stateMark(b.state, b.spin)
}

func stateMark(state toolState, spin *int) string {
	switch state {
	case toolRunning:
		frame := glyphs.spin[0]
		if spin != nil && !reducedMotion() {
			frame = glyphs.spin[*spin%len(glyphs.spin)]
		}
		if spin == nil {
			frame = glyphDot
		}
		return sAccent.Render(frame)
	case toolWaiting:
		return sWarn.Render(glyphWait)
	case toolFailed:
		return sErr.Render(glyphs.cross)
	case toolStopped:
		return sDim2.Render(glyphMinus)
	}
	return sOK.Render(glyphs.check)
}

// label es la etiqueta de la herramienta: «$» para un comando, el verbo para
// lo demás.
func (b *toolBlock) label() string {
	switch {
	case b.command || b.shell || b.tone == toneCommand:
		return "$"
	case b.fetch:
		return "Fetch"
	}
	return b.verb
}

func (b *toolBlock) header(width int) string {
	left := " " + b.dot() + " " + chip(b.label(), b.tone, b.state == toolRunning)
	if b.target != "" {
		left += " " + sInk.Render(b.target)
	}
	right := ""
	switch {
	case b.state == toolWaiting:
		right = sWarn.Render("espera tu permiso")
		if b.verb == verbs("ask_user")[0] {
			right = sWarn.Render("esperando tus respuestas")
		}
	case b.command && b.state != toolRunning && b.state != toolStopped:
		right = b.commandStatus()
		if b.meta != "" {
			right = joinMeta(right, sDim.Render(b.meta))
		}
	case b.state == toolFailed:
		right = sErr.Render(ansi.Truncate(firstNonEmpty(b.result, "falló"), max(10, width/3), glyphEllipsis))
	case b.counts:
		right = counts(b.adds, b.dels)
	case b.meta != "":
		right = sDim.Render(b.meta)
	}
	return fitRight(left, joinMeta(thoughtMeta(b.thought), right), width)
}

// sub es una fila que cuelga de un paso: dos columnas más adentro.
func sub(text string, width int) string {
	return ansi.Truncate(pad+text, max(1, width-1), glyphEllipsis)
}

// outLine es una fila de la salida de un comando: cuelga del paso con un
// riel fino; outEnd la cierra con └ (cuántas líneas, ctrl+o).
func outLine(text string, width int) string { return sub(sTrack.Render(glyphRail)+" "+text, width) }

func outEnd(text string, width int) string { return sub(sTrack.Render(glyphCorner)+" "+text, width) }

func (b *toolBlock) render(width int, open bool) string {
	out := []string{b.header(width)}
	if open {
		out = append(out, thoughtRows(b.thought, pad, width)...)
	}
	out = append(out, b.answers.render(width)...)
	out = append(out, b.image.render(width)...)
	if b.diff != nil {
		out = append(out, b.diff.render(width, open)...)
	}
	if b.agentCommand() && !open {
		return strings.Join(append(out, b.commandTail(width)...), "\n")
	}
	if len(b.output) > 0 {
		line := func(l string) string { return outLine(sSoft.Render(l), width) }
		if open || len(b.output) <= outputInline {
			for _, l := range b.output {
				out = append(out, line(l))
			}
		} else {
			for _, l := range b.output[:outputHead2] {
				out = append(out, line(l))
			}
			hidden := len(b.output) - outputHead2 - outputTail
			out = append(out, outLine(sDim.Render(fmt.Sprintf("%s %s más   ctrl+o", glyphEllipsis, noun(hidden, "línea", "líneas"))), width))
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

// commandTail es lo que se ve de un comando plegado: nada si fue bien; si
// falló, sus últimas líneas y cuántas hay en total.
func (b *toolBlock) commandTail(width int) []string {
	switch {
	case b.state == toolStopped:
		return []string{sub(sWarn.Render(glyphWarn)+" "+sSoft.Render("interrumpido"), width)}
	case b.state != toolFailed:
		return nil
	}
	var out []string
	tail := b.output[max(0, len(b.output)-outputHead2):]
	for _, l := range tail {
		out = append(out, outLine(sSoft.Render(l), width))
	}
	if len(b.output) > len(tail) {
		out = append(out, outEnd(sDim.Render(noun(len(b.output), "línea", "líneas")+"   ctrl+o"), width))
	}
	if b.check != "" {
		out = append(out, outEnd(sDim.Render(b.check), width))
	}
	return out
}

// footer es lo que queda bajo el paso cuando no cabe a la derecha: lo que
// comprobó después (gofmt…) o que se interrumpió.
func (b *toolBlock) footer(width int) string {
	switch {
	case b.fetch && b.state == toolRunning:
		return sub(sDim.Render("descargando"+glyphEllipsis), width)
	case b.state == toolRunning || b.state == toolWaiting:
		return ""
	case b.state == toolStopped:
		return sub(sWarn.Render(glyphWarn)+" "+sSoft.Render("interrumpido"), width)
	}
	var parts []string
	if !b.command && b.state != toolFailed && b.diff == nil && b.result != "" && b.result != b.meta {
		parts = append(parts, b.result)
	}
	if b.check != "" {
		parts = append(parts, b.check)
	}
	if len(parts) == 0 {
		return ""
	}
	return sub(sDim.Render(strings.Join(parts, "   ")), width)
}

// failRow pinta un fallo dentro de un grupo: el motivo en coral, sin fondo.
func failRow(lead, text string, width int) string {
	room := max(4, width-ansi.StringWidth(lead)-1)
	return lead + sErr.Render(ansi.Truncate(text, room, glyphEllipsis))
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
	spin    *int
}

// Mirar se pliega: terminado, el grupo es una fila tenue «▸ Exploró…» que
// ctrl+o o un clic despliegan.
func (b *readGroupBlock) folds() bool { return !b.live || len(b.items) > 1 }

// readPast es lo que hizo una lectura, en pasado, para la fila plegada.
var readPast = map[string]string{
	"read_file": "Leyó", "outline": "Esquematizó", "read_output": "Leyó la salida de", "search": "Buscó",
	"find_files": "Buscó archivos", "list_files": "Listó", "web_search": "Buscó en la web", "mcp_tools": "Cargó MCP",
}

func (b *readGroupBlock) foldedRow(width int) []string {
	var thoughts []thinkBlock
	for _, it := range b.items {
		thoughts = append(thoughts, it.thought)
	}
	text := glyphs.fold + " " + b.summaryText()
	if len(b.items) == 1 {
		it := b.items[0]
		text = glyphs.fold + " " + firstNonEmpty(readPast[it.tool], verbs(it.tool)[0]) + " " + it.target
	}
	right := sDim.Render(seconds(b.elapsed))
	if len(b.items) == 1 {
		right = sDim.Render(b.items[0].meta)
	}
	if b.folds() {
		right = joinMeta(right, sDim.Render("ctrl+o"))
	}
	out := []string{fitRight(" "+sDim.Render(ansi.Truncate(text, max(10, width-24), glyphEllipsis)), joinMeta(thoughtMeta(thoughts...), right), width)}
	for _, it := range b.items {
		if it.failed {
			out = append(out, failedStep(chip(verbs(it.tool)[0], toneRead, false), it.target, it.summary, width))
		}
	}
	return out
}

// failedStep es un paso que falló dentro de un grupo plegado: nunca se pliega.
func failedStep(label, target, reason string, width int) string {
	left := pad + stateMark(toolFailed, nil) + " " + label + " " + sBeige.Render(target)
	return fitRight(left, sErr.Render(ansi.Truncate(reason, max(10, width/3), glyphEllipsis)), width)
}

// summaryText es «Exploró 2 archivos · 3 búsquedas».
func (b *readGroupBlock) summaryText() string {
	files, other := 0, 0
	var searches []string
	for _, it := range b.items {
		switch it.tool {
		case "read_file", "outline", "read_output":
			files++
		case "search", "find_files", "web_search", "list_files":
			searches = append(searches, it.target)
		default:
			other++
		}
	}
	var parts []string
	if files > 0 {
		parts = append(parts, "leyó "+noun(files, "archivo", "archivos"))
	}
	switch {
	case len(searches) == 1 && searches[0] != "":
		what := ansi.Truncate(searches[0], 40, glyphEllipsis)
		if !strings.HasPrefix(what, "«") {
			what = "«" + what + "»"
		}
		parts = append(parts, "buscó "+what)
	case len(searches) > 0:
		parts = append(parts, "hizo "+noun(len(searches), "búsqueda", "búsquedas"))
	}
	if other > 0 {
		parts = append(parts, "hizo "+noun(other, "consulta", "consultas"))
	}
	text := "Exploró"
	switch len(parts) {
	case 0:
	case 1:
		text = parts[0]
	default:
		text = strings.Join(parts[:len(parts)-1], ", ") + " y " + parts[len(parts)-1]
	}
	r := []rune(text)
	return strings.ToUpper(string(r[0])) + string(r[1:])
}

func (b *readGroupBlock) render(width int, open bool) string {
	if !b.live && !open {
		return strings.Join(b.foldedRow(width), "\n")
	}
	if len(b.items) == 1 && b.live {
		it := b.items[0]
		state := toolDone
		if it.failed {
			state = toolFailed
		}
		left := " " + stateMark(state, nil) + " " + chip(verbs(it.tool)[0], toneRead, false) + " " + sBeige.Render(it.target)
		out := []string{fitRight(left, joinMeta(thoughtMeta(it.thought), sDim.Render(it.meta)), width)}
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
	summary := sInk.Render(strings.Join(parts, ", "))
	state := toolDone
	if failed > 0 {
		state = toolFailed
		summary += sErr.Render(" " + glyphSep + " " + noun(failed, "error", "errores"))
	}
	verb := "Exploró"
	if b.live {
		last := b.items[len(b.items)-1]
		verb, state = "Explorando", toolRunning
		summary += sDim2.Render("  "+glyphSep+"  ") + sSoft.Render(verbs(last.tool)[0]) + " " + sBeige.Render(last.target)
	}
	var thoughts []thinkBlock
	for _, it := range b.items {
		thoughts = append(thoughts, it.thought)
	}
	head := " " + stateMark(state, b.spin) + " " + chip(verb, toneRead, b.live) + " " + summary
	meta := joinMeta(thoughtMeta(thoughts...), sDim.Render(seconds(b.elapsed)))
	if !b.live {
		fold := glyphs.fold
		if open {
			fold = glyphs.unfold
		} else {
			meta = sDim.Render("ctrl+o")
		}
		head = " " + sDim.Render(fold+" "+b.summaryText())
	}
	out := []string{fitRight(head, meta, width)}
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
	return !b.live || len(b.steps) > 1 || slices.ContainsFunc(b.thoughts, hasThought)
}

// stepWords son los verbos de los pasos, sin repetir: «abrir, clic en, capturar».
func (b *browserBlock) stepWords() string {
	var words []string
	for _, s := range b.steps {
		if w := strings.ToLower(s.verb); !slices.Contains(words, w) {
			words = append(words, w)
		}
	}
	if len(words) > 4 {
		words = append(words[:4], glyphEllipsis)
	}
	return strings.Join(words, ", ")
}

func (b *browserBlock) foldedRow(width int, mark string) []string {
	text := mark + " Navegador " + glyphSep + " "
	if len(b.steps) == 1 {
		text += b.steps[0].verb + " " + b.steps[0].target
	} else {
		text += fmt.Sprintf("%d pasos: %s", len(b.steps), b.stepWords())
	}
	right := ""
	if t := seconds(time.Duration(b.secs * float64(time.Second))); t != "" {
		right = sDim2.Render(t)
	}
	style := sDim2
	if mark == glyphs.unfold {
		style = sDim
	}
	return []string{fitRight(" "+style.Render(ansi.Truncate(text, max(10, width-24), glyphEllipsis)), joinMeta(thoughtMeta(b.thoughts...), right), width)}
}

func (b *browserBlock) render(width int, open bool) string {
	if !b.live && !open {
		out := b.foldedRow(width, glyphs.fold)
		for _, s := range b.steps {
			if s.state == toolFailed {
				out = append(out, failedStep(chip("Navegador", toneBrowser, false)+" "+sInk.Render(s.verb), s.target, s.result, width))
			}
		}
		return strings.Join(out, "\n")
	}
	if !b.live {
		out := b.foldedRow(width, glyphs.unfold)
		return strings.Join(append(out, b.stepRows(width)...), "\n")
	}
	cur := b.last()
	verb := cur.verb
	if cur.state == toolRunning {
		verb = cur.gerund
	}
	left := " " + cur.dot() + " " + chip("Navegador", toneBrowser, cur.state == toolRunning) + " " +
		sInk.Render(verb)
	if cur.target != "" {
		left += "  " + sBeige.Render(cur.target)
	}
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
	out := []string{fitRight(left, joinMeta(thoughtMeta(b.thoughts...), right), width)}
	if !open {
		// Mientras corre solo se ve el paso en curso; su «└ Abrí…» repetiría
		// la fila, así que solo sale si falló.
		if cur.state == toolFailed {
			if footer := cur.footer(width); footer != "" {
				out = append(out, footer)
			}
		}
		return strings.Join(out, "\n")
	}
	return strings.Join(append(out, b.stepRows(width)...), "\n")
}

func (b *browserBlock) stepRows(width int) []string {
	var out []string
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
	return out
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
	left := " " + stateMark(toolDone, nil) + " " + chip("Tareas", toneOther, false) + " " + sInk.Render(fmt.Sprintf("%d de %d", done, len(b.items)))
	out := []string{left}
	for _, it := range b.items {
		var row string
		switch it.Status {
		case "done":
			row = sDim.Render(glyphDone + " " + it.Text)
		case "doing":
			row = sAccent.Render(glyphDoing) + " " + sInk.Render(it.Text)
		default:
			row = sSoft.Render(glyphTodo + " " + it.Text)
		}
		out = append(out, sub(row, width))
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
	// bare: la respuesta de un turno con riel va sin ◆; la cabecera ya lo lleva.
	bare bool
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
		switch {
		case i == 0 && !b.bare:
			lines[i] = mark(glyphBrand, sAccent) + l
		case b.bare:
			// Tras ┗, la respuesta va fuera del riel, dos columnas adentro.
			lines[i] = "  " + l
		default:
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
		// El título en tinta clara con una raya hasta el borde: sin negrita.
		rule := max(0, min(48, width-ansi.StringWidth(b.title)-len(pad)-2))
		out = append(out, mark(glyphDot, sDim)+sInk.Render(b.title)+" "+sTrack.Render(strings.Repeat(glyphs.rule, rule)))
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

// meter es la barra de cells celdas: lo usado en tinta, grueso, sobre una
// pista fina. El aviso lo da el color del número, no la barra.
func meter(pct float64, cells int) string {
	pct = max(0, min(100, pct))
	filled := int(pct*float64(cells)/100 + 0.5)
	return sInk.Render(strings.Repeat(glyphMeterOn, filled)) + sTrack.Render(strings.Repeat(glyphMeterOff, cells-filled))
}
