//! Mutadores semánticos de [`Tx`] (slice E, etapa E1b): la frontera donde un cambio del estado se
//! convierte en hechos del Event Log.
//!
//! Cada método tiene el MISMO nombre y firma que el de [`State`] y delega en él: como `Tx` hace
//! `Deref<Target = State>`, el método propio de `Tx` gana a la auto-deref y los call sites no cambian
//! (`tx.done(..)`, `tx.close(..)`…). `State` sigue siendo un modelo de dominio puro, sin conocer
//! eventos.
//!
//! # Reglas
//! * **Un hecho, un evento.** El evento nace aquí, donde se confirma semánticamente el hecho; ninguna
//!   capa superior (rpc, spawn, delivery…) vuelve a emitirlo. Las pruebas de `tx_ops_tests.rs` fijan
//!   los eventos exactos de cada mutador y una de arquitectura vigila quién puede emitir.
//! * **Solo si el mutador de `State` tuvo éxito.** Un `Err` no deja eventos (el candidato se
//!   descarta de todos modos).
//! * **`task.status_changed` solo ante un cambio real**: se compara el estado de las tareas del run
//!   antes y después y se emite exactamente una transición por tarea cuyo estado difiere (`from != to`).
//!   Un mutador que no cambia el estado (`close` de una tarea ya final, `mark_running` de una que ya
//!   corre) no emite nada.
//! * **Orden**: primero el hecho de contenido (`task.phase`, `task.question`, `task.reply`) y después
//!   las transiciones de estado que provocó; en `close_run`, las transiciones y al final `run.closed`.
//! * Los internos (`post`, `touch`, `mark_read`…) NO emiten: son consecuencias, no hechos.
//! * **Runtime sobre las tablas (LXO-233, ADR D9):** con esa persistencia, los cambios de estado de ejecución se emiten
//!   como `attempt.*` del Attempt actual (`attempt.requested` al nacer una Task o un seguimiento) y **no** como
//!   `task.status_changed`. Los hechos de la Task (`task.created`, `task.phase`, `task.question`, `task.removed`…) no
//!   cambian. Un mismo hecho nunca aparece en los dos modelos.

use std::collections::BTreeMap;

use super::agents::{self, EnvBlock};
use super::event_kinds as ev;
pub(super) use super::event_kinds::SpawnOutcome;
use super::events::{Actor, Channel, EventDraft, MutationContext};
use super::mutation::{Effect, Tx};
use super::spawn_approval::PendingSpawn;
use super::state::{NewTask, State, Status};
use crate::store::{ForkStrategy, RetryOverride};

/// Reconstruye el hecho tipado de un registro del journal sin ejecutar su efecto externo. La hora del
/// registro (`at`) se conserva: es cuándo ocurrió el efecto, no cuándo se reconcilió.
pub(super) fn recovered_effect(
    record: &super::effect_journal::RecordV2,
) -> Option<(MutationContext, EventDraft, i64)> {
    if record.v != 2 || record.at <= 0 || !super::effect_journal::valid_effect_id(&record.effect_id) {
        return None;
    }
    let (Some(task), Some(run)) = (record.task.as_deref(), record.run.as_deref()) else {
        return None;
    };
    if task.is_empty() || run.is_empty() || record.project.as_deref() == Some("") {
        return None;
    }
    let actor = match (record.actor_kind.as_str(), record.actor_id.as_deref()) {
        ("person", None) => Actor::Person,
        ("person", Some(id)) if !id.is_empty() => Actor::PersonId(id.to_string()),
        ("agent", Some(task)) if !task.is_empty() => Actor::Agent(task.to_string()),
        ("system", None) => Actor::System,
        _ => return None,
    };
    let channel = match record.channel.as_str() {
        "ui" => Channel::Ui,
        "lxo" => Channel::Lxo,
        "core" => Channel::Core,
        _ => return None,
    };
    let facts = ev::EffectObserved::parse(&record.effect_id, &record.operation, &record.kind, &record.observed).ok()?;
    let draft = ev::effect_observed(task, run, record.project.clone(), &facts, &record.effect_id).ok()?;
    Some((MutationContext {
        actor,
        channel,
        client_id: record.client_id.clone(),
    }, draft, record.at))
}

pub(super) fn effect_observed_is_valid(
    effect_id: &str,
    operation: &str,
    kind: &str,
    observed: &serde_json::Value,
) -> bool {
    ev::EffectObserved::parse(effect_id, operation, kind, observed).is_ok()
}

/// Estado de las tareas de un run (o de todos) antes de un mutador: `tarea -> (estado, run)`.
type Snapshot = BTreeMap<String, (Status, String)>;

#[cfg_attr(not(test), allow(dead_code))] // sin consumidor hasta el RPC del primer Attempt (LXO-141, fase 2c)
fn current_attempt_task(tx: &Tx, attempt_id: &str) -> Result<String, String> {
    let (task_id, n) = match attempt_id.rsplit_once("-a") {
        Some((task_id, raw_n)) => {
            let n = raw_n
                .parse::<u32>()
                .ok()
                .filter(|n| *n > 0 && format!("{task_id}-a{n}") == attempt_id)
                .ok_or_else(|| format!("id de Attempt inválido: {attempt_id}"))?;
            (task_id, n)
        }
        // The old in-module transaction helpers accepted a Task id. Keep that
        // narrow compatibility for existing Core lifecycle callers; RPC always
        // supplies and validates the full Attempt id.
        None => (
            attempt_id,
            *tx.attempt_n
                .get(attempt_id)
                .ok_or_else(|| format!("la Task {attempt_id} no tiene Attempt actual"))?,
        ),
    };
    if task_id.is_empty()
        || tx.attempt_n.get(task_id) != Some(&n)
        || !tx.tasks.contains_key(task_id)
    {
        return Err(format!("el Attempt {attempt_id} ya no es el actual de su Task"));
    }
    Ok(task_id.to_owned())
}

/// Lo que una petición de reintento cambia a propósito respecto del Attempt anterior (`None`: se hereda).
#[derive(Clone, Debug, Default)]
pub(super) struct RetrySelection {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub profile: Option<String>,
}

/// Lo que `attempt.fork` le pide a la mutación (LXO-145). Todo viene ya validado y resuelto por `fork_runtime`: aquí solo se escribe.
pub(super) struct ForkRequest {
    pub source_attempt: String,
    pub source_task: String,
    pub source_n: u32,
    pub project_id: String,
    pub objective: String,
    pub title: String,
    pub spec: String,
    pub repo: String,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub role: Option<String>,
    pub profile: String,
    pub strategy: ForkStrategy,
    pub package_id: Option<String>,
    pub overrides: Vec<RetryOverride>,
    /// Si nace de un Race (LXO-215): su id y el índice del candidato. Va en `attempt.forked`.
    pub race: Option<(String, u32)>,
}

