//! LXO-147 · Proof Pack y decisión de revisión de extremo a extremo: `attempt_proof_pack` y `attempt_review` sobre Attempts reales (adapters
//! falsos, repositorios y worktrees de verdad). Se comprueba que la evidencia distingue lo comprobado de lo que cuenta el agente, que aceptar
//! es solo sobre el HEAD exacto que se vio, que un HEAD movido no se acepta, y que rechazar no borra nada ni deja texto en el log.

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::attempt_e2e_tests::{world, World};
use super::compare_e2e_tests::{commit, event_total, git, task_of, worktree};
use super::dispatch_tests::{event_count, row};
use super::{Caller, Core};

impl World {
    fn pack(&self, attempt: &str) -> Result<Value, String> {
        self.desktop("attempt_proof_pack", json!({ "attempt_id": attempt }))
    }

    fn review(&self, attempt: &str, decision: &str, head: &str, comment: Option<&str>, confirm: bool) -> Result<Value, String> {
        let mut args = json!({ "attempt_id": attempt, "decision": decision, "head_commit": head, "confirm": confirm });
        if let Some(c) = comment {
            args["comment"] = json!(c);
        }
        self.desktop("attempt_review", args)
    }
}

fn head_of(core: &Core, attempt: &str) -> String {
    git(&worktree(core, attempt), &["rev-parse", "HEAD"])
}

/// El payload de los `decision.recorded` de la Task, en orden.
fn decisions(core: &Core, task: &str) -> Vec<Value> {
    let rows: Vec<String> = core
        .storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT payload FROM events WHERE kind = 'decision.recorded' AND entity_id = ?1 ORDER BY seq")?;
                let rows = stmt.query_map([task], |r| r.get::<_, String>(0))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
        })
        .unwrap()
        .unwrap();
    rows.iter().map(|t| serde_json::from_str(t).unwrap()).collect()
}

fn worktree_state(core: &Core, attempt: &str) -> String {
    core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT state FROM worktrees WHERE attempt_id = ?1", [attempt], |r| r.get::<_, String>(0))?))).unwrap().unwrap()
}

fn done_with_work(claim: &str) -> (World, String) {
    let w = world("claude", Some(vec![Step::Output("trabajo".into()), Step::Complete(Some(claim.into()))]));
    let attempt = w.create("claude", "pp-origen");
    w.approve(&attempt);
    w.settled(&attempt, "done");
    commit(&w.core, &attempt, &[("README.md", "cambiado\n"), ("src.txt", "nuevo\n")]);
    (w, attempt)
}

#[test]
fn un_proof_pack_completo_separa_lo_comprobado_de_lo_que_cuenta_el_agente() {
    let (w, a1) = done_with_work("Todas las pruebas pasan");
    let head = head_of(&w.core, &a1);
    let p = w.pack(&a1).expect("el Proof Pack");

    assert_eq!((p["v"].as_i64(), p["attempt_id"].as_str(), p["is_current"].as_bool()), (Some(1), Some(a1.as_str()), Some(true)));
    // La revisión y los cambios los calculó el Core con git: verificados.
    assert_eq!((p["revision"]["head_commit"]["value"].as_str(), p["revision"]["head_commit"]["provenance"].as_str()), (Some(head.as_str()), Some("verified")));
    assert_eq!((p["changes"]["files"]["value"].as_i64(), p["changes"]["files"]["provenance"].as_str()), (Some(2), Some("verified")));
    // «Todas las pruebas pasan» es lo que dice el agente: se ve como suyo y NO convierte las pruebas en verificadas.
    assert_eq!((p["summary"]["provenance"].as_str(), p["summary"]["value"].as_str()), (Some("agent_reported"), Some("Todas las pruebas pasan")));
    assert_eq!((p["tests"]["provenance"].as_str(), p["tests"]["reason"].as_str(), p["tests"]["value"].clone()), (Some("unknown"), Some("not_collected"), Value::Null));
    assert_eq!(p["objective"]["provenance"], "verified");
    // Completo = lo necesario para decidir está comprobado; las lagunas se dicen siempre.
    assert_eq!(p["completeness"], json!({"state": "complete", "gaps": ["artifacts", "tests"]}));
    // Y la decisión se ofrece sobre ESE HEAD.
    assert_eq!(p["decision"], json!({"can_decide": true, "head_commit": head}));
    assert_eq!(p["acceptance"], json!({"state": "none"}));
}

