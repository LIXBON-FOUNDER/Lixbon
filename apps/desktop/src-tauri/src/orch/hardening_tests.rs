//! Pruebas adversariales del hardening final de LXO-18 (E1b · Effects cleanup y task.removed).
//!
//! Cada prueba fija un hueco que dejaba un proceso sin dueño, un artefacto borrado con el Core degradado, una
//! referencia a una rama que ya no existe o una confirmación vacía. Corren sobre un Core REAL (SQLite
//! autoritativa y un repositorio git real); los fallos se inyectan con matadores y ganchos, nunca con esperas.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use portable_pty::ChildKiller;
use serde_json::json;

use super::delivery::Found;
use super::events::{Channel, MutationContext};
use super::pty::AgentTerm;
use super::spawn::SpawnStep;
use super::spawn_cleanup_tests::{desde, g, head, kinds, pl, setup, Env, MatadorRoto};
use super::state::Status;
use super::{Caller, Core};

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

/// Cuenta los kills que se le piden y los da por buenos.
#[derive(Debug)]
struct MatadorContador(Arc<AtomicUsize>);

impl ChildKiller for MatadorContador {
    fn kill(&mut self) -> std::io::Result<()> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(MatadorContador(self.0.clone()))
    }
}

fn persona() -> MutationContext {
    MutationContext::person(Channel::Ui)
}

/// Aprueba una hija con worktree propio (`fake_launch`: queda `running` y sin terminal). Devuelve su id.
fn hija(e: &Env) -> String {
    let pid = e.spawn(false);
    assert_eq!(e.aprobar(&pid)["outcome"], "approved", "la hija se lanzó");
    e.hijas().pop().expect("hija")
}

fn worktree_de(e: &Env, id: &str) -> String {
    e.core.lock().tasks.get(id).and_then(|t| t.worktree.clone()).expect("worktree registrado")
}

fn rama_de(e: &Env, id: &str) -> Option<String> {
    e.core.lock().tasks.get(id).and_then(|t| t.branch.clone())
}

fn terminales(core: &Core) -> usize {
    core.terms.lock().unwrap_or_else(|e| e.into_inner()).len()
}

fn rev(core: &Core) -> Option<i64> {
    core.storage.confirmed_rev().unwrap()
}

fn marca_fusionada(core: &Core, id: &str) {
    core.mutate(|tx| {
        tx.task_mut(id)?.merged = true;
        Ok(())
    })
    .unwrap();
}

fn ramas_git(e: &Env) -> String {
    e.ramas()
}

// ---------------------------------------------------------------------------------------------
// B3 · un kill que falla no puede soltar el terminal ni dejar que se borre lo que el proceso usa
// ---------------------------------------------------------------------------------------------

#[test]
fn release_con_el_kill_fallido_conserva_terminal_worktree_rama_y_task_sin_eventos() {
    let e = setup("h-rel-kill");
    let id = hija(&e);
    let wt = worktree_de(&e, &id);
    e.core.register_term(&id, AgentTerm::for_tests(Box::new(MatadorRoto))).unwrap();
    let (antes, seq) = (rev(&e.core), head(&e.core));

    let r = e.core.release(&persona(), &Caller::User, &id, true);

    assert!(r.as_ref().is_err_and(|m| m.contains("proceso")), "sin control fiable sobre el proceso no se libera: {r:?}");
    assert_eq!(terminales(&e.core), 1, "el terminal no se suelta: el proceso sigue bajo la custodia del Core");
    assert!(Path::new(&wt).exists(), "el worktree que el agente quizá sigue usando no se borra");
    assert!(ramas_git(&e).contains("lx/"), "ni su rama");
    assert_eq!(e.core.lock().tasks.get(&id).map(|t| t.status.clone()), Some(Status::Running), "la Task no cambia de estado");
    assert_eq!((rev(&e.core), head(&e.core)), (antes, seq), "ni rev ni eventos");
    e.core.terms.lock().unwrap().clear();
}

