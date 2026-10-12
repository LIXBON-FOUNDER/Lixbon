//! Pruebas del arranque autoritativo (C2b): promoción, FENCED, bloqueos, espejo y
//! fallos de SQLite. Cada prueba usa carpetas propias (`orch/` para `state.json` y
//! `core/` para el almacén): nunca el `~/.lixbon` real.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

use super::authority::{marker_path, read_marker, Marker, MarkerRead, MarkerState};
use super::fsio::{self, read_json, write_json};
use super::host::RecordingHost;
use super::mutation::{Health, MirrorHealth, MutateError};
use super::state::{NewTask, State};
use super::store_boot::{OpenStoreError, StorageStatus};
use super::{Core, Orch};
use crate::store::{self, sha256_hex, AuthorityFacts, Store, FENCE_VERSION, MODE_SQLITE_AUTHORITATIVE};

static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Borra la carpeta de la prueba al salir (declararla ANTES que los Core: se suelta la última).
pub(super) struct Limpia(pub PathBuf);

impl Drop for Limpia {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `(limpieza, data, core)`: `data` = `.lixbon/orch` y `core` = `.lixbon/core` de la prueba.
pub(super) fn dirs() -> (Limpia, PathBuf, PathBuf) {
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let base = std::env::temp_dir().join(format!("lixbon-c2b-{}-{n}-{nanos}", std::process::id()));
    let (data, core) = (base.join("orch"), base.join("core"));
    std::fs::create_dir_all(&data).unwrap();
    fsio::set_test_data_dir(&data);
    (Limpia(base), data, core)
}

pub(super) fn nueva_tarea(core: &Core, titulo: &str) -> String {
    core.lock_unpersisted()
        .create_run("obj", NewTask {
            agent: "coordinador".into(), model: None, effort: None, role: None, title: titulo.into(), spec: "s".into(),
            repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: false,
        })
        .1
}

/// Deja en `data/state.json` el estado actual de `core` (como lo dejaría una sesión anterior).
pub(super) fn escribe_state_de(core: &Core, data: &Path) {
    write_json(&data.join("state.json"), &*core.lock()).unwrap();
}

/// Un `state.json` previo con una tarea en marcha titulada `titulo`.
pub(super) fn legado_con(data: &Path, titulo: &str) -> Vec<u8> {
    let previa = Orch::default().0;
    nueva_tarea(&previa, titulo);
    escribe_state_de(&previa, data);
    std::fs::read(data.join("state.json")).unwrap()
}

pub(super) fn arranca(data: &Path, core: &Path) -> (Arc<Core>, Arc<RecordingHost>, Result<(), String>) {
    let c = Orch::default().0;
    let h = RecordingHost::new();
    let r = c.init_in(h.clone(), data, core);
    (c, h, r)
}

pub(super) fn facts(core: &Core) -> AuthorityFacts {
    core.storage.with_store(|s| s.authority_facts().unwrap()).expect("el almacén debería estar abierto")
}

pub(super) fn marcador(core_dir: &Path) -> Marker {
    match read_marker(core_dir) {
        MarkerRead::Valid(m) => m,
        otro => panic!("se esperaba un marcador válido y salió {otro:?}"),
    }
}

pub(super) fn archivos(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
    v.sort();
    v
}

pub(super) fn titulos(core: &Core) -> Vec<String> {
    let mut v: Vec<String> = core.lock().tasks.values().map(|t| t.title.clone()).collect();
    v.sort();
    v
}

/// Una instalación ya promovida: devuelve los bytes originales de `state.json`.
pub(super) fn promovida(data: &Path, core_dir: &Path, titulo: &str) -> Vec<u8> {
    let original = legado_con(data, titulo);
    let (core, _h, r) = arranca(data, core_dir);
    r.unwrap();
    assert!(matches!(core.storage_status(), StorageStatus::Ready(_)));
    original
}

pub(super) fn db_version_c1() -> Vec<store::Migration> {
    store::embedded().into_iter().filter(|m| m.version < FENCE_VERSION).collect()
}

/// Deja una instantánea de C1 (`bootstrap_snapshot`) en la base, con la `rev` pedida.
pub(super) fn instantanea_de_c1(core_dir: &Path, fuente: &Path, rev: i64) {
    let mut s = Store::open_with(core_dir, &db_version_c1(), "c1").unwrap();
    store::bootstrap_legacy_snapshot(&mut s, fuente).unwrap();
    if rev != 1 {
        s.write(|tx| {
            tx.execute("UPDATE legacy_state SET rev = ?1 WHERE id = 1", [rev])?;
            Ok(())
        })
        .unwrap();
    }
}

pub(super) fn fila(core: &Core) -> (i64, String) {
    core.storage.with_store(|s| s.legacy_state().unwrap().map(|f| (f.rev, f.doc)).unwrap()).unwrap()
}

// ---------------------------------------------------------------------------
// Promoción
// ---------------------------------------------------------------------------

/// El `doc_sha256` del espejo: SHA-256 del contenido canónico del documento de SQLite.
fn hash_canonico(doc: &str) -> String {
    super::mirror::canonical_hash(&serde_json::from_str::<Value>(doc).unwrap())
}

#[test]
fn el_primer_arranque_promociona_y_deja_todo_coherente() {
    let (_l, data, core_dir) = dirs();
    let original = legado_con(&data, "previa");
    assert!(read_json::<State>(&data.join("state.json")).unwrap().tasks.values().any(|t| !t.status.is_final()));

    let (core, host, r) = arranca(&data, &core_dir);
    r.expect("el primer arranque promociona");

    // Marcador: confirmado y con la identidad exacta del legado.
    let m = marcador(&core_dir);
    assert_eq!(m.state, MarkerState::Authoritative);
    assert_eq!((m.source_hash.clone(), m.source_bytes), (sha256_hex(&original), original.len() as u64));
    assert_eq!((m.sqlite_bootstrap_rev, m.sqlite_target_rev), (0, 1), "sin fila previa: la fila nace en rev 1");
    // Base: cruzó la valla, es autoritativa y lleva la misma promoción.
    let f = facts(&core);
    assert!(f.fenced && f.db_version == 2);
    assert_eq!((f.mode.as_deref(), f.row_rev), (Some(MODE_SQLITE_AUTHORITATIVE), Some(1)));
    assert_eq!(f.auth.as_ref().unwrap().promotion_id, m.promotion_id);
    assert_eq!(f.db_id.as_deref(), Some(m.db_id.as_str()));
    // Estado: las tareas abiertas se cerraron, y la fila ES el estado en memoria.
    assert!(core.lock().tasks.values().all(|t| t.status.is_final()));
    let (rev, doc) = fila(&core);
    assert_eq!(serde_json::from_str::<Value>(&doc).unwrap(), serde_json::to_value(&*core.lock()).unwrap());
    // Espejo: state.json lleva la revisión de la fila.
    let espejo: Value = serde_json::from_slice(&std::fs::read(data.join("state.json")).unwrap()).unwrap();
    assert_eq!(espejo["_mirror"]["rev"], rev);
    assert_eq!(espejo["_mirror"]["doc_sha256"], hash_canonico(&doc));
    // Copias previas: de la base y de state.json (con su hash).
    let copias = archivos(&core_dir.join("backups"));
    assert!(copias.iter().any(|n| n.contains("pre-authority") && n.ends_with(".db")), "{copias:?}");
    let json = copias.iter().find(|n| n.starts_with("state.pre-authority.")).expect("copia de state.json");
    assert_eq!(std::fs::read(core_dir.join("backups").join(json)).unwrap(), original);
    // Estado del almacén y avisos.
    match core.storage_status() {
        StorageStatus::Ready(r) => assert!(r.promoted_now && !r.marker_pending && r.rev == 1 && r.promotion_id == m.promotion_id),
        otro => panic!("{otro:?}"),
    }
    assert!(host.notifications().is_empty());
    assert!(!marker_path(&core_dir).with_extension("json.tmp").exists());
}

#[test]
fn una_instalacion_nueva_promociona_con_estado_vacio() {
    let (_l, data, core_dir) = dirs();
    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    let m = marcador(&core_dir);
    assert_eq!((m.state, m.source_hash.as_str(), m.source_bytes, m.sqlite_target_rev), (MarkerState::Authoritative, "none", 0, 1));
    assert!(core.lock().tasks.is_empty());
    assert_eq!(facts(&core).row_rev, Some(1));
    let copias = archivos(&core_dir.join("backups"));
    assert!(!copias.iter().any(|n| n.starts_with("state.pre-authority.")), "no había state.json que copiar: {copias:?}");
}

#[test]
fn con_una_instantanea_de_c1_se_promociona_el_legado_actual_aunque_este_desfasada() {
    for rev_de_c1 in [1, 10] {
        let (_l, data, core_dir) = dirs();
        // C1 importó un estado viejo...
        let vieja = legado_con(&data, "vieja");
        instantanea_de_c1(&core_dir, &data.join("state.json"), rev_de_c1);
        // ...y C2a siguió mutando state.json: ahora tiene OTRA tarea.
        let reciente = legado_con(&data, "reciente");
        assert_ne!(vieja, reciente);

        let (core, _h, r) = arranca(&data, &core_dir);
        r.unwrap_or_else(|e| panic!("bootstrap_rev {rev_de_c1} no debe bloquear: {e}"));
        assert_eq!(titulos(&core), vec!["reciente".to_string()], "se promociona state.json, no la instantánea");
        let m = marcador(&core_dir);
        assert_eq!((m.sqlite_bootstrap_rev, m.sqlite_target_rev), (rev_de_c1, rev_de_c1 + 1));
        assert_eq!(m.source_hash, sha256_hex(&reciente), "la identidad es la del legado, no la de la fila");
        let (rev, _) = fila(&core);
        assert_eq!(rev, rev_de_c1 + 1);
    }
}

#[test]
fn tras_promocionar_c1_y_c2a_no_pueden_abrir_la_instalacion() {
    let (_l, data, core_dir) = dirs();
    promovida(&data, &core_dir, "previa");
    // Es la llamada de `Core::init` de C1/C2a: su `embedded()` solo conocía la 001.
    match Store::open_with(&core_dir, &db_version_c1(), "c2a") {
        Err(store::StoreError::DatabaseNewer { db_version: 2, binary_version: 1 }) => {}
        otro => panic!("se esperaba DatabaseNewer, salió {otro:?}"),
    }
}

#[test]
fn un_segundo_arranque_carga_de_sqlite_y_conserva_lo_que_escribio_un_binario_ajeno() {
    let (_l, data, core_dir) = dirs();
    promovida(&data, &core_dir, "propia");
    // Un binario antiguo escribe un state.json con OTRA tarea, sin `_mirror`.
    let ajena = legado_con(&data, "ajena");

    let (core, host, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert_eq!(titulos(&core), vec!["propia".to_string()], "SQLite gana; lo de state.json no entra");
    match core.storage_status() {
        StorageStatus::Ready(r) => assert!(!r.promoted_now),
        otro => panic!("{otro:?}"),
    }
    let copia = archivos(&data).into_iter().find(|n| n.starts_with("state.json.divergente-")).expect("copia divergente");
    assert_eq!(std::fs::read(data.join(&copia)).unwrap(), ajena);
    assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon: cambios ajenos en state.json"));
    let espejo: Value = serde_json::from_slice(&std::fs::read(data.join("state.json")).unwrap()).unwrap();
    assert_eq!(espejo["_mirror"]["rev"], facts(&core).row_rev.unwrap());
}

#[test]
fn mutate_escribe_en_sqlite_y_el_espejo_acompana() {
    let (_l, data, core_dir) = dirs();
    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert_eq!(fila(&core).0, 1);
    core.mutate(|st| {
        st.create_run("otro", NewTask {
            agent: "coordinador".into(), model: None, effort: None, role: None, title: "nueva".into(), spec: "s".into(),
            repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: false,
        });
        Ok(())
    })
    .unwrap();
    let (rev, doc) = fila(&core);
    assert_eq!(rev, 2);
    assert_eq!(serde_json::from_str::<Value>(&doc).unwrap(), serde_json::to_value(&*core.lock()).unwrap(), "la fila es el estado");
    let espejo: Value = serde_json::from_slice(&std::fs::read(data.join("state.json")).unwrap()).unwrap();
    assert_eq!((espejo["_mirror"]["rev"].as_i64(), espejo["_mirror"]["doc_sha256"].as_str().map(String::from)), (Some(2), Some(hash_canonico(&doc))));
    // Una mutación que no cambia nada no consume `rev`.
    core.mutate(|st| {
        st.no_change();
        Ok(())
    })
    .unwrap();
    assert_eq!(fila(&core).0, 2);
    // Y un rechazo a mitad no deja nada: ni fila ni memoria.
    let antes = serde_json::to_value(&*core.lock()).unwrap();
    let r: Result<(), MutateError> = core.mutate(|st| {
        st.tasks.clear();
        Err("rechazada".into())
    });
    assert!(matches!(r, Err(MutateError::Rejected(_))));
    assert_eq!((fila(&core).0, serde_json::to_value(&*core.lock()).unwrap()), (2, antes));
}

// ---------------------------------------------------------------------------
// El legado no promocionable bloquea; nada se pierde ni se cruza
// ---------------------------------------------------------------------------

pub(super) fn sin_cruzar_ni_marcador(core: &Core, core_dir: &Path) {
    assert!(matches!(read_marker(core_dir), MarkerRead::Absent), "no se publicó ningún marcador");
    assert!(!facts(core).fenced, "la valla NO se aplicó: C1/C2a pueden seguir abriendo la instalación");
}

#[test]
fn un_state_json_ilegible_bloquea_se_conserva_y_no_se_toma_por_vacio() {
    let casos: [(&str, &[u8]); 4] =
        [("vacío", b""), ("truncado", b"{ \"runs\": {"), ("JSON válido pero sin la forma de un estado", b"{}"), ("no UTF-8", &[0xff, 0xfe, 0x00, 0x01])];
    for (que, bytes) in casos {
        let (_l, data, core_dir) = dirs();
        std::fs::write(data.join("state.json"), bytes).unwrap();
        let (core, host, r) = arranca(&data, &core_dir);
        let err = r.expect_err(que);
        assert!(err.contains("no se interpreta como un estado vacío"), "{que}: {err}");
        assert_eq!(std::fs::read(data.join("state.json")).unwrap(), bytes, "{que}: el original no se toca");
        let copia = archivos(&data).into_iter().find(|n| n.starts_with("state.json.invalido-")).unwrap_or_else(|| panic!("{que}: sin copia diagnóstica"));
        assert_eq!(std::fs::read(data.join(copia)).unwrap(), bytes);
        assert!(core.lock().tasks.is_empty());
        assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon no puede iniciar"));
        sin_cruzar_ni_marcador(&core, &core_dir);
        assert_eq!(fila_opcional(&core), None, "{que}: no se escribió ninguna fila");
    }
}

pub(super) fn fila_opcional(core: &Core) -> Option<(i64, String)> {
    core.storage.with_store(|s| s.legacy_state().unwrap().map(|f| (f.rev, f.doc))).unwrap()
}

#[test]
fn sin_state_json_pero_con_instantanea_bloquea_sin_promocionarla() {
    let (_l, data, core_dir) = dirs();
    legado_con(&data, "vieja");
    instantanea_de_c1(&core_dir, &data.join("state.json"), 1);
    std::fs::remove_file(data.join("state.json")).unwrap();
    let antes = {
        let s = Store::open_with(&core_dir, &db_version_c1(), "t").unwrap();
        let f = s.legacy_state().unwrap().unwrap();
        (f.rev, f.doc)
    };

    let (core, _h, r) = arranca(&data, &core_dir);
    let err = r.unwrap_err();
    assert!(err.contains("instantánea") && err.contains("no se promociona sola"), "{err}");
    assert_eq!(fila(&core), antes, "la instantánea queda intacta");
    sin_cruzar_ni_marcador(&core, &core_dir);
    assert!(!data.join("state.json").exists(), "no se inventó un state.json");
}

#[test]
fn sin_state_json_y_con_rastros_no_es_una_instalacion_nueva() {
    let (_l, data, core_dir) = dirs();
    std::fs::write(data.join("state.json.invalido-1"), b"basura de un arranque anterior").unwrap();
    let (core, _h, r) = arranca(&data, &core_dir);
    assert!(r.unwrap_err().contains("ya tenía estado"));
    sin_cruzar_ni_marcador(&core, &core_dir);
}

#[test]
fn si_no_se_puede_hacer_la_copia_se_degrada_antes_de_cruzar_la_valla() {
    let (_l, data, core_dir) = dirs();
    let original = legado_con(&data, "previa");
    std::fs::create_dir_all(&core_dir).unwrap();
    std::fs::write(core_dir.join("backups"), b"soy un archivo: la carpeta de copias no se puede crear").unwrap();

    let (core, _h, r) = arranca(&data, &core_dir);
    r.expect("antes de la valla rige la política de bootstrap: el Core arranca degradado");
    match core.storage_status() {
        StorageStatus::Degraded(m) => assert!(m.contains("promoción"), "{m}"),
        otro => panic!("{otro:?}"),
    }
    assert!(matches!(read_marker(&core_dir), MarkerRead::Absent));
    assert!(core.lock().tasks.values().all(|t| t.status.is_final()), "sigue con state.json como antes");
    // La valla no se aplicó: lo comprueba una apertura al estilo de C1.
    drop(core);
    assert_eq!(Store::open_with(&core_dir, &db_version_c1(), "c1").unwrap().schema_version().unwrap(), 1);
    assert_ne!(original.len(), 0);
}

#[test]
fn si_falla_aplicar_la_valla_se_degrada_y_el_siguiente_arranque_continua() {
    let (_l, data, core_dir) = dirs();
    legado_con(&data, "previa");
    // Una clave que choca con la que inserta la 002: la migración falla entera.
    {
        let mut s = Store::open_with(&core_dir, &db_version_c1(), "c1").unwrap();
        s.write(|tx| {
            tx.execute("INSERT INTO meta (key, value) VALUES ('authority_fence', 'estorbo')", [])?;
            Ok(())
        })
        .unwrap();
    }
    let (core, _h, r) = arranca(&data, &core_dir);
    r.expect("sin cruzar la valla, el Core arranca degradado");
    assert!(matches!(core.storage_status(), StorageStatus::Degraded(m) if m.contains("valla")));
    assert!(matches!(read_marker(&core_dir), MarkerRead::Absent));
    // La preflight y la copia sí se hicieron; la valla no.
    assert!(archivos(&core_dir.join("backups")).iter().any(|n| n.contains("pre-authority")));
    drop(core);
    {
        let mut s = Store::open_with(&core_dir, &db_version_c1(), "c1").unwrap();
        assert_eq!(s.schema_version().unwrap(), 1);
        s.write(|tx| {
            tx.execute("DELETE FROM meta WHERE key = 'authority_fence'", [])?;
            Ok(())
        })
        .unwrap();
    }
    let (core, _h, r) = arranca(&data, &core_dir);
    r.expect("retirado el estorbo, la promoción sigue");
    assert_eq!(marcador(&core_dir).state, MarkerState::Authoritative);
    assert!(facts(&core).fenced);
}

// ---------------------------------------------------------------------------
// Sin fallback tras la autoridad
// ---------------------------------------------------------------------------

pub(super) fn rompe_la_base(core_dir: &Path) {
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(core_dir.join(format!("lixbon.db{ext}")));
    }
    std::fs::write(core_dir.join("lixbon.db"), vec![b'x'; 4096]).unwrap();
}

#[test]
fn promovida_y_con_la_base_ilegible_no_se_vuelve_a_state_json() {
    let (_l, data, core_dir) = dirs();
    promovida(&data, &core_dir, "propia");
    rompe_la_base(&core_dir);
    // Un state.json tentador: más reciente y sin `_mirror`.
    let tentador = legado_con(&data, "tentadora");

    let (core, host, r) = arranca(&data, &core_dir);
    let err = r.unwrap_err();
    assert!(err.contains("ya se promovió a SQLite") && err.contains("no se vuelve a usar state.json"), "{err}");
    assert!(core.lock().tasks.is_empty(), "no adoptó ningún estado");
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), tentador, "state.json no se tocó");
    assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon no puede iniciar"));
    assert!(!matches!(core.storage_status(), StorageStatus::Degraded(_)), "no hay degradado: bloquea");
    assert_eq!(marcador(&core_dir).state, MarkerState::Authoritative, "el marcador no se toca");
}

