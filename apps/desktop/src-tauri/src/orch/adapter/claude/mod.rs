//! Adapter de Claude Code (LXO-129): `claude -p --input-format stream-json --output-format stream-json`, el canal público y
//! estructurado de la CLI. No lee transcripts ni archivos privados (`~/.claude/projects`), ni hace scraping de la TUI.
//!
//! Las capabilities se DETECTAN, no se asumen: de los flags del `--help` y de la versión verificada (`probe_from`), y la de
//! `interrupt` además de lo que la propia sesión declara en su `init`. `steer` es `unsupported` por observación: un mensaje
//! enviado en mitad de un turno no se inyecta, Claude lo encola y lo procesa DESPUÉS (capturado con 2.1.296). Eso es una
//! cola (LXO-143), no un steer.
//!
//! Varios modelos con formato Anthropic: un [`Endpoint`] (`base_url` + variable con el token + modelo) apunta la misma
//! CLI a otro servicio compatible. Cada configuración se registra con su propio id (`claude`, `claude-local`…).

mod stream;
mod usage;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

pub use super::process::{LaunchSpec, Launcher, Process, RealLauncher, Recv};
use stream::{parse_line, Msg, RateInfo, ResultMsg};

use super::redact::{redact, safe_text};
use super::{
    AdapterError, AdapterEvent, Answer, CancelToken, Capability, CapabilityMatrix, CapabilityState, EventSink, ProbeResult, ProviderAdapter, ProviderRef,
    ResumeRequest, RunHandle, RunOutcome, StartRequest,
};
use super::usage::{system_clock, Clock, Provenance, UsageError, UsageScratch, UsageField, UsageSnapshot, UsageSupport, UsageWindow};
use crate::orch::agents::{self, EnvBlock, Profile};

pub const ID: &str = "claude";

const POLL: Duration = Duration::from_millis(50);
/// Tope de `claude -p /usage`: no llama al modelo, pero arrancar la CLI (hooks incluidos) tarda unos 5-8 s.
const USAGE_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ID_CHARS: usize = 128;
const MAX_PROMPT_BYTES: usize = 200_000;
/// Un texto del modelo se parte en eventos de como mucho esto (invariante 5: la salida cruda no se copia entera).
pub const MAX_OUTPUT_EVENT_CHARS: usize = 4096;
/// Techo de texto del modelo por ejecución; pasado, solo queda un aviso.
pub const MAX_OUTPUT_TOTAL_CHARS: usize = 64 * 1024;
const MAX_SUMMARY_CHARS: usize = 2000;
const TRUNCATED: &str = " […recortado]";
const OUTPUT_EXHAUSTED: &str = "[salida recortada: se omite el resto de lo que escribió el modelo]";
const DENY_MESSAGE: &str = "Denegado por la policy de Lixbon";
/// Credenciales del usuario que NO deben llegar a un endpoint ajeno.
const OWN_CREDENTIALS: [&str; 2] = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"];

// ── Endpoint ────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Otro servicio con la API de Anthropic. El token NO se guarda aquí: se nombra la variable de entorno de la que se lee al
/// lanzar, y solo llega al entorno del hijo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoint {
    base_url: String,
    token_env: String,
    model: Option<String>,
}