#[test]
fn un_proof_pack_parcial_dice_que_falta_y_no_deja_decidir() {
    let w = world("claude", None);
    let a1 = w.create("claude", "pp-pendiente");
    let p = w.pack(&a1).unwrap();
    assert_eq!(p["completeness"]["state"], "partial");
    assert_eq!(p["completeness"]["gaps"], json!(["revision", "changes", "summary", "artifacts", "tests"]));
    for field in [&p["revision"]["head_commit"], &p["changes"]["files"], &p["summary"]] {
        assert_eq!(field["provenance"], "unknown", "{field}");
    }
    assert_eq!(p["decision"], json!({"can_decide": false, "reason": "pending_approval", "head_commit": null}));
}

#[test]
fn aceptar_el_head_exacto_registra_la_decision_sin_integrar_ni_tocar_el_attempt() {
    let (w, a1) = done_with_work("hecho");
    let head = head_of(&w.core, &a1);
    let task = task_of(&a1);
    let events_before = event_count(&w.core, &task, "decision.recorded");

    let r = w.review(&a1, "accepted", &head, None, true).expect("la aceptación");
    assert_eq!((r["outcome"].as_str(), r["attempt_id"].as_str(), r["head_commit"].as_str()), (Some("recorded"), Some(a1.as_str()), Some(head.as_str())));
    assert_eq!(event_count(&w.core, &task, "decision.recorded"), events_before + 1);
    let d = decisions(&w.core, &task).pop().unwrap();
    assert_eq!((d["decision_kind"].as_str(), d["outcome"].as_str(), d["head_commit"].as_str(), d["has_comment"].as_bool()), (Some("review"), Some("accepted"), Some(head.as_str()), Some(false)));

    // El Proof Pack lo refleja contra el HEAD de ahora.
    let p = w.pack(&a1).unwrap();
    assert_eq!((p["acceptance"]["state"].as_str(), p["acceptance"]["head_matches"].as_bool(), p["acceptance"]["decided_head"].as_str()), (Some("accepted"), Some(true), Some(head.as_str())));
    // Review ≠ Integration: no se integró nada y el Attempt sigue como estaba.
    assert_eq!(event_count(&w.core, &a1, "attempt.integrated"), 0);
    assert_eq!(row(&w.core, &a1).0, "done");
}

#[test]
fn si_la_rama_se_mueve_antes_de_aceptar_no_se_registra_nada_y_una_aceptacion_vieja_queda_stale() {
    let (w, a1) = done_with_work("hecho");
    let task = task_of(&a1);
    let visto = head_of(&w.core, &a1);
    // Entre que la persona ve el Proof Pack y pulsa Aceptar, la rama avanza.
    commit(&w.core, &a1, &[("extra.txt", "llegó tarde\n")]);
    let nuevo = head_of(&w.core, &a1);
    assert_ne!(visto, nuevo);

    let before = (decisions(&w.core, &task).len(), event_total(&w.core));
    let r = w.review(&a1, "accepted", &visto, None, true).unwrap();
    assert_eq!((r["outcome"].as_str(), r["expected_commit"].as_str(), r["found_commit"].as_str()), (Some("head_moved"), Some(visto.as_str()), Some(nuevo.as_str())));
    assert_eq!((decisions(&w.core, &task).len(), event_total(&w.core)), before, "un HEAD movido no deja ni decisión ni evento");
    assert_eq!(w.pack(&a1).unwrap()["decision"]["head_commit"], nuevo.as_str(), "el Proof Pack ofrece el HEAD nuevo");

    // Con el HEAD nuevo sí; y si la rama se mueve DESPUÉS, esa aceptación ya no vale para el HEAD de ahora.
    assert_eq!(w.review(&a1, "accepted", &nuevo, None, true).unwrap()["outcome"], "recorded");
    assert_eq!(w.pack(&a1).unwrap()["acceptance"]["state"], "accepted");
    commit(&w.core, &a1, &[("otro.txt", "después de aceptar\n")]);
    let p = w.pack(&a1).unwrap();
    assert_eq!((p["acceptance"]["state"].as_str(), p["acceptance"]["head_matches"].as_bool()), (Some("stale"), Some(false)));
    assert_eq!(p["acceptance"]["decided_head"], nuevo.as_str());
}

