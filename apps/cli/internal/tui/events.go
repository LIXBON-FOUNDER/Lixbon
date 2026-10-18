package tui

import (
	"strings"

	"lixbon.com/cli/internal/agent"
	"lixbon.com/cli/internal/toolspec"
)

// handleEvent convierte los eventos del agente en bloques. Las acciones se
// emparejan con su resultado por orden: el bucle ejecuta una herramienta
// detrás de otra, pero no todas tienen resultado (las de solo lectura llegan
// ya hechas, y una cancelación deja la última sin cerrar).
func (m *Model) handleEvent(e agent.Event) {
	thought := m.takeThought(e)
	m.flushLive()
	m.autoCompacting = e.Compacting
	if e.Kind == agent.EventStep {
		return
	}
	m.live.usedTools = true
	if e.Kind == agent.EventNote || e.Kind == agent.EventRescued {
		m.closeGroups()
		if m.turnHead != nil {
			m.addOutside(systemBlock(e.Text))
		} else {
			m.add(note(e.Text))
		}
		return
	}
	m.openRail()
	m.countStep(e)
	switch e.Kind {
	case agent.EventReadGroup:
		m.closeTool(toolDone)
		m.closeBrowser()
		for i, name := range e.Names {
			it := readItem{tool: e.Tool, target: name}
			if i == 0 {
				it.thought = thought
			}
			m.addRead(it)
		}
	case agent.EventAction:
		m.closeTool(toolDone)
		if toolspec.IsBrowser(e.Tool) {
			m.addBrowserStep(e, thought)
			return
		}
		m.closeBrowser()
		if e.ReadOnly && e.Tool != "ask_user" {
			m.addRead(readItem{tool: e.Tool, target: e.Text, meta: e.Meta, thought: thought})
			return
		}
		m.closeReads()
		b := newToolBlock(e, &m.spin)
		b.thought = thought
		entry := m.add(b)
		if e.Tool == "ask_user" {
			m.askEntry = entry
		}
		if e.ReadOnly {
			b.state = toolDone
			m.refresh(entry)
			return
		}
		m.openTool = entry
	case agent.EventActionResult:
		switch {
		case m.openTool != nil:
			m.currentTool().finish(e)
			if g, ok := m.openTool.b.(*browserBlock); ok {
				g.secs += e.Elapsed.Seconds()
			}
			m.refresh(m.openTool)
			m.openTool = nil
		case m.readGroup != nil && e.Failed:
			g := m.readGroup.b.(*readGroupBlock)
			last := &g.items[len(g.items)-1]
			last.failed, last.summary = true, e.Summary
			m.refresh(m.readGroup)
		default:
			m.add(note(e.Summary))
		}
	}
}

// takeThought aparta lo pensado antes de una acción: se guarda en ella (su
// «✦ 1,2 s»; ctrl+o lo enseña) en vez de como otra fila «Pensó».
func (m *Model) takeThought(e agent.Event) thinkBlock {
	live := &m.live
	if e.Kind != agent.EventReadGroup && e.Kind != agent.EventAction || live.answer != nil || m.liveProse() != "" {
		return thinkBlock{}
	}
	t := joinThoughts(m.pendingThought, thinkBlock{text: strings.TrimSpace(live.reasoning.String()), secs: live.reasoningSecs})
	m.pendingThought = thinkBlock{}
	live.reasoning.Reset()
	live.reasoningSecs = 0
	return t
}

// joinThoughts junta lo pensado en varios trozos del mismo paso.
func joinThoughts(a, b thinkBlock) thinkBlock {
	switch {
	case !hasThought(a):
		return b
	case !hasThought(b):
		return a
	}
	return thinkBlock{text: a.text + "\n\n" + b.text, secs: a.secs + b.secs}
}

func (m *Model) addRead(it readItem) {
	if m.readGroup == nil {
		m.readGroup = m.add(&readGroupBlock{items: []readItem{it}, live: true, spin: &m.spin})
		return
	}
	g := m.readGroup.b.(*readGroupBlock)
	g.items = append(g.items, it)
	m.refresh(m.readGroup)
}

// addBrowserStep suma la acción al grupo del navegador en curso, que la
// enseña en su única fila.
func (m *Model) addBrowserStep(e agent.Event, thought thinkBlock) {
	m.closeReads()
	step := newToolBlock(e, &m.spin)
	if e.ReadOnly {
		step.state = toolDone
	}
	if m.browserGroup == nil {
		m.browserGroup = m.add(&browserBlock{live: true, steps: []*toolBlock{step}, thoughts: []thinkBlock{thought}})
	} else {
		g := m.browserGroup.b.(*browserBlock)
		g.steps = append(g.steps, step)
		g.thoughts = append(g.thoughts, thought)
		m.refresh(m.browserGroup)
	}
	m.openTool = m.browserGroup
}

// currentTool es la herramienta en marcha: un bloque propio o el último paso
// del grupo del navegador.
func (m *Model) currentTool() *toolBlock {
	if m.openTool == nil {
		return nil
	}
	switch b := m.openTool.b.(type) {
	case *toolBlock:
		return b
	case *browserBlock:
		return b.last()
	}
	return nil
}

// closeReads termina el grupo de lecturas en curso: lo siguiente que se lea
// empieza otro.
func (m *Model) closeReads() {
	if m.readGroup != nil {
		m.readGroup.b.(*readGroupBlock).live = false
		m.refresh(m.readGroup)
		m.readGroup = nil
	}
}

func (m *Model) closeBrowser() {
	if m.browserGroup != nil {
		m.browserGroup.b.(*browserBlock).live = false
		m.refresh(m.browserGroup)
		m.browserGroup = nil
	}
}

func (m *Model) closeGroups() {
	m.closeReads()
	m.closeBrowser()
}

// closeTool cierra la herramienta que se quedó sin resultado.
func (m *Model) closeTool(state toolState) {
	b := m.currentTool()
	if b == nil {
		return
	}
	if b.state == toolRunning || b.state == toolWaiting {
		b.state = state
		m.refresh(m.openTool)
	}
	m.openTool = nil
}

// setToolState marca la herramienta abierta (p. ej. esperando aprobación).
func (m *Model) setToolState(state toolState) {
	b := m.currentTool()
	if b == nil {
		return
	}
	b.state = state
	m.refresh(m.openTool)
}

// printTodo mantiene un bloque de plan por turno y lo actualiza en su sitio.
func (m *Model) printTodo(items, _ []todoItem) {
	m.todo = items
	if m.todoEntry != nil && m.todoTurn == m.turn && m.running {
		m.todoEntry.b.(*todoBlock).items = items
		m.refresh(m.todoEntry)
		return
	}
	m.closeGroups()
	m.todoEntry, m.todoTurn = m.add(&todoBlock{items: items}), m.turn
}

// gap deja una fila en blanco antes de un bloque, sin duplicarla.
func (m *Model) gap() {
	n := len(m.log.entries)
	if n == 0 {
		return
	}
	if last := m.log.entries[n-1]; last.text == "" || last.b == block(textBlock("")) {
		return
	}
	m.print("")
}
