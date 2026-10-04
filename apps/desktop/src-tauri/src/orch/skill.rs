//! Instala las skills `orquestar` y `adversary` en los agentes del sistema. Son
//! stubs (como las de Orca): la guía completa la imprime `lxo guide`, así nunca
//! queda desfasada respecto al binario que ejecuta los comandos.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// Nombre de la primera versión de `orquestar`; se retira al instalar la nueva.
const OLD_NAME: &str = "lixbon-orquestador";

/// Como skill, su nombre es también el comando: `/orquestar <objetivo>`.
struct Skill {
    name: &'static str,
    version: u32,
    md: fn(&str) -> String,
}

const SKILLS: &[Skill] = &[
    Skill { name: "orquestar", version: 4, md: orquestar_md },
    Skill { name: "adversary", version: 1, md: adversary_md },
];

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

/// Carpeta de skills de cada agente conocido, para el catálogo (Ajustes › Skills).
pub(crate) struct AgentDir {
    pub id: &'static str,
    pub label: &'static str,
    pub dir: PathBuf,
    pub detected: bool,
}

pub(crate) fn agent_dirs(home: &Path) -> Vec<AgentDir> {
    TARGETS.iter().map(|t| AgentDir {
        id: t.id,
        label: t.label,
        dir: home.join(t.skills),
        detected: t.bins.iter().any(|b| which(b).is_some()) || home.join(t.config).is_dir(),
    }).collect()
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

fn skill_file(home: &Path, t: &Target, skill: &Skill) -> PathBuf {
    home.join(t.skills).join(skill.name).join("SKILL.md")
}

fn installed_version(path: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(path).ok()?;
    let line = text.lines().find(|l| l.trim_start().starts_with("lxo-skill-version:"))?;
    line.split(':').nth(1)?.trim().parse().ok()
}

/// `lxo` es la ruta del binario de este Lixbon: una skill escrita por otra
/// instalación (o por una versión de desarrollo) apunta a otro y se reescribe.
pub fn detect(lxo: &str) -> Vec<Detected> {
    let Some(home) = home() else { return vec![] };
    TARGETS.iter().map(|t| {
        let bin = t.bins.iter().find_map(|b| which(b)).map(|p| p.to_string_lossy().into_owned());
        let file = skill_file(&home, t, &SKILLS[0]);
        let versions: Vec<Option<u32>> = SKILLS.iter().map(|k| installed_version(&skill_file(&home, t, k))).collect();
        let stale_path = SKILLS.iter().any(|k| {
            let f = skill_file(&home, t, k);
            installed_version(&f).is_some() && !std::fs::read_to_string(&f).is_ok_and(|c| c.contains(lxo))
        });
        let old = installed_version(&home.join(t.skills).join(OLD_NAME).join("SKILL.md")).is_some();
        let any = versions.iter().any(Option::is_some);
        Detected {
            id: t.id.into(),
            label: t.label.into(),
            detected: bin.is_some() || home.join(t.config).is_dir(),
            bin,
            installed: any || old,
            outdated: old || stale_path || (any && SKILLS.iter().zip(&versions).any(|(k, v)| v.is_none_or(|v| v < k.version))),
            path: file.to_string_lossy().into_owned(),
        }
    }).collect()
}

fn orquestar_md(lxo: &str) -> String {
    let (name, version) = (SKILLS[0].name, SKILLS[0].version);
    format!(
        r#"---
name: {name}
description: >-
  Orquestador de agentes de Lixbon. Con "/orquestar <objetivo>" te conviertes en el COORDINADOR:
  repartes el objetivo entre agentes hijos de Claude Code según los roles que configuró el usuario
  (explorador, implementador, revisor, escalado), esperas sus informes, integras sus ramas y le
  cuentas al usuario el resultado; si el objetivo cita una issue de Lixbon Team (LXB-12), la
  lees, la mueves y dejas el resultado en ella con lxo issue. Úsala cuando el usuario escriba /orquestar, diga "orquesta",
  "coordina agentes", "reparte esta tarea", "lanza el equipo" o "lxo". Úsala también SIEMPRE que
  exista la variable LXO_TASK_ID o tu prompt diga que eres una tarea del orquestador de Lixbon:
  entonces eres una tarea hija y sigues la guía de hija.
argument-hint: <objetivo>
metadata:
  lxo-skill-version: {version}
---

# Orquestador de Lixbon

Este archivo es solo el punto de entrada: la guía completa la imprime el propio binario, así
nunca se desfasa de la versión instalada.

## 1. Localiza `lxo`

Usa el primero que exista y sigue usándolo para todos los comandos:

1. La variable de entorno `LXO_BIN` (la tienen las tareas hijas que lanza Lixbon).
2. `{lxo}`
3. `lxo`, si está en el PATH.

Si responde "Lixbon no está abierto" o "orquestador desactivado", díselo al usuario: tiene que
abrir Lixbon y activar Ajustes → Orquestador. No lo simules con otros subagentes.

## 2. Carga tu guía antes de hacer nada

```
lxo guide
```

- Sin `LXO_TASK_ID`: eres el **coordinador**. El texto que acompaña a /orquestar es el objetivo.
  Tú no implementas: repartes, esperas los informes, integras y respondes al usuario.
- Con `LXO_TASK_ID`: eres una **tarea hija**. Haz solo tu encargo y entrega tu informe.

Sigue la guía al pie de la letra y añade `--json` cuando necesites leer la salida.
"#
    )
}

fn adversary_md(lxo: &str) -> String {
    let (name, version) = (SKILLS[1].name, SKILLS[1].version);
    format!(
        r#"---
name: {name}
description: >-
  Revisor adversarial de Lixbon. Con "/adversary <qué atacar>" lanzas un agente hijo con el rol
  adversario, que no intenta demostrar que algo funciona sino encontrar cómo se rompe (casos
  límite, errores ocultos, vulnerabilidades, suposiciones sin justificar), y respondes a cada
  uno de sus hallazgos: corriges o justificas. Úsala cuando el usuario escriba /adversary, pida
  "un adversario", "ataca esto", "busca cómo se rompe" o "revisión adversarial".
argument-hint: <qué atacar>
metadata:
  lxo-skill-version: {version}
---

# Adversario de Lixbon

El adversario es solo lectura: puede ejecutar tests y comandos para demostrar fallos, pero no edita.
Su informe es una lista de hallazgos numerados por gravedad, cada uno con escenario, evidencia y
la pregunta que tú, como creador, debes responder.

## 1. Localiza `lxo`

Usa el primero que exista y sigue usándolo para todos los comandos:

1. La variable de entorno `LXO_BIN` (la tienen las tareas hijas que lanza Lixbon).
2. `{lxo}`
3. `lxo`, si está en el PATH.

Si responde "Lixbon no está abierto" o "orquestador desactivado", díselo al usuario: tiene que
abrir Lixbon y activar Ajustes → Orquestador. No lo simules con otros subagentes.

## 2. Lanza al adversario

1. `lxo status`. Si dice que no eres una tarea, crea un run:
   `lxo run create --objective "Revisión adversarial: <qué se ataca>" --agent <tu agente>`.
   Si eres una tarea hija (`LXO_TASK_ID`), mira `lxo status --json`: con `can_spawn` puedes lanzarlo
   como hija tuya; si no, pídeselo a tu coordinador con `lxo ask`.
2. Haz commit de lo que deba ver: parte de tu último commit, no de los cambios sin guardar.
3. Lánzalo con un encargo autocontenido (él no ve tu conversación):
   ```
   lxo spawn --role adversario --name "Adversario <tema>" --task "<qué atacar: diff (git diff <base>...<rama>), rama o archivos; contexto; decisiones tomadas y por qué>"
   ```
4. `lxo wait --timeout-ms 540000` hasta que llegue su informe; léelo entero.

## 3. Responde a cada hallazgo

Por cada hallazgo, corrígelo (con un test que lo cubra) o justifica por qué no aplica. No ignores
ninguno ni te quedes con el primero. Si el creador es otra hija, pásale los hallazgos con
`lxo continue <tarea>`.

Máximo **dos rondas** adversario → creador: tras corregir puedes pedirle una segunda pasada con el
diff nuevo. Lo que siga sin resolverse, cuéntaselo al usuario.

## 4. Informa al usuario

Qué hallazgos se corrigieron, cuáles se descartaron y por qué, y qué queda abierto.
Si creaste el run en el paso 2, ciérralo con `lxo run close`.
"#
    )
}

pub fn install(ids: &[String], lxo: &str) -> Result<Vec<String>, String> {
    install_in(&home().ok_or("No se encontró la carpeta de usuario")?, ids, lxo)
}

fn install_in(home: &Path, ids: &[String], lxo: &str) -> Result<Vec<String>, String> {
    let mut done = vec![];
    for t in TARGETS.iter().filter(|t| ids.iter().any(|i| i == t.id)) {
        for k in SKILLS {
            let file = skill_file(home, t, k);
            std::fs::create_dir_all(file.parent().unwrap_or(home)).map_err(|e| format!("{}: {e}", t.label))?;
            std::fs::write(&file, (k.md)(lxo)).map_err(|e| format!("{}: {e}", t.label))?;
        }
        remove_ours(&home.join(t.skills).join(OLD_NAME));
        done.push(t.id.to_string());
    }
    Ok(done)
}

pub fn uninstall(ids: &[String]) -> Result<(), String> {
    let home = home().ok_or("No se encontró la carpeta de usuario")?;
    for t in TARGETS.iter().filter(|t| ids.iter().any(|i| i == t.id)) {
        for k in SKILLS {
            remove_ours(&home.join(t.skills).join(k.name));
        }
        remove_ours(&home.join(t.skills).join(OLD_NAME));
    }
    Ok(())
}

/// Solo se borra lo que es nuestro: una carpeta con ese nombre y sin marca se respeta.
fn remove_ours(dir: &Path) {
    if installed_version(&dir.join("SKILL.md")).is_some() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Al arrancar, las instalaciones antiguas se ponen al día solas.
pub fn refresh_outdated(lxo: &str) {
    let ids: Vec<String> = detect(lxo).into_iter().filter(|a| a.outdated).map(|a| a.id).collect();
    if !ids.is_empty() {
        let _ = install(&ids, lxo);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LXO: &str = "C:/Lixbon/lxo.exe";

    #[test]
    fn las_skills_llevan_nombre_version_y_ruta() {
        let dir = std::env::temp_dir().join(format!("lxo-skill-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for k in SKILLS {
            let md = (k.md)(LXO);
            assert!(md.contains(&format!("name: {}", k.name)));
            assert!(md.contains(LXO));
            let f = dir.join(format!("{}.md", k.name));
            std::fs::write(&f, md).unwrap();
            assert_eq!(installed_version(&f), Some(k.version));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn instala_y_retira_ambas_skills() {
        let home = std::env::temp_dir().join(format!("lxo-skill-home-{}", std::process::id()));
        let ids = vec!["claude".to_string()];
        install_in(&home, &ids, LXO).unwrap();
        let t = &TARGETS[0];
        for k in SKILLS {
            let f = skill_file(&home, t, k);
            assert_eq!(installed_version(&f), Some(k.version));
            assert!(std::fs::read_to_string(&f).unwrap().contains(LXO));
        }
        assert!(std::fs::read_to_string(skill_file(&home, t, &SKILLS[1])).unwrap().contains("--role adversario"));
        for k in SKILLS {
            remove_ours(&home.join(t.skills).join(k.name));
            assert!(!skill_file(&home, t, k).exists());
        }
        let _ = std::fs::remove_dir_all(&home);
    }
}
