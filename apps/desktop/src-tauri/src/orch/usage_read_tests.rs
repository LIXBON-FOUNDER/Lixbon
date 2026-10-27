//! LXO-206 · `usage_report`: la lectura no espera a una CLI, solo hay un vuelo a la vez, desconocido nunca es cero, un fallo de uso
//! deja el dato anterior como `stale` sin fallar nada más, ningún secreto ni identificador de cuenta sale en la respuesta, y la query
//! es de una persona y de solo lectura.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::adapter::fake::FakeAdapter;
use super::adapter::{
    AdapterError, CancelToken, CapabilityState, Credits, EventSink, ModelUsage, ProbeResult, Provenance, ProviderAdapter, RunHandle, RunOutcome, StartRequest, UsageConfig, UsageError,
    UsageField, UsageService, UsageSnapshot, UsageSupport, UsageTarget, UsageWindow,
};
use super::attention_read_tests::{agente, core_listo, persona, rpc};
use super::rpc::rpc_action_for_tests;
use super::usage_read::LiveUsage;
use crate::store::ClientAction;

const LARGO: Duration = Duration::from_secs(3600);
const T0: i64 = 1_800_000_000_000;

#[derive(Clone)]
enum Respuesta {
    Ok(Box<UsageSnapshot>),
    Err(UsageError),
}

/// Un proveedor con uso configurable. Si `puerta` está cerrada, `usage` espera: lo que hace una CLI colgada.
struct Uso {
    id: String,
    support: UsageSupport,
    respuesta: Mutex<Respuesta>,
    llamadas: AtomicUsize,
    puerta: Mutex<bool>,
    cv: std::sync::Condvar,
    espera: AtomicBool,
}

impl Uso {
    fn nuevo(id: &str, support: UsageSupport, r: Respuesta) -> Arc<Uso> {
        Arc::new(Uso { id: id.into(), support, respuesta: Mutex::new(r), llamadas: AtomicUsize::new(0), puerta: Mutex::new(true), cv: std::sync::Condvar::new(), espera: AtomicBool::new(false) })
    }

    fn cerrada(id: &str, support: UsageSupport, r: Respuesta) -> Arc<Uso> {
        let u = Uso::nuevo(id, support, r);
        *u.puerta.lock().unwrap() = false;
        u
    }

    fn abrir(&self) {
        *self.puerta.lock().unwrap() = true;
        self.cv.notify_all();
    }

    fn pon(&self, r: Respuesta) {
        *self.respuesta.lock().unwrap() = r;
    }

    fn llamadas(&self) -> usize {
        self.llamadas.load(Ordering::SeqCst)
    }
}

impl ProviderAdapter for Uso {
    fn id(&self) -> &str {
        &self.id
    }
    fn probe(&self) -> ProbeResult {
        FakeAdapter::full(&self.id).probe()
    }
    fn start(&self, _: StartRequest, _: &CancelToken) -> Result<RunHandle, AdapterError> {
        Err(AdapterError::provider("no se usa"))
    }
    fn events(&self, _: &RunHandle, _: &CancelToken, _: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        Err(AdapterError::provider("no se usa"))
    }
    fn usage_support(&self) -> UsageSupport {
        self.support.clone()
    }
    fn usage(&self, _: &CancelToken) -> Result<UsageSnapshot, UsageError> {
        self.llamadas.fetch_add(1, Ordering::SeqCst);
        self.espera.store(true, Ordering::SeqCst);
        let mut abierta = self.puerta.lock().unwrap();
        while !*abierta {
            abierta = self.cv.wait(abierta).unwrap();
        }
        match self.respuesta.lock().unwrap().clone() {
            Respuesta::Ok(s) => Ok(*s),
            Respuesta::Err(e) => Err(e),
        }
    }
}

fn todo() -> UsageSupport {
    UsageField::ALL.into_iter().fold(UsageSupport::none(), |s, f| s.with(f, CapabilityState::Available))
}

fn solo_ventanas() -> UsageSupport {
    UsageSupport::none().with(UsageField::Windows, CapabilityState::Available)
}

fn completo(at: i64) -> UsageSnapshot {
    let mut s = UsageSnapshot::new(at, Provenance::ProviderQuery);
    s.account_id = Some("cuenta-privada-ana@example.com".into());
    s.plan = Some("plus".into());
    s.windows = vec![UsageWindow { id: "primary".into(), minutes: Some(300), used_percent: Some(12.0), resets_at: Some(at / 1000 + 3600) }];
    s.models = vec![ModelUsage { model: "m1".into(), input_tokens: Some(10), output_tokens: Some(20), cache_read_tokens: None, cache_creation_tokens: None, cost_usd: Some(0.5) }];
    s.credits = Some(Credits { has_credits: Some(true), unlimited: Some(false), balance: Some("42".into()) });
    s
}

