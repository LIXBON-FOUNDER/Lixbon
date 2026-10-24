//! Pruebas del Attempt como ejecución concreta en el almacén (migración 008, LXO-114).
//!
//! Cubren `docs/core/ATTEMPTS.md`: identidad histórica inmutable, retry = Attempt nuevo que conserva la historia,
//! ciclo de vida cerrado (la tabla completa, 9×9, contra el trigger de la base), un final que no vuelve atrás, una Task
//! que puede existir sin Attempt activo y estado + evento atómicos. Los eventos se construyen aquí a mano: el almacén
//! no sabe qué hechos existen (eso se prueba en `orch/attempt_ops_tests.rs`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::attempts::*;
use super::tasks::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-attempt-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

/// Un almacén con todas las migraciones, el corte ya hecho, un Project, un Run con su raíz `t2` y una hija `t3`.
struct Mundo {
    s: Store,
    run: String,
    raiz: String,
    hija: String,
}

fn mundo(dir: &Path) -> Mundo {
    let mut s = Store::open_with(dir, &embedded(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (run, raiz) = s
        .run_create_recorded(&NewRun { objective: "login".into(), project_id: project.clone(), root: intencion("coordinar") }, 10, |r, t| {
            Ok(vec![evento("run.created", "run", &r.id, &r.id, Some(&project)), evento("task.created", "task", &t.id, &t.run_id, t.project_id.as_deref())])
        })
        .unwrap();
    let hija = s.task_create_child_recorded(&raiz.id, &intencion("api"), 20, |t| Ok(evento("task.created", "task", &t.id, &t.run_id, t.project_id.as_deref()))).unwrap();
    Mundo { s, run: run.id, raiz: raiz.id, hija: hija.id }
}

fn evento(kind: &str, entity_kind: &str, entity_id: &str, run: &str, project: Option<&str>) -> NewEvent {
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
        project_id: project.map(Into::into),
        run_id: Some(run.into()),
        entity_kind: entity_kind.into(),
        entity_id: entity_id.into(),
        correlation_id: None,
        idem_key: None,
        payload: "{}".into(),
    }
}

/// El evento de un Attempt, con la Run y el Project de su Task.
fn de(kind: &str, a: &AttemptRow, t: &TaskRow) -> NewEvent {
    evento(kind, "attempt", &a.id, &t.run_id, t.project_id.as_deref())
}

fn pide(provider: &str, aprobacion: bool) -> NewAttempt {
    NewAttempt { provider: provider.into(), model: Some("claude-opus-5-5".into()), effort: Some("high".into()), role: Some("implementador".into()), profile: Some("implementar".into()), external: false, requires_approval: aprobacion }
}

fn crea(w: &mut Mundo, task: &str, aprobacion: bool, at: i64) -> AttemptRow {
    w.s.attempt_create_recorded(task, &pide("claude", aprobacion), at, |a, t| Ok(de("attempt.requested", a, t))).unwrap()
}

fn paso(w: &mut Mundo, id: &str, action: AttemptAction, at: i64) -> StoreResult<ChangeOutcome> {
    w.s.attempt_transition_recorded(id, &action, at, |a, _, t| Ok(de("attempt.step", a, t)))
}

fn finaliza(summary: &str) -> AttemptAction {
    AttemptAction::Finish { summary: summary.into() }
}

fn falla(reason: &str) -> AttemptAction {
    AttemptAction::Fail { reason: reason.into(), summary: String::new() }
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

fn error_sql(s: &mut Store, q: &str) -> String {
    sql(s, q).expect_err(q).to_string()
}

/// Todo lo que deja rastro: filas, eventos.
fn foto(s: &Store) -> (i64, i64, i64) {
    (cuenta(s, "attempts"), cuenta(s, "events"), cuenta(s, "tasks"))
}

fn conflicto<T: std::fmt::Debug>(r: StoreResult<T>, contiene: &str) {
    match r {
        Err(StoreError::AttemptConflict(m)) => assert!(m.contains(contiene), "«{m}» no menciona «{contiene}»"),
        otro => panic!("se esperaba AttemptConflict ({contiene}): {otro:?}"),
    }
}

fn invalido<T: std::fmt::Debug>(r: StoreResult<T>) {
    assert!(matches!(r, Err(StoreError::InvalidAttempt(_))), "se esperaba InvalidAttempt: {r:?}");
}

/// Inserta una fila importada del legado en cualquier estado (el corte lo hace así; las del Core nacen al principio).
fn legacy(w: &mut Mundo, task: &str, n: i64, status: AttemptStatus) -> String {
    let id = format!("{task}-a{n}");
    sql(
        &mut w.s,
        &format!(
            "INSERT INTO attempts (id, task_id, n, status, provider, created_at, updated_at, origin) VALUES ('{id}', '{task}', {n}, '{}', 'codex', 5, 5, 'legacy')",
            status.as_str()
        ),
    )
    .unwrap();
    id
}

// ---------------------------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------------------------

#[test]
fn la_008_es_una_migracion_hacia_adelante_y_el_attempt_no_lleva_runtime() {
    let m = embedded().into_iter().find(|m| m.version == 8).expect("hay migración 008");
    assert_eq!(m.name, "attempts");
    let sin_comentarios: String = m.sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n").to_uppercase();
    for prohibido in ["DROP ", "ALTER TABLE ATTEMPTS", "ON DELETE", "CASCADE", "BEGIN TRANSACTION", "COMMIT", "ROLLBACK"] {
        assert!(!sin_comentarios.contains(prohibido), "la 008 no puede llevar «{prohibido}»");
    }
    let t = Tmp::new();
    let w = mundo(t.path());
    let columnas: Vec<String> = w.s.read(|c| Ok(c.prepare("SELECT name FROM pragma_table_info('attempts') ORDER BY cid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    // Las 19 primeras son las de la 008 (identidad y ciclo de vida); el runtime llega después, con la 012 (LXO-231).
    assert_eq!(
        columnas[..19],
        [
            "id", "task_id", "n", "status", "external", "provider", "model", "effort", "role", "profile", "worktree_id", "provider_session_id", "summary", "failure_reason",
            "created_at", "started_at", "ended_at", "updated_at", "origin"
        ]
    );
    let columnas: Vec<String> = columnas[..19].to_vec();
    // El Attempt es identidad + ciclo de vida: nada de proceso, terminal, rutas, política ni entrega (llegan con su slice).
    for c in &columnas {
        for runtime in ["pid", "pty", "argv", "cwd", "path", "policy", "nonce", "delivery", "report", "branch", "repo", "env"] {
            assert!(!c.contains(runtime), "la columna `{c}` es del runtime, no de la identidad del Attempt");
        }
    }
    // La FK a la Task no borra en cascada; el vínculo a Worktree y ProviderSession es blando (sin FK todavía).
    let fks: Vec<(String, String)> = w.s.read(|c| Ok(c.prepare("SELECT \"table\", on_delete FROM pragma_foreign_key_list('attempts')")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?)).unwrap();
    assert_eq!(fks, [("tasks".to_string(), "NO ACTION".to_string())]);
}

/// La 008 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_008_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 8).expect("existe la 008");
    assert_eq!(m.name, "attempts");
    assert_eq!(m.checksum(), "4c91800c7ff95eee1f9494e062fc8d1ebaf07261ea030bdbaf71d76f2c10d789", "una migración publicada no se edita");
}

#[test]
fn el_juego_de_estados_de_la_base_es_el_de_rust() {
    let t = Tmp::new();
    let w = mundo(t.path());
    let ddl: String = w.s.read(|c| Ok(c.query_row("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attempts'", [], |r| r.get(0))?)).unwrap();
    let checks_status = ddl.split("CHECK (status IN (").nth(1).unwrap().split("))").next().unwrap().to_string();
    for s in AttemptStatus::ALL {
        assert!(checks_status.contains(&format!("'{}'", s.as_str())), "el CHECK de status no incluye {}", s.as_str());
        assert_eq!(AttemptStatus::parse(s.as_str()).unwrap(), s);
    }
    assert_eq!(checks_status.matches('\'').count(), AttemptStatus::ALL.len() * 2, "ni un estado de más ni de menos");
    assert_eq!(AttemptStatus::ALL.iter().filter(|s| s.is_final()).count(), 4);
    invalido(AttemptStatus::parse("zombie"));
}

// ---------------------------------------------------------------------------------------------
// Inerte hasta el corte
// ---------------------------------------------------------------------------------------------

#[test]
fn antes_del_corte_ningun_mutador_escribe_y_la_base_tampoco() {
    let t = Tmp::new();
    let mut s = Store::open_with(t.path(), &embedded(), "t").unwrap();
    assert!(!s.agentic_model_active().unwrap());
    let antes = (cuenta(&s, "attempts"), cuenta(&s, "events"));
    let inactivo = |r: StoreResult<_>| assert!(matches!(r, Err(StoreError::AgenticModelInactive)), "{r:?}");
    inactivo(s.attempt_create_recorded("t1", &pide("claude", false), 1, |_, _| unreachable!("no se construye ningún evento")).map(|_| ()));
    inactivo(s.attempt_transition_recorded("t1-a1", &AttemptAction::Start, 1, |_, _, _| unreachable!()).map(|_| ()));
    assert_eq!((cuenta(&s, "attempts"), cuenta(&s, "events")), antes);
    let e = error_sql(&mut s, "INSERT INTO attempts (id, task_id, n, status, provider, created_at, updated_at, origin) VALUES ('t1-a1', 't1', 1, 'done', 'x', 1, 1, 'legacy')");
    assert!(e.contains("inerte hasta el corte"), "{e}");
}

#[test]
fn si_se_retira_la_marca_del_corte_las_filas_quedan_inertes() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a = crea(&mut w, &h, false, 100);
    sql(&mut w.s, &format!("DELETE FROM meta WHERE key = '{AGENTIC_MODEL_KEY}'")).unwrap();
    let e = error_sql(&mut w.s, &format!("UPDATE attempts SET status = 'running', started_at = 110, updated_at = 110 WHERE id = '{}'", a.id));
    assert!(e.contains("inerte hasta el corte"), "{e}");
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap(), a);
}

// ---------------------------------------------------------------------------------------------
// Crear, múltiples Attempts y retry
// ---------------------------------------------------------------------------------------------

#[test]
fn un_attempt_nace_con_su_identidad_y_su_evento() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    assert_eq!(w.s.attempt_active(&w.hija).unwrap(), None, "una Task puede existir sin Attempt activo");
    assert_eq!(w.s.attempts_of_task(&w.hija).unwrap(), []);
    let h = w.hija.clone();
    let a = crea(&mut w, &h, true, 100);
    assert_eq!(
        a,
        AttemptRow {
            id: format!("{}-a1", w.hija),
            task_id: w.hija.clone(),
            n: 1,
            status: AttemptStatus::PendingApproval,
            external: false,
            provider: "claude".into(),
            model: Some("claude-opus-5-5".into()),
            effort: Some("high".into()),
            role: Some("implementador".into()),
            profile: Some("implementar".into()),
            worktree_id: None,
            provider_session_id: None,
            summary: String::new(),
            failure_reason: None,
            created_at: 100,
            started_at: None,
            ended_at: None,
            updated_at: 100,
            origin: TaskOrigin::Core,
        }
    );
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap(), a);
    assert_eq!(w.s.attempt_active(&w.hija).unwrap().unwrap(), a);
    let kinds: Vec<(String, String)> = w.s.read(|c| Ok(c.prepare("SELECT kind, entity_id FROM events ORDER BY seq DESC LIMIT 1")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?)).unwrap();
    assert_eq!(kinds, [("attempt.requested".to_string(), a.id.clone())]);
    // Sin aprobación nace arrancando.
    let r = w.raiz.clone();
    let b = crea(&mut w, &r, false, 110);
    assert_eq!((b.status, b.id.as_str()), (AttemptStatus::Starting, format!("{r}-a1").as_str()));
}

