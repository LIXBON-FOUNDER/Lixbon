//! Adapter de Codex (LXO-130 y LXO-131): `codex app-server` (JSON por línea sobre stdio) como canal preferido y
//! `codex exec --json` como respaldo degradado, SIN leer `~/.codex/sessions` ni la TUI.
//!
//! Capabilities por canal (contrastadas con Codex 0.162.1, 0.163.0 y 0.164.0; ver `docs/core/ADAPTERS.md`):
//!
//! | Capability | `app_server` | `exec_json` (degradado) |
//! |---|---|---|
//! | `start`, `events` | sí | sí |
//! | `answer` (aprobaciones) | sí: `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` | no |
//! | `interrupt` | sí: `turn/interrupt` → turno `interrupted` | no (solo cancelar) |
//! | `steer` | **sí, de verdad**: `turn/steer` inyecta en el turno en curso | no |
//! | `resume` | sí: `thread/resume`, también entre procesos | no (sin validar) |
//!
//! El canal es visible: `ProbeResult.transport` y el evento `Transport` (con el motivo si es un respaldo).

mod rpc;
mod usage;

#[cfg(test)]
mod fake;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use super::process::{LaunchSpec, Launcher, Process, RealLauncher, Recv};
use super::redact::{redact, safe_text};
use super::{
    AdapterError, AdapterEvent, Answer, CancelToken, Capability, CapabilityMatrix, CapabilityState, ErrorCode, EventSink, ProbeResult, ProviderAdapter,
    ProviderRef, ResumeRequest, RunHandle, RunOutcome, StartRequest,
};
use crate::orch::agents::{self, EnvBlock, EnvProof, Profile};
use super::usage::{system_clock, UsageScratch, UsageError, UsageField, UsageSnapshot, UsageSupport};
use rpc::{Incoming, RpcError};

pub const ID: &str = "codex";

/// Versiones de Codex con el protocolo de `app-server` contrastado en una máquina real. Es DISTINTA de
/// `agents::VERIFIED` (esa valida los flags de la CLI interactiva): `app-server` es experimental y su protocolo puede
/// cambiar, así que solo se declara disponible donde se ha probado.
pub const APP_SERVER_VERIFIED: [&str; 3] = ["0.162.1", "0.163.0", "0.164.0"];

const POLL: Duration = Duration::from_millis(50);
const CALL_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_ID_CHARS: usize = 128;
const MAX_PROMPT_BYTES: usize = 200_000;
const MAX_OUTPUT_EVENT_CHARS: usize = 4096;
const MAX_OUTPUT_TOTAL_CHARS: usize = 64 * 1024;
const MAX_SUMMARY_CHARS: usize = 2000;
const TRUNCATED: &str = " […recortado]";
const OUTPUT_EXHAUSTED: &str = "[salida recortada: se omite el resto de lo que escribió el modelo]";
const UNSUPPORTED_REQUEST: &str = "Lixbon aún no atiende esta petición del servidor de Codex";

/// LXO-131: el patrón ESPECÍFICO del conflicto del sandbox de Windows (lo observó el piloto cuando la app de escritorio
/// de Codex mantiene en uso sus componentes). Hacen falta las DOS partes: un texto parecido no basta (invariante 1).
pub fn is_sandbox_setup_conflict(text: &str) -> bool {
    text.contains("helper_unknown_error") && text.contains("setup refresh had errors")
}

/// `thread/resume` de un hilo que Codex ya no tiene (observado en 0.164.0: «no rollout found for thread id <id>»). Solo
/// vale para ESE método: el mismo texto en otra llamada no es una sesión caducada.
pub fn is_thread_missing(method: &str, text: &str) -> bool {
    method == "thread/resume" && text.contains("no rollout found for thread id")
}

const SANDBOX_UPDATE_REQUIRED: &str = "el sandbox de Windows de Codex necesita actualizarse: ábrelo desde Codex para completarlo y reintenta";
const SANDBOX_IN_USE: &str = "el sandbox de Windows de Codex está en uso (por ejemplo, por la app de escritorio de Codex): ciérrala y reintenta; Lixbon no cierra procesos ajenos";
const SANDBOX_NOT_READY: &str = "el sandbox de Windows de Codex no está listo (sin configurar o con una actualización pendiente): ábrelo desde Codex para configurarlo y reintenta";

/// Error de entorno de Codex. NO es un fallo del Attempt (`FailureKind::EnvironmentBlocked`): no consume reintentos. Lleva
/// la causa TIPADA (`EnvBlock::WindowsSandboxSetup`, migración 015), que es lo que el Core traduce a `environment.blocked`
/// y a su Attention con `Tx::environment_blocked`.
fn environment_blocked(message: &str) -> AdapterError {
    let mut e = AdapterError::new(ErrorCode::EnvironmentBlocked, message);
    e.env_block = Some(EnvBlock::WindowsSandboxSetup);
    e
}

/// El error que produce el conflicto del sandbox de Windows (en uso por otra aplicación). Lo usan las pruebas del Core.
pub fn sandbox_conflict_error() -> AdapterError {
    environment_blocked(SANDBOX_IN_USE)
}

