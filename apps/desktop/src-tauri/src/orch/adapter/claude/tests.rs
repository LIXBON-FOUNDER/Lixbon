//! Pruebas del adapter de Claude (LXO-129). Los guiones son capturas REALES de Claude Code 2.1.296 (saneadas); la prueba
//! `real_claude_*` (ignorada por defecto) lanza la CLI de verdad para la validación manual.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::fake::{script_of, FakeLauncher};
use crate::orch::adapter::process::LaunchSpec;
use super::stream::{parse_line, summarize_tool, Msg};
use super::*;
use crate::orch::adapter::{AdapterRegistry, Environment, ErrorCode, FailureKind, REDACTED};
use crate::store::looks_secret;

const HELP: &str = include_str!("../../testdata/claude-2.1.296-help.txt");
const NORMAL: &str = include_str!("../../testdata/claude-2.1.296-adapter-normal.jsonl");
const PERMISO: &str = include_str!("../../testdata/claude-2.1.296-adapter-permiso.jsonl");
const INTERRUMPIR: &str = include_str!("../../testdata/claude-2.1.296-adapter-interrumpir.jsonl");
const ERROR_RED: &str = include_str!("../../testdata/claude-2.1.296-adapter-error-red.jsonl");
const SESSION: &str = "00000000-0000-4000-8000-000000000001";

fn cfg() -> ClaudeConfig {
    ClaudeConfig { program: Some(PathBuf::from("claude-falso")), ..ClaudeConfig::default() }
}

fn fake_probe() -> ProbeResult {
    probe_from(true, Some("2.1.296"), Some(HELP))
}

fn adapter(cfg: ClaudeConfig, launcher: Arc<FakeLauncher>) -> Arc<ClaudeAdapter> {
    Arc::new(ClaudeAdapter::with_parts(cfg, launcher, Arc::new(fake_probe)))
}

fn registro(a: Arc<ClaudeAdapter>) -> AdapterRegistry {
    let mut r = AdapterRegistry::new();
    r.register(a).unwrap();
    r
}

fn start_req(profile: &str) -> StartRequest {
    StartRequest { attempt_id: "a1".into(), worktree: PathBuf::from("wt"), prompt: "haz algo".into(), profile: profile.into(), model: None, effort: None }
}

/// Corre una ejecución completa sin interacción.
fn corre(script: Vec<Value>, stderr: &str) -> (Vec<AdapterEvent>, RunOutcome, Arc<FakeLauncher>) {
    let l = FakeLauncher::with_stderr(script, stderr);
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("proponer"), &cancel).unwrap();
    let mut got = vec![];
    let outcome = g.events(&run, &cancel, &mut |e: AdapterEvent| got.push(e)).unwrap();
    (got, outcome, l)
}

fn salida(events: &[AdapterEvent]) -> Vec<String> {
    events.iter().filter_map(|e| if let AdapterEvent::Output { text } = e { Some(text.clone()) } else { None }).collect()
}

// ── Probe: capabilities detectadas ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn el_probe_declara_lo_que_la_cli_real_ofrece_y_steer_no() {
    let p = fake_probe();
    assert_eq!(p.environment, Environment::Ready);
    assert_eq!(p.cli_version.as_deref(), Some("2.1.296"));
    for c in [Capability::Start, Capability::Events, Capability::Answer, Capability::Interrupt, Capability::Resume] {
        assert!(p.matrix.is_available(c), "{}", c.code());
    }
    // Observado con la CLI real: un mensaje a mitad de turno se encola, no se inyecta.
    assert_eq!(p.matrix.state(Capability::Steer), &CapabilityState::Unsupported);
}

#[test]
fn en_una_version_sin_verificar_el_protocolo_de_control_no_se_declara_disponible() {
    let p = probe_from(true, Some("9.9.9"), Some(HELP));
    assert!(p.matrix.is_available(Capability::Start) && p.matrix.is_available(Capability::Events) && p.matrix.is_available(Capability::Resume));
    for c in [Capability::Answer, Capability::Interrupt] {
        let CapabilityState::Unavailable { reason } = p.matrix.state(c) else { panic!("{}: {:?}", c.code(), p.matrix.state(c)) };
        assert!(reason.contains("9.9.9") && reason.contains("2.1.296"), "{reason}");
    }
    // Sin versión legible, igual.
    assert!(!probe_from(true, None, Some(HELP)).matrix.is_available(Capability::Interrupt));
}

#[test]
fn sin_cli_o_sin_los_flags_el_entorno_esta_bloqueado_no_fallido() {
    let p = probe_from(false, None, None);
    assert_eq!(p.environment, Environment::Blocked { blocks: vec![EnvBlock::CliMissing] });
    assert!(!p.matrix.is_available(Capability::Start));

    let viejo = HELP.replace("stream-json", "jsonl");
    let p = probe_from(true, Some("2.1.296"), Some(&viejo));
    assert_eq!(p.environment, Environment::Blocked { blocks: vec![EnvBlock::CliFlagsUnsupported] });
    assert_eq!(p.matrix.state(Capability::Start), &CapabilityState::EnvironmentBlocked { block: EnvBlock::CliFlagsUnsupported });

    // Un --help ilegible no se interpreta: todo "no disponible" con su motivo, entorno listo.
    let p = probe_from(true, Some("2.1.296"), None);
    assert_eq!(p.environment, Environment::Ready);
    assert!(matches!(p.matrix.state(Capability::Start), CapabilityState::Unavailable { reason } if reason.contains("--help")));

    // Sin --resume o sin --permission-prompt-tool, esa capability es unsupported (no se simula).
    let sin = HELP.replace("--resume", "--reanudar").replace("--permission-prompt-tool", "--prompt-tool");
    let p = probe_from(true, Some("2.1.296"), Some(&sin));
    assert_eq!(p.matrix.state(Capability::Resume), &CapabilityState::Unsupported);
    assert_eq!(p.matrix.state(Capability::Answer), &CapabilityState::Unsupported);
}

