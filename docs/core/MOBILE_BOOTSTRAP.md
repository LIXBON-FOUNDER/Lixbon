# Bootstrap observacional de Mobile (LXO-107)

Estado: **implementado**. Mobile arranca su vista observacional desde la [snapshot compacta del
Core](QUERIES.md#compact_snapshot) (LXO-94) y sigue los cambios por el Event Log desde su cursor, sin el
webview ni la interfaz de Desktop. Solo lectura: no hay comandos operacionales, push ni cola offline.

## Ruta e identidad

```
App móvil ──(cuenta Lixbon + sesión /remote)──► gateway /remote ──► IDE (host) ──(Person + Desktop, F1)──► Core
```

* **El Core no recibe al móvil directamente.** Solo escucha en `127.0.0.1`. Además, según F1
  ([CLIENT_IDENTITY.md](CLIENT_IDENTITY.md)), una Person de superficie Mobile no lee el Event Log
  (`EventLogRead` es solo de Desktop y CLI). LXO-107 **no cambia F1**.
* **El móvil se autentica ante el gateway** con su cuenta: la API key de la app vive en `SecureStore`
  (`apps/mobile/src/state.js`) y la sesión `/remote` tiene que ser suya (el gateway lo comprueba).
* **El IDE hace las lecturas con su identidad Desktop de F1** (`orch_call` → `Core::rpc_via(Channel::Ui)`):
  `compact_snapshot` (`ClientAction::Read`) y `events` (`ClientAction::EventLogRead`). Son lecturas, así que
  no generan Events atribuidos.
* **Deuda explícita:** el Core ve estas lecturas como del cliente Desktop. Una identidad Mobile propia ante
  el Core (credencial Person + Mobile y su permiso sobre el Event Log) es un cambio de F1 que queda fuera de
  LXO-107.

## Protocolo del relé (v1)

El móvil manda un comando `orch` con un `rid` y el IDE responde con un evento **efímero** con el mismo `rid`.
El gateway reparte esos eventos en vivo, pero no los guarda en el replay ni en la base de datos.

| Petición (`orch` + `action`) | `args` | Respuesta (evento) |
|---|---|---|
| `core_snapshot` | `rid`, `attention_items?` (0–20) | `orch_core_snapshot` · `{rid, ok, protocol: 1, snapshot}` |
| `core_events` | `rid`, `cursor` (entero ≥ 0), `limit?` (1–200, por defecto 100) | `orch_core_events` · `{rid, ok, protocol: 1, events, next_cursor, has_more, head_seq}` |
| `core_attention` (LXO-109) | `rid`, `project_id?`, `category?`, `severity?`, `cursor?` (texto opaco), `limit?` (1–100, por defecto 50) | `orch_core_attention` · `{rid, ok, protocol: 1, items, next_cursor, has_more}` |
| `core_task` (LXO-110) | `rid`, `project_id`, `task_id` | `orch_core_task` · `{rid, ok, protocol: 1, task}` |
| `core_activity` (LXO-110) | `rid`, `task_id`, `cursor?` (entero ≥ 0; 0 = lo más nuevo), `limit?` (1–50, por defecto 30) | `orch_core_activity` · `{rid, ok, protocol: 1, items, next_cursor, has_more}` |
| `core_attempts` (LXO-126) | `rid`, `task_id` | `orch_core_attempts` · `{rid, ok, protocol: 1, task, attempts, truncated}` |
| `core_attempt` (LXO-126) | `rid`, `attempt_id` | `orch_core_attempt` · `{rid, ok, protocol: 1, attempt}` |

* `rid`: 1–64 caracteres `[A-Za-z0-9_-]`. Sin `rid` válido, la petición no llega al Core.
* `events[]` va **reducido**: `seq`, `kind`, `ts`, `project_id`, `run_id` y `entity {kind, id}`. No lleva
  `payload`, actor, cliente ni correlación (`apps/desktop/src/lib/remoteCore.js`).
* Si falla, la respuesta es `{rid, ok: false, code, protocol: 1}`. `code` es el código estable del Core
  (`cursor_ahead`, `compact_snapshot_unavailable`…), `forbidden` o `core_error`. **El mensaje del error no
  viaja**: puede llevar rutas.
* El IDE anuncia la capability `core_snapshot` en su `hello`. Con `core_attention` anuncia también la capability `core_attention`; sin ella, la bandeja del móvil enseña
  las más urgentes de la snapshot y pide actualizar. `items[]` de `core_attention` es la allowlist de
  `attention_list` (`id`, `category`, `severity`, `status`, `target_kind`, `target_id`, `project_id`, `run_id`,
  `occurrence`, `created_at`), sin `subject` ni `facts`. El cursor es el opaco de `attention_list`, ligado a la
  identidad del IDE que hace la lectura.
* Con `core_task` y `core_activity` el IDE anuncia la capability `core_task`. `task` es `task_detail` sin
  cuerpos de mensaje (solo `pending_questions`: cuántas preguntas suyas siguen sin respuesta) y sin el nombre
  ni la nota de la fase (como Activity). La ruta va en `location` (el worktree o, si comparte checkout, su
  carpeta) y el móvil la enseña solo como ubicación secundaria. `origin` sale de `external` (LXO-38):
  `external` o `lixbon`, y `null` con un Core que no lo da (el móvil usa entonces el de la snapshot).
  `core_activity` pide `activity_list` de esa
  Task con `order: desc`. Cada item va sin `provenance`, `event_id`, `correlation_id` ni el id del actor; el
  móvil traduce `message_key` con una copia del traductor de Desktop (`apps/mobile/src/observe/activityMessages.js`,
  con una prueba que exige que sea idéntica). `core_attention` admite también `target_kind` y `target_id`. El gateway admite las dos acciones en
  `ORCH_ACTIONS` y trata las dos respuestas como `EPHEMERAL_EVENTS`.
* **Intentos (LXO-126).** Con `core_attempts` y `core_attempt` el IDE anuncia la capability `core_attempts`. Solo
  responden con el Core ya cortado al modelo Task/Attempt; antes, el código es `core_model_inactive` y el móvil sigue
  con `core_task` como en LXO-110. Un IDE anterior contesta `orch_error` y el móvil lo trata igual.
  * `core_attempts` lee `task_detail_v2` y el `attempt_detail` de los **20 últimos** intentos (por `n`).
    * `task` va sin el encargo: `id`, `project_id`, `run_id`, `parent_task_id`, `title`, `intent`, `state`
      (estado derivado), `origin`, `attempt_count`, `current_attempt_id` y fechas.
    * Cada intento lleva `id`, `task_id`, `n`, `status`, `provider`, `model`, `role` y `origin` (de `external`).
      También sus fechas, `failure_reason`, `integrated`, `has_summary` (no el resumen) y `host`, la máquina de su
      Worktree si el Core la registra (`null` si no; nunca se deduce).
    * Si el detalle de uno falla, va lo de la lista y lo demás queda `null`. `truncated` dice si hay más de 20.
  * `core_attempt` es la ficha de un intento (`attempt_detail`): lo anterior más `effort`, `profile` y `summary`
    (400 caracteres).
    * `provider_session`: `status`, `resumable`, `bound`, `binding` y `opened_here`. Sin el id de la sesión ni la
      referencia del proveedor.
    * `worktree`: `path`, `branch`, `base_branch`, `provenance`, `state`, `machine` y `branch_kept`.
    * `artifacts` (`kind` y `uri`, 20 como mucho) y la última `review` (`verdict`, `status`, `head_commit`,
      `base_commit`).
  * La Attention de ejecución apunta al intento (`target_kind: attempt`). El móvil la pide con `core_attention` y
    abre **ese** intento, nunca «el último» de su tarea.
  * Sin conexión, el móvil enseña los últimos intentos que vio de esa tarea, guardados solo en memoria (no en
    disco), y los marca como desactualizados con su edad.
  * El gateway admite las dos acciones en `ORCH_ACTIONS` y sus respuestas como `EPHEMERAL_EVENTS`.

## Estados en el móvil

`apps/mobile/src/observe/bootstrap.js` (sin React Native; se prueba con `node --test`).

| Estado | Cuándo |
|---|---|
| `connecting` | Todavía no hay datos y se pide la primera snapshot |
| `online` | La última sincronización tiene menos de 60 s |
| `stale` | Hay datos, pero vienen de la caché o de una sincronización vieja (también al volver de segundo plano) |
| `offline` | Sin socket con el gateway, sin el IDE conectado o el Core no responde. Los datos se conservan |
| `unauthorized` | El gateway responde 401/403, o el Core `*_auth_required`/`forbidden`. No reintenta solo |
| `version_mismatch` | El IDE no anuncia `core_snapshot`, el gateway no conoce la acción (422), el IDE responde «acción no soportada», otro protocolo de relé u otra `snapshot_version`. No reintenta solo |

* **Offline no es un fallo:** nada se borra, y lo que había se muestra como desactualizado.
* **Backoff acotado:** reintentos a 1, 2, 4, 8 y 16 s, hasta 6 intentos seguidos. Después espera a que
  vuelva la conexión, a volver a primer plano o a un «Reintentar».
* **Segundo plano:** no sondea ni deja temporizadores. Al volver, si la sincronización es vieja, pasa a
  `stale` y refresca enseguida.
* **Seguimiento:** con la app delante y en línea, `core_events` cada 5 s desde el cursor. Si llega algo
  nuevo se pide otra snapshot (la snapshot pinta; el Event Log dice cuándo cambió algo). Más de 5 páginas
  seguidas se resuelven también con otra snapshot.
* **Reconectar no duplica:** solo cuenta un evento con `seq` mayor que el cursor, aunque el relé repita
  páginas. La Attention viene siempre de la snapshot, que se sustituye entera.
* **Cursor ajeno** (`invalid_cursor`, `cursor_ahead`, por ejemplo una base nueva): se borra la caché y se
  pide otra snapshot.

## UX de conexión (LXO-111)

`apps/mobile/src/observe/connection.js` traduce el estado del bootstrap, el socket con el gateway y la
presencia del IDE a un banner (`ConnectionBanner.js`). Las tres capas no se mezclan:

| Banner | Cuándo | Reintentar |
|---|---|---|
| En línea | sincronizado hace < 60 s, con socket y con el IDE conectado | — |
| Conectando… | primera conexión sin datos | — |
| Datos guardados | hay caché y se está conectando o actualizando | sí, cuando ya conectó |
| Reconectando… | el socket se rehace; lo visible es de la última sincronización | — |
| Desactualizado | la última sincronización es vieja (por ejemplo, al volver de segundo plano) | sí |
| IDE desconectado / Sin conexión | sin el IDE en su sesión, sin servidor o el Core sin almacén | sí |
| Sesión no autorizada | 401/403 del gateway o `*_auth_required` del Core | sí |
| Versiones incompatibles | capability, acción, protocolo o `snapshot_version` | sí |

* Cada aviso dice qué hacer y la hora de la última sincronización. Debajo va un código de diagnóstico estable
  (`host_offline`, `unsupported_action`…), nunca mensajes ni rutas.
* Offline y desactualizado no usan el rojo de los fallos: eso queda para autorización y versión.
* `actionGate(view)` solo permite mandar una acción con el banner «En línea». F2 no tiene acciones; la
  puerta queda para las futuras, que no podrán aparentar éxito sin conexión.
* **Acciones deshabilitadas con su razón (LXO-46).** La ficha de una Task enseña lo que habría que hacer
  (responder, aprobar o rechazar, revisar e integrar, resolver el conflicto, reintentar), según su estado y
  su Attention, siempre deshabilitado (`taskActions` en `observe/task.js`). La razón la pone `actionGate`:
  sin «En línea», la de la conexión; en línea, «llegará más adelante: hazlo en Lixbon Desktop». «Abrir en
  Desktop» no muta y lleva siempre la suya (F6).
* **Host.** El modelo legacy no guarda el host en la Task. La ficha enseña el IDE de la sesión `/remote`:
  el Core que responde es el de ese equipo, y es donde corren sus Tasks.

## Caché

`apps/mobile/src/observe/cache.js`: la última snapshot y su cursor, en AsyncStorage
(`lixbon.observe.cache.v1:<sesión>`).

* **Nunca es autoridad.** Al abrir se pinta como `stale` y se pide la snapshot real enseguida. Al primer
  arranque siempre se pide una snapshot nueva antes de seguir eventos.
* No lleva secretos: la snapshot del Core no incluye spec, rutas ni credenciales, y el token sigue en
  `SecureStore`. Más de 192 K caracteres no se guarda. Otra versión u otra sesión se ignoran.

## Logs

Solo códigos y contadores (`core_bootstrap_snapshot {projects, tasks, truncated}`,
`core_bootstrap_retry {code, attempts}`…), y solo en desarrollo. Nunca títulos, nombres, ids ni la clave de
la caché. Hay una prueba con centinelas.

## Pruebas

* `apps/mobile/src/observe/observe.test.js`: arranque en frío y con caché; caché vieja o inválida;
  seguimiento del cursor y snapshot al cambiar; reconexión sin duplicados; cursor ajeno; offline con backoff
  acotado; sin IDE conectado; segundo plano y vuelta; token inválido; versión (capability, acción, protocolo,
  `snapshot_version`); logs sin contenido; bootstrap con la snapshot más grande del Core; enlace por `rid`;
  indicador.
* `apps/desktop/src/lib/remoteCore.test.js`: validación de la petición, eventos reducidos sin `payload` y
  errores como código.
* `core/gateway/test_remote_core_bootstrap.py`: el relé admite las dos acciones y no guarda ni repite las
  respuestas.
* **Validación manual** en dispositivo o emulador: pendiente (`needs:manual-validation`).
