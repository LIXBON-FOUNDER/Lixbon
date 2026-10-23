//! Vocabulario canónico del orquestador: los ids de máquina que ya viajan por
//! `state.json`, `/rpc` y los comandos `orch_*`, reunidos en un solo sitio.
//!
//! - Es **dominio**: solo ids estables, ningún texto de interfaz. Las etiquetas
//!   que ve la persona (Desktop, móvil, CLI) son presentación y viven en
//!   `contracts/status-vocabulary.json` (sección `presentation`), que el Core no
//!   carga.
//! - **No cambia nada**: no hay enums nuevos ni se toca `Status`/`Kind`; no
//!   cambia el formato de `state.json` ni de HTTP. Son constantes con pruebas
//!   que fallan si el código y `contracts/status-vocabulary.json` se desvían.
//! - Los ids «reservados» (intento, estado derivado de la tarea, kinds de
//!   Attention, eventos durables) son nombres acordados en el modelo del runtime,
//!   **sin consumidores todavía**: no son API pública hasta el corte
//!   Task/Attempt. Los slices que los usen (G, E, el corte) los importan de aquí.
//!
//! Ver `docs/VOCABULARIO.md`.

// Sin consumidores en producción hasta los slices G/E y el corte Task/Attempt:
// hoy solo las pruebas leen estas constantes.
#![allow(dead_code)]

use super::state::Status;

/// Ids de `Task.status`, en el orden del enum.
pub const TASK_STATUS: [&str; 8] = [
    "starting",
    "running",
    "waiting",
    "awaiting_terminal_approval",
    "done",
    "failed",
    "stopped",
    "exited",
];

/// Todos los estados de la tarea. `task_status_id` los recorre con un `match`
/// exhaustivo: añadir una variante a `Status` no compila hasta decidir su id aquí.
pub const TASK_STATUS_ALL: [Status; 8] = [
    Status::Starting,
    Status::Running,
    Status::Waiting,
    Status::AwaitingTerminalApproval,
    Status::Done,
    Status::Failed,
    Status::Stopped,
    Status::Exited,
];

/// Id de máquina de un estado; es el mismo texto que serializa serde.
pub const fn task_status_id(s: Status) -> &'static str {
    match s {
        Status::Starting => "starting",
        Status::Running => "running",
        Status::Waiting => "waiting",
        Status::AwaitingTerminalApproval => "awaiting_terminal_approval",
        Status::Done => "done",
        Status::Failed => "failed",
        Status::Stopped => "stopped",
        Status::Exited => "exited",
    }
}

/// RESERVADO. Estado derivado de la Task tras el corte Task/Attempt.
pub const TASK_DERIVED_STATE: [&str; 5] = ["open", "in_progress", "in_review", "integrated", "discarded"];

/// RESERVADO. Estados del Attempt: los de la tarea (mismos ids, para que
/// `state.json` no cambie al hacer el corte) más `pending_approval`, que hoy vive
/// fuera de la Task como lanzamiento pendiente.
pub const ATTEMPT_STATE: [&str; 9] = [
    "pending_approval",
    "starting",
    "running",
    "waiting",
    "awaiting_terminal_approval",
    "done",
    "failed",
    "stopped",
    "exited",
];

/// Estados de un lanzamiento pendiente de aprobación (`spawn_status`, `orch-spawn-resolved`).
pub const PENDING_SPAWN_STATE: [&str; 5] = ["pending", "approved", "rejected", "launch_failed", "expired"];

/// Tipos de mensaje del buzón (`Kind`).
pub const MESSAGE_KIND: [&str; 6] = ["phase", "done", "question", "reply", "note", "exited"];

/// `Decision.kind` que emite el código hoy.
pub const DECISION_KIND: [&str; 4] = ["merge", "pr", "review", "spawn"];

/// `Task.failure_reason`.
pub const FAILURE_REASON: [&str; 2] = ["terminal_approval_timeout", "agent_idle_timeout"];

