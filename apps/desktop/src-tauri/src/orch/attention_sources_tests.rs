//! LXO-88 · las dos señales fuente EXPLÍCITAS de `review_ready` y `environment_blocked`, desde su productor real hasta
//! la Attention.
//!
//! * `task.review_requested` lo emite `Tx::done` en la entrega correcta de una hija con padre y rama propia.
//! * `environment.blocked` / `environment.cleared` los emite el host al comprobar la policy (`spawn_request` y
//!   `approve_spawn`) con una causa TIPADA (`Policy.block`), solo cuando el bloqueo vigente de un proveedor cambia.
//!
//! La proyección no infiere nada: sin estos Events no hay Attention de estas categorías.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::agents::{self, BlockCause, EnvBlock};
use super::attention_rules::EventRules;
use super::attention_rules_tests::{abre, aplica, categorias_activas, ciclo_de_vida, instantanea};
use super::events::{Channel, MutationContext};
use super::spawn_cleanup_tests::{desde, fake, head, kinds, pl, setup_con, Env};
use super::state::NewTask;
use super::{Caller, MAX_DEPTH};
use crate::store::{AttentionProjection, EventProjector, EventRow, NewEvent, Store, StoreError, StoreResult};

fn en_el_core<R>(e: &Env, f: impl FnOnce(&mut Store) -> R) -> R {
    e.core.storage.with_store(f).expect("almacén abierto")
}

fn activas(e: &Env) -> Vec<String> {
    en_el_core(e, |s| categorias_activas(s))
}

fn persona() -> MutationContext {
    MutationContext::person(Channel::Ui)
}

/// Una hija de la raíz, en marcha. `rama` = su rama propia (`None`: comparte la carpeta, como una hija `shared`).
fn hija(e: &Env, rama: Option<&str>) -> String {
    e.core
        .mutate(|tx| {
            let id = tx.add_child(
                &e.root,
                MAX_DEPTH,
                NewTask {
                    agent: "claude".into(), model: None, effort: None, role: None, title: "hija".into(), spec: "encargo".into(),
                    repo: e.repo.to_string_lossy().into_owned(), cwd: e.repo.to_string_lossy().into_owned(),
                    branch: rama.map(String::from), base: None, worktree: None, external: false,
                },
            )?;
            tx.mark_running(&id)?;
            Ok(id)
        })
        .unwrap()
}

fn entrega(e: &Env, id: &str, ok: bool) -> Vec<EventRow> {
    let antes = head(&e.core);
    e.core.mutate(|tx| tx.done(id, ok, "resumen", vec![], None).map(|_| ())).unwrap();
    desde(&e.core, antes)
}

fn decide(e: &Env, id: &str, kind: &str, detail: Value) -> Vec<EventRow> {
    let antes = head(&e.core);
    e.core.mutate_as(&persona(), |tx| tx.record_decision(id, kind, "human", &detail).map(|_| ())).unwrap();
    desde(&e.core, antes)
}

fn reabre(e: &Env, id: &str) -> Vec<EventRow> {
    let antes = head(&e.core);
    e.core.mutate(|tx| tx.reopen(id, "otra vuelta")).unwrap();
    desde(&e.core, antes)
}

// ---------------------------------------------------------------------------------------------
// review_ready · productor
// ---------------------------------------------------------------------------------------------

#[test]
fn una_entrega_correcta_con_padre_y_rama_emite_review_requested_y_levanta_review_ready() {
    let e = setup_con("src-review", fake);
    let h = hija(&e, Some("lx/r1/h-rama"));
    let evs = entrega(&e, &h, true);
    assert_eq!(kinds(&evs), vec!["task.status_changed", "task.review_requested", "attention.created"], "causal y en orden de seq");
    let (cambio, pedida) = (&evs[0], &evs[1]);
    assert_eq!(pl(cambio), json!({ "from": "running", "to": "done" }));
    assert_eq!((pedida.entity_kind.as_str(), pedida.entity_id.as_str(), pedida.class), ("task", h.as_str(), crate::store::EventClass::State));
    assert_eq!(pl(pedida), json!({ "branch": "lx/r1/h-rama" }), "solo la rama: ni informe, ni resumen, ni ficheros, ni rutas");
    assert_eq!((pedida.run_id.as_deref(), pedida.project_id.as_deref()), (Some(e.run.as_str()), Some(e.project.as_str())));
    assert_eq!((pedida.actor_kind.as_str(), pedida.channel.as_deref()), ("system", Some("core")), "la entrega por defecto la hace el Core");
    assert!(cambio.state_rev.is_some() && cambio.state_rev == pedida.state_rev, "misma mutación que la entrega");
    assert_eq!(activas(&e), vec!["review_ready"]);
    let fila = en_el_core(&e, |s| instantanea(s)).pop().unwrap();
    assert_eq!((fila[3].as_str(), fila[4].as_str(), fila[6].as_str(), fila[7].as_str()), ("review_ready", "medium", "task", h.as_str()));
    assert_eq!(fila[11], pedida.id, "source_event_id = el task.review_requested");
    assert_eq!(serde_json::from_str::<Value>(&fila[13]).unwrap()["branch"], "lx/r1/h-rama");
}

#[test]
fn sin_review_requested_no_hay_review_ready_aunque_haya_rama_y_la_tarea_este_done() {
    let e = setup_con("src-review-neg", fake);
    // Entrega fallida: no pide revisión (y sí pide atención como `failed`).
    let fallida = hija(&e, Some("lx/r1/fallida"));
    assert_eq!(kinds(&entrega(&e, &fallida, false)), vec!["task.status_changed", "attention.created"]);
    // Hija sin rama propia (comparte carpeta): no hay nada que integrar.
    let compartida = hija(&e, None);
    assert_eq!(kinds(&entrega(&e, &compartida, true)), vec!["task.status_changed"]);
    // La raíz no tiene padre: no es una hija a revisar.
    let antes = head(&e.core);
    e.core.mutate(|tx| tx.done(&e.root, true, "fin", vec![], None).map(|_| ())).unwrap();
    assert_eq!(kinds(&desde(&e.core, antes)), vec!["task.status_changed"]);
    assert_eq!(activas(&e), vec!["failed"], "ni la rama, ni el estado `done`, ni la ausencia de decisión levantan review_ready");
}

// ---------------------------------------------------------------------------------------------
// review_ready · resolución por señales durables
// ---------------------------------------------------------------------------------------------

#[test]
fn la_decision_de_revision_resuelve_review_ready_acepte_o_rechace() {
    for (decision, outcome) in [("accepted", "accepted"), ("rejected", "rejected")] {
        let e = setup_con("src-review-decision", fake);
        let h = hija(&e, Some("lx/r1/h"));
        entrega(&e, &h, true);
        let evs = decide(&e, &h, "review", json!({ "decision": decision, "head_commit": "abc123" }));
        assert_eq!(kinds(&evs), vec!["decision.recorded", "attention.resolved"], "{decision}");
        assert_eq!(pl(&evs[0])["outcome"], outcome);
        assert_eq!(pl(&evs[1]), json!({ "resolution": "acted", "source_event_id": evs[0].id }), "{decision}");
        assert!(activas(&e).is_empty(), "{decision}");
        // Repetir la decisión sobre lo ya resuelto no escribe nada más en Attention (idempotente).
        let evs = decide(&e, &h, "review", json!({ "decision": decision, "head_commit": "abc123" }));
        assert_eq!(kinds(&evs), vec!["decision.recorded"], "{decision}: resolver otra vez es no-op");
    }
}

