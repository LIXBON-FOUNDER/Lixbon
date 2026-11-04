//! LXO-141 · De extremo a extremo por la superficie de Desktop: la persona crea una Task con su primer Attempt, lo aprueba
//! (o lo rechaza) y el Core lo lanza por el adapter del proveedor. Cada prueba entra por `rpc_via(Ui, User)` —el mismo camino
//! que `orch_call` del ADE, que firma con la identidad autenticada de Desktop— y comprueba el desenlace DURABLE: estado, claim,
//! Events en orden y Attention. Los proveedores son los dos del registro de pruebas: `claude` (completo) y `codex` (sin `resume`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::adapter::fake::{FakeAdapter, Step};
use super::adapter::{AdapterError, Capability, CapabilityMatrix, CapabilityState, ProbeResult};
use super::adapter_launcher::AdapterLauncher;
use super::adapter_launcher_tests::{registry_of, repo_with_commit, worktree_state};
use super::dispatch_tests::{event_count, row};
use super::events::{Channel, MutationContext};
use super::initial_approval_tests::e2e::core_with_project_at;
use super::tx_ops::RetrySelection;
use super::{Caller, Core};

struct World {
    core: Arc<Core>,
    project: String,
    adapter: Arc<FakeAdapter>,
}

/// Un Core persistente con un Project en un repositorio real y el lanzador real sobre UN adapter falso con guion.
fn world(provider: &str, script: Option<Vec<Step>>) -> World {
    let repo = repo_with_commit();
    let (core, _client, _ctx, project) = core_with_project_at(&repo.to_string_lossy());
    let adapter = Arc::new(if provider == "codex" {
        let sin_resume = ProbeResult::ready(Some("0.0.0-fake"), CapabilityMatrix::all_available().with(Capability::Resume, CapabilityState::Unsupported));
        FakeAdapter::with_probe("codex", sin_resume)
    } else {
        FakeAdapter::full(provider)
    });
    if let Some(script) = script {
        adapter.set_script(script);
    }
    core.install_launcher(Arc::new(AdapterLauncher::new(&core, registry_of(adapter.clone()))));
    // El preflight de `task_create` mira el registro propio del Core (adapters falsos en pruebas).
    core.provider_registry.probe_all();
    World { core, project, adapter }
}

impl World {
    /// Como Desktop: Person autenticada por el canal de la interfaz.
    fn desktop(&self, cmd: &str, args: Value) -> Result<Value, String> {
        self.core.rpc_via(Channel::Ui, Caller::User, "", cmd, &args)
    }

    fn create(&self, provider: &str, request_id: &str) -> String {
        let created = self
            .desktop(
                "task_create",
                json!({"request_id": request_id, "project_id": self.project, "objective": "o", "title": "t", "spec": "haz algo", "attempt": {"provider": provider, "profile": "explorar"}}),
            )
            .expect("task_create");
        assert_eq!(created["status"], "Committed");
        created["attempt_id"].as_str().unwrap().to_string()
    }

    fn approve(&self, attempt: &str) {
        assert_eq!(self.desktop("attempt_approve", json!({"attempt_id": attempt})).unwrap()["status"], "Approved");
    }

