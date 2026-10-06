# Roadmap: Lixbon CLI — migración gradual de Python a Go

## Overview

De una referencia Python reproducible a un binario Go aceptado por plataforma, mediante chat --once, agente/workspace y funciones conectadas. Go está elegido; Rust opcional no bloquea las fases. Ninguna fase autoriza publicación automática ni retirar Python sin aceptación explícita.

**Estado a 2026-10-06:** por decisión del usuario (opción B) el código Go se adelantó a Phase 1: las fases 2 y 3 están implementadas y probadas en CI (Linux, macOS, Windows), Phase 4 está en curso (MCP hecho) y Phase 5 no ha empezado. Lo que falta de Phase 1 son los entregables de aceptación (acta, matriz de destinos, mediciones). «Implementada» no equivale a «aceptada»: la validación contra gateway real, terminales físicas y móvil sigue pendiente. Backlog en GitHub: LIXBON-FOUNDER/Lixbon, issues #12–#25.

**Granularity**: standard como calibración de planificación (config.json no define granularity).
**Phase ID convention**: sequential por defecto (config.json no define phase_id_convention).

## Phases

Leyenda: `[x]` implementada con pruebas y aceptada · `[~]` implementada o parcial, falta aceptación o cierre · `[ ]` no iniciada. Ninguna fase está aún `[x]`.

- [~] **Phase 1: Contratos y línea base reproducible** - El usuario puede identificar qué comportamientos se conservarán, qué destinos se soportarán y cómo comprobar equivalencia con Python. *Parcial: referencia Python y 6 corpus portables; faltan acta, matriz, mediciones y harness.*
- [~] **Phase 2: Chat Go usable y cancelable** - El usuario puede ejecutar un primer chat --once Go compatible con el gateway y cancelarlo sin esperar nuevos eventos. *Implementada; falta CHAT-02 (login) y probar contra gateway real.*
- [~] **Phase 3: Agente, herramientas y estado compatibles** - El usuario puede trabajar sobre su workspace con el agente Go, aprobaciones y sesiones preservadas sin recursos ilimitados. *Implementada; falta validarla con modelos reales y en terminales físicas.*
- [~] **Phase 4: Terminal interactiva y funciones conectadas** - El usuario puede completar los flujos interactivos, documentales, MCP y remotos que ofrece el cliente Python. *En curso: TUI y MCP hechos; faltan remoto, documentos, `/paste`, `/visual`, `setup`, `usage`.*
- [ ] **Phase 5: Distribución, actualización y sustitución aceptada** - El usuario instala y actualiza binarios auténticos sin Python/pip, con recuperación y paridad aceptada por plataforma. *No iniciada; el CI solo compila y prueba.*

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

