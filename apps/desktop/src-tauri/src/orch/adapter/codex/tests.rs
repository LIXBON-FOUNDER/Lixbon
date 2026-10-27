//! Pruebas del adapter de Codex (LXO-130 y LXO-131). Los guiones son capturas REALES de `codex app-server` 0.164.0
//! (saneadas); `real_codex_*` (ignoradas por defecto) lanzan la CLI de verdad para la validación manual.

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::fake::{script_of, FakeLauncher};
use super::*;
use crate::orch::adapter::{AdapterRegistry, Environment, FailureKind, Gated, REDACTED};
use crate::store::looks_secret;

const HELP: &str = include_str!("../../testdata/codex-0.164.0-help.txt");
const EXEC_HELP: &str = include_str!("../../testdata/codex-0.164.0-exec-help.txt");
const NORMAL: &str = include_str!("../../testdata/codex-0.164.0-adapter-normal.jsonl");
const INTERRUMPIR: &str = include_str!("../../testdata/codex-0.164.0-adapter-interrumpir.jsonl");
const DIRIGIR: &str = include_str!("../../testdata/codex-0.164.0-adapter-dirigir.jsonl");
const APROBAR: &str = include_str!("../../testdata/codex-0.164.0-adapter-aprobar.jsonl");
const REANUDAR: &str = include_str!("../../testdata/codex-0.164.0-adapter-reanudar.jsonl");
const EXEC: &str = include_str!("../../testdata/codex-0.164.0-adapter-exec.jsonl");

fn cfg() -> CodexConfig {
    CodexConfig { program: Some(PathBuf::from("codex-falso")), ..CodexConfig::default() }
}

fn plan_app_server() -> Plan {
    probe_from(true, Some("0.164.0"), Some(HELP), Some(EXEC_HELP), Some(Readiness::Ready))
}

fn plan_exec() -> Plan {
    probe_from(true, Some("9.9.9"), Some(HELP), Some(EXEC_HELP), None)
}

fn registro(plan: Plan, l: Arc<FakeLauncher>) -> AdapterRegistry {
    let mut r = AdapterRegistry::new();
    r.register(Arc::new(CodexAdapter::with_parts(cfg(), l, Arc::new(move || plan.clone())))).unwrap();
    r
}

fn start_req(profile: &str) -> StartRequest {
    StartRequest { attempt_id: "a1".into(), worktree: PathBuf::from("wt"), prompt: "haz algo".into(), profile: profile.into(), model: None, effort: None }
}

/// Corre una ejecución sin interacción.
fn corre(plan: Plan, script: Vec<Value>, stderr: &str) -> (Vec<AdapterEvent>, RunOutcome, Arc<FakeLauncher>) {
    let l = FakeLauncher::with_stderr(script, stderr);
    let reg = registro(plan, l.clone());
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("proponer"), &cancel).unwrap();
    let mut got = vec![];
    let outcome = g.events(&run, &cancel, &mut |e: AdapterEvent| got.push(e)).unwrap();
    (got, outcome, l)
}

/// Corre `events` en otro hilo mientras `accion` actúa sobre la ejecución viva (steer, interrupt, answer…).
fn corre_con(script: Vec<Value>, profile: &str, accion: impl FnOnce(&Gated, &RunHandle, &Receiver<AdapterEvent>) -> Vec<AdapterEvent>) -> (Vec<AdapterEvent>, RunOutcome, Arc<FakeLauncher>) {
    let l = FakeLauncher::new(script);
    let reg = registro(plan_app_server(), l.clone());
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req(profile), &cancel).unwrap();
    let (tx, rx) = mpsc::channel();
    let (mut vistos, outcome) = std::thread::scope(|s| {
        let h = s.spawn(|| g.events(&run, &cancel, &mut |e: AdapterEvent| tx.send(e).unwrap()));
        let vistos = accion(&g, &run, &rx);
        (vistos, h.join().unwrap().unwrap())
    });
    vistos.extend(rx.try_iter());
    (vistos, outcome, l)
}

fn salida(events: &[AdapterEvent]) -> Vec<String> {
    events.iter().filter_map(|e| if let AdapterEvent::Output { text } = e { Some(text.clone()) } else { None }).collect()
}

fn emit_con<'a>(s: &'a mut [Value], metodo: &str) -> &'a mut Value {
    s.iter_mut().rev().find(|p| p["emit"]["method"] == metodo).unwrap_or_else(|| panic!("falta emit {metodo}"))
}

fn respond_de<'a>(s: &'a mut [Value], metodo: &str) -> &'a mut Value {
    s.iter_mut().find(|p| p["respond"] == metodo).unwrap_or_else(|| panic!("falta respond {metodo}"))
}

fn falla_el_turno(s: &mut [Value], mensaje: &str, info: Option<&str>) {
    let t = &mut emit_con(s, "turn/completed")["emit"]["params"]["turn"];
    t["status"] = json!("failed");
    t["error"] = json!({ "message": mensaje, "codexErrorInfo": info });
}

// ── Probe y elección de canal ─────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn el_probe_prefiere_app_server_en_una_version_verificada_y_declara_las_seis() {
    let p = plan_app_server();
    assert_eq!(p.transport, Some(Transport::AppServer));
    assert_eq!(p.reason, None);
    assert_eq!(p.probe.transport.as_deref(), Some("app_server"));
    assert_eq!(p.probe.environment, Environment::Ready);
    assert_eq!(p.probe.cli_version.as_deref(), Some("0.164.0"));
    for c in Capability::ALL {
        assert!(p.probe.matrix.is_available(c), "{}", c.code());
    }
    // A diferencia de Claude, Codex SÍ tiene steer (turn/steer inyecta en el turno en curso).
    assert!(p.probe.matrix.is_available(Capability::Steer));
    for v in APP_SERVER_VERIFIED {
        assert_eq!(probe_from(true, Some(v), Some(HELP), Some(EXEC_HELP), None).transport, Some(Transport::AppServer), "{v}");
    }
}

