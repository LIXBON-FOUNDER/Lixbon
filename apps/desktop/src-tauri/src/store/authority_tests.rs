//! Pruebas del cambio de autoridad en el almacén (C2b): la valla (migración 002),
//! la promoción transaccional, la escritura autoritativa y las copias verificadas.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::authority::{new_uuid, sha256_hex};
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-auth-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

/// Lo que ven C1 y C2a: solo la migración 001.
fn lista_de_c1() -> Vec<Migration> {
    embedded().into_iter().filter(|m| m.version < FENCE_VERSION).collect()
}

fn lock_de(dir: &Path) -> InstanceLock {
    InstanceLock::acquire(&lock_path(dir)).unwrap()
}

/// Abre como lo hace el arranque de C2b (con la valla sin aplicar todavía).
fn abre_arranque(dir: &Path, lock: &InstanceLock) -> Store {
    Store::open_boot_under_lock(dir, lock, &embedded(), "t").unwrap()
}

fn plan(boot: i64, hash: &str, bytes: u64) -> PromotionPlan {
    PromotionPlan { promotion_id: new_uuid(), source_hash: hash.into(), source_bytes: bytes, sqlite_bootstrap_rev: boot, sqlite_target_rev: boot + 1 }
}

fn bootstrap_con_fila(s: &mut Store, rev: i64, doc: &str) {
    s.write(|tx| {
        tx.execute("INSERT INTO legacy_state (id, rev, doc_schema, doc, updated_at) VALUES (1, ?1, 0, ?2, 1)", rusqlite::params![rev, doc])?;
        tx.execute("INSERT INTO meta (key, value) VALUES ('legacy_import_mode', 'bootstrap_snapshot')", [])?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn la_valla_es_la_migracion_002_y_se_embebe() {
    let todas = embedded();
    assert_eq!(todas.iter().map(|m| m.version).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(todas[1].name, "authority_fence");
    assert_eq!(FENCE_VERSION, 2);
}

#[test]
fn abrir_para_el_arranque_no_publica_la_valla() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let s = abre_arranque(tmp.path(), &lock);
    assert_eq!(s.schema_version().unwrap(), 1, "abrir NO aplica la 002");
    assert!(!s.is_fenced().unwrap());
    assert_eq!(s.meta("authority_fence").unwrap(), None);
}

#[test]
fn aplicar_la_valla_sube_la_version_y_es_idempotente() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    let r = s.apply_fence(&embedded(), "t").unwrap();
    assert_eq!((r.from_version, r.to_version, r.applied.clone()), (1, 2, vec![2]));
    assert!(s.is_fenced().unwrap());
    assert_eq!(s.schema_version().unwrap(), 2);
    assert_eq!(s.meta("authority_fence").unwrap(), Some("c2b".into()));
    let user_version: i64 = s.read(|c| Ok(c.query_row("PRAGMA user_version", [], |r| r.get(0))?)).unwrap();
    assert_eq!(user_version, 2);
    let otra = s.apply_fence(&embedded(), "t").unwrap();
    assert!(otra.applied.is_empty(), "repetirla no hace nada");
}

#[test]
fn una_base_ya_cruzada_se_reabre_con_la_lista_completa() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    {
        let mut s = abre_arranque(tmp.path(), &lock);
        s.apply_fence(&embedded(), "t").unwrap();
    }
    let s = abre_arranque(tmp.path(), &lock);
    assert!(s.is_fenced().unwrap());
}

#[test]
fn c1_y_c2a_no_pueden_abrir_una_base_con_la_valla() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    {
        let mut s = abre_arranque(tmp.path(), &lock);
        s.apply_fence(&embedded(), "t").unwrap();
    }
    // Es exactamente la llamada de `Core::init` de C1/C2a: `embedded()` de entonces = [001].
    match Store::open_under_lock(tmp.path(), &lock, &lista_de_c1(), "c2a") {
        Err(StoreError::DatabaseNewer { db_version: 2, binary_version: 1 }) => {}
        other => panic!("se esperaba DatabaseNewer(2 > 1), salió {other:?}"),
    }
}

#[test]
fn la_valla_solo_con_user_version_basta_para_frenar_a_c1_pero_no_se_usa() {
    // Documenta por qué hace falta la migración real: un `user_version` suelto
    // frenaría también a C2b, cuyo máximo conocido sería 1.
    let tmp = Tmp::new();
    {
        let s = Store::open_with(tmp.path(), &lista_de_c1(), "t").unwrap();
        s.read(|c| Ok(c.pragma_update(None, "user_version", 2)?)).unwrap();
    }
    assert!(matches!(Store::open_with(tmp.path(), &lista_de_c1(), "t"), Err(StoreError::DatabaseNewer { .. })));
}

#[test]
fn si_falla_aplicar_la_valla_la_base_queda_sin_cruzar() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    let mala = vec![embedded()[0], Migration::new(2, "authority_fence", "INSERT INTO tabla_que_no_existe VALUES (1);")];
    assert!(matches!(s.apply_fence(&mala, "t"), Err(StoreError::MigrationFailed { version: 2, .. })));
    assert_eq!(s.schema_version().unwrap(), 1, "la tanda se deshizo");
    assert!(!s.is_fenced().unwrap());
    // Y se puede volver a intentar con la valla buena.
    s.apply_fence(&embedded(), "t").unwrap();
    assert!(s.is_fenced().unwrap());
}