#[test]
fn un_coordinador_externo_se_marca_en_el_attempt() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let r = w.raiz.clone();
    let externo = NewAttempt { external: true, ..pide("claude", false) };
    let a = w.s.attempt_create_recorded(&r, &externo, 100, |a, t| Ok(de("attempt.requested", a, t))).unwrap();
    assert!(a.external);
    assert!(w.s.attempt_row(&a.id).unwrap().unwrap().external);
    let h = w.hija.clone();
    assert!(!crea(&mut w, &h, false, 110).external, "por defecto no es externo");
}

#[test]
fn varios_attempts_por_task_y_el_retry_conserva_la_historia() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a1 = crea(&mut w, &h, false, 100);
    paso(&mut w, &a1.id, AttemptAction::Start, 110).unwrap();
    paso(&mut w, &a1.id, falla("agent_idle_timeout"), 120).unwrap();
    let a1_final = w.s.attempt_row(&a1.id).unwrap().unwrap();
    assert_eq!((a1_final.status, a1_final.failure_reason.as_deref(), a1_final.ended_at), (AttemptStatus::Failed, Some("agent_idle_timeout"), Some(120)));

    // Retry: un Attempt NUEVO con id propio; el anterior no se toca ni se reabre.
    let a2 = crea(&mut w, &h, false, 200);
    assert_eq!((a2.id.as_str(), a2.n, a2.status), (format!("{h}-a2").as_str(), 2, AttemptStatus::Starting));
    assert_ne!(a1.id, a2.id);
    assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), a1_final, "el intento anterior queda exactamente igual");
    paso(&mut w, &a2.id, AttemptAction::Start, 210).unwrap();
    paso(&mut w, &a2.id, finaliza("listo"), 220).unwrap();
    let a3 = crea(&mut w, &h, true, 300);
    assert_eq!((a3.n, a3.id.as_str()), (3, format!("{h}-a3").as_str()));

    // La historia completa, en orden; el actual es el último; la hermana no se mezcla.
    let todos = w.s.attempts_of_task(&h).unwrap();
    assert_eq!(todos.iter().map(|a| (a.n, a.status)).collect::<Vec<_>>(), [(1, AttemptStatus::Failed), (2, AttemptStatus::Done), (3, AttemptStatus::PendingApproval)]);
    assert_eq!(w.s.attempt_current(&h).unwrap().unwrap().id, a3.id);
    assert_eq!(w.s.attempt_active(&h).unwrap().unwrap().id, a3.id);
    assert_eq!(w.s.attempts_of_task(&w.raiz).unwrap(), []);
    assert_eq!(w.s.attempts_by_status(AttemptStatus::PendingApproval).unwrap().iter().map(|a| a.id.clone()).collect::<Vec<_>>(), [a3.id.clone()]);
    assert_eq!(w.s.attempts_by_status(AttemptStatus::Done).unwrap().len(), 1);
    // Los de otra Task tienen su propia numeración.
    let r = w.raiz.clone();
    assert_eq!(crea(&mut w, &r, false, 400).n, 1);
}

