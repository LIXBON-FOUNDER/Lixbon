//! Pruebas de los mutadores semánticos de `Tx` (slice E, E1b, primer bloque): CADA hecho produce
//! exactamente los eventos esperados, ni más ni menos, desde un único punto canónico.
//!
//! Se ejecutan sobre un Core REAL (SQLite autoritativa), así que lo que se compara es lo que quedó
//! confirmado en `events`, no los borradores. Cada paso aísla sus eventos con el `seq` previo.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

use super::approval::{Change, Timeout};
use super::boot_tests::*;
use super::delivery::{self, Found};
use super::events::{Channel, EntityKind, EventDraft, EventPayload, MutationContext};
use super::mutation::{Effect, Health, MutateError, StateAccess, Tx};
use super::state::{NewTask, State, Status};
use super::store_boot::StorageStatus;
use super::{Caller, Core};
use crate::store::{EventClass, EventQuery, EventRow};

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

fn core_listo() -> (Limpia, PathBuf, Arc<Core>) {
    let (l, data, core_dir) = dirs();
    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(matches!(core.storage_status(), StorageStatus::Ready(_)));
    core.settings.lock().unwrap().enabled = true;
    (l, data, core)
}

fn nt(titulo: &str) -> NewTask {
    NewTask {
        agent: "claude".into(), model: None, effort: None, role: None, title: titulo.into(), spec: "s".into(),
        repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: false,
    }
}

/// Como `nt`, pero en un repositorio real (para los comandos de RPC que escriben informes).
fn nt_en(repo: &Path, titulo: &str) -> NewTask {
    NewTask { repo: s(repo), cwd: s(repo), ..nt(titulo) }
}

fn head(core: &Core) -> i64 {
    core.storage.with_store(|s| s.events_head().unwrap()).unwrap()
}

fn desde(core: &Core, seq: i64) -> Vec<EventRow> {
    core.storage.with_store(|s| s.events_page(&EventQuery { after: Some(seq), limit: Some(500), ..Default::default() }).unwrap().events).unwrap()
}

/// Ejecuta UNA mutación y devuelve su resultado y los eventos que dejó confirmados.
fn paso<R>(core: &Core, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> (Result<R, MutateError>, Vec<EventRow>) {
    let antes = head(core);
    let r = core.mutate(f);
    (r, desde(core, antes))
}

fn paso_como<R>(core: &Core, ctx: &MutationContext, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> (Result<R, MutateError>, Vec<EventRow>) {
    let antes = head(core);
    let r = core.mutate_as(ctx, f);
    (r, desde(core, antes))
}

fn kinds(evs: &[EventRow]) -> Vec<&str> {
    evs.iter().map(|e| e.kind.as_str()).collect()
}

fn pl(e: &EventRow) -> Value {
    serde_json::from_str(&e.payload).unwrap()
}

/// `(run, raíz, hija a, hija b)`: la raíz y las hijas corriendo. Los eventos de la preparación no se cuentan.
fn escenario(core: &Core) -> (String, String, String, String) {
    core.mutate(|tx| {
        let (run, root) = tx.create_run("obj", NewTask { external: true, ..nt("raiz") });
        tx.mark_running(&root)?;
        let a = tx.add_child(&root, 2, nt("a"))?;
        tx.mark_running(&a)?;
        let b = tx.add_child(&root, 2, nt("b"))?;
        tx.mark_running(&b)?;
        Ok((run, root, a, b))
    })
    .unwrap()
}

fn estado(core: &Core, id: &str) -> Status {
    core.lock().tasks.get(id).unwrap().status
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// ---------------------------------------------------------------------------------------------
// run.* y task.created
// ---------------------------------------------------------------------------------------------

#[test]
fn create_run_emite_run_created_y_task_created_de_la_raiz_y_nada_mas() {
    let (_l, _d, core) = core_listo();
    let (r, evs) = paso(&core, |tx| Ok(tx.create_run("hacer algo importante", nt("raiz"))));
    let (run, root) = r.unwrap();
    assert_eq!(kinds(&evs), vec!["run.created", "task.created"], "la existencia del run y la de su raíz son dos hechos");
    assert_eq!((evs[0].entity_kind.as_str(), evs[0].entity_id.as_str()), ("run", run.as_str()));
    assert_eq!((evs[1].entity_kind.as_str(), evs[1].entity_id.as_str()), ("task", root.as_str()));
    assert_eq!(pl(&evs[0]), json!({ "root_task": root }), "el objetivo (texto libre) no se copia al log");
    assert_eq!(pl(&evs[1]), json!({ "parent": null, "depth": 0, "agent": "claude", "role": null, "model": null, "title": "raiz", "external": false }));
    assert!(evs.iter().all(|e| e.run_id.as_deref() == Some(run.as_str()) && e.class == EventClass::State));
    assert_eq!(evs[0].state_rev, evs[1].state_rev, "salen del mismo commit");
}

#[test]
fn una_hija_produce_unicamente_task_created_y_hereda_el_proyecto() {
    let (_l, _d, core) = core_listo();
    let (_run, root, _a, _b) = escenario(&core);
    core.mutate(|tx| {
        tx.task_mut(&root)?.project_id = Some("p1".into());
        Ok(())
    })
    .unwrap();
    let (r, evs) = paso(&core, |tx| tx.add_child(&root, 2, nt("c")));
    let hija = r.unwrap();
    assert_eq!(kinds(&evs), vec!["task.created"]);
    assert_eq!(pl(&evs[0])["parent"], json!(root));
    assert_eq!(pl(&evs[0])["depth"], 1);
    assert_eq!(evs[0].entity_id, hija);
    assert_eq!(evs[0].project_id.as_deref(), Some("p1"), "el proyecto de la hija sale de su Task.project_id (heredado), sin git");
}

#[test]
fn solo_task_created_de_la_hija_lleva_la_correlacion_del_pending() {
    let (_l, _d, core) = core_listo();
    let (_run, root, _a, _b) = escenario(&core);
    let pending_id = "sp-correlation-only";
    let (r, evs) = paso(&core, |tx| {
        let child = tx.add_child_for_spawn(&root, 2, nt("hija"), pending_id)?;
        tx.mark_running(&child)?;
        Ok(child)
    });
    assert!(r.is_ok());
    assert_eq!(kinds(&evs), vec!["task.created", "task.status_changed"]);
    assert_eq!(evs[0].correlation_id.as_deref(), Some(pending_id));
    assert_eq!(evs[1].correlation_id, None, "ningún otro evento hereda la correlación del pending");
}

#[test]
fn el_proyecto_se_resuelve_al_finalizar_aunque_se_complete_despues_de_crear_el_run() {
    let (_l, _d, core) = core_listo();
    // Como `run_create`: crea el run y SOLO DESPUÉS completa `project_id`, antes del commit.
    let (_r, evs) = paso(&core, |tx| {
        let (_run, root) = tx.create_run("obj", nt("raiz"));
        tx.task_mut(&root)?.project_id = Some("proy-7".into());
        Ok(())
    });
    assert_eq!(kinds(&evs), vec!["run.created", "task.created"]);
    assert!(evs.iter().all(|e| e.project_id.as_deref() == Some("proy-7")), "{evs:?}");
    // Sin proyecto: NULL es válido (tarea legacy o repositorio ambiguo).
    let (_r, evs) = paso(&core, |tx| {
        tx.create_run("otro", nt("raiz"));
        Ok(())
    });
    assert!(evs.iter().all(|e| e.project_id.is_none()));
}

#[test]
fn close_run_emite_las_transiciones_reales_y_run_closed_al_final() {
    let (_l, _d, core) = core_listo();
    let (run, root, a, b) = escenario(&core);
    // Una hija ya terminó: no cambia de estado, no emite transición.
    core.mutate(|tx| tx.done(&b, true, "ok", vec![], None).map(|_| ())).unwrap();
    // Sin --force y con hijas abiertas: se rechaza y no deja nada.
    let (r, evs) = paso(&core, |tx| tx.close_run(&run, false).map(|_| ()));
    assert!(matches!(r, Err(MutateError::Rejected(_))));
    assert!(evs.is_empty());

    let (r, evs) = paso(&core, |tx| tx.close_run(&run, true));
    let (stopped, _) = r.unwrap();
    assert_eq!(stopped, vec![a.clone()]);
    assert_eq!(kinds(&evs), vec!["task.status_changed", "task.status_changed", "run.closed"], "{evs:?}");
    let por_tarea: Vec<(&str, Value)> = evs[..2].iter().map(|e| (e.entity_id.as_str(), pl(e))).collect();
    assert!(por_tarea.contains(&(a.as_str(), json!({ "from": "running", "to": "stopped", "cause": "run_closed" }))));
    assert!(por_tarea.contains(&(root.as_str(), json!({ "from": "running", "to": "done", "cause": "run_closed" }))));
    assert!(!por_tarea.iter().any(|(id, _)| *id == b), "la hija que ya había terminado no emite transición");
    assert_eq!(pl(&evs[2]), json!({ "forced": true, "stopped": [a], "stopped_total": 1 }));
    assert_eq!((evs[2].entity_kind.as_str(), evs[2].entity_id.as_str()), ("run", run.as_str()));
}

#[test]
fn remove_run_emite_run_removed_con_el_proyecto_de_antes_de_borrar() {
    let (_l, _d, core) = core_listo();
    let (run, root, _a, _b) = escenario(&core);
    core.mutate(|tx| {
        tx.task_mut(&root)?.project_id = Some("p9".into());
        Ok(())
    })
    .unwrap();
    let (r, evs) = paso(&core, |tx| {
        tx.remove_run(&run);
        Ok(())
    });
    r.unwrap();
    assert_eq!(kinds(&evs), vec!["run.removed"]);
    assert_eq!(pl(&evs[0]), json!({ "tasks": 3 }));
    assert_eq!(evs[0].project_id.as_deref(), Some("p9"), "las tareas ya no existen al finalizar: el proyecto se tomó ANTES");
    assert!(core.lock().runs.is_empty());
    // Un run que no existe no es un hecho.
    let (_r, evs) = paso(&core, |tx| {
        tx.remove_run("r-no-existe");
        tx.no_change();
        Ok(())
    });
    assert!(evs.is_empty());
}

// ---------------------------------------------------------------------------------------------
// task.status_changed: solo si el estado cambió de verdad
// ---------------------------------------------------------------------------------------------

#[test]
fn mark_running_emite_una_transicion_real_y_ninguna_si_ya_corre() {
    let (_l, _d, core) = core_listo();
    let (_r, evs) = paso(&core, |tx| {
        let (_run, root) = tx.create_run("obj", nt("raiz"));
        tx.mark_running(&root)?;
        Ok(())
    });
    assert_eq!(kinds(&evs), vec!["run.created", "task.created", "task.status_changed"]);
    assert_eq!(pl(&evs[2]), json!({ "from": "starting", "to": "running" }));
    let root = evs[1].entity_id.clone();
    // Ya corre: from == to, no hay evento.
    let (r, evs) = paso(&core, |tx| tx.mark_running(&root));
    r.unwrap();
    assert!(evs.is_empty(), "no se emite status_changed con from == to: {evs:?}");
}

#[test]
fn done_emite_una_sola_transicion_y_una_tarea_final_no_vuelve_a_cambiar() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, b) = escenario(&core);
    let (r, evs) = paso(&core, |tx| tx.done(&a, true, "listo", vec!["x.rs".into()], None));
    r.unwrap();
    assert_eq!(kinds(&evs), vec!["task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "done" }));
    assert_eq!(evs[0].entity_id, a);
    let (_r, evs) = paso(&core, |tx| tx.done(&b, false, "falló", vec![], None).map(|_| ()));
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "failed" }));
    // Un `done` tardío es un error del mutador: ni estado ni eventos.
    let (r, evs) = paso(&core, |tx| tx.done(&a, true, "otra vez", vec![], None).map(|_| ()));
    assert!(matches!(r, Err(MutateError::Rejected(_))));
    assert!(evs.is_empty());
    assert_eq!(estado(&core, &a), Status::Done);
}

