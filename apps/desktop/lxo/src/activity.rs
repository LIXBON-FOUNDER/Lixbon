//! Texto de Activity para `lxo task show` (LXO-38).
//!
//! El Core devuelve una clave de mensaje con sus argumentos (`docs/core/ACTIVITY.md`); cada cliente la traduce.
//! Esta es la traducción de `apps/desktop/src/ade/activityMessages.js` a Rust, con las mismas frases y las
//! mismas reglas: un argumento que falta o que no es del tipo esperado deja el item sin texto (`None`), nunca
//! una frase inventada. Las dos traducciones comparten `docs/core/fixtures/activity_messages_es.json`, que
//! comprueban la prueba de Desktop y la de aquí: al cambiar una frase hay que cambiar las dos en el mismo PR.

use serde_json::{Map, Value};

const MAX_ARGUMENT_LENGTH: usize = 120;
const MAX_MESSAGE_LENGTH: usize = 480;

pub(crate) const MESSAGE_KEYS: [&str; 100] = [
    "activity.run.created",
    "activity.run.closed",
    "activity.run.removed",
    "activity.task.created",
    "activity.task.starting",
    "activity.task.running",
    "activity.task.waiting",
    "activity.task.awaiting_terminal_approval",
    "activity.task.done",
    "activity.task.failed",
    "activity.task.stopped",
    "activity.task.exited",
    "activity.task.phase_done",
    "activity.task.phase_started",
    "activity.task.question",
    "activity.task.reply",
    "activity.task.removed",
    "activity.task.review_requested",
    "activity.decision.review.accepted",
    "activity.decision.review.rejected",
    "activity.decision.merge.merged",
    "activity.decision.merge.conflict",
    "activity.decision.merge.error",
    "activity.decision.merge.target_moved",
    "activity.decision.pr.created",
    "activity.decision.pr.already_exists",
    "activity.decision.pr.error",
    "activity.effect.git_merge.merged",
    "activity.effect.git_merge.conflict",
    "activity.effect.git_merge.error",
    "activity.effect.git_push_pr.created",
    "activity.effect.git_push_pr.already_exists",
    "activity.effect.git_push_pr.error",
    "activity.effect.git_worktree.created",
    "activity.effect.git_worktree.removed",
    "activity.effect.process.launched",
    "activity.effect.process.not_launched",
    "activity.project.registered",
    "activity.project.location_added",
    "activity.project.archived",
    "activity.project.restored",
    "activity.policy.changed",
    "activity.project.relocated",
    "activity.spawn.requested",
    "activity.spawn.approved",
    "activity.spawn.rejected",
    "activity.spawn.launch_failed",
    "activity.spawn.timeout",
    "activity.spawn.coordinator_closed",
    "activity.spawn.cancelled_run_removed",
    "activity.environment.blocked",
    "activity.environment.cleared",
    "activity.attention.risk_acted",
    "activity.attention.created",
    "activity.attention.resolved",
    // Modelo Task/Attempt (LXO-233): intención de la Task, ejecución del Attempt y sus entidades.
    "activity.task.intent_created",
    "activity.task.updated",
    "activity.task.discarded",
    "activity.task.restored",
    "activity.attempt.requested",
    "activity.attempt.continued",
    "activity.attempt.retried",
    "activity.attempt.forked",
    "activity.attempt.approved",
    "activity.attempt.rejected",
    "activity.attempt.started",
    "activity.attempt.completed",
    "activity.attempt.failed",
    "activity.attempt.stopped",
    "activity.attempt.waiting",
    "activity.attempt.awaiting_terminal_approval",
    "activity.attempt.resumed",
    "activity.attempt.exited",
    "activity.attempt.integrated",
    "activity.attempt.queued",
    "activity.attempt.queue_delivered",
    "activity.attempt.queue_cancelled",
    "activity.attempt.queue_failed",
    "activity.attempt.instruction_requested",
    "activity.attempt.instruction_result",
    "activity.attempt.dispatch_ambiguous",
    "activity.provider_session.opened",
    "activity.provider_session.bound",
    "activity.provider_session.resumed",
    "activity.provider_session.detached",
    "activity.provider_session.closed",
    "activity.thread.created",
    "activity.thread.summarized",
    "activity.worktree.created",
    "activity.worktree.adopted",
    "activity.worktree.attached",
    "activity.worktree.missing",
    "activity.worktree.found",
    "activity.worktree.removed",
    "activity.artifact.created",
    "activity.review.accepted",
    "activity.review.rejected",
    "activity.review.invalidated",
    "activity.core.agentic_cut",
    "activity.unknown",
];

const TASK_STATUSES: [&str; 8] = [
    "starting",
    "running",
    "waiting",
    "awaiting_terminal_approval",
    "done",
    "failed",
    "stopped",
    "exited",
];

fn project_origin(code: &str) -> Option<&'static str> {
    Some(match code {
        "manual" => "registro manual",
        "auto" => "registro automático",
        "backfill" => "carga histórica",
        "import" => "importación",
        _ => return None,
    })
}

fn environment_code(code: &str) -> Option<&'static str> {
    Some(match code {
        "cli_missing" => "falta la CLI",
        "cli_flags_unsupported" => "la CLI no admite estas opciones",
        "windows_sandbox_elevated" => "el entorno de Windows requiere elevación",
        "windows_sandbox_setup" => "el sandbox de Windows no está listo o está en uso",
        _ => return None,
    })
}

