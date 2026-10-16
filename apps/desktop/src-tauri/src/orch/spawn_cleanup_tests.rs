//! Pruebas del cleanup de `create_child` (slice E, E1b, Effects · cleanup): cada punto de fallo de un
//! lanzamiento deja el mundo (Task, worktree, rama, proceso) y el Event Log exactamente como el mapa dice.
//!
//! Se ejecutan sobre un Core REAL con SQLite autoritativa y un repositorio git real; el lanzamiento usa el
//! `fake_launch` de las pruebas y el gancho `Core::spawn_hook` para fallar en cada punto.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

use portable_pty::ChildKiller;
use serde_json::{json, Value};

use super::boot_tests::*;
use super::event_kinds::EffectObserved;
use super::events::{Channel, MutationContext};
use super::host::{RecordedCall, RecordingHost};
use super::mutation::Health;
use super::pty::{self, pruebas};
use super::spawn::{SpawnAttempt, SpawnStep};
use super::spawn_approval::{PendState, EV_PENDING, EV_RESOLVED};
use super::state::{NewTask, State, Status};
use super::{agents, Caller, Core, Orch};
use crate::store::{EventQuery, EventRow};

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

/// Punto de sincronización de dos participantes con límite: una regresión o fallo previo produce un error legible
/// en lugar de dejar bloqueado el proceso de pruebas.
struct TimedBarrier {
    state: Mutex<(usize, bool)>,
    changed: Condvar,
}

impl TimedBarrier {
    fn new() -> Self {
        Self { state: Mutex::new((0, false)), changed: Condvar::new() }
    }

    fn wait(&self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.1 {
            return Ok(());
        }
        state.0 += 1;
        if state.0 == 2 {
            state.1 = true;
            self.changed.notify_all();
            return Ok(());
        }
        let (state, _) = self
            .changed
            .wait_timeout_while(state, Duration::from_secs(5), |state| !state.1)
            .unwrap_or_else(|e| e.into_inner());
        if state.1 {
            Ok(())
        } else {
            Err(format!("punto de sincronización venció con {} de 2 participantes", state.0))
        }
    }
}

