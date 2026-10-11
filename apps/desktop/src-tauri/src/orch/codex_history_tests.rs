//! Historial de Codex: listar las sesiones guardadas y reanudar una en la terminal.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde_json::json;

use super::agents::Probe;
use super::codex_session::{first_prompt, list, valid_session_id};
use super::codex_term::{build, command_line, with_resume};
use super::providers;

const ID_A: &str = "01a123cf-5f63-7591-b38c-67509d3a1ce1";
const ID_B: &str = "02b234d0-6a74-8602-c49d-78610e4b2df2";
const ID_SUB: &str = "03c345e1-7b85-9713-d5ae-89721f5c3e03";
const ID_OTRA: &str = "04d456f2-8c96-a824-e6bf-9a832a6d4f14";

struct Sessions(PathBuf);

impl Sessions {
    fn new(name: &str) -> Sessions {
        let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(dir.join("2026/10/10")).unwrap();
        Sessions(dir)
    }

    /// Escribe un rollout con `age` segundos de antigüedad.
    fn add(&self, id: &str, cwd: &str, source: serde_json::Value, prompt: Option<&str>, age: u64) {
        let mut lines = vec![json!({"type": "session_meta", "payload": {"id": id, "cwd": cwd, "source": source, "timestamp": "2026-10-10T03:15:55.607Z"}})];
        lines.push(json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>\n  <cwd>x</cwd>\n</environment_context>"}]}}));
        lines.push(json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "# AGENTS.md instructions for x\n..."}]}}));
        if let Some(p) = prompt {
            lines.push(json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": p}]}}));
        }
        lines.push(json!({"type": "turn_context", "payload": {"model": "gpt-6.1-sol"}}));
        let body: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        let path = self.0.join("2026/10/10").join(format!("rollout-2026-10-10T03-15-55-{id}.jsonl"));
        fs::write(&path, body.join("\n")).unwrap();
        let when = SystemTime::now() - Duration::from_secs(age);
        fs::File::options().write(true).open(&path).unwrap().set_modified(when).unwrap();
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Sessions {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn ids(list: &[super::codex_session::SessionInfo]) -> Vec<&str> {
    list.iter().map(|s| s.id.as_str()).collect()
}

#[test]
fn la_peticion_real_se_salta_los_mensajes_de_sistema() {
    let jsonl = [
        json!({"type": "session_meta", "payload": {"id": ID_A, "cwd": "C:/r", "source": "cli"}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hola"}]}}),
        json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "<environment_context>x</environment_context>"}]}}),
        json!({"type": "event_msg", "payload": {"type": "user_message", "message": "arregla el login"}}),
    ].iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n");
    assert_eq!(first_prompt(&jsonl).as_deref(), Some("arregla el login"));
    assert_eq!(first_prompt("{\"type\":\"session_meta\"}\nno es json"), None);
}

#[test]
fn lista_solo_sesiones_propias_de_la_carpeta_y_las_mas_recientes_primero() {
    let s = Sessions::new("hist-lista");
    s.add(ID_A, "C:\\Users\\yo\\repo", json!("cli"), Some("arregla el login"), 600);
    s.add(ID_B, "C:/Users/yo/repo/apps/web", json!("exec"), Some("revisa los estilos"), 60);
    s.add(ID_SUB, "C:/Users/yo/repo", json!({"subagent": {"thread_spawn": {}}}), Some("subagente"), 10);
    s.add(ID_OTRA, "C:/Users/yo/otro", json!("cli"), Some("otra cosa"), 5);

    let aqui = list(s.path(), Some("C:/Users/yo/repo"), 50);
    assert_eq!(ids(&aqui), [ID_B, ID_A], "recientes primero; sin subagentes ni otras carpetas");
    assert_eq!(aqui[0].title, "revisa los estilos");
    assert_eq!(aqui[0].model.as_deref(), Some("gpt-6.1-sol"));
    assert!(aqui[0].updated_ms > aqui[1].updated_ms);

    let todas = list(s.path(), None, 50);
    assert_eq!(ids(&todas), [ID_OTRA, ID_B, ID_A]);
    assert_eq!(list(s.path(), None, 1).len(), 1, "respeta el límite");
    assert!(list(s.path(), Some("C:/Users/yo/repo-parecido"), 50).is_empty(), "un prefijo de texto no es una subcarpeta");
    assert!(list(&s.path().join("no-existe"), None, 50).is_empty());
}

