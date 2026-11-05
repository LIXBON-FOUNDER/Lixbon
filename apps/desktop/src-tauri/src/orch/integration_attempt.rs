//! Integración de un Attempt revisado (LXO-148, épica F5). Contrato: `docs/core/INTEGRACION.md`.
//!
//! * `attempt_integration_preview { attempt_id }` (lectura): lo que hay que ver ANTES de integrar: la revisión, el destino (rama, si se movió,
//!   si está limpio), si ya se integró, el PR que haya y qué se puede hacer ahora con su motivo.
//! * `attempt_integrate { attempt_id, action, head_commit, confirm, squash?, accept_moved_target? }` (decisión humana): `merge` o `publish_pr`.
//!
//! Es una envoltura de `integration::{integrate, publish_pr}` —que ya separan la decisión del efecto y son idempotentes— con las guardas del
//! Attempt: el actual, terminado, con la revisión ACEPTADA sobre el HEAD exacto que la persona ve (`head_commit`). Nunca integra otro HEAD:
//! si la rama se movió es `head_moved`; si la aceptación no es de este HEAD, `review_required`. Aceptar una revisión no es haber integrado.
//!
//! Los resultados son los del efecto, no una excepción: `merged` · `conflict` · `error` · `target_moved` · `target_branch_mismatch` ·
//! `already_merged` (merge); `created` · `already_exists` · `error` (PR). Un conflicto o un error no pierden historia: la rama sigue intacta.

use serde::Deserialize;
use serde_json::{json, Value};

use super::events::{Actor, MutationContext};
use super::integration::{self, CreatePr};
use super::model_read::{invalid, require_person};
use super::review;
use super::{Caller, Core};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PreviewInput {
    pub attempt_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct IntegrateInput {
    pub attempt_id: String,
    /// `merge` · `publish_pr`.
    pub action: String,
    /// El HEAD que la persona vio y aceptó: el único que se integra.
    pub head_commit: String,
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    pub squash: bool,
    /// El `found_commit` de un `target_moved` que la persona vio y acepta (solo `merge`).
    #[serde(default)]
    pub accept_moved_target: Option<String>,
}

fn split(attempt_id: &str) -> Result<(String, u32), String> {
    let id = attempt_id.trim();
    id.rsplit_once("-a")
        .and_then(|(t, n)| n.parse::<u32>().ok().filter(|n| *n > 0 && !t.is_empty() && format!("{t}-a{n}") == id).map(|n| (t.to_string(), n)))
        .ok_or_else(|| "Falta un id de Attempt válido".to_string())
}

/// Qué ve el Core de la revisión frente al HEAD de ahora: `accepted` (de este HEAD) · `stale` (se aceptó otro) · `rejected` · `none`.
fn review_state(core: &Core, task_id: &str, head: Option<&str>) -> &'static str {
    let st = core.lock();
    if head.is_some_and(|h| review::accepted_for(&st, task_id, h)) {
        return "accepted";
    }
    match review::last_review_decision(&st, task_id) {
        None => "none",
        Some((d, _, _)) if d["decision"] == "rejected" => "rejected",
        Some(_) => "stale",
    }
}

fn ok() -> Value {
    json!({ "ok": true })
}
fn blocked(reason: &str) -> Value {
    json!({ "ok": false, "reason": reason })
}

/// Lo que se puede hacer AHORA y por qué no, para que la interfaz no ofrezca lo que el Core va a rechazar.
fn availability(item: &Value, review: &str, is_current: bool, is_final: bool) -> (Value, Value) {
    let base = if !is_current {
        Some("not_current_attempt")
    } else if !is_final {
        Some("not_final")
    } else if item["branch"].is_null() || item["branch_head"].is_null() {
        Some("no_branch")
    } else if review != "accepted" {
        Some("review_required")
    } else {
        None
    };
    let target = &item["target"];
    let merge = match base {
        Some(r) => blocked(r),
        None if item["merged"] == true => blocked("already_merged"),
        None if target["branch_matches"] == false => blocked("target_branch_mismatch"),
        None if target["head"].is_null() => blocked("target_unavailable"),
        None if target["clean"] == false => blocked("checkout_dirty"),
        None => ok(),
    };
    let pr = match base {
        Some(r) => blocked(r),
        None if !item["pr_url"].is_null() => blocked("already_exists"),
        None if item["has_remote"] == false => blocked("no_remote"),
        None => ok(),
    };
    (merge, pr)
}

/// La URL de un PR tal como sale al cliente: siempre por el saneado del Core (solo http/https, sin credenciales, query ni fragmento). Lo que no
/// lo pasa sale como `null`; que exista un PR se sigue sabiendo por `can_publish_pr` (`already_exists`), no por la URL.
fn safe_pr_url(value: &Value) -> Value {
    value.as_str().and_then(super::pr_url::sanitize_pr_url).map_or(Value::Null, Value::String)
}

