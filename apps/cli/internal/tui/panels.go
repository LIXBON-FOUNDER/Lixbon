package tui

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"lixbon.com/cli/internal/api"
	"lixbon.com/cli/internal/chat"
	"lixbon.com/cli/internal/session"
)

// ── modelo ───────────────────────────────────────────────────────────────

// effortOrder son los niveles por los que pasan ←→, de menos a más.
func effortOrder(graded bool) []string {
	return effortLevels(graded)[1:]
}

// effectiveEffort es el nivel que se usa de verdad: en auto, agent y plan
// piden el máximo.
func (m *Model) effectiveEffort(level, model string) string {
	if level != "" {
		return level
	}
	order := effortOrder(m.graded(model))
	if m.chat.Mode == chat.ModeAgent || m.chat.Session.PlanMode {
		return order[len(order)-1]
	}
	return ""
}

// effortBarsIn es effortBars con los tramos encendidos en el estilo dado.
func effortBarsIn(on, of int, style lipgloss.Style) string {
	var b strings.Builder
	for i := range of {
		if i < on {
			b.WriteString(style.Render(glyphMeterOn + glyphMeterOn + " "))
		} else {
			b.WriteString(sTrack.Render(glyphMeterOff + glyphMeterOff + " "))
		}
	}
	return b.String()
}

// modelPicker es el selector de modelo: cada fila con su esfuerzo en tramos
// (←→ lo cambia) y su ventana de contexto; debajo, el detalle del elegido y
// el cupo de la cuenta.
func (m *Model) modelPicker(models []api.Model) *picker {
	byID := map[string]api.Model{}
	efforts := map[string]string{}
	options := make([]option, 0, len(models))
	cursor := 0
	for i, mod := range models {
		byID[mod.ID] = mod
		o := option{Label: mod.Name, Value: mod.ID}
		if mod.NumCtx > 0 {
			o.Meta = sDim.Render(fmtContext(mod.NumCtx))
		}
		if mod.ID == m.chat.Model {
			cursor = i
			efforts[mod.ID] = m.chat.Effort
		}
		options = append(options, o)
	}
	thinks := func(id string) bool {
		mod, ok := byID[id]
		return !ok || mod.Capabilities == nil || mod.HasCapability("thinking")
	}
	p := newPicker("Modelo", options, func(value string, cancelled bool) tea.Cmd {
		if cancelled {
			return nil
		}
		m.chooseModel(value)
		if level, ok := efforts[value]; ok && thinks(value) && level != m.chat.Effort {
			m.chat.SetEffort(level)
		}
		return nil
	})
	p.search, p.noNumbers, p.cursor = true, true, cursor
	p.lead = func(o option, on bool) string {
		if !thinks(o.Value) {
			return sTrack.Render(fmt.Sprintf("%-9s", "—")) + "  " + strings.Repeat(" ", 9)
		}
		level := m.effectiveEffort(efforts[o.Value], o.Value)
		lit, of := effortSteps(level, m.graded(o.Value))
		style, label := sSoft, sDim
		if on {
			style, label = sAccent, sInk
		}
		bars := effortBarsIn(lit, of, style)
		bars += strings.Repeat(" ", max(0, 9-ansi.StringWidth(bars)))
		return bars + "  " + label.Render(fmt.Sprintf("%-9s", effortNames[level]))
	}
	p.onKey = func(p *picker, msg tea.KeyPressMsg) (tea.Cmd, bool, bool) {
		dir := 0
		switch msg.String() {
		case "left":
			dir = -1
		case "right":
			dir = 1
		default:
			return nil, false, false
		}
		opts := p.visible()
		if p.cursor >= len(opts) || !thinks(opts[p.cursor].Value) {
			return nil, true, false
		}
		id := opts[p.cursor].Value
		order := effortOrder(m.graded(id))
		i := max(0, slices.Index(order, m.effectiveEffort(efforts[id], id)))
		efforts[id] = order[max(0, min(len(order)-1, i+dir))]
		return nil, true, false
	}
	p.foot = func(o option, inner int) []string {
		mod := byID[o.Value]
		head := "  " + sInk.Render(firstNonEmpty(mod.Name, o.Value))
		if mod.ID != "" && mod.ID != mod.Name {
			head += sDim.Render("   " + mod.ID)
		}
		out := []string{head}
		var caps []string
		if mod.HasCapability("vision") {
			caps = append(caps, "ve imágenes")
		}
		if mod.HasCapability("tools") {
			caps = append(caps, "usa herramientas")
		}
		if mod.HasCapability("thinking") {
			if n := len(effortOrder(m.graded(mod.ID))); n > 2 {
				caps = append(caps, fmt.Sprintf("razona en %d niveles", n))
			} else {
				caps = append(caps, "razona")
			}
		}
		if len(caps) > 0 {
			out = append(out, "  "+sSoft.Render(strings.Join(caps, "      ")))
		}
		if q := m.quota; q != nil && !m.chat.Client.Generic {
			row := "  "
			for _, b := range []struct {
				name string
				b    api.Bucket
			}{{"sesión", q.session}, {"semana", q.week}} {
				if b.b.Unlimited {
					continue
				}
				pct := min(100, b.b.Percent)
				row += sDim.Render(b.name+"  ") + meter(pct, 16) + "  " + pctStyle(pct).Render(fmt.Sprintf("%.0f %%", pct)) + "        "
			}
			if strings.TrimSpace(row) != "" {
				out = append(out, "", strings.TrimRight(row, " "))
			}
		}
		return out
	}
	p.keys = [][2]string{{"↑↓", "mover"}, {"←→", "esfuerzo"}, {"enter", "usar"}, {"esc", "cerrar"}}
	return p
}

