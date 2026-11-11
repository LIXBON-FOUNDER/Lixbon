# Responder a una petición del proveedor (LXO-247)

Mientras un Attempt corre, el proveedor puede **pedir un permiso** (`Permission`: usar una herramienta) o **hacer una pregunta**
(`Question`). El bombeo (`run_pump.rs`) deja entonces al Attempt en `awaiting_terminal_approval` con una Attention `approval` y un
plazo. Hasta este cambio nadie podía contestar: vencido el plazo el Attempt fallaba (`terminal_approval_timeout`). Ahora una persona
puede responder desde Desktop.

## Comandos (solo una Person de Desktop, `HumanDecision`)

| RPC | Entrada | Qué hace |
|---|---|---|
| `attempt_pending_requests` | `{attempt_id}` | lo que espera respuesta: `request_id`, `kind` (`permission` \| `question`), `subject` (la herramienta o el texto de la pregunta), `summary`, `asked_at`. Una lectura: no cambia nada |
| `attempt_answer` | `{attempt_id, request_id, answer}` | responde. `request_id` es el de la propia petición del proveedor |

Un agente, el CLI o el Core no responden por una persona (la automatización es F9).

## Respuesta válida

* **Permiso**: `allow` o `deny` (sin distinguir mayúsculas). Nunca se deduce de un texto libre.
* **Pregunta**: texto libre, no vacío, hasta 4 000 caracteres (se recorta el espacio de los extremos).

## Orden de las cosas

```text
1. Person autenticada; ids válidos                                  <- error y NADA se toca
2. el Attempt existe, no es final y tiene una ejecución viva
3. la petición está pendiente (claim: nadie más la responde a la vez)
4. la respuesta vale para su tipo
5. el Attempt espera (`awaiting_terminal_approval`) y el proveedor ofrece la capability `answer`
6. Gated::answer(handle, respuesta)    si el proveedor la rechaza, la petición SIGUE pendiente y no cambia nada
7. la petición sale de las pendientes; si era la última, el Attempt vuelve a `running`
   (`attempt.resumed`, que resuelve la Attention `approval`) y el plazo se apaga
```

## Invariantes

1. **Se responde una vez.** Repetir la misma respuesta devuelve `Replayed` sin volver a llamar al proveedor; otra respuesta a una
   petición ya contestada es `request_conflict`.
2. **El plazo sigue siendo el límite.** Con varias peticiones el Attempt sigue esperando, y el plazo corre, hasta que se responde la
   última. Una respuesta tardía (la ejecución ya se canceló) es `attempt_final`/`not_running`: no resucita nada.
3. **Todo o nada antes de tocar al proveedor.** Una respuesta inválida, una capability ausente o un Attempt que no espera no dejan
   rastro y la petición sigue pendiente.
4. **No es una instrucción.** Steer y Stop & Send exigen un Attempt `running`; lo que se le dice a un Attempt que espera es una
   respuesta (`not_running` en aquellos).
5. **Todavía no pasa por la policy de autonomía** (`policy.rs`, LXO-209). La policy reserva las categorías `answer` y
   `provider_permissions` (esta con piso `confirm`) y las marca `enforced: false`; este comando **no las engancha**: una Person de
   Desktop puede responder aunque el nivel de `answer` sea `deny`. Gobernarlo exige decidir qué significa `confirm` para quien
   responde a un permiso del proveedor, y qué hace la interfaz con `enforced`. Es una decisión de producto pendiente.

## Errores (`<tipo>/<código>`)

`invalid/invalid_request`, `invalid/attempt_missing`, `invalid/attempt_final`, `invalid/request_unknown`, `invalid/invalid_answer`,
`invalid/request_conflict`, `busy/not_running`, `busy/not_waiting`, `busy/in_progress` (otra llamada la responde ahora mismo),
`unsupported/answer_unsupported` (el proveedor no ofrece `answer`), `failed/answer_failed` (el proveedor rechazó la respuesta).

## Estado en memoria, atado a la ejecución viva

Las peticiones pendientes (`provider_requests.rs`) viven en memoria junto a la ejecución: un reinicio del Core mata la ejecución y con
ella lo pendiente (el Attempt ya no espera nada que se pueda responder). Recuerdan hasta 64 respuestas dadas por ejecución para
poder repetirlas.

## Lo que NO hace (límites conocidos)

* **No deja un Event propio de la respuesta.** Queda constancia del cambio de estado (`attempt.resumed`, con el actor), no de **qué**
  se decidió (`allow`/`deny`) ni de a qué petición. Un registro durable de la decisión sería un Event nuevo (`attempt.request_answered`)
  y toca el vocabulario compartido con Mobile y CLI.
* **No hay interfaz todavía.** Hoy se responde por el RPC; la bandeja de Attention y el detalle del Attempt de Desktop no lo ofrecen.
* Solo Claude implementa `answer` de forma verificada con la CLI real; Codex lo ofrece para aprobaciones
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) y no se ha probado con una CLI real.
* Un `request_id` que el proveedor repita en otro turno de la misma ejecución se trata como el ya visto hasta que el turno cambie.