fn vivo(servicio: UsageService, targets: Vec<Arc<Uso>>) -> Arc<LiveUsage> {
    LiveUsage::with_targets(
        servicio,
        Box::new(move || Some(targets.iter().map(|u| UsageTarget { id: u.id.clone(), adapter: u.clone() as Arc<dyn ProviderAdapter>, environment_blocked: false }).collect())),
        LARGO,
    )
}

fn servicio() -> UsageService {
    UsageService::new(UsageConfig::default())
}

fn proveedor<'a>(v: &'a Value, id: &str) -> &'a Value {
    v["report"]["providers"].as_array().unwrap().iter().find(|p| p["provider"] == id).unwrap_or_else(|| panic!("falta {id}: {v}"))
}

// ── No espera ni martillea ──────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn la_primera_lectura_no_espera_a_una_cli_colgada_y_dice_que_esta_cargando() {
    let u = Uso::cerrada("codex", todo(), Respuesta::Ok(Box::new(completo(T0))));
    let live = vivo(servicio(), vec![u.clone()]);
    let t = std::time::Instant::now();
    let v = LiveUsage::snapshot(&live, false);
    assert!(t.elapsed() < Duration::from_secs(2), "la lectura esperó a la CLI: {:?}", t.elapsed());
    assert_eq!((v["status"].as_str(), v["refreshing"].as_bool(), &v["report"]), (Some("loading"), Some(true), &Value::Null));

    // Otra lectura mientras tanto: sigue igual y NO lanza una segunda consulta.
    LiveUsage::snapshot(&live, true);
    while !u.espera.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(u.llamadas(), 1, "un solo vuelo");

    u.abrir();
    live.wait_idle();
    let v = LiveUsage::snapshot(&live, false);
    assert_eq!((v["status"].as_str(), v["refreshing"].as_bool()), (Some("ready"), Some(false)));
    assert_eq!(proveedor(&v, "codex")["status"], "fresh");
    assert_eq!(v["report"]["version"], 1);
}

#[test]
fn con_el_informe_reciente_no_se_vuelve_a_consultar_y_un_refresco_manual_seguido_se_atiende_con_la_cache() {
    let u = Uso::nuevo("codex", todo(), Respuesta::Ok(Box::new(completo(T0))));
    let live = vivo(servicio(), vec![u.clone()]);
    LiveUsage::snapshot(&live, false);
    live.wait_idle();
    assert_eq!(u.llamadas(), 1);

    // Reciente y sin forzar: ni siquiera se lanza un hilo.
    LiveUsage::snapshot(&live, false);
    live.wait_idle();
    assert_eq!(u.llamadas(), 1);

    // Forzado inmediatamente: el servicio lo atiende con la caché (margen mínimo) y lo dice.
    LiveUsage::snapshot(&live, true);
    live.wait_idle();
    assert_eq!(u.llamadas(), 1, "el refresco manual dentro del margen no consulta al proveedor");
    let v = LiveUsage::snapshot(&live, false);
    assert_eq!(proveedor(&v, "codex")["throttled"], true);
}

#[test]
fn sin_proveedores_registrados_todavia_no_hay_informe_ni_se_inventa_uno() {
    let live = LiveUsage::with_targets(servicio(), Box::new(|| None), LARGO);
    LiveUsage::snapshot(&live, false);
    live.wait_idle();
    let v = LiveUsage::snapshot(&live, false);
    live.wait_idle();
    assert_eq!((v["status"].as_str(), &v["report"]), (Some("loading"), &Value::Null));
}

// ── Desconocido ≠ cero, stale, errores ──────────────────────────────────────────────────────────────────────────────────

#[test]
fn desconocido_no_es_cero_y_un_proveedor_parcial_no_rellena_lo_que_no_da() {
    let mut s = UsageSnapshot::new(T0, Provenance::RunObservation);
    s.windows = vec![UsageWindow { id: "five_hour".into(), minutes: None, used_percent: None, resets_at: None }];
    let u = Uso::nuevo("claude", solo_ventanas(), Respuesta::Ok(Box::new(s)));
    let live = vivo(servicio(), vec![u]);
    LiveUsage::snapshot(&live, false);
    live.wait_idle();
    let v = LiveUsage::snapshot(&live, false);
    let p = proveedor(&v, "claude");
    let w = &p["snapshot"]["windows"][0];
    assert_eq!(w["id"], "five_hour");
    for campo in ["used_percent", "minutes", "resets_at"] {
        assert!(w.get(campo).is_none(), "{campo} ausente = desconocido, no 0: {w}");
    }
    for campo in ["models", "credits", "plan", "account", "limit_reached"] {
        assert!(p["snapshot"].get(campo).is_none(), "{campo}: no se inventa lo que el proveedor no da");
    }
    assert_eq!(p["support"]["fields"]["tokens"]["state"], "unsupported");
    assert_eq!(p["snapshot"]["provenance"], "run_observation");
}

