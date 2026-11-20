//! Lecturas compartidas por los comandos F5 de lxo. La policy y la validación final siguen
//! siendo del Core; estas lecturas solo preparan una vista y evitan enviar paquetes inválidos.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::client_auth::{self, RpcFailure};
use crate::projects::{self, Failure};
use crate::Args;

const MAX_CONTEXT_PACKAGE_BYTES: usize = 128 * 1024;

pub(super) type Rpc<'a> = dyn FnMut(&str, &Value) -> Result<Value, RpcFailure> + 'a;

pub(super) struct SourceFacts {
    pub(super) attempt_id: String,
    pub(super) task_id: String,
    pub(super) project_id: String,
    pub(super) attempt: Value,
    pub(super) task: Value,
}

pub(super) struct PreparedPackage {
    pub(super) raw: String,
    pub(super) package_id: String,
    pub(super) revision: Value,
    /// El resumen que el Core calcula para `context_package_preview`: lo que se va a transferir.
    pub(super) summary: Value,
}

pub(super) fn rpc_failure(error: RpcFailure) -> Failure {
    if let RpcFailure::Rejected(message) = &error {
        if message.starts_with("policy_denied") || message.starts_with("policy_forbidden") {
            return Failure::Auth(format!(
                "El Core no autoriza esta operación según la policy: {}",
                safe_detail(message)
            ));
        }
        if message.starts_with("policy_confirm_required") {
            return Failure::Usage(format!(
                "La policy requiere confirmación explícita: vuelve a ejecutar con --confirm. {}",
                safe_detail(message)
            ));
        }
        if message.starts_with("model_not_found")
            || message.starts_with("resource_not_found")
            || message.starts_with("context_store_not_found")
            || message.starts_with("race_not_found")
        {
            return Failure::NotFound(safe_detail(message));
        }
        if message.starts_with("core_model_inactive")
            || message.starts_with("Comando desconocido")
            || message.starts_with("attempt_fork_unavailable")
            || message.starts_with("fork_unavailable")
        {
            return Failure::Version(format!(
                "{} Actualiza Lixbon si este comando debería estar disponible.",
                safe_detail(message)
            ));
        }
        if message.contains("_auth_required")
            || message.contains("solo está permitido a una Person")
            || message.contains("requiere una Person autenticada")
        {
            return Failure::Auth(safe_detail(message));
        }
        if message.starts_with("Acción no permitida para esta identidad") {
            return Failure::Auth(
                "El Core no autoriza esta decisión desde lxo; hazla desde Lixbon Desktop.".into(),
            );
        }
        // Deep links (LXO-168): el Core responde `código: mensaje`.
        if message.starts_with("link_not_found") {
            return Failure::NotFound(safe_detail(message));
        }
        if message.starts_with("link_host_unavailable") {
            return Failure::Unavailable(safe_detail(message));
        }
        if message.starts_with("link_unauthorized") {
            return Failure::Auth(safe_detail(message));
        }
        if message.starts_with("link_malformed")
            || message.starts_with("link_target_mismatch")
            || message.starts_with("link_version_unsupported")
        {
            return Failure::Usage(safe_detail(message));
        }
        // Delegate (LXO-171): el origen ya no es el que se vio, o no se puede resolver.
        if message.starts_with("delegate_source_stale") {
            return Failure::Stale(safe_detail(message));
        }
        if message.starts_with("delegate_source_invalid") {
            // Lleva el código de `lixbon://`: link_not_found, link_host_unavailable, link_target_mismatch…
            return if message.contains("link_not_found") {
                Failure::NotFound(safe_detail(message))
            } else if message.contains("link_host_unavailable") {
                Failure::Unavailable(safe_detail(message))
            } else {
                Failure::Usage(safe_detail(message))
            };
        }
        if message.starts_with("delegate_invalid")
            || message.starts_with("delegate_task_exists")
            || message.starts_with("delegate_source_mismatch")
            || message.starts_with("delegate_source_unknown_revision")
            // Handoff (LXO-172): el Core responde sin código a lo que depende de la petición.
            || message.starts_with("attempt_handoff_conflict")
            || message.starts_with("solo se traspasa")
            || message.starts_with("la instrucción")
            || message.starts_with("provider_unknown")
            || message.starts_with("provider_start_unsupported")
        {
            return Failure::Usage(safe_detail(message));
        }
        if message.starts_with("provider_environment_blocked")
            || message.starts_with("provider_probing")
            || message.starts_with("attempt_handoff_unavailable")
        {
            return Failure::Unavailable(safe_detail(message));
        }
        if message.starts_with("delegate_provenance_failed") {
            return Failure::Internal(safe_detail(message));
        }
        if message.starts_with("context_package_")
            || message.starts_with("race_invalid_request")
            || message.contains("race_source_not_current")
            || message.starts_with("race_candidate_not_found")
            || message.starts_with("request_conflict")
            || message.starts_with("fork_invalid_request")
        {
            return Failure::Usage(safe_detail(message));
        }
        if message.starts_with("resource_inspect_unavailable")
            || message.starts_with("policy_unavailable")
            || message.contains("lifecycle de lanzamiento verificado")
        {
            return Failure::Unavailable(safe_detail(message));
        }
    }
    projects::failure(error)
}