/// Lo que se adopta: un worktree externo, ya verificado por quien llama (existe, es del Project, está limpio, tiene rama).
pub(super) struct AdoptRequest {
    pub worktree: String,
    pub branch: String,
    pub base: String,
    pub base_commit: Option<String>,
    pub summary: String,
}

impl Tx {
    /// Adopta un worktree externo como el primer Attempt, ya TERMINADO, de una Task sin ninguna ejecución (`not_started`) (LXO-149). Es una decisión de
    /// una Person autenticada. La Task recibe el worktree y su rama (que ya no cambian: el proyector solo admite el alta), y nace su Attempt con proveedor
    /// `external`, sin `attempt.started` ni `attempt.completed`: no hubo ejecución de Lixbon. Devuelve el id del Attempt.
    pub(super) fn adopt_worktree(&mut self, task_id: &str, req: &AdoptRequest) -> Result<String, String> {
        if !self.attempt_model() {
            return Err("core_model_inactive: el runtime de Attempts no está activo".into());
        }
        if !self.is_authenticated_person() {
            return Err("adoptar un worktree requiere una Person autenticada".into());
        }
        let task = self.tasks.get(task_id).cloned().ok_or_else(|| format!("adopt_task_not_found: no existe la Task {task_id}"))?;
        if task.status != Status::NotStarted || self.attempt_n.contains_key(task_id) {
            return Err("adopt_task_not_eligible: solo se adopta en una Task sin ninguna ejecución (not_started)".into());
        }
        if task.worktree.is_some() || task.branch.is_some() {
            return Err("adopt_task_not_eligible: la Task ya tiene un worktree".into());
        }
        {
            let row = self.tasks.get_mut(task_id).ok_or("No se pudo adoptar")?;
            row.agent = "external".into();
            row.cwd = req.worktree.clone();
            row.worktree = Some(req.worktree.clone());
            row.branch = Some(req.branch.clone());
            row.base = Some(req.base.clone());
            row.base_commit = req.base_commit.clone();
            row.summary = req.summary.clone();
            row.adopted = true;
        }
        self.state_mut().attempt_n.insert(task_id.to_owned(), 1);
        self.state_mut().touch(task_id, Some(Status::Done))?;
        let adopted = self.tasks.get(task_id).cloned().map(|t| ev::runtime_attempt_adopted(&t, &req.branch, &req.base));
        if let Some(adopted) = adopted {
            self.try_push_event(adopted);
        }
        Ok(format!("{task_id}-a1"))
    }

    /// Fork (LXO-145): una Task NUEVA con su primer Attempt, que nace de otro Attempt sin tocarlo. Es el camino de `task.create` con un
    /// Attempt (nace `pending_approval`: ninguna selección exime de la decisión humana) más `attempt.forked` con la procedencia.
    /// Devuelve los ids de lo que nació. La Task tiene su Run, su rama y su worktree propios: la fuente no cambia.
    pub(super) fn request_attempt_fork(&mut self, req: &ForkRequest) -> Result<crate::store::RuntimeResultIds, String> {
        if !self.is_authenticated_person() {
            return Err("hacer un Fork requiere una Person autenticada".into());
        }
        if !self.attempt_model() {
            return Err("El runtime de Attempts no está activo".into());
        }
        if !self.tasks.contains_key(&req.source_task) {
            return Err(format!("no existe la Task {}", req.source_task));
        }
        let root = NewTask {
            agent: req.provider.clone(),
            model: req.model.clone(),
            effort: req.effort.clone(),
            role: req.role.clone(),
            title: req.title.clone(),
            spec: req.spec.clone(),
            repo: req.repo.clone(),
            cwd: req.repo.clone(),
            branch: None,
            base: None,
            worktree: None,
            external: false,
        };
        let (run, task) = self.create_run_intent(&req.objective, root);
        {
            let row = self.tasks.get_mut(&task).ok_or("No se pudo crear la Task")?;
            row.project_id = Some(req.project_id.clone());
            row.profile = Some(req.profile.clone());
            row.status = Status::PendingApproval;
        }
        self.request_initial_attempt(&task)?;
        let forked = self.tasks.get(&task).cloned().map(|t| ev::runtime_attempt_forked(&t, &req.source_attempt, &req.source_task, req.source_n, req.strategy, req.package_id.clone(), req.overrides.clone(), req.race.as_ref().map(|(id, i)| (id.as_str(), *i))));
        if let Some(forked) = forked {
            self.try_push_event(forked);
        }
        let attempt_id = format!("{task}-a1");
        Ok(crate::store::RuntimeResultIds { run_id: run, task_id: task, attempt_id: Some(attempt_id) })
    }

    /// Expira una aprobación inicial identificada por el id durable del Attempt.
    /// El plazo solo lo sugiere el Store: `runtime_commit_recorded` lo revalida
    /// junto al estado pendiente y el evento antes de confirmar el cambio.
    pub(super) fn expire_pending_initial(&mut self, attempt_id: &str) -> Result<bool, String> {
        let context = self.context();
        if context.actor != Actor::System || context.channel != Channel::Core {
            return Err("expirar una aprobación inicial requiere System/Core".into());
        }

        let Some((task_id, n)) = attempt_id
            .rsplit_once("-a")
            .and_then(|(task, n)| n.parse::<u32>().ok().map(|n| (task, n)))
            .filter(|(task, n)| !task.is_empty() && *n > 0 && format!("{task}-a{n}") == attempt_id)
        else {
            self.no_change();
            return Ok(false);
        };
        let Some(task) = self.tasks.get(task_id).cloned() else {
            self.no_change();
            return Ok(false);
        };
        if self.attempt_n.get(task_id) != Some(&n) || task.status != Status::PendingApproval {
            self.no_change();
            return Ok(false);
        }
        if super::state::now_ms() == 0 {
            self.no_change();
            return Ok(false);
        }

        // No usar `close`: una expiración no es una salida de un agente ni debe
        // crear el mensaje legacy de cierre a la tarea coordinadora.
        self.state_mut().touch(task_id, Some(Status::Stopped))?;
        self.try_push_event(ev::runtime_attempt_expired(&task, n));
        Ok(true)
    }

