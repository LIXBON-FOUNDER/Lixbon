//! Barrido durable de las aprobaciones iniciales vencidas.
//!
//! SQLite solo entrega candidatos; cada cambio pasa por `Core::mutate`, donde
//! `Tx::expire_pending_initial` actualiza el estado y añade el evento. El commit
//! runtime vuelve a validar el Attempt y su deadline durable bajo la transacción
//! que confirma estado, evento y tablas. Si la lectura falla o el Core está en
//! solo lectura, no se interpreta el candidato como autorización para cambiar nada.

use super::events::MutationContext;
use super::mutation::Health;
use super::state;
use super::Core;

const EXPIRY_CANDIDATE_LIMIT: usize = 128;

impl Core {
    /// Procesa un lote acotado de Attempts pendientes cuyo deadline durable ya venció.
    /// Devuelve cuántos cambios llegaron a confirmarse.
    pub(super) fn sweep_initial_approvals(&self) -> usize {
        if !matches!(self.health(), Health::Normal) {
            return 0;
        }

        let Ok(now) = i64::try_from(state::now_ms()) else {
            return 0;
        };
        if now <= 0 {
            return 0;
        }

        let candidates = self.initial_approval_expiry_candidates(now, EXPIRY_CANDIDATE_LIMIT);
        let Some(candidates) = candidates else {
            // Sin SQLite autoritativa no existe un deadline durable que podamos expirar.
            return 0;
        };
        let candidates = match candidates {
            Ok(candidates) => candidates,
            Err(error) => {
                eprintln!("[core] no se pudieron leer aprobaciones iniciales vencidas: {error}");
                return 0;
            }
        };

        let mut expired = 0;
        for attempt_id in candidates {
            if !matches!(self.health(), Health::Normal) {
                break;
            }
            match self.mutate_as(&MutationContext::core(), |tx| {
                tx.expire_pending_initial(&attempt_id)
            }) {
                Ok(true) => expired += 1,
                Ok(false) => {}
                Err(error) => {
                    eprintln!("[core] no se pudo expirar una aprobación inicial: {error}");
                    // Un fallo de persistencia pone el Core en solo lectura. No se
                    // intenta continuar el lote con un candidato distinto.
                    if !matches!(self.health(), Health::Normal) {
                        break;
                    }
                }
            }
        }
        expired
    }
}

#[cfg(test)]
mod tests {
    use crate::orch::events::{Channel, MutationContext};
    use crate::orch::mutation::Tx;
    use crate::orch::state::{NewTask, State, Status};

    fn pending_task() -> (State, String) {
        let mut state = State::default();
        let (_, task_id) = state.create_run(
            "approval expiry test",
            NewTask {
                agent: "fake".into(),
                model: None,
                effort: None,
                role: None,
                title: "pending".into(),
                spec: String::new(),
                repo: String::new(),
                cwd: String::new(),
                branch: None,
                base: None,
                worktree: None,
                external: false,
            },
        );
        state.tasks.get_mut(&task_id).unwrap().status = Status::PendingApproval;
        state.attempt_n.insert(task_id.clone(), 1);
        (state, task_id)
    }

    #[test]
    fn expiry_tx_only_stops_the_exact_current_pending_attempt_and_emits_rejection() {
        let (state, task_id) = pending_task();
        let mut tx = Tx::detached(state);
        let attempt_id = format!("{task_id}-a1");

        assert!(tx.expire_pending_initial(&attempt_id).unwrap());
        assert_eq!(tx.tasks[&task_id].status, Status::Stopped);
        assert_eq!(tx.pending_events().len(), 1);
        assert_eq!(tx.pending_events()[0].kind(), "attempt.rejected");
        assert!(tx.validate_events().is_ok());
    }

    #[test]
    fn stale_attempt_or_non_system_caller_cannot_expire_pending_state() {
        let (mut state, task_id) = pending_task();
        state.attempt_n.insert(task_id.clone(), 2);
        let mut tx = Tx::detached(state);
        let stale_attempt_id = format!("{task_id}-a1");

        assert!(!tx.expire_pending_initial(&stale_attempt_id).unwrap());
        assert_eq!(tx.tasks[&task_id].status, Status::PendingApproval);
        assert!(tx.pending_events().is_empty());

        let (state, task_id) = pending_task();
        let mut tx = Tx::detached(state);
        tx.set_context(MutationContext::person(Channel::Ui));
        assert!(tx
            .expire_pending_initial(&format!("{task_id}-a1"))
            .is_err());
        assert_eq!(tx.tasks[&task_id].status, Status::PendingApproval);
        assert!(tx.pending_events().is_empty());
    }

    #[test]
    fn no_store_means_no_expiry() {
        let core = super::super::Orch::default().0;
        assert_eq!(core.sweep_initial_approvals(), 0);
    }
}
