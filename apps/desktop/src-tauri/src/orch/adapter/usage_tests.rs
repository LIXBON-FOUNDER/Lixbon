//! Pruebas del contrato de Usage (LXO-205): proveedores falsos con uso completo, parcial y ninguno; caché obsoleta y refresco
//! manual; fallos de autenticación y de rate limit; respuesta multi-proveedor y que ningún secreto llegue al informe.

use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::fake::{FakeAdapter, MinimalAdapter};
use super::usage::Clock;
use super::*;
use crate::store::looks_secret;

const T0: i64 = 1_800_000_000_000;

/// Un reloj que avanza solo cuando la prueba lo dice.
fn reloj() -> (Clock, Arc<AtomicI64>) {
    let now = Arc::new(AtomicI64::new(T0));
    let n = Arc::clone(&now);
    (Arc::new(move || n.load(Ordering::SeqCst)), now)
}

fn avanza(now: &AtomicI64, ms: i64) {
    now.fetch_add(ms, Ordering::SeqCst);
}

/// Lo que responde el proveedor falso en cada consulta.
#[derive(Clone)]
enum Reply {
    Ok(Box<UsageSnapshot>),
    Err(UsageError),
    /// No contesta hasta que lo cancelan.
    Hang,
    Panic,
}

struct UsageFake {
    id: String,
    support: Mutex<UsageSupport>,
    reply: Mutex<Reply>,
    calls: AtomicUsize,
    saw_cancel: AtomicBool,
    inner: FakeAdapter,
}

impl UsageFake {
    fn new(id: &str, support: UsageSupport, reply: Reply) -> Arc<UsageFake> {
        Arc::new(UsageFake { id: id.into(), support: Mutex::new(support), reply: Mutex::new(reply), calls: AtomicUsize::new(0), saw_cancel: AtomicBool::new(false), inner: FakeAdapter::full(id) })
    }

