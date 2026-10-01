//! Agentes que puede lanzar el coordinador: cómo se arrancan en autónomo, cómo
//! se les pasa el modelo y el esfuerzo, y qué modelos ofrece cada uno según su
//! propia CLI. El coordinador decide agente y modelo por tarea; el usuario no
//! configura nada.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use super::skill::which;
use crate::hide_console;

pub struct Spec {
    pub id: &'static str,
    pub label: &'static str,
    pub bin: &'static str,
    /// Lo que mejor hace, para que el coordinador elija con criterio.
    pub strengths: &'static str,
    /// Flag que salta las confirmaciones: un hijo no tiene a quién preguntar.
    autonomy: &'static [&'static str],
    efforts: &'static [&'static str],
}

/// Aún no funcionan como hijos en Windows: la TUI de Cursor no recibe el teclado
/// dentro del PTY y en modo -p un hook le bloquea la escritura; OpenCode dice
/// escribir pero el archivo no aparece. Se retiran del equipo hasta resolverlo.
const PAUSED: &[&str] = &["cursor", "opencode"];

pub const AGENTS: &[Spec] = &[
    Spec { id: "claude", label: "Claude Code", bin: "claude", strengths: "Implementación y refactor complejos, depuración, tareas largas de código.",
        autonomy: &["--dangerously-skip-permissions"], efforts: &["low", "medium", "high", "xhigh", "max"] },
    Spec { id: "codex", label: "Codex", bin: "codex", strengths: "Implementación y tests; buen segundo implementador o revisor.",
        autonomy: &["--dangerously-bypass-approvals-and-sandbox"], efforts: &["low", "medium", "high"] },
    Spec { id: "cursor", label: "Cursor", bin: "cursor-agent", strengths: "Revisión de diffs, lectura del código y cambios acotados.",
        autonomy: &["--yolo"], efforts: &[] },
    Spec { id: "opencode", label: "OpenCode", bin: "opencode", strengths: "Modelos de muchos proveedores: documentación, lectura, QA y tareas baratas.",
        autonomy: &["--auto"], efforts: &[] },
    Spec { id: "gemini", label: "Gemini CLI", bin: "gemini", strengths: "Contexto muy largo: leer mucho código o documentación.",
        autonomy: &["--yolo"], efforts: &[] },
];

pub fn spec(id: &str) -> Option<&'static Spec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// Un id de modelo va dentro de un script de cmd: solo caracteres inofensivos.
pub fn safe_token(s: &str) -> Result<String, String> {
    let s = s.trim();
    if s.is_empty() || s.len() > 120 || !s.chars().all(|c| c.is_ascii_alphanumeric() || "._-:/[]#@".contains(c)) {
        return Err(format!("Modelo o esfuerzo no válido: {s}"));
    }
    Ok(s.to_string())
}

pub struct Launch {
    pub command: String,
    pub env: Vec<(String, String)>,
    /// Para agentes que no toman el prompt como argumento: se escribe en su
    /// terminal cuando la TUI está lista.
    pub inject: Option<String>,
    /// Sin terminal: proceso con la salida canalizada (modo de ejecución completa).
    pub piped: bool,
}

/// Herramientas que se le quitan a una hija de solo lectura. Bash se conserva:
/// la necesita para `lxo`.
const READ_ONLY_BLOCKED: &[&str] = &["Edit", "Write", "NotebookEdit"];

