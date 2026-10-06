//! Servidores MCP (Model Context Protocol) por stdio. El backend solo lanza el
//! proceso y mueve líneas JSON-RPC en ambos sentidos; el protocolo lo habla el
//! frontend (`src/lib/mcp.js`), igual que el CLI hace en `lixbon_cli/mcp.py`.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;

use tauri::{AppHandle, Emitter, State};

struct McpProc {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct McpServers(Mutex<HashMap<String, McpProc>>);

pub(crate) fn kill_tree(child: &mut Child) {
    // En Windows el servidor corre bajo `cmd /C` (npx, uvx… son .cmd): matar
    // solo cmd dejaría vivo el node/python hijo.
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::hide_console(&mut cmd);
        let _ = cmd.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl McpServers {
    pub fn stop_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, mut proc_) in map.drain() {
                kill_tree(&mut proc_.child);
            }
        }
    }
}

fn user_config_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".lixbon").join("mcp.json"))
}

#[tauri::command]
pub fn mcp_start(
    app: AppHandle,
    servers: State<'_, McpServers>,
    id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    cwd: Option<String>,
) -> Result<(), String> {
    if let Some(mut old) = servers.0.lock().map_err(|e| e.to_string())?.remove(&id) {
        kill_tree(&mut old.child);
    }

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&command);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new(&command);

    cmd.args(&args)
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    crate::hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("no se pudo lanzar «{command}»: {e}"))?;
    let stdin = child.stdin.take().ok_or("el proceso no expone stdin")?;
    let stdout = child.stdout.take().ok_or("el proceso no expone stdout")?;

    let line_event = format!("mcp:line:{id}");
    let exit_event = format!("mcp:exit:{id}");
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    if app.emit(&line_event, l).is_err() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = app.emit(&exit_event, ());
    });

    servers
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, McpProc { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn mcp_send(servers: State<'_, McpServers>, id: String, line: String) -> Result<(), String> {
    let mut map = servers.0.lock().map_err(|e| e.to_string())?;
    let proc_ = map.get_mut(&id).ok_or_else(|| format!("el servidor «{id}» no está en marcha"))?;
    proc_
        .stdin
        .write_all(line.as_bytes())
        .and_then(|_| proc_.stdin.write_all(b"\n"))
        .and_then(|_| proc_.stdin.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_stop(servers: State<'_, McpServers>, id: String) -> Result<(), String> {
    if let Some(mut proc_) = servers.0.lock().map_err(|e| e.to_string())?.remove(&id) {
        kill_tree(&mut proc_.child);
    }
    Ok(())
}

/// `~/.lixbon/mcp.json` (fuera del workspace, por eso no pasa por read_file_content).
#[tauri::command]
pub fn mcp_user_config() -> Result<Option<String>, String> {
    let Some(path) = user_config_path() else { return Ok(None) };
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// settings.json o keybindings.json del VS Code del usuario (para importar sus
/// preferencias en el onboarding). Solo esos dos nombres: no es un lector de
/// archivos arbitrario fuera de la carpeta de trabajo.
#[tauri::command]
pub fn vscode_user_file(name: String) -> Result<Option<String>, String> {
    if name != "settings.json" && name != "keybindings.json" {
        return Err("archivo no permitido".into());
    }
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config"));
    let Some(base) = base else { return Ok(None) };
    for app in ["Code", "Cursor", "Code - Insiders"] {
        if let Ok(text) = fs::read_to_string(base.join(app).join("User").join(&name)) {
            return Ok(Some(text));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn mcp_save_user_config(content: String) -> Result<String, String> {
    serde_json::from_str::<serde_json::Value>(&content).map_err(|e| format!("JSON inválido: {e}"))?;
    let path = user_config_path().ok_or("no se encontró la carpeta del usuario")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

fn app_data() -> Option<PathBuf> {
    #[cfg(windows)]
    return std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    return home().map(|h| h.join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    return home().map(|h| h.join(".config"));
}

#[derive(serde::Serialize)]
pub struct McpImportSource {
    source: String,
    path: String,
    servers: serde_json::Value,
}

fn servers_in(v: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = v.get("mcpServers").or_else(|| v.get("servers")).or_else(|| v.get("mcp").and_then(|m| m.get("servers")))?;
    obj.as_object().filter(|o| !o.is_empty()).map(|_| obj.clone())
}

/// MCP que el usuario ya tiene en otros agentes, para importarlos. Solo se
/// devuelven los bloques de servidores, no el resto de esos archivos
/// (~/.claude.json guarda también historial y cuentas).
#[tauri::command(async)]
pub fn mcp_import_sources(cwd: String) -> Vec<McpImportSource> {
    let mut out = vec![];
    let mut push = |source: &str, path: PathBuf, pick: &dyn Fn(&serde_json::Value) -> Option<serde_json::Value>| {
        let Ok(text) = fs::read_to_string(&path) else { return };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return };
        if let Some(servers) = pick(&json) {
            out.push(McpImportSource { source: source.into(), path: path.to_string_lossy().into_owned(), servers });
        }
    };
    if let Some(h) = home() {
        let project = cwd.replace('\\', "/");
        push("Claude Code", h.join(".claude.json"), &|j| {
            let mut all = serde_json::Map::new();
            if let Some(s) = j.get("mcpServers").and_then(|s| s.as_object()) {
                all.extend(s.clone());
            }
            let proj = j.get("projects").and_then(|p| p.as_object()).and_then(|p| {
                p.iter().find(|(k, _)| !project.is_empty() && k.replace('\\', "/").eq_ignore_ascii_case(&project)).map(|(_, v)| v.clone())
            });
            if let Some(s) = proj.as_ref().and_then(|p| p.get("mcpServers")).and_then(|s| s.as_object()) {
                all.extend(s.clone());
            }
            (!all.is_empty()).then(|| serde_json::Value::Object(all))
        });
        push("Cursor", h.join(".cursor").join("mcp.json"), &servers_in);
    }
    if !cwd.is_empty() {
        let p = PathBuf::from(&cwd);
        push("Claude Code (proyecto)", p.join(".mcp.json"), &servers_in);
        push("Cursor (proyecto)", p.join(".cursor").join("mcp.json"), &servers_in);
        push("VS Code (proyecto)", p.join(".vscode").join("mcp.json"), &servers_in);
    }
    if let Some(base) = app_data() {
        push("Claude Desktop", base.join("Claude").join("claude_desktop_config.json"), &servers_in);
        push("VS Code", base.join("Code").join("User").join("mcp.json"), &servers_in);
        push("VS Code", base.join("Code").join("User").join("settings.json"), &servers_in);
    }
    out
}

/// Abre `~/.lixbon/mcp.json` con la app del sistema (lo crea vacío si falta).
#[tauri::command(async)]
pub fn mcp_open_user_config() -> Result<String, String> {
    let path = user_config_path().ok_or("no se encontró la carpeta del usuario")?;
    if !path.exists() {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::write(&path, "{\n  \"servers\": {}\n}\n").map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("start").arg("").arg(&path);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&path);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&path);
        c
    };
    crate::hide_console(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
