//! Árbol de procesos de un agente: tabla del sistema, identidad de cada proceso y kill verificado de TODO el árbol.
//! Lo usa `orch::pty` (`TreeKiller`). Vive fuera de `orch/` porque no tiene que ver con la frontera del almacén (la
//! guardia de `mutation_tests` limita Win32 a `fsio.rs` por la publicación durable, no por esto).
//!
//! Un pid NO identifica un proceso: se reutiliza. La identidad es `(pid, hora de creación)` ([`Proc`]). Reglas:
//! * solo se mata un proceso cuya hora de creación se comprueba JUSTO antes (en Windows con el mismo handle con el que
//!   se termina, así que no hay ventana entre comprobar y matar; en Unix la ventana es la de dos `fork/exec` seguidos
//!   —`ps`/`/proc` y `kill`—, decenas de milisegundos con carga: un residuo documentado, no una garantía);
//! * identidad por plataforma (la MÁS FUERTE disponible, la misma en todas las vías de descubrimiento): Windows,
//!   FILETIME (100 ns); Linux, `starttime` de `/proc/<pid>/stat` (ticks de 10 ms; `ppid`, `pgrp` y `starttime` salen de
//!   la misma lectura del archivo); macOS, hash de `ps lstart` (1 s, en UTC: `ps` imprime en hora local y se fija
//!   `TZ=UTC`). **Lo que NO está demostrado (macOS):** que un falso «mismo proceso» no ocurra. Exigiría reutilizar el pid
//!   y arrancar el nuevo proceso en el MISMO segundo que el original; eso es una suposición de caudal (los pids se asignan
//!   de forma circular), no una prueba, y no vale para pids aleatorios (FreeBSD `randompid`, OpenBSD): fuera de
//!   Windows/Linux/macOS no hay garantía. Una identidad nativa más fina en macOS (`proc_pidinfo(PROC_PIDTBSDINFO)`:
//!   microsegundos, sin zona horaria) queda como seguimiento: no se puede ejecutar ni probar aquí;
//! * un proceso al que se verificó muerto (ausente, o presente con otra hora de creación) sale de `seen` y no se vuelve
//!   a tocar nunca; la raíz verificada muerta no se vuelve a usar como origen de descendientes. Un proceso que EXISTE
//!   pero no se puede leer (`/proc` con `hidepid`, de otro usuario) no está muerto: si es un pid rastreado, o el kernel lo
//!   lista como hijo de uno, el árbol queda sin probar; si no, no se puede atribuir ni matar y se omite;
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
//!      procesos con ese `pgid` se leen en UNA instantánea junto a su token de identidad y a quien ocupa el pid `pgid`.
//!      Cada miembro se mata con `terminate(Proc)` (identidad comprobada justo antes), nunca con `kill(-pgid)`.
//!
//!      **Propiedad del número de grupo.** Un `pgid` solo está reservado mientras alguien lo ocupa (como PID o como PGID).
//!      Un grupo con el líder muerto es indistinguible de uno AJENO que reutilizó el número y cuyo líder murió dejando
//!      hijos; por eso la propiedad se PRUEBA y nunca se supone ([`ownership`]):
//!      * la raíz sin reapear —viva o zombi— ocupa el pid: con él nadie más puede ser ese pid ni crear ese grupo, así que
//!        todo miembro es nuestro. Quien espera al hijo ([`wait_root`]) lo deja zombi con `waitid(WNOWAIT)`, anota los
//!        miembros del grupo y SOLO entonces lo reapea, todo bajo el candado del árbol: mientras un `kill_tree` tiene el
//!        árbol, la raíz que muere sigue de ancla hasta que termine (un miembro nacido entre dos instantáneas se
//!        descubre y se mata), y una raíz que sale sola dejando un proceso en segundo plano deja ese grupo anotado;
//!      * el ocupante del pid tiene el MISMO token que la raíz (la raíz sigue ahí): igual; tiene OTRO token: el número se
//!        liberó (el grupo estuvo vacío) y lo reutilizó otro, el grupo es ajeno, no se toca y el número se retira;
//!      * sin ocupante, los miembros solo son nuestros si uno YA verificado (en esa misma lectura, vivo, mismo token) sigue
//!        dentro: hay continuidad; sin él → sin probar (`Err`, custodia). Sin ocupante ni miembros el grupo murió y el
//!        número se retira para siempre;
//!      * **residuo**: todos los miembros anotados mueren por su cuenta, la raíz ya se reapeó y queda un proceso nacido
//!        después sin anotar. Es indistinguible de un grupo ajeno: `Err` y custodia, nunca un kill ajeno. Tampoco se
//!        cubre un proceso AJENO que se una a nuestro grupo con `setpgid` (misma sesión) conociendo el número.
//! * residual común: un proceso que se desvincula a propósito (`setsid`/`setpgid` a otro grupo, daemonización) tras
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
    /// Unix: el grupo `pgid` en UNA sola lectura (el `pgid` y el token de cada fila salen de la misma instantánea).
    /// `None` = no fiable (la duda es un error).
    fn group_view(&mut self, _pgid: u32) -> Option<GroupView> {
        None
    }
    /// Pids de la ÚLTIMA [`Os::table`] que existen pero no se pudieron leer (p. ej. `/proc` con `hidepid` para procesos
    /// de otro usuario). No están en la tabla; un pid rastreado que aparezca aquí NO está muerto, está sin probar.
    fn opaque(&mut self) -> Vec<u32> {
        Vec::new()
    }
    /// Hijos directos de `pid` según el propio sistema, también los que `table` no puede leer (Linux:
    /// `/proc/<pid>/task/*/children`). `None` si no lo ofrece o falla. Sirve para no descartar a un hijo ilegible.
    fn children(&mut self, _pid: u32) -> Option<Vec<u32>> {
        None
    }
}

/// Quien ocupa ahora el número `pgid` como PID (vivo o zombi sin reapear), de la misma lectura que el grupo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Holder {
    /// Su token de identidad; `None` si no se pudo leer (p. ej. un zombi en `ps`).
    pub start: Option<u64>,
}

/// Lo que una sola lectura dice del grupo de procesos `pgid` (Unix).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct GroupView {
    /// Procesos vivos (no zombis) con ese `pgid` y su token.
    pub members: Vec<Proc>,
    /// Hay miembros vivos cuyo token no se pudo leer: no se pueden verificar ni matar.
    pub unreadable: bool,
    /// El proceso cuyo PID es `pgid`, si existe (vivo o zombi).
    pub holder: Option<Holder>,
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
    /// Unix: el número de grupo de procesos de la raíz (que es su líder). Ver la cabecera del módulo. Se retira (`None`)
    /// en cuanto se PRUEBA que ya no es nuestro (lo ocupa otro proceso) o que el grupo está vacío y su número libre.
    pgid: Option<u32>,
    /// El proceso raíz (vivo o zombi) SIGUE ocupando su pid: nadie lo ha reapeado (lo hace [`root_exited`] bajo el candado
    /// del árbol, después de anotar el grupo). Mientras sea así el pid —y con él el número de grupo— no puede ser de otro,
    /// y la identidad de la raíz puede tomarse en cualquier momento. Ver la cabecera del módulo.
    pinned: bool,
}

/// Intentos de leer la identidad de la raíz al crearla: su pid es seguro (acaba de crearse), así que un fallo transitorio
/// de la herramienta no debe dejarla sin identidad para siempre.
const CAPTURE_TRIES: usize = 4;

impl Tree {
    /// Anota la raíz recién creada (su pid es seguro: acaba de crearse). Si ya no existe, nace verificada muerta.
    pub(crate) fn capture(os: &mut dyn Os, pid: u32) -> Tree {
        let mut start = os.start(pid);
        // Un fallo transitorio de la consulta con la raíz presente se reintenta (acotado): el pid sigue siendo seguro.
        for _ in 1..CAPTURE_TRIES {
            if start.is_some() || !os.table().is_some_and(|t| t.iter().any(|(p, _)| *p == pid)) {
                break;
            }
            os.settle();
            start = os.start(pid);
        }
        let group = os.make_group(pid, start);
        let pgid = os.leads_group(pid).then_some(pid);
        let gone = start.is_none() && os.table().is_some_and(|t| !t.iter().any(|(p, _)| *p == pid)) && !os.opaque().contains(&pid);
        Tree { pid, start, root_dead: gone, seen: Vec::new(), unproven: Vec::new(), group, pgid, pinned: false }
    }

    /// Declara que el proceso raíz no se reapeará hasta [`root_exited`] (lo garantiza quien espera al hijo: ver
    /// [`wait_root`]). Solo así el pid de la raíz es una prueba de propiedad del grupo.
    pub(crate) fn pin_root(&mut self) {
        self.pinned = true;
    }

    #[cfg(test)]
    pub(crate) fn pgid(&self) -> Option<u32> {
        self.pgid
    }

    #[cfg(test)]
    pub(crate) fn start(&self) -> Option<u64> {
        self.start
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
        let r = round(t, os, ordered, true)?;
        if r.clean {
            return Ok(());
        }
        last = r.what;
        os.settle();
    }
    Err(fail(format!("no se pudo matar todo el árbol del proceso {}: {last}", t.pid)))
}

