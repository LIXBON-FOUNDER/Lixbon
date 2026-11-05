//! LXO-148 · Integración de extremo a extremo: `attempt_integration_preview` y `attempt_integrate` sobre Attempts reales, con git de verdad
//! (el Project, su worktree y un remoto local). Se comprueba que solo se integra la revisión aceptada sobre el HEAD exacto, que cada
//! resultado del efecto (`merged`, `conflict`, `error`, `target_moved`…) llega tal cual, que repetir no duplica y que los efectos no
//! llevan rutas.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::attempt_e2e_tests::{attention, world, World};
use super::compare_e2e_tests::{commit, event_total, git, task_of, worktree};
use super::dispatch_tests::event_count;
use super::integration_attempt::IntegrateInput;
use super::{Caller, Core};

impl World {
    fn repo(&self) -> PathBuf {
        self.core.project_launch_location(&self.project).unwrap()
    }

    fn preview(&self, attempt: &str) -> Value {
        self.desktop("attempt_integration_preview", json!({ "attempt_id": attempt })).expect("la vista previa")
    }

    fn head(&self, attempt: &str) -> String {
        git(&worktree(&self.core, attempt), &["rev-parse", "HEAD"])
    }

    fn accept(&self, attempt: &str) -> String {
        let head = self.head(attempt);
        assert_eq!(self.desktop("attempt_review", json!({"attempt_id": attempt, "decision": "accepted", "head_commit": head, "confirm": true})).unwrap()["outcome"], "recorded");
        head
    }

    fn merge(&self, attempt: &str, head: &str, extra: Value) -> Result<Value, String> {
        let mut args = json!({"attempt_id": attempt, "action": "merge", "head_commit": head, "confirm": true});
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            args[k] = v;
        }
        self.desktop("attempt_integrate", args)
    }

    /// Publica con un `gh` simulado: lo que se prueba es el flujo del Core, no GitHub.
    fn publish(&self, attempt: &str, head: &str, create: super::integration::CreatePr) -> Result<Value, String> {
        let ctx = self.core.desktop_mutation_context().unwrap();
        let input = IntegrateInput { attempt_id: attempt.into(), action: "publish_pr".into(), head_commit: head.into(), confirm: true, squash: false, accept_moved_target: None };
        super::integration_attempt::integrate_attempt(&self.core, &ctx, &input, create)
    }
}

fn done_with_work() -> (World, String) {
    let w = world("claude", Some(vec![Step::Output("trabajo".into()), Step::Complete(Some("hecho".into()))]));
    let a1 = w.create("claude", "int-origen");
    w.approve(&a1);
    w.settled(&a1, "done");
    commit(&w.core, &a1, &[("feature.txt", "la función\n")]);
    (w, a1)
}

fn kinds_of_task(core: &Core, task: &str, kinds: &[&str]) -> Vec<(String, String)> {
    core.storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT kind, payload FROM events WHERE entity_id = ?1 ORDER BY seq")?;
                let rows = stmt.query_map([task], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?.into_iter().filter(|(k, _)| kinds.contains(&k.as_str())).collect())
            })
        })
        .unwrap()
        .unwrap()
}

fn with_remote(w: &World) -> PathBuf {
    let bare = w.repo().parent().unwrap().join("remote.git");
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "-q", "--bare"]);
    git(&w.repo(), &["remote", "add", "origin", &bare.to_string_lossy()]);
    bare
}

fn repo_head(dir: &Path) -> String {
    git(dir, &["rev-parse", "HEAD"])
}

