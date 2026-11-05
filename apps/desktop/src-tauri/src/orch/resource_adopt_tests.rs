//! LXO-149/157 · Adoptar un worktree externo de extremo a extremo (migración 024): `resource_adopt_preview` y `resource_adopt` sobre worktrees REALES de git.
//! Se comprueba que solo se adopta lo limpio y comprometido, en una Task sin ejecución del mismo Project, que lo que no se puede adoptar se dice con un
//! código y no deja rastro, que el Attempt adoptado nace terminado sin inventar un historial, que repetir no hace nada y que el estado se reconstruye igual.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::attempt_e2e_tests::{world, World};
use super::compare_e2e_tests::{event_total, git};
use super::events::Channel;
use super::Caller;

impl World {
    fn adopt_repo(&self) -> PathBuf {
        self.core.project_launch_location(&self.project).unwrap()
    }

    /// Una Task del Project SIN Attempt (la intención de trabajo que aún no se ejecutó).
    fn adopt_bare_task(&self, request_id: &str, title: &str) -> String {
        let created = self
            .desktop("task_create", json!({"request_id": request_id, "project_id": self.project, "objective": "o", "title": title, "spec": "s", "repo": self.adopt_repo().to_string_lossy()}))
            .expect("task_create sin attempt");
        assert_eq!(created["status"], "Committed", "{created}");
        created["task_id"].as_str().unwrap().to_string()
    }

    /// Un worktree "externo": lo crea git a mano, fuera del repositorio, con un commit propio en su rama.
    fn adopt_external_worktree(&self, name: &str, branch: &str) -> PathBuf {
        let dir = self.adopt_repo().parent().unwrap().join(name);
        git(&self.adopt_repo(), &["worktree", "add", "-q", "-b", branch, &dir.to_string_lossy()]);
        git(&dir, &["config", "user.name", "Externo"]);
        git(&dir, &["config", "user.email", "externo@example.test"]);
        std::fs::write(dir.join("externo.txt"), "trabajo hecho fuera\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "trabajo externo"]);
        dir
    }

    fn adopt_preview(&self, path: &PathBuf) -> Value {
        self.desktop("resource_adopt_preview", json!({"project_id": self.project, "path": path.to_string_lossy()})).expect("preview")
    }

    fn adopt_it(&self, path: &PathBuf, task: &str) -> Result<Value, String> {
        self.desktop("resource_adopt", json!({"project_id": self.project, "path": path.to_string_lossy(), "task_id": task, "confirm": true}))
    }

    fn adopt_attempts_total(&self) -> i64 {
        self.core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM attempts", [], |r| r.get(0))?))).unwrap().unwrap()
    }

    fn adopt_kinds_of(&self, entity: &str) -> Vec<String> {
        self.core
            .storage
            .with_store(|s| {
                s.read(|c| {
                    let mut stmt = c.prepare("SELECT kind FROM events WHERE entity_id = ?1 ORDER BY seq")?;
                    let rows = stmt.query_map([entity], |r| r.get::<_, String>(0))?;
                    Ok(rows.collect::<Result<Vec<_>, _>>()?)
                })
            })
            .unwrap()
            .unwrap()
    }
}

fn code_of(e: &str) -> &str {
    e.split(':').next().unwrap_or(e)
}

#[test]
fn adoptar_un_worktree_limpio_crea_el_primer_attempt_ya_terminado_sin_inventar_historia() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-1", "revisar trabajo externo");
    let dir = w.adopt_external_worktree("wt-externo", "feature/externo");

    let p = w.adopt_preview(&dir);
    assert_eq!((p["branch"].as_str(), p["base"].as_str(), p["adopt"]["ok"].as_bool()), (Some("feature/externo"), Some("main"), Some(true)), "{p}");
    assert_eq!(p["tasks"], json!([{"task_id": task, "title": "revisar trabajo externo"}]));

    let r = w.adopt_it(&dir, &task).expect("la adopción");
    assert_eq!((r["status"].as_str(), r["attempt_id"].as_str()), (Some("Adopted"), Some(format!("{task}-a1").as_str())), "{r}");

