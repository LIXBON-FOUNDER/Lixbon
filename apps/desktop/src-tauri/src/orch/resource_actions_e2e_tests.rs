//! LXO-149 · Resource Manager de extremo a extremo: `resource_inspect`, `resource_clean` y `resource_delete_worktree` sobre worktrees reales.
//! Se comprueba que solo se borra lo integrado y limpio, que lo sucio, lo sin integrar y lo que corre se conserva, que el Core degradado no toca
//! nada, que lo que falta en disco solo se anota y que los efectos no llevan rutas.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::attempt_e2e_tests::{wait_until, world, World};
use super::compare_e2e_tests::{commit, event_total, git, task_of, worktree};
use super::dispatch_tests::row;
use super::{Caller, Core};

impl World {
    fn repo_dir(&self) -> PathBuf {
        self.core.project_launch_location(&self.project).unwrap()
    }

    fn inspect(&self, task: &str) -> Value {
        self.desktop("resource_inspect", json!({ "task_id": task })).expect("inspect")
    }

    fn clean(&self, task: &str) -> Result<Value, String> {
        self.desktop("resource_clean", json!({ "task_id": task, "confirm": true }))
    }

    fn delete(&self, task: &str, discard: bool) -> Result<Value, String> {
        self.desktop("resource_delete_worktree", json!({ "task_id": task, "confirm": true, "discard_uncommitted": discard }))
    }

    /// Revisa, acepta y fusiona el Attempt: su trabajo queda integrado en el Project.
    fn integrate(&self, attempt: &str) {
        let head = git(&worktree(&self.core, attempt), &["rev-parse", "HEAD"]);
        assert_eq!(self.desktop("attempt_review", json!({"attempt_id": attempt, "decision": "accepted", "head_commit": head, "confirm": true})).unwrap()["outcome"], "recorded");
        let r = self.desktop("attempt_integrate", json!({"attempt_id": attempt, "action": "merge", "head_commit": head, "confirm": true})).unwrap();
        assert_eq!(r["outcome"], "merged", "{r}");
    }
}

fn branch_of(core: &Core, task: &str) -> String {
    core.lock().tasks.get(task).unwrap().branch.clone().unwrap()
}

fn branches(repo: &std::path::Path) -> String {
    git(repo, &["branch", "--format=%(refname:short)"])
}

fn done_with_work() -> (World, String, String) {
    let w = world("claude", Some(vec![Step::Output("trabajo".into()), Step::Complete(Some("hecho".into()))]));
    let a1 = w.create("claude", "rm-origen");
    w.approve(&a1);
    w.settled(&a1, "done");
    commit(&w.core, &a1, &[("feature.txt", "la función\n")]);
    let task = task_of(&a1);
    (w, a1, task)
}

/// LXO-242: un proceso de un adapter que no se pudo cerrar con prueba (en la custodia del supervisor) cuenta como «en marcha»: ni se limpia ni se borra el
/// worktree de esa Task hasta que se cierre. Cuando el supervisor lo cierra, el Resource Manager vuelve a poder.
#[test]
fn un_proceso_de_adapter_en_custodia_bloquea_limpiar_y_borrar_hasta_que_se_cierra() {
    use super::adapter::lanza_en_custodia;
    use super::adapter::supervisor;
    use super::pty::pruebas::serie_custodia;

    let _serie = serie_custodia();
    let (w, a1, task) = done_with_work();
    let _asa = lanza_en_custodia(&a1);
    assert!(supervisor::task_in_custody(&task));

    for resultado in [w.clean(&task), w.delete(&task, false)] {
        let e = resultado.unwrap_err();
        assert!(e.contains("resource_blocked: running"), "{e}");
    }
    assert!(worktree(&w.core, &a1).is_dir(), "no se tocó nada");

    assert_eq!(supervisor::reap(), 0, "el supervisor cierra lo que ya se puede probar");
    assert!(!supervisor::task_in_custody(&task));
    assert_eq!(w.delete(&task, false).expect("ya sin proceso en custodia")["outcome"], "deleted");
}

fn removal_events(core: &Core, task: &str) -> Vec<String> {
    core.storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT payload FROM events WHERE kind = 'effect.observed' AND entity_id = ?1 ORDER BY seq")?;
                let rows = stmt.query_map([task], |r| r.get::<_, String>(0))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?.into_iter().filter(|p| p.contains("git_worktree_removed")).collect())
            })
        })
        .unwrap()
        .unwrap()
}

