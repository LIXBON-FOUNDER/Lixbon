//! Pruebas de `project.registered` (slice E, E1b · Projects, commit 1): el nacimiento de un Project emite
//! UN evento en la misma transacción que su fila y su ubicación, con el actor y el canal correctos; nada
//! más lo emite; y con el Core degradado el registro no escribe nada.
//!
//! Se ejecutan sobre un Core REAL (SQLite autoritativa) y repositorios git reales.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::events::{Actor, Channel, MutationContext};
use super::project_ops::{register_project, ProjectOrigin, Registration};
use super::projects_tests::{base_de, clon, core_listo, g, id_de, lista, project_id_de_tarea, regiones, registra, repo, rpc, s, tarea_en};
use super::{Caller, Core};
use crate::store::{EventClass, EventQuery, EventRow, Fingerprint, NewLocation, StoreError, CORE_CLIENT_ID};

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

fn head(core: &Core) -> i64 {
    core.storage.with_store(|s| s.events_head().unwrap()).unwrap()
}

fn desde(core: &Core, seq: i64) -> Vec<EventRow> {
    core.storage.with_store(|s| s.events_page(&EventQuery { after: Some(seq), limit: Some(500), ..Default::default() }).unwrap().events).unwrap()
}

fn registrados(core: &Core) -> Vec<EventRow> {
    desde(core, 0).into_iter().filter(|e| e.kind == "project.registered").collect()
}

fn proyectos(core: &Core) -> usize {
    core.storage.with_store(|s| s.projects(true).unwrap().len()).unwrap()
}

fn ubicaciones(core: &Core) -> Vec<crate::store::LocationRow> {
    core.storage.with_store(|s| s.project_locations(None).unwrap()).unwrap()
}

fn meta(core: &Core, clave: &str) -> Option<String> {
    core.storage.with_store(|s| s.meta(clave).unwrap()).unwrap()
}

fn pl(e: &EventRow) -> Value {
    serde_json::from_str(&e.payload).unwrap()
}

fn kinds(evs: &[EventRow]) -> Vec<&str> {
    evs.iter().map(|e| e.kind.as_str()).collect()
}

/// Todo lo que fija el contrato de `project.registered` para el proyecto `id`.
#[derive(Clone, Copy)]
enum ClientIdExpected {
    Absent,
    Present,
    Core,
}

fn afirma_registro(
    e: &EventRow,
    id: &str,
    origin: &str,
    name: &str,
    actor: (&str, Option<&str>, &str),
    client_id: ClientIdExpected,
) {
    assert_eq!(e.kind, "project.registered");
    assert_eq!((e.class, e.v), (EventClass::State, 1));
    assert_eq!((e.entity_kind.as_str(), e.entity_id.as_str()), ("project", id));
    assert_eq!(e.project_id.as_deref(), Some(id), "el id del evento es el de la fila");
    assert_eq!(e.run_id, None, "un proyecto no pertenece a ningún run");
    assert_eq!(e.idem_key.as_deref(), Some(id), "idem_key = project_id");
    assert_eq!(e.correlation_id.as_deref(), None);
    match client_id {
        ClientIdExpected::Absent => assert_eq!(e.client_id.as_deref(), None),
        ClientIdExpected::Present => assert!(e.client_id.as_deref().is_some_and(|id| !id.is_empty())),
        ClientIdExpected::Core => assert_eq!(e.client_id.as_deref(), Some(CORE_CLIENT_ID)),
    }
    assert_eq!(e.state_rev, None, "no toca legacy_state");
    assert_eq!((e.actor_kind.as_str(), e.actor_id.as_deref(), e.channel.as_deref()), (actor.0, actor.1, Some(actor.2)));
    assert_eq!(pl(e), json!({ "origin": origin, "name": name, "has_remote": false, "root_commit_count": 1 }));
}

fn run_create(core: &std::sync::Arc<Core>, caller: Caller, repo: &Path) -> Result<Value, String> {
    let args = if matches!(caller, Caller::Agent(Some(_))) { json!({ "objective": "o", "session": true }) } else { json!({ "objective": "o" }) };
    core.rpc(caller, &s(repo), "run_create", &args)
}

