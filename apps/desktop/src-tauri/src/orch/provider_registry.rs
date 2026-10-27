//! Registro vivo de adapters y query `provider_capabilities` (LXO-135): lo que Desktop (y luego `lxo`) lee para saber qué puede
//! hacer cada proveedor AHORA, en lugar de deducirlo por su nombre. Contrato: `docs/core/QUERIES.md` § provider_capabilities;
//! forma de cada proveedor y de su matriz: `docs/core/ADAPTERS.md`.
//!
//! # Por qué es vivo y no una foto
//! Sondear un proveedor es lanzar su CLI (`--version`, `--help`, el preflight del sandbox…): tarda y puede colgarse. Por eso:
//!
//! * **La query nunca sondea.** Devuelve al instante lo último que se supo. Si no hay nada (primera vez) o es viejo, lanza el
//!   sondeo en un hilo aparte y lo dice en la propia respuesta (`status: "probing"`, `refreshing: true`).
//! * **Un solo sondeo a la vez** y **sin tener el registro tomado** mientras una CLI contesta: otro lector no espera.
//! * **`generation` sube solo si algo cambió** (una matriz, un entorno, una versión): el cliente detecta el cambio sin reiniciar.
//!
//! La lectura no tiene secretos (versiones, estados, bloqueos de entorno por código) y es de solo lectura: no hay ninguna acción.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

#[cfg(not(test))]
use super::adapter::{ClaudeAdapter, ClaudeConfig, CodexAdapter, CodexConfig};
use super::adapter::{AdapterRegistry, ProviderAdapter};
use super::events::{Actor, MutationContext};
use super::state::now_ms;
use super::{Caller, Core};

/// Lo sabido se considera fresco este tiempo; pasado, la siguiente lectura lanza un sondeo.
const FRESH: Duration = Duration::from_secs(60);
/// `refresh: true` fuerza un sondeo, pero no más de uno cada tanto: un cliente no puede martillear las CLIs.
const MIN_FORCED_GAP: Duration = Duration::from_secs(5);
const PARAMS: [&str; 1] = ["refresh"];

type Builder = Box<dyn Fn() -> Vec<Arc<dyn ProviderAdapter>> + Send + Sync>;

struct Live {
    registry: AdapterRegistry,
    /// Ya se hizo el primer sondeo y los adapters están registrados.
    built: bool,
    /// Hay un sondeo en curso.
    working: bool,
    done_at: Option<Instant>,
    done_at_ms: Option<i64>,
    forced_at: Option<Instant>,
}

pub(super) struct LiveRegistry {
    builder: Builder,
    fresh: Duration,
    cell: Mutex<Live>,
}

/// Los proveedores del producto, con su configuración por defecto.
#[cfg(not(test))]
fn production_adapters() -> Vec<Arc<dyn ProviderAdapter>> {
    vec![Arc::new(ClaudeAdapter::new(ClaudeConfig::default())), Arc::new(CodexAdapter::new(CodexConfig::default()))]
}

/// En pruebas, ningún `Core` lanza una CLI real: dos proveedores falsos, uno completo y otro sin `resume`.
#[cfg(test)]
fn production_adapters() -> Vec<Arc<dyn ProviderAdapter>> {
    use super::adapter::fake::FakeAdapter;
    use super::adapter::{Capability, CapabilityMatrix, CapabilityState, ProbeResult};
    let sin_resume = ProbeResult::ready(Some("0.0.0-fake"), CapabilityMatrix::all_available().with(Capability::Resume, CapabilityState::Unsupported));
    vec![Arc::new(FakeAdapter::full("claude")), Arc::new(FakeAdapter::with_probe("codex", sin_resume))]
}

/// Deja el sondeo como terminado aunque el hilo muera: si no, `working` quedaría puesto y nadie volvería a sondear.
struct Finish<'a>(&'a LiveRegistry);

impl Drop for Finish<'_> {
    fn drop(&mut self) {
        let mut s = self.0.live();
        s.working = false;
        s.done_at = Some(Instant::now());
        s.done_at_ms = Some(now_ms() as i64);
    }
}

impl LiveRegistry {
    pub(super) fn production() -> Arc<LiveRegistry> {
        LiveRegistry::with_builder(Box::new(production_adapters), FRESH)
    }