#[test]
fn una_instalacion_c1_sin_promocionar_con_la_base_ilegible_sigue_degradando_como_antes() {
    let (_l, data, core_dir) = dirs();
    std::fs::create_dir_all(&core_dir).unwrap();
    std::fs::write(core_dir.join("lixbon.db"), vec![b'x'; 4096]).unwrap();
    legado_con(&data, "previa");
    let (core, _h, r) = arranca(&data, &core_dir);
    r.expect("un fallo recuperable no impide arrancar");
    assert!(matches!(core.storage_status(), StorageStatus::Degraded(m) if m.contains("dañada")));
    assert!(core.lock().tasks.values().all(|t| t.status.is_final()));
    assert!(read_json::<State>(&data.join("state.json")).unwrap().tasks.values().all(|t| t.status.is_final()));
    // La exclusión mutua se mantiene aunque la base no sirva.
    let otro = Orch::default().0;
    assert!(matches!(otro.acquire_instance_lock(&core_dir), Err(OpenStoreError::AlreadyLocked { .. })));
}

#[test]
fn con_la_base_ilegible_y_un_state_json_ilegible_no_se_degrada_a_un_estado_vacio() {
    let (_l, data, core_dir) = dirs();
    std::fs::create_dir_all(&core_dir).unwrap();
    std::fs::write(core_dir.join("lixbon.db"), vec![b'x'; 4096]).unwrap();
    std::fs::write(data.join("state.json"), b"{ truncado").unwrap();
    let (_core, _h, r) = arranca(&data, &core_dir);
    assert!(r.unwrap_err().contains("no se interpreta como un estado vacío"));
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), b"{ truncado");
}

