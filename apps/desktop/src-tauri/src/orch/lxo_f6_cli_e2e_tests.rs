//! LXO-179 · `lxo delegate` y `lxo attempt handoff` con el binario REAL, como persona, contra el HTTP de un Core con dos proveedores falsos
//! y repositorios git reales. Lo que se comprueba es lo que ninguna prueba con un Core simulado puede: que las peticiones de lxo son las que el
//! Core acepta (campos exactos, policy, identidad), lo DURABLE que queda (Task, Attempt `pending_approval`, hechos de procedencia) y lo que de
//! verdad llega al agente receptor tras la aprobación de Desktop. Requiere `LXO_BIN` y usa el almacén seguro del sistema.
//!
//! ```text
//! $env:LXO_BIN = (Resolve-Path <lxo.exe>).Path
//! cargo test --lib --manifest-path src-tauri/Cargo.toml orch::lxo_f6_cli_e2e_tests -- --ignored --exact --nocapture
//! ```

use std::process::Output;

use serde_json::Value;

use super::attempt_e2e_tests::kinds;
use super::dispatch_tests::row;
use super::fork_e2e_tests::world_duo;
use super::projects_overview_tests::{registra_agente, RealStoreServer};
use super::take_over_e2e_tests::payloads;
use super::Core;

fn task_of(attempt: &str) -> String {
    attempt.rsplit_once("-a").unwrap().0.to_string()
}

fn attempt_count(core: &Core) -> i64 {
    core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM attempts", [], |r| r.get::<_, i64>(0))?))).unwrap().unwrap()
}

fn task_count(core: &Core) -> usize {
    core.lock().tasks.len()
}

fn text(out: &Output) -> String {
    format!("exit={:?} stdout={} stderr={}", out.status.code(), String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))
}

/// El error `--json` que `lxo` deja en stderr.
fn error_of(out: &Output) -> Value {
    serde_json::from_slice(&out.stderr).unwrap_or_else(|_| panic!("stderr no es JSON: {}", text(out)))
}

