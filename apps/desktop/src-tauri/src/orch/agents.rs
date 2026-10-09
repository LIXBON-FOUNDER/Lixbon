//! Agentes que puede lanzar el coordinador: cómo se arrancan en autónomo, cómo
//! se les pasa el modelo y el esfuerzo, y qué modelos ofrece cada uno según su
//! propia CLI. El coordinador decide agente y modelo por tarea; el usuario no
//! configura nada.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::skill::which;
use crate::hide_console;

pub struct Spec {
    pub id: &'static str,
    pub label: &'static str,
    pub bin: &'static str,
    /// Lo que mejor hace, para que el coordinador elija con criterio.
    pub strengths: &'static str,
    efforts: &'static [&'static str],
}

/// Aún no funcionan como hijos en Windows: la TUI de Cursor no recibe el teclado
/// dentro del PTY y en modo -p un hook le bloquea la escritura; OpenCode dice
/// escribir pero el archivo no aparece. Se retiran del equipo hasta resolverlo.
const PAUSED: &[&str] = &["cursor", "opencode"];

pub const AGENTS: &[Spec] = &[
    Spec { id: "claude", label: "Claude Code", bin: "claude", strengths: "Implementación y refactor complejos, depuración, tareas largas de código.",
        efforts: &["low", "medium", "high", "xhigh", "max"] },
    Spec { id: "codex", label: "Codex", bin: "codex", strengths: "Implementación y tests; buen segundo implementador o revisor.",
        efforts: &["low", "medium", "high"] },
    Spec { id: "cursor", label: "Cursor", bin: "cursor-agent", strengths: "Revisión de diffs, lectura del código y cambios acotados.",
        efforts: &[] },
    Spec { id: "opencode", label: "OpenCode", bin: "opencode", strengths: "Modelos de muchos proveedores: documentación, lectura, QA y tareas baratas.",
        efforts: &[] },
    Spec { id: "gemini", label: "Gemini CLI", bin: "gemini", strengths: "Contexto muy largo: leer mucho código o documentación.",
        efforts: &[] },
];

pub fn spec(id: &str) -> Option<&'static Spec> {
    AGENTS.iter().find(|a| a.id == id)
}

/// Un id de modelo va dentro de un script de cmd: solo caracteres inofensivos.
pub fn safe_token(s: &str) -> Result<String, String> {
    let s = s.trim();
    if s.is_empty() || s.len() > 120 || !s.chars().all(|c| c.is_ascii_alphanumeric() || "._-:/[]#@".contains(c)) {
        return Err(format!("Modelo o esfuerzo no válido: {s}"));
    }
    Ok(s.to_string())
}

// ── Perfiles de autonomía ───────────────────────────────────────────────
//
// Cada perfil se traduce a los flags nativos de cada CLI (tabla perfiles→flags).
// Ninguno salta permisos ni sandbox: los flags de bypass no se usan nunca, ni
// como respaldo silencioso. Si a la CLI instalada le falta un flag, el perfil
// queda bloqueado con el motivo, no se degrada.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Profile {
    Explorar,
    Proponer,
    DelegarConRevision,
    AutonomiaAmplia,
}

/// Motivo por el que Autonomía amplia está definida pero no se puede usar.
pub const DEFERRED: &str = "Aplazada a petición del cliente";

impl Profile {
    pub const ALL: [Profile; 4] = [Profile::Explorar, Profile::Proponer, Profile::DelegarConRevision, Profile::AutonomiaAmplia];

    pub fn id(self) -> &'static str {
        match self {
            Profile::Explorar => "explorar",
            Profile::Proponer => "proponer",
            Profile::DelegarConRevision => "delegar_con_revision",
            Profile::AutonomiaAmplia => "autonomia_amplia",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Profile::Explorar => "Explorar",
            Profile::Proponer => "Proponer",
            Profile::DelegarConRevision => "Delegar con revisión",
            Profile::AutonomiaAmplia => "Autonomía amplia",
        }
    }

    /// Acepta el id (`delegar_con_revision`) o la etiqueta (`Delegar con revisión`).
    pub fn parse(s: &str) -> Option<Profile> {
        let s = s.trim();
        Profile::ALL.into_iter().find(|p| p.id().eq_ignore_ascii_case(s) || p.label().eq_ignore_ascii_case(s))
    }

    pub fn disabled_reason(self) -> Option<&'static str> {
        (self == Profile::AutonomiaAmplia).then_some(DEFERRED)
    }

    /// Los roles de solo lectura (explorador, revisor, adversario) usan Explorar;
    /// los que implementan, Delegar con revisión.
    pub fn for_role(read_only: bool) -> Profile {
        if read_only { Profile::Explorar } else { Profile::DelegarConRevision }
    }
}

/// Versiones cuyo `--help` se revisó contra la tabla de perfiles.
const VERIFIED: &[(&str, &[&str])] = &[("claude", &["2.1.296"]), ("codex", &["0.159.0", "0.162.1"])];

/// Herramientas que se le quitan a Claude en los perfiles sin escritura. Bash se
/// conserva: la necesita para `lxo`.
const READ_ONLY_BLOCKED: &[&str] = &["Edit", "Write", "NotebookEdit"];

/// Única orden de Bash permitida en Explorar/Proponer con Claude.
const LXO_ONLY: &str = "Bash(lxo *)";

