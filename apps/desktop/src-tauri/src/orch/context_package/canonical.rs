//! JSON canónico del ContextPackage (LXO-133): la forma exacta de bytes sobre la que se calcula `package_id`. Claves
//! ordenadas, sin espacios, UTF-8, números enteros. No depende del orden de campos de `serde` ni de que `serde_json`
//! conserve o no el orden de inserción.

use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// `v` en forma canónica. Un número no entero no tiene forma canónica estable entre implementaciones: el paquete no los admite
/// (la validación los rechaza antes de llegar aquí).
pub fn canonical(v: &Value) -> String {
    let mut out = String::new();
    write(v, &mut out);
    out
}

fn write(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("un texto siempre se serializa")),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).expect("una clave siempre se serializa"));
                out.push(':');
                write(&o[k], out);
            }
            out.push('}');
        }
    }
}

/// `package_id` de un paquete como objeto JSON: `sha256:` + hash del canónico SIN el propio `package_id`.
pub fn package_id_of(v: &Value) -> String {
    let mut body = v.clone();
    if let Some(o) = body.as_object_mut() {
        o.remove("package_id");
    }
    format!("sha256:{}", sha256_hex(canonical(&body).as_bytes()))
}

/// Huella corta y opaca de un identificador que no debe viajar (`fp:` + 8 hex de un SHA-256).
pub fn fingerprint(raw: &str) -> String {
    format!("fp:{}", &sha256_hex(raw.as_bytes())[..8])
}
