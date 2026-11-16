//! RPC `attempt_resume`: la persona continúa la sesión del proveedor de un Attempt terminado con un mensaje nuevo (LXO-142, puente PR 4).
//!
//! Hermano de `attempt_retry` (`attempt_retry_rpc.rs`), con una diferencia de fondo: el reintento arranca limpio y esto **reanuda** la
//! ProviderSession del Attempt anterior, así que conserva lo que el proveedor guarda de la conversación. Valida la petición, pasa la
//! Task a `starting` con `Tx::request_attempt_continuation` (nace el Attempt `n + 1`, enlazado a la misma sesión, con
//! `attempt.continued`) y el despachador lo lanza con `resume` en vez de `start`. Pedirlo no lanza nada por sí mismo.
//!
//! # Qué acepta el cliente
//! * `task_id`, `from_attempt_id` (el último de la Task: hace la petición exacta y permite el `Replayed`) y `prompt` (el mensaje con
//!   que continúa la sesión).
//! * `model` y `effort` opcionales. **No acepta `provider`** (una ProviderSession no se comparte entre proveedores) **ni `profile`**
//!   (se hereda: continuar nunca amplía lo que el agente puede hacer). `deny_unknown_fields` los rechaza.
//!
//! # Solo reanudación nativa
//! Si la sesión no sirve (no se guardó, está cerrada, el proveedor no ofrece `resume`) es un error que lo dice. El **fallback con
//! ContextPackage** (arrancar limpio con el paquete del Attempt anterior) exige que la persona vea y confirme el motivo, y no entra aquí.
//!
//! # Identidad y aprobación
//! Desktop pide directamente la continuación. CLI también puede solicitarla, pero nace `pending_approval` y no despierta el
//! despachador hasta que una Person de Desktop la apruebe.

use serde::Deserialize;

use super::attempt_retry_rpc::{attempt_number, clean, RetryResult};
use super::continuity::MAX_PROMPT_CHARS;
use super::events::{Channel, MutationContext};
use super::tx_ops::RetrySelection;
use super::Core;
use crate::store::{AttemptFollowUpKind, SessionStatus};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ResumeInput {
    pub task_id: String,
    pub from_attempt_id: String,
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

pub(crate) const RESUME_NOT_AVAILABLE: &str = "continuar un Attempt requiere el lifecycle de lanzamiento verificado";

/// El mensaje de la continuación: no vacío, acotado y sin caracteres de control salvo saltos de línea y tabuladores.
pub(super) fn clean_prompt(prompt: &str) -> Result<String, String> {
    let p = prompt.trim();
    if p.is_empty() {
        return Err("falta el mensaje con que continúa la sesión".into());
    }
    if p.contains(super::dispatch::FOLLOW_UP_MARKER) {
        return Err("el mensaje contiene el delimitador reservado de seguimiento".into());
    }
    if p.chars().count() > MAX_PROMPT_CHARS || p.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
        return Err("el mensaje no es válido: demasiado largo o con caracteres de control".into());
    }
    Ok(p.to_string())
}

