//! Aprobación humana de cada lanzamiento (`lxo spawn`). Cuando un agente pide
//! una hija, el host resuelve la política y, si no está bloqueada, deja el
//! lanzamiento **pendiente** en memoria: la persona lo aprueba o lo rechaza
//! desde la ventana del orquestador (comandos Tauri `orch_approve_spawn` y
//! `orch_reject_spawn`, que no están en `orch_call` ni en el servidor de `lxo`).
//! El agente consulta el resultado con `spawn_status` (sondeo corto, sin
//! peticiones HTTP colgadas).
//!
//! - Vencimiento: `DEFAULT_TTL_SECS` (10 min) o la variable de entorno
//!   `LIXBON_SPAWN_APPROVAL_TTL_SECS` (segundos, mínimo 10) al arrancar Lixbon.
//! - Los pendientes viven solo en memoria: al reiniciar la app no existen y un
//!   id desconocido se responde como `expired`.
//! - Si el coordinador termina, o su run se cierra o se elimina, sus pendientes
//!   vencen (`expired`, actor `system`).
//! - Una sola decisión por `pending_id` en `state.json` (`kind = "spawn"`).
//! - El argv que manda la UI al aprobar solo se compara: el host lanza siempre
//!   el argv que él mismo vuelve a resolver. Si no coincide, no se lanza nada,
//!   no se crea tarea y el pendiente **sigue pendiente** (la persona puede
//!   recargar la vista y confirmar con la política actual o rechazarlo).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};

use super::{agents, random_token, s, state, worktree_env, Caller, Core};

pub const DEFAULT_TTL_SECS: u64 = 10 * 60;
pub const TTL_ENV: &str = "LIXBON_SPAWN_APPROVAL_TTL_SECS";
/// Los resueltos se recuerdan un rato para que `spawn_status` los conteste.
const KEEP_RESOLVED_MS: u64 = 60 * 60 * 1000;
pub const EV_PENDING: &str = "orch-spawn-pending";
pub const EV_RESOLVED: &str = "orch-spawn-resolved";

pub fn ttl_ms() -> u64 {
    let secs = std::env::var(TTL_ENV).ok().and_then(|v| v.trim().parse::<u64>().ok()).map(|v| v.max(10)).unwrap_or(DEFAULT_TTL_SECS);
    secs * 1000
}

