//! Arnés de caídas de C2b (`LIXBON-C2-diseno.md` §11.8).
//!
//! Cada caso relanza el binario de pruebas como SUBPROCESO con `LIXBON_CRASH_AT=<punto>`:
//! el hijo hace `abort()` en el punto con nombre (`store::crash_point`), como un `kill -9`.
//! El padre comprueba lo que quedó en disco, reabre con el motor real y verifica la
//! decisión, la fuente de los datos y, sobre todo, que `state.json` NO vuelve a ser
//! autoridad en ningún caso.
//!
//! **Qué prueba:** atomicidad ante CAÍDA DE PROCESO. **Qué no prueba:** pérdida de
//! energía ni durabilidad del sistema de archivos (ninguna prueba puede simularla con
//! `abort()`); ver §11.9.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

use super::authority::{marker_path, read_marker, write_marker, Marker, MarkerRead, MarkerState};
use super::boot_authority::{promote_in_store, PromoteCtx, PromoteError};
use super::boot_tests::*;
use super::fsio::{self, read_json};
use super::host::RecordingHost;
use super::store_boot::StorageStatus;
use super::Orch;
use crate::store::{self, sha256_hex, Store, StoreError};

// ---------------------------------------------------------------------------
// El hijo y el lanzador
// ---------------------------------------------------------------------------

/// Proceso hijo del arnés. Solo hace algo si lo lanza [`muere_en`]; en la suite
/// normal está ignorado.
#[test]
#[ignore = "lo lanza el arnés como subproceso con LIXBON_CRASH_AT"]
fn hijo_del_arnes() {
    let Some(base) = std::env::var_os("LIXBON_CRASH_DIR") else { return };
    let base = PathBuf::from(base);
    let (data, core) = (base.join("orch"), base.join("core"));
    fsio::set_test_data_dir(&data);
    let c = Orch::default().0;
    let _ = c.init_in(RecordingHost::new(), &data, &core);
    if std::env::var("LIXBON_CRASH_SCENARIO").as_deref() == Ok("mutar") {
        let _ = c.mutate(|st| {
            st.seq += 1;
            Ok(())
        });
    }
}

/// Lanza el hijo y exige que MUERA (que el punto se alcance).
fn muere_en(data: &Path, punto: &str, escenario: &str) {
    let base = data.parent().unwrap();
    let estado = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "orch::crash_tests::hijo_del_arnes", "--ignored", "--nocapture", "--test-threads=1"])
        .env("LIXBON_CRASH_DIR", base)
        .env("LIXBON_CRASH_AT", punto)
        .env("LIXBON_CRASH_SCENARIO", escenario)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("no se pudo lanzar el hijo del arnés");
    assert!(!estado.success(), "el hijo debía morir en «{punto}» pero terminó bien: ¿se alcanzó el punto?");
}

/// Un legado con una tarea en marcha y el hijo muerto en `punto` durante el arranque.
fn tras_caer_en(punto: &str) -> (Limpia, PathBuf, PathBuf, Vec<u8>) {
    let (l, data, core) = dirs();
    let original = legado_con(&data, "previa");
    muere_en(&data, punto, "promover");
    (l, data, core, original)
}

/// Una instalación ya promovida en la que el hijo muere en `punto` al mutar. Devuelve
/// también el `seq` del estado ANTES de la mutación (la línea base de la comparación).
fn tras_mutar_y_caer_en(punto: &str) -> (Limpia, PathBuf, PathBuf, u64) {
    let (l, data, core) = dirs();
    promovida(&data, &core, "propia");
    let seq0 = {
        let (c, _h, r) = arranca(&data, &core);
        r.unwrap();
        let s = c.lock().seq;
        s
    };
    muere_en(&data, punto, "mutar");
    (l, data, core, seq0)
}

fn version_de_la_base(core: &Path) -> i64 {
    let c = rusqlite::Connection::open(core.join("lixbon.db")).unwrap();
    c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
}

fn c1_no_puede_abrir(core: &Path) {
    match Store::open_with(core, &db_version_c1(), "c2a") {
        Err(StoreError::DatabaseNewer { db_version: 2, binary_version: 1 }) => {}
        otro => panic!("C1/C2a no deberían poder abrir una base con la valla: {otro:?}"),
    }
}

