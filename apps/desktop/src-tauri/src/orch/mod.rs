//! Orquestador de agentes (experimental). Cualquier agente del sistema habla
//! con Lixbon a través de `lxo` (HTTP local, ver `server.rs`) para repartir
//! trabajo en un árbol de tareas: cada hija corre en su propia terminal, en su
//! rama y su worktree, y avisa a su padre al terminar cada fase.

mod git;
mod pty;
mod server;
mod skill;
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
    /// `lxo` desde una terminal: con id si es una tarea, sin él si es un coordinador externo.
    Agent(Option<String>),
    /// La interfaz de Lixbon: el usuario puede gestionar cualquier tarea.
    User,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub enabled: bool,
    pub max_depth: u32,
    pub default_agent: String,
    pub notify_phases: bool,
    pub notify_done: bool,
    pub notify_questions: bool,
    pub worktree_root: String,
    /// Comando de cada agente; `{prompt}` se sustituye por la instrucción inicial.
    /// Sin `{prompt}`, se escribe en su terminal cuando está lista.
    pub launchers: BTreeMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        let launchers = [
            ("claude", r#"claude "{prompt}""#),
            ("codex", r#"codex "{prompt}""#),
            ("opencode", r#"opencode --prompt "{prompt}""#),
            ("cursor", r#"cursor-agent "{prompt}""#),
            ("gemini", r#"gemini -i "{prompt}""#),
            ("lixbon", "lixbon chat"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        Self {
            enabled: false,
            max_depth: 2,
            default_agent: "claude".into(),
            notify_phases: true,
            notify_done: true,
            notify_questions: true,
            worktree_root: String::new(),
            launchers,
        }
    }
}

pub struct Core {
    app: OnceLock<AppHandle>,
    state: Mutex<State>,
    cv: Condvar,
    terms: Mutex<HashMap<String, pty::AgentTerm>>,
    settings: Mutex<Settings>,
    server: Mutex<Option<server::Handle>>,
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

impl Core {
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
        match cmd {
            "status" => {
                let st = self.lock();
                let cfg = self.settings();
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
                    "max_depth": cfg.max_depth,
                    "can_spawn": task.as_ref().map(|t| t.depth < cfg.max_depth).unwrap_or(true),
                    "agents": cfg.launchers.keys().collect::<Vec<_>>(),
                    "default_agent": cfg.default_agent,
                }))
            }
            "run_create" => {
                if let Caller::Agent(Some(id)) = &caller {
                    return Err(format!("Ya eres la tarea {id}: crea hijos directamente con lxo spawn"));
                }
                let objective = s(args, "objective");
                if objective.is_empty() {
                    return Err("Falta --objective".into());
                }
                let repo = git::toplevel(cwd).ok_or("El orquestador necesita un repositorio git: ejecútalo dentro de uno")?;
                let agent = Some(s(args, "agent")).filter(|a| !a.is_empty()).unwrap_or_else(|| "externo".into());
                let mut st = self.lock();
                let (run, task) = st.create_run(&objective, NewTask {
                    agent,
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
            "spawn" => self.spawn(&caller, args),
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
                let mut st = self.lock();
                let msg = st.done(&me, !b(args, "failed"), &s(args, "summary"), files)?;
                self.commit(&st, &msg.into_iter().collect::<Vec<_>>());
                Ok(json!({ "task": me, "status": st.task(&me)?.status }))
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
                    k = vec![Kind::Done, Kind::Question, Kind::Exited, Kind::Phase];
                }
                let timeout = Duration::from_millis(n(args, "timeout_ms").unwrap_or(600_000));
                let found = self.wait_for(&me, &k, None, timeout);
                let pending = {
                    let st = self.lock();
                    st.children_open(&me)
                };
                Ok(json!({ "messages": found, "timeout": found.is_empty(), "open_children": pending }))
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
            "merge" => self.merge(&caller, args),
            "pr" => {
                let id = s(args, "task");
                let (branch, base, dir) = self.branch_of(&caller, &id)?;
                let (title, summary) = {
                    let st = self.lock();
                    let t = st.task(&id)?;
                    (t.title.clone(), t.summary.clone())
                };
                git::push(&dir, &branch)?;
                let url = git::gh_pr(&dir, &base, &branch, &title, &format!("{summary}\n\n_Tarea {id} del orquestador de Lixbon._"))?;
                let mut st = self.lock();
                st.task_mut(&id)?.pr_url = Some(url.clone());
                self.commit(&st, &[]);
                Ok(json!({ "url": url }))
            }
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
            "remove_run" => {
                if !matches!(caller, Caller::User) {
                    return Err("Solo desde la interfaz".into());
                }
                let run = s(args, "run");
                let ids: Vec<String> = self.lock().tasks.values().filter(|t| t.run == run).map(|t| t.id.clone()).collect();
                for id in &ids {
                    self.kill_term(id);
                }
                let mut st = self.lock();
                st.remove_run(&run);
                self.commit(&st, &[]);
                Ok(json!({ "removed": run }))
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

    fn spawn(self: &Arc<Self>, caller: &Caller, args: &Value) -> Result<Value, String> {
        let parent_id = match caller {
            Caller::User => s(args, "parent"),
            _ => Self::me(caller)?,
        };
        let spec = s(args, "task");
        if spec.is_empty() {
            return Err("Falta --task con lo que tiene que hacer la hija".into());
        }
        let cfg = self.settings();
        let agent = Some(s(args, "agent")).filter(|a| !a.is_empty()).unwrap_or_else(|| cfg.default_agent.clone());
        let title = Some(s(args, "name")).filter(|a| !a.is_empty())
            .unwrap_or_else(|| spec.lines().next().unwrap_or("").chars().take(60).collect());
        let shared = b(args, "no_worktree");

        let (id, parent) = {
            let mut st = self.lock();
            let parent = st.task(&parent_id)?.clone();
            let id = st.add_child(&parent_id, cfg.max_depth, NewTask {
                agent: agent.clone(), title: title.clone(), spec: spec.clone(), repo: parent.repo.clone(),
                cwd: parent.cwd.clone(), branch: None, base: None, worktree: None, external: false,
            })?;
            (id, parent)
        };

        let prepared = (|| -> Result<(), String> {
            if shared {
                return Ok(());
            }
            let base = Some(s(args, "base")).filter(|b| !b.is_empty())
                .or_else(|| parent.branch.clone())
                .or_else(|| git::current_branch(&parent.cwd))
                .unwrap_or_else(|| "HEAD".into());
            let slug = state::slug(&title, 32);
            let branch = format!("lx/{}/{id}-{slug}", parent.run);
            let dir = git::worktree_dir(&parent.repo, Some(&cfg.worktree_root), &format!("{}-{id}-{slug}", parent.run));
            git::add_worktree(&parent.repo, &dir, &branch, &base)?;
            let mut st = self.lock();
            let t = st.task_mut(&id)?;
            t.cwd = dir.to_string_lossy().into_owned();
            t.worktree = Some(t.cwd.clone());
            t.branch = Some(branch);
            t.base = Some(base);
            Ok(())
        })()
        .and_then(|_| self.launch(&id));

        let mut st = self.lock();
        if let Err(e) = prepared {
            st.tasks.remove(&id);
            self.commit(&st, &[]);
            return Err(e);
        }
        // Si el agente ya murió al arrancar, la tarea quedó en `exited` y así se informa.
        let _ = st.mark_running(&id);
        let t = st.task(&id)?.clone();
        self.commit(&st, &[]);
        Ok(json!({ "task": t.id, "agent": t.agent, "status": t.status, "branch": t.branch, "worktree": t.worktree }))
    }

    /// Nuevo run desde la interfaz: el coordinador también es una tarea gestionada.
    pub fn new_run(self: &Arc<Self>, objective: &str, agent: &str, cwd: &str) -> Result<Value, String> {
        if !self.settings().enabled {
            return Err("Activa el orquestador en Ajustes → Orquestador".into());
        }
        let repo = git::toplevel(cwd).ok_or("La carpeta de trabajo no es un repositorio git")?;
        let (run, task) = {
            let mut st = self.lock();
            st.create_run(objective, NewTask {
                agent: agent.into(),
                title: objective.lines().next().unwrap_or("").chars().take(60).collect(),
                spec: objective.into(),
                repo,
                cwd: cwd.into(),
                branch: git::current_branch(cwd),
                base: None,
                worktree: None,
                external: false,
            })
        };
        if let Err(e) = self.launch(&task) {
            let mut st = self.lock();
            st.remove_run(&run);
            self.commit(&st, &[]);
            return Err(e);
        }
        let mut st = self.lock();
        let _ = st.mark_running(&task);
        self.commit(&st, &[]);
        Ok(json!({ "run": run, "task": task }))
    }

    fn launch(self: &Arc<Self>, id: &str) -> Result<(), String> {
        let app = self.app.get().ok_or("Lixbon aún no terminó de arrancar")?.clone();
        let cfg = self.settings();
        let (task, parent, objective) = {
            let st = self.lock();
            let t = st.task(id)?.clone();
            let p = t.parent.as_ref().and_then(|p| st.tasks.get(p)).cloned();
            let o = st.runs.get(&t.run).map(|r| r.objective.clone()).unwrap_or_default();
            (t, p, o)
        };
        let dir = Path::new(&task.cwd).join(".lixbon").join("tasks");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::write(dir.join(format!("{id}.md")), task_file(&task, parent.as_ref(), &objective, cfg.max_depth))
            .map_err(|e| format!("No se pudo escribir la tarea: {e}"))?;
        git::exclude_lixbon_dir(&task.cwd);

        let prompt = if task.parent.is_some() {
            format!("Eres la tarea {id} del orquestador de Lixbon. Lee .lixbon/tasks/{id}.md y ejecuta lxo guide antes de empezar.")
        } else {
            format!("Eres el coordinador {id} del orquestador de Lixbon. Lee .lixbon/tasks/{id}.md y ejecuta lxo guide antes de empezar.")
        };
        let template = cfg.launchers.get(&task.agent).cloned().unwrap_or_else(|| task.agent.clone());
        let (command, inject) = if template.contains("{prompt}") {
            (template.replace("{prompt}", &prompt), None)
        } else {
            (template, Some(prompt))
        };

        let lxo = lxo_path();
        let mut path = lxo.parent().map(|p| p.as_os_str().to_owned()).unwrap_or_default();
        if let Some(cur) = std::env::var_os("PATH") {
            path.push(if cfg!(windows) { ";" } else { ":" });
            path.push(cur);
        }
        let env = vec![
            ("LXO_TASK_ID".to_string(), id.to_string()),
            ("LXO_RUN_ID".to_string(), task.run.clone()),
            ("LXO_BIN".to_string(), lxo.to_string_lossy().into_owned()),
            ("PATH".to_string(), path.to_string_lossy().into_owned()),
        ];
        let weak = Arc::downgrade(self);
        let tid = id.to_string();
        let term = pty::spawn(&app, pty::Launch {
            task: id,
            cwd: &task.cwd,
            script_dir: &dir.join(id),
            command,
            env,
            inject,
        }, move || {
            if let Some(core) = weak.upgrade() {
                core.on_exit(&tid);
            }
        })?;
        self.terms.lock().map_err(|_| "Estado interno corrupto")?.insert(id.to_string(), term);
        Ok(())
    }

    fn on_exit(&self, id: &str) {
        if let Ok(mut terms) = self.terms.lock() {
            terms.remove(id);
        }
        let mut st = self.lock();
        if let Ok(Some(msg)) = st.close(id, Status::Exited, "el agente se cerró sin avisar con lxo done") {
            self.commit(&st, &[msg]);
        } else {
            self.commit(&st, &[]);
        }
    }

    fn kill_term(&self, id: &str) {
        if let Some(mut t) = self.terms.lock().ok().and_then(|mut m| m.remove(id)) {
            t.kill();
        }
    }

    fn merge(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let id = s(args, "task");
        let (branch, parent_dir, title, open) = {
            let st = self.lock();
            Self::check_manages(&st, caller, &id)?;
            let t = st.task(&id)?;
            let branch = t.branch.clone().ok_or_else(|| format!("{id} no tiene rama propia"))?;
            let parent = t.parent.as_ref().and_then(|p| st.tasks.get(p)).ok_or("La tarea raíz no se fusiona en nadie")?;
            (branch, parent.cwd.clone(), t.title.clone(), !t.status.is_final())
        };
        if open && !b(args, "force") {
            return Err(format!("{id} aún está en marcha: espera a su lxo done o usa --force"));
        }
        let out = git::merge(&parent_dir, &branch, &format!("lxo: fusiona {id} · {title}"), b(args, "squash"))?;
        let mut st = self.lock();
        st.task_mut(&id)?.merged = true;
        self.commit(&st, &[]);
        Ok(json!({ "task": id, "merged": branch, "into": parent_dir, "output": out }))
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
        Ok(json!({ "task": id, "worktree_removed": worktree.is_some(), "branch_deleted": branch_deleted }))
    }

    pub fn snapshot(&self) -> Value {
        let st = self.lock();
        let live: Vec<String> = self.terms.lock().map(|t| t.keys().cloned().collect()).unwrap_or_default();
        let server = self.server.lock().ok().and_then(|s| s.as_ref().map(|h| h.port));
        let start = st.messages.len().saturating_sub(400);
        json!({
            "settings": self.settings(),
            "server": server,
            "lxo": lxo_path(),
            "lxo_exists": lxo_path().is_file(),
            "runs": st.runs,
            "tasks": st.tasks,
            "messages": &st.messages[start..],
            "live": live,
        })
    }
}

impl State {
    pub fn children_open(&self, id: &str) -> Vec<String> {
        self.children(id).into_iter().filter(|t| !t.status.is_final()).map(|t| t.id.clone()).collect()
    }
}

fn task_file(t: &Task, parent: Option<&Task>, objective: &str, max_depth: u32) -> String {
    let can_spawn = t.depth < max_depth;
    let place = match (&t.branch, &t.worktree) {
        (Some(br), Some(_)) => format!("Trabajas en tu propio worktree (`{}`), en la rama `{br}`, que sale de `{}`.", t.cwd, t.base.as_deref().unwrap_or("HEAD")),
        _ => format!("Trabajas en la carpeta compartida `{}`: no cambies de rama.", t.cwd),
    };
    let role = match parent {
        Some(p) => format!(
            "Eres la tarea **{}** del run {}. Te coordina **{}** ({}).\nObjetivo general del run: {objective}",
            t.id, t.run, p.id, p.agent
        ),
        None => format!("Eres el **coordinador** ({}) del run {}.", t.id, t.run),
    };
    let spawn = if can_spawn {
        format!("Puedes crear hijas con `lxo spawn` (profundidad {} de {max_depth}).", t.depth)
    } else {
        "No puedes crear más niveles: estás en la profundidad máxima.".into()
    };
    let rules = if parent.is_some() {
        "1. Ejecuta `lxo guide` antes de empezar y sigue su guía de tarea hija.\n\
         2. Informa de tus fases: `lxo phase \"<nombre>\" --start` y, al acabarla, `lxo phase \"<nombre>\" --done --note \"<resultado breve>\"`.\n\
         3. Si necesitas una decisión, usa `lxo ask \"<pregunta>\"` (espera la respuesta). Nunca abras preguntas interactivas: nadie las verá.\n\
         4. En los puntos de control ejecuta `lxo check` por si tu coordinador te mandó instrucciones.\n\
         5. Haz commit de tu trabajo en tu rama antes de terminar.\n\
         6. Al acabar: `lxo done --summary \"<tres frases: qué hiciste, cómo lo verificaste, qué queda>\"` (o `--failed`). Después no hagas nada más."
    } else {
        "1. Ejecuta `lxo guide` antes de empezar y sigue su guía de coordinador.\n\
         2. Divide el objetivo en tareas independientes y lánzalas con `lxo spawn`.\n\
         3. Espera con `lxo wait`, responde preguntas con `lxo reply`, revisa con `lxo diff` y fusiona con `lxo merge`.\n\
         4. Cuando todo esté fusionado y verificado, resume al usuario el resultado de cada tarea."
    };
    format!("# {} · {}\n\n{role}\n\n{place}\n{spawn}\n\n## Qué tienes que hacer\n\n{}\n\n## Reglas\n\n{rules}\n", t.id, t.title, t.spec)
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
    write_json(&data_dir().join("settings.json"), &settings)?;
    if let Ok(mut s) = core.settings.lock() {
        *s = settings;
    }
    if enabled { core.start_server()? } else { core.stop_server() }
    if let Some(app) = core.app.get() {
        let _ = app.emit("orch:changed", ());
    }
    Ok(core.snapshot())
}

#[tauri::command(async)]
pub fn orch_call(orch: TauriState<'_, Orch>, cmd: String, args: Value) -> Result<Value, String> {
    orch.0.rpc(Caller::User, "", &cmd, &args)
}

#[tauri::command(async)]
pub fn orch_new_run(orch: TauriState<'_, Orch>, objective: String, agent: String, cwd: String) -> Result<Value, String> {
    orch.0.new_run(&objective, &agent, &cwd)
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

#[tauri::command]
pub fn orch_agents() -> Vec<skill::Detected> {
    skill::detect()
}

#[tauri::command]
pub fn orch_skill_install(ids: Vec<String>) -> Result<Vec<String>, String> {
    skill::install(&ids, &lxo_path().to_string_lossy())
}

#[tauri::command]
pub fn orch_skill_uninstall(ids: Vec<String>) -> Result<(), String> {
    skill::uninstall(&ids)
}

fn lxo_dir() -> String {
    lxo_path().parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// PATH del usuario tal como está guardado (el del proceso es el de cuando arrancó Lixbon).
#[cfg(windows)]
fn user_path() -> Result<String, String> {
    let out = crate::hide_console(std::process::Command::new("powershell.exe").args([
        "-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','User')",
    ]))
    .output()
    .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command(async)]
pub fn orch_path_status() -> Value {
    let dir = lxo_dir();
    #[cfg(windows)]
    let in_path = user_path()
        .map(|p| p.split(';').any(|e| e.trim().trim_end_matches('\\').eq_ignore_ascii_case(dir.trim_end_matches('\\'))))
        .unwrap_or(false);
    #[cfg(not(windows))]
    let in_path = std::env::var("PATH").map(|p| p.split(':').any(|e| e == dir)).unwrap_or(false);
    json!({ "dir": dir, "in_path": in_path, "supported": cfg!(windows) })
}

/// Añade la carpeta de `lxo` al PATH del usuario (no al del sistema: sin
/// permisos de administrador). Las terminales abiertas antes no lo verán.
#[tauri::command(async)]
pub fn orch_add_to_path() -> Result<Value, String> {
    #[cfg(windows)]
    {
        let dir = lxo_dir();
        if orch_path_status()["in_path"].as_bool() == Some(true) {
            return Ok(orch_path_status());
        }
        let current = user_path()?;
        let next = if current.is_empty() { dir.clone() } else { format!("{};{dir}", current.trim_end_matches(';')) };
        // SetEnvironmentVariable avisa a Windows del cambio (WM_SETTINGCHANGE), a diferencia de setx o del registro a mano.
        let script = format!("[Environment]::SetEnvironmentVariable('Path', '{}', 'User')", next.replace('\'', "''"));
        let out = crate::hide_console(std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &script]))
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(format!("No se pudo cambiar el PATH: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(orch_path_status())
    }
    #[cfg(not(windows))]
    Err(format!("Añade {} a tu PATH en tu shell (~/.bashrc, ~/.zshrc…)", lxo_dir()))
}
