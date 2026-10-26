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
        // Niveles de `codex debug models` en 0.162.1.
        efforts: &["low", "medium", "high", "xhigh", "max", "ultra"] },
    Spec { id: "cursor", label: "Cursor", bin: "cursor-agent", strengths: "Revisión de diffs, lectura del código y cambios acotados.",
        efforts: &[] },
    Spec { id: "opencode", label: "OpenCode", bin: "opencode", strengths: "Modelos de muchos proveedores: documentación, lectura, QA y tareas baratas.",
        efforts: &[] },
    Spec { id: "gemini", label: "Gemini CLI", bin: "gemini", strengths: "Contexto muy largo: leer mucho código o documentación.",
        efforts: &[] },
    Spec { id: LIXBON_CLI, label: "Lixbon CLI", bin: "lixbon", strengths: "Modelos locales o de otros proveedores (Ollama, LM Studio, OpenAI, Kilo…) con los perfiles del CLI: lectura, borradores y tareas baratas.",
        efforts: &[] },
];

/// El CLI de Lixbon como agente hijo (`lixbon worker`). No se llama `lixbon` porque
/// ese id ya es el chat del gateway.
pub const LIXBON_CLI: &str = "lixbon-cli";

/// El modelo de un rol de este proveedor es `modelo@proveedor` (un perfil de
/// `lixbon profile`); sin `@` manda el proveedor activo del CLI.
pub fn split_cli_model(model: &str) -> (&str, Option<&str>) {
    match model.rsplit_once('@') {
        Some((name, provider)) if !provider.is_empty() => (name, Some(provider)),
        _ => (model, None),
    }
}

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
const VERIFIED: &[(&str, &[&str])] = &[("claude", &["2.1.296"]), ("codex", &["0.159.0", "0.162.1"]), (LIXBON_CLI, &["2.3.0"])];

pub fn verified_versions(provider: &str) -> &'static [&'static str] {
    VERIFIED.iter().find(|(id, _)| *id == provider).map(|(_, v)| *v).unwrap_or(&[])
}

pub fn version_verified(provider: &str, version: &str) -> bool {
    verified_versions(provider).contains(&version)
}

pub const WARN_MODEL_UNVERIFIED: &str = "modelo no verificado: la CLI no lo lista entre sus modelos";

/// Con un modelo que la CLI no lista como verificado, la política queda
/// `unverified` (pide `ack_unverified`). Un bloqueo se mantiene.
pub fn mark_model(policy: &mut Policy, model: Option<&str>, verified: Option<bool>) {
    let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) else { return };
    if verified != Some(false) || policy.status == Status::Blocked {
        return;
    }
    policy.warnings.push(format!("{WARN_MODEL_UNVERIFIED} ({m})"));
    if policy.status == Status::Ok {
        policy.status = Status::Unverified;
        policy.reason = Some(format!("Modelo {m} no verificado para {}", policy.provider));
    }
}

/// Herramientas que se le quitan a Claude en los perfiles sin escritura. Bash se
/// conserva: la necesita para `lxo`.
const READ_ONLY_BLOCKED: &[&str] = &["Edit", "Write", "NotebookEdit"];

/// Órdenes de Bash que Claude puede ejecutar sin pedir permiso, en todos sus
/// perfiles: lista explícita, nunca `Bash(lxo *)`.
pub const LXO_TOOLS: [&str; 5] = ["Bash(lxo report:*)", "Bash(lxo guide)", "Bash(lxo phase:*)", "Bash(lxo ask:*)", "Bash(lxo check)"];

/// `--allowedTools`/`--disallowedTools` aceptan varios valores y se tragarían lo
/// que venga detrás: van en un solo token `--flag=a,b,c` (probado con Claude 2.1.296).
pub(super) fn allowed_tools() -> String {
    format!("--allowedTools={}", LXO_TOOLS.join(","))
}

pub(super) fn disallowed_tools() -> String {
    format!("--disallowedTools={}", READ_ONLY_BLOCKED.join(","))
}

/// Reglas de un token `--flag=a,b` del argv (para la política y las pruebas).
pub fn flag_list<'a>(argv: &'a [String], flag: &str) -> Option<Vec<&'a str>> {
    argv.iter().find_map(|a| a.strip_prefix(flag)?.strip_prefix('=')).map(|v| v.split(',').collect())
}
/// Aviso y motivo de bloqueo del perfil read-only de Codex con `[windows] sandbox = "elevated"`.
pub const ELEVATED: &str = "el sandbox elevado falla y Codex sale del read-only";
/// Delegar con Codex y `[windows] sandbox = "elevated"`: no se bloquea, pero avisa y pide confirmación.
pub const WARN_ELEVATED_RW: &str = "el sandbox elevado de Codex falla en esta máquina: puede editar archivos pero no ejecutar comandos";
/// ¿Este perfil de Codex lleva el aviso del sandbox elevado? Solo Delegar (Autonomía sigue aplazada).
pub fn codex_elevated_warns(provider: &str, profile: Profile) -> bool {
    provider == "codex" && profile == Profile::DelegarConRevision
}
pub const WARN_EXEC: &str = "No interactivo: se lanza con codex exec; la terminal muestra la salida pero no acepta teclado.";
pub const WARN_EXEC_O: &str = "El host añade -o .lixbon/out/<tarea>/1/last-message.md al lanzar: el informe es el mensaje final del agente, de cualquier tamaño, escrito por la CLI.";
pub const WARN_DELEGAR: &str = "Los comandos de solo lectura y las cinco reglas de lxo corren sin pedir aprobación. Los comandos que modifican algo esperan aprobación en la terminal; si nadie responde a tiempo, la tarea falla.";
pub const WARN_CODEX_BIG: &str = "Codex puede rechazar informes de más de unos 50 KB: mantén el mensaje final por debajo de ese tamaño.";
pub const WARN_LIXBON_CLI: &str = "No interactivo: se lanza con lixbon worker; la terminal muestra la salida pero no acepta teclado. El informe es la respuesta final del modelo y lo entrega el propio CLI.";
pub const WARN_LIXBON_CLI_PLAN: &str = "La solo lectura la aplica el CLI (modo plan): no hay sandbox del sistema.";
pub const WARN_LIXBON_CLI_DELEGAR: &str = "Edita sin preguntar dentro del worktree; solo ejecuta los comandos de allowed_commands del CLI y las llamadas a lxo (los demás se rechazan: nadie responde en la terminal). No usa servidores MCP.";
pub const WARN_STREAM: &str ="No interactivo: se lanza con claude -p --output-format stream-json; el informe se toma del resultado final, sin depender de que el agente ejecute lxo.";

