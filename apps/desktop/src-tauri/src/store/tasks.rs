//! Task como intención durable (LXO-113, épica F3): lado del **almacén**. Contrato: `docs/core/TASKS.md`.
//!
//! Solo sabe guardar y leer las filas de `runs` y `tasks` (migración `007_tasks`). No conoce `orch`, ni qué
//! hechos existen, ni quién los provoca: los eventos llegan de `orch::task_ops`. La dirección sigue siendo
//! `orch -> store`.
//!
//! # Garantías
//! * **Inerte hasta el corte.** Mientras `meta.agentic_model` no exista, la autoridad de las tareas es el
//!   documento `legacy_state`: cada mutador lo comprueba primero ([`StoreError::AgenticModelInactive`], sin
//!   tocar nada) y los triggers de la 007 abortan cualquier escritura que se lo salte.
//! * **Fila + evento, juntos.** Cada mutador es UNA transacción (`BEGIN IMMEDIATE`) con sus filas y sus eventos
//!   (`state_rev = NULL`: no tocan `legacy_state`), proyectados a Attention en la misma transacción. Los
//!   eventos los construye quien llama con un closure que recibe las filas YA escritas (los ids nacen dentro
//!   de la transacción, del contador `meta.id_seq`); el closure es puro, sin E/S. Un evento duplicado, que no
//!   se refiere a la entidad o que falla al proyectarse deshace el cambio entero.
//! * **Intención, no ejecución.** Ninguna fila lleva proceso, PTY, worktree ni sesión del proveedor.
//! * **Sin borrados en cascada.** Solo [`TaskRemoval::IfUnused`] borra, y la base rechaza igualmente borrar
//!   una Task de la que dependa otra fila.
//! * **Las marcas de tiempo las fija quien llama** (la hora del evento): el almacén no lee el reloj.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: solo lo usan `orch::task_ops` y las pruebas

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use super::error::{StoreError, StoreResult};
use super::events::{insert_events_projected, EventProjector, Inserted, NewEvent};
use super::projects::ChangeOutcome;
use super::Store;

/// Clave de `meta` que escribe el corte Task/Attempt. Su presencia activa estas tablas.
pub const AGENTIC_MODEL_KEY: &str = "agentic_model";
/// Valor que escribe el corte (`docs/core/CORTE_TASK_ATTEMPT.md` §9).
pub const AGENTIC_MODEL: &str = "task_attempt_v1";

/// Intención de la Task: lo único de su «estado» que se guarda (es una decisión de la persona). El estado de
/// ejecución se deriva de sus Attempts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskIntent {
    Open,
    Discarded,
}

impl TaskIntent {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskIntent::Open => "open",
            TaskIntent::Discarded => "discarded",
        }
    }

    fn parse(s: &str) -> StoreResult<TaskIntent> {
        match s {
            "open" => Ok(TaskIntent::Open),
            "discarded" => Ok(TaskIntent::Discarded),
            other => Err(StoreError::InvalidTask(format!("intención desconocida: {other}"))),
        }
    }
}

/// De dónde salió la fila: importada del documento legacy por el corte, o creada por el Core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskOrigin {
    Legacy,
    Core,
}

