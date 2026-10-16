//! Pruebas de las decisiones de gestión de un Project (slice E, E1b · Projects, commit 2):
//! `project.location_added` (join), `project.archived` / `project.restored` y `project.relocated`.
//!
//! Cada decisión es UNA transacción del almacén con todas sus filas y su evento; solo un cambio real deja
//! evento; solo una persona por la interfaz las toma; y con el Core degradado no se escribe nada.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use super::events::Channel;
use super::projects_tests::{base_de, clon, core_listo, g, id_de, lista, registra, repo, rpc, s};
use super::{Caller, Core};
use crate::store::{EventClass, EventQuery, EventRow, Fingerprint, LocationRow, ProjectRow};

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

fn head(core: &Core) -> i64 {
    core.storage.with_store(|s| s.events_head().unwrap()).unwrap()
}

fn desde(core: &Core, seq: i64) -> Vec<EventRow> {
    core.storage.with_store(|s| s.events_page(&EventQuery { after: Some(seq), limit: Some(500), ..Default::default() }).unwrap().events).unwrap()
}

fn kinds(evs: &[EventRow]) -> Vec<&str> {
    evs.iter().map(|e| e.kind.as_str()).collect()
}

fn pl(e: &EventRow) -> Value {
    serde_json::from_str(&e.payload).unwrap()
}

fn proyecto(core: &Core, id: &str) -> ProjectRow {
    core.storage.with_store(|s| s.project(id).unwrap().unwrap()).unwrap()
}

fn ubicaciones(core: &Core, id: &str) -> Vec<LocationRow> {
    core.storage.with_store(|s| s.project_locations(Some(id)).unwrap()).unwrap()
}

fn sql(core: &Core, script: &str) {
    core.storage
        .with_store(|st| {
            st.write(|tx| {
                tx.execute_batch(script)?;
                Ok(())
            })
        })
        .unwrap()
        .unwrap();
}

/// Contrato común de las cuatro decisiones: clase `decision`, entidad `project`, sin `run`, sin `idem_key`,
/// sin `state_rev`, y siempre `person/ui`.
fn afirma_decision(e: &EventRow, id: &str, kind: &str, payload: Value) {
    assert_eq!(e.kind, kind);
    assert_eq!((e.class, e.v), (EventClass::Decision, 1));
    assert_eq!((e.entity_kind.as_str(), e.entity_id.as_str()), ("project", id));
    assert_eq!(e.project_id.as_deref(), Some(id));
    assert_eq!((e.run_id.clone(), e.idem_key.clone(), e.correlation_id.clone(), e.client_id.clone()), (None, None, None, None));
    assert_eq!(e.state_rev, None, "una decisión de Project no confirma legacy_state");
    assert_eq!((e.actor_kind.as_str(), e.actor_id.as_deref(), e.channel.as_deref()), ("person", None, Some("ui")));
    assert_eq!(pl(e), payload);
}

/// Un proyecto en `origen` y una copia suya (mismos commits raíz; sin remoto si `remoto` es `None`).
fn con_copia(core: &Arc<Core>, data: &Path, remoto: Option<&str>) -> (String, std::path::PathBuf, std::path::PathBuf) {
    let base = base_de(data);
    let origen = repo(&base, "origen", None);
    let id = id_de(&registra(core, &origen));
    let copia = clon(&base, &origen, "copia", remoto);
    (id, origen, copia)
}

fn join(core: &Arc<Core>, id: &str, copia: &Path) -> Result<Value, String> {
    rpc(core, "project_add", json!({ "path": s(copia), "join": id }))
}

// ---------------------------------------------------------------------------------------------
// join -> project.location_added
// ---------------------------------------------------------------------------------------------

