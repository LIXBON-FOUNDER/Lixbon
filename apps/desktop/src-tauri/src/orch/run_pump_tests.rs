//! El bombeo de eventos (LXO-246, PR C) de extremo a extremo: Core persistente, git real, SQLite y un adapter falso con guion.
//! La ejecución corre en su propio hilo: cada prueba espera al efecto DURABLE (con límite) y comprueba filas y eventos.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use super::adapter::fake::{FakeAdapter, Step};
use super::adapter::{
    AdapterError, CancelToken, CapabilityMatrix, ErrorCode, EventSink, ProbeResult, ProviderAdapter, RunHandle, RunOutcome, StartRequest,
};
use super::adapter_launcher_tests::{fixture, fixture_with_ttl, worktree_dir, worktree_state, Fixture};
use super::dispatch::DispatchResult;
use super::dispatch_tests::{event_count, row};
use super::events::Channel;
use crate::store::{ClientClaims, ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity};

fn cli_client(core: &super::Core) -> crate::store::AuthenticatedClient {
    let secret = "f5-stop-test-secret-0123456789abcdef";
    core.storage
        .with_store(|store| {
            let registration = ClientRegistration::new(
                ClientSurface::Cli,
                DeviceIdentity::new("f5-stop-cli-test", None).unwrap(),
            )
            .unwrap();
            let credential = ClientCredential::new(
                ClientPrincipal::Person("e2e-person".into()),
                secret,
            )
            .unwrap();
            store.register_client(&registration, &credential, 10_000).unwrap();
        })
        .unwrap();
    core.authenticate_client(secret).unwrap().unwrap()
}

fn launch(f: &Fixture) {
    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::Launched);
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < end, "no se cumplió a tiempo: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// El desenlace del Attempt y el asentado del claim son DOS escrituras seguidas: se espera a la segunda.
fn wait_settled(f: &Fixture) {
    wait_until("el claim se asienta", || row(&f.core, &f.attempt).1 == "settled");
}

fn status(f: &Fixture) -> String {
    row(&f.core, &f.attempt).0
}

/// (resumen, modelo efectivo, procedencia, sesión vinculada) del Attempt.
fn facts(f: &Fixture) -> (String, Option<String>, Option<String>, bool) {
    f.core
        .storage
        .with_store(|s| {
            s.read(|c| {
                Ok(c.query_row("SELECT summary, model_effective, model_source, provider_session_id IS NOT NULL FROM attempts WHERE id = ?1", [&f.attempt], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })?)
            })
        })
        .unwrap()
        .unwrap()
}

/// Pausa `start` tras el `attempt.started` durable y antes de que `spawn_pump`
/// registre el control cancelable de la ejecución.
struct BlockingStartAdapter {
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    seq: AtomicU64,
}

impl ProviderAdapter for BlockingStartAdapter {
    fn id(&self) -> &str {
        "fake"
    }

    fn probe(&self) -> ProbeResult {
        ProbeResult::ready(Some("0.0.0-fake"), CapabilityMatrix::all_available())
    }

    fn start(&self, request: StartRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        cancel.check()?;
        let _ = self.entered.send(());
        self.release
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| AdapterError::new(ErrorCode::Internal, "la prueba no liberó start"))?;
        cancel.check()?;
        Ok(RunHandle {
            attempt_id: request.attempt_id,
            adapter: self.id().to_string(),
            seq: self.seq.fetch_add(1, Ordering::SeqCst) + 1,
        })
    }

    fn events(&self, _run: &RunHandle, cancel: &CancelToken, _sink: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        let end = Instant::now() + Duration::from_secs(10);
        while !cancel.is_cancelled() {
            if Instant::now() >= end {
                return Err(AdapterError::new(ErrorCode::Internal, "la prueba no recibió cancelación"));
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(RunOutcome::Cancelled)
    }
}

#[test]
fn una_ejecucion_que_completa_deja_el_attempt_done_con_sus_hechos_y_el_claim_asentado() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    fake.set_script(vec![Step::Bind("sess-1"), Step::Model("modelo-efectivo"), Step::Output("trabajando".into()), Step::Complete(Some("hecho".into()))]);
    let f = fixture(fake);

    launch(&f);
    wait_until("el Attempt completa", || status(&f) == "done");
    wait_settled(&f);

    assert_eq!(row(&f.core, &f.attempt), ("done".into(), "settled".into(), None));
    assert_eq!((event_count(&f.core, &f.attempt, "attempt.started"), event_count(&f.core, &f.attempt, "attempt.completed")), (1, 1));
    let (summary, model, source, session) = facts(&f);
    assert_eq!((summary.as_str(), model.as_deref(), source.as_deref(), session), ("hecho", Some("modelo-efectivo"), Some("session_declared"), true));
    // El trabajo hecho en el worktree se conserva para revisarlo: terminar no lo libera.
    assert!(worktree_dir(&f).is_dir());
    assert_eq!(worktree_state(&f.core, &f.attempt).as_deref(), Some("active"));
    assert!(!f.core.has_term(&f.task), "la ejecución terminada sale del registro");
}

