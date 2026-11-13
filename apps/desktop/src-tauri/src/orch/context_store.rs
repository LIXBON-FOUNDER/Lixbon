//! ContextPackage guardado: construir desde un Attempt, leerlo e importarlo (LXO-138). Contrato: `docs/core/QUERIES.md` §
//! `context_package_build`, `context_package_get` y `context_package_import`; el paquete y su guardado: `docs/core/CONTEXT_PACKAGE.md`.
//!
//! * **El Core construye** ([`build`]): reúne la evidencia de git del worktree del Attempt (revisión, cambios, parche sin commit, archivos
//!   sin seguimiento y los commits sin publicar), la pasa por `context_package::build` (que redacta, acota y calcula la identidad) y la
//!   guarda. Nada de esto inicia un Attempt ni un handoff (F6): solo deja un paquete que una persona puede exportar.
//! * **El Core guarda** una sola vez ([`crate::store::Store::context_package_put`]): el paquete es inmutable y se identifica por su
//!   `package_id`; repetirlo no escribe nada.
//! * **El Core importa por la misma puerta que un Attempt** ([`import`]): `context_package::parse` (versión, formato, identidad, secretos)
//!   y la comprobación de los adjuntos contra su `sha256` ANTES de guardar. Un paquete rechazado no se guarda y no muestra su contenido
//!   (respuesta `invalid`, igual que `context_package_preview`). Importar no inicia nada: deja el paquete preparado para un Attempt futuro.
//! * **Solo una Person autenticada**: el paquete lleva el objetivo y las decisiones del trabajo y construirlo lee el worktree.
//!
//! Lo que no hace: no escribe Events (el paquete no es un hecho del Event Log) y no transfiere nada a otro host (F6/F7).

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use base64::Engine;
use serde_json::{json, Map, Value};

use super::context_package::{self, sha256_hex, Artifact, ArtifactKind, FileChange, NewPackage, PackageErrorCode, Revision, RevisionInput, UncommittedInput, UntrackedInput};
use super::context_preview;
use super::events::{Actor, MutationContext};
use super::model_read::with_model;
use super::state::now_ms;
use super::{Caller, Core};
use crate::hide_console;
use crate::store::{NewStoredPackage, PackageOrigin, PutOutcome, StoredPackage};

const API: u8 = 1;
/// Lo máximo que viaja de adjuntos por el RPC (el cuerpo HTTP admite 4 MiB y base64 pesa un tercio más).
const MAX_RPC_ATTACHMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS: usize = 300;
/// Cuántos archivos sin seguimiento se leen como mucho (el paquete admite 100).
const UNTRACKED_READ: usize = context_package::MAX_UNTRACKED;
/// Tope de lo que se lee de una salida de git: más no es un diff que un paquete pueda describir.
const MAX_GIT_OUTPUT: usize = 64 * 1024 * 1024;

fn invalid(m: impl Into<String>) -> String {
    format!("context_store_invalid_request: {}", m.into())
}

fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    match (context.map(|c| &c.actor), caller) {
        (Some(Actor::PersonId(id)), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("context_store_auth_required: solo una Person autenticada puede construir, leer o importar un ContextPackage".into()),
    }
}

fn args_of<'a>(args: &'a Value, allowed: &[&str], empty: &'a Map<String, Value>) -> Result<&'a Map<String, Value>, String> {
    let map = match args {
        Value::Null => empty,
        Value::Object(m) => m,
        _ => return Err(invalid("los argumentos son un objeto")),
    };
    if let Some(k) = map.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(invalid(format!("parámetro desconocido: {k}")));
    }
    Ok(map)
}

fn text_arg<'a>(map: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, String> {
    match map.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.trim().is_empty() && s.len() <= 200 => Ok(Some(s.trim())),
        Some(_) => Err(invalid(format!("`{key}` es un texto de hasta 200 caracteres"))),
    }
}

