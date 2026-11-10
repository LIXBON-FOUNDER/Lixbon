# Reintento y reanudación de un Attempt (LXO-142)

Estado: **implementado en el Core; los comandos por el almacén siguen inertes, pero Desktop ya reintenta y continúa por el [puente al despachador](#puente-al-despachador-proyecto-de-cuatro-pr) (RPC `attempt_retry` / `attempt_resume` y botones en el ADE); sigue sin `lxo`**. Primer comando de la épica
`[CORE][F5]`. Hay dos comandos explícitos, y no se parecen:

| Comando | Qué hace | Qué conserva del Attempt anterior | Código |
|---|---|---|---|
| `attempt.retry` | un Attempt **limpio** para la misma Task | sus parámetros (proveedor, modelo, esfuerzo, rol, perfil), salvo los que se piden distintos | `orch/attempt_commands.rs` (`retry`) |
| `attempt.resume` | **continúa la ProviderSession** del Attempt | lo que el proveedor guarda de la conversación | `orch/attempt_commands.rs` (`resume`) sobre `continue_attempt` ([CONTINUIDAD.md](CONTINUIDAD.md)) |

Ninguno reabre un Attempt: un final es final ([ATTEMPTS.md](ATTEMPTS.md), invariante 3). Los dos crean el `n + 1`, con la
procedencia `origen → nuevo` guardada en una tabla inmutable, y los dos son idempotentes por `request_id`.

* Migración [`021_attempt_retries.sql`](../../apps/desktop/src-tauri/src/store/migrations/021_attempt_retries.sql).
* Almacén: `store/retries.rs`. Pruebas: `store/retries_tests.rs`.
* Comandos: `orch/attempt_commands.rs`. Pruebas con adapters falsos: `orch/attempt_commands_tests.rs`.

## `attempt.retry`

```
retry(store, registry, ctx, cancel, RetryCommand) -> RetryOutcome | CommandError
```

| Campo | |
|---|---|
| `request_id` | clave de idempotencia **de la Task**: 1–64 caracteres entre letras, dígitos, `_`, `.`, `-` |
| `task_id`, `from_attempt_id?` | el Attempt a reintentar. `None`: el último de la Task. Si se nombra, tiene que ser el último |
| `prompt?`, `worktree` | el mensaje con que arranca (`None`: el encargo de la Task, título y especificación) y dónde |
| `provider?`, `model?`, `effort?`, `profile?` | **overrides explícitos**. `None` hereda del Attempt reintentado |

**Herencia.** Rol y perfil se heredan. El **modelo y el esfuerzo son del proveedor**: se heredan solo si el proveedor no
cambia; con `provider` distinto arrancan sin ellos (nunca se le pasa a Codex el modelo de Claude). Pedir un valor igual al
que ya tenía no es un override. `overrides` (en la fila y en `attempt.retried`) lista, en orden fijo, lo que **se pidió
distinto**.

**Qué se puede reintentar.** Solo un Attempt que **terminó mal** (`failed`, `stopped`, `exited`) y que es **el último** de
la Task. Un `done` no se reintenta (se continúa: `attempt.resume`); reintentar uno viejo habiendo otro posterior sería
rehacer lo ya rehecho. Lo repite también el trigger `attempt_retries_coherent`.

**Validación, en orden** (cada rechazo es `invalid` y **no escribe nada**):

| Código | Cuándo |
|---|---|
| `not_allowed` | no es una persona, el agente que coordina la Task ni el Core |
| `invalid_request` | clave, mensaje u overrides con formato inválido |
| `request_conflict` | la clave ya se usó para **otra** petición (otros overrides u origen, o una reanudación) |
| `task_missing` · `no_attempts` | la Task no existe o no tiene ningún Attempt |
| `attempt_active` | la Task ya tiene un Attempt activo (el mensaje dice cuál) |
| `source_missing` · `source_not_in_task` | el origen no existe o es de otra Task |
| `source_not_retryable` · `source_not_latest` | el origen terminó bien, o ya hay otro posterior |
| `profile_missing` | ni la petición ni el origen tienen perfil de permisos |
| `environment_blocked` · `start_unavailable` | el proveedor no puede lanzar ahora (sin crear nada) |

**Flujo.** Una transacción (`attempt_retry_recorded`): Attempt `n + 1` + fila de procedencia + `attempt.requested` +
`attempt.retried`. Luego `adapter.start` y `attempt.started`. Si el lanzamiento falla, se cierra el Attempt **nuevo** y el
anterior no se toca (abajo).

## `attempt.resume`

```
resume(store, registry, ctx, cancel, settings, ResumeCommand) -> Outcome | CommandError
```

Es `continue_attempt` (LXO-134) con el fallback hecho explícito. Reanuda la ProviderSession del Attempt `from_attempt_id`
(de la Task y terminado) en el **mismo proveedor**.

| Situación | Resultado |
|---|---|
| Soportado (mismo proveedor, `resume` disponible, sesión en espera y resumible) | Attempt `n + 1` que **corre en la misma ProviderSession** (`provider_session.resumed`); ninguna sesión nueva |
| Sesión caducada | `expired/session_expired`, `fallback_available` |
| Sin `resume` o sin sesión resumible | `unsupported/resume_unsupported` · `resume_unavailable` · `session_unavailable`, `fallback_available` |
| Otro proveedor | `invalid/provider_mismatch`, `fallback_available` (una sesión no se comparte entre proveedores) |
| Entorno bloqueado | `environment_blocked`, **sin crear nada** y sin probar otra estrategia |

**Fallback a ContextPackage, solo si el cliente lo confirma.** Sin `fallback`, un resume imposible es un error y no se crea
nada. El cliente lo ve (`fallback_available`, con el `code` que lo causó), se lo enseña a la persona y, si lo acepta, repite
el comando con `Fallback { package, confirmed_reason }`: el paquete y **el motivo que vio**. Si el motivo ya es otro, no se
aplica (`fallback_changed`, y se vuelve a ofrecer). El Attempt resultante es **limpio** (sin la sesión), `attempt.continued`
lleva `strategy = context_package` y el `reason`, y la sesión que no sirve no se toca. Si entre tanto el resume vuelve a ser
posible se reanuda de forma nativa, y la estrategia queda en el resultado.

**Qué es «activo».** Un origen que sigue activo es `source_not_final`; un origen final con **otro** Attempt activo en la
Task es `attempt_active`. Un Attempt en `waiting` o `awaiting_terminal_approval` está activo: se vuelve de esas esperas con
la respuesta del coordinador o la aprobación (`attempt.resumed`, LXO-231), no con este comando.

## Idempotencia

La clave es de la Task y **identifica una petición**, sea reintento o reanudación (triggers `attempt_retries_request_id_free`
y `attempt_continuations_request_id_free`, y las mismas comprobaciones en los dos comandos).

* Repetir la **misma** petición devuelve el Attempt que existe (`replayed = true`) con el estado que tenga, sin escribir ni
  lanzar nada. Vale aunque el Attempt ya haya terminado: nunca se crea el siguiente.
* La clave con **otra** petición es `request_conflict`, nunca se atiende lo viejo.
* Un rechazo antes de crear (entorno bloqueado, Attempt activo, origen inválido) **no gasta** la clave.
* Si el lanzamiento falla, el Attempt nuevo queda cerrado y repetir la clave devuelve ese. Para volver a intentar hace falta
  una clave nueva: cada intento es un Attempt de la historia.

## Entorno bloqueado

No es un fallo del agente (LXO-131):

* Si ya se sabe (capability `environment_blocked`), el comando devuelve `environment_blocked` **sin crear nada**.
* Si salta al lanzar, el Attempt nuevo queda `stopped`, **nunca `failed`**, y la sesión que reanudaba queda en espera.
* Así, cualquier contador de fallos del agente (futuros reintentos automáticos, fuera de este slice) que cuente `failed` no
  gasta un intento por un problema que la persona debe arreglar.

Un fallo real del proveedor (`provider`/`internal`) deja el Attempt nuevo `failed(launch_failed)`. En ningún caso se toca el
Attempt anterior (`settle_failure`, [CONTINUIDAD.md](CONTINUIDAD.md#cuando-falla-el-lanzamiento)).

## Events y Attention

Un reintento deja, en este orden: `attempt.requested`, `attempt.retried` y, tras lanzar, `attempt.started`. Una reanudación,
los de [CONTINUIDAD.md](CONTINUIDAD.md#events). Ver [EVENTOS.md](EVENTOS.md) y [ACTIVITY.md](ACTIVITY.md).

`attempt.retried` (v1, `state`, entidad `attempt`): `task`, `n`, `from_n`, `overrides?`. **Nunca** el mensaje, rutas, la
referencia del proveedor ni el contenido de un paquete. Activity: `activity.attempt.retried` en Desktop, Mobile y `lxo`
("El intento 3 de la tarea t-3 reintenta el intento 2 (otro modelo)").

**Attention.** `attempt.retried` y `attempt.continued` resuelven con `acted` el `failed` del Attempt anterior: reintentar o
reanudar es actuar sobre el fallo. Si el Attempt nuevo falla levanta **su** `failed`, sobre sí mismo; el del anterior no se
reabre ([ATTENTION.md](ATTENTION.md)).

## Esquema (`021_attempt_retries.sql`)

`attempt_retries`: una fila por Attempt que reintenta a otro. `attempt_id` (PK), `task_id`, `request_id` (único por Task),
`from_attempt_id`, `overrides` (lista JSON de nombres cerrados) y `created_at`.

* Inmutable y sin borrado (triggers). Coherencia por trigger: el origen es de la misma Task, es el **inmediatamente
  anterior** (`n - 1`) y terminó mal.
* Sin el mensaje, rutas ni referencias del proveedor. Lo que corrió de verdad está en la fila del Attempt.
* Inerte hasta el corte y **después de la barrera** (como la 015 y la 016).

## Invariantes de la issue y cómo se prueban

| # | Invariante | Prueba |
|---|---|---|
| 1 | Retry nunca reabre el Attempt anterior | `reintentar_un_attempt_fallido_crea_uno_limpio_…` (la fila del anterior no cambia), `sin_su_hecho_no_hay_reintento` |
| 2 | Resume no finge un Attempt reabierto: la misma sesión continúa en el `n + 1` | `resume_soportado_reanuda_la_misma_sesion_en_un_attempt_nuevo_…` |
| 3 | El fallback a ContextPackage es explícito y visible | `el_fallback_a_context_package_solo_se_aplica_si_el_cliente_lo_confirma_…`, `resume_con_la_sesion_caducada_o_sin_resume_no_se_hace_solo_…` |
| 4 | Un request de retry no duplica Attempts | `repetir_el_reintento_no_duplica_attempts_ni_vuelve_a_lanzar`, `una_clave_reutilizada_para_otra_cosa_…` |
| 5 | Entorno bloqueado no consume un fallo del agente | `un_entorno_bloqueado_no_crea_nada_…`, `un_bloqueo_que_salta_al_lanzar_deja_el_attempt_nuevo_stopped_y_no_failed` |
| — | Retry success / fail / idempotent | las anteriores y `un_fallo_del_proveedor_al_lanzar_…` |
| — | Resume supported / expired / unsupported | `resume_soportado_…`, `resume_con_la_sesion_caducada_o_sin_resume_…`, `resume_sin_sesion_es_no_soportado` |
| — | Attempt activo inválido | `con_un_attempt_activo_no_se_reintenta_…`, `resume_con_un_attempt_activo_o_un_origen_no_final_…` |
| — | Events y provenance | `…deja_dos_eventos…`, `store/retries_tests.rs` (procedencia, orden, inmutabilidad) |
| — | Attention | `reintentar_atiende_el_fallo_del_attempt_anterior_…`, `resume_atiende_el_fallo_…` |

Las pruebas se validaron con **mutaciones**: quitar la comprobación de `fallback_changed`, la de «solo el último» y la regla
de Attention rompen al menos una prueba cada una.

## Decisiones (LXO-142)

| # | Decisión | Alternativa descartada |
|---|---|---|
| D52 | **Resume crea el Attempt `n + 1` sobre la MISMA ProviderSession**; no reabre el anterior | reabrir el Attempt final: contradice ATTEMPTS inv. 3. «Resume no crea Attempt nuevo» solo vale para volver de una espera (`attempt.resumed`), que es otra transición |
| D53 | **Retry solo sobre lo que terminó mal y solo sobre el último** | reintentar un `done` (es un seguimiento) o un Attempt viejo (dos clientes con claves distintas duplicarían el trabajo) |
| D54 | **Procedencia en su propia tabla y evento (`attempt.retried`)**, no una tercera estrategia de `attempt_continuations` | ampliar `strategy`: un retry no continúa nada, y obliga a reconstruir la 016 |
| D55 | **El fallback lleva el motivo confirmado** (`confirmed_reason`) | confirmar solo con el paquete: la persona aceptó un fallback por una causa y se aplicaría por otra |
| D56 | **Una clave identifica una petición de la Task** entre reintentos y reanudaciones | espacios de claves separados: la misma clave podría significar dos cosas según el comando |
| D57 | **Reintentar o reanudar resuelve el `failed` del anterior (`acted`)** | dejarlo activo: el panel seguiría pidiendo atención por algo ya atendido |

## Fuera de este slice

El RPC y `lxo` (`lxo attempt retry` / `resume`), la UI, la política de reintento automático, la carrera/Fork entre Attempts
(F6) y construir el ContextPackage (`lxo context`, LXO-138: lo aporta quien llama). Tampoco se ha probado una reanudación
real de una sesión existente: las pruebas usan adapters falsos, como en [CONTINUIDAD.md](CONTINUIDAD.md#sin-validar-con-la-cli-real).

## Puente al despachador (proyecto de cuatro PR)

`attempt.retry` y `attempt.resume` de arriba trabajan **directamente sobre el almacén** y lanzan ellos mismos. El camino que de
verdad lanza hoy es otro: el estado en memoria cambia, sus Events se proyectan a las tablas y el despachador (`dispatch.rs`)
reserva el claim, el lanzador (`adapter_launcher.rs`) crea el worktree y llama al adapter. Un reintento por la vía del almacén
correría fuera del claim, sin bombeo de eventos y con el estado en memoria desfasado. El puente hace que un reintento use el
**mismo camino** que el primer Attempt:

| PR | Qué | Estado |
|---|---|---|
| 1 | `Tx::request_attempt_retry` (estado en memoria) + el lanzador reutiliza el Worktree de la Task | **hecho** |
| 2 | `attempt.retried` en la misma mutación que el Attempt nuevo (resuelve el `failed` del anterior) | **hecho** |
| 3 | RPC `attempt_retry` (solo una Person de Desktop) y el botón Reintentar | **hecho** |
| 4 | `resume`: el lanzador elige `start` o `resume` (reutiliza la ProviderSession) + su RPC y botón | **hecho** (solo reanudación nativa) |

### PR 1 · lo que hace

* `Tx::request_attempt_retry(task, RetrySelection)` pasa la Task de `failed`/`stopped`/`exited` a `starting`. Como en cualquier paso
  de un final a un activo, nace el Attempt `n + 1` (`attempt.requested`) con la selección que se pida; el anterior sigue final.
  Exige una Person autenticada. El modelo y el esfuerzo se heredan solo dentro del mismo proveedor; el rol y el perfil, siempre.
* El Attempt nuevo queda `starting` con el claim `none`. **No pide aprobación**: la petición de la persona es la decisión, y la
  reserva del claim ya distingue las continuaciones (`n > 1`) del primer Attempt de `task.create`.
* El barrido periódico (`approved_dispatch_candidates`) solo recoge Attempts con plazo de aprobación, así que **no** lanza un
  reintento por su cuenta: se despacha por `dispatch_attempt`, que llamará el RPC del PR 3 tras despertar al despachador.

### PR 2 · lo que hace

`request_attempt_retry` emite `attempt.retried` (`task`, `n`, `from_n` y `overrides`, solo los parámetros que se pidieron distintos) en la
**misma mutación** que crea el Attempt: están los dos o ninguno. Es lo que resuelve la Attention `failed` del Attempt anterior
(`acted`): sin él, tras reintentar, el fallo viejo seguiría pidiendo atención («el fallo de un Attempt anterior sigue siendo suyo»).

### PR 3 · lo que hace

El RPC `attempt_retry` ([TASKS.md](TASKS.md#rpc-del-reintento-attempt_retry)) valida la petición (Person de Desktop, el último Attempt, lanzador, Project y
proveedor), llama a `Tx::request_attempt_retry` y despierta al despachador. El barrido del despachador recoge los reintentos: la
consulta de candidatos añade a los aprobados los Attempts `n > 1` en `starting`, sin plazo, no externos y con `attempt.retried` o
`attempt.continued`. La interfaz es el botón «Reintentar» del detalle del Attempt.

### PR 4 · lo que hace

`Tx::request_attempt_continuation` pasa la Task final a `starting` **conservando la sesión** (`session_ref`): el proyector enlaza el Attempt
nuevo a la ProviderSession de la Task al nacer y se emite `attempt.continued` en la misma mutación (atiende el `failed` del anterior). El mensaje se
añade al `spec` como bloque «Seguimiento» (la convención de `lxo continue`). El despachador lee la sesión enlazada del Attempt
(`DispatchSnapshot.session`) y construye una intención que **reanuda**: `DispatchIntent.resume` lleva la referencia de la sesión durable y
`prompt` es el último bloque «Seguimiento», no el `spec` entero. El lanzador exige `Capability::Resume` en vez de `Start` y llama a
`adapter.resume`. El RPC `attempt_resume` ([TASKS.md](TASKS.md#rpc-de-la-continuación-attempt_resume)) valida que la sesión del Attempt anterior sirva
(en espera, resumible, con referencia, del mismo proveedor) y que el proveedor ofrezca `resume`, todo ANTES de escribir nada.

### Decisiones

| # | Decisión | Descartada |
|---|---|---|
| D58 | **Un reintento trabaja en el Worktree de la Task** (se adjunta a él; no crea otro) | un Worktree por Attempt: el proyector admite uno por Task («la ruta, la rama y la base no cambian», «un Worktree quitado no vuelve»); cambiarlo es una migración y un cambio de modelo aparte |
| D59 | **Con el Worktree retirado o ausente en disco no se reintenta**: el Attempt nuevo se cierra `stopped` («no hay dónde reintentar»), nunca `failed` | crear uno nuevo: el proyector lo rechazaría después de crearlo en disco |
| D60 | **El prompt de un reintento es el `spec` de la Task** (como el del primer Attempt) | un `prompt` propio por petición: necesita guardarlo en el Attempt, y entra con `resume` en el PR 4 |
| D61 | **La procedencia del reintento vive en el evento `attempt.retried`; esta vía no escribe `attempt_retries`** | duplicarla en la tabla: ningún consumidor la lee por esta vía, y escribirla en la misma transacción obligaría a generalizar el commit idempotente de `task.create` (método y validaciones fijos). La tabla queda para el comando por el almacén hasta que se retire |
| D62 | **El barrido recoge los reintentos por la prueba de su evento**, no por el simple hecho de ser `n > 1` sin plazo | recoger cualquier `starting` sin plazo: lanzaría lo que ninguna persona pidió. La reserva del claim ya admite las continuaciones; el barrido exige además `attempt.retried` / `attempt.continued` |
| D63 | **El RPC no acepta perfil y nombra el Attempt que se reintenta** | aceptar `profile`: un reintento ampliaría permisos sin pasar por la política de `task_create`. Sin `from_attempt_id`: «reintenta el último» no es una petición exacta y no podría ser idempotente sin la tabla de procedencia (D61) |
| D64 | **Solo reanudación nativa**: sin sesión que sirva es un error que lo dice | caer al ContextPackage: arranca limpio con el paquete del Attempt anterior y exige que la persona vea y confirme el motivo (`fallback_available`); entra en otro PR |
| D65 | **El mensaje de la continuación es el último bloque «Seguimiento» del `spec`** | una columna nueva en el Attempt: migración y un campo más en `AttemptRow` por un texto que el proyector ya extrae (`follow_up`) |
| D66 | **Un Attempt enlazado a una sesión al nacer la REANUDA; la señal es el enlace durable**, no una bandera del cliente | que el RPC diga «reanuda» en el Attempt: un cliente podría pedir reanudar una sesión que no es la de la Task. El reintento limpia `session_ref`, así que nace sin enlace y arranca |

Límite conocido: el reintento arranca con el **proveedor limpio pero sobre los mismos archivos**: lo que dejó a medias el Attempt
fallido sigue en el Worktree. Es consecuencia de D58.

Límites conocidos de la continuación: cada una **añade un bloque al `spec`** de la Task (como `lxo continue`); y si el proveedor devolviera otra
referencia al reanudar, la Task conserva la primera (el `SessionBound` posterior se ignora). **No se ha probado con una CLI real**: solo con adapters falsos.

Pruebas: `orch/attempt_e2e_tests.rs` (`reintentar_…`), con adapters falsos, por la misma entrada que usará el RPC.
