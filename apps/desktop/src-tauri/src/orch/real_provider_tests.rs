//! Prueba de humo contra un CLI REAL (LXO-246): el flujo completo —crear la Task con su primer Attempt, aprobarlo como una
//! Person en Desktop, lanzarlo por el adapter real, escucharlo y cerrarlo— con el binario `claude` de la máquina y el modelo
//! más barato. **Gasta cuota**, así que está `#[ignore]`: la CI nunca la ejecuta. A mano:
//!
//! ```text
//! cargo test --lib --locked real_claude -- --ignored --nocapture
//! ```
//!
//! No sustituye una prueba en la aplicación (Desktop firma la aprobación con su identidad): usa la misma frontera RPC
//! autenticada, pero sin interfaz. El repositorio es temporal; el prompt no pide herramientas ni toca nada.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::adapter::{ClaudeAdapter, ClaudeConfig};
use super::adapter_launcher::AdapterLauncher;
use super::adapter_launcher_tests::{registry_of, repo_with_commit, worktree_dir_of};
use super::dispatch_tests::row;
use super::events::Channel;
use super::initial_approval_tests::e2e::core_with_project_at;
use crate::store::ClientClaims;

const PROMPT: &str = "Responde exactamente con la palabra OK y nada más. No uses ninguna herramienta ni leas ningún archivo.";

fn events_of(core: &super::Core, attempt: &str) -> Vec<String> {
    core.storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT kind FROM events WHERE entity_id = ?1 ORDER BY seq")?;
                let rows = stmt.query_map([attempt], |r| r.get::<_, String>(0))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
        })
        .unwrap()
        .unwrap()
}

fn facts(core: &super::Core, attempt: &str) -> (String, Option<String>, Option<String>, bool) {
    core.storage
        .with_store(|s| {
            s.read(|c| {
                Ok(c.query_row("SELECT summary, model_effective, model_source, provider_session_id IS NOT NULL FROM attempts WHERE id = ?1", [attempt], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?)
            })
        })
        .unwrap()
        .unwrap()
}

/// Crea, aprueba y lanza un Attempt con el Claude real y espera a un estado final con el claim asentado.
/// Devuelve (estado, claim, motivo del fallo, repositorio, Core, id del Attempt).
fn run_real(prompt: &str, approval_ttl: Duration) -> (String, String, Option<String>, std::path::PathBuf, Arc<super::Core>, String) {
    let repo = repo_with_commit();
    let (core, client, _ctx, project) = core_with_project_at(&repo.to_string_lossy());

    // El lanzador real, sobre el adapter REAL de Claude. El preflight de `task_create` mira el registro propio del Core (en
    // pruebas, adapters falsos); el lanzamiento usa el de la prueba.
    let registry = registry_of(Arc::new(ClaudeAdapter::new(ClaudeConfig::default())));
    let snapshot = LiveSnapshot::of(&registry);
    eprintln!("== sonda del CLI real: {snapshot}");
    core.install_launcher(Arc::new(AdapterLauncher::new(&core, registry).with_approval_ttl(approval_ttl)));
    core.provider_registry.probe_all();

    let rpc = |cmd: &str, args: Value| core.rpc_authenticated_via(&client, &ClientClaims::default(), Channel::Ui, "", cmd, &args);
    let created = rpc(
        "task_create",
        json!({"request_id": "real-1", "project_id": project, "objective": "prueba de humo", "title": "humo", "spec": prompt, "attempt": {"provider": "claude", "model": "haiku", "profile": "explorar"}}),
    )
    .expect("task_create");
    let attempt = created["attempt_id"].as_str().unwrap().to_string();
    // Las respuestas del RPC no se imprimen: salen de la frontera autenticada y CodeQL las trata como datos sensibles.
    eprintln!("== Task y Attempt creados");
    assert_eq!(row(&core, &attempt).0, "pending_approval");

    rpc("attempt_approve", json!({"attempt_id": attempt})).expect("attempt_approve");
    eprintln!("== Attempt aprobado");

    // Espera (con límite) a un estado final, mostrando cada cambio de estado.
    let end = Instant::now() + Duration::from_secs(180);
    let mut last = String::new();
    loop {
        let (status, claim, failure) = row(&core, &attempt);
        let line = format!("{status} / claim {claim} / {failure:?}");
        if line != last {
            eprintln!("== [{:>3}s] {line}", 180 - end.saturating_duration_since(Instant::now()).as_secs());
            last = line;
        }
        if matches!(status.as_str(), "done" | "failed" | "stopped" | "exited") && claim == "settled" {
            break;
        }
        if Instant::now() > end {
            core.kill_all_terms();
            panic!("el Attempt no terminó en 180 s (último estado: {last})");
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    let (summary, model, source, session) = facts(&core, &attempt);
    eprintln!("== eventos: {:?}", events_of(&core, &attempt));
    eprintln!("== resumen: {summary:?} · modelo efectivo: {model:?} ({source:?}) · sesión vinculada: {session}");
    eprintln!("== worktree: {} (existe: {})", worktree_dir_of(&repo, &attempt).display(), worktree_dir_of(&repo, &attempt).is_dir());

    let (status, claim, failure) = row(&core, &attempt);
    (status, claim, failure, repo, core, attempt)
}

#[test]
#[ignore = "lanza el CLI real de Claude y gasta cuota: ejecutar a mano con --ignored"]
fn real_claude_con_haiku_crea_aprueba_lanza_y_completa() {
    let (status, claim, failure, ..) = run_real(PROMPT, Duration::from_secs(60));
    assert_eq!((status.as_str(), claim.as_str(), failure), ("done", "settled", None), "el Attempt debía completar");
}

/// Un prompt que pide ESCRIBIR un archivo: con el perfil `explorar` (solo lectura) el CLI real puede pedir permiso, negarse o
/// escribir. La prueba no presupone cuál: comprueba que, ocurra lo que ocurra, el Attempt TERMINA y su claim se asienta (nada
/// se queda esperando para siempre) y deja el desenlace a la vista.
#[test]
#[ignore = "lanza el CLI real de Claude y gasta cuota: ejecutar a mano con --ignored"]
fn real_claude_con_una_peticion_de_escritura_termina_sin_colgarse() {
    let (status, claim, failure, repo, core, attempt) =
        run_real("Crea un archivo llamado prueba.txt en el directorio actual con el texto hola usando la herramienta de escritura.", Duration::from_secs(20));
    assert_eq!(claim, "settled", "el claim se asienta aunque el desenlace no sea éxito");
    assert!(matches!(status.as_str(), "done" | "failed" | "stopped"), "estado final inesperado: {status}");
    let written = worktree_dir_of(&repo, &attempt).join("prueba.txt").exists();
    eprintln!("== desenlace con petición de escritura: {status} / {failure:?} · archivo escrito: {written}");
    let waited = events_of(&core, &attempt).iter().any(|k| k == "attempt.waiting");
    eprintln!("== pasó por una espera de respuesta: {waited}");
}

/// La sonda del CLI real, en una línea.
struct LiveSnapshot(String);

impl LiveSnapshot {
    fn of(registry: &Arc<super::provider_registry::LiveRegistry>) -> LiveSnapshot {
        let value = super::provider_registry::LiveRegistry::snapshot(registry, false);
        std::thread::sleep(Duration::from_millis(200));
        let _ = value;
        let value = super::provider_registry::LiveRegistry::snapshot(registry, false);
        LiveSnapshot(value["providers"].to_string())
    }
}

impl std::fmt::Display for LiveSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
