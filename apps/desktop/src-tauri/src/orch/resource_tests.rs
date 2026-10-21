//! LXO-93 · inventario de recursos (`resource_inventory`) con repositorios git REALES: clean, dirty, merged, unmerged,
//! missing, external y huérfano; solo lectura; un fallo de git no es `missing` ni dispara limpieza.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use serde_json::{json, Value};

use super::attention_read_tests::{agente, core_listo, persona, rpc};
use super::events::Channel;
use super::projects::norm_path;
use super::state::{NewTask, Status};
use super::{git as lgit, Caller, Core};
use crate::store::{Fingerprint, NewLocation};

const MACHINE: &str = "machine-test";

fn plain(p: &Path) -> String {
    p.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args([
            "-c",
            "user.name=lixbon-test",
            "-c",
            "user.email=test@lixbon.test",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.autocrlf=false",
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
        ])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git está instalado");
    assert!(
        out.status.success(),
        "git {args:?} en {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn commit(dir: &Path, file: &str, text: &str) {
    std::fs::write(dir.join(file), text).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", file]);
}

/// Un repositorio con un commit en `main`.
fn repo_nuevo(base: &Path, name: &str) -> PathBuf {
    let dir = base.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q"]);
    git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    commit(&dir, "README.md", "hola");
    dir
}

/// `<repo>.lixbon-wt/<name>` con una rama nueva desde `main`, como lo crea Lixbon.
fn worktree(repo: &Path, name: &str, branch: &str) -> PathBuf {
    let dir = lgit::worktree_dir(&plain(repo), None, name);
    git(
        repo,
        &["worktree", "add", "-q", "-b", branch, &plain(&dir), "main"],
    );
    dir
}

struct Escena {
    core: Arc<Core>,
    person: crate::store::AuthenticatedClient,
    base: PathBuf,
    repo: PathBuf,
    project: String,
    _limpia: super::boot_tests::Limpia,
}

fn escena() -> Escena {
    let (limpia, _data, _core_dir, core) = core_listo();
    let base = std::fs::canonicalize(&limpia.0).unwrap();
    let base = PathBuf::from(plain(&base)).join("repos");
    std::fs::create_dir_all(&base).unwrap();
    let repo = repo_nuevo(&base, "app");
    let shown = plain(&repo);
    let project = core
        .storage
        .with_store(|store| {
            store.meta_set("machine_id", MACHINE).unwrap();
            store
                .project_create(
                    "app",
                    &Fingerprint::default(),
                    &NewLocation {
                        machine: MACHINE.into(),
                        path: norm_path(&shown),
                        display_path: shown.clone(),
                        primary: true,
                    },
                )
                .unwrap()
                .id
        })
        .unwrap();
    let person = persona(
        &core,
        "person-resources",
        "install-person-resources",
        "person-resources-secret-0123456789abcdef",
    );
    Escena {
        core,
        person,
        base,
        repo,
        project,
        _limpia: limpia,
    }
}

struct Datos<'a> {
    titulo: &'a str,
    repo: String,
    project: Option<String>,
    worktree: Option<String>,
    branch: Option<String>,
    base: Option<String>,
    merged: bool,
    status: Status,
}

/// Una Task con exactamente los recursos que se le indican (el Core los daría por buenos).
fn tarea(core: &Core, d: Datos<'_>) -> String {
    core.mutate(|tx| {
        let (_run, root) = tx.create_run(
            "objetivo",
            NewTask {
                agent: "claude".into(),
                model: None,
                effort: None,
                role: None,
                title: d.titulo.into(),
                spec: "spec".into(),
                repo: d.repo.clone(),
                cwd: d.repo.clone(),
                branch: None,
                base: None,
                worktree: None,
                external: false,
            },
        );
        tx.mark_running(&root)?;
        if d.status != Status::Running {
            tx.close(&root, d.status, "fin")?;
        }
        let t = tx.tasks.get_mut(&root).unwrap();
        t.project_id = d.project.clone();
        t.worktree = d.worktree.clone();
        t.branch = d.branch.clone();
        t.base = d.base.clone();
        t.merged = d.merged;
        Ok(root)
    })
    .unwrap()
}

