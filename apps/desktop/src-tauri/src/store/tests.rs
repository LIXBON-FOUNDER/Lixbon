//! Pruebas del almacén. Todas usan una carpeta temporal propia (nunca el
//! `~/.lixbon` real ni `state.json`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, OpenFlags};

use super::*;

static N: AtomicU64 = AtomicU64::new(0);

/// Carpeta temporal única que se borra al salir.
struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!(
            "lixbon-store-test-{}-{}-{nanos}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
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

const M002_PROYECTOS: &str = "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
CREATE TABLE project_locations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL
) STRICT;";

// Referencias blandas: project_id y entity_id SIN REFERENCES.
const M003_EVENTOS: &str = "CREATE TABLE events (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  client_id TEXT,
  entity_kind TEXT,
  entity_id TEXT,
  at INTEGER NOT NULL
) STRICT;";

fn con_extras(extras: &[Migration]) -> Vec<Migration> {
    let mut v = embedded();
    v.extend_from_slice(extras);
    v
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn tabla_existe(store: &Store, name: &str) -> bool {
    store
        .read(|c| Ok(count(c, &format!("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='{name}'")) > 0))
        .unwrap()
}

// ---------------------------------------------------------------- apertura

#[test]
fn migraciones_embebidas_empiezan_en_001_core_y_son_validas() {
    let m = embedded();
    assert!(!m.is_empty());
    assert_eq!((m[0].version, m[0].name), (1, "core"));
    assert!(m.windows(2).all(|w| w[0].version < w[1].version));
}

#[test]
fn abrir_base_nueva_aplica_001_y_crea_el_esquema_core() {
    let tmp = Tmp::new();
    let store = Store::open(tmp.path(), "9.9.9").unwrap();
    let r = store.migration_report();
    assert_eq!((r.from_version, r.to_version), (0, 1));
    assert_eq!(r.applied, vec![1]);
    assert!(r.backup.is_none(), "una base nueva no tiene nada que copiar");
    for t in ["schema_migrations", "meta", "legacy_state"] {
        assert!(tabla_existe(&store, t), "falta la tabla {t}");
    }
    let (name, app): (String, String) = store
        .read(|c| Ok(c.query_row("SELECT name, app_version FROM schema_migrations WHERE version = 1", [], |r| Ok((r.get(0)?, r.get(1)?)))?))
        .unwrap();
    assert_eq!((name.as_str(), app.as_str()), ("core", "9.9.9"));
    assert_eq!(store.read(|c| Ok(count(c, "PRAGMA user_version"))).unwrap(), 1);
    assert!(!store.backup_dir().exists(), "no se crea la carpeta de copias sin copia");
    store.integrity_check().unwrap();
}

#[test]
fn los_pragma_del_diseno_estan_activos() {
    let tmp = Tmp::new();
    let store = Store::open(tmp.path(), "t").unwrap();
    store
        .read(|c| {
            let jm: String = c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
            assert_eq!(jm.to_lowercase(), "wal");
            assert_eq!(count(c, "PRAGMA synchronous"), 2, "synchronous=FULL");
            assert_eq!(count(c, "PRAGMA foreign_keys"), 1);
            assert_eq!(count(c, "PRAGMA busy_timeout"), 5000);
            Ok(())
        })
        .unwrap();
}

#[test]
fn reabrir_es_idempotente_y_conserva_los_datos() {
    let tmp = Tmp::new();
    {
        let mut s = Store::open(tmp.path(), "t").unwrap();
        s.write(|tx| {
            tx.execute("INSERT INTO meta (key, value) VALUES ('machine_id', 'abc')", [])?;
            Ok(())
        })
        .unwrap();
    }
    let s = Store::open(tmp.path(), "t").unwrap();
    let r = s.migration_report();
    assert_eq!((r.from_version, r.to_version), (1, 1));
    assert!(r.applied.is_empty());
    assert!(r.backup.is_none(), "sin migraciones pendientes no se copia");
    let v: String = s.read(|c| Ok(c.query_row("SELECT value FROM meta WHERE key='machine_id'", [], |r| r.get(0))?)).unwrap();
    assert_eq!(v, "abc");
}

#[test]
fn base_que_no_es_sqlite_se_informa_como_dañada() {
    let tmp = Tmp::new();
    std::fs::write(tmp.path().join("lixbon.db"), vec![b'x'; 4096]).unwrap();
    match Store::open(tmp.path(), "t") {
        Err(StoreError::Corrupt { .. }) => {}
        other => panic!("se esperaba Corrupt, salió {other:?}"),
    }
    // El bloqueo se soltó al fallar: se puede reintentar.
    std::fs::remove_file(tmp.path().join("lixbon.db")).unwrap();
    Store::open(tmp.path(), "t").unwrap();
}

// ------------------------------------------------------------------ lock

#[test]
fn segunda_instancia_sobre_la_misma_carpeta_se_rechaza() {
    let tmp = Tmp::new();
    let first = Store::open(tmp.path(), "t").unwrap();
    match Store::open(tmp.path(), "t") {
        Err(StoreError::AlreadyRunning { .. }) => {}
        other => panic!("se esperaba AlreadyRunning, salió {other:?}"),
    }
    drop(first);
    Store::open(tmp.path(), "t").expect("al soltar el primero se puede abrir");
}

#[test]
fn el_bloqueo_se_libera_al_soltarlo_y_no_deja_basura_que_limpiar() {
    let tmp = Tmp::new();
    let path = tmp.path().join("x.lock");
    let a = InstanceLock::acquire(&path).unwrap();
    assert!(matches!(InstanceLock::acquire(&path), Err(StoreError::AlreadyRunning { .. })));
    drop(a);
    // El archivo sigue en disco (con un PID viejo): no importa, no es el bloqueo.
    assert!(path.exists());
    InstanceLock::acquire(&path).unwrap();
}

// ------------------------------------------------------------ migraciones

#[test]
fn base_mas_nueva_se_rechaza_sin_tocarla() {
    let tmp = Tmp::new();
    let db = tmp.path().join("lixbon.db");
    {
        let c = Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE futuro (x INTEGER); PRAGMA user_version = 99;").unwrap();
    }
    match Store::open(tmp.path(), "t") {
        Err(StoreError::DatabaseNewer { db_version: 99, binary_version }) => assert!(binary_version < 99),
        other => panic!("se esperaba DatabaseNewer, salió {other:?}"),
    }
    let c = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(count(&c, "PRAGMA user_version"), 99);
    assert_eq!(count(&c, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'schema_migrations'"), 0);
    assert!(!tmp.path().join("backups").exists(), "rechazar no genera copias");
}

#[test]
fn migracion_ya_aplicada_editada_se_detecta_por_checksum() {
    let tmp = Tmp::new();
    drop(Store::open_with(tmp.path(), &con_extras(&[Migration::new(2, "proyectos", M002_PROYECTOS)]), "t").unwrap());
    let editada = format!("{M002_PROYECTOS}\n-- retocada");
    match Store::open_with(tmp.path(), &con_extras(&[Migration::new(2, "proyectos", Box::leak(editada.into_boxed_str()))]), "t") {
        Err(StoreError::ChecksumMismatch { version: 2, .. }) => {}
        other => panic!("se esperaba ChecksumMismatch, salió {other:?}"),
    }
}

#[test]
fn el_checksum_no_depende_de_cr_lf_ni_lf() {
    let a = Migration::new(1, "x", "CREATE TABLE a (x);\r\nCREATE TABLE b (y);\r\n");
    let b = Migration::new(1, "x", "CREATE TABLE a (x);\nCREATE TABLE b (y);\n");
    assert_eq!(a.checksum(), b.checksum());
    assert_ne!(a.checksum(), Migration::new(1, "x", "otra cosa").checksum());
}

#[test]
fn migracion_aplicada_que_el_binario_no_conoce_se_rechaza() {
    let tmp = Tmp::new();
    let con_002 = con_extras(&[Migration::new(2, "proyectos", M002_PROYECTOS)]);
    drop(Store::open_with(tmp.path(), &con_002, "t").unwrap());
    // Este "binario" conoce 001 y una 003 distinta: la 002 aplicada le es ajena.
    let otra = con_extras(&[Migration::new(3, "eventos", M003_EVENTOS)]);
    match Store::open_with(tmp.path(), &otra, "t") {
        Err(StoreError::UnknownMigration { version: 2, .. }) => {}
        other => panic!("se esperaba UnknownMigration, salió {other:?}"),
    }
}

#[test]
fn migracion_pendiente_anterior_a_una_aplicada_se_rechaza() {
    let tmp = Tmp::new();
    drop(Store::open_with(tmp.path(), &con_extras(&[Migration::new(3, "eventos", M003_EVENTOS)]), "t").unwrap());
    // Otra rama añadió la 002 después de que la base ya tuviera la 003.
    let ambas = con_extras(&[Migration::new(2, "proyectos", M002_PROYECTOS), Migration::new(3, "eventos", M003_EVENTOS)]);
    match Store::open_with(tmp.path(), &ambas, "t") {
        Err(StoreError::OutOfOrderMigration { pending: 2, applied: 3 }) => {}
        other => panic!("se esperaba OutOfOrderMigration, salió {other:?}"),
    }
}

#[test]
fn lista_de_migraciones_invalida_se_rechaza() {
    let tmp = Tmp::new();
    let dup = vec![Migration::new(1, "a", "SELECT 1;"), Migration::new(1, "b", "SELECT 1;")];
    assert!(matches!(Store::open_with(tmp.path(), &dup, "t"), Err(StoreError::InvalidMigrationList(_))));
    let desorden = vec![Migration::new(2, "a", "SELECT 1;"), Migration::new(1, "b", "SELECT 1;")];
    assert!(matches!(Store::open_with(tmp.path(), &desorden, "t"), Err(StoreError::InvalidMigrationList(_))));
    let cero = vec![Migration::new(0, "a", "SELECT 1;")];
    assert!(matches!(Store::open_with(tmp.path(), &cero, "t"), Err(StoreError::InvalidMigrationList(_))));
}

#[test]
fn si_una_migracion_falla_se_deshace_toda_la_tanda() {
    let tmp = Tmp::new();
    // Fallo del SQL en la 002 (tabla duplicada): la 001 tampoco debe quedar.
    let mala = con_extras(&[Migration::new(2, "mala", "CREATE TABLE a (x); CREATE TABLE a (x);")]);
    match Store::open_with(tmp.path(), &mala, "t") {
        Err(StoreError::MigrationFailed { version: 2, .. }) => {}
        other => panic!("se esperaba MigrationFailed, salió {other:?}"),
    }
    let c = Connection::open_with_flags(tmp.path().join("lixbon.db"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(count(&c, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'"), 0, "no debe quedar ni la 001");
    assert_eq!(count(&c, "PRAGMA user_version"), 0);
    drop(c);
    // Corregida la lista, la base se migra con normalidad.
    let s = Store::open(tmp.path(), "t").unwrap();
    assert_eq!(s.migration_report().applied, vec![1]);
}

#[test]
fn una_migracion_que_cierra_la_transaccion_se_detecta() {
    let tmp = Tmp::new();
    let sucia = vec![Migration::new(1, "sucia", "CREATE TABLE a (x); COMMIT;")];
    match Store::open_with(tmp.path(), &sucia, "t") {
        Err(StoreError::MigrationFailed { version: 1, detail, .. }) => assert!(detail.contains("transacción")),
        other => panic!("se esperaba MigrationFailed, salió {other:?}"),
    }
}

#[test]
fn migrar_base_con_datos_hace_copia_previa_consistente() {
    let tmp = Tmp::new();
    {
        let mut s = Store::open(tmp.path(), "t").unwrap();
        s.save_legacy_state(0, r#"{"tasks":[1,2,3]}"#).unwrap();
        s.write(|tx| {
            tx.execute("INSERT INTO meta (key, value) VALUES ('k', 'v')", [])?;
            Ok(())
        })
        .unwrap();
    }
    let s = Store::open_with(tmp.path(), &con_extras(&[Migration::new(2, "proyectos", M002_PROYECTOS)]), "t").unwrap();
    let r = s.migration_report();
    assert_eq!((r.from_version, r.to_version), (1, 2));
    let copia = r.backup.clone().expect("había datos: debe haber copia previa");
    assert!(copia.starts_with(s.backup_dir()));
    assert!(copia.extension().is_some_and(|e| e == "db"));
    // La copia es la base ANTES de migrar: con los datos y sin la tabla nueva.
    let c = Connection::open_with_flags(&copia, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(count(&c, "SELECT COUNT(*) FROM legacy_state"), 1);
    assert_eq!(count(&c, "SELECT COUNT(*) FROM meta"), 1);
    assert_eq!(count(&c, "SELECT COUNT(*) FROM sqlite_master WHERE name = 'projects'"), 0);
    // Y la base viva sí tiene la 002.
    assert!(tabla_existe(&s, "projects"));
    // No quedan temporales.
    let temporales = std::fs::read_dir(s.backup_dir()).unwrap().filter(|e| e.as_ref().unwrap().path().to_string_lossy().ends_with(".tmp")).count();
    assert_eq!(temporales, 0);
}

#[test]
fn migracion_con_referencia_blanda_sin_fk() {
    let tmp = Tmp::new();
    let mut s = Store::open_with(
        tmp.path(),
        &con_extras(&[Migration::new(2, "proyectos", M002_PROYECTOS), Migration::new(3, "eventos", M003_EVENTOS)]),
        "t",
    )
    .unwrap();
    // events no declara ninguna FK; project_locations sí (real).
    let fks_events = s.read(|c| Ok(count(c, "SELECT COUNT(*) FROM pragma_foreign_key_list('events')"))).unwrap();
    let fks_loc = s.read(|c| Ok(count(c, "SELECT COUNT(*) FROM pragma_foreign_key_list('project_locations')"))).unwrap();
    assert_eq!((fks_events, fks_loc), (0, 1));

    // Un evento con project_id inexistente (o de un Project ya archivado) se acepta.
    s.write(|tx| {
        tx.execute(
            "INSERT INTO events (id, project_id, client_id, entity_kind, entity_id, at) VALUES ('e1', 'no-existe', 'c-revocado', 'task', 't1', 0)",
            [],
        )?;
        Ok(())
    })
    .unwrap();
    // La FK real sí se impone.
    let err = s
        .write(|tx| {
            tx.execute("INSERT INTO project_locations (id, project_id, path) VALUES ('l1', 'no-existe', '/x')", [])?;
            Ok(())
        })
        .unwrap_err();
    assert!(err.to_string().to_lowercase().contains("foreign key"), "{err}");
}

// ----------------------------------------------------------- transacciones

#[test]
fn write_hace_commit_si_ok_y_rollback_si_error() {
    let tmp = Tmp::new();
    let mut s = Store::open(tmp.path(), "t").unwrap();
    s.write(|tx| {
        tx.execute("INSERT INTO meta (key, value) VALUES ('a', '1')", [])?;
        Ok(())
    })
    .unwrap();
    let r: StoreResult<()> = s.write(|tx| {
        tx.execute("INSERT INTO meta (key, value) VALUES ('b', '2')", [])?;
        Err(StoreError::Backup("fallo a propósito".into()))
    });
    assert!(r.is_err());
    // Una violación de restricción a mitad también deshace lo anterior.
    let r: StoreResult<()> = s.write(|tx| {
        tx.execute("INSERT INTO meta (key, value) VALUES ('c', '3')", [])?;
        tx.execute("INSERT INTO meta (key, value) VALUES ('a', 'duplicada')", [])?;
        Ok(())
    });
    assert!(r.is_err());
    let claves: Vec<String> = s
        .read(|c| {
            let mut st = c.prepare("SELECT key FROM meta ORDER BY key")?;
            let v = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            Ok(v)
        })
        .unwrap();
    assert_eq!(claves, vec!["a".to_string()]);
}

#[test]
fn write_toma_el_bloqueo_de_escritura_de_entrada_begin_immediate() {
    let tmp = Tmp::new();
    let mut s = Store::open(tmp.path(), "t").unwrap();
    let db = s.db_path().to_path_buf();
    s.write(|_tx| {
        // Desde otra conexión: leer sí se puede (WAL)…
        let otra = Connection::open(&db).unwrap();
        otra.busy_timeout(std::time::Duration::from_millis(0)).unwrap();
        assert_eq!(count(&otra, "SELECT COUNT(*) FROM meta"), 0);
        // …pero abrir otra escritura falla ya en BEGIN IMMEDIATE: la nuestra ya la tiene.
        let e = otra.execute_batch("BEGIN IMMEDIATE").unwrap_err();
        assert!(StoreError::from(e).is_busy());
        Ok(())
    })
    .unwrap();
    // Terminada la nuestra, la otra conexión ya puede escribir.
    let otra = Connection::open(&db).unwrap();
    otra.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").unwrap();
}

// ----------------------------------------------------------------- backup

#[test]
fn backup_a_peticion_es_completo_aunque_haya_datos_solo_en_el_wal() {
    let tmp = Tmp::new();
    let mut s = Store::open(tmp.path(), "t").unwrap();
    s.save_legacy_state(0, r#"{"x":1}"#).unwrap();
    // El WAL aún no se ha vuelto a volcar al .db: una copia del archivo no lo vería.
    assert!(tmp.path().join("lixbon.db-wal").exists());
    let copia = s.backup("manual / prueba").unwrap();
    let nombre = copia.file_name().unwrap().to_string_lossy().into_owned();
    assert!(nombre.ends_with("manual---prueba.db"), "{nombre}");
    let c = Connection::open_with_flags(&copia, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let doc: String = c.query_row("SELECT doc FROM legacy_state WHERE id = 1", [], |r| r.get(0)).unwrap();
    assert_eq!(doc, r#"{"x":1}"#);
    // Dos copias seguidas no se pisan.
    let otra = s.backup("manual / prueba").unwrap();
    assert_ne!(copia, otra);
}

// ------------------------------------------------------------ legacy_state

#[test]
fn legacy_state_empieza_vacio_y_cada_guardado_sube_la_rev() {
    let tmp = Tmp::new();
    let mut s = Store::open(tmp.path(), "t").unwrap();
    assert_eq!(s.legacy_state().unwrap(), None);
    assert_eq!(s.save_legacy_state(0, r#"{"v":1}"#).unwrap(), 1);
    assert_eq!(s.save_legacy_state(1, r#"{"v":2}"#).unwrap(), 2);
    assert_eq!(s.save_legacy_state(2, r#"{"v":3}"#).unwrap(), 3);
    let st = s.legacy_state().unwrap().unwrap();
    assert_eq!((st.rev, st.doc_schema, st.doc.as_str()), (3, 0, r#"{"v":3}"#));
}

#[test]
fn legacy_state_detecta_conflictos_de_revision() {
    let tmp = Tmp::new();
    let mut s = Store::open(tmp.path(), "t").unwrap();
    // Actualizar algo que no existe.
    assert!(matches!(
        s.save_legacy_state(1, "{}"),
        Err(StoreError::RevConflict { expected: 1, actual: None })
    ));
    s.save_legacy_state(0, "{}").unwrap();
    s.save_legacy_state(1, r#"{"a":1}"#).unwrap();
    // Crear cuando ya existe.
    assert!(matches!(
        s.save_legacy_state(0, "{}"),
        Err(StoreError::RevConflict { expected: 0, actual: Some(2) })
    ));
    // Revisión obsoleta.
    assert!(matches!(
        s.save_legacy_state(1, r#"{"a":9}"#),
        Err(StoreError::RevConflict { expected: 1, actual: Some(2) })
    ));
    // Nada de lo rechazado se coló.
    assert_eq!(s.legacy_state().unwrap().unwrap().doc, r#"{"a":1}"#);
}

#[test]
fn legacy_state_rechaza_json_invalido_sin_perder_el_anterior() {
    let tmp = Tmp::new();
    let mut s = Store::open(tmp.path(), "t").unwrap();
    assert!(matches!(s.save_legacy_state(0, "{no es json"), Err(StoreError::InvalidDocument(_))));
    assert_eq!(s.legacy_state().unwrap(), None);
    s.save_legacy_state(0, r#"{"ok":true}"#).unwrap();
    assert!(matches!(s.save_legacy_state(1, "{roto"), Err(StoreError::InvalidDocument(_))));
    let st = s.legacy_state().unwrap().unwrap();
    assert_eq!((st.rev, st.doc.as_str()), (1, r#"{"ok":true}"#));
}

#[test]
fn legacy_state_sobrevive_a_cerrar_y_reabrir() {
    let tmp = Tmp::new();
    let doc = r#"{"tasks":[{"id":"t1","título":"ñandú 🦤"}]}"#;
    {
        let mut s = Store::open(tmp.path(), "t").unwrap();
        s.save_legacy_state(0, doc).unwrap();
    }
    let s = Store::open(tmp.path(), "t").unwrap();
    let st = s.legacy_state().unwrap().unwrap();
    assert_eq!((st.rev, st.doc.as_str()), (1, doc));
}

#[test]
fn solo_hay_una_fila_de_legacy_state() {
    let tmp = Tmp::new();
    let mut s = Store::open(tmp.path(), "t").unwrap();
    s.save_legacy_state(0, "{}").unwrap();
    let r = s.write(|tx| {
        tx.execute("INSERT INTO legacy_state (id, rev, doc, updated_at) VALUES (2, 1, '{}', 0)", [])?;
        Ok(())
    });
    assert!(r.is_err(), "CHECK (id = 1)");
}

// ---- permisos de propietario (base y copias llevan el estado completo) ----

/// Quién puede acceder a `path` según el sistema; `None` si no se pudo consultar.
#[cfg(windows)]
fn acl(path: &Path) -> Option<String> {
    let out = std::process::Command::new("icacls").arg(path).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(windows)]
fn solo_el_propietario(path: &Path) {
    // Sin depender del idioma de Windows: debe quedar una única entrada (`cuenta:(permisos)`),
    // la del propietario, y ninguna heredada.
    let acl = acl(path).expect("icacls");
    assert_eq!(acl.matches(":(").count(), 1, "{} debe tener un solo acceso:\n{acl}", path.display());
    assert!(!acl.contains("(I)"), "{} no debe heredar permisos:\n{acl}", path.display());
    let user = std::env::var("USERNAME").unwrap();
    assert!(acl.to_lowercase().contains(&user.to_lowercase()), "el propietario conserva el acceso:\n{acl}");
}

#[cfg(unix)]
fn modo(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn la_base_y_sus_archivos_laterales_son_privados() {
    let tmp = Tmp::new();
    let mut s = Store::open(tmp.path(), "t").unwrap();
    s.save_legacy_state(0, "{}").unwrap(); // fuerza -wal y -shm
    let db = s.db_path().to_path_buf();
    #[cfg(unix)]
    {
        assert_eq!(modo(&db), 0o600);
        for ext in ["-wal", "-shm"] {
            let side = tmp.path().join(format!("lixbon.db{ext}"));
            assert!(side.exists(), "{ext} existe con la base abierta");
            assert_eq!(modo(&side), 0o600, "{ext}");
        }
    }
    #[cfg(windows)]
    {
        solo_el_propietario(&db);
        for ext in ["-wal", "-shm"] {
            let side = tmp.path().join(format!("lixbon.db{ext}"));
            assert!(side.exists(), "{ext} existe con la base abierta");
            solo_el_propietario(&side);
        }
    }
}

#[test]
fn las_copias_y_su_carpeta_son_privadas() {
    let tmp = Tmp::new();
    let s = Store::open(tmp.path(), "t").unwrap();
    let copia = s.backup("permisos").unwrap();
    #[cfg(unix)]
    {
        assert_eq!(modo(s.backup_dir()), 0o700);
        assert_eq!(modo(&copia), 0o600);
    }
    #[cfg(windows)]
    {
        solo_el_propietario(s.backup_dir());
        solo_el_propietario(&copia);
    }
}

#[test]
fn restringir_la_base_no_toca_la_carpeta_compartida() {
    // La carpeta del almacén la comparte el resto del Core (state.json, orch.json...).
    let tmp = Tmp::new();
    let antes = std::fs::metadata(tmp.path()).unwrap().permissions();
    let _s = Store::open(tmp.path(), "t").unwrap();
    assert_eq!(std::fs::metadata(tmp.path()).unwrap().permissions(), antes);
    #[cfg(windows)]
    {
        let acl = acl(tmp.path()).expect("icacls");
        assert!(!acl.is_empty());
        assert!(acl.contains("(I)"), "la carpeta sigue heredando permisos:\n{acl}");
    }
}
