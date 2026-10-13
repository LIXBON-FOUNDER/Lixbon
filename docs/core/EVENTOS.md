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
son **hechos distintos**. Este bloque solo emite la decisión; `outcome` es el valor de la fila legacy. En el
bloque de Effects, cuando un camino ejecute realmente un efecto externo, se emitirán ambos —
`decision.recorded` y `effect.observed`— correlacionados por el mismo `effect_id` (desde la frontera
`mutate_after_effect`). Un camino que no ejecutó un efecto (`target_moved`, `already_merged`, una revisión)
no inventa `effect.observed`. `already_merged`, `review_required` y `head_moved` no crean decisión ni evento.

## Hoja de ruta
* **E1a (cerrada):** migración, almacén, `EventDraft`/`NewEvent`/`EventRow`, outbox en `Tx`, persistencia
  atómica con `legacy_state`, cursor básico, triggers, pruebas.
* **E1b (en curso; bloque 1 hecho = mutadores de `State`):** mutadores de `State`, decisiones, efectos, registro de proyectos, solicitudes de lanzamiento,
  API completa, `lxo events`, diario `unrecorded-effects` v2 e importación segura.
* **E2:** HTTP `GET /events` y SSE (`server.rs`).

## Fuera de E
Attention (G), clientes e identidad por credencial (F1), la vista Activity, eventos efímeros
(`terminal.output`…), retención/compactación, Task/Attempt.
