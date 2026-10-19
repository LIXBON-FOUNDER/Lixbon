//! LXO-90 · contrato de `projects_overview`: overview multiproyecto de solo lectura.

use std::sync::Arc;

use serde_json::{json, Value};

use super::attention_read_tests::{agente, attention, core_listo, persona, raise, rpc};
use super::events::Channel;
use super::state::{NewTask, Status};
use super::{Caller, Core};
use crate::store::{AttentionCategory, Fingerprint, NewLocation, Severity};

const MACHINE: &str = "machine-a";

fn overview(core: &Arc<Core>, person: &crate::store::AuthenticatedClient, args: Value) -> Value {
    rpc(core, person, "projects_overview", args).expect("projects_overview responde a una Person autenticada")
}

fn person(core: &Core) -> crate::store::AuthenticatedClient {
    persona(core, "person-overview", "install-person-overview", "person-overview-secret-0123456789abcdef")
}

/// Registra un proyecto sin evento (fixture) con una ubicación principal en `machine`.
fn proyecto(core: &Core, name: &str, machine: &str, path: &str) -> String {
    core.storage
        .with_store(|store| {
            store
                .project_create(
                    name,
                    &Fingerprint::default(),
                    &NewLocation { machine: machine.into(), path: path.into(), display_path: path.into(), primary: true },
                )
                .unwrap()
                .id
        })
        .unwrap()
}

fn archiva(core: &Core, project: &str) {
    core.storage.with_store(|store| assert!(store.project_set_archived(project, true).unwrap())).unwrap();
}

/// Una task raíz en marcha del proyecto (o sin proyecto).
fn tarea(core: &Core, title: &str, project: Option<&str>) -> String {
    core.mutate(|tx| {
        let (_run, root) = tx.create_run(
            title,
            NewTask {
                agent: "claude".into(),
                model: None,
                effort: None,
                role: None,
                title: title.into(),
                spec: "spec".into(),
                repo: "repo".into(),
                cwd: "cwd".into(),
                branch: None,
                base: None,
                worktree: None,
                external: true,
            },
        );
        tx.mark_running(&root)?;
        if let Some(t) = tx.tasks.get_mut(&root) {
            t.project_id = project.map(str::to_string);
        }
        Ok(root)
    })
    .unwrap()
}

fn falla(core: &Core, task: &str) {
    core.mutate(|tx| tx.fail_with(task, "agent_idle_timeout", "sin actividad").map(|_| ())).unwrap();
}

fn cierra(core: &Core, task: &str) {
    core.mutate(|tx| tx.close(task, Status::Done, "hecho").map(|_| ())).unwrap();
}

fn de<'a>(out: &'a Value, id: &str) -> &'a Value {
    out["projects"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap_or_else(|| panic!("el proyecto {id} no está en {out}"))
}

fn ids(out: &Value) -> Vec<String> {
    out["projects"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn cero_proyectos_devuelve_un_overview_vacio_de_forma_estable() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let out = overview(&core, &person(&core), json!({}));
    assert_eq!(out["v"], 1);
    assert_eq!(out["total"], 0);
    assert_eq!(out["projects"], json!([]));
    assert_eq!(out["filters"], json!({ "archived": "exclude", "machine": null }));
    assert_eq!(out["unassigned"]["tasks"], 0);
    assert_eq!(out["unassigned"]["attention"]["total"], 0);
}

#[test]
fn un_proyecto_sin_trabajo_esta_idle_con_todas_las_categorias_en_cero() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let id = proyecto(&core, "Solo", MACHINE, "/repos/solo");
    let out = overview(&core, &person(&core), json!({}));
    assert_eq!(out["total"], 1);
    let p = de(&out, &id);
    assert_eq!(p["name"], "Solo");
    assert_eq!(p["state"], "active");
    assert_eq!(p["status"], "idle");
    assert_eq!(p["counts"]["tasks"], 0);
    assert_eq!(p["counts"]["active"], 0);
    assert_eq!(p["counts"]["failed"], 0);
    let categories = p["counts"]["attention"]["by_category"].as_object().unwrap();
    let mut names: Vec<_> = categories.keys().map(String::as_str).collect();
    names.sort();
    assert_eq!(names, ["approval", "conflict", "environment_blocked", "failed", "question", "review_ready", "risk"]);
    assert!(categories.values().all(|n| n == 0), "sin Attention, las siete categorías valen 0");
}

