//! Policy efectiva de autonomía (LXO-209). Contrato: `docs/core/POLICY.md`.
//!
//! La policy decide qué Commands puede ejecutar cada actor y cuáles piden confirmación, elevación o están prohibidos. El Core es la
//! ÚNICA autoridad: la interfaz y el CLI muestran y piden, nunca otorgan.
//!
//! ```text
//!   nivel efectivo = el MÁS RESTRICTIVO de  [ base del actor · global · project · attempt ]  y nunca por debajo del piso de la categoría
//!   restrictivo → allow < confirm < elevated < deny
//! ```
//!
//! * **Base por actor** (código, no editable): una Person de Desktop tiene lo que ya tenía; el CLI solo puede pedir un `start`
//!   (que sigue necesitando la aprobación de Desktop); Mobile, automatización y los agentes no tienen NADA de estas categorías.
//! * **Overrides** (SQLite, `policy_overrides`): los fija una Person de Desktop. El global se puede aflojar (con confirmación aparte);
//!   `project` y `attempt` solo pueden ENDURECER respecto al ámbito de arriba, así que un override más cercano nunca da más permiso.
//! * **Pisos** (código): `start`, `review`, `integrate`, `cleanup` y `provider_permissions` nunca bajan de `confirm`. Es lo que ya exigían
//!   (aprobación inicial, `confirm: true`); una policy no los exime.
//! * **Se revalida en CADA Command** (`gate`), leyendo el almacén en ese instante: una foto que la interfaz vio hace un minuto no autoriza nada.
//!   El actor sale de la credencial AUTENTICADA (superficie y principal), nunca de lo que el cliente afirme.
//! * `confirm` = el Command debe traer `confirm: true` (salvo `start`, cuyo `confirm` es la aprobación inicial de Desktop).
//!   `elevated` = exige una confirmación FUERA DE BANDA que aún no existe: hoy se rechaza con un código propio. `deny` = nadie.
//! * Cambiar la policy deja un Event `policy.changed` y no reescribe la historia.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::store::{AuthenticatedClient, ClientPrincipal, ClientSurface, PolicyChange, PolicyOverrideRow, PolicySnapshot, PolicyWrite};

use super::attempt_ops::{policy_changed_fact, PolicyDirection};
use super::events::{Actor, MutationContext};
use super::mutation::Health;
use super::provider_requests::RequestKind;
use super::state::now_ms;
use super::Core;

/// Qué tan restrictivo es un nivel: el orden de las variantes ES el orden de restricción.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(super) enum Level {
    Allow,
    Confirm,
    Elevated,
    Deny,
}

pub(super) const LEVELS: [Level; 4] = [Level::Allow, Level::Confirm, Level::Elevated, Level::Deny];

impl Level {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Level::Allow => "allow",
            Level::Confirm => "confirm",
            Level::Elevated => "elevated",
            Level::Deny => "deny",
        }
    }

    pub(super) fn parse(s: &str) -> Option<Level> {
        LEVELS.into_iter().find(|l| l.as_str() == s)
    }
}

/// Un nivel guardado que no se entiende es lo más restrictivo: fallar cerrado.
fn stored(level: &str) -> Level {
    Level::parse(level).unwrap_or(Level::Deny)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum Category {
    Start,
    Answer,
    Queue,
    Steer,
    Stop,
    Fork,
    Review,
    Integrate,
    Cleanup,
    ProviderPermissions,
}

pub(super) const CATEGORIES: [Category; 10] = [
    Category::Start,
    Category::Answer,
    Category::Queue,
    Category::Steer,
    Category::Stop,
    Category::Fork,
    Category::Review,
    Category::Integrate,
    Category::Cleanup,
    Category::ProviderPermissions,
];

impl Category {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Category::Start => "start",
            Category::Answer => "answer",
            Category::Queue => "queue",
            Category::Steer => "steer",
            Category::Stop => "stop",
            Category::Fork => "fork",
            Category::Review => "review",
            Category::Integrate => "integrate",
            Category::Cleanup => "cleanup",
            Category::ProviderPermissions => "provider_permissions",
        }
    }

    pub(super) fn parse(s: &str) -> Option<Category> {
        CATEGORIES.into_iter().find(|c| c.as_str() == s)
    }

    /// El nivel por debajo del cual la categoría no puede quedar, pida lo que pida una policy.
    pub(super) fn floor(self) -> Level {
        match self {
            Category::Start | Category::Review | Category::Integrate | Category::Cleanup | Category::ProviderPermissions => Level::Confirm,
            Category::Answer | Category::Queue | Category::Steer | Category::Stop | Category::Fork => Level::Allow,
        }
    }

    /// ¿Algún Command aplica ya esta categoría? Desde LXO-247 las diez las aplica algún Command (`attempt_answer` gobierna `answer` y
    /// `provider_permissions`). El campo se conserva en el contrato: si una categoría futura se declara antes de tener punto de
    /// aplicación, la interfaz lo dice en vez de aparentar una protección que no existe.
    pub(super) fn enforced(self) -> bool {
        true
    }
}

