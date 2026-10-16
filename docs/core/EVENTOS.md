# Event Log del Core (slice E)

Estado: **E1a cerrada; E1b en curso**. E1b instrumenta mutadores de estado, decisiones, efectos, Projects y
Pending Spawn. La API del diario y `lxo events` siguen pendientes de E1b; HTTP/SSE es **E2**. F1 (clientes), G
(Attention) y la vista Activity siguen fuera de esta etapa.

## Qué es
Un *evento* es un **hecho estructurado y durable**: qué ocurrió (`kind`), quién lo provocó (actor), sobre
qué entidad y en qué proyecto, y los datos propios del hecho (payload tipado). SQLite es la **única
autoridad**: no existe `events.json` ni un segundo log. El estado actual sigue siendo `legacy_state`
(no es event sourcing); el Event Log es la **historia autoritativa de hechos desde su despliegue**, sin
relleno histórico.

## Esquema (`004_events.sql`)
| Columna | Para qué |
|---|---|
| `seq` (`AUTOINCREMENT`) | **Orden autoritativo y único cursor.** No se reutiliza nunca. |
| `id` (UUID v7, único) | Identidad global del evento (sincronización futura). |
| `at` | ms epoch. **Informativo: no ordena.** |
| `v` | Versión del contrato (`kind` + forma del payload). |
| `kind` | Tipo del hecho (1–64 caracteres). |
| `class` | `state` · `effect` · `decision` · `system` (solo estas cuatro). Es la CLASE del hecho, no el módulo que escribió la fila. |
| `actor_kind`, `actor_id` | `person` · `agent` · `system`; un agente exige su tarea en `actor_id`. |
| `channel` | Transporte: `ui` · `lxo` · `core`. No es una identidad. |
| `client_id` | Reservado para F1; `NULL` en E. |
| `project_id`, `run_id`, `entity_kind`, `entity_id` | **Referencias blandas** (sin `REFERENCES`). |
| `correlation_id` | Une hechos (p. ej. el `pending_id` de una solicitud y su resolución). |
| `idem_key` | Idempotencia, **por tipo**: `UNIQUE (kind, idem_key) WHERE idem_key IS NOT NULL`. |
| `state_rev` | `rev` de `legacy_state` del COMMIT que lo confirmó. Agrupa los hechos de una misma mutación. `NULL` si no tocó `legacy_state`. |
| `payload` | JSON válido y como mucho **8 KiB medidos en bytes** (`length(CAST(payload AS BLOB))`). |

* **Append-only impuesto por la base:** `UPDATE` y `DELETE` abortan (triggers). Si algún día hace falta
  retención o compactación será una migración explícita que cambie esa propiedad a propósito.
* **`entity_kind` y `channel` se validan en Rust, sin `CHECK`:** ampliarlos obligaría a reconstruir una
  tabla append-only con los triggers desactivados. `class` y `actor_kind` son conjuntos cerrados.
* **Referencias blandas:** archivar un proyecto, borrar un run o revocar un cliente no toca su historia.
  "Blanda" no es "sin validar": el Core comprueba al emitir.
* **Vocabulario de `entity_kind`:** `task` · `run` · `project` · `spawn_request` · `core`. Una Attempt
  futura será un valor nuevo.

## Cómo nace un evento (outbox en `Tx`, no en `State`)
```text
mutador -> EventDraft -> Tx::push_event          (candidato de `mutate`, junto a `notify`)
mutate_locked: validar y FINALIZAR UNA VEZ  ->  NewEvent  (id UUID v7, hora, actor, payload)
Persistence::persist(&state, &events):
    BEGIN IMMEDIATE
      UPDATE legacy_state  rev N -> N+1
      INSERT events        state_rev = N+1
    COMMIT
solo entonces: la memoria se sustituye y se publica
```
* `State` **no** transporta eventos: el outbox vive en `Tx` y se descarta con el candidato.
* **Rollback total:** si cualquier `INSERT` (o la `rev`, o el documento) falla, la transacción entera se
  deshace: ni mutación ni eventos, y la memoria no cambia.
* **Retry:** `id`, hora, actor y payload se materializan **antes** del bucle de reintentos; cada intento
  recibe exactamente los mismos `NewEvent`. Un `BUSY` no los regenera ni los duplica.
* **Un evento inválido rechaza la mutación** (`MutateError::Rejected`) en vez de degradar el Core a
  solo lectura: es un error de contrato, no un fallo de almacenamiento.
* **Sin cambio (`no_change`) o con rechazo:** los borradores se descartan.
* **Modo legacy/degradado (`state.json`):** no hay Event Log (`Persistence::records_events() == false`).
  Los borradores se **finalizan y validan siempre**, igual que con SQLite: la semántica de una mutación
  no puede depender del backend, y un borrador inválido es `Rejected` en ambos. Solo **después** se
  decide dónde persistir: sin Event Log, el resultado materializado se descarta antes de persistir y el
  backend recibe una lista vacía. No se crea ningún archivo paralelo.