#[test]
fn phase_emite_task_phase_y_status_changed_solo_si_el_estado_cambio() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, b) = escenario(&core);
    // Corriendo: solo el hecho de contenido.
    let largo = "n".repeat(500);
    let (r, evs) = paso(&core, |tx| tx.phase(&a, "análisis", false, &largo));
    r.unwrap();
    assert_eq!(kinds(&evs), vec!["task.phase"]);
    assert_eq!(pl(&evs[0])["name"], "análisis");
    assert_eq!(pl(&evs[0]), json!({ "name": "análisis", "done": false }), "solo el hecho estructural: la nota (texto libre) se queda en el estado");
    assert!(!evs[0].payload.contains("nnnn"), "la nota no aparece en ningún sitio del payload");
    // En espera: la fase la devuelve a `running` -> dos hechos distintos.
    core.mutate(|tx| tx.ask(&b, "¿seguimos?").map(|_| ())).unwrap();
    let (_r, evs) = paso(&core, |tx| tx.phase(&b, "pruebas", true, "").map(|_| ()));
    assert_eq!(kinds(&evs), vec!["task.phase", "task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "name": "pruebas", "done": true }));
    assert_eq!(pl(&evs[1]), json!({ "from": "waiting", "to": "running", "cause": "phase" }));
}

#[test]
fn ask_y_reply_emiten_contenido_y_la_transicion_real() {
    let (_l, _d, core) = core_listo();
    let (_run, root, a, _b) = escenario(&core);
    let ctx_hija = MutationContext::agent(&a, Channel::Lxo);
    let (r, evs) = paso_como(&core, &ctx_hija, |tx| tx.ask(&a, "¿qué rama uso?"));
    let q = r.unwrap();
    assert_eq!(kinds(&evs), vec!["task.question", "task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "message_id": q, "to": root }), "el cuerpo de la pregunta no viaja en el evento");
    assert_eq!(pl(&evs[1]), json!({ "from": "running", "to": "waiting", "cause": "question" }));
    assert!(evs.iter().all(|e| e.actor_kind.as_str() == "agent" && e.actor_id.as_deref() == Some(a.as_str()) && e.channel.as_deref() == Some("lxo")));
    assert_eq!(evs[0].correlation_id.as_deref(), Some(format!("q{q}").as_str()));

    // La respuesta: la entidad es la tarea que PREGUNTÓ; el actor, quien responde.
    let ctx_raiz = MutationContext::agent(&root, Channel::Lxo);
    let (r, evs) = paso_como(&core, &ctx_raiz, |tx| tx.reply(&root, q, "la principal"));
    let reply = r.unwrap();
    assert_eq!(kinds(&evs), vec!["task.reply", "task.status_changed"]);
    assert_eq!((evs[0].entity_id.as_str(), evs[0].actor_id.as_deref()), (a.as_str(), Some(root.as_str())));
    assert_eq!(pl(&evs[0]), json!({ "question_id": q, "message_id": reply }), "quien responde es el actor del evento, no un campo");
    assert_eq!(evs[0].correlation_id, Some(format!("q{q}")), "la respuesta se correlaciona con la pregunta");
    assert_eq!(pl(&evs[1]), json!({ "from": "waiting", "to": "running", "cause": "answered" }));
}

#[test]
fn una_respuesta_a_quien_ya_termino_no_emite_transicion() {
    let (_l, _d, core) = core_listo();
    let (_run, root, a, _b) = escenario(&core);
    let q = core.mutate(|tx| tx.ask(&a, "¿?")).unwrap();
    core.mutate(|tx| tx.close(&a, Status::Stopped, "detenida").map(|_| ())).unwrap();
    let (r, evs) = paso(&core, |tx| tx.reply(&root, q, "tarde"));
    r.unwrap();
    assert_eq!(kinds(&evs), vec!["task.reply"], "la que preguntó ya era final: no hay cambio de estado");
}

#[test]
fn reopen_close_y_fail_with_emiten_una_transicion_cada_uno() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, b) = escenario(&core);
    core.mutate(|tx| tx.done(&a, true, "ok", vec![], None).map(|_| ())).unwrap();
    let (r, evs) = paso(&core, |tx| tx.reopen(&a, "más trabajo"));
    r.unwrap();
    assert_eq!((kinds(&evs), pl(&evs[0])), (vec!["task.status_changed"], json!({ "from": "done", "to": "running", "cause": "reopened" })));

    let (_r, evs) = paso(&core, |tx| tx.close(&b, Status::Stopped, "detenida").map(|_| ()));
    assert_eq!((kinds(&evs), pl(&evs[0])), (vec!["task.status_changed"], json!({ "from": "running", "to": "stopped" })));
    // Cerrar lo que ya está cerrado no es un hecho.
    let (r, evs) = paso(&core, |tx| tx.close(&b, Status::Exited, "otra vez").map(|_| ()));
    r.unwrap();
    assert!(evs.is_empty(), "{evs:?}");

    let (_r, evs) = paso(&core, |tx| tx.fail_with(&a, "agent_idle_timeout", "mudo").map(|_| ()));
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "failed", "cause": "agent_idle_timeout" }));
    let (_r, evs) = paso(&core, |tx| tx.fail_with(&a, "agent_idle_timeout", "mudo").map(|_| ()));
    assert!(evs.is_empty(), "ya fallida");
}

#[test]
fn la_espera_de_aprobacion_en_terminal_emite_solo_cambios_reales() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let (r, evs) = paso(&core, |tx| tx.await_terminal_approval(&a, 123));
    assert!(r.unwrap());
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "awaiting_terminal_approval", "cause": "terminal_approval" }));
    // Cambia el plazo pero no el estado: no hay transición.
    let (_r, evs) = paso(&core, |tx| tx.await_terminal_approval(&a, 456).map(|_| ()));
    assert!(evs.is_empty(), "from == to: {evs:?}");
    let (r, evs) = paso(&core, |tx| tx.resume_from_approval(&a));
    assert!(r.unwrap());
    assert_eq!(pl(&evs[0]), json!({ "from": "awaiting_terminal_approval", "to": "running", "cause": "terminal_approval" }));
    let (r, evs) = paso(&core, |tx| {
        let changed = tx.resume_from_approval(&a)?;
        tx.no_change();
        Ok(changed)
    });
    assert!(!r.unwrap() && evs.is_empty());
}

#[test]
fn orphan_all_emite_una_transicion_por_tarea_abierta_no_externa() {
    let (_l, _d, core) = core_listo();
    let (_run, root, a, b) = escenario(&core);
    core.mutate(|tx| tx.done(&b, true, "ok", vec![], None).map(|_| ())).unwrap(); // ya final
    let (_r, evs) = paso(&core, |tx| {
        tx.orphan_all();
        Ok(())
    });
    assert_eq!(kinds(&evs), vec!["task.status_changed"]);
    assert_eq!(evs[0].entity_id, a);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "exited", "cause": "orphaned" }));
    assert_eq!(estado(&core, &root), Status::Running, "la raíz es externa: sigue su propio curso");
    assert_eq!((evs[0].actor_kind.as_str(), evs[0].channel.as_deref()), ("system", Some("core")), "lo cierra el Core");
}

// ---------------------------------------------------------------------------------------------
// delivery::apply cierra con los mismos mutadores: no construye ni duplica eventos
// ---------------------------------------------------------------------------------------------

#[test]
fn delivery_apply_pasa_por_tx_y_emite_lo_mismo_que_un_cierre_normal() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, b) = escenario(&core);
    // Sin informe al salir el proceso: la tarea queda `exited` (un solo evento).
    let (r, evs) = paso(&core, |tx| delivery::apply(tx, &a, Found::Nothing, true));
    r.unwrap();
    assert_eq!(kinds(&evs), vec!["task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "exited" }));
    // Informe inválido al salir: `failed`.
    let (_r, evs) = paso(&core, |tx| delivery::apply(tx, &b, Found::Invalid("roto".into()), true));
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "failed" }));
    // Una tarea ya final no vuelve a emitir.
    let (_r, evs) = paso(&core, |tx| delivery::apply(tx, &a, Found::Nothing, true));
    assert!(evs.is_empty());
}

#[test]
fn los_vigilantes_de_terminal_emiten_como_el_core_una_sola_transicion() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, b) = escenario(&core);
    // La CLI queda esperando una aprobación en su terminal.
    let antes = head(&core);
    core.on_approval_change(&a, Change::Entered(999));
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "awaiting_terminal_approval", "cause": "terminal_approval" }));
    assert_eq!((evs[0].actor_kind.as_str(), evs[0].actor_id.as_deref(), evs[0].channel.as_deref()), ("system", None, Some("core")));
    // Repetir la observación con otro plazo cambia el plazo (una mutación) pero NO el estado: sin evento.
    let (rev_antes, antes) = (core.storage.confirmed_rev().unwrap(), head(&core));
    core.on_approval_change(&a, Change::Entered(1000));
    assert_eq!(desde(&core, antes).len(), 0, "sin cambio de estado, sin evento");
    assert_eq!(core.storage.confirmed_rev().unwrap(), rev_antes.map(|r| r + 1), "la mutación del plazo sí se confirmó");
    // El agente sigue: sale de la espera.
    let antes = head(&core);
    core.on_approval_change(&a, Change::Left);
    assert_eq!(pl(&desde(&core, antes)[0]), json!({ "from": "awaiting_terminal_approval", "to": "running", "cause": "terminal_approval" }));
    // Vence la vigilancia: falla con el motivo máquina (una sola transición).
    let antes = head(&core);
    core.on_guard_timeout(&b, Timeout::Idle);
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "failed", "cause": "agent_idle_timeout" }));
    assert_eq!((evs[0].actor_kind.as_str(), evs[0].channel.as_deref()), ("system", Some("core")));
}