#[test]
fn integrar_retirar_o_reabrir_cierran_la_espera_y_una_nueva_entrega_es_otra_ocurrencia() {
    let e = setup_con("src-review-fin", fake);
    let h = hija(&e, Some("lx/r1/h"));
    entrega(&e, &h, true);
    // Reabrir la tarea entregada deja la revisión superada.
    let evs = reabre(&e, &h);
    assert_eq!(kinds(&evs), vec!["task.status_changed", "attention.resolved"]);
    assert_eq!(pl(&evs[1])["resolution"], "condition_cleared");
    assert!(activas(&e).is_empty());
    // La nueva entrega pide otra revisión: ocurrencia 2 del mismo hecho.
    entrega(&e, &h, true);
    let creada = en_el_core(&e, |s| instantanea(s)).into_iter().filter(|f| f[3] == "review_ready").collect::<Vec<_>>();
    assert_eq!((creada.len(), creada.iter().filter(|f| f[5] == "active").count()), (2, 1));
    assert_eq!(creada.iter().map(|f| f[2].as_str()).collect::<Vec<_>>(), vec!["1", "2"]);
    // Integrarla (merge merged) la resuelve.
    let evs = decide(&e, &h, "merge", json!({ "outcome": "merged", "branch": "lx/r1/h", "squash": false }));
    assert_eq!(kinds(&evs), vec!["decision.recorded", "attention.resolved"]);
    assert_eq!(pl(&evs[1])["resolution"], "acted");
    assert!(activas(&e).is_empty());
}

#[test]
fn repetir_done_sin_transicion_no_reabre_review_ready_pero_reabrir_y_entregar_de_nuevo_si() {
    let e = setup_con("src-review-done-repetido", fake);
    let h = hija(&e, Some("lx/r1/h"));
    let pedidas = |e: &Env| desde(&e.core, 0).iter().filter(|ev| ev.kind == "task.review_requested").count();
    let ocurrencias = |e: &Env| en_el_core(e, |s| instantanea(s)).into_iter().filter(|f| f[3] == "review_ready").count();
    // Primera entrega correcta: review_ready ocurrencia 1.
    assert_eq!(kinds(&entrega(&e, &h, true)), vec!["task.status_changed", "task.review_requested", "attention.created"]);
    assert_eq!((pedidas(&e), ocurrencias(&e)), (1, 1));
    assert_eq!(activas(&e), vec!["review_ready"]);
    // La persona resuelve la revisión.
    assert_eq!(kinds(&decide(&e, &h, "review", json!({ "decision": "accepted", "head_commit": "abc123" }))), vec!["decision.recorded", "attention.resolved"]);
    assert!(activas(&e).is_empty());
    // Repetir el `done` con éxito NO es una transición (Done → Done): la guarda es `State::done` -> `ensure_open`, que rechaza
    // una Task final antes de que `Tx::done` llegue a emitir `task.review_requested`. Ni por el mutador ni por el RPC del agente.
    let antes = head(&e.core);
    let estado_antes = e.core.lock().tasks.get(&h).unwrap().summary.clone();
    let error = e.core.mutate(|tx| tx.done(&h, true, "otra vez", vec![], None).map(|_| ())).expect_err("la entrega repetida se rechaza");
    assert!(String::from(error).contains("ya terminó"));
    let error = e.core.rpc(Caller::Agent(Some(h.clone())), "", "done", &json!({ "summary": "reintento" })).expect_err("el reintento del RPC también");
    assert!(error.contains("ya terminó"), "{error}");
    assert_eq!(head(&e.core), antes, "ni Event ni Attention nueva: el reintento no deja rastro");
    assert_eq!(e.core.lock().tasks.get(&h).unwrap().summary, estado_antes, "ni siquiera pisa el resumen entregado");
    assert_eq!((pedidas(&e), ocurrencias(&e)), (1, 1), "sin nuevo task.review_requested ni nueva ocurrencia");
    assert!(activas(&e).is_empty(), "ni review_ready activa");
    // El caso legítimo se conserva: reabrir de verdad y entregar de nuevo pide otra revisión (ocurrencia 2).
    reabre(&e, &h);
    assert_eq!(kinds(&entrega(&e, &h, true)), vec!["task.status_changed", "task.review_requested", "attention.created"]);
    assert_eq!((pedidas(&e), ocurrencias(&e)), (2, 2));
    assert_eq!(activas(&e), vec!["review_ready"]);
}

#[test]
fn retirar_la_task_resuelve_su_review_ready() {
    let e = setup_con("src-review-removed", fake);
    let h = hija(&e, Some("lx/r1/h"));
    entrega(&e, &h, true);
    let antes = head(&e.core);
    // `task.removed` lo emite el cleanup de un lanzamiento fallido; aquí se ejercita su regla con el Event real del log.
    let fila = |seq: i64| EventRow {
        seq, id: format!("0192f0a0-0000-7000-8000-{seq:012}"), at: 9_999_999_999_999, v: 1, kind: "task.removed".into(), class: crate::store::EventClass::State,
        actor_kind: crate::store::ActorKind::System, actor_id: None, channel: Some("core".into()), client_id: None, project_id: None, run_id: Some(e.run.clone()),
        entity_kind: "task".into(), entity_id: h.clone(), correlation_id: None, idem_key: None, state_rev: None, payload: r#"{"cause":"launch_failed"}"#.into(),
    };
    let (_d, mut s) = abre();
    aplica(&mut s, 0, &desde(&e.core, 0));
    assert_eq!(categorias_activas(&s), vec!["review_ready"]);
    let r = aplica(&mut s, antes, &[fila(antes + 100)]);
    assert_eq!((r.resolved.len(), categorias_activas(&s).len()), (1, 0));
}

// ---------------------------------------------------------------------------------------------
// environment_blocked
// ---------------------------------------------------------------------------------------------

thread_local! {
    /// Qué resuelve el host (por perfil) en este hilo de prueba: un valor por defecto y excepciones por perfil.
    static MODOS: RefCell<(u8, Vec<(String, u8)>)> = const { RefCell::new((0, Vec::new())) };
}
const OK: u8 = 0;
const SIN_CLI: u8 = 1;
const SIN_FLAGS: u8 = 2;
const PERFIL: u8 = 3;
const INVALIDO: u8 = 4;
const RUTA: u8 = 5;
const SIN_VERIFICAR: u8 = 6;
const SANDBOX: u8 = 7;
/// Sondas REALES (`agents::evaluate_for` con `Detected::Found`): lo que la CLI instalada dejaría ver.
const VERSION_NO_FIJADA: u8 = 8;
const MODELO_NO_LISTADO: u8 = 9;
const SIN_AYUDA: u8 = 10;
const AYUDA_SIN_FLAGS: u8 = 11;

