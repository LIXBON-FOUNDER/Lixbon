//! Pruebas del registro de proyectos (slice D) con repositorios git REALES: reconocimiento,
//! worktrees, forks, clones, repositorio movido, ciclo de vida, relleno e importación.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::boot_tests::*;
use super::projects::{compatible, identify, norm_path_for};
use super::state::NewTask;
use super::store_boot::StorageStatus;
use super::{git, Caller, Core};
use crate::store::Fingerprint;

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

fn g(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?} en {}: {}", dir.display(), String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

/// Repositorio con un commit raíz y, si `remote` es `Some`, un `origin` (no hace falta que exista).
fn repo(base: &Path, name: &str, remote: Option<&str>) -> PathBuf {
    let dir = base.join("repos").join(name);
    std::fs::create_dir_all(&dir).unwrap();
    g(&dir, &["init", "-q", "-b", "main"]);
    g(&dir, &["config", "user.name", "t"]);
    g(&dir, &["config", "user.email", "t@t"]);
    g(&dir, &["config", "core.autocrlf", "false"]);
    // Contenido propio de cada repo: dos repos creados en el mismo segundo con el mismo texto tendrían
    // el MISMO commit raíz (mismo árbol, autor, mensaje y hora) y parecerían el mismo proyecto.
    std::fs::write(dir.join("a.txt"), format!("base de {name}\n")).unwrap();
    g(&dir, &["add", "."]);
    g(&dir, &["commit", "-qm", "base"]);
    if let Some(url) = remote {
        g(&dir, &["remote", "add", "origin", url]);
    }
    dir
}