// ── Argumentos ──────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn los_argumentos_siguen_el_perfil_y_el_prompt_no_va_en_el_argv() {
    let plan = build_args(Profile::Proponer, None, None, None, true).unwrap();
    for par in [["--input-format", "stream-json"], ["--output-format", "stream-json"], ["--permission-prompt-tool", "stdio"], ["--permission-mode", "plan"]] {
        assert!(plan.windows(2).any(|w| w == par), "falta {par:?} en {plan:?}");
    }
    assert!(plan.iter().any(|a| a.starts_with("--disallowedTools=") && a.contains("Write")), "los perfiles sin escritura quitan Write");
    assert!(!plan.iter().any(|a| a == "--no-session-persistence"), "la sesión debe poder reanudarse");

    let delegar = build_args(Profile::DelegarConRevision, None, None, None, true).unwrap();
    assert!(delegar.windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]));
    assert!(!delegar.iter().any(|a| a.starts_with("--disallowedTools")));
    let auto = build_args(Profile::AutonomiaAmplia, Some("opus"), Some("high"), None, false).unwrap();
    assert!(auto.windows(2).any(|w| w == ["--permission-mode", "auto"]) && auto.windows(2).any(|w| w == ["--model", "opus"]) && auto.windows(2).any(|w| w == ["--effort", "high"]));
    assert!(!auto.iter().any(|a| a == "--permission-prompt-tool"), "sin el flag en la CLI no se pasa");
    // Nunca se salta un permiso.
    for a in [&plan, &delegar, &auto] {
        assert!(!a.iter().any(|x| x.contains("dangerously") || x == "bypassPermissions"), "{a:?}");
    }

    let r = ProviderRef::new("sesion-abc").unwrap();
    assert!(build_args(Profile::Proponer, None, None, Some(&r), true).unwrap().windows(2).any(|w| w == ["--resume", "sesion-abc"]));
    assert_eq!(build_args(Profile::Proponer, Some("opus; rm -rf /"), None, None, true).unwrap_err().code, ErrorCode::InvalidRequest);
}

#[test]
fn start_lanza_con_los_flags_y_envia_el_prompt_por_stdin() {
    let l = FakeLauncher::new(script_of(NORMAL));
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    g.start(StartRequest { prompt: "secreto-del-usuario-123".into(), ..start_req("proponer") }, &CancelToken::new()).unwrap();

    let (spec, proc_) = l.last();
    assert_eq!(spec.program, PathBuf::from("claude-falso"));
    assert_eq!(spec.cwd, PathBuf::from("wt"));
    assert!(spec.args.windows(2).any(|w| w == ["--permission-prompt-tool", "stdio"]));
    assert!(!spec.args.iter().any(|a| a.contains("secreto-del-usuario")), "el prompt no va en el argv");
    assert!(spec.env.is_empty() && spec.env_remove.is_empty(), "sin endpoint no se toca el entorno");
    let w = proc_.written();
    assert_eq!(w[0]["type"], "user");
    assert_eq!(w[0]["message"]["content"][0]["text"], "secreto-del-usuario-123");
}

#[test]
fn una_peticion_invalida_no_lanza_ningun_proceso() {
    let l = FakeLauncher::new(script_of(NORMAL));
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    let c = CancelToken::new();
    for req in [
        StartRequest { prompt: "  ".into(), ..start_req("proponer") },
        StartRequest { attempt_id: "".into(), ..start_req("proponer") },
        StartRequest { worktree: PathBuf::new(), ..start_req("proponer") },
        start_req("saltar-permisos"),
        start_req("autonomia_amplia"), // deshabilitado por el producto
        StartRequest { model: Some("opus & calc".into()), ..start_req("proponer") },
    ] {
        assert_eq!(g.start(req, &c).unwrap_err().code, ErrorCode::InvalidRequest);
    }
    assert!(l.launched.lock().unwrap().is_empty());
}

// ── Endpoint (otros modelos con formato Anthropic) ────────────────────────────────────────────────────────────────────

#[test]
fn el_endpoint_valida_la_url_y_exige_la_variable_del_token() {
    assert!(Endpoint::new("https://api.ejemplo.com/anthropic", "MI_TOKEN", Some("glm-4.6")).is_ok());
    assert!(Endpoint::new("http://localhost:11434", "OLLAMA_TOKEN", None).is_ok());
    assert!(Endpoint::new("http://127.0.0.1:8080/", "T", None).is_ok());
    assert_eq!(Endpoint::new("https://api.ejemplo.com/", "T", None).unwrap().base_url, "https://api.ejemplo.com");
    for (url, token) in [
        ("http://api.ejemplo.com", "T"),          // http fuera del equipo
        ("https://user:pass@api.ejemplo.com", "T"), // credenciales en la URL
        ("https://api.ejemplo.com/?key=abc", "T"),  // query
        ("https://api.ejemplo.com/#x", "T"),
        ("ftp://api.ejemplo.com", "T"),
        ("api.ejemplo.com", "T"),
        ("https://api ejemplo.com", "T"),
        ("", "T"),
        ("https://api.ejemplo.com", ""),            // el token es obligatorio
        ("https://api.ejemplo.com", "sk-ant-api03-AAAA"), // un valor, no un nombre
        ("https://api.ejemplo.com", "minusculas"),
        ("https://api.ejemplo.com", "1TOKEN"),
    ] {
        assert_eq!(Endpoint::new(url, token, None).unwrap_err().code, ErrorCode::InvalidRequest, "{url} / {token}");
    }
    assert!(Endpoint::new("https://api.ejemplo.com", "T", Some("modelo; calc")).is_err());
}