#[test]
fn las_migraciones_posteriores_a_la_valla_no_se_aplican_antes_de_cruzarla() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut todas = embedded();
    todas.push(Migration::new(3, "proyectos", "CREATE TABLE projects (id TEXT PRIMARY KEY) STRICT;"));
    let mut s = Store::open_boot_under_lock(tmp.path(), &lock, &todas, "t").unwrap();
    assert_eq!(s.schema_version().unwrap(), 1);
    s.apply_fence(&todas, "t").unwrap();
    assert_eq!(s.schema_version().unwrap(), 2, "apply_fence llega hasta la valla y no más");
    drop(s);
    let s = Store::open_boot_under_lock(tmp.path(), &lock, &todas, "t").unwrap();
    assert_eq!(s.schema_version().unwrap(), 3, "ya cruzada, la siguiente apertura aplica el resto");
}

#[test]
fn ensure_db_id_crea_una_vez_y_no_cambia() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    let a = s.ensure_db_id().unwrap();
    let b = s.ensure_db_id().unwrap();
    assert_eq!(a, b);
    assert_eq!(a.len(), 36);
    assert_ne!(new_uuid(), new_uuid());
}

#[test]
fn promocionar_con_bootstrap_rev_10_produce_rev_11_sin_relacion_con_el_legado() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    bootstrap_con_fila(&mut s, 10, "{\"snapshot\":true}");
    let nuevo = "{\"seq\":99,\"mucho_mas_reciente\":true}";
    let p = plan(10, &sha256_hex(nuevo.as_bytes()), nuevo.len() as u64);
    assert_eq!(s.promote_to_authoritative(&p, nuevo).unwrap(), 11);
    let fila = s.legacy_state().unwrap().unwrap();
    assert_eq!((fila.rev, fila.doc.as_str()), (11, nuevo), "la instantánea se sustituye por el legado");
    let f = s.authority_facts().unwrap();
    assert_eq!(f.mode.as_deref(), Some(MODE_SQLITE_AUTHORITATIVE));
    let a = f.auth.unwrap();
    assert_eq!((a.sqlite_bootstrap_rev, a.sqlite_target_rev, a.promotion_id), (10, 11, p.promotion_id));
    assert_eq!((a.source_hash, a.source_bytes), (p.source_hash, nuevo.len() as u64));
}

#[test]
fn promocionar_una_instalacion_nueva_crea_la_fila_autoritativa() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    assert_eq!(s.promote_to_authoritative(&plan(0, "none", 0), "{}").unwrap(), 1);
    let f = s.authority_facts().unwrap();
    assert_eq!((f.row_rev, f.mode.as_deref()), (Some(1), Some(MODE_SQLITE_AUTHORITATIVE)));
}

#[test]
fn la_promocion_solo_ocurre_una_vez() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    bootstrap_con_fila(&mut s, 1, "{}");
    s.promote_to_authoritative(&plan(1, "h", 2), "{\"a\":1}").unwrap();
    let antes = s.legacy_state().unwrap().unwrap();
    let r = s.promote_to_authoritative(&plan(2, "h2", 2), "{\"a\":2}");
    assert!(matches!(r, Err(StoreError::PromotionConflict(_))), "{r:?}");
    assert_eq!(s.legacy_state().unwrap().unwrap(), antes, "no cambió nada");
}

#[test]
fn promocionar_con_rev_equivocada_deshace_todo() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    bootstrap_con_fila(&mut s, 10, "{\"snap\":1}");
    let r = s.promote_to_authoritative(&plan(1, "h", 2), "{\"a\":1}");
    assert!(matches!(r, Err(StoreError::RevConflict { expected: 1, actual: Some(10) })), "{r:?}");
    let f = s.authority_facts().unwrap();
    assert_eq!((f.row_rev, f.mode.as_deref(), f.auth.is_none()), (Some(10), Some("bootstrap_snapshot"), true));
    assert_eq!(s.legacy_state().unwrap().unwrap().doc, "{\"snap\":1}");
}

#[test]
fn promocionar_con_documento_invalido_o_target_incoherente_no_toca_nada() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    bootstrap_con_fila(&mut s, 1, "{\"snap\":1}");
    assert!(matches!(s.promote_to_authoritative(&plan(1, "h", 1), "esto no es json"), Err(StoreError::InvalidDocument(_))));
    let mut mala = plan(1, "h", 1);
    mala.sqlite_target_rev = 5;
    assert!(matches!(s.promote_to_authoritative(&mala, "{}"), Err(StoreError::PromotionConflict(_))));
    let f = s.authority_facts().unwrap();
    assert_eq!((f.row_rev, f.mode.as_deref()), (Some(1), Some("bootstrap_snapshot")));
    assert_eq!(s.legacy_state().unwrap().unwrap().doc, "{\"snap\":1}");
}

