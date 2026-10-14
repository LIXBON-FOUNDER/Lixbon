//! Pruebas del cleanup de `create_child` (slice E, E1b, Effects · cleanup): cada punto de fallo de un
//! lanzamiento deja el mundo (Task, worktree, rama, proceso) y el Event Log exactamente como el mapa dice.
//!
//! Se ejecutan sobre un Core REAL con SQLite autoritativa y un repositorio git real; el lanzamiento usa el
//! `fake_launch` de las pruebas y el gancho `Core::spawn_hook` para fallar en cada punto.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use portable_pty::ChildKiller;
use serde_json::{json, Value};

use super::boot_tests::*;
use super::event_kinds::EffectObserved;
use super::events::{Channel, MutationContext};
use super::host::RecordingHost;
use super::mutation::Health;
use super::pty::{self, pruebas};
use super::spawn::SpawnStep;
use super::state::{NewTask, State, Status};
use super::{agents, Caller, Core, Orch};
use crate::store::{EventQuery, EventRow};

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

fn fake(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> agents::Policy {
    let prof = agents::Profile::parse(profile).expect("perfil");
    agents::evaluate_for(provider, prof, role, worktree, agents::Detected::Skip, false, agents::Delivery::FileOrMarkers)
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn g(dir: &Path, args: &[&str]) -> String {
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

struct Env {
    _l: Limpia,
    core: Arc<Core>,
    root: String,
    run: String,
    project: String,
    repo: PathBuf,
}

fn setup(nombre: &str) -> Env {
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
    core.init_in(RecordingHost::new(), &data, &core_dir).unwrap();
    core.settings.lock().unwrap().enabled = true;
    let project = core.project_add(&json!({ "path": s(&repo) })).unwrap()["project"]["id"].as_str().unwrap().to_string();
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
    Env { _l: l, core, root, run, project, repo }
}

impl Env {
    fn spawn(&self, shared: bool) -> String {
        let v = self
            .core
            .rpc(Caller::Agent(Some(self.root.clone())), "", "spawn", &json!({ "agent": "claude", "task": "Encargo\nDetalle", "name": "Hija", "shared": shared }))
            .unwrap();
        v["pending_id"].as_str().unwrap().to_string()
    }

    fn aprobar(&self, pid: &str) -> Value {
        let argv = self.core.list_pending_spawns().into_iter().find(|p| p.pending_id == pid).unwrap().policy.argv;
        self.core.approve_spawn(pid, true, &argv, true).unwrap()
    }

    fn hijas(&self) -> Vec<String> {
        self.core.lock().tasks.values().filter(|t| t.parent.as_deref() == Some(self.root.as_str())).map(|t| t.id.clone()).collect()
    }

    fn hook(&self, f: impl Fn(&Core, &str, SpawnStep) -> Result<(), String> + Send + Sync + 'static) {
        *self.core.spawn_hook.lock().unwrap() = Some(Arc::new(f));
    }

    fn ramas(&self) -> String {
        g(&self.repo, &["branch", "--list", "lx/*"])
    }
}

fn head(core: &Core) -> i64 {
    core.storage.with_store(|s| s.events_head().unwrap()).unwrap()
}

fn desde(core: &Core, seq: i64) -> Vec<EventRow> {
    core.storage.with_store(|s| s.events_page(&EventQuery { after: Some(seq), limit: Some(500), ..Default::default() }).unwrap().events).unwrap()
}

fn kinds(evs: &[EventRow]) -> Vec<&str> {
    evs.iter().map(|e| e.kind.as_str()).collect()
}

fn pl(e: &EventRow) -> Value {
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
    assert_eq!(kinds(&evs), vec!["task.created", "task.removed"], "sin worktree no hay effect.observed");
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
    assert_eq!(kinds(&evs), vec!["task.created", "effect.observed", "effect.observed"], "ni task.removed: el run ya estaba cerrado");
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
    assert_eq!(kinds(&evs), vec!["task.created", "effect.observed", "task.status_changed", "effect.observed"]);
    assert!(!kinds(&evs).contains(&"task.removed"));
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
    assert_eq!(kinds(&evs), vec!["task.created", "effect.observed", "task.removed"]);
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
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    assert!(matches!(e.core.health(), Health::DegradedReadOnly(_)));
    assert_eq!(e.hijas().len(), 1, "no se borra la Task con el Core degradado");
    assert!(e.ramas().contains("lx/"), "ni la rama");
    assert!(g(&e.repo, &["worktree", "list"]).lines().count() > 1, "ni el worktree");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds(&evs), vec!["task.created"], "nada más se persiste");
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
    assert_eq!(kinds(&evs), vec!["task.created", "effect.observed", "effect.observed", "task.removed"], "effect.observed del cleanup antes que task.removed");
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
    assert_eq!(kinds(&evs), vec!["task.created", "effect.observed", "effect.observed", "task.removed"], "el kill no tiene evento propio");
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
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    let pid_proceso = proceso.lock().unwrap().expect("proceso real");
    assert!(pruebas::espera_muerto(pid_proceso), "la única acción destructiva con el Core degradado: matar el proceso no registrado");
    assert_eq!(terminales(&e.core), 0);
    assert_eq!(e.hijas().len(), 1, "la Task se conserva");
    assert!(e.ramas().contains("lx/"), "y su rama y su worktree");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds(&evs), vec!["task.created", "effect.observed"], "solo lo ya confirmado");
    assert!(kinds_del_diario().contains(&"pty_process".to_string()));
}

/// Un matador que siempre falla: no hay control fiable sobre el proceso.
#[derive(Debug)]
struct MatadorRoto;

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
    assert_eq!(kinds(&desde(&e.core, antes)), vec!["task.created", "effect.observed"]);
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
    assert_eq!(kinds(&evs), vec!["task.created", "task.removed"]);
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
    assert_eq!(kinds(&evs), vec!["task.created", "effect.observed"], "ni cleanup registrado ni task.removed");
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
    assert_eq!(kinds(&evs), vec!["task.created", "effect.observed", "effect.observed", "task.removed"]);
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
    assert_eq!(kinds(&evs), vec!["task.removed"]);
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
