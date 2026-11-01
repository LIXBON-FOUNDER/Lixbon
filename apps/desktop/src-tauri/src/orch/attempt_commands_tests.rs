//! LXO-142 · `attempt.retry` y `attempt.resume`: éxito, fallo, idempotencia, Attempt activo, resume soportado, caducado y no
//! soportado, y el fallback a ContextPackage solo cuando el cliente lo confirma. Contrato: `docs/core/REINTENTO.md`.
//!
//! El almacén (transacción, idempotencia, triggers) se prueba en `store/retries_tests.rs` y la política de la reanudación en
//! `orch/continuity_tests.rs`; aquí se prueba el comando con adapters falsos, sus eventos y su Attention.

use std::sync::Arc;

use serde_json::Value;

use super::adapter::fake::Step;
use super::adapter::{AdapterError, CancelToken, ProbeResult};
use super::agents::EnvBlock;
use super::attempt_commands::*;
use super::attempt_ops;
use super::attention_rules::EventRules;
use super::continuity::{ContinuityError, ErrorKind, Outcome, Settings};
use super::continuity_tests::{core, foto as foto_continuidad, mundo, paquete_de, persona, sin_resume, todos, tipos, Mundo, Tmp, PERFIL, REF};
use super::event_kinds::FailureCode;
use super::events::{Actor, Channel, MutationContext};
use super::session_ops;
use crate::store::{
    AttemptRow, AttemptStatus, AttentionProjection, ContinuationReason as Reason, ContinuityStrategy as Strategy, NewAttempt, NewProviderSession, RetryOverride, SessionBinding, SessionStatus,
};

/// La referencia del proveedor es única por sesión: la segunda Task de una prueba usa otra.
const REF_OTRA: &str = "REF-OPACA-otra-7a3d9c10-5e2b";

// ── Ayudantes ────────────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum Fin {
    Done,
    Failed,
    Stopped,
    Exited,
}

/// Un Attempt de la Task que arrancó y terminó como `fin`; con sesión resumible en espera si `referencia`.
fn termina(w: &mut Mundo, task: &str, provider: &str, fin: Fin, referencia: Option<&str>) -> (AttemptRow, Option<String>) {
    let new = NewAttempt { provider: provider.into(), model: Some("modelo-x".into()), effort: Some("alto".into()), role: Some("implementador".into()), profile: Some(PERFIL.into()), external: false, requires_approval: false };
    let a = attempt_ops::create(&mut w.s, &persona(), task, &new).unwrap();
    attempt_ops::start(&mut w.s, &core(), &a.id).unwrap();
    let ps = referencia.map(|r| session_ops::open(&mut w.s, &core(), &a.id, &NewProviderSession { resumable: true, external_ref: Some((r.to_string(), SessionBinding::StreamJson)) }).unwrap().id);
    match fin {
        Fin::Done => attempt_ops::finish(&mut w.s, &core(), &a.id, "listo").unwrap(),
        Fin::Failed => attempt_ops::fail(&mut w.s, &core(), &a.id, FailureCode::AgentReported, "no pudo").unwrap(),
        Fin::Stopped => attempt_ops::cancel(&mut w.s, &core(), &a.id, super::event_kinds::StopCause::Cancelled).unwrap(),
        Fin::Exited => attempt_ops::exit(&mut w.s, &core(), &a.id).unwrap(),
    };
    if let Some(ps) = &ps {
        session_ops::detach(&mut w.s, &core(), ps).unwrap();
    }
    (w.s.attempt_row(&a.id).unwrap().unwrap(), ps)
}

fn fallido(w: &mut Mundo, task: &str, provider: &str) -> AttemptRow {
    termina(w, task, provider, Fin::Failed, None).0
}

fn cmd<'a>(request: &'a str, task: &'a str) -> RetryCommand<'a> {
    RetryCommand { request_id: request, task_id: task, from_attempt_id: None, prompt: None, worktree: std::path::Path::new("wt"), provider: None, model: None, effort: None, profile: None }
}

fn reintenta(w: &mut Mundo, ctx: &MutationContext, c: &RetryCommand<'_>) -> Result<RetryOutcome, CommandError> {
    retry(&mut w.s, &w.reg, ctx, &CancelToken::new(), c)
}

fn ok(r: Result<RetryOutcome, CommandError>) -> RetryOutcome {
    r.unwrap_or_else(|e| panic!("debía reintentar: {e}"))
}

fn err(r: Result<RetryOutcome, CommandError>) -> CommandError {
    match r {
        Err(e) => e,
        Ok(o) => panic!("debía fallar: intento {}", o.attempt.n),
    }
}