#[test]
fn join_emite_location_added_con_primary_false_y_adopta_los_remotos_en_la_misma_transaccion() {
    let (_l, data, _c, core) = core_listo();
    let (id, _origen, copia) = con_copia(&core, &data, Some("https://github.com/o/x.git"));
    assert!(proyecto(&core, &id).fingerprint.remotes.is_empty());
    let antes = head(&core);
    join(&core, &id, &copia).unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["project.location_added"]);
    afirma_decision(&evs[0], &id, "project.location_added", json!({ "primary": false, "fingerprint_adopted": true }));
    assert_eq!(proyecto(&core, &id).fingerprint.remotes.len(), 1, "adoptó los remotos");
    let locs = ubicaciones(&core, &id);
    assert_eq!((locs.len(), locs.iter().filter(|l| l.primary).count()), (2, 1));
}

#[test]
fn join_sin_cambio_de_huella_o_con_la_principal_desaparecida_lo_refleja_en_el_payload() {
    let (_l, data, _c, core) = core_listo();
    let (id, origen, copia) = con_copia(&core, &data, None);
    // Sin remotos en ninguno de los dos: no hay nada que adoptar.
    let antes = head(&core);
    join(&core, &id, &copia).unwrap();
    afirma_decision(&desde(&core, antes)[0], &id, "project.location_added", json!({ "primary": false, "fingerprint_adopted": false }));

    // Con la principal desaparecida, la ubicación que se une pasa a ser la principal.
    let (_l2, data2, _c2, core2) = core_listo();
    let (id2, origen2, copia2) = con_copia(&core2, &data2, None);
    std::fs::remove_dir_all(origen2.join(".git")).unwrap();
    std::fs::remove_dir_all(&origen2).unwrap();
    assert_eq!(lista(&core2)[0]["locations"][0]["state"], "missing", "se persiste la marca");
    let antes2 = head(&core2);
    join(&core2, &id2, &copia2).unwrap();
    afirma_decision(&desde(&core2, antes2)[0], &id2, "project.location_added", json!({ "primary": true, "fingerprint_adopted": false }));
    assert!(ubicaciones(&core2, &id2).iter().any(|l| l.primary && !l.missing && l.display_path.ends_with("copia")));
    let _ = origen;
}

#[test]
fn en_otra_maquina_la_primera_ubicacion_unida_es_su_principal_y_la_segunda_no() {
    let (_l, data, _c, core) = core_listo();
    let (id, origen, copia) = con_copia(&core, &data, None);
    let esta: String = core.storage.with_store(|s| s.meta("machine_id").unwrap()).unwrap().unwrap();
    // La ubicación registrada pasa a ser de OTRA máquina: esta todavía no tiene ninguna.
    sql(&core, "UPDATE project_locations SET machine = 'machine-a'");
    let estado = |core: &Core| -> Vec<(String, bool)> {
        let mut v: Vec<_> = ubicaciones(core, &id).into_iter().map(|l| (if l.machine == "machine-a" { "A".to_string() } else { l.display_path.rsplit(|c| c == '/' || c == '\\').next().unwrap().to_string() }, l.primary)).collect();
        v.sort();
        v
    };
    assert!(!esta.is_empty());

    let antes = head(&core);
    join(&core, &id, &copia).unwrap();
    let evs = desde(&core, antes);
    afirma_decision(&evs[0], &id, "project.location_added", json!({ "primary": true, "fingerprint_adopted": false }));
    assert_eq!(estado(&core), vec![("A".to_string(), true), ("copia".to_string(), true)], "una principal por máquina");

    let copia2 = clon(&base_de(&data), &origen, "copia2", None);
    let antes = head(&core);
    join(&core, &id, &copia2).unwrap();
    afirma_decision(&desde(&core, antes)[0], &id, "project.location_added", json!({ "primary": false, "fingerprint_adopted": false }));
    assert_eq!(estado(&core), vec![("A".to_string(), true), ("copia".to_string(), true), ("copia2".to_string(), false)]);
}

