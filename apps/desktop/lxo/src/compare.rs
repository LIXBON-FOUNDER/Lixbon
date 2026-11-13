//! `lxo compare`: selección explícita de Attempts y presentación de la query estructurada del Core.

use std::collections::HashSet;
use std::process::ExitCode;

use serde_json::{json, Value};

use crate::attempts;
use crate::client_auth::{self, RpcFailure};
use crate::events::clean;
use crate::projects::{finish, usage, Failure};
use crate::Args;

const API: u64 = 1;
const ATTEMPT_API: u64 = 1;
const MODEL: &str = "task_attempt_v1";
const PAGE_SIZE: u64 = 100;
const MAX_PAGES: usize = 1000;
const MAX_ATTEMPTS: usize = 4;
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
const FLAGS: [&str; 5] = ["task", "status", "provider", "json", "help"];

type Rpc<'a> = &'a mut dyn FnMut(&str, &Value) -> Result<Value, RpcFailure>;

pub(super) const HELP: &str =
    "Uso: lxo compare --task <task_id> [attempt_id ...] [--status S] [--provider P] [--json]

Compara de 2 a 4 Attempts de una misma Task usando `attempt_compare` del Core.
No calcula pruebas ni git, no puntúa, no elige ganador y no integra.

Selección:
  --task ID          Task obligatoria; impide mezclar Tasks
  attempt_id ...     2–4 ids explícitos, en el orden que se compararán
  --status S         sin ids explícitos, selecciona por estado
  --provider P       sin ids explícitos, selecciona por proveedor (sin distinguir mayúsculas)
  Sin ids ni filtros, se comparan todos si hay entre 2 y 4; con más, elige los ids.

Cada dato conserva su procedencia: `verified` (✓ verificado por el Core),
`agent_reported` (⚠ declarado por el agente) o `unknown` (? desconocido con motivo).
Las pruebas siguen siendo unknown mientras el
Core no las recoja. La salida humana es vertical para terminales estrechas e
incluye `lxo review <attempt_id>` y el id que puede abrirse en Desktop.
--json devuelve la respuesta v1 completa de `attempt_compare`.

Solo para personas (3 si la credencial es de un agente).
Códigos: 0 correcto, 1 error interno, 2 uso o selección inválida,
3 autenticación o permiso, 4 versión o contrato, 5 Core no disponible,
6 Task o Attempt inexistente.
";

#[derive(Debug, PartialEq, Eq)]
struct Filters {
    status: Option<String>,
    provider: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Help,
    Compare {
        task_id: String,
        attempt_ids: Vec<String>,
        filters: Filters,
    },
}

fn contract_error(detail: &str) -> Failure {
    Failure::Version(format!(
        "El Core devolvió una comparación con un formato que este lxo no entiende ({detail}); actualiza Lixbon."
    ))
}

fn text_flag(a: &Args, name: &str) -> Result<Option<String>, Failure> {
    match a.flags.get(name) {
        None => Ok(None),
        Some(Value::String(v)) if !v.trim().is_empty() => Ok(Some(v.trim().to_string())),
        _ => Err(usage(format!("--{name} requiere un valor."))),
    }
}

fn valid_id(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= 200 && !trimmed.chars().any(char::is_control)
}