// ── git ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// La salida CRUDA de un git (no se pasa por UTF-8: un parche puede llevar bytes que no lo son) o por qué no se pudo.
fn git_bytes(dir: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = hide_console(Command::new("git").args(args).current_dir(dir).env("GIT_TERMINAL_PROMPT", "0"))
        .output()
        .map_err(|e| format!("no se pudo ejecutar git: {e}"))?;
    if !out.status.success() {
        return Err(format!("git {}: {}", args.first().copied().unwrap_or(""), String::from_utf8_lossy(&out.stderr).trim()));
    }
    if out.stdout.len() > MAX_GIT_OUTPUT {
        return Err(format!("git {}: la salida supera {MAX_GIT_OUTPUT} bytes", args.first().copied().unwrap_or("")));
    }
    Ok(out.stdout)
}

fn git_text(dir: &str, args: &[&str]) -> Result<String, String> {
    git_bytes(dir, args).map(|b| String::from_utf8_lossy(&b).trim().to_string())
}

/// Lo que se pudo reunir del worktree, y lo que NO (cada carencia consta: un paquete que calla lo que le falta engaña al receptor).
struct Evidence {
    revision: RevisionInput,
    uncommitted: Option<UncommittedInput>,
    bundle: Option<Vec<u8>>,
    artifacts: Vec<Artifact>,
    /// Notas para `constraints`: lo que se omitió y por qué.
    notes: Vec<String>,
}