/// Copia por `git clone` (mismos commits raíz) con el remoto que se pida (`None` = sin remoto).
fn clon(base: &Path, de: &Path, name: &str, remote: Option<&str>) -> PathBuf {
    let dir = base.join("repos").join(name);
    g(base, &["clone", "-q", de.to_str().unwrap(), dir.to_str().unwrap()]);
    g(&dir, &["config", "user.name", "t"]);
    g(&dir, &["config", "user.email", "t@t"]);
    g(&dir, &["remote", "remove", "origin"]);
    if let Some(url) = remote {
        g(&dir, &["remote", "add", "origin", url]);
    }
    dir
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Un Core arrancado con el almacén abierto (SQLite autoritativa).
fn core_listo() -> (Limpia, PathBuf, PathBuf, Arc<Core>) {
    let (l, data, core_dir) = dirs();
    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(matches!(core.storage_status(), StorageStatus::Ready(_)));
    (l, data, core_dir, core)
}

fn base_de(data: &Path) -> PathBuf {
    data.parent().unwrap().to_path_buf()
}

fn rpc(core: &Arc<Core>, cmd: &str, args: Value) -> Result<Value, String> {
    core.rpc(Caller::User, "", cmd, &args)
}

fn registra(core: &Arc<Core>, path: &Path) -> Value {
    rpc(core, "project_add", json!({ "path": s(path) })).unwrap()
}

fn id_de(v: &Value) -> String {
    v["project"]["id"].as_str().unwrap().to_string()
}

fn lista(core: &Arc<Core>) -> Vec<Value> {
    rpc(core, "projects", json!({ "all": true })).unwrap()["projects"].as_array().unwrap().clone()
}

/// Una tarea cuyo repositorio es `repo` (el estado se muta por la frontera, como en producción).
fn tarea_en(core: &Arc<Core>, repo: &str, titulo: &str) -> String {
    core.mutate(|st| {
        Ok(st
            .create_run("obj", NewTask {
                agent: "coordinador".into(), model: None, effort: None, role: None, title: titulo.into(), spec: "s".into(),
                repo: repo.into(), cwd: repo.into(), branch: None, base: None, worktree: None, external: false,
            })
            .1)
    })
    .unwrap()
}

fn project_id_de_tarea(core: &Arc<Core>, task: &str) -> Option<String> {
    core.lock().tasks.get(task).unwrap().project_id.clone()
}

// ---------------------------------------------------------------------------------------------
// Rutas y remotos (puras)
// ---------------------------------------------------------------------------------------------

#[test]
fn las_rutas_se_normalizan_por_sistema_operativo() {
    // Windows: sin distinguir mayúsculas, con `/`, sin `\\?\` ni barra final.
    assert_eq!(norm_path_for(r"C:\Users\Ana\Repo\", true), "c:/users/ana/repo");
    assert_eq!(norm_path_for(r"\\?\C:\Users\Ana\Repo", true), "c:/users/ana/repo");
    assert_eq!(norm_path_for("c:/USERS/ana/repo", true), norm_path_for(r"C:\users\ANA\repo", true));
    // Unix: las mayúsculas SÍ distinguen rutas.
    assert_ne!(norm_path_for("/home/ana/Repo", false), norm_path_for("/home/ana/repo", false));
    assert_eq!(norm_path_for("/home/ana/repo/", false), "/home/ana/repo");
}

#[test]
fn los_remotos_se_normalizan_y_nunca_conservan_credenciales() {
    let n = |u: &str| git::normalize_remote(u).unwrap();
    assert_eq!(n("https://github.com/Org/Repo.git"), "github.com/Org/Repo");
    assert_eq!(n("git@github.com:Org/Repo.git"), "github.com/Org/Repo");
    assert_eq!(n("ssh://git@GitHub.com/Org/Repo"), "github.com/Org/Repo");
    assert_eq!(n("https://usuario:TOKEN-SECRETO@github.com/Org/Repo.git"), "github.com/Org/Repo");
    assert_eq!(n("https://TOKEN-SECRETO@github.com:8443/Org/Repo/"), "github.com:8443/Org/Repo");
    for u in ["https://u:TOKEN-SECRETO@h.com/o/r.git", "https://TOKEN-SECRETO@h.com/o/r", "git@h.com:o/r.git"] {
        assert!(!n(u).contains("TOKEN-SECRETO") && !n(u).contains('@'), "{u} -> {}", n(u));
    }
    assert_eq!(n(r"C:\repos\bare.git"), "C:/repos/bare");
    assert!(git::normalize_remote("  ").is_none());
}

#[test]
fn la_regla_de_compatibilidad_distingue_clon_de_fork() {
    let fp = |c: &[&str], r: &[&str]| Fingerprint { root_commits: c.iter().map(|x| x.to_string()).collect(), remotes: r.iter().map(|x| x.to_string()).collect(), default_branch: None };
    // Mismo remoto: candidato.
    assert!(compatible(&fp(&["a"], &["h/o/r"]), &fp(&["a"], &["h/o/r"])));
    // Fork: mismos commits raíz y remotos DISTINTOS: otro proyecto.
    assert!(!compatible(&fp(&["a"], &["h/yo/r"]), &fp(&["a"], &["h/o/r"])));
    // Sin remoto en alguno de los dos: no se puede distinguir de un fork -> candidato (se pregunta).
    assert!(compatible(&fp(&["a"], &[]), &fp(&["a"], &["h/o/r"])));
    assert!(compatible(&fp(&["a"], &["h/o/r"]), &fp(&["a"], &[])));
    assert!(compatible(&fp(&["a"], &[]), &fp(&["a"], &[])));
    // Sin commit raíz en común: nunca.
    assert!(!compatible(&fp(&["b"], &["h/o/r"]), &fp(&["a"], &["h/o/r"])));
    assert!(!compatible(&fp(&[], &[]), &fp(&["a"], &[])), "un repo sin commits no se reconoce por huella");
}

// ---------------------------------------------------------------------------------------------
// Identidad con git real
// ---------------------------------------------------------------------------------------------

#[test]
fn la_identidad_de_un_repo_sale_de_git_y_un_worktree_es_el_mismo_repo() {
    let (_l, data, _c, _core) = core_listo();
    let base = base_de(&data);
    let r = repo(&base, "api", Some("https://usuario:TOKEN-SECRETO@github.com/o/api.git"));
    let a = identify(&s(&r)).unwrap();
    assert_eq!(a.name, "api");
    assert_eq!(a.fingerprint.root_commits.len(), 1);
    assert_eq!(a.fingerprint.remotes, vec!["github.com/o/api".to_string()], "sin credenciales");
    assert_eq!(a.fingerprint.default_branch.as_deref(), Some("main"));

    // Un worktree enlazado (`<repo>.lixbon-wt/…`) resuelve a la raíz del repo principal.
    let wt = base.join("repos").join("api.lixbon-wt").join("t1");
    g(&r, &["worktree", "add", "-q", "-b", "lx/t1", wt.to_str().unwrap()]);
    let b = identify(&s(&wt)).unwrap();
    assert_eq!(b.key, a.key, "mismo proyecto que su repositorio");
    assert_eq!(b.fingerprint, a.fingerprint);
    // Y desde una subcarpeta también.
    std::fs::create_dir_all(r.join("src/x")).unwrap();
    assert_eq!(identify(&s(&r.join("src/x"))).unwrap().key, a.key);

    assert!(identify(&s(&base.join("no-existe"))).is_err());
    let plano = base.join("plano");
    std::fs::create_dir_all(&plano).unwrap();
    assert!(identify(&s(&plano)).unwrap_err().contains("repositorio git"), "una carpeta sin git no es un proyecto");
}

#[test]
fn un_repo_recien_creado_sin_commits_se_identifica_pero_sin_huella() {
    let (_l, data, _c, _core) = core_listo();
    let dir = base_de(&data).join("repos").join("vacio");
    std::fs::create_dir_all(&dir).unwrap();
    g(&dir, &["init", "-q", "-b", "main"]);
    let i = identify(&s(&dir)).unwrap();
    assert!(i.fingerprint.root_commits.is_empty());
}

// ---------------------------------------------------------------------------------------------
// Registro y reconocimiento (Core completo)
// ---------------------------------------------------------------------------------------------

#[test]
fn registrar_crea_un_proyecto_y_repetirlo_o_registrar_su_worktree_devuelve_el_mismo() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let r = repo(&base, "api", Some("https://github.com/o/api.git"));
    let primero = registra(&core, &r);
    assert_eq!(primero["status"], "registered");
    assert_eq!(primero["created"], true);
    assert_eq!(primero["project"]["name"], "api");
    assert_eq!(primero["project"]["state"], "active");
    let id = id_de(&primero);
    assert_eq!(primero["project"]["locations"].as_array().unwrap().len(), 1);
    assert_eq!(primero["project"]["locations"][0]["primary"], true);

    let otra_vez = registra(&core, &r);
    assert_eq!((otra_vez["created"].clone(), id_de(&otra_vez)), (json!(false), id.clone()), "idempotente");

    let wt = base.join("repos").join("api.lixbon-wt").join("t1");
    g(&r, &["worktree", "add", "-q", "-b", "lx/t1", wt.to_str().unwrap()]);
    let desde_wt = registra(&core, &wt);
    assert_eq!((desde_wt["created"].clone(), id_de(&desde_wt)), (json!(false), id), "un worktree resuelve al mismo proyecto que su repo");
    assert_eq!(lista(&core).len(), 1);
}

#[test]
fn un_fork_con_los_mismos_commits_raiz_y_remotos_distintos_es_otro_proyecto() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let origen = repo(&base, "origen", Some("https://github.com/o/app.git"));
    let fork = clon(&base, &origen, "fork", Some("https://github.com/yo/app.git"));
    assert_eq!(identify(&s(&origen)).unwrap().fingerprint.root_commits, identify(&s(&fork)).unwrap().fingerprint.root_commits, "comparten commits raíz");
    let a = registra(&core, &origen);
    let b = registra(&core, &fork);
    assert_eq!(b["status"], "registered", "sin pedir confirmación: no es candidato");
    assert_eq!(b["created"], true);
    assert_ne!(id_de(&a), id_de(&b));
    assert_eq!(lista(&core).len(), 2);
}

#[test]
fn un_clon_sin_remoto_siempre_pregunta_y_solo_la_confirmacion_lo_une_o_lo_separa() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let origen = repo(&base, "origen", Some("https://github.com/o/app.git"));
    let sin_remoto = clon(&base, &origen, "sin-remoto", None);
    let id = id_de(&registra(&core, &origen));

    let r = rpc(&core, "project_add", json!({ "path": s(&sin_remoto) })).unwrap();
    assert_eq!(r["status"], "needs_confirmation", "no se une en silencio: {r}");
    assert_eq!(r["candidates"][0]["project_id"], id.as_str());
    assert_eq!(r["candidates"][0]["reason"], "sin_remoto");
    assert_eq!(lista(&core).len(), 1, "preguntar no registra nada");

    // `join`: es el mismo proyecto -> nueva ubicación (la principal sigue siendo la que existe).
    let unido = rpc(&core, "project_add", json!({ "path": s(&sin_remoto), "join": id })).unwrap();
    assert_eq!((unido["created"].clone(), id_de(&unido)), (json!(false), id.clone()));
    let locs = unido["project"]["locations"].as_array().unwrap();
    assert_eq!(locs.len(), 2);
    assert_eq!(locs.iter().filter(|l| l["primary"] == true).count(), 1);

    // `new`: otro proyecto (p. ej. un fork sin remoto).
    let otro = clon(&base, &origen, "otro-sin-remoto", None);
    let n = rpc(&core, "project_add", json!({ "path": s(&otro), "new": true })).unwrap();
    assert_eq!(n["created"], true);
    assert_ne!(id_de(&n), id);

    // `join` a un proyecto que no coincide se rechaza.
    let ajeno = repo(&base, "ajeno", None);
    let e = rpc(&core, "project_add", json!({ "path": s(&ajeno), "join": id })).unwrap_err();
    assert!(e.contains("no coincide"), "{e}");
}

