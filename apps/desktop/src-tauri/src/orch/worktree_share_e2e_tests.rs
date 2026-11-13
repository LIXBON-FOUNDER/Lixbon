//! LXO-248 · Compartir el worktree de otro Attempt, de extremo a extremo por la superficie de Desktop (`rpc_via(Ui, User)`) con git real y un
//! proveedor falso. Diseño: `docs/core/WORKTREE_SHARED.md`. Cada prueba comprueba el disco (qué carpetas existen), el registro durable y los
//! bloqueos del Resource Manager.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::attempt_e2e_tests::{wait_until, world, World};
use super::dispatch_tests::row;

fn detail(w: &World, attempt: &str) -> Value {
    w.desktop("attempt_detail", json!({"attempt_id": attempt})).expect("attempt_detail")["attempt"].clone()
}

fn worktree_dir(w: &World, attempt: &str) -> PathBuf {
    PathBuf::from(detail(w, attempt)["worktree"]["path"].as_str().unwrap_or_else(|| panic!("el Attempt {attempt} no tiene worktree: {}", detail(w, attempt))))
}

/// Cuántas carpetas de worktree hay junto a la del dueño (git real): compartir no crea ninguna.
fn worktrees_en_disco(dir: &Path) -> usize {
    std::fs::read_dir(dir.parent().unwrap()).map(|d| d.filter_map(Result::ok).filter(|e| e.path().is_dir()).count()).unwrap_or(0)
}

/// Cuántos `worktree.attached` dejó ese Attempt (el hecho cuelga del WORKTREE y lleva al Attempt en su payload).
fn adjuntos(w: &World, attempt: &str) -> i64 {
    w.core
        .storage
        .with_store(|s| s.read(|c| Ok(c.query_row("SELECT count(*) FROM events WHERE kind = 'worktree.attached' AND json_extract(payload, '$.attempt') = ?1", [attempt], |r| r.get(0))?)))
        .unwrap()
        .unwrap()
}

fn share(w: &World, attempt: &str, from: &str, confirm: bool) -> Result<Value, String> {
    let mut args = json!({"attempt_id": attempt, "from_attempt_id": from});
    if confirm {
        args["confirm"] = json!(true);
    }
    w.desktop("attempt_share_worktree", args)
}

