//! LXO-169 · `work_at` contra un Core real: Attempts de verdad (adapter falso), repositorios y Worktrees git. Se comprueba que el
//! dueño actual y la historia de toques son cosas distintas, que la ambigüedad no se resuelve sola, que la falta de evidencia no
//! se lee como «no lo tocó» y que la ruta se valida como en `lixbon://`.

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::adapter_launcher_tests::repo_with_commit;
use super::attempt_e2e_tests::{wait_until, world, World};
use super::compare_e2e_tests::{commit, git, task_of, worktree};
use super::dispatch_tests::row;
use super::projects_tests::id_de;
use super::{Caller, Core};

fn head_of(core: &Core, attempt: &str) -> String {
    git(&worktree(core, attempt), &["rev-parse", "HEAD"])
}

fn wt(attempt: &str) -> String {
    format!("wt-{attempt}")
}

fn at(w: &World, path: &str, worktree: Option<&str>) -> Value {
    let mut args = json!({ "project_id": w.project, "path": path });
    if let Some(id) = worktree {
        args["worktree_id"] = json!(id);
    }
    w.desktop("work_at", args).expect("work_at")
}

fn err(w: &World, args: Value) -> String {
    w.desktop("work_at", args).expect_err("debía fallar")
}

fn done_world() -> (World, String) {
    let w = world("claude", Some(vec![Step::Output("trabajo".into()), Step::Complete(Some("hecho".into()))]));
    let a = w.create("claude", "own-origen");
    w.approve(&a);
    w.settled(&a, "done");
    commit(&w.core, &a, &[("src.txt", "nuevo\n")]);
    (w, a)
}

/// Un Attempt VIVO: se queda en mitad del turno hasta que la prueba lo suelta.
fn running_world() -> (World, String) {
    let w = world("claude", Some(vec![Step::Output("empiezo".into()), Step::Hold, Step::Complete(Some("hecho".into()))]));
    let a = w.create("claude", "own-vivo");
    w.approve(&a);
    wait_until("el Attempt corre", || row(&w.core, &a).0 == "running");
    (w, a)
}

fn release(w: &World, a: &str) {
    w.adapter.release_hold();
    w.settled(a, "done");
}

#[test]
fn un_attempt_terminado_que_cambio_el_archivo_lo_toco_pero_ya_no_es_dueno() {
    let (w, a) = done_world();
    let head = head_of(&w.core, &a);
    let r = at(&w, "src.txt", Some(&wt(&a)));
    assert_eq!(r["v"], 1);
    // Dueño actual: nadie. El Attempt está terminado: es historia, no posesión.
    assert_eq!((r["owner"]["state"].as_str(), r["owner"]["reason"].as_str()), (Some("none"), Some("no_live_attempt")));
    assert_eq!(r["owner"]["attempt"], Value::Null);
    // Historia: lo tocó, con evidencia verificada y un enlace exacto a su diff.
    let t = &r["touched_by"];
    assert_eq!(t.as_array().unwrap().len(), 1, "{r}");
    assert_eq!((t[0]["attempt_id"].as_str(), t[0]["evidence"]["source"].as_str(), t[0]["evidence"]["provenance"].as_str()), (Some(a.as_str()), Some("live_branch"), Some("verified")));
    assert_eq!(t[0]["evidence"]["head_commit"], head);
    assert_eq!(t[0]["link"], format!("lixbon://project/{}/task/{}/attempt/{a}?view=diff&file=src.txt&revision={head}", w.project, task_of(&a)));
    assert_eq!(r["evidence"]["completeness"], "complete");
    assert_eq!(r["workspace"]["host"], "local");
}

#[test]
fn un_archivo_que_el_attempt_no_cambio_sale_vacio_y_la_evidencia_es_completa() {
    let (w, a) = done_world();
    let r = at(&w, "README.md", Some(&wt(&a)));
    assert_eq!(r["touched_by"], json!([]));
    assert_eq!((r["evidence"]["completeness"].as_str(), r["evidence"]["scanned"].as_i64(), r["evidence"]["skipped_total"].as_i64()), (Some("complete"), Some(1), Some(0)));
    let r = at(&w, "no/existe/nunca.rs", None);
    assert_eq!(r["touched_by"], json!([]), "una ruta desconocida no es un error: nadie la tocó");
    assert_eq!((r["owner"]["state"].as_str(), r["owner"]["reason"].as_str(), r["workspace"].clone()), (Some("none"), Some("no_workspace"), Value::Null));
}