fn datos<'a>(
    e: &Escena,
    titulo: &'a str,
    worktree: Option<&Path>,
    branch: &str,
    status: Status,
) -> Datos<'a> {
    Datos {
        titulo,
        repo: plain(&e.repo),
        project: Some(e.project.clone()),
        worktree: worktree.map(plain),
        branch: Some(branch.into()),
        base: Some("main".into()),
        merged: false,
        status,
    }
}

fn inventario(e: &Escena, args: Value) -> Value {
    rpc(&e.core, &e.person, "resource_inventory", args)
        .expect("resource_inventory responde a una Person autenticada")
}

fn entrada<'a>(out: &'a Value, nombre: &str) -> &'a Value {
    out["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| norm_path(w["target"]["path"].as_str().unwrap()).ends_with(&format!("/{nombre}")))
        .unwrap_or_else(|| panic!("no hay un worktree `{nombre}` en el inventario"))
}

/// El escenario completo: un caso por cada fila de la matriz.
struct Completo {
    escena: Escena,
    externo: PathBuf,
}

fn completo() -> Completo {
    let e = escena();
    // A · limpio y fusionado (la rama no tiene commits propios: es ancestro de `main`). Task terminada.
    let a = worktree(&e.repo, "wt-a", "lx/r/a");
    tarea(&e.core, datos(&e, "a", Some(&a), "lx/r/a", Status::Done));
    // B · sucio, sin fusionar y con la Task en marcha.
    let b = worktree(&e.repo, "wt-b", "lx/r/b");
    commit(&b, "b.txt", "b");
    std::fs::write(b.join("sin-commit.txt"), "pendiente").unwrap();
    tarea(&e.core, datos(&e, "b", Some(&b), "lx/r/b", Status::Running));
    // C · limpio, sin fusionar, Task terminada: hay que revisarlo.
    let c = worktree(&e.repo, "wt-c", "lx/r/c");
    commit(&c, "c.txt", "c");
    tarea(&e.core, datos(&e, "c", Some(&c), "lx/r/c", Status::Done));
    // D · la carpeta desapareció pero git (y la Task) todavía lo registran.
    let d = worktree(&e.repo, "wt-d", "lx/r/d");
    tarea(&e.core, datos(&e, "d", Some(&d), "lx/r/d", Status::Done));
    std::fs::remove_dir_all(&d).unwrap();
    // H · fusionado por squash: la rama no es ancestro, pero Lixbon lo marcó `merged`.
    let h = worktree(&e.repo, "wt-h", "lx/r/h");
    commit(&h, "h.txt", "h");
    tarea(
        &e.core,
        Datos {
            merged: true,
            ..datos(&e, "h", Some(&h), "lx/r/h", Status::Done)
        },
    );
    // I · la Task cree tener un worktree en una carpeta que existe pero git no registra.
    let i = lgit::worktree_dir(&plain(&e.repo), None, "suelto");
    std::fs::create_dir_all(&i).unwrap();
    tarea(&e.core, datos(&e, "i", Some(&i), "lx/r/i", Status::Done));
    // E · externo: lo creó una persona fuera de la carpeta de Lixbon. Sin Task.
    let externo = e.base.join("app-externo");
    git(
        &e.repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "ext/x",
            &plain(&externo),
            "main",
        ],
    );
    // F · huérfano: está en la carpeta de Lixbon pero ninguna Task lo reclama.
    worktree(&e.repo, "wt-huerfano", "lx/r/huerfano");
    // G · rama conservada: se liberó el worktree y la rama se quedó (tiene un commit sin fusionar).
    let g = worktree(&e.repo, "wt-g", "lx/r/g");
    commit(&g, "g.txt", "g");
    git(&e.repo, &["worktree", "remove", "--force", &plain(&g)]);
    tarea(&e.core, datos(&e, "g", None, "lx/r/g", Status::Stopped));
    // Una raíz: guarda la rama del propio checkout y NO es una rama conservada.
    tarea(
        &e.core,
        Datos {
            base: None,
            ..datos(&e, "raiz", None, "main", Status::Running)
        },
    );
    Completo { escena: e, externo }
}

