# Ejecución del corte Task/Attempt (LXO-117)

Estado: **implementado y probado, sin activar**. El arranque **no** aplica el corte: el runtime legacy todavía guarda
las tareas en `legacy_state`, y el corte lo congela. Activarlo es parte del slice que pase el runtime a las tablas (ver
[Activación](#activación)).

Mapeo, decisiones e invariantes: la [ADR de LXO-112](CORTE_TASK_ATTEMPT.md). Este documento fija cómo se ejecuta.

Piezas:

* SQL: [`store/cut/task_attempt_cut.sql`](../../apps/desktop/src-tauri/src/store/cut/task_attempt_cut.sql). Está fuera de
  `migrations/`, así que `build.rs` no lo mete en la lista de arranque.
* Almacén: `store/cut.rs`.
  * `cut_migration()`: el corte como la versión siguiente a la última publicada.
  * `Store::agentic_cut_recorded`: la transacción.
  * `CutView`: la vista legacy leída de las tablas.
  * `inspect_copy`: lo que dice una copia de sí misma.
* Orquestación: `orch/agentic_cut.rs`.
  * `run`: los pasos 3–5b.
  * `check_copy` y `restore`: el rollback.
* Pruebas: `orch/agentic_cut_tests.rs` y [`verificar.py`](fixtures/corte-task-attempt/verificar.py), que aplica la misma SQL.

## Pasos (ADR §9)

| Paso | Qué hace `agentic_cut::run` | Si falla |
|---|---|---|
| — | ¿Ya cortada? (`schema_migrations` tiene `task_attempt_cut` o existe `meta.agentic_model`) → `AlreadyCut`, sin tocar nada | — |
| 3 | **Comprobación previa**, solo lectura. La base debe estar exactamente en la última migración publicada. `legacy_state` debe tener `doc_schema = 0` y leerse como `State`. Sin fila (instalación nueva), el documento es un `State` vacío | `CutPreflight`, sin copia y sin cambios |
| 4 | **Copia `pre-f3-cut`** (`VACUUM INTO` + `integrity_check`). En la misma carpeta y con el mismo prefijo, guarda también `state.json` y `authority.json` y el **sidecar** `…-pre-f3-cut.db.json`. Antes comprueba que la copia tiene el mismo `legacy_state` (rev y SHA-256) | `Backup`, sin corte (D13) |
| 5 | **Una transacción** `BEGIN IMMEDIATE`: <br>• la SQL (activar, DDL pendiente, copia, residuo, asserts de conteo, congelar `legacy_state`); <br>• su fila en `schema_migrations`; <br>• `user_version` | ROLLBACK: la base queda en la versión anterior, con el mismo esquema y el mismo `legacy_state` |
| 5b | **Dentro de la misma transacción**: <br>• la vista legacy reconstruida desde las tablas es el documento, salvo D3: cada Task, mensaje y Run se lee de vuelta como `Task`/`Message`/`Run` y se compara campo a campo; <br>• `foreign_key_check` vacío; <br>• el evento `core.agentic_cut` (`idem_key = task_attempt_v1`), con los conteos y el nombre de la copia | ROLLBACK, igual que 5 |
| 6 | Pasar a `exited` los Attempts no externos y no finales (lo que hoy hace `orphan_all`) | **No está aquí**: es del runtime al activar |

**Sidecar:** `{v, label, db, db_sha256, user_version, legacy_rev, legacy_doc_sha256, integrity_check, app_version,
counts {runs, tasks, messages, decisions}, state_json, authority_json}`. Permite verificar la copia sin abrir la base
cortada. La copia no entra en ninguna retención automática (D14).

## Garantías (invariantes de LXO-117)

| # | Invariante | Cómo | Prueba |
|---|---|---|---|
| 1 | Antes de tocar datos existe una copia restaurable | el paso 4 va antes del 5; sin copia, error | `la_copia_previa_es_un_conjunto_coherente_con_su_sidecar` |
| 2 | Una Task legacy no se duplica | ids conservados (`PRIMARY KEY`), assert `tasks` = documento, un Attempt `n = 1` por Task | `la_fixture_pequena_…`, `una_fixture_grande_…` |
| 3 | Lo desconocido sigue desconocido | `ended_at` NULL; sin máquina, fechas ni motivo en Worktrees legacy; `cwd_time` → sin sesión y `model_source = unknown` (D3) | `una_fixture_grande_…_sin_inventar` |
| 4 | No se fabrica historia de retry | un Attempt por Task; los «Seguimiento» del `spec` no se parten (D5) | ídem |
| 5 | Un fallo de validación no deja la base a medio corte | todo en una transacción; la validación semántica va dentro | `un_corte_que_falla_a_mitad_…`, `si_la_validacion_semantica_falla_se_deshace_todo` |
| 6 | Los Events históricos no se reescriben | la SQL no toca `events`; solo se añade `core.agentic_cut` | `los_events_historicos_no_se_reescriben` |
| — | Idempotencia | `AlreadyCut` antes de la copia; el evento es idempotente | `cortar_dos_veces_no_hace_nada_la_segunda` |
| — | Un binario anterior al corte no toca la base cortada | el corte es la versión N+1; ese binario solo conoce hasta la N: `DatabaseNewer` | `restaurar_la_copia_…` |
| — | No está activado | la SQL no está en `migrations/`; nada fuera de `agentic_cut` llama a `run`/`restore` | `el_arranque_no_aplica_el_corte_…` |

## Informe before/after (fixture de la ADR)

`legacy_state.before.json` → `normalizado.after.json`:

| Antes (documento) | | Después (tablas) | |
|---|---|---|---|
| runs | 3 | runs | 3 |
| tasks | 6 | tasks · attempts | 6 · 6 |
| messages | 8 | threads · thread_messages | 4 · 7 |
| decisions | 4 | decisions · reviews | 4 · 2 |
| env_blocks | 2 alcances | env_blocks | 3 causas |
| — | | attempt_phases · worktrees · provider_sessions · artifacts | 2 · 3 · 2 · 3 |
| seq | 17 | `meta.id_seq` | 17 |

**Anomalías** (van a `legacy_residue`; no se descartan):

| Entidad | Id | Motivo |
|---|---|---|
| message | 15 | `dangling_participant`: el emisor ya no existe |
| task | t4 | `session_not_verified`: sesión de Codex atada por carpeta y hora |

La única diferencia de la vista legacy con el documento es la de D3 (t4: `session_ref` y `session_match` → `null`,
`model_source` → `unknown`). La fixture grande sintética (1040 Tasks, 40 Runs, los 8 estados, sesiones de los tres
tipos, Worktrees activos y ramas conservadas, mensajes y revisiones) pasa la misma validación.

## Rollback (ADR §12)

Solo si el corte se confirmó y aparece una regresión crítica. Un corte que falla no lo necesita: la transacción se
deshace.

1. Cerrar Lixbon (Desktop y servidor local). `restore` exige el bloqueo de instancia libre.
2. `agentic_cut::check_copy(copia)`: la copia coincide con su sidecar (SHA-256, `integrity_check`, `user_version` y
   SHA-256 del documento). Si no, no se restaura nada.
3. `agentic_cut::restore(core, data, copia)`:
   * aparta (no borra) `lixbon.db`, `-wal`, `-shm` y los espejos actuales a `core/rollback-<ms>/`;
   * pone en su sitio la copia, `state.json` y `authority.json` del mismo conjunto.
4. Instalar un binario anterior al corte y **fijar la versión** (si no, la actualización automática volvería a cortar).
5. Arrancar: el binario F2 valida marcador y base y vuelve a escribir `legacy_state`.

Se pierde todo lo posterior al corte (ADR §12). Probado en `restaurar_la_copia_vuelve_a_la_base_anterior_al_corte_…`
y `una_copia_que_no_cuadra_con_su_sidecar_no_se_restaura`.

## Activación

Pendiente. Lo hará el slice que pase el runtime a las tablas. Hoy ninguna issue lo cubre; está anotado en LXO-117.

1. El runtime deja de escribir `legacy_state` y `state.json` (D4) y persiste en las tablas. Los clientes F2 leen la
   vista `legacy_task_v1` (LXO-119).
2. Mover `store/cut/task_attempt_cut.sql` a `store/migrations/NNN_task_attempt_cut.sql`, con el siguiente número
   libre. Desde ese momento su texto no se edita (checksum). Quitar de ella las columnas o tablas que otro slice haya
   publicado antes (la 012 ya sacó las columnas de runtime del Attempt, `attempt_phases` y `env_blocks`).
3. En el arranque (`store_boot`/`boot_authority`), tras las migraciones anteriores al corte y con `core.lock` tomado,
   llamar a `agentic_cut::run`. Si falla, el arranque se bloquea (D13). Después, el paso 6.
4. Ajustar `cut_migration()` para leer la migración embebida y quitar la prueba que exige que no esté en `migrations/`.
5. Snapshot y `status` anuncian `core_model: "task_attempt_v1"` y `compat: ["legacy_task_v1"]` (ADR §11.1).
