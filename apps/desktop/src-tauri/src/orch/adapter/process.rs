//! El proceso de `claude` detrás de un trait mínimo (LXO-129): el adapter habla con [`Process`], no con `std::process`.
//! Así las pruebas lo sustituyen por un proceso guionizado con las capturas reales y el lanzador real se valida aparte.
//!
//! Dos propiedades de seguridad viven aquí: las variables de entorno nunca salen en un `Debug` ([`LaunchSpec`]) y una línea
//! de stdout nunca crece sin límite.

use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::orch::adapter::redact::safe_text;
use crate::orch::adapter::AdapterError;

/// Una línea de stdout más larga que esto se descarta (llega como [`OVERSIZE`]): un volcado no puede agotar la memoria.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;
/// Marcador que sustituye a una línea descartada por larga. No es JSON: el parser lo cuenta como malformado.
pub const OVERSIZE: &str = "<línea demasiado larga>";
const STDERR_TAIL_BYTES: usize = 4096;

/// Cómo arrancar la CLI. `env` lleva valores sensibles (el token del endpoint): por eso `Debug` los oculta.
#[derive(Clone)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    /// Variables heredadas que NO deben llegar al hijo (la clave de Anthropic cuando se usa otro endpoint).
    pub env_remove: Vec<String>,
}

impl fmt::Debug for LaunchSpec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<&str> = self.env.iter().map(|(k, _)| k.as_str()).collect();
        f.debug_struct("LaunchSpec").field("program", &self.program).field("args", &self.args).field("cwd", &self.cwd).field("env", &names).field("env_remove", &self.env_remove).finish()
    }
}

/// Lo que devuelve esperar una línea.
#[derive(Debug, PartialEq, Eq)]
pub enum Recv {
    Line(String),
    /// El proceso cerró stdout.
    Eof,
    Timeout,
}

/// Un proceso vivo. Todos los métodos son `&self` y thread-safe: `events` lee mientras `answer`/`interrupt` escriben.
pub trait Process: Send + Sync {
    fn send(&self, line: &str) -> Result<(), AdapterError>;
    fn recv(&self, timeout: Duration) -> Recv;
    /// Cierra stdin: la CLI termina sola al acabar el turno.
    fn close_input(&self);
    /// Mata el proceso y sus hijos.
    fn kill(&self);
    /// Cola de stderr, ya redactada: es lo que acompaña a un fallo como diagnóstico.
    fn stderr_tail(&self) -> String;
}

pub trait Launcher: Send + Sync {
    fn launch(&self, spec: &LaunchSpec) -> Result<Arc<dyn Process>, AdapterError>;
}

/// Lee una línea de como mucho `MAX_LINE_BYTES`; el resto, hasta el salto, se descarta.
fn read_bounded_line(r: &mut impl BufRead) -> Option<String> {
    let mut buf = Vec::new();
    let mut limited = r.by_ref().take(MAX_LINE_BYTES as u64 + 1);
    let n = limited.read_until(b'\n', &mut buf).ok()?;
    if n == 0 {
        return None;
    }
    if buf.len() > MAX_LINE_BYTES && buf.last() != Some(&b'\n') {
        // Descarta el resto de la línea sin guardarlo.
        let mut sink = Vec::new();
        loop {
            sink.clear();
            match r.by_ref().take(64 * 1024).read_until(b'\n', &mut sink) {
                Ok(0) | Err(_) => break,
                Ok(_) if sink.last() == Some(&b'\n') => break,
                Ok(_) => {}
            }
        }
        return Some(OVERSIZE.to_string());
    }
    Some(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string())
}

pub struct ChildProcess {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    rx: Mutex<Receiver<Option<String>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
}

impl Process for ChildProcess {
    fn send(&self, line: &str) -> Result<(), AdapterError> {
        let mut guard = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
        let stdin = guard.as_mut().ok_or_else(|| AdapterError::provider("la entrada del proceso ya está cerrada"))?;
        writeln!(stdin, "{line}").and_then(|_| stdin.flush()).map_err(|e| AdapterError::provider(&format!("no se pudo escribir al proceso: {e}")))
    }

    fn recv(&self, timeout: Duration) -> Recv {
        let rx = self.rx.lock().unwrap_or_else(|e| e.into_inner());
        match rx.recv_timeout(timeout) {
            Ok(Some(l)) => Recv::Line(l),
            Ok(None) | Err(RecvTimeoutError::Disconnected) => Recv::Eof,
            Err(RecvTimeoutError::Timeout) => Recv::Timeout,
        }
    }

    fn close_input(&self) {
        *self.stdin.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn kill(&self) {
        self.close_input();
        crate::mcp::kill_tree(&mut self.child.lock().unwrap_or_else(|e| e.into_inner()));
    }

    fn stderr_tail(&self) -> String {
        let b = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
        safe_text(&String::from_utf8_lossy(&b), STDERR_TAIL_BYTES)
    }
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        // Un adapter que suelta el proceso sin cerrarlo no deja una CLI huérfana.
        if let Ok(mut c) = self.child.lock() {
            if matches!(c.try_wait(), Ok(None)) {
                crate::mcp::kill_tree(&mut c);
            }
        }
    }
}

pub struct RealLauncher;

impl Launcher for RealLauncher {
    fn launch(&self, spec: &LaunchSpec) -> Result<Arc<dyn Process>, AdapterError> {
        // Un .cmd (npm) en Windows se ejecuta a través de cmd, igual que en `agents.rs`.
        let mut cmd = if cfg!(windows) && spec.program.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")) {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(&spec.program);
            c
        } else {
            Command::new(&spec.program)
        };
        cmd.args(&spec.args).current_dir(&spec.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        for k in &spec.env_remove {
            cmd.env_remove(k);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = crate::hide_console(&mut cmd).spawn().map_err(|e| AdapterError::provider(&format!("no se pudo lanzar {}: {e}", spec.program.display())))?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or_else(|| AdapterError::new(crate::orch::adapter::ErrorCode::Internal, "el proceso no expuso stdout"))?;
        let stderr_pipe = child.stderr.take();

        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            while let Some(line) = read_bounded_line(&mut r) {
                if tx.send(Some(line)).is_err() {
                    return;
                }
            }
            let _ = tx.send(None);
        });

        let stderr = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut pipe) = stderr_pipe {
            let sink = Arc::clone(&stderr);
            thread::spawn(move || {
                let mut chunk = [0u8; 1024];
                while let Ok(n) = pipe.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    let mut b = sink.lock().unwrap_or_else(|e| e.into_inner());
                    b.extend_from_slice(&chunk[..n]);
                    // Solo se conserva la cola.
                    if b.len() > STDERR_TAIL_BYTES {
                        let cut = b.len() - STDERR_TAIL_BYTES;
                        b.drain(..cut);
                    }
                }
            });
        }
        Ok(Arc::new(ChildProcess { child: Mutex::new(child), stdin: Mutex::new(stdin), rx: Mutex::new(rx), stderr }))
    }
}
