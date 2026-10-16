//! Hechos del registro de proyectos (slice E, E1b · Projects): el ÚNICO sitio que construye y finaliza los
//! borradores de eventos de Projects, y el único que le entrega un [`NewEvent`] al almacén.
//!
//! # Por qué existe
//! Los mutadores de `State` emiten sus hechos por `Tx` (`tx_ops.rs`). El registro de proyectos NO vive en
//! `State`: sus escrituras son transacciones propias de SQLite (`store::projects`). Para que la fila y su
//! hecho nazcan juntos, este módulo hace de «`tx_ops` del registro»:
//!
//! ```text
//! register_project(st, …)
//!   1. new_project_id()                       <- el id se pre-genera FUERA de la transacción
//!   2. event_kinds::project_registered(...)   <- borrador tipado (único constructor)
//!   3. finalize_all(...)                      <- id UUID v7, hora, actor y canal, UNA vez
//!   4. Store::project_register(id, …, &NewEvent)
//!        BEGIN IMMEDIATE
//!          INSERT projects  ·  INSERT project_locations  ·  INSERT events (state_rev = NULL)
//!        COMMIT                               <- los tres, o ninguno
//! ```
//!
//! `store::projects` recibe un `NewEvent` ya materializado, nunca un `EventDraft`: no conoce los hechos.
//! Este módulo no hace E/S externa (ni disco, ni git, ni procesos): corre dentro del closure del almacén.
//!
//! # Quién provoca cada origen (se valida, no se supone)
//! | origen | actor | canal |
//! |---|---|---|
//! | `manual` (`project_add`) | persona | `ui` |
//! | `backfill` (relleno al arrancar) | sistema | `core` |
//! | `import` (carpetas recientes) | sistema | `ui` |
//! | `auto` (`run_create`) | quien lanza el run: persona · agente (su tarea) · sistema | el de la petición (no se fija) |
//!
//! La gestión explícita de Projects es solo de la interfaz: `manual` e `import` exigen `ui` (un `Person/Lxo` o
//! un `System/Lxo` no son válidos). `auto` conserva el actor real y el canal de la petición.
//!
//! La tabla se valida al CONSTRUIR la [`Registration`]: sus campos son privados, así que un registro inválido
//! no existe y se rechaza antes de entrar en el almacén (ni siquiera llega a crear `meta.machine_id`).
//!
//! `join` NO emite `project.registered`: el proyecto ya existía. Sus hechos, y los de archivar/restaurar y
//! relocalizar, son las decisiones de gestión de más abajo ([`Management`]).

use super::event_kinds;
pub(super) use super::event_kinds::ProjectOrigin;
use super::events::{finalize_one, Actor, Channel, MutationContext};
use super::state::now_ms;
use crate::store::{new_project_id, ChangeOutcome, Fingerprint, FingerprintChange, NewEvent, NewLocation, ProjectRow, Store, StoreError, StoreResult};

/// Por qué y por quién se registra un proyecto. Solo se construye VALIDADA ([`Registration::new`]).
pub(super) struct Registration<'a> {
    origin: ProjectOrigin,
    ctx: &'a MutationContext,
}

impl<'a> Registration<'a> {
    /// Valida el par exacto origen + actor + canal. `auto` lo puede provocar cualquiera que lance un run y
    /// conserva el canal de la petición. Se llama ANTES de cualquier escritura (también de `machine_id`).
    pub(super) fn new(origin: ProjectOrigin, ctx: &'a MutationContext) -> Result<Registration<'a>, String> {
        let (ok, esperado) = match origin {
            ProjectOrigin::Manual => (ctx.is_person_ui(), "una persona por la interfaz (person/ui)"),
            ProjectOrigin::Backfill => (ctx.actor == Actor::System && ctx.channel == Channel::Core, "el sistema por el canal core (system/core)"),
            ProjectOrigin::Import => (ctx.actor == Actor::System && ctx.channel == Channel::Ui, "el sistema por la interfaz (system/ui)"),
            ProjectOrigin::Auto => (true, "una persona, un agente o el sistema"),
        };
        if ok {
            Ok(Registration { origin, ctx })
        } else {
            Err(format!("project.registered: el origen {origin:?} lo provoca {esperado}, no {:?} por {:?}", ctx.actor, ctx.channel))
        }
    }
}

/// El evento `project.registered` ya finalizado. `project_id` es el de la fila que va a nacer.
pub(super) fn registered_event(project_id: &str, name: &str, fingerprint: &Fingerprint, reg: &Registration<'_>) -> Result<NewEvent, String> {
    let draft = event_kinds::project_registered(project_id, name, fingerprint, reg.origin).map_err(|e| e.to_string())?;
    // El `project_id` va explícito en el borrador: no se consulta ninguna tarea ni el registro al finalizar.
    finalize_one(draft, reg.ctx, now_ms() as i64, &|_: &str| None)
}

/// Registra un proyecto NUEVO: fila + primera ubicación + `project.registered`, atómicamente. Solo se llama
/// cuando la política (`projects.rs`) ya decidió que el repositorio es inequívocamente nuevo (o que la
/// persona pidió uno nuevo); encontrar uno existente o una ambigüedad nunca llega aquí.
pub(super) fn register_project(st: &mut Store, name: &str, fingerprint: &Fingerprint, loc: &NewLocation, reg: &Registration<'_>) -> StoreResult<ProjectRow> {
    // Todo lo que no es SQL se hace ANTES de abrir la transacción: el id y el evento ya están fijados.
    let id = new_project_id();
    let event = registered_event(&id, name, fingerprint, reg).map_err(StoreError::InvalidEvent)?;
    st.project_register(&id, name, fingerprint, loc, &event)
}

// ---------------------------------------------------------------------------------------------
// Decisiones de gestión sobre un Project que ya existe
// ---------------------------------------------------------------------------------------------
//
// `join` (`project.location_added`), archivar/restaurar (`project.archived` / `project.restored`) y
// relocalizar (`project.relocated`). Son decisiones de una PERSONA por la interfaz. Cada una es UNA
// transacción del almacén con TODAS sus filas y su evento (`Store::project_*_recorded`): nunca «ubicación
// nueva + huella vieja» ni cambios sin su hecho. Solo `ChangeOutcome::Changed` deja evento; el evento se
// construye siempre (sin E/S) con el mismo snapshot que se va a modificar y se descarta si no hubo cambio.

/// Quién toma una decisión de gestión: SIEMPRE una persona por la interfaz (`person/ui`). Como
/// [`Registration`], solo se construye validado y antes de cualquier escritura.
pub(super) struct Management<'a> {
    ctx: &'a MutationContext,
}