#[test]
fn una_version_sin_verificar_cae_a_exec_json_y_el_motivo_es_visible() {
    let p = plan_exec();
    assert_eq!(p.transport, Some(Transport::ExecJson));
    assert_eq!(p.probe.transport.as_deref(), Some("exec_json"));
    let motivo = p.reason.unwrap();
    assert!(motivo.contains("9.9.9") && motivo.contains("0.164.0"), "{motivo}");
    let m = &p.probe.matrix;
    assert!(m.is_available(Capability::Start) && m.is_available(Capability::Events));
    for c in [Capability::Answer, Capability::Interrupt, Capability::Steer, Capability::Resume] {
        assert_eq!(m.state(c), &CapabilityState::Unsupported, "{}", c.code());
    }

    // Sin app-server en la CLI: también exec, con otro motivo.
    let viejo = HELP.replace("app-server", "servidor");
    let p = probe_from(true, Some("0.164.0"), Some(&viejo), Some(EXEC_HELP), None);
    assert_eq!(p.transport, Some(Transport::ExecJson));
    assert!(p.reason.unwrap().contains("no incluye app-server"));
}

#[test]
fn sin_cli_o_sin_ningun_canal_el_entorno_esta_bloqueado() {
    let p = probe_from(false, None, None, None, None);
    assert_eq!(p.probe.environment, Environment::Blocked { blocks: vec![EnvBlock::CliMissing] });
    assert_eq!(p.transport, None);

    let viejo = HELP.replace("app-server", "servidor");
    let sin_json = EXEC_HELP.replace("--json", "--jsonl");
    let p = probe_from(true, Some("0.164.0"), Some(&viejo), Some(&sin_json), None);
    assert_eq!(p.probe.environment, Environment::Blocked { blocks: vec![EnvBlock::CliFlagsUnsupported] });

    // Un --help ilegible no se interpreta.
    let p = probe_from(true, Some("0.164.0"), None, None, None);
    assert!(matches!(p.probe.matrix.state(Capability::Start), CapabilityState::Unavailable { reason } if reason.contains("--help")));
}

#[test]
fn si_el_sandbox_de_windows_no_esta_listo_el_entorno_esta_bloqueado_con_su_causa_tipada() {
    for r in [Readiness::NotConfigured, Readiness::UpdateRequired] {
        let p = probe_from(true, Some("0.164.0"), Some(HELP), Some(EXEC_HELP), Some(r));
        assert_eq!(p.probe.environment, Environment::Blocked { blocks: vec![EnvBlock::WindowsSandboxSetup] }, "{r:?}");
        assert_eq!(p.probe.transport.as_deref(), Some("app_server"));
        for c in Capability::ALL {
            assert_eq!(p.probe.matrix.state(c), &CapabilityState::EnvironmentBlocked { block: EnvBlock::WindowsSandboxSetup }, "{r:?} {}", c.code());
        }
        // Y arrancar contra ese plan es un bloqueo de entorno con la causa, sin lanzar ningún proceso.
        let l = FakeLauncher::new(script_of(NORMAL));
        let e = registro(p, l.clone()).gated(ID).unwrap().start(start_req("proponer"), &CancelToken::new()).unwrap_err();
        assert_eq!((e.code, e.kind(), e.env_block), (ErrorCode::EnvironmentBlocked, FailureKind::EnvironmentBlocked, Some(EnvBlock::WindowsSandboxSetup)));
        assert!(l.launched.lock().unwrap().is_empty());
    }
    assert_eq!(Readiness::parse("ready"), Some(Readiness::Ready));
    assert_eq!(Readiness::parse("notConfigured"), Some(Readiness::NotConfigured));
    assert_eq!(Readiness::parse("updateRequired"), Some(Readiness::UpdateRequired));
    assert_eq!(Readiness::parse("otraCosa"), None);
}

#[test]
fn el_canal_aparece_en_el_snapshot_del_registro() {
    let reg = registro(plan_app_server(), FakeLauncher::new(vec![]));
    let v = serde_json::to_value(reg.snapshot()).unwrap();
    assert_eq!(v["providers"][0]["id"], "codex");
    assert_eq!(v["providers"][0]["transport"], "app_server");
}

// ── app-server: start → events → finish ───────────────────────────────────────────────────────────────────────────────

#[test]
fn start_events_finish_con_la_captura_real_de_app_server() {
    let script = script_of(NORMAL);
    let thread_real = script.iter().find(|p| p["respond"] == "thread/start").unwrap()["result"]["thread"]["id"].as_str().unwrap().to_string();
    let (got, outcome, l) = corre(plan_app_server(), script, "");

    assert_eq!(got[0], AdapterEvent::Transport { kind: "app_server".into(), degraded: false, reason: None });
    assert!(matches!(&got[1], AdapterEvent::SessionBound { provider_ref } if provider_ref.expose() == thread_real), "{:?}", got[1]);
    assert!(matches!(&got[2], AdapterEvent::Model { model } if !model.is_empty()));
    assert_eq!(salida(&got), ["OK"]);
    let usage = got.iter().find_map(|e| if let AdapterEvent::Usage { input_tokens, output_tokens, .. } = e { Some((*input_tokens, *output_tokens)) } else { None }).expect("usage");
    assert!(usage.0.is_some_and(|t| t > 0) && usage.1.is_some_and(|t| t > 0), "{usage:?}");
    assert_eq!(outcome, RunOutcome::Completed { summary: Some("OK".into()) });
    assert!(l.last().1.was_killed(), "el servidor no sobrevive a su ejecución");

    // Lo que el adapter le dijo al servidor, en orden.
    let (spec, srv) = l.last();
    assert_eq!(spec.args, ["app-server"]);
    assert_eq!(spec.cwd, PathBuf::from("wt"));
    let w = srv.written();
    let metodos: Vec<&str> = w.iter().filter_map(|v| v["method"].as_str()).collect();
    assert_eq!(metodos, ["initialize", "initialized", "windowsSandbox/readiness", "thread/start", "turn/start"]);
    assert_eq!(w[0]["params"]["clientInfo"]["name"], "lixbon");
    let ts = &srv.sent("thread/start")[0]["params"];
    assert_eq!((ts["sandbox"].as_str(), ts["approvalPolicy"].as_str(), ts["ephemeral"].as_bool()), (Some("read-only"), Some("never"), Some(false)));
    assert_eq!(ts["cwd"], "wt");
    assert_eq!(srv.sent("turn/start")[0]["params"]["input"][0]["text"], "haz algo");
}