impl Endpoint {
    /// `base_url` es `https://…`, o `http://` solo hacia el propio equipo; sin usuario ni contraseña en la URL ni query. El
    /// token es OBLIGATORIO: sin él la CLI podría enviar al servicio ajeno la credencial con la que el usuario inició sesión.
    pub fn new(base_url: &str, token_env: &str, model: Option<&str>) -> Result<Endpoint, AdapterError> {
        let url = base_url.trim();
        if url.is_empty() || url.len() > 300 || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(AdapterError::invalid("la URL del endpoint es texto de hasta 300 caracteres, sin espacios"));
        }
        let (scheme, rest) = url.split_once("://").ok_or_else(|| AdapterError::invalid("la URL del endpoint empieza por https://"))?;
        if url.contains('?') || url.contains('#') {
            return Err(AdapterError::invalid("la URL del endpoint no lleva query ni fragmento"));
        }
        let authority = rest.split('/').next().unwrap_or("");
        if authority.is_empty() || authority.contains('@') {
            return Err(AdapterError::invalid("la URL del endpoint no lleva usuario ni contraseña"));
        }
        let host = if authority.starts_with('[') { authority.split(']').next().map(|h| format!("{h}]")).unwrap_or_default() } else { authority.split(':').next().unwrap_or("").to_string() };
        match scheme {
            "https" => {}
            "http" if matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]") => {}
            "http" => return Err(AdapterError::invalid("http solo se admite hacia el propio equipo (localhost); usa https")),
            _ => return Err(AdapterError::invalid("la URL del endpoint empieza por https://")),
        }
        let valid_env = !token_env.is_empty()
            && token_env.len() <= 64
            && token_env.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            && !token_env.starts_with(|c: char| c.is_ascii_digit());
        if !valid_env {
            return Err(AdapterError::invalid("el token se indica con el NOMBRE de una variable de entorno (MAYÚSCULAS y _), nunca con su valor"));
        }
        let model = model.map(|m| agents::safe_token(m).map_err(|e| AdapterError::invalid(&e))).transpose()?;
        Ok(Endpoint { base_url: url.trim_end_matches('/').to_string(), token_env: token_env.to_string(), model })
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }
}

#[derive(Clone, Debug)]
pub struct ClaudeConfig {
    /// Id con que se registra este adapter. Distinto por configuración: `claude`, `claude-local`…
    pub id: String,
    /// Ruta de la CLI; sin ella se busca `claude` en el PATH.
    pub program: Option<PathBuf>,
    pub endpoint: Option<Endpoint>,
}

impl Default for ClaudeConfig {
    fn default() -> Self {
        ClaudeConfig { id: ID.into(), program: None, endpoint: None }
    }
}

/// Entorno del hijo para un endpoint: (a definir, a quitar). Sin endpoint no se toca nada. `get` lee el entorno del Core.
fn launch_env(cfg: &ClaudeConfig, get: &dyn Fn(&str) -> Option<String>) -> Result<(Vec<(String, String)>, Vec<String>), AdapterError> {
    let Some(ep) = &cfg.endpoint else { return Ok((vec![], vec![])) };
    let token = get(&ep.token_env).filter(|t| !t.trim().is_empty()).ok_or_else(|| AdapterError::invalid(&format!("la variable {} no está definida o está vacía", ep.token_env)))?;
    Ok((
        vec![("ANTHROPIC_BASE_URL".into(), ep.base_url.clone()), ("ANTHROPIC_AUTH_TOKEN".into(), token)],
        OWN_CREDENTIALS.iter().map(|s| s.to_string()).collect(),
    ))
}

// ── Probe ───────────────────────────────────────────────────────────────────────────────────────────────────────────

fn help_has(help: &str, flag: &str) -> bool {
    super::help_has(help, flag)
}

/// Qué ofrece la CLI instalada. Función pura: `version` y `help` salen de `claude --version` / `claude --help`.
pub fn probe_from(installed: bool, version: Option<&str>, help: Option<&str>) -> ProbeResult {
    if !installed {
        return ProbeResult::blocked(None, vec![EnvBlock::CliMissing]);
    }
    let Some(help) = help else {
        let m = Capability::ALL.into_iter().fold(CapabilityMatrix::new(), |m, c| m.with(c, CapabilityState::unavailable("no se pudo leer `claude --help`")));
        return ProbeResult::ready(version, m);
    };
    let stream = help_has(help, "--input-format") && help_has(help, "--output-format") && help_has(help, "stream-json");
    if !stream {
        return ProbeResult::blocked(version, vec![EnvBlock::CliFlagsUnsupported]);
    }
    // El protocolo de control (interrupt, permisos por stdio) está contrastado con la CLI real solo en las versiones
    // verificadas; en otra, la capability no se declara disponible.
    let verified = version.is_some_and(|v| agents::version_verified(ID, v));
    let control = |ok: bool, what: &str| match (ok, verified) {
        (false, _) => CapabilityState::Unsupported,
        (true, true) => CapabilityState::Available,
        (true, false) => CapabilityState::unavailable(&format!("{what} sin verificar en la versión {} (verificada: {})", version.unwrap_or("desconocida"), agents::verified_versions(ID).join(", "))),
    };
    let m = CapabilityMatrix::new()
        .with(Capability::Start, CapabilityState::Available)
        .with(Capability::Events, CapabilityState::Available)
        .with(Capability::Answer, control(help_has(help, "--permission-prompt-tool"), "el canal de permisos"))
        .with(Capability::Interrupt, control(true, "interrupt"))
        // Observado, no supuesto: un mensaje a mitad de turno se encola, no se inyecta.
        .with(Capability::Steer, CapabilityState::Unsupported)
        .with(Capability::Resume, if help_has(help, "--resume") { CapabilityState::Available } else { CapabilityState::Unsupported });
    ProbeResult::ready(version, m)
}