fn sin_copia_divergente(data: &Path) {
    let v = archivos(data);
    assert!(!v.iter().any(|n| n.starts_with("state.json.divergente-")), "no debía haber copia divergente: {v:?}");
}

fn espejo_rev(data: &Path) -> Option<i64> {
    read_json::<Value>(&data.join("state.json")).and_then(|v| v["_mirror"]["rev"].as_i64())
}

// ---------------------------------------------------------------------------
// A. Promoción
// ---------------------------------------------------------------------------

#[test]
fn a1_caida_tras_la_copia_y_antes_de_la_valla() {
    let (_l, data, core, original) = tras_caer_en("backup_done");
    assert!(matches!(read_marker(&core), MarkerRead::Absent));
    assert_eq!(version_de_la_base(&core), 1, "la valla aún no se aplicó");
    assert!(archivos(&core.join("backups")).iter().any(|n| n.contains("pre-authority")), "la copia sí existe");
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(titulos(&c), vec!["previa".to_string()]);
    assert_eq!(marcador(&core).state, MarkerState::Authoritative);
    assert_eq!(marcador(&core).source_hash, sha256_hex(&original));
}

#[test]
fn f1_caida_inmediatamente_antes_de_aplicar_la_002() {
    let (_l, data, core, _o) = tras_caer_en("before_fence");
    assert_eq!(version_de_la_base(&core), 1, "la 002 no llegó a aplicarse");
    assert!(matches!(read_marker(&core), MarkerRead::Absent));
    // C1/C2a todavía pueden abrirla: la valla no se publicó antes de tiempo.
    drop(Store::open_with(&core, &db_version_c1(), "c2a").expect("sin valla, C2a abre"));
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert!(facts(&c).fenced && marcador(&core).state == MarkerState::Authoritative);
}

#[test]
fn f2_caida_tras_el_commit_de_la_002_y_antes_de_publicar_promoting() {
    let (_l, data, core, _o) = tras_caer_en("after_fence");
    // Estado FENCED: user_version = 2, sin marcador, SQLite todavía de bootstrap.
    assert_eq!(version_de_la_base(&core), 2);
    assert!(matches!(read_marker(&core), MarkerRead::Absent));
    c1_no_puede_abrir(&core);
    // La instalación sigue siendo promocionable desde state.json: el Core de C2b CONTINÚA.
    let (c, _h, r) = arranca(&data, &core);
    r.expect("FENCED + sin marcador + bootstrap: se repiten las validaciones y se continúa");
    assert!(!matches!(c.storage_status(), StorageStatus::Degraded(_)), "nunca degrada a C1 una vez FENCED");
    assert_eq!(titulos(&c), vec!["previa".to_string()]);
    assert_eq!(marcador(&core).state, MarkerState::Authoritative);
}

#[test]
fn f2b_fenced_sin_marcador_y_con_la_base_ilegible_bloquea_en_vez_de_degradar() {
    let (_l, data, core, _o) = tras_caer_en("after_fence");
    rompe_la_base(&core);
    let tentador = std::fs::read(data.join("state.json")).unwrap();
    let (c, _h, r) = arranca(&data, &core);
    let err = r.unwrap_err();
    assert!(err.contains("ya se promovió a SQLite"), "la copia pre-authority es el indicio: {err}");
    assert!(!matches!(c.storage_status(), StorageStatus::Degraded(_)));
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), tentador);
}

#[test]
fn a2_caida_con_el_temporal_de_promoting_escrito_y_sin_publicar() {
    let (_l, data, core, _o) = tras_caer_en("marker_promoting_tmp");
    assert!(matches!(read_marker(&core), MarkerRead::Absent), "el marcador no se publicó");
    assert!(fsio::staging_path(&marker_path(&core)).exists(), "queda el temporal huérfano");
    assert_eq!(version_de_la_base(&core), 2, "la valla va ANTES de la intención");
    c1_no_puede_abrir(&core);
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert!(!fsio::staging_path(&marker_path(&core)).exists(), "el temporal huérfano se limpia");
    assert_eq!(titulos(&c), vec!["previa".to_string()]);
}

