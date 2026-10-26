//! Continuidad de un Attempt (LXO-134, épica F4): reanudar la ProviderSession del proveedor cuando es seguro y, si no, arrancar
//! un Attempt nuevo con un ContextPackage. Contrato y decisiones: `docs/core/CONTINUIDAD.md`.
//!
//! ```text
//! continue_attempt(st, registry, ctx, req)
//!   1. autorizar y validar la petición                      <- antes de tocar nada
//!   2. ¿ya se atendió este request_id?  -> el Attempt que existe, sin escribir ni lanzar nada
//!   3. leer el Attempt anterior y su sesión; parse del paquete (si llegó)   <- un paquete inválido no inicia nada
//!   4. decide(): nativo o paquete, y POR QUÉ                 <- función pura, sin E/S
//!   5. Store::attempt_continue_recorded                      <- Attempt + procedencia + sesión + 2-3 eventos, UNA transacción
//!   6. adapter.resume / adapter.start  ->  attempt.started
//!        si falla: se cierra el Attempt nuevo (el anterior no se toca) y la sesión se deja en espera o se cierra
//! ```
//!
//! # Política (D43 de `docs/core/CONTEXT_PACKAGE.md`)
//! Resume nativo solo si el proveedor es el mismo, ofrece `resume`, la sesión existe, es resumible, está en espera, tiene su
//! referencia y no caducó. En cualquier otro caso hace falta un ContextPackage. **Nunca se finge portabilidad de una
//! ProviderSession entre proveedores.**
//!
//! # Lo que NO hace
//! * No cae a un paquete por su cuenta: con [`Intent::Native`] un resume imposible es un error; con [`Intent::Auto`] solo
//!   cae si quien llama APORTÓ el paquete, y la estrategia y el motivo quedan en `attempt.continued` y en el resultado.
//! * No construye paquetes (necesita la evidencia de git: `lxo context`, LXO-138) ni lee el flujo de eventos del proveedor
//!   (el runtime, F5); si ese flujo termina con `session_not_found`, [`settle_failure`] cierra la sesión.
//! * No salta un entorno bloqueado: si el proveedor está `environment_blocked`, es un error y NO se prueba otra estrategia.
//!
//! **Inerte hasta el corte**, como `attempt_ops`: sin conexión al RPC; el almacén rechaza escribir antes de `meta.agentic_model`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: lo conectará el comando de reintento (F5, LXO-142)

use std::path::Path;

use serde::Serialize;

use super::adapter::{AdapterError, AdapterRegistry, CancelToken, Capability, CapabilityState, ErrorCode, FailureKind, ProviderRef, ResumeRequest, RunHandle, StartRequest};
use super::attempt_ops;
use super::context_package::{self, ContextPackage};
use super::events::{Actor, MutationContext};
use super::session_ops;
use super::state::now_ms;
use crate::store::{
    AttemptRow, ContinuationReason as Reason, ContinuationRow, Continued, ContinuityStrategy as Strategy, NewAttempt, NewContinuation, ProviderSessionRow, SessionStatus, Store,
    StoreError, MAX_REQUEST_ID_CHARS,
};

// ── Petición ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Qué pide quien llama. La estrategia nunca la decide un cliente por su cuenta: la política la valida.
#[derive(Clone, Copy, Debug)]
pub enum Intent<'a> {
    /// Solo resume nativo. Si no se puede, error (nunca cae a un paquete).
    Native,
    /// Attempt limpio con este ContextPackage (JSON): otro proveedor, otro host o un Attempt sin arrastrar la sesión.
    Package(&'a str),
    /// Nativo si la política lo admite. Si no, el paquete aportado; sin paquete, error con `fallback_available`.
    Auto { package: Option<&'a str> },
}

#[derive(Clone, Debug)]
pub struct ContinueRequest<'a> {
    /// Clave de idempotencia (1 a 64 caracteres entre letras, dígitos, `_`, `.` y `-`), de la Task.
    pub request_id: &'a str,
    pub task_id: &'a str,
    /// El Attempt al que se continúa: tiene que ser de la Task y haber terminado.
    pub from_attempt_id: &'a str,
    /// El proveedor del Attempt nuevo. Distinto del anterior ⇒ solo con paquete.
    pub provider: &'a str,
    pub intent: Intent<'a>,
    /// El mensaje con que continúa. Con un paquete, va detrás del contexto.
    pub prompt: &'a str,
    pub worktree: &'a Path,
    /// `None`: hereda el del Attempt anterior (los permisos no se amplían ni se pierden al continuar).
    pub profile: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
}

