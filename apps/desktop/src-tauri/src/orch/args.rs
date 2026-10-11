//! Lectura de argumentos sueltos de un `Value` (lo que llega por `lxo`).

use serde_json::Value;
use super::state::Kind;

pub(super) fn s(args: &Value, key: &str) -> String {
    args.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

pub(super) fn b(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub(super) fn n(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

pub(super) fn kinds(args: &Value) -> Vec<Kind> {
    s(args, "types").split(',').filter_map(Kind::parse).collect()
}
