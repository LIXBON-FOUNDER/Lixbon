//! Roles del equipo: el usuario decide en Ajustes qué modelo y qué esfuerzo usa
//! cada uno, y el coordinador lanza hijas por rol (`lxo spawn --role …`) sin
//! elegir modelo. Así lo barato (leer, buscar) va a un modelo barato y lo caro
//! solo se usa cuando hace falta. Por ahora todos los roles corren en Claude Code.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::agents;

/// Agente con el que se lanzan todos los roles.
pub const AGENT: &str = "claude";

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
];

pub fn spec(id: &str) -> Option<&'static RoleSpec> {
    ROLES.iter().find(|r| r.id == id)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct RoleCfg {
    pub model: String,
    pub effort: String,
}

pub fn defaults() -> BTreeMap<String, RoleCfg> {
    ROLES.iter().map(|r| (r.id.to_string(), RoleCfg { model: r.model.into(), effort: r.effort.into() })).collect()
}

/// Rol ya resuelto: lo que se lanza de verdad.
pub struct Resolved {
    pub spec: &'static RoleSpec,
    pub model: String,
    pub effort: Option<String>,
}

/// Configuración del usuario para `id`, con los valores por defecto donde falten.
pub fn resolve(cfg: &BTreeMap<String, RoleCfg>, id: &str) -> Result<Resolved, String> {
    let spec = spec(id).ok_or_else(|| {
        format!("Rol desconocido: {id}. Usa uno de: {}", ROLES.iter().map(|r| r.id).collect::<Vec<_>>().join(", "))
    })?;
    let user = cfg.get(id);
    let model = user.map(|c| c.model.trim()).filter(|m| !m.is_empty()).unwrap_or(spec.model).to_string();
    let effort = match user {
        Some(c) => c.effort.trim().to_string(),
        None => spec.effort.to_string(),
    };
    Ok(Resolved { spec, model, effort: Some(effort).filter(|e| !e.is_empty()) })
}

/// Rechaza al guardar un modelo o esfuerzo que luego no se podría lanzar.
pub fn validate(cfg: &BTreeMap<String, RoleCfg>) -> Result<(), String> {
    for r in ROLES {
        let res = resolve(cfg, r.id)?;
        agents::launch(AGENT, Some(&res.model), res.effort.as_deref(), "x", r.read_only)
            .map_err(|e| format!("{}: {e}", r.label))?;
    }
    Ok(())
}

/// Lo que ve el coordinador con `lxo roles`.
pub fn describe(cfg: &BTreeMap<String, RoleCfg>) -> Value {
    let list: Vec<Value> = ROLES.iter().filter_map(|r| {
        let res = resolve(cfg, r.id).ok()?;
        Some(json!({
            "id": r.id, "label": r.label, "purpose": r.purpose, "read_only": r.read_only,
            "agent": AGENT, "model": res.model, "effort": res.effort,
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
        assert_eq!((r.model.as_str(), r.effort), ("haiku", None));
        assert!(r.spec.read_only);
        cfg.insert("implementador".into(), RoleCfg { model: "opus".into(), effort: "high".into() });
        let r = resolve(&cfg, "implementador").unwrap();
        assert_eq!((r.model.as_str(), r.effort.as_deref()), ("opus", Some("high")));
        // Un esfuerzo vacío guardado a propósito significa «sin --effort».
        cfg.insert("revisor".into(), RoleCfg { model: String::new(), effort: String::new() });
        let r = resolve(&cfg, "revisor").unwrap();
        assert_eq!((r.model.as_str(), r.effort), ("opus", None));
        assert!(resolve(&cfg, "planner").is_err());
    }

    #[test]
    fn valida_lo_que_se_guarda() {
        assert!(validate(&defaults()).is_ok());
        let mut cfg = defaults();
        cfg.insert("explorador".into(), RoleCfg { model: "haiku & del".into(), effort: String::new() });
        assert!(validate(&cfg).is_err());
        let mut cfg = defaults();
        cfg.insert("explorador".into(), RoleCfg { model: "haiku".into(), effort: "turbo".into() });
        assert!(validate(&cfg).is_err());
    }
}
