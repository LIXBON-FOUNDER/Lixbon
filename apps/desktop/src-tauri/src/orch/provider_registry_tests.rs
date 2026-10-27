//! LXO-135 · registro vivo de adapters y query `provider_capabilities`: la lectura no espera a una CLI, solo hay un sondeo a la
//! vez, `generation` sube solo si algo cambió, un refresco forzado tiene un tope y la query es de una persona y de solo lectura.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::adapter::fake::FakeAdapter;
use super::adapter::{
    AdapterError, CancelToken, Capability, CapabilityMatrix, CapabilityState, EventSink, ProbeResult, ProviderAdapter, RunHandle, RunOutcome, StartRequest,
};
use super::agents::EnvBlock;
use super::attention_read_tests::{agente, core_listo, persona, rpc};
use super::provider_registry::LiveRegistry;
use super::rpc::rpc_action_for_tests;
use crate::store::ClientAction;

/// Un plazo de frescura tan largo que ninguna prueba lo agota: solo sondea el primero o el forzado.
const LARGO: Duration = Duration::from_secs(3600);

fn vivo(adapters: Vec<Arc<FakeAdapter>>, fresh: Duration) -> Arc<LiveRegistry> {
    LiveRegistry::with_builder(Box::new(move || adapters.iter().map(|a| a.clone() as Arc<dyn ProviderAdapter>).collect()), fresh)
}

fn sondeos(a: &FakeAdapter) -> usize {
    a.calls().iter().filter(|c| c.as_str() == "probe").count()
}

fn estado_de<'a>(snap: &'a Value, id: &str, cap: &str) -> &'a str {
    snap["providers"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap()["matrix"]["capabilities"][cap]["state"].as_str().unwrap()
}

/// Un adapter cuya sonda no termina hasta que se le deja: lo que hace una CLI colgada.
struct Colgado {
    abierta: Arc<(Mutex<bool>, std::sync::Condvar)>,
    sondeando: Arc<AtomicBool>,
}

impl ProviderAdapter for Colgado {
    fn id(&self) -> &str {
        "colgado"
    }
    fn probe(&self) -> ProbeResult {
        self.sondeando.store(true, Ordering::SeqCst);
        let (m, cv) = &*self.abierta;
        let mut abierta = m.lock().unwrap();
        while !*abierta {
            abierta = cv.wait(abierta).unwrap();
        }
        ProbeResult::ready(None, CapabilityMatrix::all_available())
    }
    fn start(&self, _: StartRequest, _: &CancelToken) -> Result<RunHandle, AdapterError> {
        Err(AdapterError::unsupported(Capability::Start))
    }
    fn events(&self, _: &RunHandle, _: &CancelToken, _: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        Err(AdapterError::unsupported(Capability::Events))
    }
}

#[test]
fn la_primera_lectura_no_espera_a_una_cli_y_dice_que_esta_sondeando() {
    let abierta = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let sondeando = Arc::new(AtomicBool::new(false));
    let adapter: Arc<dyn ProviderAdapter> = Arc::new(Colgado { abierta: abierta.clone(), sondeando: sondeando.clone() });
    let reg = LiveRegistry::with_builder(Box::new(move || vec![adapter.clone()]), LARGO);

    // La CLI está colgada y la lectura vuelve igualmente: sin proveedores, `probing`, `refreshing`.
    let t = std::time::Instant::now();
    let snap = LiveRegistry::snapshot(&reg, false);
    assert!(t.elapsed() < Duration::from_secs(2), "la lectura esperó a la CLI: {:?}", t.elapsed());
    assert_eq!((snap["status"].as_str(), snap["refreshing"].as_bool(), snap["providers"].as_array().map(Vec::len)), (Some("probing"), Some(true), Some(0)));
    assert_eq!(snap["checked_at_ms"], Value::Null, "todavía no se sabe nada: no hay hora");

    // Otra lectura mientras tanto: sigue igual y NO lanza un segundo sondeo.
    let otra = LiveRegistry::snapshot(&reg, true);
    assert_eq!(otra["status"], "probing");

    // La CLI contesta: ya hay proveedor y hora.
    let (m, cv) = &*abierta;
    *m.lock().unwrap() = true;
    cv.notify_all();
    reg.wait_idle();
    let listo = LiveRegistry::snapshot(&reg, false);
    assert_eq!((listo["status"].as_str(), listo["refreshing"].as_bool()), (Some("ready"), Some(false)));
    assert_eq!(listo["providers"][0]["id"], "colgado");
    assert!(listo["checked_at_ms"].as_i64().unwrap() > 0);
    assert!(sondeando.load(Ordering::SeqCst));
}