#[test]
fn con_un_endpoint_el_token_sale_de_su_variable_y_no_se_filtran_las_credenciales_propias() {
    let ep = Endpoint::new("https://otro.servicio.com/v1", "TOKEN_AJENO", Some("glm-4.6")).unwrap();
    let c = ClaudeConfig { id: "claude-ajeno".into(), endpoint: Some(ep), ..cfg() };
    let (env, remove) = launch_env(&c, &|k| (k == "TOKEN_AJENO").then(|| "valor-del-token-ajeno".to_string())).unwrap();
    assert!(env.contains(&("ANTHROPIC_BASE_URL".into(), "https://otro.servicio.com/v1".into())));
    assert!(env.contains(&("ANTHROPIC_AUTH_TOKEN".into(), "valor-del-token-ajeno".into())));
    // La clave y el token de sesión del usuario no llegan al servicio ajeno.
    assert!(remove.contains(&"ANTHROPIC_API_KEY".to_string()) && remove.contains(&"CLAUDE_CODE_OAUTH_TOKEN".to_string()));

    // Sin la variable definida (o vacía) no se lanza: nunca se cae a la credencial del usuario.
    for v in [None, Some("  ".to_string())] {
        let e = launch_env(&c, &|_| v.clone()).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidRequest);
        assert!(e.message.contains("TOKEN_AJENO"));
    }
    // Sin endpoint, el entorno no se toca.
    assert_eq!(launch_env(&cfg(), &|_| Some("x".into())).unwrap(), (vec![], vec![]));

    // El token no sale en un Debug (logs, paneles de error).
    let spec = LaunchSpec { program: "claude".into(), args: vec![], cwd: "wt".into(), env, env_remove: remove };
    let dbg = format!("{spec:?}");
    assert!(!dbg.contains("valor-del-token-ajeno") && dbg.contains("ANTHROPIC_AUTH_TOKEN"), "{dbg}");
}

#[test]
fn el_modelo_del_endpoint_se_usa_si_la_peticion_no_trae_otro() {
    let ep = Endpoint::new("https://otro.servicio.com", "TOKEN_AJENO_X", Some("glm-4.6")).unwrap();
    std::env::set_var("TOKEN_AJENO_X", "t");
    let l = FakeLauncher::new(script_of(NORMAL));
    let reg = registro(adapter(ClaudeConfig { id: "claude-ajeno".into(), endpoint: Some(ep), ..cfg() }, l.clone()));
    let g = reg.gated("claude-ajeno").unwrap();
    g.start(start_req("proponer"), &CancelToken::new()).unwrap();
    assert!(l.last().0.args.windows(2).any(|w| w == ["--model", "glm-4.6"]));
    g.start(StartRequest { model: Some("otro-modelo".into()), ..start_req("proponer") }, &CancelToken::new()).unwrap();
    assert!(l.last().0.args.windows(2).any(|w| w == ["--model", "otro-modelo"]));
    std::env::remove_var("TOKEN_AJENO_X");
}

// ── start → events → finish ───────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn start_events_finish_con_la_captura_real() {
    let (got, outcome, _) = corre(script_of(NORMAL), "");
    assert!(matches!(&got[0], AdapterEvent::SessionBound { provider_ref } if provider_ref.expose() == SESSION), "{:?}", got[0]);
    assert_eq!(got[1], AdapterEvent::Model { model: "claude-haiku-5-5".into() });
    let out = salida(&got);
    assert!(out[0].starts_with("1\n2\n3\n"), "{:?}", out[0]);
    let usage = got.iter().find_map(|e| if let AdapterEvent::Usage { output_tokens, cost_usd, .. } = e { Some((*output_tokens, *cost_usd)) } else { None }).expect("usage");
    assert!(usage.0.is_some_and(|t| t > 0) && usage.1.is_some_and(|c| c > 0.0), "{usage:?}");
    let RunOutcome::Completed { summary } = outcome else { panic!("{outcome:?}") };
    assert!(summary.unwrap().starts_with("1\n2\n3"));
}

#[test]
fn el_id_de_sesion_es_opaco_y_no_aparece_en_ninguna_salida_imprimible() {
    let (got, _, _) = corre(script_of(NORMAL), "");
    for e in &got {
        assert!(!format!("{e:?}").contains(SESSION), "{e:?}");
    }
}

#[test]
fn el_texto_del_modelo_se_acota_por_evento_y_por_ejecucion() {
    let texto = |n: usize| json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "a".repeat(n)}]}});
    // Un texto enorme: un solo evento acotado y marcado.
    let (got, _, _) = corre([vec![json!({"__gate": "prompt"}), texto(10_000)], vec![json!({"type": "result", "subtype": "success", "is_error": false})]].concat(), "");
    let out = salida(&got);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].chars().count(), MAX_OUTPUT_EVENT_CHARS + TRUNCATED.chars().count());
    assert!(out[0].ends_with(TRUNCATED));

    // Muchos textos: al pasar el techo solo queda un aviso, una vez, y no se emite más.
    let mut s = vec![json!({"__gate": "prompt"})];
    s.extend((0..40).map(|_| texto(4_000)));
    s.push(json!({"type": "result", "subtype": "success", "is_error": false}));
    let (got, outcome, _) = corre(s, "");
    let out = salida(&got);
    let total: usize = out.iter().map(|t| t.chars().count()).sum();
    assert!(total <= MAX_OUTPUT_TOTAL_CHARS + 2 * (TRUNCATED.chars().count() + OUTPUT_EXHAUSTED.chars().count()), "{total}");
    assert_eq!(out.iter().filter(|t| t.as_str() == OUTPUT_EXHAUSTED).count(), 1);
    assert_eq!(out.last().unwrap(), OUTPUT_EXHAUSTED);
    assert!(matches!(outcome, RunOutcome::Completed { .. }), "el recorte no falla la ejecución");
}