#[test]
fn delegar_escribe_en_el_worktree_y_pregunta_al_core_lo_que_salga_de_el() {
    let l = FakeLauncher::new(script_of(NORMAL));
    let reg = registro(plan_app_server(), l.clone());
    reg.gated(ID).unwrap().start(start_req("delegar_con_revision"), &CancelToken::new()).unwrap();
    let ts = &l.last().1.sent("thread/start")[0]["params"];
    assert_eq!((ts["sandbox"].as_str(), ts["approvalPolicy"].as_str()), (Some("workspace-write"), Some("on-request")));
}

#[test]
fn una_peticion_invalida_no_lanza_ningun_proceso() {
    let l = FakeLauncher::new(script_of(NORMAL));
    let reg = registro(plan_app_server(), l.clone());
    let g = reg.gated(ID).unwrap();
    let c = CancelToken::new();
    for req in [
        StartRequest { prompt: " ".into(), ..start_req("proponer") },
        StartRequest { attempt_id: "".into(), ..start_req("proponer") },
        StartRequest { worktree: PathBuf::new(), ..start_req("proponer") },
        start_req("saltar-permisos"),
        start_req("autonomia_amplia"),
    ] {
        assert_eq!(g.start(req, &c).unwrap_err().code, ErrorCode::InvalidRequest);
    }
    assert!(l.launched.lock().unwrap().is_empty());
    // Un modelo con caracteres peligrosos se rechaza con el servidor ya lanzado y sin dejar el proceso vivo.
    let e = g.start(StartRequest { model: Some("gpt; calc".into()), ..start_req("proponer") }, &c).unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidRequest);
    assert!(l.last().1.was_killed());
}

// ── interrupt, steer, answer, resume ──────────────────────────────────────────────────────────────────────────────────

#[test]
fn interrupt_termina_interrupted_con_el_protocolo_real() {
    let (_, outcome, l) = corre_con(script_of(INTERRUMPIR), "proponer", |g, run, _| {
        g.interrupt(run).unwrap();
        vec![]
    });
    assert_eq!(outcome, RunOutcome::Interrupted, "una interrupción pedida NO es un fallo del Attempt");
    let srv = l.last().1;
    let i = &srv.sent("turn/interrupt")[0]["params"];
    assert_eq!(srv.sent("turn/start").len(), 1);
    assert!(i["threadId"].as_str().is_some_and(|t| t.starts_with("00000000-")) && i["turnId"].as_str().is_some_and(|t| t.starts_with("00000000-")), "{i}");
}

#[test]
fn steer_inyecta_en_el_turno_en_curso_y_el_turno_sigue_siendo_uno() {
    let (_, outcome, l) = corre_con(script_of(DIRIGIR), "proponer", |g, run, _| {
        g.steer(run, "Cambio de plan: responde solo FIN.").unwrap();
        vec![]
    });
    // Un solo turno, que cambió de rumbo: no es una cola.
    assert_eq!(outcome, RunOutcome::Completed { summary: Some("FIN".into()) });
    let srv = l.last().1;
    let s = &srv.sent("turn/steer")[0]["params"];
    assert_eq!(s["input"][0]["text"], "Cambio de plan: responde solo FIN.");
    assert!(s["expectedTurnId"].as_str().is_some_and(|t| t.starts_with("00000000-")), "{s}");
    assert_eq!(srv.sent("turn/start").len(), 1, "steer no abre otro turno");
}

#[test]
fn un_steer_vacio_se_rechaza_sin_tocar_el_servidor() {
    let l = FakeLauncher::new(script_of(NORMAL));
    let reg = registro(plan_app_server(), l.clone());
    let g = reg.gated(ID).unwrap();
    let run = g.start(start_req("proponer"), &CancelToken::new()).unwrap();
    assert_eq!(g.steer(&run, "   ").unwrap_err().code, ErrorCode::InvalidRequest);
    assert!(l.last().1.sent("turn/steer").is_empty());
}

#[test]
fn la_aprobacion_llega_al_core_que_decide_y_allow_responde_accept() {
    let (todos, outcome, l) = corre_con(script_of(APROBAR), "delegar_con_revision", |g, run, rx| {
        let mut vistos = vec![];
        loop {
            let e = rx.recv_timeout(Duration::from_secs(5)).expect("llega la petición de aprobación");
            let id = if let AdapterEvent::Permission { request_id, .. } = &e { Some(request_id.clone()) } else { None };
            vistos.push(e);
            if let Some(id) = id {
                // Una respuesta que no es allow/deny, o a otro id, se rechaza.
                assert_eq!(g.answer(run, Answer { question_id: id.clone(), text: "quizás".into() }).unwrap_err().code, ErrorCode::InvalidRequest);
                assert_eq!(g.answer(run, Answer { question_id: "99".into(), text: "allow".into() }).unwrap_err().code, ErrorCode::InvalidRequest);
                g.answer(run, Answer { question_id: id, text: "allow".into() }).unwrap();
                return vistos;
            }
        }
    });
    let AdapterEvent::Permission { request_id, tool, summary } = todos.iter().find(|e| matches!(e, AdapterEvent::Permission { .. })).unwrap() else { unreachable!() };
    assert_eq!((request_id.as_str(), tool.as_str()), ("0", "shell"));
    assert!(!summary.is_empty() && summary.chars().count() <= 200, "{summary}");

    let resp: Vec<Value> = l.last().1.written().into_iter().filter(|v| v.get("method").is_none() && v.get("result").is_some() && v["id"] == 0).collect();
    assert_eq!(resp.len(), 1, "se responde una sola vez y solo tras el answer del Core");
    assert_eq!(resp[0]["result"], json!({"decision": "accept"}));
    assert!(matches!(outcome, RunOutcome::Completed { .. }), "{outcome:?}");
}

#[test]
fn deny_responde_decline() {
    let (_, _, l) = corre_con(script_of(APROBAR), "delegar_con_revision", |g, run, rx| {
        loop {
            if let AdapterEvent::Permission { request_id, .. } = rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                g.answer(run, Answer { question_id: request_id, text: "deny".into() }).unwrap();
                return vec![];
            }
        }
    });
    let r = l.last().1.written().into_iter().find(|v| v.get("method").is_none() && v["id"] == 0).unwrap();
    assert_eq!(r["result"], json!({"decision": "decline"}));
}

