//! LXO-168 · `deep_link_resolve` y `deep_link_generate` contra un Core real: Attempts de verdad (adapter falso), repositorios y
//! Worktrees git. Se comprueba coherencia entre entidades, disponibilidad de vistas, revisión vigente/obsoleta, host y autorización.

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::attempt_e2e_tests::{world, World};
use super::adapter_launcher_tests::repo_with_commit;
use super::compare_e2e_tests::{commit, git, task_of, worktree};
use super::projects_tests::id_de;
use super::{Caller, Core};

fn head_of(core: &Core, attempt: &str) -> String {
    git(&worktree(core, attempt), &["rev-parse", "HEAD"])
}

fn resolve(w: &World, url: &str) -> Result<Value, String> {
    w.desktop("deep_link_resolve", json!({ "url": url }))
}

fn code(r: Result<Value, String>) -> String {
    r.expect_err("debía fallar").split(':').next().unwrap().to_string()
}

/// Un Attempt terminado con trabajo commiteado en su rama.
fn done() -> (World, String) {
    let w = world("claude", Some(vec![Step::Output("trabajo".into()), Step::Complete(Some("hecho".into()))]));
    let a = w.create("claude", "dl-origen");
    w.approve(&a);
    w.settled(&a, "done");
    commit(&w.core, &a, &[("src.txt", "nuevo\n")]);
    (w, a)
}

fn link(w: &World, a: &str, query: &str) -> String {
    format!("lixbon://project/{}/task/{}/attempt/{a}{query}", w.project, task_of(a))
}

#[test]
fn el_proyecto_la_task_y_el_attempt_existentes_resuelven_y_devuelven_la_forma_canonica() {
    let (w, a) = done();
    let task = task_of(&a);
    let r = resolve(&w, &format!("lixbon://project/{}", w.project)).unwrap();
    assert_eq!((r["v"].as_i64(), r["status"].as_str(), r["code"].clone()), (Some(1), Some("ready"), Value::Null));
    assert_eq!(r["target"]["task_id"], Value::Null);
    let r = resolve(&w, &format!("  LIXBON://project/{}/task/{task}/attempt/{a}?view=activity ", w.project)).unwrap();
    assert_eq!(r["canonical"], format!("lixbon://project/{}/task/{task}/attempt/{a}?view=activity", w.project));
    assert_eq!((r["target"]["attempt_id"].as_str(), r["target"]["view"].as_str(), r["status"].as_str()), (Some(a.as_str()), Some("activity"), Some("ready")));
    assert_eq!(r["revision"], json!({ "requested": null, "current": null, "state": "not_requested" }));
}

#[test]
fn lo_que_no_existe_es_not_found_y_lo_incoherente_es_target_mismatch() {
    let (w, a) = done();
    let p = &w.project;
    let task = task_of(&a);
    assert_eq!(code(resolve(&w, "lixbon://project/no-existe")), "link_not_found");
    assert_eq!(code(resolve(&w, &format!("lixbon://project/{p}/task/no-existe"))), "link_not_found");
    assert_eq!(code(resolve(&w, &format!("lixbon://project/{p}/task/{task}/attempt/{task}-a9"))), "link_not_found");
    // Otra Task del mismo Project: el Attempt existe pero no es de esa Task.
    let otra = w.create("claude", "dl-otra");
    assert_eq!(code(resolve(&w, &format!("lixbon://project/{p}/task/{}/attempt/{a}", task_of(&otra)))), "link_target_mismatch");
}

#[test]
fn una_task_de_otro_project_es_target_mismatch() {
    let (w, a) = done();
    let repo = repo_with_commit();
    let otro = id_de(&w.desktop("project_add", json!({ "path": repo.to_string_lossy(), "name": "otro" })).expect("segundo Project"));
    assert_ne!(otro, w.project);
    // Los dos existen, pero la Task es del primero.
    assert_eq!(code(resolve(&w, &format!("lixbon://project/{otro}/task/{}", task_of(&a)))), "link_target_mismatch");
    assert_eq!(code(resolve(&w, &format!("lixbon://project/{otro}/task/{}/attempt/{a}", task_of(&a)))), "link_target_mismatch");
}

