//! ContextPackage v1 (LXO-133): el paquete explícito, versionado e inmutable que lleva el contexto de una Task cuando cambia
//! de proveedor, de host o de sesión. Contrato, decisiones y evidencia: `docs/core/CONTEXT_PACKAGE.md` (ADR de LXO-132).
//!
//! * **Se construye una vez** ([`build`]): redacta antes de serializar, acota con marca explícita, calcula `package_id` y
//!   no ofrece ninguna forma de modificarlo después (sin `&mut`, sin `Deserialize` público).
//! * **Solo entra por [`parse`]**, que rechaza versión desconocida, campos que faltan o sobran, formatos inválidos,
//!   identidad que no coincide con el contenido y cualquier secreto. Un paquete que no pasa `parse` no inicia un Attempt.
//! * **Los adjuntos viajan aparte** (por `sha256`): [`ContextPackage::verify_attachments`] comprueba los bytes recibidos.
//!
//! Sin consumidores todavía: el comando de resume y su fallback (LXO-134) y los clientes (LXO-136/138/140) lo usan.
#![allow(dead_code)]

mod canonical;
mod secrets;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::ops::Deref;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use canonical::{canonical, fingerprint, package_id_of, sha256_hex};
pub use secrets::{contains_secret, redact};
#[cfg(test)]
pub(crate) use secrets::REDACTED;

pub const SCHEMA_VERSION: u32 = 1;

/// El paquete serializado, sin adjuntos.
pub const MAX_PACKAGE_BYTES: usize = 64 * 1024;
pub const MAX_OBJECTIVE_CHARS: usize = 2000;
/// El mismo tope que `Thread.summary`.
pub const MAX_THREAD_SUMMARY_CHARS: usize = 2000;
pub const MAX_LIST_ITEMS: usize = 32;
pub const MAX_ITEM_CHARS: usize = 500;
pub const MAX_FILES: usize = 500;
pub const MAX_ARTIFACTS: usize = 64;
pub const MAX_UNTRACKED: usize = 100;
pub const MAX_ATTACHMENTS: usize = 128;
pub const MAX_ATTACHMENT_BYTES: usize = 1024 * 1024;
pub const MAX_ATTACHMENTS_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_ID_CHARS: usize = 128;
const MAX_PATH_CHARS: usize = 300;
const MAX_BRANCH_CHARS: usize = 255;
const MAX_COMMAND_CHARS: usize = 200;
const MAX_REASON_CHARS: usize = 200;
const OMITTED_SECRET: &str = "secret_detected";
const REQUIRED: [&str; 9] = ["schema_version", "package_id", "created_at_ms", "source", "objective", "decisions", "constraints", "revision", "redactions"];

// ── Errores ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Conjunto CERRADO de códigos: un cliente decide por el código, no por el texto.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PackageErrorCode {
    InvalidJson,
    UnsupportedVersion,
    MissingField,
    InvalidField,
    IdMismatch,
    TooLarge,
    SecretDetected,
    AttachmentMismatch,
}

impl PackageErrorCode {
    pub fn code(self) -> &'static str {
        match self {
            PackageErrorCode::InvalidJson => "invalid_json",
            PackageErrorCode::UnsupportedVersion => "unsupported_version",
            PackageErrorCode::MissingField => "missing_field",
            PackageErrorCode::InvalidField => "invalid_field",
            PackageErrorCode::IdMismatch => "id_mismatch",
            PackageErrorCode::TooLarge => "too_large",
            PackageErrorCode::SecretDetected => "secret_detected",
            PackageErrorCode::AttachmentMismatch => "attachment_mismatch",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PackageError {
    pub code: PackageErrorCode,
    pub message: String,
}

impl PackageError {
    fn new(code: PackageErrorCode, message: impl Into<String>) -> PackageError {
        PackageError { code, message: message.into() }
    }

    fn invalid(message: impl Into<String>) -> PackageError {
        PackageError::new(PackageErrorCode::InvalidField, message)
    }
}

impl fmt::Display for PackageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.code(), self.message)
    }
}

impl std::error::Error for PackageError {}

type Res<T> = Result<T, PackageError>;

