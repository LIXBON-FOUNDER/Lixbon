//! Terminal de cada agente. A diferencia del panel de terminal, la salida se
//! guarda: el agente arranca antes de que nadie mire su pestaña y la vista la
//! reproduce al abrirla.

use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::hide_console;

const BUFFER_CAP: usize = 512 * 1024;
/// Ventana en la que se contestan los diálogos de arranque del agente.
const STARTUP: Duration = Duration::from_secs(180);

type Shared = Arc<Mutex<Box<dyn Write + Send>>>;

pub struct AgentTerm {
    /// Sin master: el agente corre sin terminal (salida canalizada).
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Shared,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pub buffer: Arc<Mutex<Vec<u8>>>,
}

fn write_to(w: &Shared, data: &[u8]) -> Result<(), String> {
    let mut w = w.lock().map_err(|_| "Estado interno corrupto".to_string())?;
    w.write_all(data).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

impl AgentTerm {
    pub fn write(&mut self, data: &[u8]) -> Result<(), String> {
        write_to(&self.writer, data)
    }

    /// Escribe una instrucción en la TUI y la envía. El Enter va aparte: si
    /// llega pegado al texto, las TUI lo toman como parte del pegado.
    pub fn type_prompt(&self, text: &str) {
        let w = self.writer.clone();
        let text = text.replace(['\r', '\n'], " ");
        thread::spawn(move || {
            let _ = write_to(&w, text.as_bytes());
            thread::sleep(Duration::from_millis(250));
            let _ = write_to(&w, b"\r");
        });
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match &self.master {
            Some(m) => m.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    pub fn kill(&mut self) {
        let _ = self.killer.kill();
    }
}

pub struct Launch<'a> {
    pub cwd: &'a str,
    pub script_dir: &'a Path,
    pub command: String,
    pub env: Vec<(String, String)>,
    pub inject: Option<String>,
    pub piped: bool,
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

/// Texto visible sin secuencias de escape, para reconocer los diálogos.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    for d in chars.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    for d in chars.by_ref() {
                        if d == '\x07' {
                            break;
                        }
                    }
                }
                _ => {
                    chars.next();
                }
            }
        } else if !c.is_control() || c == '\n' {
            out.push(c);
        } else {
            out.push(' ');
        }
    }
    out
}

/// Mata el árbol entero: bajo `cmd /C` quedaría vivo el proceso del agente.
#[derive(Debug)]
struct TreeKiller(u32);

impl ChildKiller for TreeKiller {
    fn kill(&mut self) -> std::io::Result<()> {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = std::process::Command::new("taskkill");
            c.args(["/PID", &self.0.to_string(), "/T", "/F"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = std::process::Command::new("kill");
            c.args(["-9", &self.0.to_string()]);
            c
        };
        hide_console(cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())).status().map(|_| ())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(TreeKiller(self.0))
    }
}

fn spawn_piped(
    l: Launch,
    on_output: impl Fn(String) + Send + Sync + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<AgentTerm, String> {
    use std::process::{Command, Stdio};
    let (program, args) = write_script(l.script_dir, &l.command)?;
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(l.cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in &l.env {
        cmd.env(k, v);
    }
    let mut child = hide_console(&mut cmd).spawn().map_err(|e| format!("No se pudo lanzar el agente: {e}"))?;
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let on_output = Arc::new(on_output);
    let pump = |mut pipe: Box<dyn Read + Send>, buf: Arc<Mutex<Vec<u8>>>, out: Arc<dyn Fn(String) + Send + Sync>| {
        thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                // La salida canalizada usa \n a secas: la terminal necesita \r\n.
                let text = String::from_utf8_lossy(&chunk[..n]).replace("\r\n", "\n").replace('\n', "\r\n");
                if let Ok(mut b) = buf.lock() {
                    b.extend_from_slice(text.as_bytes());
                }
                out(text);
            }
        })
    };
    let a = pump(Box::new(child.stdout.take().ok_or("sin stdout")?), buffer.clone(), on_output.clone());
    let b = pump(Box::new(child.stderr.take().ok_or("sin stderr")?), buffer.clone(), on_output);
    let pid = child.id();
    thread::spawn(move || {
        let _ = child.wait();
        let _ = a.join();
        let _ = b.join();
        on_exit();
    });
    let sink: Box<dyn Write + Send> = Box::new(std::io::sink());
    Ok(AgentTerm { master: None, writer: Arc::new(Mutex::new(sink)), killer: Box::new(TreeKiller(pid)), buffer })
}

