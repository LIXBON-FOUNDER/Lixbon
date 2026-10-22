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
    rpc(core, person, "projects_overview", args)
        .expect("projects_overview responde a una Person autenticada")
}

fn person(core: &Core) -> crate::store::AuthenticatedClient {
    persona(
        core,
        "person-overview",
        "install-person-overview",
        "person-overview-secret-0123456789abcdef",
    )
}

/// Registra un proyecto sin evento (fixture) con una ubicación principal en `machine`.
fn proyecto(core: &Core, name: &str, machine: &str, path: &str) -> String {
    core.storage
        .with_store(|store| {
            store
                .project_create(
                    name,
                    &Fingerprint::default(),
                    &NewLocation {
                        machine: machine.into(),
                        path: path.into(),
                        display_path: path.into(),
                        primary: true,
                    },
                )
                .unwrap()
                .id
        })
        .unwrap()
}

fn archiva(core: &Core, project: &str) {
    core.storage
        .with_store(|store| assert!(store.project_set_archived(project, true).unwrap()))
        .unwrap();
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
    core.mutate(|tx| {
        tx.fail_with(task, "agent_idle_timeout", "sin actividad")
            .map(|_| ())
    })
    .unwrap();
}

fn cierra(core: &Core, task: &str) {
    core.mutate(|tx| tx.close(task, Status::Done, "hecho").map(|_| ()))
        .unwrap();
}

fn de<'a>(out: &'a Value, id: &str) -> &'a Value {
    out["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .unwrap_or_else(|| panic!("el proyecto {id} no está en el overview"))
}

