//! ProviderSession y Thread explícitos (LXO-115, épica F3): lado del **almacén**. Contrato:
//! `docs/core/SESIONES_THREADS.md`.
//!
//! Solo sabe guardar y leer las filas de `provider_sessions`, `threads` y `thread_messages` (migración
//! `009_sessions_threads`). Los eventos llegan de `orch::session_ops`; la dirección sigue siendo `orch -> store`.
//!
//! # Garantías
//! * **Solo vínculos declarados.** Una sesión nace de un Attempt activo y su referencia la entrega el proveedor
//!   (`stream_json` o `session_id`). No hay forma de crearla a partir de una carpeta y una hora.
//! * **Referencia opaca.** El Core no interpreta `external_ref`: solo comprueba que es texto corto sin control ni
//!   forma de credencial, y la fija una vez.
//! * **Ciclo de vida cerrado.** [`SessionStep`] es la única tabla en Rust y la que repite el trigger
//!   `provider_sessions_lifecycle`. Solo una sesión resumible pasa a `idle` y se reanuda.
//! * **Thread sin estado de ejecución.** El Thread es la conversación de la Task; ninguna lectura del estado del
//!   Attempt sale de aquí. Su `summary` nunca guarda algo con forma de secreto.
//! * **Estado + evento juntos**, inerte hasta el corte, marcas de tiempo de quien llama: como `store::attempts`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: solo lo usan `orch::session_ops` y las pruebas

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::attempts::{attempt_in, attempts_where, link_provider_session_in, AttemptRow};
use super::error::{StoreError, StoreResult};
use super::events::NewEvent;
use super::projects::ChangeOutcome;
use super::tasks::{insert_all, require_active, task_in, TaskIntent, TaskOrigin, TaskRow};
use super::Store;

/// Máximo de caracteres de la referencia opaca del proveedor.
pub const MAX_EXTERNAL_REF_CHARS: usize = 1024;
/// Máximo de caracteres del resumen de un Thread.
pub const MAX_THREAD_SUMMARY_CHARS: usize = 2000;

/// Estado de una ProviderSession.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    /// Un Attempt la está usando.
    Open,
    /// Ningún Attempt la usa y se puede reanudar (solo si es resumible).
    Idle,
    /// Final: no se reanuda.
    Closed,
}

impl SessionStatus {
    pub const ALL: [SessionStatus; 3] = [SessionStatus::Open, SessionStatus::Idle, SessionStatus::Closed];

    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Open => "open",
            SessionStatus::Idle => "idle",
            SessionStatus::Closed => "closed",
        }
    }

    /// Para los mensajes de error.
    fn label(self) -> &'static str {
        match self {
            SessionStatus::Open => "abierta",
            SessionStatus::Idle => "en espera",
            SessionStatus::Closed => "cerrada",
        }
    }

    pub fn parse(s: &str) -> StoreResult<SessionStatus> {
        SessionStatus::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidSession(format!("estado de sesión desconocido: {s}")))
    }
}

/// Cómo declaró el proveedor la referencia. No existe `cwd_time`: una carpeta y una hora no son un vínculo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionBinding {
    /// Claude con `--output-format stream-json`: el id llega en el flujo.
    StreamJson,
    /// El proveedor devolvió un id de sesión explícito.
    SessionId,
}

impl SessionBinding {
    pub const ALL: [SessionBinding; 2] = [SessionBinding::StreamJson, SessionBinding::SessionId];

    pub fn as_str(self) -> &'static str {
        match self {
            SessionBinding::StreamJson => "stream_json",
            SessionBinding::SessionId => "session_id",
        }
    }

    pub fn parse(s: &str) -> StoreResult<SessionBinding> {
        SessionBinding::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidSession(format!("vínculo de sesión desconocido: {s}")))
    }
}

