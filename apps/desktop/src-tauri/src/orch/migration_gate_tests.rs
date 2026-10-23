//! Gate de entrada del slice D: ninguna migración posterior a la valla (003+) se aplica mientras
//! `authority.json` y SQLite no sean coherentes. Se prueba con una 003 FICTICIA (`gate_probe`) que
//! se inyecta en el catálogo del Core: el protocolo se demuestra antes de que exista ninguna
//! migración real de D.
//!
//! Orden que se fija (ver la cabecera de `boot_authority.rs`): abrir con el techo en la valla →
//! `decide_boot` → intento de acción sobre el marcador → migraciones 003+. El invariante es que
//! `decide_boot` haya demostrado que no hay contradicción; que el marcador quede PUBLICADO no es
//! condición (semántica de C2b: `marker_pending` se reintenta en el arranque siguiente).
//!
//! Cada caso BLOQUEADO comprueba lo mismo: el arranque falla, la base sigue en la 002, no hay
//! ninguna fila 003 en `schema_migrations`, la tabla de la 003 no existe, `state.json` y el
//! marcador son byte a byte los de antes, y el Core no cayó a `state.json` (no hay degradación).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use super::authority::{marker_path, read_marker, MarkerRead, MarkerState};
use super::boot_authority::{promote_in_store, PromoteCtx};
use super::boot_tests::*;
use super::store_boot::StorageStatus;
use super::{Core, Orch};
use crate::store::{self, Migration, Store};

const SQL_003: &str = "CREATE TABLE gate_probe (id TEXT PRIMARY KEY) STRICT;";
/// Una 003 que falla a mitad: la primera sentencia crea la tabla, la segunda no puede ejecutarse.
const SQL_003_MALA: &str = "CREATE TABLE gate_probe (id TEXT PRIMARY KEY) STRICT; INSERT INTO tabla_que_no_existe VALUES (1);";

/// Lo que conoce un binario anterior a D: solo hasta la valla.
fn hasta_la_valla() -> Vec<Migration> {
    store::embedded().into_iter().filter(|m| m.version <= store::FENCE_VERSION).collect()
}

/// «La primera migración posterior a la valla» de PRUEBA: ocupa la 003 en lugar de la real, para
/// demostrar el protocolo sin depender de lo que haga D.
fn con_003(sql: &'static str) -> Vec<Migration> {
    let mut todas = hasta_la_valla();
    todas.push(Migration::new(3, "gate_probe", sql));
    todas
}

/// Arranca un Core cuyo binario «conoce» la lista de migraciones dada.
fn arranca_con(catalogo: Vec<Migration>, data: &Path, core: &Path) -> (Arc<Core>, Result<(), String>) {
    let c = Orch::default().0;
    c.storage.set_catalog(catalogo);
    let r = c.init_in(super::host::RecordingHost::new(), data, core);
    (c, r)
}

/// `(user_version, filas >= 003 en schema_migrations, existe la tabla de la 003)`. Solo con el Core suelto.
fn base(core: &Path) -> (i64, i64, bool) {
    let c = rusqlite::Connection::open(core.join("lixbon.db")).unwrap();
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    let filas: i64 = c.query_row("SELECT COUNT(*) FROM schema_migrations WHERE version >= 3", [], |r| r.get(0)).unwrap();
    let tabla: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'gate_probe'", [], |r| r.get(0)).unwrap();
    (v, filas, tabla > 0)
}

const SIN_LA_003: (i64, i64, bool) = (2, 0, false);
const CON_LA_003: (i64, i64, bool) = (3, 1, true);

/// Una instalación ya promovida (SQLite autoritativa, marcador `authoritative`, base en la 002):
/// la deja un binario que solo conoce hasta la valla.
fn promovida_en_la_002() -> (Limpia, PathBuf, PathBuf) {
    let (l, data, core) = dirs();
    legado_con(&data, "propia");
    let (c, r) = arranca_con(hasta_la_valla(), &data, &core);
    r.unwrap();
    assert!(matches!(c.storage_status(), StorageStatus::Ready(_)));
    suelta(c, &core);
    assert_eq!(base(&core), SIN_LA_003, "punto de partida: promovida y en la 002");
    (l, data, core)
}