/// La policy que `evaluate_for` resolvería con una CLI hallada de esa `version` y, si `ayuda`, un `--help` que lista los flags
/// del perfil (`flags = false`: la ayuda existe pero no trae ninguno). Sin ayuda legible no hay evidencia de entorno.
fn con_sonda(provider: &str, profile: &str, role: Option<&str>, worktree: &str, version: &str, ayuda: bool, flags: bool) -> agents::Policy {
    let base = fake(provider, profile, role, worktree);
    let help = ayuda.then(|| if flags { base.argv[1..].join(" ") } else { "Usage: claude [options]".to_string() });
    let sonda = agents::Probe { version: Some(version.into()), help, exec_help: None, windows_sandbox: None };
    agents::evaluate_for(provider, agents::Profile::parse(profile).expect("perfil"), role, worktree, agents::Detected::Found(&sonda), false, agents::Delivery::FileOrMarkers)
}

/// La evidencia completa de entorno de una policy `ok` (versión fijada) en estas pruebas.
fn prueba_completa() -> agents::EnvProof {
    agents::EnvProof { cli_present: true, flags_supported: true, sandbox_not_elevated: true }
}

/// La policy que el host resolvería según el modo del perfil pedido.
fn segun_modo(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> agents::Policy {
    let mut p = fake(provider, profile, role, worktree);
    let modo = MODOS.with(|m| {
        let m = m.borrow();
        m.1.iter().find(|(perfil, _)| perfil == profile).map(|(_, modo)| *modo).unwrap_or(m.0)
    });
    let bloqueo = |p: &mut agents::Policy, causa: BlockCause| {
        p.status = agents::Status::Blocked;
        p.reason = Some("motivo irrelevante: nunca se lee".into());
        p.block = Some(causa);
    };
    match modo {
        SIN_CLI => bloqueo(&mut p, BlockCause::Environment(EnvBlock::CliMissing)),
        SIN_FLAGS => bloqueo(&mut p, BlockCause::Environment(EnvBlock::CliFlagsUnsupported)),
        SANDBOX => bloqueo(&mut p, BlockCause::Environment(EnvBlock::WindowsSandboxElevated)),
        PERFIL => bloqueo(&mut p, BlockCause::ProfileDisabled),
        INVALIDO => bloqueo(&mut p, BlockCause::Invalid),
        RUTA => bloqueo(&mut p, BlockCause::WorktreePath),
        SIN_VERIFICAR => p.status = agents::Status::Unverified,
        VERSION_NO_FIJADA => p = con_sonda(provider, profile, role, worktree, "9.9.9", true, true),
        MODELO_NO_LISTADO => {
            p = con_sonda(provider, profile, role, worktree, "2.1.296", true, true);
            agents::mark_model(&mut p, Some("modelo-no-listado"), Some(false));
        }
        SIN_AYUDA => p = con_sonda(provider, profile, role, worktree, "9.9.9", false, true),
        AYUDA_SIN_FLAGS => p = con_sonda(provider, profile, role, worktree, "9.9.9", true, false),
        _ => {
            p.status = agents::Status::Ok;
            p.env_proof = prueba_completa();
        }
    }
    p
}

/// Modo por defecto para todos los perfiles (borra las excepciones).
fn modo(m: u8) {
    MODOS.with(|c| *c.borrow_mut() = (m, Vec::new()));
}

/// Excepción para UN perfil.
fn modo_perfil(perfil: &str, m: u8) {
    MODOS.with(|c| c.borrow_mut().1.push((perfil.to_string(), m)));
}

fn pide_perfil(e: &Env, perfil: &str) -> Result<Value, String> {
    e.core.rpc(Caller::Agent(Some(e.root.clone())), "", "spawn", &json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true, "profile": perfil }))
}

fn pide(e: &Env) -> Result<Value, String> {
    pide_perfil(e, "explorar")
}

fn bloqueos(e: &Env) -> Vec<(String, EnvBlock)> {
    e.core.lock().env_blocks.iter().map(|(k, v)| (k.clone(), *v)).collect()
}

fn entorno_activo(e: &Env) -> Vec<(String, String)> {
    en_el_core(e, |s| instantanea(s)).into_iter().filter(|f| f[3] == "environment_blocked" && f[5] == "active").map(|f| (f[7].clone(), f[10].clone())).collect()
}

#[test]
fn un_bloqueo_tipado_del_entorno_levanta_environment_blocked_sin_ser_un_fallo_ni_un_riesgo() {
    let e = setup_con("src-env", segun_modo);
    modo(SIN_CLI);
    let antes = head(&e.core);
    let error = pide(&e).expect_err("el lanzamiento se rechaza como siempre");
    assert!(error.contains("bloqueado"), "{error}");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds(&evs), vec!["environment.blocked", "attention.created"], "ni spawn.requested ni task.status_changed");
    let (bloqueo, creada) = (&evs[0], &evs[1]);
    assert_eq!((bloqueo.entity_kind.as_str(), bloqueo.entity_id.as_str(), bloqueo.class), ("agent", "claude", crate::store::EventClass::State));
    assert_eq!(pl(bloqueo), json!({ "profile": "explorar", "code": "cli_missing" }));
    assert_eq!((bloqueo.actor_kind.as_str(), bloqueo.channel.as_deref()), ("system", Some("core")));
    assert_eq!((bloqueo.run_id.clone(), bloqueo.project_id.clone()), (None, None), "es del proveedor, no de un run");
    assert!(bloqueo.state_rev.is_some() && bloqueo.state_rev == creada.state_rev, "el Event fuente y el derivado comparten la misma revisión");
    assert_eq!((pl(creada)["category"].as_str(), pl(creada)["severity"].as_str()), (Some("environment_blocked"), Some("high")));
    assert_eq!(activas(&e), vec!["environment_blocked"], "y ni failed ni risk");
    assert_eq!(entorno_activo(&e), vec![("claude".to_string(), "cli_missing@explorar".to_string())], "destino = proveedor, subject = causa@perfil");
    assert_eq!(bloqueos(&e), vec![("claude/explorar".to_string(), EnvBlock::CliMissing)], "memoria durable y tipada en State");
    assert_eq!(e.core.lock().tasks.get(&e.root).unwrap().status, super::state::Status::Running, "ninguna Task cambió de estado");
    assert!(e.core.list_pending_spawns().is_empty() && e.hijas().is_empty());
}

#[test]
fn repetir_la_misma_comprobacion_no_emite_y_un_cambio_de_causa_son_dos_hechos() {
    let e = setup_con("src-env-cambio", segun_modo);
    modo(SIN_CLI);
    pide(&e).expect_err("1");
    let antes = head(&e.core);
    pide(&e).expect_err("misma causa");
    assert_eq!(head(&e.core), antes, "mismo bloqueo vigente: ni Event ni Attention nueva");
    modo(SIN_FLAGS);
    pide(&e).expect_err("otra causa");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds(&evs), vec!["environment.cleared", "environment.blocked", "attention.resolved", "attention.created"]);
    assert_eq!((pl(&evs[0])["code"].as_str(), pl(&evs[1])["code"].as_str()), (Some("cli_missing"), Some("cli_flags_unsupported")));
    assert_eq!(evs[0].state_rev, evs[1].state_rev, "misma mutación");
    assert_eq!(entorno_activo(&e), vec![("claude".to_string(), "cli_flags_unsupported@explorar".to_string())]);
    assert_eq!(bloqueos(&e), vec![("claude/explorar".to_string(), EnvBlock::CliFlagsUnsupported)]);
}