/// Todo lo que deja rastro, con las dos tablas de procedencia.
fn foto(w: &Mundo) -> Vec<i64> {
    let mut v = foto_continuidad(w);
    v.push(w.s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM attempt_retries", [], |r| r.get(0))?)).unwrap());
    v
}

fn estado(w: &Mundo, id: &str) -> AttemptStatus {
    w.s.attempt_row(id).unwrap().unwrap().status
}

fn payload(w: &Mundo, kind: &str) -> Value {
    serde_json::from_str(&todos(&w.s).into_iter().find(|e| e.kind == kind).unwrap_or_else(|| panic!("no hay {kind}")).payload).unwrap()
}

fn attentions(w: &Mundo, categoria: &str) -> Vec<(String, String, Option<String>)> {
    w.s.read(|c| {
        Ok(c.prepare("SELECT target_id, status, resolution FROM attention_items WHERE category = ?1 ORDER BY target_id")?
            .query_map([categoria], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?)
    })
    .unwrap()
}

fn con_attention(w: &mut Mundo) {
    w.s.set_event_projector(Arc::new(AttentionProjection::new(Arc::new(EventRules))));
}

// ── attempt.retry · éxito ────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn reintentar_un_attempt_fallido_crea_uno_limpio_que_hereda_sus_parametros_y_no_toca_el_anterior() {
    for fin in [Fin::Failed, Fin::Stopped, Fin::Exited] {
        let t = Tmp::new();
        let mut w = mundo(t.path());
        let hija = w.hija.clone();
        let (a1, _) = termina(&mut w, &hija, "claude", fin, Some(REF));
        let antes = todos(&w.s).len();

        let o = ok(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
        assert!(!o.replayed && o.run.is_some());
        assert_eq!((o.attempt.n, o.attempt.status, o.attempt.id.as_str()), (2, AttemptStatus::Running, format!("{hija}-a2").as_str()));
        // Hereda todo lo que no se pidió distinto, y arranca LIMPIO: nada de la sesión del anterior.
        assert_eq!((o.attempt.provider.as_str(), o.attempt.model.as_deref(), o.attempt.effort.as_deref(), o.attempt.role.as_deref(), o.attempt.profile.as_deref()), ("claude", Some("modelo-x"), Some("alto"), Some("implementador"), Some(PERFIL)));
        assert_eq!(o.attempt.provider_session_id, None);
        assert_eq!((o.retry.from_attempt_id.as_str(), o.retry.from_n, o.retry.overrides.is_empty()), (a1.id.as_str(), 1, true));
        // Al adapter llegó un start (ni resume ni sesión), con el encargo de la Task y los permisos del original.
        assert!(w.claude.resumes().is_empty());
        let s = &w.claude.starts()[0];
        assert_eq!((s.attempt_id.as_str(), s.prompt.as_str(), s.profile.as_str(), s.model.as_deref()), (o.attempt.id.as_str(), "api", PERFIL, Some("modelo-x")));
        // Provenance y eventos, en orden.
        assert_eq!(tipos(&w.s)[antes..], ["attempt.requested", "attempt.retried", "attempt.started"]);
        let p = payload(&w, "attempt.retried");
        assert_eq!((p["task"].as_str(), p["n"].as_i64(), p["from_n"].as_i64()), (Some(hija.as_str()), Some(2), Some(1)));
        assert!(p.get("overrides").is_none(), "sin cambios, no hay overrides: {p}");
        let e = todos(&w.s).into_iter().find(|e| e.kind == "attempt.retried").unwrap();
        assert_eq!((e.entity_kind.as_str(), e.entity_id.as_str()), ("attempt", o.attempt.id.as_str()));
        // El Attempt anterior es historia: no cambió (invariante 1) y su sesión sigue en espera.
        assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), a1);
        assert!(todos(&w.s).iter().all(|e| !e.payload.contains(REF)));
    }
}

#[test]
fn los_overrides_son_explicitos_y_cambiar_de_proveedor_no_arrastra_su_modelo() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = fallido(&mut w, &hija, "claude");

    // Otro modelo y otro perfil en el mismo proveedor: el esfuerzo se hereda.
    let mut c = cmd("req-1", &hija);
    c.model = Some("modelo-y");
    c.profile = Some("explorar");
    c.effort = Some("alto"); // pedir lo que ya tenía NO es un override
    let o = ok(reintenta(&mut w, &persona(), &c));
    assert_eq!((o.attempt.model.as_deref(), o.attempt.effort.as_deref(), o.attempt.profile.as_deref()), (Some("modelo-y"), Some("alto"), Some("explorar")));
    assert_eq!(o.retry.overrides, [RetryOverride::Model, RetryOverride::Profile]);
    assert_eq!(payload(&w, "attempt.retried")["overrides"], serde_json::json!(["model", "profile"]));
    assert_eq!(w.claude.starts()[0].profile, "explorar");
    assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), a1);

    // Otro proveedor: arranca en él, sin el modelo ni el esfuerzo del anterior, y el perfil sí se hereda.
    attempt_ops::fail(&mut w.s, &core(), &o.attempt.id, FailureCode::AgentIdleTimeout, "").unwrap();
    let mut c = cmd("req-2", &hija);
    c.provider = Some("codex");
    let o2 = ok(reintenta(&mut w, &persona(), &c));
    assert_eq!((o2.attempt.provider.as_str(), o2.attempt.model.as_deref(), o2.attempt.effort.as_deref(), o2.attempt.profile.as_deref()), ("codex", None, None, Some("explorar")));
    assert_eq!(o2.retry.overrides, [RetryOverride::Provider]);
    assert_eq!((w.codex.starts().len(), w.claude.starts().len()), (1, 1));
}

