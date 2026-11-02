//! Parser and authorization boundary for the `task_create` RPC (LXO-141).
//!
//! Identity scope is derived from an authenticated credential, never from request JSON.
//! Runtime wiring must authenticate first and pass the resulting client here.
//!
//! Esta fase crea solo la intención (Run + Task raíz `not_started`). El primer Attempt (selección de
//! provider, aprobación humana, despacho) llega con el lifecycle de lanzamiento verificado: mientras tanto una
//! solicitud con `attempt` se rechaza de forma explícita en vez de aceptarse a medias.

use serde::Deserialize;

use super::events::{Actor, MutationContext};
use crate::store::NewAttempt;

const REQUEST_ID_MAX: usize = 64;
const OBJECTIVE_MAX: usize = 16_384;
const PROJECT_ID_MAX: usize = 128;

pub(crate) const ATTEMPT_NOT_AVAILABLE: &str =
    "task.create con Attempt requiere el lifecycle de lanzamiento verificado";

#[derive(Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateTaskInput {
    pub request_id: String,
    pub project_id: String,
    pub objective: String,
    pub title: String,
    #[serde(default)]
    pub spec: String,
    #[serde(default)]
    pub repo: String,
    /// Reservado para la fase de lanzamiento: cualquier valor distinto de `null` se rechaza.
    #[serde(default)]
    pub attempt: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CreatePolicy {
    CreateRunWithRoot,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct AuthorizedCreate {
    pub identity_scope: String,
    pub request_id: String,
    pub project_id: String,
    pub objective: String,
    pub title: String,
    pub spec: String,
    pub repo: String,
    pub policy: CreatePolicy,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ValidationError {
    InvalidRequest,
}

impl CreateTaskInput {
    pub(crate) fn authorize_context(self, context: &MutationContext) -> Result<AuthorizedCreate, String> {
        let identity_scope = match (&context.actor, context.client_id.as_deref()) {
            (Actor::PersonId(id), Some(client_id)) if !id.is_empty() && !client_id.is_empty() => format!("user:{id}"),
            _ => return Err("task.create solo está permitido a una Person autenticada".into()),
        };
        if !valid_key(&self.request_id, REQUEST_ID_MAX)
            || !valid_key(&self.project_id, PROJECT_ID_MAX)
            || self.objective.trim().is_empty()
            || self.objective.chars().count() > OBJECTIVE_MAX
            || self.title.trim().is_empty()
            || self.title.chars().count() > 512
            || self.spec.chars().count() > OBJECTIVE_MAX
            || self.repo.chars().count() > 4096
        {
            return Err("Solicitud task.create inválida".into());
        }
        if self.attempt.as_ref().is_some_and(|value| !value.is_null()) {
            return Err(ATTEMPT_NOT_AVAILABLE.into());
        }
        Ok(AuthorizedCreate {
            identity_scope,
            request_id: self.request_id,
            project_id: self.project_id,
            objective: self.objective,
            title: self.title,
            spec: self.spec,
            repo: self.repo,
            policy: CreatePolicy::CreateRunWithRoot,
        })
    }
}

impl AuthorizedCreate {
    /// Hash del payload normalizado y autorizado. No incluye request_id ni identidad: la identidad del ledger es su
    /// propio scope + request_id. El campo `attempt` va siempre vacío en esta fase; se conserva en la forma canónica
    /// para que los hashes ya registrados sigan valiendo cuando llegue el lanzamiento.
    pub(crate) fn payload_sha256(&self) -> Result<String, ValidationError> {
        crate::store::task_create_payload_sha256(
            &self.project_id,
            &self.objective,
            &self.title,
            &self.spec,
            &self.repo,
            &None::<NewAttempt>,
        )
        .map_err(|_| ValidationError::InvalidRequest)
    }
}

fn valid_key(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn person() -> MutationContext {
        MutationContext {
            actor: Actor::PersonId("person-1".into()),
            channel: super::super::events::Channel::Ui,
            client_id: Some("client-1".into()),
        }
    }

    fn input(value: serde_json::Value) -> CreateTaskInput {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn parser_rejects_spoofed_identity_and_unknown_fields() {
        for value in [
            json!({"request_id":"r1","project_id":"p1","objective":"x","title":"t","identity_scope":"user:attacker"}),
            json!({"request_id":"r1","project_id":"p1","objective":"x","title":"t","actor":"person"}),
        ] {
            assert!(serde_json::from_value::<CreateTaskInput>(value).is_err());
        }
    }

    #[test]
    fn request_keys_are_bounded_ascii_tokens() {
        assert!(valid_key("r-1.a_b", REQUEST_ID_MAX));
        assert!(!valid_key("../r", REQUEST_ID_MAX));
        assert!(!valid_key(&"x".repeat(REQUEST_ID_MAX + 1), REQUEST_ID_MAX));
        assert!(!valid_key("é", REQUEST_ID_MAX));
    }

    #[test]
    fn authorization_requires_an_authenticated_person() {
        let value = json!({"request_id":"r1","project_id":"p1","objective":"objective","title":"task"});
        let anonymous = MutationContext { actor: Actor::PersonId("person-1".into()), channel: super::super::events::Channel::Ui, client_id: None };
        assert!(input(value.clone()).authorize_context(&anonymous).is_err());
        assert!(input(value.clone()).authorize_context(&MutationContext::core()).is_err());
        assert!(input(value).authorize_context(&person()).is_ok());
    }

    #[test]
    fn authorization_preserves_the_task_intent_and_derives_the_scope() {
        let authorized = input(json!({
            "request_id": "r1", "project_id": "p1", "objective": "objective",
            "title": "task title", "spec": "task instructions", "repo": "repo-path"
        }))
        .authorize_context(&person())
        .unwrap();
        assert_eq!(authorized.identity_scope, "user:person-1");
        assert_eq!(authorized.title, "task title");
        assert_eq!(authorized.spec, "task instructions");
        assert_eq!(authorized.repo, "repo-path");
    }

    #[test]
    fn invalid_fields_are_rejected_without_echoing_them() {
        for value in [
            json!({"request_id":"","project_id":"p1","objective":"x","title":"t"}),
            json!({"request_id":"r1","project_id":"p 1","objective":"x","title":"t"}),
            json!({"request_id":"r1","project_id":"p1","objective":"   ","title":"t"}),
            json!({"request_id":"r1","project_id":"p1","objective":"x","title":"  "}),
        ] {
            assert_eq!(input(value).authorize_context(&person()).unwrap_err(), "Solicitud task.create inválida");
        }
    }

    #[test]
    fn a_requested_attempt_is_rejected_explicitly_and_null_means_intent_only() {
        let with_attempt = input(json!({
            "request_id": "r1", "project_id": "p1", "objective": "x", "title": "t",
            "attempt": { "provider": "codex" }
        }));
        assert_eq!(with_attempt.authorize_context(&person()).unwrap_err(), ATTEMPT_NOT_AVAILABLE);
        let null_attempt = input(json!({"request_id":"r1","project_id":"p1","objective":"x","title":"t","attempt":null}));
        assert!(null_attempt.authorize_context(&person()).is_ok());
    }

    #[test]
    fn payload_hash_uses_the_store_canonical_form_and_lowercase_hex() {
        let authorized = AuthorizedCreate {
            identity_scope: "user:u1".into(),
            request_id: "req-1".into(),
            project_id: "p1".into(),
            objective: "objective".into(),
            title: "title".into(),
            spec: "spec".into(),
            repo: "repo".into(),
            policy: CreatePolicy::CreateRunWithRoot,
        };
        let actual = authorized.payload_sha256().unwrap();
        let canonical = crate::store::task_create_payload_sha256("p1", "objective", "title", "spec", "repo", &None).unwrap();
        assert_eq!(actual, canonical);
        assert_eq!(actual.len(), 64);
        assert!(actual.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }
}
