//! LXO-170 · propiedad humano/agente de un Attempt: lado del **almacén**. Contrato: `docs/core/TAKE_OVER.md`.
//!
//! La propiedad NO es un estado del Attempt (el vocabulario de estados lo comparten Core, Desktop, CLI y Mobile) ni una columna nueva:
//! se **deriva del último hecho `attempt.ownership_changed`** del Attempt. Sin hechos, el dueño es el agente. Así el cambio de dueño y su
//! rastro son el mismo dato: no puede haber un dueño sin su evento ni un evento sin efecto, y sobrevive a reiniciar el Core.
//!
//! Solo lee: el hecho lo escribe `orch` (`store_boot::ownership_changed`) con `append_events`, igual que los demás hechos del Attempt.

use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::error::StoreResult;
use super::Store;

/// `kind` del hecho que cambia el dueño.
pub const OWNERSHIP_KIND: &str = "attempt.ownership_changed";

/// Quién trabaja ahora sobre el workspace de un Attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Owner {
    Agent,
    Human,
}

impl Owner {
    pub fn as_str(self) -> &'static str {
        match self {
            Owner::Agent => "agent",
            Owner::Human => "human",
        }
    }

    pub fn parse(s: &str) -> Option<Owner> {
        match s {
            "agent" => Some(Owner::Agent),
            "human" => Some(Owner::Human),
            _ => None,
        }
    }
}

/// El dueño actual de un Attempt y desde cuándo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ownership {
    pub owner: Owner,
    /// Cuándo cambió (ms epoch). `None`: nunca cambió, es el agente de origen.
    pub since: Option<i64>,
    /// Solo con `owner = human`: el commit en el que estaba la rama cuando la persona tomó el control (la referencia para detectar sus cambios).
    pub base_commit: Option<String>,
    /// La petición que lo cambió.
    pub request_id: Option<String>,
}

impl Ownership {
    fn origin() -> Ownership {
        Ownership { owner: Owner::Agent, since: None, base_commit: None, request_id: None }
    }
}

fn from_event(at: i64, payload: &str) -> Option<Ownership> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    Some(Ownership {
        owner: Owner::parse(v.get("to")?.as_str()?)?,
        since: Some(at),
        base_commit: v.get("base_commit").and_then(|b| b.as_str()).map(str::to_string),
        request_id: v.get("request_id").and_then(|r| r.as_str()).map(str::to_string),
    })
}

impl Store {
    /// El dueño actual del Attempt: el `to` de su último `attempt.ownership_changed`, o el agente si nunca cambió. Un hecho ilegible no se
    /// interpreta: cuenta como si no existiera (el agente), nunca como una persona.
    pub fn attempt_ownership(&self, attempt_id: &str) -> StoreResult<Ownership> {
        self.read(|c| {
            let last = c
                .query_row(
                    "SELECT at, payload FROM events WHERE entity_kind = 'attempt' AND entity_id = ?1 AND kind = ?2 ORDER BY seq DESC LIMIT 1",
                    params![attempt_id, OWNERSHIP_KIND],
                    |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?;
            Ok(last.and_then(|(at, payload)| from_event(at, &payload)).unwrap_or_else(Ownership::origin))
        })
    }

    /// Los Attempts NO finales cuyo dueño actual es una persona, como `(attempt_id, task_id)`. Un Attempt terminado ya no tiene dueño que proteger.
    pub fn human_owned_attempts(&self) -> StoreResult<Vec<(String, String)>> {
        self.read(|c| {
            let mut stmt = c.prepare(
                "SELECT e.entity_id, a.task_id
                   FROM events e JOIN attempts a ON a.id = e.entity_id
                  WHERE e.kind = ?1 AND e.entity_kind = 'attempt'
                    AND e.seq = (SELECT MAX(x.seq) FROM events x WHERE x.kind = e.kind AND x.entity_kind = 'attempt' AND x.entity_id = e.entity_id)
                    AND json_extract(e.payload, '$.to') = 'human'
                    AND a.status NOT IN ('done', 'failed', 'stopped', 'exited')
                  ORDER BY e.entity_id",
            )?;
            let rows = stmt.query_map(params![OWNERSHIP_KIND], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }
}
