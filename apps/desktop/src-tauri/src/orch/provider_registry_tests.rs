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

/// LXO-137 · `lxo provider list` y `lxo provider status` con el binario real, como persona, contra el HTTP de un Core con el registro de
/// las pruebas (adapters simulados `claude` y `codex`: no lanza ninguna CLI real ni toca ninguna cuenta): lo que enseña lxo es, proveedor por
/// proveedor y capability por capability, lo que dice el Core; los códigos de salida de `status` salen del estado de lo que se mira
/// (listo/disponible 0, bloqueado por el entorno 8, unavailable 7, unsupported 9); y el agente, el proveedor inexistente, el uso inválido y el
/// Core cerrado dan sus códigos. Los estados bloqueado/unavailable los cubren las pruebas unitarias de lxo con la fixture. Requiere `LXO_BIN`;
/// usa el almacén seguro real.
#[test]
#[ignore = "requiere un binario lxo real (LXO_BIN) y el almacén seguro del sistema; ver apps/desktop/README.md"]
fn lxo_bin_e2e_provider_person_real_store() {
    use super::projects_overview_tests::RealStoreServer;
    let (cleanup, data, _core_dir, core) = core_listo();
    let server = RealStoreServer::start(&core, &data, &cleanup.0);
    let me = persona(&core, "ana", "install-lxo-provider-e2e", "ana-lxo-provider-e2e-secret-0123456789");
    let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    const CAPS: [&str; 6] = ["start", "events", "answer", "interrupt", "steer", "resume"];

    // La query del Core nunca sondea: la primera lectura puede ser `probing` y lxo espera al primer sondeo por su cuenta.
    let lista = server.json(&["provider", "list", "--json"]);
    assert_eq!((lista["v"].as_u64(), lista["status"].as_str()), (Some(1), Some("ready")), "{lista}");
    let del_core = rpc(&core, &me, "provider_capabilities", json!({})).unwrap();
    let (de_lxo, de_core) = (lista["providers"].as_array().unwrap(), del_core["providers"].as_array().unwrap());
    assert!(!de_core.is_empty(), "el Core registra al menos un proveedor");
    assert_eq!(de_lxo.len(), de_core.len());

    for cp in de_core {
        let id = cp["id"].as_str().unwrap();
        let lp = de_lxo.iter().find(|p| p["id"] == id).unwrap_or_else(|| panic!("lxo no enseña {id}"));
        // Lo que enseña lxo es lo que dice el Core.
        assert_eq!(lp["cli_version"], cp["cli_version"], "{id}");
        assert_eq!(lp["environment"]["state"], cp["environment"]["state"], "{id}");
        let bloqueado = cp["environment"]["state"] == "blocked";
        for cap in CAPS {
            assert_eq!(lp["capabilities"][cap]["state"], cp["matrix"]["capabilities"][cap]["state"], "{id} {cap}");
        }
        // `status` sin capability mira el entorno: bloqueado ≠ fallido, con su propio código.
        let entorno = server.lxo(&["provider", "status", id, "--json"], None);
        assert_eq!(entorno.status.code(), Some(if bloqueado { 8 } else { 0 }), "{id}: {}", text(&entorno.stderr));
        let doc: Value = serde_json::from_slice(&entorno.stdout).unwrap();
        assert_eq!(doc["provider"]["id"], id);
        assert_eq!(doc["check"]["scope"], "environment");
        // Con capability, el código sale del estado de esa capability.
        for cap in CAPS {
            let quiere = match cp["matrix"]["capabilities"][cap]["state"].as_str().unwrap() {
                "unavailable" => 7,
                "environment_blocked" => 8,
                "unsupported" => 9,
                _ => 0,
            };
            let out = server.lxo(&["provider", "status", id, "--capability", cap, "--json"], None);
            assert_eq!(out.status.code(), Some(quiere), "{id} {cap}: {}", text(&out.stderr));
            assert_eq!(serde_json::from_slice::<Value>(&out.stdout).unwrap()["check"]["capability"], cap);
        }
        // En texto salen las seis y, si el entorno está bloqueado, se dice que no es un intento fallido.
        let humano = text(&server.lxo(&["provider", "status", id], None).stdout);
        for cap in CAPS {
            assert!(humano.contains(&format!("  {cap:<10} ")), "{id}: falta {cap}: {humano}");
        }
        assert_eq!(humano.contains("No es un intento fallido."), bloqueado, "{id}: {humano}");
    }
    let humano = text(&server.lxo(&["provider", "list"], None).stdout);
    assert!(humano.starts_with("Proveedores del Core · generación "), "{humano}");
    println!("{humano}");

    // `--refresh` pide un sondeo y espera a que termine: la respuesta sigue siendo la del Core.
    let refrescada = server.json(&["provider", "list", "--refresh", "--json"]);
    assert_eq!((refrescada["status"].as_str(), refrescada["providers"].as_array().map(Vec::len)), (Some("ready"), Some(de_core.len())));

    // Proveedor inexistente: 6 y los ids que hay. Uso inválido: 2.
    let falta = server.lxo(&["provider", "status", "no-existe", "--json"], None);
    assert_eq!(falta.status.code(), Some(6));
    let error: Value = serde_json::from_slice(&falta.stderr).unwrap();
    assert_eq!(error["code"], "not_found", "{error}");
    assert!(error["error"].as_str().unwrap().contains(de_core[0]["id"].as_str().unwrap()), "{error}");
    for args in [&["provider"][..], &["provider", "status"], &["provider", "status", "x", "--capability", "volar"], &["provider", "list", "--capability", "start"]] {
        assert_eq!(server.lxo(args, None).status.code(), Some(2), "{args:?}");
    }
    // Sin el modelo Task/Attempt cortado, `--attempt` no encuentra el intento y no inventa uno.
    let sin_intento = server.lxo(&["provider", "status", de_core[0]["id"].as_str().unwrap(), "--attempt", "t9-a9"], None);
    assert_ne!(sin_intento.status.code(), Some(0), "{}", text(&sin_intento.stdout));

    // Solo personas: un agente recibe 3. Y con el Core cerrado, 5.
    let token = "agent-lxo-provider-e2e-token-with-32-bytes-minimum";
    super::projects_overview_tests::registra_agente(&core, "t-agente", "install-agent-lxo-provider-e2e", token);
    let como_agente = server.lxo(&["provider", "list"], Some(("t-agente", token)));
    assert_eq!(como_agente.status.code(), Some(3), "{}", text(&como_agente.stderr));
    assert!(text(&como_agente.stderr).contains("solo para personas"), "{}", text(&como_agente.stderr));
    core.stop_server_with(&server.discovery);
    assert_eq!(server.lxo(&["provider", "list"], None).status.code(), Some(5), "Lixbon cerrado");
}