#[test]
fn n_proyectos_salen_ordenados_por_nombre_sin_mayusculas_y_luego_por_project_id() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let zeta = proyecto(&core, "zeta", MACHINE, "/repos/zeta");
    let beta = proyecto(&core, "Beta", MACHINE, "/repos/beta");
    let alfa_1 = proyecto(&core, "alfa", MACHINE, "/repos/alfa-1");
    let alfa_2 = proyecto(&core, "ALFA", MACHINE, "/repos/alfa-2");
    let person = person(&core);
    let out = overview(&core, &person, json!({}));
    let mut gemelos = [alfa_1, alfa_2];
    gemelos.sort();
    let esperado: Vec<String> = gemelos.into_iter().chain([beta, zeta]).collect();
    assert_eq!(ids(&out), esperado, "nombre en minúsculas y, a igualdad, project_id");
    assert_eq!(out["total"], 4);
    assert_eq!(overview(&core, &person, json!({})), out, "mismo Core, misma respuesta");
}

#[test]
fn proyecto_con_activo_fallido_y_attention_se_resume_correctamente() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let id = proyecto(&core, "Mixto", MACHINE, "/repos/mixto");
    let otro = proyecto(&core, "Otro", MACHINE, "/repos/otro");
    let viva_1 = tarea(&core, "viva-1", Some(&id));
    let _viva_2 = tarea(&core, "viva-2", Some(&id));
    let rota = tarea(&core, "rota", Some(&id));
    let hecha = tarea(&core, "hecha", Some(&id));
    let _ajena = tarea(&core, "ajena", Some(&otro));
    falla(&core, &rota);
    cierra(&core, &hecha);
    raise(&core, attention(AttentionCategory::Question, &viva_1, &id, Severity::Medium, 1_000));
    raise(&core, attention(AttentionCategory::ReviewReady, &hecha, &id, Severity::Medium, 2_000));
    raise(&core, attention(AttentionCategory::ReviewReady, &rota, &otro, Severity::Medium, 3_000));

    let out = overview(&core, &person(&core), json!({}));
    let p = de(&out, &id);
    assert_eq!(p["counts"]["tasks"], 4);
    assert_eq!(p["counts"]["active"], 2, "las no finales: viva-1 y viva-2");
    assert_eq!(p["counts"]["failed"], 1);
    // Fallar una task levanta sola una Attention `failed` (LXO-88): señal distinta del contador de tasks.
    assert_eq!(p["counts"]["attention"]["total"], 3);
    assert_eq!(p["counts"]["attention"]["by_category"]["question"], 1);
    assert_eq!(p["counts"]["attention"]["by_category"]["review_ready"], 1);
    assert_eq!(p["counts"]["attention"]["by_category"]["failed"], 1);
    assert_eq!(p["status"], "failed");
    let q = de(&out, &otro);
    assert_eq!(q["counts"]["tasks"], 1, "las tasks y la Attention de otro proyecto no se mezclan");
    assert_eq!(q["counts"]["attention"]["by_category"]["review_ready"], 1);
}

