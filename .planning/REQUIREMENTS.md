# Requirements: Lixbon CLI — migración gradual de Python a Go

**Defined:** 2026-10-05
**Core Value:** El usuario instala y ejecuta un binario CLI soportado sin Python ni pip, conservando los contratos funcionales del cliente existente.

## v1 Requirements

Alcance de la primera sustitución aceptada. Derivado de la evaluación conservada y de la decisión posterior del usuario.

Estado a 2026-10-06. Leyenda: `[x]` implementado con pruebas automáticas (CI en Linux, macOS y Windows); `[~]` parcial; `[ ]` pendiente. Una casilla marcada **no significa aceptada**: la aceptación formal (REL-05) exige además evidencia con gateway real, terminales físicas, móvil y release por plataforma. Recuento: 14 hechos, 7 parciales, 10 pendientes.

### Contratos y línea base

- [~] **BASE-01**: El mantenedor puede reproducir la línea base Python con dependencias fijadas, sin omisiones silenciosas de casos críticos, y clasificar los dos fallos históricos de fixture antes de usarla como referencia.
- [~] **BASE-02**: El usuario dispone de un inventario contractual de comandos, flags, códigos de salida, slash commands y 20 schemas de herramientas, y de fixtures JSON portables para payloads, SSE, errores, parsing y cancelación consumibles por Python, Go y desktop sin compartir implementación.
- [~] **BASE-03**: El usuario conoce la matriz soportada de OS/arquitectura y terminales, la política de CGO/dependencias nativas y los helpers opcionales; el inventario reconcilia el README «sin dependencias externas» con rich, prompt_toolkit y pypdf actuales.
- [ ] **BASE-04**: El usuario puede comparar Python y Go mediante escenarios equivalentes de arranque, RSS, streaming, lectura parcial y cancelación, con entorno, versiones, commit e instrumentación registrados y criterios medibles acordados; no se presume mejora ni aceleración de inferencia.

### Chat Go y gateway

- [x] **CHAT-01**: El usuario puede ejecutar status, models y chat --once en un binario Go para cada destino acordado, conservando flags, salida y códigos del subconjunto; el estado local aparece sin esperar consultas auxiliares de red.
- [~] **CHAT-02**: El usuario puede configurar/login con Bearer API key, User-Agent Lixbon-CLI/<version>, issue_api_key=true y key_name="lixbon CLI", preservando identidad y rotación; redirects entre hosts no filtran credenciales.
- [x] **CHAT-03**: El usuario puede conversar mediante /v1/chat/completions preservando source="cli", conversation_id, client_id, título, num_ctx, think, web_search y tools, con errores de cuota/autenticación/offline distinguibles y sin reintento automático del POST de chat.
- [x] **CHAT-04**: El usuario recibe lixbon_sources, reasoning_content, content, tool_calls, usage y [DONE] correctamente con UTF-8/eventos fragmentados, CRLF, keepalives, <think> dividido y campos nuevos; fin válido y error se distinguen y el parser mantiene límites explícitos.
- [x] **CHAT-05**: El usuario puede cancelar un chat incluso con SSE silencioso; la petición y cuerpos se cierran con límites y timeouts definidos, y salir por --once usa la misma limpieza de recursos.

### Agente, workspace y estado

