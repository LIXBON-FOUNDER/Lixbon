//! Roles del equipo: el usuario decide en Ajustes qué modelo y qué esfuerzo usa
//! cada uno, y el coordinador lanza hijas por rol (`lxo spawn --role …`) sin
//! elegir modelo. Así lo barato (leer, buscar) va a un modelo barato y lo caro
//! solo se usa cuando hace falta. Cada rol elige su proveedor (claude o codex);
//! los roles guardados antes de existir el campo siguen en Claude.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::agents;
use super::providers::{self, Provider};

/// Proveedor de los roles que no dicen otro (y de los guardados sin el campo).
pub const DEFAULT_PROVIDER: &str = "claude";

fn default_provider() -> String {
    DEFAULT_PROVIDER.into()
}

pub struct RoleSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub purpose: &'static str,
    /// Solo lectura: trabaja en la carpeta del coordinador y sin herramientas de edición.
    pub read_only: bool,
    pub model: &'static str,
    pub effort: &'static str,
}

pub const ROLES: &[RoleSpec] = &[
    RoleSpec { id: "explorador", label: "Explorador", read_only: true, model: "haiku", effort: "",
        purpose: "Busca y lee código, investiga y resume. No edita archivos." },
    RoleSpec { id: "implementador", label: "Implementador", read_only: false, model: "sonnet", effort: "medium",
        purpose: "Programa el encargo en su propia rama y worktree, con tests." },
    RoleSpec { id: "revisor", label: "Revisor", read_only: true, model: "opus", effort: "medium",
        purpose: "Revisa el diff de otra hija y busca fallos. No edita archivos." },
    RoleSpec { id: "escalado", label: "Escalado", read_only: false, model: "opus", effort: "high",
        purpose: "Retoma lo que el implementador no resolvió tras dos intentos." },
    RoleSpec { id: "adversario", label: "Adversario", read_only: true, model: "opus", effort: "high",
        purpose: "Busca cómo se rompe lo que hizo otro: casos límite, errores ocultos, suposiciones sin justificar. No edita archivos." },
];

pub fn spec(id: &str) -> Option<&'static RoleSpec> {
    ROLES.iter().find(|r| r.id == id)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct RoleCfg {
    /// `claude` | `codex`. Falta en los settings viejos: `claude`.
    #[serde(default = "default_provider")]
    pub provider: String,
    pub model: String,
    pub effort: String,
}

impl Default for RoleCfg {
    fn default() -> Self {
        RoleCfg { provider: default_provider(), model: String::new(), effort: String::new() }
    }
}

pub fn defaults() -> BTreeMap<String, RoleCfg> {
    ROLES.iter().map(|r| (r.id.to_string(), RoleCfg { provider: default_provider(), model: r.model.into(), effort: r.effort.into() })).collect()
}

/// Rol ya resuelto: lo que se lanza de verdad.
pub struct Resolved {
    pub spec: &'static RoleSpec,
    pub provider: String,
    /// `None`: sin `--model` (Codex con su modelo de config.toml).
    pub model: Option<String>,
    pub effort: Option<String>,
}

/// Configuración del usuario para `id`, con los valores por defecto donde falten.
pub fn resolve(cfg: &BTreeMap<String, RoleCfg>, id: &str) -> Result<Resolved, String> {
    let spec = spec(id).ok_or_else(|| {
        format!("Rol desconocido: {id}. Usa uno de: {}", ROLES.iter().map(|r| r.id).collect::<Vec<_>>().join(", "))
    })?;
    let user = cfg.get(id);
    let provider = user.map(|c| c.provider.trim()).filter(|p| !p.is_empty()).unwrap_or(DEFAULT_PROVIDER).to_string();
    if !providers::IDS.contains(&provider.as_str()) {
        return Err(format!("{}: proveedor desconocido {provider}. Usa uno de: {}", spec.label, providers::IDS.join(", ")));
    }
    let claude = provider == DEFAULT_PROVIDER;
    let user_model = user.map(|c| c.model.trim()).filter(|m| !m.is_empty());
    // Los modelos por defecto son alias de Claude: con otro proveedor no se heredan.
    let model = user_model.map(str::to_string).or_else(|| claude.then(|| spec.model.to_string()));
    let effort = match user {
        Some(c) => c.effort.trim().to_string(),
        None if claude => spec.effort.to_string(),
        None => String::new(),
    };
    Ok(Resolved { spec, provider, model, effort: Some(effort).filter(|e| !e.is_empty()) })
}