#[test]
fn solo_una_comprobacion_positiva_y_verificada_levanta_el_bloqueo() {
    let e = setup_con("src-env-clear", segun_modo);
    modo(SIN_CLI);
    pide(&e).expect_err("bloqueado");
    // Sin evidencia suficiente (no verificada) o con un bloqueo que no es del entorno: se CONSERVA.
    for (m, que) in [(SIN_VERIFICAR, "no verificada"), (PERFIL, "perfil deshabilitado"), (INVALIDO, "entrada inválida"), (RUTA, "ruta de la solicitud")] {
        modo(m);
        let antes = head(&e.core);
        let _ = pide(&e);
        let k = kinds(&desde(&e.core, antes)).into_iter().map(String::from).collect::<Vec<_>>();
        assert!(!k.iter().any(|x| x == "environment.cleared"), "{que}: {k:?}");
        assert_eq!(bloqueos(&e).len(), 1, "{que}: el bloqueo sigue en el estado");
        assert_eq!(entorno_activo(&e).len(), 1, "{que}: y la Attention sigue activa");
    }
    // Verificada (`ok`): se levanta, con su Event y la resolución derivada en el mismo commit.
    modo(OK);
    let antes = head(&e.core);
    let pendiente = pide(&e).expect("preflight correcto: queda pendiente");
    assert_eq!(pendiente["status"], "pending");
    let evs = desde(&e.core, antes);
    assert_eq!(kinds(&evs), vec!["environment.cleared", "attention.resolved", "spawn.requested", "attention.created"]);
    assert_eq!(pl(&evs[0]), json!({ "profile": "explorar", "code": "cli_missing" }));
    assert_eq!(pl(&evs[1]), json!({ "resolution": "condition_cleared", "source_event_id": evs[0].id }));
    assert!(evs[0].state_rev.is_some() && evs[0].state_rev == evs[1].state_rev, "el cleared y su resolución derivada comparten la revisión");
    assert!(bloqueos(&e).is_empty() && entorno_activo(&e).is_empty());
    // Otra comprobación correcta: nada que levantar, nada que emitir.
    let antes = head(&e.core);
    pide(&e).expect("otra solicitud");
    assert!(!kinds(&desde(&e.core, antes)).contains(&"environment.cleared"));
}

#[test]
fn el_alcance_es_proveedor_y_perfil_y_cli_missing_es_de_todo_el_proveedor() {
    let e = setup_con("src-env-alcance", segun_modo);
    // Un bloqueo por banderas del perfil `explorar`.
    modo(SIN_FLAGS);
    pide_perfil(&e, "explorar").expect_err("explorar");
    // Otro perfil del MISMO proveedor que sí funciona NO levanta el bloqueo de `explorar`.
    modo(SIN_FLAGS);
    modo_perfil("delegar_con_revision", OK);
    let antes = head(&e.core);
    pide_perfil(&e, "delegar_con_revision").expect("delegar funciona");
    assert!(!kinds(&desde(&e.core, antes)).contains(&"environment.cleared"), "otro perfil no es evidencia para éste");
    assert_eq!(entorno_activo(&e), vec![("claude".to_string(), "cli_flags_unsupported@explorar".to_string())]);
    // Un bloqueo del sandbox de OTRO proveedor/perfil convive: causas simultáneas en alcances distintos.
    modo(SANDBOX);
    modo_perfil("explorar", SIN_FLAGS);
    pide_perfil(&e, "proponer").expect_err("proponer");
    assert_eq!(bloqueos(&e).len(), 2, "dos alcances, dos bloqueos simultáneos");
    assert_eq!(entorno_activo(&e).len(), 2);
    // Verificar `explorar` levanta solo el suyo.
    modo(SANDBOX);
    modo_perfil("explorar", OK);
    pide_perfil(&e, "explorar").expect("explorar verificado");
    assert_eq!(bloqueos(&e), vec![("claude/proponer".to_string(), EnvBlock::WindowsSandboxElevated)]);
    // `cli_missing` es de TODO el proveedor: una comprobación verificada de cualquier perfil lo levanta para todos.
    modo(SIN_CLI);
    pide_perfil(&e, "explorar").expect_err("sin CLI");
    pide_perfil(&e, "delegar_con_revision").expect_err("sin CLI");
    assert_eq!(bloqueos(&e).iter().filter(|(_, c)| *c == EnvBlock::CliMissing).count(), 2);
    modo(OK);
    pide_perfil(&e, "explorar").expect("la CLI existe");
    let restantes = bloqueos(&e);
    assert!(restantes.iter().all(|(_, c)| *c != EnvBlock::CliMissing), "{restantes:?}");
    assert!(restantes.iter().any(|(k, c)| k == "claude/proponer" && *c == EnvBlock::WindowsSandboxElevated), "el sandbox de `proponer` no lo desmiente un preflight de otro perfil");
}

#[test]
fn otro_proveedor_no_se_ve_afectado() {
    let e = setup_con("src-env-proveedor", segun_modo);
    modo(SIN_CLI);
    pide(&e).expect_err("claude");
    e.core
        .mutate_as(&MutationContext::core(), |tx| {
            tx.environment_blocked("codex", "explorar", EnvBlock::CliFlagsUnsupported);
            Ok(())
        })
        .unwrap();
    assert_eq!(entorno_activo(&e).len(), 2);
    modo(OK);
    pide(&e).expect("claude verificado");
    assert_eq!(bloqueos(&e), vec![("codex/explorar".to_string(), EnvBlock::CliFlagsUnsupported)], "el de `codex` sigue");
}

#[test]
fn la_aprobacion_vuelve_a_comprobar_el_entorno_y_deja_constancia() {
    let e = setup_con("src-env-approve", segun_modo);
    modo(OK);
    let pid = pide(&e).unwrap()["pending_id"].as_str().unwrap().to_string();
    modo(SIN_CLI);
    let antes = head(&e.core);
    let error = e.core.approve_spawn(&pid, true, &[], true).expect_err("ahora el entorno lo impide");
    assert!(error.contains("bloqueado"), "{error}");
    assert_eq!(kinds(&desde(&e.core, antes)), vec!["environment.blocked", "attention.created"], "queda constancia y el pendiente sigue pendiente");
    assert_eq!(e.core.list_pending_spawns().len(), 1);
    modo(OK);
    let argv = e.core.list_pending_spawns()[0].policy.argv.clone();
    let antes = head(&e.core);
    e.core.approve_spawn(&pid, true, &argv, true).unwrap();
    let evs = desde(&e.core, antes);
    let k = kinds(&evs);
    assert_eq!(&k[..2], ["environment.cleared", "attention.resolved"], "la aprobación correcta levanta el bloqueo: {k:?}");
}