// ── Schema v1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/// De dónde sale el paquete. Lo fija el Core al crearlo; el receptor no puede cambiarlo (D44).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub project_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub provider: String,
    /// Huella (`fp:` + 8 hex) de la ProviderSession; nunca la referencia opaca.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session: Option<String>,
    /// Huella del host; nunca su nombre ni su ruta.
    pub host: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FileChange {
    /// Relativa al repositorio.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<u64>,
}

/// La evidencia del trabajo hecho, verificable sin copiar el repositorio (D39).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Revision {
    pub base_commit: String,
    pub head_commit: String,
    /// Árbol de `head_commit`: lo que se compara en otro host aunque el commit no esté publicado.
    pub head_tree: String,
    /// Informativa: puede no existir en el receptor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default)]
    pub files: Vec<FileChange>,
    /// Hash del diff ORIGINAL `base..head`, sin redactar.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_bytes: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Untracked {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    /// Adjunto con el contenido, si viaja.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<String>,
}

/// El estado sin commit de un worktree sucio (D40): parche preparado, no preparado y archivos sin seguimiento.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct Uncommitted {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged_patch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unstaged_patch: Option<String>,
    #[serde(default)]
    pub untracked: Vec<Untracked>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TestResults {
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ignored: Option<u64>,
}

/// Los mismos tipos y localizadores que el Artifact de LXO-116.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Commit,
    Report,
    LastMessage,
    File,
    PullRequest,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub kind: ArtifactKind,
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    GitBundle,
    Patch,
    File,
}

/// Un blob que viaja aparte, referenciado por `sha256`. Si lleva `omitted`, sus bytes NO viajan.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Attachment {
    /// `att:` + 16 primeros hex del `sha256`.
    pub id: String,
    pub kind: AttachmentKind,
    pub sha256: String,
    pub bytes: u64,
    /// `true` si se buscaron secretos en el contenido. Un `git_bundle` va comprimido y no se escanea.
    pub scanned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omitted: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Truncated {
    pub field: String,
    pub original: u64,
    /// `chars` o `items`.
    pub unit: String,
}

/// El documento tal como viaja. No se construye ni se modifica desde fuera: ver [`ContextPackage`].
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Wire {
    pub schema_version: u32,
    pub package_id: String,
    pub created_at_ms: i64,
    pub source: Source,
    pub objective: String,
    pub decisions: Vec<String>,
    pub constraints: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_summary: Option<String>,
    /// Siempre presente: `null` solo con `revision_absent_reason`.
    pub revision: Option<Revision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_absent_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uncommitted: Option<Uncommitted>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_results: Option<TestResults>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<Artifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub truncated: Vec<Truncated>,
    /// Cuántos valores se ocultaron al redactar.
    pub redactions: u32,
    /// Campos opcionales de una versión posterior de v1: se conservan y cuentan para la identidad, no se interpretan.
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Un ContextPackage v1 válido e inmutable. Solo nace de [`build`] o de [`parse`]; no hay forma de cambiarlo después, y la
/// forma canónica con la que se calculó su identidad es la que se vuelve a emitir.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextPackage {
    w: Wire,
    canonical: String,
}

impl Deref for ContextPackage {
    type Target = Wire;

    fn deref(&self) -> &Wire {
        &self.w
    }
}

/// Lo que registra un receptor al aceptar un paquete. Va APARTE: el `source` del paquete no se reescribe (D44).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub package_id: String,
    pub received_by: String,
    pub received_at_ms: i64,
}

impl ContextPackage {
    /// De dónde sale el paquete: lo fijó el Core al crearlo y quien lo recibe no puede cambiarlo.
    pub fn source(&self) -> &Source {
        &self.w.source
    }

    pub fn id(&self) -> &str {
        &self.w.package_id
    }

    /// La forma exacta (canónica) que se exporta y sobre la que se calculó `package_id`.
    pub fn to_json(&self) -> &str {
        &self.canonical
    }

    pub fn receipt(&self, received_by: &str, received_at_ms: i64) -> Receipt {
        Receipt { package_id: self.w.package_id.clone(), received_by: received_by.to_string(), received_at_ms }
    }

    /// El mensaje con que arranca el siguiente Attempt: instrucciones de uso y el paquete. Es lo que se probó en los
    /// experimentos de LXO-132 (10/10 en Claude y en Codex).
    pub fn continuation_prompt(&self) -> String {
        format!(
            "Continúas una tarea de ingeniería que empezó otro agente (proveedor `{}`). Solo tienes el contexto que sigue. \
             La evidencia de `revision` se verifica con `head_tree` y `diff_sha256`; lo que no puedas verificar, dilo como no verificado. \
             Donde ves `[redactado]` o un adjunto `omitted`, el valor se retiró a propósito.\n\nCONTEXTO:\n{}\n",
            self.w.source.provider, self.canonical
        )
    }

