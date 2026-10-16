//! Orquestador de agentes (experimental), al estilo de Orca. El agente con el
//! que habla el usuario es el coordinador: reparte tareas entre agentes hijos
//! (Claude Code, Codex, Cursor, OpenCode…) eligiendo agente y modelo, espera sus
//! informes, integra y responde. Todos hablan con Lixbon por `lxo` (HTTP local,
//! ver `server.rs`); cada hijo corre en su terminal, con su rama y su worktree.

mod agents;
mod authority;
mod boot_authority;
mod client_identity;
#[cfg(test)]
mod boot_tests;
// E1b se entrega por bloques: parte del vocabulario (`project`, `idempotent`, `by`, entidades de
// proyecto y lanzamiento…) la estrenan los bloques siguientes (decisiones, efectos, Projects, spawn).
#[cfg_attr(not(test), allow(dead_code))]
mod events;
mod event_kinds;
mod events_read;
#[cfg(test)]
mod events_read_tests;
mod effect_journal;
mod pr_url;
mod tx_ops;
#[cfg(test)]
mod events_tests;
#[cfg(test)]
mod tx_ops_tests;
#[cfg(test)]
mod spawn_cleanup_tests;
#[cfg(test)]
mod hardening_tests;
mod projects;
mod project_ops;
#[cfg(test)]
mod projects_tests;
#[cfg(test)]
mod project_ops_tests;
#[cfg(test)]
mod project_decisions_tests;
#[cfg(test)]
mod record_facts_tests;
#[cfg(test)]
mod crash_tests;
#[cfg(test)]
mod migration_gate_tests;
mod mirror;
#[cfg(test)]
mod authority_tests;
mod approval;
mod spawn_approval;
mod providers;
mod codex_session;
mod codex_term;

pub use codex_session::SessionInfo as CodexSessionInfo;
pub use codex_term::{CodexTerms, Listed as CodexTermListed};
mod delivery;
mod git;
mod integration;
mod issues;
mod review;
mod pty;
mod roles;
mod worktree_env;
#[cfg(test)]
mod lixbon_cli_tests;
#[cfg(test)]
mod codex_history_tests;
mod server;
pub(crate) mod skill;
pub mod state;
mod args;
mod commands;
mod fsio;
mod host;
mod lifecycle;
mod mutation;
#[cfg(test)]
mod mutation_tests;
mod release;
mod rpc;
mod snapshot;
mod spawn;
mod store_boot;
mod taskfile;
mod tauri_host;
mod term_events;
#[cfg(test)]
mod tests;
mod ui_calls;
mod vocab;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use host::Host;
use state::{Kind, State};
#[cfg(test)]
use state::Status;

pub enum Caller {
    /// `lxo` desde una terminal: con id si es una tarea, sin él si aún no lo es.
    Agent(Option<String>),
    /// La interfaz de Lixbon: solo observa y, si hace falta, detiene.
    User,
}

/// Un nivel: el coordinador y sus hijos. Un hijo no reparte trabajo.
const MAX_DEPTH: u32 = 1;
const MODEL_TRIES: u32 = 10;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub enabled: bool,
    pub notify_phases: bool,
    pub notify_done: bool,
    pub notify_questions: bool,
    /// Modelo y esfuerzo de cada rol del equipo (ver `roles.rs`).
    pub roles: BTreeMap<String, roles::RoleCfg>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { enabled: false, notify_phases: true, notify_done: true, notify_questions: true, roles: roles::defaults() }
    }
}

pub struct Core {
    /// Quien aloja al Core (Desktop hoy): eventos, notificaciones y cuenta. Ver `host.rs`.
    host: OnceLock<Arc<dyn Host>>,
    /// Almacén SQLite: instantánea de arranque en C1; `state.json` sigue siendo la
    /// fuente operativa. Único punto de contacto del Core con el `Store` (ver `store_boot.rs`).
    storage: store_boot::CoreStorage,
    /// El estado solo se lee con `lock()` y solo se escribe con `mutate()` (`mutation.rs`).
    state: mutation::StateCell,
    /// Dónde se confirma una mutación, reintentos y modo solo lectura (`mutation.rs`).
    persister: mutation::Persister,
    cv: Condvar,
    terms: Mutex<HashMap<String, pty::AgentTerm>>,
    settings: Mutex<Settings>,
    /// Identidad autenticada del límite Tauri, estable para esta instalación.
    desktop_identity: Mutex<Option<crate::store::AuthenticatedClient>>,
    server: Mutex<Option<server::Handle>>,
    /// Lanzamientos esperando la aprobación de la persona (solo en memoria).
    pending: Mutex<HashMap<String, spawn_approval::Entry>>,
    /// Serializa las transiciones de un pendiente (ver `spawn_approval::Core::gate`).
    pend_gate: Mutex<()>,
    /// Cómo se resuelve la política efectiva (las pruebas no consultan CLIs reales).
    resolver: Resolver,
    ttl_ms: u64,
    #[cfg(test)]
    launched: Mutex<Vec<String>>,
    /// En pruebas: al arrancar la fase git de la snapshot avisa por el canal y
    /// espera en la barrera, para que la prueba mire el lock en ese punto exacto.
    #[cfg(test)]
    snapshot_git_hook: Mutex<Option<(std::sync::mpsc::Sender<()>, Arc<std::sync::Barrier>)>>,
    /// En pruebas: puntos de fallo/observación dentro de `create_child` (ver `spawn.rs`).
    #[cfg(test)]
    spawn_hook: Mutex<Option<spawn::SpawnHook>>,
}

