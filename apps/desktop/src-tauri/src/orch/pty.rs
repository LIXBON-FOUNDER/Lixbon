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
/// Ancho mínimo de la PTY de cada agente. La entrega no puede depender del ancho
/// del panel: si la vista es más estrecha se reduce la vista, no la PTY.
pub const MIN_COLS: u16 = 200;

/// Columnas reales de la PTY para un ancho pedido por la UI: nunca menos de MIN_COLS.
pub fn clamp_cols(cols: u16) -> u16 {
    cols.max(MIN_COLS)
}
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

    /// La UI pide `cols`; el host aplica como mínimo MIN_COLS (orch_term_resize).
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        match &self.master {
            Some(m) => m.resize(PtySize { rows: rows.max(1), cols: clamp_cols(cols), pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string()),
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

/// Largo de un carácter incompleto al final de `b` (0 si no hay): un byte inicial
/// multibyte seguido de menos continuaciones de las que pide.
fn incomplete_tail(b: &[u8]) -> usize {
    for back in 1..=b.len().min(3) {
        let byte = b[b.len() - back];
        if byte & 0xC0 == 0x80 {
            continue; // continuación: sigue buscando el inicial
        }
        let need = match byte {
            0xC2..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF4 => 4,
            _ => return 0,
        };
        let tail = &b[b.len() - back..];
        // Solo se guarda si de verdad puede completarse (prefijo válido).
        let prefix_ok = matches!(std::str::from_utf8(tail), Err(e) if e.error_len().is_none());
        return if back < need && prefix_ok { back } else { 0 };
    }
    0
}

/// Pasa bytes de la PTY a texto sin partir caracteres multibyte entre lecturas:
/// guarda los bytes incompletos del final y los pega al siguiente trozo. Los
/// bytes realmente inválidos salen como U+FFFD; `finish` vacía el resto con lossy.
#[derive(Default)]
pub(crate) struct Utf8Carry(Vec<u8>);

impl Utf8Carry {
    pub(crate) fn push(&mut self, bytes: &[u8]) -> String {
        self.0.extend_from_slice(bytes);
        let keep = incomplete_tail(&self.0);
        let cut = self.0.len() - keep;
        let text = String::from_utf8_lossy(&self.0[..cut]).into_owned();
        self.0.drain(..cut);
        text
    }

    pub(crate) fn finish(&mut self) -> String {
        let text = String::from_utf8_lossy(&self.0).into_owned();
        self.0.clear();
        text
    }
}

/// Texto visible sin secuencias de escape, para reconocer los diálogos.
pub(crate) fn plain(text: &str) -> String {
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
            let mut carry = Utf8Carry::default();
            let emit = |part: String| {
                if part.is_empty() {
                    return;
                }
                // La salida canalizada usa \n a secas: la terminal necesita \r\n.
                let text = part.replace("\r\n", "\n").replace('\n', "\r\n");
                if let Ok(mut b) = buf.lock() {
                    b.extend_from_slice(text.as_bytes());
                }
                out(text);
            };
            while let Ok(n) = pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                // Un carácter multibyte puede quedar partido entre dos lecturas: sin
                // esto, el informe de stream-json llegaba con U+FFFD en vez de la letra.
                emit(carry.push(&chunk[..n]));
            }
            emit(carry.finish());
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
    spawn_pty(l, PtyOpts { auto_answer: true, cols: MIN_COLS, rows: 32 }, on_output, move |_| on_exit())
}

/// Opciones de la PTY. Las hijas contestan solas el diálogo de confianza; una
/// terminal que maneja la persona (pestaña de Codex), no.
pub struct PtyOpts {
    pub auto_answer: bool,
    pub cols: u16,
    pub rows: u16,
}

/// PTY para una persona: sin respuestas automáticas, con el tamaño pedido (como
/// mínimo MIN_COLS) y el código de salida del proceso al terminar.
pub fn spawn_user(
    l: Launch,
    cols: u16,
    rows: u16,
    on_output: impl Fn(String) + Send + Sync + 'static,
    on_exit: impl FnOnce(Option<u32>) + Send + 'static,
) -> Result<AgentTerm, String> {
    spawn_pty(l, PtyOpts { auto_answer: false, cols: clamp_cols(cols), rows: rows.max(1) }, on_output, on_exit)
}

fn spawn_pty(
    l: Launch,
    opts: PtyOpts,
    on_output: impl Fn(String) + Send + Sync + 'static,
    on_exit: impl FnOnce(Option<u32>) + Send + 'static,
) -> Result<AgentTerm, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: opts.rows, cols: clamp_cols(opts.cols), pixel_width: 0, pixel_height: 0 })
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
        let mut carry = Utf8Carry::default();
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
                    // Un carácter multibyte puede quedar partido entre dos lecturas.
                    let text = carry.push(&chunk[..n]);
                    if text.is_empty() {
                        continue;
                    }
                    if opts.auto_answer && started.elapsed() < STARTUP {
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
        // Al cerrar, lo que quede incompleto sale con lossy.
        let rest = carry.finish();
        if !rest.is_empty() {
            on_output(rest);
        }
    });

    // Con ConPTY el lector no recibe EOF al morir el proceso (el master sigue
    // abierto): el fin se detecta esperando al hijo.
    thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code());
        thread::sleep(Duration::from_millis(300));
        on_exit(code);
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
mod utf8_tests {
    use super::Utf8Carry;

