//! Lecturas compartidas por los comandos F5 de lxo. La policy y la validación final siguen
//! siendo del Core; estas lecturas solo preparan una vista y evitan enviar paquetes inválidos.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::client_auth::{self, RpcFailure};
use crate::projects::{self, Failure};

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
        if message.starts_with("context_preview_auth_required")
            || message.starts_with("context_store_auth_required")
            || message.starts_with("race_auth_required")
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
        if message.starts_with("context_package_")
            || message.starts_with("race_invalid_request")
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

pub(super) fn dry_run_facts(
    rpc: &mut Rpc<'_>,
    source: &SourceFacts,
) -> Result<(Value, Value), Failure> {
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
    let resource = json!({
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
    });
    let policy = request(
        rpc,
        "policy_effective",
        json!({ "attempt_id": source.attempt_id }),
    )?;
    let category = policy["categories"]
        .as_array()
        .and_then(|categories| {
            categories
                .iter()
                .find(|category| category["category"].as_str() == Some("fork"))
        })
        .cloned()
        .ok_or_else(|| {
            Failure::Version("El Core no devolvió la policy efectiva de fork.".into())
        })?;
    Ok((
        resource,
        json!({
            "actor": policy["actor"],
            "revision": policy["revision"],
            "category": category,
        }),
    ))
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