#[test]
fn el_estado_agregado_prioriza_failed_luego_attention_luego_active_y_si_no_idle() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let con_fallo = proyecto(&core, "a-fallo", MACHINE, "/repos/a");
    let con_attention = proyecto(&core, "b-attention", MACHINE, "/repos/b");
    let activo = proyecto(&core, "c-activo", MACHINE, "/repos/c");
    let quieto = proyecto(&core, "d-quieto", MACHINE, "/repos/d");
    let t_fallo = tarea(&core, "t-fallo", Some(&con_fallo));
    let t_attention = tarea(&core, "t-attention", Some(&con_attention));
    let _t_activo = tarea(&core, "t-activo", Some(&activo));
    let t_quieto = tarea(&core, "t-quieto", Some(&quieto));
    falla(&core, &t_fallo);
    cierra(&core, &t_quieto);
    raise(&core, attention(AttentionCategory::Approval, &t_attention, &con_attention, Severity::Medium, 1_000));
    // Con trabajo activo y Attention a la vez gana `attention`; con un fallo gana `failed` aunque haya Attention.
    raise(&core, attention(AttentionCategory::Question, &t_fallo, &con_fallo, Severity::Medium, 2_000));

    let out = overview(&core, &person(&core), json!({}));
    assert_eq!(de(&out, &con_fallo)["status"], "failed");
    assert_eq!(de(&out, &con_attention)["status"], "attention");
    assert_eq!(de(&out, &activo)["status"], "active");
    assert_eq!(de(&out, &quieto)["status"], "idle");
}

#[test]
fn attention_y_failed_son_senales_distintas() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let id = proyecto(&core, "Senales", MACHINE, "/repos/senales");
    let task = tarea(&core, "sana", Some(&id));
    // Attention de categoría `failed` sin que ninguna task esté fallida: no se cuenta como fallo de task.
    raise(&core, attention(AttentionCategory::Failed, &task, &id, Severity::High, 1_000));
    let out = overview(&core, &person(&core), json!({}));
    let p = de(&out, &id);
    assert_eq!(p["counts"]["failed"], 0, "el contador `failed` sale de las tasks");
    assert_eq!(p["counts"]["attention"]["by_category"]["failed"], 1, "la Attention se cuenta aparte");
    assert_eq!(p["status"], "attention");
}

#[test]
fn proyecto_relocalizado_mantiene_su_identidad_y_su_trabajo() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let id = proyecto(&core, "Muda", MACHINE, "/repos/antes");
    let task = tarea(&core, "t", Some(&id));
    raise(&core, attention(AttentionCategory::Question, &task, &id, Severity::Medium, 1_000));
    let person = person(&core);
    let antes = overview(&core, &person, json!({}));

    core.storage
        .with_store(|store| {
            store.location_mark(MACHINE, "/repos/antes", true).unwrap();
            store
                .location_put(&id, &NewLocation { machine: MACHINE.into(), path: "/repos/despues".into(), display_path: "/repos/despues".into(), primary: false })
                .unwrap();
        })
        .unwrap();

    let despues = overview(&core, &person, json!({}));
    assert_eq!(ids(&despues), ids(&antes), "la identidad es el project_id, no la ruta");
    let (a, d) = (de(&antes, &id), de(&despues, &id));
    assert_eq!(a["counts"], d["counts"], "los contadores no dependen de la ruta");
    let paths: Vec<_> = d["locations"].as_array().unwrap().iter().map(|l| l["path"].as_str().unwrap()).collect();
    assert!(paths.contains(&"/repos/antes") && paths.contains(&"/repos/despues"));
    let vieja = d["locations"].as_array().unwrap().iter().find(|l| l["path"] == "/repos/antes").unwrap();
    assert_eq!(vieja["state"], "missing");
}

#[test]
fn archivados_solo_salen_de_la_vista_por_defecto_y_conservan_su_historia() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let vivo = proyecto(&core, "Vivo", MACHINE, "/repos/vivo");
    let viejo = proyecto(&core, "Viejo", MACHINE, "/repos/viejo");
    let t_viejo = tarea(&core, "del-viejo", Some(&viejo));
    raise(&core, attention(AttentionCategory::Question, &t_viejo, &viejo, Severity::Medium, 1_000));
    archiva(&core, &viejo);
    let person = person(&core);

    assert_eq!(ids(&overview(&core, &person, json!({}))), [vivo.clone()], "por defecto no sale");
    assert_eq!(ids(&overview(&core, &person, json!({ "archived": "exclude" }))), [vivo.clone()]);
    let todos = overview(&core, &person, json!({ "archived": "include" }));
    assert_eq!(ids(&todos), [viejo.clone(), vivo.clone()], "orden por nombre: Viejo, Vivo");
    let p = de(&todos, &viejo);
    assert_eq!(p["state"], "archived");
    assert_eq!(p["counts"]["tasks"], 1, "archivar no borra sus tasks");
    assert_eq!(p["counts"]["attention"]["by_category"]["question"], 1, "ni su Attention");
    let solo = overview(&core, &person, json!({ "archived": "only" }));
    assert_eq!(ids(&solo), [viejo]);
    assert_eq!(solo["filters"]["archived"], "only");
}

