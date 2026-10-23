//! Pruebas de Worktree y Artifact en el almacén (migración 010, LXO-116).
//!
//! Cubren `docs/core/WORKTREES_ARTIFACTS.md`: la ruta no es identidad, procedencia creada/adoptada/externa, Worktree
//! ausente en disco, quitar con motivo y sin trabajo en uso, seguimientos en el mismo Worktree, tipos y localizadores
//! de Artifact, sin secretos ni contenido, lecturas por Attempt/Task/Project y estado + evento atómicos.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::worktrees::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-worktree-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

struct Mundo {
    s: Store,
    project: String,
    raiz: String,
    hija: String,
    otra: String,
}

fn evento(kind: &str, entity_kind: &str, entity_id: &str, t: &TaskRow) -> NewEvent {
    NewEvent {
        id: new_uuid_v7(),
        at: 1_000,
        v: 1,
        kind: kind.into(),
        class: EventClass::State,
        actor_kind: ActorKind::System,
        actor_id: None,
        channel: Some("core".into()),
        client_id: None,
        project_id: t.project_id.clone(),
        run_id: Some(t.run_id.clone()),
        entity_kind: entity_kind.into(),
        entity_id: entity_id.into(),
        correlation_id: None,
        idem_key: None,
        payload: "{}".into(),
    }
}