fn numstat(dir: &str, base: &str, head: &str) -> Result<Vec<FileChange>, String> {
    let out = git_text(dir, &["-c", "core.quotepath=off", "diff", "--numstat", "--no-renames", base, head])?;
    let mut files = vec![];
    for line in out.lines() {
        let mut parts = line.splitn(3, '\t');
        let (added, deleted, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
        if path.is_empty() {
            continue;
        }
        // Un archivo binario no tiene cuentas (`-`): se deja sin ellas, nunca en cero.
        files.push(FileChange { path: path.to_string(), added: added.parse().ok(), deleted: deleted.parse().ok() });
    }
    Ok(files)
}

fn gather(worktree: &str, base_commit: Option<&str>, base_branch: Option<&str>, branch: Option<&str>) -> Evidence {
    let mut notes = vec![];
    let absent = |why: &str, notes: Vec<String>| Evidence { revision: RevisionInput::Absent(why.to_string()), uncommitted: None, bundle: None, artifacts: vec![], notes };
    let head = match git_text(worktree, &["rev-parse", "HEAD"]) {
        Ok(h) if !h.is_empty() => h,
        Ok(_) | Err(_) => return absent("no se pudo leer el HEAD del worktree", notes),
    };
    let tree = match git_text(worktree, &["rev-parse", "HEAD^{tree}"]) {
        Ok(t) if !t.is_empty() => t,
        Ok(_) | Err(_) => return absent("no se pudo leer el árbol del HEAD", notes),
    };
    let base = base_commit.map(str::to_string).filter(|b| !b.is_empty()).or_else(|| base_branch.and_then(|b| git_text(worktree, &["merge-base", "HEAD", b]).ok()).filter(|b| !b.is_empty()));
    let Some(base) = base else { return absent("el worktree no dice su commit base", notes) };

    let files = numstat(worktree, &base, &head).unwrap_or_else(|e| {
        notes.push(format!("la lista de archivos cambiados no se pudo leer ({})", e.chars().take(120).collect::<String>()));
        vec![]
    });
    // Hash y tamaño del diff ORIGINAL (sin redactar): lo que permite al receptor comprobar su copia.
    let (diff_sha256, diff_bytes) = match git_bytes(worktree, &["diff", "--binary", "--no-renames", &base, &head]) {
        Ok(d) => (Some(sha256_hex(&d)), Some(d.len() as u64)),
        Err(_) => {
            notes.push("el hash del diff no se pudo calcular".into());
            (None, None)
        }
    };
    let revision = Revision { base_commit: base.clone(), head_commit: head.clone(), head_tree: tree, branch: branch.map(str::to_string), files, diff_sha256, diff_bytes };

    // Lo que no está comprometido (D40): parche preparado, parche sin preparar y archivos sin seguimiento.
    let patch = |args: &[&str], what: &str, notes: &mut Vec<String>| -> Option<Vec<u8>> {
        match git_bytes(worktree, args) {
            Ok(p) if p.is_empty() => None,
            Ok(p) if p.len() > context_package::MAX_ATTACHMENT_BYTES => {
                notes.push(format!("el {what} ({} bytes) supera {} bytes y no viaja", p.len(), context_package::MAX_ATTACHMENT_BYTES));
                None
            }
            Ok(p) => Some(p),
            Err(_) => {
                notes.push(format!("el {what} no se pudo leer"));
                None
            }
        }
    };
    let staged = patch(&["diff", "--cached", "--binary", "--no-renames"], "parche preparado", &mut notes);
    let unstaged = patch(&["diff", "--binary", "--no-renames"], "parche sin preparar", &mut notes);
    let mut untracked = vec![];
    match git_bytes(worktree, &["ls-files", "--others", "--exclude-standard", "-z"]) {
        Ok(list) => {
            let paths: Vec<String> = list.split(|b| *b == 0).filter(|p| !p.is_empty()).map(|p| String::from_utf8_lossy(p).into_owned()).collect();
            let mut skipped = 0usize;
            for p in paths.iter().take(UNTRACKED_READ) {
                let full = Path::new(worktree).join(p);
                match std::fs::metadata(&full) {
                    Ok(m) if m.is_file() && m.len() as usize <= context_package::MAX_ATTACHMENT_BYTES => match std::fs::read(&full) {
                        Ok(data) => untracked.push(UntrackedInput { path: p.clone(), data }),
                        Err(_) => skipped += 1,
                    },
                    _ => skipped += 1,
                }
            }
            skipped += paths.len().saturating_sub(UNTRACKED_READ);
            if skipped > 0 {
                notes.push(format!("{skipped} archivos sin seguimiento no viajan (no son archivos legibles, pasan de {} bytes o sobran)", context_package::MAX_ATTACHMENT_BYTES));
            }
        }
        Err(_) => notes.push("los archivos sin seguimiento no se pudieron listar".into()),
    }
    let uncommitted = (staged.is_some() || unstaged.is_some() || !untracked.is_empty()).then_some(UncommittedInput { staged_patch: staged, unstaged_patch: unstaged, untracked });

    // Los commits sin publicar viajan en un `git bundle` (D39): sin él, el commit final no se resuelve en otro host.
    let bundle = match git_text(worktree, &["rev-list", "--count", "HEAD", "--not", "--remotes"]) {
        Ok(n) if n == "0" => None,
        Ok(_) => match git_bytes(worktree, &["bundle", "create", "-", "HEAD", "--not", "--remotes"]) {
            Ok(b) if b.len() <= context_package::MAX_ATTACHMENT_BYTES => Some(b),
            Ok(b) => {
                notes.push(format!("los commits sin publicar ({} bytes de bundle) superan {} bytes y no viajan: publica la rama antes de pasar el trabajo a otro host", b.len(), context_package::MAX_ATTACHMENT_BYTES));
                None
            }
            Err(_) => {
                notes.push("los commits sin publicar no se pudieron empaquetar".into());
                None
            }
        },
        Err(_) => None,
    };
    Evidence { revision: RevisionInput::Git(revision), uncommitted, bundle, artifacts: vec![Artifact { kind: ArtifactKind::Commit, uri: head, sha256: None, bytes: None }], notes }
}

// ── Respuesta ────────────────────────────────────────────────────────────────────────────────────────────────────────────

fn origin_code(o: PackageOrigin) -> &'static str {
    o.code()
}

