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
    /// `None` mientras alguien lo tiene prestado para matar el árbol (ver [`AgentTerm::begin_kill`]): el terminal
    /// SIGUE en el mapa del Core, así que una terminación en curso no se confunde con «no hay terminal».
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
    /// `Core::on_exit` vio terminar al proceso mientras se le estaba matando: el kill en curso, si falla, se reintenta
    /// una vez (ya solo falta comprobar) en vez de dejar un terminal de un proceso muerto para siempre en el mapa.
    exited: bool,
    pub buffer: Arc<Mutex<Vec<u8>>>,
}

/// Matador de un proceso, prestado por [`AgentTerm::begin_kill`] para matarlo SIN tener el mapa de terminales bloqueado.
pub type Killer = Box<dyn ChildKiller + Send + Sync>;

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
        let _ = self.try_kill();
    }

    /// Mata el árbol del proceso y dice si pudo. `Ok` = el matador se ejecutó (un proceso que ya había
    /// muerto también cuenta); `Err` = no hay control fiable sobre él (o ya hay otra terminación en curso).
    pub fn try_kill(&mut self) -> Result<(), String> {
        /// Devuelve el matador a su sitio al soltarse, también si `kill` entra en pánico.
        struct Lease<'a> {
            slot: &'a mut Option<Killer>,
            killer: Option<Killer>,
        }
        impl Drop for Lease<'_> {
            fn drop(&mut self) {
                if let Some(k) = self.killer.take() {
                    *self.slot = Some(k);
                }
            }
        }
        let killer = self.begin_kill()?;
        let mut lease = Lease { slot: &mut self.killer, killer: Some(killer) };
        lease.killer.as_mut().map_or(Ok(()), |k| k.kill()).map_err(|e| e.to_string())
    }

    /// Toma prestado el matador para matar con el terminal AÚN almacenado. Mientras esté prestado hay una terminación
    /// en curso ([`AgentTerm::kill_in_progress`]) y un segundo llamante recibe `Err` en vez de matar a la vez o de
    /// creer que el proceso ya está muerto.
    pub fn begin_kill(&mut self) -> Result<Killer, String> {
        self.killer.take().ok_or_else(|| "ya hay una terminación en curso de este proceso".to_string())
    }

    /// Devuelve el matador prestado (el kill falló o terminó): el terminal vuelve a poder matarse.
    pub fn end_kill(&mut self, killer: Killer) {
        self.killer = Some(killer);
    }

    /// Anota que el proceso terminó (lo vio `on_exit`) mientras había una terminación en curso.
    pub fn mark_exited(&mut self) {
        self.exited = true;
    }

    pub fn exited(&self) -> bool {
        self.exited
    }

    /// ¿Hay alguien matando este proceso ahora mismo?
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn kill_in_progress(&self) -> bool {
        self.killer.is_none()
    }

    /// Prueba: un terminal sin proceso detrás, con el matador que se indique (p. ej. uno que falla).
    #[cfg(test)]
    pub fn for_tests(killer: Box<dyn ChildKiller + Send + Sync>) -> AgentTerm {
        let sink: Box<dyn Write + Send> = Box::new(std::io::sink());
        AgentTerm { master: None, writer: Arc::new(Mutex::new(sink)), killer: Some(killer), exited: false, buffer: Arc::new(Mutex::new(Vec::new())) }
    }
}

/// Un proceso recién creado cuya construcción falló y que NO se pudo dar por muerto. No hay `AgentTerm` al que
/// colgarlo (el lanzamiento devuelve `Err`), así que queda aquí, bajo la custodia del módulo, con el matador que
/// falló: nunca se suelta un proceso potencialmente vivo y sin dueño. `owner` es la tarea que lo lanzó: quien limpia
/// un lanzamiento fallido pregunta por ella ([`resolve_custody`]) ANTES de borrar su worktree, su rama o su Task. Se
/// reintenta también con [`reap_unowned`] (`Core::shutdown`).
///
/// `killer: None` = alguien lo está matando AHORA (el matador está prestado, ver [`CustodyLease`]): la entrada sigue en
/// la custodia, así que ni un segundo `resolve_custody` ni el apagado la dan por resuelta o la descartan, y el mutex
/// global NO se mantiene bloqueado mientras corre el matador.
struct Unowned {
    id: u64,
    owner: Option<String>,
    pid: Option<u32>,
    killer: Option<Killer>,
}

static UNOWNED: Mutex<Vec<Unowned>> = Mutex::new(Vec::new());
static NEXT_UNOWNED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn unowned() -> std::sync::MutexGuard<'static, Vec<Unowned>> {
    UNOWNED.lock().unwrap_or_else(|e| e.into_inner())
}

fn push_unowned(owner: Option<String>, pid: Option<u32>, killer: Killer) {
    let id = NEXT_UNOWNED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    unowned().push(Unowned { id, owner, pid, killer: Some(killer) });
}

/// Procesos en custodia (su compensación no se pudo comprobar). Diagnóstico.
#[cfg_attr(not(test), allow(dead_code))]
pub fn unowned_count() -> usize {
    unowned().len()
}

/// El matador de una entrada de la custodia, prestado mientras corre. Si se suelta sin `finish` (el kill falló o hubo
/// un pánico dentro del matador) vuelve a su entrada: la custodia nunca pierde un matador cuyo proceso puede seguir vivo.
struct CustodyLease {
    id: u64,
    killer: Option<Killer>,
}

impl CustodyLease {
    /// Un intento de matar. En pruebas, `BREAK_KILLS` lo hace fallar sin tocar el proceso.
    fn kill(&mut self) -> Result<(), String> {
        #[cfg(test)]
        if BREAK_KILLS.with(|b| b.get()) {
            return Err("matador roto inyectado".into());
        }
        self.killer.as_mut().ok_or("matador ya consumido")?.kill().map_err(|e| e.to_string())
    }

    /// El kill se comprobó: la entrada sale de la custodia.
    fn finish(mut self) {
        self.killer = None;
        unowned().retain(|u| u.id != self.id);
    }
}

impl Drop for CustodyLease {
    fn drop(&mut self) {
        if let Some(k) = self.killer.take() {
            if let Some(u) = unowned().iter_mut().find(|u| u.id == self.id) {
                u.killer = Some(k);
            }
        }
    }
}

