# Activity humana desde el Event Log (LXO-92)

Estado: **`activity_list` implementado**. Activity responde *qué ocurrió*; Attention responde *qué necesita de
mí ahora* (`ATTENTION.md`). Es una **proyección de solo lectura** del Event Log (`EVENTOS.md`): no lo sustituye,
no lo muta y no guarda estado propio. Fuera de esta versión: Attention, *unread*, analítica, resúmenes por
modelo y edición de eventos.

## Decisiones

| # | Decisión | Por qué |
|---|---|---|
| 1 | **El Core devuelve una clave de mensaje + argumentos, no frases.** Cada cliente la traduce. | `VOCABULARIO.md` §1: ningún texto de interfaz entra en el Core. El CLI ya está en inglés y Desktop/Mobile en español. |
| 2 | **Un evento = un item.** Sin compresión ni agrupación en el Core. | Garantiza que un fallo no se oculta y que el cursor es el `seq`. Plegar (p. ej. por `correlation_id`) es decisión del cliente. |
| 3 | **Solo Person autenticada** (Desktop, CLI y Mobile). Un Agent y el token legacy no leen Activity. | El Event Log crudo solo lo lee Person+Desktop; Activity es una proyección filtrada, así que se amplía a CLI y Mobile sin dar el log completo. Acordado con el equipo. |
| 4 | **Orden ascendente por `seq` con cursor exclusivo**, y `order=desc` para abrir por lo último. | Igual que `events`; el cursor no depende de cuántos items se pinten. |
| 5 | **Texto libre mínimo en `args`**: título de Task y de solicitud de lanzamiento, nombre de Project y rama. | Sin ellos la línea no dice nada. Es lo único que no es código, id o contador. Acordado con el equipo. |

## Contrato

Comando `activity_list`, clasificado `ClientAction::Read`. El mismo comando por el RPC de Tauri y por `POST /rpc`
(`{"cmd":"activity_list","args":{…}}`). No abre SQLite al cliente ni escribe.

| Parámetro | Valores | Por defecto |
|---|---|---|
| `cursor` | entero ≥ 0. Con `asc`: eventos con `seq > cursor`. Con `desc`: `seq < cursor` (0 = desde lo más nuevo) | `0` |
| `limit` | 1–500 | 100 |
| `order` | `asc` · `desc` | `asc` |
| `project_id`, `run_id` | filtro exacto | sin filtro |
| `target_kind`, `target_id` | entidad del evento (`task`, `project`, `spawn_request`…). `target_id` exige `target_kind` | sin filtro |

Los parámetros desconocidos o inválidos se rechazan con `activity_invalid_request`.

```json
{"v":1,"projection":1,"order":"asc","items":[ … ],"next_cursor":131,"has_more":false,"head_seq":131,"limit":100}
```

* `next_cursor`: con `has_more = true` es el `seq` del último item devuelto (pasa ese valor como `cursor`). Con
  `asc` y sin más, es `head_seq`. Con `desc` es el `seq` más bajo devuelto.
* **Reconexión:** guardar `next_cursor` y reanudar con él produce la misma secuencia que una lectura sin cortes.
  Un cursor mayor que `head_seq` no puede venir de este Core: `activity_cursor_ahead`.
* `projection` es la versión del formateador (hoy `1`); `v` es la del contrato de la respuesta.

### ActivityItem

| Campo | Contenido |
|---|---|
| `seq`, `event_id`, `ts`, `kind`, `v`, `class` | **El evento origen**, sin tocar: todo item se rastrea a su evento. |
| `message_key` | Clave estable (`activity.task.failed`). Es lo que el cliente traduce. |
| `args` | Argumentos de la frase (ids, códigos cerrados, contadores y el texto libre de la decisión 5). Lista cerrada por `kind`. |
| `visual` | Énfasis opcional: `info` · `success` · `warning` · `error`. No es la severidad de Attention. |
| `fallback` | `true` si el evento no se pudo formatear (ver más abajo). |
| `target` | `{kind, id}` de la entidad del evento. |
| `project_id`, `run_id` | Las columnas del evento; nunca se deducen de rutas ni de texto. |
| `actor` | `{kind, id}`: `person`, `agent` (con su Task) o `system`. |
| `provenance` | `{channel, client_id}`: por dónde llegó y con qué cliente autenticado. |
| `correlation_id` | El del evento. Une hechos relacionados (ver «Correlación»). |