#[test]
fn un_repositorio_movido_pide_confirmacion_y_no_une_en_silencio() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let r = repo(&base, "app", Some("https://github.com/o/app.git"));
    let id = id_de(&registra(&core, &r));
    // «Se mueve» el repositorio: la carpeta vieja desaparece y aparece otra con el mismo contenido.
    let nueva = base.join("repos").join("app-movida");
    std::fs::rename(&r, &nueva).unwrap();

    // Al listar, la ubicación vieja pasa a `missing`.
    let p = &lista(&core)[0];
    assert_eq!(p["locations"][0]["state"], "missing");

    let r2 = rpc(&core, "project_add", json!({ "path": s(&nueva) })).unwrap();
    assert_eq!(r2["status"], "needs_confirmation");
    assert_eq!(r2["candidates"][0]["reason"], "ubicacion_desaparecida");
    assert_eq!(lista(&core).len(), 1);

    // Confirmado: mismo proyecto, la nueva ubicación pasa a ser la principal; la vieja queda registrada como desaparecida.
    let u = rpc(&core, "project_add", json!({ "path": s(&nueva), "join": id })).unwrap();
    assert_eq!(id_de(&u), id);
    let locs = u["project"]["locations"].as_array().unwrap();
    assert_eq!(locs.len(), 2);
    let principal: Vec<&Value> = locs.iter().filter(|l| l["primary"] == true).collect();
    assert_eq!(principal.len(), 1);
    assert_eq!(principal[0]["state"], "ok");
}

