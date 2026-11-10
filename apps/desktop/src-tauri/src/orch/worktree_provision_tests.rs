//! El worktree del Attempt (LXO-246, PR A) con git real, un Core persistente y SQLite. Cada prueba comprueba el disco (carpeta
//! y rama), el registro durable (tabla `worktrees`) y el estado del Core. Los repositorios temporales son únicos y no se borran.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use super::dispatch::{intent_from_rows, DispatchIntent, PrepareError};
use super::initial_approval_tests::e2e::core_with_pending_attempt_at;
use super::Core;

static NEXT: AtomicU64 = AtomicU64::new(0);

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// Un directorio nuevo y exclusivo dentro del temporal del sistema. Nunca se borra.
fn scratch(label: &str) -> PathBuf {
    let tick = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("lxo-246-{label}-{}-{tick}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Un repositorio con un commit, en una carpeta propia (el worktree irá a su lado: `<repo>.lixbon-wt/`).
fn repo_with_commit(label: &str) -> PathBuf {
    let repo = scratch(label).join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.name", "LXO 246"]);
    git(&repo, &["config", "user.email", "lxo-246@example.test"]);
    std::fs::write(repo.join("README.md"), "base\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "base"]);
    repo
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Un Core con un Project en `repo` y su primer Attempt aprobado, más la intención que el despachador le pasaría al lanzador.
fn core_with_intent(repo: &Path) -> (Arc<Core>, DispatchIntent) {
    let (core, ctx, task, attempt) = core_with_pending_attempt_at(&text(repo));
    core.mutate_as(&ctx, |tx| tx.approve_attempt(&attempt)).unwrap();
    let snapshot = core.dispatch_snapshot(&attempt).unwrap().unwrap();
    let intent = intent_from_rows(&snapshot.attempt, &snapshot.task, &snapshot.run, repo.to_path_buf()).unwrap();
    assert_eq!(intent.task_id, task);
    (core, intent)
}

/// (estado, ruta, rama, rama conservada, base, commit base, Attempt) de la fila de `worktrees` de la Task.
fn worktree_row(core: &Core, task: &str) -> Option<(String, Option<String>, Option<String>, i64, Option<String>, Option<String>, String)> {
    core.storage
        .with_store(|store| {
            store.read(|c| {
                let mut stmt = c.prepare("SELECT state, path, branch, branch_kept, base_branch, base_commit, attempt_id FROM worktrees WHERE task_id = ?1")?;
                let rows = stmt.query_map([task], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?.into_iter().next())
            })
        })
        .unwrap()
        .unwrap()
}

fn branches(repo: &Path) -> Vec<String> {
    git(repo, &["branch", "--format=%(refname:short)"]).lines().map(str::to_owned).collect()
}

#[test]
fn se_crea_el_worktree_se_registra_y_al_liberarlo_no_queda_nada() {
    let repo = repo_with_commit("ciclo");
    let (core, intent) = core_with_intent(&repo);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    let previous_cwd = core.lock().tasks[&intent.task_id].cwd.clone();

    let wt = core.provision_worktree(&intent).expect("se crea");
    let expected_branch = format!("lx/{}/{}", intent.run_id, intent.attempt_id);
    let expected_dir = repo.parent().unwrap().join("repo.lixbon-wt").join(&intent.attempt_id);
    assert_eq!((wt.branch.as_str(), wt.base.as_str()), (expected_branch.as_str(), "main"));
    // git informa la ruta real (macOS: /private/var frente a /var; Windows: nombres 8.3): se compara la ruta canónica.
    let same = |a: &Path, b: &Path| std::fs::canonicalize(a).unwrap() == std::fs::canonicalize(b).unwrap();
    assert!(same(&wt.dir, &expected_dir), "{:?} frente a {:?}", wt.dir, expected_dir);

    // Disco: la carpeta existe, es un worktree del repo y está en la rama del Attempt, sobre el commit base.
    assert!(wt.dir.is_dir());
    assert_eq!(git(&wt.dir, &["rev-parse", "--abbrev-ref", "HEAD"]), expected_branch);
    assert_eq!(git(&wt.dir, &["rev-parse", "HEAD"]), head);
    assert!(branches(&repo).contains(&expected_branch));

    // Registro durable: Worktree activo vinculado al Attempt, con su rama, su base y su commit base.
    let row = worktree_row(&core, &intent.task_id).expect("hay una fila de worktree");
    assert_eq!(row.0, "active");
    assert_eq!(row.2.as_deref(), Some(expected_branch.as_str()));
    assert_eq!((row.3, row.4.as_deref(), row.5.as_deref(), row.6.as_str()), (0, Some("main"), Some(head.as_str()), intent.attempt_id.as_str()));
    assert!(same(Path::new(row.1.as_deref().unwrap()), &expected_dir));
    let task = core.lock().tasks[&intent.task_id].clone();
    assert!(same(Path::new(task.worktree.as_deref().unwrap()), &expected_dir));
    assert!(same(Path::new(&task.cwd), &expected_dir), "el cwd de la Task es el del worktree");
    let observed: i64 = core
        .storage
        .with_store(|s| s.read(|c| Ok(c.query_row("SELECT count(*) FROM events WHERE kind = 'effect.observed'", [], |r| r.get(0))?)))
        .unwrap()
        .unwrap();
    assert!(observed >= 1, "el efecto git quedó observado en el Event Log");

    core.release_worktree(&wt).expect("se libera");
    assert!(!wt.dir.exists(), "la carpeta se quitó");
    assert!(!branches(&repo).contains(&expected_branch), "la rama, sin trabajo, se borró con branch -d");
    let removed = worktree_row(&core, &intent.task_id).expect("la fila queda como quitada");
    assert_eq!((removed.0.as_str(), removed.3), ("removed", 0), "ya no conserva su rama");
    let task = core.lock().tasks[&intent.task_id].clone();
    assert_eq!((task.worktree, task.branch, task.cwd), (None, None, previous_cwd), "el estado deja de afirmar lo que ya no existe");
    // El repositorio principal no se tocó.
    assert_eq!(git(&repo, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&repo, &["status", "--porcelain"]), "");
}

#[test]
fn una_carpeta_que_ya_existia_hace_fallar_la_creacion_y_no_se_toca() {
    let repo = repo_with_commit("carpeta");
    let (core, intent) = core_with_intent(&repo);
    let existing = repo.parent().unwrap().join("repo.lixbon-wt").join(&intent.attempt_id);
    std::fs::create_dir_all(&existing).unwrap();
    std::fs::write(existing.join("ajeno.txt"), "no es tuyo").unwrap();
    let before = branches(&repo);

    let error = core.provision_worktree(&intent).unwrap_err();
    assert!(matches!(&error, PrepareError::Failed(why) if why.contains("Ya existe la carpeta")), "{error:?}");
    assert_eq!(std::fs::read_to_string(existing.join("ajeno.txt")).unwrap(), "no es tuyo", "lo que no creó esta llamada no se borra");
    assert_eq!(branches(&repo), before, "tampoco se creó la rama");
    assert!(worktree_row(&core, &intent.task_id).is_none());
    assert!(core.lock().tasks[&intent.task_id].worktree.is_none());
}

#[test]
fn una_rama_que_ya_existia_hace_fallar_la_creacion_y_no_se_toca() {
    let repo = repo_with_commit("rama");
    let (core, intent) = core_with_intent(&repo);
    let existing_branch = format!("lx/{}/{}", intent.run_id, intent.attempt_id);
    git(&repo, &["branch", &existing_branch]);
    let tip = git(&repo, &["rev-parse", &existing_branch]);

    let error = core.provision_worktree(&intent).unwrap_err();
    assert!(matches!(error, PrepareError::Failed(_)), "{error:?}");
    assert_eq!(git(&repo, &["rev-parse", &existing_branch]), tip, "la rama ajena sigue donde estaba");
    assert!(!repo.parent().unwrap().join("repo.lixbon-wt").join(&intent.attempt_id).exists());
    assert!(worktree_row(&core, &intent.task_id).is_none());
}

#[test]
fn sin_repositorio_o_sin_commits_no_hay_nada_que_lanzar_y_no_se_escribe_nada() {
    // Una carpeta que no es un repositorio git.
    let plain = scratch("sin-git").join("repo");
    std::fs::create_dir_all(&plain).unwrap();
    let (core, intent) = core_with_intent(&plain);
    let error = core.provision_worktree(&intent).unwrap_err();
    assert!(matches!(&error, PrepareError::Unavailable(why) if why.contains("no es un repositorio git")), "{error:?}");
    assert!(worktree_row(&core, &intent.task_id).is_none());

    // Un repositorio recién creado, sin ningún commit.
    let empty = scratch("sin-commits").join("repo");
    std::fs::create_dir_all(&empty).unwrap();
    git(&empty, &["init", "-q", "-b", "main"]);
    let (core, intent) = core_with_intent(&empty);
    let error = core.provision_worktree(&intent).unwrap_err();
    assert!(matches!(&error, PrepareError::Unavailable(why) if why.contains("ningún commit")), "{error:?}");
    assert!(!empty.parent().unwrap().join("repo.lixbon-wt").exists());
}

#[test]
fn con_el_core_en_solo_lectura_no_se_crea_ni_se_borra_nada() {
    let repo = repo_with_commit("lectura");
    let (core, intent) = core_with_intent(&repo);
    let wt = core.provision_worktree(&intent).unwrap();
    core.degrade_for_tests("prueba");

    assert!(matches!(core.provision_worktree(&intent), Err(PrepareError::Unavailable(_))));
    assert!(core.release_worktree(&wt).is_err());
    assert!(wt.dir.is_dir(), "no se borra lo que no se podría registrar");
    assert!(branches(&repo).contains(&wt.branch));
}

/// Intención del Attempt 2 de la Task: con el 1 ya final (se cerró) y la petición de reintento hecha por la Person.
fn retry_intent(core: &Arc<Core>, ctx: &crate::orch::events::MutationContext, first: &DispatchIntent, repo: &Path) -> DispatchIntent {
    let task = first.task_id.clone();
    core.mutate_as(&crate::orch::events::MutationContext::core(), |tx| tx.close(&task, crate::orch::state::Status::Stopped, "prueba").map(|_| ())).unwrap();
    core.mutate_as(ctx, |tx| tx.request_attempt_retry(&task, &crate::orch::tx_ops::RetrySelection::default())).unwrap();
    let snapshot = core.dispatch_snapshot(&format!("{task}-a2")).unwrap().unwrap();
    intent_from_rows(&snapshot.attempt, &snapshot.task, &snapshot.run, repo.to_path_buf()).unwrap()
}

/// Un segundo Attempt de la MISMA Task (un reintento) no crea otro Worktree: se adjunta al de la Task. El proyector admite uno
/// por Task, y crearlo en disco para que el registro lo rechazara después sería trabajo perdido.
#[test]
fn un_segundo_attempt_de_la_misma_task_reutiliza_su_worktree_y_no_crea_otro() {
    let repo = repo_with_commit("registro");
    let (core, ctx, task, attempt) = core_with_pending_attempt_at(&text(&repo));
    core.mutate_as(&ctx, |tx| tx.approve_attempt(&attempt)).unwrap();
    let snapshot = core.dispatch_snapshot(&attempt).unwrap().unwrap();
    let intent = intent_from_rows(&snapshot.attempt, &snapshot.task, &snapshot.run, repo.clone()).unwrap();
    assert_eq!(intent.task_id, task);
    let first = core.provision_worktree(&intent).unwrap();
    assert!(!first.reused);

    let second = retry_intent(&core, &ctx, &intent, &repo);
    let again = core.provision_worktree(&second).expect("el segundo Attempt reutiliza el Worktree de la Task");
    assert!(again.reused);
    assert_eq!((again.dir.as_path(), again.branch.as_str()), (first.dir.as_path(), first.branch.as_str()));
    let second_dir = repo.parent().unwrap().join("repo.lixbon-wt").join(&second.attempt_id);
    assert!(!second_dir.exists(), "no se creó una carpeta nueva");
    assert!(!branches(&repo).contains(&format!("lx/{}/{}", second.run_id, second.attempt_id)), "ni una rama nueva");

    // Liberar el reutilizado no borra nada: es de la Task y de su Attempt anterior.
    core.release_worktree(&again).unwrap();
    assert!(first.dir.is_dir());
    assert!(branches(&repo).contains(&first.branch));
    assert_eq!(worktree_row(&core, &intent.task_id).unwrap().0, "active");
}

/// Con el Worktree de la Task ya quitado no hay dónde reintentar: `Unavailable` (el Attempt se cierra `stopped`) y NADA se crea.
#[test]
fn con_el_worktree_de_la_task_retirado_no_se_crea_otro_y_se_dice() {
    let repo = repo_with_commit("retirado");
    let (core, ctx, _task, attempt) = core_with_pending_attempt_at(&text(&repo));
    core.mutate_as(&ctx, |tx| tx.approve_attempt(&attempt)).unwrap();
    let snapshot = core.dispatch_snapshot(&attempt).unwrap().unwrap();
    let intent = intent_from_rows(&snapshot.attempt, &snapshot.task, &snapshot.run, repo.clone()).unwrap();
    let first = core.provision_worktree(&intent).unwrap();
    core.release_worktree(&first).unwrap();
    assert_eq!(worktree_row(&core, &intent.task_id).unwrap().0, "removed");

    let second = retry_intent(&core, &ctx, &intent, &repo);
    let error = core.provision_worktree(&second).unwrap_err();
    assert!(matches!(&error, PrepareError::Unavailable(why) if why.contains("no hay dónde reintentar")), "{error:?}");
    assert!(!repo.parent().unwrap().join("repo.lixbon-wt").join(&second.attempt_id).exists());
}

#[test]
fn una_rama_con_trabajo_sin_integrar_se_conserva_al_liberar() {
    let repo = repo_with_commit("rama-con-trabajo");
    let (core, intent) = core_with_intent(&repo);
    let wt = core.provision_worktree(&intent).unwrap();
    // El Attempt dejó un commit en su rama: `branch -d` se niega a borrarla (nunca `-D`).
    std::fs::write(wt.dir.join("trabajo.txt"), "hecho
").unwrap();
    git(&wt.dir, &["add", "."]);
    git(&wt.dir, &["-c", "user.name=LXO", "-c", "user.email=lxo@example.test", "commit", "-qm", "trabajo"]);
    let tip = git(&repo, &["rev-parse", &wt.branch]);

    core.release_worktree(&wt).expect("la carpeta se quita aunque la rama se conserve");
    assert!(!wt.dir.exists());
    assert_eq!(git(&repo, &["rev-parse", &wt.branch]), tip, "el trabajo sin integrar sigue en su rama");
    let row = worktree_row(&core, &intent.task_id).unwrap();
    assert_eq!((row.0.as_str(), row.3, row.2.as_deref()), ("removed", 1, Some(wt.branch.as_str())), "el Worktree quitado sigue conservando su rama");
    assert_eq!(core.lock().tasks[&intent.task_id].branch.as_deref(), Some(wt.branch.as_str()));
}