// ---------------------------------------------------------------------------------------------
// Cada origen crea exactamente un evento, con su actor y su canal
// ---------------------------------------------------------------------------------------------

#[test]
fn project_add_nuevo_emite_un_registro_manual_de_la_persona_por_la_interfaz() {
    let (_l, data, _c, core) = core_listo();
    let r = repo(&base_de(&data), "manual", None);
    let antes = head(&core);
    let v = rpc(&core, "project_add", json!({ "path": s(&r), "name": "Mi aplicación" })).unwrap();
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["project.registered"]);
    afirma_registro(&evs[0], &id_de(&v), "manual", "Mi aplicación", ("person", Some("user"), "ui"), ClientIdExpected::Present);
}

#[test]
fn run_create_de_una_persona_registra_en_auto_y_atribuye_el_proyecto_a_la_persona() {
    let (_l, data, _c, core) = core_listo();
    let r = repo(&base_de(&data), "auto-persona", None);
    let antes = head(&core);
    let out = run_create(&core, Caller::User, &r).unwrap();
    let evs = desde(&core, antes);
    let reg: Vec<_> = evs.iter().filter(|e| e.kind == "project.registered").collect();
    assert_eq!(reg.len(), 1);
    let id = project_id_de_tarea(&core, out["task"].as_str().unwrap()).expect("la tarea tiene proyecto");
    afirma_registro(reg[0], &id, "auto", "auto-persona", ("person", Some("user"), "ui"), ClientIdExpected::Present);
    assert_eq!(evs[0].kind, "project.registered", "el proyecto nace ANTES que el run que lo usa");
    let run = evs.iter().find(|e| e.kind == "run.created").unwrap();
    assert_eq!(run.project_id.as_deref(), Some(id.as_str()), "y el run lo cita");
}

#[test]
fn run_create_de_un_agente_sin_identidad_registra_como_sistema_por_el_canal_de_la_peticion() {
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let r = repo(&base_de(&data), "auto-sin-id", None);
    let antes = head(&core);
    let out = run_create(&core, Caller::Agent(None), &r).unwrap();
    let reg: Vec<_> = desde(&core, antes).into_iter().filter(|e| e.kind == "project.registered").collect();
    assert_eq!(reg.len(), 1);
    let id = project_id_de_tarea(&core, out["task"].as_str().unwrap()).unwrap();
    afirma_registro(&reg[0], &id, "auto", "auto-sin-id", ("system", None, "lxo"), ClientIdExpected::Absent);
}

#[test]
fn run_create_de_un_agente_con_identidad_registra_como_ese_agente() {
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let r = repo(&base_de(&data), "auto-agente", None);
    let antes = head(&core);
    let out = run_create(&core, Caller::Agent(Some("sesion-previa".into())), &r).unwrap();
    let reg: Vec<_> = desde(&core, antes).into_iter().filter(|e| e.kind == "project.registered").collect();
    assert_eq!(reg.len(), 1);
    let id = project_id_de_tarea(&core, out["task"].as_str().unwrap()).unwrap();
    afirma_registro(&reg[0], &id, "auto", "auto-agente", ("agent", Some("sesion-previa"), "lxo"), ClientIdExpected::Absent);
}

#[test]
fn el_relleno_registra_como_sistema_por_el_canal_core_y_repetirlo_no_emite_mas() {
    let (_l, data, _c, core) = core_listo();
    let r = repo(&base_de(&data), "relleno", None);
    let t = tarea_en(&core, &s(&r), "vieja");
    let antes = head(&core);
    assert_eq!(core.backfill_projects(Duration::from_secs(60)).unwrap()["assigned"], 1);
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["project.registered"], "un proyecto nuevo, un evento; asignar el project_id a la tarea no emite nada");
    let id = project_id_de_tarea(&core, &t).unwrap();
    afirma_registro(&evs[0], &id, "backfill", "relleno", ("system", None, "core"), ClientIdExpected::Core);
    // Otra pasada: nada nuevo que registrar.
    let tras = head(&core);
    assert_eq!(core.backfill_projects(Duration::from_secs(60)).unwrap()["assigned"], 0);
    assert_eq!(head(&core), tras);
}