#[test]
fn el_dueno_actual_es_el_attempt_vivo_y_no_depende_de_que_haya_tocado_el_archivo() {
    let (w, a) = running_world();
    let r = at(&w, "src.txt", Some(&wt(&a)));
    assert_eq!((r["owner"]["state"].as_str(), r["owner"]["attempt"]["id"].as_str(), r["owner"]["attempt"]["status"].as_str()), (Some("owned"), Some(a.as_str()), Some("running")));
    assert_eq!(r["owner"]["attempt"]["link"], format!("lixbon://project/{}/task/{}/attempt/{a}?view=overview", w.project, task_of(&a)));
    // Dueño del workspace sí; del archivo todavía no: no lo ha cambiado.
    assert_eq!(r["touched_by"], json!([]));
    // Cuando lo cambia, aparece en la historia con la rama viva, sin que el dueño cambie.
    commit(&w.core, &a, &[("src.txt", "en curso\n")]);
    let r = at(&w, "src.txt", Some(&wt(&a)));
    assert_eq!((r["owner"]["state"].as_str(), r["touched_by"][0]["attempt_id"].as_str(), r["touched_by"][0]["is_current_attempt"].as_bool()), (Some("owned"), Some(a.as_str()), Some(true)));
    release(&w, &a);
    let r = at(&w, "src.txt", Some(&wt(&a)));
    assert_eq!((r["owner"]["state"].as_str(), r["owner"]["reason"].as_str()), (Some("none"), Some("no_live_attempt")), "al terminar deja de ser dueño");
}

#[test]
fn varios_attempts_que_tocaron_el_archivo_salen_todos_y_sin_elegir_uno() {
    let (w, a1) = done_world();
    // Otra Task, con su propio worktree, que cambia el mismo archivo.
    let a2 = w.create("claude", "own-segundo");
    w.adapter.set_script(vec![Step::Output("otra vez".into()), Step::Complete(Some("hecho".into()))]);
    w.approve(&a2);
    w.settled(&a2, "done");
    commit(&w.core, &a2, &[("src.txt", "distinto\n")]);

    let r = at(&w, "src.txt", None);
    let ids: Vec<&str> = r["touched_by"].as_array().unwrap().iter().map(|c| c["attempt_id"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), 2, "{r}");
    assert!(ids.contains(&a1.as_str()) && ids.contains(&a2.as_str()));
    // Orden determinista: el más reciente primero.
    assert_eq!(ids[0], a2);
    // Y sin worktree nombrado no hay dueño: el checkout del Project no es de un Attempt.
    assert_eq!(r["owner"]["state"], "none");
}

#[test]
fn un_attempt_anterior_sin_review_no_tiene_evidencia_y_eso_no_se_lee_como_que_no_lo_toco() {
    let w = world("claude", Some(vec![Step::Output("empiezo".into()), Step::Fail(super::adapter::AdapterError::provider("el proveedor se cayó"))]));
    let a1 = w.create("claude", "own-retry");
    w.approve(&a1);
    w.settled(&a1, "failed");
    commit(&w.core, &a1, &[("src.txt", "del primero\n")]);
    let task = task_of(&a1);
    let a2 = format!("{task}-a2");
    w.adapter.set_script(vec![Step::Output("ahora sí".into()), Step::Complete(Some("hecho".into()))]);
    w.desktop("attempt_retry", json!({"task_id": task, "from_attempt_id": a1})).expect("el reintento");
    w.settled(&a2, "done");

    let r = at(&w, "src.txt", Some(&wt(&a1)));
    // La rama de la Task es la del Attempt actual (a2): a1 ya no tiene rama propia ni Review que leer.
    assert_eq!(r["evidence"]["completeness"], "partial");
    assert_eq!(r["evidence"]["skipped"], json!([{ "attempt_id": a1, "reason": "no_evidence" }]));
    // a2 (el actual) sí se mide, contra la rama viva compartida: ve el cambio de a1 en la rama.
    assert_eq!(r["touched_by"][0]["attempt_id"], a2);
    // Los dos usaron el mismo worktree: el dueño sigue siendo ninguno (los dos son finales).
    assert_eq!((r["owner"]["state"].as_str(), r["owner"]["reason"].as_str()), (Some("none"), Some("no_live_attempt")));
}

