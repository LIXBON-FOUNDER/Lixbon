//! RPC `attempt_fork`: la persona crea un Attempt NUEVO a partir de otro, sin tocarlo (LXO-145, épica F5). Contrato: `docs/core/FORK.md`.
//!
//! Un Fork es una Task nueva con su primer Attempt, que nace `pending_approval` como cualquier primer Attempt (ninguna selección exime
//! de la decisión humana) y lleva `attempt.forked` con su procedencia. Hace el mismo camino que `task_create` con `attempt`: el
//! despachador lo lanza al aprobarse, en su propio Run, rama y worktree. Por eso es paralelo de verdad sin cambiar el modelo de «un solo
//! Attempt activo por Task» (`docs/core/ATTEMPTS.md` D19): lo que corre a la vez son Tasks distintas, no dos ejecuciones de la misma.
//!
//! ```text
//! attempt_fork(source_attempt_id, selección?, package?)
//!   1. Person autenticada · lanzador instalado · request_id y selección válidos
//!   2. el Attempt origen existe y es de una Task con Project; su selección es la que se hereda
//!   3. Project lanzable · proveedor con `start` · ContextPackage (si lo hay) válido y DEL origen   ← todo antes de escribir
//!   4. ¿ya se atendió esta clave?  →  los ids que ya existen (`Replayed`); otra petición con la misma clave →  error
//!   5. UNA mutación: Run + Task + Attempt (`pending_approval`) + `attempt.requested` + `attempt.forked`
//! ```
//!
//! # Lo que NO hace
//! * **No reutiliza la identidad del origen ni lo cambia**: el Attempt nuevo tiene su id y su Task; el origen no recibe ni un evento.
//! * **No comparte worktree.** Cada Fork trabaja en el suyo (lo crea el lanzador al aprobarse); compartirlo exigiría una policy que
//!   todavía no existe (LXO-209), así que el RPC ni siquiera acepta pedirlo (`deny_unknown_fields`).
//! * **No amplía permisos**: el perfil se hereda del origen y el cliente no puede pedir otro.
//! * **No reanuda la sesión del origen**: ningún adapter ofrece `fork` de sesión y una ProviderSession no se comparte entre Attempts. El
//!   contexto viaja como ContextPackage, que la persona vio (`context_package_preview`) y el Core verifica contra el origen.
//! * **No elige ganador, no compara, no integra**: eso es Compare/Race/Integración.

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::attempt_retry_rpc::clean;
use super::context_package::{self, ContextPackage};
use super::events::{Actor, Channel, MutationContext};
use super::mutation::IdempotentMutation;
use super::tx_ops::ForkRequest;
use super::Core;
use crate::store::{ForkStrategy, RetryOverride, RuntimeResultIds};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LineageInput {
    pub attempt_id: String,
}

pub(crate) const FORK_NOT_AVAILABLE: &str = "hacer un Fork requiere el lifecycle de lanzamiento verificado";

const REQUEST_ID_MAX: usize = 64;
const TITLE_MAX: usize = 512;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ForkInput {
    pub request_id: String,
    pub source_attempt_id: String,
    /// Otro proveedor/modelo/esfuerzo/rol que el del origen. Sin valor: se hereda. El modelo y el esfuerzo solo se heredan dentro del
    /// mismo proveedor (son del proveedor).
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// El ContextPackage v1 (JSON, como texto) que la persona revisó. Sin él, el Fork arranca limpio con el encargo de la Task.
    #[serde(default)]
    pub package: Option<String>,
}

/// `<task>-a<n>` canónico: devuelve `(task, n)`.
fn split_attempt(attempt_id: &str) -> Result<(String, u32), String> {
    let invalid = || "Falta un id de Attempt válido".to_string();
    if attempt_id.is_empty() || attempt_id.len() > 256 || attempt_id.chars().any(char::is_control) {
        return Err(invalid());
    }
    let (task, raw_n) = attempt_id.rsplit_once("-a").ok_or_else(invalid)?;
    let n = raw_n.parse::<u32>().ok().filter(|n| *n > 0 && format!("{task}-a{n}") == attempt_id).ok_or_else(invalid)?;
    if task.is_empty() {
        return Err(invalid());
    }
    Ok((task.to_string(), n))
}