/// Transición del ciclo de vida que no enlaza un Attempt (reanudar es [`Store::provider_session_resume_recorded`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStep {
    /// `open -> idle`: el Attempt que la usaba terminó y la sesión queda para un seguimiento.
    Detach,
    /// `idle -> open`: un Attempt nuevo de la misma Task la reanuda.
    Resume,
    /// `open | idle -> closed`: final.
    Close,
}

impl SessionStep {
    pub const ALL: [SessionStep; 3] = [SessionStep::Detach, SessionStep::Resume, SessionStep::Close];

    pub fn to(self) -> SessionStatus {
        match self {
            SessionStep::Detach => SessionStatus::Idle,
            SessionStep::Resume => SessionStatus::Open,
            SessionStep::Close => SessionStatus::Closed,
        }
    }

    pub fn from_states(self) -> &'static [SessionStatus] {
        match self {
            SessionStep::Detach => &[SessionStatus::Open],
            SessionStep::Resume => &[SessionStatus::Idle],
            SessionStep::Close => &[SessionStatus::Open, SessionStatus::Idle],
        }
    }
}

/// ¿Admite el ciclo de vida de la sesión pasar de `from` a `to`?
pub fn session_transition_allowed(from: SessionStatus, to: SessionStatus) -> bool {
    SessionStep::ALL.iter().any(|s| s.to() == to && s.from_states().contains(&from))
}

/// Una ProviderSession tal como está en la base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProviderSessionRow {
    /// `ps-<attempt que la abrió>`.
    pub id: String,
    /// Dueña: la Task (ADR §5).
    pub task_id: String,
    pub opened_by_attempt_id: String,
    pub provider: String,
    /// Referencia opaca del proveedor; `None` hasta que el adapter la entregue.
    pub external_ref: Option<String>,
    pub binding: Option<SessionBinding>,
    /// El proveedor admite reanudarla.
    pub resumable: bool,
    pub status: SessionStatus,
    pub created_at: i64,
    pub updated_at: i64,
    pub closed_at: Option<i64>,
    pub origin: TaskOrigin,
}

/// Qué sesión abre un Attempt. La referencia puede llegar después ([`Store::provider_session_bind_recorded`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewProviderSession {
    pub resumable: bool,
    pub external_ref: Option<(String, SessionBinding)>,
}

/// Un Thread: la conversación de coordinación de una Task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadRow {
    /// `th-<task>`.
    pub id: String,
    pub task_id: String,
    pub run_id: String,
    /// Metadato corto para un resumen futuro. Nunca un secreto.
    pub summary: Option<String>,
    /// `None` en las filas del legado (el documento no las fechaba).
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub origin: TaskOrigin,
}

/// Un mensaje del Thread (lo copia el corte; los nuevos los escribirá el runtime).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadMessageRow {
    pub id: i64,
    pub thread_id: String,
    pub from_task_id: String,
    pub to_task_id: String,
    /// `None` en legacy: no se atribuye (ADR D6).
    pub from_attempt_id: Option<String>,
    pub kind: String,
    pub body: String,
    pub reply_to: Option<i64>,
    pub read: bool,
    pub at: i64,
}

const SESSION_COLS: &str = "id, task_id, opened_by_attempt_id, provider, external_ref, binding, resumable, status, created_at, updated_at, closed_at, origin";
const THREAD_COLS: &str = "id, task_id, run_id, summary, created_at, updated_at, origin";
const MESSAGE_COLS: &str = "id, thread_id, from_task_id, to_task_id, from_attempt_id, kind, body, reply_to, read, at";

fn session_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(ProviderSessionRow, Option<String>, String, String)> {
    let resumable: i64 = r.get(6)?;
    Ok((
        ProviderSessionRow {
            id: r.get(0)?,
            task_id: r.get(1)?,
            opened_by_attempt_id: r.get(2)?,
            provider: r.get(3)?,
            external_ref: r.get(4)?,
            binding: None,
            resumable: resumable == 1,
            status: SessionStatus::Open,
            created_at: r.get(8)?,
            updated_at: r.get(9)?,
            closed_at: r.get(10)?,
            origin: TaskOrigin::Core,
        },
        r.get(5)?,
        r.get(7)?,
        r.get(11)?,
    ))
}