/// Quién actúa, según la credencial AUTENTICADA (superficie y principal). Un cliente no elige su clase: la deduce el Core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum ActorClass {
    DesktopPerson,
    CliPerson,
    MobilePerson,
    Automation,
    Agent,
    Core,
}

pub(super) const ACTOR_CLASSES: [ActorClass; 6] =
    [ActorClass::DesktopPerson, ActorClass::CliPerson, ActorClass::MobilePerson, ActorClass::Automation, ActorClass::Agent, ActorClass::Core];

impl ActorClass {
    pub(super) fn of(client: &AuthenticatedClient) -> ActorClass {
        match (client.identity().principal(), client.identity().surface()) {
            (ClientPrincipal::Agent(_), _) => ActorClass::Agent,
            (ClientPrincipal::System, _) => ActorClass::Core,
            (ClientPrincipal::Person(_), ClientSurface::Desktop) => ActorClass::DesktopPerson,
            (ClientPrincipal::Person(_), ClientSurface::Cli) => ActorClass::CliPerson,
            (ClientPrincipal::Person(_), ClientSurface::Mobile) => ActorClass::MobilePerson,
            (ClientPrincipal::Person(_), ClientSurface::Automation | ClientSurface::Core) => ActorClass::Automation,
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            ActorClass::DesktopPerson => "desktop_person",
            ActorClass::CliPerson => "cli_person",
            ActorClass::MobilePerson => "mobile_person",
            ActorClass::Automation => "automation",
            ActorClass::Agent => "agent",
            ActorClass::Core => "core",
        }
    }
}

/// La base de cada actor para cada categoría. Es código: ninguna fila ni flag la cambia.
pub(super) fn baseline(actor: ActorClass, category: Category) -> Level {
    match actor {
        // Lo que ya tenía: lo que decide o destruye pide confirmación; instruir al propio Attempt no.
        ActorClass::DesktopPerson => category.floor(),
        // El CLI puede PEDIR un Attempt (queda pendiente de la aprobación de Desktop); nada más de esto.
        ActorClass::CliPerson if category == Category::Start => Level::Confirm,
        // El Core se gobierna a sí mismo: la policy rige las peticiones de actores, no su trabajo interno.
        ActorClass::Core => Level::Allow,
        // Mobile, automatización y agentes: nada de estas categorías hasta que una fase lo decida (y con confirmación fuera de banda).
        _ => Level::Deny,
    }
}