/// Una ronda de descubrimiento SIN matar: anota en `seen` todo lo que hoy se puede probar del árbol. Es lo que hace
/// [`root_exited`] con la raíz ya muerta pero todavía sin reapear.
pub(crate) fn observe(t: &mut Tree, os: &mut dyn Os) -> std::io::Result<()> {
    let ordered = os.ordered_starts();
    round(t, os, ordered, false).map(|_| ())
}

/// Qué dice el grupo de procesos de la raíz sobre la propiedad de sus miembros.
#[derive(Debug, PartialEq, Eq)]
enum Own {
    /// Todo el que lleva ese `pgid` es de la raíz.
    Ours,
    /// El número lo usa ahora OTRO grupo: nada de lo que lleve ese `pgid` es nuestro.
    Foreign,
    /// Sin miembros ni ocupante del pid: el grupo murió y su número está libre.
    Gone,
    /// Hay miembros y no se puede probar que sean nuestros.
    Unproven,
}

/// Decide si los miembros de `view` son de la raíz. Un número de grupo solo está reservado mientras alguien lo ocupa
/// (como PID o como PGID), así que la propiedad se PRUEBA, nunca se supone:
/// * la raíz sin reapear ocupa el pid `P`; con él nadie más puede ser `P` ni crear el grupo `P`: todo miembro es nuestro;
/// * quien ocupa `P` es la raíz (mismo token): lo mismo; quien lo ocupa tiene OTRO token: `P` se liberó (el grupo estuvo
///   vacío) y lo reutilizó otro: el grupo es ajeno;
/// * sin ocupante, los miembros solo son nuestros si uno YA verificado (en esta misma lectura, vivo, mismo token) sigue
///   dentro: hay continuidad. Sin ancla vivo puede ser un grupo ajeno con el líder muerto y no se toca;
/// * sin ocupante ni miembros, el grupo ya no existe.
fn ownership(t: &Tree, v: &GroupView, alive: &[Proc], root_alive: Option<Proc>) -> Own {
    if t.pinned {
        return Own::Ours;
    }
    if let (Some(h), Some(start)) = (v.holder, t.start) {
        match h.start {
            Some(s) if s == start => return Own::Ours,
            Some(_) => return Own::Foreign,
            None => {}
        }
    }
    if v.members.iter().any(|m| alive.contains(m) || root_alive == Some(*m)) {
        return Own::Ours;
    }
    if v.members.is_empty() && !v.unreadable && v.holder.is_none() {
        return Own::Gone;
    }
    Own::Unproven
}

struct Round {
    /// Una ronda completa en la que no quedó nada vivo, nuevo ni sin probar.
    clean: bool,
    what: String,
}

fn round(t: &mut Tree, os: &mut dyn Os, ordered: bool, kill: bool) -> std::io::Result<Round> {
    let table = os.table().ok_or_else(|| fail(format!("no se pudo leer la tabla de procesos fiable del árbol de {}", t.pid)))?;
    let opaque = os.opaque();
    // Un pid ilegible EXISTE: no se puede dar por muerto, solo por sin probar.
    let present = |pid: u32| table.iter().any(|(p, _)| *p == pid) || opaque.contains(&pid);

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
    let mut root = t.start.map(|start| Proc { pid: t.pid, start });
    let mut root_alive = false;
    if !t.root_dead {
        match (present(t.pid), root) {
            (false, _) => {
                t.root_dead = true;
                adopt_orphans = true;
            }
            // Raíz sin reapear: su pid es suyo, así que la identidad que tiene AHORA es la verdadera.
            (true, None) if t.pinned => match os.start(t.pid) {
                Some(s) => {
                    t.start = Some(s);
                    root = Some(Proc { pid: t.pid, start: s });
                    root_alive = true;
                }
                None => {
                    t.seen = alive;
                    return Err(fail(format!("no se puede probar la identidad del proceso raíz {}: se conserva", t.pid)));
                }
            },
            (true, None) => {
                t.seen = alive;
                return Err(fail(format!("no se puede probar la identidad del proceso raíz {}: se conserva", t.pid)));
            }
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

    // 3a) Un proceso ilegible (de otro usuario, con `/proc` restringido) puede ser un hijo de algo que rastreamos: el
    // kernel lo dice en la lista de hijos del padre aunque su fila no se pueda leer. Si lo es, el árbol no está probado,
    // y el veto es PERSISTENTE (queda en `unproven`) aunque su padre muera: mientras exista, no se da nada por muerto.
    if !opaque.is_empty() {
        for p in parents.iter().chain(alive.iter()) {
            for kid in os.children(p.pid).unwrap_or_default() {
                if opaque.contains(&kid) && !t.unproven.contains(&kid) {
                    t.unproven.push(kid);
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
                if kill {
                    let _ = g.terminate();
                }
            }
        }
    }

    // 3c) Unix: los procesos del grupo de la raíz (incluidos los reparentados a init), si se PRUEBA que son nuestros.
    if let Some(g) = t.pgid {
        match os.group_view(g) {
            None => unproven = true,
            Some(view) => match ownership(t, &view, &alive, root_alive.then_some(root).flatten()) {
                Own::Ours => {
                    unproven |= view.unreadable;
                    for r in view.members {
                        if r.pid != t.pid && !alive.contains(&r) {
                            alive.push(r);
                            found = true;
                        }
                    }
                }
                // El número ya no es nuestro: nunca más se usa para descubrir.
                Own::Foreign => t.pgid = None,
                // La raíz ilegible no es un grupo muerto: sigue sin probar.
                Own::Gone if opaque.contains(&t.pid) => unproven = true,
                Own::Gone => t.pgid = None,
                Own::Unproven => unproven = true,
            },
        }
    }

    // 4) Terminar todo lo vivo, cada uno comprobando su identidad en el momento de matarlo.
    let targets: Vec<Proc> = parents.iter().copied().chain(alive.iter().copied()).fold(Vec::new(), |mut v, p| {
        if !v.contains(&p) {
            v.push(p);
        }
        v
    });
    if kill {
        for p in &targets {
            if os.terminate(*p) == Fate::Unknown {
                unproven = true;
            }
        }
    }
    t.seen = alive;
    let clean = targets.is_empty() && !found && !unproven && !group_alive;
    Ok(Round { clean, what: format!("siguen vivos o sin probar: {:?}", targets.iter().map(|p| p.pid).collect::<Vec<_>>()) })
}

/// Espera a que la raíz `pid` termine y la reapea (`wait`) SIN perder la prueba de que el grupo es suyo. Unix: la
/// raíz queda zombi (`waitid` con `WNOWAIT`) y mientras tanto reserva su pid y su número de grupo; solo entonces, bajo el
/// candado del árbol (así un `kill_tree` en curso la sigue teniendo de ancla hasta que termine), se anotan los miembros
/// del grupo y se reapea. `wait` es el que espera de verdad al hijo. En el resto de plataformas solo llama a `wait`.
pub(crate) fn wait_root(tree: &std::sync::Mutex<Tree>, os: &mut dyn Os, pid: u32, wait: impl FnOnce()) {
    if !cfg!(unix) {
        return wait();
    }
    tree.lock().unwrap_or_else(|e| e.into_inner()).pin_root();
    if hold_exit(pid) {
        root_exited(tree, os, wait);
    } else {
        // No se pudo esperar sin reapear (p. ej. ya lo reapeó otro): sin prueba de pin, y `wait` no se hace con el candado.
        tree.lock().unwrap_or_else(|e| e.into_inner()).pinned = false;
        wait();
    }
}

/// La raíz acaba de terminar y sigue zombi: anota los miembros que ya se pueden probar (`observe`), la reapea
/// (`reap`) y suelta el pin. Todo bajo el candado del árbol: ningún `kill_tree` ve la raíz reapeada con el pin puesto.
pub(crate) fn root_exited(tree: &std::sync::Mutex<Tree>, os: &mut dyn Os, reap: impl FnOnce()) {
    let mut t = tree.lock().unwrap_or_else(|e| e.into_inner());
    let _ = observe(&mut t, os);
    reap();
    t.pinned = false;
}

/// Unix: espera a que el hijo `pid` termine SIN reapearlo (`waitid` + `WNOWAIT`): sigue como zombi y conserva su pid y su
/// grupo. `false` si no se pudo (no es hijo nuestro, ya reapeado...).
#[cfg(unix)]
pub(crate) fn hold_exit(pid: u32) -> bool {
    loop {
        // SAFETY: `siginfo_t` a cero es un valor válido y `waitid` solo escribe en él.
        let (r, err) = unsafe {
            let mut info: libc::siginfo_t = std::mem::zeroed();
            let r = libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT);
            (r, std::io::Error::last_os_error())
        };
        if r == 0 {
            return true;
        }
        if err.kind() != std::io::ErrorKind::Interrupted {
            return false;
        }
    }
}

#[cfg(not(unix))]
pub(crate) fn hold_exit(_pid: u32) -> bool {
    false
}

/// Valida una tabla recién leída: vacía, o sin el propio proceso, es una lectura truncada o inesperada, no «no hay
/// nadie». `None` = no fiable.
pub(crate) fn validated(table: Vec<(u32, u32)>, own_pid: u32) -> Option<Vec<(u32, u32)>> {
    (!table.is_empty() && table.iter().any(|(p, _)| *p == own_pid)).then_some(table)
}

/// El sistema real. Guarda los pids ilegibles de la última tabla (ver [`Os::opaque`]).
#[derive(Default)]
pub(crate) struct RealOs {
    opaque: Vec<u32>,
}

impl Os for RealOs {
    fn table(&mut self) -> Option<Vec<(u32, u32)>> {
        let (table, opaque) = process_snapshot()?;
        self.opaque = opaque;
        Some(table)
    }

    fn opaque(&mut self) -> Vec<u32> {
        self.opaque.clone()
    }

    fn children(&mut self, pid: u32) -> Option<Vec<u32>> {
        kernel_children(pid)
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

    fn group_view(&mut self, pgid: u32) -> Option<GroupView> {
        group_view(pgid)
    }
}

/// Windows: un Job Object sin límites (nada se mata al soltarlo ni se impide escapar a nadie: solo contabiliza).
#[cfg(windows)]
fn make_group(pid: u32, start: Option<u64>) -> Option<std::sync::Arc<dyn Group>> {
    win::Job::attach(pid, start).map(|j| std::sync::Arc::new(j) as std::sync::Arc<dyn Group>)
}

/// Unix: no hay Job Object; el grupo de procesos (`leads_group` + `group_view`) cumple ese papel.
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
#[cfg_attr(any(windows, target_os = "linux"), allow(dead_code))]
fn lstart_token(lstart: &str) -> Option<u64> {
    let norm = lstart.split_whitespace().collect::<Vec<_>>().join(" ");
    (!norm.is_empty()).then(|| norm.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)))
}

/// Lee `/proc/<pid>/stat` (Linux) EN BYTES. Todo sale de UNA lectura del mismo archivo: `ppid` (campo 4), `pgrp` (5) y
/// `starttime` (22, en ticks de reloj desde el arranque, resolución de 10 ms) son coherentes entre sí. El nombre (campo
/// 2) va entre paréntesis, lo elige el propio proceso y puede ser cualquier secuencia de bytes (no UTF-8, espacios,
/// paréntesis): se cuenta desde el ÚLTIMO `)` y solo lo que viene después, ASCII del kernel, se interpreta. `None` si no
/// se entiende.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_stat(pid: u32, stat: &[u8]) -> Option<PsRow> {
    let close = stat.iter().rposition(|&b| b == b')')?;
    let after = std::str::from_utf8(&stat[close + 1..]).ok()?;
    let mut f = after.split_whitespace();
    let state = f.next()?; // campo 3
    let ppid = f.next()?.parse().ok()?; // 4
    let pgid = f.next()?.parse().ok()?; // 5
    let start = f.nth(16)?.parse().ok()?; // 22 (tras 5: 6..=21 son 16 campos, el 17.º es el 22)
    Some(PsRow { pid, ppid, pgid, zombie: matches!(state, "Z" | "X" | "x"), start: Some(start) })
}