impl<'a> Management<'a> {
    pub(super) fn new(ctx: &'a MutationContext) -> Result<Management<'a>, String> {
        if ctx.is_person_ui() {
            Ok(Management { ctx })
        } else {
            Err(format!("la gestión de proyectos la decide una persona por la interfaz (person/ui), no {:?} por {:?}", ctx.actor, ctx.channel))
        }
    }
}

/// `Some` solo si la huella cambia DE VERDAD (`adoptada` distinta de la guardada).
fn fingerprint_change(project: &ProjectRow, to: Option<Fingerprint>) -> Option<FingerprintChange> {
    to.filter(|t| *t != project.fingerprint).map(|to| FingerprintChange { from: project.fingerprint.clone(), to })
}

/// `join`: la ubicación `loc` se añade a `project` (ya existente) y, si aporta remotos que el proyecto no
/// tenía, `adopt` es la huella nueva. `loc.primary` es lo que se ESCRIBE y lo que dice el evento.
pub(super) fn join_project(st: &mut Store, project: &ProjectRow, loc: &NewLocation, adopt: Option<Fingerprint>, mgmt: &Management<'_>) -> StoreResult<ChangeOutcome> {
    let change = fingerprint_change(project, adopt);
    let draft = event_kinds::project_location_added(&project.id, loc.primary, change.is_some()).map_err(|e| StoreError::InvalidEvent(e.to_string()))?;
    let event = finalize_one(draft, mgmt.ctx, now_ms() as i64, &|_: &str| None).map_err(StoreError::InvalidEvent)?;
    st.project_join_recorded(&project.id, loc, change.as_ref(), &event)
}

/// `relocate`: `loc` pasa a ser la ubicación principal de `project`. `adopt` es la huella del repositorio
/// nuevo (se adopta solo si el proyecto no tenía commits raíz y difiere de la guardada) y
/// `confirmed_mismatch` que la persona aceptó con `confirm` un repositorio de otros commits raíz.
pub(super) fn relocate_project(
    st: &mut Store,
    project: &ProjectRow,
    loc: &NewLocation,
    adopt: Option<Fingerprint>,
    confirmed_mismatch: bool,
    mgmt: &Management<'_>,
) -> StoreResult<ChangeOutcome> {
    let change = fingerprint_change(project, adopt);
    let draft = event_kinds::project_relocated(&project.id, change.is_some(), confirmed_mismatch).map_err(|e| StoreError::InvalidEvent(e.to_string()))?;
    let event = finalize_one(draft, mgmt.ctx, now_ms() as i64, &|_: &str| None).map_err(StoreError::InvalidEvent)?;
    st.project_relocate_recorded(&project.id, loc, change.as_ref(), &event)
}

/// Archiva (`archived = true` → `project.archived`) o restaura (`false` → `project.restored`).
pub(super) fn set_archived(st: &mut Store, project_id: &str, archived: bool, mgmt: &Management<'_>) -> StoreResult<ChangeOutcome> {
    let draft = if archived { event_kinds::project_archived(project_id) } else { event_kinds::project_restored(project_id) };
    let event = finalize_one(draft.map_err(|e| StoreError::InvalidEvent(e.to_string()))?, mgmt.ctx, now_ms() as i64, &|_: &str| None).map_err(StoreError::InvalidEvent)?;
    st.project_set_archived_recorded(project_id, archived, &event)
}