    /// Registra el primer Attempt solicitado durante task.create sin pasar por el runner.
    /// La política y el estado inicial los resuelve el servidor antes de entrar aquí;
    /// estado, contador, proyección y evento se conservan juntos en la mutación.
    #[cfg_attr(not(test), allow(dead_code))] // sin consumidor hasta el RPC del primer Attempt (LXO-141, fase 2c)
    pub(super) fn request_initial_attempt(&mut self, task_id: &str) -> Result<(), String> {
        if !self.attempt_model() {
            return Err("El runtime de Attempts no está activo".into());
        }
        let task = self
            .tasks
            .get(task_id)
            .cloned()
            .ok_or("No se pudo crear la Task")?;
        if self.attempt_n.contains_key(task_id) {
            return Err("La Task ya tiene un Attempt".into());
        }
        if !matches!(task.status, Status::PendingApproval | Status::Starting) {
            return Err("El primer Attempt requiere estado inicial pending_approval o starting".into());
        }
        self.state_mut().attempt_n.insert(task_id.to_owned(), 1);
        self.try_push_event(ev::runtime_new_attempt(&task, 1));
        self.mark_attempt_request(task_id, 1);
        Ok(())
    }

    /// Approve the exact current pending Attempt. The Store validates its durable deadline
    /// again inside the transaction that persists this candidate and its event.
    #[cfg_attr(not(test), allow(dead_code))] // sin consumidor hasta el RPC del primer Attempt (LXO-141, fase 2c)
    pub(super) fn approve_attempt(&mut self, attempt_id: &str) -> Result<(), String> {
        if !self.is_authenticated_person() {
            return Err("aprobar un Attempt requiere una Person autenticada".into());
        }
        let task_id = current_attempt_task(self, attempt_id)?;
        if self.tasks.get(&task_id).is_none_or(|t| t.status != Status::PendingApproval) {
            return Err("Attempt no pendiente de aprobación".into());
        }
        let before = self.snapshot_run_of(&task_id);
        self.state_mut().touch(&task_id, Some(Status::Starting))?;
        self.push_status_changes(before, None);
        Ok(())
    }

    /// Reject the exact current pending Attempt; the lifecycle event is `attempt.rejected`.
    #[cfg_attr(not(test), allow(dead_code))] // sin consumidor hasta el RPC del primer Attempt (LXO-141, fase 2c)
    pub(super) fn reject_attempt(&mut self, attempt_id: &str) -> Result<(), String> {
        if !self.is_authenticated_person() {
            return Err("rechazar un Attempt requiere una Person autenticada".into());
        }
        let task_id = current_attempt_task(self, attempt_id)?;
        if self.tasks.get(&task_id).is_none_or(|t| t.status != Status::PendingApproval) {
            return Err("Attempt no pendiente de aprobación".into());
        }
        let before = self.snapshot_run_of(&task_id);
        self.state_mut().touch(&task_id, Some(Status::Stopped))?;
        self.push_status_changes(before, None);
        Ok(())
    }

    /// Pide un Attempt LIMPIO para una Task cuyo último Attempt terminó mal (`failed`, `stopped` o `exited`): la Task vuelve
    /// a `starting` y, como en cualquier paso de un final a un activo, nace el Attempt `n + 1` (`attempt.requested`) con la
    /// selección de ejecución que se pida. Nada se reabre: el Attempt anterior sigue siendo final y no se toca.
    ///
    /// Es el puente entre la petición de la persona y el despachador: el Attempt nuevo queda `starting` con el claim
    /// `none`, y lo lanza el mismo camino que al primero (reserva del claim, worktree, `attempt.started`, adapter). A
    /// diferencia del primero, no pide aprobación: la decisión de la persona es la propia petición de reintentar.
    ///
    /// Heredado del Attempt anterior salvo lo que se pida: el modelo y el esfuerzo solo dentro del mismo proveedor (son
    /// del proveedor), el rol y el perfil siempre. Sin consumidor hasta el RPC de reintento.
    #[cfg_attr(not(test), allow(dead_code))] // sin consumidor hasta el RPC `attempt_retry`
    pub(super) fn request_attempt_retry(&mut self, task_id: &str, selection: &RetrySelection) -> Result<(), String> {
        if !self.is_authenticated_person() {
            return Err("reintentar un Attempt requiere una Person autenticada".into());
        }
        if !self.attempt_model() {
            return Err("El runtime de Attempts no está activo".into());
        }
        let task = self.tasks.get(task_id).cloned().ok_or_else(|| format!("No existe la Task {task_id}"))?;
        if !self.attempt_n.contains_key(task_id) {
            return Err("la Task no tiene ningún Attempt que reintentar".into());
        }
        if !matches!(task.status, Status::Failed | Status::Stopped | Status::Exited) {
            return Err("solo se reintenta un Attempt que terminó mal (failed, stopped o exited)".into());
        }
        let provider = selection.provider.clone().unwrap_or_else(|| task.agent.clone());
        let same_provider = provider == task.agent;
        let profile = selection.profile.clone().or_else(|| task.profile.clone());
        if profile.as_deref().is_none_or(|p| p.trim().is_empty()) {
            return Err("ni la petición ni el Attempt anterior tienen un perfil de permisos".into());
        }
        let before = self.snapshot_run_of(task_id);
        // Qué se pidió distinto del Attempt anterior (pedir lo mismo no es cambiar): es lo que dice `attempt.retried`.
        let model = selection.model.clone().or_else(|| if same_provider { task.model.clone() } else { None });
        let effort = selection.effort.clone().or_else(|| if same_provider { task.effort.clone() } else { None });
        let mut overrides = Vec::new();
        if !same_provider {
            overrides.push(RetryOverride::Provider);
        }
        if selection.model.is_some() && model != task.model {
            overrides.push(RetryOverride::Model);
        }
        if selection.effort.is_some() && effort != task.effort {
            overrides.push(RetryOverride::Effort);
        }
        if selection.profile.is_some() && profile != task.profile {
            overrides.push(RetryOverride::Profile);
        }
        {
            let t = self.state_mut().task_mut(task_id)?;
            t.model = model;
            t.effort = effort;
            t.agent = provider;
            t.profile = profile;
            // Lo del Attempt anterior no se arrastra al nuevo (como en `State::reopen`).
            t.summary.clear();
            t.report = None;
            t.delivery_channel = None;
            t.failure_reason = None;
            t.session_ref = None;
            t.model_source = None;
            t.session_match = None;
            t.approval_deadline = None;
            t.merged = false;
            t.status = Status::Starting;
            t.updated = super::state::now_ms();
        }
        self.push_status_changes(before, None);
        // La procedencia va en la MISMA mutación que el Attempt nuevo: o están los dos o ninguno. Resuelve el `failed` del anterior.
        let n = self.attempt_n.get(task_id).copied().unwrap_or(1);
        let retried = self.tasks.get(task_id).cloned().map(|t| ev::runtime_attempt_retried(&t, n, overrides));
        if let Some(retried) = retried {
            self.try_push_event(retried);
        }
        Ok(())
    }

