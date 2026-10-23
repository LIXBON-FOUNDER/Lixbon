//! Worktree y Artifact como entidades de ejecución (LXO-116, épica F3): lado del **almacén**. Contrato:
//! `docs/core/WORKTREES_ARTIFACTS.md`.
//!
//! Solo sabe guardar y leer las filas de `worktrees` y `artifacts` (migración `010_worktrees_artifacts`). Los eventos
//! llegan de `orch::worktree_ops`; la dirección sigue siendo `orch -> store`.
//!
//! # Garantías
//! * **La ruta no es identidad.** El id es `wt-<attempt>`; `machine` + `path` son su ubicación y se pierden al quitarlo.
//! * **Procedencia explícita.** `created` · `adopted` · `external`, fijada al registrarlo; uno externo nunca se limpia
//!   por integración ni descarte.
//! * **Quitar exige motivo** ([`RemovalReason`]) y que ningún Attempt activo lo use. El almacén solo registra el hecho:
//!   borrar la carpeta o la rama es del runtime.
//! * **El Artifact apunta, no copia.** Tipo cerrado, localizador validado por tipo, `sha256`/`bytes` opcionales y nada
//!   con forma de credencial. Inmutable.
//! * **Estado + evento juntos**, inerte hasta el corte, marcas de tiempo de quien llama: como `store::attempts`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: solo lo usan `orch::worktree_ops` y las pruebas

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::attempts::{attempt_in, attempts_where, link_worktree_in, AttemptRow, AttemptStatus};
use super::error::{StoreError, StoreResult};
use super::events::NewEvent;
use super::projects::ChangeOutcome;
use super::sessions::looks_secret;
use super::tasks::{insert_all, require_active, task_in, TaskOrigin, TaskRow};
use super::{new_uuid_v7, Store};

const MAX_PATH_CHARS: usize = 1024;
const MAX_URI_CHARS: usize = 2048;

/// Quién trajo el Worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    /// Lo creó Lixbon (`git worktree add`).
    Created,
    /// Existía y pasó a gestionarlo Lixbon.
    Adopted,
    /// Lixbon lo usa pero no es suyo: nunca lo limpia.
    External,
}

impl Provenance {
    pub const ALL: [Provenance; 3] = [Provenance::Created, Provenance::Adopted, Provenance::External];

    pub fn as_str(self) -> &'static str {
        match self {
            Provenance::Created => "created",
            Provenance::Adopted => "adopted",
            Provenance::External => "external",
        }
    }

    fn parse(s: &str) -> StoreResult<Provenance> {
        Provenance::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidWorktree(format!("procedencia desconocida: {s}")))
    }
}

/// Estado de un Worktree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeState {
    Active,
    /// Registrado, pero la carpeta no está en disco.
    Missing,
    /// Final: ya no es una ubicación de trabajo.
    Removed,
}

impl WorktreeState {
    pub const ALL: [WorktreeState; 3] = [WorktreeState::Active, WorktreeState::Missing, WorktreeState::Removed];

    pub fn as_str(self) -> &'static str {
        match self {
            WorktreeState::Active => "active",
            WorktreeState::Missing => "missing",
            WorktreeState::Removed => "removed",
        }
    }

    fn parse(s: &str) -> StoreResult<WorktreeState> {
        WorktreeState::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidWorktree(format!("estado de worktree desconocido: {s}")))
    }
}

/// Por qué se quita un Worktree. Ninguno borra trabajo sin integrar sin que lo confirme una persona.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemovalReason {
    /// Su trabajo ya está integrado (lo afirma el Core tras integrar).
    Integrated,
    /// Una persona confirmó descartarlo.
    Discarded,
    /// Ya no existía en disco (solo desde `missing`).
    Gone,
}

impl RemovalReason {
    pub const ALL: [RemovalReason; 3] = [RemovalReason::Integrated, RemovalReason::Discarded, RemovalReason::Gone];

    pub fn as_str(self) -> &'static str {
        match self {
            RemovalReason::Integrated => "integrated",
            RemovalReason::Discarded => "discarded",
            RemovalReason::Gone => "gone",
        }
    }

    fn parse(s: &str) -> StoreResult<RemovalReason> {
        RemovalReason::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidWorktree(format!("motivo desconocido: {s}")))
    }
}

