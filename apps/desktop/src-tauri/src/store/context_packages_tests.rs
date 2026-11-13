//! Pruebas del ContextPackage guardado en el almacén (migración 025, LXO-138). Cubren `docs/core/CONTEXT_PACKAGE.md` § Guardado: que el
//! paquete y sus adjuntos entran en una sola transacción, que repetir no escribe nada y conserva el origen, que lo guardado es
//! inmutable aunque alguien escriba SQL a mano, que los valores están acotados y que antes del corte no hay nada que escribir.
//! La validez del paquete (identidad, secretos) la comprueba `context_package::parse` antes de llegar aquí: no se repite.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-ctxpkg-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

fn con_el_corte_neutro() -> Vec<Migration> {
    embedded().into_iter().map(|m| if m.name == super::cut::CUT_NAME { Migration::new(m.version, "corte_neutro_de_prueba", "SELECT 1;") } else { m }).collect()
}

fn abre(dir: &Path, activo: bool) -> Store {
    let mut s = Store::open_with(dir, &con_el_corte_neutro(), "t").unwrap();
    if activo {
        s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    }
    s
}

const ID: &str = "sha256:ed8802df89b2fc0ce7b1535f6233a49548df5bdfd5ffaa984ccb6c2cd213b6a4";
const ATT: &str = "att:c9ac7b0624824f84";
const SHA: &str = "c9ac7b0624824f844f6c7f3d50fab9741a8914e878467e8daaedca143a34d90b";

fn paquete(id: &str, origin: PackageOrigin, attempt: &str) -> NewStoredPackage {
    NewStoredPackage {
        package_id: id.into(),
        origin,
        task_id: "t-205".into(),
        attempt_id: attempt.into(),
        created_at: 1_800_000_000_000,
        json: "{\"package_id\":\"x\"}".into(),
        blobs: BTreeMap::from([(ATT.to_string(), (SHA.to_string(), b"bundle".to_vec()))]),
    }
}

#[test]
fn guarda_el_paquete_y_sus_adjuntos_y_los_devuelve_tal_cual() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    let p = paquete(ID, PackageOrigin::Built, "a-1");
    assert_eq!(s.context_package_put(&p, 5_000).unwrap(), PutOutcome::Created);
    let got = s.context_package(ID).unwrap().expect("guardado");
    assert_eq!((got.package_id.as_str(), got.origin, got.task_id.as_str(), got.attempt_id.as_str(), got.created_at, got.stored_at), (ID, PackageOrigin::Built, "t-205", "a-1", 1_800_000_000_000, 5_000));
    assert_eq!(got.json, p.json, "el documento sale exactamente como entró");
    assert_eq!(s.context_package_blobs(ID).unwrap(), BTreeMap::from([(ATT.to_string(), b"bundle".to_vec())]));
    assert!(s.context_package("sha256:ninguno").unwrap().is_none());
}

#[test]
fn repetir_no_escribe_nada_y_conserva_el_origen_y_la_hora_de_la_primera_vez() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    assert_eq!(s.context_package_put(&paquete(ID, PackageOrigin::Built, "a-1"), 5_000).unwrap(), PutOutcome::Created);
    assert_eq!(s.context_package_put(&paquete(ID, PackageOrigin::Imported, "a-1"), 9_000).unwrap(), PutOutcome::Existing);
    let got = s.context_package(ID).unwrap().unwrap();
    assert_eq!((got.origin, got.stored_at), (PackageOrigin::Built, 5_000), "el origen y la hora son los de la primera vez");
}

