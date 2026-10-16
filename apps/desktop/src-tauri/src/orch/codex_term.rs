//! Pestaña de terminal de Codex: la TUI interactiva de Codex en una PTY (la
//! misma de los agentes, `pty.rs`, con MIN_COLS columnas como mínimo), para que
//! la persona trabaje con Codex desde Lixbon.
//!
//! - No pasa por el orquestador: no crea tareas ni intentos y no toca el estado.
//! - No está en `Core::rpc`, así que el servidor HTTP de `lxo` no la conoce.
//! - Nunca lanza con bypass (`--dangerously-*`, `danger-full-access`, `--yolo`).
//! - Eventos: `codex-term-output` `{ term_id, seq, data }` (`seq` u64 creciente por
//!   terminal, desde 1), con `data` como TEXTO UTF-8
//!   (el mismo que la PTY de los agentes emite en `orch:term:{id}`: bytes de la
//!   PTY con sus secuencias ANSI, sin base64, sin cortar caracteres multibyte), y
//!   `codex-term-exit` `{ term_id, code }` (`code`: número o `null`).
//! - Emulador vt100 por terminal (5000 líneas de scrollback, tope de 1 MB al
//!   devolverlo): `codex_term_buffer` → `{ data, seq, cols, rows, alt_screen }` con
//!   la pantalla armada, `codex_term_redraw` fuerza a Codex a repintar, y
//!   `codex_term_list` para recuperar las pestañas tras recargar la webview, que
//!   no mata las PTY.
//! - Cerrar mata el árbol completo de procesos (taskkill /T /F en Windows, como
//!   las hijas); cerrar la ventana principal cierra todas.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

use super::agents::{self, Probe};
use super::providers::{self, Provider};
use super::pty::{self, AgentTerm};