/// La vista de un paquete guardado: la de `context_package_preview` (verificación, paquete y resumen) más qué adjuntos hay guardados.
fn stored_view(stored: &StoredPackage, blobs: &BTreeMap<String, Vec<u8>>, created: Option<bool>) -> Result<Value, String> {
    let mut v = context_preview::preview(&stored.json);
    if v["status"] != "valid" {
        // Lo guardado se validó al entrar: que ya no pase `parse` es una base alterada, no una petición mala.
        return Err(format!("context_store_corrupt: el paquete guardado {} ya no pasa la verificación", stored.package_id));
    }
    let attachments: Vec<Value> = v["package"]["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| {
            let id = a["id"].as_str().unwrap_or_default();
            json!({ "id": id, "kind": a["kind"], "bytes": a["bytes"], "sha256": a["sha256"], "scanned": a["scanned"], "omitted": a.get("omitted").cloned().unwrap_or(Value::Null), "stored": blobs.contains_key(id) })
        })
        .collect();
    v["attachments"] = Value::Array(attachments);
    v["stored"] = json!({ "origin": origin_code(stored.origin), "created_at_ms": stored.created_at, "stored_at_ms": stored.stored_at, "created": created });
    Ok(v)
}

fn put(core: &Core, p: &NewStoredPackage) -> Result<PutOutcome, String> {
    core.context_package_store(p, now_ms() as i64)
}

// ── Construir ────────────────────────────────────────────────────────────────────────────────────────────────────────────

struct Loaded {
    attempt: crate::store::AttemptRow,
    task: crate::store::TaskRow,
    worktree: Option<crate::store::WorktreeRow>,
    session: Option<String>,
    machine: String,
}

/// `context_package_build` · `{ attempt_id }`. Construye el paquete del Attempt con la evidencia de su worktree, lo guarda y lo devuelve.
pub(super) fn build(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["attempt_id"], &empty)?;
    let attempt_id = text_arg(map, "attempt_id")?.ok_or_else(|| invalid("falta `attempt_id`"))?;

    let loaded = with_model(core, |s| {
        let Some(attempt) = s.attempt_row(attempt_id)? else { return Ok(Err(format!("context_store_not_found: no existe el Attempt {attempt_id}"))) };
        let Some(task) = s.task_row(&attempt.task_id)? else { return Ok(Err(format!("context_store_not_found: no existe la Task {}", attempt.task_id))) };
        let worktree = s.worktree_of_attempt(attempt_id)?;
        let session = s.provider_session_of_attempt(attempt_id)?.map(|p| p.external_ref.unwrap_or(p.id));
        let machine = s.meta("machine_id")?.unwrap_or_default();
        Ok(Ok(Loaded { attempt, task, worktree, session, machine }))
    })
    .map_err(|e| e.replacen("model_unavailable", "context_store_unavailable", 1))?;
    let l = loaded;

    let project_id = l.task.project_id.clone().filter(|p| !p.is_empty()).ok_or_else(|| "context_store_unavailable: la Task no tiene proyecto: un paquete dice de qué proyecto viene".to_string())?;
    // Git corre SIN el almacén ni el candado del Core: un repositorio lento no bloquea a los demás lectores.
    let mut ev = match l.worktree.as_ref().and_then(|w| w.path.as_deref().map(|p| (w, p))) {
        Some((w, path)) if Path::new(path).is_dir() => gather(path, w.base_commit.as_deref(), w.base_branch.as_deref(), w.branch.as_deref()),
        Some(_) => Evidence { revision: RevisionInput::Absent("el worktree del intento ya no está en disco".into()), uncommitted: None, bundle: None, artifacts: vec![], notes: vec![] },
        None => Evidence { revision: RevisionInput::Absent("el intento no tiene worktree".into()), uncommitted: None, bundle: None, artifacts: vec![], notes: vec![] },
    };
    let objective = if l.task.spec.trim().is_empty() { l.task.title.clone() } else { l.task.spec.clone() };
    let summary = l.attempt.summary.trim();
    let built = context_package::build(NewPackage {
        created_at_ms: now_ms() as i64,
        project_id,
        task_id: l.task.id.clone(),
        attempt_id: l.attempt.id.clone(),
        provider: l.attempt.provider.clone(),
        provider_session: l.session.clone(),
        host: l.machine.clone(),
        objective,
        decisions: vec![],
        constraints: std::mem::take(&mut ev.notes),
        thread_summary: (!summary.is_empty()).then(|| summary.to_string()),
        revision: ev.revision,
        uncommitted: ev.uncommitted,
        test_results: None,
        artifacts: ev.artifacts,
        bundle: ev.bundle,
    })
    .map_err(|e| format!("context_store_unavailable: no se pudo construir el paquete ({}): {}", e.code.code(), super::context_package::redact(&e.message).0.chars().take(MAX_MESSAGE_CHARS).collect::<String>()))?;

    let package = built.package;
    let blobs: BTreeMap<String, (String, Vec<u8>)> = package
        .attachments
        .iter()
        .filter_map(|a| built.blobs.get(&a.id).map(|data| (a.id.clone(), (a.sha256.clone(), data.clone()))))
        .collect();
    let stored = NewStoredPackage {
        package_id: package.id().to_string(),
        origin: PackageOrigin::Built,
        task_id: package.source().task_id.clone(),
        attempt_id: package.source().attempt_id.clone(),
        created_at: package.created_at_ms,
        json: package.to_json().to_string(),
        blobs,
    };
    let outcome = put(core, &stored)?;
    let blobs_now: BTreeMap<String, Vec<u8>> = built.blobs;
    let row = StoredPackage { package_id: stored.package_id.clone(), origin: stored.origin, task_id: stored.task_id.clone(), attempt_id: stored.attempt_id.clone(), created_at: stored.created_at, stored_at: now_ms() as i64, json: stored.json.clone() };
    stored_view(&row, &blobs_now, Some(outcome == PutOutcome::Created))
}