## Tabla Event kind → Activity

`visual` por defecto es `info`. Los argumentos con `?` son opcionales; el resto son obligatorios y, si faltan o
no son del tipo esperado, el item cae al respaldo.

| Event `kind` (v1) | `message_key` | `args` | `visual` |
|---|---|---|---|
| `run.created` | `activity.run.created` | `root_task` | info |
| `run.closed` | `activity.run.closed` | `forced`, `stopped_total` | warning si `forced` |
| `run.removed` | `activity.run.removed` | `tasks` | info |
| `task.created` | `activity.task.created` | `title`, `agent`, `role?`, `model?`, `parent?`, `depth`, `external` | info |
| `task.status_changed` | `activity.task.<to>` con `to` ∈ `starting` `running` `waiting` `awaiting_terminal_approval` `done` `failed` `stopped` `exited` | `from`, `to`, `cause?` | `done` success · `failed` y `exited` error · `awaiting_terminal_approval` y `stopped` warning · el resto info |
| `task.phase` | `activity.task.phase_started` / `activity.task.phase_done` | — (el nombre de la fase no se expone) | info |
| `task.question` | `activity.task.question` | `message_id`, `to` | warning |
| `task.reply` | `activity.task.reply` | `question_id`, `message_id` | info |
| `task.removed` | `activity.task.removed` | `cause` ∈ `launch_failed` `unused` | warning |
| `task.review_requested` | `activity.task.review_requested` | `branch` | info |
| `task.created` **v2** (Task como intención, LXO-113) | `activity.task.intent_created` | `title`, `parent?`, `depth` | info |
| `task.updated` | `activity.task.updated` | `changed` (lista ⊆ `title` `spec`), `title?` | info |
| `task.discarded` · `task.restored` | `activity.task.discarded` / `.restored` | — | warning / info |
| `attempt.requested` (LXO-114) | `activity.attempt.requested` | `task`, `n`, `provider`, `model?`, `effort?`, `role?`, `profile?`, `external`, `approval_required` | info |
| `attempt.approved` | `activity.attempt.approved` | `task`, `n` | success |
| `attempt.rejected` | `activity.attempt.rejected` | `task`, `n`, `cause` ∈ `cancelled` `run_closed` | warning |
| `attempt.started` | `activity.attempt.started` | `task`, `n` | info |
| `attempt.completed` | `activity.attempt.completed` | `task`, `n`, `has_summary` | success |
| `attempt.failed` | `activity.attempt.failed` | `task`, `n`, `reason` ∈ `launch_failed` `terminal_approval_timeout` `agent_idle_timeout` `agent_reported`, `has_summary` | error |
| `attempt.stopped` | `activity.attempt.stopped` | `task`, `n`, `from` ∈ `starting` `running` `waiting` `awaiting_terminal_approval`, `cause` ∈ `cancelled` `run_closed` | warning |
| `provider_session.opened` (LXO-115) | `activity.provider_session.opened` | `task`, `n`, `provider`, `resumable`, `bound` | info |
| `provider_session.bound` | `activity.provider_session.bound` | `task`, `binding` ∈ `stream_json` `session_id` | info |
| `provider_session.resumed` | `activity.provider_session.resumed` | `task`, `n` | info |
| `provider_session.detached` | `activity.provider_session.detached` | `task` | info |
| `provider_session.closed` | `activity.provider_session.closed` | `task`, `from` ∈ `open` `idle` | info |
| `thread.created` | `activity.thread.created` | `task` | info |
| `thread.summarized` | `activity.thread.summarized` | `task`, `has_summary` | info |
| `worktree.created` (LXO-116) | `activity.worktree.created` | `task`, `n`, `branch?` | info |
| `worktree.adopted` | `activity.worktree.adopted` | `task`, `n`, `provenance` ∈ `adopted` `external`, `branch?` | info |
| `worktree.attached` | `activity.worktree.attached` | `task`, `n` | info |
| `worktree.missing` | `activity.worktree.missing` | `task` | warning |
| `worktree.found` | `activity.worktree.found` | `task` | info |
| `worktree.removed` | `activity.worktree.removed` | `task`, `reason` ∈ `integrated` `discarded` `gone`, `branch_kept` | info |
| `artifact.created` | `activity.artifact.created` | `task`, `n`, `kind` ∈ `report` `pull_request` `last_message` `commit` `file`, `verifiable` | info |
| `decision.recorded` · `review` | `activity.decision.review.accepted` / `.rejected` | `decision_id`, `has_comment` | success / warning |
| `decision.recorded` · `merge` | `activity.decision.merge.merged` / `.conflict` / `.error` / `.target_moved` | `decision_id`, `branch`, `squash`, `conflict_count?` | success / error / error / warning |
| `decision.recorded` · `pr` | `activity.decision.pr.created` / `.already_exists` / `.error` | `decision_id`, `branch`, `has_pr_url` | success / info / error |
| `effect.observed` · `git_merge` | `activity.effect.git_merge.merged` / `.conflict` / `.error` | `effect_id`, `branch` | success / error / error |
| `effect.observed` · `git_push_pr` | `activity.effect.git_push_pr.created` / `.already_exists` / `.error` | `effect_id`, `branch`, `has_pr_url` | success / info / error |
| `effect.observed` · `git_worktree` | `activity.effect.git_worktree.created` | `effect_id`, `branch`, `base?` | info |
| `effect.observed` · `git_worktree_removed` | `activity.effect.git_worktree.removed` | `effect_id`, `worktree_removed`, `branch?`, `branch_deleted` | info |
| `effect.observed` · `pty_process` | `activity.effect.process.launched` / `.not_launched` | `effect_id` | info / warning |
| `project.registered` | `activity.project.registered` | `name`, `origin`, `has_remote` | info |
| `project.location_added` | `activity.project.location_added` | `primary`, `fingerprint_adopted` | info |
| `project.archived` · `project.restored` | `activity.project.archived` / `.restored` | — | info |
| `project.relocated` | `activity.project.relocated` | `fingerprint_adopted`, `confirmed_mismatch` | info |
| `spawn.requested` | `activity.spawn.requested` | `parent_task`, `title`, `provider`, `profile`, `role?`, `model?`, `effort?`, `shared`, `policy_status` | warning si `blocked` |
| `spawn.resolved` | `activity.spawn.<outcome>` con `outcome` ∈ `approved` `rejected` `launch_failed` `timeout` `coordinator_closed` `cancelled_run_removed` | `task?`, `has_reason` | `approved` success · `launch_failed` error · `rejected` y `timeout` warning · el resto info |
| `environment.blocked` / `environment.cleared` | `activity.environment.blocked` / `.cleared` | `provider`, `profile`, `code` | warning / success |
| `attention.risk_acted` | `activity.attention.risk_acted` | `resolution` | info |
| `attention.created` | `activity.attention.created` | `category`, `severity`, `occurrence`, `target_kind`, `target_id` | info |
| `attention.resolved` | `activity.attention.resolved` | `resolution` | info |
| **cualquier otro** | `activity.unknown` | `reason`, `kind`, `event_version` | info |

