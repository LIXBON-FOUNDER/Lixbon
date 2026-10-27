//! `lxo attempts --task` y `lxo attempt show`: los Attempts (ejecuciones) de una Task, de solo lectura (LXO-124).
//!
//! La fuente son las lecturas vNext del Core por el RPC autenticado, como Person (`docs/core/QUERIES.md` § Modelo
//! Task/Attempt): `task_detail_v2` para la Task, `attempts_by_task` para la lista, `attempt_detail` para la ficha y
//! `activity_list` (`target_kind: attempt`) para su Activity. Antes del corte el Core no las sirve y lxo lo dice.
//! Nada selecciona «el último» Attempt: la ficha exige el id del Attempt. El `--json` es una allowlist propia de lxo
//! que separa `task_id` y `attempt_id`; lo que el Core no da queda `null`, nunca se deduce de archivos locales.

use serde_json::{json, Value};

use crate::client_auth::{self, RpcFailure};
use crate::events::{clean, timestamp_utc};
use crate::projects::{failure, finish, usage, Failure};
use crate::tasks::{activity, activity_lines, wrap};
use crate::Args;

pub(super) const HELP: &str =
    "Uso: lxo attempts --task <task_id> [--status S] [--provider P] [--json]
     lxo attempt show <attempt_id> [--json]      (también: lxo attempts show …)

Los intentos (ejecuciones) de una tarea según el modelo Task/Attempt del Core.
Solo lee: no lanza, reintenta, detiene ni reanuda nada.