/// `Task.delivery_channel`.
pub const DELIVERY_CHANNEL: [&str; 5] = ["exec_o", "stream_json", "report_json", "stdout", "lxo_done"];

/// `policy.status` (estado de la política de permisos, no de la tarea).
pub const POLICY_STATUS: [&str; 3] = ["ok", "blocked", "unverified"];

/// `last_review.decision`.
pub const REVIEW_DECISION: [&str; 2] = ["accepted", "rejected"];

/// `last_integration.outcome` de las decisiones `merge` registradas.
pub const INTEGRATION_OUTCOME: [&str; 4] = ["merged", "conflict", "error", "target_moved"];

/// Kinds de Attention, de más a menos urgente. Hoy se calculan solo en el
/// frontend (`src/orch/attention.js`); el slice G los lleva al Core.
pub const ATTENTION_KIND: [&str; 4] = ["approve_in_terminal", "integrate", "review", "failed"];

/// RESERVADO. `events.entity_kind` (slice E) y prefijo de los eventos durables.
pub const ENTITY_KIND: [&str; 13] = [
    "project", "task", "attempt", "provider_session", "thread", "worktree", "artifact", "review", "integration", "agent", "decision", "policy", "attention",
];

/// RESERVADO. Eventos de dominio durables (`entidad.verbo`), slice E.
pub const DURABLE_EVENT: [&str; 40] = [
    "project.registered", "project.archived", "project.relocated",
    "task.created", "task.updated", "task.closed",
    "attempt.requested", "attempt.approved", "attempt.rejected", "attempt.started", "attempt.waiting", "attempt.completed", "attempt.failed", "attempt.stopped",
    "provider_session.opened", "provider_session.bound", "provider_session.resumed", "provider_session.detached", "provider_session.closed",
    "thread.created", "thread.summarized", "worktree.created", "worktree.adopted", "worktree.attached", "worktree.missing", "worktree.found", "worktree.removed", "artifact.created",
    "review.requested", "review.completed", "review.invalidated",
    "integration.requested", "integration.completed", "integration.conflict",
    "agent.question", "agent.answered", "decision.created", "policy.warning",
    "attention.created", "attention.resolved",
];

/// RESERVADO. Eventos efímeros (UI en vivo, sin registro durable).
pub const EPHEMERAL_EVENT: [&str; 5] = ["attempt.progress", "terminal.output", "agent.typing", "token.stream", "tool.progress"];

#[cfg(test)]
mod tests {
    use super::super::{agents, approval, delivery, state};
    use super::*;
    use serde_json::Value;

    const CONTRATO: &str = include_str!("../../../../../contracts/status-vocabulary.json");

    fn contrato() -> Value {
        serde_json::from_str(CONTRATO).expect("contracts/status-vocabulary.json es JSON válido")
    }

    fn ids_de(v: &Value, seccion: &str) -> Vec<String> {
        v["domain"][seccion]["ids"]
            .as_array()
            .unwrap_or_else(|| panic!("domain.{seccion}.ids"))
            .iter()
            .map(|x| x.as_str().expect("id de texto").to_string())
            .collect()
    }

    fn assert_ids(seccion: &str, codigo: &[&str]) {
        let json = ids_de(&contrato(), seccion);
        let codigo: Vec<String> = codigo.iter().map(|s| s.to_string()).collect();
        assert_eq!(codigo, json, "domain.{seccion} del contrato y vocab.rs deben coincidir (mismo orden)");
        let mut sin_repetir = json.clone();
        sin_repetir.sort();
        sin_repetir.dedup();
        assert_eq!(sin_repetir.len(), json.len(), "domain.{seccion}: ids repetidos");
    }

