//! Árbol de procesos de un agente: tabla del sistema, identidad de cada proceso y kill verificado de TODO el árbol.
//! Lo usa `orch::pty` (`TreeKiller`). Vive fuera de `orch/` porque no tiene que ver con la frontera del almacén (la
//! guardia de `mutation_tests` limita Win32 a `fsio.rs` por la publicación durable, no por esto).
//!
//! Un pid NO identifica un proceso: se reutiliza. La identidad es `(pid, hora de creación)` ([`Proc`]). Reglas:
//! * solo se mata un proceso cuya hora de creación se comprueba JUSTO antes (en Windows con el mismo handle con el que
//!   se termina, así que no hay ventana entre comprobar y matar; en Unix la ventana es la de dos llamadas seguidas);
//! * un proceso al que se verificó muerto (ausente, o presente con otra hora de creación) sale de `seen` y no se vuelve
//!   a tocar nunca; la raíz verificada muerta no se vuelve a usar como origen de descendientes;
//! * donde la hora de creación es un instante real y comparable (Windows, `ordered_starts`), un hijo solo cuelga de un
//!   padre si no es anterior a él (`start(hijo) >= start(padre)`). En Unix la identidad es un TOKEN opaco (igualdad, nunca
//!   orden): ahí el `ppid` de un proceso vivo es siempre su padre vivo (los huérfanos se reparentan), así que ese filtro
//!   no hace falta y compararlo por orden saltaría descendientes vivos;
//! * la descendencia se localiza por TRES vías que se refuerzan, porque el recorrido por `ppid` no ve a un nieto cuyo
//!   padre intermedio ya salió (en Unix se reparenta a init; en Windows su `ppid` queda colgando):
//!   1. recorrido por `ppid` desde la raíz y desde cada descendiente ya rastreado;
//!   2. Windows: la raíz entra en un Job Object al crearla (solo si el proceso abierto tiene la MISMA hora de creación
//!      que la capturada, para que un pid reutilizado nunca meta a un ajeno en un job que luego se termina) y el job da
//!      la lista autoritativa de sus procesos vivos;
//!   3. Unix: la raíz es líder de su propio grupo de procesos (`process_group(0)` al lanzar; la PTY hace `setsid`) y los
//!      procesos con ese `pgid` se leen en UNA instantánea de `ps` junto a su token de identidad. El número de grupo solo
//!      está reservado mientras el grupo tiene miembros, así que solo se descubre por `pgid` si un proceso que YA
//!      rastreamos (identidad verificada en esa ronda) sigue dentro en esa misma lectura; con miembros y sin ese ancla
//!      (p. ej. la raíz murió antes del primer kill y nada se había anotado) no se puede probar que el número siga
//!      siendo nuestro y se falla CERRADO en vez de arriesgar un kill ajeno. Cada miembro se mata con `terminate(Proc)`
//!      (identidad comprobada justo antes), nunca con `kill(-pgid)`;
//!   Residual común: un proceso que se desvincula a propósito (`setsid`/`setpgid` a otro grupo, daemonización) tras
//!   perder a su padre queda fuera de las tres vías; no se puede rastrear sin un contenedor del sistema (cgroups/jobs).
//! * ante la duda (la tabla no se puede leer, parece vacía o truncada, no se puede probar la identidad) se falla
//!   CERRADO: `Err` y el proceso sigue en custodia.

use std::time::Duration;

/// Identidad de un proceso: su pid y el instante de su creación (unidad opaca, solo comparable consigo misma).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Proc {
    pub pid: u32,
    pub start: u64,
}

/// Qué pasó al intentar terminar un proceso concreto.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Fate {
    /// Se ordenó terminar y la identidad coincidía.
    Killed,
    /// Ya no existía, o ese pid pertenece ahora a OTRO proceso: no se tocó.
    Gone,
    /// No se pudo probar la identidad ni terminarlo.
    Unknown,
}

/// El sistema operativo, tal como lo necesita el kill del árbol (inyectable para probar cada carrera sin procesos reales).
pub(crate) trait Os {
    /// Tabla `(pid, ppid)` de los procesos vivos, o `None` si no se pudo leer o no es fiable.
    fn table(&mut self) -> Option<Vec<(u32, u32)>>;
    /// Hora de creación de `pid`, o `None` si no existe o no se pudo consultar.
    fn start(&mut self, pid: u32) -> Option<u64>;
    /// Termina `p` SOLO si su identidad coincide en este instante.
    fn terminate(&mut self, p: Proc) -> Fate;
    /// Pausa entre rondas: el sistema tarda en retirar lo recién terminado.
    fn settle(&mut self) {}
    /// ¿Es `start` un instante real, de modo que un hijo nunca es anterior a su padre? Si no (token opaco), solo se
    /// compara por igualdad.
    fn ordered_starts(&self) -> bool {
        true
    }
    /// Mete el proceso recién creado `pid` en un grupo que contendrá a todos sus descendientes futuros. `start` es la
    /// hora de creación capturada para `pid`: solo se adjunta si el proceso que se abre ahora tiene EXACTAMENTE esa
    /// identidad (si el pid se hubiera reutilizado, un ajeno acabaría en un grupo que luego se termina). `None` si el
    /// sistema no lo ofrece, falla o la identidad no coincide (se sigue solo con el escaneo, sin fingir más garantía).
    fn make_group(&mut self, _pid: u32, _start: Option<u64>) -> Option<std::sync::Arc<dyn Group>> {
        None
    }
    /// Unix: ¿`pid` es líder de su propio grupo de procesos (`pgid == pid`)? Solo entonces el grupo es suyo y de su
    /// descendencia; si el lanzamiento no lo dejó como líder (compartiría el grupo de Lixbon) no se usa.
    fn leads_group(&mut self, _pid: u32) -> bool {
        false
    }
    /// Unix: procesos vivos (no zombis) del grupo `pgid`, con su identidad, de UNA sola lectura (el `pgid` y el token de
    /// cada fila salen de la misma instantánea). `None` = no fiable (la duda es un error).
    fn group_rows(&mut self, _pgid: u32) -> Option<Vec<Proc>> {
        None
    }
}

/// Los procesos de un árbol según el propio sistema (Job Object): no depende de pids reutilizables ni de `ppid`.
pub(crate) trait Group: Send + Sync + std::fmt::Debug {
    /// Pids de los procesos VIVOS del grupo, o `None` si no se pudo consultar (la duda es un error).
    fn members(&self) -> Option<Vec<u32>>;
    /// Ordena terminar todos los procesos del grupo. `false` si no se pudo.
    fn terminate(&self) -> bool;
}

/// Rondas máximas (descubrir, matar, comprobar). Con la pausa de 50 ms de [`RealOs`] son ~1 s en total.
const ROUNDS: usize = 20;

/// Lo que se sabe del árbol de un agente. Se conserva entre intentos (custodia, reintentos).
#[derive(Clone, Debug)]
pub(crate) struct Tree {
    pid: u32,
    /// Hora de creación de la raíz tomada al crearla; `None` = no se pudo probar su identidad.
    start: Option<u64>,
    /// La raíz se verificó muerta (o su pid es de otro): nunca más se usa como origen de descendientes.
    root_dead: bool,
    seen: Vec<Proc>,
    /// Pids presentes cuya identidad no se pudo consultar al descubrirlos: mientras sigan en la tabla, el árbol no se
    /// da por muerto (la duda es un error), aunque su padre ya haya desaparecido.
    unproven: Vec<u32>,
    /// El grupo del sistema que contiene a toda la descendencia (si se pudo crear).
    group: Option<std::sync::Arc<dyn Group>>,
    /// Unix: el número de grupo de procesos de la raíz (que es su líder). Ver la cabecera del módulo.
    pgid: Option<u32>,
}

