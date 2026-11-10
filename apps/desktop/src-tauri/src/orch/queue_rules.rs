//! Reglas Events → Attention de la Pending Queue (LXO-143). Contrato: `docs/core/COLA.md` y `docs/core/ATTENTION.md`.
//!
//! Igual que `attention_rules::derive`, es una función pura de UN Event (sin estado, reloj ni E/S). Vive aparte para no
//! mezclar las reglas de la cola con las del resto del Attempt; `attention_rules::derive` la llama una vez, antes de sus
//! propias reglas, y las dos suman intenciones al mismo [`Derived`].
//!
//! | Event (`kind`, condición) | Attention | Severidad | Hecho (target · subject) |
//! |---|---|---|---|
//! | `attempt.queue_failed` con `reason` ≠ `attempt_ended` | levanta `failed` | high | attempt · `queue` |
//! | `attempt.completed` · `failed` · `stopped` · `exited` | resuelve `failed` (`condition_cleared`) | | attempt · `queue` |
//!
//! * **Un solo hecho por Attempt** (subject `queue`, sin el id del item): si fallan varios, la Attention activa se
//!   actualiza con el último (`facts.queue_id`, `facts.failure_reason`). El detalle de cada uno está en la Pending Queue y
//!   en los Events.
//! * **`attempt_ended` no levanta nada**: el Attempt ya terminó y nada de lo que se haga sobre él tiene remedio; la
//!   Activity lo cuenta. Si lo hiciera, la Attention nacería DESPUÉS del evento final que la habría cerrado y quedaría
//!   abierta para siempre.
//! * **Se cierra sola** cuando el Attempt termina, igual que la espera de aprobación en la terminal.

use serde_json::{json, Map, Value};

use crate::store::{AttentionCategory, Derived, EventRow, Resolution, Severity, TargetKind};

/// Subject del hecho: el mismo para todos los fallos de la cola de un Attempt.
const QUEUE: &str = "queue";

/// Un código o id corto del payload (nunca texto libre): como mucho 80 caracteres y sin controles.
fn code(v: &Value) -> Option<Value> {
    let s = v.as_str()?;
    (!s.is_empty() && s.chars().count() <= 80 && !s.chars().any(char::is_control)).then(|| json!(s))
}

/// Suma a `d` lo que este Event significa para la Pending Queue (nada si no le concierne).
pub(super) fn derive_into(e: &EventRow, p: &Value, d: &mut Derived) {
    if e.entity_kind != "attempt" {
        return;
    }
    let id = e.entity_id.as_str();
    match e.kind.as_str() {
        "attempt.queue_failed" if p["reason"].as_str().is_some_and(|r| r != "attempt_ended") => {
            let mut facts = Map::new();
            for (from, to) in [("task", "task"), ("queue_id", "queue_id"), ("reason", "failure_reason")] {
                if let Some(c) = code(&p[from]) {
                    facts.insert(to.into(), c);
                }
            }
            d.raise(AttentionCategory::Failed, TargetKind::Attempt, id, Some(QUEUE.into()), Severity::High, Value::Object(facts));
        }
        "attempt.completed" | "attempt.failed" | "attempt.stopped" | "attempt.exited" => {
            d.resolve(AttentionCategory::Failed, TargetKind::Attempt, id, Some(QUEUE.into()), Resolution::ConditionCleared);
        }
        _ => {}
    }
}