fn finish_session((mut s, binding, status, origin): (ProviderSessionRow, Option<String>, String, String)) -> StoreResult<ProviderSessionRow> {
    s.binding = binding.as_deref().map(SessionBinding::parse).transpose()?;
    s.status = SessionStatus::parse(&status)?;
    s.origin = TaskOrigin::parse(&origin)?;
    Ok(s)
}

fn session_in(c: &Connection, id: &str) -> StoreResult<Option<ProviderSessionRow>> {
    c.query_row(&format!("SELECT {SESSION_COLS} FROM provider_sessions WHERE id = ?1"), [id], session_from_row).optional()?.map(finish_session).transpose()
}

fn thread_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(ThreadRow, String)> {
    Ok((
        ThreadRow { id: r.get(0)?, task_id: r.get(1)?, run_id: r.get(2)?, summary: r.get(3)?, created_at: r.get(4)?, updated_at: r.get(5)?, origin: TaskOrigin::Core },
        r.get(6)?,
    ))
}

fn thread_where(c: &Connection, filter: &str, arg: &str) -> StoreResult<Option<ThreadRow>> {
    let raw = c.query_row(&format!("SELECT {THREAD_COLS} FROM threads WHERE {filter}"), [arg], thread_from_row).optional()?;
    raw.map(|(mut t, origin)| {
        t.origin = TaskOrigin::parse(&origin)?;
        Ok(t)
    })
    .transpose()
}

fn message_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadMessageRow> {
    let read: i64 = r.get(8)?;
    Ok(ThreadMessageRow {
        id: r.get(0)?,
        thread_id: r.get(1)?,
        from_task_id: r.get(2)?,
        to_task_id: r.get(3)?,
        from_attempt_id: r.get(4)?,
        kind: r.get(5)?,
        body: r.get(6)?,
        reply_to: r.get(7)?,
        read: read == 1,
        at: r.get(9)?,
    })
}

fn messages_where(c: &Connection, filter: &str, arg: &str) -> StoreResult<Vec<ThreadMessageRow>> {
    let sql = format!("SELECT {MESSAGE_COLS} FROM thread_messages WHERE {filter} ORDER BY id");
    Ok(c.prepare(&sql)?.query_map([arg], message_from_row)?.collect::<Result<Vec<_>, _>>()?)
}

/// ¿Tiene forma de credencial? Prefijos de tokens conocidos, cabeceras de autorización, claves privadas y
/// asignaciones `clave=valor` de secretos. Es una red de seguridad, no un detector completo: lo que se guarda en
/// estos campos son ids opacos y resúmenes cortos.
pub(crate) fn looks_secret(s: &str) -> bool {
    const PREFIXES: [&str; 12] = ["sk-", "ghp_", "gho_", "ghs_", "ghu_", "github_pat_", "xoxb-", "xoxp-", "glpat-", "akia", "aiza", "lxb_"];
    const MARKERS: [&str; 8] = ["-----begin", "bearer ", "authorization:", "api_key", "apikey", "password=", "token=", "secret="];
    let lower = s.to_ascii_lowercase();
    if MARKERS.iter().any(|m| lower.contains(m)) {
        return true;
    }
    lower.split(|c: char| c.is_whitespace() || "\"'`,;()[]{}<>".contains(c)).any(|w| PREFIXES.iter().any(|p| w.starts_with(p) && w.len() >= p.len() + 8))
}

fn check_external_ref(r: &str) -> StoreResult<()> {
    let ok = !r.trim().is_empty() && r.chars().count() <= MAX_EXTERNAL_REF_CHARS && !r.chars().any(char::is_control);
    if !ok {
        return Err(StoreError::InvalidSession(format!("la referencia del proveedor es texto opaco de 1 a {MAX_EXTERNAL_REF_CHARS} caracteres sin control")));
    }
    if looks_secret(r) {
        return Err(StoreError::InvalidSession("la referencia del proveedor tiene forma de credencial: una sesión no guarda tokens".into()));
    }
    Ok(())
}

