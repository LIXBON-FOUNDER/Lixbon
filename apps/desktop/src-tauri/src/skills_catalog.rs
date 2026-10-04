//! Catálogo de skills de Lixbon (Ajustes › Skills): instala el paquete zip que
//! descarga la web en la carpeta de skills de cada agente elegido.
//!
//! El paquete solo se acepta si su sha256 coincide con el que publicó el gateway,
//! y cada entrada debe quedar dentro de `<slug>/`. Junto al SKILL.md se deja
//! `.lixbon-skill.json` (slug, versión y sha256): así se sabe qué versión hay y
//! que esa carpeta es nuestra antes de reemplazarla o borrarla.

use std::io::Read;
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::orch::skill::{agent_dirs, home};

const MARKER: &str = ".lixbon-skill.json";
/// La marca de las skills que escribe el orquestador (`orquestar`, `adversary`).
const ORCH_MARKER: &str = "lxo-skill-version:";
/// Lo rellena el IDE al instalar: la ruta del `lxo` de esta instalación.
const LXO_PLACEHOLDER: &str = "{{LXO_BIN}}";
const MAX_UNPACKED: u64 = 50 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone)]
pub struct Marker {
    pub slug: String,
    pub version: String,
    pub sha256: String,
}

#[derive(Serialize)]
pub struct Installed {
    pub agent: String,
    pub version: Option<String>,
    /// Instalada por el orquestador o a mano: no viene del catálogo.
    pub external: bool,
}

#[derive(Serialize)]
pub struct Agent {
    pub id: String,
    pub label: String,
    pub detected: bool,
    pub dir: String,
}

fn valid_slug(slug: &str) -> bool {
    !slug.is_empty() && slug.len() <= 41 && slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !slug.starts_with('-')
}

fn read_marker(dir: &Path) -> Option<Marker> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(MARKER)).ok()?).ok()
}

fn ours(dir: &Path) -> bool {
    dir.join(MARKER).is_file()
        || std::fs::read_to_string(dir.join("SKILL.md")).is_ok_and(|t| t.contains(ORCH_MARKER))
}

/// Ruta relativa segura dentro de `<slug>/`, o None si la entrada se sale.
fn entry_path(name: &str, slug: &str) -> Option<PathBuf> {
    let rel = name.strip_prefix(slug)?.strip_prefix('/')?;
    let path = Path::new(rel);
    if rel.is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    Some(path.to_path_buf())
}

fn unpack(package: &[u8], slug: &str, dest: &Path, lxo: &str) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(package)).map_err(|e| format!("Paquete no válido: {e}"))?;
    let mut total = 0u64;
    let mut has_skill = false;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("Paquete no válido: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let rel = entry_path(entry.name(), slug).ok_or_else(|| format!("Entrada fuera de la skill: {}", entry.name()))?;
        let mut data = Vec::new();
        entry.by_ref().take(MAX_UNPACKED - total + 1).read_to_end(&mut data).map_err(|e| e.to_string())?;
        total += data.len() as u64;
        if total > MAX_UNPACKED {
            return Err("El paquete descomprimido es demasiado grande".into());
        }
        if rel.extension().is_some_and(|e| e == "md") {
            if let Ok(text) = String::from_utf8(data.clone()) {
                data = text.replace(LXO_PLACEHOLDER, lxo).into_bytes();
            }
        }
        has_skill |= rel == Path::new("SKILL.md");
        let file = dest.join(&rel);
        std::fs::create_dir_all(file.parent().unwrap_or(dest)).map_err(|e| e.to_string())?;
        std::fs::write(&file, data).map_err(|e| e.to_string())?;
    }
    if !has_skill {
        return Err("El paquete no trae SKILL.md".into());
    }
    Ok(())
}

pub fn install_in(home: &Path, slug: &str, marker: &Marker, package: &[u8], agents: &[String], force: bool,
                  lxo: &str) -> Result<Vec<String>, String> {
    if !valid_slug(slug) || marker.slug != slug {
        return Err("Nombre de skill no válido".into());
    }
    let digest = format!("{:x}", Sha256::digest(package));
    if !digest.eq_ignore_ascii_case(&marker.sha256) {
        return Err("La firma del paquete no coincide: descarga cancelada".into());
    }
    let mut done = vec![];
    for agent in agent_dirs(home).into_iter().filter(|a| agents.iter().any(|i| i == a.id)) {
        let dest = agent.dir.join(slug);
        if dest.exists() && !ours(&dest) && !force {
            return Err(format!("exists:{}", agent.label));
        }
        // Se descomprime al lado y se cambia al final: un fallo a medias no deja la skill rota.
        let tmp = agent.dir.join(format!(".{slug}.lixbon-tmp"));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| format!("{}: {e}", agent.label))?;
        if let Err(e) = unpack(package, slug, &tmp, lxo) {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
        std::fs::write(tmp.join(MARKER), serde_json::to_string_pretty(marker).unwrap_or_default())
            .map_err(|e| e.to_string())?;
        if dest.exists() {
            std::fs::remove_dir_all(&dest).map_err(|e| format!("{}: {e}", agent.label))?;
        }
        std::fs::rename(&tmp, &dest).map_err(|e| format!("{}: {e}", agent.label))?;
        done.push(agent.id.to_string());
    }
    Ok(done)
}