fn edita_marcador(core: &Path, f: impl FnOnce(&mut Value)) {
    let ruta = marker_path(core);
    let mut v: Value = serde_json::from_slice(&std::fs::read(&ruta).unwrap()).unwrap();
    f(&mut v);
    std::fs::write(&ruta, serde_json::to_vec_pretty(&v).unwrap()).unwrap();
}

/// El arranque con la 003 ficticia DEBE bloquear sin tocar nada. `esperado` es parte del motivo.
fn bloquea_sin_tocar(data: &Path, core: &Path, esperado: &str, caso: &str) {
    let marcador_antes = std::fs::read(marker_path(core)).ok();
    let estado_antes = std::fs::read(data.join("state.json")).ok();
    let version_antes = base(core).0;
    let (c, r) = arranca_con(con_003(SQL_003), data, core);
    let e = r.expect_err(caso);
    assert!(e.contains(esperado), "{caso}: el motivo debía mencionar «{esperado}» y es: {e}");
    assert!(!matches!(c.storage_status(), StorageStatus::Degraded(_)), "{caso}: un arranque bloqueado no degrada a state.json");
    suelta(c, core);
    let (v, filas, tabla) = base(core);
    assert_eq!(v, version_antes, "{caso}: la versión de la base no cambió");
    assert_eq!((filas, tabla), (0, false), "{caso}: ninguna migración de D se tocó");
    assert_eq!(std::fs::read(data.join("state.json")).ok(), estado_antes, "{caso}: state.json es el de antes, byte a byte");
    assert_eq!(std::fs::read(marker_path(core)).ok(), marcador_antes, "{caso}: el marcador es el de antes, byte a byte");
}

// ---------------------------------------------------------------------------------------------
// 1. Autoridad coherente: la única ruta que migra
// ---------------------------------------------------------------------------------------------

#[test]
fn sqlite_autoritativo_con_marcador_coherente_aplica_la_003_y_reinicia_sin_cambios() {
    let (_l, data, core) = promovida_en_la_002();
    let marcador_antes = marcador(&core);

    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    assert_eq!(titulos(&c), vec!["propia".to_string()], "el estado sale de SQLite");
    suelta(c, &core);
    assert_eq!(base(&core), CON_LA_003, "marcador coherente: se aplica la 003");
    assert_eq!(marcador(&core).promotion_id, marcador_antes.promotion_id, "la misma promoción");
    let copias = archivos(&core.join("backups"));
    assert!(copias.iter().any(|n| n.contains("pre-migracion-v2")), "la migración deja su copia previa: {copias:?}");

    // Reinicio: idempotente.
    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    suelta(c, &core);
    assert_eq!(base(&core), CON_LA_003, "reiniciar no repite ni cambia nada");
}

#[test]
fn una_base_ya_migrada_no_se_abre_con_un_binario_que_no_conoce_la_003_ni_hay_bajada_implicita() {
    let (_l, data, core) = promovida_en_la_002();
    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    suelta(c, &core);

    // Un binario anterior (solo 001 y 002): versión futura -> bloqueante, y la base no se toca.
    let estado = std::fs::read(data.join("state.json")).unwrap();
    let (c, r) = arranca_con(hasta_la_valla(), &data, &core);
    let e = r.expect_err("la 003 es futura para ese binario");
    assert!(e.contains("más nueva"), "{e}");
    suelta(c, &core);
    assert_eq!(base(&core), CON_LA_003, "no hay bajada implícita de versión");
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), estado);
}

// ---------------------------------------------------------------------------------------------
// 2. Marcador contradictorio / inválido / futuro / promoting incompatible: bloquea y NO migra
// ---------------------------------------------------------------------------------------------

