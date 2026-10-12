//! Arranque y parada del Core: hilos de barrido, servidor local y cierre de runs inactivos.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use serde_json::json;
use super::host::Host;
use super::store_boot::{OpenStoreError, StorageStatus};
use super::{Core, IDLE_CLOSE_MS, SWEEP_EVERY, Settings, agents, core_dir, data_dir, discovery_file, lxo_path, read_json, server, skill, state, write_json, write_private_json};
use super::state::{Kind, State};

/// Prueba de que se llama desde el arranque: `Core::adopt_state` la exige y solo
/// este módulo puede crearla (el campo y el constructor son privados aquí).
pub(super) struct BootProof(());

impl BootProof {
    fn new() -> Self {
        BootProof(())
    }

    /// Las pruebas preparan el estado inicial como lo haría el arranque.
    #[cfg(test)]
    pub(super) fn for_tests() -> Self {
        BootProof(())
    }
}

impl Core {
    /// Arranca el Core. `Err` solo si hay un motivo BLOQUEANTE: `core.lock` tomado
    /// por otro Core o inaccesible (sin él no hay un único escritor garantizado) o
    /// una base incompatible con este binario. En ese caso NO se lee ni se
    /// reescribe `state.json`, no se arrancan ni el servidor ni los hilos, y quien
    /// llama debe terminar. Solo los fallos de la base posteriores a haber
    /// adquirido el bloqueo (disco, permisos, base corrupta) dejan el Core
    /// funcionando, degradado, con `state.json`.
    pub fn init(self: &Arc<Self>, host: Arc<dyn Host>) -> Result<(), String> {
        self.init_in(host, &data_dir(), &core_dir())
    }

    /// `init` con las carpetas explícitas: `data` (`settings.json` y `state.json`
    /// legacy) y `core` (`lixbon.db`, `core.lock`, `backups/`).
    pub(super) fn init_in(self: &Arc<Self>, host: Arc<dyn Host>, data: &Path, core: &Path) -> Result<(), String> {
        self.set_host(host);
        // 1. El bloqueo de instancia va ANTES de leer o reescribir state.json: un
        // segundo Core no puede llegar a hacer `orphan_all()` sobre el estado del
        // primero. Si no se puede garantizar el único escritor (tomado, no creable,
        // inaccesible), no se arranca: cualquier error aquí es bloqueante.
        if let Err(e) = self.acquire_instance_lock(core) {
            return Err(self.refuse_to_start(&e));
        }
        // 2. Abrir y migrar la base: comprueba que este binario y el almacén se
        // entienden (esquema más nuevo, checksum, orden) antes de tocar state.json.
        match self.open_store_db(core) {
            Ok(()) => {}
            Err(e) if e.is_blocking() => return Err(self.refuse_to_start(&e)),
            Err(e) => self.degrade_storage(&e), // con el bloqueo ya adquirido
        }
        // 3. Estado operativo (legacy): leer, orphan_all y reescribir.
        let settings: Settings = read_json(&data.join("settings.json")).unwrap_or_default();
        let mut st: State = read_json(&data.join("state.json")).unwrap_or_default();
        st.orphan_all();
        let _ = write_json(&data.join("state.json"), &st);
        self.adopt_state(&BootProof::new(), st); // carga inicial: no es una mutación
        // Acciones externas (merge, PR, worktree, proceso) que ocurrieron en una sesión
        // anterior pero cuyo registro no se pudo guardar: se avisa, no se esconde.
        let unrecorded = Self::unrecorded_effects(data);
        if unrecorded > 0 {
            let msg = format!("{unrecorded} acción(es) externa(s) se ejecutaron sin quedar registradas (ver unrecorded-effects.jsonl en {}): revísalas antes de repetirlas.", data.display());
            eprintln!("[core] {msg}");
            if let Some(host) = self.host.get() {
                host.notify("Lixbon: acciones sin registrar", &msg);
            }
        }
        // 4. Instantánea de arranque del estado que acaba de adoptar el Core. No
        // interviene en las operaciones (C1).
        if !matches!(self.storage_status(), StorageStatus::Degraded(_)) {
            match self.import_snapshot(&data.join("state.json")) {
                Ok(report) => {
                    if report.matches_adopted == Some(false) {
                        eprintln!("[core] la instantánea importada no coincide con el estado que adoptó el Core");
                    }
                }
                Err(e) if e.is_blocking() => return Err(self.refuse_to_start(&e)),
                Err(e) => self.degrade_storage(&e),
            }
        }
        let enabled = settings.enabled;
        if let Ok(mut s) = self.settings.lock() {
            *s = settings;
        }
        if enabled {
            let _ = self.start_server();
            skill::refresh_outdated(&lxo_path().to_string_lossy());
            // Preguntar a cada CLI por sus modelos tarda: se hace ya para que el
            // primer `lxo agents` del coordinador responda al momento.
            std::thread::spawn(|| agents::available(false));
        }
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            while let Some(core) = weak.upgrade() {
                core.close_idle_runs();
                drop(core);
                std::thread::sleep(SWEEP_EVERY);
            }
        });
        // Vencimiento de lanzamientos pendientes (y de los de coordinadores que ya no siguen).
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            while let Some(core) = weak.upgrade() {
                core.sweep_pending();
                drop(core);
                std::thread::sleep(Duration::from_secs(5));
            }
        });
        Ok(())
    }

    /// El Core no puede arrancar: lo dice por `stderr` y avisa a la persona.
    fn refuse_to_start(&self, e: &OpenStoreError) -> String {
        let msg = format!("Lixbon no puede iniciar el Core: {e}");
        eprintln!("[core] {msg}");
        if let Some(host) = self.host.get() {
            host.notify("Lixbon no puede iniciar", &msg);
        }
        msg
    }

    pub(super) fn close_idle_runs(&self) {
        let live: Vec<String> = self.terms.lock().map(|t| t.keys().cloned().collect()).unwrap_or_default();
        let idle = self.lock().idle_runs(state::now_ms(), IDLE_CLOSE_MS, &live);
        for run in idle {
            let noted = self.mutate(|st| {
                let Some(root) = st.runs.get(&run).map(|r| r.root.clone()) else {
                    st.no_change();
                    return Ok(false);
                };
                if let Ok(id) = st.post(&root, &root, Kind::Note, "Run cerrado por inactividad (30 min sin actividad ni hijas en marcha)", None) {
                    st.mark_read(&[id]);
                }
                Ok(true)
            });
            if !matches!(noted, Ok(true)) {
                continue;
            }
            let _ = self.close_run(&run, false);
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut terms) = self.terms.lock() {
            for t in terms.values_mut() {
                t.kill();
            }
            terms.clear();
        }
        self.stop_server();
    }

    pub(super) fn start_server(self: &Arc<Self>) -> Result<(), String> {
        let mut slot = self.server.lock().map_err(|_| "Estado interno corrupto")?;
        if slot.is_some() {
            return Ok(());
        }
        let h = server::start(self.clone())?;
        write_private_json(&discovery_file(), &json!({
            "port": h.port, "token": h.token, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION"),
            "lxo": lxo_path(),
        }))?;
        *slot = Some(h);
        Ok(())
    }

    pub(super) fn stop_server(&self) {
        if let Some(h) = self.server.lock().ok().and_then(|mut s| s.take()) {
            h.stop();
            let _ = std::fs::remove_file(discovery_file());
        }
    }
}
