# Vocabulario canónico de Lixbon (estados, intento, Attention)

Slice H de la Fase 1. Una sola tabla de nombres para el Core (Rust), el Desktop, `lxo`/CLI y el móvil. **Documenta lo que ya existe y reserva los nombres que vienen; no cambia comportamiento, ni el formato de `state.json`, ni el de HTTP.**

Fuente de datos: [`contracts/status-vocabulary.json`](../contracts/status-vocabulary.json). Pruebas que lo vigilan: `apps/desktop/src-tauri/src/orch/vocab.rs` (Rust) y `apps/desktop/src/orch/vocabulary.test.js` (vitest). Si el código y el contrato se desvían, esas pruebas fallan.

## 1. Reglas

1. **Tres capas, no se mezclan.**
   - *Dominio (ids de máquina):* `snake_case` en inglés, estables en disco y en HTTP. Viven en el Core y en `contracts/…json`, sección `domain`.
   - *Presentación:* etiquetas en español, formas, colores. Las pone cada cliente (sección `presentation`). **Ningún texto de interfaz entra en el dominio**: ni en `Status`, ni en `Kind`, ni en el JSON del Core.
   - *Transporte:* nombres de comandos y eventos de Tauri/HTTP. No se renombran.
2. **Un id vigente nunca se renombra ni cambia de significado** (rompería `state.json`, `/rpc` y la snapshot). Se añaden ids nuevos; los retirados siguen aceptándose al leer.
3. **Reservado ≠ API.** Los ids marcados *reservado* son nombres acordados en el modelo del runtime. No tienen código ni son API pública hasta el corte Task/Attempt; no se exponen todavía por `/rpc`, `lxo` ni la snapshot.
4. **Un nombre, un concepto.** Si una palabra ya significa algo en otra capa, se desambigua en la documentación (sección 6), no se renombra el código vigente.
5. **Añadir un estado de tarea:** (a) variante en `Status` → `task_status_id` en `vocab.rs` deja de compilar hasta decidir su id; (b) entrada en el contrato (`task_status.items`, `presentation.visual_group` y las etiquetas de cada cliente); (c) las pruebas dicen qué cliente falta.

## 2. Estado de la tarea (`Task.status`) — vigente

| id (`state.rs::Status`) | ¿final? | Grupo visual | Desktop | Móvil | `lxo list` | Estado de Attempt equivalente (reservado) |
|---|---|---|---|---|---|---|
| `starting` | no | active | Arrancando | arrancando | `[starting]` | `starting` |
| `running` | no | active | Trabajando | trabajando | `[running]` | `running` |
| `waiting` | no | waiting | Esperando respuesta | esperando | `[waiting]` | `waiting` |
| `awaiting_terminal_approval` | no | needs_person | Esperando aprobación en la terminal | *(sin etiqueta: ver §6)* | `[awaiting_terminal_approval]` | `awaiting_terminal_approval` |
| `done` | sí | ok | Terminada | entregó | `[done]` | `done` |
| `failed` | sí | error | Fallida | falló | `[failed]` | `failed` |
| `stopped` | sí | halted | Detenida | detenida | `[stopped]` | `stopped` |
| `exited` | sí | error | Cerrada | cerrada | `[exited]` | `exited` (pendiente de decidir si se funde con `stopped`) |

El TUI de Go (`apps/cli/internal/tui/orquestador.go`) no pinta estados de tareas hoy: solo comprueba que `lxo` esté disponible. Si algún día los pinta, usa esta tabla.

`is_final()` (`done`, `failed`, `stopped`, `exited`) existe hoy en tres copias: `state.rs`, `isFinal` en `orchStore.js` y `FINAL` en `RemoteOrch.js`. El contrato las fija todas.

## 3. Intento (`Attempt`) — reservado

Decisión del usuario: en código y API es `Attempt`; en la interfaz en español, **«Intento»**. El `Run` actual (objetivo de orquestación con árbol de tareas) **no se renombra**.

Hoy el intento es la propia `Task` (un solo intento por tarea; el anterior se pisa). Estados reservados del Attempt:

`pending_approval` → `starting` → `running` → `waiting` / `awaiting_terminal_approval` → `done` | `failed` | `stopped` (| `exited`)

- Son los ids de la tarea más **uno nuevo**, `pending_approval`. Hoy ese estado no existe en la tarea: vive fuera, como lanzamiento pendiente (`PendState::Pending`, id `pending`, ver §4). Reutilizar los ids hace que el corte Task/Attempt no obligue a reescribir `state.json`.
- Correspondencia con el modelo (en español, solo para la interfaz): pendiente de aprobación = `pending_approval`; iniciando = `starting`; trabajando = `running`; esperando (pregunta / aprobación en la terminal) = `waiting` / `awaiting_terminal_approval`; entregado = `done`; fallido = `failed`; detenido = `stopped`.
- Estado **derivado** de la Task tras el corte (reservado): `open`, `in_progress`, `in_review`, `integrated`, `discarded`.
- **Intención** de la Task (`tasks.intent`, LXO-113, inerte hasta el corte; [`core/TASKS.md`](core/TASKS.md)): `open` · `discarded`. Es lo único de su estado que se guarda, porque es una decisión de la persona; el resto del estado derivado sale de sus Attempts.
- Antes del corte **no** se consolidan como API: retry, resume, race, comparar ni historial de intentos.

