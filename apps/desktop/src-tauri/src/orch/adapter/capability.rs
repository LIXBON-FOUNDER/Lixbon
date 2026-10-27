//! Matriz de capabilities de un adapter (LXO-128). Es el ÚNICO dato por el que un cliente decide qué ofrecer: nunca el
//! nombre ni la versión del proveedor. Una capability ausente no se simula: la matriz siempre trae las seis, y lo que el
//! proveedor no ofrece consta como `unsupported`, no como un hueco.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::error::AdapterError;
use super::redact::safe_text;
use crate::orch::agents::EnvBlock;

/// Versión del formato de la matriz. Subirla es un cambio de contrato (`docs/core/ADAPTERS.md#compatibilidad`).
pub const MATRIX_VERSION: u32 = 1;

const MAX_REASON_CHARS: usize = 200;

/// Lo que un adapter puede hacer además de `probe` (que todo adapter tiene). Conjunto CERRADO y versionado con la matriz.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Start,
    Events,
    Answer,
    Interrupt,
    Steer,
    Resume,
}

impl Capability {
    pub const ALL: [Capability; 6] =
        [Capability::Start, Capability::Events, Capability::Answer, Capability::Interrupt, Capability::Steer, Capability::Resume];

    pub fn code(self) -> &'static str {
        match self {
            Capability::Start => "start",
            Capability::Events => "events",
            Capability::Answer => "answer",
            Capability::Interrupt => "interrupt",
            Capability::Steer => "steer",
            Capability::Resume => "resume",
        }
    }

    pub fn parse(code: &str) -> Option<Capability> {
        Capability::ALL.into_iter().find(|c| c.code() == code)
    }

    /// Como [`Capability::parse`], con el error estable `unknown_capability` para un nombre que no existe.
    pub fn parse_or_error(code: &str) -> Result<Capability, AdapterError> {
        Capability::parse(code).ok_or_else(|| AdapterError::unknown_capability(code))
    }
}

/// Estado de una capability. Los cuatro estados son los que muestra Desktop: `environment_blocked` NO es `unsupported`
/// (el proveedor sí lo ofrece, el entorno lo impide) y ninguno de los dos es un Attempt fallido.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CapabilityState {
    Available,
    /// El proveedor no la ofrece, por diseño.
    Unsupported,
    /// La ofrece pero ahora no (sin autenticar, degradada…). `reason` ya viene redactado y acotado.
    Unavailable { reason: String },
    /// El entorno impide usarla.
    EnvironmentBlocked { block: EnvBlock },
}

impl CapabilityState {
    pub fn unavailable(reason: &str) -> CapabilityState {
        CapabilityState::Unavailable { reason: safe_text(reason, MAX_REASON_CHARS) }
    }

    pub fn is_available(&self) -> bool {
        matches!(self, CapabilityState::Available)
    }

    pub fn code(&self) -> &'static str {
        match self {
            CapabilityState::Available => "available",
            CapabilityState::Unsupported => "unsupported",
            CapabilityState::Unavailable { .. } => "unavailable",
            CapabilityState::EnvironmentBlocked { .. } => "environment_blocked",
        }
    }
}

/// Las seis capabilities, todas presentes. Se construye en `unsupported` y se declara solo lo que el proveedor ofrece.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct CapabilityMatrix {
    pub version: u32,
    pub capabilities: BTreeMap<Capability, CapabilityState>,
}

impl Default for CapabilityMatrix {
    fn default() -> Self {
        CapabilityMatrix::new()
    }
}

impl CapabilityMatrix {
    /// Todo `unsupported`: lo que no se declara no existe.
    pub fn new() -> CapabilityMatrix {
        CapabilityMatrix { version: MATRIX_VERSION, capabilities: Capability::ALL.into_iter().map(|c| (c, CapabilityState::Unsupported)).collect() }
    }

    /// Todo `available` (adapters completos y el fake de pruebas).
    pub fn all_available() -> CapabilityMatrix {
        Capability::ALL.into_iter().fold(CapabilityMatrix::new(), |m, c| m.with(c, CapabilityState::Available))
    }

    /// Todo bloqueado por el mismo bloqueo de entorno (la CLI no está, por ejemplo).
    pub fn all_blocked(block: EnvBlock) -> CapabilityMatrix {
        Capability::ALL.into_iter().fold(CapabilityMatrix::new(), |m, c| m.with(c, CapabilityState::EnvironmentBlocked { block }))
    }

    pub fn with(mut self, cap: Capability, state: CapabilityState) -> CapabilityMatrix {
        self.capabilities.insert(cap, state);
        self
    }

    pub fn state(&self, cap: Capability) -> &CapabilityState {
        // `new` y la validación al leer garantizan las seis entradas.
        self.capabilities.get(&cap).unwrap_or(&CapabilityState::Unsupported)
    }

    pub fn is_available(&self, cap: Capability) -> bool {
        self.state(cap).is_available()
    }

    /// `Ok` si la capability está disponible; si no, el error estable que corresponde a su estado.
    pub fn require(&self, cap: Capability) -> Result<(), AdapterError> {
        match self.state(cap) {
            CapabilityState::Available => Ok(()),
            CapabilityState::Unsupported => Err(AdapterError::unsupported(cap)),
            CapabilityState::Unavailable { reason } => Err(AdapterError::unavailable(cap, reason)),
            CapabilityState::EnvironmentBlocked { block } => Err(AdapterError::environment_blocked(*block)),
        }
    }

    fn validate(version: u32, capabilities: &BTreeMap<Capability, CapabilityState>) -> Result<(), String> {
        if version != MATRIX_VERSION {
            return Err(format!("versión de matriz desconocida: {version} (esta build entiende la {MATRIX_VERSION})"));
        }
        if let Some(missing) = Capability::ALL.into_iter().find(|c| !capabilities.contains_key(c)) {
            return Err(format!("a la matriz le falta `{}`: lo que no se ofrece se declara `unsupported`", missing.code()));
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct RawMatrix {
    version: u32,
    capabilities: BTreeMap<Capability, CapabilityState>,
}

impl<'de> Deserialize<'de> for CapabilityMatrix {
    /// Una matriz con versión desconocida, con una capability de menos o con un nombre que no existe no se acepta.
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = RawMatrix::deserialize(d)?;
        CapabilityMatrix::validate(raw.version, &raw.capabilities).map_err(serde::de::Error::custom)?;
        Ok(CapabilityMatrix { version: raw.version, capabilities: raw.capabilities })
    }
}
