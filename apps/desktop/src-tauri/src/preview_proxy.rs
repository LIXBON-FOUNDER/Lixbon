//! Proxy local del modo Diseño. El iframe de la vista previa es de otro origen
//! y el IDE no puede mirar dentro; este proxy sirve el servidor de desarrollo
//! desde 127.0.0.1 e inyecta en cada página HTML un script (inspector.js) que
//! le cuenta al IDE, por postMessage, qué elemento hay bajo el cursor y qué
//! capas tiene la página. Los websockets (HMR) pasan tal cual.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::State;

const INSPECTOR: &str = include_str!("inspector.js");

#[derive(Default)]
pub struct PreviewProxy {
    port: Mutex<Option<u16>>,
    target: Arc<Mutex<String>>, // host:puerto del servidor de desarrollo
}

fn parse_target(url: &str) -> Result<String, String> {
    let rest = url.strip_prefix("http://").ok_or("Solo se admite http:// para la vista previa inspeccionable")?;
    let host = rest.split('/').next().unwrap_or("");
    let name = host.split(':').next().unwrap_or("");
    // Solo el propio equipo: el proxy no debe convertirse en un salto hacia fuera.
    if !matches!(name, "localhost" | "127.0.0.1" | "[::1]") {
        return Err("La vista previa inspeccionable solo funciona con servidores locales".into());
    }
    Ok(if host.contains(':') { host.to_string() } else { format!("{host}:80") })
}

fn read_head(reader: &mut BufReader<TcpStream>) -> Option<Vec<String>> {
    let mut lines = Vec::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 { return None; }
        let line = line.trim_end_matches(['\r', '\n']).to_string();
        if line.is_empty() { return Some(lines); }
        lines.push(line);
        if lines.len() > 200 { return None; }
    }
}

fn header<'a>(lines: &'a [String], name: &str) -> Option<&'a str> {
    lines.iter().skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

fn pipe(mut from: impl Read, mut to: impl Write) {
    let mut buf = [0u8; 16384];
    while let Ok(n) = from.read(&mut buf) {
        if n == 0 || to.write_all(&buf[..n]).is_err() { break; }
    }
}

fn read_chunked(reader: &mut impl BufRead) -> Vec<u8> {
    let mut body = Vec::new();
    loop {
        let mut size = String::new();
        if reader.read_line(&mut size).unwrap_or(0) == 0 { break; }
        let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
        if n == 0 { break; }
        let mut chunk = vec![0u8; n];
        if reader.read_exact(&mut chunk).is_err() { break; }
        body.extend_from_slice(&chunk);
        let mut crlf = [0u8; 2];
        let _ = reader.read_exact(&mut crlf);
    }
    body
}

fn inject(html: Vec<u8>) -> Vec<u8> {
    let text = String::from_utf8_lossy(&html).into_owned();
    let tag = format!("<script data-lixbon-inspector>{INSPECTOR}</script>");
    let lower = text.to_ascii_lowercase();
    let at = lower.find("</head>").or_else(|| lower.find("<body")).unwrap_or(0);
    let mut out = String::with_capacity(text.len() + tag.len());
    out.push_str(&text[..at]);
    out.push_str(&tag);
    out.push_str(&text[at..]);
    out.into_bytes()
}