#[test]
fn la_vista_previa_dice_que_falta_antes_de_integrar_y_lo_que_se_puede_hacer_despues() {
    let (w, a1) = done_with_work();
    let head = w.head(&a1);

    // Sin revisión aceptada no se ofrece integrar, y se dice por qué.
    let p = w.preview(&a1);
    assert_eq!((p["revision"]["head_commit"].as_str(), p["review"]["state"].as_str()), (Some(head.as_str()), Some("none")));
    assert_eq!(p["can_merge"], json!({"ok": false, "reason": "review_required"}));
    assert_eq!(p["can_publish_pr"], json!({"ok": false, "reason": "review_required"}));

    w.accept(&a1);
    let p = w.preview(&a1);
    assert_eq!(p["review"]["state"], "accepted");
    assert_eq!(p["can_merge"], json!({"ok": true}));
    // El destino es el checkout del Project, en su rama base y sin moverse; sin remoto no hay PR.
    let t = &p["target"];
    assert_eq!((t["kind"].as_str(), t["branch"].as_str(), t["expected_branch"].as_str(), t["branch_matches"].as_bool(), t["moved"].as_bool(), t["clean"].as_bool()), (Some("project_checkout"), Some("main"), Some("main"), Some(true), Some(false), Some(true)));
    assert_eq!(p["can_publish_pr"], json!({"ok": false, "reason": "no_remote"}));
    // Nada de rutas: se habla de ramas y commits.
    let repo = w.repo().to_string_lossy().to_string();
    assert!(!p.to_string().contains(&repo), "la vista previa no lleva rutas: {p}");
    // Es una lectura.
    let before = event_total(&w.core);
    w.preview(&a1);
    assert_eq!(event_total(&w.core), before);
}

#[test]
fn integrar_la_revision_aceptada_fusiona_en_el_project_registra_decision_y_efecto_y_repetir_no_duplica() {
    let (w, a1) = done_with_work();
    let task = task_of(&a1);
    let head = w.accept(&a1);
    let antes = repo_head(&w.repo());

    let r = w.merge(&a1, &head, json!({})).expect("la integración");
    assert_eq!((r["outcome"].as_str(), r["attempt_id"].as_str()), (Some("merged"), Some(a1.as_str())));
    // El trabajo está en la rama base del Project y el HEAD avanzó.
    assert!(w.repo().join("feature.txt").exists());
    let despues = repo_head(&w.repo());
    assert_ne!(antes, despues);
    assert_eq!(r["result_commit"].as_str(), Some(despues.as_str()));

    // Decisión + efecto, ligados, y sin rutas ni textos de git en el log.
    let evs = kinds_of_task(&w.core, &task, &["decision.recorded", "effect.observed"]);
    let merges: Vec<_> = evs.iter().filter(|(k, p)| k == "decision.recorded" && p.contains("\"merge\"")).collect();
    assert_eq!(merges.len(), 1);
    assert!(evs.iter().any(|(k, _)| k == "effect.observed"), "el efecto externo quedó observado");
    let repo = w.repo().to_string_lossy().to_string();
    assert!(evs.iter().all(|(_, p)| !p.contains(&repo)), "los eventos no llevan rutas: {evs:?}");

    // Aceptar no era integrar, y repetir devuelve lo que ya pasó sin otra decisión ni otro merge.
    let before = (event_total(&w.core), repo_head(&w.repo()));
    let again = w.merge(&a1, &head, json!({})).unwrap();
    assert_eq!(again["outcome"], "already_merged");
    assert_eq!((event_total(&w.core), repo_head(&w.repo())), before);
    let p = w.preview(&a1);
    assert_eq!((p["merge"]["merged"].as_bool(), p["can_merge"]["reason"].as_str()), (Some(true), Some("already_merged")));
}

