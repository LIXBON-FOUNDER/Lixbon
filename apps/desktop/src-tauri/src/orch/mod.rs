//! Orquestador de agentes (experimental), al estilo de Orca. El agente con el
//! que habla el usuario es el coordinador: reparte tareas entre agentes hijos
//! (Claude Code, Codex, Cursor, OpenCode…) eligiendo agente y modelo, espera sus
//! informes, integra y responde. Todos hablan con Lixbon por `lxo` (HTTP local,
//! ver `server.rs`); cada hijo corre en su terminal, con su rama y su worktree.

mod agents;
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
mod lifecycle;
mod release;
mod rpc;
mod snapshot;
mod spawn;
mod taskfile;
mod term_events;
#[cfg(test)]
mod tests;
mod ui_calls;
mod vocab;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

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
    app: OnceLock<AppHandle>,
    state: Mutex<State>,
    cv: Condvar,
    terms: Mutex<HashMap<String, pty::AgentTerm>>,
    settings: Mutex<Settings>,
    server: Mutex<Option<server::Handle>>,
    /// Lanzamientos esperando la aprobación de la persona (solo en memoria).
    pending: Mutex<HashMap<String, spawn_approval::Entry>>,
    /// Cómo se resuelve la política efectiva (las pruebas no consultan CLIs reales).
    resolver: Resolver,
    ttl_ms: u64,
    #[cfg(test)]
    launched: Mutex<Vec<String>>,
    #[cfg(test)]
    events: Mutex<Vec<(String, Value)>>,
    /// En pruebas: al arrancar la fase git de la snapshot avisa por el canal y
    /// espera en la barrera, para que la prueba mire el lock en ese punto exacto.
    #[cfg(test)]
    snapshot_git_hook: Mutex<Option<(std::sync::mpsc::Sender<()>, Arc<std::sync::Barrier>)>>,
}

pub type Resolver = fn(&str, &str, Option<&str>, &str) -> agents::Policy;

fn resolve_real(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> agents::Policy {
    agents::resolve_task_policy(provider, profile, role, worktree, agents::Delivery::FileOrMarkers)
}

pub struct Orch(pub Arc<Core>);

impl Default for Orch {
    fn default() -> Self {
        Orch(Arc::new(Core {
            app: OnceLock::new(),
            state: Mutex::new(State::default()),
            cv: Condvar::new(),
            terms: Mutex::new(HashMap::new()),
            settings: Mutex::new(Settings::default()),
            server: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            resolver: resolve_real,
            ttl_ms: spawn_approval::ttl_ms(),
            #[cfg(test)]
            launched: Mutex::new(Vec::new()),
            #[cfg(test)]
            events: Mutex::new(Vec::new()),
            #[cfg(test)]
            snapshot_git_hook: Mutex::new(None),
        }))
    }
}


pub use commands::*;
pub use fsio::{lxo_path, random_token};
use args::{b, kinds, n, s};
use fsio::{data_dir, discovery_file, read_json, write_json, write_private_json};
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

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Persiste, despierta a los que esperan en `wait`/`ask`, avisa a la UI y
    /// notifica los mensajes nuevos.
    fn commit(&self, st: &State, new: &[u64]) {
        let _ = write_json(&data_dir().join("state.json"), st);
        self.cv.notify_all();
        let Some(app) = self.app.get() else { return };
        let _ = app.emit("orch:changed", ());
        let cfg = self.settings();
        for m in st.messages.iter().filter(|m| new.contains(&m.id)) {
            let wanted = match m.kind {
                Kind::Phase => cfg.notify_phases,
                Kind::Done | Kind::Exited => cfg.notify_done,
                Kind::Question => cfg.notify_questions,
                Kind::Reply | Kind::Note => false,
            };
            if !wanted {
                continue;
            }
            let who = st.tasks.get(&m.from).map(|t| format!("{} · {}", t.agent, t.title)).unwrap_or_default();
            let title = match m.kind {
                Kind::Question => format!("Pregunta de {who}"),
                Kind::Exited => format!("Se cerró {who}"),
                _ => format!("Orquestador · {who}"),
            };
            let _ = app.notification().builder().title(title).body(&m.body).show();
        }
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

    fn wait_for(&self, to: &str, kinds: &[Kind], reply_to: Option<u64>, timeout: Duration) -> Vec<state::Message> {
        let deadline = Instant::now() + timeout.min(MAX_WAIT);
        let mut st = self.lock();
        loop {
            let found = st.unread(to, kinds, reply_to);
            if !found.is_empty() {
                let ids: Vec<u64> = found.iter().map(|m| m.id).collect();
                st.mark_read(&ids);
                self.commit(&st, &[]);
                return found;
            }
            let now = Instant::now();
            if now >= deadline {
                return vec![];
            }
            st = self.cv.wait_timeout(st, deadline - now).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0);
        }
    }
}