// ---------------------------------------------------------------------------------------------
// RPC: el actor y el canal salen de la superficie real, y ninguna capa re-emite el hecho
// ---------------------------------------------------------------------------------------------

fn g(dir: &Path, args: &[&str]) {
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
}

fn repo(data: &Path) -> PathBuf {
    let dir = data.parent().unwrap().join("repos").join("app");
    std::fs::create_dir_all(&dir).unwrap();
    g(&dir, &["init", "-q", "-b", "main"]);
    g(&dir, &["config", "user.name", "t"]);
    g(&dir, &["config", "user.email", "t@t"]);
    std::fs::write(dir.join("a.txt"), "base\n").unwrap();
    g(&dir, &["add", "."]);
    g(&dir, &["commit", "-qm", "base"]);
    dir
}

#[test]
fn run_create_emite_tres_hechos_atribuidos_a_la_raiz_y_con_el_proyecto_ya_completado() {
    let (_l, data, core) = core_listo();
    let r = repo(&data);
    let antes = head(&core);
    let out = core.rpc(Caller::Agent(None), &s(&r), "run_create", &json!({ "objective": "hacer algo" })).unwrap();
    let (run, root) = (out["run"].as_str().unwrap().to_string(), out["task"].as_str().unwrap().to_string());
    let mut evs = desde(&core, antes);
    assert_eq!(
        kinds(&evs),
        vec!["project.registered", "run.created", "task.created", "task.status_changed"],
        "el repositorio nuevo nace ANTES (registro automático); después, un hecho un evento: rpc no vuelve a emitir nada"
    );
    // El proyecto nace por el registro automático: quien lanza es un agente sin identidad, así que lo registra el sistema.
    let nacimiento = evs.remove(0);
    assert_eq!((nacimiento.actor_kind.as_str(), nacimiento.actor_id.as_deref(), nacimiento.channel.as_deref()), ("system", None, Some("lxo")));
    // Bootstrap de identidad: un coordinador aún no registrado actúa como la tarea raíz que acaba de crear.
    assert!(evs.iter().all(|e| e.actor_kind.as_str() == "agent" && e.actor_id.as_deref() == Some(root.as_str()) && e.channel.as_deref() == Some("lxo")), "{evs:?}");
    let pid = core.lock().tasks.get(&root).unwrap().project_id.clone().expect("el repositorio nuevo se registró solo");
    assert!(evs.iter().all(|e| e.project_id.as_deref() == Some(pid.as_str())), "project_id completado tras crear el run y resuelto al finalizar");
    assert_eq!(pl(&evs[2]), json!({ "from": "starting", "to": "running" }));
    assert_eq!(evs[0].run_id.as_deref(), Some(run.as_str()));

    // Una PERSONA autenticada desde la interfaz: el actor y el client_id salen de su credencial.
    let antes = head(&core);
    core.rpc(Caller::User, &s(&r), "run_create", &json!({ "objective": "otro" })).unwrap();
    let evs = desde(&core, antes);
    let client_id = evs[0].client_id.as_deref().expect("client_id autenticado");
    assert!(evs.iter().all(|e| {
        e.actor_kind.as_str() == "person"
            && e.actor_id.as_deref() == Some("user")
            && e.channel.as_deref() == Some("ui")
            && e.client_id.as_deref() == Some(client_id)
    }), "{evs:?}");
}

#[test]
fn cada_comando_de_rpc_deja_exactamente_los_eventos_de_su_mutador_con_su_actor() {
    let (_l, data, core) = core_listo();
    let r = repo(&data);
    let out = core.rpc(Caller::Agent(None), &s(&r), "run_create", &json!({ "objective": "obj" })).unwrap();
    let (run, root) = (out["run"].as_str().unwrap().to_string(), out["task"].as_str().unwrap().to_string());
    let nueva_hija = |titulo: &str| {
        core.mutate(|tx| {
            let id = tx.add_child(&root, 2, nt_en(&r, titulo))?;
            tx.mark_running(&id)?;
            Ok(id)
        })
        .unwrap()
    };
    let hija = nueva_hija("hija");
    let agente = |t: &str| Caller::Agent(Some(t.to_string()));
    let ejecuta = |caller: Caller, cmd: &str, args: Value| -> Vec<EventRow> {
        let antes = head(&core);
        core.rpc(caller, &s(&r), cmd, &args).unwrap();
        desde(&core, antes)
    };

    // phase (agente, lxo)
    let evs = ejecuta(agente(&hija), "phase", json!({ "name": "diseño" }));
    assert_eq!(kinds(&evs), vec!["task.phase"]);
    assert_eq!((evs[0].actor_kind.as_str(), evs[0].actor_id.as_deref(), evs[0].channel.as_deref()), ("agent", Some(hija.as_str()), Some("lxo")));
    // ask (agente) -> pregunta + espera
    let evs = ejecuta(agente(&hija), "ask", json!({ "question": "¿rama?" }));
    assert_eq!(kinds(&evs), vec!["task.question", "task.status_changed"]);
    let q = pl(&evs[0])["message_id"].as_u64().unwrap();
    // reply (PERSONA desde la interfaz) -> respuesta + vuelve a correr
    let evs = ejecuta(Caller::User, "reply", json!({ "question": q, "answer": "main" }));
    assert_eq!(kinds(&evs), vec!["task.reply", "task.status_changed"]);
    let client_id = evs[0].client_id.as_deref().expect("client_id autenticado");
    assert!(evs.iter().all(|e| {
        e.actor_kind.as_str() == "person"
            && e.actor_id.as_deref() == Some("user")
            && e.channel.as_deref() == Some("ui")
            && e.client_id.as_deref() == Some(client_id)
    }));
    assert_eq!(evs[0].entity_id, hija, "la respuesta cuelga de la tarea que preguntó");
    // send / check no son hechos del Event Log.
    assert!(ejecuta(Caller::User, "send", json!({ "to": hija, "body": "ánimo" })).is_empty());
    assert!(ejecuta(agente(&hija), "check", json!({})).is_empty());
    // done (agente)
    let evs = ejecuta(agente(&hija), "done", json!({ "summary": "listo", "report_text": "informe" }));
    assert_eq!(kinds(&evs), vec!["task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "done" }));
    // stop (PERSONA) de otra hija
    let otra = nueva_hija("otra");
    let evs = ejecuta(Caller::User, "stop", json!({ "task": otra }));
    assert_eq!(kinds(&evs), vec!["task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "stopped" }));
    assert_eq!((evs[0].actor_kind.as_str(), evs[0].channel.as_deref()), ("person", Some("ui")));
    // run_close (la raíz, agente) -> transición de la raíz + run.closed
    let evs = ejecuta(agente(&root), "run_close", json!({}));
    assert_eq!(kinds(&evs), vec!["task.status_changed", "run.closed"]);
    assert_eq!(evs[1].entity_id, run);
    // remove_run (PERSONA)
    let evs = ejecuta(Caller::User, "remove_run", json!({ "run": run }));
    assert_eq!(kinds(&evs), vec!["run.removed"]);
    assert_eq!((evs[0].actor_kind.as_str(), evs[0].channel.as_deref()), ("person", Some("ui")));
}

#[test]
fn un_agente_sin_identidad_no_produce_eventos_atribuidos_a_un_agente_inexistente() {
    let (_l, data, core) = core_listo();
    let r = repo(&data);
    let antes = head(&core);
    for cmd in ["phase", "ask", "done", "stop", "release", "continue", "run_close"] {
        let e = core.rpc(Caller::Agent(None), &s(&r), cmd, &json!({ "name": "x", "question": "x", "task": "t1", "summary": "x", "spec": "x" })).unwrap_err();
        assert!(!e.is_empty(), "{cmd}");
    }
    assert_eq!(head(&core), antes, "nada se emitió");
}

// ---------------------------------------------------------------------------------------------
// Adaptador de pruebas de StateAccess y arquitectura
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
struct Prueba {
    n: u32,
}

impl EventPayload for Prueba {
    const KIND: &'static str = "test.prueba";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[test]
fn el_adaptador_de_pruebas_valida_los_borradores_igual_que_produccion_y_descarta_los_eventos() {
    let st = Mutex::new(State::default());
    st.mutate(|tx| {
        tx.create_run("obj", nt("raiz"));
        Ok(())
    })
    .unwrap();
    assert_eq!(st.read(|s| s.runs.len()), 1, "un cierre válido publica el estado (los eventos se descartan)");
    // Una instrumentación inválida también falla aquí y NO publica el estado.
    let r = st.mutate(|tx| {
        tx.create_run("otro", nt("raiz"));
        tx.push_event(EventDraft::new(EntityKind::Core, "core", &Prueba { n: 1 }).unwrap().idempotent(""));
        Ok(())
    });
    assert!(matches!(&r, Err(m) if m.contains("idem_key")), "{r:?}");
    assert_eq!(st.read(|s| s.runs.len()), 1, "el estado no se publicó");
}

#[test]
fn el_adaptador_de_pruebas_respeta_no_change_igual_que_produccion() {
    let st = Mutex::new(State::default());
    st.mutate(|tx| {
        tx.create_run("obj", nt("raiz"));
        Ok(())
    })
    .unwrap();
    let antes = serde_json::to_string(&st.read(|s| s.clone())).unwrap();
    // Se modifica el candidato, se llama a `no_change` y se devuelve Ok: el candidato se descarta.
    let r = st.mutate(|tx| {
        tx.create_run("descartado", nt("otra"));
        tx.no_change();
        Ok(7)
    });
    assert_eq!(r, Ok(7), "el valor del cierre se devuelve igualmente");
    assert_eq!(serde_json::to_string(&st.read(|s| s.clone())).unwrap(), antes, "no_change: el estado queda idéntico");
    // `no_change` descarta también los borradores: no se validan (como en `mutate_locked`).
    let r = st.mutate(|tx| {
        tx.create_run("descartado", nt("otra"));
        tx.push_event(EventDraft::new(EntityKind::Core, "core", &Prueba { n: 1 }).unwrap().idempotent(""));
        tx.no_change();
        Ok(())
    });
    assert!(r.is_ok(), "{r:?}");
    assert_eq!(serde_json::to_string(&st.read(|s| s.clone())).unwrap(), antes);
    // Un cierre que devuelve Err tampoco publica.
    let r: Result<(), String> = st.mutate(|tx| {
        tx.create_run("descartado", nt("otra"));
        Err("no".into())
    });
    assert_eq!(r, Err("no".into()));
    assert_eq!(serde_json::to_string(&st.read(|s| s.clone())).unwrap(), antes, "Err: no se publica");
    // Solo un Tx válido y cambiado sustituye el estado.
    st.mutate(|tx| {
        tx.create_run("otro", nt("otra"));
        Ok(())
    })
    .unwrap();
    assert_eq!(st.read(|s| s.runs.len()), 2);
}

// ---------------------------------------------------------------------------------------------
// collect: el agente produce (o no) el informe; el Core diagnostica y decide el cierre
// ---------------------------------------------------------------------------------------------

fn informe(summary: &str) -> delivery::Report {
    delivery::Report {
        ok: true,
        summary: summary.into(),
        files: vec![],
        report: None,
        sha256: "ab".repeat(32),
        channel: delivery::Channel::Stdout,
        model: None,
        session_id: None,
    }
}

/// `(a, b, c)`: tres hijas corriendo en un repositorio real (el informe válido escribe un archivo).
fn tres_en_repo(core: &Core, data: &Path) -> (String, String, String) {
    let r = repo(data);
    core.mutate(|tx| {
        let (_run, root) = tx.create_run("obj", NewTask { external: true, ..nt_en(&r, "raiz") });
        tx.mark_running(&root)?;
        let mut hijas = Vec::new();
        for t in ["a", "b", "c"] {
            let h = tx.add_child(&root, 2, nt_en(&r, t))?;
            tx.mark_running(&h)?;
            hijas.push(h);
        }
        Ok((hijas[0].clone(), hijas[1].clone(), hijas[2].clone()))
    })
    .unwrap()
}

fn actor_y_canal(e: &EventRow) -> (&str, Option<&str>, Option<&str>) {
    (e.actor_kind.as_str(), e.actor_id.as_deref(), e.channel.as_deref())
}

#[test]
fn collect_atribuye_el_informe_valido_al_agente_y_el_resto_al_core() {
    let (_l, data, core) = core_listo();
    let (a, b, c) = tres_en_repo(&core, &data);

    // Informe válido aceptado: lo produjo el agente (Agent(task) / Core).
    let antes = head(&core);
    core.apply_found(&a, Found::Valid(informe("hecho")), true);
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "done" }));
    assert_eq!(actor_y_canal(&evs[0]), ("agent", Some(a.as_str()), Some("core")));

    // Informe inválido al salir: el agente no produjo nada utilizable; el Core cierra `failed` (System / Core).
    let antes = head(&core);
    core.apply_found(&b, Found::Invalid("roto".into()), true);
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "failed" }));
    assert_eq!(actor_y_canal(&evs[0]), ("system", None, Some("core")), "informe inválido: lo decide el Core");

    // Proceso que sale sin informe: el Core lo deja `exited` (System / Core).
    let antes = head(&core);
    core.apply_found(&c, Found::Nothing, true);
    let evs = desde(&core, antes);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "exited" }));
    assert_eq!(actor_y_canal(&evs[0]), ("system", None, Some("core")), "sin informe: lo decide el Core");
}

