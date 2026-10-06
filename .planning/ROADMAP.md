# Roadmap: Lixbon CLI — migración gradual de Python a Go

## Overview

De una referencia Python reproducible a un binario Go aceptado por plataforma, mediante chat --once, agente/workspace y funciones conectadas. Go está elegido; Rust opcional no bloquea las fases. Todas las fases están pendientes y no autorizan publicación automática.

**Granularity**: standard como calibración de planificación (config.json no define granularity).
**Phase ID convention**: sequential por defecto (config.json no define phase_id_convention).

## Phases

- [ ] **Phase 1: Contratos y línea base reproducible** - El usuario puede identificar qué comportamientos se conservarán, qué destinos se soportarán y cómo comprobar equivalencia con Python.
- [ ] **Phase 2: Chat Go usable y cancelable** - El usuario puede ejecutar un primer chat --once Go compatible con el gateway y cancelarlo sin esperar nuevos eventos.
- [ ] **Phase 3: Agente, herramientas y estado compatibles** - El usuario puede trabajar sobre su workspace con el agente Go, aprobaciones y sesiones preservadas sin recursos ilimitados.
- [ ] **Phase 4: Terminal interactiva y funciones conectadas** - El usuario puede completar los flujos interactivos, documentales, MCP y remotos que ofrece el cliente Python.
- [ ] **Phase 5: Distribución, actualización y sustitución aceptada** - El usuario instala y actualiza binarios auténticos sin Python/pip, con recuperación y paridad aceptada por plataforma.

## Phase Details

### Phase 1: Contratos y línea base reproducible

**Goal**: El usuario puede identificar qué comportamientos se conservarán, qué destinos se soportarán y cómo comprobar equivalencia con Python.
**Depends on**: Nothing (first phase)
**Requirements**: BASE-01, BASE-02, BASE-03, BASE-04
**Success Criteria** (what must be TRUE):

1. El mantenedor puede repetir la línea base Python con entorno fijado y consultar la clasificación de los dos fallos históricos, sin tratar el 131/2 previo como ejecución nueva. (BASE-01)
2. El usuario puede consultar inventario completo de comandos/slash commands/20 herramientas y corpus portable de payloads, SSE, parsing, errores y cancelación, sin depender del código desktop. (BASE-02)
3. El usuario puede saber qué OS/arquitecturas/terminales se soportan, qué permite la política CGO y qué helpers necesita cada función; el inventario aclara la contradicción del README. (BASE-03)
4. El usuario dispone de escenarios y criterios acordados para medir Python y Go de forma equivalente, con limitaciones y entorno explícitos. (BASE-04)

**Plans**: 4 plans

Plans:
- [ ] 01-01-PLAN.md — Referencia offline y diagnóstico de input-box (ola 1)
- [ ] 01-02-PLAN.md — Inventario y corpus portable Python/Node (ola 2)
- [ ] 01-03-PLAN.md — Matriz de destinos y helpers (ola 2)
- [ ] 01-04-PLAN.md — Mediciones y aceptación explícita (ola 3)

### Phase 2: Chat Go usable y cancelable

**Goal**: El usuario puede ejecutar un primer chat --once Go compatible con el gateway y cancelarlo sin esperar nuevos eventos.
**Depends on**: Phase 1
**Requirements**: CHAT-01, CHAT-02, CHAT-03, CHAT-04, CHAT-05
**Success Criteria** (what must be TRUE):

1. En cada destino acordado, el usuario ejecuta status, models y chat --once con flags/salida/códigos compatibles, configura su cuenta y observa identidad de API key y protección de credenciales conservadas. (CHAT-01, CHAT-02)
2. El chat envía los campos del contrato y distingue cuota, autenticación y offline sin duplicar POST por reintentos automáticos. (CHAT-03)
3. El usuario recibe contenido, razonamiento, fuentes, tool-call deltas y uso correctos con eventos fragmentados, UTF-8, CRLF, keepalives y campos nuevos; distingue [DONE] de error. (CHAT-04)
4. El usuario cancela incluso SSE silencioso y sale por --once dentro del límite acordado, con recursos cerrados. (CHAT-05)

**Plans**: TBD

### Phase 3: Agente, herramientas y estado compatibles

**Goal**: El usuario puede trabajar sobre su workspace con el agente Go, aprobaciones y sesiones preservadas sin recursos ilimitados.
**Depends on**: Phase 2
**Requirements**: AGNT-01, AGNT-02, TOOL-01, TOOL-02, TOOL-03, WORK-01, STATE-01, STATE-02, BOUND-01, BOUND-02
**Success Criteria** (what must be TRUE):