/// Flags de permisos de un perfil para un proveedor (sin el binario). `exec`
/// indica `codex exec`, que no acepta `-a/--ask-for-approval`.
fn profile_flags(provider: &str, profile: Profile, worktree: &str, exec: bool) -> Result<(Vec<String>, Vec<String>), String> {
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    let mut warnings = vec![];
    let flags = match (provider, profile) {
        ("claude", Profile::Explorar | Profile::Proponer) => {
            // Bash solo para `lxo` (sintaxis del --help de 2.1.296: "Bash(git *)").
            let mut f = vec!["--disallowedTools".to_string()];
            f.extend(v(READ_ONLY_BLOCKED));
            f.extend(v(&["--allowedTools", LXO_ONLY, "--permission-mode", "plan"]));
            warnings.push("Claude no tiene sandbox del sistema: el modo plan lo aplica la CLI y Bash depende de su política.".into());
            warnings.push("La red y las lecturas fuera del repo no están bloqueadas.".into());
            warnings.push("No verificado: que el modo plan respete --allowedTools \"Bash(lxo *)\" y deje ejecutar lxo.".into());
            if profile == Profile::Proponer {
                warnings.push("El parche lo entrega el agente como texto; el host no comprueba que aplique hasta intentarlo.".into());
            }
            f
        }
        ("claude", Profile::DelegarConRevision) => {
            warnings.push("La lista de --allowedTools la tiene que definir el host; sin ella, los comandos que pidan permiso quedan esperando.".into());
            warnings.push("El aislamiento lo da el worktree de git, no la CLI; un comando permitido puede escribir fuera de él.".into());
            v(&["--permission-mode", "acceptEdits"])
        }
        ("claude", Profile::AutonomiaAmplia) => v(&["--permission-mode", "auto"]),
        ("codex", Profile::Explorar | Profile::Proponer) => {
            if profile == Profile::Proponer {
                warnings.push("El parche lo entrega el agente como diff en su salida; el host no comprueba que aplique hasta intentarlo.".into());
            }
            let mut f = v(&["--sandbox", "read-only"]);
            if !exec { f.extend(v(&["--ask-for-approval", "never"])); }
            f
        }
        ("codex", Profile::DelegarConRevision) => {
            if worktree.trim().is_empty() {
                return Err("Delegar con revisión necesita un worktree".into());
            }
            warnings.push("La red en el sandbox workspace-write no está verificada en esta versión.".into());
            warnings.push("El .git del worktree apunta al repo principal: puede tocar refs compartidas.".into());
            let mut f = v(&["--sandbox", "workspace-write"]);
            if !exec { f.extend(v(&["--ask-for-approval", "never"])); }
            f.extend(["--cd".to_string(), worktree.trim().to_string()]);
            f
        }
        ("codex", Profile::AutonomiaAmplia) => {
            let mut f = v(&["--sandbox", "workspace-write"]);
            if !exec { f.extend(v(&["--ask-for-approval", "on-request"])); }
            f
        }
        _ => return Err(format!("{provider} no tiene perfiles de permisos definidos; solo se lanza sin saltar permisos con claude o codex")),
    };
    if exec && provider == "codex" {
        warnings.push("codex exec no acepta -a/--ask-for-approval: se omite.".into());
    }
    Ok((flags, warnings))
}

/// Lo que se sabe de la CLI instalada: su `--version` y el `--help` del modo con
/// que se lanza.
#[derive(Clone, Debug, Default)]
pub struct Probe {
    pub version: Option<String>,
    pub help: Option<String>,
}

pub enum Detected<'a> {
    /// No se consultó la CLI (validaciones al guardar o al crear la tarea).
    Skip,
    /// La CLI no está en el PATH.
    Missing,
    Found(&'a Probe),
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Blocked,
    Unverified,
}

/// Política efectiva: lo que devuelve `orch_resolve_policy` y lo que se lanza.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Policy {
    pub profile: String,
    /// Rol de la tarea (explorador, implementador, revisor, escalado, adversario)
    /// o `null` si se consulta sin rol.
    pub role: Option<String>,
    pub provider: String,
    /// Binario y flags de permisos, exactamente como se lanzan. Al lanzar solo se
    /// añaden detrás el modelo, el esfuerzo y el prompt.
    pub argv: Vec<String>,
    pub cli_version: Option<String>,
    pub warnings: Vec<String>,
    pub status: Status,
    pub reason: Option<String>,
}

/// Primer `x.y.z` de la salida de `--version` (`codex-cli 0.159.0`, `2.1.296 (Claude Code)`).
pub fn parse_version(text: &str) -> Option<String> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .map(|t| t.trim_matches('.'))
        .find(|t| t.split('.').count() >= 3 && t.split('.').all(|p| !p.is_empty()))
        .map(str::to_string)
}

/// El flag aparece en el `--help` como palabra entera (`--sandbox` no casa con `--sandbox-x`).
fn help_has(help: &str, word: &str) -> bool {
    let edge = |c: Option<char>| c.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    help.match_indices(word).any(|(i, _)| edge(help[..i].chars().next_back()) && edge(help[i + word.len()..].chars().next()))
}

/// Flags (y valores de modo) del argv que no aparecen en el `--help`.
fn missing_flags(argv: &[String], help: &str) -> Vec<String> {
    let mut missing = vec![];
    for (i, a) in argv.iter().enumerate() {
        if !a.starts_with('-') { continue; }
        if !help_has(help, a) {
            missing.push(a.clone());
            continue;
        }
        if ["--sandbox", "--permission-mode", "--ask-for-approval"].contains(&a.as_str()) {
            if let Some(val) = argv.get(i + 1).filter(|v| !help_has(help, v)) {
                missing.push(format!("{a} {val}"));
            }
        }
    }
    missing
}

fn blocked(provider: &str, profile: &str, argv: Vec<String>, cli_version: Option<String>, warnings: Vec<String>, reason: String) -> Policy {
    Policy { profile: profile.into(), role: None, provider: provider.into(), argv, cli_version, warnings, status: Status::Blocked, reason: Some(reason) }
}

