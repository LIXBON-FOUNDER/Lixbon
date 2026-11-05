# Steer y Stop & Send (LXO-144, épica F5)

Dos comandos para hablar con un Attempt **ocupado** sin esperar a su siguiente turno. Son distintos entre sí y distintos de
encolar (`attempt.queue`, [COLA.md](COLA.md)): ninguno se adapta a otro en silencio.

| comando (RPC de Desktop) | qué hace | capability que exige | cuándo llega la instrucción |
|---|---|---|---|
| `attempt_queue` ([COLA.md](COLA.md)) | la guarda y la entrega como el SIGUIENTE turno | `resume` | al terminar el turno en curso |
| `attempt_steer` | la inyecta en el turno EN CURSO | `steer` | ya, en el mismo turno |
| `attempt_stop_and_send` | interrumpe el turno y la envía como turno nuevo | `interrupt` **y** `resume` | cuando el adapter confirma el stop |

Quién decide qué ofrecer es la matriz de capabilities del proveedor (`provider_capabilities`), nunca su nombre ni su versión.

## Petición

```json
{ "attempt_id": "t2-a1", "request_id": "s-1", "body": "usa la rama develop" }
```

* `request_id`: clave de idempotencia del cliente (1 a 64 caracteres entre letras, dígitos, `_`, `.` y `-`). **Obligatoria.**
* `body`: de 1 a 20 000 caracteres, sin ser solo espacios. Ningún otro campo: el autor sale de la identidad autenticada.
* Solo una Person de Desktop (`HumanDecision`). Un agente no instruye por este RPC. La policy efectiva por actor y Attempt llegará
  con LXO-209; hasta entonces la validación es la del actor (persona o el agente que coordina la Task, como la cola).

Respuesta: `{ "status": "Delivered" | "Replayed", "mode", "attempt_id", "request_id" }`. Un error trae `categoría/código: mensaje`.

## Orden de las cosas

```text
1. autorizar y validar clave y texto                       <- antes de escribir
2. ¿ya se atendió esta clave?  -> el MISMO resultado, sin llamar al proveedor
3. ¿Attempt `running` con una ejecución viva?              <- si no, error y NADA se escribe
   ¿el proveedor ofrece la capability? (¿y hay sesión que reanudar, en Stop & Send?)
4. attempt.instruction_requested
5. steer:          Gated::steer(handle, texto)
   stop_and_send:  se deja la instrucción pendiente, Gated::interrupt(handle) y se ESPERA el veredicto del bombeo
6. attempt.instruction_result
```

En Stop & Send el **bombeo** de la ejecución (`run_pump.rs`) es quien confirma el stop: lo hace cuando el `events` del adapter
vuelve. Solo entonces reanuda la sesión de la Task con la instrucción y sigue escuchando el run nuevo. El Attempt no termina ni se
reabre: es el mismo, con un turno nuevo.

## Errores (conjunto cerrado: se decide por `categoría/código`)

| categoría/código | cuándo | ¿se escribió algo? |
|---|---|---|
| `unsupported/steer_unsupported` | el proveedor no ofrece `steer` | no |
| `unsupported/stop_send_unsupported` | no ofrece `interrupt` o no ofrece `resume` | no (y no se interrumpe nada) |
| `environment_blocked/environment_blocked` | el entorno del proveedor está bloqueado | no |
| `invalid/attempt_final` | el Attempt ya terminó | no |
| `busy/not_running` | no está `running` (espera una respuesta, no ha arrancado) o no tiene ejecución viva | no |
| `invalid/session_missing` | Stop & Send y el proveedor aún no ha declarado su sesión | no |
| `invalid/request_conflict` | la clave ya se usó para otra instrucción | no |
| `busy/in_progress` | la misma petición se está atendiendo ahora mismo | no |
| `busy/stop_in_progress` | ya hay un Stop & Send esperando su stop | sí (`stop_failed`) |
| `invalid/not_allowed`, `invalid/attempt_missing`, `invalid/invalid_request` | actor, Attempt o entrada inválidos | no |
| `failed/steer_failed` | el proveedor rechazó el steer | sí (`failed`) |
| `failed/stop_failed` | el proveedor rechazó el stop, o la ejecución acabó de otra forma antes de confirmarlo | sí (`stop_failed`) |
| `failed/stop_timeout` | el stop no se confirmó en 15 s | sí (`stop_timeout`) |
| `failed/send_failed` | el stop se confirmó pero la instrucción no llegó | sí (`failed`) |

## Invariantes

1. **Steer nunca cae a la cola ni a Stop.** Sin `steer`, error; nada se encola, reanuda ni interrumpe (`unsupported/steer_unsupported`).
2. **Stop & Send no envía hasta conocer el resultado del stop** según el adapter (su `events` ha vuelto). Pedir el stop no es haberlo
   conseguido.
3. **Parar sin poder enviar no existe**: sin `resume` o sin sesión se rechaza ANTES de interrumpir (la instrucción no se pierde ni el
   Attempt queda interrumpido por nada).
4. **Un stop fallido o sin confirmar nunca es éxito**: `stop_failed` / `stop_timeout`, y el error lo dice. Vencido el plazo la
   instrucción pendiente se RETIRA: un stop tardío no envía lo que la persona ya vio como «no se confirmó».
5. **Un Attempt terminado no acepta ni Steer ni Stop & Send** (`attempt_final`).
6. **Repetir no duplica.** La clave se atiende una vez por proceso: repetirla devuelve el resultado que hubo (`Replayed`, también si
   fue un fallo) sin llamar al proveedor; otra instrucción con la misma clave es `request_conflict`. La ejecución viva muere con el
   proceso, así que tras un reinicio repetirla es `attempt_final`.
7. **El texto no viaja** en ningún Event: solo `chars`.

## Events

Un par por petición aceptada, unido por `request_id` (la correlación). Detalle en [EVENTOS.md](EVENTOS.md) y [ACTIVITY.md](ACTIVITY.md).

| Event | payload | cuándo |
|---|---|---|
| `attempt.instruction_requested` | `task`, `n`, `request_id`, `mode`, `chars` | el Core aceptó la petición y la va a intentar |
| `attempt.instruction_result` | `task`, `n`, `request_id`, `mode`, `outcome` ∈ `delivered` · `failed` · `stop_failed` · `stop_timeout`, `reason?` | lo que pasó |

Una petición rechazada **antes** de actuar (tabla de errores, «no») no deja Events y deja libre la clave.

## Límites conocidos

* La idempotencia vive en memoria del proceso (ver invariante 6). No hay `request_id` durable porque no hay entrega durable: o se
  hizo ahora, con el proveedor, o no se hizo.
* La policy efectiva (LXO-209) aún no filtra estos comandos.
* El plazo del stop (15 s) no es configurable por el cliente.
* Mientras un Stop & Send espera su veredicto, la llamada RPC está abierta (hasta 15 s).