fn attention_category(code: &str) -> Option<&'static str> {
    Some(match code {
        "question" => "pregunta",
        "approval" => "aprobación",
        "review_ready" => "revisión lista",
        "conflict" => "conflicto",
        "failed" => "fallo",
        "environment_blocked" => "entorno bloqueado",
        "risk" => "riesgo",
        _ => return None,
    })
}

fn attention_severity(code: &str) -> Option<&'static str> {
    Some(match code {
        "critical" => "crítica",
        "high" => "alta",
        "medium" => "media",
        "low" => "baja",
        _ => return None,
    })
}

fn resolution(code: &str) -> Option<&'static str> {
    Some(match code {
        "acted" => "se tomó una acción",
        "condition_cleared" => "la condición dejó de ocurrir",
        "superseded" => "fue reemplazada por otra incidencia",
        _ => return None,
    })
}

const STOP_CAUSES: [&str; 2] = ["cancelled", "run_closed"];
const ACTIVE_FROM: [&str; 4] = ["starting", "running", "waiting", "awaiting_terminal_approval"];

fn intent_field(code: &str) -> Option<&'static str> {
    Some(match code {
        "title" => "el título",
        "spec" => "el encargo",
        _ => return None,
    })
}

fn attempt_failure(code: &str) -> Option<&'static str> {
    Some(match code {
        "launch_failed" => "no llegó a arrancar",
        "terminal_approval_timeout" => "nadie aprobó en la terminal a tiempo",
        "agent_idle_timeout" => "el agente dejó de dar señales",
        "agent_reported" => "el agente informó el fallo",
        _ => return None,
    })
}

/// Un cambio de policy (`policy.changed`, LXO-209): ámbito, categoría, niveles del override y qué hizo con la restricción efectiva.
const POLICY_SCOPES: [&str; 3] = ["global", "project", "attempt"];
const POLICY_CATEGORIES: [&str; 10] = ["start", "answer", "queue", "steer", "stop", "fork", "review", "integrate", "cleanup", "provider_permissions"];
const POLICY_LEVELS: [&str; 4] = ["allow", "confirm", "elevated", "deny"];
const POLICY_DIRECTIONS: [&str; 4] = ["tighten", "loosen", "same", "reset"];

fn policy_category(code: &str) -> &'static str {
    match code {
        "start" => "arrancar",
        "answer" => "responder",
        "queue" => "encolar",
        "steer" => "corregir",
        "stop" => "detener",
        "fork" => "bifurcar",
        "review" => "revisar",
        "integrate" => "integrar",
        "cleanup" => "limpiar",
        _ => "permisos del proveedor",
    }
}

fn policy_level(code: &str) -> &'static str {
    match code {
        "allow" => "permitir",
        "confirm" => "confirmar",
        "elevated" => "elevado",
        _ => "denegar",
    }
}

fn policy_direction(code: &str) -> &'static str {
    match code {
        "tighten" => "más restrictiva",
        "loosen" => "menos restrictiva",
        "same" => "mismo nivel efectivo",
        _ => "vuelve a heredar",
    }
}

/// Con qué contexto arrancó un Fork (`attempt.forked`, LXO-145).
const FORK_STRATEGIES: [&str; 2] = ["clean", "context_package"];
/// Cómo se pidió una instrucción a un Attempt ocupado y cómo acabó (`attempt.instruction_*`, LXO-144).
const INSTRUCTION_MODES: [&str; 2] = ["steer", "stop_and_send"];
const INSTRUCTION_OUTCOMES: [&str; 4] = ["delivered", "failed", "stop_failed", "stop_timeout"];

/// Por qué no se entregó una instrucción de la Pending Queue (`attempt.queue_failed`, LXO-143).
fn queue_failure(code: &str) -> Option<&'static str> {
    Some(match code {
        "unsupported" => "el proveedor no admite entregarla",
        "environment_blocked" => "el entorno del proveedor está bloqueado",
        "adapter_unavailable" => "el proveedor no estaba disponible",
        "adapter_error" => "el proveedor devolvió un error",
        "attempt_ended" => "el intento ya había terminado",
        "interrupted" => "la entrega se interrumpió y no se sabe si llegó",
        _ => return None,
    })
}

fn session_binding(code: &str) -> Option<&'static str> {
    Some(match code {
        "stream_json" => "por stream-json",
        "session_id" => "por su id de sesión",
        _ => return None,
    })
}

fn continuity_strategy(code: &str) -> Option<&'static str> {
    Some(match code {
        "native_resume" => "native_resume",
        "context_package" => "context_package",
        _ => return None,
    })
}

fn continuity_reason(code: &str) -> Option<&'static str> {
    Some(match code {
        "requested" => "pedido",
        "provider_changed" => "cambió el proveedor",
        "resume_unsupported" => "el proveedor no puede reanudar",
        "session_unavailable" => "no había una sesión que reanudar",
        "session_expired" => "la sesión caducó",
        _ => return None,
    })
}

fn retry_override(code: &str) -> Option<&'static str> {
    Some(match code {
        "provider" => "otro proveedor",
        "model" => "otro modelo",
        "effort" => "otro esfuerzo",
        "profile" => "otro perfil de permisos",
        _ => return None,
    })
}

fn worktree_removal(code: &str) -> Option<&'static str> {
    Some(match code {
        "integrated" => "integrado",
        "discarded" => "descartado",
        "gone" => "ya no existía",
        _ => return None,
    })
}

fn artifact_kind(code: &str) -> Option<&'static str> {
    Some(match code {
        "report" => "un informe",
        "pull_request" => "un pull request",
        "last_message" => "su último mensaje",
        "commit" => "un commit",
        "file" => "un archivo",
        _ => return None,
    })
}

