# Responder a una petición del proveedor (LXO-247)

Mientras un Attempt corre, el proveedor puede **pedir un permiso** (`Permission`: usar una herramienta) o **hacer una pregunta**
(`Question`). El bombeo (`run_pump.rs`) deja entonces al Attempt en `awaiting_terminal_approval` con una Attention `approval` y un
plazo. Hasta este cambio nadie podía contestar: vencido el plazo el Attempt fallaba (`terminal_approval_timeout`). Ahora una persona
puede responder desde Desktop.

## Comandos (solo una Person de Desktop, `HumanDecision`)

| RPC | Entrada | Qué hace |
|---|---|---|
| `attempt_pending_requests` | `{attempt_id}` | lo que espera respuesta: `request_id`, `kind` (`permission` \| `question`), `subject` (la herramienta o el texto de la pregunta), `summary`, `asked_at`. Una lectura: no cambia nada |
| `attempt_answer` | `{attempt_id, request_id, answer, confirm?}` | responde. `request_id` es el de la propia petición del proveedor. `confirm: true` es obligatorio para **permitir** un permiso (policy `provider_permissions`) |

Un agente, el CLI o el Core no responden por una persona (la automatización es F9).

## Respuesta válida

* **Permiso**: `allow` o `deny` (sin distinguir mayúsculas). Nunca se deduce de un texto libre.
* **Pregunta**: texto libre, no vacío, hasta 4 000 caracteres (se recorta el espacio de los extremos).

### Cómo llega una pregunta de cada proveedor

* **Claude** hace una pregunta con su herramienta `AskUserQuestion`, que llega por el protocolo como una petición de uso de herramienta
  (`can_use_tool`), igual que un permiso. **El adapter la distingue**: si la entrada trae `questions` (de una a cuatro, cada una con su
  `question`), es una **pregunta** (`kind: question`, `subject` = las preguntas con sus opciones, una por línea) y se contesta con **texto**, no con
  `allow`/`deny`. El texto vuelve a Claude en `updatedInput.answers` (clave: el texto de la pregunta tal cual la dijo el modelo; valor: la respuesta),
  junto a las preguntas originales. Con **una** pregunta, el texto entero es la respuesta; con **varias**, una línea por pregunta y en orden (si no
  encaja se rechaza sin tocar la CLI: no se contesta una pregunta con la respuesta de otra). Una entrada de `AskUserQuestion` con otra forma sigue
  siendo un permiso. Comprobado con la CLI real de Claude 2.1.296 (la respuesta «verde» llegó y el modelo la usó).
* **Codex** no tiene hoy un camino de preguntas: `item/tool/requestUserInput` no se contesta (el adapter lo deja en la salida del turno) y solo ofrece
  `answer` para las aprobaciones de comandos y de cambios de archivos.

## Orden de las cosas

```text
1. Person autenticada; ids válidos                                  <- error y NADA se toca
2. el Attempt existe, no es final y tiene una ejecución viva
3. la petición está pendiente (claim: nadie más la responde a la vez)
4. la respuesta vale para su tipo
5. el Attempt espera (`awaiting_terminal_approval`) y el proveedor ofrece la capability `answer`
6. Gated::answer(handle, respuesta)    si el proveedor la rechaza, la petición SIGUE pendiente y no cambia nada
7. queda constancia de la decisión (`attempt.request_answered`: tipo y, en un permiso, `allow`/`deny`; nunca el texto de una
   respuesta libre)
8. la petición sale de las pendientes; si era la última, el Attempt vuelve a `running`
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
5. **Pasa por la policy de autonomía** (`policy.rs`, LXO-209), antes de despachar y con la policy leída en ese instante. **Permitir**
   un permiso es la categoría `provider_permissions` (piso `confirm`): exige `confirm: true`, la decisión explícita de la persona.
   **Denegar** un permiso y **contestar** una pregunta son `answer` (baseline `allow` para una Person de Desktop). El tipo sale de la
   petición viva del Attempt, no del texto de la respuesta. Una policy que niega lo pedido (`policy_denied`) o exige confirmar
   (`policy_confirm_required`) no toca al proveedor: la petición sigue pendiente y no queda Event.

## Errores (`<tipo>/<código>`)

`policy_confirm_required` · `policy_denied` · `policy_out_of_band_required` (de la policy: ver el invariante 5), `invalid/invalid_request`, `invalid/attempt_missing`, `invalid/attempt_final`, `invalid/request_unknown`, `invalid/invalid_answer`,
`invalid/request_conflict`, `busy/not_running`, `busy/not_waiting`, `busy/in_progress` (otra llamada la responde ahora mismo),
`unsupported/answer_unsupported` (el proveedor no ofrece `answer`), `failed/answer_failed` (el proveedor rechazó la respuesta).

## Estado en memoria, atado a la ejecución viva

Las peticiones pendientes (`provider_requests.rs`) viven en memoria junto a la ejecución: un reinicio del Core mata la ejecución y con
ella lo pendiente (el Attempt ya no espera nada que se pueda responder). Recuerdan hasta 64 respuestas dadas por ejecución para
poder repetirlas.

## Lo que NO hace (límites conocidos)

* **El Event de la decisión es de mejor esfuerzo.** `attempt.request_answered` se escribe cuando el proveedor ya aceptó la respuesta;
  si el registro falla, el proveedor ya la tiene: el Core lo dice por su log y no deshace nada (el `attempt.resumed` sigue su curso).
  No lleva el texto de una pregunta respondida (ni su longitud): solo el tipo y, en un permiso, `allow`/`deny`.
* Claude y Codex implementan `answer` para permisos y se comprobaron con su CLI real (permitir con efecto, denegar sin efecto: el comando no se
  ejecuta). Las **preguntas libres** solo existen con Claude (ver arriba); Codex no las plantea por este camino.
* **La interfaz de Desktop sí existe** (detalle del Attempt y bandeja de Attention): las pruebas manuales con CLIs reales entran por el mismo RPC.
* Un `request_id` que el proveedor repita en otro turno de la misma ejecución se trata como el ya visto hasta que el turno cambie.
