//! Claude Code como agente del IDE. Se lanza `claude -p` en modo stream-json
//! y aquí solo se mueven líneas JSON en ambos sentidos; el protocolo (turnos,
//! permisos, interrupciones) lo habla el frontend (`src/lib/claudeCode.js`).
//! El historial es el del propio Claude Code: `~/.claude/projects/<cwd>/*.jsonl`.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

struct CcProc {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct ClaudeSessions(Mutex<HashMap<String, CcProc>>);

impl ClaudeSessions {
    pub fn stop_all(&self) {
        if let Ok(mut map) = self.0.lock() {
            for (_, mut p) in map.drain() {
                crate::mcp::kill_tree(&mut p.child);
            }
        }
    }
}

fn claude_command() -> Command {
    // `claude` puede ser claude.exe (instalador nativo) o claude.cmd (npm):
    // cmd /C resuelve los dos.
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg("claude");
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new("claude");
    // Si el IDE se abrió desde una terminal de Claude Code, el hijo creería
    // que está anidado en otra sesión.
    cmd.env_remove("CLAUDECODE").env_remove("CLAUDE_CODE_ENTRYPOINT");
    crate::hide_console(&mut cmd);
    cmd
}

#[tauri::command(async)]
pub fn cc_version() -> Result<String, String> {
    let out = claude_command()
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || text.is_empty() {
        return Err("Claude Code no está instalado o no está en el PATH.".into());
    }
    Ok(text)
}

#[tauri::command]
pub fn cc_start(
    app: AppHandle,
    sessions: State<'_, ClaudeSessions>,
    id: String,
    args: Vec<String>,
    cwd: String,
) -> Result<(), String> {
    if let Some(mut old) = sessions.0.lock().map_err(|e| e.to_string())?.remove(&id) {
        crate::mcp::kill_tree(&mut old.child);
    }
    let mut cmd = claude_command();
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("no se pudo lanzar Claude Code: {e}"))?;
    let stdin = child.stdin.take().ok_or("el proceso no expone stdin")?;
    let stdout = child.stdout.take().ok_or("el proceso no expone stdout")?;
    let mut stderr = child.stderr.take().ok_or("el proceso no expone stderr")?;

    let err_app = app.clone();
    let err_event = format!("cc:stderr:{id}");
    thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr.read_to_string(&mut buf);
        if !buf.trim().is_empty() {
            let _ = err_app.emit(&err_event, buf.chars().take(4000).collect::<String>());
        }
    });

    let line_event = format!("cc:line:{id}");
    let exit_event = format!("cc:exit:{id}");
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

    sessions
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, CcProc { child, stdin });
    Ok(())
}

#[tauri::command]
pub fn cc_send(sessions: State<'_, ClaudeSessions>, id: String, line: String) -> Result<(), String> {
    let mut map = sessions.0.lock().map_err(|e| e.to_string())?;
    let p = map.get_mut(&id).ok_or("Claude Code no está en marcha")?;
    p.stdin
        .write_all(line.as_bytes())
        .and_then(|_| p.stdin.write_all(b"\n"))
        .and_then(|_| p.stdin.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cc_stop(sessions: State<'_, ClaudeSessions>, id: String) -> Result<(), String> {
    if let Some(mut p) = sessions.0.lock().map_err(|e| e.to_string())?.remove(&id) {
        crate::mcp::kill_tree(&mut p.child);
    }
    Ok(())
}

// ── Historial ───────────────────────────────────────────────────────────

fn projects_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("projects"));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

/// Mismo nombre de carpeta que usa Claude Code: todo lo que no es
/// alfanumérico pasa a `-`.
fn slug(cwd: &str) -> String {
    cwd.trim_end_matches(['\\', '/'])
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn project_dir(cwd: &str) -> Option<PathBuf> {
    let base = projects_dir()?;
    let exact = base.join(slug(cwd));
    if exact.is_dir() {
        return Some(exact);
    }
    // Rutas muy largas: Claude Code recorta el nombre y le añade un hash.
    let s = slug(cwd);
    let prefix: String = s.chars().take(120).collect();
    fs::read_dir(&base).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.is_dir() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.len() < s.len() && n.starts_with(&prefix))
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[derive(Serialize)]
pub struct CcSession {
    id: String,
    title: String,
    updated_ms: u64,
}

fn text_of(content: &serde_json::Value) -> Option<String> {
    match content {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Array(parts) => parts
            .iter()
            .find(|p| p.get("type").and_then(|t| t.as_str()) == Some("text"))
            .and_then(|p| p.get("text"))
            .and_then(|t| t.as_str())
            .map(str::to_string),
        _ => None,
    }
}

fn session_title(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut first_user: Option<String> = None;
    let mut named: Option<String> = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let is_title = line.contains("\"custom-title\"") || line.contains("\"ai-title\"") || line.contains("\"summary\"");
        if first_user.is_some() && !is_title {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        match kind {
            "custom-title" | "ai-title" | "summary" => {
                let t = ["customTitle", "aiTitle", "title", "summary"]
                    .iter()
                    .find_map(|k| v.get(*k).and_then(|x| x.as_str()));
                if let Some(t) = t.filter(|t| !t.trim().is_empty()) {
                    // El título que pone el usuario manda sobre los automáticos.
                    if kind == "custom-title" || named.is_none() {
                        named = Some(t.to_string());
                    }
                }
            }
            "user" if first_user.is_none() => {
                if v.get("isMeta").and_then(|m| m.as_bool()) == Some(true) || v.get("isSidechain").and_then(|m| m.as_bool()) == Some(true) {
                    continue;
                }
                if let Some(text) = v.get("message").and_then(|m| m.get("content")).and_then(text_of) {
                    let t = text.trim();
                    if !t.is_empty() && !t.starts_with('<') && !t.starts_with("Caveat:") {
                        first_user = Some(t.chars().take(80).collect());
                    }
                }
            }
            _ => {}
        }
    }
    named.or(first_user)
}

#[tauri::command(async)]
pub fn cc_sessions(cwd: String) -> Result<Vec<CcSession>, String> {
    let Some(dir) = project_dir(&cwd) else { return Ok(vec![]) };
    let mut files: Vec<(PathBuf, u64)> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                return None;
            }
            let ms = e.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
            Some((p, ms))
        })
        .collect();
    files.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(files
        .into_iter()
        .take(40)
        .filter_map(|(p, ms)| {
            let id = p.file_stem()?.to_str()?.to_string();
            let title = session_title(&p)?;
            Some(CcSession { id, title, updated_ms: ms })
        })
        .collect())
}

#[tauri::command(async)]
pub fn cc_session_read(cwd: String, id: String) -> Result<String, String> {
    if !valid_id(&id) {
        return Err("id de sesión inválido".into());
    }
    let dir = project_dir(&cwd).ok_or("no hay historial de Claude Code para esta carpeta")?;
    fs::read_to_string(dir.join(format!("{id}.jsonl"))).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{slug, valid_id};

    #[test]
    fn slug_igual_que_claude_code() {
        assert_eq!(slug(r"C:\Users\Johnny Morales\Desktop\Lixbon"), "C--Users-Johnny-Morales-Desktop-Lixbon");
        assert_eq!(slug("/home/ana/mi_repo/"), "-home-ana-mi-repo");
    }

    #[test]
    fn ids_sin_rutas() {
        assert!(valid_id("95ca1512-f803-4ad6-84fc-b6bcdebe6cfe"));
        assert!(!valid_id("../x"));
        assert!(!valid_id(""));
    }
}
