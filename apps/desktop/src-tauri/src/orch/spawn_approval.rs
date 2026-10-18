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
//! - Los pendientes viven solo en memoria: al reiniciar la app no se reconstruyen ni se reconcilian todavía; ese
//!   trabajo durable se sigue por separado. Un id desconocido se responde como `expired`.
//! - Si el coordinador termina, o su run se cierra, sus pendientes vencen (`expired` para el agente;
//!   `coordinator_closed` en el Event Log, actor `system`); al caducar el plazo, `timeout`. Si el run se elimina,
//!   `cancelled_run_removed` en la misma mutación que `run.removed`.
//! - Una sola decisión por `pending_id` en `state.json` (`kind = "spawn"`) y UN `spawn.resolved` en el Event Log.
//! - Event Log: `spawn.requested` se persiste ANTES de crear el pendiente en memoria y `spawn.resolved` ANTES de
//!   cambiar su estado en memoria (ver `Core::gate`). `expired` solo existe en esta API; no es un outcome del log.
//! - El argv que manda la UI al aprobar solo se compara: el host lanza siempre
//!   el argv que él mismo vuelve a resolver. Si no coincide, no se lanza nada,
//!   no se crea tarea y el pendiente **sigue pendiente** (la persona puede
//!   recargar la vista y confirmar con la política actual o rechazarlo).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};

