//! El arranque y el ajuste del Orquestador (LXO-246, PR D): conciliar los claims que quedaron en vuelo, dejar constancia
//! de un desenlace desconocido y encender el lanzador real SOLO con el Orquestador activado.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::adapter::fake::FakeAdapter;
use super::adapter_launcher_tests::{fixture, repo_with_commit, worktree_state};
use super::dispatch::DispatchResult;
use super::dispatch_tests::{event_count, row};
use super::events::{Channel, MutationContext};
use super::initial_approval_tests::e2e::{core_with_project_at, restart_fixture_core};
use super::task_create_api::ATTEMPT_NOT_AVAILABLE;
use super::{Core, Orch};
use crate::store::ClientClaims;

/// El payload del único `attempt.dispatch_ambiguous` del Attempt.
fn ambiguity_payload(core: &Core, attempt: &str) -> Value {
    core.storage
        .with_store(|s| {
            s.read(|c| {
                Ok(c.query_row("SELECT payload FROM events WHERE kind = 'attempt.dispatch_ambiguous' AND entity_id = ?1", [attempt], |r| r.get::<_, String>(0))
                    .map(|p| serde_json::from_str::<Value>(&p).unwrap())
                    .unwrap_or(Value::Null))
            })
        })
        .unwrap()
        .unwrap()
}

fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < end, "no se cumplió a tiempo: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn un_claim_started_cuyo_attempt_cerro_la_orfandad_se_asienta_sin_una_ambiguedad_falsa() {
    let f = fixture(Arc::new(FakeAdapter::full("fake")));
    // El Core cayó con la ejecución en marcha: reservado, `attempt.started` registrado y claim `started`, sin nadie escuchando.
    assert!(f.core.dispatch_reserve(&f.attempt).is_ok());
    f.core.mutate_as(&MutationContext::core(), |tx| tx.mark_running(&f.task)).unwrap();
    assert!(f.core.dispatch_mark_started(&f.attempt).unwrap());
    assert_eq!(row(&f.core, &f.attempt), ("running".into(), "started".into(), None));

    // Arranque: primero las huérfanas, luego los claims.
    f.core.close_orphans();
    assert_eq!(row(&f.core, &f.attempt).0, "exited");
    f.core.reconcile_dispatch_claims_at_boot();

    assert_eq!(row(&f.core, &f.attempt), ("exited".into(), "settled".into(), None), "hay evidencia canónica: started y exited del Core");
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.dispatch_ambiguous"), 0);
    assert_eq!(f.core.dispatch_reconcile_in_flight(), Ok(0), "repetirlo no cambia nada");
}

#[test]
fn un_claim_reservado_sin_arranque_pasa_a_ambiguo_con_su_hecho_y_no_se_relanza() {
    let fake = Arc::new(FakeAdapter::full("fake"));
    let f = fixture(fake.clone());
    // Cayó entre la reserva y `attempt.started`: no hay prueba de si el proveedor llegó a llamarse.
    assert!(f.core.dispatch_reserve(&f.attempt).is_ok());

    f.core.close_orphans();
    f.core.reconcile_dispatch_claims_at_boot();

    assert_eq!(row(&f.core, &f.attempt).1, "ambiguous");
    assert_eq!(event_count(&f.core, &f.attempt, "attempt.dispatch_ambiguous"), 1);
    assert_eq!(ambiguity_payload(&f.core, &f.attempt), json!({"task": f.task, "n": 1, "from": "reserved", "cause": "core_restart"}));
    assert_eq!(f.core.dispatch_reconcile_in_flight(), Ok(0), "una ambigüedad ya constada no se repite");

    // Y nunca se vuelve a despachar solo.
    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::AlreadyClaimed);
    assert!(fake.starts().is_empty());
}

#[test]
fn un_desenlace_desconocido_al_lanzar_deja_constancia_inmediata() {
    // Un adapter que entra en pánico al lanzar: el claim pasa a `ambiguous` con su hecho, sin esperar a un reinicio.
    let f = fixture(Arc::new(super::adapter_launcher_tests::PanicAdapter));
    assert_eq!(f.core.dispatch_attempt(&f.attempt, f.launcher.as_ref()).unwrap(), DispatchResult::OutcomeUnknown);

    assert_eq!(row(&f.core, &f.attempt), ("running".into(), "ambiguous".into(), None));
    assert_eq!(ambiguity_payload(&f.core, &f.attempt), json!({"task": f.task, "n": 1, "from": "started", "cause": "start_outcome_unknown"}));
    assert_eq!(worktree_state(&f.core, &f.attempt).as_deref(), Some("active"), "el proceso pudo arrancar: el worktree no se toca");
}

