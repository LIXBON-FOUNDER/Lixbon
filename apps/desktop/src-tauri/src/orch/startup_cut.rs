//! LXO-123: activación del corte Task/Attempt al arrancar y aviso único para la UI.
//!
//! El arranque (`lifecycle.rs`) llama a [`Core::activate_cut_at_boot`] con el almacén abierto y `core.lock` tomado.
//! El corte es idempotente (`AlreadyCut` no escribe). Tras `Applied` el estado se recarga desde las tablas y la UI
//! recibe, por `orch_startup_cut`, la ruta de la copia `pre-f3-cut` para mostrarla una vez.
//! Si el corte falla (`core_cut_failed`, deshecho entero) o no hay almacén (`model_unavailable`), el Core sigue en
//! legacy con los datos sin cambios y la UI lo explica.

use std::sync::Mutex;
use serde_json::{json, Value};
use super::agentic_cut::AgenticCutStatus;
use super::boot_authority::BootResult;
use super::Core;

/// Resultado del corte en este arranque (uno por proceso: hay un solo Core por `core.lock`).
static STARTUP_CUT: Mutex<Option<Value>> = Mutex::new(None);

/// Vista para la UI: `{status, backup, code, message}`. `status`: `applied`, `already_cut`, `failed` o `not_run`.
pub(super) fn startup_cut_view(result: &Result<AgenticCutStatus, String>) -> Value {
    match result {
        Ok(AgenticCutStatus::Applied { backup }) => {
            json!({ "status": "applied", "backup": backup.to_string_lossy(), "code": null, "message": null })
        }
        Ok(AgenticCutStatus::AlreadyCut) => json!({ "status": "already_cut", "backup": null, "code": null, "message": null }),
        Err(message) => {
            let code = message.split_once(':').map(|(c, _)| c.trim()).filter(|c| !c.is_empty() && !c.contains(' ')).unwrap_or("core_cut_failed");
            json!({ "status": "failed", "backup": null, "code": code, "message": message })
        }
    }
}

fn record(view: Value) {
    if let Ok(mut slot) = STARTUP_CUT.lock() {
        *slot = Some(view);
    }
}

/// Lo que se decidió en este arranque; `not_run` si el Core arrancó sin almacén autoritativo (legacy puro).
pub(super) fn startup_cut_status() -> Value {
    STARTUP_CUT
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_else(|| json!({ "status": "not_run", "backup": null, "code": null, "message": null }))
}

impl Core {
    /// Activa el corte si la base autoritativa aún no está sobre las tablas. `Err` solo si el corte se aplicó y el
    /// estado no se pudo recargar: seguir con la persistencia anterior sobre una base cortada no es seguro.
    pub(super) fn activate_cut_at_boot(&self, boot: BootResult) -> Result<BootResult, String> {
        let BootResult::Authoritative(mut a) = boot else { return Ok(boot) };
        if a.on_tables {
            record(startup_cut_view(&Ok(AgenticCutStatus::AlreadyCut)));
            return Ok(BootResult::Authoritative(a));
        }
        let result = self.ensure_agentic_cut();
        if let Ok(AgenticCutStatus::Applied { .. }) = &result {
            match self.storage.load_from_tables() {
                Ok(Some(state)) => {
                    a.state = state;
                    a.on_tables = true;
                }
                other => {
                    let msg = format!("core_cut_failed: el corte se aplicó pero no se pudo recargar el estado de las tablas ({other:?})");
                    eprintln!("[core] {msg}");
                    self.storage.reject("core_cut_failed".to_string(), msg.clone());
                    if let Some(host) = self.host.get() {
                        host.notify("Lixbon no puede iniciar", &msg);
                    }
                    return Err(msg);
                }
            }
        }
        if let Err(e) = &result {
            eprintln!("[core] corte Task/Attempt no aplicado; se sigue en legacy: {e}");
        }
        record(startup_cut_view(&result));
        Ok(BootResult::Authoritative(a))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn la_vista_del_corte_cubre_cada_resultado() {
        let applied = startup_cut_view(&Ok(AgenticCutStatus::Applied { backup: PathBuf::from("/c/backups/pre-f3-cut-1.db") }));
        assert_eq!(applied, json!({ "status": "applied", "backup": "/c/backups/pre-f3-cut-1.db", "code": null, "message": null }));
        assert_eq!(startup_cut_view(&Ok(AgenticCutStatus::AlreadyCut))["status"], "already_cut");
        for (msg, code) in [
            ("core_cut_failed: preflight", "core_cut_failed"),
            ("core_cut_legacy_numbering: restaura pre-f3-cut", "core_cut_legacy_numbering"),
            ("model_unavailable: el almacén no está abierto", "model_unavailable"),
            ("fallo raro sin código", "core_cut_failed"),
        ] {
            let v = startup_cut_view(&Err(msg.to_string()));
            assert_eq!((v["status"].as_str(), v["code"].as_str(), v["message"].as_str()), (Some("failed"), Some(code), Some(msg)));
        }
    }

    #[test]
    fn sin_arranque_autoritativo_el_estado_es_not_run_y_un_legacy_no_corta() {
        // En pruebas el arranque no llama al corte: el estado global queda sin registrar.
        if STARTUP_CUT.lock().unwrap().is_none() {
            assert_eq!(startup_cut_status()["status"], "not_run");
        }
        let core = super::super::Orch::default().0;
        assert!(matches!(core.activate_cut_at_boot(BootResult::Legacy), Ok(BootResult::Legacy)));
    }
}
