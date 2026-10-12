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

/// Como `abre_arranque` y con la valla ya aplicada: lo que el arranque tiene justo antes de promocionar.
fn abre_cruzada(dir: &Path, lock: &InstanceLock) -> Store {
    let mut s = abre_arranque(dir, lock);
    s.apply_fence(&embedded(), "t").unwrap();
    s.ensure_db_id().unwrap();
    s
}

/// Un plan válido: `hash` es una etiqueta de prueba que se convierte en un SHA-256 real
/// (salvo `"none"`), y un legado real nunca tiene 0 bytes.
fn plan(boot: i64, hash: &str, bytes: u64) -> PromotionPlan {
    let (hash, bytes) = if hash == "none" { ("none".to_string(), 0) } else { (sha256_hex(hash.as_bytes()), bytes.max(1)) };
    PromotionPlan::new(new_uuid(), hash, bytes, boot).unwrap()
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
fn las_migraciones_posteriores_a_la_valla_solo_se_aplican_con_la_base_autoritativa() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut todas = embedded();
    todas.push(Migration::new(3, "proyectos", "CREATE TABLE projects (id TEXT PRIMARY KEY) STRICT;"));
    let abre = |lock: &InstanceLock| Store::open_boot_under_lock(tmp.path(), lock, &todas, "t").unwrap();

    // Antes de la valla: solo las anteriores a ella.
    let mut s = abre(&lock);
    assert_eq!(s.schema_version().unwrap(), 1);
    s.apply_fence(&todas, "t").unwrap();
    assert_eq!(s.schema_version().unwrap(), 2, "apply_fence llega hasta la valla y no más");
    bootstrap_con_fila(&mut s, 1, "{}");
    drop(s);

    // FENCED (caída antes de `promoting`, o `promoting` sin COMMIT): el reinicio NO aplica la 003.
    for _ in 0..2 {
        let s = abre(&lock);
        assert_eq!(s.schema_version().unwrap(), 2, "FENCED todavía no es autoritativa: máximo la 002");
        assert!(s.read(|c| Ok(c.prepare("SELECT 1 FROM projects").is_err())).unwrap(), "la tabla de la 003 no existe");
    }

    // Ya autoritativa: la siguiente apertura aplica el resto.
    let mut s = abre(&lock);
    s.ensure_db_id().unwrap();
    s.promote_to_authoritative(&plan(1, "h", 2), "{\"a\":1}").unwrap();
    drop(s);
    let s = abre(&lock);
    assert_eq!(s.schema_version().unwrap(), 3, "autoritativa: se aplica lo posterior a la valla");
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
    let mut s = abre_cruzada(tmp.path(), &lock);
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
    let mut s = abre_cruzada(tmp.path(), &lock);
    assert_eq!(s.promote_to_authoritative(&plan(0, "none", 0), "{}").unwrap(), 1);
    let f = s.authority_facts().unwrap();
    assert_eq!((f.row_rev, f.mode.as_deref()), (Some(1), Some(MODE_SQLITE_AUTHORITATIVE)));
}

#[test]
fn la_promocion_solo_ocurre_una_vez() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_cruzada(tmp.path(), &lock);
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
    let mut s = abre_cruzada(tmp.path(), &lock);
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
    let mut s = abre_cruzada(tmp.path(), &lock);
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
    let mut s = abre_cruzada(tmp.path(), &lock);
    let r = s.promote_to_authoritative(&plan(3, "h", 1), "{}");
    assert!(matches!(r, Err(StoreError::RevConflict { expected: 3, actual: None })), "{r:?}");
}

#[test]
fn commit_autoritativo_exige_modo_autoritativo_y_rev_exacta() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_cruzada(tmp.path(), &lock);
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
fn promote_to_authoritative_sin_valla_es_un_error_y_cero_cambios() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    // Con fila de bootstrap...
    let mut s = abre_arranque(tmp.path(), &lock);
    bootstrap_con_fila(&mut s, 10, "{\"snap\":1}");
    let antes = (s.authority_facts().unwrap(), s.legacy_state().unwrap().unwrap(), s.schema_version().unwrap());
    let r = s.promote_to_authoritative(&plan(10, "h", 2), "{\"a\":1}");
    assert!(matches!(r, Err(StoreError::NotFenced)), "{r:?}");
    assert_eq!((s.authority_facts().unwrap(), s.legacy_state().unwrap().unwrap(), s.schema_version().unwrap()), antes, "cero cambios");
    assert_eq!(s.meta("legacy_authority_promotion_id").unwrap(), None);
    assert!(!s.is_fenced().unwrap(), "y la promoción no aplica la valla por su cuenta");
    // ...y en una instalación nueva (sin fila): no se crea nada.
    let nueva = Tmp::new();
    let lock2 = lock_de(nueva.path());
    let mut n = abre_arranque(nueva.path(), &lock2);
    assert!(matches!(n.promote_to_authoritative(&plan(0, "none", 0), "{}"), Err(StoreError::NotFenced)));
    assert_eq!(n.legacy_state().unwrap(), None, "no se creó la fila");
    assert_eq!(n.meta("legacy_import_mode").unwrap(), None);
    // Con la valla puesta, la misma promoción sí procede.
    n.apply_fence(&embedded(), "t").unwrap();
    n.ensure_db_id().unwrap();
    assert_eq!(n.promote_to_authoritative(&plan(0, "none", 0), "{}").unwrap(), 1);
}

