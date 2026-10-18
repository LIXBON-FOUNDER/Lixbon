//! LXO-88 · camino real de `spawn` con la policy bloqueada.
//!
//! Solo una DENEGACIÓN EXPLÍCITA de policy (`agents::explicit_denial`: hoy, el perfil deshabilitado
//! `autonomia_amplia`) sobre una solicitud válida deja `spawn.requested` con `policy_status = blocked` durable ANTES
//! de que se devuelva la denegación, sin ningún efecto de lanzamiento. Todo lo demás sigue como antes y NO deja
//! Event: la entrada inválida (agente, modelo, esfuerzo, perfil, rol o combinación proveedor × perfil sin
//! definición) y el bloqueo del entorno/proveedor (CLI ausente, flags, sandbox). Si el Event no se puede persistir, el
//! error es el de la persistencia: nunca una denegación «registrada».

use std::cell::Cell;

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

thread_local! {
    /// Cuántas veces se resolvió la policy «de verdad» (en producción: sondear la CLI del proveedor) en este hilo.
    static RESOLUCIONES: Cell<usize> = const { Cell::new(0) };
}

/// Como `fake`, pero cuenta cada resolución: es el punto donde producción lanzaría `--version`/`--help` de la CLI.
fn cuenta_resoluciones(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> agents::Policy {
    RESOLUCIONES.with(|c| c.set(c.get() + 1));
    fake(provider, profile, role, worktree)
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
fn un_perfil_deshabilitado_en_una_ruta_inservible_es_un_bloqueo_del_entorno_y_no_deja_event_ni_risk() {
    // El entorno (ruta del worktree con caracteres que no se pueden pasar a la CLI) bloquea ANTES que el perfil: la causa
    // efectiva no es una decisión de policy, aunque el perfil esté además deshabilitado.
    for compartida in [true, false] {
        let e = setup_con("spawn&ruta-inservible", fake);
        let antes = head(&e.core);
        let error = pide(&e, json!({ "profile": EXPLICITA, "shared": compartida })).expect_err("bloqueado por el entorno");
        assert!(error.contains("bloqueado"), "se informa el bloqueo de siempre: {error}");
        assert!(desde(&e.core, antes).is_empty(), "compartida = {compartida}: ni spawn.requested ni attention.created");
        sin_efectos(&e, antes, 0);
        assert!(e.core.storage.with_store(|s| super::attention_rules_tests::categorias_activas(s)).unwrap().is_empty(), "no hay risk");
    }
    // Control: el mismo perfil en una ruta utilizable SÍ es una denegación explícita.
    let e = setup_con("spawn-ruta-buena", fake);
    let antes = head(&e.core);
    pide(&e, json!({ "profile": EXPLICITA })).expect_err("denegada");
    assert_eq!(kinds(&desde(&e.core, antes)), vec!["spawn.requested", "attention.created"]);
}

#[test]
fn la_denegacion_explicita_no_sondea_la_cli_del_proveedor_antes_de_denegar() {
    let e = setup_con("spawn-sin-sonda", cuenta_resoluciones);
    RESOLUCIONES.with(|c| c.set(0));
    let antes = head(&e.core);
    // Con modelo: producción también consultaría la lista de modelos de la CLI.
    pide(&e, json!({ "profile": EXPLICITA, "model": "opus" })).expect_err("denegada");
    assert_eq!(RESOLUCIONES.with(Cell::get), 0, "denegar de forma explícita no resuelve la policy (no hay subproceso de la CLI)");
    assert_eq!(kinds(&desde(&e.core, antes)), vec!["spawn.requested", "attention.created"], "y el Event sigue siendo durable antes de la denegación");

    // Sanidad del contador: un bloqueo del entorno y una solicitud normal SÍ resuelven la policy.
    pide(&e, json!({ "profile": "explorar" })).expect("pendiente");
    assert_eq!(RESOLUCIONES.with(Cell::get), 1);
    // Un perfil deshabilitado en una ruta inservible no es denegación explícita: se resuelve como el resto del entorno.
    let e2 = setup_con("spawn&sin-sonda", cuenta_resoluciones);
    RESOLUCIONES.with(|c| c.set(0));
    pide(&e2, json!({ "profile": EXPLICITA })).expect_err("entorno");
    assert_eq!(RESOLUCIONES.with(Cell::get), 1);
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
        assert_eq!(explicit_denial(provider, Profile::AutonomiaAmplia, "wt"), Some(PolicyDenial::ProfileDisabled), "{provider}");
        for perfil in [Profile::Explorar, Profile::Proponer, Profile::DelegarConRevision] {
            assert_eq!(explicit_denial(provider, perfil, "wt"), None, "{provider} {perfil:?} no está deshabilitado");
        }
        // El entorno bloquea antes que el perfil: con una ruta que no se puede pasar a la CLI no hay denegación explícita.
        for ruta in ["w&t", "w%t", "w\"t", "w^t", "w|t", "w<t", "w>t", "w
t"] {
            assert_eq!(explicit_denial(provider, Profile::AutonomiaAmplia, ruta), None, "{provider} {ruta:?}");
        }
    }
    // Sin definición para el proveedor no hay solicitud válida que denegar.
    assert_eq!(explicit_denial("gemini", Profile::AutonomiaAmplia, "wt"), None);
    assert_eq!(explicit_denial("inventado", Profile::AutonomiaAmplia, "wt"), None);
}

#[test]
fn explicit_denial_respeta_la_precedencia_de_evaluate_sin_leer_el_motivo() {
    // `explicit_denial` solo dice Some cuando `evaluate` bloquea por el PERFIL (con argv ya armado) y nunca cuando bloquea
    // antes por proveedor, ruta o combinación (que devuelven argv vacío). No se lee `reason`.
    use agents::{evaluate, explicit_denial, Detected, Profile};
    for provider in ["claude", "codex", "gemini", agents::LIXBON_CLI, "inventado"] {
        for perfil in Profile::ALL {
            for ruta in ["wt", "", "w&t", "w%t"] {
                let politica = evaluate(provider, perfil, ruta, Detected::Skip, false);
                if explicit_denial(provider, perfil, ruta).is_some() {
                    assert_eq!(politica.status, agents::Status::Blocked, "{provider} {perfil:?} {ruta:?}");
                    assert!(!politica.argv.is_empty(), "{provider} {perfil:?} {ruta:?}: bloqueó por el perfil, no antes");
                }
            }
        }
    }
}

#[test]
fn denial_policy_es_estatica_y_coincide_con_la_resolucion_sin_cli() {
    use agents::{denial_policy, evaluate_for, Delivery, Detected, Profile};
    let p = denial_policy("claude", Profile::AutonomiaAmplia, Some("implementador"), "wt", Some("opus"));
    assert_eq!(p.status, agents::Status::Blocked);
    let mut esperada = evaluate_for("claude", Profile::AutonomiaAmplia, Some("implementador"), "wt", Detected::Skip, false, Delivery::FileOrMarkers);
    agents::set_model(&mut esperada, Some("opus"));
    assert_eq!(p, esperada);
}

/// Un Core en modo legacy (`state.json`, sin Event Log) con una tarea anterior a los Projects (sin `project_id`).
fn core_legacy_sin_event_log() -> (super::boot_tests::Limpia, std::sync::Arc<super::Core>, String) {
    let (limpia, _data, _core_dir) = super::boot_tests::dirs();
    let mut orch = super::Orch::default();
    std::sync::Arc::get_mut(&mut orch.0).unwrap().resolver = fake;
    let core = orch.0;
    core.settings.lock().unwrap().enabled = true;
    let tarea = super::boot_tests::nueva_tarea(&core, "legacy");
    assert_eq!(core.lock().tasks.get(&tarea).unwrap().project_id, None, "tarea anterior a Projects");
    (limpia, core, tarea)
}

#[test]
fn sin_event_log_una_denegacion_explicita_no_se_devuelve_como_registrada() {
    // En `state.json` `record_facts` devuelve éxito sin guardar nada: devolver la denegación sería afirmar un Event que no existe.
    let (_l, core, tarea) = core_legacy_sin_event_log();
    assert!(!core.event_log_available(), "el modo legacy no tiene Event Log");
    let args = json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true, "profile": EXPLICITA });
    let error = core.rpc(Caller::Agent(Some(tarea.clone())), "", "spawn", &args).expect_err("no se lanza");
    assert!(error.contains("no tiene Event Log") && error.contains("No se pudo dejar constancia"), "se informa que no quedó registrada: {error}");
    assert!(error.contains("bloqueado"), "y se conserva el motivo para quien lo lee: {error}");
    assert!(!error.starts_with("Perfil"), "no es la denegación a secas: {error}");
    // Ningún efecto: ni pendiente, ni hija, ni terminal, ni aviso a la interfaz.
    assert!(core.list_pending_spawns().is_empty());
    assert_eq!(core.lock().tasks.len(), 1, "solo la tarea original");
    assert!(core.terms.lock().unwrap().is_empty());
}

#[test]
fn sin_event_log_un_bloqueo_del_entorno_o_una_entrada_invalida_siguen_como_siempre() {
    let (_l, core, tarea) = core_legacy_sin_event_log();
    let pide = |extra: Value| {
        let mut args = json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true });
        for (k, v) in extra.as_object().unwrap() {
            args[k] = v.clone();
        }
        core.rpc(Caller::Agent(Some(tarea.clone())), "", "spawn", &args)
    };
    assert!(pide(json!({ "agent": "inventado" })).unwrap_err().contains("Agente desconocido"));
    // Sin denegación explícita el camino de aprobación no cambia: queda pendiente (como antes de LXO-88).
    assert_eq!(pide(json!({ "profile": "explorar" })).unwrap()["status"], "pending");
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