/// Flags de permisos de un perfil para un proveedor (sin el binario). `exec`
/// indica `codex exec`, que no acepta `-a/--ask-for-approval`.
fn profile_flags(provider: &str, profile: Profile, worktree: &str, exec: bool) -> Result<(Vec<String>, Vec<String>), String> {
    let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    let mut warnings = vec![];
    if codex_exec(provider, profile) {
        warnings.push(WARN_EXEC.into());
        warnings.push(WARN_EXEC_O.into());
        warnings.push(WARN_CODEX_BIG.into());
    }
    let flags = match (provider, profile) {
        ("claude", Profile::Explorar | Profile::Proponer) => {
            // Bash solo para `lxo` (sintaxis del --help de 2.1.296: "Bash(git *)").
            let mut f = v(&["-p", "--output-format", "stream-json", "--verbose"]);
            f.push(disallowed_tools());
            f.push(allowed_tools());
            f.extend(v(&["--permission-mode", "plan"]));
            warnings.push(WARN_STREAM.into());
            warnings.push("Claude no tiene sandbox del sistema: el modo plan lo aplica la CLI y Bash depende de su política.".into());
            warnings.push("La red y las lecturas fuera del repo no están bloqueadas.".into());
            if profile == Profile::Proponer {
                warnings.push("El parche lo entrega el agente como texto; el host no comprueba que aplique hasta intentarlo.".into());
            }
            f
        }
        ("claude", Profile::DelegarConRevision) => {
            warnings.push(WARN_DELEGAR.into());
            warnings.push("El aislamiento lo da el worktree de git, no la CLI; un comando permitido puede escribir fuera de él.".into());
            let mut f = vec![allowed_tools()];
            f.extend(v(&["--permission-mode", "acceptEdits"]));
            f
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
        (LIXBON_CLI, _) => {
            warnings.push(WARN_LIXBON_CLI.into());
            match profile {
                Profile::Explorar | Profile::Proponer => warnings.push(WARN_LIXBON_CLI_PLAN.into()),
                Profile::DelegarConRevision => warnings.push(WARN_LIXBON_CLI_DELEGAR.into()),
                Profile::AutonomiaAmplia => {}
            }
            v(&["worker", "--profile", profile.id()])
        }
        _ => return Err(format!("{provider} no tiene perfiles de permisos definidos; solo se lanza sin saltar permisos con claude, codex o lixbon-cli")),
    };
    if exec && provider == "codex" {
        warnings.push("codex exec no acepta -a/--ask-for-approval: se omite.".into());
    }
    Ok((flags, warnings))
}

/// El perfil read-only de Codex se lanza siempre con `codex exec` (entrega con -o).
pub fn codex_exec(provider: &str, profile: Profile) -> bool {
    provider == "codex" && matches!(profile, Profile::Explorar | Profile::Proponer)
}

/// Lo que se sabe de la CLI instalada: su `--version` y el `--help` del modo con
/// que se lanza.
#[derive(Clone, Debug, Default)]
pub struct Probe {
    pub version: Option<String>,
    pub help: Option<String>,
    /// `codex exec --help` (si es `None` se usa `help`).
    pub exec_help: Option<String>,
    /// Valor de `[windows] sandbox` en la config de Codex (solo se lee en Windows).
    pub windows_sandbox: Option<String>,
}

pub const WARN_PLAN_SONNET: &str = "en modo plan, Claude responde con Sonnet aunque pidas otro modelo";

/// La política lanza Claude con `--permission-mode plan`.
pub fn is_plan(policy: &Policy) -> bool {
    policy.provider == "claude" && policy.argv.windows(2).any(|w| w[0] == "--permission-mode" && w[1] == "plan")
}

/// Probado con Claude 2.1.296: en plan, `--model haiku` deja el init en haiku pero
/// responde `claude-sonnet-5-5`. Si se pide un modelo que no es Sonnet, se avisa.
pub fn warn_plan_model(policy: &mut Policy, model: Option<&str>) {
    let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) else { return };
    if is_plan(policy) && !m.to_ascii_lowercase().contains("sonnet") && !policy.warnings.iter().any(|w| w == WARN_PLAN_SONNET) {
        policy.warnings.push(WARN_PLAN_SONNET.into());
    }
}

/// El modelo efectivo es de la familia pedida: `haiku` casa con `claude-haiku-*`,
/// un id completo casa consigo mismo o con su versión fechada.
pub fn same_model_family(requested: &str, effective: &str) -> bool {
    let (r, e) = (requested.trim().to_ascii_lowercase(), effective.trim().to_ascii_lowercase());
    e == r || e.starts_with(&format!("{r}-")) || e.starts_with(&format!("claude-{r}-")) || e == format!("claude-{r}")
}

/// `[windows] sandbox = "..."` (o `windows.sandbox = "..."`) de un config.toml de Codex.
pub fn codex_windows_sandbox(toml: &str) -> Option<String> {
    let mut section = String::new();
    let mut found = None;
    for raw in toml.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.starts_with('[') {
            section = line.trim_matches(|c| c == '[' || c == ']').trim().to_string();
            continue;
        }
        let Some((k, val)) = line.split_once('=') else { continue };
        let key = k.trim().trim_matches('"');
        let full = if section.is_empty() { key.to_string() } else { format!("{section}.{key}") };
        if full == "windows.sandbox" {
            found = Some(val.trim().trim_matches(|c| c == '"' || c == '\'').to_string());
        }
    }
    found
}

/// Ruta de la config de Codex: `$CODEX_HOME/config.toml` o `~/.codex/config.toml`.
fn codex_config_path() -> Option<std::path::PathBuf> {
    codex_home().map(|h| h.join("config.toml"))
}

/// `$CODEX_HOME` o `~/.codex`.
pub fn codex_home() -> Option<std::path::PathBuf> {
    if let Some(h) = std::env::var_os("CODEX_HOME").filter(|h| !h.is_empty()) {
        return Some(std::path::PathBuf::from(h));
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(std::path::PathBuf::from(home).join(".codex"))
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

/// Por qué una política quedó `blocked`, como TIPO: nunca se deduce del texto de `Policy.reason`. Lo fijan los puntos de
/// `evaluate`/`evaluate_for`/`resolve_task_policy` que bloquean.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockCause {
    /// El pedido no es válido (proveedor, perfil o rol desconocidos; combinación proveedor × perfil sin definición).
    Invalid,
    /// El perfil está definido pero deshabilitado ([`Profile::disabled_reason`]): decisión explícita de policy.
    ProfileDisabled,
    /// La entrega por `lxo done` no es posible en el sandbox (Codex sin red local).
    Delivery,
    /// La ruta del worktree de ESTA solicitud no se puede pasar a la CLI. No es una condición del proveedor (otra ruta
    /// funcionaría), así que no es `Environment`: no produce `environment.blocked`.
    WorktreePath,
    /// El entorno o el proveedor impide lanzar. Es la única causa que produce `environment.blocked`.
    Environment(EnvBlock),
}

/// Bloqueos del entorno/proveedor que el host comprueba antes de lanzar. Conjunto CERRADO: viaja TIPADO hasta la
/// frontera `Tx`/Event (`environment.blocked` / `environment.cleared` lo serializan con `code()`) y se guarda en
/// `State.env_blocks`; no hay cadenas libres que puedan persistirse y que el proyector ignore.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvBlock {
    /// La CLI del proveedor no está en el PATH.
    CliMissing,
    /// La versión instalada de la CLI no trae los flags que exige el perfil.
    CliFlagsUnsupported,
    /// El sandbox elevado de Codex en Windows impide el perfil de solo lectura.
    WindowsSandboxElevated,
}

impl EnvBlock {
    pub const ALL: [EnvBlock; 3] = [EnvBlock::CliMissing, EnvBlock::CliFlagsUnsupported, EnvBlock::WindowsSandboxElevated];

    pub fn code(self) -> &'static str {
        match self {
            EnvBlock::CliMissing => "cli_missing",
            EnvBlock::CliFlagsUnsupported => "cli_flags_unsupported",
            EnvBlock::WindowsSandboxElevated => "windows_sandbox_elevated",
        }
    }

    pub fn parse(code: &str) -> Option<EnvBlock> {
        EnvBlock::ALL.into_iter().find(|b| b.code() == code)
    }
}

/// Evidencia POSITIVA de entorno de una comprobación real de la CLI, separada de `Policy.status`: la versión (`VERIFIED`) y
/// el modelo (`mark_model`) deciden si se pide `ack_unverified`, pero no dicen nada de si el entorno funciona. Solo
/// [`evaluate`] la fija, y solo con la CLI hallada y su `--help` LEGIBLE (`Skip`, CLI ausente o ayuda ilegible: nada
/// demostrado). Cada campo demuestra una causa de [`EnvBlock`]; lo ambiguo queda en `false` y conserva el bloqueo. Una
/// policy bloqueada por flags o por sandbox elevado solo lleva lo que esa comprobación llegó a demostrar (la CLI está;
/// con el sandbox, además los flags), nunca lo que no llegó a examinar.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EnvProof {
    /// La CLI está en el PATH y respondió a `--help`.
    pub cli_present: bool,
    /// Todos los flags del perfil (y `-o` de `codex exec`) aparecen en el `--help` de esa versión.
    pub flags_supported: bool,
    /// La config de Codex declara un sandbox de Windows que es POSITIVAMENTE no elevado (`mxc` o `unelevated`, ver
    /// [`sandbox_proves_not_elevated`]). Sin valor leído (no es Windows, no es Codex o el fichero no dice nada) o con un
    /// valor desconocido no se demuestra nada.
    pub sandbox_not_elevated: bool,
}

impl EnvProof {
    /// ¿Esta evidencia demuestra que `block` ya no se da?
    pub fn demonstrates(self, block: EnvBlock) -> bool {
        match block {
            EnvBlock::CliMissing => self.cli_present,
            EnvBlock::CliFlagsUnsupported => self.flags_supported,
            EnvBlock::WindowsSandboxElevated => self.sandbox_not_elevated,
        }
    }