#[test]
fn limpiar_lo_integrado_quita_el_worktree_y_la_rama_registra_el_efecto_sin_rutas_y_repetir_no_hace_nada() {
    let (w, a1, task) = done_with_work();
    w.integrate(&a1);
    let dir = worktree(&w.core, &a1);
    let branch = branch_of(&w.core, &task);
    assert!(dir.exists() && branches(&w.repo_dir()).contains(&branch));

    let i = w.inspect(&task);
    assert_eq!((i["worktree"]["state"].as_str(), i["worktree"]["dirty"].as_bool(), i["branch"]["merged"].as_str()), (Some("present"), Some(false), Some("integrated")));
    assert_eq!(i["actions"]["clean"], json!({"ok": true}));
    assert_eq!(i["health"]["writable"], true);

    let r = w.clean(&task).expect("la limpieza");
    assert_eq!((r["outcome"].as_str(), r["worktree_removed"].as_bool(), r["branch_deleted"].as_bool(), r["branch_kept"].as_bool()), (Some("cleaned"), Some(true), Some(true), Some(false)));
    assert!(!dir.exists(), "la carpeta se quitó");
    assert!(!branches(&w.repo_dir()).contains(&branch), "la rama integrada se borró con -d");
    assert!(w.repo_dir().join("feature.txt").exists(), "el trabajo integrado sigue en el Project");

    // El efecto quedó observado, ligado al estado, y sin rutas.
    let evs = removal_events(&w.core, &task);
    assert_eq!(evs.len(), 1);
    let repo = w.repo_dir().to_string_lossy().to_string();
    assert!(!evs[0].contains(&repo) && !evs[0].contains(&dir.to_string_lossy().to_string()), "sin rutas: {}", evs[0]);
    assert!(evs[0].contains("resource_clean"));
    let after = w.inspect(&task);
    assert_eq!((after["worktree"]["state"].as_str(), after["branch"]["name"].clone()), (Some("none"), Value::Null));

    // Repetir: nada que hacer, sin otro efecto.
    let before = event_total(&w.core);
    let again = w.clean(&task).unwrap();
    assert_eq!(again["outcome"], "nothing_to_do");
    assert_eq!(event_total(&w.core), before);
    assert_eq!(after["actions"]["clean"], json!({"ok": false, "reason": "nothing_to_do"}));
}

#[test]
fn lo_sucio_o_sin_integrar_se_conserva_y_se_dice_por_que() {
    let (w, a1, task) = done_with_work();
    let dir = worktree(&w.core, &a1);
    let branch = branch_of(&w.core, &task);

    // Sin integrar: ni worktree ni rama.
    assert_eq!(w.inspect(&task)["actions"]["clean"], json!({"ok": false, "reason": "not_merged"}));
    let e = w.clean(&task).unwrap_err();
    assert!(e.contains("resource_blocked: not_merged"), "{e}");
    assert!(dir.exists() && branches(&w.repo_dir()).contains(&branch));

    // Integrado pero con cambios sin commit en el worktree: tampoco.
    w.integrate(&a1);
    std::fs::write(dir.join("a_medias.txt"), "sin guardar\n").unwrap();
    git(&dir, &["add", "a_medias.txt"]);
    let i = w.inspect(&task);
    assert_eq!((i["worktree"]["dirty"].as_bool(), i["actions"]["clean"]["reason"].as_str()), (Some(true), Some("dirty")));
    assert!(w.clean(&task).unwrap_err().contains("resource_blocked: dirty"));
    assert!(dir.join("a_medias.txt").exists() && branches(&w.repo_dir()).contains(&branch));
    assert!(removal_events(&w.core, &task).is_empty(), "ningún efecto: no se borró nada");
}

#[test]
fn borrar_el_worktree_conserva_la_rama_con_el_trabajo_y_lo_sin_commit_exige_descartarlo_aparte() {
    let (w, a1, task) = done_with_work();
    let dir = worktree(&w.core, &a1);
    let branch = branch_of(&w.core, &task);

    // Un worktree limpio sin integrar se puede quitar: el trabajo (commit) vive en la rama, que se conserva.
    let i = w.inspect(&task);
    assert_eq!(i["actions"]["delete_worktree"], json!({"ok": true, "discards_uncommitted": false}));
    let r = w.delete(&task, false).unwrap();
    assert_eq!((r["outcome"].as_str(), r["branch_deleted"].as_bool(), r["branch_kept"].as_bool(), r["discarded_uncommitted"].as_bool()), (Some("deleted"), Some(false), Some(true), Some(false)));
    assert!(!dir.exists());
    assert!(branches(&w.repo_dir()).contains(&branch));
    assert!(git(&w.repo_dir(), &["show", &format!("{branch}:feature.txt")]).contains("la función"), "el commit sigue en la rama");
    assert_eq!(w.inspect(&task)["branch"]["name"], branch.as_str());
}

#[test]
fn descartar_cambios_sin_commit_es_una_decision_explicita() {
    let (w, a1, task) = done_with_work();
    let dir = worktree(&w.core, &a1);
    std::fs::write(dir.join("README.md"), "a medias\n").unwrap();

    assert_eq!(w.inspect(&task)["actions"]["delete_worktree"], json!({"ok": true, "discards_uncommitted": true}));
    let e = w.delete(&task, false).unwrap_err();
    assert!(e.contains("resource_blocked: dirty") && e.contains("discard_uncommitted"), "{e}");
    assert!(dir.exists(), "sin la confirmación explícita no se pierde nada");

    let r = w.delete(&task, true).unwrap();
    assert_eq!((r["outcome"].as_str(), r["discarded_uncommitted"].as_bool(), r["branch_kept"].as_bool()), (Some("deleted"), Some(true), Some(true)));
    assert!(!dir.exists());
    assert!(branches(&w.repo_dir()).contains(&branch_of(&w.core, &task)), "la rama nunca se borra aquí");
}

