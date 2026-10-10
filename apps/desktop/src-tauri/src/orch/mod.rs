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

pub use codex_term::{CodexTerms, Listed as CodexTermListed};
mod delivery;
mod git;
mod integration;
mod issues;
mod review;
mod pty;
mod roles;
mod server;
pub(crate) mod skill;
pub mod state;

use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State as TauriState};
use tauri_plugin_notification::NotificationExt;

use state::{Kind, NewTask, State, Status, Task};

pub enum Caller {
    /// `lxo` desde una terminal: con id si es una tarea, sin él si aún no lo es.
    Agent(Option<String>),
    /// La interfaz de Lixbon: solo observa y, si hace falta, detiene.
    User,
}

/// Un nivel: el coordinador y sus hijos. Un hijo no reparte trabajo.
const MAX_DEPTH: u32 = 1;

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

pub fn random_token() -> String {
    let part = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(state::now_ms() as u128 ^ std::process::id() as u128);
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

fn lixbon_dir() -> PathBuf {
    skill::home().unwrap_or_else(std::env::temp_dir).join(".lixbon")
}

fn data_dir() -> PathBuf {
    // Las pruebas nunca tocan el state.json real del usuario.
    if cfg!(test) {
        return std::env::temp_dir().join(format!("lixbon-orch-test-{}", std::process::id()));
    }
    lixbon_dir().join("orch")
}

fn discovery_file() -> PathBuf {
    lixbon_dir().join("orch.json")
}

/// `lxo` viaja junto al ejecutable de Lixbon (sidecar de Tauri).
pub fn lxo_path() -> PathBuf {
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    dir.join(if cfg!(windows) { "lxo.exe" } else { "lxo" })
}

/// Destino de `orch_integrate` para las hijas de una tarea: su carpeta y la rama
/// que tiene ahora (integration.rs integra en la carpeta del padre).
pub(crate) fn integrate_target(dir: &str) -> Value {
    json!({ "dir": dir, "branch": git::current_branch(dir) })
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn s(args: &Value, key: &str) -> String {
    args.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn b(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn n(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

fn kinds(args: &Value) -> Vec<Kind> {
    s(args, "types").split(',').filter_map(Kind::parse).collect()
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

    pub fn init(self: &Arc<Self>, app: AppHandle) {
        let _ = self.app.set(app);
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

    fn close_idle_runs(&self) {
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

    fn start_server(self: &Arc<Self>) -> Result<(), String> {
        let mut slot = self.server.lock().map_err(|_| "Estado interno corrupto")?;
        if slot.is_some() {
            return Ok(());
        }
        let h = server::start(self.clone())?;
        write_json(&discovery_file(), &json!({
            "port": h.port, "token": h.token, "pid": std::process::id(), "version": env!("CARGO_PKG_VERSION"),
        }))?;
        *slot = Some(h);
        Ok(())
    }

    fn stop_server(&self) {
        if let Some(h) = self.server.lock().ok().and_then(|mut s| s.take()) {
            h.stop();
            let _ = std::fs::remove_file(discovery_file());
        }
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

    pub fn rpc(self: &Arc<Self>, caller: Caller, cwd: &str, cmd: &str, args: &Value) -> Result<Value, String> {
        if matches!(caller, Caller::Agent(_)) && !self.settings().enabled {
            return Err("El orquestador está desactivado: actívalo en Lixbon → Ajustes → Orquestador".into());
        }
        if let Caller::Agent(Some(id)) = &caller {
            if b(args, "session") && cmd != "run_create" && !self.lock().tasks.contains_key(id) {
                return Err("sesion-obsoleta".into());
            }
        }
        if let Caller::Agent(Some(id)) = &caller {
            self.lock().touch_run(id);
        }
        // Decisiones humanas (integrar, PR, revisar) y lecturas cerradas (diff de
        // revisión): ni orch_call ni el servidor de lxo llegan a ellas.
        if let Some(why) = review::closed_to_agents(cmd) {
            return Err(why.into());
        }
        match cmd {
            "status" => {
                let st = self.lock();
                let task = match &caller {
                    Caller::Agent(Some(id)) => Some(st.task(id)?.clone()),
                    _ => None,
                };
                let objective = task.as_ref().and_then(|t| st.runs.get(&t.run)).map(|r| r.objective.clone());
                Ok(json!({
                    "version": env!("CARGO_PKG_VERSION"),
                    "role": match &task { Some(t) if t.parent.is_some() => "worker", Some(_) => "coordinator", None => "external" },
                    "task": task,
                    "objective": objective,
                    "can_spawn": task.as_ref().map(|t| t.depth < MAX_DEPTH).unwrap_or(true),
                    "agents": agents::AGENTS.iter().map(|a| a.id).collect::<Vec<_>>(),
                }))
            }
            "run_create" => {
                if let Caller::Agent(Some(id)) = &caller {
                    if !b(args, "session") {
                        return Err(format!("Ya eres la tarea {id}: crea hijos directamente con lxo spawn"));
                    }
                    self.lock().session_replaceable(id)?;
                }
                let objective = s(args, "objective");
                if objective.is_empty() {
                    return Err("Falta --objective".into());
                }
                let repo = git::toplevel(cwd).ok_or("El orquestador necesita un repositorio git: ejecútalo dentro de uno")?;
                let agent = Some(s(args, "agent")).filter(|a| !a.is_empty()).unwrap_or_else(|| "coordinador".into());
                let mut st = self.lock();
                let (run, task) = st.create_run(&objective, NewTask {
                    agent,
                    model: None,
                    effort: None,
                    role: None,
                    title: objective.chars().take(60).collect(),
                    spec: objective.clone(),
                    repo,
                    cwd: cwd.into(),
                    branch: git::current_branch(cwd),
                    base: None,
                    worktree: None,
                    external: true,
                });
                st.mark_running(&task)?;
                self.commit(&st, &[]);
                Ok(json!({ "run": run, "task": task }))
            }
            // Ningún lanzamiento arranca sin la persona: queda pendiente (approval.rs).
            "spawn" => self.spawn_request(&caller, args),
            "spawn_status" => self.spawn_status(&caller, args),
            "agents" => Ok(json!({ "agents": agents::available(b(args, "refresh")) })),
            "roles" => Ok(roles::describe(&self.settings().roles)),
            "issue" => {
                // El rol de la hija firma sus comentarios como informe de agente.
                let rol = match &caller {
                    Caller::Agent(Some(id)) => self.lock().task(id).ok().and_then(|t| t.role.clone()),
                    _ => None,
                };
                let app = self.app.get().ok_or("La app todavía no ha arrancado")?;
                issues::ejecutar(app, args, rol)
            }
            "continue" => self.follow_up(&caller, args),
            "phase" => {
                let me = Self::me(&caller)?;
                let name = s(args, "name");
                if name.is_empty() {
                    return Err("Falta el nombre de la fase".into());
                }
                let mut st = self.lock();
                let msg = st.phase(&me, &name, b(args, "done"), &s(args, "note"))?;
                self.commit(&st, &msg.into_iter().collect::<Vec<_>>());
                Ok(json!({ "task": me, "phase": name }))
            }
            "done" => {
                let me = Self::me(&caller)?;
                let files = args.get("files").and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                    .unwrap_or_default();
                let summary = s(args, "summary");
                let report = self.store_report(&me, &s(args, "report"), &s(args, "report_text"), &summary)?;
                let mut st = self.lock();
                let msg = st.done(&me, !b(args, "failed"), &summary, files, Some(report.clone()))?;
                st.task_mut(&me)?.delivery_channel = Some("lxo_done".into());
                self.commit(&st, &msg.into_iter().collect::<Vec<_>>());
                Ok(json!({ "task": me, "status": st.task(&me)?.status, "report": report }))
            }
            "ask" => {
                let me = Self::me(&caller)?;
                let question = s(args, "question");
                if question.is_empty() {
                    return Err("Falta la pregunta".into());
                }
                let mut st = self.lock();
                let id = st.ask(&me, &question)?;
                self.commit(&st, &[id]);
                Ok(json!({ "question": id }))
            }
            "await_reply" => {
                let me = Self::me(&caller)?;
                let q = n(args, "question").ok_or("Falta el id de la pregunta")?;
                let timeout = Duration::from_millis(n(args, "timeout_ms").unwrap_or(600_000));
                let found = self.wait_for(&me, &[Kind::Reply], Some(q), timeout);
                Ok(match found.first() {
                    Some(m) => json!({ "answer": m.body, "from": m.from }),
                    None => json!({ "timeout": true }),
                })
            }
            "reply" => {
                let q = n(args, "question").ok_or("Falta el id de la pregunta")?;
                let answer = s(args, "answer");
                let mut st = self.lock();
                let from = match &caller {
                    Caller::User => st.messages.iter().find(|m| m.id == q).map(|m| m.to.clone()).ok_or_else(|| format!("No existe la pregunta {q}"))?,
                    _ => Self::me(&caller)?,
                };
                let id = st.reply(&from, q, &answer)?;
                self.commit(&st, &[id]);
                Ok(json!({ "reply": id }))
            }
            "send" => {
                let to = s(args, "to");
                let body = s(args, "body");
                let mut st = self.lock();
                Self::check_manages(&st, &caller, &to)?;
                let from = match &caller {
                    Caller::User => st.task(&to)?.parent.clone().unwrap_or_else(|| to.clone()),
                    _ => Self::me(&caller)?,
                };
                let id = st.post(&from, &to, Kind::Note, &body, None)?;
                self.commit(&st, &[id]);
                Ok(json!({ "message": id }))
            }
            "wait" => {
                let me = Self::me(&caller)?;
                let mut k = kinds(args);
                if k.is_empty() {
                    k = vec![Kind::Done, Kind::Question, Kind::Exited];
                }
                let timeout = Duration::from_millis(n(args, "timeout_ms").unwrap_or(600_000));
                let found = self.wait_for(&me, &k, None, timeout);
                let (pending, hint) = {
                    let st = self.lock();
                    let hint = st.task(&me).ok().filter(|t| t.parent.is_none()).map(|_| CLOSE_REMINDER);
                    (st.children_open(&me), hint)
                };
                let hint = hint.filter(|_| pending.is_empty());
                Ok(json!({ "messages": found, "timeout": found.is_empty(), "open_children": pending, "hint": hint }))
            }
            "check" | "inbox" => {
                let me = Self::me(&caller)?;
                let mut st = self.lock();
                let found = st.unread(&me, &kinds(args), None);
                if cmd == "check" {
                    let ids: Vec<u64> = found.iter().map(|m| m.id).collect();
                    st.mark_read(&ids);
                    self.commit(&st, &[]);
                }
                Ok(json!({ "messages": found }))
            }
            "list" => {
                let st = self.lock();
                let run = match &caller {
                    Caller::Agent(Some(id)) => Some(st.task(id)?.run.clone()),
                    _ => Some(s(args, "run")).filter(|r| !r.is_empty()),
                };
                let tasks: Vec<&Task> = st.tree().into_iter().filter(|t| run.as_ref().is_none_or(|r| &t.run == r)).collect();
                Ok(json!({ "tasks": tasks }))
            }
            "show" => {
                let id = Some(s(args, "task")).filter(|t| !t.is_empty()).map(Ok).unwrap_or_else(|| Self::me(&caller))?;
                let st = self.lock();
                let task = st.task(&id)?.clone();
                let messages: Vec<_> = st.messages.iter().filter(|m| m.from == id || m.to == id).cloned().collect();
                Ok(json!({ "task": task, "messages": messages, "children": st.children(&id) }))
            }
            "diff" => {
                let (branch, base, dir) = self.branch_of(&caller, &s(args, "task"))?;
                let (stat, diff) = git::diff(&dir, &base, &branch)?;
                Ok(json!({ "branch": branch, "base": base, "stat": stat, "diff": diff }))
            }
            // Integrar es decisión de una persona: `lxo merge` ya no integra.
            "merge" => Err(integration::AGENT_REJECT.into()),
            // Publicar (push + PR) es decisión de una persona: orch_publish_pr.
            "pr" => Err(integration::PR_REJECT.into()),
            "stop" => {
                let id = s(args, "task");
                {
                    let st = self.lock();
                    Self::check_manages(&st, &caller, &id)?;
                }
                self.kill_term(&id);
                let mut st = self.lock();
                let msg = st.close(&id, Status::Stopped, "detenida por su coordinador")?;
                self.commit(&st, &msg.into_iter().collect::<Vec<_>>());
                Ok(json!({ "task": id, "status": "stopped" }))
            }
            "release" => self.release(&caller, &s(args, "task"), b(args, "force")),
            "run_close" => {
                let me = Self::me(&caller)?;
                let run = {
                    let st = self.lock();
                    let t = st.task(&me)?;
                    if t.parent.is_some() {
                        return Err("Solo el coordinador del run puede cerrarlo".into());
                    }
                    t.run.clone()
                };
                self.close_run(&run, b(args, "force"))
            }
            "remove_run" => {
                if !matches!(caller, Caller::User) {
                    return Err("Solo desde la interfaz".into());
                }
                let run = s(args, "run");
                self.expire_run_pending(&run);
                let ids: Vec<String> = self.lock().tasks.values().filter(|t| t.run == run).map(|t| t.id.clone()).collect();
                for id in &ids {
                    self.kill_term(id);
                }
                let (_, kept) = self.free_worktrees(&run, false);
                let mut st = self.lock();
                st.remove_run(&run);
                self.commit(&st, &[]);
                Ok(json!({ "removed": run, "kept": kept }))
            }
            other => Err(format!("Comando desconocido: {other}")),
        }
    }

    fn branch_of(&self, caller: &Caller, id: &str) -> Result<(String, String, String), String> {
        let st = self.lock();
        Self::check_manages(&st, caller, id)?;
        let t = st.task(id)?;
        let branch = t.branch.clone().ok_or_else(|| format!("{id} no tiene rama propia (se lanzó sin worktree)"))?;
        Ok((branch, t.base.clone().unwrap_or_else(|| "HEAD".into()), t.cwd.clone()))
    }

    /// Valida lo que pide el agente (sin crear nada) y arma el pendiente.
    fn plan_spawn(&self, caller: &Caller, args: &Value) -> Result<spawn_approval::PendingSpawn, String> {
        let parent_id = Self::me(caller)?;
        let spec = s(args, "task");
        if spec.is_empty() {
            return Err("Falta --task con el encargo completo de la hija".into());
        }
        let role = Some(s(args, "role")).filter(|r| !r.is_empty());
        let (agent, model, effort, read_only) = match &role {
            // Con rol, agente, modelo y esfuerzo los fija el usuario en Ajustes: el
            // coordinador no puede cambiarlos (es donde se controla el gasto).
            Some(id) => {
                if !s(args, "model").is_empty() || !s(args, "effort").is_empty() || !s(args, "agent").is_empty() {
                    return Err(format!(
                        "Con --role {id} no pases --agent, --model ni --effort: los fija el usuario en Ajustes → Orquestador (míralos con lxo roles)"
                    ));
                }
                let r = roles::resolve(&self.settings().roles, id)?;
                (r.provider, r.model, r.effort, r.spec.read_only)
            }
            None => {
                let agent = s(args, "agent");
                if agent.is_empty() {
                    return Err("Falta --role (mira `lxo roles`) o --agent (mira `lxo agents`)".into());
                }
                (agent, Some(s(args, "model")).filter(|m| !m.is_empty()), Some(s(args, "effort")).filter(|m| !m.is_empty()), false)
            }
        };
        // Se valida antes de crear nada: un agente o modelo mal escrito no deja restos.
        // Perfil pedido (por defecto el del rol); se re-resuelve en el host al aprobar y al lanzar.
        let profile = match Some(s(args, "profile")).filter(|p| !p.is_empty()) {
            Some(p) => agents::Profile::parse(&p).ok_or_else(|| format!("Perfil desconocido: {p}"))?,
            None => agents::Profile::for_role(read_only),
        };
        agents::launch(&agent, model.as_deref(), effort.as_deref(), "x", profile, role.as_deref())?;
        let title = Some(s(args, "name")).filter(|a| !a.is_empty())
            .unwrap_or_else(|| spec.lines().next().unwrap_or("").chars().take(60).collect());
        // Un rol de solo lectura no necesita rama: lee en la carpeta del coordinador.
        let shared = b(args, "shared") || read_only;
        let parent = {
            let st = self.lock();
            let parent = st.task(&parent_id)?.clone();
            if parent.depth >= MAX_DEPTH {
                return Err("Una tarea hija no puede lanzar otras: pídeselo a tu coordinador con lxo ask".into());
            }
            if st.runs.get(&parent.run).is_none_or(|r| r.closed) {
                return Err("Tu run está cerrado: no se pueden lanzar hijas".into());
            }
            parent
        };
        let base = Some(s(args, "base")).filter(|b| !b.is_empty());
        Ok(self.new_pending(&parent, spawn_approval::NewPending {
            provider: agent, profile: profile.id().to_string(), role, model, effort, title, spec, shared, base,
        }))
    }

    /// Crea y lanza la hija de un pendiente que la persona aprobó. `argv` es el que
    /// resolvió el host (nunca el que llega de la UI).
    fn create_child(self: &Arc<Self>, p: &spawn_approval::PendingSpawn, argv: Vec<String>, ack_unverified: bool) -> Result<Value, String> {
        let parent_id = p.parent_task.clone();
        let (id, parent) = {
            let mut st = self.lock();
            let parent = st.task(&parent_id)?.clone();
            let id = st.add_child(&parent_id, MAX_DEPTH, NewTask {
                agent: p.provider.clone(), model: p.model.clone(), effort: p.effort.clone(), role: p.role.clone(), title: p.title.clone(), spec: p.spec.clone(),
                repo: parent.repo.clone(), cwd: parent.cwd.clone(), branch: None, base: None, worktree: None, external: false,
            })?;
            let t = st.task_mut(&id)?;
            t.profile = Some(p.profile.clone());
            t.ack_unverified = ack_unverified;
            t.requested_argv = Some(argv);
            (id, parent)
        };

        let prepared = (|| -> Result<(), String> {
            if p.shared {
                return Ok(());
            }
            let base = p.base.clone()
                .or_else(|| git::current_branch(&parent.cwd))
                .unwrap_or_else(|| "HEAD".into());
            let slug = state::slug(&p.title, 32);
            let branch = format!("lx/{}/{id}-{slug}", parent.run);
            // La carpeta es la que se mostró en el pendiente: el argv aprobado la incluye (codex --cd).
            let dir = PathBuf::from(&p.cwd);
            let start = git::head(&parent.cwd);
            git::add_worktree(&parent.repo, &dir, &branch, &base)?;
            let mut st = self.lock();
            let t = st.task_mut(&id)?;
            t.base_commit = start;
            t.cwd = dir.to_string_lossy().into_owned();
            t.worktree = Some(t.cwd.clone());
            t.branch = Some(branch);
            t.base = Some(base);
            Ok(())
        })()
        .and_then(|_| self.ensure_launchable(&id))
        .and_then(|_| self.launch(&id));

        if let Err(e) = prepared {
            self.discard_worktree(&id);
            let mut st = self.lock();
            st.tasks.remove(&id);
            self.commit(&st, &[]);
            return Err(e);
        }
        let mut st = self.lock();
        // Si el agente ya murió al arrancar, la tarea quedó en `exited` y así se informa.
        let _ = st.mark_running(&id);
        let t = st.task(&id)?.clone();
        self.commit(&st, &[]);
        Ok(json!({ "task": t.id, "agent": t.agent, "model": t.model, "effort": t.effort, "role": t.role, "status": t.status, "branch": t.branch, "worktree": t.worktree }))
    }

    /// Trabajo nuevo para una hija que ya entregó, en su misma terminal: conserva
    /// su contexto (como reutilizar la terminal de un worker en Orca).
    fn follow_up(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let id = s(args, "task");
        let spec = s(args, "spec");
        if spec.is_empty() {
            return Err("Falta --task con el nuevo encargo".into());
        }
        {
            let st = self.lock();
            Self::check_manages(&st, caller, &id)?;
        }
        if !self.terms.lock().map(|t| t.contains_key(&id)).unwrap_or(false) {
            return Err(format!("La terminal de {id} ya está cerrada: lanza una hija nueva con lxo spawn"));
        }
        let task = {
            let mut st = self.lock();
            st.reopen(&id, &spec)?;
            let t = st.task(&id)?.clone();
            // n = 1 hasta que haya intentos: se borra lo del intento anterior para no
            // recogerlo otra vez (lo que siga en la terminal lo descarta su idem_key).
            let _ = delivery::prepare(&t.cwd, &id, delivery::ATTEMPT);
            self.commit(&st, &[]);
            t
        };
        let file = Path::new(&task.cwd).join(".lixbon").join("tasks").join(format!("{id}.md"));
        let _ = std::fs::OpenOptions::new().append(true).open(&file).and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "\n## Seguimiento del coordinador\n\n{spec}\n\nAl terminar, escribe un informe nuevo y vuelve a cerrar con lxo done --report (sin red: lxo report).")
        });
        if let Ok(terms) = self.terms.lock() {
            if let Some(t) = terms.get(&id) {
                t.type_prompt(&format!(
                    "Nuevo encargo de tu coordinador (también al final de .lixbon/tasks/{id}.md): {spec} -- Al terminar escribe un informe nuevo y cierra otra vez con lxo done --report."
                ));
            }
        }
        Ok(json!({ "task": id, "status": "running" }))
    }

    /// Copia el informe de la hija junto al coordinador, en `.lixbon/informes/`,
    /// para que lo lea sin entrar en el worktree de nadie.
    fn store_report(&self, id: &str, path: &str, inline: &str, summary: &str) -> Result<String, String> {
        let (task, coordinator) = {
            let st = self.lock();
            let t = st.task(id)?.clone();
            let root = st.runs.get(&t.run).and_then(|r| st.tasks.get(&r.root)).cloned().ok_or("Run sin coordinador")?;
            (t, root)
        };
        let text = if !inline.trim().is_empty() {
            // Las hijas de solo lectura no pueden escribir archivos: mandan el informe por stdin.
            inline.to_string()
        } else if path.is_empty() {
            if summary.is_empty() {
                return Err("Falta --report con tu informe (.md): qué hiciste, archivos, cómo lo verificaste y qué queda.".into());
            }
            format!("# {} · {}\n\n{summary}\n", task.id, task.title)
        } else {
            let p = Path::new(path);
            let full = if p.is_absolute() { p.to_path_buf() } else { Path::new(&task.cwd).join(p) };
            std::fs::read_to_string(&full).map_err(|e| format!("No se pudo leer el informe {}: {e}", full.display()))?
        };
        delivery::write_report(&coordinator, &task, &text)
    }

    fn launch(self: &Arc<Self>, id: &str) -> Result<(), String> {
        #[cfg(test)]
        return self.fake_launch(id);
        #[allow(unreachable_code)]
        let app = self.app.get().ok_or("Lixbon aún no terminó de arrancar")?.clone();
        let (task, parent, objective) = {
            let st = self.lock();
            let t = st.task(id)?.clone();
            let p = t.parent.as_ref().and_then(|p| st.tasks.get(p)).cloned();
            let o = st.runs.get(&t.run).map(|r| r.objective.clone()).unwrap_or_default();
            (t, p, o)
        };
        let dir = Path::new(&task.cwd).join(".lixbon").join("tasks");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Entrega sin red (contrato de informe por archivo): carpeta del intento
        // limpia y nonce nuevo, antes de lanzar.
        let report_path = delivery::prepare(&task.cwd, id, delivery::ATTEMPT)?;
        let nonce = random_token();
        {
            let mut st = self.lock();
            let t = st.task_mut(id)?;
            t.report_nonce = Some(nonce.clone());
            t.delivered.clear();
        }
        let mut task = task;
        task.report_nonce = Some(nonce.clone());

        let prompt = format!("Eres la tarea {id} del orquestador de Lixbon. Lee .lixbon/tasks/{id}.md, ejecuta lxo guide y haz la tarea.");
        let read_only = task.role.as_deref().and_then(roles::spec).is_some_and(|r| r.read_only);
        // Se lanza exactamente el argv de la política efectiva (la misma que muestra
        // orch_resolve_policy); un perfil bloqueado no arranca.
        let profile = task.profile.clone().unwrap_or_else(|| agents::Profile::for_role(read_only).id().to_string());
        // Toda hija entrega con lxo done; se resuelve con el mismo rol que muestra la UI.
        let policy = self.task_policy(&task.agent, &profile, task.role.as_deref(), &task.cwd, task.model.as_deref());
        let plan_mode = agents::is_plan(&policy);
        let record = agents::authorize(&policy, task.requested_argv.as_deref(), task.ack_unverified)?;
        // Codex read-only: `codex exec -o`; Claude Explorar/Proponer: stream-json.
        let last_message = (policy.argv.get(1).map(String::as_str) == Some("exec"))
            .then(|| delivery::last_message_path(&task.cwd, id, delivery::ATTEMPT).to_string_lossy().into_owned());
        let stream_json = policy.argv.iter().any(|a| a == "stream-json");
        let launch = agents::launch_task(&policy, task.model.as_deref(), task.effort.as_deref(), &prompt, last_message.as_deref())?;
        task.last_message_path = last_message.clone();
        task.stream_json = stream_json;
        if let Ok(t) = self.lock().task_mut(id) {
            t.policy = Some(record);
            t.last_message_path = last_message;
            t.stream_json = stream_json;
            t.delivery_channel = None;
            t.model_effective = None;
            t.model_mismatch = false;
            t.model_mismatch_reason = None;
            t.plan_mode = plan_mode;
            t.failure_reason = None;
            t.session_ref = None;
            t.model_source = None;
            t.session_match = None;
            t.attempt_started = Some(state::now_ms());
            t.approval_deadline = None;
            // launch_task ya rechazó un modelo pedido que no entra en el argv.
            t.model_requested = t.model.clone();
        }
        std::fs::write(dir.join(format!("{id}.md")), task_file(&task, parent.as_ref(), &objective))
            .map_err(|e| format!("No se pudo escribir la tarea: {e}"))?;
        git::exclude_lixbon_dir(&task.cwd);

        let lxo = lxo_path();
        let mut path = lxo.parent().map(|p| p.as_os_str().to_owned()).unwrap_or_default();
        if let Some(cur) = std::env::var_os("PATH") {
            path.push(if cfg!(windows) { ";" } else { ":" });
            path.push(cur);
        }
        let mut env = launch.env;
        env.extend([
            ("LXO_TASK_ID".to_string(), id.to_string()),
            ("LXO_RUN_ID".to_string(), task.run.clone()),
            ("LXO_BIN".to_string(), lxo.to_string_lossy().into_owned()),
            ("PATH".to_string(), path.to_string_lossy().into_owned()),
            ("LXO_REPORT_PATH".to_string(), report_path.to_string_lossy().into_owned()),
            ("LXO_REPORT_NONCE".to_string(), nonce),
            ("LXO_REPORT_ATTEMPT".to_string(), delivery::ATTEMPT.to_string()),
        ]);
        let weak = Arc::downgrade(self);
        let tid = id.to_string();
        let (out_event, exit_event) = (format!("orch:term:{id}"), format!("orch:term-exit:{id}"));
        let app_exit = app.clone();
        // Espera de aprobación en la terminal y agente inactivo (orch/approval.rs).
        let guard = Arc::new(Mutex::new(approval::Guard::from_env(state::now_ms())));
        let (guard_out, weak_out, tid_out) = (guard.clone(), Arc::downgrade(self), id.to_string());
        let term = pty::spawn(
            pty::Launch { cwd: &task.cwd, script_dir: &dir.join(id), command: launch.command, env, inject: launch.inject, piped: launch.piped },
            move |text| {
                let change = guard_out.lock().ok().and_then(|mut g| g.on_output(&text, state::now_ms()));
                if let (Some(change), Some(core)) = (change, weak_out.upgrade()) {
                    core.on_approval_change(&tid_out, change);
                }
                let _ = app.emit(&out_event, text);
            },
            move || {
                let _ = app_exit.emit(&exit_event, ());
                if let Some(core) = weak.upgrade() {
                    core.on_exit(&tid);
                }
            },
        )?;
        self.terms.lock().map_err(|_| "Estado interno corrupto")?.insert(id.to_string(), term);
        // Sondeo del report.json y de la salida mientras la terminal siga abierta.
        let weak = Arc::downgrade(self);
        let tid = id.to_string();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let Some(core) = weak.upgrade() else { break };
            let Some(text) = core.term_text(&tid) else { break };
            core.collect(&tid, Some(text), false);
            let timeout = guard.lock().ok().and_then(|g| g.check(state::now_ms()));
            if let Some(t) = timeout {
                core.on_guard_timeout(&tid, t);
                break;
            }
        });
        Ok(())
    }

    fn on_approval_change(&self, id: &str, change: approval::Change) {
        let mut st = self.lock();
        let changed = match change {
            approval::Change::Entered(deadline) => st.await_terminal_approval(id, deadline),
            approval::Change::Left => st.resume_from_approval(id),
        };
        if changed.unwrap_or(false) {
            self.commit(&st, &[]);
        }
    }

    /// Venció la espera de aprobación o el agente lleva demasiado sin escribir: la
    /// tarea queda Failed con su motivo y se mata la PTY con todo su árbol.
    fn on_guard_timeout(&self, id: &str, t: approval::Timeout) {
        {
            let mut st = self.lock();
            if let Ok(msg) = st.fail_with(id, t.reason(), t.message()) {
                self.commit(&st, &msg.into_iter().collect::<Vec<_>>());
            }
        }
        self.kill_term(id);
    }

    fn term_text(&self, id: &str) -> Option<String> {
        let terms = self.terms.lock().ok()?;
        let b = terms.get(id)?.buffer.lock().ok()?;
        Some(String::from_utf8_lossy(&b).into_owned())
    }

    /// Recoge el informe por archivo o por marcadores (orch/delivery.rs) y lo
    /// entrega como un `lxo done`. Al salir el proceso cierra la tarea si falta.
    fn collect(&self, id: &str, terminal: Option<String>, at_exit: bool) {
        let (expect, cwd, delivered, is_final, last_message, stream_json) = {
            let st = self.lock();
            let Ok(t) = st.task(id) else { return };
            (delivery::Expect::of(t), t.cwd.clone(), t.delivered.clone(), t.status.is_final(), t.last_message_path.clone(), t.stream_json)
        };
        if is_final {
            return;
        }
        let found = match &expect {
            Some(ex) => {
                let file = delivery::read_report_file(&delivery::report_path(&cwd, id, ex.attempt));
                // El -o lo escribe codex al terminar: solo se lee al salir el proceso.
                let final_file = last_message.as_ref().filter(|_| at_exit).and_then(|p| delivery::read_final_file(Path::new(p)));
                let src = delivery::Sources {
                    expect_final: last_message.is_some() && at_exit,
                    final_file: final_file.as_deref(),
                    expect_stream: stream_json,
                    file: file.as_deref(),
                    terminal: terminal.as_deref(),
                };
                delivery::find_all(&src, ex, &delivered)
            }
            None => delivery::Found::Nothing,
        };
        let mut st = self.lock();
        match delivery::apply(&mut st, id, found, at_exit) {
            Ok(msgs) => self.commit(&st, &msgs),
            Err(e) if at_exit => {
                let msg = st.close(id, Status::Failed, &format!("informe inválido: {e}")).ok().flatten();
                self.commit(&st, &msg.into_iter().collect::<Vec<_>>());
            }
            Err(_) => {}
        }
    }

    /// Codex: el modelo efectivo sale de `turn_context.model` de su archivo de
    /// sesión; si no se puede leer, `unknown`. Nunca se copia del pedido.
    fn record_codex_model(&self, id: &str, session_id: Option<&str>) {
        let (agent, cwd, since) = {
            let st = self.lock();
            let Ok(t) = st.task(id) else { return };
            (t.agent.clone(), t.cwd.clone(), t.attempt_started.unwrap_or(t.created))
        };
        if agent != "codex" {
            return;
        }
        let r = codex_session::resolve(agents::codex_home().map(|h| h.join("sessions")).as_deref(), session_id, &cwd, since);
        let mut st = self.lock();
        if let Ok(t) = st.task_mut(id) {
            delivery::set_model_effective(t, &r.model);
            t.model_source = Some(r.source().into());
            t.session_match = r.session_match().map(str::to_string);
            t.session_ref = r.session_ref;
        }
        self.commit(&st, &[]);
    }

    fn on_exit(&self, id: &str) {
        let terminal = self.terms.lock().ok()
            .and_then(|mut t| t.remove(id))
            .and_then(|t| t.buffer.lock().ok().map(|b| String::from_utf8_lossy(&b).into_owned()));
        let session_id = terminal.as_deref().and_then(codex_session::session_id_from_terminal);
        self.collect(id, terminal, true);
        self.record_codex_model(id, session_id.as_deref());
        let mut st = self.lock();
        if let Ok(Some(msg)) = st.close(id, Status::Exited, delivery::MISSING) {
            self.commit(&st, &[msg]);
        } else {
            self.commit(&st, &[]);
        }
    }

    fn kill_term(&self, id: &str) -> bool {
        let Some(mut t) = self.terms.lock().ok().and_then(|mut m| m.remove(id)) else { return false };
        t.kill();
        true
    }

    /// Integración aprobada por la persona (comando Tauri `orch_integrate`).
    /// `accept_moved_target`: el `found_commit` que la persona vio y acepta.
    pub fn integrate_from_ui(&self, task: &str, confirm: bool, squash: bool, accept_moved_target: Option<&str>) -> Result<Value, String> {
        let res = integration::integrate(&self.state, true,
            &json!({ "task": task, "confirm": confirm, "squash": squash, "accept_moved_target": accept_moved_target }));
        let st = self.lock();
        self.commit(&st, &[]);
        res.map(|mut v| {
            if v["outcome"] == "merged" {
                v["hint"] = json!(self.close_hint(&st, task));
            }
            v
        })
    }

    /// Diff de revisión de una tarea (comando Tauri `orch_task_diff`).
    pub fn task_diff_from_ui(&self, task_id: &str) -> Result<Value, String> {
        review::task_diff(&self.state, task_id, review::DIFF_LIMIT)
    }

    /// Revisión de la persona (comando Tauri `orch_review_task`).
    pub fn review_from_ui(&self, task_id: &str, decision: &str, head_commit: &str, comment: Option<&str>, confirm: bool) -> Result<Value, String> {
        let out = review::review_task(&self.state, task_id, decision, head_commit, comment, confirm)?;
        if out["outcome"] == "recorded" {
            self.commit(&self.lock(), &[]);
            self.emit(review::EV_REVIEWED, &json!({ "task_id": task_id, "decision": decision, "head_commit": head_commit, "at": out["at"] }));
        }
        Ok(out)
    }

    /// Publicación de PR aprobada por la persona (comando Tauri `orch_publish_pr`).
    pub fn publish_pr_from_ui(&self, task: &str, confirm: bool) -> Result<Value, String> {
        let res = integration::publish_pr(&self.state, true, &json!({ "task": task, "confirm": confirm }), &git::gh_pr);
        let st = self.lock();
        self.commit(&st, &[]);
        res
    }

    fn release(&self, caller: &Caller, id: &str, force: bool) -> Result<Value, String> {
        let (repo, worktree, branch, merged, open) = {
            let st = self.lock();
            Self::check_manages(&st, caller, id)?;
            let t = st.task(id)?;
            (t.repo.clone(), t.worktree.clone(), t.branch.clone(), t.merged, !t.status.is_final())
        };
        if open && !force {
            return Err(format!("{id} sigue en marcha: detenla antes (lxo stop) o usa --force"));
        }
        self.kill_term(id);
        if let Some(wt) = &worktree {
            git::remove_worktree(&repo, wt, force).map_err(|e| format!("{e}\nSi hay cambios sin guardar que quieres descartar, usa --force"))?;
        }
        let branch_deleted = merged && branch.as_ref().is_some_and(|br| git::delete_branch(&repo, br).is_ok());
        let mut st = self.lock();
        if open {
            let _ = st.close(id, Status::Stopped, "liberada por su coordinador");
        }
        let t = st.task_mut(id)?;
        t.worktree = None;
        t.cwd = repo;
        self.commit(&st, &[]);
        let hint = self.close_hint(&st, id);
        Ok(json!({ "task": id, "worktree_removed": worktree.is_some(), "branch_deleted": branch_deleted, "hint": hint }))
    }

    fn close_hint(&self, st: &State, task: &str) -> Option<&'static str> {
        let run = &st.tasks.get(task)?.run;
        let open = st.runs.get(run).is_some_and(|r| !r.closed);
        (open && st.run_wrapped_up(run)).then_some(CLOSE_REMINDER)
    }

    fn ensure_launchable(&self, id: &str) -> Result<(), String> {
        let st = self.lock();
        let t = st.task(id)?;
        if t.status.is_final() || st.runs.get(&t.run).is_none_or(|r| r.closed) {
            return Err("El run se cerró mientras se preparaba la tarea: no se lanzó".into());
        }
        Ok(())
    }

    fn discard_worktree(&self, id: &str) {
        let Some((repo, wt, branch)) = self.lock().tasks.get(id).and_then(|t| Some((t.repo.clone(), t.worktree.clone()?, t.branch.clone()))) else { return };
        if git::remove_worktree(&repo, &wt, true).is_ok() {
            if let Some(b) = branch {
                let _ = git::delete_branch(&repo, &b);
            }
        }
    }

    fn close_run(&self, run: &str, force: bool) -> Result<Value, String> {
        let (stopped, msgs, ids) = {
            let mut st = self.lock();
            let (stopped, msgs) = st.close_run(run, force)?;
            let ids: Vec<String> = st.tasks.values().filter(|t| t.run == run).map(|t| t.id.clone()).collect();
            (stopped, msgs, ids)
        };
        let terminals: Vec<&String> = ids.iter().filter(|id| self.kill_term(id)).collect();
        let (released, kept) = self.free_worktrees(run, force);
        self.commit(&self.lock(), &msgs);
        Ok(json!({ "run": run, "stopped": stopped, "terminals": terminals, "released": released, "kept": kept }))
    }

    /// Libera los worktrees del run cuyas ramas ya están en la del coordinador; las
    /// demás se conservan. Con `force` también se liberan los limpios sin fusionar; los
    /// worktrees con cambios sin commit se conservan siempre y nunca se borra una rama sin fusionar.
    fn free_worktrees(&self, run: &str, force: bool) -> (Vec<Value>, Vec<Value>) {
        let (tasks, into) = {
            let st = self.lock();
            let root = st.runs.get(run).and_then(|r| st.tasks.get(&r.root));
            let into = root.and_then(|r| git::current_branch(&r.cwd).or_else(|| r.branch.clone()));
            (st.tasks.values().filter(|t| t.run == run && t.worktree.is_some()).cloned().collect::<Vec<_>>(), into)
        };
        let (mut released, mut kept) = (vec![], vec![]);
        for t in tasks {
            let Some(wt) = t.worktree.clone() else { continue };
            let merged = t.merged || t.branch.as_deref().zip(into.as_deref()).is_some_and(|(b, i)| git::is_merged(&t.repo, b, i));
            if !merged && !force {
                kept.push(json!({ "task": t.id, "branch": t.branch, "reason": "rama sin fusionar" }));
                continue;
            }
            if git::is_dirty(&wt) {
                kept.push(json!({ "task": t.id, "branch": t.branch, "reason": "cambios sin commit" }));
                continue;
            }
            if let Err(e) = git::remove_worktree(&t.repo, &wt, false) {
                kept.push(json!({ "task": t.id, "branch": t.branch, "reason": e.lines().next().unwrap_or_default() }));
                continue;
            }
            let branch_deleted = merged && t.branch.as_ref().is_some_and(|b| git::delete_branch(&t.repo, b).is_ok());
            if let Ok(task) = self.lock().task_mut(&t.id) {
                task.worktree = None;
                task.cwd = t.repo.clone();
            }
            released.push(json!({ "task": t.id, "branch": t.branch, "branch_deleted": branch_deleted }));
        }
        (released, kept)
    }

    /// Estado para la interfaz. Con el lock del estado solo se copian datos; git
    /// (`for-each-ref` y la rama del padre para `integrate_into`) corre después,
    /// sin lock, para que una consulta lenta no frene a lxo ni a los agentes.
    pub fn snapshot(&self) -> Value {
        let (mut out, git_in) = {
            let st = self.lock();
            let live: Vec<String> = self.terms.lock().map(|t| t.keys().cloned().collect()).unwrap_or_default();
            let server = self.server.lock().ok().and_then(|s| s.as_ref().map(|h| h.port));
            let start = st.messages.len().saturating_sub(400);
            let out = json!({
                "settings": self.settings(),
                "roles": roles::describe(&self.settings().roles)["roles"],
                "server": server,
                "lxo": lxo_path(),
                "lxo_exists": lxo_path().is_file(),
                "runs": st.runs,
                "tasks": tasks_with_integration(&st),
                "messages": &st.messages[start..],
                "live": live,
            });
            (out, SnapshotGit::copy(&st))
        };
        #[cfg(test)]
        {
            let hook = self.snapshot_git_hook.lock().unwrap().clone();
            if let Some((tx, barrier)) = hook {
                let _ = tx.send(());
                barrier.wait();
            }
        }
        let (heads, into) = git_in.run();
        if let Some(tasks) = out["tasks"].as_object_mut() {
            for (id, t) in tasks.iter_mut() {
                t["head_commit"] = heads.get(id).cloned().map(Value::String).unwrap_or(Value::Null);
            }
        }
        // Por tarea con rama sin integrar: dónde la integraría orch_integrate.
        out["integrate_into"] = json!(into);
        out
    }
}

/// Lo que necesita git para la snapshot, copiado con el lock tomado.
struct SnapshotGit {
    /// (tarea, repo, rama) de cada tarea con rama.
    branches: Vec<(String, String, String)>,
    /// (tarea, carpeta del padre) de cada hija con rama sin integrar.
    parents: Vec<(String, String)>,
}

impl SnapshotGit {
    fn copy(st: &State) -> Self {
        let branches = st.tasks.values().filter_map(|t| Some((t.id.clone(), t.repo.clone(), t.branch.clone()?))).collect();
        let parents = st.tasks.values().filter(|t| t.branch.is_some() && !t.merged)
            .filter_map(|t| Some((t.id.clone(), st.tasks.get(t.parent.as_ref()?)?.cwd.clone()))).collect();
        SnapshotGit { branches, parents }
    }

    /// Sin lock: un `git for-each-ref` por repo y una consulta de rama por carpeta de padre.
    fn run(self) -> (HashMap<String, String>, BTreeMap<String, Value>) {
        let mut by_repo: HashMap<String, HashMap<String, String>> = HashMap::new();
        let mut heads = HashMap::new();
        for (id, repo, branch) in self.branches {
            let refs = by_repo.entry(repo.clone()).or_insert_with(|| review::branch_heads(&repo));
            if let Some(c) = refs.get(&branch) {
                heads.insert(id, c.clone());
            }
        }
        let mut by_dir: HashMap<String, Value> = HashMap::new();
        let into = self.parents.into_iter()
            .map(|(id, dir)| (id, by_dir.entry(dir.clone()).or_insert_with(|| integrate_target(&dir)).clone()))
            .collect();
        (heads, into)
    }
}

/// Última integración de la tarea (decisión `merge` más reciente) o `null`.
fn last_integration(st: &State, id: &str) -> Value {
    st.decisions.iter().filter(|d| d.task == id && d.kind == "merge").max_by_key(|d| (d.at, d.id)).map(|d| {
        let v: Value = d.detail_json.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null);
        json!({ "outcome": v["outcome"], "result_commit": v.get("result_commit").cloned().unwrap_or(Value::Null), "at": d.at })
    }).unwrap_or(Value::Null)
}

/// Las tareas de la snapshot con `last_integration` (sin la lista de decisiones).
fn tasks_with_integration(st: &State) -> Value {
    let mut tasks = serde_json::to_value(&st.tasks).unwrap_or(Value::Null);
    if let Some(map) = tasks.as_object_mut() {
        for (id, t) in map.iter_mut() {
            t["last_integration"] = last_integration(st, id);
            t["last_review"] = review::last_review(st, id);
            // head_commit se rellena después, fuera del lock (Core::snapshot).
            t["head_commit"] = Value::Null;
        }
    }
    tasks
}

impl State {
    pub fn children_open(&self, id: &str) -> Vec<String> {
        self.children(id).into_iter().filter(|t| !t.status.is_final()).map(|t| t.id.clone()).collect()
    }
}

fn task_file(t: &Task, parent: Option<&Task>, objective: &str) -> String {
    let place = match (&t.branch, &t.worktree) {
        (Some(br), Some(_)) => format!(
            "Trabajas en tu propio worktree (`{}`), en la rama `{br}`, que sale de `{}`. Haz commit ahí de tu trabajo.",
            t.cwd,
            t.base.as_deref().unwrap_or("HEAD")
        ),
        _ => format!(
            "Trabajas en la carpeta compartida del coordinador (`{}`): no cambies de rama ni hagas commits salvo que tu encargo lo pida.",
            t.cwd
        ),
    };
    let coordinator = parent.map(|p| format!("{} ({})", p.id, p.agent)).unwrap_or_default();
    let report = format!(".lixbon/informe-{}.md", t.id);
    let role = t.role.as_deref().and_then(roles::spec);
    let read_only = role.is_some_and(|r| r.read_only);
    let role_line = role.map(|r| format!("Tu rol: **{}**. {}\n\n", r.label, r.purpose)).unwrap_or_default();
    let adversary_line = if role.is_some_and(|r| r.id == "adversario") {
        "Tu meta no es demostrar que funciona sino encontrar cómo se rompe. Puedes ejecutar tests y comandos para demostrar fallos, pero no edites nada. Tu informe es una lista de hallazgos numerados, del más grave al menos, y cada uno lleva: escenario concreto que lo rompe (entrada o estado -> resultado incorrecto), evidencia (ruta:línea, comando reproducible o test que falla) y la pregunta que el creador debe responder («¿por qué X y no Y?»). Sin elogios ni resumen de lo que está bien. Si no encuentras nada sólido, dilo y lista lo que intentaste.

"
    } else {
        ""
    };
    let final_message = t.last_message_path.is_some() || t.stream_json;
    let deliver = if final_message {
        let nonce = t.report_nonce.as_deref().unwrap_or("<nonce>");
        format!(
            "Tu informe es tu **mensaje final**: el host lo toma tal cual de la CLI, sin lxo done ni lxo report. \
Empieza tu último mensaje con la línea `LXO-RESULT nonce={nonce} status=done` (o `status=failed`), \
sigue con una línea de resumen y después el informe en markdown: qué encontraste, rutas con número de línea y qué queda. \
No modifiques archivos."
        )
    } else if t.agent == "claude" && !read_only {
        format!(
            "Escribe tu informe en `{report}` (qué hiciste, archivos, cómo lo verificaste, qué queda y decisiones pendientes) \
y cierra con `lxo report --report {report} --summary \"<una frase>\"`: es la única orden de lxo que tienes permitida sin pedir permiso."
        )
    } else if read_only {
        format!(
            "Eres de **solo lectura**: no tienes Edit ni Write y no debes modificar archivos (tampoco con Bash). \
Tu informe va por la entrada estándar, sin archivo:\n\n\
```\nlxo done --summary \"<una frase>\" --report - <<'EOF'\n# {id} · {title}\n## Resultado\n...\nEOF\n```\n\n\
Sé breve: tu coordinador paga cada línea que lee. Rutas con número de línea y conclusiones; \
nada de copiar bloques de código salvo las pocas líneas imprescindibles.",
            id = t.id,
            title = t.title,
        )
    } else {
        format!(
            "Escribe tu informe en `{report}` (qué hiciste, archivos, cómo lo verificaste, qué queda y decisiones pendientes) \
y cierra con `lxo done --report {report} --summary \"<una frase>\"`."
        )
    };
    format!(
        "# {id} · {title}\n\n\
Eres la tarea **{id}** del run {run}. Te coordina **{coordinator}**, que es quien habla con el usuario.\n\
Objetivo general: {objective}\n\n\
{role_line}{adversary_line}{place}\n\n\
## Tu encargo\n\n{spec}\n\n\
## Reglas\n\n\
1. Ejecuta `lxo guide` y síguela. Eres autónomo: nadie mira tu terminal para aprobar nada.\n\
2. Informa de tus fases: `lxo phase \"<nombre>\" --start` y `lxo phase \"<nombre>\" --done --note \"<resultado>\"`.\n\
3. Si solo tu coordinador puede decidir algo: `lxo ask \"<pregunta>\"` y espera. Nunca abras preguntas interactivas.\n\
4. En cada punto de control ejecuta `lxo check` por si tu coordinador te mandó instrucciones.\n\
5. Al acabar: {deliver} Si no se pudo completar, añade `--failed`. Después no hagas nada más.\n{offline}",
        offline = if final_message { String::new() } else { offline_rule(t) },
        id = t.id,
        title = t.title,
        run = t.run,
        spec = t.spec,
    )
}

/// Regla de entrega sin red para la ficha de la tarea (contrato de informe por archivo).
fn offline_rule(t: &Task) -> String {
    let Some(nonce) = &t.report_nonce else { return String::new() };
    format!(
        "6. **Sin red** (sandbox de Codex: `lxo` no conecta con el host): no reintentes `lxo done`; entrega con \
`lxo report --summary \"<una frase>\" --report <informe.md o ->` (mismas opciones `--failed` y `--files`). \
Si puede escribir, deja `{path}` y basta. Si no puede, imprime un bloque `<<<LXO-REPORT v1 nonce={nonce} …>>>`: \
cópialo **tal cual y completo** al final de tu respuesta. Fases, preguntas y `lxo check` no llegan sin red: sigue sin ellos.\n",
        path = delivery::report_path(&t.cwd, &t.id, delivery::ATTEMPT).display(),
    )
}

// ── Comandos de la interfaz ─────────────────────────────────────────────

#[tauri::command]
pub fn orch_snapshot(orch: TauriState<'_, Orch>) -> Value {
    orch.0.snapshot()
}

#[tauri::command]
pub fn orch_settings_set(orch: TauriState<'_, Orch>, settings: Settings) -> Result<Value, String> {
    let core = &orch.0;
    let enabled = settings.enabled;
    let was = core.settings().enabled;
    let warnings = roles::validate(&settings.roles)?;
    write_json(&data_dir().join("settings.json"), &settings)?;
    // Activarlo deja la skill en todos los agentes del equipo: nada que configurar a mano.
    if enabled && !was {
        let ids: Vec<String> = skill::detect(&lxo_path().to_string_lossy()).into_iter().filter(|a| a.detected).map(|a| a.id).collect();
        let _ = skill::install(&ids, &lxo_path().to_string_lossy());
    }
    if let Ok(mut s) = core.settings.lock() {
        *s = settings;
    }
    if enabled { core.start_server()? } else { core.stop_server() }
    if let Some(app) = core.app.get() {
        let _ = app.emit("orch:changed", ());
    }
    Ok(roles::save_response(&warnings, core.snapshot()))
}

#[tauri::command(async)]
pub fn orch_call(orch: TauriState<'_, Orch>, cmd: String, args: Value) -> Result<Value, String> {
    orch.0.rpc(Caller::User, "", &cmd, &args)
}

#[tauri::command]
pub fn orch_term_buffer(orch: TauriState<'_, Orch>, task: String) -> String {
    orch.0.terms.lock().ok()
        .and_then(|t| t.get(&task).and_then(|t| t.buffer.lock().ok().map(|b| String::from_utf8_lossy(&b).into_owned())))
        .unwrap_or_default()
}

#[tauri::command]
pub fn orch_term_write(orch: TauriState<'_, Orch>, task: String, data: String) -> Result<(), String> {
    let mut terms = orch.0.terms.lock().map_err(|_| "Estado interno corrupto")?;
    terms.get_mut(&task).ok_or("La terminal de esa tarea ya se cerró")?.write(data.as_bytes())
}

#[tauri::command]
pub fn orch_term_resize(orch: TauriState<'_, Orch>, task: String, cols: u16, rows: u16) -> Result<(), String> {
    let terms = orch.0.terms.lock().map_err(|_| "Estado interno corrupto")?;
    terms.get(&task).ok_or("La terminal de esa tarea ya se cerró")?.resize(cols, rows)
}

/// Política efectiva de un perfil para un proveedor, con el rol de la tarea
/// (vacío para consultar solo los flags), en un worktree: argv exacto,
/// versión detectada, advertencias y estado (`ok`, `blocked` o `unverified`).
#[tauri::command(async, rename_all = "snake_case")]
/// `model` (opcional): el modelo que se va a pedir; con Claude en plan y un modelo
/// que no es Sonnet, añade el aviso WARN_PLAN_SONNET.
pub fn orch_resolve_policy(provider: String, profile: String, role: String, worktree: String, model: Option<String>) -> agents::Policy {
    let mut p = agents::resolve_policy(&provider, &profile, &role, &worktree);
    agents::warn_plan_model(&mut p, model.as_deref());
    if let Some(m) = model.as_deref() {
        agents::mark_model(&mut p, Some(m), providers::model_verified(&provider, m));
    }
    agents::set_model(&mut p, model.as_deref());
    p
}

/// Pestaña de terminal de Codex (orch/codex_term.rs): política sin lanzar nada.
pub fn codex_term_policy(cwd: &str, model: Option<&str>, effort: Option<&str>) -> Result<Value, String> {
    serde_json::to_value(codex_term::resolve(cwd, model, effort)?).map_err(|e| e.to_string())
}

/// Abre la pestaña de Codex. `root`: carpeta de trabajo abierta en Lixbon.
#[allow(clippy::too_many_arguments)]
pub fn codex_term_open(app: &AppHandle, terms: &CodexTerms, root: Option<&Path>, cwd: &str, model: Option<&str>, effort: Option<&str>,
    cols: Option<u16>, rows: Option<u16>, acknowledged: bool) -> Result<Value, String> {
    let app = app.clone();
    let emit = move |name: &str, payload: Value| { let _ = app.emit(name, payload); };
    let o = codex_term::open(terms, root, cwd, model, effort, cols, rows, acknowledged, |c| codex_term::resolve(c, model, effort), emit)?;
    serde_json::to_value(o).map_err(|e| e.to_string())
}

/// Proveedores para los roles del equipo: versión, disponibilidad, modelos (con
/// `verified`) y esfuerzos que admite cada CLI. Solo la interfaz: no está en
/// `orch_call` ni en el servidor HTTP de `lxo`.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_list_providers(refresh: Option<bool>) -> Vec<providers::Provider> {
    providers::list(refresh.unwrap_or(false))
}