    fn set(&self, r: Reply) {
        *self.reply.lock().unwrap() = r;
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl ProviderAdapter for UsageFake {
    fn id(&self) -> &str {
        &self.id
    }

    fn probe(&self) -> ProbeResult {
        self.inner.probe()
    }

    fn start(&self, req: StartRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        self.inner.start(req, cancel)
    }

    fn events(&self, run: &RunHandle, cancel: &CancelToken, sink: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        self.inner.events(run, cancel, sink)
    }

    fn usage_support(&self) -> UsageSupport {
        self.support.lock().unwrap().clone()
    }

    fn usage(&self, cancel: &CancelToken) -> Result<UsageSnapshot, UsageError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match self.reply.lock().unwrap().clone() {
            Reply::Ok(s) => Ok(*s),
            Reply::Err(e) => Err(e),
            Reply::Hang => {
                let until = std::time::Instant::now() + Duration::from_secs(5);
                while !cancel.is_cancelled() && std::time::Instant::now() < until {
                    std::thread::sleep(Duration::from_millis(2));
                }
                self.saw_cancel.store(cancel.is_cancelled(), Ordering::SeqCst);
                Err(UsageError::unavailable("cancelada"))
            }
            Reply::Panic => panic!("el adapter se rompió"),
        }
    }
}

fn completo() -> UsageSupport {
    UsageField::ALL.into_iter().fold(UsageSupport::none(), |s, f| s.with(f, CapabilityState::Available))
}

fn solo_ventanas() -> UsageSupport {
    UsageSupport::none().with(UsageField::Windows, CapabilityState::Available)
}

fn win(id: &str, pct: f64) -> UsageWindow {
    UsageWindow { id: id.into(), minutes: Some(300), used_percent: Some(pct), resets_at: Some(1_800_003_600) }
}

/// Uso completo: ventanas, tokens por modelo, créditos, plan y cuenta.
fn snap_completo(at: i64) -> UsageSnapshot {
    let mut s = UsageSnapshot::new(at, Provenance::ProviderQuery);
    s.account_id = Some("cuenta-uno".into());
    s.plan = Some("plus".into());
    s.windows = vec![win("primary", 12.0), win("secondary", 3.0)];
    s.models = vec![ModelUsage { model: "m1".into(), input_tokens: Some(10), output_tokens: Some(20), cache_read_tokens: None, cache_creation_tokens: None, cost_usd: Some(0.5) }];
    s.credits = Some(Credits { has_credits: Some(true), unlimited: Some(false), balance: Some("42".into()) });
    s.limit_reached = Some(false);
    s
}

/// Uso parcial: solo una ventana, sin porcentaje.
fn snap_parcial(at: i64) -> UsageSnapshot {
    let mut s = UsageSnapshot::new(at, Provenance::RunObservation);
    s.windows = vec![UsageWindow { id: "five_hour".into(), minutes: None, used_percent: None, resets_at: Some(1_800_003_600) }];
    s
}

fn target(a: &Arc<UsageFake>) -> UsageTarget {
    UsageTarget { id: a.id.clone(), adapter: Arc::clone(a) as Arc<dyn ProviderAdapter>, environment_blocked: false }
}

/// El reloj de TTL y backoff es falso, pero el servicio espera la respuesta del hilo del adapter en tiempo REAL. El adapter falso
/// contesta al instante, así que el tope solo sirve de red de seguridad: con 300 ms, una máquina cargada lo vencía antes de que el
/// hilo llegara a contestar y el informe salía `Unknown` en vez de `Fresh`/`Stale`.
fn servicio() -> (UsageService, Arc<AtomicI64>) {
    servicio_con_tope(Duration::from_secs(30))
}

/// Solo para la prueba de «no contesta», que SÍ necesita que el tope venza pronto (vencer tarde no la hace fallar).
fn servicio_con_tope(timeout: Duration) -> (UsageService, Arc<AtomicI64>) {
    let (clock, now) = reloj();
    (UsageService::with_clock(UsageConfig { timeout, ..UsageConfig::default() }, clock), now)
}

fn one(r: &UsageReport) -> &ProviderUsage {
    assert_eq!(r.providers.len(), 1);
    &r.providers[0]
}

// ── Completo / parcial / ninguno ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn proveedor_con_uso_completo() {
    let (svc, _) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Ok(Box::new(snap_completo(T0))));
    let r = svc.report(&[target(&a)], Refresh::IfStale);
    let p = one(&r);
    assert_eq!(p.status, UsageStatus::Fresh);
    let s = p.snapshot.as_ref().unwrap();
    assert_eq!(s.provider, "a", "el proveedor lo pone el servicio");
    assert_eq!((s.plan.as_deref(), s.windows.len(), s.models.len()), (Some("plus"), 2, 1));
    assert_eq!(s.models[0].cache_read_tokens, None, "lo que el proveedor no dio sigue siendo desconocido, no 0");
    assert_eq!(p.age_ms, Some(0));
    assert_eq!(r.version, USAGE_VERSION);
}

#[test]
fn proveedor_con_uso_parcial_deja_lo_demas_desconocido() {
    let (svc, _) = servicio();
    let a = UsageFake::new("a", solo_ventanas(), Reply::Ok(Box::new(snap_parcial(T0))));
    let p = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0);
    let s = p.snapshot.unwrap();
    assert_eq!(s.windows[0].used_percent, None, "sin porcentaje no hay porcentaje: ni 0 ni 100");
    assert!(s.plan.is_none() && s.credits.is_none() && s.models.is_empty() && s.limit_reached.is_none());
    assert_eq!(p.support.state(UsageField::Tokens), &CapabilityState::Unsupported);
}

#[test]
fn proveedor_sin_uso_no_se_consulta_y_no_es_cero() {
    let (svc, _) = servicio();
    let m = Arc::new(MinimalAdapter::new("minimo"));
    let t = UsageTarget { id: "minimo".into(), adapter: m, environment_blocked: false };
    let p = svc.report(&[t], Refresh::Force).providers.remove(0);
    assert_eq!(p.status, UsageStatus::Unsupported);
    assert!(p.snapshot.is_none() && p.age_ms.is_none() && p.error.is_none());
    assert!(!p.support.offers_anything());
}