#[test]
fn la_matriz_estado_fisico_estado_mostrado_con_git_real() {
    let c = completo();
    let out = inventario(&c.escena, json!({}));
    assert_eq!(out["v"], 1);
    assert_eq!(out["machine"], MACHINE);

    let a = entrada(&out, "wt-a");
    assert_eq!(
        (
            a["state"].as_str(),
            a["physical"].as_str(),
            a["dirty"].as_str(),
            a["merged"].as_str()
        ),
        (
            Some("tracked"),
            Some("present"),
            Some("clean"),
            Some("merged")
        )
    );
    assert_eq!(a["origin"], "task");
    assert_eq!(a["git"]["registered"], true);
    assert_eq!(a["git"]["branch"], "lx/r/a");
    assert_eq!(a["into"], "main");
    assert_eq!(a["needs_review"], false, "fusionada: nada que revisar");

    let b = entrada(&out, "wt-b");
    assert_eq!(
        (
            b["state"].as_str(),
            b["dirty"].as_str(),
            b["merged"].as_str()
        ),
        (Some("tracked"), Some("dirty"), Some("unmerged"))
    );
    assert_eq!(b["owner"]["status"], "running");
    assert_eq!(
        b["needs_review"], false,
        "con la Task en marcha todavía no está para revisar"
    );

    let cc = entrada(&out, "wt-c");
    assert_eq!(
        (
            cc["state"].as_str(),
            cc["dirty"].as_str(),
            cc["merged"].as_str()
        ),
        (Some("tracked"), Some("clean"), Some("unmerged"))
    );
    assert_eq!(cc["needs_review"], true);

    let d = entrada(&out, "wt-d");
    assert_eq!(
        (d["state"].as_str(), d["physical"].as_str()),
        (Some("missing_on_disk"), Some("missing"))
    );
    assert_eq!(d["git"]["registered"], true, "git todavía lo registra");
    assert_eq!(d["git"]["prunable"], true);
    assert_eq!(d["dirty"], "skipped", "no hay carpeta que mirar");

    let h = entrada(&out, "wt-h");
    assert_eq!(h["merged"], "merged", "la marca de Lixbon cubre el squash");
    assert_eq!(h["needs_review"], false);

    let i = entrada(&out, "suelto");
    assert_eq!(
        (
            i["state"].as_str(),
            i["physical"].as_str(),
            i["git"]["registered"].as_bool()
        ),
        (Some("not_registered"), Some("present"), Some(false))
    );
    assert!(i["owner"]["task_id"].is_string());

    let ext = entrada(&out, "app-externo");
    assert_eq!(
        (ext["state"].as_str(), ext["origin"].as_str()),
        (Some("external"), Some("external"))
    );
    assert_eq!(
        ext["owner"],
        Value::Null,
        "un worktree externo no recibe dueño"
    );
    assert_eq!(ext["git"]["branch"], "ext/x");
    assert_eq!(ext["needs_review"], false, "no es trabajo de Lixbon");

    let huerfano = entrada(&out, "wt-huerfano");
    assert_eq!(
        (huerfano["state"].as_str(), huerfano["origin"].as_str()),
        (Some("orphan_candidate"), Some("lixbon_dir"))
    );
    assert_eq!(huerfano["owner"], Value::Null, "detectar no es adoptar");
    assert_eq!(
        out["worktrees"].as_array().unwrap().len(),
        8,
        "6 de Tasks + 2 que nadie reclama"
    );
}