/// Lo que se lanzará si la persona aprueba (todo validado al pedirlo).
#[derive(Serialize, Clone, Debug)]
pub struct PendingSpawn {
    pub pending_id: String,
    pub parent_task: String,
    pub run: String,
    pub provider: String,
    /// Igual que `provider` (la CLI que se lanza), con el nombre que usa la UI.
    pub agent: String,
    pub profile: String,
    pub role: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub title: String,
    /// Primeras líneas del encargo (máx. 400 caracteres).
    pub spec_summary: String,
    /// Dónde integraría `orch_integrate` la rama de la hija: la carpeta del
    /// coordinador y la rama que tiene en ese momento. `null` si es compartida (sin rama).
    pub integrate_into: Option<Value>,
    /// Carpeta donde correrá la hija: su worktree (aún sin crear) o la del coordinador.
    pub cwd: String,
    pub shared: bool,
    /// Lo que el worktree nuevo se llevaría del repo (enlaces y copias de `.worktreeinclude`);
    /// al aprobar solo se aplica esto. Vacío si es compartida o el repo no tiene reglas.
    pub env: worktree_env::Plan,
    pub policy: agents::Policy,
    pub created_at: u64,
    pub expires_at: u64,
    #[serde(skip)]
    pub spec: String,
    #[serde(skip)]
    pub base: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PendState {
    Pending,
    /// La persona aprobó y se está lanzando: otra confirmación ya es `already_resolved`.
    Launching,
    Approved(Value),
    Rejected(String),
    /// La persona aprobó pero no se pudo lanzar (sin reintento automático).
    LaunchFailed(String),
    Expired,
}

pub struct Entry {
    pub p: PendingSpawn,
    pub state: PendState,
    pub decision: Option<u64>,
    pub resolved_at: Option<u64>,
}

fn summary(spec: &str) -> String {
    let text: String = spec.lines().take(6).collect::<Vec<_>>().join("\n");
    let mut out: String = text.chars().take(400).collect();
    if out.len() < spec.trim_end().len() {
        out.push('…');
    }
    out
}

impl Core {
    fn pend(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `spawn` de un agente: valida, resuelve la política y deja el lanzamiento pendiente.
    pub(super) fn spawn_request(self: &Arc<Self>, caller: &Caller, args: &Value) -> Result<Value, String> {
        let plan = self.plan_spawn(caller, args)?;
        let policy = self.task_policy(&plan.provider, &plan.profile, plan.role.as_deref(), &plan.cwd, plan.model.as_deref());
        if policy.status == agents::Status::Blocked {
            // Igual que antes: un perfil bloqueado se rechaza sin preguntar a nadie.
            agents::authorize(&policy, None, true)?;
        }
        let now = state::now_ms();
        let mut p = plan;
        p.policy = policy;
        p.created_at = now;
        p.expires_at = now + self.ttl_ms;
        let ev = json!(p);
        self.pend().insert(p.pending_id.clone(), Entry { p: p.clone(), state: PendState::Pending, decision: None, resolved_at: None });
        self.emit(EV_PENDING, &ev);
        self.notify_pending(&p);
        Ok(json!({
            "status": "pending", "pending_id": p.pending_id, "expires_at": p.expires_at,
            "provider": p.provider, "profile": p.profile, "role": p.role, "title": p.title,
            "policy_status": p.policy.status,
        }))
    }

    /// El pendiente vence solo: avisa aunque la persona esté en otro modo o ventana.
    fn notify_pending(&self, p: &PendingSpawn) {
        let Some(host) = self.host.get() else { return };
        if !self.settings().notify_questions {
            return;
        }
        let who = p.role.as_deref().unwrap_or(&p.provider);
        let body = format!("{} · {}. Vence en {} min.", who, p.title, (self.ttl_ms / 60_000).max(1));
        host.notify("Orquestador · lanzamiento pendiente", &body);
    }

    /// Esqueleto del pendiente: lo que el agente pidió, ya validado.
    pub(super) fn new_pending(&self, parent: &state::Task, f: NewPending) -> PendingSpawn {
        let pending_id = format!("sp{}", &random_token()[..10]);
        let slug = state::slug(&f.title, 32);
        let worktree_name = format!("{}-{pending_id}-{slug}", parent.run);
        let cwd = if f.shared {
            parent.cwd.clone()
        } else {
            super::git::worktree_dir(&parent.repo, None, &worktree_name).to_string_lossy().into_owned()
        };
        PendingSpawn {
            integrate_into: (!f.shared).then(|| super::integrate_target(&parent.cwd)),
            pending_id, parent_task: parent.id.clone(), run: parent.run.clone(), agent: f.provider.clone(), provider: f.provider, profile: f.profile,
            role: f.role, model: f.model, effort: f.effort, spec_summary: summary(&f.spec), title: f.title, cwd, shared: f.shared,
            env: if f.shared { worktree_env::Plan::default() } else { worktree_env::plan(&parent.repo) },
            policy: agents::Policy { profile: String::new(), role: None, provider: String::new(), argv: vec![], cli_version: None, warnings: vec![], status: agents::Status::Unverified, reason: None, interactive: false, model: None },
            created_at: 0, expires_at: 0, spec: f.spec, base: f.base
        }
    }

    /// `spawn_status` del agente: pending | approved{task} | rejected{reason} | expired.
    pub(super) fn spawn_status(&self, caller: &Caller, args: &Value) -> Result<Value, String> {
        let me = Self::me(caller)?;
        let id = s(args, "pending_id");
        if id.is_empty() {
            return Err("Falta el pending_id".into());
        }
        self.sweep_pending();
        let pend = self.pend();
        let Some(e) = pend.get(&id) else {
            return Ok(json!({ "pending_id": id, "status": "expired" }));
        };
        if e.p.parent_task != me {
            return Err(format!("El lanzamiento {id} no es tuyo"));
        }
        Ok(match &e.state {
            PendState::Pending | PendState::Launching => json!({ "pending_id": id, "status": "pending", "expires_at": e.p.expires_at }),
            PendState::Approved(task) => json!({ "pending_id": id, "status": "approved", "task": task }),
            PendState::Rejected(r) => json!({ "pending_id": id, "status": "rejected", "reason": r }),
            PendState::LaunchFailed(r) => json!({ "pending_id": id, "status": "launch_failed", "reason": r }),
            PendState::Expired => json!({ "pending_id": id, "status": "expired" }),
        })
    }

    pub fn list_pending_spawns(&self) -> Vec<PendingSpawn> {
        self.sweep_pending();
        let mut v: Vec<PendingSpawn> = self.pend().values().filter(|e| e.state == PendState::Pending).map(|e| e.p.clone()).collect();
        v.sort_by_key(|p| p.created_at);
        v
    }

    fn decision_json(&self, id: Option<u64>) -> Value {
        let Some(id) = id else { return Value::Null };
        let st = self.lock();
        st.decisions.iter().find(|d| d.id == id).map(|d| json!({
            "id": d.id, "task": d.task, "kind": d.kind, "actor": d.actor, "at": d.at,
            "detail": d.detail_json.as_deref().and_then(|t| serde_json::from_str::<Value>(t).ok()),
        })).unwrap_or(Value::Null)
    }

    /// Registra la decisión (una por pending_id) y avisa. Si la tarea padre ya no
    /// existe (run eliminado) no hay fila a la que colgarla: no se registra.
    fn finish(&self, p: &PendingSpawn, actor: &str, outcome: &str, task: Option<&Value>, reason: Option<&str>, launch_error: Option<&str>) -> Option<u64> {
        let decided_at = state::now_ms();
        let id = {
            let mut st = self.lock();
            let exists = st.tasks.contains_key(&p.parent_task);
            let dup = st.decisions.iter().any(|d| d.kind == "spawn"
                && d.detail_json.as_deref().and_then(|t| serde_json::from_str::<Value>(t).ok()).is_some_and(|v| v["pending_id"] == p.pending_id.as_str()));
            let id = (exists && !dup).then(|| st.record_decision(&p.parent_task, "spawn", actor, &json!({
                "pending_id": p.pending_id, "parent_task": p.parent_task, "profile": p.profile, "argv": p.policy.argv,
                "policy_status": p.policy.status, "outcome": outcome, "created_at": p.created_at, "decided_at": decided_at,
                "task": task.and_then(|t| t["task"].as_str()), "reason": reason, "launch_error": launch_error,
            })));
            self.commit(&st, &[]);
            id
        };
        id
    }

    fn resolved_payload(&self, pending_id: &str, outcome: &str, task: Option<&Value>, decision: Option<u64>, reason: Option<&str>) -> Value {
        let mut v = json!({ "pending_id": pending_id, "outcome": outcome, "decision": self.decision_json(decision) });
        if let Some(t) = task {
            v["task"] = t.clone();
        }
        if let Some(r) = reason {
            v["reason"] = json!(r);
        }
        v
    }

    fn already(&self, pending_id: &str) -> Option<Value> {
        let pend = self.pend();
        let Some(e) = pend.get(pending_id) else {
            drop(pend);
            return Some(self.resolved_payload(pending_id, "expired", None, None, None));
        };
        match &e.state {
            PendState::Pending => None,
            PendState::Expired => {
                let d = e.decision;
                drop(pend);
                Some(self.resolved_payload(pending_id, "expired", None, d, None))
            }
            _ => {
                let d = e.decision;
                drop(pend);
                Some(self.resolved_payload(pending_id, "already_resolved", None, d, None))
            }
        }
    }

    /// Aprobación de la persona. `argv` solo se compara con el que vuelve a
    /// resolver el host; se lanza siempre el del host.
    pub fn approve_spawn(self: &Arc<Self>, pending_id: &str, confirm: bool, argv: &[String], ack_unverified: bool) -> Result<Value, String> {
        if !confirm {
            return Err("Aprobar un lanzamiento necesita la confirmación explícita de la persona (confirm: true)".into());
        }
        self.sweep_pending();
        if let Some(v) = self.already(pending_id) {
            return Ok(v);
        }
        let p = self.pend().get(pending_id).map(|e| e.p.clone()).ok_or("Pendiente desaparecido")?;
        let policy = self.task_policy(&p.provider, &p.profile, p.role.as_deref(), &p.cwd, p.model.as_deref());
        // Errores de uso (argv distinto, sin ack, bloqueado ahora): no se lanza y sigue pendiente.
        agents::authorize(&policy, Some(argv), ack_unverified)?;
        {
            let mut pend = self.pend();
            match pend.get_mut(pending_id) {
                Some(e) if e.state == PendState::Pending => {
                    e.state = PendState::Launching;
                    e.p.policy = policy.clone();
                }
                _ => {
                    drop(pend);
                    return Ok(self.already(pending_id).unwrap_or(Value::Null));
                }
            }
        }
        let mut p = p;
        p.policy = policy;
        // Se lanza con el argv del host (policy.argv); launch() lo vuelve a comprobar.
        let res = self.create_child(&p, p.policy.argv.clone(), ack_unverified);
        // La decisión de la persona fue aprobar: se registra `approved` aunque el
        // lanzamiento falle (detail_json.launch_error); a la UI y al agente les llega
        // `launch_failed` con el mensaje. No se reintenta solo.
        let (state_, outcome, task, reason, launch_error) = match res {
            Ok(task) => (PendState::Approved(task.clone()), "approved", Some(task), None, None),
            Err(e) => {
                let r = format!("Aprobado, pero no se pudo lanzar: {e}");
                (PendState::LaunchFailed(r.clone()), "launch_failed", None, Some(r), Some(e))
            }
        };
        let decision = self.finish(&p, "human", "approved", task.as_ref(), reason.as_deref(), launch_error.as_deref());
        if let Some(e) = self.pend().get_mut(pending_id) {
            e.state = state_;
            e.decision = decision;
            e.resolved_at = Some(state::now_ms());
        }
        let v = self.resolved_payload(pending_id, outcome, task.as_ref(), decision, reason.as_deref());
        self.emit(EV_RESOLVED, &v);
        Ok(v)
    }

    pub fn reject_spawn(&self, pending_id: &str, confirm: bool, reason: Option<&str>) -> Result<Value, String> {
        if !confirm {
            return Err("Rechazar un lanzamiento necesita la confirmación explícita de la persona (confirm: true)".into());
        }
        self.sweep_pending();
        let reason = reason.map(str::trim).filter(|r| !r.is_empty()).unwrap_or("Rechazado por la persona").to_string();
        let p = {
            let mut pend = self.pend();
            match pend.get_mut(pending_id) {
                Some(e) if e.state == PendState::Pending => {
                    e.state = PendState::Rejected(reason.clone());
                    e.resolved_at = Some(state::now_ms());
                    e.p.clone()
                }
                _ => {
                    drop(pend);
                    return Ok(self.already(pending_id).unwrap_or(Value::Null));
                }
            }
        };
        let decision = self.finish(&p, "human", "rejected", None, Some(&reason), None);
        if let Some(e) = self.pend().get_mut(pending_id) {
            e.decision = decision;
        }
        let v = self.resolved_payload(pending_id, "rejected", None, decision, Some(&reason));
        self.emit(EV_RESOLVED, &v);
        Ok(v)
    }

    /// El run se elimina: sus pendientes salen de la lista y vencen sin fila de
    /// decisión (la tarea padre desaparece con el run).
    pub(super) fn expire_run_pending(&self, run: &str) {
        let now = state::now_ms();
        let gone: Vec<String> = {
            let mut pend = self.pend();
            pend.values_mut().filter(|e| e.p.run == run && e.state == PendState::Pending).map(|e| {
                e.state = PendState::Expired;
                e.resolved_at = Some(now);
                e.p.pending_id.clone()
            }).collect()
        };
        for id in gone {
            let v = self.resolved_payload(&id, "expired", None, None, None);
            self.emit(EV_RESOLVED, &v);
        }
    }

    /// Vence los pendientes caducados y los de coordinadores que ya no siguen.
    pub fn sweep_pending(&self) {
        let now = state::now_ms();
        let parents: HashSet<String> = self.pend().values().filter(|e| e.state == PendState::Pending).map(|e| e.p.parent_task.clone()).collect();
        if parents.is_empty() {
            self.pend().retain(|_, e| e.resolved_at.is_none_or(|t| now.saturating_sub(t) < KEEP_RESOLVED_MS));
            return;
        }
        let dead: HashSet<String> = {
            let st = self.lock();
            parents.into_iter().filter(|id| match st.tasks.get(id) {
                None => true,
                Some(t) => t.status.is_final() || st.runs.get(&t.run).is_none_or(|r| r.closed),
            }).collect()
        };
        let expired: Vec<PendingSpawn> = {
            let mut pend = self.pend();
            pend.retain(|_, e| e.resolved_at.is_none_or(|t| now.saturating_sub(t) < KEEP_RESOLVED_MS));
            pend.values_mut().filter(|e| e.state == PendState::Pending && (now >= e.p.expires_at || dead.contains(&e.p.parent_task)))
                .map(|e| {
                    e.state = PendState::Expired;
                    e.resolved_at = Some(now);
                    e.p.clone()
                }).collect()
        };
        for p in expired {
            let decision = self.finish(&p, "system", "expired", None, None, None);
            if let Some(e) = self.pend().get_mut(&p.pending_id) {
                e.decision = decision;
            }
            let v = self.resolved_payload(&p.pending_id, "expired", None, decision, None);
            self.emit(EV_RESOLVED, &v);
        }
    }
}

pub struct NewPending {
    pub provider: String,
    pub profile: String,
    pub role: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub title: String,
    pub spec: String,
    pub shared: bool,
    pub base: Option<String>,
}

#[cfg(test)]
impl Core {
    /// En pruebas no se abre ninguna terminal ni CLI: se resuelve y autoriza la
    /// política igual que `launch` y se anota el lanzamiento.
    pub(super) fn fake_launch(&self, id: &str) -> Result<(), String> {
        let t = self.lock().task(id)?.clone();
        let profile = t.profile.clone().unwrap_or_default();
        let policy = self.task_policy(&t.agent, &profile, t.role.as_deref(), &t.cwd, t.model.as_deref());
        let record = agents::authorize(&policy, t.requested_argv.as_deref(), t.ack_unverified)?;
        self.lock().task_mut(id)?.policy = Some(record);
        self.launched.lock().unwrap().push(id.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::host::RecordingHost;
    use super::super::{Orch, Status};
    use super::*;
    use crate::orch::state::NewTask;
    use std::path::{Path, PathBuf};

    fn fake(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> agents::Policy {
        let prof = agents::Profile::parse(profile).expect("perfil");
        agents::evaluate_for(provider, prof, role, worktree, agents::Detected::Skip, false, agents::Delivery::FileOrMarkers)
    }

    fn git(dir: &Path, args: &[&str]) {
        let o = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(o.status.success(), "{args:?} {}", String::from_utf8_lossy(&o.stderr));
    }

    struct Env { core: Arc<Core>, host: Arc<RecordingHost>, root: String, run: String, dir: PathBuf }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
            if let Some(p) = self.dir.parent() {
                let _ = std::fs::remove_dir_all(p.join(format!("{}.lixbon-wt", self.dir.file_name().unwrap().to_string_lossy())));
            }
        }
    }

    fn setup(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("lxo-aprob-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for a in [&["init", "-q", "-b", "master"][..], &["config", "user.name", "t"], &["config", "user.email", "t@t"]] { git(&dir, a); }
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "base"]);
        let mut orch = Orch::default();
        Arc::get_mut(&mut orch.0).unwrap().resolver = fake;
        let core = orch.0;
        let host = RecordingHost::new();
        core.set_host(host.clone());
        core.settings.lock().unwrap().enabled = true;
        let cwd = dir.to_string_lossy().into_owned();
        let (run, root) = {
            let mut st = core.lock();
            let (run, root) = st.create_run("obj", NewTask { agent: "coordinador".into(), model: None, effort: None, role: None, title: "obj".into(),
                spec: "obj".into(), repo: cwd.clone(), cwd: cwd.clone(), branch: Some("master".into()), base: None, worktree: None, external: true });
            st.mark_running(&root).unwrap();
            (run, root)
        };
        Env { core, host, root, run, dir }
    }