/// El dueño termina; otro Attempt de otra Task del mismo Project comparte su worktree ANTES de aprobar, se aprueba y trabaja en la MISMA carpeta
/// sin crear otra. Mientras trabaja, ni se limpia ni se borra el worktree de la dueña. Al terminar quien comparte nada se borra; solo entonces
/// la dueña puede borrarlo.
#[test]
fn compartir_el_worktree_no_crea_otro_y_la_duena_no_lo_borra_mientras_otro_trabaja() {
    let w = world("claude", None);
    let a1 = w.create("claude", "owner");
    w.approve(&a1);
    w.settled(&a1, "done");
    let dir = worktree_dir(&w, &a1);
    let owner_task = detail(&w, &a1)["task_id"].as_str().unwrap().to_string();
    assert!(dir.is_dir());
    let carpetas = worktrees_en_disco(&dir);

    // Otro Attempt de otra Task: nace pendiente. Compartir exige la confirmación explícita.
    w.adapter.push_turn(vec![Step::Bind("sess-share"), Step::Hold, Step::Complete(Some("hecho".into()))]);
    let a2 = w.create("claude", "sharer");
    let sin = share(&w, &a2, &a1, false).unwrap_err();
    assert!(sin.contains("share_confirm_required"), "{sin}");
    assert_eq!(detail(&w, &a2)["worktree"], Value::Null, "sin confirmar no se enlaza nada");

    let shared = share(&w, &a2, &a1, true).expect("compartir");
    assert_eq!((shared["status"].as_str(), shared["owner_task_id"].as_str()), (Some("Shared"), Some(owner_task.as_str())));
    assert_eq!(share(&w, &a2, &a1, true).unwrap()["status"], "AlreadyShared", "repetir no cambia nada");
    assert_eq!(adjuntos(&w, &a2), 1);
    // Desde que se enlaza ocupa el worktree: aunque aún espere su aprobación, la dueña ya no puede borrarlo.
    let ocupado = w.desktop("resource_delete_worktree", json!({"task_id": owner_task, "confirm": true})).unwrap_err();
    assert!(ocupado.contains("shared_in_use"), "{ocupado}");

    w.approve(&a2);
    wait_until("quien comparte trabaja", || row(&w.core, &a2).0 == "running");
    assert_eq!(worktree_dir(&w, &a2), dir, "trabaja en la MISMA carpeta");
    assert_eq!(worktrees_en_disco(&dir), carpetas, "compartir no crea otro worktree");
    let ocupado = w.desktop("resource_clean", json!({"task_id": owner_task, "confirm": true})).unwrap_err();
    assert!(ocupado.contains("shared_in_use"), "{ocupado}");
    assert!(dir.is_dir(), "nada se borró");

    w.adapter.release_hold();
    w.settled(&a2, "done");
    assert!(dir.is_dir(), "al terminar quien comparte no se borra nada: no es el dueño");
    // El Resource Manager de la Task que comparte no tiene worktree propio: no toca el del dueño.
    let a2_task = detail(&w, &a2)["task_id"].as_str().unwrap().to_string();
    let nada = w.desktop("resource_delete_worktree", json!({"task_id": a2_task, "confirm": true})).expect("no hay nada que borrar");
    assert_eq!(nada["outcome"], "nothing_to_do", "{nada}");
    assert!(dir.is_dir(), "borrar «el worktree» de quien comparte NO borra el del dueño");

    // Sin nadie vivo, la dueña sí lo puede borrar.
    let borrado = w.desktop("resource_delete_worktree", json!({"task_id": owner_task, "confirm": true})).expect("la dueña lo borra");
    assert_eq!(borrado["outcome"], "deleted", "{borrado}");
    assert!(!dir.exists());
}

/// Las condiciones de compartir: confirmación, el destino espera su aprobación, y el origen trabaja en un worktree.
#[test]
fn compartir_exige_origen_con_worktree_y_destino_pendiente() {
    let w = world("claude", None);
    let a1 = w.create("claude", "owner");
    w.approve(&a1);
    w.settled(&a1, "done");

    // El origen no trabaja en ningún worktree (otro Attempt que ni ha empezado).
    let sin_worktree = w.create("claude", "sin-worktree");
    let b = w.create("claude", "destino");
    let e = share(&w, &b, &sin_worktree, true).unwrap_err();
    assert!(e.contains("share_source_without_worktree"), "{e}");
    // Un Attempt no comparte consigo mismo ni uno que no existe.
    assert!(share(&w, &a1, &a1, true).unwrap_err().contains("share_invalid"));
    assert!(share(&w, "nada-a1", &a1, true).unwrap_err().contains("share_not_found"));
    // El destino que ya se aprobó (y empezó) no cambia de worktree.
    w.approve(&b);
    w.settled(&b, "done");
    let e = share(&w, &b, &a1, true).unwrap_err();
    assert!(e.contains("share_not_pending"), "{e}");
    // Solo una Person de Desktop.
    let args = json!({"attempt_id": b, "from_attempt_id": a1, "confirm": true});
    assert!(w.core.rpc_via(super::events::Channel::Ui, super::Caller::Agent(None), "", "attempt_share_worktree", &args).is_err());
}

/// En serie: mientras el dueño (o cualquiera) tiene un Attempt vivo en el worktree, otro no se enlaza, y se dice por qué.
#[test]
fn no_se_comparte_un_worktree_con_un_attempt_vivo_en_el_y_nada_cambia() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-owner"), Step::Hold, Step::Complete(None)]);
    let a1 = w.create("claude", "owner");
    w.approve(&a1);
    wait_until("el dueño trabaja", || row(&w.core, &a1).0 == "running");
    let a2 = w.create("claude", "sharer");
    let e = share(&w, &a2, &a1, true).unwrap_err();
    assert!(e.contains("share_conflict") && e.contains("sigue trabajando"), "{e}");
    assert_eq!(detail(&w, &a2)["worktree"], Value::Null, "no quedó enlazado");
    assert_eq!(adjuntos(&w, &a2), 0);
    w.adapter.release_hold();
    w.settled(&a1, "done");
    // Con el dueño ya terminado, sí.
    assert_eq!(share(&w, &a2, &a1, true).unwrap()["status"], "Shared");
}