// ── Permisos ──────────────────────────────────────────────────────────────────────────────────────────────────────────

fn corre_con_permiso(decision: &str) -> (Vec<AdapterEvent>, RunOutcome, Arc<FakeLauncher>) {
    let l = FakeLauncher::new(script_of(PERMISO));
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("delegar_con_revision"), &cancel).unwrap();
    let (tx, rx) = mpsc::channel();
    let (got, outcome) = std::thread::scope(|s| {
        let h = s.spawn(|| g.events(&run, &cancel, &mut |e: AdapterEvent| tx.send(e).unwrap()));
        let mut got = vec![];
        loop {
            let e = rx.recv_timeout(Duration::from_secs(5)).expect("llegó la petición de permiso");
            let ask = if let AdapterEvent::Permission { request_id, .. } = &e { Some(request_id.clone()) } else { None };
            got.push(e);
            if let Some(id) = ask {
                // Nada se ha respondido por su cuenta.
                assert!(l.last().1.written().iter().all(|w| w["type"] != "control_response"), "el adapter no responde solo");
                // Una respuesta que no es allow/deny, o a otro id, se rechaza sin tocar la CLI.
                assert_eq!(g.answer(&run, Answer { question_id: id.clone(), text: "quizás".into() }).unwrap_err().code, ErrorCode::InvalidRequest);
                assert_eq!(g.answer(&run, Answer { question_id: "otro".into(), text: "allow".into() }).unwrap_err().code, ErrorCode::InvalidRequest);
                assert!(l.last().1.written().iter().all(|w| w["type"] != "control_response"));
                g.answer(&run, Answer { question_id: id, text: decision.into() }).unwrap();
                break;
            }
        }
        let outcome = h.join().unwrap().unwrap();
        got.extend(rx.try_iter());
        (got, outcome)
    });
    (got, outcome, l)
}

#[test]
fn el_permiso_llega_al_core_que_decide_y_allow_devuelve_la_entrada_original() {
    let (got, outcome, l) = corre_con_permiso("allow");
    let AdapterEvent::Permission { request_id, tool, summary } = got.iter().find(|e| matches!(e, AdapterEvent::Permission { .. })).unwrap() else { unreachable!() };
    assert_eq!((tool.as_str(), summary.as_str()), ("Write", "/work/hola.txt"));
    assert_eq!(request_id, "04eed0e3-f388-49d7-8e32-d0ab8543fe81");

    let resp = l.last().1.written().into_iter().find(|w| w["type"] == "control_response").expect("respuesta");
    assert_eq!(resp["response"]["subtype"], "success");
    assert_eq!(resp["response"]["request_id"], *request_id);
    assert_eq!(resp["response"]["response"]["behavior"], "allow");
    assert_eq!(resp["response"]["response"]["updatedInput"], json!({"file_path": "/work/hola.txt", "content": "lxo"}));
    assert!(matches!(outcome, RunOutcome::Completed { .. }), "{outcome:?}");
}

#[test]
fn deny_responde_con_el_mensaje_de_la_policy_y_sin_entrada() {
    let (_, _, l) = corre_con_permiso("deny");
    let resp = l.last().1.written().into_iter().find(|w| w["type"] == "control_response").unwrap();
    assert_eq!(resp["response"]["response"]["behavior"], "deny");
    assert_eq!(resp["response"]["response"]["message"], DENY_MESSAGE);
    assert!(resp["response"]["response"].get("updatedInput").is_none());
}

#[test]
fn el_resumen_de_la_herramienta_no_copia_el_contenido() {
    let (got, _, _) = corre_con_permiso("allow");
    for e in &got {
        // `content: "lxo"` es el contenido del trabajo: ni el resumen ni ningún evento lo llevan.
        if let AdapterEvent::Permission { summary, .. } | AdapterEvent::ToolUse { summary, .. } = e {
            assert_eq!(summary, "/work/hola.txt");
        }
    }
    assert_eq!(summarize_tool(&json!({"command": "ls -la\nrm secreto", "content": "API_KEY=zzz"})), "ls -la", "una línea y sin contenido");
    assert_eq!(summarize_tool(&json!({"content": "solo contenido"})), "");
}

// ── Interrupt y cancelación ───────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn interrupt_termina_interrupted_con_el_protocolo_real() {
    let l = FakeLauncher::new(script_of(INTERRUMPIR));
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("proponer"), &cancel).unwrap();
    let (tx, rx) = mpsc::channel();
    let outcome = std::thread::scope(|s| {
        let h = s.spawn(|| g.events(&run, &cancel, &mut |e: AdapterEvent| tx.send(e).unwrap()));
        loop {
            if let AdapterEvent::Output { .. } = rx.recv_timeout(Duration::from_secs(5)).expect("primer texto") {
                break;
            }
        }
        g.interrupt(&run).unwrap();
        h.join().unwrap().unwrap()
    });
    assert_eq!(outcome, RunOutcome::Interrupted, "una interrupción pedida NO es un fallo del Attempt");
    let req = l.last().1.written().into_iter().find(|w| w["type"] == "control_request").expect("control_request");
    assert_eq!(req["request"]["subtype"], "interrupt");
    assert_eq!(req["request_id"], "lxo-int-1");
}