#[test]
fn a_lo_sumo_un_attempt_activo_por_task() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a1 = crea(&mut w, &h, true, 100);
    let antes = foto(&w.s);
    conflicto(w.s.attempt_create_recorded(&h, &pide("codex", false), 110, |_, _| unreachable!()), &a1.id);
    assert_eq!(foto(&w.s), antes);
    // La base lo impone también, saltándose el almacén.
    let e = error_sql(&mut w.s, &format!("INSERT INTO attempts (id, task_id, n, status, provider, created_at, updated_at, origin) VALUES ('{h}-a2', '{h}', 2, 'starting', 'x', 1, 1, 'core')"));
    assert!(e.contains("UNIQUE"), "{e}");
    // Cancelado el anterior, se puede reintentar.
    paso(&mut w, &a1.id, AttemptAction::Cancel, 120).unwrap();
    assert_eq!(crea(&mut w, &h, false, 130).n, 2);
}

#[test]
fn no_se_crea_un_attempt_donde_no_cabe() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (h, r) = (w.hija.clone(), w.raiz.clone());
    let antes = foto(&w.s);
    conflicto(w.s.attempt_create_recorded("t999", &pide("claude", false), 1, |_, _| unreachable!()), "no existe la Task");
    // Task descartada.
    w.s.task_set_discarded_recorded(&h, true, 50, |t| Ok(evento("task.discarded", "task", &t.id, &t.run_id, t.project_id.as_deref()))).unwrap();
    conflicto(w.s.attempt_create_recorded(&h, &pide("claude", false), 60, |_, _| unreachable!()), "descartada");
    // Run cerrado.
    sql(&mut w.s, &format!("UPDATE runs SET closed = 1 WHERE id = '{}'", w.run)).unwrap();
    conflicto(w.s.attempt_create_recorded(&r, &pide("claude", false), 70, |_, _| unreachable!()), "cerrado");
    assert_eq!(foto(&w.s).0, antes.0);
    assert_eq!(cuenta(&w.s, "attempts"), 0);
    // La base lo impone también: una fila del Core nace al principio, con el n siguiente, en una Task y un Run abiertos.
    let t2 = Tmp::new();
    let mut w2 = mundo(t2.path());
    let r2 = w2.raiz.clone();
    for q in [
        format!("INSERT INTO attempts (id, task_id, n, status, provider, created_at, started_at, updated_at, origin) VALUES ('{r2}-a1', '{r2}', 1, 'running', 'x', 1, 1, 1, 'core')"),
        format!("INSERT INTO attempts (id, task_id, n, status, provider, created_at, updated_at, origin) VALUES ('{r2}-a2', '{r2}', 2, 'starting', 'x', 1, 1, 'core')"),
    ] {
        let e = error_sql(&mut w2.s, &q);
        assert!(e.contains("nace pendiente o arrancando"), "{q}: {e}");
    }
}

