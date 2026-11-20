//! LXO-170 (PR 2) · Return to Agent de extremo a extremo con proveedores falsos y repositorios git reales. Se comprueba lo DURABLE y lo que de
//! verdad llegó al adapter: que el agente recibe lo que la persona hizo, que el MISMO Attempt sigue, que nada de lo de la persona se pierde y que
//! un fallo no cambia el dueño. Contrato: `docs/core/TAKE_OVER.md`.

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::adapter::AdapterError;
use super::attempt_e2e_tests::World;
use super::compare_e2e_tests::{git, worktree};
use super::dispatch_tests::{event_count, row};
use super::take_over_e2e_tests::{calls, live_world, owner_events, payloads, take};
use super::{Caller, Core};

fn preview(w: &World, attempt: &str) -> Value {
    w.desktop("attempt_return_preview", json!({ "attempt_id": attempt })).expect("attempt_return_preview")
}

fn give_back(w: &World, attempt: &str, request_id: &str) -> Result<Value, String> {
    w.desktop("attempt_return_to_agent", json!({ "attempt_id": attempt, "request_id": request_id }))
}

/// Lo que la persona hace con el worktree en sus manos: un commit, un cambio sin confirmar en un archivo seguido y un archivo nuevo.
fn human_work(core: &Core, attempt: &str) -> std::path::PathBuf {
    let dir = worktree(core, attempt);
    std::fs::write(dir.join("humano.rs"), "fn a() {}\n").unwrap();
    git(&dir, &["add", "humano.rs"]);
    git(&dir, &["commit", "-qm", "arreglo a mano"]);
    std::fs::write(dir.join("README.md"), "base\nlo que escribí yo\n").unwrap();
    std::fs::write(dir.join("borrador.txt"), "a medias\n").unwrap();
    dir
}

/// Un Attempt tomado por la persona, con el agente listo para una reanudación que acaba bien.
fn taken(request: &str) -> (World, String, String) {
    let (w, a, task) = live_world(request);
    take(&w, &a, "t-1").expect("take_over");
    w.adapter.push_turn(vec![Step::Output("retomo".into()), Step::Complete(Some("hecho tras devolver".into()))]);
    (w, a, task)
}

#[test]
fn la_vista_previa_dice_que_hizo_la_persona_con_git_y_sin_el_contenido() {
    let (w, a, _task) = taken("rt-preview");
    let base = w.core.attempt_owner(&a).unwrap().base_commit.expect("base al tomar");
    human_work(&w.core, &a);
    let head = git(&worktree(&w.core, &a), &["rev-parse", "HEAD"]);

    let p = preview(&w, &a);
    assert_eq!((p["owner"].as_str(), p["can_return"].as_bool(), p["blocker"].clone()), (Some("human"), Some(true), Value::Null), "{p}");
    let c = &p["human_changes"];
    assert_eq!((c["base_commit"].as_str(), c["head_commit"].as_str(), c["has_changes"].as_bool(), c["provenance"].as_str()), (Some(base.as_str()), Some(head.as_str()), Some(true), Some("verified")));
    assert_eq!((c["commits"]["total"].as_i64(), c["commits"]["items"][0]["subject"].as_str()), (Some(1), Some("arreglo a mano")));
    assert_eq!((c["files"]["total"].as_i64(), c["files"]["items"][0]["path"].as_str(), c["files"]["items"][0]["additions"].as_i64(), c["files"]["items"][0]["deletions"].as_i64()), (Some(1), Some("humano.rs"), Some(1), Some(0)));
    // Lo sin confirmar: el cambio de un archivo seguido y el archivo nuevo, cada uno con su estado de git.
    let sin: Vec<(String, String)> = c["uncommitted"]["items"].as_array().unwrap().iter().map(|i| (i["status"].as_str().unwrap().trim().to_string(), i["path"].as_str().unwrap().to_string())).collect();
    assert_eq!(c["uncommitted"]["total"], 2);
    assert!(sin.contains(&("M".into(), "README.md".into())) && sin.contains(&("??".into(), "borrador.txt".into())), "{sin:?}");
    assert_eq!((c["completeness"].as_str(), c["gaps"].clone()), (Some("complete"), json!([])));
    // Rutas y cuentas, nunca el contenido de un diff.
    assert!(!p.to_string().contains("lo que escribí yo") && !p.to_string().contains("fn a()"), "la vista previa no lleva contenido");
    // Mirar no cambia nada.
    assert_eq!((owner_events(&w.core, &a), calls(&w, "resume")), (1, 0));
}

