//! Attempt como ejecución concreta de una Task (LXO-114, épica F3): lado del **almacén**. Contrato:
//! `docs/core/ATTEMPTS.md`.
//!
//! Solo sabe guardar y leer las filas de `attempts` (migración `008_attempts`). No conoce `orch`, ni qué hechos
//! existen, ni quién los provoca: los eventos llegan de `orch::attempt_ops`. La dirección sigue siendo `orch -> store`.
//!
//! # Garantías
//! * **Retry = Attempt nuevo.** [`Store::attempt_create_recorded`] inserta `n + 1`; ningún mutador reabre ni
//!   reescribe un Attempt anterior, y la base impide modificar uno final.
//! * **Ciclo de vida cerrado.** Cada [`AttemptStep`] tiene sus estados de origen y su destino; cualquier otro par es
//!   [`StoreError::AttemptTransition`] sin escribir nada. La misma tabla vive en el trigger `attempts_lifecycle`
//!   (una prueba compara las 81 combinaciones).
//! * **Estado + evento, juntos.** Cada mutador es UNA transacción (`BEGIN IMMEDIATE`) con su fila, su evento
//!   (`state_rev = NULL`) y la proyección de Attention. El evento lo construye quien llama con un closure puro que
//!   recibe la fila ya escrita; si no se refiere a este Attempt, está duplicado o falla al proyectarse, se deshace todo.
//! * **Inerte hasta el corte** (`meta.agentic_model`), como `store::tasks`.
//! * **Las marcas de tiempo las fija quien llama** y nunca retroceden respecto a `updated_at`.
//! * **Sin runtime.** Ni procesos, ni worktrees, ni sesiones: el vínculo a Worktree y ProviderSession es una
//!   referencia blanda que fijan los slices de esas entidades junto a su propio hecho.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: solo lo usan `orch::attempt_ops` y las pruebas

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::error::{StoreError, StoreResult};
use super::events::NewEvent;
use super::projects::ChangeOutcome;
use super::tasks::{insert_all, require_active, run_in, task_in, TaskIntent, TaskOrigin, TaskRow};
use super::Store;

/// Inserta el hecho del cambio. Un duplicado por `(kind, idem_key)` deshace el cambio (es un conflicto del Attempt).
fn insert_event(tx: &rusqlite::Transaction<'_>, e: &NewEvent, projector: Option<&dyn super::events::EventProjector>) -> StoreResult<()> {
    insert_all(tx, std::slice::from_ref(e), projector).map_err(|err| match err {
        StoreError::TaskConflict(m) => StoreError::AttemptConflict(m),
        otro => otro,
    })
}

/// Máximo de caracteres del resultado mínimo de un Attempt.
pub const MAX_SUMMARY_CHARS: usize = 2000;
const MAX_LABEL_CHARS: usize = 120;
const MAX_REASON_CHARS: usize = 64;

/// Estado de un Attempt. Los ids son los de `contracts/status-vocabulary.json` (`attempt_state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatus {
    PendingApproval,
    Starting,
    Running,
    Waiting,
    AwaitingTerminalApproval,
    Done,
    Failed,
    Stopped,
    Exited,
}

impl AttemptStatus {
    pub const ALL: [AttemptStatus; 9] = [
        AttemptStatus::PendingApproval,
        AttemptStatus::Starting,
        AttemptStatus::Running,
        AttemptStatus::Waiting,
        AttemptStatus::AwaitingTerminalApproval,
        AttemptStatus::Done,
        AttemptStatus::Failed,
        AttemptStatus::Stopped,
        AttemptStatus::Exited,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AttemptStatus::PendingApproval => "pending_approval",
            AttemptStatus::Starting => "starting",
            AttemptStatus::Running => "running",
            AttemptStatus::Waiting => "waiting",
            AttemptStatus::AwaitingTerminalApproval => "awaiting_terminal_approval",
            AttemptStatus::Done => "done",
            AttemptStatus::Failed => "failed",
            AttemptStatus::Stopped => "stopped",
            AttemptStatus::Exited => "exited",
        }
    }

    pub fn parse(s: &str) -> StoreResult<AttemptStatus> {
        AttemptStatus::ALL.into_iter().find(|a| a.as_str() == s).ok_or_else(|| StoreError::InvalidAttempt(format!("estado desconocido: {s}")))
    }

    /// Un estado final es historia: no vuelve a ninguno.
    pub fn is_final(self) -> bool {
        matches!(self, AttemptStatus::Done | AttemptStatus::Failed | AttemptStatus::Stopped | AttemptStatus::Exited)
    }
}

