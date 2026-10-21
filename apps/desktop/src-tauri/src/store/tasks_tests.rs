//! Pruebas de la Task como intención durable en el almacén (migración 007, LXO-113).
//!
//! Cubren `docs/core/TASKS.md`: la tabla no lleva ejecución, Project pertenece a Task, nada se borra en cascada, fila y
//! evento se confirman juntos y, antes del corte, nada escribe (ni por el almacén ni por SQL directo). Los eventos se
//! construyen aquí a mano: el almacén no sabe qué hechos existen (eso se prueba en `orch/task_ops_tests.rs`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::tasks::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-task-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

/// Un almacén con todas las migraciones, el corte aún sin hacer y un Project registrado.
fn abre(dir: &Path) -> (Store, String) {
    let mut s = Store::open_with(dir, &embedded(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let p = s.project_create("app", &Fingerprint::default(), &loc).unwrap();
    (s, p.id)
}

/// Lo que hará el corte: activa el modelo (y deja el contador donde lo dejaría el legado).
fn activa(s: &mut Store, seq: u64) {
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    s.meta_set("id_seq", &seq.to_string()).unwrap();
}

fn activo(dir: &Path) -> (Store, String) {
    let (mut s, p) = abre(dir);
    activa(&mut s, 0);
    (s, p)
}

fn ev(kind: &str, entity_kind: &str, entity_id: &str, run: &str, project: Option<&str>) -> NewEvent {
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

/// El evento que corresponde a una fila de Task.
fn de(kind: &str, t: &TaskRow) -> NewEvent {
    ev(kind, "task", &t.id, &t.run_id, t.project_id.as_deref())
}

fn intencion(title: &str) -> NewTaskIntent {
    NewTaskIntent { title: title.into(), spec: format!("encargo de {title}"), repo: "c:/app".into() }
}

fn run_nuevo(project: &str) -> NewRun {
    NewRun { objective: "login".into(), project_id: project.into(), root: intencion("coordinar") }
}

fn crea_run(s: &mut Store, project: &str, at: i64) -> (RunRow, TaskRow) {
    s.run_create_recorded(&run_nuevo(project), at, |r, t| {
        Ok(vec![ev("run.created", "run", &r.id, &r.id, Some(project)), de("task.created", t)])
    })
    .unwrap()
}

fn hija(s: &mut Store, parent: &str, title: &str, at: i64) -> TaskRow {
    s.task_create_child_recorded(parent, &intencion(title), at, |t| Ok(de("task.created", t))).unwrap()
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

fn kinds(s: &Store) -> Vec<(String, String)> {
    s.read(|c| {
        let mut st = c.prepare("SELECT kind, entity_id FROM events ORDER BY seq")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .unwrap()
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

fn conflicto<T: std::fmt::Debug>(r: StoreResult<T>, contiene: &str) {
    match r {
        Err(StoreError::TaskConflict(m)) => assert!(m.contains(contiene), "«{m}» no menciona «{contiene}»"),
        otro => panic!("se esperaba TaskConflict ({contiene}): {otro:?}"),
    }
}

/// Todo lo que deja rastro: filas, eventos y el contador.
fn foto(s: &Store) -> (i64, i64, i64, Option<String>) {
    (cuenta(s, "runs"), cuenta(s, "tasks"), cuenta(s, "events"), s.meta("id_seq").unwrap())
}

// ---------------------------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------------------------

#[test]
fn la_007_es_una_migracion_hacia_adelante_y_la_task_no_lleva_ejecucion() {
    let m = embedded().into_iter().find(|m| m.version == 7).expect("hay migración 007");
    assert_eq!(m.name, "tasks");
    let sin_comentarios: String = m.sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n").to_uppercase();
    for prohibido in ["DROP ", "ALTER ", "ON DELETE", "CASCADE", "BEGIN TRANSACTION", "COMMIT", "ROLLBACK"] {
        assert!(!sin_comentarios.contains(prohibido), "la 007 no puede llevar «{prohibido}»");
    }
    let t = Tmp::new();
    let (s, _) = abre(t.path());
    let columnas: Vec<String> = s.read(|c| Ok(c.prepare("SELECT name FROM pragma_table_info('tasks') ORDER BY cid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert_eq!(
        columnas,
        ["id", "run_id", "parent_task_id", "depth", "project_id", "title", "spec", "repo", "intent", "origin", "created_at", "updated_at", "discarded_at"]
    );
    // Invariante 1: nada de la ejecución es parte de la Task.
    for c in &columnas {
        for ejecucion in ["pid", "pty", "worktree", "session", "status", "agent", "model", "branch", "cwd", "attempt", "report"] {
            assert!(!c.contains(ejecucion), "la columna `{c}` es de la ejecución, no de la intención");
        }
    }
    // Ninguna FK de `tasks` ni de `runs` borra en cascada (ni SET NULL).
    let acciones: Vec<String> = s
        .read(|c| Ok(c.prepare("SELECT on_delete FROM pragma_foreign_key_list('tasks') UNION ALL SELECT on_delete FROM pragma_foreign_key_list('runs')")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?))
        .unwrap();
    assert_eq!(acciones.len(), 4, "run, padre y project de tasks; raíz de runs");
    assert!(acciones.iter().all(|a| a == "NO ACTION"), "{acciones:?}");
}

/// La 007 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_007_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 7).expect("existe la 007");
    assert_eq!(m.name, "tasks");
    assert_eq!(m.checksum(), "74316df6e4b6369baf9243ea2af52c11570e0a413226f21b8015495535f01f2c", "una migración publicada no se edita");
}

#[test]
fn antes_del_corte_ningun_mutador_escribe_y_no_queda_rastro() {
    let t = Tmp::new();
    let (mut s, p) = abre(t.path());
    assert!(!s.agentic_model_active().unwrap());
    let antes = foto(&s);
    let inactivo = |r: StoreResult<_>| assert!(matches!(r, Err(StoreError::AgenticModelInactive)), "{r:?}");
    inactivo(s.run_create_recorded(&run_nuevo(&p), 1, |_, _| unreachable!("no se construye ningún evento")).map(|_| ()));
    inactivo(s.task_create_child_recorded("t1", &intencion("x"), 1, |_| unreachable!()).map(|_| ()));
    inactivo(s.task_update_intent_recorded("t1", &IntentChange { title: Some("y".into()), spec: None }, 1, |_, _| unreachable!()).map(|_| ()));
    inactivo(s.task_set_discarded_recorded("t1", true, 1, |_| unreachable!()).map(|_| ()));
    inactivo(s.task_remove_recorded("t1", TaskRemoval::IfUnused, |_| unreachable!()).map(|_| ()));
    assert_eq!(foto(&s), antes, "ni filas, ni eventos, ni contador");
}

#[test]
fn antes_del_corte_la_base_rechaza_escribir_aunque_se_salte_el_almacen() {
    let t = Tmp::new();
    let (mut s, p) = abre(t.path());
    for q in [
        "INSERT INTO runs (id, objective, root_task_id, created_at, last_activity) VALUES ('r1', 'o', 't2', 1, 1)".to_string(),
        format!("INSERT INTO tasks (id, run_id, depth, project_id, title, repo, origin, created_at, updated_at) VALUES ('t2', 'r1', 0, '{p}', 'x', 'r', 'core', 1, 1)"),
    ] {
        let e = sql(&mut s, &q).unwrap_err().to_string();
        assert!(e.contains("inerte hasta el corte"), "{e}");
    }
    // Con filas ya escritas (tras activar), retirar la marca vuelve a dejarlas inertes: ni UPDATE ni DELETE.
    activa(&mut s, 0);
    let (run, raiz) = crea_run(&mut s, &p, 10);
    s.write(|tx| Ok(tx.execute("DELETE FROM meta WHERE key = ?1", [AGENTIC_MODEL_KEY])?)).unwrap();
    for q in [
        format!("UPDATE tasks SET title = 'z' WHERE id = '{}'", raiz.id),
        format!("DELETE FROM tasks WHERE id = '{}'", raiz.id),
        format!("UPDATE runs SET closed = 1 WHERE id = '{}'", run.id),
        format!("DELETE FROM runs WHERE id = '{}'", run.id),
    ] {
        let e = sql(&mut s, &q).unwrap_err().to_string();
        assert!(e.contains("inerte hasta el corte"), "{q}: {e}");
    }
    assert_eq!(s.task_row(&raiz.id).unwrap().unwrap(), raiz);
}

// ---------------------------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------------------------

#[test]
fn un_run_nace_con_su_raiz_y_sus_dos_hechos_y_los_ids_siguen_el_contador_del_legado() {
    let t = Tmp::new();
    let (mut s, p) = abre(t.path());
    activa(&mut s, 17);
    let (run, raiz) = crea_run(&mut s, &p, 500);
    assert_eq!((run.id.as_str(), raiz.id.as_str()), ("r18", "t19"), "continúa tras el último id del documento legacy");
    assert_eq!(run, RunRow { id: "r18".into(), objective: "login".into(), root_task_id: "t19".into(), created_at: 500, closed: false, last_activity: 500 });
    assert_eq!(
        raiz,
        TaskRow {
            id: "t19".into(),
            run_id: "r18".into(),
            parent_task_id: None,
            depth: 0,
            project_id: Some(p.clone()),
            title: "coordinar".into(),
            spec: "encargo de coordinar".into(),
            repo: "c:/app".into(),
            intent: TaskIntent::Open,
            origin: TaskOrigin::Core,
            created_at: 500,
            updated_at: 500,
            discarded_at: None,
        }
    );
    assert_eq!(s.run_row("r18").unwrap().unwrap(), run);
    assert_eq!(s.task_row("t19").unwrap().unwrap(), raiz);
    assert_eq!(kinds(&s), [("run.created".to_string(), "r18".to_string()), ("task.created".into(), "t19".into())]);
    assert_eq!(s.meta("id_seq").unwrap().as_deref(), Some("19"));
}

#[test]
fn project_es_obligatorio_en_toda_task_del_core() {
    let t = Tmp::new();
    let (mut s, _) = activo(t.path());
    let antes = foto(&s);
    conflicto(s.run_create_recorded(&run_nuevo("no-existe"), 1, |_, _| unreachable!()), "no existe el Project");
    assert_eq!(foto(&s), antes, "ni filas, ni eventos, ni un id consumido");
    // Un Run sin su raíz no llega a confirmarse (FK diferida, comprobada al COMMIT).
    s.write(|tx| Ok(tx.execute("INSERT INTO runs (id, objective, root_task_id, created_at, last_activity) VALUES ('r1', 'o', 't2', 1, 1)", [])?)).unwrap_err();
    assert_eq!(cuenta(&s, "runs"), 0);
    // La base lo impone también: una fila del Core sin Project no entra; una importada del legado sí (ADR D1).
    let e = s
        .write(|tx| {
            tx.execute("INSERT INTO runs (id, objective, root_task_id, created_at, last_activity) VALUES ('r1', 'o', 't2', 1, 1)", [])?;
            tx.execute("INSERT INTO tasks (id, run_id, depth, title, repo, origin, created_at, updated_at) VALUES ('t2', 'r1', 0, 'x', 'r', 'core', 1, 1)", [])?;
            Ok(())
        })
        .unwrap_err();
    assert!(e.to_string().contains("CHECK"), "{e}");
    s.write(|tx| {
        tx.execute("INSERT INTO runs (id, objective, root_task_id, created_at, last_activity) VALUES ('r1', 'o', 't2', 1, 1)", [])?;
        tx.execute("INSERT INTO tasks (id, run_id, depth, title, repo, origin, created_at, updated_at) VALUES ('t2', 'r1', 0, '', 'r', 'legacy', 5, 1)", [])?;
        Ok(())
    })
    .expect("el corte importa una Task legacy sin Project, con título vacío y relojes desordenados");
    assert_eq!(s.task_row("t2").unwrap().unwrap().project_id, None);
}

#[test]
fn una_hija_hereda_run_y_project_un_nivel_por_debajo() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (run, raiz) = crea_run(&mut s, &p, 10);
    let h = hija(&mut s, &raiz.id, "api", 20);
    let nieta = hija(&mut s, &h.id, "tests", 30);
    assert_eq!((h.run_id.as_str(), h.project_id.as_deref(), h.depth, h.parent_task_id.as_deref()), (run.id.as_str(), Some(p.as_str()), 1, Some(raiz.id.as_str())));
    assert_eq!((nieta.depth, nieta.parent_task_id.as_deref()), (2, Some(h.id.as_str())));
    assert_eq!(s.task_children(&raiz.id).unwrap(), [h.clone()]);
    assert_eq!(s.tasks_of_run(&run.id).unwrap(), [raiz, h, nieta]);
}

#[test]
fn una_hija_no_se_cuelga_de_lo_que_no_admite_trabajo_nuevo() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (run, raiz) = crea_run(&mut s, &p, 10);
    let antes = foto(&s);
    conflicto(s.task_create_child_recorded("t99", &intencion("x"), 1, |_| unreachable!()), "no existe la Task t99");
    assert!(matches!(s.task_create_child_recorded(&raiz.id, &intencion("  "), 1, |_| unreachable!()), Err(StoreError::InvalidTask(_))));
    assert_eq!(foto(&s), antes);
    let h = hija(&mut s, &raiz.id, "h", 20);
    s.task_set_discarded_recorded(&h.id, true, 30, |t| Ok(de("task.discarded", t))).unwrap();
    let antes_descartada = foto(&s);
    conflicto(s.task_create_child_recorded(&h.id, &intencion("x"), 40, |_| unreachable!()), "descartada");
    assert_eq!(foto(&s), antes_descartada);
    sql(&mut s, &format!("UPDATE runs SET closed = 1 WHERE id = '{}'", run.id)).unwrap();
    conflicto(s.task_create_child_recorded(&raiz.id, &intencion("x"), 50, |_| unreachable!()), "cerrado");
    // Una Task importada sin Project no puede tener hijas del Core: no tendrían Project al que pertenecer.
    s.write(|tx| {
        tx.execute("INSERT INTO runs (id, objective, root_task_id, created_at, last_activity) VALUES ('r90', 'o', 't91', 1, 1)", [])?;
        tx.execute("INSERT INTO tasks (id, run_id, depth, title, repo, origin, created_at, updated_at) VALUES ('t91', 'r90', 0, 'viejo', 'r', 'legacy', 1, 1)", [])?;
        Ok(())
    })
    .unwrap();
    conflicto(s.task_create_child_recorded("t91", &intencion("x"), 60, |_| unreachable!()), "no tiene Project");
}

#[test]
fn la_base_impone_el_arbol_y_que_la_pertenencia_no_cambie() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (run, raiz) = crea_run(&mut s, &p, 10);
    let (otro_run, _) = crea_run(&mut s, &p, 11);
    let otro_p = s.project_create("otro", &Fingerprint::default(), &NewLocation { machine: "m1".into(), path: "c:/otro".into(), display_path: "C:/otro".into(), primary: true }).unwrap().id;
    // Una hija del Core en otro Run, en otro Project o a otra profundidad no entra.
    for (run_id, depth, project) in [(otro_run.id.as_str(), 1, p.as_str()), (run.id.as_str(), 2, p.as_str()), (run.id.as_str(), 1, otro_p.as_str())] {
        let q = format!(
            "INSERT INTO tasks (id, run_id, parent_task_id, depth, project_id, title, repo, origin, created_at, updated_at) VALUES ('t50', '{run_id}', '{}', {depth}, '{project}', 'x', 'r', 'core', 1, 1)",
            raiz.id
        );
        assert!(sql(&mut s, &q).unwrap_err().to_string().contains("un nivel por debajo"), "{q}");
    }
    let h = hija(&mut s, &raiz.id, "h", 20);
    for set in [format!("run_id = '{}'", otro_run.id), "parent_task_id = NULL, depth = 0".into(), format!("project_id = '{otro_p}'"), "origin = 'legacy'".into(), "created_at = 1".into(), "id = 't77'".into()] {
        let e = sql(&mut s, &format!("UPDATE tasks SET {set} WHERE id = '{}'", h.id)).unwrap_err().to_string();
        assert!(e.contains("no cambian"), "{set}: {e}");
    }
    assert_eq!(s.task_row(&h.id).unwrap().unwrap(), h);
    // Lo único que se puede completar es el Project de una Task importada que no lo tenía (relleno de D).
    s.write(|tx| {
        tx.execute("INSERT INTO runs (id, objective, root_task_id, created_at, last_activity) VALUES ('r90', 'o', 't91', 1, 1)", [])?;
        tx.execute("INSERT INTO tasks (id, run_id, depth, title, repo, origin, created_at, updated_at) VALUES ('t91', 'r90', 0, 'viejo', 'r', 'legacy', 1, 1)", [])?;
        Ok(())
    })
    .unwrap();
    sql(&mut s, &format!("UPDATE tasks SET project_id = '{p}' WHERE id = 't91'")).unwrap();
    assert!(sql(&mut s, &format!("UPDATE tasks SET project_id = '{otro_p}' WHERE id = 't91'")).unwrap_err().to_string().contains("no cambian"));
}

// ---------------------------------------------------------------------------------------------
// Editar, descartar, restaurar
// ---------------------------------------------------------------------------------------------

#[test]
fn cambiar_la_intencion_solo_registra_lo_que_cambio_de_verdad() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (_, raiz) = crea_run(&mut s, &p, 100);
    let mut vistos = vec![];
    let r = s.task_update_intent_recorded(&raiz.id, &IntentChange { title: Some("coordinar login".into()), spec: Some(raiz.spec.clone()) }, 200, |t, campos| {
        vistos = campos.to_vec();
        assert_eq!((t.title.as_str(), t.updated_at), ("coordinar login", 200), "el evento ve la fila nueva");
        Ok(de("task.updated", t))
    });
    assert_eq!(r.unwrap(), ChangeOutcome::Changed);
    assert_eq!(vistos, [IntentField::Title], "el encargo no cambió");
    let fila = s.task_row(&raiz.id).unwrap().unwrap();
    assert_eq!((fila.title.as_str(), fila.updated_at, fila.created_at), ("coordinar login", 200, 100));
    let eventos = cuenta(&s, "events");
    assert_eq!(s.task_update_intent_recorded(&raiz.id, &IntentChange { title: Some("coordinar login".into()), spec: None }, 300, |_, _| unreachable!()).unwrap(), ChangeOutcome::Unchanged);
    assert_eq!(s.task_update_intent_recorded("t99", &IntentChange { title: Some("x".into()), spec: None }, 300, |_, _| unreachable!()).unwrap(), ChangeOutcome::Missing);
    assert_eq!(cuenta(&s, "events"), eventos, "Unchanged y Missing no dejan hecho");
    assert!(matches!(s.task_update_intent_recorded(&raiz.id, &IntentChange::default(), 300, |_, _| unreachable!()), Err(StoreError::InvalidTask(_))));
    assert!(matches!(s.task_update_intent_recorded(&raiz.id, &IntentChange { title: Some(" ".into()), spec: None }, 300, |_, _| unreachable!()), Err(StoreError::InvalidTask(_))));
    // Un reloj que retrocede no deja `updated_at` antes de lo que ya era.
    s.task_update_intent_recorded(&raiz.id, &IntentChange { title: None, spec: Some("otro".into()) }, 50, |t, _| Ok(de("task.updated", t))).unwrap();
    assert_eq!(s.task_row(&raiz.id).unwrap().unwrap().updated_at, 200);
}

#[test]
fn descartar_y_restaurar_no_actuan_en_cascada() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (_, raiz) = crea_run(&mut s, &p, 10);
    let h = hija(&mut s, &raiz.id, "h", 20);
    let nieta = hija(&mut s, &h.id, "n", 30);
    let antes = foto(&s);
    conflicto(s.task_set_discarded_recorded(&h.id, true, 40, |_| unreachable!()), &nieta.id);
    assert_eq!(foto(&s), antes, "descartar a la madre no descarta a la hija: se rechaza");
    assert_eq!(s.task_set_discarded_recorded(&nieta.id, true, 40, |t| Ok(de("task.discarded", t))).unwrap(), ChangeOutcome::Changed);
    assert_eq!(s.task_set_discarded_recorded(&h.id, true, 50, |t| Ok(de("task.discarded", t))).unwrap(), ChangeOutcome::Changed);
    let fila = s.task_row(&h.id).unwrap().unwrap();
    assert_eq!((fila.intent, fila.discarded_at, fila.updated_at), (TaskIntent::Discarded, Some(50), 50));
    assert_eq!(s.task_set_discarded_recorded(&h.id, true, 60, |_| unreachable!()).unwrap(), ChangeOutcome::Unchanged);
    assert_eq!(s.task_set_discarded_recorded("t99", true, 60, |_| unreachable!()).unwrap(), ChangeOutcome::Missing);
    conflicto(s.task_update_intent_recorded(&h.id, &IntentChange { title: Some("x".into()), spec: None }, 60, |_, _| unreachable!()), "restáurala");
    // La nieta no se restaura mientras su madre siga descartada; al revés sí.
    conflicto(s.task_set_discarded_recorded(&nieta.id, false, 70, |_| unreachable!()), "restáurala");
    assert_eq!(s.task_set_discarded_recorded(&h.id, false, 80, |t| Ok(de("task.restored", t))).unwrap(), ChangeOutcome::Changed);
    assert_eq!(s.task_row(&nieta.id).unwrap().unwrap().intent, TaskIntent::Discarded, "restaurar a la madre no restaura a la hija");
    let fila = s.task_row(&h.id).unwrap().unwrap();
    assert_eq!((fila.intent, fila.discarded_at), (TaskIntent::Open, None));
    assert_eq!(s.tasks_of_project(&p, false).unwrap().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), [raiz.id.as_str(), h.id.as_str()]);
    assert_eq!(s.tasks_of_project(&p, true).unwrap().len(), 3);
}

#[test]
fn con_el_reloj_hacia_atras_el_descarte_no_queda_antes_de_la_ultima_actualizacion() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (_, raiz) = crea_run(&mut s, &p, 10);
    let h = hija(&mut s, &raiz.id, "h", 500);
    s.task_set_discarded_recorded(&h.id, true, 100, |t| Ok(de("task.discarded", t))).unwrap();
    let fila = s.task_row(&h.id).unwrap().unwrap();
    assert_eq!((fila.updated_at, fila.discarded_at), (500, Some(500)), "el descarte usa la misma marca que updated_at");
}

// ---------------------------------------------------------------------------------------------
// Borrar
// ---------------------------------------------------------------------------------------------

#[test]
fn solo_se_borra_una_task_sin_uso_y_su_historia_se_queda() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (_, raiz) = crea_run(&mut s, &p, 10);
    let h = hija(&mut s, &raiz.id, "h", 20);
    let nieta = hija(&mut s, &h.id, "n", 30);
    let antes = foto(&s);
    conflicto(s.task_remove_recorded(&raiz.id, TaskRemoval::IfUnused, |_| unreachable!()), "raíz");
    conflicto(s.task_remove_recorded(&h.id, TaskRemoval::IfUnused, |_| unreachable!()), "hija");
    assert_eq!(foto(&s), antes);
    let mut vista = None;
    assert_eq!(
        s.task_remove_recorded(&nieta.id, TaskRemoval::IfUnused, |t| {
            vista = Some(t.clone());
            Ok(de("task.removed", t))
        })
        .unwrap(),
        ChangeOutcome::Changed
    );
    assert_eq!(vista.as_ref(), Some(&nieta), "el evento recibe la fila tal como era");
    assert_eq!(s.task_row(&nieta.id).unwrap(), None);
    let ks = kinds(&s);
    assert!(ks.contains(&("task.created".into(), nieta.id.clone())) && ks.last() == Some(&("task.removed".into(), nieta.id.clone())), "la historia no se borra: {ks:?}");
    assert_eq!(s.task_remove_recorded(&nieta.id, TaskRemoval::IfUnused, |_| unreachable!()).unwrap(), ChangeOutcome::Missing);
}