fn valid_key(value: &str) -> bool {
    !value.is_empty() && value.len() <= REQUEST_ID_MAX && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// Un id de adapter: minúsculas, dígitos y `-`, hasta 64 (como en `task_create`).
fn valid_provider(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// La identidad del ledger: la de la Person que pide, nunca la que diga el JSON.
fn identity_scope(context: &MutationContext) -> Result<String, String> {
    match (&context.actor, context.client_id.as_deref()) {
        (Actor::PersonId(id), Some(client)) if !id.is_empty() && !client.is_empty() && context.channel != Channel::Core => Ok(format!("user:{id}")),
        _ => Err("hacer un Fork requiere una Person autenticada".into()),
    }
}

/// Hash de lo que la persona ELIGIÓ (no de lo que el Core derivó): reintentar con la misma clave y lo mismo es un replay; con otra
/// cosa, un conflicto. Lleva `kind: fork` para que una clave de `task_create` no se confunda con esta.
fn payload_hash(input: &ForkInput, package_id: Option<&str>) -> String {
    let canon = json!({
        "kind": "attempt.fork",
        "source": input.source_attempt_id,
        "provider": input.provider,
        "model": input.model,
        "effort": input.effort,
        "role": input.role,
        "title": input.title,
        "package_id": package_id,
    });
    Sha256::digest(canon.to_string().as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn result(status: &str, ids: &RuntimeResultIds, source: &str, strategy: Option<ForkStrategy>, package_id: Option<&str>) -> Value {
    json!({
        "status": status,
        "source_attempt_id": source,
        "run_id": ids.run_id,
        "task_id": ids.task_id,
        "attempt_id": ids.attempt_id,
        "strategy": strategy.map(ForkStrategy::as_str),
        "package_id": package_id,
    })
}

/// El ContextPackage, ya parseado y comprobado contra el origen: lo que el paquete dice de dónde sale tiene que ser ESTE Attempt.
fn checked_package(raw: &str, source_task: &str, source_attempt: &str, project_id: &str) -> Result<ContextPackage, String> {
    let package = context_package::parse(raw).map_err(|e| format!("context_package_invalid: {} ({})", e.code.code(), clip(&e.message, 200)))?;
    let s = package.source();
    if s.attempt_id != source_attempt || s.task_id != source_task {
        return Err("context_package_source_mismatch: el paquete no sale del Attempt que se bifurca".into());
    }
    if s.project_id != project_id {
        return Err("context_package_source_mismatch: el paquete es de otro Project".into());
    }
    Ok(package)
}

pub(super) fn fork(core: &Core, context: &MutationContext, input: &ForkInput) -> Result<Value, String> {
    // 1. Quién, con qué y qué pide.
    let scope = identity_scope(context)?;
    if !valid_key(&input.request_id) {
        return Err("Falta una clave de idempotencia válida (request_id)".into());
    }
    let (source_task, source_n) = split_attempt(&input.source_attempt_id)?;
    for provider in input.provider.iter() {
        if !valid_provider(provider) {
            return Err("provider no es válido".into());
        }
    }
    let model = clean("model", &input.model)?;
    let effort = clean("effort", &input.effort)?;
    let role = clean("role", &input.role)?;
    let title = match input.title.as_deref() {
        None => None,
        Some(t) if t.trim().is_empty() || t.chars().count() > TITLE_MAX || t.chars().any(char::is_control) => return Err("title no es válido".into()),
        Some(t) => Some(t.trim().to_string()),
    };
    // Sin lanzador instalado nada ejecutaría el Attempt nuevo: se rechaza antes de tocar nada.
    if core.launcher().is_none() {
        return Err(FORK_NOT_AVAILABLE.into());
    }

    // 2. El origen: su Task (encargo, Project) y su fila durable (la selección que se hereda).
    let (project_id, source_title, source_spec, objective) = {
        let st = core.lock();
        let task = st.tasks.get(&source_task).ok_or_else(|| format!("no existe la Task {source_task}"))?;
        let project = task.project_id.clone().filter(|p| !p.is_empty()).ok_or_else(|| "la Task origen no tiene Project: no hay desde dónde lanzar".to_string())?;
        let objective = st.runs.get(&task.run).map(|r| r.objective.clone()).filter(|o| !o.trim().is_empty()).unwrap_or_else(|| task.title.clone());
        (project, task.title.clone(), task.spec.clone(), objective)
    };
    let source = core.attempt_row_for_resume(&input.source_attempt_id)?.ok_or_else(|| format!("no existe el Attempt {}", input.source_attempt_id))?;
    let profile = source.profile.clone().filter(|p| !p.trim().is_empty()).ok_or_else(|| "el Attempt origen no tiene un perfil de permisos que heredar".to_string())?;

    // 3. Todo lo que depende del estado actual se comprueba ANTES de escribir nada.
    let provider = input.provider.clone().unwrap_or_else(|| source.provider.clone());
    let same_provider = provider == source.provider;
    let repo = core.project_launch_location(&project_id)?.to_string_lossy().into_owned();
    core.provider_start_preflight(&provider)?;
    let package = input.package.as_deref().map(|raw| checked_package(raw, &source_task, &input.source_attempt_id, &project_id)).transpose()?;
    let package_id = package.as_ref().map(|p| p.id().to_string());
    let strategy = if package.is_some() { ForkStrategy::ContextPackage } else { ForkStrategy::Clean };

    // 4. ¿Ya se atendió? Un replay no depende del estado actual ni escribe nada.
    let hash = payload_hash(input, package_id.as_deref());
    if let Some(ids) = core.idempotent_replay(&scope, &input.request_id, &hash).map_err(|e| e.to_string())? {
        return Ok(result("Replayed", &ids, &input.source_attempt_id, Some(strategy), package_id.as_deref()));
    }

    // Lo heredado y lo pedido distinto (pedir lo mismo no es cambiar).
    let inherited_model = if same_provider { source.model.clone() } else { None };
    let inherited_effort = if same_provider { source.effort.clone() } else { None };
    let model = model.or(inherited_model);
    let effort = effort.or(inherited_effort);
    let mut overrides = Vec::new();
    if !same_provider {
        overrides.push(RetryOverride::Provider);
    }
    if input.model.is_some() && model != source.model {
        overrides.push(RetryOverride::Model);
    }
    if input.effort.is_some() && effort != source.effort {
        overrides.push(RetryOverride::Effort);
    }
    let base_spec = if source_spec.trim().is_empty() { source_title.clone() } else { source_spec };
    let spec = match &package {
        Some(p) => format!("{}\n\nENCARGO DE LA TASK ORIGEN:\n{}", p.continuation_prompt(), base_spec),
        None => base_spec,
    };
    let request = ForkRequest {
        source_attempt: input.source_attempt_id.clone(),
        source_task,
        source_n,
        project_id,
        objective,
        title: title.unwrap_or_else(|| format!("Fork de {}", clip(&source_title, 200))),
        spec,
        repo,
        provider,
        model,
        effort,
        role: role.or_else(|| source.role.clone()),
        profile,
        strategy,
        package_id: package_id.clone(),
        overrides,
    };

    // 5. Una sola mutación: la Task, su Attempt y los dos hechos, o nada.
    let outcome = core
        .mutate_idempotent_recorded(&scope, &input.request_id, &hash, |tx| {
            tx.set_context(context.clone());
            let ids = tx.request_attempt_fork(&request)?;
            Ok(((), ids))
        })
        .map_err(|e| e.to_string())?;
    Ok(match outcome {
        IdempotentMutation::Committed { ids, .. } => result("Requested", &ids, &input.source_attempt_id, Some(strategy), package_id.as_deref()),
        IdempotentMutation::Replayed(ids) => result("Replayed", &ids, &input.source_attempt_id, Some(strategy), package_id.as_deref()),
    })
}

/// `attempt_lineage` · `{ attempt_id }`: de dónde salió un Attempt y qué Forks nacieron de él. Solo lectura, solo una Person. Sale del
/// log (`attempt.forked`), así que lo que se ve es lo que se registró al bifurcar, no una deducción; el estado y el proveedor de cada Fork
/// son los de ahora. Un Attempt que no nació de un Fork responde `forked_from: null`.
pub(super) fn lineage(core: &Core, context: &MutationContext, input: &LineageInput) -> Result<Value, String> {
    identity_scope(context).map_err(|_| "ver la procedencia de un Attempt requiere una Person autenticada".to_string())?;
    split_attempt(&input.attempt_id)?;
    core.attempt_row_for_resume(&input.attempt_id)?.ok_or_else(|| format!("no existe el Attempt {}", input.attempt_id))?;
    let rows = core.fork_lineage_rows(&input.attempt_id)?;
    let parse = |raw: &str| serde_json::from_str::<Value>(raw).map_err(|_| "un attempt.forked del log no se puede leer".to_string());
    let forked_from = match rows.origin.as_deref() {
        None => Value::Null,
        Some(raw) => {
            let p = parse(raw)?;
            json!({"attempt_id": p["source"], "task_id": p["source_task"], "n": p["source_n"], "strategy": p["strategy"], "package_id": p.get("package_id").cloned().unwrap_or(Value::Null), "overrides": p.get("overrides").cloned().unwrap_or_else(|| json!([]))})
        }
    };
    let mut forks = Vec::with_capacity(rows.forks.len());
    for f in &rows.forks {
        let p = parse(&f.payload)?;
        forks.push(json!({"attempt_id": f.attempt_id, "task_id": p["task"], "strategy": p["strategy"], "provider": f.provider, "model": f.model, "status": f.status, "created_at": f.at}));
    }
    Ok(json!({"v": 1, "attempt_id": input.attempt_id, "forked_from": forked_from, "forks": forks}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(v: Value) -> Result<ForkInput, serde_json::Error> {
        serde_json::from_value(v)
    }

    #[test]
    fn el_id_del_origen_es_canonico() {
        assert_eq!(split_attempt("t2-a1"), Ok(("t2".into(), 1)));
        assert_eq!(split_attempt("t-2-a12"), Ok(("t-2".into(), 12)));
        for bad in ["", "t2", "t2-a0", "t2-a01", "t2-a", "-a1", "t2-a1\n"] {
            assert!(split_attempt(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn el_cliente_no_puede_pedir_perfil_worktree_ni_host() {
        assert!(parse(json!({"request_id": "r", "source_attempt_id": "t2-a1", "provider": "codex", "model": "m", "package": "{}"})).is_ok());
        for extra in ["profile", "worktree", "shared_worktree", "host", "external", "requires_approval", "approved"] {
            let mut v = json!({"request_id": "r", "source_attempt_id": "t2-a1"});
            v[extra] = json!("x");
            assert!(parse(v).is_err(), "{extra} no se acepta");
        }
        assert!(parse(json!({"request_id": "r"})).is_err(), "falta el origen");
    }

    #[test]
    fn el_hash_distingue_lo_elegido_y_no_lo_derivado() {
        let input = |v: Value| parse(v).unwrap();
        let base = payload_hash(&input(json!({"request_id": "a", "source_attempt_id": "t2-a1"})), None);
        // La clave no entra: es el ledger quien la une al hash.
        assert_eq!(base, payload_hash(&input(json!({"request_id": "b", "source_attempt_id": "t2-a1"})), None));
        assert_ne!(base, payload_hash(&input(json!({"request_id": "a", "source_attempt_id": "t2-a2"})), None));
        assert_ne!(base, payload_hash(&input(json!({"request_id": "a", "source_attempt_id": "t2-a1", "provider": "codex"})), None));
        assert_ne!(base, payload_hash(&input(json!({"request_id": "a", "source_attempt_id": "t2-a1"})), Some("sha256:x")));
        assert_eq!(base.len(), 64);
    }

    #[test]
    fn la_clave_y_el_proveedor_van_acotados() {
        assert!(valid_key("fork-1.a_b"));
        assert!(!valid_key("") && !valid_key("a b") && !valid_key(&"x".repeat(65)));
        assert!(valid_provider("codex") && valid_provider("claude-2"));
        assert!(!valid_provider("Codex") && !valid_provider("co dex") && !valid_provider(""));
    }
}