/// Una transición del ciclo de vida. La tabla `(de, a)` sale de aquí: es la ÚNICA definición en Rust y la que el
/// trigger `attempts_lifecycle` repite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttemptStep {
    Approve,
    Start,
    Finish,
    Fail,
    Cancel,
}

impl AttemptStep {
    pub const ALL: [AttemptStep; 5] = [AttemptStep::Approve, AttemptStep::Start, AttemptStep::Finish, AttemptStep::Fail, AttemptStep::Cancel];

    pub fn to(self) -> AttemptStatus {
        match self {
            AttemptStep::Approve => AttemptStatus::Starting,
            AttemptStep::Start => AttemptStatus::Running,
            AttemptStep::Finish => AttemptStatus::Done,
            AttemptStep::Fail => AttemptStatus::Failed,
            AttemptStep::Cancel => AttemptStatus::Stopped,
        }
    }

    pub fn from_states(self) -> &'static [AttemptStatus] {
        use AttemptStatus::*;
        match self {
            AttemptStep::Approve => &[PendingApproval],
            AttemptStep::Start => &[Starting],
            AttemptStep::Finish => &[Running, Waiting, AwaitingTerminalApproval],
            AttemptStep::Fail => &[Starting, Running, Waiting, AwaitingTerminalApproval],
            AttemptStep::Cancel => &[PendingApproval, Starting, Running, Waiting, AwaitingTerminalApproval],
        }
    }
}

/// ¿Admite el ciclo de vida pasar de `from` a `to`?
pub fn transition_allowed(from: AttemptStatus, to: AttemptStatus) -> bool {
    AttemptStep::ALL.iter().any(|s| s.to() == to && s.from_states().contains(&from))
}

/// Un Attempt tal como está en la base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttemptRow {
    /// `<task_id>-a<n>`: determinista.
    pub id: String,
    pub task_id: String,
    pub n: i64,
    pub status: AttemptStatus,
    /// Coordinador que corre fuera de Lixbon.
    pub external: bool,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub role: Option<String>,
    pub profile: Option<String>,
    /// Referencias blandas, fijadas una sola vez por los slices de Worktree y ProviderSession.
    pub worktree_id: Option<String>,
    pub provider_session_id: Option<String>,
    /// Resultado mínimo (como mucho [`MAX_SUMMARY_CHARS`] caracteres). El informe completo será un Artifact.
    pub summary: String,
    /// Código del motivo; solo en `failed`.
    pub failure_reason: Option<String>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub updated_at: i64,
    pub origin: TaskOrigin,
}

/// Qué ejecución se pide. La Task la fija el mutador; el número y el id, también.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewAttempt {
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub role: Option<String>,
    pub profile: Option<String>,
    pub external: bool,
    /// `true`: nace `pending_approval` y espera a una persona; `false`: nace `starting`.
    pub requires_approval: bool,
}

/// Una transición con sus datos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptAction {
    Approve,
    Start,
    Finish { summary: String },
    /// `reason` es un código (`snake_case`, hasta 64 caracteres), nunca texto libre.
    Fail { reason: String, summary: String },
    Cancel,
}

impl AttemptAction {
    pub fn step(&self) -> AttemptStep {
        match self {
            AttemptAction::Approve => AttemptStep::Approve,
            AttemptAction::Start => AttemptStep::Start,
            AttemptAction::Finish { .. } => AttemptStep::Finish,
            AttemptAction::Fail { .. } => AttemptStep::Fail,
            AttemptAction::Cancel => AttemptStep::Cancel,
        }
    }
}

