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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::orch::adapter::redact::safe_text;
use crate::orch::adapter::{AdapterError, RunOutcome};

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

/// Cómo quedó el cierre de un proceso (LXO-242). `Unproven`: no se pudo PROBAR que el proceso y sus descendientes terminaron (identidad ilegible, tabla
/// de procesos no fiable, un kill que falló). Nunca es un éxito: quien cierra debe decirlo y no declarar detenido lo que puede seguir vivo. El árbol se
/// conserva para reintentar el cierre al soltar el proceso (`Drop`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[must_use = "un cierre sin probar tiene que decirse: no se declara detenido un proceso que puede seguir vivo"]
pub enum Closure {
    Proven,
    Unproven,
}

/// El desenlace de una ejecución tras cerrar su proceso. Una ejecución `Cancelled` o `Interrupted` afirma que el proceso ya no está: si el cierre no se
/// probó, eso es mentira y pasa a un fallo que lo dice (el Core no declara detenido a un Attempt cuyo proceso no pudo cerrar). Un `Completed` o un
/// `Failed` ya dicen lo que el proveedor hizo, no que el proceso terminó: se conservan y el cierre sin probar queda en el log.
pub fn outcome_after_close(outcome: RunOutcome, closure: Closure) -> RunOutcome {
    match (closure, outcome) {
        (Closure::Unproven, RunOutcome::Cancelled | RunOutcome::Interrupted) => RunOutcome::Failed(AdapterError::provider(
            "no se pudo probar que el proceso del proveedor y sus descendientes terminaron: puede seguir vivo, así que no se declara detenido",
        )),
        (Closure::Unproven, kept) => {
            eprintln!("[core] el cierre del proceso de un proveedor no se pudo probar: puede seguir vivo");
            kept
        }
        (Closure::Proven, kept) => kept,
    }
}