pub const EVENT_OUTPUT: &str = "codex-term-output";
pub const EVENT_EXIT: &str = "codex-term-exit";
pub const MIN_VERSION: [u32; 3] = [0, 159, 0];
pub const NEEDS_ACK: &str = "needs_ack";
const BYPASS: &[&str] = &["--dangerously-bypass-approvals-and-sandbox", "--dangerously-skip-permissions", "danger-full-access", "--yolo", "--full-auto"];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct TermPolicy {
    pub policy: Value,
    pub argv: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Opened {
    pub term_id: String,
    pub policy: Value,
    pub argv: Vec<String>,
    pub warnings: Vec<String>,
}

fn version_tuple(v: &str) -> Option<[u32; 3]> {
    let mut it = v.split('.').map(|p| p.parse::<u32>().ok());
    Some([it.next()??, it.next()??, it.next()??])
}

/// Política sin efectos: todo lo de la CLI llega por parámetro.
pub fn build(cwd: &str, model: Option<&str>, effort: Option<&str>, probe: Option<&Probe>, list: &[Provider], windows_sandbox: Option<&str>) -> Result<TermPolicy, String> {
    let Some(probe) = probe else { return Err("Codex no está instalado o no está en el PATH de Lixbon".into()) };
    let Some(version) = probe.version.as_deref() else { return Err("No se pudo leer `codex --version`".into()) };
    match version_tuple(version) {
        Some(v) if v >= MIN_VERSION => {}
        _ => return Err(format!("Codex {version} es anterior a 0.159.0: actualízalo para abrir la terminal")),
    }
    if cwd.trim().is_empty() || cwd.chars().any(|c| "\"%^&|<>\r\n".contains(c)) {
        return Err("La carpeta tiene caracteres que no se pueden pasar a Codex".into());
    }
    let model = model.map(str::trim).filter(|m| !m.is_empty()).map(agents::safe_token).transpose()?;
    let effort = effort.map(str::trim).filter(|e| !e.is_empty()).map(agents::safe_token).transpose()?;
    let mut argv: Vec<String> = ["codex", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--cd", cwd].iter().map(|s| s.to_string()).collect();
    if let Some(m) = &model {
        argv.extend(["-m".into(), m.clone()]);
    }
    if let Some(e) = &effort {
        argv.extend(["-c".into(), format!("model_reasoning_effort={e}")]);
    }
    debug_assert!(!argv.iter().any(|a| BYPASS.contains(&a.as_str()) || a.starts_with("--dangerously")));
    let mut warnings = vec![];
    if !agents::version_verified("codex", version) {
        warnings.push(format!("Versión {version} de Codex no verificada (verificadas: {})", agents::verified_versions("codex").join(", ")));
    }
    let codex = list.iter().find(|p| p.id == "codex");
    if let (Some(m), Some(p)) = (&model, codex) {
        if !p.models.iter().any(|x| &x.id == m && x.verified) {
            warnings.push(format!("{} ({m})", agents::WARN_MODEL_UNVERIFIED));
        }
    }
    if let (Some(e), Some(p)) = (&effort, codex) {
        if !p.efforts.is_empty() && !p.efforts.iter().any(|x| x == e) {
            warnings.push(format!("{} ({e})", agents::WARN_EFFORT_UNVERIFIED));
        }
    }
    // workspace-write + on-request: con elevated, Codex edita pero no ejecuta comandos.
    if windows_sandbox == Some("elevated") {
        warnings.push(agents::WARN_ELEVATED_RW.into());
    }
    let policy = json!({
        "provider": "codex",
        "profile": "terminal",
        "cli_version": version,
        "model": model.clone().unwrap_or_else(|| agents::MODEL_FROM_CONFIG.into()),
        "effort": effort,
        "interactive": true,
        "status": if warnings.is_empty() { "ok" } else { "unverified" },
    });
    Ok(TermPolicy { policy, argv, warnings })
}

/// Reanuda una sesión guardada: `codex resume <id> …` con los mismos permisos de la
/// terminal (probado en 0.162.1: `resume` admite -s, -a, -C, -m y -c).
pub fn with_resume(mut p: TermPolicy, id: &str) -> Result<TermPolicy, String> {
    let id = super::codex_session::valid_session_id(id)?;
    p.argv.splice(1..1, ["resume".to_string(), id.clone()]);
    p.policy["resume"] = json!(id);
    Ok(p)
}

/// La línea de comando para el script de la PTY.
pub fn command_line(argv: &[String]) -> String {
    argv.iter().map(|a| if a.contains(' ') { format!("\"{a}\"") } else { a.clone() }).collect::<Vec<_>>().join(" ")
}

/// `cwd` existe, es carpeta y está dentro del workspace abierto.
pub fn check_cwd(root: Option<&Path>, cwd: &str) -> Result<PathBuf, String> {
    let root = root.ok_or("No hay carpeta de trabajo abierta")?;
    let root = std::fs::canonicalize(root).map_err(|_| "La carpeta de trabajo ya no existe".to_string())?;
    let p = std::fs::canonicalize(cwd).map_err(|_| format!("La carpeta no existe: {cwd}"))?;
    if !p.is_dir() {
        return Err(format!("No es una carpeta: {cwd}"));
    }
    if !p.starts_with(&root) {
        return Err("La carpeta está fuera de la carpeta de trabajo".into());
    }
    Ok(p)
}

/// Ruta para mostrar y pasar a la CLI (sin el prefijo `\\?\` de canonicalize).
fn display(p: &Path) -> String {
    p.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}

/// Política con la CLI instalada de verdad.
pub fn resolve(cwd: &str, model: Option<&str>, effort: Option<&str>) -> Result<TermPolicy, String> {
    let probe = agents::probe_cli("codex");
    let list = providers::list(false);
    let sandbox = agents::codex_config_text().as_deref().and_then(agents::codex_windows_sandbox);
    build(cwd, model, effort, probe.as_ref(), &list, sandbox.as_deref())
}

/// Tope de lo que devuelve `codex_term_buffer` (1 MB): se recorta el scrollback más viejo.
pub const BUFFER_CAP: usize = 1 << 20;
/// Líneas de scrollback que guarda el emulador de cada terminal.
pub const SCROLLBACK: usize = 5000;
pub const ALT_ON: &str = "\x1b[?1049h";
pub const RESET: &str = "\x1b[0m";

/// Pantalla emulada (vt100) y estado de una terminal, compartidos con los hilos
/// de la PTY. La TUI de Codex usa la pantalla alterna y mueve el cursor: los bytes
/// crudos no reconstruyen la pantalla; el emulador sí.
pub struct Output {
    parser: vt100::Parser,
    /// Último `seq` procesado (empieza en 1; 0 = nada todavía).
    pub seq: u64,
    pub exited: bool,
    pub code: Option<u32>,
}

impl Output {
    pub fn new(rows: u16, cols: u16) -> Output {
        Output { parser: vt100::Parser::new(rows.max(1), cols.max(1), SCROLLBACK), seq: 0, exited: false, code: None }
    }

    /// Procesa un trozo y devuelve su `seq`.
    pub fn push(&mut self, chunk: &str) -> u64 {
        self.seq += 1;
        self.parser.process(chunk.as_bytes());
        self.seq
    }

    pub fn set_size(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows.max(1), cols.max(1));
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.parser.screen()
    }

    /// Filas del scrollback ya formateadas, de la más vieja a la más nueva.
    fn scrollback_rows(&mut self) -> Vec<Vec<u8>> {
        let (rows, cols) = self.parser.screen().size();
        let screen = self.parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        let total = screen.scrollback();
        let mut out = Vec::with_capacity(total);
        let mut off = total;
        while off > 0 {
            screen.set_scrollback(off);
            let take = off.min(rows as usize);
            out.extend(screen.rows_formatted(0, cols).take(take));
            off -= take;
        }
        screen.set_scrollback(0);
        out
    }

    /// `{ data, seq, cols, rows, alt_screen }` para pintar en un xterm limpio.
    /// Pantalla alterna: `\x1b[?1049h` + `\x1b[0m` + estado. Normal: `\x1b[0m` +
    /// scrollback + estado. Todo sale del emulador: sin secuencias cortadas.
    pub fn render(&mut self) -> Value {
        let alt = self.parser.screen().alternate_screen();
        let (rows, cols) = self.parser.screen().size();
        let mut data: Vec<u8> = vec![];
        if alt {
            data.extend_from_slice(ALT_ON.as_bytes());
            data.extend_from_slice(RESET.as_bytes());
        } else {
            data.extend_from_slice(RESET.as_bytes());
            let state_len = self.parser.screen().state_formatted().len();
            let mut lines = self.scrollback_rows();
            // Tope de memoria: fuera las líneas más viejas.
            let mut size: usize = lines.iter().map(|l| l.len() + 6).sum::<usize>() + state_len + rows as usize * 2;
            let mut drop = 0;
            while size > BUFFER_CAP && drop < lines.len() {
                size -= lines[drop].len() + 6;
                drop += 1;
            }
            lines.drain(..drop);
            if !lines.is_empty() {
                for l in &lines {
                    data.extend_from_slice(l);
                    data.extend_from_slice(b"\x1b[0m\r\n");
                }
                // Empuja el scrollback fuera de la vista antes de redibujar la pantalla.
                data.extend(std::iter::repeat(b"\r\n".as_slice()).take(rows as usize).flatten().copied());
            }
        }
        data.extend_from_slice(&self.parser.screen().state_formatted());
        json!({ "data": String::from_utf8_lossy(&data), "seq": self.seq, "cols": cols, "rows": rows, "alt_screen": alt })
    }
}

/// Con qué se abrió la terminal (sale en `codex_term_list`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TermMeta {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub policy: Value,
    pub argv: Vec<String>,
}