Las claves de esta tabla están fijadas por una prueba (`activity_tests::CLAVES`): cambiar una a propósito exige
actualizar la prueba y esta tabla en el mismo PR, porque los clientes las traducen.

## Respaldo seguro

Un evento nunca rompe la timeline. Si no se puede formatear, el item es `activity.unknown` con `fallback: true`,
conserva `seq`, `event_id`, `target`, `actor` y `provenance`, y `args.reason` dice por qué:

| `reason` | Cuándo |
|---|---|
| `unknown_kind` | el `kind` no está en la tabla (un evento de una versión futura del Core) |
| `unsupported_version` | el `kind` es conocido pero este formateador no sabe leer su `v` (todas la 1; `task.created` también la 2) |
| `invalid_payload` | el payload no es JSON, falta un campo obligatorio o un código cerrado no es de su conjunto |

El respaldo **no copia el payload**: solo el `kind` (recortado), la versión y el motivo. Una prueba exige que todo
`kind` declarado en `event_kinds.rs` tenga formateador, para que añadir un evento sin formatearlo falle en CI.

## Lo que Activity no reintroduce

`args` se construye campo a campo por `kind`; no se copia el payload ni se aceptan campos extra. Un código
cerrado (resultado, estado, causa) se compara con su conjunto y la clave sale de una constante, nunca del texto
del evento. Nunca salen cuerpos de mensaje, informes, diffs, `argv`, `env`, rutas ni credenciales, aunque
aparezcan en un payload (hay una prueba con centinelas). Solo se exponen cuatro textos libres, y recortados y sin
caracteres de control: título de Task (`task.created`), título de solicitud (`spawn.requested`), nombre de
Project (`project.registered`) y nombre de rama. El nombre de una fase y el enlace de un PR **no** se exponen
(`has_pr_url` dice solo que existe). Si otro campo de texto libre hiciera falta, se decide en un PR aparte.