`lxo attempts --task <task_id>` lista los intentos de la tarea por orden (#1, #2…)
y marca el actual. Filtros (se combinan con AND):
  --status S         pending_approval, starting, running, waiting,
                     awaiting_terminal_approval, done, failed, stopped o exited
  --provider P       claude, codex… (sin distinguir mayúsculas)

`lxo attempt show <attempt_id>` da la ejecución: estado y fechas, proveedor,
modelo, esfuerzo y perfil, la sesión del proveedor (resumida), el worktree, los
artifacts, la revisión (sobre qué HEAD), la actividad reciente y cómo seguirla.
El id de la tarea no vale aquí: una tarea puede tener varios intentos.

Salida:
  (por defecto)      texto para personas
  --json             {v, core_model, task, filters, total, attempts}; show da
                     {v, core_model, attempt, activity}
  Lo que el Core no registra (la máquina del worktree, por ejemplo) sale como
  null o «desconocido».

Necesita un Core con el modelo Task/Attempt activo (tras el corte). Con el modelo
anterior, cada tarea es su única ejecución: usa lxo task show <id>.
Solo para personas: dentro de una tarea del orquestador, usa lxo list y lxo show.

Códigos de salida: 0 correcto, 1 error interno del Core, 2 uso o filtro inválido,
3 autenticación, 4 versión o contrato (también: Core sin el modelo Task/Attempt),
5 Lixbon cerrado o Core no disponible, 6 tarea o intento inexistente.
";

const CONTRACT: u64 = 1;
/// Versión de `attempts_by_task` y `attempt_detail` que entiende lxo.
const ATTEMPT_API: u64 = 1;
/// Versión de `task_detail_v2`.
const TASK_API: u64 = 2;
const MODEL: &str = "task_attempt_v1";
/// `contracts/status-vocabulary.json` `attempt_state`.
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
const FINAL: [&str; 4] = ["done", "failed", "stopped", "exited"];
const LIST_FLAGS: [&str; 5] = ["task", "status", "provider", "json", "help"];

type Rpc<'a> = &'a mut dyn FnMut(&str, &Value) -> Result<Value, RpcFailure>;

#[derive(Debug, Default, PartialEq, Eq)]
struct Filters {
    status: Option<String>,
    provider: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Help,
    List(String, Filters),
    Show(String),
}

fn text_flag(a: &Args, name: &str) -> Result<Option<String>, Failure> {
    match a.flags.get(name) {
        None => Ok(None),
        Some(Value::String(v)) if !v.trim().is_empty() => Ok(Some(v.trim().to_string())),
        _ => Err(usage(format!("--{name} requiere un valor."))),
    }
}

fn check_flags(a: &Args, allowed: &[&str], command: &str) -> Result<(), Failure> {
    if let Some(name) = a.flags.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(usage(format!(
            "--{name} no es una opción de {command}. Mira `lxo attempts --help`."
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
    Ok(())
}

/// `lxo attempts --task <id> …` y `lxo attempt show <id>` (también `lxo attempts show <id>`).
fn parse(a: &Args) -> Result<Request, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    if a.at(0).as_deref() == Some("attempt") || a.at(1).as_deref() == Some("show") {
        if a.at(1).as_deref() != Some("show") {
            return Err(usage(match a.at(1) {
                Some(other) if "show".starts_with(&other) || other.starts_with("sh") => format!(
                    "«{}» no es una orden de lxo attempt; ¿querías lxo attempt show <attempt_id>?",
                    clean(&other)
                ),
                _ => "Uso: lxo attempt show <attempt_id>. Para la lista: lxo attempts --task <task_id>."
                    .into(),
            }));
        }
        check_flags(a, &["json", "help"], "lxo attempt show")?;
        return match a.pos.get(2..).unwrap_or_default() {
            [] => Err(usage(
                "Falta el intento: lxo attempt show <attempt_id>. Los ids salen en lxo attempts --task <task_id>.",
            )),
            [id] if !id.trim().is_empty() => Ok(Request::Show(id.trim().to_string())),
            _ => Err(usage("lxo attempt show recibe un solo id de intento.")),
        };
    }
    if let Some(extra) = a.at(1) {
        return Err(usage(format!(
            "lxo attempts no admite argumentos sueltos ({}); la tarea va con --task <task_id>.",
            clean(&extra)
        )));
    }
    check_flags(a, &LIST_FLAGS, "lxo attempts")?;
    // La tarea se nombra siempre: lxo no elige una por su cuenta.
    let Some(task) = text_flag(a, "task")? else {
        return Err(usage(
            "Falta la tarea: lxo attempts --task <task_id>. Sus ids salen en lxo tasks.",
        ));
    };
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
    Ok(Request::List(task, filters))
}

fn contract_error() -> Failure {
    Failure::Version(
        "El Core devolvió intentos con un formato que este lxo no entiende; actualiza Lixbon."
            .into(),
    )
}

/// Los errores de las lecturas vNext (`model_*`, `core_model_inactive`) y de `activity_list`.
fn model_failure(error: RpcFailure) -> Failure {
    if let RpcFailure::Rejected(m) = &error {
        if m.starts_with("core_model_inactive") {
            return Failure::Version(
                "Este Core aún usa el modelo anterior, con una sola ejecución por tarea: los intentos aparecen tras el corte Task/Attempt. Mientras, usa lxo task show <id>."
                    .into(),
            );
        }
        if m.starts_with("model_auth_required") || m.starts_with("activity_auth_required") {
            return Failure::Auth(
                "Los intentos del Core son solo para personas: una tarea del orquestador (agente) usa lxo list y lxo show."
                    .into(),
            );
        }
        if m.starts_with("model_unavailable") || m.starts_with("activity_unavailable") {
            return Failure::Unavailable(
                "El Core de Lixbon no tiene su almacén abierto; reinicia Lixbon.".into(),
            );
        }
        // lxo arma la petición: si el Core la rechaza, es que no hablan el mismo contrato.
        if let Some(detail) = m.strip_prefix("model_invalid_request: ") {
            return Failure::Version(format!(
                "El Core rechazó la consulta de intentos ({}); actualiza Lixbon.",
                clean(detail)
            ));
        }
        if m.starts_with("Comando desconocido") {
            return Failure::Version(
                "Este Core no ofrece los intentos de las tareas; actualiza Lixbon.".into(),
            );
        }
    }
    failure(error)
}

fn not_found(m: &str) -> bool {
    m.starts_with("model_not_found")
}

fn text(value: &Value) -> Value {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null)
}

fn origin(external: &Value) -> Value {
    match external.as_bool() {
        Some(true) => json!("external"),
        Some(false) => json!("lixbon"),
        None => Value::Null,
    }
}

/// Allowlist de un Attempt de la lista (`attempts_by_task`). `current` lo decide la Task, no lxo.
fn brief(a: &Value, task_id: &str, current: &Value) -> Value {
    let status = a["status"].as_str().unwrap_or("");
    json!({
        "attempt_id": text(&a["id"]),
        "task_id": task_id,
        "n": a["n"].as_u64(),
        "current": !current.is_null() && a["id"] == *current,
        "status": status,
        "final": FINAL.contains(&status),
        "provider": text(&a["provider"]),
        "model": text(&a["model"]),
        "role": text(&a["role"]),
        "origin": origin(&a["external"]),
        "created_at": a["created_at"].as_u64(),
        "started_at": a["started_at"].as_u64(),
        "ended_at": a["ended_at"].as_u64(),
    })
}

/// La Task de `task_detail_v2`, solo lo que la lista necesita (no copia el encargo).
fn task_of(rpc: Rpc, task_id: &str) -> Result<Value, Failure> {
    let data = match rpc("task_detail_v2", &json!({ "task_id": task_id })) {
        Ok(data) => data,
        Err(RpcFailure::Rejected(m)) if not_found(&m) => {
            return Err(Failure::NotFound(format!(
                "No hay ninguna tarea con id «{}». Sus ids salen en lxo tasks.",
                clean(task_id)
            )))
        }
        Err(error) => return Err(model_failure(error)),
    };
    let t = &data["task"];
    if data["v"].as_u64() != Some(TASK_API) || data["core_model"] != MODEL || !t["id"].is_string() {
        return Err(contract_error());
    }
    Ok(json!({
        "task_id": text(&t["id"]),
        "title": text(&t["title"]),
        "state": text(&t["state"]),
        "current_attempt_id": text(&t["current_attempt"]["id"]),
    }))
}

fn list_data(rpc: Rpc, task_id: &str, filters: &Filters) -> Result<Value, Failure> {
    let task = task_of(rpc, task_id)?;
    let data = match rpc("attempts_by_task", &json!({ "task_id": task_id })) {
        Ok(data) => data,
        Err(RpcFailure::Rejected(m)) if not_found(&m) => {
            return Err(Failure::NotFound(format!(
                "No hay ninguna tarea con id «{}». Sus ids salen en lxo tasks.",
                clean(task_id)
            )))
        }
        Err(error) => return Err(model_failure(error)),
    };
    let items = data["items"]
        .as_array()
        .filter(|_| data["v"].as_u64() == Some(ATTEMPT_API) && data["core_model"] == MODEL)
        .ok_or_else(contract_error)?;
    if items
        .iter()
        .any(|a| !a["id"].is_string() || !a["status"].is_string())
    {
        return Err(contract_error());
    }
    let mut attempts: Vec<Value> = items
        .iter()
        .map(|a| brief(a, task_id, &task["current_attempt_id"]))
        .collect();
    attempts.sort_by_key(|a| a["n"].as_u64().unwrap_or(0));
    let total = attempts.len();
    let wanted = filters.provider.as_deref().map(str::to_lowercase);
    attempts.retain(|a| {
        filters.status.as_deref().is_none_or(|s| a["status"] == s)
            && wanted.as_deref().is_none_or(|p| {
                a["provider"]
                    .as_str()
                    .is_some_and(|ap| ap.to_lowercase() == p)
            })
    });
    Ok(json!({
        "v": CONTRACT,
        "core_model": MODEL,
        "task": task,
        "filters": { "status": filters.status, "provider": filters.provider },
        "total": total,
        "attempts": attempts,
    }))
}

/// Allowlist de la ficha (`attempt_detail`). La sesión va sin la referencia del proveedor (el Core no la da).
fn detail(a: &Value) -> Value {
    let status = a["status"].as_str().unwrap_or("");
    let session = &a["provider_session"];
    let worktree = &a["worktree"];
    let review = &a["review"];
    json!({
        "attempt_id": text(&a["id"]),
        "task_id": text(&a["task_id"]),
        "n": a["n"].as_u64(),
        "status": status,
        "final": FINAL.contains(&status),
        "provider": text(&a["provider"]),
        "model": text(&a["model"]),
        "effort": text(&a["effort"]),
        "profile": text(&a["profile"]),
        "role": text(&a["role"]),
        "origin": origin(&a["external"]),
        "created_at": a["created_at"].as_u64(),
        "started_at": a["started_at"].as_u64(),
        "ended_at": a["ended_at"].as_u64(),
        "summary": text(&a["summary"]),
        "failure_reason": text(&a["failure_reason"]),
        "integrated": a["integrated"].as_bool(),
        "provider_session": if session.is_object() { json!({
            "provider_session_id": text(&session["id"]),
            "status": text(&session["status"]),
            "resumable": session["resumable"].as_bool(),
            "binding": text(&session["binding"]),
            "bound": session["bound"].as_bool(),
            "opened_by_attempt_id": text(&session["opened_by_attempt_id"]),
        }) } else { Value::Null },
        "worktree": if worktree.is_object() { json!({
            "worktree_id": text(&worktree["id"]),
            "path": text(&worktree["path"]),
            "branch": text(&worktree["branch"]),
            "base_branch": text(&worktree["base_branch"]),
            "provenance": text(&worktree["provenance"]),
            "state": text(&worktree["state"]),
            "machine": text(&worktree["machine"]),
            "branch_kept": worktree["branch_kept"].as_bool(),
            "registered_by_attempt_id": text(&worktree["registered_by_attempt_id"]),
        }) } else { Value::Null },
        "artifacts": a["artifacts"].as_array().into_iter().flatten().map(|x| json!({
            "artifact_id": text(&x["id"]),
            "kind": text(&x["kind"]),
            "uri": text(&x["uri"]),
            "sha256": text(&x["sha256"]),
            "bytes": x["bytes"].as_u64(),
        })).collect::<Vec<_>>(),
        "review": if review.is_object() { json!({
            "decision_id": review["decision_id"].as_u64(),
            "verdict": text(&review["verdict"]),
            "status": text(&review["status"]),
            "head_commit": text(&review["head_commit"]),
            "base_commit": text(&review["base_commit"]),
        }) } else { Value::Null },
    })
}

fn show_data(rpc: Rpc, attempt_id: &str) -> Result<Value, Failure> {
    let data = match rpc("attempt_detail", &json!({ "attempt_id": attempt_id })) {
        Ok(data) => data,
        Err(RpcFailure::Rejected(m)) if not_found(&m) => return Err(missing(rpc, attempt_id)),
        Err(error) => return Err(model_failure(error)),
    };
    let a = &data["attempt"];
    if data["v"].as_u64() != Some(ATTEMPT_API)
        || data["core_model"] != MODEL
        || !a["id"].is_string()
        || !a["status"].is_string()
        || !a["task_id"].is_string()
    {
        return Err(contract_error());
    }
    let id = a["id"].as_str().unwrap_or_default().to_string();
    Ok(json!({
        "v": CONTRACT,
        "core_model": MODEL,
        "attempt": detail(a),
        "activity": activity(rpc, "attempt", &id)?,
    }))
}

/// Un id que no es de ningún Attempt. Si es el de una Task, lo dice y da sus intentos, pero no elige uno.
fn missing(rpc: Rpc, id: &str) -> Failure {
    if let Ok(data) = rpc("attempts_by_task", &json!({ "task_id": id })) {
        let n = data["items"].as_array().map_or(0, Vec::len);
        return usage(format!(
            "«{}» es una tarea, no un intento, y una tarea puede tener varios ({n}). Elige uno con lxo attempts --task {}.",
            clean(id),
            clean(id)
        ));
    }
    Failure::NotFound(format!(
        "No hay ningún intento con id «{}». Los de una tarea salen con lxo attempts --task <task_id>.",
        clean(id)
    ))
}

pub(super) fn status_text(code: &str) -> String {
    match code {
        "pending_approval" => "pendiente de aprobación".into(),
        "starting" => "arrancando".into(),
        "running" => "en curso".into(),
        "waiting" => "esperando respuesta".into(),
        "awaiting_terminal_approval" => "esperando aprobación".into(),
        "done" => "terminado".into(),
        "failed" => "fallido".into(),
        "stopped" => "detenido".into(),
        "exited" => "salió".into(),
        other => clean(other),
    }
}

/// `contracts/status-vocabulary.json` `task_derived_state`.
fn state_text(code: &str) -> String {
    match code {
        "open" => "abierta".into(),
        "in_progress" => "en curso".into(),
        "in_review" => "en revisión".into(),
        "integrated" => "integrada".into(),
        "discarded" => "descartada".into(),
        other => clean(other),
    }
}

fn field(d: &Value, name: &str) -> Option<String> {
    d[name].as_str().map(clean)
}

fn dash(v: Option<String>) -> String {
    v.unwrap_or_else(|| "—".into())
}

fn agent_text(d: &Value) -> String {
    match (field(d, "provider"), field(d, "model")) {
        (Some(p), Some(m)) => format!("{p} ({m})"),
        (Some(p), None) => p,
        (None, Some(m)) => m,
        (None, None) => "agente desconocido".into(),
    }
}

/// Fecha corta en UTC: `2026-10-26 10:00`.
fn minute(d: &Value, name: &str) -> String {
    d[name]
        .as_u64()
        .map(|ms| timestamp_utc(ms as i64)[..16].replace('T', " "))
        .unwrap_or_else(|| "—".into())
}

fn count(n: usize) -> String {
    if n == 1 {
        "1 intento".into()
    } else {
        format!("{n} intentos")
    }
}

fn list_text(data: &Value) -> String {
    let task = &data["task"];
    let id = field(task, "task_id").unwrap_or_default();
    let total = data["total"].as_u64().unwrap_or(0) as usize;
    let mut lines = vec![format!(
        "{id} · {} · {} · {}",
        field(task, "title")
            .map(|t| format!("«{t}»"))
            .unwrap_or_else(|| "(sin título)".into()),
        state_text(task["state"].as_str().unwrap_or("?")),
        count(total)
    )];
    let attempts = data["attempts"].as_array().cloned().unwrap_or_default();
    if total == 0 {
        lines.push("  Sin intentos todavía: la tarea no se ha lanzado.".into());
        return lines.join("\n");
    }
    if attempts.is_empty() {
        lines.push(format!(
            "  Ningún intento cumple estos filtros (de {}).",
            count(total)
        ));
        return lines.join("\n");
    }
    for a in &attempts {
        lines.push(format!(
            "  #{} {} · {} · {}{}",
            a["n"]
                .as_u64()
                .map(|n| n.to_string())
                .unwrap_or_else(|| "?".into()),
            field(a, "attempt_id").unwrap_or_default(),
            status_text(a["status"].as_str().unwrap_or("?")),
            agent_text(a),
            if a["current"] == true {
                " · actual"
            } else {
                ""
            }
        ));
        lines.push(format!(
            "       creado {} · empezó {} · terminó {}",
            minute(a, "created_at"),
            minute(a, "started_at"),
            minute(a, "ended_at")
        ));
    }
    lines.push("Detalle de un intento: lxo attempt show <attempt_id>".into());
    lines.join("\n")
}

fn session_text(s: &Value, attempt: &str) -> Vec<String> {
    if !s.is_object() {
        return vec!["  Sesión:      ninguna registrada".into()];
    }
    let status = match s["status"].as_str() {
        Some("open") => "abierta".to_string(),
        Some("idle") => "en espera".to_string(),
        Some("closed") => "cerrada".to_string(),
        Some(other) => clean(other),
        None => "estado desconocido".into(),
    };
    let resumable = match s["resumable"].as_bool() {
        Some(true) => " · reanudable",
        Some(false) => " · no reanudable",
        None => "",
    };
    let opened = match field(s, "opened_by_attempt_id") {
        Some(by) if by == attempt => "la abrió este intento".to_string(),
        Some(by) => format!("la abrió {by} (este intento la reanudó)"),
        None => "no consta quién la abrió".into(),
    };
    let bound = match (s["bound"].as_bool(), field(s, "binding")) {
        (Some(true), Some(b)) => format!("vinculada al proveedor ({b})"),
        (Some(true), None) => "vinculada al proveedor".into(),
        _ => "sin vincular al proveedor".into(),
    };
    vec![
        format!(
            "  Sesión:      {} · {status}{resumable}",
            dash(field(s, "provider_session_id"))
        ),
        format!("               {opened} · {bound}"),
    ]
}

fn worktree_text(w: &Value) -> Vec<String> {
    if !w.is_object() {
        return vec!["  Worktree:    ninguno registrado".into()];
    }
    let provenance = match w["provenance"].as_str() {
        Some("created") => "creado por Lixbon".to_string(),
        Some("adopted") => "adoptado por Lixbon".to_string(),
        Some("external") => "externo (Lixbon no lo limpia)".to_string(),
        Some(other) => clean(other),
        None => "procedencia desconocida".into(),
    };
    let state = match w["state"].as_str() {
        Some("active") => "activo".to_string(),
        Some("missing") => "no está en disco".to_string(),
        Some("removed") => "retirado".to_string(),
        Some(other) => clean(other),
        None => "estado desconocido".into(),
    };
    let mut place = format!("rama {}", dash(field(w, "branch")));
    if let Some(base) = field(w, "base_branch") {
        place.push_str(&format!(" · base {base}"));
    }
    vec![
        format!("  Worktree:    {}", dash(field(w, "path"))),
        format!(
            "               {place} · {provenance} · {state} · {}",
            field(w, "machine")
                .map(|m| format!("máquina {m}"))
                .unwrap_or_else(|| "máquina desconocida".into())
        ),
    ]
}

fn artifact_lines(items: &Value) -> Vec<String> {
    let items = items.as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return vec!["  Artifacts:   ninguno".into()];
    }
    items
        .iter()
        .enumerate()
        .map(|(i, x)| {
            let kind = match x["kind"].as_str() {
                Some("report") => "informe".to_string(),
                Some("pull_request") => "PR".to_string(),
                Some("last_message") => "último mensaje".to_string(),
                Some("commit") => "commit".to_string(),
                Some("file") => "archivo".to_string(),
                Some(other) => clean(other),
                None => "desconocido".into(),
            };
            format!(
                "{}{kind}: {}",
                if i == 0 {
                    "  Artifacts:   "
                } else {
                    "               "
                },
                dash(field(x, "uri"))
            )
        })
        .collect()
}

fn review_text(r: &Value) -> String {
    if !r.is_object() {
        return "  Revisión:    sin revisión".into();
    }
    let verdict = match r["verdict"].as_str() {
        Some("accepted") => "aceptada".to_string(),
        Some("rejected") => "rechazada".to_string(),
        Some(other) => clean(other),
        None => "sin veredicto".into(),
    };
    let status = match r["status"].as_str() {
        Some("active") => "vigente".to_string(),
        Some("stale") => "obsoleta: el HEAD ya no es el revisado".to_string(),
        Some("superseded") => "sustituida por otra posterior".to_string(),
        Some(other) => clean(other),
        None => "estado desconocido".into(),
    };
    let base = field(r, "base_commit")
        .map(|b| format!(" sobre base {b}"))
        .unwrap_or_default();
    format!(
        "  Revisión:    {verdict} · HEAD {}{base} · {status}",
        dash(field(r, "head_commit"))
    )
}

fn show_text(data: &Value) -> String {
    let d = &data["attempt"];
    let id = field(d, "attempt_id").unwrap_or_default();
    let mut agent = agent_text(d);
    if let Some(effort) = field(d, "effort") {
        agent.push_str(&format!(" · esfuerzo {effort}"));
    }
    if let Some(profile) = field(d, "profile") {
        agent.push_str(&format!(" · perfil {profile}"));
    }
    let mut lines = vec![
        format!(
            "{id} · intento {} de la tarea {} · {}",
            d["n"]
                .as_u64()
                .map(|n| n.to_string())
                .unwrap_or_else(|| "?".into()),
            dash(field(d, "task_id")),
            status_text(d["status"].as_str().unwrap_or("?"))
        ),
        format!("  Agente:      {agent}"),
        format!("  Rol:         {}", dash(field(d, "role"))),
        format!(
            "  Origen:      {}",
            match d["origin"].as_str() {
                Some("external") => "coordinador externo",
                Some(_) => "Lixbon",
                None => "desconocido",
            }
        ),
        format!(
            "  Fechas:      creado {} · empezó {} · terminó {} (UTC)",
            minute(d, "created_at"),
            minute(d, "started_at"),
            minute(d, "ended_at")
        ),
    ];
    if let Some(summary) = field(d, "summary") {
        lines.extend(wrap("  Resultado:   ", "               ", &summary));
    }
    if let Some(reason) = field(d, "failure_reason") {
        lines.push(format!("  Fallo:       {reason}"));
    }
    lines.push(format!(
        "  Integrado:   {}",
        match d["integrated"].as_bool() {
            Some(true) => "sí",
            Some(false) => "no",
            None => "desconocido",
        }
    ));
    lines.extend(session_text(&d["provider_session"], &id));
    lines.extend(worktree_text(&d["worktree"]));
    lines.extend(artifact_lines(&d["artifacts"]));
    lines.push(review_text(&d["review"]));
    lines.extend(activity_lines(
        &data["activity"],
        &format!("lxo events --entity-kind attempt --entity-id {id}"),
    ));
    lines.push(format!(
        "  Seguir:      lxo events --entity-kind attempt --entity-id {id}"
    ));
    lines.push(format!(
        "               lxo attention --target-kind attempt --target-id {id}"
    ));
    lines.join("\n")
}

fn execute(request: Request, json: bool) -> Result<(), Failure> {
    let mut rpc = |cmd: &str, args: &Value| client_auth::rpc(cmd, args, &crate::cwd());
    match request {
        Request::Help => print!("{HELP}"),
        Request::List(task, filters) => {
            let data = list_data(&mut rpc, &task, &filters)?;
            if json {
                println!("{data}");
            } else {
                println!("{}", list_text(&data));
            }
        }
        Request::Show(id) => {
            let data = show_data(&mut rpc, &id)?;
            if json {
                println!("{data}");
            } else {
                println!("{}", show_text(&data));
            }
        }
    }
    Ok(())
}

pub(super) fn run(a: &Args) -> std::process::ExitCode {
    let json = a.b("json");
    finish(parse(a).and_then(|request| execute(request, json)), json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|s| s.to_string()).collect())
    }

    const FIXTURE_DETAIL: &str =
        include_str!("../../../../docs/core/fixtures/api/attempt_detail.v1.json");
    const FIXTURE_LIST: &str =
        include_str!("../../../../docs/core/fixtures/api/attempts_by_task.v1.json");

    fn attempt(task: &str, n: u64, status: &str, provider: &str) -> Value {
        json!({
            "id": format!("{task}-a{n}"), "n": n, "status": status, "provider": provider, "model": "m",
            "role": null, "external": false, "created_at": 1_792_000_000_000u64 + n * 60_000,
            "started_at": null, "ended_at": null
        })
    }

    /// Core simulado ya cortado: t0 sin intentos, t1 con uno (la fixture de la ADR, t5), t3 con tres.
    fn core_with(
        calls: Rc<RefCell<Vec<(String, Value)>>>,
        model: &'static str,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        move |cmd, args| {
            calls.borrow_mut().push((cmd.to_string(), args.clone()));
            if model != MODEL && cmd != "activity_list" {
                return Err(RpcFailure::Rejected(
                    "core_model_inactive: el Core aún sirve el modelo legacy; usa tasks_by_project y task_detail".into(),
                ));
            }
            let attempts = |task: &str| -> Option<Vec<Value>> {
                match task {
                    "t0" => Some(vec![]),
                    "t5" => Some(
                        serde_json::from_str::<Value>(FIXTURE_LIST).unwrap()["items"]
                            .as_array()
                            .unwrap()
                            .clone(),
                    ),
                    // El Core los da por `n`; lxo no depende de ello y vuelve a ordenar.
                    "t3" => Some(vec![
                        attempt("t3", 2, "failed", "codex"),
                        attempt("t3", 1, "stopped", "claude"),
                        attempt("t3", 3, "running", "Claude"),
                    ]),
                    _ => None,
                }
            };
            match cmd {
                "task_detail_v2" => {
                    let id = args["task_id"].as_str().unwrap();
                    let Some(items) = attempts(id) else {
                        return Err(RpcFailure::Rejected(format!(
                            "model_not_found: no existe la Task {id}"
                        )));
                    };
                    let current = items.iter().max_by_key(|a| a["n"].as_u64()).cloned();
                    Ok(json!({ "v": 2, "core_model": MODEL, "task": {
                        "id": id, "title": format!("tarea {id}"), "state": if id == "t3" { "in_progress" } else { "open" },
                        "spec": "texto privado del encargo", "attempt_count": items.len(), "current_attempt": current,
                        "attempts": items, "children": [], "thread": null
                    } }))
                }
                "attempts_by_task" => {
                    let id = args["task_id"].as_str().unwrap();
                    match attempts(id) {
                        Some(items) => Ok(
                            json!({ "v": 1, "core_model": MODEL, "task_id": id, "items": items }),
                        ),
                        None => Err(RpcFailure::Rejected(format!(
                            "model_not_found: no existe la Task {id}"
                        ))),
                    }
                }
                "attempt_detail" => {
                    let id = args["attempt_id"].as_str().unwrap();
                    if id == "t3-a1" {
                        Ok(serde_json::from_str(FIXTURE_DETAIL).unwrap())
                    } else {
                        Err(RpcFailure::Rejected(format!(
                            "model_not_found: no existe el Attempt {id}"
                        )))
                    }
                }
                "activity_list" => {
                    assert_eq!(
                        (
                            args["target_kind"].as_str(),
                            args["order"].as_str(),
                            args["limit"].as_u64()
                        ),
                        (Some("attempt"), Some("desc"), Some(10))
                    );
                    Ok(
                        json!({ "v": 1, "order": "desc", "has_more": false, "items": [
                        { "seq": 21, "ts": 1_792_000_090_000u64, "kind": "attempt.finished", "message_key": "activity.attempt.completed",
                          "args": { "task": "t3", "n": 1, "has_summary": true }, "visual": "success" },
                        { "seq": 20, "ts": 1_792_000_050_000u64, "kind": "attempt.started", "message_key": "activity.attempt.started",
                          "args": { "task": "t3", "n": 1 }, "visual": "info" }
                    ] }),
                    )
                }
                other => panic!("comando inesperado {other}"),
            }
        }
    }

    fn core() -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        core_with(Default::default(), MODEL)
    }

    fn list(raw: &[&str]) -> Result<Value, Failure> {
        match parse(&args(raw))? {
            Request::List(task, filters) => list_data(&mut core(), &task, &filters),
            other => panic!("se esperaba la lista: {other:?}"),
        }
    }

    fn ids(data: &Value) -> Vec<String> {
        data["attempts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["attempt_id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn tarea_con_cero_uno_y_n_intentos() {
        let none = list(&["attempts", "--task", "t0"]).unwrap();
        assert_eq!(
            (none["total"].clone(), none["attempts"].clone()),
            (json!(0), json!([]))
        );
        assert!(
            list_text(&none).contains("Sin intentos todavía"),
            "{}",
            list_text(&none)
        );

        let one = list(&["attempts", "--task", "t5"]).unwrap();
        assert_eq!(ids(&one), ["t5-a1"]);
        assert_eq!(one["attempts"][0]["current"], true);

        let many = list(&["attempts", "--task", "t3"]).unwrap();
        assert_eq!(
            ids(&many),
            ["t3-a1", "t3-a2", "t3-a3"],
            "por n, aunque el Core los dé en otro orden"
        );
        let current: Vec<bool> = many["attempts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["current"] == true)
            .collect();
        assert_eq!(
            current,
            [false, false, true],
            "el actual lo dice la Task (current_attempt), no lxo"
        );
        let human = list_text(&many);
        assert!(
            human.starts_with("t3 · «tarea t3» · en curso · 3 intentos"),
            "{human}"
        );
        assert!(
            human.contains("#3 t3-a3 · en curso · Claude (m) · actual"),
            "{human}"
        );
        assert!(human.contains("lxo attempt show <attempt_id>"), "{human}");
    }

    #[test]
    fn filtros_de_estado_y_proveedor() {
        assert_eq!(
            ids(&list(&["attempts", "--task", "t3", "--status", "failed"]).unwrap()),
            ["t3-a2"]
        );
        assert_eq!(
            ids(&list(&["attempts", "--task", "t3", "--provider", "CLAUDE"]).unwrap()),
            ["t3-a1", "t3-a3"],
            "el proveedor no distingue mayúsculas"
        );
        let none = list(&[
            "attempts",
            "--task",
            "t3",
            "--provider",
            "claude",
            "--status",
            "done",
        ])
        .unwrap();
        assert_eq!(
            (none["total"].clone(), none["attempts"].clone()),
            (json!(3), json!([]))
        );
        assert_eq!(
            none["filters"],
            json!({ "status": "done", "provider": "claude" })
        );
        assert!(list_text(&none).contains("Ningún intento cumple estos filtros (de 3 intentos)."));
    }

    #[test]
    fn uso_invalido_se_rechaza_antes_de_llamar_al_core() {
        for (raw, wanted) in [
            (&["attempts"][..], "Falta la tarea"),
            (&["attempts", "t3"][..], "argumentos sueltos"),
            (&["attempts", "--task"][..], "--task requiere un valor"),
            (
                &["attempts", "--task", "t3", "--status", "rara"][..],
                "--status no reconoce",
            ),
            (
                &["attempts", "--task", "t3", "--last"][..],
                "--last no es una opción",
            ),
            (
                &["attempts", "--task", "t3", "--task", "t4"][..],
                "aparece más de una vez",
            ),
            (&["attempt", "show"][..], "Falta el intento"),
            (&["attempt", "show", "a", "b"][..], "un solo id"),
            (
                &["attempt", "sho", "t3-a1"][..],
                "¿querías lxo attempt show",
            ),
            (&["attempt", "t3-a1"][..], "Uso: lxo attempt show"),
            (
                &["attempt", "show", "t3-a1", "--json=si"][..],
                "no admite un valor",
            ),
        ] {
            match parse(&args(raw)) {
                Err(Failure::Usage(m)) => assert!(m.contains(wanted), "{raw:?}: {m}"),
                other => panic!("{raw:?}: {other:?}"),
            }
        }
        assert_eq!(
            parse(&args(&["attempts", "show", "t3-a1"])).unwrap(),
            Request::Show("t3-a1".into())
        );
        assert_eq!(parse(&args(&["attempt", "help"])).unwrap(), Request::Help);
    }

    #[test]
    fn el_id_de_la_tarea_no_selecciona_un_intento() {
        let calls: Rc<RefCell<Vec<(String, Value)>>> = Default::default();
        let mut rpc = core_with(calls.clone(), MODEL);
        match show_data(&mut rpc, "t3") {
            Err(Failure::Usage(m)) => {
                assert!(
                    m.contains("«t3» es una tarea, no un intento") && m.contains("varios (3)"),
                    "{m}"
                );
                assert!(m.contains("lxo attempts --task t3"), "{m}");
            }
            other => panic!("{other:?}"),
        }
        let asked: Vec<String> = calls.borrow().iter().map(|(c, _)| c.clone()).collect();
        assert_eq!(
            asked,
            ["attempt_detail", "attempts_by_task"],
            "no pide el detalle de ningún intento por su cuenta"
        );
    }

    #[test]
    fn intento_o_tarea_inexistente() {
        match show_data(&mut core(), "t9-a1") {
            Err(Failure::NotFound(m)) => {
                assert!(m.contains("No hay ningún intento con id «t9-a1»"), "{m}")
            }
            other => panic!("{other:?}"),
        }
        match list(&["attempts", "--task", "t9"]) {
            Err(Failure::NotFound(m)) => {
                assert!(m.contains("No hay ninguna tarea con id «t9»"), "{m}")
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(Failure::NotFound(String::new()).code(), ("not_found", 6));
    }

    #[test]
    fn antes_del_corte_lo_dice_y_sale_con_4() {
        let mut legacy = core_with(Default::default(), "legacy");
        for result in [
            list_data(&mut legacy, "t3", &Filters::default()),
            show_data(&mut legacy, "t3-a1"),
        ] {
            match result {
                Err(f @ Failure::Version(_)) => {
                    assert!(
                        f.message().contains("modelo anterior")
                            && f.message().contains("lxo task show"),
                        "{}",
                        f.message()
                    );
                    assert_eq!(f.code().1, 4);
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn errores_del_core_y_contrato() {
        let rejected = |m: &str| RpcFailure::Rejected(m.into());
        assert!(matches!(
            model_failure(rejected("model_auth_required: solo una Person")),
            Failure::Auth(_)
        ));
        assert!(matches!(
            model_failure(rejected("model_unavailable: cerrado")),
            Failure::Unavailable(_)
        ));
        assert!(matches!(
            model_failure(rejected("model_invalid_request: falta `task_id`")),
            Failure::Version(_)
        ));
        assert!(matches!(
            model_failure(rejected("Comando desconocido: attempts_by_task")),
            Failure::Version(_)
        ));
        // Un Core que cambia la forma publicada sin subir la versión no se lee a medias.
        let mut wrong_version = |cmd: &str, _: &Value| match cmd {
            "attempt_detail" => Ok(
                json!({ "v": 2, "core_model": MODEL, "attempt": { "id": "x", "status": "done", "task_id": "t" } }),
            ),
            other => panic!("{other}"),
        };
        assert!(matches!(
            show_data(&mut wrong_version, "x"),
            Err(Failure::Version(_))
        ));
        let mut no_items = |cmd: &str, args: &Value| match cmd {
            "task_detail_v2" => {
                Ok(json!({ "v": 2, "core_model": MODEL, "task": { "id": args["task_id"] } }))
            }
            "attempts_by_task" => Ok(json!({ "v": 1, "core_model": MODEL, "task_id": "t" })),
            other => panic!("{other}"),
        };
        assert!(matches!(
            list_data(&mut no_items, "t", &Filters::default()),
            Err(Failure::Version(_))
        ));
    }

    /// Snapshot del `--json` de la ficha sobre la fixture publicada del Core (`attempt_detail.v1.json`).
    #[test]
    fn snapshot_json_de_la_ficha_sobre_la_fixture_del_core() {
        let data = show_data(&mut core(), "t3-a1").unwrap();
        let mut attempt = data["attempt"].clone();
        assert_eq!(
            attempt,
            json!({
                "attempt_id": "t3-a1", "task_id": "t3", "n": 1, "status": "done", "final": true,
                "provider": "codex", "model": "gpt-6.1-sol", "effort": "high", "profile": "implementar",
                "role": "implementador", "origin": "lixbon",
                "created_at": 1_792_000_040_000u64, "started_at": 1_792_000_050_000u64, "ended_at": null,
                "summary": "API lista", "failure_reason": null, "integrated": true,
                "provider_session": {
                    "provider_session_id": "ps-t3-a1", "status": "idle", "resumable": true,
                    "binding": "session_id", "bound": true, "opened_by_attempt_id": "t3-a1"
                },
                "worktree": {
                    "worktree_id": "wt-t3-a1", "path": "/home/ana/app.lixbon-wt/t3-api-de-sesiones",
                    "branch": "lx/r1/t3-api-de-sesiones", "base_branch": "main", "provenance": "created",
                    "state": "active", "machine": null, "branch_kept": false, "registered_by_attempt_id": "t3-a1"
                },
                "artifacts": [
                    { "artifact_id": "t3-a1-last_message", "kind": "last_message", "sha256": null, "bytes": null,
                      "uri": "/home/ana/app.lixbon-wt/t3-api-de-sesiones/.lixbon/out/t3/last.txt" },
                    { "artifact_id": "t3-a1-report", "kind": "report", "sha256": null, "bytes": null,
                      "uri": "/home/ana/app/.lixbon/informes/r1/t3.md" }
                ],
                "review": {
                    "decision_id": 1, "verdict": "accepted", "status": "active",
                    "head_commit": "c3c3c3", "base_commit": "b0b0b0"
                }
            })
        );
        assert_eq!(
            (data["v"].clone(), data["core_model"].clone()),
            (json!(1), json!(MODEL))
        );
        assert!(
            attempt.as_object_mut().unwrap().remove("id").is_none(),
            "nunca un `id` a secas"
        );
        let texts: Vec<&str> = data["activity"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| i["text"].as_str())
            .collect();
        assert_eq!(
            texts.len(),
            2,
            "la actividad del intento viene traducida: {}",
            data["activity"]
        );
        assert!(
            data["activity"]["items"][0]["seq"] == 20,
            "lo último al final"
        );
    }

    #[test]
    fn snapshot_json_de_la_lista_distingue_task_y_attempt() {
        let data = list(&["attempts", "--task", "t5"]).unwrap();
        assert_eq!(
            data,
            json!({
                "v": 1, "core_model": MODEL,
                "task": { "task_id": "t5", "title": "tarea t5", "state": "open", "current_attempt_id": "t5-a1" },
                "filters": { "status": null, "provider": null },
                "total": 1,
                "attempts": [{
                    "attempt_id": "t5-a1", "task_id": "t5", "n": 1, "current": true, "status": "done", "final": true,
                    "provider": "claude", "model": "sonnet", "role": null, "origin": "lixbon",
                    "created_at": 1_792_000_046_000u64, "started_at": 1_792_000_070_000u64, "ended_at": null
                }]
            })
        );
        assert!(
            !data.to_string().contains("texto privado"),
            "no copia el encargo de la Task"
        );
    }

    #[test]
    fn ficha_humana_con_sesion_worktree_artifacts_y_revision() {
        let human = show_text(&show_data(&mut core(), "t3-a1").unwrap());
        for wanted in [
            "t3-a1 · intento 1 de la tarea t3 · terminado",
            "  Agente:      codex (gpt-6.1-sol) · esfuerzo high · perfil implementar",
            "  Resultado:   API lista",
            "  Integrado:   sí",
            "  Sesión:      ps-t3-a1 · en espera · reanudable",
            "la abrió este intento · vinculada al proveedor (session_id)",
            "  Worktree:    /home/ana/app.lixbon-wt/t3-api-de-sesiones",
            "rama lx/r1/t3-api-de-sesiones · base main · creado por Lixbon · activo · máquina desconocida",
            "  Artifacts:   último mensaje: /home/ana/app.lixbon-wt/",
            "               informe: /home/ana/app/.lixbon/informes/r1/t3.md",
            "  Revisión:    aceptada · HEAD c3c3c3 sobre base b0b0b0 · vigente",
            "  Seguir:      lxo events --entity-kind attempt --entity-id t3-a1",
            "· Empezó el intento 1 de la tarea t3.",
            "· El intento 1 de la tarea t3 terminó correctamente",
        ] {
            assert!(human.contains(wanted), "falta «{wanted}» en:\n{human}");
        }
        // Una ficha sin nada de ejecución todavía: lo desconocido se dice, no se inventa.
        let bare = json!({ "v": 1, "core_model": MODEL, "activity": null, "attempt": detail(&json!({
            "id": "t4-a1", "task_id": "t4", "n": 1, "status": "pending_approval", "artifacts": [],
            "provider_session": null, "worktree": null, "review": null
        })) });
        let human = show_text(&bare);
        for wanted in [
            "t4-a1 · intento 1 de la tarea t4 · pendiente de aprobación",
            "agente desconocido",
            "  Integrado:   desconocido",
            "  Sesión:      ninguna registrada",
            "  Worktree:    ninguno registrado",
            "  Artifacts:   ninguno",
            "  Revisión:    sin revisión",
            "  Actividad:   no disponible en este Core",
        ] {
            assert!(human.contains(wanted), "falta «{wanted}» en:\n{human}");
        }
    }

    #[test]
    fn la_ayuda_nombra_los_estados_del_vocabulario() {
        let vocab: Value =
            serde_json::from_str(include_str!("../../../../contracts/status-vocabulary.json"))
                .unwrap();
        let ids: Vec<&str> = vocab["domain"]["attempt_state"]["ids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(ids, STATUSES);
        let finals: Vec<&str> = vocab["domain"]["attempt_state"]["final"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(finals, FINAL);
        for s in STATUSES {
            assert!(HELP.contains(s), "{s}");
        }
    }
}