#[test]
fn stop_con_el_kill_fallido_no_declara_detenida_una_tarea_cuyo_proceso_sigue_vivo() {
    let e = setup("h-stop-kill");
    let id = hija(&e);
    e.core.register_term(&id, AgentTerm::for_tests(Box::new(MatadorRoto))).unwrap();
    let r = e.core.rpc(Caller::Agent(Some(e.root.clone())), "", "stop", &json!({ "task": id }));
    assert!(r.is_err(), "{r:?}");
    assert_eq!(e.core.lock().tasks.get(&id).map(|t| t.status.clone()), Some(Status::Running), "no se miente sobre un proceso que no se pudo detener");
    assert_eq!(terminales(&e.core), 1);
    e.core.terms.lock().unwrap().clear();
}

#[test]
fn remove_run_con_el_kill_fallido_no_borra_el_run_ni_el_worktree() {
    let e = setup("h-rr-kill");
    let id = hija(&e);
    let wt = worktree_de(&e, &id);
    e.core.register_term(&id, AgentTerm::for_tests(Box::new(MatadorRoto))).unwrap();
    let (antes, seq) = (rev(&e.core), head(&e.core));

    let r = e.core.remove_run_and_cancel_pending(&persona(), &e.run);

    assert!(r.is_err(), "no se quita un run con un proceso que no se pudo matar: {r:?}");
    assert!(e.core.lock().runs.contains_key(&e.run), "el run sigue ahí");
    assert!(e.core.lock().tasks.contains_key(&id), "y su Task");
    assert!(Path::new(&wt).exists());
    assert_eq!(terminales(&e.core), 1, "el terminal sigue custodiado");
    assert_eq!((rev(&e.core), head(&e.core)), (antes, seq));
    e.core.terms.lock().unwrap().clear();
}

#[test]
fn close_run_con_un_kill_fallido_conserva_solo_el_worktree_de_esa_tarea() {
    let e = setup("h-cr-kill");
    let rota = hija(&e);
    let sana = hija(&e);
    let (wt_rota, wt_sana) = (worktree_de(&e, &rota), worktree_de(&e, &sana));
    e.core.register_term(&rota, AgentTerm::for_tests(Box::new(MatadorRoto))).unwrap();

    let out = e.core.close_run(&persona(), &e.run, true).unwrap();

    assert!(Path::new(&wt_rota).exists(), "el worktree de la tarea cuyo proceso sigue vivo se conserva");
    assert!(!Path::new(&wt_sana).exists(), "el de la otra se libera");
    let kept = out["kept"].as_array().unwrap();
    assert!(kept.iter().any(|k| k["task"] == rota.as_str()), "se informa como conservado: {out}");
    assert!(out["terminals"].as_array().unwrap().iter().all(|t| t != rota.as_str()), "no se cuenta como terminal cerrado");
    assert_eq!(terminales(&e.core), 1);
    e.core.terms.lock().unwrap().clear();
}

// ---------------------------------------------------------------------------------------------
// B6 · Core degradado: ni se mata lo registrado ni se borra nada
// ---------------------------------------------------------------------------------------------

#[test]
fn release_con_el_core_degradado_no_mata_ni_borra_nada() {
    let e = setup("h-rel-deg");
    let id = hija(&e);
    let wt = worktree_de(&e, &id);
    let kills = Arc::new(AtomicUsize::new(0));
    e.core.register_term(&id, AgentTerm::for_tests(Box::new(MatadorContador(kills.clone())))).unwrap();
    e.core.degrade_for_tests("fallo de almacenamiento inyectado");

    let r = e.core.release(&persona(), &Caller::User, &id, true);

    assert!(r.is_err(), "{r:?}");
    assert_eq!(kills.load(Ordering::SeqCst), 0, "un terminal ya registrado no se mata con el Core degradado");
    assert_eq!(terminales(&e.core), 1);
    assert!(Path::new(&wt).exists(), "ni se borra el worktree");
    assert!(ramas_git(&e).contains("lx/"), "ni la rama");
    assert!(e.core.lock().tasks.contains_key(&id), "ni la Task");
    e.core.terms.lock().unwrap().clear();
}

