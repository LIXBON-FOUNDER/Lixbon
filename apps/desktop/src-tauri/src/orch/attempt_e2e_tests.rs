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

pub(super) struct World {
    pub(super) core: Arc<Core>,
    pub(super) project: String,
    pub(super) adapter: Arc<FakeAdapter>,
}

/// Un Core persistente con un Project en un repositorio real y el lanzador real sobre UN adapter falso con guion.
pub(super) fn world(provider: &str, script: Option<Vec<Step>>) -> World {
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
    pub(super) fn desktop(&self, cmd: &str, args: Value) -> Result<Value, String> {
        self.core.rpc_via(Channel::Ui, Caller::User, "", cmd, &args)
    }

    pub(super) fn create(&self, provider: &str, request_id: &str) -> String {
        let created = self
            .desktop(
                "task_create",
                json!({"request_id": request_id, "project_id": self.project, "objective": "o", "title": "t", "spec": "haz algo", "attempt": {"provider": provider, "profile": "explorar"}}),
            )
            .expect("task_create");
        assert_eq!(created["status"], "Committed");
        created["attempt_id"].as_str().unwrap().to_string()
    }

    pub(super) fn approve(&self, attempt: &str) {
        assert_eq!(self.desktop("attempt_approve", json!({"attempt_id": attempt})).unwrap()["status"], "Approved");
    }

    pub(super) fn settled(&self, attempt: &str, status: &str) {
        wait_until(&format!("el Attempt llega a {status}"), || row(&self.core, attempt).0 == status);
        wait_until("el claim se asienta", || row(&self.core, attempt).1 == "settled");
    }
}