#[test]
fn la_base_exige_una_task_abierta_en_un_run_abierto_aunque_se_salte_el_almacen() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (h, r) = (w.hija.clone(), w.raiz.clone());
    let insertar = |task: &str| format!("INSERT INTO attempts (id, task_id, n, status, provider, created_at, updated_at, origin) VALUES ('{task}-a1', '{task}', 1, 'starting', 'x', 1, 1, 'core')");
    w.s.task_set_discarded_recorded(&h, true, 50, |t| Ok(evento("task.discarded", "task", &t.id, &t.run_id, t.project_id.as_deref()))).unwrap();
    let e = error_sql(&mut w.s, &insertar(&h));
    assert!(e.contains("nace pendiente o arrancando"), "Task descartada: {e}");
    sql(&mut w.s, &format!("UPDATE runs SET closed = 1 WHERE id = '{}'", w.run)).unwrap();
    let e = error_sql(&mut w.s, &insertar(&r));
    assert!(e.contains("nace pendiente o arrancando"), "Run cerrado: {e}");
    assert_eq!(cuenta(&w.s, "attempts"), 0);
}

#[test]
fn la_seleccion_se_valida_antes_de_tocar_la_base() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let antes = foto(&w.s);
    let con = |f: &dyn Fn(&mut NewAttempt)| {
        let mut n = pide("claude", false);
        f(&mut n);
        n
    };
    for n in [
        con(&|n| n.provider = "  ".into()),
        con(&|n| n.provider = String::new()),
        con(&|n| n.model = Some("".into())),
        con(&|n| n.effort = Some("a\nb".into())),
        con(&|n| n.role = Some("x".repeat(121))),
        con(&|n| n.profile = Some(" ".into())),
    ] {
        invalido(w.s.attempt_create_recorded(&h, &n, 1, |_, _| unreachable!()));
    }
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------------------------

#[test]
fn el_ciclo_de_vida_feliz_fija_las_marcas_de_tiempo() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a = crea(&mut w, &h, true, 100);
    assert_eq!(paso(&mut w, &a.id, AttemptAction::Approve, 110).unwrap(), ChangeOutcome::Changed);
    let r = w.s.attempt_row(&a.id).unwrap().unwrap();
    assert_eq!((r.status, r.started_at, r.ended_at, r.updated_at), (AttemptStatus::Starting, None, None, 110));
    paso(&mut w, &a.id, AttemptAction::Start, 120).unwrap();
    let r = w.s.attempt_row(&a.id).unwrap().unwrap();
    assert_eq!((r.status, r.started_at, r.ended_at, r.updated_at), (AttemptStatus::Running, Some(120), None, 120));
    paso(&mut w, &a.id, finaliza("12 tests, todos ok"), 130).unwrap();
    let r = w.s.attempt_row(&a.id).unwrap().unwrap();
    assert_eq!((r.status, r.summary.as_str(), r.started_at, r.ended_at, r.updated_at, r.failure_reason), (AttemptStatus::Done, "12 tests, todos ok", Some(120), Some(130), 130, None));
    assert_eq!(w.s.attempt_active(&h).unwrap(), None, "terminado: la Task queda sin Attempt activo");
    assert_eq!(w.s.attempt_current(&h).unwrap().unwrap().id, a.id);
}

#[test]
fn fallar_guarda_el_motivo_y_cancelar_no() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (h, r) = (w.hija.clone(), w.raiz.clone());
    let a = crea(&mut w, &h, false, 100);
    // Falla sin haber arrancado (el lanzamiento no llegó a ocurrir): no tiene started_at.
    let accion = AttemptAction::Fail { reason: "launch_failed".into(), summary: "no se pudo lanzar".into() };
    assert_eq!(paso(&mut w, &a.id, accion, 110).unwrap(), ChangeOutcome::Changed);
    let f = w.s.attempt_row(&a.id).unwrap().unwrap();
    assert_eq!((f.status, f.failure_reason.as_deref(), f.summary.as_str(), f.started_at, f.ended_at), (AttemptStatus::Failed, Some("launch_failed"), "no se pudo lanzar", None, Some(110)));
    let b = crea(&mut w, &r, false, 200);
    paso(&mut w, &b.id, AttemptAction::Start, 210).unwrap();
    paso(&mut w, &b.id, AttemptAction::Cancel, 220).unwrap();
    let s = w.s.attempt_row(&b.id).unwrap().unwrap();
    assert_eq!((s.status, s.failure_reason, s.started_at, s.ended_at), (AttemptStatus::Stopped, None, Some(210), Some(220)));
}