/// De qué capa viene el nivel efectivo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Source {
    Baseline,
    Global,
    Project,
    Attempt,
    Floor,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Baseline => "baseline",
            Source::Global => "global",
            Source::Project => "project",
            Source::Attempt => "attempt",
            Source::Floor => "floor",
        }
    }

    /// Código estable para máquinas: de dónde sale el nivel.
    fn code(self, actor: ActorClass) -> &'static str {
        match self {
            Source::Baseline if actor == ActorClass::DesktopPerson => "baseline_default",
            Source::Baseline => "baseline_actor",
            Source::Global => "override_global",
            Source::Project => "override_project",
            Source::Attempt => "override_attempt",
            Source::Floor => "safety_floor",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Layers {
    pub baseline: Level,
    pub global: Option<Level>,
    pub project: Option<Level>,
    pub attempt: Option<Level>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Resolved {
    pub category: Category,
    pub level: Level,
    pub source: Source,
    pub layers: Layers,
}

fn layer_of(snapshot: &PolicySnapshot, kind: &str, id: &str, category: Category) -> Option<Level> {
    snapshot.level_of(kind, id, category.as_str()).map(stored)
}

/// La policy efectiva de `actor` para `category` en el contexto (`project`, `attempt`) dado. Función pura sobre una foto del almacén.
pub(super) fn resolve(snapshot: &PolicySnapshot, actor: ActorClass, category: Category, project: Option<&str>, attempt: Option<&str>) -> Resolved {
    let layers = Layers {
        baseline: baseline(actor, category),
        global: layer_of(snapshot, "global", "", category),
        project: project.and_then(|p| layer_of(snapshot, "project", p, category)),
        attempt: attempt.and_then(|a| layer_of(snapshot, "attempt", a, category)),
    };
    let level = [Some(layers.baseline), layers.global, layers.project, layers.attempt].into_iter().flatten().max().unwrap_or(layers.baseline);
    // El origen es la capa MÁS CERCANA que alcanza ese nivel: ante un empate manda lo más específico.
    let source = if layers.attempt == Some(level) {
        Source::Attempt
    } else if layers.project == Some(level) {
        Source::Project
    } else if layers.global == Some(level) {
        Source::Global
    } else {
        Source::Baseline
    };
    // El Core no se gobierna con pisos: la policy rige a los actores externos.
    if actor != ActorClass::Core && level < category.floor() {
        return Resolved { category, level: category.floor(), source: Source::Floor, layers };
    }
    Resolved { category, level, source, layers }
}

// ── Escritura: qué cambios son válidos ──────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ScopeKind {
    Global,
    Project,
    Attempt,
}

impl ScopeKind {
    fn as_str(&self) -> &'static str {
        match self {
            ScopeKind::Global => "global",
            ScopeKind::Project => "project",
            ScopeKind::Attempt => "attempt",
        }
    }
}

/// Un ámbito ya validado: el global no lleva id; project y attempt sí. `project` es el Project del Attempt (para evaluar la cadena).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Scope {
    pub kind: ScopeKind,
    pub id: Option<String>,
    pub project: Option<String>,
}

impl Scope {
    fn key(&self) -> (&'static str, String) {
        (self.kind.as_str(), self.id.clone().unwrap_or_default())
    }

    /// Contexto (`project`, `attempt`) con el que se evalúa la cadena de este ámbito.
    fn chain(&self) -> (Option<&str>, Option<&str>) {
        match self.kind {
            ScopeKind::Global => (None, None),
            ScopeKind::Project => (self.id.as_deref(), None),
            ScopeKind::Attempt => (self.project.as_deref(), self.id.as_deref()),
        }
    }
}

/// Por qué se rechaza un cambio (código estable + texto).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Rejection {
    pub code: &'static str,
    pub message: String,
}

