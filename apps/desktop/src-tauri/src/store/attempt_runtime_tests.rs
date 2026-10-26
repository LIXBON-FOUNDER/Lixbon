//! Pruebas de los huecos del modelo para el runtime (migración 012, LXO-231): esperas y salida del Attempt, integrar
//! después de terminar, columnas de runtime, fases, mensajes del Thread y bloqueos de entorno.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::json;

use super::attempts::*;
use super::sessions::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-runtime-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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
    raiz: String,
    hija: String,
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
        .run_create_recorded(&NewRun { objective: "login".into(), project_id: project, root: intencion("coordinar") }, 10, |r, t| {
            Ok(vec![evento("run.created", "run", &r.id, t), evento("task.created", "task", &t.id, t)])
        })
        .unwrap();
    let hija = s.task_create_child_recorded(&raiz.id, &intencion("api"), 20, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    if !activo {
        s.write(|tx| Ok(tx.execute("DELETE FROM meta WHERE key = ?1", [AGENTIC_MODEL_KEY])?)).unwrap();
    }
    Mundo { s, raiz: raiz.id, hija: hija.id }
}

fn mundo(dir: &Path) -> Mundo {
    base(dir, true)
}

fn pide(w: &mut Mundo) -> AttemptRow {
    let h = w.hija.clone();
    let new = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    w.s.attempt_create_recorded(&h, &new, 100, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap()
}

fn paso(w: &mut Mundo, id: &str, action: AttemptAction, at: i64) -> StoreResult<ChangeOutcome> {
    w.s.attempt_transition_recorded(id, &action, at, |a, _, t| Ok(evento("attempt.step", "attempt", &a.id, t)))
}

fn integra(w: &mut Mundo, id: &str) -> StoreResult<ChangeOutcome> {
    w.s.attempt_integrate_recorded(id, 900, |a, t| Ok(evento("attempt.integrated", "attempt", &a.id, t)))
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

fn columna(s: &Store, id: &str, col: &str) -> rusqlite::types::Value {
    s.read(|c| Ok(c.query_row(&format!("SELECT {col} FROM attempts WHERE id = ?1"), [id], |r| r.get(0))?)).unwrap()
}

// ---------------------------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------------------------

#[test]
fn la_012_solo_avanza_y_reemplaza_los_dos_triggers_de_la_008() {
    let m = embedded().into_iter().find(|m| m.version == 12).expect("hay migración 012");
    assert_eq!(m.name, "attempt_runtime");
    let sql: String = m.sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n").to_uppercase();
    for prohibido in ["DROP TABLE", "DROP INDEX", "ON DELETE", "CASCADE", "BEGIN TRANSACTION", "COMMIT;", "ROLLBACK"] {
        assert!(!sql.contains(prohibido), "la 012 no puede llevar «{prohibido}»");
    }
    assert_eq!(sql.matches("DROP TRIGGER").count(), 2, "solo reemplaza attempts_lifecycle y attempts_final_is_final");
    let t = Tmp::new();
    let w = mundo(t.path());
    let triggers: Vec<String> = w.s.read(|c| Ok(c.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'attempts'")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert!(triggers.contains(&"attempts_lifecycle".into()) && triggers.contains(&"attempts_final_is_final".into()));
}

/// La 012 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_012_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 12).expect("existe la 012");
    assert_eq!(m.checksum(), "7c3d46626555d5f7f07c8f7957a5ae48bade597092daec08047c52d9fa8700f9", "una migración publicada no se edita");
}

// ---------------------------------------------------------------------------------------------
// Ciclo de vida: esperas, salida e integración
// ---------------------------------------------------------------------------------------------

#[test]
fn el_attempt_espera_vuelve_y_termina_como_el_runtime_legacy() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let a = pide(&mut w);
    // `lxo ask` antes del primer comando: la espera fija el arranque.
    assert_eq!(paso(&mut w, &a.id, AttemptAction::Wait, 110).unwrap(), ChangeOutcome::Changed);
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap().started_at, Some(110));
    // De una espera se vuelve con Resume, no con Start (que fijaría otra vez el arranque).
    assert!(matches!(paso(&mut w, &a.id, AttemptAction::Start, 120), Err(StoreError::AttemptTransition { .. })));
    assert_eq!(paso(&mut w, &a.id, AttemptAction::Resume, 120).unwrap(), ChangeOutcome::Changed);
    assert_eq!(paso(&mut w, &a.id, AttemptAction::AwaitTerminal, 130).unwrap(), ChangeOutcome::Changed);
    assert_eq!(paso(&mut w, &a.id, AttemptAction::AwaitTerminal, 131).unwrap(), ChangeOutcome::Unchanged);
    assert_eq!(paso(&mut w, &a.id, AttemptAction::Resume, 140).unwrap(), ChangeOutcome::Changed);
    assert_eq!(paso(&mut w, &a.id, AttemptAction::Finish { summary: "ok".into() }, 150).unwrap(), ChangeOutcome::Changed);
    let fin = w.s.attempt_row(&a.id).unwrap().unwrap();
    assert_eq!((fin.status, fin.started_at, fin.ended_at), (AttemptStatus::Done, Some(110), Some(150)));
}

#[test]
fn un_done_antes_del_primer_comando_y_un_huerfano_cierran_bien() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let a = pide(&mut w);
    paso(&mut w, &a.id, AttemptAction::Finish { summary: String::new() }, 200).unwrap();
    let fin = w.s.attempt_row(&a.id).unwrap().unwrap();
    assert_eq!((fin.started_at, fin.ended_at), (Some(200), Some(200)), "terminó desde starting: arrancó al salir");
    let b = pide(&mut w);
    paso(&mut w, &b.id, AttemptAction::Start, 300).unwrap();
    assert_eq!(paso(&mut w, &b.id, AttemptAction::Exit, 310).unwrap(), ChangeOutcome::Changed);
    let salido = w.s.attempt_row(&b.id).unwrap().unwrap();
    assert_eq!((salido.status, salido.ended_at), (AttemptStatus::Exited, Some(310)));
    assert!(matches!(paso(&mut w, &b.id, AttemptAction::Resume, 320), Err(StoreError::AttemptTransition { .. })), "un final no vuelve");
    // Pendiente de aprobación no sale como huérfano: se rechaza (cancelar).
    let new = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: true };
    let h = w.hija.clone();
    let c = w.s.attempt_create_recorded(&h, &new, 400, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap();
    assert!(matches!(paso(&mut w, &c.id, AttemptAction::Exit, 410), Err(StoreError::AttemptTransition { .. })));
}

