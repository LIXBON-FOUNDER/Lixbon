//! Usage cross-provider (LXO-205): qué cuota, ventanas de rate limit y créditos informa cada proveedor, normalizado SIN
//! fingir lo que el proveedor no expone. Contrato y semántica: `docs/core/ADAPTERS.md#usage`.
//!
//! Reglas que este módulo hace cumplir (no solo documenta):
//! 1. Desconocido ≠ cero: un campo ausente es `None` / lista vacía y el estado del proveedor dice `unknown`; nunca se rellena.
//! 2. Magnitudes incompatibles no se suman: el [`UsageReport`] es una LISTA por proveedor, sin ningún total.
//! 3. Todo valor lleva proveedor, cuenta (huella opaca), frescura y procedencia.
//! 4. Consultar el uso nunca toca un Attempt: es una llamada aparte, con tope de tiempo, que falla sin efectos.
//! 5. Ningún texto del proveedor sale sin redactar y acotar; la cuenta sale como huella, nunca como identificador.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::redact::safe_text;
use super::{AdapterError, CancelToken, CapabilityState, ErrorCode, ProviderAdapter};

/// Versión del formato de [`UsageReport`] (`docs/core/fixtures/api/usage_report.v1.json`).
pub const USAGE_VERSION: u32 = 1;

const MAX_TEXT_CHARS: usize = 120;
const MAX_WINDOWS: usize = 8;
const MAX_MODELS: usize = 16;

/// Qué puede informar un proveedor. Conjunto CERRADO y versionado con el informe.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum UsageField {
    /// Ventanas de rate limit / cuota (porcentaje usado y cuándo se reinicia).
    Windows,
    /// Tokens por modelo.
    Tokens,
    /// Créditos o saldo.
    Credits,
    /// Plan de la cuenta.
    Plan,
    /// Coste en dólares informado por el proveedor (nunca estimado por Lixbon).
    Cost,
}

impl UsageField {
    pub const ALL: [UsageField; 5] = [UsageField::Windows, UsageField::Tokens, UsageField::Credits, UsageField::Plan, UsageField::Cost];
}

/// Qué campos ofrece un adapter. Se construye todo `unsupported` y se declara solo lo que el proveedor da de verdad.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct UsageSupport {
    pub fields: BTreeMap<UsageField, CapabilityState>,
}

impl Default for UsageSupport {
    fn default() -> Self {
        UsageSupport::none()
    }
}

impl UsageSupport {
    pub fn none() -> UsageSupport {
        UsageSupport { fields: UsageField::ALL.into_iter().map(|f| (f, CapabilityState::Unsupported)).collect() }
    }

    pub fn with(mut self, field: UsageField, state: CapabilityState) -> UsageSupport {
        self.fields.insert(field, state);
        self
    }

    pub fn state(&self, field: UsageField) -> &CapabilityState {
        self.fields.get(&field).unwrap_or(&CapabilityState::Unsupported)
    }

    /// ¿Ofrece el proveedor algo de uso? Si no, ni se le consulta.
    pub fn offers_anything(&self) -> bool {
        self.fields.values().any(|s| !matches!(s, CapabilityState::Unsupported))
    }
}

/// De dónde sale el dato. Un cliente no debe presentar una observación de una ejecución pasada como una consulta actual.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    /// El adapter preguntó al proveedor ahora (sin gastar cuota).
    ProviderQuery,
    /// Lo último que el proveedor dijo durante una ejecución; `observed_at_ms` es el momento de esa observación.
    RunObservation,
}

/// Una ventana de cuota. `used_percent` en 0..=100; `None` = el proveedor no lo dio.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UsageWindow {
    /// Identificador del proveedor para la ventana (`five_hour`, `primary`…). Texto informativo, no una enumeración.
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_percent: Option<f64>,
    /// Unix en segundos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
}

/// Tokens y coste de un modelo. Cada campo ausente es desconocido, no cero.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ModelUsage {
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

/// Créditos tal como los da el proveedor. `balance` es texto con la unidad del proveedor (no son dólares).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Credits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_credits: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unlimited: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub balance: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UsageSnapshot {
    /// Lo pone el servicio: un adapter no se atribuye el dato de otro.
    #[serde(default)]
    pub provider: String,
    /// Cuándo se observó el dato (ms Unix). Es lo que decide la frescura.
    pub observed_at_ms: i64,
    pub provenance: Provenance,
    /// Huella opaca de la cuenta (8 hex de un SHA-256): distingue cuentas sin publicar su identificador. La calcula el
    /// servicio con [`account_fingerprint`]; el adapter entrega el identificador solo en `account_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<UsageWindow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credits: Option<Credits>,
    /// `Some(true)` si el proveedor dice que se alcanzó un límite; `None` si no lo dice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_reached: Option<bool>,
    /// Identificador crudo de la cuenta, SOLO de entrada: el servicio lo convierte en `account` y lo borra.
    #[serde(skip)]
    pub account_id: Option<String>,
}