/// Parámetros de la política. Por defecto, ninguno: no se inventa un plazo de caducidad que ningún proveedor ha confirmado.
#[derive(Clone, Copy, Debug, Default)]
pub struct Settings {
    /// Edad máxima de una sesión en espera para reanudarla, contada desde su última actividad. `None` = sin plazo propio.
    pub session_max_age_ms: Option<i64>,
}

/// Lo que devuelve un `continue_attempt` que salió bien.
#[derive(Clone, Debug)]
pub struct Outcome {
    pub attempt: AttemptRow,
    pub continuation: ContinuationRow,
    /// La ejecución viva, para que el runtime lea sus eventos. `None` en una repetición: no se vuelve a lanzar nada.
    pub run: Option<RunHandle>,
    /// `true`: esta petición ya se había atendido y es el Attempt que existe (con el estado que tenga).
    pub replayed: bool,
}

// ── Errores ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Conjunto CERRADO: un cliente decide por la categoría, no por el texto.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// No hay con qué continuar así: el proveedor no ofrece `resume`, no hay sesión resumible…
    Unsupported,
    /// La sesión caducó (cerrada, fuera de plazo o el proveedor ya no la tiene).
    Expired,
    /// La petición no es válida: paquete inválido, sesión de otra Task o proveedor, petición repetida con otros datos…
    Invalid,
    /// El entorno impide usar el proveedor. No es un fallo del Attempt y no se esquiva con otra estrategia.
    EnvironmentBlocked,
    /// El proveedor o el adapter fallaron al lanzar. El Attempt nuevo quedó `failed`.
    Failed,
}

impl ErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            ErrorKind::Unsupported => "unsupported",
            ErrorKind::Expired => "expired",
            ErrorKind::Invalid => "invalid",
            ErrorKind::EnvironmentBlocked => "environment_blocked",
            ErrorKind::Failed => "failed",
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ContinuityError {
    pub kind: ErrorKind,
    /// Código estable dentro de la categoría (`session_expired`, `provider_mismatch`, `package_invalid`…).
    pub code: &'static str,
    pub message: String,
    /// Un ContextPackage resolvería este error: el cliente puede OFRECERLO. Nunca se aplica solo.
    pub fallback_available: bool,
    /// El Attempt nuevo que este fallo dejó cerrado, si llegó a crearse. El anterior nunca cambia.
    pub attempt_id: Option<String>,
}

impl ContinuityError {
    fn new(kind: ErrorKind, code: &'static str, message: impl Into<String>) -> ContinuityError {
        ContinuityError { kind, code, message: message.into(), fallback_available: false, attempt_id: None }
    }

    fn invalid(code: &'static str, message: impl Into<String>) -> ContinuityError {
        ContinuityError::new(ErrorKind::Invalid, code, message)
    }

    fn with_fallback(mut self) -> ContinuityError {
        self.fallback_available = true;
        self
    }

    fn for_attempt(mut self, id: &str) -> ContinuityError {
        self.attempt_id = Some(id.to_string());
        self
    }
}

impl std::fmt::Display for ContinuityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}: {}", self.kind.code(), self.code, self.message)
    }
}

impl std::error::Error for ContinuityError {}