#[test]
fn integrar_es_lo_unico_que_cambia_en_un_attempt_terminado() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let a = pide(&mut w);
    assert!(matches!(integra(&mut w, &a.id), Err(StoreError::AttemptConflict(m)) if m.contains("solo se integra uno done")));
    paso(&mut w, &a.id, AttemptAction::Start, 110).unwrap();
    paso(&mut w, &a.id, AttemptAction::Finish { summary: "ok".into() }, 120).unwrap();
    assert_eq!(integra(&mut w, &a.id).unwrap(), ChangeOutcome::Changed);
    assert_eq!(integra(&mut w, &a.id).unwrap(), ChangeOutcome::Unchanged);
    assert_eq!(columna(&w.s, &a.id, "integrated"), rusqlite::types::Value::Integer(1));
    for set in ["integrated = 0", "summary = 'otro'", "delivered = '[\"x\"]'", "status = 'running'", "updated_at = 999", "status = 'done'"] {
        assert!(sql(&mut w.s, &format!("UPDATE attempts SET {set} WHERE id = '{}'", a.id)).is_err(), "{set}");
    }
    // Desde la 013 (LXO-232) la base admite además la observación tardía del modelo: Codex lo declara al salir.
    assert!(sql(&mut w.s, &format!("UPDATE attempts SET model_effective = 'otro' WHERE id = '{}'", a.id)).is_ok());
    let b = pide(&mut w);
    paso(&mut w, &b.id, AttemptAction::Start, 130).unwrap();
    paso(&mut w, &b.id, AttemptAction::Fail { reason: "agent_reported".into(), summary: String::new() }, 140).unwrap();
    assert!(integra(&mut w, &b.id).is_err(), "el mutador vNext solo integra uno done");
    // La base admite integrar cualquier final desde la 013: el runtime integra la rama de una tarea fallida.
    assert!(sql(&mut w.s, &format!("UPDATE attempts SET integrated = 1 WHERE id = '{}'", b.id)).is_ok());
    assert_eq!(integra(&mut w, "t99-a1").unwrap(), ChangeOutcome::Missing);
}