#[test]
fn sin_revision_aceptada_o_con_una_stale_no_se_integra_nada() {
    let (w, a1) = done_with_work();
    let head = w.head(&a1);
    let antes = repo_head(&w.repo());

    // Sin aceptar nada: ni git ni decisión.
    let before = event_total(&w.core);
    let r = w.merge(&a1, &head, json!({})).unwrap();
    assert_eq!((r["outcome"].as_str(), r["head_commit"].as_str()), (Some("review_required"), Some(head.as_str())));
    assert_eq!(w.publish(&a1, &head, &|_, _, _, _, _| Ok("https://x/pr/1".into())).unwrap()["outcome"], "review_required", "el PR también exige la revisión");
    assert_eq!((event_total(&w.core), repo_head(&w.repo())), (before, antes.clone()));

    // Se acepta, y la rama se mueve después: esa aceptación ya no es de este HEAD.
    w.accept(&a1);
    commit(&w.core, &a1, &[("tarde.txt", "llegó después de aceptar\n")]);
    let nuevo = w.head(&a1);
    assert_eq!(w.preview(&a1)["review"]["state"], "stale");
    assert_eq!(w.preview(&a1)["can_merge"]["reason"], "review_required");
    // Con el HEAD viejo que se vio: la rama se movió.
    let moved = w.merge(&a1, &head, json!({})).unwrap();
    assert_eq!((moved["outcome"].as_str(), moved["expected_commit"].as_str(), moved["found_commit"].as_str()), (Some("head_moved"), Some(head.as_str()), Some(nuevo.as_str())));
    // Con el nuevo: no está aceptado.
    assert_eq!(w.merge(&a1, &nuevo, json!({})).unwrap()["outcome"], "review_required");
    assert_eq!(repo_head(&w.repo()), antes, "nada se integró");
    // Aceptado el HEAD nuevo, sí.
    w.accept(&a1);
    assert_eq!(w.merge(&a1, &nuevo, json!({})).unwrap()["outcome"], "merged");
}

#[test]
fn un_destino_movido_se_avisa_y_solo_se_integra_si_la_persona_acepta_el_commit_que_vio() {
    let (w, a1) = done_with_work();
    let head = w.accept(&a1);
    // Alguien commitea en el checkout del Project por fuera de Lixbon.
    std::fs::write(w.repo().join("ajeno.txt"), "otro trabajo\n").unwrap();
    git(&w.repo(), &["add", "."]);
    git(&w.repo(), &["commit", "-qm", "fuera de Lixbon"]);
    let movido = repo_head(&w.repo());

    let p = w.preview(&a1);
    assert_eq!(p["target"]["moved"], true);
    let r = w.merge(&a1, &head, json!({})).unwrap();
    assert_eq!((r["outcome"].as_str(), r["found_commit"].as_str()), (Some("target_moved"), Some(movido.as_str())));
    assert!(!w.repo().join("feature.txt").exists(), "no se integró");

    // Aceptando exactamente el commit que vio, se integra.
    let r = w.merge(&a1, &head, json!({"accept_moved_target": movido})).unwrap();
    assert_eq!((r["outcome"].as_str(), r["accepted_moved_target"].as_bool()), (Some("merged"), Some(true)));
    assert!(w.repo().join("feature.txt").exists() && w.repo().join("ajeno.txt").exists());
}

#[test]
fn un_conflicto_es_el_resultado_del_efecto_levanta_attention_y_no_pierde_historia() {
    let (w, a1) = done_with_work();
    commit(&w.core, &a1, &[("README.md", "versión de la rama\n")]);
    let head = w.accept(&a1);
    std::fs::write(w.repo().join("README.md"), "versión del Project\n").unwrap();
    git(&w.repo(), &["add", "."]);
    git(&w.repo(), &["commit", "-qm", "cambio en main"]);
    let movido = repo_head(&w.repo());

    let r = w.merge(&a1, &head, json!({"accept_moved_target": movido})).unwrap();
    assert_eq!(r["outcome"], "conflict");
    assert!(r["conflicts"].as_array().is_some_and(|c| c.iter().any(|f| f.as_str().is_some_and(|f| f.contains("README.md")))), "{r}");
    // Git abortó el merge: el checkout queda limpio y en su HEAD; la rama del Attempt, intacta.
    assert_eq!(repo_head(&w.repo()), movido);
    assert!(git(&w.repo(), &["status", "--porcelain", "--untracked-files=no"]).is_empty());
    assert_eq!(w.head(&a1), head);
    assert!(attention(&w.core, &task_of(&a1)).contains(&("conflict".to_string(), "active".to_string())), "{:?}", attention(&w.core, &task_of(&a1)));
    assert_eq!(w.preview(&a1)["merge"]["merged"], false);
}