fn check_summary(summary: &str) -> StoreResult<()> {
    if summary.trim().is_empty() || summary.chars().count() > MAX_THREAD_SUMMARY_CHARS {
        return Err(StoreError::InvalidSession(format!("el resumen de un Thread tiene de 1 a {MAX_THREAD_SUMMARY_CHARS} caracteres")));
    }
    if looks_secret(summary) {
        return Err(StoreError::InvalidSession("el resumen del Thread tiene forma de credencial: no se guarda".into()));
    }
    Ok(())
}

fn check_event(kind: &str, id: &str, t: &TaskRow, e: &NewEvent) -> StoreResult<()> {
    if e.entity_kind != kind || e.entity_id != id || e.run_id.as_deref() != Some(t.run_id.as_str()) || e.project_id != t.project_id {
        return Err(StoreError::InvalidEvent(format!("{}: el evento no se refiere a {kind} {id}", e.kind)));
    }
    e.check()
}

fn insert_event(tx: &rusqlite::Transaction<'_>, e: &NewEvent, projector: Option<&dyn super::events::EventProjector>) -> StoreResult<()> {
    insert_all(tx, std::slice::from_ref(e), projector).map_err(|err| match err {
        StoreError::TaskConflict(m) => StoreError::SessionConflict(m),
        otro => otro,
    })
}

fn task_for(tx: &Connection, task_id: &str) -> StoreResult<TaskRow> {
    task_in(tx, task_id)?.ok_or_else(|| StoreError::SessionConflict(format!("no existe la Task {task_id}")))
}

/// Un Attempt que puede usar una sesión: existe, no ha terminado y aún no tiene ninguna.
fn attempt_ready(tx: &Connection, attempt_id: &str) -> StoreResult<AttemptRow> {
    let a = attempt_in(tx, attempt_id)?.ok_or_else(|| StoreError::SessionConflict(format!("no existe el Attempt {attempt_id}")))?;
    if a.status.is_final() {
        return Err(StoreError::SessionConflict(format!("el Attempt {attempt_id} ya terminó: no abre ni reanuda sesiones")));
    }
    if let Some(ps) = &a.provider_session_id {
        return Err(StoreError::SessionConflict(format!("el Attempt {attempt_id} ya corre en la sesión {ps}")));
    }
    Ok(a)
}

/// ¿Algún Attempt activo corre en esta sesión?
fn session_in_use(tx: &Connection, id: &str) -> StoreResult<Option<String>> {
    Ok(tx
        .query_row("SELECT id FROM attempts WHERE provider_session_id = ?1 AND status NOT IN ('done', 'failed', 'stopped', 'exited') ORDER BY n DESC LIMIT 1", [id], |r| r.get(0))
        .optional()?)
}