// ---------------------------------------------------------------------------------------------
// Piezas para el runtime (sin evento propio)
// ---------------------------------------------------------------------------------------------

#[test]
fn las_columnas_de_runtime_se_actualizan_mientras_corre_y_no_despues() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let a = pide(&mut w);
    let cambios = vec![
        (RuntimeField::Cwd, json!("C:/app.wt/t3")),
        (RuntimeField::Policy, json!({ "profile": "implementar", "policy_status": "ok" })),
        (RuntimeField::RequestedArgv, json!(["claude", "-p"])),
        (RuntimeField::StreamJson, json!(true)),
        (RuntimeField::ApprovalDeadline, json!(5_000)),
        (RuntimeField::Delivered, json!(["0d9f3c"])),
    ];
    w.s.write(|tx| attempt_runtime_update_in(tx, &a.id, &cambios, 150)).unwrap();
    assert_eq!(columna(&w.s, &a.id, "cwd"), rusqlite::types::Value::Text("C:/app.wt/t3".into()));
    assert_eq!(columna(&w.s, &a.id, "stream_json"), rusqlite::types::Value::Integer(1));
    assert_eq!(columna(&w.s, &a.id, "requested_argv"), rusqlite::types::Value::Text("[\"claude\",\"-p\"]".into()));
    // Se puede volver a NULL (el plazo de aprobación se limpia al reanudar).
    w.s.write(|tx| attempt_runtime_update_in(tx, &a.id, &[(RuntimeField::ApprovalDeadline, json!(null))], 160)).unwrap();
    assert_eq!(columna(&w.s, &a.id, "approval_deadline"), rusqlite::types::Value::Null);
    assert!(w.s.write(|tx| attempt_runtime_update_in(tx, &a.id, &[(RuntimeField::Files, json!("no es json"))], 170)).is_err(), "las columnas JSON lo validan");
    assert!(w.s.write(|tx| attempt_runtime_update_in(tx, "t99-a1", &[(RuntimeField::Cwd, json!("x"))], 170)).is_err());
    paso(&mut w, &a.id, AttemptAction::Exit, 180).unwrap();
    assert!(w.s.write(|tx| attempt_runtime_update_in(tx, &a.id, &[(RuntimeField::Cwd, json!("tarde"))], 190)).is_err(), "un final no cambia");
}

#[test]
fn las_fases_se_anaden_en_orden_son_historia_y_no_llegan_a_un_final() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let a = pide(&mut w);
    let ords: Vec<i64> = ["tests", "tests", "lint"].iter().enumerate().map(|(i, n)| w.s.write(|tx| attempt_phase_append_in(tx, &a.id, n, i == 1, "", 200 + i as i64)).unwrap()).collect();
    assert_eq!(ords, [0, 1, 2]);
    assert!(sql(&mut w.s, &format!("UPDATE attempt_phases SET note = 'x' WHERE attempt_id = '{}'", a.id)).is_err());
    assert!(sql(&mut w.s, &format!("DELETE FROM attempt_phases WHERE attempt_id = '{}'", a.id)).is_err());
    paso(&mut w, &a.id, AttemptAction::Finish { summary: String::new() }, 300).unwrap();
    assert!(w.s.write(|tx| attempt_phase_append_in(tx, &a.id, "tarde", true, "", 310)).is_err());
}