#[test]
fn resume_usa_thread_resume_con_el_hilo_original_y_conserva_el_perfil() {
    let l = FakeLauncher::new(script_of(REANUDAR));
    let reg = registro(plan_app_server(), l.clone());
    let g = reg.gated(ID).unwrap();
    let r = ProviderRef::new("00000000-0000-4000-8000-000000000001").unwrap();
    let req = |prompt: Option<&str>| ResumeRequest { attempt_id: "a2".into(), provider_ref: r.clone(), worktree: PathBuf::from("wt"), prompt: prompt.map(str::to_string), profile: "delegar_con_revision".into(), model: Some("gpt-5.6-luna".into()), effort: None };
    let cancel = CancelToken::new();
    let run = g.resume(req(Some("¿qué palabra era?")), &cancel).unwrap();
    let mut got = vec![];
    let outcome = g.events(&run, &cancel, &mut |e: AdapterEvent| got.push(e)).unwrap();
    assert_eq!(outcome, RunOutcome::Completed { summary: Some("ZETA-7".into()) });

    let srv = l.last().1;
    assert!(srv.sent("thread/start").is_empty(), "reanudar no crea un hilo nuevo");
    let p = &srv.sent("thread/resume")[0]["params"];
    assert_eq!(p["threadId"], "00000000-0000-4000-8000-000000000001");
    assert_eq!((p["sandbox"].as_str(), p["approvalPolicy"].as_str(), p["model"].as_str()), (Some("workspace-write"), Some("on-request"), Some("gpt-5.6-luna")));
    assert_eq!(srv.sent("turn/start")[0]["params"]["input"][0]["text"], "¿qué palabra era?");
    assert_eq!(g.resume(req(None), &cancel).unwrap_err().code, ErrorCode::InvalidRequest);
}

#[test]
fn reanudar_un_hilo_que_codex_ya_no_tiene_es_session_not_found_y_no_un_fallo() {
    // Mensaje observado con codex 0.164.0 al reanudar un id que no existe.
    let mut s = script_of(REANUDAR);
    let r = respond_de(&mut s, "thread/resume");
    r.as_object_mut().unwrap().remove("result");
    r["error"] = json!({"code": -32600, "message": "thread/resume failed: no rollout found for thread id 00000000-0000-4000-8000-000000000001"});
    let l = FakeLauncher::new(s);
    let reg = registro(plan_app_server(), l.clone());
    let req = ResumeRequest { attempt_id: "a2".into(), provider_ref: ProviderRef::new("00000000-0000-4000-8000-000000000001").unwrap(), worktree: PathBuf::from("wt"), prompt: Some("sigue".into()), profile: "proponer".into(), model: None, effort: None };
    let e = reg.gated(ID).unwrap().resume(req, &CancelToken::new()).unwrap_err();
    assert_eq!((e.code, e.kind()), (ErrorCode::SessionNotFound, FailureKind::Rejected));
    assert!(l.last().1.was_killed(), "un arranque fallido no deja el servidor vivo");

    // La frase solo vale para `thread/resume`: la misma en otra llamada sigue siendo un fallo del proveedor.
    assert!(is_thread_missing("thread/resume", "no rollout found for thread id x"));
    assert!(!is_thread_missing("thread/start", "no rollout found for thread id x"));
    assert!(!is_thread_missing("thread/resume", "rollout corrupto"));
}

// ── cancelar, cortes y flujo malformado ───────────────────────────────────────────────────────────────────────────────

fn hasta_turn_start(mut s: Vec<Value>) -> Vec<Value> {
    let i = s.iter().position(|p| p["respond"] == "turn/start").unwrap();
    s.truncate(i + 1);
    s
}

#[test]
fn cancelar_mata_el_proceso_y_termina_cancelled() {
    let mut s = hasta_turn_start(script_of(NORMAL));
    s.push(json!({"gate": "never"}));
    let l = FakeLauncher::new(s);
    let reg = registro(plan_app_server(), l.clone());
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("proponer"), &cancel).unwrap();
    let (tx, rx) = mpsc::channel();
    let outcome = std::thread::scope(|sc| {
        let h = sc.spawn(|| g.events(&run, &cancel, &mut |e: AdapterEvent| tx.send(e).unwrap()));
        loop {
            if let AdapterEvent::SessionBound { .. } = rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                break;
            }
        }
        cancel.cancel();
        h.join().unwrap().unwrap()
    });
    assert_eq!(outcome, RunOutcome::Cancelled);
    assert!(l.last().1.was_killed());
    assert_eq!(g.interrupt(&run).unwrap_err().code, ErrorCode::UnknownRun, "la ejecución ya no existe");
}

#[test]
fn un_corte_sin_turn_completed_es_un_fallo_con_diagnostico() {
    let (_, outcome, _) = corre(plan_app_server(), hasta_turn_start(script_of(NORMAL)), "boom: token=abc123def456ghi789");
    let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
    assert_eq!((e.code, e.kind()), (ErrorCode::Provider, FailureKind::AttemptFailure));
    assert!(e.message.contains("sin resultado"), "{}", e.message);
    let d = e.diagnostic.unwrap();
    assert!(d.contains("boom") && !d.contains("abc123def456"), "{d}");
}

#[test]
fn un_turno_fallido_es_un_fallo_del_attempt_con_su_motivo_estructurado() {
    let mut s = script_of(NORMAL);
    falla_el_turno(&mut s, "el servidor está saturado", Some("serverOverloaded"));
    let (_, outcome, _) = corre(plan_app_server(), s, "");
    let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
    assert_eq!(e.kind(), FailureKind::AttemptFailure);
    let d = e.diagnostic.unwrap();
    assert!(d.contains("codexErrorInfo=serverOverloaded") && d.contains("saturado"), "{d}");
}

