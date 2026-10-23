//! Corte de datos Task/Attempt (LXO-117): lado del **almacén**. Contrato: `docs/core/CORTE_EJECUCION.md`; mapeo: ADR
//! `docs/core/CORTE_TASK_ATTEMPT.md`.
//!
//! Aplica `cut/task_attempt_cut.sql` como la versión siguiente a la última migración publicada, en UNA transacción
//! con la comprobación semántica y el evento `core.agentic_cut` que le pasa `orch::agentic_cut`. Si cualquiera falla,
//! ROLLBACK: la base queda exactamente en la versión anterior.
//!
//! **No está activado**: el arranque no lo llama (la SQL no vive en `migrations/`). Activarlo es tarea del slice que
//! pase el runtime a las tablas; ver la sección «Activación» del contrato.

#![cfg_attr(not(test), allow(dead_code))] // sin activar: solo lo usan `orch::agentic_cut` y las pruebas

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::error::{StoreError, StoreResult};
use super::events::NewEvent;
use super::migrate::{db_version, embedded, now_ms, Migration};
use super::tasks::{insert_all, AGENTIC_MODEL_KEY};
use super::Store;

/// Nombre del corte en `schema_migrations`.
pub const CUT_NAME: &str = "task_attempt_cut";
/// El SQL del corte. Fuera de `migrations/`: el arranque no lo aplica.
pub const CUT_SQL: &str = include_str!("cut/task_attempt_cut.sql");
/// Clave de idempotencia del evento `core.agentic_cut`.
pub const CUT_IDEM_KEY: &str = "task_attempt_v1";

/// El corte como migración: la versión siguiente a la última publicada. Con ella en la lista, un binario abre una base
/// ya cortada; sin ella (cualquier binario anterior), la base cortada es `DatabaseNewer` y no se toca.
pub fn cut_migration() -> Migration {
    let last = embedded().last().map(|m| m.version).unwrap_or(0);
    Migration::new(last + 1, CUT_NAME, CUT_SQL)
}

/// Las migraciones publicadas más el corte.
pub fn migrations_with_cut() -> Vec<Migration> {
    let mut all = embedded();
    all.push(cut_migration());
    all
}

/// Filas por entidad tras el corte (el informe «después» y el payload de `core.agentic_cut`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CutCounts {
    pub runs: i64,
    pub tasks: i64,
    pub attempts: i64,
    pub attempt_phases: i64,
    pub worktrees: i64,
    pub provider_sessions: i64,
    pub threads: i64,
    pub thread_messages: i64,
    pub artifacts: i64,
    pub decisions: i64,
    pub reviews: i64,
    pub env_blocks: i64,
    pub legacy_residue: i64,
}

fn count(c: &Connection, table: &str) -> StoreResult<i64> {
    Ok(c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?)
}

fn counts_in(c: &Connection) -> StoreResult<CutCounts> {
    Ok(CutCounts {
        runs: count(c, "runs")?,
        tasks: count(c, "tasks")?,
        attempts: count(c, "attempts")?,
        attempt_phases: count(c, "attempt_phases")?,
        worktrees: count(c, "worktrees")?,
        provider_sessions: count(c, "provider_sessions")?,
        threads: count(c, "threads")?,
        thread_messages: count(c, "thread_messages")?,
        artifacts: count(c, "artifacts")?,
        decisions: count(c, "decisions")?,
        reviews: count(c, "reviews")?,
        env_blocks: count(c, "env_blocks")?,
        legacy_residue: count(c, "legacy_residue")?,
    })
}

/// ¿Ya se cortó esta base? Mira las dos huellas del corte: la migración registrada y `meta.agentic_model`.
pub(super) fn is_cut(c: &Connection) -> StoreResult<bool> {
    let applied: Option<i64> = c.query_row("SELECT version FROM schema_migrations WHERE name = ?1", [CUT_NAME], |r| r.get(0)).optional()?;
    let model: Option<String> = c.query_row("SELECT value FROM meta WHERE key = ?1", [AGENTIC_MODEL_KEY], |r| r.get(0)).optional()?;
    Ok(applied.is_some() || model.is_some())
}