/// Transición del ciclo de vida del Worktree. La tabla `(de, a)` es la del trigger `worktrees_lifecycle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeStep {
    /// `active -> missing`: la carpeta no está.
    Lost,
    /// `missing -> active`: volvió a estar.
    Found,
    /// `active | missing -> removed`: final.
    Remove { reason: RemovalReason, branch_kept: bool },
}

impl WorktreeStep {
    pub fn to(self) -> WorktreeState {
        match self {
            WorktreeStep::Lost => WorktreeState::Missing,
            WorktreeStep::Found => WorktreeState::Active,
            WorktreeStep::Remove { .. } => WorktreeState::Removed,
        }
    }

    pub fn from_states(self) -> &'static [WorktreeState] {
        match self {
            WorktreeStep::Lost => &[WorktreeState::Active],
            WorktreeStep::Found => &[WorktreeState::Missing],
            WorktreeStep::Remove { .. } => &[WorktreeState::Active, WorktreeState::Missing],
        }
    }
}

/// ¿Admite el ciclo de vida del Worktree pasar de `from` a `to`?
pub fn worktree_transition_allowed(from: WorktreeState, to: WorktreeState) -> bool {
    use WorktreeState::*;
    matches!((from, to), (Active, Missing) | (Missing, Active) | (Active, Removed) | (Missing, Removed))
}

/// Un Worktree tal como está en la base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorktreeRow {
    /// `wt-<attempt que lo registró>`.
    pub id: String,
    /// Dueña: la Task (ADR §5).
    pub task_id: String,
    pub attempt_id: String,
    pub provenance: Provenance,
    /// Ubicación: máquina y ruta. `None` en el legado (máquina) o una vez quitado (ruta).
    pub machine: Option<String>,
    pub repo: String,
    pub path: Option<String>,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub base_commit: Option<String>,
    pub state: WorktreeState,
    pub removed_reason: Option<RemovalReason>,
    pub branch_kept: bool,
    pub missing_since: Option<i64>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub origin: TaskOrigin,
}

/// Qué Worktree registra un Attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewWorktree {
    pub provenance: Provenance,
    pub machine: String,
    pub repo: String,
    pub path: String,
    pub branch: Option<String>,
    pub base_branch: Option<String>,
    pub base_commit: Option<String>,
}

/// Tipo de Artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    /// El informe del Attempt (ruta local).
    Report,
    /// La PR que abrió (URL `https://`).
    PullRequest,
    /// El último mensaje del proveedor (ruta local).
    LastMessage,
    /// Un commit (sha hexadecimal).
    Commit,
    /// Cualquier otro archivo de evidencia (ruta local).
    File,
}

impl ArtifactKind {
    pub const ALL: [ArtifactKind; 5] = [ArtifactKind::Report, ArtifactKind::PullRequest, ArtifactKind::LastMessage, ArtifactKind::Commit, ArtifactKind::File];

    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactKind::Report => "report",
            ArtifactKind::PullRequest => "pull_request",
            ArtifactKind::LastMessage => "last_message",
            ArtifactKind::Commit => "commit",
            ArtifactKind::File => "file",
        }
    }

    fn parse(s: &str) -> StoreResult<ArtifactKind> {
        ArtifactKind::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidWorktree(format!("tipo de artifact desconocido: {s}")))
    }
}

/// Un Artifact tal como está en la base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtifactRow {
    pub id: String,
    pub attempt_id: String,
    pub kind: ArtifactKind,
    /// Dónde está la evidencia: ruta local, URL o sha. Nunca el contenido.
    pub uri: String,
    pub sha256: Option<String>,
    pub bytes: Option<i64>,
    pub created_at: Option<i64>,
    pub origin: TaskOrigin,
}

/// Qué deja un Attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewArtifact {
    pub kind: ArtifactKind,
    pub uri: String,
    pub sha256: Option<String>,
    pub bytes: Option<i64>,
}

const WORKTREE_COLS: &str = "id, task_id, attempt_id, provenance, machine, repo, path, branch, base_branch, base_commit, state, removed_reason, branch_kept, missing_since, \
                             created_at, updated_at, origin";
const ARTIFACT_COLS: &str = "id, attempt_id, kind, uri, sha256, bytes, created_at, origin";

type RawWorktree = (WorktreeRow, String, String, Option<String>, String);