#[test]
fn entorno_bloqueado_no_se_consulta() {
    let (svc, _) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Ok(Box::new(snap_completo(T0))));
    let mut t = target(&a);
    t.environment_blocked = true;
    let p = svc.report(&[t], Refresh::Force).providers.remove(0);
    assert_eq!(p.status, UsageStatus::EnvironmentBlocked);
    assert_eq!(a.calls(), 0, "un entorno bloqueado no recibe llamadas");
}

// ── Caché, TTL y refresco manual ────────────────────────────────────────────────────────────────────────────────────

#[test]
fn la_cache_evita_consultar_dentro_del_ttl_y_se_renueva_al_caducar() {
    let (svc, now) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Ok(Box::new(snap_completo(T0))));
    svc.report(&[target(&a)], Refresh::IfStale);
    avanza(&now, 60_000);
    let p = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0);
    assert_eq!((a.calls(), p.status, p.age_ms), (1, UsageStatus::Fresh, Some(60_000)));

    avanza(&now, 5 * 60_000);
    a.set(Reply::Ok(Box::new(snap_completo(T0 + 6 * 60_000))));
    let p = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0);
    assert_eq!((a.calls(), p.status, p.age_ms), (2, UsageStatus::Fresh, Some(0)));
}

#[test]
fn una_observacion_vieja_es_obsoleta_aunque_se_acabe_de_consultar() {
    let (svc, _) = servicio();
    // El adapter responde ahora con lo que observó hace una hora: la consulta es de ahora, el dato no.
    let a = UsageFake::new("a", solo_ventanas(), Reply::Ok(Box::new(snap_parcial(T0 - 3_600_000))));
    let p = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0);
    assert_eq!((p.status, p.age_ms), (UsageStatus::Stale, Some(3_600_000)));
    svc.report(&[target(&a)], Refresh::IfStale);
    assert_eq!(a.calls(), 1, "no se vuelve a preguntar dentro del TTL de la consulta");
}

#[test]
fn el_refresco_manual_consulta_aunque_la_cache_sea_valida_pero_no_en_rafaga() {
    let (svc, now) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Ok(Box::new(snap_completo(T0))));
    svc.report(&[target(&a)], Refresh::IfStale);

    avanza(&now, 1_000);
    let p = svc.report(&[target(&a)], Refresh::Force).providers.remove(0);
    assert!(p.throttled, "un segundo después aún es demasiado pronto");
    assert_eq!(a.calls(), 1);

    avanza(&now, 10_000);
    a.set(Reply::Ok(Box::new(snap_completo(T0 + 11_000))));
    let p = svc.report(&[target(&a)], Refresh::Force).providers.remove(0);
    assert!(!p.throttled);
    assert_eq!((a.calls(), p.age_ms), (2, Some(0)));
}

// ── Fallos ──────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn fallo_de_autenticacion_sin_dato_previo_es_desconocido() {
    let (svc, _) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Err(UsageError::auth_required()));
    let p = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0);
    assert_eq!(p.status, UsageStatus::Unknown);
    assert!(p.snapshot.is_none(), "un fallo no inventa una lectura a cero");
    assert_eq!(p.error.unwrap().kind, UsageErrorKind::AuthRequired);
}

#[test]
fn fallo_de_rate_limit_conserva_el_dato_anterior_como_obsoleto() {
    let (svc, now) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Ok(Box::new(snap_completo(T0))));
    svc.report(&[target(&a)], Refresh::IfStale);

    avanza(&now, 6 * 60_000);
    a.set(Reply::Err(UsageError::rate_limited()));
    let p = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0);
    assert_eq!(p.status, UsageStatus::Stale);
    assert_eq!(p.error.as_ref().unwrap().kind, UsageErrorKind::RateLimited);
    assert_eq!(p.snapshot.as_ref().unwrap().plan.as_deref(), Some("plus"), "el último dato bueno sigue visible");
    assert_eq!(p.age_ms, Some(6 * 60_000));
}