/// El peor caso: el lanzamiento de quien COMPARTE falla y el Core deshace la provisión. Lo que deshace es lo que esa llamada creó, y compartir no
/// crea nada: el worktree del dueño (con su trabajo) tiene que seguir en disco, activo y enlazado.
#[test]
fn si_el_lanzamiento_de_quien_comparte_falla_el_worktree_del_dueno_sigue_ahi() {
    use super::adapter::AdapterError;

    let w = world("claude", None);
    let a1 = w.create("claude", "owner");
    w.approve(&a1);
    w.settled(&a1, "done");
    let dir = worktree_dir(&w, &a1);
    // El trabajo del dueño vive en esa carpeta: una marca que un borrado se llevaría.
    std::fs::write(dir.join("trabajo-del-dueno.txt"), "no borrar").unwrap();

    let a2 = w.create("claude", "sharer");
    share(&w, &a2, &a1, true).expect("compartir");
    w.adapter.fail_start_with(Some(AdapterError::provider("el proveedor no arranca")));
    w.approve(&a2);
    w.settled(&a2, "failed");

    assert!(dir.is_dir(), "el worktree del dueño NO se borra aunque falle el lanzamiento de quien lo comparte");
    assert_eq!(std::fs::read_to_string(dir.join("trabajo-del-dueno.txt")).unwrap(), "no borrar");
    assert_eq!(detail(&w, &a1)["worktree"]["state"], "active", "sigue activo para su dueño");
}

/// La lista de candidatos del selector: los worktrees activos del mismo Project con el Attempt que se pasa a `attempt_share_worktree`; los que un
/// Attempt vivo está usando salen con `busy_by` (se comparte en serie). Es una lectura: no cambia nada.
#[test]
fn los_candidatos_del_selector_dicen_cuales_estan_ocupados() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-owner"), Step::Hold, Step::Complete(None)]);
    let a1 = w.create("claude", "owner");
    w.approve(&a1);
    wait_until("el dueño trabaja", || row(&w.core, &a1).0 == "running");
    let a2 = w.create("claude", "sharer");

    let lista = |w: &World| w.desktop("attempt_share_candidates", json!({"attempt_id": a2})).expect("candidatos")["candidates"].clone();
    let ocupado = lista(&w);
    assert_eq!(ocupado.as_array().unwrap().len(), 1, "{ocupado}");
    assert_eq!((ocupado[0]["from_attempt_id"].as_str(), ocupado[0]["busy_by"].as_str()), (Some(a1.as_str()), Some(a1.as_str())), "con el dueño vivo está ocupado");
    assert!(ocupado[0]["branch"].is_string() && ocupado[0]["owner_task_title"].is_string());

    w.adapter.release_hold();
    w.settled(&a1, "done");
    let libre = lista(&w);
    assert_eq!(libre[0]["busy_by"], Value::Null, "terminado el dueño ya se puede");
    // El Attempt dueño no se ofrece a sí mismo su propio worktree, y una lectura no cambia nada.
    assert_eq!(w.desktop("attempt_share_candidates", json!({"attempt_id": a1})).unwrap()["candidates"].as_array().unwrap().len(), 0);
    assert_eq!(detail(&w, &a2)["worktree"], Value::Null);
    // Solo una Person de Desktop.
    assert!(w.core.rpc_via(super::events::Channel::Ui, super::Caller::Agent(None), "", "attempt_share_candidates", &json!({"attempt_id": a2})).is_err());
}

