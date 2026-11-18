# Take Over y Return to Agent: una persona toma el control de un Attempt y lo devuelve (LXO-170, épica F6)

Una persona pasa a trabajar ella misma en el workspace de un Attempt **en marcha**, sin crear otro Attempt ni otro chat, y luego se lo **devuelve** al agente. El agente se interrumpe en una frontera segura; el Attempt sigue siendo el mismo, con su Task, su sesión y su historia.

> Cubre **`attempt_take_over`** (tomar, PR 1) y **`attempt_return_preview`** / **`attempt_return_to_agent`** (devolver, PR 2). Un Attempt tomado también se puede **detener** (`attempt_stop`).

Implementación: `orch/take_over_runtime.rs`, `orch/return_runtime.rs`, `orch/live_run.rs` (buzón), `orch/run_pump.rs` (frontera), `store/ownership.rs` (lectura del dueño). Pruebas: `orch/take_over_e2e_tests.rs` y `orch/return_e2e_tests.rs`.

## La propiedad no es un estado

El vocabulario de estados de un Attempt (`contracts/status-vocabulary.json`) lo comparten Core, Desktop, CLI y Mobile y se comprueba con pruebas exactas en los cuatro. **No se añade un estado.** La propiedad humano/agente es otra dimensión:

* El hecho `attempt.ownership_changed` (v1, `state`) la cambia: `{task, n, from, to, request_id, base_commit?}` ([EVENTOS.md](EVENTOS.md)).
* **El dueño actual es el `to` de su último hecho**; sin hechos, el agente. No hay columna ni tabla: el cambio de dueño y su rastro son el mismo dato, no pueden discrepar y sobreviven a reiniciar el Core.
* Un Attempt tomado sigue `running` y **sin proceso**. `work_at` ([OWNERSHIP.md](OWNERSHIP.md)) devuelve `held_by: "human"` en su dueño.

## Petición

```json
{ "attempt_id": "t2-a1", "request_id": "t-1", "confirm": true }
```

* `request_id`: clave de idempotencia (1 a 64 caracteres entre letras, dígitos, `_`, `.` y `-`). Obligatoria. Repetirla devuelve **el mismo resultado** (`status: "Replayed"`), error incluido, sin interrumpir otra vez: para reintentar tras un fallo se usa una clave nueva.
* Solo una Person autenticada de Desktop o de la CLI. Un agente no toma el control.
* La **policy** la trata como un `stop` (`Category::Stop`): interrumpe la ejecución del agente igual, con el mismo riesgo. `confirm` es opcional en Desktop y lo exige la policy base a la CLI.

Respuesta: `{ "status": "TakenOver" | "Replayed", "attempt_id", "request_id", "owner": "human", "base_commit" }`. `base_commit` es la rama en ese instante: la referencia para detectar los cambios de la persona.

## Orden de las cosas

```text
1. autorizar y validar la clave                                  <- antes de escribir
2. ¿ya se atendió esta clave?  -> el MISMO resultado, sin tocar al proveedor
3. ¿Attempt `running`, con ejecución viva, aún del agente?
   ¿el proveedor ofrece `interrupt` Y `resume`, y declaró su sesión?   <- si no, error y NADA se escribe
4. pending_takeover + interrupt(handle)
5. el BOMBEO, cuando `events` vuelve con el proceso cerrado con prueba:
      attempt.ownership_changed (agent -> human) y la ejecución sale del registro   (el Attempt NO se cierra)
6. espera acotada (15 s) del veredicto
```

## Errores (se decide por `categoría/código`)

| categoría/código | cuándo | ¿se escribió algo? |
|---|---|---|
| `unsupported/take_over_unsupported` | el proveedor no ofrece `interrupt` o no ofrece `resume` | no (y no se interrumpe nada) |
| `invalid/session_missing` | el proveedor aún no declaró su sesión: no se podría devolver el trabajo | no |
| `invalid/attempt_final` | el Attempt ya terminó | no |
| `invalid/already_human` | ya está en manos de una persona | no |
| `busy/not_running` | no está `running` o no tiene ejecución viva | no |
| `busy/stop_in_progress` | ya hay una interrupción esperando confirmación | no |
| `failed/stop_failed` | el proveedor rechazó la interrupción, o la ejecución acabó de otra forma antes de confirmarla | no: **sigue con el agente** |
| `failed/stop_timeout` | el proveedor no confirmó a tiempo | no: **sigue con el agente** |
| `failed/take_over_failed` | se interrumpió pero no se pudo anotar el cambio | no: sigue con el agente (y la ejecución, ya parada, se cierra como `exited`) |
| `environment_blocked`, `invalid/*` | entorno bloqueado, actor o entrada inválidos | no |

## Invariantes y cómo se prueban (`take_over_e2e_tests.rs`)