// ── Leer ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// `context_package_get` · `{ package_id? | attempt_id?, include_attachments? }`. Lee un paquete guardado: por su id, o el más reciente de un Attempt.
pub(super) fn get(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["package_id", "attempt_id", "include_attachments"], &empty)?;
    let (package_id, attempt_id) = (text_arg(map, "package_id")?, text_arg(map, "attempt_id")?);
    let include = match map.get("include_attachments") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(invalid("`include_attachments` es un booleano")),
    };
    let (stored, blobs) = with_model(core, |s| {
        let stored = match (package_id, attempt_id) {
            (Some(id), None) => s.context_package(id)?,
            (None, Some(id)) => s.context_package_latest_of_attempt(id)?,
            _ => return Ok(Err(invalid("indica `package_id` o `attempt_id`, uno solo"))),
        };
        let Some(stored) = stored else {
            let what = package_id.map(|i| format!("el paquete {i}")).unwrap_or_else(|| format!("ningún paquete del Attempt {}", attempt_id.unwrap_or_default()));
            return Ok(Err(format!("context_store_not_found: no hay {what}: se construye con `context_package_build` o se importa")));
        };
        let blobs = s.context_package_blobs(&stored.package_id)?;
        Ok(Ok((stored, blobs)))
    })
    .map_err(|e| e.replacen("model_unavailable", "context_store_unavailable", 1))?;
    let mut v = stored_view(&stored, &blobs, None)?;
    if include {
        let total: usize = blobs.values().map(Vec::len).sum();
        if total > MAX_RPC_ATTACHMENT_BYTES {
            return Err(format!("context_store_attachments_too_large: los adjuntos pesan {total} bytes y por el RPC solo viajan {MAX_RPC_ATTACHMENT_BYTES}"));
        }
        let data: Map<String, Value> = blobs.iter().map(|(id, b)| (id.clone(), Value::String(base64::engine::general_purpose::STANDARD.encode(b)))).collect();
        v["attachment_data"] = Value::Object(data);
    }
    Ok(v)
}