    impl Env {
        fn agent(&self) -> Caller { Caller::Agent(Some(self.root.clone())) }
        fn spawn(&self, agent: &str) -> Value {
            self.core.rpc(self.agent(), "", "spawn", &json!({ "agent": agent, "task": format!("Encargo para {agent}\nDetalle"), "name": format!("Hija {agent}") })).unwrap()
        }
        fn status(&self, id: &str) -> Value {
            self.core.rpc(self.agent(), "", "spawn_status", &json!({ "pending_id": id })).unwrap()
        }
        fn argv(&self, id: &str) -> Vec<String> {
            self.core.list_pending_spawns().into_iter().find(|p| p.pending_id == id).unwrap().policy.argv
        }
        fn launched(&self) -> Vec<String> { self.core.launched.lock().unwrap().clone() }
        fn children(&self) -> usize { self.core.lock().tasks.values().filter(|t| t.parent.is_some()).count() }
        fn decisions(&self, pid: &str) -> Vec<(String, Value)> {
            self.core.lock().decisions.iter().filter(|d| d.kind == "spawn")
                .map(|d| (d.actor.clone(), serde_json::from_str::<Value>(d.detail_json.as_deref().unwrap()).unwrap()))
                .filter(|(_, v)| v["pending_id"] == pid).collect()
        }
    }

