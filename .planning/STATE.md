---
gsd_state_version: '1.0'
status: executing
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 4
  completed_plans: 0
  percent: 48
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-10-06)

**Core value:** El usuario instala y ejecuta un binario CLI soportado sin Python ni pip, conservando los contratos funcionales del cliente existente.
**Current focus:** completar Phase 4 (documentos, remoto, `setup`/`usage`/`update`) y abrir Phase 5 (distribución y retirada de Python). Phase 1 sigue abierta en sus entregables de aceptación.

## Current Position

Rama de trabajo: `cli`. Módulo Go en `apps/cli/go/` (`lixbon.com/cli`, versión `2.3.0-go.0`).

| Fase | Estado real | Evidencia |
|------|-------------|-----------|
| 1. Contratos y línea base | Parcial: referencia Python y 6 corpus portables hechos; faltan acta, matriz de destinos, mediciones y harness 01-01 | `apps/cli/validation/` |
| 2. Chat usable y cancelable | Implementada; falta validar contra un gateway real y completar CHAT-02 (login) | pruebas `internal/{sse,api,config,cli}` |
| 3. Agente, herramientas y estado | Implementada; falta verificación en terminal real y con modelos reales | pruebas `internal/{agent,tools,process,history,session,workspace}` |
| 4. Terminal y conexiones | En curso: TUI, MCP y 36 de 41 comandos `/` del catálogo (más `/provider`) listos; faltan remoto, adjuntos, PDF/Word, `/paste`, `/visual`, `/update`, `setup`, `usage` | `internal/{tui,chat,mcp}` |
| 5. Distribución y sustitución | No iniciada (el CI solo compila y prueba) | `.github/workflows/ci.yml` job `cli-go` |

Requisitos v1: **15 hechos, 8 parciales, 8 pendientes** de 31 (detalle en REQUIREMENTS.md). «Hecho» significa implementado con pruebas automáticas, no aceptado: la aceptación del reemplazo (REL-05) sigue pendiente.

