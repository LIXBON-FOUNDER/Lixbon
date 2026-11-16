//! Validación manual con las CLIs REALES de Claude y de Codex (LXO-247). Los smokes de LXO-242 (cierre de procesos) y LXO-249 (uso) viven en
//! `real_smoke_custody_tests.rs` y `real_smoke_usage_tests.rs` y reutilizan estos ayudantes. Todas son `#[ignore]`: lanzan el proveedor de verdad y usan la
//! cuenta de la persona. Un Core completo con el lanzador real, y todo entra por los mismos RPC que usa Desktop.
//!
//! ```text
//! cargo test --lib real_smoke -- --ignored --nocapture --test-threads=1
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::adapter::{ClaudeAdapter, ClaudeConfig, CodexAdapter, CodexConfig, Environment, ProviderAdapter};
use super::adapter_launcher::AdapterLauncher;
use super::adapter_launcher_tests::{registry_of, repo_with_commit};
use super::attempt_e2e_tests::kinds;
use super::dispatch_tests::{event_count, row};
use super::events::Channel;
use super::initial_approval_tests::e2e::core_with_project_at;
use super::{Caller, Core};

pub(super) const TERMINAL: &[&str] = &["done", "failed", "stopped"];

/// Un Attempt real ya aprobado y en marcha.
pub(super) struct Real {
    pub core: Arc<Core>,
    pub attempt: String,
    _repo: PathBuf,
}

impl Real {
    pub fn desktop(&self, cmd: &str, args: Value) -> Result<Value, String> {
        self.core.rpc_via(Channel::Ui, Caller::User, "", cmd, &args)
    }

    pub fn state(&self) -> String {
        row(&self.core, &self.attempt).0
    }