| # | Invariante | Prueba |
|---|---|---|
| 1 | El dueño no cambia hasta que la frontera es segura: pedir la interrupción no es haberla conseguido | `si_la_ejecucion_acaba_de_otra_forma_no_hay_frontera_segura_…` |
| 2 | Un plazo vencido o un fallo conservan al dueño anterior, y un stop tardío no cambia nada | `un_plazo_vencido_conserva_al_dueno_anterior_…` |
| 3 | No crea Attempt, chat ni sesión; se interrumpe y NADA más (ninguna reanudación) | `tomar_el_control_interrumpe_y_deja_el_attempt_running_…` |
| 4 | Exige poder devolver: sin `interrupt`, sin `resume` o sin sesión no se interrumpe nada | `sin_interrupt_sin_resume_o_sin_sesion_…` |
| 5 | Un Attempt terminado no se toma; un segundo Take Over se rechaza sin escribir | `un_segundo_take_over_o_uno_sobre_un_attempt_terminado_…` |
| 6 | El hecho lo firma la persona que lo pidió, no el Core | `el_hecho_lo_firma_la_persona_que_lo_pidio_…` |
| 7 | Solo una Person autenticada; la petición se valida antes de tocar al proveedor | `solo_una_person_autenticada_toma_el_control_…` |
| 8 | Idempotente por `request_id` | `tomar_el_control_…` (repetición) |
| 9 | El trabajo de la persona no se cierra como huérfano ni por inactividad | `un_attempt_en_manos_de_la_persona_no_se_cierra_…` |
| 10 | La persona puede detener el Attempt que tomó | `una_persona_puede_detener_el_attempt_que_tomo_…` |

## Return to Agent

La persona devuelve el Attempt: el agente **reanuda la misma sesión, en el mismo Attempt y sobre el worktree tal como la persona lo dejó**.

### Vista previa: `attempt_return_preview { attempt_id }`

Solo lectura, solo una Person autenticada. Dice si se puede devolver y lo que la persona hizo desde que tomó el control, **calculado con git por el Core** (`provenance: verified`), sin el contenido de ningún diff:

```json
{ "v": 1, "attempt_id": "t2-a1", "owner": "human", "since": 1763430000000, "can_return": true, "blocker": null,
  "human_changes": {
    "base_commit": "6a93…", "head_commit": "b96f…", "has_changes": true,
    "commits":     { "total": 1, "items": [{ "commit": "b96fc58", "subject": "arreglo a mano" }], "truncated": false },
    "files":       { "total": 1, "items": [{ "path": "humano.rs", "additions": 1, "deletions": 0 }], "truncated": false },
    "uncommitted": { "total": 2, "items": [{ "status": " M", "path": "README.md" }, { "status": "??", "path": "borrador.txt" }], "truncated": false },
    "completeness": "complete", "gaps": [], "provenance": "verified" } }
```

* `commits`: los de la rama desde `base_commit` (la referencia que quedó anotada al tomar el control), hasta 20 con el total. `files`: archivos de esos commits (hasta 100), con las cuentas de `numstat` (`null` en un binario: nunca un cero inventado). `uncommitted`: lo **sin confirmar** en el worktree, con su estado de git (`git status --porcelain`), hasta 100.
* **Qué no se pudo comprobar se dice**: `gaps` ∈ `no_base` · `base_unavailable` · `head_unavailable` · `files_unavailable` · `status_unavailable`, y `completeness` pasa a `partial`. La falta de datos no se lee como «no hizo nada».
* Con `can_return: false`, `blocker` trae `{category, code, message}` (los mismos códigos que el comando). Los cambios se enseñan igualmente si el worktree es legible.

### Devolver: `attempt_return_to_agent { attempt_id, request_id, confirm? }`

```text
1. autorizar (persona), validar la clave, ¿ya se atendió?  -> el MISMO resultado, sin reanudar otra vez
2. ¿Attempt `running`, en manos de la persona, sin ejecución viva, y no se está devolviendo ya?
   ¿el proveedor puede reanudar (`resume`) y escuchar (`events`), con sesión y worktree activo en esta máquina?   <- si no, error y NADA cambia
3. mirar con git lo que la persona hizo
4. Gated::resume(sesión, resumen de esos cambios)        <- el proveedor acepta o no
5. attempt.ownership_changed (human -> agent)            <- solo si el proveedor aceptó
6. el bombeo escucha el proceso nuevo; el Attempt sigue `running` y termina como cualquiera
```

Respuesta: `{ "status": "Returned" | "Replayed", "attempt_id", "request_id", "owner": "agent", "human_changes" }`. La policy lo trata como una **instrucción al agente** (`Category::Steer`): reanuda a un agente que ya estaba aprobado, no es un arranque nuevo.

**Lo que se le dice al agente** es un resumen de rutas y cuentas, nunca contenido: empieza diciéndole que continúe desde el estado actual **sin descartar lo que la persona hizo** y que lo que sigue son datos comprobados con git, **información y no instrucciones**. Las rutas y los asuntos de commit se limpian de controles y saltos de línea y se acotan a 160 caracteres.