fn ids(out: &Value) -> Vec<String> {
    out["projects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn cero_proyectos_devuelve_un_overview_vacio_de_forma_estable() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let out = overview(&core, &person(&core), json!({}));
    assert_eq!(out["v"], 1);
    assert_eq!(out["total"], 0);
    assert_eq!(out["projects"], json!([]));
    assert_eq!(
        out["filters"],
        json!({ "archived": "exclude", "machine": null })
    );
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
    assert_eq!(
        names,
        [
            "approval",
            "conflict",
            "environment_blocked",
            "failed",
            "question",
            "review_ready",
            "risk"
        ]
    );
    assert!(
        categories.values().all(|n| n == 0),
        "sin Attention, las siete categorías valen 0"
    );
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
    assert_eq!(
        ids(&out),
        esperado,
        "nombre en minúsculas y, a igualdad, project_id"
    );
    assert_eq!(out["total"], 4);
    assert_eq!(
        overview(&core, &person, json!({})),
        out,
        "mismo Core, misma respuesta"
    );
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
    raise(
        &core,
        attention(
            AttentionCategory::Question,
            &viva_1,
            &id,
            Severity::Medium,
            1_000,
        ),
    );
    raise(
        &core,
        attention(
            AttentionCategory::ReviewReady,
            &hecha,
            &id,
            Severity::Medium,
            2_000,
        ),
    );
    raise(
        &core,
        attention(
            AttentionCategory::ReviewReady,
            &rota,
            &otro,
            Severity::Medium,
            3_000,
        ),
    );

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
    assert_eq!(
        q["counts"]["tasks"], 1,
        "las tasks y la Attention de otro proyecto no se mezclan"
    );
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
    raise(
        &core,
        attention(
            AttentionCategory::Approval,
            &t_attention,
            &con_attention,
            Severity::Medium,
            1_000,
        ),
    );
    // Con trabajo activo y Attention a la vez gana `attention`; con un fallo gana `failed` aunque haya Attention.
    raise(
        &core,
        attention(
            AttentionCategory::Question,
            &t_fallo,
            &con_fallo,
            Severity::Medium,
            2_000,
        ),
    );

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
    raise(
        &core,
        attention(AttentionCategory::Failed, &task, &id, Severity::High, 1_000),
    );
    let out = overview(&core, &person(&core), json!({}));
    let p = de(&out, &id);
    assert_eq!(
        p["counts"]["failed"], 0,
        "el contador `failed` sale de las tasks"
    );
    assert_eq!(
        p["counts"]["attention"]["by_category"]["failed"], 1,
        "la Attention se cuenta aparte"
    );
    assert_eq!(p["status"], "attention");
}

#[test]
fn proyecto_relocalizado_mantiene_su_identidad_y_su_trabajo() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let id = proyecto(&core, "Muda", MACHINE, "/repos/antes");
    let task = tarea(&core, "t", Some(&id));
    raise(
        &core,
        attention(
            AttentionCategory::Question,
            &task,
            &id,
            Severity::Medium,
            1_000,
        ),
    );
    let person = person(&core);
    let antes = overview(&core, &person, json!({}));

    core.storage
        .with_store(|store| {
            store.location_mark(MACHINE, "/repos/antes", true).unwrap();
            store
                .location_put(
                    &id,
                    &NewLocation {
                        machine: MACHINE.into(),
                        path: "/repos/despues".into(),
                        display_path: "/repos/despues".into(),
                        primary: false,
                    },
                )
                .unwrap();
        })
        .unwrap();

    let despues = overview(&core, &person, json!({}));
    assert_eq!(
        ids(&despues),
        ids(&antes),
        "la identidad es el project_id, no la ruta"
    );
    let (a, d) = (de(&antes, &id), de(&despues, &id));
    assert_eq!(
        a["counts"], d["counts"],
        "los contadores no dependen de la ruta"
    );
    let paths: Vec<_> = d["locations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["path"].as_str().unwrap())
        .collect();
    assert!(paths.contains(&"/repos/antes") && paths.contains(&"/repos/despues"));
    let vieja = d["locations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["path"] == "/repos/antes")
        .unwrap();
    assert_eq!(vieja["state"], "missing");
}

#[test]
fn archivados_solo_salen_de_la_vista_por_defecto_y_conservan_su_historia() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let vivo = proyecto(&core, "Vivo", MACHINE, "/repos/vivo");
    let viejo = proyecto(&core, "Viejo", MACHINE, "/repos/viejo");
    let t_viejo = tarea(&core, "del-viejo", Some(&viejo));
    raise(
        &core,
        attention(
            AttentionCategory::Question,
            &t_viejo,
            &viejo,
            Severity::Medium,
            1_000,
        ),
    );
    archiva(&core, &viejo);
    let person = person(&core);

    assert_eq!(
        ids(&overview(&core, &person, json!({}))),
        std::slice::from_ref(&vivo),
        "por defecto no sale"
    );
    assert_eq!(
        ids(&overview(&core, &person, json!({ "archived": "exclude" }))),
        std::slice::from_ref(&vivo)
    );
    let todos = overview(&core, &person, json!({ "archived": "include" }));
    assert_eq!(
        ids(&todos),
        [viejo.clone(), vivo.clone()],
        "orden por nombre: Viejo, Vivo"
    );
    let p = de(&todos, &viejo);
    assert_eq!(p["state"], "archived");
    assert_eq!(p["counts"]["tasks"], 1, "archivar no borra sus tasks");
    assert_eq!(
        p["counts"]["attention"]["by_category"]["question"], 1,
        "ni su Attention"
    );
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
                .location_put(
                    &ambos,
                    &NewLocation {
                        machine: MACHINE.into(),
                        path: "/repos/ambos-a".into(),
                        display_path: "/repos/ambos-a".into(),
                        primary: true,
                    },
                )
                .unwrap();
        })
        .unwrap();
    let person = person(&core);
    let out = overview(&core, &person, json!({ "machine": MACHINE }));
    assert_eq!(
        ids(&out),
        [ambos.clone(), aqui],
        "orden por nombre: Ambos, Aqui"
    );
    assert_eq!(out["filters"]["machine"], MACHINE);
    assert_eq!(
        de(&out, &ambos)["locations"].as_array().unwrap().len(),
        2,
        "el filtro elige proyectos, no recorta su metadato"
    );
    assert_eq!(
        overview(&core, &person, json!({ "machine": "machine-z" }))["total"],
        0
    );
}

