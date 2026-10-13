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
use super::mutation::{MutateError, StateAccess, Tx};
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
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["run.created", "task.created", "task.status_changed"], "un hecho, un evento: rpc no vuelve a emitir nada");
    // Bootstrap de identidad: un coordinador aún no registrado actúa como la tarea raíz que acaba de crear.
    assert!(evs.iter().all(|e| e.actor_kind.as_str() == "agent" && e.actor_id.as_deref() == Some(root.as_str()) && e.channel.as_deref() == Some("lxo")), "{evs:?}");
    let pid = core.lock().tasks.get(&root).unwrap().project_id.clone().expect("el repositorio nuevo se registró solo");
    assert!(evs.iter().all(|e| e.project_id.as_deref() == Some(pid.as_str())), "project_id completado tras crear el run y resuelto al finalizar");
    assert_eq!(pl(&evs[2]), json!({ "from": "starting", "to": "running" }));
    assert_eq!(evs[0].run_id.as_deref(), Some(run.as_str()));

    // Una PERSONA desde la interfaz: el actor es la persona, el canal la interfaz.
    let antes = head(&core);
    core.rpc(Caller::User, &s(&r), "run_create", &json!({ "objective": "otro" })).unwrap();
    let evs = desde(&core, antes);
    assert!(evs.iter().all(|e| e.actor_kind.as_str() == "person" && e.actor_id.is_none() && e.channel.as_deref() == Some("ui")), "{evs:?}");
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
    assert!(evs.iter().all(|e| e.actor_kind.as_str() == "person" && e.channel.as_deref() == Some("ui")));
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

fn produccion(texto: &str) -> Vec<(usize, String)> {
    let prod = texto.split("mod tests {").next().unwrap().split("mod durable_tests {").next().unwrap();
    prod.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")).map(|(n, l)| (n + 1, l.to_string())).collect()
}

#[test]
fn ninguna_capa_superior_construye_ni_empuja_eventos_de_estado() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    // El catálogo solo lo importa tx_ops; nadie más nombra sus constructores ni la cola de la transacción.
    let prohibido: [(&str, &[&str]); 5] = [
        ("event_kinds", &["tx_ops.rs", "mod.rs"]),
        ("EventDraft", &["events.rs", "event_kinds.rs", "mutation.rs"]),
        ("try_push_event", &["mutation.rs", "tx_ops.rs"]),
        ("task_status_changed(", &["event_kinds.rs", "tx_ops.rs"]),
        ("run_created(", &["event_kinds.rs", "tx_ops.rs"]),
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