fn safe_detail(message: &str) -> String {
    message.chars().take(300).collect()
}

fn request(rpc: &mut Rpc<'_>, cmd: &str, args: Value) -> Result<Value, Failure> {
    rpc(cmd, &args).map_err(rpc_failure)
}

pub(super) fn source(rpc: &mut Rpc<'_>, attempt_id: &str) -> Result<SourceFacts, Failure> {
    let detail = request(rpc, "attempt_detail", json!({ "attempt_id": attempt_id }))?;
    if detail["v"].as_u64() != Some(1)
        || detail["core_model"].as_str() != Some("task_attempt_v1")
        || detail["attempt"]["id"].as_str() != Some(attempt_id)
    {
        return Err(Failure::Version(
            "El Core devolvió un Attempt con un formato que este lxo no entiende; actualiza Lixbon."
                .into(),
        ));
    }
    let task_id = detail["attempt"]["task_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| Failure::Version("El Attempt no identifica su Task.".into()))?
        .to_string();
    let task_detail = request(rpc, "task_detail_v2", json!({ "task_id": task_id }))?;
    if task_detail["v"].as_u64() != Some(2)
        || task_detail["core_model"].as_str() != Some("task_attempt_v1")
        || task_detail["task"]["id"].as_str() != Some(task_id.as_str())
    {
        return Err(Failure::Version(
            "El Core devolvió una Task con un formato que este lxo no entiende; actualiza Lixbon."
                .into(),
        ));
    }
    let project_id = task_detail["task"]["project_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            Failure::Usage("La Task origen no tiene un Project desde el que lanzar.".into())
        })?
        .to_string();
    Ok(SourceFacts {
        attempt_id: attempt_id.to_string(),
        task_id,
        project_id,
        attempt: detail["attempt"].clone(),
        task: task_detail["task"].clone(),
    })
}

pub(super) fn source_for_task(rpc: &mut Rpc<'_>, task_id: &str) -> Result<SourceFacts, Failure> {
    let detail = request(rpc, "task_detail_v2", json!({ "task_id": task_id }))?;
    if detail["v"].as_u64() != Some(2)
        || detail["core_model"].as_str() != Some("task_attempt_v1")
        || detail["task"]["id"].as_str() != Some(task_id)
    {
        return Err(Failure::Version(
            "El Core devolvió una Task con un formato que este lxo no entiende; actualiza Lixbon."
                .into(),
        ));
    }
    let current_attempt = detail["task"]
        .get("current_attempt")
        .ok_or_else(|| Failure::Version("La Task no incluye current_attempt.".into()))?;
    let attempt_id = match current_attempt {
        Value::Null => {
            return Err(Failure::Usage(format!(
                "La Task «{}» no tiene un Attempt actual desde el que lanzar un Race.",
                task_id
            )))
        }
        Value::Object(attempt) => attempt
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| {
                !id.trim().is_empty()
                    && id.chars().count() <= 200
                    && !id.chars().any(char::is_control)
            })
            .ok_or_else(|| Failure::Version("current_attempt no incluye un id válido.".into()))?,
        _ => {
            return Err(Failure::Version(
                "El Core devolvió current_attempt con un formato no válido.".into(),
            ))
        }
    };
    let attempt_detail = request(rpc, "attempt_detail", json!({ "attempt_id": attempt_id }))?;
    if attempt_detail["v"].as_u64() != Some(1)
        || attempt_detail["core_model"].as_str() != Some("task_attempt_v1")
        || attempt_detail["attempt"]["id"].as_str() != Some(attempt_id)
    {
        return Err(Failure::Version(
            "El Core devolvió un Attempt con un formato que este lxo no entiende; actualiza Lixbon."
                .into(),
        ));
    }
    if attempt_detail["attempt"]["task_id"].as_str() != Some(task_id) {
        return Err(Failure::Version(
            "El Attempt actual devuelto por el Core no pertenece a la Task solicitada.".into(),
        ));
    }
    let project_id = detail["task"]["project_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            Failure::Usage("La Task origen no tiene un Project desde el que lanzar.".into())
        })?
        .to_string();
    Ok(SourceFacts {
        attempt_id: attempt_id.to_string(),
        task_id: task_id.to_string(),
        project_id,
        attempt: attempt_detail["attempt"].clone(),
        task: detail["task"].clone(),
    })
}