/// `resource_inspect` de la Task dueña dice quién comparte su worktree y por qué no se puede limpiar.
#[test]
fn resource_inspect_dice_quien_comparte_el_worktree() {
    let w = world("claude", None);
    let a1 = w.create("claude", "owner");
    w.approve(&a1);
    w.settled(&a1, "done");
    let owner_task = detail(&w, &a1)["task_id"].as_str().unwrap().to_string();
    assert_eq!(w.desktop("resource_inspect", json!({"task_id": owner_task})).unwrap()["shared"]["by"], Value::Null);

    w.adapter.push_turn(vec![Step::Bind("sess-share"), Step::Hold, Step::Complete(None)]);
    let a2 = w.create("claude", "sharer");
    share(&w, &a2, &a1, true).expect("compartir");
    let inspect = w.desktop("resource_inspect", json!({"task_id": owner_task})).unwrap();
    assert_eq!(inspect["shared"]["by"], a2.as_str());
    assert_eq!(inspect["actions"]["delete_worktree"]["reason"], "shared_in_use", "{inspect}");
    w.adapter.release_hold();
}

/// Quien comparte no se revisa ni se integra desde sí mismo; se integra desde el Attempt dueño, y lo que se fusiona incluye el trabajo del dueño y el de quien
/// lo continuó. Después la dueña puede limpiar lo integrado, y limpiar desde quien comparte no toca la carpeta.
#[test]
fn integrar_el_attempt_que_comparte_fusiona_el_trabajo_de_los_dos_y_luego_la_duena_limpia() {
    use super::compare_e2e_tests::{commit, git, task_of};

    let w = world("claude", None);
    let a1 = w.create("claude", "owner");
    w.approve(&a1);
    w.settled(&a1, "done");
    commit(&w.core, &a1, &[("dueno.txt", "trabajo del dueño\n")]);
    let owner_task = task_of(&a1);
    let dir = worktree_dir(&w, &a1);

    let a2 = w.create("claude", "sharer");
    share(&w, &a2, &a1, true).expect("compartir");
    w.approve(&a2);
    w.settled(&a2, "done");
    // Quien comparte trabaja en la MISMA carpeta (el helper localiza el worktree por el Attempt que lo registró: el del dueño).
    assert_eq!(worktree_dir(&w, &a2), dir);
    commit(&w.core, &a1, &[("comparte.txt", "trabajo de quien comparte\n")]);

    // El Attempt que COMPARTE no se revisa ni se integra desde sí mismo (no es dueño): el mensaje dice dónde.
    let head = git(&dir, &["rev-parse", "HEAD"]);
    let e = w.desktop("attempt_review", json!({"attempt_id": a2, "decision": "accepted", "head_commit": head, "confirm": true})).unwrap_err();
    assert!(e.contains("share_not_reviewable") && e.contains(&a1), "{e}");
    let e = w.desktop("attempt_integrate", json!({"attempt_id": a2, "action": "merge", "head_commit": head, "confirm": true})).unwrap_err();
    assert!(e.contains("share_not_reviewable"), "{e}");

    // Se revisa y se integra desde el Attempt dueño, que ya incluye lo que se hizo en esa carpeta.
    assert_eq!(w.desktop("attempt_review", json!({"attempt_id": a1, "decision": "accepted", "head_commit": head, "confirm": true})).unwrap()["outcome"], "recorded");
    let r = w.desktop("attempt_integrate", json!({"attempt_id": a1, "action": "merge", "head_commit": head, "confirm": true})).unwrap();
    assert_eq!(r["outcome"], "merged", "{r}");
    let repo = w.core.project_launch_location(&w.project).unwrap();
    assert!(repo.join("dueno.txt").is_file() && repo.join("comparte.txt").is_file(), "se integró el trabajo de los dos");

    // Quien comparte no tiene worktree propio: limpiar desde su Task no toca la carpeta del dueño.
    let a2_task = task_of(&a2);
    assert_eq!(w.desktop("resource_clean", json!({"task_id": a2_task, "confirm": true})).unwrap()["outcome"], "nothing_to_do");
    assert!(dir.is_dir());
    // La dueña, sin nadie vivo y con su rama integrada, limpia.
    let limpio = w.desktop("resource_clean", json!({"task_id": owner_task, "confirm": true})).expect("la dueña limpia");
    assert_eq!(limpio["outcome"], "cleaned", "{limpio}");
    assert!(!dir.exists());
}