/// Resuelve la política sin efectos: todo lo de la CLI llega en `detected`.
pub fn evaluate(provider: &str, profile: Profile, worktree: &str, detected: Detected, exec: bool) -> Policy {
    let pid = profile.id();
    let Some(a) = spec(provider) else {
        return blocked(provider, pid, vec![], None, vec![], format!("Proveedor desconocido: {provider}"));
    };
    if worktree.chars().any(|c| "\"%^&|<>\r\n".contains(c)) {
        return blocked(provider, pid, vec![], None, vec![], "La ruta del worktree tiene caracteres que no se pueden pasar a la CLI".into());
    }
    let (flags, warnings) = match profile_flags(provider, profile, worktree, exec) {
        Ok(f) => f,
        Err(e) => return blocked(provider, pid, vec![], None, vec![], e),
    };
    let mut argv = vec![a.bin.to_string()];
    if exec { argv.push("exec".into()); }
    argv.extend(flags);
    if let Some(r) = profile.disabled_reason() {
        return blocked(provider, pid, argv, None, warnings, r.into());
    }
    let ok = |status, version, reason| Policy { profile: pid.into(), role: None, provider: provider.into(), argv: argv.clone(), cli_version: version, warnings: warnings.clone(), status, reason };
    match detected {
        Detected::Skip => ok(Status::Unverified, None, Some("No verificado: no se consultó --version ni --help".into())),
        Detected::Missing => blocked(provider, pid, argv.clone(), None, warnings.clone(), format!("No se encontró `{}` en el PATH", a.bin)),
        Detected::Found(p) => {
            let version = p.version.clone();
            let Some(help) = &p.help else {
                return ok(Status::Unverified, version, Some("No verificado: no se pudo leer --help".into()));
            };
            let missing = missing_flags(&argv[1..], help);
            if !missing.is_empty() {
                let v = version.as_deref().unwrap_or("versión desconocida");
                return blocked(provider, pid, argv.clone(), version.clone(), warnings.clone(),
                    format!("{} {v} no admite: {}", a.label, missing.join(", ")));
            }
            let verified = VERIFIED.iter().find(|(id, _)| *id == provider).map(|(_, v)| *v).unwrap_or(&[]);
            match version.as_deref() {
                Some(v) if verified.contains(&v) => ok(Status::Ok, version.clone(), None),
                v => ok(Status::Unverified, version.clone(), Some(format!(
                    "Versión {} no verificada (verificadas: {}); sus flags sí aparecen en --help",
                    v.unwrap_or("desconocida"), verified.join(", ")))),
            }
        }
    }
}

/// Motivo de bloqueo cuando Codex tendría que entregar con `lxo done` desde un
/// sandbox sin red local.
pub const CODEX_NO_LXO: &str = "Codex en este sandbox no puede conectarse al host local para entregar con lxo done; ver PR de entrega por archivo";

/// El sandbox de Codex que resulta del argv deja conectar a 127.0.0.1. Probado con
/// `codex sandbox` (0.159.0 y 0.162.1, Linux): read-only y workspace-write sin
/// `sandbox_workspace_write.network_access=true` lo bloquean.
fn codex_allows_local_network(argv: &[String]) -> bool {
    let sandbox = argv.windows(2).find(|w| w[0] == "--sandbox" || w[0] == "-s").map(|w| w[1].as_str());
    let net = argv.iter().any(|a| a == "sandbox_workspace_write.network_access=true");
    match sandbox {
        Some("workspace-write") => net,
        _ => false,
    }
}

/// Cómo entrega la tarea su informe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Consulta de flags, sin tarea que entregue.
    Query,
    /// Solo `lxo done` por HTTP a 127.0.0.1 (tareas sin nonce de entrega).
    #[allow(dead_code)]
    LxoOnly,
    /// `lxo done` o, sin red, `report.json` / bloque con marcadores por la salida
    /// (orch/delivery.rs). Es lo que activa el host para toda hija que lanza.
    FileOrMarkers,
}

/// Política para una tarea del orquestador. `role` es el rol de la tarea (o
/// `None`). Codex sin red local solo se bloquea si la tarea no tiene activa la
/// entrega por archivo/marcadores.
pub fn evaluate_for(provider: &str, profile: Profile, role: Option<&str>, worktree: &str, detected: Detected, exec: bool, delivery: Delivery) -> Policy {
    let mut p = evaluate(provider, profile, worktree, detected, exec);
    p.role = role.map(str::to_string);
    if let Some(r) = role.filter(|r| super::roles::spec(r).is_none()) {
        p.status = Status::Blocked;
        p.reason = Some(format!("Rol desconocido: {r}"));
        return p;
    }
    if p.status != Status::Blocked && provider == "codex" && !codex_allows_local_network(&p.argv) {
        match delivery {
            Delivery::LxoOnly => {
                p.status = Status::Blocked;
                p.reason = Some(CODEX_NO_LXO.into());
            }
            Delivery::FileOrMarkers => p.warnings.push(if p.argv.iter().any(|a| a == "read-only") {
                "Sin red local: entrega con lxo report (bloque con marcadores en la salida); lxo phase, ask y check no llegan al host.".into()
            } else {
                "Sin red local: entrega con lxo report (report.json); lxo phase, ask y check no llegan al host.".into()
            }),
            Delivery::Query => {}
        }
    }
    p
}

static PROBES: Mutex<Option<HashMap<String, (Instant, Option<Probe>)>>> = Mutex::new(None);

/// `--version` y `--help` de la CLI, con caché (se repite tras CACHE_TTL).
fn probe(bin: &str) -> Option<Probe> {
    if let Ok(c) = PROBES.lock() {
        if let Some((at, p)) = c.as_ref().and_then(|m| m.get(bin)) {
            if at.elapsed() < CACHE_TTL {
                return p.clone();
            }
        }
    }
    let short = Duration::from_secs(10);
    let p = which(bin).map(|_| Probe {
        version: output(bin, &["--version"], short).as_deref().and_then(parse_version),
        help: output(bin, &["--help"], short).filter(|h| !h.trim().is_empty()),
    });
    if let Ok(mut c) = PROBES.lock() {
        c.get_or_insert_with(HashMap::new).insert(bin.to_string(), (Instant::now(), p.clone()));
    }
    p
}

