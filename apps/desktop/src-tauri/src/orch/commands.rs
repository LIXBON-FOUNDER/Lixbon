//! Comandos Tauri del orquestador (IPC de la interfaz).

use std::path::Path;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State as TauriState};
use super::events::Channel;
use super::{Caller, CodexTerms, Orch, Settings, agents, codex_session, codex_term, data_dir, lxo_path, providers, roles, skill, spawn_approval, write_json};

const ADE_READ_QUERIES: &[&str] = &["projects_overview", "tasks_by_project", "task_detail", "attention_list"];

fn is_ade_read_query(query: &str) -> bool {
    ADE_READ_QUERIES.contains(&query)
}

#[tauri::command]
pub fn orch_snapshot(orch: TauriState<'_, Orch>) -> Value {
    orch.0.snapshot()
}

#[tauri::command]
pub fn orch_settings_set(orch: TauriState<'_, Orch>, settings: Settings) -> Result<Value, String> {
    let core = &orch.0;
    let enabled = settings.enabled;
    let was = core.settings().enabled;
    let warnings = roles::validate(&settings.roles)?;
    write_json(&data_dir().join("settings.json"), &settings)?;
    // Activarlo deja la skill en todos los agentes del equipo: nada que configurar a mano.
    if enabled && !was {
        let ids: Vec<String> = skill::detect(&lxo_path().to_string_lossy()).into_iter().filter(|a| a.detected).map(|a| a.id).collect();
        let _ = skill::install(&ids, &lxo_path().to_string_lossy());
    }
    if let Ok(mut s) = core.settings.lock() {
        *s = settings;
    }
    if enabled { core.start_server()? } else { core.stop_server() }
    core.emit_changed();
    Ok(roles::save_response(&warnings, core.snapshot()))
}

#[tauri::command(async)]
pub fn orch_call(orch: TauriState<'_, Orch>, cmd: String, args: Value) -> Result<Value, String> {
    orch.0.rpc_via(Channel::Ui, Caller::User, "", &cmd, &args)
}

/// RPC dedicado del ADE. La allowlist evita exponer operaciones de escritura a esta superficie F2.
#[tauri::command(async)]
pub fn orch_query(orch: TauriState<'_, Orch>, query: String, args: Value) -> Result<Value, String> {
    if !is_ade_read_query(&query) {
        return Err(format!("orch_query_forbidden: `{query}` no es una query read-only del ADE"));
    }
    orch.0.rpc_via(Channel::Ui, Caller::User, "", &query, &args)
}

/// Proyectos registrados (slice D), con sus ubicaciones. `include_archived`: también los archivados.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_projects(orch: TauriState<'_, Orch>, include_archived: Option<bool>) -> Result<Value, String> {
    orch.0.rpc_via(Channel::Ui, Caller::User, "", "projects", &json!({ "all": include_archived.unwrap_or(false) }))
}

/// Registra el repositorio de `path` como proyecto. Si se parece a uno ya registrado en otra ruta
/// devuelve `needs_confirmation`; se resuelve repitiendo con `join` (mismo proyecto) o `new`.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_project_add(orch: TauriState<'_, Orch>, path: String, name: Option<String>, join: Option<String>, new: Option<bool>) -> Result<Value, String> {
    orch.0.rpc_via(Channel::Ui, Caller::User, "", "project_add", &json!({ "path": path, "name": name, "join": join, "new": new }))
}

/// Archiva (oculta, sin borrar) o restaura un proyecto.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_project_archive(orch: TauriState<'_, Orch>, project_id: String, archived: Option<bool>) -> Result<Value, String> {
    orch.0.rpc_via(Channel::Ui, Caller::User, "", "project_archive", &json!({ "project_id": project_id, "archived": archived.unwrap_or(true) }))
}

/// Dice dónde está ahora un proyecto (mismo id, otra ruta).
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_project_locate(orch: TauriState<'_, Orch>, project_id: String, path: String, confirm: Option<bool>) -> Result<Value, String> {
    orch.0.rpc_via(Channel::Ui, Caller::User, "", "project_locate", &json!({ "project_id": project_id, "path": path, "confirm": confirm.unwrap_or(false) }))
}

/// Importa una sola vez las carpetas recientes de la interfaz (`lixbon_recents`).
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_projects_import_recents(orch: TauriState<'_, Orch>, paths: Vec<String>) -> Result<Value, String> {
    orch.0.rpc_via(Channel::Ui, Caller::User, "", "projects_import_recents", &json!({ "paths": paths }))
}