#[test]
fn sin_fila_pero_con_rev_previa_distinta_de_cero_es_un_conflicto() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    let r = s.promote_to_authoritative(&plan(3, "h", 1), "{}");
    assert!(matches!(r, Err(StoreError::RevConflict { expected: 3, actual: None })), "{r:?}");
}

#[test]
fn commit_autoritativo_exige_modo_autoritativo_y_rev_exacta() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    bootstrap_con_fila(&mut s, 1, "{}");
    assert!(matches!(s.commit_authoritative(1, "{\"a\":1}"), Err(StoreError::NotAuthoritative)));
    s.promote_to_authoritative(&plan(1, "h", 2), "{\"a\":1}").unwrap();
    assert_eq!(s.commit_authoritative(2, "{\"a\":2}").unwrap(), 3);
    assert_eq!(s.commit_authoritative(3, "{\"a\":3}").unwrap(), 4);
    let r = s.commit_authoritative(3, "{\"a\":9}");
    assert!(matches!(r, Err(StoreError::RevConflict { expected: 3, actual: Some(4) })), "{r:?}");
    assert_eq!(s.legacy_state().unwrap().unwrap().doc, "{\"a\":3}");
    assert!(matches!(s.commit_authoritative(4, "no json"), Err(StoreError::InvalidDocument(_))));
    assert_eq!(s.legacy_state().unwrap().unwrap().rev, 4, "el rollback no consume rev");
}

#[test]
fn una_copia_fiel_se_verifica_y_se_puede_restaurar() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    s.ensure_db_id().unwrap();
    bootstrap_con_fila(&mut s, 1, "{\"estado\":\"previo\"}");
    let copia = s.backup("pre-authority").unwrap();
    s.verify_backup(&copia).expect("la copia recién hecha es fiel");

    // Prueba de restauración: la copia, puesta como base de otra carpeta, abre como Store completo.
    let otra = Tmp::new();
    std::fs::copy(&copia, otra.path().join("lixbon.db")).unwrap();
    let restaurado = Store::open_with(otra.path(), &lista_de_c1(), "t").unwrap();
    assert_eq!(restaurado.legacy_state().unwrap().unwrap().doc, "{\"estado\":\"previo\"}");
    assert_eq!(restaurado.meta("legacy_import_mode").unwrap(), Some("bootstrap_snapshot".into()));
    restaurado.integrity_check().unwrap();
}

#[test]
fn una_copia_que_ya_no_refleja_la_base_no_se_verifica() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_arranque(tmp.path(), &lock);
    bootstrap_con_fila(&mut s, 1, "{\"a\":1}");
    let copia = s.backup("x").unwrap();
    s.write(|tx| {
        tx.execute("UPDATE legacy_state SET rev = 2, doc = '{\"a\":2}' WHERE id = 1", [])?;
        Ok(())
    })
    .unwrap();
    assert!(matches!(s.verify_backup(&copia), Err(StoreError::Backup(m)) if m.contains("no es fiel")));
    // Distinta por migraciones.
    let copia2 = s.backup("y").unwrap();
    s.apply_fence(&embedded(), "t").unwrap();
    assert!(matches!(s.verify_backup(&copia2), Err(StoreError::Backup(m)) if m.contains("migraciones")));
}

#[test]
fn una_copia_corrupta_no_se_verifica() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let s = abre_arranque(tmp.path(), &lock);
    let copia = s.backup("c").unwrap();
    std::fs::write(&copia, b"esto no es una base").unwrap();
    assert!(matches!(s.verify_backup(&copia), Err(StoreError::Backup(_))));
}

#[test]
fn clasificacion_central_de_errores_transitorios_y_estructurales() {
    use std::io::{Error, ErrorKind};
    let io = |k| StoreError::Io { context: "x".into(), source: Error::from(k) };
    assert!(io(ErrorKind::Interrupted).is_transient() && io(ErrorKind::TimedOut).is_transient() && io(ErrorKind::PermissionDenied).is_transient());
    assert!(StoreError::Io { context: "x".into(), source: Error::from_raw_os_error(32) }.is_transient(), "violación de uso compartido en Windows");
    assert!(!io(ErrorKind::NotFound).is_transient());
    let busy = StoreError::Sqlite(rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY), None));
    assert!(busy.is_transient());
    for estructural in [
        StoreError::DatabaseNewer { db_version: 2, binary_version: 1 },
        StoreError::ChecksumMismatch { version: 1, name: "x".into() },
        StoreError::UnknownMigration { version: 9, name: "x".into() },
        StoreError::OutOfOrderMigration { pending: 1, applied: 2 },
        StoreError::Corrupt { path: PathBuf::new(), detail: "d".into() },
        StoreError::RevConflict { expected: 1, actual: None },
        StoreError::InvalidDocument("x".into()),
        StoreError::NotAuthoritative,
        StoreError::PromotionConflict("x".into()),
    ] {
        assert!(!estructural.is_transient(), "{estructural:?} no se reintenta");
    }
}
