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
//! * **Actualizar la activa.** [`attention_update_active_in`] cambia SOLO `severity` y/o `facts` (y
//!   `updated_at`) de una fila `active`, sin duplicarla; una `resolved` no se toca. Es el punto por el que
//!   las reglas de LXO-88 escalan o enriquecen un hecho ya levantado.
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

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use super::authority::sha256_hex;
use super::error::{StoreError, StoreResult};
use super::events::{DEFAULT_PAGE, MAX_PAGE};
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
        check_facts(&self.facts)
    }
}

/// `facts`: objeto JSON de como mucho [`MAX_FACTS_BYTES`] bytes (lo mismo que impone el CHECK).
fn check_facts(facts: &str) -> StoreResult<()> {
    if facts.len() > MAX_FACTS_BYTES {
        return bad(format!("facts de {} bytes (el máximo es {MAX_FACTS_BYTES})", facts.len()));
    }
    match serde_json::from_str::<serde_json::Value>(facts) {
        Ok(serde_json::Value::Object(_)) => Ok(()),
        Ok(_) => bad("facts debe ser un objeto JSON"),
        Err(e) => bad(format!("facts no es JSON válido ({e})")),
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

/// Clave inmutable de paginación de Attention. `created_at` nunca cambia y `id` desempata de forma estable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionCursorKey {
    pub created_at: i64,
    pub id: String,
}

/// Consulta de la lista activa de Attention. `scope_task_id`, cuando existe, es un límite obligatorio
/// del Store y siempre restringe a `target_kind='task'`; los filtros pedidos por el cliente se AND-ean.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AttentionQuery {
    pub after: Option<AttentionCursorKey>,
    pub limit: Option<usize>,
    pub project_id: Option<String>,
    pub target_kind: Option<TargetKind>,
    pub target_id: Option<String>,
    pub category: Option<AttentionCategory>,
    pub severity: Option<Severity>,
    pub scope_task_id: Option<String>,
}

/// Una página ordenada ascendentemente por `(created_at,id)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionPage {
    pub items: Vec<AttentionRow>,
    pub has_more: bool,
}

/// Resultado de levantar un hecho.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Raised {
    /// Nueva ocurrencia activa.
    Created(AttentionRow),
    /// Ya había una activa para el mismo hecho: se devuelve tal cual, sin modificarla.
    Existing(AttentionRow),
}

/// Qué se actualiza en una Attention ACTIVA: solo `severity` y `facts` (al menos uno), más `updated_at`.
/// Nada de la identidad, el destino, el contexto ni el origen se puede cambiar por aquí.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttentionUpdate {
    /// Nueva severidad, o `None` para conservar la actual.
    pub severity: Option<Severity>,
    /// Nuevos `facts` (objeto JSON de como mucho [`MAX_FACTS_BYTES`] bytes; REEMPLAZAN a los anteriores),
    /// o `None` para conservar los actuales.
    pub facts: Option<String>,
    /// ms epoch de la actualización, fijados por quien llama. No puede ser anterior a `created_at`.
    pub at: i64,
}

impl AttentionUpdate {
    /// Lo que la tabla también impone, ANTES de abrir ninguna transacción.
    pub fn check(&self) -> StoreResult<()> {
        if self.severity.is_none() && self.facts.is_none() {
            return bad("actualización vacía: indica severity, facts o ambos");
        }
        if let Some(facts) = &self.facts {
            check_facts(facts)?;
        }
        Ok(())
    }
}

/// Resultado de actualizar una Attention activa. Solo [`UpdateOutcome::Updated`] es éxito.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateOutcome {
    /// Se actualizó la fila activa (devuelve la fila ya actualizada).
    Updated(AttentionRow),
    /// La fila está resuelta: terminal e inmutable, no se escribe nada (devuelve la fila tal cual).
    AlreadyResolved(AttentionRow),
    /// No existe ese id.
    Missing,
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

/// Lee una Attention por id dentro de la transacción que proyecta un Event de dominio.
pub(crate) fn attention_get_in(conn: &Connection, id: &str) -> StoreResult<Option<AttentionRow>> {
    get(conn, id)
}