#[test]
fn la_rama_conservada_sin_fusionar_se_lista_y_no_es_un_error() {
    let c = completo();
    let out = inventario(&c.escena, json!({}));
    let ramas = out["preserved_branches"].as_array().unwrap();
    assert_eq!(
        ramas.len(),
        1,
        "solo la rama que Lixbon creó y conservó; la raíz (`main`, sin base) no cuenta"
    );
    let g = &ramas[0];
    assert_eq!(g["target"]["branch"], "lx/r/g");
    assert_eq!(g["branch_exists"], true);
    assert_eq!(g["merged"], "unmerged");
    assert_eq!(g["owner"]["status"], "stopped", "último dueño conocido");
    assert_eq!(g["needs_review"], true);
    assert!(
        g.get("error").is_none() && g.get("integrity").is_none(),
        "una rama sin fusionar conservada no es un error de integridad"
    );
}

#[test]
fn el_aviso_de_ramas_por_revisar_coincide_con_el_inventario() {
    let c = completo();
    let out = inventario(&c.escena, json!({}));
    let marcadas = out["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .chain(out["preserved_branches"].as_array().unwrap())
        .filter(|v| v["needs_review"] == true)
        .count();
    assert_eq!(out["warnings"]["branches_to_review"], marcadas);
    assert_eq!(
        marcadas, 2,
        "la rama terminada sin fusionar (c) y la conservada (g)"
    );
    // Los contadores por estado salen de las mismas entradas.
    let por_estado = out["warnings"]["worktrees_by_state"].as_object().unwrap();
    for estado in [
        "tracked",
        "missing_on_disk",
        "not_registered",
        "orphan_candidate",
        "external",
        "unknown",
    ] {
        let n = out["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|w| w["state"] == estado)
            .count();
        assert_eq!(por_estado[estado], n, "contador de {estado}");
    }
    assert_eq!(por_estado["tracked"], 4);
    assert_eq!(por_estado["missing_on_disk"], 1);
    assert_eq!(por_estado["not_registered"], 1);
    assert_eq!(por_estado["orphan_candidate"], 1);
    assert_eq!(por_estado["external"], 1);
}

/// (ruta relativa, tamaño, modificado) de todo el árbol: si una consulta añade, quita o reescribe un archivo, cambia.
fn foto(root: &Path) -> Vec<(String, u64, Option<std::time::SystemTime>)> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, u64, Option<std::time::SystemTime>)>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let meta = entry.metadata().unwrap();
            // De un directorio solo importa que exista: su fecha la mueve el sistema operativo (indexadores,
            // antivirus) sin que se añada ni se quite nada. Un archivo sí cuenta con tamaño y fecha.
            let (len, modified) = if meta.is_dir() {
                (0, None)
            } else {
                (meta.len(), meta.modified().ok())
            };
            out.push((
                path.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/"),
                len,
                modified,
            ));
            if meta.is_dir() {
                walk(&path, root, out);
            }
        }
    }
    let mut out = vec![];
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

#[test]
fn la_query_no_muta_el_repositorio_ni_los_worktrees() {
    let c = completo();
    let e = &c.escena;
    let antes = foto(&e.base);
    let refs_antes = git(&e.repo, &["for-each-ref"]);
    let wts_antes = git(&e.repo, &["worktree", "list", "--porcelain"]);
    // Varias lecturas, con y sin sondeo: ninguna escribe.
    for args in [
        json!({}),
        json!({ "probe": false }),
        json!({ "project_id": e.project }),
    ] {
        inventario(e, args);
    }
    let despues = foto(&e.base);
    let cambios: Vec<&str> = antes
        .iter()
        .filter(|a| !despues.contains(a))
        .chain(despues.iter().filter(|d| !antes.contains(d)))
        .map(|(ruta, ..)| ruta.as_str())
        .collect();
    assert!(
        cambios.is_empty(),
        "la query cambió estos archivos: {cambios:?}"
    );
    assert!(
        !e.repo.join(".git/index.lock").exists(),
        "no quedó ningún bloqueo"
    );
    assert_eq!(git(&e.repo, &["for-each-ref"]), refs_antes);
    assert_eq!(
        git(&e.repo, &["worktree", "list", "--porcelain"]),
        wts_antes,
        "git no podó el registro del worktree que falta"
    );
    assert!(c.externo.exists());
}