fn fake(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> agents::Policy {
    let prof = agents::Profile::parse(profile).expect("perfil");
    agents::evaluate_for(provider, prof, role, worktree, agents::Detected::Skip, false, agents::Delivery::FileOrMarkers)
}

pub(super) fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

pub(super) fn g(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

pub(super) struct Env {
    pub(super) _l: Limpia,
    pub(super) core: Arc<Core>,
    pub(super) root: String,
    pub(super) run: String,
    pub(super) project: String,
    pub(super) repo: PathBuf,
    pub(super) host: Arc<RecordingHost>,
}

pub(super) fn setup(nombre: &str) -> Env {
    let (l, data, core_dir) = dirs();
    let repo = data.parent().unwrap().join("repos").join(nombre);
    std::fs::create_dir_all(&repo).unwrap();
    for a in [&["init", "-q", "-b", "master"][..], &["config", "user.name", "t"], &["config", "user.email", "t@t"], &["config", "core.autocrlf", "false"]] {
        g(&repo, a);
    }
    std::fs::write(repo.join("a.txt"), "base\n").unwrap();
    g(&repo, &["add", "."]);
    g(&repo, &["commit", "-qm", "base"]);
    let mut orch = Orch::default();
    Arc::get_mut(&mut orch.0).unwrap().resolver = fake;
    let core = orch.0;
    let host = RecordingHost::new();
    core.init_in(host.clone(), &data, &core_dir).unwrap();
    core.settings.lock().unwrap().enabled = true;
    let project = core.project_add(&MutationContext::person(Channel::Ui), &json!({ "path": s(&repo) })).unwrap()["project"]["id"].as_str().unwrap().to_string();
    let cwd = s(&repo);
    let (run, root) = core
        .mutate(|tx| {
            let (run, root) = tx.create_run("obj", NewTask {
                agent: "coordinador".into(), model: None, effort: None, role: None, title: "obj".into(), spec: "obj".into(),
                repo: cwd.clone(), cwd: cwd.clone(), branch: Some("master".into()), base: None, worktree: None, external: true,
            });
            tx.mark_running(&root)?;
            tx.task_mut(&root)?.project_id = Some(project.clone());
            Ok((run, root))
        })
        .unwrap();
    Env { _l: l, core, root, run, project, repo, host }
}

impl Env {
    pub(super) fn spawn(&self, shared: bool) -> String {
        let v = self
            .core
            .rpc(Caller::Agent(Some(self.root.clone())), "", "spawn", &json!({ "agent": "claude", "task": "Encargo\nDetalle", "name": "Hija", "shared": shared }))
            .unwrap();
        v["pending_id"].as_str().unwrap().to_string()
    }

    pub(super) fn aprobar(&self, pid: &str) -> Value {
        let argv = self.core.list_pending_spawns().into_iter().find(|p| p.pending_id == pid).unwrap().policy.argv;
        self.core.approve_spawn(pid, true, &argv, true).unwrap()
    }

    /// Como `aprobar`, pero devuelve el `Result` (con el Core degradado la resolución no se puede registrar).
    pub(super) fn aprobar_res(&self, pid: &str) -> Result<Value, String> {
        let argv = self.core.list_pending_spawns().into_iter().find(|p| p.pending_id == pid).unwrap().policy.argv;
        self.core.approve_spawn(pid, true, &argv, true)
    }

    pub(super) fn estado_pendiente(&self, pid: &str) -> Option<PendState> {
        self.core.pending.lock().unwrap().get(pid).map(|e| e.state.clone())
    }

    pub(super) fn hijas(&self) -> Vec<String> {
        self.core.lock().tasks.values().filter(|t| t.parent.as_deref() == Some(self.root.as_str())).map(|t| t.id.clone()).collect()
    }

    pub(super) fn hook(&self, f: impl Fn(&Core, &str, SpawnStep) -> Result<(), String> + Send + Sync + 'static) {
        *self.core.spawn_hook.lock().unwrap() = Some(Arc::new(f));
    }

    pub(super) fn ramas(&self) -> String {
        g(&self.repo, &["branch", "--list", "lx/*"])
    }
}

pub(super) fn head(core: &Core) -> i64 {
    core.storage.with_store(|s| s.events_head().unwrap()).unwrap()
}

pub(super) fn desde(core: &Core, seq: i64) -> Vec<EventRow> {
    core.storage.with_store(|s| s.events_page(&EventQuery { after: Some(seq), limit: Some(500), ..Default::default() }).unwrap().events).unwrap()
}

/// Como `kinds`, sin el `spawn.resolved` con el que termina cada aprobación: estas pruebas son del cleanup.
fn kinds_sin_resolucion(evs: &[EventRow]) -> Vec<&str> {
    kinds(evs).into_iter().filter(|k| *k != "spawn.resolved").collect()
}

pub(super) fn kinds(evs: &[EventRow]) -> Vec<&str> {
    evs.iter().map(|e| e.kind.as_str()).collect()
}

pub(super) fn pl(e: &EventRow) -> Value {
    serde_json::from_str(&e.payload).unwrap()
}

fn actor(e: &EventRow) -> (&str, Option<&str>) {
    (e.actor_kind.as_str(), e.channel.as_deref())
}

fn diario() -> Vec<Value> {
    std::fs::read_to_string(super::fsio::data_dir().join("unrecorded-effects.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn kinds_del_diario() -> Vec<String> {
    diario().iter().map(|l| l["kind"].as_str().unwrap_or_default().to_string()).collect()
}

fn terminales(core: &Core) -> usize {
    core.terms.lock().unwrap().len()
}

/// Deja un proceso real de larga duración registrado como terminal de `id` y devuelve su pid.
fn registra_proceso(core: &Core, id: &str, pid_out: &Arc<Mutex<Option<u32>>>) {
    let dir = pruebas::carpeta(&format!("proc-{id}"));
    let term = pruebas::lanza(&dir, false).expect("lanzamiento real");
    *pid_out.lock().unwrap() = pruebas::ultimo_pid();
    core.register_term(id, term).unwrap();
}

// ---------------------------------------------------------------------------------------------
// Caso 1 · add_worktree falla: la ruta ajena no se toca
// ---------------------------------------------------------------------------------------------

#[test]
fn add_worktree_que_falla_no_toca_una_ruta_ajena_y_retira_la_task_con_run_y_proyecto() {
    let e = setup("c1");
    let pid = e.spawn(false);
    let ajena = PathBuf::from(&e.core.list_pending_spawns()[0].cwd);
    std::fs::create_dir_all(&ajena).unwrap();
    std::fs::write(ajena.join("ajeno.txt"), "mío").unwrap();
    let antes = head(&e.core);
    let out = e.aprobar(&pid);
    assert_eq!(out["outcome"], "launch_failed");
    assert_eq!(std::fs::read_to_string(ajena.join("ajeno.txt")).unwrap(), "mío", "una ruta que add_worktree no creó nunca se borra");
    assert!(e.hijas().is_empty(), "la Task retirada ya no está en el estado");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created", "task.removed"], "sin worktree no hay effect.observed");
    let quitada = &evs[1];
    assert_eq!(pl(quitada), json!({ "cause": "launch_failed" }));
    assert_eq!(actor(quitada), ("system", Some("core")), "lo decide el Core aunque la persona aprobara el lanzamiento");
    assert_eq!((quitada.run_id.as_deref(), quitada.project_id.as_deref()), (Some(e.run.as_str()), Some(e.project.as_str())), "sobreviven a borrar la Task");
    assert_eq!((quitada.entity_kind.as_str(), quitada.entity_id.as_str()), ("task", evs[0].entity_id.as_str()));
    assert!(diario().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Casos 2 · worktree registrado y ensure_launchable falla (run cerrado / Task final): se conserva la Task
// ---------------------------------------------------------------------------------------------

#[test]
fn worktree_registrado_con_el_run_cerrado_conserva_la_task_y_limpia_solo_los_artefactos() {
    let e = setup("c2a");
    let pid = e.spawn(false);
    let run = e.run.clone();
    e.hook(move |core, _id, step| {
        if step == SpawnStep::AfterWorktreeRegistered {
            core.mutate(|tx| {
                tx.runs.get_mut(&run).unwrap().closed = true;
                Ok(())
            })
            .unwrap();
        }
        Ok(())
    });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created", "effect.observed", "effect.observed"], "ni task.removed: el run ya estaba cerrado");
    let hija = e.hijas().pop().expect("la Task se conserva");
    let limpieza = &evs[2];
    assert_eq!(pl(limpieza)["effect_kind"], "git_worktree_removed");
    assert_eq!(pl(limpieza)["operation"], "spawn_cleanup");
    assert_eq!((pl(limpieza)["worktree_removed"].as_bool(), pl(limpieza)["branch_deleted"].as_bool()), (Some(true), Some(true)));
    assert_eq!(actor(limpieza), ("system", Some("core")));
    assert_eq!(actor(&evs[1]), ("person", Some("ui")), "el efecto original lo observó la persona que aprobó");
    let t = e.core.lock().tasks.get(&hija).cloned().unwrap();
    assert!(t.worktree.is_none(), "el estado ya no cree en un worktree que no existe");
    assert!(e.ramas().is_empty(), "la rama del intento se borró con -d");
}

#[test]
fn una_task_ya_final_antes_del_cleanup_se_conserva() {
    let e = setup("c2b");
    let pid = e.spawn(false);
    e.hook(|core, id, step| {
        if step == SpawnStep::AfterWorktreeRegistered {
            core.mutate(|tx| tx.close(id, Status::Stopped, "cerrada por otra acción").map(|_| ())).unwrap();
        }
        Ok(())
    });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created", "effect.observed", "task.status_changed", "effect.observed"]);
    assert!(!kinds_sin_resolucion(&evs).contains(&"task.removed"));
    assert_eq!(e.hijas().len(), 1);
    let hija = e.hijas()[0].clone();
    let t = e.core.lock().tasks.get(&hija).cloned().unwrap();
    assert_eq!(t.status, Status::Stopped);
    // El worktree y la rama (borrada con -d) ya no existen: el estado deja de afirmarlo. No es una integración.
    assert_eq!((t.worktree.as_deref(), t.branch.as_deref(), t.merged), (None, None, false));
    assert_eq!(t.cwd, s(&e.repo));
    assert!(e.ramas().is_empty());
}

#[test]
fn una_task_preservada_cuya_rama_no_se_pudo_borrar_conserva_su_rama() {
    let e = setup("c2c");
    let pid = e.spawn(false);
    let run = e.run.clone();
    e.hook(move |core, id, step| {
        if step == SpawnStep::AfterWorktreeRegistered {
            // La rama gana un commit propio (branch -d la rechazará) y el run se cierra.
            let wt = core.lock().tasks.get(id).and_then(|t| t.worktree.clone()).unwrap();
            std::fs::write(Path::new(&wt).join("trabajo.txt"), "trabajo\n").unwrap();
            g(Path::new(&wt), &["add", "."]);
            g(Path::new(&wt), &["commit", "-qm", "trabajo"]);
            core.mutate(|tx| {
                tx.runs.get_mut(&run).unwrap().closed = true;
                Ok(())
            })
            .unwrap();
        }
        Ok(())
    });
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    let hija = e.hijas()[0].clone();
    let t = e.core.lock().tasks.get(&hija).cloned().unwrap();
    assert_eq!((t.worktree.as_deref(), t.merged), (None, false), "el worktree ya no existe y no se marca merged");
    assert!(t.branch.as_deref().is_some_and(|b| b.starts_with("lx/")), "la rama sigue existiendo: la Task sigue conociéndola");
    assert!(e.ramas().contains("lx/"));
}

// ---------------------------------------------------------------------------------------------
// Casos 3 y 8 · el worktree existe pero su registro falla
// ---------------------------------------------------------------------------------------------

#[test]
fn worktree_fisico_con_registro_rechazado_y_core_sano_se_limpia_sin_depender_del_estado() {
    let e = setup("c3");
    let pid = e.spawn(false);
    e.hook(|_core, _id, step| if step == SpawnStep::InWorktreeRegistration { Err("rechazo inyectado".into()) } else { Ok(()) });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    // State nunca llegó a conocer el worktree: el cleanup usó los datos del intento.
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created", "effect.observed", "task.removed"]);
    assert_eq!(pl(&evs[1])["operation"], "spawn_cleanup");
    assert_eq!(pl(&evs[1])["worktree_removed"], true);
    assert_eq!((actor(&evs[1]), actor(&evs[2])), (("system", Some("core")), ("system", Some("core"))));
    assert!(e.hijas().is_empty());
    assert!(e.ramas().is_empty());
    assert_eq!(kinds_del_diario(), vec!["git_worktree"], "el registro rechazado queda en el diario; el cleanup se registró bien");
}

#[test]
fn worktree_fisico_con_el_core_degradado_se_conserva_todo() {
    let e = setup("c3b");
    let pid = e.spawn(false);
    e.hook(|core, _id, step| {
        if step == SpawnStep::AfterAddWorktree {
            core.degrade_for_tests("fallo de almacenamiento inyectado");
        }
        Ok(())
    });
    let antes = head(&e.core);
    let r = e.aprobar_res(&pid);
    assert!(r.as_ref().is_err_and(|m| m.contains("no se pudo registrar su resolución")), "{r:?}");
    assert_eq!(e.estado_pendiente(&pid), Some(PendState::Launching), "no vuelve a Pending ni admite otra aprobación");
    assert!(matches!(e.core.health(), Health::DegradedReadOnly(_)));
    assert_eq!(e.hijas().len(), 1, "no se borra la Task con el Core degradado");
    assert!(e.ramas().contains("lx/"), "ni la rama");
    assert!(g(&e.repo, &["worktree", "list"]).lines().count() > 1, "ni el worktree");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created"], "nada más se persiste");
    assert!(kinds_del_diario().contains(&"git_worktree".to_string()), "el worktree físico queda en el diario para reconciliar: {:?}", diario());
}

// ---------------------------------------------------------------------------------------------
// Caso 4 · launch falla antes de arrancar un proceso (orden, actor, run/proyecto)
// ---------------------------------------------------------------------------------------------

#[test]
fn launch_que_falla_antes_del_proceso_limpia_y_retira_con_orden_actor_y_pertenencia() {
    let e = setup("c4");
    let pid = e.spawn(false);
    e.hook(|_core, _id, step| if step == SpawnStep::InLaunch { Err("launch inyectado".into()) } else { Ok(()) });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created", "effect.observed", "effect.observed", "task.removed"], "effect.observed del cleanup antes que task.removed");
    let (limpieza, quitada) = (&evs[2], &evs[3]);
    assert_eq!((actor(limpieza), actor(quitada)), (("system", Some("core")), ("system", Some("core"))));
    for ev in [&evs[1], limpieza, quitada] {
        assert_eq!((ev.run_id.as_deref(), ev.project_id.as_deref()), (Some(e.run.as_str()), Some(e.project.as_str())), "{}", ev.kind);
    }
    assert_eq!(pl(limpieza)["branch_deleted"], true);
    assert_eq!(limpieza.correlation_id, limpieza.idem_key, "el cleanup también lleva su effect_id");
    assert!(e.hijas().is_empty() && e.ramas().is_empty());
    assert!(diario().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Casos 6 y 8 · launch Ok pero el registro de pty_process falla: hay un proceso vivo
// ---------------------------------------------------------------------------------------------

#[test]
fn pty_process_rechazado_con_el_core_sano_mata_el_proceso_y_limpia() {
    let e = setup("c6a");
    let pid = e.spawn(false);
    let proceso = Arc::new(Mutex::new(None));
    let p2 = proceso.clone();
    e.hook(move |core, id, step| {
        match step {
            SpawnStep::InLaunch => registra_proceso(core, id, &p2),
            SpawnStep::InPtyRegistration => return Err("rechazo inyectado".into()),
            _ => {}
        }
        Ok(())
    });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    let pid_proceso = proceso.lock().unwrap().expect("se lanzó un proceso real");
    assert!(pruebas::espera_muerto(pid_proceso), "el proceso vivo y no registrado se mata");
    assert_eq!(terminales(&e.core), 0, "y se retira del mapa");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created", "effect.observed", "effect.observed", "task.removed"], "el kill no tiene evento propio");
    assert!(evs.iter().all(|ev| pl(ev).get("launched").is_none()), "pty_process no se registró: no hay evento de proceso");
    assert!(e.hijas().is_empty() && e.ramas().is_empty());
    assert_eq!(kinds_del_diario(), vec!["pty_process"]);
}

#[test]
fn pty_process_con_el_core_degradado_mata_el_proceso_pero_conserva_task_y_worktree() {
    let e = setup("c6b");
    let pid = e.spawn(false);
    let proceso = Arc::new(Mutex::new(None));
    let p2 = proceso.clone();
    e.hook(move |core, id, step| {
        match step {
            SpawnStep::InLaunch => registra_proceso(core, id, &p2),
            SpawnStep::AfterLaunch => core.degrade_for_tests("fallo de almacenamiento inyectado"),
            _ => {}
        }
        Ok(())
    });
    let antes = head(&e.core);
    let r = e.aprobar_res(&pid);
    assert!(r.as_ref().is_err_and(|m| m.contains("no se pudo registrar su resolución")), "{r:?}");
    assert_eq!(e.estado_pendiente(&pid), Some(PendState::Launching), "no vuelve a Pending ni admite otra aprobación");
    let pid_proceso = proceso.lock().unwrap().expect("proceso real");
    assert!(pruebas::espera_muerto(pid_proceso), "la única acción destructiva con el Core degradado: matar el proceso no registrado");
    assert_eq!(terminales(&e.core), 0);
    assert_eq!(e.hijas().len(), 1, "la Task se conserva");
    assert!(e.ramas().contains("lx/"), "y su rama y su worktree");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created", "effect.observed"], "solo lo ya confirmado");
    assert!(kinds_del_diario().contains(&"pty_process".to_string()));
}

/// Un matador que siempre falla: no hay control fiable sobre el proceso.
#[derive(Debug)]
pub(super) struct MatadorRoto;

impl ChildKiller for MatadorRoto {
    fn kill(&mut self) -> std::io::Result<()> {
        Err(std::io::Error::other("no se puede matar"))
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(MatadorRoto)
    }
}

#[test]
fn si_no_hay_control_fiable_sobre_el_proceso_se_conserva_todo() {
    let e = setup("c6c");
    let pid = e.spawn(false);
    e.hook(|core, id, step| {
        match step {
            SpawnStep::InLaunch => core.register_term(id, pty::AgentTerm::for_tests(Box::new(MatadorRoto))).unwrap(),
            SpawnStep::InPtyRegistration => return Err("rechazo inyectado".into()),
            _ => {}
        }
        Ok(())
    });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    assert_eq!(e.hijas().len(), 1, "sin control sobre el proceso no se retira la Task");
    assert!(e.ramas().contains("lx/"), "ni se borra su worktree");
    assert_eq!(terminales(&e.core), 1, "el terminal vuelve al mapa para poder reintentar el kill");
    assert_eq!(kinds_sin_resolucion(&desde(&e.core, antes)), vec!["task.created", "effect.observed"]);
    e.core.terms.lock().unwrap().clear();
}

// ---------------------------------------------------------------------------------------------
// Caso 7 · hija shared
// ---------------------------------------------------------------------------------------------

#[test]
fn una_hija_shared_que_falla_al_lanzar_solo_retira_la_task_sin_efecto_git() {
    let e = setup("c7");
    let pid = e.spawn(true);
    e.hook(|_core, _id, step| if step == SpawnStep::InLaunch { Err("launch inyectado".into()) } else { Ok(()) });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created", "task.removed"]);
    assert_eq!(actor(&evs[1]), ("system", Some("core")));
    assert!(e.hijas().is_empty() && e.ramas().is_empty());
}

// ---------------------------------------------------------------------------------------------
// remove_worktree falla / branch -d falla
// ---------------------------------------------------------------------------------------------

#[test]
fn si_remove_worktree_falla_se_conserva_la_task() {
    let e = setup("c8a");
    let pid = e.spawn(false);
    let repo = e.repo.clone();
    e.hook(move |core, id, step| {
        if step == SpawnStep::InLaunch {
            // Un worktree bloqueado no se puede retirar con un solo --force.
            let wt = core.lock().tasks.get(id).and_then(|t| t.worktree.clone()).unwrap();
            g(&repo, &["worktree", "lock", &wt]);
            return Err("launch inyectado".into());
        }
        Ok(())
    });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    assert_eq!(e.hijas().len(), 1, "el worktree no se pudo quitar: la Task se conserva");
    let hija = e.hijas()[0].clone();
    let wt = e.core.lock().tasks.get(&hija).and_then(|t| t.worktree.clone()).unwrap();
    assert!(Path::new(&wt).exists());
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created", "effect.observed"], "ni cleanup registrado ni task.removed");
    g(&e.repo, &["worktree", "unlock", &wt]);
}

#[test]
fn si_branch_d_falla_la_task_se_retira_con_branch_deleted_false_y_nunca_se_usa_d_mayuscula() {
    let e = setup("c8b");
    let pid = e.spawn(false);
    e.hook(|core, id, step| {
        if step == SpawnStep::InLaunch {
            // La rama gana un commit propio: `branch -d` la rechaza (no está fusionada); `-D` la habría borrado.
            let wt = core.lock().tasks.get(id).and_then(|t| t.worktree.clone()).unwrap();
            std::fs::write(Path::new(&wt).join("trabajo.txt"), "trabajo del agente\n").unwrap();
            g(Path::new(&wt), &["add", "."]);
            g(Path::new(&wt), &["commit", "-qm", "trabajo"]);
            return Err("launch inyectado".into());
        }
        Ok(())
    });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.created", "effect.observed", "effect.observed", "task.removed"]);
    assert_eq!((pl(&evs[2])["worktree_removed"].as_bool(), pl(&evs[2])["branch_deleted"].as_bool()), (Some(true), Some(false)));
    assert!(e.ramas().contains("lx/"), "la rama con trabajo sobrevive: nunca branch -D");
    assert!(e.hijas().is_empty(), "un fallo de branch -d no impide retirar la Task");
}

// ---------------------------------------------------------------------------------------------
// register_term / kill_term_checked
// ---------------------------------------------------------------------------------------------

#[test]
fn si_no_se_puede_registrar_el_terminal_el_proceso_se_mata() {
    let core = Orch::default().0;
    let dir = pruebas::carpeta("reg-ok");
    let term = pruebas::lanza(&dir, false).unwrap();
    let pid = pruebas::ultimo_pid().unwrap();
    // Registro normal y kill comprobado.
    core.register_term("t1", term).unwrap();
    assert!(pruebas::vivo(pid));
    assert!(matches!(core.kill_term_checked("t1"), Some(Ok(()))));
    assert!(pruebas::espera_muerto(pid));
    assert!(core.kill_term_checked("t1").is_none(), "ya no hay terminal");
    // Mapa corrupto (lock envenenado): register_term mata el proceso antes de devolver el error.
    let dir2 = pruebas::carpeta("reg-veneno");
    // Canalizado: sin master PTY que se cierre al soltarlo, solo el kill explícito puede acabar con el proceso.
    let term2 = pruebas::lanza(&dir2, true).unwrap();
    let pid2 = pruebas::ultimo_pid().unwrap();
    let c2 = core.clone();
    let _ = std::thread::spawn(move || {
        let _g = c2.terms.lock().unwrap();
        panic!("envenenar el mapa de terminales");
    })
    .join();
    let r = core.register_term("t2", term2);
    assert!(r.is_err());
    assert!(pruebas::espera_muerto(pid2), "el proceso no puede quedar vivo y sin dueño si falla el registro");
    let _ = (std::fs::remove_dir_all(dir), std::fs::remove_dir_all(dir2));
}

/// Falla las primeras `n` veces y después mata bien.
#[derive(Debug)]
struct MatadorIntermitente(Arc<std::sync::atomic::AtomicUsize>);

impl ChildKiller for MatadorIntermitente {
    fn kill(&mut self) -> std::io::Result<()> {
        use std::sync::atomic::Ordering;
        if self.0.load(Ordering::SeqCst) > 0 {
            self.0.fetch_sub(1, Ordering::SeqCst);
            return Err(std::io::Error::other("no se puede matar (aún)"));
        }
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(MatadorIntermitente(self.0.clone()))
    }
}

fn envenena_el_mapa(core: &Arc<Core>) {
    let c2 = core.clone();
    let _ = std::thread::spawn(move || {
        let _g = c2.terms.lock().unwrap();
        panic!("envenenar el mapa de terminales");
    })
    .join();
}

fn custodiado(core: &Core, id: &str) -> bool {
    core.terms.lock().unwrap_or_else(|e| e.into_inner()).contains_key(id)
}

#[test]
fn registro_imposible_y_kill_imposible_dejan_el_terminal_bajo_la_custodia_del_core() {
    // Un matador que NUNCA funciona: con el mapa envenenado el terminal no se pierde ni se suelta.
    let core = Orch::default().0;
    envenena_el_mapa(&core);
    let r = core.register_term("t1", pty::AgentTerm::for_tests(Box::new(MatadorRoto)));
    assert!(matches!(&r, Err(m) if m.contains("custodia")), "{r:?}");
    assert!(custodiado(&core, "t1"), "registro imposible + kill imposible: el proceso sigue bajo el Core");
    for _ in 0..2 {
        assert!(matches!(core.kill_term_checked("t1"), Some(Err(_))));
        assert!(custodiado(&core, "t1"), "tras volver a fallar sigue almacenado");
    }

    // Un matador que falla dos veces y luego funciona: el terminal se recupera del mapa envenenado y se mata.
    let fallos = Arc::new(std::sync::atomic::AtomicUsize::new(2));
    let r = core.register_term("t2", pty::AgentTerm::for_tests(Box::new(MatadorIntermitente(fallos.clone()))));
    assert!(r.is_err() && custodiado(&core, "t2"), "el primer fallo es el del registro");
    assert!(matches!(core.kill_term_checked("t2"), Some(Err(_))), "el segundo fallo");
    assert!(custodiado(&core, "t2"));
    assert!(matches!(core.kill_term_checked("t2"), Some(Ok(()))), "ahora sí se recupera y se mata");
    assert!(!custodiado(&core, "t2"));
    assert!(core.kill_term_checked("t2").is_none());
    core.terms.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

// ---------------------------------------------------------------------------------------------
// Custodia de un proceso cuya construcción falló (LXO-18 P1-1): el cleanup la resuelve ANTES de borrar nada
// ---------------------------------------------------------------------------------------------

/// Lanza de verdad un proceso canalizado cuya construcción falla justo después de crearse (el equivalente de que
/// `take_writer` o una tubería devuelvan `Err`) y devuelve ese `Err`. Si los matadores funcionan, el proceso muere
/// ahí; si no, queda en la custodia de `pty` a nombre de `id`, sin ningún terminal en el mapa del Core.
fn pierde_el_proceso_al_construir(core: &Core, id: &str, pid_out: &Arc<Mutex<Option<u32>>>) -> String {
    let dir = pruebas::carpeta(&format!("custodia-{id}"));
    let dueno = core.custody_key(id);
    let r = pruebas::con_fallo_tras_crear(|| pruebas::lanza_para(&dir, true, Some(&dueno)));
    *pid_out.lock().unwrap() = pruebas::ultimo_pid();
    r.err().expect("la construcción falla tras crear el proceso")
}

#[test]
fn un_proceso_en_custodia_que_no_se_puede_matar_conserva_task_worktree_y_rama() {
    let _serie = pruebas::serie_custodia();
    let e = setup("c9a");
    let pend = e.spawn(false);
    let proceso = Arc::new(Mutex::new(None));
    let p2 = proceso.clone();
    e.hook(move |core, id, step| {
        if step == SpawnStep::InLaunch {
            return Err(pierde_el_proceso_al_construir(core, id, &p2));
        }
        Ok(())
    });
    let antes = head(&e.core);
    // Ningún matador funciona: ni al construir ni al reintentar la custodia durante el cleanup.
    let out = pruebas::con_matadores_rotos(|| e.aprobar(&pend));
    assert_eq!(out["outcome"], "launch_failed");
    let pid = proceso.lock().unwrap().expect("el proceso llegó a crearse");
    let hija = e.hijas().pop().expect("sin control sobre el proceso no se retira la Task");
    assert!(pruebas::vivo(pid), "el proceso sigue vivo: nadie pudo confirmar su muerte");
    assert!(pty::in_custody(&e.core.custody_key(&hija)), "y sigue bajo la custodia, a nombre de su tarea");
    assert!(e.core.has_term(&hija), "el Core lo ve como un proceso suyo aunque no haya terminal");
    let wt = e.core.lock().tasks.get(&hija).and_then(|t| t.worktree.clone()).expect("el estado conserva el worktree");
    assert!(Path::new(&wt).exists(), "el worktree sigue en disco");
    assert!(e.ramas().contains("lx/"), "y su rama (nunca branch -D)");
    assert_eq!(kinds_sin_resolucion(&desde(&e.core, antes)), vec!["task.created", "effect.observed"], "ni cleanup registrado ni task.removed");

    // Mientras no haya control fiable, ni liberar ni detener ni liberar worktrees tocan nada.
    pruebas::con_matadores_rotos(|| {
        let ctx = MutationContext::person(Channel::Ui);
        assert!(e.core.rpc(Caller::User, "", "release", &json!({ "task": hija, "force": true })).is_err());
        assert!(e.core.rpc(Caller::User, "", "stop", &json!({ "task": hija })).is_err());
        let (liberadas, conservadas) = e.core.free_worktrees(&ctx, &e.run, true);
        assert!(liberadas.is_empty() && conservadas.iter().any(|k| k["task"] == hija.as_str()), "{liberadas:?} {conservadas:?}");
    });
    assert!(Path::new(&wt).exists() && e.ramas().contains("lx/") && pruebas::vivo(pid));
    assert_ne!(e.core.lock().tasks.get(&hija).map(|t| t.status.clone()), Some(Status::Stopped), "no se declara detenida");

    // Recuperado el control, liberar la tarea mata el proceso y SOLO entonces borra el worktree.
    e.core.rpc(Caller::User, "", "release", &json!({ "task": hija, "force": true })).expect("con control, se libera");
    assert!(pruebas::espera_muerto(pid), "el reintento de la custodia lo mató");
    assert!(!pty::in_custody(&e.core.custody_key(&hija)) && !e.core.has_term(&hija));
    assert!(!Path::new(&wt).exists(), "el worktree se borró después de confirmar la muerte");
    assert!(e.ramas().contains("lx/"), "la rama sin fusionar sigue ahí: nunca branch -D");
}

#[test]
fn un_proceso_en_custodia_que_se_mata_al_reintentar_permite_el_cleanup_completo() {
    let _serie = pruebas::serie_custodia();
    let e = setup("c9b");
    let pend = e.spawn(false);
    let proceso = Arc::new(Mutex::new(None));
    let p2 = proceso.clone();
    e.hook(move |core, id, step| {
        if step == SpawnStep::InLaunch {
            // Los matadores fallan SOLO al construir: el proceso queda en custodia y el cleanup sí puede matarlo.
            return Err(pruebas::con_matadores_rotos(|| pierde_el_proceso_al_construir(core, id, &p2)));
        }
        Ok(())
    });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pend)["outcome"], "launch_failed");
    let pid = proceso.lock().unwrap().expect("el proceso llegó a crearse");
    assert!(pruebas::espera_muerto(pid), "el cleanup resolvió la custodia matando el proceso");
    assert_eq!(kinds_sin_resolucion(&desde(&e.core, antes)), vec!["task.created", "effect.observed", "effect.observed", "task.removed"]);
    assert!(e.hijas().is_empty() && e.ramas().is_empty());
}

// ---------------------------------------------------------------------------------------------
// kill_term_checked sin «quitar y reinsertar» (LXO-18 P1-2): una terminación en curso sigue siendo del Core
// ---------------------------------------------------------------------------------------------

/// Un `kill` del proceso que el test gobierna: espera en dos barreras (entra y sale) y devuelve el resultado programado.
struct PasoKill {
    entrada: Arc<TimedBarrier>,
    salida: Arc<TimedBarrier>,
    ok: bool,
}

type Pasos = Arc<Mutex<std::collections::VecDeque<PasoKill>>>;

struct MatadorGuiado(Pasos);

impl std::fmt::Debug for MatadorGuiado {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MatadorGuiado")
    }
}

impl ChildKiller for MatadorGuiado {
    fn kill(&mut self) -> std::io::Result<()> {
        let Some(paso) = self.0.lock().unwrap().pop_front() else { return Err(std::io::Error::other("kill no programado")) };
        paso.entrada.wait().map_err(std::io::Error::other)?;
        paso.salida.wait().map_err(std::io::Error::other)?;
        if paso.ok { Ok(()) } else { Err(std::io::Error::other("kill fallido programado")) }
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(MatadorGuiado(self.0.clone()))
    }
}

/// Programa un `kill` y devuelve sus dos barreras: `entrada` (el matador ya está corriendo) y `salida` (déjalo terminar).
fn programa(pasos: &Pasos, ok: bool) -> (Arc<TimedBarrier>, Arc<TimedBarrier>) {
    let (entrada, salida) = (Arc::new(TimedBarrier::new()), Arc::new(TimedBarrier::new()));
    pasos.lock().unwrap().push_back(PasoKill { entrada: entrada.clone(), salida: salida.clone(), ok });
    (entrada, salida)
}

#[test]
fn un_kill_en_curso_sigue_siendo_del_core_y_ningun_otro_llamante_lo_toma_por_muerto() {
    let e = setup("race-kill");
    let pend = e.spawn(false);
    assert_eq!(e.aprobar(&pend)["outcome"], "approved");
    let hija = e.hijas().pop().expect("hija lanzada");
    let wt = e.core.lock().tasks.get(&hija).and_then(|t| t.worktree.clone()).expect("worktree de la hija");

    let pasos: Pasos = Arc::default();
    let (entra1, sale1) = programa(&pasos, false);
    let (entra2, sale2) = programa(&pasos, true);
    e.core.register_term(&hija, pty::AgentTerm::for_tests(Box::new(MatadorGuiado(pasos)))).unwrap();

    // Lo que ningún otro llamante puede hacer mientras `kill_term` está DENTRO del matador.
    let durante_el_kill = || {
        let ctx = MutationContext::person(Channel::Ui);
        assert!(e.core.terms.try_lock().is_ok(), "el mapa de terminales no se bloquea mientras corre el matador");
        assert!(e.core.has_term(&hija), "el terminal no desaparece del mapa: no es «sin terminal»");
        assert!(e.core.terms.lock().unwrap().get(&hija).is_some_and(|t| t.kill_in_progress()), "y consta como terminación en curso");
        assert!(e.core.term_text(&hija).is_some(), "el sondeo de salida no ve el terminal desaparecer y no termina");
        assert!(matches!(e.core.kill_term_checked(&hija), Some(Err(m)) if m.contains("en curso")), "ni «no hay terminal» ni éxito");
        assert!(e.core.kill_term(&hija).is_err());
        assert!(e.core.rpc(Caller::User, "", "stop", &json!({ "task": hija })).is_err(), "no se declara detenida");
        assert!(e.core.rpc(Caller::User, "", "release", &json!({ "task": hija, "force": true })).is_err(), "ni se libera");
        let (liberadas, conservadas) = e.core.free_worktrees(&ctx, &e.run, true);
        assert!(liberadas.is_empty() && conservadas.iter().any(|k| k["task"] == hija.as_str()), "{liberadas:?} {conservadas:?}");
        assert!(Path::new(&wt).exists() && e.ramas().contains("lx/"), "worktree y rama intactos");
        assert_ne!(e.core.lock().tasks.get(&hija).map(|t| t.status.clone()), Some(Status::Stopped));
    };

    // Primer intento: el kill falla mientras los demás miran.
    let (core, id) = (e.core.clone(), hija.clone());
    let a = std::thread::spawn(move || core.kill_term(&id));
    entra1.wait().expect("kill_term entró en el matador");
    durante_el_kill();
    sale1.wait().expect("liberar el kill fallido");
    assert!(a.join().unwrap().is_err(), "el kill fallido se informa");
    assert!(e.core.has_term(&hija), "tras el fallo el terminal sigue siendo del Core");
    assert!(e.core.terms.lock().unwrap().get(&hija).is_some_and(|t| !t.kill_in_progress()), "y se puede reintentar");
    assert!(Path::new(&wt).exists());

    // Segundo intento, ya sano: igual de protegido mientras corre, y al terminar ya no queda terminal.
    let (core, id) = (e.core.clone(), hija.clone());
    let b = std::thread::spawn(move || core.kill_term(&id));
    entra2.wait().expect("el reintento entró en el matador");
    durante_el_kill();
    sale2.wait().expect("liberar el kill correcto");
    assert!(matches!(b.join().unwrap(), Ok(true)));
    assert!(!e.core.has_term(&hija));
    assert!(e.core.kill_term_checked(&hija).is_none(), "ahora sí no hay terminal");
    e.core.rpc(Caller::User, "", "release", &json!({ "task": hija, "force": true })).expect("con el proceso muerto se libera");
    assert!(!Path::new(&wt).exists());
}

#[test]
fn si_el_terminal_desaparece_por_otra_via_durante_un_kill_fallido_el_matador_pasa_a_la_custodia() {
    let _serie = pruebas::serie_custodia();
    let core = Orch::default().0;
    let pasos: Pasos = Arc::default();
    let (entra, sale) = programa(&pasos, false);
    core.register_term("t-onexit", pty::AgentTerm::for_tests(Box::new(MatadorGuiado(pasos.clone())))).unwrap();

    let c2 = core.clone();
    let a = std::thread::spawn(move || c2.kill_term_checked("t-onexit"));
    entra.wait().expect("el kill está en curso");
    // Ruta defensiva: `on_exit` ya NO retira un terminal con terminación en curso (ver la prueba específica), pero si
    // el terminal desapareciera por cualquier otra vía el matador no se descarta.
    drop(core.terms.lock().unwrap().remove("t-onexit"));
    sale.wait().expect("el kill falla");
    assert!(matches!(a.join().unwrap(), Some(Err(_))));
    assert!(pty::in_custody(&core.custody_key("t-onexit")) && core.has_term("t-onexit"), "el matador no se descarta: el proceso sigue siendo del Core");

    // La custodia se resuelve reintentando: ahora el matador funciona.
    let (entra2, sale2) = programa(&pasos, true);
    let c3 = core.clone();
    let b = std::thread::spawn(move || c3.kill_term_checked("t-onexit"));
    entra2.wait().expect("el reintento entró");
    sale2.wait().expect("el reintento termina");
    assert!(matches!(b.join().unwrap(), Some(Ok(()))));
    assert!(!pty::in_custody(&core.custody_key("t-onexit")) && !core.has_term("t-onexit"));
}

// ---------------------------------------------------------------------------------------------
// Segunda ronda de revisión de LXO-18 (P1-A y P2): `on_exit` y los demás cleanups dentro de la ventana de un kill
// ---------------------------------------------------------------------------------------------

/// Un matador que siempre funciona.
#[derive(Debug)]
struct MatadorOk;

impl ChildKiller for MatadorOk {
    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(MatadorOk)
    }
}

/// Entra en pánico la primera vez que se le pide matar y funciona después.
#[derive(Debug)]
struct MatadorQuePanicaUnaVez(Arc<std::sync::atomic::AtomicBool>);

impl ChildKiller for MatadorQuePanicaUnaVez {
    fn kill(&mut self) -> std::io::Result<()> {
        if !self.0.swap(true, std::sync::atomic::Ordering::SeqCst) {
            panic!("pánico inyectado dentro del matador");
        }
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(MatadorQuePanicaUnaVez(self.0.clone()))
    }
}

#[test]
fn on_exit_y_un_segundo_cleanup_dentro_de_la_ventana_de_un_kill_fallan_cerrados_sin_borrar_nada() {
    let e = setup("onexit-ventana");
    let pend = e.spawn(false);
    assert_eq!(e.aprobar(&pend)["outcome"], "approved");
    let hija = e.hijas().pop().expect("hija lanzada");
    let t = e.core.lock().tasks.get(&hija).cloned().expect("tarea");
    let wt = t.worktree.clone().expect("worktree de la hija");
    let intento = || SpawnAttempt { task: hija.clone(), repo: t.repo.clone(), worktree: Some(PathBuf::from(&wt)), branch: t.branch.clone() };

    let pasos: Pasos = Arc::default();
    let (entra1, sale1) = programa(&pasos, false);
    let (entra2, sale2) = programa(&pasos, true);
    e.core.register_term(&hija, pty::AgentTerm::for_tests(Box::new(MatadorGuiado(pasos)))).unwrap();

    let (core, id) = (e.core.clone(), hija.clone());
    let a = std::thread::spawn(move || core.kill_term(&id));
    entra1.wait().expect("kill_term entró en el matador");

    // El proceso termina (ve terminar al hijo) JUSTO mientras se le está matando.
    e.core.on_exit(&hija);
    assert_eq!(e.core.lock().tasks.get(&hija).map(|t| t.status.clone()), Some(Status::Exited), "on_exit sí cierra la tarea");
    assert!(e.core.has_term(&hija), "pero NO retira un terminal con una terminación en curso");
    assert!(e.core.terms.lock().unwrap().get(&hija).is_some_and(|t| t.kill_in_progress()), "que sigue constando como tal");

    // Un segundo cleanup en esa ventana no puede tomar al proceso por muerto ni borrar nada.
    let antes = head(&e.core);
    assert!(e.core.kill_term(&hija).is_err());
    e.core.abandon_attempt(&intento());
    assert!(e.core.rpc(Caller::User, "", "release", &json!({ "task": hija, "force": true })).is_err());
    let (liberadas, conservadas) = e.core.free_worktrees(&MutationContext::person(Channel::Ui), &e.run, true);
    assert!(liberadas.is_empty() && conservadas.iter().any(|k| k["task"] == hija.as_str()), "{liberadas:?} {conservadas:?}");
    assert!(e.core.follow_up(&MutationContext::person(Channel::Ui), &Caller::User, &json!({ "task": hija, "spec": "más" })).is_err_and(|m| m.contains("terminación en curso")));
    assert!(Path::new(&wt).exists() && e.ramas().contains("lx/"), "worktree y rama intactos");
    assert!(e.core.lock().tasks.contains_key(&hija), "la Task sigue en el estado");
    assert_eq!(head(&e.core), antes, "y no se registró ningún evento");

    // El kill falla: el terminal sigue siendo del Core y se puede reintentar; el cleanup sigue sin proceder.
    sale1.wait().expect("liberar el kill fallido");
    assert!(a.join().unwrap().is_err());
    assert!(e.core.has_term(&hija) && e.core.terms.lock().unwrap().get(&hija).is_some_and(|t| !t.kill_in_progress()));
    assert!(Path::new(&wt).exists());

    // El reintento funciona: ahora sí el terminal sale y el cleanup puede continuar.
    let (core, id) = (e.core.clone(), hija.clone());
    let b = std::thread::spawn(move || core.kill_term(&id));
    entra2.wait().expect("el reintento entró en el matador");
    assert!(e.core.has_term(&hija));
    sale2.wait().expect("liberar el kill correcto");
    assert!(matches!(b.join().unwrap(), Ok(true)));
    assert!(!e.core.has_term(&hija));
    e.core.abandon_attempt(&intento());
    assert!(!Path::new(&wt).exists(), "con el proceso comprobado muerto, el cleanup sí procede");
}

#[test]
fn la_custodia_no_se_bloquea_ni_se_descarta_mientras_un_kill_esta_en_curso() {
    let _serie = pruebas::serie_custodia();
    let core = Orch::default().0;
    let dueno = core.custody_key("t-curso");
    let pasos: Pasos = Arc::default();
    let (entra1, sale1) = programa(&pasos, false);
    let (entra2, sale2) = programa(&pasos, true);
    pty::keep_in_custody(&dueno, Box::new(MatadorGuiado(pasos)));

    let d = dueno.clone();
    let a = std::thread::spawn(move || pty::resolve_custody(&d));
    entra1.wait().expect("la custodia entró en el matador");
    assert!(pruebas::custodia_libre(), "el mutex global de la custodia no se mantiene bloqueado durante taskkill");
    assert!(pty::in_custody(&dueno) && core.has_term("t-curso"), "la entrada no desaparece mientras se mata");
    assert!(matches!(pty::resolve_custody(&dueno), Some(Err(m)) if m.contains("en curso")), "un segundo resolver falla cerrado");
    assert!(matches!(core.kill_term_checked("t-curso"), Some(Err(_))));
    pty::reap_unowned();
    assert!(pty::in_custody(&dueno), "el apagado no descarta una terminación en curso");
    sale1.wait().expect("liberar el kill fallido");
    assert!(matches!(a.join().unwrap(), Some(Err(_))));
    assert!(pty::in_custody(&dueno), "tras fallar, el matador vuelve a la custodia");

    let d = dueno.clone();
    let b = std::thread::spawn(move || pty::resolve_custody(&d));
    entra2.wait().expect("el reintento entró");
    sale2.wait().expect("el reintento termina");
    assert!(matches!(b.join().unwrap(), Some(Ok(()))));
    assert!(!pty::in_custody(&dueno));
}

#[test]
fn el_apagado_no_interrumpe_ni_descarta_una_terminacion_en_curso_ni_un_terminal_cuyo_kill_falla() {
    let _serie = pruebas::serie_custodia();
    let core = Orch::default().0;
    let pasos: Pasos = Arc::default();
    let (entra, sale) = programa(&pasos, false);
    core.register_term("t-curso", pty::AgentTerm::for_tests(Box::new(MatadorGuiado(pasos)))).unwrap();
    core.register_term("t-roto", pty::AgentTerm::for_tests(Box::new(MatadorRoto))).unwrap();
    core.register_term("t-ok", pty::AgentTerm::for_tests(Box::new(MatadorOk))).unwrap();

    let c2 = core.clone();
    let a = std::thread::spawn(move || c2.kill_term("t-curso"));
    entra.wait().expect("el kill está en curso");
    core.shutdown();
    assert!(core.terms.lock().unwrap().get("t-curso").is_some_and(|t| t.kill_in_progress()), "la terminación en curso sigue siendo del Core");
    assert!(core.has_term("t-roto"), "un terminal cuyo kill falló no se descarta");
    assert!(!core.has_term("t-ok"), "el que se comprobó muerto sí sale");
    sale.wait().expect("liberar el kill");
    assert!(a.join().unwrap().is_err());
    assert!(core.has_term("t-curso"), "y si ese kill falla, el terminal sigue ahí para reintentar");
    core.terms.lock().unwrap().clear();
}

#[test]
fn un_panico_dentro_del_matador_no_pierde_el_matador_ni_deja_la_terminacion_en_curso() {
    let _serie = pruebas::serie_custodia();
    let core = Orch::default().0;
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    core.register_term("t-panico", pty::AgentTerm::for_tests(Box::new(MatadorQuePanicaUnaVez(flag)))).unwrap();
    let c2 = core.clone();
    assert!(std::thread::spawn(move || c2.kill_term("t-panico")).join().is_err(), "el pánico se propaga");
    assert!(core.has_term("t-panico") && core.terms.lock().unwrap().get("t-panico").is_some_and(|t| !t.kill_in_progress()), "el terminal recuperó su matador");
    assert!(matches!(core.kill_term_checked("t-panico"), Some(Ok(()))), "y se puede reintentar");

    // Lo mismo en la custodia.
    let dueno = core.custody_key("t-panico-custodia");
    pty::keep_in_custody(&dueno, Box::new(MatadorQuePanicaUnaVez(Arc::new(std::sync::atomic::AtomicBool::new(false)))));
    let d = dueno.clone();
    assert!(std::thread::spawn(move || pty::resolve_custody(&d)).join().is_err());
    assert!(pty::in_custody(&dueno), "la entrada sigue en la custodia");
    assert!(matches!(pty::resolve_custody(&dueno), Some(Ok(()))), "con su matador de vuelta, no marcada como «en curso»");
    assert!(!pty::in_custody(&dueno));
}

// ---------------------------------------------------------------------------------------------
// task.removed e invariantes de effect.observed
// ---------------------------------------------------------------------------------------------

#[test]
fn remove_task_aplica_la_cascada_y_no_hace_eliminaciones_parciales() {
    let mut st = State::default();
    let nt = |t: &str| NewTask {
        agent: "claude".into(), model: None, effort: None, role: None, title: t.into(), spec: String::new(),
        repo: "/r".into(), cwd: "/r".into(), branch: None, base: None, worktree: None, external: false,
    };
    let (run, root) = st.create_run("obj", nt("raiz"));
    let hija = st.add_child(&root, 3, nt("hija")).unwrap();
    let otra = st.add_child(&root, 3, nt("otra")).unwrap();
    st.record_decision(&hija, "merge", "human", &json!({ "outcome": "merged" }));
    let queda = st.record_decision(&otra, "merge", "human", &json!({ "outcome": "merged" }));
    st.post(&root, &hija, super::state::Kind::Note, "para la hija", None).unwrap();
    st.post(&hija, &root, super::state::Kind::Note, "de la hija", None).unwrap();
    st.post(&root, &otra, super::state::Kind::Note, "para la otra", None).unwrap();

    st.remove_task(&hija).unwrap();
    assert!(!st.tasks.contains_key(&hija));
    assert_eq!(st.decisions.iter().map(|d| d.id).collect::<Vec<_>>(), vec![queda], "sus decisiones legacy se van");
    assert!(st.messages.iter().all(|m| m.from != hija && m.to != hija), "y los mensajes que la citan");
    assert_eq!(st.messages.iter().filter(|m| m.to == otra).count(), 1, "los ajenos no");

    // Con descendientes, o siendo la raíz, no se retira nada.
    let nieta = st.add_child(&otra, 3, nt("nieta")).unwrap();
    let antes = serde_json::to_string(&st).unwrap();
    assert!(st.remove_task(&otra).unwrap_err().contains("descendientes"));
    assert!(st.remove_task(&root).unwrap_err().contains("raíz"));
    assert!(st.remove_task("t-no-existe").is_err());
    assert_eq!(serde_json::to_string(&st).unwrap(), antes, "ninguna eliminación parcial");
    assert!(st.tasks.contains_key(&nieta) && st.runs.contains_key(&run));
}

#[test]
fn task_removed_solo_lo_decide_el_core_y_no_deja_estado_si_se_rechaza() {
    let e = setup("rm");
    let hija = e
        .core
        .mutate(|tx| tx.add_child(&e.root, 3, NewTask {
            agent: "claude".into(), model: None, effort: None, role: None, title: "h".into(), spec: String::new(),
            repo: s(&e.repo), cwd: s(&e.repo), branch: None, base: None, worktree: None, external: false,
        }))
        .unwrap();
    let antes = head(&e.core);
    // Una persona (o un agente) no puede emitir task.removed (launch_failed): lo decide el Core.
    let r = e.core.mutate_as(&MutationContext::person(Channel::Ui), |tx| tx.remove_failed_launch(&hija));
    assert!(r.is_err(), "{r:?}");
    let r = e.core.mutate_as(&MutationContext::agent(&e.root, Channel::Lxo), |tx| tx.remove_failed_launch(&hija));
    assert!(r.is_err(), "{r:?}");
    assert!(e.core.lock().tasks.contains_key(&hija) && desde(&e.core, antes).is_empty());
    // El Core sí, con run y proyecto capturados antes de borrar.
    e.core.mutate_as(&MutationContext::core(), |tx| tx.remove_failed_launch(&hija)).unwrap();
    let evs = desde(&e.core, antes);
    assert_eq!(kinds_sin_resolucion(&evs), vec!["task.removed"]);
    assert_eq!(pl(&evs[0]), json!({ "cause": "launch_failed" }));
    assert_eq!((evs[0].run_id.as_deref(), evs[0].project_id.as_deref()), (Some(e.run.as_str()), Some(e.project.as_str())));
    assert_eq!((evs[0].idem_key.clone(), evs[0].class), (None, crate::store::EventClass::State));
}

#[test]
fn effect_observed_rechaza_un_efecto_que_no_ocurrio() {
    let ok = |op: &str, kind: &str, obs: Value| EffectObserved::parse("e1", op, kind, &obs);
    // pty_process: launched debe ser true.
    assert!(ok("spawn", "pty_process", json!({ "launched": true })).is_ok());
    assert!(ok("spawn", "pty_process", json!({ "launched": false })).unwrap_err().contains("launched = true"));
    assert!(ok("spawn", "pty_process", json!({})).is_err());
    // git_worktree_removed: algo se borró de verdad, y borrar una rama exige nombrarla.
    let base = |wt: bool, bd: bool, branch: Value| json!({ "worktree_removed": wt, "branch_deleted": bd, "branch": branch });
    assert!(ok("spawn_cleanup", "git_worktree_removed", base(true, false, json!(null))).is_ok());
    assert!(ok("spawn_cleanup", "git_worktree_removed", base(false, true, json!("lx/t"))).is_ok(), "cleanup solo de rama");
    assert!(ok("spawn_cleanup", "git_worktree_removed", base(false, false, json!("lx/t"))).unwrap_err().contains("no ocurrió ningún borrado"));
    assert!(ok("release", "git_worktree_removed", base(false, true, json!(null))).unwrap_err().contains("branch"));
    assert!(ok("release", "git_worktree_removed", base(false, true, json!("  "))).is_err());
    assert!(ok("spawn", "git_worktree_removed", base(true, false, json!(null))).is_err(), "operación fuera del contrato");
}

#[test]
fn approve_spawn_y_remove_run_no_dejan_hija_fuera_de_la_limpieza_ni_resolucion_tardia() {
    let e = setup("race-approve-remove");
    let pending_id = e.spawn(false);
    let argv = e.core.list_pending_spawns().into_iter().find(|p| p.pending_id == pending_id).unwrap().policy.argv;
    let before = head(&e.core);
    e.host.clear_events();
    e.host.clear_calls();

    let claimed = Arc::new(TimedBarrier::new());
    let release_claim = Arc::new(TimedBarrier::new());
    let removal_snapshot = Arc::new(TimedBarrier::new());
    let release_removal = Arc::new(TimedBarrier::new());
    let child_ready = Arc::new(TimedBarrier::new());
    let release_child = Arc::new(TimedBarrier::new());
    let child_id = Arc::new(Mutex::new(None::<String>));
    let child_worktree = Arc::new(Mutex::new(None::<PathBuf>));
    let child_pid = Arc::new(Mutex::new(None::<u32>));
    let child_process_dir = Arc::new(Mutex::new(None::<PathBuf>));

    let (claimed_hook, release_claim_hook) = (claimed.clone(), release_claim.clone());
    let (snapshot_hook, release_removal_hook) = (removal_snapshot.clone(), release_removal.clone());
    let (child_ready_hook, release_child_hook) = (child_ready.clone(), release_child.clone());
    let (child_id_hook, worktree_hook, pid_hook, process_dir_hook) =
        (child_id.clone(), child_worktree.clone(), child_pid.clone(), child_process_dir.clone());
    e.hook(move |core, id, step| {
        match step {
            SpawnStep::AfterApprovalClaim => {
                claimed_hook.wait()?;
                release_claim_hook.wait()?;
            }
            SpawnStep::AfterRunRemovalCleanupSnapshot => {
                snapshot_hook.wait()?;
                release_removal_hook.wait()?;
            }
            SpawnStep::AfterPtyRegistration => {
                let task = core.lock().tasks.get(id).cloned().ok_or_else(|| format!("hija {id} no existe en el hook"))?;
                *child_id_hook.lock().unwrap() = Some(id.to_string());
                *worktree_hook.lock().unwrap() = task.worktree.clone().map(PathBuf::from);
                let dir = pruebas::carpeta(&format!("race-{id}"));
                let term = pruebas::lanza(&dir, false)?;
                *pid_hook.lock().unwrap() = Some(pruebas::ultimo_pid().ok_or_else(|| "el proceso no devolvió PID".to_string())?);
                core.register_term(id, term)?;
                *process_dir_hook.lock().unwrap() = Some(dir);
                child_ready_hook.wait()?;
                release_child_hook.wait()?;
            }
            _ => {}
        }
        Ok(())
    });

    let approve_core = e.core.clone();
    let approve_id = pending_id.clone();
    let approval = std::thread::spawn(move || approve_core.approve_spawn(&approve_id, true, &argv, true));
    claimed.wait().expect("approve_spawn alcanzó el claim");

    // La compuerta existente debe cubrir toda la transición, incluido create_child. Esta lectura permite forzar
    // el camino roto (captura de limpieza mientras la aprobación está pausada) antes de ejecutar el fix.
    let approval_holds_gate = match e.core.pend_gate.try_lock() {
        Ok(guard) => {
            drop(guard);
            false
        }
        Err(std::sync::TryLockError::WouldBlock) => true,
        Err(std::sync::TryLockError::Poisoned(_)) => panic!("pend_gate envenenada"),
    };

    let (remove_started_tx, remove_started_rx) = mpsc::channel();
    let remove_core = e.core.clone();
    let run = e.run.clone();
    let removal = std::thread::spawn(move || {
        remove_started_tx.send(()).unwrap();
        remove_core.rpc(Caller::User, "", "remove_run", &json!({ "run": run }))
    });
    remove_started_rx.recv_timeout(Duration::from_secs(5)).expect("remove_run inició");

    let remove_result = if approval_holds_gate {
        release_claim.wait().expect("continuar la aprobación");
        child_ready.wait().expect("hija alcanzó el registro de PTY");
        release_child.wait().expect("continuar el registro de PTY");
        let approved = approval.join().unwrap();
        assert!(approved.is_ok(), "la aprobación debe resolver antes de quitar el run: {approved:?}");
        removal_snapshot.wait().expect("remove_run alcanzó el cleanup");
        release_removal.wait().expect("continuar remove_run");
        removal.join().unwrap().unwrap()
    } else {
        // En la implementación actual la limpieza captura solo al padre; se pausa ahí y se deja que create_child
        // cree hija, worktree y proceso antes del commit que elimina el run.
        removal_snapshot.wait().expect("remove_run alcanzó el cleanup viejo");
        release_claim.wait().expect("continuar la aprobación vieja");
        child_ready.wait().expect("hija alcanzó el registro de PTY");
        release_removal.wait().expect("continuar remove_run");
        let removed = removal.join().unwrap().unwrap();
        release_child.wait().expect("continuar el registro de PTY");
        let approved = approval.join().unwrap();
        assert!(approved.is_ok(), "la resolución tardía debe reproducirse: {approved:?}");
        removed
    };

    let child_id = child_id.lock().unwrap().clone().expect("create_child alcanzó pty_process");
    let child_worktree = child_worktree.lock().unwrap().clone().expect("la hija creó un worktree");
    let child_pid = child_pid.lock().unwrap().expect("proceso de hija");
    let child_process_dir = child_process_dir.lock().unwrap().clone().expect("carpeta del proceso");
    let events = desde(&e.core, before);
    let resolution_index = events.iter().position(|ev| ev.kind == "spawn.resolved");
    let removed_index = events.iter().position(|ev| ev.kind == "run.removed");
    let resolution = events.iter().find(|ev| ev.kind == "spawn.resolved").map(pl);
    let resolution_task = resolution.as_ref().and_then(|v| v["task"].as_str()).map(str::to_owned);
    let resolution_outcome = resolution.as_ref().and_then(|v| v["outcome"].as_str());
    let term_survived = e.core.terms.lock().unwrap().contains_key(&child_id);
    let process_alive_after_remove = pruebas::vivo(child_pid);
    let worktree_survived = child_worktree.exists();
    let task_survived = e.core.lock().tasks.contains_key(&child_id);
    let run_survived = e.core.lock().runs.contains_key(&e.run);
    let worktree_reported_kept = remove_result["kept"].as_array().is_some_and(|items| items.iter().any(|item| item["task"] == child_id));

    // Ningún recurso que creó esta prueba queda vivo aunque la aserción de regresión falle en la implementación vieja.
    if term_survived {
        e.core.kill_term(&child_id);
    }
    assert!(pruebas::espera_muerto(child_pid), "el proceso simulado de la hija terminó");
    if child_worktree.exists() {
        let _ = super::git::remove_worktree(&s(&e.repo), &s(&child_worktree), true);
    }
    let _ = std::fs::remove_dir_all(&child_process_dir);

    assert!(!term_survived && !process_alive_after_remove, "remove_run no debe dejar vivo el proceso de la hija");
    assert!(!worktree_survived || worktree_reported_kept, "un worktree que la política preserva debe salir en `kept`, nunca quedar fuera de la instantánea");
    assert!(!task_survived && !run_survived, "el run y sus tareas se eliminan");
    assert_eq!(resolution_outcome, Some("approved"));
    assert_eq!(resolution_task.as_deref(), Some(child_id.as_str()));
    assert!(matches!((resolution_index, removed_index), (Some(r), Some(m)) if r < m), "spawn.resolved debe preceder a run.removed: {:?}", kinds(&events));
}

#[test]
fn spawn_request_no_emite_un_pending_despues_de_su_resolucion() {
    let e = setup("race-request-ui-order");
    e.core.settings.lock().unwrap().notify_questions = true;
    e.host.clear_events();
    e.host.clear_calls();
    let before = head(&e.core);
    let request_paused = Arc::new(TimedBarrier::new());
    let release_request = Arc::new(TimedBarrier::new());
    let (paused_hook, release_hook) = (request_paused.clone(), release_request.clone());
    e.hook(move |_core, _id, step| {
        if step == SpawnStep::AfterRequestPersistBeforeEmit {
            paused_hook.wait()?;
            release_hook.wait()?;
        }
        Ok(())
    });

    let request_core = e.core.clone();
    let parent = e.root.clone();
    let request = std::thread::spawn(move || {
        request_core.rpc(
            Caller::Agent(Some(parent)),
            "",
            "spawn",
            &json!({ "agent": "claude", "task": "Encargo", "name": "Hija UI", "shared": true }),
        )
    });
    request_paused.wait().expect("solicitud persistida antes de su aviso");
    let pending_id = e.core.list_pending_spawns().into_iter().next().expect("pending ya persistido e insertado").pending_id;
    let request_holds_gate = match e.core.pend_gate.try_lock() {
        Ok(guard) => {
            drop(guard);
            false
        }
        Err(std::sync::TryLockError::WouldBlock) => true,
        Err(std::sync::TryLockError::Poisoned(_)) => panic!("pend_gate envenenada"),
    };

    let rejection = if request_holds_gate {
        let (reject_started_tx, reject_started_rx) = mpsc::channel();
        let reject_core = e.core.clone();
        let reject_id = pending_id.clone();
        let reject = std::thread::spawn(move || {
            reject_started_tx.send(()).unwrap();
            reject_core.reject_spawn(&reject_id, true, Some("resolución concurrente"))
        });
        reject_started_rx.recv_timeout(Duration::from_secs(5)).expect("reject_spawn inició");
        release_request.wait().expect("emitir el aviso antes de resolver");
        let requested = request.join().unwrap();
        let rejected = reject.join().unwrap();
        assert!(requested.is_ok(), "solicitud: {requested:?}");
        rejected
    } else {
        let rejected = e.core.reject_spawn(&pending_id, true, Some("resolución concurrente"));
        release_request.wait().expect("emitir el aviso de solicitud");
        let requested = request.join().unwrap();
        assert!(requested.is_ok(), "solicitud: {requested:?}");
        rejected
    };
    assert!(rejection.is_ok(), "rechazo: {rejection:?}");

    let ui_events: Vec<String> = e
        .host
        .events()
        .into_iter()
        .map(|(name, _)| name)
        .filter(|name| name == EV_PENDING || name == EV_RESOLVED)
        .collect();
    let visible_order: Vec<&str> = e
        .host
        .calls()
        .iter()
        .filter_map(|call| match call {
            RecordedCall::Event(name, _) if name == EV_PENDING => Some("pending"),
            RecordedCall::Event(name, _) if name == EV_RESOLVED => Some("resolved"),
            RecordedCall::Notification(_, _) => Some("notification"),
            _ => None,
        })
        .collect();
    let rows = desde(&e.core, before);
    assert_eq!(ui_events, vec![EV_PENDING, EV_RESOLVED], "el UI recibe request antes de resolution");
    assert_eq!(visible_order, vec!["pending", "notification", "resolved"], "ni el evento UI ni el aviso aparecen después de la resolución");
    assert_eq!(kinds(&rows), vec!["spawn.requested", "spawn.resolved"], "los hechos durables siguen el mismo orden");
    assert_eq!(pl(&rows[1])["outcome"], "rejected", "`expired` es solo estado/API, nunca outcome del Event Log");
    assert_eq!(e.host.notifications().len(), 1, "el aviso del sistema se emite para la solicitud persistida");
    assert_eq!(e.estado_pendiente(&pending_id), Some(PendState::Rejected("resolución concurrente".into())));
}

#[test]
fn remove_run_antes_de_revalidar_rechaza_spawn_request_sin_persistirlo() {
    let e = setup("race-remove-before-spawn-request");
    e.core.settings.lock().unwrap().notify_questions = true;
    e.host.clear_events();
    e.host.clear_calls();
    let before = head(&e.core);
    let run = e.run.clone();
    let core_for_remove = Arc::downgrade(&e.core);
    e.hook(move |_core, _id, step| {
        if step == SpawnStep::BeforeRequestRevalidation {
            let core = core_for_remove.upgrade().ok_or("Core de prueba ya cerrado")?;
            core.rpc(Caller::User, "", "remove_run", &json!({ "run": run }))?;
        }
        Ok(())
    });

    let result = e.core.rpc(
        Caller::Agent(Some(e.root.clone())),
        "",
        "spawn",
        &json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true }),
    );

    assert!(result.as_ref().is_err_and(|error| error.contains("run está cerrado") || error.contains("tarea ya terminó")), "el padre se revalida después del borrado: {result:?}");
    assert!(e.core.list_pending_spawns().is_empty(), "no queda pending en memoria");
    assert_eq!(kinds(&desde(&e.core, before)), vec!["run.removed"], "no queda un spawn.requested después de run.removed");
    assert!(!e.host.events().iter().any(|(name, _)| name == EV_PENDING || name == EV_RESOLVED));
    assert!(e.host.notifications().is_empty(), "no se avisa una solicitud que no se pudo persistir");
}

#[test]
fn spawn_request_persistido_se_cancela_antes_de_run_removed_y_su_aviso_va_primero() {
    let e = setup("race-spawn-request-remove-run");
    e.core.settings.lock().unwrap().notify_questions = true;
    e.host.clear_events();
    e.host.clear_calls();
    let before = head(&e.core);

    let request_paused = Arc::new(TimedBarrier::new());
    let release_request = Arc::new(TimedBarrier::new());
    let (paused_hook, release_hook) = (request_paused.clone(), release_request.clone());
    let (before_gate_tx, before_gate_rx) = mpsc::channel();
    let (continue_gate_tx, continue_gate_rx) = mpsc::channel();
    let (cleanup_tx, cleanup_rx) = mpsc::channel();
    let (continue_cleanup_tx, continue_cleanup_rx) = mpsc::channel();
    let continue_gate_rx = Arc::new(Mutex::new(continue_gate_rx));
    let continue_cleanup_rx = Arc::new(Mutex::new(continue_cleanup_rx));
    let (continue_gate_hook, continue_cleanup_hook) = (continue_gate_rx.clone(), continue_cleanup_rx.clone());
    e.hook(move |_core, _id, step| {
        match step {
            SpawnStep::AfterRequestPersistBeforeEmit => {
                paused_hook.wait()?;
                release_hook.wait()?;
            }
            SpawnStep::BeforeRunRemovalGate => {
                before_gate_tx.send(()).map_err(|e| e.to_string())?;
                continue_gate_hook.lock().unwrap().recv_timeout(Duration::from_secs(5)).map_err(|e| format!("remove_run no pudo continuar hacia pend_gate: {e}"))?;
            }
            SpawnStep::AfterRunRemovalCleanupSnapshot => {
                cleanup_tx.send(()).map_err(|e| e.to_string())?;
                continue_cleanup_hook.lock().unwrap().recv_timeout(Duration::from_secs(5)).map_err(|e| format!("remove_run no pudo continuar tras cleanup: {e}"))?;
            }
            _ => {}
        }
        Ok(())
    });

    let request_core = e.core.clone();
    let parent = e.root.clone();
    let request = std::thread::spawn(move || {
        request_core.rpc(
            Caller::Agent(Some(parent)),
            "",
            "spawn",
            &json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true }),
        )
    });
    request_paused.wait().expect("spawn.requested persistido y pending insertado");
    let pending_id = e.core.list_pending_spawns().into_iter().next().expect("pending insertado antes del aviso").pending_id;

    let (remove_started_tx, remove_started_rx) = mpsc::channel();
    let remove_core = e.core.clone();
    let run = e.run.clone();
    let removal = std::thread::spawn(move || {
        remove_started_tx.send(()).unwrap();
        remove_core.rpc(Caller::User, "", "remove_run", &json!({ "run": run }))
    });
    remove_started_rx.recv_timeout(Duration::from_secs(5)).expect("remove_run inició");
    before_gate_rx.recv_timeout(Duration::from_secs(5)).expect("remove_run alcanzó la frontera de pend_gate");
    continue_gate_tx.send(()).expect("continuar remove_run hacia pend_gate");

    // El punto de cleanup es posterior a pend_gate. Mientras la solicitud sigue pausada dentro de la compuerta,
    // que remove_run llegue aquí indicaría que ya no espera la misma compuerta.
    let removal_bypassed_gate = match cleanup_rx.recv_timeout(Duration::from_secs(1)) {
        Ok(()) => true,
        Err(mpsc::RecvTimeoutError::Timeout) => false,
        Err(mpsc::RecvTimeoutError::Disconnected) => panic!("remove_run terminó antes de entrar al cleanup"),
    };
    release_request.wait().expect("publicar solicitud antes de resolverla");
    let requested = request.join().unwrap();
    assert!(requested.is_ok(), "solicitud: {requested:?}");
    if !removal_bypassed_gate {
        cleanup_rx.recv_timeout(Duration::from_secs(5)).expect("remove_run alcanza el cleanup al adquirir pend_gate");
    }
    continue_cleanup_tx.send(()).expect("continuar remove_run al commit");
    removal.join().unwrap().unwrap();

    let events = desde(&e.core, before);
    assert!(!removal_bypassed_gate, "remove_run no debe limpiar ni resolver mientras spawn_request conserva pend_gate");
    assert_eq!(kinds(&events), vec!["spawn.requested", "spawn.resolved", "run.removed"]);
    assert_eq!(pl(&events[1])["outcome"], "cancelled_run_removed");
    assert_eq!(events[1].state_rev, events[2].state_rev, "cancelación y run.removed comparten una mutación");
    let visible_order: Vec<&str> = e
        .host
        .calls()
        .iter()
        .filter_map(|call| match call {
            RecordedCall::Event(name, _) if name == EV_PENDING => Some("pending"),
            RecordedCall::Event(name, _) if name == EV_RESOLVED => Some("resolved"),
            RecordedCall::Notification(_, _) => Some("notification"),
            _ => None,
        })
        .collect();
    assert_eq!(visible_order, vec!["pending", "notification", "resolved"], "el aviso no puede aparecer después de resolver el pending");
    assert_eq!(e.estado_pendiente(&pending_id), Some(PendState::Expired));
    assert_eq!(e.host.notifications().len(), 1);
}

#[test]
fn spawn_request_no_inserta_pending_ni_avisa_si_falla_la_persistencia() {
    let e = setup("spawn-request-persist-fail");
    e.core.mutate(|tx| {
        tx.task_mut(&e.root)?.project_id = None;
        Ok(())
    }).unwrap();
    e.core.settings.lock().unwrap().notify_questions = true;
    e.host.clear_events();
    let before = head(&e.core);
    e.core.degrade_for_tests("fallo de persistencia preparado");

    let result = e.core.rpc(
        Caller::Agent(Some(e.root.clone())),
        "",
        "spawn",
        &json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true }),
    );
    let error = result.expect_err("la solicitud no puede tener éxito si `spawn.requested` no se persiste");
    assert!(error.contains("fallo de persistencia preparado"), "debe fallar al persistir `spawn.requested`, no antes: {error}");
    assert!(e.core.list_pending_spawns().is_empty(), "persistencia fallida no deja pendiente en memoria");
    assert!(desde(&e.core, before).is_empty(), "no hay hecho parcial");
    let events = e.host.events();
    assert!(!events.iter().any(|(name, _)| name == EV_PENDING || name == EV_RESOLVED));
    assert!(e.host.notifications().is_empty(), "tampoco llega el aviso al sistema");
}

