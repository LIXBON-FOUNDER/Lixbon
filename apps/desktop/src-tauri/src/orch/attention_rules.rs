//! Reglas deterministas Events → Attention (LXO-88).
//!
//! Aquí viven SOLO las reglas: [`derive`] es una función pura de UN Event (no lee `State`, git, el reloj, el cliente
//! ni SQL), así que el mismo log produce la misma Attention y un replay desde cero converge al estado incremental.
//! El driver transaccional (aplicar las intenciones, descartar señales antiguas por `seq`, emitir `attention.created`
//! / `attention.resolved`) es `store::attention_projection`, que el Core instala en su almacén y ejecutan los
//! escritores autoritativos del Event Log dentro de su propia transacción.
//!
//! # Tabla Event → Attention
//! | Event (`kind`, condición) | Attention | Severidad | Hecho (target · subject) |
//! |---|---|---|---|
//! | `task.question` | levanta `question` | medium | task · id del mensaje |
//! | `task.reply` | resuelve `question` (`acted`) | | task que preguntó · `question_id` |
//! | `spawn.requested` con `policy_status` `ok`/`unverified` | levanta `approval` | medium | spawn_request |
//! | `spawn.requested` con `policy_status = blocked` | levanta `risk` | high | spawn_request |
//! | `spawn.resolved` `approved`/`rejected`/`launch_failed` | resuelve `approval` (`acted`) | | spawn_request |
//! | `spawn.resolved` `timeout`/`coordinator_closed`/`cancelled_run_removed` | resuelve `approval` (`condition_cleared`) | | spawn_request |
//! | `task.status_changed` a `awaiting_terminal_approval` | levanta `approval` | medium | task · `terminal` |
//! | `task.status_changed` desde `awaiting_terminal_approval` | resuelve `approval` (`acted` si vuelve a `starting`/`running`/`waiting`; `condition_cleared` si termina) | | task · `terminal` |
//! | `task.status_changed` a `failed` | levanta `failed` | high | task |
//! | `task.status_changed` desde `failed` | resuelve `failed` (`condition_cleared`) | | task |
//! | `decision.recorded` `merge` con `outcome = conflict` | levanta `conflict` (si ya estaba activo, actualiza sus `facts`) | high | task |
//! | `decision.recorded` `merge` con `outcome = merged` | resuelve `conflict` y `review_ready` (`acted`) | | task |
//! | `task.review_requested` | levanta `review_ready` | medium | task |
//! | `decision.recorded` `review` con `outcome` `accepted` / `rejected` | resuelve `review_ready` (`acted`) | | task |
//! | `task.status_changed` desde `done` (la entrega se reabre) | resuelve `review_ready` (`condition_cleared`) | | task |
//! | `environment.blocked` (`code` cerrado, `profile` conocido) | levanta `environment_blocked` | high | agent (proveedor) · `code@profile` |
//! | `environment.cleared` (`code`, `profile`) | resuelve `environment_blocked` (`condition_cleared`) | | agent · `code@profile` |
//! | `task.removed` | resuelve `failed`, `conflict`, `review_ready` y `approval` (terminal) de esa task (`condition_cleared`) | | task |
//! | `attempt.requested` con `approval_required` (LXO-119) | levanta `approval` | medium | attempt · `launch` |
//! | `attempt.approved` · `attempt.rejected` | resuelve `approval` (`acted`) | | attempt · `launch` |
//! | `attempt.failed` | levanta `failed` | high | attempt |
//!
//! Los hechos de EJECUCIÓN del modelo Task/Attempt apuntan al Attempt, no a la Task: dos Attempts de una Task tienen
//! su propia Attention. Solo existen tras el corte (los `task.*` históricos siguen con sus reglas; ADR D10).
//!
//! `risk` nace SOLO de `spawn.requested.policy_status = blocked`, y ese Event solo se emite para una denegación
//! explícita de policy (`agents::explicit_denial`); los bloqueos del entorno y la entrada inválida no dejan
//! `spawn.requested` (ver `spawn_approval::spawn_request`): el entorno deja `environment.blocked`. No hay regla que
//! resuelva `risk` sola: no hay un Event que lo cierre.
//!
//! `review_ready` y `environment_blocked` nacen SOLO de sus Events fuente explícitos (`Tx::done` y la comprobación de
//! policy del host); ninguna regla los deduce de la rama, del estado, de la ausencia de una decisión ni de un `failed`.
//! Todo lo demás (incluidos `ok` y `unverified` como riesgo y un fallo genérico) NO produce Attention desde aquí;
//! ver `docs/core/ATTENTION.md`.