## Correlación decisión + efecto

Una decisión de integración y el efecto de git que la provocó comparten `correlation_id` (el `effect_id`). Activity
los muestra como **dos hechos** (dos items, dos `seq`, dos claves). El cliente puede plegarlos por
`correlation_id` sin perder el acceso a ninguno de los dos eventos origen.

## Ejemplo de timeline

Lo que devuelve el Core (resumido) y, a modo de ilustración, cómo lo traduciría un cliente en español:

```text
seq  message_key                           args (resumido)                                   visual   → texto de un cliente
120  activity.project.registered           name=lixbon origin=auto                           info     → Proyecto «lixbon» registrado (automático)
121  activity.run.created                  root_task=t-1                                     info     → Run iniciado
122  activity.task.created                 title=Migrar la tabla de usuarios agent=claude    info     → Tarea creada: «Migrar la tabla de usuarios»
123  activity.task.running                 from=starting to=running                          info     → La tarea está trabajando
124  activity.task.question                message_id=5 to=t-1                               warning  → La tarea hizo una pregunta
127  activity.effect.git_merge.conflict    effect_id=eff-1 branch=lxo/t-7                    error    → Conflicto al integrar lxo/t-7        ┐ misma correlation_id
128  activity.decision.merge.conflict      decision_id=4 branch=lxo/t-7 squash=false         error    → Integración con conflicto            ┘ (eff-1)
130  activity.task.failed                  from=running to=failed cause=agent_idle_timeout   error    → La tarea falló: sin actividad
140  activity.unknown                      reason=unknown_kind kind=task.teleported          info     → Evento no reconocido (task.teleported)
```

El mismo item como lo ve el cliente:

```json
{"seq":130,"event_id":"0192f0a0-7b1c-7000-8000-0000000000a1","ts":1760000130000,"kind":"task.status_changed","v":1,
 "class":"state","message_key":"activity.task.failed",
 "args":{"from":"running","to":"failed","cause":"agent_idle_timeout"},"visual":"error","fallback":false,
 "target":{"kind":"task","id":"t-7"},"project_id":"p-1","run_id":"r-1",
 "actor":{"kind":"system","id":null},"provenance":{"channel":"core","client_id":"core-system"},"correlation_id":null}
```

## Errores

| Código | Cuándo |
|---|---|
| `activity_auth_required` | sin cliente autenticado, o un Agent |
| `activity_invalid_request` | parámetro desconocido o con valor inválido |
| `activity_cursor_ahead` | `cursor` mayor que `head_seq` (no pertenece a este Core) |
| `activity_unavailable` | el Core no tiene Event Log (`state.json` o migración 004 pendiente) |
| `activity_read_failed` | falló la lectura de SQLite |

## Pruebas

`orch/activity_tests.rs`: tabla completa kind → clave con fixtures de `state`, `decision`, `effect`, `project` y
`spawn`; snapshot de claves; cobertura de todos los `kind` de `event_kinds.rs`; respaldo (kind desconocido,
versión nueva, payload ilegible, campo obligatorio ausente); centinelas de secretos; columnas frente a payload;
correlación; fallos sin comprimir; flujo real del Core sin respaldo; uno a uno con el Event Log; cursor y
reconexión; `order=desc`; filtros; permisos; parámetros inválidos y solo lectura. E2E por `POST /rpc` en
`orch/server.rs::http_rpc_activity_list_es_solo_para_person_autenticada`.