    /// Comprueba los bytes recibidos contra los adjuntos declarados: cada uno presente, con su `sha256` y su tamaño.
    /// Los omitidos no se esperan (y si llegan, es un error: no debían viajar).
    pub fn verify_attachments(&self, blobs: &BTreeMap<String, Vec<u8>>) -> Res<()> {
        let mut declared = BTreeSet::new();
        for a in &self.w.attachments {
            declared.insert(a.id.as_str());
            match (&a.omitted, blobs.get(&a.id)) {
                (Some(_), Some(_)) => return Err(PackageError::new(PackageErrorCode::AttachmentMismatch, format!("{}: el adjunto estaba omitido y llegó igualmente", a.id))),
                (Some(_), None) => {}
                (None, None) => return Err(PackageError::new(PackageErrorCode::AttachmentMismatch, format!("{}: falta el adjunto", a.id))),
                (None, Some(b)) => {
                    if b.len() as u64 != a.bytes || sha256_hex(b) != a.sha256 {
                        return Err(PackageError::new(PackageErrorCode::AttachmentMismatch, format!("{}: no coincide con su sha256 o su tamaño", a.id)));
                    }
                }
            }
        }
        if let Some(extra) = blobs.keys().find(|k| !declared.contains(k.as_str())) {
            return Err(PackageError::new(PackageErrorCode::AttachmentMismatch, format!("{extra}: adjunto que el paquete no declara")));
        }
        Ok(())
    }
}

// ── Validación (la comparten build y parse) ─────────────────────────────────────────────────────────────────────────────

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn check_sha256(field: &str, v: &str) -> Res<()> {
    if v.len() == 64 && is_hex(v) {
        Ok(())
    } else {
        Err(PackageError::invalid(format!("{field}: un sha256 son 64 caracteres hexadecimales en minúsculas")))
    }
}

fn check_commit(field: &str, v: &str) -> Res<()> {
    if (7..=64).contains(&v.len()) && is_hex(v) {
        Ok(())
    } else {
        Err(PackageError::invalid(format!("{field}: un sha de git son de 7 a 64 caracteres hexadecimales en minúsculas")))
    }
}

fn check_fp(field: &str, v: &str) -> Res<()> {
    match v.strip_prefix("fp:") {
        Some(h) if h.len() == 8 && is_hex(h) => Ok(()),
        _ => Err(PackageError::invalid(format!("{field}: es una huella `fp:` + 8 hex, no el identificador"))),
    }
}

fn check_text(field: &str, v: &str, max: usize, multiline: bool, allow_empty: bool) -> Res<()> {
    if !allow_empty && v.trim().is_empty() {
        return Err(PackageError::invalid(format!("{field}: no puede estar vacío")));
    }
    if v.chars().count() > max {
        return Err(PackageError::new(PackageErrorCode::TooLarge, format!("{field}: de más de {max} caracteres")));
    }
    if v.chars().any(|c| c.is_control() && !(multiline && (c == '\n' || c == '\t'))) {
        return Err(PackageError::invalid(format!("{field}: tiene caracteres de control")));
    }
    Ok(())
}

fn check_id(field: &str, v: &str) -> Res<()> {
    if v.is_empty() || v.chars().count() > MAX_ID_CHARS || v.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(PackageError::invalid(format!("{field}: es un identificador sin espacios de hasta {MAX_ID_CHARS} caracteres")));
    }
    if contains_secret(v) {
        return Err(PackageError::new(PackageErrorCode::SecretDetected, format!("{field}: tiene forma de credencial")));
    }
    Ok(())
}

/// Ruta relativa al repositorio: sin `..`, sin unidad, sin URL, sin secretos.
fn check_rel_path(field: &str, p: &str) -> Res<()> {
    check_text(field, p, MAX_PATH_CHARS, false, false)?;
    let drive = p.len() >= 2 && p.as_bytes()[1] == b':' && p.as_bytes()[0].is_ascii_alphabetic();
    if p.starts_with(['/', '\\']) || drive || p.contains("://") || p.split(['/', '\\']).any(|s| s == "..") {
        return Err(PackageError::invalid(format!("{field}: es una ruta relativa al repositorio (sin `..`, sin unidad, sin URL)")));
    }
    if contains_secret(p) {
        return Err(PackageError::new(PackageErrorCode::SecretDetected, format!("{field}: tiene forma de credencial")));
    }
    Ok(())
}