/// Resultado de reintentar un conjunto de entradas de la custodia.
struct Retry {
    /// Había al menos una entrada seleccionada.
    found: bool,
    /// Alguna ya la estaba matando otro llamante: no se pudo comprobar.
    in_progress: bool,
    failure: Option<String>,
}

/// Presta el matador de las entradas que cumplan `select` (las que otro ya está matando se marcan `in_progress`), los
/// ejecuta SIN el mutex global y saca de la custodia los que se comprobaron.
fn retry_where(select: impl Fn(&Unowned) -> bool) -> Retry {
    let mut leases = Vec::new();
    let mut r = Retry { found: false, in_progress: false, failure: None };
    {
        let mut list = unowned();
        for u in list.iter_mut().filter(|u| select(u)) {
            r.found = true;
            match u.killer.take() {
                Some(k) => leases.push(CustodyLease { id: u.id, killer: Some(k) }),
                None => r.in_progress = true,
            }
        }
    }
    for mut lease in leases {
        match lease.kill() {
            Ok(()) => lease.finish(),
            Err(e) => {
                r.failure.get_or_insert(e);
            }
        }
    }
    r
}

/// Reintenta matar los procesos en custodia que cumplan `pred` y devuelve cuántos siguen en ella. No descarta los que
/// otro está matando ya: siguen en la custodia.
fn reap_unowned_where(pred: impl Fn(Option<u32>) -> bool) -> usize {
    retry_where(|u| pred(u.pid));
    unowned().len()
}

/// Reintenta matar todos los procesos en custodia. Lo llama `Core::shutdown`.
pub fn reap_unowned() -> usize {
    reap_unowned_where(|_| true)
}

/// ¿Hay un proceso de `owner` en custodia (sin dueño porque falló su construcción o su terminal desapareció)? Uno al que
/// otro llamante está matando ahora mismo también cuenta.
pub fn in_custody(owner: &str) -> bool {
    unowned().iter().any(|u| u.owner.as_deref() == Some(owner))
}

/// Dueños en custodia cuyo nombre empieza por `prefix` (sin él): los procesos vivos sin terminal de un Core.
pub fn custody_owners(prefix: &str) -> Vec<String> {
    unowned().iter().filter_map(|u| u.owner.as_deref()?.strip_prefix(prefix).map(str::to_string)).collect()
}

/// Pone bajo custodia un proceso de `owner` cuyo matador acaba de fallar y que ya no tiene terminal al que volver.
pub fn keep_in_custody(owner: &str, killer: Killer) {
    push_unowned(Some(owner.to_string()), None, killer);
}

/// Resuelve la custodia de `owner` COMPROBANDO el resultado: reintenta matar sus procesos. `None`: no había ninguno.
/// `Some(Ok)`: había y se mataron todos (salen de la custodia). `Some(Err)`: al menos uno sigue sin control fiable, o
/// OTRO llamante lo está matando ahora mismo, y permanece en la custodia: quien limpia debe CONSERVARLO todo (worktree,
/// rama, Task). El mutex global solo se toma para prestar y devolver matadores, nunca mientras corre `taskkill`.
pub fn resolve_custody(owner: &str) -> Option<Result<(), String>> {
    let r = retry_where(|u| u.owner.as_deref() == Some(owner));
    match (r.found, r.in_progress, r.failure) {
        (false, ..) => None,
        (true, _, Some(e)) => Some(Err(format!("un proceso lanzado para {owner} sigue en custodia: {e}"))),
        (true, true, None) => Some(Err(format!("un proceso lanzado para {owner} se está matando ahora mismo: terminación en curso"))),
        (true, false, None) => Some(Ok(())),
    }
}

/// Compensa un fallo de construcción posterior a crear el proceso: lo mata COMPROBANDO el resultado y devuelve
/// `true` solo si puede darse por muerto. No se confía en que soltar los manejadores lo mate: cerrar el master de
/// una PTY puede acabar con él según la plataforma, pero un proceso canalizado seguiría vivo y `AgentTerm` no
/// tiene `Drop`. Solo el matador del ÁRBOL cuenta (verifica que murió todo, no solo la raíz); si falla, el kill directo
/// del hijo (`direct`, solo alcanza a la raíz) se intenta por si ayuda, pero NO libera nada: el proceso pasa a la
/// custodia del módulo (`UNOWNED`, a nombre de `owner`) con su matador del árbol, que recuerda los descendientes que
/// vio y los verificará al reintentar.
fn kill_after_failed_setup(owner: Option<&str>, pid: Option<u32>, mut killer: Killer, direct: &mut dyn FnMut() -> std::io::Result<()>) -> bool {
    #[cfg(test)]
    let broken = BREAK_KILLS.with(|b| b.get());
    #[cfg(not(test))]
    let broken = false;
    let dead = !broken && killer.kill().is_ok();
    if dead {
        #[cfg(test)]
        KILLS_AFTER_FAILED_SETUP.with(|k| k.set(k.get() + 1));
    } else {
        if !broken {
            let _ = direct();
        }
        push_unowned(owner.map(str::to_string), pid, killer);
    }
    dead
}

/// El `Err` de un lanzamiento cuya construcción falló, con lo que pasó con el proceso si no se pudo matar.
fn setup_failure(e: String, pid: Option<u32>, dead: bool) -> String {
    if dead {
        return e;
    }
    let who = pid.map_or("recién creado".to_string(), |p| p.to_string());
    format!("{e}. El proceso {who} no se pudo matar y queda bajo la custodia de Lixbon")
}

