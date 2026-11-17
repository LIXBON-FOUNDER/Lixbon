//! `lxo integrate`: integra un Attempt revisado a través del Core (LXO-163).
//!
//! El CLI solo lee la vista previa y envía una decisión autenticada. Git, `gh`,
//! la vigencia de la revisión y la policy siguen siendo responsabilidad del Core.

use std::process::ExitCode;

use serde_json::{json, Value};

use crate::client_auth::{self, EventRequestFailure, RpcFailure};
use crate::events::clean;
use crate::Args;

const CONTRACT: u64 = 1;
const MODEL: &str = "task_attempt_v1";
const PREVIEW_API: u64 = 1;
const ATTEMPT_API: u64 = 1;
const EVENTS_API: u64 = 1;

pub(super) const HELP: &str = "Uso: lxo integrate merge|pr <attempt_id|review_id> [--dry-run|--confirm] [--squash] [--accept-moved-target SHA] [--json]

Previsualiza el destino y comprueba que la revisión aceptada sigue vigente.
Sin --confirm (o con --dry-run) solo muestra el resumen: no integra ni publica.
--confirm solicita la acción al Core, que revalida la policy en ese instante.
No sirve para satisfacer una policy elevated: --confirm es local y nunca sustituye
la confirmación fuera de banda. Como aún no existe un canal para esa aprobación,
si el Core la exige la acción queda bloqueada.

Identificador:
  <attempt_id>     id explícito, por ejemplo task-1-a2
  <review_id>      decision_id numérico de una revisión; se resuelve por Event Log

Opciones:
  --squash                    solo para merge
  --accept-moved-target SHA   acepta únicamente el HEAD del destino que se mostró
  --json                      salida estable v1 con vista previa y resultado

Resultados merge: merged, conflict, error, target_moved, target_branch_mismatch,
already_merged, head_moved o review_required. Resultados PR: created,
already_exists, error, head_moved o review_required. El resultado de un efecto no
garantiza que haya tenido éxito. No se limpia el worktree ni se resuelven conflictos.
Un resultado error termina con código 10 (el resultado se imprime igual). En merge,
`result.reason` dice por qué: git_identity_missing (faltan user.name y user.email
en el repositorio), target_dirty (cambios sin commit en el destino) o git_failed.
";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Merge,
    Pr,
}

