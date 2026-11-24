//! LXO-182 · identidad de host con Cores reales: el host propio, su clave, el registro de un par con su prueba, la suplantación y `hosts_list`.
//! Dos Cores en dos directorios son dos máquinas distintas (cada uno tiene su `machine_id`).

use std::sync::Arc;

use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Value};

use super::agentic_cut;
use super::attention_read_tests::{agente, persona, rpc};
use super::boot_tests::{arranca, dirs, suelta};
use super::host::RecordingHost;
use super::host_identity::{proof_message, to_hex, HostProof, PROOF_WINDOW_MS, STALE_AFTER_MS};
use super::state::now_ms;
use super::{Core, Orch};
use crate::secure_store::{MemoryStore, UnavailableStore};
use crate::store::{Fingerprint, HostInfo, NewLocation};

/// Un Core persistente con el corte Task/Attempt aplicado (`hosts` nace con la migración 027, posterior al corte). Con `machine`, la base ya
/// tenía ese `machine_id` ANTES del corte (una instalación existente); con `None`, es una instalación nueva y el host nace al arrancar.
fn core_cortado(machine: Option<&str>) -> Arc<Core> {
    let (keep, data, core_dir) = dirs();
    std::mem::forget(keep); // la base queda en disco, como en las demás fixtures
    let (core, _host, ready) = arranca(&data, &core_dir);
    ready.unwrap();
    if let Some(machine) = machine {
        core.storage.with_store(|s| s.meta_set("machine_id", machine).unwrap()).unwrap();
    }
    let cut = core.storage.with_store(|s| agentic_cut::run(s, &core_dir, &data, "host-identity-test")).unwrap().unwrap();
    assert!(matches!(cut, agentic_cut::CutReport::Applied { .. }), "{cut:?}");
    crate::orch::pty::pruebas::apaga_en_serie(&core);
    suelta(core, &core_dir);
    let core = Orch::default().0;
    core.init_in(RecordingHost::new(), &data, &core_dir).unwrap();
    core.settings.lock().unwrap().enabled = true;
    core
}

fn eventos_de_host(core: &Core) -> Vec<Value> {
    core.storage
        .read_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT payload, entity_id, class, actor_kind FROM events WHERE kind = 'host.registered' ORDER BY seq")?;
                let rows = stmt
                    .query_map([], |r| Ok(json!({ "payload": serde_json::from_str::<Value>(&r.get::<_, String>(0)?).unwrap(), "entity": r.get::<_, String>(1)?, "class": r.get::<_, String>(2)?, "actor": r.get::<_, String>(3)? })))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
        })
        .unwrap()
        .unwrap()
}

fn host_propio(core: &Core, secrets: &MemoryStore) -> crate::store::HostRow {
    core.host_identity_ensure_with(secrets).unwrap()
}

/// Una prueba firmada con una clave que el llamador controla (para falsificar datos, horas o identidades).
fn firma(host_id: &str, clave: &Ed25519KeyPair, info: &HostInfo, issued_at: i64) -> HostProof {
    let public_key = to_hex(clave.public_key().as_ref());
    let signature = to_hex(clave.sign(&proof_message(host_id, &public_key, info, issued_at)).as_ref());
    HostProof { host_id: host_id.into(), public_key, info: info.clone(), issued_at, signature }
}

fn clave_nueva() -> Ed25519KeyPair {
    Ed25519KeyPair::from_pkcs8(Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap().as_ref()).unwrap()
}

fn info(label: &str) -> HostInfo {
    HostInfo { label: label.into(), os: "linux".into(), arch: "aarch64".into(), app_version: "9.9.9".into(), capabilities: vec!["core".into()] }
}

fn person(core: &Core) -> crate::store::AuthenticatedClient {
    const SECRET: &str = "person-hosts-secret-0123456789abcdef-xyz";
    if let Ok(Some(ya)) = core.authenticate_client(SECRET) {
        return ya;
    }
    persona(core, "person-hosts", "install-person-hosts", SECRET)
}