    /// Espera a que el Attempt llegue a un estado que cumpla `done`; devuelve ese estado.
    pub fn wait(&self, what: &str, secs: u64, done: &dyn Fn(&str) -> bool) -> String {
        let start = Instant::now();
        let end = start + Duration::from_secs(secs);
        let mut last = String::new();
        loop {
            let now = self.state();
            if now != last {
                println!("[{:>3}s] estado: {now}", start.elapsed().as_secs());
                last = now.clone();
            }
            if done(&now) {
                return now;
            }
            assert!(Instant::now() < end, "no se cumplió a tiempo: {what} (último estado {now})");
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    /// La carpeta del worktree en el que trabaja el Attempt.
    pub fn worktree_dir(&self) -> PathBuf {
        worktree_dir(&self.core, &self.attempt).expect("el Attempt tiene worktree")
    }

    /// La primera petición pendiente del proveedor, ya con el Attempt esperándola.
    pub fn first_request(&self) -> Value {
        let pending = self.desktop("attempt_pending_requests", json!({"attempt_id": self.attempt})).expect("pendientes");
        println!("pendientes: {pending}");
        let requests = pending["requests"].as_array().expect("lista");
        assert!(!requests.is_empty() && pending["live"] == true, "{pending}");
        requests[0].clone()
    }
}

pub(super) fn worktree_dir(core: &Core, attempt: &str) -> Option<PathBuf> {
    core.worktree_store(|st| {
        let a = st.attempt_row(attempt).ok()??;
        let w = st.worktree_row(a.worktree_id.as_deref()?).ok()??;
        w.path.map(PathBuf::from)
    })
    .flatten()
}

fn launch(adapter: Arc<dyn ProviderAdapter>, provider: &str, profile: &str, model: &str, spec: &str) -> Real {
    let repo = repo_with_commit();
    let (core, _client, _ctx, project) = core_with_project_at(&repo.to_string_lossy());
    let probe = adapter.probe();
    println!("probe: {:?}", probe.environment);
    assert_eq!(probe.environment, Environment::Ready, "{provider} no está listo en esta máquina");
    core.install_launcher(Arc::new(AdapterLauncher::new(&core, registry_of(adapter))));
    // El preflight de `task_create` mira el registro propio del Core (en pruebas, adapters falsos): no hay nada que sondear aquí.
    core.provider_registry.probe_all();
    let real = Real { core, attempt: String::new(), _repo: repo };
    let created = real
        .desktop(
            "task_create",
            json!({
                "request_id": format!("smoke-real-{provider}-{profile}"), "project_id": project, "objective": "smoke real", "title": "smoke", "spec": spec,
                "attempt": {"provider": provider, "profile": profile, "model": model}
            }),
        )
        .expect("task_create");
    let attempt = created["attempt_id"].as_str().unwrap().to_string();
    real.desktop("attempt_approve", json!({"attempt_id": attempt})).expect("aprobar");
    Real { attempt, ..real }
}

pub(super) fn claude(profile: &str, spec: &str) -> Real {
    launch(Arc::new(ClaudeAdapter::new(ClaudeConfig::default())), "claude", profile, "haiku", spec)
}

pub(super) fn codex(profile: &str, spec: &str) -> Real {
    launch(Arc::new(CodexAdapter::new(CodexConfig::default())), "codex", profile, "gpt-5.6-luna", spec)
}

const WRITE_SMOKE: &str = "Usa la herramienta Bash para ejecutar exactamente este comando: node -e \"require('fs').writeFileSync('smoke.txt','SMOKE_OK')\" . Cuando termine responde solo la palabra LISTO.";

/// DENEGAR con Claude real: el proveedor recibe el no, NO ejecuta el comando (el archivo no existe) y el Attempt sale de la espera (no por el plazo).
#[test]
#[ignore = "validación manual: lanza la CLI real de Claude y usa la cuenta del usuario"]
fn real_claude_denegar_un_permiso_no_ejecuta_el_comando_y_el_attempt_sale_de_la_espera() {
    let r = claude("delegar_con_revision", WRITE_SMOKE);
    let first = r.wait("el Attempt pide un permiso, termina o falla", 180, &|s| matches!(s, "awaiting_terminal_approval") || TERMINAL.contains(&s));
    assert_eq!(first, "awaiting_terminal_approval", "Claude no pidió permiso (terminó {first})");
    let request = r.first_request();
    assert_eq!(request["kind"], "permission", "{request}");
    let request_id = request["request_id"].as_str().unwrap();

    // Denegar es `answer` (no `provider_permissions`): no exige confirmación.
    let answered = r.desktop("attempt_answer", json!({"attempt_id": r.attempt, "request_id": request_id, "answer": "deny"})).expect("denegar");
    println!("respuesta: {answered}");
    assert_eq!(answered["status"], "Answered");

    let last = r.wait("el Attempt termina tras la negativa", 180, &|s| TERMINAL.contains(&s));
    println!("eventos finales: {:?}\nestado final: {last}", kinds(&r.core, &r.attempt));
    assert_ne!(row(&r.core, &r.attempt).2.as_deref(), Some("terminal_approval_timeout"), "salió por el plazo, no por la respuesta");
    assert_eq!(event_count(&r.core, &r.attempt, "attempt.request_answered"), 1);
    assert!(!r.worktree_dir().join("smoke.txt").exists(), "se denegó: el comando NO debía ejecutarse");
}

/// PREGUNTA LIBRE con Claude real. El proveedor la plantea con su herramienta `AskUserQuestion`; esta prueba imprime cómo llega al Core (para
/// que quede registrado qué tipo de petición es) y la contesta con texto.
#[test]
#[ignore = "validación manual: lanza la CLI real de Claude y usa la cuenta del usuario"]
fn real_claude_una_pregunta_libre_se_responde_desde_desktop_y_el_attempt_continua() {
    let r = claude(
        "delegar_con_revision",
        "Antes de hacer nada, usa la herramienta AskUserQuestion para preguntarme cuál es mi color favorito (ofrece las opciones rojo y azul). \
         Cuando te conteste, responde exactamente: COLOR=<lo que te contesté>.",
    );
    let first = r.wait("el Attempt pregunta, termina o falla", 180, &|s| matches!(s, "awaiting_terminal_approval") || TERMINAL.contains(&s));
    println!("eventos hasta aquí: {:?}", kinds(&r.core, &r.attempt));
    assert_eq!(first, "awaiting_terminal_approval", "Claude no preguntó (terminó {first})");
    let request = r.first_request();
    println!("petición: {request}");
    let request_id = request["request_id"].as_str().unwrap();
    assert_eq!(request["kind"], "question", "una pregunta libre del proveedor debe llegar como `question`, no como un permiso: {request}");

    let answered = r.desktop("attempt_answer", json!({"attempt_id": r.attempt, "request_id": request_id, "answer": "verde"})).expect("responder");
    println!("respuesta: {answered}");
    assert_eq!(answered["status"], "Answered");
    let last = r.wait("el Attempt continúa y termina", 180, &|s| TERMINAL.contains(&s));
    println!("eventos finales: {:?}\nestado final: {last}", kinds(&r.core, &r.attempt));
    assert_eq!(last, "done");
    let detail = r.desktop("attempt_detail", json!({"attempt_id": r.attempt})).expect("detalle");
    let text = detail.to_string();
    assert!(text.contains("COLOR=verde"), "Claude debía haber recibido «verde»: {text}");
}

/// Un archivo FUERA de las raíces escribibles del sandbox de Codex (`workspace-write`: el workspace y el directorio temporal; escribir en el temporal
/// NO pide aprobación): la carpeta personal. Quien lo use lo borra.
fn outside_the_sandbox(name: &str) -> PathBuf {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).expect("carpeta personal");
    PathBuf::from(home).join(format!(".{name}-{}.txt", std::process::id()))
}

/// PERMISO con Codex real: un comando que escribe FUERA del sandbox pide aprobación bajo `workspace-write` + `on-request`.
#[test]
#[ignore = "validación manual: lanza la CLI real de Codex y usa la cuenta del usuario"]
fn real_codex_un_permiso_se_responde_desde_desktop_y_el_attempt_continua() {
    let outside = outside_the_sandbox("lxo-smoke-codex");
    let _ = std::fs::remove_file(&outside);
    let spec = format!(
        "Ejecuta en la terminal exactamente este comando: node -e \"require('fs').writeFileSync(process.argv[1],'SMOKE_OK')\" \"{}\" . Cuando termine responde solo la palabra LISTO.",
        outside.display().to_string().replace('\\', "/")
    );
    let r = codex("delegar_con_revision", &spec);
    let first = r.wait("el Attempt pide un permiso, termina o falla", 240, &|s| matches!(s, "awaiting_terminal_approval") || TERMINAL.contains(&s));
    println!("eventos hasta aquí: {:?}", kinds(&r.core, &r.attempt));
    assert_eq!(first, "awaiting_terminal_approval", "Codex no pidió aprobación (terminó {first}): el smoke no ejercita `answer`");
    let request = r.first_request();
    assert_eq!(request["kind"], "permission", "{request}");
    let request_id = request["request_id"].as_str().unwrap();

    let sin_confirmar = r.desktop("attempt_answer", json!({"attempt_id": r.attempt, "request_id": request_id, "answer": "allow"})).unwrap_err();
    assert!(sin_confirmar.contains("policy_confirm_required"), "{sin_confirmar}");
    let answered = r.desktop("attempt_answer", json!({"attempt_id": r.attempt, "request_id": request_id, "answer": "allow", "confirm": true})).expect("responder");
    println!("respuesta: {answered}");
    assert_eq!(answered["status"], "Answered");
    let again = r.desktop("attempt_answer", json!({"attempt_id": r.attempt, "request_id": request_id, "answer": "allow", "confirm": true})).expect("repetida");
    assert_eq!(again["status"], "Replayed");

    let last = r.wait("el Attempt continúa y termina", 240, &|s| TERMINAL.contains(&s));
    println!("eventos finales: {:?}\nestado final: {last}", kinds(&r.core, &r.attempt));
    let wrote = std::fs::read_to_string(&outside).ok();
    let _ = std::fs::remove_file(&outside);
    assert_eq!(last, "done");
    assert_eq!(event_count(&r.core, &r.attempt, "attempt.request_answered"), 1);
    assert_eq!(wrote.as_deref(), Some("SMOKE_OK"), "se permitió: el comando debía ejecutarse");
}

/// DENEGAR con Codex real: el comando que pedía aprobación no se ejecuta.
#[test]
#[ignore = "validación manual: lanza la CLI real de Codex y usa la cuenta del usuario"]
fn real_codex_denegar_una_aprobacion_no_ejecuta_el_comando() {
    let outside = outside_the_sandbox("lxo-smoke-codex-deny");
    let _ = std::fs::remove_file(&outside);
    let spec = format!(
        "Ejecuta en la terminal exactamente este comando: node -e \"require('fs').writeFileSync(process.argv[1],'SMOKE_OK')\" \"{}\" . Cuando termine, o si no puedes, responde solo la palabra LISTO.",
        outside.display().to_string().replace('\\', "/")
    );
    let r = codex("delegar_con_revision", &spec);
    let first = r.wait("el Attempt pide un permiso, termina o falla", 240, &|s| matches!(s, "awaiting_terminal_approval") || TERMINAL.contains(&s));
    assert_eq!(first, "awaiting_terminal_approval", "Codex no pidió aprobación (terminó {first})");
    let request = r.first_request();
    let request_id = request["request_id"].as_str().unwrap();
    let answered = r.desktop("attempt_answer", json!({"attempt_id": r.attempt, "request_id": request_id, "answer": "deny"})).expect("denegar");
    assert_eq!(answered["status"], "Answered");
    let last = r.wait("el Attempt termina tras la negativa", 240, &|s| TERMINAL.contains(&s));
    println!("eventos finales: {:?}\nestado final: {last}", kinds(&r.core, &r.attempt));
    let wrote = outside.exists();
    let _ = std::fs::remove_file(&outside);
    assert_ne!(row(&r.core, &r.attempt).2.as_deref(), Some("terminal_approval_timeout"));
    assert!(!wrote, "se denegó: el comando NO debía ejecutarse");
}
