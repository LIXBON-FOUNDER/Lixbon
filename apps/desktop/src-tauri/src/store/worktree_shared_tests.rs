//! Pruebas del Worktree COMPARTIDO entre Attempts de Tasks distintas del mismo Project (migración 026, LXO-248). Diseño y reglas:
//! `docs/core/WORKTREE_SHARED.md`. Aquí se prueba que la BASE las impone aunque alguien escriba SQL a mano: mismo Project, en serie (nunca dos
//! Attempts vivos en un Worktree), y el Worktree sigue siendo de la Task que lo creó.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::worktrees::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-wtshared-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

/// Un almacén con el corte hecho y dos Projects: `app` con las Tasks `hija` (la dueña) y `otra`, y `ajeno` con la Task `ajena`.
struct Mundo {
    s: Store,
    project: String,
    hija: String,
    otra: String,
    ajena: String,
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

fn mundo(dir: &Path) -> Mundo {
    mundo_con(dir, &super::migrate::embedded_post_cut())
}

fn mundo_con(dir: &Path, migraciones: &[super::migrate::Migration]) -> Mundo {
    let mut s = Store::open_with(dir, migraciones, "t").unwrap();
    let loc = |path: &str| NewLocation { machine: "m1".into(), path: path.into(), display_path: path.into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc("c:/app")).unwrap().id;
    let ajeno = s.project_create("ajeno", &Fingerprint::default(), &loc("c:/ajeno")).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (_, raiz) = s
        .run_create_recorded(&NewRun { objective: "login".into(), project_id: project.clone(), root: intencion("coordinar") }, 10, |r, t| {
            Ok(vec![evento("run.created", "run", &r.id, t), evento("task.created", "task", &t.id, t)])
        })
        .unwrap();
    let hija = s.task_create_child_recorded(&raiz.id, &intencion("api"), 20, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    let otra = s.task_create_child_recorded(&raiz.id, &intencion("ui"), 21, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    let (_, ajena) = s
        .run_create_recorded(&NewRun { objective: "otro".into(), project_id: ajeno, root: intencion("ajena") }, 30, |r, t| {
            Ok(vec![evento("run.created", "run", &r.id, t), evento("task.created", "task", &t.id, t)])
        })
        .unwrap();
    Mundo { s, project, hija: hija.id, otra: otra.id, ajena: ajena.id }
}

fn corre(w: &mut Mundo, task: &str) -> AttemptRow {
    let new = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    let a = w.s.attempt_create_recorded(task, &new, 100, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap();
    w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, 101, |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, t))).unwrap();
    a
}

fn termina(w: &mut Mundo, id: &str) {
    w.s.attempt_transition_recorded(id, &AttemptAction::Finish { summary: String::new() }, 200, |a, _, t| Ok(evento("attempt.completed", "attempt", &a.id, t))).unwrap();
}

fn nuevo() -> NewWorktree {
    NewWorktree { provenance: Provenance::Created, machine: "m1".into(), repo: "c:/app".into(), path: "c:/wt/t3".into(), branch: Some("lx/r1/t3-api".into()), base_branch: Some("main".into()), base_commit: Some("b0b0b0".into()) }
}

fn registra(w: &mut Mundo, attempt_id: &str) -> WorktreeRow {
    w.s.worktree_register_recorded(attempt_id, &nuevo(), 110, |x, _, t| Ok(evento("worktree.created", "worktree", &x.id, t))).unwrap()
}

fn engancha(w: &mut Mundo, id: &str, attempt_id: &str) -> StoreResult<ChangeOutcome> {
    w.s.worktree_attach_recorded(id, attempt_id, 300, |x, _, t| Ok(evento("worktree.attached", "worktree", &x.id, t)))
}

fn quita(w: &mut Mundo, id: &str) -> StoreResult<ChangeOutcome> {
    w.s.worktree_transition_recorded(id, WorktreeStep::Remove { reason: RemovalReason::Discarded, branch_kept: false }, 400, |x, _, t| Ok(evento("worktree.removed", "worktree", &x.id, t)))
}

fn conflicto<T: std::fmt::Debug>(r: StoreResult<T>, contiene: &str) {
    match r {
        Err(StoreError::WorktreeConflict(m)) => assert!(m.contains(contiene), "«{m}» no menciona «{contiene}»"),
        otro => panic!("se esperaba WorktreeConflict ({contiene}): {otro:?}"),
    }
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

fn error_sql(s: &mut Store, q: &str) -> String {
    sql(s, q).expect_err(q).to_string()
}

/// La 026 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_026_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 26).expect("existe la 026");
    assert_eq!(m.name, "worktree_shared");
    assert_eq!(m.checksum(), "2d62f4fbeb29275df263eb6892585afd87f7218227e7cf963640b02af0d6dada", "una migración publicada no se edita");
}

/// Otra Task del MISMO Project comparte el Worktree en serie: solo cuando el dueño ya no tiene un Attempt vivo en él. El Worktree sigue siendo
/// de la Task que lo creó y quien comparte no lo posee.
#[test]
fn otra_task_del_mismo_project_comparte_el_worktree_en_serie() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = corre(&mut w, &hija);
    let x = registra(&mut w, &a.id);
    let b = corre(&mut w, &otra);