#[test]
fn el_mensaje_se_hereda_del_encargo_de_la_task_o_se_pide_explicito() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    fallido(&mut w, &hija, "claude");
    let mut c = cmd("req-1", &hija);
    c.prompt = Some("prueba otra vez, pero sin tocar la base");
    ok(reintenta(&mut w, &persona(), &c));
    assert_eq!(w.claude.starts()[0].prompt, "prueba otra vez, pero sin tocar la base");
    // El mensaje no viaja en ningún evento.
    assert!(todos(&w.s).iter().all(|e| !e.payload.contains("sin tocar la base")));
}

// ── attempt.retry · idempotencia ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn repetir_el_reintento_no_duplica_attempts_ni_vuelve_a_lanzar() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    fallido(&mut w, &hija, "claude");
    let primero = ok(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
    let antes = foto(&w);
    let eventos = tipos(&w.s);

    // Aunque el reintento ya esté corriendo (o haya terminado), la misma clave devuelve ese, no crea otro.
    for _ in 0..2 {
        let otra = ok(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
        assert!(otra.replayed && otra.run.is_none());
        assert_eq!((otra.attempt.id.as_str(), &otra.retry), (primero.attempt.id.as_str(), &primero.retry));
        assert_eq!(foto(&w), antes, "un reintento no escribe");
        assert_eq!(tipos(&w.s), eventos);
        assert_eq!(w.claude.starts().len(), 1, "ni vuelve a lanzar");
    }
    attempt_ops::fail(&mut w.s, &core(), &primero.attempt.id, FailureCode::AgentReported, "").unwrap();
    let tras_fallar = foto(&w);
    let otra = ok(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
    assert!(otra.replayed);
    assert_eq!(otra.attempt.id, primero.attempt.id);
    assert_eq!(otra.attempt.status, AttemptStatus::Failed, "devuelve el estado que tenga");
    assert_eq!(foto(&w), tras_fallar);
}

#[test]
fn una_clave_reutilizada_para_otra_cosa_se_rechaza_en_vez_de_atender_lo_viejo() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = fallido(&mut w, &hija, "claude");
    let primero = ok(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
    let antes = foto(&w);

    let mut otro_modelo = cmd("req-1", &hija);
    otro_modelo.model = Some("modelo-z");
    let mut otro_proveedor = cmd("req-1", &hija);
    otro_proveedor.provider = Some("codex");
    let mut otro_origen = cmd("req-1", &hija);
    otro_origen.from_attempt_id = Some("t-inventado-a1");
    for c in [otro_modelo, otro_proveedor, otro_origen] {
        let e = err(reintenta(&mut w, &persona(), &c));
        assert_eq!((e.kind, e.code, e.attempt_id.as_deref()), (ErrorKind::Invalid, "request_conflict", Some(primero.attempt.id.as_str())));
    }
    // Nombrar el mismo origen de entonces sí es la misma petición.
    let mut mismo = cmd("req-1", &hija);
    mismo.from_attempt_id = Some(&a1.id);
    assert!(ok(reintenta(&mut w, &persona(), &mismo)).replayed);
    assert_eq!(foto(&w), antes);
}

#[test]
fn una_clave_no_sirve_a_la_vez_para_un_reintento_y_para_una_reanudacion() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());

    // En `hija`, la clave la gasta un reintento: reanudar con ella es otra petición.
    fallido(&mut w, &hija, "claude");
    let a2 = ok(reintenta(&mut w, &persona(), &cmd("k1", &hija))).attempt;
    attempt_ops::fail(&mut w.s, &core(), &a2.id, FailureCode::AgentReported, "").unwrap();
    let antes = foto(&w);
    let e = reanuda(&mut w, &persona(), &resume_cmd("k1", &hija, &a2.id)).unwrap_err();
    assert_eq!((e.kind, e.code, e.attempt_id.as_deref()), (ErrorKind::Invalid, "request_conflict", Some(a2.id.as_str())));
    assert_eq!(foto(&w), antes);

    // En `otra`, la gasta una reanudación: reintentar con ella es otra petición. La clave es de la Task: `hija` no la ve.
    let (b1, _) = termina(&mut w, &otra, "claude", Fin::Failed, Some(REF_OTRA));
    let b2 = reanuda(&mut w, &persona(), &resume_cmd("k2", &otra, &b1.id)).unwrap().attempt;
    attempt_ops::fail(&mut w.s, &core(), &b2.id, FailureCode::AgentReported, "").unwrap();
    let antes = foto(&w);
    let e = err(reintenta(&mut w, &persona(), &cmd("k2", &otra)));
    assert_eq!((e.kind, e.code, e.attempt_id.as_deref()), (ErrorKind::Invalid, "request_conflict", Some(b2.id.as_str())));
    assert_eq!(foto(&w), antes);
    ok(reintenta(&mut w, &persona(), &cmd("k2", &hija)));
}

