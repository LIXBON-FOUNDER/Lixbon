//! Adapters de proveedor (LXO-128): la interfaz estable que desacopla el Core de Claude/Codex. El Core no ramifica por
//! nombre de engine; pregunta a la [`CapabilityMatrix`] del adapter y llama a través de [`Gated`], que no deja pasar una
//! llamada a una capability que el proveedor no ofrece. Contrato, invariantes y guía para un proveedor nuevo:
//! `docs/core/ADAPTERS.md`.
//!
//! Un adapter REPORTA HECHOS al Core ([`AdapterEvent`], [`RunOutcome`]); no recibe `Store`, `Tx` ni `State`, así que no
//! puede escribirlos (invariante 4). Los tipos de este módulo no implementan `Serialize` a propósito salvo los que son
//! contrato público (matriz, errores, snapshot): un hecho del adapter solo llega a un Event si el Core lo mapea a mano.
//!
//! Sin consumidores todavía: los adapters de Claude y Codex (LXO-129/130) y el comando de resume (LXO-134) los usan.
#![allow(dead_code, unused_imports)]

mod capability;
mod claude;
mod codex;
mod error;
mod process;
mod redact;
mod registry;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

use std::fmt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub use capability::{Capability, CapabilityMatrix, CapabilityState, MATRIX_VERSION};
pub use claude::{ClaudeAdapter, ClaudeConfig, Endpoint};
pub use codex::{CodexAdapter, CodexConfig};
pub use error::{AdapterError, ErrorCode, FailureKind};
pub use redact::{redact, REDACTED};
pub use registry::{AdapterRegistry, ProviderEntry, RegistrySnapshot, SNAPSHOT_VERSION};

use crate::orch::agents::EnvBlock;
use crate::store::{looks_secret, MAX_EXTERNAL_REF_CHARS};

/// ¿Menciona la ayuda de una CLI este flag o subcomando COMPLETO? `--json` no se da por presente porque aparezca `--jsonl` o
/// `--json-schema`: una CLI con un flag parecido no es compatible.
pub(crate) fn help_has(help: &str, token: &str) -> bool {
    let is_token_char = |c: char| c.is_alphanumeric() || c == '-' || c == '_';
    help.match_indices(token).any(|(i, _)| {
        let before = help[..i].chars().next_back();
        let after = help[i + token.len()..].chars().next();
        !before.is_some_and(is_token_char) && !after.is_some_and(is_token_char)
    })
}

/// Cancelación cooperativa: el Core la dispara, el adapter la mira entre pasos y devuelve `Cancelled`. Se clona; todos
/// los clones comparten el mismo estado.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> CancelToken {
        CancelToken::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// `Err(cancelled)` si ya se canceló: para el inicio de cada paso del adapter.
    pub fn check(&self) -> Result<(), AdapterError> {
        if self.is_cancelled() {
            Err(AdapterError::cancelled())
        } else {
            Ok(())
        }
    }
}

/// Id de sesión del proveedor (invariante 2): texto OPACO. No se interpreta, no se imprime (`Debug` lo oculta), no se
/// serializa y no tiene forma de credencial. Quien lo recibe solo puede devolvérselo al mismo adapter.
#[derive(Clone, PartialEq, Eq)]
pub struct ProviderRef(String);

impl ProviderRef {
    pub fn new(raw: &str) -> Result<ProviderRef, AdapterError> {
        let ok = !raw.trim().is_empty() && raw.chars().count() <= MAX_EXTERNAL_REF_CHARS && !raw.chars().any(char::is_control);
        if !ok {
            return Err(AdapterError::invalid("la referencia del proveedor es texto opaco, no vacío, sin control y acotado"));
        }
        if looks_secret(raw) {
            return Err(AdapterError::invalid("la referencia del proveedor tiene forma de credencial: no se acepta"));
        }
        Ok(ProviderRef(raw.to_string()))
    }

    /// Solo para pasarla al adapter que la emitió o para que el Core la fije en `provider_sessions` (que no la publica).
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ProviderRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ProviderRef(<opaco>)")
    }
}

/// Cómo está el entorno del proveedor. Es un resultado de PREFLIGHT, no de un Attempt: que esté bloqueado no falla nada.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Environment {
    Ready,
    Blocked { blocks: Vec<EnvBlock> },
}

/// Resultado de `probe`: qué ofrece el proveedor y si el entorno deja usarlo. Nunca un fallo de Attempt.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProbeResult {
    /// Versión de la CLI/servicio del proveedor, si se pudo leer. Informativa: ningún cliente decide por ella.
    pub cli_version: Option<String>,
    pub environment: Environment,
    pub matrix: CapabilityMatrix,
    /// Canal con que el adapter hablará con el proveedor, si ofrece más de uno (`app_server`, `exec_json`…). Un canal
    /// degradado es visible aquí y en el evento `Transport`. Ausente en los adapters de un solo canal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
}