#[test]
fn con_review_la_evidencia_es_el_rango_inmutable_aunque_el_worktree_se_quite() {
    // La custodia es global: en serie con las pruebas que dejan un proceso a nombre de `t2-a1`.
    let _serie = super::pty::pruebas::serie_custodia();
    let (w, a) = done_world();
    let head = head_of(&w.core, &a);
    assert_eq!(w.desktop("attempt_review", json!({"attempt_id": a, "decision": "accepted", "head_commit": head, "confirm": true})).unwrap()["outcome"], "recorded");
    let r = w.desktop("attempt_integrate", json!({"attempt_id": a, "action": "merge", "head_commit": head, "confirm": true})).unwrap();
    assert_eq!(r["outcome"], "merged", "{r}");
    w.desktop("resource_delete_worktree", json!({ "task_id": task_of(&a), "confirm": true, "discard_uncommitted": false })).expect("quitar el worktree");

    let r = at(&w, "src.txt", Some(&wt(&a)));
    assert_eq!((r["workspace"]["state"].as_str(), r["owner"]["state"].as_str(), r["owner"]["reason"].as_str()), (Some("removed"), Some("none"), Some("worktree_removed")));
    // La historia no se borra con el worktree: el Review guardó el rango y los commits siguen en el repositorio.
    assert_eq!(r["touched_by"][0]["attempt_id"], a, "{r}");
    assert_eq!((r["touched_by"][0]["evidence"]["source"].as_str(), r["touched_by"][0]["evidence"]["head_commit"].as_str()), (Some("review"), Some(head.as_str())));
}

#[test]
fn un_worktree_de_otra_maquina_se_dice_y_su_evidencia_queda_como_no_disponible() {
    let (w, a) = done_world();
    w.core
        .storage
        .with_store(|s| s.write(|tx| Ok(tx.execute("UPDATE meta SET value = 'otra-maquina' WHERE key = 'machine_id'", [])?)))
        .expect("almacén abierto")
        .expect("la máquina local cambia");
    let r = at(&w, "src.txt", Some(&wt(&a)));
    assert_eq!(r["workspace"]["host"], "other");
    assert_eq!(r["touched_by"], json!([]));
    assert_eq!((r["evidence"]["completeness"].as_str(), r["evidence"]["skipped"][0]["reason"].as_str()), (Some("partial"), Some("host_unavailable")));
    // El dueño sale del almacén, que es el mismo en cualquier máquina.
    assert_eq!(r["owner"]["state"], "none");
}

#[test]
fn la_revision_del_editor_se_compara_con_la_vigente_del_worktree() {
    let (w, a) = done_world();
    let head = head_of(&w.core, &a);
    let ask = |rev: &str| w.desktop("work_at", json!({ "project_id": w.project, "path": "src.txt", "worktree_id": wt(&a), "revision": rev })).unwrap()["revision"].clone();
    let current = ask(&head[..7].to_uppercase());
    assert_eq!((current["state"].as_str(), current["current"].as_str()), (Some("current"), Some(head.as_str())));
    commit(&w.core, &a, &[("otro.txt", "mas\n")]);
    let stale = ask(&head);
    assert_eq!((stale["state"].as_str(), stale["requested"].as_str()), (Some("stale"), Some(head.as_str())));
    assert_ne!(stale["current"].as_str(), Some(head.as_str()));
    // Sin worktree no hay vigente que comparar: se dice `unknown`, no se da por buena.
    let sin = w.desktop("work_at", json!({ "project_id": w.project, "path": "src.txt", "revision": head })).unwrap();
    assert_eq!(sin["revision"]["state"], "unknown");
    assert_eq!(w.desktop("work_at", json!({ "project_id": w.project, "path": "src.txt" })).unwrap()["revision"], Value::Null);
}

#[test]
fn la_ruta_se_valida_como_en_los_deep_links_y_nunca_es_un_patron_de_git() {
    let (w, a) = done_world();
    for peligrosa in ["../secreto", "a/../../secreto", "%2e%2e/secreto", "/etc/passwd", "C:/Windows", "a\\b", "a//b", "a/", "", "a\u{0}b", "%252e%252e/x"] {
        let e = err(&w, json!({ "project_id": w.project, "path": peligrosa, "worktree_id": wt(&a) }));
        assert!(e.starts_with("model_invalid_request: "), "{peligrosa:?}: {e}");
    }
    // `*` y `:(top)` son nombres de archivo, no patrones ni magia de pathspec: no devuelven «todo».
    for patron in ["*", "src.*", ":(top)src.txt", ":/src.txt"] {
        assert_eq!(at(&w, patron, Some(&wt(&a)))["touched_by"], json!([]), "{patron}");
    }
    for rev in ["HEAD", "xyz1234", "abc"] {
        assert!(err(&w, json!({ "project_id": w.project, "path": "src.txt", "revision": rev })).starts_with("model_invalid_request: "), "{rev}");
    }
}

