//! Frontera entre el dominio del Core y quien lo aloja (el «host»).
//!
//! Principio: el Core posee el estado; los clientes (y el host que lo aloja)
//! poseen capacidades y presentación. Hoy el único host es el Desktop
//! (`TauriHost`, en `tauri_host.rs`); más adelante puede haber un `DaemonHost`
//! (proceso `lixbon-core` independiente) sin reescribir el dominio. Este archivo
//! y el resto del dominio de `orch/` **no importan Tauri**: una prueba de
//! arquitectura (`tests.rs`) falla si alguien lo hace fuera del límite.
//!
//! # Auditoría: qué usa hoy el Core del host
//!
//! | Dependencia | ¿La usa el Core hoy? | Decisión |
//! |---|---|---|
//! | `AppHandle` | Sí, en `Core.app` (solo para emitir, notificar y obtener la cuenta) | Sustituido por `Arc<dyn Host>`; el `AppHandle` vive solo en `TauriHost` |
//! | Eventos (`emit`) | Sí: `orch:changed`, `orch:term:{id}`, `orch:term-exit:{id}`, `orch-task-reviewed`, `orch-spawn-pending/resolved` | `Host::emit` |
//! | Notificaciones del sistema | Sí: `commit` (mensajes nuevos) y `notify_pending` (lanzamiento pendiente) | `Host::notify` |
//! | Cuenta/sesión + almacén seguro | Sí, solo en `lxo issue` (sesión de dispositivo, o API key del almacén de credenciales) | `Host::gateway`: el host resuelve la cuenta y hace la petición al gateway |
//! | Carpeta de datos | No: `fsio::data_dir()` es `~/.lixbon/orch` (no usa `app_data_dir` de Tauri) | Sin método (futuro: lo reescribirá el slice C) |
//! | Procesos / PTY | No dependen de Tauri: `pty.rs` usa `portable-pty` y recibe cierres (callbacks) | Sin método. **Futuro:** propiedad de los procesos (E-PTY): un daemon necesitará un supervisor propio; no se resuelve aquí |
//! | Cierre (`shutdown`) | No usa Tauri; lo invoca `lib.rs` al destruirse la ventana | Sin método. **Futuro:** separar `detach()` de `stop()` |
//! | `codex_term` | Su `open` ya recibe un cierre `emit`; no es parte del Core (pestaña de la interfaz) | Sin cambios; el `AppHandle` queda en `commands.rs` |
//! | `skill.rs`, `term_events.rs`, `lifecycle.rs`, `server.rs` | No importan Tauri | Sin cambios (`lifecycle.rs::init` recibe el host) |
//!
//! Lo que no figura en la tabla como «Sí» **no** tiene método aquí a propósito.

use std::sync::Arc;

use serde_json::Value;

/// Verbos HTTP que el Core usa contra el gateway de Lixbon Team.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GatewayMethod {
    Get,
    Post,
    Patch,
}

/// Cliente del gateway de Lixbon con la cuenta de la persona ya resuelta por el
/// host (sesión de dispositivo o API key). El Core nunca ve la credencial.
pub struct Gateway(Box<dyn Fn(GatewayMethod, &str, Option<Value>) -> Result<Value, String> + Send + Sync>);

impl Gateway {
    pub fn new(f: impl Fn(GatewayMethod, &str, Option<Value>) -> Result<Value, String> + Send + Sync + 'static) -> Self {
        Self(Box::new(f))
    }

    /// `ruta` empieza por `/api/…`; devuelve el JSON de la respuesta o el motivo del fallo.
    pub fn request(&self, method: GatewayMethod, ruta: &str, cuerpo: Option<Value>) -> Result<Value, String> {
        (self.0)(method, ruta, cuerpo)
    }
}

/// Capacidades que el Core pide a quien lo aloja. Solo lo que el dominio usa hoy.
pub trait Host: Send + Sync {
    /// Avisa a los clientes conectados de un evento (el nombre y la carga útil
    /// son contrato con el frontend y no cambian).
    fn emit(&self, event: &str, payload: &Value);

    /// Notificación del sistema para la persona.
    fn notify(&self, title: &str, body: &str);

    /// Cliente del gateway con la cuenta de la persona. Falla con un mensaje
    /// legible si no hay sesión.
    fn gateway(&self) -> Result<Gateway, String>;
}

/// Host de prueba: anota lo que el Core emite y notifica y no toca ningún
/// sistema (ni ventanas ni red). Permite ejercitar el Core sin Tauri.
#[cfg(test)]
type GatewayFake = Arc<dyn Fn(GatewayMethod, &str, &Option<Value>) -> Result<Value, String> + Send + Sync>;

#[cfg(test)]
pub struct RecordingHost {
    events: std::sync::Mutex<Vec<(String, Value)>>,
    notifications: std::sync::Mutex<Vec<(String, String)>>,
    gateway_calls: Arc<std::sync::Mutex<Vec<(GatewayMethod, String, Option<Value>)>>>,
    /// Respuestas del gateway falso; sin ellas simula «sin sesión».
    gateway_fake: std::sync::Mutex<Option<GatewayFake>>,
}

#[cfg(test)]
impl RecordingHost {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            events: Default::default(),
            notifications: Default::default(),
            gateway_calls: Default::default(),
            gateway_fake: Default::default(),
        })
    }

    pub fn events(&self) -> Vec<(String, Value)> {
        self.events.lock().unwrap().clone()
    }

    /// Las cargas útiles de un tema, en orden.
    pub fn events_named(&self, name: &str) -> Vec<Value> {
        self.events().into_iter().filter(|(n, _)| n == name).map(|(_, v)| v).collect()
    }

    pub fn clear_events(&self) {
        self.events.lock().unwrap().clear();
    }

    pub fn notifications(&self) -> Vec<(String, String)> {
        self.notifications.lock().unwrap().clone()
    }

    pub fn gateway_calls(&self) -> Vec<(GatewayMethod, String, Option<Value>)> {
        self.gateway_calls.lock().unwrap().clone()
    }

    /// Activa la sesión falsa: `f` responde cada petición al gateway.
    pub fn set_gateway(&self, f: impl Fn(GatewayMethod, &str, &Option<Value>) -> Result<Value, String> + Send + Sync + 'static) {
        *self.gateway_fake.lock().unwrap() = Some(Arc::new(f));
    }
}

#[cfg(test)]
impl Host for RecordingHost {
    fn emit(&self, event: &str, payload: &Value) {
        self.events.lock().unwrap().push((event.to_string(), payload.clone()));
    }

    fn notify(&self, title: &str, body: &str) {
        self.notifications.lock().unwrap().push((title.to_string(), body.to_string()));
    }

    fn gateway(&self) -> Result<Gateway, String> {
        let fake = self.gateway_fake.lock().unwrap().clone().ok_or("No hay sesión de Lixbon: inicia sesión en el IDE")?;
        let calls = self.gateway_calls.clone();
        Ok(Gateway::new(move |m, ruta, cuerpo| {
            let reply = fake(m, ruta, &cuerpo);
            calls.lock().unwrap().push((m, ruta.to_string(), cuerpo));
            reply
        }))
    }
}