#[test]
fn el_filtro_machine_deja_solo_proyectos_con_ubicacion_en_ese_host() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let aqui = proyecto(&core, "Aqui", MACHINE, "/repos/aqui");
    let _alla = proyecto(&core, "Alla", "machine-b", "/repos/alla");
    let ambos = proyecto(&core, "Ambos", "machine-b", "/repos/ambos-b");
    core.storage
        .with_store(|store| {
            store
                .location_put(&ambos, &NewLocation { machine: MACHINE.into(), path: "/repos/ambos-a".into(), display_path: "/repos/ambos-a".into(), primary: true })
                .unwrap();
        })
        .unwrap();
    let person = person(&core);
    let out = overview(&core, &person, json!({ "machine": MACHINE }));
    assert_eq!(ids(&out), [ambos.clone(), aqui], "orden por nombre: Ambos, Aqui");
    assert_eq!(out["filters"]["machine"], MACHINE);
    assert_eq!(de(&out, &ambos)["locations"].as_array().unwrap().len(), 2, "el filtro elige proyectos, no recorta su metadato");
    assert_eq!(overview(&core, &person, json!({ "machine": "machine-z" }))["total"], 0);
}

#[test]
fn lo_sin_proyecto_va_a_un_cubo_aparte_y_no_inventa_un_proyecto() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let id = proyecto(&core, "P", MACHINE, "/repos/p");
    let suelta = tarea(&core, "suelta", None);
    let rota = tarea(&core, "suelta-rota", None);
    falla(&core, &rota);
    let con_proyecto = tarea(&core, "con", Some(&id));
    let mut huerfana = attention(AttentionCategory::Question, &suelta, "", Severity::Medium, 1_000);
    huerfana.project_id = None;
    raise(&core, huerfana);
    raise(&core, attention(AttentionCategory::Question, &con_proyecto, &id, Severity::Medium, 2_000));

    let out = overview(&core, &person(&core), json!({}));
    assert_eq!(out["total"], 1, "solo hay un proyecto real");
    assert_eq!(de(&out, &id)["counts"]["tasks"], 1);
    assert_eq!(out["unassigned"]["tasks"], 2);
    assert_eq!(out["unassigned"]["active"], 1);
    assert_eq!(out["unassigned"]["failed"], 1);
    assert_eq!(out["unassigned"]["attention"]["total"], 2, "la pregunta suelta y la `failed` que levantó la task rota");
    assert_eq!(out["unassigned"]["attention"]["by_category"]["question"], 1);
    assert_eq!(out["unassigned"]["attention"]["by_category"]["failed"], 1);
}

#[test]
fn los_contadores_coinciden_con_las_consultas_de_detalle() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let a = proyecto(&core, "A", MACHINE, "/repos/a");
    let b = proyecto(&core, "B", MACHINE, "/repos/b");
    let t1 = tarea(&core, "t1", Some(&a));
    let t2 = tarea(&core, "t2", Some(&a));
    let t3 = tarea(&core, "t3", Some(&a));
    let t4 = tarea(&core, "t4", Some(&b));
    falla(&core, &t2);
    cierra(&core, &t3);
    raise(&core, attention(AttentionCategory::Question, &t1, &a, Severity::Medium, 1_000));
    raise(&core, attention(AttentionCategory::Approval, &t1, &a, Severity::Medium, 2_000));
    raise(&core, attention(AttentionCategory::ReviewReady, &t4, &b, Severity::Medium, 3_000));
    let person = person(&core);
    let out = overview(&core, &person, json!({}));

    let snapshot = core.snapshot();
    let tasks = snapshot["tasks"].as_object().unwrap();
    for project in [&a, &b] {
        let p = de(&out, project);
        let suyas: Vec<&Value> = tasks.values().filter(|t| t["project_id"] == project.as_str()).collect();
        let activas = suyas.iter().filter(|t| !matches!(t["status"].as_str(), Some("done" | "failed" | "stopped" | "exited"))).count();
        let falladas = suyas.iter().filter(|t| t["status"] == "failed").count();
        assert_eq!(p["counts"]["tasks"], suyas.len(), "tasks de {project}");
        assert_eq!(p["counts"]["active"], activas, "activas de {project}");
        assert_eq!(p["counts"]["failed"], falladas, "fallidas de {project}");

        let lista = rpc(&core, &person, "attention_list", json!({ "project_id": project })).unwrap();
        let items = lista["items"].as_array().unwrap();
        assert_eq!(p["counts"]["attention"]["total"], items.len(), "attention_list de {project}");
        for (category, n) in p["counts"]["attention"]["by_category"].as_object().unwrap() {
            let en_lista = items.iter().filter(|i| i["category"] == category.as_str()).count();
            assert_eq!(n, en_lista, "categoría {category} de {project}");
        }
    }
}

