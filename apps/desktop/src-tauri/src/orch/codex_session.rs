//! Modelo efectivo de Codex: `turn_context.model` del rollout de sesión
//! (`$CODEX_HOME/sessions/AAAA/MM/DD/rollout-<fecha>-<session_id>.jsonl`) atado al
//! intento. Si no se encuentra exactamente uno, `unknown`; nunca se copia del
//! modelo pedido.
//!
//! Cómo se ata la sesión al intento:
//! 1. `codex exec` imprime `session id: <uuid>` en su cabecera (0.162.1). Con ese
//!    id se busca el rollout cuyo `session_meta.id` (o el final del nombre) coincide.
//! 2. Si no hay id (TUI interactiva) o no aparece su archivo: rollouts cuyo
//!    `session_meta.cwd` normalizado es el del intento y cuyo `session_meta.timestamp`
//!    es >= inicio del intento menos `MARGIN_MS` (`cwd_time`).
//! 3. Solo cuentan las sesiones con `source` `cli` o `exec` (no los subagentes).
//! 4. Cero o más de un candidato: `unknown` y `session_ref: null`.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde_json::Value;

pub const UNKNOWN: &str = "unknown";
/// Margen por relojes y por el tiempo entre lanzar y que Codex escriba la sesión.
pub const MARGIN_MS: u64 = 5_000;

/// Último `turn_context.model` de una sesión.
pub fn turn_context_model(jsonl: &str) -> Option<String> {
    jsonl.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v["type"] == "turn_context" && v["payload"]["model"].is_string())
        .and_then(|v| v["payload"]["model"].as_str().map(str::to_string))
        .filter(|m| super::agents::safe_token(m).is_ok())
}

#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    pub id: String,
    pub cwd: String,
    pub started_ms: Option<u64>,
    /// `source` es `cli` (TUI) o `exec`. Los subagentes (`{"subagent": ...}`, con
    /// `guardian` o `thread_spawn`) comparten carpeta pero no son la hija.
    pub own: bool,
}

/// `session_meta` (en las primeras líneas).
pub fn session_meta(jsonl: &str) -> Option<Meta> {
    let v = jsonl.lines().take(5).filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|v| v["type"] == "session_meta")?;
    let p = &v["payload"];
    Some(Meta {
        id: p["id"].as_str().unwrap_or("").to_string(),
        cwd: p["cwd"].as_str()?.to_string(),
        started_ms: p["timestamp"].as_str().or(v["timestamp"].as_str()).and_then(parse_rfc3339_ms),
        own: matches!(p["source"].as_str(), Some("cli" | "exec")),
    })
}

/// `2026-10-10T03:15:55.607Z` (o con `+hh:mm`) en ms epoch.
pub fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.len() < 20 {
        return None;
    }
    let n = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    let mut rest = &s[19..];
    let mut ms = 0i64;
    if let Some(r) = rest.strip_prefix('.') {
        let digits: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
        let frac = format!("{:0<3}", &digits[..digits.len().min(3)]);
        ms = frac.parse().ok()?;
        rest = &r[digits.len()..];
    }
    let offset = match rest {
        "Z" | "z" => 0,
        o if o.len() == 6 && (o.starts_with('+') || o.starts_with('-')) => {
            let sign = if o.starts_with('-') { -1 } else { 1 };
            sign * (o[1..3].parse::<i64>().ok()? * 3600 + o[4..6].parse::<i64>().ok()? * 60)
        }
        _ => return None,
    };
    // Días desde 1970-01-01 (algoritmo civil de H. Hinnant).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + h * 3600 + mi * 60 + se - offset;
    u64::try_from(secs * 1000 + ms).ok()
}

/// `session id: <uuid>` de la cabecera de `codex exec` (sin ANSI).
pub fn session_id_from_terminal(text: &str) -> Option<String> {
    let plain = super::pty::plain(text);
    let i = plain.rfind("session id:")?;
    let id: String = plain[i + "session id:".len()..].trim_start().chars().take_while(|c| c.is_ascii_hexdigit() || *c == '-').collect();
    (id.len() >= 32).then_some(id)
}