/// Política efectiva consultando la CLI instalada (TUI, que es como se lanza).
/// Con rol, la tarea entrega con `lxo done`; sin rol (`""`) es una consulta de
/// los flags y no se exige la entrega.
pub fn resolve_policy(provider: &str, profile: &str, role: &str, worktree: &str) -> Policy {
    let role = Some(role.trim()).filter(|r| !r.is_empty());
    // Con rol es una hija: el host le activa la entrega por archivo/marcadores.
    resolve_task_policy(provider, profile, role, worktree, if role.is_some() { Delivery::FileOrMarkers } else { Delivery::Query })
}

/// Como `resolve_policy`, indicando si la tarea entrega con `lxo done` (las hijas
/// del orquestador siempre, tengan rol o no).
pub fn resolve_task_policy(provider: &str, profile: &str, role: Option<&str>, worktree: &str, delivery: Delivery) -> Policy {
    let Some(prof) = Profile::parse(profile) else {
        let mut p = blocked(provider, profile, vec![], None, vec![], format!(
            "Perfil desconocido: {profile}. Usa uno de: {}", Profile::ALL.map(|p| p.id()).join(", ")));
        p.role = role.map(str::to_string);
        return p;
    };
    let Some(a) = spec(provider) else {
        return evaluate_for(provider, prof, role, worktree, Detected::Skip, false, delivery);
    };
    match probe(a.bin) {
        Some(p) => evaluate_for(provider, prof, role, worktree, Detected::Found(&p), false, delivery),
        None => evaluate_for(provider, prof, role, worktree, Detected::Missing, false, delivery),
    }
}

/// Registro del intento de lanzamiento (mismos nombres que la tabla `attempts`
/// del diseño SQLite): perfil, versión de la CLI, estado de la política y si se
/// confirmó una versión no verificada.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PolicyRecord {
    pub profile: String,
    pub cli_version: Option<String>,
    pub policy_status: Status,
    pub ack_unverified: bool,
}

/// Decide si se puede lanzar con la política que acaba de resolver el host. No
/// se confía en el argv de la UI: si viene, tiene que ser idéntico al resuelto.
/// - `blocked`: se rechaza siempre, aunque haya confirmación.
/// - `unverified` sin `ack_unverified`: se rechaza.
/// - `unverified` con `ack_unverified`: se lanza.
/// Si se puede lanzar, devuelve el registro del intento.
pub fn authorize(policy: &Policy, requested_argv: Option<&[String]>, ack_unverified: bool) -> Result<PolicyRecord, String> {
    if policy.status == Status::Blocked {
        return Err(format!("Perfil {} bloqueado: {}", policy.profile, policy.reason.as_deref().unwrap_or("sin motivo")));
    }
    if let Some(req) = requested_argv {
        if req != policy.argv.as_slice() {
            return Err(format!("El argv recibido ({}) no coincide con el que resuelve el host ({}): no se lanza",
                req.join(" "), policy.argv.join(" ")));
        }
    }
    match policy.status {
        Status::Unverified if !ack_unverified => Err(format!(
            "Perfil {} sin verificar: {}. Confírmalo (ack_unverified) para lanzar",
            policy.profile, policy.reason.as_deref().unwrap_or("versión no verificada"))),
        _ => Ok(PolicyRecord {
            profile: policy.profile.clone(),
            cli_version: policy.cli_version.clone(),
            policy_status: policy.status,
            ack_unverified: policy.status == Status::Unverified && ack_unverified,
        }),
    }
}

pub struct Launch {
    pub command: String,
    pub env: Vec<(String, String)>,
    /// Para agentes que no toman el prompt como argumento: se escribe en su
    /// terminal cuando la TUI está lista.
    pub inject: Option<String>,
    /// Sin terminal: proceso con la salida canalizada (modo de ejecución completa).
    pub piped: bool,
}

fn quote(a: &str) -> String {
    if a.contains(' ') { format!("\"{a}\"") } else { a.to_string() }
}

/// Valida y arma el lanzamiento de una hija del orquestador sin consultar la CLI
/// (perfil sin verificar). Las hijas entregan con `lxo done`.
pub fn launch(agent: &str, model: Option<&str>, effort: Option<&str>, prompt: &str, profile: Profile, role: Option<&str>) -> Result<Launch, String> {
    let policy = evaluate_for(agent, profile, role, ".", Detected::Skip, false, Delivery::FileOrMarkers);
    launch_with(&policy, model, effort, prompt)
}

/// Arma el lanzamiento con el argv exacto de la política; solo añade modelo,
/// esfuerzo y prompt. Una política bloqueada no se lanza.
pub fn launch_with(policy: &Policy, model: Option<&str>, effort: Option<&str>, prompt: &str) -> Result<Launch, String> {
    let agent = policy.provider.as_str();
    let a = spec(agent).ok_or_else(|| format!("Agente desconocido: {agent}. Usa uno de `lxo agents`."))?;
    if PAUSED.contains(&agent) {
        return Err(format!("{} no está disponible todavía como agente hijo en Lixbon. Usa uno de `lxo agents`.", a.label));
    }
    if policy.status == Status::Blocked {
        return Err(format!("{} con el perfil {}: {}", a.label, policy.profile, policy.reason.as_deref().unwrap_or("bloqueado")));
    }
    let model = model.map(safe_token).transpose()?;
    let effort = effort.map(safe_token).transpose()?;
    if let Some(e) = &effort {
        if !a.efforts.contains(&e.as_str()) {
            return Err(format!("{} no admite --effort {e}", a.label));
        }
    }
    let mut args: Vec<String> = policy.argv.iter().map(|s| quote(s)).collect();
    match agent {
        "claude" => {
            if let Some(m) = &model { args.extend(["--model".into(), m.clone()]); }
            if let Some(e) = &effort { args.extend(["--effort".into(), e.clone()]); }
        }
        "codex" => {
            if let Some(m) = &model { args.extend(["--model".into(), m.clone()]); }
            if let Some(e) = &effort { args.extend(["-c".into(), format!("model_reasoning_effort={e}")]); }
        }
        _ => {}
    }
    args.push(format!("\"{prompt}\""));
    Ok(Launch { command: args.join(" "), env: vec![], inject: None, piped: false })
}