#[test]
fn un_final_no_vuelve_a_running_ni_cambia_de_final() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a = crea(&mut w, &h, false, 100);
    paso(&mut w, &a.id, AttemptAction::Start, 110).unwrap();
    paso(&mut w, &a.id, finaliza("ok"), 120).unwrap();
    let final_ = w.s.attempt_row(&a.id).unwrap().unwrap();
    let antes = foto(&w.s);
    for accion in [AttemptAction::Approve, AttemptAction::Start, falla("agent_reported"), AttemptAction::Cancel] {
        let r = paso(&mut w, &a.id, accion.clone(), 130);
        assert!(matches!(r, Err(StoreError::AttemptTransition { .. })), "{accion:?}: {r:?}");
    }
    // Terminar otra vez es un reintento idempotente: sin cambio y sin evento.
    assert_eq!(paso(&mut w, &a.id, finaliza("otro resumen"), 140).unwrap(), ChangeOutcome::Unchanged);
    assert_eq!(foto(&w.s), antes);
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap(), final_, "el final no cambió ni siquiera el resumen");
    // Y la base lo impone: ningún UPDATE sobre un final, de ninguna columna.
    for q in [
        format!("UPDATE attempts SET status = 'running' WHERE id = '{}'", a.id),
        format!("UPDATE attempts SET summary = 'x' WHERE id = '{}'", a.id),
        format!("UPDATE attempts SET updated_at = 999 WHERE id = '{}'", a.id),
    ] {
        let e = error_sql(&mut w.s, &q);
        assert!(e.contains("transición de ciclo de vida no permitida") || e.contains("final no se modifica"), "{q}: {e}");
    }
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap(), final_);
}

/// Un Attempt de la base en cada uno de los 9 estados (los del legado entran por el corte, no por el ciclo de vida).
fn uno_en_cada_estado(w: &mut Mundo) -> Vec<(AttemptStatus, String)> {
    let mut out = vec![];
    for (i, st) in AttemptStatus::ALL.into_iter().enumerate() {
        let task = w
            .s
            .task_create_child_recorded(&w.raiz.clone(), &NewTaskIntent { title: format!("t-{i}"), spec: String::new(), repo: "c:/app".into() }, 30 + i as i64, |t| {
                Ok(evento("task.created", "task", &t.id, &t.run_id, t.project_id.as_deref()))
            })
            .unwrap()
            .id;
        out.push((st, legacy(w, &task, 1, st)));
    }
    out
}

#[test]
fn la_tabla_de_transiciones_de_rust_cuadra_con_el_trigger_en_las_81_combinaciones() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let mut esperadas = 0;
    for (from, _) in uno_en_cada_estado(&mut w) {
        for to in AttemptStatus::ALL {
            // Una fila nueva en `from` por combinación, para que un rechazo no contamine la siguiente.
            let task = w
                .s
                .task_create_child_recorded(&w.raiz.clone(), &NewTaskIntent { title: "c".into(), spec: String::new(), repo: "c:/app".into() }, 99, |t| {
                    Ok(evento("task.created", "task", &t.id, &t.run_id, t.project_id.as_deref()))
                })
                .unwrap()
                .id;
            let id = legacy(&mut w, &task, 1, from);
            let r = sql(&mut w.s, &format!("UPDATE attempts SET status = '{}' WHERE id = '{id}'", to.as_str()));
            // Un final no admite ningún UPDATE (ni siquiera uno que deja el estado igual); un activo, el mismo estado sí.
            let admitida = if from.is_final() { false } else { from == to || transition_allowed(from, to) };
            esperadas += (admitida && from != to) as usize;
            match (admitida, r) {
                (true, Ok(_)) => {}
                (false, Err(e)) => assert!(e.to_string().contains("no permitida") || e.to_string().contains("final no se modifica"), "{from:?}->{to:?}: {e}"),
                (_, otro) => panic!("{from:?} -> {to:?}: admitida={admitida}, resultado de la base: {otro:?}"),
            }
        }
    }
    assert_eq!(esperadas, 26, "la tabla cerrada tiene exactamente 26 pares (14 de la 008 + 12 de las esperas y la salida, 012)");
    // Ningún estado final tiene salida; el pendiente solo va a starting o stopped.
    for f in AttemptStatus::ALL.into_iter().filter(|s| s.is_final()) {
        assert!(AttemptStatus::ALL.into_iter().all(|to| !transition_allowed(f, to)), "{f:?} no tiene salida");
    }
    assert!(!transition_allowed(AttemptStatus::PendingApproval, AttemptStatus::Running), "no se salta la aprobación ni el arranque");
}