Last activity: 2026-10-06 — cliente MCP (stdio y HTTP) y `/mcp` en Go (issue #12); documentos alineados con el código; backlog abierto como issues #12–#25 en LIXBON-FOUNDER/Lixbon.

Progress: [█████░░░░░] 48% de requisitos implementados (0 % aceptados)

## Verified Evidence (2026-10-06)

- `go vet ./...` y `go test -count=1 ./...` en `apps/cli/go`: todos los paquetes con pruebas pasan (Windows 11, Go 1.26.5, ejecución local).
- CI (`ci.yml`, job `cli-go`): verde en ubuntu, macos y windows en el fork (`PR3S1G4zZ/Lixbon`, PR #2) y en el upstream (ejecución 37503221140: los tres jobs Go en success).
- CI upstream en `master`/`cli`: el job Python `CLI · tests + artefacto al día` **falla** (`state_corpus.json` no coincide con `sessions.py`/`commands.py`). La regeneración está en el fork (commit 8c95435) pero aún no llegó al upstream.
- Referencia Python: 133 passed, 0 failed (Windows, Python 3.13.14, `apps/cli/validation/REFERENCE.md`). Los dos fallos históricos de `test_input_box.py` no se reproducen; causa original no determinada.
- Sin evidencia todavía: gateway autenticado, LM Studio/Ollama/OpenAI reales, terminales físicas Linux/macOS, móvil, mediciones Go y release por plataforma.

## Performance Metrics

**Velocity:**
- Total plans completed: 0 de 4 (los planes 01-0x no se ejecutaron como estaban escritos; el trabajo se hizo fuera de ellos, ver Decisions)
- Commits que tocan `apps/cli/go` desde 2026-10-05: 22

**Recent Trend:**
- Last 5 commits: proveedores externos, sincronización de `/visual`, pruebas estables entre sistemas operativos
- Trend: implementación por delante de la validación y la documentación

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.

- 2026-10-05: Go elegido por el usuario tras debate; supersede la recomendación anterior del SPEC sin modificarlo. Python conserva referencia y rollback hasta paridad/cutover aceptados. Rust opcional y fuera del camino crítico.
- 2026-10-06: el usuario eligió adelantar Go sin esperar el cierre de Phase 1 (opción B). Es una desviación del gate de TASK-DIVISION: acta, matriz de destinos (01-03) y mediciones (01-04) siguen pendientes.
- 2026-10-06: UI con Bubble Tea v2. El modo inline duplicaba la caja de entrada al encogerse la vista; se pasó a pantalla completa con transcript y scroll propios. A cambio se pierde el scrollback nativo y la selección con ratón exige Mayús (`/copy` como alternativa).
- 2026-10-06: perfiles de proveedor (`lixbon profile`, `/provider`) y modo genérico compatible con OpenAI. `/provider` es un comando solo de Go, fuera del catálogo contrastado con Python. Una suscripción de ChatGPT o Claude no es una API key y se descarta como vía.
- 2026-10-06: tras el merge del upstream (`/visual` sobre MCP), `state_corpus.json` se regeneró y el catálogo Go se sincronizó.
- 2026-10-06: cliente MCP en `internal/mcp` (stdio y Streamable HTTP, paginación, cancelación con `notifications/cancelled`, cierre acotado que mata el árbol, redirecciones solo al mismo origen) y `/mcp`. Paridad con Python comprobada con `mcp_corpus.json`; probado en Windows con `@modelcontextprotocol/server-filesystem` real y sin procesos huérfanos. Desviaciones: respalda `structuredContent`, añade `type: object` a schemas sin tipo, desambigua nombres repetidos y limita el nombre a 64 caracteres (APIs OpenAI), y arranca los servidores en paralelo con un límite de 60 s (la primera ejecución de `npx` descarga el paquete). El servidor `lixbon` (Visuals) se añade solo con cuenta Lixbon y `lixbon_mcp` no desactivado.
- Pruebas que dependían del sistema operativo (LF/CR del emulador, enlaces simbólicos en `/workspace`, orden de recorrido de Python en el corpus de workspace) se corrigieron al estrenar el CI de Go.

### Hecho en Go (resumen)

`sse`, `config`, `api`, `cli` (`init status models profile chat`), `mcp`, `toolspec`, `toolparse`, `tools` (20 herramientas), `process` (árbol de procesos), `history`, `agent` (bucle, aprobaciones, diff, undo, verificadores), `session`, `workspace`, `chat`, `tui` (Bubble Tea v2). Detalle por paquete en `apps/cli/go/README.md`.

### Pending Todos

Backlog en GitHub (LIXBON-FOUNDER/Lixbon):

- #13 adjuntos `@ruta` e `/image` · #14 PDF y Word · #15 `/paste` · #16 `/visual` · #17 `/remote`
- #18 `update` y `/update` · #19 `setup`, `usage`, `ui-demo` · #20 distribución, instaladores y Docker
- #21 validación contra modelos y gateway reales · #22 terminales reales · #23 `lixbon.exe~` versionado · #25 cierre de Phase 1
- Retirada de Python: ver «Retirada de Python» en ROADMAP.md.
- Llevar al upstream la regeneración de `state_corpus.json` para recuperar el CI Python.

### Blockers/Concerns

- Phase 1 sin cerrar: no hay matriz de destinos acordada ni política CGO escrita; hay que decidirlas antes de elegir biblioteca PDF (#14) y de empaquetar (#20).
- Mediciones Python vs Go inexistentes: ninguna afirmación de rendimiento está respaldada.
- Eliminar Python exige antes congelar los corpus: los `gen_*_corpus.py` usan el código Python como oráculo.
- `apps/cli/go/lixbon.exe~` está versionado (#23).
- Prueba intermitente `TestProviderCommandSwitchesToAnExternalServerAndBack` (≈15 % de fallos, también en `HEAD` previo): tras `/provider lixbon` el `settle` del harness no termina. Puede tumbar el CI; sin diagnosticar.

## Deferred Items

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| Credentials | Almacén OS con fallback diseñado | v2 | 2026-10-05 | v1 |
| Experiment | Rust 1–2 días con dueño/fecha y gates desktop | Opcional, fuera del camino crítico | 2026-10-05 | v1 |

## Session Continuity

Last session: 2026-10-06
Stopped at: MCP hecho. Siguiente: investigar más proveedores (modelos locales y por API), luego `/visual` (#16, ya hay `GetPrompt`), `setup`/`usage`/`update` y el resto, para poder retirar Python.
Resume file: None
