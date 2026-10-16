//! Árbol de procesos de un agente: tabla del sistema, identidad de cada proceso y kill verificado de TODO el árbol.
//! Lo usa `orch::pty` (`TreeKiller`). Vive fuera de `orch/` porque no tiene que ver con la frontera del almacén (la
//! guardia de `mutation_tests` limita Win32 a `fsio.rs` por la publicación durable, no por esto).
//!
//! Un pid NO identifica un proceso: se reutiliza. La identidad es `(pid, hora de creación)` ([`Proc`]). Reglas:
//! * solo se mata un proceso cuya hora de creación se comprueba JUSTO antes (en Windows con el mismo handle con el que
//!   se termina, así que no hay ventana entre comprobar y matar; en Unix la ventana es la de dos llamadas seguidas);
//! * un proceso al que se verificó muerto (ausente, o presente con otra hora de creación) sale de `seen` y no se vuelve
//!   a tocar nunca; la raíz verificada muerta no se vuelve a usar como origen de descendientes;
//! * un hijo solo cuelga de un padre si no es anterior a él (`start(hijo) >= start(padre)`);
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
}

impl Tree {
    /// Anota la raíz recién creada (su pid es seguro: acaba de crearse). Si ya no existe, nace verificada muerta.
    pub(crate) fn capture(os: &mut dyn Os, pid: u32) -> Tree {
        let start = os.start(pid);
        let gone = start.is_none() && os.table().is_some_and(|t| !t.iter().any(|(p, _)| *p == pid));
        Tree { pid, start, root_dead: gone, seen: Vec::new(), unproven: Vec::new() }
    }

    #[cfg(test)]
    pub(crate) fn seen(&self) -> &[Proc] {
        &self.seen
    }

    #[cfg(test)]
    pub(crate) fn root_dead(&self) -> bool {
        self.root_dead
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
        if adopt_orphans {
            queue.extend(root);
        }
        while let Some(parent) = queue.pop() {
            for &(pid, ppid) in &table {
                if ppid != parent.pid || pid == 0 || pid == parent.pid || pid == t.pid || alive.iter().any(|p| p.pid == pid) {
                    continue;
                }
                match os.start(pid) {
                    Some(s) if s >= parent.start => {
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
        if targets.is_empty() && !found && !unproven {
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

#[cfg(not(windows))]
fn raw_table() -> Option<Vec<(u32, u32)>> {
    let mut cmd = std::process::Command::new("ps");
    cmd.args(["-e", "-o", "pid=,ppid=,stat="]);
    let o = crate::hide_console(&mut cmd).output().ok().filter(|o| o.status.success())?;
    let text = String::from_utf8_lossy(&o.stdout);
    let mut out = Vec::new();
    for l in text.lines().filter(|l| !l.trim().is_empty()) {
        let mut f = l.split_whitespace();
        // Una línea que no se entiende hace dudosa TODA la lectura.
        let (pid, ppid, stat): (u32, u32, &str) = (f.next()?.parse().ok()?, f.next()?.parse().ok()?, f.next().unwrap_or(""));
        // Un zombi pendiente de `wait` cuenta como muerto, pero el propio proceso sigue contando para validar.
        if !stat.starts_with('Z') || pid == std::process::id() {
            out.push((pid, ppid));
        }
    }
    Some(out)
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, FILETIME, HANDLE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, GetProcessTimes, OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE};

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
    let mut cmd = std::process::Command::new("ps");
    cmd.args(["-o", "lstart=", "-p", &pid.to_string()]);
    let o = crate::hide_console(&mut cmd).output().ok().filter(|o| o.status.success())?;
    let text = String::from_utf8_lossy(&o.stdout);
    let text = text.trim();
    // FNV-1a de la cadena: solo importa que sea igual para el mismo proceso y distinta para otro.
    (!text.is_empty()).then(|| text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)))
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
        fn table(&mut self) -> Option<Vec<(u32, u32)>> {
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

    #[test]
    fn la_tabla_real_es_fiable_y_contiene_este_proceso() {
        let t = process_table().expect("la tabla del sistema se lee");
        assert!(t.iter().any(|(p, _)| *p == std::process::id()));
        assert!(start_time(std::process::id()).is_some(), "y se puede consultar la identidad propia");
    }
}