impl Rejection {
    fn new(code: &'static str, message: impl Into<String>) -> Rejection {
        Rejection { code, message: message.into() }
    }
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct WriteCheck {
    pub direction: PolicyDirection,
    /// Aflojar la restricción efectiva exige `confirm: true` del cliente.
    pub needs_confirm: bool,
    pub before: Level,
    pub after: Level,
}

/// La foto como quedaría tras el cambio, sin tocar el almacén.
fn with_write(snapshot: &PolicySnapshot, write: &PolicyWrite) -> PolicySnapshot {
    let mut next = snapshot.clone();
    let (kind, id, category) = match write {
        PolicyWrite::Set { scope_kind, scope_id, category, .. } | PolicyWrite::Reset { scope_kind, scope_id, category } => (scope_kind, scope_id, category),
    };
    next.rows.retain(|r| !(&r.scope_kind == kind && &r.scope_id == id && &r.category == category));
    if let PolicyWrite::Set { level, .. } = write {
        next.rows.push(PolicyOverrideRow { scope_kind: kind.clone(), scope_id: id.clone(), category: category.clone(), level: level.clone(), set_by: String::new(), set_at: 0, revision: 0 });
    }
    next
}

/// Qué pasaría al fijar `to` (o volver a heredar si es `None`) en `scope`. Las reglas son del Core y las mismas para quien guarda y para quien
/// previsualiza. La evalúa una Person de Desktop (es la única que edita).
pub(super) fn check_write(snapshot: &PolicySnapshot, scope: &Scope, category: Category, to: Option<Level>) -> Result<(WriteCheck, PolicyWrite), Rejection> {
    let (kind, id) = scope.key();
    let write = match to {
        Some(level) => PolicyWrite::Set { scope_kind: kind.into(), scope_id: id, category: category.as_str().into(), level: level.as_str().into() },
        None => PolicyWrite::Reset { scope_kind: kind.into(), scope_id: id, category: category.as_str().into() },
    };
    let editor = ActorClass::DesktopPerson;
    let (project, attempt) = scope.chain();
    if let Some(level) = to {
        if level < category.floor() {
            return Err(Rejection::new(
                "policy_below_floor",
                format!("«{}» no puede quedar por debajo de «{}»: ya exige esa confirmación y una policy no la exime", category.as_str(), category.floor().as_str()),
            ));
        }
        if scope.kind != ScopeKind::Global {
            // Lo que heredaría este ámbito si no tuviera override: el nivel de arriba. Un ámbito más cercano solo puede endurecerlo.
            let without = with_write(snapshot, &PolicyWrite::Reset { scope_kind: kind.into(), scope_id: scope.key().1, category: category.as_str().into() });
            let parent = resolve(&without, editor, category, project, attempt).level;
            if level < parent {
                return Err(Rejection::new(
                    "policy_cannot_loosen",
                    format!("un override de {} solo puede endurecer: «{}» ya está en «{}» más arriba", kind, category.as_str(), parent.as_str()),
                ));
            }
        }
    }
    let before = resolve(snapshot, editor, category, project, attempt).level;
    let after = resolve(&with_write(snapshot, &write), editor, category, project, attempt).level;
    let direction = match to {
        None => PolicyDirection::Reset,
        Some(_) if after > before => PolicyDirection::Tighten,
        Some(_) if after < before => PolicyDirection::Loosen,
        Some(_) => PolicyDirection::Same,
    };
    Ok((WriteCheck { direction, needs_confirm: after < before, before, after }, write))
}

// ── Aplicar la policy a un Command (revalidación en cada ejecución) ─────────────────────────────────────────────────────────────────

/// A qué recursos apunta un Command, tal como los nombra su propia entrada.
#[derive(Debug, Default)]
struct Hint {
    project_id: Option<String>,
    task_id: Option<String>,
    attempt_id: Option<String>,
}

fn text(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty() && s.chars().count() <= 200).map(str::to_string)
}

/// La categoría que gobierna un Command y los recursos que nombra. Lo que no está aquí no pasa por la policy de autonomía.
///
/// `attempt_queue_cancel` NO se gobierna: cancelar una instrucción pendiente deshace, no ejecuta. Las lecturas, el estado y la aprobación
/// inicial (`attempt_approve`/`attempt_reject`, parte del propio `start`) tampoco.
fn classify(cmd: &str, args: &Value) -> Option<(Category, Hint)> {
    let attempt = |key: &str| Hint { attempt_id: text(args, key), ..Hint::default() };
    let task = || Hint { task_id: text(args, "task_id"), ..Hint::default() };
    Some(match cmd {
        // Solo el que arranca un Attempt: una Task sin `attempt` no ejecuta nada.
        "task_create" if args.get("attempt").is_some_and(|a| !a.is_null()) => (Category::Start, Hint { project_id: text(args, "project_id"), ..Hint::default() }),
        "attempt_retry" | "attempt_resume" => (Category::Start, task()),
        "attempt_queue" => (Category::Queue, attempt("attempt_id")),
        "attempt_steer" => (Category::Steer, attempt("attempt_id")),
        "attempt_stop_and_send" => (Category::Stop, attempt("attempt_id")),
        "attempt_fork" | "task_race" => (Category::Fork, attempt("source_attempt_id")),
        // Cancelar lo que queda de un Race detiene ejecuciones: es la categoría `stop`.
        "task_race_cancel" => (Category::Stop, Hint::default()),
        "attempt_review" => (Category::Review, attempt("attempt_id")),
        "attempt_integrate" => (Category::Integrate, attempt("attempt_id")),
        "resource_clean" | "resource_delete_worktree" => (Category::Cleanup, task()),
        _ => return None,
    })
}

