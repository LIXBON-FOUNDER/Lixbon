//! Query `context_package_preview` (LXO-136): qué contexto viajaría en un ContextPackage, para revisarlo ANTES de cualquier
//! transferencia. Contrato: `docs/core/QUERIES.md` § context_package_preview; el paquete en sí: `docs/core/CONTEXT_PACKAGE.md`.
//!
//! # Principios
//! * **La verificación es del Core.** Se llama a [`context_package::parse`], la misma puerta por la que entra un paquete a un
//!   Attempt: versión, campos, formatos, identidad (`package_id` = sha256 del contenido canónico) y secretos. El cliente no
//!   reimplementa nada de eso. Un paquete que `parse` rechaza es `status: "invalid"` y **no se muestra su contenido**: un
//!   paquete alterado no se presenta como si fuera de fiar.
//! * **La vista refleja exactamente el paquete.** `package` es el documento serializado tal cual, sin recortar ni reinterpretar;
//!   `summary` solo añade lo que se calcula sobre él (tamaños, qué se omitió, qué no se escaneó).
//! * **Solo lectura.** No guarda el paquete, no crea ningún Attempt, no inicia ninguna transferencia (F6) y no tiene forma de
//!   revelar lo redactado: un valor `[redactado]` llega ya redactado y así se queda.
//! * Los mensajes de error pasan por la redacción y se acotan: el texto que dio la persona no vuelve entero a la respuesta.

use serde_json::{json, Map, Value};

use super::context_package::{self, ContextPackage, PackageErrorCode, MAX_PACKAGE_BYTES};
use super::events::{Actor, MutationContext};
use super::{Caller, Core};

const API_VERSION: u8 = 1;
/// Lo máximo que acepta la petición: el tope del paquete más holgura para el sobre. Más es un error de petición, no un paquete.
const MAX_REQUEST_BYTES: usize = MAX_PACKAGE_BYTES * 2;
const MAX_MESSAGE_CHARS: usize = 300;
const PARAMS: [&str; 1] = ["package"];

fn invalid(message: impl Into<String>) -> String {
    format!("context_preview_invalid_request: {}", message.into())
}

/// Solo una persona autenticada, como el resto de lecturas del ADE: el paquete puede llevar el objetivo y las decisiones del trabajo.
fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    let context = context.ok_or_else(|| "context_preview_auth_required: la lectura requiere un cliente autenticado".to_string())?;
    match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("context_preview_auth_required: solo una Person autenticada puede revisar un paquete".into()),
    }
}

/// Un texto de error acotado y redactado: el de `parse` nombra el campo, pero la entrada es de la persona.
fn safe_message(raw: &str) -> String {
    let (redacted, _) = context_package::redact(raw);
    let mut out: String = redacted.chars().take(MAX_MESSAGE_CHARS).collect();
    if redacted.chars().count() > MAX_MESSAGE_CHARS {
        out.push('…');
    }
    out
}

/// Lo que se calcula SOBRE el paquete: tamaños y qué falta o no se pudo comprobar. No reinterpreta nada de lo que dice.
fn summary(p: &ContextPackage) -> Value {
    let attachments_total: u64 = p.attachments.iter().map(|a| a.bytes).sum();
    let omitted = p.attachments.iter().filter(|a| a.omitted.is_some()).count();
    // Un adjunto omitido no viaja, así que no hay nada que escanear: solo cuentan los que viajan y no se pudieron escanear.
    let unscanned = p.attachments.iter().filter(|a| a.omitted.is_none() && !a.scanned).count();
    let files = p.revision.as_ref().map_or(0, |r| r.files.len());
    let untracked = p.uncommitted.as_ref().map_or(0, |u| u.untracked.len());

    // Los códigos son un conjunto cerrado y van siempre en este orden: el cliente decide por ellos, no por texto.
    let mut notes: Vec<&str> = vec![];
    if !p.truncated.is_empty() {
        notes.push("truncated");
    }
    if p.redactions > 0 {
        notes.push("redacted");
    }
    if p.revision.is_none() {
        notes.push("revision_absent");
    }
    if omitted > 0 {
        notes.push("attachment_omitted");
    }
    if unscanned > 0 {
        notes.push("attachment_not_scanned");
    }
    // «Parcial» = falta algo que el receptor necesitaría; redactar y no poder escanear un adjunto no quitan contenido.
    let partial = !p.truncated.is_empty() || p.revision.is_none() || omitted > 0;
    json!({
        "serialized_bytes": p.to_json().len(),
        "completeness": if partial { "partial" } else { "complete" },
        "notes": notes,
        "counts": {
            "decisions": p.decisions.len(),
            "constraints": p.constraints.len(),
            "files": files,
            "untracked": untracked,
            "artifacts": p.artifacts.len(),
            "attachments": p.attachments.len(),
            "attachments_omitted": omitted,
            "attachments_not_scanned": unscanned,
            "attachments_bytes": attachments_total,
            "redactions": p.redactions,
            "truncated_fields": p.truncated.len(),
        },
    })
}

/// La respuesta de un paquete que `parse` rechazó: el código, un mensaje acotado y, si el rechazo es de identidad, los dos hashes
/// (no son secretos y son lo que hace visible la alteración). NUNCA el contenido del paquete.
fn rejected(raw: &str, code: PackageErrorCode, message: &str) -> Value {
    let mut out = json!({
        "v": API_VERSION,
        "status": "invalid",
        "error": { "code": code.code(), "message": safe_message(message) },
        "serialized_bytes": raw.len(),
    });
    if code == PackageErrorCode::IdMismatch {
        if let Ok(v) = serde_json::from_str::<Value>(raw) {
            let declared = v.get("package_id").and_then(Value::as_str).filter(|s| s.len() == 71 && s.starts_with("sha256:")).map(str::to_string);
            out["declared_id"] = json!(declared);
            out["recomputed_id"] = json!(context_package::package_id_of(&v));
        }
    }
    out
}

/// La vista previa de un paquete. Pura: no toca el Core, así que la prueban directamente las pruebas.
pub(super) fn preview(raw: &str) -> Value {
    match context_package::parse(raw) {
        Err(e) => rejected(raw, e.code, &e.message),
        Ok(p) => json!({
            "v": API_VERSION,
            "status": "valid",
            // Lo que se comprobó: la identidad (el hash del contenido canónico) y la ausencia de secretos. Los bytes de los
            // adjuntos no llegan con el paquete, así que NO se han comprobado: lo dice la respuesta, no se supone.
            "verification": { "identity": "verified", "secrets": "none_found", "attachments": "not_checked" },
            "package_id": p.id(),
            "package": serde_json::to_value(&*p).unwrap_or(Value::Null),
            "summary": summary(&p),
        }),
    }
}

/// `context_package_preview` · `{ package: "<JSON del paquete>" }`. Ver el contrato en `docs/core/QUERIES.md`.
pub(super) fn query(_core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let obj: &Map<String, Value> = args.as_object().ok_or_else(|| invalid("los argumentos son un objeto con `package`"))?;
    if let Some(k) = obj.keys().find(|k| !PARAMS.contains(&k.as_str())) {
        return Err(invalid(format!("parámetro desconocido: {k}")));
    }
    let raw = obj.get("package").and_then(Value::as_str).ok_or_else(|| invalid("`package` es el JSON del paquete, como texto"))?;
    if raw.len() > MAX_REQUEST_BYTES {
        return Err(invalid(format!("el paquete pesa más de {MAX_REQUEST_BYTES} bytes: un ContextPackage v1 no pasa de {MAX_PACKAGE_BYTES}")));
    }
    Ok(preview(raw))
}