#[test]
fn a3_caida_con_promoting_publicado_y_antes_del_commit_se_rehace_la_misma_promocion() {
    let (_l, data, core, original) = tras_caer_en("marker_promoting_published");
    let antes = marcador(&core);
    assert_eq!(antes.state, MarkerState::Promoting);
    assert_eq!(antes.source_hash, sha256_hex(&original), "la intención fija los bytes exactos");
    assert_eq!(version_de_la_base(&core), 2);
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    let despues = marcador(&core);
    assert_eq!(despues.state, MarkerState::Authoritative);
    assert_eq!(despues.promotion_id, antes.promotion_id, "es LA MISMA promoción, no una nueva");
    assert_eq!(titulos(&c), vec!["previa".to_string()]);
}

#[test]
fn a4_caida_dentro_de_la_transaccion_de_la_promocion_no_deja_nada_a_medias() {
    let (_l, data, core, _o) = tras_caer_en("promote_in_tx");
    let antes = marcador(&core);
    assert_eq!(antes.state, MarkerState::Promoting);
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(marcador(&core).promotion_id, antes.promotion_id);
    assert_eq!(fila(&c).0, 1, "una sola fila, en rev 1: el rollback no dejó residuos");
}

#[test]
fn a5_commit_hecho_y_marcador_aun_en_promoting_manda_sqlite_y_se_completa() {
    let (_l, data, core, _o) = tras_caer_en("promote_committed");
    let antes = marcador(&core);
    assert_eq!(antes.state, MarkerState::Promoting, "el COMMIT ocurrió pero el marcador no se confirmó");
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(marcador(&core).state, MarkerState::Authoritative);
    assert!(matches!(c.storage_status(), StorageStatus::Ready(r) if !r.promoted_now), "no es una promoción nueva: se completa la anterior");
    assert_eq!(titulos(&c), vec!["previa".to_string()], "el estado sale de SQLite");
}

#[test]
fn a5b_commit_hecho_y_la_base_se_vuelve_ilegible_bloquea_sin_usar_state_json() {
    let (_l, data, core, _o) = tras_caer_en("promote_committed");
    rompe_la_base(&core);
    let (c, _h, r) = arranca(&data, &core);
    assert!(r.unwrap_err().contains("ya se promovió a SQLite"));
    assert!(c.lock().tasks.is_empty());
    assert_eq!(marcador(&core).state, MarkerState::Promoting, "el marcador sigue ahí");
}

#[test]
fn a6_caida_con_el_temporal_de_authoritative_escrito_y_sin_publicar() {
    let (_l, data, core, _o) = tras_caer_en("marker_final_tmp");
    assert_eq!(marcador(&core).state, MarkerState::Promoting);
    assert!(fsio::staging_path(&marker_path(&core)).exists());
    let (_c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(marcador(&core).state, MarkerState::Authoritative);
    assert!(!fsio::staging_path(&marker_path(&core)).exists());
}

#[test]
fn a7_caida_inmediatamente_despues_de_publicar_authoritative() {
    let (_l, data, core, _o) = tras_caer_en("marker_final_published");
    assert_eq!(marcador(&core).state, MarkerState::Authoritative);
    assert!(espejo_rev(&data).is_none(), "el primer espejo aún no se escribió");
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(titulos(&c), vec!["previa".to_string()]);
    assert_eq!(espejo_rev(&data), Some(1), "el espejo se regenera");
    sin_copia_divergente(&data);
}

#[test]
fn a7b_publicado_y_la_base_ilegible_despues_bloquea() {
    let (_l, data, core, _o) = tras_caer_en("marker_final_published");
    rompe_la_base(&core);
    let (_c, _h, r) = arranca(&data, &core);
    assert!(r.unwrap_err().contains("ya se promovió a SQLite"));
}

#[test]
fn a8_caida_con_el_temporal_del_primer_espejo_escrito() {
    let (_l, data, core, original) = tras_caer_en("mirror_tmp_written");
    assert_eq!(marcador(&core).state, MarkerState::Authoritative);
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), original, "state.json aún es el legado intacto");
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(espejo_rev(&data), Some(1));
    sin_copia_divergente(&data);
    assert_eq!(titulos(&c), vec!["previa".to_string()]);
}

// ---------------------------------------------------------------------------
// B. Mutaciones en una instalación ya promovida
// ---------------------------------------------------------------------------