// ── Argumentos ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// Flags de la CLI. El prompt NO va en el argv (se envía por stdin): ni escapes ni visible en la lista de procesos.
fn build_args(profile: Profile, model: Option<&str>, effort: Option<&str>, resume: Option<&ProviderRef>, prompt_tool: bool) -> Result<Vec<String>, AdapterError> {
    let mut a: Vec<String> = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"].iter().map(|s| s.to_string()).collect();
    if prompt_tool {
        a.extend(["--permission-prompt-tool".to_string(), "stdio".to_string()]);
    }
    match profile {
        Profile::Explorar | Profile::Proponer => a.extend([agents::disallowed_tools(), agents::allowed_tools(), "--permission-mode".into(), "plan".into()]),
        Profile::DelegarConRevision => a.extend([agents::allowed_tools(), "--permission-mode".into(), "acceptEdits".into()]),
        Profile::AutonomiaAmplia => a.extend(["--permission-mode".into(), "auto".into()]),
    }
    for (flag, value) in [("--model", model), ("--effort", effort)] {
        if let Some(v) = value {
            a.extend([flag.to_string(), agents::safe_token(v).map_err(|e| AdapterError::invalid(&e))?]);
        }
    }
    if let Some(r) = resume {
        a.extend(["--resume".to_string(), r.expose().to_string()]);
    }
    Ok(a)
}

fn user_message(text: &str) -> String {
    json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } }).to_string()
}

// ── El adapter ──────────────────────────────────────────────────────────────────────────────────────────────────────

struct Run {
    process: Arc<dyn Process>,
    /// `capabilities` del `init` de esta sesión; `None` hasta que llega.
    session_caps: Mutex<Option<Vec<String>>>,
    /// Peticiones de permiso sin responder: id → entrada original de la herramienta (solo en memoria).
    pending: Mutex<HashMap<String, Value>>,
    interrupted: AtomicBool,
    /// Se lanzó con `--resume`: un «no existe esa conversación» significa sesión caducada, no un fallo de la ejecución.
    resumed: bool,
}

/// El mensaje con que Claude dice que ya no tiene la sesión que se le pidió reanudar (observado en 2.1.x: «No conversation
/// found with session ID: <id>»). Se exige la frase COMPLETA: un texto parecido en otro error no es una sesión caducada.
fn is_session_missing(message: &str) -> bool {
    message.contains("No conversation found with session ID")
}

type ProbeFn = Arc<dyn Fn() -> ProbeResult + Send + Sync>;

pub struct ClaudeAdapter {
    cfg: ClaudeConfig,
    launcher: Arc<dyn Launcher>,
    probe_fn: ProbeFn,
    cached: Mutex<Option<ProbeResult>>,
    runs: Mutex<HashMap<u64, Arc<Run>>>,
    seq: AtomicU64,
    /// Lo último que Claude dijo de sus límites en CUALQUIER ejecución, con el momento en que lo dijo (LXO-205).
    observed_limits: Mutex<Option<(i64, RateInfo)>>,
    clock: Clock,
}

fn real_probe() -> ProbeResult {
    match agents::probe_cli("claude") {
        None => probe_from(false, None, None),
        Some(p) => probe_from(true, p.version.as_deref(), p.help.as_deref()),
    }
}

/// Reparte el texto del modelo en eventos acotados, con un techo por ejecución.
struct OutputBudget {
    used: usize,
    exhausted: bool,
}