/// Teclas para el diálogo de arranque que bloquearía a un hijo sin nadie
/// delante: confiar en la carpeta nueva del worktree. El aviso del modo sin
/// permisos no se acepta nunca. Se envían una a una, con pausa, como las
/// pulsaría una persona.
pub fn auto_answer(screen: &str) -> Option<&'static [&'static str]> {
    let s = screen.to_lowercase();
    if s.contains("bypass") {
        return None;
    }
    // Claude marca por defecto «No, exit»: hay que bajar a «Yes, I trust this folder».
    if s.contains("yes, i trust this folder") || s.contains("yes,itrustthisfolder") {
        return Some(&["\x1b[B", "\r"]);
    }
    if s.contains("trust") && (s.contains("folder") || s.contains("directory") || s.contains("workspace") || s.contains("files in")) {
        return Some(&["\r"]);
    }
    None
}

// ── Modelos disponibles ─────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct Model {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

#[derive(Serialize, Clone)]
pub struct Available {
    pub id: String,
    pub label: String,
    pub strengths: String,
    pub models: Vec<Model>,
    pub efforts: Vec<String>,
    pub model_hint: String,
}

static CACHE: Mutex<Option<(Instant, Vec<Available>)>> = Mutex::new(None);
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

fn output(bin: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let path = which(bin)?;
    let mut cmd = if cfg!(windows) && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&path);
        c
    } else {
        Command::new(&path)
    };
    let mut child = hide_console(cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())).spawn().ok()?;
    let stdout = child.stdout.take()?;
    let reader = thread::spawn(move || std::io::read_to_string(stdout).unwrap_or_default());
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return reader.join().ok();
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    None
}

/// Los modelos de Claude salen de su `initialize`, igual que en el chat de Claude Code.
fn claude_models() -> Vec<Model> {
    let fallback = || ["opus", "sonnet", "haiku", "fable"].iter().map(|m| Model { id: m.to_string(), label: m.to_string(), note: String::new() }).collect();
    let Some(path) = which("claude") else { return fallback() };
    let mut cmd = if cfg!(windows) && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(&path);
        c
    } else {
        Command::new(&path)
    };
    let child = hide_console(cmd.args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()))
        .spawn();
    let Ok(mut child) = child else { return fallback() };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = writeln!(stdin, "{}", json!({ "type": "control_request", "request_id": "lxo", "request": { "subtype": "initialize" } }));
        let stdout = child.stdout.take();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let Some(out) = stdout else { return };
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
                if v["type"] == "control_response" {
                    let _ = tx.send(v["response"]["response"]["models"].clone());
                    return;
                }
            }
        });
        let models = rx.recv_timeout(Duration::from_secs(25)).ok();
        drop(stdin);
        let _ = child.kill();
        if let Some(Value::Array(list)) = models {
            let out: Vec<Model> = list.iter().filter_map(|m| {
                let id = m["value"].as_str()?.to_string();
                (id != "default").then(|| Model {
                    label: m["displayName"].as_str().unwrap_or(&id).to_string(),
                    note: m["description"].as_str().unwrap_or("").to_string(),
                    id,
                })
            }).collect();
            if !out.is_empty() {
                return out;
            }
        }
    }
    fallback()
}

/// Una lista de modelos en texto (una por línea, con o sin viñeta).
fn parse_lines(text: &str) -> Vec<Model> {
    text.lines()
        .map(|l| l.trim().trim_start_matches(['-', '*', '•']).trim())
        .filter(|l| (!l.is_empty() && !l.ends_with(':') && !l.contains(' ')) || l.contains("(default)") || l.contains(" - "))
        .filter_map(|l| {
            let id = l.split_whitespace().next()?.to_string();
            safe_token(&id).ok()?;
            let note = l[id.len()..].trim().trim_start_matches('-').trim().to_string();
            Some(Model { label: id.clone(), id, note })
        })
        .take(80)
        .collect()
}

fn discover(a: &Spec) -> Vec<Model> {
    let long = Duration::from_secs(25);
    match a.id {
        "claude" => claude_models(),
        "opencode" => output("opencode", &["models"], long).map(|t| parse_lines(&t)).unwrap_or_default(),
        "codex" => output("codex", &["debug", "models"], long).map(|t| parse_lines(&t)).unwrap_or_default(),
        "cursor" => output("cursor-agent", &["models"], long).map(|t| parse_lines(&t)).unwrap_or_default(),
        _ => vec![],
    }
}

fn hint(id: &str) -> &'static str {
    match id {
        "claude" => "--model con un alias (opus, sonnet, haiku, fable) o un id completo",
        "codex" => "--model con un id de OpenAI (p. ej. gpt-5.5); --effort low|medium|high",
        "opencode" => "--model proveedor/modelo, tal como sale en la lista",
        "cursor" => "--model con un id de la lista de Cursor",
        "gemini" => "--model con un id de Gemini",
        _ => "",
    }
}