    const MUESTRAS: [&str; 4] = [
        "Revisión: año, acción, pingüino ÁÉÍÓÚñ",
        "┌─┬─┐│ ╔═╗ ║x║ └─┴─┘ ▶ ● ✓",
        "listo 🚀 ok 👍🏽 familia 👨‍👩‍👧 bandera 🇨🇴",
        "\x1b[1;32mverde ✓\x1b[0m tilde é en ANSI \x1b[38;5;208m🔥\x1b[0m",
    ];

    fn por_trozos(bytes: &[u8], cortes: &[usize]) -> String {
        let mut c = Utf8Carry::default();
        let mut out = String::new();
        let mut prev = 0;
        for &k in cortes.iter().chain(std::iter::once(&bytes.len())) {
            let part = c.push(&bytes[prev..k]);
            assert!(!part.contains('\u{FFFD}'), "U+FFFD en el corte {k}");
            out.push_str(&part);
            prev = k;
        }
        out + &c.finish()
    }

    #[test]
    fn cortes_en_cada_posicion() {
        for m in MUESTRAS {
            let b = m.as_bytes();
            for i in 0..=b.len() {
                assert_eq!(por_trozos(b, &[i]), m, "corte en {i}");
            }
        }
    }

    #[test]
    fn dos_cortes_y_byte_a_byte() {
        for m in MUESTRAS {
            let b = m.as_bytes();
            for i in 0..=b.len() {
                for j in i..=b.len() {
                    assert_eq!(por_trozos(b, &[i, j]), m, "cortes {i},{j}");
                }
            }
            let todos: Vec<usize> = (1..b.len()).collect();
            assert_eq!(por_trozos(b, &todos), m);
        }
    }

    #[test]
    fn invalido_antes_de_un_corte_no_estropea_el_siguiente() {
        let mut c = Utf8Carry::default();
        let emoji = "🚀".as_bytes();
        let mut a = vec![b'x', 0xFF];
        a.extend_from_slice(&emoji[..2]);
        assert_eq!(c.push(&a), "x\u{FFFD}");
        assert_eq!(c.push(&emoji[2..]), "🚀");
        assert_eq!(c.finish(), "");
    }

    #[test]
    fn al_cerrar_lo_incompleto_sale_con_lossy() {
        let mut c = Utf8Carry::default();
        assert_eq!(c.push(&"añ".as_bytes()[..2]), "a");
        assert_eq!(c.push(&"─".as_bytes()[..0]), "");
        assert_eq!(c.finish(), "\u{FFFD}");
        assert_eq!(c.finish(), "");
    }
}

#[cfg(test)]
mod tests {
    use super::{clamp_cols, incomplete_tail, plain, MIN_COLS};