use super::events::MutationContext;
use super::mutation::Health;
use super::tx_ops::{spawn_requested_fact, spawn_resolution_fact, SpawnOutcome, SpawnRecorded, SpawnResolution};
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
    /// Se conserva para emitir la resolución standalone si el padre ya no está en el estado confirmado.
    #[serde(skip)]
    pub project_id: Option<String>,
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

    #[cfg(test)]
    pub(super) fn expire_pending_for_test(&self, pending_id: &str) {
        if let Some(entry) = self.pend().get_mut(pending_id) {
            entry.p.expires_at = 0;
        }
    }

    /// Serializa las TRANSICIONES de un pendiente (solicitar, aprobar, resolver, vencer, quitar un run) y el
    /// snapshot de limpieza de `remove_run`. La aprobación conserva la compuerta durante `create_child` para que
    /// esa limpieza no omita una hija que se está creando. Orden de bloqueos: compuerta → estado → almacén →
    /// `pending`; nadie toma la compuerta con el estado o el almacén ya tomados.
    ///
    /// Es lo que hace fiable el orden frente a `remove_run`: o `spawn.requested` queda persistido y el pendiente
    /// en memoria ANTES de que `remove_run` tome su instantánea (y entonces se cancela con el run), o `remove_run`
    /// termina primero y la revalidación del padre rechaza la solicitud. Sin compuerta, una solicitud persistida
    /// entre la instantánea y el COMMIT quedaría sin resolver.
    fn gate(&self) -> std::sync::MutexGuard<'_, ()> {
        self.pend_gate.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// El padre sigue vivo: existe, es del mismo run, no está final y el run existe y no está cerrado.
    fn check_parent_live(&self, p: &PendingSpawn) -> Result<(), String> {
        let st = self.lock();
        let vivo = st.tasks.get(&p.parent_task).is_some_and(|t| t.run == p.run && !t.status.is_final()) && st.runs.get(&p.run).is_some_and(|r| !r.closed);
        if vivo {
            Ok(())
        } else {
            Err("Tu run está cerrado o tu tarea ya terminó: no se pueden lanzar hijas".into())
        }
    }

    /// `spawn` de un agente: valida, resuelve la política y deja el lanzamiento pendiente.
    ///
    /// Orden obligatorio, con la compuerta tomada:
    /// `plan → revalidar el padre → record_facts(spawn.requested) → insertar el pendiente → EV_PENDING / aviso`.
    /// Si el hecho no se puede persistir (también con el Core en solo lectura) no existe pendiente en memoria,
    /// ni aviso, ni lanzamiento posible. Si el padre se perdió en la carrera con `remove_run` o con un cierre, no
    /// se persiste nada: nunca existió una solicitud durable.
    pub(super) fn spawn_request(self: &Arc<Self>, ctx: MutationContext, caller: &Caller, args: &Value) -> Result<Value, String> {
        let plan = self.plan_spawn(caller, args)?;
        // Un perfil bloqueado se rechaza sin preguntar a nadie. SOLO una denegación explícita de policy (tipada,
        // `agents::explicit_denial`, sobre el worktree real) deja constancia durable de la solicitud antes de devolverla;
        // un bloqueo del entorno o del proveedor se rechaza como siempre, sin `spawn.requested`, y nunca es `risk` (si la causa tipada
        // es del proveedor, `observe_environment` deja `environment.blocked`).
        //
        // La denegación explícita se decide por tipos y su política es estática (`agents::denial_policy`): ANTES de
        // denegar no se lanza ningún subproceso de la CLI del proveedor (sonda de `--version`/`--help`, lista de modelos).
        let explicit = agents::Profile::parse(&plan.profile).filter(|profile| agents::explicit_denial(&plan.provider, *profile, &plan.cwd).is_some());
        let policy = match explicit {
            Some(profile) => agents::denial_policy(&plan.provider, profile, plan.role.as_deref(), &plan.cwd, plan.model.as_deref()),
            None => self.resolve_and_observe(&plan.provider, &plan.profile, plan.role.as_deref(), &plan.cwd, plan.model.as_deref())?,
        };
        let mut registrar_denegacion = None;
        if policy.status == agents::Status::Blocked {
            let denial = agents::authorize(&policy, None, true).expect_err("authorize rechaza siempre una policy bloqueada");
            if explicit.is_none() {
                return Err(denial);
            }
            registrar_denegacion = Some(denial);
        }
        let now = state::now_ms();
        let mut p = plan;
        p.policy = policy;
        p.created_at = now;
        p.expires_at = now + self.ttl_ms;
        self.spawn_hook(super::spawn::SpawnStep::BeforeRequestRevalidation, &p.parent_task)?;
        {
            let _gate = self.gate();
            self.check_parent_live(&p)?;
            let fact = spawn_requested_fact(&ctx, &p)?;
            // `record_facts` devuelve éxito SIN guardar nada cuando el backend no tiene Event Log (`state.json`). Una
            // denegación solo se devuelve con su Event durable: sin Event Log no hay dónde dejarlo, así que se informa
            // de eso (no de una denegación «registrada»). Sigue sin pendiente ni efecto alguno.
            if let Some(denial) = &registrar_denegacion {
                if !self.event_log_available() {
                    return Err(format!(
                        "No se pudo dejar constancia durable de la solicitud denegada: este modo (state.json) no tiene Event Log. No se lanza nada. Motivo de la denegación: {denial}"
                    ));
                }
            }
            self.record_facts(&ctx, vec![fact]).map_err(String::from)?;
            if let Some(denial) = registrar_denegacion {
                // Ya es durable. La denegación NO crea pendiente, Task, aprobación, aviso, terminal, proceso ni
                // worktree, y no habrá `spawn.resolved`: la solicitud nace y termina denegada.
                return Err(denial);
            }
            self.pend().insert(p.pending_id.clone(), Entry { p: p.clone(), state: PendState::Pending, decision: None, resolved_at: None });
            // La fila durable, el estado en memoria, el evento de UI y el aviso quedan serializados contra
            // reject/sweep/approve: nunca se publica una tarjeta después de su resolución.
            self.spawn_hook(super::spawn::SpawnStep::AfterRequestPersistBeforeEmit, &p.pending_id)?;
            self.emit(EV_PENDING, &json!(p));
            self.notify_pending(&p);
        }
        Ok(json!({
            "status": "pending", "pending_id": p.pending_id, "expires_at": p.expires_at,
            "provider": p.provider, "profile": p.profile, "role": p.role, "title": p.title,
            "policy_status": p.policy.status,
        }))
    }

    /// Resuelve la policy del host Y deja constancia durable de lo que dice del entorno, en UN solo paso serializado
    /// (`env_gate`). Es el único punto por el que `spawn_request`, `approve_spawn` y el recheck de `launch` consultan la
    /// policy real: la resolución y la observación son atómicas entre sí, así que una comprobación más vieja no puede
    /// escribir después de una más nueva (carrera de frescura). El orden de bloqueos es `pend_gate → env_gate → estado →
    /// almacén`: ningún camino toma `pend_gate` con `env_gate` ya tomado.
    pub(super) fn resolve_and_observe(&self, provider: &str, profile: &str, role: Option<&str>, cwd: &str, model: Option<&str>) -> Result<agents::Policy, String> {
        let _env = self.env_gate.lock().unwrap_or_else(|e| e.into_inner());
        let policy = self.task_policy(provider, profile, role, cwd, model);
        self.observe_environment(&policy)?;
        Ok(policy)
    }

    /// Deja constancia durable de lo que la policy resuelta dice del ENTORNO del proveedor en el perfil comprobado
    /// (`environment.blocked` / `environment.cleared`, ver `Tx::environment_blocked`). Solo mira la causa TIPADA
    /// (`Policy.block`), nunca el texto de `reason`, y solo escribe cuando el bloqueo vigente cambia.
    ///
    /// * `Blocked` por una causa de ENTORNO → `environment.blocked`. Cualquier otro bloqueo (perfil deshabilitado, entrada
    ///   inválida, ruta de la solicitud) no dice nada del entorno: ni lo bloquea ni lo levanta.
    /// * SOLO una policy `ok` (comprobación positiva y verificada) levanta un bloqueo. `unverified` o un estado desconocido
    ///   lo CONSERVAN: sin evidencia suficiente no se asume que el entorno se recuperó.
    /// * Sin Event Log (`state.json`) no se marca nada: un marcador sin su Event durable ocultaría la señal para siempre.
    ///   En producción ese modo es solo lectura (arranque `DegradeC1`) y la mutación se rechaza antes de tocar el estado.
    fn observe_environment(&self, policy: &agents::Policy) -> Result<(), String> {
        if !self.event_log_available() {
            return Ok(());
        }
        let (provider, profile) = (policy.provider.as_str(), policy.profile.as_str());
        match (policy.status, policy.block) {
            (agents::Status::Blocked, Some(agents::BlockCause::Environment(code))) => self
                .mutate_as(&MutationContext::core(), |tx| {
                    if !tx.environment_blocked(provider, profile, code) {
                        tx.no_change();
                    }
                    Ok(())
                })
                .map_err(String::from),
            (agents::Status::Ok, _) if self.lock().has_env_blocks_of(provider) => self
                .mutate_as(&MutationContext::core(), |tx| {
                    if !tx.environment_verified(provider, profile) {
                        tx.no_change();
                    }
                    Ok(())
                })
                .map_err(String::from),
            _ => Ok(()),
        }
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
            pending_id, parent_task: parent.id.clone(), run: parent.run.clone(), project_id: parent.project_id.clone(), agent: f.provider.clone(), provider: f.provider, profile: f.profile,
            role: f.role, model: f.model, effort: f.effort, spec_summary: summary(&f.spec), title: f.title, cwd, shared: f.shared,
            env: if f.shared { worktree_env::Plan::default() } else { worktree_env::plan(&parent.repo) },
            policy: agents::Policy { profile: String::new(), role: None, provider: String::new(), argv: vec![], cli_version: None, warnings: vec![], status: agents::Status::Unverified, reason: None, interactive: false, model: None, block: None },
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

    /// Persiste la resolución de `p` (ANTES de cambiar nada en memoria) y devuelve el id de la fila legacy si la
    /// hubo. Con la tarea padre viva: una sola mutación con la fila `Decision(spawn)` y `spawn.resolved`
    /// (`Tx::record_spawn_resolution`); si ya existía una fila para ese `pending_id` no se añade otra. Con el padre
    /// ya desaparecido no hay fila ni estado que cambiar: el hecho va standalone (`record_facts`). NO es un
    /// efecto externo: aprobar, rechazar o vencer se registra con una mutación normal, no con `mutate_after_effect`.
    fn persist_resolution(&self, p: &PendingSpawn, r: &Resolution<'_>) -> Result<Option<u64>, String> {
        // Quién resuelve: la persona desde la interfaz, o el propio Core al vencer el pendiente.
        let ctx = if r.outcome.decided_by_person() {
            self.desktop_mutation_context()?
        } else {
            MutationContext::core()
        };
        if !self.lock().tasks.contains_key(&p.parent_task) {
            let fact = spawn_resolution_fact(&ctx, p, r.outcome, r.task, r.has_reason)?;
            return self.record_facts(&ctx, vec![fact]).map(|_| None).map_err(String::from);
        }
        let detail = json!({
            "pending_id": p.pending_id, "parent_task": p.parent_task, "profile": p.profile, "argv": p.policy.argv,
            "policy_status": p.policy.status, "outcome": r.legacy_outcome, "created_at": p.created_at, "decided_at": state::now_ms(),
            "task": r.task, "reason": r.reason, "launch_error": r.launch_error,
        });
        self.mutate_as(&ctx, |tx| {
            let res = SpawnResolution {
                pending_id: &p.pending_id,
                parent_task: &p.parent_task,
                outcome: r.outcome,
                task: r.task,
                has_reason: r.has_reason,
                legacy: Some((r.actor, &detail)),
            };
            match tx.record_spawn_resolution(&res)? {
                SpawnRecorded::Recorded(id) => Ok(id),
                SpawnRecorded::Duplicate => {
                    tx.no_change();
                    Ok(None)
                }
            }
        })
        .map_err(String::from)
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
    ///
    /// `Pending → Launching → create_child → persistir la resolución → Approved | LaunchFailed`. Con el Core en
    /// solo lectura no se empieza (no hay efectos externos que no se puedan registrar). Si la resolución no se
    /// puede persistir DESPUÉS de `create_child`, el pendiente se queda en `Launching`: no vuelve a `Pending`, no
    /// admite una segunda aprobación y se devuelve el error; la reconciliación durable tras reiniciar queda fuera
    /// de esta entrega. El hijo no se compensa aquí: `create_child` tiene sus propios contratos.
    pub fn approve_spawn(self: &Arc<Self>, pending_id: &str, confirm: bool, argv: &[String], ack_unverified: bool) -> Result<Value, String> {
        if !confirm {
            return Err("Aprobar un lanzamiento necesita la confirmación explícita de la persona (confirm: true)".into());
        }
        self.sweep_pending();
        if let Some(v) = self.already(pending_id) {
            return Ok(v);
        }
        if let Health::DegradedReadOnly(why) = self.health() {
            return Err(format!("El Core está en solo lectura ({why}): no se puede aprobar un lanzamiento hasta que se recupere el almacenamiento"));
        }
        let p = self.pend().get(pending_id).map(|e| e.p.clone()).ok_or("Pendiente desaparecido")?;
        let policy = self.resolve_and_observe(&p.provider, &p.profile, p.role.as_deref(), &p.cwd, p.model.as_deref())?;
        // Errores de uso (argv distinto, sin ack, bloqueado ahora): no se lanza y sigue pendiente.
        agents::authorize(&policy, Some(argv), ack_unverified)?;
        let _gate = self.gate();
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
        self.spawn_hook(super::spawn::SpawnStep::AfterApprovalClaim, pending_id)?;
        let mut p = p;
        p.policy = policy;
        // Se lanza con el argv del host (policy.argv); launch() lo vuelve a comprobar.
        let res = self.create_child(&p, p.policy.argv.clone(), ack_unverified);
        // La decisión de la persona fue aprobar: la fila legacy dice `approved` aunque el lanzamiento falle
        // (detail_json.launch_error); el hecho canónico dice `launch_failed`. A la UI y al agente les llega
        // `launch_failed` con el mensaje. No se reintenta solo.
        let (state_, outcome, task, reason, launch_error) = match res {
            Ok(task) => (PendState::Approved(task.clone()), SpawnOutcome::Approved, Some(task), None, None),
            Err(e) => {
                let r = format!("Aprobado, pero no se pudo lanzar: {e}");
                (PendState::LaunchFailed(r.clone()), SpawnOutcome::LaunchFailed, None, Some(r), Some(e))
            }
        };
        let task_id = task.as_ref().and_then(|t| t["task"].as_str());
        let resolution = Resolution {
            outcome,
            actor: "human",
            legacy_outcome: "approved",
            task: task_id,
            reason: reason.as_deref(),
            launch_error: launch_error.as_deref(),
            has_reason: reason.is_some(),
        };
        let decision = self
            .persist_resolution(&p, &resolution)
            .map_err(|e| format!("El lanzamiento se ejecutó pero no se pudo registrar su resolución: {e}. Queda en curso y no se puede aprobar de nuevo; la reconciliación tras reinicio requiere trabajo posterior."))?;
        if let Some(e) = self.pend().get_mut(pending_id) {
            e.state = state_;
            e.decision = decision;
            e.resolved_at = Some(state::now_ms());
        }
        let label = if outcome == SpawnOutcome::Approved { "approved" } else { "launch_failed" };
        let v = self.resolved_payload(pending_id, label, task.as_ref(), decision, reason.as_deref());
        self.emit(EV_RESOLVED, &v);
        Ok(v)
    }

    /// Rechazo de la persona: `Pending → persistir Decision + spawn.resolved → Rejected en memoria → EV_RESOLVED`.
    /// Si la persistencia falla sigue `Pending` y no hay `EV_RESOLVED`.
    pub fn reject_spawn(&self, pending_id: &str, confirm: bool, reason: Option<&str>) -> Result<Value, String> {
        if !confirm {
            return Err("Rechazar un lanzamiento necesita la confirmación explícita de la persona (confirm: true)".into());
        }
        self.sweep_pending();
        let dada = reason.map(str::trim).filter(|r| !r.is_empty());
        let reason = dada.unwrap_or("Rechazado por la persona").to_string();
        let _gate = self.gate();
        let p = {
            let pend = self.pend();
            match pend.get(pending_id) {
                Some(e) if e.state == PendState::Pending => e.p.clone(),
                _ => {
                    drop(pend);
                    return Ok(self.already(pending_id).unwrap_or(Value::Null));
                }
            }
        };
        let resolution = Resolution { outcome: SpawnOutcome::Rejected, actor: "human", legacy_outcome: "rejected", task: None, reason: Some(&reason), launch_error: None, has_reason: dada.is_some() };
        let decision = self.persist_resolution(&p, &resolution)?;
        if let Some(e) = self.pend().get_mut(pending_id) {
            e.state = PendState::Rejected(reason.clone());
            e.decision = decision;
            e.resolved_at = Some(state::now_ms());
        }
        let v = self.resolved_payload(pending_id, "rejected", None, decision, Some(&reason));
        self.emit(EV_RESOLVED, &v);
        Ok(v)
    }

    /// `remove_run` (solo desde la interfaz): UNA mutación `person/ui` con `spawn.resolved` (`cancelled_run_removed`)
    /// por cada pendiente del run y, al final, `run.removed` (y el borrado del run), y SOLO tras el COMMIT los
    /// pendientes pasan a `Expired` en memoria con su `EV_RESOLVED`. Sin fila `Decision(spawn)`: el run y su tarea
    /// padre desaparecen en la misma mutación. La captura/limpieza de terminales y worktrees, la instantánea de
    /// pendientes y el COMMIT ocurren con la compuerta tomada, así que una aprobación concurrente queda incluida
    /// en la limpieza o espera hasta que el run ya no exista. Si el almacenamiento ya está degradado, se rechaza
    /// antes de iniciar el cleanup.
    pub(super) fn remove_run_and_cancel_pending(&self, ctx: &MutationContext, run: &str) -> Result<Vec<Value>, String> {
        self.spawn_hook(super::spawn::SpawnStep::BeforeRunRemovalGate, run)?;
        let _gate = self.gate();
        if let Health::DegradedReadOnly(why) = self.health() {
            return Err(format!("El Core está en solo lectura ({why}): no se puede quitar un run hasta recuperar el almacenamiento"));
        }
        let ids: Vec<String> = self.lock().tasks.values().filter(|t| t.run == run).map(|t| t.id.clone()).collect();
        // Un proceso que no se pudo matar impide quitar el run: sus tareas, worktrees y terminales siguen siendo suyos.
        let sin_control: Vec<String> = ids.iter().filter_map(|id| self.kill_term(id).err().map(|e| format!("{id} ({e})"))).collect();
        if !sin_control.is_empty() {
            return Err(format!("No se pudo detener el proceso de {}: el run se conserva hasta poder matarlo", sin_control.join(", ")));
        }
        let (_, kept) = self.free_worktrees(ctx, run, false);
        self.spawn_hook(super::spawn::SpawnStep::AfterRunRemovalCleanupSnapshot, run)?;
        let snapshot: Vec<PendingSpawn> = {
            let st = self.lock();
            let mut v: Vec<PendingSpawn> = self
                .pend()
                .values()
                .filter(|e| e.p.run == run && e.state == PendState::Pending && st.tasks.contains_key(&e.p.parent_task))
                .map(|e| e.p.clone())
                .collect();
            v.sort_by_key(|p| p.created_at);
            v
        };
        self.mutate_as(ctx, |tx| {
            for p in &snapshot {
                let res = SpawnResolution {
                    pending_id: &p.pending_id,
                    parent_task: &p.parent_task,
                    outcome: SpawnOutcome::CancelledRunRemoved,
                    task: None,
                    has_reason: false,
                    legacy: None,
                };
                tx.record_spawn_resolution(&res)?;
            }
            tx.remove_run(run);
            Ok(())
        })
        .map_err(String::from)?;
        let now = state::now_ms();
        for p in snapshot {
            if let Some(e) = self.pend().get_mut(&p.pending_id) {
                e.state = PendState::Expired;
                e.resolved_at = Some(now);
            }
            let v = self.resolved_payload(&p.pending_id, "expired", None, None, None);
            self.emit(EV_RESOLVED, &v);
        }
        Ok(kept)
    }

    /// Vence los pendientes caducados y los de coordinadores que ya no siguen. Distingue `coordinator_closed`
    /// (el padre ya no existe, está final o su run está cerrado: la causa más específica gana) de `timeout`
    /// (`now >= expires_at`). Persistencia primero: `spawn.resolved` (+ fila del sistema si hay padre) y SOLO
    /// entonces `Expired` en memoria con `EV_RESOLVED` (estado/API compatible `expired`). Si no se puede
    /// persistir sigue `Pending` y se reintenta en el siguiente barrido.
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
        let due: Vec<(PendingSpawn, SpawnOutcome)> = {
            let mut pend = self.pend();
            pend.retain(|_, e| e.resolved_at.is_none_or(|t| now.saturating_sub(t) < KEEP_RESOLVED_MS));
            pend.values()
                .filter(|e| e.state == PendState::Pending)
                .filter_map(|e| {
                    if dead.contains(&e.p.parent_task) {
                        Some((e.p.clone(), SpawnOutcome::CoordinatorClosed))
                    } else if now >= e.p.expires_at {
                        Some((e.p.clone(), SpawnOutcome::Timeout))
                    } else {
                        None
                    }
                })
                .collect()
        };
        for (p, outcome) in due {
            let _gate = self.gate();
            // Otro hilo pudo resolverlo mientras esperábamos la compuerta.
            if !matches!(self.pend().get(&p.pending_id).map(|e| &e.state), Some(PendState::Pending)) {
                continue;
            }
            let resolution = Resolution { outcome, actor: "system", legacy_outcome: "expired", task: None, reason: None, launch_error: None, has_reason: false };
            let Ok(decision) = self.persist_resolution(&p, &resolution) else { continue };
            if let Some(e) = self.pend().get_mut(&p.pending_id) {
                e.state = PendState::Expired;
                e.decision = decision;
                e.resolved_at = Some(state::now_ms());
            }
            let v = self.resolved_payload(&p.pending_id, "expired", None, decision, None);
            self.emit(EV_RESOLVED, &v);
        }
    }
}