fn base(dir: &Path, activo: bool) -> Mundo {
    let mut s = Store::open_with(dir, &embedded(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (_, raiz) = s
        .run_create_recorded(&NewRun { objective: "login".into(), project_id: project.clone(), root: intencion("coordinar") }, 10, |r, t| {
            Ok(vec![evento("run.created", "run", &r.id, t), evento("task.created", "task", &t.id, t)])
        })
        .unwrap();
    let hija = s.task_create_child_recorded(&raiz.id, &intencion("api"), 20, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    let otra = s.task_create_child_recorded(&raiz.id, &intencion("ui"), 21, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    if !activo {
        s.write(|tx| Ok(tx.execute("DELETE FROM meta WHERE key = ?1", [AGENTIC_MODEL_KEY])?)).unwrap();
    }
    Mundo { s, project, raiz: raiz.id, hija: hija.id, otra: otra.id }
}

fn mundo(dir: &Path) -> Mundo {
    base(dir, true)
}

fn pide(w: &mut Mundo, task: &str) -> AttemptRow {
    let new = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    w.s.attempt_create_recorded(task, &new, 100, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap()
}

fn corre(w: &mut Mundo, task: &str) -> AttemptRow {
    let a = pide(w, task);
    w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, 101, |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, t))).unwrap();
    a
}

fn termina(w: &mut Mundo, id: &str) {
    w.s.attempt_transition_recorded(id, &AttemptAction::Finish { summary: String::new() }, 200, |a, _, t| Ok(evento("attempt.completed", "attempt", &a.id, t))).unwrap();
}

fn nuevo(provenance: Provenance, machine: &str, path: &str) -> NewWorktree {
    NewWorktree { provenance, machine: machine.into(), repo: "c:/app".into(), path: path.into(), branch: Some("lx/r1/t3-api".into()), base_branch: Some("main".into()), base_commit: Some("b0b0b0".into()) }
}

fn registra(w: &mut Mundo, attempt_id: &str, n: &NewWorktree) -> StoreResult<WorktreeRow> {
    w.s.worktree_register_recorded(attempt_id, n, 110, |x, _, t| Ok(evento("worktree.created", "worktree", &x.id, t)))
}

fn paso(w: &mut Mundo, id: &str, step: WorktreeStep, at: i64) -> StoreResult<ChangeOutcome> {
    w.s.worktree_transition_recorded(id, step, at, |x, _, t| Ok(evento("worktree.step", "worktree", &x.id, t)))
}

fn quita(reason: RemovalReason) -> WorktreeStep {
    WorktreeStep::Remove { reason, branch_kept: false }
}

fn engancha(w: &mut Mundo, id: &str, attempt_id: &str) -> StoreResult<ChangeOutcome> {
    w.s.worktree_attach_recorded(id, attempt_id, 300, |x, _, t| Ok(evento("worktree.attached", "worktree", &x.id, t)))
}

fn deja(w: &mut Mundo, attempt_id: &str, kind: ArtifactKind, uri: &str) -> StoreResult<ArtifactRow> {
    let n = NewArtifact { kind, uri: uri.into(), sha256: None, bytes: None };
    w.s.artifact_create_recorded(attempt_id, &n, 150, |x, _, t| Ok(evento("artifact.created", "artifact", &x.id, t)))
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

fn foto(s: &Store) -> Vec<i64> {
    ["worktrees", "artifacts", "events", "attempts"].iter().map(|t| cuenta(s, t)).collect()
}

fn conflicto<T: std::fmt::Debug>(r: StoreResult<T>, contiene: &str) {
    match r {
        Err(StoreError::WorktreeConflict(m)) => assert!(m.contains(contiene), "«{m}» no menciona «{contiene}»"),
        otro => panic!("se esperaba WorktreeConflict ({contiene}): {otro:?}"),
    }
}

fn invalido<T: std::fmt::Debug>(r: StoreResult<T>) {
    assert!(matches!(r, Err(StoreError::InvalidWorktree(_))), "se esperaba InvalidWorktree: {r:?}");
}

// ---------------------------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------------------------

#[test]
fn la_010_es_una_migracion_hacia_adelante_sin_cascadas_ni_contenido() {
    let m = embedded().into_iter().find(|m| m.version == 10).expect("hay migración 010");
    assert_eq!(m.name, "worktrees_artifacts");
    let sin_comentarios: String = m.sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n").to_uppercase();
    for prohibido in ["DROP ", "ALTER TABLE", "ON DELETE", "CASCADE", "BEGIN TRANSACTION", "COMMIT;", "ROLLBACK"] {
        assert!(!sin_comentarios.contains(prohibido), "la 010 no puede llevar «{prohibido}»");
    }
    let t = Tmp::new();
    let w = mundo(t.path());
    let fks = |tabla: &str| -> Vec<(String, String)> {
        w.s.read(|c| Ok(c.prepare(&format!("SELECT \"table\", on_delete FROM pragma_foreign_key_list('{tabla}') ORDER BY \"table\""))?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?)).unwrap()
    };
    let no_action = |t: &str| (t.to_string(), "NO ACTION".to_string());
    assert_eq!(fks("worktrees"), [no_action("attempts"), no_action("tasks")]);
    assert_eq!(fks("artifacts"), [no_action("attempts")]);
    let indices: Vec<String> = w.s.read(|c| Ok(c.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    for i in ["worktrees_by_task", "worktrees_one_active_path", "attempts_by_worktree", "artifacts_by_attempt"] {
        assert!(indices.contains(&i.to_string()), "falta el índice {i}");
    }
    // El Artifact apunta a la evidencia: ninguna columna guarda su contenido.
    let columnas: Vec<String> = w.s.read(|c| Ok(c.prepare("SELECT name FROM pragma_table_info('artifacts') ORDER BY cid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert_eq!(columnas, ["id", "attempt_id", "kind", "uri", "sha256", "bytes", "created_at", "origin"]);
}

/// La 010 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_010_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 10).expect("existe la 010");
    assert_eq!(m.checksum(), "c419f06e190a748429d929e0cfd1fc43f884bd3ed1dd081dd80e3624b438a6d5", "una migración publicada no se edita");
}

#[test]
fn antes_del_corte_nada_escribe() {
    let t = Tmp::new();
    let mut w = base(t.path(), false);
    let antes = foto(&w.s);
    assert!(matches!(registra(&mut w, "t3-a1", &nuevo(Provenance::Created, "m1", "c:/wt/1")), Err(StoreError::AgenticModelInactive)));
    assert!(matches!(deja(&mut w, "t3-a1", ArtifactKind::Commit, "abcdef0"), Err(StoreError::AgenticModelInactive)));
    let q = "INSERT INTO artifacts (id, attempt_id, kind, uri, origin) VALUES ('x', 'x', 'commit', 'abcdef0', 'legacy')";
    assert!(sql(&mut w.s, q).unwrap_err().to_string().contains("inerte"));
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Worktree
// ---------------------------------------------------------------------------------------------

#[test]
fn creado_adoptado_y_externo_se_distinguen_y_no_cambian() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (raiz, hija, otra) = (w.raiz.clone(), w.hija.clone(), w.otra.clone());
    let (a, b, c) = (corre(&mut w, &hija), corre(&mut w, &otra), corre(&mut w, &raiz));
    let creado = registra(&mut w, &a.id, &nuevo(Provenance::Created, "m1", "c:/wt/t3")).unwrap();
    let adoptado = registra(&mut w, &b.id, &nuevo(Provenance::Adopted, "m1", "c:/wt/t4")).unwrap();
    let externo = registra(&mut w, &c.id, &NewWorktree { branch: None, base_branch: None, base_commit: None, ..nuevo(Provenance::External, "m1", "c:/app") }).unwrap();
    assert_eq!([creado.provenance, adoptado.provenance, externo.provenance], [Provenance::Created, Provenance::Adopted, Provenance::External]);
    assert_eq!((creado.id.as_str(), creado.state, creado.machine.as_deref()), (format!("wt-{}", a.id).as_str(), WorktreeState::Active, Some("m1")));
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap().worktree_id.as_deref(), Some(creado.id.as_str()));
    for set in ["provenance = 'created'", "machine = 'm2'", "repo = 'c:/otro'", "branch = 'otra'", "path = 'c:/movido'"] {
        assert!(sql(&mut w.s, &format!("UPDATE worktrees SET {set} WHERE id = '{}'", adoptado.id)).is_err(), "{set}");
    }
}

#[test]
fn la_ruta_es_ubicacion_no_identidad() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra, raiz) = (w.hija.clone(), w.otra.clone(), w.raiz.clone());
    let a = corre(&mut w, &hija);
    let x = registra(&mut w, &a.id, &nuevo(Provenance::Created, "m1", "c:/wt/compartida")).unwrap();
    assert!(!x.id.contains("compartida"), "el id no sale de la ruta");
    // La misma carpeta activa en la misma máquina es otro Worktree: conflicto. En otra máquina es otra ubicación.
    let b = corre(&mut w, &otra);
    conflicto(registra(&mut w, &b.id, &nuevo(Provenance::Created, "m1", "c:/wt/compartida")), "otro Worktree en esta máquina");
    registra(&mut w, &b.id, &nuevo(Provenance::Created, "m2", "c:/wt/compartida")).unwrap();
    // Quitado, la ruta se pierde y la carpeta se puede volver a usar; el Worktree sigue identificado por su id.
    termina(&mut w, &a.id);
    paso(&mut w, &x.id, quita(RemovalReason::Integrated), 400).unwrap();
    let quitado = w.s.worktree_row(&x.id).unwrap().unwrap();
    assert_eq!((quitado.path, quitado.state, quitado.removed_reason), (None, WorktreeState::Removed, Some(RemovalReason::Integrated)));
    let c = corre(&mut w, &raiz);
    registra(&mut w, &c.id, &nuevo(Provenance::Created, "m1", "c:/wt/compartida")).unwrap();
}

#[test]
fn un_worktree_ausente_en_disco_se_representa_y_puede_volver() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let x = registra(&mut w, &a.id, &nuevo(Provenance::Created, "m1", "c:/wt/t3")).unwrap();
    conflicto(paso(&mut w, &x.id, quita(RemovalReason::Gone), 150), "sigue en disco");
    assert_eq!(paso(&mut w, &x.id, WorktreeStep::Lost, 160).unwrap(), ChangeOutcome::Changed);
    assert_eq!(paso(&mut w, &x.id, WorktreeStep::Lost, 161).unwrap(), ChangeOutcome::Unchanged);
    let ausente = w.s.worktree_row(&x.id).unwrap().unwrap();
    assert_eq!((ausente.state, ausente.missing_since, ausente.path.as_deref()), (WorktreeState::Missing, Some(160), Some("c:/wt/t3")), "se conoce dónde debería estar");
    assert_eq!(paso(&mut w, &x.id, WorktreeStep::Found, 170).unwrap(), ChangeOutcome::Changed);
    assert_eq!(w.s.worktree_row(&x.id).unwrap().unwrap().missing_since, None);
    paso(&mut w, &x.id, WorktreeStep::Lost, 180).unwrap();
    termina(&mut w, &a.id);
    // Un seguimiento no trabaja en una carpeta que no está.
    let a2 = corre(&mut w, &hija);
    conflicto(engancha(&mut w, &x.id, &a2.id), "no está activo");
    assert_eq!(paso(&mut w, &x.id, quita(RemovalReason::Gone), 190).unwrap(), ChangeOutcome::Changed);
    assert_eq!(w.s.worktree_row(&x.id).unwrap().unwrap().removed_reason, Some(RemovalReason::Gone));
}

#[test]
fn quitar_no_borra_trabajo_en_uso_ni_lo_externo_y_es_final() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = corre(&mut w, &hija);
    let x = registra(&mut w, &a.id, &nuevo(Provenance::Created, "m1", "c:/wt/t3")).unwrap();
    conflicto(paso(&mut w, &x.id, quita(RemovalReason::Discarded), 150), "sigue trabajando");
    termina(&mut w, &a.id);
    let b = corre(&mut w, &otra);
    let e = registra(&mut w, &b.id, &nuevo(Provenance::External, "m1", "c:/externo")).unwrap();
    termina(&mut w, &b.id);
    conflicto(paso(&mut w, &e.id, quita(RemovalReason::Integrated), 160), "es externo");
    conflicto(paso(&mut w, &e.id, quita(RemovalReason::Discarded), 160), "es externo");
    assert!(sql(&mut w.s, &format!("UPDATE worktrees SET state = 'removed', path = NULL, removed_reason = 'discarded' WHERE id = '{}'", e.id)).is_err(), "ni por SQL");
    // Con su motivo y la rama conservada.
    assert_eq!(paso(&mut w, &x.id, WorktreeStep::Remove { reason: RemovalReason::Discarded, branch_kept: true }, 170).unwrap(), ChangeOutcome::Changed);
    let q = w.s.worktree_row(&x.id).unwrap().unwrap();
    assert_eq!((q.branch.as_deref(), q.branch_kept), (Some("lx/r1/t3-api"), true));
    assert_eq!(paso(&mut w, &x.id, quita(RemovalReason::Discarded), 171).unwrap(), ChangeOutcome::Unchanged);
    conflicto(paso(&mut w, &x.id, WorktreeStep::Found, 172), "no puede pasar de removed a active");
    assert!(sql(&mut w.s, &format!("UPDATE worktrees SET updated_at = 999 WHERE id = '{}'", x.id)).is_err());
    assert!(sql(&mut w.s, &format!("DELETE FROM worktrees WHERE id = '{}'", x.id)).is_err());
    assert_eq!(paso(&mut w, "wt-nada", WorktreeStep::Lost, 1).unwrap(), ChangeOutcome::Missing);
}

#[test]
fn sin_rama_no_hay_rama_que_conservar() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let x = registra(&mut w, &a.id, &NewWorktree { branch: None, ..nuevo(Provenance::Adopted, "m1", "c:/wt/detached") }).unwrap();
    termina(&mut w, &a.id);
    conflicto(paso(&mut w, &x.id, WorktreeStep::Remove { reason: RemovalReason::Discarded, branch_kept: true }, 150), "no tiene rama");
}

#[test]
fn el_seguimiento_trabaja_en_el_mismo_worktree_y_las_lecturas_lo_dicen() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra, project) = (w.hija.clone(), w.otra.clone(), w.project.clone());
    let a1 = corre(&mut w, &hija);
    let x = registra(&mut w, &a1.id, &nuevo(Provenance::Created, "m1", "c:/wt/t3")).unwrap();
    let a2 = corre(&mut w, &otra);
    conflicto(engancha(&mut w, &x.id, &a2.id), "no es de la Task");
    termina(&mut w, &a1.id);
    let s2 = corre(&mut w, &hija);
    assert_eq!(engancha(&mut w, &x.id, &s2.id).unwrap(), ChangeOutcome::Changed);
    assert_eq!(engancha(&mut w, &x.id, &s2.id).unwrap(), ChangeOutcome::Unchanged);
    assert_eq!(w.s.attempts_of_worktree(&x.id).unwrap().iter().map(|a| a.n).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(w.s.worktree_of_attempt(&s2.id).unwrap().unwrap().id, x.id);
    assert_eq!(w.s.worktree_of_attempt(&a2.id).unwrap(), None, "un Attempt sin Worktree es válido");
    assert_eq!(w.s.worktrees_of_task(&hija).unwrap().len(), 1);
    assert_eq!(w.s.worktrees_of_project(&project).unwrap().len(), 1);
    assert!(w.s.worktrees_of_project("p-otro").unwrap().is_empty());
    // Ni por SQL: el vínculo apunta a un Worktree activo de su Task.
    assert!(sql(&mut w.s, &format!("UPDATE attempts SET worktree_id = '{}' WHERE id = '{}'", x.id, a2.id)).is_err());
    assert!(sql(&mut w.s, &format!("UPDATE attempts SET worktree_id = 'wt-nada' WHERE id = '{}'", a2.id)).is_err());
}