* **Una base sin la 004** (promovida pero todavía sin migrar) sigue confirmando mutaciones SIN eventos
  como siempre: con la lista vacía no se toca la tabla.
* **Hechos que no tocan `legacy_state`** (registro de proyectos, solicitudes de lanzamiento) usan su
  propia transacción (`Store::append_events`), `state_rev = NULL`. Si además cambian otras filas, filas y
  evento van en **una** transacción (E1b).

## Payload
Solo lo produce un constructor **tipado**: `EventDraft::new::<P: EventPayload>(entidad, &payload)`. No hay
forma de crear un borrador desde un `serde_json::Value` arbitrario (por ejemplo, llegado por RPC). Nunca
entran cuerpos de mensaje, informes, diffs, `argv`, `env` ni credenciales; identificadores y hechos
pequeños, sí.

## Lectura (E1a: cursor básico)
`Store::events_page(EventQuery { after, before, limit, newest_first })`:
* `after = N` → `seq > N` · `before = N` → `seq < N` · **nunca inclusivo**; sin `OFFSET`.
* `limit` por defecto 100, máximo **500** (se recorta); `0` o un cursor negativo son un error.
* Devuelve `events`, `has_more`, `next_cursor` (el `seq` del último evento devuelto) y `head_seq`.
* Los filtros por proyecto/entidad/run/`kind` (exacto **o** prefijo, parámetros distintos, con `LIKE`
  escapando `%` y `_`), el comando RPC y `lxo events` siguen pendientes de E1b. Los agentes solo verán su run.

## Un solo punto de emisión
`Tx::push_event` es el único punto de entrada de un evento a la transacción; `INSERT INTO events` solo
existe en `store/events.rs`; los borradores solo se construyen en `orch/events.rs`. Las pruebas de
arquitectura (`orch/events_tests.rs`) fallan si otra capa los usa. En E1b los mutadores semánticos de
`Tx` (`Tx::done`, `Tx::ask`…) delegarán en los mutadores puros de `State` y acumularán **exactamente un**
borrador; los internos (`touch`, `post`) no emiten.

## E1b · bloque 1: mutadores de `State`
La instrumentación llega por bloques sobre la infraestructura de E1a (decisiones → efectos → Projects →
lanzamientos pendientes → diario v2 → lectura/`lxo events`). Este bloque instrumenta los mutadores de
`State`.

### Quién actúa: `MutationContext`
Cada mutación lleva un contexto **explícito**: `{ actor, channel, client_id }` (`client_id` siempre `None`
hasta F1). Se pasa con `Core::mutate_as(&ctx, ..)`; `Core::mutate(..)` es el contexto del propio Core
(arranque, vigilantes, temporizadores). No hay hilo local ni «caller actual» global, y el canal **no se
deduce del actor**: lo fija la superficie que recibe la orden.

| Superficie | Canal | Quién entra |
|---|---|---|
| Comandos de Tauri (`rpc_via(Channel::Ui, ..)`, `*_from_ui`, aprobar un lanzamiento) | `ui` | persona |
| Servidor local de `lxo` (`rpc_via(Channel::Lxo, ..)`) | `lxo` | agente con identidad |
| Arranque, vigilantes de terminal, temporizadores | `core` | sistema |
| Recogida de informes (`collect`) | `core` | agente (informe válido aceptado) · sistema (inválido, no entregado, sin informe, fallback) |

* `Caller::Agent(None)` **no** tiene alcance ni autoría general: solo `run_create` lo admite, y dentro de
  esa mutación el actor pasa a ser la tarea raíz recién creada (bootstrap de identidad).
* `StateAccess` ya no se implementa para `Core` sino para `Acting` (el `Core` con un contexto explícito),
  y sus cierres reciben `&mut Tx`. `impl StateAccess for Mutex<State>` es **solo de pruebas**: construye un
  `Tx` detached, valida los borradores como producción y descarta los eventos.

### Mutadores de `Tx` (un hecho, un evento)
`orch/tx_ops.rs` define, sobre `Tx`, los mismos mutadores que `State` (mismo nombre y firma, delegan en él).
Son el **único** sitio que emite estos eventos; `delivery::apply` recibe `&mut Tx` y cierra con
`tx.done`/`tx.close`, sin construir borradores. `post`, `touch`, `mark_read` no emiten.

| Mutador | Eventos (en orden) |
|---|---|
| `create_run` | `run.created {root_task}`, `task.created` (raíz) |
| `add_child` | `task.created` |
| `mark_running`, `done`, `close`, `reopen`, `await_terminal_approval`, `resume_from_approval`, `fail_with` | `task.status_changed` **solo si el estado cambió** |
| `phase` | `task.phase {name, done}`, y `task.status_changed` si cambió (p. ej. `waiting → running`) |
| `ask` | `task.question`, y `task.status_changed` (`→ waiting`) |
| `reply` | `task.reply {question_id, message_id}` (entidad: la tarea que preguntó; actor: quien responde), y `task.status_changed` de ésta si volvió a correr |
| `orphan_all` | un `task.status_changed` por tarea abierta no externa (`cause = orphaned`) |
| `close_run` | un `task.status_changed` por tarea que cambió (`cause = run_closed`) y, al final, `run.closed` |
| `remove_run` | `run.removed` (si el run existía) |