#[test]
fn la_importacion_registra_como_sistema_por_la_interfaz_y_un_evento_por_proyecto_nuevo() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let (a, b) = (repo(&base, "imp-a", None), repo(&base, "imp-b", None));
    let antes = head(&core);
    let out = rpc(&core, "projects_import_recents", json!({ "paths": [s(&a), s(&b), s(&a)] })).unwrap();
    assert_eq!((out["imported"].clone(), out["existing"].clone()), (json!(2), json!(1)));
    let evs = desde(&core, antes);
    assert_eq!(kinds(&evs), vec!["project.registered", "project.registered"], "uno por proyecto que NACE; la repetida no emite");
    let ids: Vec<String> = lista(&core).iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
    for (e, nombre) in evs.iter().zip(["imp-a", "imp-b"]) {
        assert!(ids.contains(e.project_id.as_ref().unwrap()));
        afirma_registro(e, e.project_id.as_ref().unwrap(), "import", nombre, ("system", None, "ui"), ClientIdExpected::Present);
    }
    // La importación es de una sola vez: la segunda llamada no escribe ni emite.
    let tras = head(&core);
    assert_eq!(rpc(&core, "projects_import_recents", json!({ "paths": [s(&a)] })).unwrap()["already_done"], true);
    assert_eq!(head(&core), tras);
}

// ---------------------------------------------------------------------------------------------
// Lo que NO es un nacimiento no emite nada
// ---------------------------------------------------------------------------------------------

#[test]
fn la_misma_ruta_o_su_worktree_o_un_run_sobre_un_repo_ya_registrado_no_emiten() {
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let base = base_de(&data);
    let r = repo(&base, "api", Some("https://github.com/o/api.git"));
    let id = id_de(&registra(&core, &r));
    assert_eq!(registrados(&core).len(), 1);

    let antes = head(&core);
    assert_eq!(registra(&core, &r)["created"], false, "misma ruta");
    let wt = base.join("repos").join("api.lixbon-wt").join("t1");
    g(&r, &["worktree", "add", "-q", "-b", "lx/t1", wt.to_str().unwrap()]);
    assert_eq!(id_de(&registra(&core, &wt)), id, "su worktree");
    assert_eq!(core.project_for_repo(&MutationContext::core(), &s(&r)), Ok(Some(id.clone())), "descubrimiento automático");
    assert_eq!(head(&core), antes, "ni un solo evento");

    // Un run sobre el repo ya registrado usa el proyecto existente: emite los eventos del run, no un registro.
    let out = run_create(&core, Caller::Agent(None), &r).unwrap();
    assert_eq!(project_id_de_tarea(&core, out["task"].as_str().unwrap()), Some(id));
    assert_eq!(registrados(&core).len(), 1);
    assert_eq!(proyectos(&core), 1);
}

#[test]
fn lo_ambiguo_no_emite_y_el_join_emite_location_added_no_registered() {
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let base = base_de(&data);
    let origen = repo(&base, "origen", None);
    let id = id_de(&registra(&core, &origen));
    let copia = clon(&base, &origen, "copia", None);
    let t = tarea_en(&core, &s(&copia), "ambigua");
    let antes = head(&core);

    // project_add: pide confirmación y no crea.
    assert_eq!(rpc(&core, "project_add", json!({ "path": s(&copia) })).unwrap()["status"], "needs_confirmation");
    // Descubrimiento automático: ambiguo -> sin proyecto.
    assert_eq!(core.project_for_repo(&MutationContext::person(Channel::Ui), &s(&copia)), Ok(None));
    // run_create sobre el repo ambiguo: el run nace sin proyecto.
    let out = run_create(&core, Caller::Agent(None), &copia).unwrap();
    assert_eq!(project_id_de_tarea(&core, out["task"].as_str().unwrap()), None);
    // Relleno: la tarea ambigua se cuenta como ambigua.
    let rel = core.backfill_projects(Duration::from_secs(60)).unwrap();
    assert_eq!(rel["assigned"], 0);
    assert!(rel["ambiguous"].as_u64().unwrap() >= 1, "{rel}");
    assert_eq!(project_id_de_tarea(&core, &t), None);
    // Importación: se omite y se informa.
    let imp = rpc(&core, "projects_import_recents", json!({ "paths": [s(&copia)] })).unwrap();
    assert_eq!((imp["imported"].clone(), imp["skipped"].as_array().unwrap().len()), (json!(0), 1));
    assert_eq!(registrados(&core).len(), 1, "solo el de `origen`");
    assert!(desde(&core, antes).iter().all(|e| e.kind != "project.registered"));

    // join: el proyecto YA existía; su hecho es `project.location_added`, nunca `project.registered`.
    let antes_join = head(&core);
    let j = rpc(&core, "project_add", json!({ "path": s(&copia), "join": id })).unwrap();
    assert_eq!(j["created"], false);
    assert_eq!(ubicaciones(&core).len(), 2, "la ubicación sí se guardó");
    assert_eq!(kinds(&desde(&core, antes_join)), vec!["project.location_added"], "join no emite project.registered");
    assert_eq!(registrados(&core).len(), 1);
    assert_eq!(proyectos(&core), 1);
}

