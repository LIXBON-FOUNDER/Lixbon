//! Entrega del informe sin red (contrato «informe por archivo», revisión 3).
//!
//! Un agente dentro de un sandbox sin red local (Codex `-s read-only` o
//! `workspace-write`) no puede llamar al host con `lxo done`. Entrega así:
//! - `workspace-write`: `lxo report` escribe `.lixbon/out/<task>/<n>/report.json`
//!   (`.tmp` + rename).
//! - `read-only`: `lxo report` imprime un bloque con marcadores (JSON en base64,
//!   sha256 y nonce del intento) que el agente copia en su respuesta; el host lo
//!   busca en la salida de la terminal.
//!
//! Desde la revisión 4 (prueba de punta a punta en Windows):
//! - Codex read-only se lanza con `codex exec -o <last-message.md>`: el mensaje
//!   final lo escribe la propia CLI, fuera del sandbox, sin pasar por ConPTY. Es
//!   la vía principal para cualquier tamaño (`Channel::ExecO`).
//! - Claude en Explorar/Proponer se lanza con `--output-format stream-json`: el
//!   informe es el `result` del último evento (`Channel::StreamJson`).
//! - El bloque por la salida queda de respaldo solo hasta MAX_STDOUT; si pasa de
//!   eso o no llega nada, el informe queda **no entregado** con el motivo, nunca
//!   se entrega recortado.
//!
//! El host valida forma, `task`/`attempt`/`nonce` y hash, y entrega por el mismo
//! camino que `lxo done`. La clave `idem_key(task, n, sha256)` evita registrar dos
//! veces el mismo informe. `n` es siempre 1 hasta que exista el registro por intento.

use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::state::{self, State, Status, Task};

/// Hueco aceptado: un solo intento por tarea hasta el PR de registro por intento.
pub const ATTEMPT: u32 = 1;
pub const MAX_FILE: usize = 256 * 1024;
pub const MAX_REPORT: usize = 200 * 1024;
pub const MAX_SUMMARY: usize = 500;
pub const MISSING: &str = "el agente se cerró sin avisar con lxo done ni report.json";
/// Respaldo por la salida de la terminal: hasta 50 KB de JSON.
pub const MAX_STDOUT: usize = 50 * 1024;
/// Mensaje final de `codex exec -o` o de stream-json: sin límite práctico.
pub const MAX_FINAL: usize = 8 * 1024 * 1024;
pub const NO_EXEC_O: &str = "codex exec terminó sin escribir el mensaje final (-o) ni un bloque válido por la salida";
pub const NO_STREAM_RESULT: &str = "Claude terminó sin evento result en stream-json ni otro informe válido";
/// Primera línea opcional del mensaje final: `LXO-RESULT nonce=<n> status=done|failed`.
pub const RESULT_HEADER: &str = "LXO-RESULT";

/// Vía por la que llegó el informe (`delivery_channel` en la tarea).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    ExecO,
    StreamJson,
    ReportJson,
    Stdout,
}

impl Channel {
    pub fn id(self) -> &'static str {
        match self {
            Channel::ExecO => "exec_o",
            Channel::StreamJson => "stream_json",
            Channel::ReportJson => "report_json",
            Channel::Stdout => "stdout",
        }
    }
}

const BEGIN: &str = "<<<LXO-REPORTv1nonce=";
const END: &str = "<<<LXO-REPORT-ENDnonce=";

/// Lo que el lanzamiento fijó para el intento.
#[derive(Clone, Debug)]
pub struct Expect {
    pub task: String,
    pub attempt: u32,
    pub nonce: String,
}

