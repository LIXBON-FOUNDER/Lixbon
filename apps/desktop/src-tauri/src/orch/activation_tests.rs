//! LXO-234 · activación del corte Task/Attempt en el arranque, con el interruptor de dogfood (`LIXBON_AGENTIC_CUT=1`):
//! corte, uso normal y reinicio; un corte que falla bloquea el arranque y deja la base intacta; y la restauración de la
//! copia previa de punta a punta (`lxo core restore` → siguiente arranque). Más una prueba sobre la copia de una base
//! real, que se lanza a mano (`LIXBON_REAL_COPY`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::json;

use super::agentic_cut::{self, HOLD_FILE, RESTORE_REQUEST_FILE, SWITCH_FOR_TESTS};
use super::boot_tests::{arranca, dirs, escribe_state_de, promovida, suelta};
use super::events::Channel;
use super::host::RecordingHost;
use super::state::NewTask;
use super::{Caller, Core, Orch};
use crate::store::cut_migration;

fn interruptor(on: bool) {
    SWITCH_FOR_TESTS.with(|c| c.set(Some(on)));
}

fn en_tablas(core: &Core) -> bool {
    core.storage.with_store(|s| s.runtime_on_tables().unwrap()).unwrap()
}

fn version(core: &Core) -> i64 {
    core.storage.with_store(|s| s.schema_version().unwrap()).unwrap()
}

fn legado(core: &Core) -> (i64, String) {
    core.storage.with_store(|s| s.legacy_state().unwrap().map(|l| (l.rev, l.doc)).unwrap()).unwrap()
}

fn titulos(core: &Core) -> Vec<String> {
    let mut v: Vec<String> = core.lock().tasks.values().map(|t| t.title.clone()).collect();
    v.sort();
    v
}

fn nt(title: &str) -> NewTask {
    NewTask {
        agent: "coordinador".into(), model: None, effort: None, role: None, title: title.into(), spec: "s".into(), repo: "r".into(),
        cwd: "c".into(), branch: None, base: None, worktree: None, external: true,
    }
}

fn nuevo_run(core: &Core, titulo: &str) {
    core.mutate(|tx| {
        tx.create_run(titulo, nt(titulo));
        Ok(())
    })
    .unwrap();
}

fn copias(core_dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(core_dir.join("backups")).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    v.sort();
    v
}

#[test]
fn sin_el_interruptor_el_arranque_no_corta() {
    interruptor(false);
    let (_l, data, core_dir) = dirs();
    promovida(&data, &core_dir, "previa");
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(!en_tablas(&c));
    assert_eq!(version(&c), cut_migration().version - 1, "el migrador se detiene antes del corte");
    assert!(!copias(&core_dir).iter().any(|n| n.contains("pre-f3-cut")));
}

