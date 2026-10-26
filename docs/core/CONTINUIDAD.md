# Continuidad de un Attempt: resume nativo y fallback a ContextPackage (LXO-134)

Estado: **implementado, inerte hasta el corte**. Último paso de código del Core F4
([adapters](ADAPTERS.md) · [ContextPackage](CONTEXT_PACKAGE.md) · [ProviderSession](SESIONES_THREADS.md)).

Cuando una Task necesita otro Attempt después de que uno terminó, hay dos formas de seguir:

| Estrategia | Qué hace | Qué conserva | Cuándo |
|---|---|---|---|
| `native_resume` | reanuda la **ProviderSession** del Attempt anterior | lo que el proveedor guarda de la conversación (razonamiento, salidas de herramientas) | mismo proveedor, el adapter ofrece `resume` y la sesión sirve |
| `context_package` | Attempt **limpio** con un ContextPackage v1 | la intención y la evidencia verificable; no el estado interno del proveedor | cambia el proveedor, no hay `resume`, la sesión no sirve o se pidió un Attempt limpio |

La política es la D43 de [CONTEXT_PACKAGE.md](CONTEXT_PACKAGE.md). **Nunca se finge portabilidad de una ProviderSession
entre proveedores.**

Código: `orch/continuity.rs` (política y comando), `store/continuity.rs` (transacción y lecturas), migración
[`016_attempt_continuity.sql`](../../apps/desktop/src-tauri/src/store/migrations/016_attempt_continuity.sql). Pruebas:
`orch/continuity_tests.rs`, `store/continuity_tests.rs`.

## El comando

```
continue_attempt(store, registry, ctx, cancel, settings, request) -> Outcome | ContinuityError
```

1. **Autorizar y validar** la petición, antes de leer nada: persona, el agente que coordina la Task, o el Core.
2. **Validar el paquete** si llegó, **se vaya a usar o no** (`context_package::parse`). Un paquete inválido no inicia nada.
3. **¿Ya se atendió `request_id`?** Devuelve el Attempt que existe, sin escribir ni lanzar nada (`replayed = true`).
4. Leer el Attempt anterior (de la Task, terminado) y su sesión; comprobar su dueño.
5. **Decidir** (función pura, abajo).
6. **Una transacción**: Attempt nuevo + fila de continuidad + (nativo) sesión reanudada + eventos.
7. **Lanzar** (`resume` o `start`) y marcar `attempt.started`. Si falla, se cierra el Attempt nuevo (abajo).

### La petición

| Campo | |
|---|---|
| `request_id` | clave de idempotencia de la Task: 1–64 caracteres entre letras, dígitos, `_`, `.`, `-` |
| `task_id`, `from_attempt_id` | el Attempt anterior: de la Task y ya terminado |
| `provider` | el del Attempt **nuevo**. Distinto del anterior ⇒ solo con paquete |
| `intent` | `Native` · `Package(json)` · `Auto { package? }` |
| `prompt`, `worktree` | el mensaje con que continúa (con un paquete, va detrás del contexto) y dónde |
| `profile?`, `model?`, `effort?` | `None` hereda: el perfil del Attempt anterior; el modelo y el esfuerzo solo si es el mismo proveedor |

`Intent` es la forma de que **nada pase en silencio**:

| Intent | Si el resume nativo es posible | Si no lo es |
|---|---|---|
| `Native` | nativo | **error**; nunca cae a un paquete |
| `Package(json)` | paquete (un Attempt limpio a petición) | paquete |
| `Auto { package }` | nativo | paquete **si se aportó** (con su motivo); si no, **error** con `fallback_available` |

El Core no construye paquetes (necesita la evidencia de git: `lxo context`, LXO-138): quien llama lo aporta. Un cliente ve
`fallback_available = true` y decide si lo ofrece; el Core nunca lo aplica solo.

## Política

Resume nativo **solo si** se cumplen las seis:

1. el proveedor del Attempt nuevo es el mismo que el del anterior;
2. la matriz del adapter tiene `resume` `available`;
3. el Attempt anterior corrió en una ProviderSession (de **su** Task y **su** proveedor: si no, `session_not_owned`);
4. la sesión está `idle`, es resumible y el proveedor entregó su referencia;
5. no está cerrada ni fuera de plazo (`Settings.session_max_age_ms`, sin plazo por defecto);
6. el entorno del proveedor no está bloqueado.

Si no se cumplen, la causa es **una** (la primera de la lista) y es el `reason` que queda registrado:

