//! El runtime sobre las tablas Task/Attempt (LXO-232): lado del **almacén**. Contrato: `docs/core/RUNTIME_TABLAS.md`.
//!
//! Tras el corte (LXO-117) el runtime sigue trabajando con su `State` en memoria como copia de trabajo, pero ya no lo
//! guarda en `legacy_state` (congelado) ni en `state.json`: cada mutación confirmada se traduce aquí a las tablas
//! normalizadas, comparando el documento confirmado antes con el nuevo, en **una** transacción con sus eventos.
//!
//! ```text
//! runtime_commit_recorded(antes, después, eventos, verify)
//!   BEGIN IMMEDIATE
//!     runs nuevos → tasks (padres primero) → por Task: fila, Attempt (nuevo o seguimiento n + 1), Worktree, sesión,
//!     fases, transición, Artifacts, integración → Tasks retiradas (se descartan) → runs → mensajes → decisiones y
//!     revisiones → bloqueos de entorno → meta.id_seq → meta.runtime_rev → eventos (+ Attention)
//!     verify(vista legacy de lo que cambió)          ← la vista reconstruida debe ser el documento nuevo
//!   COMMIT                                           ← o ROLLBACK de todo: ni filas ni eventos a medias
//! ```
//!
//! Al arrancar, [`Store::runtime_load`] reconstruye el documento desde las tablas con la misma vista ([`CutView`]): lo
//! retirado (Tasks descartadas, su Run, sus mensajes y decisiones) no aparece.
//!
//! El almacén no conoce `orch::State`: lee el documento en su forma JSON con tipos propios ([`RuntimeDoc`]), igual que
//! el SQL del corte. Lo que no se puede representar en las tablas es [`StoreError::RuntimeMapping`] y deshace todo.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::attempts::{
    attempt_phase_append_in, link_provider_session_in, link_worktree_in, runtime_attempt_insert_in, runtime_attempt_set_in, runtime_attempt_step_in,
    runtime_attempt_stop_in, transition_allowed, RuntimeAttempt,
};
use super::cut::{is_cut, CutView};
use super::error::{StoreError, StoreResult};
use super::events::{insert_events_projected, NewEvent};
use super::reviews::{runtime_decision_insert_in, runtime_review_insert_in};
use super::sessions::{
    env_block_set_in, runtime_message_insert_in, runtime_session_insert_in, runtime_session_status_in, runtime_thread_ensure_in,
    thread_messages_mark_read_in, NewThreadMessage, SessionBinding, SessionStatus,
};
use super::tasks::{require_active, runtime_run_insert_in, runtime_run_update_in, runtime_task_discard_in, runtime_task_insert_in, runtime_task_update_in, RuntimeTask, TaskOrigin};
use super::worktrees::{runtime_artifact_insert_in, runtime_worktree_drop_branch_in, runtime_worktree_insert_in, runtime_worktree_insert_removed_in, runtime_worktree_remove_in, ArtifactKind, RemovalReason, RuntimeWorktree};
use super::{new_uuid, AttemptStatus, Store};

/// Revisión del estado del runtime sobre las tablas: agrupa los eventos de un mismo COMMIT (`events.state_rev`), como
/// hacía la `rev` de `legacy_state`. Empieza en la `rev` congelada por el corte.
const RUNTIME_REV_KEY: &str = "runtime_rev";
const CUT_LEGACY_REV_KEY: &str = "f3_cut_legacy_rev";
const MACHINE_KEY: &str = "machine_id";

fn mapping(m: impl Into<String>) -> StoreError {
    StoreError::RuntimeMapping(m.into())
}

// ---------------------------------------------------------------------------------------------------------------------
// El documento legacy, tal como lo ve el almacén
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct RuntimeDoc {
    #[serde(default)]
    pub runs: BTreeMap<String, DocRun>,
    #[serde(default)]
    pub tasks: BTreeMap<String, DocTask>,
    #[serde(default)]
    pub messages: Vec<DocMessage>,
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub decisions: Vec<DocDecision>,
    #[serde(default)]
    pub env_blocks: BTreeMap<String, BTreeSet<String>>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct DocRun {
    pub id: String,
    pub objective: String,
    pub root: String,
    pub created: i64,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub last_activity: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, serde::Serialize)]