#[test]
fn un_espejo_sin_autoridad_en_la_base_impide_degradar() {
    let (_l, data, core_dir) = dirs();
    promovida(&data, &core_dir, "propia");
    // Se pierden marcador y base, pero state.json conserva su `_mirror`.
    std::fs::remove_file(marker_path(&core_dir)).unwrap();
    rompe_la_base(&core_dir);
    let (_core, _h, r) = arranca(&data, &core_dir);
    assert!(r.unwrap_err().contains("ya se promovió a SQLite"), "el `_mirror` es un indicio: no se degrada");
}

#[test]
fn si_se_pierde_el_marcador_y_la_base_es_autoritativa_se_reconstruye() {
    let (_l, data, core_dir) = dirs();
    promovida(&data, &core_dir, "propia");
    let antes = marcador(&core_dir);
    std::fs::remove_file(marker_path(&core_dir)).unwrap();
    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    let ahora = marcador(&core_dir);
    assert_eq!(ahora.state, MarkerState::Authoritative);
    assert_eq!((ahora.promotion_id, ahora.db_id, ahora.source_hash, ahora.sqlite_target_rev), (antes.promotion_id, antes.db_id, antes.source_hash, antes.sqlite_target_rev));
    assert_eq!(titulos(&core), vec!["propia".to_string()], "manda SQLite");
    assert!(matches!(core.storage_status(), StorageStatus::Ready(r) if !r.promoted_now));
}