/// `attempt_answer` (LXO-247) se gobierna según LO QUE SE RESPONDE: PERMITIR un permiso del proveedor es `provider_permissions` (piso
/// `confirm`: exige `confirm: true`); denegarlo o contestar una pregunta es `answer`. El tipo sale de la petición VIVA del Attempt, no de
/// lo que el cliente afirme. Si la petición ya no está (una repetición, una desconocida) manda `answer`, lo menos restrictivo: ese
/// Command no entrega nada al proveedor y el runtime responde `Replayed` o `request_unknown`.
fn classify_answer(core: &Core, args: &Value) -> (Category, Hint) {
    let attempt_id = text(args, "attempt_id");
    let allows = text(args, "answer").is_some_and(|a| a.eq_ignore_ascii_case("allow"));
    let permission = allows
        && attempt_id
            .as_deref()
            .and_then(task_of_attempt)
            .zip(text(args, "request_id"))
            .and_then(|(task, request)| {
                let awaiting = core.awaiting_of(task)?;
                let kind = awaiting.lock().pending().into_iter().find(|r| r.id == request).map(|r| r.kind);
                kind
            })
            == Some(RequestKind::Permission);
    (if permission { Category::ProviderPermissions } else { Category::Answer }, Hint { attempt_id, ..Hint::default() })
}

/// SOLO pruebas: la categoría que gobierna un Command, como texto.
#[cfg(test)]
pub(super) fn classify_for_tests(cmd: &str, args: &Value) -> Option<&'static str> {
    classify(cmd, args).map(|(category, _)| category.as_str())
}

/// `<task>-a<n>` → `<task>`.
fn task_of_attempt(attempt_id: &str) -> Option<&str> {
    attempt_id.rsplit_once("-a").filter(|(task, n)| !task.is_empty() && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).map(|(task, _)| task)
}

impl Core {
    /// El Project de una Task del runtime, si se conoce.
    fn policy_project_of_task(&self, task_id: &str) -> Option<String> {
        self.lock().tasks.get(task_id).and_then(|t| t.project_id.clone())
    }

    fn policy_context(&self, hint: &Hint) -> (Option<String>, Option<String>) {
        let task = hint.task_id.as_deref().or_else(|| hint.attempt_id.as_deref().and_then(task_of_attempt));
        let project = hint.project_id.clone().or_else(|| task.and_then(|t| self.policy_project_of_task(t)));
        (project, hint.attempt_id.clone())
    }
}

/// ¿El Command trae la confirmación explícita de la persona?
fn confirmed(args: &Value) -> bool {
    args.get("confirm").and_then(Value::as_bool) == Some(true)
}

/// Decide si `class` puede ejecutar `cmd` AHORA. Se llama en cada Command, antes de despachar, con la policy leída en ese instante:
/// una foto vieja de la interfaz no autoriza nada. Falla cerrado si no puede leer la policy.
pub(super) fn gate(core: &Core, class: ActorClass, cmd: &str, args: &Value) -> Result<(), String> {
    let classified = if cmd == "attempt_answer" { Some(classify_answer(core, args)) } else { classify(cmd, args) };
    let Some((category, hint)) = classified else { return Ok(()) };
    if class == ActorClass::Core {
        return Ok(());
    }
    let snapshot = core.policy_snapshot().map_err(|e| format!("policy_unavailable: {e}. No se ejecuta «{}» sin poder comprobar la policy", category.as_str()))?;
    let (project, attempt) = core.policy_context(&hint);
    let resolved = resolve(&snapshot, class, category, project.as_deref(), attempt.as_deref());
    let why = format!("«{}» para {} (nivel «{}», origen {})", category.as_str(), class.as_str(), resolved.level.as_str(), resolved.source.as_str());
    match resolved.level {
        Level::Allow => Ok(()),
        // `start` pide confirmación y ya la tiene: el Attempt nace pendiente de la aprobación de una Person de Desktop (LXO-141).
        Level::Confirm if category == Category::Start || confirmed(args) => Ok(()),
        Level::Confirm => Err(format!("policy_confirm_required: la policy pide confirmación explícita para {why}: repite con confirm: true")),
        Level::Elevated => Err(format!("policy_out_of_band_required: la policy exige confirmación fuera de banda para {why}, y todavía no hay un canal para darla")),
        Level::Deny => Err(format!("policy_denied: la policy niega {why}")),
    }
}

