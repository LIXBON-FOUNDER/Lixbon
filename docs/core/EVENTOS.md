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

## Hoja de ruta
* **E1a (esta):** migración, almacén, `EventDraft`/`NewEvent`/`EventRow`, outbox en `Tx`, persistencia
  atómica con `legacy_state`, cursor básico, triggers, pruebas.
* **E1b:** mutadores de `State`, decisiones, efectos, registro de proyectos, solicitudes de lanzamiento,
  API completa, `lxo events`, diario `unrecorded-effects` v2 e importación segura.
* **E2:** HTTP `GET /events` y SSE (`server.rs`).

## Fuera de E
Attention (G), clientes e identidad por credencial (F1), la vista Activity, eventos efímeros
(`terminal.output`…), retención/compactación, Task/Attempt.
