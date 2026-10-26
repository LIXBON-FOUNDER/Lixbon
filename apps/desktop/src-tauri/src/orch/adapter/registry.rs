//! Registro de adapters (LXO-128): qué proveedores conoce el Core y qué ofrece cada uno AHORA. Es DATO, no ramas: los
//! clientes leen el [`RegistrySnapshot`] y pintan lo que dice cada matriz; añadir un proveedor es registrar su adapter, sin
//! tocar ningún cliente. `generation` sube cada vez que algo cambia (un proveedor nuevo o una matriz distinta tras un
//! `refresh`), para que un cliente detecte el cambio sin reiniciar la app.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::{AdapterError, CapabilityMatrix, Environment, Gated, ProbeResult, ProviderAdapter};

/// Versión del formato del snapshot (`docs/core/fixtures/api/provider_capabilities.v1.json`).
pub const SNAPSHOT_VERSION: u32 = 1;

const MAX_ID_CHARS: usize = 64;

/// Lo que ve un cliente de un proveedor registrado.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ProviderEntry {
    pub id: String,
    pub cli_version: Option<String>,
    pub environment: Environment,
    pub matrix: CapabilityMatrix,
    /// Canal con que habla el adapter (`app_server`, `exec_json`…), si tiene más de uno.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct RegistrySnapshot {
    pub version: u32,
    pub generation: u64,
    pub providers: Vec<ProviderEntry>,
}

struct Entry {
    adapter: Arc<dyn ProviderAdapter>,
    probe: ProbeResult,
}

#[derive(Default)]
pub struct AdapterRegistry {
    entries: BTreeMap<String, Entry>,
    generation: u64,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_CHARS && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

impl AdapterRegistry {
    pub fn new() -> AdapterRegistry {
        AdapterRegistry::default()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Registra un adapter y lee su matriz. Un id inválido o repetido se rechaza: dos adapters no comparten identidad.
    pub fn register(&mut self, adapter: Arc<dyn ProviderAdapter>) -> Result<(), AdapterError> {
        let id = adapter.id().to_string();
        if !valid_id(&id) {
            return Err(AdapterError::invalid("el id del proveedor es `[a-z0-9-]`, de 1 a 64 caracteres"));
        }
        if self.entries.contains_key(&id) {
            return Err(AdapterError::invalid(&format!("el proveedor {id} ya está registrado")));
        }
        let probe = adapter.probe();
        self.entries.insert(id, Entry { adapter, probe });
        self.generation += 1;
        Ok(())
    }

    /// Vuelve a preguntar al proveedor. `true` si su matriz, su entorno o su versión cambiaron (y sube `generation`).
    pub fn refresh(&mut self, id: &str) -> Result<bool, AdapterError> {
        let entry = self.entries.get_mut(id).ok_or_else(|| AdapterError::unknown_provider(id))?;
        let probe = entry.adapter.probe();
        let changed = probe != entry.probe;
        if changed {
            entry.probe = probe;
            self.generation += 1;
        }
        Ok(changed)
    }

    /// `refresh` de todos. `true` si alguno cambió.
    pub fn refresh_all(&mut self) -> bool {
        let ids: Vec<String> = self.entries.keys().cloned().collect();
        ids.iter().fold(false, |any, id| self.refresh(id).unwrap_or(false) || any)
    }

    /// El adapter a través de su matriz: lo único que debe usar el Core para llamarlo.
    pub fn gated(&self, id: &str) -> Result<Gated<'_>, AdapterError> {
        let e = self.entries.get(id).ok_or_else(|| AdapterError::unknown_provider(id))?;
        Ok(Gated::new(e.adapter.as_ref(), &e.probe.matrix))
    }

    pub fn snapshot(&self) -> RegistrySnapshot {
        RegistrySnapshot {
            version: SNAPSHOT_VERSION,
            generation: self.generation,
            providers: self
                .entries
                .iter()
                .map(|(id, e)| ProviderEntry { id: id.clone(), cli_version: e.probe.cli_version.clone(), environment: e.probe.environment.clone(), matrix: e.probe.matrix.clone(), transport: e.probe.transport.clone() })
                .collect(),
        }
    }
}
