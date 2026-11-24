//! LXO-182 · el hecho `host.registered`: el ÚNICO sitio que construye y finaliza ese borrador (como `project_ops.rs` con los de Project).
//!
//! `host_identity.rs` decide CUÁNDO un host nace o se verifica y le entrega este evento ya materializado al almacén; `store::hosts` no
//! conoce qué hechos existen. Lo escribe siempre el propio Core (`system/core`).

use super::event_kinds;
use super::events::{finalize_one, MutationContext};
use crate::store::NewEvent;

/// El evento `host.registered` de `host_id`. `verified` = ¿tiene ya su clave fijada?
pub(super) fn registered_event(host_id: &str, is_self: bool, verified: bool, at: i64) -> Result<NewEvent, String> {
    let draft = event_kinds::host_registered(host_id, is_self, verified).map_err(|e| e.to_string())?;
    finalize_one(draft, &MutationContext::core(), at, &|_: &str| None)
}