#[test]
fn repetir_project_add_no_duplica_el_evento() {
    let (_l, data, _c, core) = core_listo();
    let r = repo(&base_de(&data), "idem", None);
    let id = id_de(&registra(&core, &r));
    for _ in 0..3 {
        assert_eq!(id_de(&registra(&core, &r)), id);
    }
    let reg = registrados(&core);
    assert_eq!(reg.len(), 1);
    assert_eq!(reg[0].idem_key.as_deref(), Some(id.as_str()));
}

// ---------------------------------------------------------------------------------------------
// Contenido del payload y relación con legacy_state
// ---------------------------------------------------------------------------------------------

#[test]
fn el_payload_no_lleva_ruta_remoto_commits_ni_huella() {
    let (_l, data, _c, core) = core_listo();
    let r = repo(&base_de(&data), "secreto", Some("https://usuario:TOKEN@github.com/o/secreto.git"));
    let commit = g(&r, &["rev-list", "--max-parents=0", "HEAD"]);
    let id = id_de(&registra(&core, &r));
    let e = &registrados(&core)[0];
    assert_eq!(e.project_id.as_deref(), Some(id.as_str()));
    let p = pl(e);
    let mut claves: Vec<&str> = p.as_object().unwrap().keys().map(String::as_str).collect();
    claves.sort_unstable();
    assert_eq!(claves, vec!["has_remote", "name", "origin", "root_commit_count"], "contrato cerrado");
    assert_eq!((p["has_remote"].clone(), p["root_commit_count"].clone()), (json!(true), json!(1)));
    // Ninguna columna del evento filtra la ruta, el remoto, el commit raíz ni la huella.
    let todo = format!("{e:?}");
    let ruta = s(&r);
    for prohibido in [ruta.as_str(), &ruta.replace('\\', "/"), commit.as_str(), "github.com", "TOKEN", "display_path", "fingerprint", "default_branch"] {
        assert!(!todo.contains(prohibido), "el evento contiene «{prohibido}»: {todo}");
    }
}

#[test]
fn registrar_un_proyecto_no_confirma_legacy_state() {
    let (_l, data, _c, core) = core_listo();
    let r = repo(&base_de(&data), "sin-rev", None);
    let rev = core.storage.confirmed_rev().unwrap();
    registra(&core, &r);
    assert_eq!(core.storage.confirmed_rev().unwrap(), rev, "la rev del estado no avanza: el nacimiento es del registro");
    assert!(registrados(&core).iter().all(|e| e.state_rev.is_none()));
}

#[test]
fn el_nombre_del_payload_se_recorta() {
    let (_l, data, _c, core) = core_listo();
    let r = repo(&base_de(&data), "largo", None);
    let nombre = "ñ".repeat(500);
    rpc(&core, "project_add", json!({ "path": s(&r), "name": nombre })).unwrap();
    let n = pl(&registrados(&core)[0])["name"].as_str().unwrap().to_string();
    assert_eq!(n.chars().count(), 120);
    assert!(n.ends_with('…'));
}

// ---------------------------------------------------------------------------------------------
// Atomicidad desde la capa de política
// ---------------------------------------------------------------------------------------------

fn fp() -> Fingerprint {
    Fingerprint { root_commits: vec!["c1".into()], remotes: vec![], default_branch: None }
}