#[test]
fn las_vistas_que_no_estan_disponibles_dicen_por_que() {
    let (w, a) = done();
    assert_eq!(code(resolve(&w, &link(&w, &a, "?view=review"))), "link_not_found", "sin Review");
    assert_eq!(code(resolve(&w, &link(&w, &a, "?view=artifact"))), "link_not_found", "sin Artifacts");
    let r = resolve(&w, &link(&w, &a, "?view=diff&file=src.txt&line=1")).expect("el diff de un Attempt con Worktree local");
    assert_eq!((r["status"].as_str(), r["target"]["file"].as_str(), r["target"]["line"].as_i64()), (Some("ready"), Some("src.txt"), Some(1)));
    // Un Attempt aún sin Worktree (pendiente de aprobación) no tiene diff ni archivos.
    let pendiente = w.create("claude", "dl-pendiente");
    assert_eq!(code(resolve(&w, &link(&w, &pendiente, "?view=diff"))), "link_not_found");
    assert_eq!(code(resolve(&w, &link(&w, &pendiente, "?file=a.rs"))), "link_not_found");
}

#[test]
fn la_revision_vigente_resuelve_y_la_obsoleta_se_informa_sin_abrir_otra() {
    let (w, a) = done();
    let head = head_of(&w.core, &a);
    let vigente = resolve(&w, &link(&w, &a, &format!("?revision={}", &head[..7]))).unwrap();
    assert_eq!((vigente["status"].as_str(), vigente["revision"]["state"].as_str(), vigente["revision"]["current"].as_str()), (Some("ready"), Some("current"), Some(head.as_str())));
    // También con el hash completo y en mayúsculas.
    let completo = resolve(&w, &link(&w, &a, &format!("?revision={}", head.to_uppercase()))).unwrap();
    assert_eq!(completo["revision"]["state"], "current");

    // La rama se mueve: el enlace con el HEAD anterior queda obsoleto, y el resultado enseña las dos revisiones.
    commit(&w.core, &a, &[("otro.txt", "mas\n")]);
    let nuevo = head_of(&w.core, &a);
    assert_ne!(nuevo, head);
    let obsoleta = resolve(&w, &link(&w, &a, &format!("?revision={head}"))).unwrap();
    assert_eq!((obsoleta["status"].as_str(), obsoleta["code"].as_str(), obsoleta["revision"]["state"].as_str()), (Some("stale"), Some("link_stale"), Some("stale")));
    assert_eq!((obsoleta["revision"]["requested"].as_str(), obsoleta["revision"]["current"].as_str()), (Some(head.as_str()), Some(nuevo.as_str())));
    // El destino que se devuelve es el pedido: no se sustituye la revisión por la nueva.
    assert_eq!(obsoleta["target"]["revision"], head);
    // Una revisión que ninguna rama conoce tampoco se da por buena.
    let ajena = resolve(&w, &link(&w, &a, "?revision=deadbeef")).unwrap();
    assert_eq!((ajena["status"].as_str(), ajena["revision"]["state"].as_str()), (Some("stale"), Some("stale")));
}

#[test]
fn un_enlace_de_otra_version_o_mal_formado_se_distingue() {
    let (w, a) = done();
    assert_eq!(code(resolve(&w, &link(&w, &a, "?v=2"))), "link_version_unsupported");
    assert_eq!(code(resolve(&w, &link(&w, &a, "?view=diff&file=../secreto"))), "link_malformed");
    assert_eq!(code(resolve(&w, "lixbon://project/")), "link_malformed");
    assert_eq!(code(w.desktop("deep_link_resolve", json!({}))), "model_invalid_request");
    assert_eq!(code(w.desktop("deep_link_resolve", json!({ "url": 5 }))), "model_invalid_request");
    assert_eq!(code(w.desktop("deep_link_resolve", json!({ "url": "lixbon://project/x", "otro": 1 }))), "model_invalid_request");
}

#[test]
fn quien_no_es_una_person_autenticada_no_averigua_nada() {
    let (w, a) = done();
    for agent in [None, Some(task_of(&a))] {
        for cmd in ["deep_link_resolve", "deep_link_generate"] {
            let err = w.core.rpc_via(super::events::Channel::Lxo, Caller::Agent(agent.clone()), "", cmd, &json!({ "url": "lixbon://project/x", "project_id": w.project })).expect_err(cmd);
            assert!(!err.contains(&w.project) && !err.contains("no existe"), "no debe filtrar si el Project existe: {err}");
        }
    }
}