#[test]
fn collect_no_entregado_y_el_fallback_de_aplicacion_son_del_core() {
    let (_l, data, core) = core_listo();
    let (a, b, _c) = tres_en_repo(&core, &data);

    // Informe no entregado por ninguna vía válida: Failed decidido por el Core.
    let antes = head(&core);
    core.apply_found(&a, Found::Undelivered("demasiado grande".into()), true);
    let evs = desde(&core, antes);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "failed" }));
    assert_eq!(actor_y_canal(&evs[0]), ("system", None, Some("core")));

    // Informe «válido» que no se puede aplicar (el run ya no tiene coordinador): el Core cierra Failed,
    // aunque el contexto inicial fuera el del agente.
    core.mutate(|tx| {
        let run = tx.task(&b)?.run.clone();
        let root = tx.runs.get(&run).map(|r| r.root.clone()).unwrap();
        tx.tasks.remove(&root);
        Ok(())
    })
    .unwrap();
    let antes = head(&core);
    core.apply_found(&b, Found::Valid(informe("hecho")), true);
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["task.status_changed"]);
    assert_eq!(pl(&evs[0]), json!({ "from": "running", "to": "failed" }));
    assert_eq!(actor_y_canal(&evs[0]), ("system", None, Some("core")), "fallback del Core tras fallar la aplicación");
}

// ---------------------------------------------------------------------------------------------
// decision.recorded: un único mutador (`Tx::record_decision`), payload cerrado, actor validado
// ---------------------------------------------------------------------------------------------

fn persona_ui() -> MutationContext {
    MutationContext::person(Channel::Ui)
}

/// Una decisión por el mutador semántico, como una persona desde la interfaz.
fn decide(core: &Core, task: &str, kind: &str, detail: Value) -> (Result<u64, MutateError>, Vec<EventRow>) {
    paso_como(core, &persona_ui(), |tx| tx.record_decision(task, kind, "human", &detail))
}

fn rechazada<T: std::fmt::Debug>(r: &Result<T, MutateError>, fragmento: &str) {
    assert!(matches!(r, Err(MutateError::Rejected(m)) if m.contains(fragmento)), "se esperaba un rechazo con «{fragmento}»: {r:?}");
}

const SECRETOS: [&str; 6] = ["SECRETO-COMENTARIO", "/ruta/secreta", "token@host", "TEXTO-ERROR", "conflicto-uno.txt", "MENSAJE-GIT"];

#[test]
fn cada_decision_de_una_persona_emite_un_decision_recorded_con_su_payload_cerrado() {
    let (_l, _d, core) = core_listo();
    let (run, _root, a, _b) = escenario(&core);
    core.mutate(|tx| {
        tx.task_mut(&a)?.project_id = Some("p1".into());
        Ok(())
    })
    .unwrap();
    let casos: Vec<(&str, Value, Value)> = vec![
        (
            "review",
            json!({ "decision": "accepted", "base_commit": "b1", "base_source": "task_base", "head_commit": "h1", "comment": "SECRETO-COMENTARIO" }),
            json!({ "decision_kind": "review", "outcome": "accepted", "head_commit": "h1", "base_commit": "b1", "base_source": "task_base", "has_comment": true }),
        ),
        (
            "review",
            json!({ "decision": "rejected", "base_commit": null, "base_source": null, "head_commit": "h2", "comment": null }),
            json!({ "decision_kind": "review", "outcome": "rejected", "head_commit": "h2", "has_comment": false }),
        ),
        (
            "merge",
            json!({ "outcome": "merged", "branch": "lx/t", "into": "/ruta/secreta", "squash": true, "base_commit": "b", "result_commit": "r",
                    "conflicts": null, "base_check": "ok", "message": "MENSAJE-GIT" }),
            json!({ "decision_kind": "merge", "outcome": "merged", "branch": "lx/t", "squash": true, "base_commit": "b", "result_commit": "r", "base_check": "ok" }),
        ),
        (
            "merge",
            json!({ "outcome": "conflict", "branch": "lx/t", "into": "/ruta/secreta", "squash": false, "base_commit": "b", "result_commit": null,
                    "conflicts": ["conflicto-uno.txt", "dos.txt"], "base_check": "sin_referencia", "message": "MENSAJE-GIT" }),
            json!({ "decision_kind": "merge", "outcome": "conflict", "branch": "lx/t", "squash": false, "base_commit": "b", "conflict_count": 2, "base_check": "sin_referencia" }),
        ),
        (
            "merge",
            json!({ "outcome": "error", "branch": "lx/t", "into": "/ruta/secreta", "squash": false, "base_commit": null, "result_commit": null,
                    "conflicts": null, "base_check": "ok", "message": "MENSAJE-GIT" }),
            json!({ "decision_kind": "merge", "outcome": "error", "branch": "lx/t", "squash": false, "base_check": "ok" }),
        ),
        (
            "merge",
            json!({ "outcome": "target_moved", "branch": "lx/t", "into": "/ruta/secreta", "squash": false, "expected_commit": "e", "found_commit": "f" }),
            json!({ "decision_kind": "merge", "outcome": "target_moved", "branch": "lx/t", "squash": false, "expected_commit": "e", "found_commit": "f" }),
        ),
        (
            "merge",
            json!({ "outcome": "merged", "branch": "lx/t", "into": "/ruta/secreta", "squash": false, "base_commit": "f", "result_commit": "r", "conflicts": null,
                    "base_check": "ok", "accepted_moved_target": true, "expected_commit": "e", "found_commit": "f" }),
            json!({ "decision_kind": "merge", "outcome": "merged", "branch": "lx/t", "squash": false, "base_commit": "f", "result_commit": "r", "base_check": "ok",
                    "accepted_moved_target": true, "expected_commit": "e", "found_commit": "f" }),
        ),
        (
            "pr",
            json!({ "outcome": "created", "branch": "lx/t", "remote": "https://token@host/x.git", "pr_url": "https://github.com/o/r/pull/1" }),
            json!({ "decision_kind": "pr", "outcome": "created", "branch": "lx/t", "pr_url": "https://github.com/o/r/pull/1" }),
        ),
        (
            "pr",
            json!({ "outcome": "already_exists", "branch": "lx/t", "remote": "https://token@host/x.git", "pr_url": "https://github.com/o/r/pull/1" }),
            json!({ "decision_kind": "pr", "outcome": "already_exists", "branch": "lx/t", "pr_url": "https://github.com/o/r/pull/1" }),
        ),
        (
            "pr",
            json!({ "outcome": "created", "branch": "lx/t", "pr_url": "https://user:SECRETO@github.com/o/r/pull/1?token=SECRETO#SECRETO" }),
            json!({ "decision_kind": "pr", "outcome": "created", "branch": "lx/t", "pr_url": "https://github.com/o/r/pull/1" }),
        ),
        (
            "pr",
            json!({ "outcome": "created", "branch": "lx/t", "pr_url": "https://user:pa/ss@github.com/o/r/pull/1;x=SECRETO" }),
            json!({ "decision_kind": "pr", "outcome": "created", "branch": "lx/t" }),
        ),
        (
            "pr",
            json!({ "outcome": "error", "branch": "lx/t", "remote": null, "pr_url": null, "error": "TEXTO-ERROR" }),
            json!({ "decision_kind": "pr", "outcome": "error", "branch": "lx/t" }),
        ),
    ];
    let mut ultimo_seq = head(&core);
    for (kind, detail, esperado) in casos {
        let (r, evs) = decide(&core, &a, kind, detail);
        let id = r.unwrap_or_else(|e| panic!("{kind}: {e:?}"));
        assert_eq!(kinds(&evs), vec!["decision.recorded"], "{kind}: una decisión, un evento");
        let mut con_id = esperado.clone();
        con_id["decision_id"] = json!(id);
        assert_eq!(pl(&evs[0]), con_id, "{kind}");
        assert!(SECRETOS.iter().all(|s| !evs[0].payload.contains(s)), "{kind}: ni comentarios, ni rutas, ni mensajes, ni errores: {}", evs[0].payload);
        let e = &evs[0];
        assert_eq!((e.class, e.entity_kind.as_str(), e.entity_id.as_str()), (EventClass::Decision, "task", a.as_str()));
        assert_eq!((e.project_id.as_deref(), e.run_id.as_deref()), (Some("p1"), Some(run.as_str())));
        assert_eq!((e.idem_key.as_deref(), e.correlation_id.as_deref()), (None, None), "sin identidad natural y sin correlación todavía");
        assert_eq!(actor_y_canal(e), ("person", None, Some("ui")));
        assert_eq!(core.lock().decisions.iter().filter(|d| d.id == id).count(), 1, "la fila legacy se conserva");
        assert!(e.seq > ultimo_seq);
        ultimo_seq = e.seq;
    }
}