* `task.status_changed` compara el estado de las tareas del run **antes y después**: nunca se emite con
  `from == to`.
* `cause` (opcional): `question`, `answered`, `phase`, `reopened`, `terminal_approval`, `orphaned`,
  `run_closed`, o el motivo máquina de un fallo por vigilancia (`terminal_approval_timeout`,
  `agent_idle_timeout`).
* Los payloads llevan identificadores y hechos pequeños. **Los textos libres no se copian**: ni el
  objetivo del run (`Run.objective`), ni la nota de una fase, ni el cuerpo de una pregunta o respuesta
  (`messages`), ni informes ni `argv`. El Event Log no es otra copia del estado. Solo el título de una
  tarea (etiqueta corta de la entidad) y el nombre de la fase (recortado) viajan como texto.
* Quién respondió a una pregunta es el **actor** del evento, no un campo: `task.reply` no lleva
  `answered_by`. Si algún día hace falta el remitente del `Message` heredado, será `message_from_task`.

### Atribución de `collect`
La decisión del contexto vive en `term_events` (`apply_found`); `delivery::apply` sigue sin construir
eventos ni elegir actores. El agente produce —o no— el informe; el Core diagnostica su ausencia o
invalidez y decide el cierre:

| Resultado | Actor / canal |
|---|---|
| Informe válido aceptado | `agent(<tarea>)` / `core` |
| Informe inválido al salir, no entregado, o proceso sin informe (`failed`/`exited`) | `system` / `core` |
| Fallback del Core cuando un informe válido no se puede aplicar | `system` / `core` |

### `project_id`
Se resuelve **al finalizar** el evento, con una fuente explícita del borrador: `project` explícito →
`project_from_task` (lee `Task.project_id` del candidato) → `NULL`. Sin git y sin consultar el registro.
Por eso `run_create` puede completar `project_id` después de crear el run y antes del commit.

### No retroactivo
El Event Log **empieza cuando la infraestructura ya es autoritativa**. No se rellenan `messages` ni
`decisions` históricos, ni lo ocurrido antes de la 004, ni las tareas huérfanas que se cierran durante la
**primera promoción** a SQLite (ocurren dentro de la transacción de promoción, no de `mutate`). En
arranques posteriores las huérfanas sí emiten.

## E1b · bloque 2: decisiones (`decision.recorded`)
Un único evento, **`decision.recorded`** (`class = decision`, `v = 1`), lo emite SOLO `Tx::record_decision`
(`orch/tx_ops.rs`), que envuelve `State::record_decision`:

1. valida la tarea, el actor y el contrato del `detail`;
2. escribe la fila legacy (`State.decisions`) y obtiene su `decision_id`;
3. añade exactamente un borrador cuando `decision_kind` ∈ `review | merge | pr`.

`integration.rs`, `review.rs`, `spawn_approval.rs`, el RPC y la interfaz **no construyen** el borrador.
Si el detalle no cumple el contrato, o el `kind` es desconocido, la mutación completa se rechaza (sin fila,
sin evento, sin cambios de estado).

* **Entidad**: `task` (la tarea sobre la que se decide; `Decision.id` se reutiliza tras `remove_run`, no
  puede ser identidad). `project_id` por `project_from_task`. **Sin `idem_key`** (revisar dos veces la misma
  rama es legítimo) y sin `correlation_id` por ahora.
* **Actor**: la fila legacy dice quién decide (`"human"`, `"system"` o una tarea) y el `MutationContext`
  debe ser realmente ese actor. Además `review`, `merge` y `pr` exigen **Person / Ui** (regla por `kind`,
  no global: los lanzamientos pendientes podrán decidir como sistema).
* **`spawn`**: conserva su fila legacy pero **no emite** `decision.recorded`; `Tx::record_spawn_resolution`
  registra la fila y `spawn.resolved` juntos en una mutación. `cancelled_run_removed` no deja fila porque el run
  y la tarea padre se borran en esa misma mutación. Es la única excepción al registro genérico; la
  prueba la fija contra el vocabulario.

### Payload (cerrado por `decision_kind`)
| `decision_kind` | Campos | Nunca |
|---|---|---|
| `review` | `decision_id`, `outcome` (`accepted`·`rejected`), `head_commit`, `base_commit?`, `base_source?`, `has_comment` | `comment` |
| `merge` | `decision_id`, `outcome` (`merged`·`conflict`·`error`·`target_moved`), `branch`, `squash`, `base_commit?`, `result_commit?`, `conflict_count?`, `base_check?`, `accepted_moved_target?`, `expected_commit?`, `found_commit?` | `into`, mensajes de git, lista de archivos en conflicto |
| `pr` | `decision_id`, `outcome` (`created`·`already_exists`·`error`), `branch`, `pr_url?` | `remote`, error textual |