#[tauri::command]
pub fn orch_term_buffer(orch: TauriState<'_, Orch>, task: String) -> String {
    orch.0.terms.lock().ok()
        .and_then(|t| t.get(&task).and_then(|t| t.buffer.lock().ok().map(|b| String::from_utf8_lossy(&b).into_owned())))
        .unwrap_or_default()
}

#[tauri::command]
pub fn orch_term_write(orch: TauriState<'_, Orch>, task: String, data: String) -> Result<(), String> {
    let mut terms = orch.0.terms.lock().map_err(|_| "Estado interno corrupto")?;
    terms.get_mut(&task).ok_or("La terminal de esa tarea ya se cerró")?.write(data.as_bytes())
}

#[tauri::command]
pub fn orch_term_resize(orch: TauriState<'_, Orch>, task: String, cols: u16, rows: u16) -> Result<(), String> {
    let terms = orch.0.terms.lock().map_err(|_| "Estado interno corrupto")?;
    terms.get(&task).ok_or("La terminal de esa tarea ya se cerró")?.resize(cols, rows)
}

/// Política efectiva de un perfil para un proveedor, con el rol de la tarea
/// (vacío para consultar solo los flags), en un worktree: argv exacto,
/// versión detectada, advertencias y estado (`ok`, `blocked` o `unverified`).
#[tauri::command(async, rename_all = "snake_case")]
/// `model` (opcional): el modelo que se va a pedir; con Claude en plan y un modelo
/// que no es Sonnet, añade el aviso WARN_PLAN_SONNET.
pub fn orch_resolve_policy(provider: String, profile: String, role: String, worktree: String, model: Option<String>) -> agents::Policy {
    let mut p = agents::resolve_policy(&provider, &profile, &role, &worktree);
    agents::warn_plan_model(&mut p, model.as_deref());
    if let Some(m) = model.as_deref() {
        agents::mark_model(&mut p, Some(m), providers::model_verified(&provider, m));
    }
    agents::set_model(&mut p, model.as_deref());
    p
}

/// Pestaña de terminal de Codex (orch/codex_term.rs): política sin lanzar nada.
pub fn codex_term_policy(cwd: &str, model: Option<&str>, effort: Option<&str>, resume: Option<&str>) -> Result<Value, String> {
    serde_json::to_value(resolve_codex_term(cwd, model, effort, resume)?).map_err(|e| e.to_string())
}

fn resolve_codex_term(cwd: &str, model: Option<&str>, effort: Option<&str>, resume: Option<&str>) -> Result<codex_term::TermPolicy, String> {
    let policy = codex_term::resolve(cwd, model, effort)?;
    match resume.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => codex_term::with_resume(policy, id),
        None => Ok(policy),
    }
}

/// Sesiones guardadas de Codex para el historial de la interfaz (solo lectura de `~/.codex/sessions`).
pub fn codex_sessions(cwd: Option<&str>, limit: usize) -> Vec<codex_session::SessionInfo> {
    agents::codex_home().map(|h| codex_session::list(&h.join("sessions"), cwd, limit.clamp(1, 200))).unwrap_or_default()
}

/// Abre la pestaña de Codex. `root`: carpeta de trabajo abierta en Lixbon.
#[allow(clippy::too_many_arguments)]
pub fn codex_term_open(app: &AppHandle, terms: &CodexTerms, root: Option<&Path>, cwd: &str, model: Option<&str>, effort: Option<&str>,
    cols: Option<u16>, rows: Option<u16>, acknowledged: bool, resume: Option<&str>) -> Result<Value, String> {
    let app = app.clone();
    let emit = move |name: &str, payload: Value| { let _ = app.emit(name, payload); };
    let o = codex_term::open(terms, root, cwd, model, effort, cols, rows, acknowledged, |c| resolve_codex_term(c, model, effort, resume), emit)?;
    serde_json::to_value(o).map_err(|e| e.to_string())
}

/// Proveedores para los roles del equipo: versión, disponibilidad, modelos (con
/// `verified`) y esfuerzos que admite cada CLI. Solo la interfaz: no está en
/// `orch_call` ni en el servidor HTTP de `lxo`.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_list_providers(refresh: Option<bool>) -> Vec<providers::Provider> {
    providers::list(refresh.unwrap_or(false))
}