#[test]
fn con_el_interruptor_el_arranque_corta_sigue_sobre_las_tablas_y_reinicia() {
    let (_l, data, core_dir) = dirs();
    interruptor(false);
    promovida(&data, &core_dir, "previa");
    let legacy0 = {
        let (c, _h, r) = arranca(&data, &core_dir);
        r.unwrap();
        let l = legado(&c);
        suelta(c, &core_dir);
        l
    };
    interruptor(true);
    let (c, host, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(en_tablas(&c), "con el interruptor el arranque corta");
    // Con el corte aplicado cae la barrera: las migraciones posteriores (015…) se aplican en ESTE mismo arranque, no en el siguiente.
    let ultima = crate::store::embedded().last().map(|m| m.version).unwrap();
    assert!(ultima > cut_migration().version, "hay migraciones posteriores al corte");
    assert_eq!(version(&c), ultima);
    let tabla: String = c.storage.with_store(|s| s.read(|x| Ok(x.query_row("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'env_blocks'", [], |r| r.get(0))?)).unwrap()).unwrap();
    assert!(tabla.contains("windows_sandbox_setup"), "en la misma sesión del corte la base ya admite la causa de entorno nueva: {tabla}");
    assert!(copias(&core_dir).iter().any(|n| n.contains("pre-f3-cut")), "con su copia previa: {:?}", copias(&core_dir));
    assert_eq!(titulos(&c), ["previa"], "el estado cargado de las tablas es el del legado");
    // Paso 6: la tarea del legado que estaba en marcha queda huérfana (no es externa).
    assert!(c.lock().tasks.values().all(|t| t.status.is_final() || t.external));
    assert_eq!(legado(&c), legacy0, "legacy_state queda congelado tal cual");
    assert!(host.notifications().iter().all(|(t, _)| t != "Lixbon no puede iniciar"));
    // Uso normal.
    nuevo_run(&c, "tras el corte");
    suelta(c, &core_dir);
    // Reinicio: ya cortada, no vuelve a cortar ni a copiar; el estado sigue ahí.
    let antes = copias(&core_dir);
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(en_tablas(&c));
    assert_eq!(titulos(&c), ["previa", "tras el corte"]);
    assert_eq!(copias(&core_dir), antes, "un segundo arranque no corta ni copia otra vez");
    let eventos: i64 = c.storage.with_store(|s| s.read(|x| Ok(x.query_row("SELECT count(*) FROM events WHERE kind = 'core.agentic_cut'", [], |r| r.get(0))?)).unwrap()).unwrap();
    assert_eq!(eventos, 1);
}

#[test]
fn un_corte_que_falla_bloquea_el_arranque_con_su_mensaje_y_deja_la_base_intacta() {
    let (_l, data, core_dir) = dirs();
    interruptor(false);
    // Un documento que el corte no reconstruye igual (un commit base sin Worktree ni base): la validación semántica lo
    // rechaza dentro de la transacción.
    let previa = Orch::default().0;
    {
        let mut st = previa.lock_unpersisted();
        let (_, t) = st.create_run("obj", nt("rara"));
        st.task_mut(&t).unwrap().base_commit = Some("abc1234".into());
    }
    escribe_state_de(&previa, &data);
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    let (legacy0, version0) = (legado(&c), version(&c));
    suelta(c, &core_dir);

    interruptor(true);
    let (c, host, r) = arranca(&data, &core_dir);
    let e = r.expect_err("el arranque se bloquea");
    assert!(e.contains("no se pudo pasar al modelo Task/Attempt") && e.contains("LIXBON_AGENTIC_CUT"), "{e}");
    assert!(host.notifications().iter().any(|(t, m)| t == "Lixbon no puede iniciar" && m.contains("Task/Attempt")), "se avisa en Desktop");
    suelta(c, &core_dir);

    // La base quedó como estaba: misma versión, mismo legado, sin cortar. Sin el interruptor arranca como siempre.
    interruptor(false);
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert_eq!((legado(&c), version(&c), en_tablas(&c)), (legacy0, version0, false));
    assert_eq!(titulos(&c), ["rara"]);
}

#[test]
fn la_restauracion_vuelve_a_la_base_de_antes_del_corte_de_punta_a_punta() {
    let (_l, data, core_dir) = dirs();
    interruptor(false);
    promovida(&data, &core_dir, "previa");
    interruptor(true);
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(en_tablas(&c));
    nuevo_run(&c, "solo tras el corte");
    // Un agente no restaura; una persona sí, para el siguiente arranque.
    assert!(c.rpc(Caller::Agent(Some("t1".into())), "", "core_restore", &json!({})).is_err());
    let pedida = c.rpc_via(Channel::Ui, Caller::User, "", "core_restore", &json!({})).unwrap();
    assert_eq!(pedida["requested"], true);
    assert!(pedida["copy"].as_str().unwrap().contains("pre-f3-cut"));
    assert!(core_dir.join(RESTORE_REQUEST_FILE).exists());
    // Pedirla no toca nada mientras el Core sigue en marcha.
    assert!(en_tablas(&c));
    suelta(c, &core_dir);

    // Siguiente arranque, con el interruptor aún puesto: restaura y no vuelve a cortar (la espera).
    let (c, host, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(!en_tablas(&c), "la base es la de antes del corte");
    assert_eq!(version(&c), cut_migration().version - 1);
    assert_eq!(titulos(&c), ["previa"], "lo posterior al corte se pierde (ADR §12)");
    assert!(core_dir.join(HOLD_FILE).exists() && !core_dir.join(RESTORE_REQUEST_FILE).exists());
    assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon: base restaurada"));
    let apartadas: Vec<PathBuf> = std::fs::read_dir(&core_dir).unwrap().flatten().map(|e| e.path()).filter(|p| p.file_name().unwrap().to_string_lossy().starts_with("rollback-")).collect();
    assert_eq!(apartadas.len(), 1);
    assert!(apartadas[0].join("lixbon.db").exists(), "la base cortada se aparta, no se borra");
    // El runtime legacy funciona sobre la base restaurada.
    nuevo_run(&c, "de nuevo en legacy");
    suelta(c, &core_dir);
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(!en_tablas(&c), "con la espera, el interruptor no vuelve a cortar");
    assert_eq!(titulos(&c), ["de nuevo en legacy", "previa"]);
    suelta(c, &core_dir);

    // Quitar la espera es volver a intentarlo.
    std::fs::remove_file(core_dir.join(HOLD_FILE)).unwrap();
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(en_tablas(&c));
    assert_eq!(titulos(&c), ["de nuevo en legacy", "previa"]);
}

#[test]
fn una_restauracion_pedida_se_puede_retirar_y_una_copia_que_no_cuadra_no_se_pide() {
    let (_l, data, core_dir) = dirs();
    interruptor(false);
    promovida(&data, &core_dir, "previa");
    interruptor(true);
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    c.rpc_via(Channel::Ui, Caller::User, "", "core_restore", &json!({})).unwrap();
    assert_eq!(c.rpc_via(Channel::Ui, Caller::User, "", "core_restore", &json!({ "cancel": true })).unwrap()["cancelled"], true);
    assert!(!core_dir.join(RESTORE_REQUEST_FILE).exists());
    let copia = agentic_cut::latest_copy(&core_dir).unwrap();
    let sidecar = copia.with_file_name(format!("{}.json", copia.file_name().unwrap().to_string_lossy()));
    let mut sc: serde_json::Value = serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
    sc["db_sha256"] = json!("0".repeat(64));
    std::fs::write(&sidecar, serde_json::to_vec(&sc).unwrap()).unwrap();
    assert!(c.rpc_via(Channel::Ui, Caller::User, "", "core_restore", &json!({ "copy": copia })).is_err());
    assert!(!core_dir.join(RESTORE_REQUEST_FILE).exists(), "una copia que no cuadra no se pide");
}

/// Sobre la copia de una base real (LXO-234: «copias de bases reales del equipo»). Se lanza a mano:
/// `LIXBON_REAL_COPY=<carpeta con lixbon.db, state.json y authority.json> cargo test --lib real_copy -- --ignored --nocapture`.
/// Trabaja sobre una copia en una carpeta temporal: la carpeta de origen no se toca.
#[test]
#[ignore = "se lanza a mano con LIXBON_REAL_COPY"]
fn real_copy_corte_uso_reinicio_y_restauracion() {
    let Some(origen) = std::env::var_os("LIXBON_REAL_COPY").map(PathBuf::from) else { return };
    let (_l, data, core_dir) = dirs();
    std::fs::create_dir_all(&core_dir).unwrap();
    std::fs::copy(origen.join("lixbon.db"), core_dir.join("lixbon.db")).unwrap();
    for (f, dest) in [("authority.json", core_dir.join("authority.json")), ("state.json", data.join("state.json"))] {
        if origen.join(f).exists() {
            std::fs::copy(origen.join(f), dest).unwrap();
        }
    }
    interruptor(false);
    let (antes_tasks, antes_runs, antes_msgs) = {
        let (c, _h, r) = arranca(&data, &core_dir);
        r.unwrap();
        let st = c.lock().clone();
        println!("[real] antes: v{} · {} runs · {} tareas · {} mensajes · {} decisiones", version(&c), st.runs.len(), st.tasks.len(), st.messages.len(), st.decisions.len());
        let v = (st.tasks.keys().cloned().collect::<Vec<_>>(), st.runs.len(), st.messages.len());
        suelta(c, &core_dir);
        v
    };
    interruptor(true);
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(en_tablas(&c), "la base real se corta");
    let counts = c.storage.with_store(|s| s.read(|x| Ok(x.query_row("SELECT (SELECT count(*) FROM tasks), (SELECT count(*) FROM attempts), (SELECT count(*) FROM legacy_residue)", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))?)).unwrap()).unwrap();
    println!("[real] tras el corte: {} tareas · {} attempts · {} en residuo", counts.0, counts.1, counts.2);
    assert_eq!(c.lock().tasks.keys().cloned().collect::<Vec<_>>(), antes_tasks, "las mismas tareas");
    let (runs, msgs) = {
        let st = c.lock();
        (st.runs.len(), st.messages.len())
    };
    assert_eq!((runs, msgs <= antes_msgs), (antes_runs, true), "los mismos Runs; los mensajes, salvo los colgantes que van a residuo");
    nuevo_run(&c, "uso normal tras el corte real");
    let foto = serde_json::to_value(&*c.lock()).unwrap();
    suelta(c, &core_dir);
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    let mut despues = serde_json::to_value(&*c.lock()).unwrap();
    let mut esperado = foto;
    for v in [&mut despues, &mut esperado] {
        for r in v["runs"].as_object_mut().unwrap().values_mut() {
            r["last_activity"] = serde_json::Value::Null;
        }
    }
    assert_eq!(despues, esperado, "el reinicio carga lo mismo");
    c.rpc_via(Channel::Ui, Caller::User, "", "core_restore", &json!({})).unwrap();
    suelta(c, &core_dir);
    let (c, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(!en_tablas(&c), "restaurada");
    assert_eq!(c.lock().tasks.keys().cloned().collect::<Vec<_>>(), antes_tasks, "y vuelve exactamente a las tareas de antes");
    println!("[real] corte, uso, reinicio y restauración: ok");
    let _ = Arc::new(RecordingHost::new());
}
