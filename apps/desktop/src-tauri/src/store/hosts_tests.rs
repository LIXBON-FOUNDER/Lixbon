//! Pruebas del registro de hosts en el almacén (migración 027, LXO-182). Aquí se prueba que la BASE impone las reglas aunque alguien escriba
//! SQL a mano; la verificación de firmas y las reglas de producto están en `orch/host_identity_tests.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::migrate::{embedded_post_cut, Migration};
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-hosts-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

const KEY_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn abre(dir: &Path) -> Store {
    Store::open_with(dir, &embedded_post_cut(), "t").unwrap()
}

fn hasta_la_026() -> Vec<Migration> {
    embedded_post_cut().into_iter().filter(|m| m.version <= 26).collect()
}

fn info(label: &str) -> HostInfo {
    HostInfo { label: label.into(), os: "windows".into(), arch: "x86_64".into(), app_version: "0.1.0".into(), capabilities: vec!["core".into()] }
}

fn evento(host_id: &str, verified: bool) -> NewEvent {
    NewEvent {
        id: new_uuid_v7(),
        at: 1_000,
        v: 1,
        kind: "host.registered".into(),
        class: EventClass::State,
        actor_kind: ActorKind::System,
        actor_id: None,
        channel: Some("core".into()),
        client_id: Some(CORE_CLIENT_ID.into()),
        project_id: None,
        run_id: None,
        entity_kind: "host".into(),
        entity_id: host_id.into(),
        correlation_id: None,
        idem_key: None,
        payload: format!(r#"{{"is_self":false,"verified":{verified}}}"#),
    }
}

fn raw(s: &mut Store, sql: &str) -> Result<(), String> {
    s.write(|tx| {
        tx.execute_batch(sql)?;
        Ok(())
    })
    .map_err(|e| e.to_string())
}

fn eventos_de_host(s: &Store) -> i64 {
    s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM events WHERE kind = 'host.registered'", [], |r| r.get(0))?)).unwrap()
}

#[test]
fn una_base_antigua_se_rellena_con_su_machine_id_y_las_maquinas_de_sus_ubicaciones() {
    let t = Tmp::new();
    {
        let mut viejo = Store::open_with(t.path(), &hasta_la_026(), "t").unwrap();
        viejo.meta_set("machine_id", "esta-maquina").unwrap();
        let loc = |machine: &str, path: &str| NewLocation { machine: machine.into(), path: path.into(), display_path: path.into(), primary: true };
        let a = viejo.project_create("a", &Fingerprint::default(), &loc("esta-maquina", "c:/a")).unwrap();
        viejo.location_put(&a.id, &loc("otra-maquina", "c:/a")).unwrap();
        assert!(viejo.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'hosts'", [], |r| r.get::<_, i64>(0))?)).unwrap() == 0, "la base todavía no tiene `hosts`");
    }
    let s = abre(t.path());
    let hosts = s.hosts_list().unwrap();
    assert_eq!(hosts.iter().map(|h| (h.host_id.as_str(), h.is_self, h.public_key.is_some())).collect::<Vec<_>>(), vec![("esta-maquina", true, false), ("otra-maquina", false, false)]);
    assert!(hosts.iter().all(|h| h.verified_at.is_none()), "lo que ya existía NO está verificado: no hay prueba de nadie");
    assert_eq!(s.host_self().unwrap().unwrap().host_id, "esta-maquina");
}

#[test]
fn la_base_exige_un_solo_host_propio_y_una_clave_por_host() {
    let t = Tmp::new();
    let mut s = abre(t.path());
    s.host_self_record("yo", &info("yo"), None, 100, &evento("yo", false)).unwrap();
    // Un segundo host propio, escrito a mano.
    assert!(raw(&mut s, "INSERT INTO hosts (host_id, label, is_self, first_seen, last_seen) VALUES ('otro-yo', 'x', 1, 1, 1)").is_err());
    // Una clave de 64 hex en minúsculas, y solo eso.
    assert!(raw(&mut s, "INSERT INTO hosts (host_id, label, public_key, first_seen, last_seen) VALUES ('p', 'x', 'corta', 1, 1)").is_err());
    assert!(raw(&mut s, &format!("INSERT INTO hosts (host_id, label, public_key, first_seen, last_seen) VALUES ('p', 'x', '{}', 1, 1)", KEY_A.to_uppercase())).is_err());
    raw(&mut s, &format!("INSERT INTO hosts (host_id, label, public_key, first_seen, last_seen) VALUES ('p1', 'x', '{KEY_A}', 1, 1)")).unwrap();
    assert!(raw(&mut s, &format!("INSERT INTO hosts (host_id, label, public_key, first_seen, last_seen) VALUES ('p2', 'x', '{KEY_A}', 1, 1)")).is_err(), "una clave no es de dos hosts");
}

#[test]
fn la_clave_fijada_no_cambia_y_un_host_no_se_borra() {
    let t = Tmp::new();
    let mut s = abre(t.path());
    raw(&mut s, "INSERT INTO hosts (host_id, label, first_seen, last_seen) VALUES ('p', 'par', 1, 1)").unwrap();
    // Fijarla por primera vez sí; cambiarla después, no.
    raw(&mut s, &format!("UPDATE hosts SET public_key = '{KEY_A}' WHERE host_id = 'p'")).unwrap();
    assert!(raw(&mut s, &format!("UPDATE hosts SET public_key = '{KEY_B}' WHERE host_id = 'p'")).is_err());
    assert!(raw(&mut s, "UPDATE hosts SET public_key = NULL WHERE host_id = 'p'").is_err());
    assert!(raw(&mut s, "UPDATE hosts SET is_self = 1 WHERE host_id = 'p'").is_err(), "un par no se convierte en el host propio");
    assert!(raw(&mut s, "DELETE FROM hosts WHERE host_id = 'p'").is_err(), "parado o sin conexión no es borrado");
    assert_eq!(s.host_get("p").unwrap().unwrap().public_key.as_deref(), Some(KEY_A));
}

#[test]
fn el_host_propio_nace_con_su_evento_y_refrescarlo_no_lo_repite() {
    let t = Tmp::new();
    let mut s = abre(t.path());
    let (row, change) = s.host_self_record("yo", &info("mi equipo"), Some(KEY_A), 100, &evento("yo", true)).unwrap();
    assert_eq!(change, HostChange::Created);
    assert!(row.is_self && row.verified_at == Some(100) && row.first_seen == 100);
    assert_eq!(eventos_de_host(&s), 1);

    let (row, change) = s.host_self_record("yo", &info("mi equipo nuevo"), Some(KEY_A), 500, &evento("yo", true)).unwrap();
    assert_eq!(change, HostChange::Refreshed);
    assert_eq!((row.label.as_str(), row.first_seen, row.last_seen), ("mi equipo nuevo", 100, 500));
    assert_eq!(eventos_de_host(&s), 1, "refrescar no es un hecho nuevo");
}

#[test]
fn un_host_propio_sin_clave_se_verifica_despues_con_su_segundo_evento() {
    let t = Tmp::new();
    let mut s = abre(t.path());
    let (row, change) = s.host_self_record("yo", &info("yo"), None, 100, &evento("yo", false)).unwrap();
    assert_eq!((change, row.public_key.is_none(), row.verified_at), (HostChange::Created, true, None));
    let (row, change) = s.host_self_record("yo", &info("yo"), Some(KEY_A), 200, &evento("yo", true)).unwrap();
    assert_eq!((change, row.public_key.as_deref(), row.verified_at), (HostChange::Verified, Some(KEY_A), Some(200)));
    assert_eq!(eventos_de_host(&s), 2);
    // Otra clave para el mismo host propio, no.
    let err = s.host_self_record("yo", &info("yo"), Some(KEY_B), 300, &evento("yo", true)).unwrap_err().to_string();
    assert!(err.contains("otra clave"), "{err}");
}

#[test]
fn este_core_no_cambia_de_identidad_ni_adopta_la_de_un_par() {
    let t = Tmp::new();
    let mut s = abre(t.path());
    s.host_self_record("yo", &info("yo"), None, 100, &evento("yo", false)).unwrap();
    assert!(s.host_self_record("otro", &info("otro"), None, 200, &evento("otro", false)).unwrap_err().to_string().contains("ya es el host yo"));
    s.host_peer_record("par", &info("par"), KEY_A, 150, 150, &evento("par", true)).unwrap();
    // El par no puede ser el propio ni usar su clave.
    let t2 = Tmp::new();
    let mut s2 = abre(t2.path());
    s2.host_peer_record("par", &info("par"), KEY_A, 150, 150, &evento("par", true)).unwrap();
    assert!(s2.host_self_record("par", &info("par"), None, 200, &evento("par", false)).unwrap_err().to_string().contains("otra máquina"));
}

#[test]
fn un_par_solo_se_refresca_con_su_clave_y_una_prueba_mas_reciente() {
    let t = Tmp::new();
    let mut s = abre(t.path());
    let (_, change) = s.host_peer_record("par", &info("par"), KEY_A, 100, 100, &evento("par", true)).unwrap();
    assert_eq!(change, HostChange::Created);
    // Otra clave para el mismo host: suplantación.
    let err = s.host_peer_record("par", &info("par"), KEY_B, 200, 200, &evento("par", true)).unwrap_err().to_string();
    assert!(err.contains("suplantación"), "{err}");
    // La misma prueba, o una más vieja: no vale.
    for at in [100, 50] {
        let err = s.host_peer_record("par", &info("par"), KEY_A, at, 300, &evento("par", true)).unwrap_err().to_string();
        assert!(err.contains("no es más reciente"), "{err}");
    }
    // Una más reciente refresca sin evento nuevo.
    let (row, change) = s.host_peer_record("par", &info("par renombrado"), KEY_A, 400, 400, &evento("par", true)).unwrap();
    assert_eq!((change, row.label.as_str(), row.last_seen, row.verified_at), (HostChange::Refreshed, "par renombrado", 400, Some(400)));
    assert_eq!(eventos_de_host(&s), 1);
    // Y su clave no puede ser la de otro host.
    let err = s.host_peer_record("otro", &info("otro"), KEY_A, 500, 500, &evento("otro", true)).unwrap_err().to_string();
    assert!(err.contains("ya pertenece al host par"), "{err}");
}

#[test]
fn un_host_antes_sin_verificar_se_verifica_al_probar_su_clave() {
    let t = Tmp::new();
    let mut s = abre(t.path());
    raw(&mut s, "INSERT INTO hosts (host_id, label, first_seen, last_seen) VALUES ('viejo', 'Host sin verificar', 1, 1)").unwrap();
    let (row, change) = s.host_peer_record("viejo", &info("viejo"), KEY_A, 100, 100, &evento("viejo", true)).unwrap();
    assert_eq!((change, row.public_key.as_deref(), row.first_seen), (HostChange::Verified, Some(KEY_A), 1));
    assert_eq!(eventos_de_host(&s), 1, "verificar es un hecho: lleva su evento");
}

#[test]
fn un_fallo_al_insertar_el_evento_deshace_el_host() {
    let t = Tmp::new();
    let mut s = abre(t.path());
    // El evento habla de OTRO host: no se confirma ni la fila ni nada.
    assert!(s.host_peer_record("par", &info("par"), KEY_A, 100, 100, &evento("otro", true)).is_err());
    assert!(s.host_get("par").unwrap().is_none());
    assert_eq!(eventos_de_host(&s), 0);
}

#[test]
fn la_misma_ruta_en_dos_hosts_son_dos_ubicaciones() {
    let t = Tmp::new();
    let mut s = abre(t.path());
    s.host_self_record("yo", &info("yo"), None, 100, &evento("yo", false)).unwrap();
    s.host_peer_record("par", &info("par"), KEY_A, 100, 100, &evento("par", true)).unwrap();
    let loc = |machine: &str| NewLocation { machine: machine.into(), path: "c:/repo".into(), display_path: "C:/repo".into(), primary: true };
    let p = s.project_create("repo", &Fingerprint::default(), &loc("yo")).unwrap();
    s.location_put(&p.id, &loc("par")).unwrap();
    let locs = s.project_locations(Some(&p.id)).unwrap();
    assert_eq!(locs.len(), 2, "mismo texto de ruta, dos hosts, sin colisión");
    assert!(locs.iter().all(|l| l.primary), "cada host tiene su propia principal");
    assert_eq!(locs.iter().map(|l| l.machine.as_str()).collect::<std::collections::BTreeSet<_>>(), ["par", "yo"].into_iter().collect());
}
