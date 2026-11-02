use super::runtime::{runtime_lookup_idempotent_in, validate_runtime_result_refs, RuntimeResultIds};
use rusqlite::Connection;

// SQLite puramente en memoria: no crea, limpia ni modifica ficheros de base de datos.
fn refs_fixture() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);
         INSERT INTO meta VALUES('agentic_model','1');
         CREATE TABLE projects(id TEXT PRIMARY KEY);
         CREATE TABLE runs(id TEXT PRIMARY KEY, root_task_id TEXT);
         CREATE TABLE tasks(id TEXT PRIMARY KEY, run_id TEXT, project_id TEXT, parent_task_id TEXT, depth INTEGER);
         CREATE TABLE attempts(id TEXT PRIMARY KEY, task_id TEXT);
         CREATE TABLE events(kind TEXT, entity_kind TEXT, entity_id TEXT, project_id TEXT, run_id TEXT);
         CREATE TABLE task_create_requests(identity_scope TEXT, method TEXT, request_id TEXT, payload_sha256 TEXT, run_id TEXT, task_id TEXT, attempt_id TEXT);
         INSERT INTO projects VALUES ('p1'),('p2');
         INSERT INTO runs VALUES ('r1','t1'),('r2','t2');
         INSERT INTO tasks VALUES ('t1','r1','p1',NULL,0),('t2','r2','p2',NULL,0);
         INSERT INTO attempts VALUES ('a2','t2');
         INSERT INTO events VALUES
           ('run.created','run','r1','p1','r1'),('task.created','task','t1','p1','r1'),
           ('run.created','run','r2','p2','r2'),('task.created','task','t2','p2','r2');",
    ).unwrap();
    db
}

#[test]
fn runtime_ledger_rejects_missing_or_unrelated_refs() {
    let db = refs_fixture();
    let valid = RuntimeResultIds { run_id: "r1".into(), task_id: "t1".into(), attempt_id: None };
    assert_eq!(validate_runtime_result_refs(&db, &valid).unwrap(), "p1");

    // Alineamos el root del Run equivocado a la Task para aislar la relación Task -> Run.
    db.execute("UPDATE runs SET root_task_id='t1' WHERE id='r2'", []).unwrap();
    let wrong_run = RuntimeResultIds { run_id: "r2".into(), ..valid.clone() };
    assert!(validate_runtime_result_refs(&db, &wrong_run).is_err());
    db.execute("UPDATE runs SET root_task_id='t2' WHERE id='r2'", []).unwrap();

    let wrong_attempt = RuntimeResultIds { attempt_id: Some("a2".into()), ..valid };
    assert!(validate_runtime_result_refs(&db, &wrong_attempt).is_err());
    let missing = RuntimeResultIds { run_id: "missing".into(), task_id: "t1".into(), attempt_id: None };
    assert!(validate_runtime_result_refs(&db, &missing).is_err());

    // Una Task de ledger debe ser la raíz del Run; no basta con que ambos existan.
    db.execute("UPDATE runs SET root_task_id='t2' WHERE id='r1'", []).unwrap();
    let valid = RuntimeResultIds { run_id: "r1".into(), task_id: "t1".into(), attempt_id: None };
    assert!(validate_runtime_result_refs(&db, &valid).is_err());
    db.execute("UPDATE runs SET root_task_id='t1' WHERE id='r1'", []).unwrap();

    // Project debe seguir presente y ligado a la Task.
    db.execute("UPDATE tasks SET project_id='missing' WHERE id='t1'", []).unwrap();
    assert!(validate_runtime_result_refs(&db, &valid).is_err());
}

#[test]
fn readonly_lookup_verifies_payload_and_original_relations() {
    let db = refs_fixture();
    db.execute(
        "INSERT INTO task_create_requests VALUES('user:u1','task.create','req1','', 'r1','t1',NULL)",
        [],
    ).unwrap();
    // Populate an exact valid lowercase digest.
    db.execute("UPDATE task_create_requests SET payload_sha256=?1", ["a".repeat(64)]).unwrap();
    let replay = runtime_lookup_idempotent_in(&db, "user:u1", "req1", &"a".repeat(64)).unwrap();
    assert_eq!(replay, Some(RuntimeResultIds { run_id: "r1".into(), task_id: "t1".into(), attempt_id: None }));
    assert!(runtime_lookup_idempotent_in(&db, "user:u1", "req1", &"b".repeat(64)).is_err());
    assert_eq!(runtime_lookup_idempotent_in(&db, "user:u1", "missing", &"a".repeat(64)).unwrap(), None);

    // Aunque el Project alternativo exista, no puede separarse del vínculo histórico emitido.
    db.execute("UPDATE tasks SET project_id='p2' WHERE id='t1'", []).unwrap();
    assert!(runtime_lookup_idempotent_in(&db, "user:u1", "req1", &"a".repeat(64)).is_err());
}