#[test]
fn b1_caida_dentro_de_la_transaccion_de_una_mutacion_deja_el_estado_previo() {
    let (_l, data, core, seq0) = tras_mutar_y_caer_en("mutate_in_tx");
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(fila(&c).0, 1, "la mutación no existe");
    assert_eq!(c.lock().seq, seq0, "el estado es el previo");
}

#[test]
fn b2_caida_tras_el_commit_y_antes_del_espejo_sqlite_gana_sin_copia_divergente() {
    let (_l, data, core, seq0) = tras_mutar_y_caer_en("mutate_after_commit");
    assert_eq!(espejo_rev(&data), Some(1), "el espejo quedó en la revisión anterior");
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!((fila(&c).0, c.lock().seq), (2, seq0 + 1), "la mutación confirmada sobrevive");
    assert_eq!(espejo_rev(&data), Some(2), "el espejo se regenera");
    sin_copia_divergente(&data);
}

#[test]
fn b3_caida_a_mitad_del_espejo_deja_state_json_anterior_intacto_y_sqlite_gana() {
    let (_l, data, core, seq0) = tras_mutar_y_caer_en("mirror_tmp_written");
    assert_eq!(espejo_rev(&data), Some(1), "state.json anterior intacto");
    assert!(fsio::staging_path(&data.join("state.json")).exists(), "queda el temporal");
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!((fila(&c).0, c.lock().seq), (2, seq0 + 1));
    assert_eq!(espejo_rev(&data), Some(2));
    sin_copia_divergente(&data);
}

// ---------------------------------------------------------------------------
// C. Base inaccesible tras una caída
// ---------------------------------------------------------------------------

#[test]
fn c2_promoting_publicado_y_la_base_ilegible_bloquea() {
    let (_l, data, core, _o) = tras_caer_en("marker_promoting_published");
    rompe_la_base(&core);
    let (c, _h, r) = arranca(&data, &core);
    assert!(r.unwrap_err().contains("ya se promovió a SQLite"));
    assert!(c.lock().tasks.is_empty());
}

#[test]
fn c4_instalacion_promovida_y_la_base_deja_de_abrir_no_vuelve_a_state_json() {
    let (_l, data, core, _seq0) = tras_mutar_y_caer_en("mutate_after_commit");
    rompe_la_base(&core);
    let (c, _h, r) = arranca(&data, &core);
    assert!(r.unwrap_err().contains("no se vuelve a usar state.json"));
    assert!(c.lock().tasks.is_empty());
}

// ---------------------------------------------------------------------------
// D. `state.json` (y la fila) alrededor de la intención
// ---------------------------------------------------------------------------

#[test]
fn d1_state_json_modificado_tras_publicar_promoting_bloquea_y_no_promociona_lo_nuevo() {
    let (_l, data, core, _o) = tras_caer_en("marker_promoting_published");
    let antes = marcador(&core);
    let nuevo = legado_con(&data, "otro-programa-lo-cambio");
    let (c, _h, r) = arranca(&data, &core);
    let err = r.unwrap_err();
    assert!(err.contains("cambió después de que Lixbon fijara la promoción"), "{err}");
    let copia = archivos(&data).into_iter().find(|n| n.starts_with("state.json.cambiado-")).expect("copia del actual");
    assert_eq!(std::fs::read(data.join(copia)).unwrap(), nuevo);
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), nuevo, "state.json no se tocó");
    assert_eq!(marcador(&core), antes, "el marcador sigue siendo la misma intención");
    assert_eq!(fila_opcional(&c), None, "SQLite sin cambios: no se promocionó nada");
    assert!(c.lock().tasks.is_empty());
}

#[test]
fn d2_state_json_borrado_tras_publicar_promoting_bloquea() {
    let (_l, data, core, _o) = tras_caer_en("marker_promoting_published");
    std::fs::remove_file(data.join("state.json")).unwrap();
    let (c, _h, r) = arranca(&data, &core);
    assert!(r.unwrap_err().contains("cambió después de que Lixbon fijara la promoción"));
    assert_eq!(marcador(&core).state, MarkerState::Promoting);
    assert_eq!(fila_opcional(&c), None);
}