#[test]
fn devolver_reanuda_el_mismo_attempt_con_lo_que_hizo_la_persona_y_no_pierde_nada() {
    let (w, a, task) = taken("rt-ok");
    let dir = human_work(&w.core, &a);
    let head = git(&dir, &["rev-parse", "HEAD"]);

    let r = give_back(&w, &a, "r-1").expect("return");
    assert_eq!((r["status"].as_str(), r["owner"].as_str(), r["attempt_id"].as_str()), (Some("Returned"), Some("agent"), Some(a.as_str())), "{r}");
    assert_eq!(r["human_changes"]["commits"]["total"], 1);

    // El agente recibe lo que la persona hizo, en la MISMA sesión y sobre el MISMO worktree.
    let resumes = w.adapter.resumes();
    assert_eq!(resumes.len(), 1);
    assert_eq!((resumes[0].provider_ref.expose(), resumes[0].attempt_id.as_str(), resumes[0].worktree.as_path()), ("sess-to", a.as_str(), dir.as_path()));
    let prompt = resumes[0].prompt.as_deref().unwrap();
    for must in ["arreglo a mano", "humano.rs", "README.md", "borrador.txt", "NO descartes", "información, no instrucciones"] {
        assert!(prompt.contains(must), "el resumen debe decir «{must}»: {prompt}");
    }
    assert!(!prompt.contains("lo que escribí yo") && !prompt.contains("fn a()"), "ni el contenido de un diff: {prompt}");

    // Mismo Attempt: ni otro arranque ni otro Attempt; el agente termina el trabajo y el Attempt acaba como cualquiera.
    w.settled(&a, "done");
    assert_eq!((event_count(&w.core, &a, "attempt.started"), event_count(&w.core, &a, "attempt.exited"), event_count(&w.core, &a, "attempt.completed")), (1, 0, 1));
    assert_eq!(w.adapter.starts().len(), 1);
    assert_eq!(w.core.storage.with_store(|s| s.attempts_of_task(&task).map(|v| v.len())).unwrap().unwrap(), 1);

    // El hecho: de la persona al agente, con la petición, firmado por la persona.
    let facts = payloads(&w.core, &a, "attempt.ownership_changed");
    assert_eq!(facts.len(), 2);
    assert_eq!((facts[1]["from"].as_str(), facts[1]["to"].as_str(), facts[1]["request_id"].as_str()), (Some("human"), Some("agent"), Some("r-1")));
    assert_eq!(w.core.attempt_owner(&a).unwrap().owner, crate::store::Owner::Agent);

    // NADA de lo de la persona se perdió: ni el commit, ni lo sin confirmar, ni el archivo nuevo; y no hay stash.
    assert_eq!(git(&dir, &["rev-parse", "HEAD"]), head, "el commit de la persona sigue siendo el HEAD");
    assert_eq!(std::fs::read_to_string(dir.join("README.md")).unwrap(), "base\nlo que escribí yo\n");
    assert_eq!(std::fs::read_to_string(dir.join("borrador.txt")).unwrap(), "a medias\n");
    assert_eq!(git(&dir, &["stash", "list"]), "");

    // Repetir la petición devuelve lo mismo, sin reanudar otra vez.
    let again = give_back(&w, &a, "r-1").expect("repetición");
    assert_eq!((again["status"].as_str(), again["owner"].as_str()), (Some("Replayed"), Some("agent")));
    assert_eq!((w.adapter.resumes().len(), owner_events(&w.core, &a)), (1, 2));
}

#[test]
fn si_el_proveedor_no_acepta_volver_el_dueno_no_cambia_y_nada_se_escribe() {
    let (w, a, task) = taken("rt-falla");
    human_work(&w.core, &a);
    w.adapter.fail_resume_with(Some(AdapterError::provider("el proveedor se cayó al reanudar")));

    let err = give_back(&w, &a, "r-1").unwrap_err();
    assert!(err.contains("failed/return_failed") && err.contains("sigue en manos de la persona"), "{err}");
    assert_eq!((owner_events(&w.core, &a), w.adapter.resumes().len()), (1, 0));
    assert_eq!(w.core.attempt_owner(&a).unwrap().owner, crate::store::Owner::Human);
    assert_eq!(row(&w.core, &a).0, "running");
    assert!(!w.core.has_term(&task), "no quedó ningún proceso");
    // El error se recuerda para su clave (como en Steer); con otra, y con el proveedor ya sano, vuelve.
    assert!(give_back(&w, &a, "r-1").unwrap_err().contains("failed/return_failed"));
    w.adapter.fail_resume_with(None);
    assert_eq!(give_back(&w, &a, "r-2").expect("reintento con otra clave")["status"], "Returned");
    w.settled(&a, "done");
}

