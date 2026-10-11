//! Sesión de dispositivo del IDE: un access de 30 min y un refresh que rota en
//! cada uso. Vive aquí y no en el WebView para que la ventana principal, la de
//! Team y `lxo issue` compartan una sola copia: el candado impide que dos
//! renueven a la vez con el mismo refresh, que el servidor tomaría como robado
//! y cerraría la sesión.
//!
//! En Windows se guarda en el Credential Manager; en el resto, en
//! `session.json` dentro de los datos de la app, solo legible por su dueño.

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::async_runtime::Mutex;
use tauri::AppHandle;
use tauri_plugin_http::reqwest;

/// Se renueva un poco antes de caducar: una petición larga que sale con un
/// access a punto de expirar no debe recibir 401 a medias.
const MARGEN_SEG: i64 = 120;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Sesion {
    pub servidor: String,
    pub access: String,
    pub refresh: String,
    /// Segundos Unix en que caduca el access.
    pub expira: i64,
}

#[derive(Serialize)]
pub struct Token {
    token: String,
    expira: i64,
}

fn candado() -> &'static Mutex<()> {
    static CANDADO: OnceLock<Mutex<()>> = OnceLock::new();
    CANDADO.get_or_init(|| Mutex::new(()))
}

fn ahora() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(windows)]
mod almacen {
    use super::Sesion;
    use tauri::AppHandle;

    const NOMBRE: &str = "session";

    pub fn leer(_app: &AppHandle) -> Option<Sesion> {
        crate::secret_get(NOMBRE.into()).ok().flatten().and_then(|t| serde_json::from_str(&t).ok())
    }

    pub fn guardar(_app: &AppHandle, s: &Sesion) -> Result<(), String> {
        crate::secret_set(NOMBRE.into(), serde_json::to_string(s).map_err(|e| e.to_string())?)
    }

    pub fn borrar(_app: &AppHandle) {
        let _ = crate::secret_delete(NOMBRE.into());
    }
}

#[cfg(not(windows))]
mod almacen {
    use super::Sesion;
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager};

    fn ruta(app: &AppHandle) -> Option<PathBuf> {
        app.path().app_data_dir().ok().map(|d| d.join("session.json"))
    }

    pub fn leer(app: &AppHandle) -> Option<Sesion> {
        let texto = std::fs::read_to_string(ruta(app)?).ok()?;
        serde_json::from_str(&texto).ok()
    }

    pub fn guardar(app: &AppHandle, s: &Sesion) -> Result<(), String> {
        use std::io::Write;
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let ruta = ruta(app).ok_or("Sin carpeta de datos de la app")?;
        if let Some(dir) = ruta.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = ruta.with_extension("json.tmp");
        let mut opciones = std::fs::OpenOptions::new();
        opciones.write(true).create(true).truncate(true);
        #[cfg(unix)]
        opciones.mode(0o600);
        let mut f = opciones.open(&tmp).map_err(|e| e.to_string())?;
        f.write_all(serde_json::to_string(s).map_err(|e| e.to_string())?.as_bytes())
            .map_err(|e| e.to_string())?;
        drop(f);
        std::fs::rename(&tmp, &ruta).map_err(|e| e.to_string())
    }

    pub fn borrar(app: &AppHandle) {
        if let Some(r) = ruta(app) {
            let _ = std::fs::remove_file(r);
        }
    }
}

enum Fallo {
    /// El refresh ya no vale: hay que volver a iniciar sesión.
    Rechazado,
    Red(String),
}

async fn renovar(s: &Sesion) -> Result<Sesion, Fallo> {
    let res = reqwest::Client::new()
        .post(format!("{}/api/auth/refresh", s.servidor))
        .header("Content-Type", "application/json")
        .body(json!({ "refresh_token": s.refresh }).to_string())
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| Fallo::Red(format!("No se pudo contactar con Lixbon: {e}")))?;
    let estado = res.status();
    if estado.as_u16() == 401 {
        return Err(Fallo::Rechazado);
    }
    if !estado.is_success() {
        return Err(Fallo::Red(format!("Lixbon respondió {estado}")));
    }
    let datos: Value = serde_json::from_str(&res.text().await.unwrap_or_default()).unwrap_or(Value::Null);
    match (datos["access_token"].as_str(), datos["refresh_token"].as_str(), datos["expires_in"].as_i64()) {
        (Some(access), Some(refresh), Some(segundos)) => Ok(Sesion {
            servidor: s.servidor.clone(),
            access: access.to_string(),
            refresh: refresh.to_string(),
            expira: ahora() + segundos,
        }),
        _ => Err(Fallo::Red("Respuesta inesperada al renovar la sesión".into())),
    }
}

/// La sesión con un access vigente, renovándolo si está por caducar o si
/// `rechazado` es el access que acaba de recibir un 401. `Ok(None)`: no hay
/// sesión de dispositivo (se entró con una API key, o no se entró).
/// Sin red se devuelve el access que hay: cuando vuelva, otra llamada renovará.
pub async fn vigente(app: &AppHandle, rechazado: Option<&str>) -> Result<Option<Sesion>, String> {
    let _turno = candado().lock().await;
    let Some(actual) = almacen::leer(app) else { return Ok(None) };
    let forzar = rechazado == Some(actual.access.as_str());
    if !forzar && actual.expira - ahora() > MARGEN_SEG {
        return Ok(Some(actual));
    }
    match renovar(&actual).await {
        Ok(nueva) => {
            almacen::guardar(app, &nueva)?;
            Ok(Some(nueva))
        }
        Err(Fallo::Rechazado) => {
            almacen::borrar(app);
            Err("session_expired".into())
        }
        Err(Fallo::Red(e)) if forzar => Err(e),
        Err(Fallo::Red(_)) => Ok(Some(actual)),
    }
}

#[tauri::command]
pub async fn auth_session_start(
    app: AppHandle,
    servidor: String,
    access: String,
    refresh: String,
    expires_in: i64,
) -> Result<(), String> {
    let _turno = candado().lock().await;
    let s = Sesion { servidor: servidor.trim_end_matches('/').to_string(), access, refresh, expira: ahora() + expires_in };
    almacen::guardar(&app, &s)
}

#[tauri::command]
pub async fn auth_token(app: AppHandle, stale: Option<String>) -> Result<Option<Token>, String> {
    Ok(vigente(&app, stale.as_deref()).await?.map(|s| Token { token: s.access, expira: s.expira }))
}

/// Cierra la sesión en el servidor (si hay red) y la olvida aquí.
#[tauri::command]
pub async fn auth_logout(app: AppHandle) -> Result<(), String> {
    let _turno = candado().lock().await;
    if let Some(s) = almacen::leer(&app) {
        let _ = reqwest::Client::new()
            .post(format!("{}/api/auth/logout", s.servidor))
            .header("Content-Type", "application/json")
            .body(json!({ "refresh_token": s.refresh }).to_string())
            .timeout(Duration::from_secs(10))
            .send()
            .await;
    }
    almacen::borrar(&app);
    Ok(())
}

/// Nombre del equipo para la lista de sesiones de la cuenta.
#[tauri::command]
pub fn device_name() -> Option<String> {
    #[cfg(windows)]
    let nombre = std::env::var("COMPUTERNAME").ok();
    #[cfg(target_os = "macos")]
    let nombre = std::process::Command::new("scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok());
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let nombre = std::fs::read_to_string("/etc/hostname").ok();
    nombre.map(|n| n.trim().to_string()).filter(|n| !n.is_empty())
}

