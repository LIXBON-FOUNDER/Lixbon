//! `task_race`: lanzar N Forks comparables a la vez, con un `race_id` y una procedencia comunes (LXO-215, épica F5). Contrato: `docs/core/RACE.md`.
//!
//! Un Race es una operación EXPLÍCITA, no un Fork repetido a mano: la persona elige de 2 a 4 candidatos (proveedor, modelo, esfuerzo, rol) que
//! salen del MISMO Attempt origen y, si hay, del MISMO ContextPackage (verificado una vez contra el origen). Cada candidato es un Fork de
//! verdad (`fork_runtime`): su propia Task, su Attempt `pending_approval`, su rama y su worktree, con identidad e historia propias. Por eso
//! corren a la vez sin tocar «un solo Attempt activo por Task» (ATTEMPTS D19).
//!
//! ```text
//! task_race(source_attempt_id, candidates[2..4], package?)
//!   1. Person autenticada · lanzador · request_id · candidatos y paquete válidos     ← un candidato inválido rechaza TODO, no es un fallo parcial
//!   2. race_id = rc-<hash(identidad, request_id)>: el mismo reintento cae en el mismo Race; otra petición con la misma clave → request_conflict
//!   3. `race.requested` (idempotente)
//!   4. por cada candidato, en orden:  límite de Tasks activas + policy (`fork`)  →  Fork con la clave `<race_id>-c<i>`  →  `race.candidate_recorded`
//!        · un candidato que falla queda registrado con su código y NO deshace a los lanzados;
//!        · reintentar la misma petición no duplica a los ya creados (el ledger del Fork los devuelve `Replayed`) y reintenta los fallidos.
//! ```
//!
//! # Lo que NO hace
//! * **No elige ganador, no puntúa, no integra.** «Ganador» es una decisión posterior de la persona (Compare, Proof Pack, revisión).
//! * **No cancela a nadie porque otro termine.** Cancelar es `task_race_cancel`, explícito: un candidato o todos los que no han terminado.
//! * **No elige host ni estrategia de worktree.** Hoy hay un solo host y cada candidato recibe su worktree propio; el RPC ni siquiera acepta pedirlo.
//! * **No oculta lo fallido**: `task_race_status` devuelve todos los candidatos, también los que no se pudieron lanzar.

use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::attempt_retry_rpc::clean;
use super::event_kinds;
use super::events::MutationContext;
use super::fork_runtime::{checked_package, fork_gated, identity_scope, ForkInput};
use super::policy::{self, ActorClass};
use super::state::now_ms;
use super::Core;
use crate::store::ForkStrategy;

pub(crate) const MIN_CANDIDATES: usize = 2;
pub(crate) const MAX_CANDIDATES: usize = 4;
/// Tope de Tasks sin terminar (incluidas las que esperan aprobación) para lanzar otro candidato: lo que protege la máquina de un Race que
/// se suma a mucho trabajo en marcha. Se comprueba ANTES de cada lanzamiento.
pub(crate) const MAX_ACTIVE_TASKS: usize = 8;

const REQUEST_ID_MAX: usize = 64;
const TITLE_MAX: usize = 512;

