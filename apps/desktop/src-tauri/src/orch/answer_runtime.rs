//! Responder a una petición del proveedor desde Desktop (LXO-247): `attempt_answer` y `attempt_pending_requests`.
//!
//! Hasta ahora un Attempt que pedía un permiso o hacía una pregunta quedaba en `awaiting_terminal_approval` sin que nadie pudiera
//! contestar, y vencido el plazo fallaba (`terminal_approval_timeout`). Ahora una persona puede responder.
//!
//! ```text
//! attempt_answer { attempt_id, request_id, answer }
//!   1. Person autenticada (`HumanDecision`); la clave es el `request_id` de la propia petición del proveedor
//!   2. el Attempt existe y tiene una ejecución viva; la petición está pendiente         <- si no, error y NADA se toca
//!   3. claim: nadie más la responde a la vez; la respuesta vale para su tipo
//!        permiso:  `allow` | `deny`           pregunta: texto libre (hasta 4 000 caracteres)
//!   4. la capability `answer`                                                           <- si falta, error y NADA se escribe
//!   5. Gated::answer(handle, ...)              si el proveedor la rechaza, la petición SIGUE pendiente y no cambia nada
//!   6. finish: la petición sale de las pendientes; si era la última, el Attempt vuelve a `running` y el plazo se apaga
//! ```
//!
//! # Invariantes
//! * **Se responde UNA vez.** Repetir la misma respuesta devuelve `Replayed` sin volver a llamar al proveedor; otra respuesta a una
//!   petición ya contestada es `request_conflict`.
//! * **El plazo sigue siendo el límite.** Mientras queden peticiones sin responder el Attempt sigue esperando y el plazo corre; una
//!   respuesta tardía (la ejecución ya se canceló por el plazo) es `not_running`/`attempt_final`, no una resurrección.
//! * **Solo una Person.** Ni un agente ni el Core responden por una persona (la automatización es F9).
//! * **Pasa por la policy de autonomía** (`policy.rs`, antes de despachar): PERMITIR un permiso es `provider_permissions` (piso
//!   `confirm`: exige `confirm: true`); denegarlo o contestar una pregunta es `answer`. Ver `docs/core/POLICY.md`.
//! * La respuesta de un permiso es siempre `allow` o `deny`; nunca se deduce de un texto libre.
//!
//! Deja un Event durable de la decisión (`attempt.request_answered`: tipo y `allow`/`deny`, nunca el texto de una respuesta libre),
//! escrito antes del `attempt.resumed`; ver `docs/core/RESPUESTAS.md`.

#![cfg_attr(not(test), allow(dead_code))]

use serde::Deserialize;
use serde_json::{json, Value};

use super::adapter::{Answer, Capability, Gated};
use super::events::{Channel, MutationContext};
use super::provider_requests::{Claim, ProviderRequest, RequestKind};
use super::queue_commands::{ErrorKind, QueueError};
use super::steer_commands as cmd;
use super::Core;
use crate::store::AttemptStatus;

/// Una respuesta de texto admite hasta 4 000 caracteres.
pub(super) const MAX_ANSWER_CHARS: usize = 4_000;
/// El `request_id` es el del proveedor: se acepta lo que mande, acotado y sin caracteres de control.
const MAX_REQUEST_ID_CHARS: usize = 200;

fn invalid(code: &'static str, message: impl Into<String>) -> QueueError {
    QueueError::new(ErrorKind::Invalid, code, message)
}

fn busy(code: &'static str, message: impl Into<String>) -> QueueError {
    QueueError::new(ErrorKind::Busy, code, message)
}

fn check_ids(attempt_id: &str, request_id: Option<&str>) -> Result<(), QueueError> {
    if attempt_id.trim().is_empty() || attempt_id.chars().count() > 200 {
        return Err(invalid("invalid_request", "attempt_id: obligatorio, hasta 200 caracteres"));
    }
    if let Some(id) = request_id {
        if id.trim().is_empty() || id.chars().count() > MAX_REQUEST_ID_CHARS || id.chars().any(char::is_control) {
            return Err(invalid("invalid_request", format!("request_id: de 1 a {MAX_REQUEST_ID_CHARS} caracteres, sin caracteres de control")));
        }
    }
    Ok(())
}