/// Integra la rama de una tarea en su padre. Solo la interfaz (la persona) llega
/// aquí: no está en `orch_call` ni en el servidor HTTP de `lxo`. `confirm` debe
/// ser `true` (diálogo de confirmación de la UI).
// snake_case: la webview envía los nombres tal cual (accept_moved_target), sin camelCase.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_integrate(orch: TauriState<'_, Orch>, task: String, confirm: bool, squash: Option<bool>, accept_moved_target: Option<String>) -> Result<Value, String> {
    orch.0.integrate_from_ui(&task, confirm, squash.unwrap_or(false), accept_moved_target.as_deref())
}

/// Publica la rama de una tarea (push + `gh pr create`). Solo la interfaz: no
/// está en `orch_call` ni en el servidor HTTP de `lxo`. `confirm` debe ser `true`.
// snake_case: la webview envía los nombres tal cual (accept_moved_target), sin camelCase.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_publish_pr(orch: TauriState<'_, Orch>, task: String, confirm: bool) -> Result<Value, String> {
    orch.0.publish_pr_from_ui(&task, confirm)
}

/// Lanzamientos que esperan a la persona (para recuperar la vista si se recarga).
/// Solo la interfaz: no está en `orch_call` ni en el servidor HTTP de `lxo`.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_list_pending_spawns(orch: TauriState<'_, Orch>) -> Vec<spawn_approval::PendingSpawn> {
    orch.0.list_pending_spawns()
}