#[test]
fn tras_un_fallo_no_se_martillea_al_proveedor_salvo_refresco_manual() {
    let (svc, now) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Err(UsageError::unavailable("caído")));
    svc.report(&[target(&a)], Refresh::IfStale);
    avanza(&now, 10_000);
    svc.report(&[target(&a)], Refresh::IfStale);
    assert_eq!(a.calls(), 1, "dentro del backoff no se reintenta");

    avanza(&now, 30_000);
    a.set(Reply::Ok(Box::new(snap_completo(T0 + 40_000))));
    let p = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0);
    assert_eq!((a.calls(), p.status, p.error), (2, UsageStatus::Fresh, None), "pasado el backoff se recupera y se limpia el error");
}

#[test]
fn una_consulta_que_no_contesta_se_corta_por_tiempo_y_se_cancela() {
    let (svc, _) = servicio_con_tope(Duration::from_millis(300));
    let a = UsageFake::new("a", completo(), Reply::Hang);
    let t0 = std::time::Instant::now();
    let p = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0);
    assert!(t0.elapsed() < Duration::from_secs(3), "el informe no espera al proveedor");
    assert_eq!((p.status, p.error.unwrap().kind), (UsageStatus::Unknown, UsageErrorKind::ProviderUnavailable));
    // El adapter falso mira la cancelación cada 2 ms y se rinde a los 5 s: se espera a verla, no a un instante fijo.
    let limite = std::time::Instant::now() + Duration::from_secs(4);
    while !a.saw_cancel.load(Ordering::SeqCst) && std::time::Instant::now() < limite {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(a.saw_cancel.load(Ordering::SeqCst), "al pasar el tope se cancela la consulta");
}

#[test]
fn un_adapter_que_entra_en_panico_es_un_fallo_interno_no_un_cierre() {
    let (svc, _) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Panic);
    let p = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0);
    assert_eq!(p.error.unwrap().kind, UsageErrorKind::Internal);
}

#[test]
fn consultar_el_uso_no_toca_el_ciclo_de_vida_de_una_ejecucion() {
    let (svc, _) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Err(UsageError::auth_required()));
    let mut reg = AdapterRegistry::new();
    reg.register(Arc::clone(&a) as Arc<dyn ProviderAdapter>).unwrap();
    let cancel = CancelToken::new();
    let run = reg.gated("a").unwrap().start(StartRequest { attempt_id: "a1".into(), worktree: "wt".into(), prompt: "x".into(), profile: "proponer".into(), model: None, effort: None }, &cancel).unwrap();

    let r = svc.report(&reg.usage_targets(), Refresh::Force);
    assert_eq!(one(&r).error.as_ref().unwrap().kind, UsageErrorKind::AuthRequired);

    let outcome = reg.gated("a").unwrap().events(&run, &cancel, &mut |_e: AdapterEvent| {}).unwrap();
    assert!(matches!(outcome, RunOutcome::Completed { .. }), "el fallo de uso no afectó a la ejecución");
}

