//! Pruebas del Attempt ADOPTADO en el almacén (migración 024, LXO-149/157). Cubren `docs/core/RESOURCES.md` § Adoptar: un Attempt nace TERMINADO solo
//! si es una adopción (con su Worktree adoptado, primero de su Task, proveedor `external`), nada más lleva `adopted_at`, y lo adoptado es historia
//! como cualquier final. Aquí se prueba que la BASE lo impone aunque alguien escriba SQL a mano; las reglas de producto (limpio, de qué Task) están en
//! `orch/resource_adopt_tests.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::attempts::*;
use super::tasks::*;
use super::worktrees::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-adopt-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Un almacén con el corte hecho, un Project y un Run con su raíz `t2` y una hija `t3` (ninguna con Attempt).
struct Mundo {
    s: Store,
    raiz: String,
    hija: String,
}

fn mundo(dir: &Path) -> Mundo {
    let mut s = Store::open_with(dir, &super::migrate::embedded_post_cut(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let evento = |kind: &str, entity: &str, run: &str, project: Option<&str>| NewEvent {
        id: new_uuid_v7(),
        at: 1_000,
        v: 1,
        kind: kind.into(),
        class: EventClass::State,
        actor_kind: ActorKind::System,
        actor_id: None,
        channel: Some("core".into()),
        client_id: None,
        project_id: project.map(Into::into),
        run_id: Some(run.into()),
        entity_kind: if kind.starts_with("run") { "run" } else { "task" }.into(),
        entity_id: entity.into(),
        correlation_id: None,
        idem_key: None,
        payload: "{}".into(),
    };
    let (run, raiz) = s
        .run_create_recorded(&NewRun { objective: "login".into(), project_id: project.clone(), root: intencion("coordinar") }, 10, |r, t| {
            Ok(vec![evento("run.created", &r.id, &r.id, Some(&project)), evento("task.created", &t.id, &t.run_id, t.project_id.as_deref())])
        })
        .unwrap();
    let hija = s.task_create_child_recorded(&raiz.id, &intencion("api"), 20, |t| Ok(evento("task.created", &t.id, &t.run_id, t.project_id.as_deref()))).unwrap();
    let _ = run;
    Mundo { s, raiz: raiz.id, hija: hija.id }
}

/// Registra la adopción como lo hace el runtime: el Worktree adoptado primero y luego el Attempt terminado, en UNA transacción.
fn adopta(w: &mut Mundo, task: &str, at: i64) -> StoreResult<()> {
    let attempt = format!("{task}-a1");
    let wid = format!("wt-{attempt}");
    w.s.write(|tx| {
        runtime_worktree_insert_adopted_in(
            tx,
            &RuntimeWorktree { id: &wid, task_id: task, attempt_id: &attempt, machine: "m1", repo: "c:/app", path: "c:/otro/wt", branch: Some("feature/x"), base_branch: Some("main"), base_commit: Some("abc1234"), env_plan: None, at },
        )?;
        runtime_attempt_insert_adopted_in(
            tx,
            &RuntimeAttempt { id: &attempt, task_id: task, n: 1, status: AttemptStatus::Done, external: false, provider: "external", model: None, effort: None, role: None, profile: None, worktree_id: Some(&wid), instruction: None, cwd: "c:/otro/wt", at },
            "Trabajo externo adoptado.",
        )
    })
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

fn error_sql(s: &mut Store, q: &str) -> String {
    sql(s, q).expect_err(q).to_string()
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

#[test]
fn una_adopcion_nace_terminada_con_su_worktree_adoptado() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let task = w.hija.clone();
    adopta(&mut w, &task, 500).unwrap();
    let a = w.s.attempts_of_task(&task).unwrap();
    assert_eq!(a.len(), 1);
    let a = &a[0];
    assert_eq!((a.status, a.n, a.external, a.provider.as_str()), (AttemptStatus::Done, 1, false, "external"));
    assert_eq!((w.s.attempt_adopted_at(&a.id).unwrap(), a.started_at, a.ended_at), (Some(500), Some(500), Some(500)));
    assert_eq!(a.worktree_id.as_deref(), Some(format!("wt-{task}-a1").as_str()));
    let wt = w.s.worktree_of_attempt(&a.id).unwrap().expect("el Attempt adoptado lleva su Worktree");
    assert_eq!((wt.provenance.as_str(), wt.state.as_str()), ("adopted", "active"));
}

#[test]
fn un_attempt_que_nace_terminado_sin_ser_adopcion_se_rechaza() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let task = w.hija.clone();
    let e = error_sql(
        &mut w.s,
        &format!(
            "INSERT INTO attempts (id, task_id, n, status, external, provider, summary, cwd, created_at, started_at, ended_at, updated_at, origin)
             VALUES ('{task}-a1', '{task}', 1, 'done', 0, 'claude', 'x', 'c:/app', 5, 5, 5, 5, 'core')"
        ),
    );
    assert!(e.contains("nace pendiente o arrancando"), "{e}");
    assert_eq!(cuenta(&w.s, "attempts"), 0);
}

/// Intenta una variante de la adopción en una transacción que se deshace: devuelve el error de la base.
fn variante(w: &mut Mundo, task: &str, columnas_attempt: &str) -> String {
    let attempt = format!("{task}-a1");
    let wid = format!("wt-{attempt}");
    let r: StoreResult<()> = w.s.write(|tx| {
        tx.execute(
            "INSERT INTO worktrees (id, task_id, attempt_id, provenance, machine, repo, path, branch, base_branch, base_commit, env_plan, state, created_at, updated_at, origin)
             VALUES (?1, ?2, ?3, 'adopted', 'm1', 'c:/app', 'c:/otro/wt', 'feature/x', 'main', 'abc1234', NULL, 'active', 5, 5, 'core')",
            rusqlite::params![wid, task, attempt],
        )?;
        tx.execute(&format!("INSERT INTO attempts (id, task_id, n, status, external, provider, worktree_id, summary, cwd, created_at, started_at, ended_at, updated_at, origin, adopted_at) VALUES ({columnas_attempt})"), rusqlite::params![])?;
        Ok(())
    });
    r.expect_err(columnas_attempt).to_string()
}

#[test]
fn la_forma_de_una_adopcion_la_impone_la_base() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let task = w.hija.clone();
    let id = format!("'{task}-a1'");
    let wid = format!("'wt-{task}-a1'");
    let t_ = format!("'{task}'");
    // Cada variante rompe UNA condición de la forma: debe rechazarla con el trigger de la adopción.
    let casos: [(&str, String); 7] = [
        ("proveedor distinto de external", format!("{id}, {t_}, 1, 'done', 0, 'claude', {wid}, 'x', 'c', 5, 5, 5, 5, 'core', 5")),
        ("external = 1", format!("{id}, {t_}, 1, 'done', 1, 'external', {wid}, 'x', 'c', 5, 5, 5, 5, 'core', 5")),
        ("sin Worktree", format!("{id}, {t_}, 1, 'done', 0, 'external', NULL, 'x', 'c', 5, 5, 5, 5, 'core', 5")),
        ("started_at distinto del instante de adopción", format!("{id}, {t_}, 1, 'done', 0, 'external', {wid}, 'x', 'c', 5, 4, 5, 5, 'core', 5")),
        ("ended_at distinto del instante de adopción", format!("{id}, {t_}, 1, 'done', 0, 'external', {wid}, 'x', 'c', 5, 5, 6, 6, 'core', 5")),
        ("creado después de adoptarse", format!("{id}, {t_}, 1, 'done', 0, 'external', {wid}, 'x', 'c', 9, 5, 5, 9, 'core', 5")),
        ("no nace done", format!("{id}, {t_}, 1, 'starting', 0, 'external', {wid}, 'x', 'c', 5, NULL, NULL, 5, 'core', 5")),
    ];
    for (nombre, columnas) in casos {
        let e = variante(&mut w, &task, &columnas);
        assert!(e.contains("adoptado") || e.contains("nace pendiente"), "{nombre}: {e}");
        assert_eq!((cuenta(&w.s, "attempts"), cuenta(&w.s, "worktrees")), (0, 0), "{nombre}: no debe dejar nada");
    }
}

#[test]
fn un_attempt_adoptado_exige_un_worktree_con_procedencia_adopted() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let task = w.hija.clone();
    let attempt = format!("{task}-a1");
    let wid = format!("wt-{attempt}");
    // Un Worktree con otra procedencia (`created`) no vale para una adopción.
    let r: StoreResult<()> = w.s.write(|tx| {
        tx.execute(
            "INSERT INTO worktrees (id, task_id, attempt_id, provenance, machine, repo, path, branch, base_branch, base_commit, env_plan, state, created_at, updated_at, origin)
             VALUES (?1, ?2, ?3, 'created', 'm1', 'c:/app', 'c:/otro/wt', 'feature/x', 'main', 'abc1234', NULL, 'active', 5, 5, 'core')",
            rusqlite::params![wid, task, attempt],
        )?;
        Ok(())
    });
    // El propio Worktree `created` ya exige un Attempt activo: no puede ni nacer antes que su Attempt.
    assert!(r.is_err(), "solo la procedencia adopted nace antes que su Attempt");
}

#[test]
fn lo_adoptado_es_historia_y_no_se_adopta_dos_veces() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let task = w.hija.clone();
    adopta(&mut w, &task, 500).unwrap();
    // Un final no cambia.
    let e = error_sql(&mut w.s, &format!("UPDATE attempts SET summary = 'otro' WHERE id = '{task}-a1'"));
    assert!(e.to_lowercase().contains("final"), "{e}");
    // No se puede adoptar por segunda vez en la misma Task: el segundo Attempt ya no sería el primero.
    let otra = adopta(&mut w, &task, 600).unwrap_err().to_string();
    assert!(!otra.is_empty());
    assert_eq!(cuenta(&w.s, "attempts"), 1);
    assert_eq!(cuenta(&w.s, "worktrees"), 1);
}

/// La 024 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_024_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 24).expect("existe la 024");
    assert_eq!(m.name, "adopted_attempts");
    assert_eq!(m.checksum(), "f2c449bcadd3a7be919d54390fb0f96bf1e9c3fa6a7ef03453906d29ee965b5d", "una migración publicada no se edita");
}