fn worktree_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawWorktree> {
    let kept: i64 = r.get(12)?;
    Ok((
        WorktreeRow {
            id: r.get(0)?,
            task_id: r.get(1)?,
            attempt_id: r.get(2)?,
            provenance: Provenance::Created,
            machine: r.get(4)?,
            repo: r.get(5)?,
            path: r.get(6)?,
            branch: r.get(7)?,
            base_branch: r.get(8)?,
            base_commit: r.get(9)?,
            state: WorktreeState::Active,
            removed_reason: None,
            branch_kept: kept == 1,
            missing_since: r.get(13)?,
            created_at: r.get(14)?,
            updated_at: r.get(15)?,
            origin: TaskOrigin::Core,
        },
        r.get(3)?,
        r.get(10)?,
        r.get(11)?,
        r.get(16)?,
    ))
}

fn finish_worktree((mut w, provenance, state, reason, origin): RawWorktree) -> StoreResult<WorktreeRow> {
    w.provenance = Provenance::parse(&provenance)?;
    w.state = WorktreeState::parse(&state)?;
    w.removed_reason = reason.as_deref().map(RemovalReason::parse).transpose()?;
    w.origin = TaskOrigin::parse(&origin)?;
    Ok(w)
}

fn worktrees_where(c: &Connection, filter: &str, arg: &str) -> StoreResult<Vec<WorktreeRow>> {
    let sql = format!("SELECT {WORKTREE_COLS} FROM worktrees WHERE {filter} ORDER BY created_at, id");
    let rows = c.prepare(&sql)?.query_map([arg], worktree_from_row)?.collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(finish_worktree).collect()
}

fn worktree_in(c: &Connection, id: &str) -> StoreResult<Option<WorktreeRow>> {
    Ok(worktrees_where(c, "id = ?1", id)?.pop())
}

fn artifact_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(ArtifactRow, String, String)> {
    Ok((
        ArtifactRow { id: r.get(0)?, attempt_id: r.get(1)?, kind: ArtifactKind::File, uri: r.get(3)?, sha256: r.get(4)?, bytes: r.get(5)?, created_at: r.get(6)?, origin: TaskOrigin::Core },
        r.get(2)?,
        r.get(7)?,
    ))
}

fn artifacts_where(c: &Connection, filter: &str, arg: &str) -> StoreResult<Vec<ArtifactRow>> {
    let sql = format!("SELECT {ARTIFACT_COLS} FROM artifacts WHERE {filter} ORDER BY created_at, id");
    let rows = c.prepare(&sql)?.query_map([arg], artifact_from_row)?.collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(mut a, kind, origin)| {
            a.kind = ArtifactKind::parse(&kind)?;
            a.origin = TaskOrigin::parse(&origin)?;
            Ok(a)
        })
        .collect()
}

fn bad(m: impl Into<String>) -> StoreError {
    StoreError::InvalidWorktree(m.into())
}

/// Texto local (máquina, ruta, rama): sin control, acotado y sin forma de credencial.
fn check_text(field: &str, v: &str, max: usize) -> StoreResult<()> {
    if v.trim().is_empty() || v.chars().count() > max || v.chars().any(char::is_control) {
        return Err(bad(format!("{field}: vacío, de más de {max} caracteres o con caracteres de control")));
    }
    if looks_secret(v) {
        return Err(bad(format!("{field}: tiene forma de credencial")));
    }
    Ok(())
}

fn check_new_worktree(n: &NewWorktree) -> StoreResult<()> {
    check_text("machine", &n.machine, 200)?;
    check_text("repo", &n.repo, MAX_PATH_CHARS)?;
    check_text("path", &n.path, MAX_PATH_CHARS)?;
    for (f, v) in [("branch", &n.branch), ("base_branch", &n.base_branch), ("base_commit", &n.base_commit)] {
        if let Some(v) = v {
            check_text(f, v, 255)?;
        }
    }
    Ok(())
}