fn ubic(path: &str) -> NewLocation {
    NewLocation { machine: "m".into(), path: path.into(), display_path: path.into(), primary: true }
}

#[test]
fn un_fallo_al_insertar_la_ubicacion_no_deja_proyecto_ni_evento() {
    let (_l, _d, _c, core) = core_listo();
    let ctx = MutationContext::person(Channel::Ui);
    let reg = Registration::new(ProjectOrigin::Manual, &ctx).unwrap();
    core.storage.with_store(|st| register_project(st, "a", &fp(), &ubic("c:/a"), &reg)).unwrap().unwrap();
    assert_eq!((proyectos(&core), ubicaciones(&core).len(), registrados(&core).len()), (1, 1, 1));
    // La misma ruta, otro proyecto: el INSERT de la ubicación falla DESPUÉS del de la fila.
    let r = core.storage.with_store(|st| register_project(st, "b", &fp(), &ubic("c:/a"), &reg)).unwrap();
    assert!(matches!(r, Err(StoreError::ProjectConflict(_))), "{r:?}");
    assert_eq!((proyectos(&core), ubicaciones(&core).len(), registrados(&core).len()), (1, 1, 1), "nada quedó a medias");
}

#[test]
fn la_politica_exige_el_par_exacto_origen_actor_y_canal() {
    let (_l, _d, _c, core) = core_listo();
    use Channel::{Core as Nucleo, Lxo, Ui};
    let casos: Vec<(ProjectOrigin, MutationContext, bool)> = vec![
        // manual: Person + Ui
        (ProjectOrigin::Manual, MutationContext::person(Ui), true),
        (ProjectOrigin::Manual, MutationContext::person(Lxo), false),
        (ProjectOrigin::Manual, MutationContext::person(Nucleo), false),
        (ProjectOrigin::Manual, MutationContext::system(Ui), false),
        (ProjectOrigin::Manual, MutationContext::core(), false),
        (ProjectOrigin::Manual, MutationContext::agent("t", Lxo), false),
        // backfill: System + Core
        (ProjectOrigin::Backfill, MutationContext::core(), true),
        (ProjectOrigin::Backfill, MutationContext::system(Ui), false),
        (ProjectOrigin::Backfill, MutationContext::system(Lxo), false),
        (ProjectOrigin::Backfill, MutationContext::person(Nucleo), false),
        (ProjectOrigin::Backfill, MutationContext::person(Ui), false),
        // import: System + Ui
        (ProjectOrigin::Import, MutationContext::system(Ui), true),
        (ProjectOrigin::Import, MutationContext::system(Lxo), false),
        (ProjectOrigin::Import, MutationContext::system(Nucleo), false),
        (ProjectOrigin::Import, MutationContext::person(Ui), false),
        // auto: conserva el actor real y el canal de la petición (no se fija a Ui)
        (ProjectOrigin::Auto, MutationContext::person(Ui), true),
        (ProjectOrigin::Auto, MutationContext::person(Lxo), true),
        (ProjectOrigin::Auto, MutationContext::agent("t", Lxo), true),
        (ProjectOrigin::Auto, MutationContext::agent("t", Ui), true),
        (ProjectOrigin::Auto, MutationContext::system(Lxo), true),
        (ProjectOrigin::Auto, MutationContext::new(Actor::System, Ui), true),
    ];
    let mut esperados = 0;
    for (n, (origen, ctx, valido)) in casos.into_iter().enumerate() {
        let reg = Registration::new(origen, &ctx);
        assert_eq!(reg.is_ok(), valido, "{origen:?} con {ctx:?}: {:?}", reg.as_ref().err());
        if let Ok(reg) = reg {
            let r = core.storage.with_store(|st| register_project(st, "p", &fp(), &ubic(&format!("c:/p{n}")), &reg)).unwrap();
            r.expect("un registro válido se registra");
            esperados += 1;
        }
        assert_eq!((proyectos(&core), registrados(&core).len()), (esperados, esperados), "una combinación inválida no deja fila ni evento");
    }
}

