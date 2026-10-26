//! Detector y redactor de secretos del ContextPackage (LXO-133, D42). Parte de la red de seguridad de siempre
//! ([`looks_secret`]: ids, metadata) y le añade lo que el experimento de LXO-132 midió que no veía: JWT, URL con
//! credenciales, más prefijos de token (`npm_`, `ya29.`, `sk_live_`…), claves AWS de 40 caracteres y variables de entorno
//! con nombre de secreto (`NOMBRE_TOKEN=valor`). Cobertura medida en el experimento: 6 de 13 → 13 de 13, sin falsos positivos.
//!
//! Sigue siendo una red, no un detector completo: por eso un paquete **nunca** copia un adjunto de código con un secreto
//! detectado (se omite) en lugar de intentar limpiarlo.

use std::sync::OnceLock;

use regex::Regex;

use crate::store::looks_secret;

pub const REDACTED: &str = "[redactado]";

/// Prefijos de token que `looks_secret` no cubre. Como en aquel, cuenta si la palabra sigue con al menos 8 caracteres.
const EXTRA_PREFIXES: [&str; 14] =
    ["npm_", "ya29.", "sk_live_", "sk_test_", "rk_live_", "rk_test_", "shpat_", "xoxa-", "xoxs-", "xoxr-", "hf_", "ghr_", "dop_v1_", "pypi-"];
const KEYWORDS: [&str; 6] = ["KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL"];
const SEPARATORS: &str = "\"'`,;()[]{}<>/\\?&=:@";

fn jwt() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*)?$").expect("regex fija"))
}

fn userinfo() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)[a-z][a-z0-9+.\-]*://[^/\s:@]+:[^/\s@]+@").expect("regex fija"))
}

/// El valor de una asignación que solo REFERENCIA un secreto (`$VAR`, `${VAR}`, `%VAR%`, `<aquí-el-token>`): no lo contiene.
fn reference_value() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^<>\s]+>|%[A-Za-z_][A-Za-z0-9_]*%)$").expect("regex fija"))
}

fn env_name() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Z][A-Z0-9_]*$").expect("regex fija"))
}

/// Un bloque PEM de clave privada, con su cuerpo: es el cuerpo lo que es secreto, no solo la cabecera. Sin pie, hasta el final.
fn pem_block() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|\z)").expect("regex fija"))
}

fn words() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\S+").expect("regex fija"))
}

fn trim_word(w: &str) -> &str {
    w.trim_matches(|c: char| "\"'`,;()[]{}<>".contains(c))
}

fn secret_named(name: &str) -> bool {
    env_name().is_match(name) && KEYWORDS.iter().any(|k| name.contains(k))
}

/// Una clave AWS de 40 caracteres: mezcla mayúsculas, minúsculas y dígitos y no es un hash hexadecimal.
fn looks_like_aws_secret(w: &str) -> bool {
    w.len() == 40
        && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '/' || c == '+')
        && w.chars().any(|c| c.is_ascii_uppercase())
        && w.chars().any(|c| c.is_ascii_lowercase())
        && w.chars().any(|c| c.is_ascii_digit())
}

/// ¿Esta palabra (sin espacios) tiene forma de credencial? El motivo es un código estable, no un fragmento del texto.
pub fn word_secret(raw: &str) -> Option<&'static str> {
    let w = trim_word(raw);
    if w.is_empty() {
        return None;
    }
    // `NOMBRE_TOKEN=$VARIABLE` o `=<tu-token>` no es un secreto: apunta a donde está.
    // (Se mira la palabra sin recortar `<` `>`: son parte de la forma `<aquí-el-token>`.)
    let unbracketed = raw.trim_matches(|c: char| "\"'`,;()[]{}".contains(c));
    if let Some((_, value)) = unbracketed.split_once('=') {
        if reference_value().is_match(value.trim_matches(|c: char| "\"'".contains(c))) {
            return None;
        }
    }
    if looks_secret(w) {
        return Some("known_pattern");
    }
    if jwt().is_match(w) {
        return Some("jwt");
    }
    if userinfo().is_match(w) {
        return Some("url_credentials");
    }
    let lower = w.to_ascii_lowercase();
    if lower.split(|c: char| c.is_whitespace() || SEPARATORS.contains(c)).any(|p| EXTRA_PREFIXES.iter().any(|x| p.starts_with(x) && p.len() >= x.len() + 8)) {
        return Some("token_prefix");
    }
    if looks_like_aws_secret(w) {
        return Some("high_entropy_key");
    }
    if let Some((name, value)) = w.split_once('=') {
        let value = value.trim_matches(|c: char| "\"'".contains(c));
        let varref = value.starts_with(['$', '<', '%', '{']);
        if secret_named(name) && !varref && value.len() >= 12 && value.chars().any(|c| c.is_ascii_alphabetic()) && value.chars().any(|c| c.is_ascii_digit()) {
            return Some("env_secret");
        }
    }
    None
}

/// ¿Anuncia esta palabra una credencial en la siguiente? (`Bearer abc`, `Authorization: x`, `NOMBRE_TOKEN: abc`).
fn announces_secret(raw: &str) -> bool {
    let w = trim_word(raw);
    let bare = w.trim_end_matches([':', '=']);
    matches!(bare.to_ascii_lowercase().as_str(), "bearer" | "basic" | "authorization") || (w.ends_with([':', '=']) && secret_named(bare))
}

/// `text` con cada palabra con forma de credencial sustituida por [`REDACTED`], y cuántas se sustituyeron. Conserva los
/// espacios y saltos de línea originales.
pub fn redact(text: &str) -> (String, usize) {
    let mut blocks = 0;
    let text = &pem_block()
        .replace_all(text, |_: &regex::Captures| {
            blocks += 1;
            REDACTED
        })
        .into_owned();
    let (red, n) = redact_words(text);
    (red, n + blocks)
}

fn redact_words(text: &str) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let (mut last, mut announced, mut count) = (0, false, 0);
    for m in words().find_iter(text) {
        out.push_str(&text[last..m.start()]);
        let w = m.as_str();
        let hide = announced || word_secret(w).is_some();
        announced = announces_secret(w);
        if hide {
            count += 1;
            out.push_str(REDACTED);
        } else {
            out.push_str(w);
        }
        last = m.end();
    }
    out.push_str(&text[last..]);
    (out, count)
}

/// ¿Hay algo con forma de credencial en el texto? Es lo que decide si un adjunto de código se omite.
pub fn contains_secret(text: &str) -> bool {
    redact(text).1 > 0
}