pub(super) fn resume(core: &Core, context: &MutationContext, input: &ResumeInput) -> Result<RetryResult, String> {
    if !context.is_person() || context.client_id.as_deref().is_none_or(str::is_empty) || context.channel == Channel::Core {
        return Err("continuar un Attempt requiere una Person autenticada".into());
    }
    let from_n = attempt_number(&input.task_id, &input.from_attempt_id)?;
    let next_n = from_n.checked_add(1).ok_or_else(|| "Falta un id de Attempt válido".to_string())?;
    let prompt = clean_prompt(&input.prompt)?;
    let selection = RetrySelection { provider: None, model: clean("model", &input.model)?, effort: clean("effort", &input.effort)?, profile: None };

    let (current, project_id, provider, spec) = {
        let st = core.lock();
        let task = st.tasks.get(&input.task_id).ok_or_else(|| format!("no existe la Task {}", input.task_id))?;
        let current = st.attempt_n.get(&input.task_id).copied().ok_or_else(|| "la Task no tiene ningún Attempt que continuar".to_string())?;
        (current, task.project_id.clone(), task.agent.clone(), task.spec.clone())
    };
    if current == next_n {
        let next_id = format!("{}-a{current}", input.task_id);
        if core.attempt_follow_up_kind(&next_id)? != Some(AttemptFollowUpKind::NativeResume) {
            return Err(format!("attempt_resume_conflict: {next_id} no procede de un resume nativo de {}", input.from_attempt_id));
        }
        let source = core
            .attempt_row_for_resume(&input.from_attempt_id)?
            .ok_or_else(|| format!("attempt_resume_conflict: falta el Attempt fuente {}", input.from_attempt_id))?;
        let next = core
            .attempt_row_for_resume(&next_id)?
            .ok_or_else(|| format!("attempt_resume_conflict: falta el Attempt creado {next_id}"))?;
        if source.task_id != input.task_id || source.n != i64::from(from_n) {
            return Err(format!("attempt_resume_conflict: {} no es el origen durable esperado", input.from_attempt_id));
        }
        let expected_model = selection.model.as_deref().or(source.model.as_deref());
        let expected_effort = selection.effort.as_deref().or(source.effort.as_deref());
        if next.provider != source.provider
            || next.model.as_deref() != expected_model
            || next.effort.as_deref() != expected_effort
            || next.role != source.role
            || next.profile != source.profile
            || next.external != source.external
            || next.provider_session_id != source.provider_session_id
            || source.provider_session_id.is_none()
            || super::dispatch::follow_up_prompt(&spec).as_deref() != Some(prompt.as_str())
        {
            return Err(format!("attempt_resume_conflict: {next_id} ya existe con otra intención"));
        }
        return Ok(RetryResult::Replayed(next_id));
    }
    if current != from_n {
        return Err(format!("solo se continúa el último Attempt de la Task: el actual es {}-a{current}", input.task_id));
    }
    if !core.lock().tasks.get(&input.task_id).is_some_and(|task| task.status.is_final()) {
        return Err("solo se continúa un Attempt terminado".into());
    }
    // Un replay no depende de que el lanzador siga instalado; una petición nueva sí.
    if core.launcher().is_none() {
        return Err(RESUME_NOT_AVAILABLE.into());
    }

    // La sesión del Attempt anterior tiene que servir para reanudarla; si no, se dice por qué ANTES de escribir nada.
    let session = core.attempt_session_record(&input.from_attempt_id)?.ok_or_else(|| "el Attempt anterior no tuvo una sesión del proveedor que reanudar".to_string())?;
    if session.provider != provider {
        return Err("la sesión no es del proveedor del Attempt: no se puede reanudar".into());
    }
    if !session.resumable || session.external_ref.as_deref().is_none_or(|r| r.trim().is_empty()) {
        return Err("la sesión del proveedor no es resumible: no entregó una referencia para reanudarla".into());
    }
    if session.status != SessionStatus::Idle {
        return Err(format!("la sesión del proveedor no está en espera ({}): no se puede reanudar", session.status.as_str()));
    }
    // Lo que se comprobó al crear la Task pudo cambiar: se vuelve a mirar ANTES de escribir nada.
    let project_id = project_id.filter(|p| !p.is_empty()).ok_or_else(|| "la Task no tiene Project: no hay desde dónde lanzar".to_string())?;
    core.project_launch_location(&project_id)?;
    core.provider_resume_preflight(&provider)?;

    core.mutate_as(context, |tx| tx.request_attempt_continuation(&input.task_id, &prompt, &selection)).map_err(|e| e.to_string())?;
    Ok(RetryResult::Requested(format!("{}-a{next_n}", input.task_id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_mensaje_va_acotado_y_sin_controles_salvo_saltos() {
        assert_eq!(clean_prompt("  sigue con X\ny con Y\t.  "), Ok("sigue con X\ny con Y\t.".into()));
        for bad in ["", "   ", "a\u{0}b", "a\u{1b}[31mb"] {
            assert!(clean_prompt(bad).is_err(), "{bad:?}");
        }
        let marker = super::super::dispatch::FOLLOW_UP_MARKER;
        assert!(clean_prompt(&format!("texto{marker}ambiguo")).is_err());
        assert!(clean_prompt(&"x".repeat(MAX_PROMPT_CHARS + 1)).is_err());
    }

    #[test]
    fn el_cliente_no_puede_cambiar_de_proveedor_ni_pedir_un_perfil() {
        let ok = serde_json::from_value::<ResumeInput>(serde_json::json!({"task_id": "t2", "from_attempt_id": "t2-a1", "prompt": "sigue", "model": "haiku"}));
        assert!(ok.is_ok());
        for extra in ["provider", "profile"] {
            let mut v = serde_json::json!({"task_id": "t2", "from_attempt_id": "t2-a1", "prompt": "sigue"});
            v[extra] = serde_json::json!("x");
            assert!(serde_json::from_value::<ResumeInput>(v).is_err(), "{extra} no se acepta");
        }
        assert!(serde_json::from_value::<ResumeInput>(serde_json::json!({"task_id": "t2", "from_attempt_id": "t2-a1"})).is_err(), "el mensaje es obligatorio");
    }
}