#[test]
fn el_paquete_mas_reciente_de_un_attempt_es_el_ultimo_guardado() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    let otro = "sha256:da2f30634f3fb2d893fc4ffffb176ccee763ece336b753987bb07d7bbb7880b6";
    s.context_package_put(&paquete(ID, PackageOrigin::Built, "a-1"), 5_000).unwrap();
    s.context_package_put(&paquete(otro, PackageOrigin::Built, "a-1"), 6_000).unwrap();
    s.context_package_put(&paquete("sha256:0000000000000000000000000000000000000000000000000000000000000000", PackageOrigin::Built, "a-2"), 7_000).unwrap();
    assert_eq!(s.context_package_latest_of_attempt("a-1").unwrap().unwrap().package_id, otro);
    assert_eq!(s.context_package_latest_of_attempt("a-2").unwrap().unwrap().attempt_id, "a-2");
    assert!(s.context_package_latest_of_attempt("a-9").unwrap().is_none());
}

#[test]
fn si_un_adjunto_falla_no_queda_ni_el_paquete() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    let mut p = paquete(ID, PackageOrigin::Built, "a-1");
    p.blobs.insert("att:no-es-un-id".into(), (SHA.into(), vec![1]));
    assert!(s.context_package_put(&p, 5_000).is_err(), "el id de adjunto no cumple el CHECK");
    assert!(s.context_package(ID).unwrap().is_none(), "una sola transacción: sin adjunto no hay paquete");
    assert!(s.context_package_blobs(ID).unwrap().is_empty());
}

#[test]
fn lo_guardado_es_inmutable_aunque_se_escriba_sql_a_mano() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    s.context_package_put(&paquete(ID, PackageOrigin::Built, "a-1"), 5_000).unwrap();
    let paquete_editado = s.read(|c| Ok(c.execute("UPDATE context_packages SET json = '{\"a\":1}' WHERE package_id = ?1", [ID]))).unwrap();
    assert!(paquete_editado.unwrap_err().to_string().contains("inmutable"));
    let adjunto_editado = s.read(|c| Ok(c.execute("UPDATE context_package_blobs SET data = x'00' WHERE package_id = ?1", [ID]))).unwrap();
    assert!(adjunto_editado.unwrap_err().to_string().contains("inmutable"));
    assert_eq!(s.context_package(ID).unwrap().unwrap().json, "{\"package_id\":\"x\"}");
}

#[test]
fn los_valores_estan_acotados_por_la_base() {
    let t = Tmp::new();
    let mut s = abre(t.path(), true);
    for (name, p) in [
        ("id sin sha256", NewStoredPackage { package_id: "md5:abc".into(), ..paquete(ID, PackageOrigin::Built, "a-1") }),
        ("id demasiado corto", NewStoredPackage { package_id: "sha256:abc".into(), ..paquete(ID, PackageOrigin::Built, "a-1") }),
        ("attempt vacío", NewStoredPackage { attempt_id: String::new(), ..paquete(ID, PackageOrigin::Built, "a-1") }),
        ("documento enorme", NewStoredPackage { json: "x".repeat(65_537), ..paquete(ID, PackageOrigin::Built, "a-1") }),
        ("adjunto de más de 1 MiB", NewStoredPackage { blobs: BTreeMap::from([(ATT.to_string(), (SHA.to_string(), vec![0u8; 1_048_577]))]), ..paquete(ID, PackageOrigin::Built, "a-1") }),
    ] {
        assert!(s.context_package_put(&p, 1).is_err(), "{name}");
    }
    assert!(s.context_package(ID).unwrap().is_none());
}

#[test]
fn antes_del_corte_no_hay_nada_que_leer_ni_se_puede_escribir() {
    let t = Tmp::new();
    let mut s = abre(t.path(), false);
    assert!(s.context_package(ID).unwrap().is_none());
    assert!(s.context_package_latest_of_attempt("a-1").unwrap().is_none());
    assert!(s.context_package_blobs(ID).unwrap().is_empty());
    assert!(matches!(s.context_package_put(&paquete(ID, PackageOrigin::Built, "a-1"), 1), Err(StoreError::AgenticModelInactive)));
}

#[test]
fn la_migracion_025_existe_con_su_nombre() {
    let m = embedded().into_iter().find(|m| m.version == 25).expect("existe la 025");
    assert_eq!(m.name, "context_packages");
    assert_eq!(m.checksum().len(), 64);
}