/// La evidencia POSITIVA que desmiente `windows_sandbox_setup`: solo un preflight `ready`. `NotConfigured`, `UpdateRequired`
/// o no haber podido preguntar no demuestran nada y el bloqueo sigue (ver `Tx::environment_verified`).
pub fn env_proof(readiness: Readiness) -> EnvProof {
    EnvProof { sandbox_ready: readiness == Readiness::Ready, ..EnvProof::default() }
}

// ── Canal y probe ───────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    AppServer,
    ExecJson,
}

impl Transport {
    pub fn code(self) -> &'static str {
        match self {
            Transport::AppServer => "app_server",
            Transport::ExecJson => "exec_json",
        }
    }
}

/// `windowsSandbox/readiness` de `app-server`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Readiness {
    Ready,
    NotConfigured,
    UpdateRequired,
}

impl Readiness {
    pub fn parse(s: &str) -> Option<Readiness> {
        match s {
            "ready" => Some(Readiness::Ready),
            "notConfigured" => Some(Readiness::NotConfigured),
            "updateRequired" => Some(Readiness::UpdateRequired),
            _ => None,
        }
    }
}

/// Qué ofrece la CLI instalada y por qué canal.
#[derive(Clone, Debug)]
pub struct Plan {
    pub probe: ProbeResult,
    pub transport: Option<Transport>,
    /// Por qué se usa el respaldo `exec_json`, si es el caso.
    pub reason: Option<String>,
}

pub fn probe_from(installed: bool, version: Option<&str>, help: Option<&str>, exec_help: Option<&str>, readiness: Option<Readiness>) -> Plan {
    let plan = |probe: ProbeResult, transport: Option<Transport>, reason: Option<String>| Plan { probe, transport, reason };
    if !installed {
        return plan(ProbeResult::blocked(None, vec![EnvBlock::CliMissing]), None, None);
    }
    let Some(help) = help else {
        let m = Capability::ALL.into_iter().fold(CapabilityMatrix::new(), |m, c| m.with(c, CapabilityState::unavailable("no se pudo leer `codex --help`")));
        return plan(ProbeResult::ready(version, m), None, None);
    };
    let has_app_server = super::help_has(help, "app-server");
    let verified = version.is_some_and(|v| APP_SERVER_VERIFIED.contains(&v));
    let exec_json = exec_help.is_some_and(|h| super::help_has(h, "--json"));

    if has_app_server && verified {
        // El sandbox de Windows no está listo: es un bloqueo de ENTORNO (no «no disponible» ni un fallo), con su causa tipada.
        if matches!(readiness, Some(r) if r != Readiness::Ready) {
            let probe = ProbeResult::blocked(version, vec![EnvBlock::WindowsSandboxSetup]).with_transport(Transport::AppServer.code());
            return plan(probe, Some(Transport::AppServer), None);
        }
        return plan(ProbeResult::ready(version, CapabilityMatrix::all_available()).with_transport(Transport::AppServer.code()), Some(Transport::AppServer), None);
    }
    if exec_json {
        let reason = if !has_app_server {
            "esta versión de Codex no incluye app-server".to_string()
        } else {
            format!("app-server sin verificar en la versión {} (verificadas: {})", version.unwrap_or("desconocida"), APP_SERVER_VERIFIED.join(", "))
        };
        // Respaldo: solo start/events. exec resume existe pero no admite -s/-C y no está validado, así que no se declara.
        let m = CapabilityMatrix::new().with(Capability::Start, CapabilityState::Available).with(Capability::Events, CapabilityState::Available);
        return plan(ProbeResult::ready(version, m).with_transport(Transport::ExecJson.code()), Some(Transport::ExecJson), Some(reason));
    }
    plan(ProbeResult::blocked(version, vec![EnvBlock::CliFlagsUnsupported]), None, None)
}

fn real_plan() -> Plan {
    match agents::probe_cli("codex") {
        None => probe_from(false, None, None, None, None),
        Some(p) => probe_from(true, p.version.as_deref(), p.help.as_deref(), p.exec_help.as_deref(), None),
    }
}

// ── Configuración y adapter ─────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct CodexConfig {
    pub id: String,
    /// Ruta de la CLI; sin ella se busca `codex` en el PATH.
    pub program: Option<PathBuf>,
}

impl Default for CodexConfig {
    fn default() -> Self {
        CodexConfig { id: ID.into(), program: None }
    }
}

type PlanFn = Arc<dyn Fn() -> Plan + Send + Sync>;
type Waiting = Arc<Mutex<HashMap<i64, Sender<Result<Value, RpcError>>>>>;

struct Run {
    process: Arc<dyn Process>,
    transport: Transport,
    fallback_reason: Option<String>,
    thread_id: Mutex<Option<String>>,
    turn_id: Mutex<Option<String>>,
    model: Mutex<Option<String>>,
    next_id: AtomicI64,
    waiting: Waiting,
    inbox: Mutex<Receiver<Incoming>>,
    /// Peticiones del servidor sin responder: id que mostramos al Core → id JSON-RPC del servidor.
    pending: Mutex<HashMap<String, Value>>,
    interrupted: AtomicBool,
    stop: Arc<AtomicBool>,
}

