# Task como intención durable (LXO-113)

Estado: **esquema y mutadores implementados, inertes hasta el corte**. Es el primer paso de código de la épica
`[CORE][F3]` ([ADR](CORTE_TASK_ATTEMPT.md)). La Task guarda **qué se quiere hacer**, en qué Project y dentro de qué
Run; la ejecución (proceso, terminal, worktree, sesión del proveedor, informe) será del Attempt (LXO-114 en adelante).

* Migración: [`007_tasks.sql`](../../apps/desktop/src-tauri/src/store/migrations/007_tasks.sql).
* Almacén: `store/tasks.rs` (filas, restricciones, atomicidad). Pruebas: `store/tasks_tests.rs`.
* Hechos y permisos: `orch/task_ops.rs` (el único que construye sus eventos). Pruebas: `orch/task_ops_tests.rs`.

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

## Fuera de este slice

Migrar datos del legado (lo hace el corte), Attempt y su runtime, conectar los mutadores al RPC o a `lxo`, UI,
reglas de Attention propias de la intención (`task.discarded` no resuelve nada todavía; `task.removed` ya resuelve lo
de su Task, como en el legacy) y mutadores de Run (cerrar, borrar).