/// Caracteres de control a espacio, espacios seguidos a uno y sin bordes; recorta a `max` caracteres.
fn bounded(value: &str, max: usize) -> Option<String> {
    let normalized = value
        .chars()
        .map(|c| {
            if c.is_control() && (c as u32) < 0x80 {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        return None;
    }
    // Como `String.length` de JavaScript: se cuenta en unidades UTF-16.
    if normalized.encode_utf16().count() > max {
        let mut out = String::new();
        let mut units = 0;
        for c in normalized.chars() {
            if units + c.len_utf16() > max - 1 {
                break;
            }
            units += c.len_utf16();
            out.push(c);
        }
        out.push('…');
        return Some(out);
    }
    Some(normalized)
}

/// Lectura de los argumentos de un item, con las mismas reglas que la traducción de Desktop.
struct A<'a>(&'a Map<String, Value>);

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

impl A<'_> {
    fn get(&self, key: &str) -> &Value {
        self.0.get(key).unwrap_or(&Value::Null)
    }

    fn present(&self, key: &str) -> bool {
        !self.get(key).is_null()
    }

    fn text(&self, key: &str) -> Option<String> {
        self.get(key)
            .as_str()
            .and_then(|s| bounded(s, MAX_ARGUMENT_LENGTH))
    }

    /// `Some(None)` si falta; `None` si está pero no vale (el item se queda sin texto).
    fn optional_text(&self, key: &str) -> Option<Option<String>> {
        if !self.present(key) {
            return Some(None);
        }
        self.text(key).map(Some)
    }

    fn number(&self, key: &str) -> Option<u64> {
        let value = self.get(key);
        value
            .as_u64()
            .or_else(|| {
                value
                    .as_f64()
                    .filter(|f| f.fract() == 0.0 && *f >= 0.0)
                    .map(|f| f as u64)
            })
            .filter(|n| *n <= MAX_SAFE_INTEGER)
    }

    fn optional_number(&self, key: &str) -> Option<Option<u64>> {
        if !self.present(key) {
            return Some(None);
        }
        self.number(key).map(Some)
    }

    fn identifier(&self, key: &str) -> Option<String> {
        if self.get(key).is_string() {
            return self.text(key);
        }
        self.number(key).map(|n| n.to_string())
    }

    fn boolean(&self, key: &str) -> Option<bool> {
        self.get(key).as_bool()
    }

    fn code<'v>(&'v self, key: &str, allowed: &[&str]) -> Option<&'v str> {
        self.get(key).as_str().filter(|v| allowed.contains(v))
    }

    fn code_in<T>(&self, key: &str, table: fn(&str) -> Option<T>) -> Option<T> {
        self.get(key).as_str().and_then(table)
    }
}

fn details(parts: &[Option<String>]) -> String {
    let present: Vec<&str> = parts.iter().flatten().map(String::as_str).collect();
    if present.is_empty() {
        String::new()
    } else {
        format!(" ({})", present.join("; "))
    }
}

fn plural(count: u64, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn merge(key: &str, a: &A) -> Option<String> {
    let decision = a.number("decision_id")?;
    let branch = a.text("branch")?;
    let squash = a.boolean("squash")?;
    let conflicts = a.optional_number("conflict_count")?;
    let subject = format!("la rama «{branch}» (decisión {decision})");
    Some(if key.ends_with(".merged") {
        format!(
            "Se integró {subject}{}.",
            if squash { " mediante squash" } else { "" }
        )
    } else if key.ends_with(".conflict") {
        let count = conflicts
            .map(|n| format!(" ({})", plural(n, "conflicto", "conflictos")))
            .unwrap_or_default();
        format!("Hubo conflictos al integrar {subject}{count}.")
    } else if key.ends_with(".target_moved") {
        format!("No se integró {subject} porque cambió el destino.")
    } else {
        format!("Falló la integración de {subject}.")
    })
}

fn pull_request(key: &str, a: &A, id_field: &str, id_label: &str) -> Option<String> {
    let id = a.identifier(id_field)?;
    let branch = a.text("branch")?;
    let has_url = a.boolean("has_pr_url")?;
    let suffix = if has_url {
        " con enlace al pull request"
    } else {
        ""
    };
    Some(if key.ends_with(".created") {
        format!("Se creó un pull request para «{branch}» ({id_label} {id}){suffix}.")
    } else if key.ends_with(".already_exists") {
        format!("Ya existe un pull request para «{branch}» ({id_label} {id}){suffix}.")
    } else {
        format!("No se pudo crear el pull request para «{branch}» ({id_label} {id}){suffix}.")
    })
}

fn task_status(key: &str, a: &A) -> Option<String> {
    let _from = a.code("from", &TASK_STATUSES)?;
    let to = a.code("to", &TASK_STATUSES)?;
    a.optional_text("cause")?;
    if Some(to) != key.strip_prefix("activity.task.") {
        return None;
    }
    Some(
        match to {
            "starting" => "La tarea está iniciando.",
            "running" => "La tarea está en ejecución.",
            "waiting" => "La tarea está en espera.",
            "awaiting_terminal_approval" => "La tarea espera aprobación para abrir una terminal.",
            "done" => "La tarea terminó correctamente.",
            "failed" => "La tarea falló.",
            "stopped" => "La tarea se detuvo.",
            "exited" => "La tarea salió con error.",
            _ => return None,
        }
        .into(),
    )
}

fn spawn_resolved(key: &str, a: &A) -> Option<String> {
    let has_reason = a.boolean("has_reason")?;
    let task = a.optional_text("task")?;
    let outcome = match key {
        "activity.spawn.approved" => "La solicitud de lanzamiento fue aprobada",
        "activity.spawn.rejected" => "La solicitud de lanzamiento fue rechazada",
        "activity.spawn.launch_failed" => "No se pudo iniciar la tarea solicitada",
        "activity.spawn.timeout" => "La solicitud de lanzamiento venció por tiempo",
        "activity.spawn.coordinator_closed" => "La solicitud terminó al cerrarse el coordinador",
        "activity.spawn.cancelled_run_removed" => {
            "La solicitud se canceló al eliminarse la ejecución"
        }
        _ => return None,
    };
    Some(format!(
        "{outcome}{}.",
        details(&[
            task.map(|t| format!("tarea {t}")),
            has_reason.then(|| "con motivo registrado".into()),
        ])
    ))
}

/// «intento N de la tarea T» (sin artículo): las claves de un Attempt nombran siempre su Task y su número.
fn attempt_of(a: &A) -> Option<String> {
    let task = a.text("task")?;
    let n = a.number("n")?;
    Some(format!("intento {n} de la tarea {task}"))
}

fn run_closed(cause: &str) -> &'static str {
    if cause == "run_closed" {
        " al cerrarse la ejecución"
    } else {
        ""
    }
}