impl TaskOrigin {
    pub(super) fn parse(s: &str) -> StoreResult<TaskOrigin> {
        match s {
            "legacy" => Ok(TaskOrigin::Legacy),
            "core" => Ok(TaskOrigin::Core),
            other => Err(StoreError::InvalidTask(format!("origen desconocido: {other}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TaskRow {
    pub id: String,
    pub run_id: String,
    pub parent_task_id: Option<String>,
    pub depth: i64,
    /// `None` solo en filas importadas del legado (ADR D1).
    pub project_id: Option<String>,
    pub title: String,
    pub spec: String,
    /// Ruta local donde se creó (ADR D18). No identifica nada.
    pub repo: String,
    pub intent: TaskIntent,
    pub origin: TaskOrigin,
    pub created_at: i64,
    pub updated_at: i64,
    pub discarded_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunRow {
    pub id: String,
    pub objective: String,
    pub root_task_id: String,
    pub created_at: i64,
    pub closed: bool,
    pub last_activity: i64,
}

/// Lo que define una Task al nacer. El árbol, el Run y el Project los decide el mutador.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTaskIntent {
    pub title: String,
    pub spec: String,
    pub repo: String,
}

/// Un Run nuevo con su Task raíz, en un Project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRun {
    pub objective: String,
    pub project_id: String,
    pub root: NewTaskIntent,
}

/// Qué cambia de la intención. `None` = no se toca.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IntentChange {
    pub title: Option<String>,
    pub spec: Option<String>,
}

/// Campos de la intención que un cambio puede tocar (para el hecho: nunca el texto del encargo).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentField {
    Title,
    Spec,
}

/// Política de borrado. Es la ÚNICA forma de borrar una Task y es explícita en cada llamada: no hay borrado
/// por defecto ni en cascada. Lo que no cumple la política se descarta (intención `discarded`), no se borra.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskRemoval {
    /// Solo una Task sin hijas que no es la raíz de su Run (y, por la base, de la que no depende ninguna fila).
    IfUnused,
}

const TASK_COLS: &str = "id, run_id, parent_task_id, depth, project_id, title, spec, repo, intent, origin, created_at, updated_at, discarded_at";
const RUN_COLS: &str = "id, objective, root_task_id, created_at, closed, last_activity";

type RawTask = (TaskRow, String, String);

fn task_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RawTask> {
    Ok((
        TaskRow {
            id: r.get(0)?,
            run_id: r.get(1)?,
            parent_task_id: r.get(2)?,
            depth: r.get(3)?,
            project_id: r.get(4)?,
            title: r.get(5)?,
            spec: r.get(6)?,
            repo: r.get(7)?,
            intent: TaskIntent::Open,
            origin: TaskOrigin::Core,
            created_at: r.get(10)?,
            updated_at: r.get(11)?,
            discarded_at: r.get(12)?,
        },
        r.get(8)?,
        r.get(9)?,
    ))
}

fn finish_task((mut t, intent, origin): RawTask) -> StoreResult<TaskRow> {
    t.intent = TaskIntent::parse(&intent)?;
    t.origin = TaskOrigin::parse(&origin)?;
    Ok(t)
}

fn run_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<RunRow> {
    let closed: i64 = r.get(4)?;
    Ok(RunRow { id: r.get(0)?, objective: r.get(1)?, root_task_id: r.get(2)?, created_at: r.get(3)?, closed: closed == 1, last_activity: r.get(5)? })
}

pub(super) fn task_in(c: &Connection, id: &str) -> StoreResult<Option<TaskRow>> {
    c.query_row(&format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?1"), [id], task_from_row).optional()?.map(finish_task).transpose()
}

pub(super) fn run_in(c: &Connection, id: &str) -> StoreResult<Option<RunRow>> {
    Ok(c.query_row(&format!("SELECT {RUN_COLS} FROM runs WHERE id = ?1"), [id], run_from_row).optional()?)
}

fn tasks_where(c: &Connection, filter: &str, arg: &str) -> StoreResult<Vec<TaskRow>> {
    let sql = format!("SELECT {TASK_COLS} FROM tasks WHERE {filter} ORDER BY created_at, id");
    let rows = c.prepare(&sql)?.query_map([arg], task_from_row)?.collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(finish_task).collect()
}

fn active_in(c: &Connection) -> StoreResult<bool> {
    let n: i64 = c.query_row("SELECT COUNT(*) FROM meta WHERE key = ?1", [AGENTIC_MODEL_KEY], |r| r.get(0))?;
    Ok(n == 1)
}

/// Antes del corte nada de esto escribe: la autoridad de las tareas es `legacy_state`.
pub(super) fn require_active(c: &Connection) -> StoreResult<()> {
    if active_in(c)? {
        Ok(())
    } else {
        Err(StoreError::AgenticModelInactive)
    }
}

/// Siguiente id del contador compartido del legado (`tN`, `rN` y mensajes). El corte lo deja en el `seq`
/// del documento; sin él, empieza en 1.
fn next_id(tx: &Transaction<'_>, prefix: char) -> StoreResult<String> {
    Ok(format!("{prefix}{}", next_seq_in(tx)?))
}

/// Siguiente número del contador compartido (`tN`, `rN` y mensajes).
pub(super) fn next_seq_in(tx: &Connection) -> StoreResult<u64> {
    let value: String = tx.query_row(
        "INSERT INTO meta (key, value) VALUES ('id_seq', '1')
         ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
         RETURNING value",
        [],
        |r| r.get(0),
    )?;
    value.parse().map_err(|_| StoreError::InvalidDocument(format!("meta.id_seq no es un entero: {value}")))
}

fn check_title(title: &str) -> StoreResult<()> {
    if title.trim().is_empty() {
        return Err(StoreError::InvalidTask("el título de una Task no puede estar vacío".into()));
    }
    Ok(())
}

/// El evento se refiere a esta Task: su entidad, su Run y su Project.
fn check_task_event(t: &TaskRow, e: &NewEvent) -> StoreResult<()> {
    if e.entity_kind != "task" || e.entity_id != t.id || e.run_id.as_deref() != Some(t.run_id.as_str()) || e.project_id != t.project_id {
        return Err(StoreError::InvalidEvent(format!("{}: el evento no se refiere a la Task {}", e.kind, t.id)));
    }
    e.check()
}

fn check_run_event(run: &RunRow, project_id: &str, e: &NewEvent) -> StoreResult<()> {
    if e.entity_kind != "run" || e.entity_id != run.id || e.run_id.as_deref() != Some(run.id.as_str()) || e.project_id.as_deref() != Some(project_id) {
        return Err(StoreError::InvalidEvent(format!("{}: el evento no se refiere al Run {}", e.kind, run.id)));
    }
    e.check()
}

/// Inserta los hechos del cambio. Un duplicado por `(kind, idem_key)` deshace el cambio en lugar de dejarlo sin su hecho.
pub(super) fn insert_all(tx: &Transaction<'_>, events: &[NewEvent], projector: Option<&dyn EventProjector>) -> StoreResult<()> {
    if events.is_empty() {
        return Err(StoreError::InvalidEvent("un cambio de una Task no se confirma sin su hecho".into()));
    }
    let inserted = insert_events_projected(tx, events, None, projector)?;
    if let Some((e, _)) = events.iter().zip(&inserted).find(|(_, i)| !matches!(i, Inserted::New(_))) {
        return Err(StoreError::TaskConflict(format!("el evento {} ya existía: el cambio no se confirma sin su hecho", e.kind)));
    }
    Ok(())
}

fn insert_task(tx: &Transaction<'_>, t: &TaskRow) -> StoreResult<()> {
    tx.execute(
        "INSERT INTO tasks (id, run_id, parent_task_id, depth, project_id, title, spec, repo, intent, origin, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'open', 'core', ?9, ?9)",
        params![t.id, t.run_id, t.parent_task_id, t.depth, t.project_id, t.title, t.spec, t.repo, t.created_at],
    )?;
    Ok(())
}

fn core_task(id: String, run_id: String, parent: Option<String>, depth: i64, project_id: String, new: &NewTaskIntent, at: i64) -> TaskRow {
    TaskRow {
        id,
        run_id,
        parent_task_id: parent,
        depth,
        project_id: Some(project_id),
        title: new.title.clone(),
        spec: new.spec.clone(),
        repo: new.repo.clone(),
        intent: TaskIntent::Open,
        origin: TaskOrigin::Core,
        created_at: at,
        updated_at: at,
        discarded_at: None,
    }
}

impl Store {
    /// ¿Ya se hizo el corte Task/Attempt (`meta.agentic_model`)? Antes, ningún mutador de este módulo escribe.
    pub fn agentic_model_active(&self) -> StoreResult<bool> {
        self.read(active_in)
    }

    /// Nace un Run con su Task raíz en `new.project_id`: las dos filas y sus eventos (`events(&run, &raíz)`), en
    /// UNA transacción. Los ids salen del contador compartido dentro de la transacción. Un Project que no existe
    /// es [`StoreError::TaskConflict`] y no deja nada.
    pub fn run_create_recorded(&mut self, new: &NewRun, at: i64, events: impl FnOnce(&RunRow, &TaskRow) -> StoreResult<Vec<NewEvent>>) -> StoreResult<(RunRow, TaskRow)> {
        check_title(&new.root.title)?;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let project: Option<String> = tx.query_row("SELECT id FROM projects WHERE id = ?1", [&new.project_id], |r| r.get(0)).optional()?;
            if project.is_none() {
                return Err(StoreError::TaskConflict(format!("no existe el Project {}", new.project_id)));
            }
            let run_id = next_id(tx, 'r')?;
            let task_id = next_id(tx, 't')?;
            let run = RunRow { id: run_id.clone(), objective: new.objective.clone(), root_task_id: task_id.clone(), created_at: at, closed: false, last_activity: at };
            let task = core_task(task_id, run_id, None, 0, new.project_id.clone(), &new.root, at);
            tx.execute(
                "INSERT INTO runs (id, objective, root_task_id, created_at, closed, last_activity) VALUES (?1, ?2, ?3, ?4, 0, ?4)",
                params![run.id, run.objective, run.root_task_id, at],
            )?;
            insert_task(tx, &task)?;
            let events = events(&run, &task)?;
            for e in &events {
                if e.entity_kind == "run" {
                    check_run_event(&run, &new.project_id, e)?;
                } else {
                    check_task_event(&task, e)?;
                }
            }
            insert_all(tx, &events, projector.as_deref())?;
            Ok((run, task))
        })
    }