#[test]
fn los_mensajes_del_thread_usan_el_contador_compartido_y_solo_cambian_de_leido() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (raiz, hija) = (w.raiz.clone(), w.hija.clone());
    let a = pide(&mut w);
    let th = w.s.thread_open_recorded(&hija, 50, |th, t| Ok(evento("thread.created", "thread", &th.id, t))).unwrap();
    let msg = |kind: &str, body: &str, reply_to: Option<i64>, from: &str, to: &str, att: Option<String>| NewThreadMessage {
        thread_id: th.id.clone(),
        from_task_id: from.into(),
        to_task_id: to.into(),
        from_attempt_id: att,
        kind: kind.into(),
        body: body.into(),
        reply_to,
        at: 60,
    };
    let q = w.s.write(|tx| thread_message_append_in(tx, &msg("question", "¿users o accounts?", None, &hija, &raiz, Some(a.id.clone())))).unwrap();
    let r = w.s.write(|tx| thread_message_append_in(tx, &msg("reply", "accounts", Some(q), &raiz, &hija, None))).unwrap();
    assert!(r > q, "ids del contador compartido");
    let siguiente = w.s.task_create_child_recorded(&raiz, &NewTaskIntent { title: "otra".into(), spec: String::new(), repo: "c:/app".into() }, 70, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    assert!(siguiente.id[1..].parse::<i64>().unwrap() > r, "las Tasks siguen después de los mensajes, sin colisiones");
    assert!(w.s.write(|tx| thread_message_append_in(tx, &msg("chisme", "x", None, &hija, &raiz, None))).is_err(), "tipo cerrado");
    assert_eq!(w.s.write(|tx| thread_messages_mark_read_in(tx, &[q, r])).unwrap(), 2);
    assert_eq!(w.s.write(|tx| thread_messages_mark_read_in(tx, &[q])).unwrap(), 0);
    assert_eq!(w.s.thread_messages_of_attempt(&a.id).unwrap().len(), 1);
}

#[test]
fn los_bloqueos_de_entorno_se_ponen_y_se_quitan() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    assert!(w.s.write(|tx| env_block_set_in(tx, "codex/explorar", "windows_sandbox_elevated", true)).unwrap());
    assert!(!w.s.write(|tx| env_block_set_in(tx, "codex/explorar", "windows_sandbox_elevated", true)).unwrap(), "idempotente");
    assert!(w.s.write(|tx| env_block_set_in(tx, "codex/explorar", "inventado", true)).is_err(), "causa cerrada");
    assert!(w.s.write(|tx| env_block_set_in(tx, "codex/explorar", "windows_sandbox_elevated", false)).unwrap());
    assert_eq!(w.s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM env_blocks", [], |r| r.get::<_, i64>(0))?)).unwrap(), 0);
}

/// Las migraciones del binario con el CORTE sustituido por una migración vacía. El migrador general no aplica la 014 ni nada
/// posterior (es una barrera); así se prueba la 015 aislada, sin la maquinaria del corte.
fn con_el_corte_neutro() -> Vec<Migration> {
    embedded().into_iter().map(|m| if m.name == super::cut::CUT_NAME { Migration::new(m.version, "corte_neutro_de_prueba", "SELECT 1;") } else { m }).collect()
}

#[test]
fn la_causa_del_sandbox_de_windows_de_codex_se_guarda_y_una_desconocida_se_rechaza() {
    let t = Tmp::new();
    let mut s = Store::open_with(t.path(), &con_el_corte_neutro(), "t").unwrap();
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    assert!(s.write(|tx| env_block_set_in(tx, "codex/explorar", "windows_sandbox_setup", true)).unwrap());
    assert!(s.write(|tx| env_block_set_in(tx, "codex/explorar", "windows_sandbox_inventado", true)).is_err(), "el conjunto sigue cerrado");
    assert!(s.write(|tx| env_block_set_in(tx, "codex/explorar", "windows_sandbox_setup", false)).unwrap());
}