// ── attempt.retry · Task y Attempt final o activo ────────────────────────────────────────────────────────────────────

#[test]
fn con_un_attempt_activo_no_se_reintenta_ni_se_crea_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = fallido(&mut w, &hija, "claude");
    let a2 = ok(reintenta(&mut w, &persona(), &cmd("req-1", &hija))).attempt;
    let antes = foto(&w);
    // El nuevo corre: ni pedir otro reintento, ni nombrar el anterior, ni nombrar el activo.
    for from in [None, Some(a1.id.as_str()), Some(a2.id.as_str())] {
        let mut c = cmd("req-2", &hija);
        c.from_attempt_id = from;
        let e = err(reintenta(&mut w, &persona(), &c));
        assert_eq!((e.kind, e.code), (ErrorKind::Invalid, "attempt_active"));
        assert!(e.message.contains(&a2.id) && e.attempt_id.is_none());
    }
    assert_eq!(foto(&w), antes);
    assert_eq!(estado(&w, &a2.id), AttemptStatus::Running, "el activo no se toca");
}

#[test]
fn un_attempt_que_termino_bien_o_que_no_es_el_ultimo_no_se_reintenta() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let (hecho, _) = termina(&mut w, &hija, "claude", Fin::Done, None);
    let antes = foto(&w);
    let e = err(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
    assert_eq!((e.kind, e.code), (ErrorKind::Invalid, "source_not_retryable"));
    assert_eq!(foto(&w), antes);
    assert_eq!(estado(&w, &hecho.id), AttemptStatus::Done);

    // El primero ya tiene uno posterior: solo se reintenta el último.
    let a1 = fallido(&mut w, &otra, "claude");
    let _a2 = termina(&mut w, &otra, "claude", Fin::Stopped, None).0;
    let antes = foto(&w);
    let mut c = cmd("req-2", &otra);
    c.from_attempt_id = Some(&a1.id);
    assert_eq!(err(reintenta(&mut w, &persona(), &c)).code, "source_not_latest");
    assert_eq!(foto(&w), antes);
}

#[test]
fn una_task_sin_attempts_o_un_origen_ajeno_o_inexistente_se_rechaza() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let antes = foto(&w);
    assert_eq!(err(reintenta(&mut w, &persona(), &cmd("req-1", &hija))).code, "no_attempts");
    assert_eq!(err(reintenta(&mut w, &persona(), &cmd("req-1", "t-inventada"))).code, "task_missing");
    let ajeno = fallido(&mut w, &otra, "claude");
    let mut c = cmd("req-2", &hija);
    c.from_attempt_id = Some(&ajeno.id);
    assert_eq!(err(reintenta(&mut w, &persona(), &c)).code, "no_attempts");
    fallido(&mut w, &hija, "claude");
    let antes_ajeno = foto(&w);
    assert_eq!(err(reintenta(&mut w, &persona(), &c)).code, "source_not_in_task");
    let mut c = cmd("req-3", &hija);
    c.from_attempt_id = Some("no-existe-a1");
    assert_eq!(err(reintenta(&mut w, &persona(), &c)).code, "source_missing");
    assert_eq!(foto(&w), antes_ajeno);
    assert_ne!(antes, antes_ajeno);
}

#[test]
fn quien_no_puede_o_pide_mal_no_deja_rastro() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    fallido(&mut w, &hija, "claude");
    let antes = foto(&w);
    let hermana = MutationContext { actor: Actor::Agent(w.otra.clone()), channel: Channel::Lxo, client_id: None };
    assert_eq!(err(reintenta(&mut w, &hermana, &cmd("req-1", &hija))).code, "not_allowed");
    for clave in ["", "con espacio", "ñandú", &"x".repeat(65)] {
        assert_eq!(err(reintenta(&mut w, &persona(), &cmd(clave, &hija))).code, "invalid_request", "clave «{clave}»");
    }
    let mut c = cmd("req-1", &hija);
    c.prompt = Some("   ");
    assert_eq!(err(reintenta(&mut w, &persona(), &c)).code, "invalid_request");
    assert_eq!(foto(&w), antes);
    // El Core sí puede (lo usará el runtime).
    ok(reintenta(&mut w, &core(), &cmd("req-1", &hija)));
}

#[test]
fn sin_perfil_de_permisos_no_hay_con_que_lanzar() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let sin_perfil = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    let a = attempt_ops::create(&mut w.s, &persona(), &hija, &sin_perfil).unwrap();
    attempt_ops::fail(&mut w.s, &core(), &a.id, FailureCode::LaunchFailed, "").unwrap();
    let antes = foto(&w);
    assert_eq!(err(reintenta(&mut w, &persona(), &cmd("req-1", &hija))).code, "profile_missing");
    assert_eq!(foto(&w), antes);
    let mut c = cmd("req-1", &hija);
    c.profile = Some("proponer");
    ok(reintenta(&mut w, &persona(), &c));
}