#[test]
fn un_proveedor_sin_uso_o_con_el_entorno_bloqueado_no_se_consulta_y_no_es_un_fallo() {
    let sin = Uso::nuevo("minimo", UsageSupport::none(), Respuesta::Ok(Box::new(completo(T0))));
    let bloqueado = Uso::nuevo("bloq", todo(), Respuesta::Ok(Box::new(completo(T0))));
    let (a, b) = (sin.clone(), bloqueado.clone());
    let live = LiveUsage::with_targets(
        servicio(),
        Box::new(move || {
            Some(vec![
                UsageTarget { id: "minimo".into(), adapter: a.clone() as Arc<dyn ProviderAdapter>, environment_blocked: false },
                UsageTarget { id: "bloq".into(), adapter: b.clone() as Arc<dyn ProviderAdapter>, environment_blocked: true },
            ])
        }),
        LARGO,
    );
    LiveUsage::snapshot(&live, false);
    live.wait_idle();
    let v = LiveUsage::snapshot(&live, false);
    assert_eq!(proveedor(&v, "minimo")["status"], "unsupported");
    assert_eq!(proveedor(&v, "bloq")["status"], "environment_blocked");
    assert_eq!((sin.llamadas(), bloqueado.llamadas()), (0, 0), "no se consulta a quien no informa o está bloqueado");
    assert!(proveedor(&v, "minimo").get("snapshot").is_none() && proveedor(&v, "bloq").get("error").is_none(), "ninguno es un error");
}

#[test]
fn un_fallo_deja_el_dato_anterior_como_stale_y_un_fallo_sin_dato_es_unknown_con_su_motivo() {
    let reloj = Arc::new(AtomicI64::new(T0));
    let r2 = reloj.clone();
    let cfg = UsageConfig { ttl_ms: 60_000, error_backoff_ms: 1_000, min_refresh_ms: 1_000, timeout: Duration::from_secs(5) };
    let u = Uso::nuevo("codex", todo(), Respuesta::Ok(Box::new(completo(T0))));
    let live = vivo(UsageService::with_clock(cfg, Arc::new(move || r2.load(Ordering::SeqCst))), vec![u.clone()]);
    LiveUsage::snapshot(&live, false);
    live.wait_idle();
    assert_eq!(proveedor(&LiveUsage::snapshot(&live, false), "codex")["status"], "fresh");

    // Pasa el TTL y el proveedor pide iniciar sesión: el dato anterior se conserva y pasa a stale, con su error.
    reloj.store(T0 + 120_000, Ordering::SeqCst);
    u.pon(Respuesta::Err(UsageError::auth_required()));
    live.consult(true);
    let v = LiveUsage::snapshot(&live, false);
    let p = proveedor(&v, "codex");
    assert_eq!(p["status"], "stale");
    assert_eq!(p["error"]["kind"], "auth_required");
    assert_eq!(p["snapshot"]["windows"][0]["used_percent"], 12.0, "el dato anterior no se borra ni se vuelve cero");
    assert_eq!(p["age_ms"], 120_000);

    // Sin ningún dato anterior, el fallo es `unknown` (NO cero) y lo dice.
    let nuevo = Uso::nuevo("otro", todo(), Respuesta::Err(UsageError::rate_limited()));
    let live2 = vivo(servicio(), vec![nuevo]);
    LiveUsage::snapshot(&live2, false);
    live2.wait_idle();
    let p = proveedor(&LiveUsage::snapshot(&live2, false), "otro").clone();
    assert_eq!((p["status"].as_str(), p["error"]["kind"].as_str()), (Some("unknown"), Some("rate_limited")));
    assert!(p.get("snapshot").is_none());
}

#[test]
fn ningun_secreto_ni_identificador_de_cuenta_sale_en_la_respuesta() {
    let mut s = completo(T0);
    s.plan = Some("plus ghp_abcdefghijklmnopqrstuvwxyz0123456789".into());
    let bueno = Uso::nuevo("codex", todo(), Respuesta::Ok(Box::new(s)));
    let malo = Uso::nuevo("otro", todo(), Respuesta::Err(UsageError::unavailable("falló con token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 en la cabecera")));
    let live = vivo(servicio(), vec![bueno, malo]);
    LiveUsage::snapshot(&live, false);
    live.wait_idle();
    let texto = LiveUsage::snapshot(&live, false).to_string();
    for prohibido in ["cuenta-privada-ana", "example.com", "ghp_abcdef", "account_id"] {
        assert!(!texto.contains(prohibido), "la respuesta no debe llevar «{prohibido}»");
    }
    // La cuenta sale como huella de 8 hex.
    let v: Value = serde_json::from_str(&texto).unwrap();
    let cuenta = proveedor(&v, "codex")["snapshot"]["account"].as_str().unwrap();
    assert_eq!(cuenta.len(), 8);
    assert!(cuenta.chars().all(|c| c.is_ascii_hexdigit()));
}

