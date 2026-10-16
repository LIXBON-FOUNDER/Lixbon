//! Espera de aprobación en la terminal del agente y agente inactivo.
//!
//! La prueba de punta a punta (bb0b013) dejó a Claude en Delegar colgado 903 s en
//! el diálogo «This command requires approval»: nadie mira la terminal. El host lo
//! detecta en la salida de la PTY (sin depender de los códigos ANSI ni de los cortes
//! de ConPTY), pasa la tarea a `awaiting_terminal_approval` con `approval_deadline` y,
//! si vence `LIXBON_TERMINAL_APPROVAL_TTL_SECS`, la cierra Failed con
//! `failure_reason: "terminal_approval_timeout"` y mata el árbol de procesos.
//! Aparte, si la PTY no escribe nada durante `LIXBON_AGENT_IDLE_TTL_SECS`, Failed con
//! `failure_reason: "agent_idle_timeout"`.

use std::time::Duration;

/// Texto exacto del aviso de Claude Code 2.1.296 (log de Delegar de la prueba de punta a punta).
pub const PROMPT: &str = "This command requires approval";
pub const APPROVAL_TTL_ENV: &str = "LIXBON_TERMINAL_APPROVAL_TTL_SECS";
pub const IDLE_TTL_ENV: &str = "LIXBON_AGENT_IDLE_TTL_SECS";
pub const DEFAULT_APPROVAL_TTL: Duration = Duration::from_secs(300);
pub const DEFAULT_IDLE_TTL: Duration = Duration::from_secs(1800);
pub const APPROVAL_TIMEOUT: &str = "terminal_approval_timeout";
pub const IDLE_TIMEOUT: &str = "agent_idle_timeout";
/// Tras entrar en la espera, la TUI aún repinta el diálogo un rato: no cuenta como avance.
const SETTLE_MS: u64 = 2000;
/// Letras o cifras que tiene que traer un trozo de salida para contar como avance
/// (el spinner `●` y los repintados vacíos no cuentan).
const MIN_PROGRESS: usize = 12;
const DIALOG_WORDS: &[&str] = &["requiresapproval", "doyouwanttoproceed", "esctocancel", "tabtoamend", "automode", "don'taskagain", "donotaskagain"];

/// TTL de una variable de entorno en segundos; si falta o no vale, el de por defecto.
pub fn ttl_from_env(var: &str, default: Duration) -> Duration {
    std::env::var(var).ok().and_then(|v| v.trim().parse::<u64>().ok()).filter(|s| *s > 0).map(Duration::from_secs).unwrap_or(default)
}

/// Texto visible sin ANSI, sin espacios ni saltos y en minúsculas: así no importan
/// los colores, el cursor ni los cortes de línea de ConPTY.
pub fn compact(raw: &str) -> String {
    super::pty::plain(raw).chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect()
}

fn prompt_key() -> String {
    PROMPT.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase).collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    /// Entró en la espera; `approval_deadline` en ms epoch.
    Entered(u64),
    /// El agente siguió y volvió a escribir: sale de la espera.
    Left,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Timeout {
    Approval,
    Idle,
}

impl Timeout {
    pub fn reason(self) -> &'static str {
        match self {
            Timeout::Approval => APPROVAL_TIMEOUT,
            Timeout::Idle => IDLE_TIMEOUT,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Timeout::Approval => "nadie aprobó en la terminal a tiempo: se cerró el agente",
            Timeout::Idle => "el agente no escribió nada durante demasiado tiempo: se cerró",
        }
    }
}

/// Estado de vigilancia de una terminal. Sin efectos: los tiempos llegan de fuera.
#[derive(Clone, Debug)]
pub struct Guard {
    approval_ttl_ms: u64,
    idle_ttl_ms: u64,
    last_output: u64,
    entered_at: Option<u64>,
    deadline: Option<u64>,
    /// Final de la salida compactada: el aviso puede llegar partido en dos trozos.
    tail: String,
}

impl Guard {
    pub fn new(approval_ttl: Duration, idle_ttl: Duration, now: u64) -> Guard {
        Guard { approval_ttl_ms: approval_ttl.as_millis() as u64, idle_ttl_ms: idle_ttl.as_millis() as u64, last_output: now, entered_at: None, deadline: None, tail: String::new() }
    }