    conflicto(engancha(&mut w, &x.id, &b.id), "sigue trabajando");
    termina(&mut w, &a.id);
    assert_eq!(engancha(&mut w, &x.id, &b.id).unwrap(), ChangeOutcome::Changed);
    assert_eq!(engancha(&mut w, &x.id, &b.id).unwrap(), ChangeOutcome::Unchanged);

    assert_eq!(w.s.attempts_of_worktree(&x.id).unwrap().iter().map(|a| a.id.clone()).collect::<Vec<_>>(), [a.id.clone(), b.id.clone()]);
    assert_eq!(w.s.worktree_of_attempt(&b.id).unwrap().unwrap().id, x.id);
    assert_eq!(w.s.worktree_row(&x.id).unwrap().unwrap().task_id, hija, "el Worktree sigue siendo de la Task que lo creó");
    assert!(w.s.worktrees_of_task(&otra).unwrap().is_empty(), "quien comparte no lo posee");
    assert_eq!(w.s.worktrees_of_task(&hija).unwrap().len(), 1);
}

/// Mientras quien comparte sigue vivo: ni el dueño vuelve a entrar ni se puede quitar el Worktree. Cuando termina, el Worktree se puede quitar.
#[test]
fn mientras_quien_comparte_sigue_vivo_no_entra_otro_ni_se_quita() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = corre(&mut w, &hija);
    let x = registra(&mut w, &a.id);
    termina(&mut w, &a.id);
    let b = corre(&mut w, &otra);
    engancha(&mut w, &x.id, &b.id).unwrap();

    // El dueño intenta volver con un seguimiento mientras `b` trabaja en el Worktree.
    let seguimiento = corre(&mut w, &hija);
    conflicto(engancha(&mut w, &x.id, &seguimiento.id), "sigue trabajando");
    // Y nadie lo puede quitar.
    conflicto(quita(&mut w, &x.id), "sigue trabajando");
    assert_eq!(w.s.worktree_row(&x.id).unwrap().unwrap().state, WorktreeState::Active);

    termina(&mut w, &b.id);
    termina(&mut w, &seguimiento.id);
    assert_eq!(quita(&mut w, &x.id).unwrap(), ChangeOutcome::Changed, "sin nadie vivo se puede quitar");
}

/// Otro Project no comparte: ni por la API del almacén ni escribiendo SQL.
#[test]
fn otro_project_no_comparte_ni_por_sql() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, ajena) = (w.hija.clone(), w.ajena.clone());
    let a = corre(&mut w, &hija);
    let x = registra(&mut w, &a.id);
    termina(&mut w, &a.id);
    let c = corre(&mut w, &ajena);

    conflicto(engancha(&mut w, &x.id, &c.id), "ni del Project");
    let e = error_sql(&mut w.s, &format!("UPDATE attempts SET worktree_id = '{}' WHERE id = '{}'", x.id, c.id));
    assert!(e.contains("otro Project"), "{e}");
    assert_eq!(w.s.worktree_of_attempt(&c.id).unwrap(), None);
}

