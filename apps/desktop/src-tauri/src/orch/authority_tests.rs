//! Pruebas del protocolo de autoridad (C2b): marcador `authority.json`, clasificación
//! del legado y `decide_boot`, incluida la prueba de propiedad que hace imposible
//! añadir por accidente un camino que devuelva la autoridad a `state.json`.

use std::path::PathBuf;

use serde_json::json;

use super::authority::*;
use crate::store::{AuthMeta, AuthorityFacts, PromotionPlan, MODE_SQLITE_AUTHORITATIVE};

const BOOTSTRAP: &str = "bootstrap_snapshot";
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTRO_HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn plan(boot: i64) -> PromotionPlan {
    PromotionPlan { promotion_id: "P1".into(), source_hash: HASH.into(), source_bytes: 100, sqlite_bootstrap_rev: boot, sqlite_target_rev: boot + 1 }
}

fn marcador(boot: i64) -> Marker {
    Marker::promoting(&plan(boot), "DB1")
}

fn confirmado(boot: i64) -> Marker {
    marcador(boot).confirmed()
}

fn auth(boot: i64) -> AuthMeta {
    AuthMeta { promotion_id: "P1".into(), source_hash: HASH.into(), source_bytes: 100, sqlite_bootstrap_rev: boot, sqlite_target_rev: boot + 1, since: 1 }
}

fn facts_bootstrap(fenced: bool, row: Option<i64>) -> AuthorityFacts {
    AuthorityFacts {
        db_version: if fenced { 2 } else { 1 },
        fenced,
        db_id: Some("DB1".into()),
        row_rev: row,
        mode: row.map(|_| BOOTSTRAP.to_string()),
        auth: None,
        has_import_meta: row.is_some(),
    }
}

fn facts_autoritativos(boot: i64, row: i64) -> AuthorityFacts {
    AuthorityFacts {
        db_version: 2,
        fenced: true,
        db_id: Some("DB1".into()),
        row_rev: Some(row),
        mode: Some(MODE_SQLITE_AUTHORITATIVE.into()),
        auth: Some(auth(boot)),
        has_import_meta: true,
    }
}

fn legible(hash: &str, bytes: u64) -> Legacy {
    Legacy::Readable { hash: hash.into(), bytes, has_mirror: false }
}

fn decide(marker: &MarkerRead, probe: &DbProbe, legacy: &Legacy, traces: bool, evidence: bool) -> Boot {
    decide_boot(&BootInputs { marker, probe, legacy, traces, evidence })
}

fn valido(m: Marker) -> MarkerRead {
    MarkerRead::Valid(m)
}

fn bloquea(b: &Boot) -> bool {
    matches!(b, Boot::Block(_))
}

// ---------------------------------------------------------------------------
// El marcador
// ---------------------------------------------------------------------------

