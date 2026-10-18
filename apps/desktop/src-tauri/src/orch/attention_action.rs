//! Comandos de decisión humana sobre Attention expuestos únicamente por Desktop.

use serde_json::{json, Value};

use super::events::{Channel, MutationContext};
use super::Core;
use crate::store::{AttentionCategory, ClientAction, ClientClaims};

impl Core {
    /// Resuelve como `acted` un riesgo de policy. Solo Desktop Person: HTTP/RPC no expone este Command.
    pub fn attention_act_risk_from_ui(&self, attention_id: &str) -> Result<Value, String> {
        let client = self
            .desktop_client()?
            .ok_or("La identidad autenticada de Desktop no está disponible")?;
        client
            .authorize(ClientAction::HumanDecision)
            .map_err(|error| format!("Acción humana no autorizada: {error}"))?;
        let context =
            MutationContext::authenticated(&client, &ClientClaims::default(), Channel::Ui)
                .map_err(|error| format!("Identidad de Desktop inválida: {error}"))?;
        if !context.is_person_ui() || context.client_id.is_none() {
            return Err(
                "Resolver risk requiere una identidad Person autenticada de Desktop".into(),
            );
        }
        if attention_id.is_empty()
            || attention_id.chars().count() > 200
            || attention_id.chars().any(char::is_control)
        {
            return Err("attention_id inválido".into());
        }
        if !self.event_log_available() {
            return Err(
                "No se puede resolver risk: el Event Log autoritativo no está disponible".into(),
            );
        }
        let row = self
            .storage
            .attention_get_scoped(attention_id, None)
            .ok_or("El almacén de Attention no está disponible")?
            .map_err(|error| format!("No se pudo leer Attention: {error}"))?
            .ok_or_else(|| format!("Attention inexistente: {attention_id}"))?;
        if row.category != AttentionCategory::Risk {
            return Err("Solo se puede resolver como acted una Attention de categoría risk".into());
        }
        let draft =
            super::event_kinds::attention_risk_acted(attention_id, row.project_id, row.run_id)
                .map_err(|error| format!("No se pudo construir el Event de decisión: {error}"))?;
        self.record_facts(&context, vec![draft])
            .map_err(|error| error.to_string())?;
        Ok(json!({ "attention_id": attention_id, "status": "resolved", "resolution": "acted" }))
    }
}