#[test]
fn las_revisiones_fuera_de_rango_fallan_cerrado_sin_overflow() {
    // PromotionPlan::new
    assert!(matches!(PromotionPlan::new("p".into(), "none".into(), 0, i64::MAX), Err(StoreError::RevOutOfRange { rev: i64::MAX })));
    assert!(matches!(PromotionPlan::new("p".into(), "none".into(), 0, -1), Err(StoreError::RevOutOfRange { rev: -1 })));
    assert_eq!(PromotionPlan::new("p".into(), "none".into(), 0, i64::MAX - 1).unwrap().sqlite_target_rev, i64::MAX);

    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_cruzada(tmp.path(), &lock);
    bootstrap_con_fila(&mut s, 1, "{}");
    // Un plan escrito a mano con target envuelto no se acepta.
    let torcido = PromotionPlan { promotion_id: "p".into(), source_hash: "none".into(), source_bytes: 0, sqlite_bootstrap_rev: i64::MAX, sqlite_target_rev: i64::MIN };
    assert!(matches!(s.promote_to_authoritative(&torcido, "{}"), Err(StoreError::RevOutOfRange { .. })));
    assert_eq!(s.legacy_state().unwrap().unwrap().rev, 1);

    // commit_authoritative con la fila en i64::MAX: no se envuelve ni hace panic ni escribe.
    s.promote_to_authoritative(&plan(1, "h", 2), "{\"a\":1}").unwrap();
    s.write(|tx| {
        tx.execute("UPDATE legacy_state SET rev = ?1", [i64::MAX])?;
        Ok(())
    })
    .unwrap();
    let r = s.commit_authoritative(i64::MAX, "{\"a\":2}");
    assert!(matches!(r, Err(StoreError::RevOutOfRange { rev: i64::MAX })), "{r:?}");
    let fila = s.legacy_state().unwrap().unwrap();
    assert_eq!((fila.rev, fila.doc.as_str()), (i64::MAX, "{\"a\":1}"));
    assert!(!StoreError::RevOutOfRange { rev: 1 }.is_transient() && !StoreError::NotFenced.is_transient());
}

#[test]
fn metadata_de_autoridad_incoherente_no_se_da_por_buena() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_cruzada(tmp.path(), &lock);
    bootstrap_con_fila(&mut s, 1, "{}");
    s.promote_to_authoritative(&plan(1, &sha256_hex(b"{}"), 2), "{}").unwrap();
    assert!(s.authority_facts().unwrap().auth.is_some(), "la promoción normal es coherente");
    let toca = |s: &mut Store, k: &str, v: &str| {
        s.write(|tx| {
            tx.execute("UPDATE meta SET value = ?2 WHERE key = ?1", rusqlite::params![k, v])?;
            Ok(())
        })
        .unwrap()
    };
    let bueno = s.authority_facts().unwrap().auth.unwrap();
    // target != bootstrap + 1
    toca(&mut s, "legacy_authority_sqlite_target_rev", "9");
    assert!(s.authority_facts().unwrap().auth.is_none());
    toca(&mut s, "legacy_authority_sqlite_target_rev", &bueno.sqlite_target_rev.to_string());
    assert!(s.authority_facts().unwrap().auth.is_some());
    // bootstrap = i64::MAX (envolvería)
    toca(&mut s, "legacy_authority_sqlite_bootstrap_rev", &i64::MAX.to_string());
    toca(&mut s, "legacy_authority_sqlite_target_rev", &i64::MIN.to_string());
    assert!(s.authority_facts().unwrap().auth.is_none());
    toca(&mut s, "legacy_authority_sqlite_bootstrap_rev", &bueno.sqlite_bootstrap_rev.to_string());
    toca(&mut s, "legacy_authority_sqlite_target_rev", &bueno.sqlite_target_rev.to_string());
    // «sin legado» con bytes
    toca(&mut s, "legacy_authority_source_hash", "none");
    assert!(s.authority_facts().unwrap().auth.is_none(), "none => source_bytes == 0");
    toca(&mut s, "legacy_authority_source_bytes", "0");
    assert!(s.authority_facts().unwrap().auth.is_some());
    toca(&mut s, "legacy_authority_promotion_id", "");
    assert!(s.authority_facts().unwrap().auth.is_none(), "promotion_id vacío");
}