#[test]
fn ids_ajenos_inexistentes_o_parametros_de_mas_se_rechazan() {
    let (w, a) = done_world();
    assert!(err(&w, json!({ "project_id": "no-existe", "path": "src.txt" })).starts_with("model_not_found: "));
    assert!(err(&w, json!({ "project_id": w.project, "path": "src.txt", "worktree_id": "wt-no-existe" })).starts_with("model_not_found: "));
    // Un worktree que existe pero es de otro Project no se lee con este.
    let repo = repo_with_commit();
    let otro = id_de(&w.desktop("project_add", json!({ "path": repo.to_string_lossy(), "name": "otro" })).expect("segundo Project"));
    let e = err(&w, json!({ "project_id": otro, "path": "src.txt", "worktree_id": wt(&a) }));
    assert!(e.starts_with("model_not_found: ") && e.contains("no es de ese Project"), "{e}");
    assert!(err(&w, json!({ "path": "src.txt" })).starts_with("model_invalid_request: "));
    assert!(err(&w, json!({ "project_id": w.project })).starts_with("model_invalid_request: "));
    assert!(err(&w, json!({ "project_id": w.project, "path": 5 })).starts_with("model_invalid_request: "));
    assert!(err(&w, json!({ "project_id": w.project, "path": "src.txt", "otro": 1 })).starts_with("model_invalid_request: "));
}

#[test]
fn solo_una_person_autenticada_consulta_y_la_autorizacion_va_primero() {
    let (w, a) = done_world();
    let hostil = json!({ "project_id": "no-existe", "path": "../secreto", "worktree_id": wt(&a) });
    // Directo a la función, sin el filtro del RPC: sin Person autenticada no se valida ni se busca nada.
    for (caller, context) in [(Caller::Agent(None), None), (Caller::Agent(Some(task_of(&a))), None), (Caller::User, None)] {
        let e = super::ownership_read::work_at(&w.core, &caller, context, &hostil).expect_err("sin Person");
        assert!(e.starts_with("model_auth_required: "), "{e}");
    }
    for agent in [None, Some(task_of(&a))] {
        let e = w.core.rpc_via(super::events::Channel::Lxo, Caller::Agent(agent), "", "work_at", &json!({ "project_id": w.project, "path": "src.txt" })).expect_err("un agente no consulta");
        assert!(!e.contains("touched_by"), "{e}");
    }
}

#[test]
fn dos_attempts_vivos_en_un_worktree_se_devuelven_como_candidatos_y_no_se_elige_uno() {
    // La base de datos lo impide (regla en serie), así que se prueba la decisión sobre filas reales con un estado imposible.
    let (w, a) = done_world();
    let (worktree, attempt) = w
        .core
        .storage
        .with_store(|s| Ok::<_, crate::store::StoreError>((s.worktree_row(&wt(&a))?.expect("worktree"), s.attempt_row(&a)?.expect("attempt"))))
        .expect("almacén abierto")
        .expect("lectura");
    let vivo = |id: &str| crate::store::AttemptRow { id: id.into(), status: crate::store::AttemptStatus::Running, ..attempt.clone() };
    let owner = |users: Vec<crate::store::AttemptRow>| super::ownership_read::owner_json(&w.project, Some(&(worktree.clone(), users)), &[]);

    let uno = owner(vec![attempt.clone(), vivo("t9-a1")]);
    assert_eq!((uno["state"].as_str(), uno["attempt"]["id"].as_str()), (Some("owned"), Some("t9-a1")), "los finales no cuentan");
    let dos = owner(vec![vivo("t9-a1"), vivo("t9-a2")]);
    assert_eq!((dos["state"].as_str(), dos["attempt"].clone()), (Some("ambiguous"), Value::Null));
    assert_eq!(dos["candidates"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect::<Vec<_>>(), ["t9-a1", "t9-a2"]);
    assert_eq!(owner(vec![attempt.clone()])["reason"], "no_live_attempt");
}