#[test]
fn interrupt_exige_que_la_sesion_lo_declare() {
    // Antes del init: aún no se sabe.
    let l = FakeLauncher::new(vec![json!({"__gate": "prompt"}), json!({"__gate": "never"})]);
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    let run = g.start(start_req("proponer"), &CancelToken::new()).unwrap();
    let e = g.interrupt(&run).unwrap_err();
    assert_eq!((e.code, e.kind()), (ErrorCode::CapabilityUnavailable, FailureKind::Rejected));
    assert!(l.last().1.written().iter().all(|w| w["type"] != "control_request"));

    // Un init que no declara interrupt_*: tampoco.
    let mut s = script_of(INTERRUMPIR);
    for v in s.iter_mut() {
        if v["subtype"] == "init" {
            v["capabilities"] = json!(["msg_lifecycle_v1"]);
        }
    }
    let l = FakeLauncher::new(s);
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("proponer"), &cancel).unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::scope(|s| {
        let h = s.spawn(|| g.events(&run, &cancel, &mut |e: AdapterEvent| tx.send(e).unwrap()));
        loop {
            if let AdapterEvent::Output { .. } = rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                break;
            }
        }
        let e = g.interrupt(&run).unwrap_err();
        assert_eq!(e.code, ErrorCode::CapabilityUnavailable);
        assert!(e.message.contains("no declara"), "{}", e.message);
        cancel.cancel();
        h.join().unwrap().unwrap();
    });
}

#[test]
fn cancelar_mata_el_proceso_y_termina_cancelled() {
    let l = FakeLauncher::new(vec![json!({"__gate": "prompt"}), json!({"type": "system", "subtype": "init", "session_id": SESSION}), json!({"__gate": "never"})]);
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("proponer"), &cancel).unwrap();
    let (tx, rx) = mpsc::channel();
    let outcome = std::thread::scope(|s| {
        let h = s.spawn(|| g.events(&run, &cancel, &mut |e: AdapterEvent| tx.send(e).unwrap()));
        assert!(matches!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), AdapterEvent::SessionBound { .. }));
        cancel.cancel();
        h.join().unwrap().unwrap()
    });
    assert_eq!(outcome, RunOutcome::Cancelled);
    assert!(l.last().1.was_killed(), "la CLI no queda huérfana");
    // La ejecución ya no existe.
    assert_eq!(g.interrupt(&run).unwrap_err().code, ErrorCode::UnknownRun);
}

#[test]
fn terminar_siempre_mata_el_proceso() {
    let (_, outcome, l) = corre(script_of(NORMAL), "");
    assert!(matches!(outcome, RunOutcome::Completed { .. }));
    assert!(l.last().1.was_killed());
}

// ── Errores, flujo malformado y final incompleto ─────────────────────────────────────────────────────────────────────

#[test]
fn los_reintentos_de_red_son_informativos_y_un_flujo_cortado_es_un_fallo_con_diagnostico() {
    let (got, outcome, _) = corre(script_of(ERROR_RED), "ECONNREFUSED 127.0.0.1:9");
    let retries: Vec<(u32, u32)> = got.iter().filter_map(|e| if let AdapterEvent::Retry { attempt, max, .. } = e { Some((*attempt, *max)) } else { None }).collect();
    assert_eq!(retries, [(1, 10), (2, 10), (3, 10)]);
    let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
    assert_eq!((e.code, e.kind()), (ErrorCode::Provider, FailureKind::AttemptFailure));
    assert!(e.message.contains("sin resultado"), "{}", e.message);
    assert!(e.diagnostic.as_deref().unwrap().contains("ECONNREFUSED"), "{:?}", e.diagnostic);
}

#[test]
fn un_result_con_error_es_un_fallo_con_su_motivo() {
    let (_, outcome, _) = corre(
        vec![json!({"__gate": "prompt"}), json!({"type": "result", "subtype": "error_during_execution", "is_error": true, "terminal_reason": "model_error", "result": "límite de cuota agotado"})],
        "",
    );
    let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
    assert!(e.message.contains("error_during_execution"));
    let d = e.diagnostic.unwrap();
    assert!(d.contains("model_error") && d.contains("cuota"), "{d}");
}

#[test]
fn lineas_malformadas_se_saltan_sin_corromper_la_ejecucion() {
    let mut s = script_of(NORMAL);
    s.insert(2, Value::String("esto no es json".into()));
    s.insert(3, Value::String("[1, 2, 3]".into()));
    s.insert(4, Value::String("{\"type\":\"assistant\",\"message\":{\"con".into()));
    s.insert(5, Value::String("".into()));
    let (got, outcome, _) = corre(s, "");
    assert!(matches!(outcome, RunOutcome::Completed { .. }), "{outcome:?}");
    assert!(!salida(&got).is_empty());
}

#[test]
fn un_final_incompleto_es_un_fallo_y_no_un_exito_ni_un_panico() {
    let mut s = script_of(NORMAL);
    let result = s.pop().unwrap().to_string();
    s.push(Value::String(result[..result.len() / 2].to_string()));
    let (got, outcome, _) = corre(s, "");
    let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
    assert!(e.message.contains("sin resultado") && e.diagnostic.as_deref().unwrap().contains("malformadas: 1"), "{e:?}");
    // Lo recibido antes sigue siendo válido.
    assert!(!salida(&got).is_empty());
}

#[test]
fn el_parser_nunca_entra_en_panico() {
    for l in ["", "   ", "null", "42", "\"x\"", "{", "{}", "{\"type\":5}", "{\"type\":\"assistant\"}", "{\"type\":\"assistant\",\"message\":{\"content\":3}}", "{\"type\":\"system\",\"subtype\":\"init\"}", "{\"type\":\"control_request\",\"request\":{}}", "{\"type\":\"result\",\"usage\":7}", "\u{0}\u{1}"] {
        let _ = parse_line(l);
    }
    assert_eq!(parse_line("{\"type\":\"system\",\"subtype\":\"hook_started\"}"), [Msg::Ignored]);
    // `rate_limit_event` se lee desde LXO-205, pero solo las ventanas: ni `session_id` ni el resto.
    assert!(matches!(parse_line("{\"type\":\"rate_limit_event\"}")[..], [Msg::RateLimit(_)]));
}