use serde_json::{json, Map, Value};

use super::agents::{EnvBlock, Profile};
use crate::store::{AttentionCategory, AttentionRules, Derived, EventRow, Resolution, Severity, TargetKind};

/// Un código o id corto del payload (nunca texto libre): como mucho 64 caracteres y sin controles.
fn code(v: &Value) -> Option<Value> {
    let s = v.as_str()?;
    (!s.is_empty() && s.chars().count() <= 64 && !s.chars().any(char::is_control)).then(|| json!(s))
}

fn copy_codes(from: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for k in keys {
        if let Some(c) = code(&from[*k]) {
            out.insert((*k).to_string(), c);
        }
    }
    Value::Object(out)
}

const TERMINAL: &str = "terminal";
/// Subject de la aprobación de lanzar un Attempt (`pending_approval`).
const LAUNCH: &str = "launch";

/// El alcance de un `environment.*`: la causa (del conjunto cerrado `EnvBlock`) y el perfil (de los conocidos). Un código
/// o un perfil fuera de esos conjuntos no es una señal y no levanta ni resuelve nada.
fn env_scope(p: &Value) -> Option<(EnvBlock, String)> {
    let code = EnvBlock::parse(p["code"].as_str()?)?;
    let profile = p["profile"].as_str().filter(|prof| Profile::parse(prof).is_some_and(|known| known.id() == *prof))?;
    Some((code, profile.to_string()))
}

/// Un hecho por causa Y perfil: un preflight de otro perfil no resuelve el de éste.
fn env_subject(code: EnvBlock, profile: &str) -> String {
    format!("{}@{profile}", code.code())
}