/// Una fila de `ps -e -o pid=,ppid=,pgid=,stat=,lstart=` (macOS y otros Unix) o de `/proc/<pid>/stat` (Linux).
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(windows, allow(dead_code))]
struct PsRow {
    pid: u32,
    ppid: u32,
    pgid: u32,
    zombie: bool,
    /// Token de identidad; `None` si la fila existe pero su hora de creación no se pudo leer (no se puede verificar).
    start: Option<u64>,
}

/// Lee la salida de `ps`. Una fila cuyos campos NUMÉRICOS (`pid`, `ppid`, `pgid`) o `stat` no se entienden hace dudosa
/// TODA la lectura: `None`. Una fila con esas columnas pero sin un `lstart` completo (los zombis y los procesos que
/// salen pueden imprimirlo vacío) no envenena el resto: queda como fila sin token (`start: None`), que el árbol trata
/// como sin probar solo si es relevante para él.
#[cfg_attr(any(windows, target_os = "linux"), allow(dead_code))]
fn parse_ps_rows(text: &str) -> Option<Vec<PsRow>> {
    let mut out = Vec::new();
    for l in text.lines().filter(|l| !l.trim().is_empty()) {
        let mut f = l.split_whitespace();
        let (pid, ppid, pgid): (u32, u32, u32) = (f.next()?.parse().ok()?, f.next()?.parse().ok()?, f.next()?.parse().ok()?);
        let stat = f.next()?;
        let lstart: Vec<&str> = f.collect();
        let start = if lstart.len() == 5 { lstart_token(&lstart.join(" ")) } else { None };
        out.push(PsRow { pid, ppid, pgid, zombie: stat.starts_with('Z'), start });
    }
    Some(out)
}

/// Tabla `(pid, ppid)` de los procesos vivos, o `None` si no se pudo leer o no es fiable (vacía, sin este proceso,
/// recorrido interrumpido antes del final). Las pruebas la usan para mirar el sistema; el kill usa [`Os::table`].
#[cfg(test)]
pub(crate) fn process_table() -> Option<Vec<(u32, u32)>> {
    process_snapshot().map(|(t, _)| t)
}

/// Tabla `(pid, ppid)` y pids ilegibles de una misma lectura.
type Snapshot = (Vec<(u32, u32)>, Vec<u32>);

/// La tabla y los pids que existen pero no se pudieron leer (solo Linux con `/proc` restringido; ver [`Os::opaque`]).
fn process_snapshot() -> Option<Snapshot> {
    let (table, opaque) = raw_snapshot()?;
    validated(table, std::process::id()).map(|t| (t, opaque))
}

#[cfg(windows)]
fn raw_snapshot() -> Option<Snapshot> {
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
        Some((out, Vec::new()))
    }
}

/// El entorno con el que se ejecuta `ps` (ver [`ps_output`]).
#[cfg_attr(any(windows, target_os = "linux"), allow(dead_code))]
const PS_ENV: [(&str, &str); 2] = [("LC_ALL", "C"), ("TZ", "UTC")];

/// `ps` en un entorno fijo: `LC_ALL=C` (formato) y `TZ=UTC` (`lstart` sale en hora LOCAL: si la zona del sistema
/// cambiara entre dos lecturas —viaje, cambio de horario de verano— el mismo proceso tendría otro token y se
/// creería que su pid se reutilizó). El token de `lstart` debe salir igual en todas las lecturas.
#[cfg(all(not(windows), not(target_os = "linux")))]
fn ps_output(args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("ps");
    cmd.args(args).envs(PS_ENV);
    let o = crate::hide_console(&mut cmd).output().ok().filter(|o| o.status.success())?;
    Some(String::from_utf8_lossy(&o.stdout).into_owned())
}

/// Qué pasó al leer el `stat` de un pid de `/proc`.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum StatRead {
    Bytes(Vec<u8>),
    /// Desapareció durante la lectura (`ENOENT`/`ESRCH`): simplemente ya no está.
    Gone,
    /// Existe pero es de OTRO usuario y `/proc` (`hidepid`) no deja leerlo: no es nuestro, ni podríamos matarlo.
    Opaque,
    /// Cualquier otro fallo (incluido no poder leer un proceso de nuestro mismo usuario): la lectura no es fiable.
    Broken,
}

/// Clasifica el resultado de leer `/proc/<pid>/stat`. `other_owner` dice si el directorio `/proc/<pid>` es de otro
/// usuario (se consulta solo ante «permiso denegado»; `/proc/<pid>` sigue siendo consultable con `hidepid=1`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn classify_stat_read(read: std::io::Result<Vec<u8>>, other_owner: impl FnOnce() -> std::io::Result<bool>) -> StatRead {
    use std::io::ErrorKind::{NotFound, PermissionDenied};
    match read {
        Ok(b) => StatRead::Bytes(b),
        Err(e) if e.kind() == NotFound || e.raw_os_error() == Some(3) => StatRead::Gone,
        Err(e) if e.kind() == PermissionDenied || e.raw_os_error() == Some(1) => match other_owner() {
            Ok(true) => StatRead::Opaque,
            Err(e) if e.kind() == NotFound => StatRead::Gone,
            _ => StatRead::Broken,
        },
        Err(_) => StatRead::Broken,
    }
}

/// Linux: los hijos directos de `pid` que lista el kernel (`/proc/<pid>/task/<tid>/children`, un archivo por hilo).
/// `None` si el kernel no lo ofrece (`CONFIG_PROC_CHILDREN`) o algo falla.
#[cfg(target_os = "linux")]
fn kernel_children(pid: u32) -> Option<Vec<u32>> {
    let mut out = Vec::new();
    for t in std::fs::read_dir(format!("/proc/{pid}/task")).ok()? {
        let text = std::fs::read(t.ok()?.path().join("children")).ok()?;
        out.extend(text.split(|b| b.is_ascii_whitespace()).filter(|s| !s.is_empty()).filter_map(|s| std::str::from_utf8(s).ok()?.parse::<u32>().ok()));
    }
    Some(out)
}

#[cfg(not(target_os = "linux"))]
fn kernel_children(_pid: u32) -> Option<Vec<u32>> {
    None
}

