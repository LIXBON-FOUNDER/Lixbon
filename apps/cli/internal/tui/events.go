package tui

import (
	"lixbon.com/cli/internal/agent"
)

// handleEvent convierte los eventos del agente en bloques. Las acciones se
// emparejan con su resultado por orden: el bucle ejecuta una herramienta
// detrás de otra, pero no todas tienen resultado (las de solo lectura llegan
// ya hechas, y una cancelación deja la última sin cerrar).
func (m *Model) handleEvent(e agent.Event) {
	m.flushLive()
	if e.Kind == agent.EventStep {
		return
	}
	m.live.usedTools = true
	switch e.Kind {
	case agent.EventNote, agent.EventRescued:
		m.closeReads()
		m.add(note(e.Text))
	case agent.EventReadGroup:
		m.closeTool(toolDone)
		for _, name := range e.Names {
			m.addRead(readItem{tool: e.Tool, target: name})
		}
	case agent.EventAction:
		m.closeTool(toolDone)
		if e.ReadOnly && e.Tool != "ask_user" {
			m.addRead(readItem{tool: e.Tool, target: e.Text, meta: e.Meta})
			return
		}
		m.closeReads()
		b := newToolBlock(e, &m.spin)
		entry := m.add(b)
		if e.ReadOnly {
			b.state = toolDone
			m.refresh(entry)
			return
		}
		m.openTool = entry
	case agent.EventActionResult:
		switch {
		case m.openTool != nil:
			m.openTool.b.(*toolBlock).finish(e)
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

func (m *Model) addRead(it readItem) {
	if m.readGroup == nil {
		m.readGroup = m.add(&readGroupBlock{items: []readItem{it}})
		return
	}
	g := m.readGroup.b.(*readGroupBlock)
	g.items = append(g.items, it)
	m.refresh(m.readGroup)
}

// closeReads termina el grupo de lecturas en curso: lo siguiente que se lea
// empieza otro.
func (m *Model) closeReads() { m.readGroup = nil }

// closeTool cierra la herramienta que se quedó sin resultado.
func (m *Model) closeTool(state toolState) {
	if m.openTool == nil {
		return
	}
	if b := m.openTool.b.(*toolBlock); b.state == toolRunning || b.state == toolWaiting {
		b.state = state
		m.refresh(m.openTool)
	}
	m.openTool = nil
}

// setToolState marca la herramienta abierta (p. ej. esperando aprobación).
func (m *Model) setToolState(state toolState) {
	if m.openTool == nil {
		return
	}
	m.openTool.b.(*toolBlock).state = state
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
	m.closeReads()
	m.todoEntry, m.todoTurn = m.add(&todoBlock{items: items}), m.turn
}

// gap deja una fila en blanco antes de un bloque, sin duplicarla.
func (m *Model) gap() {
	n := len(m.log.entries)
	if n == 0 {
		return
	}
	if last := m.log.entries[n-1]; last.text == "" {
		return
	}
	m.print("")
}