fn attempt(key: &str, a: &A) -> Option<String> {
    let at = attempt_of(a)?;
    Some(match key {
        "activity.attempt.approved" => format!("Se aprobó el {at}."),
        "activity.attempt.started" => format!("Empezó el {at}."),
        "activity.attempt.integrated" => format!("Se integró el trabajo del {at}."),
        // Pending Queue (LXO-143): nunca el texto de la instrucción, solo el hecho.
        "activity.attempt.queued" => {
            let position = a.number("position")?;
            let attachments = a.number("attachments")?;
            format!("Se encoló una instrucción para el {at}{}.", details(&[Some(format!("posición {position}")), (attachments > 0).then(|| plural(attachments, "adjunto", "adjuntos"))]))
        }
        "activity.attempt.queue_delivered" => format!("Se entregó al {at} la instrucción encolada."),
        "activity.attempt.queue_cancelled" => format!("Se canceló una instrucción encolada para el {at}."),
        "activity.attempt.dispatch_ambiguous" => format!("No se sabe si el proveedor llegó a lanzarse para el {at}: no se relanzará."),
        "activity.attempt.queue_failed" => format!("No se pudo entregar una instrucción encolada al {at}: {}.", a.code_in("reason", queue_failure)?),
        // Steer y Stop & Send (LXO-144): nunca el texto de la instrucción, solo el hecho y cómo acabó.
        "activity.attempt.instruction_requested" => {
            if a.code("mode", &INSTRUCTION_MODES)? == "steer" {
                format!("Se pidió inyectar una instrucción en el turno en curso del {at}.")
            } else {
                format!("Se pidió detener el turno en curso del {at} y enviarle una instrucción.")
            }
        }
        "activity.attempt.instruction_result" => {
            let steer = a.code("mode", &INSTRUCTION_MODES)? == "steer";
            let outcome = a.code("outcome", &INSTRUCTION_OUTCOMES)?;
            // `reason` es opcional, pero si viene tiene que ser uno de los motivos cerrados.
            let detail = if a.present("reason") { format!(" ({})", a.code_in("reason", queue_failure)?) } else { String::new() };
            match (outcome, steer) {
                ("delivered", true) => format!("Se inyectó la instrucción en el turno en curso del {at}."),
                ("delivered", false) => format!("Se detuvo el turno en curso del {at} y se le envió la instrucción."),
                ("failed", true) => format!("El proveedor no aceptó la instrucción para el turno en curso del {at}{detail}."),
                ("failed", false) => format!("Se detuvo el turno en curso del {at}, pero la instrucción no llegó{detail}."),
                ("stop_failed", _) => format!("No se pudo detener el turno en curso del {at}: no se envió la instrucción{detail}."),
                _ => format!("El proveedor no confirmó a tiempo que el turno en curso del {at} se hubiera detenido: no se envió la instrucción."),
            }
        }
        "activity.attempt.rejected" => format!("Se rechazó el {at}{}.", run_closed(a.code("cause", &STOP_CAUSES)?)),
        "activity.attempt.completed" => {
            let summary = a.boolean("has_summary")?;
            format!("El {at} terminó correctamente{}.", if summary { " con resumen" } else { "" })
        }
        "activity.attempt.failed" => {
            let reason = a.code_in("reason", attempt_failure)?;
            a.boolean("has_summary")?;
            format!("El {at} falló: {reason}.")
        }
        "activity.attempt.stopped" => {
            a.code("from", &ACTIVE_FROM)?;
            format!("Se detuvo el {at}{}.", run_closed(a.code("cause", &STOP_CAUSES)?))
        }
        _ => {
            a.code("from", &ACTIVE_FROM)?;
            let state = match key {
                "activity.attempt.waiting" => "espera una respuesta",
                "activity.attempt.awaiting_terminal_approval" => "espera aprobación en la terminal",
                "activity.attempt.resumed" => "siguió en ejecución",
                "activity.attempt.exited" => "salió sin cerrarse",
                _ => return None,
            };
            format!("El {at} {state}.")
        }
    })
}

