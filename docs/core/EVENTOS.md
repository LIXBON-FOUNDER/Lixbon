# Event Log del Core (slice E)

Estado: **E1a cerrada; E1b en curso**. E1b instrumenta mutadores de estado, decisiones, efectos, Projects y
Pending Spawn, y expone la **API de lectura versionada** (LXO-83, ver «API de lectura»). `lxo events` (LXO-84) sigue
pendiente; SSE/streaming es **E2**. F1 (clientes), G (Attention) y la vista Activity siguen fuera de esta etapa.

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
* **Vocabulario de `entity_kind`:** `task` · `run` · `project` · `spawn_request` · `attention` · `core`. Una Attempt
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

## API de lectura (LXO-83)
Contrato `v = 1`, **solo lectura**. Dos puertas al mismo documento, ambas del Core (ningún cliente abre SQLite):

| Puerta | Quién | Cómo |
|---|---|---|
| RPC `events` (`orch_call` de la interfaz; `POST /rpc` con `{"cmd":"events","args":{…},"caller":"<tarea>"}`) | persona (interfaz) · agente con identidad | `args` = los parámetros de abajo |
| `GET /events?<parámetros>` en el servidor local (127.0.0.1, `Authorization: Bearer <token de orch.json>`) | agente con identidad: cabecera `X-Lixbon-Caller: <tarea>` | query string |

Cualquier otro método en `/events` es `405`; sin token válido, `401` (antes de revelar nada más). No hay comando
RPC ni ruta que escriba, borre o reescriba eventos.

### Parámetros
Todos opcionales; un parámetro desconocido, repetido o con tipo erróneo es un **error** (`invalid_filter`), nunca se ignora. La lista es cerrada: ningún otro nombre se admite, tampoco los que añaden otros comandos de `lxo` (por ejemplo `session`).

| Parámetro | Significado |
|---|---|
| `cursor` | entero decimal ≥ 0, por defecto `0`. Devuelve los eventos con `seq > cursor` (**exclusivo**). |
| `limit` | entero ≥ 1, por defecto `100`, máximo `500`: cualquier entero hasta 2⁶⁴−1 (número JSON o texto decimal) por encima de 500 se recorta a 500 y la respuesta informa el `limit` efectivo; más allá de 2⁶⁴−1 es `invalid_limit`. |
| `project` · `run` | igualdad con `project_id` / `run_id`. |
| `entity_kind` · `entity_id` | igualdad con la entidad (`task`·`run`·`project`·`spawn_request`·`attention`·`core`); `entity_id` exige `entity_kind`. |
| `kind` · `kind_prefix` | igualdad exacta o prefijo literal (sensible a mayúsculas, sin comodines); incompatibles entre sí. |
| `class` | `state` · `effect` · `decision` · `system`. |

Los filtros se combinan con AND, miden 1–128 caracteres y solo usan columnas ya indexadas por `seq`
(`project_id`, `run_id`, entidad) más `kind` y `class`. **No hay filtro por `correlation_id`, actor ni tiempo**: no
tienen índice y el esquema no cambia en este corte; quien necesite correlacionar lo hace sobre el payload
(`effect_id`, `pending_id`) leyendo por entidad.

### Respuesta (`200`)
```json
{
  "ok": true,
  "data": {
    "v": 1,
    "events": [
      {
        "seq": 2, "id": "01a13e36-607e-71eb-8e8d-43d75c9836d3", "ts": 1792045113470, "v": 1,
        "kind": "task.created", "class": "state",
        "actor": { "kind": "system", "id": null }, "channel": "core", "client_id": null,
        "project_id": null, "run_id": "r1",
        "entity": { "kind": "task", "id": "t2" }, "correlation_id": null,
        "payload": { "agent": "claude", "depth": 0, "external": true, "model": null, "parent": null, "role": null, "title": "raiz-humo-a" }
      }
    ],
    "next_cursor": 2, "has_more": true, "head_seq": 10, "limit": 2
  }
}
```
* Cada evento lleva **exactamente** estos campos: `seq`, `id`, `ts`, `v`, `kind`, `class`, `actor{kind,id}`,
  `channel`, `client_id`, `project_id`, `run_id`, `entity{kind,id}`, `correlation_id`, `payload`. Las claves
  nulas se emiten como `null`, no se omiten.
