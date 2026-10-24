# Ejecución del corte Task/Attempt (LXO-117)

Estado: **activado en dogfood (LXO-234)**. El arranque corta la base solo con el interruptor `LIXBON_AGENTIC_CUT=1`,
que está desactivado por defecto. Ya cortada, el runtime persiste y carga desde las tablas
([RUNTIME_TABLAS.md](RUNTIME_TABLAS.md)); sin cortar, sigue en `legacy_state`. Activarlo para todos espera a una release
en dogfood sin rollback (ver [Activación](#activación)).

Mapeo, decisiones e invariantes: la [ADR de LXO-112](CORTE_TASK_ATTEMPT.md). Este documento fija cómo se ejecuta.

Piezas:

* SQL: [`migrations/014_task_attempt_cut.sql`](../../apps/desktop/src-tauri/src/store/migrations/014_task_attempt_cut.sql),
  publicada y con el checksum congelado. El migrador general **no la aplica nunca**: `migrate::plan` se detiene antes de
  ella (y de lo que venga después) mientras la base no esté cortada.
* Almacén: `store/cut.rs`.
  * `cut_migration()`: la migración embebida del corte.
  * `Store::agentic_cut_recorded`: la transacción.
  * `CutView`: la vista legacy leída de las tablas.
  * `inspect_copy`: lo que dice una copia de sí misma.
* Orquestación: `orch/agentic_cut.rs`.
  * `run`: los pasos 3–5b. Lo llama el arranque (`boot_authority::cut_if_switched`).
  * `check_copy`, `request_restore`, `restore_pending` y `restore`: el rollback.
* Pruebas:
  * `orch/agentic_cut_tests.rs` y `orch/activation_tests.rs`;
  * [`verificar.py`](fixtures/corte-task-attempt/verificar.py), que aplica la misma SQL.

## Pasos (ADR §9)

| Paso | Qué hace `agentic_cut::run` | Si falla |
|---|---|---|
| — | ¿Ya cortada? (`schema_migrations` tiene `task_attempt_cut` o existe `meta.agentic_model`) → `AlreadyCut`, sin tocar nada | — |
| 3 | **Comprobación previa**, solo lectura. La base debe estar exactamente en la última migración publicada. `legacy_state` debe tener `doc_schema = 0` y leerse como `State`. Sin fila (instalación nueva), el documento es un `State` vacío | `CutPreflight`, sin copia y sin cambios |
| 4 | **Copia `pre-f3-cut`** (`VACUUM INTO` + `integrity_check`). En la misma carpeta y con el mismo prefijo, guarda también `state.json` y `authority.json` y el **sidecar** `…-pre-f3-cut.db.json`. Antes comprueba que la copia tiene el mismo `legacy_state` (rev y SHA-256) | `Backup`, sin corte (D13) |
| 5 | **Una transacción** `BEGIN IMMEDIATE`: <br>• la SQL (activar, DDL pendiente, copia, residuo, asserts de conteo, congelar `legacy_state`); <br>• su fila en `schema_migrations`; <br>• `user_version` | ROLLBACK: la base queda en la versión anterior, con el mismo esquema y el mismo `legacy_state` |
| 5b | **Dentro de la misma transacción**: <br>• la vista legacy reconstruida desde las tablas es el documento, salvo D3: cada Task, mensaje y Run se lee de vuelta como `Task`/`Message`/`Run` y se compara campo a campo; <br>• `foreign_key_check` vacío; <br>• el evento `core.agentic_cut` (`idem_key = task_attempt_v1`), con los conteos y el nombre de la copia | ROLLBACK, igual que 5 |
| 6 | Pasar a `exited` los Attempts no externos y no finales (lo que hoy hace `orphan_all`) | **No está aquí**: lo hace el runtime en cada arranque sobre las tablas (`close_orphans`, LXO-232) |

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

**Worktrees legacy sin carpeta.** Si `git branch -d` borró la rama al liberar la tarea, el documento conserva `base` sin
`worktree` ni `branch`. Esa Task también tiene fila: el Worktree `removed` con `branch_kept = 0` y la base (LXO-232; antes
la validación semántica rechazaba el corte por el campo `base`).

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

**Con `lxo core restore` (LXO-234):**

1. `lxo core restore [--copy <ruta>]`, como persona y con Lixbon abierto. Sin `--copy` toma la copia `pre-f3-cut` más
   reciente de `core/backups/`. Comprueba la copia contra su sidecar con `check_copy`: SHA-256, `integrity_check`,
   `user_version` y SHA-256 del documento. Si no cuadra, no pide nada. Si cuadra, deja la petición en
   `core/agentic-cut-restore.json`.
2. Cerrar Lixbon y volver a abrirlo. El arranque, con `core.lock` tomado y la base aún sin abrir, aplica la petición:
   * aparta (no borra) `lixbon.db`, `-wal`, `-shm` y los espejos actuales a `core/rollback-<ms>/`;
   * pone en su sitio la copia, `state.json` y `authority.json` del mismo conjunto;
   * avisa en Desktop.
3. **Versión fijada.** La restauración deja `core/agentic-cut-hold.json`, y con ella el arranque no vuelve a cortar
   aunque `LIXBON_AGENTIC_CUT` siga puesto. Este binario funciona sobre la base restaurada (la 013, legacy). Si además
   se instala un binario anterior a LXO-232, hay que desactivar sus actualizaciones. Borrar la espera es volver a
   intentar el corte.
4. `lxo core restore --cancel` retira una petición que aún no se ha aplicado. Si la restauración falla al arrancar, el
   arranque se bloquea y el mensaje dice qué archivo borrar para arrancar sin restaurar.

Sin Lixbon abierto, `agentic_cut::restore(core, data, copia)` hace lo mismo y exige el bloqueo de instancia libre.

Se pierde todo lo posterior al corte (ADR §12). Probado en:

* `la_restauracion_vuelve_a_la_base_de_antes_del_corte_de_punta_a_punta`;
* `una_restauracion_pedida_se_puede_retirar_y_una_copia_que_no_cuadra_no_se_pide`;
* `restaurar_la_copia_vuelve_a_la_base_anterior_al_corte_…`;
* `una_copia_que_no_cuadra_con_su_sidecar_no_se_restaura`.

## Activación

Activado en **dogfood** (LXO-234).

1. **Hecho (LXO-232).** Con la base cortada, el runtime deja de escribir `legacy_state` y `state.json` (D4) y persiste en
   las tablas. Al arrancar carga la vista `legacy_task_v1` y pasa los huérfanos a `exited` (paso 6).
2. **Hecho.** El corte es `migrations/014_task_attempt_cut.sql`, con el checksum congelado
   (`la_014_del_corte_tiene_el_checksum_congelado`). Es una **barrera**: el migrador general no la aplica, ni nada
   posterior a ella, mientras la base no esté cortada.
3. **Hecho.** En el arranque (`boot_authority::cut_if_switched`), tras las migraciones anteriores al corte y con
   `core.lock` tomado, se llama a `agentic_cut::run`. Solo ocurre con `LIXBON_AGENTIC_CUT=1` y si no hay espera de
   restauración (`core/agentic-cut-hold.json`).
   * Si falla, el arranque se bloquea con su mensaje en Desktop (D13) y la base queda como estaba
     (`un_corte_que_falla_bloquea_el_arranque_…`). Sin el interruptor, arranca como siempre.
   * Después, el paso 6.
4. **Hecho.** `cut_migration()` lee la migración embebida. La prueba que exigía que no estuviera en `migrations/` pasa a
   ser `el_migrador_no_aplica_el_corte_y_solo_el_arranque_con_el_interruptor_lo_ejecuta`.
5. **Hecho (LXO-119).** `core_model` anuncia `task_attempt_v1` y `compat: ["legacy_task_v1"]` una vez cortada.
6. **Copias de bases reales.** `activation_tests::real_copy_corte_uso_reinicio_y_restauracion` se lanza a mano con
   `LIXBON_REAL_COPY=<carpeta con lixbon.db, state.json y authority.json>`. Trabaja sobre una copia temporal y recorre
   el corte, el uso, el reinicio y la restauración. La copia de la base se hace en solo lectura (`VACUUM INTO`).
7. **Pendiente.** Activarlo por defecto requiere al menos una release en dogfood sin rollback.