/// Nada nuevo en el almacén: ni proyecto, ni ubicación, ni evento, ni `meta` (en particular `machine_id`).
fn sin_escrituras(core: &Core, eventos: i64) {
    assert_eq!((head(core), proyectos(core), ubicaciones(core).len()), (eventos, 0, 0));
    for clave in ["machine_id", "projects_backfilled", "projects_recents_imported"] {
        assert_eq!(meta(core, clave), None, "{clave}");
    }
}

#[test]
fn project_add_manual_por_un_canal_que_no_es_la_interfaz_se_rechaza_sin_escribir_nada() {
    let (_l, data, _c, core) = core_listo();
    let r = repo(&base_de(&data), "por-lxo", None);
    let antes = head(&core);
    let e = core.rpc_via(Channel::Lxo, Caller::User, "", "project_add", &json!({ "path": s(&r) })).unwrap_err();
    assert!(e.contains("person/ui"), "{e}");
    sin_escrituras(&core, antes);
    // Por la interfaz sí.
    core.rpc_via(Channel::Ui, Caller::User, "", "project_add", &json!({ "path": s(&r) })).unwrap();
    assert_eq!(proyectos(&core), 1);
}

#[test]
fn la_importacion_por_un_canal_que_no_es_la_interfaz_se_rechaza_sin_escribir_nada() {
    let (_l, data, _c, core) = core_listo();
    let r = repo(&base_de(&data), "imp-lxo", None);
    let antes = head(&core);
    for canal in [Channel::Lxo, Channel::Core] {
        let e = core.rpc_via(canal, Caller::User, "", "projects_import_recents", &json!({ "paths": [s(&r)] })).unwrap_err();
        assert!(e.contains("system/ui"), "{e}");
        sin_escrituras(&core, antes);
    }
    // La marca de «ya importado» tampoco se puso: la importación legítima por la interfaz sigue disponible.
    let ok = core.rpc_via(Channel::Ui, Caller::User, "", "projects_import_recents", &json!({ "paths": [s(&r)] })).unwrap();
    assert_eq!(ok["imported"], 1);
}

#[test]
fn run_create_automatico_conserva_el_canal_de_la_peticion_y_no_se_fija_a_la_interfaz() {
    let (_l, data, _c, core) = core_listo();
    let r = repo(&base_de(&data), "auto-lxo", None);
    // Una persona que llega por `lxo`: válido para `auto`, canal `lxo`.
    core.rpc_via(Channel::Lxo, Caller::User, &s(&r), "run_create", &json!({ "objective": "o" })).unwrap();
    let reg = registrados(&core);
    assert_eq!(reg.len(), 1);
    assert_eq!((reg[0].actor_kind.as_str(), reg[0].channel.as_deref()), ("person", Some("lxo")));
}

// ---------------------------------------------------------------------------------------------
// Con el Core degradado el registro no escribe; las lecturas siguen
// ---------------------------------------------------------------------------------------------