#[test]
fn el_actor_validado_de_una_decision_no_cambia_si_el_contexto_cambia_despues() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let antes = head(&core);
    // Person/Ui decide y, ya validada, la misma mutación cambia el contexto a System/Core antes de confirmar.
    core.mutate_as(&persona_ui(), |tx| {
        tx.record_decision(&a, "review", "human", &json!({ "decision": "accepted", "head_commit": "h" }))?;
        tx.set_context(MutationContext::core());
        Ok(())
    })
    .unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["decision.recorded"]);
    assert_eq!(actor_y_canal(&evs[0]), ("person", None, Some("ui")), "el evento conserva el actor que se validó, no el contexto tardío");

    // Los demás eventos siguen usando el contexto vigente al finalizar (el bootstrap de `run_create` lo necesita).
    let antes = head(&core);
    core.mutate_as(&persona_ui(), |tx| {
        tx.set_context(MutationContext::core());
        tx.create_run("obj", nt("otra"));
        Ok(())
    })
    .unwrap();
    assert!(desde(&core, antes).iter().all(|e| actor_y_canal(e) == ("system", None, Some("core"))), "contexto tardío para el resto");
}

// ---------------------------------------------------------------------------------------------
// effect.observed: un único mutador (`Tx::observe_effect`) llamado por la frontera `mutate_after_effect`
// ---------------------------------------------------------------------------------------------

fn diario() -> Vec<Value> {
    std::fs::read_to_string(super::fsio::data_dir().join("unrecorded-effects.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn estado_json(core: &Core) -> String {
    serde_json::to_string(&*core.lock()).unwrap()
}

#[test]
fn cada_efecto_observado_emite_un_effect_observed_con_payload_cerrado_y_una_sola_identidad() {
    let (_l, _d, core) = core_listo();
    let (run, root, a, _b) = escenario(&core);
    core.mutate(|tx| {
        tx.task_mut(&a)?.project_id = Some("p1".into());
        Ok(())
    })
    .unwrap();
    let casos: Vec<(&'static str, &'static str, Value, MutationContext, Value, (&str, Option<&str>, Option<&str>))> = vec![
        (
            "integrate", "git_merge",
            json!({ "outcome": "conflict", "branch": "lx/t", "base_commit": "b", "result_commit": null, "worktree": "/ruta/secreta", "message": "MENSAJE-GIT" }),
            persona_ui(),
            json!({ "effect_kind": "git_merge", "operation": "integrate", "result": "conflict", "branch": "lx/t", "base_commit": "b" }),
            ("person", None, Some("ui")),
        ),
        (
            "publish_pr", "git_push_pr",
            json!({ "outcome": "created", "branch": "lx/t", "pr_url": "https://github.com/o/r/pull/1", "remote": "https://token@host/x.git", "error": "TEXTO-ERROR" }),
            persona_ui(),
            json!({ "effect_kind": "git_push_pr", "operation": "publish_pr", "result": "created", "branch": "lx/t", "pr_url": "https://github.com/o/r/pull/1" }),
            ("person", None, Some("ui")),
        ),
        (
            "publish_pr", "git_push_pr",
            json!({ "outcome": "created", "branch": "lx/t", "pr_url": "https://user:SECRETO@github.com/o/r/pull/1?token=SECRETO#SECRETO" }),
            persona_ui(),
            json!({ "effect_kind": "git_push_pr", "operation": "publish_pr", "result": "created", "branch": "lx/t", "pr_url": "https://github.com/o/r/pull/1" }),
            ("person", None, Some("ui")),
        ),
        (
            "publish_pr", "git_push_pr",
            json!({ "outcome": "created", "branch": "lx/t", "pr_url": "https://user:pa/ss@github.com/o/r/pull/1;x=SECRETO" }),
            persona_ui(),
            json!({ "effect_kind": "git_push_pr", "operation": "publish_pr", "result": "created", "branch": "lx/t" }),
            ("person", None, Some("ui")),
        ),
        (
            "spawn", "git_worktree",
            json!({ "worktree": "/ruta/secreta", "branch": "lx/r/t1-x", "base": "main" }),
            persona_ui(),
            json!({ "effect_kind": "git_worktree", "operation": "spawn", "branch": "lx/r/t1-x", "base": "main" }),
            ("person", None, Some("ui")),
        ),
        (
            "release", "git_worktree_removed",
            json!({ "worktree": "/ruta/secreta", "worktree_removed": false, "branch": "lx/b", "branch_deleted": true }),
            MutationContext::agent(&root, Channel::Lxo),
            json!({ "effect_kind": "git_worktree_removed", "operation": "release", "worktree_removed": false, "branch": "lx/b", "branch_deleted": true }),
            ("agent", Some(root.as_str()), Some("lxo")),
        ),
        (
            "close_idle_runs", "git_worktree_removed",
            json!({ "worktree": "/ruta/secreta", "worktree_removed": true, "branch": null, "branch_deleted": false }),
            MutationContext::core(),
            json!({ "effect_kind": "git_worktree_removed", "operation": "close_idle_runs", "worktree_removed": true, "branch_deleted": false }),
            ("system", None, Some("core")),
        ),
        (
            "spawn", "pty_process",
            json!({ "launched": true, "argv": ["--secreto"] }),
            persona_ui(),
            json!({ "effect_kind": "pty_process", "operation": "spawn", "launched": true }),
            ("person", None, Some("ui")),
        ),
    ];
    for (op, kind, observed, ctx, esperado, actor) in casos {
        let efecto = Effect::new(op, kind).task(&a).observed(observed);
        let effect_id = efecto.effect_id().to_string();
        let antes = head(&core);
        core.acting(ctx).mutate_after_effect(efecto, |_tx| Ok(())).unwrap();
        let evs = desde(&core, antes);
        assert_eq!(kinds(&evs), vec!["effect.observed"], "{op}/{kind}: un efecto, un evento");
        let e = &evs[0];
        let mut con_id = esperado.clone();
        con_id["effect_id"] = json!(effect_id);
        assert_eq!(pl(e), con_id, "{op}/{kind}");
        // Tres usos del mismo identificador: contenido, relación y unicidad.
        assert_eq!((e.correlation_id.as_deref(), e.idem_key.as_deref()), (Some(effect_id.as_str()), Some(effect_id.as_str())), "{op}/{kind}");
        assert_eq!((e.class, e.entity_kind.as_str(), e.entity_id.as_str()), (EventClass::Effect, "task", a.as_str()));
        assert_eq!((e.project_id.as_deref(), e.run_id.as_deref()), (Some("p1"), Some(run.as_str())));
        assert_eq!(actor_y_canal(e), actor, "{op}/{kind}");
        assert!(SECRETOS.iter().all(|s| !e.payload.contains(s)) && !e.payload.contains("--secreto"), "{op}/{kind}: {}", e.payload);
    }
}

#[test]
fn el_orden_es_efecto_decision_estado_y_solo_efecto_y_decision_comparten_correlacion() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let efecto = Effect::new("integrate", "git_merge").task(&a).observed(json!({ "outcome": "merged", "branch": "lx/t", "result_commit": "r" }));
    let effect_id = efecto.effect_id().to_string();
    let antes = head(&core);
    core.acting(persona_ui())
        .mutate_after_effect(efecto, |tx| {
            // Primero el registro de la decisión y después un cambio de estado del mismo Tx.
            tx.record_decision(&a, "merge", "human", &json!({ "outcome": "merged", "branch": "lx/t", "squash": false }))?;
            tx.close(&a, Status::Stopped, "liberada").map(|_| ())
        })
        .unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["effect.observed", "decision.recorded", "task.status_changed"], "el efecto ocurrió ANTES que su registro");
    assert_eq!((evs[0].correlation_id.as_deref(), evs[1].correlation_id.as_deref()), (Some(effect_id.as_str()), Some(effect_id.as_str())), "efecto y decisión comparten effect_id");
    assert_eq!(evs[2].correlation_id, None, "los hechos de estado NO se correlacionan con el efecto");
    assert_eq!(evs[1].idem_key, None, "la decisión no hereda la clave de unicidad del efecto");
    // Una decisión fuera de `mutate_after_effect` no lleva correlación.
    let antes = head(&core);
    core.mutate_as(&persona_ui(), |tx| tx.record_decision(&a, "review", "human", &json!({ "decision": "accepted", "head_commit": "h" }))).unwrap();
    assert_eq!(desde(&core, antes)[0].correlation_id, None);
}

#[test]
fn cambiar_el_contexto_despues_de_observar_el_efecto_no_reatribuye_actor_ni_canal() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let efecto = Effect::new("spawn", "pty_process").task(&a).observed(json!({ "launched": true }));
    let antes = head(&core);
    core.acting(persona_ui())
        .mutate_after_effect(efecto, |tx| {
            tx.set_context(MutationContext::core());
            tx.mark_running(&a).map(|_| ())
        })
        .unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["effect.observed"]);
    assert_eq!(actor_y_canal(&evs[0]), ("person", None, Some("ui")), "el efecto conserva el actor que lo observó");
}