#[test]
fn reject_y_timeout_siguen_pending_si_falla_la_persistencia_de_la_resolucion() {
    let e = setup("spawn-resolution-persist-fail");
    let reject_id = e.spawn(true);
    let timeout_id = e.spawn(true);
    e.core.expire_pending_for_test(&timeout_id);
    e.host.clear_events();
    let before = head(&e.core);
    e.core.degrade_for_tests("fallo de persistencia preparado");

    let rejected = e.core.reject_spawn(&reject_id, true, Some("no"));
    let rejection_error = rejected.expect_err("el rechazo no cambia memoria si no queda durable");
    assert!(rejection_error.contains("fallo de persistencia preparado"), "el rechazo debe fallar en la persistencia: {rejection_error}");
    e.core.sweep_pending();
    assert_eq!(e.estado_pendiente(&reject_id), Some(PendState::Pending));
    assert_eq!(e.estado_pendiente(&timeout_id), Some(PendState::Pending));
    assert!(desde(&e.core, before).is_empty());
    assert!(!e.host.events().iter().any(|(name, _)| name == EV_RESOLVED));
}

#[test]
fn spawn_requested_y_resolved_cumplen_identidad_clase_actor_y_correlacion() {
    let e = setup("spawn-event-contract");
    let before = head(&e.core);
    let pending_id = e.spawn(true);
    let request = desde(&e.core, before).into_iter().find(|ev| ev.kind == "spawn.requested").unwrap();
    assert_eq!((request.entity_kind.as_str(), request.entity_id.as_str()), ("spawn_request", pending_id.as_str()));
    assert_eq!((request.class, request.actor_kind.as_str(), request.actor_id.as_deref(), request.channel.as_deref()),
        (crate::store::EventClass::State, "agent", Some(e.root.as_str()), Some("lxo")));
    assert_eq!((request.correlation_id.as_deref(), request.idem_key.as_deref(), request.run_id.as_deref(), request.project_id.as_deref()),
        (Some(pending_id.as_str()), Some(pending_id.as_str()), Some(e.run.as_str()), Some(e.project.as_str())));
    let requested = pl(&request);
    assert_eq!(requested["parent_task"], e.root);
    assert_eq!(requested["title"], "Hija");
    assert_eq!(requested["shared"], true);
    assert!(requested.get("argv").is_none() && requested.get("cwd").is_none() && requested.get("env").is_none());

    let before_resolution = head(&e.core);
    e.core.reject_spawn(&pending_id, true, Some("motivo no exportado")).unwrap();
    let resolution = desde(&e.core, before_resolution).into_iter().find(|ev| ev.kind == "spawn.resolved").unwrap();
    assert_eq!((resolution.entity_kind.as_str(), resolution.entity_id.as_str()), ("spawn_request", pending_id.as_str()));
    assert_eq!((resolution.class, resolution.actor_kind.as_str(), resolution.actor_id.as_deref(), resolution.channel.as_deref()),
        (crate::store::EventClass::Decision, "person", None, Some("ui")));
    assert_eq!((resolution.correlation_id.as_deref(), resolution.idem_key.as_deref(), resolution.run_id.as_deref(), resolution.project_id.as_deref()),
        (Some(pending_id.as_str()), Some(pending_id.as_str()), Some(e.run.as_str()), Some(e.project.as_str())));
    assert_eq!(pl(&resolution), json!({ "outcome": "rejected", "has_reason": true }));
}

