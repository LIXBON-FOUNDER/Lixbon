//! Errores normalizados de un adapter (LXO-128, invariante 3): un código ESTABLE para que Core y clientes decidan sin
//! leer texto, un mensaje y, cuando sirve, el diagnóstico crudo ya redactado y acotado.

use std::fmt;

use serde::{Deserialize, Serialize};

use super::capability::Capability;
use super::redact::{safe_text, MAX_DIAGNOSTIC_CHARS};
use crate::orch::agents::EnvBlock;

const MAX_MESSAGE_CHARS: usize = 400;

/// Conjunto CERRADO. Añadir un código es un cambio de contrato (`docs/core/ADAPTERS.md`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// El nombre de capability no existe en este contrato.
    UnknownCapability,
    /// El proveedor no ofrece la capability (por diseño).
    UnsupportedCapability,
    /// La ofrece, pero ahora no (sin autenticar, degradado…).
    CapabilityUnavailable,
    /// El entorno impide usar el proveedor. No es un fallo del Attempt.
    EnvironmentBlocked,
    /// El Core canceló la operación.
    Cancelled,
    /// La petición no es válida (campos, referencia opaca con forma de credencial…).
    InvalidRequest,
    /// El adapter no conoce ese proveedor registrado.
    UnknownProvider,
    /// El adapter no conoce esa ejecución.
    UnknownRun,
    /// El proveedor falló mientras ejecutaba.
    Provider,
    /// Fallo del propio adapter.
    Internal,
}

impl ErrorCode {
    pub fn code(self) -> &'static str {
        match self {
            ErrorCode::UnknownCapability => "unknown_capability",
            ErrorCode::UnsupportedCapability => "unsupported_capability",
            ErrorCode::CapabilityUnavailable => "capability_unavailable",
            ErrorCode::EnvironmentBlocked => "environment_blocked",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::UnknownProvider => "unknown_provider",
            ErrorCode::UnknownRun => "unknown_run",
            ErrorCode::Provider => "provider",
            ErrorCode::Internal => "internal",
        }
    }
}

/// Qué hace el Core con un error: la clasificación vive aquí, en un solo sitio, para que "entorno bloqueado" no se
/// convierta en "Attempt fallido" por un `match` olvidado en otro lado.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureKind {
    /// La petición no se pudo atender y el Attempt no cambia (capability ausente, petición inválida…).
    Rejected,
    /// El entorno impide lanzar: `environment.blocked`, nunca `attempt.failed`.
    EnvironmentBlocked,
    /// Lo pidió el Core.
    Cancelled,
    /// El proveedor o el adapter fallaron ejecutando: ahí sí falla el Attempt.
    AttemptFailure,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct AdapterError {
    pub code: ErrorCode,
    pub message: String,
    /// Salida cruda del proveedor, redactada y acotada. Nunca con forma de credencial.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    /// El bloqueo de entorno, solo con `environment_blocked`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env_block: Option<EnvBlock>,
}

impl AdapterError {
    pub fn new(code: ErrorCode, message: &str) -> AdapterError {
        AdapterError { code, message: safe_text(message, MAX_MESSAGE_CHARS), diagnostic: None, env_block: None }
    }

    /// Añade el diagnóstico crudo del proveedor, ya redactado y acotado.
    pub fn with_diagnostic(mut self, raw: &str) -> AdapterError {
        self.diagnostic = Some(safe_text(raw, MAX_DIAGNOSTIC_CHARS));
        self
    }

    pub fn unknown_capability(code: &str) -> AdapterError {
        AdapterError::new(ErrorCode::UnknownCapability, &format!("capability desconocida: {code}"))
    }

    pub fn unsupported(cap: Capability) -> AdapterError {
        AdapterError::new(ErrorCode::UnsupportedCapability, &format!("el proveedor no ofrece `{}`", cap.code()))
    }

    pub fn unavailable(cap: Capability, reason: &str) -> AdapterError {
        AdapterError::new(ErrorCode::CapabilityUnavailable, &format!("`{}` no está disponible ahora: {reason}", cap.code()))
    }

    pub fn environment_blocked(block: EnvBlock) -> AdapterError {
        let mut e = AdapterError::new(ErrorCode::EnvironmentBlocked, &format!("el entorno impide usar el proveedor: {}", block.code()));
        e.env_block = Some(block);
        e
    }

    pub fn cancelled() -> AdapterError {
        AdapterError::new(ErrorCode::Cancelled, "operación cancelada")
    }

    pub fn invalid(message: &str) -> AdapterError {
        AdapterError::new(ErrorCode::InvalidRequest, message)
    }

    pub fn unknown_provider(id: &str) -> AdapterError {
        AdapterError::new(ErrorCode::UnknownProvider, &format!("proveedor no registrado: {id}"))
    }

    pub fn unknown_run() -> AdapterError {
        AdapterError::new(ErrorCode::UnknownRun, "ejecución desconocida para este adapter")
    }

    pub fn provider(message: &str) -> AdapterError {
        AdapterError::new(ErrorCode::Provider, message)
    }

    pub fn kind(&self) -> FailureKind {
        match self.code {
            ErrorCode::UnknownCapability
            | ErrorCode::UnsupportedCapability
            | ErrorCode::CapabilityUnavailable
            | ErrorCode::InvalidRequest
            | ErrorCode::UnknownProvider
            | ErrorCode::UnknownRun => FailureKind::Rejected,
            ErrorCode::EnvironmentBlocked => FailureKind::EnvironmentBlocked,
            ErrorCode::Cancelled => FailureKind::Cancelled,
            ErrorCode::Provider | ErrorCode::Internal => FailureKind::AttemptFailure,
        }
    }
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.code(), self.message)
    }
}

impl std::error::Error for AdapterError {}