// ── attempt.retry · entorno bloqueado y fallos de lanzamiento ────────────────────────────────────────────────────────

#[test]
fn un_entorno_bloqueado_no_crea_nada_ni_consume_un_fallo_del_agente() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = fallido(&mut w, &hija, "claude");
    w.claude.set_probe(ProbeResult::blocked(None, vec![EnvBlock::CliMissing]));
    w.reg.refresh("claude").unwrap();
    let antes = foto(&w);
    let e = err(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
    assert_eq!((e.kind, e.code, e.fallback_available, e.attempt_id), (ErrorKind::EnvironmentBlocked, "environment_blocked", false, None));
    assert_eq!(foto(&w), antes, "nada se creó");
    assert!(w.claude.calls().iter().all(|c| c != "start"));
    assert_eq!(estado(&w, &a1.id), AttemptStatus::Failed);

    // Cuando el entorno se arregla, la MISMA clave sirve: el bloqueo no la gastó.
    w.claude.set_probe(ProbeResult::ready(Some("0.0.0-fake"), super::adapter::CapabilityMatrix::all_available()));
    w.reg.refresh("claude").unwrap();
    let o = ok(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
    assert_eq!(o.attempt.n, 2);
}

#[test]
fn un_bloqueo_que_salta_al_lanzar_deja_el_attempt_nuevo_stopped_y_no_failed() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = fallido(&mut w, &hija, "claude");
    w.claude.fail_start_with(Some(AdapterError::environment_blocked(EnvBlock::CliMissing)));
    let e = err(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
    assert_eq!((e.kind, e.fallback_available), (ErrorKind::EnvironmentBlocked, false));
    let nuevo = e.attempt_id.expect("nombra el Attempt que quedó cerrado");
    assert_eq!(estado(&w, &nuevo), AttemptStatus::Stopped, "un entorno bloqueado no es un fallo del agente");
    assert_eq!(estado(&w, &a1.id), AttemptStatus::Failed);
    let fallos = w.s.attempts_of_task(&hija).unwrap().iter().filter(|a| a.status == AttemptStatus::Failed).count();
    assert_eq!(fallos, 1, "solo cuenta el fallo del agente original");
    // Repetir la clave devuelve ese Attempt cerrado, sin relanzar; para volver a intentar hace falta una clave nueva.
    w.claude.fail_start_with(None);
    let otra_vez = ok(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
    assert!(otra_vez.replayed && otra_vez.attempt.status == AttemptStatus::Stopped);
    let o = ok(reintenta(&mut w, &persona(), &cmd("req-2", &hija)));
    assert_eq!((o.attempt.n, o.attempt.status), (3, AttemptStatus::Running));
}

#[test]
fn un_fallo_del_proveedor_al_lanzar_deja_el_attempt_nuevo_failed_y_el_anterior_intacto() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = fallido(&mut w, &hija, "claude");
    w.claude.fail_start_with(Some(AdapterError::provider("el CLI se cayó")));
    let e = err(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
    assert_eq!((e.kind, e.code), (ErrorKind::Failed, "launch_failed"));
    let nuevo = w.s.attempt_row(&e.attempt_id.unwrap()).unwrap().unwrap();
    assert_eq!((nuevo.status, nuevo.failure_reason.as_deref()), (AttemptStatus::Failed, Some("launch_failed")));
    assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), a1);
    // Un fallo es un Attempt cerrado: se puede reintentar de nuevo, con otra clave.
    w.claude.fail_start_with(None);
    assert_eq!(ok(reintenta(&mut w, &persona(), &cmd("req-2", &hija))).attempt.n, 3);
}

#[test]
fn un_proveedor_que_no_existe_o_que_no_puede_lanzar_no_crea_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    fallido(&mut w, &hija, "claude");
    let antes = foto(&w);
    let mut c = cmd("req-1", &hija);
    c.provider = Some("fantasma");
    assert_eq!(err(reintenta(&mut w, &persona(), &c)).kind, ErrorKind::Invalid);
    w.codex.set_probe(ProbeResult::ready(Some("0.0.0-fake"), super::adapter::CapabilityMatrix::all_available().with(super::adapter::Capability::Start, super::adapter::CapabilityState::Unsupported)));
    w.reg.refresh("codex").unwrap();
    c.provider = Some("codex");
    let e = err(reintenta(&mut w, &persona(), &c));
    assert_eq!((e.kind, e.code), (ErrorKind::Unsupported, "start_unavailable"));
    assert_eq!(foto(&w), antes);
}