/// Agentes instalados en este equipo y sus modelos. Tarda la primera vez
/// (pregunta a cada CLI), después se sirve de caché.
pub fn available(refresh: bool) -> Vec<Available> {
    if !refresh {
        if let Ok(c) = CACHE.lock() {
            if let Some((at, list)) = c.as_ref() {
                if at.elapsed() < CACHE_TTL {
                    return list.clone();
                }
            }
        }
    }
    let installed: Vec<&Spec> = AGENTS.iter().filter(|a| !PAUSED.contains(&a.id) && which(a.bin).is_some()).collect();
    let handles: Vec<_> = installed.iter().map(|a| {
        let id = a.id;
        thread::spawn(move || discover(spec(id).expect("agente conocido")))
    }).collect();
    let list: Vec<Available> = installed.iter().zip(handles).map(|(a, h)| Available {
        id: a.id.into(),
        label: a.label.into(),
        strengths: a.strengths.into(),
        models: h.join().unwrap_or_default(),
        efforts: a.efforts.iter().map(|e| e.to_string()).collect(),
        model_hint: hint(a.id).into(),
    }).collect();
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((Instant::now(), list.clone()));
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODEX_HELP: &str = include_str!("testdata/codex-0.159.0-help.txt");
    const CODEX_EXEC_HELP: &str = include_str!("testdata/codex-0.159.0-exec-help.txt");
    const CLAUDE_HELP: &str = include_str!("testdata/claude-2.1.296-help.txt");
    const BYPASS: &[&str] = &["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--allow-dangerously-skip-permissions",
        "bypassPermissions", "danger-full-access", "--yolo"];

    fn probe(version: &str, help: &str) -> Probe {
        Probe { version: Some(version.into()), help: Some(help.into()) }
    }

    #[test]
    fn lanzadores_con_perfil_y_modelo() {
        let l = launch("claude", Some("opus"), Some("high"), "Lee la tarea", Profile::DelegarConRevision, None).unwrap();
        assert_eq!(l.command, r#"claude --permission-mode acceptEdits --model opus --effort high "Lee la tarea""#);
        assert!(launch("opencode", Some("anthropic/claude-sonnet-5"), None, "x", Profile::Explorar, None).is_err());
        let l = launch_with(&evaluate("codex", Profile::Explorar, ".", Detected::Skip, false), Some("gpt-5.5"), Some("high"), "x").unwrap();
        assert_eq!(l.command, r#"codex --sandbox read-only --ask-for-approval never --model gpt-5.5 -c model_reasoning_effort=high "x""#);
        assert!(launch("claude", Some("opus & del"), None, "x", Profile::Explorar, None).is_err());
        assert!(launch("gemini", None, None, "x", Profile::Explorar, None).is_err());
    }

    #[test]
    fn explorar_en_claude_sin_herramientas_de_edicion() {
        let l = launch("claude", Some("haiku"), None, "Lee", Profile::Explorar, Some("explorador")).unwrap();
        assert_eq!(l.command, r#"claude --disallowedTools Edit Write NotebookEdit --allowedTools "Bash(lxo *)" --permission-mode plan --model haiku "Lee""#);
    }

    #[test]
    fn argv_por_perfil_y_proveedor() {
        let wt = "C:\\Users\\USUARIO\\wt";
        let argv = |prov, prof| evaluate(prov, prof, wt, Detected::Skip, false).argv.join(" ");
        assert_eq!(argv("claude", Profile::Explorar), "claude --disallowedTools Edit Write NotebookEdit --allowedTools Bash(lxo *) --permission-mode plan");
        assert_eq!(argv("claude", Profile::Proponer), "claude --disallowedTools Edit Write NotebookEdit --allowedTools Bash(lxo *) --permission-mode plan");
        assert_eq!(argv("claude", Profile::DelegarConRevision), "claude --permission-mode acceptEdits");
        assert_eq!(argv("codex", Profile::Explorar), "codex --sandbox read-only --ask-for-approval never");
        assert_eq!(argv("codex", Profile::Proponer), "codex --sandbox read-only --ask-for-approval never");
        assert_eq!(argv("codex", Profile::DelegarConRevision), format!("codex --sandbox workspace-write --ask-for-approval never --cd {wt}"));
        // El argv de la política es exactamente el que se lanza; la ruta con espacios va entre comillas.
        let p = evaluate("codex", Profile::DelegarConRevision, "C:\\Mis Documentos\\wt", Detected::Found(&probe("0.159.0", CODEX_HELP)), false);
        assert_eq!(p.status, Status::Ok);
        let l = launch_with(&p, None, None, "x").unwrap();
        assert_eq!(l.command, r#"codex --sandbox workspace-write --ask-for-approval never --cd "C:\Mis Documentos\wt" "x""#);
        assert_eq!(evaluate("codex", Profile::DelegarConRevision, "", Detected::Skip, false).status, Status::Blocked);
    }

    #[test]
    fn ningun_perfil_salta_permisos() {
        for prov in ["claude", "codex"] {
            for prof in Profile::ALL {
                for exec in [false, true] {
                    let p = evaluate(prov, prof, "wt", Detected::Skip, exec);
                    for flag in BYPASS {
                        assert!(!p.argv.iter().any(|a| a == flag), "{prov} {prof:?} lleva {flag}");
                    }
                }
                if prof != Profile::AutonomiaAmplia {
                    let l = launch_with(&evaluate(prov, prof, "wt", Detected::Skip, false), None, None, "x").unwrap();
                    assert!(BYPASS.iter().all(|f| !l.command.contains(f)), "{}", l.command);
                }
            }
        }
        assert_eq!(auto_answer("Bypass Permissions mode ... Yes, I accept"), None);
    }

    #[test]
    fn bloquea_si_falta_un_flag() {
        // Codex 0.159.0: la TUI tiene -a, `codex exec` no.
        let tui = evaluate("codex", Profile::Explorar, "wt", Detected::Found(&probe("0.159.0", CODEX_HELP)), false);
        assert_eq!((tui.status, tui.cli_version.as_deref()), (Status::Ok, Some("0.159.0")));
        let mismo_argv_en_exec = missing_flags(&tui.argv[1..], CODEX_EXEC_HELP);
        assert_eq!(mismo_argv_en_exec, ["--ask-for-approval"]);
        let exec = evaluate("codex", Profile::Explorar, "wt", Detected::Found(&probe("0.159.0", CODEX_EXEC_HELP)), true);
        assert_eq!(exec.argv, ["codex", "exec", "--sandbox", "read-only"]);
        assert_eq!(exec.status, Status::Ok);
        // Un --help sin --sandbox (CLI antigua) bloquea con el motivo.
        let vieja = CODEX_HELP.replace("--sandbox", "--sbx");
        let p = evaluate("codex", Profile::DelegarConRevision, "wt", Detected::Found(&probe("0.159.0", &vieja)), false);
        assert_eq!(p.status, Status::Blocked);
        assert_eq!(p.reason.as_deref(), Some("Codex 0.159.0 no admite: --sandbox"));
        assert!(launch_with(&p, None, None, "x").is_err());
        // Un valor de modo que la CLI no lista también bloquea.
        let sin_plan = CLAUDE_HELP.replace("\"plan\"", "\"x\"");
        let p = evaluate("claude", Profile::Explorar, "wt", Detected::Found(&probe("2.1.296", &sin_plan)), false);
        assert_eq!(p.reason.as_deref(), Some("Claude Code 2.1.296 no admite: --permission-mode plan"));
        // CLI ausente: bloqueado; versión no revisada: sin verificar pero lanzable.
        assert_eq!(evaluate("claude", Profile::Explorar, "wt", Detected::Missing, false).status, Status::Blocked);
        let p = evaluate("claude", Profile::DelegarConRevision, "wt", Detected::Found(&probe("2.2.0", CLAUDE_HELP)), false);
        assert_eq!(p.status, Status::Unverified);
        assert!(launch_with(&p, None, None, "x").is_ok());
        assert_eq!(evaluate("claude", Profile::DelegarConRevision, "wt", Detected::Found(&probe("2.1.296", CLAUDE_HELP)), false).status, Status::Ok);
    }

    #[test]
    fn autonomia_amplia_definida_pero_deshabilitada() {
        for prov in ["claude", "codex"] {
            let p = evaluate(prov, Profile::AutonomiaAmplia, "wt", Detected::Skip, false);
            assert_eq!(p.status, Status::Blocked);
            assert_eq!(p.reason.as_deref(), Some(DEFERRED));
            assert!(!p.argv.is_empty());
            assert!(launch(prov, None, None, "x", Profile::AutonomiaAmplia, None).is_err());
        }
        assert_eq!(resolve_policy("claude", "autonomia_amplia", "", "wt").reason.as_deref(), Some(DEFERRED));
    }

    #[test]
    fn forma_de_la_politica() {
        assert_eq!(Profile::parse("Delegar con revisión"), Some(Profile::DelegarConRevision));
        assert_eq!(Profile::parse("explorar"), Some(Profile::Explorar));
        assert_eq!(resolve_policy("codex", "turbo", "revisor", "wt").status, Status::Blocked);
        let p = evaluate("codex", Profile::Explorar, "wt", Detected::Skip, false);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["status"], "unverified");
        assert_eq!(v["profile"], "explorar");
        assert!(v["role"].is_null());
        let p = evaluate_for("claude", Profile::Explorar, Some("revisor"), "wt", Detected::Skip, false, Delivery::FileOrMarkers);
        assert_eq!(serde_json::to_value(&p).unwrap()["role"], "revisor");
        assert_eq!(resolve_policy("codex", "turbo", "revisor", "wt").role.as_deref(), Some("revisor"));
        assert_eq!(evaluate_for("claude", Profile::Explorar, Some("planner"), "wt", Detected::Skip, false, Delivery::FileOrMarkers).status, Status::Blocked);
        for k in ["profile", "role", "provider", "argv", "cli_version", "warnings", "status", "reason"] {
            assert!(v.get(k).is_some(), "falta {k}");
        }
        assert_eq!(parse_version("codex-cli 0.159.0\n").as_deref(), Some("0.159.0"));
        assert_eq!(parse_version("2.1.296 (Claude Code)").as_deref(), Some("2.1.296"));
        assert!(!help_has("--sandbox-x", "--sandbox"));
    }

    fn con(status: Status) -> Policy {
        let mut p = evaluate("codex", Profile::Explorar, "wt", Detected::Found(&probe("0.162.1", CODEX_HELP)), false);
        if status == Status::Unverified {
            p = evaluate("codex", Profile::Explorar, "wt", Detected::Found(&probe("0.170.0", CODEX_HELP)), false);
        }
        assert_eq!(p.status, status);
        p
    }

    #[test]
    fn bloqueado_se_rechaza_aunque_haya_confirmacion() {
        let p = evaluate("codex", Profile::AutonomiaAmplia, "wt", Detected::Skip, false);
        assert!(authorize(&p, None, true).is_err());
        assert!(authorize(&p, Some(&p.argv), true).is_err());
        let falta = evaluate("codex", Profile::Explorar, "wt", Detected::Found(&probe("0.159.0", CODEX_EXEC_HELP)), false);
        assert_eq!(falta.status, Status::Blocked);
        assert!(authorize(&falta, None, true).is_err());
    }

    #[test]
    fn sin_verificar_sin_confirmacion_se_rechaza() {
        let p = con(Status::Unverified);
        assert!(authorize(&p, None, false).unwrap_err().contains("ack_unverified"));
    }

    #[test]
    fn sin_verificar_con_confirmacion_lanza_y_lo_registra() {
        let p = con(Status::Unverified);
        let rec = authorize(&p, Some(&p.argv), true).unwrap();
        assert_eq!(rec, PolicyRecord { profile: "explorar".into(), cli_version: Some("0.170.0".into()), policy_status: Status::Unverified, ack_unverified: true });
        // Una versión verificada no necesita confirmación; el registro dice ok y sin ack.
        let rec = authorize(&con(Status::Ok), None, true).unwrap();
        assert_eq!(rec, PolicyRecord { profile: "explorar".into(), cli_version: Some("0.162.1".into()), policy_status: Status::Ok, ack_unverified: false });
    }

    #[test]
    fn registro_del_intento_con_nombres_de_attempts() {
        let rec = authorize(&con(Status::Unverified), None, true).unwrap();
        let v = serde_json::to_value(&rec).unwrap();
        assert_eq!(v, json!({ "profile": "explorar", "cli_version": "0.170.0", "policy_status": "unverified", "ack_unverified": true }));
        let back: PolicyRecord = serde_json::from_value(v).unwrap();
        assert_eq!(back, rec);
    }

    #[test]
    fn argv_distinto_del_resuelto_se_rechaza() {
        let p = con(Status::Ok);
        let mut otro = p.argv.clone();
        otro.push("--dangerously-bypass-approvals-and-sandbox".into());
        assert!(authorize(&p, Some(&otro), true).unwrap_err().contains("no coincide"));
        assert!(authorize(&p, Some(&p.argv[..2]), false).is_err());
        assert!(authorize(&p, Some(&p.argv), false).is_ok());
    }

    #[test]
    fn explorar_en_claude_solo_permite_lxo() {
        for prof in [Profile::Explorar, Profile::Proponer] {
            let p = evaluate("claude", prof, "wt", Detected::Found(&probe("2.1.296", CLAUDE_HELP)), false);
            assert_eq!(p.status, Status::Ok);
            let i = p.argv.iter().position(|a| a == "--allowedTools").unwrap();
            assert_eq!(p.argv[i + 1], "Bash(lxo *)");
            assert!(p.argv.windows(2).any(|w| w == ["--permission-mode", "plan"]));
        }
        // Sin --allowedTools en el --help, Explorar queda bloqueado.
        let sin = CLAUDE_HELP.replace("--allowedTools", "--x");
        let p = evaluate("claude", Profile::Explorar, "wt", Detected::Found(&probe("2.1.296", &sin)), false);
        assert_eq!(p.reason.as_deref(), Some("Claude Code 2.1.296 no admite: --allowedTools"));
    }

    #[test]
    fn codex_bloqueado_por_rol_que_entrega_con_lxo() {
        let found = probe("0.162.1", CODEX_HELP);
        for (prof, role) in [(Profile::Explorar, "explorador"), (Profile::Explorar, "revisor"), (Profile::Proponer, "adversario"),
            (Profile::DelegarConRevision, "implementador"), (Profile::DelegarConRevision, "escalado")] {
            let p = evaluate_for("codex", prof, Some(role), "wt", Detected::Found(&found), false, Delivery::LxoOnly);
            assert_eq!(p.status, Status::Blocked, "{prof:?} {role}");
            assert_eq!(p.reason.as_deref(), Some(CODEX_NO_LXO));
            assert!(authorize(&p, None, true).is_err());
        }
        // Con la entrega por archivo/marcadores activa se desbloquea, con advertencia.
        for (prof, role, via) in [(Profile::Explorar, "revisor", "marcadores"), (Profile::Proponer, "adversario", "marcadores"),
            (Profile::DelegarConRevision, "implementador", "report.json")] {
            let p = evaluate_for("codex", prof, Some(role), "wt", Detected::Found(&found), false, Delivery::FileOrMarkers);
            assert_eq!((p.status, p.reason.as_deref()), (Status::Ok, None), "{prof:?} {role}");
            assert!(p.warnings.iter().any(|w| w.contains(via)), "{:?}", p.warnings);
        }
        assert!(launch("codex", None, None, "x", Profile::Explorar, None).is_ok());
        assert_eq!(resolve_policy("codex", "explorar", "revisor", "wt").reason.as_deref().filter(|r| *r == CODEX_NO_LXO), None);
        // Consulta sin rol ni entrega: los flags siguen valiendo.
        let p = evaluate_for("codex", Profile::Explorar, None, "wt", Detected::Found(&found), false, Delivery::Query);
        assert_eq!(p.status, Status::Ok);
        // Solo workspace-write con red local permitiría entregar.
        let con_red: Vec<String> = ["codex", "--sandbox", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"].map(String::from).to_vec();
        assert!(codex_allows_local_network(&con_red));
        assert!(!codex_allows_local_network(&con_red[..3]));
        assert!(!codex_allows_local_network(&["codex".into(), "--sandbox".into(), "read-only".into()]));
    }

    #[test]
    fn claude_no_se_bloquea_por_rol() {
        let found = probe("2.1.296", CLAUDE_HELP);
        for (prof, role) in [(Profile::Explorar, "revisor"), (Profile::Proponer, "adversario"), (Profile::DelegarConRevision, "implementador")] {
            let p = evaluate_for("claude", prof, Some(role), "wt", Detected::Found(&found), false, Delivery::LxoOnly);
            assert_eq!((p.status, p.reason), (Status::Ok, None), "{prof:?} {role}");
        }
    }

    #[test]
    fn el_revisor_explora() {
        assert_eq!(Profile::for_role(true), Profile::Explorar);
        assert_eq!(Profile::for_role(false), Profile::DelegarConRevision);
    }

    #[test]
    fn responde_dialogos_de_arranque() {
        assert_eq!(auto_answer("Do you trust the contents of this directory?"), Some(&["\r"][..]));
        assert_eq!(auto_answer("Quick safety check ❯ No, exit  Yes, I trust this folder"), Some(&["\x1b[B", "\r"][..]));
        assert_eq!(auto_answer("> hola"), None);
    }

    #[test]
    fn lista_de_modelos_en_texto() {
        let m = parse_lines("Available models:\n- auto (default)\n- gpt-5.5\nanthropic/claude-sonnet-5\n");
        let ids: Vec<&str> = m.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["auto", "gpt-5.5", "anthropic/claude-sonnet-5"]);
    }
}