Campos de Task que son «del intento» (para el corte, no para H): `agent`, `model`, `effort`, `role`, `profile`, `status`, `phases`, `policy`, `report*`, `delivery_channel`, `model_*`, `approval_deadline`, `failure_reason`, `attempt_started`… (lista completa en `LIXBON-modelo-runtime.md` §2.2).

## 4. Otros vocabularios de estado vigentes

| Concepto | Ids | Dónde |
|---|---|---|
| Lanzamiento pendiente (`spawn_status`, `orch-spawn-resolved`) | `pending`, `approved`, `rejected`, `launch_failed`, `expired` (+ `already_resolved`, que es un resultado y no un estado) | `spawn_approval.rs` (`PendState`; `launching` es interno y se informa como `pending`), `spawnContract.js` |
| Tipo de mensaje del buzón | `phase`, `done`, `question`, `reply`, `note`, `exited` | `state.rs::Kind` |
| Tipo de decisión (`Decision.kind`) | `merge`, `pr`, `review`, `spawn` (reservados en el comentario de `state.rs`: `release`, `discard`, `reopen`, `stop`) | `state.rs`, `integration.rs`, `review.rs`, `spawn_approval.rs` |
| Motivo de fallo (`failure_reason`) | `terminal_approval_timeout`, `agent_idle_timeout` | `approval.rs`, `terminalApprovalContract.js` |
| Canal de entrega (`delivery_channel`) | `exec_o`, `stream_json`, `report_json`, `stdout`, `lxo_done` | `delivery.rs`, `rpc.rs` |
| Estado de la política (`policy.status`) | `ok`, `blocked`, `unverified` | `agents.rs::Status` (**no** es el estado de la tarea) |
| Decisión de revisión | `accepted`, `rejected` | `review.rs`, `reviewContract.js` |
| Estado de revisión (derivado, no se guarda) | `none`, `stale`, `accepted`, `rejected` | `attention.js::reviewStatus` |
| Resultado de integración | `merged`, `conflict`, `error`, `target_moved` (+ `already_merged`, `review_required`, que no se registran) | `integration.rs` |

## 5. Attention

Hoy se calcula **solo en el frontend** (`src/orch/attention.js`); el slice G lo lleva al Core. Kinds vigentes, de más a menos urgente (el orden es la prioridad):

| kind | Condición (tarea hija) | Texto de ayuda del Desktop |
|---|---|---|
| `approve_in_terminal` | `status = awaiting_terminal_approval` | Espera tu aprobación en su terminal. |
| `integrate` | `done`, con rama, sin integrar y revisión aceptada sobre el commit actual | Revisada y lista para integrar. |
| `review` | `done`, con rama, sin integrar, sin revisión o revisión vieja (`none`/`stale`) | Revisa su diff antes de integrar. / La rama cambió después de tu revisión. |
| `failed` | `status = failed` | Motivo de `failure_reason` o «Terminó con error.» |

- Una revisión **rechazada** no genera Attention (el coordinador debe corregir). `exited` tampoco: solo `failed`.
- **Reservados:** `pending_spawn` (lanzamiento pendiente de aprobación) y `unanswered_question` (pregunta sin respuesta). Hoy el frontend los cuenta aparte (`useAttentionTotals`: `pending` y `questions`) sin un `kind`; G decide si pasan a ser kinds.
- **Modelo del Core (LXO-87):** `docs/core/ATTENTION.md` define las categorías cerradas (`question`, `approval`, `review_ready`, `conflict`, `failed`, `environment_blocked`, `risk`), la severidad (`critical`, `high`, `medium`, `low`) y el ciclo de vida (`active`/`resolved`). Los kinds de arriba son los del frontend vigente; LXO-88 los mapea a esas categorías.
- **Severidad (frontend):** no existe hoy. El plan de la Fase 1 dice que G toma los nombres de severidad de H; **H no los inventa**: mientras no se decida, la prioridad es la posición en la lista. Decisión pendiente del usuario/G (ver informe).
- Estado por persona y dispositivo (`visto`, `pospuesto`, `resuelto`) es del slice G, no del vocabulario de H.

## 6. Eventos y colisiones de palabras

**Tres familias de «evento»** (no se renombra ninguna):