// ── attempt.retry · Attention ────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn reintentar_atiende_el_fallo_del_attempt_anterior_y_si_el_nuevo_falla_levanta_el_suyo() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    con_attention(&mut w);
    let hija = w.hija.clone();
    let a1 = fallido(&mut w, &hija, "claude");
    assert_eq!(attentions(&w, "failed"), [(a1.id.clone(), "active".into(), None)], "el fallo levanta Attention sobre su Attempt");

    let o = ok(reintenta(&mut w, &persona(), &cmd("req-1", &hija)));
    assert_eq!(attentions(&w, "failed"), [(a1.id.clone(), "resolved".into(), Some("acted".into()))], "reintentar es actuar sobre el fallo");

    attempt_ops::fail(&mut w.s, &core(), &o.attempt.id, FailureCode::AgentReported, "").unwrap();
    assert_eq!(
        attentions(&w, "failed"),
        [(a1.id.clone(), "resolved".into(), Some("acted".into())), (o.attempt.id.clone(), "active".into(), None)],
        "el fallo del reintento es suyo, no reabre el anterior"
    );
}

// ── attempt.resume ───────────────────────────────────────────────────────────────────────────────────────────────────

fn resume_cmd<'a>(request: &'a str, task: &'a str, from: &'a str) -> ResumeCommand<'a> {
    ResumeCommand { request_id: request, task_id: task, from_attempt_id: from, prompt: "sigue con el login", worktree: std::path::Path::new("wt"), provider: None, profile: None, model: None, effort: None, fallback: None }
}

fn reanuda(w: &mut Mundo, ctx: &MutationContext, c: &ResumeCommand<'_>) -> Result<Outcome, ContinuityError> {
    resume(&mut w.s, &w.reg, ctx, &CancelToken::new(), &Settings::default(), c)
}

fn sesion(w: &Mundo, id: &str) -> SessionStatus {
    w.s.provider_session_row(id).unwrap().unwrap().status
}

#[test]
fn resume_soportado_reanuda_la_misma_sesion_en_un_attempt_nuevo_sin_reabrir_el_anterior() {
    for fin in [Fin::Done, Fin::Failed, Fin::Stopped, Fin::Exited] {
        let t = Tmp::new();
        let mut w = mundo(t.path());
        let hija = w.hija.clone();
        let (a1, ps) = termina(&mut w, &hija, "claude", fin, Some(REF));
        let ps = ps.unwrap();
        let antes = todos(&w.s).len();

        let o = reanuda(&mut w, &persona(), &resume_cmd("req-1", &hija, &a1.id)).unwrap_or_else(|e| panic!("debía reanudar: {e}"));
        assert!(!o.replayed && o.run.is_some());
        assert_eq!((o.attempt.n, o.attempt.status), (2, AttemptStatus::Running));
        assert_eq!((o.continuation.strategy, o.continuation.reason, o.continuation.from_n), (Strategy::NativeResume, Reason::Preferred, 1));
        // La MISMA ProviderSession continúa (no se abre otra): el Attempt anterior sigue siendo historia.
        assert_eq!(o.attempt.provider_session_id.as_deref(), Some(ps.as_str()));
        assert_eq!(sesion(&w, &ps), SessionStatus::Open);
        assert_eq!(w.claude.resumes()[0].provider_ref.expose(), REF);
        assert!(w.claude.starts().is_empty());
        assert_eq!(tipos(&w.s)[antes..], ["attempt.requested", "attempt.continued", "provider_session.resumed", "attempt.started"]);
        assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), a1);
        assert_eq!(w.s.provider_sessions_of_task(&hija).unwrap().len(), 1, "ninguna sesión nueva");
    }
}

#[test]
fn resume_repetido_devuelve_el_mismo_attempt_y_no_relanza() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, _) = termina(&mut w, &hija, "claude", Fin::Failed, Some(REF));
    let primero = reanuda(&mut w, &persona(), &resume_cmd("req-1", &hija, &a1.id)).unwrap();
    let antes = foto(&w);
    let otra = reanuda(&mut w, &persona(), &resume_cmd("req-1", &hija, &a1.id)).unwrap();
    assert!(otra.replayed && otra.run.is_none());
    assert_eq!(otra.attempt.id, primero.attempt.id);
    assert_eq!((foto(&w), w.claude.resumes().len()), (antes, 1));
}

#[test]
fn resume_con_la_sesion_caducada_o_sin_resume_no_se_hace_solo_y_dice_que_un_paquete_lo_resolveria() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = termina(&mut w, &hija, "claude", Fin::Failed, Some(REF));
    let ps = ps.unwrap();

    // Caducada: el proveedor ya no la tiene.
    session_ops::close(&mut w.s, &core(), &ps).unwrap();
    let antes = foto(&w);
    let e = reanuda(&mut w, &persona(), &resume_cmd("req-1", &hija, &a1.id)).unwrap_err();
    assert_eq!((e.kind, e.code, e.fallback_available, e.attempt_id), (ErrorKind::Expired, "session_expired", true, None));
    assert_eq!(foto(&w), antes, "no hay auto-resume ni fallback silencioso");

    // No soportado: el proveedor no ofrece `resume`.
    let otra = w.otra.clone();
    let (b1, _) = termina(&mut w, &otra, "claude", Fin::Failed, Some(REF_OTRA));
    w.claude.set_probe(sin_resume());
    w.reg.refresh("claude").unwrap();
    let antes = foto(&w);
    let e = reanuda(&mut w, &persona(), &resume_cmd("req-2", &otra, &b1.id)).unwrap_err();
    assert_eq!((e.kind, e.code, e.fallback_available), (ErrorKind::Unsupported, "resume_unsupported", true));
    assert_eq!(foto(&w), antes);
    assert!(w.claude.calls().iter().all(|c| c != "start" && c != "resume"));
}