// ── Multi-proveedor ─────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn la_respuesta_multi_proveedor_es_una_lista_sin_totales() {
    let (svc, _) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Ok(Box::new(snap_completo(T0))));
    let b = UsageFake::new("b", solo_ventanas(), Reply::Ok(Box::new(snap_parcial(T0))));
    let c = UsageFake::new("c", completo(), Reply::Err(UsageError::rate_limited()));
    let m = Arc::new(MinimalAdapter::new("d"));
    let targets = vec![target(&a), target(&b), target(&c), UsageTarget { id: "d".into(), adapter: m, environment_blocked: false }];
    let r = svc.report(&targets, Refresh::IfStale);

    let estados: Vec<_> = r.providers.iter().map(|p| (p.provider.as_str(), p.status)).collect();
    assert_eq!(estados, [("a", UsageStatus::Fresh), ("b", UsageStatus::Fresh), ("c", UsageStatus::Unknown), ("d", UsageStatus::Unsupported)]);

    // Cada magnitud se queda con su proveedor; ningún campo suma tokens de uno con porcentajes de otro.
    let json = serde_json::to_value(&r).unwrap();
    let texto = json.to_string();
    for prohibido in ["\"total", "\"sum", "\"aggregate"] {
        assert!(!texto.contains(prohibido), "el informe no debe traer totales: {prohibido}");
    }
    assert_eq!(json["providers"].as_array().unwrap().len(), 4);
}

#[test]
fn el_registro_entrega_los_proveedores_y_marca_los_bloqueados() {
    let mut reg = AdapterRegistry::new();
    reg.register(Arc::new(FakeAdapter::full("listo"))).unwrap();
    reg.register(Arc::new(FakeAdapter::with_probe("bloqueado", ProbeResult::blocked(None, vec![crate::orch::agents::EnvBlock::CliMissing])))).unwrap();
    let t = reg.usage_targets();
    let m: Vec<_> = t.iter().map(|t| (t.id.as_str(), t.environment_blocked)).collect();
    assert_eq!(m, [("bloqueado", true), ("listo", false)]);
}

// ── Sin secretos y sin valores falsos ───────────────────────────────────────────────────────────────────────────────

const SECRETO: &str = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef";

#[test]
fn ningun_secreto_ni_identificador_de_cuenta_llega_al_informe() {
    assert!(looks_secret(SECRETO), "el texto de prueba tiene forma de credencial");
    let (svc, _) = servicio();
    let mut s = snap_completo(T0);
    s.plan = Some(format!("plus {SECRETO}"));
    s.windows[0].id = format!("w {SECRETO}");
    s.models[0].model = format!("modelo {SECRETO}");
    s.credits = Some(Credits { has_credits: Some(true), unlimited: None, balance: Some(format!("1 {SECRETO}")) });
    s.account_id = Some("cuenta-privada@ejemplo.com".into());
    let a = UsageFake::new("a", completo(), Reply::Ok(Box::new(s)));
    let r = svc.report(&[target(&a)], Refresh::IfStale);
    let texto = serde_json::to_string(&r).unwrap();
    assert!(!texto.contains(SECRETO), "el secreto se redacta en cada campo de texto");
    assert!(texto.contains(REDACTED));
    assert!(!texto.contains("cuenta-privada"), "el identificador de la cuenta no sale; solo su huella");
    let s = one(&r).snapshot.as_ref().unwrap();
    assert_eq!(s.account.as_deref(), Some(account_fingerprint("cuenta-privada@ejemplo.com").as_str()));
    assert_eq!(s.account.as_ref().unwrap().len(), 8);
    assert!(s.account_id.is_none());
}

#[test]
fn un_error_del_proveedor_con_un_secreto_sale_redactado() {
    let (svc, _) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Err(UsageError::unavailable(&format!("fallo con {SECRETO}"))));
    let r = svc.report(&[target(&a)], Refresh::IfStale);
    assert!(!serde_json::to_string(&r).unwrap().contains(SECRETO));
}

#[test]
fn valores_imposibles_se_descartan_en_lugar_de_corregirse() {
    let (svc, _) = servicio();
    let mut s = snap_completo(T0);
    s.windows = vec![win("a", 140.0), win("b", -1.0), win("c", f64::NAN), win("d", 100.0)];
    s.models[0].cost_usd = Some(f64::INFINITY);
    let a = UsageFake::new("a", completo(), Reply::Ok(Box::new(s)));
    let p = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0);
    let s = p.snapshot.unwrap();
    let w: Vec<_> = s.windows.iter().map(|w| w.used_percent).collect();
    assert_eq!(w, [None, None, None, Some(100.0)]);
    assert_eq!(s.models[0].cost_usd, None);
}