/// El matador de una terminal, prestado mientras corre; al soltarse sin consumirlo vuelve a su terminal.
struct Lease<'a> {
    terms: &'a Mutex<HashMap<String, Entry>>,
    id: &'a str,
    killer: Option<pty::Killer>,
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        if let Some(k) = self.killer.take() {
            if let Some(e) = self.terms.lock().unwrap_or_else(|e| e.into_inner()).get_mut(self.id) {
                e.term.end_kill(k);
            }
        }
    }
}

struct Entry {
    term: AgentTerm,
    cwd: String,
    meta: TermMeta,
    out: Arc<Mutex<Output>>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Listed {
    pub term_id: String,
    pub cwd: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub policy: Value,
    pub argv: Vec<String>,
    pub exited: bool,
    pub code: Option<u32>,
}

/// Terminales vivas. Sobreviven a recargar la webview: solo las cierra
/// `codex_term_close` o el cierre de la app (`close_all`).
#[derive(Default)]
pub struct CodexTerms {
    terms: Mutex<HashMap<String, Entry>>,
}

// Global al proceso: el id da nombre a la carpeta del script, que no puede repetirse entre instancias.
static NEXT_TERM: AtomicU64 = AtomicU64::new(0);

impl CodexTerms {
    /// Abre una terminal con `command` (la de Codex o, en las pruebas, un falso).
    /// `emit(evento, payload)` publica los eventos; cada salida va con su `seq`
    /// y se emite con el buffer bloqueado, así buffer y eventos no se cruzan.
    pub fn open_command(
        &self,
        cwd: &Path,
        command: String,
        meta: TermMeta,
        cols: u16,
        rows: u16,
        emit: impl Fn(&str, Value) + Send + Sync + Clone + 'static,
    ) -> Result<String, String> {
        let n = NEXT_TERM.fetch_add(1, Ordering::SeqCst) + 1;
        let term_id = format!("codex-{}-{n}", std::process::id());
        let script_dir = std::env::temp_dir().join("lixbon-codex-term").join(&term_id);
        let (cols, rows) = (pty::clamp_cols(cols), rows.max(1));
        let out = Arc::new(Mutex::new(Output::new(rows, cols)));
        let (out_id, exit_id, emit_exit) = (term_id.clone(), term_id.clone(), emit.clone());
        let (out_w, out_e, dir_e) = (out.clone(), out.clone(), script_dir.clone());
        let term = pty::spawn_user(
            pty::Launch { cwd: &display(cwd), script_dir: &script_dir, command, env: vec![], inject: None, piped: false, owner: None },
            cols,
            rows,
            move |data| {
                if let Ok(mut o) = out_w.lock() {
                    let seq = o.push(&data);
                    emit(EVENT_OUTPUT, json!({ "term_id": out_id, "seq": seq, "data": data }));
                }
            },
            move |code| {
                if let Ok(mut o) = out_e.lock() {
                    o.exited = true;
                    o.code = code;
                }
                emit_exit(EVENT_EXIT, json!({ "term_id": exit_id, "code": code }));
                let _ = std::fs::remove_dir_all(&dir_e);
            },
        )?;
        let entry = Entry { term, cwd: display(cwd), meta, out };
        self.terms.lock().map_err(|_| "Estado interno corrupto")?.insert(term_id.clone(), entry);
        Ok(term_id)
    }

    pub fn write(&self, term_id: &str, data: &str) -> Result<(), String> {
        let mut t = self.terms.lock().map_err(|_| "Estado interno corrupto")?;
        t.get_mut(term_id).ok_or_else(|| format!("Terminal desconocida: {term_id}"))?.term.write(data.as_bytes())
    }

    /// El host aplica el mínimo de MIN_COLS columnas (a la PTY y al emulador).
    pub fn resize(&self, term_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let t = self.terms.lock().map_err(|_| "Estado interno corrupto")?;
        let e = t.get(term_id).ok_or_else(|| format!("Terminal desconocida: {term_id}"))?;
        e.term.resize(cols, rows)?;
        if let Ok(mut o) = e.out.lock() {
            o.set_size(rows.max(1), pty::clamp_cols(cols));
        }
        Ok(())
    }

