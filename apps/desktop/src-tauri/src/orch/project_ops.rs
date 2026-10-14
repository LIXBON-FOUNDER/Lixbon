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
//! `join` NO emite `project.registered`: el proyecto ya existía. Su hecho (`project.location_added`),
//! archivar/restaurar y relocalizar llegan en el commit siguiente.

use super::event_kinds;
pub(super) use super::event_kinds::ProjectOrigin;
use super::events::{finalize_all, Actor, Channel, MutationContext};
use super::state::now_ms;
use crate::store::{new_project_id, Fingerprint, NewEvent, NewLocation, ProjectRow, Store, StoreError, StoreResult};

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
            ProjectOrigin::Manual => (ctx.actor == Actor::Person && ctx.channel == Channel::Ui, "una persona por la interfaz (person/ui)"),
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
    let mut events = finalize_all(vec![draft], reg.ctx, now_ms() as i64, &|_: &str| None)?;
    match (events.pop(), events.is_empty()) {
        (Some(e), true) => Ok(e),
        _ => Err("project.registered: un registro produce exactamente un evento".into()),
    }
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