#[test]
fn repetir_el_join_o_unir_una_ruta_que_ya_es_del_proyecto_no_emite() {
    let (_l, data, _c, core) = core_listo();
    let (id, _origen, copia) = con_copia(&core, &data, None);
    join(&core, &id, &copia).unwrap();
    let antes = head(&core);
    assert_eq!(join(&core, &id, &copia).unwrap()["created"], false);
    assert_eq!(id_de(&registra(&core, &copia)), id);
    assert_eq!(head(&core), antes, "la ruta ya era del proyecto: ni filas ni evento");
}

// ---------------------------------------------------------------------------------------------
// archive / restore
// ---------------------------------------------------------------------------------------------

#[test]
fn archivar_y_restaurar_emiten_solo_ante_un_cambio_real() {
    let (_l, data, _c, core) = core_listo();
    let id = id_de(&registra(&core, &repo(&base_de(&data), "app", None)));
    let archivar = |archived: bool| rpc(&core, "project_archive", json!({ "project_id": id, "archived": archived }));

    let antes = head(&core);
    archivar(false).unwrap();
    assert_eq!(head(&core), antes, "restaurar un activo no deja evento");
    archivar(true).unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["project.archived"]);
    afirma_decision(&evs[0], &id, "project.archived", json!({}));
    assert!(proyecto(&core, &id).archived);

    let (antes, updated) = (head(&core), proyecto(&core, &id).updated_at);
    archivar(true).unwrap();
    assert_eq!((head(&core), proyecto(&core, &id).updated_at), (antes, updated), "archivar un archivado: ni evento ni updated_at");
    archivar(false).unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["project.restored"]);
    afirma_decision(&evs[0], &id, "project.restored", json!({}));
    assert!(!proyecto(&core, &id).archived);

    // Un proyecto que no existe es un error y no deja nada.
    let antes = head(&core);
    assert!(rpc(&core, "project_archive", json!({ "project_id": "fantasma" })).unwrap_err().contains("No existe"));
    assert_eq!(head(&core), antes);
}

// ---------------------------------------------------------------------------------------------
// relocate -> project.relocated
// ---------------------------------------------------------------------------------------------

fn locate(core: &Arc<Core>, id: &str, path: &Path, confirm: bool) -> Result<Value, String> {
    rpc(core, "project_locate", json!({ "project_id": id, "path": s(path), "confirm": confirm }))
}

#[test]
fn relocalizar_emite_relocated_y_repetirlo_no_emite() {
    let (_l, data, _c, core) = core_listo();
    let (id, _origen, copia) = con_copia(&core, &data, None);
    let antes = head(&core);
    locate(&core, &id, &copia, false).unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["project.relocated"]);
    afirma_decision(&evs[0], &id, "project.relocated", json!({ "fingerprint_adopted": false, "confirmed_mismatch": false }));
    assert!(ubicaciones(&core, &id).iter().any(|l| l.primary && l.display_path.ends_with("copia")));
    // La misma ruta otra vez: ya es la principal y está `ok`.
    let antes = head(&core);
    locate(&core, &id, &copia, false).unwrap();
    assert_eq!(head(&core), antes);
}

#[test]
fn confirmed_mismatch_solo_cuando_la_persona_acepto_commits_raiz_distintos() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let id = id_de(&registra(&core, &repo(&base, "app", None)));
    let otro = repo(&base, "otro-repo", None);
    // Sin `confirm`: pide confirmación y no escribe.
    let antes = head(&core);
    assert_eq!(locate(&core, &id, &otro, false).unwrap()["status"], "needs_confirmation");
    assert_eq!((head(&core), ubicaciones(&core, &id).len()), (antes, 1));
    // Con `confirm`: el hecho dice que se aceptó una discrepancia.
    locate(&core, &id, &otro, true).unwrap();
    let evs = desde(&core, antes);
    afirma_decision(&evs[0], &id, "project.relocated", json!({ "fingerprint_adopted": false, "confirmed_mismatch": true }));
    // `confirm` sobre un repositorio que SÍ coincide no es una discrepancia.
    let (id2, copia) = {
        let origen = repo(&base, "origen2", None);
        (id_de(&registra(&core, &origen)), clon(&base, &origen, "copia2", None))
    };
    let antes = head(&core);
    locate(&core, &id2, &copia, true).unwrap();
    afirma_decision(&desde(&core, antes)[0], &id2, "project.relocated", json!({ "fingerprint_adopted": false, "confirmed_mismatch": false }));
}