#[test]
fn lineas_malformadas_y_notificaciones_desconocidas_se_saltan() {
    let mut s = script_of(NORMAL);
    let i = s.iter().position(|p| p["respond"] == "turn/start").unwrap() + 1;
    s.insert(i, Value::String("esto no es json".into()));
    s.insert(i, Value::String("[1,2,3]".into()));
    s.insert(i, Value::String("{\"method\":".into()));
    s.insert(i, json!({"emit": {"method": "algo/que/no/existe", "params": {"x": 1}}}));
    s.insert(i, json!({"emit": {"method": "mcpServer/startupStatus/updated", "params": {}}}));
    let (got, outcome, _) = corre(plan_app_server(), s, "");
    assert_eq!(salida(&got), ["OK"]);
    assert!(matches!(outcome, RunOutcome::Completed { .. }), "{outcome:?}");
}

#[test]
fn una_peticion_del_servidor_que_no_se_atiende_se_rechaza_y_se_avisa_sin_colgar() {
    let mut s = script_of(NORMAL);
    let i = s.iter().position(|p| p["respond"] == "turn/start").unwrap() + 1;
    s.insert(i, json!({"on_response": 77}));
    s.insert(i, json!({"emit": {"id": 77, "method": "item/tool/requestUserInput", "params": {}}}));
    let (got, outcome, l) = corre(plan_app_server(), s, "");
    let rechazo = l.last().1.written().into_iter().find(|v| v["id"] == 77).expect("se respondió");
    assert_eq!(rechazo["error"]["code"], -32601);
    assert!(salida(&got).iter().any(|t| t.contains("item/tool/requestUserInput")), "{:?}", salida(&got));
    assert!(matches!(outcome, RunOutcome::Completed { .. }));
}

#[test]
fn la_salida_se_acota_y_ningun_secreto_sale() {
    let mut s = script_of(NORMAL);
    let secreto = "listo, sk-ant-api03-AAAAAAAAAAAAAAAAAAAA y token=abc123def456ghi789";
    for p in s.iter_mut().filter(|p| p["emit"]["method"] == "item/completed" && p["emit"]["params"]["item"]["type"] == "agentMessage") {
        p["emit"]["params"]["item"]["text"] = json!(secreto);
    }
    let i = s.iter().position(|p| p["emit"]["method"] == "turn/started").unwrap();
    s.insert(i + 1, json!({"emit": {"method": "item/started", "params": {"item": {"type": "commandExecution", "id": "c1", "command": "curl -H 'token=abc123def456ghi789' https://x\nrm -rf /", "status": "inProgress"}}}}));
    let (got, outcome, _) = corre(plan_app_server(), s, "");
    for e in &got {
        let dbg = format!("{e:?}");
        assert!(!dbg.contains("AAAAAAAAAAAA") && !dbg.contains("abc123def456"), "{dbg}");
        if let AdapterEvent::Output { text } | AdapterEvent::ToolUse { summary: text, .. } = e {
            assert!(!looks_secret(text), "{text}");
        }
    }
    assert!(salida(&got)[0].contains(REDACTED));
    let uso = got.iter().find_map(|e| if let AdapterEvent::ToolUse { tool, summary } = e { Some((tool.clone(), summary.clone())) } else { None }).expect("tool use");
    assert_eq!(uso.0, "shell");
    assert!(!uso.1.contains('\n') && !uso.1.contains("rm -rf"), "una sola línea: {}", uso.1);
    let RunOutcome::Completed { summary } = outcome else { panic!() };
    assert!(!summary.unwrap().contains("abc123def456"));
}

// ── LXO-131: entorno bloqueado ≠ Attempt fallido ──────────────────────────────────────────────────────────────────────

#[test]
fn el_patron_del_conflicto_del_sandbox_es_especifico() {
    assert!(is_sandbox_setup_conflict("helper_unknown_error: setup refresh had errors"));
    assert!(is_sandbox_setup_conflict("fallo: helper_unknown_error — setup refresh had errors (detalle)"));
    // Parecido pero distinto: no es un bloqueo de entorno (invariantes 1 y 2).
    for no in [
        "setup refresh had errors",
        "helper_unknown_error: disk full",
        "helper_unknown_error",
        "setup refresh succeeded",
        "sandbox error",
        "",
    ] {
        assert!(!is_sandbox_setup_conflict(no), "{no:?}");
    }
}

#[test]
fn el_conflicto_del_sandbox_en_un_turno_es_entorno_bloqueado_y_no_un_fallo() {
    let mut s = script_of(NORMAL);
    falla_el_turno(&mut s, "helper_unknown_error: setup refresh had errors", Some("sandboxError"));
    let (_, outcome, _) = corre(plan_app_server(), s, "");
    let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
    assert_eq!((e.code, e.kind(), e.env_block), (ErrorCode::EnvironmentBlocked, FailureKind::EnvironmentBlocked, Some(EnvBlock::WindowsSandboxSetup)));
    // La acción sugerida es segura: cerrar y reintentar, nunca matar procesos ajenos.
    assert!(e.message.contains("ciérrala y reintenta") && e.message.contains("no cierra procesos ajenos"), "{}", e.message);
}

#[test]
fn el_conflicto_del_sandbox_tambien_se_reconoce_al_arrancar_y_en_stderr() {
    // Al arrancar el hilo.
    let mut s = script_of(NORMAL);
    let r = respond_de(&mut s, "thread/start");
    r.as_object_mut().unwrap().remove("result");
    r["error"] = json!({"code": -32000, "message": "helper_unknown_error: setup refresh had errors"});
    let l = FakeLauncher::new(s);
    let reg = registro(plan_app_server(), l.clone());
    let e = reg.gated(ID).unwrap().start(start_req("proponer"), &CancelToken::new()).unwrap_err();
    assert_eq!((e.code, e.kind(), e.env_block), (ErrorCode::EnvironmentBlocked, FailureKind::EnvironmentBlocked, Some(EnvBlock::WindowsSandboxSetup)));
    assert!(l.last().1.was_killed(), "un arranque fallido no deja el servidor vivo");

    // Al cortarse el proceso, por su stderr.
    let (_, outcome, _) = corre(plan_app_server(), hasta_turn_start(script_of(NORMAL)), "ERROR helper_unknown_error: setup refresh had errors");
    let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
    assert_eq!(e.kind(), FailureKind::EnvironmentBlocked);
}