#[test]
fn la_lectura_trae_la_matriz_de_cada_proveedor_con_sus_cuatro_estados() {
    let completo = Arc::new(FakeAdapter::full("completo"));
    let parcial = Arc::new(FakeAdapter::with_probe(
        "parcial",
        ProbeResult::ready(Some("1.2.3"), CapabilityMatrix::all_available().with(Capability::Steer, CapabilityState::Unsupported).with(Capability::Interrupt, CapabilityState::unavailable("sin iniciar sesión"))),
    ));
    let bloqueado = Arc::new(FakeAdapter::with_probe("bloqueado", ProbeResult::blocked(None, vec![EnvBlock::CliMissing])));
    let reg = vivo(vec![completo, parcial, bloqueado], LARGO);
    LiveRegistry::snapshot(&reg, false);
    reg.wait_idle();
    let snap = LiveRegistry::snapshot(&reg, false);

    assert_eq!(snap["version"], 1);
    let ids: Vec<&str> = snap["providers"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["bloqueado", "completo", "parcial"], "ordenados por id: el orden no depende de cuándo contestó cada CLI");
    assert_eq!(estado_de(&snap, "completo", "resume"), "available");
    assert_eq!(estado_de(&snap, "parcial", "steer"), "unsupported");
    assert_eq!(estado_de(&snap, "parcial", "interrupt"), "unavailable");
    assert_eq!(estado_de(&snap, "bloqueado", "start"), "environment_blocked");
    // Cada matriz trae las seis capabilities, sin huecos.
    for p in snap["providers"].as_array().unwrap() {
        assert_eq!(p["matrix"]["capabilities"].as_object().unwrap().len(), 6, "{}", p["id"]);
    }
    assert_eq!(snap["providers"][2]["cli_version"], "1.2.3");
}

#[test]
fn generation_sube_solo_si_algo_cambio_y_el_refresco_forzado_tiene_tope() {
    let a = Arc::new(FakeAdapter::full("uno"));
    let reg = vivo(vec![a.clone()], LARGO);
    LiveRegistry::snapshot(&reg, false);
    reg.wait_idle();
    let g0 = LiveRegistry::snapshot(&reg, false)["generation"].as_u64().unwrap();
    assert_eq!(sondeos(&a), 1);

    // Fresco y sin forzar: no se vuelve a sondear.
    LiveRegistry::snapshot(&reg, false);
    reg.wait_idle();
    assert_eq!(sondeos(&a), 1);

    // Forzado, pero la CLI sigue igual: se sondea y `generation` NO sube.
    LiveRegistry::snapshot(&reg, true);
    reg.wait_idle();
    assert_eq!(sondeos(&a), 2);
    assert_eq!(LiveRegistry::snapshot(&reg, false)["generation"].as_u64().unwrap(), g0, "nada cambió");

    // Otro forzado enseguida: el tope lo ignora (no se martillea a las CLIs).
    LiveRegistry::snapshot(&reg, true);
    reg.wait_idle();
    assert_eq!(sondeos(&a), 2, "dentro del margen mínimo no se vuelve a sondear");
}

#[test]
fn un_cambio_en_el_proveedor_se_ve_en_la_siguiente_lectura_sin_reiniciar() {
    let a = Arc::new(FakeAdapter::full("uno"));
    // Plazo de frescura nulo: cada lectura puede lanzar un sondeo, como cuando pasa el minuto.
    let reg = vivo(vec![a.clone()], Duration::ZERO);
    LiveRegistry::snapshot(&reg, false);
    reg.wait_idle();
    let antes = LiveRegistry::snapshot(&reg, false);
    reg.wait_idle();
    assert_eq!(estado_de(&antes, "uno", "resume"), "available");

    // La CLI se desinstala: la matriz cambia sola en la lectura siguiente.
    a.set_probe(ProbeResult::blocked(None, vec![EnvBlock::CliMissing]));
    LiveRegistry::snapshot(&reg, false);
    reg.wait_idle();
    let despues = LiveRegistry::snapshot(&reg, false);
    reg.wait_idle();
    assert_eq!(estado_de(&despues, "uno", "resume"), "environment_blocked");
    assert!(despues["generation"].as_u64().unwrap() > antes["generation"].as_u64().unwrap());
    assert_eq!(despues["providers"][0]["environment"]["state"], "blocked");
}