    fn pid(v: &Value) -> String { v["pending_id"].as_str().unwrap().to_string() }

    #[test]
    fn un_agente_no_puede_aprobar_ni_listar() {
        let e = setup("agente");
        let p = e.spawn("claude");
        for c in ["approve_spawn", "orch_approve_spawn", "reject_spawn", "orch_reject_spawn", "list_pending_spawns", "orch_list_pending_spawns"] {
            for caller in [e.agent(), Caller::Agent(None), Caller::User] {
                let r = e.core.rpc(caller, "", c, &json!({ "pending_id": pid(&p), "confirm": true, "argv": e.argv(&pid(&p)) }));
                assert_eq!(r.unwrap_err(), format!("Comando desconocido: {c}"));
            }
        }
        let server = include_str!("server.rs");
        assert!(!server.contains("approve") && !server.contains("reject") && !server.contains("pending"));
        // La interfaz tampoco consulta ni pide lanzamientos por orch_call (no es una tarea).
        assert!(e.core.rpc(Caller::User, "", "spawn_status", &json!({ "pending_id": pid(&p) })).is_err());
        assert!(e.core.rpc(Caller::User, "", "spawn", &json!({ "agent": "claude", "task": "x" })).is_err());
        assert!(e.launched().is_empty());
    }

    #[test]
    fn spawn_queda_pendiente_y_sin_confirm_se_rechaza() {
        let e = setup("pendiente");
        let p = e.spawn("claude");
        assert_eq!(p["status"], "pending");
        assert_eq!(e.children(), 0, "no se crea tarea hasta aprobar");
        assert_eq!(e.status(&pid(&p))["status"], "pending");
        let list = e.core.list_pending_spawns();
        assert_eq!(list.len(), 1);
        let shown = serde_json::to_value(&list[0]).unwrap();
        for k in ["pending_id", "parent_task", "run", "provider", "profile", "role", "policy", "title", "spec_summary", "agent", "integrate_into", "cwd", "created_at", "expires_at"] {
            assert!(shown.get(k).is_some(), "falta {k}: {shown}");
        }
        assert!(shown.get("spec").is_none());
        assert_eq!(shown["agent"], "claude");
        assert_eq!(shown["integrate_into"]["branch"], "master");
        assert_eq!(shown["integrate_into"]["dir"], json!(e.dir.to_string_lossy()));
        assert_eq!(shown["expires_at"].as_u64().unwrap() - shown["created_at"].as_u64().unwrap(), DEFAULT_TTL_SECS * 1000);
        assert!(e.core.approve_spawn(&pid(&p), false, &e.argv(&pid(&p)), true).is_err());
        assert!(e.core.reject_spawn(&pid(&p), false, None).is_err());
        assert!(e.launched().is_empty());
        assert_eq!(e.core.list_pending_spawns().len(), 1);
        // Sin ack con política sin verificar: error de uso, sigue pendiente.
        assert!(e.core.approve_spawn(&pid(&p), true, &e.argv(&pid(&p)), false).is_err());
        assert_eq!(e.core.list_pending_spawns().len(), 1);
    }