#[test]
fn el_informe_se_acota() {
    let (svc, _) = servicio();
    let mut s = snap_completo(T0);
    s.windows = (0..50).map(|i| win(&format!("w{i}"), 1.0)).collect();
    s.models = (0..50).map(|i| ModelUsage { model: format!("m{i}"), input_tokens: None, output_tokens: None, cache_read_tokens: None, cache_creation_tokens: None, cost_usd: None }).collect();
    let a = UsageFake::new("a", completo(), Reply::Ok(Box::new(s)));
    let s = svc.report(&[target(&a)], Refresh::IfStale).providers.remove(0).snapshot.unwrap();
    assert!(s.windows.len() <= 8 && s.models.len() <= 16);
}

#[test]
fn la_huella_distingue_cuentas_y_es_estable() {
    assert_eq!(account_fingerprint("a"), account_fingerprint("a"));
    assert_ne!(account_fingerprint("a"), account_fingerprint("b"));
}

// ── Contrato publicado ──────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn el_informe_de_ejemplo_del_contrato_coincide_con_la_fixture() {
    let (svc, _) = servicio();
    let a = UsageFake::new("codex", completo(), Reply::Ok(Box::new(snap_completo(T0))));
    let b = UsageFake::new("claude", solo_ventanas(), Reply::Ok(Box::new(snap_parcial(T0 - 120_000))));
    let c = UsageFake::new("otro", completo(), Reply::Err(UsageError::auth_required()));
    let m = Arc::new(MinimalAdapter::new("minimo"));
    let r = svc.report(&[target(&a), target(&b), target(&c), UsageTarget { id: "minimo".into(), adapter: m, environment_blocked: false }], Refresh::IfStale);
    let actual = serde_json::to_value(&r).unwrap();
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/core/fixtures/api/usage_report.v1.json");
    if std::env::var("LXO_WRITE_API_FIXTURES").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "
").unwrap();
    }
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("falta {}; contenido actual:
{}", path.display(), serde_json::to_string_pretty(&actual).unwrap()));
    let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture válida");
    assert_eq!(actual, fixture, "si el contrato cambió, actualiza docs/core/fixtures/api/usage_report.v1.json (y sube USAGE_VERSION si rompe a los clientes)");

    // Y un cliente puede leerla tal cual.
    let leida: UsageReport = serde_json::from_value(fixture).expect("la fixture se deserializa");
    assert_eq!(leida.providers.len(), 4);
}

#[test]
fn un_support_al_que_le_falta_un_campo_no_se_acepta() {
    let ok = serde_json::to_value(UsageSupport::none()).unwrap();
    assert!(serde_json::from_value::<UsageSupport>(ok.clone()).is_ok());
    let mut roto = ok;
    roto["fields"].as_object_mut().unwrap().remove("cost");
    assert!(serde_json::from_value::<UsageSupport>(roto).is_err());
}

#[test]
fn se_puede_pedir_solo_el_proveedor_en_uso() {
    let (svc, _) = servicio();
    let a = UsageFake::new("a", completo(), Reply::Ok(Box::new(snap_completo(T0))));
    let b = UsageFake::new("b", completo(), Reply::Ok(Box::new(snap_completo(T0))));
    let mut reg = AdapterRegistry::new();
    reg.register(Arc::clone(&a) as Arc<dyn ProviderAdapter>).unwrap();
    reg.register(Arc::clone(&b) as Arc<dyn ProviderAdapter>).unwrap();
    let r = svc.report(&[reg.usage_target("b").unwrap()], Refresh::IfStale);
    assert_eq!(one(&r).provider, "b");
    assert_eq!((a.calls(), b.calls()), (0, 1), "el otro proveedor ni se entera");
    assert_eq!(reg.usage_target("zz").err().unwrap().code, ErrorCode::UnknownProvider);
}