#[test]
fn lo_sin_proyecto_va_a_un_cubo_aparte_y_no_inventa_un_proyecto() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let id = proyecto(&core, "P", MACHINE, "/repos/p");
    let suelta = tarea(&core, "suelta", None);
    let rota = tarea(&core, "suelta-rota", None);
    falla(&core, &rota);
    let con_proyecto = tarea(&core, "con", Some(&id));
    let mut huerfana = attention(
        AttentionCategory::Question,
        &suelta,
        "",
        Severity::Medium,
        1_000,
    );
    huerfana.project_id = None;
    raise(&core, huerfana);
    raise(
        &core,
        attention(
            AttentionCategory::Question,
            &con_proyecto,
            &id,
            Severity::Medium,
            2_000,
        ),
    );

    let out = overview(&core, &person(&core), json!({}));
    assert_eq!(out["total"], 1, "solo hay un proyecto real");
    assert_eq!(de(&out, &id)["counts"]["tasks"], 1);
    assert_eq!(out["unassigned"]["tasks"], 2);
    assert_eq!(out["unassigned"]["active"], 1);
    assert_eq!(out["unassigned"]["failed"], 1);
    assert_eq!(
        out["unassigned"]["attention"]["total"], 2,
        "la pregunta suelta y la `failed` que levantó la task rota"
    );
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
    raise(
        &core,
        attention(
            AttentionCategory::Question,
            &t1,
            &a,
            Severity::Medium,
            1_000,
        ),
    );
    raise(
        &core,
        attention(
            AttentionCategory::Approval,
            &t1,
            &a,
            Severity::Medium,
            2_000,
        ),
    );
    raise(
        &core,
        attention(
            AttentionCategory::ReviewReady,
            &t4,
            &b,
            Severity::Medium,
            3_000,
        ),
    );
    let person = person(&core);
    let out = overview(&core, &person, json!({}));

    let snapshot = core.snapshot();
    let tasks = snapshot["tasks"].as_object().unwrap();
    for project in [&a, &b] {
        let p = de(&out, project);
        let suyas: Vec<&Value> = tasks
            .values()
            .filter(|t| t["project_id"] == project.as_str())
            .collect();
        let activas = suyas
            .iter()
            .filter(|t| {
                !matches!(
                    t["status"].as_str(),
                    Some("done" | "failed" | "stopped" | "exited")
                )
            })
            .count();
        let falladas = suyas.iter().filter(|t| t["status"] == "failed").count();
        assert_eq!(p["counts"]["tasks"], suyas.len(), "tasks de {project}");
        assert_eq!(p["counts"]["active"], activas, "activas de {project}");
        assert_eq!(p["counts"]["failed"], falladas, "fallidas de {project}");

        let lista = rpc(
            &core,
            &person,
            "attention_list",
            json!({ "project_id": project }),
        )
        .unwrap();
        let items = lista["items"].as_array().unwrap();
        assert_eq!(
            p["counts"]["attention"]["total"],
            items.len(),
            "attention_list de {project}"
        );
        for (category, n) in p["counts"]["attention"]["by_category"].as_object().unwrap() {
            let en_lista = items
                .iter()
                .filter(|i| i["category"] == category.as_str())
                .count();
            assert_eq!(n, en_lista, "categoría {category} de {project}");
        }
    }
}

#[test]
fn resolver_una_attention_baja_el_contador() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let id = proyecto(&core, "R", MACHINE, "/repos/r");
    let task = tarea(&core, "t", Some(&id));
    let fila = raise(
        &core,
        attention(
            AttentionCategory::Question,
            &task,
            &id,
            Severity::Medium,
            1_000,
        ),
    );
    let person = person(&core);
    assert_eq!(
        de(&overview(&core, &person, json!({})), &id)["counts"]["attention"]["total"],
        1
    );
    core.storage
        .with_store(|store| {
            store
                .attention_resolve(&fila.id, crate::store::Resolution::Acted, 2_000)
                .unwrap()
        })
        .unwrap();
    let p = overview(&core, &person, json!({}));
    assert_eq!(
        de(&p, &id)["counts"]["attention"]["total"],
        0,
        "solo cuenta la Attention activa"
    );
    assert_eq!(de(&p, &id)["status"], "active");
}