// SOLO pruebas: punto de fallo inyectable justo después de crear el proceso (el equivalente de que
// `try_clone_reader`, `take_writer` o la captura de las tuberías devuelva `Err`).
#[cfg(test)]
thread_local! {
    pub(crate) static FAIL_AFTER_SPAWN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(crate) static LAST_SPAWNED_PID: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
    /// Cuántas veces se ejecutó la compensación (el kill tras un fallo de construcción) en este hilo.
    pub(crate) static KILLS_AFTER_FAILED_SETUP: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
    /// Ningún matador (ni el del árbol ni el directo) funciona: no hay control fiable sobre el proceso.
    pub(crate) static BREAK_KILLS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// La n-ésima creación de un hilo del agente (1 = la primera) falla; 0 = ninguna.
    pub(crate) static FAIL_THREAD_SPAWN: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn post_spawn_failpoint(pid: Option<u32>) -> Result<(), String> {
    LAST_SPAWNED_PID.with(|p| p.set(pid));
    if FAIL_AFTER_SPAWN.with(|f| f.get()) {
        return Err("fallo inyectado tras crear el proceso".into());
    }
    Ok(())
}

#[cfg(not(test))]
fn post_spawn_failpoint(_pid: Option<u32>) -> Result<(), String> {
    Ok(())
}

pub struct Launch<'a> {
    pub cwd: &'a str,
    pub script_dir: &'a Path,
    pub command: String,
    pub env: Vec<(String, String)>,
    pub inject: Option<String>,
    pub piped: bool,
    /// Tarea a cuyo nombre queda en custodia el proceso si su construcción falla y no se puede matar.
    pub owner: Option<&'a str>,
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

/// Mata el árbol entero: bajo `cmd /C` quedaría vivo el proceso del agente. Delega en `proctable::kill_tree`, que
/// identifica cada proceso por `(pid, hora de creación)` (un pid se reutiliza), recuerda entre intentos solo a los
/// descendientes que siguen vivos, vuelve a descubrir lo que nazca durante el kill y falla CERRADO si algo no se puede
/// probar. Ver la cabecera de ese módulo.
///
/// El árbol es COMPARTIDO (`Arc<Mutex<_>>`) entre este matador, sus clones y el hilo que espera a la raíz
/// ([`proctable::wait_root`]): el hilo anota el grupo de procesos cuando la raíz sale y la reapea SOLO con el candado, así
/// que mientras un kill tiene el árbol la raíz (zombi) sigue siendo el ancla de la propiedad del grupo.
#[derive(Debug)]
struct TreeKiller {
    tree: Arc<Mutex<crate::proctable::Tree>>,
}

impl TreeKiller {
    /// Se crea justo después de crear el proceso (su pid es seguro): anota su identidad en ese instante.
    fn new(pid: u32) -> Self {
        TreeKiller { tree: Arc::new(Mutex::new(crate::proctable::Tree::capture(&mut crate::proctable::RealOs::default(), pid))) }
    }

    /// El árbol, para quien espera a la raíz.
    fn shared(&self) -> Arc<Mutex<crate::proctable::Tree>> {
        self.tree.clone()
    }
}

impl ChildKiller for TreeKiller {
    /// `Ok` solo si una ronda completa comprobó que NINGÚN proceso del árbol sigue vivo y no apareció ninguno nuevo.
    fn kill(&mut self) -> std::io::Result<()> {
        // Un pánico anterior dentro de un kill no invalida lo que el árbol recuerda: se recupera el candado.
        let mut tree = self.tree.lock().unwrap_or_else(|e| e.into_inner());
        crate::proctable::kill_tree(&mut tree, &mut crate::proctable::RealOs::default())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(TreeKiller { tree: self.tree.clone() })
    }
}

#[cfg(test)]
/// ¿Sigue vivo el proceso `pid`? Ante la duda (no se pudo ejecutar la comprobación, o la herramienta falló y su
/// salida vacía no prueba nada), `true`.
fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("tasklist");
        cmd.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
        match hide_console(&mut cmd).output() {
            Ok(o) => tasklist_alive(o.status.success(), &String::from_utf8_lossy(&o.stdout), pid),
            Err(_) => true,
        }
    }
    #[cfg(not(windows))]
    {
        let mut cmd = std::process::Command::new("ps");
        cmd.args(["-o", "stat=", "-p", &pid.to_string()]);
        match hide_console(&mut cmd).output() {
            Ok(o) => ps_alive(o.status.code(), &String::from_utf8_lossy(&o.stdout)),
            Err(_) => true,
        }
    }
}

/// Interpreta la salida de `tasklist /FI "PID eq N" /NH`. Un estado distinto de cero es un fallo de la herramienta
/// (su salida vacía NO significa «no existe»): vivo. Con éxito, el proceso vive si su fila lo nombra.
#[cfg(test)]
#[cfg_attr(not(windows), allow(dead_code))]
fn tasklist_alive(success: bool, stdout: &str, pid: u32) -> bool {
    !success || stdout.contains(&format!(" {pid} "))
}

/// Interpreta la salida de `ps -o stat= -p N`. `ps` sale con 1 cuando ningún proceso coincide; cualquier otro estado
/// con la salida vacía es un fallo de la herramienta y no prueba nada: vivo. Un zombi pendiente de `wait` cuenta como muerto.
#[cfg(test)]
#[cfg_attr(windows, allow(dead_code))]
fn ps_alive(code: Option<i32>, stdout: &str) -> bool {
    let stat = stdout.trim();
    if stat.is_empty() {
        return code != Some(1);
    }
    !stat.starts_with('Z')
}

/// Crea un hilo propio del agente. SOLO pruebas: `FAIL_THREAD_SPAWN = n` hace fallar la n-ésima creación del hilo.
fn spawn_thread<F: FnOnce() + Send + 'static>(f: F) -> std::io::Result<thread::JoinHandle<()>> {
    #[cfg(test)]
    if FAIL_THREAD_SPAWN.with(|c| match c.get() {
        0 => false,
        1 => {
            c.set(0);
            true
        }
        n => {
            c.set(n - 1);
            false
        }
    }) {
        return Err(std::io::Error::other("hilo no creado (fallo inyectado)"));
    }
    thread::Builder::new().spawn(f)
}