pub struct CodexAdapter {
    cfg: CodexConfig,
    launcher: Arc<dyn Launcher>,
    plan_fn: PlanFn,
    cached: Mutex<Option<Plan>>,
    runs: Mutex<HashMap<u64, Arc<Run>>>,
    seq: AtomicU64,
}

fn one_line(text: &str, max: usize) -> String {
    safe_text(text.lines().next().unwrap_or(""), max)
}

/// Sandbox y política de aprobación por perfil. Explorar y Proponer no pueden escribir ni preguntar; Delegar escribe en
/// el worktree y lo que salga de él se pregunta al Core.
fn profile_policy(profile: Profile) -> (&'static str, &'static str) {
    match profile {
        Profile::Explorar | Profile::Proponer => ("read-only", "never"),
        Profile::DelegarConRevision => ("workspace-write", "on-request"),
        Profile::AutonomiaAmplia => ("workspace-write", "on-request"),
    }
}

/// Reparte el texto del modelo en eventos acotados, con un techo por ejecución.
struct OutputBudget {
    used: usize,
    exhausted: bool,
}

impl OutputBudget {
    fn emit(&mut self, text: &str, sink: &mut dyn EventSink) {
        if self.exhausted || text.is_empty() {
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
        } else if chars > MAX_OUTPUT_EVENT_CHARS {
            sink.push(AdapterEvent::Output { text: text.chars().take(MAX_OUTPUT_EVENT_CHARS).collect::<String>() + TRUNCATED });
            self.used += MAX_OUTPUT_EVENT_CHARS;
        } else {
            sink.push(AdapterEvent::Output { text });
            self.used += chars;
        }
    }
}

#[derive(Default)]
struct Totals {
    input: Option<u64>,
    output: Option<u64>,
    cached: Option<u64>,
    cache_write: Option<u64>,
}

impl Totals {
    fn event(&self) -> Option<AdapterEvent> {
        (self.input.is_some() || self.output.is_some() || self.cached.is_some() || self.cache_write.is_some()).then(|| AdapterEvent::Usage {
            input_tokens: self.input,
            output_tokens: self.output,
            cache_read_tokens: self.cached,
            cache_creation_tokens: self.cache_write,
            cost_usd: None,
        })
    }
}

impl CodexAdapter {
    pub fn new(cfg: CodexConfig) -> CodexAdapter {
        CodexAdapter::with_parts(cfg, Arc::new(RealLauncher), Arc::new(real_plan))
    }

    pub(crate) fn with_parts(cfg: CodexConfig, launcher: Arc<dyn Launcher>, plan_fn: PlanFn) -> CodexAdapter {
        CodexAdapter { cfg, launcher, plan_fn, cached: Mutex::new(None), runs: Mutex::new(HashMap::new()), seq: AtomicU64::new(0) }
    }

    fn plan(&self) -> Plan {
        let mut c = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        c.get_or_insert_with(|| (self.plan_fn)()).clone()
    }

