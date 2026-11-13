//! RPC `attempt_retry`: la persona pide un Attempt LIMPIO para una Task cuyo último Attempt terminó mal (LXO-142, puente PR 3).
//!
//! Es la puerta del puente (`docs/core/REINTENTO.md`): valida la petición y llama a `Tx::request_attempt_retry` (nace el Attempt
//! `n + 1` y su `attempt.retried`). Desktop lo deja en `starting` y despierta al despachador; CLI lo deja `pending_approval`
//! hasta que una Person de Desktop lo apruebe.
//!
//! # Qué acepta el cliente
//! * `task_id` y `from_attempt_id`: el Attempt que se reintenta, que tiene que ser el último de la Task. Nombrarlo es lo que hace la
//!   petición exacta: repetirla cuando el reintento ya existe (doble clic, reintento de red) devuelve ese Attempt (`Replayed`) en
//!   vez de abrir otro.
//! * `provider`, `model`, `effort` opcionales (lo que se quiere distinto). **No acepta `profile`**: el perfil de permisos se hereda
//!   del Attempt anterior, así que un reintento nunca amplía lo que el agente puede hacer (`deny_unknown_fields` lo rechaza).
//!
//! # Identidad y aprobación
//! Desktop pide directamente el retry. CLI también puede solicitarlo, pero nace `pending_approval` y no despierta el despachador
//! hasta que una Person de Desktop lo apruebe.

use serde::Deserialize;