#[test]
fn solo_una_person_autenticada_puede_leerlo() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let task = tarea(&core, "t", None);
    let agent = agente(
        &core,
        &task,
        "install-agent-overview",
        "agent-overview-secret-0123456789abcdef",
    );
    let error = rpc(&core, &agent, "projects_overview", json!({}))
        .expect_err("un Agent no lee el overview multiproyecto");
    assert!(error.contains("projects_overview_auth_required"), "{error}");
    assert!(overview(&core, &person(&core), json!({}))["v"] == 1);

    // Desktop/Tauri entra como Person por el canal de la interfaz.
    let desde_ui = core
        .rpc_via(
            Channel::Ui,
            Caller::User,
            "",
            "projects_overview",
            &json!({}),
        )
        .expect("Person de Desktop");
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
        let error = rpc(&core, &person, "projects_overview", args.clone())
            .expect_err(&format!("{args} debe rechazarse"));
        assert!(
            error.starts_with("projects_overview_invalid_request"),
            "{args}: {error}"
        );
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
    assert_eq!(
        de(&primera, &id)["locations"][0]["state"],
        "ok",
        "no tocó el disco ni escribió marcas"
    );
    let guardada = core
        .storage
        .read_store(|s| s.project_locations(Some(&id)).unwrap())
        .unwrap();
    assert!(!guardada[0].missing, "la base sigue como estaba");
}

/// Core con su servidor HTTP arrancado como lo arranca Lixbon: la credencial CLI Person va al almacén
/// seguro REAL del sistema (con un `installation_id` aleatorio) y `orch.json` a un home temporal. Al
/// soltarse para el servidor y borra su entrada del almacén. Requiere `LXO_BIN`.
pub(super) struct RealStoreServer {
    core: Arc<Core>,
    pub(super) discovery: std::path::PathBuf,
    home: std::path::PathBuf,
    binary: std::path::PathBuf,
    key: Option<crate::secure_store::SecretKey>,
}

impl RealStoreServer {
    pub(super) fn start(core: &Arc<Core>, data: &std::path::Path, root: &std::path::Path) -> Self {
        use crate::secure_store::{OsStore, SecretKey};
        let binary = std::path::PathBuf::from(std::env::var_os("LXO_BIN").expect("define LXO_BIN con el binario lxo"));
        assert!(binary.is_file(), "LXO_BIN no apunta a un archivo: {}", binary.display());
        let home = root.join("lxo-home");
        let discovery = home.join(".lixbon").join("orch.json");
        std::fs::create_dir_all(discovery.parent().unwrap()).unwrap();
        let mut server = Self { core: core.clone(), discovery, home, binary, key: None };
        core.start_server_with(&OsStore::new(), &data.join("cli-client.json"), &server.discovery).unwrap();
        let published: Value = serde_json::from_slice(&std::fs::read(&server.discovery).unwrap()).unwrap();
        let installation = published["installation_id"].as_str().unwrap();
        server.key = Some(SecretKey::lixbon(&format!("client/cli/{installation}")).unwrap());
        assert!(published.get("token").is_none(), "orch.json no publica secretos");
        server
    }

    /// `lxo` como persona; con `agent`, con la credencial de esa tarea.
    pub(super) fn lxo(&self, args: &[&str], agent: Option<(&str, &str)>) -> std::process::Output {
        let mut command = std::process::Command::new(&self.binary);
        command.args(args).env("USERPROFILE", &self.home).env("HOME", &self.home)
            .env_remove("LXO_TASK_ID").env_remove("LXO_CLIENT_TOKEN");
        if let Some((task, token)) = agent {
            command.env("LXO_TASK_ID", task).env("LXO_CLIENT_TOKEN", token);
        }
        command.output().unwrap()
    }