fn parse(a: &Args) -> Result<Request, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    if let Some(name) = a.flags.keys().find(|k| !FLAGS.contains(&k.as_str())) {
        return Err(usage(format!(
            "--{name} no es una opción de lxo compare. Mira `lxo compare --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["json", "help"] {
        if a.flags.get(name).is_some_and(|v| !v.is_boolean()) {
            return Err(usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }
    let Some(task_id) = text_flag(a, "task")? else {
        return Err(usage(
            "Falta la tarea: lxo compare --task <task_id> [attempt_id ...].",
        ));
    };
    if !valid_id(&task_id) {
        return Err(usage(
            "--task debe contener de 1 a 200 caracteres sin controles.",
        ));
    }
    let filters = Filters {
        status: text_flag(a, "status")?,
        provider: text_flag(a, "provider")?,
    };
    if let Some(status) = &filters.status {
        if !STATUSES.contains(&status.as_str()) {
            return Err(usage(format!(
                "--status no reconoce «{}»; usa {}.",
                clean(status),
                STATUSES.join(", ")
            )));
        }
    }

    let mut attempt_ids = Vec::new();
    for id in a.pos.get(1..).unwrap_or_default() {
        if !valid_id(id) {
            return Err(usage(
                "Cada id de Attempt debe contener de 1 a 200 caracteres sin controles.",
            ));
        }
        let id = id.trim().to_string();
        if attempt_ids.contains(&id) {
            return Err(usage(format!("El Attempt «{}» está repetido.", clean(&id))));
        }
        attempt_ids.push(id);
    }
    if !attempt_ids.is_empty() && !(2..=MAX_ATTEMPTS).contains(&attempt_ids.len()) {
        return Err(usage(format!(
            "Selecciona de 2 a {MAX_ATTEMPTS} Attempts distintos; llegaron {}.",
            attempt_ids.len()
        )));
    }
    Ok(Request::Compare {
        task_id,
        attempt_ids,
        filters,
    })
}

fn error_from_model(error: RpcFailure, operation: &str) -> Failure {
    if let RpcFailure::Rejected(message) = &error {
        if message.starts_with("model_not_found") {
            return Failure::NotFound(format!(
                "No se encontró la Task o uno de los Attempts pedidos ({operation})."
            ));
        }
        if message.starts_with("compare_not_comparable") {
            return usage(format!(
                "El Core no considera comparables estos Attempts: {}",
                clean(message.trim_start_matches("compare_not_comparable: "))
            ));
        }
        if message.starts_with("Comando desconocido") {
            return Failure::Version(
                "Este Core no ofrece `attempt_compare`; actualiza Lixbon.".into(),
            );
        }
    }
    attempts::model_failure(error)
}

fn check_list_page<'a>(data: &'a Value, task_id: &str) -> Result<&'a Vec<Value>, Failure> {
    if data["v"].as_u64() != Some(ATTEMPT_API)
        || data["core_model"] != MODEL
        || data["task_id"] != task_id
        || !data["items"].is_array()
        || !(data["next_cursor"].is_null() || data["next_cursor"].is_string())
    {
        return Err(contract_error("attempts_by_task"));
    }
    let items = data["items"]
        .as_array()
        .ok_or_else(|| contract_error("attempts_by_task.items"))?;
    for item in items {
        if !item["id"].as_str().is_some_and(valid_id)
            || !item["status"]
                .as_str()
                .is_some_and(|s| STATUSES.contains(&s))
            || item["n"].as_u64().is_none_or(|n| n == 0)
            || !(item["provider"].is_string() || item["provider"].is_null())
        {
            return Err(contract_error("attempts_by_task.items[]"));
        }
    }
    Ok(items)
}

fn task_attempts(rpc: Rpc, task_id: &str) -> Result<Vec<Value>, Failure> {
    let mut cursor: Option<String> = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_ids = HashSet::new();
    let mut attempts = Vec::new();
    for _ in 0..MAX_PAGES {
        let mut args = json!({ "task_id": task_id, "limit": PAGE_SIZE });
        if let Some(value) = &cursor {
            args["cursor"] = json!(value);
        }
        let page =
            rpc("attempts_by_task", &args).map_err(|e| error_from_model(e, "attempts_by_task"))?;
        for attempt in check_list_page(&page, task_id)? {
            let id = attempt["id"].as_str().unwrap_or_default();
            if !seen_ids.insert(id.to_string()) {
                return Err(contract_error(
                    "attempts_by_task repite un id entre páginas",
                ));
            }
            attempts.push(attempt.clone());
        }
        match page["next_cursor"].as_str() {
            None => return Ok(attempts),
            Some(next) if !next.trim().is_empty() && seen_cursors.insert(next.to_string()) => {
                cursor = Some(next.to_string());
            }
            Some(_) => return Err(contract_error("next_cursor vacío o repetido")),
        }
    }
    Err(contract_error(
        "la paginación excede el límite de seguridad",
    ))
}

fn detail_for(rpc: Rpc, task_id: &str, attempt_id: &str) -> Result<Value, Failure> {
    let data = rpc("attempt_detail", &json!({ "attempt_id": attempt_id }))
        .map_err(|e| error_from_model(e, "attempt_detail"))?;
    let attempt = &data["attempt"];
    if data["v"].as_u64() != Some(ATTEMPT_API)
        || data["core_model"] != MODEL
        || attempt["id"] != attempt_id
        || attempt["task_id"] != task_id
        || attempt["status"]
            .as_str()
            .is_none_or(|s| !STATUSES.contains(&s))
        || !(attempt["provider"].is_string() || attempt["provider"].is_null())
    {
        if data["v"].as_u64() == Some(ATTEMPT_API)
            && data["core_model"] == MODEL
            && attempt["id"].is_string()
            && attempt["task_id"].is_string()
            && attempt["task_id"] != task_id
        {
            return Err(usage(format!(
                "«{}» no pertenece a la tarea «{}»; compare no mezcla Tasks.",
                clean(attempt_id),
                clean(task_id)
            )));
        }
        return Err(contract_error("attempt_detail"));
    }
    Ok(attempt.clone())
}

fn matches_filters(attempt: &Value, filters: &Filters) -> bool {
    filters
        .status
        .as_deref()
        .is_none_or(|status| attempt["status"] == status)
        && filters.provider.as_deref().is_none_or(|provider| {
            attempt["provider"]
                .as_str()
                .is_some_and(|actual| actual.eq_ignore_ascii_case(provider))
        })
}

fn select_attempts(
    rpc: Rpc,
    task_id: &str,
    requested: &[String],
    filters: &Filters,
) -> Result<Vec<String>, Failure> {
    if !requested.is_empty() {
        let mut selected = Vec::with_capacity(requested.len());
        for id in requested {
            let attempt = detail_for(rpc, task_id, id)?;
            if !matches_filters(&attempt, filters) {
                return Err(usage(format!(
                    "El Attempt «{}» no cumple los filtros seleccionados.",
                    clean(id)
                )));
            }
            selected.push(id.clone());
        }
        return Ok(selected);
    }

    let listed = task_attempts(rpc, task_id)?;
    let selected: Vec<String> = listed
        .iter()
        .filter(|attempt| matches_filters(attempt, filters))
        .filter_map(|attempt| attempt["id"].as_str().map(str::to_string))
        .collect();
    if !(2..=MAX_ATTEMPTS).contains(&selected.len()) {
        return Err(usage(if selected.len() > MAX_ATTEMPTS {
            format!(
                "{} Attempts cumplen los filtros; elige de 2 a {MAX_ATTEMPTS} ids explícitos.",
                selected.len()
            )
        } else {
            format!(
                "Solo {} Attempts cumplen los filtros; se necesitan de 2 a {MAX_ATTEMPTS}.",
                selected.len()
            )
        }));
    }
    Ok(selected)
}

fn evidence(value: &Value, where_: &str) -> Result<(), Failure> {
    let provenance = value["provenance"]
        .as_str()
        .ok_or_else(|| contract_error(where_))?;
    if !["verified", "agent_reported", "unknown"].contains(&provenance) {
        return Err(contract_error(where_));
    }
    if provenance == "unknown" {
        if !value["value"].is_null()
            || !value["reason"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
        {
            return Err(contract_error(where_));
        }
    } else if value["value"].is_null() || value.get("reason").is_some() {
        return Err(contract_error(where_));
    }
    Ok(())
}

fn validate_attempt(
    attempt: &Value,
    index: usize,
    requested_id: &str,
    task_id: &str,
) -> Result<(), Failure> {
    let prefix = format!("attempts[{index}]");
    if attempt["attempt_id"] != requested_id
        || attempt["task_id"] != task_id
        || attempt["n"].as_u64().is_none_or(|n| n == 0)
        || !attempt["is_current"].is_boolean()
        || !(attempt["forked_from"].is_null()
            || attempt["forked_from"].as_str().is_some_and(valid_id))
    {
        return Err(contract_error(&format!("{prefix}.identity")));
    }
    for field in [
        "selection",
        "status",
        "timing",
        "host",
        "worktree",
        "summary",
        "tests",
        "review",
    ] {
        evidence(&attempt[field], &format!("{prefix}.{field}"))?;
    }
    if !attempt["revision"].is_object()
        || !(attempt["revision"]["source"].is_null()
            || attempt["revision"]["source"].as_str().is_some())
    {
        return Err(contract_error(&format!("{prefix}.revision")));
    }
    evidence(
        &attempt["revision"]["base_commit"],
        &format!("{prefix}.revision.base_commit"),
    )?;
    evidence(
        &attempt["revision"]["head_commit"],
        &format!("{prefix}.revision.head_commit"),
    )?;

    let changes = &attempt["changes"];
    if !changes["list"].is_array() || !changes["truncated"].is_boolean() {
        return Err(contract_error(&format!("{prefix}.changes")));
    }
    for field in ["files", "additions", "deletions"] {
        evidence(&changes[field], &format!("{prefix}.changes.{field}"))?;
    }
    if changes["files"]["provenance"] == "unknown"
        && !changes["list"].as_array().unwrap().is_empty()
    {
        return Err(contract_error(&format!("{prefix}.changes.list")));
    }
    for file in changes["list"].as_array().unwrap() {
        if !file["path"].as_str().is_some_and(|s| !s.is_empty())
            || !(file["additions"].is_null() || file["additions"].as_u64().is_some())
            || !(file["deletions"].is_null() || file["deletions"].as_u64().is_some())
        {
            return Err(contract_error(&format!("{prefix}.changes.list[]")));
        }
    }

    let artifacts = &attempt["artifacts"];
    let provenance = artifacts["provenance"]
        .as_str()
        .filter(|p| ["verified", "agent_reported", "unknown"].contains(p))
        .ok_or_else(|| contract_error(&format!("{prefix}.artifacts")))?;
    if !artifacts["items"].is_array()
        || (provenance == "unknown"
            && (!artifacts["items"].as_array().unwrap().is_empty()
                || !artifacts["reason"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty())))
        || (provenance != "unknown" && artifacts.get("reason").is_some())
    {
        return Err(contract_error(&format!("{prefix}.artifacts")));
    }
    for item in artifacts["items"].as_array().unwrap() {
        if !item["id"].as_str().is_some_and(valid_id)
            || !item["kind"].as_str().is_some_and(|s| !s.is_empty())
            || !(item["uri"].is_null() || item["uri"].is_string())
        {
            return Err(contract_error(&format!("{prefix}.artifacts.items[]")));
        }
    }
    Ok(())
}

fn check_compare(data: Value, requested_ids: &[String], task_id: &str) -> Result<Value, Failure> {
    if data["v"].as_u64() != Some(API) {
        return Err(contract_error("versión"));
    }
    if data["relation"]["kind"] != "same_task" || data["relation"]["root"] != task_id {
        return Err(contract_error("relation"));
    }
    let rows = data["attempts"]
        .as_array()
        .filter(|rows| (2..=MAX_ATTEMPTS).contains(&rows.len()))
        .ok_or_else(|| contract_error("attempts"))?;
    if rows.len() != requested_ids.len() {
        return Err(contract_error("attempts.length"));
    }
    for (index, (row, id)) in rows.iter().zip(requested_ids).enumerate() {
        validate_attempt(row, index, id, task_id)?;
    }
    let overlaps = &data["overlaps"];
    let items = overlaps["items"]
        .as_array()
        .ok_or_else(|| contract_error("overlaps.items"))?;
    if !overlaps["complete"].is_boolean() || overlaps["total"].as_u64().is_none() {
        return Err(contract_error("overlaps"));
    }
    for overlap in items {
        let ids = overlap["attempt_ids"]
            .as_array()
            .filter(|ids| ids.len() >= 2)
            .ok_or_else(|| contract_error("overlaps.items[].attempt_ids"))?;
        if !overlap["path"].as_str().is_some_and(|s| !s.is_empty())
            || ids.iter().any(|id| {
                id.as_str()
                    .is_none_or(|id| !requested_ids.iter().any(|asked| asked == id))
            })
        {
            return Err(contract_error("overlaps.items[]"));
        }
    }
    let limits = &data["limits"];
    if limits["max_attempts"]
        .as_u64()
        .is_none_or(|n| n < rows.len() as u64)
        || limits["max_files_per_attempt"].as_u64().is_none()
        || limits["max_overlaps"].as_u64().is_none()
    {
        return Err(contract_error("limits"));
    }
    Ok(data)
}

fn compare_failure(error: RpcFailure) -> Failure {
    error_from_model(error, "attempt_compare")
}

fn compare_data(
    rpc: Rpc,
    task_id: &str,
    requested: &[String],
    filters: &Filters,
) -> Result<Value, Failure> {
    let selected = select_attempts(rpc, task_id, requested, filters)?;
    let args = json!({ "attempt_ids": selected });
    let data = rpc("attempt_compare", &args).map_err(compare_failure)?;
    check_compare(data, &selected, task_id)
}

fn marker(evidence: &Value) -> String {
    match evidence["provenance"].as_str() {
        Some("verified") => "✓ Verificado".into(),
        Some("agent_reported") => "⚠ Declarado por el agente".into(),
        Some("unknown") => format!(
            "? Sin dato ({})",
            clean(evidence["reason"].as_str().unwrap_or("motivo no informado"))
        ),
        _ => "? Procedencia no reconocida".into(),
    }
}

fn evidence_line(evidence: &Value, value: impl FnOnce(&Value) -> String) -> String {
    if evidence["provenance"] == "unknown" {
        marker(evidence)
    } else {
        format!("{} · {}", marker(evidence), value(&evidence["value"]))
    }
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(s) => clean(s),
        Value::Null => "—".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        _ => clean(&value.to_string()),
    }
}

fn duration(value: &Value) -> String {
    let Some(ms) = value["duration_ms"].as_u64() else {
        return "sin duración registrada".into();
    };
    if ms < 1000 {
        return format!("{ms} ms");
    }
    let seconds = ms / 1000;
    if seconds < 60 {
        return format!("{seconds} s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes} min {} s", seconds % 60);
    }
    let hours = minutes / 60;
    format!("{hours} h {} min {} s", minutes % 60, seconds % 60)
}

fn status_label(code: &str) -> String {
    attempts::status_text(code)
}

fn render_selection(value: &Value) -> String {
    let parts: Vec<String> = ["provider", "model", "effort", "role"]
        .iter()
        .filter_map(|key| value[*key].as_str().map(clean))
        .collect();
    let mut label = if parts.is_empty() {
        "selección no detallada".into()
    } else {
        parts.join(" · ")
    };
    if value["external"] == true {
        label.push_str(" · coordinador externo");
    }
    label
}

fn render_revision(attempt: &Value) -> String {
    let revision = &attempt["revision"];
    let base = evidence_line(&revision["base_commit"], value_text);
    let head = evidence_line(&revision["head_commit"], value_text);
    let source = revision["source"]
        .as_str()
        .map(|s| format!(" · fuente {}", clean(s)))
        .unwrap_or_default();
    format!("base: {base} → HEAD: {head}{source}")
}

fn render_changes(attempt: &Value) -> String {
    let changes = &attempt["changes"];
    let count = evidence_line(&changes["files"], |v| format!("{} archivos", value_text(v)));
    let sums_known = changes["additions"]["provenance"] != "unknown"
        && changes["deletions"]["provenance"] != "unknown";
    let mut out = if sums_known {
        format!(
            "{count}; +{} −{}",
            value_text(&changes["additions"]["value"]),
            value_text(&changes["deletions"]["value"])
        )
    } else {
        count
    };
    if changes["truncated"] == true {
        out.push_str(&format!(
            "; lista recortada a {} de {}",
            changes["list"].as_array().map_or(0, Vec::len),
            value_text(&changes["total_files"])
        ));
    }
    out
}

fn render_artifacts(attempt: &Value) -> Vec<String> {
    let artifacts = &attempt["artifacts"];
    if artifacts["provenance"] == "unknown" {
        return vec![marker(artifacts)];
    }
    let Some(items) = artifacts["items"].as_array() else {
        return vec!["? Artefactos con forma desconocida".into()];
    };
    if items.is_empty() {
        return vec![format!(
            "{} · el agente no declaró artefactos",
            marker(artifacts)
        )];
    }
    items
        .iter()
        .map(|item| {
            format!(
                "{} · {}: {}",
                marker(artifacts),
                clean(item["kind"].as_str().unwrap_or("artefacto")),
                value_text(&item["uri"])
            )
        })
        .collect()
}

fn compare_text(data: &Value) -> String {
    let relation = data["relation"]["kind"].as_str().unwrap_or("?");
    let root = clean(data["relation"]["root"].as_str().unwrap_or("?"));
    let rows = data["attempts"].as_array().cloned().unwrap_or_default();
    let mut lines = vec![
        format!(
            "Comparación · {} · raíz {} · {} Attempts",
            clean(relation),
            root,
            rows.len()
        ),
        "Sin puntuación ni ganador automático; Review e integración son decisiones aparte.".into(),
    ];
    for attempt in &rows {
        let id = clean(attempt["attempt_id"].as_str().unwrap_or("?"));
        let n = attempt["n"]
            .as_u64()
            .map(|n| format!("#{n}"))
            .unwrap_or_else(|| "#?".into());
        let mut title = format!("{id} ({n})");
        if attempt["is_current"] == true {
            title.push_str(" · actual");
        }
        if let Some(parent) = attempt["forked_from"].as_str() {
            title.push_str(&format!(" · bifurcado de {}", clean(parent)));
        }
        lines.push(title);
        lines.push(format!(
            "  Proveedor/modelo: {}",
            evidence_line(&attempt["selection"], render_selection)
        ));
        lines.push(format!(
            "  Estado: {}",
            evidence_line(&attempt["status"], |v| {
                let status = status_label(v["status"].as_str().unwrap_or("?"));
                match v["failure_reason"].as_str() {
                    Some(reason) => format!("{status} · fallo {}", clean(reason)),
                    None => status,
                }
            })
        ));
        lines.push(format!(
            "  Duración: {}",
            evidence_line(&attempt["timing"], duration)
        ));
        lines.push(format!("  Revisión: {}", render_revision(attempt)));
        lines.push(format!("  Cambios: {}", render_changes(attempt)));
        lines.push(format!(
            "  Pruebas: {}",
            evidence_line(&attempt["tests"], value_text)
        ));
        lines.push(format!(
            "  Review: {}",
            evidence_line(&attempt["review"], |v| {
                format!(
                    "{} · {}",
                    clean(v["verdict"].as_str().unwrap_or("?")),
                    clean(v["status"].as_str().unwrap_or("?"))
                )
            })
        ));
        lines.push(format!(
            "  Resumen: {}",
            evidence_line(&attempt["summary"], value_text)
        ));
        let mut artifacts = render_artifacts(attempt);
        if let Some(first) = artifacts.first_mut() {
            lines.push(format!("  Artefactos: {first}"));
            for extra in artifacts.iter().skip(1) {
                lines.push(format!("              {extra}"));
            }
        }
        lines.push(format!("  Review: lxo review {id}"));
        lines.push(format!("  Desktop: Attempt ID {id}"));
    }
    let overlaps = &data["overlaps"];
    lines.push(format!(
        "Solapes: {} {}",
        value_text(&overlaps["total"]),
        if overlaps["complete"] == true {
            "(lista completa)"
        } else {
            "(puede haber más)"
        }
    ));
    for item in overlaps["items"].as_array().into_iter().flatten() {
        let ids = item["attempt_ids"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(clean)
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!(
            "  {} · {}",
            clean(item["path"].as_str().unwrap_or("?")),
            ids
        ));
    }
    lines.join("\n")
}

fn execute(request: Request, json_output: bool) -> Result<(), Failure> {
    match request {
        Request::Help => print!("{HELP}"),
        Request::Compare {
            task_id,
            attempt_ids,
            filters,
        } => {
            let mut rpc = |cmd: &str, args: &Value| client_auth::rpc(cmd, args, &crate::cwd());
            let data = compare_data(&mut rpc, &task_id, &attempt_ids, &filters)?;
            if json_output {
                println!("{data}");
            } else {
                println!("{}", compare_text(&data));
            }
        }
    }
    Ok(())
}

pub(super) fn run(a: &Args) -> ExitCode {
    let json_output = a.b("json");
    finish(
        parse(a).and_then(|request| execute(request, json_output)),
        json_output,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|s| s.to_string()).collect())
    }

    fn evidence(value: Value, provenance: &str) -> Value {
        if provenance == "unknown" {
            json!({ "value": null, "provenance": provenance, "reason": "not_collected" })
        } else {
            json!({ "value": value, "provenance": provenance })
        }
    }

    fn attempt(id: &str, task_id: &str, n: u64, provider: &str) -> Value {
        json!({
            "attempt_id": id, "task_id": task_id, "n": n, "project_id": "p1",
            "is_current": n == 2, "forked_from": null,
            "selection": evidence(json!({"provider": provider, "model": "m1", "effort": null, "role": null, "profile": null, "external": false}), "verified"),
            "status": evidence(json!({"status": if n == 1 { "failed" } else { "done" }, "failure_reason": null}), "verified"),
            "timing": evidence(json!({"created_at": 1000, "started_at": 2000, "ended_at": 3500, "duration_ms": 1500}), "verified"),
            "host": evidence(json!("machine-1"), "verified"),
            "worktree": evidence(json!({"id": format!("wt-{n}"), "branch": "feature", "base_branch": "main", "state": "active"}), "verified"),
            "revision": {
                "source": "live_branch",
                "base_commit": evidence(json!("base-sha"), "verified"),
                "head_commit": evidence(json!(format!("head-{n}")), "verified")
            },
            "changes": {
                "files": evidence(json!(1), "verified"),
                "additions": evidence(json!(2), "verified"),
                "deletions": evidence(json!(0), "verified"),
                "list": [{"path": "src/a.rs", "additions": 2, "deletions": 0}],
                "total_files": 1, "truncated": false
            },
            "summary": evidence(json!("resultado declarado"), "agent_reported"),
            "artifacts": {
                "provenance": "agent_reported",
                "items": [{"id": format!("art-{n}"), "kind": "report", "uri": "report.md", "sha256": null, "bytes": null}]
            },
            "tests": evidence(Value::Null, "unknown"),
            "review": evidence(json!({"verdict": "accepted", "status": "active", "head_commit": "head", "base_commit": "base", "at": 1, "closed_at": null, "observed_head": null}), "verified")
        })
    }

    fn compare_response(ids: &[String]) -> Value {
        let attempts = ids
            .iter()
            .enumerate()
            .map(|(index, id)| {
                attempt(
                    id,
                    "t3",
                    index as u64 + 1,
                    if index == 0 { "claude" } else { "codex" },
                )
            })
            .collect::<Vec<_>>();
        json!({
            "v": 1,
            "relation": {"kind": "same_task", "root": "t3"},
            "attempts": attempts,
            "overlaps": {"complete": true, "total": 1, "items": [{"path": "src/a.rs", "attempt_ids": ids}]},
            "limits": {"max_attempts": 4, "max_files_per_attempt": 200, "max_overlaps": 100}
        })
    }

    fn list_row(id: &str, n: u64, status: &str, provider: &str) -> Value {
        json!({"id": id, "n": n, "status": status, "provider": provider})
    }

    fn explicit_core(
        expected: Vec<String>,
        calls: Rc<RefCell<Vec<(String, Value)>>>,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        move |cmd, args| {
            calls.borrow_mut().push((cmd.to_string(), args.clone()));
            match cmd {
                "attempt_detail" => {
                    let id = args["attempt_id"].as_str().unwrap();
                    let n = id.rsplit_once("-a").unwrap().1.parse::<u64>().unwrap();
                    Ok(json!({
                        "v": 1, "core_model": MODEL,
                        "attempt": {"id": id, "task_id": "t3", "n": n, "status": "done", "provider": if n == 1 { "claude" } else { "codex" }}
                    }))
                }
                "attempt_compare" => {
                    assert_eq!(args, &json!({"attempt_ids": expected}));
                    Ok(compare_response(&expected))
                }
                other => panic!("comando inesperado {other}"),
            }
        }
    }

    #[test]
    fn parsea_seleccion_explicit_filters_y_limites() {
        assert_eq!(
            parse(&args(&[
                "compare", "--task", "t3", "t3-a1", "t3-a2", "--status", "done"
            ])),
            Ok(Request::Compare {
                task_id: "t3".into(),
                attempt_ids: vec!["t3-a1".into(), "t3-a2".into()],
                filters: Filters {
                    status: Some("done".into()),
                    provider: None
                }
            })
        );
        for (raw, wanted) in [
            (&["compare"][..], "Falta la tarea"),
            (&["compare", "--task", "t3", "t3-a1"][..], "de 2 a 4"),
            (
                &["compare", "--task", "t3", "t3-a1", "t3-a1"][..],
                "repetido",
            ),
            (
                &["compare", "--task", "t3", "a1", "a2", "a3", "a4", "a5"][..],
                "de 2 a 4",
            ),
            (
                &["compare", "--task", "t3", "--status", "unknown"][..],
                "--status no reconoce",
            ),
            (
                &["compare", "--task", "t3", "--mystery"][..],
                "no es una opción",
            ),
            (&["compare", "--task"][..], "--task requiere un valor"),
            (
                &["compare", "--task", "t3", "--json=si"][..],
                "no admite un valor",
            ),
            (&["compare", "help"][..], "Uso: lxo compare"),
        ] {
            if raw.last() == Some(&"help") {
                assert_eq!(parse(&args(raw)).unwrap(), Request::Help);
                continue;
            }
            match parse(&args(raw)) {
                Err(Failure::Usage(message)) => {
                    assert!(message.contains(wanted), "{raw:?}: {message}")
                }
                other => panic!("{raw:?}: {other:?}"),
            }
        }
        assert!(matches!(
            parse(&args(&["compare", "--task", "t3"])),
            Ok(Request::Compare { attempt_ids, .. }) if attempt_ids.is_empty()
        ));
    }

    #[test]
    fn los_ids_explicitos_se_validan_en_la_task_y_se_pasan_en_el_orden_pedido() {
        let ids = vec!["t3-a2".into(), "t3-a1".into()];
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = explicit_core(ids.clone(), calls.clone());
        let data = compare_data(
            &mut rpc,
            "t3",
            &ids,
            &Filters {
                status: None,
                provider: None,
            },
        )
        .unwrap();
        assert_eq!(
            data["attempts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| a["attempt_id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["t3-a2", "t3-a1"]
        );
        assert_eq!(
            calls
                .borrow()
                .iter()
                .map(|(cmd, _)| cmd.as_str())
                .collect::<Vec<_>>(),
            ["attempt_detail", "attempt_detail", "attempt_compare"]
        );
        assert_eq!(
            calls.borrow()[2].1,
            json!({"attempt_ids": ["t3-a2", "t3-a1"]})
        );
    }

    #[test]
    fn compara_tres_attempts_de_proveedores_distintos_sin_ordenar_por_proveedor() {
        let ids = vec!["t3-a3".into(), "t3-a1".into(), "t3-a2".into()];
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = explicit_core(ids.clone(), calls);
        let data = compare_data(
            &mut rpc,
            "t3",
            &ids,
            &Filters {
                status: None,
                provider: None,
            },
        )
        .unwrap();
        let returned: Vec<&str> = data["attempts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|attempt| attempt["attempt_id"].as_str().unwrap())
            .collect();
        assert_eq!(returned, ["t3-a3", "t3-a1", "t3-a2"]);
        let human = compare_text(&data);
        assert!(human.contains("claude"));
        assert!(human.contains("codex"));
        assert!(!human.contains("ganador:"));
    }

    #[test]
    fn filtro_sin_ids_pagina_el_core_y_no_selecciona_automaticamente_mas_de_cuatro() {
        let ids = vec!["t3-a2".into(), "t3-a3".into()];
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = {
            let calls = calls.clone();
            move |cmd: &str, args: &Value| {
                calls.borrow_mut().push((cmd.to_string(), args.clone()));
                match (cmd, args["cursor"].as_str()) {
                    ("attempts_by_task", None) => Ok(json!({
                        "v": 1, "core_model": MODEL, "task_id": "t3",
                        "items": [list_row("t3-a1", 1, "failed", "claude"), list_row("t3-a2", 2, "done", "codex")],
                        "next_cursor": "a1:2"
                    })),
                    ("attempts_by_task", Some("a1:2")) => Ok(json!({
                        "v": 1, "core_model": MODEL, "task_id": "t3",
                        "items": [list_row("t3-a3", 3, "done", "codex"), list_row("t3-a4", 4, "running", "claude")],
                        "next_cursor": null
                    })),
                    ("attempt_compare", _) => {
                        assert_eq!(args, &json!({"attempt_ids": ids}));
                        Ok(compare_response(&ids))
                    }
                    other => panic!("comando inesperado {other:?}"),
                }
            }
        };
        let data = compare_data(
            &mut rpc,
            "t3",
            &[],
            &Filters {
                status: Some("done".into()),
                provider: Some("CODEX".into()),
            },
        )
        .unwrap();
        assert_eq!(data["attempts"].as_array().unwrap().len(), 2);
        assert_eq!(
            calls
                .borrow()
                .iter()
                .map(|(cmd, _)| cmd.as_str())
                .collect::<Vec<_>>(),
            ["attempts_by_task", "attempts_by_task", "attempt_compare"]
        );

        let mut too_many = |cmd: &str, args: &Value| match cmd {
            "attempts_by_task" => Ok(json!({
                "v": 1, "core_model": MODEL, "task_id": "t3",
                "items": (1..=5).map(|n| list_row(&format!("t3-a{n}"), n, "done", "codex")).collect::<Vec<_>>(),
                "next_cursor": null
            })),
            other => panic!("no debía llamar {other} con {args}"),
        };
        assert!(matches!(
            compare_data(&mut too_many, "t3", &[], &Filters { status: None, provider: None }),
            Err(Failure::Usage(message)) if message.contains("elige de 2 a 4 ids explícitos")
        ));
    }

    #[test]
    fn la_seleccion_explicita_no_se_corrige_silenciosamente_con_filtros() {
        let ids = vec!["t3-a1".into(), "t3-a2".into()];
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = explicit_core(ids.clone(), calls.clone());
        assert!(matches!(
            compare_data(&mut rpc, "t3", &ids, &Filters { status: Some("failed".into()), provider: None }),
            Err(Failure::Usage(message)) if message.contains("no cumple los filtros")
        ));
        assert_eq!(
            calls
                .borrow()
                .iter()
                .map(|(cmd, _)| cmd.as_str())
                .collect::<Vec<_>>(),
            ["attempt_detail"]
        );
    }

    #[test]
    fn no_mezcla_tasks_aunque_el_core_tenga_relaciones_de_fork() {
        let ids = vec!["t3-a1".into(), "t4-a1".into()];
        let mut rpc = |cmd: &str, args: &Value| match cmd {
            "attempt_detail" => {
                let id = args["attempt_id"].as_str().unwrap();
                Ok(json!({
                    "v": 1, "core_model": MODEL,
                    "attempt": {"id": id, "task_id": if id.starts_with("t3") { "t3" } else { "t4" }, "n": 1, "status": "done", "provider": "codex"}
                }))
            }
            other => panic!("no debe llegar a {other}"),
        };
        assert!(matches!(
            compare_data(&mut rpc, "t3", &ids, &Filters { status: None, provider: None }),
            Err(Failure::Usage(message)) if message.contains("no pertenece a la tarea")
        ));
    }

    #[test]
    fn errores_del_core_se_clasifican_sin_cambiar_la_autorizacion() {
        for (message, expected) in [
            (
                "model_auth_required: solo una Person",
                ("authentication", 3),
            ),
            (
                "model_unavailable: almacén cerrado",
                ("core_unavailable", 5),
            ),
            ("Comando desconocido: attempt_compare", ("version", 4)),
            (
                "compare_not_comparable: Attempts de Projects distintos",
                ("usage", 2),
            ),
            ("model_not_found: no existe el Attempt", ("not_found", 6)),
        ] {
            let error = compare_failure(RpcFailure::Rejected(message.into()));
            assert_eq!(error.code(), expected, "{message}: {error:?}");
        }
    }

    #[test]
    fn valida_provenance_orden_y_respuesta_completa_del_core() {
        let ids = vec!["t3-a1".into(), "t3-a2".into()];
        let good = check_compare(compare_response(&ids), &ids, "t3").unwrap();
        assert_eq!(good["v"], 1);
        assert_eq!(good["limits"]["max_files_per_attempt"], 200);

        let mut bad_order = compare_response(&ids);
        bad_order["attempts"].as_array_mut().unwrap().reverse();
        assert!(matches!(
            check_compare(bad_order, &ids, "t3"),
            Err(Failure::Version(_))
        ));
        let mut bad_evidence = compare_response(&ids);
        bad_evidence["attempts"][0]["summary"]["provenance"] = json!("verified");
        bad_evidence["attempts"][0]["summary"]["reason"] = json!("agent_reported");
        assert!(matches!(
            check_compare(bad_evidence, &ids, "t3"),
            Err(Failure::Version(_))
        ));
        let mut bad_unknown = compare_response(&ids);
        bad_unknown["attempts"][0]["tests"]["value"] = json!(0);
        assert!(matches!(
            check_compare(bad_unknown, &ids, "t3"),
            Err(Failure::Version(_))
        ));
        let mut mixed_task = compare_response(&ids);
        mixed_task["attempts"][1]["task_id"] = json!("fork-task");
        assert!(matches!(
            check_compare(mixed_task, &ids, "t3"),
            Err(Failure::Version(_))
        ));
    }

    #[test]
    fn salida_vertical_muestra_provenance_sin_inventar_pruebas_y_enlaza_review() {
        let ids = vec!["t3-a1".into(), "t3-a2".into()];
        let human = compare_text(&compare_response(&ids));
        for expected in [
            "Comparación · same_task · raíz t3 · 2 Attempts",
            "Proveedor/modelo: ✓ Verificado · claude · m1",
            "Pruebas: ? Sin dato (not_collected)",
            "Resumen: ⚠ Declarado por el agente · resultado declarado",
            "Review: lxo review t3-a1",
            "Desktop: Attempt ID t3-a1",
            "Solapes: 1 (lista completa)",
        ] {
            assert!(human.contains(expected), "{expected}\n{human}");
        }
        assert!(!human.contains("Pruebas: 0"), "{human}");
        assert!(!human.contains("ganador:"), "{human}");
    }

    #[test]
    fn snapshot_json_conserva_la_respuesta_v1_completa_del_core() {
        let ids = vec!["t3-a1".into(), "t3-a2".into()];
        let response = compare_response(&ids);
        crate::snapshot("compare.v1.json", &response);
    }

    #[test]
    fn ayuda_documenta_comando_procedencia_y_limites() {
        for text in [
            "lxo compare --task",
            "agent_reported",
            "unknown",
            "no puntúa",
            "2 a 4",
        ] {
            assert!(HELP.to_lowercase().contains(&text.to_lowercase()), "{text}");
        }
    }
}