fn review(key: &str, a: &A) -> Option<String> {
    let at = attempt_of(a)?;
    let head = a.text("head_commit")?;
    if key == "activity.review.invalidated" {
        let observed = a.text("observed_head")?;
        return Some(format!("La revisión del {at} sobre {head} dejó de valer: la rama está en {observed}."));
    }
    let comment = a.boolean("has_comment")?;
    let verdict = if key == "activity.review.accepted" { "aceptó" } else { "rechazó" };
    Some(format!("Se {verdict} la revisión del {at} sobre {head}{}.", if comment { " con comentario" } else { "" }))
}

/// Una rama opcional: ausente, `null` o texto vacío se omiten; otro tipo deja el item sin texto.
fn optional_branch(a: &A) -> Option<Option<String>> {
    if a.present("branch") && !a.get("branch").is_string() {
        return None;
    }
    Some(a.text("branch"))
}

fn worktree_removed(a: &A) -> Option<String> {
    let effect = a.text("effect_id")?;
    let removed = a.boolean("worktree_removed")?;
    let deleted = a.boolean("branch_deleted")?;
    if a.present("branch") && !a.get("branch").is_string() {
        return None;
    }
    let branch = a.text("branch");
    Some(format!(
        "{} el worktree (efecto {effect}){}.",
        if removed {
            "Se retiró"
        } else {
            "No se retiró"
        },
        details(&[
            branch.map(|b| format!("rama «{b}»")),
            deleted.then(|| "rama eliminada".into()),
        ])
    ))
}