fn check_artifact(a: &Artifact) -> Res<()> {
    check_text("artifacts.uri", &a.uri, MAX_PATH_CHARS, false, false)?;
    if contains_secret(&a.uri) {
        return Err(PackageError::new(PackageErrorCode::SecretDetected, "artifacts.uri: un Artifact no guarda secretos"));
    }
    match a.kind {
        ArtifactKind::Commit => check_commit("artifacts.uri", &a.uri)?,
        ArtifactKind::PullRequest => {
            let host = a.uri.strip_prefix("https://").map(|r| r.split('/').next().unwrap_or("")).unwrap_or("");
            if host.is_empty() || host.contains('@') || a.uri.contains(char::is_whitespace) {
                return Err(PackageError::invalid("artifacts.uri: una PR es una URL https:// sin usuario ni contraseña"));
            }
        }
        ArtifactKind::Report | ArtifactKind::LastMessage | ArtifactKind::File => check_rel_path("artifacts.uri", &a.uri)?,
    }
    if let Some(h) = &a.sha256 {
        check_sha256("artifacts.sha256", h)?;
    }
    Ok(())
}

fn attachment_id(sha256: &str) -> String {
    format!("att:{}", &sha256[..16])
}

/// Todas las reglas del schema sobre un documento ya tipado. `build` las aplica a lo que produce y `parse` a lo que recibe.
fn validate(w: &Wire) -> Res<()> {
    if w.schema_version != SCHEMA_VERSION {
        return Err(PackageError::new(PackageErrorCode::UnsupportedVersion, format!("schema_version {} (esta build entiende la {SCHEMA_VERSION})", w.schema_version)));
    }
    if w.created_at_ms < 0 {
        return Err(PackageError::invalid("created_at_ms: no puede ser negativo"));
    }
    let s = &w.source;
    for (f, v) in [("source.project_id", &s.project_id), ("source.task_id", &s.task_id), ("source.attempt_id", &s.attempt_id)] {
        check_id(f, v)?;
    }
    if s.provider.is_empty() || s.provider.len() > 64 || !s.provider.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(PackageError::invalid("source.provider: `[a-z0-9-]`, de 1 a 64 caracteres"));
    }
    if let Some(p) = &s.provider_session {
        check_fp("source.provider_session", p)?;
    }
    check_fp("source.host", &s.host)?;

    check_text("objective", &w.objective, MAX_OBJECTIVE_CHARS, true, false)?;
    for (f, list) in [("decisions", &w.decisions), ("constraints", &w.constraints)] {
        if list.len() > MAX_LIST_ITEMS {
            return Err(PackageError::new(PackageErrorCode::TooLarge, format!("{f}: más de {MAX_LIST_ITEMS} elementos")));
        }
        for x in list {
            check_text(f, x, MAX_ITEM_CHARS, true, false)?;
        }
    }
    if let Some(t) = &w.thread_summary {
        check_text("thread_summary", t, MAX_THREAD_SUMMARY_CHARS, true, false)?;
    }

    match (&w.revision, &w.revision_absent_reason) {
        (None, None) => return Err(PackageError::invalid("revision: es `null` solo con `revision_absent_reason`")),
        (Some(_), Some(_)) => return Err(PackageError::invalid("revision_absent_reason: solo con `revision` null")),
        (None, Some(r)) => check_text("revision_absent_reason", r, MAX_REASON_CHARS, false, false)?,
        (Some(r), None) => {
            check_commit("revision.base_commit", &r.base_commit)?;
            check_commit("revision.head_commit", &r.head_commit)?;
            check_commit("revision.head_tree", &r.head_tree)?;
            if let Some(b) = &r.branch {
                check_text("revision.branch", b, MAX_BRANCH_CHARS, false, false)?;
            }
            if r.files.len() > MAX_FILES {
                return Err(PackageError::new(PackageErrorCode::TooLarge, format!("revision.files: más de {MAX_FILES} archivos")));
            }
            for f in &r.files {
                check_rel_path("revision.files.path", &f.path)?;
            }
            if let Some(h) = &r.diff_sha256 {
                check_sha256("revision.diff_sha256", h)?;
            }
        }
    }

    if let Some(t) = &w.test_results {
        check_text("test_results.command", &t.command, MAX_COMMAND_CHARS, false, false)?;
    }
    if w.artifacts.len() > MAX_ARTIFACTS {
        return Err(PackageError::new(PackageErrorCode::TooLarge, format!("artifacts: más de {MAX_ARTIFACTS}")));
    }
    w.artifacts.iter().try_for_each(check_artifact)?;

    // Adjuntos: identidad derivada del hash, sin repetidos, con topes.
    if w.attachments.len() > MAX_ATTACHMENTS {
        return Err(PackageError::new(PackageErrorCode::TooLarge, format!("attachments: más de {MAX_ATTACHMENTS}")));
    }
    let (mut ids, mut total) = (BTreeSet::new(), 0u64);
    for a in &w.attachments {
        check_sha256("attachments.sha256", &a.sha256)?;
        if a.id != attachment_id(&a.sha256) {
            return Err(PackageError::invalid(format!("{}: el id de un adjunto es `att:` + 16 hex de su sha256", a.id)));
        }
        if !ids.insert(a.id.as_str()) {
            return Err(PackageError::invalid(format!("{}: adjunto repetido", a.id)));
        }
        if a.bytes > MAX_ATTACHMENT_BYTES as u64 {
            return Err(PackageError::new(PackageErrorCode::TooLarge, format!("{}: más de {MAX_ATTACHMENT_BYTES} bytes", a.id)));
        }
        if a.omitted.as_deref().is_some_and(|o| o != OMITTED_SECRET) {
            return Err(PackageError::invalid(format!("{}: `omitted` solo admite `{OMITTED_SECRET}`", a.id)));
        }
        total += a.bytes;
    }
    if total > MAX_ATTACHMENTS_TOTAL_BYTES as u64 {
        return Err(PackageError::new(PackageErrorCode::TooLarge, format!("attachments: más de {MAX_ATTACHMENTS_TOTAL_BYTES} bytes en total")));
    }
    if let Some(u) = &w.uncommitted {
        if u.untracked.len() > MAX_UNTRACKED {
            return Err(PackageError::new(PackageErrorCode::TooLarge, format!("uncommitted.untracked: más de {MAX_UNTRACKED} archivos")));
        }
        let refs = u.staged_patch.iter().chain(u.unstaged_patch.iter()).chain(u.untracked.iter().filter_map(|x| x.attachment.as_ref()));
        for r in refs {
            if !ids.contains(r.as_str()) {
                return Err(PackageError::invalid(format!("uncommitted: referencia el adjunto {r}, que el paquete no declara")));
            }
        }
        for x in &u.untracked {
            check_rel_path("uncommitted.untracked.path", &x.path)?;
            check_sha256("uncommitted.untracked.sha256", &x.sha256)?;
        }
    }

    for t in &w.truncated {
        if t.field.is_empty() || t.field.len() > 64 || !matches!(t.unit.as_str(), "chars" | "items") {
            return Err(PackageError::invalid("truncated: `field` y `unit` (`chars` o `items`)"));
        }
    }
    Ok(())
}

