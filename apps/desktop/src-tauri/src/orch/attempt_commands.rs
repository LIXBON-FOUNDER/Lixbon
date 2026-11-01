//! Comandos de reintento y reanudación de un Attempt (LXO-142, épica F5). Contrato y decisiones: `docs/core/REINTENTO.md`.
//!
//! ```text
//! attempt.retry(st, registry, ctx, cmd)                       attempt.resume(st, registry, ctx, cmd)
//!   1. autorizar y validar la petición                          1. autorizar y validar la petición
//!   2. ¿ya se atendió request_id?  -> el Attempt que existe     2. (continue_attempt) ¿ya se atendió? -> el que existe
//!   3. el origen: de la Task, el ÚLTIMO, terminó mal;           3. el origen: de la Task y terminado; ninguno activo
//!      ningún Attempt activo                                    4. nativo si la política lo admite; si no, error con
//!   4. la capability `start` y el entorno                          `fallback_available`, o el paquete CONFIRMADO
//!   5. Store::attempt_retry_recorded  (Attempt n+1 +            5. Store::attempt_continue_recorded
//!      procedencia + 2 eventos, UNA transacción)                6. adapter.resume / adapter.start  ->  attempt.started
//!   6. adapter.start  ->  attempt.started
//!      si falla: se cierra el Attempt nuevo (el anterior no se toca)
//! ```
//!
//! # Lo que NO hace
//! * **No reabre un Attempt.** Un final es final (`ATTEMPTS.md`): retry y resume crean el `n + 1`; resume reutiliza la
//!   ProviderSession (la misma, no una nueva), retry arranca limpio.
//! * **No hay auto-retry ni auto-resume.** Cada Attempt nuevo nace de una petición con su `request_id`.
//! * **No cae a un ContextPackage por su cuenta.** Sin resume posible, `resume` devuelve el error con
//!   `fallback_available`; solo con un [`Fallback`] que el cliente confirmó (con el motivo que vio) crea el Attempt limpio.
//! * **No cuenta un entorno bloqueado como fallo del agente.** Si ya se sabe, no se crea nada; si salta al lanzar, el
//!   Attempt nuevo queda `stopped`, nunca `failed`.
//!
//! **Inerte hasta el corte**, como `attempt_ops`: sin conexión al RPC; el almacén rechaza escribir antes de `meta.agentic_model`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: lo conectará el RPC del Core (F5)

use std::path::Path;

use super::adapter::{AdapterRegistry, CancelToken, Capability, CapabilityState, RunHandle, StartRequest};
use super::attempt_ops;
use super::continuity::{self, authorize, check_request_key, check_text, from_adapter, from_store, settle_failure, ContinuityError, ContinueRequest, ErrorKind, Intent, Outcome, Settings, MAX_PROMPT_CHARS};
use super::events::MutationContext;
use super::state::now_ms;
use crate::store::{retryable, AttemptRow, ContinuationReason as Reason, NewAttempt, NewRetry, Retried, RetryOverride, RetryRow, Store, TaskRow};

/// Los errores de estos comandos son los de la continuidad: la misma categoría cerrada y los mismos códigos estables.
pub type CommandError = ContinuityError;

// ── attempt.retry ────────────────────────────────────────────────────────────────────────────────────────────────────

/// Qué pide `attempt.retry`. Todo lo que es `None` se hereda del Attempt reintentado.
#[derive(Clone, Debug)]
pub struct RetryCommand<'a> {
    /// Clave de idempotencia de la Task (1–64 caracteres entre letras, dígitos, `_`, `.`, `-`).
    pub request_id: &'a str,
    pub task_id: &'a str,
    /// El Attempt a reintentar. `None`: el último de la Task. Si se nombra, tiene que ser el último.
    pub from_attempt_id: Option<&'a str>,
    /// El mensaje con que arranca. `None`: el encargo de la Task (título y especificación).
    pub prompt: Option<&'a str>,
    pub worktree: &'a Path,
    /// Override explícito. Cambiar el proveedor NO arrastra el modelo ni el esfuerzo del anterior.
    pub provider: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub profile: Option<&'a str>,
}

