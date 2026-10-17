//! Attention (slice G, LXO-87): modelo autoritativo y ciclo de vida, lado del **almacén**.
//!
//! Solo sabe guardar, deduplicar y resolver las filas de `attention_items` (migración
//! `006_attention`). No conoce `orch`, ni qué Events o State generan una Attention (eso son las reglas
//! de LXO-88), ni cómo se consulta (LXO-89). La dirección sigue siendo `orch -> store`. Contrato,
//! diagrama de estados y ejemplos: `docs/core/ATTENTION.md`.
//!
//! # Garantías de este módulo
//! * **Identidad determinista.** `fingerprint` = SHA-256 del hecho (categoría + destino + subject);
//!   `id` = derivado de `(fingerprint, occurrence)`. Mismo historial ⇒ mismos ids al reconstruir.
//! * **Deduplicación.** Una sola ocurrencia ACTIVA por `fingerprint`: levantar el mismo hecho devuelve
//!   la activa sin modificarla ([`Raised::Existing`]). La base lo impone con un índice único parcial.
//! * **Resolver no borra.** [`attention_resolve_in`] solo hace `active → resolved`; es idempotente y
//!   no toca `events`. La fila resuelta es historia: terminal, inmutable, no se borra (triggers).
//! * **Destino lógico.** `(TargetKind, id)`: una identidad del Core, nunca una ruta. Se valida aquí y
//!   en la base.
//! * **Sin textos de interfaz.** Solo códigos estables (`snake_case` ASCII) y `facts` estructurados.
//! * **Tiempo fijado por quien llama** (`at`): ninguna escritura llama a `now()`.
//!
//! Las variantes `*_in` corren DENTRO de la transacción de quien llama (p. ej. junto al INSERT del
//! evento que origina la Attention, como hace el registro de proyectos); los métodos de [`Store`] son
//! la vía de una sola operación.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use super::authority::sha256_hex;
use super::error::{StoreError, StoreResult};
use super::Store;

/// Tamaño máximo de `facts`, en BYTES de su texto JSON.
pub const MAX_FACTS_BYTES: usize = 2048;
const MAX_ID_CHARS: usize = 200;

fn bad<T>(m: impl Into<String>) -> StoreResult<T> {
    Err(StoreError::InvalidAttention(m.into()))
}

/// Qué necesita la persona. Conjunto CERRADO: ampliarlo exige decisión explícita (ADR + migración de
/// CHECK), no un valor nuevo en un cliente.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionCategory {
    /// Un agente espera una respuesta.
    Question,
    /// Algo espera una aprobación humana.
    Approval,
    /// Un resultado está listo para revisar o integrar.
    ReviewReady,
    /// Un conflicto impide avanzar.
    Conflict,
    /// Un intento terminó con error.
    Failed,
    /// El entorno impide trabajar (herramienta, credencial, ruta…).
    EnvironmentBlocked,
    /// Una política o heurística avisa de un riesgo.
    Risk,
}

impl AttentionCategory {
    pub const ALL: [AttentionCategory; 7] = [
        AttentionCategory::Question,
        AttentionCategory::Approval,
        AttentionCategory::ReviewReady,
        AttentionCategory::Conflict,
        AttentionCategory::Failed,
        AttentionCategory::EnvironmentBlocked,
        AttentionCategory::Risk,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AttentionCategory::Question => "question",
            AttentionCategory::Approval => "approval",
            AttentionCategory::ReviewReady => "review_ready",
            AttentionCategory::Conflict => "conflict",
            AttentionCategory::Failed => "failed",
            AttentionCategory::EnvironmentBlocked => "environment_blocked",
            AttentionCategory::Risk => "risk",
        }
    }

    pub fn parse(s: &str) -> StoreResult<AttentionCategory> {
        AttentionCategory::ALL.into_iter().find(|c| c.as_str() == s).map_or_else(|| bad(format!("categoría desconocida: {s}")), Ok)
    }
}

/// Urgencia normalizada, fijada por el Core (nunca derivada en un cliente). Orden total:
/// `Critical` es la más urgente.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
}