### Decisión y efecto
Una decisión de la persona y el efecto externo que provoca (`git merge`, push + `gh pr create`, lanzamiento)
son **hechos distintos**: `decision.recorded` (`outcome` es el valor de la fila legacy) y `effect.observed`
(ver «E1b · bloque 3»), correlacionados por el mismo `effect_id`. Un camino que no ejecutó un efecto
(`target_moved`, `already_merged`, una revisión, un PR ya registrado) no inventa `effect.observed`.
`already_merged`, `review_required` y `head_moved` no crean decisión ni evento.

## E1b · bloque 3: efectos externos (`effect.observed`)
Un único evento, **`effect.observed`** (`class = effect`, `v = 1`, entidad `task`, `project_from_task`), lo
emite SOLO `Tx::observe_effect`, que invoca únicamente la frontera `StateAccess::mutate_after_effect`.

### Contrato de `mutate_after_effect`
* **Solo se llama si hubo un efecto externo real.** La única forma de decir «no hubo efecto» es no llamarla
  (mutación normal). Ejemplos: un `Task.pr_url` ya registrado (no se ejecuta push ni `gh`), `release` sin
  worktree ni rama borrados, `target_moved`.
* **Cualquier fallo posterior** (`Rejected`, `Persist`, `ReadOnly`, o un `tx.no_change()` del cierre, que es
  inválido) deja el candidato sin publicar —ni estado ni eventos— y anota el efecto en
  `unrecorded-effects.jsonl`. El efecto ya ocurrió: es un efecto sin registrar, también si el registro lo
  rechaza el propio cierre.
* **Orden canónico**: `observe_effect` entra al `Tx` ANTES de ejecutar el cierre (el efecto ocurrió antes que
  cualquier hecho que lo registre): `effect.observed`, `decision.recorded`, resto de hechos de estado. Si el
  cierre falla se descarta el candidato entero.
* **Identidad**: `Effect::new` genera un `effect_id` (UUID v7) una sola vez. Es la identidad de la ocurrencia
  observada y tiene tres usos del mismo identificador: `payload.effect_id` (contenido),
  `correlation_id` (relación) e `idem_key` (unicidad `(kind, idem_key)`; no interfiere con un futuro
  `effect.unrecorded` de la misma ocurrencia).
* **Correlación**: `Tx::record_decision` consulta el efecto activo y pone ese `effect_id` como
  `correlation_id` de `decision.recorded`. Los demás hechos de estado (`task.status_changed`,
  `task.created`…) NO se correlacionan.
* **Actor**: `effect.observed` captura el actor y el canal vigentes al observar (un `set_context` posterior no
  lo reatribuye), igual que las decisiones.
* **Ventana abierta**: `Effect` se construye cuando el efecto ya ocurrió; si el proceso cae entre el efecto
  externo y la construcción o el registro del `Effect`, no queda rastro. E1b no pretende cerrarla (no es un
  protocolo intención/confirmación).
* **Diario**: sigue en `v = 1` y todavía no persiste el `effect_id`; el diario v2 y la importación idempotente
  son un bloque posterior.

### Payload (cerrado por `effect_kind`, `operation` validada contra valores conocidos)
| `effect_kind` | `operation` | Campos (además de `effect_id`) |
|---|---|---|
| `git_merge` | `integrate` | `result` (`merged`·`conflict`·`error`), `branch`, `base_commit?`, `result_commit?` |
| `git_push_pr` | `publish_pr` | `result` (`created`·`already_exists`·`error`), `branch`, `pr_url?` |
| `git_worktree` | `spawn` | `branch`, `base?` |
| `git_worktree_removed` | `release`·`close_idle_runs`·`spawn_cleanup` | `worktree_removed`, `branch?`, `branch_deleted` |
| `pty_process` | `spawn` | `launched` |

Nunca rutas locales, `env`, `argv`, mensajes de error ni credenciales. Los datos estructurales los pone el
llamador en `Effect.observed`; el constructor no consulta git. No existe un efecto `spawn_outcome`: las
resoluciones de spawn son decisiones `spawn.resolved`, no efectos.

Invariantes (un call site no puede inventar un efecto que no ocurrió): `pty_process.launched` debe ser
`true`; `git_worktree_removed` exige `worktree_removed || branch_deleted`, y `branch_deleted` exige `branch`
presente y no vacía (un cleanup solo de rama es `worktree_removed = false, branch_deleted = true`).

**Pertenencia histórica**: `observe_effect` captura `run_id` y `project_id` de la tarea EN ESE MOMENTO y los
fija en el borrador (nunca `project_from_task`): el cierre que registra el efecto puede retirar la tarea, y
una resolución al finalizar ya no la encontraría. Sin git ni registro de proyectos.

Fuera de este bloque (sin evento de efecto): matar terminales (`kill_term`; el hecho es el
`task.status_changed` o `task.removed`; **no hay evento para el kill**), el archivo de informe,
`delivery::prepare`, `type_prompt` y las observaciones de aprobación en terminal.

