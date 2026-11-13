//! LXO-119 · páginas por clave (keyset) de las lecturas vNext (`orch/model_read.rs`). Solo lectura; devuelven las
//! claves y el lector carga cada fila con las funciones de siempre.

use rusqlite::OptionalExtension;

use super::{Store, StoreResult};

/// El uso del proveedor de un Attempt (LXO-249): la SUMA de sus hechos `attempt.usage_reported` (uno por turno). Cada campo suma solo los
/// turnos que lo declararon; `None` = ningún turno lo declaró (desconocido, NUNCA cero).
#[derive(Clone, Debug, PartialEq)]
pub struct AttemptUsage {
    /// Turnos en los que el proveedor informó algo.
    pub turns: i64,
    pub provider: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_creation_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
}

impl Store {
    /// El uso agregado del Attempt, o `None` si el proveedor no declaró nada (ausencia explícita, no ceros).
    pub fn attempt_usage(&self, attempt_id: &str) -> StoreResult<Option<AttemptUsage>> {
        self.read(|c| {
            let row = c.query_row(
                "SELECT count(*), \
                        sum(json_extract(payload, '$.input_tokens')), sum(json_extract(payload, '$.output_tokens')), \
                        sum(json_extract(payload, '$.cache_read_tokens')), sum(json_extract(payload, '$.cache_creation_tokens')), \
                        sum(json_extract(payload, '$.cost_usd')), max(json_extract(payload, '$.provider')) \
                 FROM events WHERE kind = 'attempt.usage_reported' AND entity_kind = 'attempt' AND entity_id = ?1",
                [attempt_id],
                |r| {
                    Ok(AttemptUsage {
                        turns: r.get(0)?,
                        input_tokens: r.get(1)?,
                        output_tokens: r.get(2)?,
                        cache_read_tokens: r.get(3)?,
                        cache_creation_tokens: r.get(4)?,
                        cost_usd: r.get(5)?,
                        provider: r.get(6)?,
                    })
                },
            )?;
            Ok((row.turns > 0).then_some(row))
        })
    }

    /// Ids de las Tasks del Project tras la clave `(created_at, id)`, en ese orden; como mucho `limit`.
    pub fn task_ids_after(&self, project_id: &str, include_discarded: bool, after: Option<(i64, &str)>, limit: usize) -> StoreResult<Vec<String>> {
        let filter = if include_discarded { "" } else { " AND intent = 'open'" };
        let (at, id) = after.unwrap_or((i64::MIN, ""));
        self.read(|c| {
            let sql = format!("SELECT id FROM tasks WHERE project_id = ?1{filter} AND (created_at > ?2 OR (created_at = ?2 AND id > ?3)) ORDER BY created_at, id LIMIT ?4");
            Ok(c.prepare(&sql)?.query_map(rusqlite::params![project_id, at, id, limit as i64], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Números de los Attempts de la Task con `n > after`, por `n`; como mucho `limit`.
    pub fn attempt_ns_after(&self, task_id: &str, after: i64, limit: usize) -> StoreResult<Vec<i64>> {
        self.read(|c| {
            Ok(c.prepare("SELECT n FROM attempts WHERE task_id = ?1 AND n > ?2 ORDER BY n LIMIT ?3")?
                .query_map(rusqlite::params![task_id, after, limit as i64], |r| r.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Hora del hecho `attempt.integrated` del Attempt, si el runtime lo registró.
    pub fn attempt_integrated_at(&self, attempt_id: &str) -> StoreResult<Option<i64>> {
        self.read(|c| {
            Ok(c.query_row(
                "SELECT max(at) FROM events WHERE kind = 'attempt.integrated' AND entity_kind = 'attempt' AND entity_id = ?1",
                [attempt_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()?
            .flatten())
        })
    }
}