    /// Fuerza a Codex a redibujar: una columna más y vuelta al tamaño real.
    pub fn redraw(&self, term_id: &str) -> Result<(), String> {
        let (rows, cols) = {
            let t = self.terms.lock().map_err(|_| "Estado interno corrupto")?;
            let e = t.get(term_id).ok_or_else(|| format!("Terminal desconocida: {term_id}"))?;
            let o = e.out.lock().map_err(|_| "Estado interno corrupto")?;
            o.screen().size()
        };
        self.resize(term_id, cols.saturating_add(1), rows)?;
        std::thread::sleep(std::time::Duration::from_millis(60));
        self.resize(term_id, cols, rows)
    }

    /// `{ data, seq, cols, rows, alt_screen }`: la pantalla armada y el último `seq`
    /// que incluye. Los eventos con `seq` mayor son posteriores.
    pub fn buffer(&self, term_id: &str) -> Result<Value, String> {
        let t = self.terms.lock().map_err(|_| "Estado interno corrupto")?;
        let e = t.get(term_id).ok_or_else(|| format!("Terminal desconocida: {term_id}"))?;
        let mut o = e.out.lock().map_err(|_| "Estado interno corrupto")?;
        Ok(o.render())
    }

    /// Terminales abiertas (también las que ya salieron y nadie cerró).
    pub fn list(&self) -> Vec<Listed> {
        let t = match self.terms.lock() { Ok(t) => t, Err(_) => return vec![] };
        let mut l: Vec<Listed> = t.iter().map(|(id, e)| {
            let (exited, code) = e.out.lock().map(|o| (o.exited, o.code)).unwrap_or((false, None));
            Listed {
                term_id: id.clone(), cwd: e.cwd.clone(), model: e.meta.model.clone(), effort: e.meta.effort.clone(),
                policy: e.meta.policy.clone(), argv: e.meta.argv.clone(), exited, code,
            }
        }).collect();
        l.sort_by(|a, b| a.term_id.cmp(&b.term_id));
        l
    }

    /// Mata el árbol de procesos de la terminal COMPROBANDO el resultado y solo entonces la quita de la lista. Si el
    /// kill falla (o ya hay otro cerrándola) la terminal SIGUE en la lista con su matador: el proceso puede seguir vivo
    /// y no se suelta un `AgentTerm` sin dueño. El mapa no se bloquea mientras corre el matador.
    pub fn close(&self, term_id: &str) -> Result<(), String> {
        let killer = {
            let mut t = self.terms.lock().map_err(|_| "Estado interno corrupto")?;
            let e = t.get_mut(term_id).ok_or_else(|| format!("Terminal desconocida: {term_id}"))?;
            e.term.begin_kill().map_err(|e| format!("No se pudo cerrar {term_id}: {e}"))?
        };
        // Si el kill falla o entra en pánico, el `Drop` devuelve el matador a su terminal.
        let mut lease = Lease { terms: &self.terms, id: term_id, killer: Some(killer) };
        match lease.killer.as_mut().map_or(Ok(()), |k| k.kill()) {
            Ok(()) => {
                lease.killer = None;
                self.terms.lock().unwrap_or_else(|e| e.into_inner()).remove(term_id);
                Ok(())
            }
            Err(e) => Err(format!("No se pudo cerrar {term_id}: {e}. La terminal sigue abierta y bajo la custodia de Lixbon")),
        }
    }

    /// Al cerrar la ventana principal o la app. Cierra todas las que puede; las que no se pueden matar siguen en la
    /// lista (custodiadas) y se devuelven en el `Err`, con su motivo.
    pub fn close_all(&self) -> Result<(), String> {
        let ids: Vec<String> = self.terms.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
        let failures: Vec<String> = ids.iter().filter_map(|id| self.close(id).err()).collect();
        if failures.is_empty() { Ok(()) } else { Err(failures.join("; ")) }
    }

    pub fn len(&self) -> usize {
        self.terms.lock().map(|t| t.len()).unwrap_or(0)
    }