#[test]
fn un_worktree_que_ya_no_esta_en_disco_solo_se_anota_y_repetir_es_un_no_op() {
    let (w, a1, task) = done_with_work();
    let dir = worktree(&w.core, &a1);
    std::fs::remove_dir_all(&dir).unwrap();

    let i = w.inspect(&task);
    assert_eq!((i["worktree"]["state"].as_str(), i["worktree"]["dirty"].clone()), (Some("missing"), Value::Null));
    let before = event_total(&w.core);
    let r = w.delete(&task, false).unwrap();
    assert_eq!((r["outcome"].as_str(), r["worktree_removed"].as_bool()), (Some("forgotten"), Some(false)));
    assert!(removal_events(&w.core, &task).is_empty(), "no hubo efecto externo que observar");
    let _ = before;
    assert_eq!(w.inspect(&task)["worktree"]["state"], "none");
    assert_eq!(w.delete(&task, false).unwrap()["outcome"], "nothing_to_do");
    assert!(branches(&w.repo_dir()).contains(&branch_of(&w.core, &task)), "la rama con el trabajo sigue");
}

#[test]
fn con_el_core_degradado_o_el_intento_en_marcha_no_se_toca_nada() {
    let (w, a1, task) = done_with_work();
    w.integrate(&a1);
    let dir = worktree(&w.core, &a1);
    let branch = branch_of(&w.core, &task);

    w.core.degrade_for_tests("fallo de almacenamiento inyectado");
    let i = w.desktop("resource_inspect", json!({"task_id": task})).unwrap();
    assert_eq!((i["health"]["writable"].as_bool(), i["actions"]["clean"]["reason"].as_str(), i["actions"]["delete_worktree"]["reason"].as_str()), (Some(false), Some("degraded"), Some("degraded")));
    assert!(w.clean(&task).unwrap_err().contains("degraded"));
    assert!(w.delete(&task, true).unwrap_err().contains("degraded"));
    assert!(dir.exists() && branches(&w.repo_dir()).contains(&branch), "el Core no puede registrar el cambio: no se borra nada");

    // Un intento en marcha tampoco: su proceso es el dueño de esa carpeta.
    let live = world("claude", Some(vec![Step::Output("trabajando".into()), Step::Wait]));
    let b1 = live.create("claude", "rm-vivo");
    live.approve(&b1);
    wait_until("corre", || row(&live.core, &b1).0 == "running");
    wait_until("hay ejecución", || live.core.has_term(&task_of(&b1)));
    let ib = live.inspect(&task_of(&b1));
    assert_eq!((ib["process"]["running"].as_bool(), ib["actions"]["clean"]["reason"].as_str(), ib["actions"]["delete_worktree"]["reason"].as_str()), (Some(true), Some("running"), Some("running")));
    assert!(live.delete(&task_of(&b1), true).unwrap_err().contains("running"));
    assert!(worktree(&live.core, &b1).exists());
    live.core.kill_term(&task_of(&b1)).unwrap();
}

#[test]
fn la_peticion_se_valida_y_solo_una_persona_de_desktop_limpia() {
    let (w, a1, task) = done_with_work();
    w.integrate(&a1);
    let dir = worktree(&w.core, &a1);
    let before = event_total(&w.core);

    assert!(w.desktop("resource_clean", json!({"task_id": task})).unwrap_err().contains("confirmación explícita"));
    assert!(w.desktop("resource_delete_worktree", json!({"task_id": task, "confirm": false})).unwrap_err().contains("confirmación explícita"));
    assert!(w.clean("t999").unwrap_err().contains("resource_not_found"));
    assert!(w.desktop("resource_inspect", json!({"task_id": "t999"})).unwrap_err().contains("resource_not_found"));
    assert_eq!(w.desktop("resource_clean", json!({"task_id": task, "confirm": true, "force": true})).unwrap_err(), "Solicitud de recurso inválida");
    assert!(w.desktop("resource_inspect", json!({"task_id": task, "x": 1})).is_err());
    let args = json!({"task_id": task, "confirm": true});
    assert!(w.core.rpc(Caller::Agent(Some(task.clone())), "", "resource_clean", &args).is_err());
    assert!(w.core.rpc_via(super::events::Channel::Lxo, Caller::User, "", "resource_delete_worktree", &args).is_err());
    assert!(w.core.rpc(Caller::Agent(Some(task.clone())), "", "resource_inspect", &json!({"task_id": task})).is_err());
    assert_eq!(event_total(&w.core), before);
    assert!(dir.exists());
}