    pub fn any(self) -> bool {
        EnvBlock::ALL.into_iter().any(|b| self.demonstrates(b))
    }
}

/// Valores oficiales de `[windows] sandbox` en la config de Codex: `mxc`, `elevated` y `unelevated`. Solo `mxc` y
/// `unelevated` son evidencia POSITIVA de que el sandbox no es el elevado; `elevated` es el bloqueo, y un valor ausente
/// o desconocido (otra versión, una errata, otra mayúscula) no demuestra nada: la comparación es exacta.
pub fn sandbox_proves_not_elevated(value: Option<&str>) -> bool {
    matches!(value, Some("mxc" | "unelevated"))
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
    /// `false`: la CLI corre sin TUI (codex exec, claude -p); se ve pero no se le escribe.
    pub interactive: bool,
    /// Modelo que se pedirá; con Codex sin modelo, MODEL_FROM_CONFIG (nunca un
    /// nombre inventado). `null` en Claude sin modelo.
    pub model: Option<String>,
    /// Por qué está `blocked` (solo entonces). Tipado; no forma parte del contrato hacia la interfaz.
    #[serde(skip)]
    pub block: Option<BlockCause>,
    /// Evidencia positiva de entorno de esta comprobación. Tipada y fuera del contrato hacia la interfaz.
    #[serde(skip)]
    pub env_proof: EnvProof,
}

pub const MODEL_FROM_CONFIG: &str = "el que defina config.toml";

/// Muestra en la política el modelo pedido (o de dónde saldrá).
pub fn set_model(policy: &mut Policy, model: Option<&str>) {
    policy.model = match model.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => Some(m.to_string()),
        None if policy.provider == "codex" => Some(MODEL_FROM_CONFIG.into()),
        None => None,
    };
}

pub const WARN_EFFORT_UNVERIFIED: &str = "esfuerzo no verificado: la CLI no lo lista entre sus niveles";

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
        let name = a.split('=').next().unwrap_or(a);
        if !help_has(help, name) {
            missing.push(name.to_string());
            continue;
        }
        if ["--sandbox", "--permission-mode", "--ask-for-approval", "--output-format"].contains(&a.as_str()) {
            if let Some(val) = argv.get(i + 1).filter(|v| !help_has(help, v)) {
                missing.push(format!("{a} {val}"));
            }
        }
    }
    missing
}

fn blocked(provider: &str, profile: &str, argv: Vec<String>, cli_version: Option<String>, warnings: Vec<String>, reason: String, cause: BlockCause) -> Policy {
    let interactive = !(argv.get(1).is_some_and(|a| a == "exec" || a == "worker") || argv.iter().any(|a| a == "stream-json"));
    Policy { profile: profile.into(), role: None, provider: provider.into(), argv, cli_version, warnings, status: Status::Blocked, reason: Some(reason), interactive, model: None, block: Some(cause), env_proof: EnvProof::default() }
}

/// La ruta del worktree se puede pasar a la CLI (sin caracteres de cmd). Es el MISMO criterio con el que `evaluate`
/// bloquea por entorno ANTES de mirar el perfil: [`explicit_denial`] lo comparte para respetar esa precedencia.
fn worktree_is_passable(worktree: &str) -> bool {
    !worktree.chars().any(|c| "\"%^&|<>\r\n".contains(c))
}

/// Resuelve la política sin efectos: todo lo de la CLI llega en `detected`.
/// `exec` pide `codex exec`; el perfil read-only de Codex lo usa siempre.
pub fn evaluate(provider: &str, profile: Profile, worktree: &str, detected: Detected, exec: bool) -> Policy {
    let exec = exec || codex_exec(provider, profile);
    let pid = profile.id();
    let Some(a) = spec(provider) else {
        return blocked(provider, pid, vec![], None, vec![], format!("Proveedor desconocido: {provider}"), BlockCause::Invalid);
    };
    if !worktree_is_passable(worktree) {
        return blocked(provider, pid, vec![], None, vec![], "La ruta del worktree tiene caracteres que no se pueden pasar a la CLI".into(), BlockCause::WorktreePath);
    }
    let (flags, warnings) = match profile_flags(provider, profile, worktree, exec) {
        Ok(f) => f,
        Err(e) => return blocked(provider, pid, vec![], None, vec![], e, BlockCause::Invalid),
    };
    let mut argv = vec![a.bin.to_string()];
    if exec { argv.push("exec".into()); }
    argv.extend(flags);
    if let Some(r) = profile.disabled_reason() {
        return blocked(provider, pid, argv, None, warnings, r.into(), BlockCause::ProfileDisabled);
    }
    let interactive = !(exec || provider == LIXBON_CLI || argv.iter().any(|a| a == "stream-json"));
    let ok = |status, version, reason| Policy { profile: pid.into(), role: None, provider: provider.into(), argv: argv.clone(), cli_version: version, warnings: warnings.clone(), status, reason, interactive, model: None, block: None, env_proof: EnvProof::default() };
    match detected {
        Detected::Skip => ok(Status::Unverified, None, Some("No verificado: no se consultó --version ni --help".into())),
        Detected::Missing => blocked(provider, pid, argv.clone(), None, warnings.clone(), format!("No se encontró `{}` en el PATH", a.bin), BlockCause::Environment(EnvBlock::CliMissing)),
        Detected::Found(p) => {
            let version = p.version.clone();
            let help = if exec { p.exec_help.as_ref().or(p.help.as_ref()) } else { p.help.as_ref() };
            let Some(help) = help else {
                return ok(Status::Unverified, version, Some("No verificado: no se pudo leer --help".into()));
            };
            let mut missing = missing_flags(&argv[1..], help);
            // -o lo añade el host al lanzar: también tiene que existir.
            if exec && !help_has(help, "--output-last-message") {
                missing.push("-o/--output-last-message".into());
            }
            if !missing.is_empty() {
                let v = version.as_deref().unwrap_or("versión desconocida");
                let mut pol = blocked(provider, pid, argv.clone(), version.clone(), warnings.clone(),
                    format!("{} {v} no admite: {}", a.label, missing.join(", ")), BlockCause::Environment(EnvBlock::CliFlagsUnsupported));
                // La CLI se halló y su ayuda se leyó: eso desmiente `cli_missing`. Los flags faltan y el sandbox NO se
                // examina antes de bloquear por flags, así que ni uno ni otro se demuestran.
                pol.env_proof = EnvProof { cli_present: true, flags_supported: false, sandbox_not_elevated: false };
                return pol;
            }
            if codex_exec(provider, profile) && p.windows_sandbox.as_deref() == Some("elevated") {
                let mut w = warnings.clone();
                w.push(ELEVATED.into());
                let mut pol = blocked(provider, pid, argv.clone(), version.clone(), w, ELEVATED.into(), BlockCause::Environment(EnvBlock::WindowsSandboxElevated));
                // Llegar aquí demuestra la CLI hallada y todos los flags del perfil; del sandbox solo que SIGUE elevado.
                pol.env_proof = EnvProof { cli_present: true, flags_supported: true, sandbox_not_elevated: false };
                return pol;
            }
            let verified = VERIFIED.iter().find(|(id, _)| *id == provider).map(|(_, v)| *v).unwrap_or(&[]);
            let mut pol = match version.as_deref() {
                Some(v) if verified.contains(&v) => ok(Status::Ok, version.clone(), None),
                v => ok(Status::Unverified, version.clone(), Some(format!(
                    "Versión {} no verificada (verificadas: {}); sus flags sí aparecen en --help",
                    v.unwrap_or("desconocida"), verified.join(", ")))),
            };
            // La evidencia de entorno no depende de la versión: CLI hallada con ayuda legible y todos los flags presentes.
            pol.env_proof = EnvProof {
                cli_present: true,
                flags_supported: true,
                sandbox_not_elevated: sandbox_proves_not_elevated(p.windows_sandbox.as_deref()),
            };
            if codex_elevated_warns(provider, profile) && p.windows_sandbox.as_deref() == Some("elevated") {
                pol.warnings.push(WARN_ELEVATED_RW.into());
                pol.status = Status::Unverified;
                pol.reason = Some(match pol.reason.take() {
                    Some(r) => format!("{r}; {WARN_ELEVATED_RW}"),
                    None => WARN_ELEVATED_RW.into(),
                });
            }
            pol
        }
    }
}