/// La persona aprueba un lanzamiento. `argv` es el que vio: solo se compara con el
/// que vuelve a resolver el host, que es el que se lanza. Solo la interfaz.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_approve_spawn(orch: TauriState<'_, Orch>, pending_id: String, confirm: bool, argv: Vec<String>, ack_unverified: Option<bool>) -> Result<Value, String> {
    orch.0.approve_spawn(&pending_id, confirm, &argv, ack_unverified.unwrap_or(false))
}

/// La persona rechaza un lanzamiento. Solo la interfaz.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_reject_spawn(orch: TauriState<'_, Orch>, pending_id: String, confirm: bool, reason: Option<String>) -> Result<Value, String> {
    orch.0.reject_spawn(&pending_id, confirm, reason.as_deref())
}

/// Diff de la rama de una tarea contra su base, por archivo. Solo la interfaz:
/// no está en `orch_call` ni en el servidor HTTP de `lxo`.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_task_diff(orch: TauriState<'_, Orch>, task_id: String) -> Result<Value, String> {
    orch.0.task_diff_from_ui(&task_id)
}

/// La persona acepta o rechaza el diff de una tarea sobre `head_commit`. Solo la interfaz.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_review_task(orch: TauriState<'_, Orch>, task_id: String, decision: String, head_commit: String, comment: Option<String>, confirm: bool) -> Result<Value, String> {
    orch.0.review_from_ui(&task_id, &decision, &head_commit, comment.as_deref(), confirm)
}