    fn run_of(&self, run: &RunHandle) -> Result<Arc<Run>, AdapterError> {
        if run.adapter != self.cfg.id {
            return Err(AdapterError::unknown_run());
        }
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).get(&run.seq).cloned().ok_or_else(AdapterError::unknown_run)
    }

    fn program(&self) -> Result<PathBuf, AdapterError> {
        self.cfg.program.clone().or_else(|| crate::orch::skill::which("codex")).ok_or_else(|| AdapterError::environment_blocked(EnvBlock::CliMissing))
    }

    fn register(&self, attempt_id: &str, run: Run) -> RunHandle {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).insert(seq, Arc::new(run));
        RunHandle { attempt_id: attempt_id.to_string(), adapter: self.cfg.id.clone(), seq }
    }

    fn check_request(attempt_id: &str, worktree: &Path, prompt: &str, profile: &str) -> Result<Profile, AdapterError> {
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
        if let Some(reason) = profile.disabled_reason() {
            return Err(AdapterError::invalid(&format!("el perfil {} está deshabilitado: {reason}", profile.id())));
        }
        Ok(profile)
    }

    // ── app-server ───────────────────────────────────────────────────────────────────────────────────────────────────

    fn spawn_server(&self, worktree: &Path) -> Result<Run, AdapterError> {
        let spec = LaunchSpec { program: self.program()?, args: vec!["app-server".into()], cwd: worktree.to_path_buf(), env: vec![], env_remove: vec![] };
        let process = self.launcher.launch(&spec)?;
        let (tx, rx) = mpsc::channel();
        let waiting: Waiting = Arc::new(Mutex::new(HashMap::new()));
        let stop = Arc::new(AtomicBool::new(false));
        pump(Arc::clone(&process), Arc::clone(&waiting), tx, Arc::clone(&stop));
        Ok(Run {
            process,
            transport: Transport::AppServer,
            fallback_reason: None,
            thread_id: Mutex::new(None),
            turn_id: Mutex::new(None),
            model: Mutex::new(None),
            next_id: AtomicI64::new(0),
            waiting,
            inbox: Mutex::new(rx),
            pending: Mutex::new(HashMap::new()),
            interrupted: AtomicBool::new(false),
            stop,
        })
    }

    /// `initialize` → `initialized`.
    fn initialize(run: &Run) -> Result<(), AdapterError> {
        run.call("initialize", Some(json!({ "clientInfo": { "name": "lixbon", "title": "Lixbon", "version": env!("CARGO_PKG_VERSION") } })))?;
        run.process.send(&rpc::notification_line("initialized"))
    }

    /// `windowsSandbox/readiness`. En otras plataformas o versiones la consulta puede no existir: `None`, y no bloquea nada.
    fn readiness(run: &Run) -> Option<Readiness> {
        run.call("windowsSandbox/readiness", None).ok().and_then(|v| v["status"].as_str().and_then(Readiness::parse))
    }

    /// `initialize` → `initialized` → preflight del sandbox. Un servidor que no contesta es un fallo; un preflight que
    /// dice "no listo" es un bloqueo de entorno.
    fn handshake(run: &Run) -> Result<(), AdapterError> {
        Self::initialize(run)?;
        match Self::readiness(run) {
            Some(Readiness::NotConfigured) => Err(environment_blocked(SANDBOX_NOT_READY)),
            Some(Readiness::UpdateRequired) => Err(environment_blocked(SANDBOX_UPDATE_REQUIRED)),
            _ => Ok(()),
        }
    }

    /// Pregunta al sandbox de Windows de Codex si está listo SIN crear ningún hilo ni gastar cuota. `Ok(None)`: este canal o
    /// esta versión no sabe contestar. Es la prueba que levanta el bloqueo `windows_sandbox_setup` (ver [`env_proof`]).
    pub fn preflight(&self, cwd: &Path) -> Result<Option<Readiness>, AdapterError> {
        if self.plan().transport != Some(Transport::AppServer) {
            return Ok(None);
        }
        let run = self.spawn_server(cwd)?;
        let r = Self::initialize(&run).map(|_| Self::readiness(&run));
        run.shutdown();
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn begin_turn(run: &Run, thread_method: &str, resume: Option<&ProviderRef>, worktree: &Path, prompt: &str, profile: Profile, model: Option<&str>, effort: Option<&str>) -> Result<(), AdapterError> {
        let (sandbox, approval) = profile_policy(profile);
        let model = model.map(|m| agents::safe_token(m).map_err(|e| AdapterError::invalid(&e))).transpose()?;
        let effort = effort.map(|e| agents::safe_token(e).map_err(|e| AdapterError::invalid(&e))).transpose()?;
        let mut tp = json!({ "cwd": worktree.to_string_lossy(), "sandbox": sandbox, "approvalPolicy": approval });
        if let Some(m) = &model {
            tp["model"] = json!(m);
        }
        match resume {
            Some(r) => tp["threadId"] = json!(r.expose()),
            None => tp["ephemeral"] = json!(false),
        }
        let resp = run.call(thread_method, Some(tp))?;
        let thread = resp["thread"]["id"].as_str().ok_or_else(|| AdapterError::provider("Codex no devolvió el id del hilo"))?.to_string();
        *run.thread_id.lock().unwrap_or_else(|e| e.into_inner()) = Some(thread.clone());
        *run.model.lock().unwrap_or_else(|e| e.into_inner()) = resp["model"].as_str().map(str::to_string);

        let mut turn = json!({ "threadId": thread, "input": rpc::text_input(prompt) });
        if let Some(e) = &effort {
            turn["effort"] = json!(e);
        }
        let resp = run.call("turn/start", Some(turn))?;
        *run.turn_id.lock().unwrap_or_else(|e| e.into_inner()) = resp["turn"]["id"].as_str().map(str::to_string);
        Ok(())
    }

    fn launch_app_server(&self, attempt_id: &str, worktree: &Path, prompt: &str, profile: Profile, model: Option<&str>, effort: Option<&str>, resume: Option<&ProviderRef>) -> Result<RunHandle, AdapterError> {
        let run = self.spawn_server(worktree)?;
        let started = Self::handshake(&run).and_then(|_| Self::begin_turn(&run, if resume.is_some() { "thread/resume" } else { "thread/start" }, resume, worktree, prompt, profile, model, effort));
        if let Err(e) = started {
            run.shutdown();
            return Err(e);
        }
        Ok(self.register(attempt_id, run))
    }

    // ── exec --json (respaldo) ───────────────────────────────────────────────────────────────────────────────────────

    fn launch_exec(&self, attempt_id: &str, worktree: &Path, prompt: &str, profile: Profile, model: Option<&str>, effort: Option<&str>, reason: Option<String>) -> Result<RunHandle, AdapterError> {
        let (sandbox, _) = profile_policy(profile);
        let mut args: Vec<String> = ["exec", "--json", "--skip-git-repo-check", "-s", sandbox].iter().map(|s| s.to_string()).collect();
        args.extend(["-C".to_string(), worktree.to_string_lossy().into_owned()]);
        if let Some(m) = model {
            args.extend(["-m".to_string(), agents::safe_token(m).map_err(|e| AdapterError::invalid(&e))?]);
        }
        if let Some(e) = effort {
            args.extend(["-c".to_string(), format!("model_reasoning_effort=\"{}\"", agents::safe_token(e).map_err(|e| AdapterError::invalid(&e))?)]);
        }
        let spec = LaunchSpec { program: self.program()?, args, cwd: worktree.to_path_buf(), env: vec![], env_remove: vec![] };
        let process = self.launcher.launch(&spec)?;
        // `codex exec` lee el mensaje de stdin y espera a que se cierre.
        if let Err(e) = process.send(prompt) {
            process.kill();
            return Err(e);
        }
        process.close_input();
        let (_tx, rx) = mpsc::channel();
        let run = Run {
            process,
            transport: Transport::ExecJson,
            fallback_reason: reason,
            thread_id: Mutex::new(None),
            turn_id: Mutex::new(None),
            model: Mutex::new(None),
            next_id: AtomicI64::new(0),
            waiting: Arc::new(Mutex::new(HashMap::new())),
            inbox: Mutex::new(rx),
            pending: Mutex::new(HashMap::new()),
            interrupted: AtomicBool::new(false),
            stop: Arc::new(AtomicBool::new(false)),
        };
        Ok(self.register(attempt_id, run))
    }

    fn launch(&self, attempt_id: &str, worktree: &Path, prompt: &str, profile: &str, model: Option<&str>, effort: Option<&str>, resume: Option<&ProviderRef>) -> Result<RunHandle, AdapterError> {
        let profile = Self::check_request(attempt_id, worktree, prompt, profile)?;
        let plan = self.plan();
        match plan.transport {
            Some(Transport::AppServer) => {
                plan.probe.matrix.require(Capability::Start)?;
                self.launch_app_server(attempt_id, worktree, prompt, profile, model, effort, resume)
            }
            Some(Transport::ExecJson) => {
                if resume.is_some() {
                    return Err(AdapterError::unsupported(Capability::Resume));
                }
                self.launch_exec(attempt_id, worktree, prompt, profile, model, effort, plan.reason)
            }
            None => {
                plan.probe.matrix.require(Capability::Start)?;
                Err(AdapterError::new(ErrorCode::Internal, "el plan de Codex no eligió ningún canal"))
            }
        }
    }
}