#[test]
fn timeout_se_persiste_como_outcome_timeout_y_no_expired() {
    let e = setup("spawn-timeout-event-contract");
    let pending_id = e.spawn(true);
    e.core.expire_pending_for_test(&pending_id);
    let before = head(&e.core);
    e.core.sweep_pending();
    let events = desde(&e.core, before);
    assert_eq!(kinds(&events), vec!["spawn.resolved"]);
    assert_eq!(pl(&events[0])["outcome"], "timeout");
    assert_ne!(pl(&events[0])["outcome"], "expired");
}

#[test]
fn resolucion_standalone_conserva_el_project_id_capturado_en_el_pendiente() {
    let e = setup("spawn-standalone-project");
    let pending_id = e.spawn(true);
    let p = e.core.list_pending_spawns().into_iter().find(|p| p.pending_id == pending_id).expect("pending persistido");
    assert_eq!(p.project_id.as_deref(), Some(e.project.as_str()));
    let before = head(&e.core);
    let fact = super::tx_ops::spawn_resolution_fact(
        &MutationContext::core(),
        &p,
        super::event_kinds::SpawnOutcome::CoordinatorClosed,
        None,
        false,
    )
    .unwrap();
    e.core.record_facts(&MutationContext::core(), vec![fact]).unwrap();
    let events = desde(&e.core, before);
    assert_eq!(kinds(&events), vec!["spawn.resolved"]);
    assert_eq!(events[0].project_id.as_deref(), Some(e.project.as_str()));
}

