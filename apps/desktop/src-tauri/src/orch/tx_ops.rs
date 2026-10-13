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

use std::collections::BTreeMap;

use super::event_kinds as ev;
use super::events::{Actor, Channel};
use super::mutation::Tx;
use super::state::{NewTask, State, Status};

/// Estado de las tareas de un run (o de todos) antes de un mutador: `tarea -> (estado, run)`.
type Snapshot = BTreeMap<String, (Status, String)>;

impl Tx {
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

    /// Emite UN `task.status_changed` por cada tarea cuyo estado difiere del de `before`.
    fn push_status_changes(&mut self, before: Snapshot, cause: Option<&str>) {
        let changes: Vec<_> = before
            .into_iter()
            .filter_map(|(id, (from, run))| {
                let now = self.tasks.get(&id)?.status;
                (now != from).then_some((id, run, from, now))
            })
            .collect();
        for (id, run, from, to) in changes {
            self.try_push_event(ev::task_status_changed(&id, &run, from, to, cause.map(String::from)));
        }
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
        (run, task)
    }

    /// `task.created`. Las hijas producen únicamente éste.
    pub(super) fn add_child(&mut self, parent: &str, max_depth: u32, t: NewTask) -> Result<String, String> {
        let id = self.state_mut().add_child(parent, max_depth, t)?;
        if let Some(t) = self.tasks.get(&id).cloned() {
            self.try_push_event(ev::task_created(&t));
        }
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

    pub(super) fn done(&mut self, id: &str, ok: bool, summary: &str, files: Vec<String>, report: Option<String>) -> Result<Option<u64>, String> {
        let before = self.snapshot_run_of(id);
        let msg = self.state_mut().done(id, ok, summary, files, report)?;
        self.push_status_changes(before, None);
        Ok(msg)
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
        let tasks = self.tasks.values().filter(|t| t.run == run).count();
        self.state_mut().remove_run(run);
        self.try_push_event(ev::run_removed(run, project, tasks));
    }

    // -----------------------------------------------------------------------------------------
    // Decisiones
    // -----------------------------------------------------------------------------------------

    /// Registra una decisión (fila legacy) y emite `decision.recorded`. ÚNICO sitio que construye ese
    /// evento. Orden: 1) valida la tarea, el actor y el contrato del `detail`; 2) `State::record_decision`;
    /// 3) con el id asignado, EXACTAMENTE un borrador cuando `kind` ∈ review/merge/pr. `spawn` conserva
    /// su fila pero no emite (lo representará `spawn.resolved`); cualquier otro `kind` rechaza la
    /// mutación completa.
    ///
    /// Validación de actor: la fila legacy dice quién decide (`"human"`, `"system"` o una tarea) y el
    /// contexto de la mutación debe ser realmente ese actor. Además, review/merge/pr son decisiones de una
    /// PERSONA desde la interfaz (`Person / Ui`); no es una regla global de `Decision`: los lanzamientos
    /// pendientes podrán decidir como sistema.
    pub(super) fn record_decision(&mut self, task: &str, kind: &str, actor: &str, detail: &serde_json::Value) -> Result<u64, String> {
        if !self.tasks.contains_key(task) {
            return Err(format!("decisión {kind}: la tarea {task} no existe"));
        }
        self.check_decision_actor(kind, actor)?;
        let facts = ev::DecisionRecorded::parse(kind, detail)?;
        let id = self.state_mut().record_decision(task, kind, actor, detail);
        if let Some(facts) = facts {
            let run = self.run_of(task);
            self.try_push_event(ev::decision_recorded(task, &run, &facts.with_id(id)));
        }
        Ok(id)
    }

    fn check_decision_actor(&self, kind: &str, actor: &str) -> Result<(), String> {
        let ctx = self.context();
        let coincide = match (actor, &ctx.actor) {
            ("human", Actor::Person) | ("system", Actor::System) => true,
            (a, Actor::Agent(task)) => a != "human" && a != "system" && a == task,
            _ => false,
        };
        if !coincide {
            return Err(format!("decisión {kind}: la fila dice actor {actor:?} pero la mutación la hace {:?}", ctx.actor));
        }
        if matches!(kind, "review" | "merge" | "pr") && (actor != "human" || ctx.channel != Channel::Ui) {
            return Err(format!("decisión {kind}: solo la toma una persona desde la interfaz (llegó {:?} por {:?})", ctx.actor, ctx.channel));
        }
        Ok(())
    }
}