#[test]
fn marcador_valido_pero_contradictorio_con_sqlite_bloquea_y_la_base_sigue_en_la_002() {
    let casos: [(&str, fn(&mut Value)); 4] = [
        ("promotion_id distinto", |v| v["promotion_id"] = json!("otra-promocion")),
        ("db_id distinto", |v| v["db_id"] = json!("otra-base")),
        ("source_hash distinto", |v| v["source_hash"] = json!("ab".repeat(32))),
        ("revisiones distintas", |v| {
            v["sqlite_bootstrap_rev"] = json!(7);
            v["sqlite_target_rev"] = json!(8);
        }),
    ];
    for (nombre, rompe) in casos {
        let (_l, data, core) = promovida_en_la_002();
        edita_marcador(&core, rompe);
        assert!(matches!(read_marker(&core), MarkerRead::Valid(_)), "{nombre}: el marcador sigue siendo VÁLIDO por sí solo");
        bloquea_sin_tocar(&data, &core, "se contradicen", nombre);
    }
}

#[test]
fn marcador_malformado_bloquea_y_la_base_sigue_en_la_002() {
    let casos: [(&str, Vec<u8>); 4] = [
        ("JSON truncado", b"{\"v\":1,\"state\":".to_vec()),
        ("no es un objeto", b"[]".to_vec()),
        ("vacío", Vec::new()),
        ("basura binaria", vec![0xff, 0xfe, 0x00, 0x01]),
    ];
    for (nombre, bytes) in casos {
        let (_l, data, core) = promovida_en_la_002();
        std::fs::write(marker_path(&core), &bytes).unwrap();
        bloquea_sin_tocar(&data, &core, "marcador de autoridad no es válido", nombre);
    }
    // Falta un campo obligatorio.
    let (_l, data, core) = promovida_en_la_002();
    edita_marcador(&core, |v| {
        v.as_object_mut().unwrap().remove("db_id");
    });
    bloquea_sin_tocar(&data, &core, "marcador de autoridad no es válido", "falta db_id");
}

#[test]
fn marcador_de_version_futura_o_estado_desconocido_bloquea_y_la_base_sigue_en_la_002() {
    let casos: [(&str, fn(&mut Value), &str); 3] = [
        ("versión futura", |v| v["v"] = json!(2), "actualiza Lixbon"),
        ("sin versión válida", |v| v["v"] = json!(0), "marcador de autoridad no es válido"),
        ("estado desconocido", |v| v["state"] = json!("committed"), "marcador de autoridad no es válido"),
    ];
    for (nombre, rompe, esperado) in casos {
        let (_l, data, core) = promovida_en_la_002();
        edita_marcador(&core, rompe);
        bloquea_sin_tocar(&data, &core, esperado, nombre);
    }
}

#[test]
fn marcador_promoting_incompatible_bloquea_y_uno_compatible_se_completa_antes_de_migrar() {
    // Incompatible: dice «promoting» de una promoción que no es la de la base.
    let incompatibles: [(&str, fn(&mut Value)); 2] = [
        ("otra promoción", |v| v["promotion_id"] = json!("otra-promocion")),
        ("otra base", |v| v["db_id"] = json!("otra-base")),
    ];
    for (nombre, rompe) in incompatibles {
        let (_l, data, core) = promovida_en_la_002();
        edita_marcador(&core, |v| {
            v["state"] = json!("promoting");
            v.as_object_mut().unwrap().remove("confirmed_at");
            rompe(v);
        });
        bloquea_sin_tocar(&data, &core, "se contradicen", nombre);
    }

    // Compatible: el COMMIT ya ocurrió y la caída fue antes de confirmar el marcador. Primero se
    // determina esa coherencia (y se confirma el marcador); solo entonces migra.
    let (_l, data, core) = promovida_en_la_002();
    edita_marcador(&core, |v| {
        v["state"] = json!("promoting");
        v.as_object_mut().unwrap().remove("confirmed_at");
    });
    assert_eq!(marcador(&core).state, MarkerState::Promoting);
    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    suelta(c, &core);
    assert_eq!(marcador(&core).state, MarkerState::Authoritative, "el marcador se confirmó");
    assert_eq!(base(&core), CON_LA_003, "y después se aplicó la 003");
}

// ---------------------------------------------------------------------------------------------
// 3. Estados anteriores a la autoridad: FENCED y LEGACY no reciben la 003
// ---------------------------------------------------------------------------------------------