#[test]
fn resume_sin_sesion_es_no_soportado() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = fallido(&mut w, &hija, "claude");
    let antes = foto(&w);
    let e = reanuda(&mut w, &persona(), &resume_cmd("req-1", &hija, &a1.id)).unwrap_err();
    assert_eq!((e.kind, e.code, e.fallback_available), (ErrorKind::Unsupported, "session_unavailable", true));
    assert_eq!(foto(&w), antes);
}

#[test]
fn el_fallback_a_context_package_solo_se_aplica_si_el_cliente_lo_confirma_con_el_motivo_que_vio() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = termina(&mut w, &hija, "claude", Fin::Failed, Some(REF));
    let ps = ps.unwrap();
    session_ops::close(&mut w.s, &core(), &ps).unwrap();
    let pkg = paquete_de(&hija, &a1.id, "claude");

    // 1. Sin confirmar: el error lo ofrece y no se crea nada.
    let e = reanuda(&mut w, &persona(), &resume_cmd("req-1", &hija, &a1.id)).unwrap_err();
    assert!(e.fallback_available && e.code == "session_expired");
    let antes = foto(&w);

    // 2. Confirmado por OTRO motivo (el cliente vio que no había `resume`, pero lo que pasa es que caducó): no se aplica.
    let mut c = resume_cmd("req-1", &hija, &a1.id);
    c.fallback = Some(Fallback { package: &pkg, confirmed_reason: Reason::ResumeUnsupported });
    let e = reanuda(&mut w, &persona(), &c).unwrap_err();
    assert_eq!((e.kind, e.code, e.fallback_available), (ErrorKind::Invalid, "fallback_changed", true));
    assert_eq!(foto(&w), antes);

    // 3. Un paquete que no sale de ese Attempt, o inválido: nada.
    let ajeno = paquete_de(&hija, "otro-a1", "claude");
    c.fallback = Some(Fallback { package: &ajeno, confirmed_reason: Reason::SessionExpired });
    assert_eq!(reanuda(&mut w, &persona(), &c).unwrap_err().code, "package_source_mismatch");
    c.fallback = Some(Fallback { package: "{}", confirmed_reason: Reason::SessionExpired });
    assert_eq!(reanuda(&mut w, &persona(), &c).unwrap_err().code, "package_invalid");
    assert_eq!(foto(&w), antes);

    // 4. Confirmado por el motivo correcto: Attempt NUEVO y LIMPIO, con el motivo visible en el evento.
    c.fallback = Some(Fallback { package: &pkg, confirmed_reason: Reason::SessionExpired });
    let antes_eventos = todos(&w.s).len();
    let o = reanuda(&mut w, &persona(), &c).unwrap();
    assert_eq!((o.continuation.strategy, o.continuation.reason), (Strategy::ContextPackage, Reason::SessionExpired));
    assert_eq!((o.attempt.n, o.attempt.provider_session_id.clone()), (2, None), "limpio: sin la sesión del anterior");
    assert!(o.continuation.package_id.is_some());
    assert_eq!(sesion(&w, &ps), SessionStatus::Closed, "la sesión caducada no se toca");
    assert!(w.claude.resumes().is_empty() && w.claude.starts().len() == 1, "no se finge continuidad");
    assert!(w.claude.starts()[0].prompt.contains("dejar el login funcionando") && w.claude.starts()[0].prompt.contains("sigue con el login"));
    assert_eq!(tipos(&w.s)[antes_eventos..], ["attempt.requested", "attempt.continued", "attempt.started"]);
    let p = payload(&w, "attempt.continued");
    assert_eq!((p["strategy"].as_str(), p["reason"].as_str(), p["from_n"].as_i64()), (Some("context_package"), Some("session_expired"), Some(1)));
    assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), a1);
}

#[test]
fn con_otro_proveedor_solo_hay_fallback_y_la_sesion_no_se_comparte() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = termina(&mut w, &hija, "claude", Fin::Failed, Some(REF));
    let ps = ps.unwrap();
    let mut c = resume_cmd("req-1", &hija, &a1.id);
    c.provider = Some("codex");
    let antes = foto(&w);
    let e = reanuda(&mut w, &persona(), &c).unwrap_err();
    assert_eq!((e.kind, e.code, e.fallback_available), (ErrorKind::Invalid, "provider_mismatch", true));
    assert_eq!(foto(&w), antes);

    let pkg = paquete_de(&hija, &a1.id, "claude");
    c.fallback = Some(Fallback { package: &pkg, confirmed_reason: Reason::ProviderChanged });
    let o = reanuda(&mut w, &persona(), &c).unwrap();
    assert_eq!((o.attempt.provider.as_str(), o.continuation.strategy, o.continuation.reason), ("codex", Strategy::ContextPackage, Reason::ProviderChanged));
    assert_eq!(sesion(&w, &ps), SessionStatus::Idle, "la sesión de Claude no se tocó");
    assert!(w.claude.calls().iter().all(|c| c != "resume" && c != "start"));
}

