//! LXO-234: aviso único para la UI de lo que hizo el corte Task/Attempt en este arranque.
//!
//! El corte lo ejecuta `boot_authority::cut_if_switched` (migración 014, con `LIXBON_AGENTIC_CUT=1`). Aquí solo se
//! guarda el resultado para que la UI lo lea por `orch_startup_cut` y muestre una vez la copia `pre-f3-cut`.

use std::path::Path;
use std::sync::Mutex;
use serde_json::{json, Value};

/// Resultado del corte en este arranque (uno por proceso: hay un solo Core por `core.lock`).
static STARTUP_CUT: Mutex<Option<Value>> = Mutex::new(None);

/// Vista `{status, backup, code, message}`; `status`: `applied`, `already_cut`, `failed` o `not_run`.
pub(super) fn applied_view(backup: &Path) -> Value {
    json!({ "status": "applied", "backup": backup.to_string_lossy(), "code": null, "message": null })
}

pub(super) fn already_cut_view() -> Value {
    json!({ "status": "already_cut", "backup": null, "code": null, "message": null })
}

pub(super) fn failed_view(message: &str) -> Value {
    json!({ "status": "failed", "backup": null, "code": "core_cut_failed", "message": message })
}

pub(super) fn record(view: Value) {
    if let Ok(mut slot) = STARTUP_CUT.lock() {
        *slot = Some(view);
    }
}

/// Lo que se decidió en este arranque; `not_run` si el corte no se intentó (interruptor apagado o espera de restauración).
pub(super) fn startup_cut_status() -> Value {
    STARTUP_CUT
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_else(|| json!({ "status": "not_run", "backup": null, "code": null, "message": null }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_vista_del_corte_cubre_cada_resultado() {
        assert_eq!(applied_view(Path::new("/c/backups/pre-f3-cut-1.db")), json!({ "status": "applied", "backup": "/c/backups/pre-f3-cut-1.db", "code": null, "message": null }));
        assert_eq!(already_cut_view()["status"], "already_cut");
        let f = failed_view("no se pudo pasar al modelo Task/Attempt");
        assert_eq!((f["status"].as_str(), f["code"].as_str()), (Some("failed"), Some("core_cut_failed")));
    }

    #[test]
    fn sin_corte_en_este_arranque_el_estado_es_not_run() {
        if STARTUP_CUT.lock().unwrap().is_none() {
            assert_eq!(startup_cut_status()["status"], "not_run");
        }
    }
}