#[test]
fn project_locate_relocaliza_pero_pide_confirmacion_si_el_repo_no_parece_el_mismo() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let r = repo(&base, "app", Some("https://github.com/o/app.git"));
    let id = id_de(&registra(&core, &r));
    let ajeno = repo(&base, "ajeno", None);
    // Otro repositorio (commits raíz distintos): no se acepta sin confirmar.
    let d = rpc(&core, "project_locate", json!({ "project_id": id, "path": s(&ajeno) })).unwrap();
    assert_eq!(d["status"], "needs_confirmation");
    assert_eq!(lista(&core)[0]["locations"].as_array().unwrap().len(), 1, "no cambió nada");
    let ok = rpc(&core, "project_locate", json!({ "project_id": id, "path": s(&ajeno), "confirm": true })).unwrap();
    assert_eq!(ok["project"]["locations"].as_array().unwrap().len(), 2);
    // Una ruta que ya es de OTRO proyecto es un conflicto.
    let otro = repo(&base, "otro", None);
    let id2 = id_de(&registra(&core, &otro));
    let e = rpc(&core, "project_locate", json!({ "project_id": id, "path": s(&otro), "confirm": true })).unwrap_err();
    assert!(e.contains(&id2), "{e}");
    assert!(rpc(&core, "project_locate", json!({ "project_id": "no-existe", "path": s(&r) })).is_err());
}

// ---------------------------------------------------------------------------------------------
// Ciclo de vida y lanzamiento
// ---------------------------------------------------------------------------------------------