#[test]
fn la_tabla_de_transiciones_de_rust_cuadra_con_el_trigger() {
    for from in WorktreeState::ALL {
        for to in WorktreeState::ALL {
            if from == to {
                continue;
            }
            let t = Tmp::new();
            let mut w = mundo(t.path());
            let hija = w.hija.clone();
            let a = corre(&mut w, &hija);
            let (path, missing) = match from {
                WorktreeState::Removed => ("NULL", "NULL"),
                WorktreeState::Missing => ("'c:/wt'", "5"),
                WorktreeState::Active => ("'c:/wt'", "NULL"),
            };
            sql(
                &mut w.s,
                &format!(
                    "INSERT INTO worktrees (id, task_id, attempt_id, provenance, repo, path, branch, state, missing_since, origin) VALUES ('wt-{0}', '{1}', '{0}', 'created', 'c:/app', {path}, 'b', '{2}', {missing}, 'legacy')",
                    a.id,
                    hija,
                    from.as_str()
                ),
            )
            .unwrap();
            let (np, nm) = match to {
                WorktreeState::Removed => ("NULL", "NULL"),
                WorktreeState::Missing => ("path", "5"),
                WorktreeState::Active => ("path", "NULL"),
            };
            let r = sql(&mut w.s, &format!("UPDATE worktrees SET state = '{}', path = {np}, missing_since = {nm} WHERE id = 'wt-{}'", to.as_str(), a.id));
            assert_eq!(r.is_ok(), worktree_transition_allowed(from, to), "{} -> {}: {r:?}", from.as_str(), to.as_str());
        }
    }
}