#[test]
fn un_marcador_invalido_bloquea_sin_tocar_nada() {
    let (_l, data, core_dir) = dirs();
    promovida(&data, &core_dir, "propia");
    for malo in [&b"{ truncado"[..], &br#"{"v":9}"#[..], &br#"{"v":1,"state":"otro"}"#[..]] {
        std::fs::write(marker_path(&core_dir), malo).unwrap();
        let (core, _h, r) = arranca(&data, &core_dir);
        let err = r.unwrap_err();
        assert!(err.contains("marcador de autoridad no es válido"), "{err}");
        assert!(core.lock().tasks.is_empty());
        assert_eq!(std::fs::read(marker_path(&core_dir)).unwrap(), malo, "el marcador inválido no se sobrescribe");
    }
}

#[test]
fn una_base_restaurada_de_antes_de_la_promocion_contradice_al_marcador() {
    let (_l, data, core_dir) = dirs();
    promovida(&data, &core_dir, "propia");
    let copia = archivos(&core_dir.join("backups")).into_iter().find(|n| n.contains("pre-authority") && n.ends_with(".db")).unwrap();
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(core_dir.join(format!("lixbon.db{ext}")));
    }
    std::fs::copy(core_dir.join("backups").join(copia), core_dir.join("lixbon.db")).unwrap();
    let (core, _h, r) = arranca(&data, &core_dir);
    let err = r.unwrap_err();
    assert!(err.contains("se contradicen"), "{err}");
    assert!(!err.to_lowercase().contains("borra"), "el mensaje no sugiere borrar nada: {err}");
    assert!(core.lock().tasks.is_empty());
}