#[test]
fn runtime_lookup_acepta_scope_completo_de_clientprincipal_sin_colision() {
    let db = refs_fixture();
    let hash = "c".repeat(64);
    let id_a = format!("persona:{}ab", "é".repeat(95)); // 200 bytes: Unicode + colon.
    let id_b = format!("persona:{}ac", "é".repeat(95));
    assert_eq!(id_a.len(), 200);
    assert_eq!(id_b.len(), 200);
    let scope_a = format!("user:{id_a}");
    let scope_b = format!("user:{id_b}");
    assert_eq!(scope_a.len(), 205);
    assert_ne!(scope_a, scope_b);
    db.execute(
        "INSERT INTO task_create_requests VALUES(?1,'task.create','same',?2,'r1','t1',NULL),
         (?3,'task.create','same',?2,'r2','t2',NULL)",
        rusqlite::params![scope_a, hash, scope_b],
    ).unwrap();

    assert_eq!(
        runtime_lookup_idempotent_in(&db, &scope_a, "same", &hash).unwrap(),
        Some(RuntimeResultIds { run_id: "r1".into(), task_id: "t1".into(), attempt_id: None })
    );
    assert_eq!(
        runtime_lookup_idempotent_in(&db, &scope_b, "same", &hash).unwrap(),
        Some(RuntimeResultIds { run_id: "r2".into(), task_id: "t2".into(), attempt_id: None })
    );

    let too_long = format!("user:{}x", "é".repeat(100)); // 201 bytes in the principal id.
    assert_eq!(too_long.len(), 206);
    assert!(runtime_lookup_idempotent_in(&db, &too_long, "same", &hash).is_err());
}

// ---------------------------------------------------------------------------------------------------------------------
// La tabla del ledger (migración 017): inerte hasta el corte, inmutable y con claves acotadas
// ---------------------------------------------------------------------------------------------------------------------

/// Carpeta temporal para el migrador (copias previas); se borra al salir, solo ella.
struct Dir(std::path::PathBuf);