#[test]
fn una_ejecucion_que_falla_deja_el_attempt_failed_con_su_motivo() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    fake.set_script(vec![Step::Output("empiezo".into()), Step::Fail(AdapterError::provider("el proveedor se cayó"))]);
    let f = fixture(fake);

    launch(&f);
    wait_until("el Attempt falla", || status(&f) == "failed");
    wait_settled(&f);

    assert_eq!(row(&f.core, &f.attempt), ("failed".into(), "settled".into(), Some("agent_reported".into())));
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.failed"), 1);
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.completed"), 0);
}

#[test]
fn detener_la_task_cancela_la_ejecucion_espera_a_que_muera_y_deja_el_attempt_stopped() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    fake.set_script(vec![Step::Wait]);
    let f = fixture(fake);
    launch(&f);
    wait_until("la ejecución está registrada", || f.core.has_term(&f.task));
    assert!(f.core.live_ids().contains(&f.task), "cuenta como proceso vivo para el resto del Core");

    // Es el camino de `stop`, del cierre de un Run y de `release`: cancela y espera a que el proceso muera.
    assert_eq!(f.core.kill_term(&f.task), Ok(true));
    assert!(!f.core.has_term(&f.task), "cuando kill_term vuelve, el proceso ya murió");
    wait_until("el Attempt se detiene", || status(&f) == "stopped");
    wait_settled(&f);

    assert_eq!(row(&f.core, &f.attempt), ("stopped".into(), "settled".into(), None));
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.failed"), 0, "cancelar no es fallar");
    assert_eq!(f.core.kill_term(&f.task), Ok(false), "ya no hay nada que matar");
}

#[test]
fn detener_un_attempt_exacto_no_afecta_a_otra_ejecucion_y_espera_el_cierre_durable() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    fake.set_script(vec![Step::Wait]);
    let f = fixture(fake);
    launch(&f);
    wait_until("la ejecución está registrada", || f.core.has_term(&f.task));

    let wrong = format!("{}-a99", f.task);
    let cli = cli_client(&f.core);
    let stop = |attempt_id: &str, confirm: bool| {
        f.core.rpc_authenticated_via(
            &cli,
            &ClientClaims::default(),
            Channel::Lxo,
            "",
            "attempt_stop",
            &serde_json::json!({"attempt_id":attempt_id,"confirm":confirm}),
        )
    };
    assert!(stop(&f.attempt, false).unwrap_err().starts_with("policy_confirm_required"));
    assert_eq!(status(&f), "running", "sin confirmación la policy no permite detener");
    assert!(stop(&wrong, true).is_err(), "un Attempt diferente no debe detenerse");
    assert_eq!(status(&f), "running", "una identidad distinta no cancela ni cierra la Task");
    assert!(f.core.has_term(&f.task));

    let result = stop(&f.attempt, true).expect("el stop exacto");
    assert_eq!(result["status"], "Stopped");
    assert!(!f.core.has_term(&f.task), "el stop retorna después de que muere el proceso");
    wait_until("el Attempt exacto se detiene", || status(&f) == "stopped");
    wait_settled(&f);
    assert_eq!(row(&f.core, &f.attempt), ("stopped".into(), "settled".into(), None));
}