/// La BASE impone la serie entre Tasks aunque se escriba SQL a mano: con un Attempt vivo en el Worktree, otro de otra Task no se enlaza; cuando
/// ya no hay ninguno vivo, sí.
#[test]
fn la_base_impone_la_serie_entre_tasks_aunque_se_escriba_sql() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = corre(&mut w, &hija);
    let x = registra(&mut w, &a.id);
    let b = corre(&mut w, &otra);

    let e = error_sql(&mut w.s, &format!("UPDATE attempts SET worktree_id = '{}' WHERE id = '{}'", x.id, b.id));
    assert!(e.contains("otro Attempt vivo"), "{e}");
    termina(&mut w, &a.id);
    sql(&mut w.s, &format!("UPDATE attempts SET worktree_id = '{}' WHERE id = '{}'", x.id, b.id)).expect("sin nadie vivo, otra Task del mismo Project puede");
    // Dentro de la misma Task la regla de siempre no cambia: un seguimiento de la dueña sigue pudiendo enlazarse por SQL (lo gobierna `in_use`, en Rust).
    assert_eq!(w.s.worktree_of_attempt(&b.id).unwrap().unwrap().id, x.id);
}

/// Un Worktree que no está activo no se comparte, sea del Project que sea.
#[test]
fn un_worktree_que_no_esta_activo_no_se_comparte() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = corre(&mut w, &hija);
    let x = registra(&mut w, &a.id);
    termina(&mut w, &a.id);
    quita(&mut w, &x.id).unwrap();
    let b = corre(&mut w, &otra);
    conflicto(engancha(&mut w, &x.id, &b.id), "no está activo");
    assert!(sql(&mut w.s, &format!("UPDATE attempts SET worktree_id = '{}' WHERE id = '{}'", x.id, b.id)).is_err());
}

/// La 026 se aplica sobre una base que está en la 025 y YA tiene un Worktree con su Attempt: los conserva y desde ahí se puede compartir.
#[test]
fn la_026_se_aplica_sobre_una_base_en_la_025_y_conserva_lo_que_hay() {
    let t = Tmp::new();
    let hasta_025: Vec<_> = super::migrate::embedded_post_cut().into_iter().filter(|m| m.version <= 25).collect();
    let (hija, otra, ajena, a_id, x_id) = {
        let mut w = mundo_con(t.path(), &hasta_025);
        let hija = w.hija.clone();
        let a = corre(&mut w, &hija);
        let x = registra(&mut w, &a.id);
        termina(&mut w, &a.id);
        assert_eq!(w.s.schema_version().unwrap(), 25);
        // Antes de la 026 otra Task NO podía, aunque el dueño ya hubiera terminado.
        let otra_task = w.otra.clone();
        let b = corre(&mut w, &otra_task);
        assert!(sql(&mut w.s, &format!("UPDATE attempts SET worktree_id = '{}' WHERE id = '{}'", x.id, b.id)).is_err(), "en la 025 solo la misma Task");
        (w.hija.clone(), w.otra.clone(), w.ajena.clone(), a.id, x.id)
    };
    let s = Store::open_with(t.path(), &super::migrate::embedded_post_cut(), "t").unwrap();
    let mut w = Mundo { s, project: String::new(), hija, otra: otra.clone(), ajena };
    assert_eq!(w.s.schema_version().unwrap(), 26);
    assert_eq!(w.s.worktree_of_attempt(&a_id).unwrap().unwrap().id, x_id, "lo que ya estaba enlazado sigue ahí");
    let b = w.s.attempts_of_task(&otra).unwrap().pop().expect("el Attempt de la otra Task");
    assert_eq!(engancha(&mut w, &x_id, &b.id).unwrap(), ChangeOutcome::Changed, "con la 026 sí");
}