    #[test]
    fn cada_variante_de_status_tiene_id_y_es_el_que_serializa_serde() {
        let json = contrato();
        let items = json["domain"]["task_status"]["items"].as_array().unwrap();
        assert_eq!(items.len(), TASK_STATUS_ALL.len());
        for (i, s) in TASK_STATUS_ALL.iter().enumerate() {
            let id = task_status_id(*s);
            assert_eq!(id, TASK_STATUS[i]);
            assert_eq!(serde_json::to_value(s).unwrap(), Value::String(id.into()), "serde y vocab.rs difieren en {s:?}");
            assert_eq!(serde_json::from_value::<Status>(Value::String(id.into())).unwrap(), *s);
            assert_eq!(items[i]["id"], id);
            assert_eq!(items[i]["final"].as_bool(), Some(s.is_final()), "final de {id}");
        }
    }

    #[test]
    fn mensajes_y_motivos_del_codigo_coinciden_con_el_contrato() {
        assert_ids("message_kind", &MESSAGE_KIND);
        for id in MESSAGE_KIND {
            let k = state::Kind::parse(id).unwrap_or_else(|| panic!("Kind::parse no conoce {id}"));
            assert_eq!(serde_json::to_value(&k).unwrap(), Value::String(id.into()));
        }
        assert_ids("failure_reason", &FAILURE_REASON);
        assert_eq!([approval::Timeout::Approval.reason(), approval::Timeout::Idle.reason()], FAILURE_REASON);
        assert_ids("policy_status", &POLICY_STATUS);
        for (s, id) in [(agents::Status::Ok, "ok"), (agents::Status::Blocked, "blocked"), (agents::Status::Unverified, "unverified")] {
            assert_eq!(serde_json::to_value(s).unwrap(), Value::String(id.into()));
            assert!(POLICY_STATUS.contains(&id));
        }
    }

    #[test]
    fn canales_de_entrega_coinciden() {
        assert_ids("delivery_channel", &DELIVERY_CHANNEL);
        let ids = [delivery::Channel::ExecO, delivery::Channel::StreamJson, delivery::Channel::ReportJson, delivery::Channel::Stdout].map(|c| c.id());
        assert_eq!(&DELIVERY_CHANNEL[..4], &ids);
        // `lxo_done` lo escribe `rpc.rs` directamente (no pasa por `Channel`).
        assert!(include_str!("rpc.rs").contains("Some(\"lxo_done\".into())"));
    }

    #[test]
    fn ids_que_viven_como_texto_en_el_codigo_aparecen_en_su_fuente() {
        assert_ids("pending_spawn_state", &PENDING_SPAWN_STATE);
        let aprobacion = include_str!("spawn_approval.rs");
        for id in PENDING_SPAWN_STATE {
            assert!(aprobacion.contains(&format!("\"{id}\"")), "spawn_approval.rs ya no menciona {id}");
        }
        assert_ids("integration_outcome", &INTEGRATION_OUTCOME);
        let integracion = include_str!("integration.rs");
        for id in INTEGRATION_OUTCOME {
            assert!(integracion.contains(&format!("\"{id}\"")), "integration.rs ya no menciona {id}");
        }
        assert_ids("review_decision", &REVIEW_DECISION);
        assert!(include_str!("review.rs").contains("[\"accepted\", \"rejected\"]"));
        assert_ids("decision_kind", &DECISION_KIND);
        let fuentes = [include_str!("integration.rs"), include_str!("review.rs"), include_str!("spawn_approval.rs")].concat();
        for id in DECISION_KIND {
            assert!(fuentes.contains(&format!(", \"{id}\", ")), "ningún record_decision emite ya {id}");
        }
    }

