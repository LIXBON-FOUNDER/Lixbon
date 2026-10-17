//! Proyección Events → Attention (LXO-88), lado del almacén: el driver transaccional.
//!
//! La FRONTERA es estrecha. Las reglas (qué Event levanta, actualiza o resuelve qué hecho) son una función pura de un
//! Event que implementa quien conoce el vocabulario de Events ([`AttentionRules`], en `orch/attention_rules.rs`).
//! Aquí vive todo lo que toca SQL: aplicar esas intenciones con las variantes `_in` de LXO-87 DENTRO de la
//! transacción que inserta los Events, descartar las señales antiguas por `seq` y emitir `attention.created` /
//! `attention.resolved` en esa misma transacción ([`AttentionProjection`] es el [`EventProjector`] que la ejecuta en
//! cada escritor del Event Log). `orch` no importa `rusqlite`, no inserta Events ni finaliza borradores.
//!
//! # Orden y señales antiguas
//! * Un tramo debe venir **estrictamente ascendente por `seq`** (no por `at`, que es informativo): si no, se rechaza
//!   entero antes de escribir ([`ProjectError::OutOfOrder`]).
//! * `after_seq` es la marca de agua de quien llama: lo que tiene `seq <= after_seq` ya se aplicó y no se reaplica.
//! * Cada hecho guarda en sus `facts` el `event_seq` del último Event que lo tocó. Una señal con `seq` menor o igual
//!   se descarta ([`Report::stale`]): un `task.reply` antiguo no resuelve una pregunta que volvió a hacerse, y un
//!   `task.status_changed` antiguo no reabre lo ya resuelto. Vale también para un replay sobre un estado poblado.
//!
//! # Eventos de ciclo de vida
//! `attention.created` y `attention.resolved` (entidad `attention`, `entity_id` = `attention_items.id`, que es también
//! `correlation_id` e `idem_key`: hay como mucho UNO de cada por ocurrencia, así que un replay no duplica). Solo
//! códigos e ids; nunca `facts`. Actualizar severity/facts de la activa NO emite nada (no hay `attention.updated`).

use std::sync::Arc;

use rusqlite::Transaction;
use serde_json::{json, Map, Value};

use super::attention::{
    attention_latest_in, attention_raise_in, attention_resolve_in, attention_update_active_in, AttentionCategory, AttentionRow, AttentionStatus, AttentionTarget, AttentionUpdate,
    NewAttention, Raised, Resolution, ResolveOutcome, Severity, TargetKind, UpdateOutcome,
};
use super::authority::new_uuid_v7;
use super::clients::CORE_CLIENT_ID;
use super::error::{StoreError, StoreResult};
use super::events::{insert_derived_in, ActorKind, EventClass, EventProjector, EventRow, NewEvent};

/// Identidad del hecho: lo que define el `fingerprint`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Key {
    pub category: AttentionCategory,
    pub target: AttentionTarget,
    pub subject: Option<String>,
}

/// Lo que un Event pide a la Attention.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Intent {
    Raise { key: Key, severity: Severity, facts: Map<String, Value> },
    Resolve { key: Key, resolution: Resolution },
}

/// Lo que las reglas derivan de UN Event.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Derived {
    pub intents: Vec<Intent>,
    /// Señales reconocidas cuyo destino no es un id lógico válido.
    pub invalid: usize,
}

impl Derived {
    fn key(&mut self, category: AttentionCategory, kind: TargetKind, id: &str, subject: Option<String>) -> Option<Key> {
        match AttentionTarget::new(kind, id) {
            Ok(target) => Some(Key { category, target, subject }),
            Err(_) => {
                self.invalid += 1;
                None
            }
        }
    }

    pub(crate) fn raise(&mut self, category: AttentionCategory, kind: TargetKind, id: &str, subject: Option<String>, severity: Severity, facts: Value) {
        if let (Some(key), Value::Object(facts)) = (self.key(category, kind, id, subject), facts) {
            self.intents.push(Intent::Raise { key, severity, facts });
        }
    }

    pub(crate) fn resolve(&mut self, category: AttentionCategory, kind: TargetKind, id: &str, subject: Option<String>, resolution: Resolution) {
        if let Some(key) = self.key(category, kind, id, subject) {
            self.intents.push(Intent::Resolve { key, resolution });
        }
    }
}

/// Las reglas: una función PURA de un Event (sin estado, reloj, SQL ni E/S). La implementa `orch`.
pub(crate) trait AttentionRules: Send + Sync + std::fmt::Debug {
    fn derive(&self, event: &EventRow) -> Derived;
}

/// Por qué una proyección no se aplicó.
#[derive(Debug)]
pub(crate) enum ProjectError {
    /// El tramo no es estrictamente ascendente por `seq`. No se escribió nada.
    OutOfOrder { previous: i64, got: i64 },
    /// Fallo del almacén (la transacción de quien llama debe deshacerse).
    Store(StoreError),
}