/// Motivo de bloqueo cuando Codex tendría que entregar con `lxo done` desde un
/// sandbox sin red local.
pub const CODEX_NO_LXO: &str = "Codex en este sandbox no puede conectarse al host local para entregar con lxo done; ver PR de entrega por archivo";

pub const WARN_NO_ASK: &str = "Sin red local, Codex no puede usar lxo ask: no podrá preguntarle a la persona y decidirá solo.";
pub const WARN_COPY_BLOCK: &str = "Respaldo si no llega el -o: el bloque por la salida solo vale hasta 50 KB y con el hash exacto; si no, el informe queda como no entregado.";
pub const WARN_STDOUT_LIMIT: &str = "Si no llega report.json, el bloque por la salida solo vale hasta 50 KB; por encima el informe queda como no entregado.";

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
        p.block = Some(BlockCause::Invalid);
        return p;
    }
    if p.status != Status::Blocked && provider == "codex" && !codex_allows_local_network(&p.argv) {
        match delivery {
            Delivery::LxoOnly => {
                p.status = Status::Blocked;
                p.reason = Some(CODEX_NO_LXO.into());
                p.block = Some(BlockCause::Delivery);
            }
            Delivery::FileOrMarkers => {
                let read_only = p.argv.iter().any(|a| a == "read-only");
                p.warnings.push(if read_only {
                    "Sin red local: entrega con el mensaje final (codex exec -o); lxo phase, ask y check no llegan al host.".into()
                } else {
                    "Sin red local: entrega con lxo report (report.json); lxo phase, ask y check no llegan al host.".into()
                });
                p.warnings.push(WARN_NO_ASK.into());
                p.warnings.push(if read_only { WARN_COPY_BLOCK } else { WARN_STDOUT_LIMIT }.into());
            }
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
        // El CLI de Lixbon declara sus flags de agente hijo en `worker --help`, no en la ayuda general.
        help: output(bin, if bin == "lixbon" { &["worker", "--help"] } else { &["--help"] }, short).filter(|h| !h.trim().is_empty()),
        exec_help: (bin == "codex").then(|| output(bin, &["exec", "--help"], short)).flatten().filter(|h| !h.trim().is_empty()),
        windows_sandbox: None,
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
            "Perfil desconocido: {profile}. Usa uno de: {}", Profile::ALL.map(|p| p.id()).join(", ")), BlockCause::Invalid);
        p.role = role.map(str::to_string);
        return p;
    };
    let Some(a) = spec(provider) else {
        return evaluate_for(provider, prof, role, worktree, Detected::Skip, false, delivery);
    };
    match probe(a.bin) {
        Some(mut p) => {
            if cfg!(windows) && provider == "codex" {
                p.windows_sandbox = codex_config_path().and_then(|f| std::fs::read_to_string(f).ok()).as_deref().and_then(codex_windows_sandbox);
            }
            evaluate_for(provider, prof, role, worktree, Detected::Found(&p), false, delivery)
        }
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
    launch_task(policy, model, effort, prompt, None)
}

/// Como `launch_with`; con `codex exec` añade `-o <last_message>` (lo fija el host
/// por intento, por eso no va en el argv de la política). Claude con stream-json
/// corre con la salida canalizada: el JSONL llega sin cortes de ConPTY.
pub fn launch_task(policy: &Policy, model: Option<&str>, effort: Option<&str>, prompt: &str, last_message: Option<&str>) -> Result<Launch, String> {
    build_launch(policy, model, effort, prompt, last_message, true)
}

/// Valida el PEDIDO de un lanzamiento sin aplicar la compuerta de policy: agente conocido y disponible, modelo y
/// esfuerzo admitidos, rol existente y una combinación proveedor × perfil que tenga definición. Todo eso es
/// ENTRADA: si falla es un error y no se registra nada. Que una solicitud así de válida acabe `blocked` lo decide
/// después la policy (ver [`explicit_denial`]); quien llama aplica la compuerta con [`authorize`].
pub fn check_request(agent: &str, model: Option<&str>, effort: Option<&str>, profile: Profile, role: Option<&str>) -> Result<(), String> {
    if let Some(r) = role.filter(|r| super::roles::spec(r).is_none()) {
        return Err(format!("Rol desconocido: {r}"));
    }
    let policy = evaluate_for(agent, profile, role, ".", Detected::Skip, false, Delivery::FileOrMarkers);
    build_launch(&policy, model, effort, "x", None, false)?;
    profile_flags(agent, profile, ".", codex_exec(agent, profile)).map(|_| ())
}

/// Denegación EXPLÍCITA de policy: la solicitud es válida y una decisión de producto, no el entorno, la rechaza.
/// Es la causa EFECTIVA del bloqueo: si el entorno (ruta del worktree inservible) o una combinación sin definición
/// ya bloquean antes que el perfil —en el orden de [`evaluate`]—, el bloqueo NO es una denegación de policy.
/// Es lo único que justifica registrar `spawn.requested` con `policy_status = blocked`. Cerrado y tipado: nunca se
/// deduce del texto de `Policy.reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PolicyDenial {
    /// El perfil está definido pero deshabilitado ([`Profile::disabled_reason`]).
    ProfileDisabled,
}

/// ¿Esta solicitud ya VÁLIDA (ver [`check_request`]) la deniega, en el worktree REAL donde correría, una decisión
/// explícita de policy? Un bloqueo del entorno (CLI ausente, flags que la versión instalada no trae, sandbox elevado,
/// ruta del worktree inservible) o del proveedor NO lo es: esos no se registran como solicitud denegada y nunca son
/// `risk`, aunque el perfil esté además deshabilitado. Es una función de tipos y de la ruta: no consulta la CLI.
pub fn explicit_denial(provider: &str, profile: Profile, worktree: &str) -> Option<PolicyDenial> {
    // Mismo orden que `evaluate`: primero el entorno (ruta) y la definición de proveedor × perfil, después el perfil.
    if !worktree_is_passable(worktree) {
        return None;
    }
    profile_flags(provider, profile, worktree, codex_exec(provider, profile)).ok()?;
    profile.disabled_reason().map(|_| PolicyDenial::ProfileDisabled)
}

/// La política de una denegación explícita, SIN consultar la CLI del proveedor (ni `--version`/`--help` ni su lista de
/// modelos): con el perfil deshabilitado el resultado es el mismo que el de la resolución completa, así que no hay
/// nada que sondear antes de denegar.
pub fn denial_policy(provider: &str, profile: Profile, role: Option<&str>, worktree: &str, model: Option<&str>) -> Policy {
    let mut policy = evaluate_for(provider, profile, role, worktree, Detected::Skip, false, Delivery::FileOrMarkers);
    set_model(&mut policy, model);
    policy
}