#[tauri::command]
pub fn skills_agents() -> Vec<Agent> {
    let Some(home) = home() else { return vec![] };
    agent_dirs(&home).into_iter().map(|a| Agent {
        id: a.id.into(), label: a.label.into(), detected: a.detected, dir: a.dir.to_string_lossy().into_owned(),
    }).collect()
}

/// Por cada slug pedido, en qué agentes está y con qué versión.
#[tauri::command]
pub fn skills_installed(slugs: Vec<String>) -> std::collections::HashMap<String, Vec<Installed>> {
    let mut out = std::collections::HashMap::new();
    let Some(home) = home() else { return out };
    let agents = agent_dirs(&home);
    for slug in slugs.into_iter().filter(|s| valid_slug(s)) {
        let found = agents.iter().filter_map(|a| {
            let dir = a.dir.join(&slug);
            dir.join("SKILL.md").is_file().then(|| {
                let marker = read_marker(&dir);
                Installed { agent: a.id.into(), external: marker.is_none(), version: marker.map(|m| m.version) }
            })
        }).collect();
        out.insert(slug, found);
    }
    out
}

#[tauri::command]
pub fn skill_install(slug: String, version: String, sha256: String, package_b64: String, agents: Vec<String>,
                     force: bool) -> Result<Vec<String>, String> {
    let package = base64::engine::general_purpose::STANDARD.decode(package_b64).map_err(|e| e.to_string())?;
    let home = home().ok_or("No se encontró la carpeta de usuario")?;
    let marker = Marker { slug: slug.clone(), version, sha256 };
    install_in(&home, &slug, &marker, &package, &agents, force, &crate::orch::lxo_path().to_string_lossy())
}

#[tauri::command]
pub fn skill_uninstall(slug: String, agents: Vec<String>) -> Result<(), String> {
    if !valid_slug(&slug) {
        return Err("Nombre de skill no válido".into());
    }
    let home = home().ok_or("No se encontró la carpeta de usuario")?;
    for agent in agent_dirs(&home).into_iter().filter(|a| agents.iter().any(|i| i == a.id)) {
        let dir = agent.dir.join(&slug);
        if dir.exists() && ours(&dir) {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", agent.label))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn package(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut buf);
            for (name, body) in entries {
                zw.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                zw.write_all(body.as_bytes()).unwrap();
            }
            zw.finish().unwrap();
        }
        buf.into_inner()
    }

    fn marker(slug: &str, pkg: &[u8]) -> Marker {
        Marker { slug: slug.into(), version: "1.0.0".into(), sha256: format!("{:x}", Sha256::digest(pkg)) }
    }

    fn home_tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lixbon-skills-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn instala_verifica_y_reemplaza_lxo() {
        let home = home_tmp("ok");
        let pkg = package(&[("demo/SKILL.md", "---\nname: demo\n---\nUsa `{{LXO_BIN}}`"), ("demo/refs/a.md", "x")]);
        let done = install_in(&home, "demo", &marker("demo", &pkg), &pkg, &["claude".into()], false, "C:/lxo.exe").unwrap();
        assert_eq!(done, vec!["claude"]);
        let dir = home.join(".claude/skills/demo");
        assert!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap().contains("Usa `C:/lxo.exe`"));
        assert!(dir.join("refs/a.md").is_file());
        assert_eq!(read_marker(&dir).unwrap().version, "1.0.0");
        skill_uninstall_in(&home, "demo");
        assert!(!dir.exists());
    }

    fn skill_uninstall_in(home: &Path, slug: &str) {
        for a in agent_dirs(home) {
            let dir = a.dir.join(slug);
            if dir.exists() && ours(&dir) {
                std::fs::remove_dir_all(dir).unwrap();
            }
        }
    }

    #[test]
    fn rechaza_firma_distinta_y_rutas_fuera() {
        let home = home_tmp("bad");
        let pkg = package(&[("demo/SKILL.md", "hola")]);
        let mut m = marker("demo", &pkg);
        m.sha256 = "0".repeat(64);
        assert!(install_in(&home, "demo", &m, &pkg, &["claude".into()], false, "lxo").unwrap_err().contains("firma"));
        let evil = package(&[("demo/SKILL.md", "x"), ("demo/../../evil.md", "x")]);
        assert!(install_in(&home, "demo", &marker("demo", &evil), &evil, &["claude".into()], false, "lxo").is_err());
        assert!(!home.join("evil.md").exists() && !home.join(".claude/evil.md").exists());
        assert!(!home.join(".claude/skills/demo").exists());
    }

    #[test]
    fn no_pisa_una_carpeta_ajena_sin_permiso() {
        let home = home_tmp("ajena");
        let dir = home.join(".claude/skills/demo");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), "mía").unwrap();
        let pkg = package(&[("demo/SKILL.md", "nueva")]);
        let err = install_in(&home, "demo", &marker("demo", &pkg), &pkg, &["claude".into()], false, "lxo").unwrap_err();
        assert_eq!(err, "exists:Claude Code");
        install_in(&home, "demo", &marker("demo", &pkg), &pkg, &["claude".into()], true, "lxo").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("SKILL.md")).unwrap(), "nueva");
    }
}