* Correspondencia con la fila persistida: `ts` = `at` (ms epoch, informativo: **no ordena**), `actor` =
  `actor_kind`/`actor_id`, `entity` = `entity_kind`/`entity_id`. «Tarea» no es un campo: es `entity` cuando
  `entity.kind = "task"` (y `actor.id` cuando el actor es un agente).
* **No se exponen** `idem_key` ni `state_rev` (mecánica interna de idempotencia y de agrupación de commits) ni
  nada que no estuviera ya persistido. El `payload` viaja como objeto JSON, tal como lo validó el Core al emitir.
* `events` va en orden **ascendente y total por `seq`**, sin repeticiones. Solo existe el sentido ascendente
  (el sentido inverso del almacén no forma parte del contrato).
* `head_seq`: el `seq` más alto del Core (0 si no hay eventos). Filas y `head_seq` salen de **una misma
  instantánea** de lectura: ninguna fila supera `head_seq`.
* `next_cursor`: **siempre** el valor que se pasa como `cursor` en la siguiente petición. Con `has_more = true`
  es el `seq` del último evento devuelto; con `has_more = false` es `head_seq`. Como `seq` se asigna en orden de
  commit y la instantánea contiene todo lo anterior a `head_seq`, ningún evento que cumpla los filtros queda
  entre medias: un cliente filtrado puede avanzar hasta `head_seq` sin releer.

### Cursor y `seq`
* `seq` es el `AUTOINCREMENT` de la tabla: **estrictamente creciente, nunca se reutiliza** y sobrevive a
  reinicios (el diario está en SQLite). Un cursor guardado sigue valiendo tras reiniciar el Core.
* El cursor es el `seq` en decimal, tanto como número JSON como texto (`"cursor": "42"`). No se admiten
  signos, espacios, decimales ni valores fuera de `i64` (a diferencia de `limit`, el cursor no se recorta: se rechaza).
* Un cursor **mayor que `head_seq`** no puede venir de este Core (base restaurada o sustituida): `409 cursor_ahead`,
  para que el cliente reinicie su lectura en vez de esperar eventos que ya existen con otra identidad.
* Un cursor válido jamás queda caducado: no hay retención ni compactación (fuera de E).

### Errores
`{"ok": false, "error": "<texto para personas>", "code": "<código>"}`. Por RPC el campo `error` llega como
`"<código>: <texto>"` (el envoltorio de RPC no tiene `code`).

| `code` | HTTP | Cuándo |
|---|---|---|
| `invalid_cursor` | 400 | `cursor` no es un entero decimal ≥ 0 |
| `invalid_limit` | 400 | `limit` no es un entero ≥ 1 |
| `invalid_filter` | 400 | parámetro desconocido/repetido/vacío/demasiado largo, `class` desconocida, combinaciones prohibidas, URL mal codificada |
| `forbidden` | 403 | sin identidad, tarea inexistente, orquestador desactivado, o `run` ajeno |
| `cursor_ahead` | 409 | `cursor > head_seq` |
| `event_log_unavailable` | 503 | SQLite no es la autoridad (modo `state.json`/degradado) o falta la migración 004 |
| `internal` | 500 | fallo de lectura o payload ilegible (el detalle no sale del Core) |

### Autorización
* **Persona (interfaz)**: lee todo el diario.
* **Agente con identidad** (`Caller::Agent(Some(tarea))`): el Core fuerza `run = <su run>`; pedir otro run es
  `forbidden`, pedir el suyo es válido. Ve los eventos con `run_id` de su run; **no** ve los de proyecto sin run
  (`project.*`) ni los de otros runs. Con el orquestador desactivado no lee.
* **Sin identidad** (`Caller::Agent(None)`, token pero sin tarea): `forbidden`. El token de `orch.json` identifica
  «una terminal del usuario», no «el usuario»; abrir una lectura global para quien no es una tarea es una decisión
  de autoridad que queda para el cliente CLI/F1 (identidad por credencial), no para este corte.
