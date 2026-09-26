//! Servidor estático local para los visuales (HTML, SVG, imágenes del
//! Markdown) que se ven dentro del IDE. La CSP del WebView hereda en los
//! iframes srcdoc y bloquearía sus scripts; una página servida desde
//! 127.0.0.1 (permitido en frame-src) trae su propio origen y no la hereda.
//! Solo expone la carpeta de trabajo (`/w/`) y los fragmentos del chat
//! (`/s/`), detrás de un token aleatorio por proceso.

use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, State};

use crate::WorkspaceRoot;

struct Inner {
    token: String,
    workspace: Mutex<Option<PathBuf>>,
    snippets: Mutex<Option<PathBuf>>,
}

pub struct VisualServer {
    inner: Arc<Inner>,
    port: Mutex<Option<u16>>,
}

impl Default for VisualServer {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner { token: random_token(), workspace: Mutex::new(None), snippets: Mutex::new(None) }),
            port: Mutex::new(None),
        }
    }
}

fn random_token() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let part = || {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(nanos);
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

fn content_hash(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn mime(path: &Path) -> &'static str {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "txt" | "md" | "csv" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn resolve(inner: &Inner, target: &str) -> Option<PathBuf> {
    let path = target.split(['?', '#']).next()?;
    let rest = path.strip_prefix('/')?.strip_prefix(inner.token.as_str())?.strip_prefix('/')?;
    let (kind, rel) = rest.split_once('/').unwrap_or((rest, ""));
    let base = match kind {
        "w" => inner.workspace.lock().unwrap().clone()?,
        "s" => inner.snippets.lock().unwrap().clone()?,
        _ => return None,
    };
    let rel = percent_decode(rel)?;
    let mut file = base.join(rel.trim_start_matches(['/', '\\'])).canonicalize().ok()?;
    if !file.starts_with(&base) { return None; }
    if file.is_dir() { file = file.join("index.html"); }
    file.is_file().then_some(file)
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8], head_only: bool) -> Option<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).ok()?;
    if !head_only { stream.write_all(body).ok()?; }
    Some(())
}

fn handle(mut stream: TcpStream, inner: Arc<Inner>) -> Option<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request = String::new();
    reader.read_line(&mut request).ok()?;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 || line.trim().is_empty() { break; }
    }
    let mut parts = request.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;
    let head_only = method == "HEAD";
    if method != "GET" && !head_only {
        return respond(&mut stream, "405 Method Not Allowed", "text/plain", b"", false);
    }
    match resolve(&inner, target).and_then(|p| fs::read(&p).ok().map(|b| (p, b))) {
        Some((path, body)) => respond(&mut stream, "200 OK", mime(&path), &body, head_only),
        None => respond(&mut stream, "404 Not Found", "text/plain; charset=utf-8", b"No encontrado", head_only),
    }
}

impl VisualServer {
    fn base_url(&self) -> Result<String, String> {
        let mut port = self.port.lock().unwrap();
        let p = match *port {
            Some(p) => p,
            None => {
                let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
                let p = listener.local_addr().map_err(|e| e.to_string())?.port();
                let inner = self.inner.clone();
                thread::spawn(move || {
                    for conn in listener.incoming().flatten() {
                        let inner = inner.clone();
                        thread::spawn(move || { let _ = handle(conn, inner); });
                    }
                });
                *port = Some(p);
                p
            }
        };
        Ok(format!("http://127.0.0.1:{p}/{}/", self.inner.token))
    }
}

/// URL base con la que se sirve la carpeta de trabajo actual.
#[tauri::command]
pub fn visual_base(root: State<'_, WorkspaceRoot>, server: State<'_, VisualServer>) -> Result<String, String> {
    let ws = root.0.lock().unwrap().clone().ok_or("No hay carpeta de trabajo")?;
    let ws = ws.canonicalize().map_err(|e| e.to_string())?;
    *server.inner.workspace.lock().unwrap() = Some(ws);
    Ok(format!("{}w/", server.base_url()?))
}

/// Guarda un fragmento del chat (```html, ```svg) y devuelve su URL.
#[tauri::command]
pub fn visual_snippet(app: AppHandle, content: String, ext: String, server: State<'_, VisualServer>) -> Result<String, String> {
    let ext = if matches!(ext.as_str(), "html" | "svg") { ext } else { "html".into() };
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("visuals");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let name = format!("{}.{ext}", content_hash(&content));
    fs::write(dir.join(&name), content.as_bytes()).map_err(|e| e.to_string())?;
    *server.inner.snippets.lock().unwrap() = Some(dir);
    Ok(format!("{}s/{name}", server.base_url()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inner_with(dir: &Path) -> Inner {
        Inner { token: "tok".into(), workspace: Mutex::new(Some(dir.canonicalize().unwrap())), snippets: Mutex::new(None) }
    }

    #[test]
    fn resolves_only_inside_the_workspace() {
        let dir = std::env::temp_dir().join(format!("lixbon-visual-{}", random_token()));
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("a b.html"), "<p>hola</p>").unwrap();
        fs::write(dir.join("index.html"), "raiz").unwrap();
        let inner = inner_with(&dir);

        assert!(resolve(&inner, "/tok/w/sub/a%20b.html?x=1").is_some());
        assert!(resolve(&inner, "/tok/w/").unwrap().ends_with("index.html"));
        assert!(resolve(&inner, "/otro/w/index.html").is_none());
        assert!(resolve(&inner, "/tok/w/../index.html").is_none());
        assert!(resolve(&inner, "/tok/w/%2e%2e/%2e%2e/Windows/win.ini").is_none());
        assert!(resolve(&inner, "/tok/s/x.html").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%20b%C3%B1").unwrap(), "a bñ");
        assert!(percent_decode("%zz").is_none());
    }
}