| `reason` | Causa | Categoría del error si no hay paquete |
|---|---|---|
| `preferred` | resume nativo (la única estrategia nativa) | — |
| `requested` | quien llamó pidió el paquete | — |
| `provider_changed` | el Attempt nuevo es de otro proveedor | `invalid` · `provider_mismatch` |
| `resume_unsupported` | el adapter no ofrece `resume` (o no ahora) | `unsupported` · `resume_unsupported` / `resume_unavailable` |
| `session_unavailable` | no hay sesión resumible: ninguna, sin referencia, `open` | `unsupported` · `session_unavailable` |
| `session_expired` | cerrada, fuera de plazo o el proveedor ya no la tiene | `expired` · `session_expired` |

**El entorno bloqueado no se esquiva**: si el proveedor está `environment_blocked` el resultado es
`environment_blocked` con cualquier `intent`, sin crear nada y sin probar otra estrategia. Tampoco es un Attempt fallido.

## Errores

`ContinuityError { kind, code, message, fallback_available, attempt_id? }`. La categoría es un conjunto cerrado:

| `kind` | Significa |
|---|---|
| `unsupported` | no hay con qué continuar así (sin `resume`, sin sesión resumible, sin `start`) |
| `expired` | la sesión caducó |
| `invalid` | la petición no vale: paquete inválido, `request_conflict`, `provider_mismatch`, `not_allowed`, `source_not_final`… |
| `environment_blocked` | el entorno impide usar el proveedor |
| `failed` | el proveedor o el adapter fallaron al lanzar; el Attempt nuevo quedó `failed` |

Las cuatro primeras son las de la issue; `failed` es la quinta, necesaria porque un fallo de lanzamiento no es ninguna de
las otras. `attempt_id` nombra el Attempt nuevo que el fallo dejó cerrado, si llegó a crearse.

Códigos de `invalid`: `not_allowed` · `invalid_request` · `package_invalid` (con el código de `PackageErrorCode` en el
mensaje) · `package_missing` · `package_source_mismatch` (el paquete no sale del Attempt al que se continúa) ·
`request_conflict` (la clave se usó para otra continuidad) · `source_missing` · `source_not_in_task` · `source_not_final` ·
`session_not_owned` · `profile_missing` · `provider_mismatch` · `conflict` · `model_inactive` · `store`.

## Cuando falla el lanzamiento

El Attempt **anterior no cambia nunca**. Sobre el nuevo (`settle_failure`):

| Error del adapter | Attempt nuevo | Sesión (si reanudó una) |
|---|---|---|
| `session_not_found` | `stopped` | `closed` (el proveedor ya no la tiene) |
| `environment_blocked`, capability ausente, petición inválida, cancelación | `stopped` | `idle` |
| `provider` / `internal` | `failed` (`launch_failed`) | `idle` |

`stopped` y no `failed` cuando nada llegó a ejecutarse: igual que en LXO-131, un entorno bloqueado **no** es un Attempt
fallido. `settle_failure` también sirve al runtime cuando el flujo de eventos de una reanudación termina con
`session_not_found` (Claude lo informa en su `result`, no al lanzar). Es idempotente.

Repetir con la **misma** `request_id` devuelve ese Attempt cerrado, sin relanzar. Para volver a intentar hace falta una
`request_id` nueva.

## Detección de la sesión caducada

