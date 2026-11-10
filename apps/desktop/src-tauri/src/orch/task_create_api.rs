//! Parser and authorization boundary for the `task_create` RPC (LXO-141).
//!
//! Identity scope is derived from an authenticated credential, never from request JSON.
//! Runtime wiring must authenticate first and pass the resulting client here.
//!
//! Sin `attempt` crea solo la intención (Run + Task raíz `not_started`). Con `attempt` pide además el primer Attempt: el
//! cliente aporta solo la SELECCIÓN de ejecución (provider, model, effort, role, profile); la política la fija el servidor:
//! el Attempt nace siempre `pending_approval` (ninguna selección es evidencia para saltarse la decisión humana) y `external`
//! no lo dice el cliente. Que el Core pueda ejecutarlo (lanzador instalado, capability del proveedor) se comprueba en el RPC.

use serde::Deserialize;

use super::agents::Profile;
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
    #[serde(default)]
    pub attempt: Option<CreateAttemptInput>,
}

/// La selección de ejecución del primer Attempt. Host y worktree no se aceptan: son recursos del runtime, no input del RPC.
/// Tampoco `external` ni `requires_approval`: los fija el servidor.
#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateAttemptInput {
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    /// Perfil de permisos del Core (`explorar`, `proponer`, `delegar_con_revision`). Obligatorio: sin él no se puede lanzar.
    pub profile: String,
}

impl CreateAttemptInput {
    fn authorize(self) -> Result<NewAttempt, String> {
        let invalid = || "Solicitud task.create inválida".to_string();
        if !valid_provider(&self.provider) {
            return Err(invalid());
        }
        for optional in [&self.model, &self.effort, &self.role].into_iter().flatten() {
            if !valid_selection_text(optional) {
                return Err(invalid());
            }
        }
        // El perfil se guarda con su id canónico; uno aplazado (Autonomía amplia) no se puede usar.
        let profile = Profile::parse(&self.profile).filter(|p| p.disabled_reason().is_none()).ok_or_else(invalid)?;
        Ok(NewAttempt {
            provider: self.provider,
            model: self.model,
            effort: self.effort,
            role: self.role,
            profile: Some(profile.id().to_string()),
            // Es un proveedor gestionado por un adapter del Core (se comprueba en el preflight del RPC).
            external: false,
            // Ninguna selección exime de la decisión humana del primer Attempt.
            requires_approval: true,
        })
    }
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
    pub attempt: Option<NewAttempt>,
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
        let attempt = self.attempt.map(CreateAttemptInput::authorize).transpose()?;
        Ok(AuthorizedCreate {
            identity_scope,
            request_id: self.request_id,
            project_id: self.project_id,
            objective: self.objective,
            title: self.title,
            spec: self.spec,
            repo: self.repo,
            attempt,
            policy: CreatePolicy::CreateRunWithRoot,
        })
    }
}

impl AuthorizedCreate {
    /// Hash del payload normalizado y autorizado. No incluye request_id ni identidad: la identidad del ledger es su
    /// propio scope + request_id. De `attempt` solo entra la selección que eligió el cliente (la política es del servidor), y
    /// una solicitud sin `attempt` conserva el hash que ya tenía.
    pub(crate) fn payload_sha256(&self) -> Result<String, ValidationError> {
        crate::store::task_create_payload_sha256(
            &self.project_id,
            &self.objective,
            &self.title,
            &self.spec,
            &self.repo,
            &self.attempt,
        )
        .map_err(|_| ValidationError::InvalidRequest)
    }
}