#[test]
fn si_el_resume_vuelve_a_ser_posible_con_el_fallback_confirmado_se_reanuda_de_forma_nativa() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, _) = termina(&mut w, &hija, "claude", Fin::Failed, Some(REF));
    let pkg = paquete_de(&hija, &a1.id, "claude");
    let mut c = resume_cmd("req-1", &hija, &a1.id);
    c.fallback = Some(Fallback { package: &pkg, confirmed_reason: Reason::SessionExpired });
    let o = reanuda(&mut w, &persona(), &c).unwrap();
    assert_eq!(o.continuation.strategy, Strategy::NativeResume, "lo mejor posible, y el cliente lo ve en la estrategia");
    assert!(w.claude.starts().is_empty());
}

#[test]
fn resume_con_un_attempt_activo_o_un_origen_no_final_se_rechaza_sin_rastro() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let (a1, _) = termina(&mut w, &hija, "claude", Fin::Failed, Some(REF));
    let a2 = ok(reintenta(&mut w, &persona(), &cmd("req-0", &hija))).attempt; // activo
    let antes = foto(&w);
    // El origen sigue activo.
    let e = reanuda(&mut w, &persona(), &resume_cmd("req-1", &hija, &a2.id)).unwrap_err();
    assert_eq!((e.kind, e.code), (ErrorKind::Invalid, "source_not_final"));
    // El origen es final, pero la Task ya tiene otro Attempt activo.
    let e = reanuda(&mut w, &persona(), &resume_cmd("req-2", &hija, &a1.id)).unwrap_err();
    assert_eq!((e.kind, e.code), (ErrorKind::Invalid, "attempt_active"));
    assert!(e.message.contains(&a2.id));
    // Un origen de otra Task o inexistente.
    let (b1, _) = termina(&mut w, &otra, "claude", Fin::Failed, Some(REF_OTRA));
    let antes_ajeno = foto(&w);
    assert_eq!(reanuda(&mut w, &persona(), &resume_cmd("req-3", &hija, &b1.id)).unwrap_err().code, "source_not_in_task");
    assert_eq!(reanuda(&mut w, &persona(), &resume_cmd("req-4", &hija, "no-existe-a1")).unwrap_err().code, "source_missing");
    assert_ne!(antes, antes_ajeno);
    assert_eq!((foto(&w), estado(&w, &a2.id)), (antes_ajeno, AttemptStatus::Running));
}

#[test]
fn resume_con_el_entorno_bloqueado_no_se_esquiva_ni_falla_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = termina(&mut w, &hija, "claude", Fin::Failed, Some(REF));
    let ps = ps.unwrap();
    w.claude.set_probe(ProbeResult::blocked(None, vec![EnvBlock::CliMissing]));
    w.reg.refresh("claude").unwrap();
    let pkg = paquete_de(&hija, &a1.id, "claude");
    let antes = foto(&w);
    let mut c = resume_cmd("req-1", &hija, &a1.id);
    for fallback in [None, Some(Fallback { package: &pkg, confirmed_reason: Reason::SessionExpired })] {
        c.fallback = fallback;
        let e = reanuda(&mut w, &persona(), &c).unwrap_err();
        assert_eq!((e.kind, e.code, e.fallback_available), (ErrorKind::EnvironmentBlocked, "environment_blocked", false));
    }
    assert_eq!((foto(&w), estado(&w, &a1.id), sesion(&w, &ps)), (antes, AttemptStatus::Failed, SessionStatus::Idle));
}

#[test]
fn resume_atiende_el_fallo_del_attempt_anterior_en_attention() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    con_attention(&mut w);
    let hija = w.hija.clone();
    let (a1, _) = termina(&mut w, &hija, "claude", Fin::Failed, Some(REF));
    assert_eq!(attentions(&w, "failed"), [(a1.id.clone(), "active".into(), None)]);
    reanuda(&mut w, &persona(), &resume_cmd("req-1", &hija, &a1.id)).unwrap();
    assert_eq!(attentions(&w, "failed"), [(a1.id, "resolved".into(), Some("acted".into()))]);
}

#[test]
fn el_script_de_un_proveedor_que_falla_al_reanudar_no_altera_el_comando() {
    // La reanudación que el proveedor rechaza al leer su flujo se cierra con `settle_failure` (continuity_tests); aquí solo
    // se fija que el comando entrega el `RunHandle` para que el runtime lo lea.
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, _) = termina(&mut w, &hija, "claude", Fin::Failed, Some(REF));
    w.claude.set_script(vec![Step::Fail(AdapterError::session_not_found())]);
    let o = reanuda(&mut w, &persona(), &resume_cmd("req-1", &hija, &a1.id)).unwrap();
    assert!(o.run.is_some());
}