/// Una base cruzada, promovida de verdad (registro de autoridad completo y válido).
fn promovida(dir: &Path, lock: &InstanceLock) -> Store {
    let mut s = abre_cruzada(dir, lock);
    bootstrap_con_fila(&mut s, 1, "{}");
    s.promote_to_authoritative(&plan(1, "legado", 2), "{\"a\":1}").unwrap();
    assert!(s.authority_facts().unwrap().authority_valid(), "la promoción normal deja un registro válido");
    s
}

fn toca_meta(s: &mut Store, k: &str, v: &str) {
    s.write(|tx| {
        tx.execute("UPDATE meta SET value = ?2 WHERE key = ?1", rusqlite::params![k, v])?;
        Ok(())
    })
    .unwrap()
}

#[test]
fn la_identidad_de_la_promocion_tiene_una_unica_validacion() {
    let hash = sha256_hex(b"x");
    let ok = |id: &str, h: &str, b: u64, boot: i64, target: i64| check_promotion_identity(id, h, b, boot, target);
    assert!(ok("p", &hash, 10, 0, 1).is_ok() && ok("p", "none", 0, 4, 5).is_ok());
    assert!(ok("", &hash, 10, 0, 1).is_err(), "promotion_id vacío");
    assert!(ok("p", "basura", 10, 0, 1).is_err(), "hash que no es SHA-256");
    assert!(ok("p", &hash[..63], 10, 0, 1).is_err() && ok("p", &format!("{hash}0"), 10, 0, 1).is_err(), "longitud");
    assert!(ok("p", &"g".repeat(64), 10, 0, 1).is_err(), "no hexadecimal");
    assert!(ok("p", &hash, 0, 0, 1).is_err(), "hash real con 0 bytes");
    assert!(ok("p", "none", 3, 0, 1).is_err(), "none con bytes");
    assert!(ok("p", &hash, 10, -1, 0).is_err() && ok("p", &hash, 10, 0, 2).is_err() && ok("p", &hash, 10, i64::MAX, i64::MIN).is_err());
}

#[test]
fn el_store_no_fabrica_una_autoridad_que_el_lector_rechazaria() {
    // PromotionPlan::new
    assert!(matches!(PromotionPlan::new("".into(), "none".into(), 0, 0), Err(StoreError::PromotionConflict(_))));
    assert!(matches!(PromotionPlan::new("p".into(), "basura".into(), 5, 0), Err(StoreError::PromotionConflict(_))));
    assert!(matches!(PromotionPlan::new("p".into(), sha256_hex(b"x"), 0, 0), Err(StoreError::PromotionConflict(_))));
    // promote_to_authoritative con un plan armado a mano: cero cambios.
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = abre_cruzada(tmp.path(), &lock);
    bootstrap_con_fila(&mut s, 1, "{\"snap\":1}");
    let antes = (s.authority_facts().unwrap(), s.legacy_state().unwrap().unwrap());
    for (id, hash, bytes) in [("", sha256_hex(b"x"), 5), ("p", "basura".to_string(), 5), ("p", sha256_hex(b"x"), 0), ("p", "none".to_string(), 7)] {
        let torcido = PromotionPlan { promotion_id: id.into(), source_hash: hash, source_bytes: bytes, sqlite_bootstrap_rev: 1, sqlite_target_rev: 2 };
        let r = s.promote_to_authoritative(&torcido, "{\"a\":1}");
        assert!(matches!(r, Err(StoreError::PromotionConflict(_))), "{torcido:?}: {r:?}");
        assert_eq!((s.authority_facts().unwrap(), s.legacy_state().unwrap().unwrap()), antes, "cero cambios");
    }
    // Sin db_id tampoco: authority_valid lo exigiría después.
    let nueva = Tmp::new();
    let lock2 = lock_de(nueva.path());
    let mut sin_id = abre_arranque(nueva.path(), &lock2);
    sin_id.apply_fence(&embedded(), "t").unwrap();
    bootstrap_con_fila(&mut sin_id, 1, "{}");
    let r = sin_id.promote_to_authoritative(&plan(1, "x", 1), "{}");
    assert!(matches!(r, Err(StoreError::PromotionConflict(m)) if m.contains("db_id")));
    assert_eq!(sin_id.authority_facts().unwrap().mode.as_deref(), Some("bootstrap_snapshot"));
}