/// FENCED que no puede completar la promoción (su `state.json` es ilegible): la 003 no se aplica.
#[test]
fn fenced_sin_promocion_completada_no_recibe_la_003() {
    let (_l, data, core) = dirs();
    legado_con(&data, "previa");
    instantanea_de_c1(&core, &data.join("state.json"), 1);
    // Cruza la valla (002) sin llegar a promover: justo lo que deja una caída entre la valla y `promoting`.
    drop(Store::open_with(&core, &hasta_la_valla(), "t").unwrap());
    assert_eq!(base(&core), SIN_LA_003, "FENCED: en la 002");
    std::fs::write(data.join("state.json"), b"{{ esto no es un estado").unwrap();

    bloquea_sin_tocar(&data, &core, "state.json", "FENCED con legado ilegible");
}

/// LEGACY (aún en la 001, sin valla): ni la 002 ni la 003; nada de D se cuela antes del protocolo.
#[test]
fn legacy_no_recibe_la_003_ni_la_valla_si_el_arranque_bloquea() {
    let (_l, data, core) = dirs();
    legado_con(&data, "previa");
    instantanea_de_c1(&core, &data.join("state.json"), 1);
    assert_eq!(base(&core).0, 1, "LEGACY: en la 001");
    std::fs::write(data.join("state.json"), b"{{ esto no es un estado").unwrap();

    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.expect_err("legado ilegible");
    assert!(!matches!(c.storage_status(), StorageStatus::Degraded(_)));
    suelta(c, &core);
    assert_eq!(base(&core), (1, 0, false), "ni siquiera la valla: sigue en la 001");
}

/// Control positivo del orden: la promoción (valla incluida) deja la base en la 002; la 003 NO
/// forma parte de ella. Solo la pide el arranque después, con `migrate_authoritative`.
#[test]
fn la_promocion_deja_la_base_en_la_002_y_la_003_solo_llega_por_el_gate() {
    let (_l, data, core) = dirs();
    let bytes = legado_con(&data, "previa");
    let mut s = Store::open_with(&core, &db_version_c1(), "t").unwrap();
    let ctx = PromoteCtx { core: &core, data: &data, legacy_bytes: Some(&bytes), resume: None };
    promote_in_store(&mut s, &ctx).unwrap_or_else(|_| panic!("la promoción debía completarse"));
    assert_eq!(s.schema_version().unwrap(), 2, "tras promover: valla (002), nada más");
    s.read(|c| {
        assert!(c.prepare("SELECT 1 FROM gate_probe").is_err(), "la 003 no es parte de la promoción");
        Ok(())
    })
    .unwrap();
    s.migrate_authoritative(&con_003(SQL_003), "t").unwrap();
    assert_eq!(s.schema_version().unwrap(), 3, "el gate sí la aplica");
}

/// Un arranque LEGACY limpio que SÍ puede promover termina autoritativo y entonces migra, en el
/// mismo arranque: no se queda con un esquema a medias para el código de D.
#[test]
fn un_arranque_legacy_que_promueve_con_exito_termina_en_la_003() {
    let (_l, data, core) = dirs();
    legado_con(&data, "previa");
    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    assert_eq!(titulos(&c), vec!["previa".to_string()]);
    suelta(c, &core);
    assert_eq!(base(&core), CON_LA_003);
    assert_eq!(marcador(&core).state, MarkerState::Authoritative);
}

// ---------------------------------------------------------------------------------------------
// 4. Marcador ausente: recuperación desde SQLite y orden marcador -> migración
// ---------------------------------------------------------------------------------------------

#[test]
fn marcador_ausente_con_sqlite_autoritativo_se_reconstruye_y_despues_migra() {
    let (_l, data, core) = promovida_en_la_002();
    let promocion = marcador(&core).promotion_id;
    std::fs::remove_file(marker_path(&core)).unwrap();

    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    assert_eq!(titulos(&c), vec!["propia".to_string()]);
    suelta(c, &core);
    let m = marcador(&core);
    assert_eq!((m.state, m.promotion_id), (MarkerState::Authoritative, promocion), "marcador reconstruido desde SQLite");
    assert_eq!(base(&core), CON_LA_003);
}