#[test]
fn el_recheck_final_antes_de_lanzar_tambien_deja_constancia_sin_convertirse_en_fallo_ni_riesgo() {
    use super::spawn::SpawnStep;
    let e = setup_con("src-env-launch", segun_modo);
    modo(OK);
    let pid = pide(&e).unwrap()["pending_id"].as_str().unwrap().to_string();
    let argv = e.core.list_pending_spawns()[0].policy.argv.clone();
    // Entre la aprobación y el lanzamiento el entorno cambia: la segunda evaluación (la de `launch`) lo encuentra bloqueado.
    e.hook(|_core, _id, step| {
        if step == SpawnStep::AfterApprovalClaim {
            modo(SIN_CLI);
        }
        Ok(())
    });
    let antes = head(&e.core);
    let resultado = e.core.approve_spawn(&pid, true, &argv, true).expect("la aprobación se resuelve como lanzamiento fallido");
    assert_eq!(resultado["outcome"], "launch_failed");
    let evs = desde(&e.core, antes);
    let k = kinds(&evs);
    assert!(k.contains(&"environment.blocked"), "el recheck de launch deja el source Event: {k:?}");
    assert_eq!(pl(evs.iter().find(|ev| ev.kind == "environment.blocked").unwrap()), json!({ "profile": "explorar", "code": "cli_missing" }));
    assert_eq!(bloqueos(&e), vec![("claude/explorar".to_string(), EnvBlock::CliMissing)]);
    assert_eq!(entorno_activo(&e).len(), 1);
    // No es un riesgo ni un fallo de la tarea: la solicitud se resolvió (`launch_failed`) y su approval se cerró.
    let activas_ahora = activas(&e);
    assert!(!activas_ahora.contains(&"risk".to_string()) && !activas_ahora.contains(&"failed".to_string()), "{activas_ahora:?}");
    assert!(e.hijas().is_empty(), "la hija del lanzamiento fallido se retiró");
}

#[test]
fn solo_la_causa_de_entorno_tipada_levanta_environment_blocked() {
    for (m, nombre) in [(PERFIL, "perfil deshabilitado"), (INVALIDO, "entrada inválida"), (RUTA, "ruta del worktree inservible"), (SIN_VERIFICAR, "no verificada")] {
        let e = setup_con("src-env-neg", segun_modo);
        modo(m);
        let antes = head(&e.core);
        let _ = pide(&e);
        let evs = desde(&e.core, antes);
        let k = kinds(&evs);
        assert!(!k.iter().any(|x| x.starts_with("environment.")), "{nombre}: {k:?}");
        assert!(e.core.lock().env_blocks.is_empty(), "{nombre}");
        assert!(!activas(&e).contains(&"environment_blocked".to_string()), "{nombre}");
    }
    let e = setup_con("src-env-ok", segun_modo);
    modo(OK);
    let antes = head(&e.core);
    pide(&e).unwrap();
    assert!(!kinds(&desde(&e.core, antes)).iter().any(|x| x.starts_with("environment.")), "ok sin bloqueo previo: nada");
}

#[test]
fn un_fallo_generico_de_una_tarea_no_es_environment_blocked() {
    let e = setup_con("src-env-failed", segun_modo);
    let h = hija(&e, Some("lx/r1/h"));
    let antes = head(&e.core);
    e.core.mutate_as(&MutationContext::core(), |tx| tx.fail_with(&h, "helper_unknown_error", "setup refresh had errors")).unwrap();
    assert_eq!(kinds(&desde(&e.core, antes)), vec!["task.status_changed", "attention.created"]);
    assert_eq!(activas(&e), vec!["failed"], "un error con ese texto SIN el Event tipado sigue siendo `failed`: no se reclasifica");
}

// ---------------------------------------------------------------------------------------------
// environment_blocked · la evidencia positiva es tipada y no depende de la versión ni del modelo
// ---------------------------------------------------------------------------------------------

fn cleared_de(evs: &[EventRow]) -> Vec<Value> {
    evs.iter().filter(|ev| ev.kind == "environment.cleared").map(pl).collect()
}

#[test]
fn la_sonda_real_separa_la_evidencia_de_entorno_del_estado_de_version_y_modelo() {
    let wt = "C:/wt";
    let fijada = con_sonda("claude", "explorar", None, wt, "2.1.296", true, true);
    let sin_fijar = con_sonda("claude", "explorar", None, wt, "9.9.9", true, true);
    let modelo = {
        let mut p = con_sonda("claude", "explorar", None, wt, "2.1.296", true, true);
        agents::mark_model(&mut p, Some("modelo-no-listado"), Some(false));
        p
    };
    let completa = agents::EnvProof { cli_present: true, flags_supported: true, sandbox_not_elevated: false };
    assert_eq!((fijada.status, fijada.env_proof), (agents::Status::Ok, completa));
    assert_eq!((sin_fijar.status, sin_fijar.env_proof), (agents::Status::Unverified, completa), "versión sin fijar: sus flags sí están en --help");
    assert_eq!((modelo.status, modelo.env_proof), (agents::Status::Unverified, completa), "mark_model degrada el status, no la evidencia");
    // Sin ayuda legible, `Skip` o ayuda sin los flags del perfil: nada demostrado.
    let sin_ayuda = con_sonda("claude", "explorar", None, wt, "9.9.9", false, true);
    assert_eq!((sin_ayuda.status, sin_ayuda.env_proof), (agents::Status::Unverified, agents::EnvProof::default()));
    let skip = fake("claude", "explorar", None, wt);
    assert_eq!((skip.status, skip.env_proof), (agents::Status::Unverified, agents::EnvProof::default()));
    let sin_flags = con_sonda("claude", "explorar", None, wt, "9.9.9", true, false);
    assert_eq!((sin_flags.status, sin_flags.block, sin_flags.env_proof), (agents::Status::Blocked, Some(BlockCause::Environment(EnvBlock::CliFlagsUnsupported)), agents::EnvProof::default()));
}

#[test]
fn una_cli_funcional_de_version_no_fijada_levanta_cli_missing() {
    let e = setup_con("src-env-version", segun_modo);
    modo(SIN_CLI);
    pide(&e).expect_err("bloqueado");
    assert_eq!(bloqueos(&e), vec![("claude/explorar".to_string(), EnvBlock::CliMissing)]);
    // Se instala una CLI que funciona, de una versión que Lixbon no tiene fijada: la policy es `unverified`.
    modo(VERSION_NO_FIJADA);
    let antes = head(&e.core);
    let pendiente = pide(&e).expect("unverified no bloquea: queda pendiente (pide ack al aprobar)");
    assert_eq!(pendiente["policy_status"], "unverified");
    assert_eq!(e.core.list_pending_spawns()[0].policy.status, agents::Status::Unverified);
    let evs = desde(&e.core, antes);
    assert_eq!(kinds(&evs), vec!["environment.cleared", "attention.resolved", "spawn.requested", "attention.created"]);
    assert_eq!(cleared_de(&evs), vec![json!({ "profile": "explorar", "code": "cli_missing" })]);
    assert_eq!(pl(&evs[1]), json!({ "resolution": "condition_cleared", "source_event_id": evs[0].id }));
    assert!(bloqueos(&e).is_empty() && entorno_activo(&e).is_empty());
}