fn hosts(core: &Arc<Core>) -> Value {
    rpc(core, &person(core), "hosts_list", json!({})).expect("hosts_list responde a una Person autenticada")
}

#[test]
fn el_host_propio_usa_su_machine_id_y_nace_con_clave_y_un_solo_evento() {
    let core = core_cortado(None);
    let secrets = MemoryStore::new();
    let row = host_propio(&core, &secrets);
    let machine = core.storage.read_store(|s| s.meta("machine_id")).unwrap().unwrap().unwrap();
    assert!(row.is_self);
    assert_eq!(row.host_id, machine, "el host propio ES el machine_id que ya usaban las ubicaciones");
    let key = row.public_key.clone().expect("con almacén seguro tiene clave");
    assert_eq!(key.len(), 64);
    assert!(row.verified_at.is_some());

    let eventos = eventos_de_host(&core);
    assert_eq!(eventos.len(), 1);
    assert_eq!(eventos[0]["payload"], json!({ "is_self": true, "verified": true }));
    assert_eq!((eventos[0]["entity"].as_str(), eventos[0]["class"].as_str(), eventos[0]["actor"].as_str()), (Some(machine.as_str()), Some("state"), Some("system")));
    assert!(!eventos[0].to_string().contains(&key), "la clave no entra en el evento");

    // Idempotente: misma fila, misma clave, sin evento nuevo.
    let otra = host_propio(&core, &secrets);
    assert_eq!((otra.host_id.as_str(), otra.public_key.as_deref(), otra.first_seen), (row.host_id.as_str(), Some(key.as_str()), row.first_seen));
    assert_eq!(eventos_de_host(&core).len(), 1);
}

#[test]
fn sin_almacen_seguro_el_host_existe_sin_verificar_y_se_verifica_cuando_aparece() {
    let core = core_cortado(None);
    let row = core.host_identity_ensure_with(&UnavailableStore).unwrap();
    assert!(row.is_self && row.public_key.is_none() && row.verified_at.is_none());
    let err = core.host_proof_issue_with(&UnavailableStore).unwrap_err();
    assert!(err.starts_with("host_unverified"), "{err}");

    let secrets = MemoryStore::new();
    let verificado = core.host_identity_ensure_with(&secrets).unwrap();
    assert_eq!(verificado.host_id, row.host_id);
    assert!(verificado.public_key.is_some() && verificado.verified_at.is_some());
    let eventos = eventos_de_host(&core);
    assert_eq!(eventos.iter().map(|e| e["payload"]["verified"].as_bool().unwrap()).collect::<Vec<_>>(), vec![false, true], "nació sin verificar y luego se verificó");
    assert!(core.host_proof_issue_with(&secrets).is_ok());
}

#[test]
fn un_par_se_registra_con_la_prueba_de_su_clave_y_aparece_en_hosts_list() {
    let a = core_cortado(None);
    let b = core_cortado(None);
    let (sa, sb) = (MemoryStore::new(), MemoryStore::new());
    let yo = host_propio(&a, &sa);
    let par = host_propio(&b, &sb);
    assert_ne!(yo.host_id, par.host_id, "dos máquinas, dos identidades");

    let registrado = a.host_peer_register(&b.host_proof_issue_with(&sb).unwrap()).unwrap();
    assert!(!registrado.is_self);
    assert_eq!((registrado.host_id.as_str(), registrado.public_key, registrado.os.is_some()), (par.host_id.as_str(), par.public_key.clone(), true));

    let eventos = eventos_de_host(&a);
    assert_eq!(eventos.len(), 2, "el del host propio y el del par");
    assert_eq!(eventos[1]["payload"], json!({ "is_self": false, "verified": true }));
    assert_eq!(eventos[1]["entity"], json!(par.host_id));

    let listado = hosts(&a);
    assert_eq!(listado["self"], json!(yo.host_id));
    let lista = listado["hosts"].as_array().unwrap();
    assert_eq!(lista.len(), 2);
    assert_eq!((lista[0]["host_id"].as_str(), lista[0]["self"].as_bool()), (Some(yo.host_id.as_str()), Some(true)), "primero el propio");
    assert_eq!((lista[1]["host_id"].as_str(), lista[1]["verified"].as_bool(), lista[1]["availability"].as_str()), (Some(par.host_id.as_str()), Some(true), Some("online")));
    assert!(lista[1].get("private_key").is_none() && !listado.to_string().contains("pkcs8"));
}