    #[test]
    fn los_ids_reservados_cuadran_con_el_contrato_y_con_los_vigentes() {
        assert_ids("attention_kind", &ATTENTION_KIND);
        assert_ids("task_derived_state", &TASK_DERIVED_STATE);
        assert_ids("entity_kind", &ENTITY_KIND);
        let json = contrato();
        let durables: Vec<String> = json["domain"]["event"]["dominio_durable_reservado"]["ids"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(durables, DURABLE_EVENT.map(String::from).to_vec());
        let efimeros: Vec<String> = json["domain"]["event"]["efimeros_reservados"]["ids"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(efimeros, EPHEMERAL_EVENT.map(String::from).to_vec());
        // Todo evento durable es `entidad.verbo` con una entidad conocida, y toda entidad tiene eventos.
        for e in DURABLE_EVENT {
            let (entidad, verbo) = e.split_once('.').unwrap_or_else(|| panic!("{e}: falta el punto"));
            assert!(ENTITY_KIND.contains(&entidad), "{e}: entidad desconocida");
            assert!(!verbo.is_empty() && !verbo.contains('.'), "{e}: verbo mal formado");
        }
        for k in ENTITY_KIND {
            assert!(DURABLE_EVENT.iter().any(|e| e.starts_with(&format!("{k}."))), "entity_kind {k} sin eventos");
        }
        // Los efímeros no son durables, y los durables del intento cubren sus estados.
        assert!(EPHEMERAL_EVENT.iter().all(|e| !DURABLE_EVENT.contains(e)));
        let attempt = ids_de(&json, "attempt_state");
        assert_eq!(attempt, ATTEMPT_STATE.map(String::from).to_vec());
        // El intento reutiliza los ids de la tarea; solo `pending_approval` es nuevo.
        for id in ATTEMPT_STATE.iter().filter(|i| **i != "pending_approval") {
            assert!(TASK_STATUS.contains(id), "el estado de intento {id} no existe como estado de tarea");
        }
        assert_eq!(ATTEMPT_STATE.len(), TASK_STATUS.len() + 1);
        for item in json["domain"]["task_status"]["items"].as_array().unwrap() {
            assert!(ATTEMPT_STATE.contains(&item["attempt_state"].as_str().unwrap()));
        }
        let finales: Vec<&str> = json["domain"]["attempt_state"]["final"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        let finales_tarea: Vec<&str> = TASK_STATUS_ALL.iter().filter(|s| s.is_final()).map(|s| task_status_id(*s)).collect();
        assert_eq!(finales, finales_tarea);
        // Los kinds de Attention nunca chocan con un estado de tarea sin querer, salvo `failed`
        // (mismo concepto: la tarea falló).
        let choques: Vec<&&str> = ATTENTION_KIND.iter().filter(|k| TASK_STATUS.contains(k)).collect();
        assert_eq!(choques, vec![&"failed"]);
    }

    #[test]
    fn el_dominio_no_lleva_textos_de_interfaz() {
        // Dentro de cada sección de `domain` solo caben estas claves: ids, estados y
        // procedencia. Una etiqueta («label», «titulo»…) haría fallar la prueba.
        const PERMITIDAS: &[&str] = &[
            "_comment", "estado", "origen", "items", "ids", "final", "pendiente_de_decidir", "ids_de_resultado_no_estado",
            "reservados", "nota_reservados", "severidad", "ids_de_resultado_no_registrados", "transporte_ui_vigente",
            "dominio_durable_reservado", "efimeros_reservados", "id", "attempt_state",
        ];
        fn revisar(v: &Value, ruta: &str) {
            match v {
                Value::Object(m) => {
                    for (k, hijo) in m {
                        assert!(PERMITIDAS.contains(&k.as_str()), "domain.{ruta}.{k}: clave no permitida (¿texto de interfaz en el dominio?)");
                        revisar(hijo, &format!("{ruta}.{k}"));
                    }
                }
                Value::Array(a) => a.iter().for_each(|h| revisar(h, ruta)),
                _ => {}
            }
        }
        let json = contrato();
        for (nombre, seccion) in json["domain"].as_object().unwrap() {
            if nombre != "_comment" {
                revisar(seccion, nombre);
            }
        }
        assert!(json.get("presentation").is_some(), "las etiquetas viven en `presentation`");
    }
}