/// Lee stdout, entrega las respuestas a quien las espera y el resto al buzón de `events`.
fn pump(process: Arc<dyn Process>, waiting: Waiting, tx: Sender<Incoming>, stop: Arc<AtomicBool>) {
    thread::spawn(move || loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        match process.recv(POLL * 2) {
            Recv::Timeout => {}
            Recv::Eof => {
                // Quien espera una respuesta no la recibirá: se le suelta (su `recv` ve el canal cerrado).
                waiting.lock().unwrap_or_else(|e| e.into_inner()).clear();
                let _ = tx.send(Incoming::Eof);
                return;
            }
            Recv::Line(l) => match rpc::parse(&l) {
                Incoming::Response { id, result } => {
                    if let Some(s) = waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
                        let _ = s.send(result);
                    }
                }
                other => {
                    if tx.send(other).is_err() {
                        return;
                    }
                }
            },
        }
    });
}

impl Run {
    /// Petición con respuesta. Segura desde cualquier hilo: el `pump` entrega la respuesta.
    fn call(&self, method: &str, params: Option<Value>) -> Result<Value, AdapterError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::channel();
        self.waiting.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        if let Err(e) = self.process.send(&rpc::request_line(id, method, params)) {
            self.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return Err(e);
        }
        match rx.recv_timeout(CALL_TIMEOUT) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(if is_sandbox_setup_conflict(&e.message) {
                environment_blocked(SANDBOX_IN_USE)
            } else if is_thread_missing(method, &e.message) {
                AdapterError::session_not_found()
            } else {
                AdapterError::provider(&format!("{method}: {}", e.message))
            }),
            Err(RecvTimeoutError::Timeout) => {
                self.waiting.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                Err(AdapterError::provider(&format!("{method}: Codex no respondió a tiempo")))
            }
            Err(RecvTimeoutError::Disconnected) => Err(AdapterError::provider(&format!("{method}: Codex cerró la conexión"))),
        }
    }

    fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.process.kill();
    }

    fn ids(&self) -> Option<(String, String)> {
        Some((self.thread_id.lock().unwrap_or_else(|e| e.into_inner()).clone()?, self.turn_id.lock().unwrap_or_else(|e| e.into_inner()).clone()?))
    }
}

// ── events: app-server ──────────────────────────────────────────────────────────────────────────────────────────────

fn item_tool(item: &Value) -> Option<(String, String)> {
    match item["type"].as_str()? {
        "commandExecution" => Some(("shell".into(), one_line(item["command"].as_str().unwrap_or(""), 200))),
        "fileChange" => Some(("apply_patch".into(), one_line(item["changes"][0]["path"].as_str().unwrap_or(""), 200))),
        "mcpToolCall" => Some((format!("{}/{}", item["server"].as_str().unwrap_or("?"), item["tool"].as_str().unwrap_or("?")), String::new())),
        _ => None,
    }
}