impl From<StoreError> for ProjectError {
    fn from(e: StoreError) -> Self {
        ProjectError::Store(e)
    }
}

impl From<rusqlite::Error> for ProjectError {
    fn from(e: rusqlite::Error) -> Self {
        ProjectError::Store(e.into())
    }
}

impl From<ProjectError> for StoreError {
    fn from(e: ProjectError) -> Self {
        match e {
            ProjectError::Store(e) => e,
            ProjectError::OutOfOrder { previous, got } => StoreError::InvalidEvent(format!("tramo fuera de orden: seq {got} tras {previous}")),
        }
    }
}

/// Qué hizo una proyección. Solo informa: el estado está en `attention_items`.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Report {
    pub created: Vec<AttentionRow>,
    pub updated: Vec<AttentionRow>,
    pub resolved: Vec<AttentionRow>,
    /// Resolver algo que no estaba activo (ya resuelto o nunca levantado): idempotente, no escribe.
    pub noop: usize,
    /// Señales descartadas por ser anteriores al último Event que tocó ese hecho.
    pub stale: usize,
    /// Events con `seq <= after_seq`: ya aplicados por quien llama.
    pub skipped_old: usize,
    /// Señales cuyo destino o `facts` no cumplen el contrato de Attention: se descartan sin abortar el tramo.
    pub invalid: usize,
    /// Eventos `attention.*` realmente insertados (un replay no añade ninguno).
    pub lifecycle_events: usize,
}

/// `event_seq` del último Event que tocó este hecho (0 si la fila no lo lleva).
fn last_seq(row: &AttentionRow) -> i64 {
    serde_json::from_str::<Value>(&row.facts).ok().and_then(|f| f["event_seq"].as_i64()).unwrap_or(0)
}

fn new_attention(e: &EventRow, key: &Key, severity: Severity, mut facts: Map<String, Value>) -> NewAttention {
    facts.insert("event_seq".into(), json!(e.seq));
    NewAttention {
        category: key.category,
        severity,
        target: key.target.clone(),
        project_id: e.project_id.clone(),
        run_id: e.run_id.clone(),
        subject: key.subject.clone(),
        source_event_id: Some(e.id.clone()),
        correlation_id: e.correlation_id.clone(),
        facts: Value::Object(facts).to_string(),
        at: e.at,
    }
}

/// Fingerprint de un hecho, sin materializar la fila.
fn fingerprint(key: &Key) -> String {
    NewAttention {
        category: key.category,
        severity: Severity::Low,
        target: key.target.clone(),
        project_id: None,
        run_id: None,
        subject: key.subject.clone(),
        source_event_id: None,
        correlation_id: None,
        facts: "{}".into(),
        at: 0,
    }
    .fingerprint()
}

/// `attention.created` / `attention.resolved`: el Core es el actor (`system` / `core`).
fn lifecycle(kind: &str, row: &AttentionRow, payload: Value, at: i64) -> NewEvent {
    NewEvent {
        id: new_uuid_v7(),
        at,
        v: 1,
        kind: kind.into(),
        class: EventClass::State,
        actor_kind: ActorKind::System,
        actor_id: None,
        channel: Some("core".into()),
        client_id: Some(CORE_CLIENT_ID.to_string()),
        project_id: row.project_id.clone(),
        run_id: row.run_id.clone(),
        entity_kind: "attention".into(),
        entity_id: row.id.clone(),
        correlation_id: Some(row.id.clone()),
        idem_key: Some(row.id.clone()),
        payload: payload.to_string(),
    }
}

fn created_event(row: &AttentionRow, at: i64) -> NewEvent {
    let mut p = json!({
        "category": row.category.as_str(),
        "severity": row.severity.as_str(),
        "occurrence": row.occurrence,
        "target_kind": row.target.kind.as_str(),
        "target_id": row.target.id,
    });
    if let Some(source) = &row.source_event_id {
        p["source_event_id"] = json!(source);
    }
    lifecycle("attention.created", row, p, at)
}

fn resolved_event(row: &AttentionRow, source: &str, at: i64) -> NewEvent {
    let p = json!({ "resolution": row.resolution.map(|r| r.as_str()).unwrap_or_default(), "source_event_id": source });
    lifecycle("attention.resolved", row, p, at)
}

