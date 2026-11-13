//! `lxo review`: inspección del Proof Pack y decisión humana sobre su HEAD exacto.

use std::process::ExitCode;

use serde_json::{json, Value};

use crate::attempts;
use crate::client_auth::{self, RpcFailure};
use crate::events::clean;
use crate::projects::{self, Failure};
use crate::Args;

const CLI_API: u64 = 1;
const CORE_API: u64 = 1;
const MAX_COMMENT_CHARS: usize = 2000;
const STATUSES: [&str; 9] = [
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
const PROVENANCE: [&str; 3] = ["verified", "agent_reported", "unknown"];
const ACCEPTANCE: [&str; 4] = ["none", "accepted", "stale", "rejected"];
const DECISION_BLOCKS: [&str; 4] = [
    "pending_approval",
    "not_current_attempt",
    "not_final",
    "no_revision",
];
const FLAGS: [&str; 6] = ["accept", "reject", "comment", "open", "json", "help"];

type Rpc<'a> = &'a mut dyn FnMut(&str, &Value) -> Result<Value, RpcFailure>;

pub(super) const HELP: &str =
    "Uso: lxo review <attempt_id> [--accept | --reject] [--comment TEXTO] [--open] [--json]

Lee el Proof Pack antes del diff. Con --accept o --reject decide sobre el HEAD
exacto que ese Proof Pack mostró. Review no integra ni abre un PR; rechazar no
borra el Attempt ni su worktree.

Opciones:
  --accept          acepta el HEAD mostrado por el Proof Pack
  --reject          rechaza el HEAD mostrado por el Proof Pack
  --comment TEXTO   comentario de la decisión (máximo 2000 caracteres)
  --open            muestra el id para abrirlo manualmente en Desktop; no inicia la app
  --json            {v: 1, proof_pack, review}; review es null si solo se consulta

Si el Core detecta que la rama se movió, no registra la decisión: vuelve a
ejecutar `lxo review <attempt_id>` y examina el Proof Pack nuevo.
Solo para personas. Códigos: 0 correcto, 1 error interno, 2 uso/decisión inválida,
3 autenticación o permiso, 4 versión/contrato, 5 Core no disponible,
6 Attempt inexistente, 7 HEAD movido (stale).
";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Accept,
    Reject,
}