    fn settled(&self, attempt: &str, status: &str) {
        wait_until(&format!("el Attempt llega a {status}"), || row(&self.core, attempt).0 == status);
        wait_until("el claim se asienta", || row(&self.core, attempt).1 == "settled");
    }
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(15);
    while !condition() {
        assert!(Instant::now() < end, "no se cumplió a tiempo: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Los kinds de los Events del Attempt, en el orden en que quedaron en el log.
fn kinds(core: &Core, attempt: &str) -> Vec<String> {
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

/// (categoría, estado) de cada Attention del Attempt, en el orden en que nacieron.
fn attention(core: &Core, attempt: &str) -> Vec<(String, String)> {
    core.storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT category, status FROM attention_items WHERE target_id LIKE ?1 || '%' ORDER BY rowid")?;
                let rows = stmt.query_map([attempt], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
        })
        .unwrap()
        .unwrap()
}

fn attempt_provider(core: &Core, attempt: &str) -> String {
    core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT provider FROM attempts WHERE id = ?1", [attempt], |r| r.get::<_, String>(0))?))).unwrap().unwrap()
}

/// El payload del `attempt.retried` del Attempt.
fn retried_payload(core: &Core, attempt: &str) -> Value {
    let text: String = core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT payload FROM events WHERE kind = 'attempt.retried' AND entity_id = ?1", [attempt], |r| r.get(0))?))).unwrap().unwrap();
    serde_json::from_str(&text).unwrap()
}

fn ordered(actual: &[String], expected: &[&str]) {
    let positions: Vec<usize> = expected.iter().map(|kind| actual.iter().position(|k| k == kind).unwrap_or_else(|| panic!("falta {kind} en {actual:?}"))).collect();
    assert!(positions.windows(2).all(|w| w[0] < w[1]), "fuera de orden: {actual:?}");
}

#[test]
fn claude_crear_aprobar_y_completar_deja_los_hechos_en_orden_y_ninguna_attention_activa() {
    let w = world("claude", None);
    let attempt = w.create("claude", "e2e-claude-ok");

    // Recién creado: espera a la persona, con su Attention de aprobación a la vista y nada lanzado.
    assert_eq!(row(&w.core, &attempt).0, "pending_approval");
    assert_eq!(attention(&w.core, &attempt), vec![("approval".to_string(), "active".to_string())]);
    assert!(w.adapter.starts().is_empty(), "crear no lanza nada");

    w.approve(&attempt);
    w.settled(&attempt, "done");

    assert_eq!(row(&w.core, &attempt), ("done".into(), "settled".into(), None));
    ordered(&kinds(&w.core, &attempt), &["attempt.requested", "attempt.approved", "attempt.started", "attempt.completed"]);
    assert_eq!(w.adapter.starts().len(), 1, "el proveedor se lanzó UNA vez");
    assert_eq!(attempt_provider(&w.core, &attempt), "claude");
    assert_eq!(worktree_state(&w.core, &attempt).as_deref(), Some("active"), "el trabajo queda en su worktree");
    // La aprobación se resolvió al decidir: no queda nada pendiente de la persona.
    assert!(attention(&w.core, &attempt).iter().all(|(_, status)| status == "resolved"), "{:?}", attention(&w.core, &attempt));
}

#[test]
fn codex_sin_resume_crea_aprueba_y_completa_igual() {
    let w = world("codex", None);
    let attempt = w.create("codex", "e2e-codex-ok");
    w.approve(&attempt);
    w.settled(&attempt, "done");

    assert_eq!(attempt_provider(&w.core, &attempt), "codex");
    assert_eq!(w.adapter.starts().len(), 1);
    ordered(&kinds(&w.core, &attempt), &["attempt.requested", "attempt.approved", "attempt.started", "attempt.completed"]);
}

#[test]
fn un_proveedor_que_falla_deja_el_attempt_failed_con_su_motivo_y_una_attention_failed() {
    let w = world("claude", Some(vec![Step::Output("empiezo".into()), Step::Fail(AdapterError::provider("el proveedor se cayó"))]));
    let attempt = w.create("claude", "e2e-claude-fail");
    w.approve(&attempt);
    w.settled(&attempt, "failed");

    assert_eq!(row(&w.core, &attempt), ("failed".into(), "settled".into(), Some("agent_reported".into())));
    ordered(&kinds(&w.core, &attempt), &["attempt.requested", "attempt.approved", "attempt.started", "attempt.failed"]);
    assert_eq!(event_count(&w.core, &attempt, "attempt.completed"), 0);
    // El fallo queda a la vista de la persona; la aprobación inicial, ya resuelta.
    assert!(attention(&w.core, &attempt).contains(&("failed".to_string(), "active".to_string())), "{:?}", attention(&w.core, &attempt));
    assert!(attention(&w.core, &attempt).iter().filter(|(c, _)| c == "approval").all(|(_, s)| s == "resolved"));
}

#[test]
fn rechazar_el_primer_attempt_no_lanza_nada_ni_crea_worktree() {
    let w = world("codex", None);
    let attempt = w.create("codex", "e2e-codex-reject");

    let rejected = w.desktop("attempt_reject", json!({"attempt_id": attempt})).unwrap();
    assert_eq!(rejected["status"], "Rejected");

    assert_eq!(row(&w.core, &attempt).0, "stopped");
    ordered(&kinds(&w.core, &attempt), &["attempt.requested", "attempt.rejected"]);
    assert_eq!(event_count(&w.core, &attempt, "attempt.approved"), 0);
    assert_eq!(event_count(&w.core, &attempt, "attempt.started"), 0);
    assert!(w.adapter.starts().is_empty(), "un intento rechazado nunca llega al proveedor");
    assert_eq!(worktree_state(&w.core, &attempt), None, "ni worktree");
    assert!(attention(&w.core, &attempt).iter().all(|(_, status)| status == "resolved"));

    // Decidir lo contrario después se rechaza con un error, sin tocar nada.
    assert!(w.desktop("attempt_approve", json!({"attempt_id": attempt})).unwrap_err().contains("rechazado"));
    assert_eq!(row(&w.core, &attempt).0, "stopped");
}

#[test]
fn detener_una_ejecucion_viva_la_deja_stopped_y_sin_attention_de_fallo() {
    let w = world("claude", Some(vec![Step::Output("trabajando".into()), Step::Wait]));
    let attempt = w.create("claude", "e2e-claude-stop");
    w.approve(&attempt);
    wait_until("el Attempt corre", || row(&w.core, &attempt).0 == "running");

    let task = attempt.rsplit_once("-a").unwrap().0.to_string();
    // `running` se registra antes que la ejecución viva: se espera a que exista para poder detenerla.
    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    assert_eq!(w.core.kill_term(&task), Ok(true));
    w.settled(&attempt, "stopped");

    assert_eq!(row(&w.core, &attempt), ("stopped".into(), "settled".into(), None));
    assert_eq!(event_count(&w.core, &attempt, "attempt.failed"), 0);
    assert!(!attention(&w.core, &attempt).iter().any(|(c, s)| c == "failed" && s == "active"));
}

/// Puente del reintento (proyecto LXO-142, PR 1): `Tx::request_attempt_retry` pone la Task final de vuelta en `starting` y nace
/// el Attempt n+1 con el claim `none`; el despachador de siempre lo lanza SIN aprobación (las continuaciones n > 1 no la piden).
#[test]
fn reintentar_un_attempt_fallido_crea_el_n_mas_1_y_el_despachador_lo_lanza_sin_aprobacion() {
    let w = world("claude", Some(vec![Step::Output("empiezo".into()), Step::Fail(AdapterError::provider("el proveedor se cayó"))]));
    let a1 = w.create("claude", "e2e-claude-retry");
    w.approve(&a1);
    w.settled(&a1, "failed");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let a2 = format!("{task}-a2");

    // La segunda ejecución sí completa.
    w.adapter.set_script(vec![Step::Output("ahora sí".into()), Step::Complete(Some("hecho".into()))]);
    let person = w.core.desktop_mutation_context().unwrap();
    w.core.mutate_as(&person, |tx| tx.request_attempt_retry(&task, &RetrySelection::default())).expect("la petición de reintento");

    // El Attempt nuevo existe, espera a ser despachado y no pide aprobación; el anterior no se tocó.
    assert_eq!(row(&w.core, &a2), ("starting".into(), "none".into(), None));
    assert_eq!(row(&w.core, &a1), ("failed".into(), "settled".into(), Some("agent_reported".into())));
    assert_eq!(event_count(&w.core, &a2, "attempt.requested"), 1);
    assert_eq!(event_count(&w.core, &a2, "attempt.approved"), 0, "un reintento no pide aprobación: la petición es la decisión");
    // La procedencia nace con el Attempt, en la misma mutación, y atiende el fallo del anterior.
    ordered(&kinds(&w.core, &a2), &["attempt.requested", "attempt.retried"]);
    let retried = retried_payload(&w.core, &a2);
    assert_eq!((retried["task"].as_str(), retried["n"].as_i64(), retried["from_n"].as_i64()), (Some(task.as_str()), Some(2), Some(1)));
    assert!(retried.get("overrides").is_none(), "no se pidió nada distinto: se heredó todo");
    let anterior = attention(&w.core, &a1);
    assert!(anterior.contains(&("failed".to_string(), "resolved".to_string())) && !anterior.contains(&("failed".to_string(), "active".to_string())), "el failed del anterior queda atendido: {anterior:?}");
    assert_eq!(attempt_provider(&w.core, &a2), "claude");
    assert_eq!(w.adapter.starts().len(), 1, "pedirlo no lanza nada");

    let launcher = w.core.launcher().expect("lanzador instalado");
    assert_eq!(w.core.dispatch_attempt(&a2, launcher.as_ref()).unwrap(), super::dispatch::DispatchResult::Launched);
    w.settled(&a2, "done");

    assert_eq!(row(&w.core, &a2), ("done".into(), "settled".into(), None));
    ordered(&kinds(&w.core, &a2), &["attempt.requested", "attempt.started", "attempt.completed"]);
    assert_eq!(w.adapter.starts().len(), 2, "el proveedor se lanzó una vez por Attempt");
    // El reintento trabaja en el Worktree de la Task (el proyector admite uno por Task): se adjunta a él, no crea otro.
    let linked = |attempt: &str| -> Option<String> {
        w.core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT worktree_id FROM attempts WHERE id = ?1", [attempt], |r| r.get::<_, Option<String>>(0))?))).unwrap().unwrap()
    };
    assert_eq!(linked(&a2), linked(&a1), "los dos Attempts trabajan en el mismo Worktree");
    let worktrees: i64 = w.core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM worktrees WHERE task_id = ?1", [&task], |r| r.get(0))?))).unwrap().unwrap();
    assert_eq!(worktrees, 1, "no se creó otro Worktree");
    assert_eq!(worktree_state(&w.core, &a1).as_deref(), Some("active"), "el Worktree sigue activo");
    // Despachar otra vez no relanza: el claim es de un solo uso.
    assert_eq!(w.core.dispatch_attempt(&a2, launcher.as_ref()).unwrap(), super::dispatch::DispatchResult::AlreadyClaimed);
    assert_eq!(w.adapter.starts().len(), 2);
}

/// Sin carpeta donde reintentar (el Worktree de la Task ya no está en disco) el Attempt nuevo se cierra `stopped`, nunca `failed`:
/// no es un fallo del agente y no se crea otro Worktree (el proyector no lo admitiría).
#[test]
fn reintentar_sin_el_worktree_de_la_task_deja_el_attempt_nuevo_stopped_y_no_crea_otro() {
    let w = world("claude", Some(vec![Step::Fail(AdapterError::provider("el proveedor se cayó"))]));
    let a1 = w.create("claude", "e2e-claude-retry-sin-worktree");
    w.approve(&a1);
    w.settled(&a1, "failed");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let a2 = format!("{task}-a2");
    let dir: String = w.core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT path FROM worktrees WHERE attempt_id = ?1", [&a1], |r| r.get(0))?))).unwrap().unwrap();
    // La carpeta desaparece (una limpieza, el usuario): el registro de la Task sigue, sin su carpeta.
    std::fs::remove_dir_all(&dir).expect("quitar la carpeta del Worktree");

    let person = w.core.desktop_mutation_context().unwrap();
    w.core.mutate_as(&person, |tx| tx.request_attempt_retry(&task, &RetrySelection::default())).expect("la petición se acepta");
    let launcher = w.core.launcher().expect("lanzador instalado");
    assert_eq!(w.core.dispatch_attempt(&a2, launcher.as_ref()).unwrap(), super::dispatch::DispatchResult::NotLaunched { stopped: true });

    assert_eq!(row(&w.core, &a2), ("stopped".into(), "settled".into(), None));
    assert_eq!(event_count(&w.core, &a2, "attempt.failed"), 0);
    assert_eq!(w.adapter.starts().len(), 1, "el proveedor no se lanzó otra vez");
    let worktrees: i64 = w.core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM worktrees WHERE task_id = ?1", [&task], |r| r.get(0))?))).unwrap().unwrap();
    assert_eq!(worktrees, 1, "no se creó otro Worktree");
}

/// Solo una Person pide el reintento y solo de un Attempt que terminó mal; cambiar de proveedor no arrastra su modelo.
#[test]
fn reintentar_solo_lo_pide_una_person_y_solo_de_un_attempt_que_termino_mal() {
    let w = world("claude", Some(vec![Step::Output("trabajando".into()), Step::Wait]));
    let a1 = w.create("claude", "e2e-claude-retry-rules");
    w.approve(&a1);
    wait_until("el Attempt corre", || row(&w.core, &a1).0 == "running");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let person = w.core.desktop_mutation_context().unwrap();

    // En marcha no se reintenta.
    let err = w.core.mutate_as(&person, |tx| tx.request_attempt_retry(&task, &RetrySelection::default())).unwrap_err().to_string();
    assert!(err.contains("terminó mal"), "{err}");
    // Detenido sí, pero no por quien no es una Person autenticada.
    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    w.desktop("stop", json!({"task": task})).expect("stop");
    w.settled(&a1, "stopped");
    let err = w.core.mutate_as(&MutationContext::core(), |tx| tx.request_attempt_retry(&task, &RetrySelection::default())).unwrap_err().to_string();
    assert!(err.contains("Person autenticada"), "{err}");
    assert_eq!(event_count(&w.core, &format!("{task}-a2"), "attempt.requested"), 0, "una petición rechazada no crea nada");

    // Con otro proveedor, el modelo y el esfuerzo del anterior no se heredan; el perfil sí.
    let selection = RetrySelection { provider: Some("codex".into()), ..RetrySelection::default() };
    w.core.mutate_as(&person, |tx| tx.request_attempt_retry(&task, &selection)).expect("reintento con otro proveedor");
    let a2 = format!("{task}-a2");
    assert_eq!(attempt_provider(&w.core, &a2), "codex");
    assert_eq!(retried_payload(&w.core, &a2)["overrides"], json!(["provider"]), "solo se pidió otro proveedor");
    let (model, profile): (Option<String>, Option<String>) = w
        .core
        .storage
        .with_store(|s| s.read(|c| Ok(c.query_row("SELECT model, profile FROM attempts WHERE id = ?1", [&a2], |r| Ok((r.get(0)?, r.get(1)?)))?)))
        .unwrap()
        .unwrap();
    assert_eq!((model, profile.as_deref()), (None, Some("explorar")));
}

/// El botón «Detener» del ADE llama al RPC `stop` con la Task del intento: la entrada de Desktop, no `kill_term` directo.
#[test]
fn detener_por_el_rpc_de_desktop_deja_el_attempt_stopped_y_el_claim_asentado() {
    let w = world("claude", Some(vec![Step::Output("trabajando".into()), Step::Wait]));
    let attempt = w.create("claude", "e2e-claude-rpc-stop");
    w.approve(&attempt);
    wait_until("el Attempt corre", || row(&w.core, &attempt).0 == "running");
    let task = attempt.rsplit_once("-a").unwrap().0.to_string();
    wait_until("la ejecución está registrada", || w.core.has_term(&task));

    let stopped = w.desktop("stop", json!({"task": task})).expect("stop");
    assert_eq!(stopped["status"], "stopped");
    w.settled(&attempt, "stopped");

    assert_eq!(row(&w.core, &attempt), ("stopped".into(), "settled".into(), None));
    assert_eq!(event_count(&w.core, &attempt, "attempt.failed"), 0);
    assert!(!w.core.has_term(&task), "el proceso del proveedor ya no está");
    assert!(!attention(&w.core, &attempt).iter().any(|(c, s)| c == "failed" && s == "active"));
    // Detenerla otra vez no inventa un segundo cierre.
    assert_eq!(event_count(&w.core, &attempt, "attempt.stopped"), 1);
}

/// A5/A6 · ¿El diff y la revisión de la interfaz (comandos `orch_task_diff` / `orch_review_task`) alcanzan a una Task creada
/// por `task_create`? Con el trabajo ya confirmado en su rama, el diff lo ve y la revisión queda sobre ese commit.
#[test]
fn el_diff_y_la_revision_de_desktop_alcanzan_la_task_creada_por_task_create() {
    let w = world("claude", Some(vec![Step::Wait]));
    let attempt = w.create("claude", "e2e-claude-diff");
    w.approve(&attempt);
    wait_until("el Attempt corre", || row(&w.core, &attempt).0 == "running");
    let task = attempt.rsplit_once("-a").unwrap().0.to_string();
    let (path, branch): (String, String) = w
        .core
        .storage
        .with_store(|s| s.read(|c| Ok(c.query_row("SELECT path, branch FROM worktrees WHERE attempt_id = ?1", [&attempt], |r| Ok((r.get(0)?, r.get(1)?))).unwrap())))
        .unwrap()
        .unwrap();
    let dir = std::path::Path::new(&path);
    std::fs::write(dir.join("nuevo.txt"), "hola
").unwrap();
    for args in [vec!["add", "."], vec!["-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-qm", "trabajo"]] {
        assert!(std::process::Command::new("git").args(&args).current_dir(dir).output().unwrap().status.success());
    }

    let diff = w.core.task_diff_from_ui(&task).expect("el diff de la Task");
    assert_eq!(diff["branch"], branch.as_str());
    assert_eq!(diff["files"][0]["path"], "nuevo.txt");
    let head = diff["head_commit"].as_str().unwrap().to_string();

    let reviewed = w.core.review_from_ui(&task, "accepted", &head, None, true).expect("la revisión");
    assert_eq!(reviewed["outcome"], "recorded");
    assert_eq!(reviewed["head_commit"], head.as_str());
}

#[test]
fn repetir_la_misma_solicitud_no_duplica_la_task_ni_el_lanzamiento() {
    let w = world("claude", None);
    let first = w.create("claude", "e2e-claude-idem");
    let again = w
        .desktop("task_create", json!({"request_id": "e2e-claude-idem", "project_id": w.project, "objective": "o", "title": "t", "spec": "haz algo", "attempt": {"provider": "claude", "profile": "explorar"}}))
        .unwrap();
    assert_eq!(again["status"], "Replayed");
    assert_eq!(again["attempt_id"], first.as_str());

    w.approve(&first);
    w.settled(&first, "done");
    assert_eq!(w.adapter.starts().len(), 1);
    // Aprobar otra vez es un replay, no un segundo lanzamiento.
    let replay = w.desktop("attempt_approve", json!({"attempt_id": first})).unwrap();
    assert_eq!(replay["status"], "Replayed");
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(w.adapter.starts().len(), 1);
}