fn is_hex(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// El localizador según el tipo: una ruta local, una URL `https://` sin credenciales o un sha.
fn check_artifact(n: &NewArtifact) -> StoreResult<()> {
    let u = n.uri.as_str();
    if u.trim().is_empty() || u.chars().count() > MAX_URI_CHARS || u.chars().any(|c| c.is_control()) {
        return Err(bad("el localizador está vacío, es demasiado largo o tiene caracteres de control"));
    }
    if looks_secret(u) {
        return Err(bad("el localizador tiene forma de credencial: un Artifact no guarda secretos"));
    }
    match n.kind {
        ArtifactKind::PullRequest => {
            let rest = u.strip_prefix("https://").ok_or_else(|| bad("una PR es una URL https://"))?;
            let host = rest.split('/').next().unwrap_or("");
            if host.is_empty() || host.contains('@') || u.contains(char::is_whitespace) {
                return Err(bad("la URL de la PR no lleva usuario ni contraseña, ni espacios"));
            }
        }
        ArtifactKind::Commit => {
            if !(7..=64).contains(&u.len()) || !is_hex(u) {
                return Err(bad("un commit es un sha hexadecimal en minúsculas de 7 a 64 caracteres"));
            }
        }
        ArtifactKind::Report | ArtifactKind::LastMessage | ArtifactKind::File => {
            if u.contains("://") {
                return Err(bad("este tipo de Artifact apunta a una ruta local, no a una URL"));
            }
            if u.split(['/', '\\']).any(|seg| seg == "..") {
                return Err(bad("la ruta del Artifact no sube de carpeta (`..`)"));
            }
        }
    }
    if let Some(h) = &n.sha256 {
        if h.len() != 64 || !is_hex(h) {
            return Err(bad("sha256: 64 caracteres hexadecimales en minúsculas"));
        }
    }
    if n.bytes.is_some_and(|b| b < 0) {
        return Err(bad("bytes no puede ser negativo"));
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
        StoreError::TaskConflict(m) => StoreError::WorktreeConflict(m),
        otro => otro,
    })
}

fn conflict(m: impl Into<String>) -> StoreError {
    StoreError::WorktreeConflict(m.into())
}

fn task_for(tx: &Connection, task_id: &str) -> StoreResult<TaskRow> {
    task_in(tx, task_id)?.ok_or_else(|| conflict(format!("no existe la Task {task_id}")))
}

/// Un Attempt que puede usar un Worktree: existe, no ha terminado y aún no tiene ninguno.
fn attempt_ready(tx: &Connection, attempt_id: &str) -> StoreResult<AttemptRow> {
    let a = attempt_in(tx, attempt_id)?.ok_or_else(|| conflict(format!("no existe el Attempt {attempt_id}")))?;
    if a.status.is_final() {
        return Err(conflict(format!("el Attempt {attempt_id} ya terminó")));
    }
    if let Some(w) = &a.worktree_id {
        return Err(conflict(format!("el Attempt {attempt_id} ya trabaja en {w}")));
    }
    Ok(a)
}

fn in_use(tx: &Connection, id: &str) -> StoreResult<Option<String>> {
    Ok(tx
        .query_row("SELECT id FROM attempts WHERE worktree_id = ?1 AND status NOT IN ('done', 'failed', 'stopped', 'exited') ORDER BY n DESC LIMIT 1", [id], |r| r.get(0))
        .optional()?)
}

/// Una ruta ya registrada como activa en la misma máquina es un conflicto, no un error de la base.
fn unique_path(e: rusqlite::Error) -> StoreError {
    match &e {
        rusqlite::Error::SqliteFailure(f, Some(m)) if f.code == rusqlite::ErrorCode::ConstraintViolation && m.contains("worktrees") && m.contains("path") => {
            conflict("esa carpeta ya es la ubicación de otro Worktree en esta máquina")
        }
        _ => e.into(),
    }
}