#[test]
fn con_marcador_y_sin_base_no_se_recrea_una_base_vacia() {
    let (_l, data, core_dir) = dirs();
    promovida(&data, &core_dir, "propia");
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(core_dir.join(format!("lixbon.db{ext}")));
    }
    let (_core, _h, r) = arranca(&data, &core_dir);
    assert!(r.unwrap_err().contains("se contradicen"));
    assert!(!core_dir.join("lixbon.db").exists(), "abrir habría recreado una base vacía");
}

// ---------------------------------------------------------------------------
// Fallos en marcha: espejo y SQLite
// ---------------------------------------------------------------------------

#[test]
fn un_fallo_del_espejo_no_invalida_el_commit_ni_degrada() {
    let (_l, data, core_dir) = dirs();
    let (core, host, r) = arranca(&data, &core_dir);
    r.unwrap();
    host.clear_events();
    // El espejo no se puede escribir: state.json es ahora una carpeta.
    std::fs::remove_file(data.join("state.json")).unwrap();
    std::fs::create_dir(data.join("state.json")).unwrap();

    core.mutate(|st| {
        st.create_run("otro", NewTask {
            agent: "coordinador".into(), model: None, effort: None, role: None, title: "n".into(), spec: "s".into(),
            repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: false,
        });
        Ok(())
    })
    .expect("el COMMIT de SQLite basta");
    assert_eq!(fila(&core).0, 2, "SQLite avanzó");
    assert!(matches!(core.mirror_health(), MirrorHealth::Failed(_)));
    assert_eq!(core.health(), Health::Normal, "un espejo caído no pone el Core en solo lectura");
    let avisos = host.events_named("orch:degraded");
    assert_eq!(avisos.len(), 1);
    assert_eq!(avisos[0]["mode"], "mirror_failed");
    // Restablecido el archivo, el siguiente COMMIT lo reescribe y el estado vuelve a Ok.
    std::fs::remove_dir(data.join("state.json")).unwrap();
    core.mutate(|st| {
        st.seq += 1;
        Ok(())
    })
    .unwrap();
    assert_eq!(core.mirror_health(), MirrorHealth::Ok);
    assert_eq!(read_json::<Value>(&data.join("state.json")).unwrap()["_mirror"]["rev"], 3);
}