#[test]
fn sin_su_evento_no_hay_worktree_ni_enlace() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let antes = foto(&w.s);
    let r = w.s.worktree_register_recorded(&a.id, &nuevo(Provenance::Created, "m1", "c:/wt"), 1, |_, a, t| Ok(evento("worktree.created", "attempt", &a.id, t)));
    assert!(matches!(r, Err(StoreError::InvalidEvent(_))), "{r:?}");
    assert_eq!(foto(&w.s), antes);
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap().worktree_id, None);
}

#[test]
fn los_datos_del_worktree_no_admiten_vacios_control_ni_credenciales() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let antes = foto(&w.s);
    invalido(registra(&mut w, &a.id, &nuevo(Provenance::Created, " ", "c:/wt")));
    invalido(registra(&mut w, &a.id, &nuevo(Provenance::Created, "m1", "")));
    invalido(registra(&mut w, &a.id, &nuevo(Provenance::Created, "m1", "c:/wt\n")));
    invalido(registra(&mut w, &a.id, &NewWorktree { repo: "https://x:ghp_0123456789abcdefghij@github.com/a/b".into(), ..nuevo(Provenance::Adopted, "m1", "c:/wt") }));
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------------------------

#[test]
fn cada_tipo_valida_su_localizador() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    for (kind, uri) in [
        (ArtifactKind::Report, "/home/ana/app/.lixbon/informes/r1/t3.md"),
        (ArtifactKind::LastMessage, "C:\\Users\\Ana María\\app\\.lixbon\\out\\t3\\last.txt"),
        (ArtifactKind::PullRequest, "https://github.com/ana/app/pull/42"),
        (ArtifactKind::Commit, "0123456789abcdef0123456789abcdef01234567"),
        (ArtifactKind::File, "docs/evidencia/captura.png"),
    ] {
        let x = deja(&mut w, &a.id, kind, uri).unwrap();
        assert_eq!((x.kind, x.uri.as_str(), x.created_at), (kind, uri, Some(150)));
    }
    let antes = foto(&w.s);
    for (kind, uri) in [
        (ArtifactKind::PullRequest, "http://github.com/ana/app/pull/42"),
        (ArtifactKind::PullRequest, "https://ana:tok@github.com/ana/app/pull/42"),
        (ArtifactKind::PullRequest, "https://github.com/a b"),
        (ArtifactKind::Commit, "abc"),
        (ArtifactKind::Commit, "ABCDEF0123"),
        (ArtifactKind::Commit, "main"),
        (ArtifactKind::Report, "https://ejemplo.com/informe.md"),
        (ArtifactKind::File, "../../etc/passwd"),
        (ArtifactKind::File, ""),
        (ArtifactKind::File, "notas\u{0}.md"),
    ] {
        invalido(deja(&mut w, &a.id, kind, uri));
    }
    assert_eq!(foto(&w.s), antes);
}