#[test]
fn la_base_no_borra_en_cascada_aunque_se_salte_la_politica() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (run, raiz) = crea_run(&mut s, &p, 10);
    let h = hija(&mut s, &raiz.id, "h", 20);
    let antes = foto(&s);
    for q in [format!("DELETE FROM tasks WHERE id = '{}'", raiz.id), format!("DELETE FROM runs WHERE id = '{}'", run.id)] {
        let e = sql(&mut s, &q).unwrap_err().to_string();
        assert!(e.contains("FOREIGN KEY"), "{q}: {e}");
    }
    assert_eq!(foto(&s), antes);
    // Una fila de otra tabla que dependa de la Task (como lo harán los Attempts) bloquea el borrado entero.
    sql(&mut s, "CREATE TABLE depende (task_id TEXT NOT NULL REFERENCES tasks (id)) STRICT").unwrap();
    sql(&mut s, &format!("INSERT INTO depende VALUES ('{}')", h.id)).unwrap();
    assert!(s.task_remove_recorded(&h.id, TaskRemoval::IfUnused, |t| Ok(de("task.removed", t))).is_err());
    assert_eq!(s.task_row(&h.id).unwrap().unwrap(), h);
    assert_eq!(foto(&s), antes, "ni la fila ni su evento");
}

// ---------------------------------------------------------------------------------------------
// Atomicidad fila + evento
// ---------------------------------------------------------------------------------------------

