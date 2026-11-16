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

use std::sync::{Arc, Mutex, MutexGuard};

use super::process::Family;

struct Entry {
    owner: Option<String>,
    family: Arc<Family>,
}

static CUSTODY: Mutex<Vec<Entry>> = Mutex::new(Vec::new());

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