impl Tree {
    /// Anota la raíz recién creada (su pid es seguro: acaba de crearse). Si ya no existe, nace verificada muerta.
    pub(crate) fn capture(os: &mut dyn Os, pid: u32) -> Tree {
        let start = os.start(pid);
        let group = os.make_group(pid, start);
        let pgid = os.leads_group(pid).then_some(pid);
        let gone = start.is_none() && os.table().is_some_and(|t| !t.iter().any(|(p, _)| *p == pid));
        Tree { pid, start, root_dead: gone, seen: Vec::new(), unproven: Vec::new(), group, pgid }
    }

    #[cfg(test)]
    pub(crate) fn seen(&self) -> &[Proc] {
        &self.seen
    }

    #[cfg(test)]
    pub(crate) fn root_dead(&self) -> bool {
        self.root_dead
    }

    /// Prueba: los procesos vivos del grupo del sistema (`None` si no hay grupo o no se pudo consultar).
    #[cfg(test)]
    pub(crate) fn group_members(&self) -> Option<Vec<u32>> {
        self.group.as_ref()?.members()
    }
}

fn fail(msg: String) -> std::io::Error {
    std::io::Error::other(msg)
}

/// Mata el árbol de `t` y comprueba su muerte. `Ok` solo tras una ronda COMPLETA en la que ningún proceso del árbol
/// (verificado por identidad) sigue vivo y no apareció ninguno nuevo; si el árbol cambia sin parar o algo no se puede
/// probar, `Err` tras [`ROUNDS`] rondas.
pub(crate) fn kill_tree(t: &mut Tree, os: &mut dyn Os) -> std::io::Result<()> {
    let mut last = String::from("sin intentos");
    let ordered = os.ordered_starts();
    for _ in 0..ROUNDS {
        let table = os.table().ok_or_else(|| fail(format!("no se pudo leer la tabla de procesos fiable del árbol de {}", t.pid)))?;
        let present = |pid: u32| table.iter().any(|(p, _)| *p == pid);

        // 1) Los ya vistos: los verificados muertos (ausentes, o con otro dueño del pid) salen para siempre.
        let mut unproven = false;
        let mut alive: Vec<Proc> = Vec::new();
        for p in std::mem::take(&mut t.seen) {
            if !present(p.pid) {
                continue;
            }
            match os.start(p.pid) {
                Some(s) if s != p.start => {} // el pid se reutilizó: el original murió
                Some(_) => alive.push(p),
                None => {
                    unproven = true;
                    alive.push(p); // presente y sin identidad probable: se conserva, y el éxito queda vetado
                }
            }
        }

        // 2) La raíz.
        let mut parents = alive.clone();
        let mut adopt_orphans = false;
        let root = t.start.map(|start| Proc { pid: t.pid, start });
        let mut root_alive = false;
        if !t.root_dead {
            match (present(t.pid), root) {
                (false, _) => {
                    t.root_dead = true;
                    adopt_orphans = true;
                }
                (true, None) => return Err(fail(format!("no se puede probar la identidad del proceso raíz {}: se conserva", t.pid))),
                (true, Some(r)) => match os.start(t.pid) {
                    Some(s) if s == r.start => root_alive = true,
                    Some(_) => t.root_dead = true, // pid reutilizado: no hay huérfanos que adoptar con seguridad
                    None => {
                        unproven = true;
                        root_alive = true;
                    }
                },
            }
        }
        if root_alive {
            parents.extend(root);
        }

        // 3) Descubrimiento: hijos (transitivos) de los padres vivos, o los huérfanos de una raíz que acaba de morir.
        let mut found = false;
        let mut queue: Vec<Proc> = parents.clone();
        // Adoptar los huérfanos de una raíz muerta se apoya en `start(hijo) >= start(raíz)`: sin instantes reales no se hace.
        if adopt_orphans && ordered {
            queue.extend(root);
        }
        while let Some(parent) = queue.pop() {
            for &(pid, ppid) in &table {
                if ppid != parent.pid || pid == 0 || pid == parent.pid || pid == t.pid || alive.iter().any(|p| p.pid == pid) {
                    continue;
                }
                match os.start(pid) {
                    Some(s) if !ordered || s >= parent.start => {
                        let child = Proc { pid, start: s };
                        alive.push(child);
                        queue.push(child);
                        t.unproven.retain(|u| *u != pid);
                        found = true;
                    }
                    Some(_) => {} // anterior a su supuesto padre: su padre real era otro proceso con ese pid
                    None => {
                        if !t.unproven.contains(&pid) {
                            t.unproven.push(pid);
                        }
                    }
                }
            }
        }

        t.unproven.retain(|u| present(*u));
        unproven |= !t.unproven.is_empty();

        // 3b) El grupo del sistema: autoritativo para lo que el escaneo no ve (huérfanos de un padre intermedio que ya salió).
        let mut group_alive = false;
        if let Some(g) = &t.group {
            match g.members() {
                None => unproven = true,
                Some(m) if m.is_empty() => {}
                Some(_) => {
                    group_alive = true;
                    // El resultado de `terminate` no se mira a propósito: con miembros vivos `group_alive` ya impide el éxito
                    // en esta ronda, y solo una lectura posterior con el grupo VACÍO prueba que murieron.
                    let _ = g.terminate();
                }
            }
        }

        // 3c) Unix: los procesos del grupo de la raíz (incluidos los reparentados a init). Solo con ancla: ver la cabecera.
        if let Some(g) = t.pgid {
            match os.group_rows(g) {
                None => unproven = true,
                Some(rows) => {
                    let anchored = rows.iter().any(|r| alive.contains(r) || (root_alive && Some(*r) == root));
                    if !rows.is_empty() && !anchored {
                        unproven = true;
                    } else {
                        for r in rows {
                            if r.pid != t.pid && !alive.contains(&r) {
                                alive.push(r);
                                found = true;
                            }
                        }
                    }
                }
            }
        }

        // 4) Terminar todo lo vivo, cada uno comprobando su identidad en el momento de matarlo.
        let targets: Vec<Proc> = parents.iter().copied().chain(alive.iter().copied()).fold(Vec::new(), |mut v, p| {
            if !v.contains(&p) {
                v.push(p);
            }
            v
        });
        for p in &targets {
            if os.terminate(*p) == Fate::Unknown {
                unproven = true;
            }
        }
        t.seen = alive;
        if targets.is_empty() && !found && !unproven && !group_alive {
            return Ok(());
        }
        last = format!("siguen vivos o sin probar: {:?}", targets.iter().map(|p| p.pid).collect::<Vec<_>>());
        os.settle();
    }
    Err(fail(format!("no se pudo matar todo el árbol del proceso {}: {last}", t.pid)))
}

/// Valida una tabla recién leída: vacía, o sin el propio proceso, es una lectura truncada o inesperada, no «no hay
/// nadie». `None` = no fiable.
pub(crate) fn validated(table: Vec<(u32, u32)>, own_pid: u32) -> Option<Vec<(u32, u32)>> {
    (!table.is_empty() && table.iter().any(|(p, _)| *p == own_pid)).then_some(table)
}

/// El sistema real.
pub(crate) struct RealOs;

impl Os for RealOs {
    fn table(&mut self) -> Option<Vec<(u32, u32)>> {
        process_table()
    }

    fn start(&mut self, pid: u32) -> Option<u64> {
        start_time(pid)
    }

    fn terminate(&mut self, p: Proc) -> Fate {
        terminate(p)
    }

    fn settle(&mut self) {
        std::thread::sleep(Duration::from_millis(50));
    }

    fn ordered_starts(&self) -> bool {
        cfg!(windows)
    }