#[test]
fn un_proyecto_sin_commits_raiz_adopta_la_huella_y_el_hecho_lo_dice() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let vacio = base.join("repos").join("vacio");
    std::fs::create_dir_all(&vacio).unwrap();
    g(&vacio, &["init", "-q", "-b", "main"]);
    let id = id_de(&registra(&core, &vacio));
    assert!(proyecto(&core, &id).fingerprint.root_commits.is_empty());
    let con_commits = repo(&base, "con-commits", None);
    let antes = head(&core);
    locate(&core, &id, &con_commits, false).unwrap();
    afirma_decision(&desde(&core, antes)[0], &id, "project.relocated", json!({ "fingerprint_adopted": true, "confirmed_mismatch": false }));
    assert!(!proyecto(&core, &id).fingerprint.root_commits.is_empty());
    // Adoptada: otra vez la misma ruta no cambia nada.
    let antes = head(&core);
    locate(&core, &id, &con_commits, false).unwrap();
    assert_eq!(head(&core), antes);
}

#[test]
fn una_huella_igual_a_la_guardada_no_cuenta_como_adoptada() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let vacio = |n: &str| {
        let d = base.join("repos").join(n);
        std::fs::create_dir_all(&d).unwrap();
        g(&d, &["init", "-q", "-b", "main"]);
        d
    };
    let id = id_de(&registra(&core, &vacio("vacio-a")));
    let antes = head(&core);
    locate(&core, &id, &vacio("vacio-b"), false).unwrap();
    // El proyecto no tenía commits raíz, pero la huella del repositorio nuevo es idéntica: nada que adoptar.
    afirma_decision(&desde(&core, antes)[0], &id, "project.relocated", json!({ "fingerprint_adopted": false, "confirmed_mismatch": false }));
}

// ---------------------------------------------------------------------------------------------
// Privacidad del payload
// ---------------------------------------------------------------------------------------------