/// El ORDEN del intento, demostrado: si la migración falla con el marcador ausente, el marcador ya
/// se había reconstruido (paso 3 antes del 4) y la base sigue en la 002.
#[test]
fn con_el_marcador_ausente_el_marcador_se_publica_antes_de_migrar() {
    let (_l, data, core) = promovida_en_la_002();
    std::fs::remove_file(marker_path(&core)).unwrap();

    let (c, r) = arranca_con(con_003(SQL_003_MALA), &data, &core);
    r.expect_err("la 003 falla");
    suelta(c, &core);
    assert_eq!(base(&core), SIN_LA_003, "la transacción se deshizo entera");
    assert_eq!(marcador(&core).state, MarkerState::Authoritative, "el marcador, derivado de SQLite, ya estaba publicado");
}

// ---------------------------------------------------------------------------------------------
// 4b. Publicación del marcador pendiente (`marker_pending`): migra igual y se reintenta
// ---------------------------------------------------------------------------------------------

/// Hace fallar de forma determinista la publicación del marcador: un DIRECTORIO donde iría el
/// temporal (`authority.json.tmp`) impide crearlo, y `clean_staging` no puede borrarlo.
fn impide_publicar_el_marcador(core: &Path) -> PathBuf {
    let estorbo = super::fsio::staging_path(&marker_path(core));
    std::fs::create_dir_all(&estorbo).unwrap();
    estorbo
}

fn marker_pending(c: &Core) -> bool {
    match c.storage_status() {
        StorageStatus::Ready(r) => r.marker_pending,
        otro => panic!("se esperaba Ready y es {otro:?}"),
    }
}

/// Marcador AUSENTE y la reconstrucción no se puede publicar: SQLite manda, `decide_boot` no vio
/// contradicción alguna, así que la 003 se aplica con `marker_pending`; el arranque siguiente
/// (ya sin el estorbo) reconstruye el marcador.
#[test]
fn con_la_publicacion_pendiente_el_marcador_ausente_no_impide_migrar_y_se_reconstruye_despues() {
    let (_l, data, core) = promovida_en_la_002();
    std::fs::remove_file(marker_path(&core)).unwrap();
    let estorbo = impide_publicar_el_marcador(&core);

    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    assert!(marker_pending(&c), "la publicación quedó pendiente");
    assert_eq!(titulos(&c), vec!["propia".to_string()]);
    suelta(c, &core);
    assert_eq!(base(&core), CON_LA_003, "SQLite es la autoridad: se migró aunque el marcador no se publicó");
    assert!(matches!(read_marker(&core), MarkerRead::Absent), "y el marcador sigue ausente");

    std::fs::remove_dir_all(&estorbo).unwrap();
    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    assert!(!marker_pending(&c));
    suelta(c, &core);
    assert_eq!(marcador(&core).state, MarkerState::Authoritative, "el siguiente arranque reconstruye el marcador");
    assert_eq!(base(&core), CON_LA_003);
}

/// `promoting` COHERENTE con un COMMIT ya hecho y la confirmación no se puede publicar: se migra con
/// `marker_pending` y el marcador sigue en `promoting`; el arranque siguiente lo confirma (`Complete`).
#[test]
fn con_la_publicacion_pendiente_un_promoting_coherente_no_impide_migrar_y_se_confirma_despues() {
    let (_l, data, core) = promovida_en_la_002();
    edita_marcador(&core, |v| {
        v["state"] = json!("promoting");
        v.as_object_mut().unwrap().remove("confirmed_at");
    });
    let estorbo = impide_publicar_el_marcador(&core);

    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    assert!(marker_pending(&c));
    suelta(c, &core);
    assert_eq!(base(&core), CON_LA_003);
    assert_eq!(marcador(&core).state, MarkerState::Promoting, "la confirmación quedó pendiente");

    std::fs::remove_dir_all(&estorbo).unwrap();
    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    assert!(!marker_pending(&c));
    suelta(c, &core);
    assert_eq!(marcador(&core).state, MarkerState::Authoritative, "el siguiente arranque confirma el marcador");
    assert_eq!(base(&core), CON_LA_003, "y reiniciar no repite la migración");
}