#[test]
fn d3_state_json_que_vuelve_a_los_bytes_exactos_permite_rehacer() {
    let (_l, data, core, original) = tras_caer_en("marker_promoting_published");
    let antes = marcador(&core);
    std::fs::write(data.join("state.json"), b"{ lo estropean }").unwrap();
    let (fallido, _h, r) = arranca(&data, &core);
    assert!(r.is_err());
    drop(fallido); // un Core que no arrancó conserva core.lock hasta soltarse
    std::fs::write(data.join("state.json"), &original).unwrap();
    let (c, _h, r) = arranca(&data, &core);
    r.expect("mismos bytes: misma promoción");
    assert_eq!(marcador(&core).promotion_id, antes.promotion_id);
    assert_eq!(titulos(&c), vec!["previa".to_string()]);
}

#[test]
fn d7_state_json_ilegible_tras_publicar_promoting_bloquea_con_copia_diagnostica() {
    let (_l, data, core, _o) = tras_caer_en("marker_promoting_published");
    std::fs::write(data.join("state.json"), b"{ truncado").unwrap();
    let (_c, _h, r) = arranca(&data, &core);
    assert!(r.unwrap_err().contains("no se interpreta como un estado vacío"));
    assert!(archivos(&data).iter().any(|n| n.starts_with("state.json.invalido-")));
    assert_eq!(marcador(&core).state, MarkerState::Promoting);
}

#[test]
fn d4_state_json_cambia_entre_la_intencion_y_el_commit_en_el_mismo_proceso() {
    let (_l, data, core_dir) = dirs();
    let original = legado_con(&data, "previa");
    // El «cambio» ocurre tras leer los bytes y publicar la intención: se simula con un
    // archivo en disco distinto de los bytes con los que se fijó la intención.
    let c = Orch::default().0;
    c.acquire_instance_lock(&core_dir).unwrap();
    c.storage.open_for_boot(&core_dir).unwrap();
    let cambiado = legado_con(&data, "cambiado-por-otro");
    let ctx = PromoteCtx { core: &core_dir, data: &data, legacy_bytes: Some(&original), resume: None };
    let r = c.storage.with_store(|s| promote_in_store(s, &ctx)).unwrap();
    assert!(matches!(r, Err(PromoteError::LegacyChanged)), "{:?}", r.map(|p| p.plan));
    // Quedó S2: intención publicada, valla puesta, SQLite sin tocar...
    assert_eq!(marcador(&core_dir).state, MarkerState::Promoting);
    assert!(facts(&c).fenced);
    assert_eq!(fila_opcional(&c), None);
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), cambiado);
    // ...y el siguiente arranque lo diagnostica como D1.
    drop(c);
    let (_c2, _h, r) = arranca(&data, &core_dir);
    assert!(r.unwrap_err().contains("cambió después de que Lixbon fijara la promoción"));
}

#[test]
fn d6_la_fila_de_c1_cambia_tras_publicar_promoting_bloquea() {
    let (_l, data, core) = dirs();
    legado_con(&data, "vieja");
    instantanea_de_c1(&core, &data.join("state.json"), 1);
    legado_con(&data, "reciente");
    muere_en(&data, "marker_promoting_published", "promover");
    assert_eq!(marcador(&core).sqlite_bootstrap_rev, 1);
    {
        let mut s = Store::open_with(&core, &store::embedded(), "t").unwrap();
        s.write(|tx| {
            tx.execute("UPDATE legacy_state SET rev = 11 WHERE id = 1", [])?;
            Ok(())
        })
        .unwrap();
    }
    let (_c, _h, r) = arranca(&data, &core);
    assert!(r.unwrap_err().contains("se contradicen"), "la fila ya no está en el rev fijado por la intención");
}

#[test]
fn d11_con_bootstrap_rev_10_la_caida_y_el_reinicio_rehacen_hacia_el_rev_11() {
    let (_l, data, core) = dirs();
    legado_con(&data, "vieja");
    instantanea_de_c1(&core, &data.join("state.json"), 10);
    legado_con(&data, "reciente");
    muere_en(&data, "marker_promoting_published", "promover");
    let antes = marcador(&core);
    assert_eq!((antes.sqlite_bootstrap_rev, antes.sqlite_target_rev), (10, 11));
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(titulos(&c), vec!["reciente".to_string()], "se promociona state.json, no la instantánea de rev 10");
    assert_eq!(marcador(&core).promotion_id, antes.promotion_id);
    assert_eq!(fila(&c).0, 11);
}

