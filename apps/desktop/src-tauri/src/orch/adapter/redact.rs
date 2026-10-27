//! Redacción de lo que sale de un adapter (LXO-128, invariante 5): ni un secreto ni una variable de entorno sensible
//! llegan a un Event, a un diagnóstico o a un mensaje de error. Reutiliza [`looks_secret`] (la misma red de seguridad que
//! protege `provider_sessions` y `worktrees`): es una red, no un detector completo, y por eso el adapter además no recibe
//! variables de entorno en sus peticiones.

use std::sync::OnceLock;

use regex::Regex;

use crate::store::looks_secret;

pub const REDACTED: &str = "[redactado]";

/// Tope de un diagnóstico crudo que acompaña a un error: suficiente para entender el fallo, no para volcar una salida.
pub const MAX_DIAGNOSTIC_CHARS: usize = 2048;

fn words() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\S+").expect("regex fija"))
}

/// Palabras que anuncian una credencial en la palabra siguiente (`Bearer abc`, `Authorization: Basic abc`).
fn announces_secret(word: &str) -> bool {
    matches!(word.trim_end_matches(':').to_ascii_lowercase().as_str(), "bearer" | "basic" | "authorization")
}

/// `text` sin nada con forma de credencial: cada palabra sospechosa, y la que sigue a `Bearer`/`Basic`/`Authorization`,
/// se sustituye por [`REDACTED`]. Conserva los espacios y saltos de línea originales.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    let mut announced = false;
    for m in words().find_iter(text) {
        out.push_str(&text[last..m.start()]);
        let w = m.as_str();
        let hide = announced || announces_secret(w) || looks_secret(w);
        announced = announces_secret(w);
        out.push_str(if hide { REDACTED } else { w });
        last = m.end();
    }
    out.push_str(&text[last..]);
    out
}

/// Como mucho `max` caracteres, marcando el corte (nunca en silencio).
pub fn bounded(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut s: String = text.chars().take(max).collect();
    s.push('…');
    s
}

/// Redacta y acota: el único camino por el que un texto del proveedor entra en un error o un diagnóstico.
pub fn safe_text(text: &str, max: usize) -> String {
    bounded(&redact(text), max)
}