/// Lo que se le dice al proveedor, según el tipo de la petición. Un permiso es `allow` o `deny`, nada más.
fn decision_for(request: &ProviderRequest, answer: &str) -> Result<String, QueueError> {
    match request.kind {
        RequestKind::Permission => match answer.trim().to_ascii_lowercase().as_str() {
            d @ ("allow" | "deny") => Ok(d.to_string()),
            _ => Err(invalid("invalid_answer", "la respuesta a un permiso es `allow` o `deny`")),
        },
        RequestKind::Question => {
            let text = answer.trim();
            if text.is_empty() {
                return Err(invalid("invalid_answer", "la respuesta a una pregunta no puede estar vacía"));
            }
            if text.chars().count() > MAX_ANSWER_CHARS {
                return Err(invalid("invalid_answer", format!("la respuesta admite hasta {MAX_ANSWER_CHARS} caracteres")));
            }
            Ok(text.to_string())
        }
    }
}

fn answered(attempt_id: &str, request_id: &str, kind: Option<RequestKind>, replayed: bool) -> Value {
    json!({
        "status": if replayed { "Replayed" } else { "Answered" },
        "attempt_id": attempt_id,
        "request_id": request_id,
        "kind": kind.map(RequestKind::as_str),
    })
}

impl Core {
    /// `attempt_answer`. Ver el diagrama del módulo.
    pub(super) fn answer_request(&self, ctx: &MutationContext, attempt_id: &str, request_id: &str, answer: &str) -> Result<Value, QueueError> {
        check_ids(attempt_id, Some(request_id))?;
        let attempt = self.attempt_for_answer(attempt_id)?;
        if attempt.status.is_final() {
            return Err(invalid("attempt_final", format!("el Attempt {} ya terminó: no admite respuestas", attempt.id)));
        }
        let live = self
            .live_view(&attempt.task_id)
            .filter(|live| live.attempt_id == attempt.id)
            .ok_or_else(|| busy("not_running", format!("el Attempt {} no tiene una ejecución viva a la que responder", attempt.id)))?;
        let awaiting = self.awaiting_of(&attempt.task_id).ok_or_else(|| busy("not_running", format!("el Attempt {} no tiene una ejecución viva a la que responder", attempt.id)))?;

        let request = match awaiting.lock().claim(request_id) {
            Claim::Taken(request) => request,
            Claim::Busy => return Err(busy("in_progress", "esa petición se está respondiendo ahora mismo")),
            Claim::Answered(decision) => {
                let wanted = answer.trim();
                return if decision == wanted || decision.eq_ignore_ascii_case(wanted) {
                    Ok(answered(&attempt.id, request_id, None, true))
                } else {
                    Err(invalid("request_conflict", "esa petición ya se respondió de otra forma"))
                };
            }
            Claim::Unknown => return Err(invalid("request_unknown", format!("el Attempt {} no tiene una petición pendiente con ese request_id", attempt.id))),
        };

        // Todo o nada antes de tocar al proveedor: si algo falla, la petición queda pendiente y puede intentarse otra vez.
        let release = |why: QueueError| {
            awaiting.lock().release(request_id);
            why
        };
        let decision = decision_for(&request, answer).map_err(release)?;
        if attempt.status != AttemptStatus::AwaitingTerminalApproval {
            return Err(release(busy("not_waiting", format!("el Attempt {} no está esperando una respuesta", attempt.id))));
        }
        live.matrix.require(Capability::Answer).map_err(|e| release(cmd::capability_refusal(&e, "answer_unsupported")))?;

        let gated = Gated::new(live.adapter.as_ref(), &live.matrix);
        if let Err(e) = gated.answer(&live.handle, Answer { question_id: request.id.clone(), text: decision.clone() }) {
            return Err(release(cmd::capability_refusal(&e, "answer_unsupported").with_code("answer_failed")));
        }

        // El proveedor la aceptó: ya no se puede deshacer. Con el candado de las peticiones tomado (antes que el del Core, como el
        // bombeo): así una petición nueva no llega entre medias, y el Attempt no vuelve a `running` con algo sin responder.
        let mut waiting = awaiting.lock();
        // Queda constancia de QUÉ se decidió (solo `allow`/`deny` en un permiso; el texto de una pregunta no viaja). Si no se puede
        // escribir, el proveedor ya la tiene: se dice, no se esconde, y no se deshace nada.
        let decided = match (request.kind, decision.as_str()) {
            (RequestKind::Permission, "allow") => Some("allow"),
            (RequestKind::Permission, _) => Some("deny"),
            (RequestKind::Question, _) => None,
        };
        if let Err(why) = self.request_answered(ctx, &attempt.id, &request.id, request.kind.as_str(), decided) {
            eprintln!("[core] el proveedor aceptó la respuesta a {request_id} de {} pero no quedó constancia de la decisión: {why}", attempt.id);
        }
        if waiting.finish(&request.id, &decision) {
            match self.mutate_as(ctx, |tx| tx.resume_from_approval(&attempt.task_id).map(|_| ())) {
                Ok(()) => waiting.stop_waiting(),
                // El plazo sigue en marcha: si el proveedor no avanza, vence como siempre. Se dice, no se esconde.
                Err(why) => eprintln!("[core] el proveedor aceptó la respuesta a {request_id} de {} pero el Attempt no pudo volver a running: {why}", attempt.id),
            }
        }
        Ok(answered(&attempt.id, &request.id, Some(request.kind), false))
    }