impl OutputBudget {
    fn emit(&mut self, text: &str, sink: &mut dyn EventSink) {
        if self.exhausted {
            return;
        }
        let text = redact(text);
        let chars = text.chars().count();
        let room = MAX_OUTPUT_TOTAL_CHARS - self.used;
        if chars > room {
            if room > 0 {
                sink.push(AdapterEvent::Output { text: text.chars().take(room.min(MAX_OUTPUT_EVENT_CHARS)).collect::<String>() + TRUNCATED });
            }
            sink.push(AdapterEvent::Output { text: OUTPUT_EXHAUSTED.into() });
            self.exhausted = true;
            return;
        }
        if chars > MAX_OUTPUT_EVENT_CHARS {
            sink.push(AdapterEvent::Output { text: text.chars().take(MAX_OUTPUT_EVENT_CHARS).collect::<String>() + TRUNCATED });
            self.used += MAX_OUTPUT_EVENT_CHARS;
        } else {
            sink.push(AdapterEvent::Output { text });
            self.used += chars;
        }
    }
}

impl ClaudeAdapter {
    /// Con la CLI real.
    pub fn new(cfg: ClaudeConfig) -> ClaudeAdapter {
        ClaudeAdapter::with_parts(cfg, Arc::new(RealLauncher), Arc::new(real_probe))
    }

    pub(crate) fn with_parts(cfg: ClaudeConfig, launcher: Arc<dyn Launcher>, probe_fn: ProbeFn) -> ClaudeAdapter {
        ClaudeAdapter { cfg, launcher, probe_fn, cached: Mutex::new(None), runs: Mutex::new(HashMap::new()), seq: AtomicU64::new(0), observed_limits: Mutex::new(None), clock: system_clock() }
    }

    fn probe_cached(&self) -> ProbeResult {
        let mut c = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        c.get_or_insert_with(|| (self.probe_fn)()).clone()
    }