    /// Nace una Task hija de `parent_id`: hereda su Run y su Project, un nivel por debajo. No se puede colgar
    /// de una Task descartada, de un Run cerrado ni de una Task importada sin Project.
    pub fn task_create_child_recorded(&mut self, parent_id: &str, new: &NewTaskIntent, at: i64, event: impl FnOnce(&TaskRow) -> StoreResult<NewEvent>) -> StoreResult<TaskRow> {
        check_title(&new.title)?;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let parent = task_in(tx, parent_id)?.ok_or_else(|| StoreError::TaskConflict(format!("no existe la Task {parent_id}")))?;
            if parent.intent == TaskIntent::Discarded {
                return Err(StoreError::TaskConflict(format!("la Task {parent_id} está descartada: no admite hijas")));
            }
            let Some(project_id) = parent.project_id.clone() else {
                return Err(StoreError::TaskConflict(format!("la Task {parent_id} no tiene Project: sus hijas no tendrían a cuál pertenecer")));
            };
            let run = run_in(tx, &parent.run_id)?.ok_or_else(|| StoreError::TaskConflict(format!("no existe el Run {}", parent.run_id)))?;
            if run.closed {
                return Err(StoreError::TaskConflict(format!("el Run {} está cerrado: no admite Tasks nuevas", run.id)));
            }
            let task = core_task(next_id(tx, 't')?, parent.run_id.clone(), Some(parent.id.clone()), parent.depth + 1, project_id, new, at);
            insert_task(tx, &task)?;
            let e = event(&task)?;
            check_task_event(&task, &e)?;
            insert_all(tx, std::slice::from_ref(&e), projector.as_deref())?;
            Ok(task)
        })
    }

    /// Cambia el título o el encargo de una Task abierta. `Unchanged` (sin evento) si ya era así; una Task
    /// descartada no se edita (se restaura antes). `event(&fila_nueva, &campos_cambiados)`.
    pub fn task_update_intent_recorded(&mut self, id: &str, change: &IntentChange, at: i64, event: impl FnOnce(&TaskRow, &[IntentField]) -> StoreResult<NewEvent>) -> StoreResult<ChangeOutcome> {
        if change.title.is_none() && change.spec.is_none() {
            return Err(StoreError::InvalidTask("un cambio de intención tiene que tocar el título o el encargo".into()));
        }
        if let Some(title) = &change.title {
            check_title(title)?;
        }
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(mut t) = task_in(tx, id)? else { return Ok(ChangeOutcome::Missing) };
            if t.intent == TaskIntent::Discarded {
                return Err(StoreError::TaskConflict(format!("la Task {id} está descartada: restáurala antes de editarla")));
            }
            let mut fields = vec![];
            if let Some(title) = change.title.as_ref().filter(|v| **v != t.title) {
                t.title = title.clone();
                fields.push(IntentField::Title);
            }
            if let Some(spec) = change.spec.as_ref().filter(|v| **v != t.spec) {
                t.spec = spec.clone();
                fields.push(IntentField::Spec);
            }
            if fields.is_empty() {
                return Ok(ChangeOutcome::Unchanged);
            }
            t.updated_at = at.max(t.updated_at);
            tx.execute("UPDATE tasks SET title = ?2, spec = ?3, updated_at = ?4 WHERE id = ?1", params![id, t.title, t.spec, t.updated_at])?;
            let e = event(&t, &fields)?;
            check_task_event(&t, &e)?;
            insert_all(tx, std::slice::from_ref(&e), projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    /// Descarta (`discarded = true`) o restaura la intención. Sin cascada: no se descarta una Task con hijas
    /// abiertas ni se restaura la hija de una Task descartada. `Unchanged` (sin evento) si ya estaba así.
    pub fn task_set_discarded_recorded(&mut self, id: &str, discarded: bool, at: i64, event: impl FnOnce(&TaskRow) -> StoreResult<NewEvent>) -> StoreResult<ChangeOutcome> {
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(mut t) = task_in(tx, id)? else { return Ok(ChangeOutcome::Missing) };
            if (t.intent == TaskIntent::Discarded) == discarded {
                return Ok(ChangeOutcome::Unchanged);
            }
            if discarded {
                let activo: Option<String> = tx
                    .query_row("SELECT id FROM attempts WHERE task_id = ?1 AND status NOT IN ('done', 'failed', 'stopped', 'exited')", [id], |r| r.get(0))
                    .optional()?;
                if let Some(activo) = activo {
                    return Err(StoreError::TaskConflict(format!("la Task {id} tiene el Attempt activo {activo}: cancélalo antes de descartarla")));
                }
                let abiertas: Vec<String> = tx
                    .prepare("SELECT id FROM tasks WHERE parent_task_id = ?1 AND intent = 'open' ORDER BY created_at, id")?
                    .query_map([id], |r| r.get(0))?
                    .collect::<Result<_, _>>()?;
                if !abiertas.is_empty() {
                    return Err(StoreError::TaskConflict(format!("la Task {id} tiene hijas abiertas ({}): descártalas antes", abiertas.join(", "))));
                }
            } else if let Some(parent) = t.parent_task_id.as_deref() {
                if task_in(tx, parent)?.is_some_and(|p| p.intent == TaskIntent::Discarded) {
                    return Err(StoreError::TaskConflict(format!("la Task {parent}, padre de {id}, está descartada: restáurala antes")));
                }
            }
            t.updated_at = at.max(t.updated_at);
            (t.intent, t.discarded_at) = if discarded { (TaskIntent::Discarded, Some(t.updated_at)) } else { (TaskIntent::Open, None) };
            tx.execute(
                "UPDATE tasks SET intent = ?2, discarded_at = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, t.intent.as_str(), t.discarded_at, t.updated_at],
            )?;
            let e = event(&t)?;
            check_task_event(&t, &e)?;
            insert_all(tx, std::slice::from_ref(&e), projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    /// Borra una Task según `policy`. Con [`TaskRemoval::IfUnused`]: ni la raíz de su Run ni una Task con hijas
    /// (eso es [`StoreError::TaskConflict`]); y si otra fila depende de ella, la base rechaza el COMMIT y no se
    /// borra nada. El evento recibe la fila tal como era. La historia (Event Log) no se toca.
    pub fn task_remove_recorded(&mut self, id: &str, policy: TaskRemoval, event: impl FnOnce(&TaskRow) -> StoreResult<NewEvent>) -> StoreResult<ChangeOutcome> {
        let TaskRemoval::IfUnused = policy;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(t) = task_in(tx, id)? else { return Ok(ChangeOutcome::Missing) };
            if run_in(tx, &t.run_id)?.is_some_and(|r| r.root_task_id == id) {
                return Err(StoreError::TaskConflict(format!("{id} es la raíz del Run {}: no se borra como Task", t.run_id)));
            }
            let hijas: i64 = tx.query_row("SELECT COUNT(*) FROM tasks WHERE parent_task_id = ?1", [id], |r| r.get(0))?;
            if hijas > 0 {
                return Err(StoreError::TaskConflict(format!("{id} tiene {hijas} hija(s): no se borra una Task con descendientes (descártala)")));
            }
            let intentos: i64 = tx.query_row("SELECT COUNT(*) FROM attempts WHERE task_id = ?1", [id], |r| r.get(0))?;
            if intentos > 0 {
                return Err(StoreError::TaskConflict(format!("{id} tiene {intentos} Attempt(s): su historia no se borra (descártala)")));
            }
            tx.execute("DELETE FROM tasks WHERE id = ?1", [id])?;
            let e = event(&t)?;
            check_task_event(&t, &e)?;
            insert_all(tx, std::slice::from_ref(&e), projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    pub fn task_row(&self, id: &str) -> StoreResult<Option<TaskRow>> {
        self.read(|c| task_in(c, id))
    }

    pub fn run_row(&self, id: &str) -> StoreResult<Option<RunRow>> {
        self.read(|c| run_in(c, id))
    }

    /// Las Tasks de un Run, de la más antigua a la más nueva.
    pub fn tasks_of_run(&self, run_id: &str) -> StoreResult<Vec<TaskRow>> {
        self.read(|c| tasks_where(c, "run_id = ?1", run_id))
    }

    /// Las Tasks de un Project; sin `include_discarded`, solo las abiertas.
    pub fn tasks_of_project(&self, project_id: &str, include_discarded: bool) -> StoreResult<Vec<TaskRow>> {
        self.read(|c| tasks_where(c, if include_discarded { "project_id = ?1" } else { "project_id = ?1 AND intent = 'open'" }, project_id))
    }

    pub fn task_children(&self, id: &str) -> StoreResult<Vec<TaskRow>> {
        self.read(|c| tasks_where(c, "parent_task_id = ?1", id))
    }
}
