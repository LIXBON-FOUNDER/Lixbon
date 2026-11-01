//! Huella canónica del payload de `task.create` (LXO-141).
//!
//! El ledger `task_create_requests` (migración 017) compara esta huella para distinguir un replay
//! legítimo de la reutilización de un `request_id` con otro payload. La escritura idempotente vive en
//! `runtime::runtime_commit_idempotent_recorded`: es la única vía por la que producción crea la Task.
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    attempts::NewAttempt,
    error::{StoreError, StoreResult},
};

pub(crate) fn task_create_payload_sha256(
    project_id: &str,
    objective: &str,
    title: &str,
    spec: &str,
    repo: &str,
    attempt: &Option<NewAttempt>,
) -> StoreResult<String> {
    #[derive(Serialize)]
    struct AttemptSelection<'a> {
        provider: &'a str,
        model: &'a Option<String>,
        effort: &'a Option<String>,
        role: &'a Option<String>,
        profile: &'a Option<String>,
    }
    #[derive(Serialize)]
    struct Canon<'a> {
        project_id: &'a str,
        objective: &'a str,
        title: &'a str,
        spec: &'a str,
        repo: &'a str,
        attempt: Option<AttemptSelection<'a>>,
    }
    // Solo forman parte del request los valores elegidos por el cliente. `external` deriva del
    // registro mutable del Core y `requires_approval` es política del servidor.
    let attempt = attempt.as_ref().map(|attempt| AttemptSelection {
        provider: &attempt.provider,
        model: &attempt.model,
        effort: &attempt.effort,
        role: &attempt.role,
        profile: &attempt.profile,
    });
    let bytes = serde_json::to_vec(&Canon {
        project_id,
        objective,
        title,
        spec,
        repo,
        attempt,
    })
    .map_err(|e| StoreError::InvalidDocument(e.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