impl ProbeResult {
    /// Entorno listo con la matriz dada.
    pub fn ready(cli_version: Option<&str>, matrix: CapabilityMatrix) -> ProbeResult {
        ProbeResult { cli_version: cli_version.map(str::to_string), environment: Environment::Ready, matrix, transport: None }
    }

    pub fn with_transport(mut self, transport: &str) -> ProbeResult {
        self.transport = Some(transport.to_string());
        self
    }

    /// Entorno bloqueado: toda la matriz queda `environment_blocked` por el primer bloqueo.
    pub fn blocked(cli_version: Option<&str>, blocks: Vec<EnvBlock>) -> ProbeResult {
        let first = blocks.first().copied().unwrap_or(EnvBlock::CliMissing);
        ProbeResult { cli_version: cli_version.map(str::to_string), environment: Environment::Blocked { blocks }, matrix: CapabilityMatrix::all_blocked(first), transport: None }
    }
}

/// Qué arrancar. Sin variables de entorno ni credenciales: el adapter usa las suyas y nunca viajan en la petición.
#[derive(Clone, Debug)]
pub struct StartRequest {
    pub attempt_id: String,
    pub worktree: PathBuf,
    pub prompt: String,
    /// Perfil de permisos del Core (`agents::Profile::id`).
    pub profile: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// Reanudar la sesión nativa del proveedor. `provider_ref` es la que el mismo adapter entregó con `SessionBound`.
#[derive(Clone, Debug)]
pub struct ResumeRequest {
    pub attempt_id: String,
    pub provider_ref: ProviderRef,
    pub worktree: PathBuf,
    /// El mensaje con el que continúa la sesión.
    pub prompt: Option<String>,
    /// Los permisos con que corría el Attempt original: reanudar no los amplía ni los pierde.
    pub profile: String,
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    pub question_id: String,
    pub text: String,
}

/// Una ejecución viva en un adapter. Opaca para el cliente: el Core la guarda mientras corre y se la devuelve al adapter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunHandle {
    pub attempt_id: String,
    pub adapter: String,
    pub seq: u64,
}

/// Hechos que el adapter observa mientras corre. NO es `Serialize`: el Core decide qué se vuelve un Event.
#[derive(Clone, Debug, PartialEq)]
pub enum AdapterEvent {
    /// El proveedor entregó el id de su sesión. El Core lo fija en `provider_sessions`; no viaja en ningún Event.
    SessionBound { provider_ref: ProviderRef },
    /// Canal con que corre esta ejecución. `degraded` marca un respaldo; `reason` dice por qué se cayó al respaldo.
    Transport { kind: String, degraded: bool, reason: Option<String> },
    /// Modelo EFECTIVO con el que corre (puede diferir del pedido).
    Model { model: String },
    Output { text: String },
    Question { question_id: String, text: String },
    /// El proveedor pide permiso para usar una herramienta. El Core decide (policy) y responde con `answer`, con el texto
    /// `allow` o `deny`; el adapter nunca responde por su cuenta.
    Permission { request_id: String, tool: String, summary: String },
    /// El proveedor usa una herramienta (un hecho, no una petición). `summary` es corto: nunca el contenido completo.
    ToolUse { tool: String, summary: String },
    /// El proveedor reintenta una llamada de red: informativo, la ejecución sigue.
    Retry { attempt: u32, max: u32, delay_ms: u64 },
    /// Uso total al terminar. `None` = el proveedor no lo informó: desconocido, NUNCA cero.
    Usage { input_tokens: Option<u64>, output_tokens: Option<u64>, cache_read_tokens: Option<u64>, cache_creation_tokens: Option<u64>, cost_usd: Option<f64> },
}

/// Cómo terminó una ejecución. Un fallo del proveedor es un RESULTADO (`Failed`); un error de la llamada (`Err`) es que
/// la operación no se pudo atender.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunOutcome {
    Completed { summary: Option<String> },
    Interrupted,
    Cancelled,
    Failed(AdapterError),
}

pub trait EventSink {
    fn push(&mut self, event: AdapterEvent);
}

impl<F: FnMut(AdapterEvent)> EventSink for F {
    fn push(&mut self, event: AdapterEvent) {
        self(event)
    }
}

/// Redacta todo texto que sale hacia el Core (invariante 5). [`Gated::events`] siempre lo pone delante del sink del Core.
struct RedactingSink<'a> {
    inner: &'a mut dyn EventSink,
}

