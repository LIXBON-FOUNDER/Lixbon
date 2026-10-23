//! Comandos Tauri del orquestador (IPC de la interfaz).

use std::path::Path;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State as TauriState};
use super::events::Channel;
use super::{Caller, CodexTerms, Orch, Settings, agents, codex_session, codex_term, data_dir, lxo_path, providers, roles, skill, spawn_approval, write_json};

/// Superficie F2 del ADE: solo lectura. `resource_inventory` entra porque el inventario de recursos
/// (LXO-93) es una foto de solo lectura: repos, worktrees y ramas conservadas. Ninguna acción de
/// git, de limpieza o de adopción existe en esta superficie.
const ADE_READ_QUERIES: &[&str] = &[
    "projects_overview",
    "tasks_by_project",
    "task_detail",
    "attention_list",
    "activity_list",
    "resource_inventory",
    // Lecturas vNext del modelo Task/Attempt (LXO-119, docs/core/QUERIES.md). Solo lectura; antes
    // del corte el Core responde `core_model_inactive` y el ADE sigue con las lecturas F2.
    "core_model",
    "task_list_v2",
    "task_detail_v2",
    "attempts_by_task",
    "attempt_detail",
];
const MAX_SAFE_ACTIVITY_CURSOR: i64 = 9_007_199_254_740_991;

fn is_ade_read_query(query: &str) -> bool {
    ADE_READ_QUERIES.contains(&query)
}

/// El Core recibe `cursor` como i64, pero la WebView solo puede transportar
/// enteros JS exactos como Number hasta `MAX_SAFE_ACTIVITY_CURSOR`. Los cursores
/// mayores cruzan IPC como decimal y se restauran a i64 antes de llamar al Core.
fn activity_args_for_core(mut args: Value) -> Result<Value, String> {
    let Some(cursor) = args.get("cursor") else { return Ok(args) };
    let parsed = match cursor {
        Value::String(text) => {
            if text.is_empty()
                || text.len() > 19
                || !text.bytes().all(|byte| byte.is_ascii_digit())
                || (text.len() > 1 && text.starts_with('0'))
            {
                return Err("ade_query_invalid_request: cursor Activity debe ser un decimal i64 canónico".into());
            }
            text.parse::<i64>()
                .map_err(|_| "ade_query_invalid_request: cursor Activity está fuera de i64".to_string())?
        }
        Value::Number(number) => {
            let number = number.as_i64()
                .ok_or_else(|| "ade_query_invalid_request: cursor Activity debe ser un entero i64".to_string())?;
            if number > MAX_SAFE_ACTIVITY_CURSOR {
                return Err("ade_query_invalid_request: cursor Activity mayor que MAX_SAFE_INTEGER debe enviarse como decimal".into());
            }
            number
        }
        _ => return Err("ade_query_invalid_request: cursor Activity debe ser un entero i64".into()),
    };
    if parsed < 0 {
        return Err("ade_query_invalid_request: cursor Activity debe ser no negativo".into());
    }
    if let Some(object) = args.as_object_mut() {
        object.insert("cursor".into(), Value::Number(parsed.into()));
    }
    Ok(args)
}

/// Serializa los tres i64 del contrato Activity como decimal en IPC para que
/// JSON/JavaScript no los redondee antes de que `coreQueries` los valide.
fn activity_response_for_webview(mut response: Value) -> Value {
    if let Some(object) = response.as_object_mut() {
        for key in ["next_cursor", "head_seq"] {
            if let Some(value) = object.get_mut(key) {
                stringify_activity_i64(value);
            }
        }
        if let Some(Value::Array(items)) = object.get_mut("items") {
            for item in items {
                if let Some(seq) = item.get_mut("seq") {
                    stringify_activity_i64(seq);
                }
            }
        }
    }
    response
}