#[test]
fn todo_fallo_del_registro_tras_un_efecto_se_anota_y_no_deja_estado_ni_eventos() {
    let (_l, _data, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let valido = |a: &str| Effect::new("spawn", "pty_process").task(a).observed(json!({ "launched": true }));
    type Caso<'a> = (&'a str, Effect, Box<dyn Fn(&mut Tx) -> Result<(), String> + 'a>);
    let casos: Vec<Caso> = vec![
        ("el cierre devuelve Err (Rejected)", valido(&a), Box::new(|tx| {
            tx.create_run("no debe quedar", nt("otra"));
            Err("rechazado por el cierre".into())
        })),
        ("effect_kind desconocido", Effect::new("spawn", "kind_inventado").task(&a).observed(json!({})), Box::new(|_| Ok(()))),
        ("operation fuera del contrato", Effect::new("operacion_inventada", "pty_process").task(&a).observed(json!({ "launched": true })), Box::new(|_| Ok(()))),
        ("detalle fuera del contrato", Effect::new("spawn", "pty_process").task(&a).observed(json!({ "launched": "si" })), Box::new(|_| Ok(()))),
        ("la tarea no existe", valido("t-no-existe"), Box::new(|_| Ok(()))),
        ("no_change dentro de la frontera", valido(&a), Box::new(|tx| {
            tx.create_run("no debe quedar", nt("otra"));
            tx.no_change();
            Ok(())
        })),
    ];
    for (nombre, efecto, cierre) in casos {
        let (estado, antes, n) = (estado_json(&core), head(&core), diario().len());
        let r = core.acting(persona_ui()).mutate_after_effect(efecto, |tx| cierre(tx));
        assert!(matches!(&r, Err(m) if m.contains("NO quedó registrada")), "{nombre}: {r:?}");
        assert_eq!(estado_json(&core), estado, "{nombre}: ningún estado");
        assert_eq!(head(&core), antes, "{nombre}: ningún evento");
        let lineas = diario();
        assert_eq!(lineas.len(), n + 1, "{nombre}: el efecto ocurrió, así que SÍ se anota (también un Rejected)");
        let ultima = lineas.last().unwrap();
        assert_eq!(ultima["v"], 2, "el writer nuevo usa v2");
        let effect_id = ultima["effect_id"].as_str().expect("persiste la identidad del efecto");
        assert!(super::effect_journal::valid_effect_id(effect_id), "UUID v7 original");
        assert!(ultima.get("expected").is_none(), "no persiste valores esperados");
        assert!(ultima.get("error").is_none(), "no persiste texto de error");
        assert!(ultima.get("repo").is_none(), "no persiste rutas de repositorio");
    }
    assert_eq!(core.health(), Health::Normal, "un rechazo no degrada el almacenamiento");
}

#[test]
fn spawn_outcome_ya_no_es_un_efecto_aprobar_rechazar_o_vencer_no_son_efectos_externos() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let efecto = Effect::new("spawn_approval", "spawn_outcome").task(&a).observed(json!({ "launched_task": null }));
    let (antes, filas) = (head(&core), core.lock().decisions.len());
    let r = core.acting(persona_ui()).mutate_after_effect(efecto, |_tx| Ok(()));
    assert!(matches!(&r, Err(m) if m.contains("fuera del contrato")), "{r:?}");
    assert_eq!((head(&core), core.lock().decisions.len()), (antes, filas), "ni evento ni fila");
}

fn con_remoto(dir: &Path) -> PathBuf {
    let bare = dir.with_extension("remote.git");
    let _ = std::fs::remove_dir_all(&bare);
    g(dir, &["init", "-q", "--bare", &s(&bare)]);
    g(dir, &["remote", "add", "origin", &s(&bare)]);
    bare
}

#[test]
fn publicar_un_pr_distingue_si_hubo_efecto_externo() {
    let (_l, core, id, dir) = core_con_rama("eff-pr");
    let persona = core.acting(persona_ui());
    let args = json!({ "task": id, "confirm": true });
    let gh_ok = |_: &str, _: &str, _: &str, _: &str, _: &str| -> Result<String, String> { Ok("https://github.com/o/r/pull/1".into()) };
    let gh_ya_existe = |_: &str, _: &str, _: &str, _: &str, _: &str| -> Result<String, String> {
        Err("gh pr create: a pull request for branch \"lx/t\" already exists:\nhttps://github.com/o/r/pull/3".into())
    };

    // Sin remoto el push falla: se ejecutó la acción, se observa con result `error`.
    let antes = head(&core);
    let out = super::integration::publish_pr(&persona, true, &args, &gh_ok).unwrap();
    assert_eq!(out["outcome"], "error");
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["effect.observed", "decision.recorded"]);
    let id_efecto = evs[0].idem_key.clone().unwrap();
    assert_eq!(pl(&evs[0]), json!({ "effect_kind": "git_push_pr", "effect_id": id_efecto, "operation": "publish_pr", "result": "error", "branch": "lx/t" }));
    assert_eq!((evs[0].correlation_id.as_deref(), evs[1].correlation_id.as_deref()), (Some(id_efecto.as_str()), Some(id_efecto.as_str())));
    assert!(!evs[0].payload.contains("remote"));

    // Con remoto: created -> efecto + decisión correlacionados.
    let bare = con_remoto(&dir);
    let antes = head(&core);
    let out = super::integration::publish_pr(&persona, true, &args, &gh_ok).unwrap();
    assert_eq!(out["outcome"], "created");
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["effect.observed", "decision.recorded"]);
    assert_eq!((pl(&evs[0])["result"].as_str(), pl(&evs[0])["pr_url"].as_str()), (Some("created"), Some("https://github.com/o/r/pull/1")));
    assert_eq!(evs[0].correlation_id, evs[1].correlation_id);
    assert_eq!(evs[0].idem_key, evs[0].correlation_id);

    // `gh` responde «ya existe» tras ejecutar push + gh: SÍ hubo efecto -> efecto + decisión.
    core.mutate(|tx| {
        tx.task_mut(&id)?.pr_url = None;
        Ok(())
    })
    .unwrap();
    let antes = head(&core);
    let out = super::integration::publish_pr(&persona, true, &args, &gh_ya_existe).unwrap();
    assert_eq!((out["outcome"].as_str(), out["pr_url"].as_str()), (Some("already_exists"), Some("https://github.com/o/r/pull/3")));
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["effect.observed", "decision.recorded"]);
    assert_eq!((pl(&evs[0])["result"].as_str(), pl(&evs[1])["outcome"].as_str()), (Some("already_exists"), Some("already_exists")));

    // Con `Task.pr_url` ya registrada NO se ejecuta nada: decisión sí, efecto no, diario no.
    let (antes, n) = (head(&core), diario().len());
    let out = super::integration::publish_pr(&persona, true, &args, &gh_ok).unwrap();
    assert_eq!(out["outcome"], "already_exists");
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["decision.recorded"], "sin efecto no hay effect.observed");
    assert_eq!(evs[0].correlation_id, None);
    assert_eq!(diario().len(), n, "y nada que reconciliar");
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(bare);
}

#[test]
fn liberar_solo_observa_un_efecto_si_se_borro_un_worktree_o_una_rama() {
    let (_l, data, core) = core_listo();
    let r = repo(&data);
    let (_run, root, a, b) = escenario(&core);
    let wt = data.parent().unwrap().join("wt-release");
    g(&r, &["worktree", "add", "-q", "-b", "lx/w", &s(&wt), "HEAD"]);
    g(&r, &["branch", "lx/b"]);
    core.mutate(|tx| {
        let t = tx.task_mut(&a)?;
        (t.repo, t.cwd, t.worktree, t.branch) = (s(&r), s(&wt), Some(s(&wt)), Some("lx/w".into()));
        let t = tx.task_mut(&b)?;
        (t.repo, t.cwd, t.worktree, t.branch, t.merged) = (s(&r), s(&r), None, Some("lx/b".into()), true);
        Ok(())
    })
    .unwrap();
    let ctx = MutationContext::agent(&root, Channel::Lxo);
    let caller = Caller::Agent(Some(root.clone()));

    // Se borra el worktree (la rama no está fusionada, así que se conserva): efecto + estado.
    let antes = head(&core);
    core.release(&ctx, &caller, &a, true).unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["effect.observed", "task.status_changed"]);
    let id_a = evs[0].idem_key.clone().unwrap();
    assert_eq!(pl(&evs[0]), json!({ "effect_kind": "git_worktree_removed", "effect_id": id_a, "operation": "release", "worktree_removed": true, "branch": "lx/w", "branch_deleted": false }));
    assert_eq!(actor_y_canal(&evs[0]), ("agent", Some(root.as_str()), Some("lxo")));
    assert!(!evs[0].payload.contains("wt-release"), "la ruta no viaja");

    // Sin worktree pero con la rama fusionada realmente borrada: efecto de rama únicamente.
    let antes = head(&core);
    core.release(&ctx, &caller, &b, true).unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["effect.observed", "task.status_changed"]);
    assert_eq!(pl(&evs[0])["worktree_removed"], false);
    assert_eq!((pl(&evs[0])["branch"].as_str(), pl(&evs[0])["branch_deleted"].as_bool()), (Some("lx/b"), Some(true)));

    // Ni worktree ni rama borrada: mutación normal, ningún efecto ficticio ni diario.
    let (c, n) = (
        core.mutate(|tx| {
            let (_run, _root) = tx.create_run("otro", nt("raiz2"));
            let h = tx.add_child(&_root, 2, nt("hija"))?;
            tx.mark_running(&h)?;
            Ok(h)
        })
        .unwrap(),
        diario().len(),
    );
    let antes = head(&core);
    core.release(&MutationContext::person(Channel::Ui), &Caller::User, &c, true).unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["task.status_changed"], "sin efecto externo real: effect.observed cero");
    assert_eq!(diario().len(), n);
}

#[test]
fn el_frontera_de_efectos_solo_conoce_los_kinds_del_contrato_y_los_efectos_reales_de_produccion() {
    use super::event_kinds::EffectObserved;
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    let mut pares = Vec::new();
    for entrada in std::fs::read_dir(&dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        for (_, l) in produccion(&texto) {
            for trozo in l.split("Effect::new(\"").skip(1) {
                let op = trozo.split('"').next().unwrap();
                let kind = trozo.split("\"").nth(2).unwrap_or_default();
                pares.push((nombre.clone(), op.to_string(), kind.to_string()));
            }
        }
    }
    assert!(pares.len() >= 7, "los siete sitios de producción: {pares:?}");
    for (archivo, op, kind) in pares {
        let observado = match kind.as_str() {
            "git_merge" => json!({ "outcome": "merged", "branch": "b" }),
            "git_push_pr" => json!({ "outcome": "created", "branch": "b" }),
            "git_worktree" => json!({ "branch": "b" }),
            "git_worktree_removed" => json!({ "worktree_removed": true, "branch_deleted": false }),
            "pty_process" => json!({ "launched": true }),
            _ => json!({}),
        };
        let r = EffectObserved::parse("id", &op, &kind, &observado);
        assert!(r.is_ok(), "{archivo}: Effect::new({op:?}, {kind:?}) no está en el contrato de effect.observed ni en la excepción: {r:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// on_exit tardío: no confirma una mutación vacía
// ---------------------------------------------------------------------------------------------

#[test]
fn un_on_exit_tardio_tras_retirar_la_task_no_avanza_la_rev_ni_deja_eventos() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    core.mutate_as(&MutationContext::core(), |tx| tx.remove_failed_launch(&a)).unwrap();
    let (rev, seq) = (core.storage.confirmed_rev().unwrap(), head(&core));
    core.on_exit(&a);
    assert_eq!((core.storage.confirmed_rev().unwrap(), head(&core)), (rev, seq), "ni rev ni eventos");
}

#[test]
fn un_on_exit_con_la_task_ya_final_no_avanza_la_rev_ni_deja_eventos() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    core.mutate(|tx| tx.close(&a, Status::Stopped, "detenida").map(|_| ())).unwrap();
    let (rev, seq) = (core.storage.confirmed_rev().unwrap(), head(&core));
    core.on_exit(&a);
    assert_eq!((core.storage.confirmed_rev().unwrap(), head(&core)), (rev, seq));
}

#[test]
fn un_on_exit_de_una_task_viva_la_cierra_una_sola_vez() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let (rev, seq) = (core.storage.confirmed_rev().unwrap(), head(&core));
    core.on_exit(&a);
    assert_eq!(estado(&core, &a), Status::Exited);
    let evs = desde(&core, seq);
    assert_eq!(kinds(&evs), vec!["task.status_changed"], "un solo cierre");
    assert_eq!(core.storage.confirmed_rev().unwrap(), rev.map(|r| r + 1), "y UNA sola confirmación, no una segunda vacía");
}

