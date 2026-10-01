//! Ventana de Lixbon Team: hermana de `main`, con su propio documento
//! (team.html). Comparte con el IDE la sesión, que vive en el almacén cifrado.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const VENTANA: &str = "team";
/// Argumento del acceso directo «Lixbon Team»: abre solo la ventana de Team.
pub const SOLO_TEAM: &str = "--team";

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

/// Arrancada desde el acceso directo «Lixbon Team»: el IDE se queda oculto
/// (su sesión sigue viva detrás) y solo se ve Team.
pub fn al_arrancar(app: &AppHandle) {
    if !std::env::args().any(|a| a == SOLO_TEAM) {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let _ = team_abrir(app);
    });
}

/// Otra copia lanzada con la app abierta: con --team se abre Team; sin él, se
/// trae el IDE al frente.
pub fn segunda_instancia(app: &AppHandle, argv: &[String]) {
    if argv.iter().any(|a| a == SOLO_TEAM) {
        let app = app.clone();
        std::thread::spawn(move || {
            let _ = team_abrir(app);
        });
    } else if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// Si Team era lo único visible (se abrió con el acceso directo y el IDE nunca
/// se mostró), cerrarla cierra la app: no queda un proceso invisible.
pub fn al_cerrar_team(app: &AppHandle) {
    let ide_oculto = app
        .get_webview_window("main")
        .map(|w| !w.is_visible().unwrap_or(true))
        .unwrap_or(true);
    if ide_oculto {
        app.exit(0);
    }
}

