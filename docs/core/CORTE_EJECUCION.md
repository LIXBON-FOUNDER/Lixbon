# Ejecución del corte Task/Attempt (LXO-117)

Estado: **implementado y probado, sin activar**. El arranque **no** aplica el corte. Si la base ya está cortada, el
runtime persiste y carga desde las tablas ([RUNTIME_TABLAS.md](RUNTIME_TABLAS.md), LXO-232); sin cortar, sigue en
`legacy_state`. Activar el corte al arrancar es LXO-234 (ver [Activación](#activación)).

Mapeo, decisiones e invariantes: la [ADR de LXO-112](CORTE_TASK_ATTEMPT.md). Este documento fija cómo se ejecuta.

Piezas:

* SQL: [`store/cut/task_attempt_cut.sql`](../../apps/desktop/src-tauri/src/store/cut/task_attempt_cut.sql). Está fuera de
  `migrations/`, así que `build.rs` no lo mete en la lista de arranque.
* Almacén: `store/cut.rs`.
  * `cut_migration()`: el corte con su versión **reservada** `CUT_VERSION = 900` (LXO-234); se aplica sobre la última migración publicada (`cut_base_version()`).
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

Estado tras LXO-234:

1. **Hecho (LXO-232).** Con la base cortada, el runtime deja de escribir `legacy_state` y `state.json` (D4) y persiste
   en las tablas; al arrancar carga la vista `legacy_task_v1` y pasa los huérfanos a `exited` (paso 6).
2. **Hecho (LXO-234): número fijo.** El corte ya no es «última migración + 1» (con 012/013 publicadas eso chocaba:
   una base cortada como 012 daba `ChecksumMismatch` sin salida). Ahora ocupa la versión reservada **900** en
   `schema_migrations`; `user_version` se queda en la última publicada. Las migraciones publicadas siguen numerándose
   por debajo (014, 015…) y se aplican también sobre una base ya cortada: el orden y la versión de esquema ignoran la
   fila del corte (`store/migrate.rs`). El SQL sigue en `store/cut/` y solo lo aplica el corte, nunca el arranque.
3. **Hecho (LXO-234): función pública.** `Core::ensure_agentic_cut(&self) -> Result<AgenticCutStatus, String>`
   (`orch/agentic_cut.rs`, reexportado `orch::AgenticCutStatus`). Síncrona e idempotente: `Applied { backup }` si
   cortó ahora, `AlreadyCut` si ya lo estaba (no escribe). Errores `código: mensaje`: `core_cut_legacy_numbering`,
   `model_unavailable` (almacén cerrado) y `core_cut_failed` (preflight, copia o validación; se deshace entero).
4. **Pendiente (DESKTOP, LXO-123).** Llamarla en el arranque con el almacén abierto y `core.lock` tomado; si falla, el
   arranque se bloquea (D13); tras `Applied`, recargar el estado desde las tablas (paso 6).
5. Snapshot y `status` anuncian `core_model: "task_attempt_v1"` y `compat: ["legacy_task_v1"]` (ADR §11.1).

### Bases cortadas con la numeración anterior

Ningún arranque publicado llamó al corte (`store/cut.rs` estaba sin activar), así que una base cortada solo puede
venir de pruebas o de una ejecución manual con un binario anterior a LXO-234 (corte en 012 o 014). **Se rechazan, no se
renumeran**: al abrir, `StoreError::CutLegacyNumbering { version }`, texto
`core_cut_legacy_numbering: … Restaura la copia pre-f3-cut …`, antes de abrir ninguna transacción y sin copia previa:
la base no se modifica (solo la cabecera pasa a `journal_mode = WAL` al abrirla). Para seguir: restaurar la copia
`pre-f3-cut` que dejó aquel corte (sección Rollback) y volver a cortar con este binario.