fn has_float(v: &Value) -> bool {
    match v {
        Value::Number(n) => !(n.is_i64() || n.is_u64()),
        Value::Array(a) => a.iter().any(has_float),
        Value::Object(o) => o.values().any(has_float),
        _ => false,
    }
}

/// Primer texto del documento con forma de credencial, con su ruta.
fn find_secret(v: &Value, path: &str) -> Option<String> {
    match v {
        Value::String(s) => contains_secret(s).then(|| path.to_string()),
        Value::Array(a) => a.iter().enumerate().find_map(|(i, x)| find_secret(x, &format!("{path}/{i}"))),
        Value::Object(o) => o.iter().find_map(|(k, x)| if path.is_empty() && k == "package_id" { None } else { find_secret(x, &format!("{path}/{k}")) }),
        _ => None,
    }
}

// ── parse ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// El ÚNICO camino para aceptar un paquete que viene de fuera. Orden: tamaño → JSON → versión → campos requeridos →
/// identidad → tipos y reglas → secretos. Si algo falla, el paquete no existe: no inicia ningún Attempt.
pub fn parse(json: &str) -> Res<ContextPackage> {
    if json.len() > MAX_PACKAGE_BYTES {
        return Err(PackageError::new(PackageErrorCode::TooLarge, format!("el paquete pesa más de {MAX_PACKAGE_BYTES} bytes (sin adjuntos)")));
    }
    let v: Value = serde_json::from_str(json).map_err(|e| PackageError::new(PackageErrorCode::InvalidJson, e.to_string()))?;
    let o = v.as_object().ok_or_else(|| PackageError::new(PackageErrorCode::InvalidJson, "el paquete es un objeto JSON"))?;
    // La versión primero: un paquete de una versión que no entendemos no se interpreta con las reglas de esta.
    match o.get("schema_version") {
        None => return Err(PackageError::new(PackageErrorCode::MissingField, "schema_version")),
        Some(x) if x.as_u64() != Some(SCHEMA_VERSION as u64) => {
            return Err(PackageError::new(PackageErrorCode::UnsupportedVersion, format!("schema_version {x} (esta build entiende la {SCHEMA_VERSION})")))
        }
        Some(_) => {}
    }
    if let Some(missing) = REQUIRED.iter().find(|k| !o.contains_key(**k)) {
        return Err(PackageError::new(PackageErrorCode::MissingField, *missing));
    }
    if has_float(&v) {
        return Err(PackageError::invalid("el paquete solo admite números enteros"));
    }
    let declared = o["package_id"].as_str().ok_or_else(|| PackageError::invalid("package_id: es texto `sha256:` + 64 hex"))?;
    match declared.strip_prefix("sha256:") {
        Some(h) if h.len() == 64 && is_hex(h) => {}
        _ => return Err(PackageError::invalid("package_id: es `sha256:` + 64 hex")),
    }
    if declared != package_id_of(&v) {
        return Err(PackageError::new(PackageErrorCode::IdMismatch, "package_id no coincide con el contenido: el paquete se alteró"));
    }
    let w: Wire = serde_json::from_value(v.clone()).map_err(|e| PackageError::invalid(e.to_string()))?;
    validate(&w)?;
    if let Some(p) = find_secret(&v, "") {
        return Err(PackageError::new(PackageErrorCode::SecretDetected, format!("{p}: tiene forma de credencial; un paquete llega ya redactado")));
    }
    Ok(ContextPackage { canonical: canonical(&v), w })
}