#[test]
fn free_worktrees_con_el_core_degradado_conserva_los_worktrees() {
    let e = setup("h-fw-deg");
    let id = hija(&e);
    let wt = worktree_de(&e, &id);
    marca_fusionada(&e.core, &id);
    e.core.degrade_for_tests("fallo de almacenamiento inyectado");

    let (released, kept) = e.core.free_worktrees(&MutationContext::core(), &e.run, true);

    assert!(released.is_empty(), "{released:?}");
    assert!(kept.iter().any(|k| k["task"] == id.as_str()), "{kept:?}");
    assert!(Path::new(&wt).exists());
    assert!(ramas_git(&e).contains("lx/"));
}

// ---------------------------------------------------------------------------------------------
// B5 · rama borrada con la Task retenida: el estado no conserva una referencia a una rama inexistente
// ---------------------------------------------------------------------------------------------

#[test]
fn release_de_una_tarea_fusionada_con_rama_borrada_limpia_task_branch() {
    let e = setup("h-rel-branch");
    let id = hija(&e);
    marca_fusionada(&e.core, &id);
    e.core.mutate(|tx| tx.close(&id, Status::Done, "ok").map(|_| ())).unwrap();
    let antes = head(&e.core);

    let out = e.core.release(&persona(), &Caller::User, &id, false).unwrap();

    assert_eq!(out["branch_deleted"], true);
    assert!(ramas_git(&e).is_empty(), "branch -d la borró");
    assert_eq!(rama_de(&e, &id), None, "State no afirma una rama que ya no existe");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds(&evs), vec!["effect.observed"]);
    assert_eq!(pl(&evs[0])["branch_deleted"], true, "la identidad histórica de la rama queda en effect.observed");
}

#[test]
fn release_con_branch_d_rechazado_conserva_la_rama_y_nunca_usa_d_mayuscula() {
    let e = setup("h-rel-branch-keep");
    let id = hija(&e);
    // La rama gana un commit propio: `branch -d` la rechaza; `-D` la habría borrado.
    let wt = worktree_de(&e, &id);
    std::fs::write(Path::new(&wt).join("trabajo.txt"), "trabajo\n").unwrap();
    g(Path::new(&wt), &["add", "."]);
    g(Path::new(&wt), &["commit", "-qm", "trabajo"]);
    let rama = rama_de(&e, &id).unwrap();
    marca_fusionada(&e.core, &id);
    e.core.mutate(|tx| tx.close(&id, Status::Done, "ok").map(|_| ())).unwrap();

    let out = e.core.release(&persona(), &Caller::User, &id, true).unwrap();

    assert_eq!(out["branch_deleted"], false);
    assert!(ramas_git(&e).contains(&rama), "la rama con trabajo sobrevive");
    assert_eq!(rama_de(&e, &id), Some(rama), "y la Task sigue conociéndola");
}

#[test]
fn free_worktrees_de_una_tarea_fusionada_limpia_task_branch_solo_si_branch_d_funciono() {
    let e = setup("h-fw-branch");
    let borrable = hija(&e);
    let con_trabajo = hija(&e);
    let wt = worktree_de(&e, &con_trabajo);
    std::fs::write(Path::new(&wt).join("trabajo.txt"), "trabajo\n").unwrap();
    g(Path::new(&wt), &["add", "."]);
    g(Path::new(&wt), &["commit", "-qm", "trabajo"]);
    let rama_trabajo = rama_de(&e, &con_trabajo).unwrap();
    for id in [&borrable, &con_trabajo] {
        marca_fusionada(&e.core, id);
        e.core.mutate(|tx| tx.close(id, Status::Done, "ok").map(|_| ())).unwrap();
    }

    let (released, _kept) = e.core.free_worktrees(&MutationContext::core(), &e.run, false);

    assert_eq!(released.len(), 2, "{released:?}");
    assert_eq!(rama_de(&e, &borrable), None, "rama borrada con -d: referencia limpia");
    assert_eq!(rama_de(&e, &con_trabajo), Some(rama_trabajo.clone()), "-d rechazado: la rama sigue siendo suya");
    assert!(ramas_git(&e).contains(&rama_trabajo), "nunca -D");
}