/// Un proceso vivo. Todos los métodos son `&self` y thread-safe: `events` lee mientras `answer`/`interrupt` escriben.
pub trait Process: Send + Sync {
    fn send(&self, line: &str) -> Result<(), AdapterError>;
    fn recv(&self, timeout: Duration) -> Recv;
    /// Cierra stdin: la CLI termina sola al acabar el turno.
    fn close_input(&self);
    /// Mata el proceso y sus hijos y dice si el cierre quedó PROBADO ([`Closure`]).
    fn kill(&self) -> Closure;
    /// Cola de stderr, ya redactada: es lo que acompaña a un fallo como diagnóstico.
    fn stderr_tail(&self) -> String;
    /// El Attempt dueño del proceso (`<task>-a<n>`), para que un cierre sin probar quede en la custodia a su nombre (LXO-242). No-op por defecto.
    fn set_owner(&self, _owner: &str) {}
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

/// La familia de procesos de una ejecución: la raíz, su árbol con identidad y (Windows) su Job, y si ya se cerró. Es lo que el supervisor conserva
/// cuando un cierre no se pudo probar (`supervisor.rs`): vive aparte del `ChildProcess` para poder sobrevivirle.
pub(super) struct Family {
    child: Mutex<Child>,
    /// El árbol de procesos de la raíz, con su identidad y (Windows) su Job: es con lo que se cierra todo el árbol sin tocar
    /// nunca a un proceso ajeno (LXO-242).
    tree: Mutex<crate::proctable::Tree>,
    /// El árbol se cerró y la raíz se reapeó: no hay nada más que cerrar.
    closed: AtomicBool,
}

/// SOLO pruebas: el siguiente cierre de ESTE hilo no se puede probar (no mata nada), para ejercitar la custodia sin esperar a un fallo real.
#[cfg(test)]
thread_local! {
    pub(super) static BREAK_CLOSE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// SOLO pruebas: lanza un proceso real de larga duración y deja su cierre SIN PROBAR, en la custodia del supervisor y a nombre de `owner`. Devuelve el
/// asa (soltarla no lo cierra: la familia ya está en custodia) para que una prueba de otro módulo vea los efectos.
#[cfg(test)]
pub(crate) fn lanza_en_custodia(owner: &str) -> Arc<dyn Process> {
    let spec = if cfg!(windows) {
        LaunchSpec { program: PathBuf::from("ping"), args: vec!["-n".into(), "139".into(), "127.0.0.1".into()], cwd: std::env::temp_dir(), env: vec![], env_remove: vec![] }
    } else {
        LaunchSpec { program: PathBuf::from("sleep"), args: vec!["139".into()], cwd: std::env::temp_dir(), env: vec![], env_remove: vec![] }
    };
    let p = spawn_child(&spec).expect("lanzamiento");
    p.set_owner(owner);
    BREAK_CLOSE.with(|b| b.set(true));
    let closure = p.kill();
    BREAK_CLOSE.with(|b| b.set(false));
    assert_eq!(closure, Closure::Unproven);
    Arc::new(p)
}

pub struct ChildProcess {
    family: Arc<Family>,
    /// El Attempt dueño de este proceso (`<task>-a<n>`), si el adapter lo dijo: lo que permite decir «esa Task tiene un proceso sin cerrar».
    owner: Mutex<Option<String>>,
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

    fn kill(&self) -> Closure {
        self.close_input();
        if self.family.close() {
            Closure::Proven
        } else {
            // Sin prueba, el supervisor conserva la familia (no se pierde ni se mata a ciegas) y la reintentará.
            super::supervisor::keep(self.owner(), Arc::clone(&self.family));
            Closure::Unproven
        }
    }

    fn set_owner(&self, owner: &str) {
        *self.owner.lock().unwrap_or_else(|e| e.into_inner()) = Some(owner.to_string());
    }

    fn stderr_tail(&self) -> String {
        let b = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
        safe_text(&String::from_utf8_lossy(&b), STDERR_TAIL_BYTES)
    }
}

impl ChildProcess {
    fn owner(&self) -> Option<String> {
        self.owner.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl Family {
    /// Cierra TODO el árbol de la raíz comprobando la identidad de cada proceso (`proctable::kill_tree`) y, solo si se
    /// comprobó su muerte, reapea la raíz. `true` si no queda nada. Si no se puede probar (identidad ilegible, tabla de
    /// procesos no fiable) NO se hace un kill ciego del resto del árbol: el árbol y la raíz sin reapear se conservan para
    /// reintentarlo (en Unix la raíz sin reapear ancla su pid). A la raíz, que este `Child` posee, sí se le ordena morir:
    /// su handle (o su zombi) impide que ese pid sea de otro.
    pub(super) fn close(&self) -> bool {
        #[cfg(test)]
        if BREAK_CLOSE.with(|b| b.get()) {
            return false;
        }
        if self.closed.load(Ordering::Acquire) {
            return true;
        }
        let mut tree = self.tree.lock().unwrap_or_else(|e| e.into_inner());
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        // Con el candado del árbol: una segunda llamada concurrente espera y ve `closed`.
        if self.closed.load(Ordering::Acquire) {
            return true;
        }
        match crate::proctable::kill_tree(&mut tree, &mut crate::proctable::RealOs::default()) {
            Ok(()) => {
                let _ = child.wait();
                self.closed.store(true, Ordering::Release);
                true
            }
            Err(_) => {
                let _ = child.kill();
                false
            }
        }
    }
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        // Un adapter que suelta el proceso sin cerrarlo no deja una CLI huérfana ni sus descendientes. Si el cierre no se puede probar, el supervisor
        // CONSERVA la familia (antes se mataba la raíz a ciegas y se reapeaba, perdiendo el ancla de su pid): la reintentará `reap`.
        if !self.family.close() {
            super::supervisor::keep(self.owner(), Arc::clone(&self.family));
        }
    }
}

pub struct RealLauncher;

impl Launcher for RealLauncher {
    fn launch(&self, spec: &LaunchSpec) -> Result<Arc<dyn Process>, AdapterError> {
        Ok(Arc::new(spawn_child(spec)?))
    }
}

/// Mata la raíz recién lanzada que no llegó a usarse y la reapea. La raíz es nuestra: su handle (o su zombi) ancla su pid.
fn abort_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Lanza el proceso del proveedor bajo la custodia de `proctable` (LXO-242). Windows: la raíz nace SUSPENDIDA, se mete en su
/// Job antes de ejecutar nada y solo se reanuda si quedó dentro. Unix: la raíz lidera su PROPIA sesión (`setsid`).
fn spawn_child(spec: &LaunchSpec) -> Result<ChildProcess, AdapterError> {
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
    crate::hide_console(&mut cmd);
    // Windows: la raíz nace suspendida (los flags sustituyen a los de `hide_console`, así que se repite CREATE_NO_WINDOW).
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }
    // Unix: la raíz lidera su PROPIA sesión (pgid == sid == pid): el número de su grupo es suyo y `proctable` encuentra a
    // los descendientes que se reparenten a init.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: el callback solo llama a `setsid` entre `fork` y `exec`; no toca el estado de Rust ni reserva memoria.
        unsafe {
            cmd.pre_exec(|| if libc::setsid() == -1 { Err(std::io::Error::last_os_error()) } else { Ok(()) });
        }
    }
    let mut child = cmd.spawn().map_err(|e| AdapterError::provider(&format!("no se pudo lanzar {}: {e}", spec.program.display())))?;
    let pid = child.id();
    #[cfg(windows)]
    let tree = {
        let tree = crate::proctable::Tree::capture_suspended(&mut crate::proctable::RealOs::default(), pid);
        // Solo se reanuda con el Job adjunto y la raíz aún suspendida; si no, se mata sin haber ejecutado nada.
        if !tree.has_complete_job() {
            abort_child(&mut child);
            return Err(AdapterError::provider("no se pudo meter el proceso suspendido en un Job Object; no se lanzó"));
        }
        if !resume_root(pid) {
            abort_child(&mut child);
            return Err(AdapterError::provider("no se pudo reanudar el proceso suspendido; no se lanzó"));
        }
        tree
    };
    #[cfg(not(windows))]
    let tree = {
        let mut tree = crate::proctable::Tree::capture(&mut crate::proctable::RealOs::default(), pid);
        // Nadie reapea a la raíz hasta `close_tree`: su pid (y el número de su grupo) es suyo mientras tanto.
        tree.pin_root();
        tree
    };
    let stdin = child.stdin.take();
    let Some(stdout) = child.stdout.take() else {
        abort_child(&mut child);
        return Err(AdapterError::new(crate::orch::adapter::ErrorCode::Internal, "el proceso no expuso stdout"));
    };
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
    let family = Arc::new(Family { child: Mutex::new(child), tree: Mutex::new(tree), closed: AtomicBool::new(false) });
    Ok(ChildProcess { family, owner: Mutex::new(None), stdin: Mutex::new(stdin), rx: Mutex::new(rx), stderr })
}

/// SOLO pruebas: la reanudación de la raíz suspendida falla (camino de aborto del lanzamiento, Windows).
#[cfg(all(test, windows))]
thread_local! {
    static FAIL_RESUME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Windows: reanuda la raíz suspendida (`false` si no se pudo, sin haber reanudado nada).
#[cfg(windows)]
fn resume_root(pid: u32) -> bool {
    #[cfg(test)]
    if FAIL_RESUME.with(|f| f.get()) {
        return false;
    }
    crate::proctable::resume_suspended(pid)
}

impl ChildProcess {
    #[cfg(test)]
    fn pid(&self) -> u32 {
        self.family.child.lock().unwrap_or_else(|e| e.into_inner()).id()
    }
}

/// Procesos de verdad (LXO-242): el cierre del lanzador real termina TODO el árbol, también al nieto huérfano que el
/// recorrido por `ppid` (y `taskkill /T`) no ve, y un lanzamiento que no puede ponerse bajo el Job no llega a ejecutar nada.
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::Instant;

    fn carpeta(nombre: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!("lxo-adapter-{nombre}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn spec(program: PathBuf, args: Vec<String>) -> LaunchSpec {
        LaunchSpec { program, args, cwd: std::env::temp_dir(), env: vec![], env_remove: vec![] }
    }

    fn espera(mut cond: impl FnMut() -> bool, segundos: u64) -> bool {
        let limite = Instant::now() + Duration::from_secs(segundos);
        while Instant::now() < limite {
            if cond() {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        cond()
    }

    // --- Windows ---

    #[cfg(windows)]
    fn powershell(script: &str) -> String {
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        String::from_utf8_lossy(&crate::hide_console(&mut cmd).output().expect("powershell").stdout).into_owned()
    }

    /// Pids de los `ping.exe` de esta prueba, reconocidos por su cuenta de paquetes `marca`.
    #[cfg(windows)]
    fn pings_con(marca: &str) -> Vec<u32> {
        powershell(&format!("Get-CimInstance Win32_Process | Where-Object {{ $_.Name -eq 'PING.EXE' -and $_.CommandLine -like '*-n {marca} 127.0.0.1*' }} | ForEach-Object {{ $_.ProcessId }}"))
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect()
    }

    /// Si la prueba falla a medias, los `ping` no pueden quedarse vivos.
    #[cfg(windows)]
    struct LimpiaPings(&'static [&'static str]);

    #[cfg(windows)]
    impl Drop for LimpiaPings {
        fn drop(&mut self) {
            for m in self.0 {
                for pid in pings_con(m) {
                    powershell(&format!("Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue"));
                }
            }
        }
    }

    /// Un `.cmd` cuyo intermedio lanza un `ping` en segundo plano y sale (el `ping` queda huérfano con el `ppid` colgando) y
    /// cuya raíz sigue viva con otro `ping`. El lanzador real ejecuta un `.cmd` a través de `cmd /C`.
    #[cfg(windows)]
    fn guion_con_huerfano(dir: &Path, huerfano: &str, raiz: &str) -> PathBuf {
        let f = dir.join("agente.cmd");
        std::fs::write(&f, format!("@echo off\r\ncmd /C \"start \"\" /B ping -n {huerfano} 127.0.0.1 >nul\"\r\nping -n {raiz} 127.0.0.1 >nul\r\n")).unwrap();
        f
    }

    #[cfg(windows)]
    #[test]
    fn windows_kill_cierra_tambien_al_nieto_huerfano_con_el_job() {
        let _limpia = LimpiaPings(&["133", "134"]);
        let dir = carpeta("huerfano");
        let p = spawn_child(&spec(guion_con_huerfano(&dir, "133", "134"), vec![])).expect("lanzamiento");
        assert!(espera(|| !pings_con("133").is_empty() && !pings_con("134").is_empty(), 20), "el huérfano y el ping de la raíz arrancaron");
        let (huerfano, raiz) = (pings_con("133"), pings_con("134"));
        assert_eq!(p.kill(), Closure::Proven);
        assert!(espera(|| pings_con("133").is_empty() && pings_con("134").is_empty(), 20), "murieron el huérfano {huerfano:?} (su `ppid` cuelga de un cmd que ya salió) y el de la raíz {raiz:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn windows_soltar_el_proceso_cierra_el_arbol_entero() {
        let _limpia = LimpiaPings(&["135", "136"]);
        let dir = carpeta("drop");
        let p = spawn_child(&spec(guion_con_huerfano(&dir, "135", "136"), vec![])).expect("lanzamiento");
        assert!(espera(|| !pings_con("135").is_empty() && !pings_con("136").is_empty(), 20), "arrancaron");
        drop(p);
        assert!(espera(|| pings_con("135").is_empty() && pings_con("136").is_empty(), 20), "soltar el proceso no deja una CLI ni un huérfano vivos");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Si no se puede reanudar la raíz suspendida, el lanzamiento falla y la raíz, que no ejecutó nada, se mata: el guion no
    /// llega a lanzar ningún `ping`.
    #[cfg(windows)]
    #[test]
    fn windows_si_no_se_puede_reanudar_la_raiz_suspendida_no_se_ejecuta_nada() {
        let _limpia = LimpiaPings(&["137", "138"]);
        let dir = carpeta("no-reanuda");
        FAIL_RESUME.with(|f| f.set(true));
        let r = spawn_child(&spec(guion_con_huerfano(&dir, "137", "138"), vec![]));
        FAIL_RESUME.with(|f| f.set(false));
        let e = r.err().expect("el lanzamiento falla");
        assert!(e.to_string().contains("no se lanzó"), "{e}");
        thread::sleep(Duration::from_secs(3));
        assert!(pings_con("137").is_empty() && pings_con("138").is_empty(), "la raíz estaba suspendida y muerta: el guion nunca corrió");
        let _ = std::fs::remove_dir_all(dir);
    }

    // --- Unix (solo la CI) ---

    /// ¿Sigue vivo `pid`? Un zombi (muerto sin reapear, p. ej. huérfano reparentado a un init que no reapea) cuenta como muerto.
    #[cfg(unix)]
    fn vivo(pid: u32) -> bool {
        let mut cmd = Command::new("ps");
        cmd.args(["-o", "stat=", "-p", &pid.to_string()]);
        let out = String::from_utf8_lossy(&cmd.output().expect("ps").stdout).trim().to_string();
        !out.is_empty() && !out.starts_with('Z')
    }

    /// Un `sh` cuyo subshell lanza un `sleep` y sale (el `sleep` se reparenta a init) y cuya raíz sigue viva con otro `sleep`.
    /// El pid del huérfano se anota en un archivo.
    #[cfg(unix)]
    fn lanza_con_huerfano(dir: &Path, huerfano: &str, raiz: &str) -> (ChildProcess, PathBuf) {
        let pidfile = dir.join("huerfano.pid");
        let script = format!("( sleep {huerfano} & echo $! > '{}' ); sleep {raiz}", pidfile.display());
        let p = spawn_child(&spec(PathBuf::from("sh"), vec!["-c".into(), script])).expect("lanzamiento");
        (p, pidfile)
    }

    #[cfg(unix)]
    fn pid_del_huerfano(pidfile: &Path) -> u32 {
        assert!(espera(|| std::fs::read_to_string(pidfile).is_ok_and(|t| t.trim().parse::<u32>().is_ok()), 20), "el huérfano arrancó");
        std::fs::read_to_string(pidfile).unwrap().trim().parse().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn unix_kill_cierra_tambien_al_nieto_huerfano() {
        let dir = carpeta("huerfano");
        let (p, pidfile) = lanza_con_huerfano(&dir, "133", "134");
        let huerfano = pid_del_huerfano(&pidfile);
        assert!(vivo(huerfano) && vivo(p.pid()), "antes de cerrar viven la raíz y el huérfano");
        assert_eq!(p.kill(), Closure::Proven);
        assert!(espera(|| !vivo(huerfano), 20), "el huérfano {huerfano} (reparentado a init) murió con el árbol");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// La raíz termina SOLA dejando un proceso en segundo plano (la CLI acaba su turno con un hijo vivo): la raíz queda zombi
    /// (nadie la reapea hasta `close_tree`) y su grupo sigue siendo suyo; cerrar después encuentra y mata al huérfano.
    #[cfg(unix)]
    #[test]
    fn unix_kill_tras_salir_la_raiz_sola_cierra_al_huerfano() {
        let dir = carpeta("raiz-sale");
        let pidfile = dir.join("huerfano.pid");
        let script = format!("sleep 140 & echo $! > '{}'; exit 0", pidfile.display());
        let p = spawn_child(&spec(PathBuf::from("sh"), vec!["-c".into(), script])).expect("lanzamiento");
        let huerfano = pid_del_huerfano(&pidfile);
        assert!(espera(|| !vivo(p.pid()), 20), "la raíz salió sola (queda zombi)");
        assert!(vivo(huerfano), "y el huérfano sigue vivo");
        assert_eq!(p.kill(), Closure::Proven);
        assert!(espera(|| !vivo(huerfano), 20), "cerrar el árbol mató al huérfano {huerfano} aunque la raíz ya había salido");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn unix_soltar_el_proceso_cierra_el_arbol_entero() {
        let dir = carpeta("drop");
        let (p, pidfile) = lanza_con_huerfano(&dir, "135", "136");
        let (huerfano, raiz) = (pid_del_huerfano(&pidfile), p.pid());
        drop(p);
        assert!(espera(|| !vivo(huerfano) && !vivo(raiz), 20), "soltar el proceso no deja la raíz {raiz} ni el huérfano {huerfano} vivos");
        let _ = std::fs::remove_dir_all(dir);
    }

    // --- Todas las plataformas ---

    fn proceso_largo() -> LaunchSpec {
        if cfg!(windows) {
            spec(PathBuf::from("ping"), vec!["-n".into(), "139".into(), "127.0.0.1".into()])
        } else {
            spec(PathBuf::from("sleep"), vec!["139".into()])
        }
    }

    #[test]
    fn cerrar_dos_veces_es_inocuo_y_la_raiz_muere() {
        let p = spawn_child(&proceso_largo()).expect("lanzamiento");
        let pid = p.pid();
        assert_eq!(p.kill(), Closure::Proven);
        assert_eq!(p.kill(), Closure::Proven);
        assert!(p.family.closed.load(Ordering::Acquire), "el cierre se comprobó");
        #[cfg(windows)]
        assert!(espera(|| !powershell(&format!("Get-Process -Id {pid} -ErrorAction SilentlyContinue")).contains("ProcessName"), 10), "la raíz murió");
        #[cfg(unix)]
        assert!(espera(|| !vivo(pid), 10), "la raíz murió");
    }

    // --- Supervisor: la custodia de lo que no se pudo cerrar con prueba (LXO-242) ---

    use crate::orch::adapter::supervisor;
    use crate::orch::pty::pruebas::{espera_muerto, serie_custodia, vivo as proceso_vivo};

    /// Un cierre que no se puede probar sin matar nada (el hook de prueba) y vuelve a la normalidad.
    fn kill_sin_prueba(p: &ChildProcess) -> Closure {
        BREAK_CLOSE.with(|b| b.set(true));
        let c = p.kill();
        BREAK_CLOSE.with(|b| b.set(false));
        c
    }

    /// Un cierre sin probar NO mata a ciegas ni pierde el árbol: queda en la custodia a nombre de su Attempt, el proceso sigue vivo, y `reap` lo cierra
    /// cuando ya se puede probar. Lo comprobado sale de la custodia.
    #[test]
    fn un_cierre_sin_probar_queda_en_custodia_con_su_dueno_y_reap_lo_cierra() {
        let _serie = serie_custodia();
        let antes = supervisor::count();
        let p = spawn_child(&proceso_largo()).expect("lanzamiento");
        let pid = p.pid();
        p.set_owner("t9-a1");

        assert_eq!(kill_sin_prueba(&p), Closure::Unproven);
        assert_eq!(supervisor::count(), antes + 1, "la familia quedó en custodia");
        assert!(supervisor::in_custody("t9-a1") && supervisor::task_in_custody("t9"));
        assert!(proceso_vivo(pid), "sin prueba no se mata a ciegas: el proceso sigue vivo");

        assert_eq!(supervisor::reap(), antes, "con el cierre ya posible, lo comprobado sale de la custodia");
        assert!(!supervisor::in_custody("t9-a1") && !supervisor::task_in_custody("t9"));
        assert!(espera_muerto(pid), "el árbol terminó");
    }

    /// Soltar el proceso (`Drop`) con el cierre sin probar tampoco lo pierde: antes se mataba la raíz a ciegas y se reapeaba, perdiendo el ancla de su pid.
    #[test]
    fn soltar_un_proceso_sin_probar_no_lo_pierde() {
        let _serie = serie_custodia();
        let antes = supervisor::count();
        let p = spawn_child(&proceso_largo()).expect("lanzamiento");
        let pid = p.pid();
        p.set_owner("t8-a2");
        BREAK_CLOSE.with(|b| b.set(true));
        drop(p);
        BREAK_CLOSE.with(|b| b.set(false));

        assert_eq!(supervisor::count(), antes + 1, "soltarlo no lo descarta");
        assert!(supervisor::in_custody("t8-a2") && proceso_vivo(pid));
        assert_eq!(supervisor::reap(), antes);
        assert!(espera_muerto(pid));
    }

    /// La misma familia no se registra dos veces aunque se intente cerrar varias veces sin prueba.
    #[test]
    fn la_misma_familia_no_se_registra_dos_veces() {
        let _serie = serie_custodia();
        let antes = supervisor::count();
        let p = spawn_child(&proceso_largo()).expect("lanzamiento");
        let pid = p.pid();
        p.set_owner("t7-a1");
        assert_eq!((kill_sin_prueba(&p), kill_sin_prueba(&p)), (Closure::Unproven, Closure::Unproven));
        assert_eq!(supervisor::count(), antes + 1);
        assert_eq!(supervisor::reap(), antes);
        assert!(espera_muerto(pid));
    }

    /// El dueño se compara exacto: la Task `t9` no es la `t90`.
    #[test]
    fn la_task_en_custodia_se_compara_por_su_id_exacto() {
        let _serie = serie_custodia();
        let antes = supervisor::count();
        let p = spawn_child(&proceso_largo()).expect("lanzamiento");
        let pid = p.pid();
        p.set_owner("t90-a1");
        assert_eq!(kill_sin_prueba(&p), Closure::Unproven);
        assert!(supervisor::task_in_custody("t90"));
        assert!(!supervisor::task_in_custody("t9"), "t9 no es t90");
        assert!(!supervisor::task_in_custody("t90-a"), "ni un prefijo");
        assert_eq!(supervisor::reap(), antes);
        assert!(espera_muerto(pid));
    }

    /// El apagado ordenado del Core reintenta la custodia de los adapters antes de salir.
    #[test]
    fn el_apagado_del_core_reintenta_la_custodia_de_los_adapters() {
        let _serie = serie_custodia();
        let antes = supervisor::count();
        let p = spawn_child(&proceso_largo()).expect("lanzamiento");
        let pid = p.pid();
        p.set_owner("t6-a1");
        assert_eq!(kill_sin_prueba(&p), Closure::Unproven);
        assert_eq!(supervisor::count(), antes + 1);

        crate::orch::Orch::default().0.shutdown();

        assert_eq!(supervisor::count(), antes, "Core::shutdown vació la custodia de los adapters");
        assert!(espera_muerto(pid));
    }

    #[test]
    fn un_programa_que_no_existe_falla_sin_dejar_nada() {
        let e = spawn_child(&spec(PathBuf::from("este-programa-no-existe-lxo-242"), vec![])).err().expect("falla");
        assert!(e.to_string().contains("no se pudo lanzar"), "{e}");
    }
}