// ── Importar ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

fn rejected(raw_len: usize, code: PackageErrorCode, message: &str) -> Value {
    let message: String = super::context_package::redact(message).0.chars().take(MAX_MESSAGE_CHARS).collect();
    json!({ "v": API, "status": "invalid", "error": { "code": code.code(), "message": message }, "serialized_bytes": raw_len })
}

/// `context_package_import` · `{ package, attachments? }`. Valida el paquete y sus adjuntos y, solo si pasan, lo guarda como importado.
/// Un paquete que no pasa NO es un error de la petición: es una respuesta `invalid` (para poder mostrarla), y no se guarda nada.
pub(super) fn import(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["package", "attachments"], &empty)?;
    let raw = map.get("package").and_then(Value::as_str).ok_or_else(|| invalid("`package` es el JSON del paquete, como texto"))?;
    if raw.len() > context_package::MAX_PACKAGE_BYTES * 2 {
        return Err(invalid(format!("el paquete pesa más de {} bytes: un ContextPackage v1 no pasa de {}", context_package::MAX_PACKAGE_BYTES * 2, context_package::MAX_PACKAGE_BYTES)));
    }
    let mut blobs: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    match map.get("attachments") {
        None | Some(Value::Null) => {}
        Some(Value::Object(m)) => {
            let mut total = 0usize;
            for (id, v) in m {
                let b64 = v.as_str().ok_or_else(|| invalid("cada adjunto es su contenido en base64"))?;
                let data = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| invalid("un adjunto no es base64 válido"))?;
                total += data.len();
                if total > MAX_RPC_ATTACHMENT_BYTES {
                    return Err(invalid(format!("los adjuntos pesan más de {MAX_RPC_ATTACHMENT_BYTES} bytes")));
                }
                blobs.insert(id.clone(), data);
            }
        }
        Some(_) => return Err(invalid("`attachments` es un objeto {id: base64}")),
    }
    // La misma puerta que un Attempt: si `parse` rechaza, la respuesta es la de la vista previa (sin contenido) y no se guarda nada.
    let package = match context_package::parse(raw) {
        Ok(p) => p,
        // La vista previa arma el rechazo (con las dos huellas si la identidad no coincide) sin mostrar el contenido.
        Err(_) => return Ok(context_preview::preview(raw)),
    };
    if let Err(e) = package.verify_attachments(&blobs) {
        return Ok(rejected(raw.len(), e.code, &e.message));
    }
    let stored_blobs: BTreeMap<String, (String, Vec<u8>)> = package
        .attachments
        .iter()
        .filter_map(|a| blobs.get(&a.id).map(|data| (a.id.clone(), (a.sha256.clone(), data.clone()))))
        .collect();
    let row = NewStoredPackage {
        package_id: package.id().to_string(),
        origin: PackageOrigin::Imported,
        task_id: package.source().task_id.clone(),
        attempt_id: package.source().attempt_id.clone(),
        created_at: package.created_at_ms,
        json: package.to_json().to_string(),
        blobs: stored_blobs,
    };
    let outcome = put(core, &row)?;
    // Si ya estaba, la vista es la del guardado (con su origen de la primera vez).
    let (stored, have) = with_model(core, |s| {
        let stored = s.context_package(&row.package_id)?;
        let have = s.context_package_blobs(&row.package_id)?;
        Ok(Ok((stored, have)))
    })
    .map_err(|e| e.replacen("model_unavailable", "context_store_unavailable", 1))?;
    let stored = stored.ok_or_else(|| format!("context_store_unavailable: el paquete {} no quedó guardado", row.package_id))?;
    stored_view(&stored, &have, Some(outcome == PutOutcome::Created))
}