/// Lo que devuelve un `attempt.retry` que salió bien.
#[derive(Clone, Debug)]
pub struct RetryOutcome {
    pub attempt: AttemptRow,
    pub retry: RetryRow,
    /// La ejecución viva, para que el runtime lea sus eventos. `None` en una repetición: no se vuelve a lanzar nada.
    pub run: Option<RunHandle>,
    /// `true`: esta petición ya se había atendido y es el Attempt que existe (con el estado que tenga).
    pub replayed: bool,
}

fn task_intent_prompt(t: &TaskRow) -> String {
    if t.spec.trim().is_empty() {
        t.title.clone()
    } else {
        format!("{}\n\n{}", t.title, t.spec)
    }
}

/// Qué parámetros cambió la petición respecto del Attempt reintentado (pedir lo mismo no es cambiar).
fn overrides_of(from: &AttemptRow, cmd: &RetryCommand<'_>) -> Vec<RetryOverride> {
    let mut out = Vec::new();
    if cmd.provider.is_some_and(|p| p != from.provider) {
        out.push(RetryOverride::Provider);
    }
    if cmd.model.is_some_and(|m| from.model.as_deref() != Some(m)) {
        out.push(RetryOverride::Model);
    }
    if cmd.effort.is_some_and(|e| from.effort.as_deref() != Some(e)) {
        out.push(RetryOverride::Effort);
    }
    if cmd.profile.is_some_and(|p| from.profile.as_deref() != Some(p)) {
        out.push(RetryOverride::Profile);
    }
    out
}

/// ¿La repetición de una petición ya atendida es la MISMA petición? Distinta ⇒ `request_conflict`: una clave vieja nunca
/// atiende otra cosa. Sin `from_attempt_id` el origen era «el último» y ya no lo es (el reintento lo es): no se compara.
fn same_retry(st: &Store, existing: &RetryRow, cmd: &RetryCommand<'_>) -> Result<(), CommandError> {
    let attempt = st.attempt_row(&existing.attempt_id).map_err(from_store)?;
    let from_ok = cmd.from_attempt_id.is_none_or(|f| f == existing.from_attempt_id);
    let provider_ok = cmd.provider.is_none_or(|p| attempt.as_ref().is_some_and(|a| a.provider == p));
    let model_ok = cmd.model.is_none_or(|m| attempt.as_ref().is_some_and(|a| a.model.as_deref() == Some(m)));
    let effort_ok = cmd.effort.is_none_or(|e| attempt.as_ref().is_some_and(|a| a.effort.as_deref() == Some(e)));
    let profile_ok = cmd.profile.is_none_or(|p| attempt.as_ref().is_some_and(|a| a.profile.as_deref() == Some(p)));
    if from_ok && provider_ok && model_ok && effort_ok && profile_ok {
        Ok(())
    } else {
        Err(CommandError::invalid("request_conflict", "ese request_id ya se usó para otro reintento").for_attempt(&existing.attempt_id))
    }
}

/// `attempt.retry`: un Attempt LIMPIO para la Task, a partir de uno que terminó mal. Ver el diagrama del módulo.
pub(super) fn retry(st: &mut Store, registry: &AdapterRegistry, ctx: &MutationContext, cancel: &CancelToken, cmd: &RetryCommand<'_>) -> Result<RetryOutcome, CommandError> {
    retry_at(st, registry, ctx, cancel, cmd, now_ms() as i64)
}