#[test]
fn con_el_core_degradado_las_cuatro_vias_de_creacion_y_la_gestion_rechazan_sin_escribir() {
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let base = base_de(&data);
    let existente = repo(&base, "existente", None);
    let id = id_de(&registra(&core, &existente));
    let nuevo = repo(&base, "nuevo", None);
    let vieja = repo(&base, "vieja", None);
    tarea_en(&core, &s(&vieja), "vieja");
    let (eventos, ubic_antes, runs) = (head(&core), ubicaciones(&core), core.lock().runs.len());
    let marcas_antes = (meta(&core, "projects_backfilled"), meta(&core, "projects_recents_imported"));

    core.degrade_for_tests("fallo de prueba");

    // Las cuatro vías de creación.
    let e = rpc(&core, "project_add", json!({ "path": s(&nuevo) })).unwrap_err();
    assert!(e.contains("solo lectura"), "{e}");
    let e = run_create(&core, Caller::User, &nuevo).unwrap_err();
    assert!(e.contains("solo lectura"), "{e}");
    // El descubrimiento automático rechaza también lo que no puede identificar (no devuelve un `Ok(None)` silencioso).
    let e = core.project_for_repo(&MutationContext::core(), &s(&base.join("no-existe"))).unwrap_err();
    assert!(e.contains("solo lectura"), "{e}");
    assert!(core.project_for_repo(&MutationContext::core(), &s(&existente)).is_err());
    let e = core.backfill_projects(Duration::from_secs(60)).unwrap_err();
    assert!(e.contains("solo lectura"), "{e}");
    let e = rpc(&core, "projects_import_recents", json!({ "paths": [s(&nuevo)] })).unwrap_err();
    assert!(e.contains("solo lectura"), "{e}");
    // Y el resto de escrituras del registro: unir una ubicación, relocalizar y archivar.
    let e = rpc(&core, "project_add", json!({ "path": s(&existente), "join": id })).unwrap_err();
    assert!(e.contains("solo lectura"), "{e}");
    let e = rpc(&core, "project_locate", json!({ "project_id": id, "path": s(&existente) })).unwrap_err();
    assert!(e.contains("solo lectura"), "{e}");
    let e = rpc(&core, "project_archive", json!({ "project_id": id })).unwrap_err();
    assert!(e.contains("solo lectura"), "{e}");

    assert_eq!((head(&core), ubicaciones(&core), core.lock().runs.len()), (eventos, ubic_antes, runs), "ni eventos, ni ubicaciones, ni runs");
    assert_eq!(proyectos(&core), 1);
    assert_eq!((meta(&core, "projects_backfilled"), meta(&core, "projects_recents_imported")), marcas_antes, "ni marcas de relleno ni de importación");
    assert!(lista(&core).iter().all(|p| p["state"] == "active"), "y el proyecto no se archivó");
}

#[test]
fn con_el_core_degradado_projects_y_la_guarda_de_lanzamiento_leen_sin_escribir_marcas() {
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let r = repo(&base_de(&data), "app", None);
    let id = id_de(&registra(&core, &r));
    let t = tarea_en(&core, &s(&r), "trabajo");
    core.mutate(|st| {
        st.tasks.get_mut(&t).unwrap().project_id = Some(id.clone());
        Ok(())
    })
    .unwrap();
    assert!(core.check_project_launchable(&t).is_ok());
    std::fs::remove_dir_all(r.join(".git")).unwrap();
    std::fs::remove_dir_all(&r).unwrap();

    core.degrade_for_tests("fallo de prueba");
    // La lectura funciona y calcula `missing` en memoria…
    assert_eq!(lista(&core)[0]["locations"][0]["state"], "missing");
    let e = core.check_project_launchable(&t).unwrap_err();
    assert!(e.contains("project_locate"), "{e}");
    // …pero no lo persiste: en la base la ubicación sigue como `ok`.
    assert!(ubicaciones(&core).iter().all(|l| !l.missing), "ninguna marca escrita en solo lectura");
}

#[test]
fn una_lectura_con_el_core_degradado_no_crea_el_machine_id() {
    let (_l, _d, _c, core) = core_listo();
    assert_eq!(meta(&core, "machine_id"), None, "un Core nuevo aún no lo tiene");
    core.degrade_for_tests("fallo de prueba");
    let e = core.check_project_launchable_id("p-que-no-existe").unwrap_err();
    assert!(e.contains("no existe en el registro"), "{e}");
    assert_eq!(rpc(&core, "projects", json!({})).unwrap()["projects"], json!([]));
    assert_eq!(meta(&core, "machine_id"), None, "leer no escribe `meta`");
}

#[test]
fn en_salud_normal_el_machine_id_nace_con_la_primera_escritura_y_las_lecturas_no_lo_crean() {
    let (_l, data, _c, core) = core_listo();
    assert!(core.check_project_launchable_id("fantasma").is_err());
    rpc(&core, "projects", json!({})).unwrap();
    assert_eq!(meta(&core, "machine_id"), None);
    registra(&core, &repo(&base_de(&data), "primero", None));
    assert!(meta(&core, "machine_id").is_some());
}

// ---------------------------------------------------------------------------------------------
// Arquitectura
// ---------------------------------------------------------------------------------------------