impl Expect {
    /// Solo hay entrega por archivo si la tarea se lanzó con nonce.
    pub fn of(t: &Task) -> Option<Expect> {
        Some(Expect { task: t.id.clone(), attempt: ATTEMPT, nonce: t.report_nonce.clone()? })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub ok: bool,
    pub summary: String,
    pub files: Vec<String>,
    pub report: Option<String>,
    /// sha256 (hex) de los bytes del JSON (o del mensaje final).
    pub sha256: String,
    pub channel: Channel,
    /// Modelo efectivo, si la vía lo trae (stream-json).
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Found {
    Nothing,
    Valid(Report),
    Invalid(String),
    /// No llegó por ninguna vía válida (o el respaldo se pasó de tamaño): al salir
    /// el proceso la tarea queda Failed con «informe no entregado: <motivo>».
    Undelivered(String),
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// `sha256(task ‖ "\0" ‖ n ‖ "\0" ‖ sha256(bytes del archivo))`.
pub fn idem_key(task: &str, attempt: u32, file_sha256: &str) -> String {
    sha256_hex(format!("{task}\0{attempt}\0{file_sha256}").as_bytes())
}

pub fn out_dir(cwd: &str, task: &str) -> PathBuf {
    Path::new(cwd).join(".lixbon").join("out").join(task)
}

pub fn report_path(cwd: &str, task: &str, attempt: u32) -> PathBuf {
    out_dir(cwd, task).join(attempt.to_string()).join("report.json")
}

/// Archivo de `codex exec -o` del intento (junto a report.json; `prepare` lo borra).
pub fn last_message_path(cwd: &str, task: &str, attempt: u32) -> PathBuf {
    out_dir(cwd, task).join(attempt.to_string()).join("last-message.md")
}

/// Lee el mensaje final de `-o` (como mucho MAX_FINAL + 1 bytes).
pub fn read_final_file(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
    let mut buf = vec![];
    f.take(MAX_FINAL as u64 + 1).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Informe a partir del mensaje final del agente (`-o` o `result` de stream-json),
/// tal cual, sin base64 ni copia. Si empieza por `LXO-RESULT`, la cabecera manda
/// (nonce del intento y status); si no, `ok_default`. El resumen es la primera
/// línea con texto.
pub fn parse_final_message(text: &str, ex: &Expect, ok_default: bool, channel: Channel) -> Result<Report, String> {
    if text.len() > MAX_FINAL {
        return Err(format!("el mensaje final pasa de {} MiB", MAX_FINAL / (1024 * 1024)));
    }
    let body = text.trim_start_matches('\u{feff}').trim();
    if body.is_empty() {
        return Err("el mensaje final está vacío".into());
    }
    let (first, rest) = body.split_once('\n').unwrap_or((body, ""));
    let (ok, report) = match first.trim().strip_prefix(RESULT_HEADER) {
        Some(h) => {
            let kv = |k: &str| h.split_whitespace().find_map(|p| p.strip_prefix(k)).map(str::to_string);
            if kv("nonce=").as_deref() != Some(ex.nonce.as_str()) {
                return Err("la cabecera LXO-RESULT no trae el nonce de este intento".into());
            }
            let ok = match kv("status=").as_deref() {
                Some("done") => true,
                Some("failed") => false,
                _ => return Err("la cabecera LXO-RESULT necesita status=done o status=failed".into()),
            };
            (ok, rest.trim().to_string())
        }
        None => (ok_default, body.to_string()),
    };
    let first_line = report.lines().map(|l| l.trim().trim_start_matches('#').trim()).find(|l| !l.is_empty()).unwrap_or("");
    if first_line.is_empty() {
        return Err("el mensaje final no trae informe".into());
    }
    let summary: String = first_line.chars().take(MAX_SUMMARY).collect();
    Ok(Report { ok, summary, files: vec![], report: Some(report), sha256: sha256_hex(text.as_bytes()), channel, model: None })
}

/// Lo que se saca de la salida de `claude -p --output-format stream-json`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stream {
    /// `result` del evento final y si fue error (`is_error` o subtype distinto de success).
    pub result: Option<(String, bool)>,
    /// `message.model` de los eventos assistant o, si no hay, el de `modelUsage` del
    /// result. Nunca el del init: en plan, el init dice el pedido y responde otro.
    pub model: Option<String>,
}

/// Lee los eventos JSONL. Una línea a medias (aún escribiéndose) no es JSON y se salta.
pub fn parse_stream_json(raw: &str) -> Stream {
    let mut s = Stream::default();
    for line in raw.split('\n') {
        let l = line.trim();
        if !l.starts_with('{') {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        match v["type"].as_str() {
            Some("assistant") => {
                if let Some(m) = v["message"]["model"].as_str().filter(|m| !m.is_empty() && *m != "<synthetic>") {
                    s.model = Some(m.to_string());
                }
            }
            Some("result") => {
                let err = v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str() != Some("success");
                s.result = Some((v["result"].as_str().unwrap_or("").to_string(), err));
                if s.model.is_none() {
                    // Con varios modelos, el que más tokens de salida generó.
                    s.model = v["modelUsage"].as_object().and_then(|u| {
                        u.iter().max_by_key(|(_, x)| x["outputTokens"].as_u64().unwrap_or(0)).map(|(k, _)| k.clone())
                    });
                }
            }
            _ => {}
        }
    }
    s
}

/// Antes de lanzar o relanzar: borra lo de intentos anteriores y deja la carpeta lista.
pub fn prepare(cwd: &str, task: &str, attempt: u32) -> Result<PathBuf, String> {
    let _ = std::fs::remove_dir_all(out_dir(cwd, task));
    let path = report_path(cwd, task, attempt);
    std::fs::create_dir_all(path.parent().expect("con carpeta")).map_err(|e| format!("No se pudo preparar {}: {e}", path.display()))?;
    Ok(path)
}

/// Lee `report.json` (nunca el `.tmp`) y lo cierra enseguida. Lee como mucho
/// MAX_FILE + 1 bytes para poder decir que se pasa del límite.
pub fn read_report_file(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
    let mut buf = vec![];
    f.take(MAX_FILE as u64 + 1).read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Valida un `report.json` contra lo que fijó el lanzamiento.
pub fn parse_report(bytes: &[u8], ex: &Expect) -> Result<Report, String> {
    if bytes.len() > MAX_FILE {
        return Err(format!("report.json pasa de {} KiB", MAX_FILE / 1024));
    }
    let v: Value = serde_json::from_slice(bytes).map_err(|e| format!("JSON no válido: {e}"))?;
    if v["schema"].as_u64() != Some(1) {
        return Err("schema desconocido".into());
    }
    if v["task"].as_str() != Some(ex.task.as_str()) {
        return Err(format!("task {} no es {}", v["task"], ex.task));
    }
    if v["attempt"].as_u64() != Some(ex.attempt as u64) {
        return Err(format!("attempt {} no es {}", v["attempt"], ex.attempt));
    }
    if v["nonce"].as_str() != Some(ex.nonce.as_str()) {
        return Err("nonce que no es el de este intento".into());
    }
    let ok = match v["status"].as_str() {
        Some("done") => true,
        Some("failed") => false,
        _ => return Err("status debe ser done o failed".into()),
    };
    let summary = v["summary"].as_str().map(str::trim).unwrap_or("").to_string();
    if summary.is_empty() {
        return Err("falta summary".into());
    }
    if summary.chars().count() > MAX_SUMMARY {
        return Err(format!("summary pasa de {MAX_SUMMARY} caracteres"));
    }
    let report = v["report"].as_str().filter(|r| !r.trim().is_empty()).map(String::from);
    if report.as_ref().is_some_and(|r| r.len() > MAX_REPORT) {
        return Err(format!("report pasa de {} KiB", MAX_REPORT / 1024));
    }
    let files = v["files"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
    Ok(Report { ok, summary, files, report, sha256: sha256_hex(bytes), channel: Channel::ReportJson, model: None })
}

/// Salida de terminal sin ANSI y sin ningún espacio ni salto: así los cortes que
/// mete ConPTY por el ancho no importan. El base64 no tiene espacios, y los
/// marcadores se buscan también compactados.
fn compact(raw: &str) -> String {
    super::pty::plain(raw).chars().filter(|c| !c.is_whitespace()).collect()
}

/// Busca bloques con el nonce del intento. Gana el último válido cuyo informe no
/// se haya entregado ya; los de otro nonce se ignoran. Si hay bloques con el nonce
/// correcto pero ninguno válido (hash distinto, truncado), es inválido: no se repara.
/// Un bloque de más de MAX_STDOUT no se entrega nunca: queda no entregado.
pub fn scan_markers(raw: &str, ex: &Expect, delivered: &[String]) -> Found {
    let text = compact(raw);
    let mut last_err = None;
    let mut too_big = None;
    let mut found = None;
    let mut from = 0;
    while let Some(i) = text[from..].find(BEGIN).map(|i| i + from) {
        from = i + BEGIN.len();
        let rest = &text[from..];
        let Some(h) = rest.find("sha256=") else { continue };
        if rest[..h] != *ex.nonce {
            continue;
        }
        let after = &rest[h + 7..];
        let Some(close) = after.find(">>>") else { continue };
        let declared = after[..close].to_ascii_lowercase();
        let body_start = from + h + 7 + close + 3;
        let end_tok = format!("{END}{}>>>", ex.nonce);
        let next_begin = text[body_start..].find(BEGIN).map(|j| j + body_start).unwrap_or(text.len());
        let Some(e) = text[body_start..next_begin].find(&end_tok).map(|e| e + body_start) else {
            last_err = Some("bloque sin marcador de fin (truncado)".to_string());
            continue;
        };
        let payload: String = text[body_start..e].chars().filter(|c| c.is_ascii_alphanumeric() || "+/=".contains(*c)).collect();
        let res = base64::engine::general_purpose::STANDARD.decode(payload.as_bytes())
            .map_err(|e| format!("base64 no válido: {e}"))
            .and_then(|bytes| {
                if bytes.len() > MAX_STDOUT {
                    return Err(format!("{}{} KB", TOO_BIG, MAX_STDOUT / 1024));
                }
                if declared.len() != 64 || sha256_hex(&bytes) != declared {
                    return Err("el sha256 no coincide".into());
                }
                parse_report(&bytes, ex).map(|r| Report { channel: Channel::Stdout, ..r })
            });
        match res {
            Ok(r) if delivered.contains(&idem_key(&ex.task, ex.attempt, &r.sha256)) => {}
            Ok(r) => found = Some(r),
            Err(e) if e.starts_with(TOO_BIG) => too_big = Some(e),
            Err(e) => last_err = Some(e),
        }
    }
    match (found, last_err, too_big) {
        (Some(r), _, _) => Found::Valid(r),
        (None, Some(e), _) => Found::Invalid(e),
        (None, None, Some(e)) => Found::Undelivered(e),
        (None, None, None) => Found::Nothing,
    }
}

const TOO_BIG: &str = "el bloque por la salida pasa del respaldo de ";

/// Vías en orden: `report.json` y después la salida de la terminal.
pub fn find(file: Option<&[u8]>, terminal: Option<&str>, ex: &Expect, delivered: &[String]) -> Found {
    find_all(&Sources { file, terminal, ..Sources::default() }, ex, delivered)
}

/// Todo lo que el host puede mirar para un intento.
#[derive(Default)]
pub struct Sources<'a> {
    /// La tarea se lanzó con `codex exec -o`: se espera el mensaje final.
    pub expect_final: bool,
    /// Bytes de `-o` (solo se leen al salir el proceso: antes podría estar a medias).
    pub final_file: Option<&'a [u8]>,
    /// La tarea se lanzó con stream-json: la salida es JSONL.
    pub expect_stream: bool,
    pub file: Option<&'a [u8]>,
    pub terminal: Option<&'a str>,
}

/// Vías en orden: `codex exec -o`, `result` de stream-json, `report.json` y el
/// bloque por la salida (respaldo hasta MAX_STDOUT).
pub fn find_all(src: &Sources, ex: &Expect, delivered: &[String]) -> Found {
    let fresh = |r: &Report| !delivered.contains(&idem_key(&ex.task, ex.attempt, &r.sha256));
    let mut invalid: Vec<String> = vec![];
    let mut undelivered: Vec<String> = vec![];
    if let Some(bytes) = src.final_file {
        let res = if bytes.len() > MAX_FINAL {
            Err(format!("el mensaje final pasa de {} MiB", MAX_FINAL / (1024 * 1024)))
        } else {
            std::str::from_utf8(bytes).map_err(|_| "el mensaje final no es UTF-8 válido".to_string())
                .and_then(|t| parse_final_message(t, ex, true, Channel::ExecO))
        };
        match res {
            Ok(r) if fresh(&r) => return Found::Valid(r),
            Ok(_) => {}
            Err(e) => invalid.push(format!("codex exec -o: {e}")),
        }
    }
    let mut stream_model = None;
    if src.expect_stream {
        let s = parse_stream_json(src.terminal.unwrap_or(""));
        stream_model = s.model.clone();
        if let Some((text, err)) = s.result {
            match parse_final_message(&text, ex, !err, Channel::StreamJson) {
                Ok(r) if fresh(&r) => return Found::Valid(Report { model: s.model, ..r }),
                Ok(_) => {}
                Err(e) => invalid.push(format!("stream-json: {e}")),
            }
        }
    }
    if let Some(bytes) = src.file {
        match parse_report(bytes, ex) {
            Ok(r) if fresh(&r) => return Found::Valid(Report { model: stream_model, ..r }),
            Ok(_) => {}
            Err(e) => invalid.push(format!("report.json: {e}")),
        }
    }
    match src.terminal.map(|t| scan_markers(t, ex, delivered)) {
        Some(Found::Valid(r)) => return Found::Valid(Report { model: stream_model, ..r }),
        Some(Found::Invalid(e)) => invalid.push(e),
        Some(Found::Undelivered(e)) => undelivered.push(e),
        _ => {}
    }
    if !invalid.is_empty() {
        return Found::Invalid(invalid.join("; "));
    }
    if src.expect_final && src.final_file.is_none() {
        undelivered.insert(0, NO_EXEC_O.into());
    }
    if src.expect_stream && undelivered.is_empty() {
        undelivered.push(NO_STREAM_RESULT.into());
    }
    if undelivered.is_empty() { Found::Nothing } else { Found::Undelivered(undelivered.join("; ")) }
}

/// Copia el informe junto al coordinador, igual que `lxo done`.
pub fn write_report(coordinator: &Task, task: &Task, text: &str) -> Result<String, String> {
    let dir = Path::new(&coordinator.cwd).join(".lixbon").join("informes").join(&task.run);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    super::git::exclude_lixbon_dir(&coordinator.cwd);
    let dest = dir.join(format!("{}-{}.md", task.id, state::slug(&task.title, 40)));
    let header = format!(
        "<!-- Tarea {} · {}{}{} · {} -->\n\n",
        task.id,
        task.role.as_deref().map(|r| format!("{r} · ")).unwrap_or_default(),
        task.agent,
        task.model.as_deref().map(|m| format!(" ({m})")).unwrap_or_default(),
        task.branch.as_deref().map(|b| format!("rama {b}")).unwrap_or_else(|| "carpeta compartida".into())
    );
    std::fs::write(&dest, format!("{header}{text}")).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Modelo con que respondió la CLI y si difiere del pedido. `unknown` (no se
/// pudo leer) no cuenta como diferencia.
pub fn set_model_effective(t: &mut super::state::Task, model: &str) {
    t.model_effective = Some(model.to_string());
    t.model_mismatch = model != super::codex_session::UNKNOWN
        && t.model_requested.as_deref().is_some_and(|req| !super::agents::same_model_family(req, model));
    t.model_mismatch_reason = (t.model_mismatch && t.plan_mode).then(|| "plan_mode".to_string());
}

/// Aplica lo encontrado. Entrega por el camino de `lxo done`; una tarea ya final
/// (llegó antes un `lxo done` u otra lectura) se descarta en silencio. Al salir
/// el proceso, un informe inválido deja la tarea `Failed` y la falta, `Exited`.
/// Devuelve los mensajes nuevos para `commit`.
pub fn apply(st: &mut State, id: &str, found: Found, at_exit: bool) -> Result<Vec<u64>, String> {
    let task = st.task(id)?.clone();
    if task.status.is_final() {
        return Ok(vec![]);
    }
    match found {
        Found::Valid(r) => {
            let root = st.runs.get(&task.run).and_then(|run| st.tasks.get(&run.root)).cloned().ok_or("Run sin coordinador")?;
            let text = r.report.clone().unwrap_or_else(|| format!("# {} · {}\n\n{}\n", task.id, task.title, r.summary));
            let path = write_report(&root, &task, &text)?;
            let msg = st.done(id, r.ok, &r.summary, r.files.clone(), Some(path))?;
            let t = st.task_mut(id)?;
            t.delivered.push(idem_key(id, ATTEMPT, &r.sha256));
            t.delivery_channel = Some(r.channel.id().into());
            if let Some(m) = &r.model {
                set_model_effective(t, m);
            }
            Ok(msg.into_iter().collect())
        }
        Found::Invalid(e) if at_exit => Ok(st.close(id, Status::Failed, &format!("informe inválido: {e}"))?.into_iter().collect()),
        Found::Undelivered(e) if at_exit => Ok(st.close(id, Status::Failed, &format!("informe no entregado: {e}"))?.into_iter().collect()),
        Found::Nothing if at_exit => Ok(st.close(id, Status::Exited, MISSING)?.into_iter().collect()),
        _ => Ok(vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orch::state::{Kind, NewTask};

    const NONCE: &str = "0123456789abcdef0123456789abcdef";

    fn ex(task: &str) -> Expect {
        Expect { task: task.into(), attempt: 1, nonce: NONCE.into() }
    }

    fn json(task: &str, nonce: &str, summary: &str) -> String {
        serde_json::json!({ "schema": 1, "task": task, "attempt": 1, "status": "done", "summary": summary,
            "files": ["src/a.rs"], "report": format!("# {task}\nhecho"), "nonce": nonce, "created": 1, "extra": "se ignora" }).to_string()
    }

    /// Lo mismo que imprime `lxo report` (lxo/src/main.rs).
    fn block(json: &str, nonce: &str) -> String {
        let b64 = base64::engine::general_purpose::STANDARD.encode(json.as_bytes());
        let lines: Vec<&str> = b64.as_bytes().chunks(76).map(|c| std::str::from_utf8(c).unwrap()).collect();
        format!("<<<LXO-REPORT v1 nonce={nonce} sha256={}>>>\n{}\n<<<LXO-REPORT-END nonce={nonce}>>>", sha256_hex(json.as_bytes()), lines.join("\n"))
    }

    /// Simula ConPTY con una terminal estrecha: corta cada `width` caracteres con
    /// \r\n, mete secuencias ANSI de color y de cursor y sangría de la TUI.
    fn conpty(text: &str, width: usize) -> String {
        let mut out = String::from("\x1b[?25l\x1b[1;1H");
        for (i, line) in text.lines().enumerate() {
            let chars: Vec<char> = line.chars().collect();
            for (j, c) in chars.chunks(width).enumerate() {
                let s: String = c.iter().collect();
                if (i + j) % 3 == 0 { out.push_str("\x1b[38;5;245m"); }
                out.push_str("  ");
                out.push_str(&s);
                out.push_str("\x1b[0m\x1b[K\r\n");
            }
        }
        out.push_str("\x1b]0;codex\x07");
        out
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lxo-entrega-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn setup(name: &str) -> (State, String, String, PathBuf) {
        let dir = tmp(name);
        let cwd = dir.to_string_lossy().into_owned();
        let nt = |title: &str| NewTask {
            agent: "codex".into(), model: None, effort: None, role: None, title: title.into(), spec: String::new(),
            repo: cwd.clone(), cwd: cwd.clone(), branch: None, base: None, worktree: None, external: false,
        };
        let mut st = State::default();
        let (_, root) = st.create_run("obj", nt("raíz"));
        let id = st.add_child(&root, 2, nt("hija")).unwrap();
        st.task_mut(&id).unwrap().report_nonce = Some(NONCE.into());
        (st, root, id, dir)
    }

    fn done_msgs(st: &State, root: &str) -> usize {
        st.messages.iter().filter(|m| m.to == root && m.kind == Kind::Done).count()
    }

    #[test]
    fn workspace_write_entrega_por_report_json() {
        // Prueba 1: report.json → Done, informe en .lixbon/informes/<run>/ y Kind::Done al padre.
        let (mut st, root, id, dir) = setup("archivo");
        let path = prepare(&dir.to_string_lossy(), &id, 1).unwrap();
        assert!(path.ends_with(format!(".lixbon/out/{id}/1/report.json")));
        std::fs::write(&path, json(&id, NONCE, "Hecho")).unwrap();
        let e = Expect::of(st.task(&id).unwrap()).unwrap();
        let found = find(read_report_file(&path).as_deref(), None, &e, &[]);
        let msgs = apply(&mut st, &id, found, false).unwrap();
        assert_eq!(msgs.len(), 1);
        let t = st.task(&id).unwrap();
        assert_eq!((t.status, t.summary.as_str(), t.files.clone()), (Status::Done, "Hecho", vec!["src/a.rs".to_string()]));
        let report = t.report.clone().unwrap();
        assert!(Path::new(&report).parent().unwrap().ends_with(Path::new(".lixbon").join("informes").join(&t.run)));
        assert!(std::fs::read_to_string(report).unwrap().contains("hecho"));
        assert_eq!(done_msgs(&st, &root), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_only_entrega_por_marcadores() {
        // Prueba 2 (vía stdout, sin -o): bloque en la salida → Done.
        let (mut st, root, id, dir) = setup("stdout");
        let out = format!("› trabajando...\n{}\n› listo\n", block(&json(&id, NONCE, "Revisado"), NONCE));
        let e = ex(&id);
        let msgs = apply(&mut st, &id, find(None, Some(&out), &e, &[]), false).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(st.task(&id).unwrap().status, Status::Done);
        assert_eq!(done_msgs(&st, &root), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn hash_distinto_o_truncado_es_invalido_sin_reparar() {
        // Prueba 2b.
        let e = ex("t1");
        let good = block(&json("t1", NONCE, "x"), NONCE);
        let mut lines: Vec<String> = good.lines().map(String::from).collect();
        let l = &mut lines[1];
        let c = if l.starts_with('A') { "B" } else { "A" };
        l.replace_range(0..1, c);
        assert_eq!(scan_markers(&lines.join("\n"), &e, &[]), Found::Invalid("el sha256 no coincide".into()));
        let truncated: String = good.lines().take(2).collect::<Vec<_>>().join("\n");
        assert!(matches!(scan_markers(&truncated, &e, &[]), Found::Invalid(_)));
        let cut_payload = good.lines().enumerate().filter(|(i, _)| *i != 2).map(|(_, l)| l).collect::<Vec<_>>().join("\n");
        assert!(matches!(scan_markers(&cut_payload, &e, &[]), Found::Invalid(_)));
        // Al salir el proceso, inválido → Failed con motivo.
        let (mut st, _, id, dir) = setup("hash");
        let bad = block(&json(&id, NONCE, "x"), NONCE).replacen("sha256=", "sha256=0", 1);
        apply(&mut st, &id, find(None, Some(&bad), &ex(&id), &[]), true).unwrap();
        assert_eq!(st.task(&id).unwrap().status, Status::Failed);
        assert!(st.messages.last().unwrap().body.contains("informe inválido"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn marcadores_de_otro_nonce_se_ignoran() {
        // Prueba 2c: sin nonce, con nonce viejo o un archivo con marcadores impreso con cat.
        let e = ex("t1");
        let viejo = block(&json("t1", "viejo", "x"), "viejo");
        assert_eq!(scan_markers(&viejo, &e, &[]), Found::Nothing);
        let sin = "<<<LXO-REPORT v1 sha256=00>>>\nAAAA\n<<<LXO-REPORT-END>>>";
        assert_eq!(scan_markers(sin, &e, &[]), Found::Nothing);
        let cat = "$ cat docs/ejemplo.md\n<<<LXO-REPORT v1 nonce=<NONCE> sha256=<hex>>>\n<base64>\n<<<LXO-REPORT-END nonce=<NONCE>>>";
        assert_eq!(scan_markers(cat, &e, &[]), Found::Nothing);
        // Uno viejo y uno bueno: gana el bueno.
        let both = format!("{viejo}\n{}", block(&json("t1", NONCE, "bueno"), NONCE));
        assert!(matches!(scan_markers(&both, &e, &[]), Found::Valid(r) if r.summary == "bueno"));
        // Sin bloque válido, al salir: Exited con el motivo ampliado.
        let (mut st, _, id, dir) = setup("nonce");
        apply(&mut st, &id, find(None, Some(&viejo), &ex(&id), &[]), true).unwrap();
        assert_eq!(st.task(&id).unwrap().status, Status::Exited);
        assert!(st.messages.last().unwrap().body.ends_with(MISSING));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn cortes_de_conpty_y_ansi_se_limpian() {
        // Prueba 2d: líneas base64 cortadas a mitad, mezcladas con ANSI y sangría.
        let e = ex("t1");
        let j = json("t1", NONCE, "Con ñ, emoji 🚀 y \"comillas\"");
        let b = block(&j, NONCE);
        for width in [20, 33, 40, 77] {
            let raw = conpty(&format!("salida previa\n{b}\nfin"), width);
            assert!(raw.contains("\r\n") && raw.contains("\x1b["));
            match scan_markers(&raw, &e, &[]) {
                Found::Valid(r) => {
                    assert_eq!(r.summary, "Con ñ, emoji 🚀 y \"comillas\"");
                    assert_eq!(r.sha256, sha256_hex(j.as_bytes()));
                }
                other => panic!("ancho {width}: {other:?}"),
            }
        }
    }

    #[test]
    fn fixture_grabada_estilo_conpty() {
        // Fixture: salida tal como la deja ConPTY con ancho 40 (cursor, colores, cortes).
        let raw = include_str!("testdata/conpty-marcadores.txt");
        let e = Expect { task: "t7".into(), attempt: 1, nonce: "5f1c2a9be04d7713a0c4e8f2b6d9c1e3".into() };
        assert!(matches!(scan_markers(raw, &e, &[]), Found::Valid(r) if r.summary == "Revisión terminada: 2 hallazgos" && !r.ok));
    }

    #[test]
    fn salidas_reales_de_codex_sandbox() {
        // Grabadas con `codex sandbox` 0.162.1 (Linux) ejecutando `lxo report`:
        // read-only no puede escribir e imprime el bloque; workspace-write escribe report.json.
        let e = Expect { task: "t7".into(), attempt: 1, nonce: "5f1c2a9be04d7713a0c4e8f2b6d9c1e3".into() };
        let ro = include_str!("testdata/codex-sandbox-read-only-lxo-report.txt");
        assert!(ro.contains("Read-only file system"));
        assert!(matches!(scan_markers(ro, &e, &[]), Found::Valid(r) if r.summary == "Prueba read-only" && r.ok));
        // La misma salida pasada por una terminal estrecha estilo ConPTY.
        assert!(matches!(scan_markers(&conpty(ro, 31), &e, &[]), Found::Valid(_)));
        let ww = include_bytes!("testdata/codex-sandbox-workspace-write-report.json");
        assert_eq!(parse_report(ww, &e).unwrap().summary, "Prueba workspace-write");
    }

    #[test]
    fn informe_doble_un_solo_done() {
        // Prueba 3: leído en el sondeo y otra vez al salir → un solo Kind::Done.
        let (mut st, root, id, dir) = setup("doble");
        let path = prepare(&dir.to_string_lossy(), &id, 1).unwrap();
        std::fs::write(&path, json(&id, NONCE, "Hecho")).unwrap();
        let e = ex(&id);
        for at_exit in [false, true] {
            let delivered = st.task(&id).unwrap().delivered.clone();
            let found = find(read_report_file(&path).as_deref(), None, &e, &delivered);
            apply(&mut st, &id, found, at_exit).unwrap();
        }
        assert_eq!(done_msgs(&st, &root), 1);
        assert_eq!(st.task(&id).unwrap().status, Status::Done);
        let key = idem_key(&id, 1, &sha256_hex(json(&id, NONCE, "Hecho").as_bytes()));
        assert_eq!(st.task(&id).unwrap().delivered, vec![key]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lxo_done_y_archivo_gana_el_primero() {
        // Prueba 4.
        let (mut st, root, id, dir) = setup("primero");
        st.done(&id, true, "por http", vec![], None).unwrap();
        let found = find(Some(json(&id, NONCE, "por archivo").as_bytes()), None, &ex(&id), &[]);
        assert!(apply(&mut st, &id, found, true).unwrap().is_empty());
        assert_eq!(st.task(&id).unwrap().summary, "por http");
        assert_eq!(done_msgs(&st, &root), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupto_grande_o_ajeno_falla_y_conserva_el_archivo() {
        // Prueba 5.
        let e = ex("t1");
        assert!(parse_report(b"{no es json", &e).unwrap_err().contains("JSON"));
        let big = json("t1", NONCE, "x").replace("hecho", &"a".repeat(MAX_FILE));
        assert!(parse_report(big.as_bytes(), &e).unwrap_err().contains("KiB"));
        assert!(parse_report(json("t9", NONCE, "x").as_bytes(), &e).unwrap_err().contains("task"));
        let sin = json("t1", NONCE, "");
        assert_eq!(parse_report(sin.as_bytes(), &e).unwrap_err(), "falta summary");
        let (mut st, _, id, dir) = setup("corrupto");
        let path = prepare(&dir.to_string_lossy(), &id, 1).unwrap();
        std::fs::write(&path, json("otra", NONCE, "x")).unwrap();
        let found = find(read_report_file(&path).as_deref(), None, &ex(&id), &[]);
        apply(&mut st, &id, found, true).unwrap();
        assert_eq!(st.task(&id).unwrap().status, Status::Failed);
        assert!(st.messages.last().unwrap().body.contains("informe inválido: report.json: task"));
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn solo_tmp_cuenta_como_falta() {
        // Prueba 6.
        let (mut st, _, id, dir) = setup("tmp");
        let path = prepare(&dir.to_string_lossy(), &id, 1).unwrap();
        std::fs::write(path.with_extension("json.tmp"), json(&id, NONCE, "x")).unwrap();
        let found = find(read_report_file(&path).as_deref(), Some(""), &ex(&id), &[]);
        assert_eq!(found, Found::Nothing);
        apply(&mut st, &id, found, true).unwrap();
        assert_eq!(st.task(&id).unwrap().status, Status::Exited);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reopen_no_recoge_el_informe_viejo() {
        // Prueba 7: el host borra .lixbon/out/<task>/ al relanzar y lo ya entregado
        // (mismo idem_key) se ignora aunque siga en la salida de la terminal.
        let (mut st, root, id, dir) = setup("reopen");
        let cwd = dir.to_string_lossy().into_owned();
        let path = prepare(&cwd, &id, 1).unwrap();
        let viejo = json(&id, NONCE, "Primero");
        std::fs::write(&path, &viejo).unwrap();
        let out = block(&viejo, NONCE);
        apply(&mut st, &id, find(read_report_file(&path).as_deref(), Some(&out), &ex(&id), &[]), false).unwrap();
        st.reopen(&id, "más").unwrap();
        let path = prepare(&cwd, &id, 1).unwrap();
        assert!(!path.exists());
        let delivered = st.task(&id).unwrap().delivered.clone();
        assert_eq!(find(read_report_file(&path).as_deref(), Some(&out), &ex(&id), &delivered), Found::Nothing);
        let nuevo = format!("{out}\n{}", block(&json(&id, NONCE, "Segundo"), NONCE));
        apply(&mut st, &id, find(None, Some(&nuevo), &ex(&id), &delivered), false).unwrap();
        assert_eq!(st.task(&id).unwrap().summary, "Segundo");
        assert_eq!(done_msgs(&st, &root), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn exec_o_es_la_via_principal_para_cualquier_tamano() {
        let (mut st, root, id, dir) = setup("exec-o");
        let cwd = dir.to_string_lossy().into_owned();
        prepare(&cwd, &id, 1).unwrap();
        let path = last_message_path(&cwd, &id, 1);
        assert!(path.ends_with(format!(".lixbon/out/{id}/1/last-message.md")));
        // 300 KB: más que MAX_FILE y que el respaldo por la salida; llega entero.
        let cuerpo = "línea con ñ y 🚀\n".repeat(300 * 1024 / 20);
        let msg = format!("LXO-RESULT nonce={NONCE} status=done\n# Revisión grande\n{cuerpo}");
        std::fs::write(&path, &msg).unwrap();
        let bytes = read_final_file(&path).unwrap();
        assert!(bytes.len() > MAX_FILE && bytes.len() > MAX_STDOUT);
        let src = Sources { expect_final: true, final_file: Some(&bytes), terminal: Some("ruido sin bloque"), ..Sources::default() };
        let found = find_all(&src, &ex(&id), &[]);
        let Found::Valid(r) = &found else { panic!("{found:?}") };
        assert_eq!((r.channel, r.summary.as_str(), r.ok), (Channel::ExecO, "Revisión grande", true));
        assert_eq!(r.report.as_deref().unwrap().len(), format!("# Revisión grande\n{cuerpo}").trim().len());
        apply(&mut st, &id, found, true).unwrap();
        let t = st.task(&id).unwrap();
        assert_eq!((t.status, t.delivery_channel.as_deref()), (Status::Done, Some("exec_o")));
        let copia = std::fs::read_to_string(t.report.clone().unwrap()).unwrap();
        assert!(copia.contains("línea con ñ y 🚀") && copia.len() > 300 * 1024 - 100);
        assert_eq!(done_msgs(&st, &root), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mensaje_final_sin_cabecera_o_con_cabecera_mala() {
        let e = ex("t1");
        let r = parse_final_message("## Hallazgos\n1. uno", &e, true, Channel::ExecO).unwrap();
        assert_eq!((r.summary.as_str(), r.ok), ("Hallazgos", true));
        let r = parse_final_message(&format!("LXO-RESULT nonce={NONCE} status=failed\nNo se pudo"), &e, true, Channel::ExecO).unwrap();
        assert!(!r.ok);
        assert!(parse_final_message("LXO-RESULT nonce=viejo status=done\nx", &e, true, Channel::ExecO).unwrap_err().contains("nonce"));
        assert!(parse_final_message(&format!("LXO-RESULT nonce={NONCE}\nx"), &e, true, Channel::ExecO).unwrap_err().contains("status"));
        assert!(parse_final_message("  \n", &e, true, Channel::ExecO).unwrap_err().contains("vacío"));
        let largo = "a".repeat(2000);
        assert_eq!(parse_final_message(&largo, &e, true, Channel::ExecO).unwrap().summary.chars().count(), MAX_SUMMARY);
        // Bytes que no son UTF-8: inválido, nunca se entrega «arreglado».
        let src = Sources { expect_final: true, final_file: Some(&[0xff, 0xfe, b'x']), ..Sources::default() };
        assert!(matches!(find_all(&src, &e, &[]), Found::Invalid(m) if m.contains("UTF-8")));
    }

    #[test]
    fn exec_o_ausente_queda_no_entregado() {
        let (mut st, _, id, dir) = setup("exec-o-falta");
        let src = Sources { expect_final: true, final_file: None, terminal: Some("codex terminó"), ..Sources::default() };
        let found = find_all(&src, &ex(&id), &[]);
        assert_eq!(found, Found::Undelivered(NO_EXEC_O.into()));
        // Durante el sondeo no cierra; al salir, Failed con motivo claro.
        apply(&mut st, &id, found.clone(), false).unwrap();
        assert!(!st.task(&id).unwrap().status.is_final());
        apply(&mut st, &id, found, true).unwrap();
        let t = st.task(&id).unwrap();
        assert_eq!((t.status, t.delivery_channel.clone()), (Status::Failed, None));
        assert!(st.messages.last().unwrap().body.contains(&format!("informe no entregado: {NO_EXEC_O}")));
        // Sin -o pero con un bloque válido por la salida: respaldo, canal stdout.
        let out = block(&json(&id, NONCE, "Por respaldo"), NONCE);
        let src = Sources { expect_final: true, final_file: None, terminal: Some(&out), ..Sources::default() };
        assert!(matches!(find_all(&src, &ex(&id), &[]), Found::Valid(r) if r.channel == Channel::Stdout));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn respaldo_por_salida_solo_hasta_50_kb() {
        let e = ex("t1");
        let chico = json("t1", NONCE, "chico").replace("hecho", &"a".repeat(40 * 1024));
        assert!(matches!(scan_markers(&block(&chico, NONCE), &e, &[]), Found::Valid(r) if r.channel == Channel::Stdout));
        let grande = json("t1", NONCE, "grande").replace("hecho", &"a".repeat(60 * 1024));
        let found = scan_markers(&block(&grande, NONCE), &e, &[]);
        assert!(matches!(&found, Found::Undelivered(m) if m.contains("50 KB")), "{found:?}");
        // Al salir: Failed como no entregado, sin informe recortado.
        let (mut st, _, id, dir) = setup("grande");
        let grande = json(&id, NONCE, "grande").replace("hecho", &"a".repeat(60 * 1024));
        apply(&mut st, &id, find(None, Some(&block(&grande, NONCE)), &ex(&id), &[]), true).unwrap();
        let t = st.task(&id).unwrap();
        assert_eq!((t.status, t.report.clone()), (Status::Failed, None));
        assert!(st.messages.last().unwrap().body.contains("informe no entregado"));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn stream(result: Option<&str>) -> String {
        let mut lines = vec![
            r#"{"type":"system","subtype":"init","model":"claude-haiku-5-5","permissionMode":"plan"}"#.to_string(),
            r#"{"type":"assistant","message":{"model":"claude-haiku-5-5-20260901","content":[{"type":"text","text":"Leyendo"}]}}"#.to_string(),
        ];
        if let Some(r) = result {
            lines.push(serde_json::json!({ "type": "result", "subtype": "success", "is_error": false, "result": r }).to_string());
        }
        // Como lo deja la salida canalizada: \r\n.
        lines.join("\r\n") + "\r\n"
    }

    #[test]
    fn claude_plan_entrega_por_stream_json_con_modelo() {
        let (mut st, _, id, dir) = setup("stream");
        let out = stream(Some(&format!("LXO-RESULT nonce={NONCE} status=done\n# Exploración\nTodo en src/a.rs:10")));
        let s = parse_stream_json(&out);
        assert_eq!(s.model.as_deref(), Some("claude-haiku-5-5-20260901"));
        let src = Sources { expect_stream: true, terminal: Some(&out), ..Sources::default() };
        let found = find_all(&src, &ex(&id), &[]);
        assert!(matches!(&found, Found::Valid(r) if r.channel == Channel::StreamJson && r.summary == "Exploración"));
        apply(&mut st, &id, found, false).unwrap();
        let t = st.task(&id).unwrap();
        assert_eq!(t.delivery_channel.as_deref(), Some("stream_json"));
        assert_eq!(t.model_effective.as_deref(), Some("claude-haiku-5-5-20260901"));
        assert!(!t.model_mismatch);
        // Una línea a medias no rompe nada; sin result, al salir queda no entregado.
        let parcial = format!("{}{{\"type\":\"result\",\"res", stream(None));
        assert_eq!(parse_stream_json(&parcial).result, None);
        let src = Sources { expect_stream: true, terminal: Some(&parcial), ..Sources::default() };
        assert_eq!(find_all(&src, &ex("t1"), &[]), Found::Undelivered(NO_STREAM_RESULT.into()));
        // El error de la CLI cuenta como fallo.
        let err = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"Se acabaron los turnos"}"#;
        let src = Sources { expect_stream: true, terminal: Some(err), ..Sources::default() };
        assert!(matches!(find_all(&src, &ex("t1"), &[]), Found::Valid(r) if !r.ok));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn salidas_reales_de_codex_exec_o_y_claude_stream_json() {
        // Grabadas en Windows: `codex exec --sandbox read-only -o <archivo>` (0.162.1) y
        // `claude -p --output-format stream-json --verbose ... --permission-mode plan` (2.1.296).
        let e = Expect { task: "t1".into(), attempt: 1, nonce: "abc123".into() };
        let lm = include_bytes!("testdata/codex-0.162.1-exec-o-last-message.md");
        let src = Sources { expect_final: true, final_file: Some(lm), ..Sources::default() };
        match find_all(&src, &e, &[]) {
            Found::Valid(r) => {
                assert_eq!(r.channel, Channel::ExecO);
                assert!(r.ok && r.report.unwrap().contains("hola"));
            }
            other => panic!("{other:?}"),
        }
        let raw = include_str!("testdata/claude-2.1.296-plan-stream-json.jsonl");
        let src = Sources { expect_stream: true, terminal: Some(raw), ..Sources::default() };
        match find_all(&src, &e, &[]) {
            Found::Valid(r) => {
                assert_eq!(r.channel, Channel::StreamJson);
                assert!(r.ok && r.report.unwrap().ends_with("hola"));
                // Se pidió --model haiku y la CLI informó otro modelo: se guarda el efectivo.
                assert_eq!(r.model.as_deref(), Some("claude-sonnet-5-5"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn model_mismatch_solo_si_se_pidio_y_es_otra_familia() {
        let out = stream(Some("# Hecho"));
        let otro = out.replace("claude-haiku-5-5-20260901", "claude-sonnet-5-5");
        for (requested, raw, mismatch) in [(Some("haiku"), &out, false), (Some("haiku"), &otro, true), (None, &otro, false)] {
            let (mut st, _, id, dir) = setup("mismatch");
            st.task_mut(&id).unwrap().model_requested = requested.map(String::from);
            let src = Sources { expect_stream: true, terminal: Some(raw), ..Sources::default() };
            apply(&mut st, &id, find_all(&src, &ex(&id), &[]), true).unwrap();
            let t = st.task(&id).unwrap();
            assert_eq!(t.model_mismatch, mismatch, "{requested:?} {:?}", t.model_effective);
            let v = serde_json::to_value(t).unwrap();
            for k in ["model_requested", "model_effective", "model_mismatch", "delivery_channel"] {
                assert!(v.get(k).is_some(), "falta {k}");
            }
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn modelo_efectivo_nunca_del_init() {
        // Grabación real en plan: el init dice claude-haiku-5-5, responde sonnet.
        let raw = include_str!("testdata/claude-2.1.296-plan-stream-json.jsonl");
        assert!(raw.contains(r#""subtype":"init""#) && raw.contains(r#""model":"claude-haiku-5-5""#));
        assert_eq!(parse_stream_json(raw).model.as_deref(), Some("claude-sonnet-5-5"));
        // Solo init: sin modelo efectivo.
        let init = r#"{"type":"system","subtype":"init","model":"claude-haiku-5-5"}"#;
        assert_eq!(parse_stream_json(init).model, None);
        // Sin message.model, sale de modelUsage del result.
        let usage = format!("{init}\n{}", r#"{"type":"result","subtype":"success","is_error":false,"result":"ok","modelUsage":{"claude-sonnet-5-5":{"outputTokens":212},"claude-haiku-5-5":{"outputTokens":3}}}"#);
        assert_eq!(parse_stream_json(&usage).model.as_deref(), Some("claude-sonnet-5-5"));
    }

    #[test]
    fn motivo_del_mismatch_en_plan() {
        let raw = include_str!("testdata/claude-2.1.296-plan-stream-json.jsonl");
        let e = Expect { task: String::new(), attempt: 1, nonce: "abc123".into() };
        for (requested, plan, mismatch, reason) in [
            (Some("haiku"), true, true, Some("plan_mode")),
            (Some("haiku"), false, true, None),
            (Some("sonnet"), true, false, None),
            (None, true, false, None),
        ] {
            let (mut st, _, id, dir) = setup("motivo");
            let t = st.task_mut(&id).unwrap();
            t.model_requested = requested.map(String::from);
            t.plan_mode = plan;
            let src = Sources { expect_stream: true, terminal: Some(raw), ..Sources::default() };
            apply(&mut st, &id, find_all(&src, &Expect { task: id.clone(), ..e.clone() }, &[]), true).unwrap();
            let t = st.task(&id).unwrap();
            assert_eq!((t.model_mismatch, t.model_mismatch_reason.as_deref()), (mismatch, reason), "{requested:?} plan={plan}");
            assert!(serde_json::to_value(t).unwrap().get("model_mismatch_reason").is_some());
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn datos_de_prueba_nuevos_sin_crlf() {
        // .gitattributes los fija en LF: un \r\n cambiaría el sha256 y el parseo.
        for (name, bytes) in [
            ("claude-2.1.296-plan-stream-json.jsonl", &include_bytes!("testdata/claude-2.1.296-plan-stream-json.jsonl")[..]),
            ("codex-0.162.1-exec-help.txt", &include_bytes!("testdata/codex-0.162.1-exec-help.txt")[..]),
            ("codex-0.162.1-exec-o-last-message.md", &include_bytes!("testdata/codex-0.162.1-exec-o-last-message.md")[..]),
        ] {
            assert!(!bytes.windows(2).any(|w| w == b"\r\n"), "{name} trae \\r\\n");
        }
    }

    #[test]
    fn entrega_con_ancho_pedido_40_60_76() {
        // La UI pide 40, 60 o 76 columnas; el host deja la PTY en su mínimo.
        let e = ex("t1");
        let j = json("t1", NONCE, "Ancho fijo");
        let b = block(&j, NONCE);
        for pedido in [40u16, 60, 76] {
            let real = crate::orch::pty::clamp_cols(pedido) as usize;
            assert_eq!(real, crate::orch::pty::MIN_COLS as usize);
            let raw = conpty(&format!("previo\n{b}\nfin"), real);
            match scan_markers(&raw, &e, &[]) {
                Found::Valid(r) => assert_eq!(r.sha256, sha256_hex(j.as_bytes()), "{pedido}"),
                other => panic!("{pedido}: {other:?}"),
            }
        }
    }

    #[test]
    fn idem_key_del_contrato() {
        let k = idem_key("t1", 1, "abc");
        assert_eq!(k, sha256_hex(b"t1\x001\x00abc"));
        assert_ne!(k, idem_key("t1", 2, "abc"));
    }
}