impl Severity {
    pub const ALL: [Severity; 4] = [Severity::Critical, Severity::High, Severity::Medium, Severity::Low];

    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::High => "high",
            Severity::Medium => "medium",
            Severity::Low => "low",
        }
    }

    /// 0 = la más urgente. Es el orden de [`Severity::ALL`].
    pub fn rank(self) -> u8 {
        match self {
            Severity::Critical => 0,
            Severity::High => 1,
            Severity::Medium => 2,
            Severity::Low => 3,
        }
    }

    pub fn parse(s: &str) -> StoreResult<Severity> {
        Severity::ALL.into_iter().find(|v| v.as_str() == s).map_or_else(|| bad(format!("severidad desconocida: {s}")), Ok)
    }
}

/// Estado del ciclo de vida. No hay `snoozed`: posponer es política por persona/dispositivo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionStatus {
    Active,
    Resolved,
}

impl AttentionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            AttentionStatus::Active => "active",
            AttentionStatus::Resolved => "resolved",
        }
    }

    pub fn parse(s: &str) -> StoreResult<AttentionStatus> {
        match s {
            "active" => Ok(AttentionStatus::Active),
            "resolved" => Ok(AttentionStatus::Resolved),
            other => bad(format!("estado desconocido: {other}")),
        }
    }
}

/// Por qué dejó de requerir atención (solo existe en filas `resolved`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Resolution {
    /// Una persona (o su agente delegado) actuó.
    Acted,
    /// La condición que la originó dejó de cumplirse sin acción directa.
    ConditionCleared,
    /// Otra Attention o un hecho posterior la sustituye.
    Superseded,
}

impl Resolution {
    pub const ALL: [Resolution; 3] = [Resolution::Acted, Resolution::ConditionCleared, Resolution::Superseded];

    pub fn as_str(self) -> &'static str {
        match self {
            Resolution::Acted => "acted",
            Resolution::ConditionCleared => "condition_cleared",
            Resolution::Superseded => "superseded",
        }
    }

    pub fn parse(s: &str) -> StoreResult<Resolution> {
        Resolution::ALL.into_iter().find(|r| r.as_str() == s).map_or_else(|| bad(format!("motivo de resolución desconocido: {s}")), Ok)
    }
}

/// A qué entidad lógica apunta una Attention: el vocabulario de `entity_kind` del Core, sin
/// `attention` (una Attention no apunta a otra). Se valida en Rust, sin CHECK en la base.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TargetKind {
    Project,
    Task,
    /// Run legacy del modelo actual.
    Run,
    SpawnRequest,
    Attempt,
    Thread,
    Worktree,
    Artifact,
    Review,
    Integration,
    Agent,
    Decision,
    Policy,
}

impl TargetKind {
    pub const ALL: [TargetKind; 13] = [
        TargetKind::Project,
        TargetKind::Task,
        TargetKind::Run,
        TargetKind::SpawnRequest,
        TargetKind::Attempt,
        TargetKind::Thread,
        TargetKind::Worktree,
        TargetKind::Artifact,
        TargetKind::Review,
        TargetKind::Integration,
        TargetKind::Agent,
        TargetKind::Decision,
        TargetKind::Policy,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            TargetKind::Project => "project",
            TargetKind::Task => "task",
            TargetKind::Run => "run",
            TargetKind::SpawnRequest => "spawn_request",
            TargetKind::Attempt => "attempt",
            TargetKind::Thread => "thread",
            TargetKind::Worktree => "worktree",
            TargetKind::Artifact => "artifact",
            TargetKind::Review => "review",
            TargetKind::Integration => "integration",
            TargetKind::Agent => "agent",
            TargetKind::Decision => "decision",
            TargetKind::Policy => "policy",
        }
    }

    pub fn parse(s: &str) -> StoreResult<TargetKind> {
        TargetKind::ALL.into_iter().find(|k| k.as_str() == s).map_or_else(|| bad(format!("tipo de destino desconocido: {s}")), Ok)
    }
}

/// Destino lógico: tipo + id estable del Core. Nunca una ruta (ver [`check_logical_id`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttentionTarget {
    pub kind: TargetKind,
    pub id: String,
}