/// La 015 reconstruye `env_blocks` (SQLite no cambia un CHECK en su sitio): conserva las filas, admite la causa nueva,
/// mantiene cerrado el conjunto y recrea los dos triggers de «inerte hasta el corte».
#[test]
fn la_migracion_015_conserva_las_filas_admite_la_causa_nueva_y_mantiene_los_triggers() {
    use rusqlite::Connection;
    let t = Tmp::new();
    let todas = con_el_corte_neutro();
    let mut conn = Connection::open_in_memory().unwrap();
    let r = super::migrate::migrate_capped(&mut conn, &todas, 14, "t", t.path()).unwrap();
    assert_eq!(r.to_version, 14);
    conn.execute("INSERT INTO meta (key, value) VALUES ('agentic_model', '1')", []).unwrap();
    for (scope, cause) in [("claude/explorar", "cli_missing"), ("codex/explorar", "windows_sandbox_elevated"), ("codex/proponer", "cli_flags_unsupported")] {
        conn.execute("INSERT INTO env_blocks (scope, cause) VALUES (?1, ?2)", [scope, cause]).unwrap();
    }
    assert!(conn.execute("INSERT INTO env_blocks (scope, cause) VALUES ('codex/explorar', 'windows_sandbox_setup')", []).is_err(), "antes de la 015 la causa no existe");

    let r = super::migrate::migrate_capped(&mut conn, &todas, i64::MAX, "t", t.path()).unwrap();
    assert_eq!((r.from_version, r.applied.clone()), (14, vec![15, 16]));
    let filas: Vec<(String, String)> = conn.prepare("SELECT scope, cause FROM env_blocks ORDER BY scope").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(
        filas,
        [("claude/explorar".into(), "cli_missing".into()), ("codex/explorar".into(), "windows_sandbox_elevated".into()), ("codex/proponer".into(), "cli_flags_unsupported".into())],
        "las filas pasan intactas"
    );
    conn.execute("INSERT INTO env_blocks (scope, cause) VALUES ('codex/explorar', 'windows_sandbox_setup')", []).expect("ya admite la causa nueva");
    assert!(conn.execute("INSERT INTO env_blocks (scope, cause) VALUES ('codex/explorar', 'otra')", []).is_err(), "el conjunto sigue cerrado");
    assert!(conn.execute("INSERT INTO env_blocks (scope, cause) VALUES ('codex/explorar', 'windows_sandbox_setup')", []).is_err(), "y la clave primaria (scope, cause) sigue");

    // Los triggers sobreviven a la reconstrucción: sin el corte activo, ni insertar ni borrar.
    conn.execute("DELETE FROM meta WHERE key = 'agentic_model'", []).unwrap();
    let ins = conn.execute("INSERT INTO env_blocks (scope, cause) VALUES ('x/y', 'cli_missing')", []).unwrap_err().to_string();
    let del = conn.execute("DELETE FROM env_blocks", []).unwrap_err().to_string();
    assert!(ins.contains("inerte") && del.contains("inerte"), "{ins} / {del}");
    let triggers: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'env_blocks'", [], |r| r.get(0)).unwrap();
    assert_eq!(triggers, 2);
}

/// La 015 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_015_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 15).expect("existe la 015");
    assert_eq!(m.name, "env_block_sandbox_setup");
    assert_eq!(m.checksum(), "f2ca67ed936aee208e58dad78ce86e1b155002ae65c796e765b3173b0c6a6bea", "una migración publicada no se edita");
}

#[test]
fn antes_del_corte_ninguna_pieza_escribe() {
    let t = Tmp::new();
    let mut w = base(t.path(), false);
    let r = w.s.write(|tx| env_block_set_in(tx, "codex/explorar", "cli_missing", true));
    assert!(matches!(r, Err(StoreError::AgenticModelInactive)), "{r:?}");
    assert!(matches!(w.s.write(|tx| attempt_phase_append_in(tx, "t3-a1", "x", true, "", 1)), Err(StoreError::AgenticModelInactive)));
    assert!(matches!(w.s.write(|tx| attempt_runtime_update_in(tx, "t3-a1", &[(RuntimeField::Cwd, json!("x"))], 1)), Err(StoreError::AgenticModelInactive)));
    assert!(sql(&mut w.s, "INSERT INTO env_blocks (scope, cause) VALUES ('a/b', 'cli_missing')").unwrap_err().to_string().contains("inerte"));
}