    // El Attempt nació terminado y adoptado; ni arranque ni duración inventados.
    let attempt = format!("{task}-a1");
    let d = w.desktop("attempt_detail", json!({"attempt_id": attempt})).expect("attempt_detail");
    let a = &d["attempt"];
    assert_eq!((a["status"].as_str(), a["provider"].as_str(), a["adopted"].as_bool(), a["origin"].as_str()), (Some("done"), Some("external"), Some(true), Some("core")), "{a}");
    assert!(a["started_at"].is_null() && a["ended_at"].is_null(), "no hay arranque ni fin reales: {a}");
    assert_eq!(a["ended_at_known"], true);
    assert_eq!(a["worktree"]["provenance"], "adopted", "{d}");

    // Un solo hecho, de decisión; sin `attempt.started` ni `attempt.completed`.
    assert_eq!(w.adopt_kinds_of(&attempt).iter().filter(|k| k.starts_with("attempt.")).collect::<Vec<_>>(), ["attempt.adopted"]);
    // Ya no es elegible ni se puede adoptar otra vez en esa Task.
    assert_eq!(w.adopt_preview(&dir)["adopt"]["ok"], false);
}

#[test]
fn lo_que_no_se_puede_adoptar_se_dice_con_un_codigo_y_no_deja_rastro() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-2", "t");
    let dir = w.adopt_external_worktree("wt-sucio", "feature/sucio");
    let (events, attempts) = (event_total(&w.core), w.adopt_attempts_total());

    // Sucio: cambios sin commit (también los archivos nuevos sin seguimiento).
    std::fs::write(dir.join("a_medias.txt"), "sin guardar\n").unwrap();
    assert_eq!(w.adopt_preview(&dir)["adopt"]["code"], "adopt_dirty");
    let e = w.adopt_it(&dir, &task).unwrap_err();
    assert_eq!(code_of(&e), "adopt_dirty", "{e}");
    std::fs::remove_file(dir.join("a_medias.txt")).unwrap();

    // El checkout principal no es un worktree adicional; una carpeta cualquiera no es un worktree.
    let main = w.adopt_repo();
    assert_eq!(code_of(&w.adopt_it(&main, &task).unwrap_err()), "adopt_main_checkout");
    let nada = main.parent().unwrap().join("no-es-un-worktree");
    std::fs::create_dir_all(&nada).unwrap();
    assert_eq!(code_of(&w.adopt_it(&nada, &task).unwrap_err()), "adopt_not_a_worktree");

    // Sin rama (HEAD desacoplado): no hay qué revisar ni integrar.
    let suelto = w.adopt_external_worktree("wt-suelto", "feature/suelto");
    git(&suelto, &["checkout", "-q", "--detach"]);
    assert_eq!(code_of(&w.adopt_it(&suelto, &task).unwrap_err()), "adopt_detached");

    // Sin confirmar no se hace nada.
    let e = w.desktop("resource_adopt", json!({"project_id": w.project, "path": dir.to_string_lossy(), "task_id": task})).unwrap_err();
    assert!(e.contains("confirmación"), "{e}");

    // Una Task que no existe, o que ya corrió, no recibe el worktree.
    let e = w.adopt_it(&dir, "t999").unwrap_err();
    assert_eq!(code_of(&e), "adopt_task_not_found", "{e}");

    assert_eq!((event_total(&w.core), w.adopt_attempts_total()), (events, attempts), "nada de lo rechazado dejó rastro");
}

#[test]
fn solo_una_person_de_desktop_adopta_y_repetir_no_hace_nada() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-3", "t");
    let dir = w.adopt_external_worktree("wt-idem", "feature/idem");
    let args = json!({"project_id": w.project, "path": dir.to_string_lossy(), "task_id": task, "confirm": true});

    // Un agente no adopta, ni lee la previsualización.
    assert!(w.core.rpc_via(Channel::Ui, Caller::Agent(None), "", "resource_adopt", &args).is_err());
    assert!(w.core.rpc_via(Channel::Lxo, Caller::Agent(None), "", "resource_adopt", &args).is_err());
    assert_eq!(w.adopt_attempts_total(), 0);

    assert_eq!(w.adopt_it(&dir, &task).unwrap()["status"], "Adopted");
    let (events, attempts) = (event_total(&w.core), w.adopt_attempts_total());
    let again = w.adopt_it(&dir, &task).expect("repetir");
    assert_eq!(again["status"], "AlreadyAdopted", "{again}");
    assert_eq!((event_total(&w.core), w.adopt_attempts_total()), (events, attempts), "repetir no deja rastro");

    // El mismo worktree no se adopta en OTRA Task: ya tiene dueño.
    let otra = w.adopt_bare_task("ad-3b", "otra");
    assert_eq!(code_of(&w.adopt_it(&dir, &otra).unwrap_err()), "adopt_already_owned");
}