    fn run_of(&self, run: &RunHandle) -> Result<Arc<Run>, AdapterError> {
        if run.adapter != self.cfg.id {
            return Err(AdapterError::unknown_run());
        }
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).get(&run.seq).cloned().ok_or_else(AdapterError::unknown_run)
    }

    fn program(&self) -> Result<PathBuf, AdapterError> {
        self.cfg.program.clone().or_else(|| crate::orch::skill::which("claude")).ok_or_else(|| AdapterError::environment_blocked(EnvBlock::CliMissing))
    }

    #[allow(clippy::too_many_arguments)]
    fn launch(&self, attempt_id: &str, worktree: &std::path::Path, prompt: &str, profile: &str, model: Option<&str>, effort: Option<&str>, resume: Option<&ProviderRef>) -> Result<RunHandle, AdapterError> {
        if attempt_id.trim().is_empty() || attempt_id.len() > MAX_ID_CHARS {
            return Err(AdapterError::invalid("el attempt_id es texto no vacío de hasta 128 caracteres"));
        }
        if prompt.trim().is_empty() || prompt.len() > MAX_PROMPT_BYTES {
            return Err(AdapterError::invalid("el mensaje es texto no vacío de hasta 200 KB"));
        }
        if worktree.as_os_str().is_empty() {
            return Err(AdapterError::invalid("falta el worktree"));
        }
        let profile = Profile::parse(profile).ok_or_else(|| AdapterError::invalid("perfil de permisos desconocido"))?;
        // Un perfil que el producto tiene deshabilitado no se lanza por la puerta de atrás del adapter.
        if let Some(reason) = profile.disabled_reason() {
            return Err(AdapterError::invalid(&format!("el perfil {} está deshabilitado: {reason}", profile.id())));
        }
        let model = model.or_else(|| self.cfg.endpoint.as_ref().and_then(Endpoint::model));
        let probe = self.probe_cached();
        let prompt_tool = probe.matrix.is_available(Capability::Answer);
        let args = build_args(profile, model, effort, resume, prompt_tool)?;
        let (env, env_remove) = launch_env(&self.cfg, &|k| std::env::var(k).ok())?;
        let spec = LaunchSpec { program: self.program()?, args, cwd: worktree.to_path_buf(), env, env_remove };

        let process = self.launcher.launch(&spec)?;
        if let Err(e) = process.send(&user_message(prompt)) {
            process.kill();
            return Err(e);
        }
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let state = Run { process, session_caps: Mutex::new(None), pending: Mutex::new(HashMap::new()), interrupted: AtomicBool::new(false), resumed: resume.is_some() };
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).insert(seq, Arc::new(state));
        Ok(RunHandle { attempt_id: attempt_id.to_string(), adapter: self.cfg.id.clone(), seq })
    }

    /// Lee el flujo hasta el `result`, el fin del proceso o la cancelación.
    fn drive(&self, run: &Run, cancel: &CancelToken, sink: &mut dyn EventSink) -> RunOutcome {
        let mut budget = OutputBudget { used: 0, exhausted: false };
        let mut malformed = 0usize;
        loop {
            if cancel.is_cancelled() {
                run.process.kill();
                return RunOutcome::Cancelled;
            }
            let line = match run.process.recv(POLL) {
                Recv::Timeout => continue,
                Recv::Line(l) => l,
                Recv::Eof => {
                    // El proceso terminó sin `result`: ni éxito ni corrupción, un fallo con su diagnóstico.
                    if run.interrupted.load(Ordering::SeqCst) {
                        return RunOutcome::Interrupted;
                    }
                    let tail = run.process.stderr_tail();
                    let detail = format!("líneas malformadas: {malformed}{}", if tail.is_empty() { String::new() } else { format!("; stderr: {tail}") });
                    return RunOutcome::Failed(AdapterError::provider("el flujo de Claude terminó sin resultado: el proceso salió o se cortó").with_diagnostic(&detail));
                }
            };
            for msg in parse_line(&line) {
                match msg {
                    Msg::Malformed => malformed += 1,
                    Msg::Ignored => {}
                    Msg::Init { session_id, model, capabilities, .. } => {
                        *run.session_caps.lock().unwrap_or_else(|e| e.into_inner()) = Some(capabilities);
                        if let Ok(provider_ref) = ProviderRef::new(&session_id) {
                            sink.push(AdapterEvent::SessionBound { provider_ref });
                        }
                        if let Some(model) = model {
                            sink.push(AdapterEvent::Model { model: safe_text(&model, 120) });
                        }
                    }
                    Msg::Text(t) => budget.emit(&t, sink),
                    Msg::ToolUse { tool, summary } => sink.push(AdapterEvent::ToolUse { tool, summary }),
                    Msg::PermissionRequest { request_id, tool, summary, input } => {
                        run.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(request_id.clone(), input);
                        sink.push(AdapterEvent::Permission { request_id, tool, summary });
                    }
                    Msg::ApiRetry { attempt, max, delay_ms } => sink.push(AdapterEvent::Retry { attempt, max, delay_ms }),
                    Msg::RateLimit(info) => *self.observed_limits.lock().unwrap_or_else(|e| e.into_inner()) = Some(((self.clock)(), info)),
                    Msg::Result(r) => return self.finish(run, r, sink),
                }
            }
        }
    }

    /// ¿Se puede consultar el uso con `claude -p /usage`? Solo en versiones donde se comprobó que es un comando local: en
    /// otra, `/usage` podría llegar al modelo y gastar cuota.
    fn can_query_usage_command(&self) -> bool {
        let probe = self.probe_cached();
        matches!(probe.environment, super::Environment::Ready) && probe.cli_version.as_deref().is_some_and(|v| agents::version_verified(ID, v))
    }

    /// `claude -p /usage --output-format stream-json`: el comando local de la CLI. Se corta en seco si algún mensaje del
    /// modelo aparece (el comando local responde con el modelo sintético `<synthetic>`): así una versión que lo trate
    /// distinto no gasta más que el arranque.
    fn query_usage_command(&self, cancel: &CancelToken) -> Result<Vec<UsageWindow>, UsageError> {
        let program = self.program().map_err(UsageError::from)?;
        let args = ["-p", "/usage", "--output-format", "stream-json", "--verbose"].iter().map(|s| s.to_string()).collect();
        let scratch = UsageScratch::create()?;
        let spec = LaunchSpec { program, args, cwd: scratch.path().to_path_buf(), env: vec![], env_remove: vec![] };
        let process = self.launcher.launch(&spec).map_err(UsageError::from)?;
        process.close_input();
        let deadline = std::time::Instant::now() + USAGE_COMMAND_TIMEOUT;
        let outcome = loop {
            if cancel.is_cancelled() {
                break Err(UsageError::unavailable("consulta de uso cancelada"));
            }
            if std::time::Instant::now() > deadline {
                break Err(UsageError::unavailable("`claude /usage` no contestó a tiempo"));
            }
            match process.recv(POLL) {
                Recv::Timeout => {}
                Recv::Eof => break Err(UsageError::unavailable("`claude /usage` terminó sin resultado")),
                Recv::Line(l) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&l) {
                        if v["type"] == "assistant" && v.pointer("/message/model").and_then(Value::as_str) != Some("<synthetic>") {
                            break Err(UsageError::unavailable("en esta versión `/usage` no es un comando local: no se usa"));
                        }
                    }
                    if let Some(Msg::Result(r)) = parse_line(&l).into_iter().find(|m| matches!(m, Msg::Result(_))) {
                        break match r.text.as_deref().map(usage::windows_from) {
                            Some(w) if !r.is_error && !w.is_empty() => Ok(w),
                            _ => Err(UsageError::unavailable("`claude /usage` no informa de límites en esta cuenta")),
                        };
                    }
                }
            }
        };
        process.kill();
        outcome
    }

    fn finish(&self, run: &Run, r: ResultMsg, sink: &mut dyn EventSink) -> RunOutcome {
        let u = &r.usage;
        if [u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens].iter().any(Option::is_some) || u.cost_usd.is_some() {
            sink.push(AdapterEvent::Usage {
                input_tokens: u.input_tokens,
                output_tokens: u.output_tokens,
                cache_read_tokens: u.cache_read_tokens,
                cache_creation_tokens: u.cache_creation_tokens,
                cost_usd: u.cost_usd,
            });
        }
        if !r.is_error {
            return RunOutcome::Completed { summary: r.text.as_deref().map(|t| safe_text(t, MAX_SUMMARY_CHARS)) };
        }
        if run.interrupted.load(Ordering::SeqCst) {
            return RunOutcome::Interrupted;
        }
        // Reanudar una sesión que Claude ya no tiene no es un fallo de la ejecución: es una sesión caducada (LXO-134).
        if run.resumed && r.errors.iter().any(|m| is_session_missing(m)) {
            return RunOutcome::Failed(AdapterError::session_not_found());
        }
        let mut e = AdapterError::provider(&format!("Claude terminó con error ({})", r.subtype));
        let detail = [r.terminal_reason.as_deref().map(|t| format!("terminal_reason={t}")), r.text.clone()].into_iter().flatten().collect::<Vec<_>>().join("; ");
        if !detail.is_empty() {
            e = e.with_diagnostic(&detail);
        }
        RunOutcome::Failed(e)
    }
}

