//! Lanzamiento de hijas: plan, aprobación, creación y arranque del proceso.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use serde_json::{json, Value};
use super::{Caller, Core, MAX_DEPTH, MODEL_TRIES, agents, approval, b, codex_session, delivery, git, lxo_path, pty, random_token, roles, s, spawn_approval, state, task_file, worktree_env};
use super::events::MutationContext;
use super::mutation::{Effect, Health, StateAccess, Tx};
use super::state::NewTask;

/// Lo que UN intento de lanzamiento ha creado y por tanto puede deshacer. Local al intento (no durable) y
/// independiente de `State`: el worktree puede existir en disco sin que `Task.worktree` lo sepa (el registro
/// pudo fallar), así que el cleanup NO se apoya en el estado. `worktree`/`branch` solo se rellenan cuando
/// `git::add_worktree` devolvió `Ok`: un `add_worktree` que falla (p. ej. «ya existe la carpeta») no da
/// propiedad sobre esa ruta, que nunca se borra.
pub(super) struct SpawnAttempt {
    pub(super) task: String,
    pub(super) repo: String,
    pub(super) worktree: Option<PathBuf>,
    pub(super) branch: Option<String>,
}

/// Puntos del lanzamiento donde las pruebas pueden fallar o intervenir (ver `Core::spawn_hook`).
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SpawnStep {
    /// `git worktree add` devolvió Ok; todavía no se registró.
    AfterAddWorktree,
    /// Dentro del cierre que registra el worktree (un `Err` es un rechazo del registro).
    InWorktreeRegistration,
    /// Worktree registrado; antes de `ensure_launchable`.
    AfterWorktreeRegistered,
    /// Dentro de `launch` (en pruebas, `fake_launch`).
    InLaunch,
    /// `launch` devolvió Ok; antes de registrar `pty_process`.
    AfterLaunch,
    /// Dentro del cierre que registra `pty_process` (un `Err` es un rechazo del registro).
    InPtyRegistration,
    /// `spawn_request`: el plan ya está hecho y todavía no se tomó la compuerta ni se revalidó el padre (la
    /// carrera con `remove_run` o con un cierre del run). `id` es la tarea padre.
    BeforeRequestRevalidation,
    /// Después de persistir e insertar el pending y antes de emitir el aviso de UI.
    AfterRequestPersistBeforeEmit,
    /// Después de pasar `Pending → Launching`, antes de `create_child`.
    AfterApprovalClaim,
    /// Justo antes de que `remove_run` intente tomar `pend_gate`.
    BeforeRunRemovalGate,
    /// Después de limpiar terminales/worktrees de `remove_run`, antes de tomar la instantánea de pendientes.
    AfterRunRemovalCleanupSnapshot,
    /// Después de confirmar el registro `pty_process` de la tarea hija.
    AfterPtyRegistration,
}

#[cfg(test)]
pub(super) type SpawnHook = Arc<dyn Fn(&Core, &str, SpawnStep) -> Result<(), String> + Send + Sync>;

impl Core {
    /// Solo pruebas: ejecuta el gancho instalado en ese punto. `AfterApprovalClaim`, `AfterRequestPersistBeforeEmit`,
    /// `AfterPtyRegistration` y `AfterRunRemovalCleanupSnapshot` corren con `pend_gate` tomada; sus ganchos no deben
    /// llamar una transición que vuelva a tomarla. Los ganchos `In*` corren DENTRO de una mutación y no deben tocar
    /// el estado del Core.
    #[cfg(test)]
    pub(super) fn spawn_hook(&self, step: SpawnStep, id: &str) -> Result<(), String> {
        let hook = self.spawn_hook.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match hook {
            Some(h) => h(self, id, step),
            None => Ok(()),
        }
    }

    #[cfg(not(test))]
    #[inline(always)]
    pub(super) fn spawn_hook(&self, _step: SpawnStep, _id: &str) -> Result<(), String> {
        Ok(())
    }

    pub(super) fn branch_of(&self, caller: &Caller, id: &str) -> Result<(String, String, String), String> {
        let st = self.lock();
        Self::check_manages(&st, caller, id)?;
        let t = st.task(id)?;
        let branch = t.branch.clone().ok_or_else(|| format!("{id} no tiene rama propia (se lanzó sin worktree)"))?;
        Ok((branch, t.base.clone().unwrap_or_else(|| "HEAD".into()), t.cwd.clone()))
    }