    /// `attempt_pending_requests`: qué espera una respuesta ahora mismo. Una lectura: no cambia nada.
    pub(super) fn pending_provider_requests(&self, attempt_id: &str) -> Result<Value, QueueError> {
        check_ids(attempt_id, None)?;
        let attempt = self.attempt_for_answer(attempt_id)?;
        let live = self.live_view(&attempt.task_id).is_some_and(|live| live.attempt_id == attempt.id);
        let requests: Vec<Value> = match self.awaiting_of(&attempt.task_id).filter(|_| live) {
            Some(awaiting) => awaiting
                .lock()
                .pending()
                .iter()
                .map(|r| json!({"request_id": r.id, "kind": r.kind.as_str(), "subject": r.subject, "summary": r.summary, "asked_at": r.asked_at_ms}))
                .collect(),
            None => Vec::new(),
        };
        Ok(json!({"attempt_id": attempt.id, "live": live, "requests": requests}))
    }
}

// ── RPC de Desktop ───────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AnswerInput {
    pub attempt_id: String,
    pub request_id: String,
    pub answer: String,
    /// La confirmación explícita que pide la policy para PERMITIR un permiso del proveedor (`provider_permissions`, LXO-247). La lee la
    /// policy en `rpc` antes de despachar, no este Command.
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PendingInput {
    pub attempt_id: String,
}

fn person(context: &MutationContext, what: &str) -> Result<(), String> {
    if !context.is_person() || context.client_id.as_deref().is_none_or(str::is_empty) || context.channel == Channel::Core {
        return Err(format!("{what} requiere una Person autenticada"));
    }
    Ok(())
}

/// `attempt_answer`: solo una Person de Desktop (`HumanDecision`).
pub(super) fn rpc_answer(core: &Core, context: &MutationContext, input: &AnswerInput) -> Result<Value, String> {
    person(context, "responder a un proveedor")?;
    core.answer_request(context, &input.attempt_id, &input.request_id, &input.answer).map_err(|e| e.to_string())
}

/// `attempt_pending_requests`: solo una Person de Desktop.
pub(super) fn rpc_pending(core: &Core, context: &MutationContext, input: &PendingInput) -> Result<Value, String> {
    person(context, "ver lo que espera una respuesta")?;
    core.pending_provider_requests(&input.attempt_id).map_err(|e| e.to_string())
}