#[test]
#[ignore = "requiere un binario lxo real (LXO_BIN) y el almacén seguro del sistema; ver apps/desktop/README.md"]
fn lxo_bin_e2e_delegate_handoff_person_real_store() {
    let (w, codex) = world_duo();
    let a1 = w.finished("cli-origen");
    let task = task_of(&a1);
    let project = w.project.clone();
    let dir = std::env::temp_dir().join(format!("lxo-f6-cli-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let server = RealStoreServer::start(&w.core, &dir, &dir);

    // ── lxo attempt handoff ────────────────────────────────────────────────────────────────────────────────────────────────────
    // Sin receptor, lxo ni pregunta al Core: no elige agente por ti.
    let sin_receptor = server.lxo(&["attempt", "handoff", &a1, "--json"], None);
    assert_eq!(sin_receptor.status.code(), Some(2), "{}", text(&sin_receptor));

    // Previsualización: enseña origen, receptor, contexto y policy y no crea nada.
    let attempts = attempt_count(&w.core);
    let dry = server.json(&["attempt", "handoff", &a1, "--provider", "codex", "--dry-run", "--json"]);
    assert_eq!((dry["status"].as_str(), dry["v"].as_u64()), (Some("dry_run"), Some(1)), "{dry}");
    assert_eq!((dry["source"]["attempt_id"].as_str(), dry["target"]["provider"].as_str()), (Some(a1.as_str()), Some("codex")));
    assert_eq!((dry["policy"]["category"]["category"].as_str(), dry["context"]["built_by"].as_str()), (Some("start"), Some("core")));
    assert_eq!(attempt_count(&w.core), attempts, "el dry-run no crea nada");

    // El traspaso real: el siguiente Attempt de la MISMA Task, pendiente de la decisión de Desktop.
    let handoff = ["attempt", "handoff", a1.as_str(), "--provider", "codex", "--instruction", "termina los tests que faltan", "--json"];
    let out = server.json(&handoff);
    let a2 = format!("{task}-a2");
    assert_eq!((out["status"].as_str(), out["attempt_id"].as_str(), out["source_attempt_id"].as_str()), (Some("Requested"), Some(a2.as_str()), Some(a1.as_str())), "{out}");
    assert_eq!((out["attempt_status"].as_str(), out["approval_required"].as_bool(), out["approval_surface"].as_str()), (Some("pending_approval"), Some(true), Some("desktop")));
    assert_eq!((out["strategy"].as_str(), out["reason"].as_str()), (Some("context_package"), Some("provider_changed")));
    assert_eq!(out["link"], format!("lixbon://project/{project}/task/{task}/attempt/{a2}"), "el enlace al Attempt nuevo viene del Core");
    let codes: Vec<&str> = out["transfer"]["left_out"].as_array().unwrap().iter().filter_map(|i| i["code"].as_str()).collect();
    assert!(codes.contains(&"provider_session"), "dice qué se quedó fuera: {codes:?}");
    assert_eq!(row(&w.core, &a2).0, "pending_approval");
    assert!(codex.starts().is_empty(), "desde la CLI nada se lanza antes de la aprobación");
    assert!(kinds(&w.core, &a2).contains(&"attempt.continued".to_string()));

    // Repetirlo no crea otro Attempt: lxo enseña el que ya existe.
    let again = server.json(&handoff);
    assert_eq!((again["status"].as_str(), again["attempt_id"].as_str()), (Some("Replayed"), Some(a2.as_str())), "{again}");
    assert_eq!(attempt_count(&w.core), attempts + 1);
    let human = server.lxo(&["attempt", "handoff", &a1, "--provider", "codex", "--instruction", "termina los tests que faltan"], None);
    assert!(human.status.success() && String::from_utf8_lossy(&human.stdout).contains("ya existía"), "{}", text(&human));

    // Lo que ve el receptor tras aprobar en Desktop: la instrucción de la persona dicha desde la CLI.
    w.approve(&a2);
    w.settled(&a2, "done");
    assert_eq!(codex.starts().len(), 1, "lo lanzó codex");
    let prompt = codex.starts()[0].prompt.clone();
    assert!(prompt.contains("INSTRUCCIÓN DE LA PERSONA:\ntermina los tests que faltan") && prompt.contains("QUÉ SE QUEDÓ FUERA"), "{prompt}");

    // Con un paquete que la persona exportó y revisó: el resumen se ve antes de confirmar y el mismo proveedor reanuda con sesión nueva.
    let file = dir.join("paquete-a2.json");
    let export = server.json(&["context", "export", &a2, "--out", file.to_str().unwrap(), "--json"]);
    let package = export["package_id"].as_str().expect("el Core guardó el paquete").to_string();
    let preview = server.json(&["attempt", "handoff", &a2, "--provider", "codex", "--context-package", &package, "--dry-run", "--json"]);
    assert_eq!((preview["context"]["package_id"].as_str(), preview["context"]["built_by"].as_str()), (Some(package.as_str()), Some("stored")), "{preview}");
    assert!(preview["context"]["summary"].is_object(), "el resumen del paquete se enseña antes de confirmar: {preview}");
    // Un paquete de OTRO Attempt no se envía: lxo lo rechaza antes y nada nace.
    let ajeno = server.json(&["context", "export", &a1, "--out", dir.join("paquete-a1.json").to_str().unwrap(), "--json"]);
    let ajeno_id = ajeno["package_id"].as_str().unwrap().to_string();
    let attempts = attempt_count(&w.core);
    let mal = server.lxo(&["attempt", "handoff", &a2, "--provider", "codex", "--context-package", &ajeno_id, "--json"], None);
    assert_eq!(mal.status.code(), Some(2), "{}", text(&mal));
    assert_eq!(attempt_count(&w.core), attempts);
    // Un archivo no es un id guardado: el traspaso pide el id.
    let archivo = server.lxo(&["attempt", "handoff", &a2, "--provider", "codex", "--context-package", file.to_str().unwrap(), "--json"], None);
    assert_eq!(archivo.status.code(), Some(2), "{}", text(&archivo));

    let mismo = server.json(&["attempt", "handoff", &a2, "--provider", "codex", "--context-package", &package, "--json"]);
    let a3 = format!("{task}-a3");
    assert_eq!((mismo["attempt_id"].as_str(), mismo["reason"].as_str(), mismo["package_id"].as_str()), (Some(a3.as_str()), Some("requested"), Some(package.as_str())), "{mismo}");
    assert_eq!(row(&w.core, &a3).0, "pending_approval");

    // Un Attempt que no ha terminado no se traspasa, y el origen ya traspasado no admite otra intención.
    let en_curso = server.lxo(&["attempt", "handoff", &a3, "--provider", "claude", "--json"], None);
    assert_eq!(en_curso.status.code(), Some(2), "{}", text(&en_curso));
    assert!(error_of(&en_curso)["error"].as_str().unwrap().contains("lxo attempt stop"));
    let conflicto = server.lxo(&["attempt", "handoff", &a2, "--provider", "claude", "--json"], None);
    assert_eq!(conflicto.status.code(), Some(2), "otro receptor para el mismo origen: {}", text(&conflicto));
    assert_eq!(attempt_count(&w.core), attempts + 1, "ni el en curso ni el conflicto crearon nada");

    // ── lxo delegate ───────────────────────────────────────────────────────────────────────────────────────────────────────────
    let tasks = task_count(&w.core);
    let base = ["delegate", "--project", project.as_str(), "--provider", "claude", "--profile", "explorar", "--instruction", "arregla el título"];
    let selection = |extra: &[&str]| -> Vec<String> { base.iter().chain(extra).map(|s| s.to_string()).collect() };
    let run = |args: Vec<String>| server.lxo(&args.iter().map(String::as_str).collect::<Vec<_>>(), None);

    // Previsualización desde una selección de código: el origen se comprueba en el Core y no nace nada.
    let dry = run(selection(&["--file", "README.md", "--line", "1", "--end-line", "3", "--dry-run", "--json"]));
    let dry: Value = serde_json::from_slice(&dry.stdout).unwrap_or_else(|_| panic!("{}", text(&dry)));
    assert_eq!((dry["status"].as_str(), dry["source"]["kind"].as_str()), (Some("dry_run"), Some("selection")), "{dry}");
    assert_eq!(dry["source"]["link"], format!("lixbon://project/{project}?file=README.md&line=1"));
    assert_eq!(dry["policy"]["category"]["category"], "start");
    assert_eq!(task_count(&w.core), tasks, "el dry-run no crea ninguna Task");

    // La delegación real: Task y Attempt NUEVOS, pendientes, con la procedencia durable y sin lanzar nada.
    let starts = w.adapter.starts().len();
    let real = run(selection(&["--file", "README.md", "--line", "1", "--end-line", "3", "--json"]));
    assert!(real.status.success(), "{}", text(&real));
    let delegated: Value = serde_json::from_slice(&real.stdout).unwrap();
    let (task2, attempt2) = (delegated["task_id"].as_str().unwrap().to_string(), delegated["attempt_id"].as_str().unwrap().to_string());
    assert_eq!((delegated["status"].as_str(), attempt2.as_str()), (Some("Requested"), format!("{task2}-a1").as_str()), "{delegated}");
    assert_ne!(task2, task, "es una Task nueva");
    assert_eq!((delegated["attempt_status"].as_str(), delegated["approval_required"].as_bool()), (Some("pending_approval"), Some(true)));
    assert_eq!(delegated["link"], format!("lixbon://project/{project}/task/{task2}/attempt/{attempt2}"));
    assert_eq!(task_count(&w.core), tasks + 1);
    assert_eq!(row(&w.core, &attempt2).0, "pending_approval");
    assert_eq!(w.adapter.starts().len(), starts, "delegar no lanza nada antes de la aprobación");
    let facts = payloads(&w.core, &attempt2, "attempt.delegated");
    assert_eq!((facts.len(), facts[0]["source_kind"].as_str(), facts[0]["line_end"].as_i64()), (1, Some("selection"), Some(3)), "{facts:?}");
    assert_eq!(facts[0]["link"], delegated["source"]["link"]);

    // Repetirla no crea otra Task.
    let again = run(selection(&["--file", "README.md", "--line", "1", "--end-line", "3", "--json"]));
    let again: Value = serde_json::from_slice(&again.stdout).unwrap();
    assert_eq!((again["status"].as_str(), again["task_id"].as_str()), (Some("Replayed"), Some(task2.as_str())), "{again}");
    assert_eq!(task_count(&w.core), tasks + 1);

    // Desde un Attempt con el paquete que revisó la persona: otra Task, el origen intacto y el paquete verificado.
    let antes = (row(&w.core, &a1), kinds(&w.core, &a1));
    let con_paquete = run(selection(&["--attempt", &a1, "--new-task", "--context-package", &ajeno_id, "--file", "README.md", "--line", "1", "--json"]));
    let con_paquete: Value = serde_json::from_slice(&con_paquete.stdout).unwrap_or_else(|_| panic!("{}", text(&con_paquete)));
    assert_eq!((con_paquete["strategy"].as_str(), con_paquete["package_id"].as_str(), con_paquete["source"]["kind"].as_str()), (Some("context_package"), Some(ajeno_id.as_str()), Some("attempt")), "{con_paquete}");
    let attempt3 = con_paquete["attempt_id"].as_str().unwrap();
    assert_ne!(task_of(attempt3), task);
    assert_eq!(payloads(&w.core, attempt3, "attempt.delegated")[0]["package_id"], ajeno_id.as_str());
    assert_eq!((row(&w.core, &a1), kinds(&w.core, &a1)), antes, "el origen no recibe ni un hecho");

    // Lo que NO debe crear nada: sin la acción explícita, con una revisión obsoleta, con un Project inexistente.
    let tasks = task_count(&w.core);
    let sin_new_task = run(selection(&["--attempt", &a1, "--file", "README.md", "--json"]));
    assert_eq!(sin_new_task.status.code(), Some(2), "{}", text(&sin_new_task));
    let obsoleta = run(selection(&["--attempt", &a1, "--new-task", "--file", "README.md", "--revision", "deadbee", "--json"]));
    assert_eq!(obsoleta.status.code(), Some(7), "una revisión obsoleta se rechaza: {}", text(&obsoleta));
    assert_eq!(error_of(&obsoleta)["code"], "stale");
    let obsoleta_dry = run(selection(&["--attempt", &a1, "--new-task", "--file", "README.md", "--revision", "deadbee", "--dry-run", "--json"]));
    assert_eq!(obsoleta_dry.status.code(), Some(7), "el dry-run falla igual que la delegación: {}", text(&obsoleta_dry));
    let mut sin_project = selection(&["--file", "README.md", "--json"]);
    sin_project[2] = "no-existe".into();
    let sin_project = run(sin_project);
    assert_eq!(sin_project.status.code(), Some(6), "{}", text(&sin_project));
    assert_eq!(task_count(&w.core), tasks, "nada de lo anterior creó una Task");

    // Un agente (no una persona) no delega ni traspasa: el Core lo rechaza.
    w.core.settings.lock().unwrap().enabled = true; // un agente solo habla con el Core si el orquestador está activo
    let token = "agente-e2e-token-0123456789abcdef-secret";
    registra_agente(&w.core, &task, "agente-e2e-install", token);
    let agente = server.lxo(&["delegate", "--project", &project, "--provider", "claude", "--profile", "explorar", "--instruction", "x", "--file", "README.md", "--json"], Some((task.as_str(), token)));
    assert_eq!(agente.status.code(), Some(3), "{}", text(&agente));
    let agente = server.lxo(&["attempt", "handoff", &a1, "--provider", "codex", "--json"], Some((task.as_str(), token)));
    assert_eq!(agente.status.code(), Some(3), "{}", text(&agente));
    assert_eq!(task_count(&w.core), tasks);

    drop(server);
    let _ = std::fs::remove_dir_all(&dir);
}