/// `on_output` recibe cada trozo de salida; `on_exit`, el fin del proceso.
pub fn spawn(
    l: Launch,
    on_output: impl Fn(String) + Send + Sync + 'static,
    on_exit: impl FnOnce() + Send + 'static,
) -> Result<AgentTerm, String> {
    if l.piped {
        return spawn_piped(l, on_output, on_exit);
    }
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
    // El proceso del PTY es `cmd /C launch.cmd`: matar solo ese deja vivo al
    // agente, que además retiene su worktree y no deja borrarlo.
    let killer: Box<dyn ChildKiller + Send + Sync> = match child.process_id() {
        Some(pid) => Box::new(TreeKiller(pid)),
        None => child.clone_killer(),
    };
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: Shared = Arc::new(Mutex::new(pair.master.take_writer().map_err(|e| e.to_string())?));
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let started = Instant::now();
    let last_output = Arc::new(Mutex::new(None::<Instant>));

    let (buf_r, writer_r, last_r) = (buffer.clone(), writer.clone(), last_output.clone());
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new();
        let mut screen = String::new();
        // Cuándo se contestó por última vez: si el diálogo sigue ahí, se reintenta.
        let mut last_answer: Option<Instant> = None;
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut l) = last_r.lock() {
                        *l = Some(Instant::now());
                    }
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
                    if text.is_empty() {
                        continue;
                    }
                    if started.elapsed() < STARTUP {
                        screen.push_str(&plain(&text));
                        if screen.len() > 4000 {
                            let mut cut = screen.len() - 3000;
                            while !screen.is_char_boundary(cut) {
                                cut += 1;
                            }
                            screen.drain(..cut);
                        }
                        let settled = last_answer.is_none_or(|t| t.elapsed() > Duration::from_secs(4));
                        if let Some(keys) = super::agents::auto_answer(&screen).filter(|_| settled) {
                            last_answer = Some(Instant::now());
                            screen.clear();
                            let w = writer_r.clone();
                            thread::spawn(move || {
                                // La TUI dibuja el diálogo antes de aceptar teclas.
                                thread::sleep(Duration::from_millis(1200));
                                for k in keys {
                                    let _ = write_to(&w, k.as_bytes());
                                    thread::sleep(Duration::from_millis(350));
                                }
                            });
                        }
                    }
                    on_output(text);
                }
            }
        }
    });

    // Con ConPTY el lector no recibe EOF al morir el proceso (el master sigue
    // abierto): el fin se detecta esperando al hijo.
    thread::spawn(move || {
        let _ = child.wait();
        thread::sleep(Duration::from_millis(300));
        on_exit();
    });

    let term = AgentTerm { master: Some(pair.master), writer, killer, buffer };
    if let Some(prompt) = l.inject {
        let w = term.writer.clone();
        thread::spawn(move || {
            // La TUI está lista cuando lleva un rato sin pintar nada.
            let deadline = Instant::now() + Duration::from_secs(90);
            while Instant::now() < deadline {
                thread::sleep(Duration::from_millis(300));
                let quiet = last_output.lock().ok().and_then(|l| *l).is_some_and(|t| t.elapsed() > Duration::from_millis(2500));
                if quiet && started.elapsed() > Duration::from_secs(4) {
                    break;
                }
            }
            let _ = write_to(&w, prompt.replace(['\r', '\n'], " ").as_bytes());
            thread::sleep(Duration::from_millis(400));
            let _ = write_to(&w, b"\r");
        });
    }
    Ok(term)
}

#[cfg(test)]
mod tests {
    use super::plain;

    #[test]
    fn quita_escapes() {
        assert_eq!(plain("\x1b[1;32mDo you trust\x1b[0m the files?"), "Do you trust the files?");
        assert_eq!(plain("\x1b]0;titulo\x07hola"), "hola");
    }
}

#[cfg(test)]
mod real {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// Lanza un agente de verdad en una carpeta nueva (sin confiar) y espera a
    /// que complete un encargo mínimo sin intervención. Gasta tokens: a mano.
    fn autonomo(agent: &str, model: Option<&str>) {
        let home = std::path::PathBuf::from(std::env::var("USERPROFILE").unwrap());
        let dir = home.join("AppData").join("Local").join("Temp").join(format!("lxo-real-{agent}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::process::Command::new("git").arg("init").arg("-q").current_dir(&dir).status();
        let prompt = "Crea un archivo llamado hola.txt que contenga la palabra hola. No hagas nada mas.";
        let l = crate::orch::agents::launch(agent, model, None, prompt, false).unwrap();
        let screen = Arc::new(Mutex::new(String::new()));
        let sc = screen.clone();
        let mut term = super::spawn(
            super::Launch { cwd: &dir.to_string_lossy(), script_dir: &dir.join(".lixbon"), command: l.command, env: l.env, inject: l.inject, piped: l.piped },
            move |t| sc.lock().unwrap().push_str(&t),
            || {},
        )
        .unwrap();
        let start = Instant::now();
        let ok = loop {
            if dir.join("hola.txt").exists() { break true; }
            if start.elapsed() > Duration::from_secs(300) { break false; }
            std::thread::sleep(Duration::from_millis(500));
        };
        term.kill();
        let tail = super::plain(&screen.lock().unwrap());
        let tail: String = tail.chars().rev().take(1500).collect::<String>().chars().rev().collect();
        println!("--- {agent}: {} en {:?}\n{tail}", if ok { "OK" } else { "SIN ARCHIVO" }, start.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
        assert!(ok);
    }

    #[test]
    #[ignore]
    fn claude_autonomo() { autonomo("claude", Some("haiku")); }
}