/// Un hilo no se pudo crear DESPUÉS de crear el proceso: el mismo cleanup comprobado que ante cualquier otro fallo de
/// construcción (`thread::spawn` habría entrado en pánico y dejado el proceso sin dueño). Devuelve el `Err` del
/// lanzamiento.
fn thread_failure(owner: Option<&str>, pid: Option<u32>, killer: Killer, direct: &mut dyn FnMut() -> std::io::Result<()>, e: std::io::Error) -> (String, bool) {
    let dead = kill_after_failed_setup(owner, pid, killer, direct);
    (setup_failure(format!("No se pudo crear un hilo del agente: {e}"), pid, dead), dead)
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
    // Unix: la raíz lidera su PROPIO grupo de procesos (pgid == pid) para que `proctable` pueda encontrar a toda su
    // descendencia aunque un padre intermedio salga y sus hijos se reparenten a init. (La PTY ya hace `setsid`.)
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    for (k, v) in &l.env {
        cmd.env(k, v);
    }
    let mut child = hide_console(&mut cmd).spawn().map_err(|e| format!("No se pudo lanzar el agente: {e}"))?;
    let pid = child.id();
    // La identidad de la raíz se anota ahora, con el proceso recién creado.
    let tree = TreeKiller::new(pid);
    let waiter_tree = tree.shared();
    // El proceso ya existe: si falta cualquier tubería, se mata antes de devolver el error.
    let pipes = post_spawn_failpoint(Some(pid)).and_then(|_| match (child.stdout.take(), child.stderr.take()) {
        (Some(out), Some(err)) => Ok((out, err)),
        (None, _) => Err("sin stdout".to_string()),
        (_, None) => Err("sin stderr".to_string()),
    });
    let (stdout, stderr) = match pipes {
        Ok(p) => p,
        Err(e) => {
            let dead = kill_after_failed_setup(l.owner, Some(pid), tree.clone_killer(), &mut || child.kill());
            if dead {
                let _ = child.wait();
            }
            return Err(setup_failure(e, Some(pid), dead));
        }
    };
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let on_output = Arc::new(on_output);
    // El hijo queda en una ranura: si un hilo no se puede crear, el closure se descarta y el hijo no se pierde.
    let child = Arc::new(Mutex::new(Some(child)));
    let abort = |e: std::io::Error| -> String {
        let mut c = child.lock().unwrap_or_else(|x| x.into_inner()).take();
        let pid_known = Some(pid);
        let (msg, dead) = thread_failure(l.owner, pid_known, tree.clone_killer(), &mut || c.as_mut().map_or(Ok(()), |c| c.kill()), e);
        if let (true, Some(mut c)) = (dead, c) {
            let _ = c.wait();
        }
        msg
    };
    let pump = |mut pipe: Box<dyn Read + Send>, buf: Arc<Mutex<Vec<u8>>>, out: Arc<dyn Fn(String) + Send + Sync>| {
        spawn_thread(move || {
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
    let a = match pump(Box::new(stdout), buffer.clone(), on_output.clone()) {
        Ok(h) => h,
        Err(e) => return Err(abort(e)),
    };
    let b = match pump(Box::new(stderr), buffer.clone(), on_output) {
        Ok(h) => h,
        Err(e) => return Err(abort(e)),
    };
    let waiter_child = child.clone();
    if let Err(e) = spawn_thread(move || {
        let taken = waiter_child.lock().unwrap_or_else(|x| x.into_inner()).take();
        if let Some(mut c) = taken {
            // Unix: la raíz queda zombi mientras se anota su grupo (los procesos que deje en segundo plano retienen las
            // tuberías, así que lo de abajo puede tardar), y solo entonces se reapea.
            crate::proctable::wait_root(&waiter_tree, &mut crate::proctable::RealOs::default(), pid, || {
                let _ = c.wait();
            });
        }
        let _ = a.join();
        let _ = b.join();
        on_exit();
    }) {
        return Err(abort(e));
    }
    let sink: Box<dyn Write + Send> = Box::new(std::io::sink());
    Ok(AgentTerm { master: None, writer: Arc::new(Mutex::new(sink)), killer: Some(Box::new(tree)), exited: false, buffer })
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
    let tree_killer = child.process_id().map(TreeKiller::new);
    let observer = tree_killer.as_ref().map(TreeKiller::shared);
    let killer: Box<dyn ChildKiller + Send + Sync> = match tree_killer {
        Some(k) => Box::new(k),
        None => child.clone_killer(),
    };
    drop(pair.slave);

    // El proceso ya existe: si falla cualquier preparación posterior se mata antes de devolver el error
    // (`AgentTerm` no mata al soltarse, así que nadie más lo haría).
    let streams = post_spawn_failpoint(child.process_id())
        .and_then(|_| pair.master.try_clone_reader().map_err(|e| e.to_string()))
        .and_then(|r| pair.master.take_writer().map_err(|e| e.to_string()).map(|w| (r, w)));
    let (mut reader, writer): (_, Shared) = match streams {
        Ok((r, w)) => (r, Arc::new(Mutex::new(w))),
        Err(e) => {
            let pid = child.process_id();
            let dead = kill_after_failed_setup(l.owner, pid, killer, &mut || child.kill());
            if dead {
                let _ = child.wait();
            }
            return Err(setup_failure(e, pid, dead));
        }
    };
    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let started = Instant::now();
    let last_output = Arc::new(Mutex::new(None::<Instant>));

    // El hijo queda en una ranura: si un hilo no se puede crear, el closure se descarta y el hijo no se pierde.
    let child = Arc::new(Mutex::new(Some(child)));
    let pid_known = child.lock().unwrap_or_else(|x| x.into_inner()).as_ref().and_then(|c| c.process_id());
    let abort = |killer: Killer, e: std::io::Error| -> String {
        let mut c = child.lock().unwrap_or_else(|x| x.into_inner()).take();
        let (msg, dead) = thread_failure(l.owner, pid_known, killer, &mut || c.as_mut().map_or(Ok(()), |c| c.kill()), e);
        if let (true, Some(mut c)) = (dead, c) {
            let _ = c.wait();
        }
        msg
    };
    let (buf_r, writer_r, last_r) = (buffer.clone(), writer.clone(), last_output.clone());
    if let Err(e) = spawn_thread(move || {
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
    }) {
        return Err(abort(killer.clone_killer(), e));
    }

    // Con ConPTY el lector no recibe EOF al morir el proceso (el master sigue
    // abierto): el fin se detecta esperando al hijo.
    let waiter_child = child.clone();
    if let Err(e) = spawn_thread(move || {
        let taken = waiter_child.lock().unwrap_or_else(|x| x.into_inner()).take();
        let code = taken
            .and_then(|mut c| {
                let mut status = None;
                match (&observer, c.process_id()) {
                    // Unix: la raíz queda zombi mientras se anota su grupo, y solo entonces se reapea.
                    (Some(tree), Some(pid)) => crate::proctable::wait_root(tree, &mut crate::proctable::RealOs::default(), pid, || status = c.wait().ok()),
                    _ => status = c.wait().ok(),
                }
                status
            })
            .map(|s| s.exit_code());
        thread::sleep(Duration::from_millis(300));
        on_exit(code);
    }) {
        return Err(abort(killer.clone_killer(), e));
    }

    let mut term = AgentTerm { master: Some(pair.master), writer, killer: Some(killer), exited: false, buffer };
    if let Some(prompt) = l.inject {
        let w = term.writer.clone();
        if let Err(e) = spawn_thread(move || {
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
        }) {
            // El terminal aún no es de nadie: su matador se usa aquí, con la misma compensación comprobada.
            let killer = term.killer.take().unwrap_or_else(|| Box::new(TreeKiller::new(pid_known.unwrap_or(0))));
            return Err(abort(killer, e));
        }
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
            super::Launch { cwd: &dir.to_string_lossy(), script_dir: &dir.join(".lixbon"), command: l.command, env: l.env, inject: l.inject, piped: l.piped, owner: None },
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
                    owner: None,
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

/// Pruebas del cleanup de procesos: lanzar un proceso real de larga duración y saber si sigue vivo.
#[cfg(test)]
pub(crate) mod pruebas {
    use super::*;

    pub fn comando_largo() -> String {
        if cfg!(windows) { "ping -n 60 127.0.0.1 >nul".into() } else { "sleep 60".into() }
    }

    /// ¿Sigue vivo el proceso? (un zombi pendiente de `wait` cuenta como muerto).
    pub fn vivo(pid: u32) -> bool {
        super::pid_alive(pid)
    }

    pub fn espera_muerto(pid: u32) -> bool {
        let limite = Instant::now() + Duration::from_secs(15);
        while Instant::now() < limite {
            if !vivo(pid) {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        !vivo(pid)
    }

    pub fn lanza(dir: &Path, piped: bool) -> Result<AgentTerm, String> {
        lanza_para(dir, piped, None)
    }

    /// Como `lanza`, con la tarea a cuyo nombre queda en custodia el proceso si su construcción falla y no se mata.
    pub fn lanza_para(dir: &Path, piped: bool, owner: Option<&str>) -> Result<AgentTerm, String> {
        lanza_inyectando(dir, piped, owner, None)
    }

    /// Como `lanza_para`, con un texto que se escribe en la TUI al arrancar (crea un tercer hilo en una PTY).
    pub fn lanza_inyectando(dir: &Path, piped: bool, owner: Option<&str>, inject: Option<&str>) -> Result<AgentTerm, String> {
        let cwd = dir.to_string_lossy().into_owned();
        spawn(Launch { cwd: &cwd, script_dir: &dir.join("s"), command: comando_largo(), env: vec![], inject: inject.map(str::to_string), piped, owner }, |_| {}, || {})
    }

    /// Ejecuta `f` haciendo fallar la n-ésima creación de un hilo del agente (1 = la primera).
    pub fn con_hilo_que_falla<R>(n: u32, f: impl FnOnce() -> R) -> R {
        FAIL_THREAD_SPAWN.with(|c| c.set(n));
        let r = f();
        FAIL_THREAD_SPAWN.with(|c| c.set(0));
        r
    }

    /// Ejecuta `f` con TODOS los matadores rotos (el del árbol, el directo y los reintentos de la custodia): no hay
    /// control fiable sobre ningún proceso.
    pub fn con_matadores_rotos<R>(f: impl FnOnce() -> R) -> R {
        BREAK_KILLS.with(|b| b.set(true));
        let r = f();
        BREAK_KILLS.with(|b| b.set(false));
        r
    }

    /// La custodia es global y `Core::shutdown` la vacía entera (mata lo que encuentre): las pruebas que la tocan, o que
    /// lo invocan, van de una en una.
    pub fn serie_custodia() -> std::sync::MutexGuard<'static, ()> {
        static SERIE: Mutex<()> = Mutex::new(());
        SERIE.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// ¿Está libre el mutex global de la custodia? Una prueba lo consulta MIENTRAS un matador corre: si estuviera
    /// bloqueado, `lock()` colgaría la prueba en vez de fallarla.
    pub fn custodia_libre() -> bool {
        !matches!(UNOWNED.try_lock(), Err(std::sync::TryLockError::WouldBlock))
    }

    pub fn kills_tras_fallo() -> u32 {
        KILLS_AFTER_FAILED_SETUP.with(|k| k.get())
    }

    pub fn ultimo_pid() -> Option<u32> {
        LAST_SPAWNED_PID.with(|p| p.get())
    }

    /// Ejecuta `f` con el fallo inyectado justo después de crear el proceso.
    pub fn con_fallo_tras_crear<R>(f: impl FnOnce() -> R) -> R {
        FAIL_AFTER_SPAWN.with(|x| x.set(true));
        let r = f();
        FAIL_AFTER_SPAWN.with(|x| x.set(false));
        r
    }

    /// Carpeta de trabajo propia de cada llamada: las pruebas corren en paralelo dentro del mismo proceso y
    /// compartir carpeta (y su `launch.cmd`) entre dos lanzamientos los pisaba.
    pub fn carpeta(nombre: &str) -> std::path::PathBuf {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("lxo-pty-{nombre}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}

/// P2-6: un hilo que no se puede crear DESPUÉS de crear el proceso (`thread::spawn` habría entrado en pánico y soltado
/// un proceso vivo sin dueño) pasa por la misma compensación comprobada y, si no se confirma la muerte, por la custodia.
#[cfg(test)]
mod hilos_tras_crear_el_proceso {
    use super::pruebas::*;
    use super::{in_custody, resolve_custody};

    /// (canalizado, texto inyectado, hilos que crea): cada uno de ellos puede ser el que falle.
    const CASOS: [(bool, Option<&str>, u32); 3] = [(true, None, 3), (false, None, 2), (false, Some("hola"), 3)];

    #[test]
    fn si_un_hilo_no_se_crea_el_proceso_se_mata_antes_de_devolver_el_error() {
        let _serie = serie_custodia();
        for (piped, inject, hilos) in CASOS {
            for n in 1..=hilos {
                let dir = carpeta(&format!("hilo-{piped}-{n}"));
                let dueno = format!("t-hilo-{piped}-{n}-{}", inject.is_some());
                let r = con_hilo_que_falla(n, || lanza_inyectando(&dir, piped, Some(&dueno), inject));
                let pid = ultimo_pid().expect("el proceso llegó a crearse");
                let e = r.err().unwrap_or_else(|| panic!("el hilo {n} (piped={piped}, inject={inject:?}) debía fallar"));
                assert!(e.contains("hilo") && !e.contains("custodia"), "{e}");
                assert!(espera_muerto(pid), "sin hilo no hay dueño: el proceso se mató (piped={piped}, hilo {n}, inject={inject:?})");
                assert!(!in_custody(&dueno), "y no queda nada que custodiar");
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    #[test]
    fn si_un_hilo_no_se_crea_y_no_se_puede_matar_el_proceso_queda_en_custodia() {
        let _serie = serie_custodia();
        for (piped, inject, hilos) in CASOS {
            for n in 1..=hilos {
                let dir = carpeta(&format!("hilo-roto-{piped}-{n}"));
                let dueno = format!("t-hilo-roto-{piped}-{n}-{}", inject.is_some());
                let r = con_matadores_rotos(|| con_hilo_que_falla(n, || lanza_inyectando(&dir, piped, Some(&dueno), inject)));
                let pid = ultimo_pid().expect("el proceso llegó a crearse");
                let e = r.err().expect("el lanzamiento falla");
                assert!(e.contains("hilo") && e.contains("custodia"), "{e}");
                // Una PTY puede morir sola al soltar su master; uno canalizado solo muere si alguien lo mata.
                assert!(in_custody(&dueno) && (!piped || vivo(pid)), "no se suelta un proceso vivo (piped={piped}, hilo {n}, inject={inject:?})");
                assert!(matches!(resolve_custody(&dueno), Some(Ok(()))), "el reintento lo mata");
                assert!(espera_muerto(pid) && !in_custody(&dueno));
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }
}

#[cfg(test)]
mod error_tras_crear_el_proceso {
    use super::pruebas::*;

    #[test]
    fn sin_fallo_el_proceso_vive_y_try_kill_lo_mata() {
        for piped in [false, true] {
            let dir = carpeta(&format!("base-{piped}"));
            let mut term = lanza(&dir, piped).expect("el lanzamiento normal funciona");
            let pid = ultimo_pid().expect("pid");
            assert!(vivo(pid), "el proceso arrancó (piped={piped})");
            term.try_kill().unwrap();
            assert!(espera_muerto(pid), "try_kill lo mata (piped={piped})");
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn try_kill_mata_tambien_a_los_descendientes_reales() {
        let dir = carpeta("arbol-real");
        let mut term = lanza(&dir, true).expect("lanzamiento");
        let raiz = ultimo_pid().expect("pid");
        // `cmd /C launch` arranca al agente (`ping`/`sleep`) como hijo: se espera a verlo en la tabla.
        let limite = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let hijos = loop {
            let t = crate::proctable::process_table().expect("tabla");
            let hijos: Vec<u32> = t.iter().filter(|(_, pp)| *pp == raiz).map(|(p, _)| *p).collect();
            if !hijos.is_empty() || std::time::Instant::now() > limite {
                break hijos;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert!(!hijos.is_empty(), "el agente es un hijo de la raíz");
        term.try_kill().expect("el árbol entero se mata y se comprueba");
        assert!(espera_muerto(raiz));
        for h in hijos {
            assert!(espera_muerto(h), "el descendiente {h} también murió");
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_error_posterior_a_spawn_command_mata_el_proceso_en_pty() {
        let dir = carpeta("pty");
        let antes = kills_tras_fallo();
        let r = con_fallo_tras_crear(|| lanza(&dir, false));
        assert!(matches!(&r, Err(e) if e.contains("inyectado")), "{:?}", r.err());
        assert_eq!(kills_tras_fallo(), antes + 1, "se ejecutó la compensación: no se depende de que soltar el master mate al proceso");
        let pid = ultimo_pid().expect("el proceso llegó a crearse");
        assert!(espera_muerto(pid), "el proceso no puede quedar vivo y sin dueño");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn un_error_posterior_al_spawn_mata_el_proceso_canalizado() {
        let dir = carpeta("piped");
        let antes = kills_tras_fallo();
        let r = con_fallo_tras_crear(|| lanza(&dir, true));
        assert!(matches!(&r, Err(e) if e.contains("inyectado")), "{:?}", r.err());
        assert_eq!(kills_tras_fallo(), antes + 1, "se ejecutó la compensación");
        let pid = ultimo_pid().expect("el proceso llegó a crearse");
        assert!(espera_muerto(pid), "el proceso no puede quedar vivo y sin dueño");
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Unix, procesos de verdad: el lanzamiento deja a la raíz como líder de su grupo (`process_group(0)` canalizado, `setsid`
/// en la PTY), el matador del árbol lo sabe, y una raíz que sale dejando un proceso en segundo plano no deja un cleanup
/// imposible: el grupo se anota al salir la raíz (todavía zombi) y el kill posterior lo encuentra.
#[cfg(all(test, unix))]
mod grupo_de_procesos_unix {
    use super::pruebas::*;
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn lanza_comando(dir: &Path, piped: bool, command: &str, on_exit: impl FnOnce() + Send + 'static) -> Result<AgentTerm, String> {
        let cwd = dir.to_string_lossy().into_owned();
        spawn(Launch { cwd: &cwd, script_dir: &dir.join("s"), command: command.into(), env: vec![], inject: None, piped, owner: None }, |_| {}, on_exit)
    }

    /// Espera (acotado) a que el grupo `pgid` tenga algún miembro vivo que no sea `raiz` y devuelve sus pids.
    fn miembros_huerfanos(raiz: u32) -> Vec<u32> {
        let limite = Instant::now() + Duration::from_secs(15);
        loop {
            let mut os = crate::proctable::RealOs::default();
            let m: Vec<u32> = crate::proctable::Os::group_view(&mut os, raiz).map(|g| g.members.iter().map(|p| p.pid).filter(|p| *p != raiz).collect()).unwrap_or_default();
            if !m.is_empty() || Instant::now() > limite {
                return m;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn la_raiz_lanzada_lidera_su_grupo_y_un_matador_creado_tras_el_spawn_lo_sabe() {
        for piped in [true, false] {
            let dir = carpeta(&format!("lider-{piped}"));
            let mut term = lanza(&dir, piped).expect("lanzamiento");
            let pid = ultimo_pid().expect("pid");
            let tk = TreeKiller::new(pid);
            assert_eq!(tk.tree.lock().unwrap().pgid(), Some(pid), "la raíz lidera su propio grupo (piped={piped})");
            term.try_kill().expect("el árbol se mata y se comprueba");
            assert!(espera_muerto(pid));
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn disparador_b_la_raiz_sale_dejando_un_proceso_en_segundo_plano_y_aun_asi_se_puede_matar_todo() {
        // Canalizado: el proceso en segundo plano retiene las tuberías, así que `on_exit` NO llega mientras viva. PTY: la
        // raíz ignora SIGHUP para que el huérfano sobreviva al cierre de su terminal de control.
        for (piped, comando) in [(true, "sleep 120 &"), (false, "trap '' HUP; sleep 120 &")] {
            let dir = carpeta(&format!("b-{piped}"));
            let salio = Arc::new(AtomicBool::new(false));
            let s2 = salio.clone();
            let mut term = lanza_comando(&dir, piped, comando, move || s2.store(true, Ordering::SeqCst)).expect("lanzamiento");
            let raiz = ultimo_pid().expect("pid");
            assert!(espera_muerto(raiz), "la raíz salió por sí sola (piped={piped})");
            let huerfanos = miembros_huerfanos(raiz);
            assert!(!huerfanos.is_empty(), "el proceso en segundo plano sigue en el grupo de la raíz muerta (piped={piped})");
            if piped {
                assert!(!salio.load(Ordering::SeqCst), "retiene las tuberías: on_exit no puede haber llegado");
            }
            // Antes de la reparación esto daba `Err` para siempre: la raíz ya estaba reapeada y nada se había anotado.
            term.try_kill().unwrap_or_else(|e| panic!("(piped={piped}) {e}"));
            for h in &huerfanos {
                assert!(espera_muerto(*h), "el huérfano {h} murió (piped={piped})");
            }
            let limite = Instant::now() + Duration::from_secs(15);
            while !salio.load(Ordering::SeqCst) && Instant::now() < limite {
                thread::sleep(Duration::from_millis(50));
            }
            assert!(salio.load(Ordering::SeqCst), "y con el huérfano muerto el hilo de espera termina y avisa (piped={piped})");
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// Windows, procesos de verdad: el Job Object de la raíz se crea también en los lanzamientos reales (ConPTY de
/// portable-pty y tuberías), no solo con un `Command` suelto. El nieto que deja la raíz al salir tiene el `ppid` colgando:
/// solo el Job lo conoce, así que si no estuviera el kill no lo encontraría.
#[cfg(all(test, windows))]
mod job_en_los_lanzamientos_reales {
    use super::pruebas::*;
    use super::*;

    /// Pids de los `ping.exe` de esta prueba, reconocidos por su cuenta de paquetes `marca` (sin tocar otras pruebas que
    /// también lanzan `ping`).
    fn pings_con(marca: &str) -> Vec<u32> {
        powershell(&format!("Get-CimInstance Win32_Process | Where-Object {{ $_.Name -eq 'PING.EXE' -and $_.CommandLine -like '*-n {marca} 127.0.0.1*' }} | ForEach-Object {{ $_.ProcessId }}"))
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect()
    }

    fn powershell(script: &str) -> String {
        let mut cmd = std::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        String::from_utf8_lossy(&hide_console(&mut cmd).output().expect("powershell").stdout).into_owned()
    }

    /// Si la prueba falla a medias, el `ping` huérfano no puede quedarse vivo (y reteniendo las tuberías de `cargo test`).
    struct LimpiaPings(&'static str);

    impl Drop for LimpiaPings {
        fn drop(&mut self) {
            for pid in pings_con(self.0) {
                powershell(&format!("Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue"));
            }
        }
    }

    fn espera_pings(marca: &str) -> Vec<u32> {
        let limite = Instant::now() + Duration::from_secs(20);
        loop {
            let p = pings_con(marca);
            if !p.is_empty() || Instant::now() > limite {
                return p;
            }
            thread::sleep(Duration::from_millis(250));
        }
    }

    #[test]
    fn el_nieto_huerfano_de_un_lanzamiento_real_muere_con_el_job_de_la_raiz() {
        for (piped, marca) in [(true, "117"), (false, "118")] {
            let _limpia = LimpiaPings(marca);
            let dir = carpeta(&format!("job-{piped}"));
            let cwd = dir.to_string_lossy().into_owned();
            // Un `cmd` INTERMEDIO lanza el ping y sale; el script termina y la raíz sale también: el ping queda con el `ppid`
            // colgando de un pid que no es el de la raíz (el recorrido por `ppid` no lo ve; solo lo conoce el Job).
            let comando = format!("cmd /C \"start \"\" /B ping -n {marca} 127.0.0.1 >nul\"");
            let mut term = spawn(Launch { cwd: &cwd, script_dir: &dir.join("s"), command: comando, env: vec![], inject: None, piped, owner: None }, |_| {}, || {}).expect("lanzamiento");
            let raiz = ultimo_pid().expect("pid");
            let nietos = espera_pings(marca);
            assert!(!nietos.is_empty(), "el ping huérfano llegó a arrancar (piped={piped})");
            assert!(espera_muerto(raiz), "la raíz (cmd) salió dejando al nieto (piped={piped})");
            term.try_kill().unwrap_or_else(|e| panic!("(piped={piped}) {e}"));
            for n in &nietos {
                assert!(espera_muerto(*n), "el nieto {n} (ppid colgando) murió con el Job de la raíz (piped={piped})");
            }
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[cfg(test)]
mod custodia_y_verificacion {
    use super::pruebas::*;
    use super::{in_custody, ps_alive, reap_unowned_where, resolve_custody, tasklist_alive, unowned};

    fn pids_en_custodia() -> Vec<u32> {
        unowned().iter().filter_map(|u| u.pid).collect()
    }

    /// Reintenta SOLO el proceso `pid` (otras pruebas comparten la custodia, que es global).
    fn reintenta(pid: u32) -> usize {
        reap_unowned_where(|p| p == Some(pid))
    }

    #[test]
    fn si_ningun_matador_funciona_el_proceso_queda_en_custodia_y_se_mata_al_reintentar() {
        let _serie = serie_custodia();
        for piped in [false, true] {
            let dir = carpeta(&format!("custodia-{piped}"));
            let r = con_fallo_tras_crear(|| con_matadores_rotos(|| lanza(&dir, piped)));
            let pid = ultimo_pid().expect("el proceso llegó a crearse");
            let e = r.err().expect("el lanzamiento falla");
            assert!(e.contains("inyectado") && e.contains("custodia"), "el error dice qué pasó con el proceso: {e}");
            assert!(pids_en_custodia().contains(&pid), "un proceso que no se pudo matar no se suelta (piped={piped})");
            if piped {
                // Sin master PTY que se cierre al soltarlo, solo un kill explícito puede acabar con él.
                assert!(vivo(pid), "el proceso canalizado sigue vivo: la custodia es lo único que lo posee");
            }
            // El control se recupera: el reintento lo mata y lo saca de la custodia.
            reintenta(pid);
            assert!(espera_muerto(pid), "el reintento lo mata (piped={piped})");
            assert!(!pids_en_custodia().contains(&pid), "y deja la custodia (piped={piped})");
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn un_reintento_que_vuelve_a_fallar_no_pierde_la_custodia() {
        let _serie = serie_custodia();
        let dir = carpeta("custodia-reintento");
        let _ = con_fallo_tras_crear(|| con_matadores_rotos(|| lanza(&dir, true)));
        let pid = ultimo_pid().expect("pid");
        // El killer de la custodia es el real (`TreeKiller`): para simular que sigue fallando se retira el pid
        // del filtro (no se toca) y se comprueba que un reintento ajeno no la vacía.
        reintenta(pid.wrapping_add(1));
        assert!(pids_en_custodia().contains(&pid), "un reintento que no la alcanza no la pierde");
        reintenta(pid);
        assert!(espera_muerto(pid));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn la_custodia_se_resuelve_por_la_tarea_dueña_y_solo_mata_cuando_el_matador_funciona() {
        let _serie = serie_custodia();
        let dir = carpeta("custodia-dueno");
        let dueno = "t-custodia-dueno";
        let r = con_fallo_tras_crear(|| con_matadores_rotos(|| lanza_para(&dir, true, Some(dueno))));
        let pid = ultimo_pid().expect("pid");
        assert!(r.err().is_some_and(|e| e.contains("custodia")));
        assert!(in_custody(dueno) && vivo(pid));
        // Otra tarea no puede resolver ni ver la custodia ajena.
        assert!(resolve_custody("otra-tarea").is_none() && !in_custody("otra-tarea"));
        // Sin control fiable: se informa, el proceso sigue vivo y sigue en custodia.
        assert!(matches!(con_matadores_rotos(|| resolve_custody(dueno)), Some(Err(_))));
        assert!(in_custody(dueno) && vivo(pid), "un kill que no se pudo confirmar no libera la custodia");
        // Con control: se mata, sale de la custodia y no queda nada que resolver.
        assert!(matches!(resolve_custody(dueno), Some(Ok(()))));
        assert!(espera_muerto(pid) && !in_custody(dueno));
        assert!(resolve_custody(dueno).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn si_el_matador_funciona_no_queda_nada_en_custodia() {
        let _serie = serie_custodia();
        for piped in [false, true] {
            let dir = carpeta(&format!("sin-custodia-{piped}"));
            let r = con_fallo_tras_crear(|| lanza(&dir, piped));
            let pid = ultimo_pid().expect("pid");
            assert!(matches!(&r, Err(e) if e.contains("inyectado") && !e.contains("custodia")), "{:?}", r.err());
            assert!(espera_muerto(pid));
            assert!(!pids_en_custodia().contains(&pid), "compensado: nada que custodiar (piped={piped})");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn el_apagado_del_core_reintenta_matar_los_procesos_en_custodia() {
        let _serie = serie_custodia();
        let dir = carpeta("custodia-apagado");
        let _ = con_fallo_tras_crear(|| con_matadores_rotos(|| lanza(&dir, true)));
        let pid = ultimo_pid().expect("pid");
        assert!(pids_en_custodia().contains(&pid) && vivo(pid));
        crate::orch::Orch::default().0.shutdown();
        assert!(espera_muerto(pid), "shutdown lo mata");
        assert!(!pids_en_custodia().contains(&pid));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tasklist_que_falla_no_prueba_que_el_proceso_haya_muerto() {
        // Salida vacía con éxito: la herramienta dice que no hay filas -> muerto.
        assert!(!tasklist_alive(true, "INFO: No tasks are running which match the specified criteria.\r\n", 4242));
        assert!(!tasklist_alive(true, "", 4242));
        // Salida vacía con fallo de la herramienta: NO prueba nada -> vivo.
        assert!(tasklist_alive(false, "", 4242), "tasklist falló: ante la duda, vivo");
        // La fila nombra al proceso -> vivo.
        assert!(tasklist_alive(true, "cmd.exe                      4242 Console                    1      3.512 K\r\n", 4242));
        // Otro pid en la fila no cuenta.
        assert!(!tasklist_alive(true, "cmd.exe                      42420 Console                   1      3.512 K\r\n", 4242));
    }

    #[test]
    fn ps_que_falla_no_prueba_que_el_proceso_haya_muerto() {
        assert!(!ps_alive(Some(1), ""), "ps sale con 1 cuando ningún proceso coincide -> muerto");
        assert!(ps_alive(Some(127), ""), "ps no pudo ejecutarse bien: vivo");
        assert!(ps_alive(None, ""), "ps murió por una señal: vivo");
        assert!(ps_alive(Some(0), "S"), "dormido -> vivo");
        assert!(!ps_alive(Some(0), "Z+"), "un zombi pendiente de wait cuenta como muerto");
    }
}