#[test]
fn un_par_que_se_presenta_con_otra_clave_o_con_la_identidad_de_este_host_se_rechaza() {
    let a = core_cortado(None);
    let b = core_cortado(None);
    let (sa, sb) = (MemoryStore::new(), MemoryStore::new());
    let yo = host_propio(&a, &sa);
    let par = host_propio(&b, &sb);
    a.host_peer_register(&b.host_proof_issue_with(&sb).unwrap()).unwrap();
    let ahora = now_ms() as i64;
    let atacante = clave_nueva();

    // 1. Con el host_id de ESTE Core, firmado por otra clave.
    let err = a.host_peer_register(&firma(&yo.host_id, &atacante, &info("falso"), ahora)).unwrap_err();
    assert!(err.starts_with("host_conflict"), "{err}");
    // 2. Una prueba LEGÍTIMA y bien firmada del propio host, presentada como si fuera de un par: tampoco entra.
    let err = a.host_peer_register(&a.host_proof_issue_with(&sa).unwrap()).unwrap_err();
    assert!(err.starts_with("host_conflict"), "{err}");
    // 3. Con el host_id de otro par ya fijado, con una clave distinta.
    let err = a.host_peer_register(&firma(&par.host_id, &atacante, &info("falso"), ahora + 1)).unwrap_err();
    assert!(err.starts_with("host_conflict") && err.contains("suplantación"), "{err}");
    // El par conserva SU clave.
    let del_par = a.storage.read_store(|s| s.host_get(&par.host_id)).unwrap().unwrap().unwrap().public_key;
    assert_eq!(del_par, par.public_key);

    // Nada de eso cambió el registro: sigue habiendo dos hosts y el par conserva su clave.
    let lista = hosts(&a);
    assert_eq!(lista["hosts"].as_array().unwrap().len(), 2);
    assert_eq!(eventos_de_host(&a).len(), 2);
}

#[test]
fn una_firma_que_no_cuadra_una_hora_fuera_de_ventana_o_datos_malos_no_registran_nada() {
    let a = core_cortado(None);
    host_propio(&a, &MemoryStore::new());
    let clave = clave_nueva();
    let ahora = now_ms() as i64;

    // Datos cambiados después de firmar.
    let mut manipulada = firma("par-x", &clave, &info("original"), ahora);
    manipulada.info.label = "otro nombre".into();
    assert!(a.host_peer_register(&manipulada).unwrap_err().starts_with("host_proof_invalid"));
    // Firma de otra clave.
    let mut ajena = firma("par-x", &clave, &info("par"), ahora);
    ajena.signature = firma("par-x", &clave_nueva(), &info("par"), ahora).signature;
    assert!(a.host_peer_register(&ajena).unwrap_err().starts_with("host_proof_invalid"));
    // Clave o firma que no son hexadecimal del tamaño exacto.
    let mut mala = firma("par-x", &clave, &info("par"), ahora);
    mala.public_key = "no-es-hex".into();
    assert!(a.host_peer_register(&mala).unwrap_err().starts_with("host_proof_invalid"));
    // Campos con saltos de línea (romperían el texto firmado).
    let mut con_salto = info("par\nfalso");
    assert!(a.host_peer_register(&firma("par-x", &clave, &con_salto, ahora)).unwrap_err().starts_with("host_proof_invalid"));
    con_salto.label = "par".into();
    assert!(a.host_peer_register(&firma("par\nx", &clave, &con_salto, ahora)).unwrap_err().starts_with("host_proof_invalid"));
    // Fuera de la ventana, hacia atrás y hacia delante, aunque la firma sea válida.
    for desfase in [-(PROOF_WINDOW_MS + 1_000), PROOF_WINDOW_MS + 60_000] {
        let err = a.host_peer_register(&firma("par-x", &clave, &info("par"), ahora + desfase)).unwrap_err();
        assert!(err.starts_with("host_proof_expired"), "{err}");
    }
    assert_eq!(hosts(&a)["hosts"].as_array().unwrap().len(), 1, "solo el propio");
    assert_eq!(eventos_de_host(&a).len(), 1);
}