impl UsageSnapshot {
    pub fn new(observed_at_ms: i64, provenance: Provenance) -> UsageSnapshot {
        UsageSnapshot {
            provider: String::new(),
            observed_at_ms,
            provenance,
            account: None,
            plan: None,
            windows: vec![],
            models: vec![],
            credits: None,
            limit_reached: None,
            account_id: None,
        }
    }
}

/// Huella de una cuenta: 8 hex del SHA-256 del identificador. Estable, no reversible a efectos prácticos.
pub fn account_fingerprint(account_id: &str) -> String {
    let digest = Sha256::digest(account_id.as_bytes());
    digest.iter().take(4).map(|b| format!("{b:02x}")).collect()
}

// ── Errores ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Por qué no se pudo consultar el uso. Conjunto CERRADO; ninguno falla un Attempt.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageErrorKind {
    /// El proveedor pide iniciar sesión.
    AuthRequired,
    /// El proveedor limita las consultas.
    RateLimited,
    /// El proveedor no contesta, tarda demasiado o aún no tiene datos.
    ProviderUnavailable,
    /// El proveedor no informa de uso.
    Unsupported,
    /// El entorno impide consultarlo.
    EnvironmentBlocked,
    /// Fallo del adapter.
    Internal,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct UsageError {
    pub kind: UsageErrorKind,
    pub message: String,
}

impl UsageError {
    pub fn new(kind: UsageErrorKind, message: &str) -> UsageError {
        UsageError { kind, message: safe_text(message, 300) }
    }

    pub fn auth_required() -> UsageError {
        UsageError::new(UsageErrorKind::AuthRequired, "el proveedor pide iniciar sesión")
    }

    pub fn rate_limited() -> UsageError {
        UsageError::new(UsageErrorKind::RateLimited, "el proveedor limita las consultas de uso: se reintentará más tarde")
    }

    pub fn unavailable(message: &str) -> UsageError {
        UsageError::new(UsageErrorKind::ProviderUnavailable, message)
    }

    pub fn unsupported() -> UsageError {
        UsageError::new(UsageErrorKind::Unsupported, "el proveedor no informa de su uso")
    }
}

impl From<AdapterError> for UsageError {
    fn from(e: AdapterError) -> UsageError {
        let kind = match e.code {
            ErrorCode::UnsupportedCapability | ErrorCode::UnknownCapability => UsageErrorKind::Unsupported,
            ErrorCode::EnvironmentBlocked => UsageErrorKind::EnvironmentBlocked,
            ErrorCode::CapabilityUnavailable | ErrorCode::Cancelled | ErrorCode::Provider => UsageErrorKind::ProviderUnavailable,
            _ => UsageErrorKind::Internal,
        };
        UsageError::new(kind, &e.message)
    }
}

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

// ── Informe ─────────────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UsageStatus {
    /// Dato observado dentro del TTL.
    Fresh,
    /// Hay dato pero es más viejo que el TTL, o el último refresco falló (ver `error`).
    Stale,
    /// No hay dato (todavía o por un fallo): NO es cero.
    Unknown,
    /// El proveedor no informa de uso.
    Unsupported,
    EnvironmentBlocked,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ProviderUsage {
    pub provider: String,
    pub status: UsageStatus,
    pub support: UsageSupport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<UsageSnapshot>,
    /// Edad del dato en ms respecto a su observación.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub age_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<UsageError>,
    /// `true` si un refresco manual se atendió con la caché por pedirse demasiado pronto.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub throttled: bool,
}

/// Una entrada por proveedor, sin totales: sumar tokens de un proveedor con porcentajes de otro no significa nada.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct UsageReport {
    pub version: u32,
    pub generated_at_ms: i64,
    pub providers: Vec<ProviderUsage>,
}

impl<'de> Deserialize<'de> for UsageSupport {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            fields: BTreeMap<UsageField, CapabilityState>,
        }
        let raw = Raw::deserialize(d)?;
        if let Some(missing) = UsageField::ALL.into_iter().find(|f| !raw.fields.contains_key(f)) {
            return Err(serde::de::Error::custom(format!("a `support` le falta {missing:?}: lo que no se ofrece se declara `unsupported`")));
        }
        Ok(UsageSupport { fields: raw.fields })
    }
}