    /// Valida lo que pide el agente (sin crear nada) y arma el pendiente.
    pub(super) fn plan_spawn(&self, caller: &Caller, args: &Value) -> Result<spawn_approval::PendingSpawn, String> {
        let parent_id = Self::me(caller)?;
        self.check_project_launchable(&parent_id)?;
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
        // Solo el PEDIDO (agente, modelo, esfuerzo): la compuerta de policy la aplica `spawn_request` DESPUÉS de
        // registrar la solicitud, así que una policy `blocked` ya no se confunde con una entrada inválida.
        agents::check_request(&agent, model.as_deref(), effort.as_deref(), profile, role.as_deref())?;
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
    pub(super) fn create_child(self: &Arc<Self>, p: &spawn_approval::PendingSpawn, argv: Vec<String>, ack_unverified: bool) -> Result<Value, String> {
        let parent_id = p.parent_task.clone();
        // Quien actúa: la PERSONA que aprobó el lanzamiento, desde la interfaz (`approve_spawn` solo
        // existe como comando de Tauri: los agentes no pueden aprobar). El agente que lo pidió consta en
        // `spawn.requested` (bloque de Pending Spawn).
        let ctx = self.desktop_mutation_context()?;
        // REVALIDACIÓN tras la aprobación humana: plan -> aprobación -> revalidación -> efectos.
        // Entre `plan_spawn` y el «sí» de la persona pueden pasar minutos: el proyecto pudo archivarse,
        // su carpeta desaparecer o relocalizarse. La aprobación no congela una launchability antigua.
        // Va ANTES de crear la tarea, el worktree o cualquier proceso: si falla, no queda nada.
        self.check_project_launchable(&parent_id)?;
        // La tarea se persiste ANTES de cualquier efecto (worktree, proceso): una
        // caída a mitad del lanzamiento deja rastro recuperable en vez de un
        // worktree huérfano sin tarea.
        // Nota para Task/Attempt: este orden ya pide estados intermedios explícitos
        // (`pending` -> `starting` -> `working`, y `failed_start`). Hoy la tarea nace
        // sin ellos; C2a no introduce Attempt, solo deja constancia de la necesidad.
        let (id, parent) = self.mutate_as(&ctx, |st| {
            let parent = st.task(&parent_id)?.clone();
            let id = st.add_child_for_spawn(&parent_id, MAX_DEPTH, NewTask {
                agent: p.provider.clone(), model: p.model.clone(), effort: p.effort.clone(), role: p.role.clone(), title: p.title.clone(), spec: p.spec.clone(),
                repo: parent.repo.clone(), cwd: parent.cwd.clone(), branch: None, base: None, worktree: None, external: false,
            }, &p.pending_id)?;
            let t = st.task_mut(&id)?;
            t.profile = Some(p.profile.clone());
            t.ack_unverified = ack_unverified;
            t.requested_argv = Some(argv);
            Ok((id, parent))
        })?;

        let mut attempt = SpawnAttempt { task: id.clone(), repo: parent.repo.clone(), worktree: None, branch: None };
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
            // A partir de aquí el intento es dueño de este worktree y esta rama (y solo de ellos).
            attempt.worktree = Some(dir.clone());
            attempt.branch = Some(branch.clone());
            self.spawn_hook(SpawnStep::AfterAddWorktree, &id)?;
            let env = worktree_env::apply(&parent.repo, &dir, &worktree_env::plan(&parent.repo).restricted_to(&p.env));
            // El worktree ya existe: su registro es UNA mutación posterior.
            let effect = Effect::new("spawn", "git_worktree").task(&id).repo(&parent.repo)
                .expected(json!({ "record": "task worktree, branch y cwd" }))
                .observed(json!({ "worktree": dir, "branch": branch, "base": base }));
            self.acting(ctx.clone()).mutate_after_effect(effect, |st| {
                self.spawn_hook(SpawnStep::InWorktreeRegistration, &id)?;
                let t = st.task_mut(&id)?;
                t.env = Some(env).filter(|e| !e.is_empty());
                t.base_commit = start;
                t.cwd = dir.to_string_lossy().into_owned();
                t.worktree = Some(t.cwd.clone());
                t.branch = Some(branch.clone());
                t.base = Some(base);
                Ok(())
            })
        })()
        .and_then(|_| self.spawn_hook(SpawnStep::AfterWorktreeRegistered, &id))
        .and_then(|_| self.ensure_launchable(&id))
        .and_then(|_| self.launch(&id));

