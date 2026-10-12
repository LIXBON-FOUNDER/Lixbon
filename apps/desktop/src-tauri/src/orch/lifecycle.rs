//! Arranque y parada del Core: hilos de barrido, servidor local y cierre de runs inactivos.

use std::sync::Arc;
use std::time::Duration;
use serde_json::json;
use super::host::Host;
use super::{Core, IDLE_CLOSE_MS, SWEEP_EVERY, Settings, agents, data_dir, discovery_file, lxo_path, read_json, server, skill, state, write_json, write_private_json};
use super::state::{Kind, State};

impl Core {
    pub fn init(self: &Arc<Self>, host: Arc<dyn Host>) {
        self.set_host(host);
        let settings: Settings = read_json(&data_dir().join("settings.json")).unwrap_or_default();
        let mut st: State = read_json(&data_dir().join("state.json")).unwrap_or_default();
        st.orphan_all();
        let _ = write_json(&data_dir().join("state.json"), &st);
        *self.lock() = st;
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
    }

    pub(super) fn close_idle_runs(&self) {
        let live: Vec<String> = self.terms.lock().map(|t| t.keys().cloned().collect()).unwrap_or_default();
        let idle = self.lock().idle_runs(state::now_ms(), IDLE_CLOSE_MS, &live);
        for run in idle {
            {
                let mut st = self.lock();
                let Some(root) = st.runs.get(&run).map(|r| r.root.clone()) else { continue };
                if let Ok(id) = st.post(&root, &root, Kind::Note, "Run cerrado por inactividad (30 min sin actividad ni hijas en marcha)", None) {
                    st.mark_read(&[id]);
                }
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