fn format(key: &str, a: &A) -> Option<String> {
    match key {
        "activity.run.created" => Some(format!(
            "Se creó la ejecución para la tarea {}.",
            a.text("root_task")?
        )),
        "activity.run.closed" => {
            let forced = a.boolean("forced")?;
            let stopped = a.number("stopped_total")?;
            Some(format!(
                "La ejecución {}; {}.",
                if forced {
                    "se cerró de forma forzada"
                } else {
                    "se cerró"
                },
                plural(stopped, "tarea detenida", "tareas detenidas")
            ))
        }
        "activity.run.removed" => Some(format!(
            "Se eliminó la ejecución junto con {}.",
            plural(a.number("tasks")?, "tarea", "tareas")
        )),
        "activity.task.created" => {
            let title = a.text("title")?;
            let agent = a.text("agent")?;
            let depth = a.number("depth")?;
            let external = a.boolean("external")?;
            let role = a.optional_text("role")?;
            let model = a.optional_text("model")?;
            let parent = a.optional_text("parent")?;
            Some(format!(
                "Se creó la tarea «{title}» para {agent}{}.",
                details(&[
                    role.map(|r| format!("rol {r}")),
                    model.map(|m| format!("modelo {m}")),
                    parent.map(|p| format!("depende de {p}")),
                    Some(format!("profundidad {depth}")),
                    external.then(|| "externa".into()),
                ])
            ))
        }
        "activity.task.starting"
        | "activity.task.running"
        | "activity.task.waiting"
        | "activity.task.awaiting_terminal_approval"
        | "activity.task.done"
        | "activity.task.failed"
        | "activity.task.stopped"
        | "activity.task.exited" => task_status(key, a),
        "activity.task.phase_done" => Some("La tarea terminó una fase.".into()),
        "activity.task.phase_started" => Some("La tarea inició una fase.".into()),
        "activity.task.question" => {
            let message = a.number("message_id")?;
            let to = a.text("to")?;
            Some(format!("La tarea envió la pregunta {message} a {to}."))
        }
        "activity.task.reply" => {
            let question = a.number("question_id")?;
            let message = a.number("message_id")?;
            Some(format!(
                "La tarea respondió a la pregunta {question} con el mensaje {message}."
            ))
        }
        "activity.task.removed" => Some(
            if a.code("cause", &["launch_failed", "unused"])? == "unused" {
                "Se eliminó la tarea porque no llegó a usarse."
            } else {
                "Se eliminó la tarea porque falló su lanzamiento."
            }
            .into(),
        ),
        "activity.task.intent_created" => {
            let title = a.text("title")?;
            let depth = a.number("depth")?;
            let parent = a.optional_text("parent")?;
            Some(format!(
                "Se creó la tarea «{title}»{}.",
                details(&[parent.map(|p| format!("depende de {p}")), Some(format!("profundidad {depth}"))])
            ))
        }
        "activity.task.updated" => {
            let changed = a.get("changed").as_array()?;
            if changed.is_empty() {
                return None;
            }
            let fields = changed.iter().map(|f| f.as_str().and_then(intent_field)).collect::<Option<Vec<_>>>()?;
            let title = a.optional_text("title")?;
            Some(format!(
                "Se actualizó {} de la tarea{}.",
                fields.join(" y "),
                title.map(|t| format!(" («{t}»)")).unwrap_or_default()
            ))
        }
        "activity.task.discarded" => Some("Se descartó la tarea.".into()),
        "activity.task.restored" => Some("Se recuperó la tarea descartada.".into()),
        "activity.attempt.continued" => {
            let at = attempt_of(a)?;
            let from_n = a.number("from_n")?;
            Some(match a.code_in("strategy", continuity_strategy)? {
                "native_resume" => {
                    a.code("reason", &["preferred"])?;
                    format!("El {at} continúa el intento {from_n} reanudando la sesión del proveedor.")
                }
                _ => format!("El {at} continúa el intento {from_n} con un paquete de contexto ({}).", a.code_in("reason", continuity_reason)?),
            })
        }
        "activity.attempt.retried" => {
            let at = attempt_of(a)?;
            let from_n = a.number("from_n")?;
            // Ausente: se heredó todo. Presente: una lista no vacía de nombres cerrados.
            let overrides = match a.get("overrides") {
                Value::Null => Vec::new(),
                list => {
                    let names = list.as_array()?.iter().map(|o| o.as_str().and_then(retry_override)).collect::<Option<Vec<_>>>()?;
                    if names.is_empty() {
                        return None;
                    }
                    names
                }
            };
            let parts: Vec<Option<String>> = overrides.into_iter().map(|o| Some(o.to_string())).collect();
            Some(format!("El {at} reintenta el intento {from_n}{}.", details(&parts)))
        }
        "activity.policy.changed" => {
            let place = match a.code("scope", &POLICY_SCOPES)? {
                "global" => "el ámbito global".to_string(),
                "project" => format!("el proyecto {}", a.text("scope_id")?),
                _ => format!("el intento {}", a.text("scope_id")?),
            };
            let category = policy_category(a.code("category", &POLICY_CATEGORIES)?);
            // Ausente: el ámbito heredaba (o vuelve a heredar). Presente pero fuera del contrato: sin texto.
            let level = |key: &str| -> Option<&'static str> {
                if a.present(key) {
                    a.code(key, &POLICY_LEVELS).map(policy_level)
                } else {
                    Some("heredado")
                }
            };
            let (from, to) = (level("from")?, level("to")?);
            let direction = policy_direction(a.code("direction", &POLICY_DIRECTIONS)?);
            a.number("revision")?;
            Some(format!("Policy de «{category}» en {place}: de {from} a {to} ({direction})."))
        }
        "activity.attempt.forked" => {
            let at = attempt_of(a)?;
            let source_task = a.text("source_task")?;
            let source_n = a.number("source_n")?;
            let with_package = a.code("strategy", &FORK_STRATEGIES)? == "context_package";
            Some(format!("El {at} se bifurcó del intento {source_n} de la tarea {source_task}{}.", if with_package { " con un paquete de contexto" } else { "" }))
        }
        "activity.attempt.requested" => {
            let at = attempt_of(a)?;
            let provider = a.text("provider")?;
            let external = a.boolean("external")?;
            let approval = a.boolean("approval_required")?;
            let model = a.optional_text("model")?;
            let effort = a.optional_text("effort")?;
            let role = a.optional_text("role")?;
            let profile = a.optional_text("profile")?;
            Some(format!(
                "Se pidió el {at} con {provider}{}.",
                details(&[
                    role.map(|r| format!("rol {r}")),
                    model.map(|m| format!("modelo {m}")),
                    effort.map(|e| format!("esfuerzo {e}")),
                    profile.map(|p| format!("perfil {p}")),
                    external.then(|| "externo".into()),
                    approval.then(|| "pendiente de aprobación".into()),
                ])
            ))
        }
        "activity.attempt.approved"
        | "activity.attempt.rejected"
        | "activity.attempt.started"
        | "activity.attempt.completed"
        | "activity.attempt.failed"
        | "activity.attempt.stopped"
        | "activity.attempt.waiting"
        | "activity.attempt.awaiting_terminal_approval"
        | "activity.attempt.resumed"
        | "activity.attempt.exited"
        | "activity.attempt.integrated"
        | "activity.attempt.queued"
        | "activity.attempt.queue_delivered"
        | "activity.attempt.queue_cancelled"
        | "activity.attempt.queue_failed"
        | "activity.attempt.instruction_requested"
        | "activity.attempt.instruction_result"
        | "activity.attempt.dispatch_ambiguous" => attempt(key, a),
        "activity.provider_session.opened" => {
            let at = attempt_of(a)?;
            let provider = a.text("provider")?;
            let resumable = a.boolean("resumable")?;
            let bound = a.boolean("bound")?;
            Some(format!(
                "Se abrió una sesión de {provider} en el {at}{}.",
                details(&[resumable.then(|| "reanudable".into()), bound.then(|| "vinculada".into())])
            ))
        }
        "activity.provider_session.bound" => {
            let task = a.text("task")?;
            let binding = a.code_in("binding", session_binding)?;
            Some(format!("La sesión de la tarea {task} quedó vinculada {binding}."))
        }
        "activity.provider_session.resumed" => {
            let task = a.text("task")?;
            let n = a.number("n")?;
            Some(format!("Se reanudó la sesión de la tarea {task} en el intento {n}."))
        }
        "activity.provider_session.detached" => Some(format!("La sesión de la tarea {} quedó en espera.", a.text("task")?)),
        "activity.provider_session.closed" => {
            let task = a.text("task")?;
            a.code("from", &["open", "idle"])?;
            Some(format!("Se cerró la sesión de la tarea {task}."))
        }
        "activity.thread.created" => Some(format!("Se abrió la conversación de la tarea {}.", a.text("task")?)),
        "activity.thread.summarized" => {
            let task = a.text("task")?;
            Some(if a.boolean("has_summary")? {
                format!("Se resumió la conversación de la tarea {task}.")
            } else {
                format!("Se quitó el resumen de la conversación de la tarea {task}.")
            })
        }
        "activity.worktree.created" => {
            let at = attempt_of(a)?;
            let branch = optional_branch(a)?;
            Some(format!("Se creó el worktree del {at}{}.", branch.map(|b| format!(" para «{b}»")).unwrap_or_default()))
        }
        "activity.worktree.adopted" => {
            let at = attempt_of(a)?;
            let external = a.code("provenance", &["adopted", "external"])? == "external";
            let branch = optional_branch(a)?;
            Some(format!(
                "{} en el {at}{}.",
                if external { "Se registró un worktree externo" } else { "Se adoptó un worktree existente" },
                branch.map(|b| format!(" («{b}»)")).unwrap_or_default()
            ))
        }
        "activity.worktree.attached" => Some(format!("El {} reutiliza su worktree.", attempt_of(a)?)),
        "activity.worktree.missing" => Some(format!("No se encuentra el worktree de la tarea {}.", a.text("task")?)),
        "activity.worktree.found" => Some(format!("Se volvió a encontrar el worktree de la tarea {}.", a.text("task")?)),
        "activity.worktree.removed" => {
            let task = a.text("task")?;
            let reason = a.code_in("reason", worktree_removal)?;
            let kept = a.boolean("branch_kept")?;
            Some(format!("Se quitó el worktree de la tarea {task} ({reason}{}).", if kept { "; se conserva la rama" } else { "" }))
        }
        "activity.artifact.created" => {
            let at = attempt_of(a)?;
            let kind = a.code_in("kind", artifact_kind)?;
            let verifiable = a.boolean("verifiable")?;
            Some(format!("El {at} dejó {kind}{}.", if verifiable { " verificable" } else { "" }))
        }
        "activity.review.accepted" | "activity.review.rejected" | "activity.review.invalidated" => review(key, a),
        "activity.core.agentic_cut" => {
            let tasks = a.number("tasks")?;
            let attempts = a.number("attempts")?;
            Some(format!(
                "Se pasó al modelo de tareas e intentos ({}, {}).",
                plural(tasks, "tarea", "tareas"),
                plural(attempts, "intento", "intentos")
            ))
        }
        "activity.task.review_requested" => Some(format!(
            "Se solicitó revisar la rama «{}».",
            a.text("branch")?
        )),
        "activity.decision.review.accepted" | "activity.decision.review.rejected" => {
            let id = a.number("decision_id")?;
            let comment = a.boolean("has_comment")?;
            Some(format!(
                "La revisión {id} fue {}{}.",
                if key.ends_with(".accepted") {
                    "aceptada"
                } else {
                    "rechazada"
                },
                if comment {
                    " con comentario"
                } else {
                    " sin comentario"
                }
            ))
        }
        "activity.decision.merge.merged"
        | "activity.decision.merge.conflict"
        | "activity.decision.merge.error"
        | "activity.decision.merge.target_moved" => merge(key, a),
        "activity.decision.pr.created"
        | "activity.decision.pr.already_exists"
        | "activity.decision.pr.error" => pull_request(key, a, "decision_id", "decisión"),
        "activity.effect.git_merge.merged"
        | "activity.effect.git_merge.conflict"
        | "activity.effect.git_merge.error" => {
            let effect = a.text("effect_id")?;
            let branch = a.text("branch")?;
            Some(if key.ends_with(".merged") {
                format!("El efecto {effect} integró la rama «{branch}».")
            } else if key.ends_with(".conflict") {
                format!("El efecto {effect} encontró conflictos al integrar «{branch}».")
            } else {
                format!("Falló la integración de «{branch}» (efecto {effect}).")
            })
        }
        "activity.effect.git_push_pr.created"
        | "activity.effect.git_push_pr.already_exists"
        | "activity.effect.git_push_pr.error" => pull_request(key, a, "effect_id", "efecto"),
        "activity.effect.git_worktree.created" => {
            let effect = a.text("effect_id")?;
            let branch = a.text("branch")?;
            if a.present("base") && !a.get("base").is_string() {
                return None;
            }
            let base = a
                .text("base")
                .map(|b| format!(" desde «{b}»"))
                .unwrap_or_default();
            Some(format!(
                "Se creó un worktree para «{branch}»{base} (efecto {effect})."
            ))
        }
        "activity.effect.git_worktree.removed" => worktree_removed(a),
        "activity.effect.process.launched" => Some(format!(
            "Se inició un proceso (efecto {}).",
            a.text("effect_id")?
        )),
        "activity.effect.process.not_launched" => Some(format!(
            "No se inició el proceso (efecto {}).",
            a.text("effect_id")?
        )),
        "activity.project.registered" => {
            let name = a.text("name")?;
            let origin = a.code_in("origin", project_origin)?;
            let remote = a.boolean("has_remote")?;
            Some(format!(
                "Se registró el proyecto «{name}» por {origin}{}.",
                if remote { " con remoto" } else { " sin remoto" }
            ))
        }
        "activity.project.location_added" => {
            let primary = a.boolean("primary")?;
            let adopted = a.boolean("fingerprint_adopted")?;
            Some(format!(
                "Se añadió una ubicación al proyecto{}{}.",
                if primary { " como principal" } else { "" },
                if adopted {
                    " y se adoptó su huella"
                } else {
                    ""
                }
            ))
        }
        "activity.project.archived" => Some("Se archivó el proyecto.".into()),
        "activity.project.restored" => Some("Se restauró el proyecto.".into()),
        "activity.project.relocated" => {
            let adopted = a.boolean("fingerprint_adopted")?;
            let mismatch = a.boolean("confirmed_mismatch")?;
            Some(format!(
                "Se reubicó el proyecto{}{}.",
                if adopted {
                    " y se adoptó la huella"
                } else {
                    ""
                },
                if mismatch {
                    "; se confirmó una discrepancia"
                } else {
                    ""
                }
            ))
        }
        "activity.spawn.requested" => {
            let parent = a.text("parent_task")?;
            let title = a.text("title")?;
            let provider = a.text("provider")?;
            let profile = a.text("profile")?;
            let shared = a.boolean("shared")?;
            let policy = match a.code("policy_status", &["ok", "blocked", "unverified"])? {
                "ok" => "permitida",
                "blocked" => "bloqueada",
                _ => "sin verificar",
            };
            let role = a.optional_text("role")?;
            let model = a.optional_text("model")?;
            let effort = a.optional_text("effort")?;
            Some(format!(
                "Se solicitó iniciar «{title}» con {provider} desde la tarea {parent}{}.",
                details(&[
                    Some(format!("perfil {profile}")),
                    role.map(|r| format!("rol {r}")),
                    model.map(|m| format!("modelo {m}")),
                    effort.map(|e| format!("esfuerzo {e}")),
                    Some(
                        if shared {
                            "compartida"
                        } else {
                            "no compartida"
                        }
                        .into()
                    ),
                    Some(format!("política {policy}")),
                ])
            ))
        }
        "activity.spawn.approved"
        | "activity.spawn.rejected"
        | "activity.spawn.launch_failed"
        | "activity.spawn.timeout"
        | "activity.spawn.coordinator_closed"
        | "activity.spawn.cancelled_run_removed" => spawn_resolved(key, a),
        "activity.environment.blocked" | "activity.environment.cleared" => {
            let provider = a.text("provider")?;
            let profile = a.text("profile")?;
            let code = a.code_in("code", environment_code)?;
            Some(if key.ends_with(".blocked") {
                format!("El entorno de {provider} está bloqueado para el perfil {profile}: {code}.")
            } else {
                format!("Se despejó el bloqueo del entorno de {provider} para el perfil {profile}: {code}.")
            })
        }
        "activity.attention.risk_acted" => Some(format!(
            "Se registró una acción relacionada con un riesgo: {}.",
            a.code_in("resolution", resolution)?
        )),
        "activity.attention.created" => {
            let category = a.code_in("category", attention_category)?;
            let severity = a.code_in("severity", attention_severity)?;
            let occurrence = a.number("occurrence")?;
            let kind = a.text("target_kind")?;
            let id = a.text("target_id")?;
            Some(format!(
                "Se registró una incidencia de {category} con severidad {severity} para {kind} {id} (ocurrencia {occurrence})."
            ))
        }
        "activity.attention.resolved" => Some(format!(
            "Se registró la resolución de una incidencia: {}.",
            a.code_in("resolution", resolution)?
        )),
        "activity.unknown" => {
            let reason = a.text("reason")?;
            let kind = a.text("kind")?;
            let version = a.number("event_version")?;
            Some(format!(
                "No se reconoce el evento «{kind}» (versión {version}, motivo: {reason})."
            ))
        }
        _ => None,
    }
}