pub struct DocPhase {
    pub name: String,
    pub done: bool,
    #[serde(default)]
    pub note: String,
    pub at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct DocTask {
    pub id: String,
    pub run: String,
    pub parent: Option<String>,
    pub depth: i64,
    pub agent: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub role: Option<String>,
    pub title: String,
    pub spec: String,
    pub repo: String,
    pub project_id: Option<String>,
    pub cwd: String,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub worktree: Option<String>,
    pub status: String,
    pub phases: Vec<DocPhase>,
    pub summary: String,
    pub files: Value,
    pub report: Option<String>,
    pub external: bool,
    pub merged: bool,
    pub pr_url: Option<String>,
    pub env: Value,
    pub base_commit: Option<String>,
    pub profile: Option<String>,
    pub ack_unverified: bool,
    pub requested_argv: Value,
    pub policy: Value,
    pub report_nonce: Option<String>,
    pub delivered: Value,
    pub delivery_channel: Option<String>,
    pub model_effective: Option<String>,
    pub model_requested: Option<String>,
    pub model_mismatch: bool,
    pub model_mismatch_reason: Option<String>,
    pub plan_mode: bool,
    pub approval_deadline: Option<i64>,
    pub failure_reason: Option<String>,
    pub session_ref: Option<String>,
    pub model_source: Option<String>,
    pub session_match: Option<String>,
    pub attempt_started: Option<i64>,
    pub last_message_path: Option<String>,
    pub stream_json: bool,
    pub created: i64,
    pub updated: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct DocMessage {
    pub id: i64,
    pub run: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub body: String,
    #[serde(default)]
    pub reply_to: Option<i64>,
    #[serde(default)]
    pub read: bool,
    pub at: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct DocDecision {
    pub id: i64,
    pub task: String,
    pub kind: String,
    pub actor: String,
    pub detail_json: Option<String>,
    pub at: i64,
}

impl RuntimeDoc {
    /// Lee el documento (la forma JSON de `orch::State`).
    pub fn from_value(v: Value) -> StoreResult<RuntimeDoc> {
        serde_json::from_value(v).map_err(|e| StoreError::InvalidDocument(format!("el estado del runtime no se lee: {e}")))
    }
}

/// Lo que tocó una confirmación: lo que `verify` compara con la vista reconstruida.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RuntimeChanges {
    /// Tasks nuevas o cambiadas (están en el documento nuevo).
    pub tasks: BTreeSet<String>,
    /// Tasks retiradas (descartadas en las tablas).
    pub removed_tasks: BTreeSet<String>,
    /// Mensajes nuevos o cambiados.
    pub messages: BTreeSet<i64>,
    /// Runs nuevos o cambiados.
    pub runs: BTreeSet<String>,
}

impl RuntimeChanges {
    pub fn is_empty(&self) -> bool {
        self.tasks.is_empty() && self.removed_tasks.is_empty() && self.messages.is_empty() && self.runs.is_empty()
    }
}

/// El estado cargado de las tablas.
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeLoad {
    /// El documento en la forma de `orch::State`.
    pub doc: Value,
    pub rev: i64,
    /// El mayor id de decisión de la base, también de las Tasks retiradas: una decisión nueva va por encima.
    pub decision_floor: i64,
    /// El número del Attempt actual de cada Task a la vista.
    pub attempts: BTreeMap<String, i64>,
}

// ---------------------------------------------------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------------------------------------------------

fn meta_i64(c: &Connection, key: &str) -> StoreResult<Option<i64>> {
    let v: Option<String> = c.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?;
    v.map(|s| s.parse().map_err(|_| StoreError::InvalidDocument(format!("meta.{key} no es un entero: {s}")))).transpose()
}

fn rev_in(c: &Connection) -> StoreResult<i64> {
    Ok(match meta_i64(c, RUNTIME_REV_KEY)? {
        Some(r) => r,
        None => meta_i64(c, CUT_LEGACY_REV_KEY)?.unwrap_or(0),
    })
}

/// Las Tasks retiradas por el runtime (`remove_run`, limpieza de un lanzamiento fallido): descartadas.
fn discarded_in(c: &Connection) -> StoreResult<BTreeSet<String>> {
    let mut q = c.prepare("SELECT id FROM tasks WHERE intent = 'discarded'")?;
    let ids = q.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<BTreeSet<_>, _>>()?;
    Ok(ids)
}

fn load_in(c: &Connection) -> StoreResult<RuntimeLoad> {
    let view = CutView::new(c);
    let gone = discarded_in(c)?;
    let mut runs = Map::new();
    for r in view.legacy_runs()? {
        if !r["root"].as_str().is_some_and(|root| gone.contains(root)) {
            runs.insert(r["id"].as_str().unwrap_or_default().to_string(), r);
        }
    }
    let mut tasks = Map::new();
    let ids = c.prepare("SELECT id FROM tasks WHERE intent = 'open' ORDER BY id")?.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
    for id in ids {
        tasks.insert(id.clone(), view.legacy_task(&id)?);
    }
    let messages: Vec<Value> = view
        .legacy_messages()?
        .into_iter()
        .filter(|m| !gone.contains(m["from"].as_str().unwrap_or_default()) && !gone.contains(m["to"].as_str().unwrap_or_default()))
        .collect();
    let mut decisions = vec![];
    let mut q = c.prepare("SELECT id, task_id, kind, actor, detail_json, at FROM decisions ORDER BY id")?;
    for d in q.query_map([], |r| {
        Ok(json!({ "id": r.get::<_, i64>(0)?, "task": r.get::<_, String>(1)?, "kind": r.get::<_, String>(2)?, "actor": r.get::<_, String>(3)?,
                   "detail_json": r.get::<_, Option<String>>(4)?, "at": r.get::<_, i64>(5)? }))
    })? {
        let d = d?;
        if !gone.contains(d["task"].as_str().unwrap_or_default()) {
            decisions.push(d);
        }
    }
    let decision_floor: i64 = c.query_row("SELECT coalesce(max(id), 0) FROM decisions", [], |r| r.get(0))?;
    let mut env_blocks: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut q = c.prepare("SELECT scope, cause FROM env_blocks ORDER BY scope, cause")?;
    for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (scope, cause) = row?;
        env_blocks.entry(scope).or_default().push(cause);
    }
    let seq = meta_i64(c, "id_seq")?.unwrap_or(0);
    let doc = json!({ "runs": runs, "tasks": tasks, "messages": messages, "seq": seq, "decisions": decisions, "env_blocks": env_blocks });
    let mut q = c.prepare("SELECT a.task_id, max(a.n) FROM attempts AS a JOIN tasks AS t ON t.id = a.task_id WHERE t.intent = 'open' GROUP BY a.task_id")?;
    let attempts = q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?.collect::<Result<BTreeMap<_, _>, _>>()?;
    Ok(RuntimeLoad { doc, rev: rev_in(c)?, decision_floor, attempts })
}

impl Store {
    /// ¿Persiste el runtime en las tablas? Sí desde el corte Task/Attempt.
    pub fn runtime_on_tables(&self) -> StoreResult<bool> {
        self.read(is_cut)
    }

    /// La revisión del runtime sobre las tablas (la del último COMMIT).
    pub fn runtime_rev(&self) -> StoreResult<i64> {
        self.read(rev_in)
    }

    /// El estado del runtime reconstruido desde las tablas, en una sola instantánea de lectura.
    pub fn runtime_load(&self) -> StoreResult<RuntimeLoad> {
        self.read(|c| {
            require_active(c)?;
            let snapshot = c.unchecked_transaction()?;
            let out = load_in(&snapshot);
            drop(snapshot);
            out
        })
    }