fn handle(client: TcpStream, target: String) -> Option<()> {
    client.set_read_timeout(Some(Duration::from_secs(30))).ok();
    let mut reader = BufReader::new(client.try_clone().ok()?);
    let head = read_head(&mut reader)?;
    let upgrade = header(&head, "upgrade").is_some();

    let mut upstream = TcpStream::connect(&target).ok()?;
    let mut req = String::new();
    req.push_str(&head[0]);
    req.push_str("\r\n");
    for line in head.iter().skip(1) {
        let key = line.split(':').next().unwrap_or("").trim().to_ascii_lowercase();
        if key == "host" { req.push_str(&format!("Host: {target}\r\n")); continue; }
        // Sin compresión (para poder inyectar) y una respuesta por conexión
        // (así el final del cuerpo es el cierre, sin reglas de keep-alive).
        if !upgrade && (key == "accept-encoding" || key == "connection") { continue; }
        req.push_str(line);
        req.push_str("\r\n");
    }
    if !upgrade { req.push_str("Accept-Encoding: identity\r\nConnection: close\r\n"); }
    req.push_str("\r\n");
    upstream.write_all(req.as_bytes()).ok()?;

    if upgrade {
        let up2 = upstream.try_clone().ok()?;
        let mut cl2 = client.try_clone().ok()?;
        client.set_read_timeout(None).ok();
        let t = thread::spawn(move || pipe(up2, &mut cl2));
        pipe(reader, &mut upstream);
        let _ = t.join();
        return Some(());
    }

    if let Some(len) = header(&head, "content-length").and_then(|v| v.parse::<u64>().ok()) {
        let mut body = (&mut reader).take(len);
        std::io::copy(&mut body, &mut upstream).ok()?;
    }

    let mut up_reader = BufReader::new(upstream);
    let resp = read_head(&mut up_reader)?;
    let mut client = client;
    let is_html = header(&resp, "content-type").map(|v| v.contains("text/html")).unwrap_or(false);
    if !is_html {
        let mut out = String::new();
        for line in &resp { out.push_str(line); out.push_str("\r\n"); }
        out.push_str("\r\n");
        client.write_all(out.as_bytes()).ok()?;
        pipe(up_reader, &mut client);
        return Some(());
    }

    let chunked = header(&resp, "transfer-encoding").map(|v| v.contains("chunked")).unwrap_or(false);
    let body = if chunked {
        read_chunked(&mut up_reader)
    } else {
        let mut b = Vec::new();
        let _ = up_reader.read_to_end(&mut b);
        b
    };
    let body = inject(body);
    let mut out = String::new();
    out.push_str(&resp[0]);
    out.push_str("\r\n");
    for line in resp.iter().skip(1) {
        let key = line.split(':').next().unwrap_or("").trim().to_ascii_lowercase();
        // La CSP de la página bloquearía el script inyectado.
        if matches!(key.as_str(), "content-length" | "transfer-encoding" | "connection" | "content-security-policy") { continue; }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()));
    client.write_all(out.as_bytes()).ok()?;
    client.write_all(&body).ok()?;
    Some(())
}

/// Arranca el proxy (una sola vez) o cambia su destino. Devuelve el puerto.
#[tauri::command]
pub fn preview_proxy_start(url: String, state: State<'_, PreviewProxy>) -> Result<u16, String> {
    let target = parse_target(&url)?;
    *state.target.lock().unwrap() = target;
    let mut port = state.port.lock().unwrap();
    if let Some(p) = *port { return Ok(p); }
    let p = listen(state.target.clone())?;
    *port = Some(p);
    Ok(p)
}

fn listen(target: Arc<Mutex<String>>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let p = listener.local_addr().map_err(|e| e.to_string())?.port();
    thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let target = target.lock().unwrap().clone();
            thread::spawn(move || { let _ = handle(conn, target); });
        }
    });
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn upstream(response: &'static str) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut c in l.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let _ = c.read(&mut buf);
                let _ = c.write_all(response.as_bytes());
            }
        });
        port
    }

    fn get(port: u16, path: &str) -> String {
        let mut c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(c, "GET {path} HTTP/1.1\r\nHost: x\r\nAccept-Encoding: gzip\r\n\r\n").unwrap();
        let mut out = String::new();
        c.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn injects_into_chunked_html() {
        let up = upstream("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\nContent-Security-Policy: script-src 'self'\r\n\r\n19\r\n<html><head></head><body>\r\n7\r\nhola</b\r\n0\r\n\r\n");
        let proxy = listen(Arc::new(Mutex::new(format!("127.0.0.1:{up}")))).unwrap();
        let out = get(proxy, "/");
        assert!(out.contains("data-lixbon-inspector"));
        assert!(out.contains("<body>hola</b"));
        assert!(!out.to_ascii_lowercase().contains("content-security-policy"));
        assert!(out.contains("Content-Length:"));
    }

    #[test]
    fn passes_other_content_through() {
        let up = upstream("HTTP/1.1 200 OK\r\nContent-Type: text/css\r\nContent-Length: 9\r\n\r\nbody{a:b}");
        let proxy = listen(Arc::new(Mutex::new(format!("127.0.0.1:{up}")))).unwrap();
        let out = get(proxy, "/a.css");
        assert!(out.ends_with("body{a:b}"));
        assert!(!out.contains("lixbon"));
    }

    #[test]
    fn rejects_remote_targets() {
        assert!(parse_target("http://example.com").is_err());
        assert!(parse_target("https://localhost:3000").is_err());
        assert_eq!(parse_target("http://localhost:5173/x").unwrap(), "localhost:5173");
    }
}