#[test]
fn un_artifact_no_guarda_secretos_ni_contenido_y_no_cambia() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    invalido(deja(&mut w, &a.id, ArtifactKind::File, "secretos/sk-ant-api03-AAAAAAAAAAAA.txt"));
    invalido(deja(&mut w, &a.id, ArtifactKind::PullRequest, "https://github.com/a/b/pull/1?token=abc123"));
    let mal_hash = NewArtifact { kind: ArtifactKind::Report, uri: "informe.md".into(), sha256: Some("XYZ".into()), bytes: Some(10) };
    invalido(w.s.artifact_create_recorded(&a.id, &mal_hash, 1, |_, _, _| unreachable!()));
    let negativo = NewArtifact { kind: ArtifactKind::Report, uri: "informe.md".into(), sha256: None, bytes: Some(-1) };
    invalido(w.s.artifact_create_recorded(&a.id, &negativo, 1, |_, _, _| unreachable!()));
    let verificable = NewArtifact { kind: ArtifactKind::Report, uri: "informe.md".into(), sha256: Some("a".repeat(64)), bytes: Some(2048) };
    let x = w.s.artifact_create_recorded(&a.id, &verificable, 150, |x, _, t| Ok(evento("artifact.created", "artifact", &x.id, t))).unwrap();
    assert_eq!((x.sha256.as_deref().map(str::len), x.bytes), (Some(64), Some(2048)));
    assert!(sql(&mut w.s, &format!("UPDATE artifacts SET uri = 'otro.md' WHERE id = '{}'", x.id)).is_err());
    assert!(sql(&mut w.s, &format!("DELETE FROM artifacts WHERE id = '{}'", x.id)).is_err());
}