pub(super) fn dry_run_facts(
    rpc: &mut Rpc<'_>,
    source: &SourceFacts,
) -> Result<(Value, Value), Failure> {
    let resource = resource_facts(rpc, source)?;
    let policy = policy_for(rpc, json!({ "attempt_id": source.attempt_id }), "fork")?;
    Ok((resource, policy))
}

/// El estado del worktree, el proceso y las acciones de la Task del origen. Solo lectura.
pub(super) fn resource_facts(rpc: &mut Rpc<'_>, source: &SourceFacts) -> Result<Value, Failure> {
    let resource = request(
        rpc,
        "resource_inspect",
        json!({ "task_id": source.task_id }),
    )?;
    if resource["v"].as_u64() != Some(1)
        || resource["task_id"].as_str() != Some(source.task_id.as_str())
    {
        return Err(Failure::Version(
            "El Core devolvió una inspección de recursos con un formato que este lxo no entiende."
                .into(),
        ));
    }
    Ok(json!({
        "v": resource["v"],
        "task_id": resource["task_id"],
        "worktree": {
            "state": resource["worktree"]["state"],
            "dirty": resource["worktree"]["dirty"],
        },
        "branch": resource["branch"],
        "process": resource["process"],
        "health": resource["health"],
        "actions": resource["actions"],
    }))
}

/// La policy efectiva de una categoría para el ámbito dado (`attempt_id` o `project_id`). Solo lectura.
pub(super) fn policy_for(
    rpc: &mut Rpc<'_>,
    scope: Value,
    category: &str,
) -> Result<Value, Failure> {
    let policy = request(rpc, "policy_effective", scope)?;
    let found = policy["categories"]
        .as_array()
        .and_then(|categories| {
            categories
                .iter()
                .find(|entry| entry["category"].as_str() == Some(category))
        })
        .cloned()
        .ok_or_else(|| {
            Failure::Version(format!(
                "El Core no devolvió la policy efectiva de {category}."
            ))
        })?;
    Ok(json!({
        "actor": policy["actor"],
        "revision": policy["revision"],
        "category": found,
    }))
}

