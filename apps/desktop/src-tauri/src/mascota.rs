//! Aviso flotante de la mascota (mascota.html): cuando el agente termina y el
//! IDE no tiene el foco, Gael o Leya aparecen sobre las demás apps, en la
//! esquina inferior derecha del monitor donde está el IDE. La ventana no roba
//! el foco ni sale en la barra de tareas.
//!
//! El IDE decide qué decir (aviso, látigo…) y lo manda como JSON; la ventana
//! lo pide al abrirse (`mascota_datos`) y escucha `mascota:datos` para los
//! cambios mientras sigue abierta.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder};

pub const VENTANA: &str = "mascota";
const ANCHO: f64 = 400.0;
const ALTO: f64 = 320.0;
const MARGEN: f64 = 12.0;

/// Lo último que se pidió mostrar, para la ventana recién creada.
pub struct MascotaDatos(pub Mutex<String>);

// async: el builder espera al bucle de eventos (ver team::team_abrir).
#[tauri::command(async)]
pub fn mascota_flotante(app: AppHandle, estado: State<'_, MascotaDatos>, datos: String) -> Result<(), String> {
    if let Ok(mut d) = estado.0.lock() {
        *d = datos.clone();
    }
    if let Some(ventana) = app.get_webview_window(VENTANA) {
        app.emit_to(VENTANA, "mascota:datos", datos).map_err(|e| e.to_string())?;
        let _ = ventana.show();
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(&app, VENTANA, WebviewUrl::App("mascota.html".into()))
        .title("Lixbon")
        .inner_size(ANCHO, ALTO)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .shadow(false)
        .visible(false);
    // La transparencia en macOS exige la API privada; allí la ventana lleva
    // fondo propio (ver src/mascota).
    #[cfg(not(target_os = "macos"))]
    let builder = builder.transparent(true);
    let ventana = builder.build().map_err(|e| e.to_string())?;

    // Esquina inferior derecha del área útil (sin la barra de tareas) del
    // monitor del IDE; si no se sabe, la del monitor principal.
    let monitor = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .or_else(|| ventana.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let escala = m.scale_factor();
        let area = m.work_area();
        let x = area.position.x as f64 + area.size.width as f64 - (ANCHO + MARGEN) * escala;
        let y = area.position.y as f64 + area.size.height as f64 - (ALTO + MARGEN) * escala;
        let _ = ventana.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }
    ventana.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mascota_datos(estado: State<'_, MascotaDatos>) -> String {
    estado.0.lock().map(|d| d.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn mascota_flotante_cerrar(app: AppHandle) {
    apagar(&app);
}

/// «Volver a lixbon»: trae el IDE al frente y quita el aviso.
#[tauri::command]
pub fn mascota_volver(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
    apagar(&app);
}

pub fn apagar(app: &AppHandle) {
    if let Some(ventana) = app.get_webview_window(VENTANA) {
        let _ = ventana.destroy();
    }
}
