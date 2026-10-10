//! Proveedores (CLI de agentes) que el usuario puede asignar a los roles del
//! equipo, con los modelos y esfuerzos que de verdad admite cada CLI instalada.
//!
//! Nada inventado: Claude ofrece los modelos de su `initialize` (o los alias que
//! nombra su `--help`) y los esfuerzos de `--effort`; Codex, los modelos visibles de
//! `codex debug models` con sus niveles de razonamiento. Si no se pueden detectar,
//! el modelo de `~/.codex/config.toml` y una lista mínima con `verified: false`.
//! Un proveedor que falta o con versión sin verificar sale `available: false`
//! con su motivo, pero no desaparece de la lista.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::agents;

pub const IDS: [&str; 2] = ["claude", "codex"];

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProviderModel {
    pub id: String,
    pub label: String,
    pub verified: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Provider {
    pub id: String,
    pub version: Option<String>,
    pub available: bool,
    pub disabled_reason: Option<String>,
    pub models: Vec<ProviderModel>,
    pub efforts: Vec<String>,
    /// De dónde salió la lista: `initialize`, `help`, `debug_models`, `config` o `none`.
    pub models_source: String,
}

fn m(id: &str, label: &str, verified: bool) -> ProviderModel {
    ProviderModel { id: id.into(), label: label.into(), verified }
}

/// Disponibilidad común: instalado y con versión verificada.
fn availability(id: &str, installed: bool, version: Option<&str>) -> (bool, Option<String>) {
    if !installed {
        return (false, Some(format!("{id} no está instalado o no está en el PATH de Lixbon")));
    }
    match version {
        None => (false, Some(format!("no se pudo leer `{id} --version`"))),
        Some(v) if agents::version_verified(id, v) => (true, None),
        Some(v) => (false, Some(format!("versión {v} de {id} no verificada (verificadas: {})", agents::verified_versions(id).join(", ")))),
    }
}

/// Niveles entre paréntesis de la línea `--effort` del `--help` de Claude.
pub fn claude_efforts(help: &str) -> Vec<String> {
    let Some(i) = help.find("--effort") else { return vec![] };
    let rest = &help[i..];
    let (Some(a), Some(b)) = (rest.find('('), rest.find(')')) else { return vec![] };
    if b < a || a > 300 {
        return vec![];
    }
    rest[a + 1..b].split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty() && agents::safe_token(s).is_ok()).collect()
}

/// Alias entre comillas simples de la línea `--model` del `--help` de Claude.
pub fn claude_help_aliases(help: &str) -> Vec<String> {
    let Some(i) = help.find("--model") else { return vec![] };
    let rest = &help[i..help.len().min(i + 400)];
    // Hasta el paréntesis de los ejemplos: después viene "model's full name".
    let end = rest.find(')').unwrap_or(rest.len());
    rest[..end].split('\'').skip(1).step_by(2).map(str::to_string).filter(|s| agents::safe_token(s).is_ok()).collect()
}

/// Claude a partir de lo leído de la CLI. `init`: los modelos de `initialize` (id, label).
pub fn claude(installed: bool, version: Option<&str>, help: Option<&str>, init: Option<Vec<(String, String)>>) -> Provider {
    let (available, disabled_reason) = availability("claude", installed, version);
    let help = help.unwrap_or("");
    let (models, source) = match init.filter(|l| !l.is_empty()) {
        Some(list) => (list.into_iter().map(|(id, label)| ProviderModel { id, label, verified: true }).collect(), "initialize"),
        None => {
            let aliases = claude_help_aliases(help);
            if aliases.is_empty() {
                (vec![], "none")
            } else {
                (aliases.iter().map(|a| m(a, a, true)).collect(), "help")
            }
        }
    };
    Provider { id: "claude".into(), version: version.map(str::to_string), available, disabled_reason, models, efforts: claude_efforts(help), models_source: source.into() }
}

/// Modelos visibles (`visibility: "list"`) de `codex debug models` y la unión de
/// sus niveles de razonamiento, en el orden en que aparecen.
pub fn codex_debug_models(json: &str) -> Option<(Vec<ProviderModel>, Vec<String>)> {
    let v: Value = serde_json::from_str(json.trim()).ok()?;
    let list = v["models"].as_array()?;
    let mut models = vec![];
    let mut efforts: Vec<String> = vec![];
    for x in list {
        let Some(slug) = x["slug"].as_str() else { continue };
        if x["visibility"].as_str() != Some("list") || agents::safe_token(slug).is_err() {
            continue;
        }
        models.push(m(slug, x["display_name"].as_str().unwrap_or(slug), true));
        for e in x["supported_reasoning_levels"].as_array().into_iter().flatten().filter_map(|l| l["effort"].as_str()) {
            if !efforts.iter().any(|f| f == e) && agents::safe_token(e).is_ok() {
                efforts.push(e.to_string());
            }
        }
    }
    (!models.is_empty()).then_some((models, efforts))
}