#[test]
fn metadata_de_autoridad_con_identidad_invalida_no_es_autoridad() {
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    let mut s = promovida(tmp.path(), &lock);
    let bueno = s.authority_facts().unwrap().auth.unwrap();
    let restaura = |s: &mut Store| {
        toca_meta(s, "legacy_authority_promotion_id", &bueno.promotion_id);
        toca_meta(s, "legacy_authority_source_hash", &bueno.source_hash);
        toca_meta(s, "legacy_authority_source_bytes", &bueno.source_bytes.to_string());
        assert!(s.authority_facts().unwrap().authority_valid());
    };
    // 1. source_hash inválido
    toca_meta(&mut s, "legacy_authority_source_hash", "basura");
    let f = s.authority_facts().unwrap();
    assert!(f.auth.is_none() && !f.authority_valid(), "hash inválido");
    restaura(&mut s);
    // 2. promotion_id vacío
    toca_meta(&mut s, "legacy_authority_promotion_id", "");
    assert!(!s.authority_facts().unwrap().authority_valid(), "promotion_id vacío");
    restaura(&mut s);
    // 3. hash real con source_bytes = 0
    toca_meta(&mut s, "legacy_authority_source_bytes", "0");
    assert!(!s.authority_facts().unwrap().authority_valid(), "hash real con 0 bytes");
    restaura(&mut s);
    // 4. db_id vacío o ausente; modo distinto; fila por debajo del target
    toca_meta(&mut s, "db_id", "");
    assert!(!s.authority_facts().unwrap().authority_valid(), "db_id vacío");
    s.write(|tx| {
        tx.execute("DELETE FROM meta WHERE key = 'db_id'", [])?;
        Ok(())
    })
    .unwrap();
    assert!(!s.authority_facts().unwrap().authority_valid(), "db_id ausente");
}

/// La 003 ficticia de las pruebas de apertura.
fn con_la_003() -> Vec<Migration> {
    let mut todas = embedded();
    todas.push(Migration::new(3, "proyectos", "CREATE TABLE projects (id TEXT PRIMARY KEY) STRICT;"));
    todas
}

#[test]
fn con_el_modo_autoritativo_pero_la_metadata_corrupta_la_apertura_se_queda_en_la_002() {
    let todas = con_la_003();
    for (nombre, rompe) in [
        ("source_hash inválido", ("legacy_authority_source_hash", "basura")),
        ("promotion_id vacío", ("legacy_authority_promotion_id", "")),
        ("hash real con 0 bytes", ("legacy_authority_source_bytes", "0")),
        ("target incoherente", ("legacy_authority_sqlite_target_rev", "9")),
        ("db_id vacío", ("db_id", "")),
    ] {
        let tmp = Tmp::new();
        let lock = lock_de(tmp.path());
        {
            let mut s = promovida(tmp.path(), &lock);
            toca_meta(&mut s, rompe.0, rompe.1);
            assert_eq!(s.authority_facts().unwrap().mode.as_deref(), Some(MODE_SQLITE_AUTHORITATIVE), "{nombre}: el modo sigue siendo autoritativo");
        }
        let s = Store::open_boot_under_lock(tmp.path(), &lock, &todas, "t").unwrap();
        assert_eq!(s.schema_version().unwrap(), 2, "{nombre}: máximo la 002");
        assert!(s.read(|c| Ok(c.prepare("SELECT 1 FROM projects").is_err())).unwrap(), "{nombre}: no se creó la tabla de la 003");
        assert!(!s.authority_facts().unwrap().authority_valid());
    }
    // Metadata incompleta (falta una clave).
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    {
        let mut s = promovida(tmp.path(), &lock);
        s.write(|tx| {
            tx.execute("DELETE FROM meta WHERE key = 'legacy_authority_since'", [])?;
            Ok(())
        })
        .unwrap();
    }
    let s = Store::open_boot_under_lock(tmp.path(), &lock, &todas, "t").unwrap();
    assert_eq!(s.schema_version().unwrap(), 2, "metadata incompleta: máximo la 002");
}

#[test]
fn una_base_autoritativa_completamente_valida_si_permite_la_003() {
    let todas = con_la_003();
    let tmp = Tmp::new();
    let lock = lock_de(tmp.path());
    drop(promovida(tmp.path(), &lock));
    let s = Store::open_boot_under_lock(tmp.path(), &lock, &todas, "t").unwrap();
    assert_eq!(s.schema_version().unwrap(), 3, "registro válido: se aplica lo posterior a la valla");
    assert!(s.authority_facts().unwrap().authority_valid(), "y la 003 no altera el registro de autoridad");
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
        StoreError::NotFenced,
        StoreError::RevOutOfRange { rev: i64::MAX },
    ] {
        assert!(!estructural.is_transient(), "{estructural:?} no se reintenta");
    }
}