#[test]
fn un_error_parecido_pero_distinto_sigue_siendo_un_fallo_del_attempt() {
    for mensaje in ["helper_unknown_error: disk full", "setup refresh had errors", "algo salió mal en el sandbox"] {
        let mut s = script_of(NORMAL);
        falla_el_turno(&mut s, mensaje, None);
        let (_, outcome, _) = corre(plan_app_server(), s, "");
        let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
        assert_eq!(e.kind(), FailureKind::AttemptFailure, "{mensaje}");
    }
    let (_, outcome, _) = corre(plan_app_server(), hasta_turn_start(script_of(NORMAL)), "helper_unknown_error: otra cosa");
    let RunOutcome::Failed(e) = outcome else { panic!() };
    assert_eq!(e.kind(), FailureKind::AttemptFailure);
}

#[test]
fn si_el_preflight_dice_no_listo_se_bloquea_antes_de_crear_el_hilo() {
    for estado in ["notConfigured", "updateRequired"] {
        let mut s = script_of(NORMAL);
        respond_de(&mut s, "windowsSandbox/readiness")["result"] = json!({"status": estado});
        let l = FakeLauncher::new(s);
        let reg = registro(plan_app_server(), l.clone());
        let e = reg.gated(ID).unwrap().start(start_req("proponer"), &CancelToken::new()).unwrap_err();
        assert_eq!((e.code, e.kind(), e.env_block), (ErrorCode::EnvironmentBlocked, FailureKind::EnvironmentBlocked, Some(EnvBlock::WindowsSandboxSetup)), "{estado}");
        assert!(l.last().1.sent("thread/start").is_empty(), "no se crea ningún hilo con el entorno bloqueado");
        assert!(l.last().1.was_killed());
    }
}

#[test]
fn si_el_preflight_no_existe_en_esta_version_no_bloquea() {
    let mut s = script_of(NORMAL);
    let r = respond_de(&mut s, "windowsSandbox/readiness");
    r.as_object_mut().unwrap().remove("result");
    r["error"] = json!({"code": -32601, "message": "method not found"});
    let (_, outcome, _) = corre(plan_app_server(), s, "");
    assert!(matches!(outcome, RunOutcome::Completed { .. }), "{outcome:?}");
}

#[test]
fn el_preflight_pregunta_al_sandbox_sin_crear_hilos_ni_gastar_cuota() {
    let prefijo = |mut s: Vec<Value>| {
        let i = s.iter().position(|p| p["respond"] == "windowsSandbox/readiness").unwrap();
        s.truncate(i + 1);
        s
    };
    for (estado, esperado) in [("ready", Readiness::Ready), ("notConfigured", Readiness::NotConfigured), ("updateRequired", Readiness::UpdateRequired)] {
        let mut s = prefijo(script_of(NORMAL));
        respond_de(&mut s, "windowsSandbox/readiness")["result"] = json!({ "status": estado });
        let l = FakeLauncher::new(s);
        let a = CodexAdapter::with_parts(cfg(), l.clone(), Arc::new(plan_app_server));
        assert_eq!(a.preflight(Path::new("wt")).unwrap(), Some(esperado), "{estado}");
        let srv = l.last().1;
        assert!(srv.sent("thread/start").is_empty() && srv.sent("turn/start").is_empty(), "el preflight no crea hilos ni turnos");
        assert!(srv.was_killed(), "ni deja el servidor vivo");
    }
    // Una versión que no tiene la consulta: no sabe contestar, y eso no es «no listo».
    let mut s = prefijo(script_of(NORMAL));
    let r = respond_de(&mut s, "windowsSandbox/readiness");
    r.as_object_mut().unwrap().remove("result");
    r["error"] = json!({"code": -32601, "message": "method not found"});
    let a = CodexAdapter::with_parts(cfg(), FakeLauncher::new(s), Arc::new(plan_app_server));
    assert_eq!(a.preflight(Path::new("wt")).unwrap(), None);
    // El respaldo exec no tiene esta consulta ni lanza nada.
    let l = FakeLauncher::new(vec![]);
    let a = CodexAdapter::with_parts(cfg(), l.clone(), Arc::new(plan_exec));
    assert_eq!(a.preflight(Path::new("wt")).unwrap(), None);
    assert!(l.launched.lock().unwrap().is_empty());
}

#[test]
fn solo_un_preflight_listo_desmiente_el_bloqueo_del_sandbox() {
    use crate::orch::agents::EnvProof;
    assert!(env_proof(Readiness::Ready).demonstrates(EnvBlock::WindowsSandboxSetup));
    for no in [Readiness::NotConfigured, Readiness::UpdateRequired] {
        assert!(!env_proof(no).any(), "{no:?} no demuestra nada");
    }
    // Y la prueba de listo no desmiente NINGUNA otra causa.
    for otra in [EnvBlock::CliMissing, EnvBlock::CliFlagsUnsupported, EnvBlock::WindowsSandboxElevated] {
        assert!(!env_proof(Readiness::Ready).demonstrates(otra), "{otra:?}");
    }
    // A la inversa, que la CLI exista, tenga los flags y el sandbox no sea elevado NO prueba que esté listo ni libre.
    let otra = EnvProof { cli_present: true, flags_supported: true, sandbox_not_elevated: true, sandbox_ready: false };
    assert!(!otra.demonstrates(EnvBlock::WindowsSandboxSetup));
    assert_eq!(sandbox_conflict_error().env_block, Some(EnvBlock::WindowsSandboxSetup));
}

// ── exec --json (respaldo degradado) ──────────────────────────────────────────────────────────────────────────────────

#[test]
fn exec_json_start_events_finish_con_el_canal_degradado_visible() {
    let (got, outcome, l) = corre(plan_exec(), script_of(EXEC), "");
    let AdapterEvent::Transport { kind, degraded, reason } = &got[0] else { panic!("{:?}", got[0]) };
    assert_eq!((kind.as_str(), *degraded), ("exec_json", true));
    assert!(reason.as_deref().unwrap().contains("9.9.9"), "{reason:?}");
    assert!(matches!(&got[1], AdapterEvent::SessionBound { provider_ref } if provider_ref.expose().starts_with("00000000-")));
    assert_eq!(salida(&got), ["OK"]);
    assert!(got.iter().any(|e| matches!(e, AdapterEvent::Usage { output_tokens: Some(5), .. })));
    assert_eq!(outcome, RunOutcome::Completed { summary: Some("OK".into()) });

    let (spec, srv) = l.last();
    assert_eq!(&spec.args[..3], ["exec", "--json", "--skip-git-repo-check"]);
    assert!(spec.args.windows(2).any(|w| w == ["-s", "read-only"]) && spec.args.windows(2).any(|w| w == ["-C", "wt"]));
    // El prompt va por stdin, no en el argv, y la entrada se cierra para que `codex exec` no espere más.
    assert!(!spec.args.iter().any(|a| a.contains("haz algo")));
    assert_eq!(srv.written(), [Value::String("haz algo".into())]);
    assert!(srv.input_closed());
}