// ── build ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

pub enum RevisionInput {
    Git(Revision),
    /// El Attempt no tiene repositorio: el motivo consta en el paquete.
    Absent(String),
}

pub struct UntrackedInput {
    pub path: String,
    pub data: Vec<u8>,
}

#[derive(Default)]
pub struct UncommittedInput {
    pub staged_patch: Option<Vec<u8>>,
    pub unstaged_patch: Option<Vec<u8>>,
    pub untracked: Vec<UntrackedInput>,
}

/// Lo que el Core sabe al crear un paquete. Los identificadores locales (`provider_session`, `host`) entran CRUDOS y salen
/// como huella; el texto entra sin redactar y sale redactado.
pub struct NewPackage {
    pub created_at_ms: i64,
    pub project_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub provider: String,
    pub provider_session: Option<String>,
    pub host: String,
    pub objective: String,
    pub decisions: Vec<String>,
    pub constraints: Vec<String>,
    pub thread_summary: Option<String>,
    pub revision: RevisionInput,
    pub uncommitted: Option<UncommittedInput>,
    pub test_results: Option<TestResults>,
    pub artifacts: Vec<Artifact>,
    /// `git bundle` con los commits que el receptor no tiene (los no publicados).
    pub bundle: Option<Vec<u8>>,
}

/// El paquete y los bytes de sus adjuntos (solo los que viajan; los omitidos no están).
#[derive(Debug)]
pub struct Built {
    pub package: ContextPackage,
    pub blobs: BTreeMap<String, Vec<u8>>,
}

#[derive(Default)]
struct Ctx {
    redactions: u32,
    truncated: Vec<Truncated>,
    attachments: Vec<Attachment>,
    blobs: BTreeMap<String, Vec<u8>>,
    total_bytes: usize,
}