/// Integra la rama de una tarea en su padre. Solo la interfaz (la persona) llega
/// aquí: no está en `orch_call` ni en el servidor HTTP de `lxo`. `confirm` debe
/// ser `true` (diálogo de confirmación de la UI).
// snake_case: la webview envía los nombres tal cual (accept_moved_target), sin camelCase.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_integrate(orch: TauriState<'_, Orch>, task: String, confirm: bool, squash: Option<bool>, accept_moved_target: Option<String>) -> Result<Value, String> {
    orch.0.integrate_from_ui(&task, confirm, squash.unwrap_or(false), accept_moved_target.as_deref())
}

/// Publica la rama de una tarea (push + `gh pr create`). Solo la interfaz: no
/// está en `orch_call` ni en el servidor HTTP de `lxo`. `confirm` debe ser `true`.
// snake_case: la webview envía los nombres tal cual (accept_moved_target), sin camelCase.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_publish_pr(orch: TauriState<'_, Orch>, task: String, confirm: bool) -> Result<Value, String> {
    orch.0.publish_pr_from_ui(&task, confirm)
}

/// Lanzamientos que esperan a la persona (para recuperar la vista si se recarga).
/// Solo la interfaz: no está en `orch_call` ni en el servidor HTTP de `lxo`.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_list_pending_spawns(orch: TauriState<'_, Orch>) -> Vec<spawn_approval::PendingSpawn> {
    orch.0.list_pending_spawns()
}

/// La persona aprueba un lanzamiento. `argv` es el que vio: solo se compara con el
/// que vuelve a resolver el host, que es el que se lanza. Solo la interfaz.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_approve_spawn(orch: TauriState<'_, Orch>, pending_id: String, confirm: bool, argv: Vec<String>, ack_unverified: Option<bool>) -> Result<Value, String> {
    orch.0.approve_spawn(&pending_id, confirm, &argv, ack_unverified.unwrap_or(false))
}

/// La persona rechaza un lanzamiento. Solo la interfaz.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_reject_spawn(orch: TauriState<'_, Orch>, pending_id: String, confirm: bool, reason: Option<String>) -> Result<Value, String> {
    orch.0.reject_spawn(&pending_id, confirm, reason.as_deref())
}

/// Diff de la rama de una tarea contra su base, por archivo. Solo la interfaz:
/// no está en `orch_call` ni en el servidor HTTP de `lxo`.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_task_diff(orch: TauriState<'_, Orch>, task_id: String) -> Result<Value, String> {
    orch.0.task_diff_from_ui(&task_id)
}

/// La persona acepta o rechaza el diff de una tarea sobre `head_commit`. Solo la interfaz.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_review_task(orch: TauriState<'_, Orch>, task_id: String, decision: String, head_commit: String, comment: Option<String>, confirm: bool) -> Result<Value, String> {
    orch.0.review_from_ui(&task_id, &decision, &head_commit, comment.as_deref(), confirm)
}

/// Registra la decisión de una Person/Desktop de actuar sobre un riesgo de policy. No tiene ruta HTTP/RPC.
#[tauri::command(async, rename_all = "snake_case")]
pub fn orch_attention_act_risk(orch: TauriState<'_, Orch>, attention_id: String) -> Result<Value, String> {
    orch.0.attention_act_risk_from_ui(&attention_id)
}

#[tauri::command]
pub fn orch_agents() -> Vec<skill::Detected> {
    skill::detect(&lxo_path().to_string_lossy())
}

#[tauri::command]
pub fn orch_skill_install(ids: Vec<String>) -> Result<Vec<String>, String> {
    skill::install(&ids, &lxo_path().to_string_lossy())
}

#[tauri::command]
pub fn orch_skill_uninstall(ids: Vec<String>) -> Result<(), String> {
    skill::uninstall(&ids)
}

#[cfg(test)]
mod ade_query_tests {
    use super::is_ade_read_query;

    #[test]
    fn ade_solo_expone_queries_observacionales_de_f2() {
        for query in ["projects_overview", "tasks_by_project", "task_detail", "attention_list"] {
            assert!(is_ade_read_query(query), "{query} debe ser una query F2 permitida");
        }
        for operation in ["project_archive", "run_create", "spawn", "remove_run", "unknown"] {
            assert!(!is_ade_read_query(operation), "{operation} no debe exponerse en el ADE");
        }
        // Escribir o resolver Attention no entra por la superficie F2: solo su lectura activa.
        for operation in ["attention_detail", "attention_resolve", "attention_act_risk", "attention_snooze"] {
            assert!(!is_ade_read_query(operation), "{operation} no debe exponerse en el ADE");
        }
    }
}
