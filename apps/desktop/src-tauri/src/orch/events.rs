//! Event Log del Core (slice E, etapa E1a): lado de la **política**.
//!
//! Un *evento* es un hecho estructurado y durable: qué ocurrió (`kind`), quién lo provocó (actor), sobre
//! qué entidad y en qué proyecto, y los datos propios del hecho (payload tipado). SQLite es la única
//! autoridad (`store::events`, migración `004_events`): no existe `events.json` ni un segundo log.
//!
//! # Cómo nace un evento (outbox en `Tx`, no en `State`)
//! ```text
//! mutador producen EventDraft  ->  Tx::push_event          (en el candidato, junto a `notify`)
//! mutate_locked: validar/finalizar UNA vez  ->  NewEvent    (id UUID v7, hora, actor, payload)
//! Persistence::persist(&state, &events)  ->  BEGIN IMMEDIATE
//!                                            UPDATE legacy_state  rev N -> N+1
//!                                            INSERT events        state_rev = N+1
//!                                            COMMIT
//! solo entonces: la memoria se sustituye y se publica
//! ```
//! * El estado autoritativo (`State`) NO transporta metadatos de una transacción: el outbox vive en
//!   [`Tx`](super::mutation::Tx) y se descarta con el candidato si algo falla.
//! * **Un solo punto de emisión**: [`Tx::push_event`](super::mutation::Tx::push_event). Una prueba de
//!   arquitectura vigila quién lo llama y quién construye borradores.
//! * **Retry.** Los eventos se finalizan ANTES del bucle de reintentos de la persistencia: cada
//!   intento recibe exactamente los mismos `NewEvent` (mismo `id`, misma hora). Un `BUSY` no los
//!   regenera ni los duplica (cada intento es una transacción nueva y la anterior se deshizo).
//! * **Modo legacy/degradado** (`state.json`): no hay Event Log. Los borradores se descartan sin
//!   finalizarse; no se crea ningún archivo paralelo.
//!
//! # Payload
//! Solo lo produce un constructor TIPADO: [`EventDraft::new`] exige un [`EventPayload`] (una estructura
//! concreta por `kind`, con su versión y su clase). No hay forma de crear un borrador a partir de un
//! `serde_json::Value` arbitrario (por ejemplo, llegado por RPC). El texto resultante es un objeto JSON
//! de como mucho [`MAX_PAYLOAD_BYTES`] bytes; la tabla vuelve a imponerlo.
//!
//! Lo que NUNCA entra en un payload: cuerpos de mensaje, informes, diffs, `argv`, `env`, credenciales.
//! Identificadores y hechos pequeños sí.
//!
//! # Referencias blandas
//! `project_id`, `run_id`, `entity_kind` y `entity_id` no tienen clave foránea. El `project_id` sale de
//! la tarea (o del proyecto) que ya se conoce al emitir: **no se ejecuta git para resolverlo**. `None`
//! es válido (tareas anteriores a D, repositorios ambiguos, hechos sin proyecto).
//!
//! # Actor y canal
//! `Actor` = persona, agente (con su tarea) o sistema. `Channel` describe el TRANSPORTE (`ui`, `lxo`,
//! `core`), no una identidad: Desktop, móvil y CLI no se distinguen todavía; F1 añadirá `client_id`
//! desde la credencial sin reescribir los eventos ya guardados.

use serde::Serialize;

use crate::store::{new_uuid_v7, ActorKind, EventClass, NewEvent, MAX_PAYLOAD_BYTES};

/// Quién provoca un hecho.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Actor {
    /// Una persona (la interfaz local). Su identidad concreta llega con F1.
    Person,
    /// Un agente, con la tarea que lo identifica.
    Agent(String),
    /// El propio Core.
    System,
}

impl Actor {
    fn parts(&self) -> (ActorKind, Option<String>) {
        match self {
            Actor::Person => (ActorKind::Person, None),
            Actor::Agent(task) => (ActorKind::Agent, Some(task.clone())),
            Actor::System => (ActorKind::System, None),
        }
    }
}

/// Por dónde llegó la orden (transporte), no quién es el cliente.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Channel {
    /// Comandos de la interfaz (Tauri).
    Ui,
    /// El servidor local que usa `lxo`.
    Lxo,
    /// Interno del Core (arranque, vigilancia, temporizadores).
    Core,
}

impl Channel {
    fn as_str(self) -> &'static str {
        match self {
            Channel::Ui => "ui",
            Channel::Lxo => "lxo",
            Channel::Core => "core",
        }
    }
}

/// Qué clase de entidad es el sujeto principal de un evento.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EntityKind {
    Task,
    Run,
    Project,
    SpawnRequest,
    /// Hechos del sistema sin Task ni Project natural.
    Core,
}

impl EntityKind {
    fn as_str(self) -> &'static str {
        match self {
            EntityKind::Task => "task",
            EntityKind::Run => "run",
            EntityKind::Project => "project",
            EntityKind::SpawnRequest => "spawn_request",
            EntityKind::Core => "core",
        }
    }
}

