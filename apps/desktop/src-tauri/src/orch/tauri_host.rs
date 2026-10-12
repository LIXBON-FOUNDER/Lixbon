//! `TauriHost`: el host del Desktop. Es el único lugar (junto con `commands.rs`)
//! donde el orquestador conoce a Tauri: emite eventos a la webview, muestra las
//! notificaciones del sistema y resuelve la cuenta de la persona para hablar con
//! el gateway de Lixbon. El dominio solo ve el trait `Host` (ver `host.rs`).

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_http::reqwest::{self, Method};
use tauri_plugin_notification::NotificationExt;

use super::host::{Gateway, GatewayMethod, Host};

pub struct TauriHost(AppHandle);

impl TauriHost {
    /// El host que `lib.rs` entrega a `Core::init`.
    pub fn arc(app: AppHandle) -> Arc<dyn Host> {
        Arc::new(Self(app))
    }
}

impl Host for TauriHost {
    fn emit(&self, event: &str, payload: &Value) {
        let _ = self.0.emit(event, payload);
    }

    fn notify(&self, title: &str, body: &str) {
        let _ = self.0.notification().builder().title(title).body(body).show();
    }

    fn gateway(&self) -> Result<Gateway, String> {
        let s = sesion(&self.0)?;
        Ok(Gateway::new(move |metodo, ruta, cuerpo| pedir(&s, metodo, ruta, cuerpo)))
    }
}

/// La cuenta con la que se habla al gateway: la sesión de dispositivo o, si se
/// entró con una API key, esa llave (almacén de credenciales o ajustes).
struct Sesion {
    servidor: String,
    llave: String,
}

fn sesion(app: &AppHandle) -> Result<Sesion, String> {
    if let Some(s) = tauri::async_runtime::block_on(crate::auth_session::vigente(app, None))? {
        return Ok(Sesion { servidor: s.servidor, llave: s.access });
    }
    let ruta = app.path().app_data_dir().map_err(|e| e.to_string())?.join("lixbon.settings.json");
    let ajustes: Value = std::fs::read_to_string(&ruta)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    let servidor = ajustes
        .get("serverUrl")
        .and_then(Value::as_str)
        .unwrap_or("https://lixbon.com")
        .trim_end_matches('/')
        .to_string();
    let llave = crate::secret_get("apiKey".into())
        .ok()
        .flatten()
        .or_else(|| ajustes.get("apiKey").and_then(Value::as_str).map(String::from))
        .filter(|k| !k.is_empty())
        .ok_or("No hay sesión de Lixbon: inicia sesión en el IDE")?;
    Ok(Sesion { servidor, llave })
}

fn pedir(s: &Sesion, metodo: GatewayMethod, ruta: &str, cuerpo: Option<Value>) -> Result<Value, String> {
    let metodo = match metodo {
        GatewayMethod::Get => Method::GET,
        GatewayMethod::Post => Method::POST,
        GatewayMethod::Patch => Method::PATCH,
    };
    let url = format!("{}{}", s.servidor, ruta);
    let llave = s.llave.clone();
    tauri::async_runtime::block_on(async move {
        let mut req = reqwest::Client::new()
            .request(metodo, url)
            .header("Authorization", format!("Bearer {llave}"))
            .timeout(Duration::from_secs(20));
        if let Some(c) = cuerpo {
            req = req.header("Content-Type", "application/json").body(c.to_string());
        }
        let res = req.send().await.map_err(|e| format!("No se pudo contactar con Lixbon: {e}"))?;
        let estado = res.status();
        let texto = res.text().await.unwrap_or_default();
        let datos: Value = serde_json::from_str(&texto).unwrap_or(Value::Null);
        if !estado.is_success() {
            return Err(datos
                .get("detail")
                .and_then(Value::as_str)
                .map(String::from)
                .unwrap_or_else(|| format!("Lixbon respondió {estado}")));
        }
        Ok(datos)
    })
}
