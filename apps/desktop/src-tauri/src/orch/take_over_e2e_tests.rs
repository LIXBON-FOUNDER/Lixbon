//! LXO-170 · Take Over de extremo a extremo por el RPC autenticado de Desktop, con proveedores falsos y repositorios git reales. Cada prueba
//! comprueba el desenlace DURABLE: el hecho `attempt.ownership_changed`, el estado del Attempt, lo que de verdad llegó al adapter y lo que
//! NO ocurrió (ningún Attempt nuevo, ninguna reanudación, ningún cierre). Contrato: `docs/core/TAKE_OVER.md`.

use std::time::Duration;

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::adapter::{AdapterError, Capability};
use super::attempt_e2e_tests::{kinds, wait_until, world, World};
use super::compare_e2e_tests::{git, worktree};
use super::dispatch_tests::{event_count, row};
use super::steer_e2e_tests::world_without;
use super::{Caller, Core};

pub(super) fn payloads(core: &Core, attempt: &str, kind: &str) -> Vec<Value> {
    let rows: Vec<String> = core
        .storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT payload FROM events WHERE kind = ?1 AND entity_id = ?2 ORDER BY seq")?;
                let rows = stmt.query_map([kind, attempt], |r| r.get::<_, String>(0))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
        })
        .unwrap()
        .unwrap();
    rows.iter().map(|p| serde_json::from_str(p).unwrap()).collect()
}

pub(super) fn owner_events(core: &Core, attempt: &str) -> usize {
    event_count(core, attempt, "attempt.ownership_changed") as usize
}

pub(super) fn calls(w: &World, name: &str) -> usize {
    w.adapter.calls().iter().filter(|c| c.as_str() == name).count()
}

pub(super) fn take(w: &World, attempt: &str, request_id: &str) -> Result<Value, String> {
    w.desktop("attempt_take_over", json!({ "attempt_id": attempt, "request_id": request_id }))
}

/// El Attempt corre con su ejecución viva y la sesión declarada.
pub(super) fn running(w: &World, attempt: &str) -> String {
    wait_until("el Attempt corre", || row(&w.core, attempt).0 == "running");
    let task = attempt.rsplit_once("-a").unwrap().0.to_string();
    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    wait_until("el proveedor declara su sesión", || w.core.lock().tasks.get(&task).is_some_and(|t| t.session_ref.is_some()));
    task
}

/// Un Attempt `claude` que trabaja hasta que se le interrumpe (`Wait` reacciona a la interrupción).
pub(super) fn live_world(request: &str) -> (World, String, String) {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-to"), Step::Output("trabajando".into()), Step::Wait]);
    let a = w.create("claude", request);
    w.approve(&a);
    let task = running(&w, &a);
    (w, a, task)
}