#[test]
fn ninguna_decision_copia_rutas_remotos_huellas_ni_commits() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let origen = repo(&base, "origen", Some("https://usuario:TOKEN@github.com/o/secreto.git"));
    let id = id_de(&registra(&core, &origen));
    let copia = clon(&base, &origen, "copia", Some("https://usuario:TOKEN@github.com/o/secreto.git"));
    let commit = g(&origen, &["rev-list", "--max-parents=0", "HEAD"]);
    let antes = head(&core);
    join(&core, &id, &copia).unwrap();
    locate(&core, &id, &copia, false).unwrap();
    rpc(&core, "project_archive", json!({ "project_id": id })).unwrap();
    rpc(&core, "project_archive", json!({ "project_id": id, "archived": false })).unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["project.location_added", "project.relocated", "project.archived", "project.restored"]);
    let (ruta_o, ruta_c) = (s(&origen), s(&copia));
    for e in &evs {
        let todo = format!("{e:?}");
        for prohibido in [ruta_o.as_str(), ruta_c.as_str(), &ruta_c.replace('\\', "/"), commit.as_str(), "github.com", "TOKEN", "display_path", "fingerprint\"", "default_branch"] {
            assert!(!todo.contains(prohibido), "{}: contiene «{prohibido}»: {todo}", e.kind);
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Solo una persona por la interfaz
// ---------------------------------------------------------------------------------------------

#[test]
fn las_decisiones_por_un_canal_que_no_es_la_interfaz_se_rechazan_sin_escribir_nada() {
    let (_l, data, _c, core) = core_listo();
    let (id, _origen, copia) = con_copia(&core, &data, Some("https://github.com/o/x.git"));
    let (antes, fp_antes, locs_antes) = (head(&core), proyecto(&core, &id), ubicaciones(&core, &id));
    for canal in [Channel::Lxo, Channel::Core] {
        let via = |cmd: &str, args: Value| core.rpc_via(canal, Caller::User, "", cmd, &args);
        for (cmd, args) in [
            ("project_add", json!({ "path": s(&copia), "join": id })),
            ("project_locate", json!({ "project_id": id, "path": s(&copia) })),
            ("project_archive", json!({ "project_id": id })),
        ] {
            let e = via(cmd, args).unwrap_err();
            assert!(e.contains("person/ui"), "{cmd} por {canal:?}: {e}");
        }
    }
    assert_eq!((head(&core), proyecto(&core, &id), ubicaciones(&core, &id)), (antes, fp_antes, locs_antes));
}

// ---------------------------------------------------------------------------------------------
// Core degradado
// ---------------------------------------------------------------------------------------------

#[test]
fn con_el_core_degradado_no_hay_ubicacion_ni_archivado_ni_relocate_ni_huella_ni_evento() {
    let (_l, data, _c, core) = core_listo();
    let (id, _origen, copia) = con_copia(&core, &data, Some("https://github.com/o/x.git"));
    let (antes, p_antes, locs_antes) = (head(&core), proyecto(&core, &id), ubicaciones(&core, &id));
    core.degrade_for_tests("fallo de prueba");
    for e in [
        join(&core, &id, &copia).unwrap_err(),
        locate(&core, &id, &copia, false).unwrap_err(),
        rpc(&core, "project_archive", json!({ "project_id": id })).unwrap_err(),
        rpc(&core, "project_archive", json!({ "project_id": id, "archived": false })).unwrap_err(),
    ] {
        assert!(e.contains("solo lectura"), "{e}");
    }
    assert_eq!((head(&core), proyecto(&core, &id), ubicaciones(&core, &id)), (antes, p_antes, locs_antes));
}

// ---------------------------------------------------------------------------------------------
// Atomicidad de la política: un fallo no deja nada a medias
// ---------------------------------------------------------------------------------------------

type Foto = (ProjectRow, Vec<LocationRow>, i64);

fn foto(core: &Core, id: &str) -> Foto {
    (proyecto(core, id), ubicaciones(core, id), head(core))
}

#[test]
fn join_y_relocate_no_dejan_ubicacion_nueva_con_huella_vieja_si_falla_la_huella() {
    let (_l, data, _c, core) = core_listo();
    let (id, _origen, copia) = con_copia(&core, &data, Some("https://github.com/o/x.git"));
    sql(&core, "CREATE TRIGGER falla_huella BEFORE UPDATE OF fingerprint ON projects BEGIN SELECT RAISE(ABORT, 'huella'); END;");
    let antes: Foto = foto(&core, &id);
    assert!(join(&core, &id, &copia).is_err());
    assert_eq!(foto(&core, &id), antes, "join: ni la ubicación ni el evento sin la huella");
    // Relocate adopta huella si el proyecto no tenía commits raíz.
    sql(&core, "DROP TRIGGER falla_huella; UPDATE projects SET fingerprint = '{\"root_commits\":[],\"remotes\":[],\"default_branch\":null}'");
    sql(&core, "CREATE TRIGGER falla_huella BEFORE UPDATE OF fingerprint ON projects BEGIN SELECT RAISE(ABORT, 'huella'); END;");
    let antes: Foto = foto(&core, &id);
    assert!(locate(&core, &id, &copia, false).is_err());
    assert_eq!(foto(&core, &id), antes, "relocate: ni la ubicación nueva ni el evento con la huella vieja");
    // Sin el fallo, las dos cosas ocurren juntas.
    sql(&core, "DROP TRIGGER falla_huella");
    locate(&core, &id, &copia, false).unwrap();
    let (p, locs, _) = foto(&core, &id);
    assert!(!p.fingerprint.root_commits.is_empty() && locs.iter().any(|l| l.primary && l.display_path.ends_with("copia")));
}

#[test]
fn si_falla_el_insert_del_evento_se_deshacen_todos_los_cambios_del_proyecto() {
    let (_l, data, _c, core) = core_listo();
    let (id, _origen, copia) = con_copia(&core, &data, Some("https://github.com/o/x.git"));
    for (kind, accion) in [
        ("project.location_added", 0),
        ("project.relocated", 1),
        ("project.archived", 2),
    ] {
        sql(&core, &format!("CREATE TRIGGER sin_evento BEFORE INSERT ON events WHEN NEW.kind = '{kind}' BEGIN SELECT RAISE(ABORT, 'evento'); END;"));
        let antes: Foto = foto(&core, &id);
        let r = match accion {
            0 => join(&core, &id, &copia),
            1 => locate(&core, &id, &copia, false),
            _ => rpc(&core, "project_archive", json!({ "project_id": id })),
        };
        assert!(r.is_err(), "{kind}: debía fallar sin su evento y devolvió Ok");
        assert_eq!(foto(&core, &id), antes, "{kind}: ni ubicación, ni huella, ni estado nuevos sin su evento");
        sql(&core, "DROP TRIGGER sin_evento");
    }
    // Sin el fallo, funcionan y dejan cada uno su evento.
    let antes = head(&core);
    join(&core, &id, &copia).unwrap();
    assert_eq!(kinds(&desde(&core, antes)), vec!["project.location_added"]);
}

// ---------------------------------------------------------------------------------------------
// Arquitectura
// ---------------------------------------------------------------------------------------------

#[test]
fn la_produccion_no_usa_las_apis_sin_evento_y_solo_project_ops_construye_las_decisiones() {
    let orch = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    let mut vistos = 0;
    for entrada in std::fs::read_dir(&orch).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        let prod = texto.split("mod tests {").next().unwrap().split("mod durable_tests {").next().unwrap();
        for (n, l) in prod.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")) {
            // Las APIs del almacén SIN evento son de prueba: la producción no las llama.
            for api in [".location_put(", ".project_set_fingerprint(", ".project_set_archived(", ".project_create("] {
                assert!(!l.contains(api), "{nombre}:{}: «{api}» cambia filas sin su hecho (usa las *_recorded)", n + 1);
            }
            // Los constructores de los cuatro hechos y las operaciones *_recorded solo viven en project_ops.rs.
            for (simbolo, donde) in [
                ("project_location_added(", &["event_kinds.rs", "project_ops.rs"][..]),
                ("project_archived(", &["event_kinds.rs", "project_ops.rs"]),
                ("project_restored(", &["event_kinds.rs", "project_ops.rs"]),
                ("project_relocated(", &["event_kinds.rs", "project_ops.rs"]),
                (".project_join_recorded(", &["project_ops.rs"]),
                (".project_relocate_recorded(", &["project_ops.rs"]),
                (".project_set_archived_recorded(", &["project_ops.rs"]),
                ("finalize_one(", &["events.rs", "project_ops.rs"]),
            ] {
                assert!(!l.contains(simbolo) || donde.contains(&nombre.as_str()), "{nombre}:{}: «{simbolo}» solo puede aparecer en {donde:?}", n + 1);
            }
        }
        vistos += 1;
    }
    assert!(vistos >= 30);
    // projects.rs no abre una segunda transacción para la misma decisión: sus decisiones pasan por project_ops.
    let projects = std::fs::read_to_string(orch.join("projects.rs")).unwrap();
    for f in ["join_project(", "relocate_project(", "set_archived("] {
        assert_eq!(projects.matches(f).count(), 1, "{f} se llama una sola vez");
    }
    let _ = Fingerprint::default();
}