impl Store {
    /// El Attempt `attempt_id` abre su sesión del proveedor (`ps-<attempt>`, `open`) y queda enlazado a ella, con su
    /// evento, en UNA transacción. Un Attempt terminado o que ya tiene sesión es [`StoreError::SessionConflict`].
    pub fn provider_session_open_recorded(
        &mut self,
        attempt_id: &str,
        new: &NewProviderSession,
        at: i64,
        event: impl FnOnce(&ProviderSessionRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ProviderSessionRow> {
        if let Some((r, _)) = &new.external_ref {
            check_external_ref(r)?;
        }
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let attempt = attempt_ready(tx, attempt_id)?;
            let task = task_for(tx, &attempt.task_id)?;
            let id = format!("ps-{attempt_id}");
            let (external_ref, binding) = match &new.external_ref {
                Some((r, b)) => (Some(r.as_str()), Some(b.as_str())),
                None => (None, None),
            };
            tx.execute(
                "INSERT INTO provider_sessions (id, task_id, opened_by_attempt_id, provider, external_ref, binding, resumable, status, created_at, updated_at, origin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open', ?8, ?8, 'core')",
                params![id, attempt.task_id, attempt_id, attempt.provider, external_ref, binding, new.resumable as i64, at],
            )
            .map_err(|e| unique_ref(e, &attempt.provider))?;
            link_provider_session_in(tx, attempt_id, &id)?;
            let session = session_in(tx, &id)?.ok_or_else(|| StoreError::SessionConflict(format!("la sesión recién creada {id} no existe")))?;
            let attempt = attempt_in(tx, attempt_id)?.ok_or_else(|| StoreError::SessionConflict(format!("el Attempt {attempt_id} desapareció")))?;
            let e = event(&session, &attempt, &task)?;
            check_event("provider_session", &session.id, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(session)
        })
    }

    /// El adapter entrega la referencia opaca de la sesión. Se fija UNA vez: repetir la misma es `Unchanged`; otra
    /// distinta, o una sesión cerrada, es [`StoreError::SessionConflict`].
    pub fn provider_session_bind_recorded(
        &mut self,
        id: &str,
        external_ref: &str,
        binding: SessionBinding,
        at: i64,
        event: impl FnOnce(&ProviderSessionRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ChangeOutcome> {
        check_external_ref(external_ref)?;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(current) = session_in(tx, id)? else { return Ok(ChangeOutcome::Missing) };
            if current.external_ref.as_deref() == Some(external_ref) && current.binding == Some(binding) {
                return Ok(ChangeOutcome::Unchanged);
            }
            if current.external_ref.is_some() {
                return Err(StoreError::SessionConflict(format!("la sesión {id} ya tiene su referencia del proveedor: no cambia")));
            }
            if current.status == SessionStatus::Closed {
                return Err(StoreError::SessionConflict(format!("la sesión {id} está cerrada")));
            }
            tx.execute(
                "UPDATE provider_sessions SET external_ref = ?2, binding = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, external_ref, binding.as_str(), at.max(current.updated_at)],
            )
            .map_err(|e| unique_ref(e, &current.provider))?;
            let session = session_in(tx, id)?.ok_or_else(|| StoreError::SessionConflict(format!("la sesión {id} desapareció")))?;
            let task = task_for(tx, &session.task_id)?;
            let e = event(&session, &task)?;
            check_event("provider_session", id, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    /// Un Attempt nuevo de la misma Task y el mismo proveedor reanuda la sesión `idle` (`idle -> open`) y queda
    /// enlazado a ella (ADR D7). Si ese Attempt ya corre en ella, `Unchanged`.
    pub fn provider_session_resume_recorded(
        &mut self,
        id: &str,
        attempt_id: &str,
        at: i64,
        event: impl FnOnce(&ProviderSessionRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ChangeOutcome> {
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(current) = session_in(tx, id)? else { return Ok(ChangeOutcome::Missing) };
            if current.status == SessionStatus::Open && attempt_in(tx, attempt_id)?.is_some_and(|a| a.provider_session_id.as_deref() == Some(id)) {
                return Ok(ChangeOutcome::Unchanged);
            }
            if current.status != SessionStatus::Idle {
                return Err(StoreError::SessionConflict(format!("la sesión {id} está {}: solo se reanuda una sesión en espera", current.status.label())));
            }
            let attempt = attempt_ready(tx, attempt_id)?;
            if attempt.task_id != current.task_id || attempt.provider != current.provider {
                return Err(StoreError::SessionConflict(format!("el Attempt {attempt_id} no es de la Task y el proveedor de la sesión {id}")));
            }
            tx.execute("UPDATE provider_sessions SET status = 'open', updated_at = ?2 WHERE id = ?1", params![id, at.max(current.updated_at)])?;
            link_provider_session_in(tx, attempt_id, id)?;
            let session = session_in(tx, id)?.ok_or_else(|| StoreError::SessionConflict(format!("la sesión {id} desapareció")))?;
            let attempt = attempt_in(tx, attempt_id)?.ok_or_else(|| StoreError::SessionConflict(format!("el Attempt {attempt_id} desapareció")))?;
            let task = task_for(tx, &session.task_id)?;
            let e = event(&session, &attempt, &task)?;
            check_event("provider_session", id, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    /// `Detach` (`open -> idle`, solo resumible y sin Attempt activo dentro) o `Close` (final). Pedir el estado en el
    /// que ya está es `Unchanged`; cualquier otro par, [`StoreError::SessionConflict`] sin escribir nada.
    pub fn provider_session_transition_recorded(
        &mut self,
        id: &str,
        step: SessionStep,
        at: i64,
        event: impl FnOnce(&ProviderSessionRow, SessionStatus, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ChangeOutcome> {
        if step == SessionStep::Resume {
            return Err(StoreError::SessionConflict("reanudar una sesión enlaza un Attempt: usa provider_session_resume_recorded".into()));
        }
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(current) = session_in(tx, id)? else { return Ok(ChangeOutcome::Missing) };
            let target = step.to();
            if current.status == target {
                return Ok(ChangeOutcome::Unchanged);
            }
            if !session_transition_allowed(current.status, target) {
                return Err(StoreError::SessionConflict(format!("la sesión {id} no puede pasar de {} a {}", current.status.as_str(), target.as_str())));
            }
            if step == SessionStep::Detach {
                if !current.resumable {
                    return Err(StoreError::SessionConflict(format!("la sesión {id} no es resumible: se cierra, no queda en espera")));
                }
                if let Some(a) = session_in_use(tx, id)? {
                    return Err(StoreError::SessionConflict(format!("el Attempt {a} sigue corriendo en la sesión {id}")));
                }
            }
            let stamp = at.max(current.updated_at);
            let closed_at = (target == SessionStatus::Closed).then_some(stamp);
            tx.execute("UPDATE provider_sessions SET status = ?2, updated_at = ?3, closed_at = ?4 WHERE id = ?1", params![id, target.as_str(), stamp, closed_at])?;
            let session = session_in(tx, id)?.ok_or_else(|| StoreError::SessionConflict(format!("la sesión {id} desapareció")))?;
            let task = task_for(tx, &session.task_id)?;
            let e = event(&session, current.status, &task)?;
            check_event("provider_session", id, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    /// Nace el Thread de la Task (`th-<task>`). La Task tiene que estar abierta y no tener ya uno.
    pub fn thread_open_recorded(&mut self, task_id: &str, at: i64, event: impl FnOnce(&ThreadRow, &TaskRow) -> StoreResult<NewEvent>) -> StoreResult<ThreadRow> {
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let task = task_for(tx, task_id)?;
            if task.intent == TaskIntent::Discarded {
                return Err(StoreError::SessionConflict(format!("la Task {task_id} está descartada: no abre un Thread")));
            }
            if thread_where(tx, "task_id = ?1", task_id)?.is_some() {
                return Err(StoreError::SessionConflict(format!("la Task {task_id} ya tiene su Thread")));
            }
            let id = format!("th-{task_id}");
            tx.execute(
                "INSERT INTO threads (id, task_id, run_id, created_at, updated_at, origin) VALUES (?1, ?2, ?3, ?4, ?4, 'core')",
                params![id, task_id, task.run_id, at],
            )?;
            let thread = thread_where(tx, "id = ?1", &id)?.ok_or_else(|| StoreError::SessionConflict(format!("el Thread recién creado {id} no existe")))?;
            let e = event(&thread, &task)?;
            check_event("thread", &id, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(thread)
        })
    }

    /// Fija o borra (`None`) el resumen del Thread. Un resumen con forma de credencial se rechaza sin escribir nada.
    pub fn thread_summary_set_recorded(
        &mut self,
        id: &str,
        summary: Option<&str>,
        at: i64,
        event: impl FnOnce(&ThreadRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ChangeOutcome> {
        if let Some(s) = summary {
            check_summary(s)?;
        }
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(current) = thread_where(tx, "id = ?1", id)? else { return Ok(ChangeOutcome::Missing) };
            if current.summary.as_deref() == summary {
                return Ok(ChangeOutcome::Unchanged);
            }
            let stamp = current.updated_at.map_or(at, |u| at.max(u));
            tx.execute("UPDATE threads SET summary = ?2, updated_at = ?3 WHERE id = ?1", params![id, summary, stamp])?;
            let thread = thread_where(tx, "id = ?1", id)?.ok_or_else(|| StoreError::SessionConflict(format!("el Thread {id} desapareció")))?;
            let task = task_for(tx, &thread.task_id)?;
            let e = event(&thread, &task)?;
            check_event("thread", id, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    pub fn provider_session_row(&self, id: &str) -> StoreResult<Option<ProviderSessionRow>> {
        self.read(|c| session_in(c, id))
    }

    /// La sesión en la que corre (o corrió) un Attempt. `None`: el Attempt no tiene sesión, o no existe.
    pub fn provider_session_of_attempt(&self, attempt_id: &str) -> StoreResult<Option<ProviderSessionRow>> {
        self.read(|c| match attempt_in(c, attempt_id)?.and_then(|a| a.provider_session_id) {
            Some(ps) => session_in(c, &ps),
            None => Ok(None),
        })
    }

    /// Las sesiones de una Task, por creación.
    pub fn provider_sessions_of_task(&self, task_id: &str) -> StoreResult<Vec<ProviderSessionRow>> {
        self.read(|c| {
            let rows = c.prepare(&format!("SELECT {SESSION_COLS} FROM provider_sessions WHERE task_id = ?1 ORDER BY created_at, id"))?.query_map([task_id], session_from_row)?.collect::<Result<Vec<_>, _>>()?;
            rows.into_iter().map(finish_session).collect()
        })
    }

    /// Los Attempts que han corrido en una sesión (el que la abrió y los que la reanudaron), por número.
    pub fn attempts_of_provider_session(&self, id: &str) -> StoreResult<Vec<AttemptRow>> {
        self.read(|c| attempts_where(c, "provider_session_id = ?1", id))
    }

    pub fn thread_row(&self, id: &str) -> StoreResult<Option<ThreadRow>> {
        self.read(|c| thread_where(c, "id = ?1", id))
    }

    pub fn thread_of_task(&self, task_id: &str) -> StoreResult<Option<ThreadRow>> {
        self.read(|c| thread_where(c, "task_id = ?1", task_id))
    }

    /// El Thread en el que habla un Attempt: el de su Task.
    pub fn thread_of_attempt(&self, attempt_id: &str) -> StoreResult<Option<ThreadRow>> {
        self.read(|c| match attempt_in(c, attempt_id)? {
            Some(a) => thread_where(c, "task_id = ?1", &a.task_id),
            None => Ok(None),
        })
    }

    pub fn thread_messages(&self, thread_id: &str) -> StoreResult<Vec<ThreadMessageRow>> {
        self.read(|c| messages_where(c, "thread_id = ?1", thread_id))
    }

    /// Los mensajes que envió un Attempt (los del legado no están atribuidos: ADR D6).
    pub fn thread_messages_of_attempt(&self, attempt_id: &str) -> StoreResult<Vec<ThreadMessageRow>> {
        self.read(|c| messages_where(c, "from_attempt_id = ?1", attempt_id))
    }
}

/// Una referencia que ya es de otra sesión del mismo proveedor es un conflicto, no un error de la base.
fn unique_ref(e: rusqlite::Error, provider: &str) -> StoreError {
    match &e {
        rusqlite::Error::SqliteFailure(f, Some(m)) if f.code == rusqlite::ErrorCode::ConstraintViolation && m.contains("external_ref") => {
            StoreError::SessionConflict(format!("esa referencia ya es de otra sesión de {provider}"))
        }
        _ => e.into(),
    }
}