#[test]
fn tomar_el_control_interrumpe_y_deja_el_attempt_running_sin_proceso_en_manos_de_la_persona() {
    let (w, a, task) = live_world("to-ok");
    let head = git(&worktree(&w.core, &a), &["rev-parse", "HEAD"]);

    let r = take(&w, &a, "t-1").expect("take_over");
    assert_eq!((r["status"].as_str(), r["owner"].as_str(), r["attempt_id"].as_str(), r["base_commit"].as_str()), (Some("TakenOver"), Some("human"), Some(a.as_str()), Some(head.as_str())));

    // Se interrumpió y NADA más: no se reanudó, no se lanzó otro proveedor, no hay Attempt nuevo.
    assert_eq!((calls(&w, "interrupt"), calls(&w, "resume")), (1, 0), "{:?}", w.adapter.calls());
    assert_eq!(w.adapter.starts().len(), 1);
    assert!(!w.core.has_term(&task), "la ejecución del agente salió del registro");
    // El Attempt sigue vivo (`running`) y SIN cierre: la propiedad no es un estado del Attempt.
    assert_eq!(row(&w.core, &a).0, "running");
    assert_eq!((event_count(&w.core, &a, "attempt.started"), event_count(&w.core, &a, "attempt.exited"), event_count(&w.core, &a, "attempt.completed"), event_count(&w.core, &a, "attempt.failed")), (1, 0, 0, 0));
    assert_eq!(w.core.storage.with_store(|s| s.attempts_of_task(&task).map(|v| v.len())).unwrap().unwrap(), 1, "Take Over no crea otro Attempt");

    // El hecho: de agente a persona, con la petición y la rama en ese instante; sin rutas ni contenido.
    let facts = payloads(&w.core, &a, "attempt.ownership_changed");
    assert_eq!(facts.len(), 1);
    assert_eq!((facts[0]["from"].as_str(), facts[0]["to"].as_str(), facts[0]["request_id"].as_str(), facts[0]["base_commit"].as_str()), (Some("agent"), Some("human"), Some("t-1"), Some(head.as_str())));
    let owner = w.core.attempt_owner(&a).unwrap();
    assert_eq!((owner.owner, owner.request_id.as_deref(), owner.base_commit.as_deref()), (crate::store::Owner::Human, Some("t-1"), Some(head.as_str())));
    assert_eq!(w.core.human_owned_attempts().unwrap(), vec![(a.clone(), task.clone())]);

    // Repetir la petición devuelve lo mismo, sin interrumpir ni escribir otra vez.
    let again = take(&w, &a, "t-1").expect("repetición");
    assert_eq!((again["status"].as_str(), again["owner"].as_str()), (Some("Replayed"), Some("human")));
    assert_eq!((calls(&w, "interrupt"), owner_events(&w.core, &a)), (1, 1));
}

#[test]
fn el_hecho_lo_firma_la_persona_que_lo_pidio_y_el_dueno_lo_lee_work_at() {
    let (w, a, _task) = live_world("to-actor");
    take(&w, &a, "t-1").expect("take_over");
    let (kind, actor): (String, Option<String>) = w
        .core
        .storage
        .with_store(|s| s.read(|c| Ok(c.query_row("SELECT actor_kind, actor_id FROM events WHERE kind = 'attempt.ownership_changed' AND entity_id = ?1", [&a], |r| Ok((r.get(0)?, r.get(1)?))).unwrap())))
        .unwrap()
        .unwrap();
    assert_eq!(kind, "person", "no lo firma el Core: lo pidió una persona");
    assert_ne!(actor.as_deref(), Some(""));

    // `work_at` (LXO-169) dice quién lo tiene en sus manos.
    let wt = format!("wt-{a}");
    let r = w.desktop("work_at", json!({ "project_id": w.project, "path": "README.md", "worktree_id": wt })).expect("work_at");
    assert_eq!((r["owner"]["state"].as_str(), r["owner"]["attempt"]["id"].as_str(), r["owner"]["attempt"]["held_by"].as_str()), (Some("owned"), Some(a.as_str()), Some("human")));
}

#[test]
fn un_segundo_take_over_o_uno_sobre_un_attempt_terminado_se_rechaza_sin_escribir() {
    let (w, a, _task) = live_world("to-doble");
    take(&w, &a, "t-1").expect("take_over");
    let err = take(&w, &a, "t-2").unwrap_err();
    assert!(err.contains("invalid/already_human"), "{err}");
    assert_eq!((owner_events(&w.core, &a), calls(&w, "interrupt")), (1, 1));

    // Un Attempt terminado es historia.
    let done = world("claude", Some(vec![Step::Bind("sess-fin"), Step::Complete(Some("hecho".into()))]));
    let d = done.create("claude", "to-final");
    done.approve(&d);
    done.settled(&d, "done");
    let err = take(&done, &d, "t-1").unwrap_err();
    assert!(err.contains("invalid/attempt_final"), "{err}");
    assert_eq!(owner_events(&done.core, &d), 0);
}