#[test]
fn la_autorizacion_va_antes_que_la_forma_y_que_la_existencia() {
    let (w, a) = done();
    // Directo a la función, sin pasar por el filtro del RPC: sin Person autenticada ni siquiera se lee el enlace.
    let hostil = json!({ "url": "esto ni siquiera es un enlace", "project_id": w.project });
    for (caller, context) in [(Caller::Agent(None), None), (Caller::Agent(Some(task_of(&a))), None), (Caller::User, None)] {
        for (name, f) in [("resolve", super::deep_link_read::resolve as fn(&Core, &Caller, Option<&super::events::MutationContext>, &Value) -> Result<Value, String>), ("generate", super::deep_link_read::generate)] {
            let err = f(&w.core, &caller, context, &hostil).expect_err(name);
            assert!(err.starts_with("link_unauthorized: "), "{name}: {err}");
        }
    }
}

#[test]
fn un_worktree_de_otra_maquina_deja_el_diff_y_los_archivos_en_host_unavailable() {
    let (w, a) = done();
    assert_eq!(resolve(&w, &link(&w, &a, "?view=diff&file=src.txt")).unwrap()["status"], "ready", "en su máquina, sí");
    // El Worktree no cambia de máquina (el esquema lo impide): lo que cambia es QUÉ máquina es esta.
    w.core
        .storage
        .with_store(|s| s.write(|tx| Ok(tx.execute("UPDATE meta SET value = 'otra-maquina' WHERE key = 'machine_id'", [])?)))
        .expect("almacén abierto")
        .expect("la máquina local cambia");
    assert_eq!(code(resolve(&w, &link(&w, &a, "?view=diff"))), "link_host_unavailable");
    assert_eq!(code(resolve(&w, &link(&w, &a, "?file=src.txt"))), "link_host_unavailable");
    assert_eq!(code(resolve(&w, &format!("lixbon://project/{}?file=README.md", w.project))), "link_host_unavailable", "sin ubicación del Project aquí");
    // Lo que vive en el almacén se sigue resolviendo desde cualquier máquina.
    assert_eq!(resolve(&w, &link(&w, &a, "?view=activity")).unwrap()["status"], "ready");
    assert_eq!(resolve(&w, &link(&w, &a, "")).unwrap()["status"], "ready");
}

#[test]
fn generate_emite_el_enlace_canonico_y_no_a_algo_inexistente() {
    let (w, a) = done();
    let task = task_of(&a);
    let head = head_of(&w.core, &a);
    let g = w
        .desktop("deep_link_generate", json!({ "project_id": w.project, "task_id": task, "attempt_id": a, "view": "diff", "file": "src.txt", "line": 1, "revision": head.to_uppercase() }))
        .unwrap();
    assert_eq!(g["canonical"], format!("lixbon://project/{}/task/{task}/attempt/{a}?view=diff&file=src.txt&line=1&revision={head}", w.project));
    assert_eq!(g["status"], "ready");
    // Lo que genera, el resolutor lo acepta tal cual.
    assert_eq!(resolve(&w, g["canonical"].as_str().unwrap()).unwrap()["canonical"], g["canonical"]);

    assert_eq!(code(w.desktop("deep_link_generate", json!({ "project_id": "no-existe" }))), "link_not_found");
    assert_eq!(code(w.desktop("deep_link_generate", json!({ "project_id": w.project, "task_id": task, "attempt_id": format!("{task}-a9") }))), "link_not_found");
    assert_eq!(code(w.desktop("deep_link_generate", json!({ "project_id": w.project, "attempt_id": a }))), "link_malformed", "un Attempt va bajo su Task");
    assert_eq!(code(w.desktop("deep_link_generate", json!({ "project_id": w.project, "view": "terminal" }))), "link_malformed");
    assert_eq!(code(w.desktop("deep_link_generate", json!({ "project_id": w.project, "task_id": task, "attempt_id": a, "file": "../x", "view": "diff" }))), "link_malformed");
    assert_eq!(code(w.desktop("deep_link_generate", json!({ "task_id": task }))), "model_invalid_request");
    assert_eq!(code(w.desktop("deep_link_generate", json!({ "project_id": w.project, "line": "3" }))), "model_invalid_request");
}