impl CodexAdapter {
    fn drive_server(&self, run: &Run, cancel: &CancelToken, sink: &mut dyn EventSink) -> RunOutcome {
        sink.push(AdapterEvent::Transport { kind: Transport::AppServer.code().into(), degraded: false, reason: None });
        if let Some(t) = run.thread_id.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            if let Ok(provider_ref) = ProviderRef::new(&t) {
                sink.push(AdapterEvent::SessionBound { provider_ref });
            }
        }
        if let Some(m) = run.model.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            sink.push(AdapterEvent::Model { model: safe_text(&m, 120) });
        }
        let mut budget = OutputBudget { used: 0, exhausted: false };
        let mut totals = Totals::default();
        let mut last_message: Option<String> = None;
        let mut last_error: Option<String> = None;
        let mut unsupported_notified: Vec<String> = vec![];
        let mut malformed = 0usize;
        loop {
            if cancel.is_cancelled() {
                run.shutdown();
                return RunOutcome::Cancelled;
            }
            let msg = match run.inbox.lock().unwrap_or_else(|e| e.into_inner()).recv_timeout(POLL) {
                Ok(m) => m,
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => Incoming::Eof,
            };
            match msg {
                Incoming::Malformed => malformed += 1,
                Incoming::Response { .. } => {}
                Incoming::Eof => {
                    if run.interrupted.load(Ordering::SeqCst) {
                        return RunOutcome::Interrupted;
                    }
                    let tail = run.process.stderr_tail();
                    if is_sandbox_setup_conflict(&tail) || last_error.as_deref().is_some_and(is_sandbox_setup_conflict) {
                        return RunOutcome::Failed(environment_blocked(SANDBOX_IN_USE));
                    }
                    let detail = format!("líneas malformadas: {malformed}{}", if tail.is_empty() { String::new() } else { format!("; stderr: {tail}") });
                    return RunOutcome::Failed(AdapterError::provider("el flujo de Codex terminó sin resultado: el proceso salió o se cortó").with_diagnostic(&detail));
                }
                Incoming::Request { id, method, params } => match method.as_str() {
                    "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
                        let (tool, summary) = if method.contains("commandExecution") {
                            ("shell", one_line(params["command"].as_str().unwrap_or(""), 200))
                        } else {
                            ("apply_patch", one_line(params["reason"].as_str().or(params["grantRoot"].as_str()).unwrap_or("cambios de archivos"), 200))
                        };
                        let key = id.to_string().trim_matches('"').to_string();
                        run.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(key.clone(), id);
                        sink.push(AdapterEvent::Permission { request_id: key, tool: tool.into(), summary });
                    }
                    _ => {
                        // Algo que este adapter aún no atiende: se rechaza para que Codex no se quede esperando.
                        let _ = run.process.send(&rpc::error_line(&id, -32601, UNSUPPORTED_REQUEST));
                        if !unsupported_notified.contains(&method) {
                            unsupported_notified.push(method.clone());
                            sink.push(AdapterEvent::Output { text: format!("[Codex envió `{}` y el adapter aún no lo atiende]", safe_text(&method, 80)) });
                        }
                    }
                },
                Incoming::Notification { method, params } => match method.as_str() {
                    "turn/started" => *run.turn_id.lock().unwrap_or_else(|e| e.into_inner()) = params["turn"]["id"].as_str().map(str::to_string),
                    "item/started" => {
                        if let Some((tool, summary)) = item_tool(&params["item"]) {
                            sink.push(AdapterEvent::ToolUse { tool, summary });
                        }
                    }
                    "item/completed" => {
                        if params["item"]["type"] == "agentMessage" {
                            if let Some(t) = params["item"]["text"].as_str() {
                                last_message = Some(t.to_string());
                                budget.emit(t, sink);
                            }
                        }
                    }
                    "thread/tokenUsage/updated" => {
                        let t = &params["tokenUsage"]["total"];
                        totals = Totals { input: t["inputTokens"].as_u64(), output: t["outputTokens"].as_u64(), cached: t["cachedInputTokens"].as_u64(), cache_write: t["cacheWriteInputTokens"].as_u64() };
                    }
                    "model/rerouted" => {
                        if let Some(m) = params["toModel"].as_str() {
                            sink.push(AdapterEvent::Model { model: safe_text(m, 120) });
                        }
                    }
                    "error" => last_error = params["error"]["message"].as_str().map(str::to_string),
                    "turn/completed" => return Self::finish_turn(run, &params["turn"], last_message.as_deref(), last_error.as_deref(), &totals, sink),
                    _ => {}
                },
            }
        }
    }

    fn finish_turn(run: &Run, turn: &Value, last_message: Option<&str>, last_error: Option<&str>, totals: &Totals, sink: &mut dyn EventSink) -> RunOutcome {
        if let Some(u) = totals.event() {
            sink.push(u);
        }
        match turn["status"].as_str() {
            Some("completed") => RunOutcome::Completed { summary: last_message.map(|t| safe_text(t, MAX_SUMMARY_CHARS)) },
            Some("interrupted") => RunOutcome::Interrupted,
            _ => {
                let message = turn["error"]["message"].as_str().or(last_error).unwrap_or("");
                if is_sandbox_setup_conflict(message) || last_error.is_some_and(is_sandbox_setup_conflict) {
                    return RunOutcome::Failed(environment_blocked(SANDBOX_IN_USE));
                }
                if run.interrupted.load(Ordering::SeqCst) {
                    return RunOutcome::Interrupted;
                }
                let mut e = AdapterError::provider(&format!("Codex terminó el turno con estado {}", turn["status"].as_str().unwrap_or("desconocido")));
                let detail = [turn["error"]["codexErrorInfo"].as_str().map(|i| format!("codexErrorInfo={i}")), (!message.is_empty()).then(|| message.to_string())]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join("; ");
                if !detail.is_empty() {
                    e = e.with_diagnostic(&detail);
                }
                RunOutcome::Failed(e)
            }
        }
    }

    // ── events: exec --json ──────────────────────────────────────────────────────────────────────────────────────────

    fn drive_exec(&self, run: &Run, cancel: &CancelToken, sink: &mut dyn EventSink) -> RunOutcome {
        sink.push(AdapterEvent::Transport { kind: Transport::ExecJson.code().into(), degraded: true, reason: run.fallback_reason.clone() });
        let mut budget = OutputBudget { used: 0, exhausted: false };
        let mut last_message: Option<String> = None;
        let mut failure: Option<String> = None;
        let mut malformed = 0usize;
        loop {
            if cancel.is_cancelled() {
                run.shutdown();
                return RunOutcome::Cancelled;
            }
            let line = match run.process.recv(POLL) {
                Recv::Timeout => continue,
                Recv::Line(l) => l,
                Recv::Eof => {
                    let tail = run.process.stderr_tail();
                    if is_sandbox_setup_conflict(&tail) || failure.as_deref().is_some_and(is_sandbox_setup_conflict) {
                        return RunOutcome::Failed(environment_blocked(SANDBOX_IN_USE));
                    }
                    let detail = format!("líneas malformadas: {malformed}{}{}", failure.as_deref().map(|f| format!("; error: {f}")).unwrap_or_default(), if tail.is_empty() { String::new() } else { format!("; stderr: {tail}") });
                    return RunOutcome::Failed(AdapterError::provider("el flujo de Codex terminó sin resultado: el proceso salió o se cortó").with_diagnostic(&detail));
                }
            };
            let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
                malformed += 1;
                continue;
            };
            match v["type"].as_str() {
                Some("thread.started") => {
                    if let Some(Ok(provider_ref)) = v["thread_id"].as_str().map(ProviderRef::new) {
                        sink.push(AdapterEvent::SessionBound { provider_ref });
                    }
                }
                Some("item.started") | Some("item.completed") => {
                    let item = &v["item"];
                    match (v["type"].as_str(), item["type"].as_str()) {
                        (Some("item.completed"), Some("agent_message")) => {
                            if let Some(t) = item["text"].as_str() {
                                last_message = Some(t.to_string());
                                budget.emit(t, sink);
                            }
                        }
                        (Some("item.started"), Some("command_execution")) => sink.push(AdapterEvent::ToolUse { tool: "shell".into(), summary: one_line(item["command"].as_str().unwrap_or(""), 200) }),
                        _ => {}
                    }
                }
                Some("turn.completed") => {
                    let u = &v["usage"];
                    let totals = Totals { input: u["input_tokens"].as_u64(), output: u["output_tokens"].as_u64(), cached: u["cached_input_tokens"].as_u64(), cache_write: u["cache_write_input_tokens"].as_u64() };
                    if let Some(e) = totals.event() {
                        sink.push(e);
                    }
                    return RunOutcome::Completed { summary: last_message.as_deref().map(|t| safe_text(t, MAX_SUMMARY_CHARS)) };
                }
                // Forma observada en la CLI; sin captura propia de un fallo: se lee con tolerancia.
                Some("turn.failed") | Some("error") => {
                    failure = v["error"]["message"].as_str().or(v["message"].as_str()).map(str::to_string);
                }
                _ => {}
            }
            if let Some(f) = failure.as_deref() {
                if v["type"] == "turn.failed" {
                    if is_sandbox_setup_conflict(f) {
                        return RunOutcome::Failed(environment_blocked(SANDBOX_IN_USE));
                    }
                    return RunOutcome::Failed(AdapterError::provider("Codex terminó el turno con error").with_diagnostic(f));
                }
            }
        }
    }
}