// ── Comandos propios: policy_effective · policy_set · policy_reset ──────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScopeInput {
    kind: String,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewInput {
    scope: ScopeInput,
    category: String,
    /// Ausente o `null`: volver a heredar.
    #[serde(default)]
    level: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EffectiveInput {
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    attempt_id: Option<String>,
    #[serde(default)]
    preview: Option<PreviewInput>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangeInput {
    scope: ScopeInput,
    category: String,
    #[serde(default)]
    level: Option<String>,
    expected_revision: i64,
    #[serde(default)]
    confirm: bool,
}

const INVALID: &str = "policy_invalid_request";

fn invalid(what: impl std::fmt::Display) -> String {
    format!("{INVALID}: {what}")
}

fn durable(value: &str, what: &str) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() || v.chars().count() > 200 {
        return Err(invalid(format!("{what} debe ser un ID durable")));
    }
    Ok(v.to_string())
}

impl Core {
    /// Valida un ámbito: el Project o el Attempt tienen que existir. Un id inventado nunca crea un override huérfano.
    fn policy_scope(&self, input: &ScopeInput) -> Result<Scope, String> {
        match input.kind.as_str() {
            "global" => {
                if input.id.as_deref().is_some_and(|id| !id.is_empty()) {
                    return Err(invalid("el ámbito global no lleva id"));
                }
                Ok(Scope { kind: ScopeKind::Global, id: None, project: None })
            }
            "project" => {
                let id = durable(input.id.as_deref().unwrap_or(""), "project")?;
                if !self.project_exists(&id)? {
                    return Err(format!("policy_not_found: el Project {id} no existe"));
                }
                Ok(Scope { kind: ScopeKind::Project, id: Some(id), project: None })
            }
            "attempt" => {
                let id = durable(input.id.as_deref().unwrap_or(""), "attempt")?;
                let row = self.attempt_row_for_resume(&id)?.ok_or_else(|| format!("policy_not_found: el Attempt {id} no existe"))?;
                let project = self.policy_project_of_task(&row.task_id);
                Ok(Scope { kind: ScopeKind::Attempt, id: Some(id), project })
            }
            other => Err(invalid(format!("ámbito «{other}» fuera del contrato (global, project o attempt)"))),
        }
    }
}

fn rows_json(snapshot: &PolicySnapshot, project: Option<&str>, attempt: Option<&str>) -> Vec<Value> {
    snapshot
        .rows
        .iter()
        .filter(|r| match r.scope_kind.as_str() {
            "global" => true,
            "project" => project == Some(r.scope_id.as_str()),
            "attempt" => attempt == Some(r.scope_id.as_str()),
            _ => false,
        })
        .map(|r| json!({"scope": {"kind": r.scope_kind, "id": if r.scope_id.is_empty() { Value::Null } else { Value::String(r.scope_id.clone()) }}, "category": r.category, "level": r.level, "set_by": r.set_by, "set_at": r.set_at, "revision": r.revision}))
        .collect()
}

fn level_or_null(level: Option<Level>) -> Value {
    level.map_or(Value::Null, |l| Value::String(l.as_str().into()))
}

fn categories_json(snapshot: &PolicySnapshot, class: ActorClass, project: Option<&str>, attempt: Option<&str>) -> Vec<Value> {
    CATEGORIES
        .into_iter()
        .map(|category| {
            let r = resolve(snapshot, class, category, project, attempt);
            json!({
                "category": category.as_str(),
                "level": r.level.as_str(),
                "source": r.source.as_str(),
                "reason": r.source.code(class),
                "layers": {"baseline": r.layers.baseline.as_str(), "global": level_or_null(r.layers.global), "project": level_or_null(r.layers.project), "attempt": level_or_null(r.layers.attempt)},
                "floor": if category.floor() > Level::Allow { Value::String(category.floor().as_str().into()) } else { Value::Null },
                "enforced": category.enforced(),
            })
        })
        .collect()
}

fn matrix_json() -> Value {
    let mut out = serde_json::Map::new();
    for actor in ACTOR_CLASSES {
        let row: serde_json::Map<String, Value> = CATEGORIES.into_iter().map(|c| (c.as_str().to_string(), Value::String(baseline(actor, c).as_str().into()))).collect();
        out.insert(actor.as_str().into(), Value::Object(row));
    }
    Value::Object(out)
}

fn direction_str(direction: PolicyDirection) -> &'static str {
    match direction {
        PolicyDirection::Tighten => "tighten",
        PolicyDirection::Loosen => "loosen",
        PolicyDirection::Same => "same",
        PolicyDirection::Reset => "reset",
    }
}

