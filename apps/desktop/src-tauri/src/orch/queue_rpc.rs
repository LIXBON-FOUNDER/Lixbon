//! RPC de la cola de instrucciones (LXO-143): `attempt_queue`, `attempt_queue_cancel` y `pending_queue`.
//!
//! Solo una Person de Desktop (`attempt_queue` y `attempt_queue_cancel` son `HumanDecision`). El cuerpo lo valida el almacén (hasta
//! 20 000 caracteres) y la clave de idempotencia es del cliente: **repetir la petición devuelve el mismo item** (`Replayed`) sin
//! duplicarlo ni entregarlo dos veces, y reutilizar la clave para otra instrucción es `request_conflict`.
//!
//! **Encolar no entrega nada.** El Attempt está `running` y en mitad de un turno: la instrucción espera y la entrega el bombeo en el fin
//! de turno (`queue_runtime.rs`), reanudando la sesión. Si el proveedor no puede reanudar, encolar es un error y no se escribe nada:
//! no se degrada a otra semántica (Queue nunca es Steer). Esta primera entrega no admite adjuntos.

use serde::Deserialize;
use serde_json::{json, Value};

use super::adapter::CancelToken;
use super::events::{Channel, MutationContext};
use super::queue_commands::{Cancelled, QueueRequest};
use super::queue_runtime::TurnPort;
use super::Core;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct QueueInput {
    pub attempt_id: String,
    pub request_id: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CancelInput {
    pub queue_id: String,
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

pub(super) fn enqueue(core: &Core, context: &MutationContext, input: &QueueInput) -> Result<Value, String> {
    person(context, "encolar una instrucción")?;
    let port = TurnPort::for_enqueue(core);
    let request = QueueRequest { request_id: &input.request_id, attempt_id: &input.attempt_id, body: &input.body, attachments: &[] };
    let queued = core.queue_enqueue(&port, context, &CancelToken::new(), &request).map_err(|e| e.to_string())?;
    Ok(json!({
        "status": if queued.replayed { "Replayed" } else { "Queued" },
        "attempt_id": input.attempt_id,
        "queue_id": queued.item.queue_id,
        "position": queued.position,
    }))
}

pub(super) fn cancel(core: &Core, context: &MutationContext, input: &CancelInput) -> Result<Value, String> {
    person(context, "cancelar una instrucción")?;
    let cancelled = core.queue_cancel(context, &input.queue_id).map_err(|e| e.to_string())?;
    let status = match cancelled {
        Cancelled::Cancelled(_) => "Cancelled",
        Cancelled::AlreadyCancelled(_) => "AlreadyCancelled",
    };
    Ok(json!({"status": status, "queue_id": input.queue_id}))
}

/// Cuántos items ya terminados devuelve `pending_queue` como mucho (los últimos).
pub(super) const FINISHED_LIMIT: usize = 20;

/// Lo que la interfaz necesita de un item: nunca la clave de idempotencia, su digest ni la instalación que lo envió.
fn shown(item: &crate::store::QueueItemRow) -> Value {
    json!({
        "queue_id": item.queue_id,
        "seq": item.seq,
        "author_kind": item.author_kind,
        "body": item.body,
        "status": item.status,
        "failure": item.failure,
        "confirmed_by": item.confirmed_by,
        "created_at": item.created_at,
        "delivered_at": item.delivered_at,
        "ended_at": item.ended_at,
    })
}

pub(super) fn pending(core: &Core, context: &MutationContext, input: &PendingInput) -> Result<Value, String> {
    person(context, "ver la cola de instrucciones")?;
    let queue = core.queue_pending(context, &input.attempt_id).map_err(|e| e.to_string())?;
    let finished = core.queue_finished(context, &input.attempt_id, FINISHED_LIMIT).map_err(|e| e.to_string())?;
    Ok(json!({
        "v": 1,
        "attempt_id": queue.attempt_id,
        "task_id": queue.task_id,
        "items": queue.items.iter().map(|p| { let mut v = shown(&p.item); v["position"] = json!(p.position); v }).collect::<Vec<_>>(),
        "finished": finished.iter().map(shown).collect::<Vec<_>>(),
        "finished_limit": FINISHED_LIMIT,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_cliente_solo_aporta_lo_que_la_cola_acepta() {
        let ok = serde_json::from_value::<QueueInput>(json!({"attempt_id": "t2-a1", "request_id": "q-1", "body": "sigue"}));
        assert!(ok.is_ok());
        for extra in ["attachments", "author", "client_id", "status"] {
            let mut v = json!({"attempt_id": "t2-a1", "request_id": "q-1", "body": "sigue"});
            v[extra] = json!("x");
            assert!(serde_json::from_value::<QueueInput>(v).is_err(), "{extra} no se acepta: el autor sale de la identidad autenticada");
        }
        assert!(serde_json::from_value::<QueueInput>(json!({"attempt_id": "t2-a1", "body": "sigue"})).is_err(), "la clave de idempotencia es obligatoria");
    }
}