## E1b · bloque 3b: cleanup de un lanzamiento fallido (`task.removed`)
`create_child` crea la Task ANTES de cualquier efecto (worktree, proceso). Si el lanzamiento falla, el Core
(no la persona que lo aprobó) deshace el intento y registra dos hechos distintos de «la solicitud de spawn
terminó en `launch_failed`» (que será `spawn.resolved`):

* `task.removed { cause: "launch_failed" }` (`class = state`, entidad `task`, actor **system / core**, sin
  `idem_key`): lo emite SOLO `Tx::remove_failed_launch`, que captura `run_id` y `project_id` ANTES de borrar y
  los pone explícitos. Exige contexto System / Core. La cascada de `State::remove_task` retira las decisiones
  legacy de la tarea y los mensajes que la citan; con hijas, o siendo la raíz de un run, falla sin eliminar nada.
* `effect.observed` de `git_worktree_removed` con `operation = "spawn_cleanup"` si se borró de verdad el
  worktree o la rama. Va primero en la misma mutación (`mutate_after_effect`, System / Core).

### `SpawnAttempt`
El intento es un objeto local (no durable): `task`, `repo`, `worktree`, `branch`. Solo fija `worktree` y
`branch` cuando `git::add_worktree` devolvió `Ok`; un `add_worktree` fallido (p. ej. «ya existe la carpeta») no
da propiedad sobre esa ruta, que nunca se borra. El cleanup NO depende de `Task.worktree`: el worktree puede
existir en disco sin que el estado lo sepa (el registro pudo fallar).

### Política del cleanup
Orden: 1) se captura si la Task es retirable (no final y run abierto) ANTES de matar nada; 2) se mata el proceso
vivo y no registrado —también con el Core degradado— y, si no hay control fiable sobre él (el matador falla),
se conserva TODO y el terminal vuelve al mapa; 3) con el Core degradado (`Health != Normal`: un `Persist` o
`ReadOnly` degradan, un `Rejected` no) NO se borra worktree, rama ni Task; 4) se retira el worktree del
intento y, si tuvo éxito, se intenta `git branch -d` (nunca `-D`; `branch_deleted` es el resultado real; un
fallo de `-d` no impide retirar la Task); si `remove_worktree` falla la Task se conserva; 5) un único registro
(`mutate_after_effect` si hubo borrado git; `mutate` si solo hay que retirar la Task): `effect.observed` y, si
la Task era retirable, `task.removed`. Una Task ya final o con el run cerrado se conserva (solo se limpian los
artefactos del intento). Si falla la persistencia tras el cleanup físico: ni estado ni eventos, y el diario v1.

| Fallo | Resultado |
|---|---|
| `add_worktree` falla | Task retirada (`task.removed`); la ruta ajena intacta; sin efecto git |
| worktree creado, registro rechazado y Core sano | worktree y rama retirados con los datos del intento; `effect.observed` + `task.removed`; el registro rechazado queda en el diario |
| worktree creado, registro `Persist`/`ReadOnly` | todo se conserva; diario |
| `ensure_launchable` falla (run cerrado / Task final) | Task conservada; solo `effect.observed` de cleanup |
| `launch` falla antes del proceso | `effect.observed` + `task.removed` |
| `launch` OK y falla el registro de `pty_process` (Core sano) | kill + `effect.observed` + `task.removed` |
| ídem con el Core degradado | solo kill; Task y worktree se conservan |
| sin control sobre el proceso | todo se conserva |
| hija `shared` | `task.removed` sin efecto git |

### Endurecimiento del cleanup
* **Custodia del terminal.** `register_term` mata el proceso con `try_kill` y comprueba el resultado. Si el mapa
  está envenenado y tampoco se puede matar, el terminal NO se pierde: se guarda recuperando el guard
  (`PoisonError::into_inner`, ruta de emergencia) y el proceso sigue bajo la custodia del Core —la Task y el
  worktree se conservan—. `kill_term_checked` recupera ese terminal de un mapa envenenado y, si el kill vuelve a
  fallar, lo deja otra vez almacenado. Nunca se suelta un `AgentTerm` con el proceso potencialmente vivo.
* **Un kill dudoso es un error.** `TreeKiller::kill` ya no da por bueno que el comando de matar arrancara: un
  estado distinto de cero es `Err`. Conservar la Task y el worktree ante la duda es mejor que borrar con el agente
  quizá vivo. Única excepción: que el proceso **ya no exista** (`taskkill` sale con 128 si terminó justo antes;
  observado 1 de cada ~60 ejecuciones): se comprueba mirando si el pid sigue vivo y, si esa comprobación no puede
  hacerse, se asume vivo. Deuda preexistente, sin tocar: en Unix `kill -9` solo alcanza al proceso raíz, no a su árbol.
* **Rama de una Task preservada.** Si la Task se conserva (final o run cerrado) y `branch -d` borró la rama,
  `task.branch` pasa a `None` (además de `worktree = None` y `cwd = repo`); si `branch -d` falló, conserva su rama.
  No se marca `merged`: fue un lanzamiento fallido, no una integración.