/// LAS REGLAS. Función pura de un Event: sin estado, sin reloj, sin E/S.
pub(super) fn derive(e: &EventRow) -> Derived {
    use AttentionCategory as C;
    let mut d = Derived::default();
    let Ok(p) = serde_json::from_str::<Value>(&e.payload) else { return d };
    let (kind, id) = (e.entity_kind.as_str(), e.entity_id.as_str());
    match (e.kind.as_str(), kind) {
        ("task.question", "task") => {
            if let Some(message) = p["message_id"].as_u64() {
                let mut facts = copy_codes(&p, &["to"]);
                facts["message_id"] = json!(message);
                d.raise(C::Question, TargetKind::Task, id, Some(message.to_string()), Severity::Medium, facts);
            }
        }
        ("task.reply", "task") => {
            if let Some(question) = p["question_id"].as_u64() {
                d.resolve(C::Question, TargetKind::Task, id, Some(question.to_string()), Resolution::Acted);
            }
        }
        ("spawn.requested", "spawn_request") => {
            let mut facts = copy_codes(&p, &["parent_task", "provider", "profile", "policy_status"]);
            match p["policy_status"].as_str() {
                Some("blocked") => d.raise(C::Risk, TargetKind::SpawnRequest, id, None, Severity::High, facts),
                Some("ok" | "unverified") => {
                    facts["policy_status"] = p["policy_status"].clone();
                    d.raise(C::Approval, TargetKind::SpawnRequest, id, None, Severity::Medium, facts);
                }
                _ => {}
            }
        }
        ("spawn.resolved", "spawn_request") => match p["outcome"].as_str() {
            Some("approved" | "rejected" | "launch_failed") => d.resolve(C::Approval, TargetKind::SpawnRequest, id, None, Resolution::Acted),
            Some("timeout" | "coordinator_closed" | "cancelled_run_removed") => d.resolve(C::Approval, TargetKind::SpawnRequest, id, None, Resolution::ConditionCleared),
            _ => {}
        },
        ("task.status_changed", "task") => {
            let (from, to) = (p["from"].as_str().unwrap_or(""), p["to"].as_str().unwrap_or(""));
            if from == "awaiting_terminal_approval" && to != from {
                let resolution = if matches!(to, "starting" | "running" | "waiting") { Resolution::Acted } else { Resolution::ConditionCleared };
                d.resolve(C::Approval, TargetKind::Task, id, Some(TERMINAL.into()), resolution);
            }
            if to == "awaiting_terminal_approval" && from != to {
                d.raise(C::Approval, TargetKind::Task, id, Some(TERMINAL.into()), Severity::Medium, json!({}));
            }
            if from == "failed" && to != from {
                d.resolve(C::Failed, TargetKind::Task, id, None, Resolution::ConditionCleared);
            }
            // La tarea entregada se reabre: la revisión pendiente queda superada (la nueva entrega pedirá otra).
            if from == "done" && to != from {
                d.resolve(C::ReviewReady, TargetKind::Task, id, None, Resolution::ConditionCleared);
            }
            if to == "failed" && from != to {
                let mut facts = Map::new();
                if let Some(cause) = code(&p["cause"]) {
                    facts.insert("failure_reason".into(), cause);
                }
                d.raise(C::Failed, TargetKind::Task, id, None, Severity::High, Value::Object(facts));
            }
        }
        ("decision.recorded", "task") if p["decision_kind"] == "merge" => match p["outcome"].as_str() {
            Some("conflict") => {
                let mut facts = copy_codes(&p, &["branch"]);
                if let Some(n) = p["conflict_count"].as_u64() {
                    facts["conflict_count"] = json!(n);
                }
                d.raise(C::Conflict, TargetKind::Task, id, None, Severity::High, facts);
            }
            Some("merged") => {
                d.resolve(C::Conflict, TargetKind::Task, id, None, Resolution::Acted);
                d.resolve(C::ReviewReady, TargetKind::Task, id, None, Resolution::Acted);
            }
            _ => {}
        },
        // La revisión de la persona (aceptar o rechazar) es la decisión que cierra la espera de revisión.
        ("decision.recorded", "task") if p["decision_kind"] == "review" && matches!(p["outcome"].as_str(), Some("accepted" | "rejected")) => {
            d.resolve(C::ReviewReady, TargetKind::Task, id, None, Resolution::Acted)
        }
        ("task.review_requested", "task") => d.raise(C::ReviewReady, TargetKind::Task, id, None, Severity::Medium, copy_codes(&p, &["branch"])),
        ("environment.blocked", "agent") => {
            if let Some((code, profile)) = env_scope(&p) {
                let facts = json!({ "provider": id, "profile": profile, "code": code.code() });
                d.raise(C::EnvironmentBlocked, TargetKind::Agent, id, Some(env_subject(code, &profile)), Severity::High, facts);
            }
        }
        ("environment.cleared", "agent") => {
            if let Some((code, profile)) = env_scope(&p) {
                d.resolve(C::EnvironmentBlocked, TargetKind::Agent, id, Some(env_subject(code, &profile)), Resolution::ConditionCleared);
            }
        }
        ("attention.risk_acted", "attention") if p["resolution"] == "acted" => {
            d.resolve_id(C::Risk, id, Resolution::Acted);
        }
        ("attempt.requested", "attempt") if p["approval_required"] == true => {
            d.raise(C::Approval, TargetKind::Attempt, id, Some(LAUNCH.into()), Severity::Medium, copy_codes(&p, &["task", "provider"]))
        }
        ("attempt.approved" | "attempt.rejected", "attempt") => d.resolve(C::Approval, TargetKind::Attempt, id, Some(LAUNCH.into()), Resolution::Acted),
        ("attempt.failed", "attempt") => {
            let mut facts = copy_codes(&p, &["task"]);
            if let Some(reason) = code(&p["reason"]) {
                facts["failure_reason"] = reason;
            }
            d.raise(C::Failed, TargetKind::Attempt, id, None, Severity::High, facts);
        }
        ("task.removed", "task") => {
            d.resolve(C::Failed, TargetKind::Task, id, None, Resolution::ConditionCleared);
            d.resolve(C::Conflict, TargetKind::Task, id, None, Resolution::ConditionCleared);
            d.resolve(C::ReviewReady, TargetKind::Task, id, None, Resolution::ConditionCleared);
            d.resolve(C::Approval, TargetKind::Task, id, Some(TERMINAL.into()), Resolution::ConditionCleared);
        }
        _ => {}
    }
    d
}

/// Las reglas de `derive`, como las consume el almacén.
#[derive(Debug)]
pub(super) struct EventRules;

impl AttentionRules for EventRules {
    fn derive(&self, event: &EventRow) -> Derived {
        derive(event)
    }
}