#[test]
fn una_cli_que_no_trae_los_flags_del_perfil_conserva_y_con_los_flags_levanta_cli_flags_unsupported() {
    let e = setup_con("src-env-flags", segun_modo);
    modo(SIN_FLAGS);
    pide(&e).expect_err("bloqueado por flags");
    // Versión desconocida y `--help` sin los flags: el propio evaluate la bloquea de nuevo (misma causa: no hay evento).
    modo(AYUDA_SIN_FLAGS);
    let antes = head(&e.core);
    pide(&e).expect_err("sigue sin los flags");
    assert_eq!(head(&e.core), antes, "mismo bloqueo vigente: ni cleared ni blocked");
    assert_eq!(bloqueos(&e), vec![("claude/explorar".to_string(), EnvBlock::CliFlagsUnsupported)]);
    // La versión nueva sí los trae, aunque no esté fijada: se levanta ese bloqueo del perfil.
    modo(VERSION_NO_FIJADA);
    let antes = head(&e.core);
    pide(&e).expect("pendiente");
    assert_eq!(cleared_de(&desde(&e.core, antes)), vec![json!({ "profile": "explorar", "code": "cli_flags_unsupported" })]);
    assert!(bloqueos(&e).is_empty());
}

#[test]
fn sin_ayuda_legible_o_sin_comprobar_ningun_bloqueo_se_levanta() {
    let e = setup_con("src-env-ambiguo", segun_modo);
    modo(SIN_CLI);
    pide(&e).expect_err("bloqueado");
    // `Skip` y versión desconocida sin `--help` legible: se CONSERVA, aunque la CLI exista.
    for (m, que) in [(SIN_VERIFICAR, "Skip"), (SIN_AYUDA, "ayuda ilegible")] {
        modo(m);
        let antes = head(&e.core);
        let _ = pide(&e);
        let evs = desde(&e.core, antes);
        assert!(cleared_de(&evs).is_empty(), "{que}: {:?}", kinds(&evs));
        assert_eq!(bloqueos(&e), vec![("claude/explorar".to_string(), EnvBlock::CliMissing)], "{que}");
        assert_eq!(entorno_activo(&e).len(), 1, "{que}");
    }
    // Lo mismo con un bloqueo de sandbox: ni la versión ni los flags demuestran que ya no esté elevado.
    let e = setup_con("src-env-sandbox", segun_modo);
    modo(SANDBOX);
    pide(&e).expect_err("sandbox elevado");
    modo(VERSION_NO_FIJADA);
    let antes = head(&e.core);
    let _ = pide(&e);
    assert!(cleared_de(&desde(&e.core, antes)).is_empty(), "flags correctos no desmienten el sandbox elevado");
    assert_eq!(bloqueos(&e), vec![("claude/explorar".to_string(), EnvBlock::WindowsSandboxElevated)]);
    // Solo una lectura del sandbox NO elevado lo demuestra.
    let proof = agents::EnvProof { cli_present: true, flags_supported: true, sandbox_not_elevated: true };
    e.core.mutate_as(&MutationContext::core(), |tx| Ok(tx.environment_verified("claude", "explorar", proof))).unwrap();
    assert!(bloqueos(&e).is_empty());
}

#[test]
fn un_modelo_no_listado_no_impide_levantar_el_bloqueo_de_entorno() {
    let e = setup_con("src-env-modelo", segun_modo);
    modo(SIN_CLI);
    pide(&e).expect_err("bloqueado");
    modo(MODELO_NO_LISTADO);
    let antes = head(&e.core);
    let pendiente = pide(&e).expect("unverified por el modelo: pendiente");
    assert_eq!(pendiente["policy_status"], "unverified");
    assert_eq!(cleared_de(&desde(&e.core, antes)), vec![json!({ "profile": "explorar", "code": "cli_missing" })]);
    assert!(bloqueos(&e).is_empty() && entorno_activo(&e).is_empty());
}

#[test]
fn la_evidencia_levanta_solo_lo_que_demuestra() {
    let e = setup_con("src-env-demuestra", segun_modo);
    // Dos alcances: flags del perfil `explorar` y `cli_missing` de `proponer`.
    modo(SIN_FLAGS);
    pide_perfil(&e, "explorar").expect_err("explorar");
    modo(SIN_CLI);
    pide_perfil(&e, "proponer").expect_err("proponer");
    assert_eq!(bloqueos(&e).len(), 2);
    // Evidencia de CLI presente SIN flags demostrados: solo cae `cli_missing`; los flags de `explorar` se conservan.
    let solo_cli = agents::EnvProof { cli_present: true, flags_supported: false, sandbox_not_elevated: false };
    let levantado = e.core.mutate_as(&MutationContext::core(), |tx| Ok(tx.environment_verified("claude", "explorar", solo_cli))).unwrap();
    assert!(levantado);
    assert_eq!(bloqueos(&e), vec![("claude/explorar".to_string(), EnvBlock::CliFlagsUnsupported)], "los flags no están demostrados");
    // Sin ninguna evidencia no se levanta nada.
    let nada = e.core.mutate_as(&MutationContext::core(), |tx| Ok(tx.environment_verified("claude", "explorar", agents::EnvProof::default()))).unwrap();
    assert!(!nada);
    assert_eq!(bloqueos(&e).len(), 1);
}

#[test]
fn si_la_proyeccion_falla_el_clear_por_evidencia_positiva_tampoco_se_confirma() {
    let e = setup_con("src-env-clear-rollback", segun_modo);
    modo(SIN_CLI);
    pide(&e).expect_err("bloqueado");
    let (antes, foto, estado) = (head(&e.core), en_el_core(&e, |s| instantanea(s)), bloqueos(&e));
    en_el_core(&e, |s| s.set_event_projector(Arc::new(ProyectaYFalla)));
    modo(VERSION_NO_FIJADA);
    let error = pide(&e).expect_err("el clear no se confirma");
    assert!(error.contains("proyección rota a propósito"), "{error}");
    assert_eq!(bloqueos(&e), estado, "el bloqueo sigue en el estado");
    assert_eq!((head(&e.core), en_el_core(&e, |s| instantanea(s))), (antes, foto), "ni Event ni Attention");
}

#[test]
fn el_replay_de_un_clear_por_evidencia_positiva_con_version_no_fijada_es_el_estado_incremental() {
    let e = setup_con("src-env-clear-replay", segun_modo);
    modo(SIN_CLI);
    pide(&e).expect_err("1");
    modo(VERSION_NO_FIJADA);
    pide(&e).expect("pendiente");
    modo(SIN_FLAGS);
    pide_perfil(&e, "proponer").expect_err("2");
    modo(MODELO_NO_LISTADO);
    pide_perfil(&e, "proponer").expect("pendiente");
    let mantenido = en_el_core(&e, |s| instantanea(s));
    let log = desde(&e.core, 0);
    assert_eq!(log.iter().filter(|ev| ev.kind == "environment.cleared").count(), 2);
    let (_d, mut limpio) = abre();
    aplica(&mut limpio, 0, &log);
    assert_eq!(instantanea(&limpio), mantenido, "replay desde cero = lo que mantuvieron los writers");
    assert!(en_el_core(&e, |s| categorias_activas(s)).iter().all(|c| c != "environment_blocked"));
}

// ---------------------------------------------------------------------------------------------
// Sin Event Log, solo lectura y carreras
// ---------------------------------------------------------------------------------------------

