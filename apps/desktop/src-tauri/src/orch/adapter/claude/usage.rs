//! Uso de la cuenta de Claude (LXO-205): el comando local `/usage` de la propia CLI (`claude -p /usage`), que NO llama al
//! modelo (0 turnos, coste 0; capturado con 2.1.296 en `testdata/claude-2.1.296-usage-comando.jsonl`).
//!
//! De su salida solo se leen las líneas de límites (`Current session: 72% used · resets …`). El resto del texto (qué skills,
//! servidores MCP o subagentes consumen más) es actividad local de la persona, no cuota: no se copia ni se guarda.
//! La hora de reinicio viene en texto con una zona IANA (`Oct 26, 5:39pm (America/Bogota)`) y sin base de zonas horarias
//! no se convierte: `resets_at` queda desconocido en vez de adivinarse.

use std::sync::OnceLock;

use regex::Regex;

use crate::orch::adapter::usage::UsageWindow;

fn line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*Current (session|week)(?: \(([^)]{1,40})\))?: (\d{1,3})% used\b").expect("regex fija"))
}

fn slug(text: &str) -> String {
    let s: String = text.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' }).collect();
    s.split('_').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("_")
}

/// Las ventanas de límite que dice `/usage`. Vacío si el texto no trae ninguna (p. ej. una cuenta con clave de API).
pub fn windows_from(text: &str) -> Vec<UsageWindow> {
    text.lines()
        .filter_map(|l| {
            let c = line_re().captures(l)?;
            let pct: f64 = c[3].parse().ok().filter(|p: &f64| *p <= 100.0)?;
            let (id, minutes) = match (&c[1], c.get(2).map(|m| m.as_str())) {
                ("session", _) => ("five_hour".to_string(), 300),
                // "all models" es la ventana semanal general; una con calificador (`Opus`) tiene la suya.
                ("week", None) | ("week", Some("all models")) => ("seven_day".to_string(), 10_080),
                ("week", Some(q)) => (format!("seven_day_{}", slug(q)), 10_080),
                _ => return None,
            };
            Some(UsageWindow { id, minutes: Some(minutes), used_percent: Some(pct), resets_at: None })
        })
        .collect()
}