/// La vista `legacy_task_v1` leída de las tablas, para la comprobación semántica del corte (ADR §9, paso 5b): cada
/// Task con su Attempt actual (`max(n)`), su Worktree, su sesión y sus Artifacts, en la forma del documento legacy.
/// `orch::agentic_cut` la compara con el `State` original.
pub struct CutView<'a>(&'a Connection);

fn json_col(v: Option<String>) -> Value {
    v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null)
}

fn view_err(m: String) -> StoreError {
    StoreError::MigrationFailed { version: 0, name: CUT_NAME.into(), detail: format!("vista legacy: {m}") }
}

impl CutView<'_> {
    /// Una Task en la forma del documento legacy (JSON).
    pub fn legacy_task(&self, id: &str) -> StoreResult<Value> {
        let c = self.0;
        let mut o: Map<String, Value> = c.query_row(
            "SELECT id, run_id, parent_task_id, depth, title, spec, repo, project_id, created_at, updated_at FROM tasks WHERE id = ?1",
            [id],
            |r| {
                let mut o = Map::new();
                o.insert("id".into(), json!(r.get::<_, String>(0)?));
                o.insert("run".into(), json!(r.get::<_, String>(1)?));
                o.insert("parent".into(), json!(r.get::<_, Option<String>>(2)?));
                o.insert("depth".into(), json!(r.get::<_, i64>(3)?));
                o.insert("title".into(), json!(r.get::<_, String>(4)?));
                o.insert("spec".into(), json!(r.get::<_, String>(5)?));
                o.insert("repo".into(), json!(r.get::<_, String>(6)?));
                o.insert("project_id".into(), json!(r.get::<_, Option<String>>(7)?));
                o.insert("created".into(), json!(r.get::<_, i64>(8)?));
                o.insert("updated".into(), json!(r.get::<_, i64>(9)?));
                Ok(o)
            },
        )?;
        let (aid, worktree_id, session_id) = c.query_row(
            "SELECT id, worktree_id, provider_session_id, provider, model, effort, role, profile, cwd, checkout_branch, status, summary, files, external,
                    integrated, ack_unverified, requested_argv, policy, report_nonce, delivered, delivery_channel, model_effective, model_requested,
                    model_mismatch, model_mismatch_reason, plan_mode, approval_deadline, failure_reason, model_source, started_at, stream_json
             FROM attempts WHERE task_id = ?1 ORDER BY n DESC LIMIT 1",
            [id],
            |r| {
                for (k, col) in [("agent", 3), ("model", 4), ("effort", 5), ("role", 6), ("profile", 7), ("cwd", 8), ("branch", 9), ("status", 10), ("summary", 11)] {
                    o.insert(k.into(), json!(r.get::<_, Option<String>>(col)?));
                }
                for (k, col) in [("external", 13), ("merged", 14), ("ack_unverified", 15), ("model_mismatch", 23), ("plan_mode", 25), ("stream_json", 30)] {
                    o.insert(k.into(), json!(r.get::<_, i64>(col)? == 1));
                }
                for (k, col) in [("files", 12), ("requested_argv", 16), ("policy", 17), ("delivered", 19)] {
                    o.insert(k.into(), json_col(r.get(col)?));
                }
                for (k, col) in [("report_nonce", 18), ("delivery_channel", 20), ("model_effective", 21), ("model_requested", 22), ("model_mismatch_reason", 24), ("failure_reason", 27), ("model_source", 28)] {
                    o.insert(k.into(), json!(r.get::<_, Option<String>>(col)?));
                }
                o.insert("approval_deadline".into(), json!(r.get::<_, Option<i64>>(26)?));
                o.insert("attempt_started".into(), json!(r.get::<_, Option<i64>>(29)?));
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?))
            },
        )?;
        if let Some(w) = worktree_id {
            c.query_row("SELECT path, branch, base_branch, base_commit, env_plan FROM worktrees WHERE id = ?1", [&w], |r| {
                o.insert("worktree".into(), json!(r.get::<_, Option<String>>(0)?));
                o.insert("branch".into(), json!(r.get::<_, Option<String>>(1)?));
                o.insert("base".into(), json!(r.get::<_, Option<String>>(2)?));
                o.insert("base_commit".into(), json!(r.get::<_, Option<String>>(3)?));
                o.insert("env".into(), json_col(r.get(4)?));
                Ok(())
            })?;
        }
        if let Some(ps) = session_id {
            c.query_row("SELECT external_ref, binding FROM provider_sessions WHERE id = ?1", [&ps], |r| {
                o.insert("session_ref".into(), json!(r.get::<_, Option<String>>(0)?));
                o.insert("session_match".into(), json!(r.get::<_, Option<String>>(1)?.filter(|b| b == "session_id")));
                Ok(())
            })?;
        }
        let mut arts = c.prepare("SELECT kind, uri FROM artifacts WHERE attempt_id = ?1")?;
        for row in arts.query_map([&aid], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (kind, uri) = row?;
            let key = match kind.as_str() {
                "report" => "report",
                "pull_request" => "pr_url",
                "last_message" => "last_message_path",
                otro => return Err(view_err(format!("{id}: Artifact de tipo {otro} en el legado"))),
            };
            o.insert(key.into(), json!(uri));
        }
        let mut ph = c.prepare("SELECT name, done, note, at FROM attempt_phases WHERE attempt_id = ?1 ORDER BY ord")?;
        let phases = ph
            .query_map([&aid], |r| Ok(json!({ "name": r.get::<_, String>(0)?, "done": r.get::<_, i64>(1)? == 1, "note": r.get::<_, String>(2)?, "at": r.get::<_, i64>(3)? })))?
            .collect::<Result<Vec<_>, _>>()?;
        o.insert("phases".into(), json!(phases));
        Ok(Value::Object(o))
    }

    /// Los mensajes en la forma del documento legacy, por id.
    pub fn legacy_messages(&self) -> StoreResult<Vec<Value>> {
        let mut q = self.0.prepare(
            "SELECT m.id, th.run_id, m.from_task_id, m.to_task_id, m.kind, m.body, m.reply_to, m.read, m.at
             FROM thread_messages AS m JOIN threads AS th ON th.id = m.thread_id ORDER BY m.id",
        )?;
        let rows = q.query_map([], |r| {
            Ok(json!({ "id": r.get::<_, i64>(0)?, "run": r.get::<_, String>(1)?, "from": r.get::<_, String>(2)?, "to": r.get::<_, String>(3)?, "kind": r.get::<_, String>(4)?,
                       "body": r.get::<_, String>(5)?, "reply_to": r.get::<_, Option<i64>>(6)?, "read": r.get::<_, i64>(7)? == 1, "at": r.get::<_, i64>(8)? }))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Los Runs en la forma del documento legacy, por id.
    pub fn legacy_runs(&self) -> StoreResult<Vec<Value>> {
        let mut q = self.0.prepare("SELECT id, objective, root_task_id, created_at, closed, last_activity FROM runs ORDER BY id")?;
        let rows = q.query_map([], |r| {
            Ok(json!({ "id": r.get::<_, String>(0)?, "objective": r.get::<_, String>(1)?, "root": r.get::<_, String>(2)?, "created": r.get::<_, i64>(3)?,
                       "closed": r.get::<_, i64>(4)? == 1, "last_activity": r.get::<_, i64>(5)? }))
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Los mensajes legacy que fueron a residuo (participante inexistente): la vista no los tiene.
    pub fn dangling_messages(&self) -> StoreResult<BTreeSet<u64>> {
        let ids = self.0.prepare("SELECT legacy_id FROM legacy_residue WHERE entity_kind = 'message'")?.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(ids.into_iter().filter_map(|s| s.parse().ok()).collect())
    }

    /// La primera tabla con una referencia rota, si la hay (`PRAGMA foreign_key_check`).
    pub fn foreign_key_violation(&self) -> StoreResult<Option<String>> {
        Ok(self.0.query_row("SELECT \"table\" FROM pragma_foreign_key_check LIMIT 1", [], |r| r.get(0)).optional()?)
    }
}

/// Lo que dice una copia de sí misma, leído en solo lectura: `user_version`, `legacy_state` (rev y documento) e
/// `integrity_check`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CopyFacts {
    pub user_version: i64,
    pub legacy: Option<(i64, String)>,
    pub integrity: String,
}

pub fn inspect_copy(db: &Path) -> StoreResult<CopyFacts> {
    let c = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let integrity: String = c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    let user_version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let legacy = c.query_row("SELECT rev, doc FROM legacy_state WHERE id = 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
    Ok(CopyFacts { user_version, legacy, integrity })
}

/// Resultado de [`Store::agentic_cut_recorded`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CutOutcome {
    /// Se aplicó: filas por entidad.
    Applied(CutCounts),
    /// La base ya estaba cortada: no se hizo nada (idempotencia).
    AlreadyCut,
}

impl Store {
    /// La vista legacy de una base ya cortada (para comprobarla fuera del corte).
    pub fn cut_view<T>(&self, f: impl FnOnce(&CutView<'_>) -> StoreResult<T>) -> StoreResult<T> {
        self.read(|c| f(&CutView(c)))
    }

    /// ¿Ya se cortó esta base?
    pub fn agentic_cut_done(&self) -> StoreResult<bool> {
        self.read(is_cut)
    }

    /// Aplica el corte en UNA transacción `BEGIN IMMEDIATE`: el SQL (activar, DDL pendiente, copia, residuo, asserts,
    /// congelar), su fila en `schema_migrations`, `user_version`, la comprobación semántica de quien llama (`verify`,
    /// que lee las tablas ya llenas) y su evento. Cualquier error deshace todo.
    ///
    /// Exige que la base esté exactamente en la última migración publicada. Una base ya cortada es `AlreadyCut`.
    pub fn agentic_cut_recorded(&mut self, cut: &Migration, app_version: &str, verify: impl FnOnce(&CutView<'_>, &CutCounts) -> StoreResult<NewEvent>) -> StoreResult<CutOutcome> {
        let projector = self.projector.clone();
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if is_cut(&tx)? {
            return Ok(CutOutcome::AlreadyCut);
        }
        let version = db_version(&tx)?;
        if version != cut.version - 1 {
            return Err(StoreError::CutPreflight(format!("la base está en la versión {version}; el corte se aplica sobre la {}", cut.version - 1)));
        }
        let fail = |detail: String| StoreError::MigrationFailed { version: cut.version, name: cut.name.to_string(), detail };
        tx.execute_batch(cut.sql).map_err(|e| fail(e.to_string()))?;
        if tx.is_autocommit() {
            return Err(fail("el SQL cerró la transacción".into()));
        }
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum, app_version, applied_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![cut.version, cut.name, cut.checksum(), app_version, now_ms()],
        )
        .map_err(|e| fail(e.to_string()))?;
        tx.pragma_update(None, "user_version", cut.version)?;
        let counts = counts_in(&tx)?;
        let e = verify(&CutView(&tx), &counts)?;
        if e.kind != "core.agentic_cut" || e.idem_key.as_deref() != Some(CUT_IDEM_KEY) {
            return Err(StoreError::InvalidEvent(format!("{}: el corte se registra con core.agentic_cut ({CUT_IDEM_KEY})", e.kind)));
        }
        e.check()?;
        insert_all(&tx, std::slice::from_ref(&e), projector.as_deref())?;
        tx.commit()?;
        Ok(CutOutcome::Applied(counts))
    }
}