impl Store {
    /// El Attempt registra su Worktree (`wt-<attempt>`, `active`), creado, adoptado o externo, y queda enlazado a él,
    /// con su evento, en UNA transacción.
    pub fn worktree_register_recorded(
        &mut self,
        attempt_id: &str,
        new: &NewWorktree,
        at: i64,
        event: impl FnOnce(&WorktreeRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<WorktreeRow> {
        check_new_worktree(new)?;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let attempt = attempt_ready(tx, attempt_id)?;
            let task = task_for(tx, &attempt.task_id)?;
            let id = format!("wt-{attempt_id}");
            tx.execute(
                "INSERT INTO worktrees (id, task_id, attempt_id, provenance, machine, repo, path, branch, base_branch, base_commit, state, created_at, updated_at, origin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', ?11, ?11, 'core')",
                params![id, attempt.task_id, attempt_id, new.provenance.as_str(), new.machine, new.repo, new.path, new.branch, new.base_branch, new.base_commit, at],
            )
            .map_err(unique_path)?;
            link_worktree_in(tx, attempt_id, &id)?;
            let w = worktree_in(tx, &id)?.ok_or_else(|| conflict(format!("el Worktree recién creado {id} no existe")))?;
            let attempt = attempt_in(tx, attempt_id)?.ok_or_else(|| conflict(format!("el Attempt {attempt_id} desapareció")))?;
            let e = event(&w, &attempt, &task)?;
            check_event("worktree", &id, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(w)
        })
    }

    /// Un seguimiento de la misma Task trabaja en un Worktree ya registrado y activo (ADR D7). Si ya trabaja en él,
    /// `Unchanged`.
    pub fn worktree_attach_recorded(
        &mut self,
        id: &str,
        attempt_id: &str,
        at: i64,
        event: impl FnOnce(&WorktreeRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ChangeOutcome> {
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(current) = worktree_in(tx, id)? else { return Ok(ChangeOutcome::Missing) };
            if attempt_in(tx, attempt_id)?.is_some_and(|a| a.worktree_id.as_deref() == Some(id)) {
                return Ok(ChangeOutcome::Unchanged);
            }
            if current.state != WorktreeState::Active {
                return Err(conflict(format!("el Worktree {id} no está activo")));
            }
            let attempt = attempt_ready(tx, attempt_id)?;
            if attempt.task_id != current.task_id {
                return Err(conflict(format!("el Attempt {attempt_id} no es de la Task del Worktree {id}")));
            }
            if let Some(otro) = in_use(tx, id)? {
                return Err(conflict(format!("el Attempt {otro} sigue trabajando en {id}")));
            }
            link_worktree_in(tx, attempt_id, id)?;
            tx.execute("UPDATE worktrees SET updated_at = ?2 WHERE id = ?1", params![id, current.updated_at.map_or(at, |u| at.max(u))])?;
            let w = worktree_in(tx, id)?.ok_or_else(|| conflict(format!("el Worktree {id} desapareció")))?;
            let attempt = attempt_in(tx, attempt_id)?.ok_or_else(|| conflict(format!("el Attempt {attempt_id} desapareció")))?;
            let task = task_for(tx, &w.task_id)?;
            let e = event(&w, &attempt, &task)?;
            check_event("worktree", id, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    /// `Lost` / `Found` / `Remove`. Pedir el estado en el que ya está es `Unchanged`; el resto de pares fuera de la tabla,
    /// [`StoreError::WorktreeConflict`]. Quitar exige que ningún Attempt activo trabaje en él; `Gone` solo desde
    /// `missing`; uno externo solo sale con `Gone`.
    pub fn worktree_transition_recorded(
        &mut self,
        id: &str,
        step: WorktreeStep,
        at: i64,
        event: impl FnOnce(&WorktreeRow, WorktreeState, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ChangeOutcome> {
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(current) = worktree_in(tx, id)? else { return Ok(ChangeOutcome::Missing) };
            let target = step.to();
            if current.state == target {
                return Ok(ChangeOutcome::Unchanged);
            }
            if !worktree_transition_allowed(current.state, target) {
                return Err(conflict(format!("el Worktree {id} no puede pasar de {} a {}", current.state.as_str(), target.as_str())));
            }
            let stamp = current.updated_at.map_or(at, |u| at.max(u));
            match step {
                WorktreeStep::Lost => tx.execute("UPDATE worktrees SET state = 'missing', missing_since = ?2, updated_at = ?2 WHERE id = ?1", params![id, stamp])?,
                WorktreeStep::Found => tx.execute("UPDATE worktrees SET state = 'active', missing_since = NULL, updated_at = ?2 WHERE id = ?1", params![id, stamp])?,
                WorktreeStep::Remove { reason, branch_kept } => {
                    if reason == RemovalReason::Gone && current.state != WorktreeState::Missing {
                        return Err(conflict(format!("el Worktree {id} sigue en disco: «gone» solo vale si falta")));
                    }
                    if current.provenance == Provenance::External && reason != RemovalReason::Gone {
                        return Err(conflict(format!("el Worktree {id} es externo: Lixbon no lo limpia")));
                    }
                    if branch_kept && current.branch.is_none() {
                        return Err(conflict(format!("el Worktree {id} no tiene rama que conservar")));
                    }
                    if let Some(a) = in_use(tx, id)? {
                        return Err(conflict(format!("el Attempt {a} sigue trabajando en {id}: no se quita")));
                    }
                    tx.execute(
                        "UPDATE worktrees SET state = 'removed', path = NULL, missing_since = NULL, removed_reason = ?2, branch_kept = ?3, updated_at = ?4 WHERE id = ?1",
                        params![id, reason.as_str(), branch_kept as i64, stamp],
                    )?
                }
            };
            let w = worktree_in(tx, id)?.ok_or_else(|| conflict(format!("el Worktree {id} desapareció")))?;
            let task = task_for(tx, &w.task_id)?;
            let e = event(&w, current.state, &task)?;
            check_event("worktree", id, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    /// El Attempt deja un Artifact (id UUID v7). El localizador se valida por tipo; el contenido nunca se guarda.
    pub fn artifact_create_recorded(
        &mut self,
        attempt_id: &str,
        new: &NewArtifact,
        at: i64,
        event: impl FnOnce(&ArtifactRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ArtifactRow> {
        check_artifact(new)?;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let attempt = attempt_in(tx, attempt_id)?.ok_or_else(|| conflict(format!("no existe el Attempt {attempt_id}")))?;
            if matches!(attempt.status, AttemptStatus::PendingApproval | AttemptStatus::Starting) {
                return Err(conflict(format!("el Attempt {attempt_id} aún no arrancó: no deja Artifacts")));
            }
            let task = task_for(tx, &attempt.task_id)?;
            let id = new_uuid_v7();
            tx.execute(
                "INSERT INTO artifacts (id, attempt_id, kind, uri, sha256, bytes, created_at, origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'core')",
                params![id, attempt_id, new.kind.as_str(), new.uri, new.sha256, new.bytes, at],
            )?;
            let a = artifacts_where(tx, "id = ?1", &id)?.pop().ok_or_else(|| conflict(format!("el Artifact recién creado {id} no existe")))?;
            let e = event(&a, &attempt, &task)?;
            check_event("artifact", &id, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(a)
        })
    }

    pub fn worktree_row(&self, id: &str) -> StoreResult<Option<WorktreeRow>> {
        self.read(|c| worktree_in(c, id))
    }

    /// El Worktree en el que trabaja (o trabajó) un Attempt. `None`: no tiene, o no existe.
    pub fn worktree_of_attempt(&self, attempt_id: &str) -> StoreResult<Option<WorktreeRow>> {
        self.read(|c| match attempt_in(c, attempt_id)?.and_then(|a| a.worktree_id) {
            Some(w) => worktree_in(c, &w),
            None => Ok(None),
        })
    }

    pub fn worktrees_of_task(&self, task_id: &str) -> StoreResult<Vec<WorktreeRow>> {
        self.read(|c| worktrees_where(c, "task_id = ?1", task_id))
    }

    /// Los Worktrees de las Tasks de un Project.
    pub fn worktrees_of_project(&self, project_id: &str) -> StoreResult<Vec<WorktreeRow>> {
        self.read(|c| worktrees_where(c, "task_id IN (SELECT id FROM tasks WHERE project_id = ?1)", project_id))
    }

    /// Los Attempts que han trabajado en un Worktree, por número.
    pub fn attempts_of_worktree(&self, id: &str) -> StoreResult<Vec<AttemptRow>> {
        self.read(|c| attempts_where(c, "worktree_id = ?1", id))
    }

    pub fn artifacts_of_attempt(&self, attempt_id: &str) -> StoreResult<Vec<ArtifactRow>> {
        self.read(|c| artifacts_where(c, "attempt_id = ?1", attempt_id))
    }

    pub fn artifacts_of_task(&self, task_id: &str) -> StoreResult<Vec<ArtifactRow>> {
        self.read(|c| artifacts_where(c, "attempt_id IN (SELECT id FROM attempts WHERE task_id = ?1)", task_id))
    }

    pub fn artifacts_of_project(&self, project_id: &str) -> StoreResult<Vec<ArtifactRow>> {
        self.read(|c| artifacts_where(c, "attempt_id IN (SELECT a.id FROM attempts AS a JOIN tasks AS t ON t.id = a.task_id WHERE t.project_id = ?1)", project_id))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Runtime sobre las tablas (LXO-232): piezas sin evento propio. Las llama `store::runtime` dentro de la transacción de
// la mutación del runtime, cuyo hecho ya va en sus eventos. Este módulo sigue siendo el único que escribe worktrees y artifacts.
// ---------------------------------------------------------------------------------------------------------------------

/// Un Worktree que el lanzamiento acaba de crear (`created`), activo, registrado por el Attempt que lo usa.
pub(crate) struct RuntimeWorktree<'a> {
    pub id: &'a str,
    pub task_id: &'a str,
    pub attempt_id: &'a str,
    pub machine: &'a str,
    pub repo: &'a str,
    pub path: &'a str,
    pub branch: Option<&'a str>,
    pub base_branch: Option<&'a str>,
    pub base_commit: Option<&'a str>,
    pub env_plan: Option<&'a str>,
    pub at: i64,
}

pub(crate) fn runtime_worktree_insert_in(c: &Connection, w: &RuntimeWorktree<'_>) -> StoreResult<()> {
    require_active(c)?;
    c.execute(
        "INSERT INTO worktrees (id, task_id, attempt_id, provenance, machine, repo, path, branch, base_branch, base_commit, env_plan, state,
                                created_at, updated_at, origin)
         VALUES (?1, ?2, ?3, 'created', ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'active', ?11, ?11, 'core')",
        params![w.id, w.task_id, w.attempt_id, w.machine, w.repo, w.path, w.branch, w.base_branch, w.base_commit, w.env_plan, w.at],
    )?;
    Ok(())
}

/// Una rama y una base sin Worktree conocido (la carpeta ya no está y el runtime no sabe dónde ni en qué máquina estuvo):
/// la fila que el corte importa en ese caso, `legacy` y ya quitada, con la rama si se conserva.
pub(crate) fn runtime_worktree_insert_removed_in(c: &Connection, w: &RuntimeWorktree<'_>) -> StoreResult<()> {
    require_active(c)?;
    c.execute(
        "INSERT INTO worktrees (id, task_id, attempt_id, provenance, repo, path, branch, base_branch, base_commit, env_plan, state, branch_kept, origin)
         VALUES (?1, ?2, ?3, 'created', ?4, NULL, ?5, ?6, ?7, ?8, 'removed', ?9, 'legacy')",
        params![w.id, w.task_id, w.attempt_id, w.repo, w.branch, w.base_branch, w.base_commit, w.env_plan, w.branch.is_some() as i64],
    )?;
    Ok(())
}

/// Quitado al liberarlo: pierde la ruta y conserva la rama si `git branch -d` no la borró.
pub(crate) fn runtime_worktree_remove_in(c: &Connection, id: &str, reason: RemovalReason, branch_kept: bool, at: i64) -> StoreResult<()> {
    require_active(c)?;
    c.execute(
        "UPDATE worktrees SET state = 'removed', path = NULL, removed_reason = ?2, branch_kept = ?3, missing_since = NULL,
                              updated_at = max(coalesce(updated_at, ?4), ?4) WHERE id = ?1",
        params![id, reason.as_str(), branch_kept as i64, at],
    )?;
    Ok(())
}

/// La rama que se conservaba al quitarlo se borró después (migración 013).
pub(crate) fn runtime_worktree_drop_branch_in(c: &Connection, id: &str, at: i64) -> StoreResult<()> {
    require_active(c)?;
    c.execute("UPDATE worktrees SET branch_kept = 0, updated_at = max(coalesce(updated_at, ?2), ?2) WHERE id = ?1", params![id, at])?;
    Ok(())
}

/// Un Artifact nuevo del Attempt (informe, PR, ruta de `codex exec -o`). No se modifica nunca: uno nuevo lo sustituye.
pub(crate) fn runtime_artifact_insert_in(c: &Connection, id: &str, attempt_id: &str, kind: ArtifactKind, uri: &str, at: i64) -> StoreResult<()> {
    require_active(c)?;
    c.execute(
        "INSERT INTO artifacts (id, attempt_id, kind, uri, created_at, origin) VALUES (?1, ?2, ?3, ?4, ?5, 'core')",
        params![id, attempt_id, kind.as_str(), uri, at],
    )?;
    Ok(())
}
