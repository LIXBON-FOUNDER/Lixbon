//! Eventos del proceso de una tarea: salida, informe, cierre y cambios de aprobación.

use std::path::Path;
use super::{Core, agents, approval, codex_session, delivery};
use super::state::Status;

impl Core {
    pub(super) fn on_approval_change(&self, id: &str, change: approval::Change) {
        let mut st = self.lock();
        let changed = match change {
            approval::Change::Entered(deadline) => st.await_terminal_approval(id, deadline),
            approval::Change::Left => st.resume_from_approval(id),
        };
        if changed.unwrap_or(false) {
            self.commit(&st, &[]);
        }
    }

    /// Venció la espera de aprobación o el agente lleva demasiado sin escribir: la
    /// tarea queda Failed con su motivo y se mata la PTY con todo su árbol.
    pub(super) fn on_guard_timeout(&self, id: &str, t: approval::Timeout) {
        {
            let mut st = self.lock();
            if let Ok(msg) = st.fail_with(id, t.reason(), t.message()) {
                self.commit(&st, &msg.into_iter().collect::<Vec<_>>());
            }
        }
        self.kill_term(id);
    }

    pub(super) fn term_text(&self, id: &str) -> Option<String> {
        let terms = self.terms.lock().ok()?;
        let b = terms.get(id)?.buffer.lock().ok()?;
        Some(String::from_utf8_lossy(&b).into_owned())
    }

    /// Recoge el informe por archivo o por marcadores (orch/delivery.rs) y lo
    /// entrega como un `lxo done`. Al salir el proceso cierra la tarea si falta.
    pub(super) fn collect(&self, id: &str, terminal: Option<String>, at_exit: bool) {
        let (expect, cwd, delivered, is_final, last_message, stream_json) = {
            let st = self.lock();
            let Ok(t) = st.task(id) else { return };
            (delivery::Expect::of(t), t.cwd.clone(), t.delivered.clone(), t.status.is_final(), t.last_message_path.clone(), t.stream_json)
        };
        if is_final {
            return;
        }
        let found = match &expect {
            Some(ex) => {
                let file = delivery::read_report_file(&delivery::report_path(&cwd, id, ex.attempt));
                // El -o lo escribe codex al terminar: solo se lee al salir el proceso.
                let final_file = last_message.as_ref().filter(|_| at_exit).and_then(|p| delivery::read_final_file(Path::new(p)));
                let src = delivery::Sources {
                    expect_final: last_message.is_some() && at_exit,
                    final_file: final_file.as_deref(),
                    expect_stream: stream_json,
                    file: file.as_deref(),
                    terminal: terminal.as_deref(),
                };
                delivery::find_all(&src, ex, &delivered)
            }
            None => delivery::Found::Nothing,
        };
        let mut st = self.lock();
        match delivery::apply(&mut st, id, found, at_exit) {
            Ok(msgs) => self.commit(&st, &msgs),
            Err(e) if at_exit => {
                let msg = st.close(id, Status::Failed, &format!("informe inválido: {e}")).ok().flatten();
                self.commit(&st, &msg.into_iter().collect::<Vec<_>>());
            }
            Err(_) => {}
        }
    }

    /// Codex: el modelo efectivo sale de `turn_context.model` de su archivo de
    /// sesión; si no se puede leer, `unknown`. Nunca se copia del pedido.
    pub(super) fn record_codex_model(&self, id: &str, session_id: Option<&str>) {
        let (agent, cwd, since) = {
            let st = self.lock();
            let Ok(t) = st.task(id) else { return };
            (t.agent.clone(), t.cwd.clone(), t.attempt_started.unwrap_or(t.created))
        };
        if agent != "codex" {
            return;
        }
        let r = codex_session::resolve(agents::codex_home().map(|h| h.join("sessions")).as_deref(), session_id, &cwd, since);
        let mut st = self.lock();
        if let Ok(t) = st.task_mut(id) {
            delivery::set_model_effective(t, &r.model);
            t.model_source = Some(r.source().into());
            t.session_match = r.session_match().map(str::to_string);
            t.session_ref = r.session_ref;
        }
        self.commit(&st, &[]);
    }

    pub(super) fn codex_model_pending(&self, id: &str) -> bool {
        let st = self.lock();
        st.task(id).is_ok_and(|t| t.agent == "codex" && t.status.is_final() && matches!(t.model_source.as_deref(), None | Some("unknown")))
    }

    pub(super) fn on_exit(&self, id: &str) {
        let terminal = self.terms.lock().ok()
            .and_then(|mut t| t.remove(id))
            .and_then(|t| t.buffer.lock().ok().map(|b| String::from_utf8_lossy(&b).into_owned()));
        let session_id = terminal.as_deref().and_then(codex_session::session_id_from_terminal);
        self.collect(id, terminal, true);
        self.record_codex_model(id, session_id.as_deref());
        let mut st = self.lock();
        if let Ok(Some(msg)) = st.close(id, Status::Exited, delivery::MISSING) {
            self.commit(&st, &[msg]);
        } else {
            self.commit(&st, &[]);
        }
    }

    pub(super) fn kill_term(&self, id: &str) -> bool {
        let Some(mut t) = self.terms.lock().ok().and_then(|mut m| m.remove(id)) else { return false };
        t.kill();
        true
    }
}