pub fn launch(agent: &str, model: Option<&str>, effort: Option<&str>, prompt: &str, read_only: bool) -> Result<Launch, String> {
    let a = spec(agent).ok_or_else(|| format!("Agente desconocido: {agent}. Usa uno de `lxo agents`."))?;
    if PAUSED.contains(&agent) {
        return Err(format!("{} no está disponible todavía como agente hijo en Lixbon. Usa uno de `lxo agents`.", a.label));
    }
    let model = model.map(safe_token).transpose()?;
    let effort = effort.map(safe_token).transpose()?;
    if let Some(e) = &effort {
        if !a.efforts.contains(&e.as_str()) {
            return Err(format!("{} no admite --effort {e}", a.label));
        }
    }
    let mut args: Vec<String> = a.autonomy.iter().map(|s| s.to_string()).collect();
    let env = vec![];
    let inject = None;
    let mut piped = false;
    match agent {
        "claude" => {
            // Va delante de todo: la lista de --disallowedTools acaba en la siguiente opción.
            if read_only {
                let mut blocked = vec!["--disallowedTools".to_string()];
                blocked.extend(READ_ONLY_BLOCKED.iter().map(|t| t.to_string()));
                args.splice(0..0, blocked);
            }
            if let Some(m) = &model { args.extend(["--model".into(), m.clone()]); }
            if let Some(e) = &effort { args.extend(["--effort".into(), e.clone()]); }
            args.push(format!("\"{prompt}\""));
        }
        "codex" => {
            if let Some(m) = &model { args.extend(["--model".into(), m.clone()]); }
            if let Some(e) = &effort { args.extend(["-c".into(), format!("model_reasoning_effort={e}")]); }
            args.push(format!("\"{prompt}\""));
        }
        // Su TUI no recibe el teclado dentro de un PTY de Windows, y dentro de uno
        // sus hooks (los que instala Orca, por ejemplo) no le responden. Trabaja en
        // modo de ejecución completa (-p) sin terminal, entrega con lxo y termina.
        "cursor" => {
            piped = true;
            args.extend(["-p".into(), "--trust".into(), "--output-format".into(), "text".into()]);
            if let Some(m) = &model { args.extend(["--model".into(), m.clone()]); }
            args.push(format!("\"{prompt}\""));
        }
        // Su TUI no procesa el prompt dentro de un PTY de Windows: `opencode run`
        // hace la tarea completa sin terminal, entrega con lxo y termina.
        "opencode" => {
            piped = true;
            args.insert(0, "run".into());
            if let Some(m) = &model { args.extend(["--model".into(), m.clone()]); }
            args.push(format!("\"{prompt}\""));
        }
        "gemini" => {
            if let Some(m) = &model { args.extend(["-m".into(), m.clone()]); }
            args.extend(["-i".into(), format!("\"{prompt}\"")]);
        }
        _ => {}
    }
    Ok(Launch { command: format!("{} {}", a.bin, args.join(" ")), env, inject, piped })
}

/// Teclas para los diálogos de arranque que bloquearían a un hijo sin nadie
/// delante: confiar en la carpeta nueva del worktree y aceptar el modo sin
/// permisos. Se envían una a una, con pausa, como las pulsaría una persona.
pub fn auto_answer(screen: &str) -> Option<&'static [&'static str]> {
    let s = screen.to_lowercase();
    // Claude marca por defecto «No, exit»: hay que bajar a «Yes, I trust this folder».
    if s.contains("yes, i trust this folder") || s.contains("yes,itrustthisfolder") {
        return Some(&["\x1b[B", "\r"]);
    }
    if (s.contains("yes, i accept") || s.contains("yes,iaccept")) && s.contains("bypass") {
        return Some(&["\x1b[B", "\r"]);
    }
    if s.contains("trust") && (s.contains("folder") || s.contains("directory") || s.contains("workspace") || s.contains("files in")) {
        return Some(&["\r"]);
    }
    None
}

// ── Modelos disponibles ─────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct Model {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Serialize, Clone)]
pub struct Available {
    pub id: String,
    pub label: String,
    pub strengths: String,
    pub models: Vec<Model>,
    pub efforts: Vec<String>,
    pub model_hint: String,
}

static CACHE: Mutex<Option<(Instant, Vec<Available>)>> = Mutex::new(None);
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

fn output(bin: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let path = which(bin)?;
    let mut cmd = if cfg!(windows) && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&path);
        c
    } else {
        Command::new(&path)
    };
    let mut child = hide_console(cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())).spawn().ok()?;
    let stdout = child.stdout.take()?;
    let reader = thread::spawn(move || std::io::read_to_string(stdout).unwrap_or_default());
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return reader.join().ok();
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    None
}

/// Los modelos de Claude salen de su `initialize`, igual que en el chat de Claude Code.
fn claude_models() -> Vec<Model> {
    let fallback = || ["opus", "sonnet", "haiku", "fable"].iter().map(|m| Model { id: m.to_string(), label: m.to_string(), note: String::new() }).collect();
    let Some(path) = which("claude") else { return fallback() };
    let mut cmd = if cfg!(windows) && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&path);
        c
    } else {
        Command::new(&path)
    };
    let child = hide_console(cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()))
        .spawn();
    let Ok(mut child) = child else { return fallback() };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = writeln!(stdin, "{}", json!({ "type": "control_request", "request_id": "lxo", "request": { "subtype": "initialize" } }));
        let stdout = child.stdout.take();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let Some(out) = stdout else { return };
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v["type"] == "control_response" {
                    let _ = tx.send(v["response"]["response"]["models"].clone());
                    return;
                }
            }
        });
        let models = rx.recv_timeout(Duration::from_secs(25)).ok();
        drop(stdin);
        let _ = child.kill();
        if let Some(Value::Array(list)) = models {
            let out: Vec<Model> = list.iter().filter_map(|m| {
                let id = m["value"].as_str()?.to_string();
                (id != "default").then(|| Model {
                    label: m["displayName"].as_str().unwrap_or(&id).to_string(),
                    note: m["description"].as_str().unwrap_or("").to_string(),
                    id,
                })
            }).collect();
            if !out.is_empty() {
                return out;
            }
        }
    }
    fallback()
}

