# Propiedad persistente de procesos (LXO-183)

Estado: **implementado y probado con procesos reales; vive tras el corte Task/Attempt** (tabla `process_ownership`, migración 028).
Decisión de arquitectura: la ADR del runtime persistente (`ADR_RUNTIME_PERSISTENTE.md`, LXO-181), rebanada 2.

## Qué resuelve

Quién poseía el proceso de un Attempt vivía solo en memoria (la custodia del supervisor, un `static`). Si el Core moría, nadie sabía qué
procesos había lanzado: en Unix se quedaban huérfanos y en Windows los mataba el Job, sin que quedara constancia. Ahora cada runtime deja
anotado, **por Attempt**, el proceso que sostiene y cómo reconocerlo después; un runtime nuevo resuelve lo que dejó el anterior.

## Qué NO hace

* **No reengancha** un proceso vivo. Sus tuberías de entrada y salida eran del Core que murió, así que un proceso que sobrevive a su Core ya
  no lo lee nadie. Hoy un proceso hallado vivo se **cierra** (con la verificación de identidad del kill del árbol), nunca se «adopta».
  *Attach/reconnect* y «el cliente se cierra y el Attempt en segundo plano sigue» exigen el daemon (rebanada 5 de la ADR) y **no están
  cubiertos aquí**.
* No decide el estado del Attempt: `close_orphans` ya lo cierra al arrancar. Esto cierra el **proceso**.
* No cambia el Job de Windows (`KILL_ON_JOB_CLOSE`): sigue matando al árbol si el Core muere; aquí queda la constancia.
* No cubre las terminales PTY de usuario ni los procesos sin Attempt como dueño.

## La tabla

`process_ownership`: una fila por proceso registrado.

| Columna | Qué es |
|---|---|
| `attempt_id` | El Attempt dueño (clave foránea). Como mucho **un proceso vivo por Attempt** (índice único parcial). |
| `host_id` | La máquina (el `machine_id`; ver `HOSTS.md`). |
| `runtime_instance` | Qué vida del Core lo sostiene (un UUID nuevo en cada arranque). |
| `root_pid`, `root_start`, `pgid` | La **identidad**: pid + hora de creación (un pid solo se reutiliza) + grupo (Unix). `root_start` es un token opaco en decimal; `NULL` si no se pudo probar. |
| `state` | `held` (este runtime lo sostiene), `unproven` (su cierre no se pudo probar: a la vista), `released` (historia). |
| `lease_until`, `heartbeat_at` | El lease (cuatro barridos) y el último latido. |
| `release_reason` | `closed` (lo cerró con prueba el runtime que lo sostenía), `gone` (un runtime posterior comprobó que ya no existía) o `reaped` (un runtime posterior lo encontró vivo y lo cerró). |

La base impone: la identidad no cambia, lo liberado no vuelve a vivir ni cambia de motivo, y la historia no se borra.

## Cómo se mantiene

```text
adapters ── set_owner(attempt) ──► supervisor (en memoria)  ── owned_snapshot() ──┐
Core::process_ownership_sync  ◄─────────────────────────────────────────────────┘
   tras lanzar un Attempt · en cada barrido (latido) · al apagar
   └─► registra lo nuevo · renueva el lease · libera como `closed` lo que ya no está abierto
```

El cierre de un proceso ocurre en el supervisor; anotarlo es **después** y nunca lo retrasa. Un cierre sin probar queda `unproven`.
`Core::shutdown` reintenta la custodia y deja constancia: lo cerrado queda `released(closed)`.

## Qué hace un arranque con lo que dejó el runtime anterior

`Core::process_ownership_reconcile` corre siempre al arrancar (antes de `close_orphans`) sobre las filas vivas de **otro** runtime:

| Lo que se comprueba | Desenlace |
|---|---|
| El pid ya no existe, o es de **otro** proceso (otra hora de creación) | `released(gone)`. **No se toca** al proceso actual de ese pid. |
| Existe con la misma hora de creación | Se cierra el **árbol** con la prueba de propiedad de `proctable`; si se termina la raíz, `released(reaped)` (si ya había terminado, `gone`). |
| No se pudo leer la tabla de procesos o la identidad, no hay hora de creación registrada, o no se puede probar el cierre | `unproven`: queda a la vista y se reintenta en el siguiente arranque. **Nunca se mata a ciegas.** |

Lo que sostiene este mismo runtime no lo resuelve un arranque.

## Diagnóstico

`Core::process_ownership_report`: cada proceso vivo con su estado, si es de este runtime y `stale` (lease vencido, o de otro runtime sin
resolver). Todavía no hay RPC; lo consume el diagnóstico de LXO-189.

## Qué no está verificado

* Árboles con descendientes reales en Windows y Linux a través de este registro: se apoyan en las pruebas de `proctable`; las de aquí usan
  un proceso raíz real y un sistema operativo falso para la duda.
* macOS y la identidad de un proceso de otro usuario.
* Que el barrido (cada `SWEEP_EVERY`) alcance a renovar el lease con el Core muy cargado.
