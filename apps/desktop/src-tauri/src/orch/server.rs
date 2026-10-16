//! HTTP local por el que habla `lxo`. Solo 127.0.0.1 y con token: el puerto y
//! el token se publican en `~/.lixbon/orch.json`, legible solo por el usuario.
//! `POST /rpc` despacha comandos; `GET /events` es la lectura del Event Log (events_read.rs).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use super::Core;

pub struct Handle {
    pub port: u16,
    pub token: String,
    stop: Arc<AtomicBool>,
}

impl Handle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        // Despierta al accept bloqueado para que el hilo vea la señal y salga.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

const MAX_BODY: usize = 4 * 1024 * 1024;

pub fn start(core: Arc<Core>) -> Result<Handle, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = super::random_token();
    let stop = Arc::new(AtomicBool::new(false));
    let (tok, stop_t) = (token.clone(), stop.clone());
    thread::spawn(move || {
        for conn in listener.incoming() {
            if stop_t.load(Ordering::Relaxed) {
                break;
            }
            let Ok(stream) = conn else { continue };
            let (core, tok) = (core.clone(), tok.clone());
            thread::spawn(move || {
                let _ = handle(stream, &core, &tok);
            });
        }
    });
    Ok(Handle { port, token, stop })
}

fn handle(mut stream: TcpStream, core: &Arc<Core>, token: &str) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));

    let mut len = 0usize;
    let mut auth = String::new();
    let mut caller_header = String::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        let (k, v) = h.split_once(':').unwrap_or((&h, ""));
        match k.trim().to_ascii_lowercase().as_str() {
            "content-length" => len = v.trim().parse().unwrap_or(0),
            "authorization" => auth = v.trim().to_string(),
            "x-lixbon-caller" => caller_header = v.trim().to_string(),
            _ => {}
        }
    }
    if len > MAX_BODY {
        return reply(&mut stream, 413, &json!({ "ok": false, "error": "Petición demasiado grande" }));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;

    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    if route == "/events" {
        if auth != format!("Bearer {token}") {
            return reply(&mut stream, 401, &json!({ "ok": false, "error": "Token inválido: vuelve a abrir la terminal o reinicia Lixbon" }));
        }
        if method != "GET" {
            return reply(&mut stream, 405, &json!({ "ok": false, "error": "El Event Log es de solo lectura: usa GET /events" }));
        }
        let caller = Some(caller_header).filter(|c| !c.is_empty());
        let (code, body) = core.events_http(super::Caller::Agent(caller), query);
        return reply(&mut stream, code, &body);
    }
    if method != "POST" || path != "/rpc" {
        return reply(&mut stream, 404, &json!({ "ok": false, "error": "No encontrado" }));
    }
    if auth != format!("Bearer {token}") {
        return reply(&mut stream, 401, &json!({ "ok": false, "error": "Token inválido: vuelve a abrir la terminal o reinicia Lixbon" }));
    }
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let caller = req.get("caller").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
    let cwd = req.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or("");
    let args = req.get("args").cloned().unwrap_or(Value::Null);
    // Las esperas largas (wait, ask) superan el timeout de lectura por diseño.
    stream.set_read_timeout(None)?;
    // Rechazo explícito antes de despachar: decisiones humanas y lecturas cerradas (review.rs).
    if let Some(why) = super::review::closed_to_agents(cmd) {
        return reply(&mut stream, 200, &json!({ "ok": false, "error": why }));
    }
    // Un pánico dentro de un comando no debe cortar la conexión sin decir nada: el agente recibe el motivo.
    let res = guarded(cmd, || core.rpc_via(super::events::Channel::Lxo, super::Caller::Agent(caller), &cwd, cmd, &args));
    reply(&mut stream, 200, &res)
}

fn guarded(cmd: &str, run: impl FnOnce() -> Result<Value, String>) -> Value {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
        Ok(Ok(v)) => json!({ "ok": true, "data": v }),
        Ok(Err(e)) => json!({ "ok": false, "error": e }),
        Err(panic) => {
            let why = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            json!({ "ok": false, "error": format!("Error interno de Lixbon en «{cmd}»: {why}") })
        }
    }
}

fn reply(stream: &mut TcpStream, code: u16, body: &Value) -> std::io::Result<()> {
    let text = body.to_string();
    let status = match code {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        503 => "Service Unavailable",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {code} {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    )?;
    stream.flush()?;
    // Cierre ordenado: cerrar de golpe con algo sin leer del otro lado manda un RST en Windows y el
    // cliente pierde el final de la respuesta («conexión forzada»). Se avisa del fin y se espera su cierre.
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut sink = [0u8; 512];
    while matches!(stream.read(&mut sink), Ok(n) if n > 0) {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orch::state::NewTask;
    use crate::orch::Orch;

    #[test]
    fn un_panico_en_un_comando_llega_como_error_con_el_motivo() {
        let r = guarded("show", || panic!("se rompió"));
        assert_eq!(r["ok"], false);
        let e = r["error"].as_str().unwrap();
        assert!(e.contains("«show»") && e.contains("se rompió"), "{e}");
        let propio = String::from("motivo propio");
        let r = guarded("list", move || -> Result<Value, String> { std::panic::panic_any(propio) });
        assert!(r["error"].as_str().unwrap().contains("motivo propio"));
        assert_eq!(guarded("x", || Ok(json!(1)))["data"], 1);
        assert_eq!(guarded("x", || Err("no".into()))["error"], "no");
    }

    #[test]
    fn una_respuesta_grande_llega_completa_aunque_el_cliente_lea_despacio() {
        let core = Orch::default().0;
        core.settings.lock().unwrap().enabled = true;
        let spec = "x".repeat(3 * 1024 * 1024);
        core.lock_unpersisted().create_run("obj", NewTask {
            agent: "coordinador".into(), model: None, effort: None, role: None, title: "t".into(), spec: spec.clone(),
            repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: true,
        });
        let h = start(core).unwrap();
        let body = r#"{"cmd":"list","args":{}}"#;
        let mut s = TcpStream::connect(("127.0.0.1", h.port)).unwrap();
        // Bytes de más tras el cuerpo: sin leer en el servidor al cerrar, Windows manda un RST.
        write!(s, "POST /rpc HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n{}EXTRA-SIN-LEER", h.token, body.len(), body).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let mut raw = Vec::new();
        let mut chunk = [0u8; 32 * 1024];
        loop {
            match s.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    raw.extend_from_slice(&chunk[..n]);
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(e) => panic!("la conexión se cortó a mitad de la respuesta: {e}"),
            }
        }
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let len: usize = head.lines().find_map(|l| l.strip_prefix("Content-Length: ")).unwrap().trim().parse().unwrap();
        assert_eq!(raw.len() - split, len, "respuesta truncada");
        let v: Value = serde_json::from_slice(&raw[split..]).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["data"]["tasks"][0]["spec"].as_str().unwrap().len(), spec.len());
        h.stop();
    }

    #[test]
    fn sin_el_token_correcto_no_se_despacha_nada() {
        let core = Orch::default().0;
        core.settings.lock().unwrap().enabled = true;
        let h = start(core).unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", h.port)).unwrap();
        let body = r#"{"cmd":"status"}"#;
        write!(s, "POST /rpc HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer incorrecto\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 401"), "{out}");
        h.stop();
    }
}