/// Un borrador que no se pudo construir.
fn falla<T>() -> StoreResult<T> {
    Err(StoreError::InvalidEvent("borrador inválido".into()))
}

#[test]
fn sin_su_hecho_no_hay_cambio() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (_, raiz) = crea_run(&mut s, &p, 10);
    let antes = foto(&s);
    assert!(s.run_create_recorded(&run_nuevo(&p), 20, |_, _| falla()).is_err());
    assert!(s.run_create_recorded(&run_nuevo(&p), 20, |_, _| Ok(vec![])).is_err(), "un cambio sin eventos no se confirma");
    assert!(s.task_create_child_recorded(&raiz.id, &intencion("x"), 20, |_| falla()).is_err());
    assert!(s.task_update_intent_recorded(&raiz.id, &IntentChange { title: Some("z".into()), spec: None }, 20, |_, _| falla()).is_err());
    assert!(s.task_set_discarded_recorded(&raiz.id, true, 20, |_| falla()).is_err());
    assert_eq!(foto(&s), antes, "ni filas, ni eventos, ni ids consumidos");
    assert_eq!(s.task_row(&raiz.id).unwrap().unwrap(), raiz);
}

#[test]
fn un_evento_que_no_se_refiere_a_la_task_o_repetido_deshace_el_cambio() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (run, raiz) = crea_run(&mut s, &p, 10);
    let antes = foto(&s);
    let casos: [fn(&TaskRow) -> StoreResult<NewEvent>; 4] = [
        |t| Ok(ev("task.created", "task", "t999", &t.run_id, t.project_id.as_deref())),
        |t| Ok(ev("task.created", "task", &t.id, "r999", t.project_id.as_deref())),
        |t| Ok(ev("task.created", "task", &t.id, &t.run_id, Some("p-otro"))),
        |t| Ok(ev("task.created", "run", &t.id, &t.run_id, t.project_id.as_deref())),
    ];
    for e in casos {
        assert!(matches!(s.task_create_child_recorded(&raiz.id, &intencion("x"), 20, e), Err(StoreError::InvalidEvent(_))));
    }
    assert!(matches!(
        s.run_create_recorded(&run_nuevo(&p), 20, |r, t| Ok(vec![ev("run.created", "run", &r.id, &r.id, Some("p-otro")), de("task.created", t)])),
        Err(StoreError::InvalidEvent(_))
    ));
    assert_eq!(foto(&s), antes);
    // El mismo hecho dos veces (misma idem_key): el segundo no se confirma sin su evento.
    let con_clave = |t: &TaskRow| Ok(NewEvent { idem_key: Some("una".into()), ..de("task.created", t) });
    s.task_create_child_recorded(&raiz.id, &intencion("a"), 20, con_clave).unwrap();
    let tras_la_primera = foto(&s);
    conflicto(s.task_create_child_recorded(&raiz.id, &intencion("b"), 30, con_clave), "ya existía");
    assert_eq!(foto(&s), tras_la_primera);
    let _ = run;
}

/// Un proyector que falla deshace fila y evento: Task, Event y Attention viajan en la misma transacción.
#[derive(Debug)]
struct Falla;

impl EventProjector for Falla {
    fn project(&self, _tx: &rusqlite::Transaction<'_>, _events: &[EventRow]) -> StoreResult<Vec<NewEvent>> {
        Err(StoreError::InvalidAttention("proyección rota a propósito".into()))
    }
}

#[test]
fn si_la_proyeccion_falla_no_queda_ni_la_task_ni_su_evento() {
    let t = Tmp::new();
    let (mut s, p) = activo(t.path());
    let (_, raiz) = crea_run(&mut s, &p, 10);
    s.set_event_projector(std::sync::Arc::new(Falla));
    let antes = foto(&s);
    assert!(matches!(s.task_create_child_recorded(&raiz.id, &intencion("x"), 20, |t| Ok(de("task.created", t))), Err(StoreError::InvalidAttention(_))));
    assert!(s.run_create_recorded(&run_nuevo(&p), 20, |r, t| Ok(vec![ev("run.created", "run", &r.id, &r.id, Some(&p)), de("task.created", t)])).is_err());
    assert_eq!(foto(&s), antes);
}
