# Task como intención durable (LXO-113)

Estado: **esquema y mutadores implementados, inertes hasta el corte**. Es el primer paso de código de la épica
`[CORE][F3]` ([ADR](CORTE_TASK_ATTEMPT.md)). La Task guarda **qué se quiere hacer**, en qué Project y dentro de qué
Run; la ejecución (proceso, terminal, worktree, sesión del proveedor, informe) será del Attempt (LXO-114 en adelante).

* Migración: [`007_tasks.sql`](../../apps/desktop/src-tauri/src/store/migrations/007_tasks.sql).
* Almacén: `store/tasks.rs` (filas, restricciones, atomicidad). Pruebas: `store/tasks_tests.rs`.
* Hechos y permisos: `orch/task_ops.rs` (el único que construye sus eventos). Pruebas: `orch/task_ops_tests.rs`.
* LXO-141 (RPC `task_create`): migración [`017_task_create_idempotency.sql`](../../apps/desktop/src-tauri/src/store/migrations/017_task_create_idempotency.sql),
  parser `orch/task_create_api.rs`, commit idempotente `store/runtime.rs::runtime_commit_idempotent_recorded` y
  `Tx::create_run_intent`. Ver [§ LXO-141](#lxo-141-crear-una-intención-con-task_create).

## Inerte hasta el corte

Hasta que la migración del corte copie `legacy_state` y escriba `meta.agentic_model = task_attempt_v1`, la autoridad
de las tareas sigue siendo el documento legacy. Mientras tanto:

* las tablas `runs` y `tasks` existen y están **vacías**;
* cada mutador del almacén devuelve `AgenticModelInactive` **sin escribir nada** (ni filas, ni eventos, ni el
  contador de ids);
* los triggers `runs_inert_*` y `tasks_inert_*` abortan cualquier `INSERT`, `UPDATE` o `DELETE` que se salte el
  almacén;
* nada está conectado al RPC, a `lxo` ni a la interfaz.

Así el esquema puede publicarse antes que los datos sin que nazca una segunda autoridad (ADR D15, revisada en
LXO-113). El corte escribe `meta.agentic_model` **antes** de copiar.

## Invariantes y cómo se prueban

| # | Invariante | Mecanismo | Prueba |
|---|---|---|---|
| 1 | La Task no contiene PID, PTY, worktree ni sesión del proveedor | la 007 no tiene esas columnas; la lista de columnas está fijada | `la_007_es_una_migracion_hacia_adelante_y_la_task_no_lleva_ejecucion` |
| 2 | Project pertenece a Task | `tasks.project_id` FK real; `CHECK (project_id IS NOT NULL OR origin = 'legacy')`; la hija hereda el del padre; el trigger `tasks_core_tree` lo comprueba | `project_es_obligatorio_en_toda_task_del_core`, `una_hija_hereda_run_y_project_un_nivel_por_debajo`, `la_base_impone_el_arbol_y_que_la_pertenencia_no_cambie` |
| 3 | Borrar una Task con historia o dependientes exige política explícita; no hay cascada | ninguna FK lleva `ON DELETE`; la única vía es `TaskRemoval::IfUnused`; la base rechaza el COMMIT si otra fila depende de la Task; el Event Log no se toca | `solo_se_borra_una_task_sin_uso_y_su_historia_se_queda`, `la_base_no_borra_en_cascada_aunque_se_salte_la_politica` |
| 4 | Fila durable + Event son atómicos | cada mutador es UNA transacción con sus filas, sus eventos y la proyección de Attention | `sin_su_hecho_no_hay_cambio`, `un_evento_que_no_se_refiere_a_la_task_o_repetido_deshace_el_cambio`, `si_la_proyeccion_falla_no_queda_ni_la_task_ni_su_evento` |
| 5 | Antes del corte no hay segunda autoridad | `AgenticModelInactive` + triggers `*_inert_*` | `antes_del_corte_ningun_mutador_escribe_y_no_queda_rastro`, `antes_del_corte_la_base_rechaza_escribir_aunque_se_salte_el_almacen` |
| 6 | La pertenencia no cambia después de nacer | trigger `tasks_ownership_immutable` (id, run, padre, profundidad, origen, creación; Project solo se puede completar si era `NULL`) | `la_base_impone_el_arbol_y_que_la_pertenencia_no_cambie` |
| 7 | La migración es solo hacia adelante y no se edita | sin `DROP`/`ALTER`/`ON DELETE`/`CASCADE`; checksum congelado | `la_007_es_una_migracion_hacia_adelante_y_la_task_no_lleva_ejecucion`, `la_migracion_007_tiene_el_checksum_congelado` |
| 8 | El esquema llega por el gate autoritativo y no cambia el runtime legacy | un Core real arranca en la 7 con las tablas vacías e inertes; `run_create` sigue escribiendo el documento | `un_core_real_aplica_la_007_y_sus_tablas_quedan_inertes_mientras_el_legacy_sigue_mandando` |

## Esquema (`007_tasks.sql`)

### `tasks`

| Columna | Para qué |
|---|---|
| `id` | `tN` del contador compartido `meta.id_seq` (ADR §8). Las del legado conservan su id |
| `run_id` | Run al que pertenece (FK diferida) |
| `parent_task_id`, `depth` | árbol de coordinación. `parent IS NULL ⇔ depth = 0` |
| `project_id` | FK a `projects`. Obligatorio salvo en filas importadas (`origin = 'legacy'`, ADR D1) |
| `title`, `spec` | la intención: título y encargo |
| `repo` | ruta local donde se creó (ADR D18). No identifica nada |
| `intent` | `open` · `discarded`: lo único de su estado que se guarda (es una decisión de la persona) |
| `origin` | `legacy` (copiada por el corte) · `core` |
| `created_at`, `updated_at`, `discarded_at` | ms epoch, fijados por quien llama (la hora del evento) |

Las comprobaciones de forma (título no vacío, `updated_at >= created_at`, árbol coherente) solo se imponen a las
filas `core`: el legado se importa tal cual y no puede abortar el corte.

### `runs`

`id` (`rN`), `objective`, `root_task_id` (FK diferida a `tasks`), `created_at`, `closed`, `last_activity`. Es la
agrupación legacy que se conserva (ADR D16). En este slice no hay mutadores propios de Run más allá de nacer con su
raíz.

### Estado de la Task

La Task **no** guarda estado de ejecución. Su estado visible será derivado (ADR §7, D17): `discarded` si la persona
la descartó y, si no, lo que digan sus Attempts (`open` sin intentos, `in_progress`, `in_review`, `integrated`). La
derivación llega con el Attempt (LXO-114).

## Mutadores

Todos en `store/tasks.rs`, todos `*_recorded`: una transacción con las filas y su evento. Los ids nacen dentro de la
transacción; el evento lo construye `task_ops` con un closure puro que recibe las filas ya escritas.

| Mutador | Qué hace | Rechaza (`TaskConflict` / `InvalidTask`) | Resultado |
|---|---|---|---|
| `run_create_recorded` | Run + Task raíz en un Project | Project inexistente; título vacío | `(RunRow, TaskRow)` |
| `task_create_child_recorded` | hija: hereda Run y Project, `depth + 1` | padre inexistente o descartado; Run cerrado; padre sin Project; título vacío | `TaskRow` |
| `task_update_intent_recorded` | cambia `title` y/o `spec` | Task descartada; cambio vacío; título vacío | `Changed` · `Unchanged` (sin evento) · `Missing` |
| `task_set_discarded_recorded` | descarta o restaura | descartar con hijas abiertas; restaurar con el padre descartado (sin cascada en ningún sentido) | `Changed` · `Unchanged` · `Missing` |
| `task_remove_recorded(TaskRemoval::IfUnused)` | borra | la raíz de su Run; con hijas; con cualquier fila que dependa de ella (la base) | `Changed` · `Missing` |

Lecturas: `task_row`, `run_row`, `tasks_of_run`, `tasks_of_project(include_discarded)`, `task_children`.

**Desde LXO-114** ([`ATTEMPTS.md`](ATTEMPTS.md)): una Task con un Attempt **activo** no se descarta (`task_set_discarded_recorded`
y un trigger de la 008; se cancela antes) y una Task con **cualquier** Attempt no se borra (`task_remove_recorded`): su
historia se conserva descartándola.

## Quién puede (`orch/task_ops.rs`)

| Operación | Persona | Agente (su Task) | Sistema |
|---|---|---|---|
| crear un Run con su raíz | sí | sí | sí |
| crear una hija | sí | solo bajo su propia Task o sus descendientes | sí |
| cambiar título o encargo | sí | solo de su Task o sus descendientes | no |
| descartar · restaurar · borrar | sí | no | no |

Una denegación es `TaskConflict` y no escribe nada.

## Events

Contrato completo en [`EVENTOS.md`](EVENTOS.md#task-como-intención-lxo-113). Run y Project van explícitos, leídos de la
fila confirmada. **Nunca** el encargo (`spec`), rutas, proceso, worktree ni sesión.

| Mutador | Events (en orden) | class |
|---|---|---|
| `run_create_recorded` | `run.created {root_task}` (v1, misma forma que el legacy) · `task.created {parent, depth, title}` (**v2**) | state |
| `task_create_child_recorded` | `task.created` (v2) | state |
| `task_update_intent_recorded` | `task.updated {changed: ["title" \| "spec"], title?}` (v1) | state |
| `task_set_discarded_recorded` | `task.discarded {}` · `task.restored {}` (v1) | decision |
| `task_remove_recorded` | `task.removed {cause: "unused"}` (v1, causa nueva) | state |

`task.created` sube a **v2** porque la v1 mezclaba datos de la ejecución (`agent`, `role`, `model`, `external`), que
tras el corte son del Attempt. La v1 sigue siendo la que emite el runtime legacy; Activity sabe leer las dos
([`ACTIVITY.md`](ACTIVITY.md)).

## Mutation testing

Manual, como en [`ATTENTION_MUTACION.md`](ATTENTION_MUTACION.md): cada mutante se aplica uno a uno sobre el código de
producción, se ejecutan `tasks_tests` y `task_ops_tests` y el archivo se restaura byte a byte. Inventario y
resultados en [`TASKS_MUTACION.md`](TASKS_MUTACION.md).

## LXO-141: crear una intención con `task_create`

`task_create` crea un **Run con su Task raíz en `not_started`** dentro de un Project explícito. Sin `attempt` no crea
Attempt, no elige provider, no pide aprobación ni lanza ningún proceso: es solo la intención durable. Con `attempt` pide
además el primer Attempt (ver [§ Primer Attempt con `task_create`](#primer-attempt-con-task_create-fase-2c-3)); mientras el
Core no tenga un lanzador instalado, esa solicitud se rechaza **antes** de tocar el ledger, los eventos o la memoria
(`task.create con Attempt requiere el lifecycle de lanzamiento verificado`). El lanzador real se instala **solo con el
Orquestador activado** (ver [§ Encender el lanzador](#encender-el-lanzador-lxo-246-pr-d)); con el ajuste desactivado, `attempt`
sigue rechazado.

* **Quién:** solo una Person autenticada (CLI global o Desktop). Un Agent se rechaza en el handler, antes de mutar. La
  identidad sale de la credencial, nunca del JSON: los campos `identity_scope`, `actor` o `client_id` en la solicitud son
  un error.
* **Project:** `project_id` es obligatorio y no se infiere por `cwd`. Se comprueba (`check_project_launchable_id`) **fuera**
  del lock del estado, porque lee disco y escribe marcas, y solo si la petición no es un replay; el almacén vuelve a exigir
  que el Project exista dentro de la transacción.
* **Idempotencia:** la clave es `(identity_scope, 'task.create', request_id)`, con `identity_scope = user:<person>`.
  La huella es el SHA-256 de la forma canónica del payload (`project_id`, `objective`, `title`, `spec`, `repo` y `attempt`,
  del que solo entra la selección que eligió el cliente; sin `attempt` el hash es el de siempre). Mismo scope, id y huella devuelve los ids originales como `Replayed`, **sin escribir, sin publicar y sin subir
  la revisión**; el mismo id con otro payload es un conflicto. Un replay no depende del estado actual del Project.
* **Orden:** consulta del ledger sin el lock del estado → comprobación del Project → `Core::mutate_idempotent_recorded`, que
  repite la consulta bajo el lock y la transacción final la repite bajo `BEGIN IMMEDIATE` (escritores concurrentes). La
  persistencia usa la misma política de reintentos que el resto de mutaciones: un error transitorio de SQLite se reintenta
  y **no** deja el Core en solo lectura; una lectura del ledger que falla no lo degrada.
* **Hechos:** `run.created` (v1) y `task.created` (v2, solo `parent`, `depth` y `title`), atribuidos al contexto
  autenticado (actor Person, canal, `client_id`, Project y Run) y en la misma revisión. Las rutas legacy `create_run` y
  `add_child` conservan `task.created` v1.
* **Ledger (017):** `task_create_requests` guarda scope, método, `request_id`, huella, Run y Task (y el Attempt, si lo hay). Las inserciones están **inertes hasta el corte** (`meta.agentic_model`), las filas son inmutables
  y no se borran, y una Task nace de una sola petición (`UNIQUE(task_id)`).

### Aprobación inicial (fase 2a, inerte)

Un Attempt puede nacer `pending_approval`: espera la decisión de una **Person autenticada** hasta un plazo **durable** de
30 minutos (`attempts.initial_approval_deadline`, migración 019), fijado por el servidor al crearlo. La Task raíz lo refleja
con el estado `pending_approval` (distinto de `awaiting_terminal_approval`, que es la aprobación de una terminal).

* **Quién decide:** solo una Person autenticada con `client_id` (`Tx::approve_attempt` / `Tx::reject_attempt`). Un Agent, el
  Core o una Person sin `client_id` no cambian nada ni dejan hechos.
* **Qué cuenta como decisión:** el almacén exige la **evidencia canónica**: el evento `attempt.approved` o `attempt.rejected`
  tiene que ser el que el Core habría emitido (actor Person con credencial registrada y vigente en el instante del evento,
  canal, Project, Run, plazo vigente) y ningún hecho posterior lo contradice. Aprobar con el plazo vencido se rechaza.
* **Expiración:** el hilo periódico del Core (`Core::periodic_sweep`, cada 60 s, junto al cierre de Runs inactivos) busca los
  Attempts pendientes con el plazo vencido y cada uno se expira por `Core::mutate`: la Task pasa a `stopped` y se emite
  `attempt.rejected` con causa `approval_timeout` (actor System, canal Core). El commit revalida el plazo bajo la
  transacción: el candidato que entrega SQLite no autoriza nada por sí solo. Si el almacén no está disponible o el Core está en
  solo lectura, no se expira nada.
* **Tareas periódicas:** un Run que espera una decisión no es «inactivo» y no se cierra por inactividad; cerrarlo a mano
  mientras su raíz espera se rechaza con un mensaje claro (hay que aprobar o rechazar antes).
* **Barrera del corte:** la columna del plazo solo la escribe y lee un Attempt que nace `pending_approval`. El resto del
  almacén no depende de la migración 019, que queda detrás de la barrera (014).
* **Guard del ledger (018):** `INSERT OR REPLACE` sobre `task_create_requests` sustituye la fila sin disparar el trigger de
  borrado mientras `recursive_triggers` esté OFF, y la huella original se perdería. La migración 018 lo aborta con un trigger
  local; no se cambia ningún PRAGMA de la base.

Esta fase es **inerte**: `task_create` sigue rechazando todo `attempt` y los RPC de decisión no existen todavía. Pedir el
primer Attempt, decidirlo y lanzarlo se conecta en la fase siguiente (`Tx::request_initial_attempt`, la resolución de la
decisión y el despacho). Hoy solo ejecutan este código las pruebas y el barrido de expiración.

### Claim de despacho (fase 2b, inerte)

Antes de cualquier efecto externo, el despacho de un Attempt reserva un **claim durable de un solo uso**
(`attempts.dispatch_claim`, migración 020). El orden del protocolo es: reservar → registrar `attempt.started` → marcar el
claim `started` → llamar al proveedor. Los estados son `none → reserved → started → settled`, con `ambiguous` cuando el
Core reinicia sin poder probar el desenlace; el trigger de la base impide reiniciar un claim o saltarse pasos.

* **Reservar (`attempt_dispatch_reserve`):** solo si el Attempt es del Core y está `starting`, su Task sigue abierta en un Run
  abierto y un Project activo y, para el primer Attempt de una Task de `task.create`, existe un spec no vacío y la
  aprobación canónica de una Person autenticada con plazo durable. Devuelve `false` si ya hay claim: nunca se repite.
* **Asentar (`settled`):** solo con evidencia canónica de un Attempt final (`store/dispatch_evidence.rs`): exactamente un
  `attempt.started` seguido de exactamente un evento terminal, ambos como los emitiría el Core. Un fallo posterior al
  arranque con resultado desconocido no es un terminal conocido: el claim queda `ambiguous` y lo resuelve una persona.
* **Termina sin `attempt.started`:** como `attempt.started` se registra *antes* de llamar al proveedor, un claim sin él
  prueba que el proveedor nunca se llamó. Si el Attempt termina entonces con un `attempt.failed` por `launch_failed`
  (actor System) o un `attempt.stopped` con `from = starting`, el claim se asienta directamente desde `reserved` (o
  `ambiguous`). Antes quedaba `ambiguous` para siempre.
* **Reconciliar al arrancar:** los claims `reserved`/`started` sin evidencia terminal pasan a `ambiguous` y se registra
  `attempt.dispatch_ambiguous`; los que sí la tienen se asientan sin ese hecho falso.

Esta fase es **inerte**: no hay dispatcher que llame a estas primitivas del almacén (llegará en 2c).

### Despachador del primer Attempt (fase 2c-1a, inerte)

`orch/dispatch.rs` lleva un Attempt aprobado (`starting`) a «lanzado» respetando el claim de despacho. Reconstruye todo de
filas persistidas, nunca de lo que diga quien llama, y deja el lanzamiento real detrás de un `Launcher` inyectable:

1. Lee las filas durables y resuelve la **ubicación verificada del Project** en esta máquina (`Core::project_launch_location`:
   la de esta máquina, no `missing`, que exista como carpeta). `Task.repo` no se usa: lo dice quien crea la Task.
2. Reserva el claim (revalida aprobación canónica, Run abierto, Project activo).
3. `Launcher::prepare` (worktree, capability, entorno): sin ningún efecto del proveedor. Si falla, el Attempt se cierra
   **desde `starting`** (`failed(launch_failed)` si falló algo esperado; `stopped` si no había nada que lanzar) y el claim se
   asienta sin `attempt.started`.
4. `attempt.started` por `Core::mutate`, **antes** de llamar al proveedor; después el claim pasa a `started`.
5. `PreparedLaunch::start`: `Running` (queda `running`), `NotSpawned` (`failed(launch_failed)` y claim asentado) o `Unknown`
   (el claim se queda `started` y el Attempt `running`: ni se da por fallido ni se relanza).

Un Attempt con claim nunca se despacha otra vez, tampoco tras un reintento del cliente o una nueva pasada
(`Core::dispatch_approved`).

**Fuera de esta fase** (hecho después): el `Launcher` real ([§ Launcher real](#launcher-real-lxo-246-pr-b)), la conversión de los
eventos del proveedor ([§ Bombeo de eventos](#bombeo-de-eventos-lxo-246-pr-c)) y `attempt.dispatch_ambiguous` con la reconciliación
de los claims en vuelo al arrancar ([§ Encender el lanzador](#encender-el-lanzador-lxo-246-pr-d)).

### RPC de la aprobación inicial (fase 2c-2)

`attempt_approve` y `attempt_reject` · `{ attempt_id }` (nada más: `deny_unknown_fields`, el cliente nunca aporta el plazo). Se
clasifican como `HumanDecision`: **solo una Person en Desktop**; ni la Person del CLI ni un agente. El módulo es
`orch/initial_approval_rpc.rs`; la decisión pasa por `Core::mutate` (`Tx::approve_attempt` / `Tx::reject_attempt`) y el commit
del runtime revalida el plazo durable y la evidencia canónica bajo la transacción.

| caso | respuesta |
|---|---|
| decisión en plazo sobre un Attempt pendiente | `{ "status": "Approved" \| "Rejected", "decision": null, "attempt_id" }` |
| la misma decisión ya estaba tomada | `{ "status": "Replayed", "decision": "approved" \| "rejected", … }`, sin escribir ni subir la revisión |
| el plazo ya venció | `{ "status": "Expired", … }`: el Attempt queda detenido (`attempt.rejected`, causa `approval_timeout`, actor System); una aprobación tardía **nunca** aprueba |
| la decisión contraria ya estaba tomada, no está pendiente, no existe o el id es inválido | error, sin cambios |

**Aprobar no lanza nada:** deja el Attempt en `starting`, y es el despachador (`dispatch.rs`) el que lo toma de la cola de
aprobados. Mientras `task_create` rechace `attempt` (fase 2c-3) no puede existir un Attempt pendiente creado por el RPC, así que
estos comandos son inertes en la práctica.

### Primer Attempt con `task_create` (fase 2c-3)

`attempt` · `{ provider, model?, effort?, role?, profile }`. El cliente aporta solo la **selección** de ejecución; la política es
del servidor y no se acepta como input (`deny_unknown_fields`: `external`, `requires_approval`, host, worktree, `approved`,
plazos… son un error).

* **Perfil:** obligatorio, uno de `explorar`, `proponer`, `delegar_con_revision` (se guarda con su id canónico; Autonomía amplia
  está aplazada y se rechaza). `provider`: un id de adapter (minúsculas, dígitos y `-`); `model`, `effort` y `role` son texto
  corto sin controles.
* **Aprobación:** el Attempt nace **siempre `pending_approval`**: ninguna selección es evidencia para saltarse la decisión
  humana del primer Attempt (plazo durable de 30 min). `external` lo fija el servidor (`false`: el proveedor lo gestiona un
  adapter del Core, que es lo que comprueba el preflight).
* **Preflight, antes de escribir nada:** el proveedor tiene que estar en el registro vivo del Core y su capability `start`
  disponible. Motivos: `provider_probing` (aún se sondea: reintentar), `provider_unknown`, `provider_start_unsupported`,
  `provider_start_unavailable`, `provider_environment_blocked`. Como la comprobación del Project, depende del estado actual:
  un replay ya se atendió antes y no la repite.
* **`repo` de la Task:** con `attempt`, la Task guarda la **ubicación verificada del Project** en esta máquina
  (`Core::project_launch_location`), no el `repo` que mande el cliente: el Worktree del Attempt se registra con el `repo` de la
  Task (no puede estar vacío) y la Task no lo cambia después. Sin `attempt`, `repo` sigue siendo lo que mandó el cliente. Si el
  Project no tiene en esta máquina una ubicación que exista como carpeta, la solicitud se rechaza antes de escribir.
* **Respuesta:** `{ status: Committed | Replayed, run_id, task_id, attempt_id }`, con `attempt_id = <task>-a1`; el ledger
  guarda el Attempt y un replay lo devuelve.
* **Lanzador:** el Core tiene una ranura de lanzador (`Core::install_launcher`). Sin uno instalado, `task_create` rechaza
  `attempt`: nada podría ejecutarlo y un Attempt aprobado se quedaría `starting` para siempre. Producción lo instala solo con el
  Orquestador activado. Con uno, aprobar (`attempt_approve`) despierta al despachador en segundo plano, y el barrido periódico despacha
  los aprobados que quedaron esperando (p. ej. tras un reinicio). El claim garantiza un único lanzamiento aunque ambos
  coincidan.

### Worktree del Attempt (LXO-246, PR A)

`orch/worktree_provision.rs` crea, registra y deshace el worktree de un Attempt **sin tocar a ningún proveedor**; lo usará el
`Launcher` real en `prepare`, antes de `attempt.started`. Estrategia **`new`**: cada Attempt tiene su carpeta y su rama (compartir
la del Project, `shared`, queda para otra fase).

* **Nombres deterministas:** rama `lx/<run>/<attempt>` y carpeta `<repo>.lixbon-wt/<attempt>`, al lado del repositorio. Un id con
  separadores, `..`, controles o sufijo `.lock` se rechaza antes de llamar a git.
* **Creación:** `git worktree add -b` desde la rama actual del repositorio (o `HEAD` si está desacoplado). Sin repositorio git o sin
  ningún commit no hay nada que lanzar (`Unavailable`); cualquier fallo de git es `Failed`.
* **Registro:** una mutación con efecto (`effect.observed`, `git_worktree`, operación `spawn`) fija `Task.worktree`, `cwd`, `branch`,
  `base` y `base_commit`; el commit del runtime lo materializa en la tabla `worktrees`, vinculado al Attempt. Si el registro falla,
  se deshace lo que esa llamada acaba de crear y solo eso.
* **Solo se borra lo creado:** una carpeta o una rama que ya existían hacen fallar la creación y quedan intactas (los restos de una
  caída los limpia la reconciliación de arranque, no esta llamada).
* **Liberar:** `git worktree remove --force`, `git branch -d` (**nunca** `-D`: una rama con trabajo sin integrar se conserva y el
  Worktree quitado sigue conservándola) y el registro (`git_worktree_removed`, operación `spawn_cleanup`), que devuelve el `cwd` de
  la Task al que tenía. Con el Core en solo lectura no se crea ni se borra nada: no se podría registrar.
* **Sin plan de entorno:** no se aplica `worktree_env` (enlaces de `node_modules`, copias de `.env`): ese plan es lo que una persona
  aprobó para una hija y el primer Attempt no tiene una aprobación equivalente.

Inerte: nada en producción lo llama todavía.

### Launcher real (LXO-246, PR B)

`orch/adapter_launcher.rs` implementa el `Launcher` del despachador sobre el registro de proveedores y el worktree del PR A.

* **`prepare`** (sin efectos del proveedor): toma el adapter y una **copia** de su matriz del registro vivo (no se retiene el
  registro: una ejecución dura minutos), vuelve a comprobar que `start` y `events` están disponibles **ahora** (pudieron cambiar
  desde `task_create`) y crea el worktree. Si algo falla, el Attempt se cierra desde `starting` sin `attempt.started`.
* **`start`** (tras `attempt.started`): `Gated::start`. `Ok(handle)` es `Running` y la ejecución queda en `take_started` para el
  bombeo de eventos (PR C). `Err(e)` prueba que **no se lanzó**: el contrato del adapter es que un `Err` es «la operación no se
  pudo atender» y los dos adapters reales matan o cierran el proceso antes de devolverlo; se libera el worktree y se clasifica.
  Un **pánico** del adapter es `Unknown`: pudo haber arrancado, así que no se libera nada y el claim queda `started`.
* **`abandon`:** no se llegó a llamar al proveedor; se libera el worktree.

| Código del adapter | Desenlace |
|---|---|
| `environment_blocked`, `unsupported_capability`, `capability_unavailable`, `unknown_capability`, `cancelled` | **Nada que lanzar**: `attempt.stopped`, nunca `failed` (un entorno bloqueado no es un fallo del agente) |
| `invalid_request`, `unknown_provider`, `unknown_run`, `session_not_found`, `provider`, `internal` | **No se pudo lanzar**: `attempt.failed(launch_failed)` |

La clasificación es un `match` sin comodín: un código nuevo obliga a decidir. Del error solo viajan el código y el mensaje ya
redactado; nunca el diagnóstico crudo del proveedor.

Se instala en producción solo con el Orquestador activado (PR D).

### Bombeo de eventos (LXO-246, PR C)

`orch/run_pump.rs` convierte lo que el proveedor emite en el ciclo de vida durable del Attempt y deja que el Core cancele la
ejecución. Al aceptar el proveedor la ejecución (`StartOutcome::Running`) el despachador llama a `Launcher::started` y el
lanzador real arranca un hilo que bloquea en `Gated::events`, con un sink que llama a `Core::mutate`.

| Evento del proveedor | Efecto |
|---|---|
| `SessionBound` | `Task.session_ref` y `session_match = session_id` (una vez): el runtime crea la `provider_session` |
| `Model` | `model_effective` y `model_source = session_declared` |
| `Permission`, `Question` | el Attempt pasa a `awaiting_terminal_approval` con un plazo (Attention `approval`); **no se responde** |
| `Output`, `ToolUse`, `Retry`, `Transport`, `Usage` | ninguno: no son hechos durables del Attempt |

* **Peticiones sin respuesta.** Todavía no hay RPC para responder a un permiso o una pregunta del proveedor, así que el Attempt
  espera con Attention y, vencido el plazo (`LIXBON_TERMINAL_APPROVAL_TTL_SECS`, 300 s por defecto), un vigilante cancela la
  ejecución y el Attempt acaba `failed(terminal_approval_timeout)`. Sin él el proveedor esperaría para siempre. Detenerla antes
  la deja `stopped`, no `failed`.
* **Desenlace** (función pura, sin comodín): `Completed` → `completed` (resumen redactado y acotado); `Failed` o `Err` →
  `failed(agent_reported)`; `Interrupted` → `exited`; `Cancelled` → `stopped`; plazo vencido → `failed(terminal_approval_timeout)`.
  Después se asienta el claim de despacho (`started → settled`). El worktree se conserva: es el trabajo que se revisa.
* **Cancelación.** Cada ejecución viva consta en un registro del Core por Task. `kill_term_checked` (el camino de `stop`, del
  cierre de un Run y de `release`), `has_term`, `live_ids` y el apagado (`kill_all_terms`) la consultan: cancelan su
  `CancelToken` y **esperan (hasta 10 s) a que el proceso muera** antes de devolver, de modo que nadie borra un worktree bajo un
  proceso vivo. Si no muere a tiempo es un `Err` («no hay control fiable») y se conserva todo.
* **Un pánico del bombeo** no inventa un desenlace: la ejecución sale del registro y el Attempt queda `running` para la
  reconciliación de arranque.

Se activa con el Orquestador (PR D).

### Encender el lanzador (LXO-246, PR D)

El lanzador real (`AdapterLauncher`, sobre los adapters de Claude y Codex del registro de proveedores) se instala **solo con el
Orquestador activado** (Ajustes → Orquestador, `Settings.enabled`). `Core::sync_launcher` alinea la ranura con el ajuste: se
llama al arrancar (tras leer los ajustes) y cada vez que cambian (`orch_settings_set`). Activado, `task_create` acepta `attempt`,
`attempt_approve` despierta al despachador y el barrido periódico despacha los aprobados que esperan. Desactivado, `attempt` se
rechaza y no se lanza nada nuevo; **desactivarlo no interrumpe las ejecuciones vivas** (se detienen con `stop` o al apagar).

* **`attempt.dispatch_ambiguous`** (`task`, `n`, `from` ∈ `reserved` · `started`, `cause` ∈ `core_restart` · `start_outcome_unknown`):
  no se puede probar si el proveedor llegó a lanzarse. El claim pasa a `ambiguous` y **nunca se vuelve a despachar solo**. En la
  Activity consta como un aviso (`activity.attempt.dispatch_ambiguous`). No levanta Attention: al arrancar, el Attempt ya se cerró
  como huérfano y una Attention nacería después del evento final que la habría cerrado.
* **Desenlace desconocido al lanzar** (el adapter entró en pánico): el claim pasa a `ambiguous` en el momento, con su hecho. El
  Attempt sigue `running` y el worktree no se toca; lo cierra la reconciliación del siguiente arranque.
* **Conciliación al arrancar** (`Core::reconcile_dispatch_claims_at_boot`, DESPUÉS de cerrar las tareas huérfanas): todo claim
  `reserved` o `started` que quedó en vuelo se asienta si su Attempt acabó con evidencia terminal canónica (`started` y un
  terminal del Core), sin una ambigüedad falsa; si no, pasa a `ambiguous` (`cause = core_restart`). Se hace en UNA transacción y
  repetirla no cambia nada.
* **Límite conocido:** un proveedor que siga vivo tras reiniciar Lixbon (su proceso no murió con la aplicación) no se vuelve a
  adoptar: el Attempt queda cerrado como huérfano y el proceso sin dueño es asunto de la custodia de procesos (LXO-242).

### `not_started`

Una Task abierta sin ninguna fila de Attempt se representa como `not_started`. Significa únicamente «intención existente
sin ejecución solicitada»: no es `starting`, no es final (`is_final() == false`) y no cuenta como actividad. Concretamente:

* no es una tarea huérfana: el arranque no la cierra ni escribe una revisión por ella;
* no bloquea ni cuenta en `run_open_tasks`, y el barrido de Runs inactivos **no** cierra un Run que espera su primer
  Attempt;
* no puede repartir tareas, cerrarse como si ejecutara, fallar con motivo máquina ni esperar una aprobación de terminal;
* la vista legacy reconstruida desde las tablas la devuelve sin fila en `attempts` (agente vacío, `cwd` = repo, sin rama ni
  worktree) y no se fabrica un Attempt al reconstruir ni al reiniciar.

Es un concepto distinto de `StartDisposition::NotStarted`, el resultado tipado de un adapter que prueba que un despacho
concreto falló antes del spawn.

### Prueba

`orch/task_create_rpc_tests.rs` (RPC sobre un Core con el corte aplicado: commit, replay, replay tras reiniciar, conflicto,
mutación posterior con la Task presente, reinicio sin revisiones nuevas, barrido de inactividad y rechazo de Attempt),
`orch/mutation_tests.rs` (reintentos del commit idempotente), `store/runtime_idempotency_tests.rs` (ledger y referencias) y
`orch/state.rs` (semántica de `not_started`).

## Fuera de este slice

Migrar datos del legado (lo hace el corte), Attempt y su runtime, conectar los mutadores al RPC o a `lxo`, UI,
reglas de Attention propias de la intención (`task.discarded` no resuelve nada todavía; `task.removed` ya resuelve lo
de su Task, como en el legacy) y mutadores de Run (cerrar, borrar).
