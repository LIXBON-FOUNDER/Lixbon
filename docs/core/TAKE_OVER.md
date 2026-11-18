# Take Over: una persona toma el control de un Attempt (LXO-170, épica F6)

Una persona pasa a trabajar ella misma en el workspace de un Attempt **en marcha**, sin crear otro Attempt ni otro chat. El agente se interrumpe en una frontera segura; el Attempt sigue siendo el mismo, con su Task, su sesión y su historia.

> **Este documento cubre `attempt_take_over`** (PR 1 de LXO-170). **Return to Agent** (devolver el trabajo al agente con la comprobación de los cambios humanos) es el PR 2: hasta entonces un Attempt tomado se **detiene** (`attempt_stop`), no se devuelve.

Implementación: `orch/take_over_runtime.rs`, `orch/live_run.rs` (buzón), `orch/run_pump.rs` (frontera), `store/ownership.rs` (lectura del dueño). Pruebas: `orch/take_over_e2e_tests.rs`.

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

## Lo que cambia en el resto del Core

* **Arranque (`close_orphans`)** y **cierre por inactividad (`close_idle_runs`, 30 min)** excluyen a los Attempts en manos de una persona: están `running` sin proceso **a propósito**, y cerrarlos destruiría el trabajo a medias. Si no se puede saber quiénes son (error de lectura con el almacén abierto) **no se cierra nada** ese ciclo; con el almacén cerrado no hay hechos de propiedad y se cierra como siempre.
* **`attempt_stop` (CLI)** sobre un Attempt tomado no cancela ninguna ejecución (no la hay): lo cierra como `stopped` por el mismo camino que el desenlace de cualquier ejecución (hecho, cola y claim de despacho).
* **Activity**: `activity.attempt.ownership_changed` con `to` ∈ `agent` · `human` (ni rutas ni commits). Es un cambio de contrato de los clientes: la copia de `activityMessages.js` de Mobile se sincroniza en el mismo PR, como exige la regla del repo.

## Qué NO hace (todavía)

* **No devuelve el trabajo al agente** (Return to Agent, PR 2): requiere la comprobación previa de los cambios humanos (`git status` sucio y commits desde `base_commit`) y reanudar la sesión con un resumen.
* **No impide que otro actor escriba** en el worktree mientras la persona trabaja: `held_by: "human"` es una señal para clientes, no un candado.
* **No escribe un hecho de petición/resultado** para los intentos fallidos (a diferencia de Steer): un fallo se devuelve a quien lo pidió y no deja rastro durable. Sí lo deja el cambio de dueño.
* **No hay interfaz** (banner, botón): es LXO-175 (Desktop) y LXO-174.
* La evidencia de `work_at` de un Attempt tomado incluye los commits de la persona (su rango es `base..HEAD vivo`); separarlos por autor es del Return.