impl Ctx {
    /// Redacta y acota un texto. Primero se redacta y después se corta: un secreto partido por el tope no deja un prefijo.
    fn text(&mut self, field: &str, s: &str, max: usize, multiline: bool) -> Res<String> {
        if s.chars().any(|c| c.is_control() && !(multiline && (c == '\n' || c == '\t'))) {
            return Err(PackageError::invalid(format!("{field}: tiene caracteres de control")));
        }
        let (red, n) = redact(s);
        self.redactions += n as u32;
        Ok(self.cap(field, red, max))
    }

    fn cap(&mut self, field: &str, s: String, max: usize) -> String {
        let n = s.chars().count();
        if n <= max {
            return s;
        }
        self.truncated.push(Truncated { field: field.to_string(), original: n as u64, unit: "chars".into() });
        s.chars().take(max).collect()
    }

    fn list(&mut self, field: &str, items: &[String]) -> Res<Vec<String>> {
        let kept = &items[..items.len().min(MAX_LIST_ITEMS)];
        if items.len() > kept.len() {
            self.truncated.push(Truncated { field: field.to_string(), original: items.len() as u64, unit: "items".into() });
        }
        kept.iter().map(|x| self.text(field, x, MAX_ITEM_CHARS, true)).collect()
    }

    /// Registra un adjunto. Un contenido de texto con secreto NO viaja (D42): consta como `omitted`. Un `git_bundle` va
    /// comprimido y no se puede escanear: viaja con `scanned: false`.
    fn attach(&mut self, kind: AttachmentKind, data: Vec<u8>) -> Res<String> {
        if data.len() > MAX_ATTACHMENT_BYTES {
            return Err(PackageError::new(PackageErrorCode::TooLarge, format!("un adjunto de {} bytes supera el máximo de {MAX_ATTACHMENT_BYTES}", data.len())));
        }
        let sha = sha256_hex(&data);
        let id = attachment_id(&sha);
        if self.attachments.iter().any(|a| a.id == id) {
            return Ok(id);
        }
        let text = (kind != AttachmentKind::GitBundle).then(|| std::str::from_utf8(&data).ok()).flatten();
        let scanned = text.is_some();
        let omitted = text.is_some_and(contains_secret).then(|| OMITTED_SECRET.to_string());
        if omitted.is_none() {
            self.total_bytes += data.len();
            if self.total_bytes > MAX_ATTACHMENTS_TOTAL_BYTES {
                return Err(PackageError::new(PackageErrorCode::TooLarge, format!("los adjuntos superan {MAX_ATTACHMENTS_TOTAL_BYTES} bytes en total")));
            }
            self.blobs.insert(id.clone(), data.clone());
        }
        self.attachments.push(Attachment { id: id.clone(), kind, sha256: sha, bytes: data.len() as u64, scanned, omitted });
        Ok(id)
    }
}

fn build_revision(ctx: &mut Ctx, r: Revision) -> Res<Revision> {
    let branch = r.branch.map(|b| ctx.text("revision.branch", &b, MAX_BRANCH_CHARS, false)).transpose()?;
    let total = r.files.len();
    let files: Vec<FileChange> = r.files.into_iter().take(MAX_FILES).collect();
    if total > files.len() {
        ctx.truncated.push(Truncated { field: "revision.files".into(), original: total as u64, unit: "items".into() });
    }
    // Una ruta o un commit con forma de credencial no se redacta (dejaría de ser una ruta): se rechaza al validar.
    Ok(Revision { branch, files, ..r })
}