pub(super) fn retry_at(st: &mut Store, registry: &AdapterRegistry, ctx: &MutationContext, cancel: &CancelToken, cmd: &RetryCommand<'_>, now: i64) -> Result<RetryOutcome, CommandError> {
    // 1. Autorizar y validar, antes de leer nada más.
    authorize(st, ctx, cmd.task_id)?;
    check_request_key(cmd.request_id)?;
    if let Some(prompt) = cmd.prompt {
        check_text("el mensaje", prompt, MAX_PROMPT_CHARS)?;
    }
    for (what, v) in [("provider", cmd.provider), ("model", cmd.model), ("effort", cmd.effort), ("profile", cmd.profile)] {
        if let Some(v) = v {
            check_text(what, v, 120)?;
        }
    }

    // 2. ¿Ya se atendió? Es la misma petición, o una clave reutilizada para otra cosa (también si fue una reanudación).
    if let Some(c) = st.continuation_by_request(cmd.task_id, cmd.request_id).map_err(from_store)? {
        return Err(CommandError::invalid("request_conflict", "ese request_id ya se usó para una reanudación").for_attempt(&c.attempt_id));
    }
    if let Some(existing) = st.retry_by_request(cmd.task_id, cmd.request_id).map_err(from_store)? {
        same_retry(st, &existing, cmd)?;
        let attempt = st.attempt_row(&existing.attempt_id).map_err(from_store)?.ok_or_else(|| CommandError::invalid("store", "el Attempt del reintento no existe"))?;
        return Ok(RetryOutcome { attempt, retry: existing, run: None, replayed: true });
    }

    // 3. La Task y el Attempt a reintentar.
    let task = st.task_row(cmd.task_id).map_err(from_store)?.ok_or_else(|| CommandError::invalid("task_missing", "no existe la Task"))?;
    if let Some(active) = st.attempt_active(cmd.task_id).map_err(from_store)? {
        return Err(CommandError::invalid("attempt_active", format!("la Task ya tiene el Attempt activo {}: un reintento no corre a la vez que otro", active.id)));
    }
    let latest = st.attempt_current(cmd.task_id).map_err(from_store)?.ok_or_else(|| CommandError::invalid("no_attempts", "la Task no tiene ningún Attempt que reintentar"))?;
    let from = match cmd.from_attempt_id {
        None => latest.clone(),
        Some(id) => st.attempt_row(id).map_err(from_store)?.ok_or_else(|| CommandError::invalid("source_missing", "no existe el Attempt que se quiere reintentar"))?,
    };
    if from.task_id != cmd.task_id {
        return Err(CommandError::invalid("source_not_in_task", "el Attempt a reintentar no es de esta Task"));
    }
    if !retryable(from.status) {
        return Err(CommandError::invalid("source_not_retryable", "solo se reintenta un Attempt que terminó mal (failed, stopped o exited)"));
    }
    if from.id != latest.id {
        return Err(CommandError::invalid("source_not_latest", format!("solo se reintenta el último Attempt de la Task ({})", latest.id)));
    }

    // 4. Qué se lanza y si se puede: el entorno bloqueado se informa tal cual, sin crear nada y sin tocar los reintentos.
    let provider = cmd.provider.unwrap_or(&from.provider);
    let same_provider = provider == from.provider;
    let gated = registry.gated(provider).map_err(|e| from_adapter(&e))?;
    match gated.matrix().state(Capability::Start) {
        CapabilityState::Available => {}
        CapabilityState::EnvironmentBlocked { block } => {
            return Err(CommandError::new(ErrorKind::EnvironmentBlocked, "environment_blocked", format!("el entorno impide lanzar con {provider}: {}", block.code())));
        }
        other => return Err(CommandError::new(ErrorKind::Unsupported, "start_unavailable", format!("{provider} no puede lanzar ahora ({})", other.code()))),
    }
    let profile = cmd.profile.map(str::to_string).or_else(|| from.profile.clone()).ok_or_else(|| CommandError::invalid("profile_missing", "ni la petición ni el Attempt anterior tienen un perfil de permisos"))?;
    let new_attempt = NewAttempt {
        provider: provider.to_string(),
        // El modelo y el esfuerzo son del proveedor: se heredan solo dentro del mismo.
        model: cmd.model.map(str::to_string).or_else(|| if same_provider { from.model.clone() } else { None }),
        effort: cmd.effort.map(str::to_string).or_else(|| if same_provider { from.effort.clone() } else { None }),
        role: from.role.clone(),
        profile: Some(profile.clone()),
        external: false,
        requires_approval: false,
    };
    let new = NewRetry { request_id: cmd.request_id.to_string(), from_attempt_id: from.id.clone(), overrides: overrides_of(&from, cmd) };
    let prompt = cmd.prompt.map(str::to_string).unwrap_or_else(|| task_intent_prompt(&task));
    check_text("el mensaje", &prompt, MAX_PROMPT_CHARS)?;

    // 5. Todo o nada: el Attempt, su procedencia y los dos eventos.
    let done = st
        .attempt_retry_recorded(cmd.task_id, &new_attempt, &new, now, |a, t| attempt_ops::requested_fact(a, t, ctx, now), |a, r, t| attempt_ops::retried_fact(a, r, t, ctx, now))
        .map_err(from_store)?;
    let (attempt, retry) = match done {
        Retried::Created { attempt, retry } => (attempt, retry),
        // Otro hilo la atendió entre la comprobación y la transacción: es la misma petición.
        Retried::Replayed { attempt, retry } => return Ok(RetryOutcome { attempt, retry, run: None, replayed: true }),
    };

    // 6. Lanzar. Si falla, el Attempt nuevo se cierra (`stopped` si nada llegó a ejecutarse, `failed` si fue el proveedor);
    //    el anterior no se toca.
    let launched = gated.start(
        StartRequest { attempt_id: attempt.id.clone(), worktree: cmd.worktree.to_path_buf(), prompt, profile, model: attempt.model.clone(), effort: attempt.effort.clone() },
        cancel,
    );
    match launched {
        Ok(run) => {
            let core = MutationContext::core();
            attempt_ops::start(st, &core, &attempt.id).map_err(|e| from_store(e).for_attempt(&attempt.id))?;
            let attempt = st.attempt_row(&attempt.id).map_err(from_store)?.unwrap_or(attempt);
            Ok(RetryOutcome { attempt, retry, run: Some(run), replayed: false })
        }
        Err(e) => {
            settle_failure(st, &attempt.id, &e);
            Err(from_adapter(&e).for_attempt(&attempt.id))
        }
    }
}