#[test]
fn desde_cualquier_estado_cada_accion_hace_lo_que_dice_la_tabla_o_se_rechaza_sin_rastro() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let acciones = [
        AttemptAction::Approve,
        AttemptAction::Start,
        AttemptAction::Wait,
        AttemptAction::AwaitTerminal,
        AttemptAction::Resume,
        finaliza("ok"),
        falla("agent_reported"),
        AttemptAction::Cancel,
        AttemptAction::Exit,
    ];
    for accion in acciones {
        for (from, _) in uno_en_cada_estado(&mut w) {
            let task = w
                .s
                .task_create_child_recorded(&w.raiz.clone(), &NewTaskIntent { title: "c".into(), spec: String::new(), repo: "c:/app".into() }, 99, |t| {
                    Ok(evento("task.created", "task", &t.id, &t.run_id, t.project_id.as_deref()))
                })
                .unwrap()
                .id;
            let id = legacy(&mut w, &task, 1, from);
            let antes_fila = w.s.attempt_row(&id).unwrap().unwrap();
            let antes = foto(&w.s);
            let destino = accion.step().to();
            let r = paso(&mut w, &id, accion.clone(), 500);
            if from == destino {
                assert_eq!(r.unwrap(), ChangeOutcome::Unchanged, "{from:?} {accion:?}");
                assert_eq!(foto(&w.s), antes);
            } else if accion.step().from_states().contains(&from) {
                assert_eq!(r.unwrap(), ChangeOutcome::Changed, "{from:?} {accion:?}");
                assert_eq!(w.s.attempt_row(&id).unwrap().unwrap().status, destino);
                assert_eq!(foto(&w.s).1, antes.1 + 1, "exactamente un evento");
            } else {
                assert!(matches!(r, Err(StoreError::AttemptTransition { .. })), "{from:?} {accion:?}: {r:?}");
                assert_eq!(foto(&w.s), antes);
                assert_eq!(w.s.attempt_row(&id).unwrap().unwrap(), antes_fila, "un rechazo no cambia nada");
            }
        }
    }
    assert!(matches!(paso(&mut w, "t999-a1", AttemptAction::Start, 1), Ok(ChangeOutcome::Missing)));
}

#[test]
fn un_attempt_importado_en_espera_puede_terminar_pero_no_volver_atras() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let id = legacy(&mut w, &h, 1, AttemptStatus::Waiting);
    assert_eq!(w.s.attempt_active(&h).unwrap().unwrap().id, id);
    assert_eq!(paso(&mut w, &id, finaliza("ok"), 100).unwrap(), ChangeOutcome::Changed);
    let f = w.s.attempt_row(&id).unwrap().unwrap();
    assert_eq!((f.status, f.origin, f.started_at, f.ended_at), (AttemptStatus::Done, TaskOrigin::Legacy, None, Some(100)), "el legado no registra el inicio y no se inventa");
    // Retry sobre lo importado: el siguiente número, sin tocar lo importado.
    let nuevo = crea(&mut w, &h, false, 200);
    assert_eq!(nuevo.n, 2);
    assert_eq!(w.s.attempt_row(&id).unwrap().unwrap(), f);
}

// ---------------------------------------------------------------------------------------------
// Identidad histórica
// ---------------------------------------------------------------------------------------------

#[test]
fn la_identidad_no_cambia_y_el_vinculo_se_fija_una_sola_vez() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a = crea(&mut w, &h, false, 100);
    for set in [
        "id = 'otro-a1'",
        "task_id = 't999'",
        "n = 9",
        "provider = 'codex'",
        "model = 'otro'",
        "model = NULL",
        "effort = 'low'",
        "role = 'explorador'",
        "profile = 'explorar'",
        "external = 1",
        "origin = 'legacy'",
        "created_at = 1",
    ] {
        let e = error_sql(&mut w.s, &format!("UPDATE attempts SET {set} WHERE id = '{}'", a.id));
        assert!(e.contains("la identidad, la selección y el origen no cambian"), "{set}: {e}");
    }
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap(), a);
    // Worktree y ProviderSession: de NULL a un valor sí (lo hacen sus slices); después, nunca otro. La sesión y el
    // Worktree tienen que existir desde la 009 y la 010 (LXO-115, LXO-116).
    let (ps, wt) = (format!("ps-{}", a.id), format!("wt-{}", a.id));
    sql(&mut w.s, &format!("INSERT INTO provider_sessions (id, task_id, opened_by_attempt_id, provider, resumable, status, created_at, updated_at, origin) VALUES ('{ps}', '{}', '{}', '{}', 1, 'open', 1, 1, 'legacy')", a.task_id, a.id, a.provider)).unwrap();
    sql(&mut w.s, &format!("INSERT INTO worktrees (id, task_id, attempt_id, provenance, repo, path, state, origin) VALUES ('{wt}', '{}', '{}', 'created', 'c:/app', 'c:/wt', 'active', 'legacy')", a.task_id, a.id)).unwrap();
    sql(&mut w.s, &format!("UPDATE attempts SET worktree_id = '{wt}', provider_session_id = '{ps}' WHERE id = '{}'", a.id)).unwrap();
    for set in ["worktree_id = 'wt-2'", "worktree_id = NULL", "provider_session_id = 'ps-2'", "provider_session_id = NULL"] {
        let e = error_sql(&mut w.s, &format!("UPDATE attempts SET {set} WHERE id = '{}'", a.id));
        // `wt-2` y `ps-2` no existen: los puede rechazar antes el trigger de existencia de la 009 o la 010.
        assert!(e.contains("se fija una sola vez") || e.contains("no existe"), "{set}: {e}");
    }
    let v = w.s.attempt_row(&a.id).unwrap().unwrap();
    assert_eq!((v.worktree_id.as_deref(), v.provider_session_id.as_deref()), (Some(wt.as_str()), Some(ps.as_str())));
    // El vínculo sobrevive al ciclo de vida.
    paso(&mut w, &a.id, AttemptAction::Start, 110).unwrap();
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap().worktree_id.as_deref(), Some(wt.as_str()));
}