    fn make_group(&mut self, pid: u32, start: Option<u64>) -> Option<std::sync::Arc<dyn Group>> {
        make_group(pid, start)
    }

    fn leads_group(&mut self, pid: u32) -> bool {
        leads_group(pid)
    }

    fn group_rows(&mut self, pgid: u32) -> Option<Vec<Proc>> {
        group_rows(pgid)
    }
}

/// Windows: un Job Object sin límites (nada se mata al soltarlo ni se impide escapar a nadie: solo contabiliza).
#[cfg(windows)]
fn make_group(pid: u32, start: Option<u64>) -> Option<std::sync::Arc<dyn Group>> {
    win::Job::attach(pid, start).map(|j| std::sync::Arc::new(j) as std::sync::Arc<dyn Group>)
}

/// Unix: no hay Job Object; el grupo de procesos (`leads_group` + `group_rows`) cumple ese papel.
#[cfg(not(windows))]
fn make_group(_pid: u32, _start: Option<u64>) -> Option<std::sync::Arc<dyn Group>> {
    None
}

/// ¿Puede adjuntarse al grupo el proceso abierto? Solo si su hora de creación es EXACTAMENTE la capturada al crearlo; sin
/// identidad capturada (o distinta) el pid podría ser de otro proceso.
#[cfg_attr(not(windows), allow(dead_code))]
fn may_attach(captured: Option<u64>, opened: Option<u64>) -> bool {
    captured.is_some() && captured == opened
}

/// Token opaco de una cadena `lstart` (varios espacios entre campos, p. ej. «Oct  5»): FNV-1a de la cadena normalizada.
/// Solo se compara por IGUALDAD; su orden numérico no dice nada del orden en el tiempo.
#[cfg_attr(windows, allow(dead_code))]
fn lstart_token(lstart: &str) -> Option<u64> {
    let norm = lstart.split_whitespace().collect::<Vec<_>>().join(" ");
    (!norm.is_empty()).then(|| norm.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)))
}

/// Una fila de `ps -e -o pid=,ppid=,pgid=,stat=,lstart=`.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(windows, allow(dead_code))]
struct PsRow {
    pid: u32,
    ppid: u32,
    pgid: u32,
    zombie: bool,
    start: u64,
}

/// Lee la salida de `ps`. Una fila que no se entiende (campos que faltan, `lstart` sin sus 5 campos) hace dudosa TODA la
/// lectura: `None`.
#[cfg_attr(windows, allow(dead_code))]
fn parse_ps_rows(text: &str) -> Option<Vec<PsRow>> {
    let mut out = Vec::new();
    for l in text.lines().filter(|l| !l.trim().is_empty()) {
        let mut f = l.split_whitespace();
        let (pid, ppid, pgid): (u32, u32, u32) = (f.next()?.parse().ok()?, f.next()?.parse().ok()?, f.next()?.parse().ok()?);
        let stat = f.next()?;
        let lstart: Vec<&str> = f.collect();
        if lstart.len() != 5 {
            return None;
        }
        out.push(PsRow { pid, ppid, pgid, zombie: stat.starts_with('Z'), start: lstart_token(&lstart.join(" "))? });
    }
    Some(out)
}

/// Tabla `(pid, ppid)` de los procesos vivos, o `None` si no se pudo leer o no es fiable (vacía, sin este proceso,
/// recorrido interrumpido antes del final).
pub(crate) fn process_table() -> Option<Vec<(u32, u32)>> {
    validated(raw_table()?, std::process::id())
}

#[cfg(windows)]
fn raw_table() -> Option<Vec<(u32, u32)>> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    const ERROR_NO_MORE_FILES: u32 = 18;
    // SAFETY: llamadas FFI con una estructura inicializada a cero y `dwSize` fijado; el handle se cierra siempre.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut out = Vec::new();
        let mut complete = Process32FirstW(snap, &mut entry) != 0;
        while complete {
            out.push((entry.th32ProcessID, entry.th32ParentProcessID));
            if Process32NextW(snap, &mut entry) == 0 {
                // Solo «no hay más» es un final legítimo; cualquier otro error deja la lectura truncada.
                complete = false;
                if GetLastError() != ERROR_NO_MORE_FILES {
                    CloseHandle(snap);
                    return None;
                }
            }
        }
        CloseHandle(snap);
        Some(out)
    }
}

/// `ps` en un entorno fijo (`LC_ALL=C`): el token de `lstart` debe salir igual en todas las lecturas.
#[cfg(not(windows))]
fn ps_output(args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("ps");
    cmd.args(args).env("LC_ALL", "C");
    let o = crate::hide_console(&mut cmd).output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&o.stdout).into_owned())
}

#[cfg(not(windows))]
fn ps_rows() -> Option<Vec<PsRow>> {
    let rows = parse_ps_rows(&ps_output(&["-e", "-o", "pid=,ppid=,pgid=,stat=,lstart="])?)?;
    // Sin este proceso la lectura está truncada o es inesperada.
    rows.iter().any(|r| r.pid == std::process::id()).then_some(rows)
}

#[cfg(not(windows))]
fn raw_table() -> Option<Vec<(u32, u32)>> {
    // Un zombi pendiente de `wait` cuenta como muerto, pero el propio proceso sigue contando para validar.
    Some(ps_rows()?.into_iter().filter(|r| !r.zombie || r.pid == std::process::id()).map(|r| (r.pid, r.ppid)).collect())
}

#[cfg(not(windows))]
fn group_rows(pgid: u32) -> Option<Vec<Proc>> {
    Some(ps_rows()?.into_iter().filter(|r| r.pgid == pgid && !r.zombie).map(|r| Proc { pid: r.pid, start: r.start }).collect())
}

#[cfg(windows)]
fn group_rows(_pgid: u32) -> Option<Vec<Proc>> {
    None
}

#[cfg(not(windows))]
fn leads_group(pid: u32) -> bool {
    ps_output(&["-o", "pgid=", "-p", &pid.to_string()]).and_then(|t| t.trim().parse::<u32>().ok()) == Some(pid)
}