- [x] **AGNT-01**: El usuario puede completar turnos con tool calls nativas y protocolo textual tolerante, rescate desde razonamiento, IDs/orden conservados, argumentos completos validados antes de ejecutar, límite de 40 pasos y detección de repetición.
- [x] **AGNT-02**: El usuario conserva contexto de 16.384 por defecto y presupuesto de prompt de 65 %, recorte/compactación con pares assistant/tool y petición original, calibración por modelo y coherencia del num_ctx enviado; no se eleva VRAM automáticamente.
- [x] **TOOL-01**: El usuario puede utilizar los 20 schemas y efectos actuales: list_files, find_files, read_file, outline, search, write_file, edit_file, multi_edit, insert_at_line, append_file, mkdir, delete_file, rename_file, run_command, read_output, stop_command, fetch_url, web_search, todo y ask_user.
- [x] **TOOL-02**: El usuario controla aprobaciones distintas para shell y edición, efectos externos y modo /plan; las rutas resueltas respetan el workspace ante espacios, Unicode, traversal y symlinks en plataformas soportadas.
- [x] **TOOL-03**: El usuario puede revisar /diff, recuperar mediante snapshots y /undo y usar /commit/verificadores conservando sus contratos y errores.
- [x] **WORK-01**: El usuario conserva directorio de lanzamiento, /workspace, LIXBON.md y .lixbon/commands/*.md con $ARGUMENTS; búsquedas e índice respetan ignores/límites y se invalidan tras cambios, con rg opcional y fallback funcional acotado.
- [x] **STATE-01**: El usuario puede leer y modificar ~/.lixbon/config.json y configuración existente, incluyendo BOM UTF-8 y campos desconocidos, con backup antes de evolución y formato compatible durante coexistencia Python/Go.
- [x] **STATE-02**: El usuario puede guardar/reanudar sesiones <uuid>.json e history sin pérdida, con escritura atómica, índice reconstruible y bloqueo entre procesos para sessions/index.json; dos CLI conservan entradas y retención visible de 200 sesiones.
- [x] **BOUND-01**: El usuario puede leer rangos de archivos y ejecutar búsquedas/shell con presupuestos de bytes, líneas, longitud de línea y tiempos; el truncamiento se informa y los pipes se drenan sin capturar salida ilimitada.
- [x] **BOUND-02**: El usuario puede cancelar shell con hijos y salir sin procesos auxiliares huérfanos; la limpieza del árbol POSIX/Windows y buffers de procesos en segundo plano tiene límites verificables.

### Terminal y conexiones

- [~] **TERM-01**: El usuario puede abrir chat sin comando, usar run/start, init/setup/usage y todos los slash commands del inventario con paridad interactiva/no interactiva, Markdown/transcript, entrada en cola, resize, terminal angosta, Unicode y scrollback en terminales acordadas.
- [~] **TERM-02**: El usuario puede mantener sesiones largas sin reconstrucción ilimitada del texto por delta; ingesta y dibujo tienen presupuestos independientes y la terminal permanece utilizable bajo respuestas largas.
- [ ] **DOC-01**: El usuario puede adjuntar texto, PDF, Word e imágenes base64 con límites actuales de tamaño/páginas, orden/tablas compatibles y errores claros; extracción local sin subida silenciosa, PDF con adaptador elegido por corpus/calidad/licencia y helpers declarados.
- [~] **DOC-02**: El usuario puede usar portapapeles por OS y funciones Visuals/delegación con paridad explícita del inventario; la beta identifica funciones pendientes.
- [ ] **MCP-01**: El usuario puede usar servidores MCP stdio desde configuración usuario/proyecto, servers o mcpServers, precedencia, command/args/env/cwd y nombres mcp__..., con negociación, tools/list paginado, diagnóstico, cancelación y cierre acotado.
- [ ] **REMOTE-01**: El usuario puede controlar sesión desde móvil preservando rutas/campos y eventos hello/deltas/done/tools/snapshot/aprobaciones/bye, lotes cada 250 ms, cancelación independiente, cola limitada en bytes con prioridades y snapshot al recuperarse; no se promete entrega exactamente una vez.
- [ ] **CONNECT-01**: El usuario conserva políticas de aprobación para efectos MCP/remotos y puede cerrar conexiones bloqueadas sin dejar streams ni procesos abiertos.

### Distribución y sustitución

- [ ] **REL-01**: El usuario puede descargar e instalar artefactos por cada OS/arquitectura acordado y ejecutar el núcleo CLI sin Python/pip; CI y aceptación de instalación real cubren cada destino, y helpers opcionales están declarados.
- [ ] **REL-02**: El usuario puede verificar autenticidad/integridad de release y update mediante firma o digest esperado autenticado, rechazando artefactos alterados o de plataforma incorrecta antes de reemplazar.
- [ ] **REL-03**: El usuario puede actualizar desde Python y entre binarios mediante descarga temporal y reemplazo recuperable, incluido ejecutable Windows en uso; descarga o reemplazo fallido conserva una versión usable y rollback.
- [ ] **REL-04**: El usuario recibe el artefacto correcto desde instaladores/distribución del gateway y Docker, preservando transición desde client_cli.py sin cambiar lógica de inferencia.
- [ ] **REL-05**: El usuario puede aceptar la sustitución con matriz completa de paridad y evidencia por plataforma/terminal/MCP/remoto/documentos y mediciones equivalentes; Python permanece disponible como referencia y rollback hasta dicha aceptación.

## v2 Requirements

- **CRED-01**: Migración opcional de API keys al almacén del OS con fallback y recuperación diseñados; no se atribuye este cambio automáticamente al lenguaje Go.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Migración del backend/Ollama/GPU | El hito entrega solo el cliente CLI. |
| Reescribir desktop o compartir core vía CGO/Rust | Compartir fixtures portables evita acoplar runtimes. |
| OCR | No forma parte de la paridad documental actual. |
| Spike Rust como prerrequisito | Go está elegido; experimento opcional fuera del camino crítico, bajo condiciones de PROJECT.md. |
| Publicación automática o reemplazo anticipado de Python | Requiere aceptación explícita de paridad/distribución. |

## Traceability

| Requirement | Phase | Status | Evidencia / pendiente |
|-------------|-------|--------|-----------------------|
| BASE-01 | Phase 1 | Parcial | Referencia manual 133 passed; sin harness 01-01 ni hashes (#25) |
| BASE-02 | Phase 1 | Parcial | 6 corpus portables; falta inventario contractual y corpus de payloads/errores (#25) |
| BASE-03 | Phase 1 | Parcial | Discrepancia del README documentada en REFERENCE.md; matriz y política CGO sin acordar (#25) |
| BASE-04 | Phase 1 | Pendiente | Solo línea base Python histórica; sin mediciones Go (#25) |
| CHAT-01 | Phase 2 | Hecho | `status`, `models`, `chat --once`; CI en 3 SO |
| CHAT-02 | Phase 2 | Parcial | Bearer y User-Agent sí; falta login/emisión de API key (#19) y prueba de redirects entre hosts |
| CHAT-03 | Phase 2 | Hecho | Gateway falso; sin gateway real (#21) |
| CHAT-04 | Phase 2 | Hecho | `sse_corpus.json` |
| CHAT-05 | Phase 2 | Hecho | Pruebas de cancelación, cierre e inactividad en `api`, `sse` y `cli` |
| AGNT-01 | Phase 3 | Hecho | `internal/agent`, `toolparse`; 50 pruebas del bucle |
| AGNT-02 | Phase 3 | Hecho | `internal/history`; 16.384 y 65 % |
| TOOL-01 | Phase 3 | Hecho | 20 herramientas; PDF/Word en `read_file` pendiente (#14) |
| TOOL-02 | Phase 3 | Hecho | Aprobaciones, `/plan`, rutas seguras y symlinks |
| TOOL-03 | Phase 3 | Hecho | `/diff`, `/undo`, `/commit`, verificadores |
| WORK-01 | Phase 3 | Hecho | `LIXBON.md`, `.lixbon/commands`, búsqueda propia sin `rg` |
| STATE-01 | Phase 3 | Hecho | `internal/config`; BOM, campos desconocidos, escritura atómica |
| STATE-02 | Phase 3 | Hecho | `internal/session`; candado, índice reconstruible, retención de 200 |
| BOUND-01 | Phase 3 | Hecho | Lecturas, búsqueda y shell acotados |
| BOUND-02 | Phase 3 | Hecho | `internal/process`; mata el árbol en Windows y Unix |
| TERM-01 | Phase 4 | Parcial | TUI y 35/41 comandos `/`; faltan `setup`, `usage`, `/image`, `/paste`, `/visual`, `/mcp`, `/remote`, `/update`; sin matriz de terminales (#19, #22) |
| TERM-02 | Phase 4 | Parcial | Pantalla completa con scroll propio; sin presupuestos medidos (#22) |
| DOC-01 | Phase 4 | Pendiente | Sin adjuntos, imágenes ni PDF/Word (#13, #14) |
| DOC-02 | Phase 4 | Parcial | `/copy` hecho; `/paste` y `/visual` pendientes (#15, #16) |
| MCP-01 | Phase 4 | Pendiente | Solo ganchos de aprobación; sin cliente (#12) |
| REMOTE-01 | Phase 4 | Pendiente | Sin implementar (#17) |
| CONNECT-01 | Phase 4 | Pendiente | Depende de MCP y remoto (#12, #17) |
| REL-01 | Phase 5 | Pendiente | CI compila y prueba; sin artefactos (#20) |
| REL-02 | Phase 5 | Pendiente | Sin firma ni digest (#18) |
| REL-03 | Phase 5 | Pendiente | `update` no disponible (#18) |
| REL-04 | Phase 5 | Pendiente | Instaladores y Docker siguen sirviendo `client_cli.py` (#20) |
| REL-05 | Phase 5 | Pendiente | Requiere todo lo anterior y aceptación explícita |

**Coverage:**

- v1 requirements: 31 total
- Mapped to phases: 31
- Unmapped: 0
- Duplicated: 0
- Hechos: 14 · Parciales: 7 · Pendientes: 10

## Sources

- apps/cli/audit/EVALUACION_PYTHON_GO.md: contratos, costos, propuestas y evidencia histórica.
- .planning/intel/SYNTHESIS.md y constraints.md: ingest sin IDs; las recomendaciones técnicas no son decisiones bloqueadas.
- .planning/DECISION-CLI-GO.md: decisión del usuario posterior al SPEC.
- apps/cli/lixbon_cli/agent.py: catálogo nominal de 20 herramientas.
- apps/cli/README.md: declaración de dependencia pendiente de reconciliación.

---
*Last updated: 2026-10-05 after roadmap initialization; sin ejecución de pruebas.*

