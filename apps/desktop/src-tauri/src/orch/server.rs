//! HTTP local por el que habla `lxo`. Solo 127.0.0.1 y con token: el puerto y
//! el token se publican en `~/.lixbon/orch.json`, legible solo por el usuario.

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
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        let (k, v) = h.split_once(':').unwrap_or((&h, ""));
        match k.trim().to_ascii_lowercase().as_str() {
            "content-length" => len = v.trim().parse().unwrap_or(0),
            "authorization" => auth = v.trim().to_string(),
            _ => {}
        }
    }
    if len > MAX_BODY {
        return reply(&mut stream, 413, &json!({ "ok": false, "error": "Petición demasiado grande" }));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;

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
    let res = match core.rpc(super::Caller::Agent(caller), &cwd, cmd, &args) {
        Ok(v) => json!({ "ok": true, "data": v }),
        Err(e) => json!({ "ok": false, "error": e }),
    };
    reply(&mut stream, 200, &res)
}

fn reply(stream: &mut TcpStream, code: u16, body: &Value) -> std::io::Result<()> {
    let text = body.to_string();
    let status = match code {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {code} {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    )?;
    stream.flush()
}
