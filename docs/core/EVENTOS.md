# Event Log del Core (slice E)

Estado: **E1a — infraestructura** (migración `004_events`). Todavía no hay mutadores instrumentados:
eso es **E1b**. HTTP/SSE es **E2**. Nada de F1 (clientes), G (Attention) ni de la vista Activity.

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
  escapando `%` y `_`), el comando RPC y `lxo events` llegan en E1b. Los agentes solo verán su run.

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
* **`spawn`**: conserva su fila legacy pero **no emite** `decision.recorded`; lo representará
  `spawn.resolved` en el bloque de lanzamientos pendientes. Es la única excepción
  (`DECISION_KINDS_WITHOUT_EVENT`) y una prueba la fija contra el vocabulario.

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
llamador en `Effect.observed`; el constructor no consulta git. **Excepción temporal**: `spawn_outcome` (el
marcador de registro de la decisión `spawn`) sigue yendo al diario pero no emite `effect.observed` ni se
correlaciona; lo reformulará el bloque de lanzamientos pendientes.

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

### Seguridad de excepciones de `pty::spawn`
Una vez creado el proceso, cualquier `Err` posterior al construir el `AgentTerm` (`try_clone_reader`,
`take_writer`, tuberías de stdout/stderr) mata el proceso antes de devolver el error, tanto en `spawn_pty` como
en `spawn_piped`; y `Core::register_term` mata el terminal si no puede registrarlo. `AgentTerm` no mata al
soltarse (`Drop`): la compensación es explícita. El comportamiento normal de `on_exit` no cambia.

## Hoja de ruta
* **E1a (cerrada):** migración, almacén, `EventDraft`/`NewEvent`/`EventRow`, outbox en `Tx`, persistencia
  atómica con `legacy_state`, cursor básico, triggers, pruebas.
* **E1b (en curso; bloque 1 hecho = mutadores de `State`):** mutadores de `State`, decisiones, efectos, registro de proyectos, solicitudes de lanzamiento,
  API completa, `lxo events`, diario `unrecorded-effects` v2 e importación segura.
* **E2:** HTTP `GET /events` y SSE (`server.rs`).

## Fuera de E
Attention (G), clientes e identidad por credencial (F1), la vista Activity, eventos efímeros
(`terminal.output`…), retención/compactación, Task/Attempt.