/// `policy_effective`: la policy efectiva DEL QUE PREGUNTA (su clase sale de su credencial), con el origen de cada nivel, y, si se pide, qué
/// pasaría al aplicar un cambio (`preview`), sin escribir nada. Solo lectura.
fn effective(core: &Core, class: ActorClass, args: &Value) -> Result<Value, String> {
    let input: EffectiveInput = serde_json::from_value(args.clone()).map_err(|_| invalid("solicitud de policy efectiva inválida"))?;
    let (mut project, mut attempt) = (input.project_id.as_deref().map(|p| durable(p, "project_id")).transpose()?, None);
    if let Some(a) = input.attempt_id.as_deref() {
        let a = durable(a, "attempt_id")?;
        let row = core.attempt_row_for_resume(&a)?.ok_or_else(|| format!("policy_not_found: el Attempt {a} no existe"))?;
        let of = core.policy_project_of_task(&row.task_id);
        if project.is_some() && of.is_some() && project != of {
            return Err(invalid("el Attempt no pertenece a ese Project"));
        }
        project = project.or(of);
        attempt = Some(a);
    }
    let snapshot = core.policy_snapshot()?;
    let mut body = json!({
        "v": 1,
        "revision": snapshot.revision,
        "actor": {"class": class.as_str(), "can_edit": class == ActorClass::DesktopPerson},
        "scope": {"project_id": project, "attempt_id": attempt},
        "levels": LEVELS.map(Level::as_str),
        "categories": categories_json(&snapshot, class, project.as_deref(), attempt.as_deref()),
        "overrides": rows_json(&snapshot, project.as_deref(), attempt.as_deref()),
        "baseline_matrix": matrix_json(),
    });
    if let Some(p) = &input.preview {
        let scope = core.policy_scope(&p.scope)?;
        let category = Category::parse(&p.category).ok_or_else(|| invalid(format!("categoría «{}» fuera del contrato", p.category)))?;
        let to = p.level.as_deref().map(|l| Level::parse(l).ok_or_else(|| invalid(format!("nivel «{l}» fuera del contrato")))).transpose()?;
        body["preview"] = match check_write(&snapshot, &scope, category, to) {
            Ok((check, write)) => json!({
                "valid": true,
                "direction": direction_str(check.direction),
                "needs_confirm": check.needs_confirm,
                "before": check.before.as_str(),
                "after": check.after.as_str(),
                "categories": categories_json(&with_write(&snapshot, &write), class, project.as_deref(), attempt.as_deref()),
            }),
            Err(r) => json!({"valid": false, "code": r.code, "message": r.message}),
        };
    }
    Ok(body)
}