#[test]
fn un_fallo_estructural_de_sqlite_descarta_el_candidato_y_pasa_a_solo_lectura() {
    let (_l, data, core_dir) = dirs();
    let (core, host, r) = arranca(&data, &core_dir);
    r.unwrap();
    // Otro escritor movió la fila: la `rev` esperada ya no es la de la base (RevConflict, estructural).
    core.storage
        .with_store(|s| {
            s.write(|tx| {
                tx.execute("UPDATE legacy_state SET rev = rev + 5 WHERE id = 1", [])?;
                Ok(())
            })
        })
        .unwrap()
        .unwrap();
    let antes = serde_json::to_value(&*core.lock()).unwrap();
    let r = core.mutate(|st| {
        st.seq += 100;
        Ok(())
    });
    assert!(matches!(r, Err(MutateError::Persist(_))), "{r:?}");
    assert_eq!(serde_json::to_value(&*core.lock()).unwrap(), antes, "la memoria conserva el último estado confirmado");
    assert!(matches!(core.health(), Health::DegradedReadOnly(_)));
    assert!(host.events_named("orch:degraded").iter().any(|e| e["mode"] == "read_only"));
    // Las lecturas siguen; las mutaciones nuevas se rechazan.
    assert_eq!(core.lock().seq, antes["seq"], "las lecturas siguen funcionando");
    assert!(matches!(core.mutate(|_| Ok(())), Err(MutateError::ReadOnly(_))));
}