#[test]
fn dos_revisiones_legitimas_consecutivas_producen_dos_eventos_distintos() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let detalle = json!({ "decision": "accepted", "head_commit": "h", "comment": null });
    let (r1, e1) = decide(&core, &a, "review", detalle.clone());
    let (r2, e2) = decide(&core, &a, "review", detalle);
    let (d1, d2) = (r1.unwrap(), r2.unwrap());
    assert_ne!(d1, d2);
    assert_eq!((e1.len(), e2.len()), (1, 1));
    assert_ne!(e1[0].id, e2[0].id);
    assert_eq!((pl(&e1[0])["decision_id"].as_u64(), pl(&e2[0])["decision_id"].as_u64()), (Some(d1), Some(d2)));
    assert!(e1[0].idem_key.is_none() && e2[0].idem_key.is_none(), "repetir una revisión no se deduplica");
}

#[test]
fn record_decision_rechaza_spawn_su_unica_via_es_record_spawn_resolution() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let detalle = json!({ "pending_id": "p-1", "outcome": "approved", "argv": ["--secreto"] });
    let (filas, antes) = (core.lock().decisions.len(), head(&core));
    // Ni la persona desde la interfaz…
    let (r, evs) = decide(&core, &a, "spawn", detalle.clone());
    rechazada(&r, "record_spawn_resolution");
    assert!(evs.is_empty());
    // …ni el Core.
    let (r, evs) = paso_como(&core, &MutationContext::core(), |tx| tx.record_decision(&a, "spawn", "system", &detalle));
    rechazada(&r, "record_spawn_resolution");
    assert!(evs.is_empty());
    assert_eq!((core.lock().decisions.len(), head(&core)), (filas, antes), "ni fila ni evento");
}

#[test]
fn record_spawn_resolution_no_duplica_decision_para_el_mismo_pending_id() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, parent, _other) = escenario(&core);
    let pending_id = "sp-duplicate-resolution";
    let detail = json!({ "pending_id": pending_id, "outcome": "rejected" });
    let resolution = super::tx_ops::SpawnResolution {
        pending_id,
        parent_task: &parent,
        outcome: super::event_kinds::SpawnOutcome::Rejected,
        task: None,
        has_reason: true,
        legacy: Some(("human", &detail)),
    };
    let first = core.mutate_as(&persona_ui(), |tx| tx.record_spawn_resolution(&resolution)).unwrap();
    assert!(matches!(first, super::tx_ops::SpawnRecorded::Recorded(Some(_))));
    let (rev_before, seq_before) = (core.storage.confirmed_rev().unwrap(), head(&core));

    let second = core.mutate_as(&persona_ui(), |tx| {
        match tx.record_spawn_resolution(&resolution)? {
            super::tx_ops::SpawnRecorded::Duplicate => {
                tx.no_change();
                Ok("duplicate")
            }
            super::tx_ops::SpawnRecorded::Recorded(_) => Ok("recorded twice"),
        }
    }).unwrap();
    assert_eq!(second, "duplicate");
    assert_eq!(core.storage.confirmed_rev().unwrap(), rev_before, "el duplicado no confirma otra mutación");
    assert_eq!(head(&core), seq_before, "el duplicado no emite otro evento");
    assert_eq!(core.lock().decisions.iter().filter(|d| d.kind == "spawn").count(), 1, "una sola Decision(spawn) por pending_id");
}

#[test]
fn un_kind_desconocido_rechaza_la_mutacion_completa() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let (runs, decisiones, antes) = {
        let st = core.lock();
        (st.runs.len(), st.decisions.len(), head(&core))
    };
    for kind in ["release", "discard", "reopen", "stop", "", "Merge"] {
        // Además de la decisión, la misma mutación hace otro cambio: tampoco debe publicarse.
        let r = core.mutate_as(&persona_ui(), |tx| {
            tx.create_run("no debe quedar", nt("otra"));
            tx.record_decision(&a, kind, "human", &json!({ "outcome": "merged" }))
        });
        rechazada(&r, "fuera del contrato");
    }
    let (runs_ahora, decisiones_ahora) = {
        let st = core.lock();
        (st.runs.len(), st.decisions.len())
    };
    assert_eq!((runs_ahora, decisiones_ahora, head(&core)), (runs, decisiones, antes), "ni estado ni filas ni eventos");
    // La tarea tiene que existir.
    let (r, evs) = decide(&core, "t-no-existe", "review", json!({ "decision": "accepted", "head_commit": "h" }));
    rechazada(&r, "no existe");
    assert!(evs.is_empty());
}

#[test]
fn un_detalle_fuera_del_contrato_rechaza_la_mutacion() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    let antes = (core.lock().decisions.len(), head(&core));
    let malos = [
        ("review", json!({ "decision": "quizas", "head_commit": "h" })),
        ("review", json!({ "decision": "accepted" })),
        ("review", json!({ "decision": "accepted", "head_commit": "h", "base_commit": 5 })),
        ("merge", json!({ "outcome": "inventado", "branch": "b", "squash": false })),
        ("merge", json!({ "outcome": "merged", "squash": false })),
        ("merge", json!({ "outcome": "merged", "branch": "b" })),
        ("merge", json!({ "outcome": "conflict", "branch": "b", "squash": false, "conflicts": "a.txt" })),
        ("pr", json!({ "outcome": "created" })),
        ("pr", json!({ "outcome": "pendiente", "branch": "b" })),
        ("pr", json!({ "outcome": "created", "branch": "b", "pr_url": 7 })),
    ];
    for (kind, detalle) in malos {
        let (r, evs) = decide(&core, &a, kind, detalle.clone());
        rechazada(&r, "decision.recorded");
        assert!(evs.is_empty(), "{kind} {detalle}");
    }
    assert_eq!((core.lock().decisions.len(), head(&core)), antes, "ninguna fila ni evento");
}

#[test]
fn la_validacion_de_actor_exige_coherencia_con_la_fila_y_una_persona_en_la_interfaz() {
    let (_l, _d, core) = core_listo();
    let (_run, root, a, _b) = escenario(&core);
    let review = json!({ "decision": "accepted", "head_commit": "h" });
    let (filas, antes) = (core.lock().decisions.len(), head(&core));
    let rechazos: Vec<(&str, MutationContext, &str, &str)> = vec![
        // La fila dice «human» pero quien muta no es una persona.
        ("review", MutationContext::core(), "human", "la fila dice actor"),
        ("review", MutationContext::agent(&root, Channel::Lxo), "human", "la fila dice actor"),
        ("merge", MutationContext::agent(&root, Channel::Ui), "human", "la fila dice actor"),
        // La fila dice «system» pero quien muta es una persona.
        ("spawn", persona_ui(), "system", "la fila dice actor"),
        // Coherentes, pero review/merge/pr son de una PERSONA desde la interfaz.
        ("review", MutationContext::core(), "system", "solo la toma una persona"),
        ("pr", MutationContext::agent(&a, Channel::Lxo), a.as_str(), "solo la toma una persona"),
        ("review", MutationContext::person(Channel::Lxo), "human", "solo la toma una persona"),
        ("merge", MutationContext::person(Channel::Core), "human", "solo la toma una persona"),
    ];
    for (kind, ctx, actor, fragmento) in rechazos {
        let detalle = match kind {
            "merge" => json!({ "outcome": "merged", "branch": "b", "squash": false }),
            "pr" => json!({ "outcome": "created", "branch": "b" }),
            "spawn" => json!({ "pending_id": "p", "outcome": "approved" }),
            _ => review.clone(),
        };
        let r = core.mutate_as(&ctx, |tx| tx.record_decision(&a, kind, actor, &detalle));
        rechazada(&r, fragmento);
    }
    assert_eq!((core.lock().decisions.len(), head(&core)), (filas, antes), "ningún rechazo deja fila ni evento");

    // El adaptador de pruebas por defecto es el Core: ahí una decisión humana se rechaza, no se tolera.
    let st = Mutex::new(State::default());
    let (_run, tarea) = st.mutate(|tx| Ok(tx.create_run("obj", nt("raiz")))).unwrap();
    let r = st.mutate(|tx| tx.record_decision(&tarea, "review", "human", &review));
    assert!(matches!(&r, Err(m) if m.contains("la fila dice actor")), "{r:?}");
    assert!(st.read(|s| s.decisions.is_empty()));
    // Representar a la persona es EXPLÍCITO.
    let persona = crate::orch::mutation::ConContexto::persona(&st);
    persona.mutate(|tx| tx.record_decision(&tarea, "review", "human", &review)).unwrap();
    assert_eq!(st.read(|s| s.decisions.len()), 1);
}

#[test]
fn todo_kind_del_vocabulario_emite_exactamente_un_evento_salvo_spawn_que_tiene_su_propio_mutador() {
    let (_l, _d, core) = core_listo();
    let (_run, _root, a, _b) = escenario(&core);
    for kind in super::vocab::DECISION_KIND {
        let detalle = match kind {
            "review" => json!({ "decision": "accepted", "head_commit": "h" }),
            "merge" => json!({ "outcome": "merged", "branch": "b", "squash": false }),
            "pr" => json!({ "outcome": "created", "branch": "b" }),
            "spawn" => json!({ "pending_id": "p", "outcome": "approved" }),
            otro => panic!("kind nuevo del vocabulario sin instrumentar ni excluir explícitamente: {otro}"),
        };
        let (r, evs) = decide(&core, &a, kind, detalle);
        if kind == "spawn" {
            rechazada(&r, "record_spawn_resolution");
            assert!(evs.is_empty());
            continue;
        }
        r.unwrap();
        assert_eq!(evs.len(), 1, "{kind}");
    }
}