#[test]
fn el_lanzador_sigue_al_ajuste_del_orquestador() {
    let core = Orch::default().0;
    assert!(core.launcher().is_none());
    core.sync_launcher();
    assert!(core.launcher().is_none(), "desactivado: no hay lanzador");

    core.settings.lock().unwrap().enabled = true;
    core.sync_launcher();
    assert!(core.launcher().is_some(), "activado: el lanzador real");
    let installed = core.launcher().unwrap();
    core.sync_launcher();
    assert!(Arc::ptr_eq(&installed, &core.launcher().unwrap()), "sincronizar de nuevo no lo reemplaza");

    core.settings.lock().unwrap().enabled = false;
    core.sync_launcher();
    assert!(core.launcher().is_none(), "desactivado otra vez: se retira");
}

#[test]
fn con_el_orquestador_activado_crear_aprobar_y_lanzar_corre_de_extremo_a_extremo_y_desactivado_se_rechaza() {
    let repo = repo_with_commit();
    let (core, client, _ctx, project) = core_with_project_at(&repo.to_string_lossy());
    let create = |request_id: &str| -> Result<Value, String> {
        let args = json!({"request_id": request_id, "project_id": project, "objective": "o", "title": "t", "spec": "haz algo", "attempt": {"provider": "claude", "profile": "explorar"}});
        core.rpc_authenticated_via(&client, &ClientClaims::default(), Channel::Ui, "", "task_create", &args)
    };

    // Desactivado (el valor de partida): task_create no acepta attempt.
    assert_eq!(create("apagado").unwrap_err(), ATTEMPT_NOT_AVAILABLE);

    // Activado: el lanzador real (sobre los adapters del registro) acepta y ejecuta.
    core.settings.lock().unwrap().enabled = true;
    core.sync_launcher();
    core.provider_registry.probe_all();
    let created = create("encendido").unwrap();
    let attempt = created["attempt_id"].as_str().unwrap().to_string();
    let approved = core.rpc_authenticated_via(&client, &ClientClaims::default(), Channel::Ui, "", "attempt_approve", &json!({"attempt_id": attempt})).unwrap();
    assert_eq!(approved["status"], "Approved");

    // El despachador corre en su hilo; el adapter falso (guion por defecto) completa.
    wait_until("el Attempt completa", || row(&core, &attempt).0 == "done");
    wait_until("el claim se asienta", || row(&core, &attempt).1 == "settled");
    assert_eq!(row(&core, &attempt), ("done".into(), "settled".into(), None));
    for kind in ["attempt.requested", "attempt.approved", "attempt.started", "attempt.completed"] {
        assert_eq!(event_count(&core, &attempt, kind), 1, "{kind}");
    }
    assert_eq!(worktree_state(&core, &attempt).as_deref(), Some("active"), "el trabajo queda en su worktree");

    // Desactivarlo vuelve a cerrar la puerta.
    core.settings.lock().unwrap().enabled = false;
    core.sync_launcher();
    assert_eq!(create("apagado-otra-vez").unwrap_err(), ATTEMPT_NOT_AVAILABLE);
}

#[test]
fn reiniciar_el_core_concilia_los_claims_en_vuelo_por_el_camino_real_de_arranque() {
    // Un Core con un Attempt `running` y su claim `started` (sin nadie escuchando) y otro con el claim solo reservado.
    let f = fixture(Arc::new(FakeAdapter::full("fake")));
    assert!(f.core.dispatch_reserve(&f.attempt).is_ok());
    f.core.mutate_as(&MutationContext::core(), |tx| tx.mark_running(&f.task)).unwrap();
    assert!(f.core.dispatch_mark_started(&f.attempt).unwrap());

    let core = restart_fixture_core(f.core);

    // El arranque cerró la tarea huérfana Y concilió el claim, en ese orden: hay evidencia canónica, así que se asienta.
    assert_eq!(row(&core, &f.attempt), ("exited".into(), "settled".into(), None));
    assert_eq!(event_count(&core, &f.attempt, "attempt.dispatch_ambiguous"), 0);
    assert_eq!(core.dispatch_reconcile_in_flight(), Ok(0), "no queda nada en vuelo");
}