fn active_by_fingerprint(conn: &Connection, fingerprint: &str) -> StoreResult<Option<AttentionRow>> {
    let raw = conn.query_row(&format!("SELECT {COLS} FROM attention_items WHERE fingerprint = ?1 AND status = 'active'"), [fingerprint], Raw::read).optional()?;
    raw.map(Raw::into_row).transpose()
}

/// La ocurrencia MÁS RECIENTE de un hecho (la activa si la hay: una activa siempre es la de mayor `occurrence`),
/// o `None` si nunca se levantó. Lectura pura dentro de la transacción de quien llama: la usan las reglas de
/// LXO-88 para resolver o actualizar por hecho sin conocer el `id` y para no reaplicar una señal antigua.
pub(crate) fn attention_latest_in(tx: &Transaction<'_>, fingerprint: &str) -> StoreResult<Option<AttentionRow>> {
    let raw = tx
        .query_row(&format!("SELECT {COLS} FROM attention_items WHERE fingerprint = ?1 ORDER BY occurrence DESC LIMIT 1"), [fingerprint], Raw::read)
        .optional()?;
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

/// Actualiza `severity` y/o `facts` de una Attention ACTIVA dentro de la transacción de quien llama.
/// Cambia solo esos campos y `updated_at`; todo lo demás (identidad, destino, contexto, origen,
/// `created_at`) queda intacto. Una fila resuelta es terminal: se devuelve [`UpdateOutcome::AlreadyResolved`]
/// sin escribir nada. Todo se valida antes de escribir y el `UPDATE` es una sola sentencia, así que no
/// hay cambios parciales.
pub(crate) fn attention_update_active_in(tx: &Transaction<'_>, id: &str, u: &AttentionUpdate) -> StoreResult<UpdateOutcome> {
    u.check()?;
    let Some(row) = get(tx, id)? else {
        return Ok(UpdateOutcome::Missing);
    };
    if row.status == AttentionStatus::Resolved {
        return Ok(UpdateOutcome::AlreadyResolved(row));
    }
    if u.at < row.created_at {
        return bad(format!("{id}: no se puede actualizar en {}, antes de su creación ({})", u.at, row.created_at));
    }
    let severity = u.severity.unwrap_or(row.severity);
    let facts = u.facts.as_deref().unwrap_or(&row.facts);
    tx.execute("UPDATE attention_items SET severity = ?2, facts = ?3, updated_at = ?4 WHERE id = ?1 AND status = 'active'", params![id, severity.as_str(), facts, u.at])?;
    let row = get(tx, id)?.ok_or_else(|| StoreError::InvalidAttention("la fila actualizada no se pudo leer".into()))?;
    Ok(UpdateOutcome::Updated(row))
}

impl Store {
    /// Actualiza severity/facts de una Attention activa en UNA transacción ([`attention_update_active_in`]).
    #[allow(dead_code)] // lo consumen las reglas de LXO-88; hasta entonces, las pruebas.
    pub fn attention_update_active(&mut self, id: &str, u: &AttentionUpdate) -> StoreResult<UpdateOutcome> {
        u.check()?;
        self.write(|tx| attention_update_active_in(tx, id, u))
    }

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

    /// Lista solo filas activas, con filtros combinados y keyset ascendente por `(created_at,id)`.
    /// Las páginas son consultas de solo lectura; el scope de Agent queda como predicado obligatorio del SQL.
    pub fn attention_page(&self, query: &AttentionQuery) -> StoreResult<AttentionPage> {
        if query.after.as_ref().is_some_and(|key| key.created_at < 0 || key.id.is_empty()) {
            return bad("cursor de Attention inválido");
        }
        if let Some(limit) = query.limit {
            if limit == 0 {
                return bad("`limit` debe ser al menos 1");
            }
        }
        for (name, value) in [
            ("project_id", query.project_id.as_deref()),
            ("target_id", query.target_id.as_deref()),
            ("scope_task_id", query.scope_task_id.as_deref()),
        ] {
            if value.is_some_and(|value| value.is_empty() || value.chars().count() > MAX_ID_CHARS) {
                return bad(format!("`{name}` debe contener de 1 a {MAX_ID_CHARS} caracteres"));
            }
        }

        let limit = query.limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE);
        let mut conditions = vec!["status = 'active'".to_string()];
        let mut values: Vec<Value> = Vec::new();
        let mut bind_text = |column: &str, value: Option<&str>| {
            if let Some(value) = value {
                values.push(Value::Text(value.to_string()));
                conditions.push(format!("{column} = ?{}", values.len()));
            }
        };
        bind_text("project_id", query.project_id.as_deref());
        bind_text("target_id", query.target_id.as_deref());
        drop(bind_text);
        if let Some(kind) = query.target_kind {
            values.push(Value::Text(kind.as_str().into()));
            conditions.push(format!("target_kind = ?{}", values.len()));
        }
        if let Some(category) = query.category {
            values.push(Value::Text(category.as_str().into()));
            conditions.push(format!("category = ?{}", values.len()));
        }
        if let Some(severity) = query.severity {
            values.push(Value::Text(severity.as_str().into()));
            conditions.push(format!("severity = ?{}", values.len()));
        }
        if let Some(task) = query.scope_task_id.as_deref() {
            values.push(Value::Text(task.to_string()));
            conditions.push(format!("target_kind = 'task' AND target_id = ?{}", values.len()));
        }
        if let Some(after) = &query.after {
            values.push(Value::Integer(after.created_at));
            let created_at = values.len();
            values.push(Value::Text(after.id.clone()));
            let id = values.len();
            conditions.push(format!("(created_at > ?{created_at} OR (created_at = ?{created_at} AND id > ?{id}))"));
        }
        values.push(Value::Integer((limit + 1) as i64));
        let sql = format!(
            "SELECT {COLS} FROM attention_items WHERE {} ORDER BY created_at ASC, id ASC LIMIT ?{}",
            conditions.join(" AND "),
            values.len()
        );

        self.read(|connection| {
            let mut statement = connection.prepare(&sql)?;
            let raw = statement
                .query_map(params_from_iter(values.iter()), Raw::read)?
                .collect::<Result<Vec<_>, _>>()?;
            let mut items = raw.into_iter().map(Raw::into_row).collect::<StoreResult<Vec<_>>>()?;
            let has_more = items.len() > limit;
            items.truncate(limit);
            Ok(AttentionPage { items, has_more })
        })
    }

    /// Attention ACTIVA agrupada por proyecto y categoría (`None` = sin proyecto), solo lectura. Son las mismas
    /// filas que lista [`Store::attention_page`] con el filtro `project_id`, contadas por la base.
    pub fn attention_active_counts(&self) -> StoreResult<Vec<(Option<String>, AttentionCategory, u64)>> {
        self.read(|connection| {
            let mut statement = connection.prepare(
                "SELECT project_id, category, COUNT(*) FROM attention_items WHERE status = 'active' \
                 GROUP BY project_id, category ORDER BY project_id, category",
            )?;
            let raw = statement
                .query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            raw.into_iter().map(|(project, category, n)| Ok((project, AttentionCategory::parse(&category)?, n as u64))).collect()
        })
    }

    /// Las `limit` Attention ACTIVAS más urgentes, solo lectura y sin paginar: primero por severidad
    /// (`critical` > `high` > `medium` > `low`), después la más reciente y, a igualdad, por `id`. La usa la
    /// snapshot compacta (LXO-94) para sus elementos destacados; con `limit` 0 no consulta nada.
    pub fn attention_active_top(&self, limit: usize) -> StoreResult<Vec<AttentionRow>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT {COLS} FROM attention_items WHERE status = 'active' ORDER BY \
             CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, \
             created_at DESC, id ASC LIMIT ?1"
        );
        self.read(|connection| {
            let mut statement = connection.prepare(&sql)?;
            let raw = statement
                .query_map([limit as i64], Raw::read)?
                .collect::<Result<Vec<_>, _>>()?;
            raw.into_iter().map(Raw::into_row).collect()
        })
    }

    /// Lee un detalle respetando el límite autenticado del Agent, si corresponde.
    /// Las filas resueltas siguen disponibles como historial de su mismo scope.
    pub fn attention_get_scoped(&self, id: &str, scope_task_id: Option<&str>) -> StoreResult<Option<AttentionRow>> {
        self.read(|connection| {
            let Some(row) = get(connection, id)? else { return Ok(None) };
            if scope_task_id.is_some_and(|task| row.target.kind != TargetKind::Task || row.target.id != task) {
                return Ok(None);
            }
            Ok(Some(row))
        })
    }
}