#[test]
fn sin_event_log_no_se_marca_ningun_bloqueo_de_entorno() {
    // Un marcador en `State` sin su Event durable ocultaría la señal para siempre: sin Event Log no se marca nada.
    let (_l, _data, _core) = super::boot_tests::dirs();
    let mut orch = super::Orch::default();
    std::sync::Arc::get_mut(&mut orch.0).unwrap().resolver = segun_modo;
    let core = orch.0;
    core.settings.lock().unwrap().enabled = true;
    let tarea = super::boot_tests::nueva_tarea(&core, "legacy");
    assert!(!core.event_log_available());
    modo(SIN_CLI);
    let args = json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true, "profile": "explorar" });
    let error = core.rpc(Caller::Agent(Some(tarea)), "", "spawn", &args).expect_err("bloqueado como siempre");
    assert!(error.contains("bloqueado"), "{error}");
    assert!(core.lock().env_blocks.is_empty(), "ni marcador ni claim de Event");
}

#[test]
fn con_el_core_en_solo_lectura_no_se_muta_env_blocks() {
    let e = setup_con("src-env-ro", segun_modo);
    modo(SIN_CLI);
    e.core.degrade_for_tests("fallo de almacenamiento preparado");
    let antes = head(&e.core);
    let error = pide(&e).expect_err("solo lectura");
    assert!(error.contains("fallo de almacenamiento preparado"), "{error}");
    assert!(e.core.lock().env_blocks.is_empty(), "la mutación se rechaza antes de tocar el estado");
    assert_eq!(head(&e.core), antes);
}

/// Contadores de la prueba de carrera (solo la usa `una_observacion_vieja_no_se_aplica_despues_de_una_mas_nueva`).
static EN_RESOLVEDOR: AtomicUsize = AtomicUsize::new(0);
static LIBERA_A: AtomicBool = AtomicBool::new(false);
static A_DENTRO: AtomicBool = AtomicBool::new(false);

/// Resolvedor de la carrera: el hilo con nombre `"A"` queda detenido DENTRO del resolvedor (bloqueado por el entorno) hasta
/// que la prueba lo libere; cualquier otro hilo resuelve `ok` de inmediato.
fn resolvedor_de_carrera(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> agents::Policy {
    EN_RESOLVEDOR.fetch_add(1, Ordering::SeqCst);
    let mut p = fake(provider, profile, role, worktree);
    if std::thread::current().name() == Some("A") {
        A_DENTRO.store(true, Ordering::SeqCst);
        let limite = Instant::now() + Duration::from_secs(10);
        while !LIBERA_A.load(Ordering::SeqCst) && Instant::now() < limite {
            std::thread::yield_now();
        }
        p.status = agents::Status::Blocked;
        p.block = Some(BlockCause::Environment(EnvBlock::CliMissing));
        p.reason = Some("irrelevante".into());
    } else {
        p.status = agents::Status::Ok;
        p.env_proof = prueba_completa();
    }
    p
}

#[test]
fn una_observacion_vieja_no_se_aplica_despues_de_una_mas_nueva() {
    // A resuelve «bloqueado» (lenta) y B resuelve «ok» después: sin serialización B limpiaría y luego A dejaría un bloqueo
    // que ya no existe. Con `env_gate`, B ni siquiera entra al resolvedor hasta que A termina de observar.
    let e = setup_con("src-env-carrera", resolvedor_de_carrera);
    EN_RESOLVEDOR.store(0, Ordering::SeqCst);
    LIBERA_A.store(false, Ordering::SeqCst);
    A_DENTRO.store(false, Ordering::SeqCst);
    let (core, root) = (e.core.clone(), e.root.clone());
    let args = json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true, "profile": "explorar" });
    let hilo_a = {
        let (core, root, args) = (core.clone(), root.clone(), args.clone());
        std::thread::Builder::new().name("A".into()).spawn(move || core.rpc(Caller::Agent(Some(root)), "", "spawn", &args)).unwrap()
    };
    let limite = Instant::now() + Duration::from_secs(10);
    while !A_DENTRO.load(Ordering::SeqCst) {
        assert!(Instant::now() < limite, "A no llegó al resolvedor");
        std::thread::yield_now();
    }
    let hilo_b = {
        let (core, root, args) = (core.clone(), root.clone(), args.clone());
        std::thread::Builder::new().name("B".into()).spawn(move || core.rpc(Caller::Agent(Some(root)), "", "spawn", &args)).unwrap()
    };
    // Con A retenido DENTRO del resolvedor, B no puede haber entrado (ventana acotada; sin la compuerta entraría al instante).
    let ventana = Instant::now() + Duration::from_millis(400);
    while Instant::now() < ventana {
        assert_eq!(EN_RESOLVEDOR.load(Ordering::SeqCst), 1, "B entró al resolvedor mientras A observaba: falta serialización");
        std::thread::yield_now();
    }
    LIBERA_A.store(true, Ordering::SeqCst);
    let a = hilo_a.join().unwrap();
    let b = hilo_b.join().unwrap();
    assert!(a.is_err(), "A: bloqueado por el entorno");
    assert_eq!(b.expect("B: preflight correcto")["status"], "pending");
    // La última evidencia es la de B (`ok`): no queda ningún bloqueo, ni en el estado ni en la Attention.
    assert!(core.lock().env_blocks.is_empty(), "una observación vieja no pudo escribir después de la más nueva");
    assert!(en_el_core(&e, |s| categorias_activas(s)).iter().all(|c| c != "environment_blocked"));
    let log = desde(&e.core, 0);
    let orden: Vec<&str> = log.iter().map(|ev| ev.kind.as_str()).filter(|k| k.starts_with("environment.")).collect();
    assert_eq!(orden, vec!["environment.blocked", "environment.cleared"], "A observó primero, B después");
}

// ---------------------------------------------------------------------------------------------
// Replay, rollback, reinicio, estado durable
// ---------------------------------------------------------------------------------------------

#[test]
fn el_replay_desde_cero_de_estas_dos_categorias_es_el_estado_incremental() {
    let e = setup_con("src-replay", segun_modo);
    let h = hija(&e, Some("lx/r1/h"));
    entrega(&e, &h, true);
    modo(SIN_CLI);
    pide(&e).expect_err("1");
    decide(&e, &h, "review", json!({ "decision": "accepted", "head_commit": "abc" }));
    reabre(&e, &h);
    entrega(&e, &h, true);
    modo(SIN_FLAGS);
    pide(&e).expect_err("2");
    modo(OK);
    pide(&e).unwrap();
    decide(&e, &h, "merge", json!({ "outcome": "merged", "branch": "lx/r1/h", "squash": false }));

    let mantenido = en_el_core(&e, |s| instantanea(s));
    let log = desde(&e.core, 0);
    let (_d, mut limpio) = abre();
    aplica(&mut limpio, 0, &log);
    assert_eq!(instantanea(&limpio), mantenido, "replay desde cero = lo que mantuvieron los writers");
    assert_eq!(ciclo_de_vida(&limpio).len(), en_el_core(&e, |s| ciclo_de_vida(s)).len());
    en_el_core(&e, |s| {
        let r = aplica(s, 0, &log);
        assert!(r.created.is_empty() && r.updated.is_empty() && r.resolved.is_empty() && r.lifecycle_events == 0, "{r:?}");
    });
    assert_eq!(en_el_core(&e, |s| instantanea(s)), mantenido);
}