const ATTEMPT_COLS: &str = "id, task_id, n, status, external, provider, model, effort, role, profile, worktree_id, provider_session_id, \
                            summary, failure_reason, created_at, started_at, ended_at, updated_at, origin";

type RawAttempt = (AttemptRow, String, String);

fn attempt_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawAttempt> {
    let external: i64 = r.get(4)?;
    Ok((
        AttemptRow {
            id: r.get(0)?,
            task_id: r.get(1)?,
            n: r.get(2)?,
            status: AttemptStatus::Starting,
            external: external == 1,
            provider: r.get(5)?,
            model: r.get(6)?,
            effort: r.get(7)?,
            role: r.get(8)?,
            profile: r.get(9)?,
            worktree_id: r.get(10)?,
            provider_session_id: r.get(11)?,
            summary: r.get(12)?,
            failure_reason: r.get(13)?,
            created_at: r.get(14)?,
            started_at: r.get(15)?,
            ended_at: r.get(16)?,
            updated_at: r.get(17)?,
            origin: TaskOrigin::Core,
        },
        r.get(3)?,
        r.get(18)?,
    ))
}

fn finish_attempt((mut a, status, origin): RawAttempt) -> StoreResult<AttemptRow> {
    a.status = AttemptStatus::parse(&status)?;
    a.origin = TaskOrigin::parse(&origin)?;
    Ok(a)
}

fn attempt_in(c: &Connection, id: &str) -> StoreResult<Option<AttemptRow>> {
    c.query_row(&format!("SELECT {ATTEMPT_COLS} FROM attempts WHERE id = ?1"), [id], attempt_from_row).optional()?.map(finish_attempt).transpose()
}

fn attempts_where(c: &Connection, filter: &str, arg: &str) -> StoreResult<Vec<AttemptRow>> {
    let sql = format!("SELECT {ATTEMPT_COLS} FROM attempts WHERE {filter} ORDER BY task_id, n");
    let rows = c.prepare(&sql)?.query_map([arg], attempt_from_row)?.collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(finish_attempt).collect()
}

/// Texto corto opcional de la selección (modelo, esfuerzo, rol, perfil): sin espacios sobrantes ni control.
fn check_label(field: &str, value: &str) -> StoreResult<()> {
    let ok = !value.trim().is_empty() && value.chars().count() <= MAX_LABEL_CHARS && !value.chars().any(char::is_control);
    if ok {
        Ok(())
    } else {
        Err(StoreError::InvalidAttempt(format!("{field}: vacío, demasiado largo o con caracteres de control")))
    }
}

fn check_new(new: &NewAttempt) -> StoreResult<()> {
    check_label("provider", &new.provider)?;
    for (field, v) in [("model", &new.model), ("effort", &new.effort), ("role", &new.role), ("profile", &new.profile)] {
        if let Some(v) = v {
            check_label(field, v)?;
        }
    }
    Ok(())
}

fn check_summary(summary: &str) -> StoreResult<()> {
    if summary.chars().count() > MAX_SUMMARY_CHARS {
        return Err(StoreError::InvalidAttempt(format!("el resumen pasa de {MAX_SUMMARY_CHARS} caracteres: el informe completo es un Artifact")));
    }
    Ok(())
}

/// Un motivo es un código, no una frase: `snake_case` ASCII.
fn check_reason(reason: &str) -> StoreResult<()> {
    let ok = !reason.is_empty()
        && reason.len() <= MAX_REASON_CHARS
        && reason.starts_with(|c: char| c.is_ascii_lowercase())
        && reason.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
    if ok {
        Ok(())
    } else {
        Err(StoreError::InvalidAttempt(format!("el motivo debe ser un código snake_case de hasta {MAX_REASON_CHARS} caracteres")))
    }
}