    /// Prueba: registra una terminal sin proceso, con el matador que se indique.
    #[cfg(test)]
    pub(crate) fn insert_for_tests(&self, term_id: &str, term: AgentTerm) {
        let out = Arc::new(Mutex::new(Output::new(24, pty::MIN_COLS)));
        let entry = Entry { term, cwd: String::new(), meta: TermMeta::default(), out };
        self.terms.lock().unwrap().insert(term_id.to_string(), entry);
    }
}

/// `codex_term_open` sin Tauri: valida, exige `acknowledged` si hay avisos y abre.
pub fn open(
    terms: &CodexTerms,
    root: Option<&Path>,
    cwd: &str,
    model: Option<&str>,
    effort: Option<&str>,
    cols: Option<u16>,
    rows: Option<u16>,
    acknowledged: bool,
    policy: impl FnOnce(&str) -> Result<TermPolicy, String>,
    emit: impl Fn(&str, Value) + Send + Sync + Clone + 'static,
) -> Result<Opened, String> {
    let dir = check_cwd(root, cwd)?;
    let p = policy(&display(&dir))?;
    let clean = |v: Option<&str>| v.map(str::trim).filter(|x| !x.is_empty()).map(str::to_string);
    if !p.warnings.is_empty() && !acknowledged {
        return Err(format!("{NEEDS_ACK}: {}", p.warnings.join(" | ")));
    }
    let meta = TermMeta { model: clean(model), effort: clean(effort), policy: p.policy.clone(), argv: p.argv.clone() };
    let term_id = terms.open_command(&dir, command_line(&p.argv), meta, cols.unwrap_or(pty::MIN_COLS), rows.unwrap_or(32), emit)?;
    Ok(Opened { term_id, policy: p.policy, argv: p.argv, warnings: p.warnings })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(v: &str) -> Probe {
        Probe { version: Some(v.into()), ..Default::default() }
    }

    fn list() -> Vec<Provider> {
        vec![providers::codex(true, Some("0.162.1"), Some(include_str!("testdata/codex-0.162.1-debug-models.json")), None)]
    }

    #[test]
    fn argv_por_defecto() {
        let p = build(r"C:\repo", None, None, Some(&probe("0.162.1")), &list(), None).unwrap();
        assert_eq!(p.argv, ["codex", "--sandbox", "workspace-write", "--ask-for-approval", "on-request", "--cd", r"C:\repo"]);
        assert!(p.warnings.is_empty(), "{:?}", p.warnings);
        assert_eq!(p.policy["model"], agents::MODEL_FROM_CONFIG);
        assert_eq!(p.policy["status"], "ok");
        assert_eq!(p.policy["interactive"], true);
        assert_eq!(command_line(&build(r"C:\Mis Documentos\r", None, None, Some(&probe("0.162.1")), &list(), None).unwrap().argv),
            r#"codex --sandbox workspace-write --ask-for-approval on-request --cd "C:\Mis Documentos\r""#);
    }

    #[test]
    fn con_modelo_y_esfuerzo() {
        let p = build("/r", Some("gpt-6.1-sol"), Some("ultra"), Some(&probe("0.162.1")), &list(), None).unwrap();
        assert_eq!(&p.argv[7..], ["-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=ultra"]);
        assert!(p.warnings.is_empty());
        // No verificados: avisos, no error.
        let p = build("/r", Some("gpt-9"), Some("turbo"), Some(&probe("0.162.1")), &list(), None).unwrap();
        assert_eq!(p.warnings, vec![format!("{} (gpt-9)", agents::WARN_MODEL_UNVERIFIED), format!("{} (turbo)", agents::WARN_EFFORT_UNVERIFIED)]);
        assert_eq!(p.policy["status"], "unverified");
        // Elevated: el mismo aviso que Delegar; no se bloquea, queda unverified y pide ack.
        let p = build("/r", None, None, Some(&probe("0.162.1")), &list(), Some("elevated")).unwrap();
        assert_eq!(p.warnings, vec![agents::WARN_ELEVATED_RW.to_string()]);
        assert_eq!(p.policy["status"], "unverified");
        let p = build("/r", None, None, Some(&probe("0.162.1")), &list(), Some("unelevated")).unwrap();
        assert!(p.warnings.is_empty() && p.policy["status"] == "ok");
        // Inyección en el modelo: error.
        assert!(build("/r", Some("x & del"), None, Some(&probe("0.162.1")), &list(), None).is_err());
    }

    #[test]
    fn sin_codex_o_version_vieja() {
        assert!(build("/r", None, None, None, &list(), None).unwrap_err().contains("no está instalado"));
        assert!(build("/r", None, None, Some(&probe("0.158.9")), &list(), None).unwrap_err().contains("anterior a 0.159.0"));
        assert!(build("/r", None, None, Some(&Probe::default()), &list(), None).unwrap_err().contains("--version"));
        let p = build("/r", None, None, Some(&probe("0.170.0")), &list(), None).unwrap();
        assert!(p.warnings[0].contains("0.170.0 de Codex no verificada"));
    }

    #[test]
    fn nunca_bypass() {
        for (m, e, sb) in [(None, None, None), (Some("gpt-6.1-sol"), Some("high"), Some("elevated"))] {
            let p = build("/r", m, e, Some(&probe("0.162.1")), &list(), sb).unwrap();
            for a in &p.argv {
                assert!(!BYPASS.contains(&a.as_str()) && !a.starts_with("--dangerously") && a != "never", "{a}");
            }
        }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lxo-codex-term-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        d
    }

    #[test]
    fn cwd_invalido_y_needs_ack() {
        let root = tmp("cwd");
        let terms = CodexTerms::default();
        let pol = |w: Vec<String>| move |cwd: &str| Ok(TermPolicy { policy: json!({}), argv: vec!["codex".into(), "--cd".into(), cwd.into()], warnings: w });
        let noop = |_: &str, _: Value| {};
        let o = |cwd: &str, ack: bool, w: Vec<String>| open(&terms, Some(&root), cwd, None, None, None, None, ack, pol(w), noop);
        assert!(o(&root.join("no-existe").to_string_lossy(), true, vec![]).unwrap_err().contains("no existe"));
        let fuera = std::env::temp_dir();
        assert!(o(&fuera.to_string_lossy(), true, vec![]).unwrap_err().contains("fuera"));
        std::fs::write(root.join("f.txt"), "x").unwrap();
        assert!(o(&root.join("f.txt").to_string_lossy(), true, vec![]).unwrap_err().contains("No es una carpeta"));
        assert!(open(&terms, None, &root.to_string_lossy(), None, None, None, None, true, pol(vec![]), noop).unwrap_err().contains("No hay carpeta"));
        // Con avisos y sin acknowledged: needs_ack y no se abre nada.
        let e = o(&root.join("sub").to_string_lossy(), false, vec!["aviso".into()]).unwrap_err();
        assert!(e.starts_with("needs_ack") && e.contains("aviso"), "{e}");
        assert_eq!(terms.len(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Pinta `data` en un emulador limpio del mismo tamaño.
    pub(super) fn replay(v: &Value) -> vt100::Parser {
        let mut p = vt100::Parser::new(v["rows"].as_u64().unwrap() as u16, v["cols"].as_u64().unwrap() as u16, SCROLLBACK);
        p.process(v["data"].as_str().unwrap().as_bytes());
        p
    }

    #[test]
    fn pantalla_alterna_con_cursor_se_reconstruye() {
        let mut o = Output::new(10, 200);
        let mut seqs = vec![];
        for chunk in ["linea normal 1\r\n", "\x1b[?1049h\x1b[2J\x1b[H", "\x1b[5;10H\x1b[1;31mrojo\x1b[0m", "\x1b[2;1Harriba ñandú", "\x1b[8;3H› escribe aquí", "\x1b[3;40H"] {
            seqs.push(o.push(chunk));
        }
        assert_eq!(seqs, [1, 2, 3, 4, 5, 6]);
        let v = o.render();
        assert_eq!(v["alt_screen"], true);
        assert_eq!(v["seq"], 6);
        let d = v["data"].as_str().unwrap();
        assert!(d.starts_with("\x1b[?1049h\x1b[0m"), "{d:?}");
        let r = replay(&v);
        assert!(r.screen().alternate_screen());
        assert_eq!(r.screen().contents(), o.screen().contents());
        assert_eq!(r.screen().cursor_position(), (2, 39));
        assert!(r.screen().cell(4, 9).unwrap().bold() || r.screen().cell(4, 9).unwrap().fgcolor() != vt100::Color::Default);
        // Sale de la alterna: vuelve la normal y data ya no lleva 1049h.
        o.push("\x1b[?1049l");
        let v = o.render();
        assert_eq!(v["alt_screen"], false);
        assert!(v["data"].as_str().unwrap().starts_with("\x1b[0m") && !v["data"].as_str().unwrap().contains("\x1b[?1049h"));
        assert_eq!(replay(&v).screen().contents(), o.screen().contents());
    }

    #[test]
    fn cortes_de_utf8_y_ansi_sin_basura() {
        // La PTY entrega texto ya entero (pty.rs no parte multibyte), pero una
        // secuencia ANSI sí puede llegar partida: el emulador la junta.
        let mut o = Output::new(5, 200);
        for chunk in ["hola \x1b[3", "2mverde\x1b", "[0m ñ", "andú €", "\x1b[2;5Hfin"] {
            o.push(chunk);
        }
        let c = o.screen().contents();
        assert!(c.starts_with("hola verde ñandú €"), "{c:?}");
        assert!(!c.contains('[') && !c.contains('\u{1b}'));
        let v = o.render();
        let d = v["data"].as_str().unwrap();
        assert!(!d.contains('\u{fffd}'));
        assert_eq!(replay(&v).screen().contents(), c);
    }

    #[test]
    fn scrollback_con_tope() {
        let mut o = Output::new(5, 200);
        for i in 0..(SCROLLBACK + 300) {
            o.push(&format!("linea {i}\r\n"));
        }
        let total = {
            let s = o.parser.screen_mut();
            s.set_scrollback(usize::MAX);
            let n = s.scrollback();
            s.set_scrollback(0);
            n
        };
        assert_eq!(total, SCROLLBACK);
        let v = o.render();
        let d = v["data"].as_str().unwrap();
        assert!(d.starts_with("\x1b[0m"));
        assert!(d.len() <= BUFFER_CAP + 4096);
        // Lo más viejo se perdió (5 filas en pantalla + SCROLLBACK de historia, menos el tope de bytes);
        // lo que queda es un sufijo contiguo que llega hasta la última línea.
        let nums: Vec<usize> = d.split("linea ").skip(1)
            .filter_map(|t| t.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()).collect();
        let first = nums[0];
        assert!(first >= 295, "primera línea {first}");
        assert_eq!(*nums.last().unwrap(), SCROLLBACK + 299);
        assert_eq!(nums, (first..=SCROLLBACK + 299).collect::<Vec<_>>());
        let r = replay(&v);
        assert_eq!(r.screen().contents(), o.screen().contents());
        assert_eq!(v["seq"].as_u64().unwrap(), (SCROLLBACK + 300) as u64);
    }

    #[test]
    fn no_se_expone_por_http_ni_toca_el_estado() {
        let core = super::super::Orch::default().0;
        core.settings.lock().unwrap().enabled = true;
        for c in ["codex_term_open", "codex_term_policy", "codex_term_write", "codex_term_resize", "codex_term_close"] {
            assert_eq!(core.rpc(super::super::Caller::Agent(None), "", c, &json!({})).unwrap_err(), format!("Comando desconocido: {c}"));
        }
        assert!(!include_str!("server.rs").contains("codex_term"));
        let src = include_str!("codex_term.rs").split("#[cfg(test)]").next().unwrap().to_string();
        assert!(!src.contains("super::state") && !src.contains("self.lock()") && !src.contains("attempt"));
    }
}

/// Dos terminales con un falso ejecutable en ConPTY real: write, resize y close,
/// sin cruzar la salida, y close mata el árbol.
#[cfg(all(test, windows))]
mod falso {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::*;
    use super::tests::replay;

    fn wait(cond: impl Fn() -> bool, secs: u64) -> bool {
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(secs) {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        cond()
    }

    fn alive(pid: &str) -> bool {
        let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }

    #[test]
    fn entrada_unicode_llega_entera() {
        let root = std::env::temp_dir().join(format!("lxo-codex-term-uni-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let terms = CodexTerms::default();
        let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(vec![]));
        let ev = events.clone();
        let emit = move |name: &str, v: Value| ev.lock().unwrap().push((name.to_string(), v));
        let cmd = "powershell -NoProfile -Command \"Write-Host LISTO; for ($i=0; $i -lt 10; $i++) { $k = [Console]::ReadKey($true); Write-Host ('K' + [int]$k.KeyChar) }; Write-Host FIN; Start-Sleep 30\"".to_string();
        let id = terms.open_command(&root, cmd, TermMeta { policy: json!({}), argv: vec![], ..Default::default() }, 200, 20, emit).unwrap();
        let out = || events.lock().unwrap().iter().filter(|(n, v)| n == EVENT_OUTPUT && v["term_id"] == id.as_str()).map(|(_, v)| v["data"].as_str().unwrap().to_string()).collect::<String>();
        assert!(wait(|| pty::plain(&out()).contains("LISTO"), 40));
        for chunk in ["a", "\u{f1}", "\u{2764}", "\u{2500}", "\u{2502}", "\u{1F680}", "\u{2764}\u{fe0f}", "z"] {
            terms.write(&id, chunk).unwrap();
            std::thread::sleep(Duration::from_millis(300));
        }
        assert!(wait(|| pty::plain(&out()).contains("FIN"), 10), "{:?}", pty::plain(&out()));
        let got: Vec<u32> = pty::plain(&out()).split_whitespace().filter_map(|t| t.strip_prefix('K')?.parse().ok()).collect();
        // ñ, ❤, símbolos de caja, 🚀 (par sustituto) y ❤ + selector de emoji: ConPTY los entrega todos.
        assert_eq!(got, [97, 241, 10084, 9472, 9474, 55357, 56960, 10084, 65039, 122]);
        terms.close_all().unwrap();
    }

    #[test]
    fn dos_terminales_write_resize_close() {
        let root = std::env::temp_dir().join(format!("lxo-codex-term-falso-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["a", "b"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let terms = CodexTerms::default();
        let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(vec![]));
        let ev = events.clone();
        let emit = move |name: &str, v: Value| ev.lock().unwrap().push((name.to_string(), v));
        let fake = |tag: &str| format!("powershell -NoProfile -Command \"$PID | Set-Content -Encoding ascii hijo.pid; Write-Host LISTO-{tag}; $l = [Console]::ReadLine(); Write-Host ECO-{tag}-$l; Start-Sleep 120\"");
        let meta_a = TermMeta { model: Some("gpt-6.1-sol".into()), effort: Some("high".into()), policy: json!({"profile": "terminal"}), argv: vec!["codex".into(), "-m".into(), "gpt-6.1-sol".into()] };
        let meta_b = TermMeta { policy: json!({"profile": "terminal"}), argv: vec!["codex".into()], ..Default::default() };
        let a = terms.open_command(&root.join("a"), fake("A"), meta_a, 40, 20, emit.clone()).unwrap();
        let b = terms.open_command(&root.join("b"), fake("B"), meta_b, 300, 20, emit.clone()).unwrap();
        assert_ne!(a, b);
        let out = |id: &str| events.lock().unwrap().iter().filter(|(n, v)| n == EVENT_OUTPUT && v["term_id"] == id).map(|(_, v)| v["data"].as_str().unwrap().to_string()).collect::<String>();
        assert!(wait(|| pty::plain(&out(&a)).contains("LISTO-A") && pty::plain(&out(&b)).contains("LISTO-B"), 40), "a={:?} b={:?}", out(&a), out(&b));
        terms.resize(&a, 60, 30).unwrap();
        terms.write(&a, "hola\r").unwrap();
        assert!(wait(|| pty::plain(&out(&a)).contains("ECO-A-hola"), 20), "{:?}", pty::plain(&out(&a)));
        // Sin cruces: lo de A no aparece en B ni al revés.
        let (pa, pb) = (pty::plain(&out(&a)), pty::plain(&out(&b)));
        assert!(!pb.contains("ECO-A") && !pb.contains("LISTO-A") && !pa.contains("LISTO-B"), "a={pa:?} b={pb:?}");
        assert!(terms.write("codex-x", "x").is_err());
        // seq creciente por terminal; el buffer refleja todo lo emitido hasta su seq.
        for (id, tag) in [(&a, "A"), (&b, "B")] {
            let seqs: Vec<u64> = events.lock().unwrap().iter().filter(|(n, v)| n == EVENT_OUTPUT && v["term_id"] == id.as_str()).map(|(_, v)| v["seq"].as_u64().unwrap()).collect();
            assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>());
            let buf = terms.buffer(id).unwrap();
            assert!(buf["data"].is_string(), "data es texto");
            assert!(buf["seq"].as_u64().unwrap() >= *seqs.last().unwrap());
            assert!(buf["cols"].as_u64().unwrap() >= pty::MIN_COLS as u64);
            let r = replay(&buf);
            assert!(r.screen().contents().contains(&format!("LISTO-{tag}")));
        }
        terms.redraw(&a).unwrap();
        assert_eq!(terms.buffer(&a).unwrap()["cols"], 200);
        // list: las dos, con su carpeta y política, vivas.
        let l = terms.list();
        assert_eq!(l.len(), 2);
        assert!(l.iter().all(|x| !x.exited && x.policy["profile"] == "terminal"));
        assert!(l.iter().any(|x| x.term_id == a && x.cwd.ends_with("a")));
        let la = l.iter().find(|x| x.term_id == a).unwrap();
        assert_eq!((la.model.as_deref(), la.effort.as_deref(), la.argv.len()), (Some("gpt-6.1-sol"), Some("high"), 3));
        let lb = serde_json::to_value(l.iter().find(|x| x.term_id == b).unwrap()).unwrap();
        assert!(lb["model"].is_null() && lb["effort"].is_null());
        for k in ["term_id", "cwd", "model", "effort", "policy", "argv", "exited", "code"] {
            assert!(lb.get(k).is_some(), "{k}");
        }
        let pid_a = std::fs::read_to_string(root.join("a").join("hijo.pid")).unwrap().trim().to_string();
        let pid_b = std::fs::read_to_string(root.join("b").join("hijo.pid")).unwrap().trim().to_string();
        terms.close(&a).unwrap();
        let exited = |id: &str| events.lock().unwrap().iter().any(|(n, v)| n == EVENT_EXIT && v["term_id"] == id);
        assert!(wait(|| exited(&a), 20), "sin evento de salida de A");
        assert!(wait(|| !alive(&pid_a), 10), "el nieto de A sigue vivo");
        assert_eq!(terms.list().len(), 1);
        // B sigue viva hasta cerrar todas (como al cerrar la app).
        assert!(alive(&pid_b) && !exited(&b));
        terms.close_all().unwrap();
        assert!(wait(|| exited(&b) && !alive(&pid_b), 20));
        assert_eq!(terms.len(), 0);
        let ev = events.lock().unwrap();
        let exit_a = ev.iter().find(|(n, v)| n == EVENT_EXIT && v["term_id"] == a.as_str()).unwrap();
        assert!(exit_a.1.get("code").is_some());
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// `close`/`close_all` no sueltan un `AgentTerm` cuyo kill falló: el proceso puede seguir vivo (LXO-18).
#[cfg(test)]
mod cierre_tests {
    use super::*;
    use portable_pty::ChildKiller;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Falla las primeras `n` veces y después mata bien.
    #[derive(Debug)]
    struct Intermitente(Arc<AtomicUsize>);

    impl ChildKiller for Intermitente {
        fn kill(&mut self) -> std::io::Result<()> {
            if self.0.load(Ordering::SeqCst) > 0 {
                self.0.fetch_sub(1, Ordering::SeqCst);
                return Err(std::io::Error::other("no se puede matar (aún)"));
            }
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
            Box::new(Intermitente(self.0.clone()))
        }
    }

    fn con_fallos(n: usize) -> AgentTerm {
        AgentTerm::for_tests(Box::new(Intermitente(Arc::new(AtomicUsize::new(n)))))
    }

    #[test]
    fn close_con_un_kill_fallido_conserva_la_terminal_y_lo_dice() {
        let terms = CodexTerms::default();
        terms.insert_for_tests("a", con_fallos(2));
        for _ in 0..2 {
            let e = terms.close("a").unwrap_err();
            assert!(e.contains("sigue abierta"), "{e}");
            assert_eq!(terms.len(), 1, "la terminal sigue en la lista con su matador");
            assert_eq!(terms.list().len(), 1);
        }
        terms.close("a").expect("ahora el matador funciona");
        assert_eq!(terms.len(), 0);
        assert!(terms.close("a").unwrap_err().contains("desconocida"));
    }

    #[test]
    fn close_all_cierra_las_que_puede_y_conserva_y_reporta_las_demas() {
        let terms = CodexTerms::default();
        terms.insert_for_tests("rota", AgentTerm::for_tests(Box::new(super::super::spawn_cleanup_tests::MatadorRoto)));
        terms.insert_for_tests("bien", con_fallos(0));
        let e = terms.close_all().unwrap_err();
        assert!(e.contains("rota") && !e.contains("bien"), "{e}");
        assert_eq!(terms.list().iter().map(|l| l.term_id.as_str()).collect::<Vec<_>>(), vec!["rota"], "solo queda la que no se pudo matar");
        assert!(terms.close_all().is_err(), "y se sigue reportando mientras no muera");
        assert_eq!(terms.len(), 1);
    }

    #[test]
    fn un_pánico_dentro_del_matador_no_pierde_la_terminal() {
        #[derive(Debug)]
        struct Panica;
        impl ChildKiller for Panica {
            fn kill(&mut self) -> std::io::Result<()> {
                panic!("pánico inyectado dentro del matador");
            }
            fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
                Box::new(Panica)
            }
        }
        let terms = Arc::new(CodexTerms::default());
        terms.insert_for_tests("p", AgentTerm::for_tests(Box::new(Panica)));
        let t2 = terms.clone();
        assert!(std::thread::spawn(move || t2.close("p")).join().is_err());
        assert_eq!(terms.len(), 1, "la terminal sigue siendo nuestra");
        assert!(terms.terms.lock().unwrap().get("p").is_some_and(|e| !e.term.kill_in_progress()), "con su matador de vuelta");
    }
}