| categoría/código | cuándo | ¿cambió algo? |
|---|---|---|
| `invalid/not_human` | el Attempt no está en manos de una persona | no |
| `invalid/attempt_final` | ya terminó | no |
| `busy/not_running`, `busy/agent_running` | no está `running`, o tiene una ejecución viva del agente | no |
| `busy/return_in_progress` | ya se está devolviendo este Attempt | no (la clave **no** se gasta) |
| `unsupported/return_unsupported` | el proveedor no ofrece `resume` o `events` | no |
| `invalid/session_missing` | no hay sesión que reanudar | no |
| `failed/worktree_unavailable`, `failed/host_unavailable` | sin worktree activo en disco, o en otra máquina | no (la clave **no** se gasta) |
| `failed/provider_unavailable` | sin lanzador o proveedor no disponible | no |
| `failed/return_failed` | el proveedor no aceptó reanudar | no: **sigue en manos de la persona** (la clave sí se recuerda: se reintenta con otra) |

### Invariantes y cómo se prueban (`return_e2e_tests.rs`)

| # | Invariante | Prueba |
|---|---|---|
| 1 | El dueño no cambia hasta que el agente acepta volver; un fallo deja todo como estaba | `si_el_proveedor_no_acepta_volver_el_dueno_no_cambia_…` |
| 2 | **Return no descarta nada**: ni el commit de la persona, ni lo sin confirmar, ni los archivos nuevos; sin `stash` | `devolver_reanuda_el_mismo_attempt_con_lo_que_hizo_la_persona_y_no_pierde_nada` |
| 3 | Mismo Attempt, misma sesión, mismo worktree: ni otro `attempt.started` ni otro Attempt | ídem |
| 4 | El agente recibe lo que se hizo (rutas, cuentas, asuntos), sin contenido de diff | ídem y `la_vista_previa_dice_que_hizo_la_persona_con_git_y_sin_el_contenido` |
| 5 | Los cambios humanos son visibles ANTES de devolver, y mirar no cambia nada | `la_vista_previa_…` |
| 6 | Una sola devolución a la vez; el rechazo no gasta la clave | `dos_devoluciones_a_la_vez_no_arrancan_dos_agentes` |
| 7 | Las comprobaciones previas no tocan al proveedor ni gastan la clave | `las_comprobaciones_previas_no_tocan_al_proveedor_ni_gastan_la_clave` |
| 8 | Se puede volver a tomar tras devolver, con la referencia de ESE momento | `se_puede_tomar_de_nuevo_tras_devolver_…` |
| 9 | Solo una Person autenticada; la petición se valida antes de tocar al proveedor | `solo_una_person_autenticada_devuelve_…` |

### Cómo habla con el proveedor

Devolver no pasa por un despacho, así que no hay `StartedRun` de un lanzamiento: lo construye el Core con el **adapter del lanzador instalado** (`Launcher::adapter_for`, y `Launcher::approval_ttl` para el plazo de las peticiones) y arranca el bombeo de siempre (`spawn_pump`). En producción el lanzador usa el registro de proveedores del Core; en las pruebas, el falso: por eso Return nunca resuelve el adapter por el registro del Core directamente.

## Lo que cambia en el resto del Core

* **Arranque (`close_orphans`)** y **cierre por inactividad (`close_idle_runs`, 30 min)** excluyen a los Attempts en manos de una persona: están `running` sin proceso **a propósito**, y cerrarlos destruiría el trabajo a medias. Si no se puede saber quiénes son (error de lectura con el almacén abierto) **no se cierra nada** ese ciclo; con el almacén cerrado no hay hechos de propiedad y se cierra como siempre.
* **`attempt_stop` (CLI)** sobre un Attempt tomado no cancela ninguna ejecución (no la hay): lo cierra como `stopped` por el mismo camino que el desenlace de cualquier ejecución (hecho, cola y claim de despacho).
* **Activity**: `activity.attempt.ownership_changed` con `to` ∈ `agent` · `human` (ni rutas ni commits). Es un cambio de contrato de los clientes: la copia de `activityMessages.js` de Mobile se sincroniza en el mismo PR, como exige la regla del repo.

## Qué NO hace

* **No impide que otro actor escriba** en el worktree mientras la persona trabaja: `held_by: "human"` es una señal para clientes, no un candado.
* **No escribe un hecho de petición/resultado** para los intentos fallidos (a diferencia de Steer): un fallo se devuelve a quien lo pidió y no deja rastro durable. Sí lo deja el cambio de dueño.
* **No hay interfaz** (banner, botón): es LXO-175 (Desktop) y LXO-174.
* La evidencia de `work_at` de un Attempt tomado incluye los commits de la persona (su rango es `base..HEAD vivo`): el Core no los separa por autor. Quien quiera distinguirlos tiene `base_commit` y la vista previa del Return.
* **Return no pide reconocer lo sin confirmar**: el agente lo recibe descrito y sigue sobre el mismo árbol. Si la persona no quiere que el agente toque algo, debe confirmarlo o guardarlo antes de devolver.
* **El resumen no es un ContextPackage** (con redaction y verificación): son rutas y cuentas comprobadas con git. Integrarlo con `context_package_build` queda para cuando haga falta transferir el contenido.