/// Contrato de un tipo de evento: su nombre, la versión de su payload y su clase. Una estructura por
/// `kind`; es lo único que puede producir un payload de dominio.
pub(super) trait EventPayload: Serialize {
    const KIND: &'static str;
    /// Versión del contrato (`kind` + forma del payload). Sube cuando la forma cambia.
    const VERSION: i64;
    const CLASS: EventClass;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum EventError {
    /// El payload no se pudo serializar.
    Serialize(String),
    /// El payload serializado no es un objeto JSON.
    NotAnObject(&'static str),
    /// El payload pasa de [`MAX_PAYLOAD_BYTES`].
    TooLarge { kind: &'static str, bytes: usize },
}

impl std::fmt::Display for EventError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EventError::Serialize(m) => write!(f, "no se pudo serializar el payload del evento: {m}"),
            EventError::NotAnObject(kind) => write!(f, "{kind}: el payload debe ser un objeto JSON"),
            EventError::TooLarge { kind, bytes } => write!(f, "{kind}: payload de {bytes} bytes (el máximo es {MAX_PAYLOAD_BYTES})"),
        }
    }
}

/// Un hecho ya decidido pero todavía SIN materializar: no tiene `id` ni hora. Se acumula en el
/// candidato de `mutate` y se finaliza una sola vez, antes de persistir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct EventDraft {
    kind: &'static str,
    v: i64,
    class: EventClass,
    /// `None` = el actor por defecto del `Tx`.
    actor: Option<(Actor, Channel)>,
    project_id: Option<String>,
    run_id: Option<String>,
    entity_kind: EntityKind,
    entity_id: String,
    correlation_id: Option<String>,
    idem_key: Option<String>,
    payload: String,
}

impl EventDraft {
    /// ÚNICA forma de crear un borrador: con un payload tipado.
    pub(super) fn new<P: EventPayload>(entity_kind: EntityKind, entity_id: impl Into<String>, payload: &P) -> Result<EventDraft, EventError> {
        let payload_text = serde_json::to_string(payload).map_err(|e| EventError::Serialize(e.to_string()))?;
        if !payload_text.starts_with('{') {
            return Err(EventError::NotAnObject(P::KIND));
        }
        if payload_text.len() > MAX_PAYLOAD_BYTES {
            return Err(EventError::TooLarge { kind: P::KIND, bytes: payload_text.len() });
        }
        Ok(EventDraft {
            kind: P::KIND,
            v: P::VERSION,
            class: P::CLASS,
            actor: None,
            project_id: None,
            run_id: None,
            entity_kind,
            entity_id: entity_id.into(),
            correlation_id: None,
            idem_key: None,
            payload: payload_text,
        })
    }

    /// Proyecto al que pertenece el hecho, si ya se conoce (nunca se resuelve con git aquí).
    pub(super) fn project(mut self, project_id: Option<String>) -> EventDraft {
        self.project_id = project_id;
        self
    }

    pub(super) fn run(mut self, run_id: Option<String>) -> EventDraft {
        self.run_id = run_id;
        self
    }

    pub(super) fn correlated(mut self, correlation_id: impl Into<String>) -> EventDraft {
        self.correlation_id = Some(correlation_id.into());
        self
    }

    /// Clave de idempotencia. Su unicidad es POR `kind` (`UNIQUE (kind, idem_key)`): no hace falta
    /// que sea única entre tipos distintos.
    pub(super) fn idempotent(mut self, key: impl Into<String>) -> EventDraft {
        self.idem_key = Some(key.into());
        self
    }

    /// Quién lo provocó, si es distinto del actor por defecto de la mutación.
    pub(super) fn by(mut self, actor: Actor, channel: Channel) -> EventDraft {
        self.actor = Some((actor, channel));
        self
    }

    pub(super) fn kind(&self) -> &'static str {
        self.kind
    }

    /// Materializa el borrador: fija `id` (UUID v7), hora, actor y canal. Se llama UNA vez por evento,
    /// antes del bucle de reintentos de la persistencia.
    fn finalize(self, default_actor: &(Actor, Channel), at: i64) -> NewEvent {
        let (actor, channel) = self.actor.as_ref().unwrap_or(default_actor);
        let (actor_kind, actor_id) = actor.parts();
        NewEvent {
            id: new_uuid_v7(),
            at,
            v: self.v,
            kind: self.kind.to_string(),
            class: self.class,
            actor_kind,
            actor_id,
            channel: Some(channel.as_str().to_string()),
            client_id: None,
            project_id: self.project_id,
            run_id: self.run_id,
            entity_kind: self.entity_kind.as_str().to_string(),
            entity_id: self.entity_id,
            correlation_id: self.correlation_id,
            idem_key: self.idem_key,
            payload: self.payload,
        }
    }
}

/// Finaliza y valida los borradores de UNA mutación: misma hora para todos, un `id` nuevo cada uno.
/// Un evento que no cumple el contrato rechaza la mutación entera (nada cambia): es un error de
/// programación que debe verse, no un hecho que se pierda en silencio.
pub(super) fn finalize_all(drafts: Vec<EventDraft>, default_actor: &(Actor, Channel), at: i64) -> Result<Vec<NewEvent>, String> {
    let mut out = Vec::with_capacity(drafts.len());
    for d in drafts {
        let kind = d.kind();
        let e = d.finalize(default_actor, at);
        e.check().map_err(|err| format!("{kind}: {err}"))?;
        out.push(e);
    }
    Ok(out)
}