1. El usuario completa turnos con los 20 schemas, llamadas nativas/textuales validadas, IDs/orden, rescate de razonamiento, límites de pasos/repetición y contexto coherente. (AGNT-01, AGNT-02, TOOL-01)
2. El usuario aprueba shell/edición/efectos externos y usa /plan, /diff, snapshots, /undo, /commit y verificadores; rutas con Unicode/espacios/symlinks permanecen dentro de la política acordada. (TOOL-02, TOOL-03)
3. El usuario conserva directorio, /workspace, LIXBON.md, comandos con $ARGUMENTS y búsquedas acotadas con índice actualizado y fallback sin rg. (WORK-01)
4. El usuario abre configuración/sesiones Python con BOM/campos desconocidos, respaldo y compatibilidad; dos CLI guardan sin perder entradas del índice y muestran retención de 200 sesiones. (STATE-01, STATE-02)
5. El usuario lee rangos y ejecuta búsqueda/shell con límites y truncamiento visibles; cancelación/salida termina árboles de procesos y drena salida sin consumo ilimitado. (BOUND-01, BOUND-02)

**Plans**: TBD

### Phase 4: Terminal interactiva y funciones conectadas

**Goal**: El usuario puede completar los flujos interactivos, documentales, MCP y remotos que ofrece el cliente Python.
**Depends on**: Phase 3
**Requirements**: TERM-01, TERM-02, DOC-01, DOC-02, MCP-01, REMOTE-01, CONNECT-01
**Success Criteria** (what must be TRUE):

1. El usuario abre chat sin comando, usa aliases/subcomandos/slash commands completos y mantiene entrada en cola, Markdown/transcript y scrollback utilizables al redimensionar o recibir respuestas largas en terminales acordadas. (TERM-01, TERM-02)
2. El usuario adjunta texto/PDF/Word/imágenes con límites/orden/errores compatibles y extracción local declarada, usa portapapeles por OS, Visuals y delegación; conoce las funciones pendientes en beta. (DOC-01, DOC-02)
3. El usuario conecta servidores MCP con configuración/precedencia/nombres existentes, negociación, listado paginado y errores aislados de servidor. (MCP-01)
4. Desde móvil, el usuario recibe eventos y aprobaciones compatibles, cancela independientemente del SSE y recupera estado con snapshot sin promesa de entrega exactamente una vez. (REMOTE-01)
5. El usuario conserva aprobaciones de efectos externos y puede cerrar MCP/remoto bloqueados sin streams ni procesos abandonados. (CONNECT-01)

**Plans**: TBD
**UI hint**: yes

### Phase 5: Distribución, actualización y sustitución aceptada

**Goal**: El usuario instala y actualiza binarios auténticos sin Python/pip, con recuperación y paridad aceptada por plataforma.
**Depends on**: Phase 4
**Requirements**: REL-01, REL-02, REL-03, REL-04, REL-05
**Success Criteria** (what must be TRUE):

1. En cada destino acordado, el usuario instala el artefacto correspondiente desde distribución gateway/release y Docker cuando aplique, y ejecuta el núcleo sin Python/pip con helpers explícitos y evidencia de CI/instalación. (REL-01, REL-04)
2. El usuario verifica autenticidad/integridad y rechaza artefactos alterados o para otra plataforma antes de reemplazar su cliente. (REL-02)
3. El usuario actualiza desde Python o un binario previo, incluido Windows en uso, y conserva cliente usable/rollback ante fallo de descarga o reemplazo. (REL-03)
4. El usuario revisa matriz completa de paridad y evidencia de terminal, documentos, MCP, remoto y medidas equivalentes antes de aceptar cutover; Python sigue disponible hasta dicha aceptación. (REL-05)

**Plans**: TBD

## Acceptance Gates

- Phase 1 fija matriz de soporte, política CGO/helpers, corpus y presupuestos/criterios medibles antes de evaluar los destinos; terminal/PDF se prueban como decisiones antes del port completo del agente.
- Phase 2 debe demostrar viabilidad de terminal inline/scrollback y adaptador PDF sobre casos acordados antes de Phase 3; la paridad completa se acepta en Phase 4. No se adopta biblioteca por nombre/versiones citadas en el SPEC.
- No se heredan como PASS los 131 casos históricos ni benchmarks Python. Distinguir evidencia local, CI, terminal física, gateway autenticado, móvil y release por destino; ausencia de evidencia queda pendiente/bloqueada.
- La integración de instaladores/gateway/Docker en Phase 5 sirve distribución CLI; no cambia inferencia. Publicación y sustitución requieren autorización y aceptación concreta.

## Progress

**Execution Order:** 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Contratos y línea base reproducible | 0/4 | Planned; execution pending | - |
| 2. Chat Go usable y cancelable | 0/TBD | Not started | - |
| 3. Agente, herramientas y estado compatibles | 0/TBD | Not started | - |
| 4. Terminal interactiva y funciones conectadas | 0/TBD | Not started | - |
| 5. Distribución, actualización y sustitución aceptada | 0/TBD | Not started | - |

## Coverage

31/31 requisitos v1 asignados exactamente una vez; 0 huérfanos y 0 duplicados. REQUIREMENTS.md contiene trazabilidad y fuentes. Phase 1 tiene cuatro planes ejecutables; fases 2–5 son backlog en TASK-DIVISION.md y requieren replantear desde evidencia.
