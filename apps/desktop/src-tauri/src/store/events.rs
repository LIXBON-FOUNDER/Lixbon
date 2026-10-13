//! Event Log (slice E, etapa E1a): lado del **almacén**.
//!
//! Solo sabe guardar y leer las filas de `events` (migración `004_events`). No conoce `orch`, ni qué
//! hechos existen, ni quién los provoca: eso es política de `orch::events`. La dirección sigue siendo
//! `orch -> store`.
//!
//! # Garantías de este módulo
//! * **Append-only.** Aquí solo hay `INSERT` y `SELECT`; la base además aborta `UPDATE` y `DELETE`.
//! * **Orden.** `seq` (AUTOINCREMENT) es el orden y el único cursor. `at` no ordena.
//! * **Atomicidad.** [`insert_events`] corre DENTRO de la transacción de quien llama: la mutación del
//!   estado ([`Store::commit_authoritative_with_events`]) y sus eventos se confirman o se deshacen
//!   juntos. [`Store::append_events`] es la vía para hechos que no tocan `legacy_state` (su propia
//!   transacción).
//! * **Idempotencia.** `UNIQUE (kind, idem_key)`: el mismo hecho repetido se deduplica
//!   ([`Inserted::Duplicate`]); la misma clave en otro `kind` no colisiona.
//! * **Límites impuestos dos veces.** [`NewEvent::check`] los comprueba antes de tocar la base y la
//!   propia tabla (CHECK) los vuelve a imponer: JSON válido y como mucho [`MAX_PAYLOAD_BYTES`] bytes.
//! * **Referencias blandas.** `project_id`, `run_id`, `client_id`, `entity_kind` y `entity_id` no
//!   llevan clave foránea: archivar un proyecto o borrar un run no toca su historia.
//!
//! Los eventos llegan ya MATERIALIZADOS ([`NewEvent`]: id, hora y payload fijados una vez). Este
//! módulo no genera nada: un reintento de la persistencia vuelve a insertar exactamente lo mismo.

use rusqlite::{params, Transaction};
use serde::Serialize;

use super::error::{StoreError, StoreResult};
use super::Store;

/// Tamaño máximo del payload de un evento, en BYTES de su texto JSON.
pub const MAX_PAYLOAD_BYTES: usize = 8192;
/// Máximo de eventos que devuelve una página de lectura.
pub const MAX_PAGE: usize = 500;
/// Tamaño de página si quien lee no indica ninguno.
pub const DEFAULT_PAGE: usize = 100;
const MAX_KIND_CHARS: usize = 64;

/// Qué clase de hecho es (no qué módulo escribió la fila).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventClass {
    /// Un cambio de estado confirmado.
    State,
    /// Un efecto externo observado (worktree, proceso…) sin decisión humana asociada.
    Effect,
    /// Una decisión de una persona (o su resolución) con su resultado.
    Decision,
    /// Un hecho del propio Core.
    System,
}

impl EventClass {
    pub fn as_str(self) -> &'static str {
        match self {
            EventClass::State => "state",
            EventClass::Effect => "effect",
            EventClass::Decision => "decision",
            EventClass::System => "system",
        }
    }

    fn parse(s: &str) -> StoreResult<EventClass> {
        Ok(match s {
            "state" => EventClass::State,
            "effect" => EventClass::Effect,
            "decision" => EventClass::Decision,
            "system" => EventClass::System,
            other => return Err(StoreError::InvalidEvent(format!("clase de evento desconocida: {other}"))),
        })
    }
}

/// Quién provocó el hecho. La identidad de cliente (Desktop, móvil, CLI…) llega con F1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    Person,
    Agent,
    System,
}

impl ActorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ActorKind::Person => "person",
            ActorKind::Agent => "agent",
            ActorKind::System => "system",
        }
    }

    fn parse(s: &str) -> StoreResult<ActorKind> {
        Ok(match s {
            "person" => ActorKind::Person,
            "agent" => ActorKind::Agent,
            "system" => ActorKind::System,
            other => return Err(StoreError::InvalidEvent(format!("tipo de actor desconocido: {other}"))),
        })
    }
}

/// Un evento ya materializado, listo para insertar. Todo lo que lo identifica (`id`, `at`, payload,
/// `idem_key`…) está fijado: reintentar una persistencia no regenera nada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewEvent {
    /// UUID v7: identidad global del evento.
    pub id: String,
    /// ms epoch. Informativo: NO ordena.
    pub at: i64,
    /// Versión del contrato (`kind` + forma del payload).
    pub v: i64,
    pub kind: String,
    pub class: EventClass,
    pub actor_kind: ActorKind,
    pub actor_id: Option<String>,
    pub channel: Option<String>,
    pub client_id: Option<String>,
    pub project_id: Option<String>,
    pub run_id: Option<String>,
    pub entity_kind: String,
    pub entity_id: String,
    pub correlation_id: Option<String>,
    pub idem_key: Option<String>,
    /// Texto JSON de un objeto, como mucho [`MAX_PAYLOAD_BYTES`] bytes.
    pub payload: String,
}