impl Dir {
    fn new() -> Dir {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("lixbon-ledger-017-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        Dir(dir)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Las migraciones del binario con el CORTE sustituido por una migración vacía: el migrador general no aplica la 014 ni
/// nada posterior (es una barrera), así que la 017 se prueba aislada, sin la maquinaria del corte.
fn ledger_conn(dir: &Dir) -> Connection {
    use super::migrate::{embedded, migrate_capped, Migration};
    let neutral: Vec<Migration> = embedded()
        .into_iter()
        .map(|m| if m.name == super::cut::CUT_NAME { Migration::new(m.version, "corte_neutro_ledger_test", "SELECT 1;") } else { m })
        .collect();
    let mut conn = Connection::open_in_memory().unwrap();
    let report = migrate_capped(&mut conn, &neutral, i64::MAX, "t", &dir.0).unwrap();
    assert!(report.applied.contains(&17), "la 017 se aplica: {:?}", report.applied);
    // Estas pruebas miran las restricciones propias de la tabla; las referencias a Run/Task se prueban aparte.
    conn.execute_batch("PRAGMA foreign_keys = OFF;").unwrap();
    conn
}

fn ledger_row(conn: &Connection, scope: &str, method: &str, request: &str, hash: &str, task: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO task_create_requests(identity_scope, method, request_id, payload_sha256, run_id, task_id, attempt_id, created_at)
         VALUES (?1, ?2, ?3, ?4, 'r1', ?5, NULL, 1)",
        rusqlite::params![scope, method, request, hash, task],
    )
}

#[test]
fn el_ledger_esta_inerte_hasta_el_corte_y_despues_acepta_filas() {
    let dir = Dir::new();
    let conn = ledger_conn(&dir);
    let hash = "a".repeat(64);
    let error = ledger_row(&conn, "user:u1", "task.create", "req1", &hash, "t1").unwrap_err().to_string();
    assert!(error.contains("inerte"), "antes del corte no hay un segundo origen de verdad: {error}");
    conn.execute("INSERT INTO meta (key, value) VALUES ('agentic_model', '1')", []).unwrap();
    assert_eq!(ledger_row(&conn, "user:u1", "task.create", "req1", &hash, "t1").unwrap(), 1);
}

#[test]
fn una_fila_del_ledger_no_se_modifica_ni_se_borra() {
    let dir = Dir::new();
    let conn = ledger_conn(&dir);
    conn.execute("INSERT INTO meta (key, value) VALUES ('agentic_model', '1')", []).unwrap();
    ledger_row(&conn, "user:u1", "task.create", "req1", &"a".repeat(64), "t1").unwrap();
    let update = conn.execute("UPDATE task_create_requests SET payload_sha256 = ?1", ["b".repeat(64)]).unwrap_err().to_string();
    assert!(update.contains("inmutable"), "{update}");
    let delete = conn.execute("DELETE FROM task_create_requests", []).unwrap_err().to_string();
    assert!(delete.contains("no se borra"), "{delete}");
}

#[test]
fn el_ledger_acota_claves_metodo_huella_y_una_sola_peticion_por_task() {
    let dir = Dir::new();
    let conn = ledger_conn(&dir);
    conn.execute("INSERT INTO meta (key, value) VALUES ('agentic_model', '1')", []).unwrap();
    let hash = "a".repeat(64);
    for (label, result) in [
        ("request_id con caracteres fuera del alfabeto", ledger_row(&conn, "user:u1", "task.create", "req 1", &hash, "t1")),
        ("request_id de 65 caracteres", ledger_row(&conn, "user:u1", "task.create", &"x".repeat(65), &hash, "t1")),
        ("request_id vacío", ledger_row(&conn, "user:u1", "task.create", "", &hash, "t1")),
        ("scope vacío", ledger_row(&conn, "", "task.create", "req1", &hash, "t1")),
        ("otro método", ledger_row(&conn, "user:u1", "task.update", "req1", &hash, "t1")),
        ("huella que no mide 64", ledger_row(&conn, "user:u1", "task.create", "req1", "abc", "t1")),
    ] {
        assert!(result.is_err(), "se aceptó: {label}");
    }
    ledger_row(&conn, "user:u1", "task.create", "req1", &hash, "t1").unwrap();
    assert!(ledger_row(&conn, "user:u1", "task.create", "req1", &hash, "t2").is_err(), "mismo scope y request_id: es la clave primaria");
    assert!(ledger_row(&conn, "user:u1", "task.create", "req2", &hash, "t1").is_err(), "una Task nace de una sola petición");
    assert!(ledger_row(&conn, "user:u2", "task.create", "req1", &hash, "t3").is_ok(), "otro scope puede reutilizar el request_id");
}

#[test]
fn insert_or_replace_no_puede_reescribir_una_fila_del_ledger() {
    let dir = Dir::new();
    let conn = ledger_conn(&dir);
    conn.execute("INSERT INTO meta (key, value) VALUES ('agentic_model', '1')", []).unwrap();
    let original = "a".repeat(64);
    ledger_row(&conn, "user:u1", "task.create", "req1", &original, "t1").unwrap();

    let replace = |scope: &str, request: &str, hash: &str, task: &str| {
        conn.execute(
            "INSERT OR REPLACE INTO task_create_requests(identity_scope, method, request_id, payload_sha256, run_id, task_id, attempt_id, created_at)
             VALUES (?1, 'task.create', ?2, ?3, 'r1', ?4, NULL, 1)",
            rusqlite::params![scope, request, hash, task],
        )
    };
    // Sin la 018, SQLite borraría la fila existente sin disparar el trigger de borrado (recursive_triggers está OFF) y la
    // huella original se perdería: la idempotencia quedaría rota para ese request_id.
    let same_key = replace("user:u1", "req1", &"b".repeat(64), "t2").unwrap_err().to_string();
    assert!(same_key.contains("no_replace"), "{same_key}");
    let same_task = replace("user:u1", "req2", &"b".repeat(64), "t1").unwrap_err().to_string();
    assert!(same_task.contains("no_replace"), "{same_task}");

    let rows: Vec<(String, String)> = conn
        .prepare("SELECT request_id, payload_sha256 FROM task_create_requests")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows, vec![("req1".to_string(), original)], "el ledger conserva la fila original, intacta");

    // Un REPLACE sobre claves libres es un insert normal: la guarda no bloquea el uso legítimo.
    assert_eq!(replace("user:u1", "req3", &"c".repeat(64), "t3").unwrap(), 1);
}