#[test]
fn el_titulo_se_acorta_y_tiene_respaldo() {
    let s = Sessions::new("hist-titulo");
    let largo = format!("{} y mas cosas", "a".repeat(120));
    s.add(ID_A, "C:/r", json!("cli"), Some(&format!("\n  {largo}\nsegunda línea")), 20);
    s.add(ID_B, "C:/r", json!("cli"), None, 10);
    let l = list(s.path(), Some("C:/r"), 10);
    assert_eq!(l[0].title, "Sesión de Codex");
    assert_eq!(l[1].title.chars().count(), 81, "80 caracteres y una elipsis");
    assert!(l[1].title.ends_with('…') && !l[1].title.contains("segunda"));
}

#[test]
fn solo_vale_un_uuid_hexadecimal() {
    assert_eq!(valid_session_id(&format!("  {}  ", ID_A.to_uppercase())).unwrap(), ID_A);
    for malo in ["", "abc", "x & del", "01a123cf-5f63-7591-b38c-67509d3a1ce1 --yolo", "../../etc", &"a".repeat(41)] {
        assert!(valid_session_id(malo).is_err(), "{malo:?}");
    }
}

#[test]
fn reanudar_pone_resume_y_el_id_antes_de_los_mismos_permisos() {
    let probe = Probe { version: Some("0.162.1".into()), ..Default::default() };
    let list = vec![providers::codex(true, Some("0.162.1"), Some(include_str!("testdata/codex-0.162.1-debug-models.json")), None)];
    let base = build("C:/repo", Some("gpt-6.1-sol"), None, Some(&probe), &list, None).unwrap();
    let p = with_resume(base.clone(), ID_A).unwrap();
    assert_eq!(&p.argv[..5], ["codex", "resume", ID_A, "--sandbox", "workspace-write"]);
    assert_eq!(p.argv[3..], base.argv[1..], "el resto del argv no cambia");
    assert_eq!(p.policy["resume"], ID_A);
    assert!(!p.argv.iter().any(|a| a.starts_with("--dangerously") || a == "--yolo" || a == "--full-auto" || a == "danger-full-access"));
    assert_eq!(
        command_line(&p.argv),
        format!("codex resume {ID_A} --sandbox workspace-write --ask-for-approval on-request --cd C:/repo -m gpt-6.1-sol")
    );
    assert!(with_resume(base, "x && calc").is_err());
}

/// Contra el `~/.codex/sessions` real de la máquina: `cargo test -- --ignored codex_real`.
#[test]
#[ignore]
fn codex_real_lista_sesiones_con_forma_valida() {
    let home = super::agents::codex_home().expect("sin CODEX_HOME");
    let t = std::time::Instant::now();
    let todas = list(&home.join("sessions"), None, 200);
    eprintln!("sesiones: {} en {:?}", todas.len(), t.elapsed());
    assert!(!todas.is_empty(), "no hay sesiones propias");
    for s in &todas {
        assert!(valid_session_id(&s.id).is_ok(), "id raro: {}", s.id);
        assert!(!s.title.is_empty() && !s.title.starts_with('<'), "título de sistema: {:?}", s.title.chars().take(20).collect::<String>());
    }
    let sin_titulo = todas.iter().filter(|s| s.title == "Sesión de Codex").count();
    eprintln!("con respaldo de título: {sin_titulo}");
    assert!(todas.windows(2).all(|w| w[0].updated_ms >= w[1].updated_ms), "orden por fecha");
}
