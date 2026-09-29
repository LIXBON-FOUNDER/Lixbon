//! Ventana de Lixbon Team: hermana de `main`, con su propio documento
//! (team.html). Comparte con el IDE la sesión, que vive en el almacén cifrado.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const VENTANA: &str = "team";

// async: creado en el hilo principal, el builder espera a un bucle de eventos
// que no avanza mientras el propio comando lo ocupa, y el IDE se congela.
#[tauri::command(async)]
pub fn team_abrir(app: AppHandle) -> Result<(), String> {
    if let Some(ventana) = app.get_webview_window(VENTANA) {
        let _ = ventana.unminimize();
        let _ = ventana.show();
        let _ = ventana.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, VENTANA, WebviewUrl::App("team.html".into()))
        .title("Lixbon Team")
        .inner_size(1280.0, 820.0)
        .min_inner_size(960.0, 620.0)
        .decorations(false)
        // Con el drag-drop nativo, Windows se queda los archivos y el chat no los recibe.
        .disable_drag_drop_handler()
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn apagar(app: &AppHandle) {
    if let Some(ventana) = app.get_webview_window(VENTANA) {
        let _ = ventana.destroy();
    }
}