impl EventSink for RedactingSink<'_> {
    fn push(&mut self, event: AdapterEvent) {
        // Sin rama comodín: una variante nueva obliga a decidir aquí qué se redacta.
        let event = match event {
            AdapterEvent::Output { text } => AdapterEvent::Output { text: redact(&text) },
            AdapterEvent::Question { question_id, text } => AdapterEvent::Question { question_id, text: redact(&text) },
            AdapterEvent::Model { model } => AdapterEvent::Model { model: redact(&model) },
            AdapterEvent::Permission { request_id, tool, summary } => AdapterEvent::Permission { request_id, tool: redact(&tool), summary: redact(&summary) },
            AdapterEvent::ToolUse { tool, summary } => AdapterEvent::ToolUse { tool: redact(&tool), summary: redact(&summary) },
            AdapterEvent::Transport { kind, degraded, reason } => AdapterEvent::Transport { kind: redact(&kind), degraded, reason: reason.map(|r| redact(&r)) },
            keep @ (AdapterEvent::SessionBound { .. } | AdapterEvent::Retry { .. } | AdapterEvent::Usage { .. }) => keep,
        };
        self.inner.push(event);
    }
}

/// La interfaz de un proveedor. Solo `id`, `probe`, `start` y `events` son obligatorios; el resto tiene un valor por
/// defecto que RECHAZA con `unsupported_capability`: un adapter que no implementa `steer` no puede fingir que lo hace.
pub trait ProviderAdapter: Send + Sync {
    /// Id estable del proveedor (`[a-z0-9-]`, hasta 64).
    fn id(&self) -> &str;

    /// Qué ofrece y si el entorno lo permite. No arranca ninguna ejecución y no falla un Attempt.
    fn probe(&self) -> ProbeResult;

    fn start(&self, req: StartRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError>;

    /// Bloquea hasta el final de la ejecución, entregando los hechos al `sink`. Mira `cancel` entre pasos.
    fn events(&self, run: &RunHandle, cancel: &CancelToken, sink: &mut dyn EventSink) -> Result<RunOutcome, AdapterError>;

    fn answer(&self, _run: &RunHandle, _answer: Answer) -> Result<(), AdapterError> {
        Err(AdapterError::unsupported(Capability::Answer))
    }

    fn interrupt(&self, _run: &RunHandle) -> Result<(), AdapterError> {
        Err(AdapterError::unsupported(Capability::Interrupt))
    }

    fn steer(&self, _run: &RunHandle, _instruction: &str) -> Result<(), AdapterError> {
        Err(AdapterError::unsupported(Capability::Steer))
    }

    fn resume(&self, _req: ResumeRequest, _cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        Err(AdapterError::unsupported(Capability::Resume))
    }
}

/// Un adapter visto a través de su matriz: cada llamada comprueba primero que la capability esté disponible y, si no,
/// devuelve el error estable de su estado SIN llegar al adapter. Es el único camino que usa el Core.
pub struct Gated<'a> {
    adapter: &'a dyn ProviderAdapter,
    matrix: &'a CapabilityMatrix,
}

impl<'a> Gated<'a> {
    pub fn new(adapter: &'a dyn ProviderAdapter, matrix: &'a CapabilityMatrix) -> Gated<'a> {
        Gated { adapter, matrix }
    }

    pub fn id(&self) -> &str {
        self.adapter.id()
    }

    pub fn matrix(&self) -> &CapabilityMatrix {
        self.matrix
    }

    /// Para un nombre de capability que llega de fuera (un cliente, un comando): desconocida → `unknown_capability`.
    pub fn require_named(&self, code: &str) -> Result<Capability, AdapterError> {
        let cap = Capability::parse_or_error(code)?;
        self.matrix.require(cap)?;
        Ok(cap)
    }

    pub fn start(&self, req: StartRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        self.matrix.require(Capability::Start)?;
        cancel.check()?;
        self.adapter.start(req, cancel)
    }

    pub fn events(&self, run: &RunHandle, cancel: &CancelToken, sink: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        self.matrix.require(Capability::Events)?;
        self.adapter.events(run, cancel, &mut RedactingSink { inner: sink })
    }

    pub fn answer(&self, run: &RunHandle, answer: Answer) -> Result<(), AdapterError> {
        self.matrix.require(Capability::Answer)?;
        self.adapter.answer(run, Answer { question_id: answer.question_id, text: answer.text })
    }

    pub fn interrupt(&self, run: &RunHandle) -> Result<(), AdapterError> {
        self.matrix.require(Capability::Interrupt)?;
        self.adapter.interrupt(run)
    }

    pub fn steer(&self, run: &RunHandle, instruction: &str) -> Result<(), AdapterError> {
        self.matrix.require(Capability::Steer)?;
        self.adapter.steer(run, instruction)
    }

    pub fn resume(&self, req: ResumeRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        self.matrix.require(Capability::Resume)?;
        cancel.check()?;
        self.adapter.resume(req, cancel)
    }
}