impl NewEvent {
    /// Comprueba lo que la tabla también impone, ANTES de abrir ninguna transacción: un evento mal
    /// formado se rechaza con un error claro, no como un fallo de persistencia.
    pub fn check(&self) -> StoreResult<()> {
        let bad = |m: String| Err(StoreError::InvalidEvent(m));
        if self.id.is_empty() {
            return bad("el evento no tiene id".into());
        }
        if self.v < 1 {
            return bad(format!("{}: la versión del contrato debe ser >= 1", self.kind));
        }
        let kind_chars = self.kind.chars().count();
        if kind_chars == 0 || kind_chars > MAX_KIND_CHARS {
            return bad(format!("el tipo de evento debe tener entre 1 y {MAX_KIND_CHARS} caracteres"));
        }
        if self.entity_kind.is_empty() || self.entity_id.is_empty() {
            return bad(format!("{}: falta la entidad (entity_kind/entity_id)", self.kind));
        }
        if self.idem_key.as_deref() == Some("") {
            return bad(format!("{}: idem_key vacía", self.kind));
        }
        if self.actor_kind == ActorKind::Agent && self.actor_id.is_none() {
            return bad(format!("{}: un agente sin identidad", self.kind));
        }
        if self.payload.len() > MAX_PAYLOAD_BYTES {
            return bad(format!("{}: payload de {} bytes (el máximo es {MAX_PAYLOAD_BYTES})", self.kind, self.payload.len()));
        }
        match serde_json::from_str::<serde_json::Value>(&self.payload) {
            Ok(serde_json::Value::Object(_)) => Ok(()),
            Ok(_) => bad(format!("{}: el payload debe ser un objeto JSON", self.kind)),
            Err(e) => bad(format!("{}: payload no es JSON válido ({e})", self.kind)),
        }
    }
}

/// Una fila leída de `events`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EventRow {
    pub seq: i64,
    pub id: String,
    pub at: i64,
    pub v: i64,
    pub kind: String,
    pub class: EventClass,
    pub actor_kind: ActorKind,
    pub actor_id: Option<String>,
    pub channel: Option<String>,
    pub client_id: Option<String>,
    pub project_id: Option<String>,
    pub run_id: Option<String>,
    pub entity_kind: String,
    pub entity_id: String,
    pub correlation_id: Option<String>,
    pub idem_key: Option<String>,
    /// `rev` de `legacy_state` del COMMIT que lo confirmó (NULL si no tocó `legacy_state`).
    pub state_rev: Option<i64>,
    /// Texto JSON del payload.
    pub payload: String,
}

/// Resultado de insertar un evento.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inserted {
    /// Insertado con este `seq`.
    New(i64),
    /// Ya existía un evento con el mismo `(kind, idem_key)`: no se insertó nada.
    Duplicate,
}

/// Consulta por cursor. Solo por `seq`, nunca por desplazamiento:
/// * `after = N`  → `seq > N`  (exclusivo);
/// * `before = N` → `seq < N`  (exclusivo).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventQuery {
    pub after: Option<i64>,
    pub before: Option<i64>,
    /// `None` = [`DEFAULT_PAGE`]; más de [`MAX_PAGE`] se recorta a [`MAX_PAGE`]; `Some(0)` es un error.
    pub limit: Option<usize>,
    /// `false` = del más antiguo al más nuevo (sincronizar); `true` = del más nuevo hacia atrás
    /// («últimos eventos», paginar hacia el pasado).
    pub newest_first: bool,
}

/// Una página de eventos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EventPage {
    pub events: Vec<EventRow>,
    /// Hay más eventos en la dirección pedida.
    pub has_more: bool,
    /// `seq` del último evento devuelto: va en `after` (hacia delante) o `before` (hacia atrás) para
    /// pedir la página siguiente. `None` si la página está vacía.
    pub next_cursor: Option<i64>,
    /// El `seq` más alto del Core en el momento de leer (0 si no hay eventos).
    pub head_seq: i64,
}

const COLS: &str = "seq, id, at, v, kind, class, actor_kind, actor_id, channel, client_id, project_id, run_id, entity_kind, entity_id, correlation_id, idem_key, state_rev, payload";