fn norm(p: &str) -> String {
    p.trim().trim_start_matches(r"\\?\").replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

fn mtime_ms(p: &Path) -> u64 {
    p.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Rollouts modificados desde `since_ms` (los viejos ni se abren).
fn rollouts(dir: &Path, since_ms: u64, out: &mut Vec<PathBuf>, depth: u8) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() && depth < 4 {
            rollouts(&p, since_ms, out, depth + 1);
        } else if p.extension().is_some_and(|x| x == "jsonl")
            && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("rollout-"))
            && mtime_ms(&p) >= since_ms
        {
            out.push(p);
        }
    }
}

fn one(mut v: Vec<PathBuf>) -> Option<PathBuf> {
    (v.len() == 1).then(|| v.remove(0))
}

/// Rollout del intento, o `None` si no hay exactamente uno.
pub fn pick(sessions: &Path, session_id: Option<&str>, cwd: &str, start_ms: u64) -> (Option<PathBuf>, &'static str) {
    let since = start_ms.saturating_sub(MARGIN_MS);
    let mut files = vec![];
    rollouts(sessions, since, &mut files, 0);
    let metas: Vec<(PathBuf, Meta)> = files.into_iter()
        .filter_map(|p| { let m = std::fs::read_to_string(&p).ok().and_then(|t| session_meta(&t))?; Some((p, m)) })
        .filter(|(_, m)| m.own)
        .collect();
    if let Some(id) = session_id.map(str::trim).filter(|i| !i.is_empty()) {
        let by_id: Vec<PathBuf> = metas.iter()
            .filter(|(p, m)| m.id.eq_ignore_ascii_case(id) || p.file_stem().is_some_and(|s| s.to_string_lossy().to_ascii_lowercase().ends_with(&id.to_ascii_lowercase())))
            .map(|(p, _)| p.clone()).collect();
        if !by_id.is_empty() {
            return (one(by_id), "session_id");
        }
    }
    let want = norm(cwd);
    let by_filter: Vec<PathBuf> = metas.into_iter()
        .filter(|(_, m)| norm(&m.cwd) == want && m.started_ms.is_some_and(|t| t >= since))
        .map(|(p, _)| p).collect();
    (one(by_filter), "cwd_time")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub model: String,
    pub session_ref: Option<String>,
    /// Cómo se eligió la sesión: `session_id` o `cwd_time`.
    pub mechanism: &'static str,
}

impl Resolved {
    /// `model_source` del intento: el mecanismo si se leyó el modelo, si no `unknown`.
    pub fn source(&self) -> &'static str {
        if self.model == UNKNOWN { UNKNOWN } else { self.mechanism }
    }
}