impl ProviderAdapter for ClaudeAdapter {
    fn id(&self) -> &str {
        &self.cfg.id
    }

    fn probe(&self) -> ProbeResult {
        let p = (self.probe_fn)();
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some(p.clone());
        p
    }

    fn start(&self, req: StartRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        cancel.check()?;
        self.launch(&req.attempt_id, &req.worktree, &req.prompt, &req.profile, req.model.as_deref(), req.effort.as_deref(), None)
    }

    fn events(&self, run: &RunHandle, cancel: &CancelToken, sink: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        let state = self.run_of(run)?;
        let outcome = self.drive(&state, cancel, sink);
        // Termine como termine, el proceso no sobrevive a su ejecución.
        state.process.kill();
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).remove(&run.seq);
        Ok(outcome)
    }

    /// Claude solo informa de sus límites DURANTE una ejecución: no hay consulta de cuenta sin gastar una. Por eso `windows`
    /// consta como `unavailable` hasta que haya una observación, y la procedencia es siempre `run_observation`. Con un
    /// endpoint ajeno no se atribuyen al servicio de otro los límites de Anthropic: sin uso.
    fn usage_support(&self) -> UsageSupport {
        if self.cfg.endpoint.is_some() {
            return UsageSupport::none();
        }
        let observed = self.observed_limits.lock().unwrap_or_else(|e| e.into_inner()).is_some();
        let state = if self.can_query_usage_command() || observed {
            CapabilityState::Available
        } else {
            CapabilityState::unavailable("`claude /usage` solo se usa en las versiones verificadas y aún no hay ninguna ejecución observada")
        };
        UsageSupport::none().with(UsageField::Windows, state)
    }

    fn usage(&self, cancel: &CancelToken) -> Result<UsageSnapshot, UsageError> {
        cancel.check()?;
        if self.cfg.endpoint.is_some() {
            return Err(UsageError::unsupported());
        }
        // Lo exacto: el propio comando de uso de la CLI. Si no se puede (versión sin verificar, el comando falló), se cae a lo
        // último que Claude dijo en una ejecución, con su procedencia y su antigüedad reales.
        let command_error = if self.can_query_usage_command() {
            match self.query_usage_command(cancel) {
                Ok(windows) => {
                    let mut snap = UsageSnapshot::new((self.clock)(), Provenance::ProviderQuery);
                    snap.limit_reached = windows.iter().any(|w| w.used_percent.is_some_and(|p| p >= 100.0)).then_some(true);
                    snap.windows = windows;
                    return Ok(snap);
                }
                Err(e) => Some(e),
            }
        } else {
            None
        };
        let Some((at, info)) = self.observed_limits.lock().unwrap_or_else(|e| e.into_inner()).clone() else {
            return Err(command_error.unwrap_or_else(|| UsageError::unavailable("`claude /usage` no está verificado en esta versión y aún no hay ninguna ejecución de la que leer los límites")));
        };
        let mut snap = UsageSnapshot::new(at, Provenance::RunObservation);
        snap.windows = info
            .windows
            .iter()
            .map(|w| UsageWindow {
                id: w.id.clone(),
                minutes: match w.id.as_str() {
                    "five_hour" => Some(300),
                    "seven_day" => Some(10_080),
                    _ => None,
                },
                // `utilization` es una fracción; algo fuera de 0..=1 es un formato que no conocemos: desconocido.
                used_percent: w.utilization.filter(|u| u.is_finite() && (0.0..=1.0).contains(u)).map(|u| (u * 1000.0).round() / 10.0),
                resets_at: w.resets_at,
            })
            .collect();
        snap.limit_reached = match info.status.as_deref() {
            Some("allowed") | Some("allowed_warning") => Some(false),
            Some("rejected") => Some(true),
            _ => None,
        };
        Ok(snap)
    }

    fn answer(&self, run: &RunHandle, answer: Answer) -> Result<(), AdapterError> {
        let state = self.run_of(run)?;
        let input = state
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&answer.question_id)
            .cloned()
            .ok_or_else(|| AdapterError::invalid("no hay una petición de permiso pendiente con ese id"))?;
        let response = match answer.text.trim().to_ascii_lowercase().as_str() {
            "allow" => json!({ "behavior": "allow", "updatedInput": input }),
            "deny" => json!({ "behavior": "deny", "message": DENY_MESSAGE }),
            _ => return Err(AdapterError::invalid("la respuesta a un permiso es `allow` o `deny`")),
        };
        let line = json!({ "type": "control_response", "response": { "subtype": "success", "request_id": answer.question_id, "response": response } });
        state.process.send(&line.to_string())?;
        state.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&answer.question_id);
        Ok(())
    }

    fn interrupt(&self, run: &RunHandle) -> Result<(), AdapterError> {
        let state = self.run_of(run)?;
        let declared = state.session_caps.lock().unwrap_or_else(|e| e.into_inner()).clone();
        match declared {
            None => return Err(AdapterError::unavailable(Capability::Interrupt, "la sesión de Claude aún no ha iniciado")),
            Some(caps) if !caps.iter().any(|c| c.starts_with("interrupt_")) => {
                return Err(AdapterError::unavailable(Capability::Interrupt, "esta sesión de Claude no declara soporte de interrupt"));
            }
            Some(_) => {}
        }
        let line = json!({ "type": "control_request", "request_id": format!("lxo-int-{}", run.seq), "request": { "subtype": "interrupt" } });
        state.interrupted.store(true, Ordering::SeqCst);
        state.process.send(&line.to_string()).inspect_err(|_| state.interrupted.store(false, Ordering::SeqCst))
    }

    // `steer` NO se implementa: el valor por defecto del trait lo rechaza como `unsupported_capability`.

    fn resume(&self, req: ResumeRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        cancel.check()?;
        let prompt = req.prompt.as_deref().ok_or_else(|| AdapterError::invalid("reanudar una sesión necesita un mensaje para continuar"))?;
        self.launch(&req.attempt_id, &req.worktree, prompt, &req.profile, req.model.as_deref(), req.effort.as_deref(), Some(&req.provider_ref))
    }
}