        if let Err(e) = prepared {
            // Se devuelve el error original aunque la limpieza no se pueda hacer o persistir.
            self.abandon_attempt(&attempt);
            return Err(e);
        }
        if let Err(e) = self.spawn_hook(SpawnStep::AfterLaunch, &id) {
            self.abandon_attempt(&attempt);
            return Err(e);
        }
        // El proceso ya corre: su registro es UNA mutación posterior. Si el agente ya
        // murió al arrancar, la tarea quedó en `exited` y así se informa.
        let effect = Effect::new("spawn", "pty_process").task(&id)
            .expected(json!({ "record": "task en marcha (running)" }))
            .observed(json!({ "launched": true }));
        let registered = self.acting(ctx.clone()).mutate_after_effect(effect, |st| {
            self.spawn_hook(SpawnStep::InPtyRegistration, &id)?;
            let _ = st.mark_running(&id);
            Ok(st.task(&id)?.clone())
        });
        let t = match registered {
            Ok(t) => t,
            Err(e) => {
                // El proceso está vivo y NO quedó registrado: se compensa (matarlo y, si el Core sigue sano, deshacer).
                self.abandon_attempt(&attempt);
                return Err(e);
            }
        };
        self.spawn_hook(SpawnStep::AfterPtyRegistration, &id)?;
        Ok(json!({ "task": t.id, "agent": t.agent, "model": t.model, "effort": t.effort, "role": t.role, "status": t.status, "branch": t.branch, "worktree": t.worktree }))
    }

    /// Deshace un intento de lanzamiento fallido. Lo decide el Core (System / Core), aunque la persona aprobara
    /// el lanzamiento, y se apoya en lo que el INTENTO creó, no en lo que `State` recuerde.
    ///
    /// Orden: 1) capturar si la Task es retirable (antes de matar nada: nuestro propio `on_exit` no puede
    /// convertir una Task removible en preservada); 2) matar el proceso vivo, también con el Core degradado
    /// (es el único acto destructivo permitido ahí); «el proceso» incluye uno sin terminal que `pty` custodia porque su
    /// construcción falló y no se pudo matar (`kill_term_checked` lo resuelve), y una terminación ya en curso por otro
    /// llamante cuenta como «sin control»; si no hay control fiable sobre él, se conserva TODO;
    /// 3) con el Core degradado no se borra nada más (ni worktree, ni rama, ni Task): su borrado no se podría
    /// registrar y el estado y el disco quedarían inconsistentes; 4) quitar el worktree del intento y, si
    /// tuvo éxito, intentar `branch -d` (nunca `-D`; `branch_deleted` es el resultado real); 5) registrar en
    /// UNA mutación: `effect.observed` (git_worktree_removed / spawn_cleanup) y `task.removed` solo si la
    /// Task era retirable. Si `remove_worktree` falla, la Task se conserva.
    pub(super) fn abandon_attempt(&self, a: &SpawnAttempt) {
        let removable = {
            let st = self.lock();
            st.tasks.get(&a.task).is_some_and(|t| !t.status.is_final() && st.runs.get(&t.run).is_some_and(|r| !r.closed))
        };
        if let Some(Err(_)) = self.kill_term_checked(&a.task) {
            return;
        }
        if self.health() != Health::Normal {
            return;
        }
        let mut branch_deleted = false;
        let effect = match &a.worktree {
            Some(wt) => {
                let dir = wt.to_string_lossy().into_owned();
                if git::remove_worktree(&a.repo, &dir, true).is_err() {
                    return;
                }
                branch_deleted = a.branch.as_ref().is_some_and(|b| git::delete_branch(&a.repo, b).is_ok());
                Some(
                    Effect::new("spawn_cleanup", "git_worktree_removed").task(&a.task).repo(&a.repo)
                        .expected(json!({ "record": "worktree del intento retirado", "task_removed": removable }))
                        .observed(json!({ "worktree": dir, "worktree_removed": true, "branch": a.branch, "branch_deleted": branch_deleted })),
                )
            }
            None => None,
        };
        let register = |tx: &mut Tx| -> Result<(), String> {
            if removable {
                return tx.remove_failed_launch(&a.task);
            }
            // La Task se conserva (ya era final o su run estaba cerrado): el estado deja de afirmar lo que ya no
            // existe. Worktree y cwd si lo conocía; la rama solo si `branch -d` la borró de verdad (si no, sigue
            // siendo suya). No se marca `merged`: fue un lanzamiento fallido, no una integración; la identidad
            // histórica de la rama queda en `effect.observed`.
            let t = tx.task_mut(&a.task)?;
            if t.worktree.is_some() {
                t.worktree = None;
                t.cwd = a.repo.clone();
            }
            if branch_deleted && t.branch == a.branch {
                t.branch = None;
            }
            Ok(())
        };
        let core = self.acting(MutationContext::core());
        let _ = match effect {
            Some(effect) => core.mutate_after_effect(effect, register),
            None if removable => core.mutate(register),
            None => Ok(()),
        };
    }

    /// Trabajo nuevo para una hija que ya entregó, en su misma terminal: conserva
    /// su contexto (como reutilizar la terminal de un worker en Orca).
    pub(super) fn follow_up(&self, ctx: &MutationContext, caller: &Caller, args: &Value) -> Result<Value, String> {
        let id = s(args, "task");
        let spec = s(args, "spec");
        if spec.is_empty() {
            return Err("Falta --task con el nuevo encargo".into());
        }
        {
            let st = self.lock();
            Self::check_manages(&st, caller, &id)?;
        }
        match self.terms.lock().map(|t| t.get(&id).map(|t| t.kill_in_progress())) {
            Ok(Some(false)) => {}
            Ok(Some(true)) => return Err(format!("La terminal de {id} se está cerrando (terminación en curso): espera a que acabe o lanza una hija nueva con lxo spawn")),
            _ => return Err(format!("La terminal de {id} ya está cerrada: lanza una hija nueva con lxo spawn")),
        }
        let task = self.mutate_as(ctx, |st| {
            st.reopen(&id, &spec)?;
            let t = st.task(&id)?.clone();
            // n = 1 hasta que haya intentos: se borra lo del intento anterior para no
            // recogerlo otra vez (lo que siga en la terminal lo descarta su idem_key).
            // Va dentro de la mutación a propósito: el recolector necesita el estado, y
            // así no ve la tarea reabierta con el informe viejo todavía en disco.
            let _ = delivery::prepare(&t.cwd, &id, delivery::ATTEMPT);
            Ok(t)
        })?;
        let file = Path::new(&task.cwd).join(".lixbon").join("tasks").join(format!("{id}.md"));
        let _ = std::fs::OpenOptions::new().append(true).open(&file).and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "\n## Seguimiento del coordinador\n\n{spec}\n\nAl terminar, escribe un informe nuevo y vuelve a cerrar con lxo done --report (sin red: lxo report).")
        });
        if let Ok(terms) = self.terms.lock() {
            if let Some(t) = terms.get(&id).filter(|t| !t.kill_in_progress()) {
                t.type_prompt(&format!(
                    "Nuevo encargo de tu coordinador (también al final de .lixbon/tasks/{id}.md): {spec} -- Al terminar escribe un informe nuevo y cierra otra vez con lxo done --report."
                ));
            }
        }
        Ok(json!({ "task": id, "status": "running" }))
    }

    /// Copia el informe de la hija junto al coordinador, en `.lixbon/informes/`,
    /// para que lo lea sin entrar en el worktree de nadie.
    pub(super) fn store_report(&self, id: &str, path: &str, inline: &str, summary: &str) -> Result<String, String> {
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

    pub(super) fn launch(self: &Arc<Self>, id: &str) -> Result<(), String> {
        #[cfg(test)]
        return self.fake_launch(id);
        #[allow(unreachable_code)]
        let host = self.host.get().ok_or("Lixbon aún no terminó de arrancar")?.clone();
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
        self.mutate(|st| {
            let t = st.task_mut(id)?;
            t.report_nonce = Some(nonce.clone());
            t.delivered.clear();
            Ok(())
        })?;
        let mut task = task;
        task.report_nonce = Some(nonce.clone());

        // El CLI de Lixbon ya lleva sus reglas de entrega: no se le manda a leer la guía de lxo.
        let prompt = if task.agent == agents::LIXBON_CLI {
            format!("Lee .lixbon/tasks/{id}.md y haz la tarea.")
        } else {
            format!("Eres la tarea {id} del orquestador de Lixbon. Lee .lixbon/tasks/{id}.md, ejecuta lxo guide y haz la tarea.")
        };
        let read_only = task.role.as_deref().and_then(roles::spec).is_some_and(|r| r.read_only);
        // Se lanza exactamente el argv de la política efectiva (la misma que muestra
        // orch_resolve_policy); un perfil bloqueado no arranca.
        let profile = task.profile.clone().unwrap_or_else(|| agents::Profile::for_role(read_only).id().to_string());
        // Toda hija entrega con lxo done; se resuelve con el mismo rol que muestra la UI.
        // Recheck final: lo que dice el entorno justo antes de lanzar también queda como `environment.blocked` / `cleared`.
        let policy = self.resolve_and_observe(&task.agent, &profile, task.role.as_deref(), &task.cwd, task.model.as_deref())?;
        let plan_mode = agents::is_plan(&policy);
        let record = agents::authorize(&policy, task.requested_argv.as_deref(), task.ack_unverified)?;
        // Codex read-only: `codex exec -o`; Claude Explorar/Proponer: stream-json.
        let last_message = (policy.argv.get(1).map(String::as_str) == Some("exec"))
            .then(|| delivery::last_message_path(&task.cwd, id, delivery::ATTEMPT).to_string_lossy().into_owned());
        let stream_json = policy.argv.iter().any(|a| a == "stream-json");
        let launch = agents::launch_task(&policy, task.model.as_deref(), task.effort.as_deref(), &prompt, last_message.as_deref())?;
        task.last_message_path = last_message.clone();
        task.stream_json = stream_json;
        self.mutate(|st| {
            if let Ok(t) = st.task_mut(id) {
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
            Ok(())
        })?;
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
        let agent_token = self.issue_agent_credential(id)?;
        env.push(("LXO_CLIENT_TOKEN".to_string(), agent_token));
        let custody = self.custody_key(id);
        let weak = Arc::downgrade(self);
        let tid = id.to_string();
        let (out_event, exit_event) = (format!("orch:term:{id}"), format!("orch:term-exit:{id}"));
        let host_exit = host.clone();
        // Espera de aprobación en la terminal y agente inactivo (orch/approval.rs).
        let guard = Arc::new(Mutex::new(approval::Guard::from_env(state::now_ms())));
        let (guard_out, weak_out, tid_out) = (guard.clone(), Arc::downgrade(self), id.to_string());
        let term = match pty::spawn(
            pty::Launch { cwd: &task.cwd, script_dir: &dir.join(id), command: launch.command, env, inject: launch.inject, piped: launch.piped, owner: Some(&custody) },
            move |text| {
                let change = guard_out.lock().ok().and_then(|mut g| g.on_output(&text, state::now_ms()));
                if let (Some(change), Some(core)) = (change, weak_out.upgrade()) {
                    core.on_approval_change(&tid_out, change);
                }
                host.emit(&out_event, &Value::String(text));
            },
            move || {
                host_exit.emit(&exit_event, &Value::Null);
                if let Some(core) = weak.upgrade() {
                    core.on_exit(&tid);
                }
            },
        ) {
            Ok(term) => term,
            Err(error) => {
                self.revoke_agent_credentials(id);
                return Err(error);
            }
        };
        // Si no se puede registrar, el proceso se mata antes de devolver el error (un `AgentTerm` suelto no mata).
        if let Err(error) = self.register_term(id, term) {
            self.revoke_agent_credentials(id);
            return Err(error);
        }
        // Sondeo del report.json y de la salida mientras la terminal siga abierta.
        let weak = Arc::downgrade(self);
        let tid = id.to_string();
        let mut model_tries = 0;
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            let Some(core) = weak.upgrade() else { break };
            let Some(text) = core.term_text(&tid) else { break };
            let session_id = codex_session::session_id_from_terminal(&text);
            core.collect(&tid, Some(text), false);
            // Codex deja la TUI abierta tras el informe: el modelo no puede esperar a que se cierre.
            if model_tries < MODEL_TRIES && core.codex_model_pending(&tid) {
                model_tries += 1;
                core.record_codex_model(&tid, session_id.as_deref());
            }
            let timeout = guard.lock().ok().and_then(|g| g.check(state::now_ms()));
            if let Some(t) = timeout {
                core.on_guard_timeout(&tid, t);
                break;
            }
        });
        Ok(())
    }
}