/// El enlace `lixbon://` canónico de un Attempt recién creado. Es un dato añadido: si el Core no lo
/// ofrece o falla, la operación ya hecha no se da por mala y el campo queda en `null`.
pub(super) fn attempt_link(
    rpc: &mut Rpc<'_>,
    project_id: &str,
    task_id: &str,
    attempt_id: &str,
) -> Value {
    let args = json!({
        "project_id": project_id,
        "task_id": task_id,
        "attempt_id": attempt_id,
    });
    match rpc("deep_link_generate", &args) {
        Ok(link) if link["status"].as_str() == Some("ready") => link["canonical"]
            .as_str()
            .filter(|url| url.starts_with("lixbon://"))
            .map(|url| json!(url))
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

pub(super) const ATTEMPT_STATUSES: [&str; 9] = [
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

/// Los estados en los que un Attempt ya no cambia por sí solo.
pub(super) const FINAL_STATUSES: [&str; 4] = ["done", "failed", "stopped", "exited"];

/// El Attempt tal como lo cuenta el Core ahora, comprobado contra la Task que se esperaba.
pub(super) fn current_attempt(
    rpc: &mut Rpc<'_>,
    attempt_id: &str,
    task_id: &str,
) -> Result<Value, Failure> {
    let detail = send("attempt_detail", &json!({ "attempt_id": attempt_id }), rpc)?;
    let attempt = &detail["attempt"];
    let status = attempt["status"].as_str().ok_or_else(|| {
        Failure::Version("El Core devolvió un estado de Attempt que lxo no reconoce.".into())
    })?;
    if detail["v"].as_u64() != Some(1)
        || detail["core_model"].as_str() != Some("task_attempt_v1")
        || attempt["id"].as_str() != Some(attempt_id)
        || attempt["task_id"].as_str() != Some(task_id)
        || !ATTEMPT_STATUSES.contains(&status)
    {
        return Err(Failure::Version(
            "El Core devolvió un Attempt con un formato que este lxo no entiende.".into(),
        ));
    }
    Ok(attempt.clone())
}

/// Un nombre de proveedor válido, en minúsculas.
pub(super) fn valid_provider(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// El valor de `--clave`: ausente es `None`; sin valor o vacío es un error de uso.
pub(super) fn value_flag(a: &Args, key: &str) -> Result<Option<String>, Failure> {
    match a.flags.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => {
            Ok(Some(value.trim().to_string()))
        }
        _ => Err(Failure::Usage(format!("--{key} requiere un valor."))),
    }
}

/// `<task>-a<n>` canónico: devuelve la Task.
pub(super) fn task_of_attempt(attempt_id: &str) -> Option<&str> {
    let (task, raw) = attempt_id.rsplit_once("-a")?;
    let n: u32 = raw.parse().ok().filter(|n| *n > 0)?;
    (!task.is_empty() && format!("{task}-a{n}") == attempt_id).then_some(task)
}

/// Las mismas reglas que `lixbon://` para `file`: relativo, sin `..` ni controles ni doble codificación.
pub(super) fn check_relative_file(file: &str) -> Result<(), Failure> {
    let bytes = file.as_bytes();
    let escaped = |segment: &str| {
        segment
            .as_bytes()
            .windows(3)
            .any(|w| w[0] == b'%' && w[1].is_ascii_hexdigit() && w[2].is_ascii_hexdigit())
    };
    if file.chars().count() > 1024
        || file.chars().any(|c| c.is_control() || c == '\\')
        || file.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || file.split('/').any(|segment| {
            segment.is_empty() || segment == "." || segment == ".." || escaped(segment)
        })
    {
        return Err(Failure::Usage(
            "--file debe ser una ruta relativa al Project: sin rutas absolutas, `..`, barras \
             invertidas, controles ni codificación `%XX`."
                .into(),
        ));
    }
    Ok(())
}

/// Modelo, esfuerzo o rol: una línea de texto sin controles.
pub(super) fn selection_text(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 128 && !value.chars().any(char::is_control)
}

pub(super) fn context_package(
    reference: Option<&str>,
    base_dir: Option<&Path>,
    source: &SourceFacts,
    rpc: &mut Rpc<'_>,
) -> Result<Option<PreparedPackage>, Failure> {
    let Some(reference) = reference else {
        return Ok(None);
    };
    let requested_package_id = reference.starts_with("sha256:").then_some(reference);
    let raw = if reference.starts_with("sha256:") {
        let stored = request(
            rpc,
            "context_package_get",
            json!({ "package_id": reference }),
        )?;
        if stored["status"].as_str() != Some("valid") {
            return Err(Failure::NotFound(format!(
                "El Core no encontró el ContextPackage {reference}."
            )));
        }
        let package = stored["package"].as_object().ok_or_else(|| {
            Failure::Version(
                "El Core no devolvió el contenido del ContextPackage solicitado.".into(),
            )
        })?;
        serde_json::to_string(package).map_err(|_| {
            Failure::Version(
                "El Core devolvió el ContextPackage guardado con un formato que este lxo no entiende."
                    .into(),
            )
        })?
    } else {
        let path = if reference == "-" {
            None
        } else {
            let path = PathBuf::from(reference);
            Some(if path.is_absolute() {
                path
            } else if let Some(base) = base_dir {
                base.join(path)
            } else {
                path
            })
        };
        let mut bytes = Vec::new();
        match path {
            Some(path) => {
                let file = std::fs::File::open(&path).map_err(|e| {
                    Failure::Usage(format!(
                        "No se pudo leer el ContextPackage {}: {e}",
                        path.display()
                    ))
                })?;
                let _ = file
                    .take((MAX_CONTEXT_PACKAGE_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|e| {
                        Failure::Usage(format!("No se pudo leer el ContextPackage: {e}"))
                    })?;
            }
            None => {
                let _ = std::io::stdin()
                    .take((MAX_CONTEXT_PACKAGE_BYTES + 1) as u64)
                    .read_to_end(&mut bytes)
                    .map_err(|e| Failure::Usage(format!("No se pudo leer stdin: {e}")))?;
            }
        }
        if bytes.len() > MAX_CONTEXT_PACKAGE_BYTES {
            return Err(Failure::Usage(format!(
                "El ContextPackage supera el límite de {MAX_CONTEXT_PACKAGE_BYTES} bytes."
            )));
        }
        let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
        String::from_utf8(bytes.to_vec())
            .map_err(|_| Failure::Usage("El ContextPackage debe ser un archivo UTF-8.".into()))?
    };
    if raw.len() > MAX_CONTEXT_PACKAGE_BYTES {
        return Err(Failure::Usage(format!(
            "El ContextPackage supera el límite de {MAX_CONTEXT_PACKAGE_BYTES} bytes."
        )));
    }

    let preview = request(rpc, "context_package_preview", json!({ "package": raw }))?;
    if preview["status"].as_str() != Some("valid") {
        let code = preview["error"]["code"]
            .as_str()
            .unwrap_or("invalid_package");
        let message = preview["error"]["message"]
            .as_str()
            .unwrap_or("el Core rechazó el ContextPackage");
        return Err(Failure::Usage(format!(
            "ContextPackage rechazado ({code}): {}",
            safe_detail(message)
        )));
    }
    let package_source = &preview["package"]["source"];
    if package_source["attempt_id"].as_str() != Some(source.attempt_id.as_str())
        || package_source["task_id"].as_str() != Some(source.task_id.as_str())
        || package_source["project_id"].as_str() != Some(source.project_id.as_str())
    {
        return Err(Failure::Usage(
            "El ContextPackage no sale del Attempt y Project de origen.".into(),
        ));
    }
    let package_id = preview["package_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            Failure::Version("El Core validó el ContextPackage sin devolver su identidad.".into())
        })?
        .to_string();
    if requested_package_id.is_some_and(|requested| requested != package_id.as_str()) {
        return Err(Failure::Version(
            "El Core devolvió un ContextPackage distinto del solicitado.".into(),
        ));
    }
    let package_revision = &preview["package"]["revision"];
    let revision = if package_revision.is_object() {
        json!({
            "base_commit": package_revision["base_commit"],
            "head_commit": package_revision["head_commit"],
            "head_tree": package_revision["head_tree"],
            "branch": package_revision["branch"],
        })
    } else {
        Value::Null
    };
    Ok(Some(PreparedPackage {
        raw,
        package_id,
        revision,
        summary: preview["summary"].clone(),
    }))
}

pub(super) fn stable_request_id(prefix: &str, payload: &Value) -> String {
    let digest = Sha256::digest(payload.to_string().as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("lxo-{prefix}-{}", &hex[..40])
}

pub(super) fn source_preview(source: &SourceFacts) -> Value {
    let review = &source.attempt["review"];
    let revision = if review.is_object() {
        json!({
            "source": "review",
            "base_commit": review["base_commit"],
            "head_commit": review["head_commit"],
        })
    } else {
        json!({ "source": "unknown", "reason": "no_review_recorded" })
    };
    let worktree = &source.attempt["worktree"];
    json!({
        "attempt_id": source.attempt_id,
        "task_id": source.task_id,
        "project_id": source.project_id,
        "provider": source.attempt["provider"],
        "model": source.attempt["model"],
        "effort": source.attempt["effort"],
        "role": source.attempt["role"],
        "status": source.attempt["status"],
        "revision": revision,
        "worktree": {
            "branch": worktree["branch"],
            "state": worktree["state"],
            "machine": worktree["machine"],
        },
        "task_state": source.task["state"],
    })
}

pub(super) fn send(cmd: &str, args: &Value, rpc: &mut Rpc<'_>) -> Result<Value, Failure> {
    rpc(cmd, args).map_err(rpc_failure)
}

pub(super) fn live_rpc<'a>() -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> + 'a {
    |cmd, args| client_auth::rpc(cmd, args, &crate::cwd())
}