/// `policy_set` / `policy_reset`: SOLO una Person de Desktop. Valida con las mismas reglas que la previsualización, exige la revisión que el
/// cliente leyó (`policy_stale` si ya cambió) y la confirmación cuando se afloja, y deja su Event `policy.changed` en la misma transacción.
fn change(core: &Core, class: ActorClass, ctx: &MutationContext, cmd: &str, args: &Value) -> Result<Value, String> {
    // Quién edita: lo dice la credencial autenticada, no el cliente. Una Person de CLI, Mobile o un agente nunca llega aquí (HumanDecision),
    // y aun así se comprueba: la defensa no depende de una sola capa.
    let person = match &ctx.actor {
        Actor::PersonId(id) if class == ActorClass::DesktopPerson && ctx.is_person_ui() => id.clone(),
        _ => return Err("policy_forbidden: solo una Person autenticada de Desktop puede cambiar la policy".into()),
    };
    let input: ChangeInput = serde_json::from_value(args.clone()).map_err(|_| invalid("solicitud de cambio de policy inválida"))?;
    let category = Category::parse(&input.category).ok_or_else(|| invalid(format!("categoría «{}» fuera del contrato", input.category)))?;
    let to = match (cmd, input.level.as_deref()) {
        ("policy_set", Some(l)) => Some(Level::parse(l).ok_or_else(|| invalid(format!("nivel «{l}» fuera del contrato")))?),
        ("policy_set", None) => return Err(invalid("policy_set exige `level`")),
        (_, None) => None,
        (_, Some(_)) => return Err(invalid("policy_reset no lleva `level`: vuelve a heredar")),
    };
    if input.expected_revision < 0 {
        return Err(invalid("expected_revision debe ser la revisión que leíste"));
    }
    match core.health() {
        Health::Normal => {}
        Health::DegradedReadOnly(why) => return Err(format!("policy_unavailable: el Core está en solo lectura ({why}): la policy no admite cambios hasta que se recupere el almacenamiento")),
    }
    let scope = core.policy_scope(&input.scope)?;
    let snapshot = core.policy_snapshot()?;
    if snapshot.revision != input.expected_revision {
        return Err(format!("policy_stale: la policy cambió desde que la leíste (revisión actual {}); recárgala antes de editar", snapshot.revision));
    }
    let (check, write) = check_write(&snapshot, &scope, category, to).map_err(|r| r.to_string())?;
    if check.needs_confirm && !input.confirm {
        return Err(format!(
            "policy_confirm_required: aflojar «{}» de «{}» a «{}» da más autonomía y exige confirmación explícita (confirm: true)",
            category.as_str(),
            check.before.as_str(),
            check.after.as_str()
        ));
    }
    let (kind, _) = scope.key();
    let project = match scope.kind {
        ScopeKind::Project => scope.id.clone(),
        ScopeKind::Attempt => scope.project.clone(),
        ScopeKind::Global => None,
    };
    let at = now_ms() as i64;
    let to_str = to.map(Level::as_str);
    let change = core.policy_apply(input.expected_revision, &write, &person, at, |previous, revision| {
        policy_changed_fact(kind, scope.id.as_deref(), project.as_deref(), category.as_str(), previous, to_str, check.direction, revision, ctx, at)
    })?;
    match change {
        PolicyChange::Changed { revision, previous } => Ok(json!({
            "status": "Changed",
            "revision": revision,
            "direction": direction_str(check.direction),
            "scope": {"kind": kind, "id": scope.id},
            "category": category.as_str(),
            "from": previous,
            "to": to_str,
        })),
        PolicyChange::Unchanged { revision } => Ok(json!({"status": "Unchanged", "revision": revision, "scope": {"kind": kind, "id": scope.id}, "category": category.as_str()})),
        PolicyChange::Stale { current } => Err(format!("policy_stale: la policy cambió desde que la leíste (revisión actual {current}); recárgala antes de editar")),
    }
}

/// Los Commands de la propia policy. `None` = no es uno de ellos.
pub(super) fn dispatch(core: &Core, class: ActorClass, ctx: &MutationContext, cmd: &str, args: &Value) -> Option<Result<Value, String>> {
    match cmd {
        "policy_effective" => Some(effective(core, class, args)),
        "policy_set" | "policy_reset" => Some(change(core, class, ctx, cmd, args)),
        _ => None,
    }
}