#[test]
fn sin_interrupt_sin_resume_o_sin_sesion_no_se_interrumpe_nada() {
    for capability in [Capability::Interrupt, Capability::Resume] {
        let w = world_without(capability, vec![Step::Bind("sess-cap"), Step::Wait]);
        let a = w.create("claude", "to-cap");
        w.approve(&a);
        running(&w, &a);
        let err = take(&w, &a, "t-1").unwrap_err();
        assert!(err.contains("unsupported/take_over_unsupported"), "{capability:?}: {err}");
        assert_eq!((calls(&w, "interrupt"), owner_events(&w.core, &a)), (0, 0), "{capability:?}: sin la capability no se interrumpe nada");
        assert_eq!(row(&w.core, &a).0, "running", "el agente sigue trabajando");
        w.adapter.release_hold();
        w.desktop("stop", json!({ "task": a.rsplit_once("-a").unwrap().0 })).expect("stop");
    }

    // Sin sesión declarada no se podría devolver el trabajo al mismo Attempt.
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Output("sin sesión".into()), Step::Wait]);
    let a = w.create("claude", "to-sin-sesion");
    w.approve(&a);
    wait_until("el Attempt corre", || row(&w.core, &a).0 == "running");
    let task = a.rsplit_once("-a").unwrap().0.to_string();
    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    let err = take(&w, &a, "t-1").unwrap_err();
    assert!(err.contains("invalid/session_missing"), "{err}");
    assert_eq!((calls(&w, "interrupt"), owner_events(&w.core, &a)), (0, 0));
    w.desktop("stop", json!({ "task": task })).expect("stop");
}

#[test]
fn un_plazo_vencido_conserva_al_dueno_anterior_y_un_stop_tardio_no_cambia_nada() {
    let w = world("claude", None);
    // `Hold` no reacciona a la interrupción: se acepta pero el turno no acaba.
    w.adapter.push_turn(vec![Step::Bind("sess-to"), Step::Hold, Step::Complete(Some("terminó solo".into()))]);
    let a = w.create("claude", "to-timeout");
    w.approve(&a);
    running(&w, &a);
    w.core.take_overs.set_wait(Duration::from_millis(300));

    let err = take(&w, &a, "t-1").unwrap_err();
    assert!(err.contains("failed/stop_timeout"), "{err}");
    assert_eq!(owner_events(&w.core, &a), 0, "sin frontera segura el dueño no cambia");
    assert_eq!(w.core.attempt_owner(&a).unwrap().owner, crate::store::Owner::Agent);
    // Ahora el turno acaba por su cuenta: la petición retirada NO le quita el Attempt a nadie.
    w.adapter.release_hold();
    w.settled(&a, "done");
    assert_eq!((owner_events(&w.core, &a), event_count(&w.core, &a, "attempt.completed")), (0, 1));
    // Repetir la MISMA clave devuelve el mismo resultado (como Steer): para reintentar se usa otra. Y con otra, el Attempt ya terminó.
    assert!(take(&w, &a, "t-1").unwrap_err().contains("failed/stop_timeout"));
    assert!(take(&w, &a, "t-2").unwrap_err().contains("invalid/attempt_final"));
}

#[test]
fn si_la_ejecucion_acaba_de_otra_forma_no_hay_frontera_segura_y_el_dueno_no_cambia() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-cae"), Step::Hold, Step::Fail(AdapterError::provider("el proveedor se cayó"))]);
    let a = w.create("claude", "to-cae");
    w.approve(&a);
    running(&w, &a);
    std::thread::scope(|scope| {
        let pedido = scope.spawn(|| take(&w, &a, "t-1"));
        // El proveedor no reacciona a la interrupción: cae por su cuenta con la petición ya pendiente.
        wait_until("se pidió la interrupción", || calls(&w, "interrupt") == 1);
        w.adapter.release_hold();
        let err = pedido.join().unwrap().unwrap_err();
        assert!(err.contains("failed/stop_failed"), "{err}");
    });
    w.settled(&a, "failed");
    assert_eq!(owner_events(&w.core, &a), 0);
    assert_eq!(w.core.attempt_owner(&a).unwrap().owner, crate::store::Owner::Agent);
}