// ---------------------------------------------------------------------------
// Bloqueos heredados de C1 (lock, esquema, checksum)
// ---------------------------------------------------------------------------

#[test]
fn un_segundo_core_con_el_bloqueo_ocupado_no_arranca_ni_toca_state_json() {
    let (_l, data, core_dir) = dirs();
    let titular = Orch::default().0;
    titular.acquire_instance_lock(&core_dir).unwrap();
    let antes = legado_con(&data, "previa");

    let (segundo, host, r) = arranca(&data, &core_dir);
    assert!(r.unwrap_err().contains("otra instancia"));
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), antes, "state.json cambió: hubo orphan_all o reescritura");
    assert!(segundo.lock().tasks.is_empty());
    assert_eq!(segundo.storage_status(), StorageStatus::NotOpened);
    assert!(!core_dir.join("lixbon.db").exists(), "no creó la base");
    assert!(!marker_path(&core_dir).exists());
    assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon no puede iniciar"));
    drop(titular);
    segundo.acquire_instance_lock(&core_dir).expect("liberado el titular, el segundo ya puede");
}

#[test]
fn sin_poder_crear_core_lock_el_core_no_arranca() {
    let (_l, data, core_dir) = dirs();
    std::fs::write(&core_dir, b"soy un archivo, no una carpeta").unwrap();
    let antes = legado_con(&data, "previa");
    let (core, host, r) = arranca(&data, &core_dir);
    assert!(r.unwrap_err().contains("bloqueo"));
    assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon no puede iniciar"));
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), antes);
    assert!(core.lock().tasks.is_empty());
}

#[test]
fn una_base_de_version_futura_impide_arrancar_y_no_se_toca() {
    let (_l, data, core_dir) = dirs();
    std::fs::create_dir_all(&core_dir).unwrap();
    {
        let c = rusqlite::Connection::open(core_dir.join("lixbon.db")).unwrap();
        c.execute_batch("CREATE TABLE futuro (x INTEGER); PRAGMA user_version = 99;").unwrap();
    }
    let antes = legado_con(&data, "previa");
    let (core, host, r) = arranca(&data, &core_dir);
    assert!(r.unwrap_err().contains("versión más nueva"));
    assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon no puede iniciar"));
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), antes, "un Core incompatible no modifica state.json");
    assert!(core.lock().tasks.is_empty());
    assert!(!marker_path(&core_dir).exists());
    let c = rusqlite::Connection::open_with_flags(core_dir.join("lixbon.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 99, "la base futura no se modificó");
}

#[test]
fn una_migracion_editada_impide_arrancar_sin_tocar_state_json() {
    let (_l, data, core_dir) = dirs();
    drop(Store::open_with(&core_dir, &db_version_c1(), "t").unwrap());
    {
        let c = rusqlite::Connection::open(core_dir.join("lixbon.db")).unwrap();
        c.execute("UPDATE schema_migrations SET checksum = 'otro' WHERE version = 1", []).unwrap();
    }
    let antes = legado_con(&data, "previa");
    let (core, _h, r) = arranca(&data, &core_dir);
    assert!(r.unwrap_err().contains("ha cambiado"));
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), antes);
    assert!(core.lock().tasks.is_empty());
}

#[test]
fn los_errores_de_esquema_y_de_autoridad_son_bloqueantes_y_los_de_disco_no() {
    use crate::store::StoreError as E;
    let casos: Vec<(E, bool)> = vec![
        (E::AlreadyRunning { lock_path: "x".into() }, true),
        (E::DatabaseNewer { db_version: 9, binary_version: 1 }, true),
        (E::UnknownMigration { version: 9, name: "x".into() }, true),
        (E::ChecksumMismatch { version: 1, name: "x".into() }, true),
        (E::OutOfOrderMigration { pending: 2, applied: 3 }, true),
        (E::InvalidMigrationList("x".into()), true),
        (E::Corrupt { path: "x".into(), detail: "x".into() }, false),
        (E::Io { context: "x".into(), source: std::io::Error::other("disco lleno") }, false),
        (E::Backup("x".into()), false),
        (E::WalUnavailable { got: "delete".into() }, false),
        (E::MigrationFailed { version: 2, name: "x".into(), detail: "x".into() }, false),
    ];
    for (e, bloqueante) in casos {
        let texto = format!("{e:?}");
        assert_eq!(OpenStoreError::from(e).is_blocking(), bloqueante, "{texto}");
    }
    assert!(OpenStoreError::LockUnavailable { detail: "x".into() }.is_blocking());
    assert!(OpenStoreError::Authority { detail: "x".into() }.is_blocking(), "un bloqueo de autoridad nunca se degrada");
    assert!(!OpenStoreError::AlreadyOpened.is_blocking());
}