#[test]
fn el_razonamiento_y_los_resultados_de_herramientas_no_se_copian() {
    let line = json!({"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "plan secreto", "signature": "FIRMA"}, {"type": "text", "text": "hola"}]}}).to_string();
    assert_eq!(parse_line(&line), [Msg::Text("hola".into())]);
    let user = json!({"type": "user", "message": {"content": [{"type": "tool_result", "content": "contenido del archivo"}]}}).to_string();
    assert_eq!(parse_line(&user), [Msg::Ignored]);
}

// ── Secretos ──────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn ningun_secreto_sale_del_adapter() {
    let script = vec![
        json!({"__gate": "prompt"}),
        json!({"type": "system", "subtype": "init", "session_id": SESSION, "model": "modelo sk-ant-api03-AAAAAAAAAAAAAAAA", "capabilities": []}),
        json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "mi clave es sk-ant-api03-AAAAAAAAAAAAAAAAAAAA y Authorization: Bearer abc.def.ghi"}]}}),
        json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": "curl -H 'token=abc123def456ghi789' https://x", "content": "API_KEY=zzzzzzzzzzzz"}}]}}),
        json!({"type": "control_request", "request_id": "r1", "request": {"subtype": "can_use_tool", "tool_name": "Write", "input": {"file_path": "/work/.env", "content": "password=hunter2hunter2"}}}),
        json!({"__gate": "control_response"}),
        json!({"type": "result", "subtype": "success", "is_error": false, "result": "listo, token=abc123def456ghi789"}),
    ];
    let l = FakeLauncher::new(script);
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("proponer"), &cancel).unwrap();
    let (tx, rx) = mpsc::channel();
    let (mut todos, outcome) = std::thread::scope(|s| {
        let h = s.spawn(|| g.events(&run, &cancel, &mut |e: AdapterEvent| tx.send(e).unwrap()));
        let mut todos = vec![];
        loop {
            let e = rx.recv_timeout(Duration::from_secs(5)).expect("llega la petición de permiso");
            let ask = if let AdapterEvent::Permission { request_id, .. } = &e { Some(request_id.clone()) } else { None };
            todos.push(e);
            if let Some(id) = ask {
                g.answer(&run, Answer { question_id: id, text: "deny".into() }).unwrap();
                break;
            }
        }
        (todos, h.join().unwrap().unwrap())
    });
    todos.extend(rx.try_iter());
    assert!(todos.len() >= 5, "se vieron todos los eventos: {todos:?}");

    for e in &todos {
        let dbg = format!("{e:?}");
        for centinela in ["AAAAAAAAAAAA", "abc123def456", "abc.def.ghi", "hunter2", "zzzzzzzz"] {
            assert!(!dbg.contains(centinela), "{centinela} salió en {dbg}");
        }
        let textos: Vec<&str> = match e {
            AdapterEvent::Output { text } | AdapterEvent::Question { text, .. } => vec![text],
            AdapterEvent::Model { model } => vec![model],
            AdapterEvent::Permission { tool, summary, .. } | AdapterEvent::ToolUse { tool, summary } => vec![tool, summary],
            _ => vec![],
        };
        for t in textos {
            assert!(!looks_secret(t), "con forma de secreto: {t}");
        }
    }
    // Los dos que lo llevaban dentro quedaron redactados, no borrados.
    assert!(todos.iter().any(|e| matches!(e, AdapterEvent::Output { text } if text.contains(REDACTED))));
    // El contenido de las herramientas no entra: el resumen es solo el comando / la ruta.
    assert!(todos.iter().any(|e| matches!(e, AdapterEvent::Permission { summary, .. } if summary == "/work/.env")));
    let RunOutcome::Completed { summary } = outcome else { panic!("{outcome:?}") };
    assert!(!summary.unwrap().contains("abc123def456"));
}

#[test]
fn el_stderr_del_proceso_acompana_al_fallo_ya_redactado() {
    let (_, outcome, _) = corre(vec![json!({"__gate": "prompt"})], "fallo de login: token=abc123def456ghi789 rechazado");
    let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
    let d = e.diagnostic.unwrap();
    assert!(d.contains("rechazado") && !d.contains("abc123def456"), "{d}");
}

// ── Capabilities a través de Gated, steer y resume ───────────────────────────────────────────────────────────────────

#[test]
fn steer_se_rechaza_sin_llegar_al_proceso() {
    let l = FakeLauncher::new(vec![json!({"__gate": "prompt"}), json!({"__gate": "never"})]);
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    let run = g.start(start_req("proponer"), &CancelToken::new()).unwrap();
    let e = g.steer(&run, "cambia de plan").unwrap_err();
    assert_eq!(e.code, ErrorCode::UnsupportedCapability);
    // Solo se escribió el mensaje inicial.
    assert_eq!(l.last().1.written().len(), 1);
}

#[test]
fn resume_lanza_con_resume_y_el_perfil_original() {
    let l = FakeLauncher::new(script_of(NORMAL));
    let reg = registro(adapter(cfg(), l.clone()));
    let g = reg.gated(ID).unwrap();
    let r = ProviderRef::new("sesion-previa-7").unwrap();
    let req = |prompt: Option<&str>| ResumeRequest { attempt_id: "a2".into(), provider_ref: r.clone(), worktree: PathBuf::from("wt"), prompt: prompt.map(str::to_string), profile: "delegar_con_revision".into(), model: Some("opus".into()), effort: None };
    let run = g.resume(req(Some("sigue donde lo dejaste")), &CancelToken::new()).unwrap();
    assert_eq!(run.attempt_id, "a2");
    let (spec, proc_) = l.last();
    assert!(spec.args.windows(2).any(|w| w == ["--resume", "sesion-previa-7"]));
    assert!(spec.args.windows(2).any(|w| w == ["--permission-mode", "acceptEdits"]), "conserva el perfil original");
    assert!(spec.args.windows(2).any(|w| w == ["--model", "opus"]));
    assert_eq!(proc_.written()[0]["message"]["content"][0]["text"], "sigue donde lo dejaste");
    // Sin mensaje no hay nada con qué continuar.
    assert_eq!(g.resume(req(None), &CancelToken::new()).unwrap_err().code, ErrorCode::InvalidRequest);
}