#[test]
fn un_attempt_que_no_arranco_no_deja_artifacts_y_las_lecturas_cubren_attempt_task_y_project() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra, project) = (w.hija.clone(), w.otra.clone(), w.project.clone());
    let pendiente = pide(&mut w, &otra);
    conflicto(deja(&mut w, &pendiente.id, ArtifactKind::Commit, "abcdef0"), "aún no arrancó");
    conflicto(deja(&mut w, "t99-a1", ArtifactKind::Commit, "abcdef0"), "no existe");
    let a1 = corre(&mut w, &hija);
    deja(&mut w, &a1.id, ArtifactKind::Report, "informe-1.md").unwrap();
    termina(&mut w, &a1.id);
    // Un Attempt terminado todavía deja su evidencia (el informe se recoge al final).
    deja(&mut w, &a1.id, ArtifactKind::PullRequest, "https://github.com/ana/app/pull/42").unwrap();
    let a2 = corre(&mut w, &hija);
    deja(&mut w, &a2.id, ArtifactKind::Report, "informe-2.md").unwrap();
    assert_eq!(w.s.artifacts_of_attempt(&a1.id).unwrap().len(), 2);
    assert_eq!(w.s.artifacts_of_attempt(&a2.id).unwrap().len(), 1, "cada Attempt tiene los suyos");
    assert_eq!(w.s.artifacts_of_task(&hija).unwrap().len(), 3);
    assert_eq!(w.s.artifacts_of_project(&project).unwrap().len(), 3);
    assert!(w.s.artifacts_of_task(&otra).unwrap().is_empty());
}