impl ProviderAdapter for CodexAdapter {
    fn id(&self) -> &str {
        &self.cfg.id
    }

    fn probe(&self) -> ProbeResult {
        let p = (self.plan_fn)();
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some(p.clone());
        p.probe
    }

    fn start(&self, req: StartRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        cancel.check()?;
        self.launch(&req.attempt_id, &req.worktree, &req.prompt, &req.profile, req.model.as_deref(), req.effort.as_deref(), None)
    }

    fn events(&self, run: &RunHandle, cancel: &CancelToken, sink: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        let state = self.run_of(run)?;
        let outcome = match state.transport {
            Transport::AppServer => self.drive_server(&state, cancel, sink),
            Transport::ExecJson => self.drive_exec(&state, cancel, sink),
        };
        state.shutdown();
        self.runs.lock().unwrap_or_else(|e| e.into_inner()).remove(&run.seq);
        Ok(outcome)
    }

    fn answer(&self, run: &RunHandle, answer: Answer) -> Result<(), AdapterError> {
        let state = self.run_of(run)?;
        if state.transport != Transport::AppServer {
            return Err(AdapterError::unsupported(Capability::Answer));
        }
        let server_id = state.pending.lock().unwrap_or_else(|e| e.into_inner()).get(&answer.question_id).cloned().ok_or_else(|| AdapterError::invalid("no hay una petición de aprobación pendiente con ese id"))?;
        let decision = match answer.text.trim().to_ascii_lowercase().as_str() {
            "allow" => "accept",
            "deny" => "decline",
            _ => return Err(AdapterError::invalid("la respuesta a una aprobación es `allow` o `deny`")),
        };
        state.process.send(&rpc::result_line(&server_id, json!({ "decision": decision })))?;
        state.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&answer.question_id);
        Ok(())
    }

    fn interrupt(&self, run: &RunHandle) -> Result<(), AdapterError> {
        let state = self.run_of(run)?;
        if state.transport != Transport::AppServer {
            return Err(AdapterError::unsupported(Capability::Interrupt));
        }
        let (thread, turn) = state.ids().ok_or_else(|| AdapterError::unavailable(Capability::Interrupt, "aún no hay un turno en curso"))?;
        state.interrupted.store(true, Ordering::SeqCst);
        state.call("turn/interrupt", Some(json!({ "threadId": thread, "turnId": turn }))).map(|_| ()).inspect_err(|_| state.interrupted.store(false, Ordering::SeqCst))
    }

    fn steer(&self, run: &RunHandle, instruction: &str) -> Result<(), AdapterError> {
        let state = self.run_of(run)?;
        if state.transport != Transport::AppServer {
            return Err(AdapterError::unsupported(Capability::Steer));
        }
        if instruction.trim().is_empty() || instruction.len() > MAX_PROMPT_BYTES {
            return Err(AdapterError::invalid("la instrucción es texto no vacío de hasta 200 KB"));
        }
        let (thread, turn) = state.ids().ok_or_else(|| AdapterError::unavailable(Capability::Steer, "aún no hay un turno en curso"))?;
        state
            .call("turn/steer", Some(json!({ "threadId": thread, "expectedTurnId": turn, "input": rpc::text_input(instruction) })))
            .map(|_| ())
            .map_err(|e| if e.code == ErrorCode::Provider { AdapterError::unavailable(Capability::Steer, &e.message) } else { e })
    }

    /// Con `app-server`, los límites y el plan de la cuenta se piden sin gastar cuota. Con el respaldo `exec --json` no hay
    /// canal para preguntar: `unavailable`, no `unsupported` (el proveedor sí lo ofrece).
    fn usage_support(&self) -> UsageSupport {
        if self.plan().transport == Some(Transport::AppServer) {
            UsageSupport::none().with(UsageField::Windows, CapabilityState::Available).with(UsageField::Credits, CapabilityState::Available).with(UsageField::Plan, CapabilityState::Available)
        } else {
            let why = CapabilityState::unavailable("el uso de la cuenta solo se consulta con codex app-server");
            UsageSupport::none().with(UsageField::Windows, why.clone()).with(UsageField::Credits, why.clone()).with(UsageField::Plan, why)
        }
    }

    fn usage(&self, cancel: &CancelToken) -> Result<UsageSnapshot, UsageError> {
        cancel.check()?;
        if self.plan().transport != Some(Transport::AppServer) {
            return Err(UsageError::unavailable("el uso de la cuenta solo se consulta con codex app-server"));
        }
        // Su propio proceso: no toca ninguna ejecución en curso ni espera a que termine.
        let scratch = UsageScratch::create()?;
        let run = self.spawn_server(scratch.path())?;
        let read = Self::initialize(&run).and_then(|_| {
            cancel.check()?;
            run.call("account/rateLimits/read", None)
        });
        run.shutdown();
        match read {
            Ok(v) => Ok(usage::snapshot_from(&v, (system_clock())())),
            Err(e) => Err(usage::classify(&e)),
        }
    }

    fn resume(&self, req: ResumeRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        cancel.check()?;
        let prompt = req.prompt.as_deref().ok_or_else(|| AdapterError::invalid("reanudar una sesión necesita un mensaje para continuar"))?;
        self.launch(&req.attempt_id, &req.worktree, prompt, &req.profile, req.model.as_deref(), req.effort.as_deref(), Some(&req.provider_ref))
    }
}