#[test]
fn las_pruebas_nunca_usan_la_carpeta_real_del_core() {
    let real = super::skill::home().unwrap_or_default().join(".lixbon");
    assert!(!super::core_dir().starts_with(&real) && !super::data_dir().starts_with(&real));
    assert!(super::core_dir().starts_with(std::env::temp_dir()));
}

/// Opt-in, no forma parte de la suite normal: `LIXBON_REAL_STATE_PATH=<ruta a un
/// state.json> cargo test promociona_un_state_json_real -- --ignored --nocapture`.
/// Solo LEE el archivo: la promoción se hace sobre una copia en carpetas temporales.
#[test]
fn el_informe_del_arranque_lleva_la_rev_tras_cerrar_las_huerfanas() {
    let (_l, data, core_dir) = dirs();
    // Primera sesión: promueve y deja una tarea abierta (rev 2).
    let (primero, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    primero
        .mutate(|st| {
            st.create_run("obj", NewTask {
                agent: "coordinador".into(), model: None, effort: None, role: None, title: "abierta".into(), spec: "s".into(),
                repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: false,
            });
            Ok(())
        })
        .unwrap();
    assert_eq!(fila(&primero).0, 2);
    assert!(primero.lock().tasks.values().any(|t| !t.status.is_final()));
    drop(primero);

    // Segunda sesión: carga la rev N (2) y `close_orphans` la avanza a N+1 (3).
    let (segundo, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    let (rev, doc) = fila(&segundo);
    assert_eq!(rev, 3, "SQLite avanzó al cerrar las huérfanas");
    let StorageStatus::Ready(informe) = segundo.storage_status() else { panic!("{:?}", segundo.storage_status()) };
    assert_eq!(informe.rev, 3, "el informe lleva la revisión realmente confirmada, no la cargada");
    // Memoria == SQLite == espejo.
    assert!(segundo.lock().tasks.values().all(|t| t.status.is_final()));
    assert_eq!(serde_json::from_str::<Value>(&doc).unwrap(), serde_json::to_value(&*segundo.lock()).unwrap());
    let espejo: Value = serde_json::from_slice(&std::fs::read(data.join("state.json")).unwrap()).unwrap();
    assert_eq!(espejo["_mirror"]["rev"], 3);
    assert_eq!(espejo["_mirror"]["doc_sha256"], hash_canonico(&doc));
    // Y la persistencia sigue desde N+1: la siguiente mutación es la 4, sin conflicto.
    segundo.mutate(|st| { st.seq += 1; Ok(()) }).unwrap();
    assert_eq!(fila(&segundo).0, 4);
}

#[test]
fn una_rev_de_fila_en_el_limite_bloquea_la_promocion_sin_envolver() {
    let (_l, data, core_dir) = dirs();
    let original = legado_con(&data, "previa");
    instantanea_de_c1(&core_dir, &data.join("state.json"), i64::MAX);
    let (_core, _h, r) = arranca(&data, &core_dir);
    let msg = r.unwrap_err();
    assert!(msg.contains("fuera de rango"), "{msg}");
    assert!(!marker_path(&core_dir).exists(), "no se publicó ninguna intención");
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), original, "state.json intacto");
    let c = rusqlite::Connection::open_with_flags(core_dir.join("lixbon.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(v, 1, "ni siquiera se aplicó la valla");
    let rev: i64 = c.query_row("SELECT rev FROM legacy_state WHERE id = 1", [], |r| r.get(0)).unwrap();
    assert_eq!(rev, i64::MAX, "la fila no se tocó");
}

#[test]
#[ignore = "opt-in: define LIXBON_REAL_STATE_PATH con la ruta de un state.json real"]
fn promociona_un_state_json_real_en_solo_lectura() {
    let Some(ruta) = std::env::var_os("LIXBON_REAL_STATE_PATH") else {
        eprintln!("LIXBON_REAL_STATE_PATH no está definida: nada que comprobar");
        return;
    };
    let ruta = PathBuf::from(ruta);
    let antes = std::fs::read(&ruta).unwrap();
    let (_l, data, core_dir) = dirs();
    std::fs::write(data.join("state.json"), &antes).unwrap();
    let real: State = read_json(&ruta).expect("el archivo no se deserializa como State");
    let (tareas, runs) = (real.tasks.len(), real.runs.len());
    let t = std::time::Instant::now();
    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    eprintln!("{} bytes de estado real ({tareas} tareas, {runs} runs) promovidos en {:?}: {:?}", antes.len(), t.elapsed(), core.storage_status());
    assert_eq!(core.lock().tasks.len(), tareas);
    assert_eq!(std::fs::read(&ruta).unwrap(), antes, "el archivo real no se modificó");
}