    /// Confirma el paso de `prev` (el documento confirmado) a `next` en las tablas, con sus `events` (y su proyección de
    /// Attention), en UNA transacción. `verify` lee la vista legacy reconstruida de lo que cambió, dentro de la misma
    /// transacción: si no es el documento nuevo, se deshace todo. Devuelve la nueva revisión.
    pub fn runtime_commit_recorded(
        &mut self,
        prev: &RuntimeDoc,
        next: &RuntimeDoc,
        events: &[NewEvent],
        verify: impl FnOnce(&CutView<'_>, &RuntimeChanges) -> StoreResult<()>,
    ) -> StoreResult<i64> {
        for e in events {
            e.check()?;
        }
        let projector = self.projector.clone();
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        require_active(&tx)?;
        let changes = apply(&tx, prev, next)?;
        let rev = rev_in(&tx)? + 1;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![RUNTIME_REV_KEY, rev.to_string()],
        )?;
        super::crash_point("runtime_in_tx");
        insert_events_projected(&tx, events, Some(rev), projector.as_deref())?;
        super::crash_point("runtime_events_in_tx");
        verify(&CutView::new(&tx), &changes)?;
        tx.commit()?;
        Ok(rev)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------------------------------------------------

/// Una fila de `attempts` lo justo para decidir.
#[derive(Debug, Clone)]
struct Cur {
    id: String,
    n: i64,
    status: AttemptStatus,
    core: bool,
    created_at: i64,
    started_at: Option<i64>,
    provider_session_id: Option<String>,
}

fn current(c: &Connection, task: &str) -> StoreResult<Option<Cur>> {
    let raw = c
        .query_row(
            "SELECT id, n, status, origin, created_at, started_at, provider_session_id FROM attempts WHERE task_id = ?1 ORDER BY n DESC LIMIT 1",
            [task],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, Option<i64>>(5)?, r.get::<_, Option<String>>(6)?)),
        )
        .optional()?;
    raw.map(|(id, n, status, origin, created_at, started_at, provider_session_id)| {
        Ok(Cur { id, n, status: AttemptStatus::parse(&status)?, core: origin == "core", created_at, started_at, provider_session_id })
    })
    .transpose()
}

fn status_of(t: &DocTask) -> StoreResult<AttemptStatus> {
    AttemptStatus::parse(&t.status).map_err(|_| mapping(format!("{}: estado legacy desconocido {}", t.id, t.status)))
}

/// Un valor JSON del documento como texto JSON de la columna (`null` → NULL).
fn json_text(v: &Value) -> Option<String> {
    (!v.is_null()).then(|| v.to_string())
}

fn json_list(v: &Value) -> String {
    if v.is_null() { "[]".into() } else { v.to_string() }
}

/// ¿Declaró el proveedor la sesión? Solo entonces es un vínculo (D3): Claude por stream-json o un `session_id`.
fn declared_session(t: &DocTask) -> Option<&str> {
    let declared = (t.agent == "claude" && t.stream_json) || t.session_match.as_deref() == Some("session_id");
    t.session_ref.as_deref().filter(|_| declared)
}

/// El modelo leído de una sesión atada por carpeta y hora no tiene procedencia verificada (D3), como en el corte.
fn model_source(t: &DocTask) -> Option<String> {
    if t.session_match.as_deref() == Some("cwd_time") {
        Some("unknown".into())
    } else {
        t.model_source.clone()
    }
}

/// El Worktree de la Task (lo registra un Attempt y lo reutilizan sus seguimientos).
struct Wt {
    id: String,
    state: String,
    branch_kept: bool,
    path: Option<String>,
    branch: Option<String>,
    core: bool,
}

fn worktree_of(c: &Connection, task: &str) -> StoreResult<Option<Wt>> {
    Ok(c
        .query_row("SELECT id, state, branch_kept, path, branch, origin FROM worktrees WHERE task_id = ?1 ORDER BY rowid DESC LIMIT 1", [task], |r| {
            Ok(Wt { id: r.get(0)?, state: r.get(1)?, branch_kept: r.get::<_, i64>(2)? == 1, path: r.get(3)?, branch: r.get(4)?, core: r.get::<_, String>(5)? == "core" })
        })
        .optional()?)
}

type Col = (&'static str, SqlValue);

fn text(s: &Option<String>) -> SqlValue {
    s.clone().map(SqlValue::Text).unwrap_or(SqlValue::Null)
}

fn int(b: bool) -> SqlValue {
    SqlValue::Integer(b as i64)
}

/// Lo que un Attempt final todavía admite (migración 013): la integración y la observación tardía de su modelo.
fn late_columns(t: &DocTask) -> Vec<Col> {
    vec![
        ("model_effective", text(&t.model_effective)),
        ("model_source", text(&model_source(t))),
        ("model_mismatch", int(t.model_mismatch)),
        ("model_mismatch_reason", text(&t.model_mismatch_reason)),
        ("integrated", int(t.merged)),
    ]
}

fn late_view(t: &DocTask) -> Value {
    json!([t.model_effective, model_source(t), t.model_mismatch, t.model_mismatch_reason, t.merged])
}

/// Las columnas de runtime del Attempt que salen del documento (todas menos el estado y las marcas de tiempo).
fn runtime_columns(c: &Connection, t: &DocTask, cur: &Cur) -> StoreResult<Vec<Col>> {
    let wt = worktree_of(c, &t.id)?;
    let checkout = if t.worktree.is_none() && t.base.is_none() && wt.is_none() { text(&t.branch) } else { SqlValue::Null };
    let mut cols = vec![("checkout_branch", checkout)];
    // Al quitar un Worktree del Core el documento vuelve al repositorio, pero el Attempt conserva dónde corrió: la vista
    // lo deriva del Worktree quitado.
    if t.worktree.is_some() || !wt.is_some_and(|w| w.core) {
        cols.push(("cwd", SqlValue::Text(t.cwd.clone())));
    }
    cols.extend([
        ("policy", json_text(&t.policy).map(SqlValue::Text).unwrap_or(SqlValue::Null)),
        ("ack_unverified", int(t.ack_unverified)),
        ("requested_argv", json_text(&t.requested_argv).map(SqlValue::Text).unwrap_or(SqlValue::Null)),
        ("plan_mode", int(t.plan_mode)),
        ("stream_json", int(t.stream_json)),
        ("report_nonce", text(&t.report_nonce)),
        ("delivered", SqlValue::Text(json_list(&t.delivered))),
        ("delivery_channel", text(&t.delivery_channel)),
        ("model_requested", text(&t.model_requested)),
        ("approval_deadline", t.approval_deadline.map(SqlValue::Integer).unwrap_or(SqlValue::Null)),
        ("files", SqlValue::Text(json_list(&t.files))),
        ("summary", SqlValue::Text(t.summary.clone())),
        ("failure_reason", text(&t.failure_reason)),
    ]);
    cols.extend(late_columns(t));
    // El arranque del intento: `launched_at` en una fila del Core; en una del corte vive en `started_at`.
    let started = t.attempt_started.map(SqlValue::Integer).unwrap_or(SqlValue::Null);
    cols.push(if cur.core { ("launched_at", started) } else { ("started_at", started) });
    Ok(cols)
}

/// La parte del documento que es del Attempt actual: si no cambia, la fila no se toca.
fn attempt_view(t: &DocTask) -> Value {
    json!([
        t.cwd, t.branch, t.base, t.worktree, t.base_commit, t.env, t.policy, t.ack_unverified, t.requested_argv, t.plan_mode, t.stream_json,
        t.report_nonce, t.delivered, t.delivery_channel, t.model_requested, t.approval_deadline, t.files, t.summary, t.failure_reason,
        t.attempt_started, t.status, late_view(t), t.phases, t.session_ref, t.session_match, t.report, t.pr_url, t.last_message_path
    ])
}

/// El camino del ciclo de vida de `from` a `to`: directo o pasando por `running` (de una espera a otra).
fn path(task: &str, from: AttemptStatus, to: AttemptStatus) -> StoreResult<Vec<AttemptStatus>> {
    if from == to {
        return Ok(vec![]);
    }
    if transition_allowed(from, to) {
        return Ok(vec![to]);
    }
    if transition_allowed(from, AttemptStatus::Running) && transition_allowed(AttemptStatus::Running, to) {
        return Ok(vec![AttemptStatus::Running, to]);
    }
    Err(mapping(format!("{task}: el Attempt no pasa de {} a {}", from.as_str(), to.as_str())))
}

fn needs_start(s: AttemptStatus) -> bool {
    matches!(s, AttemptStatus::Running | AttemptStatus::Waiting | AttemptStatus::AwaitingTerminalApproval | AttemptStatus::Done)
}

/// Lleva el Attempt al estado del documento y escribe sus columnas de runtime en el orden que exige la base: los pasos
/// intermedios solo cambian el estado; el último, todo (el motivo de fallo solo existe con `failed`). Un Attempt que ya
/// era final solo recibe lo que la 013 le admite; cualquier otra diferencia la detecta la comprobación de la vista.
fn sync_attempt(c: &Connection, p: Option<&DocTask>, t: &DocTask, cur: &mut Cur, at: i64) -> StoreResult<()> {
    let to = status_of(t)?;
    if cur.status.is_final() {
        if to != cur.status {
            return Err(mapping(format!("{}: el Attempt {} ya terminó ({}) y no pasa a {}", t.id, cur.id, cur.status.as_str(), to.as_str())));
        }
        if p.is_none_or(|p| late_view(p) != late_view(t)) {
            runtime_attempt_set_in(c, &cur.id, late_columns(t), at).map_err(|e| mapping(format!("{}: el Attempt {} no admite el cambio ({e})", t.id, cur.id)))?;
        }
        return Ok(());
    }
    let steps = path(&t.id, cur.status, to)?;
    let started_at = |cur: &Cur, s: AttemptStatus| -> Option<i64> {
        match cur.started_at {
            Some(x) => Some(x),
            None if cur.core && needs_start(s) => Some(at.max(cur.created_at)),
            None => None,
        }
    };
    for s in steps.iter().take(steps.len().saturating_sub(1)) {
        let st = started_at(cur, *s);
        runtime_attempt_step_in(c, &cur.id, *s, st, at).map_err(|e| mapping(format!("{}: el Attempt {} no pasa a {} ({e})", t.id, cur.id, s.as_str())))?;
        cur.status = *s;
        cur.started_at = st;
    }
    let mut cols = runtime_columns(c, t, cur)?;
    if cur.core {
        let st = started_at(cur, to);
        cols.push(("started_at", st.map(SqlValue::Integer).unwrap_or(SqlValue::Null)));
        cur.started_at = st;
    }
    if to.is_final() {
        let end = at.max(cur.started_at.unwrap_or(cur.created_at)).max(cur.created_at);
        cols.push(("ended_at", SqlValue::Integer(end)));
    }
    cols.push(("status", SqlValue::Text(to.as_str().into())));
    runtime_attempt_set_in(c, &cur.id, cols, at).map_err(|e| mapping(format!("{}: el Attempt {} no admite el cambio ({e})", t.id, cur.id)))?;
    cur.status = to;
    Ok(())
}

/// Nace el Attempt `n` de la Task: `starting`, con la selección del documento. Un seguimiento (`n > 1`) lleva su encargo
/// y reutiliza el Worktree activo de la Task (D7).
fn insert_attempt(c: &Connection, t: &DocTask, n: i64, instruction: Option<&str>, at: i64) -> StoreResult<Cur> {
    let id = format!("{}-a{n}", t.id);
    let worktree = worktree_of(c, &t.id)?.filter(|w| w.state == "active").map(|w| w.id);
    let label = |s: &Option<String>| s.as_deref().filter(|v| !v.trim().is_empty()).map(str::to_string);
    let (model, effort, role, profile) = (label(&t.model), label(&t.effort), label(&t.role), label(&t.profile));
    runtime_attempt_insert_in(
        c,
        &RuntimeAttempt {
            id: &id,
            task_id: &t.id,
            n,
            external: t.external,
            provider: &t.agent,
            model: model.as_deref(),
            effort: effort.as_deref(),
            role: role.as_deref(),
            profile: profile.as_deref(),
            worktree_id: worktree.as_deref(),
            instruction,
            cwd: &t.cwd,
            at,
        },
    )
    .map_err(|e| mapping(format!("{}: no nace el Attempt {n} ({e})", t.id)))?;
    Ok(Cur { id, n, status: AttemptStatus::Starting, core: true, created_at: at, started_at: None, provider_session_id: None })
}

fn project_known(c: &Connection, id: &Option<String>) -> StoreResult<bool> {
    match id {
        Some(p) => Ok(c.query_row("SELECT 1 FROM projects WHERE id = ?1", [p], |_| Ok(())).optional()?.is_some()),
        None => Ok(false),
    }
}

fn insert_task(c: &Connection, t: &DocTask) -> StoreResult<()> {
    if t.project_id.is_some() && !project_known(c, &t.project_id)? {
        return Err(mapping(format!("{}: el Project {} no está en el registro", t.id, t.project_id.as_deref().unwrap_or_default())));
    }
    // Las reglas de forma del Core (Project y título) no se pueden imponer a lo que el runtime legacy crea sin ellos: esa
    // Task se guarda como `legacy`, igual que las que importó el corte (ADR D1).
    let origin = if t.project_id.is_some() && !t.title.trim().is_empty() { TaskOrigin::Core } else { TaskOrigin::Legacy };
    runtime_task_insert_in(
        c,
        &RuntimeTask {
            id: &t.id,
            run_id: &t.run,
            parent_task_id: t.parent.as_deref(),
            depth: t.depth,
            project_id: t.project_id.as_deref(),
            title: &t.title,
            spec: &t.spec,
            repo: &t.repo,
            origin,
            created_at: t.created,
            updated_at: t.updated,
        },
    )
    .map_err(|e| mapping(format!("{}: la Task no se puede guardar ({e})", t.id)))
}

fn machine(c: &Connection) -> StoreResult<String> {
    if let Some(m) = c.query_row("SELECT value FROM meta WHERE key = ?1", [MACHINE_KEY], |r| r.get::<_, String>(0)).optional()? {
        return Ok(m);
    }
    let m = new_uuid();
    c.execute("INSERT INTO meta (key, value) VALUES (?1, ?2)", params![MACHINE_KEY, m])?;
    Ok(m)
}

/// Worktree de la Task: nace al registrarlo el lanzamiento, se quita al liberarlo y deja de conservar la rama si `git
/// branch -d` la borra después. La ruta, la rama y la base no cambian.
fn sync_worktree(c: &Connection, p: Option<&DocTask>, t: &DocTask, cur: &Cur, at: i64) -> StoreResult<()> {
    let place = |x: &DocTask| (x.base.clone(), x.base_commit.clone(), x.env.clone());
    let same_place = p.is_none_or(|p| place(p) == place(t));
    let Some(wt) = worktree_of(c, &t.id)? else {
        if t.worktree.is_none() && t.base.is_none() {
            if t.base_commit.is_some() || !t.env.is_null() {
                return Err(mapping(format!("{}: el commit base o el entorno de un Worktree no existen sin él", t.id)));
            }
            return Ok(());
        }
        let (wid, env, machine) = (format!("wt-{}", cur.id), json_text(&t.env), machine(c)?);
        let w = RuntimeWorktree {
            id: &wid,
            task_id: &t.id,
            attempt_id: &cur.id,
            machine: &machine,
            repo: &t.repo,
            path: t.worktree.as_deref().unwrap_or_default(),
            branch: t.branch.as_deref(),
            base_branch: t.base.as_deref(),
            base_commit: t.base_commit.as_deref(),
            env_plan: env.as_deref(),
            at,
        };
        if t.worktree.is_none() {
            // Rama y base sin carpeta: el Worktree ya no está (como lo importa el corte).
            return runtime_worktree_insert_removed_in(c, &w).map_err(|e| mapping(format!("{}: la rama sin Worktree no se puede guardar ({e})", t.id)));
        }
        runtime_worktree_insert_in(c, &w).map_err(|e| mapping(format!("{}: el Worktree no se puede registrar ({e})", t.id)))?;
        return link_worktree_in(c, &cur.id, &wid).map_err(|e| mapping(format!("{}: el Attempt no se vincula a su Worktree ({e})", t.id)));
    };
    if wt.state == "active" {
        match &t.worktree {
            Some(dir) if Some(dir) == wt.path.as_ref() && t.branch == wt.branch && same_place => {}
            Some(_) => return Err(mapping(format!("{}: el Worktree activo no cambia de ruta, rama ni base", t.id))),
            None => {
                if !same_place || (t.branch.is_some() && t.branch != wt.branch) {
                    return Err(mapping(format!("{}: la rama y la base de un Worktree no cambian al quitarlo", t.id)));
                }
                let reason = if t.merged { RemovalReason::Integrated } else { RemovalReason::Discarded };
                runtime_worktree_remove_in(c, &wt.id, reason, t.branch.is_some() && wt.branch.is_some(), at)
                    .map_err(|e| mapping(format!("{}: el Worktree no se puede quitar ({e})", t.id)))?;
            }
        }
        return Ok(());
    }
    // Ya quitado: solo puede dejar de conservar su rama.
    if t.worktree.is_some() || !same_place {
        return Err(mapping(format!("{}: un Worktree quitado no vuelve ni cambia", t.id)));
    }
    match (&t.branch, wt.branch_kept) {
        (None, true) => runtime_worktree_drop_branch_in(c, &wt.id, at).map_err(|e| mapping(format!("{}: el Worktree no suelta su rama ({e})", t.id))),
        (Some(b), true) if Some(b) == wt.branch.as_ref() => Ok(()),
        (None, false) => Ok(()),
        _ => Err(mapping(format!("{}: la rama de un Worktree quitado no cambia", t.id))),
    }
}

/// Sesión del proveedor que declaró el Attempt actual: se reutiliza la de la Task con la misma referencia (D7) o nace
/// una nueva; una sesión que no se declaró no es un vínculo (D3).
fn sync_session(c: &Connection, t: &DocTask, cur: &mut Cur, at: i64) -> StoreResult<()> {
    let want = declared_session(t);
    let have: Option<String> = match &cur.provider_session_id {
        Some(ps) => c.query_row("SELECT external_ref FROM provider_sessions WHERE id = ?1", [ps], |r| r.get(0))?,
        None => None,
    };
    if want == have.as_deref() {
        return Ok(());
    }
    let Some(want) = want else {
        return Err(mapping(format!("{}: el Attempt {} ya tiene su sesión", t.id, cur.id)));
    };
    if have.is_some() {
        return Err(mapping(format!("{}: el Attempt {} no cambia de sesión", t.id, cur.id)));
    }
    let existing: Option<(String, String)> = c
        .query_row("SELECT id, status FROM provider_sessions WHERE task_id = ?1 AND provider = ?2 AND external_ref = ?3", params![t.id, t.agent, want], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let ps = match existing {
        Some((ps, status)) => {
            if !cur.status.is_final() && status == "idle" {
                runtime_session_status_in(c, &ps, SessionStatus::Idle, SessionStatus::Open, at)?;
            }
            ps
        }
        None => {
            let binding = if t.session_match.as_deref() == Some("session_id") { SessionBinding::SessionId } else { SessionBinding::StreamJson };
            let status = if cur.status.is_final() { SessionStatus::Idle } else { SessionStatus::Open };
            runtime_session_insert_in(c, &t.id, &cur.id, &t.agent, want, binding, status, at).map_err(|e| mapping(format!("{}: la sesión no se puede guardar ({e})", t.id)))?
        }
    };
    link_provider_session_in(c, &cur.id, &ps).map_err(|e| mapping(format!("{}: el Attempt no se vincula a su sesión ({e})", t.id)))?;
    cur.provider_session_id = Some(ps);
    Ok(())
}

fn insert_artifact(c: &Connection, task: &str, attempt: &str, kind: ArtifactKind, uri: &str, at: i64) -> StoreResult<()> {
    let base = format!("{attempt}-{}", kind.as_str());
    let mut id = base.clone();
    let mut k = 1;
    while c.query_row("SELECT 1 FROM artifacts WHERE id = ?1", [&id], |_| Ok(())).optional()?.is_some() {
        k += 1;
        id = format!("{base}-{k}");
    }
    runtime_artifact_insert_in(c, &id, attempt, kind, uri, at).map_err(|e| mapping(format!("{task}: el Artifact {} no se puede guardar ({e})", kind.as_str())))
}

/// Lo que el documento añade al Attempt actual: informe (solo de este Attempt), PR y ruta de `codex exec -o` (de la
/// Task: sobreviven a un seguimiento). Un Artifact no se borra ni cambia: uno nuevo sustituye al anterior en la vista.
fn sync_artifacts(c: &Connection, p: Option<&DocTask>, t: &DocTask, cur: &Cur, fresh_attempt: bool, at: i64) -> StoreResult<()> {
    let before_report = if fresh_attempt { None } else { p.and_then(|p| p.report.clone()) };
    for (kind, was, now) in [
        (ArtifactKind::Report, before_report, t.report.clone()),
        (ArtifactKind::PullRequest, p.and_then(|p| p.pr_url.clone()), t.pr_url.clone()),
        (ArtifactKind::LastMessage, p.and_then(|p| p.last_message_path.clone()), t.last_message_path.clone()),
    ] {
        match (&was, &now) {
            (a, b) if a == b => {}
            (_, Some(uri)) => insert_artifact(c, &t.id, &cur.id, kind, uri, at)?,
            (Some(_), None) => return Err(mapping(format!("{}: el Artifact {} no se retira", t.id, kind.as_str()))),
            (None, None) => {}
        }
    }
    Ok(())
}

/// Las fases anteriores ya están en los Attempts previos (la vista las concatena): solo se añaden las nuevas.
fn sync_phases(c: &Connection, p: Option<&DocTask>, t: &DocTask, cur: &Cur) -> StoreResult<()> {
    let before = p.map(|p| p.phases.as_slice()).unwrap_or_default();
    if t.phases.len() < before.len() || t.phases[..before.len()] != *before {
        return Err(mapping(format!("{}: las fases son historia: solo se añaden", t.id)));
    }
    for ph in &t.phases[before.len()..] {
        attempt_phase_append_in(c, &cur.id, &ph.name, ph.done, &ph.note, ph.at).map_err(|e| mapping(format!("{}: la fase no se puede añadir ({e})", t.id)))?;
    }
    Ok(())
}

/// Un seguimiento (`lxo continue`) añade al `spec` el bloque «Seguimiento»: ese texto es el encargo del Attempt nuevo.
fn follow_up(p: &DocTask, t: &DocTask) -> Option<String> {
    t.spec.strip_prefix(p.spec.as_str())?.strip_prefix("\n\n---\nSeguimiento:\n").map(str::to_string)
}

fn apply_task(c: &Connection, p: Option<&DocTask>, t: &DocTask) -> StoreResult<()> {
    let at = t.updated.max(t.created);
    match p {
        None => insert_task(c, t)?,
        Some(p) => {
            if p.run != t.run || p.parent != t.parent || p.depth != t.depth || p.created != t.created || p.repo != t.repo {
                return Err(mapping(format!("{}: el Run, el padre, la profundidad, el repositorio y la creación no cambian", t.id)));
            }
            if p.project_id.is_some() && p.project_id != t.project_id {
                return Err(mapping(format!("{}: el Project de una Task no cambia", t.id)));
            }
            if p.project_id.is_none() && t.project_id.is_some() && !project_known(c, &t.project_id)? {
                return Err(mapping(format!("{}: el Project {} no está en el registro", t.id, t.project_id.as_deref().unwrap_or_default())));
            }
            runtime_task_update_in(c, &t.id, &t.title, &t.spec, t.project_id.as_deref(), at).map_err(|e| mapping(format!("{}: la Task no se puede actualizar ({e})", t.id)))?;
        }
    }
    let selection = |x: &DocTask| (x.agent.clone(), x.model.clone(), x.effort.clone(), x.role.clone(), x.profile.clone(), x.external);
    let (mut cur, fresh) = match (p, current(c, &t.id)?) {
        (None, None) => (insert_attempt(c, t, 1, None, t.created)?, true),
        (Some(p), Some(cur)) => {
            if status_of(p)?.is_final() && !status_of(t)?.is_final() {
                // Un seguimiento nunca reabre el Attempt: crea el siguiente.
                (insert_attempt(c, t, cur.n + 1, follow_up(p, t).as_deref(), at)?, true)
            } else {
                if selection(p) != selection(t) {
                    return Err(mapping(format!("{}: la selección del Attempt (agente, modelo, esfuerzo, rol, perfil) no cambia", t.id)));
                }
                (cur, false)
            }
        }
        (None, Some(_)) => return Err(mapping(format!("{}: la Task ya existe en las tablas", t.id))),
        (Some(_), None) => return Err(mapping(format!("{}: la Task no tiene Attempt", t.id))),
    };
    if !fresh && p.is_some_and(|p| attempt_view(p) == attempt_view(t)) {
        return Ok(());
    }
    let was_final = cur.status.is_final();
    // Lo que exige un Attempt activo va antes de la transición: Worktree, fases y el vínculo de la sesión.
    sync_worktree(c, p, t, &cur, at)?;
    sync_session(c, t, &mut cur, at)?;
    sync_phases(c, p, t, &cur)?;
    sync_attempt(c, p.filter(|_| !fresh), t, &mut cur, at)?;
    if cur.status.is_final() && !was_final {
        if let Some(ps) = &cur.provider_session_id {
            runtime_session_status_in(c, ps, SessionStatus::Open, SessionStatus::Idle, at)?;
        }
    }
    sync_artifacts(c, p, t, &cur, fresh && p.is_some(), at)
}

/// Una Task que el runtime retira (`remove_run`, la limpieza de un lanzamiento fallido) se descarta: su historia se
/// conserva y no vuelve al cargar. Un Attempt que siga activo se para antes (D24).
fn retire_task(c: &Connection, id: &str, at: i64) -> StoreResult<()> {
    if let Some(cur) = current(c, id)? {
        if !cur.status.is_final() {
            let end = at.max(cur.started_at.unwrap_or(cur.created_at)).max(cur.created_at);
            runtime_attempt_stop_in(c, &cur.id, end).map_err(|e| mapping(format!("{id}: el Attempt {} no se puede parar ({e})", cur.id)))?;
            if let Some(ps) = &cur.provider_session_id {
                runtime_session_status_in(c, ps, SessionStatus::Open, SessionStatus::Idle, at)?;
            }
        }
    }
    runtime_task_discard_in(c, id, at).map_err(|e| mapping(format!("{id}: la Task no se puede retirar ({e})")))
}

/// El Thread de un mensaje es el de la Task de mayor profundidad entre emisor y destino (como en el corte).
fn thread_owner<'a>(next: &'a RuntimeDoc, m: &'a DocMessage) -> StoreResult<&'a DocTask> {
    let from = next.tasks.get(&m.from).ok_or_else(|| mapping(format!("mensaje {}: no existe el emisor {}", m.id, m.from)))?;
    let to = next.tasks.get(&m.to).ok_or_else(|| mapping(format!("mensaje {}: no existe el destino {}", m.id, m.to)))?;
    Ok(if from.depth >= to.depth && (from.id == to.id || from.depth != to.depth) { from } else { to })
}

fn insert_message(c: &Connection, next: &RuntimeDoc, m: &DocMessage) -> StoreResult<()> {
    let owner = thread_owner(next, m)?;
    let thread = runtime_thread_ensure_in(c, &owner.id, &owner.run, m.at).map_err(|e| mapping(format!("mensaje {}: el Thread no se puede abrir ({e})", m.id)))?;
    // Lo que escribe una Task a otra es de su Attempt actual; una nota a sí misma (la persona a la raíz) no.
    let from_attempt_id = if m.from != m.to { current(c, &m.from)?.map(|a| a.id) } else { None };
    let new = NewThreadMessage {
        thread_id: thread,
        from_task_id: m.from.clone(),
        to_task_id: m.to.clone(),
        from_attempt_id,
        kind: m.kind.clone(),
        body: m.body.clone(),
        reply_to: m.reply_to,
        at: m.at,
    };
    runtime_message_insert_in(c, m.id, &new, m.read).map_err(|e| mapping(format!("mensaje {}: no se puede guardar ({e})", m.id)))
}

fn insert_decision(c: &Connection, d: &DocDecision) -> StoreResult<()> {
    let attempt = current(c, &d.task)?.map(|a| a.id);
    runtime_decision_insert_in(c, d.id, &d.task, attempt.as_deref(), &d.kind, &d.actor, d.detail_json.as_deref(), d.at)
        .map_err(|e| mapping(format!("decisión {}: no se puede guardar ({e})", d.id)))?;
    // Una revisión con su target concreto (Attempt, head) deja `superseded` la anterior de ese Attempt (LXO-118). Sin
    // target válido queda solo la decisión, como en el corte.
    if d.kind != "review" {
        return Ok(());
    }
    let (Some(attempt), Some(detail)) = (attempt, d.detail_json.as_deref().and_then(|j| serde_json::from_str::<Value>(j).ok())) else {
        return Ok(());
    };
    let head = detail["head_commit"].as_str().filter(|h| (4..=64).contains(&h.len()));
    let base = detail["base_commit"].as_str().filter(|b| (4..=64).contains(&b.len()));
    let verdict = detail["decision"].as_str().filter(|v| matches!(*v, "accepted" | "rejected"));
    let (Some(head), Some(verdict)) = (head, verdict) else { return Ok(()) };
    runtime_review_insert_in(c, d.id, &attempt, head, base, verdict, d.at).map_err(|e| mapping(format!("revisión {}: no se puede guardar ({e})", d.id)))
}

fn apply(tx: &Transaction<'_>, prev: &RuntimeDoc, next: &RuntimeDoc) -> StoreResult<RuntimeChanges> {
    let mut ch = RuntimeChanges::default();
    let now = super::now_ms();

    // Runs nuevos, abiertos: un Attempt solo nace en un Run abierto. Su estado final se escribe al terminar.
    for (id, r) in next.runs.iter().filter(|(id, _)| !prev.runs.contains_key(*id)) {
        runtime_run_insert_in(tx, id, &r.objective, &r.root, r.created, r.last_activity).map_err(|e| mapping(format!("{id}: el Run no se puede guardar ({e})")))?;
    }

    // Tasks: las nuevas con los padres primero (el árbol del Core se comprueba al insertar).
    let mut order: Vec<&DocTask> = next.tasks.values().filter(|t| prev.tasks.get(&t.id) != Some(*t)).collect();
    order.sort_by_key(|t| (prev.tasks.contains_key(&t.id), t.depth, t.created, t.id.clone()));
    for t in order {
        apply_task(tx, prev.tasks.get(&t.id), t)?;
        ch.tasks.insert(t.id.clone());
    }
    for id in prev.tasks.keys().filter(|id| !next.tasks.contains_key(*id)) {
        retire_task(tx, id, now)?;
        ch.removed_tasks.insert(id.clone());
    }

    for (id, r) in &next.runs {
        if prev.runs.get(id) == Some(r) {
            continue;
        }
        if prev.runs.get(id).is_some_and(|p| p.closed && !r.closed) {
            return Err(mapping(format!("{id}: un Run cerrado no se reabre")));
        }
        runtime_run_update_in(tx, id, &r.objective, &r.root, r.closed, r.last_activity).map_err(|e| mapping(format!("{id}: el Run no se puede actualizar ({e})")))?;
        ch.runs.insert(id.clone());
    }
    for (id, r) in prev.runs.iter().filter(|(id, _)| !next.runs.contains_key(*id)) {
        if !ch.removed_tasks.contains(&r.root) {
            return Err(mapping(format!("{id}: un Run solo se retira con sus Tasks")));
        }
    }

    // Mensajes: nacen, se marcan leídos y, al retirar sus Tasks, dejan de verse. Nada más cambia.
    let before: BTreeMap<i64, &DocMessage> = prev.messages.iter().map(|m| (m.id, m)).collect();
    let mut seen = BTreeSet::new();
    let mut read = vec![];
    for m in &next.messages {
        seen.insert(m.id);
        match before.get(&m.id) {
            None => insert_message(tx, next, m)?,
            Some(p) if *p == m => continue,
            Some(p) => {
                let mut leido = (*p).clone();
                leido.read = true;
                if leido != *m {
                    return Err(mapping(format!("mensaje {}: un mensaje solo cambia al leerse", m.id)));
                }
                read.push(m.id);
            }
        }
        ch.messages.insert(m.id);
    }
    thread_messages_mark_read_in(tx, &read)?;
    for m in prev.messages.iter().filter(|m| !seen.contains(&m.id)) {
        if !ch.removed_tasks.contains(&m.from) && !ch.removed_tasks.contains(&m.to) {
            return Err(mapping(format!("mensaje {}: un mensaje solo se retira con sus Tasks", m.id)));
        }
    }

    // Decisiones: historia. Las nuevas se atan al Attempt actual de su Task.
    let before: BTreeMap<i64, &DocDecision> = prev.decisions.iter().map(|d| (d.id, d)).collect();
    let mut seen = BTreeSet::new();
    for d in &next.decisions {
        seen.insert(d.id);
        match before.get(&d.id) {
            None => insert_decision(tx, d)?,
            Some(p) if *p == d => {}
            Some(_) => return Err(mapping(format!("decisión {}: una decisión no se modifica", d.id))),
        }
    }
    for d in prev.decisions.iter().filter(|d| !seen.contains(&d.id)) {
        if !ch.removed_tasks.contains(&d.task) {
            return Err(mapping(format!("decisión {}: una decisión solo se retira con su Task", d.id)));
        }
    }

    // Bloqueos de entorno: el conjunto (alcance, causa) del documento.
    let set = |d: &RuntimeDoc| -> BTreeSet<(String, String)> { d.env_blocks.iter().flat_map(|(s, cs)| cs.iter().map(move |c| (s.clone(), c.clone()))).collect() };
    let (was, now_set) = (set(prev), set(next));
    for (scope, cause) in was.difference(&now_set) {
        env_block_set_in(tx, scope, cause, false)?;
    }
    for (scope, cause) in now_set.difference(&was) {
        env_block_set_in(tx, scope, cause, true).map_err(|e| mapping(format!("bloqueo de entorno {scope}/{cause}: no se puede guardar ({e})")))?;
    }

    // El contador compartido (tN, rN, mensajes) nunca retrocede.
    tx.execute(
        "INSERT INTO meta (key, value) VALUES ('id_seq', ?1)
         ON CONFLICT (key) DO UPDATE SET value = CAST(max(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)",
        [next.seq.to_string()],
    )?;
    Ok(ch)
}