#[test]
fn varias_configuraciones_conviven_con_ids_distintos() {
    std::env::set_var("TOKEN_MULTI_X", "t");
    let ep = Endpoint::new("http://localhost:11434", "TOKEN_MULTI_X", Some("qwen3")).unwrap();
    let l1 = FakeLauncher::new(script_of(NORMAL));
    let l2 = FakeLauncher::new(script_of(NORMAL));
    let mut reg = AdapterRegistry::new();
    reg.register(adapter(cfg(), l1.clone())).unwrap();
    reg.register(adapter(ClaudeConfig { id: "claude-local".into(), endpoint: Some(ep), ..cfg() }, l2.clone())).unwrap();
    // El mismo id dos veces se rechaza.
    assert!(reg.register(adapter(cfg(), l1.clone())).is_err());
    let snap = reg.snapshot();
    assert_eq!(snap.providers.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["claude", "claude-local"]);
    reg.gated("claude-local").unwrap().start(start_req("proponer"), &CancelToken::new()).unwrap();
    let (spec, _) = l2.last();
    assert!(spec.env.iter().any(|(k, _)| k == "ANTHROPIC_BASE_URL") && l1.launched.lock().unwrap().is_empty());
    std::env::remove_var("TOKEN_MULTI_X");
}

// ── Validación manual con la CLI real ─────────────────────────────────────────────────────────────────────────────────