/// Cómo se resuelve una solicitud: el outcome canónico del Event Log y lo que la fila legacy conserva.
struct Resolution<'a> {
    outcome: SpawnOutcome,
    /// `"human"` | `"system"`: quién dice la fila legacy.
    actor: &'a str,
    /// El `outcome` de la fila legacy (compatibilidad: un `launch_failed` sigue siendo «approved» con `launch_error`).
    legacy_outcome: &'a str,
    task: Option<&'a str>,
    reason: Option<&'a str>,
    launch_error: Option<&'a str>,
    has_reason: bool,
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
        // Punto de fallo/observación de las pruebas del cleanup (puede dejar un proceso real registrado).
        self.spawn_hook(super::spawn::SpawnStep::InLaunch, id)?;
        let t = self.lock().task(id)?.clone();
        let profile = t.profile.clone().unwrap_or_default();
        let policy = self.resolve_and_observe(&t.agent, &profile, t.role.as_deref(), &t.cwd, t.model.as_deref())?;
        let record = agents::authorize(&policy, t.requested_argv.as_deref(), t.ack_unverified)?;
        self.mutate(|st| {
            st.task_mut(id)?.policy = Some(record);
            Ok(())
        })?;
        self.launched.lock().unwrap().push(id.to_string());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::host::RecordingHost;
    use super::super::{Orch, Status};
    use super::*;
    use crate::orch::boot_tests;
    use crate::orch::state::NewTask;
    use crate::store::{EventQuery, CORE_CLIENT_ID};
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
            let mut st = core.lock_unpersisted();
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
        e.core.lock_unpersisted().close(&e.root, Status::Exited, "se cerró").unwrap();
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
    fn aprobacion_desde_ui_persiste_client_id_en_task_created_y_spawn_resolved() {
        let (cleanup, data, core_dir) = boot_tests::dirs();
        let e = setup("identity-events");
        boot_tests::escribe_state_de(&e.core, &data);
        e.core.init_in(e.host.clone(), &data, &core_dir).unwrap();

        let parent = e.core.lock().task(&e.root).unwrap().clone();
        let mut pending = e.core.new_pending(
            &parent,
            NewPending {
                provider: "claude".into(),
                profile: "delegar_con_revision".into(),
                role: None,
                model: None,
                effort: None,
                title: "identity child".into(),
                spec: "verify authenticated event context".into(),
                shared: true,
                base: None,
            },
        );
        pending.policy = fake("claude", "delegar_con_revision", None, &parent.cwd);
        pending.created_at = state::now_ms();
        pending.expires_at = pending.created_at + DEFAULT_TTL_SECS * 1000;
        let pending_id = pending.pending_id.clone();
        let argv = pending.policy.argv.clone();
        e.core.pend().insert(
            pending_id.clone(),
            Entry {
                p: pending,
                state: PendState::Pending,
                decision: None,
                resolved_at: None,
            },
        );
        let head_before = e
            .core
            .storage
            .with_store(|store| store.events_head().unwrap())
            .unwrap();

        let result = e.core.approve_spawn(&pending_id, true, &argv, true).unwrap();
        assert_eq!(result["outcome"], "approved");

        let events = e
            .core
            .storage
            .with_store(|store| {
                store
                    .events_page(&EventQuery {
                        after: Some(head_before),
                        limit: Some(100),
                        ..Default::default()
                    })
                    .unwrap()
                    .events
            })
            .unwrap();
        let created = events
            .iter()
            .find(|event| event.kind == "task.created" && event.correlation_id.as_deref() == Some(&pending_id))
            .expect("la hija aprobada emite task.created correlacionado");
        let resolved = events
            .iter()
            .find(|event| event.kind == "spawn.resolved")
            .expect("la aprobación emite spawn.resolved");
        let client_id = created.client_id.as_deref().expect("task.created conserva client_id autenticado");
        assert_ne!(client_id, CORE_CLIENT_ID);
        for event in [created, resolved] {
            assert_eq!(event.client_id.as_deref(), Some(client_id));
            assert_eq!(event.actor_kind.as_str(), "person");
            assert_eq!(event.actor_id.as_deref(), Some("user"));
            assert_eq!(event.channel.as_deref(), Some("ui"));
        }

        drop(e);
        boot_tests::espera_lock_libre(&core_dir);
        drop(cleanup);
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