#[cfg(windows)]
fn leads_group(_pid: u32) -> bool {
    false
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, FILETIME, HANDLE};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicProcessIdList, QueryInformationJobObject, TerminateJobObject};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, GetProcessTimes, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    const STILL_ACTIVE: u32 = 259;
    const ERROR_INVALID_PARAMETER: u32 = 87;

    /// Handle que se cierra al soltarse.
    pub struct Handle(HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            // SAFETY: handle válido y propio.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub enum Open {
        Ok(Handle),
        NoSuchProcess,
        Denied,
    }

    pub fn open(pid: u32, access: u32) -> Open {
        // SAFETY: FFI sin punteros.
        let h = unsafe { OpenProcess(access, 0, pid) };
        if h == 0 {
            // SAFETY: FFI sin punteros.
            return if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER { Open::NoSuchProcess } else { Open::Denied };
        }
        Open::Ok(Handle(h))
    }

    pub fn creation(h: &Handle) -> Option<u64> {
        let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let (mut created, mut a, mut b, mut c) = (zero, zero, zero, zero);
        // SAFETY: punteros a estructuras locales válidas.
        let ok = unsafe { GetProcessTimes(h.0, &mut created, &mut a, &mut b, &mut c) };
        (ok != 0).then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    pub fn still_active(h: &Handle) -> Option<bool> {
        let mut code = 0u32;
        // SAFETY: puntero a una variable local válida.
        let ok = unsafe { GetExitCodeProcess(h.0, &mut code) };
        (ok != 0).then_some(code == STILL_ACTIVE)
    }

    pub fn terminate(h: &Handle) -> bool {
        // SAFETY: handle válido con PROCESS_TERMINATE.
        unsafe { TerminateProcess(h.0, 1) != 0 }
    }

    /// Job Object con la raíz dentro. Los hijos que cree la raíz DESPUÉS de entrar heredan el job (sin
    /// `BREAKAWAY_OK` no hay forma de salir), aunque su padre intermedio ya haya terminado.
    #[derive(Debug)]
    pub struct Job(HANDLE);

    // SAFETY: un HANDLE de job es un entero opaco que el sistema permite usar desde cualquier hilo.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        /// Mete a `pid` en un job nuevo SOLO si el proceso que se abre ahora (el mismo handle que se asigna) tiene la hora
        /// de creación `expected` capturada al crearlo: así un pid reutilizado entre la captura y la apertura nunca
        /// pone a un proceso ajeno en un job que `kill_tree` termina. Sin identidad capturada no se adjunta.
        pub fn attach(pid: u32, expected: Option<u64>) -> Option<Job> {
            let access = PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
            let Open::Ok(h) = open(pid, access) else { return None };
            if !super::may_attach(expected, creation(&h)) {
                return None;
            }
            // SAFETY: FFI; los atributos nulos significan los de por defecto; el handle de proceso sigue abierto (ancla el pid).
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job == 0 {
                    return None;
                }
                let job = Job(job);
                (AssignProcessToJobObject(job.0, h.0) != 0).then_some(job)
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: handle válido y propio.
            unsafe { CloseHandle(self.0) };
        }
    }

    #[repr(C)]
    struct IdList {
        assigned: u32,
        listed: u32,
        ids: [usize; 256],
    }

    impl super::Group for Job {
        fn members(&self) -> Option<Vec<u32>> {
            // SAFETY: estructura local con el tamaño que se declara.
            unsafe {
                let mut l: IdList = std::mem::zeroed();
                let ok = QueryInformationJobObject(self.0, JobObjectBasicProcessIdList, std::ptr::addr_of_mut!(l).cast(), std::mem::size_of::<IdList>() as u32, std::ptr::null_mut());
                // Con más procesos de los que caben (ERROR_MORE_DATA) el recuento sigue siendo válido.
                if ok == 0 && GetLastError() != 234 {
                    return None;
                }
                let mut v: Vec<u32> = l.ids.iter().take(l.listed as usize).map(|p| *p as u32).collect();
                v.resize(l.assigned as usize, 0);
                Some(v)
            }
        }

        fn terminate(&self) -> bool {
            // SAFETY: handle de job válido.
            unsafe { TerminateJobObject(self.0, 1) != 0 }
        }
    }

    pub const QUERY: u32 = PROCESS_QUERY_LIMITED_INFORMATION;
    pub const KILL: u32 = PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
}

#[cfg(windows)]
fn start_time(pid: u32) -> Option<u64> {
    match win::open(pid, win::QUERY) {
        win::Open::Ok(h) => win::creation(&h),
        _ => None,
    }
}

/// En Windows se abre el proceso UNA vez, se compara su hora de creación y se termina con ese MISMO handle: mientras
/// el handle esté abierto el pid no puede reutilizarse, así que no hay ventana entre comprobar y matar.
#[cfg(windows)]
fn terminate(p: Proc) -> Fate {
    match win::open(p.pid, win::KILL) {
        win::Open::NoSuchProcess => Fate::Gone,
        win::Open::Denied => Fate::Unknown,
        win::Open::Ok(h) => match win::creation(&h) {
            None => Fate::Unknown,
            Some(s) if s != p.start => Fate::Gone,
            Some(_) => match win::still_active(&h) {
                Some(false) => Fate::Gone,
                _ if win::terminate(&h) => Fate::Killed,
                _ => if win::still_active(&h) == Some(false) { Fate::Gone } else { Fate::Unknown },
            },
        },
    }
}

#[cfg(not(windows))]
fn start_time(pid: u32) -> Option<u64> {
    // La MISMA fuente (`lstart`) que las filas de `ps_rows`, para que los tokens de un proceso coincidan en todas las
    // vías de descubrimiento. Token opaco: `ordered_starts` es falso en Unix y `kill_tree` nunca lo ordena.
    lstart_token(&ps_output(&["-o", "lstart=", "-p", &pid.to_string()])?)
}

