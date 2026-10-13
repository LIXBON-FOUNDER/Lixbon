//! Despacho de comandos de `lxo` y de la interfaz (`Core::rpc`).

use std::sync::Arc;
use std::time::Duration;
use serde_json::{json, Value};
use super::{CLOSE_REMINDER, Caller, Core, MAX_DEPTH, agents, b, git, integration, issues, kinds, n, review, roles, s};
use super::events::{Channel, MutationContext};
use super::state::{Kind, NewTask, Status, Task};

impl Core {
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
        // Contexto de lo que muta este comando. Un agente sin identidad solo puede crear un run
        // (`run_create` fija su actor al crear la tarea raíz): para todo lo demás, sin identidad no hay
        // evento atribuido a un agente que no existe.
        let ctx_of = || -> Result<MutationContext, String> {
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
            // Registro de proyectos (slice D). Leer es para todos. La gestión EXPLÍCITA (registrar, unir,
            // relocalizar, archivar, importar) es de la persona; un repositorio inequívocamente nuevo se
            // descubre solo (`run_create`, relleno) y lo ambiguo nunca se une en silencio.
            "projects" => self.projects_list(b(args, "all")),
            "project_add" | "project_archive" | "project_locate" | "projects_import_recents" => {
                if !matches!(caller, Caller::User) {
                    return Err("Solo desde la interfaz: la gestión de proyectos (registrar, unir, relocalizar, archivar, importar) la decide una persona; un repositorio nuevo se descubre solo al lanzar un run".into());
                }
                match cmd {
                    "project_add" => self.project_add(args),
                    "project_archive" => self.project_archive(args),
                    "project_locate" => self.project_locate(args),
                    _ => self.projects_import_recents(args),
                }
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
                let branch = git::current_branch(cwd);
                // Proyecto del repositorio: misma ruta -> ese; sin coincidencias -> nuevo; ambiguo -> ninguno.
                // Un error real del registro activo se propaga: no se crea ni el run ni la tarea.
                let project_id = self.project_for_repo(&repo)?;
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
                        Caller::User => MutationContext::person(channel),
                        Caller::Agent(_) => MutationContext::agent(task.clone(), channel),
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
                self.mutate_as(&ctx_of()?, |st| {
                    let msg = st.close(&id, Status::Stopped, "detenida por su coordinador")?;
                    st.notify_opt(msg);
                    Ok(())
                })?;
                Ok(json!({ "task": id, "status": "stopped" }))
            }
            "release" => self.release(&ctx_of()?, &caller, &s(args, "task"), b(args, "force")),
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
                self.close_run(&ctx_of()?, &run, b(args, "force"))
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
                let (_, kept) = self.free_worktrees(&ctx_of()?, &run, false);
                self.mutate_as(&ctx_of()?, |st| {
                    st.remove_run(&run);
                    Ok(())
                })?;
                Ok(json!({ "removed": run, "kept": kept }))
            }
            other => Err(format!("Comando desconocido: {other}")),
        }
    }
}