/// Convierte las lecturas de `/proc` en filas. Un `stat` legible que no se entiende, o un fallo no clasificado, vuelve
/// dudosa TODA la lectura; un proceso ajeno e ilegible (`Opaque`) solo se anota como tal: el árbol lo trata como
/// «sin probar» únicamente si es un pid que rastrea.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn rows_from_reads(reads: Vec<(u32, StatRead)>) -> Option<(Vec<PsRow>, Vec<u32>)> {
    let (mut rows, mut opaque) = (Vec::new(), Vec::new());
    for (pid, read) in reads {
        match read {
            StatRead::Bytes(b) => rows.push(parse_proc_stat(pid, &b)?),
            StatRead::Gone => {}
            StatRead::Opaque => opaque.push(pid),
            StatRead::Broken => return None,
        }
    }
    Some((rows, opaque))
}

/// Linux: recorre `/proc`.
#[cfg(target_os = "linux")]
fn proc_snapshot() -> Option<(Vec<PsRow>, Vec<u32>)> {
    use std::os::unix::fs::MetadataExt;
    let own = std::fs::metadata("/proc/self").ok()?.uid();
    let mut reads = Vec::new();
    for e in std::fs::read_dir("/proc").ok()? {
        let e = e.ok()?;
        let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let read = classify_stat_read(std::fs::read(e.path().join("stat")), || std::fs::metadata(e.path()).map(|m| m.uid() != own));
        reads.push((pid, read));
    }
    rows_from_reads(reads)
}

/// Fuente de filas por plataforma: Linux usa `/proc` (identidad en ticks); macOS y el resto, `ps` (identidad por `lstart`).
#[cfg(not(windows))]
fn ps_rows() -> Option<(Vec<PsRow>, Vec<u32>)> {
    #[cfg(target_os = "linux")]
    let (rows, opaque) = proc_snapshot()?;
    #[cfg(not(target_os = "linux"))]
    let (rows, opaque) = (parse_ps_rows(&ps_output(&["-e", "-o", "pid=,ppid=,pgid=,stat=,lstart="])?)?, Vec::new());
    // Sin este proceso la lectura está truncada o es inesperada.
    rows.iter().any(|r| r.pid == std::process::id()).then_some((rows, opaque))
}

#[cfg(not(windows))]
fn raw_snapshot() -> Option<Snapshot> {
    // Un zombi pendiente de `wait` cuenta como muerto, pero el propio proceso sigue contando para validar.
    let (rows, opaque) = ps_rows()?;
    Some((rows.into_iter().filter(|r| !r.zombie || r.pid == std::process::id()).map(|r| (r.pid, r.ppid)).collect(), opaque))
}

/// El grupo `pgid` de una lectura: sus miembros vivos con token, si algún miembro es ilegible y quién ocupa ese PID.
#[cfg_attr(windows, allow(dead_code))]
fn group_view_of(rows: &[PsRow], pgid: u32) -> GroupView {
    let holder = rows.iter().find(|r| r.pid == pgid).map(|r| Holder { start: r.start });
    let (mut members, mut unreadable) = (Vec::new(), false);
    for r in rows.iter().filter(|r| r.pgid == pgid && !r.zombie) {
        match r.start {
            Some(start) => members.push(Proc { pid: r.pid, start }),
            None => unreadable = true,
        }
    }
    GroupView { members, unreadable, holder }
}

#[cfg(not(windows))]
fn group_view(pgid: u32) -> Option<GroupView> {
    Some(group_view_of(&ps_rows()?.0, pgid))
}

#[cfg(windows)]
fn group_view(_pgid: u32) -> Option<GroupView> {
    None
}

#[cfg(not(windows))]
fn leads_group(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::fs::read(format!("/proc/{pid}/stat")).ok().and_then(|t| parse_proc_stat(pid, &t)).is_some_and(|r| r.pgid == pid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        ps_output(&["-o", "pgid=", "-p", &pid.to_string()]).and_then(|t| t.trim().parse::<u32>().ok()) == Some(pid)
    }
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

/// Identidad en Unix: la MISMA fuente que las filas de `ps_rows`, para que los tokens de un proceso coincidan en todas las
/// vías de descubrimiento. Linux: `starttime` de `/proc/<pid>/stat` (ticks, 10 ms). macOS y el resto: hash de `lstart`
/// (resolución de 1 s, en UTC; ver la cabecera del módulo sobre lo que eso NO prueba). En ambos casos es un token que
/// solo se compara por IGUALDAD: `ordered_starts` es falso en Unix y `kill_tree` nunca lo ordena.
#[cfg(not(windows))]
fn start_time(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        parse_proc_stat(pid, &std::fs::read(format!("/proc/{pid}/stat")).ok()?)?.start
    }
    #[cfg(not(target_os = "linux"))]
    {
        lstart_token(&ps_output(&["-o", "lstart=", "-p", &pid.to_string()])?)
    }
}

/// ¿Se PRUEBA que `pid` ya no existe? Solo si la tabla es fiable y no lo contiene NI entre los pids que existen pero no
/// se pudieron leer (un proceso ilegible está vivo, solo que sin probar).
#[cfg(not(windows))]
fn proven_absent(pid: u32) -> bool {
    process_snapshot().is_some_and(|(t, opaque)| !t.iter().any(|(q, _)| *q == pid) && !opaque.contains(&pid))
}