    /// Salida JSON de un `lxo` que debe terminar bien.
    pub(super) fn json(&self, args: &[&str]) -> Value {
        let out = self.lxo(args, None);
        assert!(out.status.success(), "lxo {args:?}: {:?} stderr={}", out.status.code(), String::from_utf8_lossy(&out.stderr));
        serde_json::from_slice(&out.stdout).unwrap()
    }
}

impl Drop for RealStoreServer {
    fn drop(&mut self) {
        use crate::secure_store::{OsStore, SecretStore};
        self.core.stop_server_with(&self.discovery);
        if let Some(key) = &self.key {
            let _ = OsStore::new().delete(key);
        }
    }
}

/// LXO-103 · `lxo projects` real contra el HTTP del Core, como persona: el Core aprovisiona la credencial CLI
/// en el almacén seguro REAL del sistema (como al abrir Lixbon) y `lxo` la lee de ahí. Usa un home temporal y
/// borra su entrada del almacén al terminar.
#[test]
#[ignore = "requiere un binario lxo real (LXO_BIN) y el almacén seguro del sistema; ver apps/desktop/README.md"]
fn lxo_bin_e2e_projects_person_real_store() {
    use std::process::Output;

    let (cleanup, data, _core_dir, core) = core_listo();
    let server = RealStoreServer::start(&core, &data, &cleanup.0);
    let discovery = server.discovery.clone();
    let lxo = |args: &[&str], agent: Option<(&str, &str)>| server.lxo(args, agent);
    let text = |out: &Output| String::from_utf8_lossy(&out.stdout).into_owned();
    let json_of = |args: &[&str]| server.json(args);

    // Vacío.
    let empty = json_of(&["projects", "--json"]);
    assert_eq!((empty["total"].clone(), empty["projects"].clone()), (json!(0), json!([])), "{empty}");
    assert!(text(&lxo(&["projects"], None)).starts_with("Sin proyectos registrados."));

    // N proyectos: uno con trabajo activo, un fallo y su Attention; uno archivado; una tarea sin proyecto.
    let api = proyecto(&core, "api", MACHINE, "C:/r/api");
    let docs = proyecto(&core, "docs", MACHINE, "C:/r/docs");
    let viva = tarea(&core, "en marcha", Some(&api));
    let rota = tarea(&core, "rota", Some(&api));
    falla(&core, &rota);
    archiva(&core, &docs);
    tarea(&core, "suelta", None);

    let lxo_view = json_of(&["projects", "--json"]);
    assert_eq!(lxo_view, overview(&core, &person(&core), json!({})), "lxo enseña el overview del Core sin tocarlo");
    assert_eq!(lxo_view["projects"][0]["id"], api);
    assert_eq!(lxo_view["projects"][0]["status"], "failed");
    assert_eq!(lxo_view["projects"][0]["counts"]["attention"]["by_category"]["failed"], 1);
    assert_eq!(lxo_view["unassigned"]["tasks"], 1);
    let human = text(&lxo(&["projects"], None));
    assert!(human.contains("api · con fallos") && human.contains(&format!("id {api}")) && human.contains("Sin proyecto: 1 tarea"), "{human}");
    assert!(!human.contains("docs"), "los archivados no salen por defecto: {human}");

    let only = json_of(&["projects", "--archived", "only", "--json"]);
    assert_eq!(only["projects"].as_array().unwrap().iter().map(|p| p["id"].clone()).collect::<Vec<_>>(), vec![json!(docs)]);
    assert_eq!(json_of(&["projects", "--all", "--json"])["total"], 2);
    assert!(text(&lxo(&["projects", "--machine", "otra-maquina"], None)).contains("Ningún proyecto tiene ubicaciones en la máquina otra-maquina."));

    // Códigos de salida: filtro que rechaza el Core, agente (solo personas) y Core caído.
    assert_eq!(lxo(&["projects", "--archived", "nada"], None).status.code(), Some(2));
    let agent_token = "agent-lxo-projects-e2e-token-with-32-bytes-minimum";
    let registration = crate::store::ClientRegistration::new(
        crate::store::ClientSurface::Cli,
        crate::store::DeviceIdentity::new("install-agent-lxo-projects-e2e", None).unwrap(),
    )
    .unwrap();
    let credential = crate::store::ClientCredential::new(crate::store::ClientPrincipal::Agent(viva.clone()), agent_token).unwrap();
    core.storage
        .with_store(|store| store.register_client(&registration, &credential, super::state::now_ms() as i64).unwrap())
        .unwrap();
    let as_agent = lxo(&["projects"], Some((&viva, agent_token)));
    assert_eq!(as_agent.status.code(), Some(3), "stderr={}", String::from_utf8_lossy(&as_agent.stderr));
    let agent_error = String::from_utf8_lossy(&as_agent.stderr).into_owned();
    assert!(agent_error.contains("solo para personas"), "{agent_error}");
    core.stop_server_with(&discovery);
    assert_eq!(lxo(&["projects"], None).status.code(), Some(5), "Lixbon cerrado");
}