    #[test]
    fn la_pty_nunca_baja_del_minimo() {
        for pedido in [1u16, 40, 60, 76, 120, 199] {
            assert_eq!(clamp_cols(pedido), MIN_COLS, "{pedido}");
        }
        assert_eq!(clamp_cols(200), 200);
        assert_eq!(clamp_cols(260), 260);
    }

    #[test]
    fn utf8_partido_entre_lecturas() {
        let s = "ñ🚀".as_bytes();
        assert_eq!(incomplete_tail(&s[..1]), 1);
        assert_eq!(incomplete_tail(&s[..3]), 1);
        assert_eq!(incomplete_tail(&s[..5]), 3);
        assert_eq!(incomplete_tail(s), 0);
        assert_eq!(incomplete_tail(&[b'a', 0xFF]), 0);
    }

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
        let l = crate::orch::agents::launch(agent, model, None, prompt, crate::orch::agents::Profile::DelegarConRevision, None).unwrap();
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


/// ConPTY de verdad (portable-pty en Windows): la UI pide 40, 60 y 76 columnas,
/// el host deja la PTY en MIN_COLS y el bloque llega con el hash correcto. No
/// gasta tokens: imprime un bloque ya hecho con `type`.
#[cfg(all(test, windows))]
mod ancho_real {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use base64::Engine;

    use super::super::delivery::{scan_markers, sha256_hex, Expect, Found};

    #[test]
    fn entrega_por_conpty_real_sin_resize_y_a_40_60_76_columnas() {
        let nonce = "5f1c2a9be04d7713a0c4e8f2b6d9c1e3";
        // 0: sin ningún resize, el bloque sale con la PTY tal como se abrió.
        for pedido in [0u16, 40, 60, 76] {
            let dir = std::env::temp_dir().join(format!("lxo-conpty-{pedido}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let task = format!("t{pedido}");
            let json = serde_json::json!({ "schema": 1, "task": task, "attempt": 1, "status": "done",
                "summary": format!("ancho {pedido}"), "files": [], "report": "ñ ".repeat(1500), "nonce": nonce }).to_string();
            let b64 = base64::engine::general_purpose::STANDARD.encode(json.as_bytes());
            // Líneas de 150 con sangría: más anchas que lo que pide la UI.
            let lines: Vec<String> = b64.as_bytes().chunks(150).map(|c| format!("    {}", std::str::from_utf8(c).unwrap())).collect();
            let block = format!("<<<LXO-REPORT v1 nonce={nonce} sha256={}>>>\r\n{}\r\n<<<LXO-REPORT-END nonce={nonce}>>>\r\n",
                sha256_hex(json.as_bytes()), lines.join("\r\n"));
            std::fs::write(dir.join("bloque.txt"), block).unwrap();
            let screen = Arc::new(Mutex::new(String::new()));
            let done = Arc::new(AtomicBool::new(false));
            let (sc, d) = (screen.clone(), done.clone());
            let term = super::spawn(
                super::Launch {
                    cwd: &dir.to_string_lossy(),
                    script_dir: &dir.join("s"),
                    command: if pedido == 0 { "type bloque.txt & ping -n 2 127.0.0.1 >nul".into() } else { "ping -n 3 127.0.0.1 >nul & type bloque.txt & ping -n 2 127.0.0.1 >nul".into() },
                    env: vec![],
                    inject: None,
                    piped: false,
                },
                move |t| sc.lock().unwrap().push_str(&t),
                move || d.store(true, Ordering::SeqCst),
            )
            .unwrap();
            // La UI pide menos que el mínimo antes de que salga el bloque.
            if pedido > 0 {
                term.resize(pedido, 30).unwrap();
            }
            let start = Instant::now();
            while !done.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(40) {
                std::thread::sleep(Duration::from_millis(200));
            }
            let raw = screen.lock().unwrap().clone();
            let e = Expect { task: task.clone(), attempt: 1, nonce: nonce.into() };
            match scan_markers(&raw, &e, &[]) {
                Found::Valid(r) => {
                    assert_eq!(r.sha256, sha256_hex(json.as_bytes()), "{pedido}");
                    assert_eq!(r.summary, format!("ancho {pedido}"));
                }
                other => panic!("{pedido} columnas: {other:?}\n{}", super::plain(&raw)),
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}