fn fuentes(dir: &Path) -> Vec<(String, Vec<(usize, String)>)> {
    let mut out = vec![];
    for entrada in std::fs::read_dir(dir).unwrap() {
        let ruta: PathBuf = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        // Producción: sin comentarios y sin los módulos de pruebas incrustados.
        let prod = texto.split("mod tests {").next().unwrap().split("mod durable_tests {").next().unwrap();
        out.push((nombre, prod.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")).map(|(n, l)| (n + 1, l.to_string())).collect()));
    }
    out
}

#[test]
fn solo_project_ops_construye_los_eventos_de_projects_y_solo_el_almacen_inserta_sql() {
    let orch = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    let store = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("store");
    // (símbolo, archivos donde puede aparecer)
    let prohibido: [(&str, &[&str]); 9] = [
        ("project_registered(", &["event_kinds.rs", "project_ops.rs"]),
        ("ProjectRegistered", &["event_kinds.rs"]),
        ("ProjectOrigin::", &["event_kinds.rs", "project_ops.rs", "projects.rs"]),
        (".project_register(", &["project_ops.rs"]),
        ("register_project(", &["project_ops.rs", "projects.rs"]),
        ("finalize_all", &["events.rs", "mutation.rs", "project_ops.rs"]),
        ("INSERT INTO", &[]),
        ("rusqlite", &[]),
        ("project_create(", &[]),
    ];
    let mut vistos = 0;
    for (nombre, lineas) in fuentes(&orch) {
        vistos += 1;
        for (n, l) in lineas {
            for (simbolo, donde) in prohibido {
                assert!(!l.contains(simbolo) || donde.contains(&nombre.as_str()), "{nombre}:{n}: «{simbolo}» solo puede aparecer en {donde:?}");
            }
        }
    }
    assert!(vistos >= 30);

    // El almacén: un solo INSERT de eventos y un solo punto desde el que se llama.
    for (nombre, lineas) in fuentes(&store) {
        for (n, l) in &lineas {
            assert!(!l.contains("INSERT INTO events") || nombre == "events.rs", "store/{nombre}:{n}: el INSERT de `events` es solo de events.rs");
            assert!(
                !l.contains("insert_events(") || ["events.rs", "projects.rs", "authority.rs"].contains(&nombre.as_str()),
                "store/{nombre}:{n}: insert_events solo lo llaman las transacciones del almacén"
            );
        }
    }
}

#[test]
fn project_ops_no_hace_io_externo_ni_construye_borradores_a_mano() {
    let src = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch").join("project_ops.rs")).unwrap();
    let prod: String = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n");
    // Corre dentro del closure del almacén: ni disco, ni git, ni procesos, ni el estado del Core.
    for p in [
        "Path::new", ".exists()", "std::fs", "fs::", "git::", "identify(", "std::process", "Command", "std::thread", "sleep(", "self.lock()", "self.mutate(", "EventDraft::new",
        "serde_json::json!", "INSERT",
    ] {
        assert!(!prod.contains(p), "project_ops.rs no puede contener «{p}»");
    }
    assert!(prod.contains("event_kinds::project_registered") && prod.contains("project_register("));
}

#[test]
fn el_registro_separa_lecturas_y_escrituras_en_dos_fronteras() {
    let src = include_str!("projects.rs");
    let prod: String = src.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("
");
    // El único `with_store(` de este archivo son las dos fronteras (lectura y escritura). Las escrituras
    // necesitan `&mut Store`, que solo da `registry_write_opt`, y esa comprueba `Health` antes de nada.
    assert_eq!(prod.matches(".with_store(").count(), 2, "todo pasa por registry_read_opt / registry_write_opt");
    let escritura = regiones(&prod, "fn registry_write_opt<R>(").len();
    assert_eq!(escritura, 1);
    assert!(prod.contains("self.require_registry_writable()?;
        match self.storage.with_store(f)"), "la frontera de escritura comprueba Health ANTES de abrir el almacén");
    // Una lectura recibe `&Store`: nunca nombra un método que escribe.
    let mut lecturas = 0;
    for llamada in [".registry_read(", ".registry_read_opt("] {
        for r in regiones(&prod, llamada) {
            lecturas += 1;
            for w in [".meta_set(", ".location_put(", ".project_set_", ".locations_mark(", "register_project(", "machine_id_ensure(", ".write("] {
                assert!(!r.contains(w), "una lectura del registro no puede escribir («{w}»):
{r}");
            }
        }
    }
    assert!(lecturas >= 4, "vio {lecturas} lecturas");
}