#[derive(Debug)]
struct ProyectaYFalla;

impl EventProjector for ProyectaYFalla {
    fn project(&self, tx: &rusqlite::Transaction<'_>, events: &[EventRow]) -> StoreResult<Vec<NewEvent>> {
        AttentionProjection::new(Arc::new(EventRules)).project(tx, events)?;
        Err(StoreError::InvalidEvent("proyección rota a propósito".into()))
    }
}

#[test]
fn si_la_proyeccion_falla_ni_la_entrega_ni_el_bloqueo_ni_su_clear_se_confirman() {
    let e = setup_con("src-rollback", segun_modo);
    let h = hija(&e, Some("lx/r1/h"));
    modo(SIN_CLI);
    pide(&e).expect_err("bloqueado");
    let (antes, foto, estado) = (head(&e.core), en_el_core(&e, |s| instantanea(s)), bloqueos(&e));
    en_el_core(&e, |s| s.set_event_projector(Arc::new(ProyectaYFalla)));

    let error = e.core.mutate(|tx| tx.done(&h, true, "resumen", vec![], None).map(|_| ())).expect_err("no se confirma");
    assert!(String::from(error).contains("proyección rota a propósito"));
    assert_eq!((head(&e.core), en_el_core(&e, |s| instantanea(s))), (antes, foto.clone()));
    assert_eq!(e.core.lock().tasks.get(&h).unwrap().status, super::state::Status::Running, "la tarea no quedó entregada");

    // El CLEAR de un bloqueo vigente también se deshace: sigue bloqueado en el estado y en la Attention.
    modo(OK);
    let error = pide(&e).expect_err("el clear no se confirma");
    assert!(error.contains("proyección rota a propósito"), "{error}");
    assert_eq!(bloqueos(&e), estado, "el bloqueo sigue en el estado");
    assert_eq!((head(&e.core), en_el_core(&e, |s| instantanea(s))), (antes, foto.clone()));

    // Y un bloqueo NUEVO tampoco se confirma.
    modo(SIN_FLAGS);
    modo_perfil("proponer", SIN_FLAGS);
    let error = pide_perfil(&e, "proponer").expect_err("el bloqueo nuevo no se confirma");
    assert!(error.contains("proyección rota a propósito"), "{error}");
    assert_eq!(bloqueos(&e), estado);
    assert_eq!((head(&e.core), en_el_core(&e, |s| instantanea(s))), (antes, foto));
}

#[test]
fn el_bloqueo_vigente_sobrevive_a_un_reinicio_y_se_levanta_despues() {
    // Reinicio REAL: se cierra el Core y se vuelve a abrir el mismo almacén SQLite (no basta con serializar el estado).
    let (_l, data, core_dir) = super::boot_tests::dirs();
    let host = super::host::RecordingHost::new();
    let arranca = |host: &Arc<super::host::RecordingHost>| {
        let mut orch = super::Orch::default();
        Arc::get_mut(&mut orch.0).unwrap().resolver = segun_modo;
        let core = orch.0;
        core.init_in(host.clone(), &data, &core_dir).unwrap();
        core.settings.lock().unwrap().enabled = true;
        core
    };
    let core1 = arranca(&host);
    let raiz = core1
        .mutate(|tx| {
            let (_run, root) = tx.create_run(
                "obj",
                NewTask {
                    agent: "coordinador".into(), model: None, effort: None, role: None, title: "obj".into(), spec: "obj".into(),
                    repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: true,
                },
            );
            tx.mark_running(&root)?;
            Ok(root)
        })
        .unwrap();
    let args = json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true, "profile": "explorar" });
    modo(SIN_CLI);
    core1.rpc(Caller::Agent(Some(raiz.clone())), "", "spawn", &args).expect_err("bloqueado");
    assert_eq!(core1.lock().env_blocks.len(), 1);
    let doc = core1.storage.with_store(|s| s.legacy_state().unwrap().unwrap().doc).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&doc).unwrap()["env_blocks"], json!({ "claude/explorar": "cli_missing" }));
    drop(core1);
    super::boot_tests::espera_lock_libre(&core_dir);

    let core2 = arranca(&host);
    assert_eq!(core2.lock().env_blocks.get("claude/explorar"), Some(&EnvBlock::CliMissing), "reabierto desde SQLite");
    let activas_tras = core2.storage.with_store(|s| categorias_activas(s)).unwrap();
    assert_eq!(activas_tras, vec!["environment_blocked"], "y la Attention también");
    // Tras el reinicio, una comprobación verificada puede emitir `cleared`: el Event existe aunque el proceso sea otro.
    modo(OK);
    let antes = core2.storage.with_store(|s| s.events_head().unwrap()).unwrap();
    core2.rpc(Caller::Agent(Some(raiz)), "", "spawn", &args).expect("preflight correcto");
    let nuevos = core2.storage.with_store(|s| s.events_page(&crate::store::EventQuery { after: Some(antes), limit: Some(50), ..Default::default() }).unwrap().events).unwrap();
    assert_eq!(nuevos.iter().map(|ev| ev.kind.as_str()).take(2).collect::<Vec<_>>(), vec!["environment.cleared", "attention.resolved"]);
    assert!(core2.lock().env_blocks.is_empty());
    assert!(core2.storage.with_store(|s| categorias_activas(s)).unwrap().iter().all(|c| c != "environment_blocked"));
}

// ---------------------------------------------------------------------------------------------
// Guardas de arquitectura de los productores
// ---------------------------------------------------------------------------------------------

/// Líneas de producción de un archivo (sin comentarios ni el módulo de pruebas).
fn produccion_de(nombre: &str) -> String {
    let ruta = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch").join(nombre);
    let texto = std::fs::read_to_string(ruta).unwrap();
    let antes_de_pruebas = texto.split("#[cfg(test)]\nmod tests").next().unwrap().to_string();
    antes_de_pruebas.lines().filter(|l| !l.trim_start().starts_with("//")).collect::<Vec<_>>().join("\n")
}

#[test]
fn toda_consulta_de_la_policy_real_pasa_por_resolve_and_observe() {
    // `launch` real no se ejecuta en pruebas (`fake_launch` lo sustituye y refleja su comprobación); esta guarda estática
    // fija que el recheck final de `launch` y los otros dos puntos usan el único camino que deja constancia del entorno.
    for archivo in ["spawn.rs", "spawn_approval.rs"] {
        let src = produccion_de(archivo);
        let directas: Vec<&str> = src.lines().filter(|l| l.contains("self.task_policy(") && !l.contains("fn task_policy")).collect();
        // En `spawn_approval.rs` solo `resolve_and_observe` llama a `task_policy`.
        let permitidas = usize::from(archivo == "spawn_approval.rs");
        assert_eq!(directas.len(), permitidas, "{archivo}: la policy real se consulta con resolve_and_observe: {directas:?}");
    }
    assert!(produccion_de("spawn.rs").contains("self.resolve_and_observe("), "el recheck de launch observa el entorno");
    assert!(produccion_de("spawn_approval.rs").matches("self.resolve_and_observe(").count() >= 3, "spawn_request, approve_spawn y fake_launch");
}