// ── La query ────────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn la_query_es_de_una_persona_de_solo_lectura_y_valida_sus_argumentos() {
    assert_eq!(rpc_action_for_tests("usage_report"), ClientAction::Read);
    let (_l, _data, _core_dir, core) = core_listo();
    let me = persona(&core, "person-usage", "install-person-usage", "person-usage-secret-0123456789abcdef");

    // Primera lectura: el registro todavía sondea; cuando termina, ambos proveedores falsos (sin uso) constan como `unsupported`.
    let v = rpc(&core, &me, "usage_report", json!({})).unwrap();
    assert!(v["status"] == "loading" || v["status"] == "ready", "estado inesperado de usage_report");
    core.provider_registry.wait_idle();
    rpc(&core, &me, "usage_report", Value::Null).unwrap();
    core.usage_live.wait_idle();
    let v = rpc(&core, &me, "usage_report", json!({})).unwrap();
    assert_eq!(v["status"], "ready", "estado inesperado de usage_report");
    let ids: Vec<&str> = v["report"]["providers"].as_array().unwrap().iter().map(|p| p["provider"].as_str().unwrap()).collect();
    assert_eq!(ids, ["claude", "codex"]);
    assert!(v["report"]["providers"].as_array().unwrap().iter().all(|p| p["status"] == "unsupported"));

    for (args, contiene) in [(json!({ "x": 1 }), "parámetro desconocido"), (json!({ "refresh": "si" }), "booleano"), (json!("texto"), "objeto")] {
        let e = rpc(&core, &me, "usage_report", args).unwrap_err();
        assert!(e.contains("usage_report_invalid_request") && e.contains(contiene), "{e}");
    }
    assert!(rpc(&core, &me, "usage_report", json!({ "refresh": true })).is_ok());

    let ag = agente(&core, "t-agente", "install-agent-usage", "agent-usage-secret-0123456789abcdef");
    let e = rpc(&core, &ag, "usage_report", json!({})).unwrap_err();
    assert!(e.contains("usage_report_auth_required"), "{e}");
}

/// Validación manual con las CLI REALES instaladas: `claude /usage` (comando local, no pasa por el modelo) y los límites de la cuenta de
/// Codex. No gasta cuota. `cargo test --lib -- --ignored --exact --nocapture orch::usage_read_tests::real_uso_con_las_cli_instaladas`.
#[test]
#[ignore = "requiere las CLI de Claude y Codex instaladas y con sesión; ver docs/core/QUERIES.md"]
fn real_uso_con_las_cli_instaladas() {
    use super::adapter::{ClaudeAdapter, ClaudeConfig, CodexAdapter, CodexConfig};
    use super::provider_registry::LiveRegistry;
    let registro = LiveRegistry::with_builder(
        Box::new(|| vec![Arc::new(ClaudeAdapter::new(ClaudeConfig::default())) as Arc<dyn ProviderAdapter>, Arc::new(CodexAdapter::new(CodexConfig::default()))]),
        LARGO,
    );
    LiveRegistry::snapshot(&registro, false);
    registro.wait_idle();
    let r2 = registro.clone();
    let live = LiveUsage::with_targets(UsageService::new(UsageConfig::default()), Box::new(move || r2.usage_targets()), LARGO);

    let t = std::time::Instant::now();
    let primera = LiveUsage::snapshot(&live, false);
    assert!(t.elapsed() < Duration::from_secs(2), "la lectura no debe esperar a las CLI: {:?}", t.elapsed());
    assert_eq!(primera["status"], "loading");
    let mut v = primera;
    while v["refreshing"] == true && t.elapsed() < Duration::from_secs(90) {
        std::thread::sleep(Duration::from_millis(250));
        v = LiveUsage::snapshot(&live, false);
    }
    println!("consulta real en {:?}", t.elapsed());
    assert_eq!(v["status"], "ready", "estado inesperado de usage_report");
    for p in v["report"]["providers"].as_array().unwrap() {
        let resumen: Vec<String> = p["snapshot"]["windows"].as_array().map(|w| w.iter().map(|x| format!("{}={}", x["id"], x.get("used_percent").map_or("sin dato".to_string(), |u| u.to_string()))).collect()).unwrap_or_default();
        println!("{} · {} · {:?} · ventanas {:?} · error {}", p["provider"], p["status"], p["snapshot"]["provenance"], resumen, p["error"]["kind"]);
    }
    let texto = v.to_string();
    assert!(!super::context_package::contains_secret(&texto), "la respuesta no debe llevar nada con forma de credencial");
}