    pub fn from_env(now: u64) -> Guard {
        Guard::new(ttl_from_env(APPROVAL_TTL_ENV, DEFAULT_APPROVAL_TTL), ttl_from_env(IDLE_TTL_ENV, DEFAULT_IDLE_TTL), now)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn deadline(&self) -> Option<u64> {
        self.deadline
    }

    /// Cada trozo de salida de la PTY.
    pub fn on_output(&mut self, raw: &str, now: u64) -> Option<Change> {
        if raw.is_empty() {
            return None;
        }
        self.last_output = now;
        let c = compact(raw);
        let key = prompt_key();
        self.tail.push_str(&c);
        if self.tail.contains(&key) {
            self.tail.clear();
            if self.deadline.is_none() {
                let d = now + self.approval_ttl_ms;
                self.entered_at = Some(now);
                self.deadline = Some(d);
                return Some(Change::Entered(d));
            }
            return None;
        }
        let keep = key.len() * 2;
        if self.tail.len() > keep {
            let mut cut = self.tail.len() - keep;
            while !self.tail.is_char_boundary(cut) {
                cut += 1;
            }
            self.tail.drain(..cut);
        }
        let settled = self.entered_at.is_some_and(|t| now.saturating_sub(t) >= SETTLE_MS);
        let progress = c.chars().filter(|ch| ch.is_alphanumeric()).count() >= MIN_PROGRESS && !DIALOG_WORDS.iter().any(|w| c.contains(w));
        if self.deadline.is_some() && settled && progress {
            self.deadline = None;
            self.entered_at = None;
            return Some(Change::Left);
        }
        None
    }

    /// Se consulta periódicamente mientras el proceso siga vivo.
    pub fn check(&self, now: u64) -> Option<Timeout> {
        if self.deadline.is_some_and(|d| now >= d) {
            return Some(Timeout::Approval);
        }
        if now.saturating_sub(self.last_output) >= self.idle_ttl_ms {
            return Some(Timeout::Idle);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: u64 = 1000;

    fn g() -> Guard {
        Guard::new(Duration::from_secs(5), Duration::from_secs(30), 0)
    }

    #[test]
    fn detecta_el_aviso_sin_depender_de_ansi_ni_cortes() {
        let mut w = g();
        assert_eq!(w.on_output("\x1b[1mThis com", S), None);
        assert_eq!(w.on_output("mand re\x1b[38;5;245mquires\r\n  appr", S), None);
        assert_eq!(w.on_output("oval\x1b[0m\r\nDo you want to proceed?", 2 * S), Some(Change::Entered(2 * S + 5 * S)));
        assert_eq!(w.deadline(), Some(7 * S));
        // Repetir el aviso no reinicia el plazo.
        assert_eq!(w.on_output("This command requires approval", 3 * S), None);
        assert_eq!(w.deadline(), Some(7 * S));
        // Compactado como lo deja ConPTY (sin espacios) también vale.
        let mut w = g();
        assert!(matches!(w.on_output("Thiscommandrequiresapproval", S), Some(Change::Entered(_))));
    }

    #[test]
    fn vence_con_ttl_corto() {
        let mut w = g();
        w.on_output(PROMPT, S);
        // El spinner sigue escribiendo pero no es avance.
        for t in 2..6 {
            assert_eq!(w.on_output("\r\n●\r\n \x1b[K", t * S), None);
        }
        assert_eq!(w.check(5 * S), None);
        assert_eq!(w.check(6 * S), Some(Timeout::Approval));
        assert_eq!(Timeout::Approval.reason(), "terminal_approval_timeout");
    }

    #[test]
    fn sale_de_la_espera_si_el_agente_sigue() {
        let mut w = g();
        w.on_output(PROMPT, S);
        // El repintado del diálogo justo después no cuenta.
        assert_eq!(w.on_output("1. Yes 2. Yes, and don't ask again 3. No  Esc to cancel", 2 * S), None);
        assert_eq!(w.on_output("Leyendo src/main.rs y escribiendo NOTAS.md", 2 * S + 500), None);
        assert_eq!(w.on_output("Leyendo src/main.rs y escribiendo NOTAS.md", 4 * S), Some(Change::Left));
        assert_eq!(w.deadline(), None);
        assert_eq!(w.check(10 * S), None);
    }

    #[test]
    fn inactivo_independiente_de_la_aprobacion() {
        let mut w = Guard::new(Duration::from_secs(300), Duration::from_secs(3), 0);
        w.on_output("hola", S);
        assert_eq!(w.check(3 * S), None);
        assert_eq!(w.check(4 * S), Some(Timeout::Idle));
        assert_eq!(Timeout::Idle.reason(), "agent_idle_timeout");
        // Cualquier byte reinicia el reloj de inactividad (también el spinner).
        w.on_output("●", 4 * S);
        assert_eq!(w.check(6 * S), None);
    }

    #[test]
    fn ttl_desde_el_entorno() {
        std::env::set_var("LXO_TEST_TTL_X", "7");
        assert_eq!(ttl_from_env("LXO_TEST_TTL_X", DEFAULT_APPROVAL_TTL), Duration::from_secs(7));
        std::env::set_var("LXO_TEST_TTL_X", "no");
        assert_eq!(ttl_from_env("LXO_TEST_TTL_X", DEFAULT_APPROVAL_TTL), Duration::from_secs(300));
        assert_eq!(ttl_from_env("LXO_TEST_TTL_NO_EXISTE", DEFAULT_IDLE_TTL), Duration::from_secs(1800));
    }

    #[test]
    fn log_real_de_delegar_colgado() {
        // Salida grabada de Claude 2.1.296 en Delegar (prueba de punta a punta sobre bb0b013, 903 s).
        let raw = include_str!("testdata/claude-2.1.296-delegar-espera-aprobacion.txt");
        let mut w = g();
        let mut entered = None;
        // En trozos de 512 bytes, como llegaría de la PTY.
        let bytes = raw.as_bytes();
        let mut i = 0;
        let mut t = S;
        while i < bytes.len() {
            let mut j = (i + 512).min(bytes.len());
            while !raw.is_char_boundary(j) {
                j += 1;
            }
            if let Some(Change::Entered(d)) = w.on_output(&raw[i..j], t) {
                entered = Some(d);
            }
            i = j;
            t += 10;
        }
        assert!(entered.is_some(), "no se detectó la espera");
        // Lo que sigue en el log (spinner) no la saca de la espera.
        assert!(w.deadline().is_some());
    }
}

/// Falso agente en una ConPTY real: escribe el aviso de Claude y se queda colgado
/// (o sigue), con TTL cortos. Comprueba que al vencer se mata el árbol completo.
#[cfg(all(test, windows))]
mod falso_agente {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::*;
    use super::super::state::now_ms;

    struct Run {
        changes: Vec<Change>,
        timeout: Option<Timeout>,
        exited: bool,
        dir: std::path::PathBuf,
        /// ¿Existía `hijo.pid` cuando el vigilante vio el aviso, es decir, cuando empezó a contar el TTL?
        pid_al_entrar: Option<bool>,
    }

    fn run(name: &str, command: &str, approval: u64, idle: u64) -> Run {
        let dir = std::env::temp_dir().join(format!("lxo-falso-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let guard = Arc::new(Mutex::new(Guard::new(Duration::from_secs(approval), Duration::from_secs(idle), now_ms())));
        let changes = Arc::new(Mutex::new(vec![]));
        let done = Arc::new(AtomicBool::new(false));
        let (g, c, d) = (guard.clone(), changes.clone(), done.clone());
        let pid_file = dir.join("hijo.pid");
        let pid_al_entrar = Arc::new(Mutex::new(None::<bool>));
        let p2 = pid_al_entrar.clone();
        let mut term = super::super::pty::spawn(
            super::super::pty::Launch { cwd: &dir.to_string_lossy(), script_dir: &dir.join("s"), command: command.into(), env: vec![], inject: None, piped: false, owner: None },
            move |t| {
                if let Some(ch) = g.lock().unwrap().on_output(&t, now_ms()) {
                    if matches!(ch, Change::Entered(_)) {
                        *p2.lock().unwrap() = Some(pid_file.exists());
                    }
                    c.lock().unwrap().push(ch);
                }
            },
            move || d.store(true, Ordering::SeqCst),
        )
        .unwrap();
        let start = Instant::now();
        let mut timeout = None;
        while !done.load(Ordering::SeqCst) && start.elapsed() < Duration::from_secs(60) {
            if timeout.is_none() {
                if let Some(t) = guard.lock().unwrap().check(now_ms()) {
                    timeout = Some(t);
                    term.kill();
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let changes = changes.lock().unwrap().clone();
        let pid_al_entrar = *pid_al_entrar.lock().unwrap();
        Run { changes, timeout, exited: done.load(Ordering::SeqCst), dir, pid_al_entrar }
    }

    fn alive(pid: &str) -> bool {
        let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }

    /// Un agente colgado en el aviso de aprobación: al vencer el TTL se mata el árbol completo.
    ///
    /// El nieto (PowerShell) escribe su pid y SOLO DESPUÉS imprime el aviso. Así el TTL empieza a
    /// contar cuando el nieto ya existe: lo garantiza el orden del programa del propio nieto, no
    /// una carrera de tiempos. Antes imprimía el aviso `cmd` y PowerShell arrancaba a la vez; en un
    /// runner cargado PowerShell tardaba más que el TTL, se mataba el árbol antes de que existiera
    /// el nieto y la prueba fallaba sin haber comprobado nada («no se escribió el pid del nieto»).
    /// `arranque_lento_s` retrasa a propósito el arranque del nieto para demostrarlo.
    fn colgado_y_se_mata_el_arbol(nombre: &str, arranque_lento_s: u64, ttl_s: u64) {
        let lento = if arranque_lento_s > 0 { format!("Start-Sleep {arranque_lento_s}; ") } else { String::new() };
        let r = run(
            nombre,
            &format!(
                "powershell -NoProfile -Command \"{lento}$PID | Set-Content -Encoding ascii hijo.pid; 'This command requires approval'; 'Do you want to proceed?'; Start-Sleep 120\""
            ),
            ttl_s,
            60,
        );
        assert!(matches!(r.changes.as_slice(), [Change::Entered(_)]), "{:?}", r.changes);
        assert_eq!(r.timeout, Some(Timeout::Approval));
        assert!(r.exited, "la PTY no terminó tras matarla");
        // Precondición: el TTL empezó con el nieto ya vivo y con su pid escrito.
        assert_eq!(r.pid_al_entrar, Some(true), "se vio el aviso antes de que el nieto escribiera su pid: el TTL empezó sin nieto que matar");
        let pid = std::fs::read_to_string(r.dir.join("hijo.pid")).expect("hijo.pid").trim().to_string();
        // El nieto (powershell) también murió: sin zombis. Se espera a la condición observable.
        let start = Instant::now();
        while alive(&pid) {
            assert!(start.elapsed() < Duration::from_secs(10), "sigue vivo el proceso {pid}");
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn colgado_en_la_aprobacion_vence_y_mata_el_arbol() {
        colgado_y_se_mata_el_arbol("colgado", 0, 4);
    }

    /// Regresión determinista del fallo de CI: el nieto tarda MÁS que el TTL en arrancar (4 s frente
    /// a 2 s). Con el aviso impreso por `cmd` antes de que PowerShell escribiera su pid, esta
    /// misma situación hacía fallar la prueba siempre; ahora el TTL solo empieza tras el nieto.
    #[test]
    fn colgado_en_la_aprobacion_aunque_el_nieto_tarde_mas_que_el_ttl() {
        colgado_y_se_mata_el_arbol("colgado-lento", 4, 2);
    }

    #[test]
    fn si_el_agente_sigue_sale_de_la_espera() {
        let r = run(
            "sigue",
            "echo This command requires approval & ping -n 4 127.0.0.1 >nul & echo Leyendo src/main.rs y escribiendo NOTAS.md & ping -n 2 127.0.0.1 >nul",
            8,
            60,
        );
        assert!(matches!(r.changes.as_slice(), [Change::Entered(_), Change::Left]), "{:?}", r.changes);
        assert_eq!(r.timeout, None);
        assert!(r.exited);
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    #[test]
    fn agente_mudo_vence_por_inactividad() {
        let r = run("mudo", "echo hola & ping -n 30 127.0.0.1 >nul", 300, 3);
        assert!(r.changes.is_empty());
        assert_eq!(r.timeout, Some(Timeout::Idle));
        assert!(r.exited);
        let _ = std::fs::remove_dir_all(&r.dir);
    }
}