impl AttentionTarget {
    pub fn new(kind: TargetKind, id: &str) -> StoreResult<AttentionTarget> {
        check_logical_id("destino", id)?;
        Ok(AttentionTarget { kind, id: id.to_string() })
    }
}

/// Una identidad lógica (destino, subject): 1–200 caracteres, sin caracteres de control y que NO
/// parezca una ruta (absoluta, de unidad, UNC, `~`, con `\` o con `..`). Lo mismo que impone la base.
fn check_logical_id(what: &str, id: &str) -> StoreResult<()> {
    let n = id.chars().count();
    if n == 0 || n > MAX_ID_CHARS || id.trim().is_empty() {
        return bad(format!("{what}: debe tener entre 1 y {MAX_ID_CHARS} caracteres"));
    }
    if id.chars().any(|c| c.is_control()) {
        return bad(format!("{what}: contiene caracteres de control"));
    }
    let mut chars = id.chars();
    let (first, second) = (chars.next(), chars.next());
    let drive = matches!((first, second), (Some(a), Some(':')) if a.is_ascii_alphabetic());
    if matches!(first, Some('/') | Some('~') | Some('\\')) || drive || id.contains('\\') || id.contains("..") {
        return bad(format!("{what}: «{id}» parece una ruta; la identidad es lógica, no un camino del disco"));
    }
    Ok(())
}

/// Un hecho que requiere atención, ya MATERIALIZADO: todo lo que lo identifica está fijado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewAttention {
    pub category: AttentionCategory,
    pub severity: Severity,
    pub target: AttentionTarget,
    pub project_id: Option<String>,
    pub run_id: Option<String>,
    /// Distingue hechos distintos de la misma categoría y destino (p. ej. dos preguntas de una tarea).
    pub subject: Option<String>,
    /// `events.id` (UUID v7) del evento que la origina, si aplica. Referencia blanda.
    pub source_event_id: Option<String>,
    pub correlation_id: Option<String>,
    /// Objeto JSON de datos estructurados (códigos e ids), como mucho [`MAX_FACTS_BYTES`] bytes.
    pub facts: String,
    /// ms epoch de creación, fijados por quien llama.
    pub at: i64,
}

impl NewAttention {
    /// Identidad del HECHO (no de la ocurrencia): no depende de la hora, la severidad, el origen ni
    /// los `facts`. Los campos van separados por `\0` (los ids no pueden contener controles) y
    /// `subject` lleva un marcador de presencia, así que ninguna combinación es ambigua.
    pub fn fingerprint(&self) -> String {
        let subject = match &self.subject {
            None => "n".to_string(),
            Some(s) => format!("s{s}"),
        };
        sha256_hex(format!("lixbon.attention.v1\0{}\0{}\0{}\0{subject}", self.category.as_str(), self.target.kind.as_str(), self.target.id).as_bytes())
    }

    /// Lo que la tabla también impone, ANTES de abrir ninguna transacción.
    pub fn check(&self) -> StoreResult<()> {
        check_logical_id("destino", &self.target.id)?;
        if let Some(s) = &self.subject {
            check_logical_id("subject", s)?;
        }
        for (what, v) in [("project_id", &self.project_id), ("run_id", &self.run_id), ("source_event_id", &self.source_event_id), ("correlation_id", &self.correlation_id)] {
            if v.as_deref() == Some("") {
                return bad(format!("{what} vacío"));
            }
        }
        if self.facts.len() > MAX_FACTS_BYTES {
            return bad(format!("facts de {} bytes (el máximo es {MAX_FACTS_BYTES})", self.facts.len()));
        }
        match serde_json::from_str::<serde_json::Value>(&self.facts) {
            Ok(serde_json::Value::Object(_)) => Ok(()),
            Ok(_) => bad("facts debe ser un objeto JSON"),
            Err(e) => bad(format!("facts no es JSON válido ({e})")),
        }
    }
}