#[test]
fn un_fallo_de_git_es_unknown_no_missing_y_no_dispara_ninguna_limpieza() {
    let e = escena();
    // Una carpeta que existe pero no es un repositorio, con una «Task» que dice tener un worktree dentro.
    let plano = e.base.join("no-es-un-repo");
    let wt = plano.join("trabajo");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join("importante.txt"), "no se toca").unwrap();
    let id = tarea(
        &e.core,
        Datos {
            repo: plain(&plano),
            project: None,
            ..datos(&e, "x", Some(&wt), "lx/r/x", Status::Done)
        },
    );
    // Y un repo que ni siquiera existe en disco.
    let ausente = e.base.join("repo-ausente");
    let ausente_wt = ausente.join("trabajo");
    tarea(
        &e.core,
        Datos {
            repo: plain(&ausente),
            project: None,
            ..datos(&e, "y", Some(&ausente_wt), "lx/r/y", Status::Done)
        },
    );

    let tareas_antes = serde_json::to_value(&e.core.lock().tasks).unwrap();
    let head_antes = e.core.events_read(&Caller::User, &json!({})).unwrap()["head_seq"].clone();
    let out = inventario(&e, json!({}));

    let x = entrada(&out, "trabajo");
    // Hay dos entradas `trabajo`; busca por dueño.
    let _ = x;
    let por_dueno = |task: &str| {
        out["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .find(|w| w["owner"]["task_id"] == task)
            .unwrap()
            .clone()
    };
    let w = por_dueno(&id);
    assert_eq!(
        w["state"], "unknown",
        "git no pudo responder: no sabemos, y NO decimos que falta"
    );
    assert_eq!(w["physical"], "present");
    assert_eq!(w["git"]["registered"], Value::Null);
    assert_eq!(w["merged"], "unknown");
    let repos = out["repos"].as_array().unwrap();
    let repo_plano = repos
        .iter()
        .find(|r| norm_path(r["path"].as_str().unwrap()).ends_with("no-es-un-repo"))
        .unwrap();
    assert_eq!(
        (repo_plano["scan"].as_str(), repo_plano["reason"].as_str()),
        (Some("unavailable"), Some("not_a_repository"))
    );
    let repo_ausente = repos
        .iter()
        .find(|r| norm_path(r["path"].as_str().unwrap()).ends_with("repo-ausente"))
        .unwrap();
    assert_eq!(repo_ausente["reason"], "path_missing");

    // Nada se limpió ni se registró: el estado, el Event Log y los archivos siguen igual.
    assert_eq!(
        serde_json::to_value(&e.core.lock().tasks).unwrap(),
        tareas_antes,
        "el estado no cambia"
    );
    assert_eq!(
        e.core.events_read(&Caller::User, &json!({})).unwrap()["head_seq"],
        head_antes,
        "ningún evento nuevo"
    );
    assert!(wt.join("importante.txt").exists());
}

#[test]
fn probe_false_solo_mira_registro_y_disco() {
    let c = completo();
    let out = inventario(&c.escena, json!({ "probe": false }));
    assert_eq!(out["filters"]["probe"], false);
    for w in out["worktrees"].as_array().unwrap() {
        assert_eq!(
            (w["dirty"].as_str(), w["merged"].as_str()),
            (Some("skipped"), Some("skipped"))
        );
        assert_eq!(w["needs_review"], Value::Null);
    }
    assert_eq!(
        out["warnings"]["branches_to_review"],
        Value::Null,
        "sin sondeo no se puede decir cuántas hay por revisar"
    );
    assert_eq!(
        entrada(&out, "wt-d")["state"],
        "missing_on_disk",
        "el estado físico sí se calcula"
    );
    assert_eq!(entrada(&out, "app-externo")["state"], "external");
}

