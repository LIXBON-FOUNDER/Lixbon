# División de trabajo — migración CLI Go
Fecha: 2026-10-05. Propuesta de despacho futuro por Orca; ningún worker/worktree creado por esta planificación. Phase 1 tiene planes ejecutables; fases 2–5 son backlog acotado que debe replantearse con evidencia de prerrequisitos. No se modifica backend ni desktop ni audit; Go futuro convive bajo apps/cli/go/. Roles propuestos, autoridad por propiedad y revisión, no por modelo.

## Estado real (2026-10-06)

Este documento es la propuesta original de despacho y se conserva como historial. La ejecución real difirió: el usuario eligió adelantar Go (opción B) y el trabajo de las fases 2–4 se hizo en una sola rama (`cli`), sin worktrees por dueño ni planes GSD, y con rutas distintas a las candidatas de las tablas de abajo.

| Fase propuesta | Rutas candidatas | Rutas reales en `apps/cli/go/` | Estado |
|---|---|---|---|
| 1 / BASE | `validation/` | `../validation/` (`REFERENCE.md`, `gen_*_corpus.py`, 6 corpus) | Parcial: faltan 01-01 (harness), 01-03 (matriz), 01-04 (mediciones) y acta |
| 2 / CHAT | `cmd/lixbon`, `internal/{config,api,sse,chat}` | `cmd/lixbon`, `internal/{config,api,sse,cli}` | Implementada; CHAT-02 parcial |
| 3 / agente, herramientas, estado | `internal/{agent,context,tools,process,workspace,state}` | `internal/{agent,history,toolspec,toolparse,tools,process,session,workspace,textutil}` | Implementada |
| 4 / terminal | `internal/terminal` | `internal/{chat,tui}` | En curso |
| 4 / documentos | `internal/{documents,clipboard}` | sin crear | Pendiente (#13, #14, #15) |
| 4 / MCP y remoto | `internal/{mcp,remote}` | `internal/mcp` | MCP implementado; remoto pendiente (#17) |
| 5 / binarios, actualización, cutover | `internal/update`, CI, instaladores | solo job `cli-go` en `ci.yml` | No iniciada (#18, #20) |

Lo que falta se rastrea en las issues #12–#25 de LIXBON-FOUNDER/Lixbon. Los roles Implementador/Validador/Revisor de las tablas siguientes no se aplicaron; la validación independiente de lo ya hecho es una tarea pendiente.

## Planes Phase 1 y propiedad
| Ola | Paquete | Módulos / propiedad exclusiva | Necesita / produce | Implementador | Validador | Revisor |
|---|---|---|---|---|---|---|
| 1 | 01-01 referencia | validation/preflight.py, reference_runner.py, requirements.lock, REFERENCE.md; tests/test_input_box.py | Entorno oficial verificable → referencia aislada, diagnóstico, lock y runner | Codex | OpenCode | Claude |
| 2 | 01-02 contratos | validation/CONTRACTS.md, fixtures/schema.json, corpus.json, verify_corpus.mjs; tests/test_contract_corpus.py | 01-01 integrado → inventario y corpus Python/Node | Claude | Codex | OpenCode |
| 2 | 01-03 destinos | validation/MATRIX.md, verify_inventory.py | 01-01 integrado → matriz/helpers y opciones CGO | Codex | Claude | OpenCode |
| 3 | 01-04 medidas/aceptación | validation/measure_baseline.py, BASELINE.md, verify_acceptance.py, ACCEPTANCE.md | 01-01/02/03 integrados → medidas y checkpoint concreto | OpenCode | Codex | Claude |

Rutas de tabla relativas a apps/cli/. Cada tarea crea como máximo cinco archivos fuente. results/<run-id> es salida generada, no un archivo de propiedad compartida: prefijo incluye plan/worker/commit. Fixture input-box pertenece exclusivamente a 01-01. Corpus pertenece a 01-02; otros planes no lo actualizan. Si un diagnóstico requiere fuente Python/bundle compartido, detener esa reparación y negociar propiedad concreta antes de editar; freshness no regenera automáticamente. Ola 2 no comparte archivos. Validador y revisor actúan después de integración y son distintos del implementador para cada paquete. Worktrees del debate se preservan.

## Backlog de las cinco fases
| Fase / paquete propuesto | Alcance y módulos/rutas candidatas | Gate previo | Implementador | Validador | Revisor |
|---|---|---|---|---|---|
| 1 / BASE | Cuatro planes de tabla anterior; BASE-01/02/03/04 | Fuentes actuales; preflight y diagnóstico antes de aceptación | Según tabla | Según tabla | Según tabla |
| 2 / CHAT entrada/API | apps/cli/go/cmd/lixbon/, internal/config/, internal/api/; status/models/chat --once, identidad/credenciales/errores; CHAT-01/02/03 | Acta Phase 1, destinos y corpus aceptados | Claude | Codex | OpenCode |
| 2 / CHAT streaming/cancelación | internal/sse/, internal/chat/ y adaptador Go de fixtures; CHAT-04/05 | Primer camino API integrado; ownership de entrypoint por CHAT entrada | OpenCode | Claude | Codex |
| 2 / pruebas terminal/PDF | directorios de pruebas acotadas terminal/PDF definidos al replanificar; sin port completo | Casos/terminales/helper-policy aceptados; compara candidatos con calidad/licencia | Codex | OpenCode | Claude |
| 3 / agente/contexto | internal/agent/, internal/context/; AGNT-01/02 y TOOL-01 | Chat/cancelación y pruebas terminal/PDF Phase 2 | Claude | Codex | OpenCode |
| 3 / herramientas/I/O | internal/tools/, internal/process/; TOOL-02/03 y BOUND-01/02 | Schemas y aprobación acordados; agente consume interfaz publicada | OpenCode | Claude | Codex |
| 3 / workspace/estado | internal/workspace/, internal/state/; WORK-01, STATE-01/02 | Formatos/corpus y límites aceptados; herramientas públicas integradas | Codex | OpenCode | Claude |
| 4 / terminal | internal/terminal/; TERM-01/02, queue/scrollback/render | Phase 3, decisión de terminal probada Phase 2 | Claude | Codex | OpenCode |
| 4 / documentos | internal/documents/, internal/clipboard/; DOC-01/02 | Adaptador PDF/terminal y helpers aceptados; corpus documental | Codex | Claude | OpenCode |
| 4 / MCP/remoto | internal/mcp/, internal/remote/; MCP-01, REMOTE-01, CONNECT-01 | Agente/aprobaciones/cleanup estable; contratos inventariados | OpenCode | Codex | Claude |
| 5 / binarios/CI | apps/cli/go/, .github/workflows/ (archivos exactos al replanificar); REL-01 | Paridad completa Phase 4 y matriz destino | Codex | OpenCode | Claude |
| 5 / actualización | internal/update/; REL-02/03 | Canal de autenticidad definido, binarios y pruebas fallo por OS | OpenCode | Claude | Codex |
| 5 / integración/cutover | Instaladores CLI, distribución gateway y Docker: archivos exactos al replanificar; REL-04/05 | CI/instalación/rollback reales, autorización publicación y aceptación | Claude | Codex | OpenCode |

Las rutas Go son paquetes propuestos, no interfaces congeladas ni autorización de modificar hoy. Cada fase futura tendrá mapas exactos de files_modified y olas recalculadas: cambios compartidos de cmd/lixbon, go.mod, config, scripts/CI requieren un único dueño y ola de integración secuencial. Paquetes solo corren en paralelo con rutas disjuntas; no se infiere disjunción de estos directorios candidatos. Ningún role adquiere autoridad para reducir requisitos. OpenCode puede aportar contrarrevisión Rust a decisiones de I/O/concurrencia; experimento Rust continúa opcional, fuera del camino crítico, con dueño/fecha desktop y gates de PROJECT antes de iniciarlo.

## Auditoría multifuente Phase 1
CONTEXT no tiene IDs D-NN. Los siguientes aliases locales identifican sus ocho decisiones por orden; no alteran el documento fuente ni crean nuevas decisiones.

| Fuente | ID | Ítem | Plan | Estado |
|---|---|---|---|---|
| GOAL | G1 | Comportamientos conservados, destinos y equivalencia verificables | 01-01/02/03/04 | COVERED |
| REQ | BASE-01 | Dependencias/colección/diagnóstico dos fallos | 01-01 | COVERED |
| REQ | BASE-02 | Inventario completo y corpus independiente portable | 01-02 | COVERED |
| REQ | BASE-03 | Matriz, CGO, helpers y contradicción README | 01-03/04 | COVERED |
| REQ | BASE-04 | Arranque/RSS/streaming/lectura/cancelación equivalentes | 01-04 | COVERED |
| CONTEXT | D-01 | Go elegido, binarios sin Python/pip | 01-03/04 delimitan futuros destinos; Go Phase 2 | COVERED |
| CONTEXT | D-02 | Python referencia/rollback | 01-01/02/04 | COVERED |
| CONTEXT | D-03 | Corpus independiente, diferencias no accidentales | 01-02/04 | COVERED |
| CONTEXT | D-04 | Audit inmutable e historia separada | 01-01/04 | COVERED |
| CONTEXT | D-05 | API/terminal/permisos/recursos separados | 01-02/04 | COVERED |
| CONTEXT | D-06 | Orca, worktrees, ownership y revisión independiente | Todos | COVERED |
| CONTEXT | D-07 | Rust opcional fuera de camino crítico | 01-03/04 y backlog; no implementación Rust | COVERED |
| CONTEXT | D-08 | Terminal/PDF se prueban Phase 2, sin adopción por nombre | 01-03/04 y backlog Phase 2 | COVERED |
| RESEARCH | R1 | Preflight crítico, venv/lock/wheelhouse, imports sin pip y suite con skips | 01-01 | COVERED |
| RESEARCH | R2 | Frescura generate sin escritura, diagnóstico causal input-box | 01-01 | COVERED |
| RESEARCH | R3 | CLI handlers/slash dispatch/20 schemas/argumentos/errores | 01-02 | COVERED |
| RESEARCH | R4 | Payload/auth/omisión/null/false y errores fake | 01-02 | COVERED |
| RESEARCH | R5 | SSE bytes/think/EOF/UTF8 y cancelación silenciosa | 01-02/04 | COVERED |
| RESEARCH | R6 | Desktop Node puro y oráculos/procedencia diferenciados | 01-02 | COVERED |
| RESEARCH | R7 | Config BOM/campos desconocidos/session sintética; no home real | 01-01/02 | COVERED |
| RESEARCH | R8 | Matriz evidencia/helpers/CGO y README | 01-03/04 | COVERED |
| RESEARCH | R9 | Controlador externo RSS, muestras, warm/cold/on/off, cleanup | 01-04 | COVERED |
| RESEARCH | R10 | Datos históricos separados y budgets después de medir | 01-04 | COVERED |
| RESEARCH | R11 | A1 rutas/A2 colección/A3 ASVS conceptual/A4 soporte pendiente | 01-04 gate/delta | COVERED |
| RESEARCH | R12 | Threat boundaries y controles explícitos sin certificación | Todos | COVERED |

Excluidos por scope: OCR/backend/desktop rewrite/almacén OS; biblioteca terminal/PDF y Go son Phase 2; Rust experimental no se convierte en plan obligatorio.

## Probes y supuestos pendientes
Informe del orchestrator: applicable=4, resolved=0, unresolved=4. BASE-01/02/03/04 category=unclassified, status=unresolved, verification=null, probe=manual review. Conservar este informe como origen; tasks 01-01-02, 01-02-03, 01-03-02 y 01-04-02 realizan revisión manual de cada requisito y 01-04-03 confirma disposiciones. Hasta ejecutar no existen edges resueltos. Registrar casos faltantes, razón de inaplicabilidad si procede y revisor/fecha; jamás declarar edge-free por fallback no clasificador.
Prohibition probe se revisó como guía: no fabricar valores/ética no presentes ni confundir controles rutinarios STRIDE con prohibiciones de producto. Prohibiciones de alcance acordadas: no historia como PASS nuevo, no accidentes impuestos a Go, no soporte/rendimiento supuesto aceptado, no ampliar backend ni acceder datos reales. Revisión de intención/semántica al cierre; ausencia de prohibiciones adicionales no es prueba de ausencia de riesgos.

## Descubrimiento y capacidades
Research y PATTERNS actuales proporcionan descubrimiento suficiente Level 0 para harness interno, stdlib y consumidores existentes; no selección de biblioteca nueva. El bootstrap verifica procedencia oficial/hashes antes de provisionar dependencias existentes: auditoría research sin tabla no equivale a aprobación de paquetes. Si procedencia no se resuelve se bloquea instalación. No se pide permiso genérico para paquetes verificables ya autorizados.
No NEW external API integration: solo inventory de contratos actuales. Fragments ai-integration/api-coverage, assumption-delta/plan-pre, schema-gate/plan-pre y security/plan-pre no instalados en runtime consultado; registrar ausencia sin fingir ejecución de hooks. No graph ni historial de fases previas disponible (history-digest vacío); skills de proyecto no encontrados en investigación, agent_skills vacío. Calibración estimate factor=1, sample_count=0, confidence=low; estimaciones de planes son proyecciones, no tiempo medido.

## Gate de inicio/fin
Los bloques automated de los cuatro planes son comandos PowerShell multilinea con comprobación inmediata de $LASTEXITCODE tras cada proceso externo; el primer fallo detiene el bloque y conserva su código. El checkpoint --accepted sigue la misma regla y requiere acta explícita. 01-01-01 incorpora en el --self-check del harness de referencia el caso primer proceso falla / último sería exitoso: el bloque debe devolver FAIL y no ejecutar el último; el self-check devuelve cero solo al confirmar el rechazo. VALIDATION referencia esos bloques como comandos canónicos y conserva prerrequisitos y estado pendiente. Esta revisión solo ajusta documentos; la comprobación negativa se ejecutará junto al harness futuro.
Antes del despacho verificar estado Git, autorización de ejecución y preflight del plan. Validación draft/nyquist_compliant=false permanece así hasta ejecutar; checks del planner solo validan documentos. Cierre requiere evidencia, revisión independiente y checkpoint 01-04-03 con decisiones reales; luego se replantea Phase 2 sin iniciarla automáticamente. No commit, branch, test, benchmark, instalación ni publicación durante esta entrega.
