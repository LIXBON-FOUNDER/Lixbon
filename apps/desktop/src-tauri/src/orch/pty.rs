//! Terminal de cada agente. A diferencia del panel de terminal, la salida se
//! guarda: el agente arranca antes de que nadie mire su pestaña y la vista la
//! reproduce al abrirla.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

const BUFFER_CAP: usize = 512 * 1024;

pub struct AgentTerm {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pub buffer: Arc<Mutex<Vec<u8>>>,
}

impl AgentTerm {
    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        self.writer.write_all(data).map_err(|e| e.to_string())?;
        self.writer.flush().map_err(|e| e.to_string())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

pub struct Launch<'a> {
    pub task: &'a str,
    pub cwd: &'a str,
    pub script_dir: &'a Path,
    pub command: String,
    pub env: Vec<(String, String)>,
    /// Para agentes sin argumento de prompt: se escribe cuando la TUI se calla.
    pub inject: Option<String>,
}

/// El comando va en un script y no como argumento: portable-pty escapa las
/// comillas al estilo C y cmd.exe no las entiende, con lo que el prompt llegaba roto.
fn write_script(dir: &Path, command: &str) -> Result<(String, Vec<String>), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let path = dir.join("launch.cmd");
        std::fs::write(&path, format!("@echo off\r\n{command}\r\n")).map_err(|e| e.to_string())?;
        Ok(("cmd.exe".into(), vec!["/C".into(), path.to_string_lossy().into_owned()]))
    }
    #[cfg(not(windows))]
    {
        let path = dir.join("launch.sh");
        std::fs::write(&path, format!("{command}\n")).map_err(|e| e.to_string())?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "sh".into());
        Ok((shell, vec!["-l".into(), path.to_string_lossy().into_owned()]))
    }
}

pub fn spawn(app: &AppHandle, l: Launch, on_exit: impl FnOnce() + Send + 'static) -> Result<AgentTerm, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: 32, cols: 120, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let (program, args) = write_script(l.script_dir, &l.command)?;
    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    cmd.cwd(l.cwd);
    for (k, v) in &l.env {
        cmd.env(k, v);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| format!("No se pudo lanzar el agente: {e}"))?;
    let killer = child.clone_killer();
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let last_output = Arc::new(AtomicU64::new(0));
    let started = Instant::now();

    let out_event = format!("orch:term:{}", l.task);
    let exit_event = format!("orch:term-exit:{}", l.task);
    let (app_r, buf_r, last_r) = (app.clone(), buffer.clone(), last_output.clone());
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    last_r.store(started.elapsed().as_millis() as u64 + 1, Ordering::Relaxed);
                    if let Ok(mut b) = buf_r.lock() {
                        b.extend_from_slice(&chunk[..n]);
                        if b.len() > BUFFER_CAP * 2 {
                            let cut = b.len() - BUFFER_CAP;
                            b.drain(0..cut);
                        }
                    }
                    carry.extend_from_slice(&chunk[..n]);
                    // Un carácter multibyte puede quedar partido entre dos lecturas.
                    let valid = match std::str::from_utf8(&carry) {
                        Ok(_) => carry.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => carry.len(),
                    };
                    let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                    carry.drain(0..valid);
                    if !text.is_empty() {
                        let _ = app_r.emit(&out_event, text);
                    }
                }
            }
        }
    });

    // Con ConPTY el lector no recibe EOF al morir el proceso (el master sigue
    // abierto): el fin se detecta esperando al hijo.
    let app_w = app.clone();
    thread::spawn(move || {
        let _ = child.wait();
        thread::sleep(Duration::from_millis(300));
        let _ = app_w.emit(&exit_event, ());
        on_exit();
    });

    let mut term = AgentTerm { master: pair.master, writer, killer, buffer };
    if let Some(prompt) = l.inject {
        let mut w = term.writer_clone()?;
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(90);
            while Instant::now() < deadline {
                thread::sleep(Duration::from_millis(250));
                let last = last_output.load(Ordering::Relaxed);
                let now = started.elapsed().as_millis() as u64;
                if last > 0 && now.saturating_sub(last) > 2000 {
                    break;
                }
            }
            let _ = w.write_all(prompt.as_bytes());
            let _ = w.flush();
            thread::sleep(Duration::from_millis(150));
            let _ = w.write_all(b"\r");
            let _ = w.flush();
        });
    }
    Ok(term)
}

impl AgentTerm {
    fn writer_clone(&mut self) -> Result<Box<dyn Write + Send>, String> {
        // portable-pty entrega un único writer: el hilo de inyección lo comparte.
        let shared = Arc::new(Mutex::new(std::mem::replace(&mut self.writer, Box::new(std::io::sink()))));
        self.writer = Box::new(SharedWriter(shared.clone()));
        Ok(Box::new(SharedWriter(shared)))
    }
}

struct SharedWriter(Arc<Mutex<Box<dyn Write + Send>>>);

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().map_err(|_| std::io::Error::other("pty"))?.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.0.lock().map_err(|_| std::io::Error::other("pty"))?.flush()
    }
}