* **`on_exit` tardío.** Si la Task ya no existe o ya estaba final, la mutación hace `no_change()` (decidido por el
  estado previo, no por `close() == Ok(None)`): no avanza `rev` ni deja eventos.

### Endurecimiento final (LXO-18)
Mismo principio: ante la duda, el proceso está vivo, el terminal sigue custodiado y no se borra nada. Sin eventos nuevos.

* **Ningún camino suelta un terminal cuyo kill falló.** `Core::kill_term` ya no hace `remove` + `kill` ignorando el
  resultado: devuelve `Result<bool, String>` sobre `kill_term_checked` (el terminal vuelve al mapa si el kill falla).
  `release` y `lxo stop` devuelven `Err` sin tocar ni el estado ni el disco; `remove_run` (UI) aborta antes de borrar
  el run; `close_run` no cuenta el terminal como cerrado y `free_worktrees` conserva (`kept`, «proceso sin detener»)
  el worktree de toda tarea cuyo terminal sigue custodiado. En `on_guard_timeout` el terminal queda custodiado.
* **Compensación comprobada tras un fallo de construcción (`pty::spawn_pty`/`spawn_piped`).** El kill del árbol y el
  directo ya no se descartan: si ninguno prueba que el proceso murió, pasa a una custodia estática (`UNOWNED`) con su
  matador, el `Err` lo dice («queda bajo la custodia de Lixbon») y `Core::shutdown` lo reintenta (`pty::reap_unowned`).
  Solo se espera al hijo (`wait`) si se pudo matar: antes un `wait` tras un kill fallido podía bloquear para siempre.
* **`pid_alive` no confunde un fallo de la herramienta con «no existe».** Windows: `tasklist` con estado distinto de
  cero (consulta no válida) es «vivo»; solo una salida con éxito que no nombra al pid prueba que murió. Unix: `ps`
  sale con 1 cuando ningún proceso coincide; cualquier otro estado con la salida vacía es «vivo».
* **Core degradado también en `release` y `free_worktrees`.** Sin poder registrar el borrado no se mata un terminal
  ya registrado ni se borra worktree, rama o Task (`release` devuelve `Err`; `free_worktrees` lo deja en `kept`,
  «Core en solo lectura»). La única acción destructiva permitida con el Core degradado sigue siendo matar un proceso
  spawneado y no registrado (`abandon_attempt`).
* **`task.branch` no sobrevive a su rama** en `release` y `free_worktrees`: si `branch -d` la borró, la Task
  retenida pasa a `branch = None` (la identidad histórica queda en `effect.observed`); si `-d` falló, conserva su rama.
  Nunca `-D`.
* **Ninguna confirmación vacía.** `apply_found` decide por el estado previo: Task retirada o ya final, o sondeo sin
  informe válido fuera del cierre del proceso, es `no_change()` (el sondeo de cada segundo avanzaba la `rev` de toda
  Task viva). `record_codex_model` solo confirma si algún campo del modelo cambia (un `on_exit` repetido no).
* **Causalidad (sin cambios, ahora fijada por prueba).** `effect.observed` y `task.removed` del cleanup van
  contiguos y con el mismo `state_rev`; `task.removed` no lleva `correlation_id` (solo `decision.recorded` se
  correlaciona con el efecto).

### Seguridad de excepciones de `pty::spawn`
Una vez creado el proceso, cualquier `Err` posterior al construir el `AgentTerm` (`try_clone_reader`,
`take_writer`, tuberías de stdout/stderr) mata el proceso antes de devolver el error, tanto en `spawn_pty` como
en `spawn_piped`; y `Core::register_term` mata el terminal si no puede registrarlo. `AgentTerm` no mata al
soltarse (`Drop`): la compensación es explícita. El comportamiento normal de `on_exit` no cambia.

## E1b · Projects, commit 1: nacimiento de un Project (`project.registered`)
El registro de proyectos (D) no vive en `State`: sus escrituras son transacciones propias de SQLite. Para que la
fila y su hecho nazcan juntos, `orch/project_ops.rs` hace de «`tx_ops` del registro»: es el **único** que
construye y finaliza los borradores de Projects y el único que le entrega un `NewEvent` al almacén
(`store/projects.rs` recibe `NewEvent`, nunca `EventDraft`).

| campo | valor |
|---|---|
| `kind` / `class` / entidad | `project.registered` · `state` · `project` |
| `project_id` | el id del proyecto (el mismo de la fila) |
| `run_id` | `NULL` |
| `idem_key` | `project_id` |
| `state_rev` | `NULL` (no toca `legacy_state`) |
| payload (cerrado) | `{ origin: manual \| auto \| backfill \| import, name, has_remote, root_commit_count }` |

* **Solo nace con la fila.** No hay `created`: el evento existe únicamente cuando `projects` recibió el `INSERT`.
  Encontrar un proyecto ya registrado (misma ruta, un worktree), una ambigüedad, o un `join` **no** lo emiten.
  `project.location_added`, archivar/restaurar y relocalizar están definidos en E1b · Projects, commit 2.