use super::events::{Channel, MutationContext};
use super::tx_ops::RetrySelection;
use super::Core;
use crate::store::AttemptFollowUpKind;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RetryInput {
    pub task_id: String,
    pub from_attempt_id: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum RetryResult {
    /// Se creó el Attempt `n + 1` (el id). Falta despertar al despachador.
    Requested(String),
    /// El reintento de ese Attempt ya existía (el id): no se escribe nada.
    Replayed(String),
}

pub(crate) const RETRY_NOT_AVAILABLE: &str = "reintentar un Attempt requiere el lifecycle de lanzamiento verificado";

/// `<task>-a<n>` con `n > 0` canónico y de la Task que se dice: devuelve `n`.
pub(super) fn attempt_number(task_id: &str, attempt_id: &str) -> Result<u32, String> {
    let invalid = || "Falta un id de Attempt válido".to_string();
    if task_id.is_empty() || task_id.len() > 256 || attempt_id.len() > 256 || attempt_id.chars().chain(task_id.chars()).any(char::is_control) {
        return Err(invalid());
    }
    let (task, raw_n) = attempt_id.rsplit_once("-a").ok_or_else(invalid)?;
    let n = raw_n.parse::<u32>().ok().filter(|n| *n > 0 && format!("{task}-a{n}") == attempt_id).ok_or_else(invalid)?;
    if task != task_id {
        return Err(format!("el Attempt {attempt_id} no es de la Task {task_id}"));
    }
    Ok(n)
}

/// Un valor opcional de la selección: acotado, sin controles y sin espacios sobrantes. Vacío no es «sin valor»: es un error.
pub(super) fn clean(what: &str, value: &Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = value else { return Ok(None) };
    let v = raw.trim();
    if v.is_empty() || v.len() > 120 || v.chars().any(char::is_control) {
        return Err(format!("{what} no es válido"));
    }
    Ok(Some(v.to_string()))
}

pub(super) fn retry(core: &Core, context: &MutationContext, input: &RetryInput) -> Result<RetryResult, String> {
    if !context.is_person() || context.client_id.as_deref().is_none_or(str::is_empty) || context.channel == Channel::Core {
        return Err("reintentar un Attempt requiere una Person autenticada".into());
    }
    let from_n = attempt_number(&input.task_id, &input.from_attempt_id)?;
    let next_n = from_n.checked_add(1).ok_or_else(|| "Falta un id de Attempt válido".to_string())?;
    let selection = RetrySelection {
        provider: clean("provider", &input.provider)?,
        model: clean("model", &input.model)?,
        effort: clean("effort", &input.effort)?,
        profile: None,
    };

    let (current, project_id, current_provider) = {
        let st = core.lock();
        let task = st.tasks.get(&input.task_id).ok_or_else(|| format!("no existe la Task {}", input.task_id))?;
        let current = st.attempt_n.get(&input.task_id).copied().ok_or_else(|| "la Task no tiene ningún Attempt que reintentar".to_string())?;
        (current, task.project_id.clone(), task.agent.clone())
    };
    if current == next_n {
        let next_id = format!("{}-a{current}", input.task_id);
        if core.attempt_follow_up_kind(&next_id)? != Some(AttemptFollowUpKind::Retry) {
            return Err(format!("attempt_retry_conflict: {next_id} no procede de un retry canónico de {}", input.from_attempt_id));
        }
        let source = core
            .attempt_row_for_resume(&input.from_attempt_id)?
            .ok_or_else(|| format!("attempt_retry_conflict: falta el Attempt fuente {}", input.from_attempt_id))?;
        let next = core
            .attempt_row_for_resume(&next_id)?
            .ok_or_else(|| format!("attempt_retry_conflict: falta el Attempt creado {next_id}"))?;
        if source.task_id != input.task_id || source.n != i64::from(from_n) {
            return Err(format!("attempt_retry_conflict: {} no es el origen durable esperado", input.from_attempt_id));
        }
        let provider = selection.provider.as_deref().unwrap_or(&source.provider);
        let same_provider = provider == source.provider;
        let model = selection.model.as_deref().or_else(|| if same_provider { source.model.as_deref() } else { None });
        let effort = selection.effort.as_deref().or_else(|| if same_provider { source.effort.as_deref() } else { None });
        if next.provider != provider
            || next.model.as_deref() != model
            || next.effort.as_deref() != effort
            || next.role != source.role
            || next.profile != source.profile
            || next.external != source.external
        {
            return Err(format!("attempt_retry_conflict: {next_id} ya existe con otra intención"));
        }
        return Ok(RetryResult::Replayed(next_id));
    }
    if current != from_n {
        return Err(format!("solo se reintenta el último Attempt de la Task: el actual es {}-a{current}", input.task_id));
    }
    // Un replay no depende de que el lanzador siga instalado; una petición nueva sí.
    if core.launcher().is_none() {
        return Err(RETRY_NOT_AVAILABLE.into());
    }
    // Lo que se comprobó al crear la Task pudo cambiar: se vuelve a mirar ANTES de escribir nada.
    let project_id = project_id.filter(|p| !p.is_empty()).ok_or_else(|| "la Task no tiene Project: no hay desde dónde lanzar".to_string())?;
    core.project_launch_location(&project_id)?;
    core.provider_start_preflight(selection.provider.as_deref().unwrap_or(&current_provider))?;

    core.mutate_as(context, |tx| tx.request_attempt_retry(&input.task_id, &selection)).map_err(|e| e.to_string())?;
    Ok(RetryResult::Requested(format!("{}-a{next_n}", input.task_id)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_id_del_attempt_es_canonico_y_de_la_task() {
        assert_eq!(attempt_number("t2", "t2-a1"), Ok(1));
        assert_eq!(attempt_number("t2", "t2-a12"), Ok(12));
        for (task, attempt) in [("t2", "t2-a0"), ("t2", "t2-a01"), ("t2", "t2-a"), ("t2", "t2"), ("", "-a1"), ("t2", "t2-a1\n")] {
            assert!(attempt_number(task, attempt).is_err(), "{attempt}");
        }
        assert!(attempt_number("t2", "t3-a1").unwrap_err().contains("no es de la Task"));
    }

    #[test]
    fn los_valores_opcionales_van_acotados_y_vacio_es_un_error() {
        assert_eq!(clean("model", &None), Ok(None));
        assert_eq!(clean("model", &Some("  haiku ".into())), Ok(Some("haiku".into())));
        for bad in ["", "   ", "a\nb", &"x".repeat(121)] {
            assert!(clean("model", &Some(bad.to_string())).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn el_cliente_no_puede_pedir_un_perfil() {
        let ok = serde_json::from_value::<RetryInput>(serde_json::json!({"task_id": "t2", "from_attempt_id": "t2-a1", "provider": "codex"}));
        assert!(ok.is_ok());
        let con_perfil = serde_json::from_value::<RetryInput>(serde_json::json!({"task_id": "t2", "from_attempt_id": "t2-a1", "profile": "autonomia_amplia"}));
        assert!(con_perfil.is_err(), "un reintento nunca amplía los permisos: el perfil se hereda");
    }
}
