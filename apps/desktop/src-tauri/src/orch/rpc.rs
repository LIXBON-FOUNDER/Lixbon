//! Despacho de comandos de `lxo` y de la interfaz (`Core::rpc`).

use std::sync::Arc;
use std::time::Duration;
use serde_json::{json, Value};
use super::{activity_read, attention_read, projects_overview, CLOSE_REMINDER, Caller, Core, MAX_DEPTH, agents, b, git, integration, issues, kinds, n, review, roles, s};
use super::events::{Actor, Channel, MutationContext};
use super::state::{Kind, NewTask, Status, Task};
use crate::store::{AuthenticatedClient, ClientAction, ClientClaims, ClientPrincipal};

impl Core {
    /// Resuelve la raíz que usa un coordinador CLI de Person como selector de contexto. La raíz no
    /// concede identidad ni permisos: la autorización sigue derivándose de la credencial Person y
    /// los Agent siempre usan la tarea de su propia credencial.
    pub(super) fn coordinator_task(&self, channel: Channel, caller: &Caller, args: &Value) -> Result<String, String> {
        match caller {
            Caller::Agent(_) => Self::me(caller),
            Caller::User if channel == Channel::Lxo => {
                let id = s(args, "root_task");
                if id.is_empty() {
                    return Err("Falta root_task para el run del coordinador CLI; crea o selecciona un run con `lxo run create`".into());
                }
                let st = self.lock();
                let task = st.task(&id)?;
                if task.parent.is_some() || st.runs.get(&task.run).is_none_or(|run| run.root != id) {
                    return Err(format!("La tarea {id} no es la raíz de un run"));
                }
                Ok(id)
            }
            _ => Self::me(caller),
        }
    }

    /// SOLO pruebas: atajo con el canal de cada superficie real (Tauri -> `Ui`, `lxo` -> `Lxo`). La
    /// producción llama a `rpc_via` con el canal que conoce; aquí el mapa es explícito y de prueba.
    #[cfg(test)]
    pub fn rpc(self: &Arc<Self>, caller: Caller, cwd: &str, cmd: &str, args: &Value) -> Result<Value, String> {
        let channel = match &caller {
            Caller::User => Channel::Ui,
            Caller::Agent(_) => Channel::Lxo,
        };
        self.rpc_via(channel, caller, cwd, cmd, args)
    }

    /// Despacho de un comando desde una superficie CONOCIDA: Tauri -> `Channel::Ui`, servidor local de
    /// `lxo` -> `Channel::Lxo`. El canal lo fija quien recibe la orden; nunca se deduce del actor.
    pub(super) fn rpc_via(self: &Arc<Self>, channel: Channel, caller: Caller, cwd: &str, cmd: &str, args: &Value) -> Result<Value, String> {
        if channel == Channel::Ui && matches!(&caller, Caller::User) {
            if let Some(client) = self.desktop_client()? {
                return self.rpc_authenticated_via(&client, &ClientClaims::default(), channel, cwd, cmd, args);
            }
        }
        self.rpc_with_context(channel, caller, cwd, cmd, args, None)
    }

    pub(super) fn rpc_authenticated_via(
        self: &Arc<Self>,
        client: &AuthenticatedClient,
        claims: &ClientClaims,
        channel: Channel,
        cwd: &str,
        cmd: &str,
        args: &Value,
    ) -> Result<Value, String> {
        let context = MutationContext::authenticated(client, claims, channel)
            .map_err(|error| format!("Identidad de cliente inválida: {error:?}"))?;
        let action = rpc_action(cmd);
        client.authorize(action).map_err(|error| format!("Acción no permitida para esta identidad: {error:?}"))?;
        let caller = match client.identity().principal() {
            ClientPrincipal::Person(_) => Caller::User,
            ClientPrincipal::Agent(task) => Caller::Agent(Some(task.clone())),
            ClientPrincipal::System => return Err("La identidad Core/System está reservada".into()),
        };
        self.rpc_with_context(channel, caller, cwd, cmd, args, Some(context))
    }