#[test]
fn archivar_oculta_sin_borrar_restaurar_lo_devuelve_y_un_proyecto_archivado_no_lanza() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let r = repo(&base, "app", None);
    let id = id_de(&registra(&core, &r));
    let t = tarea_en(&core, &s(&r), "trabajo");
    core.mutate(|st| {
        st.tasks.get_mut(&t).unwrap().project_id = Some(id.clone());
        Ok(())
    })
    .unwrap();
    assert!(core.check_project_launchable(&t).is_ok());

    let a = rpc(&core, "project_archive", json!({ "project_id": id })).unwrap();
    assert_eq!(a["project"]["state"], "archived");
    let activos = rpc(&core, "projects", json!({})).unwrap();
    assert!(activos["projects"].as_array().unwrap().is_empty(), "archivado = oculto");
    assert_eq!(lista(&core).len(), 1, "con `all` sigue ahí: nada se borró");
    assert_eq!(project_id_de_tarea(&core, &t).as_deref(), Some(id.as_str()), "su historial intacto");
    let e = core.check_project_launchable(&t).unwrap_err();
    assert!(e.contains("archivado"), "{e}");

    rpc(&core, "project_archive", json!({ "project_id": id, "archived": false })).unwrap();
    assert!(core.check_project_launchable(&t).is_ok());
    assert!(rpc(&core, "project_archive", json!({ "project_id": "no-existe" })).is_err());
}

#[test]
fn una_ubicacion_inexistente_pasa_a_missing_y_no_se_puede_lanzar() {
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let base = base_de(&data);
    let r = repo(&base, "app", None);
    let id = id_de(&registra(&core, &r));
    let t = tarea_en(&core, &s(&r), "trabajo");
    core.mutate(|st| {
        st.tasks.get_mut(&t).unwrap().project_id = Some(id.clone());
        Ok(())
    })
    .unwrap();
    std::fs::remove_dir_all(r.join(".git")).unwrap(); // sigue la carpeta, pero…
    std::fs::remove_dir_all(&r).unwrap(); // …ahora desaparece del todo
    let e = core.check_project_launchable(&t).unwrap_err();
    assert!(e.contains("project_locate"), "{e}");
    assert_eq!(lista(&core)[0]["locations"][0]["state"], "missing");
    // La historia sigue legible: la tarea y el proyecto existen.
    assert_eq!(project_id_de_tarea(&core, &t).as_deref(), Some(id.as_str()));
    // Y un lanzamiento de verdad (`spawn`) lo rechaza antes de planear nada.
    let e = core.rpc(Caller::Agent(Some(t.clone())), "", "spawn", &json!({ "task": "x", "agent": "claude" })).unwrap_err();
    assert!(e.contains("project_locate"), "el lanzamiento se rechaza por la ubicación: {e}");
}

#[test]
fn solo_la_persona_cambia_el_registro_y_los_agentes_solo_leen() {
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let r = repo(&base_de(&data), "app", None);
    registra(&core, &r);
    for cmd in ["project_add", "project_archive", "project_locate", "projects_import_recents"] {
        let e = core.rpc(Caller::Agent(None), &s(&r), cmd, &json!({ "path": s(&r), "project_id": "x", "paths": [] })).unwrap_err();
        assert!(e.contains("Solo desde la interfaz"), "{cmd}: {e}");
    }
    // Leer sí: la lectura no depende de quién llama (el orquestador desactivado solo corta a los agentes).
    assert_eq!(lista(&core).len(), 1);
}

// ---------------------------------------------------------------------------------------------
// Asignación a tareas
// ---------------------------------------------------------------------------------------------

#[test]
fn el_relleno_asigna_project_id_es_idempotente_y_deja_sin_asignar_lo_ambiguo() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let a = repo(&base, "a", Some("https://github.com/o/a.git"));
    let b = repo(&base, "b", None);
    let ta1 = tarea_en(&core, &s(&a), "a1");
    let ta2 = tarea_en(&core, &s(&a), "a2");
    let tb = tarea_en(&core, &s(&b), "b");
    let t_perdida = tarea_en(&core, &s(&base.join("repos").join("ya-no-existe")), "perdida");
    assert!(core.lock().tasks.values().all(|t| t.project_id.is_none()), "antes de D ninguna lo tiene");

    // Un repositorio ambiguo: ya hay un proyecto con el mismo commit raíz y sin remoto distinguible.
    let primero = repo(&base, "amb-1", None);
    registra(&core, &primero);
    let clon_amb = clon(&base, &primero, "amb-2", None);
    let t_amb = tarea_en(&core, &s(&clon_amb), "ambigua");

    let r1 = core.backfill_projects(Duration::from_secs(60)).unwrap();
    assert_eq!(r1["complete"], true);
    assert_eq!((r1["ambiguous"].clone(), r1["unresolved"].clone()), (json!(1), json!(1)), "{r1}");
    let (pa1, pa2, pb) = (project_id_de_tarea(&core, &ta1), project_id_de_tarea(&core, &ta2), project_id_de_tarea(&core, &tb));
    assert!(pa1.is_some() && pa1 == pa2, "tareas del mismo repo -> el mismo proyecto");
    assert!(pb.is_some() && pb != pa1);
    assert_eq!(project_id_de_tarea(&core, &t_perdida), None, "un repo que ya no existe se deja sin proyecto");
    assert_eq!(project_id_de_tarea(&core, &t_amb), None, "no se une en silencio");
    let proyectos = rpc(&core, "projects", json!({})).unwrap();
    assert_eq!(proyectos["unassigned_tasks"], 2);

    // Idempotente: repetirlo no asigna nada nuevo ni crea proyectos.
    let n = lista(&core).len();
    let r2 = core.backfill_projects(Duration::from_secs(60)).unwrap();
    assert_eq!(r2["assigned"], 0);
    assert_eq!(lista(&core).len(), n);
    assert!(core.storage.with_store(|s| s.meta("projects_backfilled").unwrap()).flatten().is_some(), "marca de pasada completa");
}