/// LXO-104 · `lxo tasks` y `lxo task show` reales como persona contra el HTTP del Core: árbol raíz →
/// hija con worktree (que falla) y hija en checkout compartido, más una raíz sin proyecto.
#[test]
#[ignore = "requiere un binario lxo real (LXO_BIN) y el almacén seguro del sistema; ver apps/desktop/README.md"]
fn lxo_bin_e2e_tasks_person_real_store() {
    let (cleanup, data, _core_dir, core) = core_listo();
    let server = RealStoreServer::start(&core, &data, &cleanup.0);
    let ids = |doc: &Value| -> Vec<String> {
        doc["tasks"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_string()).collect()
    };

    let empty = server.json(&["tasks", "--json"]);
    assert_eq!((empty["task_model"].clone(), empty["tasks"].clone()), (json!("legacy"), json!([])), "{empty}");
    assert!(String::from_utf8_lossy(&server.lxo(&["tasks"], None).stdout).starts_with("Sin tareas."));

    let api = proyecto(&core, "api", MACHINE, "C:/r/api");
    let root = tarea(&core, "raíz", Some(&api));
    let child = |title: &str, worktree: Option<&str>| {
        core.mutate(|tx| {
            let id = tx.add_child(&root, 2, NewTask {
                agent: "codex".into(), model: Some("gpt-5".into()), effort: None, role: Some("implementador".into()),
                title: title.into(), spec: "encargo privado".into(), repo: "repo".into(), cwd: "C:/r/api".into(),
                branch: worktree.map(|_| format!("lxo/{title}")), base: worktree.map(|_| "main".into()),
                worktree: worktree.map(String::from), external: false,
            })?;
            tx.mark_running(&id)?;
            if let Some(t) = tx.tasks.get_mut(&id) {
                t.project_id = Some(api.clone());
            }
            Ok(id)
        })
        .unwrap()
    };
    let wt = child("con-worktree", Some("C:/r/api-wt/1"));
    let shared = child("compartida", None);
    falla(&core, &wt);
    let loose = tarea(&core, "suelta", None);

    let all = server.json(&["tasks", "--json"]);
    assert_eq!(ids(&all), [root.clone(), wt.clone(), shared.clone(), loose.clone()], "árbol: raíz, hijas y la otra raíz");
    assert!(!all.to_string().contains("encargo privado"), "el JSON no copia el encargo");
    assert_eq!(ids(&server.json(&["tasks", "--project", "api", "--json"])), [root.clone(), wt.clone(), shared.clone()]);
    assert_eq!(ids(&server.json(&["tasks", "--project", "api", "--active", "--json"])), [root.clone(), shared.clone()]);
    assert_eq!(ids(&server.json(&["tasks", "--final", "--json"])), [wt.clone()]);
    assert_eq!(ids(&server.json(&["tasks", "--status", "failed", "--json"])), [wt.clone()]);

    let detail = server.json(&["task", "show", &wt, "--json"]);
    let task = &detail["task"];
    assert_eq!((task["root_id"].as_str(), task["parent_id"].as_str(), task["project_id"].as_str()), (Some(root.as_str()), Some(root.as_str()), Some(api.as_str())));
    assert_eq!((task["worktree"].as_str(), task["branch"].as_str(), task["shared_checkout"].as_bool()), (Some("C:/r/api-wt/1"), Some("lxo/con-worktree"), Some(false)));
    assert_eq!((task["status"].as_str(), task["final"].as_bool(), task["provider"].as_str()), (Some("failed"), Some(true), Some("codex")));
    assert_eq!(task["host"], Value::Null, "lo que el modelo legacy no registra queda null");
    assert_eq!(server.json(&["task", "show", &shared, "--json"])["task"]["shared_checkout"], true);
    assert_eq!(server.json(&["task", "show", &root, "--json"])["children"], json!([wt, shared]));

    let human = String::from_utf8_lossy(&server.lxo(&["task", "show", &wt], None).stdout).into_owned();
    assert!(human.contains("fallida") && human.contains(&format!("lxo events --task {wt}")), "{human}");
    let missing = server.lxo(&["task", "show", "no-existe", "--json"], None);
    assert_eq!(missing.status.code(), Some(6));
    let error: Value = serde_json::from_slice(&missing.stderr).unwrap();
    assert_eq!((error["code"].as_str(), error["ok"].as_bool()), (Some("not_found"), Some(false)), "{error}");
    assert_eq!(server.lxo(&["tasks", "--project", "no-existe"], None).status.code(), Some(6));
    core.stop_server_with(&server.discovery);
    assert_eq!(server.lxo(&["tasks"], None).status.code(), Some(5), "Lixbon cerrado");
}