// ── Directorio de trabajo de la consulta ───────────────────────────────────────────────────────────────────────────────

/// Carpeta vacía y propia donde corre la CLI al consultar el uso. No es el TEMP del sistema: una CLI que escanea su `cwd`
/// tarda 4 veces más en una carpeta llena (medido con Claude 2.1.296: 20,7 s frente a 5,3 s). Se borra al soltarla.
pub struct UsageScratch(std::path::PathBuf);

impl UsageScratch {
    pub fn create() -> Result<UsageScratch, UsageError> {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("lxo-usage-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
        std::fs::create_dir_all(&dir).map_err(|e| UsageError::new(UsageErrorKind::Internal, &format!("no se pudo crear la carpeta de la consulta: {e}")))?;
        Ok(UsageScratch(dir))
    }

    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for UsageScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ── Servicio ────────────────────────────────────────────────────────────────────────────────────────────────────────

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0))
}

#[derive(Clone, Debug)]
pub struct UsageConfig {
    /// Hasta cuándo un dato es `fresh`, y cada cuánto se vuelve a consultar sin que nadie lo pida.
    pub ttl_ms: i64,
    /// Tras un fallo, no se reintenta antes de esto salvo refresco manual.
    pub error_backoff_ms: i64,
    /// Un refresco manual dentro de este margen respecto a la última consulta se atiende con la caché.
    pub min_refresh_ms: i64,
    /// Tope de una consulta; al pasarlo se cancela y cuenta como `provider_unavailable`.
    pub timeout: Duration,
}

