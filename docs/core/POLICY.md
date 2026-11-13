# Policy de autonomía (LXO-209)

La policy decide qué Commands puede ejecutar cada actor y cuáles piden confirmación, elevación o están prohibidos. **El Core es la única
autoridad**: la interfaz y el CLI muestran y piden, nunca otorgan (invariante 1). Implementación: `orch/policy.rs`; persistencia:
`store/policy.rs` y la migración `023_policy.sql`.

## Modelo

```text
nivel efectivo = el MÁS RESTRICTIVO de  [ base del actor · global · project · attempt ]   y nunca por debajo del piso de la categoría
restrictivo:   allow  <  confirm  <  elevated  <  deny
```

### Categorías

`start · answer · queue · steer · stop · fork · review · integrate · cleanup · provider_permissions`.

| categoría | Commands que gobierna | piso |
|---|---|---|
| `start` | `task_create` **con** `attempt`, `attempt_retry`, `attempt_resume` | `confirm` |
| `queue` | `attempt_queue` | — |
| `steer` | `attempt_steer` | — |
| `stop` | `attempt_stop_and_send`, `task_race_cancel` | — |
| `fork` | `attempt_fork`, `task_race` (se vuelve a comprobar antes de CADA candidato) | — |
| `review` | `attempt_review` | `confirm` |
| `integrate` | `attempt_integrate` | `confirm` |
| `cleanup` | `resource_clean`, `resource_delete_worktree` | `confirm` |
| `answer` | `attempt_answer` (LXO-247) cuando **deniega** un permiso del proveedor o **contesta una pregunta** | — |
| `provider_permissions` | `attempt_answer` cuando **permite** un permiso del proveedor (`answer: allow` sobre una petición de tipo `permission`). El tipo sale de la petición viva, no del texto: una pregunta respondida con la palabra «allow» es `answer`. Con el piso `confirm` hace falta `confirm: true` (el clic explícito en «Permitir»); sin él, `policy_confirm_required` y el proveedor no se toca | `confirm` |

No se gobiernan: las lecturas, `attempt_queue_cancel` (deshace, no ejecuta), `attempt_approve`/`attempt_reject` (la aprobación inicial es
parte del propio `start`), `resource_adopt` (LXO-149: no ejecuta nada, solo registra trabajo que ya existía, y exige una Person y `confirm`) ni una Task sin `attempt` (no ejecuta nada). La interfaz lo dice con `enforced: false` en vez de aparentar una
protección que no existe.

### Niveles

| nivel | qué exige el Command |
|---|---|
| `allow` | nada |
| `confirm` | `confirm: true` en la petición (salvo `start`: su confirmación es la aprobación inicial de Desktop, LXO-141) |
| `elevated` | confirmación **fuera de banda**. Aún no existe ese canal: se rechaza con `policy_out_of_band_required` aunque venga `confirm: true` |
| `deny` | nadie |

### Base por actor (código, no editable)

La clase del actor sale de la credencial **autenticada** (principal + superficie), nunca de lo que el cliente afirme (invariante 4 y
«spoof»): `desktop_person · cli_person · mobile_person · automation · agent · core`.

| | start | review · integrate · cleanup · provider_permissions | answer · queue · steer · stop · fork |
|---|---|---|---|
| `desktop_person` | confirm | confirm | allow |
| `cli_person` | confirm (solo **pide**; la aprueba Desktop) | deny | deny |
| `mobile_person`, `automation`, `agent` | deny | deny | deny |
| `core` | allow | allow | allow |

`policy_effective` devuelve esta matriz completa (`baseline_matrix`). Un agente nunca hereda alcance humano (invariante 3), y Mobile no
puede elevar lo que el Core clasifica `elevated`/`deny` (invariante 4): ni la policy ni `confirm` le dan lo que su base niega.
Hoy Mobile ni siquiera se autentica en el Core (`Channel` solo conoce `ui`, `lxo` y `core`); la matriz ya lo deja sin nada para cuando exista.

### Precedencia y overrides

* **global**: lo fija una Person de Desktop; se puede **aflojar** (con confirmación aparte) o endurecer.
* **project** y **attempt**: solo pueden **endurecer** respecto al ámbito de arriba (`policy_cannot_loosen`). Un override más cercano
  nunca da más permiso; igualar lo de arriba lo **fija** frente a un aflojamiento posterior del global.
* **pisos**: `start`, `review`, `integrate`, `cleanup` y `provider_permissions` no bajan de `confirm` (`policy_below_floor` al escribir; la
  resolución también los aplica aunque una fila diga otra cosa).