/// Proveedor al que pertenece un id de modelo, por su forma (alias o prefijo).
fn model_owner(model: &str) -> Option<&'static str> {
    let m = model.to_ascii_lowercase();
    if ["opus", "sonnet", "haiku", "fable"].contains(&m.as_str()) || m.starts_with("claude") {
        return Some("claude");
    }
    if m.starts_with("gpt-") || m.starts_with("codex") || (m.len() > 1 && m.starts_with('o') && m[1..2].chars().all(|c| c.is_ascii_digit())) {
        return Some("codex");
    }
    None
}

/// Avisos por rol (solo los que tienen), con el mismo texto que `warnings` de
/// `orch_resolve_policy`.
pub type Warnings = BTreeMap<String, Vec<String>>;

/// Respuesta de guardar los roles: `{ ok, warnings: { rol: [...] }, snapshot }`.
pub fn save_response(warnings: &Warnings, snapshot: Value) -> Value {
    json!({ "ok": true, "warnings": warnings, "snapshot": snapshot })
}

/// Revisa modelo y esfuerzo contra la lista de proveedores. Rechaza un modelo de
/// otro proveedor; uno que la lista no trae (o trae con `verified: false`) solo
/// queda como aviso de `unverified`. Devuelve los avisos por rol.
pub fn validate_with(cfg: &BTreeMap<String, RoleCfg>, list: &[Provider]) -> Result<Warnings, String> {
    let mut all = Warnings::new();
    for r in ROLES {
        let res = resolve(cfg, r.id)?;
        agents::launch(&res.provider, res.model.as_deref(), res.effort.as_deref(), "x", agents::Profile::for_role(r.read_only), Some(r.id))
            .map_err(|e| format!("{}: {e}", r.label))?;
        let mine = list.iter().find(|p| p.id == res.provider);
        let mut notes: Vec<String> = vec![];
        // Mismo aviso que orch_resolve_policy para Claude en plan con un modelo que no es Sonnet.
        let mut pol = agents::evaluate_for(&res.provider, agents::Profile::for_role(r.read_only), Some(r.id), ".", agents::Detected::Skip, false, agents::Delivery::FileOrMarkers);
        pol.warnings.clear();
        agents::warn_plan_model(&mut pol, res.model.as_deref());
        notes.extend(pol.warnings);
        if let Some(m) = res.model.as_deref() {
            let in_mine = mine.is_some_and(|p| p.models.iter().any(|x| x.id == m));
            let other = list.iter().filter(|p| p.id != res.provider).any(|p| p.models.iter().any(|x| x.id == m))
                || model_owner(m).is_some_and(|o| o != res.provider);
            if !in_mine && other {
                return Err(format!("{}: el modelo {m} no es de {}", r.label, res.provider));
            }
            if let Some(p) = mine {
                if !p.models.iter().any(|x| x.id == m && x.verified) {
                    notes.push(format!("{} ({m})", agents::WARN_MODEL_UNVERIFIED));
                }
            }
        }
        // Sandbox elevado de Codex: el read-only queda bloqueado; Delegar avisa y pide confirmación.
        if let Some(p) = mine.filter(|p| p.sandbox_elevated) {
            let profile = agents::Profile::for_role(r.read_only);
            if agents::codex_exec(&res.provider, profile) {
                notes.push(agents::ELEVATED.into());
            } else if agents::codex_elevated_warns(&p.id, profile) {
                notes.push(agents::WARN_ELEVATED_RW.into());
            }
        }
        if let (Some(e), Some(p)) = (res.effort.as_deref(), mine) {
            if !p.efforts.is_empty() && !p.efforts.iter().any(|x| x == e) {
                notes.push(format!("{} ({e})", agents::WARN_EFFORT_UNVERIFIED));
            }
        }
        if !notes.is_empty() {
            all.insert(r.id.to_string(), notes);
        }
    }
    Ok(all)
}

