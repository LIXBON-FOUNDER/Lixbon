//! LXO-88 · camino real de `spawn` con la policy bloqueada.
//!
//! Solo una DENEGACIÓN EXPLÍCITA de policy (`agents::explicit_denial`: hoy, el perfil deshabilitado
//! `autonomia_amplia`) sobre una solicitud válida deja `spawn.requested` con `policy_status = blocked` durable ANTES
//! de que se devuelva la denegación, sin ningún efecto de lanzamiento. Todo lo demás sigue como antes y NO deja
//! Event: la entrada inválida (agente, modelo, esfuerzo, perfil, rol o combinación proveedor × perfil sin
//! definición) y el bloqueo del entorno/proveedor (CLI ausente, flags, sandbox). Si el Event no se puede persistir, el
//! error es el de la persistencia: nunca una denegación «registrada».

use serde_json::{json, Value};

use super::agents;
use super::spawn_approval::{EV_PENDING, EV_RESOLVED};
use super::spawn_cleanup_tests::{desde, fake, head, kinds, pl, setup_con, Env};
use super::{Caller, Resolver};

/// El perfil que la policy deshabilita de forma explícita (`Profile::disabled_reason`).
const EXPLICITA: &str = "autonomia_amplia";

/// Un bloqueo que NO es una decisión de policy (p. ej. CLI ausente): el resolvedor marca `blocked` un perfil que
/// está habilitado.
fn bloqueada_por_entorno(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> agents::Policy {
    let mut p = fake(provider, profile, role, worktree);
    p.status = agents::Status::Blocked;
    p.reason = Some("CLI ausente en la prueba".into());
    p
}

fn verificada(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> agents::Policy {
    let mut p = fake(provider, profile, role, worktree);
    p.status = agents::Status::Ok;
    p.reason = None;
    p
}

fn pide(e: &Env, extra: Value) -> Result<Value, String> {
    let mut args = json!({ "agent": "claude", "task": "Encargo\nDetalle", "name": "Hija", "shared": true });
    for (k, v) in extra.as_object().unwrap() {
        args[k] = v.clone();
    }
    e.core.rpc(Caller::Agent(Some(e.root.clone())), "", "spawn", &args)
}

/// Todo lo que un lanzamiento autorizado dejaría tras de sí. `solicitudes` = cuántos `spawn.requested` se esperan.
fn sin_efectos(e: &Env, antes: i64, solicitudes: usize) {
    assert!(e.core.list_pending_spawns().is_empty(), "no hay pendiente ni aprobación");
    assert!(e.hijas().is_empty(), "no se crea ninguna Task hija");
    assert!(e.core.terms.lock().unwrap().is_empty(), "no hay PTY ni proceso");
    assert_eq!(e.ramas(), "", "no hay rama ni worktree");
    assert!(!e.host.events().iter().any(|(name, _)| name == EV_PENDING || name == EV_RESOLVED), "no se emite tarjeta ni resolución a la interfaz");
    assert!(e.host.notifications().is_empty(), "no hay notificación");
    // Lo único registrado: la solicitud y, en su misma transacción, el `risk` que levanta (`attention.created`).
    let nuevos = desde(&e.core, antes);
    let esperados: Vec<&str> = (0..solicitudes).flat_map(|_| ["spawn.requested", "attention.created"]).collect();
    assert_eq!(kinds(&nuevos), esperados, "solo la solicitud y su Attention quedan registradas");
}

#[test]
fn una_denegacion_explicita_de_policy_deja_el_event_durable_y_se_deniega_sin_efectos() {
    let e = setup_con("spawn-blocked-persist", fake);
    e.core.settings.lock().unwrap().notify_questions = true;
    e.host.clear_events();
    let antes = head(&e.core);

    let denegacion = pide(&e, json!({ "profile": EXPLICITA })).expect_err("la policy deniega el lanzamiento");
    assert!(denegacion.contains("bloqueado"), "la respuesta es la denegación de siempre: {denegacion}");

    let nuevos = desde(&e.core, antes);
    assert_eq!(kinds(&nuevos), vec!["spawn.requested", "attention.created"], "el Event ya es durable cuando se devuelve la denegación, con su risk en la misma transacción");
    let request = &nuevos[0];
    let payload = pl(request);
    assert_eq!((payload["policy_status"].as_str(), payload["profile"].as_str()), (Some("blocked"), Some(EXPLICITA)));
    assert_eq!((request.entity_kind.as_str(), request.actor_kind.as_str(), request.channel.as_deref()), ("spawn_request", "agent", Some("lxo")));
    assert_eq!(request.actor_id.as_deref(), Some(e.root.as_str()));
    assert_eq!((request.correlation_id.as_deref(), request.idem_key.as_deref()), (Some(request.entity_id.as_str()), Some(request.entity_id.as_str())));
    assert_eq!((request.run_id.as_deref(), request.project_id.as_deref()), (Some(e.run.as_str()), Some(e.project.as_str())));
    for omitido in ["argv", "cwd", "env", "reason", "spec", "warnings"] {
        assert!(payload.get(omitido).is_none(), "el payload no lleva {omitido}");
    }
    sin_efectos(&e, antes, 1);
}

#[test]
fn un_bloqueo_del_entorno_se_rechaza_como_siempre_y_no_deja_event() {
    // CLI ausente / flags que la versión instalada no trae / sandbox elevado: la policy sale `blocked` pero no es una
    // decisión de policy sobre la solicitud. Sin Event no puede haber `risk`.
    let e = setup_con("spawn-blocked-env", bloqueada_por_entorno);
    let antes = head(&e.core);
    for perfil in ["explorar", "delegar_con_revision"] {
        let error = pide(&e, json!({ "profile": perfil })).expect_err("bloqueado");
        assert!(error.contains("CLI ausente en la prueba"), "{perfil}: se informa el bloqueo de siempre: {error}");
    }
    assert!(desde(&e.core, antes).is_empty(), "ninguna queda registrada");
    sin_efectos(&e, antes, 0);
}

#[test]
fn sin_persistencia_la_respuesta_es_el_fallo_de_persistencia_y_no_una_denegacion() {
    let e = setup_con("spawn-blocked-persist-fail", fake);
    let antes = head(&e.core);
    e.core.degrade_for_tests("fallo de persistencia preparado");

    let error = pide(&e, json!({ "profile": EXPLICITA })).expect_err("no puede tener éxito");
    assert!(error.contains("fallo de persistencia preparado"), "se informa el fallo real: {error}");
    assert!(!error.contains("bloqueado"), "no se devuelve una denegación como si estuviera registrada: {error}");
    assert!(desde(&e.core, antes).is_empty(), "no hay hecho parcial");
    sin_efectos(&e, antes, 0);
}

#[test]
fn una_entrada_invalida_es_un_error_y_no_se_registra_como_denegada_por_policy() {
    // El resolvedor lo bloquea TODO: si algún caso llegara a la policy, quedaría registrado o sería «bloqueado».
    let e = setup_con("spawn-invalid-input", bloqueada_por_entorno);
    let antes = head(&e.core);
    for (que, extra) in [
        ("agente desconocido", json!({ "agent": "inventado", "profile": EXPLICITA })),
        ("agente pausado", json!({ "agent": "opencode", "profile": EXPLICITA })),
        ("proveedor sin perfiles definidos", json!({ "agent": "gemini", "profile": EXPLICITA })),
        ("modelo con caracteres peligrosos", json!({ "model": "opus & del", "profile": EXPLICITA })),
        ("esfuerzo no admitido", json!({ "effort": "turbo", "profile": EXPLICITA })),
        ("perfil desconocido", json!({ "profile": "inventado" })),
        ("rol desconocido", json!({ "role": "inventado", "agent": "" , "profile": EXPLICITA })),
        ("rol con agente", json!({ "role": "explorador", "agent": "claude", "profile": EXPLICITA })),
        ("encargo vacío", json!({ "task": "", "profile": EXPLICITA })),
    ] {
        let error = pide(&e, extra).expect_err(que);
        assert!(!error.contains("CLI ausente en la prueba"), "{que}: es un error de entrada, no un bloqueo de policy: {error}");
        assert!(desde(&e.core, antes).is_empty(), "{que}: no deja Event");
    }
    sin_efectos(&e, antes, 0);
}

#[test]
fn check_request_conserva_la_validacion_de_entrada_que_hacia_launch() {
    use agents::{check_request, Profile};
    assert!(check_request("claude", Some("opus"), Some("high"), Profile::DelegarConRevision, None).is_ok());
    for (que, r) in [
        ("agente desconocido", check_request("inventado", None, None, Profile::Explorar, None)),
        ("agente pausado", check_request("opencode", None, None, Profile::Explorar, None)),
        ("modelo inseguro", check_request("claude", Some("opus & del"), None, Profile::Explorar, None)),
        ("esfuerzo no admitido", check_request("claude", None, Some("turbo"), Profile::Explorar, None)),
        ("rol desconocido", check_request("claude", None, None, Profile::Explorar, Some("inventado"))),
        ("proveedor sin perfiles", check_request("gemini", None, None, Profile::Explorar, None)),
    ] {
        assert!(r.is_err(), "{que} es entrada inválida");
    }
    // El perfil deshabilitado es una solicitud VÁLIDA: lo deniega la policy, no la validación.
    assert!(check_request("claude", None, None, Profile::AutonomiaAmplia, None).is_ok());
}

#[test]
fn solo_el_perfil_deshabilitado_es_una_denegacion_explicita_y_se_decide_por_tipos() {
    use agents::{explicit_denial, PolicyDenial, Profile};
    for provider in ["claude", "codex", agents::LIXBON_CLI] {
        assert_eq!(explicit_denial(provider, Profile::AutonomiaAmplia), Some(PolicyDenial::ProfileDisabled), "{provider}");
        for perfil in [Profile::Explorar, Profile::Proponer, Profile::DelegarConRevision] {
            assert_eq!(explicit_denial(provider, perfil), None, "{provider} {perfil:?} no está deshabilitado");
        }
    }
    // Sin definición para el proveedor no hay solicitud válida que denegar.
    assert_eq!(explicit_denial("gemini", Profile::AutonomiaAmplia), None);
    assert_eq!(explicit_denial("inventado", Profile::AutonomiaAmplia), None);
}

#[test]
fn ok_y_unverified_siguen_el_camino_de_aprobacion_y_no_son_denegaciones() {
    let casos: [(&str, Resolver, &str); 2] = [("spawn-ok", verificada, "ok"), ("spawn-unverified", fake, "unverified")];
    for (nombre, resolver, estado) in casos {
        let e = setup_con(nombre, resolver);
        let antes = head(&e.core);
        let respuesta = pide(&e, json!({})).expect("la solicitud queda pendiente");
        assert_eq!((respuesta["status"].as_str(), respuesta["policy_status"].as_str()), (Some("pending"), Some(estado)));
        let nuevos = desde(&e.core, antes);
        assert_eq!(kinds(&nuevos), vec!["spawn.requested", "attention.created"], "la aprobación pendiente levanta un approval, no un risk");
        assert_eq!(pl(&nuevos[0])["policy_status"], estado);
        assert_eq!(pl(&nuevos[1])["category"], "approval");
        assert_eq!(e.core.list_pending_spawns().len(), 1, "queda el pendiente para la aprobación humana");
    }
}

#[test]
fn cada_denegacion_explicita_es_un_intento_nuevo_con_su_propia_identidad() {
    let e = setup_con("spawn-blocked-retry", fake);
    let antes = head(&e.core);
    pide(&e, json!({ "profile": EXPLICITA })).expect_err("1");
    pide(&e, json!({ "profile": EXPLICITA })).expect_err("2");
    let nuevos = desde(&e.core, antes);
    assert_eq!(kinds(&nuevos), vec!["spawn.requested", "attention.created", "spawn.requested", "attention.created"]);
    let solicitudes: Vec<_> = nuevos.iter().filter(|ev| ev.kind == "spawn.requested").collect();
    assert_ne!(solicitudes[0].entity_id, solicitudes[1].entity_id, "un RPC nuevo es otro intento (otro pending_id)");
    sin_efectos(&e, antes, 2);
}

#[test]
fn una_denegacion_explicita_nunca_fue_pendiente() {
    let e = setup_con("spawn-blocked-not-pending", fake);
    let antes = head(&e.core);
    pide(&e, json!({ "profile": EXPLICITA })).expect_err("denegada");
    let pending_id = desde(&e.core, antes)[0].entity_id.clone();
    let estado = e.core.rpc(Caller::Agent(Some(e.root.clone())), "", "spawn_status", &json!({ "pending_id": pending_id })).unwrap();
    assert_eq!(estado["status"], "expired", "para el agente no existe pendiente");
    assert!(e.core.approve_spawn(&pending_id, true, &[], true).is_ok_and(|v| v["outcome"] == "expired"), "no hay nada que aprobar");
    assert_eq!(kinds(&desde(&e.core, antes)), vec!["spawn.requested", "attention.created"], "no hay `spawn.resolved` de una solicitud que nunca fue pendiente");
    sin_efectos(&e, antes, 1);
}