/// La frase de un item de Activity, o `None` si la clave no es de la v1 o sus argumentos no cuadran.
pub(crate) fn translate(key: &str, args: &Value) -> Option<String> {
    if !MESSAGE_KEYS.contains(&key) {
        return None;
    }
    let map = args.as_object()?;
    format(key, &A(map)).and_then(|text| bounded(&text, MAX_MESSAGE_LENGTH))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DESKTOP: &str = include_str!("../../src/ade/activityMessages.js");
    const SHARED: &str = include_str!("../../../../docs/core/fixtures/activity_messages_es.json");

    #[test]
    fn las_claves_son_las_de_desktop() {
        let start = DESKTOP
            .find("ACTIVITY_V1_MESSAGE_KEYS = Object.freeze([")
            .expect("lista de claves en Desktop");
        let list = &DESKTOP[start..DESKTOP[start..].find("]);").unwrap() + start];
        let keys: Vec<&str> = list.split('\'').skip(1).step_by(2).collect();
        assert_eq!(
            keys, MESSAGE_KEYS,
            "al cambiar las claves de Desktop, cambiarlas aquí en el mismo PR"
        );
    }

    /// Los mismos casos que comprueba `activityMessages.test.js`: misma frase en Desktop y en lxo.
    #[test]
    fn mismas_frases_que_desktop() {
        let cases: Value = serde_json::from_str(SHARED).unwrap();
        let cases = cases["cases"].as_array().unwrap();
        let mut covered: Vec<&str> = vec![];
        for case in cases {
            let key = case["key"].as_str().unwrap();
            covered.push(key);
            assert_eq!(
                translate(key, &case["args"]),
                case["text"].as_str().map(String::from),
                "{key} {}",
                case["args"]
            );
        }
        for key in MESSAGE_KEYS {
            assert!(
                covered.contains(&key),
                "falta un caso para {key} en activity_messages_es.json"
            );
        }
    }

    #[test]
    fn sin_argumentos_validos_no_hay_frase() {
        assert_eq!(
            translate(
                "activity.task.failed",
                &json!({ "from": "running", "to": "done" })
            ),
            None
        );
        assert_eq!(
            translate(
                "activity.task.question",
                &json!({ "message_id": -1, "to": "t1" })
            ),
            None
        );
        assert_eq!(translate("activity.task.created", &json!([])), None);
        assert_eq!(translate("activity.desconocida", &json!({})), None);
        assert_eq!(
            translate(
                "activity.task.review_requested",
                &json!({ "branch": "a\u{1b}[2J\nb" })
            )
            .as_deref(),
            Some("Se solicitó revisar la rama «a [2J b».")
        );
        let long = translate(
            "activity.task.review_requested",
            &json!({ "branch": "x".repeat(300) }),
        )
        .unwrap();
        assert!(long.contains(&format!("«{}…»", "x".repeat(119))), "{long}");
    }
}