/// El evento se refiere a este Attempt: su entidad, su Run y su Project (los de su Task).
fn check_attempt_event(a: &AttemptRow, t: &TaskRow, e: &NewEvent) -> StoreResult<()> {
    if e.entity_kind != "attempt" || e.entity_id != a.id || e.run_id.as_deref() != Some(t.run_id.as_str()) || e.project_id != t.project_id {
        return Err(StoreError::InvalidEvent(format!("{}: el evento no se refiere al Attempt {}", e.kind, a.id)));
    }
    e.check()
}

fn task_of(tx: &Connection, a: &AttemptRow) -> StoreResult<TaskRow> {
    task_in(tx, &a.task_id)?.ok_or_else(|| StoreError::AttemptConflict(format!("el Attempt {} apunta a la Task inexistente {}", a.id, a.task_id)))
}

impl Store {
    /// Nace el Attempt `n + 1` de `task_id`: `pending_approval` (si pide aprobación) o `starting`, más su evento, en UNA
    /// transacción. Un reintento NO toca los Attempts anteriores. La Task tiene que existir, estar abierta, ser de un
    /// Run abierto y no tener ya un Attempt activo; si no, es [`StoreError::AttemptConflict`] y no se escribe nada.
    pub fn attempt_create_recorded(&mut self, task_id: &str, new: &NewAttempt, at: i64, event: impl FnOnce(&AttemptRow, &TaskRow) -> StoreResult<NewEvent>) -> StoreResult<AttemptRow> {
        check_new(new)?;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let task = task_in(tx, task_id)?.ok_or_else(|| StoreError::AttemptConflict(format!("no existe la Task {task_id}")))?;
            if task.intent == TaskIntent::Discarded {
                return Err(StoreError::AttemptConflict(format!("la Task {task_id} está descartada: no admite Attempts")));
            }
            if run_in(tx, &task.run_id)?.is_some_and(|r| r.closed) {
                return Err(StoreError::AttemptConflict(format!("el Run {} está cerrado: no admite Attempts nuevos", task.run_id)));
            }
            let activo: Option<String> =
                tx.query_row("SELECT id FROM attempts WHERE task_id = ?1 AND status NOT IN ('done', 'failed', 'stopped', 'exited')", [task_id], |r| r.get(0)).optional()?;
            if let Some(activo) = activo {
                return Err(StoreError::AttemptConflict(format!("la Task {task_id} ya tiene el Attempt activo {activo}: espera a que termine o cancélalo")));
            }
            let n: i64 = tx.query_row("SELECT COALESCE(MAX(n), 0) + 1 FROM attempts WHERE task_id = ?1", [task_id], |r| r.get(0))?;
            let status = if new.requires_approval { AttemptStatus::PendingApproval } else { AttemptStatus::Starting };
            let id = format!("{task_id}-a{n}");
            tx.execute(
                "INSERT INTO attempts (id, task_id, n, status, external, provider, model, effort, role, profile, created_at, updated_at, origin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, 'core')",
                params![id, task_id, n, status.as_str(), new.external as i64, new.provider, new.model, new.effort, new.role, new.profile, at],
            )?;
            let attempt = attempt_in(tx, &id)?.ok_or_else(|| StoreError::AttemptConflict(format!("el Attempt recién creado {id} no existe")))?;
            let e = event(&attempt, &task)?;
            check_attempt_event(&attempt, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(attempt)
        })
    }

    /// Aplica una transición cerrada al Attempt `id` y registra su evento, en UNA transacción. El closure recibe el
    /// Attempt ya cambiado, el estado del que venía y su Task.
    ///
    /// * `Missing`: no existe. `Unchanged`: ya estaba en el destino (reintento idempotente; sin evento).
    /// * Cualquier otro par que no esté en la tabla es [`StoreError::AttemptTransition`], sin escribir nada: un final
    ///   no vuelve a `running` ni se cancela después de terminar.
    pub fn attempt_transition_recorded(
        &mut self,
        id: &str,
        action: &AttemptAction,
        at: i64,
        event: impl FnOnce(&AttemptRow, AttemptStatus, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ChangeOutcome> {
        match action {
            AttemptAction::Finish { summary } => check_summary(summary)?,
            AttemptAction::Fail { reason, summary } => {
                check_reason(reason)?;
                check_summary(summary)?;
            }
            AttemptAction::Approve | AttemptAction::Start | AttemptAction::Cancel => {}
        }
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(current) = attempt_in(tx, id)? else { return Ok(ChangeOutcome::Missing) };
            let target = action.step().to();
            if current.status == target {
                return Ok(ChangeOutcome::Unchanged);
            }
            if !transition_allowed(current.status, target) {
                return Err(StoreError::AttemptTransition { id: id.into(), from: current.status.as_str().into(), to: target.as_str().into() });
            }
            let stamp = at.max(current.updated_at);
            let changed = match action {
                AttemptAction::Approve => tx.execute("UPDATE attempts SET status = ?2, updated_at = ?3 WHERE id = ?1", params![id, target.as_str(), stamp])?,
                AttemptAction::Start => tx.execute("UPDATE attempts SET status = ?2, started_at = ?3, updated_at = ?3 WHERE id = ?1", params![id, target.as_str(), stamp])?,
                AttemptAction::Finish { summary } => {
                    tx.execute("UPDATE attempts SET status = ?2, summary = ?3, ended_at = ?4, updated_at = ?4 WHERE id = ?1", params![id, target.as_str(), summary, stamp])?
                }
                AttemptAction::Fail { reason, summary } => tx.execute(
                    "UPDATE attempts SET status = ?2, failure_reason = ?3, summary = ?4, ended_at = ?5, updated_at = ?5 WHERE id = ?1",
                    params![id, target.as_str(), reason, summary, stamp],
                )?,
                AttemptAction::Cancel => tx.execute("UPDATE attempts SET status = ?2, ended_at = ?3, updated_at = ?3 WHERE id = ?1", params![id, target.as_str(), stamp])?,
            };
            if changed != 1 {
                return Err(StoreError::AttemptConflict(format!("no se pudo actualizar el Attempt {id}")));
            }
            let attempt = attempt_in(tx, id)?.ok_or_else(|| StoreError::AttemptConflict(format!("el Attempt {id} desapareció")))?;
            let task = task_of(tx, &attempt)?;
            let e = event(&attempt, current.status, &task)?;
            check_attempt_event(&attempt, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    pub fn attempt_row(&self, id: &str) -> StoreResult<Option<AttemptRow>> {
        self.read(|c| attempt_in(c, id))
    }

    /// Todos los Attempts de una Task, del primero al último (la historia completa).
    pub fn attempts_of_task(&self, task_id: &str) -> StoreResult<Vec<AttemptRow>> {
        self.read(|c| attempts_where(c, "task_id = ?1", task_id))
    }

    /// El Attempt más reciente de la Task (`n` más alto), activo o final. `None`: la Task no tiene ninguno.
    pub fn attempt_current(&self, task_id: &str) -> StoreResult<Option<AttemptRow>> {
        self.read(|c| {
            c.query_row(&format!("SELECT {ATTEMPT_COLS} FROM attempts WHERE task_id = ?1 ORDER BY n DESC LIMIT 1"), [task_id], attempt_from_row).optional()?.map(finish_attempt).transpose()
        })
    }

    /// El Attempt activo (no final) de la Task, si lo hay. Una Task puede existir sin ninguno.
    pub fn attempt_active(&self, task_id: &str) -> StoreResult<Option<AttemptRow>> {
        self.read(|c| {
            c.query_row(
                &format!("SELECT {ATTEMPT_COLS} FROM attempts WHERE task_id = ?1 AND status NOT IN ('done', 'failed', 'stopped', 'exited')"),
                [task_id],
                attempt_from_row,
            )
            .optional()?
            .map(finish_attempt)
            .transpose()
        })
    }

    /// Los Attempts en un estado, ordenados por Task y número (la cola de aprobaciones, los que corren…).
    pub fn attempts_by_status(&self, status: AttemptStatus) -> StoreResult<Vec<AttemptRow>> {
        self.read(|c| attempts_where(c, "status = ?1", status.as_str()))
    }
}