/// LXO-106 · `lxo summary` con el binario real como persona y el almacén seguro real: vacío, con trabajo y
/// Attention, sin contenido en la salida, y Lixbon cerrado (5) rápido para que el arranque del CLI no espere.
#[test]
#[ignore = "requiere un binario lxo real (LXO_BIN) y el almacén seguro del sistema; ver apps/desktop/README.md"]
fn lxo_bin_e2e_summary_person_real_store() {
    let (cleanup, data, _core_dir, core) = core_listo();
    let server = RealStoreServer::start(&core, &data, &cleanup.0);

    let empty = server.json(&["summary", "--json"]);
    assert_eq!(empty["v"], 1, "{empty}");
    assert_eq!((empty["active_tasks"].clone(), empty["attention"]["total"].clone()), (json!(0), json!(0)), "{empty}");
    let text = String::from_utf8_lossy(&server.lxo(&["summary"], None).stdout).into_owned();
    assert!(text.starts_with("Lixbon · sin proyectos con trabajo · 0 tareas activas · nada pide atención"), "{text}");

    let api = proyecto(&core, "SENTINEL-PROYECTO", MACHINE, "C:/r/SENTINEL-RUTA");
    let t = tarea(&core, "SENTINEL-TITULO", Some(&api));
    raise(&core, attention(AttentionCategory::Question, &t, &api, Severity::High, 10));
    let full = server.json(&["summary", "--json"]);
    assert_eq!(full["active_tasks"], 1, "{full}");
    assert_eq!(full["projects"]["with_work"], 1, "{full}");
    assert_eq!(full["attention"]["by_category"]["question"], 1, "{full}");
    assert_eq!(full["cursor"], json!(core.storage.with_store(|s| s.events_head().unwrap()).unwrap()));
    let human = server.lxo(&["summary"], None);
    let text = String::from_utf8_lossy(&human.stdout).into_owned();
    assert!(text.contains("1 tarea activa · 1 pide atención (1 pregunta)") && text.contains("lxo attention"), "{text}");
    for out in [full.to_string(), text] {
        assert!(!out.contains("SENTINEL") && !out.contains(&t) && !out.contains(&api), "el resumen solo cuenta: {out}");
    }

    core.stop_server_with(&server.discovery);
    let started = std::time::Instant::now();
    let closed = server.lxo(&["summary", "--json"], None);
    assert_eq!(closed.status.code(), Some(5), "Lixbon cerrado");
    assert!(started.elapsed() < std::time::Duration::from_millis(1500), "cerrado se sabe enseguida: {:?}", started.elapsed());
}