    #[test]
    fn doble_confirmacion_lanza_una_sola_vez() {
        let e = setup("doble");
        let p = pid(&e.spawn("claude"));
        let argv = e.argv(&p);
        let outs: Vec<Value> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..4).map(|_| sc.spawn(|| e.core.approve_spawn(&p, true, &argv, true).unwrap())).collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let approved: Vec<&Value> = outs.iter().filter(|o| o["outcome"] == "approved").collect();
        assert_eq!(approved.len(), 1, "{outs:?}");
        assert_eq!(outs.iter().filter(|o| o["outcome"] == "already_resolved").count(), 3);
        assert_eq!(e.launched().len(), 1);
        assert_eq!(e.children(), 1);
        let again = e.core.approve_spawn(&p, true, &argv, true).unwrap();
        assert_eq!(again["outcome"], "already_resolved");
        assert_eq!(e.launched().len(), 1);
        let task = approved[0]["task"]["task"].as_str().unwrap().to_string();
        let st = e.status(&p);
        assert_eq!((st["status"].as_str(), st["task"]["task"].as_str()), (Some("approved"), Some(task.as_str())));
        let d = e.decisions(&p);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].0, "human");
        assert_eq!((d[0].1["outcome"].as_str(), d[0].1["task"].as_str()), (Some("approved"), Some(task.as_str())));
        assert_eq!(d[0].1["argv"], json!(argv));
        assert_eq!(approved[0]["decision"]["actor"], "human");
        // La hija corre en el worktree que se mostró en el pendiente.
        let t = e.core.lock().task(&task).unwrap().clone();
        assert!(t.worktree.as_deref().is_some_and(|w| w.contains(&p)));
        assert!(Path::new(t.worktree.as_deref().unwrap()).is_dir());
    }

    #[test]
    fn confirmar_tras_rechazo_no_lanza() {
        let e = setup("rechazo");
        let p = pid(&e.spawn("codex"));
        let r = e.core.reject_spawn(&p, true, Some("No hace falta")).unwrap();
        assert_eq!((r["outcome"].as_str(), r["reason"].as_str()), (Some("rejected"), Some("No hace falta")));
        let a = e.core.approve_spawn(&p, true, &[], true).unwrap();
        assert_eq!(a["outcome"], "already_resolved");
        assert_eq!(e.core.reject_spawn(&p, true, None).unwrap()["outcome"], "already_resolved");
        assert!(e.launched().is_empty());
        assert_eq!(e.children(), 0);
        let st = e.status(&p);
        assert_eq!((st["status"].as_str(), st["reason"].as_str()), (Some("rejected"), Some("No hace falta")));
        let d = e.decisions(&p);
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].0.as_str(), d[0].1["outcome"].as_str()), ("human", Some("rejected")));
    }

    #[test]
    fn vencido_queda_expired_con_decision_de_sistema() {
        let e = setup("vence");
        let p = pid(&e.spawn("claude"));
        let argv = e.argv(&p);
        e.core.pend().get_mut(&p).unwrap().p.expires_at = 0;
        assert_eq!(e.status(&p)["status"], "expired");
        assert!(e.core.list_pending_spawns().is_empty());
        assert_eq!(e.core.approve_spawn(&p, true, &argv, true).unwrap()["outcome"], "expired");
        assert!(e.launched().is_empty());
        let d = e.decisions(&p);
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].0.as_str(), d[0].1["outcome"].as_str()), ("system", Some("expired")));
        assert!(d[0].1["decided_at"].as_u64().is_some() && d[0].1["created_at"].as_u64().is_some());
    }

    #[test]
    fn coordinador_terminado_o_run_eliminado_limpia_sus_pendientes() {
        let e = setup("muerto");
        let p = pid(&e.spawn("claude"));
        let argv = e.argv(&p);
        e.host.clear_events();
        e.core.lock().close(&e.root, Status::Exited, "se cerró").unwrap();
        assert!(e.core.list_pending_spawns().is_empty());
        let ev: Vec<_> = e.host.events().into_iter().filter(|(n, v)| n == EV_RESOLVED && v["pending_id"] == p.as_str()).collect();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].1["outcome"], "expired");
        assert_eq!(ev[0].1["decision"]["actor"], "system");
        assert_eq!(e.status(&p)["status"], "expired");
        let d = e.decisions(&p);
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].0.as_str(), d[0].1["outcome"].as_str()), ("system", Some("expired")));
        let late = e.core.approve_spawn(&p, true, &argv, true).unwrap();
        assert!(late["outcome"] == "expired" || late["outcome"] == "already_resolved", "{late}");
        assert!(e.launched().is_empty());
        assert_eq!(e.children(), 0);
        assert_eq!(e.decisions(&p).len(), 1);

        let e2 = setup("eliminado");
        let p2 = pid(&e2.spawn("codex"));
        e2.core.rpc(Caller::User, "", "remove_run", &json!({ "run": e2.run })).unwrap();
        assert!(e2.core.list_pending_spawns().is_empty());
        assert_eq!(e2.status(&p2)["status"], "expired");
        // Sin tarea padre no queda fila (como el ON DELETE CASCADE de decisions.task).
        assert!(e2.decisions(&p2).is_empty());
        assert!(e2.launched().is_empty());
    }

    #[test]
    fn argv_distinto_no_lanza_y_sigue_pendiente() {
        let e = setup("argv");
        let p = pid(&e.spawn("claude"));
        let mut evil = e.argv(&p);
        evil.push("--dangerously-skip-permissions".into());
        let err = e.core.approve_spawn(&p, true, &evil, true).unwrap_err();
        assert!(err.contains("no coincide"), "{err}");
        assert!(e.launched().is_empty());
        assert_eq!(e.children(), 0);
        assert_eq!(e.status(&p)["status"], "pending");
        assert!(e.decisions(&p).is_empty());
        // Con el argv que resolvió el host sí se lanza, y se lanza ese.
        let ok = e.core.approve_spawn(&p, true, &e.argv(&p), true).unwrap();
        assert_eq!(ok["outcome"], "approved");
        let task = ok["task"]["task"].as_str().unwrap();
        let recorded: Vec<String> = e.decisions(&p)[0].1["argv"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        let launched_argv = e.core.lock().task(task).unwrap().requested_argv.clone().unwrap();
        assert_eq!(launched_argv, recorded);
        assert!(!launched_argv.contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn dos_pendientes_claude_y_codex_son_independientes() {
        let e = setup("dos");
        let c = pid(&e.spawn("claude"));
        let x = pid(&e.spawn("codex"));
        assert_ne!(c, x);
        assert_eq!(e.core.list_pending_spawns().len(), 2);
        let ok = e.core.approve_spawn(&x, true, &e.argv(&x), true).unwrap();
        assert_eq!(ok["outcome"], "approved");
        assert_eq!(e.status(&c)["status"], "pending");
        assert_eq!(e.core.reject_spawn(&c, true, None).unwrap()["outcome"], "rejected");
        assert_eq!(e.status(&x)["status"], "approved");
        assert_eq!(e.launched().len(), 1);
        assert_eq!(e.children(), 1);
        assert_eq!(e.decisions(&c).len(), 1);
        assert_eq!(e.decisions(&x).len(), 1);
    }

    #[test]
    fn orquestador_desactivado_rechaza_spawn_sin_pendiente() {
        let e = setup("desactivado");
        e.core.settings.lock().unwrap().enabled = false;
        let err = e.core.rpc(e.agent(), "", "spawn", &json!({ "agent": "claude", "task": "x" })).unwrap_err();
        assert!(err.contains("desactivado"), "{err}");
        assert!(e.core.pend().is_empty());
        assert!(e.core.list_pending_spawns().is_empty());
    }

    #[test]
    fn lanzamiento_fallido_registra_approved_con_launch_error() {
        let e = setup("fallo");
        let p = pid(&e.core.rpc(e.agent(), "", "spawn", &json!({ "agent": "claude", "task": "x", "base": "rama-que-no-existe" })).unwrap());
        let out = e.core.approve_spawn(&p, true, &e.argv(&p), true).unwrap();
        assert_eq!(out["outcome"], "launch_failed", "{out}");
        assert!(out["reason"].as_str().unwrap().contains("no se pudo lanzar"));
        assert!(e.launched().is_empty());
        assert_eq!(e.children(), 0);
        let d = e.decisions(&p);
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].0.as_str(), d[0].1["outcome"].as_str()), ("human", Some("approved")));
        assert!(d[0].1["launch_error"].as_str().is_some_and(|m| !m.is_empty()));
        let st = e.status(&p);
        assert_eq!(st["status"], "launch_failed");
        assert!(st["reason"].as_str().is_some());
        let ev = e.host.events().into_iter().filter(|(n, v)| n == EV_RESOLVED && v["pending_id"] == p.as_str()).collect::<Vec<_>>();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].1["outcome"], "launch_failed");
        // Sin reintento automático: otra confirmación no lanza.
        assert_eq!(e.core.approve_spawn(&p, true, &[], true).unwrap()["outcome"], "already_resolved");
        assert!(e.launched().is_empty());
    }

    #[test]
    fn run_eliminado_quita_pendientes_y_emite_expired_sin_decision() {
        let e = setup("borrado");
        let a = pid(&e.spawn("claude"));
        let b = pid(&e.spawn("codex"));
        e.host.clear_events();
        e.core.rpc(Caller::User, "", "remove_run", &json!({ "run": e.run })).unwrap();
        assert!(e.core.list_pending_spawns().is_empty());
        let ev = e.host.events();
        for id in [&a, &b] {
            let mine: Vec<_> = ev.iter().filter(|(n, v)| n == EV_RESOLVED && v["pending_id"] == id.as_str()).collect();
            assert_eq!(mine.len(), 1, "{ev:?}");
            assert_eq!(mine[0].1["outcome"], "expired");
            assert_eq!(mine[0].1["decision"], Value::Null);
            assert!(e.decisions(id).is_empty());
        }
        assert!(e.core.lock().decisions.iter().all(|d| d.kind != "spawn"));
    }

    #[test]
    fn spawn_status_de_id_desconocido_es_expired() {
        let e = setup("desconocido");
        assert_eq!(e.status("sp-no-existe")["status"], "expired");
        assert_eq!(e.core.approve_spawn("sp-no-existe", true, &[], true).unwrap()["outcome"], "expired");
        assert_eq!(e.core.reject_spawn("sp-no-existe", true, None).unwrap()["outcome"], "expired");
    }

    #[test]
    fn ttl_configurable_por_entorno() {
        assert_eq!(ttl_ms(), DEFAULT_TTL_SECS * 1000);
    }

    /// Los tres comandos por el IPC de Tauri (MockRuntime), con el JSON de la webview.
    #[test]
    fn la_webview_envia_pending_id_en_snake_case() {
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
        use tauri::webview::InvokeRequest;

        let e = setup("ipc");
        let a = pid(&e.spawn("claude"));
        let r = pid(&e.spawn("codex"));
        let argv = e.argv(&a);
        let app = mock_builder().manage(Orch(e.core.clone()))
            .invoke_handler(tauri::generate_handler![crate::orch::orch_list_pending_spawns, crate::orch::orch_approve_spawn, crate::orch::orch_reject_spawn])
            .build(mock_context(noop_assets())).unwrap();
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        let invoke = |cmd: &str, body: Value| {
            get_ipc_response(&webview, InvokeRequest {
                cmd: cmd.into(), callback: CallbackFn(0), error: CallbackFn(1),
                url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(), body: InvokeBody::Json(body),
                headers: Default::default(), invoke_key: INVOKE_KEY.to_string(),
            }).map(|r| r.deserialize::<Value>().unwrap())
        };
        let list = invoke("orch_list_pending_spawns", json!({})).unwrap();
        assert_eq!(list.as_array().unwrap().len(), 2);
        // camelCase no llega: falta pending_id y Tauri rechaza la llamada.
        assert!(invoke("orch_approve_spawn", json!({ "pendingId": a, "confirm": true, "argv": argv, "ackUnverified": true })).is_err());
        assert!(invoke("orch_approve_spawn", json!({ "pending_id": a, "argv": argv })).is_err(), "confirm es obligatorio");
        // ack en camelCase se ignora (None) y la política sin verificar no se lanza.
        assert!(invoke("orch_approve_spawn", json!({ "pending_id": a, "confirm": true, "argv": argv, "ackUnverified": true })).is_err());
        assert!(e.launched().is_empty());
        let ok = invoke("orch_approve_spawn", json!({ "pending_id": a, "confirm": true, "argv": argv, "ack_unverified": true })).unwrap();
        assert_eq!(ok["outcome"], "approved", "{ok}");
        let rej = invoke("orch_reject_spawn", json!({ "pending_id": r, "confirm": true, "reason": "no" })).unwrap();
        assert_eq!(rej["outcome"], "rejected");
        assert!(invoke("orch_list_pending_spawns", json!({})).unwrap().as_array().unwrap().is_empty());
        assert_eq!(e.launched().len(), 1);
    }
}
