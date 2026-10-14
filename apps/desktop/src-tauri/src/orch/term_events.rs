//! Eventos del proceso de una tarea: salida, informe, cierre y cambios de aprobación.

use std::path::Path;
use super::events::{Channel, MutationContext};
use super::{Core, agents, approval, codex_session, delivery};
use super::state::Status;

impl Core {
    pub(super) fn on_approval_change(&self, id: &str, change: approval::Change) {
        // Mutación de fondo: si falla, el Core ya avisó y entró en solo lectura.
        let _ = self.mutate(|st| {
            let changed = match change {
                approval::Change::Entered(deadline) => st.await_terminal_approval(id, deadline),
                approval::Change::Left => st.resume_from_approval(id),
            };
            if !changed.unwrap_or(false) {
                st.no_change();
            }
            Ok(())
        });
    }

    /// Venció la espera de aprobación o el agente lleva demasiado sin escribir: la
    /// tarea queda Failed con su motivo y se mata la PTY con todo su árbol.
    pub(super) fn on_guard_timeout(&self, id: &str, t: approval::Timeout) {
        let _ = self.mutate(|st| {
            let msg = st.fail_with(id, t.reason(), t.message())?;
            st.notify_opt(msg);
            Ok(())
        });
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
        self.apply_found(id, found, at_exit);
    }

    /// Aplica lo encontrado con la atribución correcta (`delivery::apply` no decide actores):
    /// * informe VÁLIDO aceptado → el agente lo produjo: `Agent(id) / Core`;
    /// * informe inválido, no entregado o proceso terminado sin informe → el agente no produjo nada
    ///   utilizable y es el Core quien diagnostica y decide `Failed`/`Exited`: `System / Core`;
    /// * cualquier fallback posterior donde el Core cierra por un fallo al aplicar → `System / Core`.
    pub(super) fn apply_found(&self, id: &str, found: delivery::Found, at_exit: bool) {
        let ctx = match &found {
            delivery::Found::Valid(_) => MutationContext::agent(id, Channel::Core),
            _ => MutationContext::core(),
        };
        let _ = self.mutate_as(&ctx, |st| {
            match delivery::apply(st, id, found, at_exit) {
                Ok(msgs) => st.notify(&msgs),
                Err(e) if at_exit => {
                    // El informe «válido» no se pudo aplicar: el cierre lo decide el Core.
                    st.set_context(MutationContext::core());
                    let msg = st.close(id, Status::Failed, &format!("informe inválido: {e}")).ok().flatten();
                    st.notify_opt(msg);
                }
                // Sin cambios que confirmar: se descarta lo que `apply` hubiera tocado a medias.
                Err(_) => st.no_change(),
            }
            Ok(())
        });
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
        let _ = self.mutate(|st| {
            if let Ok(t) = st.task_mut(id) {
                delivery::set_model_effective(t, &r.model);
                t.model_source = Some(r.source().into());
                t.session_match = r.session_match().map(str::to_string);
                t.session_ref = r.session_ref;
            }
            Ok(())
        });
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
        let _ = self.mutate(|st| {
            // Decide mirando el estado PREVIO: si la Task ya no existe (la retiró un cleanup) o ya estaba final, un
            // `on_exit` tardío no tiene nada que cerrar y NO debe confirmar una mutación vacía (rev, eventos).
            // No se deduce de `close() == Ok(None)`: una raíz puede devolverlo tras cambiar su estado.
            if st.tasks.get(id).is_none_or(|t| t.status.is_final()) {
                st.no_change();
                return Ok(());
            }
            if let Ok(Some(msg)) = st.close(id, Status::Exited, delivery::MISSING) {
                st.notify(&[msg]);
            }
            Ok(())
        });
    }

    /// Mata y retira el terminal de `id` DICIENDO si pudo. `None`: no hay terminal registrado. `Some(Err)`:
    /// no hay control fiable sobre el proceso (el matador falló o devolvió un estado distinto de cero); en ese caso el
    /// terminal vuelve al mapa para poder reintentarlo y NADA que dependa de que el proceso esté muerto
    /// (borrar su worktree, su tarea) debe hacerse.
    ///
    /// Un mapa con el lock envenenado NO impide recuperar el terminal: su guard se recupera con
    /// `PoisonError::into_inner` (el `HashMap` sigue siendo coherente; el pánico fue de otro hilo). Si el kill
    /// vuelve a fallar, el terminal queda otra vez almacenado: nunca se suelta un `AgentTerm` cuyo proceso
    /// puede seguir vivo.
    pub(super) fn kill_term_checked(&self, id: &str) -> Option<Result<(), String>> {
        let mut term = self.terms.lock().unwrap_or_else(|e| e.into_inner()).remove(id)?;
        match term.try_kill() {
            Ok(()) => Some(Ok(())),
            Err(e) => {
                self.terms.lock().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), term);
                Some(Err(e))
            }
        }
    }

    /// Registra el terminal recién creado. Si no se puede registrar, el proceso se MATA antes de devolver el
    /// error, comprobando el resultado. Si tampoco se puede matar, el terminal NO se pierde: se guarda en el
    /// mapa (recuperando su guard envenenado, ruta de emergencia) y el proceso sigue bajo la custodia del Core,
    /// que conservará la Task y el worktree. Nunca se suelta un `AgentTerm` con el proceso potencialmente vivo
    /// (no tiene `Drop` que lo mate).
    pub(super) fn register_term(&self, id: &str, mut term: super::pty::AgentTerm) -> Result<(), String> {
        match self.terms.lock() {
            Ok(mut m) => {
                m.insert(id.to_string(), term);
                Ok(())
            }
            Err(poisoned) => {
                let mut map = poisoned.into_inner();
                match term.try_kill() {
                    Ok(()) => Err("Estado interno corrupto: no se pudo registrar el terminal (su proceso se mató)".into()),
                    Err(e) => {
                        map.insert(id.to_string(), term);
                        Err(format!("Estado interno corrupto: no se pudo registrar el terminal ni matar su proceso ({e}); queda bajo la custodia del Core"))
                    }
                }
            }
        }
    }

    pub(super) fn kill_term(&self, id: &str) -> bool {
        let Some(mut t) = self.terms.lock().ok().and_then(|mut m| m.remove(id)) else { return false };
        t.kill();
        true
    }
}