impl Default for UsageConfig {
    fn default() -> Self {
        UsageConfig { ttl_ms: 5 * 60_000, error_backoff_ms: 30_000, min_refresh_ms: 5_000, timeout: Duration::from_secs(15) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refresh {
    /// Usa la caché si no ha caducado.
    IfStale,
    /// Refresco manual: consulta aunque la caché sea válida (con un margen mínimo).
    Force,
}

#[derive(Default)]
struct CacheEntry {
    snapshot: Option<UsageSnapshot>,
    fetched_at_ms: Option<i64>,
    error: Option<(UsageError, i64)>,
}

pub struct UsageService {
    cfg: UsageConfig,
    clock: Clock,
    cache: Mutex<HashMap<String, CacheEntry>>,
    in_flight: Mutex<HashSet<String>>,
}

/// Lo que el servicio necesita saber de un proveedor registrado.
pub struct UsageTarget {
    pub id: String,
    pub adapter: Arc<dyn ProviderAdapter>,
    pub environment_blocked: bool,
}

impl UsageService {
    pub fn new(cfg: UsageConfig) -> UsageService {
        UsageService::with_clock(cfg, system_clock())
    }

    pub fn with_clock(cfg: UsageConfig, clock: Clock) -> UsageService {
        UsageService { cfg, clock, cache: Mutex::new(HashMap::new()), in_flight: Mutex::new(HashSet::new()) }
    }

    /// El uso de cada proveedor. Nunca falla: un proveedor que no responde aparece como `unknown`/`stale` con su error.
    pub fn report(&self, targets: &[UsageTarget], refresh: Refresh) -> UsageReport {
        let now = (self.clock)();
        UsageReport { version: USAGE_VERSION, generated_at_ms: now, providers: targets.iter().map(|t| self.one(t, refresh)).collect() }
    }

    fn one(&self, t: &UsageTarget, refresh: Refresh) -> ProviderUsage {
        let support = t.adapter.usage_support();
        if t.environment_blocked {
            return self.view(&t.id, support, UsageStatus::EnvironmentBlocked, false);
        }
        if !support.offers_anything() {
            return self.view(&t.id, support, UsageStatus::Unsupported, false);
        }
        let now = (self.clock)();
        let (call, throttled) = self.should_call(&t.id, refresh, now);
        if call {
            self.fetch(t, now);
        }
        self.view(&t.id, support, UsageStatus::Unknown, throttled)
    }

    fn should_call(&self, id: &str, refresh: Refresh, now: i64) -> (bool, bool) {
        let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let Some(e) = cache.get(id) else { return (true, false) };
        let since_fetch = e.fetched_at_ms.map(|f| now - f);
        if refresh == Refresh::Force {
            return match since_fetch {
                Some(s) if s < self.cfg.min_refresh_ms => (false, true),
                _ => (true, false),
            };
        }
        // Tras un fallo manda el backoff, no el TTL: se reintenta en cuanto pasa, aunque la última lectura buena sea reciente.
        if let Some((_, at)) = &e.error {
            return (now - at >= self.cfg.error_backoff_ms, false);
        }
        match since_fetch {
            Some(s) if s <= self.cfg.ttl_ms => (false, false),
            _ => (true, false),
        }
    }

    /// Consulta con tope de tiempo y a un solo vuelo por proveedor. El resultado queda en la caché; no se devuelve.
    fn fetch(&self, t: &UsageTarget, now: i64) {
        if !self.in_flight.lock().unwrap_or_else(|e| e.into_inner()).insert(t.id.clone()) {
            return;
        }
        let cancel = CancelToken::new();
        let (tx, rx) = mpsc::channel();
        let adapter = Arc::clone(&t.adapter);
        let c = cancel.clone();
        std::thread::spawn(move || {
            let _ = tx.send(adapter.usage(&c));
        });
        let outcome: Result<UsageSnapshot, UsageError> = match rx.recv_timeout(self.cfg.timeout) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                cancel.cancel();
                Err(UsageError::unavailable("la consulta de uso superó el tiempo máximo"))
            }
            // El hilo del adapter murió sin contestar: un fallo del adapter, no del proveedor.
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(UsageError::new(UsageErrorKind::Internal, "la consulta de uso terminó de forma inesperada")),
        };
        self.in_flight.lock().unwrap_or_else(|e| e.into_inner()).remove(&t.id);

        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let entry = cache.entry(t.id.clone()).or_default();
        entry.fetched_at_ms = Some(now);
        match outcome {
            Ok(snap) => {
                entry.snapshot = Some(sanitize(snap, &t.id));
                entry.error = None;
            }
            // El dato anterior se conserva: pasa a `stale`, no se borra ni se vuelve cero.
            Err(e) => entry.error = Some((e, now)),
        }
    }

    fn view(&self, id: &str, support: UsageSupport, base: UsageStatus, throttled: bool) -> ProviderUsage {
        let now = (self.clock)();
        let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let entry = cache.get(id);
        let snapshot = if matches!(base, UsageStatus::Unsupported | UsageStatus::EnvironmentBlocked) { None } else { entry.and_then(|e| e.snapshot.clone()) };
        let error = entry.and_then(|e| e.error.as_ref().map(|(err, _)| err.clone()));
        let age_ms = snapshot.as_ref().map(|s| (now - s.observed_at_ms).max(0));
        let status = match (base, &snapshot) {
            (UsageStatus::Unsupported, _) | (UsageStatus::EnvironmentBlocked, _) => base,
            (_, Some(_)) if error.is_some() || age_ms.is_some_and(|a| a > self.cfg.ttl_ms) => UsageStatus::Stale,
            (_, Some(_)) => UsageStatus::Fresh,
            (_, None) => UsageStatus::Unknown,
        };
        let error = if matches!(base, UsageStatus::Unsupported | UsageStatus::EnvironmentBlocked) { None } else { error };
        ProviderUsage { provider: id.to_string(), status, support, snapshot, age_ms, error, throttled }
    }
}

/// Lo único que sale del servicio: proveedor puesto por nosotros, texto redactado y acotado, porcentajes en 0..=100,
/// cuenta como huella. Un valor que no cabe se descarta (queda desconocido), no se corrige a otro.
fn sanitize(mut s: UsageSnapshot, provider: &str) -> UsageSnapshot {
    s.provider = provider.to_string();
    s.account = s.account_id.take().filter(|id| !id.trim().is_empty()).map(|id| account_fingerprint(&id));
    s.plan = s.plan.map(|p| safe_text(&p, 40)).filter(|p| !p.is_empty());
    s.windows.truncate(MAX_WINDOWS);
    for w in &mut s.windows {
        w.id = safe_text(&w.id, 40);
        w.used_percent = w.used_percent.filter(|p| p.is_finite() && (0.0..=100.0).contains(p));
    }
    s.models.truncate(MAX_MODELS);
    for m in &mut s.models {
        m.model = safe_text(&m.model, MAX_TEXT_CHARS);
        m.cost_usd = m.cost_usd.filter(|c| c.is_finite() && *c >= 0.0);
    }
    if let Some(c) = &mut s.credits {
        c.balance = c.balance.take().map(|b| safe_text(&b, 40)).filter(|b| !b.is_empty());
    }
    s
}