/// `model = "..."` y `model_reasoning_effort = "..."` de la raíz de config.toml.
pub fn codex_config_model(toml: &str) -> (Option<String>, Option<String>) {
    let mut model = None;
    let mut effort = None;
    for line in toml.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            break; // solo la raíz
        }
        let Some((k, v)) = l.split_once('=') else { continue };
        let v = v.split('#').next().unwrap_or("").trim().trim_matches('"').trim_matches('\'').to_string();
        match k.trim() {
            "model" if agents::safe_token(&v).is_ok() => model = Some(v),
            "model_reasoning_effort" if agents::safe_token(&v).is_ok() => effort = Some(v),
            _ => {}
        }
    }
    (model, effort)
}

/// Esfuerzos mínimos de Codex cuando no se pudieron detectar (no verificados).
const CODEX_MIN_EFFORTS: [&str; 3] = ["low", "medium", "high"];

pub fn codex(installed: bool, version: Option<&str>, debug_models: Option<&str>, config: Option<&str>) -> Provider {
    let (available, disabled_reason) = availability("codex", installed, version);
    let base = |models, efforts, source: &str| Provider {
        id: "codex".into(), version: version.map(str::to_string), available, disabled_reason: disabled_reason.clone(), models, efforts, models_source: source.into(),
    };
    if let Some((models, efforts)) = debug_models.and_then(codex_debug_models) {
        return base(models, efforts, "debug_models");
    }
    let (model, effort) = config.map(codex_config_model).unwrap_or((None, None));
    let mut efforts: Vec<String> = CODEX_MIN_EFFORTS.iter().map(|e| e.to_string()).collect();
    if let Some(e) = effort.filter(|e| !efforts.contains(e)) {
        efforts.push(e);
    }
    match model {
        Some(id) => base(vec![m(&id, &id, false)], efforts, "config"),
        None => base(vec![], efforts, "none"),
    }
}

static CACHE: Mutex<Option<(Instant, Vec<Provider>)>> = Mutex::new(None);
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

/// Consulta las CLI instaladas (con caché).
pub fn list(refresh: bool) -> Vec<Provider> {
    if !refresh {
        if let Some((at, l)) = CACHE.lock().ok().and_then(|c| c.clone()) {
            if at.elapsed() < CACHE_TTL {
                return l;
            }
        }
    }
    let claude_p = agents::probe_cli("claude");
    let codex_p = agents::probe_cli("codex");
    let init = claude_p.as_ref().and_then(|_| agents::claude_init_models());
    let debug = codex_p.as_ref().and_then(|_| agents::cli_output("codex", &["debug", "models"], Duration::from_secs(25)));
    let config = agents::codex_config_text();
    let l = vec![
        claude(claude_p.is_some(), claude_p.as_ref().and_then(|p| p.version.as_deref()), claude_p.as_ref().and_then(|p| p.help.as_deref()), init),
        codex(codex_p.is_some(), codex_p.as_ref().and_then(|p| p.version.as_deref()), debug.as_deref(), config.as_deref()),
    ];
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((Instant::now(), l.clone()));
    }
    l
}

/// ¿Está verificado este modelo para el proveedor? `None` si el proveedor no es
/// de esta lista (otros agentes): no se toca su política.
pub fn model_verified_in(list: &[Provider], provider: &str, model: &str) -> Option<bool> {
    let p = list.iter().find(|p| p.id == provider)?;
    Some(p.models.iter().any(|x| x.id == model && x.verified))
}