    fn rpc_with_context(
        self: &Arc<Self>,
        channel: Channel,
        caller: Caller,
        cwd: &str,
        cmd: &str,
        args: &Value,
        authenticated_context: Option<MutationContext>,
    ) -> Result<Value, String> {
        // Contexto de lo que muta este comando. Un agente sin identidad solo puede crear un run
        // (`run_create` fija su actor al crear la tarea raíz): para todo lo demás, sin identidad no hay
        // evento atribuido a un agente que no existe.
        let ctx_of = || -> Result<MutationContext, String> {
            if let Some(context) = &authenticated_context {
                return Ok(context.clone());
            }
            match &caller {
                Caller::User => Ok(MutationContext::person(channel)),
                Caller::Agent(Some(id)) => Ok(MutationContext::agent(id.clone(), channel)),
                Caller::Agent(None) => Err("Un agente sin identidad solo puede crear un run (lxo run create)".to_string()),
            }
        };
        if matches!(caller, Caller::Agent(_)) && !self.settings().enabled {
            return Err("El orquestador está desactivado: actívalo en Lixbon → Ajustes → Orquestador".into());
        }
        if let Caller::Agent(Some(id)) = &caller {
            if b(args, "session") && cmd != "run_create" && !self.lock().tasks.contains_key(id) {
                return Err("sesion-obsoleta".into());
            }
        }
        if matches!(&caller, Caller::User) && channel == Channel::Lxo && b(args, "session") && cmd != "run_create" {
            let root = s(args, "root_task");
            if root.is_empty() || !self.lock().tasks.contains_key(&root) {
                return Err("sesion-obsoleta".into());
            }
        }
        if let Caller::Agent(Some(id)) = &caller {
            self.touch_activity(id);
        }
        // Decisiones humanas (integrar, PR, revisar) y lecturas cerradas (diff de
        // revisión): ni orch_call ni el servidor de lxo llegan a ellas.
        if let Some(why) = review::closed_to_agents(cmd) {
            return Err(why.into());
        }
        match cmd {
            "status" => {
                let person_root = if matches!(&caller, Caller::User) && channel == Channel::Lxo && !s(args, "root_task").is_empty() {
                    Some(self.coordinator_task(channel, &caller, args)?)
                } else {
                    None
                };
                let st = self.lock();
                let task = match &caller {
                    Caller::Agent(Some(id)) => Some(st.task(id)?.clone()),
                    Caller::User if person_root.is_some() => Some(st.task(person_root.as_deref().unwrap())?.clone()),
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
            // Registro de proyectos (slice D). Leer es para todos. La gestión EXPLÍCITA (registrar, unir,
            // relocalizar, archivar, importar) es de la persona; un repositorio inequívocamente nuevo se
            // descubre solo (`run_create`, relleno) y lo ambiguo nunca se une en silencio.
            "projects" => self.projects_list(b(args, "all")),
            "projects_overview" => projects_overview::overview(self, &caller, authenticated_context.as_ref(), args),
            "activity_list" => activity_read::list(self, &caller, authenticated_context.as_ref(), args),
            "events" => self.events_read(&caller, args).map_err(String::from),
            "attention_list" => attention_read::list(self, &caller, authenticated_context.as_ref(), args),
            "attention_detail" => attention_read::detail(self, &caller, authenticated_context.as_ref(), args),
            "project_add" | "project_archive" | "project_locate" | "projects_import_recents" => {
                if !matches!(caller, Caller::User) {
                    return Err("Solo desde la interfaz: la gestión de proyectos (registrar, unir, relocalizar, archivar, importar) la decide una persona; un repositorio nuevo se descubre solo al lanzar un run".into());
                }
                let context = ctx_of()?;
                match cmd {
                    // La persona registra (manual). La importación la dispara la interfaz, pero la hace el Core.
                    "project_add" => self.project_add(&context, args),
                    "project_archive" => self.project_archive(&context, args),
                    "project_locate" => self.project_locate(&context, args),
                    _ => self.projects_import_recents(&context.with_actor(Actor::System), args),
                }
            }
            "run_create" => {
                if let Caller::Agent(Some(id)) = &caller {
                    if !b(args, "session") {
                        return Err(format!("Ya eres la tarea {id}: crea hijos directamente con lxo spawn"));
                    }
                    self.lock().session_replaceable(id)?;
                }
                if matches!(&caller, Caller::User) && channel == Channel::Lxo && b(args, "session") {
                    let root = s(args, "root_task");
                    if !root.is_empty() && self.lock().tasks.contains_key(&root) {
                        self.coordinator_task(channel, &caller, args)?;
                        self.lock().session_replaceable(&root)?;
                    }
                }
                let objective = s(args, "objective");
                if objective.is_empty() {
                    return Err("Falta --objective".into());
                }
                let repo = git::toplevel(cwd).ok_or("El orquestador necesita un repositorio git: ejecútalo dentro de uno")?;
                let agent = Some(s(args, "agent")).filter(|a| !a.is_empty()).unwrap_or_else(|| "coordinador".into());
                let branch = git::current_branch(cwd);
                // Proyecto del repositorio: misma ruta -> ese; sin coincidencias -> nuevo; ambiguo -> ninguno.
                // Un error real del registro activo se propaga: no se crea ni el run ni la tarea.
                // Si nace, `project.registered` lo atribuye a quien lanza el run: persona, agente (su tarea) o,
                // sin identidad, el sistema.
                let registrant = match &caller {
                    Caller::Agent(None) => MutationContext::system(channel),
                    _ => ctx_of()?,
                };
                let project_id = self.project_for_repo(&registrant, &repo)?;
                if let Some(pid) = &project_id {
                    self.check_project_launchable_id(pid)?;
                }
                let (run, task) = self.mutate(|st| {
                    let (run, task) = st.create_run(&objective, NewTask {
                        agent,
                        model: None,
                        effort: None,
                        role: None,
                        title: objective.chars().take(60).collect(),
                        spec: objective.clone(),
                        repo,
                        cwd: cwd.into(),
                        branch,
                        base: None,
                        worktree: None,
                        external: true,
                    });
                    // Bootstrap de identidad (solo aquí): el coordinador aún no existía como tarea, así que
                    // el actor de los eventos de esta mutación es la tarea raíz recién creada. Los borradores
                    // ya acumulados usan este actor al finalizar.
                    st.set_context(match &caller {
                        Caller::User => ctx_of()?,
                        Caller::Agent(None) => MutationContext::agent(task.clone(), channel),
                        Caller::Agent(Some(_)) => ctx_of()?.with_actor(Actor::Agent(task.clone())),
                    });
                    st.mark_running(&task)?;
                    if let Some(t) = st.tasks.get_mut(&task) {
                        t.project_id = project_id.clone();
                    }
                    Ok((run, task))
                })?;
                Ok(json!({ "run": run, "task": task }))
            }
            // Ningún lanzamiento arranca sin la persona: queda pendiente (approval.rs).
            "spawn" => self.spawn_request(ctx_of()?, &caller, args),
            "spawn_status" => self.spawn_status(channel, &caller, args),
            "agents" => Ok(json!({ "agents": agents::available(b(args, "refresh")) })),
            "roles" => Ok(roles::describe(&self.settings().roles)),
            "issue" => {
                // El rol de la hija firma sus comentarios como informe de agente.
                let rol = match &caller {
                    Caller::Agent(Some(id)) => self.lock().task(id).ok().and_then(|t| t.role.clone()),
                    _ => None,
                };
                let host = self.host.get().ok_or("La app todavía no ha arrancado")?;
                issues::ejecutar(host.as_ref(), args, rol)
            }
            "continue" => self.follow_up(&ctx_of()?, &caller, args),
            "phase" => {
                let me = Self::me(&caller)?;
                let name = s(args, "name");
                if name.is_empty() {
                    return Err("Falta el nombre de la fase".into());
                }
                self.mutate_as(&ctx_of()?, |st| {
                    let msg = st.phase(&me, &name, b(args, "done"), &s(args, "note"))?;
                    st.notify_opt(msg);
                    Ok(())
                })?;
                Ok(json!({ "task": me, "phase": name }))
            }
            "done" => {
                let me = Self::me(&caller)?;
                let files = args.get("files").and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect())
                    .unwrap_or_default();
                let summary = s(args, "summary");
                let report = self.store_report(&me, &s(args, "report"), &s(args, "report_text"), &summary)?;
                let status = self.mutate_as(&ctx_of()?, |st| {
                    let msg = st.done(&me, !b(args, "failed"), &summary, files, Some(report.clone()))?;
                    st.task_mut(&me)?.delivery_channel = Some("lxo_done".into());
                    st.notify_opt(msg);
                    Ok(st.task(&me)?.status)
                })?;
                Ok(json!({ "task": me, "status": status, "report": report }))
            }
            "ask" => {
                let me = Self::me(&caller)?;
                let question = s(args, "question");
                if question.is_empty() {
                    return Err("Falta la pregunta".into());
                }
                let id = self.mutate_as(&ctx_of()?, |st| {
                    let id = st.ask(&me, &question)?;
                    st.notify(&[id]);
                    Ok(id)
                })?;
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
                let id = self.mutate_as(&ctx_of()?, |st| {
                    let from = match &caller {
                        Caller::User => st.messages.iter().find(|m| m.id == q).map(|m| m.to.clone()).ok_or_else(|| format!("No existe la pregunta {q}"))?,
                        _ => Self::me(&caller)?,
                    };
                    let id = st.reply(&from, q, &answer)?;
                    st.notify(&[id]);
                    Ok(id)
                })?;
                Ok(json!({ "reply": id }))
            }
            "send" => {
                let to = s(args, "to");
                let body = s(args, "body");
                let id = self.mutate(|st| {
                    Self::check_manages(st, &caller, &to)?;
                    let from = match &caller {
                        Caller::User => st.task(&to)?.parent.clone().unwrap_or_else(|| to.clone()),
                        _ => Self::me(&caller)?,
                    };
                    let id = st.post(&from, &to, Kind::Note, &body, None)?;
                    st.notify(&[id]);
                    Ok(id)
                })?;
                Ok(json!({ "message": id }))
            }
            "wait" => {
                let me = self.coordinator_task(channel, &caller, args)?;
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
                let me = self.coordinator_task(channel, &caller, args)?;
                let found = if cmd == "check" {
                    self.mutate(|st| {
                        let found = st.unread(&me, &kinds(args), None);
                        let ids: Vec<u64> = found.iter().map(|m| m.id).collect();
                        st.mark_read(&ids);
                        Ok(found)
                    })?
                } else {
                    self.lock().unread(&me, &kinds(args), None)
                };
                Ok(json!({ "messages": found }))
            }
            "list" => {
                let run = match &caller {
                    Caller::Agent(Some(id)) => Some(self.lock().task(id)?.run.clone()),
                    Caller::User if channel == Channel::Lxo && !s(args, "root_task").is_empty() => {
                        let id = self.coordinator_task(channel, &caller, args)?;
                        Some(self.lock().task(&id)?.run.clone())
                    }
                    _ => Some(s(args, "run")).filter(|r| !r.is_empty()),
                };
                let st = self.lock();
                let tasks: Vec<&Task> = st.tree().into_iter().filter(|t| run.as_ref().is_none_or(|r| &t.run == r)).collect();
                Ok(json!({ "tasks": tasks }))
            }
            "show" => {
                let id = Some(s(args, "task")).filter(|t| !t.is_empty()).map(Ok)
                    .unwrap_or_else(|| self.coordinator_task(channel, &caller, args))?;
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
                // Si el proceso no se pudo detener la tarea NO se declara detenida: el terminal sigue custodiado.
                self.kill_term(&id).map_err(|e| format!("No se pudo detener {id}: {e}. Sigue en marcha; reinténtalo"))?;
                self.mutate_as(&ctx_of()?, |st| {
                    let msg = st.close(&id, Status::Stopped, "detenida por su coordinador")?;
                    st.notify_opt(msg);
                    Ok(())
                })?;
                Ok(json!({ "task": id, "status": "stopped" }))
            }
            "release" => self.release(&ctx_of()?, &caller, &s(args, "task"), b(args, "force")),
            "run_close" => {
                let run = {
                    let st = self.lock();
                    match &caller {
                        Caller::User => {
                            let root_task = s(args, "root_task");
                            if root_task.is_empty() {
                                return Err("Falta root_task: selecciona el run que quieres cerrar".into());
                            }
                            let task = st.task(&root_task)?;
                            if task.parent.is_some() {
                                return Err("Solo se puede cerrar el run desde su tarea raíz".into());
                            }
                            task.run.clone()
                        }
                        Caller::Agent(Some(id)) => {
                            if let Some(selector) = args.get("root_task") {
                                let selected = selector.as_str().filter(|s| !s.is_empty())
                                    .ok_or_else(|| "root_task debe ser el identificador de la tarea raíz autenticada".to_string())?;
                                if selected != id {
                                    return Err("Un Agent solo puede cerrar el run de su tarea autenticada".into());
                                }
                            }
                            let task = st.task(id)?;
                            if task.parent.is_some() {
                                return Err("Solo el coordinador del run puede cerrarlo".into());
                            }
                            task.run.clone()
                        }
                        Caller::Agent(None) => return Err(Self::me(&caller).unwrap_err()),
                    }
                };
                self.close_run(&ctx_of()?, &run, b(args, "force"))
            }
            "remove_run" => {
                if !matches!(caller, Caller::User) {
                    return Err("Solo desde la interfaz".into());
                }
                let run = s(args, "run");
                // `spawn.resolved` (cancelled_run_removed) de sus pendientes + `run.removed`: UNA mutación; la memoria
                // de los pendientes solo cambia tras el COMMIT.
                let kept = self.remove_run_and_cancel_pending(&ctx_of()?, &run)?;
                Ok(json!({ "removed": run, "kept": kept }))
            }
            other => Err(format!("Comando desconocido: {other}")),
        }
    }
}

/// Cada comando expuesto por el sidecar debe tener una clasificación explícita. La
/// política por principal/superficie está centralizada en `AuthenticatedClient::authorize`.
fn rpc_action(cmd: &str) -> ClientAction {
    match cmd {
        "status" | "projects" | "projects_overview" | "attention_list" | "attention_detail" | "activity_list"
        | "spawn_status" | "agents" | "roles" | "list" | "show" => ClientAction::Read,
        "events" => ClientAction::EventLogRead,
        "project_add" | "project_archive" | "project_locate" | "projects_import_recents"
        | "remove_run" => ClientAction::UiCommand,
        "run_create" | "run_close" | "spawn" | "issue" | "continue" | "phase" | "done"
        | "ask" | "await_reply" | "reply" | "send" | "wait" | "check" | "inbox" => {
            ClientAction::AgentCommand
        }
        "stop" | "release" | "diff" => ClientAction::AgentOrDesktopCommand,
        "integrate" | "merge" | "pr" | "review" => ClientAction::HumanDecision,
        _ => ClientAction::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orch::boot_tests;
    use crate::store::{ClientCredential, ClientRegistration, ClientSurface, DeviceIdentity, Store};

    fn cli_commands() -> std::collections::BTreeSet<&'static str> {
        const CLI_MAIN: &str = include_str!("../../../lxo/src/main.rs");
        let mut commands = std::collections::BTreeSet::new();
        let mut remaining = CLI_MAIN;
        while let Some((_, after_marker)) = remaining.split_once("call(\"") {
            let (command, after_command) = after_marker.split_once('\"').expect("literal call command closes");
            commands.insert(command);
            remaining = after_command;
        }
        commands
    }

    fn expected_cli_action(cmd: &str) -> ClientAction {
        match cmd {
            "status" | "projects" | "projects_overview" | "attention_list" | "attention_detail" | "activity_list"
            | "spawn_status" | "agents" | "roles" | "list" | "show" => ClientAction::Read,
            "events" => ClientAction::EventLogRead,
            "project_add" | "project_archive" | "project_locate" | "projects_import_recents"
            | "remove_run" => ClientAction::UiCommand,
            "run_create" | "run_close" | "spawn" | "issue" | "continue" | "phase" | "done"
            | "ask" | "await_reply" | "reply" | "send" | "wait" | "check" | "inbox" => {
                ClientAction::AgentCommand
            }
            "stop" | "release" | "diff" => ClientAction::AgentOrDesktopCommand,
            "integrate" | "merge" | "pr" | "review" => ClientAction::HumanDecision,
            _ => ClientAction::Unknown,
        }
    }

    fn test_client(surface: ClientSurface, principal: ClientPrincipal) -> (Store, AuthenticatedClient, std::path::PathBuf) {
        let surface_name = match surface {
            ClientSurface::Desktop => "desktop",
            ClientSurface::Cli => "cli",
            _ => panic!("el inventario compara Desktop y CLI"),
        };
        let dir = std::env::temp_dir().join(format!(
            "lixbon-rpc-matrix-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = Store::open(&dir, "test").unwrap();
        let registration = ClientRegistration::new(
            surface,
            DeviceIdentity::new(format!("install-matrix-{surface_name}"), None).unwrap(),
        )
        .unwrap();
        let credential = ClientCredential::new(principal, format!("rpc-matrix-secret-{surface_name}-32-bytes-minimum")).unwrap();
        let client = store.register_client(&registration, &credential, 100).unwrap();
        (store, client, dir)
    }

    #[test]
    fn todos_los_calls_del_cli_tienen_clasificacion_y_matriz_explicitas() {
        let commands = cli_commands();
        assert!(!commands.is_empty(), "el inventario real de llamadas del sidecar se debe analizar");
        let (person_cli_store, person_cli, person_cli_dir) = test_client(
            ClientSurface::Cli,
            ClientPrincipal::Person("cli-person".into()),
        );
        let (agent_cli_store, agent_cli, agent_cli_dir) = test_client(
            ClientSurface::Cli,
            ClientPrincipal::Agent("task-agent".into()),
        );
        let (person_desktop_store, person_desktop, person_desktop_dir) = test_client(
            ClientSurface::Desktop,
            ClientPrincipal::Person("desktop-person".into()),
        );
        assert_eq!(rpc_action("events"), ClientAction::EventLogRead);
        assert!(person_cli.authorize(ClientAction::EventLogRead).is_ok(), "Person CLI recibe solo lectura del Event Log");
        assert!(agent_cli.authorize(ClientAction::EventLogRead).is_ok());
        assert!(person_desktop.authorize(ClientAction::EventLogRead).is_ok());
        assert!(person_cli.authorize(ClientAction::UiCommand).is_err());
        assert!(person_cli.authorize(ClientAction::HumanDecision).is_err());

        for command in &commands {
            let action = rpc_action(command);
            assert_ne!(action, ClientAction::Unknown, "call(\"{command}\") del CLI no tiene política explícita");
            assert_eq!(action, expected_cli_action(command), "clasificación de call(\"{command}\")");
            let coordinator_cli_allows = matches!(
                action,
                ClientAction::Read
                    | ClientAction::EventLogRead
                    | ClientAction::AgentCommand
                    | ClientAction::AgentOrDesktopCommand
            );
            let agent_task_allows = matches!(
                action,
                ClientAction::Read
                    | ClientAction::EventLogRead
                    | ClientAction::AgentCommand
                    | ClientAction::AgentOrDesktopCommand
            );
            let desktop_person_allows = !matches!(action, ClientAction::CoreCommand | ClientAction::Unknown);
            assert_eq!(
                person_cli.authorize(action).is_ok(),
                coordinator_cli_allows,
                "Person CLI permiso para call(\"{command}\") como coordinador"
            );
            assert_eq!(
                agent_cli.authorize(action).is_ok(),
                agent_task_allows,
                "Agent CLI permiso para call(\"{command}\"); relación con task se comprueba al despachar"
            );
            assert_eq!(
                person_desktop.authorize(action).is_ok(),
                desktop_person_allows,
                "Person Desktop permiso para call(\"{command}\")"
            );
        }

        for action in [ClientAction::Unknown, ClientAction::CoreCommand] {
            assert!(person_cli.authorize(action).is_err());
            assert!(agent_cli.authorize(action).is_err());
            assert!(person_desktop.authorize(action).is_err());
        }
        assert_eq!(rpc_action("unknown_future_rpc"), ClientAction::Unknown);

        drop((person_cli_store, agent_cli_store, person_desktop_store));
        for dir in [person_cli_dir, agent_cli_dir, person_desktop_dir] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn credencial_agent_no_puede_decidir_revision_antes_de_mutar() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();

        let secret = "agent-rpc-review-secret-85-at-least-32-bytes";
        let registration = ClientRegistration::new(
            ClientSurface::Cli,
            DeviceIdentity::new("install-agent-rpc-review-85", None).unwrap(),
        )
        .unwrap();
        let credential = ClientCredential::new(
            ClientPrincipal::Agent("task-agent-rpc-review-85".into()),
            secret,
        )
        .unwrap();
        core.storage
            .with_store(|store| {
                store
                    .register_client(&registration, &credential, super::super::state::now_ms() as i64)
                    .unwrap();
            })
            .expect("almacén abierto");
        let client = core.authenticate_client(secret).unwrap().expect("credencial registrada");
        let head_before = core.storage.with_store(|store| store.events_head().unwrap()).unwrap();

        let result = core.rpc_authenticated_via(
            &client,
            &ClientClaims::default(),
            Channel::Lxo,
            "",
            "review",
            &json!({ "task": "task-agent-rpc-review-85", "decision": "accepted", "confirm": true }),
        );

        assert!(result.unwrap_err().contains("Acción no permitida"), "la identidad Agent se rechaza en la frontera autenticada");
        assert_eq!(core.storage.with_store(|store| store.events_head().unwrap()).unwrap(), head_before);
    }
}