fn row_to_event(r: &rusqlite::Row<'_>) -> rusqlite::Result<(EventRow, String, String)> {
    let class: String = r.get(5)?;
    let actor: String = r.get(6)?;
    Ok((
        EventRow {
            seq: r.get(0)?,
            id: r.get(1)?,
            at: r.get(2)?,
            v: r.get(3)?,
            kind: r.get(4)?,
            class: EventClass::State,
            actor_kind: ActorKind::System,
            actor_id: r.get(7)?,
            channel: r.get(8)?,
            client_id: r.get(9)?,
            project_id: r.get(10)?,
            run_id: r.get(11)?,
            entity_kind: r.get(12)?,
            entity_id: r.get(13)?,
            correlation_id: r.get(14)?,
            idem_key: r.get(15)?,
            state_rev: r.get(16)?,
            payload: r.get(17)?,
        },
        class,
        actor,
    ))
}

/// Inserta `events` DENTRO de la transacción de quien llama, en el orden dado (el orden de inserción
/// es el orden de `seq`). `state_rev` es la `rev` de `legacy_state` que esa misma transacción
/// confirma, o `None` si no toca `legacy_state`.
///
/// Todos los eventos se comprueban ANTES de insertar ninguno. Un `Err` deja la transacción sin
/// confirmar: quien llama la deshace entera (la mutación y los eventos van juntos).
pub(crate) fn insert_events(tx: &Transaction<'_>, events: &[NewEvent], state_rev: Option<i64>) -> StoreResult<Vec<Inserted>> {
    // Sin eventos no se toca la tabla: una base que aún no tiene la 004 (promovida pero sin migrar)
    // sigue confirmando mutaciones del estado exactamente como antes.
    if events.is_empty() {
        return Ok(Vec::new());
    }
    for e in events {
        e.check()?;
    }
    let mut stmt = tx.prepare_cached(
        "INSERT INTO events (id, at, v, kind, class, actor_kind, actor_id, channel, client_id, project_id, run_id, entity_kind, entity_id, correlation_id, idem_key, state_rev, payload)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         ON CONFLICT (kind, idem_key) WHERE idem_key IS NOT NULL DO NOTHING",
    )?;
    let mut out = Vec::with_capacity(events.len());
    for e in events {
        let n = stmt.execute(params![
            e.id,
            e.at,
            e.v,
            e.kind,
            e.class.as_str(),
            e.actor_kind.as_str(),
            e.actor_id,
            e.channel,
            e.client_id,
            e.project_id,
            e.run_id,
            e.entity_kind,
            e.entity_id,
            e.correlation_id,
            e.idem_key,
            state_rev,
            e.payload,
        ])?;
        out.push(if n == 1 { Inserted::New(tx.last_insert_rowid()) } else { Inserted::Duplicate });
    }
    Ok(out)
}

impl Store {
    /// Añade eventos que NO acompañan a una mutación de `legacy_state` (`state_rev` queda NULL), en
    /// su propia transacción. Si el hecho también cambia otras filas, esas filas y su evento van en
    /// UNA transacción (no se usa esta vía).
    pub fn append_events(&mut self, events: &[NewEvent]) -> StoreResult<Vec<Inserted>> {
        for e in events {
            e.check()?;
        }
        self.write(|tx| insert_events(tx, events, None))
    }

    /// Una página de eventos por cursor de `seq` (ver [`EventQuery`]).
    pub fn events_page(&self, q: &EventQuery) -> StoreResult<EventPage> {
        for (name, v) in [("after", q.after), ("before", q.before)] {
            if v.is_some_and(|n| n < 0) {
                return Err(StoreError::InvalidEvent(format!("el cursor `{name}` no puede ser negativo")));
            }
        }
        let limit = match q.limit {
            None => DEFAULT_PAGE,
            Some(0) => return Err(StoreError::InvalidEvent("`limit` debe ser al menos 1".into())),
            Some(n) => n.min(MAX_PAGE),
        };
        let order = if q.newest_first { "DESC" } else { "ASC" };
        self.read(|c| {
            let sql = format!("SELECT {COLS} FROM events WHERE (?1 IS NULL OR seq > ?1) AND (?2 IS NULL OR seq < ?2) ORDER BY seq {order} LIMIT ?3");
            let mut stmt = c.prepare(&sql)?;
            let raw = stmt
                .query_map(params![q.after, q.before, (limit + 1) as i64], row_to_event)?
                .collect::<Result<Vec<_>, _>>()?;
            let mut events = Vec::with_capacity(raw.len());
            for (mut row, class, actor) in raw {
                row.class = EventClass::parse(&class)?;
                row.actor_kind = ActorKind::parse(&actor)?;
                events.push(row);
            }
            let has_more = events.len() > limit;
            events.truncate(limit);
            let next_cursor = events.last().map(|e| e.seq);
            let head_seq: i64 = c.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |r| r.get(0))?;
            Ok(EventPage { events, has_more, next_cursor, head_seq })
        })
    }

    /// El `seq` más alto, o 0 si aún no hay eventos.
    pub fn events_head(&self) -> StoreResult<i64> {
        self.read(|c| Ok(c.query_row("SELECT COALESCE(MAX(seq), 0) FROM events", [], |r| r.get(0))?))
    }
}