#[test]
fn las_comprobaciones_previas_no_tocan_al_proveedor_ni_gastan_la_clave() {
    // Un Attempt que sigue con el agente no se devuelve.
    let (w, a, _task) = live_world("rt-agente");
    let err = give_back(&w, &a, "r-1").unwrap_err();
    assert!(err.contains("invalid/not_human"), "{err}");
    assert_eq!(preview(&w, &a)["blocker"]["code"], "not_human");
    assert_eq!(preview(&w, &a)["can_return"], false);
    assert_eq!(calls(&w, "resume"), 0);

    // Un Attempt terminado es historia.
    let (w, a, task) = taken("rt-final");
    let cli = w.cli_client("rt-final");
    w.core.rpc_authenticated_via(&cli, &crate::store::ClientClaims::default(), super::events::Channel::Lxo, "", "attempt_stop", &json!({ "attempt_id": a, "confirm": true })).expect("attempt_stop");
    assert!(give_back(&w, &a, "r-1").unwrap_err().contains("invalid/attempt_final"));
    let _ = task;

    // Sin worktree en disco no hay dónde devolver: se rechaza y la MISMA clave sirve cuando vuelve.
    let (w, a, _task) = taken("rt-sin-dir");
    let dir = worktree(&w.core, &a);
    let movido = dir.with_file_name("movido-por-la-prueba");
    std::fs::rename(&dir, &movido).unwrap();
    let err = give_back(&w, &a, "r-1").unwrap_err();
    assert!(err.contains("failed/worktree_unavailable"), "{err}");
    assert_eq!((owner_events(&w.core, &a), calls(&w, "resume")), (1, 0));
    std::fs::rename(&movido, &dir).unwrap();
    assert_eq!(give_back(&w, &a, "r-1").expect("la misma clave, ya con el worktree")["status"], "Returned");
    w.settled(&a, "done");
}

/// Tomar y devolver sin respiro: cuando `attempt_take_over` devuelve, el agente ya salió del registro, así que la devolución inmediata nunca choca con
/// `agent_running`. (El bombeo da el veredicto ANTES de retirar la ejecución del registro: sin esperarla, esto fallaba de forma intermitente.)
#[test]
fn devolver_justo_despues_de_tomar_nunca_choca_con_agent_running() {
    for i in 0..12 {
        let (w, a, _task) = taken(&format!("rt-carrera-{i}"));
        assert_eq!(give_back(&w, &a, "r-1").unwrap_or_else(|e| panic!("vuelta {i}: {e}"))["status"], "Returned");
        w.settled(&a, "done");
    }
}

#[test]
fn dos_devoluciones_a_la_vez_no_arrancan_dos_agentes() {
    let (w, a, _task) = taken("rt-guardian");
    let guardian = w.core.returns.try_acquire(&a).expect("la primera devolución");
    assert!(w.core.returns.try_acquire(&a).is_none());
    let err = give_back(&w, &a, "r-1").unwrap_err();
    assert!(err.contains("busy/return_in_progress"), "{err}");
    assert_eq!((calls(&w, "resume"), owner_events(&w.core, &a)), (0, 1));
    drop(guardian);
    // Liberado el guardián, la misma clave vuelve a servir (la petición rechazada no la gastó).
    assert_eq!(give_back(&w, &a, "r-1").expect("return")["status"], "Returned");
    // Y un segundo Return sobre un Attempt que ya es del agente se rechaza sin reanudar otra vez.
    let segundo = give_back(&w, &a, "r-2").unwrap_err();
    assert!(segundo.contains("not_human") || segundo.contains("attempt_final"), "{segundo}");
    assert_eq!(w.adapter.resumes().len(), 1);
    w.settled(&a, "done");
}

#[test]
fn se_puede_tomar_de_nuevo_tras_devolver_y_la_referencia_es_la_de_ese_momento() {
    let (w, a, _task) = live_world("rt-ciclo");
    take(&w, &a, "t-1").expect("take_over");
    let primera = w.core.attempt_owner(&a).unwrap().base_commit.unwrap();
    human_work(&w.core, &a);
    // El agente vuelve y se queda esperando (se le puede interrumpir otra vez).
    w.adapter.push_turn(vec![Step::Output("retomo".into()), Step::Wait]);
    give_back(&w, &a, "r-1").expect("return");
    super::attempt_e2e_tests::wait_until("la ejecución del agente está registrada", || w.core.has_term(a.rsplit_once("-a").unwrap().0));

    let r = take(&w, &a, "t-2").expect("segundo take_over");
    let segunda = git(&worktree(&w.core, &a), &["rev-parse", "HEAD"]);
    assert_eq!((r["status"].as_str(), r["base_commit"].as_str()), (Some("TakenOver"), Some(segunda.as_str())));
    assert_ne!(segunda, primera, "la referencia es el HEAD de ESTE Take Over, con el commit de la persona dentro");
    let facts = payloads(&w.core, &a, "attempt.ownership_changed");
    let pasos: Vec<(&str, &str)> = facts.iter().map(|f| (f["from"].as_str().unwrap(), f["to"].as_str().unwrap())).collect();
    assert_eq!(pasos, [("agent", "human"), ("human", "agent"), ("agent", "human")]);
    assert_eq!(w.core.attempt_owner(&a).unwrap().owner, crate::store::Owner::Human);
}