// ── conversaciones ───────────────────────────────────────────────────────

// dayGroup es el grupo de una fecha en /history: hoy, ayer, esta semana o
// antes.
func dayGroup(now, ts time.Time) string {
	y1, m1, d1 := now.Date()
	today := time.Date(y1, m1, d1, 0, 0, 0, 0, now.Location())
	switch {
	case !ts.Before(today):
		return "hoy"
	case !ts.Before(today.AddDate(0, 0, -1)):
		return "ayer"
	case !ts.Before(today.AddDate(0, 0, -6)):
		return "esta semana"
	}
	return "antes"
}

var weekdays = []string{"dom", "lun", "mar", "mié", "jue", "vie", "sáb"}
var months = []string{"ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"}

// whenLabel es cuándo, como lo enseña /history: «hace 2 h» hoy, la hora ayer
// y el día de la semana o la fecha antes.
func whenLabel(now, ts time.Time) string {
	switch dayGroup(now, ts) {
	case "hoy":
		return session.RelativeTime(float64(now.Unix()), float64(ts.Unix()))
	case "ayer":
		return ts.Format("15:04")
	case "esta semana":
		return fmt.Sprintf("%s %d", weekdays[ts.Weekday()], ts.Day())
	}
	return fmt.Sprintf("%d %s", ts.Day(), months[ts.Month()-1])
}

// historyOptions agrupa las conversaciones por día, con cuántos mensajes
// tienen, el modelo y cuándo.
func (m *Model) historyOptions(items []session.Header, all bool) []option {
	now := time.Now()
	var options []option
	group := ""
	for _, item := range items {
		ts := time.Unix(int64(item.UpdatedAt), 0)
		if g := dayGroup(now, ts); g != group {
			group = g
			options = append(options, option{Label: g, Disabled: true})
		}
		title := firstNonEmpty(item.Title, "Sin título")
		if r := []rune(title); len(r) > 60 {
			title = string(r[:60]) + glyphEllipsis
		}
		desc := fmt.Sprintf("%-14s", noun(item.Messages, "mensaje", "mensajes"))
		if item.Model != "" {
			desc += m.modelLabel(item.Model)
		}
		o := option{Label: title, Value: item.ID, Desc: desc, Meta: sDim.Render(whenLabel(now, ts))}
		if all {
			o.Meta = sDim.Render(filepath.Base(item.Workspace) + "   " + whenLabel(now, ts))
		}
		if item.ID == m.chat.ConversationID {
			o.Badge = "actual"
		}
		options = append(options, o)
	}
	return options
}