/// En Unix la identidad se comprueba justo antes de `kill -9`: son dos llamadas seguidas, no una sola operación (no hay
/// handle que ancle el pid sin pidfd). La ventana es de milisegundos, frente a la de horas que había al reintentar con
/// pids viejos.
#[cfg(not(windows))]
fn terminate(p: Proc) -> Fate {
    match start_time(p.pid) {
        Some(s) if s == p.start => {}
        Some(_) => return Fate::Gone,
        None => return if process_table().is_some_and(|t| !t.iter().any(|(q, _)| *q == p.pid)) { Fate::Gone } else { Fate::Unknown },
    }
    let mut cmd = std::process::Command::new("kill");
    cmd.args(["-9", &p.pid.to_string()]);
    match crate::hide_console(cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())).status() {
        Ok(s) if s.success() => Fate::Killed,
        _ => if start_time(p.pid).is_none_or(|s| s != p.start) { Fate::Gone } else { Fate::Unknown },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Un mundo de procesos de mentira, con los hooks justos para provocar cada carrera.
    #[derive(Default)]
    struct World {
        /// (pid, ppid, start, vivo)
        procs: Vec<(u32, u32, u64, bool)>,
        table_ok: bool,
        /// pids cuya hora de creación no se puede consultar.
        no_start: Vec<u32>,
        /// Pids terminados de verdad por `terminate`.
        killed: Vec<(u32, u64)>,
        /// Se ejecuta justo ANTES de cada `terminate` (para reutilizar un pid entre la comprobación y el kill).
        before_terminate: Option<Box<dyn FnMut(&mut Vec<(u32, u32, u64, bool)>, Proc)>>,
        /// Se ejecuta después de cada ronda de `terminate` (para que aparezcan procesos nuevos).
        on_settle: Option<Box<dyn FnMut(&mut Vec<(u32, u32, u64, bool)>)>>,
        /// Procesos que ignoran el kill (siguen vivos).
        immortal: Vec<u32>,
        /// La «hora de creación» es un token opaco (Unix): solo se compara por igualdad, su orden no significa nada.
        unordered: bool,
        /// Estado del grupo del sistema (Job Object) si el mundo ofrece uno.
        grp: Option<std::sync::Arc<std::sync::Mutex<Grp>>>,
        /// Unix: (pid, pgid) de cada proceso y si la raíz lidera su grupo.
        pg: Vec<(u32, u32)>,
        leader: bool,
        /// La lectura de las filas del grupo no es fiable.
        rows_unreadable: bool,
        /// Lo que `make_group` recibió como `start` (para comprobar que `capture` pasa la identidad capturada).
        group_start_seen: Option<Option<u64>>,
    }

    #[derive(Default, Debug)]
    struct Grp {
        /// Pids que el sistema contabiliza dentro del grupo (aunque su padre ya no exista).
        members: Vec<u32>,
        /// La consulta falla.
        unreadable: bool,
        /// Terminar el grupo falla.
        stuck: bool,
        terminated: bool,
        /// Terminar «funciona» pero los miembros no se van (el sistema no los retira).
        sticky: bool,
    }

    #[derive(Debug)]
    struct FakeGroup(std::sync::Arc<std::sync::Mutex<Grp>>);

    impl Group for FakeGroup {
        fn members(&self) -> Option<Vec<u32>> {
            let g = self.0.lock().unwrap();
            (!g.unreadable).then(|| g.members.clone())
        }

        fn terminate(&self) -> bool {
            let mut g = self.0.lock().unwrap();
            if g.stuck {
                return false;
            }
            g.terminated = true;
            true
        }
    }

    impl World {
        fn new(procs: &[(u32, u32, u64)]) -> World {
            World { procs: procs.iter().map(|&(p, pp, s)| (p, pp, s, true)).collect(), table_ok: true, ..Default::default() }
        }

        fn alive(&self, pid: u32) -> bool {
            self.procs.iter().any(|&(p, _, _, a)| p == pid && a)
        }
    }

    impl Os for World {
        fn ordered_starts(&self) -> bool {
            !self.unordered
        }

        fn make_group(&mut self, _pid: u32, start: Option<u64>) -> Option<std::sync::Arc<dyn Group>> {
            self.group_start_seen = Some(start);
            self.grp.clone().map(|g| std::sync::Arc::new(FakeGroup(g)) as std::sync::Arc<dyn Group>)
        }

        fn leads_group(&mut self, _pid: u32) -> bool {
            self.leader
        }

        fn group_rows(&mut self, pgid: u32) -> Option<Vec<Proc>> {
            if self.rows_unreadable {
                return None;
            }
            Some(self.procs.iter().filter(|p| p.3 && self.pg.iter().any(|&(pid, g)| pid == p.0 && g == pgid)).map(|p| Proc { pid: p.0, start: p.2 }).collect())
        }

        fn table(&mut self) -> Option<Vec<(u32, u32)>> {
            // Terminar el grupo mata a todos sus miembros, vean o no el escaneo.
            if let Some(g) = &self.grp {
                let mut g = g.lock().unwrap();
                if g.terminated && g.sticky {
                    g.terminated = false; // «terminado», pero los miembros siguen ahí
                } else if g.terminated {
                    let muertos = std::mem::take(&mut g.members);
                    g.terminated = false;
                    self.procs.iter_mut().filter(|p| muertos.contains(&p.0)).for_each(|p| p.3 = false);
                }
            }
            self.table_ok.then(|| self.procs.iter().filter(|p| p.3).map(|&(p, pp, _, _)| (p, pp)).collect())
        }

        fn start(&mut self, pid: u32) -> Option<u64> {
            if self.no_start.contains(&pid) {
                return None;
            }
            self.procs.iter().find(|p| p.0 == pid && p.3).map(|p| p.2)
        }

        fn terminate(&mut self, p: Proc) -> Fate {
            if let Some(mut hook) = self.before_terminate.take() {
                hook(&mut self.procs, p);
                self.before_terminate = Some(hook);
            }
            match self.procs.iter_mut().find(|q| q.0 == p.pid && q.3) {
                None => Fate::Gone,
                Some(q) if q.2 != p.start => Fate::Gone,
                Some(q) => {
                    if !self.immortal.contains(&p.pid) {
                        q.3 = false;
                        self.killed.push((p.pid, p.start));
                    }
                    Fate::Killed
                }
            }
        }

        fn settle(&mut self) {
            if let Some(mut hook) = self.on_settle.take() {
                hook(&mut self.procs);
                self.on_settle = Some(hook);
            }
        }
    }

    // pid raíz 10 (start 100) -> 11 (110) -> 12 (120); 20 ajeno (start 50).
    fn arbol() -> World {
        World::new(&[(1, 0, 1), (10, 1, 100), (11, 10, 110), (12, 11, 120), (20, 1, 50)])
    }

    fn captura(w: &mut World) -> Tree {
        Tree::capture(w, 10)
    }

    #[test]
    fn mata_todo_el_arbol_y_solo_el_arbol() {
        let mut w = arbol();
        let mut t = captura(&mut w);
        kill_tree(&mut t, &mut w).unwrap();
        assert!(!w.alive(10) && !w.alive(11) && !w.alive(12), "el árbol entero");
        assert!(w.alive(20) && w.alive(1), "y nada más");
    }

    #[test]
    fn la_tabla_no_fiable_o_ausente_falla_cerrado() {
        let mut w = arbol();
        let mut t = captura(&mut w);
        w.table_ok = false;
        assert!(kill_tree(&mut t, &mut w).is_err());
        assert!(w.alive(10), "no se mató nada sin poder leer la tabla");
    }

    #[test]
    fn una_tabla_vacia_truncada_o_sin_este_proceso_no_es_un_arbol_muerto() {
        assert!(validated(vec![], 7).is_none());
        assert!(validated(vec![(1, 0), (2, 1)], 7).is_none(), "sin el propio pid es una lectura truncada");
        assert!(validated(vec![(7, 1)], 7).is_some());
    }

    #[test]
    fn un_pid_raiz_reutilizado_por_un_proceso_ajeno_no_se_mata_ni_se_adopta() {
        // La raíz (10) murió hace horas y SU pid lo tiene ahora un programa del usuario, con un hijo propio (30).
        let mut w = arbol();
        let mut t = captura(&mut w);
        for p in w.procs.iter_mut().filter(|p| p.0 == 10 || p.0 == 11 || p.0 == 12) {
            p.3 = false;
        }
        w.procs.push((10, 1, 5_000, true));
        w.procs.push((30, 10, 5_100, true));
        kill_tree(&mut t, &mut w).unwrap();
        assert!(w.alive(10) && w.alive(30), "ni el nuevo dueño del pid ni su hijo se tocan");
        assert!(t.root_dead() && t.seen().is_empty());
        assert!(w.killed.is_empty());
    }

    #[test]
    fn un_descendiente_visto_cuyo_pid_se_reutiliza_se_poda_y_no_se_mata() {
        let mut w = arbol();
        let mut t = captura(&mut w);
        // Primera ronda: 12 sobrevive al kill (inmortal) y queda en `seen`.
        w.immortal.push(12);
        assert!(kill_tree(&mut t, &mut w).is_err());
        assert!(t.seen().iter().any(|p| p.pid == 12));
        // 12 por fin muere, y su pid lo reutiliza un proceso ajeno.
        w.immortal.clear();
        for p in w.procs.iter_mut().filter(|p| p.0 == 12) {
            p.3 = false;
        }
        w.procs.push((12, 1, 9_000, true));
        kill_tree(&mut t, &mut w).unwrap();
        assert!(w.alive(12), "el proceso ajeno que heredó el pid no se mata");
        assert!(t.seen().is_empty(), "y el viejo salió de `seen`");
    }

    #[test]
    fn el_pid_cambia_de_dueno_entre_la_comprobacion_y_el_kill() {
        let mut w = arbol();
        let mut t = captura(&mut w);
        // Justo antes de terminar a 12, muere y su pid pasa a un proceso ajeno.
        w.before_terminate = Some(Box::new(|procs, p| {
            if p.pid == 12 {
                procs.iter_mut().filter(|q| q.0 == 12).for_each(|q| q.3 = false);
                procs.push((12, 1, 7_777, true));
            }
        }));
        kill_tree(&mut t, &mut w).unwrap();
        assert!(w.alive(12) && w.killed.iter().all(|k| k.0 != 12 || k.1 != 7_777), "terminate comprueba la identidad al matar: el ajeno sobrevive");
    }

    #[test]
    fn lo_que_nace_durante_el_kill_se_descubre_y_se_mata() {
        let mut w = arbol();
        let mut t = captura(&mut w);
        // Tras la primera ronda, el nieto (inmortal por una vez) ya había creado un hijo nuevo.
        let mut nacido = false;
        w.on_settle = Some(Box::new(move |procs| {
            if !nacido {
                nacido = true;
                procs.push((40, 11, 400, true));
                procs.iter_mut().filter(|p| p.0 == 11).for_each(|p| p.3 = true);
            }
        }));
        kill_tree(&mut t, &mut w).unwrap();
        assert!(!w.alive(40), "el hijo nacido entre el descubrimiento y el kill también murió");
    }

    #[test]
    fn un_arbol_que_no_para_de_cambiar_falla_cerrado() {
        let mut w = arbol();
        let mut t = captura(&mut w);
        let mut n = 100;
        w.on_settle = Some(Box::new(move |procs| {
            n += 1;
            procs.push((n, 10, 10_000 + u64::from(n), true));
            procs.iter_mut().filter(|p| p.0 == 10).for_each(|p| p.3 = true);
        }));
        assert!(kill_tree(&mut t, &mut w).is_err(), "sin un instante estable no se declara muerto");
    }

    #[test]
    fn un_proceso_presente_cuya_identidad_no_se_puede_probar_falla_cerrado() {
        let mut w = arbol();
        let mut t = captura(&mut w);
        w.no_start.push(12);
        assert!(kill_tree(&mut t, &mut w).is_err());
    }

    #[test]
    fn los_huerfanos_de_una_raiz_que_acaba_de_morir_se_adoptan_si_no_son_anteriores_a_ella() {
        let mut w = arbol();
        let mut t = captura(&mut w);
        // La raíz murió antes de este intento y su hijo 11 quedó colgando de un ppid muerto; 21 es anterior a la raíz.
        w.procs.iter_mut().filter(|p| p.0 == 10).for_each(|p| p.3 = false);
        w.procs.push((21, 10, 60, true));
        kill_tree(&mut t, &mut w).unwrap();
        assert!(!w.alive(11) && !w.alive(12), "los descendientes de la raíz muerta se adoptan");
        assert!(w.alive(21), "uno más antiguo que la raíz no es suyo");
    }

    #[test]
    fn una_raiz_que_ya_no_existe_al_crear_el_killer_nace_verificada_muerta() {
        let mut w = arbol();
        let mut t = Tree::capture(&mut w, 2_000_000_001);
        assert!(t.root_dead());
        kill_tree(&mut t, &mut w).unwrap();
        assert!(w.killed.is_empty());
    }

    // --- Unix: la identidad es un token opaco; su orden numérico no es el orden en el tiempo ---

    /// Raíz 10, hijo 11, nieto 12 cuyos tokens están en el orden numérico CONTRARIO al del tiempo.
    fn arbol_sin_orden() -> World {
        let mut w = World::new(&[(1, 0, 1), (10, 1, 900), (11, 10, 5), (12, 11, 3), (20, 1, 50)]);
        w.unordered = true;
        w
    }

    #[test]
    fn con_tokens_sin_orden_un_hijo_con_token_menor_que_su_padre_no_se_salta() {
        let mut w = arbol_sin_orden();
        let mut t = captura(&mut w);
        kill_tree(&mut t, &mut w).unwrap();
        assert!(!w.alive(11) && !w.alive(12), "los descendientes cuyo token es numéricamente menor también mueren");
        assert!(w.alive(20) && !w.alive(10));
    }

    #[test]
    fn con_tokens_sin_orden_no_se_declara_muerto_un_arbol_con_un_descendiente_vivo() {
        let mut w = arbol_sin_orden();
        let mut t = captura(&mut w);
        w.immortal.push(12); // el nieto, con el token más pequeño, no muere
        assert!(kill_tree(&mut t, &mut w).is_err(), "si un descendiente sigue vivo el árbol NO está muerto");
        assert!(w.alive(12));
    }

    #[test]
    fn con_tokens_sin_orden_la_reutilizacion_de_pid_se_detecta_por_igualdad() {
        let mut w = arbol_sin_orden();
        let mut t = captura(&mut w);
        w.immortal.push(12);
        assert!(kill_tree(&mut t, &mut w).is_err());
        w.immortal.clear();
        w.procs.iter_mut().filter(|p| p.0 == 12).for_each(|p| p.3 = false);
        // El nuevo dueño del pid tiene un token MAYOR y otro MENOR que el viejo: ninguno es el mismo proceso.
        w.procs.push((12, 1, 4_000, true));
        kill_tree(&mut t, &mut w).unwrap();
        assert!(w.alive(12), "el ajeno no se toca");
        assert!(t.seen().is_empty());
        let mut w2 = arbol_sin_orden();
        let mut t2 = captura(&mut w2);
        w2.immortal.push(12);
        assert!(kill_tree(&mut t2, &mut w2).is_err());
        w2.immortal.clear();
        w2.procs.iter_mut().filter(|p| p.0 == 12).for_each(|p| p.3 = false);
        w2.procs.push((12, 1, 1, true));
        kill_tree(&mut t2, &mut w2).unwrap();
        assert!(w2.alive(12));
    }

    // --- Grupo del sistema: lo que el escaneo no puede ver ---

    /// Raíz 10 viva; 50 es un huérfano cuyo padre INTERMEDIO (99) salió antes del primer escaneo: su ppid cuelga de un
    /// pid inexistente, así que ningún recorrido desde la raíz lo encuentra. El grupo sí lo contabiliza.
    fn mundo_con_huerfano_y_grupo() -> World {
        let mut w = World::new(&[(1, 0, 1), (10, 1, 100), (50, 99, 150), (20, 1, 50)]);
        w.grp = Some(std::sync::Arc::new(std::sync::Mutex::new(Grp { members: vec![10, 50], ..Default::default() })));
        w
    }

    #[test]
    fn el_grupo_mata_al_huerfano_cuyo_padre_intermedio_salio_antes_del_primer_escaneo() {
        let mut w = mundo_con_huerfano_y_grupo();
        let mut t = captura(&mut w);
        kill_tree(&mut t, &mut w).unwrap();
        assert!(!w.alive(50), "el huérfano que el escaneo no ve murió con el grupo");
        assert!(!w.alive(10) && w.alive(20));
    }

    #[test]
    fn un_grupo_que_no_se_puede_consultar_o_terminar_falla_cerrado() {
        let mut w = mundo_con_huerfano_y_grupo();
        let mut t = captura(&mut w);
        w.grp.as_ref().unwrap().lock().unwrap().unreadable = true;
        assert!(kill_tree(&mut t, &mut w).is_err(), "sin poder consultar el grupo no se declara nada");

        let mut w = mundo_con_huerfano_y_grupo();
        let mut t = captura(&mut w);
        w.grp.as_ref().unwrap().lock().unwrap().stuck = true;
        assert!(kill_tree(&mut t, &mut w).is_err(), "si el grupo no se puede terminar, el árbol sigue vivo");
        assert!(w.alive(50));
    }

    #[test]
    fn mientras_el_grupo_tiene_miembros_el_arbol_no_esta_muerto_aunque_el_escaneo_no_vea_nada() {
        let mut w = World::new(&[(1, 0, 1), (10, 1, 100)]);
        let g = std::sync::Arc::new(std::sync::Mutex::new(Grp { members: vec![777], stuck: true, ..Default::default() }));
        w.grp = Some(g);
        let mut t = captura(&mut w);
        w.procs.iter_mut().filter(|p| p.0 == 10).for_each(|p| p.3 = false);
        assert!(kill_tree(&mut t, &mut w).is_err());
    }

    // --- Unix: grupo de procesos de la raíz (P1: el nieto reparentado a init que el recorrido por ppid no ve) ---

    /// Raíz 10 (líder de su grupo 10), su hijo 11 ya salió, y el nieto 12 se reparentó a init (ppid 1) pero sigue en el
    /// grupo 10. 30 es un proceso ajeno con su propio grupo. Los tokens están en orden numérico contrario al del tiempo.
    fn mundo_unix_con_nieto_huerfano() -> World {
        let mut w = World::new(&[(1, 0, 1), (10, 1, 900), (12, 1, 3), (30, 1, 70)]);
        w.unordered = true;
        w.leader = true;
        w.pg = vec![(10, 10), (12, 10), (30, 30)];
        w
    }

    #[test]
    fn el_grupo_de_procesos_mata_al_nieto_reparentado_a_init() {
        let mut w = mundo_unix_con_nieto_huerfano();
        let mut t = captura(&mut w);
        kill_tree(&mut t, &mut w).unwrap();
        assert!(!w.alive(12), "el nieto que el recorrido por ppid no ve murió con el grupo");
        assert!(!w.alive(10) && w.alive(30) && w.alive(1), "y ningún proceso ajeno se tocó");
    }

    #[test]
    fn un_nieto_del_grupo_que_no_muere_impide_declarar_el_arbol_muerto() {
        let mut w = mundo_unix_con_nieto_huerfano();
        let mut t = captura(&mut w);
        w.immortal.push(12);
        assert!(kill_tree(&mut t, &mut w).is_err(), "con un miembro vivo el árbol NO está muerto");
        assert!(w.alive(12));
    }

    #[test]
    fn si_las_filas_del_grupo_no_son_fiables_se_falla_cerrado() {
        let mut w = mundo_unix_con_nieto_huerfano();
        let mut t = captura(&mut w);
        w.rows_unreadable = true;
        assert!(kill_tree(&mut t, &mut w).is_err());
    }

    #[test]
    fn un_numero_de_grupo_reutilizado_por_un_ajeno_no_se_mata() {
        // La raíz y todos sus miembros murieron; el número 10 lo reutiliza un programa ajeno que lidera SU grupo 10 y
        // tiene un hijo. Nada rastreado sigue vivo: no hay ancla, así que no se puede probar que el grupo sea nuestro.
        let mut w = World::new(&[(1, 0, 1), (10, 1, 900), (12, 1, 3)]);
        w.unordered = true;
        w.leader = true;
        w.pg = vec![(10, 10), (12, 10)];
        let mut t = captura(&mut w);
        w.procs.iter_mut().filter(|p| p.0 == 10 || p.0 == 12).for_each(|p| p.3 = false);
        w.procs.push((10, 1, 8_000, true));
        w.procs.push((31, 10, 8_001, true));
        w.pg.extend([(31, 10)]);
        assert!(kill_tree(&mut t, &mut w).is_err(), "ante la duda: Err y custodia");
        assert!(w.alive(10) && w.alive(31) && w.killed.is_empty(), "ni el nuevo líder ni su hijo se tocaron");
    }

    #[test]
    fn con_la_raiz_muerta_y_un_miembro_sin_anotar_no_se_da_el_arbol_por_muerto_ni_se_mata_a_ciegas() {
        let mut w = mundo_unix_con_nieto_huerfano();
        let mut t = captura(&mut w);
        w.procs.iter_mut().filter(|p| p.0 == 10).for_each(|p| p.3 = false);
        assert!(kill_tree(&mut t, &mut w).is_err(), "hay un miembro vivo y no hay ancla para fiarse del número de grupo");
        assert!(w.alive(12) && w.killed.is_empty(), "no se mata sin poder probar que es nuestro");
    }

    #[test]
    fn un_miembro_ya_rastreado_ancla_el_grupo_aunque_la_raiz_haya_muerto() {
        let mut w = mundo_unix_con_nieto_huerfano();
        let mut t = captura(&mut w);
        // Primer intento: el nieto 12 no muere y queda anotado.
        w.immortal.push(12);
        assert!(kill_tree(&mut t, &mut w).is_err());
        assert!(t.seen().iter().any(|p| p.pid == 12));
        // Mientras tanto nace otro huérfano del mismo grupo; ahora 12 sí muere en el siguiente intento.
        w.procs.push((13, 1, 2, true));
        w.pg.push((13, 10));
        w.immortal.clear();
        kill_tree(&mut t, &mut w).unwrap();
        assert!(!w.alive(12) && !w.alive(13), "12 ancla el grupo y 13 se descubre y se mata");
        assert!(w.alive(30));
    }

    #[test]
    fn un_pid_de_otro_grupo_que_reutiliza_el_de_un_miembro_no_se_toca() {
        let mut w = mundo_unix_con_nieto_huerfano();
        let mut t = captura(&mut w);
        w.immortal.push(12);
        assert!(kill_tree(&mut t, &mut w).is_err());
        w.immortal.clear();
        w.procs.iter_mut().filter(|p| p.0 == 12).for_each(|p| p.3 = false);
        // El pid 12 pasa a un proceso ajeno de OTRO grupo.
        w.procs.push((12, 1, 5_000, true));
        w.pg.retain(|&(pid, _)| pid != 12);
        w.pg.push((12, 12));
        kill_tree(&mut t, &mut w).unwrap();
        assert!(w.alive(12), "el ajeno que heredó el pid no se mata");
    }

    #[test]
    fn sin_ser_lider_de_su_grupo_la_raiz_no_usa_pgid() {
        // Si el lanzamiento no dejó a la raíz como líder, su grupo es el de Lixbon: jamás se enumera ni se mata por él.
        let mut w = mundo_unix_con_nieto_huerfano();
        w.leader = false;
        let mut t = captura(&mut w);
        kill_tree(&mut t, &mut w).unwrap();
        assert!(w.alive(12) && w.alive(30), "sin pgid propio solo actúa el recorrido por ppid");
    }

    // --- P2: mutantes que sobrevivían en la revisión ---

    #[test]
    fn m01_con_la_raiz_muerta_y_un_huerfano_solo_en_el_grupo_no_hay_exito_antes_de_comprobar() {
        // Solo el grupo (Job Object) conoce a 50. `terminate` «funciona», pero el sistema retira al miembro en la lectura
        // SIGUIENTE: devolver Ok en la ronda en que se vio vivo sería afirmar la muerte sin comprobarla.
        let mut w = mundo_con_huerfano_y_grupo();
        let mut t = captura(&mut w);
        w.procs.iter_mut().filter(|p| p.0 == 10).for_each(|p| p.3 = false);
        w.grp.as_ref().unwrap().lock().unwrap().members = vec![50];
        kill_tree(&mut t, &mut w).unwrap();
        assert!(!w.alive(50), "Ok solo tras comprobar que el miembro ya no está");
    }

    #[test]
    fn m01_un_grupo_cuyos_miembros_no_se_van_aunque_terminate_funcione_falla() {
        let mut w = mundo_con_huerfano_y_grupo();
        let mut t = captura(&mut w);
        w.grp.as_ref().unwrap().lock().unwrap().sticky = true;
        assert!(kill_tree(&mut t, &mut w).is_err());
        assert!(w.alive(50));
    }

    #[test]
    fn m03_sin_instantes_reales_no_se_adoptan_procesos_cuyo_ppid_cuelga_de_la_raiz_muerta() {
        // Unix (tokens opacos): un proceso AJENO con `ppid == pid de la raíz` (pid ya libre) no es descendiente de nadie
        // que conozcamos: adoptarlo sería matar a un ajeno.
        let mut w = World::new(&[(1, 0, 1), (10, 1, 900), (21, 10, 60)]);
        w.unordered = true;
        let mut t = captura(&mut w);
        w.procs.iter_mut().filter(|p| p.0 == 10).for_each(|p| p.3 = false);
        kill_tree(&mut t, &mut w).unwrap();
        assert!(w.alive(21) && w.killed.is_empty(), "el ajeno no se toca");
    }

    #[test]
    fn m05_terminar_el_grupo_que_falla_no_cambia_el_veredicto_porque_ya_veta_group_alive() {
        // `terminate() == false` solo importaría si no hubiera otro veto; pero con miembros vivos `group_alive` ya
        // impide el éxito de la ronda y solo un grupo VACÍO lo permite. Con el grupo atascado el resultado es Err; si
        // los miembros se van solos, el siguiente Ok es legítimo (la muerte se comprobó por la lectura vacía).
        let mut w = mundo_con_huerfano_y_grupo();
        let mut t = captura(&mut w);
        w.grp.as_ref().unwrap().lock().unwrap().stuck = true;
        assert!(kill_tree(&mut t, &mut w).is_err());
        w.procs.iter_mut().filter(|p| p.0 == 50).for_each(|p| p.3 = false);
        w.grp.as_ref().unwrap().lock().unwrap().members.clear();
        kill_tree(&mut t, &mut w).unwrap();
    }

    #[test]
    fn el_sistema_real_declara_si_los_instantes_son_comparables() {
        // Windows: FILETIME real (comparables). Unix: token de `lstart` (solo igualdad).
        assert_eq!(RealOs.ordered_starts(), cfg!(windows));
    }

    // --- Windows: un pid reutilizado no puede meter a un ajeno en el Job ---

    #[test]
    fn capture_pasa_la_identidad_capturada_a_make_group() {
        let mut w = arbol();
        let _ = captura(&mut w);
        assert_eq!(w.group_start_seen, Some(Some(100)), "la hora de creación de la raíz viaja con la petición");
        let mut w = arbol();
        let _ = Tree::capture(&mut w, 2_000_000_001);
        assert_eq!(w.group_start_seen, Some(None), "sin identidad capturada se pide sin identidad (y no se adjunta)");
    }

    #[test]
    fn solo_se_adjunta_con_la_identidad_exacta() {
        assert!(may_attach(Some(7), Some(7)));
        assert!(!may_attach(Some(7), Some(8)), "otra hora de creación: el pid es de otro proceso");
        assert!(!may_attach(None, Some(7)), "sin identidad capturada no hay con qué comparar");
        assert!(!may_attach(Some(7), None), "si el proceso abierto no puede consultarse, no se adjunta");
        assert!(!may_attach(None, None));
    }

    #[cfg(windows)]
    #[test]
    fn el_job_real_no_adjunta_un_proceso_con_otra_identidad() {
        let mut child = std::process::Command::new("ping").args(["-n", "60", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        let pid = child.id();
        let start = start_time(pid).expect("identidad del proceso");
        assert!(win::Job::attach(pid, Some(start.wrapping_add(1))).is_none(), "identidad distinta: no se adjunta");
        assert!(win::Job::attach(pid, None).is_none(), "sin identidad: no se adjunta");
        let job = win::Job::attach(pid, Some(start)).expect("con la identidad exacta sí");
        assert!(Group::members(&job).is_some_and(|m| m.contains(&pid)));
        assert!(Group::terminate(&job));
        let _ = child.wait();
    }

    /// Unix, procesos de verdad: el intermedio (`( sleep 60 & )`) lanza al nieto y sale; el nieto se reparenta a init y
    /// solo el grupo de procesos de la raíz lo conoce. Corre solo en Linux/macOS (CI); en Windows no compila.
    #[cfg(unix)]
    #[test]
    fn el_grupo_de_procesos_real_mata_a_un_nieto_huerfano_de_verdad() {
        use std::os::unix::process::CommandExt;
        let dir = std::env::temp_dir().join(format!("lxo-pgrp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let marcador = dir.join("listo.txt");
        let script = format!("( sleep 60 & ); echo ok > '{}'; sleep 60", marcador.display());
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", &script]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        cmd.process_group(0);
        let mut child = cmd.spawn().unwrap();
        let mut os = RealOs;
        let mut t = Tree::capture(&mut os, child.id());
        let limite = std::time::Instant::now() + Duration::from_secs(20);
        while !marcador.exists() && std::time::Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(marcador.exists(), "la raíz llegó a su segunda fase: el intermedio ya salió");
        let miembros = os.group_rows(child.id()).expect("filas del grupo");
        assert!(miembros.len() >= 2, "la raíz y al menos el nieto huérfano: {miembros:?}");
        assert!(miembros.iter().any(|m| m.pid != child.id()), "hay un miembro que no es la raíz (el nieto huérfano)");
        kill_tree(&mut t, &mut os).expect("el árbol entero muere y se comprueba");
        assert_eq!(os.group_rows(child.id()).map(|r| r.len()), Some(0), "el grupo quedó vacío");
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn las_filas_de_ps_se_leen_con_su_token_y_lo_dudoso_invalida_la_lectura() {
        let ok = "  10     1    10 S    Wed Oct 15 10:20:30 2026\n  12     1    10 Z+   Wed Oct  5 09:00:01 2026\n";
        let rows = parse_ps_rows(ok).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].pid, rows[0].ppid, rows[0].pgid, rows[0].zombie), (10, 1, 10, false));
        assert!(rows[1].zombie);
        assert_eq!(lstart_token("Wed Oct  5 09:00:01 2026"), lstart_token("Wed Oct 5 09:00:01 2026"), "los espacios dobles no cambian el token");
        assert_ne!(lstart_token("Wed Oct 15 10:20:30 2026"), lstart_token("Wed Oct 15 10:20:31 2026"));
        assert!(parse_ps_rows("10 1 10 S Wed Oct 15 10:20:30").is_none(), "lstart incompleto");
        assert!(parse_ps_rows("10 1 S Wed Oct 15 10:20:30 2026").is_none(), "falta una columna");
        assert!(parse_ps_rows("x 1 10 S Wed Oct 15 10:20:30 2026").is_none(), "pid no numérico");
        assert_eq!(parse_ps_rows("").map(|r| r.len()), Some(0));
    }

    /// Windows, procesos de verdad: el padre intermedio (`cmd /C inner.cmd`) lanza al nieto y SALE antes de que el
    /// escaneo vea nada; el nieto queda con un `ppid` colgando. Solo el Job Object lo conoce.
    #[cfg(windows)]
    #[test]
    fn el_job_object_mata_a_un_nieto_huerfano_de_verdad() {
        use std::os::windows::process::CommandExt;
        let dir = std::env::temp_dir().join(format!("lxo-job-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("inner.cmd"), "@start \"\" /B ping -n 60 127.0.0.1 >nul\r\n").unwrap();
        // `cmd /C inner.cmd` (el padre intermedio) lanza al nieto y termina; solo después sigue la raíz.
        std::fs::write(dir.join("launch.cmd"), "@echo off\r\ncmd /C \"%~dp0inner.cmd\"\r\necho ok > \"%~dp0listo.txt\"\r\nping -n 60 127.0.0.1 >nul\r\n").unwrap();
        let mut cmd = std::process::Command::new("cmd.exe");
        cmd.arg("/C").arg(dir.join("launch.cmd")).current_dir(&dir).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let mut child = cmd.creation_flags(0x0800_0000).spawn().unwrap();
        let mut os = RealOs;
        let mut t = Tree::capture(&mut os, child.id());
        let limite = std::time::Instant::now() + Duration::from_secs(20);
        while !dir.join("listo.txt").exists() && std::time::Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(dir.join("listo.txt").exists(), "la raíz llegó a su segunda fase: el intermedio ya salió");
        let miembros = t.group_members().expect("el proceso se metió en un Job Object");
        assert!(miembros.len() >= 2, "la raíz y al menos el nieto huérfano: {miembros:?}");
        kill_tree(&mut t, &mut os).expect("el árbol entero muere y se comprueba");
        let tabla = process_table().unwrap();
        for m in miembros {
            assert!(!tabla.iter().any(|(p, _)| *p == m) || m == 0, "el miembro {m} del grupo sigue vivo");
        }
        assert_eq!(t.group_members(), Some(vec![]), "y el grupo quedó vacío");
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn la_tabla_real_es_fiable_y_contiene_este_proceso() {
        let t = process_table().expect("la tabla del sistema se lee");
        assert!(t.iter().any(|(p, _)| *p == std::process::id()));
        assert!(start_time(std::process::id()).is_some(), "y se puede consultar la identidad propia");
    }
}