#[test]
fn repetir_una_prueba_no_refresca_pero_una_mas_reciente_si_y_sin_evento_nuevo() {
    let a = core_cortado(None);
    let b = core_cortado(None);
    let (sa, sb) = (MemoryStore::new(), MemoryStore::new());
    host_propio(&a, &sa);
    host_propio(&b, &sb);

    let primera = b.host_proof_issue_with(&sb).unwrap();
    a.host_peer_register(&primera).unwrap();
    let err = a.host_peer_register(&primera).unwrap_err();
    assert!(err.starts_with("host_conflict") && err.contains("no es más reciente"), "una prueba repetida no vale: {err}");

    std::thread::sleep(std::time::Duration::from_millis(5));
    let segunda = b.host_proof_issue_with(&sb).unwrap();
    assert!(segunda.issued_at > primera.issued_at);
    let refrescado = a.host_peer_register(&segunda).unwrap();
    assert_eq!(refrescado.verified_at, Some(segunda.issued_at));
    assert_eq!(eventos_de_host(&a).len(), 2, "refrescar no es un hecho nuevo");
}

#[test]
fn un_par_parado_sigue_en_la_lista_como_stale_y_nunca_se_borra() {
    let a = core_cortado(None);
    let b = core_cortado(None);
    let (sa, sb) = (MemoryStore::new(), MemoryStore::new());
    host_propio(&a, &sa);
    let par = host_propio(&b, &sb);
    a.host_peer_register(&b.host_proof_issue_with(&sb).unwrap()).unwrap();

    let viejo = now_ms() as i64 - STALE_AFTER_MS - 60_000;
    a.storage.with_store(|s| s.write(|tx| Ok(tx.execute("UPDATE hosts SET last_seen = ?1 WHERE host_id = ?2", rusqlite::params![viejo, par.host_id])?)).unwrap()).unwrap();
    let lista = hosts(&a);
    let el_par = lista["hosts"].as_array().unwrap().iter().find(|h| h["host_id"] == json!(par.host_id)).expect("el par sigue en la lista");
    assert_eq!(el_par["availability"], "stale");
    assert_eq!(el_par["verified"], true, "estar parado no le quita la verificación");

    let borrar = a.storage.with_store(|s| s.write(|tx| Ok(tx.execute("DELETE FROM hosts WHERE host_id = ?1", [&par.host_id])?))).unwrap();
    assert!(borrar.is_err(), "ni a mano se borra un host");
    assert_eq!(hosts(&a)["hosts"].as_array().unwrap().len(), 2);
}

#[test]
fn un_proyecto_con_dos_hosts_agrupa_cada_ubicacion_bajo_su_host_aunque_la_ruta_sea_la_misma() {
    let a = core_cortado(None);
    let b = core_cortado(None);
    let (sa, sb) = (MemoryStore::new(), MemoryStore::new());
    let yo = host_propio(&a, &sa);
    let par = host_propio(&b, &sb);
    a.host_peer_register(&b.host_proof_issue_with(&sb).unwrap()).unwrap();

    let loc = |machine: &str| NewLocation { machine: machine.into(), path: "c:/repo".into(), display_path: "C:/repo".into(), primary: true };
    let project = a
        .storage
        .with_store(|s| {
            let p = s.project_create("repo", &Fingerprint::default(), &loc(&yo.host_id)).unwrap();
            s.location_put(&p.id, &loc(&par.host_id)).unwrap();
            p.id
        })
        .unwrap();

    let lista = hosts(&a);
    for h in lista["hosts"].as_array().unwrap() {
        let locs = h["locations"].as_array().unwrap();
        assert_eq!(locs.len(), 1, "cada host ve solo SU ubicación: {h}");
        assert_eq!(locs[0]["project_id"], json!(project));
    }
}