// ── procesos ─────────────────────────────────────────────────────────────

// procTail son las últimas n líneas de la salida de un proceso.
func (m *Model) procTail(id string, n int) []string {
	bg, ok := m.chat.Toolbox.Procs.Get(id)
	if !ok {
		return nil
	}
	var lines []string
	for _, l := range strings.Split(strings.TrimRight(ansi.Strip(bg.Tail()), "\n"), "\n") {
		if l = strings.TrimRight(l, " \r"); l != "" {
			lines = append(lines, strings.ReplaceAll(l, "\t", "    "))
		}
	}
	return lines[max(0, len(lines)-n):]
}

// ── uso ──────────────────────────────────────────────────────────────────

// serviceNames son los servicios del panal, como se enseñan.
var serviceNames = map[string]string{"cli": "cli", "ide": "ide", "mobile": "móvil", "web": "web", "other": "otros"}

// usageLines es el panel de /usage: el cupo de la sesión y de la semana, el
// contexto de esta conversación y, de la semana, qué parte gastó cada
// servicio. En un panel estrecho (el menú del plan) la nota va debajo de su
// barra en vez de al lado.
func usageLines(u api.Usage, ctxPct float64, ctxTokens, ctxWindow int, now time.Time, width int) []string {
	const label, pctCol, noteCol = 10, 6, 34
	narrow := width < label+16+pctCol+2+noteCol
	cells := 36
	if narrow {
		cells = max(8, min(36, width-label-pctCol-2))
	}
	var out []string
	add := func(name string, pct float64, note string, share bool) {
		pct = max(0, min(100, pct))
		text := fmt.Sprintf("%.0f %%", pct)
		style := pctStyle(pct)
		if share {
			// Una parte del total no es un aviso: nunca en ámbar ni coral.
			style = sSoft
		}
		line := sDim.Render(fmt.Sprintf("%-*s", label, name)) + meter(pct, cells) + "  " + style.Render(text)
		switch {
		case note == "":
		case narrow:
			out = append(out, line)
			line = strings.Repeat(" ", label) + sDim.Render(note)
		default:
			line += strings.Repeat(" ", max(2, 8-len(text))) + sDim.Render(note)
		}
		out = append(out, line)
	}
	for _, b := range []struct {
		label  string
		bucket api.Bucket
	}{{"sesión", u.Buckets.Session}, {"semana", u.Buckets.Week}} {
		if b.bucket.Unlimited {
			out = append(out, sDim.Render(fmt.Sprintf("%-10s", b.label))+sSoft.Render("ilimitado"))
			continue
		}
		note := ""
		if when := api.ResetIn(b.bucket.ResetAt, now); when != "" {
			note = "se renueva " + when
		} else if b.bucket.ResetAt == "" && b.bucket.Percent == 0 {
			note = "empieza con tu próximo mensaje"
		}
		add(b.label, b.bucket.Percent, note, false)
	}
	if ctxTokens > 0 {
		note := fmtTokens(ctxTokens) + " en esta conversación"
		if ctxWindow > 0 {
			note = fmtTokens(ctxTokens) + " de " + fmtTokens(ctxWindow) + " en esta conversación"
		}
		add("contexto", ctxPct, note, false)
	}
	since := now.AddDate(0, 0, -6).Format("2006-01-02")
	totals := map[string]int{}
	sum := 0
	for _, d := range u.Services {
		if d.Date >= since {
			totals[d.Service] += d.Tokens
			sum += d.Tokens
		}
	}
	if sum > 0 {
		out = append(out, "", sDim.Render("Esta semana, por servicio"), "")
		for _, s := range []string{"cli", "ide", "mobile", "web", "other"} {
			if totals[s] > 0 {
				add(serviceNames[s], float64(totals[s])*100/float64(sum), fmtTokens(totals[s])+" tokens", true)
			}
		}
	}
	return out
}