pub fn model_verified(provider: &str, model: &str) -> Option<bool> {
    // En las pruebas no se consulta ninguna CLI real.
    if cfg!(test) || !IDS.contains(&provider) {
        return None;
    }
    model_verified_in(&list(false), provider, model)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_HELP: &str = include_str!("testdata/claude-2.1.296-help.txt");
    const CODEX_VERSION: &str = include_str!("testdata/codex-0.162.1-version.txt");
    const CODEX_MODELS: &str = include_str!("testdata/codex-0.162.1-debug-models.json");

    #[test]
    fn version_real_de_codex_en_windows() {
        // Salida real de `codex --version` en la máquina de Presiga (con \r\n).
        assert!(CODEX_VERSION.ends_with("\r\n"));
        assert_eq!(agents::parse_version(CODEX_VERSION).as_deref(), Some("0.162.1"));
        assert_eq!(agents::parse_version("codex-cli 0.162.1").as_deref(), Some("0.162.1"));
        assert_eq!(agents::parse_version("2.1.296 (Claude Code)\r\n").as_deref(), Some("2.1.296"));
    }

    #[test]
    fn claude_desde_su_help() {
        assert_eq!(claude_efforts(CLAUDE_HELP), ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(claude_help_aliases(CLAUDE_HELP), ["fable", "opus", "sonnet"]);
        let p = claude(true, Some("2.1.296"), Some(CLAUDE_HELP), None);
        assert!(p.available && p.disabled_reason.is_none());
        assert_eq!(p.models_source, "help");
        assert!(p.models.iter().all(|m| m.verified));
        // Con initialize, sus modelos tal cual.
        let p = claude(true, Some("2.1.296"), Some(CLAUDE_HELP), Some(vec![("haiku".into(), "Haiku".into()), ("opus".into(), "Opus".into())]));
        assert_eq!(p.models, vec![m("haiku", "Haiku", true), m("opus", "Opus", true)]);
    }

    #[test]
    fn codex_desde_debug_models_real() {
        let p = codex(true, Some("0.162.1"), Some(CODEX_MODELS), None);
        assert!(p.available, "{:?}", p.disabled_reason);
        assert_eq!(p.models_source, "debug_models");
        let ids: Vec<&str> = p.models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
        // Los ocultos no salen.
        assert!(!ids.contains(&"gpt-5.5") && !ids.contains(&"codex-auto-review"));
        assert!(p.models.iter().all(|m| m.verified));
        assert_eq!(p.efforts, ["low", "medium", "high", "xhigh", "max", "ultra"]);
        assert_eq!(p.models[0].label, "GPT-6.1-Sol");
    }

    #[test]
    fn codex_sin_detectar_usa_config_sin_verificar() {
        let toml = "model = \"gpt-6.1-sol\"\nmodel_reasoning_effort = \"xhigh\"\n[windows]\nmodel = \"no\"\n";
        assert_eq!(codex_config_model(toml), (Some("gpt-6.1-sol".into()), Some("xhigh".into())));
        let p = codex(true, Some("0.162.1"), Some("Error: unknown command"), Some(toml));
        assert_eq!(p.models_source, "config");
        assert_eq!(p.models, vec![m("gpt-6.1-sol", "gpt-6.1-sol", false)]);
        assert_eq!(p.efforts, ["low", "medium", "high", "xhigh"]);
        let p = codex(true, Some("0.162.1"), None, None);
        assert!(p.models.is_empty() && p.models_source == "none");
    }

    #[test]
    fn no_instalado_o_sin_verificar_sale_sin_desaparecer() {
        let p = codex(false, None, None, None);
        assert!(!p.available && p.disabled_reason.as_deref().unwrap().contains("no está instalado"));
        let p = codex(true, None, None, None);
        assert!(!p.available && p.disabled_reason.as_deref().unwrap().contains("--version"));
        let p = codex(true, Some("0.170.0"), Some(CODEX_MODELS), None);
        assert!(!p.available && p.disabled_reason.as_deref().unwrap().contains("0.170.0 de codex no verificada"));
        assert!(!p.models.is_empty());
        let c = claude(false, None, None, None);
        assert_eq!((c.id.as_str(), c.available), ("claude", false));
        let v = serde_json::to_value(&p).unwrap();
        for k in ["id", "version", "available", "disabled_reason", "models", "efforts"] {
            assert!(v.get(k).is_some(), "{k}");
        }
        assert!(v["models"][0].get("verified").is_some());
    }

    #[test]
    fn modelo_verificado_en_la_lista() {
        let l = vec![codex(true, Some("0.162.1"), Some("x"), Some("model = \"gpt-6.1-sol\"")), claude(true, Some("2.1.296"), Some(CLAUDE_HELP), None)];
        assert_eq!(model_verified_in(&l, "codex", "gpt-6.1-sol"), Some(false));
        assert_eq!(model_verified_in(&l, "codex", "inventado"), Some(false));
        assert_eq!(model_verified_in(&l, "claude", "opus"), Some(true));
        assert_eq!(model_verified_in(&l, "gemini", "x"), None);
    }
}
