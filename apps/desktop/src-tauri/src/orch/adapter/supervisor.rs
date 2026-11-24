//! Supervisor de los procesos de los adapters (LXO-242): la CUSTODIA de lo que no se pudo cerrar con prueba y su reintento ordenado.
//!
//! ```text
//! Process::kill / Drop ── close() ── probado ────────────────► Closure::Proven, nada que custodiar
//!                            └── NO probado ─► supervisor::keep(dueño, familia) ─► Closure::Unproven
//! Core::shutdown  ── cancela las ejecuciones ─► supervisor::reap()   reintenta TODA la custodia
//! barrido periódico ───────────────────────────► supervisor::reap()   reintenta lo que siga sin cerrar
//! Resource Manager ─► supervisor::task_in_custody(task)             no limpia el worktree de una Task con un proceso en custodia
//! ```
//!
//! Antes de este módulo, un cierre sin probar solo lo reintentaba el `Drop` del proceso y, si fallaba otra vez, el árbol se perdía (el kill ciego de la
//! raíz era el último recurso). Ahora el supervisor CONSERVA la familia (la raíz sin reapear, que ancla su pid, y el árbol con su identidad y su Job) hasta
//! que el cierre se comprueba: nunca se mata a un proceso por un pid reutilizado, y lo que no se pueda probar sigue a la vista, no desaparece.
//!
//! La custodia es GLOBAL al proceso, como la de las terminales (`pty::UNOWNED`): `Core::shutdown` la vacía entera. Las pruebas que la tocan, o que
//! apagan un Core, van de una en una (`pty::pruebas::serie_custodia`).
//!
//! # Invariantes
//! * **Nada se pierde**: un cierre sin probar queda aquí hasta que `reap` lo comprueba; soltar el proceso (`Drop`) no lo descarta.
//! * **Idempotente**: la misma familia no se registra dos veces.
//! * **El registro no se mantiene bloqueado mientras corre un cierre**: `reap` toma una copia y reintenta fuera del candado.
//! * **El dueño es el Attempt** (`<task>-a<n>`): permite decir «esa Task tiene un proceso sin cerrar» sin adivinar por pid.

use std::sync::{Arc, Mutex, MutexGuard, Weak};

use super::process::Family;

struct Entry {
    owner: Option<String>,
    family: Arc<Family>,
}

static CUSTODY: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

/// Los procesos con dueño CONOCIDO que siguen abiertos (LXO-183). Débiles: el supervisor no alarga la vida de ninguna familia; una
/// familia cerrada o soltada simplemente deja de aparecer. Lo lee el Core para registrar la propiedad de forma durable.
static HELD: Mutex<Vec<(String, Weak<Family>)>> = Mutex::new(Vec::new());

fn held() -> MutexGuard<'static, Vec<(String, Weak<Family>)>> {
    HELD.lock().unwrap_or_else(|e| e.into_inner())
}

/// Anota que `family` tiene como dueño a `owner` (un Attempt `<task>-a<n>`). Idempotente.
pub(super) fn hold(owner: &str, family: &Arc<Family>) {
    let mut held = held();
    held.retain(|(_, w)| w.strong_count() > 0);
    let ptr = Arc::as_ptr(family);
    if let Some(entry) = held.iter_mut().find(|(_, w)| w.as_ptr() == ptr) {
        entry.0 = owner.to_string();
    } else {
        held.push((owner.to_string(), Arc::downgrade(family)));
    }
}

/// Un proceso abierto con dueño conocido, tal como lo ve el supervisor ahora.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedProcess {
    /// El Attempt dueño (`<task>-a<n>`).
    pub owner: String,
    pub pid: u32,
    /// Hora de creación de la raíz (token opaco), si se pudo probar. Sin ella el proceso no se puede reconocer después.
    pub start: Option<u64>,
    /// Unix: el grupo de procesos de la raíz.
    pub pgid: Option<u32>,
    /// Su último cierre no se pudo probar: sigue en custodia.
    pub in_custody: bool,
}

/// Los procesos con dueño que siguen abiertos: los que se sostienen y los que están en custodia. Sin duplicados y sin los ya cerrados.
pub fn owned_snapshot() -> Vec<OwnedProcess> {
    let mut found: Vec<(*const Family, OwnedProcess)> = Vec::new();
    let mut push = |owner: &str, family: &Arc<Family>, in_custody: bool| {
        if family.is_closed() {
            return;
        }
        let ptr = Arc::as_ptr(family);
        if let Some((_, existing)) = found.iter_mut().find(|(p, _)| *p == ptr) {
            existing.in_custody |= in_custody;
            return;
        }
        if let Some((pid, start, pgid)) = family.identity() {
            found.push((ptr, OwnedProcess { owner: owner.to_string(), pid, start, pgid, in_custody }));
        }
    };
    let held_now: Vec<(String, Arc<Family>)> = held().iter().filter_map(|(o, w)| w.upgrade().map(|f| (o.clone(), f))).collect();
    let in_custody: Vec<(String, Arc<Family>)> = custody().iter().filter_map(|e| e.owner.clone().map(|o| (o, Arc::clone(&e.family)))).collect();
    for (owner, family) in &held_now {
        push(owner, family, false);
    }
    for (owner, family) in &in_custody {
        push(owner, family, true);
    }
    found.into_iter().map(|(_, p)| p).collect()
}

fn custody() -> MutexGuard<'static, Vec<Entry>> {
    CUSTODY.lock().unwrap_or_else(|e| e.into_inner())
}

/// Pone bajo custodia una familia cuyo cierre no se pudo probar. Idempotente.
pub(super) fn keep(owner: Option<String>, family: Arc<Family>) {
    let mut entries = custody();
    if entries.iter().any(|e| Arc::ptr_eq(&e.family, &family)) {
        // Si ahora se conoce un dueño que antes no estaba, se conserva.
        if let (Some(entry), Some(_)) = (entries.iter_mut().find(|e| Arc::ptr_eq(&e.family, &family) && e.owner.is_none()), owner.as_ref()) {
            entry.owner = owner;
        }
        return;
    }
    eprintln!("[core] un proceso de proveedor queda en custodia: no se pudo probar que su árbol terminó ({})", owner.as_deref().unwrap_or("sin dueño"));
    entries.push(Entry { owner, family });
}

/// Reintenta cerrar TODO lo que sigue en custodia. Lo comprobado sale; lo demás se queda. Devuelve cuántos siguen sin cerrar. Lo llaman
/// `Core::shutdown` y el barrido periódico.
pub fn reap() -> usize {
    let pending: Vec<Arc<Family>> = custody().iter().map(|e| Arc::clone(&e.family)).collect();
    for family in pending {
        // Fuera del candado del registro: un cierre lento no bloquea a quien consulta la custodia.
        if family.close() {
            custody().retain(|e| !Arc::ptr_eq(&e.family, &family));
        }
    }
    count()
}

/// Cuántas familias siguen en custodia. Diagnóstico y pruebas.
pub fn count() -> usize {
    custody().len()
}

/// ¿Hay un proceso sin cerrar de ese Attempt (`<task>-a<n>`)?
pub fn in_custody(attempt_id: &str) -> bool {
    custody().iter().any(|e| e.owner.as_deref() == Some(attempt_id))
}

/// ¿Hay un proceso sin cerrar de algún Attempt de esa Task? Compara `<task>-a<dígitos>` exacto: `t9` no coincide con `t90-a1`.
pub fn task_in_custody(task_id: &str) -> bool {
    let prefix = format!("{task_id}-a");
    custody().iter().any(|e| e.owner.as_deref().and_then(|o| o.strip_prefix(prefix.as_str())).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
}