/// Aplica un tramo del Event Log DENTRO de la transacción de quien llama y devuelve, junto al informe, los eventos
/// `attention.*` que quien llama debe insertar en esa misma transacción (ver [`apply_attention_in`]). Ver la
/// documentación del módulo.
pub(crate) fn project_attention_in(tx: &Transaction<'_>, rules: &dyn AttentionRules, after_seq: i64, events: &[EventRow]) -> Result<(Report, Vec<NewEvent>), ProjectError> {
    for pair in events.windows(2) {
        if pair[1].seq <= pair[0].seq {
            return Err(ProjectError::OutOfOrder { previous: pair[0].seq, got: pair[1].seq });
        }
    }
    let mut report = Report::default();
    let mut emitted: Vec<NewEvent> = vec![];
    for e in events {
        if e.seq <= after_seq {
            report.skipped_old += 1;
            continue;
        }
        let derived = rules.derive(e);
        report.invalid += derived.invalid;
        for intent in derived.intents {
            match intent {
                Intent::Raise { key, severity, facts } => raise(tx, e, &key, severity, facts, &mut report, &mut emitted)?,
                Intent::Resolve { key, resolution } => resolve(tx, e, &key, resolution, &mut report, &mut emitted)?,
            }
        }
    }
    report.lifecycle_events = emitted.len();
    Ok((report, emitted))
}

/// [`project_attention_in`] e inserción de sus eventos en la misma transacción (lo que hace un escritor del log).
#[allow(dead_code)] // lo usan las pruebas; en producción lo ejecuta `AttentionProjection` a través del escritor.
pub(crate) fn apply_attention_in(tx: &Transaction<'_>, rules: &dyn AttentionRules, after_seq: i64, events: &[EventRow]) -> Result<Report, ProjectError> {
    let (report, derived) = project_attention_in(tx, rules, after_seq, events)?;
    insert_derived_in(tx, &derived, None)?;
    Ok(report)
}

fn raise(tx: &Transaction<'_>, e: &EventRow, key: &Key, severity: Severity, facts: Map<String, Value>, report: &mut Report, emitted: &mut Vec<NewEvent>) -> Result<(), ProjectError> {
    let n = new_attention(e, key, severity, facts);
    if n.check().is_err() {
        report.invalid += 1;
        return Ok(());
    }
    match attention_latest_in(tx, &n.fingerprint())? {
        Some(row) if last_seq(&row) >= e.seq => report.stale += 1,
        Some(row) if row.status == AttentionStatus::Active => {
            // El mismo hecho sigue activo: se refrescan severity y facts, sin duplicar ni tocar la identidad.
            let update = AttentionUpdate { severity: (row.severity != n.severity).then_some(n.severity), facts: Some(n.facts.clone()), at: e.at.max(row.created_at) };
            if let UpdateOutcome::Updated(updated) = attention_update_active_in(tx, &row.id, &update)? {
                report.updated.push(updated);
            }
        }
        _ => {
            // Nunca se levantó, o la anterior ocurrencia está resuelta y esta señal es posterior: otra ocurrencia.
            if let Raised::Created(row) = attention_raise_in(tx, &n)? {
                emitted.push(created_event(&row, e.at));
                report.created.push(row);
            }
        }
    }
    Ok(())
}

fn resolve(tx: &Transaction<'_>, e: &EventRow, key: &Key, resolution: Resolution, report: &mut Report, emitted: &mut Vec<NewEvent>) -> Result<(), ProjectError> {
    match attention_latest_in(tx, &fingerprint(key))? {
        None => report.noop += 1,
        Some(row) if row.status == AttentionStatus::Resolved => report.noop += 1,
        Some(row) if last_seq(&row) >= e.seq => report.stale += 1,
        Some(row) => {
            if let ResolveOutcome::Resolved(done) = attention_resolve_in(tx, &row.id, resolution, e.at.max(row.created_at))? {
                emitted.push(resolved_event(&done, &e.id, e.at));
                report.resolved.push(done);
            }
        }
    }
    Ok(())
}

/// La proyección que el Core instala en su almacén: la ejecuta CADA escritor autoritativo del Event Log dentro de su
/// propia transacción (`commit_authoritative_with_events`, `append_events` y los cambios de gestión de Project), así
/// que el Event origen, las filas de Attention y `attention.created` / `attention.resolved` se confirman o se
/// deshacen juntos. Recibe solo los Events nuevos y en orden de `seq`.
#[derive(Debug)]
pub(crate) struct AttentionProjection {
    rules: Arc<dyn AttentionRules>,
}

impl AttentionProjection {
    pub(crate) fn new(rules: Arc<dyn AttentionRules>) -> AttentionProjection {
        AttentionProjection { rules }
    }
}

impl EventProjector for AttentionProjection {
    fn project(&self, tx: &Transaction<'_>, events: &[EventRow]) -> StoreResult<Vec<NewEvent>> {
        // Una base aún sin la migración 006 no tiene dónde proyectar (igual que sin la 004 no hay Event Log): no hay
        // relleno histórico, la Attention empieza cuando la tabla existe.
        let hay_tabla: bool = tx.query_row("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attention_items')", [], |r| r.get(0))?;
        if !hay_tabla {
            return Ok(vec![]);
        }
        let despues = events.first().map_or(0, |e| e.seq - 1);
        project_attention_in(tx, self.rules.as_ref(), despues, events).map(|(_, derived)| derived).map_err(StoreError::from)
    }
}