#[test]
fn remove_run_degradado_no_mata_terminales_ni_borra_el_run() {
    let e = setup("remove-run-degraded-preflight");
    let dir = pruebas::carpeta("remove-run-degraded");
    let term = pruebas::lanza(&dir, false).unwrap();
    let pid = pruebas::ultimo_pid().expect("proceso simulado");
    e.core.register_term(&e.root, term).unwrap();
    e.core.degrade_for_tests("fallo de almacenamiento preparado");

    let result = e.core.rpc(Caller::User, "", "remove_run", &json!({ "run": e.run }));
    assert!(result.is_err(), "no se quita un run con el Core degradado: {result:?}");
    assert!(pruebas::vivo(pid), "el terminal no se mata antes del rechazo");
    assert!(e.core.terms.lock().unwrap().contains_key(&e.root));
    assert!(e.core.lock().runs.contains_key(&e.run));
    assert!(e.core.lock().tasks.contains_key(&e.root));

    e.core.kill_term(&e.root);
    assert!(pruebas::espera_muerto(pid));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn coordinator_closed_y_remove_run_persisten_outcomes_canónicos() {
    let closed = setup("spawn-coordinator-closed-event");
    let closed_id = closed.spawn(true);
    let before_closed = head(&closed.core);
    closed.core.lock_unpersisted().close(&closed.root, Status::Exited, "coordinador terminó").unwrap();
    closed.core.sweep_pending();
    let closed_events = desde(&closed.core, before_closed);
    let closed_resolution = closed_events.iter().find(|ev| ev.kind == "spawn.resolved").expect("resolución durable");
    assert_eq!(pl(closed_resolution)["outcome"], "coordinator_closed");
    assert_eq!((closed_resolution.entity_id.as_str(), closed_resolution.actor_kind.as_str(), closed_resolution.channel.as_deref()),
        (closed_id.as_str(), "system", Some("core")));

    let removed = setup("spawn-cancelled-run-event");
    let removed_id = removed.spawn(true);
    let before_removed = head(&removed.core);
    removed.core.rpc(Caller::User, "", "remove_run", &json!({ "run": removed.run })).unwrap();
    let removed_events = desde(&removed.core, before_removed);
    assert_eq!(kinds(&removed_events), vec!["spawn.resolved", "run.removed"]);
    let cancellation = &removed_events[0];
    assert_eq!(pl(cancellation)["outcome"], "cancelled_run_removed");
    assert_eq!(cancellation.entity_id, removed_id);
    assert_eq!(cancellation.state_rev, removed_events[1].state_rev, "resolución y borrado son la misma mutación");
    assert!(removed.core.lock().decisions.iter().all(|decision| decision.kind != "spawn"));
}