#[test]
fn un_attempt_en_manos_de_la_persona_no_se_cierra_como_huerfano_ni_por_inactividad() {
    let (w, a, task) = live_world("to-huerfano");
    take(&w, &a, "t-1").expect("take_over");
    assert_eq!(row(&w.core, &a).0, "running");

    // Otra Task, esta SÍ del agente y viva: es la que el cierre de huérfanos debe cerrar (el control de que el cierre funciona), sin llevarse a la anterior.
    w.adapter.push_turn(vec![Step::Bind("sess-otra"), Step::Output("sigo".into()), Step::Wait]);
    let b = w.create("claude", "to-huerfano-otra");
    w.approve(&b);
    running(&w, &b);

    // Al arrancar: la del agente es un huérfano; la de la persona no lo es aunque no tenga proceso.
    w.core.close_orphans();
    assert_eq!(row(&w.core, &b).0, "exited", "el cierre de huérfanos sí cierra lo que es del agente");
    assert_eq!(row(&w.core, &a).0, "running", "el cierre de huérfanos no toca el trabajo de una persona");
    assert_eq!(event_count(&w.core, &a, "attempt.exited"), 0);

    // Por inactividad: dos horas después, el Run sigue abierto.
    let now = super::state::now_ms();
    w.core.close_idle_runs_at(now + 2 * 60 * 60 * 1000);
    assert_eq!(row(&w.core, &a).0, "running", "tampoco se cierra por inactividad");
    assert!(w.core.lock().tasks.get(&task).is_some_and(|t| !t.status.is_final()));
    assert_eq!(kinds(&w.core, &a).iter().filter(|k| k.as_str() == "attempt.stopped").count(), 0);
}

#[test]
fn solo_una_person_autenticada_toma_el_control_y_la_peticion_se_valida() {
    let (w, a, task) = live_world("to-auth");
    for agent in [None, Some(task.clone())] {
        let e = w.core.rpc_via(super::events::Channel::Lxo, Caller::Agent(agent), "", "attempt_take_over", &json!({ "attempt_id": a, "request_id": "t-1" })).expect_err("un agente no toma el control");
        assert!(!e.contains("TakenOver"), "{e}");
    }
    for args in [json!({ "attempt_id": a }), json!({ "request_id": "t-1" }), json!({ "attempt_id": a, "request_id": "t-1", "otro": 1 }), json!({ "attempt_id": a, "request_id": "" }), json!({ "attempt_id": "no-existe", "request_id": "t-1" })] {
        assert!(w.desktop("attempt_take_over", args.clone()).is_err(), "{args}");
    }
    assert_eq!((calls(&w, "interrupt"), owner_events(&w.core, &a)), (0, 0), "nada de lo anterior llegó al proveedor");
    // La policy base trata Take Over como un stop: una Person de Desktop puede, y queda registrado quién.
    take(&w, &a, "t-1").expect("la Person de Desktop");
}

#[test]
fn una_persona_puede_detener_el_attempt_que_tomo_y_ya_no_queda_en_sus_manos() {
    let (w, a, task) = live_world("to-stop");
    take(&w, &a, "t-1").expect("take_over");
    assert_eq!(w.core.human_owned_attempts().unwrap().len(), 1);

    // La CLI no tiene ejecución que cancelar: detener es cerrar el Attempt, y queda asentado como `stopped`.
    let cli = w.cli_client("to-stop");
    let stopped = w.core.rpc_authenticated_via(&cli, &crate::store::ClientClaims::default(), super::events::Channel::Lxo, "", "attempt_stop", &json!({ "attempt_id": a, "confirm": true })).expect("attempt_stop");
    assert_eq!(stopped["status"], "Stopped", "{stopped}");
    assert_eq!((row(&w.core, &a).0.as_str(), event_count(&w.core, &a, "attempt.stopped")), ("stopped", 1));
    assert!(w.core.human_owned_attempts().unwrap().is_empty(), "un Attempt terminado ya no tiene a nadie que proteger");
    assert!(!w.core.has_term(&task));
    // Y no se puede volver a tomar: es historia.
    assert!(take(&w, &a, "t-2").unwrap_err().contains("invalid/attempt_final"));
}