/// `attempt_integration_preview`. Solo lectura, solo una Person de Desktop.
pub(super) fn preview(core: &Core, caller: &Caller, context: Option<&MutationContext>, input: &PreviewInput) -> Result<Value, String> {
    require_person(caller, context)?;
    let context = context.ok_or_else(|| "model_auth_required: solo una Person autenticada puede ver la integración".to_string())?;
    let (task_id, n) = split(&input.attempt_id).map_err(invalid)?;
    let (current, status_final) = {
        let st = core.lock();
        let task = st.tasks.get(&task_id).ok_or_else(|| format!("model_not_found: no existe el Attempt {}", input.attempt_id))?;
        (st.attempt_n.get(&task_id).copied(), task.status.is_final())
    };
    if current.is_none_or(|c| c < n) {
        return Err(format!("model_not_found: no existe el Attempt {}", input.attempt_id));
    }
    let is_current = current == Some(n);
    let item = integration::preview(&core.acting(context.clone()), &task_id)?;
    let head = item["branch_head"].as_str().map(String::from);
    let review = review_state(core, &task_id, head.as_deref());
    let (can_merge, can_pr) = availability(&item, review, is_current, status_final);
    Ok(json!({
        "v": 1,
        "attempt_id": input.attempt_id.trim(),
        "task_id": task_id,
        "is_current": is_current,
        "revision": { "head_commit": head },
        "review": { "state": review },
        "merge": { "merged": item["merged"], "result_commit": item["result_commit"] },
        "pr": { "url": safe_pr_url(&item["pr_url"]), "has_remote": item["has_remote"] },
        "target": item["target"],
        "can_merge": can_merge,
        "can_publish_pr": can_pr,
    }))
}

/// `attempt_integrate`. `create` crea el PR (en la app, `gh`; en pruebas, uno simulado).
pub(super) fn integrate_attempt(core: &Core, context: &MutationContext, input: &IntegrateInput, create: CreatePr) -> Result<Value, String> {
    if !context.is_person() || !matches!(context.actor, Actor::PersonId(_)) || context.client_id.as_deref().is_none_or(str::is_empty) {
        return Err("integrar un Attempt requiere una Person autenticada".into());
    }
    if !matches!(input.action.as_str(), "merge" | "publish_pr") {
        return Err("action debe ser merge o publish_pr".into());
    }
    if !input.confirm {
        return Err(if input.action == "merge" { integration::NEED_CONFIRM } else { integration::NEED_CONFIRM_PR }.into());
    }
    let (task_id, n) = split(&input.attempt_id)?;
    let (current, status_final) = {
        let st = core.lock();
        let task = st.tasks.get(&task_id).ok_or_else(|| format!("integration_not_found: no existe la Task {task_id}"))?;
        (st.attempt_n.get(&task_id).copied(), task.status.is_final())
    };
    if current != Some(n) {
        return Err(format!("integration_not_current: solo se integra el Attempt actual de la Task ({task_id}-a{}); la rama es la suya", current.unwrap_or(0)));
    }
    if !status_final {
        return Err("integration_not_final: el Attempt todavía no terminó; integrar un trabajo en marcha sería integrar un HEAD que va a cambiar".into());
    }
    let acting = core.acting(context.clone());
    // 1. La revisión que se integra es la que la persona ve: si la rama se movió, no se integra otra.
    let live = integration::preview(&acting, &task_id)?;
    let Some(head) = live["branch_head"].as_str().map(String::from) else {
        return Err("integration_no_branch: el Attempt no tiene una rama que integrar".into());
    };
    if head != input.head_commit.trim() {
        return Ok(json!({ "task": task_id, "attempt_id": input.attempt_id.trim(), "outcome": "head_moved", "expected_commit": input.head_commit.trim(), "found_commit": head,
            "message": "La rama se movió desde que la viste: no se integró nada. Revisa el HEAD actual." }));
    }
    // 2. Y esa revisión tiene que estar aceptada: aceptar otra no vale.
    if review_state(core, &task_id, Some(&head)) != "accepted" {
        let last = review::last_review(&core.lock(), &task_id);
        return Ok(json!({ "task": task_id, "attempt_id": input.attempt_id.trim(), "outcome": "review_required", "head_commit": head, "last_review": last,
            "message": "Antes de integrar, acepta la revisión de este HEAD exacto." }));
    }
    // 3. El efecto. Merge y PR son decisiones distintas; ninguna limpia el worktree.
    let mut out = if input.action == "merge" {
        integration::integrate(&acting, true, &json!({ "task": task_id, "confirm": true, "squash": input.squash, "accept_moved_target": input.accept_moved_target }))?
    } else {
        integration::publish_pr(&acting, true, &json!({ "task": task_id, "confirm": true }), create)?
    };
    // El Task puede guardar lo que dijo `gh`: al cliente solo llega saneado.
    out["pr_url"] = safe_pr_url(&out["pr_url"]);
    out["attempt_id"] = json!(input.attempt_id.trim());
    Ok(out)
}