#[test]
fn un_checkout_sucio_o_en_otra_rama_no_se_toca() {
    let (w, a1) = done_with_work();
    let head = w.accept(&a1);
    let antes = repo_head(&w.repo());

    // Cambios sin commit en el Project: la vista previa lo dice y el merge es un error del efecto, sin tocar nada.
    std::fs::write(w.repo().join("README.md"), "a medias\n").unwrap();
    assert_eq!(w.preview(&a1)["can_merge"]["reason"], "checkout_dirty");
    let r = w.merge(&a1, &head, json!({})).unwrap();
    assert_eq!(r["outcome"], "error");
    assert!(r["message"].as_str().is_some_and(|m| m.contains("sin commit")));
    assert_eq!(repo_head(&w.repo()), antes);
    git(&w.repo(), &["checkout", "--", "README.md"]);

    // El Project en otra rama: fusionar ahí sería integrar donde nadie lo pidió.
    git(&w.repo(), &["checkout", "-q", "-b", "otra"]);
    let p = w.preview(&a1);
    assert_eq!((p["target"]["branch_matches"].as_bool(), p["can_merge"]["reason"].as_str()), (Some(false), Some("target_branch_mismatch")));
    let r = w.merge(&a1, &head, json!({})).unwrap();
    assert_eq!((r["outcome"].as_str(), r["expected_branch"].as_str(), r["found_branch"].as_str()), (Some("target_branch_mismatch"), Some("main"), Some("otra")));
    assert_eq!(repo_head(&w.repo()), antes);
    assert!(!w.repo().join("feature.txt").exists());
}

#[test]
fn publicar_un_pr_crea_lo_reconoce_si_ya_existe_y_cuenta_el_error_sin_duplicar() {
    let (w, a1) = done_with_work();
    let bare = with_remote(&w);
    let head = w.accept(&a1);
    assert_eq!(w.preview(&a1)["can_publish_pr"], json!({"ok": true}));

    // Un error de gh: se cuenta como resultado del efecto y no deja un PR registrado.
    let r = w.publish(&a1, &head, &|_, _, _, _, _| Err("gh pr create: sin permisos".into())).unwrap();
    assert_eq!((r["outcome"].as_str(), r["pr_url"].clone()), (Some("error"), Value::Null));
    assert_eq!(w.preview(&a1)["pr"]["url"], Value::Null);

    // Creado: se empujó la rama de verdad y el PR queda en la Task.
    let calls = std::cell::Cell::new(0);
    let create = |_: &str, base: &str, _: &str, _: &str, _: &str| {
        calls.set(calls.get() + 1);
        assert_eq!(base, "main");
        Ok("https://github.com/lixbon/demo/pull/7".to_string())
    };
    let r = w.publish(&a1, &head, &create).unwrap();
    assert_eq!((r["outcome"].as_str(), r["pr_url"].as_str()), (Some("created"), Some("https://github.com/lixbon/demo/pull/7")));
    let branches = git(&bare, &["branch", "--list"]);
    assert!(branches.contains("lx/"), "la rama llegó al remoto: {branches}");

    // Repetir no abre otro: ni push ni gh.
    let again = w.publish(&a1, &head, &create).unwrap();
    assert_eq!((again["outcome"].as_str(), again["pr_url"].as_str()), (Some("already_exists"), Some("https://github.com/lixbon/demo/pull/7")));
    assert_eq!(calls.get(), 1);
    let p = w.preview(&a1);
    assert_eq!((p["pr"]["url"].as_str(), p["can_publish_pr"]["reason"].as_str()), (Some("https://github.com/lixbon/demo/pull/7"), Some("already_exists")));
    // Publicar un PR no es haber integrado.
    assert_eq!(p["merge"]["merged"], false);
}