    /// Pide un Attempt que CONTINÚA la ProviderSession del anterior (reanudación nativa): la Task vuelve a `starting` y nace el
    /// Attempt `n + 1` con `attempt.continued`. Como `request_attempt_retry` es el puente al despachador (el Attempt nuevo queda
    /// `starting` con el claim `none` y lo lanza el despachador), pero aquí la sesión **se conserva**: el proyector enlaza el Attempt
    /// nuevo a la ProviderSession de la Task y el lanzador reanuda en vez de arrancar.
    ///
    /// Se continúa un Attempt terminado de cualquier manera (también `done`: es un seguimiento) y siempre en el mismo proveedor:
    /// una sesión no se comparte entre proveedores. El mensaje se añade al `spec` como bloque «Seguimiento» (la convención de
    /// `lxo continue`), y ese bloque es el mensaje con que continúa la sesión. Sin consumidor hasta el RPC `attempt_resume`.
    #[cfg_attr(not(test), allow(dead_code))] // sin consumidor hasta el RPC `attempt_resume`
    pub(super) fn request_attempt_continuation(&mut self, task_id: &str, prompt: &str, selection: &RetrySelection) -> Result<(), String> {
        if !self.is_authenticated_person() {
            return Err("continuar un Attempt requiere una Person autenticada".into());
        }
        if !self.attempt_model() {
            return Err("El runtime de Attempts no está activo".into());
        }
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err("falta el mensaje con que continúa la sesión".into());
        }
        let task = self.tasks.get(task_id).cloned().ok_or_else(|| format!("No existe la Task {task_id}"))?;
        if !self.attempt_n.contains_key(task_id) {
            return Err("la Task no tiene ningún Attempt que continuar".into());
        }
        if !task.status.is_final() {
            return Err("solo se continúa un Attempt terminado".into());
        }
        if task.session_ref.as_deref().is_none_or(|r| r.trim().is_empty()) {
            return Err("el Attempt anterior no tuvo una sesión del proveedor que reanudar".into());
        }
        if selection.provider.as_deref().is_some_and(|p| p != task.agent) {
            return Err("continuar una sesión no cambia de proveedor: una ProviderSession no se comparte entre proveedores".into());
        }
        let before = self.snapshot_run_of(task_id);
        {
            let t = self.state_mut().task_mut(task_id)?;
            t.model = selection.model.clone().or_else(|| t.model.clone());
            t.effort = selection.effort.clone().or_else(|| t.effort.clone());
            t.spec = format!("{}{}{prompt}", t.spec, super::dispatch::FOLLOW_UP_MARKER);
            // Lo del Attempt anterior no se arrastra al nuevo, SALVO la sesión: es lo que se reanuda.
            t.summary.clear();
            t.report = None;
            t.delivery_channel = None;
            t.failure_reason = None;
            t.approval_deadline = None;
            t.merged = false;
            t.status = Status::Starting;
            t.updated = super::state::now_ms();
        }
        self.push_status_changes(before, None);
        let n = self.attempt_n.get(task_id).copied().unwrap_or(1);
        let continued = self.tasks.get(task_id).cloned().map(|t| ev::runtime_native_continuation(&t, n));
        if let Some(continued) = continued {
            self.try_push_event(continued);
        }
        Ok(())
    }

    fn state_mut(&mut self) -> &mut State {
        &mut *self
    }

    fn run_of(&self, task: &str) -> String {
        self.tasks.get(task).map(|t| t.run.clone()).unwrap_or_default()
    }

    /// Estados de todas las tareas del run al que pertenece `task` (vacío si no existe).
    fn snapshot_run_of(&self, task: &str) -> Snapshot {
        match self.tasks.get(task) {
            Some(t) => self.snapshot_run(&t.run.clone()),
            None => Snapshot::new(),
        }
    }

    fn snapshot_run(&self, run: &str) -> Snapshot {
        self.tasks.values().filter(|t| t.run == run).map(|t| (t.id.clone(), (t.status, t.run.clone()))).collect()
    }

    fn snapshot_all(&self) -> Snapshot {
        self.tasks.values().map(|t| (t.id.clone(), (t.status, t.run.clone()))).collect()
    }

    /// Emite UN `task.status_changed` por cada tarea cuyo estado difiere del de `before` o, con el runtime sobre las
    /// tablas, los `attempt.*` de esa transición ([`Tx::push_attempt_changes`]).
    fn push_status_changes(&mut self, before: Snapshot, cause: Option<&str>) {
        let changes: Vec<_> = before
            .into_iter()
            .filter_map(|(id, (from, run))| {
                let now = self.tasks.get(&id)?.status;
                (now != from).then_some((id, run, from, now))
            })
            .collect();
        for (id, run, from, to) in changes {
            if self.attempt_model() {
                self.push_attempt_changes(&id, from, to, cause);
            } else {
                self.try_push_event(ev::task_status_changed(&id, &run, from, to, cause.map(String::from)));
            }
        }
    }

    /// Los hechos de ejecución de una transición, sobre el Attempt actual. De un final a uno activo es un seguimiento:
    /// nace el Attempt `n + 1` (`attempt.requested`) y arranca desde `starting`, como en las tablas.
    fn push_attempt_changes(&mut self, id: &str, from: Status, to: Status, cause: Option<&str>) {
        let Some(t) = self.tasks.get(id).cloned() else { return };
        let mut n = self.attempt_n.get(id).copied().unwrap_or(1);
        let mut from = from;
        if from.is_final() && !to.is_final() {
            n += 1;
            self.state_mut().attempt_n.insert(id.to_string(), n);
            self.try_push_event(ev::runtime_new_attempt(&t, n));
            self.mark_attempt_request(id, n);
            from = Status::Starting;
        }
        for draft in ev::runtime_attempt_transition(&t, n, from, to, cause) {
            self.try_push_event(draft);
        }
    }

    /// Rehace cada `attempt.requested` de esta mutación con la Task tal como quedó: su selección (el perfil que
    /// `create_child` fija después de crearla) es la de la fila del Attempt. Lo llama la frontera al finalizar.
    pub(super) fn refresh_attempt_requests(&mut self) {
        for (idx, task, n) in self.take_attempt_requests() {
            if let Some(t) = self.tasks.get(&task).cloned() {
                self.replace_draft(idx, ev::runtime_new_attempt(&t, n));
            }
        }
    }

    /// Con el runtime sobre las tablas, una Task nueva nace con su Attempt 1 (`attempt.requested`).
    fn push_attempt_created(&mut self, id: &str) {
        if !self.attempt_model() {
            return;
        }
        let Some(t) = self.tasks.get(id).cloned() else { return };
        self.state_mut().attempt_n.insert(id.to_string(), 1);
        self.try_push_event(ev::runtime_new_attempt(&t, 1));
        self.mark_attempt_request(id, 1);
    }

    /// Con el runtime sobre las tablas, retirar una Task para su Attempt activo (`attempt.stopped`): es lo que queda en
    /// las tablas (D24). Devuelve el Attempt actual, que `task.removed` lleva para cerrar su Attention.
    fn push_attempt_retired(&mut self, id: &str) -> Option<u32> {
        if !self.attempt_model() {
            return None;
        }
        let t = self.tasks.get(id).cloned()?;
        let n = self.attempt_n.get(id).copied().unwrap_or(1);
        if !t.status.is_final() {
            for draft in ev::runtime_attempt_transition(&t, n, t.status, Status::Stopped, None) {
                self.try_push_event(draft);
            }
        }
        self.state_mut().attempt_n.remove(id);
        Some(n)
    }

    // -----------------------------------------------------------------------------------------
    // Runs y tareas
    // -----------------------------------------------------------------------------------------

    /// `run.created` + `task.created` (de la tarea raíz): la existencia del run y la de su raíz son
    /// hechos distintos. El `project_id` se resuelve AL FINALIZAR desde la raíz (el llamador lo
    /// completa después de crear el run).
    pub(super) fn create_run(&mut self, objective: &str, root: NewTask) -> (String, String) {
        let (run, task) = self.state_mut().create_run(objective, root);
        self.try_push_event(ev::run_created(&run, &task));
        if let Some(t) = self.tasks.get(&task).cloned() {
            self.try_push_event(ev::task_created(&t));
        }
        self.push_attempt_created(&task);
        (run, task)
    }

    /// Crea solo la intención durable y emite `task.created` v2. A diferencia de `create_run`, no
    /// solicita Attempt ni produce `attempt.requested`; las demás rutas legacy conservan v1.
    pub(super) fn create_run_intent(&mut self, objective: &str, root: NewTask) -> (String, String) {
        let (run, task) = self.state_mut().create_run(objective, root);
        if let Some(t) = self.tasks.get_mut(&task) {
            t.status = Status::NotStarted;
        }
        self.try_push_event(ev::run_created(&run, &task));
        if let Some(t) = self.tasks.get(&task).cloned() {
            self.try_push_event(ev::task_intent_created_from_state(&t));
        }
        (run, task)
    }

    /// `task.created`. Las hijas producen únicamente éste. En producción las hijas nacen de una solicitud de
    /// lanzamiento ([`Tx::add_child_for_spawn`]); ésta sin correlación queda para el modelo y las pruebas.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn add_child(&mut self, parent: &str, max_depth: u32, t: NewTask) -> Result<String, String> {
        let id = self.state_mut().add_child(parent, max_depth, t)?;
        if let Some(t) = self.tasks.get(&id).cloned() {
            self.try_push_event(ev::task_created(&t));
        }
        self.push_attempt_created(&id);
        Ok(id)
    }

    /// `task.created` de la hija de una solicitud de lanzamiento: lleva `correlation_id = pending_id`. Es la
    /// ÚNICA entrada que correlaciona un evento de Task con un `pending_id`, y solo este `task.created`: ni
    /// `task.status_changed`, ni `effect.observed` (que conserva su `effect_id`), ni `task.removed` heredan la
    /// correlación, y `Tx` no guarda ningún «correlation actual».
    pub(super) fn add_child_for_spawn(&mut self, parent: &str, max_depth: u32, t: NewTask, pending_id: &str) -> Result<String, String> {
        let id = self.state_mut().add_child(parent, max_depth, t)?;
        if let Some(t) = self.tasks.get(&id).cloned() {
            self.try_push_event(ev::task_created(&t).map(|d| d.correlated(pending_id)));
        }
        self.push_attempt_created(&id);
        Ok(id)
    }

    pub(super) fn mark_running(&mut self, id: &str) -> Result<(), String> {
        let before = self.snapshot_run_of(id);
        self.state_mut().mark_running(id)?;
        self.push_status_changes(before, None);
        Ok(())
    }

    /// `task.phase` y, solo si el estado cambió de verdad (p. ej. estaba en espera), `task.status_changed`.
    pub(super) fn phase(&mut self, id: &str, name: &str, done: bool, note: &str) -> Result<Option<u64>, String> {
        let before = self.snapshot_run_of(id);
        let msg = self.state_mut().phase(id, name, done, note)?;
        let run = self.run_of(id);
        self.try_push_event(ev::task_phase(id, &run, name, done));
        self.push_status_changes(before, Some("phase"));
        Ok(msg)
    }

    /// La entrega de una hija. Una entrega CORRECTA de una Task con padre y rama propia (`State.branch`) pide la
    /// revisión de la persona: además de `task.status_changed`, emite `task.review_requested` (fuente de
    /// `review_ready`). Una entrega fallida, la de una raíz o la de una hija sin rama (`shared`) no.
    pub(super) fn done(&mut self, id: &str, ok: bool, summary: &str, files: Vec<String>, report: Option<String>) -> Result<Option<u64>, String> {
        let before = self.snapshot_run_of(id);
        let msg = self.state_mut().done(id, ok, summary, files, report)?;
        self.push_status_changes(before, None);
        // Solo una entrega correcta deja la Task en `Done` (`ok = false` la deja en `Failed`): ese estado es la guarda.
        let pedida = self.tasks.get(id).filter(|t| t.status == Status::Done && t.parent.is_some()).and_then(|t| Some((t.run.clone(), t.branch.clone()?)));
        if let Some((run, branch)) = pedida {
            self.try_push_event(ev::task_review_requested(id, &run, &branch));
        }
        Ok(msg)
    }

    /// El host comprobó que el ENTORNO impide trabajar con `provider` en el perfil `profile` (`code`: el enum tipado
    /// `agents::EnvBlock`; no hay cadenas libres). Emite solo si esa causa NO estaba ya activa en ese alcance (`false` =
    /// ya lo estaba). La causa se SUMA a las que haya: una causa nueva no demuestra que otra haya terminado, así que
    /// nunca emite `environment.cleared` (eso solo lo hace [`Tx::environment_verified`] con prueba positiva). No toca el
    /// estado de ninguna Task.
    pub(super) fn environment_blocked(&mut self, provider: &str, profile: &str, code: EnvBlock) -> bool {
        if !self.state_mut().set_env_block(provider, profile, code) {
            return false;
        }
        self.try_push_event(ev::environment_blocked(provider, profile, code));
        true
    }

    /// El host obtuvo una comprobación POSITIVA de `provider` en el perfil `profile` (`proof`: evidencia tipada de
    /// entorno, no el `status` de la policy): emite `environment.cleared` solo por cada causa que esa evidencia
    /// DEMUESTRA terminada (las de ese alcance que desmiente y los `CliMissing` del proveedor). `false` = no había nada que levantar.
    /// Lo no demostrado (versión o modelo sin fijar no cuentan; ayuda ilegible, `Skip`, ambigüedad) conserva el bloqueo.
    pub(super) fn environment_verified(&mut self, provider: &str, profile: &str, proof: agents::EnvProof) -> bool {
        let levantados = self.state_mut().verify_env(provider, profile, proof);
        for (perfil, causa) in &levantados {
            self.try_push_event(ev::environment_cleared(provider, perfil, *causa));
        }
        !levantados.is_empty()
    }

    /// `task.question` (solo el id del mensaje: el cuerpo se queda en `messages`) y `task.status_changed`
    /// a `waiting` si cambió.
    pub(super) fn ask(&mut self, id: &str, question: &str) -> Result<u64, String> {
        let before = self.snapshot_run_of(id);
        let message = self.state_mut().ask(id, question)?;
        let (run, to) = (self.run_of(id), self.messages.iter().find(|m| m.id == message).map(|m| m.to.clone()).unwrap_or_default());
        self.try_push_event(ev::task_question(id, &run, message, &to));
        self.push_status_changes(before, Some("question"));
        Ok(message)
    }

    /// `task.reply` (entidad: la tarea que preguntó; actor: quien responde) y `task.status_changed`
    /// de la que preguntó si volvió a correr.
    pub(super) fn reply(&mut self, from: &str, question: u64, answer: &str) -> Result<u64, String> {
        let asker = self.messages.iter().find(|m| m.id == question).map(|m| m.from.clone()).unwrap_or_default();
        let before = self.snapshot_run_of(&asker);
        let message = self.state_mut().reply(from, question, answer)?;
        let run = self.run_of(&asker);
        self.try_push_event(ev::task_reply(&asker, &run, question, message));
        self.push_status_changes(before, Some("answered"));
        Ok(message)
    }

    pub(super) fn reopen(&mut self, id: &str, spec: &str) -> Result<(), String> {
        let before = self.snapshot_run_of(id);
        self.state_mut().reopen(id, spec)?;
        self.push_status_changes(before, Some("reopened"));
        Ok(())
    }

    pub(super) fn close(&mut self, id: &str, status: Status, why: &str) -> Result<Option<u64>, String> {
        let before = self.snapshot_run_of(id);
        let msg = self.state_mut().close(id, status, why)?;
        self.push_status_changes(before, None);
        Ok(msg)
    }

    pub(super) fn await_terminal_approval(&mut self, id: &str, deadline: u64) -> Result<bool, String> {
        let before = self.snapshot_run_of(id);
        let changed = self.state_mut().await_terminal_approval(id, deadline)?;
        self.push_status_changes(before, Some("terminal_approval"));
        Ok(changed)
    }

    pub(super) fn resume_from_approval(&mut self, id: &str) -> Result<bool, String> {
        let before = self.snapshot_run_of(id);
        let changed = self.state_mut().resume_from_approval(id)?;
        self.push_status_changes(before, Some("terminal_approval"));
        Ok(changed)
    }

    /// La causa es el motivo máquina del fallo (`terminal_approval_timeout`, `agent_idle_timeout`…).
    pub(super) fn fail_with(&mut self, id: &str, reason: &str, why: &str) -> Result<Option<u64>, String> {
        let before = self.snapshot_run_of(id);
        let msg = self.state_mut().fail_with(id, reason, why)?;
        self.push_status_changes(before, Some(reason));
        Ok(msg)
    }

    /// Cierra las tareas abiertas que quedaron de una sesión anterior: un `task.status_changed` por tarea.
    pub(super) fn orphan_all(&mut self) {
        let before = self.snapshot_all();
        self.state_mut().orphan_all();
        self.push_status_changes(before, Some("orphaned"));
    }

    /// Transiciones de las tareas del run (`cause = run_closed`) y, al final, `run.closed`.
    pub(super) fn close_run(&mut self, run: &str, force: bool) -> Result<(Vec<String>, Vec<u64>), String> {
        let before = self.snapshot_run(run);
        let (open, msgs) = self.state_mut().close_run(run, force)?;
        self.push_status_changes(before, Some("run_closed"));
        let root = self.runs.get(run).map(|r| r.root.clone()).unwrap_or_default();
        self.try_push_event(ev::run_closed(run, &root, force, &open));
        Ok((open, msgs))
    }

    /// `run.removed`. El proyecto se toma ANTES de borrar (al finalizar las tareas ya no existen).
    pub(super) fn remove_run(&mut self, run: &str) {
        let Some(r) = self.runs.get(run) else {
            self.state_mut().remove_run(run);
            return;
        };
        let project = self.tasks.get(&r.root).and_then(|t| t.project_id.clone());
        let ids: Vec<String> = self.tasks.values().filter(|t| t.run == run).map(|t| t.id.clone()).collect();
        let tasks = ids.len();
        for id in &ids {
            self.push_attempt_retired(id);
        }
        self.state_mut().remove_run(run);
        self.try_push_event(ev::run_removed(run, project, tasks));
    }

    // -----------------------------------------------------------------------------------------
    // Decisiones
    // -----------------------------------------------------------------------------------------

    /// Registra una decisión (fila legacy) y emite `decision.recorded`. ÚNICO sitio que construye ese
    /// evento. Orden: 1) valida la tarea, el actor y el contrato del `detail`; 2) `State::record_decision`;
    /// 3) con el id asignado, EXACTAMENTE un borrador. Solo review/merge/pr: `spawn` NO pasa por aquí (su
    /// única vía es [`Tx::record_spawn_resolution`]) y cualquier otro `kind` rechaza la mutación completa.
    ///
    /// Validación de actor: la fila legacy dice quién decide (`"human"`, `"system"` o una tarea) y el
    /// contexto de la mutación debe ser realmente ese actor. Además, review/merge/pr son decisiones de una
    /// PERSONA desde la interfaz (`Person / Ui`).
    pub(super) fn record_decision(&mut self, task: &str, kind: &str, actor: &str, detail: &serde_json::Value) -> Result<u64, String> {
        if !self.tasks.contains_key(task) {
            return Err(format!("decisión {kind}: la tarea {task} no existe"));
        }
        // El actor y el canal que se VALIDAN son los que quedan en el evento: se capturan ahora y se fijan
        // en el borrador. Los demás eventos usan el contexto vigente al finalizar (`run_create` lo cambia a
        // mitad de mutación a propósito); una decisión no: un `set_context` posterior no la reatribuye.
        let ctx = self.context().clone();
        self.check_decision_actor(kind, actor)?;
        let facts = ev::DecisionRecorded::parse(kind, detail)?;
        let id = self.state_mut().record_decision(task, kind, actor, detail);
        let run = self.run_of(task);
        // Dentro de `mutate_after_effect` la decisión se correlaciona con el efecto que la provocó.
        let efecto = self.active_effect().map(String::from);
        let draft = ev::decision_recorded(task, &run, &facts.with_id(id)).map(|d| d.by(ctx.actor, ctx.channel));
        self.try_push_event(draft.map(|d| match efecto {
            Some(e) => d.correlated(e),
            None => d,
        }));
        Ok(id)
    }

    /// Resuelve una solicitud de lanzamiento: la fila legacy `Decision(kind = "spawn")` (cuando corresponde) y
    /// EXACTAMENTE un `spawn.resolved`, en la MISMA mutación. ÚNICO mutador autorizado para una
    /// `Decision(spawn)`; ÚNICO sitio que construye `spawn.resolved` dentro de una mutación (el caso de la tarea
    /// padre ya desaparecida es [`spawn_resolution_fact`]).
    ///
    /// Invariante `pending_id → ≤ 1 Decision legacy spawn → ≤ 1 spawn.resolved`: si ya existe una fila `spawn`
    /// para ese `pending_id`, devuelve [`SpawnRecorded::Duplicate`] sin fila ni evento (el `DO NOTHING` de
    /// `(kind, idem_key)` solo protege al Event; la fila legacy se protege aquí).
    ///
    /// * `legacy = None` es `cancelled_run_removed` (el run y la tarea padre desaparecen en la misma mutación) y
    ///   solo ese outcome puede ir sin fila.
    /// * Actor validado: approved / rejected / launch_failed / cancelled_run_removed los toma una persona por la
    ///   interfaz (`person/ui`, fila `human`); timeout / coordinator_closed el Core (`system/core`, fila `system`).
    ///   El evento se atribuye a ese contexto, capturado ahora.
    pub(super) fn record_spawn_resolution(&mut self, r: &SpawnResolution<'_>) -> Result<SpawnRecorded, String> {
        let (run, project) = match self.tasks.get(r.parent_task) {
            Some(t) => (t.run.clone(), t.project_id.clone()),
            None => return Err(format!("spawn.resolved: la tarea padre {} no existe (usa spawn_resolution_fact)", r.parent_task)),
        };
        let ctx = self.context().clone();
        check_spawn_actor(r.outcome, &ctx)?;
        match r.legacy {
            None if r.outcome != ev::SpawnOutcome::CancelledRunRemoved => {
                return Err(format!("spawn.resolved: {:?} exige su fila Decision(spawn); solo cancelled_run_removed va sin ella", r.outcome))
            }
            Some(_) if r.outcome == ev::SpawnOutcome::CancelledRunRemoved => return Err("spawn.resolved: cancelled_run_removed no deja fila Decision(spawn)".into()),
            _ => {}
        }
        let mut decision = None;
        if let Some((actor, detail)) = r.legacy {
            let esperado = if r.outcome.decided_by_person() { "human" } else { "system" };
            if actor != esperado {
                return Err(format!("spawn.resolved: {:?} lo decide {esperado:?}, no {actor:?}", r.outcome));
            }
            if detail["pending_id"] != r.pending_id {
                return Err(format!("spawn.resolved: el detalle de la fila no corresponde al pending_id {}", r.pending_id));
            }
            if self.spawn_decision_exists(r.pending_id) {
                return Ok(SpawnRecorded::Duplicate);
            }
            decision = Some(self.state_mut().record_decision(r.parent_task, "spawn", actor, detail));
        }
        self.try_push_event(ev::spawn_resolved(r.pending_id, &run, project, r.outcome, r.task, r.has_reason).map(|d| d.by(ctx.actor, ctx.channel)));
        Ok(SpawnRecorded::Recorded(decision))
    }

    fn spawn_decision_exists(&self, pending_id: &str) -> bool {
        self.decisions.iter().any(|d| {
            d.kind == "spawn"
                && d.detail_json.as_deref().and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok()).is_some_and(|v| v["pending_id"] == pending_id)
        })
    }

    fn check_decision_actor(&self, kind: &str, actor: &str) -> Result<(), String> {
        let ctx = self.context();
        let coincide = match (actor, &ctx.actor) {
            ("human", Actor::Person) => ctx.is_person(),
            ("human", Actor::PersonId(_)) => ctx.is_person(),
            ("system", Actor::System) => true,
            (a, Actor::Agent(task)) => a != "human" && a != "system" && a == task,
            _ => false,
        };
        if !coincide {
            return Err(format!("decisión {kind}: la fila dice actor {actor:?} pero la mutación la hace {:?}", ctx.actor));
        }
        if matches!(kind, "review" | "merge" | "pr") && (actor != "human" || !ctx.is_person_ui()) {
            return Err(format!("decisión {kind}: solo la toma una persona desde la interfaz (llegó {:?} por {:?})", ctx.actor, ctx.channel));
        }
        Ok(())
    }

    // -----------------------------------------------------------------------------------------
    // Efectos externos
    // -----------------------------------------------------------------------------------------

    /// Registra que un efecto externo YA ocurrido fue observado: emite `effect.observed` (ÚNICO sitio que
    /// construye ese evento) con `effect_id` = payload = `correlation_id` = `idem_key`. Solo lo llama la
    /// frontera `mutate_after_effect`, ANTES de ejecutar el cierre de registro: por eso es el primer evento
    /// del lote. Captura el actor y el canal vigentes (un `set_context` posterior no reatribuye el efecto) y
    /// activa el `effect_id` para que las decisiones registradas dentro lo lleven como correlación. Los
    /// demás hechos de estado NO se correlacionan.
    ///
    /// Un `effect_kind`/`operation` desconocido, un detalle fuera de contrato o una tarea inexistente
    /// devuelven `Err`: el registro falla y, como el efecto ocurrió, el Core lo anota en el diario.
    pub(super) fn observe_effect(&mut self, effect: &Effect) -> Result<(), String> {
        let facts = ev::EffectObserved::parse(effect.effect_id(), effect.operation(), effect.kind(), effect.observed_value())?;
        let task = effect.task_id().ok_or_else(|| format!("effect.observed: el efecto {} no declara su tarea", effect.kind()))?;
        // Pertenencia histórica congelada AHORA: el cierre que registra el efecto puede retirar la tarea.
        let (run, project) = match self.tasks.get(task) {
            Some(t) => (t.run.clone(), t.project_id.clone()),
            None => return Err(format!("effect.observed: la tarea {task} no existe")),
        };
        let ctx = self.context().clone();
        self.try_push_event(ev::effect_observed(task, &run, project, &facts, effect.effect_id()).map(|d| d.by(ctx.actor, ctx.channel)));
        self.set_active_effect(Some(effect.effect_id().to_string()));
        Ok(())
    }

    // -----------------------------------------------------------------------------------------
    // Retirada de una tarea
    // -----------------------------------------------------------------------------------------

    /// Retira una tarea cuyo lanzamiento falló y emite `task.removed { cause: launch_failed }`. ÚNICO sitio
    /// que construye ese evento. La decide el Core (aunque la persona aprobara el lanzamiento): exige
    /// contexto System / Core y el evento se atribuye explícitamente a ese actor. Captura `run` y
    /// `project_id` ANTES de borrar y van explícitos en el borrador (la tarea ya no existe al finalizarlo).
    /// La cascada de `State::remove_task` quita sus decisiones legacy y los mensajes que la citan; si tiene
    /// hijas o es la raíz de un run, falla sin eliminar nada.
    pub(super) fn remove_failed_launch(&mut self, id: &str) -> Result<(), String> {
        let ctx = self.context().clone();
        if ctx.actor != Actor::System || ctx.channel != Channel::Core {
            return Err(format!("task.removed (launch_failed) lo decide el Core (System / Core); llegó {:?} por {:?}", ctx.actor, ctx.channel));
        }
        let (run, project) = match self.tasks.get(id) {
            Some(t) => (t.run.clone(), t.project_id.clone()),
            None => return Err(format!("La tarea {id} no existe")),
        };
        if let Some(t) = self.tasks.get(id) {
            // Lo que bloquea retirarla se comprueba antes de emitir nada (el Attempt no se para por un rechazo).
            if self.runs.get(&t.run).is_some_and(|r| r.root == id) || self.tasks.values().any(|c| c.parent.as_deref() == Some(id)) {
                return self.state_mut().remove_task(id);
            }
        }
        let attempt = self.push_attempt_retired(id);
        self.state_mut().remove_task(id)?;
        self.try_push_event(ev::task_removed(id, &run, project, ev::RemovalCause::LaunchFailed, attempt).map(|d| d.by(Actor::System, Channel::Core)));
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Solicitudes de lanzamiento (spawn.requested · spawn.resolved)
// ---------------------------------------------------------------------------------------------

/// Una resolución de solicitud ya decidida: lo que `Tx::record_spawn_resolution` registra.
pub(super) struct SpawnResolution<'a> {
    pub pending_id: &'a str,
    pub parent_task: &'a str,
    pub outcome: ev::SpawnOutcome,
    /// La hija, SOLO si existe de verdad.
    pub task: Option<&'a str>,
    /// ¿Hay un motivo (razón del rechazo, error del lanzamiento)? El texto no viaja en el evento.
    pub has_reason: bool,
    /// La fila legacy `Decision(spawn)`: `(actor "human" | "system", detalle)`. `None` solo para `cancelled_run_removed`.
    pub legacy: Option<(&'a str, &'a serde_json::Value)>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum SpawnRecorded {
    /// Registrada: el id de la fila legacy si la hubo.
    Recorded(Option<u64>),
    /// Ya existía una fila `Decision(spawn)` de ese `pending_id`: no se añadió nada.
    Duplicate,
}

fn check_spawn_actor(outcome: ev::SpawnOutcome, ctx: &MutationContext) -> Result<(), String> {
    let ok = if outcome.decided_by_person() {
        ctx.is_person_ui()
    } else {
        ctx.actor == Actor::System && ctx.channel == Channel::Core
    };
    if ok {
        Ok(())
    } else {
        Err(format!(
            "spawn.resolved: {outcome:?} lo decide {} (llegó {:?} por {:?})",
            if outcome.decided_by_person() { "una persona por la interfaz (person/ui)" } else { "el Core (system/core)" },
            ctx.actor,
            ctx.channel
        ))
    }
}

/// `spawn.requested` listo para `Core::record_facts`: lo puede solicitar el Agent autenticado que es padre
/// (`Agent(parent_task) / Lxo`) o la Person coordinadora desde el CLI (`Person / Lxo`).
pub(super) fn spawn_requested_fact(ctx: &MutationContext, p: &PendingSpawn) -> Result<EventDraft, String> {
    let parent_agent = ctx.actor == Actor::Agent(p.parent_task.clone());
    let cli_person = ctx.is_person();
    if ctx.channel != Channel::Lxo || !(parent_agent || cli_person) {
        return Err(format!("spawn.requested requiere el Agent padre o Person coordinadora por lxo (llegó {:?} por {:?})", ctx.actor, ctx.channel));
    }
    let facts = ev::SpawnRequestFacts {
        pending_id: &p.pending_id,
        parent_task: &p.parent_task,
        run: &p.run,
        provider: &p.provider,
        profile: &p.profile,
        role: p.role.as_deref(),
        model: p.model.as_deref(),
        effort: p.effort.as_deref(),
        title: &p.title,
        shared: p.shared,
        policy_status: p.policy.status,
        expires_at: p.expires_at,
    };
    ev::spawn_requested(&facts)
        .map(|event| event.by(ctx.actor.clone(), ctx.channel))
        .map_err(|e| e.to_string())
}

/// `spawn.resolved` de una solicitud cuya tarea padre YA no existe (el run desapareció por otra vía): no hay
/// fila legacy a la que colgarla ni estado que cambiar, así que el hecho va standalone (`Core::record_facts`,
/// `state_rev = NULL`). Es el único camino standalone de `spawn.resolved`; mismas reglas de actor.
pub(super) fn spawn_resolution_fact(ctx: &MutationContext, p: &PendingSpawn, outcome: ev::SpawnOutcome, task: Option<&str>, has_reason: bool) -> Result<EventDraft, String> {
    check_spawn_actor(outcome, ctx)?;
    ev::spawn_resolved(&p.pending_id, &p.run, p.project_id.clone(), outcome, task, has_reason).map(|d| d.by(ctx.actor.clone(), ctx.channel)).map_err(|e| e.to_string())
}