fn from_store(e: StoreError) -> ContinuityError {
    match e {
        StoreError::AttemptConflict(m) | StoreError::SessionConflict(m) => ContinuityError::invalid("conflict", m),
        StoreError::InvalidAttempt(m) | StoreError::InvalidSession(m) => ContinuityError::invalid("invalid_request", m),
        StoreError::AgenticModelInactive => ContinuityError::invalid("model_inactive", "el modelo Task/Attempt todavía no está activo"),
        // El resto (E/S, SQLite…) no se cuenta al cliente: puede llevar rutas o detalles internos.
        _ => ContinuityError::invalid("store", "no se pudo leer o escribir el estado de la Task"),
    }
}

fn from_adapter(e: &AdapterError) -> ContinuityError {
    match e.code {
        ErrorCode::SessionNotFound => ContinuityError::new(ErrorKind::Expired, "session_expired", "el proveedor ya no tiene la sesión").with_fallback(),
        ErrorCode::EnvironmentBlocked => ContinuityError::new(ErrorKind::EnvironmentBlocked, "environment_blocked", e.message.clone()),
        ErrorCode::UnsupportedCapability | ErrorCode::CapabilityUnavailable => ContinuityError::new(ErrorKind::Unsupported, "capability_unavailable", e.message.clone()).with_fallback(),
        ErrorCode::Cancelled => ContinuityError::invalid("cancelled", e.message.clone()),
        ErrorCode::Provider | ErrorCode::Internal => ContinuityError::new(ErrorKind::Failed, "launch_failed", e.message.clone()),
        ErrorCode::UnknownCapability | ErrorCode::InvalidRequest | ErrorCode::UnknownProvider | ErrorCode::UnknownRun => ContinuityError::invalid("invalid_request", e.message.clone()),
    }
}

// ── Política (pura) ──────────────────────────────────────────────────────────────────────────────────────────────────

/// Qué hay de la sesión del Attempt anterior, ya comprobado su dueño.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum SessionFacts {
    /// Se puede reanudar.
    Usable,
    /// No hay una sesión que reanudar (no la hubo, no es resumible, sin referencia…). El texto dice cuál.
    Unavailable(&'static str),
    /// Caducó. El texto dice por qué.
    Expired(&'static str),
}

/// Por qué no se puede reanudar de forma nativa.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Blocker {
    pub(super) reason: Reason,
    kind: ErrorKind,
    code: &'static str,
    message: String,
}

impl Blocker {
    fn error(&self) -> ContinuityError {
        // Un paquete resuelve todo salvo una petición que no era válida en sí.
        ContinuityError::new(self.kind, self.code, self.message.clone()).with_fallback()
    }
}