#[test]
fn con_el_core_en_solo_lectura_no_se_adopta_pero_se_previsualiza() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-4", "t");
    let dir = w.adopt_external_worktree("wt-ro", "feature/ro");
    w.core.degrade_for_tests("disco lleno");
    let p = w.adopt_preview(&dir);
    assert_eq!((p["adopt"]["ok"].as_bool(), p["adopt"]["code"].as_str(), p["health"]["writable"].as_bool()), (Some(false), Some("adopt_degraded"), Some(false)), "{p}");
    let e = w.adopt_it(&dir, &task).unwrap_err();
    assert_eq!(code_of(&e), "adopt_degraded", "{e}");
    assert_eq!(w.adopt_attempts_total(), 0);
}

#[test]
fn el_attempt_adoptado_se_reconstruye_igual_y_se_puede_revisar_con_la_evidencia_de_su_rama() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-5", "t");
    let dir = w.adopt_external_worktree("wt-pack", "feature/pack");
    w.adopt_it(&dir, &task).unwrap();
    let attempt = format!("{task}-a1");

    // La vista del almacén coincide con el estado en memoria: la Task adoptada vuelve a leerse igual desde las tablas.
    let t = w.desktop("task_detail_v2", json!({"task_id": task})).expect("task_detail_v2");
    assert_eq!(t["task"]["state"], "in_review", "lo adoptado espera revisión: {t}");
    assert_eq!(t["task"]["attempts"][0]["adopted"], true);

    // Reabrir: lo que las tablas reconstruyen es la Task adoptada, con su worktree, su rama y su Attempt.
    let load = w.core.storage.with_store(|s| s.runtime_load()).unwrap().unwrap();
    let doc = &load.doc["tasks"][&task];
    assert_eq!((doc["adopted"].as_bool(), doc["status"].as_str(), doc["branch"].as_str(), doc["agent"].as_str()), (Some(true), Some("done"), Some("feature/pack"), Some("external")), "{doc}");
    let slash = |p: &str| p.replace('\\', "/");
    assert_eq!(doc["worktree"].as_str().map(slash), Some(slash(&dir.to_string_lossy())));
    assert_eq!(load.attempts.get(&task), Some(&1));

    // La evidencia sale de git (rama contra la base), no de una ejecución que no hubo.
    let pack = w.desktop("attempt_proof_pack", json!({"attempt_id": attempt})).expect("proof pack");
    let text = pack.to_string();
    assert!(text.contains("externo.txt"), "el Proof Pack ve el archivo de la rama adoptada: {text}");
}

#[test]
fn reintentar_o_bifurcar_un_attempt_adoptado_falla_y_no_deja_nada() {
    let w = world("claude", None);
    let task = w.adopt_bare_task("ad-6", "t");
    let dir = w.adopt_external_worktree("wt-retry", "feature/retry");
    w.adopt_it(&dir, &task).unwrap();
    let attempt = format!("{task}-a1");
    let (events, attempts) = (event_total(&w.core), w.adopt_attempts_total());

    let retry = w.desktop("attempt_retry", json!({"task_id": task, "from_attempt_id": attempt}));
    let fork = w.desktop("attempt_fork", json!({"request_id": "fk-ad-1", "source_attempt_id": attempt}));
    assert!(retry.is_err(), "reintentar un adoptado no debe arrancar nada: {retry:?}");
    assert!(fork.is_err(), "bifurcar un adoptado no debe arrancar nada: {fork:?}");
    assert_eq!((event_total(&w.core), w.adopt_attempts_total()), (events, attempts), "lo rechazado no deja rastro");
}
