//! Query `usage_report` (LXO-206): el uso y los límites de cada proveedor, para la vista de Usage. Contrato: `docs/core/QUERIES.md`
//! § usage_report; qué es cada campo y por qué no hay totales: `docs/core/ADAPTERS.md` § Usage.
//!
//! # Por qué es viva y no espera
//! Consultar el uso de un proveedor es lanzar su CLI (`claude /usage` tarda varios segundos; Codex abre su `app-server`) y
//! [`UsageService::report`] bloquea hasta que contestan o vence su tope (15 s, 30 s para Claude). Una lectura de la interfaz no
//! puede esperar eso. Por eso, como `provider_capabilities`:
//!
//! * **La query nunca consulta.** Devuelve al instante el último informe y, si falta, es viejo (15 s) o se fuerza, lanza la
//!   consulta en un hilo aparte (`status: "loading"` mientras no hay ninguno, `refreshing: true` mientras corre).
//! * **Un solo vuelo a la vez.** Y la caché del propio servicio (TTL 5 min, backoff 30 s tras un fallo, margen de 5 s para el
//!   refresco manual, un vuelo por proveedor) sigue mandando: repetir la lectura no martillea a los proveedores.
//! * **Un fallo de uso no es un fallo del proveedor ni de un Attempt.** El informe lo dice (`unknown`/`stale` con su error) y
//!   nada más cambia.
//!
//! No sale ninguna credencial ni identificador de cuenta: la cuenta es una huella de 8 hex (`account_fingerprint`) y los textos
//! de error pasan por la redacción del contrato de adapters. Solo lectura y solo de una Person.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::adapter::{Refresh, UsageReport, UsageService, UsageTarget};
use super::events::{Actor, MutationContext};
use super::provider_registry::LiveRegistry;
use super::{Caller, Core};

/// Un informe se considera reciente este tiempo: pasado, la siguiente lectura pide al servicio que lo revise (que, con su
/// caché de 5 min, casi siempre contesta sin lanzar ninguna CLI).
const FRESH: Duration = Duration::from_secs(15);
const PARAMS: [&str; 1] = ["refresh"];

type Targets = Box<dyn Fn() -> Option<Vec<UsageTarget>> + Send + Sync>;

struct Live {
    last: Option<UsageReport>,
    working: bool,
}

pub(super) struct LiveUsage {
    service: UsageService,
    targets: Targets,
    fresh: Duration,
    cell: Mutex<Live>,
    done_at: Mutex<Option<Instant>>,
}

/// Deja el vuelo como terminado aunque el hilo muera: si no, `working` quedaría puesto y nadie volvería a consultar.
struct Finish<'a>(&'a LiveUsage);

impl Drop for Finish<'_> {
    fn drop(&mut self) {
        self.0.live().working = false;
        *self.0.done_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    }
}

impl LiveUsage {
    /// Sobre los proveedores del registro vivo del Core.
    pub(super) fn over(registry: &Arc<LiveRegistry>) -> Arc<LiveUsage> {
        let registry = Arc::clone(registry);
        LiveUsage::with_targets(UsageService::new(Default::default()), Box::new(move || registry.usage_targets()), FRESH)
    }

    /// Con el servicio y los proveedores que se den (las pruebas usan adapters y relojes falsos).
    pub(super) fn with_targets(service: UsageService, targets: Targets, fresh: Duration) -> Arc<LiveUsage> {
        Arc::new(LiveUsage { service, targets, fresh, cell: Mutex::new(Live { last: None, working: false }), done_at: Mutex::new(None) })
    }

    fn live(&self) -> std::sync::MutexGuard<'_, Live> {
        self.cell.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// El último informe, AHORA. Si falta, es viejo o se fuerza, lanza una consulta en segundo plano. Nunca espera a una CLI.
    pub(super) fn snapshot(this: &Arc<LiveUsage>, force: bool) -> Value {
        let mut s = this.live();
        let stale = this.done_at.lock().unwrap_or_else(|e| e.into_inner()).is_none_or(|t| t.elapsed() >= this.fresh);
        if !s.working && (s.last.is_none() || stale || force) {
            s.working = true;
            let me = Arc::clone(this);
            if std::thread::Builder::new().name("usage-report".into()).spawn(move || me.consult(force)).is_err() {
                s.working = false;
            }
        }
        json!({
            "v": 1,
            "status": if s.last.is_some() { "ready" } else { "loading" },
            "refreshing": s.working,
            "report": s.last.as_ref().map(|r| serde_json::to_value(r).unwrap_or(Value::Null)),
        })
    }

    /// La consulta, SIN tener el estado tomado mientras las CLIs contestan. Síncrona: la llama el hilo y las pruebas.
    pub(super) fn consult(&self, force: bool) {
        let _finish = Finish(self);
        // Sin proveedores registrados todavía (el registro sigue sondeando): no hay nada que consultar, y no cuenta como informe.
        let Some(targets) = (self.targets)() else { return };
        let report = self.service.report(&targets, if force { Refresh::Force } else { Refresh::IfStale });
        self.live().last = Some(report);
    }

    /// Para las pruebas: espera a que no haya una consulta en curso.
    #[cfg(test)]
    pub(super) fn wait_idle(&self) {
        let end = Instant::now() + Duration::from_secs(10);
        while self.live().working && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

fn invalid(message: impl Into<String>) -> String {
    format!("usage_report_invalid_request: {}", message.into())
}

/// Solo una persona autenticada, como el resto de lecturas del ADE: la cuota es de su cuenta.
fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    let context = context.ok_or_else(|| "usage_report_auth_required: la lectura requiere un cliente autenticado".to_string())?;
    match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("usage_report_auth_required: solo una Person autenticada puede leer el uso".into()),
    }
}

/// `usage_report` · `{ refresh?: bool }`. Ver el contrato en `docs/core/QUERIES.md`.
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
    // Esta lectura es la primera que necesita los proveedores: asegura que el registro vivo ya está sondeando.
    let _ = LiveRegistry::snapshot(&core.provider_registry, false);
    Ok(LiveUsage::snapshot(&core.usage_live, force))
}