* **La identidad del agente es declarada, no autenticada.** `X-Lixbon-Caller` (y el campo `caller` de
  `POST /rpc`) lo escribe el cliente y se acepta si la tarea existe; el `Bearer` es **un único token del proceso**
  publicado en `orch.json` (legible por el usuario, igual que el resto de procesos del usuario), sin credencial
  por tarea. Una tarea que lea `orch.json` puede declarar el id de otra y leer su run; lo mismo ocurre ya con
  los demás comandos de `lxo` que identifican por `caller`. El alcance por run acota lecturas por error o por rol,
  **no es aislamiento frente a un agente hostil** y no debe presentarse como tal. Cerrarlo exige una credencial
  por tarea emitida al lanzarla (variable de entorno privada) que el servidor compare con el `caller`; eso cambia
  `orch.json`, `lxo` y el lanzamiento, y queda fuera de este corte. Un id inexistente sigue siendo `forbidden`.
* Leer no escribe: no cambia `rev`, no añade eventos, no toca `state.json`.

### Seguir (follow) y sondeo
**Sin streaming en este corte.** El servidor local es un hilo por conexión con respuestas de
`Content-Length` y cierre inmediato, y los avisos del Core (`orch:changed`) no llevan carga ni cursor. Un
follow seguro (SSE o long-poll) exige un canal de notificación del COMMIT, límites de conexiones y de tiempo, y
decidir qué pasa con una conexión de un agente que muere; eso es E2 y no cambia la autoridad (el diario sigue
siendo la verdad, el stream solo avisaría). Hasta entonces el contrato de **sondeo** es:

1. Primera lectura con `cursor=0` (o `cursor=<head_seq>` de una lectura previa para «solo lo nuevo»).
2. Repetir con `cursor = next_cursor`. Si `has_more` es `true`, repetir **sin esperar**; si es `false`,
   dormir entre 0,5 y 2 s (con retroceso si la respuesta viene vacía repetidamente).
3. Guardar `next_cursor` de forma durable en el cliente; reanudar con él tras cualquier reinicio.
4. Ante `cursor_ahead`, descartar el cursor y volver a empezar (la base ya no es la misma).

Una extensión futura **aditiva** (`wait_ms` acotado para long-poll, o SSE) no cambia estas reglas.

### Contrato mínimo congelado para LXO-84 (`lxo events`)
Estable en `v = 1`; cualquier cambio incompatible sube `v` del envoltorio:
* Ruta `GET /events` y comando RPC `events` con los parámetros y errores de arriba.
* Los 14 campos de cada evento y su significado; `seq` entero positivo estrictamente creciente.
* Semántica de `cursor` (exclusivo), `next_cursor`, `has_more`, `head_seq`, `limit` (100/500).
* Códigos de error y su estado HTTP; alcance por run de los agentes (sobre identidad declarada, ver Autorización).
* Lista cerrada de parámetros: `session` no es un parámetro válido de `events`, y un cliente `lxo events` no debe reenviarlo ni reenviar ningún otro nombre fuera de la lista.

Abierto (no congelado): sentido inverso, filtros por tiempo/actor/correlación, lectura global sin tarea,
long-poll/SSE. El contenido de cada `kind`/`payload` lo define su propio `v`.

### Ejemplos
```sh
# datos de conexión: ~/.lixbon/orch.json (port, token)
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Lixbon-Caller: $LXO_TASK_ID" \
  "http://127.0.0.1:$PORT/events?limit=2"
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Lixbon-Caller: $LXO_TASK_ID" \
  "http://127.0.0.1:$PORT/events?cursor=2&kind_prefix=task.&limit=100"
curl -s -H "Authorization: Bearer $TOKEN" -H "X-Lixbon-Caller: $LXO_TASK_ID" \
  "http://127.0.0.1:$PORT/events?entity_kind=task&entity_id=t3"

# lo mismo por RPC
curl -s -H "Authorization: Bearer $TOKEN" \
  -d '{"cmd":"events","args":{"cursor":2,"class":"decision"},"caller":"t3"}' "http://127.0.0.1:$PORT/rpc"
```
Error: `GET /events?cursor=abc` → `400 {"ok":false,"code":"invalid_cursor","error":"`cursor` debe ser un entero decimal >= 0"}`.

### Dónde vive
`orch/events_read.rs` (validación, alcance, JSON) → `Store::events_page` (SQL con parámetros, un solo
`SELECT` por página). `server.rs` solo enruta `GET /events`; `rpc.rs` solo despacha `events`. Una prueba de
arquitectura impide `rusqlite` o SQL de eventos en esas tres capas.

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
* **Diario**: el writer nuevo usa `v = 2` y conserva el mismo `effect_id` y la hora. Las líneas `v = 1` siguen
  siendo diagnósticas/manuales: no reciben IDs inventados ni se importan al Event Log. Reconciliar no repara
  `legacy_state` (ver «Journal v2 y reconciliación»).