1. *Transporte hacia la interfaz (vigente):* `orch:changed`, `orch:term:{id}`, `orch:term-exit:{id}`, `orch-task-reviewed`, `orch-spawn-pending`, `orch-spawn-resolved`. Mezclan `:` y `-` por historia; son contrato del frontend.
2. *Mensajes del buzón (vigente):* `Kind` (§4), guardados en `state.json`.
3. *Eventos de dominio durables (reservado, slice E):* `entidad.verbo`, p. ej. `attempt.requested|approved|rejected|started|waiting|completed|failed|stopped`, `attention.created|resolved` (lista completa en el contrato). Los efímeros (`attempt.progress`, `terminal.output`…) no se registran.

**`entity_kind`** (reservado; columna `events.entity_kind` del slice E y prefijo de cada evento durable): `project`, `task`, `attempt`, `thread`, `worktree`, `artifact`, `review`, `integration`, `agent`, `decision`, `policy`, `attention`. Los prefijos de los efímeros (`terminal`, `token`, `tool`) **no** son entidades.

**Colisiones conocidas** (se resuelven al hablar, no en el código):

| Palabra | Significados | Cómo decirlo |
|---|---|---|
| `Status` | `state::Status` (tarea) y `agents::Status` (política: `ok/blocked/unverified`) | «estado de la tarea» vs «estado de la política» |
| `exited` | estado de la tarea y tipo de mensaje del buzón | `Task.status = exited` vs `Kind::Exited` |
| `done` | estado de la tarea, tipo de mensaje y estado de una fase/ítem de todo | idem; en la interfaz «Terminada» / «Entrega» |
| `waiting` | `Status::Waiting` (pregunta al coordinador) y el grupo visual *waiting* (también cubre `awaiting_terminal_approval` en el Desktop) | el grupo visual se llama `needs_person` cuando espera a la persona |
| `STATUS_LABELS` | estados de tarea (`orchStore.js`) y estados de archivo de un diff (`TaskDiffView.jsx`) | desambiguado por archivo; no se renombra |
| `Run` | objetivo de orquestación (vigente) | **no** es el intento; el intento es `Attempt` |
| `review` | decisión (`review`), estado de Attention (`review`) y estado derivado de revisión | por contexto: `Decision.kind`, `attention_kind`, `review_state` |

## 7. Diferencias vigentes entre clientes (no se corrigen en H)

Cambiarlas cambiaría lo que ve la persona. Están declaradas en `presentation.known_divergences` del contrato y las pruebas exigen que la lista sea exacta.

1. **El móvil no conoce `awaiting_terminal_approval`:** `STATUS` de `RemoteOrch.js` no la trae, así que muestra el id crudo y `StatusMark` la dibuja como «en cola» (aro vacío). El Desktop la muestra como «Esperando aprobación en la terminal». Es el único hueco real; corregirlo es un cambio visible del móvil (probablemente una PR pequeña propia: etiqueta + marca ámbar).
2. **Redacción distinta:** móvil `done` = «entregó» vs Desktop «Terminada»; `failed` = «falló» vs «Fallida»; `waiting` = «esperando» vs «Esperando respuesta». Los demás coinciden salvo mayúscula inicial. El móvil usa verbos tras «Agente ·», el Desktop usa el estado; es una diferencia de frase, no de concepto, pero se declara.
3. **`lxo list` y la snapshot muestran el id de máquina** (`[running]`); el Desktop y el móvil muestran etiquetas. El plan menciona un campo `ui_state` en la snapshot: **no se añade en H** (cambiaría el formato HTTP) y queda para cuando se decida.
4. **`state.rs` documenta `Decision.kind` como `merge|pr|release|discard|reopen|stop`**, pero el código solo emite `merge`, `pr`, `review` y `spawn`.

## 8. Convenciones para los slices vecinos

- **Ids de máquina** (estados, kinds, códigos de error, motivos): `snake_case` en inglés, estables. Los textos legibles (español) van aparte y no se usan como clave ni se comparan.
- **Nombres de adaptadores/proveedores** (`claude`, `codex`, `lixbon-cli`, `windows-credential-manager`): minúsculas con guion, como los ids de agente ya existentes.
- **Eventos durables** `entidad.verbo` con `entity_kind` de la lista de §6; los de transporte a la interfaz conservan sus nombres actuales.
- **Tras el corte Task/Attempt** se aplica la correspondencia de §2/§3; antes, ningún código nuevo debe depender de los ids *reservados*.

## 9. Qué NO hace este slice

No renombra `Run`, `Task`, `Status` ni `Kind`; no añade enums ni campos al `State`; no añade `ui_state` a la snapshot; no genera copias de código (`gen-contracts.mjs` del plan original) ni toca el móvil, el TUI de Go o `lxo`; no define severidades de Attention ni estados de `Thread`/`Worktree`/`Artifact`.