#[test]
fn un_adapter_repetido_o_con_id_invalido_no_tumba_a_los_demas() {
    let bueno = Arc::new(FakeAdapter::full("bueno"));
    let repetido = Arc::new(FakeAdapter::full("bueno"));
    let malo = Arc::new(FakeAdapter::full("Mayusculas"));
    let reg = vivo(vec![bueno, repetido, malo], LARGO);
    LiveRegistry::snapshot(&reg, false);
    reg.wait_idle();
    let snap = LiveRegistry::snapshot(&reg, false);
    assert_eq!(snap["status"], "ready");
    assert_eq!(snap["providers"].as_array().unwrap().len(), 1);
}

#[test]
fn la_query_es_de_una_persona_y_de_solo_lectura() {
    assert_eq!(rpc_action_for_tests("provider_capabilities"), ClientAction::Read);
    let (_l, _data, _core_dir, core) = core_listo();
    let me = persona(&core, "person-caps", "install-person-caps", "person-caps-secret-0123456789abcdef");

    let r = rpc(&core, &me, "provider_capabilities", json!({})).unwrap();
    assert_eq!(r["version"], 1);
    assert!(r["status"] == "probing" || r["status"] == "ready", "estado inesperado de provider_capabilities");
    core.provider_registry.wait_idle();
    let r = rpc(&core, &me, "provider_capabilities", json!({})).unwrap();
    assert_eq!(r["status"], "ready");
    let ids: Vec<&str> = r["providers"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["claude", "codex"]);
    // Sin argumentos también vale.
    assert!(rpc(&core, &me, "provider_capabilities", Value::Null).is_ok());
    // No hay nada que escribir: ni rutas, ni credenciales, ni identificadores de cuenta en la respuesta.
    let texto = r.to_string();
    for prohibido in ["token", "secret", "api_key", "path", "C:\\"] {
        assert!(!texto.to_lowercase().contains(&prohibido.to_lowercase()), "la respuesta no debe llevar «{prohibido}»");
    }

    // Parámetros: solo `refresh` y booleano.
    let desconocido = rpc(&core, &me, "provider_capabilities", json!({ "x": 1 })).unwrap_err();
    assert!(desconocido.contains("provider_capabilities_invalid_request"), "{desconocido}");
    let mal = rpc(&core, &me, "provider_capabilities", json!({ "refresh": "si" })).unwrap_err();
    assert!(mal.contains("provider_capabilities_invalid_request"), "{mal}");
    assert!(rpc(&core, &me, "provider_capabilities", json!({ "refresh": true })).is_ok());

    // Un agente no la lee: es una pantalla de la persona.
    let ag = agente(&core, "t-agente", "install-agent-caps", "agent-caps-secret-0123456789abcdef");
    let e = rpc(&core, &ag, "provider_capabilities", json!({})).unwrap_err();
    assert!(e.contains("provider_capabilities_auth_required"), "{e}");
}

/// Validación manual con las CLI REALES instaladas (solo sondea: `--version`, `--help`, el preflight del sandbox; no gasta cuota):
/// `cargo test --lib orch::provider_registry_tests::real_ -- --ignored --exact --nocapture orch::provider_registry_tests::real_capabilities_con_las_cli_instaladas`.
#[test]
#[ignore = "requiere las CLI de Claude y Codex instaladas; ver docs/core/QUERIES.md"]
fn real_capabilities_con_las_cli_instaladas() {
    use super::adapter::{ClaudeAdapter, ClaudeConfig, CodexAdapter, CodexConfig};
    let reg = LiveRegistry::with_builder(
        Box::new(|| vec![Arc::new(ClaudeAdapter::new(ClaudeConfig::default())) as Arc<dyn ProviderAdapter>, Arc::new(CodexAdapter::new(CodexConfig::default()))]),
        LARGO,
    );
    let t = std::time::Instant::now();
    let primera = LiveRegistry::snapshot(&reg, false);
    assert!(t.elapsed() < Duration::from_secs(2), "la lectura no debe esperar a las CLI: {:?}", t.elapsed());
    assert_eq!(primera["status"], "probing");
    reg.wait_idle();
    let snap = LiveRegistry::snapshot(&reg, false);
    println!("sondeo real en {:?}\n{}", t.elapsed(), serde_json::to_string_pretty(&snap).unwrap());
    assert_eq!(snap["status"], "ready");
    let ids: Vec<&str> = snap["providers"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["claude", "codex"]);
    for p in snap["providers"].as_array().unwrap() {
        assert_eq!(p["matrix"]["capabilities"].as_object().unwrap().len(), 6);
    }
}