fn carpeta(nombre: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lixbon-authority-{}-{nombre}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn el_marcador_promoting_tiene_el_esquema_exacto() {
    let v: serde_json::Value = serde_json::to_value(marcador(1)).unwrap();
    let mut claves: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
    claves.sort_unstable();
    assert_eq!(
        claves,
        ["created_at", "db", "db_id", "promotion_id", "source_bytes", "source_hash", "sqlite_bootstrap_rev", "sqlite_target_rev", "state", "v", "writer"]
    );
    assert_eq!((v["v"].as_u64(), v["state"].as_str(), v["sqlite_target_rev"].as_i64()), (Some(1), Some("promoting"), Some(2)));
    assert!(v.get("confirmed_at").is_none(), "promoting no lleva confirmed_at");
}

#[test]
fn el_marcador_authoritative_conserva_la_identidad_y_anade_confirmed_at() {
    // El confirmado sale del MISMO marcador: dos marcadores creados por separado tienen `created_at`
    // distinto si cambia el milisegundo entre ambos (el test fallaba ~7 % de las veces).
    let p = marcador(1);
    let a = p.confirmed();
    assert_eq!(a.state, MarkerState::Authoritative);
    assert!(a.confirmed_at.is_some());
    for (x, y) in [
        (&p.promotion_id, &a.promotion_id),
        (&p.db_id, &a.db_id),
        (&p.source_hash, &a.source_hash),
    ] {
        assert_eq!(x, y);
    }
    assert_eq!((p.source_bytes, p.sqlite_bootstrap_rev, p.sqlite_target_rev, p.created_at), (a.source_bytes, a.sqlite_bootstrap_rev, a.sqlite_target_rev, a.created_at));
}

#[test]
fn escribir_y_leer_el_marcador_es_fiel_y_no_deja_temporal() {
    let d = carpeta("io");
    assert_eq!(read_marker(&d), MarkerRead::Absent);
    write_marker(&d, &marcador(1), ("a", "b")).unwrap();
    assert_eq!(read_marker(&d), valido(marcador(1)).clone_with_created(&d));
    assert!(!crate::orch::fsio::staging_path(&marker_path(&d)).exists());
    write_marker(&d, &confirmado(1), ("a", "b")).unwrap();
    match read_marker(&d) {
        MarkerRead::Valid(m) => assert_eq!(m.state, MarkerState::Authoritative),
        otro => panic!("{otro:?}"),
    }
    let _ = std::fs::remove_dir_all(&d);
}

trait ConCreado {
    fn clone_with_created(self, d: &std::path::Path) -> MarkerRead;
}

impl ConCreado for MarkerRead {
    /// `created_at` se fija al construir: se compara contra lo realmente leído del disco.
    fn clone_with_created(self, d: &std::path::Path) -> MarkerRead {
        match (self, read_marker(d)) {
            (MarkerRead::Valid(mut esperado), MarkerRead::Valid(leido)) => {
                esperado.created_at = leido.created_at;
                esperado.writer = leido.writer.clone();
                MarkerRead::Valid(esperado)
            }
            (x, _) => x,
        }
    }
}

#[test]
fn un_marcador_defectuoso_es_invalido_nunca_ausente() {
    let ok = serde_json::to_value(marcador(1)).unwrap();
    let con = |f: &dyn Fn(&mut serde_json::Value)| {
        let mut v = ok.clone();
        f(&mut v);
        parse_marker(v.to_string().as_bytes())
    };
    assert!(matches!(parse_marker(b"no es json"), MarkerRead::Invalid(_)));
    assert!(matches!(parse_marker(b""), MarkerRead::Invalid(_)));
    assert!(matches!(con(&|v| v["v"] = json!(2)), MarkerRead::Invalid(m) if m.contains("actualiza Lixbon")), "versión desconocida");
    assert!(matches!(con(&|v| v["v"] = json!(0)), MarkerRead::Invalid(_)));
    assert!(matches!(con(&|v| { v.as_object_mut().unwrap().remove("v"); }), MarkerRead::Invalid(_)));
    assert!(matches!(con(&|v| v["state"] = json!("committed")), MarkerRead::Invalid(_)), "estado desconocido");
    for campo in ["promotion_id", "db_id", "source_hash", "source_bytes", "sqlite_bootstrap_rev", "sqlite_target_rev", "created_at", "db", "writer"] {
        assert!(matches!(con(&|v| { v.as_object_mut().unwrap().remove(campo); }), MarkerRead::Invalid(_)), "falta {campo}");
    }
    assert!(matches!(con(&|v| v["sqlite_target_rev"] = json!(9)), MarkerRead::Invalid(_)), "target != bootstrap + 1");
    assert!(matches!(con(&|v| v["source_hash"] = json!("xyz")), MarkerRead::Invalid(_)));
    assert!(matches!(con(&|v| v["promotion_id"] = json!("")), MarkerRead::Invalid(_)));
    // «none» sí es válido (instalación nueva).
    assert!(matches!(con(&|v| { v["source_hash"] = json!("none"); v["source_bytes"] = json!(0); }), MarkerRead::Valid(_)));
}

#[test]
fn el_marcador_valida_sus_coherencias_internas_y_no_desborda() {
    let promoting = serde_json::to_value(marcador(1)).unwrap();
    let authoritative = serde_json::to_value(confirmado(1)).unwrap();
    let con = |base: &serde_json::Value, f: &dyn Fn(&mut serde_json::Value)| {
        let mut v = base.clone();
        f(&mut v);
        parse_marker(v.to_string().as_bytes())
    };
    assert!(matches!(con(&promoting, &|_| {}), MarkerRead::Valid(_)) && matches!(con(&authoritative, &|_| {}), MarkerRead::Valid(_)));
    // source_hash == "none" => source_bytes == 0 (y al revés: con legado, no vacío).
    assert!(matches!(con(&promoting, &|v| { v["source_hash"] = json!("none"); v["source_bytes"] = json!(5); }), MarkerRead::Invalid(m) if m.contains("source_bytes")));
    assert!(matches!(con(&promoting, &|v| v["source_bytes"] = json!(0)), MarkerRead::Invalid(_)), "hash real con 0 bytes");
    // Revisiones: sin envolver con i64::MAX, ni negativas.
    assert!(matches!(con(&promoting, &|v| { v["sqlite_bootstrap_rev"] = json!(i64::MAX); v["sqlite_target_rev"] = json!(i64::MIN); }), MarkerRead::Invalid(_)));
    assert!(matches!(con(&promoting, &|v| { v["sqlite_bootstrap_rev"] = json!(i64::MAX); v["sqlite_target_rev"] = json!(i64::MAX); }), MarkerRead::Invalid(_)));
    assert!(matches!(con(&promoting, &|v| { v["sqlite_bootstrap_rev"] = json!(-1); v["sqlite_target_rev"] = json!(0); }), MarkerRead::Invalid(_)));
    assert!(matches!(con(&promoting, &|v| { v["sqlite_bootstrap_rev"] = json!(i64::MAX - 1); v["sqlite_target_rev"] = json!(i64::MAX); }), MarkerRead::Valid(_)), "el último par válido");
    // El estado y `confirmed_at` deben concordar; la base es siempre lixbon.db.
    assert!(matches!(con(&promoting, &|v| v["confirmed_at"] = json!(5)), MarkerRead::Invalid(m) if m.contains("confirmed_at")));
    assert!(matches!(con(&authoritative, &|v| { v.as_object_mut().unwrap().remove("confirmed_at"); }), MarkerRead::Invalid(_)));
    assert!(matches!(con(&promoting, &|v| v["db"] = json!("otra.db")), MarkerRead::Invalid(_)));
}

#[test]
fn un_marcador_ilegible_en_disco_es_invalido() {
    let d = carpeta("ilegible");
    std::fs::write(marker_path(&d), b"{ truncado").unwrap();
    assert!(matches!(read_marker(&d), MarkerRead::Invalid(_)));
    let _ = std::fs::remove_dir_all(&d);
}

// ---------------------------------------------------------------------------
// El legado
// ---------------------------------------------------------------------------

fn estado_valido() -> Vec<u8> {
    br#"{"runs":{},"tasks":{},"messages":[],"seq":3,"decisions":[]}"#.to_vec()
}

#[test]
fn clasificar_el_legado() {
    assert_eq!(classify_legacy(None), Legacy::Absent);
    let ok = estado_valido();
    match classify_legacy(Some(&ok)) {
        Legacy::Readable { hash, bytes, has_mirror } => {
            assert_eq!((hash, bytes, has_mirror), (crate::store::sha256_hex(&ok), ok.len() as u64, false));
        }
        otro => panic!("{otro:?}"),
    }
    assert!(matches!(classify_legacy(Some(b"")), Legacy::Unreadable(_)), "vacío");
    assert!(matches!(classify_legacy(Some(&[0xff, 0xfe, 0x00])), Legacy::Unreadable(_)), "no UTF-8");
    assert!(matches!(classify_legacy(Some(b"{ truncado")), Legacy::Unreadable(_)));
    assert!(matches!(classify_legacy(Some(b"{}")), Legacy::Unreadable(_)), "JSON válido pero sin la forma de State: NO es un estado vacío");
    assert!(matches!(classify_legacy(Some(b"[1,2,3]")), Legacy::Unreadable(_)));
    let con_espejo = br#"{"runs":{},"tasks":{},"messages":[],"seq":0,"_mirror":{"rev":4}}"#;
    assert!(matches!(classify_legacy(Some(con_espejo)), Legacy::Readable { has_mirror: true, .. }));
}

// ---------------------------------------------------------------------------
// decide_boot: celdas de la tabla
// ---------------------------------------------------------------------------

#[test]
fn instalacion_nueva_promueve_con_estado_vacio() {
    let d = decide(&MarkerRead::Absent, &DbProbe::Opens(facts_bootstrap(false, None)), &Legacy::Absent, false, false);
    assert_eq!(d, Boot::PromoteFresh { fenced: false });
}

#[test]
fn legado_legible_con_instantanea_en_cualquier_rev_promueve_desde_el_legado() {
    for rev in [1, 10, 1000] {
        let d = decide(&MarkerRead::Absent, &DbProbe::Opens(facts_bootstrap(false, Some(rev))), &legible(HASH, 100), false, false);
        assert_eq!(d, Boot::Promote { fenced: false }, "bootstrap_rev {rev}: no se compara con el legado");
    }
}

#[test]
fn estado_fenced_con_marcador_ausente_continua_la_promocion_y_nunca_degrada() {
    let d = decide(&MarkerRead::Absent, &DbProbe::Opens(facts_bootstrap(true, Some(1))), &legible(HASH, 100), false, false);
    assert_eq!(d, Boot::Promote { fenced: true }, "FENCED + sin marcador + bootstrap -> continuar");
    let fresco = decide(&MarkerRead::Absent, &DbProbe::Opens(facts_bootstrap(true, None)), &Legacy::Absent, false, false);
    assert_eq!(fresco, Boot::PromoteFresh { fenced: true });
}

#[test]
fn sin_state_json_y_con_instantanea_se_bloquea_sin_promocionarla() {
    let d = decide(&MarkerRead::Absent, &DbProbe::Opens(facts_bootstrap(false, Some(1))), &Legacy::Absent, false, false);
    assert_eq!(d, Boot::Block(BlockReason::LegacyMissing));
}

#[test]
fn sin_state_json_pero_con_rastros_no_es_una_instalacion_nueva() {
    let d = decide(&MarkerRead::Absent, &DbProbe::Opens(facts_bootstrap(false, None)), &Legacy::Absent, true, false);
    assert_eq!(d, Boot::Block(BlockReason::LegacyMissing), "copias diagnosticas = rastro");
    let mut f = facts_bootstrap(false, None);
    f.has_import_meta = true;
    assert_eq!(decide(&MarkerRead::Absent, &DbProbe::Opens(f), &Legacy::Absent, false, false), Boot::Block(BlockReason::LegacyMissing));
}

#[test]
fn state_json_ilegible_bloquea_siempre_y_nunca_es_estado_vacio() {
    let ilegible = Legacy::Unreadable("x".into());
    for facts in [facts_bootstrap(false, None), facts_bootstrap(false, Some(1)), facts_bootstrap(true, Some(1))] {
        let d = decide(&MarkerRead::Absent, &DbProbe::Opens(facts), &ilegible, false, false);
        assert!(matches!(d, Boot::Block(BlockReason::LegacyUnreadable(_))), "{d:?}");
    }
    assert!(matches!(decide(&MarkerRead::Absent, &DbProbe::FileMissing, &ilegible, false, false), Boot::Block(BlockReason::LegacyUnreadable(_))));
}

#[test]
fn un_espejo_nunca_se_promociona_como_si_fuera_el_legado() {
    let espejo = Legacy::Readable { hash: HASH.into(), bytes: 1, has_mirror: true };
    let d = decide(&MarkerRead::Absent, &DbProbe::Opens(facts_bootstrap(false, Some(1))), &espejo, false, false);
    assert_eq!(d, Boot::Block(BlockReason::MirrorWithoutAuthority));
}

#[test]
fn marcador_ausente_y_base_autoritativa_valida_reconstruye_sin_comparar_pid() {
    let d = decide(&MarkerRead::Absent, &DbProbe::Opens(facts_autoritativos(1, 7)), &legible(OTRO_HASH, 5), false, false);
    assert_eq!(d, Boot::RebuildMarker, "SQLite gana; el legado no interviene");
    let mut incompleta = facts_autoritativos(1, 7);
    incompleta.auth = None;
    assert!(matches!(decide(&MarkerRead::Absent, &DbProbe::Opens(incompleta), &Legacy::Absent, false, false), Boot::Block(BlockReason::Inconsistent(_))));
}

#[test]
fn marcador_ausente_con_la_base_ilegible_solo_degrada_sin_ningun_indicio() {
    let rota = DbProbe::Unopenable("corrupta".into());
    assert_eq!(decide(&MarkerRead::Absent, &rota, &legible(HASH, 1), false, false), Boot::DegradeC1);
    assert_eq!(decide(&MarkerRead::Absent, &rota, &Legacy::Absent, false, false), Boot::DegradeC1);
    assert_eq!(decide(&MarkerRead::Absent, &rota, &legible(HASH, 1), false, true), Boot::Block(BlockReason::NotVerifiable), "backup pre-authority");
    let espejo = Legacy::Readable { hash: HASH.into(), bytes: 1, has_mirror: true };
    assert_eq!(decide(&MarkerRead::Absent, &rota, &espejo, false, false), Boot::Block(BlockReason::NotVerifiable), "_mirror");
}

#[test]
fn promoting_rehace_solo_si_se_cumplen_las_cinco_condiciones() {
    let m = valido(marcador(10));
    let ok = DbProbe::Opens(facts_bootstrap(true, Some(10)));
    assert_eq!(decide(&m, &ok, &legible(HASH, 100), false, false), Boot::Redo);
    // 1. hash distinto  2. bytes distintos
    assert_eq!(decide(&m, &ok, &legible(OTRO_HASH, 100), false, false), Boot::Block(BlockReason::LegacyChangedAfterIntent));
    assert_eq!(decide(&m, &ok, &legible(HASH, 101), false, false), Boot::Block(BlockReason::LegacyChangedAfterIntent));
    // legado borrado / ilegible
    assert_eq!(decide(&m, &ok, &Legacy::Absent, false, false), Boot::Block(BlockReason::LegacyChangedAfterIntent));
    assert!(matches!(decide(&m, &ok, &Legacy::Unreadable("x".into()), false, false), Boot::Block(BlockReason::LegacyUnreadable(_))));
    // 3. la base ya no es bootstrap / 4. rev distinta
    assert!(bloquea(&decide(&m, &DbProbe::Opens(facts_bootstrap(true, Some(11))), &legible(HASH, 100), false, false)));
    assert!(bloquea(&decide(&m, &DbProbe::Opens(facts_bootstrap(true, Some(1))), &legible(HASH, 100), false, false)));
    // 5. db_id distinto
    let mut otra = facts_bootstrap(true, Some(10));
    otra.db_id = Some("OTRA".into());
    assert!(bloquea(&decide(&m, &DbProbe::Opens(otra), &legible(HASH, 100), false, false)));
    // sin cruzar la valla
    assert!(bloquea(&decide(&m, &DbProbe::Opens(facts_bootstrap(false, Some(10))), &legible(HASH, 100), false, false)));
}

#[test]
fn promoting_de_instalacion_nueva_exige_que_siga_sin_legado() {
    let mut p = plan(0);
    p.source_hash = NO_SOURCE.into();
    p.source_bytes = 0;
    let m = valido(Marker::promoting(&p, "DB1"));
    let sin_fila = DbProbe::Opens(facts_bootstrap(true, None));
    assert_eq!(decide(&m, &sin_fila, &Legacy::Absent, false, false), Boot::Redo);
    assert_eq!(decide(&m, &sin_fila, &legible(HASH, 100), false, false), Boot::Block(BlockReason::LegacyChangedAfterIntent), "apareció un state.json");
    assert!(bloquea(&decide(&m, &DbProbe::Opens(facts_bootstrap(true, Some(1))), &Legacy::Absent, false, false)), "apareció una fila");
}

#[test]
fn promoting_con_commit_hecho_completa_t3_aunque_la_rev_haya_avanzado() {
    let m = valido(marcador(1));
    assert_eq!(decide(&m, &DbProbe::Opens(facts_autoritativos(1, 2)), &Legacy::Absent, false, false), Boot::Complete);
    assert_eq!(decide(&m, &DbProbe::Opens(facts_autoritativos(1, 40)), &Legacy::Absent, false, false), Boot::Complete, "el Core siguió mutando con T3 pendiente");
    let mut otra_promocion = facts_autoritativos(1, 2);
    otra_promocion.auth.as_mut().unwrap().promotion_id = "OTRA".into();
    assert!(bloquea(&decide(&m, &DbProbe::Opens(otra_promocion), &Legacy::Absent, false, false)));
}

#[test]
fn promoting_con_la_base_perdida_o_ilegible_bloquea() {
    let m = valido(marcador(1));
    assert!(matches!(decide(&m, &DbProbe::FileMissing, &legible(HASH, 100), false, false), Boot::Block(BlockReason::Inconsistent(_))));
    assert_eq!(decide(&m, &DbProbe::Unopenable("x".into()), &legible(HASH, 100), false, false), Boot::Block(BlockReason::NotVerifiable));
}

#[test]
fn authoritative_normal_y_sus_contradicciones() {
    let m = valido(confirmado(1));
    assert_eq!(decide(&m, &DbProbe::Opens(facts_autoritativos(1, 2)), &Legacy::Absent, false, false), Boot::Normal);
    assert_eq!(decide(&m, &DbProbe::Opens(facts_autoritativos(1, 500)), &legible(OTRO_HASH, 3), false, false), Boot::Normal, "el legado no interviene");
    // C9: base restaurada de antes de la promoción.
    assert!(matches!(decide(&m, &DbProbe::Opens(facts_bootstrap(false, Some(1))), &legible(HASH, 100), false, false), Boot::Block(BlockReason::Inconsistent(_))));
    assert!(bloquea(&decide(&m, &DbProbe::Opens(facts_bootstrap(true, Some(1))), &legible(HASH, 100), false, false)));
    assert!(bloquea(&decide(&m, &DbProbe::Opens(facts_bootstrap(true, None)), &Legacy::Absent, false, false)));
    // C10: base anterior al marcador (rev < target).
    assert!(bloquea(&decide(&m, &DbProbe::Opens(facts_autoritativos(1, 1)), &Legacy::Absent, false, false)));
    // C11: db_id distinto.
    let mut otra = facts_autoritativos(1, 2);
    otra.db_id = Some("OTRA".into());
    assert!(bloquea(&decide(&m, &DbProbe::Opens(otra), &Legacy::Absent, false, false)));
    // C1: autoritativa y luego ilegible / perdida.
    assert_eq!(decide(&m, &DbProbe::Unopenable("x".into()), &legible(HASH, 100), false, false), Boot::Block(BlockReason::NotVerifiable));
    assert!(bloquea(&decide(&m, &DbProbe::FileMissing, &legible(HASH, 100), false, false)));
}

#[test]
fn un_marcador_invalido_bloquea_en_toda_situacion() {
    let inv = MarkerRead::Invalid("x".into());
    for probe in [DbProbe::FileMissing, DbProbe::Unopenable("x".into()), DbProbe::Opens(facts_bootstrap(false, None)), DbProbe::Opens(facts_autoritativos(1, 2))] {
        assert!(matches!(decide(&inv, &probe, &Legacy::Absent, false, false), Boot::Block(BlockReason::MarkerInvalid(_))));
    }
}

#[test]
fn ningun_mensaje_de_bloqueo_sugiere_borrar_el_marcador() {
    let todos = [
        BlockReason::MarkerInvalid("x".into()),
        BlockReason::LegacyUnreadable("x".into()),
        BlockReason::LegacyMissing,
        BlockReason::LegacyChangedAfterIntent,
        BlockReason::NotVerifiable,
        BlockReason::Inconsistent("x".into()),
        BlockReason::MirrorWithoutAuthority,
    ];
    for r in todos {
        let m = r.to_string().to_lowercase();
        assert!(!m.contains("borra") && !m.contains("elimina") && !m.contains("authority.json"), "{m}");
    }
}

// ---------------------------------------------------------------------------
// Prueba de propiedad
// ---------------------------------------------------------------------------

fn marcadores() -> Vec<MarkerRead> {
    let mut v = vec![MarkerRead::Absent, MarkerRead::Invalid("x".into())];
    for boot in [0, 1, 10, 1000] {
        v.push(valido(marcador(boot)));
        v.push(valido(confirmado(boot)));
    }
    let mut sin_legado = plan(0);
    sin_legado.source_hash = NO_SOURCE.into();
    sin_legado.source_bytes = 0;
    v.push(valido(Marker::promoting(&sin_legado, "DB1")));
    v
}

fn sondas() -> Vec<DbProbe> {
    let mut v = vec![DbProbe::FileMissing, DbProbe::Unopenable("x".into())];
    for fenced in [false, true] {
        for db_id in [Some("DB1"), Some("OTRA"), None] {
            for row in [None, Some(1), Some(2), Some(10), Some(11), Some(1000)] {
                for mode in [None, Some(BOOTSTRAP), Some("raro"), Some(MODE_SQLITE_AUTHORITATIVE)] {
                    for auth_boot in [None, Some(0), Some(1), Some(10), Some(1000)] {
                        for otra_promocion in [false, true] {
                            let mut a = auth_boot.map(auth);
                            if otra_promocion {
                                if let Some(a) = a.as_mut() {
                                    a.promotion_id = "OTRA".into();
                                }
                            }
                            v.push(DbProbe::Opens(AuthorityFacts {
                                db_version: if fenced { 2 } else { 1 },
                                fenced,
                                db_id: db_id.map(String::from),
                                row_rev: row,
                                mode: mode.map(String::from),
                                auth: a,
                                has_import_meta: row.is_some(),
                            }));
                        }
                    }
                }
            }
        }
    }
    v
}

fn legados() -> Vec<Legacy> {
    vec![
        Legacy::Absent,
        Legacy::Unreadable("x".into()),
        legible(HASH, 100),
        legible(OTRO_HASH, 100),
        legible(HASH, 7),
        Legacy::Readable { hash: HASH.into(), bytes: 100, has_mirror: true },
    ]
}

fn usa_state_json(b: &Boot) -> bool {
    matches!(b, Boot::Promote { .. } | Boot::PromoteFresh { .. } | Boot::Redo | Boot::DegradeC1)
}

/// El invariante central: se enumera marcador × base × legado × rastros × indicios y
/// se comprueba, para CADA combinación, bajo qué condiciones `state.json` puede ser
/// la fuente de algo. Un camino nuevo hacia `state.json` rompe esta prueba.
#[test]
fn propiedad_state_json_solo_es_fuente_en_promover_rehacer_o_degradar_c1() {
    let (mut total, mut con_state_json) = (0, 0);
    for marker in marcadores() {
        for probe in sondas() {
            for legacy in legados() {
                for traces in [false, true] {
                    for evidence in [false, true] {
                        total += 1;
                        let d = decide(&marker, &probe, &legacy, traces, evidence);
                        let ctx = format!("{marker:?}\n{probe:?}\n{legacy:?} traces={traces} evidence={evidence}\n=> {d:?}");

                        // (c) Con marcador `authoritative`, jamás se usa state.json.
                        if matches!(&marker, MarkerRead::Valid(m) if m.state == MarkerState::Authoritative) {
                            assert!(matches!(d, Boot::Normal | Boot::Block(_)), "{ctx}");
                        }
                        // Con marcador inválido, siempre bloquea.
                        if matches!(marker, MarkerRead::Invalid(_)) {
                            assert!(bloquea(&d), "{ctx}");
                        }
                        // Con la base autoritativa y consultable, jamás se usa state.json.
                        if let DbProbe::Opens(f) = &probe {
                            if f.mode.as_deref() == Some(MODE_SQLITE_AUTHORITATIVE) {
                                assert!(!usa_state_json(&d), "{ctx}");
                            }
                        }
                        if usa_state_json(&d) {
                            con_state_json += 1;
                            match &d {
                                // (b) Degradar C1: solo sin marcador, sin indicios y con la base ilegible.
                                Boot::DegradeC1 => {
                                    assert!(matches!(marker, MarkerRead::Absent), "{ctx}");
                                    assert!(matches!(probe, DbProbe::Unopenable(_)), "{ctx}");
                                    assert!(!evidence && !matches!(legacy, Legacy::Readable { has_mirror: true, .. }), "{ctx}");
                                }
                                // (a) Promover/Rehacer: marcador ausente o promoting; el legado legible o ausente y nunca un espejo.
                                Boot::Promote { .. } | Boot::PromoteFresh { .. } | Boot::Redo => {
                                    assert!(matches!(&marker, MarkerRead::Absent | MarkerRead::Valid(Marker { state: MarkerState::Promoting, .. })), "{ctx}");
                                    assert!(!matches!(legacy, Legacy::Unreadable(_) | Legacy::Readable { has_mirror: true, .. }), "{ctx}");
                                    assert!(matches!(probe, DbProbe::Opens(_) | DbProbe::FileMissing), "{ctx}");
                                    if let DbProbe::Opens(f) = &probe {
                                        assert!(matches!(f.mode.as_deref(), None | Some(BOOTSTRAP)), "{ctx}");
                                    }
                                }
                                _ => unreachable!(),
                            }
                            // Rehacer: identidad exacta del legado y de la fila.
                            if let (Boot::Redo, MarkerRead::Valid(m)) = (&d, &marker) {
                                match &legacy {
                                    Legacy::Readable { hash, bytes, .. } => assert!(*hash == m.source_hash && *bytes == m.source_bytes, "{ctx}"),
                                    Legacy::Absent => assert_eq!(m.source_hash, NO_SOURCE, "{ctx}"),
                                    _ => panic!("{ctx}"),
                                }
                                let DbProbe::Opens(f) = &probe else { panic!("{ctx}") };
                                assert!(f.fenced && f.db_id.as_deref() == Some(m.db_id.as_str()), "{ctx}");
                                assert_eq!(f.row_rev.unwrap_or(0), m.sqlite_bootstrap_rev, "{ctx}");
                            }
                            // Un `promoting` jamás cae a Promover (que escribiría una intención nueva sin comprobar nada).
                            if matches!(&marker, MarkerRead::Valid(m) if m.state == MarkerState::Promoting) {
                                assert!(matches!(d, Boot::Redo), "{ctx}");
                            }
                        }
                        // (d) Normal ⇒ marcador authoritative que coincide con la base.
                        if matches!(d, Boot::Normal) {
                            let (MarkerRead::Valid(m), DbProbe::Opens(f)) = (&marker, &probe) else { panic!("{ctx}") };
                            assert!(m.state == MarkerState::Authoritative && m.matches(f) && f.fenced, "{ctx}");
                        }
                        // Complete ⇒ marcador promoting que coincide con la base autoritativa.
                        if matches!(d, Boot::Complete) {
                            let (MarkerRead::Valid(m), DbProbe::Opens(f)) = (&marker, &probe) else { panic!("{ctx}") };
                            assert!(m.state == MarkerState::Promoting && m.matches(f), "{ctx}");
                        }
                    }
                }
            }
        }
    }
    assert!(total > 100_000, "la enumeración es exhaustiva: {total} combinaciones");
    assert!(con_state_json > 0 && con_state_json < total);
}

/// La decisión no depende de ninguna relación entre `bootstrap_rev` y el contenido
/// del legado: con marcador ausente, el `rev` de la fila de C1 no cambia el resultado.
#[test]
fn propiedad_el_rev_de_la_instantanea_de_c1_no_condiciona_la_promocion() {
    for legacy in legados() {
        for fenced in [false, true] {
            let referencia = decide(&MarkerRead::Absent, &DbProbe::Opens(facts_bootstrap(fenced, Some(1))), &legacy, false, false);
            for rev in [2, 10, 13, 1000, i64::MAX / 2] {
                let d = decide(&MarkerRead::Absent, &DbProbe::Opens(facts_bootstrap(fenced, Some(rev))), &legacy, false, false);
                assert_eq!(d, referencia, "bootstrap_rev {rev} con {legacy:?}");
            }
        }
    }
}

/// Con marcador `promoting`, la fila solo importa por su igualdad con `sqlite_bootstrap_rev`
/// (la fila de ANTES de la intención), nunca por su relación con el legado.
#[test]
fn propiedad_promoting_exige_que_la_fila_siga_en_el_rev_fijado() {
    for boot in [1, 10, 13, 1000] {
        let m = valido(marcador(boot));
        for fila in [1, 2, 10, 11, 13, 14, 1000, 1001] {
            let d = decide(&m, &DbProbe::Opens(facts_bootstrap(true, Some(fila))), &legible(HASH, 100), false, false);
            if fila == boot {
                assert_eq!(d, Boot::Redo, "boot {boot}");
            } else {
                assert!(bloquea(&d), "boot {boot}, fila {fila}: {d:?}");
            }
        }
    }
}

#[test]
fn el_target_siempre_es_bootstrap_mas_uno() {
    for boot in [0, 1, 10, 1000] {
        let p = plan(boot);
        assert_eq!(p.sqlite_target_rev, p.sqlite_bootstrap_rev + 1);
        let m = Marker::promoting(&p, "DB1");
        assert_eq!(m.sqlite_target_rev, m.sqlite_bootstrap_rev + 1);
    }
}

#[test]
fn reconstruir_el_marcador_desde_la_base_describe_la_misma_promocion() {
    let f = facts_autoritativos(10, 15);
    let m = Marker::from_database(&f, f.auth.as_ref().unwrap()).unwrap();
    assert_eq!(m.state, MarkerState::Authoritative);
    assert!(m.matches(&f), "el marcador reconstruido coincide con la base de la que salió");
    assert_eq!(decide(&valido(m), &DbProbe::Opens(f), &Legacy::Absent, false, false), Boot::Normal);
}