/// En Unix la identidad se comprueba justo antes de `kill -9`: son dos llamadas seguidas, no una sola operación (no hay
/// handle que ancle el pid sin pidfd). La ventana es la de dos `fork/exec` (decenas de milisegundos con carga), frente a
/// la de horas que había al reintentar con pids viejos; es un residuo documentado, no una garantía.
#[cfg(not(windows))]
fn terminate(p: Proc) -> Fate {
    match start_time(p.pid) {
        Some(s) if s == p.start => {}
        Some(_) => return Fate::Gone,
        None => return if proven_absent(p.pid) { Fate::Gone } else { Fate::Unknown },
    }
    let mut cmd = std::process::Command::new("kill");
    cmd.args(["-9", &p.pid.to_string()]);
    match crate::hide_console(cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())).status() {
        Ok(s) if s.success() => Fate::Killed,
        _ => match start_time(p.pid) {
            Some(s) if s != p.start => Fate::Gone,
            Some(_) => Fate::Unknown,
            None if proven_absent(p.pid) => Fate::Gone,
            None => Fate::Unknown,
        },
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
        /// Procesos muertos pero SIN reapear (zombis): `(pid, start)`. Siguen ocupando su pid.
        zombies: Vec<(u32, u64)>,
        /// Pids que, al morir por `terminate`, quedan zombis en vez de desaparecer (nadie los reapea).
        zombify: Vec<u32>,
        /// Pids que existen pero cuya fila no se puede leer (`/proc` con `hidepid`): no están en la tabla.
        opaque_pids: Vec<u32>,
        /// El ocupante zombi del número de grupo no tiene token legible.
        holder_blind: bool,
        /// Cuántas consultas de `start` fallan antes de funcionar (fallo transitorio de la herramienta).
        start_flaky: u32,
        /// Algún miembro del grupo existe pero su token no se puede leer.
        rows_blind: bool,
        /// El sistema no ofrece la lista de hijos de un proceso.
        no_children: bool,
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

        fn group_view(&mut self, pgid: u32) -> Option<GroupView> {
            if self.rows_unreadable {
                return None;
            }
            let members: Vec<Proc> = self.procs.iter().filter(|p| p.3 && self.pg.iter().any(|&(pid, g)| pid == p.0 && g == pgid)).map(|p| Proc { pid: p.0, start: p.2 }).collect();
            // Quien ocupa el pid `pgid`: un proceso vivo, o un zombi sin reapear.
            let holder = self
                .procs
                .iter()
                .find(|p| p.0 == pgid && p.3)
                .map(|p| Holder { start: Some(p.2) })
                .or_else(|| self.zombies.iter().find(|z| z.0 == pgid).map(|z| Holder { start: (!self.holder_blind).then_some(z.1) }));
            // Con `rows_blind` los miembros existen pero no se puede leer su token: se ven como ilegibles, no como miembros.
            let unreadable = self.rows_blind && !members.is_empty();
            Some(GroupView { unreadable, members: if self.rows_blind { Vec::new() } else { members }, holder })
        }

        fn children(&mut self, pid: u32) -> Option<Vec<u32>> {
            (!self.no_children).then(|| self.procs.iter().filter(|p| p.3 && p.1 == pid).map(|p| p.0).collect())
        }

        fn opaque(&mut self) -> Vec<u32> {
            self.opaque_pids.clone()
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
            self.table_ok.then(|| self.procs.iter().filter(|p| p.3 && !self.opaque_pids.contains(&p.0)).map(|&(p, pp, _, _)| (p, pp)).collect())
        }

        fn start(&mut self, pid: u32) -> Option<u64> {
            if self.start_flaky > 0 {
                self.start_flaky -= 1;
                return None;
            }
            if self.no_start.contains(&pid) || self.opaque_pids.contains(&pid) {
                return None;
            }
            self.procs.iter().find(|p| p.0 == pid && p.3).map(|p| p.2)
        }

        fn terminate(&mut self, p: Proc) -> Fate {
            if let Some(mut hook) = self.before_terminate.take() {
                hook(&mut self.procs, p);
                self.before_terminate = Some(hook);
            }
            if self.opaque_pids.contains(&p.pid) {
                return Fate::Unknown; // no se puede ni leer ni señalar
            }
            match self.procs.iter_mut().find(|q| q.0 == p.pid && q.3) {
                None => Fate::Gone,
                Some(q) if q.2 != p.start => Fate::Gone,
                Some(q) => {
                    if !self.immortal.contains(&p.pid) {
                        q.3 = false;
                        self.killed.push((p.pid, p.start));
                        if self.zombify.contains(&p.pid) {
                            self.zombies.push((p.pid, p.start));
                        }
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
        // tiene un hijo.
        let mut w = World::new(&[(1, 0, 1), (10, 1, 900), (12, 1, 3)]);
        w.unordered = true;
        w.leader = true;
        w.pg = vec![(10, 10), (12, 10)];
        let mut t = captura(&mut w);
        w.procs.iter_mut().filter(|p| p.0 == 10 || p.0 == 12).for_each(|p| p.3 = false);
        w.procs.push((10, 1, 8_000, true));
        w.procs.push((31, 10, 8_001, true));
        w.pg.extend([(31, 10)]);
        // El ocupante del pid 10 tiene OTRO token: el número se liberó (el grupo estuvo vacío) y lo reutilizó un ajeno. El
        // grupo es suyo, no nuestro: se PRUEBA que no queda nada nuestro y se retira el número, sin tocar a nadie.
        kill_tree(&mut t, &mut w).expect("probado: el árbol está muerto y el grupo 10 es ajeno");
        assert!(w.alive(10) && w.alive(31) && w.killed.is_empty(), "ni el nuevo líder ni su hijo se tocaron");
        assert_eq!(t.pgid(), None, "el número de grupo ya no es nuestro: nunca más se usa");
    }

    #[test]
    fn con_la_raiz_reapeada_y_un_miembro_jamas_anotado_no_se_da_el_arbol_por_muerto_ni_se_mata_a_ciegas() {
        // Sin pin, sin observación al salir y sin ancla vivo, un grupo con el líder muerto es indistinguible de uno AJENO
        // que lo reutilizó (un líder ajeno que murió dejando hijos): no se puede probar que sea nuestro. Residuo
        // documentado: `Err` y custodia, nunca un kill a ciegas. (El camino real anota el grupo al salir la raíz: ver
        // `la_raiz_que_sale_dejando_un_huerfano_anota_el_grupo_al_salir_y_un_kill_posterior_lo_mata`.)
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

    // --- LXO-18 (reparación): propiedad PROBADA del grupo sin ancla vivo ---
    //
    // Un número de grupo solo está reservado mientras alguien lo ocupa (como PID o como PGID). Un grupo con el líder muerto
    // es indistinguible de uno AJENO que reutilizó el número y cuyo líder murió dejando hijos, así que sin prueba no se
    // toca. Las pruebas son: la raíz sin reapear (viva o zombi) ocupa el pid; el ocupante con el MISMO token; un miembro
    // ya verificado que sigue dentro; o los miembros anotados cuando la raíz salió (todavía zombi).

    /// Raíz 10 (líder del grupo 10), hijo 11, nieto 12, todos en el grupo 10; 30 es un ajeno con su propio grupo.
    fn arbol_unix() -> World {
        let mut w = World::new(&[(1, 0, 1), (10, 1, 900), (11, 10, 5), (12, 11, 3), (30, 1, 70)]);
        w.unordered = true;
        w.leader = true;
        w.pg = vec![(10, 10), (11, 10), (12, 10), (30, 30), (13, 10)];
        w
    }

    /// Prepara el nacimiento de 13 (huérfano del grupo 10, `ppid` 1) JUSTO antes de matar a 11: después de la lectura del
    /// grupo y antes del kill, que es la ventana de la carrera.
    fn nace_el_13_antes_de_matar_al_11(w: &mut World) {
        let mut nacido = false;
        w.before_terminate = Some(Box::new(move |procs, p| {
            if p.pid == 11 && !nacido {
                nacido = true;
                procs.push((13, 1, 2, true));
            }
        }));
    }

    #[test]
    fn disparador_a_un_miembro_nacido_entre_instantaneas_se_mata_porque_la_raiz_zombi_ancla_el_grupo() {
        for fijada in [true, false] {
            let mut w = arbol_unix();
            let mut t = captura(&mut w);
            if fijada {
                t.pin_root();
            }
            // Tras morir por el kill, la raíz queda zombi (nadie la reapea mientras `kill_tree` tiene el árbol).
            w.zombify.push(10);
            nace_el_13_antes_de_matar_al_11(&mut w);
            kill_tree(&mut t, &mut w).unwrap_or_else(|e| panic!("fijada={fijada}: {e}"));
            assert!(!w.alive(13), "fijada={fijada}: el nacido entre instantáneas murió");
            assert!(!w.alive(11) && !w.alive(12) && w.alive(30) && w.alive(1), "fijada={fijada}: y solo lo nuestro");
        }
    }

    #[test]
    fn disparador_a_sin_la_raiz_como_ancla_el_nacido_no_se_mata_y_el_resultado_es_err_con_custodia() {
        // Si el pin se rompiera (alguien reapea la raíz entre rondas) y el nacido fuera el único miembro, no se puede
        // probar que el número siga siendo nuestro: Err, nada ajeno muerto, y el nacido sigue custodiado.
        let mut w = arbol_unix();
        let mut t = captura(&mut w);
        nace_el_13_antes_de_matar_al_11(&mut w); // la raíz no queda zombi: desaparece del todo
        let r = kill_tree(&mut t, &mut w);
        assert!(r.is_err(), "sin ancla vivo ni ocupante del pid no se prueba nada");
        assert!(w.alive(13) && w.alive(30), "ni el nacido ni ningún ajeno se tocaron a ciegas");
        assert!(w.killed.iter().all(|k| k.0 != 13 && k.0 != 30));
    }

    fn mundo_raiz_que_sale_dejando_un_huerfano() -> (World, std::sync::Mutex<Tree>) {
        // La raíz 10 acaba de salir sola (zombi, sin reapear) y deja un proceso en segundo plano 12 (ppid 1) en su grupo.
        let mut w = World::new(&[(1, 0, 1), (10, 1, 900), (12, 1, 3), (30, 1, 70)]);
        w.unordered = true;
        w.leader = true;
        w.pg = vec![(10, 10), (12, 10), (13, 10), (30, 30)];
        let tree = std::sync::Mutex::new(captura(&mut w));
        tree.lock().unwrap().pin_root();
        w.procs.iter_mut().filter(|p| p.0 == 10).for_each(|p| p.3 = false);
        w.zombies.push((10, 900));
        (w, tree)
    }

    #[test]
    fn la_raiz_que_sale_dejando_un_huerfano_anota_el_grupo_al_salir_y_un_kill_posterior_lo_mata() {
        let (mut w, tree) = mundo_raiz_que_sale_dejando_un_huerfano();
        let reapeada = std::cell::Cell::new(false);
        root_exited(&tree, &mut w, || reapeada.set(true));
        assert!(reapeada.get());
        {
            let t = tree.lock().unwrap();
            assert!(t.seen().iter().any(|p| p.pid == 12), "el huérfano se anotó mientras la raíz aún ocupaba el pid");
            assert!(!t.pinned && t.root_dead());
        }
        // La raíz se reapea: el número solo lo reserva ya el grupo. Después nace otro miembro.
        w.zombies.clear();
        w.procs.push((13, 12, 2, true));
        kill_tree(&mut tree.lock().unwrap(), &mut w).expect("12 ancla el grupo: 12 y el 13 nacido después mueren");
        assert!(!w.alive(12) && !w.alive(13) && w.alive(30));
    }

    #[test]
    fn la_raiz_que_sale_sin_que_se_anote_nada_deja_el_huerfano_sin_matar_y_con_err() {
        // Mismo escenario SIN observación al salir (no hay `root_exited`): el residuo documentado.
        let (mut w, tree) = mundo_raiz_que_sale_dejando_un_huerfano();
        w.zombies.clear(); // reapeada sin más
        tree.lock().unwrap().pinned = false;
        assert!(kill_tree(&mut tree.lock().unwrap(), &mut w).is_err());
        assert!(w.alive(12) && w.killed.is_empty(), "sin prueba de propiedad no se mata");
    }

    #[test]
    fn si_todos_los_miembros_anotados_mueren_solos_y_queda_un_nacido_despues_se_falla_cerrado() {
        let (mut w, tree) = mundo_raiz_que_sale_dejando_un_huerfano();
        root_exited(&tree, &mut w, || {});
        w.zombies.clear();
        // El anotado (12) muere por su cuenta y deja un hijo 13: nadie rastreado sigue dentro y el número ya no tiene
        // quien lo ocupe. Es indistinguible de un grupo ajeno que lo reutilizó.
        w.procs.iter_mut().filter(|p| p.0 == 12).for_each(|p| p.3 = false);
        w.procs.push((13, 1, 2, true));
        assert!(kill_tree(&mut tree.lock().unwrap(), &mut w).is_err());
        assert!(w.alive(13) && w.killed.is_empty());
    }

    #[test]
    fn root_exited_aunque_no_pueda_observar_siempre_reapea_y_suelta_el_pin() {
        let mut w = arbol_unix();
        let tree = std::sync::Mutex::new(captura(&mut w));
        tree.lock().unwrap().pin_root();
        w.table_ok = false; // la observación falla
        let reapeada = std::cell::Cell::new(false);
        root_exited(&tree, &mut w, || reapeada.set(true));
        assert!(reapeada.get() && !tree.lock().unwrap().pinned, "sin tabla no se anota nada, pero la raíz se reapea igualmente");
    }

    #[test]
    fn un_ocupante_ajeno_del_numero_de_grupo_con_hijos_no_se_toca_y_el_numero_se_retira() {
        // La raíz murió y se reapeó; el pid 10 es ahora de un programa ajeno que lidera su grupo 10 con un hijo, aunque
        // el líder ajeno ya se haya ido (grupo ajeno con el líder muerto) NO se confunde con el nuestro.
        let mut w = World::new(&[(1, 0, 1), (10, 1, 900), (12, 1, 3)]);
        w.unordered = true;
        w.leader = true;
        w.pg = vec![(10, 10), (12, 10), (31, 10)];
        let mut t = captura(&mut w);
        w.procs.iter_mut().filter(|p| p.0 == 10 || p.0 == 12).for_each(|p| p.3 = false);
        w.procs.push((10, 1, 8_000, true)); // el ajeno F ocupa el pid
        w.procs.push((31, 10, 8_001, true)); // y tiene un hijo en SU grupo 10
        kill_tree(&mut t, &mut w).expect("el árbol nuestro está muerto: se prueba");
        assert!(w.alive(10) && w.alive(31) && w.killed.is_empty());
        assert_eq!(t.pgid(), None);
        // Más tarde F muere dejando a 31 en el grupo 10, sin ocupante: como el número ya se retiró, sigue sin tocarse.
        w.procs.iter_mut().filter(|p| p.0 == 10).for_each(|p| p.3 = false);
        kill_tree(&mut t, &mut w).expect("nada nuestro que matar");
        assert!(w.alive(31) && w.killed.is_empty(), "el grupo ajeno con el líder muerto no se toca");
    }

    #[test]
    fn un_grupo_vacio_sin_ocupante_retira_el_numero_para_siempre() {
        let mut w = arbol_unix();
        let mut t = captura(&mut w);
        kill_tree(&mut t, &mut w).unwrap();
        assert_eq!(t.pgid(), None, "el grupo murió y su número quedó libre");
        // Un ajeno reutiliza el número, lidera su grupo y tiene hijos: jamás se confunde con el nuestro.
        w.procs.push((10, 1, 8_000, true));
        w.procs.push((40, 10, 8_001, true));
        w.pg.extend([(10, 10), (40, 10)]);
        kill_tree(&mut t, &mut w).unwrap();
        assert!(w.alive(10) && w.alive(40) && w.killed.iter().all(|k| k.1 < 8_000), "ningún proceso ajeno (token >= 8000) se mató");
    }

    #[test]
    fn el_ocupante_zombi_sin_token_legible_solo_prueba_la_propiedad_si_la_raiz_esta_fijada() {
        // macOS: un zombi puede no tener `lstart`. Sin token no se puede comparar con el de la raíz.
        for (fijada, esperado_ok) in [(true, true), (false, false)] {
            let mut w = arbol_unix();
            let mut t = captura(&mut w);
            if fijada {
                t.pin_root();
            }
            w.zombify.push(10);
            w.holder_blind = true;
            nace_el_13_antes_de_matar_al_11(&mut w);
            let r = kill_tree(&mut t, &mut w);
            assert_eq!(r.is_ok(), esperado_ok, "fijada={fijada}: {r:?}");
            assert_eq!(w.alive(13), !esperado_ok, "fijada={fijada}");
            assert!(w.alive(30));
        }
    }

    #[test]
    fn un_miembro_del_grupo_sin_token_legible_veta_el_exito_aunque_el_grupo_sea_nuestro() {
        // La raíz fijada prueba que el grupo es nuestro; el huérfano 13 vive en él, pero su token no se puede leer: no se
        // puede verificar ni matar, y mientras exista el árbol no está probado muerto.
        let mut w = arbol_unix();
        w.procs.push((13, 1, 2, true));
        let mut t = captura(&mut w);
        t.pin_root();
        w.zombify.push(10);
        w.rows_blind = true;
        assert!(kill_tree(&mut t, &mut w).is_err());
        assert!(w.alive(13) && !w.alive(10) && !w.alive(11) && !w.alive(12), "lo verificable murió; el ilegible sigue custodiado");
        // Cuando el ilegible desaparece, sí se puede probar.
        w.procs.iter_mut().filter(|p| p.0 == 13).for_each(|p| p.3 = false);
        kill_tree(&mut t, &mut w).expect("sin el ilegible, el grupo es nuestro y está vacío");
    }

    // --- Identidad de la raíz (P2-3) ---

    #[test]
    fn un_fallo_transitorio_al_capturar_la_identidad_de_la_raiz_se_reintenta() {
        let mut w = arbol();
        w.start_flaky = 2;
        let t = captura(&mut w);
        assert_eq!(t.start(), Some(100), "la raíz recién creada tiene un pid seguro: se reintenta la consulta");
    }

    #[test]
    fn sin_identidad_de_la_raiz_y_sin_pin_no_se_mata_nada_y_la_custodia_se_conserva() {
        let mut w = arbol();
        w.no_start.push(10);
        let mut t = captura(&mut w);
        assert_eq!(t.start(), None);
        w.no_start.clear(); // la herramienta vuelve, pero sin pin el pid podría ser de otro
        let r = kill_tree(&mut t, &mut w);
        assert!(r.is_err() && w.alive(10) && w.killed.is_empty(), "{r:?}");
    }

    #[test]
    fn con_la_raiz_fijada_la_identidad_que_faltaba_se_toma_al_matar() {
        let mut w = arbol();
        w.no_start.push(10);
        let mut t = captura(&mut w);
        t.pin_root();
        w.no_start.clear();
        kill_tree(&mut t, &mut w).expect("la raíz sin reapear es nuestra: su identidad de ahora es la verdadera");
        assert!(!w.alive(10) && !w.alive(11) && !w.alive(12) && w.alive(20));
        assert_eq!(t.start(), Some(100));
    }

    #[test]
    fn con_la_raiz_fijada_y_su_identidad_aun_ilegible_se_falla_cerrado_sin_perder_lo_visto() {
        let mut w = arbol();
        w.no_start.push(10);
        let mut t = captura(&mut w);
        t.pin_root();
        assert!(kill_tree(&mut t, &mut w).is_err());
        assert!(w.alive(10) && w.killed.is_empty());
    }

    // --- Procesos ilegibles (P1-2) ---

    #[test]
    fn un_proceso_ilegible_ajeno_al_arbol_no_bloquea_el_cleanup() {
        let mut w = arbol();
        w.procs.push((40, 1, 500, true));
        w.opaque_pids.push(40); // otro usuario, /proc restringido
        let mut t = captura(&mut w);
        kill_tree(&mut t, &mut w).expect("un proceso ajeno e ilegible no impide limpiar el árbol");
        assert!(w.alive(40) && !w.alive(10) && !w.alive(11) && !w.alive(12));
    }

    #[test]
    fn un_pid_rastreado_que_se_vuelve_ilegible_esta_vivo_sin_probar_no_muerto() {
        let mut w = arbol();
        let mut t = captura(&mut w);
        w.immortal.push(12);
        assert!(kill_tree(&mut t, &mut w).is_err());
        w.immortal.clear();
        w.opaque_pids.push(12); // sigue vivo, pero /proc ya no deja leerlo
        assert!(kill_tree(&mut t, &mut w).is_err(), "ausente de la tabla NO es muerto si es ilegible");
        assert!(w.alive(12) && t.seen().iter().any(|p| p.pid == 12), "y se conserva en la custodia del árbol");
    }

    #[test]
    fn la_raiz_ilegible_no_se_da_por_muerta() {
        let mut w = arbol();
        let mut t = captura(&mut w);
        w.opaque_pids.push(10);
        assert!(kill_tree(&mut t, &mut w).is_err());
        assert!(w.alive(10) && w.killed.iter().all(|k| k.0 != 10), "la raíz ilegible no se toca ni se da por muerta");
    }

    #[test]
    fn un_hijo_ilegible_de_un_proceso_rastreado_veta_el_exito() {
        // El kernel lista a 41 entre los hijos de 11 aunque su fila no se pueda leer: puede ser un descendiente.
        let mut w = arbol();
        w.procs.push((41, 11, 600, true));
        w.opaque_pids.push(41);
        let mut t = captura(&mut w);
        assert!(kill_tree(&mut t, &mut w).is_err(), "un posible descendiente que no se puede verificar no se descarta");
        assert!(w.alive(41) && !w.alive(10), "lo verificable sí murió; el veto sobrevive a la muerte de su padre");
        assert!(kill_tree(&mut t, &mut w).is_err(), "y sigue vetando mientras el ilegible exista");
        w.procs.iter_mut().filter(|p| p.0 == 41).for_each(|p| p.3 = false);
        w.opaque_pids.clear();
        kill_tree(&mut t, &mut w).expect("cuando el ilegible desaparece, se puede probar");
    }

    #[test]
    fn sin_lista_de_hijos_un_proceso_ilegible_irrelevante_se_omite() {
        // Sin `children` el kernel no dice de quién es: se omite (no se puede atribuir ni matar), pero lo rastreado no.
        let mut w = arbol();
        w.procs.push((41, 11, 600, true));
        w.opaque_pids.push(41);
        w.no_children = true;
        let mut t = captura(&mut w);
        kill_tree(&mut t, &mut w).expect("documentado: sin atribución posible se omite");
        assert!(w.alive(41));
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
        assert_eq!(RealOs::default().ordered_starts(), cfg!(windows));
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
        let mut os = RealOs::default();
        let mut t = Tree::capture(&mut os, child.id());
        let limite = std::time::Instant::now() + Duration::from_secs(20);
        while !marcador.exists() && std::time::Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(marcador.exists(), "la raíz llegó a su segunda fase: el intermedio ya salió");
        let miembros = os.group_view(child.id()).expect("lectura del grupo").members;
        assert!(miembros.len() >= 2, "la raíz y al menos el nieto huérfano: {miembros:?}");
        assert!(miembros.iter().any(|m| m.pid != child.id()), "hay un miembro que no es la raíz (el nieto huérfano)");
        kill_tree(&mut t, &mut os).expect("el árbol entero muere y se comprueba");
        assert_eq!(os.group_view(child.id()).map(|v| v.members.len()), Some(0), "el grupo quedó vacío");
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Unix, procesos de verdad: un `sh` en su propio grupo que lanza `script`.
    #[cfg(unix)]
    fn lanza_raiz(script: &str) -> std::process::Child {
        use std::os::unix::process::CommandExt;
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", script]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        cmd.process_group(0);
        cmd.spawn().unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn hold_exit_deja_a_la_raiz_zombi_ocupando_su_pid_hasta_que_se_reapea() {
        let mut child = lanza_raiz("exit 0");
        let pid = child.id();
        assert!(hold_exit(pid), "se espera a que termine sin reapearla");
        let mut os = RealOs::default();
        let v = os.group_view(pid).expect("lectura del grupo");
        assert!(v.holder.is_some(), "zombi sin reapear: sigue ocupando su pid (y con él su número de grupo)");
        assert!(v.members.is_empty(), "pero un zombi no es un miembro vivo");
        assert!(!os.table().unwrap().iter().any(|(p, _)| *p == pid), "y la tabla lo da por muerto");
        child.wait().unwrap();
        assert!(os.group_view(pid).unwrap().holder.is_none(), "reapeada, el pid queda libre");
        assert!(!hold_exit(pid), "ya no es hijo esperable: se dice, sin colgarse");
    }

    /// Disparador B con procesos de verdad: la raíz sale por sí sola dejando un proceso en segundo plano en su grupo.
    #[cfg(unix)]
    #[test]
    fn la_raiz_real_que_sale_dejando_un_huerfano_anota_el_grupo_y_el_kill_posterior_lo_mata() {
        let mut child = lanza_raiz("sleep 60 & exit 0");
        let pid = child.id();
        let mut os = RealOs::default();
        let tree = std::sync::Mutex::new(Tree::capture(&mut os, pid));
        assert_eq!(tree.lock().unwrap().pgid(), Some(pid), "la raíz lidera su propio grupo");
        wait_root(&tree, &mut os, pid, || {
            let _ = child.wait();
        });
        let seen = tree.lock().unwrap().seen().to_vec();
        assert!(!seen.is_empty() && seen.iter().all(|p| p.pid != pid), "el sleep se anotó al salir la raíz: {seen:?}");
        assert!(!tree.lock().unwrap().pinned, "y la raíz se reapeó");
        assert_eq!(os.group_view(pid).unwrap().holder, None, "sin ocupante: ya solo el sleep reserva el número");
        assert!(!os.group_view(pid).unwrap().members.is_empty(), "el huérfano sigue vivo en el grupo");
        kill_tree(&mut tree.lock().unwrap(), &mut os).expect("anclado por el miembro anotado: se mata y se comprueba");
        assert_eq!(os.group_view(pid).map(|v| v.members.len()), Some(0), "el grupo quedó vacío");
    }

    /// Disparador A con procesos de verdad: mientras `kill_tree` tiene el árbol, el hilo que espera a la raíz NO puede
    /// reapearla, así que el zombi sigue siendo el ancla durante todo el kill.
    #[cfg(unix)]
    #[test]
    fn mientras_kill_tree_tiene_el_arbol_el_hilo_que_espera_no_reapea_la_raiz() {
        let child = lanza_raiz("sleep 60 & sleep 60 & wait");
        let pid = child.id();
        let mut os = RealOs::default();
        let tree = std::sync::Arc::new(std::sync::Mutex::new(Tree::capture(&mut os, pid)));
        // Espera a que el grupo tenga a sus tres miembros.
        let limite = std::time::Instant::now() + Duration::from_secs(20);
        while os.group_view(pid).map_or(0, |v| v.members.len()) < 3 && std::time::Instant::now() < limite {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(os.group_view(pid).unwrap().members.len() >= 3, "raíz y dos sleep");
        let waiter = {
            let tree = tree.clone();
            std::thread::spawn(move || {
                let mut child = child;
                wait_root(&tree, &mut RealOs::default(), pid, || {
                    let _ = child.wait();
                });
            })
        };
        // El hilo ya está (o va a estar) en `waitid`; el kill mata a la raíz con el candado del árbol en nuestras manos.
        let mut guard = tree.lock().unwrap();
        kill_tree(&mut guard, &mut os).expect("el árbol entero muere y se comprueba");
        // La raíz murió, pero sigue zombi: el hilo que la espera no puede reapearla mientras tengamos el candado.
        std::thread::sleep(Duration::from_millis(100));
        assert!(os.group_view(pid).unwrap().holder.is_some(), "la raíz sigue ocupando su pid: nadie la reapeó durante el kill");
        drop(guard);
        waiter.join().unwrap();
        assert!(!tree.lock().unwrap().pinned && os.group_view(pid).unwrap().holder.is_none(), "después sí se reapea y se suelta el pin");
    }

    /// Linux: un proceso con un nombre que no es UTF-8 hace que `read_to_string` falle en SU `stat`; eso ya no invalida la
    /// tabla (los nombres los elige cada proceso: cualquiera podía bloquear el cleanup de todas las Tasks).
    #[cfg(target_os = "linux")]
    #[test]
    fn un_proceso_real_con_nombre_no_utf8_no_invalida_la_tabla() {
        let anterior = std::fs::read("/proc/self/comm").unwrap();
        std::fs::write("/proc/self/comm", b"\xff\xfe)(\xe9").unwrap();
        let stat = std::fs::read("/proc/self/stat").unwrap();
        let (tabla, inicio, vista) = (process_table(), start_time(std::process::id()), RealOs::default().group_view(std::process::id()));
        let _ = std::fs::write("/proc/self/comm", anterior);
        assert!(String::from_utf8(stat).is_err(), "precondición: el nombre no es UTF-8 y read_to_string lo habría rechazado");
        assert!(tabla.is_some_and(|t| t.iter().any(|(p, _)| *p == std::process::id())), "la tabla se lee y contiene este proceso");
        assert!(inicio.is_some() && vista.is_some());
    }

    // --- Identidad fuerte en Linux (starttime en ticks) y reutilización de pid en el mismo instante ---

    #[test]
    fn proc_stat_da_ppid_pgrp_y_starttime_de_una_sola_lectura() {
        let tail = "S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 5000 300 18446744073709551615";
        let fila = |nombre: &[u8], tail: &str| [b"77 (".as_slice(), nombre, format!(") {tail}\n").as_bytes()].concat();
        let r = parse_proc_stat(77, &fila(b"bash", tail)).unwrap();
        assert_eq!((r.pid, r.ppid, r.pgid, r.zombie, r.start), (77, 1, 1234, false, Some(987_654)));
        let raro = parse_proc_stat(77, &fila(b"we ird) na)me", tail)).unwrap();
        assert_eq!((raro.ppid, raro.pgid, raro.start), (1, 1234, Some(987_654)), "el nombre puede traer espacios y paréntesis");
        let zombi = parse_proc_stat(77, &fila(b"x", &tail.replacen("S ", "Z ", 1))).unwrap();
        assert!(zombi.zombie, "un zombi cuenta como muerto");
        assert!(parse_proc_stat(77, b"77 (corto) S 1 2").is_none());
        assert!(parse_proc_stat(77, "sin paréntesis".as_bytes()).is_none());
        assert!(parse_proc_stat(77, &fila(b"x", &tail.replace("987654", "no-numero"))).is_none());
    }

    #[test]
    fn el_nombre_del_proceso_no_utf8_no_impide_leer_su_fila() {
        // `comm` lo elige el proceso (`prctl(PR_SET_NAME)`): puede ser latin-1, bytes sueltos o cualquier cosa. Con
        // `read_to_string` esa fila (y con ella TODA la tabla) dejaba de leerse.
        let tail = "S 4 55 55 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 424242 0 0 0";
        for nombre in [&b"\xff\xfe"[..], b"caf\xe9 (latin-1)", b"\x80\x81)\n(", b")(", b""] {
            let bytes = [b"55 (".as_slice(), nombre, format!(") {tail}\n").as_bytes()].concat();
            let r = parse_proc_stat(55, &bytes).unwrap_or_else(|| panic!("la fila con nombre {nombre:?} se lee"));
            assert_eq!((r.ppid, r.pgid, r.start), (4, 55, Some(424_242)));
        }
        let invalido = [b"55 (".as_slice(), b"\xff\xfe", format!(") {tail}\n").as_bytes()].concat();
        assert!(String::from_utf8(invalido).is_err(), "la muestra es justo lo que read_to_string rechazaba");
        // Lo que sigue al nombre es ASCII del kernel: si NO lo es, la fila no se entiende (lectura dudosa).
        assert!(parse_proc_stat(55, b"55 (a) S 4 55 55 \xff\xfe").is_none());
    }

    fn lee(texto: &str) -> StatRead {
        StatRead::Bytes(texto.as_bytes().to_vec())
    }

    #[test]
    fn la_lectura_de_proc_clasifica_cada_error_y_solo_lo_ajeno_e_ilegible_es_opaco() {
        use std::io::{Error, ErrorKind};
        let ajeno = || Ok(true);
        let propio = || Ok(false);
        let nada = || -> std::io::Result<bool> { panic!("no se consulta el dueño sin permiso denegado") };
        assert_eq!(classify_stat_read(Ok(b"x".to_vec()), nada), StatRead::Bytes(b"x".to_vec()));
        assert_eq!(classify_stat_read(Err(Error::from_raw_os_error(2)), nada), StatRead::Gone, "ENOENT: desapareció");
        assert_eq!(classify_stat_read(Err(Error::from_raw_os_error(3)), nada), StatRead::Gone, "ESRCH: desapareció");
        assert_eq!(classify_stat_read(Err(Error::new(ErrorKind::PermissionDenied, "x")), ajeno), StatRead::Opaque, "EACCES de otro usuario");
        assert_eq!(classify_stat_read(Err(Error::from_raw_os_error(1)), ajeno), StatRead::Opaque, "EPERM de otro usuario");
        assert_eq!(classify_stat_read(Err(Error::new(ErrorKind::PermissionDenied, "x")), propio), StatRead::Broken, "ilegible siendo NUESTRO: anomalía");
        assert_eq!(classify_stat_read(Err(Error::new(ErrorKind::PermissionDenied, "x")), || Err(Error::new(ErrorKind::NotFound, "x"))), StatRead::Gone, "el directorio desapareció entre medias");
        assert_eq!(classify_stat_read(Err(Error::new(ErrorKind::PermissionDenied, "x")), || Err(Error::from(ErrorKind::TimedOut))), StatRead::Broken);
        assert_eq!(classify_stat_read(Err(Error::from(ErrorKind::TimedOut)), nada), StatRead::Broken, "un fallo no clasificado no prueba nada");
        assert_eq!(classify_stat_read(Err(Error::from(ErrorKind::OutOfMemory)), nada), StatRead::Broken);
    }

    #[test]
    fn una_lectura_de_proc_con_un_proceso_ajeno_ilegible_o_un_nombre_raro_sigue_siendo_fiable() {
        let tail = "S 1 9 9 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0 0";
        let reads = vec![
            (9, lee(&format!("9 (ok) {tail}"))),
            (10, StatRead::Opaque), // proceso de otro usuario con /proc restringido
            (11, StatRead::Gone),
            (12, StatRead::Bytes([b"12 (\xff) ".as_slice(), tail.as_bytes()].concat())),
        ];
        let (rows, opaque) = rows_from_reads(reads).expect("un proceso ajeno ilegible NO invalida la tabla");
        assert_eq!(rows.iter().map(|r| r.pid).collect::<Vec<_>>(), vec![9, 12]);
        assert_eq!(opaque, vec![10]);
        // Lo que SÍ invalida la lectura: un fallo no clasificado, o un archivo legible que no se entiende.
        assert!(rows_from_reads(vec![(9, lee(&format!("9 (ok) {tail}"))), (10, StatRead::Broken)]).is_none());
        assert!(rows_from_reads(vec![(9, lee("basura"))]).is_none());
    }

    #[test]
    fn dos_procesos_con_el_mismo_pid_y_un_tick_de_diferencia_no_comparten_identidad() {
        // El pid se reutiliza y el nuevo proceso empieza solo 10 ms (1 tick) después: con ticks los tokens difieren.
        let base = "S 1 50 50 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0";
        let viejo = parse_proc_stat(50, format!("50 (a) {base} 1000 0").as_bytes()).unwrap();
        let nuevo = parse_proc_stat(50, format!("50 (a) {base} 1001 0").as_bytes()).unwrap();
        assert_ne!(viejo.start, nuevo.start);
    }

    #[test]
    fn un_pid_reutilizado_en_el_instante_siguiente_se_poda_y_no_se_mata() {
        let mut w = arbol_sin_orden();
        let mut t = captura(&mut w);
        w.immortal.push(12);
        assert!(kill_tree(&mut t, &mut w).is_err());
        let viejo = t.seen().iter().find(|p| p.pid == 12).unwrap().start;
        w.immortal.clear();
        w.procs.iter_mut().filter(|p| p.0 == 12).for_each(|p| p.3 = false);
        // Mismo pid, token adyacente (+1 y -1), y estando en el MISMO grupo que los miembros: aun así es otro proceso.
        for (pid_ajeno, tok) in [(12u32, viejo + 1), (12u32, viejo - 1)] {
            let mut w2 = arbol_sin_orden();
            let mut t2 = captura(&mut w2);
            w2.leader = true;
            w2.immortal.push(12);
            assert!(kill_tree(&mut t2, &mut w2).is_err());
            w2.immortal.clear();
            w2.procs.iter_mut().filter(|p| p.0 == pid_ajeno).for_each(|p| p.3 = false);
            w2.procs.push((pid_ajeno, 1, tok, true));
            kill_tree(&mut t2, &mut w2).unwrap();
            assert!(w2.alive(pid_ajeno) && w2.killed.iter().all(|k| !(k.0 == pid_ajeno && k.1 == tok)), "el ajeno con token {tok} no se mató");
        }
    }

    #[test]
    fn las_filas_de_ps_se_leen_con_su_token_y_lo_dudoso_invalida_la_lectura() {
        let ok = "  10     1    10 S    Wed Oct 15 10:20:30 2026\n  12     1    10 Z+   Wed Oct  5 09:00:01 2026\n";
        let rows = parse_ps_rows(ok).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].pid, rows[0].ppid, rows[0].pgid, rows[0].zombie), (10, 1, 10, false));
        assert!(rows[0].start.is_some() && rows[1].start.is_some());
        assert!(rows[1].zombie);
        assert_eq!(lstart_token("Wed Oct  5 09:00:01 2026"), lstart_token("Wed Oct 5 09:00:01 2026"), "los espacios dobles no cambian el token");
        assert_ne!(lstart_token("Wed Oct 15 10:20:30 2026"), lstart_token("Wed Oct 15 10:20:31 2026"));
        assert!(parse_ps_rows("10 1 S Wed Oct 15 10:20:30 2026").is_none(), "falta una columna numérica");
        assert!(parse_ps_rows("x 1 10 S Wed Oct 15 10:20:30 2026").is_none(), "pid no numérico");
        assert!(parse_ps_rows("10 1 10").is_none(), "falta el estado");
        assert_eq!(parse_ps_rows("").map(|r| r.len()), Some(0));
    }

    #[test]
    fn una_fila_de_ps_sin_lstart_no_envenena_el_resto_de_la_lectura() {
        // macOS puede imprimir `lstart` vacío en zombis y procesos que salen: esa fila queda sin token, las demás se leen.
        let texto = "  10     1    10 S    Wed Oct 15 10:20:30 2026\n  12    10    10 Z\n  13    10    10 E    Wed Oct\n  14     1    14 S    Wed Oct 15 10:20:31 2026\n";
        let rows = parse_ps_rows(texto).expect("una fila sin lstart no invalida la lectura");
        assert_eq!(rows.iter().map(|r| (r.pid, r.start.is_some())).collect::<Vec<_>>(), vec![(10, true), (12, false), (13, false), (14, true)]);
        // El zombi sin token no es miembro vivo del grupo; la fila viva SIN token sí cuenta, como miembro ilegible (sin probar).
        let v = group_view_of(&rows, 10);
        assert_eq!(v.members.iter().map(|m| m.pid).collect::<Vec<_>>(), vec![10]);
        assert!(v.unreadable, "13 está vivo, en el grupo y no se puede verificar");
        assert_eq!(v.holder, Some(Holder { start: rows[0].start }));
        // Una fila sin token que no es del grupo no afecta.
        assert!(!group_view_of(&rows, 14).unreadable);
    }

    #[test]
    fn ps_fija_el_entorno_para_que_el_token_de_lstart_no_dependa_de_la_zona_horaria() {
        // `lstart` sale en hora LOCAL: sin TZ fijo, un cambio de zona entre dos lecturas cambia el token del MISMO proceso.
        assert!(PS_ENV.contains(&("TZ", "UTC")) && PS_ENV.contains(&("LC_ALL", "C")));
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
        let mut os = RealOs::default();
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