#[test]
fn el_relleno_respeta_su_presupuesto_y_no_marca_la_pasada_como_completa() {
    let (_l, data, _c, core) = core_listo();
    let a = repo(&base_de(&data), "a", None);
    tarea_en(&core, &s(&a), "a");
    let r = core.backfill_projects(Duration::ZERO).unwrap();
    assert_eq!((r["complete"].clone(), r["assigned"].clone()), (json!(false), json!(0)));
    assert!(core.storage.with_store(|s| s.meta("projects_backfilled").unwrap()).flatten().is_none(), "sin terminar no se marca");
    assert_eq!(core.backfill_projects(Duration::from_secs(60)).unwrap()["assigned"], 1, "el siguiente arranque lo retoma");
}

#[test]
fn una_hija_hereda_el_proyecto_de_su_padre_y_run_create_asigna_el_del_repositorio() {
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let r = repo(&base_de(&data), "app", Some("https://github.com/o/app.git"));
    // run_create (un coordinador externo en el repo): proyecto nuevo y asignado.
    let out = core.rpc(Caller::Agent(None), &s(&r), "run_create", &json!({ "objective": "hacer algo" })).unwrap();
    let raiz = out["task"].as_str().unwrap().to_string();
    let pid = project_id_de_tarea(&core, &raiz).expect("run_create asigna proyecto");
    assert_eq!(lista(&core)[0]["id"], pid.as_str());
    assert_eq!(lista(&core)[0]["tasks"], 1);
    // Un segundo run en el mismo repo reutiliza el proyecto.
    let out2 = core.rpc(Caller::Agent(None), &s(&r), "run_create", &json!({ "objective": "otra cosa" })).unwrap();
    assert_eq!(project_id_de_tarea(&core, out2["task"].as_str().unwrap()), Some(pid.clone()));
    assert_eq!(lista(&core).len(), 1);
    // La hija hereda.
    let hija = core.mutate(|st| st.add_child(&raiz, 1, NewTask {
        agent: "claude".into(), model: None, effort: None, role: None, title: "h".into(), spec: "s".into(),
        repo: s(&r), cwd: s(&r), branch: None, base: None, worktree: None, external: false,
    })).unwrap();
    assert_eq!(project_id_de_tarea(&core, &hija), Some(pid));
}

#[test]
fn run_create_en_un_repositorio_ambiguo_no_une_en_silencio_y_la_tarea_queda_sin_proyecto() {
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let base = base_de(&data);
    let origen = repo(&base, "origen", None);
    registra(&core, &origen);
    let copia = clon(&base, &origen, "copia", None);
    let out = core.rpc(Caller::Agent(None), &s(&copia), "run_create", &json!({ "objective": "x" })).unwrap();
    assert_eq!(project_id_de_tarea(&core, out["task"].as_str().unwrap()), None);
    assert_eq!(lista(&core).len(), 1, "no se creó ni se unió nada");
}

