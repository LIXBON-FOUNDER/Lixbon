//! Modelo efectivo de Codex: `turn_context.model` de su archivo de sesión
//! (`$CODEX_HOME/sessions/AAAA/MM/DD/rollout-*.jsonl`). Si no se puede leer,
//! `unknown`; nunca se copia del modelo pedido.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;

pub const UNKNOWN: &str = "unknown";

/// Último `turn_context.model` de una sesión.
pub fn turn_context_model(jsonl: &str) -> Option<String> {
    jsonl.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v["type"] == "turn_context" && v["payload"]["model"].is_string())
        .and_then(|v| v["payload"]["model"].as_str().map(str::to_string))
        .filter(|m| super::agents::safe_token(m).is_ok())
}

/// `cwd` de la `session_meta` (primera línea).
pub fn session_cwd(jsonl: &str) -> Option<String> {
    jsonl.lines().take(5).filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v["type"] == "session_meta")
        .and_then(|v| v["payload"]["cwd"].as_str().map(str::to_string))
}

fn norm(p: &str) -> String {
    p.trim().trim_start_matches(r"\\?\").replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

fn mtime_ms(p: &Path) -> u64 {
    p.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn walk(dir: &Path, since_ms: u64, out: &mut Vec<(u64, PathBuf)>, depth: u8) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() && depth < 4 {
            walk(&p, since_ms, out, depth + 1);
        } else if p.extension().is_some_and(|x| x == "jsonl") && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("rollout-")) {
            let t = mtime_ms(&p);
            if t >= since_ms {
                out.push((t, p));
            }
        }
    }
}

/// Sesión más reciente de `cwd` escrita desde `since_ms`.
pub fn find_session(sessions: &Path, cwd: &str, since_ms: u64) -> Option<PathBuf> {
    let mut files = vec![];
    walk(sessions, since_ms, &mut files, 0);
    files.sort_by(|a, b| b.0.cmp(&a.0));
    let want = norm(cwd);
    files.into_iter().map(|(_, p)| p).find(|p| {
        std::fs::read_to_string(p).ok().and_then(|t| session_cwd(&t)).is_some_and(|c| norm(&c) == want)
    })
}

/// Modelo efectivo o `unknown`.
pub fn effective_model(sessions: Option<&Path>, cwd: &str, since_ms: u64) -> String {
    sessions
        .and_then(|s| find_session(s, cwd, since_ms))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| turn_context_model(&t))
        .unwrap_or_else(|| UNKNOWN.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orch::state::{NewTask, State};

    /// Recorte de una sesión real de `codex exec` 0.162.1 (prueba de punta a punta sobre bb0b013).
    const SESSION: &str = include_str!("testdata/codex-0.162.1-session-recortada.jsonl");
    const CWD: &str = r"C:\Users\USUARIO\lixbon-e2e-bb0b013-run\ws-c1-codex-199k";

    #[test]
    fn modelo_de_turn_context() {
        assert_eq!(turn_context_model(SESSION).as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(session_cwd(SESSION).as_deref(), Some(CWD));
        // Sin turn_context no hay modelo (no se adivina por session_meta ni por el pedido).
        let sin: String = SESSION.lines().filter(|l| !l.contains("turn_context")).collect::<Vec<_>>().join("\n");
        assert_eq!(turn_context_model(&sin), None);
    }

    #[test]
    fn busca_la_sesion_por_cwd_y_si_no_unknown() {
        let root = std::env::temp_dir().join(format!("lxo-codex-sess-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let day = root.join("2026").join("10").join("09");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("rollout-2026-10-09T22-15-55-x.jsonl"), SESSION).unwrap();
        let other = SESSION.replace("ws-c1-codex-199k", "otro").replace("gpt-6.1-sol", "gpt-5.6-luna");
        std::fs::write(day.join("rollout-2026-10-09T22-16-00-y.jsonl"), other).unwrap();
        // Ruta con otra capitalización y barras: la misma carpeta.
        let cwd = CWD.to_lowercase().replace('\\', "/");
        assert_eq!(effective_model(Some(&root), &cwd, 0), "gpt-6.1-sol");
        assert_eq!(effective_model(Some(&root), r"C:\otra\carpeta", 0), UNKNOWN);
        assert_eq!(effective_model(Some(&root), CWD, u64::MAX), UNKNOWN);
        assert_eq!(effective_model(None, CWD, 0), UNKNOWN);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nunca_se_copia_del_pedido() {
        let mut s = State::default();
        let (_, root) = s.create_run("obj", NewTask {
            agent: "codex".into(), model: None, effort: None, role: None, title: "r".into(), spec: String::new(), repo: "/r".into(), cwd: "/r".into(),
            branch: None, base: None, worktree: None, external: false,
        });
        let t = s.task_mut(&root).unwrap();
        t.model_requested = Some("gpt-6.1-sol".into());
        super::super::delivery::set_model_effective(t, UNKNOWN);
        assert_eq!(t.model_effective.as_deref(), Some("unknown"));
        assert!(!t.model_mismatch);
        super::super::delivery::set_model_effective(t, "gpt-5.6-luna");
        assert!(t.model_mismatch);
        super::super::delivery::set_model_effective(t, "gpt-6.1-sol");
        assert!(!t.model_mismatch);
    }
}