/// ¿Por qué NO se puede reanudar de forma nativa? `None` = se puede. Es la única definición de la política.
pub(super) fn native_blocker(same_provider: bool, resume: &CapabilityState, session: &SessionFacts) -> Option<Blocker> {
    if !same_provider {
        return Some(Blocker {
            reason: Reason::ProviderChanged,
            kind: ErrorKind::Invalid,
            code: "provider_mismatch",
            message: "una ProviderSession no se comparte entre proveedores: hace falta un ContextPackage".into(),
        });
    }
    match resume {
        CapabilityState::Available => {}
        CapabilityState::Unsupported => {
            return Some(Blocker { reason: Reason::ResumeUnsupported, kind: ErrorKind::Unsupported, code: "resume_unsupported", message: "el proveedor no ofrece `resume`".into() });
        }
        CapabilityState::Unavailable { reason } => {
            return Some(Blocker { reason: Reason::ResumeUnsupported, kind: ErrorKind::Unsupported, code: "resume_unavailable", message: format!("`resume` no está disponible ahora: {reason}") });
        }
        // El entorno bloqueado lo trata `continue_attempt` antes: no se esquiva con otra estrategia.
        CapabilityState::EnvironmentBlocked { .. } => {}
    }
    match session {
        SessionFacts::Usable => None,
        SessionFacts::Unavailable(why) => Some(Blocker { reason: Reason::SessionUnavailable, kind: ErrorKind::Unsupported, code: "session_unavailable", message: (*why).into() }),
        SessionFacts::Expired(why) => Some(Blocker { reason: Reason::SessionExpired, kind: ErrorKind::Expired, code: "session_expired", message: (*why).into() }),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Choice {
    pub(super) strategy: Strategy,
    pub(super) reason: Reason,
}

/// La estrategia y su motivo, o el error. `has_package`: llegó un paquete (ya validado).
pub(super) fn decide(intent: &Intent<'_>, blocker: Option<Blocker>, has_package: bool) -> Result<Choice, ContinuityError> {
    let native = Choice { strategy: Strategy::NativeResume, reason: Reason::Preferred };
    match (intent, blocker) {
        (Intent::Native, None) => Ok(native),
        (Intent::Native, Some(b)) => Err(b.error()),
        (Intent::Package(_), None) => Ok(Choice { strategy: Strategy::ContextPackage, reason: Reason::Requested }),
        (Intent::Package(_), Some(b)) => Ok(Choice {
            strategy: Strategy::ContextPackage,
            reason: if b.reason == Reason::ProviderChanged { Reason::ProviderChanged } else { Reason::Requested },
        }),
        (Intent::Auto { .. }, None) => Ok(native),
        (Intent::Auto { .. }, Some(b)) if has_package => Ok(Choice { strategy: Strategy::ContextPackage, reason: b.reason }),
        (Intent::Auto { .. }, Some(b)) => Err(b.error()),
    }
}

// ── Comando ──────────────────────────────────────────────────────────────────────────────────────────────────────────

fn check_text(what: &str, v: &str, max: usize) -> Result<(), ContinuityError> {
    if v.trim().is_empty() || v.chars().count() > max || v.chars().any(char::is_control) {
        return Err(ContinuityError::invalid("invalid_request", format!("{what}: texto no vacío, sin caracteres de control y de hasta {max} caracteres")));
    }
    Ok(())
}

fn parse_package(json: &str) -> Result<ContextPackage, ContinuityError> {
    context_package::parse(json).map_err(|e| ContinuityError::invalid("package_invalid", format!("ContextPackage rechazado ({}): {}", e.code.code(), e.message)))
}

/// La sesión del Attempt anterior vista por la política. `Err` si no es de esta Task y este proveedor (invariante 2).
fn session_facts(st: &Store, from: &AttemptRow, settings: &Settings, now: i64) -> Result<(SessionFacts, Option<ProviderSessionRow>), ContinuityError> {
    let Some(id) = from.provider_session_id.as_deref() else {
        return Ok((SessionFacts::Unavailable("el Attempt anterior no tuvo una sesión del proveedor"), None));
    };
    let Some(s) = st.provider_session_row(id).map_err(from_store)? else {
        return Err(ContinuityError::invalid("session_not_owned", "la sesión del Attempt anterior no existe"));
    };
    if s.task_id != from.task_id || s.provider != from.provider {
        return Err(ContinuityError::invalid("session_not_owned", "la sesión no es de la Task y el proveedor del Attempt anterior"));
    }
    let facts = match s.status {
        SessionStatus::Closed => SessionFacts::Expired("la sesión está cerrada"),
        SessionStatus::Open => SessionFacts::Unavailable("la sesión sigue marcada como abierta: nadie la dejó en espera"),
        SessionStatus::Idle if !s.resumable => SessionFacts::Unavailable("la sesión no es resumible"),
        SessionStatus::Idle if s.external_ref.is_none() => SessionFacts::Unavailable("el proveedor no entregó la referencia de la sesión"),
        SessionStatus::Idle if settings.session_max_age_ms.is_some_and(|max| now.saturating_sub(s.updated_at) > max) => SessionFacts::Expired("la sesión pasó el plazo para reanudarla"),
        SessionStatus::Idle => SessionFacts::Usable,
    };
    Ok((facts, Some(s)))
}

/// ¿La repetición de una petición ya atendida es la MISMA petición? Distinta ⇒ `request_conflict`, nunca se atiende otra cosa
/// con una clave vieja.
fn same_request(st: &Store, existing: &ContinuationRow, req: &ContinueRequest<'_>, package: Option<&ContextPackage>) -> Result<(), ContinuityError> {
    let attempt = st.attempt_row(&existing.attempt_id).map_err(from_store)?;
    let provider_ok = attempt.as_ref().is_some_and(|a| a.provider == req.provider);
    let intent_ok = match req.intent {
        Intent::Native => existing.strategy == Strategy::NativeResume,
        Intent::Package(_) => existing.strategy == Strategy::ContextPackage && package.is_some_and(|p| existing.package_id.as_deref() == Some(p.id())),
        Intent::Auto { .. } => true,
    };
    if existing.from_attempt_id == req.from_attempt_id && provider_ok && intent_ok {
        Ok(())
    } else {
        Err(ContinuityError::invalid("request_conflict", "ese request_id ya se usó para otra continuidad").for_attempt(&existing.attempt_id))
    }
}

/// Continúa el trabajo de `req.from_attempt_id`. Ver el diagrama del módulo.
pub(super) fn continue_attempt(
    st: &mut Store,
    registry: &AdapterRegistry,
    ctx: &MutationContext,
    cancel: &CancelToken,
    settings: &Settings,
    req: &ContinueRequest<'_>,
) -> Result<Outcome, ContinuityError> {
    continue_attempt_at(st, registry, ctx, cancel, settings, req, now_ms() as i64)
}

pub(super) fn continue_attempt_at(
    st: &mut Store,
    registry: &AdapterRegistry,
    ctx: &MutationContext,
    cancel: &CancelToken,
    settings: &Settings,
    req: &ContinueRequest<'_>,
    now: i64,
) -> Result<Outcome, ContinuityError> {
    // 1. Autorizar y validar, antes de leer nada más.
    let allowed = ctx.actor == Actor::System || attempt_ops::person_or_manager(st, ctx, req.task_id).map_err(from_store)?;
    if !allowed {
        return Err(ContinuityError::invalid("not_allowed", format!("no lo puede hacer {:?} por {:?}", ctx.actor, ctx.channel)));
    }
    check_text("request_id", req.request_id, MAX_REQUEST_ID_CHARS)?;
    if !req.request_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
        return Err(ContinuityError::invalid("invalid_request", "request_id: solo letras, dígitos, `_`, `.` y `-`"));
    }
    check_text("el mensaje", req.prompt, 200_000)?;

    // 2. El paquete se valida SIEMPRE que llega, se vaya a usar o no: un paquete inválido no inicia ningún Attempt.
    let package_json = match req.intent {
        Intent::Native => None,
        Intent::Package(j) => Some(j),
        Intent::Auto { package } => package,
    };
    let package = package_json.map(parse_package).transpose()?;
    if matches!(req.intent, Intent::Package(_)) && package.is_none() {
        return Err(ContinuityError::invalid("package_missing", "falta el ContextPackage"));
    }

    // 3. ¿Ya se atendió? Es la misma petición, o una clave reutilizada para otra cosa.
    if let Some(existing) = st.continuation_by_request(req.task_id, req.request_id).map_err(from_store)? {
        same_request(st, &existing, req, package.as_ref())?;
        let attempt = st.attempt_row(&existing.attempt_id).map_err(from_store)?.ok_or_else(|| ContinuityError::invalid("store", "el Attempt de la continuidad no existe"))?;
        return Ok(Outcome { attempt, continuation: existing, run: None, replayed: true });
    }

    // 4. El Attempt anterior y su sesión.
    let from = st.attempt_row(req.from_attempt_id).map_err(from_store)?.ok_or_else(|| ContinuityError::invalid("source_missing", "no existe el Attempt al que se quiere continuar"))?;
    if from.task_id != req.task_id {
        return Err(ContinuityError::invalid("source_not_in_task", "el Attempt anterior no es de esta Task"));
    }
    if !from.status.is_final() {
        return Err(ContinuityError::invalid("source_not_final", "el Attempt anterior sigue activo: no se continúa a la vez que corre"));
    }
    if let Some(p) = &package {
        let s = p.source();
        if s.task_id != req.task_id || s.attempt_id != req.from_attempt_id {
            return Err(ContinuityError::invalid("package_source_mismatch", "el ContextPackage no sale del Attempt al que se continúa"));
        }
    }
    let (session_facts, session) = session_facts(st, &from, settings, now)?;
    let gated = registry.gated(req.provider).map_err(|e| from_adapter(&e))?;
    let (resume_state, start_state) = (gated.matrix().state(Capability::Resume), gated.matrix().state(Capability::Start));
    let same_provider = from.provider == req.provider;

    // 5. El entorno bloqueado se informa tal cual, sin probar otra estrategia que lo esquive.
    let native_possible = same_provider && !matches!(req.intent, Intent::Package(_));
    if let (true, CapabilityState::EnvironmentBlocked { block }) = (native_possible, resume_state) {
        return Err(ContinuityError::new(ErrorKind::EnvironmentBlocked, "environment_blocked", format!("el entorno impide reanudar con {}: {}", req.provider, block.code())));
    }

    // 6. La política.
    let choice = decide(&req.intent, native_blocker(same_provider, resume_state, &session_facts), package.is_some())?;
    if choice.strategy == Strategy::ContextPackage {
        match start_state {
            CapabilityState::Available => {}
            CapabilityState::EnvironmentBlocked { block } => {
                return Err(ContinuityError::new(ErrorKind::EnvironmentBlocked, "environment_blocked", format!("el entorno impide lanzar con {}: {}", req.provider, block.code())));
            }
            other => return Err(ContinuityError::new(ErrorKind::Unsupported, "start_unavailable", format!("{} no puede lanzar ahora ({})", req.provider, other.code()))),
        }
    }

    // 7. El Attempt nuevo hereda los permisos del anterior y, en el mismo proveedor, su modelo.
    let profile = req.profile.map(str::to_string).or_else(|| from.profile.clone()).ok_or_else(|| ContinuityError::invalid("profile_missing", "ni la petición ni el Attempt anterior tienen un perfil de permisos"))?;
    let new_attempt = NewAttempt {
        provider: req.provider.to_string(),
        model: req.model.map(str::to_string).or_else(|| if same_provider { from.model.clone() } else { None }),
        effort: req.effort.map(str::to_string).or_else(|| if same_provider { from.effort.clone() } else { None }),
        role: from.role.clone(),
        profile: Some(profile.clone()),
        external: false,
        requires_approval: false,
    };
    let new = NewContinuation {
        request_id: req.request_id.to_string(),
        from_attempt_id: from.id.clone(),
        strategy: choice.strategy,
        reason: choice.reason,
        provider_session_id: if choice.strategy == Strategy::NativeResume { session.as_ref().map(|s| s.id.clone()) } else { None },
        package_id: if choice.strategy == Strategy::ContextPackage { package.as_ref().map(|p| p.id().to_string()) } else { None },
    };

    // 8. Todo o nada: el Attempt, su procedencia, la sesión reanudada y los eventos.
    let core = MutationContext::core();
    let at = now;
    let done = st
        .attempt_continue_recorded(
            req.task_id,
            &new_attempt,
            &new,
            at,
            |a, t| attempt_ops::requested_fact(a, t, ctx, at),
            |a, c, t| attempt_ops::continued_fact(a, c, t, ctx, at),
            |s, a, t| session_ops::resumed_fact(s, a, t, &core, at),
        )
        .map_err(from_store)?;
    let (attempt, continuation) = match done {
        Continued::Created { attempt, continuation } => (attempt, continuation),
        // Otro hilo la atendió entre la comprobación y la transacción: es la misma petición.
        Continued::Replayed { attempt, continuation } => return Ok(Outcome { attempt, continuation, run: None, replayed: true }),
    };

    // 9. Lanzar. Si falla, el Attempt nuevo se cierra y la sesión queda como corresponde; el anterior no se toca.
    let launched = match choice.strategy {
        Strategy::NativeResume => {
            let external = session.as_ref().and_then(|s| s.external_ref.as_deref()).unwrap_or_default();
            ProviderRef::new(external).and_then(|provider_ref| {
                gated.resume(
                    ResumeRequest {
                        attempt_id: attempt.id.clone(),
                        provider_ref,
                        worktree: req.worktree.to_path_buf(),
                        prompt: Some(req.prompt.to_string()),
                        profile: profile.clone(),
                        model: attempt.model.clone(),
                        effort: attempt.effort.clone(),
                    },
                    cancel,
                )
            })
        }
        Strategy::ContextPackage => {
            let prompt = match &package {
                Some(p) => format!("{}\nINSTRUCCIÓN:\n{}\n", p.continuation_prompt(), req.prompt),
                None => req.prompt.to_string(),
            };
            gated.start(
                StartRequest { attempt_id: attempt.id.clone(), worktree: req.worktree.to_path_buf(), prompt, profile: profile.clone(), model: attempt.model.clone(), effort: attempt.effort.clone() },
                cancel,
            )
        }
    };
    match launched {
        Ok(run) => {
            attempt_ops::start(st, &core, &attempt.id).map_err(|e| from_store(e).for_attempt(&attempt.id))?;
            let attempt = st.attempt_row(&attempt.id).map_err(from_store)?.unwrap_or(attempt);
            Ok(Outcome { attempt, continuation, run: Some(run), replayed: false })
        }
        Err(e) => {
            settle_failure(st, &attempt.id, &e);
            Err(from_adapter(&e).for_attempt(&attempt.id))
        }
    }
}

/// Cierra lo que dejó un lanzamiento (o una reanudación) fallido del Attempt `attempt_id`:
///
/// * el Attempt: `failed(launch_failed)` si fue el proveedor; `stopped` si nada llegó a ejecutarse (capability ausente,
///   entorno bloqueado, cancelación). El entorno bloqueado NUNCA es un Attempt fallido;
/// * su sesión, si reanudó una: `closed` si el proveedor ya no la tiene (`session_not_found`), `idle` en cualquier otro caso
///   para poder reintentar.
///
/// También sirve al runtime cuando el flujo de eventos de una reanudación termina con `session_not_found`. No toca ningún
/// otro Attempt de la Task. Idempotente: un Attempt ya final no se vuelve a cerrar.
pub(super) fn settle_failure(st: &mut Store, attempt_id: &str, err: &AdapterError) {
    let core = MutationContext::core();
    let Ok(Some(attempt)) = st.attempt_row(attempt_id) else { return };
    if !attempt.status.is_final() {
        let _ = match err.kind() {
            FailureKind::AttemptFailure => attempt_ops::fail_launch(st, &core, attempt_id),
            FailureKind::Rejected | FailureKind::EnvironmentBlocked | FailureKind::Cancelled => attempt_ops::stop_unlaunched(st, &core, attempt_id),
        };
    }
    if let Some(ps) = attempt.provider_session_id.as_deref() {
        let _ = if err.code == ErrorCode::SessionNotFound { session_ops::close(st, &core, ps) } else { session_ops::detach(st, &core, ps) };
    }
}
