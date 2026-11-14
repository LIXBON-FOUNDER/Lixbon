//! LXO-250 · La Pending Queue ante un REINICIO REAL del Core (no solo `recover` a nivel de almacén): `restart_fixture_core` suelta el
//! Core y arranca otro sobre las mismas carpetas, por el camino real de arranque (`close_orphans` → claims → `queue_recover_at_boot`).
//! Contrato: `docs/core/COLA.md` (policy D7).

use std::sync::Arc;

use super::adapter::fake::FakeAdapter;
use super::adapter::{AdapterError, CancelToken};
use super::adapter_launcher_tests::fixture;
use super::dispatch_tests::{event_count, row};
use super::events::{Actor, Channel, MutationContext};
use super::initial_approval_tests::e2e::restart_fixture_core;
use super::queue_commands::{Boundary, DeliveryRequest, QueuePort, QueueRequest};
use super::Core;
use crate::store::{AttemptRow, QueueConfirmation, QueueFailure, QueueItemRow, QueueStatus, Store};

/// Un puerto que acepta encolar y NUNCA entrega: el run está en mitad de un turno y cualquier entrega sería un error de la prueba.
struct PuertoOcupado;

impl QueuePort for PuertoOcupado {
    fn capability(&self, _attempt: &AttemptRow) -> Result<(), AdapterError> {
        Ok(())
    }

    fn boundary(&self, _attempt: &AttemptRow) -> Boundary {
        Boundary::Busy
    }

    fn deliver(&self, _attempt: &AttemptRow, _request: &DeliveryRequest<'_>, _cancel: &CancelToken) -> Result<QueueConfirmation, AdapterError> {
        panic!("tras un reinicio nada se entrega: un item interrumpido no se reintenta y lo encolado ya no tiene Attempt vivo");
    }
}

fn persona() -> MutationContext {
    MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) }
}

/// El almacén del Core, para leer (o forzar un estado) sin pasar por un comando.
fn con_store<R>(core: &Core, f: impl FnOnce(&mut Store) -> R) -> R {
    core.storage.with_store(f).expect("el almacén del Core está abierto")
}

fn cola(core: &Core, attempt: &str) -> Vec<QueueItemRow> {
    con_store(core, |st| st.queue_of_attempt(attempt)).expect("leer la cola")
}

fn estados(core: &Core, attempt: &str) -> Vec<(String, QueueStatus, Option<QueueFailure>)> {
    cola(core, attempt).into_iter().map(|i| (i.body, i.status, i.failure)).collect()
}

/// Un Attempt `running` con un claim `started` y tres instrucciones: la primera EN VUELO (`delivering`: el Core cayó entre pedir la
/// entrega y anotar su resultado) y dos en cola.
fn con_la_cola_a_medias() -> (Arc<Core>, String) {
    let f = fixture(Arc::new(FakeAdapter::full("fake")));
    assert!(f.core.dispatch_reserve(&f.attempt).is_ok());
    f.core.mutate_as(&MutationContext::core(), |tx| tx.mark_running(&f.task)).unwrap();
    assert!(f.core.dispatch_mark_started(&f.attempt).unwrap());
    for (request, body) in [("r1", "en vuelo"), ("r2", "en cola uno"), ("r3", "en cola dos")] {
        f.core
            .queue_enqueue(&PuertoOcupado, &persona(), &CancelToken::new(), &QueueRequest { request_id: request, attempt_id: &f.attempt, body, attachments: &[] })
            .unwrap_or_else(|e| panic!("debía encolar {request}: {e}"));
    }
    let en_vuelo = con_store(&f.core, |st| st.queue_claim_next(&f.attempt, 500)).unwrap().expect("había algo que reclamar");
    assert_eq!(en_vuelo.body, "en vuelo");
    assert_eq!(estados(&f.core, &f.attempt).iter().map(|(_, s, _)| *s).collect::<Vec<_>>(), [QueueStatus::Delivering, QueueStatus::Queued, QueueStatus::Queued]);
    (f.core, f.attempt)
}

/// Un reinicio real con la cola no vacía: el Attempt que corría queda `exited` (no hay proceso que lo continúe), lo que iba en vuelo falla
/// `interrupted` (no se sabe si llegó: NUNCA se reintenta) y lo encolado falla `attempt_ended`. Nada se entrega, y un segundo reinicio no
/// escribe nada más.
#[test]
fn un_reinicio_real_con_la_cola_no_vacia_cierra_lo_pendiente_y_no_entrega_nada() {
    let (core, attempt) = con_la_cola_a_medias();
    let antes = event_count(&core, &attempt, "attempt.queue_failed");
    assert_eq!(antes, 0);

    let core = restart_fixture_core(core);

    assert_eq!(row(&core, &attempt).0, "exited", "el arranque cerró la ejecución huérfana ANTES de recuperar la cola");
    assert_eq!(
        estados(&core, &attempt),
        [
            ("en vuelo".to_string(), QueueStatus::Failed, Some(QueueFailure::Interrupted)),
            ("en cola uno".to_string(), QueueStatus::Failed, Some(QueueFailure::AttemptEnded)),
            ("en cola dos".to_string(), QueueStatus::Failed, Some(QueueFailure::AttemptEnded)),
        ]
    );
    assert_eq!(event_count(&core, &attempt, "attempt.queue_failed"), 3, "un hecho por item, coherente con su estado");
    assert_eq!(event_count(&core, &attempt, "attempt.queue_delivered"), 0, "nada se entregó");
    assert_eq!(con_store(&core, |st| st.queue_pending_of_attempt(&attempt)).unwrap().len(), 0, "no queda nada pendiente");

    // Idempotente: otro reinicio no vuelve a escribir ni a entregar.
    let core = restart_fixture_core(core);
    assert_eq!(event_count(&core, &attempt, "attempt.queue_failed"), 3);
    assert_eq!(event_count(&core, &attempt, "attempt.queue_delivered"), 0);
    assert_eq!(estados(&core, &attempt).iter().filter(|(_, s, _)| *s == QueueStatus::Failed).count(), 3);
}
