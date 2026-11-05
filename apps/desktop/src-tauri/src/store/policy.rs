//! Overrides durables de la policy de autonomía (migración 023, LXO-209). Contrato: `docs/core/POLICY.md`.
//!
//! Aquí solo hay persistencia: guardar el nivel que una persona fijó en un ámbito (`global`, `project`, `attempt`), llevar el
//! contador de revisión y dejar el Event de auditoría EN LA MISMA transacción. Las REGLAS (qué se puede endurecer, qué pisos
//! hay, qué actor puede qué) viven en `orch::policy`: el almacén no decide seguridad, solo acota los valores con CHECK.
//!
//! * Cambiar es atómico: la fila, la revisión y el Event se confirman juntos o ninguno. Un cambio sin su hecho no existe.
//! * Optimista: quien escribe manda la revisión que leyó; si ya cambió, `Stale` y no se toca nada.
//! * Repetir lo mismo no avanza la revisión ni deja un Event nuevo (`Unchanged`).
//! * Antes del corte no hay tablas: leer devuelve la policy vacía (solo manda la base del Core) y escribir es
//!   `AgenticModelInactive`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::error::{StoreError, StoreResult};
use super::events::NewEvent;
use super::tasks::{insert_all, require_active};
use super::Store;

/// Un override vigente: el nivel que una persona fijó en un ámbito para una categoría.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PolicyOverrideRow {
    pub scope_kind: String,
    pub scope_id: String,
    pub category: String,
    pub level: String,
    pub set_by: String,
    pub set_at: i64,
    pub revision: i64,
}

/// La policy guardada en un instante: la revisión y todos los overrides. Es una FOTO: cada Command vuelve a leerla al ejecutar.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PolicySnapshot {
    pub revision: i64,
    pub rows: Vec<PolicyOverrideRow>,
}

impl PolicySnapshot {
    /// El nivel guardado para (ámbito, categoría), si hay override.
    pub fn level_of(&self, scope_kind: &str, scope_id: &str, category: &str) -> Option<&str> {
        self.rows.iter().find(|r| r.scope_kind == scope_kind && r.scope_id == scope_id && r.category == category).map(|r| r.level.as_str())
    }
}

/// Lo que se escribe: fijar un nivel o volver a heredar (borrar el override).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyWrite {
    Set { scope_kind: String, scope_id: String, category: String, level: String },
    Reset { scope_kind: String, scope_id: String, category: String },
}

impl PolicyWrite {
    fn key(&self) -> (&str, &str, &str) {
        match self {
            PolicyWrite::Set { scope_kind, scope_id, category, .. } | PolicyWrite::Reset { scope_kind, scope_id, category } => (scope_kind, scope_id, category),
        }
    }
}

/// Resultado de escribir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyChange {
    /// Confirmado: la nueva revisión y el nivel que había (`None` = heredaba).
    Changed { revision: i64, previous: Option<String> },
    /// Ya estaba así: no avanza la revisión ni deja Event.
    Unchanged { revision: i64 },
    /// La policy cambió desde que el cliente la leyó: no se escribió nada.
    Stale { current: i64 },
}

fn has_tables(c: &Connection) -> StoreResult<bool> {
    Ok(c.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'policy_state'", [], |_| Ok(())).optional()?.is_some())
}

fn snapshot_in(c: &Connection) -> StoreResult<PolicySnapshot> {
    if !has_tables(c)? {
        return Ok(PolicySnapshot::default());
    }
    let revision: i64 = c.query_row("SELECT revision FROM policy_state WHERE id = 1", [], |r| r.get(0))?;
    let mut stmt = c.prepare("SELECT scope_kind, scope_id, category, level, set_by, set_at, revision FROM policy_overrides ORDER BY scope_kind, scope_id, category")?;
    let rows = stmt
        .query_map([], |r| {
            Ok(PolicyOverrideRow { scope_kind: r.get(0)?, scope_id: r.get(1)?, category: r.get(2)?, level: r.get(3)?, set_by: r.get(4)?, set_at: r.get(5)?, revision: r.get(6)? })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PolicySnapshot { revision, rows })
}

impl Store {
    /// La policy guardada ahora. Sin tablas (antes del corte): vacía, revisión 0.
    pub fn policy_snapshot(&self) -> StoreResult<PolicySnapshot> {
        self.read(snapshot_in)
    }

    /// Escribe un cambio de policy con su Event de auditoría en una sola transacción.
    ///
    /// `event` recibe el nivel anterior y la revisión NUEVA y devuelve el Event `policy.changed`. Solo se llama si de verdad hay
    /// cambio. `set_by` es la persona autenticada; el almacén no la valida, la valida quien llama.
    pub fn policy_apply_recorded(
        &mut self,
        expected_revision: i64,
        write: &PolicyWrite,
        set_by: &str,
        at: i64,
        event: impl FnOnce(Option<&str>, i64) -> StoreResult<NewEvent>,
    ) -> StoreResult<PolicyChange> {
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let current: i64 = tx.query_row("SELECT revision FROM policy_state WHERE id = 1", [], |r| r.get(0))?;
            if current != expected_revision {
                return Ok(PolicyChange::Stale { current });
            }
            let (kind, id, category) = write.key();
            let previous: Option<String> =
                tx.query_row("SELECT level FROM policy_overrides WHERE scope_kind = ?1 AND scope_id = ?2 AND category = ?3", params![kind, id, category], |r| r.get(0)).optional()?;
            let same = match write {
                PolicyWrite::Set { level, .. } => previous.as_deref() == Some(level.as_str()),
                PolicyWrite::Reset { .. } => previous.is_none(),
            };
            if same {
                return Ok(PolicyChange::Unchanged { revision: current });
            }
            let next = current + 1;
            match write {
                PolicyWrite::Set { level, .. } => {
                    tx.execute(
                        "INSERT INTO policy_overrides (scope_kind, scope_id, category, level, set_by, set_at, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                         ON CONFLICT (scope_kind, scope_id, category) DO UPDATE SET level = ?4, set_by = ?5, set_at = ?6, revision = ?7",
                        params![kind, id, category, level, set_by, at.max(0), next],
                    )?;
                }
                PolicyWrite::Reset { .. } => {
                    tx.execute("DELETE FROM policy_overrides WHERE scope_kind = ?1 AND scope_id = ?2 AND category = ?3", params![kind, id, category])?;
                }
            }
            tx.execute("UPDATE policy_state SET revision = ?1 WHERE id = 1", params![next])?;
            let e = event(previous.as_deref(), next)?;
            insert_all(tx, std::slice::from_ref(&e), projector.as_deref()).map_err(|err| match err {
                StoreError::TaskConflict(m) => StoreError::InvalidEvent(m),
                otro => otro,
            })?;
            Ok(PolicyChange::Changed { revision: next, previous })
        })
    }
}