/// Crea un paquete: redacta, acota, adjunta, calcula la identidad y se valida a sí mismo con las mismas reglas que `parse`.
pub fn build(n: NewPackage) -> Res<Built> {
    let mut ctx = Ctx::default();
    let objective = ctx.text("objective", &n.objective, MAX_OBJECTIVE_CHARS, true)?;
    let decisions = ctx.list("decisions", &n.decisions)?;
    let constraints = ctx.list("constraints", &n.constraints)?;
    let thread_summary = n.thread_summary.as_deref().map(|t| ctx.text("thread_summary", t, MAX_THREAD_SUMMARY_CHARS, true)).transpose()?;
    let (revision, revision_absent_reason) = match n.revision {
        RevisionInput::Git(r) => (Some(build_revision(&mut ctx, r)?), None),
        RevisionInput::Absent(reason) => (None, Some(ctx.text("revision_absent_reason", &reason, MAX_REASON_CHARS, false)?)),
    };
    let test_results = n
        .test_results
        .map(|t| Ok::<_, PackageError>(TestResults { command: ctx.text("test_results.command", &t.command, MAX_COMMAND_CHARS, false)?, ..t }))
        .transpose()?;

    if let Some(b) = n.bundle {
        ctx.attach(AttachmentKind::GitBundle, b)?;
    }
    let uncommitted = match n.uncommitted {
        None => None,
        Some(u) => {
            let staged_patch = u.staged_patch.map(|d| ctx.attach(AttachmentKind::Patch, d)).transpose()?;
            let unstaged_patch = u.unstaged_patch.map(|d| ctx.attach(AttachmentKind::Patch, d)).transpose()?;
            let total = u.untracked.len();
            let mut untracked = vec![];
            for x in u.untracked.into_iter().take(MAX_UNTRACKED) {
                let (sha256, bytes) = (sha256_hex(&x.data), x.data.len() as u64);
                let attachment = Some(ctx.attach(AttachmentKind::File, x.data)?);
                untracked.push(Untracked { path: x.path, sha256, bytes, attachment });
            }
            if total > untracked.len() {
                ctx.truncated.push(Truncated { field: "uncommitted.untracked".into(), original: total as u64, unit: "items".into() });
            }
            Some(Uncommitted { staged_patch, unstaged_patch, untracked })
        }
    };

    let total_artifacts = n.artifacts.len();
    let artifacts: Vec<Artifact> = n.artifacts.into_iter().take(MAX_ARTIFACTS).collect();
    if total_artifacts > artifacts.len() {
        ctx.truncated.push(Truncated { field: "artifacts".into(), original: total_artifacts as u64, unit: "items".into() });
    }

    let mut w = Wire {
        schema_version: SCHEMA_VERSION,
        package_id: String::new(),
        created_at_ms: n.created_at_ms,
        source: Source {
            project_id: n.project_id,
            task_id: n.task_id,
            attempt_id: n.attempt_id,
            provider: n.provider,
            provider_session: n.provider_session.as_deref().map(fingerprint),
            host: fingerprint(&n.host),
        },
        objective,
        decisions,
        constraints,
        thread_summary,
        revision,
        revision_absent_reason,
        uncommitted,
        test_results,
        artifacts,
        attachments: std::mem::take(&mut ctx.attachments),
        truncated: std::mem::take(&mut ctx.truncated),
        redactions: ctx.redactions,
        extra: BTreeMap::new(),
    };
    validate(&w)?;
    seal(&mut w)?;
    // Sin sitio: se recorta la lista de archivos (lo más voluminoso) a la mitad hasta que quepa, y consta en `truncated`.
    while sealed_len(&w)? > MAX_PACKAGE_BYTES {
        let Some(r) = w.revision.as_mut().filter(|r| !r.files.is_empty()) else {
            return Err(PackageError::new(PackageErrorCode::TooLarge, format!("el paquete pesa más de {MAX_PACKAGE_BYTES} bytes incluso sin la lista de archivos")));
        };
        let original = w.truncated.iter().find(|t| t.field == "revision.files").map(|t| t.original).unwrap_or(r.files.len() as u64);
        r.files.truncate(r.files.len() / 2);
        w.truncated.retain(|t| t.field != "revision.files");
        w.truncated.push(Truncated { field: "revision.files".into(), original, unit: "items".into() });
    }
    seal(&mut w)?;
    let value = serde_json::to_value(&w).map_err(|e| PackageError::new(PackageErrorCode::InvalidJson, e.to_string()))?;
    Ok(Built { package: ContextPackage { canonical: canonical(&value), w }, blobs: std::mem::take(&mut ctx.blobs) })
}

fn sealed_len(w: &Wire) -> Res<usize> {
    let mut c = w.clone();
    seal(&mut c)?;
    let v = serde_json::to_value(&c).map_err(|e| PackageError::new(PackageErrorCode::InvalidJson, e.to_string()))?;
    Ok(canonical(&v).len())
}

/// Calcula `package_id` sobre el contenido actual y lo fija.
fn seal(w: &mut Wire) -> Res<()> {
    w.package_id = String::new();
    let v = serde_json::to_value(&*w).map_err(|e| PackageError::new(PackageErrorCode::InvalidJson, e.to_string()))?;
    w.package_id = package_id_of(&v);
    Ok(())
}