/// La publicación pendiente NO relaja ningún bloqueo: con un marcador contradictorio el estorbo es
/// irrelevante, porque `decide_boot` bloquea antes de intentar publicar nada.
#[test]
fn la_publicacion_pendiente_no_relaja_un_bloqueo_por_contradiccion() {
    let (_l, data, core) = promovida_en_la_002();
    edita_marcador(&core, |v| v["promotion_id"] = json!("otra-promocion"));
    impide_publicar_el_marcador(&core);
    bloquea_sin_tocar(&data, &core, "se contradicen", "contradictorio con publicación imposible");
}

// ---------------------------------------------------------------------------------------------
// 4c. La 003 REAL (registro de proyectos) por el mismo camino
// ---------------------------------------------------------------------------------------------

fn tablas_de_proyectos(core: &Path) -> (i64, i64) {
    let c = rusqlite::Connection::open(core.join("lixbon.db")).unwrap();
    let n = |t: &str| c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1", [t], |r| r.get(0)).unwrap();
    (n("projects"), n("project_locations"))
}

/// Una instalación en la 002 (autoritativa) sube a la 003 real con el binario de D: conserva su
/// estado, deja la copia previa, reiniciar no repite nada y un binario anterior ya no la abre.
#[test]
fn la_003_real_actualiza_desde_la_002_conserva_el_estado_y_bloquea_a_los_binarios_anteriores() {
    let (_l, data, core) = promovida_en_la_002();
    assert_eq!(tablas_de_proyectos(&core), (0, 0));
    let marcador_antes = marcador(&core);

    let (c, r) = arranca_con(store::embedded(), &data, &core);
    r.unwrap();
    assert_eq!(titulos(&c), vec!["propia".to_string()], "el estado se conserva");
    suelta(c, &core);
    assert_eq!(base(&core).0, (store::cut_migration().version - 1), "sube a la última migración del binario");
    assert_eq!(tablas_de_proyectos(&core), (1, 1), "y aparecen las dos tablas de D");
    assert!(archivos(&core.join("backups")).iter().any(|n| n.contains("pre-migracion-v2")), "copia previa de la migración");
    assert_eq!(marcador(&core).promotion_id, marcador_antes.promotion_id, "la autoridad no cambia");

    // Reinicio: nada que migrar.
    let (c, r) = arranca_con(store::embedded(), &data, &core);
    r.unwrap();
    suelta(c, &core);
    assert_eq!(tablas_de_proyectos(&core), (1, 1));

    // Un binario que solo llega a la valla se niega (versión futura) sin tocar la base.
    let (c, r) = arranca_con(hasta_la_valla(), &data, &core);
    let e = r.expect_err("la 003 es futura para ese binario");
    assert!(e.contains("más nueva"), "{e}");
    suelta(c, &core);
    assert_eq!(tablas_de_proyectos(&core), (1, 1), "no hay bajada implícita");
}

// ---------------------------------------------------------------------------------------------
// 5. Un fallo del gate no cae a state.json
// ---------------------------------------------------------------------------------------------

#[test]
fn si_la_003_falla_el_arranque_bloquea_sin_volver_a_state_json_y_el_siguiente_arranque_se_recupera() {
    let (_l, data, core) = promovida_en_la_002();
    let estado_antes = std::fs::read(data.join("state.json")).unwrap();
    let marcador_antes = std::fs::read(marker_path(&core)).unwrap();

    let (c, r) = arranca_con(con_003(SQL_003_MALA), &data, &core);
    let e = r.expect_err("la 003 falla");
    assert!(e.contains("no se vuelve a state.json"), "el motivo lo dice: {e}");
    assert!(!matches!(c.storage_status(), StorageStatus::Degraded(_)), "no se degrada a state.json");
    suelta(c, &core);
    assert_eq!(base(&core), SIN_LA_003, "la tanda se deshizo: ni la tabla ni la fila");
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), estado_antes, "state.json ni se leyó para arrancar ni se reescribió");
    assert_eq!(std::fs::read(marker_path(&core)).unwrap(), marcador_antes);

    // Con la migración corregida el mismo estado arranca y migra: nada quedó a medias.
    let (c, r) = arranca_con(con_003(SQL_003), &data, &core);
    r.unwrap();
    assert_eq!(titulos(&c), vec!["propia".to_string()]);
    suelta(c, &core);
    assert_eq!(base(&core), CON_LA_003);
}