**Estado (2026-10-06)**: parcial. Hecho: referencia Python reducida (`validation/REFERENCE.md`, 133 passed, fallos históricos no reproducidos) y corpus portables `sse`, `tool_parse`, `workspace`, `edit`, `agent`, `state`. Pendiente: harness 01-01, inventario contractual completo, matriz de destinos/CGO, mediciones, acta (issue #25).

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

**Estado (2026-10-06)**: implementada (`internal/{sse,api,config,cli}`). CHAT-01/03/04/05 hechos; CHAT-02 parcial (Bearer y User-Agent sí; `setup`/emisión de API key no, issue #19). Sin probar contra gateway autenticado ni proveedores reales (issue #21).

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

**Estado (2026-10-06)**: implementada (`internal/{agent,tools,process,history,session,workspace}`). Los 10 requisitos están hechos con pruebas en CI de tres sistemas operativos. Pendiente: `read_file` de PDF/Word (issue #14) y validación con modelos y terminales reales (issues #21, #22).

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

**Estado (2026-10-06)**: en curso. Hecho: TUI Bubble Tea v2 a pantalla completa, cliente MCP stdio/HTTP y `/mcp`, 36 de 41 comandos `/`, `/provider`, perfiles de proveedor. Pendiente: adjuntos (#13), PDF/Word (#14), `/paste` (#15), `/visual` (#16), `/remote` (#17), `setup`/`usage` (#19) y la matriz de terminales (#22).
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

**Estado (2026-10-06)**: no iniciada. Existe CI de compilación y pruebas en tres sistemas operativos; no hay empaquetado, firma, actualización ni instaladores Go (issues #18, #20). Ver «Retirada de Python».

## Acceptance Gates

- Phase 1 fija matriz de soporte, política CGO/helpers, corpus y presupuestos/criterios medibles antes de evaluar los destinos; terminal/PDF se prueban como decisiones antes del port completo del agente.
- Phase 2 debe demostrar viabilidad de terminal inline/scrollback y adaptador PDF sobre casos acordados antes de Phase 3; la paridad completa se acepta en Phase 4. No se adopta biblioteca por nombre/versiones citadas en el SPEC. *Resultado parcial (2026-10-06): el modo inline de Bubble Tea 2.0.10 duplicaba la caja de entrada y se adoptó pantalla completa con scrollback propio (se pierde el scrollback nativo); la elección de biblioteca PDF sigue abierta (issue #14).*
- No se heredan como PASS los 131 casos históricos ni benchmarks Python. Distinguir evidencia local, CI, terminal física, gateway autenticado, móvil y release por destino; ausencia de evidencia queda pendiente/bloqueada.
- La integración de instaladores/gateway/Docker en Phase 5 sirve distribución CLI; no cambia inferencia. Publicación y sustitución requieren autorización y aceptación concreta.

## Progress

**Execution Order:** 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Contratos y línea base reproducible | 0/4 (trabajo parcial fuera de plan) | Parcial; aceptación pendiente | - |
| 2. Chat Go usable y cancelable | n/a (sin planes GSD) | Implementada; 4/5 requisitos hechos, CHAT-02 parcial | - |
| 3. Agente, herramientas y estado compatibles | n/a (sin planes GSD) | Implementada; 10/10 requisitos hechos | - |
| 4. Terminal interactiva y funciones conectadas | n/a (sin planes GSD) | En curso; 1/7 hechos, 4 parciales | - |
| 5. Distribución, actualización y sustitución aceptada | 0/TBD | Not started | - |

## Coverage

31/31 requisitos v1 asignados exactamente una vez; 0 huérfanos y 0 duplicados. REQUIREMENTS.md contiene trazabilidad, estado real por requisito y fuentes: 15 hechos, 8 parciales, 8 pendientes. Phase 1 conserva sus cuatro planes sin ejecutar; fases 2–4 se implementaron sin planes GSD y 5 sigue como backlog en TASK-DIVISION.md.

## Retirada de Python

Objetivo del usuario: terminar la migración para poder eliminar la base Python del CLI y dejar el repositorio mejor organizado. Es el contenido de REL-04 y REL-05 y **no debe ejecutarse hasta aceptar la paridad**. Dependencias actuales que hay que reemplazar o retirar, en orden:

1. **Paridad funcional** (Phase 4): adjuntos, PDF/Word, `/paste`, `/visual`, `/remote`, `setup`, `usage`, `update` (issues #13–#19; MCP, #12, ya implementado).
2. **Evidencia de aceptación** (Phase 1 y #21, #22): matriz de destinos, mediciones, validación con gateway/modelos/terminales reales.
3. **Congelar los corpus**: los `apps/cli/validation/gen_*_corpus.py` usan el código Python como oráculo (`sessions.py`, `commands.py`, `agent.py`…). Antes de borrarlo hay que conservar los JSON de `validation/fixtures/` como contrato versionado y decidir qué hacer con los generadores y con `test_contract_corpus.py`.
4. **Distribución** (#20): `core/gateway/routers/installer.py` sirve `/install/client_cli.py` y sus scripts `install.sh`/`install.ps1` ejecutan `python`; `core/gateway/routers/versions.py` publica el manifest que consume `client_cli.py --update`; `core/config.py` define `CLI_SOURCE_PATH`; el `Dockerfile` copia `apps/cli/client_cli.py`.
5. **CI y contribución**: `.github/workflows/ci.yml` (job `CLI · tests + artefacto al día`), `.github/pull_request_template.md` y `CONTRIBUTING.md` (`build.py`, `pytest`).
6. **Borrado**: `apps/cli/lixbon_cli/`, `client_cli.py`, `build.py`, `tests/`, tras un periodo de coexistencia y con la tag/rama de rollback acordada. `apps/cli/audit/` se conserva como historial.
7. **Reorganización**: mover `apps/cli/go/` a la raíz de `apps/cli/` y actualizar rutas de CI, README y documentos.