/// `cargo test --lib orch::adapter::claude::tests::real_claude -- --ignored --nocapture`: lanza `claude` de verdad (modelo
/// haiku, una línea de prompt, perfil de solo lectura) y comprueba start→events→finish con el lanzador real.
#[test]
#[ignore = "validación manual: lanza la CLI real de Claude y usa la cuenta del usuario"]
fn real_claude_start_events_finish() {
    let a = Arc::new(ClaudeAdapter::new(ClaudeConfig::default()));
    let probe = a.probe();
    println!("probe: {probe:#?}");
    assert_eq!(probe.environment, Environment::Ready, "claude no está listo en esta máquina");
    let dir = std::env::temp_dir().join(format!("lxo-real-claude-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let reg = registro(a);
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g
        .start(StartRequest { attempt_id: "real-1".into(), worktree: dir.clone(), prompt: "Responde solo la palabra OK.".into(), profile: "explorar".into(), model: Some("haiku".into()), effort: None }, &cancel)
        .unwrap();
    let mut got = vec![];
    let outcome = g.events(&run, &cancel, &mut |e: AdapterEvent| got.push(e)).unwrap();
    println!("eventos: {got:#?}\nresultado: {outcome:?}");
    assert!(matches!(got.first(), Some(AdapterEvent::SessionBound { .. })), "la sesión debe anunciarse primero");
    assert!(matches!(outcome, RunOutcome::Completed { .. }), "{outcome:?}");
    let _ = std::fs::remove_dir_all(dir);
}

// ── Usage (LXO-205) ─────────────────────────────────────────────────────────────────────────────────────────────────

const USAGE_CMD: &str = include_str!("../../testdata/claude-2.1.296-usage-comando.jsonl");

/// Una versión que no está entre las verificadas: `/usage` no se prueba (podría llegar al modelo).
fn adapter_sin_verificar(l: Arc<FakeLauncher>) -> Arc<ClaudeAdapter> {
    Arc::new(ClaudeAdapter::with_parts(cfg(), l, Arc::new(|| probe_from(true, Some("9.9.9"), Some(HELP)))))
}

#[test]
fn antes_de_cualquier_ejecucion_y_sin_version_verificada_claude_no_inventa_limites() {
    use crate::orch::adapter::{UsageErrorKind, UsageField};
    let l = FakeLauncher::new(vec![]);
    let a = adapter_sin_verificar(l.clone());
    assert!(matches!(a.usage_support().state(UsageField::Windows), CapabilityState::Unavailable { .. }));
    assert_eq!(a.usage_support().state(UsageField::Tokens), &CapabilityState::Unsupported);
    assert_eq!(a.usage(&CancelToken::new()).unwrap_err().kind, UsageErrorKind::ProviderUnavailable);
    assert!(l.launched.lock().unwrap().is_empty(), "en una versión sin verificar no se lanza `/usage`");
}

#[test]
fn el_uso_de_claude_sale_del_comando_local_usage_sin_llamar_al_modelo() {
    use crate::orch::adapter::{Provenance, UsageField};
    let l = FakeLauncher::new(script_of(USAGE_CMD));
    let a = adapter(cfg(), l.clone());
    assert!(a.usage_support().state(UsageField::Windows).is_available());
    let snap = a.usage(&CancelToken::new()).unwrap();

    assert_eq!(snap.provenance, Provenance::ProviderQuery, "se pregunta ahora a la propia CLI");
    let w: Vec<_> = snap.windows.iter().map(|w| (w.id.as_str(), w.minutes, w.used_percent, w.resets_at)).collect();
    assert_eq!(w, [("five_hour", Some(300), Some(72.0), None), ("seven_day", Some(10080), Some(10.0), None)], "la hora de reinicio (texto con zona IANA) no se adivina");
    assert_eq!(snap.limit_reached, None);
    assert!(snap.plan.is_none() && snap.credits.is_none() && snap.models.is_empty());
    let dump = format!("{snap:?}");
    assert!(!dump.contains("habilidad") && !dump.contains("servidor-a"), "la actividad local de la persona no se copia");

    let (spec, proc_) = l.last();
    assert_eq!(spec.args, ["-p", "/usage", "--output-format", "stream-json", "--verbose"]);
    assert!(proc_.written().is_empty(), "no se manda ningún mensaje de usuario");
    assert!(proc_.was_killed());
}

#[test]
fn si_usage_llega_al_modelo_se_corta_al_instante_y_no_se_usa_el_texto() {
    use crate::orch::adapter::UsageErrorKind;
    let mut s = script_of(USAGE_CMD);
    s[1]["message"]["model"] = json!("claude-sonnet-5-5");
    let l = FakeLauncher::new(s);
    let a = adapter(cfg(), l.clone());
    let e = a.usage(&CancelToken::new()).unwrap_err();
    assert_eq!(e.kind, UsageErrorKind::ProviderUnavailable);
    assert!(e.message.contains("no es un comando local"));
    assert!(l.last().1.was_killed(), "el proceso se mata en cuanto aparece un mensaje del modelo");
}

#[test]
fn una_cuenta_sin_limites_en_usage_no_inventa_ventanas() {
    use crate::orch::adapter::UsageErrorKind;
    let mut s = script_of(USAGE_CMD);
    let t = "You are currently using an API key.\n\nLast 24h · 3 requests";
    s[1]["message"]["content"][0]["text"] = json!(t);
    s[2]["result"] = json!(t);
    let a = adapter(cfg(), FakeLauncher::new(s));
    assert_eq!(a.usage(&CancelToken::new()).unwrap_err().kind, UsageErrorKind::ProviderUnavailable);
}

#[test]
fn tras_una_ejecucion_sin_comando_los_limites_son_una_observacion_de_esa_ejecucion() {
    use crate::orch::adapter::{Provenance, UsageField};
    let l = FakeLauncher::new(script_of(NORMAL));
    let a = adapter_sin_verificar(l);
    let reg = registro(Arc::clone(&a));
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("proponer"), &cancel).unwrap();
    g.events(&run, &cancel, &mut |_e: AdapterEvent| {}).unwrap();

    assert!(a.usage_support().state(UsageField::Windows).is_available());
    let snap = a.usage(&CancelToken::new()).unwrap();
    assert_eq!(snap.provenance, Provenance::RunObservation, "sin `/usage`, lo último que Claude dijo mientras ejecutaba");
    let w: Vec<_> = snap.windows.iter().map(|w| (w.id.as_str(), w.minutes, w.used_percent, w.resets_at)).collect();
    // Lo último que dijo la captura: 14 % en 5 h y 2 % en 7 d.
    assert_eq!(w, [("five_hour", Some(300), Some(14.0), Some(1793054400)), ("seven_day", Some(10080), Some(2.0), Some(1793613600))]);
    assert_eq!(snap.limit_reached, Some(false));
    assert_eq!(snap.plan, None, "Claude no dice el plan: desconocido");
    assert!(snap.models.is_empty() && snap.credits.is_none(), "no se rellena lo que no se informó");
}

#[test]
fn con_un_endpoint_ajeno_no_se_atribuyen_limites_de_anthropic() {
    use crate::orch::adapter::UsageErrorKind;
    let c = ClaudeConfig { id: "claude-local".into(), endpoint: Some(Endpoint::new("http://127.0.0.1:9", "LXO_TOKEN_LOCAL", Some("modelo")).unwrap()), ..cfg() };
    let l = FakeLauncher::new(script_of(USAGE_CMD));
    let a = adapter(c, l.clone());
    assert!(!a.usage_support().offers_anything());
    assert_eq!(a.usage(&CancelToken::new()).unwrap_err().kind, UsageErrorKind::Unsupported);
    assert!(l.launched.lock().unwrap().is_empty());
}

#[test]
fn un_rate_limit_event_raro_no_rompe_el_flujo_ni_se_vuelve_cero() {
    let m = parse_line(r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":7.5}}}}"#);
    let Msg::RateLimit(info) = &m[0] else { panic!("{m:?}") };
    assert_eq!(info.windows[0].utilization, Some(7.5));
    assert_eq!(info.windows[0].resets_at, None);
    assert_eq!(parse_line(r#"{"type":"rate_limit_event"}"#), vec![Msg::RateLimit(super::stream::RateInfo { status: None, windows: vec![] })]);
}

#[test]
fn el_texto_de_usage_solo_aporta_lineas_de_limite() {
    use super::usage::windows_from;
    let ids = |t: &str| windows_from(t).into_iter().map(|w| (w.id, w.used_percent)).collect::<Vec<_>>();
    assert_eq!(ids("Current session: 100% used · resets mañana"), [("five_hour".to_string(), Some(100.0))]);
    assert_eq!(ids("Current week (Opus 4): 5% used"), [("seven_day_opus_4".to_string(), Some(5.0))]);
    assert!(ids("Current session: 101% used").is_empty(), "más de 100 % no es un porcentaje");
    assert!(ids("Current session: lots used\nLast 24h · 3 requests\n  Top skills: /x 6%").is_empty());
    assert!(ids("").is_empty());
}

/// Validación manual de LXO-205: `claude -p /usage` real. Es un comando local: no llama al modelo ni gasta cuota.
#[test]
#[ignore = "validación manual: lanza la CLI real de Claude (comando local /usage, sin modelo)"]
fn real_claude_usage_comando_local() {
    let a = ClaudeAdapter::new(ClaudeConfig::default());
    let probe = a.probe();
    println!("version: {:?}", probe.cli_version);
    let snap = a.usage(&CancelToken::new()).expect("`claude /usage` respondió");
    println!("{snap:#?}");
    assert_eq!(snap.provenance, crate::orch::adapter::Provenance::ProviderQuery);
    assert!(snap.windows.iter().any(|w| w.id == "five_hour" && w.used_percent.is_some()));
}