### Payload (cerrado por `effect_kind`, `operation` validada contra valores conocidos)
| `effect_kind` | `operation` | Campos (además de `effect_id`) |
|---|---|---|
| `git_merge` | `integrate` | `result` (`merged`·`conflict`·`error`), `branch`, `base_commit?`, `result_commit?` |
| `git_push_pr` | `publish_pr` | `result` (`created`·`already_exists`·`error`), `branch`, `pr_url?` |
| `git_worktree` | `spawn` | `branch`, `base?` |
| `git_worktree_removed` | `release`·`close_idle_runs`·`spawn_cleanup` | `worktree_removed`, `branch?`, `branch_deleted` |
| `pty_process` | `spawn` | `launched` |

### Journal v2 y reconciliación
Cada línea nueva de `unrecorded-effects.jsonl` tiene `v: 2`, el `effect_id` UUID v7 original, `at` (cuándo se
anotó el efecto), `operation`, `kind`, `task`, `run`, `project`, `actor_kind`, `actor_id`, `channel` y un
objeto `observed` filtrado al contrato del efecto. Ejemplo:

```json
{"v":2,"effect_id":"01900000-0000-7000-8000-000000000001","at":1800000000000,"operation":"spawn","kind":"pty_process","task":"t1","run":"r1","project":null,"actor_kind":"system","actor_id":null,"channel":"core","observed":{"launched":true}}
```

Una línea heredada v1 se conserva opaca para revisión; no se le asigna identidad ni se importa:

```json
{"v":1,"operation":"integrate","kind":"git_merge","observed":{"outcome":"merged"},"error":"legacy diagnostic"}
```