#[test]
fn la_url_del_pr_solo_sale_saneada_al_cliente_y_una_insegura_sale_vacia_sin_ocultar_que_hay_pr() {
    let (w, a1) = done_with_work();
    with_remote(&w);
    let head = w.accept(&a1);
    // `gh` devolvió una URL con credenciales, query y fragmento: sale limpia.
    let r = w.publish(&a1, &head, &|_, _, _, _, _| Ok("https://ana:secreto@github.com/lixbon/demo/pull/9?token=abc#frag".to_string())).unwrap();
    assert_eq!((r["outcome"].as_str(), r["pr_url"].as_str()), (Some("created"), Some("https://github.com/lixbon/demo/pull/9")));
    assert_eq!(w.preview(&a1)["pr"]["url"], "https://github.com/lixbon/demo/pull/9");

    // Una URL que no es https ni se guarda ni llega al cliente (y el resultado se registra igual: no queda una acción ejecutada sin anotar).
    for raw in ["javascript:alert(1)", "http://github.example/o/r/pull/1"] {
        let (w, a1) = done_with_work();
        with_remote(&w);
        let head = w.accept(&a1);
        let r = w.publish(&a1, &head, &|_, _, _, _, _| Ok(raw.to_string())).unwrap();
        assert_eq!((r["outcome"].as_str(), r["pr_url"].clone()), (Some("created"), Value::Null), "{raw}");
        assert_eq!(w.preview(&a1)["pr"]["url"], Value::Null, "{raw}");
    }
}

#[test]
fn un_pr_que_gh_dice_que_ya_existe_se_reconoce_con_su_url() {
    let (w, a1) = done_with_work();
    with_remote(&w);
    let head = w.accept(&a1);
    let r = w.publish(&a1, &head, &|_, _, _, _, _| Err("a pull request already exists: https://github.com/lixbon/demo/pull/3".into())).unwrap();
    assert_eq!((r["outcome"].as_str(), r["pr_url"].as_str()), (Some("already_exists"), Some("https://github.com/lixbon/demo/pull/3")));
}

#[test]
fn solo_una_persona_integra_el_attempt_actual_terminado_y_con_confirmacion() {
    let (w, a1) = done_with_work();
    let head = w.accept(&a1);
    let task = task_of(&a1);
    let before = (event_total(&w.core), repo_head(&w.repo()));

    assert!(w.merge(&a1, &head, json!({"confirm": false})).unwrap_err().contains("confirmación explícita"));
    assert!(w.desktop("attempt_integrate", json!({"attempt_id": a1, "action": "squash", "head_commit": head, "confirm": true})).unwrap_err().contains("merge o publish_pr"));
    assert!(w.merge(&format!("{task}-a2"), &head, json!({})).unwrap_err().contains("integration_not_current"));
    assert!(w.merge("t999-a1", &head, json!({})).is_err());
    assert_eq!(w.desktop("attempt_integrate", json!({"attempt_id": a1, "action": "merge", "head_commit": head, "confirm": true, "task": task})).unwrap_err(), "Solicitud de integración inválida");
    let args = json!({"attempt_id": a1, "action": "merge", "head_commit": head, "confirm": true});
    assert!(w.core.rpc(Caller::Agent(Some(task.clone())), "", "attempt_integrate", &args).is_err());
    assert!(w.core.rpc_via(super::events::Channel::Lxo, Caller::User, "", "attempt_integrate", &args).is_err());
    assert!(w.core.rpc(Caller::Agent(Some(task)), "", "attempt_integration_preview", &json!({"attempt_id": a1})).is_err());
    assert_eq!((event_total(&w.core), repo_head(&w.repo())), before, "nada de lo anterior dejó rastro");
    assert_eq!(event_count(&w.core, &a1, "attempt.integrated"), 0);
}