#[test]
fn host_y_ubicacion_son_parte_del_destino_y_otras_maquinas_no_se_escanean() {
    let c = completo();
    let e = &c.escena;
    let otra = e
        .core
        .storage
        .with_store(|store| {
            store
                .project_create(
                    "remoto",
                    &Fingerprint::default(),
                    &NewLocation {
                        machine: "otro-equipo".into(),
                        path: "/srv/remoto".into(),
                        display_path: "/srv/remoto".into(),
                        primary: true,
                    },
                )
                .unwrap()
                .id
        })
        .unwrap();
    let out = inventario(e, json!({}));
    let w = entrada(&out, "wt-a");
    assert_eq!(w["target"]["machine"], MACHINE);
    assert_eq!(w["target"]["project_id"], e.project.as_str());
    assert_eq!(
        norm_path(w["target"]["repo"].as_str().unwrap()),
        norm_path(&plain(&e.repo)),
        "el repo (ubicación) forma parte del destino"
    );
    let remoto = out["repos"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["project_id"] == otra.as_str())
        .unwrap();
    assert_eq!(
        (remoto["machine"].as_str(), remoto["scan"].as_str()),
        (Some("otro-equipo"), Some("other_machine"))
    );
    assert!(
        out["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .all(|w| w["target"]["project_id"] != otra.as_str()),
        "sin git en otro host: no hay worktrees inventados"
    );
    // El filtro por proyecto acota repos y worktrees.
    let solo = inventario(e, json!({ "project_id": otra }));
    assert!(solo["worktrees"].as_array().unwrap().is_empty());
    assert_eq!(solo["repos"].as_array().unwrap().len(), 1);
}

#[test]
fn la_respuesta_es_reproducible_y_ordenada() {
    let c = completo();
    let primera = inventario(&c.escena, json!({}));
    let segunda = inventario(&c.escena, json!({}));
    assert_eq!(primera, segunda, "sin cambios, la misma respuesta");
    let rutas: Vec<String> = primera["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| norm_path(w["target"]["path"].as_str().unwrap()))
        .collect();
    let mut ordenadas = rutas.clone();
    ordenadas.sort();
    assert_eq!(rutas, ordenadas);
}

#[test]
fn solo_una_person_autenticada_y_parametros_cerrados() {
    let e = escena();
    let task = tarea(&e.core, datos(&e, "t", None, "x", Status::Running));
    let agent = agente(
        &e.core,
        &task,
        "install-agent-resources",
        "agent-resources-secret-0123456789abcdef",
    );
    let error = rpc(&e.core, &agent, "resource_inventory", json!({}))
        .expect_err("un Agent no lee el inventario");
    assert!(
        error.contains("resource_inventory_auth_required"),
        "{error}"
    );
    let desde_ui = e
        .core
        .rpc_via(
            Channel::Ui,
            Caller::User,
            "",
            "resource_inventory",
            &json!({ "probe": false }),
        )
        .expect("Person de Desktop");
    assert_eq!(desde_ui["v"], 1);
    for args in [
        json!({ "path": "/tmp" }),
        json!({ "probe": "si" }),
        json!({ "project_id": "" }),
        json!({ "project_id": 3 }),
        json!("texto"),
    ] {
        let error = rpc(&e.core, &e.person, "resource_inventory", args.clone())
            .expect_err(&format!("{args} debe rechazarse"));
        assert!(
            error.starts_with("resource_inventory_invalid_request"),
            "{args}: {error}"
        );
    }
}