* **Nunca** lleva ruta, `display_path`, remoto, commits ni huella: la identidad física del repositorio vive en el
  registro, no en el log. `name` se recorta a 120 caracteres.
* **Atomicidad.** `project_ops::register_project` pre-genera el `project_id` y finaliza el evento FUERA de la
  transacción; `Store::project_register` hace `BEGIN IMMEDIATE · INSERT projects · INSERT project_locations ·
  INSERT events (state_rev = NULL) · COMMIT`. Un fallo en cualquiera de los tres lo deshace todo (también un evento
  que ya existía por `(kind, idem_key)`: no se registra un proyecto sin su hecho).

### Quién provoca cada origen (se valida, no se supone)
| origen | actor | canal |
|---|---|---|
| `manual` (`project_add` nuevo) | persona | `ui` |
| `backfill` (relleno de tareas anteriores a D) | sistema | `core` |
| `import` (carpetas recientes de la interfaz) | sistema | `ui` |
| `auto` (`run_create`) | persona · agente (su tarea) · sistema (agente sin identidad) | el de la petición |

Un par origen/actor que no cumple la tabla rechaza el registro entero (sin fila ni evento).

### Frontera de escritura del registro y `Health`
* `registry_read` / `registry_read_opt` reciben un `&Store`: **una lectura nunca escribe** (el compilador lo
  impide), tampoco el `machine_id` lazy: sin él todavía no hay ubicaciones en esta máquina.
* `registry_write` / `registry_write_opt` son el único camino de escritura y comprueban `Health` antes de abrir
  el almacén. Con el Core en `DegradedReadOnly` rechazan toda creación, `location_put`, `meta_set`, relleno,
  importación y escritura de marcas `ok ↔ missing`. `projects_list` y la guarda de lanzamiento siguen leyendo y
  calculan `missing` solo en memoria.

### Referencias históricas
Los ids nuevos se validan **al asignarlos**; el Event Log preserva referencias históricas y **no consulta el
Project Registry al finalizar** (`finalize_all` no hace SQL). `project_id` sigue siendo una referencia blanda.

## E1b · Projects, commit 2: decisiones de gestión de un Project
Un Project que ya existe cambia por decisión de una **persona por la interfaz** (`person/ui`, validado por
`project_ops::Management` antes de cualquier escritura; por `lxo` o el Core se rechaza). Cuatro hechos, todos
`class = decision`, entidad `project`, `project_id`, `run_id` NULL, **sin `idem_key`** (archivar, restaurar y
volver a archivar es legítimo) y `state_rev` NULL. Nunca copian rutas, remotos, huellas ni commits.

| kind | cuándo | payload |
|---|---|---|
| `project.location_added` | `join`: una ubicación nueva para un proyecto existente | `{ primary, fingerprint_adopted }` |
| `project.archived` | `active → archived` | `{}` |
| `project.restored` | `archived → active` | `{}` |
| `project.relocated` | `project_locate`: la nueva ubicación pasa a ser la principal | `{ fingerprint_adopted, confirmed_mismatch }` |

* `primary` es lo que se ESCRIBIÓ (la ubicación quedó como principal), no una intención. `fingerprint_adopted`
  es `true` solo si la huella guardada **cambió de verdad**. `confirmed_mismatch` es `true` únicamente cuando la
  persona usó `confirm` para aceptar un repositorio cuyos commits raíz no coincidían.
* **Una transacción por decisión.** `Store::project_join_recorded` / `project_relocate_recorded` hacen
  `ubicación + posible cambio de huella + evento`; `project_set_archived_recorded` hace `estado + evento`. Un fallo
  en cualquier paso lo deshace todo: nunca «ubicación nueva + huella vieja» ni «cambios sin evento». Los tres
  reciben un `NewEvent` ya materializado por `project_ops.rs` (el único que construye estos hechos), construido
  dentro del closure que ya serializa el almacén pero ANTES de abrir `Store::write`, sin E/S externa.
* **Resultado explícito:** `ChangeOutcome::{Missing, Unchanged, Changed}`. Solo `Changed` escribe filas y evento.
  Archivar un archivado, restaurar un activo, relocalizar a una ruta que ya es la principal (`ok`, mismo
  `display_path`, sin cambio de huella) o unir una ruta que ya era del proyecto: **0 eventos** y ni siquiera se
  toca `last_seen`/`updated_at`. Una ruta que ya es de OTRO proyecto es `ProjectConflict` (rollback).
* **Guarda de snapshot.** `FingerprintChange { from, to }` lleva la huella que la política leyó; la transacción
  comprueba que sigue siendo la guardada y, en `join`, que «es la principal» sigue siendo cierto EN ESA MÁQUINA (la principal es por `(project_id, machine)`: la de otra máquina no cuenta y la primera ubicación de una máquina nueva es su principal). Si no, rollback:
  el payload no puede describir un estado que ya no existe.