#[tauri::command]
pub fn orch_agents() -> Vec<skill::Detected> {
    skill::detect(&lxo_path().to_string_lossy())
}

#[tauri::command]
pub fn orch_skill_install(ids: Vec<String>) -> Result<Vec<String>, String> {
    skill::install(&ids, &lxo_path().to_string_lossy())
}

#[tauri::command]
pub fn orch_skill_uninstall(ids: Vec<String>) -> Result<(), String> {
    skill::uninstall(&ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use state::NewTask;

    #[test]
    fn el_servidor_de_lxo_no_conoce_la_integracion() {
        // server.rs despacha todo por Core::rpc con Caller::Agent; orch_call de la UI
        // usa el mismo rpc. Ninguno de los dos puede integrar.
        let core = Orch::default().0;
        core.settings.lock().unwrap().enabled = true;
        for caller in [Caller::Agent(None), Caller::Agent(Some("t1".into())), Caller::User] {
            let e = core.rpc(caller, "", "integrate", &json!({ "task": "t1", "confirm": true })).unwrap_err();
            assert_eq!(e, integration::AGENT_REJECT);
        }
        let e = core.rpc(Caller::Agent(None), "", "merge", &json!({ "task": "t1" })).unwrap_err();
        assert_eq!(e, integration::AGENT_REJECT);
        for caller in [Caller::Agent(Some("t1".into())), Caller::User] {
            assert_eq!(core.rpc(caller, "", "pr", &json!({ "task": "t1" })).unwrap_err(), integration::PR_REJECT);
        }
        for c in ["publish_pr", "orch_publish_pr"] {
            assert_eq!(core.rpc(Caller::Agent(None), "", c, &json!({})).unwrap_err(), format!("Comando desconocido: {c}"));
        }
        assert!(!include_str!("server.rs").contains("integrate") && !include_str!("server.rs").contains("publish"));
    }

    /// Invoca orch_integrate por el IPC de Tauri (MockRuntime), con el JSON que
    /// mandaría la webview, para comprobar cómo llegan los argumentos.
    #[test]
    fn la_webview_envia_accept_moved_target_en_snake_case() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
        use tauri::webview::InvokeRequest;

        let git = |dir: &Path, args: &[&str]| {
            let o = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
            assert!(o.status.success(), "{args:?}");
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        };
        let dir = std::env::temp_dir().join(format!("lxo-ipc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for a in [&["init", "-q", "-b", "master"][..], &["config", "user.name", "t"], &["config", "user.email", "t@t"]] { git(&dir, a); }
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "base"]);
        let base = git(&dir, &["rev-parse", "HEAD"]);
        git(&dir, &["checkout", "-qb", "lx/t"]);
        std::fs::write(dir.join("b.txt"), "rama\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "rama"]);
        git(&dir, &["checkout", "-q", "master"]);
        std::fs::write(dir.join("c.txt"), "manual\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "manual"]);
        let moved = git(&dir, &["rev-parse", "HEAD"]);

        let orch = Orch::default();
        let id = {
            let cwd = dir.to_string_lossy().into_owned();
            let nt = |branch: Option<&str>| NewTask { agent: "claude".into(), model: None, effort: None, role: None, title: "x".into(),
                spec: String::new(), repo: cwd.clone(), cwd: cwd.clone(), branch: branch.map(String::from), base: None, worktree: None, external: false };
            let mut st = orch.0.lock();
            let (_, root) = st.create_run("obj", nt(None));
            let id = st.add_child(&root, 2, nt(Some("lx/t"))).unwrap();
            st.done(&id, true, "ok", vec![], None).unwrap();
            st.task_mut(&id).unwrap().base_commit = Some(base.clone());
            id
        };
        // Integrar exige la revisión aceptada sobre el HEAD de la rama (review.rs).
        orch.0.lock().record_decision(&id, "review", "human", &json!({ "decision": "accepted", "head_commit": git(&dir, &["rev-parse", "lx/t"]) }));
        let app = mock_builder().manage(orch).invoke_handler(tauri::generate_handler![orch_integrate, orch_publish_pr])
            .build(mock_context(noop_assets())).unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let invoke = |body: Value| {
            get_ipc_response(&webview, InvokeRequest {
                cmd: "orch_integrate".into(), callback: CallbackFn(0), error: CallbackFn(1),
                url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(), body: InvokeBody::Json(body),
                headers: Default::default(), invoke_key: INVOKE_KEY.to_string(),
            }).map(|r| r.deserialize::<Value>().unwrap())
        };
        // En camelCase (lo que Tauri esperaría por defecto) el campo ya no se reconoce:
        // llega como None y el destino movido no se acepta.
        let out = invoke(json!({ "task": id, "confirm": true, "acceptMovedTarget": moved })).unwrap();
        assert_eq!(out["outcome"], "target_moved");
        // En snake_case llega y se integra contra el commit aceptado.
        let out = invoke(json!({ "task": id, "confirm": true, "accept_moved_target": moved })).unwrap();
        assert_eq!((out["outcome"].as_str(), out["accepted_moved_target"].as_bool()), (Some("merged"), Some(true)), "{out}");
        assert_eq!(git(&dir, &["rev-parse", "HEAD^1"]), moved);
        // Sin confirm (campo obligatorio) Tauri rechaza la llamada antes de llegar al host.
        assert!(invoke(json!({ "task": id })).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Las dos listas de rechazo, cada una por separado, por orch_call (User) y
    /// por el camino del servidor HTTP (Caller::Agent, mismo Core::rpc).
    #[test]
    fn revisar_y_diff_de_revision_no_llegan_por_orch_call_ni_http() {
        let core = Orch::default().0;
        core.settings.lock().unwrap().enabled = true;
        let callers = || [Caller::Agent(None), Caller::Agent(Some("t1".into())), Caller::User];
        for c in review::HUMAN_DECISION_CMDS {
            for caller in callers() {
                let e = core.rpc(caller, "", c, &json!({ "task": "t1", "task_id": "t1", "confirm": true })).unwrap_err();
                assert!([integration::AGENT_REJECT, integration::PR_REJECT, review::REVIEW_REJECT].contains(&e.as_str()), "{c}: {e}");
            }
        }
        assert_eq!(core.rpc(Caller::User, "", "review", &json!({})).unwrap_err(), review::REVIEW_REJECT);
        for c in review::CLOSED_READ_CMDS {
            for caller in callers() {
                assert_eq!(core.rpc(caller, "", c, &json!({ "task_id": "t1" })).unwrap_err(), review::TASK_DIFF_CLOSED);
            }
        }
        for c in ["orch_review_task", "orch_task_diff", "review_task"] {
            assert_eq!(core.rpc(Caller::User, "", c, &json!({})).unwrap_err(), format!("Comando desconocido: {c}"));
        }
        let server = include_str!("server.rs");
        assert!(server.contains("closed_to_agents"));
        assert!(!server.contains("review_task") && !server.contains("task_diff_from_ui"));
    }

    /// orch_task_diff y orch_review_task por el IPC de Tauri, en snake_case.
    #[test]
    fn la_webview_envia_task_id_y_head_commit_en_snake_case() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
        use tauri::webview::InvokeRequest;
        let (st, id, dir, _) = review::tests::setup("ipc");
        let orch = Orch::default();
        *orch.0.lock() = st.into_inner().unwrap();
        let core = orch.0.clone();
        let app = mock_builder().manage(orch).invoke_handler(tauri::generate_handler![orch_task_diff, orch_review_task])
            .build(mock_context(noop_assets())).unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let invoke = |cmd: &str, body: Value| {
            get_ipc_response(&webview, InvokeRequest {
                cmd: cmd.into(), callback: CallbackFn(0), error: CallbackFn(1),
                url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(), body: InvokeBody::Json(body),
                headers: Default::default(), invoke_key: INVOKE_KEY.to_string(),
            }).map(|r| r.deserialize::<Value>().unwrap())
        };
        assert!(invoke("orch_task_diff", json!({ "taskId": id })).is_err());
        let d = invoke("orch_task_diff", json!({ "task_id": id })).unwrap();
        let h = d["head_commit"].as_str().unwrap().to_string();
        assert_eq!(d["base_source"], "recorded");
        let nf = invoke("orch_task_diff", json!({ "task_id": "nadie" })).unwrap_err();
        assert!(format!("{nf:?}").contains("not_found"), "{nf:?}");
        assert!(invoke("orch_review_task", json!({ "taskId": id, "decision": "accepted", "headCommit": h, "confirm": true })).is_err());
        assert!(invoke("orch_review_task", json!({ "task_id": id, "decision": "accepted", "head_commit": h })).is_err(), "confirm obligatorio");
        let out = invoke("orch_review_task", json!({ "task_id": id, "decision": "accepted", "head_commit": h, "comment": "ok", "confirm": true })).unwrap();
        assert_eq!(out["outcome"], "recorded");
        let ev: Vec<_> = core.events.lock().unwrap().iter().filter(|(n, _)| n == review::EV_REVIEWED).cloned().collect();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].1, json!({ "task_id": id, "decision": "accepted", "head_commit": h, "at": out["at"] }));
        let snap = core.snapshot();
        assert_eq!(snap["tasks"][&id]["last_review"]["decision"], "accepted");
        assert_eq!(snap["tasks"][&id]["head_commit"].as_str(), Some(h.as_str()));
        let root = core.lock().task(&id).unwrap().parent.clone().unwrap();
        assert_eq!(snap["tasks"][&root]["head_commit"], Value::Null);
        assert_eq!(snap["tasks"][&root]["last_review"], Value::Null);
        let moved = invoke("orch_review_task", json!({ "task_id": id, "decision": "rejected", "head_commit": "0000", "confirm": true })).unwrap();
        assert_eq!((moved["outcome"].as_str(), moved["found_commit"].as_str()), (Some("head_moved"), Some(h.as_str())));
        assert_eq!(core.events.lock().unwrap().iter().filter(|(n, _)| n == review::EV_REVIEWED).count(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// git corre sin el lock del estado. Determinista: la snapshot avisa al
    /// arrancar su fase git y espera; la prueba hace try_lock() justo ahí (tiene
    /// que funcionar) y recién entonces la deja seguir.
    #[test]
    fn la_snapshot_no_corre_git_con_el_lock_tomado() {
        let (st, id, dir, _) = review::tests::setup("lock-snapshot");
        let core = Orch::default().0;
        *core.lock() = st.into_inner().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        *core.snapshot_git_hook.lock().unwrap() = Some((tx, barrier.clone()));
        let worker = {
            let core = core.clone();
            std::thread::spawn(move || core.snapshot())
        };
        rx.recv().expect("la snapshot no llegó a la fase git");
        assert!(core.state.try_lock().is_ok(), "el lock del estado sigue tomado en la fase git");
        barrier.wait();
        let snap = worker.join().unwrap();
        *core.snapshot_git_hook.lock().unwrap() = None;
        assert!(snap["tasks"][&id]["head_commit"].as_str().is_some_and(|h| h.len() == 40));
        assert!(snap["integrate_into"][&id]["branch"].as_str() == Some("master"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn la_snapshot_trae_la_ultima_integracion_de_cada_tarea() {
        let orch = Orch::default();
        let id = {
            let nt = || NewTask { agent: "claude".into(), model: None, effort: None, role: None, title: "x".into(), spec: String::new(),
                repo: ".".into(), cwd: ".".into(), branch: None, base: None, worktree: None, external: false };
            let mut st = orch.0.lock();
            let (_, root) = st.create_run("obj", nt());
            st.add_child(&root, 2, nt()).unwrap()
        };
        let li = |o: &Orch| o.0.snapshot()["tasks"][&id]["last_integration"].clone();
        assert_eq!(li(&orch), Value::Null);
        orch.0.lock().record_decision(&id, "merge", "human", &json!({ "outcome": "conflict", "conflict": ["a.txt"] }));
        assert_eq!((li(&orch)["outcome"].as_str(), li(&orch)["result_commit"].clone()), (Some("conflict"), Value::Null));
        std::thread::sleep(Duration::from_millis(5));
        orch.0.lock().record_decision(&id, "merge", "human", &json!({ "outcome": "merged", "result_commit": "abc123" }));
        orch.0.lock().record_decision(&id, "spawn", "human", &json!({ "outcome": "approved" }));
        let v = li(&orch);
        assert_eq!((v["outcome"].as_str(), v["result_commit"].as_str()), (Some("merged"), Some("abc123")));
        assert!(v["at"].as_u64().is_some());
        assert!(orch.0.snapshot().get("decisions").is_none());
    }

    #[test]
    fn la_decision_persiste_en_state_json_y_sobrevive_recarga() {
        let dir = std::env::temp_dir().join(format!("lxo-decisiones-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let mut st = State::default();
        let id = st.record_decision("t2", "merge", "human", &json!({ "outcome": "conflict", "conflict": ["a.txt"] }));
        write_json(&path, &st).unwrap();
        let back: State = read_json(&path).unwrap();
        assert_eq!(back.decisions, st.decisions);
        assert_eq!(back.decisions[0].id, id);
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["decisions"][0]["actor"], "human");
        let _ = std::fs::remove_dir_all(dir);
    }
}