pub fn resolve(sessions: Option<&Path>, session_id: Option<&str>, cwd: &str, start_ms: u64) -> Resolved {
    let (path, mechanism) = match sessions {
        Some(s) => pick(s, session_id, cwd, start_ms),
        None => (None, "cwd_time"),
    };
    let model = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| turn_context_model(&t)).unwrap_or_else(|| UNKNOWN.to_string());
    Resolved { model, session_ref: path.map(|p| p.to_string_lossy().into_owned()), mechanism }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orch::state::{NewTask, State};

    /// Recorte de una sesión real de `codex exec` 0.162.1 (prueba de punta a punta sobre bb0b013).
    const SESSION: &str = include_str!("testdata/codex-0.162.1-session-recortada.jsonl");
    const CWD: &str = r"C:\Users\USUARIO\lixbon-e2e-bb0b013-run\ws-c1-codex-199k";
    const ID: &str = "01a123cf-5f63-7591-b38c-67509d3a1ce1";
    /// 2026-10-10T03:15:55.607Z
    const T0: u64 = 1_791_602_155_607;

    /// Sesión con otro id, cwd, hora de inicio (ms) y modelo.
    fn session(id: &str, cwd: &str, start: u64, model: &str) -> String {
        let iso = |ms: u64| {
            let (secs, milli) = ((ms / 1000) as i64, ms % 1000);
            let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
            // Inverso del algoritmo civil (H. Hinnant).
            let z = days + 719468;
            let era = z.div_euclid(146097);
            let doe = z - era * 146097;
            let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = if mp < 10 { mp + 3 } else { mp - 9 };
            let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
            format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
        };
        SESSION.replace(ID, id).replace(r"C:\\Users\\USUARIO\\lixbon-e2e-bb0b013-run\\ws-c1-codex-199k", &cwd.replace('\\', r"\\"))
            .replace("2026-10-10T03:15:55.607Z", &iso(start)).replace("gpt-6.1-sol", model)
    }

    fn dir(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("lxo-codex-sess-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("2026").join("10").join("09")).unwrap();
        root
    }

    fn put(root: &Path, id: &str, body: &str) -> PathBuf {
        let p = root.join("2026").join("10").join("09").join(format!("rollout-2026-10-09T22-15-55-{id}.jsonl"));
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn piezas_de_la_sesion_real() {
        assert_eq!(turn_context_model(SESSION).as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(session_meta(SESSION), Some(Meta { id: ID.into(), cwd: CWD.into(), started_ms: Some(T0), own: true }));
        assert_eq!(parse_rfc3339_ms("2026-10-09T22:15:55.607-05:00"), Some(T0));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01Z"), Some(1000));
        // Cabecera real de `codex exec` 0.162.1 (con ANSI).
        let head = "\x1b[2J\x1b[mOpenAI Codex v0.162.1\r\n--------\r\nworkdir: C:\\x\r\nmodel: gpt-6.1-sol\r\nsession id: 01a123cf-5f63-7591-b38c-67509d3a1ce1\r\n--------\r\nuser\r\n";
        assert_eq!(session_id_from_terminal(head).as_deref(), Some(ID));
        assert_eq!(session_id_from_terminal("sin cabecera"), None);
        let sin: String = SESSION.lines().filter(|l| !l.contains("turn_context")).collect::<Vec<_>>().join("\n");
        assert_eq!(turn_context_model(&sin), None);
    }

    #[test]
    fn por_session_id() {
        let root = dir("id");
        let p = put(&root, ID, SESSION);
        put(&root, "otro-mismo-cwd", &session("otro-mismo-cwd", CWD, T0 + 2000, "gpt-5.6-luna"));
        // Dos con el mismo cwd y casi la misma hora: el id decide.
        let r = resolve(Some(&root), Some(ID), CWD, T0);
        assert_eq!((r.model.as_str(), r.mechanism, r.source()), ("gpt-6.1-sol", "session_id", "session_id"));
        assert_eq!(r.session_ref, Some(p.to_string_lossy().into_owned()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mismo_cwd_horas_distintas() {
        let root = dir("horas");
        // Intento anterior (hace 10 min) y el actual, en la misma carpeta.
        put(&root, "viejo", &session("viejo", CWD, T0 - 600_000, "gpt-5.6-luna"));
        let p = put(&root, ID, SESSION);
        let r = resolve(Some(&root), None, CWD, T0 - 1000);
        assert_eq!((r.model.as_str(), r.mechanism, r.source()), ("gpt-6.1-sol", "cwd_time", "cwd_time"));
        assert_eq!(r.session_ref, Some(p.to_string_lossy().into_owned()));
        // Pedir desde antes de las dos: ambiguo.
        let r = resolve(Some(&root), None, CWD, T0 - 700_000);
        assert_eq!((r.model.as_str(), r.session_ref), (UNKNOWN, None));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cwd_distinto_en_paralelo() {
        let root = dir("paralelo");
        let a = put(&root, ID, SESSION);
        let otro = r"C:\Users\USUARIO\lixbon-e2e-bb0b013-run\ws-c2-codex";
        let b = put(&root, "paralela", &session("paralela", otro, T0 + 1000, "gpt-5.6-terra"));
        // Misma carpeta con otras mayúsculas y barras: se reconoce.
        let r = resolve(Some(&root), None, &CWD.to_lowercase().replace('\\', "/"), T0);
        assert_eq!((r.model.as_str(), r.session_ref), ("gpt-6.1-sol", Some(a.to_string_lossy().into_owned())));
        let r = resolve(Some(&root), None, otro, T0);
        assert_eq!((r.model.as_str(), r.session_ref), ("gpt-5.6-terra", Some(b.to_string_lossy().into_owned())));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sesion_vieja_anterior_al_intento() {
        let root = dir("vieja");
        put(&root, "vieja", &session("vieja", CWD, T0 - 3_600_000, "gpt-5.6-luna"));
        // El intento empezó después: no hay sesión suya todavía.
        let r = resolve(Some(&root), None, CWD, T0);
        assert_eq!((r.model.as_str(), r.session_ref), (UNKNOWN, None));
        // Un id de otra sesión tampoco la adopta.
        let r = resolve(Some(&root), Some(ID), CWD, T0);
        assert_eq!(r.model, UNKNOWN);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sesion_sin_turn_context_da_source_unknown() {
        let root = dir("sintc");
        let sin: String = SESSION.lines().filter(|l| !l.contains("turn_context")).collect::<Vec<_>>().join("\n");
        put(&root, ID, &sin);
        let r = resolve(Some(&root), Some(ID), CWD, T0);
        assert_eq!((r.model.as_str(), r.mechanism, r.source()), (UNKNOWN, "session_id", "unknown"));
        assert!(r.session_ref.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn subagent(id: &str, start: u64, source: &str) -> String {
        session(id, CWD, start, "gpt-5.6-luna").replace(r#""source":"exec""#, &format!(r#""source":{source}"#))
    }

    const GUARDIAN: &str = r#"{"subagent":{"other":"guardian"}}"#;
    const SPAWN: &str = r#"{"subagent":{"thread_spawn":{"parent_thread_id":"01a123cf-5f63-7591-b38c-67509d3a1ce1","depth":1,"agent_path":null,"agent_nickname":"Hooke","agent_role":null}}}"#;

    #[test]
    fn hija_mas_subagente_guardian_gana_la_hija() {
        let root = dir("guardian");
        let p = put(&root, ID, SESSION);
        put(&root, "guardian", &subagent("guardian", T0 + 2000, GUARDIAN));
        put(&root, "spawn", &subagent("spawn", T0 + 3000, SPAWN));
        assert!(!session_meta(&subagent("g", T0, GUARDIAN)).unwrap().own);
        let r = resolve(Some(&root), None, CWD, T0);
        assert_eq!((r.model.as_str(), r.source()), ("gpt-6.1-sol", "cwd_time"));
        assert_eq!(r.session_ref, Some(p.to_string_lossy().into_owned()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn solo_un_subagente_da_unknown() {
        let root = dir("solosub");
        put(&root, "guardian", &subagent("guardian", T0 + 2000, GUARDIAN));
        let r = resolve(Some(&root), None, CWD, T0);
        assert_eq!((r.model.as_str(), r.session_ref.clone(), r.source()), (UNKNOWN, None, "unknown"));
        // Ni pidiéndolo por su id.
        let r = resolve(Some(&root), Some("guardian"), CWD, T0);
        assert_eq!((r.model.as_str(), r.session_ref), (UNKNOWN, None));
        // Un source desconocido tampoco cuenta; `cli` (TUI) sí.
        put(&root, "rara", &subagent("rara", T0 + 1000, r#""vscode""#));
        assert_eq!(resolve(Some(&root), None, CWD, T0).model, UNKNOWN);
        put(&root, "tui", &subagent("tui", T0 + 1500, r#""cli""#));
        let r = resolve(Some(&root), None, CWD, T0);
        assert_eq!((r.model.as_str(), r.source()), ("gpt-5.6-luna", "cwd_time"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ambiguo_da_unknown() {
        let root = dir("ambiguo");
        put(&root, ID, SESSION);
        put(&root, "gemela", &session("gemela", CWD, T0 + 3000, "gpt-5.6-luna"));
        let r = resolve(Some(&root), None, CWD, T0);
        assert_eq!((r.model.as_str(), r.session_ref.clone(), r.mechanism, r.source()), (UNKNOWN, None, "cwd_time", "unknown"));
        assert_eq!(resolve(None, None, CWD, T0).model, UNKNOWN);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nunca_se_copia_del_pedido_y_sale_en_la_snapshot() {
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
        // Codex sin modelo pedido: model_requested null, sin mismatch, el efectivo de la sesión.
        t.model_requested = None;
        super::super::delivery::set_model_effective(t, "gpt-6.1-sol");
        assert_eq!((t.model_requested.as_deref(), t.model_effective.as_deref(), t.model_mismatch), (None, Some("gpt-6.1-sol"), false));
        assert!(t.model_mismatch_reason.is_none());
        t.session_ref = Some("C:/x/rollout.jsonl".into());
        t.model_source = Some("session_id".into());
        let v = serde_json::to_value(&*t).unwrap();
        assert_eq!(v["session_ref"], "C:/x/rollout.jsonl");
        assert_eq!(v["model_source"], "session_id");
        t.session_ref = None;
        assert!(serde_json::to_value(&*t).unwrap()["session_ref"].is_null());
    }
}