/// Rechaza al guardar un modelo o esfuerzo que luego no se podría lanzar, con
/// la lista de `orch_list_providers` (en las pruebas, sin consultar ninguna CLI).
pub fn validate(cfg: &BTreeMap<String, RoleCfg>) -> Result<Warnings, String> {
    let list = if cfg!(test) { vec![] } else { providers::list(false) };
    validate_with(cfg, &list)
}

/// Lo que ve el coordinador con `lxo roles`.
pub fn describe(cfg: &BTreeMap<String, RoleCfg>) -> Value {
    let list: Vec<Value> = ROLES.iter().filter_map(|r| {
        let res = resolve(cfg, r.id).ok()?;
        Some(json!({
            "id": r.id, "label": r.label, "purpose": r.purpose, "read_only": r.read_only,
            "agent": res.provider, "model": res.model, "effort": res.effort,
        }))
    }).collect();
    json!({ "roles": list })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resuelve_con_defaults_y_config() {
        let mut cfg = BTreeMap::new();
        let r = resolve(&cfg, "explorador").unwrap();
        assert_eq!((r.model.as_deref(), r.effort), (Some("haiku"), None));
        assert!(r.spec.read_only);
        cfg.insert("implementador".into(), RoleCfg { model: "opus".into(), effort: "high".into(), ..Default::default() });
        let r = resolve(&cfg, "implementador").unwrap();
        assert_eq!((r.model.as_deref(), r.effort.as_deref()), (Some("opus"), Some("high")));
        // Un esfuerzo vacío guardado a propósito significa «sin --effort».
        cfg.insert("revisor".into(), RoleCfg { model: String::new(), effort: String::new(), ..Default::default() });
        let r = resolve(&cfg, "revisor").unwrap();
        assert_eq!((r.model.as_deref(), r.effort), (Some("opus"), None));
        assert!(resolve(&cfg, "planner").is_err());
    }

    #[test]
    fn el_adversario_es_opus_high_y_solo_lectura() {
        let r = resolve(&BTreeMap::new(), "adversario").unwrap();
        assert_eq!((r.model.as_deref(), r.effort.as_deref()), (Some("opus"), Some("high")));
        assert!(r.spec.read_only);
        assert!(defaults().contains_key("adversario"));
    }

    #[test]
    fn valida_lo_que_se_guarda() {
        assert!(validate(&defaults()).is_ok());
        let mut cfg = defaults();
        cfg.insert("explorador".into(), RoleCfg { model: "haiku & del".into(), effort: String::new(), ..Default::default() });
        assert!(validate(&cfg).is_err());
        let mut cfg = defaults();
        cfg.insert("explorador".into(), RoleCfg { model: "haiku".into(), effort: "turbo".into(), ..Default::default() });
        assert!(validate(&cfg).is_err());
    }

    fn codex_list() -> Vec<Provider> {
        vec![
            providers::claude(true, Some("2.1.296"), Some(include_str!("testdata/claude-2.1.296-help.txt")), None),
            providers::codex(true, Some("0.162.1"), Some(include_str!("testdata/codex-0.162.1-debug-models.json")), None),
        ]
    }

    #[test]
    fn guardar_con_sandbox_elevado() {
        let toml = "[windows]\nsandbox = \"elevated\"\n";
        let list = vec![
            providers::claude(true, Some("2.1.296"), Some(include_str!("testdata/claude-2.1.296-help.txt")), None),
            providers::codex(true, Some("0.162.1"), Some(include_str!("testdata/codex-0.162.1-debug-models.json")), Some(toml)),
        ];
        let mut cfg = codex_cfg("implementador", "gpt-6.1-sol", "high");
        cfg.insert("escalado".into(), RoleCfg { provider: "codex".into(), model: "gpt-6.1-sol".into(), effort: "high".into() });
        cfg.insert("revisor".into(), RoleCfg { provider: "codex".into(), model: "gpt-6.1-sol".into(), effort: "high".into() });
        let w = validate_with(&cfg, &list).unwrap();
        for r in ["implementador", "escalado"] {
            assert!(w[r].iter().any(|x| x == agents::WARN_ELEVATED_RW), "{r}: {:?}", w.get(r));
        }
        assert!(w["revisor"].iter().any(|x| x == agents::ELEVATED));
        assert!(!w["revisor"].iter().any(|x| x == agents::WARN_ELEVATED_RW));
        // Roles de Claude no reciben el aviso.
        assert!(w.get("explorador").is_none_or(|v| !v.iter().any(|x| x == agents::WARN_ELEVATED_RW)));
    }

    fn codex_cfg(role: &str, model: &str, effort: &str) -> BTreeMap<String, RoleCfg> {
        let mut cfg = defaults();
        cfg.insert(role.into(), RoleCfg { provider: "codex".into(), model: model.into(), effort: effort.into() });
        cfg
    }

    #[test]
    fn guarda_y_lee_el_proveedor() {
        // Settings viejos, sin el campo: Claude.
        let old: BTreeMap<String, RoleCfg> = serde_json::from_str(r#"{"explorador":{"model":"haiku","effort":""}}"#).unwrap();
        assert_eq!(old["explorador"].provider, "claude");
        assert_eq!(resolve(&old, "explorador").unwrap().provider, "claude");
        let cfg = codex_cfg("implementador", "gpt-6.1-sol", "ultra");
        let text = serde_json::to_string(&cfg).unwrap();
        let back: BTreeMap<String, RoleCfg> = serde_json::from_str(&text).unwrap();
        assert_eq!(back, cfg);
        assert_eq!(back["implementador"].provider, "codex");
        let d = describe(&back);
        let imp = d["roles"].as_array().unwrap().iter().find(|r| r["id"] == "implementador").unwrap();
        assert_eq!((imp["agent"].as_str(), imp["model"].as_str()), (Some("codex"), Some("gpt-6.1-sol")));
        // Codex sin modelo elegido: no hereda el alias de Claude ni se inventa uno.
        let r = resolve(&codex_cfg("revisor", "", ""), "revisor").unwrap();
        assert_eq!((r.model.clone(), r.effort.clone()), (None, None));
        let mut p = agents::evaluate_for("codex", agents::Profile::for_role(true), Some("revisor"), "wt", agents::Detected::Skip, false, agents::Delivery::FileOrMarkers);
        agents::set_model(&mut p, r.model.as_deref());
        assert_eq!(p.model.as_deref(), Some(agents::MODEL_FROM_CONFIG));
        let l = agents::launch_with(&p, r.model.as_deref(), None, "x").unwrap();
        assert!(!l.command.contains("--model"), "{}", l.command);
        agents::set_model(&mut p, Some("gpt-6.1-sol"));
        assert_eq!(p.model.as_deref(), Some("gpt-6.1-sol"));
        let mut c = agents::evaluate("claude", agents::Profile::Explorar, "wt", agents::Detected::Skip, false);
        agents::set_model(&mut c, None);
        assert_eq!(c.model, None);
        let mut bad = defaults();
        bad.insert("revisor".into(), RoleCfg { provider: "gemini".into(), ..Default::default() });
        assert!(resolve(&bad, "revisor").is_err());
    }

    #[test]
    fn valida_contra_los_proveedores() {
        let l = codex_list();
        // gpt-* con ultra en Codex: pasa sin avisos para ese rol.
        let w = validate_with(&codex_cfg("implementador", "gpt-6.1-sol", "ultra"), &l).unwrap();
        assert!(!w.contains_key("implementador"), "{w:?}");
        // Modelo que la lista no trae: unverified, no rechazado.
        let w = validate_with(&codex_cfg("implementador", "gpt-9-nuevo", "high"), &l).unwrap();
        assert_eq!(w["implementador"], vec![format!("{} (gpt-9-nuevo)", agents::WARN_MODEL_UNVERIFIED)]);
        // Modelo de otro proveedor: rechazado.
        let e = validate_with(&codex_cfg("implementador", "opus", "high"), &l).unwrap_err();
        assert!(e.contains("opus no es de codex"), "{e}");
        let mut c = defaults();
        c.insert("implementador".into(), RoleCfg { provider: "claude".into(), model: "gpt-6.1-sol".into(), effort: "high".into() });
        assert!(validate_with(&c, &l).unwrap_err().contains("no es de claude"));
        // Sin lista (no se pudo consultar): solo la forma.
        assert!(validate_with(&codex_cfg("implementador", "opus", ""), &[]).is_err());
        assert!(validate_with(&defaults(), &l).is_ok());
    }

    #[test]
    fn guardar_devuelve_avisos_solo_de_los_roles_que_los_tienen() {
        let l = codex_list();
        let mut cfg = defaults();
        cfg.insert("implementador".into(), RoleCfg { provider: "codex".into(), model: "gpt-9-nuevo".into(), effort: "high".into() });
        let w = validate_with(&cfg, &l).unwrap();
        // Explorador (plan) con haiku: aviso de Sonnet en plan y haiku no listado en el --help de Claude 2.1.296.
        assert_eq!(w["explorador"], vec![agents::WARN_PLAN_SONNET.to_string(), format!("{} (haiku)", agents::WARN_MODEL_UNVERIFIED)]);
        assert_eq!(w["implementador"], vec![format!("{} (gpt-9-nuevo)", agents::WARN_MODEL_UNVERIFIED)]);
        // Escalado (opus, edita): sin avisos, no aparece.
        assert!(!w.contains_key("escalado"));
        let v = save_response(&w, json!({"runs": []}));
        assert_eq!(v["ok"], true);
        assert!(v["warnings"]["implementador"].is_array());
        assert!(v["warnings"].get("escalado").is_none());
        assert!(v["snapshot"].is_object());
        let v = save_response(&Warnings::new(), json!({}));
        assert_eq!(v["warnings"], json!({}));
    }

    #[test]
    fn argv_de_codex_para_un_rol() {
        let cfg = codex_cfg("explorador", "gpt-6.1-sol", "high");
        let r = resolve(&cfg, "explorador").unwrap();
        assert!(r.spec.read_only);
        let profile = agents::Profile::for_role(r.spec.read_only);
        let p = agents::evaluate_for(&r.provider, profile, Some("explorador"), "wt", agents::Detected::Skip, false, agents::Delivery::FileOrMarkers);
        // Solo lectura con Codex: el perfil read-only (codex exec, sandbox read-only) y sus avisos.
        assert_eq!(&p.argv[..2], ["codex", "exec"]);
        assert!(p.argv.windows(2).any(|w| w == ["--sandbox", "read-only"]), "{:?}", p.argv);
        assert!(!p.interactive);
        assert!(p.warnings.iter().any(|w| w == agents::WARN_CODEX_BIG));
        let l = agents::launch_with(&p, r.model.as_deref(), r.effort.as_deref(), "x").unwrap();
        assert!(l.command.contains("--model gpt-6.1-sol") && l.command.contains("-c model_reasoning_effort=high"), "{}", l.command);
        // Un rol que edita con Codex no usa read-only.
        let cfg = codex_cfg("implementador", "gpt-6.1-sol", "ultra");
        let r = resolve(&cfg, "implementador").unwrap();
        let p = agents::evaluate_for(&r.provider, agents::Profile::for_role(false), Some("implementador"), "wt", agents::Detected::Skip, false, agents::Delivery::FileOrMarkers);
        assert!(!p.argv.iter().any(|a| a == "read-only"));
        assert!(agents::launch_with(&p, r.model.as_deref(), r.effort.as_deref(), "x").unwrap().command.contains("model_reasoning_effort=ultra"));
    }
}