#[test]
fn hosts_list_es_solo_para_una_person_y_no_acepta_argumentos() {
    let core = core_cortado(None);
    host_propio(&core, &MemoryStore::new());
    let persona_cli = person(&core);
    let agente_cli = agente(&core, "t-host", "install-agent-hosts", "agent-hosts-secret-0123456789abcdef-xyz");

    let err = rpc(&core, &agente_cli, "hosts_list", json!({})).unwrap_err();
    // No se imprime la respuesta entera: viene de una llamada con credenciales y el diagnóstico solo necesita el código.
    assert!(err.contains("hosts_list_auth_required") || err.contains("no autorizado") || err.contains("denied") || err.contains("no permite"), "un Agent no recibió el rechazo esperado");
    let err = rpc(&core, &persona_cli, "hosts_list", json!({ "machine": "otra" })).unwrap_err();
    assert!(err.starts_with("hosts_list_invalid_request"), "un argumento desconocido no recibió hosts_list_invalid_request");
    assert!(rpc(&core, &persona_cli, "hosts_list", json!({})).is_ok());
}

#[test]
fn una_instalacion_existente_conserva_su_machine_id_como_host_y_se_verifica_con_un_evento() {
    let core = core_cortado(Some("maquina-de-siempre"));
    // La migración ya la rellenó: está, es la propia y NO está verificada, y no hay ningún evento todavía.
    let antes = core.storage.read_store(|s| s.host_self()).unwrap().unwrap().unwrap();
    assert_eq!((antes.host_id.as_str(), antes.public_key.is_none(), antes.verified_at.is_none()), ("maquina-de-siempre", true, true));
    assert!(eventos_de_host(&core).is_empty());

    let despues = host_propio(&core, &MemoryStore::new());
    assert_eq!(despues.host_id, "maquina-de-siempre", "las ubicaciones y worktrees que ya usaban ese texto siguen siendo suyos");
    assert!(despues.public_key.is_some() && despues.verified_at.is_some());
    assert_eq!(despues.first_seen, antes.first_seen, "no es un alta nueva");
    assert_eq!(eventos_de_host(&core).iter().map(|e| e["payload"]["verified"].as_bool().unwrap()).collect::<Vec<_>>(), vec![true]);
}

#[test]
fn antes_del_corte_el_registro_de_hosts_no_existe_y_no_rompe_nada() {
    let (_l, _d, _c, core) = super::attention_read_tests::core_listo();
    let secrets = MemoryStore::new();
    assert!(core.host_identity_ensure_with(&secrets).unwrap_err().starts_with("core_model_inactive"));
    assert!(core.host_proof_issue_with(&secrets).is_err());
    let err = rpc(&core, &person(&core), "hosts_list", json!({})).unwrap_err();
    assert!(err.starts_with("core_model_inactive"), "antes del corte hosts_list no respondió core_model_inactive");
    let err = core.host_peer_register(&firma("par", &clave_nueva(), &info("par"), now_ms() as i64)).unwrap_err();
    assert!(err.starts_with("core_model_inactive"), "{err}");
}

#[test]
fn si_se_pierde_la_clave_propia_el_host_falla_cerrado_y_no_inventa_otra() {
    let core = core_cortado(None);
    let original = host_propio(&core, &MemoryStore::new());
    // El almacén seguro nuevo está vacío: la clave de antes se perdió.
    let vacio = MemoryStore::new();
    let err = core.host_identity_ensure_with(&vacio).unwrap_err();
    assert!(err.starts_with("host_conflict") && err.contains("otra clave"), "{err}");
    assert!(core.host_proof_issue_with(&vacio).unwrap_err().starts_with("host_unverified"));
    let sigue = core.storage.read_store(|s| s.host_self()).unwrap().unwrap().unwrap();
    assert_eq!(sigue.public_key, original.public_key, "la clave fijada no se sustituyó");
    assert_eq!(eventos_de_host(&core).len(), 1);
}