#[test]
fn stop_en_la_ventana_running_sin_control_falla_cerrado_y_el_mismo_stop_se_puede_reintentar() {
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let adapter = Arc::new(BlockingStartAdapter {
        entered: entered_tx,
        release: Mutex::new(release_rx),
        seq: AtomicU64::new(0),
    });
    let f = fixture(adapter);
    let cli = cli_client(&f.core);

    let core = Arc::clone(&f.core);
    let launcher = Arc::clone(&f.launcher);
    let attempt = f.attempt.clone();
    let dispatch = std::thread::spawn(move || core.dispatch_attempt(&attempt, launcher.as_ref()));

    entered_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("el adapter debe detenerse dentro de start");
    assert_eq!(row(&f.core, &f.attempt), ("running".into(), "started".into(), None));
    assert!(!f.core.has_term(&f.task), "todavía no existe un RunControl");

    let stop = || {
        f.core.rpc_authenticated_via(
            &cli,
            &ClientClaims::default(),
            Channel::Lxo,
            "",
            "attempt_stop",
            &serde_json::json!({"attempt_id":f.attempt.clone(),"confirm":true}),
        )
    };
    let unavailable = stop().unwrap_err();
    assert!(unavailable.starts_with("attempt_stop_unavailable:"), "{unavailable}");
    assert_eq!(row(&f.core, &f.attempt), ("running".into(), "started".into(), None));
    assert!(!f.core.has_term(&f.task));

    release_tx.send(()).expect("liberar el lanzamiento");
    assert_eq!(dispatch.join().unwrap().unwrap(), DispatchResult::Launched);
    wait_until("el RunControl queda registrado", || f.core.has_term(&f.task));

    assert_eq!(stop().unwrap()["status"], "Stopped", "el mismo stop exacto se puede reintentar");
    assert_eq!(row(&f.core, &f.attempt), ("stopped".into(), "settled".into(), None));
}

#[test]
fn el_apagado_cancela_las_ejecuciones_vivas() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    fake.set_script(vec![Step::Wait]);
    let f = fixture(fake);
    launch(&f);
    wait_until("la ejecución está registrada", || f.core.has_term(&f.task));

    f.core.kill_all_terms();
    assert!(!f.core.has_term(&f.task));
    wait_until("el Attempt se detiene", || status(&f) == "stopped");
}

#[test]
fn una_peticion_del_proveedor_deja_el_attempt_esperando_con_attention_y_vencido_el_plazo_falla() {
    for (label, step) in [("pregunta", Step::Question { id: "q1", text: "¿sigo?".into() }), ("permiso", Step::Permission { id: "p1", tool: "Bash" })] {
        let fake = Arc::new(FakeAdapter::full("fake"));
        fake.set_script(vec![step, Step::Wait]);
        let f = fixture_with_ttl(fake, Some(Duration::from_millis(400)));

        launch(&f);
        wait_until(&format!("{label}: el Attempt espera"), || status(&f) == "awaiting_terminal_approval");
        // La espera consta como `attempt.waiting` (state = awaiting_terminal_approval), que levanta la Attention `approval`.
        assert_eq!(event_count(&f.core, &f.attempt, "attempt.waiting"), 1, "{label}");
        let active_approvals: i64 = f
            .core
            .storage
            .with_store(|s| s.read(|c| Ok(c.query_row("SELECT count(*) FROM attention_items WHERE category = 'approval' AND status = 'active'", [], |r| r.get(0))?)))
            .unwrap()
            .unwrap();
        assert_eq!(active_approvals, 1, "{label}: la persona ve que algo espera");

        // Nadie puede responder: vencido el plazo se cancela la ejecución y el Attempt falla con su motivo.
        wait_until(&format!("{label}: vence el plazo"), || status(&f) == "failed");
        wait_settled(&f);
        assert_eq!(row(&f.core, &f.attempt), ("failed".into(), "settled".into(), Some("terminal_approval_timeout".into())), "{label}");
        wait_until(&format!("{label}: se libera el control de ejecución"), || !f.core.has_term(&f.task));
    }
}

#[test]
fn detener_mientras_espera_una_respuesta_es_stopped_y_no_un_vencimiento() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    fake.set_script(vec![Step::Permission { id: "p1", tool: "Bash" }, Step::Wait]);
    let f = fixture_with_ttl(fake, Some(Duration::from_secs(60)));
    launch(&f);
    wait_until("el Attempt espera", || status(&f) == "awaiting_terminal_approval");

    assert_eq!(f.core.kill_term(&f.task), Ok(true));
    wait_until("el Attempt se detiene", || status(&f) == "stopped");
    assert_eq!(row(&f.core, &f.attempt).2, None);
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.failed"), 0);
}