pub(super) fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(15);
    while !condition() {
        assert!(Instant::now() < end, "no se cumplió a tiempo: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Los kinds de los Events del Attempt, en el orden en que quedaron en el log.
pub(super) fn kinds(core: &Core, attempt: &str) -> Vec<String> {
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
pub(super) fn attention(core: &Core, attempt: &str) -> Vec<(String, String)> {
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

/// PR 3 del puente: el RPC `attempt_retry` por la entrada autenticada de Desktop. Pedirlo no lanza nada por sí mismo: despierta al
/// despachador, que recoge el reintento en su barrido. Repetir la petición devuelve el mismo Attempt y no lanza otra vez.
#[test]
fn el_rpc_attempt_retry_reintenta_y_el_despachador_lo_lanza_solo_una_vez() {
    let w = world("claude", Some(vec![Step::Output("empiezo".into()), Step::Fail(AdapterError::provider("el proveedor se cayó"))]));
    let a1 = w.create("claude", "e2e-claude-rpc-retry");
    w.approve(&a1);
    w.settled(&a1, "failed");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let a2 = format!("{task}-a2");
    w.adapter.set_script(vec![Step::Output("ahora sí".into()), Step::Complete(Some("hecho".into()))]);

    let out = w.desktop("attempt_retry", json!({"task_id": task, "from_attempt_id": a1})).expect("el reintento");
    assert_eq!((out["status"].as_str(), out["attempt_id"].as_str(), out["task_id"].as_str()), (Some("Requested"), Some(a2.as_str()), Some(task.as_str())));
    w.settled(&a2, "done");
    ordered(&kinds(&w.core, &a2), &["attempt.requested", "attempt.retried", "attempt.started", "attempt.completed"]);
    assert_eq!(event_count(&w.core, &a2, "attempt.approved"), 0, "un reintento no pide aprobación");
    assert_eq!(w.adapter.starts().len(), 2, "el proveedor se lanzó una vez por Attempt");

    // Repetir la petición (doble clic, reintento de red) devuelve ese mismo Attempt y no abre otro ni lanza de nuevo.
    let again = w.desktop("attempt_retry", json!({"task_id": task, "from_attempt_id": a1})).expect("la repetición");
    assert_eq!((again["status"].as_str(), again["attempt_id"].as_str()), (Some("Replayed"), Some(a2.as_str())));
    assert_eq!(event_count(&w.core, &format!("{task}-a3"), "attempt.requested"), 0);
    assert_eq!(w.adapter.starts().len(), 2);
}

/// Lo que el RPC rechaza: no es el último, no terminó mal, un perfil, un agente, y sin lanzador. Nada de eso crea un Attempt.
#[test]
fn el_rpc_attempt_retry_rechaza_lo_que_no_debe_y_no_crea_nada() {
    let w = world("claude", Some(vec![Step::Output("trabajando".into()), Step::Wait]));
    let a1 = w.create("claude", "e2e-claude-rpc-retry-rechazos");
    w.approve(&a1);
    wait_until("el Attempt corre", || row(&w.core, &a1).0 == "running");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let a2 = format!("{task}-a2");
    let retry = |args: Value| w.desktop("attempt_retry", args);
    let creados = || event_count(&w.core, &a2, "attempt.requested");

    // En marcha no se reintenta.
    let err = retry(json!({"task_id": task, "from_attempt_id": a1})).unwrap_err();
    assert!(err.contains("terminó mal"), "{err}");
    // Un Attempt que no es el último, uno de otra Task, un id mal formado.
    assert!(retry(json!({"task_id": task, "from_attempt_id": format!("{task}-a7")})).unwrap_err().contains("último"));
    assert!(retry(json!({"task_id": task, "from_attempt_id": "otra-a1"})).unwrap_err().contains("no es de la Task"));
    assert!(retry(json!({"task_id": task, "from_attempt_id": "basura"})).is_err());

    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    w.desktop("stop", json!({"task": task})).expect("stop");
    w.settled(&a1, "stopped");
    // Con el Attempt detenido, tampoco con un perfil (el perfil se hereda: un reintento nunca amplía permisos) ni con valores vacíos.
    assert!(retry(json!({"task_id": task, "from_attempt_id": a1, "profile": "autonomia_amplia"})).is_err());
    assert!(retry(json!({"task_id": task, "from_attempt_id": a1, "model": "  "})).is_err());
    // Un agente no reintenta: es una decisión de la persona.
    assert!(w.core.rpc(Caller::Agent(Some(task.clone())), "", "attempt_retry", &json!({"task_id": task, "from_attempt_id": a1})).is_err());
    // Sin lanzador (Orquestador desactivado) se dice y no se escribe nada.
    let launcher = w.core.launcher.lock().unwrap().take();
    let err = retry(json!({"task_id": task, "from_attempt_id": a1})).unwrap_err();
    assert!(err.contains("lifecycle de lanzamiento verificado"), "{err}");
    *w.core.launcher.lock().unwrap() = launcher;
    assert_eq!(creados(), 0, "ninguna petición rechazada crea un Attempt");
}

/// Si Lixbon cae entre pedir el reintento y despacharlo, el barrido periódico lo recoge (lleva `attempt.retried`): no se queda
/// `starting` para siempre.
#[test]
fn el_barrido_recoge_un_reintento_que_nadie_despacho() {
    let w = world("claude", Some(vec![Step::Fail(AdapterError::provider("el proveedor se cayó"))]));
    let a1 = w.create("claude", "e2e-claude-barrido-reintento");
    w.approve(&a1);
    w.settled(&a1, "failed");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let a2 = format!("{task}-a2");
    w.adapter.set_script(vec![Step::Output("ahora sí".into()), Step::Complete(Some("hecho".into()))]);

    // La petición confirma el Attempt y NADIE despierta al despachador.
    let person = w.core.desktop_mutation_context().unwrap();
    w.core.mutate_as(&person, |tx| tx.request_attempt_retry(&task, &RetrySelection::default())).unwrap();
    assert_eq!(row(&w.core, &a2), ("starting".into(), "none".into(), None));

    w.core.dispatch_waiting_approved();
    w.settled(&a2, "done");
    assert_eq!(w.adapter.starts().len(), 2);
}

/// La ProviderSession a la que está enlazado un Attempt (`None` si no tiene).
fn linked_session(core: &Core, attempt: &str) -> Option<String> {
    core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT provider_session_id FROM attempts WHERE id = ?1", [attempt], |r| r.get::<_, Option<String>>(0))?))).unwrap().unwrap()
}

/// PR 4 del puente: `attempt_resume` continúa la ProviderSession de un Attempt terminado. El Attempt nuevo se enlaza a la MISMA sesión y el
/// despachador lo lanza con `resume` (con la referencia y el mensaje), no con `start`. Repetir la petición devuelve el mismo Attempt.
#[test]
fn el_rpc_attempt_resume_continua_la_sesion_y_el_despachador_la_reanuda_una_sola_vez() {
    let w = world("claude", Some(vec![Step::Bind("sess-1"), Step::Output("hecho".into()), Step::Complete(Some("hecho".into()))]));
    let a1 = w.create("claude", "e2e-claude-rpc-resume");
    w.approve(&a1);
    w.settled(&a1, "done");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let a2 = format!("{task}-a2");
    w.adapter.set_script(vec![Step::Output("sigo".into()), Step::Complete(Some("seguido".into()))]);

    let out = w.desktop("attempt_resume", json!({"task_id": task, "from_attempt_id": a1, "prompt": "sigue con la parte dos"})).expect("la continuación");
    assert_eq!((out["status"].as_str(), out["attempt_id"].as_str(), out["task_id"].as_str()), (Some("Requested"), Some(a2.as_str()), Some(task.as_str())));
    w.settled(&a2, "done");

    // Se REANUDÓ (no se arrancó de cero) con la referencia de la sesión y el mensaje nuevo, no con el spec entero.
    let resumes = w.adapter.resumes();
    assert_eq!(resumes.len(), 1, "el adapter recibió una reanudación");
    assert_eq!(resumes[0].provider_ref.expose(), "sess-1");
    assert_eq!(resumes[0].prompt.as_deref(), Some("sigue con la parte dos"));
    assert_eq!(resumes[0].attempt_id, a2);
    assert_eq!(w.adapter.starts().len(), 1, "solo el primer Attempt arrancó de cero");

    // La procedencia, en orden y atendida en la misma mutación; sin aprobación; ambos Attempts en la misma sesión.
    ordered(&kinds(&w.core, &a2), &["attempt.requested", "attempt.continued", "attempt.started", "attempt.completed"]);
    assert_eq!(event_count(&w.core, &a2, "attempt.approved"), 0, "continuar no pide aprobación: la petición es la decisión");
    assert!(linked_session(&w.core, &a1).is_some());
    assert_eq!(linked_session(&w.core, &a1), linked_session(&w.core, &a2), "los dos Attempts comparten la ProviderSession");
    assert_eq!(row(&w.core, &a2), ("done".into(), "settled".into(), None));

    // Repetir la petición devuelve ese mismo Attempt y no reanuda de nuevo.
    let again = w.desktop("attempt_resume", json!({"task_id": task, "from_attempt_id": a1, "prompt": "sigue con la parte dos"})).expect("la repetición");
    assert_eq!((again["status"].as_str(), again["attempt_id"].as_str()), (Some("Replayed"), Some(a2.as_str())));
    assert_eq!(w.adapter.resumes().len(), 1);
}

/// Lo que `attempt_resume` rechaza: en marcha, sin sesión, no es el último, mensaje vacío, proveedor o perfil, un agente y sin lanzador.
#[test]
fn el_rpc_attempt_resume_rechaza_lo_que_no_debe_y_no_crea_nada() {
    let w = world("claude", Some(vec![Step::Output("trabajando".into()), Step::Wait]));
    let a1 = w.create("claude", "e2e-claude-rpc-resume-rechazos");
    w.approve(&a1);
    wait_until("el Attempt corre", || row(&w.core, &a1).0 == "running");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let a2 = format!("{task}-a2");
    let resume = |args: Value| w.desktop("attempt_resume", args);
    let args = |extra: Value| {
        let mut base = json!({"task_id": task, "from_attempt_id": a1, "prompt": "sigue"});
        for (k, v) in extra.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    };

    // En marcha no se continúa.
    assert!(resume(args(json!({}))).unwrap_err().contains("terminado"));
    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    w.desktop("stop", json!({"task": task})).expect("stop");
    w.settled(&a1, "stopped");

    // Detenido pero sin sesión del proveedor (este intento nunca la entregó): no hay qué reanudar.
    assert!(resume(args(json!({}))).unwrap_err().contains("no tuvo una sesión"));
    // El resto, aunque hubiera sesión: no es el último, mensaje vacío, otro proveedor, un perfil, un agente.
    assert!(resume(args(json!({"from_attempt_id": format!("{task}-a7")}))).unwrap_err().contains("último"));
    assert!(resume(args(json!({"prompt": "   "}))).is_err());
    assert!(resume(args(json!({"provider": "codex"}))).is_err(), "una sesión no se comparte entre proveedores");
    assert!(resume(args(json!({"profile": "autonomia_amplia"}))).is_err(), "continuar nunca amplía los permisos");
    assert!(w.core.rpc(Caller::Agent(Some(task.clone())), "", "attempt_resume", &args(json!({}))).is_err());
    let launcher = w.core.launcher.lock().unwrap().take();
    assert!(resume(args(json!({}))).unwrap_err().contains("lifecycle de lanzamiento verificado"));
    *w.core.launcher.lock().unwrap() = launcher;
    assert_eq!(event_count(&w.core, &a2, "attempt.requested"), 0, "ninguna petición rechazada crea un Attempt");
    assert!(w.adapter.resumes().is_empty());
}

/// Un proveedor sin `resume` (codex) no continúa: se dice ANTES de escribir nada, y nada se crea.
#[test]
fn el_rpc_attempt_resume_con_un_proveedor_sin_resume_se_rechaza_antes_de_escribir() {
    let w = world("codex", Some(vec![Step::Bind("sess-c"), Step::Complete(Some("hecho".into()))]));
    let a1 = w.create("codex", "e2e-codex-rpc-resume");
    w.approve(&a1);
    w.settled(&a1, "done");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();

    let err = w.desktop("attempt_resume", json!({"task_id": task, "from_attempt_id": a1, "prompt": "sigue"})).unwrap_err();
    assert!(err.contains("provider_resume_unsupported"), "{err}");
    assert_eq!(event_count(&w.core, &format!("{task}-a2"), "attempt.requested"), 0);
    assert_eq!(row(&w.core, &a1), ("done".into(), "settled".into(), None), "el Attempt anterior no se tocó");
}

/// Si Lixbon cae entre pedir la continuación y despacharla, el barrido la recoge (lleva `attempt.continued`) y la REANUDA.
#[test]
fn el_barrido_recoge_una_continuacion_que_nadie_despacho_y_la_reanuda() {
    let w = world("claude", Some(vec![Step::Bind("sess-2"), Step::Complete(Some("hecho".into()))]));
    let a1 = w.create("claude", "e2e-claude-barrido-resume");
    w.approve(&a1);
    w.settled(&a1, "done");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let a2 = format!("{task}-a2");
    w.adapter.set_script(vec![Step::Output("sigo".into()), Step::Complete(Some("seguido".into()))]);

    let person = w.core.desktop_mutation_context().unwrap();
    w.core.mutate_as(&person, |tx| tx.request_attempt_continuation(&task, "continúa", &RetrySelection::default())).unwrap();
    assert_eq!(row(&w.core, &a2), ("starting".into(), "none".into(), None));

    w.core.dispatch_waiting_approved();
    w.settled(&a2, "done");
    assert_eq!(w.adapter.resumes().len(), 1);
    assert_eq!(w.adapter.resumes()[0].provider_ref.expose(), "sess-2");
}

/// (queue_id, estado, motivo del fallo, quién confirmó) de la cola del Attempt, en orden FIFO.
fn queue_rows(core: &Core, attempt: &str) -> Vec<(String, String, Option<String>, Option<String>)> {
    core.storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT queue_id, status, failure_reason, confirmed_by FROM attempt_queue WHERE attempt_id = ?1 ORDER BY seq")?;
                let rows = stmt.query_map([attempt], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
        })
        .unwrap()
        .unwrap()
}

fn attempt_summary(core: &Core, attempt: &str) -> String {
    core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT summary FROM attempts WHERE id = ?1", [attempt], |r| r.get::<_, String>(0))?))).unwrap().unwrap()
}

/// LXO-143 · la cola de instrucciones por el RPC de Desktop. Encolar no entrega nada: el Attempt está en mitad de un turno. En cada fin
/// de turno el bombeo entrega la primera REANUDANDO la misma sesión, y el Attempt sigue `running` entre turnos: `completed` llega
/// solo cuando la cola se vacía. FIFO, idempotente por `request_id`, lo cancelado no se entrega jamás.
#[test]
fn la_cola_entrega_en_fifo_reanudando_la_sesion_y_el_attempt_termina_al_vaciarse() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-q"), Step::Output("uno".into()), Step::Hold, Step::Complete(Some("uno".into()))]);
    w.adapter.push_turn(vec![Step::Output("dos".into()), Step::Complete(Some("dos".into()))]);
    w.adapter.push_turn(vec![Step::Output("tres".into()), Step::Complete(Some("tres".into()))]);
    let a1 = w.create("claude", "e2e-queue-fifo");
    w.approve(&a1);
    wait_until("el Attempt corre", || row(&w.core, &a1).0 == "running");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let queue = |request_id: &str, body: &str| w.desktop("attempt_queue", json!({"attempt_id": a1, "request_id": request_id, "body": body}));

    let q1 = queue("r1", "segunda instrucción").expect("encolar la primera");
    assert_eq!((q1["status"].as_str(), q1["queue_id"].as_str(), q1["position"].as_i64()), (Some("Queued"), Some(format!("{a1}-q1").as_str()), Some(1)));
    assert_eq!(queue("r2", "tercera instrucción").unwrap()["position"], 2);
    assert_eq!(queue("r3", "cuarta (se cancela)").unwrap()["position"], 3);
    assert!(w.adapter.resumes().is_empty(), "encolar no entrega nada: el turno sigue en curso");

    // Repetir la petición devuelve el mismo item; reutilizar la clave para otra instrucción es un conflicto; nada se duplica.
    let again = queue("r1", "segunda instrucción").unwrap();
    assert_eq!((again["status"].as_str(), again["queue_id"].as_str()), (Some("Replayed"), Some(format!("{a1}-q1").as_str())));
    assert!(queue("r1", "otra cosa").unwrap_err().contains("request_conflict"));
    assert_eq!(queue_rows(&w.core, &a1).len(), 3);

    // La Pending Queue: lo que sigue sin entregarse, en el orden en que se entregará.
    let pending = w.desktop("pending_queue", json!({"attempt_id": a1})).expect("la cola pendiente");
    let items = pending["items"].as_array().unwrap();
    assert_eq!(items.iter().map(|i| i["body"].as_str().unwrap()).collect::<Vec<_>>(), ["segunda instrucción", "tercera instrucción", "cuarta (se cancela)"]);
    assert_eq!(items.iter().map(|i| i["position"].as_i64().unwrap()).collect::<Vec<_>>(), [1, 2, 3]);

    // Cancelar antes de la entrega; repetirlo no escribe nada.
    let q3 = format!("{a1}-q3");
    assert_eq!(w.desktop("attempt_queue_cancel", json!({"queue_id": q3})).unwrap()["status"], "Cancelled");
    assert_eq!(w.desktop("attempt_queue_cancel", json!({"queue_id": q3})).unwrap()["status"], "AlreadyCancelled");

    w.adapter.release_hold();
    w.settled(&a1, "done");

    // Cada instrucción abrió su turno REANUDANDO la sesión, en orden, dentro del mismo Attempt; el proveedor solo arrancó una vez.
    let resumes = w.adapter.resumes();
    assert_eq!(resumes.iter().map(|r| r.prompt.as_deref().unwrap()).collect::<Vec<_>>(), ["segunda instrucción", "tercera instrucción"]);
    assert!(resumes.iter().all(|r| r.provider_ref.expose() == "sess-q" && r.attempt_id == a1));
    assert_eq!(w.adapter.starts().len(), 1);
    assert_eq!(
        queue_rows(&w.core, &a1),
        vec![
            (format!("{a1}-q1"), "delivered".into(), None, Some("adapter_result".into())),
            (format!("{a1}-q2"), "delivered".into(), None, Some("adapter_result".into())),
            (format!("{a1}-q3"), "cancelled".into(), None, None),
        ],
        "lo cancelado no se entrega jamás"
    );
    // UN solo Attempt, UN solo comienzo y UN solo cierre, que llega al final de la cola (con el resumen del último turno).
    assert_eq!(event_count(&w.core, &a1, "attempt.started"), 1);
    assert_eq!(event_count(&w.core, &a1, "attempt.completed"), 1);
    assert_eq!((event_count(&w.core, &a1, "attempt.queued"), event_count(&w.core, &a1, "attempt.queue_delivered"), event_count(&w.core, &a1, "attempt.queue_cancelled")), (3, 2, 1));
    assert_eq!(attempt_summary(&w.core, &a1), "tres");
    assert_eq!(w.core.lock().tasks.len(), 1, "no nació ningún Attempt ni Task nueva");
    let after = w.desktop("pending_queue", json!({"attempt_id": a1})).unwrap();
    assert_eq!(after["items"].as_array().unwrap().len(), 0);
    // Lo ya resuelto se ve en `finished`, en el orden en que se encoló, con lo que dijo el Core: entregada (confirmada por el adapter),
    // entregada y cancelada. Y de un item la interfaz nunca recibe la clave de idempotencia, su digest ni la instalación que lo envió.
    let finished = after["finished"].as_array().unwrap();
    assert_eq!(finished.iter().map(|i| (i["status"].as_str().unwrap(), i["confirmed_by"].as_str())).collect::<Vec<_>>(), [("delivered", Some("adapter_result")), ("delivered", Some("adapter_result")), ("cancelled", None)]);
    assert_eq!(finished.iter().map(|i| i["body"].as_str().unwrap()).collect::<Vec<_>>(), ["segunda instrucción", "tercera instrucción", "cuarta (se cancela)"]);
    for hidden in ["request_id", "request_digest", "client_id", "author_id", "attachments"] {
        assert!(finished.iter().chain(items.iter()).all(|i| i.get(hidden).is_none()), "{hidden} no sale en pending_queue");
    }
    // Terminado, no admite instrucciones.
    assert!(queue("r9", "tarde").unwrap_err().contains("attempt_final"));
    let _ = task;
}

/// Un fallo de la entrega no falla el Attempt: solo el item (`attempt.queue_failed`), y el Attempt termina bien.
#[test]
fn si_la_entrega_falla_el_item_falla_con_su_motivo_y_el_attempt_termina_bien() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-f"), Step::Hold, Step::Complete(Some("uno".into()))]);
    let a1 = w.create("claude", "e2e-queue-fallo");
    w.approve(&a1);
    wait_until("el Attempt corre", || row(&w.core, &a1).0 == "running");
    w.desktop("attempt_queue", json!({"attempt_id": a1, "request_id": "r1", "body": "esto no llegará"})).expect("encolar");
    w.adapter.fail_resume_with(Some(AdapterError::provider("el proveedor se cayó al reanudar")));
    w.adapter.release_hold();
    w.settled(&a1, "done");

    assert_eq!(queue_rows(&w.core, &a1), vec![(format!("{a1}-q1"), "failed".into(), Some("adapter_error".into()), None)]);
    assert_eq!(event_count(&w.core, &a1, "attempt.queue_failed"), 1);
    assert_eq!(event_count(&w.core, &a1, "attempt.queue_delivered"), 0, "sin confirmación del adapter no hay entrega");
    assert!(w.adapter.resumes().is_empty());
    assert_eq!(row(&w.core, &a1), ("done".into(), "settled".into(), None), "el Attempt termina bien: un fallo de entrega no lo falla");
}

/// Detener el Attempt con instrucciones en cola: lo pendiente ya no se entregará y falla con `attempt_ended` (sin Attention).
#[test]
fn detener_con_instrucciones_en_cola_las_deja_failed_attempt_ended_y_no_entrega_nada() {
    let w = world("claude", Some(vec![Step::Bind("sess-s"), Step::Output("trabajando".into()), Step::Wait]));
    let a1 = w.create("claude", "e2e-queue-stop");
    w.approve(&a1);
    wait_until("el Attempt corre", || row(&w.core, &a1).0 == "running");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    w.desktop("attempt_queue", json!({"attempt_id": a1, "request_id": "r1", "body": "no llegará"})).expect("encolar");
    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    w.desktop("stop", json!({"task": task})).expect("stop");
    w.settled(&a1, "stopped");
    // El cierre de la cola es parte del cierre del Attempt: se espera explícitamente en vez de suponer que ya ocurrió.
    wait_until("la cola del Attempt detenido se cierra", || queue_rows(&w.core, &a1).iter().all(|(_, status, _, _)| status != "queued"));

    assert_eq!(queue_rows(&w.core, &a1), vec![(format!("{a1}-q1"), "failed".into(), Some("attempt_ended".into()), None)]);
    assert!(w.adapter.resumes().is_empty());
    assert!(!attention(&w.core, &a1).iter().any(|(c, s)| c == "failed" && s == "active"), "attempt_ended no levanta Attention: el Attempt ya terminó");
}

/// Un proveedor sin `resume` (codex) no puede entregar en un fin de turno: encolar es un ERROR y no se escribe nada. Nunca se cae a Steer.
#[test]
fn encolar_con_un_proveedor_sin_resume_es_un_error_y_no_escribe_ni_cae_a_steer() {
    let w = world("codex", Some(vec![Step::Output("trabajando".into()), Step::Wait]));
    let a1 = w.create("codex", "e2e-queue-sin-resume");
    w.approve(&a1);
    wait_until("el Attempt corre", || row(&w.core, &a1).0 == "running");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();

    let err = w.desktop("attempt_queue", json!({"attempt_id": a1, "request_id": "r1", "body": "sigue"})).unwrap_err();
    assert!(err.contains("queue_unsupported"), "{err}");
    assert!(queue_rows(&w.core, &a1).is_empty(), "no se escribe nada");
    assert_eq!(event_count(&w.core, &a1, "attempt.queued"), 0);
    assert!(!w.adapter.calls().iter().any(|c| c.starts_with("steer")), "Queue nunca se convierte en Steer");
    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    w.desktop("stop", json!({"task": task})).expect("stop");
}

/// Lo que el RPC de la cola rechaza: un agente, un Attempt que no existe, una clave o un cuerpo inválidos, un campo que no existe.
#[test]
fn el_rpc_de_la_cola_rechaza_lo_que_no_debe_y_no_escribe() {
    let w = world("claude", Some(vec![Step::Bind("sess-r"), Step::Output("trabajando".into()), Step::Wait]));
    let a1 = w.create("claude", "e2e-queue-rechazos");
    w.approve(&a1);
    wait_until("el Attempt corre", || row(&w.core, &a1).0 == "running");
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let q = |args: Value| w.desktop("attempt_queue", args);

    assert!(q(json!({"attempt_id": "nadie-a1", "request_id": "r1", "body": "x"})).unwrap_err().contains("attempt_missing"));
    assert!(q(json!({"attempt_id": a1, "request_id": "con espacios", "body": "x"})).unwrap_err().contains("invalid_request"));
    assert!(q(json!({"attempt_id": a1, "request_id": "r1", "body": ""})).is_err(), "una instrucción vacía no se encola");
    assert!(q(json!({"attempt_id": a1, "request_id": "r1", "body": "x".repeat(20_001)})).is_err(), "el cuerpo está acotado");
    assert!(q(json!({"attempt_id": a1, "request_id": "r1", "body": "x", "attachments": ["art-1"]})).is_err(), "esta entrega no admite adjuntos");
    assert!(w.core.rpc(Caller::Agent(Some(task.clone())), "", "attempt_queue", &json!({"attempt_id": a1, "request_id": "r1", "body": "x"})).is_err(), "un agente no encola por este RPC");
    assert!(w.desktop("attempt_queue_cancel", json!({"queue_id": "nadie-a1-q1"})).unwrap_err().contains("queue_missing"));
    assert!(w.desktop("pending_queue", json!({"attempt_id": "nadie-a1"})).is_err());
    assert!(queue_rows(&w.core, &a1).is_empty(), "ninguna petición rechazada escribe");

    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    w.desktop("stop", json!({"task": task})).expect("stop");
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