// ---------------------------------------------------------------------------------------------
// B4 · una confirmación que no cambia nada no avanza la rev ni deja eventos
// ---------------------------------------------------------------------------------------------

#[test]
fn apply_found_sobre_una_task_que_ya_es_final_no_confirma_nada() {
    let e = setup("h-apply-final");
    let id = hija(&e);
    e.core.mutate(|tx| tx.close(&id, Status::Stopped, "detenida").map(|_| ())).unwrap();
    let (antes, seq) = (rev(&e.core), head(&e.core));
    // El resultado de la carrera: `collect` la vio viva y, al llegar la mutación, otra acción ya la cerró.
    e.core.apply_found(&id, Found::Nothing, true);
    assert_eq!((rev(&e.core), head(&e.core)), (antes, seq), "ni rev ni eventos");
}

#[test]
fn apply_found_sobre_una_task_retirada_no_confirma_nada() {
    let e = setup("h-apply-gone");
    let id = hija(&e);
    e.core.mutate_as(&MutationContext::core(), |tx| tx.remove_failed_launch(&id)).unwrap();
    let (antes, seq) = (rev(&e.core), head(&e.core));
    e.core.apply_found(&id, Found::Nothing, true);
    assert_eq!((rev(&e.core), head(&e.core)), (antes, seq));
}

#[test]
fn el_sondeo_sin_informe_de_una_task_viva_no_confirma_nada() {
    let e = setup("h-apply-poll");
    let id = hija(&e);
    let (antes, seq) = (rev(&e.core), head(&e.core));
    e.core.collect(&id, Some("salida sin informe".into()), false);
    assert_eq!((rev(&e.core), head(&e.core)), (antes, seq), "el sondeo de cada segundo no es una mutación");
    assert_eq!(e.core.lock().tasks.get(&id).map(|t| t.status.clone()), Some(Status::Running));
}

#[test]
fn un_on_exit_repetido_de_codex_no_vuelve_a_confirmar_el_modelo() {
    let e = setup("h-codex-exit");
    let id = hija(&e);
    e.core.mutate(|tx| {
        tx.task_mut(&id)?.agent = "codex".into();
        Ok(())
    })
    .unwrap();
    e.core.mutate(|tx| tx.close(&id, Status::Stopped, "detenida").map(|_| ())).unwrap();
    e.core.on_exit(&id); // la primera resolución del modelo sí es un cambio legítimo
    let (antes, seq) = (rev(&e.core), head(&e.core));
    e.core.on_exit(&id); // la repetición resuelve lo mismo: nada que confirmar
    assert_eq!((rev(&e.core), head(&e.core)), (antes, seq));
}

// ---------------------------------------------------------------------------------------------
// I8 · causalidad del cleanup: effect.observed y task.removed en la MISMA Tx, en ese orden
// ---------------------------------------------------------------------------------------------

#[test]
fn effect_observed_y_task_removed_comparten_transaccion_y_van_en_orden() {
    let e = setup("h-causa");
    let pid = e.spawn(false);
    e.hook(|_core, _id, step| if step == SpawnStep::InLaunch { Err("launch inyectado".into()) } else { Ok(()) });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    let evs: Vec<_> = desde(&e.core, antes).into_iter().filter(|ev| ev.kind != "spawn.resolved").collect();
    assert_eq!(kinds(&evs), vec!["task.created", "effect.observed", "effect.observed", "task.removed"]);
    let (registro, limpieza, quitada) = (&evs[1], &evs[2], &evs[3]);
    assert_eq!(pl(limpieza)["operation"], "spawn_cleanup");
    assert_eq!(quitada.seq, limpieza.seq + 1, "contiguos: nada se interpone entre el efecto y la retirada");
    assert!(limpieza.state_rev.is_some() && limpieza.state_rev == quitada.state_rev, "misma transacción");
    assert_ne!(registro.state_rev, limpieza.state_rev, "el registro del worktree fue otra mutación anterior");
    assert_eq!(quitada.correlation_id, None, "los hechos de estado no se correlacionan con el efecto (EVENTOS.md)");
}