#[test]
fn exec_json_no_ofrece_answer_interrupt_steer_ni_resume() {
    let l = FakeLauncher::new(script_of(EXEC));
    let reg = registro(plan_exec(), l.clone());
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("proponer"), &cancel).unwrap();
    assert_eq!(g.interrupt(&run).unwrap_err().code, ErrorCode::UnsupportedCapability);
    assert_eq!(g.steer(&run, "x").unwrap_err().code, ErrorCode::UnsupportedCapability);
    assert_eq!(g.answer(&run, Answer { question_id: "0".into(), text: "allow".into() }).unwrap_err().code, ErrorCode::UnsupportedCapability);
    let r = ResumeRequest { attempt_id: "a2".into(), provider_ref: ProviderRef::new("t-1").unwrap(), worktree: PathBuf::from("wt"), prompt: Some("sigue".into()), profile: "proponer".into(), model: None, effort: None };
    assert_eq!(g.resume(r, &cancel).unwrap_err().code, ErrorCode::UnsupportedCapability);
}

#[test]
fn exec_json_un_fallo_o_un_corte_no_se_dan_por_completados() {
    let mut s = script_of(EXEC);
    s.pop();
    s.push(json!({"type": "turn.failed", "error": {"message": "el modelo no está disponible"}}));
    let (_, outcome, _) = corre(plan_exec(), s, "");
    let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
    assert!(e.diagnostic.unwrap().contains("modelo no está disponible"));

    let mut s = script_of(EXEC);
    s.pop();
    let (_, outcome, _) = corre(plan_exec(), s, "");
    let RunOutcome::Failed(e) = outcome else { panic!("{outcome:?}") };
    assert!(e.message.contains("sin resultado"));

    let mut s = script_of(EXEC);
    s.pop();
    s.push(json!({"type": "turn.failed", "error": {"message": "helper_unknown_error: setup refresh had errors"}}));
    let (_, outcome, _) = corre(plan_exec(), s, "");
    let RunOutcome::Failed(e) = outcome else { panic!() };
    assert_eq!(e.kind(), FailureKind::EnvironmentBlocked);
}

#[test]
fn exec_json_cancelar_mata_el_proceso() {
    let mut s = script_of(EXEC);
    s.truncate(1);
    s.push(json!({"gate": "never"}));
    let l = FakeLauncher::new(s);
    let reg = registro(plan_exec(), l.clone());
    let g = reg.gated(ID).unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("proponer"), &cancel).unwrap();
    let (tx, rx) = mpsc::channel();
    let outcome = std::thread::scope(|sc| {
        let h = sc.spawn(|| g.events(&run, &cancel, &mut |e: AdapterEvent| tx.send(e).unwrap()));
        loop {
            if let AdapterEvent::SessionBound { .. } = rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                break;
            }
        }
        cancel.cancel();
        h.join().unwrap().unwrap()
    });
    assert_eq!(outcome, RunOutcome::Cancelled);
    assert!(l.last().1.was_killed());
}

// ── Validación manual con la CLI real ─────────────────────────────────────────────────────────────────────────────────