// ---------------------------------------------------------------------------------------------
// Rutas reales de la persona: integrar, revisar y publicar
// ---------------------------------------------------------------------------------------------

/// Un Core real con la rama `lx/t` de la preparación de revisión (tarea hija ya terminada).
fn core_con_rama(nombre: &str) -> (Limpia, Arc<Core>, String, PathBuf) {
    let (l, _d, core) = core_listo();
    let (st, id, dir, _base) = super::review::tests::setup(nombre);
    let nuevo = st.into_inner().unwrap();
    core.mutate(|tx| {
        **tx = nuevo;
        tx.task_mut(&id)?.project_id = Some("p9".into());
        Ok(())
    })
    .unwrap();
    (l, core, id, dir)
}

fn rev_parse(dir: &Path, rama: &str) -> String {
    let o = Command::new("git").args(["rev-parse", rama]).current_dir(dir).output().unwrap();
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

#[test]
fn revisar_e_integrar_desde_la_interfaz_deja_un_solo_decision_recorded_por_decision() {
    let (_l, core, id, dir) = core_con_rama("dec-flujo");
    let h = rev_parse(&dir, "lx/t");

    // head_moved no registra nada.
    let antes = head(&core);
    assert_eq!(core.review_from_ui(&id, "accepted", "0000000", None, true).unwrap()["outcome"], "head_moved");
    assert!(desde(&core, antes).is_empty());
    // Integrar sin revisión aceptada tampoco.
    assert_eq!(core.integrate_from_ui(&id, true, false, None).unwrap()["outcome"], "review_required");
    assert!(desde(&core, antes).is_empty());

    // La revisión: UN evento; el comentario no viaja.
    let r = core.review_from_ui(&id, "accepted", &h, Some("SECRETO-COMENTARIO"), true).unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["decision.recorded"]);
    let p = pl(&evs[0]);
    assert_eq!((p["decision_kind"].as_str(), p["outcome"].as_str(), p["head_commit"].as_str()), (Some("review"), Some("accepted"), Some(h.as_str())));
    assert_eq!((p["decision_id"].as_u64(), p["has_comment"].as_bool()), (r["decision_id"].as_u64(), Some(true)));
    assert!(!evs[0].payload.contains("SECRETO-COMENTARIO"));
    assert_eq!((actor_y_canal(&evs[0]), evs[0].project_id.as_deref()), (("person", None, Some("ui")), Some("p9")));

    // La integración: el efecto (git merge) y la decisión son hechos distintos, correlacionados por `effect_id`;
    // ninguna capa repite ninguno de los dos.
    let antes = head(&core);
    let out = core.integrate_from_ui(&id, true, false, None).unwrap();
    assert_eq!(out["outcome"], "merged");
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["effect.observed", "decision.recorded"], "un efecto y una decisión, en ese orden");
    let efecto = pl(&evs[0]);
    assert_eq!((efecto["effect_kind"].as_str(), efecto["result"].as_str(), efecto["branch"].as_str()), (Some("git_merge"), Some("merged"), Some("lx/t")));
    assert_eq!(efecto["result_commit"], out["result_commit"]);
    assert_eq!(efecto["effect_id"].as_str(), evs[0].idem_key.as_deref());
    assert_eq!((evs[0].correlation_id.as_deref(), evs[1].correlation_id.as_deref()), (evs[0].idem_key.as_deref(), evs[0].idem_key.as_deref()));
    assert_eq!(actor_y_canal(&evs[0]), ("person", None, Some("ui")));
    let evs = vec![evs[1].clone()];
    let p = pl(&evs[0]);
    assert_eq!((p["decision_kind"].as_str(), p["outcome"].as_str(), p["branch"].as_str(), p["squash"].as_bool()), (Some("merge"), Some("merged"), Some("lx/t"), Some(false)));
    assert_eq!(p["decision_id"], out["decision"]);
    assert_eq!(p["result_commit"], out["result_commit"]);
    assert!(p.get("into").is_none() && p.get("message").is_none() && p.get("conflicts").is_none());
    assert!(!evs[0].payload.contains("lxo-revision"), "la ruta local del destino no viaja: {}", evs[0].payload);
    assert_eq!((actor_y_canal(&evs[0]), evs[0].project_id.as_deref()), (("person", None, Some("ui")), Some("p9")));
    assert_eq!(core.lock().decisions.last().map(|d| (d.kind.as_str(), d.actor.as_str())), Some(("merge", "human")), "fila legacy y evento coinciden");

    // Repetir: already_merged no crea decisión ni evento.
    let antes = head(&core);
    assert_eq!(core.integrate_from_ui(&id, true, false, None).unwrap()["outcome"], "already_merged");
    assert!(desde(&core, antes).is_empty());
    // Un agente no puede integrar: ni efecto ni evento.
    let r = core.rpc(Caller::Agent(Some(id.clone())), &s(&dir), "integrate", &json!({ "task": id, "confirm": true }));
    assert!(r.is_err());
    assert!(desde(&core, antes).is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn publicar_un_pr_deja_un_decision_recorded_sin_remoto_ni_error_textual() {
    let (_l, core, id, dir) = core_con_rama("dec-pr");
    let gh = |_: &str, _: &str, _: &str, _: &str, _: &str| -> Result<String, String> { Ok("https://github.com/o/r/pull/1".into()) };
    let persona = core.acting(persona_ui());
    // Sin remoto el push falla: se registra la decisión con outcome `error`, sin el texto del error.
    let antes = head(&core);
    let out = super::integration::publish_pr(&persona, true, &json!({ "task": id, "confirm": true }), &gh).unwrap();
    assert_eq!(out["outcome"], "error");
    assert!(out["message"].is_string(), "el error textual sí se devuelve al llamador");
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["effect.observed", "decision.recorded"], "el push/gh se ejecutó: efecto observado y decisión");
    let evs = vec![evs[1].clone()];
    assert_eq!(pl(&evs[0]), json!({ "decision_kind": "pr", "decision_id": out["decision"], "outcome": "error", "branch": "lx/t" }));
    assert_eq!(actor_y_canal(&evs[0]), ("person", None, Some("ui")));
    // Con un PR ya registrado: already_exists, con su URL; sigue siendo una decisión nueva.
    core.mutate(|tx| {
        tx.task_mut(&id)?.pr_url = Some("https://github.com/o/r/pull/3".into());
        Ok(())
    })
    .unwrap();
    let antes = head(&core);
    let out = super::integration::publish_pr(&persona, true, &json!({ "task": id, "confirm": true }), &gh).unwrap();
    assert_eq!(out["outcome"], "already_exists");
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["decision.recorded"], "con la URL ya registrada no se ejecuta nada: sin efecto");
    assert_eq!(pl(&evs[0])["pr_url"], "https://github.com/o/r/pull/3");
    assert!(!evs[0].payload.contains("remote"));
    let _ = std::fs::remove_dir_all(dir);
}

fn produccion(texto: &str) -> Vec<(usize, String)> {
    let prod = texto.split("mod tests {").next().unwrap().split("mod durable_tests {").next().unwrap();
    prod.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")).map(|(n, l)| (n + 1, l.to_string())).collect()
}

#[test]
fn ninguna_capa_superior_construye_ni_empuja_eventos_de_estado() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    // El catálogo solo lo importa tx_ops; nadie más nombra sus constructores ni la cola de la transacción.
    let prohibido: [(&str, &[&str]); 16] = [
        // Dos únicos importadores del catálogo: los mutadores de `Tx` y el registro de proyectos (`project_ops.rs`).
        ("event_kinds", &["tx_ops.rs", "mod.rs", "project_ops.rs"]),
        ("EventDraft", &["events.rs", "event_kinds.rs", "mutation.rs", "tx_ops.rs"]),
        ("try_push_event", &["mutation.rs", "tx_ops.rs"]),
        ("task_status_changed(", &["event_kinds.rs", "tx_ops.rs"]),
        ("run_created(", &["event_kinds.rs", "tx_ops.rs"]),
        // `decision.recorded` lo construye SOLO `Tx::record_decision`: ni integration, ni review, ni rpc.
        ("decision_recorded(", &["event_kinds.rs", "tx_ops.rs"]),
        ("DecisionRecorded", &["event_kinds.rs", "tx_ops.rs"]),
        ("DECISION_KINDS_WITHOUT_EVENT", &["event_kinds.rs"]),
        // `effect.observed` lo construye SOLO `Tx::observe_effect`, y solo lo invoca la frontera `mutate_after_effect`.
        ("effect_observed(", &["event_kinds.rs", "tx_ops.rs"]),
        ("EffectObserved", &["event_kinds.rs", "tx_ops.rs"]),
        (".observe_effect(", &["mutation.rs"]),
        ("EFFECT_KINDS_WITHOUT_EVENT", &["event_kinds.rs"]),
        // `task.removed` lo construye SOLO `Tx::remove_failed_launch`; el cleanup no vuelve a borrar tareas a mano ni a depender de `Task.worktree`.
        ("task_removed(", &["event_kinds.rs", "tx_ops.rs"]),
        ("RemovalCause", &["event_kinds.rs", "tx_ops.rs"]),
        ("discard_worktree", &[]),
        ("tasks.remove(", &["state.rs"]),
    ];
    let mut revisados = 0;
    for entrada in std::fs::read_dir(&dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        for (n, l) in produccion(&texto) {
            for (simbolo, donde) in prohibido {
                assert!(
                    !l.contains(simbolo) || donde.contains(&nombre.as_str()),
                    "{nombre}:{n}: «{simbolo}» solo puede aparecer en {donde:?}: el hecho nace donde se confirma semánticamente, no en una capa superior"
                );
            }
        }
        revisados += 1;
    }
    assert!(revisados >= 20);
    // delivery.rs cierra con tx.done / tx.close y no construye borradores.
    let delivery = std::fs::read_to_string(dir.join("delivery.rs")).unwrap();
    assert!(produccion(&delivery).iter().all(|(_, l)| !l.contains("EventDraft") && !l.contains("event_kinds")));
}

#[test]
fn los_mutadores_no_reciben_un_state_suelto_en_produccion() {
    // Los cierres de `mutate`/`StateAccess` reciben `&mut Tx`: ningún módulo de producción fuera del
    // modelo (`state.rs`, `tx_ops.rs`) y del arranque legacy/promoción declara un `&mut State`.
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    for entrada in std::fs::read_dir(&dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        if ["state.rs", "tx_ops.rs", "boot_authority.rs", "lifecycle.rs", "mutation.rs", "mirror.rs", "snapshot.rs"].contains(&nombre.as_str()) {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        for (n, l) in produccion(&texto) {
            assert!(!l.contains("&mut State"), "{nombre}:{n}: un mutador recibe `&mut Tx`, no `&mut State` (así emite eventos): {l}");
        }
    }
}