fn build_launch(policy: &Policy, model: Option<&str>, effort: Option<&str>, prompt: &str, last_message: Option<&str>, enforce_policy: bool) -> Result<Launch, String> {
    let agent = policy.provider.as_str();
    let a = spec(agent).ok_or_else(|| format!("Agente desconocido: {agent}. Usa uno de `lxo agents`."))?;
    if PAUSED.contains(&agent) {
        return Err(format!("{} no está disponible todavía como agente hijo en Lixbon. Usa uno de `lxo agents`.", a.label));
    }
    if enforce_policy && policy.status == Status::Blocked {
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
    if policy.argv.get(1).is_some_and(|a| a == "exec") {
        if let Some(lm) = last_message {
            if lm.chars().any(|c| "\"%^&|<>\r\n".contains(c)) {
                return Err("La ruta del mensaje final tiene caracteres que no se pueden pasar a la CLI".into());
            }
            args.extend(["-o".into(), format!("\"{lm}\"")]);
        }
    }
    let piped = policy.argv.iter().any(|a| a == "stream-json");
    match agent {
        "claude" => {
            if let Some(m) = &model { args.extend(["--model".into(), m.clone()]); }
            if let Some(e) = &effort { args.extend(["--effort".into(), e.clone()]); }
            // Fin de opciones: el prompt nunca se lee como valor de un flag (Claude 2.1.296 acepta `--`).
            args.push("--".into());
        }
        "codex" => {
            if let Some(m) = &model { args.extend(["--model".into(), m.clone()]); }
            if let Some(e) = &effort { args.extend(["-c".into(), format!("model_reasoning_effort={e}")]); }
        }
        LIXBON_CLI => {
            if let Some(m) = &model {
                let (name, provider) = split_cli_model(m);
                if let Some(p) = provider { args.extend(["--provider".into(), p.to_string()]); }
                if !name.is_empty() { args.extend(["--model".into(), name.to_string()]); }
            }
        }
        _ => {
            if let Some(m) = &model {
                return Err(format!("Se pidió el modelo {m} pero el lanzamiento de {} no lo lleva en el argv: no se lanza", a.label));
            }
        }
    }
    args.push(format!("\"{prompt}\""));
    Ok(Launch { command: args.join(" "), env: vec![], inject: None, piped })
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

/// `--version` y `--help` (con caché) para la lista de proveedores.
pub fn probe_cli(bin: &str) -> Option<Probe> {
    probe(bin)
}

pub fn cli_output(bin: &str, args: &[&str], timeout: Duration) -> Option<String> {
    output(bin, args, timeout)
}

pub fn codex_config_text() -> Option<String> {
    codex_config_path().and_then(|f| std::fs::read_to_string(f).ok())
}

/// Modelos del `initialize` de Claude como (id, label); `None` si no respondió.
pub fn claude_init_models() -> Option<Vec<(String, String)>> {
    let l = claude_models_init()?;
    Some(l.into_iter().map(|m| (m.id, m.label)).collect())
}

/// Los modelos de Claude salen de su `initialize`, igual que en el chat de Claude Code.
fn claude_models() -> Vec<Model> {
    claude_models_init().unwrap_or_else(|| ["opus", "sonnet", "haiku", "fable"].iter().map(|m| Model { id: m.to_string(), label: m.to_string(), note: String::new() }).collect())
}

fn claude_models_init() -> Option<Vec<Model>> {
    let fallback = || None;
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
                return Some(out);
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
        // `codex debug models` imprime JSON (0.162.1): una lista de texto no sirve.
        "codex" => output("codex", &["debug", "models"], long).as_deref().and_then(super::providers::codex_debug_models)
            .map(|(l, _)| l.into_iter().map(|m| Model { id: m.id, label: m.label, note: String::new() }).collect()).unwrap_or_default(),
        "cursor" => output("cursor-agent", &["models"], long).map(|t| parse_lines(&t)).unwrap_or_default(),
        LIXBON_CLI => output("lixbon", &["profile", "list", "--json"], long).as_deref().map(super::providers::lixbon_profile_models)
            .map(|l| l.into_iter().map(|m| Model { id: m.id, label: m.label, note: String::new() }).collect()).unwrap_or_default(),
        _ => vec![],
    }
}

fn hint(id: &str) -> &'static str {
    match id {
        "claude" => "--model con un alias (opus, sonnet, haiku, fable) o un id completo",
        "codex" => "--model con un id de OpenAI (mira los de `codex debug models`); --effort low|medium|high|xhigh|max|ultra",
        "opencode" => "--model proveedor/modelo, tal como sale en la lista",
        "cursor" => "--model con un id de la lista de Cursor",
        "gemini" => "--model con un id de Gemini",
        LIXBON_CLI => "--model modelo@proveedor, con un proveedor de `lixbon profile`; sin @ usa el proveedor activo del CLI",
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

    #[test]
    fn modelo_no_verificado_pide_ack() {
        let mut p = evaluate("codex", Profile::DelegarConRevision, "wt", Detected::Skip, false);
        p.status = Status::Ok;
        p.reason = None;
        mark_model(&mut p, Some("gpt-6.1-sol"), Some(false));
        assert_eq!(p.status, Status::Unverified);
        assert!(p.warnings.iter().any(|w| w.starts_with(WARN_MODEL_UNVERIFIED)));
        assert!(authorize(&p, None, false).unwrap_err().contains("ack_unverified"));
        let rec = authorize(&p, None, true).unwrap();
        assert!(rec.ack_unverified);
        // Verificado o desconocido: no cambia.
        let mut q = p.clone();
        q.status = Status::Ok;
        mark_model(&mut q, Some("gpt-6.1-sol"), Some(true));
        mark_model(&mut q, Some("x"), None);
        assert_eq!(q.status, Status::Ok);
        // Bloqueado sigue bloqueado.
        let mut b = p.clone();
        b.status = Status::Blocked;
        mark_model(&mut b, Some("x"), Some(false));
        assert_eq!(b.status, Status::Blocked);
    }

    #[test]
    fn aviso_de_delegar_en_claude() {
        let p = evaluate("claude", Profile::DelegarConRevision, "wt", Detected::Skip, false);
        assert!(p.warnings.iter().any(|w| w == "Los comandos de solo lectura y las cinco reglas de lxo corren sin pedir aprobación. Los comandos que modifican algo esperan aprobación en la terminal; si nadie responde a tiempo, la tarea falla."), "{:?}", p.warnings);
        assert!(!p.warnings.iter().any(|w| w.starts_with("Solo se ejecutan sin pedir permiso")));
        let e = evaluate("claude", Profile::Explorar, "wt", Detected::Skip, false);
        assert!(!e.warnings.iter().any(|w| w == WARN_DELEGAR));
    }
    use super::*;

    const CODEX_HELP: &str = include_str!("testdata/codex-0.159.0-help.txt");
    const CODEX_EXEC_HELP: &str = include_str!("testdata/codex-0.159.0-exec-help.txt");
    const CLAUDE_HELP: &str = include_str!("testdata/claude-2.1.296-help.txt");
    const CODEX_EXEC_HELP_162: &str = include_str!("testdata/codex-0.162.1-exec-help.txt");
    const BYPASS: &[&str] = &["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--allow-dangerously-skip-permissions",
        "bypassPermissions", "danger-full-access", "--yolo"];

    fn probe(version: &str, help: &str) -> Probe {
        Probe { version: Some(version.into()), help: Some(help.into()), exec_help: Some(CODEX_EXEC_HELP_162.into()), windows_sandbox: None }
    }

    #[test]
    fn lanzadores_con_perfil_y_modelo() {
        let l = launch("claude", Some("opus"), Some("high"), "Lee la tarea", Profile::DelegarConRevision, None).unwrap();
        assert_eq!(l.command, r#"claude "--allowedTools=Bash(lxo report:*),Bash(lxo guide),Bash(lxo phase:*),Bash(lxo ask:*),Bash(lxo check)" --permission-mode acceptEdits --model opus --effort high -- "Lee la tarea""#);
        assert!(!l.piped);
        assert!(launch("opencode", Some("anthropic/claude-sonnet-5"), None, "x", Profile::Explorar, None).is_err());
        let l = launch_with(&evaluate("codex", Profile::Explorar, ".", Detected::Skip, false), Some("gpt-5.5"), Some("high"), "x").unwrap();
        assert_eq!(l.command, r#"codex exec --sandbox read-only --model gpt-5.5 -c model_reasoning_effort=high "x""#);
        let p = evaluate("codex", Profile::Explorar, ".", Detected::Skip, false);
        let l = launch_task(&p, None, None, "x", Some(r"C:\Mis Documentos\wt\.lixbon\out\t2\1\last-message.md")).unwrap();
        assert_eq!(l.command, r#"codex exec --sandbox read-only -o "C:\Mis Documentos\wt\.lixbon\out\t2\1\last-message.md" "x""#);
        assert!(launch_task(&p, None, None, "x", Some("a&b")).is_err());
        assert!(launch("claude", Some("opus & del"), None, "x", Profile::Explorar, None).is_err());
        assert!(launch("gemini", None, None, "x", Profile::Explorar, None).is_err());
    }

    #[test]
    fn explorar_en_claude_sin_herramientas_de_edicion() {
        let l = launch("claude", Some("haiku"), None, "Lee", Profile::Explorar, Some("explorador")).unwrap();
        assert_eq!(l.command, r#"claude -p --output-format stream-json --verbose --disallowedTools=Edit,Write,NotebookEdit "--allowedTools=Bash(lxo report:*),Bash(lxo guide),Bash(lxo phase:*),Bash(lxo ask:*),Bash(lxo check)" --permission-mode plan --model haiku -- "Lee""#);
        // stream-json va canalizado: el JSONL llega sin pasar por ConPTY.
        assert!(l.piped);
    }

    #[test]
    fn argv_por_perfil_y_proveedor() {
        let wt = "C:\\Users\\USUARIO\\wt";
        let argv = |prov, prof| evaluate(prov, prof, wt, Detected::Skip, false).argv.join(" ");
        let tools = "--allowedTools=Bash(lxo report:*),Bash(lxo guide),Bash(lxo phase:*),Bash(lxo ask:*),Bash(lxo check)";
        let plan = format!("claude -p --output-format stream-json --verbose --disallowedTools=Edit,Write,NotebookEdit {tools} --permission-mode plan");
        assert_eq!(argv("claude", Profile::Explorar), plan);
        assert_eq!(argv("claude", Profile::Proponer), plan);
        assert_eq!(argv("claude", Profile::DelegarConRevision), format!("claude {tools} --permission-mode acceptEdits"));
        assert_eq!(argv("codex", Profile::Explorar), "codex exec --sandbox read-only");
        assert_eq!(argv("codex", Profile::Proponer), "codex exec --sandbox read-only");
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
        let tui = evaluate("codex", Profile::DelegarConRevision, "wt", Detected::Found(&probe("0.159.0", CODEX_HELP)), false);
        assert_eq!((tui.status, tui.cli_version.as_deref()), (Status::Ok, Some("0.159.0")));
        let mismo_argv_en_exec = missing_flags(&tui.argv[1..], CODEX_EXEC_HELP);
        assert_eq!(mismo_argv_en_exec, ["--ask-for-approval"]);
        let exec = evaluate("codex", Profile::Explorar, "wt", Detected::Found(&probe("0.162.1", CODEX_HELP)), false);
        assert_eq!(exec.argv, ["codex", "exec", "--sandbox", "read-only"]);
        assert_eq!(exec.status, Status::Ok);
        assert!(!exec.interactive);
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
        for k in ["profile", "role", "provider", "argv", "cli_version", "warnings", "status", "reason", "interactive"] {
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
        // Un `codex exec --help` sin -o: el read-only no se puede entregar, bloqueado.
        let sin_o = Probe { exec_help: Some(CODEX_EXEC_HELP_162.replace("--output-last-message", "--x")), ..probe("0.162.1", CODEX_HELP) };
        let falta = evaluate("codex", Profile::Explorar, "wt", Detected::Found(&sin_o), false);
        assert_eq!(falta.status, Status::Blocked);
        assert_eq!(falta.reason.as_deref(), Some("Codex 0.162.1 no admite: -o/--output-last-message"));
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
            assert_eq!(flag_list(&p.argv, "--allowedTools").unwrap(), LXO_TOOLS);
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
        for (prof, role, via) in [(Profile::Explorar, "revisor", "codex exec -o"), (Profile::Proponer, "adversario", "codex exec -o"),
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
    fn advertencias_de_codex_sin_red() {
        let found = probe("0.162.1", CODEX_HELP);
        for (prof, role, read_only) in [(Profile::Explorar, "revisor", true), (Profile::Proponer, "adversario", true),
            (Profile::DelegarConRevision, "implementador", false)] {
            let p = evaluate_for("codex", prof, Some(role), "wt", Detected::Found(&found), false, Delivery::FileOrMarkers);
            assert!(p.warnings.iter().any(|w| w == WARN_NO_ASK), "{prof:?}");
            assert_eq!(p.warnings.iter().any(|w| w == WARN_COPY_BLOCK), read_only, "{prof:?}");
        }
        // Ni en Claude ni en una consulta sin entrega.
        let c = evaluate_for("claude", Profile::Explorar, Some("revisor"), "wt", Detected::Found(&probe("2.1.296", CLAUDE_HELP)), false, Delivery::FileOrMarkers);
        assert!(!c.warnings.iter().any(|w| w == WARN_NO_ASK || w == WARN_COPY_BLOCK));
        let q = evaluate_for("codex", Profile::Explorar, None, "wt", Detected::Found(&found), false, Delivery::Query);
        assert!(!q.warnings.iter().any(|w| w == WARN_NO_ASK || w == WARN_COPY_BLOCK));
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
    fn sandbox_elevado_bloquea_el_read_only_de_codex() {
        // Config de prueba, no la de la persona.
        let dir = std::env::temp_dir().join(format!("lxo-codex-home-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.toml");
        std::fs::write(&cfg, "model = \"gpt-5.5\"\n\n[windows]\nsandbox = \"elevated\" # prueba\n\n[otra]\nsandbox = \"x\"\n").unwrap();
        let leida = codex_windows_sandbox(&std::fs::read_to_string(&cfg).unwrap());
        assert_eq!(leida.as_deref(), Some("elevated"));
        assert_eq!(codex_windows_sandbox("windows.sandbox = 'unelevated'").as_deref(), Some("unelevated"));
        assert_eq!(codex_windows_sandbox("[sandbox_workspace_write]\nnetwork_access = true"), None);
        let elev = Probe { windows_sandbox: leida, ..probe("0.162.1", CODEX_HELP) };
        for prof in [Profile::Explorar, Profile::Proponer] {
            let p = evaluate_for("codex", prof, Some("revisor"), "wt", Detected::Found(&elev), false, Delivery::FileOrMarkers);
            assert_eq!((p.status, p.reason.as_deref()), (Status::Blocked, Some(ELEVATED)), "{prof:?}");
            assert!(p.warnings.iter().any(|w| w == ELEVATED));
            assert!(authorize(&p, Some(&p.argv), true).is_err());
        }
        // Delegar no se bloquea: avisa y queda unverified (pide ack).
        let d = evaluate("codex", Profile::DelegarConRevision, "wt", Detected::Found(&elev), false);
        assert_eq!((d.status, d.reason.as_deref()), (Status::Unverified, Some(WARN_ELEVATED_RW)));
        assert!(d.warnings.iter().any(|w| w == WARN_ELEVATED_RW) && !d.warnings.iter().any(|w| w == ELEVATED));
        // Autonomía sigue deshabilitada con su motivo, sin el aviso.
        let a = evaluate("codex", Profile::AutonomiaAmplia, "wt", Detected::Found(&elev), false);
        assert_eq!((a.status, a.reason.as_deref()), (Status::Blocked, Some(DEFERRED)));
        assert!(!a.warnings.iter().any(|w| w == WARN_ELEVATED_RW));
        // Sin elevated, Delegar sigue ok y sin aviso.
        let normal_d = Probe { windows_sandbox: Some("unelevated".into()), ..probe("0.162.1", CODEX_HELP) };
        let d = evaluate("codex", Profile::DelegarConRevision, "wt", Detected::Found(&normal_d), false);
        assert_eq!(d.status, Status::Ok);
        assert!(!d.warnings.iter().any(|w| w == WARN_ELEVATED_RW));
        let normal = Probe { windows_sandbox: Some("unelevated".into()), ..probe("0.162.1", CODEX_HELP) };
        assert_eq!(evaluate("codex", Profile::Explorar, "wt", Detected::Found(&normal), false).status, Status::Ok);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn solo_mxc_y_unelevated_demuestran_un_sandbox_no_elevado() {
        // Valores oficiales de `[windows] sandbox`: mxc, elevated, unelevated. Los desconocidos no prueban nada.
        let completa = EnvProof { cli_present: true, flags_supported: true, sandbox_not_elevated: true };
        let sin_sandbox = EnvProof { cli_present: true, flags_supported: true, sandbox_not_elevated: false };
        for (valor, prueba) in [(Some("mxc"), true), (Some("unelevated"), true), (Some("elevated"), false), (None, false)] {
            assert_eq!(sandbox_proves_not_elevated(valor), prueba, "{valor:?}");
        }
        for desconocido in ["", "Elevated", "ELEVATED", "UNELEVATED", "Mxc", "mxc2", "elevated2", "disabled", "none", "read-only", " unelevated", "unelevated "] {
            assert!(!sandbox_proves_not_elevated(Some(desconocido)), "{desconocido:?} no prueba nada");
        }
        for prof in [Profile::Explorar, Profile::Proponer] {
            for (valor, esperada) in [(Some("mxc"), completa), (Some("unelevated"), completa), (None, sin_sandbox)] {
                let found = Probe { windows_sandbox: valor.map(String::from), ..probe("0.162.1", CODEX_HELP) };
                let p = evaluate("codex", prof, "wt", Detected::Found(&found), false);
                assert_eq!((p.status, p.block, p.env_proof), (Status::Ok, None, esperada), "{prof:?} {valor:?}");
            }
            // Un valor desconocido NO bloquea (no es `elevated`) pero tampoco demuestra el sandbox: conserva su bloqueo.
            for desconocido in ["", "Elevated", "ELEVATED", "mxc2", "disabled", "otro"] {
                let found = Probe { windows_sandbox: Some(desconocido.into()), ..probe("0.162.1", CODEX_HELP) };
                let p = evaluate("codex", prof, "wt", Detected::Found(&found), false);
                assert_eq!((p.status, p.block, p.env_proof), (Status::Ok, None, sin_sandbox), "{prof:?} {desconocido:?}");
            }
            // `elevated` sigue siendo el bloqueo y no prueba el sandbox, solo lo que se llegó a examinar.
            let elev = Probe { windows_sandbox: Some("elevated".into()), ..probe("0.162.1", CODEX_HELP) };
            let p = evaluate("codex", prof, "wt", Detected::Found(&elev), false);
            assert_eq!((p.status, p.block, p.env_proof), (Status::Blocked, Some(BlockCause::Environment(EnvBlock::WindowsSandboxElevated)), sin_sandbox), "{prof:?}");
        }
        // Lo que lee la config llega tal cual: `mxc` y `unelevated` prueban; `elevated` y lo ajeno, no.
        for (toml, prueba) in [("[windows]
sandbox = \"mxc\"", true), ("windows.sandbox = 'unelevated'", true), ("[windows]
sandbox = \"elevated\"", false), ("[windows]
sandbox = \"Mxc\"", false), ("[otra]
sandbox = \"mxc\"", false)] {
            assert_eq!(sandbox_proves_not_elevated(codex_windows_sandbox(toml).as_deref()), prueba, "{toml}");
        }
    }

    #[test]
    fn un_bloqueo_solo_lleva_la_evidencia_que_llego_a_demostrar() {
        // Flags que faltan: la CLI está (desmiente `cli_missing`), pero ni los flags ni el sandbox se demuestran.
        let vieja = CODEX_EXEC_HELP_162.replace("--sandbox", "--sbx");
        let found = Probe { exec_help: Some(vieja.clone()), ..probe("0.159.0", CODEX_HELP) };
        let p = evaluate("codex", Profile::Explorar, "wt", Detected::Found(&found), false);
        assert_eq!((p.status, p.block), (Status::Blocked, Some(BlockCause::Environment(EnvBlock::CliFlagsUnsupported))));
        assert_eq!(p.env_proof, EnvProof { cli_present: true, flags_supported: false, sandbox_not_elevated: false });
        // CLI ausente: nada.
        let ausente = evaluate("codex", Profile::Explorar, "wt", Detected::Missing, false);
        assert_eq!(ausente.env_proof, EnvProof::default());
        // Flags que faltan Y sandbox no elevado en la config: el sandbox no se examina antes de bloquear por flags.
        let ambas = Probe { windows_sandbox: Some("unelevated".into()), ..found.clone() };
        assert!(!evaluate("codex", Profile::Explorar, "wt", Detected::Found(&ambas), false).env_proof.sandbox_not_elevated);
    }

    #[test]
    fn claude_stream_json_y_lxo_report_en_la_politica() {
        let found = probe("2.1.296", CLAUDE_HELP);
        for prof in [Profile::Explorar, Profile::Proponer] {
            let p = evaluate_for("claude", prof, Some("explorador"), "wt", Detected::Found(&found), false, Delivery::FileOrMarkers);
            assert_eq!(p.status, Status::Ok, "{:?}", p.reason);
            assert!(p.argv.windows(2).any(|w| w == ["--output-format", "stream-json"]));
            assert!(p.argv.iter().any(|a| a == "-p") && p.argv.iter().any(|a| a == "--verbose"));
            assert!(!p.interactive);
            assert!(p.warnings.iter().any(|w| w == WARN_STREAM));
            // La comprobación de argv sigue valiendo.
            assert!(authorize(&p, Some(&p.argv), false).is_ok());
            let mut sin_stream = p.argv.clone();
            sin_stream.retain(|a| a != "--verbose");
            assert!(authorize(&p, Some(&sin_stream), false).is_err());
        }
        let d = evaluate_for("claude", Profile::DelegarConRevision, Some("implementador"), "wt", Detected::Found(&found), false, Delivery::FileOrMarkers);
        assert_eq!(d.status, Status::Ok);
        assert!(d.interactive);
        assert_eq!(flag_list(&d.argv, "--allowedTools").unwrap(), LXO_TOOLS);
        // Un --help sin stream-json bloquea Explorar.
        let sin = CLAUDE_HELP.replace("stream-json", "jsonl");
        let p = evaluate("claude", Profile::Explorar, "wt", Detected::Found(&probe("2.1.296", &sin)), false);
        assert_eq!(p.reason.as_deref(), Some("Claude Code 2.1.296 no admite: --output-format stream-json"));
    }

    #[test]
    fn codex_interactivo_avisa_del_limite_de_50_kb() {
        let found = probe("0.162.1", CODEX_HELP);
        let d = evaluate_for("codex", Profile::DelegarConRevision, Some("implementador"), "wt", Detected::Found(&found), false, Delivery::FileOrMarkers);
        assert!(d.interactive && d.warnings.iter().any(|w| w == WARN_STDOUT_LIMIT));
        let r = evaluate_for("codex", Profile::Explorar, Some("revisor"), "wt", Detected::Found(&found), false, Delivery::FileOrMarkers);
        assert!(!r.interactive && r.warnings.iter().any(|w| w == WARN_EXEC) && r.warnings.iter().any(|w| w == WARN_EXEC_O));
        // Aviso de tamaño solo en el read-only de Codex.
        for prof in [Profile::Explorar, Profile::Proponer] {
            let p = evaluate_for("codex", prof, Some("revisor"), "wt", Detected::Found(&found), false, Delivery::FileOrMarkers);
            assert!(p.warnings.iter().any(|w| w == WARN_CODEX_BIG), "{prof:?}");
        }
        assert!(!d.warnings.iter().any(|w| w == WARN_CODEX_BIG));
        let c = evaluate("claude", Profile::Explorar, "wt", Detected::Skip, false);
        assert!(!c.warnings.iter().any(|w| w == WARN_CODEX_BIG));
    }

    #[test]
    fn claude_lista_explicita_de_lxo_en_todos_los_perfiles() {
        let found = probe("2.1.296", CLAUDE_HELP);
        for prof in [Profile::Explorar, Profile::Proponer, Profile::DelegarConRevision] {
            let p = evaluate("claude", prof, "wt", Detected::Found(&found), false);
            assert_eq!(p.status, Status::Ok, "{prof:?} {:?}", p.reason);
            assert!(!p.argv.iter().any(|a| a.contains("Bash(lxo *)") || a.contains("Bash(lxo:*)")), "{prof:?}");
            assert_eq!(flag_list(&p.argv, "--allowedTools").unwrap(), LXO_TOOLS, "{prof:?}");
            // Un solo token: no hay valores sueltos de --allowedTools que se coman lo siguiente.
            assert!(!p.argv.iter().any(|a| a == "--allowedTools" || a == "--disallowedTools"), "{prof:?}");
        }
    }

    /// Parte la línea de launch.cmd como lo haría la CLI: comillas dobles agrupan.
    fn split_cmd(line: &str) -> Vec<String> {
        let (mut out, mut cur, mut q) = (vec![], String::new(), false);
        for c in line.chars() {
            match c {
                '"' => q = !q,
                ' ' if !q => { if !cur.is_empty() { out.push(std::mem::take(&mut cur)); } }
                c => cur.push(c),
            }
        }
        if !cur.is_empty() { out.push(cur); }
        out
    }

    #[test]
    fn argv_real_modelo_prompt_y_reglas() {
        // --disallowedTools y --allowedTools aceptan varios valores: van en un solo
        // token y el prompt va tras `--`. Se comprueba sobre el argv que se lanza.
        let prompt = "Eres la tarea t3 del orquestador de Lixbon. Lee .lixbon/tasks/t3.md, ejecuta lxo guide y haz la tarea.";
        for prof in [Profile::Explorar, Profile::Proponer, Profile::DelegarConRevision] {
            for model in [Some("haiku"), None] {
                let l = launch_with(&evaluate("claude", prof, "wt", Detected::Skip, false), model, None, prompt).unwrap();
                let argv = split_cmd(&l.command);
                // 1. --model llega con su valor.
                let m = argv.iter().position(|a| a == "--model");
                assert_eq!(m.map(|i| argv[i + 1].as_str()), model, "{}", l.command);
                // 2. El prompt llega intacto, último y tras `--`.
                assert_eq!(argv.last().unwrap(), prompt);
                assert_eq!(argv[argv.len() - 2], "--");
                assert_eq!(argv.iter().filter(|a| *a == "--").count(), 1);
                // 3. Exactamente las cinco reglas (con lxo check), en un solo token.
                assert_eq!(flag_list(&argv, "--allowedTools").unwrap().len(), 5);
                assert!(flag_list(&argv, "--allowedTools").unwrap().contains(&"Bash(lxo check)"));
                assert_eq!(flag_list(&argv, "--allowedTools").unwrap(), LXO_TOOLS);
                assert_eq!(argv.iter().filter(|a| a.starts_with("--allowedTools")).count(), 1);
                if prof != Profile::DelegarConRevision {
                    assert_eq!(flag_list(&argv, "--disallowedTools").unwrap(), READ_ONLY_BLOCKED);
                }
            }
        }
        // Codex no lleva `--`.
        let c = launch_with(&evaluate("codex", Profile::Explorar, "wt", Detected::Skip, false), None, None, "x").unwrap();
        assert!(!split_cmd(&c.command).iter().any(|a| a == "--"));
    }

    #[test]
    fn modelo_pedido_que_no_entra_en_el_argv_no_se_lanza() {
        let mut p = evaluate("claude", Profile::DelegarConRevision, "wt", Detected::Skip, false);
        p.provider = "gemini".into();
        assert!(launch_with(&p, Some("gemini-x"), None, "x").is_err());
        assert!(launch_with(&evaluate("codex", Profile::Explorar, "wt", Detected::Skip, false), Some("gpt-5.5"), None, "x").unwrap().command.contains("--model gpt-5.5"));
    }

    #[test]
    fn familia_del_modelo() {
        assert!(same_model_family("haiku", "claude-haiku-5-5"));
        assert!(same_model_family("haiku", "claude-haiku-5-5-20260901"));
        assert!(same_model_family("claude-haiku-5-5", "claude-haiku-5-5-20260901"));
        assert!(same_model_family("gpt-5.5", "gpt-5.5"));
        assert!(!same_model_family("haiku", "claude-sonnet-5-5"));
        assert!(!same_model_family("opus", "claude-opusplan-5"));
    }

    #[test]
    fn aviso_de_sonnet_en_modo_plan() {
        let found = probe("2.1.296", CLAUDE_HELP);
        let con = |prof, model: Option<&str>| {
            let mut p = evaluate_for("claude", prof, Some("explorador"), "wt", Detected::Found(&found), false, Delivery::FileOrMarkers);
            warn_plan_model(&mut p, model);
            p.warnings.iter().filter(|w| *w == WARN_PLAN_SONNET).count()
        };
        for prof in [Profile::Explorar, Profile::Proponer] {
            assert_eq!(con(prof, Some("haiku")), 1, "{prof:?}");
            assert_eq!(con(prof, Some("opus")), 1, "{prof:?}");
            assert_eq!(con(prof, Some("claude-opus-5")), 1, "{prof:?}");
            assert_eq!(con(prof, Some("sonnet")), 0, "{prof:?}");
            assert_eq!(con(prof, Some("claude-sonnet-5-5")), 0, "{prof:?}");
            assert_eq!(con(prof, None), 0, "{prof:?}");
        }
        // Sin plan (Delegar) o en Codex no se avisa.
        assert_eq!(con(Profile::DelegarConRevision, Some("haiku")), 0);
        let mut c = evaluate("codex", Profile::Explorar, "wt", Detected::Skip, false);
        warn_plan_model(&mut c, Some("haiku"));
        assert!(!c.warnings.iter().any(|w| w == WARN_PLAN_SONNET));
        // Llamarlo dos veces no duplica el aviso.
        let mut p = evaluate("claude", Profile::Explorar, "wt", Detected::Skip, false);
        warn_plan_model(&mut p, Some("haiku"));
        warn_plan_model(&mut p, Some("haiku"));
        assert_eq!(p.warnings.iter().filter(|w| *w == WARN_PLAN_SONNET).count(), 1);
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

    /// LXO-88: la causa de un bloqueo es un TIPO que fija cada punto de `evaluate`; nadie lee `reason`.
    #[test]
    fn cada_bloqueo_lleva_su_causa_tipada() {
        use BlockCause::{Environment, Invalid, ProfileDisabled, WorktreePath};
        let causa = |p: Policy| (p.status, p.block);
        let b = Status::Blocked;
        // Pedido inválido: proveedor desconocido, combinación sin definición, rol desconocido, perfil desconocido.
        assert_eq!(causa(evaluate("inventado", Profile::Explorar, "wt", Detected::Skip, false)), (b, Some(Invalid)));
        assert_eq!(causa(evaluate("gemini", Profile::Explorar, "wt", Detected::Skip, false)), (b, Some(Invalid)));
        assert_eq!(causa(evaluate_for("claude", Profile::Explorar, Some("inventado"), "wt", Detected::Skip, false, Delivery::FileOrMarkers)), (b, Some(Invalid)));
        assert_eq!(causa(resolve_task_policy("claude", "inventado", None, "wt", Delivery::Query)), (b, Some(Invalid)));
        // Decisión de policy y ruta de ESTA solicitud: no son condiciones del proveedor.
        assert_eq!(causa(evaluate("claude", Profile::AutonomiaAmplia, "wt", Detected::Skip, false)), (b, Some(ProfileDisabled)));
        assert_eq!(causa(evaluate("claude", Profile::Explorar, "w&t", Detected::Skip, false)), (b, Some(WorktreePath)));
        // Entorno / proveedor.
        assert_eq!(causa(evaluate("claude", Profile::Explorar, "wt", Detected::Missing, false)), (b, Some(Environment(EnvBlock::CliMissing))));
        let sin_o = Probe { exec_help: Some(CODEX_EXEC_HELP_162.replace("--output-last-message", "--x")), ..probe("0.162.1", CODEX_HELP) };
        assert_eq!(causa(evaluate("codex", Profile::Explorar, "wt", Detected::Found(&sin_o), false)), (b, Some(Environment(EnvBlock::CliFlagsUnsupported))));
        let elevado = Probe { windows_sandbox: Some("elevated".into()), ..probe("0.162.1", CODEX_HELP) };
        assert_eq!(causa(evaluate("codex", Profile::Explorar, "wt", Detected::Found(&elevado), false)), (b, Some(Environment(EnvBlock::WindowsSandboxElevated))));
        // Lo que no está bloqueado no lleva causa.
        assert_eq!(evaluate("claude", Profile::Explorar, "wt", Detected::Skip, false).block, None);
        // Solo estas tres causas son del entorno, y sus códigos son un conjunto cerrado y estable.
        assert_eq!(EnvBlock::ALL.map(EnvBlock::code), ["cli_missing", "cli_flags_unsupported", "windows_sandbox_elevated"]);
        assert!(EnvBlock::ALL.into_iter().all(|c| EnvBlock::parse(c.code()) == Some(c)));
        assert_eq!(EnvBlock::parse("worktree_path_unusable"), None);
    }

    /// LXO-88: `EnvProof::any` solo es cierto si ALGUNA prueba demuestra algo (guarda de `observe_environment`).
    #[test]
    fn env_proof_any_solo_es_cierto_con_alguna_prueba() {
        assert!(!EnvProof::default().any(), "sin ninguna prueba no demuestra nada");
        for (proof, causa) in [
            (EnvProof { cli_present: true, ..EnvProof::default() }, EnvBlock::CliMissing),
            (EnvProof { flags_supported: true, ..EnvProof::default() }, EnvBlock::CliFlagsUnsupported),
            (EnvProof { sandbox_not_elevated: true, ..EnvProof::default() }, EnvBlock::WindowsSandboxElevated),
        ] {
            assert!(proof.any(), "{causa:?}");
            assert!(proof.demonstrates(causa), "{causa:?}");
            for otra in EnvBlock::ALL.into_iter().filter(|o| *o != causa) {
                assert!(!proof.demonstrates(otra), "{proof:?} solo demuestra {causa:?}, no {otra:?}");
            }
        }
    }
}