/// `id` de la ocurrencia: determinista a partir del hecho y su número de ocurrencia.
fn derive_id(fingerprint: &str, occurrence: i64) -> String {
    let h = sha256_hex(format!("lixbon.attention.id.v1\0{fingerprint}\0{occurrence}").as_bytes());
    format!("att_{}", &h[..32])
}

/// Una fila leída de `attention_items`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttentionRow {
    pub id: String,
    pub fingerprint: String,
    pub occurrence: i64,
    pub category: AttentionCategory,
    pub severity: Severity,
    pub status: AttentionStatus,
    pub target: AttentionTarget,
    pub project_id: Option<String>,
    pub run_id: Option<String>,
    pub subject: Option<String>,
    pub source_event_id: Option<String>,
    pub correlation_id: Option<String>,
    /// Texto JSON de un objeto.
    pub facts: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub resolved_at: Option<i64>,
    pub resolution: Option<Resolution>,
}

/// Resultado de levantar un hecho.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Raised {
    /// Nueva ocurrencia activa.
    Created(AttentionRow),
    /// Ya había una activa para el mismo hecho: se devuelve tal cual, sin modificarla.
    Existing(AttentionRow),
}

/// Resultado de resolver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveOutcome {
    Resolved(AttentionRow),
    /// Ya estaba resuelta: no se reescribe nada (ni `resolved_at` ni el motivo).
    AlreadyResolved(AttentionRow),
    /// No existe ese id.
    Missing,
}

const COLS: &str = "id, fingerprint, occurrence, category, severity, status, target_kind, target_id, project_id, run_id, subject, source_event_id, correlation_id, facts, created_at, updated_at, resolved_at, resolution";

/// La fila tal como sale de SQLite, antes de validar sus códigos.
struct Raw {
    id: String,
    fingerprint: String,
    occurrence: i64,
    category: String,
    severity: String,
    status: String,
    target_kind: String,
    target_id: String,
    project_id: Option<String>,
    run_id: Option<String>,
    subject: Option<String>,
    source_event_id: Option<String>,
    correlation_id: Option<String>,
    facts: String,
    created_at: i64,
    updated_at: i64,
    resolved_at: Option<i64>,
    resolution: Option<String>,
}

impl Raw {
    fn read(r: &rusqlite::Row<'_>) -> rusqlite::Result<Raw> {
        Ok(Raw {
            id: r.get(0)?,
            fingerprint: r.get(1)?,
            occurrence: r.get(2)?,
            category: r.get(3)?,
            severity: r.get(4)?,
            status: r.get(5)?,
            target_kind: r.get(6)?,
            target_id: r.get(7)?,
            project_id: r.get(8)?,
            run_id: r.get(9)?,
            subject: r.get(10)?,
            source_event_id: r.get(11)?,
            correlation_id: r.get(12)?,
            facts: r.get(13)?,
            created_at: r.get(14)?,
            updated_at: r.get(15)?,
            resolved_at: r.get(16)?,
            resolution: r.get(17)?,
        })
    }

    fn into_row(self) -> StoreResult<AttentionRow> {
        Ok(AttentionRow {
            id: self.id,
            fingerprint: self.fingerprint,
            occurrence: self.occurrence,
            category: AttentionCategory::parse(&self.category)?,
            severity: Severity::parse(&self.severity)?,
            status: AttentionStatus::parse(&self.status)?,
            target: AttentionTarget { kind: TargetKind::parse(&self.target_kind)?, id: self.target_id },
            project_id: self.project_id,
            run_id: self.run_id,
            subject: self.subject,
            source_event_id: self.source_event_id,
            correlation_id: self.correlation_id,
            facts: self.facts,
            created_at: self.created_at,
            updated_at: self.updated_at,
            resolved_at: self.resolved_at,
            resolution: self.resolution.as_deref().map(Resolution::parse).transpose()?,
        })
    }
}

fn get(conn: &Connection, id: &str) -> StoreResult<Option<AttentionRow>> {
    let raw = conn.query_row(&format!("SELECT {COLS} FROM attention_items WHERE id = ?1"), [id], Raw::read).optional()?;
    raw.map(Raw::into_row).transpose()
}