#[test]
fn d8_state_json_modificado_cuando_ya_hay_commit_es_irrelevante_manda_sqlite() {
    let (_l, data, core, _o) = tras_caer_en("promote_committed");
    legado_con(&data, "otro-programa");
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(titulos(&c), vec!["previa".to_string()], "la fuente es SQLite");
    assert!(archivos(&data).iter().any(|n| n.starts_with("state.json.divergente-")), "lo ajeno se conserva");
}

#[test]
fn d9_con_t3_pendiente_y_el_core_ya_mutado_mas_alla_del_target_se_completa() {
    let (_l, data, core_dir) = dirs();
    promovida(&data, &core_dir, "propia");
    // Simula «T3 falló y el Core siguió»: la fila avanza y el marcador vuelve a `promoting`.
    let seq0 = {
        let (c, _h, r) = arranca(&data, &core_dir);
        r.unwrap();
        let seq0 = c.lock().seq;
        for _ in 0..3 {
            c.mutate(|st| {
                st.seq += 1;
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(fila(&c).0, 4);
        seq0
    };
    let confirmado = marcador(&core_dir);
    write_marker(&core_dir, &Marker { state: MarkerState::Promoting, confirmed_at: None, ..confirmado }, ("a", "b")).unwrap();
    let (c, _h, r) = arranca(&data, &core_dir);
    r.expect("compara con el target_rev inmutable, no con la rev actual");
    assert_eq!(marcador(&core_dir).state, MarkerState::Authoritative);
    assert_eq!(c.lock().seq, seq0 + 3, "las tres mutaciones posteriores a la promoción se conservan");
}

// ---------------------------------------------------------------------------
// F. Valla + intención
// ---------------------------------------------------------------------------

#[test]
fn f5_copia_valida_y_valla_aplicada_pero_la_intencion_no_se_puede_publicar() {
    let (_l, data, core) = dirs();
    let original = legado_con(&data, "previa");
    // El temporal del marcador es una carpeta: publicar `authority.json` es imposible.
    std::fs::create_dir_all(fsio::staging_path(&marker_path(&core))).unwrap();
    let (c, _h, r) = arranca(&data, &core);
    let err = r.unwrap_err();
    assert!(err.contains("no se pudo publicar authority.json"), "{err}");
    // Con la valla ya cruzada NO se degrada a C1.
    assert!(!matches!(c.storage_status(), StorageStatus::Degraded(_)));
    assert!(facts(&c).fenced);
    assert!(archivos(&core.join("backups")).iter().any(|n| n.contains("pre-authority")), "la copia es válida y existe");
    assert!(matches!(read_marker(&core), MarkerRead::Absent));
    assert_eq!(fila_opcional(&c), None);
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), original);
    drop(c);
    c1_no_puede_abrir(&core);
    // Resuelto el problema, el siguiente arranque continúa sin más.
    std::fs::remove_dir_all(fsio::staging_path(&marker_path(&core))).unwrap();
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(marcador(&core).state, MarkerState::Authoritative);
    assert_eq!(titulos(&c), vec!["previa".to_string()]);
}

// ---------------------------------------------------------------------------
// E. Legado ausente
// ---------------------------------------------------------------------------

#[test]
fn e4_tras_el_bloqueo_por_falta_de_state_json_colocar_uno_legible_promueve_ese_archivo() {
    let (_l, data, core) = dirs();
    legado_con(&data, "vieja");
    instantanea_de_c1(&core, &data.join("state.json"), 1);
    std::fs::remove_file(data.join("state.json")).unwrap();
    let (fallido, _h, r) = arranca(&data, &core);
    assert!(r.is_err());
    drop(fallido);
    legado_con(&data, "recuperada-a-mano");
    let (c, _h, r) = arranca(&data, &core);
    r.unwrap();
    assert_eq!(titulos(&c), vec!["recuperada-a-mano".to_string()]);
    assert_eq!(marcador(&core).sqlite_bootstrap_rev, 1);
}

#[test]
fn la_suite_normal_nunca_activa_un_punto_de_caida() {
    // Si LIXBON_CRASH_AT estuviera definida en el entorno de la suite, cualquier prueba moriría.
    assert!(std::env::var("LIXBON_CRASH_AT").is_err(), "LIXBON_CRASH_AT solo la define el arnés para su hijo");
    store::crash_point("cualquier_punto");
}
