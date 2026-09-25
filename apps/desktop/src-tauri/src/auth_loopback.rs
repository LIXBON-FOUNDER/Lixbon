//! Vuelta del navegador en el inicio de sesión con lixbon.com
//! (`core/gateway/routers/ide_auth.py`): un servidor efímero en 127.0.0.1
//! recibe `/callback?token=…&state=…` una sola vez y lo pasa al frontend, que
//! hace el canje con el verificador.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

const WAIT: Duration = Duration::from_secs(300);

const DONE_PAGE: &str = "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\"><title>lixbon</title>\
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070707;color:#F2F2EE;\
font:15px/1.6 system-ui,sans-serif}main{text-align:center}h1{font-size:20px;margin:0 0 6px}p{margin:0;color:#85857F}</style>\
</head><body><main><h1>Listo</h1><p>Vuelve a lixbon desktop; ya puedes cerrar esta pestaña.</p></main></body></html>";

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(b) => { out.push(b); i += 2; }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn param(query: &str, key: &str) -> String {
    query
        .split('&')
        .find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == key).map(|(_, v)| decode(v)))
        .unwrap_or_default()
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
}

/// Devuelve el puerto; el resultado llega como evento `auth:callback`
/// ({ token, state }) o `auth:timeout` si nadie vuelve en 5 minutos.
#[tauri::command]
pub fn auth_loopback_start(app: AppHandle) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;

    thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < WAIT {
            let mut stream = match listener.accept() {
                Ok((s, _)) => s,
                Err(_) => { thread::sleep(Duration::from_millis(150)); continue; }
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let head = String::from_utf8_lossy(&buf[..n]);
            let target = head.split_whitespace().nth(1).unwrap_or("");
            let (path, query) = target.split_once('?').unwrap_or((target, ""));
            if path != "/callback" {
                respond(&mut stream, "404 Not Found", "");
                continue;
            }
            respond(&mut stream, "200 OK", DONE_PAGE);
            let _ = app.emit(
                "auth:callback",
                serde_json::json!({ "token": param(query, "token"), "state": param(query, "state") }),
            );
            return;
        }
        let _ = app.emit("auth:timeout", ());
    });
    Ok(port)
}