/// Un id de adapter: minúsculas, dígitos y `-`, hasta 64.
fn valid_provider(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Texto de selección (modelo, esfuerzo, rol): no vacío, acotado y sin caracteres de control.
fn valid_selection_text(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 128 && !value.chars().any(char::is_control)
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

    fn with_attempt(attempt: serde_json::Value) -> CreateTaskInput {
        input(json!({"request_id": "r1", "project_id": "p1", "objective": "x", "title": "t", "attempt": attempt}))
    }

    #[test]
    fn la_seleccion_del_attempt_se_autoriza_con_la_politica_del_servidor() {
        let authorized = with_attempt(json!({"provider": "codex", "model": "m", "effort": "high", "role": "worker", "profile": "Explorar"}))
            .authorize_context(&person())
            .unwrap();
        let attempt = authorized.attempt.expect("hay selección");
        assert_eq!((attempt.provider.as_str(), attempt.model.as_deref(), attempt.effort.as_deref(), attempt.role.as_deref()), ("codex", Some("m"), Some("high"), Some("worker")));
        assert_eq!(attempt.profile.as_deref(), Some("explorar"), "el perfil se guarda con su id canónico");
        assert!(attempt.requires_approval, "ninguna selección exime de la decisión humana");
        assert!(!attempt.external, "external no lo dice el cliente");
        let null_attempt = input(json!({"request_id":"r1","project_id":"p1","objective":"x","title":"t","attempt":null}));
        assert!(null_attempt.authorize_context(&person()).unwrap().attempt.is_none(), "null es solo la intención");
    }

    #[test]
    fn una_seleccion_invalida_o_con_campos_de_politica_se_rechaza() {
        // Campos que son política o recursos del runtime: ni siquiera se parsean.
        for extra in ["external", "requires_approval", "host", "worktree", "approved", "deadline"] {
            let mut attempt = json!({"provider": "codex", "profile": "explorar"});
            attempt[extra] = json!(true);
            let value = json!({"request_id": "r1", "project_id": "p1", "objective": "x", "title": "t", "attempt": attempt});
            assert!(serde_json::from_value::<CreateTaskInput>(value).is_err(), "{extra} no es input del RPC");
        }
        for attempt in [
            json!({"provider": "codex"}),
            json!({"profile": "explorar"}),
            json!({"provider": "", "profile": "explorar"}),
            json!({"provider": "Codex", "profile": "explorar"}),
            json!({"provider": "co dex", "profile": "explorar"}),
            json!({"provider": "x".repeat(65), "profile": "explorar"}),
            json!({"provider": "codex", "profile": "no-existe"}),
            json!({"provider": "codex", "profile": "autonomia_amplia"}),
            json!({"provider": "codex", "profile": "explorar", "model": "  "}),
            json!({"provider": "codex", "profile": "explorar", "effort": "a\nb"}),
            json!({"provider": "codex", "profile": "explorar", "role": "r".repeat(129)}),
        ] {
            let parsed = serde_json::from_value::<CreateTaskInput>(json!({"request_id": "r1", "project_id": "p1", "objective": "x", "title": "t", "attempt": attempt}));
            if let Ok(input) = parsed {
                assert_eq!(input.authorize_context(&person()).unwrap_err(), "Solicitud task.create inválida", "{attempt}");
            }
        }
    }

    #[test]
    fn el_hash_incluye_la_seleccion_pero_no_la_politica() {
        let hash = |attempt: serde_json::Value| with_attempt(attempt).authorize_context(&person()).unwrap().payload_sha256().unwrap();
        let base = hash(json!({"provider": "codex", "profile": "explorar"}));
        assert_eq!(base, hash(json!({"provider": "codex", "profile": "Explorar"})), "el perfil se canoniza antes del hash");
        assert_ne!(base, hash(json!({"provider": "claude", "profile": "explorar"})));
        assert_ne!(base, hash(json!({"provider": "codex", "profile": "proponer"})));
        assert_ne!(base, hash(json!({"provider": "codex", "profile": "explorar", "model": "m"})));
        let intent_only = input(json!({"request_id": "r1", "project_id": "p1", "objective": "x", "title": "t"})).authorize_context(&person()).unwrap();
        assert_ne!(base, intent_only.payload_sha256().unwrap());
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
            attempt: None,
            policy: CreatePolicy::CreateRunWithRoot,
        };
        let actual = authorized.payload_sha256().unwrap();
        let canonical = crate::store::task_create_payload_sha256("p1", "objective", "title", "spec", "repo", &None).unwrap();
        assert_eq!(actual, canonical);
        assert_eq!(actual.len(), 64);
        assert!(actual.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    }
}