fn active_by_fingerprint(conn: &Connection, fingerprint: &str) -> StoreResult<Option<AttentionRow>> {
    let raw = conn.query_row(&format!("SELECT {COLS} FROM attention_items WHERE fingerprint = ?1 AND status = 'active'"), [fingerprint], Raw::read).optional()?;
    raw.map(Raw::into_row).transpose()
}

/// Levanta un hecho dentro de la transacción de quien llama (p. ej. junto al evento que lo origina).
/// Si ya hay una ocurrencia activa del mismo hecho la devuelve sin tocarla; si no, crea la siguiente.
pub(crate) fn attention_raise_in(tx: &Transaction<'_>, n: &NewAttention) -> StoreResult<Raised> {
    n.check()?;
    let fingerprint = n.fingerprint();
    if let Some(row) = active_by_fingerprint(tx, &fingerprint)? {
        return Ok(Raised::Existing(row));
    }
    let occurrence: i64 = tx.query_row("SELECT COALESCE(MAX(occurrence), 0) + 1 FROM attention_items WHERE fingerprint = ?1", [&fingerprint], |r| r.get(0))?;
    let id = derive_id(&fingerprint, occurrence);
    tx.execute(
        "INSERT INTO attention_items (id, fingerprint, occurrence, category, severity, status, target_kind, target_id, project_id, run_id, subject, source_event_id, correlation_id, facts, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
        params![
            id,
            fingerprint,
            occurrence,
            n.category.as_str(),
            n.severity.as_str(),
            n.target.kind.as_str(),
            n.target.id,
            n.project_id,
            n.run_id,
            n.subject,
            n.source_event_id,
            n.correlation_id,
            n.facts,
            n.at
        ],
    )?;
    let row = get(tx, &id)?.ok_or_else(|| StoreError::InvalidAttention("la fila recién creada no se pudo leer".into()))?;
    Ok(Raised::Created(row))
}

/// Resuelve dentro de la transacción de quien llama. Solo `active → resolved`; resolver una ya
/// resuelta es un no-op que devuelve la fila original. `at` no puede ser anterior a la creación.
pub(crate) fn attention_resolve_in(tx: &Transaction<'_>, id: &str, resolution: Resolution, at: i64) -> StoreResult<ResolveOutcome> {
    let Some(row) = get(tx, id)? else {
        return Ok(ResolveOutcome::Missing);
    };
    if row.status == AttentionStatus::Resolved {
        return Ok(ResolveOutcome::AlreadyResolved(row));
    }
    if at < row.created_at {
        return bad(format!("{id}: no se puede resolver en {at}, antes de su creación ({})", row.created_at));
    }
    tx.execute(
        "UPDATE attention_items SET status = 'resolved', resolved_at = ?2, resolution = ?3, updated_at = ?2 WHERE id = ?1 AND status = 'active'",
        params![id, at, resolution.as_str()],
    )?;
    let row = get(tx, id)?.ok_or_else(|| StoreError::InvalidAttention("la fila resuelta no se pudo leer".into()))?;
    Ok(ResolveOutcome::Resolved(row))
}

impl Store {
    /// Levanta un hecho en UNA transacción ([`attention_raise_in`]).
    #[allow(dead_code)] // lo consumen las reglas de LXO-88; hasta entonces, las pruebas.
    pub fn attention_raise(&mut self, n: &NewAttention) -> StoreResult<Raised> {
        n.check()?;
        self.write(|tx| attention_raise_in(tx, n))
    }

    /// Resuelve en UNA transacción ([`attention_resolve_in`]).
    #[allow(dead_code)] // idem
    pub fn attention_resolve(&mut self, id: &str, resolution: Resolution, at: i64) -> StoreResult<ResolveOutcome> {
        self.write(|tx| attention_resolve_in(tx, id, resolution, at))
    }

    /// Una Attention por id (no es la API de consulta: esa es LXO-89).
    #[allow(dead_code)] // idem
    pub fn attention_get(&self, id: &str) -> StoreResult<Option<AttentionRow>> {
        self.read(|c| get(c, id))
    }
}
