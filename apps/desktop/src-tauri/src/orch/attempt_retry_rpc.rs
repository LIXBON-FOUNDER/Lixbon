//! RPC `attempt_retry`: la persona pide un Attempt LIMPIO para una Task cuyo último Attempt terminó mal (LXO-142, puente PR 3).
//!
//! Es la puerta del puente (`docs/core/REINTENTO.md`): valida la petición, pasa la Task a `starting` con `Tx::request_attempt_retry`
//! (nace el Attempt `n + 1` y su `attempt.retried`) y el despachador lo lanza por el mismo camino que al primer Attempt. Pedirlo no
//! lanza nada por sí mismo: despierta al despachador, que recoge el Attempt en su barrido.
//!
//! # Qué acepta el cliente
//! * `task_id` y `from_attempt_id`: el Attempt que se reintenta, que tiene que ser el último de la Task. Nombrarlo es lo que hace la
//!   petición exacta: repetirla cuando el reintento ya existe (doble clic, reintento de red) devuelve ese Attempt (`Replayed`) en
//!   vez de abrir otro.
//! * `provider`, `model`, `effort` opcionales (lo que se quiere distinto). **No acepta `profile`**: el perfil de permisos se hereda
//!   del Attempt anterior, así que un reintento nunca amplía lo que el agente puede hacer (`deny_unknown_fields` lo rechaza).
//!
//! # Solo una Person de Desktop
//! `rpc_action` lo clasifica como decisión humana: ni un agente ni el CLI. Aquí se vuelve a exigir una Person autenticada.

use serde::Deserialize;

use super::events::{Channel, MutationContext};
use super::tx_ops::RetrySelection;
use super::Core;

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
    let selection = RetrySelection {
        provider: clean("provider", &input.provider)?,
        model: clean("model", &input.model)?,
        effort: clean("effort", &input.effort)?,
        profile: None,
    };
    // Sin lanzador instalado nada ejecutaría el Attempt nuevo: se rechaza antes de tocar nada.
    if core.launcher().is_none() {
        return Err(RETRY_NOT_AVAILABLE.into());
    }

    let (project_id, current_provider) = {
        let st = core.lock();
        let task = st.tasks.get(&input.task_id).ok_or_else(|| format!("no existe la Task {}", input.task_id))?;
        let current = st.attempt_n.get(&input.task_id).copied().ok_or_else(|| "la Task no tiene ningún Attempt que reintentar".to_string())?;
        if current == from_n + 1 {
            // Ya hay un Attempt posterior a ese: es su reintento (el único que nace de él).
            return Ok(RetryResult::Replayed(format!("{}-a{current}", input.task_id)));
        }
        if current != from_n {
            return Err(format!("solo se reintenta el último Attempt de la Task: el actual es {}-a{current}", input.task_id));
        }
        (task.project_id.clone(), task.agent.clone())
    };
    // Lo que se comprobó al crear la Task pudo cambiar: se vuelve a mirar ANTES de escribir nada.
    let project_id = project_id.filter(|p| !p.is_empty()).ok_or_else(|| "la Task no tiene Project: no hay desde dónde lanzar".to_string())?;
    core.project_launch_location(&project_id)?;
    core.provider_start_preflight(selection.provider.as_deref().unwrap_or(&current_provider))?;

    core.mutate_as(context, |tx| tx.request_attempt_retry(&input.task_id, &selection)).map_err(|e| e.to_string())?;
    Ok(RetryResult::Requested(format!("{}-a{}", input.task_id, from_n + 1)))
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
