//! Uso de la cuenta de Codex (LXO-205): `account/rateLimits/read` de `codex app-server`. Es una consulta de solo lectura que
//! no crea ningún hilo ni gasta cuota. Contrastado con Codex 0.164.0 (`testdata/codex-0.164.0-account-rate-limits.json`).
//!
//! No se mapea `account/tokenUsage/read` (totales de por vida y por día): no es uso de límites y mezclaría magnitudes.

use serde_json::Value;

use crate::orch::adapter::usage::{Credits, Provenance, UsageError, UsageSnapshot, UsageWindow};
use crate::orch::adapter::AdapterError;

fn percent(w: &Value) -> Option<f64> {
    w.get("usedPercent").and_then(Value::as_f64).filter(|p| (0.0..=100.0).contains(p))
}

fn window(id: String, w: &Value) -> Option<UsageWindow> {
    // Una ventana sin porcentaje ni reinicio no dice nada: no se inventa.
    if !w.is_object() {
        return None;
    }
    Some(UsageWindow { id, minutes: w.get("windowDurationMins").and_then(Value::as_u64), used_percent: percent(w), resets_at: w.get("resetsAt").and_then(Value::as_i64) })
}

/// Respuesta de `account/rateLimits/read` → snapshot. `now_ms` es el momento de la consulta.
pub fn snapshot_from(v: &Value, now_ms: i64) -> UsageSnapshot {
    let mut snap = UsageSnapshot::new(now_ms, Provenance::ProviderQuery);
    snap.account_id = v.get("accountId").and_then(Value::as_str).map(str::to_string);

    // Un cubo por `limitId` (modelos con cuota propia); sin el mapa, el cubo único de compatibilidad.
    let mut buckets: Vec<(String, &Value)> = match v.get("rateLimitsByLimitId").and_then(Value::as_object) {
        Some(o) if !o.is_empty() => o.iter().map(|(k, b)| (k.clone(), b)).collect(),
        _ => v.get("rateLimits").filter(|b| b.is_object()).map(|b| (b.get("limitId").and_then(Value::as_str).unwrap_or("codex").to_string(), b)).into_iter().collect(),
    };
    buckets.sort_by(|a, b| a.0.cmp(&b.0));

    let single = v.get("rateLimits").filter(|b| b.is_object());
    snap.plan = single.and_then(|b| b.get("planType")).and_then(Value::as_str).filter(|p| *p != "unknown").map(str::to_string);
    snap.credits = single.and_then(|b| b.get("credits")).filter(|c| c.is_object()).map(|c| Credits {
        has_credits: c.get("hasCredits").and_then(Value::as_bool),
        unlimited: c.get("unlimited").and_then(Value::as_bool),
        balance: c.get("balance").and_then(Value::as_str).map(str::to_string),
    });

    for (limit, b) in &buckets {
        for slot in ["primary", "secondary"] {
            if let Some(w) = b.get(slot).and_then(|w| window(format!("{limit}.{slot}"), w)) {
                snap.windows.push(w);
            }
        }
    }

    let reached = buckets.iter().any(|(_, b)| b.get("rateLimitReachedType").is_some_and(|t| !t.is_null()));
    snap.limit_reached = match (reached, v.get("ordinaryUsageAllowed").and_then(Value::as_bool)) {
        (true, _) | (_, Some(false)) => Some(true),
        (false, Some(true)) => Some(false),
        // Sin ninguna de las dos señales no se afirma nada.
        (false, None) => None,
    };
    snap
}

/// El error de Codex → el error de uso que corresponde. Heurística sobre el texto: Codex no da códigos estables aquí, y
/// ante la duda es `provider_unavailable`, nunca un `auth_required` inventado.
pub fn classify(e: &AdapterError) -> UsageError {
    let m = e.message.to_lowercase();
    if ["not logged in", "login", "log in", "sign in", "unauthorized", "authentication required"].iter().any(|k| m.contains(k)) {
        UsageError::auth_required()
    } else if ["rate limit", "too many requests"].iter().any(|k| m.contains(k)) {
        UsageError::rate_limited()
    } else {
        UsageError::from(e.clone())
    }
}