#[test]
fn rechazar_no_borra_el_attempt_ni_su_worktree_y_el_comentario_no_llega_al_log() {
    let (w, a1) = done_with_work("hecho");
    let head = head_of(&w.core, &a1);
    let task = task_of(&a1);
    let secreto = "falta cubrir el caso de la clave sk-123 en producción";

    let r = w.review(&a1, "rejected", &head, Some(secreto), true).unwrap();
    assert_eq!(r["outcome"], "recorded");
    let d = decisions(&w.core, &task).pop().unwrap();
    assert_eq!((d["outcome"].as_str(), d["has_comment"].as_bool()), (Some("rejected"), Some(true)));
    assert!(!d.to_string().contains("sk-123") && !d.to_string().contains("cubrir"), "el texto del comentario no entra al Event Log: {d}");
    // Rechazar es una decisión sobre el trabajo, no un borrado.
    assert_eq!(row(&w.core, &a1).0, "done");
    assert_eq!(worktree_state(&w.core, &a1), "active");
    assert!(worktree(&w.core, &a1).join("README.md").exists());
    assert_eq!(w.pack(&a1).unwrap()["acceptance"]["state"], "rejected");
}

#[test]
fn solo_se_decide_sobre_el_attempt_actual_ya_terminado_con_confirmacion_y_por_una_persona() {
    let (w, a1) = done_with_work("hecho");
    let head = head_of(&w.core, &a1);
    let task = task_of(&a1);
    let before = event_total(&w.core);

    assert!(w.review(&a1, "accepted", &head, None, false).unwrap_err().contains("confirmación explícita"));
    assert!(w.review(&a1, "quizas", &head, None, true).is_err());
    assert!(w.review(&format!("{task}-a2"), "accepted", &head, None, true).unwrap_err().contains("review_not_current"));
    assert!(w.review("t999-a1", "accepted", &head, None, true).is_err());
    assert!(w.review("sin-formato", "accepted", &head, None, true).is_err());
    assert_eq!(w.desktop("attempt_review", json!({"attempt_id": a1, "decision": "accepted", "head_commit": head, "confirm": true, "task_id": task})).unwrap_err(), "Solicitud de revisión inválida");
    let args = json!({"attempt_id": a1, "decision": "accepted", "head_commit": head, "confirm": true});
    assert!(w.core.rpc(Caller::Agent(Some(task.clone())), "", "attempt_review", &args).is_err());
    assert!(w.core.rpc_via(super::events::Channel::Lxo, Caller::User, "", "attempt_review", &args).is_err());
    assert_eq!(event_total(&w.core), before, "nada de lo anterior dejó rastro");
}

#[test]
fn un_attempt_en_marcha_no_se_acepta_porque_su_head_va_a_cambiar() {
    let w = world("claude", Some(vec![Step::Output("trabajando".into()), Step::Wait]));
    let a1 = w.create("claude", "pp-vivo");
    w.approve(&a1);
    super::attempt_e2e_tests::wait_until("corre", || row(&w.core, &a1).0 == "running");
    let p = w.pack(&a1).unwrap();
    assert_eq!(p["decision"]["can_decide"], false);
    assert_eq!(p["decision"]["reason"], "not_final");
    let e = w.review(&a1, "accepted", "0000000", None, true).unwrap_err();
    assert!(e.contains("review_not_final"), "{e}");
    super::attempt_e2e_tests::wait_until("hay ejecución", || w.core.has_term(&task_of(&a1)));
    w.core.kill_term(&task_of(&a1)).unwrap();
}

#[test]
fn el_proof_pack_es_solo_lectura_y_solo_para_una_persona() {
    let (w, a1) = done_with_work("hecho");
    let before = event_total(&w.core);
    let first = w.pack(&a1).unwrap();
    assert_eq!(first, w.pack(&a1).unwrap(), "determinista");
    assert_eq!(event_total(&w.core), before);
    assert!(w.pack("t999-a1").unwrap_err().contains("model_not_found"));
    assert!(w.desktop("attempt_proof_pack", json!({"attempt_id": a1, "x": 1})).is_err());
    assert!(w.core.rpc(Caller::Agent(Some(task_of(&a1))), "", "attempt_proof_pack", &json!({"attempt_id": a1})).is_err());
}