#[test]
fn un_attempt_no_se_borra_y_su_task_tampoco_ni_se_descarta_mientras_corre() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a = crea(&mut w, &h, false, 100);
    let e = error_sql(&mut w.s, &format!("DELETE FROM attempts WHERE id = '{}'", a.id));
    assert!(e.contains("conserva la historia"), "{e}");
    // La Task con Attempts no se borra (política IfUnused), ni siquiera con el Attempt ya terminado.
    let evt = |t: &TaskRow| Ok(evento("task.removed", "task", &t.id, &t.run_id, t.project_id.as_deref()));
    conflicto_t(w.s.task_remove_recorded(&h, TaskRemoval::IfUnused, evt), "Attempt");
    // Y mientras tenga uno activo no se descarta: se cancela antes (sin cascada implícita).
    let antes = foto(&w.s);
    conflicto_t(w.s.task_set_discarded_recorded(&h, true, 120, |_| unreachable!()), &a.id);
    assert_eq!(foto(&w.s), antes);
    let e = error_sql(&mut w.s, &format!("UPDATE tasks SET intent = 'discarded', discarded_at = 1 WHERE id = '{h}'"));
    assert!(e.contains("Attempt activo"), "también por la base: {e}");
    paso(&mut w, &a.id, AttemptAction::Cancel, 130).unwrap();
    assert_eq!(w.s.task_set_discarded_recorded(&h, true, 140, |t| Ok(evento("task.discarded", "task", &t.id, &t.run_id, t.project_id.as_deref()))).unwrap(), ChangeOutcome::Changed);
    assert_eq!(w.s.attempts_of_task(&h).unwrap().len(), 1, "descartar la Task conserva su historia");
    conflicto_t(w.s.task_remove_recorded(&h, TaskRemoval::IfUnused, evt), "Attempt");
}

fn conflicto_t<T: std::fmt::Debug>(r: StoreResult<T>, contiene: &str) {
    match r {
        Err(StoreError::TaskConflict(m)) => assert!(m.contains(contiene), "«{m}» no menciona «{contiene}»"),
        otro => panic!("se esperaba TaskConflict ({contiene}): {otro:?}"),
    }
}

// ---------------------------------------------------------------------------------------------
// Restricciones de forma
// ---------------------------------------------------------------------------------------------

#[test]
fn las_marcas_de_tiempo_de_una_fila_del_core_son_coherentes_con_su_estado() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a = crea(&mut w, &h, false, 100);
    // running sin started_at, un final sin ended_at, ended_at en un activo, relojes desordenados, motivo fuera de failed.
    for (set, trozo) in [
        ("status = 'running'", "CHECK"),
        ("status = 'stopped'", "CHECK"),
        ("ended_at = 150", "CHECK"),
        ("failure_reason = 'launch_failed'", "CHECK"),
        ("started_at = 150", "CHECK"),
        ("updated_at = 50", "CHECK"),
        ("summary = replace(hex(zeroblob(1001)), '0', 'x')", "CHECK"),
    ] {
        let e = error_sql(&mut w.s, &format!("UPDATE attempts SET {set} WHERE id = '{}'", a.id));
        assert!(e.contains(trozo), "{set}: {e}");
    }
    let e = error_sql(&mut w.s, &format!("UPDATE attempts SET status = 'stopped', ended_at = 50 WHERE id = '{}'", a.id));
    assert!(e.contains("CHECK"), "ended_at < created_at: {e}");
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap(), a);
}

#[test]
fn el_resumen_y_el_motivo_tienen_limites() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a = crea(&mut w, &h, false, 100);
    paso(&mut w, &a.id, AttemptAction::Start, 110).unwrap();
    let antes = foto(&w.s);
    invalido(paso(&mut w, &a.id, finaliza(&"x".repeat(MAX_SUMMARY_CHARS + 1)), 120));
    let largo = "a".repeat(65);
    for reason in ["", "Launch", "con espacios", "9abc", "a-b", largo.as_str()] {
        invalido(paso(&mut w, &a.id, falla(reason), 120));
    }
    assert_eq!(foto(&w.s), antes);
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap().status, AttemptStatus::Running);
    // El límite exacto cabe.
    assert_eq!(paso(&mut w, &a.id, finaliza(&"é".repeat(MAX_SUMMARY_CHARS)), 130).unwrap(), ChangeOutcome::Changed);
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap().summary.chars().count(), MAX_SUMMARY_CHARS);
}

#[test]
fn el_reloj_hacia_atras_no_deja_marcas_anteriores_a_las_previas() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a = crea(&mut w, &h, false, 500);
    paso(&mut w, &a.id, AttemptAction::Start, 100).unwrap();
    let r = w.s.attempt_row(&a.id).unwrap().unwrap();
    assert_eq!((r.started_at, r.updated_at, r.created_at), (Some(500), 500, 500), "started_at no queda antes de created_at");
    paso(&mut w, &a.id, finaliza("ok"), 50).unwrap();
    let r = w.s.attempt_row(&a.id).unwrap().unwrap();
    assert_eq!((r.ended_at, r.updated_at), (Some(500), 500));
}

// ---------------------------------------------------------------------------------------------
// Atomicidad estado + evento
// ---------------------------------------------------------------------------------------------

