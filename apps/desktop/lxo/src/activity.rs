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

pub(crate) const MESSAGE_KEYS: [&str; 55] = [
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
        "activity.task.removed" => {
            a.code("cause", &["launch_failed"])?;
            Some("Se eliminó la tarea porque falló su lanzamiento.".into())
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