/// Un Race a la vez dentro del Core: dos peticiones iguales a la vez no pueden registrar dos veces `race.requested` ni lanzar dos veces.
static RACE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CandidateInput {
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RaceInput {
    pub request_id: String,
    pub source_attempt_id: String,
    pub candidates: Vec<CandidateInput>,
    /// El ContextPackage común (JSON como texto) que la persona revisó. Sin él, todos arrancan limpios con el encargo de la Task.
    #[serde(default)]
    pub package: Option<String>,
    /// La confirmación que pide la policy cuando `fork` está en `confirm` (LXO-209). La lee la policy, no este Command.
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StatusInput {
    #[serde(default)]
    pub race_id: Option<String>,
    /// Alternativa a `race_id`: los Races que salieron de este Attempt.
    #[serde(default)]
    pub source_attempt_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CancelInput {
    pub race_id: String,
    /// Un candidato concreto. Sin él: todos los que no han terminado.
    #[serde(default)]
    pub attempt_id: Option<String>,
    #[serde(default)]
    pub confirm: bool,
}

fn sha(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn valid_key(value: &str) -> bool {
    !value.is_empty() && value.len() <= REQUEST_ID_MAX && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn valid_race_id(value: &str) -> bool {
    value.len() == 23 && value.starts_with("rc-") && value[3..].bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_provider(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// El código estable de un error de lanzamiento: el `codigo:` con que empiezan los errores del Core, o `launch_failed`.
fn code_of(error: &str) -> String {
    let head = error.split(':').next().unwrap_or("").trim();
    if !head.is_empty() && head.len() <= 64 && head.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') && error.contains(':') {
        head.to_string()
    } else {
        "launch_failed".to_string()
    }
}

fn person(context: &MutationContext, what: &str) -> Result<(), String> {
    identity_scope(context).map(|_| ()).map_err(|_| format!("{what} requiere una Person autenticada"))
}

/// Cuántas Tasks siguen sin terminar ahora mismo.
fn active_tasks(core: &Core) -> usize {
    core.lock().tasks.values().filter(|t| !t.status.is_final()).count()
}

fn fail<T>(e: impl std::fmt::Debug) -> Result<T, String> {
    Err(format!("No se pudo registrar el Race: {e:?}"))
}

pub(super) fn race(core: &Core, class: ActorClass, context: &MutationContext, input: &RaceInput) -> Result<Value, String> {
    // 1. Quién y qué pide. Todo lo que se pueda comprobar sin tocar nada se comprueba aquí: un candidato inválido rechaza el Race entero.
    let scope = identity_scope(context).map_err(|_| "lanzar un Race requiere una Person autenticada".to_string())?;
    if !valid_key(&input.request_id) {
        return Err("Falta una clave de idempotencia válida (request_id)".into());
    }
    let n = input.candidates.len();
    if !(MIN_CANDIDATES..=MAX_CANDIDATES).contains(&n) {
        return Err(format!("race_invalid_request: un Race lleva de {MIN_CANDIDATES} a {MAX_CANDIDATES} candidatos, no {n}"));
    }
    let mut specs = Vec::with_capacity(n);
    for (i, c) in input.candidates.iter().enumerate() {
        if c.provider.as_deref().is_some_and(|p| !valid_provider(p)) {
            return Err(format!("race_invalid_request: el candidato {} no tiene un provider válido", i + 1));
        }
        let model = clean("model", &c.model).map_err(|e| format!("race_invalid_request: candidato {}: {e}", i + 1))?;
        let effort = clean("effort", &c.effort).map_err(|e| format!("race_invalid_request: candidato {}: {e}", i + 1))?;
        let role = clean("role", &c.role).map_err(|e| format!("race_invalid_request: candidato {}: {e}", i + 1))?;
        if c.title.as_deref().is_some_and(|t| t.trim().is_empty() || t.chars().count() > TITLE_MAX || t.chars().any(char::is_control)) {
            return Err(format!("race_invalid_request: el candidato {} no tiene un title válido", i + 1));
        }
        specs.push((c.provider.clone(), model, effort, role, c.title.clone()));
    }
    if core.launcher().is_none() {
        return Err(super::fork_runtime::FORK_NOT_AVAILABLE.replace("hacer un Fork", "lanzar un Race"));
    }
    let (source_task, _) = input.source_attempt_id.rsplit_once("-a").ok_or("Falta un id de Attempt válido")?;
    let (project_id, source_title) = {
        let st = core.lock();
        let task = st.tasks.get(source_task).ok_or_else(|| format!("no existe la Task {source_task}"))?;
        (task.project_id.clone().filter(|p| !p.is_empty()).ok_or_else(|| "la Task origen no tiene Project: no hay desde dónde lanzar".to_string())?, task.title.clone())
    };
    core.attempt_row_for_resume(&input.source_attempt_id)?.ok_or_else(|| format!("no existe el Attempt {}", input.source_attempt_id))?;
    // El paquete común se verifica UNA vez contra el origen: todos los candidatos son comparables o ninguno.
    let package = input.package.as_deref().map(|raw| checked_package(raw, source_task, &input.source_attempt_id, &project_id)).transpose()?;
    let package_id = package.as_ref().map(|p| p.id().to_string());
    let strategy = if package.is_some() { ForkStrategy::ContextPackage } else { ForkStrategy::Clean };

    let digest = sha(&json!({"kind": "task.race", "source": input.source_attempt_id, "candidates": specs, "package_id": package_id}).to_string());
    let race_id = format!("rc-{}", &sha(&format!("{scope}\u{0}{}", input.request_id))[..20]);

    // Dos peticiones iguales a la vez no registran dos Races ni lanzan dos veces.
    let _one = RACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // 2. ¿Ya existía? La misma clave con otra petición es un conflicto, no un reintento.
    let known = core.race_events(&race_id)?;
    let requested = known.iter().find(|(k, _, _)| k == "race.requested");
    if let Some((_, payload, _)) = requested {
        let p: Value = serde_json::from_str(payload).map_err(|_| "un race.requested del log no se puede leer".to_string())?;
        if p["digest"].as_str() != Some(digest.as_str()) {
            return Err("request_conflict: esa clave ya se usó con otro Race: usa otra clave para otra petición".into());
        }
    } else {
        let draft = event_kinds::race_requested(&race_id, &input.source_attempt_id, source_task, n, strategy, package_id.as_deref(), &digest, Some(&project_id)).or_else(fail)?;
        core.record_facts(context, vec![draft]).map_err(|e| format!("No se pudo registrar el Race: {e:?}"))?;
    }

    // 3. Candidato a candidato. Un fallo se registra y se sigue: no deshace a los ya lanzados.
    let fork_args = json!({"source_attempt_id": input.source_attempt_id, "confirm": input.confirm});
    let mut replayed = 0usize;
    for (i, (provider, model, effort, role, title)) in specs.iter().enumerate() {
        let fork_input = ForkInput {
            request_id: format!("{race_id}-c{i}"),
            source_attempt_id: input.source_attempt_id.clone(),
            confirm: false,
            provider: provider.clone(),
            model: model.clone(),
            effort: effort.clone(),
            role: role.clone(),
            title: Some(title.clone().unwrap_or_else(|| format!("Race {}/{n} · {}", i + 1, source_title.chars().take(160).collect::<String>()))),
            package: input.package.clone(),
            race: Some((race_id.clone(), i as u32)),
        };
        // Límites y policy se validan ANTES de cada lanzamiento (no del Race entero), y solo si el candidato no es un replay.
        let before = || -> Result<(), String> {
            policy::gate(core, class, "attempt_fork", &fork_args)?;
            let active = active_tasks(core);
            if active >= MAX_ACTIVE_TASKS {
                return Err(format!("race_concurrency_limit: ya hay {active} Tasks sin terminar (el límite es {MAX_ACTIVE_TASKS}): termina o cancela alguna antes de lanzar otro candidato"));
            }
            Ok(())
        };
        let outcome = fork_gated(core, context, &fork_input, &before);
        let (task_id, attempt_id, code) = match &outcome {
            Ok(v) => {
                if v["status"] == "Replayed" {
                    replayed += 1;
                }
                (v["task_id"].as_str().map(str::to_string), v["attempt_id"].as_str().map(str::to_string), None)
            }
            Err(e) => (None, None, Some(code_of(e))),
        };
        let provider_name = provider.clone().unwrap_or_else(|| "origen".into());
        let draft = event_kinds::race_candidate_recorded(&race_id, i, &provider_name, model.as_deref(), task_id.as_deref(), attempt_id.as_deref(), code.as_deref(), Some(&project_id)).or_else(fail)?;
        core.record_facts(context, vec![draft]).map_err(|e| format!("No se pudo registrar el candidato {}: {e:?}", i + 1))?;
    }
    let mut status = status_of(core, &race_id)?;
    status["status"] = json!(if requested.is_some() { "Retried" } else { "Requested" });
    status["replayed"] = json!(replayed);
    Ok(status)
}

/// El estado del Race, plegando sus eventos. Lo lanzado y lo fallido salen de lo que se REGISTRÓ; el estado de cada Attempt, de ahora.
fn status_of(core: &Core, race_id: &str) -> Result<Value, String> {
    let events = core.race_events(race_id)?;
    let (_, requested, created_at) = events.iter().find(|(k, _, _)| k == "race.requested").ok_or_else(|| format!("race_not_found: no existe el Race {race_id}"))?;
    let req: Value = serde_json::from_str(requested).map_err(|_| "un race.requested del log no se puede leer".to_string())?;
    let wanted = req["candidates"].as_u64().unwrap_or(0) as usize;
    // El último hecho de cada índice gana: un candidato fallido que un reintento lanzó queda como lanzado.
    let mut latest: Vec<Option<Value>> = vec![None; wanted];
    for (kind, payload, _) in &events {
        if kind != "race.candidate_recorded" {
            continue;
        }
        let p: Value = serde_json::from_str(payload).map_err(|_| "un race.candidate_recorded del log no se puede leer".to_string())?;
        if let Some(slot) = p["index"].as_u64().and_then(|i| latest.get_mut(i as usize)) {
            *slot = Some(p);
        }
    }
    let (mut launched, mut failed, mut active, mut finished) = (0, 0, 0, 0);
    let mut cancellable = vec![];
    let mut attempts = vec![];
    let mut candidates = Vec::with_capacity(wanted);
    for (i, slot) in latest.iter().enumerate() {
        let Some(p) = slot else {
            candidates.push(json!({"index": i, "outcome": "not_attempted", "provider": null, "model": null, "task_id": null, "attempt_id": null, "status": null, "code": null}));
            continue;
        };
        let outcome = p["outcome"].as_str().unwrap_or("failed");
        let mut status = Value::Null;
        let mut model = p.get("model").cloned().unwrap_or(Value::Null);
        let mut provider = p["provider"].clone();
        if outcome == "launched" {
            launched += 1;
            if let Some(id) = p["attempt_id"].as_str() {
                attempts.push(id.to_string());
                if let Some(row) = core.attempt_row_for_resume(id)? {
                    status = json!(row.status.as_str());
                    provider = json!(row.provider);
                    model = json!(row.model);
                    if row.status.is_final() {
                        finished += 1;
                    } else {
                        active += 1;
                        cancellable.push(id.to_string());
                    }
                }
            }
        } else {
            failed += 1;
        }
        candidates.push(json!({
            "index": i, "outcome": outcome, "provider": provider, "model": model,
            "task_id": p.get("task_id").cloned().unwrap_or(Value::Null), "attempt_id": p.get("attempt_id").cloned().unwrap_or(Value::Null),
            "status": status, "code": p.get("code").cloned().unwrap_or(Value::Null),
        }));
    }
    Ok(json!({
        "v": 1,
        "race_id": race_id,
        "source_attempt_id": req["source"],
        "requested": wanted,
        "strategy": req["strategy"],
        "package_id": req.get("package_id").cloned().unwrap_or(Value::Null),
        "created_at": created_at,
        "candidates": candidates,
        "summary": {"launched": launched, "failed": failed, "not_attempted": wanted - launched - failed, "active": active, "finished": finished},
        // Los Attempts que Compare puede comparar ahora (2–4), y los que `task_race_cancel` puede detener.
        "compare": {"attempt_ids": if attempts.len() >= 2 { json!(attempts) } else { Value::Null }},
        "cancellable": cancellable,
        "limits": {"min_candidates": MIN_CANDIDATES, "max_candidates": MAX_CANDIDATES, "max_active_tasks": MAX_ACTIVE_TASKS},
    }))
}

/// `task_race_status { race_id }` → un Race; `{ source_attempt_id }` → los Races de ese Attempt (los más recientes primero). Solo lectura.
fn status(core: &Core, context: &MutationContext, input: &StatusInput) -> Result<Value, String> {
    person(context, "ver un Race")?;
    match (&input.race_id, &input.source_attempt_id) {
        (Some(id), None) => {
            if !valid_race_id(id) {
                return Err("race_invalid_request: race_id no es válido".into());
            }
            status_of(core, id)
        }
        (None, Some(source)) => {
            let mut races = vec![];
            for (id, payload, at) in core.race_requests(200)? {
                let p: Value = serde_json::from_str(&payload).map_err(|_| "un race.requested del log no se puede leer".to_string())?;
                if p["source"].as_str() == Some(source.as_str()) {
                    races.push(json!({"race_id": id, "requested": p["candidates"], "created_at": at}));
                }
            }
            Ok(json!({"v": 1, "source_attempt_id": source, "races": races}))
        }
        _ => Err("race_invalid_request: pide un race_id o un source_attempt_id, no los dos ni ninguno".into()),
    }
}

/// `task_race_cancel { race_id, attempt_id? }`: detiene UN candidato o todos los que no han terminado. Siempre explícito; nada se cancela solo
/// porque otro candidato termine. Un candidato esperando aprobación se rechaza; uno en marcha se detiene (y si su proceso no muere, sigue en marcha
/// y el resultado lo dice). Lo ya escrito se conserva en su worktree.
fn cancel(core: &Core, context: &MutationContext, input: &CancelInput) -> Result<Value, String> {
    person(context, "cancelar un Race")?;
    if !valid_race_id(&input.race_id) {
        return Err("race_invalid_request: race_id no es válido".into());
    }
    let _one = RACE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let state = status_of(core, &input.race_id)?;
    let launched: Vec<String> = state["candidates"].as_array().into_iter().flatten().filter(|c| c["outcome"] == "launched").filter_map(|c| c["attempt_id"].as_str().map(str::to_string)).collect();
    let targets: Vec<String> = match &input.attempt_id {
        Some(a) if launched.contains(a) => vec![a.clone()],
        Some(_) => return Err("race_candidate_not_found: ese Attempt no es un candidato lanzado de este Race".into()),
        None => launched,
    };
    let (mut stopped, mut rejected, mut failed) = (0usize, 0usize, 0usize);
    let mut results = vec![];
    for attempt in &targets {
        let outcome = cancel_one(core, context, attempt);
        match outcome.as_deref() {
            Ok("stopped") => stopped += 1,
            Ok("rejected") => rejected += 1,
            Ok(_) => {}
            Err(_) => failed += 1,
        }
        results.push(match outcome {
            Ok(o) => json!({"attempt_id": attempt, "outcome": o}),
            Err(e) => json!({"attempt_id": attempt, "outcome": "failed", "error": e}),
        });
    }
    let project = core.lock().tasks.get(attempt_task(&targets, &state)).and_then(|t| t.project_id.clone());
    let key = format!("race:{}:cancel:{}:{}", input.race_id, input.attempt_id.as_deref().unwrap_or("remaining"), now_ms());
    let draft = event_kinds::race_cancelled(&input.race_id, input.attempt_id.as_deref(), stopped, rejected, failed, project.as_deref(), &key).or_else(fail)?;
    core.record_facts(context, vec![draft]).map_err(|e| format!("No se pudo registrar la cancelación: {e:?}"))?;
    Ok(json!({"status": "Cancelled", "race_id": input.race_id, "results": results, "race": status_of(core, &input.race_id)?}))
}

/// La Task con la que se resuelve el Project del hecho: la primera cancelada, o la del origen del Race.
fn attempt_task<'a>(targets: &'a [String], state: &'a Value) -> &'a str {
    let id = targets.first().map(String::as_str).or_else(|| state["source_attempt_id"].as_str()).unwrap_or("");
    id.rsplit_once("-a").map_or("", |(task, _)| task)
}

/// Un candidato: pendiente de aprobación → se rechaza; en marcha → se detiene; ya terminado → no se toca. Devuelve qué pasó.
fn cancel_one(core: &Core, context: &MutationContext, attempt_id: &str) -> Result<&'static str, String> {
    let row = core.attempt_row_for_resume(attempt_id)?.ok_or_else(|| format!("no existe el Attempt {attempt_id}"))?;
    if row.status.is_final() {
        return Ok("already_final");
    }
    if row.status == crate::store::AttemptStatus::PendingApproval {
        use super::initial_approval_rpc::InitialApprovalResult as R;
        return match super::initial_approval_rpc::decide(core, context, attempt_id, false)? {
            R::Rejected | R::ReplayedRejected | R::Expired => Ok("rejected"),
            R::Approved | R::ReplayedApproved => Err("se aprobó mientras tanto: vuelve a cancelar".into()),
        };
    }
    let task = row.task_id.clone();
    // Si el proceso no se pudo detener la Task NO se declara detenida: sigue custodiada y el error lo dice.
    core.kill_term(&task).map_err(|e| format!("No se pudo detener {task}: {e}. Sigue en marcha; reinténtalo"))?;
    core.mutate_as(context, |st| {
        let msg = st.close(&task, super::state::Status::Stopped, "detenida al cancelar el Race")?;
        st.notify_opt(msg);
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    Ok("stopped")
}

/// Los Commands del Race. `None` = no es uno de ellos.
pub(super) fn dispatch(core: &Core, class: ActorClass, context: &MutationContext, cmd: &str, args: &Value) -> Option<Result<Value, String>> {
    let invalid = |_| "race_invalid_request: solicitud de Race inválida".to_string();
    match cmd {
        "task_race" => Some(person(context, "lanzar un Race").and_then(|()| serde_json::from_value::<RaceInput>(args.clone()).map_err(invalid)).and_then(|input| race(core, class, context, &input))),
        "task_race_status" => Some(serde_json::from_value::<StatusInput>(args.clone()).map_err(invalid).and_then(|input| status(core, context, &input))),
        "task_race_cancel" => Some(serde_json::from_value::<CancelInput>(args.clone()).map_err(invalid).and_then(|input| cancel(core, context, &input))),
        _ => None,
    }
}