fn falla_el_borrador<T>() -> StoreResult<T> {
    Err(StoreError::InvalidEvent("borrador inválido".into()))
}

#[test]
fn sin_su_hecho_no_hay_cambio() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let antes = foto(&w.s);
    assert!(w.s.attempt_create_recorded(&h, &pide("claude", false), 20, |_, _| falla_el_borrador()).is_err());
    assert_eq!(foto(&w.s), antes, "ni fila ni evento");
    let a = crea(&mut w, &h, false, 30);
    let antes = foto(&w.s);
    assert!(w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, 40, |_, _, _| falla_el_borrador()).is_err());
    assert_eq!(foto(&w.s), antes);
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap(), a, "el Attempt sigue como estaba");
}

#[test]
fn un_evento_que_no_se_refiere_al_attempt_o_repetido_deshace_el_cambio() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let antes = foto(&w.s);
    let casos: [fn(&AttemptRow, &TaskRow) -> StoreResult<NewEvent>; 5] = [
        |_, t| Ok(evento("attempt.requested", "attempt", "t999-a1", &t.run_id, t.project_id.as_deref())),
        |a, t| Ok(evento("attempt.requested", "attempt", &a.id, "r999", t.project_id.as_deref())),
        |a, t| Ok(evento("attempt.requested", "attempt", &a.id, &t.run_id, Some(&format!("{}-otro", t.project_id.clone().unwrap_or_default())))),
        |a, t| Ok(evento("attempt.requested", "task", &a.id, &t.run_id, t.project_id.as_deref())),
        |a, t| Ok(NewEvent { payload: "[]".into(), ..de("attempt.requested", a, t) }),
    ];
    for e in casos {
        assert!(matches!(w.s.attempt_create_recorded(&h, &pide("claude", false), 20, e), Err(StoreError::InvalidEvent(_))));
    }
    assert_eq!(foto(&w.s), antes);
    // Lo mismo al cambiar de estado: el evento tiene que ser de ese Attempt, de su Run y de su Project.
    let a = crea(&mut w, &h, false, 25);
    let antes = foto(&w.s);
    let ajenos: [fn(&AttemptRow, AttemptStatus, &TaskRow) -> StoreResult<NewEvent>; 4] = [
        |_, _, t| Ok(evento("attempt.started", "attempt", "t999-a1", &t.run_id, t.project_id.as_deref())),
        |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, "r999", t.project_id.as_deref())),
        |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, &t.run_id, Some(&format!("{}-otro", t.project_id.clone().unwrap_or_default())))),
        |a, _, t| Ok(evento("attempt.started", "task", &a.id, &t.run_id, t.project_id.as_deref())),
    ];
    for e in ajenos {
        assert!(matches!(w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, 30, e), Err(StoreError::InvalidEvent(_))));
        assert_eq!(foto(&w.s), antes);
        assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap(), a, "el Attempt sigue como estaba");
    }
    paso(&mut w, &a.id, AttemptAction::Cancel, 35).unwrap();
    // El mismo hecho dos veces (misma idem_key): el segundo no se confirma sin su evento.
    let a = w.s.attempt_create_recorded(&h, &pide("claude", false), 30, |a, t| Ok(NewEvent { idem_key: Some("k".into()), ..de("attempt.requested", a, t) })).unwrap();
    let r = w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, 40, |a, _, t| Ok(NewEvent { idem_key: Some("k".into()), ..de("attempt.requested", a, t) }));
    conflicto_dup(r);
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap(), a);
}

fn conflicto_dup(r: StoreResult<ChangeOutcome>) {
    match r {
        Err(StoreError::AttemptConflict(m)) => assert!(m.contains("ya existía"), "{m}"),
        otro => panic!("se esperaba el rechazo de un evento duplicado: {otro:?}"),
    }
}

/// Un proyector que falla deshace fila y evento: Attempt, Event y Attention viajan en la misma transacción.
#[derive(Debug)]
struct Falla;

impl EventProjector for Falla {
    fn project(&self, _tx: &rusqlite::Transaction<'_>, _events: &[EventRow]) -> StoreResult<Vec<NewEvent>> {
        Err(StoreError::InvalidAttention("proyección rota a propósito".into()))
    }
}

#[test]
fn si_la_proyeccion_falla_no_queda_ni_el_attempt_ni_su_evento() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a = crea(&mut w, &h, false, 30);
    w.s.set_event_projector(std::sync::Arc::new(Falla));
    let antes = foto(&w.s);
    assert!(matches!(w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, 40, |a, _, t| Ok(de("attempt.started", a, t))), Err(StoreError::InvalidAttention(_))));
    assert!(w.s.attempt_create_recorded(&w.raiz.clone(), &pide("claude", false), 50, |a, t| Ok(de("attempt.requested", a, t))).is_err());
    assert_eq!(foto(&w.s), antes);
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap(), a);
}

#[test]
fn el_closure_recibe_el_attempt_ya_cambiado_y_el_estado_del_que_venia() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.clone();
    let a = crea(&mut w, &h, true, 30);
    let mut visto = None;
    w.s.attempt_transition_recorded(&a.id, &AttemptAction::Cancel, 40, |nuevo, de_estado, task| {
        visto = Some((nuevo.status, de_estado, nuevo.ended_at, task.id.clone()));
        Ok(de("attempt.rejected", nuevo, task))
    })
    .unwrap();
    assert_eq!(visto, Some((AttemptStatus::Stopped, AttemptStatus::PendingApproval, Some(40), h)));
}