#[test]
fn importar_los_recientes_ocurre_una_sola_vez_y_no_pregunta() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let a = repo(&base, "a", None);
    let b = repo(&base, "b", None);
    let plano = base.join("plano");
    std::fs::create_dir_all(&plano).unwrap();
    let paths = json!({ "paths": [s(&a), s(&b), s(&plano), s(&base.join("no-existe")), s(&a)] });
    let r = rpc(&core, "projects_import_recents", paths.clone()).unwrap();
    assert_eq!(r["already_done"], false);
    assert_eq!(r["imported"], 2);
    assert_eq!(r["existing"], 1, "la repetida ya estaba");
    assert_eq!(r["skipped"].as_array().unwrap().len(), 2, "carpeta sin git y carpeta inexistente");
    assert_eq!(lista(&core).len(), 2);
    let otra = rpc(&core, "projects_import_recents", paths).unwrap();
    assert_eq!((otra["already_done"].clone(), otra["imported"].clone()), (json!(true), json!(0)));
    assert_eq!(lista(&core).len(), 2);
}

// ---------------------------------------------------------------------------------------------
// Garantías transversales
// ---------------------------------------------------------------------------------------------

fn instantanea(dir: &Path) -> Vec<(String, u64, std::time::SystemTime)> {
    fn rec(dir: &Path, out: &mut Vec<(String, u64, std::time::SystemTime)>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            let m = e.metadata().unwrap();
            if m.is_dir() {
                // De una carpeta solo importa que exista: su fecha la cambia el sistema (NTFS) por su cuenta.
                out.push((p.to_string_lossy().into_owned(), 0, std::time::UNIX_EPOCH));
                rec(&p, out);
            } else {
                out.push((p.to_string_lossy().into_owned(), m.len(), m.modified().unwrap()));
            }
        }
    }
    let mut v = vec![];
    rec(dir, &mut v);
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

#[test]
fn ningun_archivo_se_escribe_dentro_del_repositorio() {
    let (_l, data, _c, core) = core_listo();
    let base = base_de(&data);
    let r = repo(&base, "app", Some("https://github.com/o/app.git"));
    let wt = base.join("repos").join("app.lixbon-wt").join("t1");
    g(&r, &["worktree", "add", "-q", "-b", "lx/t1", wt.to_str().unwrap()]);
    let antes = (instantanea(&r), instantanea(&wt));
    registra(&core, &r);
    registra(&core, &wt);
    identify(&s(&r)).unwrap();
    rpc(&core, "project_locate", json!({ "project_id": id_de(&registra(&core, &r)), "path": s(&wt) })).unwrap();
    rpc(&core, "projects", json!({ "all": true })).unwrap();
    tarea_en(&core, &s(&r), "t");
    core.backfill_projects(Duration::from_secs(60)).unwrap();
    assert_eq!((instantanea(&r), instantanea(&wt)), antes, "ni un archivo creado, borrado o modificado en el repo ni en su worktree");
}

#[test]
fn el_registro_sobrevive_a_reiniciar_y_a_la_migracion_no_se_pierde_nada() {
    let (_l, data, core_dir, core) = core_listo();
    let r = repo(&base_de(&data), "app", Some("https://github.com/o/app.git"));
    let id = id_de(&registra(&core, &r));
    let t = tarea_en(&core, &s(&r), "trabajo");
    core.backfill_projects(Duration::from_secs(60)).unwrap();
    suelta(core, &core_dir);
    let (core2, _h, res) = arranca(&data, &core_dir);
    res.unwrap();
    let ps = lista(&core2);
    assert_eq!((ps.len(), ps[0]["id"].clone(), ps[0]["tasks"].clone()), (1, json!(id.clone()), json!(1)));
    assert_eq!(project_id_de_tarea(&core2, &t), Some(id), "Task.project_id se conserva en el estado de SQLite");
}

#[test]
fn las_tareas_anteriores_a_d_se_leen_sin_project_id() {
    // Compatibilidad: un `state.json` sin el campo sigue cargando (`serde(default)`), y el código
    // viejo ignora el campo nuevo.
    let t: super::state::Task = serde_json::from_value(json!({
        "id": "t1", "run": "r1", "parent": null, "depth": 0, "agent": "claude", "title": "x", "repo": "r", "cwd": "c",
        "branch": null, "base": null, "worktree": null, "status": "running", "created": 1, "updated": 1
    }))
    .unwrap_or_else(|e| panic!("la tarea antigua debía leerse: {e}"));
    assert_eq!(t.project_id, None);
    let con: Value = serde_json::to_value(&t).unwrap();
    assert!(con.get("project_id").is_some(), "se serializa explícito (null) en cuanto se guarda");
}