* Las APIs del almacén que cambiaban filas sin su hecho (`location_put`, `project_set_fingerprint`,
  `project_set_archived`, `project_create`) son `#[cfg(test)]`; una prueba de arquitectura impide usarlas en
  producción. Con el Core en `DegradedReadOnly` las cuatro decisiones se rechazan (frontera `registry_write`).

## E1b · Pending Spawn: solicitud y resolución durables
`spawn.requested` y `spawn.resolved` registran el ciclo de aprobación humana. La solicitud existe primero como
hecho durable; luego se inserta en memoria y se emiten `orch-spawn-pending` y el aviso. Si el almacenamiento está
degradado, el padre terminó o el run se cerró, no se guarda la solicitud ni se publica un pendiente.

```text
Core::record_facts(ctx, drafts)
  Health != Normal            -> ReadOnly, SIN finalizar ni intentar nada
  finalizar + validar UNA vez -> Rejected si un borrador no cumple el contrato (nada se persiste)
  sin Event Log (state.json)  -> el resultado materializado se descarta con éxito
  Persister::append           -> reintentos con los MISMOS NewEvent (mismo id, hora e idem_key)
    -> Persistence::append    -> Store::append_events (su propia transacción, state_rev = NULL)
  fallo definitivo            -> Core en DegradedReadOnly (igual que una mutación normal)
```

* **No** incrementa la `rev` de `legacy_state`, **no** escribe el espejo `state.json`, **no** publica un `State`
  nuevo ni emite `orch:changed`.
* **No hay otra vía SQL:** la única inserción es `Store::append_events`; `SqlitePersistence::append` no toca la
  `rev` ni la transacción del estado.
* **Idempotencia:** repetir la misma `(kind, idem_key)` es un éxito que no duplica (`DO NOTHING`).
* **`Tx::no_change()` no confirma eventos** (una mutación sin cambios descarta su outbox). Un hecho que no cambia
  el estado se registra con `record_facts`, no forzando una mutación ni subiendo la `rev` para guardarlo.
* El `project_id` de un borrador con `project_from_task` se resuelve contra el estado CONFIRMADO.

### Contrato de los hechos
* `spawn.requested` es `class = state`; `spawn.resolved` es `class = decision`. Ambos usan la entidad
  `spawn_request`, `entity_id = pending_id`, `correlation_id = pending_id` e `idem_key = pending_id`.
* El payload de `spawn.requested` contiene `parent_task`, `provider`, `profile`, `role?`, `model?`, `effort?`,
  `title` (recortado), `shared`, `policy_status` y `expires_at`. No copia el encargo, `argv`, `cwd`, `env`, rutas,
  motivos de política ni credenciales.
* El payload de `spawn.resolved` contiene `outcome`, `task?` y `has_reason`; nunca copia el texto del rechazo o
  del error de lanzamiento. Los outcomes cerrados son `approved`, `rejected`, `launch_failed`, `timeout`,
  `coordinator_closed` y `cancelled_run_removed`. `expired` solo es el estado compatible de la API; no es un
  outcome del Event Log.
* Con padre presente, la fila legacy `Decision(spawn)` y `spawn.resolved` se confirman juntos. Al quitar un run,
  las cancelaciones y `run.removed` comparten la misma mutación; esas cancelaciones no dejan fila spawn. Si el
  padre ya no está, la resolución se registra standalone con `state_rev = NULL`, conservando el `run_id` y el
  `project_id` capturados en la solicitud.
* Las resoluciones por la persona son `person/ui`; `timeout` y `coordinator_closed` son `system/core`. En
  aprobación, la compuerta serializa `Pending → Launching → create_child → spawn.resolved`; `remove_run` toma la
  misma compuerta antes de capturar tareas, limpiar terminales/worktrees y borrar el run. Así una hija aprobada
  entra en la limpieza del run.
* Los eventos y el aviso de una solicitud se emiten bajo esa misma compuerta, antes de permitir una resolución
  concurrente. Por eso la UI nunca recibe una tarjeta pendiente después de su resolución.

### Reinicio
Los pendientes viven en memoria y todavía no se reconstruyen ni se reconcilian al arrancar. Este cambio no añade
`abandoned_on_restart` ni ningún otro outcome de reinicio. La reconciliación durable de solicitudes pendientes
queda en un seguimiento separado.

## Hoja de ruta
* **E1a (cerrada):** migración, almacén, `EventDraft`/`NewEvent`/`EventRow`, outbox en `Tx`, persistencia
  atómica con `legacy_state`, cursor básico, triggers, pruebas.
* **E1b (en curso; hechos: mutadores de `State`, decisiones, efectos, Projects y Pending Spawn):** API completa,
  `lxo events`, diario `unrecorded-effects` v2 e importación segura.
* **E2:** HTTP `GET /events` y SSE (`server.rs`).

## Fuera de E
Attention (G), clientes e identidad por credencial (F1), la vista Activity, eventos efímeros
(`terminal.output`…), retención/compactación, Task/Attempt.