/// `cargo test --lib orch::adapter::codex::tests::real_codex -- --ignored --nocapture --test-threads=1`: lanza `codex` de verdad
/// (modelo pequeño, prompts de una línea, perfil de solo lectura) con el lanzador real.
#[test]
#[ignore = "validación manual: lanza la CLI real de Codex y usa la cuenta del usuario"]
fn real_codex_start_steer_interrupt_resume() {
    let a = Arc::new(CodexAdapter::new(CodexConfig::default()));
    let plan = a.plan();
    println!("probe: {:#?}\nreason: {:?}", plan.probe, plan.reason);
    assert_eq!(plan.transport, Some(Transport::AppServer), "esta máquina debería usar app-server");
    let dir = std::env::temp_dir().join(format!("lxo-real-codex-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut reg = AdapterRegistry::new();
    reg.register(a).unwrap();
    let g = reg.gated(ID).unwrap();
    let req = |prompt: &str| StartRequest { attempt_id: "real".into(), worktree: dir.clone(), prompt: prompt.into(), profile: "explorar".into(), model: Some("gpt-5.6-luna".into()), effort: None };

    // 1) start → events → finish, y guardamos el hilo.
    let cancel = CancelToken::new();
    let run = g.start(req("Recuerda la palabra ZETA-9. Responde solo OK."), &cancel).unwrap();
    let mut got = vec![];
    let outcome = g.events(&run, &cancel, &mut |e: AdapterEvent| got.push(e)).unwrap();
    println!("eventos: {got:#?}\nresultado: {outcome:?}");
    assert!(matches!(outcome, RunOutcome::Completed { .. }), "{outcome:?}");
    let thread = got.iter().find_map(|e| if let AdapterEvent::SessionBound { provider_ref } = e { Some(provider_ref.clone()) } else { None }).expect("hilo");

    // 2) resume en un proceso nuevo: el hilo recuerda la palabra.
    let rr = ResumeRequest { attempt_id: "real-2".into(), provider_ref: thread, worktree: dir.clone(), prompt: Some("¿Cuál era la palabra? Responde solo la palabra.".into()), profile: "explorar".into(), model: Some("gpt-5.6-luna".into()), effort: None };
    let run = g.resume(rr, &cancel).unwrap();
    let mut got2 = vec![];
    let outcome = g.events(&run, &cancel, &mut |e: AdapterEvent| got2.push(e)).unwrap();
    println!("resume: {outcome:?}");
    assert!(matches!(&outcome, RunOutcome::Completed { summary: Some(s) } if s.contains("ZETA-9")), "{outcome:?}");

    // 3) interrupt a mitad de un turno largo.
    let run = g.start(req("Escribe los numeros del 1 al 300, uno por linea, sin herramientas ni comentarios."), &cancel).unwrap();
    let outcome = std::thread::scope(|s| {
        let h = s.spawn(|| g.events(&run, &cancel, &mut |_: AdapterEvent| {}));
        std::thread::sleep(Duration::from_secs(4));
        g.interrupt(&run).unwrap();
        h.join().unwrap().unwrap()
    });
    println!("interrupt: {outcome:?}");
    assert_eq!(outcome, RunOutcome::Interrupted);
    let _ = std::fs::remove_dir_all(dir);
}

// ── Usage (LXO-205) ─────────────────────────────────────────────────────────────────────────────────────────────────

const RATE_LIMITS: &str = include_str!("../../testdata/codex-0.164.0-account-rate-limits.json");

fn rate_limits() -> Value {
    serde_json::from_str(RATE_LIMITS).unwrap()
}

fn usage_script(rate_limits_step: Value) -> Vec<Value> {
    vec![json!({"on": "initialize"}), json!({"respond": "initialize", "result": {"userAgent": "codex/0.164.0"}}), json!({"on_notification": "initialized"}), json!({"on": "account/rateLimits/read"}), rate_limits_step]
}

#[test]
fn usage_de_codex_sale_de_account_rate_limits_read_sin_crear_hilos() {
    let l = FakeLauncher::new(usage_script(json!({"respond": "account/rateLimits/read", "result": rate_limits()})));
    let reg = registro(plan_app_server(), l.clone());
    let a = reg.usage_targets().remove(0).adapter;
    let snap = a.usage(&CancelToken::new()).unwrap();
    assert_eq!(snap.provenance, crate::orch::adapter::Provenance::ProviderQuery);
    assert_eq!(snap.plan.as_deref(), Some("plus"));
    assert_eq!(snap.windows.len(), 2);
    assert_eq!((snap.windows[0].id.as_str(), snap.windows[0].minutes, snap.windows[0].used_percent, snap.windows[0].resets_at), ("codex.primary", Some(300), Some(0.0), Some(1793061241)));
    assert_eq!((snap.windows[1].id.as_str(), snap.windows[1].minutes, snap.windows[1].used_percent), ("codex.secondary", Some(10080), Some(1.0)));
    assert_eq!(snap.limit_reached, Some(false));
    assert_eq!(snap.credits.as_ref().unwrap().balance.as_deref(), Some("0"));
    // El identificador de la cuenta viaja solo hasta el servicio, que lo vuelve huella.
    assert_eq!(snap.account_id.as_deref(), Some("00000000-0000-4000-8000-0000000000aa"));
    let (_, server) = l.last();
    assert!(server.was_killed(), "el proceso de la consulta no sobrevive a ella");
    let metodos: Vec<String> = server.written().iter().filter_map(|m| m["method"].as_str().map(str::to_string)).collect();
    assert_eq!(metodos, ["initialize", "initialized", "account/rateLimits/read"], "solo una consulta: ni `thread/start` ni `turn/start`");
}

#[test]
fn usage_de_codex_con_el_respaldo_exec_es_no_disponible_y_no_lanza_nada() {
    let l = FakeLauncher::new(vec![]);
    let reg = registro(plan_exec(), l.clone());
    let a = reg.usage_targets().remove(0).adapter;
    let sup = a.usage_support();
    assert!(matches!(sup.state(crate::orch::adapter::UsageField::Windows), CapabilityState::Unavailable { .. }));
    assert_eq!(a.usage(&CancelToken::new()).unwrap_err().kind, crate::orch::adapter::UsageErrorKind::ProviderUnavailable);
    assert!(l.launched.lock().unwrap().is_empty(), "sin app-server no se lanza ningún proceso");
}

#[test]
fn el_texto_de_error_de_codex_se_clasifica_sin_inventar_auth() {
    use crate::orch::adapter::UsageErrorKind as K;
    let e = |m: &str| AdapterError::provider(m);
    assert_eq!(usage::classify(&e("account/rateLimits/read: not logged in, run codex login")).kind, K::AuthRequired);
    assert_eq!(usage::classify(&e("account/rateLimits/read: Too Many Requests")).kind, K::RateLimited);
    assert_eq!(usage::classify(&e("account/rateLimits/read: algo raro")).kind, K::ProviderUnavailable);
}

#[test]
fn un_cubo_sin_ventanas_ni_senales_no_afirma_nada() {
    let snap = usage::snapshot_from(&json!({"rateLimits": {"limitId": "x", "planType": "unknown"}}), 5);
    assert!(snap.windows.is_empty());
    assert_eq!(snap.plan, None, "`unknown` es desconocido, no un plan");
    assert_eq!(snap.limit_reached, None);
    assert_eq!(snap.credits, None);
    assert_eq!(snap.account_id, None);
}

#[test]
fn limite_alcanzado_y_porcentajes_fuera_de_rango() {
    let v = json!({"ordinaryUsageAllowed": false, "rateLimits": {"limitId": "codex", "primary": {"usedPercent": 140}, "secondary": {"usedPercent": 100, "windowDurationMins": 10080}, "rateLimitReachedType": "rate_limit_reached"}});
    let snap = usage::snapshot_from(&v, 5);
    assert_eq!(snap.limit_reached, Some(true));
    assert_eq!(snap.windows[0].used_percent, None, "140 % no es un porcentaje: desconocido");
    assert_eq!(snap.windows[1].used_percent, Some(100.0));
}

/// Validación manual de LXO-205: `account/rateLimits/read` real. Solo lectura: ni hilo ni modelo ni cuota.
#[test]
#[ignore = "validación manual: lanza codex app-server real y lee los límites de la cuenta"]
fn real_codex_usage_rate_limits() {
    let a = CodexAdapter::new(CodexConfig::default());
    let p = a.probe();
    println!("version: {:?} transporte: {:?}", p.cli_version, p.transport);
    let snap = a.usage(&CancelToken::new()).expect("account/rateLimits/read respondió");
    println!("{snap:#?}");
    assert!(!snap.windows.is_empty());
}