impl Action {
    fn cli_name(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Pr => "pr",
        }
    }

    fn core_name(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Pr => "publish_pr",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Selector {
    Attempt(String),
    Review { id: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Request {
    action: Action,
    selector: Selector,
    json: bool,
    confirm: bool,
    squash: bool,
    accept_moved_target: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum FailureKind {
    Internal,
    Usage,
    Authentication,
    Version,
    Unavailable,
    NotFound,
    Blocked,
    PolicyDenied,
    OutOfBand,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Failure {
    kind: FailureKind,
    message: String,
}

impl Failure {
    fn new(kind: FailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn code(&self) -> (&'static str, u8) {
        match self.kind {
            FailureKind::Internal => ("internal", 1),
            FailureKind::Usage => ("usage", 2),
            FailureKind::Authentication => ("authentication", 3),
            FailureKind::Version => ("version", 4),
            FailureKind::Unavailable => ("core_unavailable", 5),
            FailureKind::NotFound => ("not_found", 6),
            FailureKind::Blocked => ("integration_blocked", 7),
            FailureKind::PolicyDenied => ("policy_denied", 8),
            FailureKind::OutOfBand => ("policy_out_of_band_required", 9),
        }
    }
}

fn usage(message: impl Into<String>) -> Failure {
    Failure::new(FailureKind::Usage, message)
}

fn parse_attempt_id(raw: &str) -> bool {
    let Some((task, n)) = raw.rsplit_once("-a") else {
        return false;
    };
    if task.is_empty() || n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    n.parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
        .is_some_and(|n| format!("{task}-a{n}") == raw)
}

fn parse_selector(raw: &str) -> Result<Selector, Failure> {
    let id = raw.trim();
    if parse_attempt_id(id) {
        return Ok(Selector::Attempt(id.to_string()));
    }
    if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) {
        if let Ok(n) = id.parse::<u64>() {
            if n > 0 {
                return Ok(Selector::Review { id: n });
            }
        }
    }
    Err(usage(
        "El identificador debe ser un Attempt (<task>-a<n>) o el decision_id numérico de una revisión.",
    ))
}

fn parse(a: &Args) -> Result<Option<Request>, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") || a.at(2).as_deref() == Some("help") {
        return Ok(None);
    }
    const ALLOWED: &[&str] = &[
        "json",
        "help",
        "dry-run",
        "confirm",
        "squash",
        "accept-moved-target",
    ];
    if let Some(name) = a
        .flags
        .keys()
        .find(|name| !ALLOWED.contains(&name.as_str()))
    {
        return Err(usage(format!(
            "--{name} no es una opción de lxo integrate. Mira `lxo integrate --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["json", "help", "dry-run", "confirm", "squash"] {
        if a.flags.get(name).is_some_and(|value| !value.is_boolean()) {
            return Err(usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }
    let action = match a.at(1).as_deref() {
        Some("merge") => Action::Merge,
        Some("pr") => Action::Pr,
        Some(other) => {
            return Err(usage(format!(
                "«{}» no es una acción de integración; usa merge o pr.",
                clean(other)
            )))
        }
        None => return Err(usage("Uso: lxo integrate merge|pr <attempt_id|review_id>.")),
    };
    let id = a
        .at(2)
        .ok_or_else(|| usage("Falta <attempt_id|review_id>."))?;
    if a.pos.len() != 3 {
        return Err(usage(
            "lxo integrate recibe una sola identidad: <attempt_id|review_id>.",
        ));
    }
    let confirm = a.b("confirm");
    if confirm && a.b("dry-run") {
        return Err(usage("--confirm y --dry-run se excluyen."));
    }
    let squash = a.b("squash");
    if squash && action != Action::Merge {
        return Err(usage("--squash solo se aplica a lxo integrate merge."));
    }
    let accept_moved_target = match a.flags.get("accept-moved-target") {
        None => None,
        Some(Value::String(value)) if !value.trim().is_empty() => {
            if action != Action::Merge {
                return Err(usage(
                    "--accept-moved-target solo se aplica a lxo integrate merge.",
                ));
            }
            if !confirm {
                return Err(usage(
                    "--accept-moved-target solo se usa con --confirm; para inspeccionar el HEAD usa --dry-run.",
                ));
            }
            Some(value.trim().to_string())
        }
        _ => return Err(usage("--accept-moved-target requiere el SHA del HEAD.")),
    };
    Ok(Some(Request {
        action,
        selector: parse_selector(&id)?,
        json: a.b("json"),
        confirm,
        squash,
        accept_moved_target,
    }))
}

fn transport_failure(error: EventRequestFailure) -> Failure {
    match error {
        EventRequestFailure::Network(message) | EventRequestFailure::CoreUnavailable(message) => {
            Failure::new(FailureKind::Unavailable, message)
        }
        EventRequestFailure::Authentication(message) => {
            Failure::new(FailureKind::Authentication, message)
        }
        EventRequestFailure::Version(message) => Failure::new(FailureKind::Version, message),
        EventRequestFailure::Internal(_) => Failure::new(
            FailureKind::Internal,
            "No se pudo consultar el Event Log para resolver la revisión.",
        ),
    }
}

fn rejected_failure(message: &str) -> Failure {
    if message.starts_with("policy_out_of_band_required") {
        return Failure::new(
            FailureKind::OutOfBand,
            "La policy exige confirmación fuera de banda. --confirm no la satisface y aún no hay un canal para aprobarla; la acción queda bloqueada.",
        );
    }
    if message.starts_with("policy_denied") || message.starts_with("policy_forbidden") {
        return Failure::new(
            FailureKind::PolicyDenied,
            "La policy efectiva del Core no permite integrar o publicar este Attempt.",
        );
    }
    if message.starts_with("policy_confirm_required") {
        return Failure::new(
            FailureKind::Blocked,
            "La policy exige confirmación explícita: repite con --confirm. El Core la volverá a validar.",
        );
    }
    if message.starts_with("model_not_found") || message.starts_with("integration_not_found") {
        return Failure::new(
            FailureKind::NotFound,
            "No existe el Attempt o la revisión indicada.",
        );
    }
    if message.starts_with("model_auth_required")
        || message.starts_with("activity_auth_required")
        || message.contains("requiere una Person autenticada")
        || message.contains("solo está permitido a una Person")
    {
        return Failure::new(
            FailureKind::Authentication,
            "Esta operación requiere la credencial Person de Lixbon Desktop/CLI.",
        );
    }
    if message.starts_with("core_model_inactive")
        || message.starts_with("Comando desconocido")
        || message.starts_with("model_invalid_request")
        || message.starts_with("Solicitud de integración inválida")
    {
        return Failure::new(
            FailureKind::Version,
            "Este Core no ofrece el contrato de integración de Attempts que necesita lxo; actualiza Lixbon.",
        );
    }
    if message.starts_with("model_unavailable")
        || message.starts_with("attempt_integration_unavailable")
    {
        return Failure::new(
            FailureKind::Unavailable,
            "El Core de Lixbon no tiene su almacén abierto; reinicia Lixbon.",
        );
    }
    Failure::new(
        FailureKind::Internal,
        "El Core rechazó la solicitud de integración; no se ejecutó una acción local.",
    )
}

fn rpc_failure(error: RpcFailure) -> Failure {
    match error {
        RpcFailure::Transport(transport) => transport_failure(transport),
        RpcFailure::Rejected(message) => rejected_failure(&message),
    }
}

fn request_review_attempt(
    id: u64,
    events: &mut dyn FnMut(&[(String, String)]) -> Result<(u16, Value), EventRequestFailure>,
) -> Result<String, Failure> {
    let params = vec![
        ("entity_kind".to_string(), "review".to_string()),
        ("entity_id".to_string(), id.to_string()),
        ("limit".to_string(), "100".to_string()),
    ];
    let (status, body) = events(&params).map_err(transport_failure)?;
    if status != 200 || body["ok"].as_bool() != Some(true) {
        let code = body["code"].as_str().unwrap_or("");
        return Err(match (status, code) {
            (401, _) | (403, _) | (_, "forbidden") => Failure::new(
                FailureKind::Authentication,
                "El Core no autoriza leer la revisión con esta identidad.",
            ),
            (503, _) | (_, "event_log_unavailable") => Failure::new(
                FailureKind::Unavailable,
                "El Event Log del Core no está disponible para resolver el id de revisión.",
            ),
            (_, "invalid_filter") => Failure::new(
                FailureKind::Version,
                "El Core no acepta búsquedas de revisiones por Event Log; actualiza Lixbon.",
            ),
            _ => Failure::new(
                FailureKind::Internal,
                "No se pudo resolver la revisión en el Event Log del Core.",
            ),
        });
    }
    if body["data"]["v"].as_u64() != Some(EVENTS_API) {
        return Err(Failure::new(
            FailureKind::Version,
            "El Event Log devolvió una versión incompatible; actualiza Lixbon.",
        ));
    }
    let entries = body["data"]["events"].as_array().ok_or_else(|| {
        Failure::new(
            FailureKind::Version,
            "El Event Log devolvió una forma incompatible.",
        )
    })?;
    let mut attempts: Vec<&str> = entries
        .iter()
        .filter(|event| {
            event["entity"]["kind"] == "review"
                && event["entity"]["id"] == id.to_string()
                && matches!(
                    event["kind"].as_str(),
                    Some("review.completed" | "review.invalidated")
                )
        })
        .filter_map(|event| event["payload"]["attempt"].as_str())
        .filter(|attempt| parse_attempt_id(attempt))
        .collect();
    attempts.sort_unstable();
    attempts.dedup();
    match attempts.as_slice() {
        [attempt] => Ok((*attempt).to_string()),
        [] => Err(Failure::new(
            FailureKind::NotFound,
            format!("No existe una revisión con id {id}."),
        )),
        _ => Err(Failure::new(
            FailureKind::Version,
            "El Event Log asocia la revisión con más de un Attempt; no se integró nada.",
        )),
    }
}

type Rpc<'a> = &'a mut dyn FnMut(&str, &Value) -> Result<Value, RpcFailure>;
type EventGet<'a> =
    &'a mut dyn FnMut(&[(String, String)]) -> Result<(u16, Value), EventRequestFailure>;

fn resolve_selector(
    selector: &Selector,
    rpc: Rpc<'_>,
    events: EventGet<'_>,
) -> Result<(String, Option<u64>), Failure> {
    let (attempt_id, review_id) = match selector {
        Selector::Attempt(attempt_id) => (attempt_id.clone(), None),
        Selector::Review { id } => (request_review_attempt(*id, events)?, Some(*id)),
    };
    if let Some(review_id) = review_id {
        let data =
            rpc("attempt_detail", &json!({ "attempt_id": attempt_id })).map_err(rpc_failure)?;
        let attempt = &data["attempt"];
        if data["v"].as_u64() != Some(ATTEMPT_API)
            || data["core_model"] != MODEL
            || attempt["id"].as_str() != Some(attempt_id.as_str())
        {
            return Err(Failure::new(
                FailureKind::Version,
                "El Core devolvió el detalle del Attempt con una forma incompatible.",
            ));
        }
        if attempt["review"]["decision_id"].as_u64() != Some(review_id) {
            return Err(Failure::new(
                FailureKind::Blocked,
                format!(
                    "La revisión {review_id} ya no es la vigente de {attempt_id}; vuelve a revisar el Attempt actual."
                ),
            ));
        }
    }
    Ok((attempt_id, review_id))
}

fn nullable_text(value: &Value) -> Value {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .map(|text| Value::String(clean(text)))
        .unwrap_or(Value::Null)
}

fn nullable_bool(value: &Value) -> Value {
    value.as_bool().map(Value::Bool).unwrap_or(Value::Null)
}

fn safe_pr_url(value: &Value) -> Value {
    let url = value
        .as_str()
        .and_then(crate::attempts::sanitize_pr_url)
        .filter(|url| url.starts_with("https://"));
    url.map(Value::String).unwrap_or(Value::Null)
}

fn availability(value: &Value) -> Value {
    json!({
        "ok": value["ok"].as_bool().unwrap_or(false),
        "reason": nullable_text(&value["reason"]),
    })
}

fn validate_preview(data: Value, attempt_id: &str) -> Result<Value, Failure> {
    if data["v"].as_u64() != Some(PREVIEW_API)
        || data["attempt_id"].as_str() != Some(attempt_id)
        || !data["is_current"].is_boolean()
        || !matches!(
            data["review"]["state"].as_str(),
            Some("none" | "accepted" | "stale" | "rejected")
        )
        || !data["target"].is_object()
        || !data["can_merge"]["ok"].is_boolean()
        || !data["can_publish_pr"]["ok"].is_boolean()
    {
        return Err(Failure::new(
            FailureKind::Version,
            "El Core devolvió una vista previa de integración incompatible; actualiza Lixbon.",
        ));
    }
    Ok(json!({
        "is_current": data["is_current"],
        "revision": {
            "head_commit": nullable_text(&data["revision"]["head_commit"]),
        },
        "review": {
            "state": data["review"]["state"],
        },
        "merge": {
            "merged": nullable_bool(&data["merge"]["merged"]),
            "result_commit": nullable_text(&data["merge"]["result_commit"]),
        },
        "pr": {
            "url": safe_pr_url(&data["pr"]["url"]),
            "has_remote": nullable_bool(&data["pr"]["has_remote"]),
        },
        "target": {
            "kind": nullable_text(&data["target"]["kind"]),
            "branch": nullable_text(&data["target"]["branch"]),
            "expected_branch": nullable_text(&data["target"]["expected_branch"]),
            "branch_matches": nullable_bool(&data["target"]["branch_matches"]),
            "head": nullable_text(&data["target"]["head"]),
            "expected_head": nullable_text(&data["target"]["expected_head"]),
            "moved": nullable_bool(&data["target"]["moved"]),
            "clean": nullable_bool(&data["target"]["clean"]),
        },
        "can_merge": availability(&data["can_merge"]),
        "can_publish_pr": availability(&data["can_publish_pr"]),
    }))
}

fn result_projection(data: &Value, action: Action, attempt_id: &str) -> Result<Value, Failure> {
    let outcome = data["outcome"].as_str().unwrap_or("");
    let allowed = match action {
        Action::Merge => &[
            "merged",
            "conflict",
            "error",
            "target_moved",
            "target_branch_mismatch",
            "already_merged",
            "head_moved",
            "review_required",
        ][..],
        Action::Pr => &[
            "created",
            "already_exists",
            "error",
            "head_moved",
            "review_required",
        ][..],
    };
    if !allowed.contains(&outcome) {
        return Err(Failure::new(
            FailureKind::Version,
            "El Core devolvió un resultado de integración incompatible; actualiza Lixbon.",
        ));
    }
    let conflict_count = data["conflicts"]
        .as_array()
        .map(|conflicts| json!(conflicts.len()))
        .unwrap_or(Value::Null);
    let mut projected = json!({
        "outcome": outcome,
        "attempt_id": data["attempt_id"].as_str().map(clean).unwrap_or_else(|| attempt_id.to_string()),
        "decision_id": data["decision"].as_u64(),
        "result_commit": nullable_text(&data["result_commit"]),
        "pr_url": if action == Action::Pr { safe_pr_url(&data["pr_url"]) } else { Value::Null },
        "expected_commit": nullable_text(&data["expected_commit"]),
        "found_commit": nullable_text(&data["found_commit"]),
        "expected_branch": nullable_text(&data["expected_branch"]),
        "found_branch": nullable_text(&data["found_branch"]),
        "accepted_moved_target": nullable_bool(&data["accepted_moved_target"]),
        "conflict_count": conflict_count,
    });
    // LXO-251: `reason` solo existe en un `error` con un motivo conocido: el contrato v1 de los demás resultados no cambia.
    if let Some(reason) = merge_reason(&data["reason"]) {
        projected["reason"] = json!(reason);
    }
    Ok(projected)
}

/// LXO-251: el motivo de un `error` de merge es un código del Core, no su texto (que puede traer rutas o secretos). Lo que no es de la lista, nada.
fn merge_reason(value: &Value) -> Option<&'static str> {
    match value.as_str() {
        Some("git_identity_missing") => Some("git_identity_missing"),
        Some("target_dirty") => Some("target_dirty"),
        Some("git_failed") => Some("git_failed"),
        _ => None,
    }
}

/// Código de salida cuando el efecto terminó en `error` (LXO-251): el resultado se imprime igual, pero no se confunde con un éxito.
const EXIT_EFFECT_ERROR: u8 = 10;

fn result_exit(data: &Value) -> ExitCode {
    if data["dry_run"] == false && data["result"]["outcome"] == "error" {
        ExitCode::from(EXIT_EFFECT_ERROR)
    } else {
        ExitCode::SUCCESS
    }
}

fn output(
    request: &Request,
    attempt_id: &str,
    review_id: Option<u64>,
    preview: Value,
    result: Option<Value>,
) -> Value {
    json!({
        "v": CONTRACT,
        "action": request.action.cli_name(),
        "requested_id": match &request.selector {
            Selector::Attempt(id) => id.clone(),
            Selector::Review { id } => id.to_string(),
        },
        "attempt_id": attempt_id,
        "review_id": review_id,
        "dry_run": result.is_none(),
        "preview": preview,
        "result": result,
    })
}

fn execute(request: &Request, rpc: Rpc<'_>, events: EventGet<'_>) -> Result<Value, Failure> {
    let (attempt_id, review_id) = resolve_selector(&request.selector, rpc, events)?;
    let raw_preview = rpc(
        "attempt_integration_preview",
        &json!({ "attempt_id": attempt_id }),
    )
    .map_err(rpc_failure)?;
    let preview = validate_preview(raw_preview, &attempt_id)?;

    if !request.confirm {
        return Ok(output(request, &attempt_id, review_id, preview, None));
    }
    if preview["is_current"] != true {
        return Err(Failure::new(
            FailureKind::Blocked,
            format!(
                "El Attempt {attempt_id} ya no es el actual de su tarea; no se envió ninguna acción."
            ),
        ));
    }
    if preview["review"]["state"] != "accepted" {
        return Err(Failure::new(
            FailureKind::Blocked,
            format!(
                "La revisión de {attempt_id} no está aceptada sobre su HEAD actual; no se envió ninguna acción."
            ),
        ));
    }
    if preview["revision"]["head_commit"].as_str().is_none() {
        return Err(Failure::new(
            FailureKind::Blocked,
            format!("El Attempt {attempt_id} no tiene una rama con HEAD revisable."),
        ));
    }
    if preview["target"]["kind"].is_null() {
        return Err(Failure::new(
            FailureKind::Blocked,
            "El Core no pudo determinar el destino; no se envió ninguna acción.",
        ));
    }
    let head_commit = preview["revision"]["head_commit"]
        .as_str()
        .expect("comprobado arriba");
    let args = json!({
        "attempt_id": attempt_id,
        "action": request.action.core_name(),
        "head_commit": head_commit,
        "confirm": true,
        "squash": request.squash,
        "accept_moved_target": request.accept_moved_target,
    });
    let raw_result = rpc("attempt_integrate", &args).map_err(rpc_failure)?;
    let result = result_projection(&raw_result, request.action, &attempt_id)?;
    Ok(output(
        request,
        &attempt_id,
        review_id,
        preview,
        Some(result),
    ))
}

fn text_preview(data: &Value, action: Action, attempt_id: &str, dry_run: bool) -> String {
    let state = match data["review"]["state"].as_str().unwrap_or("") {
        "accepted" => "aceptada y vigente",
        "stale" => "obsoleta",
        "rejected" => "rechazada",
        _ => "sin aceptar",
    };
    let target = &data["target"];
    let mut lines = vec![
        format!("Integración {} · {attempt_id}", action.cli_name()),
        format!(
            "Revisión: {state} · HEAD {}",
            data["revision"]["head_commit"]
                .as_str()
                .unwrap_or("desconocido")
        ),
        format!(
            "Attempt actual: {}",
            if data["is_current"] == true {
                "sí"
            } else {
                "no"
            }
        ),
        format!(
            "Destino: {} · rama {} · HEAD {}",
            target["kind"].as_str().unwrap_or("desconocido"),
            target["branch"].as_str().unwrap_or("desconocida"),
            target["head"].as_str().unwrap_or("desconocido")
        ),
    ];
    if let Some(expected) = target["expected_branch"].as_str() {
        lines.push(format!(
            "Rama base esperada: {expected} · coincide: {}",
            target["branch_matches"]
                .as_bool()
                .map(|value| if value { "sí" } else { "no" })
                .unwrap_or("desconocido")
        ));
    }
    if let Some(expected) = target["expected_head"].as_str() {
        lines.push(format!(
            "HEAD del destino: esperado {expected} · movido: {}",
            target["moved"]
                .as_bool()
                .map(|value| if value { "sí" } else { "no" })
                .unwrap_or("desconocido")
        ));
    }
    if let Some(clean) = target["clean"].as_bool() {
        lines.push(format!(
            "Checkout del destino: {}",
            if clean {
                "limpio"
            } else {
                "con cambios sin commit"
            }
        ));
    }
    match action {
        Action::Merge => {
            lines.push(format!(
                "Merge disponible: {}{}",
                if data["can_merge"]["ok"] == true {
                    "sí"
                } else {
                    "no"
                },
                data["can_merge"]["reason"]
                    .as_str()
                    .map(|reason| format!(" ({reason})"))
                    .unwrap_or_default()
            ));
        }
        Action::Pr => {
            lines.push(format!(
                "PR disponible: {}{}",
                if data["can_publish_pr"]["ok"] == true {
                    "sí"
                } else {
                    "no"
                },
                data["can_publish_pr"]["reason"]
                    .as_str()
                    .map(|reason| format!(" ({reason})"))
                    .unwrap_or_default()
            ));
            if let Some(url) = data["pr"]["url"].as_str() {
                lines.push(format!("PR registrado: {url}"));
            }
        }
    }
    if dry_run {
        lines.push("No se ejecutó nada. Para solicitarlo al Core, repite con --confirm.".into());
    }
    lines.join("\n")
}

fn result_text(data: &Value, action: Action) -> String {
    let result = &data["result"];
    let outcome = result["outcome"].as_str().unwrap_or("desconocido");
    match (action, outcome) {
        (Action::Merge, "merged") => format!(
            "Integración completada{}.",
            result["result_commit"]
                .as_str()
                .map(|commit| format!(" · commit {commit}"))
                .unwrap_or_default()
        ),
        (Action::Merge, "conflict") => format!(
            "Conflicto al integrar ({} archivo(s)); el efecto quedó registrado y el worktree se conservó.",
            result["conflict_count"].as_u64().unwrap_or(0)
        ),
        (Action::Merge, "error") => match result["reason"].as_str() {
            Some("git_identity_missing") => "El merge no se hizo: git no tiene identidad (user.name y user.email) en el repositorio del Project. Configúrala y repite el comando.".into(),
            Some("target_dirty") => "El merge no se hizo: el checkout del Project tiene cambios sin commit. Haz commit o stash y repite el comando.".into(),
            Some(_) => "El merge no se hizo: git falló al fusionar. Revisa el repositorio del Project con git y repite el comando.".into(),
            None => "El merge terminó con error; el resultado quedó registrado en el Core.".into(),
        },
        (Action::Merge, "target_moved") => format!(
            "El destino se movió; no se integró. Revisa el HEAD {} antes de repetir.",
            result["found_commit"].as_str().unwrap_or("actual")
        ),
        (Action::Merge, "target_branch_mismatch") => format!(
            "El destino está en una rama distinta de la esperada ({}); no se integró.",
            result["found_branch"].as_str().unwrap_or("desconocida")
        ),
        (Action::Merge, "already_merged") => "El Attempt ya estaba integrado; no se repitió el merge.".into(),
        (Action::Pr, "created") => format!(
            "PR creado{}.",
            result["pr_url"]
                .as_str()
                .map(|url| format!(": {url}"))
                .unwrap_or_default()
        ),
        (Action::Pr, "already_exists") => format!(
            "El PR ya existe{}.",
            result["pr_url"]
                .as_str()
                .map(|url| format!(": {url}"))
                .unwrap_or_default()
        ),
        (Action::Pr, "error") => "No se pudo publicar el PR; el resultado quedó registrado en el Core.".into(),
        (_, "head_moved") => "La rama cambió desde la vista previa; no se integró. Revisa el HEAD actual.".into(),
        (_, "review_required") => "La revisión dejó de estar vigente; no se integró.".into(),
        _ => format!("Resultado de integración: {outcome}."),
    }
}

fn finish(result: Result<Value, Failure>, json_output: bool, action: Action) -> ExitCode {
    match result {
        Ok(data) if json_output => {
            println!(
                "{}",
                serde_json::to_string_pretty(&data).unwrap_or_default()
            );
            result_exit(&data)
        }
        Ok(data) => {
            if data["dry_run"] == true {
                println!(
                    "{}",
                    text_preview(
                        &data["preview"],
                        action,
                        data["attempt_id"].as_str().unwrap_or(""),
                        true,
                    )
                );
            } else {
                println!("{}", result_text(&data, action));
            }
            result_exit(&data)
        }
        Err(failure) => {
            let (code, exit) = failure.code();
            if json_output {
                eprintln!(
                    "{}",
                    json!({ "ok": false, "code": code, "error": failure.message })
                );
            } else {
                eprintln!("lxo: {}", failure.message);
            }
            ExitCode::from(exit)
        }
    }
}

pub(super) fn run(a: &Args) -> ExitCode {
    match parse(a) {
        Err(failure) => finish(Err(failure), a.b("json"), Action::Merge),
        Ok(None) => {
            println!("{HELP}");
            ExitCode::SUCCESS
        }
        Ok(Some(request)) => {
            let action = request.action;
            let json_output = request.json;
            let mut rpc = |cmd: &str, args: &Value| client_auth::rpc(cmd, args, &crate::cwd());
            let mut events = |params: &[(String, String)]| client_auth::get_events(params);
            finish(
                execute(&request, &mut rpc, &mut events),
                json_output,
                action,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|value| value.to_string()).collect())
    }

    fn preview(attempt_id: &str) -> Value {
        json!({
            "v": 1,
            "attempt_id": attempt_id,
            "task_id": "task-1",
            "is_current": true,
            "revision": { "head_commit": "attempt-head" },
            "review": { "state": "accepted" },
            "merge": { "merged": false, "result_commit": null },
            "pr": { "url": null, "has_remote": true },
            "target": {
                "kind": "project_checkout", "branch": "main", "expected_branch": "main",
                "branch_matches": true, "head": "target-head", "expected_head": "target-head",
                "moved": false, "clean": true
            },
            "can_merge": { "ok": true },
            "can_publish_pr": { "ok": true }
        })
    }

    fn fake_rpc(
        calls: Rc<RefCell<Vec<(String, Value)>>>,
        preview_data: Value,
        result: Value,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        move |cmd, args| {
            calls.borrow_mut().push((cmd.to_string(), args.clone()));
            match cmd {
                "attempt_integration_preview" => Ok(preview_data.clone()),
                "attempt_detail" => Ok(json!({
                    "v": 1, "core_model": MODEL,
                    "attempt": { "id": "task-1-a1", "review": { "decision_id": 42 } }
                })),
                "attempt_integrate" => Ok(result.clone()),
                other => panic!("RPC inesperado: {other}"),
            }
        }
    }

    fn no_events() -> impl FnMut(&[(String, String)]) -> Result<(u16, Value), EventRequestFailure> {
        |params| {
            assert!(params
                .iter()
                .any(|(key, value)| key == "entity_kind" && value == "review"));
            Ok((200, json!({ "ok": true, "data": { "events": [] } })))
        }
    }

    fn event_for_review(
    ) -> impl FnMut(&[(String, String)]) -> Result<(u16, Value), EventRequestFailure> {
        |params| {
            assert!(params
                .iter()
                .any(|(key, value)| key == "entity_id" && value == "42"));
            Ok((
                200,
                json!({ "ok": true, "data": { "v": 1, "events": [{
                    "entity": { "kind": "review", "id": "42" },
                    "kind": "review.completed",
                    "payload": { "attempt": "task-1-a1" }
                }, {
                    "entity": { "kind": "review", "id": "42" },
                    "kind": "review.invalidated",
                    "payload": { "attempt": "task-1-a1" }
                }] } }),
            ))
        }
    }

    fn request(raw: &[&str]) -> Request {
        parse(&args(raw)).unwrap().unwrap()
    }

    #[test]
    fn parser_distingue_preview_de_confirmacion_y_rechaza_flags_ambiguos() {
        assert_eq!(
            request(&["integrate", "merge", "task-1-a2"]),
            Request {
                action: Action::Merge,
                selector: Selector::Attempt("task-1-a2".into()),
                json: false,
                confirm: false,
                squash: false,
                accept_moved_target: None,
            }
        );
        assert!(request(&["integrate", "pr", "42", "--confirm", "--json"]).confirm);
        assert!(parse(&args(&[
            "integrate",
            "merge",
            "task-1-a1",
            "--confirm",
            "--dry-run"
        ]))
        .is_err());
        assert!(parse(&args(&["integrate", "pr", "task-1-a1", "--squash"])).is_err());
        assert!(parse(&args(&[
            "integrate",
            "merge",
            "task-1-a1",
            "--accept-moved-target",
            "abc123"
        ]))
        .is_err());
        assert!(parse(&args(&["integrate", "merge", "task-1"])).is_err());
        assert!(parse(&args(&["integrate", "merge", "task-1-a0"])).is_err());
    }

    #[test]
    fn preview_no_ejecuta_acciones_y_tiene_un_json_versionado() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = fake_rpc(calls.clone(), preview("task-1-a1"), json!({}));
        let mut events = no_events();
        let data = execute(
            &request(&["integrate", "merge", "task-1-a1", "--json"]),
            &mut rpc,
            &mut events,
        )
        .unwrap();

        assert_eq!(data["v"], 1);
        assert_eq!(data["dry_run"], true);
        assert_eq!(data["preview"]["review"]["state"], "accepted");
        assert!(data["result"].is_null());
        assert_eq!(
            calls
                .borrow()
                .iter()
                .map(|call| call.0.as_str())
                .collect::<Vec<_>>(),
            ["attempt_integration_preview"]
        );
        crate::snapshot("integrate_dry_run.v1.json", &data);
    }

    #[test]
    fn confirm_solo_envia_la_decision_al_core_con_el_head_mostrado() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let result = json!({
            "outcome": "merged", "attempt_id": "task-1-a1", "task": "task-1",
            "decision": 77, "result_commit": "result-head"
        });
        let mut rpc = fake_rpc(calls.clone(), preview("task-1-a1"), result);
        let mut events = no_events();
        let data = execute(
            &request(&[
                "integrate",
                "merge",
                "task-1-a1",
                "--confirm",
                "--squash",
                "--json",
            ]),
            &mut rpc,
            &mut events,
        )
        .unwrap();

        let calls = calls.borrow();
        let action = calls
            .iter()
            .find(|call| call.0 == "attempt_integrate")
            .unwrap();
        assert_eq!(action.1["action"], "merge");
        assert_eq!(action.1["head_commit"], "attempt-head");
        assert_eq!(action.1["confirm"], true);
        assert_eq!(action.1["squash"], true);
        assert_eq!(data["result"]["outcome"], "merged");
        assert_eq!(data["result"]["result_commit"], "result-head");
        crate::snapshot("integrate_merge.v1.json", &data);
    }

    #[test]
    fn una_review_id_se_resuelve_por_event_log_y_se_compara_con_la_vigente() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = fake_rpc(
            calls.clone(),
            preview("task-1-a1"),
            json!({ "outcome": "created", "attempt_id": "task-1-a1", "decision": 78,
                "pr_url": "https://user:secret@github.com/lixbon/demo/pull/4?token=x#frag" }),
        );
        let mut events = event_for_review();
        let data = execute(
            &request(&["integrate", "pr", "42", "--confirm", "--json"]),
            &mut rpc,
            &mut events,
        )
        .unwrap();

        assert_eq!(data["attempt_id"], "task-1-a1");
        assert_eq!(data["review_id"], 42);
        assert_eq!(
            data["result"]["pr_url"],
            "https://github.com/lixbon/demo/pull/4"
        );
        assert!(calls.borrow().iter().any(|call| call.0 == "attempt_detail"));
        crate::snapshot("integrate_pr.v1.json", &data);
    }

    #[test]
    fn eventos_completed_e_invalidated_de_una_review_no_se_confunden_con_dos_attempts() {
        let mut events = event_for_review();
        assert_eq!(
            request_review_attempt(42, &mut events).unwrap(),
            "task-1-a1"
        );
    }

    #[test]
    fn una_revision_obsoleta_se_bloquea_antes_de_intentar_el_efecto() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut stale = preview("task-1-a1");
        stale["review"]["state"] = json!("stale");
        let mut rpc = fake_rpc(calls.clone(), stale, json!({}));
        let mut events = no_events();
        let error = execute(
            &request(&["integrate", "merge", "task-1-a1", "--confirm"]),
            &mut rpc,
            &mut events,
        )
        .unwrap_err();
        assert_eq!(error.code(), ("integration_blocked", 7));
        assert!(!calls
            .borrow()
            .iter()
            .any(|call| call.0 == "attempt_integrate"));
    }

    #[test]
    fn un_attempt_que_ya_no_es_actual_se_bloquea_antes_del_efecto() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut no_actual = preview("task-1-a1");
        no_actual["is_current"] = json!(false);
        let mut rpc = fake_rpc(calls.clone(), no_actual, json!({}));
        let mut events = no_events();
        let error = execute(
            &request(&["integrate", "merge", "task-1-a1", "--confirm"]),
            &mut rpc,
            &mut events,
        )
        .unwrap_err();
        assert_eq!(error.code(), ("integration_blocked", 7));
        assert!(!calls
            .borrow()
            .iter()
            .any(|call| call.0 == "attempt_integrate"));
    }

    #[test]
    fn una_confirmacion_local_no_satisface_policy_elevated() {
        let error = rejected_failure("policy_out_of_band_required: confirmación externa");
        assert_eq!(error.code(), ("policy_out_of_band_required", 9));
        assert!(error.message.contains("--confirm no la satisface"));
    }

    #[test]
    fn un_resultado_error_no_expone_mensaje_raw_ni_una_url_insegura() {
        let result = result_projection(
            &json!({
                "outcome": "error", "attempt_id": "task-1-a1",
                "message": "token=secreto y C:/ruta/privada",
                "pr_url": "http://evil.test/pr/1"
            }),
            Action::Pr,
            "task-1-a1",
        )
        .unwrap();
        assert_eq!(result["outcome"], "error");
        assert!(result["pr_url"].is_null());
        assert!(!result.to_string().contains("secreto"));
        assert!(!result.to_string().contains("privada"));
    }

    #[test]
    fn un_error_de_merge_lleva_el_motivo_del_core_y_no_su_texto() {
        let proyectar = |reason: Value| {
            result_projection(
                &json!({ "outcome": "error", "attempt_id": "task-1-a1", "message": "C:/ruta/privada token=secreto", "reason": reason }),
                Action::Merge,
                "task-1-a1",
            )
            .unwrap()
        };
        for reason in ["git_identity_missing", "target_dirty", "git_failed"] {
            assert_eq!(proyectar(json!(reason))["reason"], reason);
        }
        // Un código que el CLI no conoce no se reenvía tal cual: es texto del Core que podría llevar de todo.
        assert!(proyectar(json!("C:/ruta/privada")).get("reason").is_none());
        assert!(proyectar(Value::Null).get("reason").is_none());
        assert!(!proyectar(json!("git_identity_missing")).to_string().contains("secreto"));
    }

    #[test]
    fn el_texto_de_un_error_de_merge_dice_que_falta() {
        let texto = |reason: Value| {
            let resultado = result_projection(&json!({ "outcome": "error", "attempt_id": "task-1-a1", "reason": reason }), Action::Merge, "task-1-a1").unwrap();
            result_text(&json!({ "result": resultado }), Action::Merge)
        };
        assert!(texto(json!("git_identity_missing")).contains("user.name y user.email"));
        assert!(texto(json!("target_dirty")).contains("cambios sin commit"));
        assert!(texto(json!("git_failed")).contains("git falló"));
        assert!(texto(Value::Null).contains("terminó con error"));
    }

    #[test]
    fn un_resultado_error_no_sale_con_codigo_de_exito_y_un_dry_run_o_un_merge_si() {
        let con = |dry_run: bool, outcome: &str| result_exit(&json!({ "dry_run": dry_run, "result": { "outcome": outcome } }));
        assert_eq!(format!("{:?}", con(false, "error")), format!("{:?}", ExitCode::from(10)));
        for (dry_run, outcome) in [(false, "merged"), (false, "conflict"), (false, "already_merged")] {
            assert_eq!(format!("{:?}", con(dry_run, outcome)), format!("{:?}", ExitCode::SUCCESS), "{outcome}");
        }
        assert_eq!(format!("{:?}", result_exit(&json!({ "dry_run": true, "result": null }))), format!("{:?}", ExitCode::SUCCESS));
    }
}