// ── attempt.resume ───────────────────────────────────────────────────────────────────────────────────────────────────

/// El fallback que el cliente VIO y confirmó: un ContextPackage en lugar de la ProviderSession que no se puede reanudar.
#[derive(Clone, Copy, Debug)]
pub struct Fallback<'a> {
    /// El ContextPackage v1 (JSON). Tiene que salir del Attempt al que se continúa.
    pub package: &'a str,
    /// El motivo por el que el cliente vio que no se podía reanudar (el de `ContinuityError`). Si ahora es otro, no se aplica.
    pub confirmed_reason: Reason,
}

/// Qué pide `attempt.resume`. Reanuda la ProviderSession del Attempt, en el MISMO proveedor.
#[derive(Clone, Debug)]
pub struct ResumeCommand<'a> {
    /// Clave de idempotencia de la Task.
    pub request_id: &'a str,
    pub task_id: &'a str,
    /// El Attempt cuya sesión se reanuda: de la Task y ya terminado.
    pub from_attempt_id: &'a str,
    /// El mensaje con que continúa.
    pub prompt: &'a str,
    pub worktree: &'a Path,
    /// `None`: el del Attempt anterior. Otro proveedor solo con [`Fallback`] (una sesión no se comparte entre proveedores).
    pub provider: Option<&'a str>,
    pub profile: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    /// `None`: solo reanudación nativa; si no se puede, error (con `fallback_available`) y no se crea nada.
    pub fallback: Option<Fallback<'a>>,
}

/// `attempt.resume`: continúa la ProviderSession del Attempt en un Attempt nuevo (el anterior es final y no se reabre).
/// Es `continue_attempt` (LXO-134) con la confirmación del fallback hecha explícita.
pub(super) fn resume(st: &mut Store, registry: &AdapterRegistry, ctx: &MutationContext, cancel: &CancelToken, settings: &Settings, cmd: &ResumeCommand<'_>) -> Result<Outcome, CommandError> {
    resume_at(st, registry, ctx, cancel, settings, cmd, now_ms() as i64)
}

pub(super) fn resume_at(st: &mut Store, registry: &AdapterRegistry, ctx: &MutationContext, cancel: &CancelToken, settings: &Settings, cmd: &ResumeCommand<'_>, now: i64) -> Result<Outcome, CommandError> {
    // El proveedor por defecto es el del Attempt anterior; si no existe, `continue_attempt` lo dirá con su código.
    let provider = match cmd.provider {
        Some(p) => p.to_string(),
        None => st.attempt_row(cmd.from_attempt_id).map_err(from_store)?.map(|a| a.provider).unwrap_or_default(),
    };
    let req = ContinueRequest {
        request_id: cmd.request_id,
        task_id: cmd.task_id,
        from_attempt_id: cmd.from_attempt_id,
        provider: &provider,
        intent: match cmd.fallback {
            None => Intent::Native,
            Some(f) => Intent::Auto { package: Some(f.package) },
        },
        prompt: cmd.prompt,
        worktree: cmd.worktree,
        profile: cmd.profile,
        model: cmd.model,
        effort: cmd.effort,
        confirmed_reason: cmd.fallback.map(|f| f.confirmed_reason),
    };
    continuity::continue_attempt_at(st, registry, ctx, cancel, settings, &req, now)
}