fn stringify_activity_i64(value: &mut Value) {
    if let Some(number) = value.as_i64() {
        *value = Value::String(number.to_string());
    }
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
    let args = if query == "activity_list" { activity_args_for_core(args)? } else { args };
    let response = orch.0.rpc_via(Channel::Ui, Caller::User, "", &query, &args)?;
    Ok(if query == "activity_list" { activity_response_for_webview(response) } else { response })
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
    use super::{activity_args_for_core, activity_response_for_webview, is_ade_read_query, MAX_SAFE_ACTIVITY_CURSOR};
    use serde_json::{json, Value};

    #[test]
    fn ade_solo_expone_queries_de_lectura_f2_y_del_modelo_task_attempt() {
        for query in ["projects_overview", "tasks_by_project", "task_detail", "attention_list", "activity_list", "resource_inventory"] {
            assert!(is_ade_read_query(query), "{query} debe ser una query F2 permitida");
        }
        for query in ["core_model", "task_list_v2", "task_detail_v2", "attempts_by_task", "attempt_detail"] {
            assert!(is_ade_read_query(query), "{query} debe ser una lectura vNext permitida");
        }
        // Las mutaciones del Attempt no entran por esta superficie: el ADE F3 solo lee.
        for operation in ["attempt_request", "attempt_start", "attempt_stop", "attempt_retry", "attempt_resume", "task_discard"] {
            assert!(!is_ade_read_query(operation), "{operation} no debe exponerse en el ADE");
        }
        for operation in ["project_archive", "run_create", "spawn", "remove_run", "events", "unknown"] {
            assert!(!is_ade_read_query(operation), "{operation} no debe exponerse en el ADE");
        }
        // Escribir o resolver Attention no entra por la superficie F2: solo su lectura activa.
        for operation in ["attention_detail", "attention_resolve", "attention_act_risk", "attention_snooze"] {
            assert!(!is_ade_read_query(operation), "{operation} no debe exponerse en el ADE");
        }
    }

    #[test]
    fn activity_cursor_decimal_se_convierte_a_i64_sin_perdida() {
        let cursor = "9223372036854775807";
        let args = activity_args_for_core(json!({ "cursor": cursor, "limit": 1 })).unwrap();
        assert_eq!(args["cursor"].as_i64(), Some(i64::MAX));
        assert_eq!(args["limit"], json!(1));

        let safe = activity_args_for_core(json!({ "cursor": 9_007_199_254_740_991_i64 })).unwrap();
        assert_eq!(safe["cursor"].as_i64(), Some(MAX_SAFE_ACTIVITY_CURSOR));
    }

    #[test]
    fn activity_cursor_rechaza_numeros_inseguros_y_decimales_no_canonicos() {
        for args in [
            json!({ "cursor": 9_007_199_254_740_992_i64 }),
            json!({ "cursor": -1 }),
            json!({ "cursor": "09223372036854775807" }),
            json!({ "cursor": "9223372036854775808" }),
            json!({ "cursor": 1.5 }),
        ] {
            assert!(activity_args_for_core(args).is_err());
        }
    }

    #[test]
    fn activity_i64_salen_como_decimales_exactos_por_ipc() {
        let response = activity_response_for_webview(json!({
            "next_cursor": i64::MAX,
            "head_seq": i64::MAX,
            "items": [{ "seq": i64::MAX, "args": { "depth": 1 } }],
        }));
        assert_eq!(response["next_cursor"], Value::String(i64::MAX.to_string()));
        assert_eq!(response["head_seq"], Value::String(i64::MAX.to_string()));
        assert_eq!(response["items"][0]["seq"], Value::String(i64::MAX.to_string()));
        assert_eq!(response["items"][0]["args"]["depth"], json!(1));
    }

    /// El inventario de recursos se LEE desde el ADE, pero por esta superficie no se toca nada: ni
    /// git, ni el disco, ni la lista de Tasks. Detectar no es adoptar ni borrar (LXO-93).
    #[test]
    fn el_inventario_de_recursos_es_de_solo_lectura() {
        assert!(is_ade_read_query("resource_inventory"));
        for operation in [
            "worktree_prune",
            "worktree_remove",
            "resource_adopt",
            "resource_archive",
            "resource_clean",
            "resource_delete",
            "branch_delete",
        ] {
            assert!(!is_ade_read_query(operation), "{operation} no debe exponerse en el ADE");
        }
    }
}
