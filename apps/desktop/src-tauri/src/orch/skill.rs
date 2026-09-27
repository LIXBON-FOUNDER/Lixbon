//! Instala la skill `lixbon-orquestador` en los agentes del sistema. Es un stub
//! (como las de Orca): la guía completa la imprime `lxo guide`, así nunca queda
//! desfasada respecto al binario que ejecuta los comandos.

use std::path::{Path, PathBuf};

use serde::Serialize;

pub const SKILL_NAME: &str = "lixbon-orquestador";
pub const SKILL_VERSION: u32 = 1;

struct Target {
    id: &'static str,
    label: &'static str,
    bins: &'static [&'static str],
    /// Carpeta que delata el agente instalado, relativa al home.
    config: &'static str,
    skills: &'static str,
}

const TARGETS: &[Target] = &[
    Target { id: "claude", label: "Claude Code", bins: &["claude"], config: ".claude", skills: ".claude/skills" },
    Target { id: "codex", label: "Codex", bins: &["codex"], config: ".codex", skills: ".codex/skills" },
    Target { id: "opencode", label: "OpenCode", bins: &["opencode"], config: ".config/opencode", skills: ".config/opencode/skills" },
    Target { id: "cursor", label: "Cursor", bins: &["cursor-agent"], config: ".cursor", skills: ".cursor/skills" },
    Target { id: "gemini", label: "Gemini CLI", bins: &["gemini"], config: ".gemini", skills: ".gemini/skills" },
    // Carpeta común que leen varios agentes (Codex, Amp…) además de la suya.
    Target { id: "agents", label: "Otros agentes (~/.agents)", bins: &[], config: ".agents", skills: ".agents/skills" },
];

#[derive(Serialize)]
pub struct Detected {
    pub id: String,
    pub label: String,
    pub bin: Option<String>,
    pub detected: bool,
    pub installed: bool,
    pub outdated: bool,
    pub path: String,
}

pub fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or(".EXE;.CMD;.BAT".into()).split(';').map(|e| e.to_ascii_lowercase()).collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        for ext in &exts {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn skill_file(home: &Path, t: &Target) -> PathBuf {
    home.join(t.skills).join(SKILL_NAME).join("SKILL.md")
}

fn installed_version(path: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(path).ok()?;
    let line = text.lines().find(|l| l.trim_start().starts_with("lxo-skill-version:"))?;
    line.split(':').nth(1)?.trim().parse().ok()
}

pub fn detect() -> Vec<Detected> {
    let Some(home) = home() else { return vec![] };
    TARGETS.iter().map(|t| {
        let bin = t.bins.iter().find_map(|b| which(b)).map(|p| p.to_string_lossy().into_owned());
        let file = skill_file(&home, t);
        let version = installed_version(&file);
        Detected {
            id: t.id.into(),
            label: t.label.into(),
            detected: bin.is_some() || home.join(t.config).is_dir(),
            bin,
            installed: version.is_some(),
            outdated: version.is_some_and(|v| v < SKILL_VERSION),
            path: file.to_string_lossy().into_owned(),
        }
    }).collect()
}

fn skill_md(lxo: &str) -> String {
    format!(
        r#"---
name: {SKILL_NAME}
description: >-
  Orquestador de agentes de Lixbon (lxo). Úsala para repartir trabajo entre varios agentes
  (Claude Code, Codex, OpenCode, Cursor, Lixbon…) cada uno en su rama y worktree, coordinarlos
  como padre, esperar sus fases y resultados, responder sus preguntas y fusionar sus ramas.
  Úsala también SIEMPRE que tu prompt diga que eres una tarea del orquestador de Lixbon, que
  exista la variable LXO_TASK_ID o que te pidan leer .lixbon/tasks/*.md. Frases típicas:
  "orquesta", "coordina agentes", "divide en subagentes", "lanza un hijo", "lxo".
metadata:
  lxo-skill-version: {SKILL_VERSION}
---

# Orquestador de Lixbon

Este archivo es solo el punto de entrada. La guía completa y actualizada la imprime el propio
binario, para que nunca se desfase de la versión instalada.

## 1. Localiza `lxo`

Usa, por este orden, el primero que exista y sigue usándolo para todos los comandos:

1. La variable de entorno `LXO_BIN`, que tienen los agentes que lanza Lixbon.
2. `{lxo}`
3. `lxo`, si está en el PATH.

Si falla con "Lixbon no está abierto" o "orquestador desactivado", díselo al usuario: tiene que
abrir Lixbon y activar Ajustes → Orquestador. No intentes simularlo con otros subagentes.

## 2. Carga la guía antes de hacer nada

```
lxo guide
```

Te indica tu papel: **coordinador** si no tienes `LXO_TASK_ID` o si vas a repartir trabajo, y
**tarea hija** si Lixbon te lanzó con una tarea asignada. Una hija también puede ser coordinadora
de sus propios hijos. Sigue la guía al pie de la letra y usa siempre `--json` cuando necesites
leer la salida.
"#
    )
}

pub fn install(ids: &[String], lxo: &str) -> Result<Vec<String>, String> {
    let home = home().ok_or("No se encontró la carpeta de usuario")?;
    let mut done = vec![];
    for t in TARGETS.iter().filter(|t| ids.iter().any(|i| i == t.id)) {
        let file = skill_file(&home, t);
        std::fs::create_dir_all(file.parent().unwrap_or(&home)).map_err(|e| format!("{}: {e}", t.label))?;
        std::fs::write(&file, skill_md(lxo)).map_err(|e| format!("{}: {e}", t.label))?;
        done.push(t.id.to_string());
    }
    Ok(done)
}

pub fn uninstall(ids: &[String]) -> Result<(), String> {
    let home = home().ok_or("No se encontró la carpeta de usuario")?;
    for t in TARGETS.iter().filter(|t| ids.iter().any(|i| i == t.id)) {
        let dir = home.join(t.skills).join(SKILL_NAME);
        // Solo se borra lo que es nuestro: una carpeta con ese nombre y sin marca se respeta.
        if installed_version(&dir.join("SKILL.md")).is_some() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("{}: {e}", t.label))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_skill_lleva_version_y_ruta() {
        let md = skill_md("C:/Lixbon/lxo.exe");
        assert!(md.contains("name: lixbon-orquestador"));
        assert!(md.contains("C:/Lixbon/lxo.exe"));
        let dir = std::env::temp_dir().join(format!("lxo-skill-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("SKILL.md");
        std::fs::write(&f, md).unwrap();
        assert_eq!(installed_version(&f), Some(SKILL_VERSION));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