impl Decision {
    fn core_value(self) -> &'static str {
        match self {
            Self::Accept => "accepted",
            Self::Reject => "rejected",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Accept => "Aceptado",
            Self::Reject => "Rechazado",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ReviewRequest {
    attempt_id: String,
    decision: Option<Decision>,
    comment: Option<String>,
    open: bool,
}

#[derive(Debug, PartialEq)]
enum Request {
    Help,
    Review(ReviewRequest),
}

struct Output {
    json: Value,
    human: String,
    stale: Option<String>,
}

fn usage(message: impl Into<String>) -> Failure {
    Failure::Usage(message.into())
}

fn contract_error(where_: &str) -> Failure {
    Failure::Version(format!(
        "El Core devolvió un Proof Pack con un formato que este lxo no entiende ({where_}); actualiza Lixbon."
    ))
}

fn valid_text(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 200 && !value.chars().any(char::is_control)
}

fn text_flag(a: &Args, name: &str) -> Result<Option<String>, Failure> {
    match a.flags.get(name) {
        None => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => {
            Ok(Some(value.trim().to_string()))
        }
        _ => Err(usage(format!("--{name} requiere un valor."))),
    }
}

fn parse(a: &Args) -> Result<Request, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    if let Some(name) = a.flags.keys().find(|key| !FLAGS.contains(&key.as_str())) {
        return Err(usage(format!(
            "--{name} no es una opción de lxo review. Mira `lxo review --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["accept", "reject", "open", "json", "help"] {
        if a.flags.get(name).is_some_and(|value| !value.is_boolean()) {
            return Err(usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }

    let attempt_id = match a.pos.get(1..) {
        Some([id]) if valid_text(id) => id.trim().to_string(),
        Some([]) => {
            return Err(usage(
                "Falta el intento: lxo review <attempt_id>. Usa el id que muestra `lxo attempts --task <task_id>`.",
            ))
        }
        Some([_]) => {
            return Err(usage(
                "El id de Attempt debe contener de 1 a 200 caracteres sin controles.",
            ))
        }
        _ => return Err(usage("lxo review recibe un solo id de Attempt.")),
    };

    let accept = a.b("accept");
    let reject = a.b("reject");
    if accept && reject {
        return Err(usage("Usa solo una decisión: --accept o --reject."));
    }
    let decision = if accept {
        Some(Decision::Accept)
    } else if reject {
        Some(Decision::Reject)
    } else {
        None
    };
    let comment = text_flag(a, "comment")?;
    if let Some(comment) = &comment {
        if comment.chars().count() > MAX_COMMENT_CHARS {
            return Err(usage(format!(
                "--comment admite hasta {MAX_COMMENT_CHARS} caracteres."
            )));
        }
        if decision.is_none() {
            return Err(usage("--comment solo se usa junto a --accept o --reject."));
        }
    }

    Ok(Request::Review(ReviewRequest {
        attempt_id,
        decision,
        comment,
        open: a.b("open"),
    }))
}

fn rpc_failure(error: RpcFailure, operation: &str) -> Failure {
    if let RpcFailure::Rejected(message) = &error {
        if message.starts_with("model_not_found") || message.starts_with("review_not_found") {
            return Failure::NotFound(format!(
                "No se encontró el Attempt solicitado ({operation})."
            ));
        }
        if message.starts_with("model_auth_required")
            || message.starts_with("revisar un Attempt requiere")
        {
            return Failure::Auth(
                "El Proof Pack y las decisiones de revisión son solo para personas autenticadas."
                    .into(),
            );
        }
        if message.starts_with("review_not_current")
            || message.starts_with("review_not_final")
            || message.starts_with("no_branch:")
            || message.starts_with("Falta un id de Attempt válido")
        {
            return usage(clean(message));
        }
        if message.starts_with("Comando desconocido") {
            return Failure::Version(format!(
                "Este Core no ofrece `{operation}`; actualiza Lixbon."
            ));
        }
    }
    attempts::model_failure(error)
}

fn evidence(value: &Value, where_: &str) -> Result<(), Failure> {
    let provenance = value["provenance"]
        .as_str()
        .filter(|value| PROVENANCE.contains(value))
        .ok_or_else(|| contract_error(where_))?;
    if provenance == "unknown" {
        if !value["value"].is_null()
            || !value["reason"]
                .as_str()
                .is_some_and(|reason| !reason.trim().is_empty())
        {
            return Err(contract_error(where_));
        }
    } else if value["value"].is_null() || value.get("reason").is_some() {
        return Err(contract_error(where_));
    }
    Ok(())
}

fn check_proof_pack(data: Value, requested_id: &str) -> Result<Value, Failure> {
    if data["v"].as_u64() != Some(CORE_API)
        || data["attempt_id"] != requested_id
        || !data["task_id"].as_str().is_some_and(valid_text)
        || data["n"].as_u64().is_none_or(|n| n == 0)
        || !data["is_current"].is_boolean()
    {
        return Err(contract_error("identity"));
    }

    for field in ["status", "objective", "summary", "tests"] {
        evidence(&data[field], field)?;
    }
    let status = &data["status"];
    if status["provenance"] != "verified"
        || status["value"]["status"]
            .as_str()
            .is_none_or(|value| !STATUSES.contains(&value))
        || !(status["value"]["failure_reason"].is_null()
            || status["value"]["failure_reason"].is_string())
    {
        return Err(contract_error("status"));
    }
    if data["objective"]["provenance"] != "unknown"
        && (!data["objective"]["value"]["title"].is_string()
            || !data["objective"]["value"]["objective"].is_string())
    {
        return Err(contract_error("objective"));
    }
    if data["summary"]["provenance"] != "unknown" && !data["summary"]["value"].is_string() {
        return Err(contract_error("summary"));
    }
    if data["tests"]["provenance"] != "unknown" || data["tests"]["reason"] != "not_collected" {
        return Err(contract_error("tests"));
    }

    let revision = &data["revision"];
    if !(revision["source"].is_null() || revision["source"].is_string()) {
        return Err(contract_error("revision.source"));
    }
    for field in ["base_commit", "head_commit"] {
        evidence(&revision[field], &format!("revision.{field}"))?;
        if revision[field]["provenance"] != "unknown"
            && !revision[field]["value"].as_str().is_some_and(valid_text)
        {
            return Err(contract_error(&format!("revision.{field}")));
        }
    }

    let changes = &data["changes"];
    if !changes["list"].is_array()
        || !changes["truncated"].is_boolean()
        || !(changes["total_files"].is_null() || changes["total_files"].as_u64().is_some())
    {
        return Err(contract_error("changes"));
    }
    for field in ["files", "additions", "deletions"] {
        evidence(&changes[field], &format!("changes.{field}"))?;
        if changes[field]["provenance"] != "unknown" && changes[field]["value"].as_u64().is_none() {
            return Err(contract_error(&format!("changes.{field}")));
        }
    }
    if changes["files"]["provenance"] == "unknown"
        && !changes["list"].as_array().unwrap().is_empty()
    {
        return Err(contract_error("changes.list"));
    }
    for file in changes["list"].as_array().unwrap() {
        if !file["path"].as_str().is_some_and(|path| !path.is_empty())
            || !(file["additions"].is_null() || file["additions"].as_u64().is_some())
            || !(file["deletions"].is_null() || file["deletions"].as_u64().is_some())
        {
            return Err(contract_error("changes.list[]"));
        }
    }

    let artifacts = &data["artifacts"];
    let provenance = artifacts["provenance"]
        .as_str()
        .filter(|value| PROVENANCE.contains(value))
        .ok_or_else(|| contract_error("artifacts"))?;
    if !artifacts["items"].is_array()
        || (provenance == "unknown"
            && (!artifacts["items"].as_array().unwrap().is_empty()
                || !artifacts["reason"]
                    .as_str()
                    .is_some_and(|reason| !reason.trim().is_empty())))
        || (provenance != "unknown" && artifacts.get("reason").is_some())
    {
        return Err(contract_error("artifacts"));
    }
    for item in artifacts["items"].as_array().unwrap() {
        if !item["id"].as_str().is_some_and(valid_text)
            || !item["kind"].as_str().is_some_and(|kind| !kind.is_empty())
            || !(item["uri"].is_null() || item["uri"].is_string())
            || !(item["sha256"].is_null() || item["sha256"].is_string())
            || !(item["bytes"].is_null() || item["bytes"].as_u64().is_some())
        {
            return Err(contract_error("artifacts.items[]"));
        }
    }

    let acceptance = &data["acceptance"];
    let acceptance_state = acceptance["state"]
        .as_str()
        .filter(|state| ACCEPTANCE.contains(state))
        .ok_or_else(|| contract_error("acceptance"))?;
    if acceptance_state != "none"
        && (!acceptance["decided_head"].as_str().is_some_and(valid_text)
            || !acceptance["head_matches"].is_boolean())
    {
        return Err(contract_error("acceptance"));
    }
    if (acceptance_state == "accepted" && acceptance["head_matches"] != true)
        || (acceptance_state == "stale" && acceptance["head_matches"] != false)
    {
        return Err(contract_error("acceptance.head_matches"));
    }

    let decision = &data["decision"];
    let can_decide = decision["can_decide"]
        .as_bool()
        .ok_or_else(|| contract_error("decision"))?;
    if can_decide {
        if !decision["head_commit"].as_str().is_some_and(valid_text)
            || decision["head_commit"] != revision["head_commit"]["value"]
        {
            return Err(contract_error("decision.head_commit"));
        }
    } else if !DECISION_BLOCKS.contains(&decision["reason"].as_str().unwrap_or_default())
        || !decision["head_commit"].is_null()
    {
        return Err(contract_error("decision.reason"));
    }

    let completeness = &data["completeness"];
    let completeness_state = completeness["state"]
        .as_str()
        .filter(|state| ["complete", "partial"].contains(state))
        .ok_or_else(|| contract_error("completeness.state"))?;
    let gaps = completeness["gaps"]
        .as_array()
        .filter(|gaps| gaps.iter().all(Value::is_string))
        .ok_or_else(|| contract_error("completeness.gaps"))?;
    let has_required_gaps = gaps
        .iter()
        .any(|gap| matches!(gap.as_str(), Some("revision" | "changes")));
    if !gaps.iter().any(|gap| gap == "tests")
        || (completeness_state == "complete" && has_required_gaps)
        || (completeness_state == "partial" && !has_required_gaps)
        || data["limits"]["max_files"].as_u64().is_none_or(|n| n == 0)
        || data["limits"]["max_summary_chars"]
            .as_u64()
            .is_none_or(|n| n == 0)
    {
        return Err(contract_error("completeness"));
    }
    Ok(data)
}

fn check_review_result(
    data: Value,
    request: &ReviewRequest,
    pack: &Value,
    decision: Decision,
    head_commit: &str,
) -> Result<(Value, Option<String>), Failure> {
    if data["attempt_id"] != request.attempt_id || data["task_id"] != pack["task_id"] {
        return Err(contract_error("attempt_review.identity"));
    }
    match data["outcome"].as_str() {
        Some("recorded") => {
            if data["decision"] != decision.core_value()
                || data["head_commit"] != head_commit
                || data["decision_id"].as_u64().is_none()
                || data["at"].as_u64().is_none()
                || !(data["base_commit"].is_null() || data["base_commit"].is_string())
                || !(data["base_source"].is_null() || data["base_source"].is_string())
                || !(data["comment"].is_null() || data["comment"].is_string())
            {
                return Err(contract_error("attempt_review.recorded"));
            }
            Ok((data, None))
        }
        Some("head_moved") => {
            let found = data["found_commit"]
                .as_str()
                .filter(|found| valid_text(found) && *found != head_commit)
                .ok_or_else(|| contract_error("attempt_review.found_commit"))?;
            if data["expected_commit"] != head_commit {
                return Err(contract_error("attempt_review.expected_commit"));
            }
            let message = format!(
                "La rama se movió: el Proof Pack mostraba {head_commit}, pero el HEAD actual es {}. No se registró la decisión; vuelve a revisar el Proof Pack.",
                clean(found)
            );
            Ok((data, Some(message)))
        }
        _ => Err(contract_error("attempt_review.outcome")),
    }
}

fn review_rpc(
    rpc: Rpc,
    request: &ReviewRequest,
    pack: &Value,
    decision: Decision,
) -> Result<(Value, Option<String>), Failure> {
    if pack["decision"]["can_decide"] != true {
        let reason = pack["decision"]["reason"].as_str().unwrap_or("no_revision");
        let explanation = match reason {
            "pending_approval" => "el Attempt sigue pendiente de aprobación",
            "not_current_attempt" => "solo se puede revisar el Attempt actual de la Task",
            "not_final" => "el Attempt todavía no terminó",
            _ => "el Proof Pack no pudo comprobar un HEAD para revisar",
        };
        return Err(usage(format!(
            "No se puede registrar la decisión porque {explanation} ({reason})."
        )));
    }
    let head_commit = pack["decision"]["head_commit"]
        .as_str()
        .ok_or_else(|| contract_error("decision.head_commit"))?;
    let mut args = json!({
        "attempt_id": request.attempt_id,
        "decision": decision.core_value(),
        "head_commit": head_commit,
        "confirm": true,
    });
    if let Some(comment) = &request.comment {
        args["comment"] = json!(comment);
    }
    let data =
        rpc("attempt_review", &args).map_err(|error| rpc_failure(error, "attempt_review"))?;
    check_review_result(data, request, pack, decision, head_commit)
}

fn marker(value: &Value) -> String {
    match value["provenance"].as_str() {
        Some("verified") => "✓ Verificado".into(),
        Some("agent_reported") => "⚠ Declarado por el agente".into(),
        Some("unknown") => format!(
            "? Sin dato ({})",
            clean(value["reason"].as_str().unwrap_or("motivo no informado"))
        ),
        _ => "? Procedencia no reconocida".into(),
    }
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(text) => clean(text),
        Value::Null => "—".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        _ => clean(&value.to_string()),
    }
}

fn evidence_line(value: &Value, render: impl FnOnce(&Value) -> String) -> String {
    if value["provenance"] == "unknown" {
        marker(value)
    } else {
        format!("{} · {}", marker(value), render(&value["value"]))
    }
}

fn render_objective(value: &Value) -> String {
    let title = clean(value["title"].as_str().unwrap_or(""));
    let objective = clean(value["objective"].as_str().unwrap_or(""));
    match (title.is_empty(), objective.is_empty()) {
        (false, false) => format!("{title} — {objective}"),
        (false, true) => title,
        (true, false) => objective,
        (true, true) => "sin objetivo registrado".into(),
    }
}

fn render_revision(pack: &Value) -> String {
    let revision = &pack["revision"];
    let base = evidence_line(&revision["base_commit"], value_text);
    let head = evidence_line(&revision["head_commit"], value_text);
    let source = revision["source"]
        .as_str()
        .map(|source| format!(" · fuente {}", clean(source)))
        .unwrap_or_default();
    format!("base: {base} · HEAD: {head}{source}")
}

fn render_changes(pack: &Value) -> String {
    let changes = &pack["changes"];
    let files = evidence_line(&changes["files"], |value| {
        format!("{} archivos", value_text(value))
    });
    let additions = evidence_line(&changes["additions"], value_text);
    let deletions = evidence_line(&changes["deletions"], value_text);
    let mut result = format!("{files}; +{additions}; −{deletions}");
    if changes["truncated"] == true {
        result.push_str(&format!(
            "; lista recortada a {} de {}",
            changes["list"].as_array().map_or(0, Vec::len),
            value_text(&changes["total_files"])
        ));
    }
    result
}

fn render_artifacts(pack: &Value) -> Vec<String> {
    let artifacts = &pack["artifacts"];
    let Some(items) = artifacts["items"].as_array() else {
        return vec![marker(artifacts)];
    };
    if artifacts["provenance"] == "unknown" {
        return vec![marker(artifacts)];
    }
    if items.is_empty() {
        return vec![format!(
            "{} · no hay artefactos declarados",
            marker(artifacts)
        )];
    }
    items
        .iter()
        .map(|item| {
            format!(
                "{} · {} (id {})",
                marker(artifacts),
                clean(item["kind"].as_str().unwrap_or("artefacto")),
                clean(item["id"].as_str().unwrap_or("?"))
            )
        })
        .collect()
}

fn status_text(value: &Value) -> String {
    let status = attempts::status_text(value["status"].as_str().unwrap_or("?"));
    match value["failure_reason"].as_str() {
        Some(reason) => format!("{status} · fallo {}", clean(reason)),
        None => status,
    }
}

fn acceptance_text(pack: &Value) -> String {
    let acceptance = &pack["acceptance"];
    match acceptance["state"].as_str().unwrap_or("?") {
        "none" => "sin decisión anterior".into(),
        "accepted" => format!(
            "aceptación vigente sobre {}",
            clean(acceptance["decided_head"].as_str().unwrap_or("?"))
        ),
        "stale" => format!(
            "aceptación obsoleta: se decidió sobre {}, no sobre el HEAD actual",
            clean(acceptance["decided_head"].as_str().unwrap_or("?"))
        ),
        "rejected" => format!(
            "última decisión: rechazo sobre {}",
            clean(acceptance["decided_head"].as_str().unwrap_or("?"))
        ),
        other => clean(other),
    }
}

fn blocked_reason(pack: &Value) -> String {
    match pack["decision"]["reason"].as_str().unwrap_or("?") {
        "pending_approval" => "pendiente de aprobación".into(),
        "not_current_attempt" => "no es el Attempt actual".into(),
        "not_final" => "todavía está en curso".into(),
        "no_revision" => "no hay un HEAD comprobado".into(),
        other => clean(other),
    }
}

fn review_text(pack: &Value, review: Option<&Value>, open: bool) -> String {
    let id = clean(pack["attempt_id"].as_str().unwrap_or("?"));
    let n = pack["n"]
        .as_u64()
        .map(|number| format!(" #{number}"))
        .unwrap_or_default();
    let completeness = if pack["completeness"]["state"] == "complete" {
        "completo"
    } else {
        "parcial"
    };
    let mut lines = vec![
        format!("Proof Pack · Attempt {id}{n} · evidencia {completeness}"),
        format!("Task: {}", clean(pack["task_id"].as_str().unwrap_or("?"))),
        format!("Estado: {}", evidence_line(&pack["status"], status_text)),
        format!(
            "Objetivo: {}",
            evidence_line(&pack["objective"], render_objective)
        ),
        format!("Revisión: {}", render_revision(pack)),
        format!("Cambios: {}", render_changes(pack)),
        format!("Pruebas: {}", evidence_line(&pack["tests"], value_text)),
        format!("Resumen: {}", evidence_line(&pack["summary"], value_text)),
    ];

    let artifacts = render_artifacts(pack);
    if let Some(first) = artifacts.first() {
        lines.push(format!("Artefactos: {first}"));
        for extra in artifacts.iter().skip(1) {
            lines.push(format!("            {extra}"));
        }
    }
    for file in pack["changes"]["list"].as_array().into_iter().flatten() {
        let additions = file["additions"]
            .as_u64()
            .map(|number| format!("+{number}"))
            .unwrap_or_else(|| "+desconocido".into());
        let deletions = file["deletions"]
            .as_u64()
            .map(|number| format!("−{number}"))
            .unwrap_or_else(|| "−desconocido".into());
        lines.push(format!(
            "  {} ({additions}, {deletions})",
            clean(file["path"].as_str().unwrap_or("?"))
        ));
    }
    lines.push(format!("Aceptación: {}", acceptance_text(pack)));
    if pack["decision"]["can_decide"] == true {
        lines.push(format!(
            "Decisión disponible sobre HEAD: {}",
            clean(pack["decision"]["head_commit"].as_str().unwrap_or("?"))
        ));
    } else {
        lines.push(format!(
            "No se puede decidir ahora: {}",
            blocked_reason(pack)
        ));
    }
    let gaps = pack["completeness"]["gaps"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(clean)
        .collect::<Vec<_>>();
    lines.push(format!(
        "Integridad: {completeness}; faltan: {}",
        if gaps.is_empty() {
            "ningún dato".into()
        } else {
            gaps.join(", ")
        }
    ));

    if let Some(review) = review {
        match review["outcome"].as_str() {
            Some("recorded") => {
                let verb = if review["decision"] == "accepted" {
                    Decision::Accept.label()
                } else {
                    Decision::Reject.label()
                };
                lines.push(format!(
                    "Decisión registrada: {verb} sobre HEAD {}. No integra ni borra nada.",
                    clean(review["head_commit"].as_str().unwrap_or("?"))
                ));
            }
            Some("head_moved") => {
                lines.push(format!(
                    "No se registró la decisión: HEAD mostrado {}, HEAD actual {}. Vuelve a ejecutar `lxo review {id}`.",
                    clean(review["expected_commit"].as_str().unwrap_or("?")),
                    clean(review["found_commit"].as_str().unwrap_or("?"))
                ));
            }
            _ => lines.push("El Core devolvió una decisión no reconocida.".into()),
        }
    }
    if open {
        lines.push(format!(
            "Desktop: Attempt ID {id} (abre Lixbon manualmente; este CLI no inicia la app)."
        ));
    }
    lines.join("\n")
}

fn cli_json(pack: &Value, review: Option<&Value>) -> Value {
    json!({
        "v": CLI_API,
        "proof_pack": pack,
        "review": review,
    })
}

fn result_json(output: &Output) -> Value {
    match &output.stale {
        Some(message) => json!({
            "ok": false,
            "code": "stale",
            "error": message,
            "result": output.json,
        }),
        None => output.json.clone(),
    }
}

fn result_exit(output: &Output) -> ExitCode {
    output
        .stale
        .as_ref()
        .map(|message| ExitCode::from(Failure::Stale(message.clone()).code().1))
        .unwrap_or(ExitCode::SUCCESS)
}

fn execute(rpc: Rpc, request: &ReviewRequest) -> Result<Output, Failure> {
    let pack = rpc(
        "attempt_proof_pack",
        &json!({ "attempt_id": request.attempt_id }),
    )
    .map_err(|error| rpc_failure(error, "attempt_proof_pack"))?;
    let pack = check_proof_pack(pack, &request.attempt_id)?;
    let (review, stale) = match request.decision {
        Some(decision) => {
            let (review, stale) = review_rpc(rpc, request, &pack, decision)?;
            (Some(review), stale)
        }
        None => (None, None),
    };
    let output = cli_json(&pack, review.as_ref());
    let human = review_text(&pack, review.as_ref(), request.open);
    Ok(Output {
        json: output,
        human,
        stale,
    })
}

pub(super) fn run(a: &Args) -> ExitCode {
    let json_output = a.b("json");
    let request = match parse(a) {
        Ok(request) => request,
        Err(error) => return projects::finish(Err(error), json_output),
    };
    match request {
        Request::Help => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        Request::Review(request) => {
            let mut rpc =
                |command: &str, args: &Value| client_auth::rpc(command, args, &crate::cwd());
            match execute(&mut rpc, &request) {
                Err(error) => projects::finish(Err(error), json_output),
                Ok(output) => {
                    if json_output {
                        println!("{}", result_json(&output));
                    } else {
                        println!("{}", output.human);
                    }
                    result_exit(&output)
                }
            }
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

    fn ev(value: Value, provenance: &str) -> Value {
        if provenance == "unknown" {
            json!({ "value": null, "provenance": provenance, "reason": "not_collected" })
        } else {
            json!({ "value": value, "provenance": provenance })
        }
    }

    fn proof_pack() -> Value {
        json!({
            "v": 1,
            "attempt_id": "t3-a2",
            "task_id": "t3",
            "n": 2,
            "is_current": true,
            "status": ev(json!({"status": "done", "failure_reason": null}), "verified"),
            "objective": ev(json!({"title": "Revisar", "objective": "Validar el cambio"}), "verified"),
            "revision": {
                "source": "live_branch",
                "base_commit": ev(json!("base-123"), "verified"),
                "head_commit": ev(json!("head-456"), "verified")
            },
            "changes": {
                "files": ev(json!(1), "verified"),
                "additions": ev(json!(2), "verified"),
                "deletions": ev(json!(0), "verified"),
                "list": [{"path": "src/a.rs", "additions": 2, "deletions": 0}],
                "truncated": false,
                "total_files": 1
            },
            "summary": ev(json!("resumen declarado"), "agent_reported"),
            "artifacts": {
                "provenance": "agent_reported",
                "items": [{"id": "artifact-1", "kind": "report", "uri": "report.md", "sha256": null, "bytes": null}]
            },
            "tests": ev(Value::Null, "unknown"),
            "acceptance": {"state": "none"},
            "decision": {"can_decide": true, "head_commit": "head-456"},
            "completeness": {"state": "complete", "gaps": ["summary", "tests"]},
            "limits": {"max_files": 200, "max_summary_chars": 2000}
        })
    }

    fn accepted_result() -> Value {
        json!({
            "task_id": "t3",
            "outcome": "recorded",
            "decision": "accepted",
            "decision_id": 17,
            "head_commit": "head-456",
            "base_commit": "base-123",
            "base_source": "recorded",
            "comment": "LGTM",
            "at": 42,
            "attempt_id": "t3-a2"
        })
    }

    fn rejected_result() -> Value {
        json!({
            "task_id": "t3",
            "outcome": "recorded",
            "decision": "rejected",
            "decision_id": 18,
            "head_commit": "head-456",
            "base_commit": "base-123",
            "base_source": "recorded",
            "comment": null,
            "at": 43,
            "attempt_id": "t3-a2"
        })
    }

    fn mock_rpc(
        pack: Value,
        review: Result<Value, RpcFailure>,
        calls: Rc<RefCell<Vec<(String, Value)>>>,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        move |command, args| {
            calls.borrow_mut().push((command.to_string(), args.clone()));
            match command {
                "attempt_proof_pack" => Ok(pack.clone()),
                "attempt_review" => {
                    review
                        .as_ref()
                        .map(Value::clone)
                        .map_err(|error| match error {
                            RpcFailure::Rejected(message) => RpcFailure::Rejected(message.clone()),
                            RpcFailure::Transport(_) => {
                                panic!("no se clona un transporte de prueba")
                            }
                        })
                }
                other => panic!("comando inesperado {other}"),
            }
        }
    }

    #[test]
    fn parsea_lectura_y_decisiones_y_rechaza_combinaciones_ambiguas() {
        assert_eq!(
            parse(&args(&[
                "review",
                "t3-a2",
                "--accept",
                "--comment",
                "  revisar  "
            ])),
            Ok(Request::Review(ReviewRequest {
                attempt_id: "t3-a2".into(),
                decision: Some(Decision::Accept),
                comment: Some("revisar".into()),
                open: false,
            }))
        );
        assert!(matches!(
            parse(&args(&["review", "t3-a2"])),
            Ok(Request::Review(ReviewRequest {
                decision: None,
                comment: None,
                ..
            }))
        ));
        for (raw, expected) in [
            (&["review"][..], "Falta el intento"),
            (&["review", "t3-a2", "t4-a1"][..], "un solo id"),
            (
                &["review", "t3-a2", "--accept", "--reject"][..],
                "solo una decisión",
            ),
            (
                &["review", "t3-a2", "--comment", "nota"][..],
                "solo se usa junto",
            ),
            (
                &["review", "t3-a2", "--accept=si"][..],
                "no admite un valor",
            ),
            (&["review", "t3-a2", "--mystery"][..], "no es una opción"),
            (&["review", "--help"][..], "Uso: lxo review"),
        ] {
            if raw.contains(&"--help") {
                assert_eq!(parse(&args(raw)), Ok(Request::Help));
                continue;
            }
            assert!(
                matches!(parse(&args(raw)), Err(Failure::Usage(message)) if message.contains(expected)),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn valida_proof_pack_completo_e_invalida_decisiones_sobre_otro_head() {
        let pack = check_proof_pack(proof_pack(), "t3-a2").unwrap();
        assert_eq!(pack["decision"]["head_commit"], "head-456");
        let mut wrong_head = proof_pack();
        wrong_head["decision"]["head_commit"] = json!("head-older");
        assert!(matches!(
            check_proof_pack(wrong_head, "t3-a2"),
            Err(Failure::Version(_))
        ));
        let mut bad_provenance = proof_pack();
        bad_provenance["summary"]["provenance"] = json!("verified");
        bad_provenance["summary"]["reason"] = json!("agent_reported");
        assert!(matches!(
            check_proof_pack(bad_provenance, "t3-a2"),
            Err(Failure::Version(_))
        ));
        let mut wrong_identity = proof_pack();
        wrong_identity["attempt_id"] = json!("t3-a1");
        assert!(matches!(
            check_proof_pack(wrong_identity, "t3-a2"),
            Err(Failure::Version(_))
        ));
    }

    #[test]
    fn leer_no_muta_y_muestra_evidencia_procedencia_y_lagunas() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = mock_rpc(proof_pack(), Ok(accepted_result()), calls.clone());
        let output = execute(
            &mut rpc,
            &ReviewRequest {
                attempt_id: "t3-a2".into(),
                decision: None,
                comment: None,
                open: false,
            },
        )
        .unwrap();
        assert_eq!(
            calls
                .borrow()
                .iter()
                .map(|(cmd, _)| cmd.as_str())
                .collect::<Vec<_>>(),
            ["attempt_proof_pack"]
        );
        for expected in [
            "Proof Pack · Attempt t3-a2 #2 · evidencia completo",
            "Estado: ✓ Verificado · terminado",
            "Resumen: ⚠ Declarado por el agente · resumen declarado",
            "Pruebas: ? Sin dato (not_collected)",
            "Artefactos: ⚠ Declarado por el agente · report (id artifact-1)",
            "src/a.rs (+2, −0)",
            "Integridad: completo; faltan: summary, tests",
        ] {
            assert!(
                output.human.contains(expected),
                "{expected}\n{}",
                output.human
            );
        }
        assert_eq!(output.json["review"], Value::Null);
    }

    #[test]
    fn accept_envia_solo_el_head_del_proof_pack_y_confirmacion_explicita() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = mock_rpc(proof_pack(), Ok(accepted_result()), calls.clone());
        let request = ReviewRequest {
            attempt_id: "t3-a2".into(),
            decision: Some(Decision::Accept),
            comment: Some("LGTM".into()),
            open: false,
        };
        let output = execute(&mut rpc, &request).unwrap();
        assert_eq!(output.json["review"]["outcome"], "recorded");
        assert_eq!(
            calls.borrow()[1].1,
            json!({
                "attempt_id": "t3-a2",
                "decision": "accepted",
                "head_commit": "head-456",
                "confirm": true,
                "comment": "LGTM"
            })
        );
        assert!(output
            .human
            .contains("Decisión registrada: Aceptado sobre HEAD head-456"));
        assert!(output.human.contains("No integra ni borra nada."));
    }

    #[test]
    fn reject_envia_la_misma_revision_y_no_borra_el_attempt() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = mock_rpc(proof_pack(), Ok(rejected_result()), calls.clone());
        let output = execute(
            &mut rpc,
            &ReviewRequest {
                attempt_id: "t3-a2".into(),
                decision: Some(Decision::Reject),
                comment: None,
                open: false,
            },
        )
        .unwrap();
        assert_eq!(
            calls.borrow()[1].1,
            json!({
                "attempt_id": "t3-a2",
                "decision": "rejected",
                "head_commit": "head-456",
                "confirm": true
            })
        );
        assert!(output.human.contains("Decisión registrada: Rechazado"));
        assert!(output.human.contains("No integra ni borra nada."));
    }

    #[test]
    fn bloquea_intentos_no_decidibles_y_no_reintenta_tras_head_moved() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut blocked_pack = proof_pack();
        blocked_pack["decision"] = json!({
            "can_decide": false,
            "reason": "not_final",
            "head_commit": null
        });
        let mut blocked = mock_rpc(blocked_pack, Ok(accepted_result()), calls.clone());
        assert!(matches!(
            execute(
                &mut blocked,
                &ReviewRequest {
                    attempt_id: "t3-a2".into(),
                    decision: Some(Decision::Accept),
                    comment: None,
                    open: false,
                }
            ),
            Err(Failure::Usage(message)) if message.contains("todavía no terminó")
        ));
        assert_eq!(calls.borrow().len(), 1);

        calls.borrow_mut().clear();
        let moved = json!({
            "task_id": "t3",
            "outcome": "head_moved",
            "expected_commit": "head-456",
            "found_commit": "head-789",
            "attempt_id": "t3-a2"
        });
        let mut rpc = mock_rpc(proof_pack(), Ok(moved), calls.clone());
        let output = execute(
            &mut rpc,
            &ReviewRequest {
                attempt_id: "t3-a2".into(),
                decision: Some(Decision::Accept),
                comment: None,
                open: true,
            },
        )
        .unwrap();
        assert!(output.stale.is_some());
        assert_eq!(calls.borrow().len(), 2);
        assert_eq!(output.json["review"]["outcome"], "head_moved");
        let machine = result_json(&output);
        assert_eq!(machine["code"], "stale");
        assert_eq!(machine["result"]["review"]["outcome"], "head_moved");
        assert_eq!(result_exit(&output), ExitCode::from(7));
        assert!(output.human.contains("No se registró la decisión"));
        assert!(output.human.contains("Desktop: Attempt ID t3-a2"));
    }

    #[test]
    fn fallos_de_autorizacion_y_de_estado_tienen_codigos_adecuados() {
        for (message, expected) in [
            (
                "model_auth_required: solo una Person",
                ("authentication", 3),
            ),
            (
                "revisar un Attempt requiere una Person autenticada",
                ("authentication", 3),
            ),
            ("review_not_current: solo el actual", ("usage", 2)),
            ("review_not_final: sigue en curso", ("usage", 2)),
            ("review_not_found: no existe", ("not_found", 6)),
        ] {
            let error = rpc_failure(RpcFailure::Rejected(message.into()), "attempt_review");
            assert_eq!(error.code(), expected, "{message}");
        }
        assert_eq!(Failure::Stale("movido".into()).code(), ("stale", 7));
    }

    #[test]
    fn los_json_v1_del_proof_pack_y_la_decision_son_snapshots_estables() {
        let pack = check_proof_pack(proof_pack(), "t3-a2").unwrap();
        crate::snapshot("review.v1.json", &cli_json(&pack, None));
        crate::snapshot(
            "review.recorded.v1.json",
            &cli_json(&pack, Some(&accepted_result())),
        );
    }

    #[test]
    fn texto_no_inyecta_controles_y_open_no_lanza_desktop() {
        let mut pack = proof_pack();
        pack["summary"]["value"] = json!("resumen\n\x1b[31m");
        let pack = check_proof_pack(pack, "t3-a2").unwrap();
        let text = review_text(&pack, None, true);
        assert!(!text.contains('\x1b'));
        assert!(text.contains("resumen??[31m"));
        assert!(text.contains("Desktop: Attempt ID t3-a2"));
        assert!(text.contains("no inicia la app"));
    }
}