    /// Con los adapters que diga `builder` (las pruebas usan falsos) y el plazo de frescura dado.
    pub(super) fn with_builder(builder: Builder, fresh: Duration) -> Arc<LiveRegistry> {
        Arc::new(LiveRegistry {
            builder,
            fresh,
            cell: Mutex::new(Live { registry: AdapterRegistry::new(), built: false, working: false, done_at: None, done_at_ms: None, forced_at: None }),
        })
    }

    fn live(&self) -> std::sync::MutexGuard<'_, Live> {
        self.cell.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Lo último que se supo, AHORA. Si falta o es viejo (o se fuerza), lanza un sondeo en segundo plano. Nunca espera a una CLI.
    pub(super) fn snapshot(this: &Arc<LiveRegistry>, force: bool) -> Value {
        let mut s = this.live();
        let stale = s.done_at.is_none_or(|t| t.elapsed() >= this.fresh);
        let forced = force && s.forced_at.is_none_or(|t| t.elapsed() >= MIN_FORCED_GAP);
        if !s.working && (!s.built || stale || forced) {
            s.working = true;
            if forced {
                s.forced_at = Some(Instant::now());
            }
            let me = Arc::clone(this);
            // Si no se pudo crear el hilo, no se queda `working` para siempre.
            if std::thread::Builder::new().name("provider-capabilities".into()).spawn(move || me.probe_all()).is_err() {
                s.working = false;
            }
        }
        let mut out = serde_json::to_value(s.registry.snapshot()).unwrap_or_else(|_| json!({}));
        if let Some(o) = out.as_object_mut() {
            o.insert("status".into(), json!(if s.built { "ready" } else { "probing" }));
            o.insert("refreshing".into(), json!(s.working));
            o.insert("checked_at_ms".into(), json!(s.done_at_ms));
        }
        out
    }

    /// El sondeo, SIN tener el registro tomado mientras las CLIs contestan. Síncrono: lo llama el hilo y las pruebas.
    pub(super) fn probe_all(&self) {
        let _finish = Finish(self);
        let built = self.live().built;
        if !built {
            let adapters = (self.builder)();
            let probed: Vec<_> = adapters.into_iter().map(|a| (a.probe(), a)).collect();
            let mut s = self.live();
            for (probe, adapter) in probed {
                // Un adapter con id inválido o repetido se descarta: no tumba a los demás.
                let _ = s.registry.register_probed(adapter, probe);
            }
            s.built = true;
            return;
        }
        let adapters = self.live().registry.adapters();
        let probed: Vec<_> = adapters.into_iter().map(|a| (a.id().to_string(), a.probe())).collect();
        let mut s = self.live();
        for (id, probe) in probed {
            let _ = s.registry.apply_probe(&id, probe);
        }
    }

    /// Los proveedores para el servicio de uso (LXO-206), o `None` si el primer sondeo todavía no terminó. No sondea ni espera.
    pub(super) fn usage_targets(&self) -> Option<Vec<super::adapter::UsageTarget>> {
        let s = self.live();
        s.built.then(|| s.registry.usage_targets())
    }

    /// Para las pruebas: espera a que no haya un sondeo en curso.
    #[cfg(test)]
    pub(super) fn wait_idle(&self) {
        let end = Instant::now() + Duration::from_secs(10);
        while self.live().working && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

fn invalid(message: impl Into<String>) -> String {
    format!("provider_capabilities_invalid_request: {}", message.into())
}

/// Solo una persona autenticada, como el resto de lecturas del ADE.
fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    let context = context.ok_or_else(|| "provider_capabilities_auth_required: la lectura requiere un cliente autenticado".to_string())?;
    match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("provider_capabilities_auth_required: solo una Person autenticada puede leer las capabilities".into()),
    }
}

/// `provider_capabilities` · `{ refresh?: bool }`. Ver el contrato en `docs/core/QUERIES.md`.
pub(super) fn query(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let obj = match args {
        Value::Null => &empty,
        Value::Object(o) => o,
        _ => return Err(invalid("los argumentos son un objeto")),
    };
    if let Some(k) = obj.keys().find(|k| !PARAMS.contains(&k.as_str())) {
        return Err(invalid(format!("parámetro desconocido: {k}")));
    }
    let force = match obj.get("refresh") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(invalid("refresh es un booleano")),
    };
    Ok(LiveRegistry::snapshot(&core.provider_registry, force))
}