* Un nivel guardado que no se entiende cuenta como `deny` (falla cerrado).
* Origen (`source`) = la capa **más cercana** que alcanza el nivel efectivo: `baseline · global · project · attempt · floor`, con su `reason`
  máquina: `baseline_default · baseline_actor · override_global · override_project · override_attempt · safety_floor`.

Un override de `attempt` aplica a los Commands que **nombran** un Attempt; los que nombran una Task (`attempt_retry`, `attempt_resume`,
`resource_*`) evalúan global + project.

## Se revalida en CADA Command (invariante 2)

`rpc_authenticated_via` llama a `policy::gate` antes de despachar, con la policy **leída del almacén en ese instante**: la foto que la
interfaz vio hace un minuto no autoriza nada. Si la policy no se puede leer, el Command **no se ejecuta** (`policy_unavailable`).

| código | cuándo |
|---|---|
| `policy_denied` | nivel `deny` |
| `policy_confirm_required` | nivel `confirm` sin `confirm: true`; también al **aflojar** una policy sin confirmarlo |
| `policy_out_of_band_required` | nivel `elevated` |
| `policy_unavailable` | no se puede leer la policy, o el Core está en solo lectura al cambiarla |

## Commands

| Command | clase | qué hace |
|---|---|---|
| `policy_effective { project_id?, attempt_id?, preview? }` | lectura (ADE) | la policy efectiva **de quien pregunta**: `revision`, `actor { class, can_edit }`, `categories[]` (nivel, origen, `reason`, capas, piso, `enforced`), `overrides[]` del ámbito pedido y `baseline_matrix`. Con `preview { scope, category, level? }` añade `preview { valid, direction, needs_confirm, before, after, categories }` o `{ valid: false, code, message }`: **sin escribir nada** |
| `policy_set { scope { kind, id? }, category, level, expected_revision, confirm? }` | `HumanDecision` (solo Person de Desktop) | fija un override |
| `policy_reset { scope, category, expected_revision, confirm? }` | `HumanDecision` | borra el override: el ámbito vuelve a heredar |

Reglas de escritura (las mismas para guardar y para previsualizar): `policy_below_floor`, `policy_cannot_loosen`, `policy_not_found` (Project o
Attempt inexistente: nunca un override huérfano), `policy_invalid_request`, `policy_forbidden` (no es una Person autenticada de Desktop),
`policy_stale` (la revisión que el cliente leyó ya no es la actual: **no se pisa nada**) y `policy_confirm_required` si **la restricción
efectiva baja** (aflojar, o volver a heredar lo que restringía). Repetir lo mismo → `Unchanged`, sin revisión ni Event nuevos.

## Auditoría (invariantes 5 y 6)

Cada cambio deja `policy.changed` (class `decision`, entidad `policy`: `global`, `project:<id>`, `attempt:<id>`) **en la misma transacción**
que la fila y la revisión: sin su hecho no hay cambio. Payload cerrado: `scope`, `scope_id?`, `category`, `from?`, `to?` (niveles del
override; ausente = heredaba), `direction` ∈ `tighten · loosen · same · reset` y `revision`. Nunca credenciales, rutas ni texto libre. Borrar un
override no borra los hechos anteriores: la historia está en `events` y es append-only. Aparece en Activity como `activity.policy.changed`.

## Lo que NO hay (honesto)

* **Canal fuera de banda**: `elevated` hoy se rechaza siempre. No hay un segundo factor fuera del cliente que lo satisfaga.
* **Las diez categorías tienen ya punto de aplicación** (`enforced: true`, desde LXO-247). El campo se conserva en el contrato por si una categoría futura se declara antes de tener Command que la aplique. Decisión de producto tomada en LXO-247, revisable: `confirm` para quien responde a un permiso es la confirmación explícita de **permitir** (no de denegar).
* **Roles de equipo (F9)**, editor de reglas, lenguaje de reglas y bypass por flags/env: fuera de alcance.
* **El camino legacy de la interfaz** (`orch_integrate`, `orch_publish_pr`, `orch_review_task`, que no pasan por `rpc_authenticated_via`) **no** consulta
  esta policy: sigue con su propio `confirm`. Los Commands `attempt_*` y `resource_*` sí.
* **Antes del corte Task/Attempt** no hay tablas: la policy es solo la base del Core y escribir devuelve `core_model_inactive`.
* La policy no se cachea: cada Command lee el almacén. Si eso pesara, se podría cachear por revisión.