`session_not_found` es un código nuevo del contrato de adapters ([ADAPTERS.md](ADAPTERS.md#errores)). Cada adapter lo
levanta con un texto **observado en el CLI real**, y solo al reanudar:

| Proveedor | Texto observado | Dónde |
|---|---|---|
| Claude 2.1.296 | `No conversation found with session ID: <id>` en `errors` del `result` | al terminar el flujo (`RunOutcome::Failed`) |
| Codex 0.164.0 | `thread/resume failed: no rollout found for thread id <id>` (código -32600) | al lanzar (`resume()` devuelve el error) |

Cualquier otro texto, o el mismo en una llamada que no es `resume`, sigue siendo un fallo normal del proveedor.

## Esquema (`016_attempt_continuity.sql`)

`attempt_continuations`: una fila por Attempt que continúa a otro. `attempt_id` (PK), `task_id`, `request_id` (único por
Task), `strategy`, `reason`, `from_attempt_id`, `provider_session_id` (solo nativo, el id de Lixbon `ps-…`),
`package_id` (solo paquete, el `sha256:…`), `created_at`.

* **Nunca** la referencia opaca del proveedor ni el contenido del paquete.
* La estrategia decide qué lleva (`CHECK`): nativo ⇒ sesión y `reason = preferred`; paquete ⇒ `package_id` y otro `reason`.
* Inmutable y sin borrado (triggers). Coherencia por trigger: el anterior es de la misma Task, es anterior y ya terminó; la
  sesión es de la Task y del proveedor del Attempt nuevo.
* Inerte hasta el corte, y va **después de la barrera** (como la 015): solo se aplica en una base ya cortada.

## Events

`attempt.continued` (v1, `state`, entidad `attempt`): `task`, `n`, `from_n`, `strategy`, `reason`, `package_id?`. Sin la
referencia del proveedor. Una continuidad deja, en este orden: `attempt.requested`, `attempt.continued`, y si fue nativa
`provider_session.resumed`, y tras lanzar `attempt.started`. Activity: `activity.attempt.continued` en Desktop, Mobile y
`lxo`. Contrato en [EVENTOS.md](EVENTOS.md) y [ACTIVITY.md](ACTIVITY.md).

## Invariantes de la issue y cómo se prueban

| # | Invariante | Prueba |
|---|---|---|
| 1 | El resume nunca crea continuidad ficticia | `sin_resume_el_paquete_aportado_…`, `sin_resume_y_sin_paquete_no_se_hace_nada_…` (el adapter no recibe `resume`) |
| 2 | La sesión es del proveedor y Attempt correctos | `una_sesion_no_se_comparte_entre_proveedores_…`, `la_sesion_es_de_la_task_y_la_corrio_el_attempt_anterior` (almacén) |
| 3 | Un fallo no muta el Attempt histórico | `si_el_proveedor_ya_no_tiene_la_sesion_…`, `un_fallo_del_proveedor_al_lanzar_…` |
| 4 | El fallback crea un Attempt nuevo con procedencia | `sin_resume_el_paquete_aportado_…` (evento con `package_id` y `reason`) |
| 5 | El cliente sabe qué estrategia se usó | `Outcome.continuation`, `attempt.continued`, `ContinuityError.fallback_available` |
| — | Sin duplicados al repetir el comando | `repetir_el_comando_no_crea_otro_attempt_…`, `repetir_la_peticion_…` (almacén) |
| — | Sin auto-resume ni fallback silencioso | `sin_resume_y_sin_paquete_…`, `la_tabla_de_la_politica_…` (las 18 combinaciones × 3 intents) |
| — | Paquete inválido no inicia nada | `un_paquete_invalido_no_inicia_ningun_attempt_…` |

Las pruebas de la política se validaron con **mutaciones**: siete cambios deliberados (caer a paquete sin él, ignorar el
proveedor, esquivar el entorno bloqueado, no validar el paquete, marcar `failed` por un bloqueo, no cerrar la sesión
caducada, atender una clave reutilizada) rompen al menos una prueba cada uno.

## Decisiones

| # | Decisión | Alternativa descartada |
|---|---|---|
| D45 | **`Intent` explícito; el Core no cae a un paquete por su cuenta.** `Auto` solo cae si se aportó el paquete | caer siempre que se pueda: es el auto-resume silencioso que la issue prohíbe |
| D46 | **Idempotencia por `request_id` de la Task, resuelta en el almacén.** Repetir devuelve lo que existe; una clave reutilizada para otra cosa es `request_conflict` | deducir la repetición por «mismo Attempt anterior»: dos continuidades legítimas del mismo Attempt serían una |
| D47 | **Sin plazo de caducidad por defecto.** `session_max_age_ms` es opcional | inventar 30 días: ningún proveedor lo ha confirmado y rechazaría sesiones válidas |
| D48 | **`session_not_found` es un código del contrato de adapters**, levantado solo con el texto observado y solo al reanudar | clasificar por el texto en el Core: el Core volvería a ramificar por proveedor |
| D49 | **`stopped`, no `failed`, si nada llegó a ejecutarse.** Un entorno bloqueado nunca falla el Attempt | `failed` para todo: contradice LXO-131 |
| D50 | **El entorno bloqueado no se esquiva con otra estrategia** | caer a paquete: ocultaría un problema que la persona debe arreglar |
| D51 | **Un paquete debe salir del Attempt al que se continúa** (`source.task`, `source.attempt`) | aceptar cualquier paquete de la Task: la procedencia dejaría de ser verificable |

## Fuera de este slice

El comando de reintento y resume del Attempt que lo expone al RPC y a `lxo` (F5, LXO-142), leer el flujo de eventos del
proveedor tras lanzar (el runtime), construir el paquete (`lxo context`, LXO-138), la UI (LXO-135/136), la aprobación previa
de un seguimiento (`requires_approval` es siempre `false` aquí) y el handoff entre Tasks (F6, LXO-172).

## Sin validar con la CLI real

Lo probado contra los CLI reales es **cómo falla** una reanudación de una sesión inexistente (Claude 2.1.296 y Codex 0.164.0).
**No** se ha probado una reanudación real de una sesión existente a través de este comando: las pruebas del comando usan
adapters falsos. Los adapters reales ya prueban `--resume` / `thread/resume` por su lado (LXO-129/130).