pub type Resolver = fn(&str, &str, Option<&str>, &str) -> agents::Policy;

fn resolve_real(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> agents::Policy {
    agents::resolve_task_policy(provider, profile, role, worktree, agents::Delivery::FileOrMarkers)
}

pub struct Orch(pub Arc<Core>);

impl Default for Orch {
    fn default() -> Self {
        Orch(Arc::new(Core {
            host: OnceLock::new(),
            storage: store_boot::CoreStorage::default(),
            state: mutation::StateCell::default(),
            persister: mutation::Persister::default(),
            cv: Condvar::new(),
            terms: Mutex::new(HashMap::new()),
            settings: Mutex::new(Settings::default()),
            desktop_identity: Mutex::new(None),
            server: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            pend_gate: Mutex::new(()),
            resolver: resolve_real,
            ttl_ms: spawn_approval::ttl_ms(),
            #[cfg(test)]
            launched: Mutex::new(Vec::new()),
            #[cfg(test)]
            snapshot_git_hook: Mutex::new(None),
            #[cfg(test)]
            spawn_hook: Mutex::new(None),
        }))
    }
}


pub use commands::*;
pub use fsio::{lxo_path, random_token};
pub use tauri_host::TauriHost;
use args::{b, kinds, n, s};
use fsio::{core_dir, data_dir, discovery_file, read_json, write_json, write_private_json};
use taskfile::task_file;

/// Destino de `orch_integrate` para las hijas de una tarea: su carpeta y la rama
/// que tiene ahora (integration.rs integra en la carpeta del padre).
pub(crate) fn integrate_target(dir: &str) -> Value {
    json!({ "dir": dir, "branch": git::current_branch(dir) })
}

const MAX_WAIT: Duration = Duration::from_secs(30 * 60);
const IDLE_CLOSE_MS: u64 = 30 * 60 * 1000;
const SWEEP_EVERY: Duration = Duration::from_secs(60);
const CLOSE_REMINDER: &str = "No quedan hijas en marcha. Si el objetivo está cumplido e integrado, termina con `lxo run close`.";

impl Core {
    /// Política efectiva de una hija: la del perfil (vía `resolver`) más el modelo
    /// pedido (aviso del modo plan, modelo no verificado). La misma al pedir
    /// aprobación, al aprobar y al lanzar.
    pub(crate) fn task_policy(&self, provider: &str, profile: &str, role: Option<&str>, cwd: &str, model: Option<&str>) -> agents::Policy {
        let mut policy = (self.resolver)(provider, profile, role, cwd);
        agents::warn_plan_model(&mut policy, model);
        if let Some(m) = model {
            agents::mark_model(&mut policy, Some(m), providers::model_verified(provider, m));
        }
        agents::set_model(&mut policy, model);
        policy
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Entrega el host al Core (una sola vez). `init` lo hace al arrancar; las
    /// pruebas lo usan para dar un host falso sin tocar el disco.
    pub(crate) fn set_host(&self, host: Arc<dyn Host>) {
        let _ = self.host.set(host);
    }

    /// Avisa a los clientes de un evento. Sin host (antes de `init`) no hace nada.
    pub(super) fn emit(&self, event: &str, payload: &Value) {
        if let Some(host) = self.host.get() {
            host.emit(event, payload);
        }
    }

    /// Avisa de que el estado cambió (`orch:changed`, sin carga útil).
    pub(super) fn emit_changed(&self) {
        self.emit("orch:changed", &Value::Null);
    }

    fn me(caller: &Caller) -> Result<String, String> {
        match caller {
            Caller::Agent(Some(id)) => Ok(id.clone()),
            Caller::Agent(None) => Err("No eres una tarea del orquestador. Si vas a coordinar, empieza con: lxo run create --objective \"...\"".into()),
            Caller::User => Err("Esta acción la hace un agente, no la interfaz".into()),
        }
    }

    fn check_manages(st: &State, caller: &Caller, target: &str) -> Result<(), String> {
        st.task(target)?;
        match caller {
            Caller::User => Ok(()),
            _ => {
                let me = Self::me(caller)?;
                if me == target {
                    return Err("Esta acción se hace sobre una tarea hija, no sobre ti mismo".into());
                }
                st.ensure_manages(&me, target)
            }
        }
    }

    /// Espera mensajes sin leer para `to` y los marca como leídos.
    ///
    /// Semántica ante un fallo de persistencia: los mensajes SE ENTREGAN igualmente
    /// aunque no se pueda persistir el «leído» (el Core pasa a solo lectura y avisa).
    /// Como el «leído» no quedó guardado, un mensaje puede reaparecer en una llamada
    /// posterior o tras reiniciar. Se prefiere duplicar temporalmente a perder información.
    fn wait_for(&self, to: &str, kinds: &[Kind], reply_to: Option<u64>, timeout: Duration) -> Vec<state::Message> {
        let deadline = Instant::now() + timeout.min(MAX_WAIT);
        let mut st = self.lock();
        loop {
            let found = st.unread(to, kinds, reply_to);
            if !found.is_empty() {
                let ids: Vec<u64> = found.iter().map(|m| m.id).collect();
                // Si no se pudo persistir el «leído», los mensajes se entregan igualmente
                // (peor una entrega repetida que perderlos); el Core ya avisó del fallo.
                let _ = self.mutate_locked(&mut st, |tx| {
                    tx.mark_read(&ids);
                    Ok(())
                });
                return found;
            }
            let now = Instant::now();
            if now >= deadline {
                return vec![];
            }
            st = st.wait(&self.cv, deadline - now);
        }
    }
}