/// Una lista de modelos en texto (una por línea, con o sin viñeta).
fn parse_lines(text: &str) -> Vec<Model> {
    text.lines()
        .map(|l| l.trim().trim_start_matches(['-', '*', '•']).trim())
        .filter(|l| (!l.is_empty() && !l.ends_with(':') && !l.contains(' ')) || l.contains("(default)") || l.contains(" - "))
        .filter_map(|l| {
            let id = l.split_whitespace().next()?.to_string();
            safe_token(&id).ok()?;
            let note = l[id.len()..].trim().trim_start_matches('-').trim().to_string();
            Some(Model { label: id.clone(), id, note })
        })
        .take(80)
        .collect()
}

fn discover(a: &Spec) -> Vec<Model> {
    let long = Duration::from_secs(25);
    match a.id {
        "claude" => claude_models(),
        "opencode" => output("opencode", &["models"], long).map(|t| parse_lines(&t)).unwrap_or_default(),
        "codex" => output("codex", &["debug", "models"], long).map(|t| parse_lines(&t)).unwrap_or_default(),
        "cursor" => output("cursor-agent", &["models"], long).map(|t| parse_lines(&t)).unwrap_or_default(),
        _ => vec![],
    }
}

fn hint(id: &str) -> &'static str {
    match id {
        "claude" => "--model con un alias (opus, sonnet, haiku, fable) o un id completo",
        "codex" => "--model con un id de OpenAI (p. ej. gpt-5.5); --effort low|medium|high",
        "opencode" => "--model proveedor/modelo, tal como sale en la lista",
        "cursor" => "--model con un id de la lista de Cursor",
        "gemini" => "--model con un id de Gemini",
        _ => "",
    }
}

/// Agentes instalados en este equipo y sus modelos. Tarda la primera vez
/// (pregunta a cada CLI), después se sirve de caché.
pub fn available(refresh: bool) -> Vec<Available> {
    if !refresh {
        if let Ok(c) = CACHE.lock() {
            if let Some((at, list)) = c.as_ref() {
                if at.elapsed() < CACHE_TTL {
                    return list.clone();
                }
            }
        }
    }
    let installed: Vec<&Spec> = AGENTS.iter().filter(|a| !PAUSED.contains(&a.id) && which(a.bin).is_some()).collect();
    let handles: Vec<_> = installed.iter().map(|a| {
        let id = a.id;
        thread::spawn(move || discover(spec(id).expect("agente conocido")))
    }).collect();
    let list: Vec<Available> = installed.iter().zip(handles).map(|(a, h)| Available {
        id: a.id.into(),
        label: a.label.into(),
        strengths: a.strengths.into(),
        models: h.join().unwrap_or_default(),
        efforts: a.efforts.iter().map(|e| e.to_string()).collect(),
        model_hint: hint(a.id).into(),
    }).collect();
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((Instant::now(), list.clone()));
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lanzadores_autonomos_con_modelo() {
        let l = launch("claude", Some("opus"), Some("high"), "Lee la tarea", false).unwrap();
        assert_eq!(l.command, r#"claude --dangerously-skip-permissions --model opus --effort high "Lee la tarea""#);
        assert!(launch("opencode", Some("anthropic/claude-sonnet-5"), None, "x", false).is_err());
        let l = launch("codex", Some("gpt-5.5"), Some("high"), "x", false).unwrap();
        assert_eq!(l.command, r#"codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.5 -c model_reasoning_effort=high "x""#);
        assert!(launch("claude", Some("opus & del"), None, "x", false).is_err());
        assert!(launch("gemini", None, Some("high"), "x", false).is_err());
    }

    #[test]
    fn solo_lectura_sin_herramientas_de_edicion() {
        let l = launch("claude", Some("haiku"), None, "Lee", true).unwrap();
        assert_eq!(l.command, r#"claude --disallowedTools Edit Write NotebookEdit --dangerously-skip-permissions --model haiku "Lee""#);
    }

    #[test]
    fn responde_dialogos_de_arranque() {
        assert_eq!(auto_answer("Do you trust the contents of this directory?"), Some(&["\r"][..]));
        assert_eq!(auto_answer("Quick safety check ❯ No, exit  Yes, I trust this folder"), Some(&["\x1b[B", "\r"][..]));
        assert_eq!(auto_answer("Bypass Permissions mode ... Yes, I accept"), Some(&["\x1b[B", "\r"][..]));
        assert_eq!(auto_answer("> hola"), None);
    }

    #[test]
    fn lista_de_modelos_en_texto() {
        let m = parse_lines("Available models:\n- auto (default)\n- gpt-5.5\nanthropic/claude-sonnet-5\n");
        let ids: Vec<&str> = m.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["auto", "gpt-5.5", "anthropic/claude-sonnet-5"]);
    }
}