El writer no guarda `expected`, texto de error, campos desconocidos de `observed`, `argv`, `env`, diff ni body.
`pr_url` pasa por el mismo saneador (`pr_url.rs`) en el camino normal (`effect.observed` y `decision.recorded`)
y en el replay: solo `http(s)://host[:puerto]/segmentos`, sin usuario, contraseña, query ni fragmento; la ruta
admite únicamente `A-Za-z0-9._~-` (controles, `;`, `%`, `@` o `\` la invalidan). Una URL que no se puede
sanear se omite del hecho, no se recorta. `Task.pr_url` (estado legacy) no forma parte del contrato de
eventos y no se toca. El lector mantiene las líneas v1 para revisión manual y nunca las convierte en hechos.

Al arrancar con SQLite autoritativo, cada v2 válido (UUID v7 canónico en minúsculas, actor y canal coherentes,
`at` positivo) se transforma en el `effect.observed` tipado y se inserta con el `effect_id` original como
`payload.effect_id`, `correlation_id` e `idem_key`, y con `at` igual al del journal: el Event dice cuándo
ocurrió el efecto, no cuándo se reconcilió (`seq` sigue ordenando). La recuperación no invoca Git, PTY ni
filesystem. Un duplicado `(kind, idem_key)` es éxito: si el proceso cae después del commit y antes del ACK,
el siguiente arranque reintenta solo la inserción idempotente. Dos líneas con el mismo `effect_id` pero
distinto contenido (`at` aparte) son un conflicto: no se importan ni se compactan.

**La reconciliación NO repara `legacy_state`.** El registro original falló y su mutación se descartó entera
(sin estado ni eventos); la recuperación solo añade el hecho `effect.observed` (`state_rev = NULL`). Tarea,
rama, PR o proceso pueden seguir sin reflejar lo que ocurrió. Por eso, tras recuperar efectos, el arranque
avisa a la persona (`Lixbon: acciones recuperadas, estado sin reparar`) con la operación, el tipo y la tarea
de cada uno (máximo 5, sin datos del efecto), y le pide comprobar el estado antes de repetirlos. Quien
decida repetir una acción debe hacerlo después de comprobarlo: un nuevo intento es un efecto distinto con su
propio `effect_id`.

El ACK es la compactación del archivo tras confirmar el Event: se escribe un temporal en el mismo directorio,
se sincroniza y se renombra atómicamente (el temporal se borra si algo falla). Solo se quitan líneas v2
confirmadas; v1, truncadas, corruptas, de una versión que este binario no conoce (`v` ≥ 3 o campos
desconocidos), con identidad inválida o conflictivas quedan para revisión manual y se avisan en cada
arranque. Un registro inválido no bloquea los posteriores. Si falla la compactación, el v2 sigue presente,
se avisa por el log y el replay es seguro.

Si el journal no se puede escribir (disco lleno, permisos, registro demasiado grande), el error que recibe el
llamador lo dice (`TAMPOCO se pudo anotar…`, con el `effect_id`) y no afirma que la anotación exista; el log
solo recibe identificadores no sensibles (`effect_id`, `operation`/`kind`, `task` y la clase del error de E/S).

Durabilidad: cada línea se sincroniza con `sync_data` antes de devolver `Ok`. Al crear el archivo se sincroniza
además el directorio que lo contiene, y la compactación sincroniza el directorio tras el `rename`, donde el SO
lo permite (Unix). **En Windows no se sincroniza el directorio**: `std` no ofrece un flush de directorio
(haría falta `CreateFileW` con `FILE_FLAG_BACKUP_SEMANTICS` y `FlushFileBuffers`, que exige permisos de
escritura sobre el directorio). Allí el contenido sí está sincronizado, pero la entrada de directorio de un
journal recién creado o de un `rename` puede perderse ante un corte de energía; el efecto quedaría entonces
sin rastro, como en la ventana siguiente.

Ventanas que permanecen: una caída después del efecto externo y antes de persistir una línea v2 puede dejarlo
sin rastro; una línea v2 parcialmente escrita requiere revisión manual (la siguiente escritura la separa con
un salto de línea y no la pierde); el fallo al escribir el journal (ver arriba); y la durabilidad de la
creación o el `rename` en Windows.

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
artefactos del intento). Si falla la persistencia tras el cleanup físico: ni estado ni eventos, y el diario v2.

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
* **Un kill dudoso es un error.** `TreeKiller::kill` solo da `Ok` si COMPRUEBA que no queda ningún proceso del árbol
  vivo; que el comando de matar arrancara, saliera con estado cero o que la raíz haya muerto no prueba nada. Ante la
  duda (tabla de procesos ilegible, vacía o truncada; identidad no probable; árbol que cambia sin parar) es `Err`, el
  proceso sigue custodiado y no se borra nada. Garantías exactas por plataforma en «Kill verificado del árbol».
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
* **La vida de un proceso se decide por su identidad, no por su pid.** Ver «Kill verificado del árbol». (`pid_alive`,
  basado en `tasklist`/`ps`, quedó solo como ayuda de las pruebas.)
* **Core degradado también en `release` y `free_worktrees`.** Sin poder registrar el borrado no se mata un terminal
  ya registrado ni se borra worktree, rama o Task (`release` devuelve `Err`; `free_worktrees` lo deja en `kept`,
  «Core en solo lectura»). La única acción destructiva permitida con el Core degradado sigue siendo matar un proceso
  spawneado y no registrado (`abandon_attempt`).
* **`task.branch` no sobrevive a su rama** en `release` y `free_worktrees`: si `branch -d` la borró, la Task
  retenida pasa a `branch = None` (la identidad histórica queda en `effect.observed`); si `-d` falló, conserva su rama.
  Nunca `-D`.
* **La salida natural de la raíz no suelta el terminal sin barrer su árbol.** `Core::on_exit` presta el matador y ejecuta
  un `kill_tree` final (grupo de procesos / Job aún consultables) ANTES de retirar el terminal: que la raíz haya salido
  no prueba que hayan salido sus descendientes (un servidor en segundo plano). Si el barrido se comprueba, el terminal
  sale como siempre; si no (tras el único reintento), el terminal queda en el mapa —`exited`, con su matador de vuelta,
  visible en `live`— y la Task se cierra `Exited` pero `release`, `abandon_attempt` y `free_worktrees` conservan el
  worktree («proceso sin detener») hasta que un cleanup posterior lo compruebe. Con una terminación ya en curso no se
  barre: lo hace ese kill (sin cambios).
* **Ninguna confirmación vacía.** `apply_found` decide por el estado previo: Task retirada o ya final, o sondeo sin
  informe válido fuera del cierre del proceso, es `no_change()` (el sondeo de cada segundo avanzaba la `rev` de toda
  Task viva). `record_codex_model` solo confirma si algún campo del modelo cambia (un `on_exit` repetido no).
* **Causalidad (sin cambios, ahora fijada por prueba).** `effect.observed` y `task.removed` del cleanup van
  contiguos y con el mismo `state_rev`; `task.removed` no lleva `correlation_id` (solo `decision.recorded` se
  correlaciona con el efecto).

### Kill verificado del árbol (LXO-18)
Implementado en `src/proctable.rs` (`kill_tree`) y usado por `pty::TreeKiller`. Un pid NO identifica un proceso (se
reutiliza), así que cada proceso es `Proc { pid, start }` con `start` = hora de creación. Reglas comunes:

* Solo se mata un proceso cuya identidad se comprueba justo antes (`Os::terminate`); un proceso verificado muerto sale de
  `seen` y no se vuelve a tocar; una raíz verificada muerta no vuelve a ser origen de descendientes. Nunca se mata un pid
  ajeno.
* `Ok` exige una ronda COMPLETA en la que ningún proceso rastreado sigue vivo, no apareció ninguno nuevo y nada quedó sin
  probar; `ROUNDS = 20` rondas con 50 ms (~1 s) y luego `Err`. Una tabla vacía, sin este proceso o interrumpida es
  «no fiable».
* La descendencia se localiza por tres vías que se refuerzan, porque el recorrido por `ppid` no ve a un nieto cuyo padre
  intermedio ya salió:

| plataforma | identidad `start` | vías de descubrimiento | garantía |
|---|---|---|---|
| Windows | FILETIME (instante real, comparable: un hijo no es anterior a su padre) | `ppid` + **Job Object** al crear la raíz, solo si el proceso abierto tiene la misma hora de creación capturada | el job lista a todos los procesos vivos del árbol, también huérfanos con `ppid` colgando; se termina con el mismo handle que se verifica |
| Linux | `starttime` de `/proc/<pid>/stat` en ticks de 10 ms (token solo para igualdad); `ppid`, `pgrp` y `starttime` salen de la misma lectura del archivo, leída EN BYTES (el nombre del proceso no tiene por qué ser UTF-8) | `ppid` + **grupo de procesos** de la raíz (`process_group(0)` al lanzar, `setsid` en la PTY) leído recorriendo `/proc` | los huérfanos reparentados a init que siguen en el grupo se encuentran y se matan uno a uno con identidad comprobada, si se PRUEBA que el grupo es nuestro (abajo) |
| macOS | hash normalizado de `ps lstart` (resolución de 1 s, `TZ=UTC` y `LC_ALL=C` fijados; solo igualdad) | igual, con una única instantánea de `ps -e -o pid=,ppid=,pgid=,stat=,lstart=` | igual. **No demostrado:** un falso «mismo proceso» exige reutilizar el pid y arrancar en el mismo segundo; es una suposición de caudal, no una prueba. Identidad fina (`proc_pidinfo`, µs) pendiente. Sin ejecutar en un macOS real |
| otros Unix | como macOS | como macOS | **sin garantía** (pids aleatorios en FreeBSD/OpenBSD) |

* **Unix y el número de grupo: la propiedad se prueba, no se supone.** Un `pgid` solo está reservado mientras alguien lo
  ocupa, y un grupo con el líder muerto es indistinguible de uno ajeno que reutilizó el número (su líder murió dejando
  hijos). Una sola lectura da los miembros, su token y quien ocupa el PID `pgid`. Son nuestros si: (1) la raíz sigue sin
  reapear (viva o zombi: ocupa el pid y nadie más puede ser ese pid ni crear ese grupo); (2) el ocupante tiene el token de
  la raíz; (3) un miembro YA verificado en esa lectura sigue dentro (continuidad). Si el ocupante tiene OTRO token el
  grupo es ajeno: no se toca y el número se retira. Sin ocupante ni miembros el grupo murió y el número se retira. En
  cualquier otro caso: `Err`, custodia y nada se mata. Nunca `kill(-pgid)`.
  Para que (1) no se pierda, el hilo que espera a la raíz (`proctable::wait_root`, piped y PTY) usa `waitid(WNOWAIT)`
  (crate `libc`, solo Unix): la raíz queda zombi, se anotan los miembros del grupo y SOLO después se reapea, todo bajo el
  candado del `Arc<Mutex<Tree>>` que comparte con el `TreeKiller`. Mientras un `kill_tree` tiene el árbol, la raíz que
  muere sigue de ancla: lo que nazca entre dos instantáneas se descubre y se mata, y una raíz que sale sola dejando un
  proceso en segundo plano (que retiene las tuberías) deja el grupo anotado para el kill posterior. **Residuo:** todos los
  miembros anotados mueren solos, la raíz ya está reapeada y queda un nacido posterior sin anotar → `Err` y custodia.
* **Procesos ilegibles (`/proc` con `hidepid`).** Un `stat` ilegible por permisos de un proceso de OTRO usuario ya no
  invalida la tabla de todos: es un pid «opaco» (existe, no se puede leer). Un pid rastreado opaco está sin probar (no
  muerto) y el kernel (`/proc/<pid>/task/*/children`) dice si un opaco es hijo de algo rastreado: entonces el veto es
  persistente aunque su padre muera. Un opaco sin relación visible se omite (no se puede atribuir ni, siendo de otro
  usuario, matar). Un fallo de lectura de un proceso del PROPIO usuario, o cualquier error no clasificado, sigue
  invalidando la lectura. Límite: un hijo de otro usuario cuyo padre ya murió, bajo `hidepid`, es invisible.
* **Identidad de la raíz.** Se reintenta (acotado, `CAPTURE_TRIES`) al crearla, con su pid seguro. Si aun así falta y la
  raíz sigue sin reapear (pin), se toma al matar; si no, `Err` y custodia (nunca se mata un pid sin identidad).
* **Residuales (no cubiertos):** un proceso que se desvincula a propósito tras perder a su padre (`setsid`/`setpgid` a
  otro grupo, daemonización) escapa a las tres vías; en Unix la identidad se comprueba justo antes de `kill -9` (dos
  llamadas, sin handle que ancle el pid; ventana de decenas de milisegundos con carga: no es una garantía); un proceso creado por la raíz antes de entrar en el
  Job (microsegundos) solo lo cubre el recorrido por `ppid`. Cubrirlos exigiría un contenedor del sistema (cgroups).
* **Pruebas.** Mundo simulado determinista (`proctable::tests::World`, corre en Windows) para cada carrera: nacido entre
  instantáneas con la raíz zombi de ancla, raíz que sale dejando un huérfano (con y sin observación), pin roto, número
  reutilizado por un líder ajeno (vivo o muerto), zombi sin token, opacos rastreados/ajenos/hijos, identidad de la raíz.
  Procesos reales: Job Object en Windows; grupo de procesos, `waitid(WNOWAIT)`, el waiter sin reapear durante un kill y
  un nombre de proceso no UTF-8 en `#[cfg(unix)]`, y `orch::pty` (`TreeKiller::new` tras `spawn_piped`/PTY y la raíz que
  sale dejando un proceso que retiene las tuberías). Se han ejecutado en un Linux real (WSL2, kernel 6.6, binario musl
  compilado desde Windows); la rama macOS solo se compila (`cargo check --target aarch64-apple-darwin`) y NO se ha
  ejecutado.

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

### Denegación explícita de policy: `spawn.requested` con `policy_status = blocked` (LXO-88)
Una solicitud **válida** que una decisión explícita de policy deniega deja `spawn.requested` con
`policy_status = blocked` **antes** de devolver la denegación. Nada más cambia en el contrato del Event (sin campo
nuevo, sin motivo de policy, sin `argv`/`cwd`/`env`).

```text
spawn_request(caller, args)
  plan_spawn                       -> entrada inválida?  Err, SIN Event   (agente/modelo/esfuerzo/perfil/rol/combinación
                                                                           proveedor × perfil; padre sin vida; profundidad)
  task_policy(...)                 -> status = Blocked?
      agents::explicit_denial(...) -> None   (CLI ausente, flags, sandbox, ruta…): Err como siempre, SIN Event
                                   -> Some(ProfileDisabled): check_parent_live + record_facts(spawn.requested)
                                        fallo de persistencia -> Err(fallo)           (NO se devuelve una denegación «registrada»)
                                        éxito                 -> Err(denegación)      (el Event ya es durable)
  ok / unverified                  -> camino de aprobación de siempre
```

* **Qué es una denegación explícita** lo decide un tipo, no el texto de `Policy.reason`: `agents::PolicyDenial`
  (hoy solo `ProfileDisabled`, vía `Profile::disabled_reason()`), y solo si la combinación proveedor × perfil tiene
  definición (`profile_flags`). Un bloqueo del entorno o del proveedor sigue siendo un error sin Event.
* **Entrada inválida ≠ policy:** `agents::check_request` conserva la validación que hacía `launch` (agente
  conocido y no pausado, modelo y esfuerzo admitidos, rol existente, combinación proveedor × perfil definida) y NO
  aplica la compuerta de policy. Así «`gemini` + perfil» o «rol inventado» son errores, no solicitudes denegadas.
* **Invariante que sostiene a `risk`:** todo `spawn.requested` con `policy_status = blocked` del log se emitió por
  este camino, es decir, por una denegación explícita. El Event no lo dice por sí mismo; lo garantiza la emisión
  (`spawn_blocked_tests`). Si algún día otra causa explícita (o un bloqueo del entorno) debe registrarse, el Event
  necesitará un discriminador durable (ver `ATTENTION.md`, «Gaps de señal»).
* **Sin efectos:** la rama bloqueada no crea pendiente en memoria, Task, aprobación, `orch-spawn-pending`, aviso,
  PTY, proceso ni worktree. **No habrá `spawn.resolved`**: la solicitud nace y termina denegada. Una consulta de
  `spawn_status` responde `expired` y aprobarla no resuelve nada.
* **Cada RPC es un intento nuevo** (otro `pending_id`, otro Event); los reintentos del *append* de un mismo Event
  reutilizan su `(kind, idem_key)` y no duplican.
* Sin Event Log (`state.json`/degradado) no hay dónde registrar: con el Core en solo lectura la persistencia falla y
  se informa ese fallo, no la denegación.

### Reinicio
Los pendientes viven en memoria y todavía no se reconstruyen ni se reconcilian al arrancar. Este cambio no añade
`abandoned_on_restart` ni ningún otro outcome de reinicio. La reconciliación durable de solicitudes pendientes
queda en un seguimiento separado. Consecuencia para Attention: el `approval` de un lanzamiento pendiente se
resuelve con `spawn.resolved`; si el Core reinicia con un pendiente sin resolver, ese `approval` sigue activo hasta
que la reconciliación emita su resolución. Una solicitud `blocked` no tiene pendiente que reconciliar.

## E1b · Attention: `attention.created` · `attention.resolved` (LXO-88)
Ciclo de vida de una ocurrencia de Attention (`ATTENTION.md`). `class = state`, entidad `attention`,
`entity_id = correlation_id = idem_key = attention_items.id` (como mucho UN `created` y UN `resolved` por
ocurrencia, así que un replay no duplica), actor `system`, canal `core`.

| kind | Payload (solo códigos e ids) |
|---|---|
| `attention.created` | `category`, `severity`, `occurrence`, `target_kind`, `target_id`, `source_event_id?` |
| `attention.resolved` | `resolution` (`acted` · `condition_cleared` · `superseded`), `source_event_id` |

* **Misma transacción que su origen.** Cada escritor del Event Log (`commit_authoritative_with_events`,
  `append_events` y los cambios de gestión de Project) ejecuta el proyector del almacén después de insertar y antes
  de confirmar (`EventProjector`): el Event origen, las filas de Attention y estos eventos se confirman o se
  deshacen juntos. Los eventos derivados se insertan **después** de los de origen de esa transacción
  (`insert_derived_in`, sin reproyectarlos); el orden entre eventos de origen no cambia.
* Actualizar `severity`/`facts` de la activa **no** emite nada (no hay `attention.updated`).
* `source_event_id` es el `events.id` (no el `seq`) del Event que levantó o resolvió.

## Hoja de ruta
* **E1a (cerrada):** migración, almacén, `EventDraft`/`NewEvent`/`EventRow`, outbox en `Tx`, persistencia
  atómica con `legacy_state`, cursor básico, triggers, pruebas.
* **E1b (en curso; hechos: mutadores de `State`, decisiones, efectos, Projects, Pending Spawn, journal
  `unrecorded-effects` v2 y API de lectura LXO-83):** `lxo events` (LXO-84).
* **E2:** SSE/long-poll de seguimiento (el `GET /events` de sondeo ya existe).

## Fuera de E
La API de lectura de Attention (LXO-89), clientes e identidad por credencial (F1), la vista Activity, eventos efímeros
(`terminal.output`…), retención/compactación del Event Log, Task/Attempt.