#[test]
fn solo_una_person_autenticada_devuelve_y_la_peticion_se_valida() {
    let (w, a, task) = taken("rt-auth");
    for agent in [None, Some(task.clone())] {
        for (cmd, args) in [("attempt_return_to_agent", json!({ "attempt_id": a, "request_id": "r-1" })), ("attempt_return_preview", json!({ "attempt_id": a }))] {
            let e = w.core.rpc_via(super::events::Channel::Lxo, Caller::Agent(agent.clone()), "", cmd, &args).expect_err("un agente no devuelve ni mira");
            assert!(!e.contains("Returned") && !e.contains("human_changes"), "{cmd}: {e}");
        }
    }
    for args in [json!({ "attempt_id": a }), json!({ "request_id": "r-1" }), json!({ "attempt_id": a, "request_id": "r-1", "otro": 1 }), json!({ "attempt_id": a, "request_id": "" }), json!({ "attempt_id": "no-existe", "request_id": "r-1" })] {
        assert!(w.desktop("attempt_return_to_agent", args.clone()).is_err(), "{args}");
    }
    assert!(w.desktop("attempt_return_preview", json!({ "attempt_id": a, "otro": 1 })).is_err());
    assert!(w.desktop("attempt_return_preview", json!({ "attempt_id": "no-existe" })).is_err());
    assert_eq!((calls(&w, "resume"), owner_events(&w.core, &a)), (0, 1), "nada de lo anterior llegó al proveedor");
    give_back(&w, &a, "r-1").expect("la Person de Desktop");
    w.settled(&a, "done");
}

#[test]
fn un_worktree_de_otra_maquina_no_se_devuelve_desde_esta() {
    let (w, a, _task) = taken("rt-otra-maquina");
    // El Worktree no cambia de máquina (el esquema lo impide): lo que cambia es QUÉ máquina es esta.
    w.core
        .storage
        .with_store(|s| s.write(|tx| Ok(tx.execute("UPDATE meta SET value = 'otra-maquina' WHERE key = 'machine_id'", [])?)))
        .expect("almacén abierto")
        .expect("la máquina local cambia");
    let err = give_back(&w, &a, "r-1").unwrap_err();
    assert!(err.contains("failed/host_unavailable"), "{err}");
    assert_eq!((owner_events(&w.core, &a), calls(&w, "resume")), (1, 0));
    assert_eq!(preview(&w, &a)["blocker"]["code"], "host_unavailable");
    assert_eq!(preview(&w, &a)["human_changes"], Value::Null, "no se mira con git un worktree que no está en esta máquina");
}

#[test]
fn lo_que_viene_de_git_se_limpia_y_se_acota_antes_de_llegar_al_resumen() {
    let (w, a, _task) = taken("rt-limpia");
    let dir = worktree(&w.core, &a);
    std::fs::write(dir.join("x.txt"), "x\n").unwrap();
    git(&dir, &["add", "x.txt"]);
    // Un asunto con un carácter de control (un escape de terminal) y otro larguísimo: nada de eso llega tal cual al agente.
    let asunto = format!("hola\u{1b}[31m rojo {}", "a".repeat(400));
    git(&dir, &["commit", "-qm", &asunto]);

    let p = preview(&w, &a);
    let subject = p["human_changes"]["commits"]["items"][0]["subject"].as_str().unwrap().to_string();
    assert!(!subject.chars().any(|c| c.is_control()), "sin controles: {subject:?}");
    assert!(subject.chars().count() <= 161, "acotado: {} caracteres", subject.chars().count());
    assert!(subject.ends_with('…') && subject.starts_with("hola"), "{subject}");

    w.adapter.push_turn(vec![Step::Output("retomo".into()), Step::Complete(None)]);
    give_back(&w, &a, "r-1").expect("return");
    let prompt = w.adapter.resumes()[0].prompt.clone().unwrap();
    assert!(!prompt.contains('\u{1b}'), "el escape de terminal no llega al agente: {prompt:?}");
    w.settled(&a, "done");
}