#[test]
fn resolver_una_attention_baja_el_contador() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let id = proyecto(&core, "R", MACHINE, "/repos/r");
    let task = tarea(&core, "t", Some(&id));
    let fila = raise(&core, attention(AttentionCategory::Question, &task, &id, Severity::Medium, 1_000));
    let person = person(&core);
    assert_eq!(de(&overview(&core, &person, json!({})), &id)["counts"]["attention"]["total"], 1);
    core.storage
        .with_store(|store| store.attention_resolve(&fila.id, crate::store::Resolution::Acted, 2_000).unwrap())
        .unwrap();
    let p = overview(&core, &person, json!({}));
    assert_eq!(de(&p, &id)["counts"]["attention"]["total"], 0, "solo cuenta la Attention activa");
    assert_eq!(de(&p, &id)["status"], "active");
}

#[test]
fn solo_una_person_autenticada_puede_leerlo() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let task = tarea(&core, "t", None);
    let agent = agente(&core, &task, "install-agent-overview", "agent-overview-secret-0123456789abcdef");
    let error = rpc(&core, &agent, "projects_overview", json!({})).expect_err("un Agent no lee el overview multiproyecto");
    assert!(error.contains("projects_overview_auth_required"), "{error}");
    assert!(overview(&core, &person(&core), json!({}))["v"] == 1);

    // Desktop/Tauri entra como Person por el canal de la interfaz.
    let desde_ui = core.rpc_via(Channel::Ui, Caller::User, "", "projects_overview", &json!({})).expect("Person de Desktop");
    assert_eq!(desde_ui["v"], 1);
}

#[test]
fn parametros_desconocidos_o_invalidos_se_rechazan() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let person = person(&core);
    for args in [
        json!({ "limit": 5 }),
        json!({ "cursor": "x" }),
        json!({ "archived": "todos" }),
        json!({ "archived": true }),
        json!({ "machine": "" }),
        json!({ "machine": 7 }),
        json!("texto"),
    ] {
        let error = rpc(&core, &person, "projects_overview", args.clone()).expect_err(&format!("{args} debe rechazarse"));
        assert!(error.starts_with("projects_overview_invalid_request"), "{args}: {error}");
    }
}

#[test]
fn es_de_solo_lectura_no_comprueba_el_disco_y_es_reproducible() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    // La ruta no existe en el disco: `projects` la marcaría `missing`; el overview solo lee lo guardado.
    let id = proyecto(&core, "Fantasma", MACHINE, "/no/existe/en/este/equipo");
    let _ = tarea(&core, "t", Some(&id));
    let person = person(&core);
    let primera = overview(&core, &person, json!({}));
    let segunda = overview(&core, &person, json!({}));
    assert_eq!(primera, segunda);
    assert_eq!(de(&primera, &id)["locations"][0]["state"], "ok", "no tocó el disco ni escribió marcas");
    let guardada = core.storage.read_store(|s| s.project_locations(Some(&id)).unwrap()).unwrap();
    assert!(!guardada[0].missing, "la base sigue como estaba");
}
