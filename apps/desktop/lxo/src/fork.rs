//! `lxo attempt fork`: crea un Attempt nuevo con la procedencia que registra el Core (LXO-160).

use std::process::ExitCode;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::f5_support::{self, value_flag, PreparedPackage, Rpc, SourceFacts};
use crate::projects::{self, Failure};
use crate::Args;

pub(super) const HELP: &str = "Uso: lxo attempt fork <source_attempt_id> [opciones]

Crea una Task y un Attempt nuevos a partir del Attempt indicado. No modifica el origen,
no compara ni integra. El Core decide la policy, valida la procedencia del ContextPackage
y crea un worktree propio. La decisión de aprobación inicial sigue siendo humana.

Opciones:
  --provider P             otro proveedor (si no, hereda el del origen)
  --model M                modelo; se hereda solo con el mismo proveedor
  --effort E                esfuerzo; se hereda solo con el mismo proveedor
  --role R                  rol explícito
  --title T                 título de la nueva Task
  --context-package ID|FILE ContextPackage guardado (sha256:…) o archivo; '-' lee stdin
  --request-id ID           clave idempotente; si se omite, se deriva de la petición
  --confirm                 confirmación que puede exigir la policy efectiva
  --dry-run                 enseña origen, destino, contexto, recursos y policy sin crear nada
  --wait [--timeout-ms N]   sigue el Attempt hasta terminal (defecto: ejecución en background)
  --background              explicita el comportamiento por defecto
  --json                    salida estructurada (v1)

El host y la estrategia del worktree no son opciones: el Core usa el host local y un worktree
propio. Un intento recién creado queda pending_approval hasta que una persona lo apruebe en
Lixbon. Si se repite una solicitud, lxo muestra el estado actual del Core.
El Core puede rechazar la mutación si la identidad autenticada del CLI no está autorizada.
";

const CONTRACT: u64 = 1;
const FLAGS: [&str; 13] = [
    "provider",
    "model",
    "effort",
    "role",
    "title",
    "context-package",
    "request-id",
    "confirm",
    "dry-run",
    "wait",
    "background",
    "timeout-ms",
    "json",
];
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const MAX_WAIT: u64 = 30 * 60 * 1000;

#[derive(Debug, PartialEq, Eq)]
struct Request {
    source_attempt_id: String,
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    role: Option<String>,
    title: Option<String>,
    context_package: Option<String>,
    request_id: Option<String>,
    confirm: bool,
    dry_run: bool,
    wait_ms: Option<u64>,
}

fn usage(message: impl Into<String>) -> Failure {
    Failure::Usage(message.into())
}

fn parse(a: &Args) -> Result<Option<Request>, Failure> {
    if a.b("help") || a.at(2).as_deref() == Some("help") {
        return Ok(None);
    }
    if let Some(name) = a
        .flags
        .keys()
        .find(|name| !FLAGS.contains(&name.as_str()) && name.as_str() != "help")
    {
        return Err(usage(format!(
            "--{name} no es una opción de lxo attempt fork."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["confirm", "dry-run", "wait", "background", "json", "help"] {
        if a.flags.get(name).is_some_and(|value| !value.is_boolean()) {
            return Err(usage(format!("--{name} no admite un valor.")));
        }
    }
    let source_attempt_id = match a.pos.get(2..) {
        Some([id]) if !id.trim().is_empty() => id.trim().to_string(),
        Some([]) => {
            return Err(usage(
                "Falta el origen: lxo attempt fork <source_attempt_id>.",
            ))
        }
        _ => return Err(usage("lxo attempt fork recibe un solo source_attempt_id.")),
    };
    if a.b("wait") && a.b("background") {
        return Err(usage("--wait y --background se excluyen mutuamente."));
    }
    let wait_ms = if a.b("wait") {
        let timeout = match a.flags.get("timeout-ms") {
            None => 10 * 60 * 1000,
            Some(Value::String(value)) => value
                .parse::<u64>()
                .ok()
                .filter(|value| *value > 0 && *value <= MAX_WAIT)
                .ok_or_else(|| usage(format!("--timeout-ms debe estar entre 1 y {MAX_WAIT}.")))?,
            _ => return Err(usage("--timeout-ms requiere un valor numérico.")),
        };
        Some(timeout)
    } else if a.flags.contains_key("timeout-ms") {
        return Err(usage("--timeout-ms solo se usa junto con --wait."));
    } else {
        None
    };
    Ok(Some(Request {
        source_attempt_id,
        provider: value_flag(a, "provider")?,
        model: value_flag(a, "model")?,
        effort: value_flag(a, "effort")?,
        role: value_flag(a, "role")?,
        title: value_flag(a, "title")?,
        context_package: value_flag(a, "context-package")?,
        request_id: value_flag(a, "request-id")?,
        confirm: a.b("confirm"),
        dry_run: a.b("dry-run"),
        wait_ms,
    }))
}

fn target(source: &SourceFacts, request: &Request) -> Value {
    let provider = request
        .provider
        .as_deref()
        .unwrap_or_else(|| source.attempt["provider"].as_str().unwrap_or(""));
    let same_provider = provider == source.attempt["provider"].as_str().unwrap_or("");
    json!({
        "provider": provider,
        "model": request.model.as_ref().map(|value| json!(value)).unwrap_or_else(|| {
            if same_provider { source.attempt["model"].clone() } else { Value::Null }
        }),
        "effort": request.effort.as_ref().map(|value| json!(value)).unwrap_or_else(|| {
            if same_provider { source.attempt["effort"].clone() } else { Value::Null }
        }),
        "role": request.role.as_ref().map(|value| json!(value)).unwrap_or_else(|| source.attempt["role"].clone()),
        "title": request.title,
    })
}

fn request_id(
    source: &SourceFacts,
    request: &Request,
    package: Option<&PreparedPackage>,
) -> String {
    request.request_id.clone().unwrap_or_else(|| {
        f5_support::stable_request_id(
            "fork",
            &json!({
                "source_attempt_id": source.attempt_id,
                "provider": request.provider,
                "model": request.model,
                "effort": request.effort,
                "role": request.role,
                "title": request.title,
                "package_id": package.map(|package| package.package_id.as_str()),
            }),
        )
    })
}

fn execute(request: Request, rpc: &mut Rpc<'_>) -> Result<Value, Failure> {
    let source = f5_support::source(rpc, &request.source_attempt_id)?;
    let package =
        f5_support::context_package(request.context_package.as_deref(), None, &source, rpc)?;
    let target = target(&source, &request);
    let request_id = request_id(&source, &request, package.as_ref());
    let package_id = package
        .as_ref()
        .map(|package| Value::String(package.package_id.clone()))
        .unwrap_or(Value::Null);
    if request.dry_run {
        let (resource, policy) = f5_support::dry_run_facts(rpc, &source)?;
        return Ok(json!({
            "v": CONTRACT,
            "status": "dry_run",
            "request_id": request_id,
            "source": f5_support::source_preview(&source),
            "target": target,
            "context": {
                "strategy": if package.is_some() { "context_package" } else { "clean" },
                "package_id": package_id,
            },
            "resource": resource,
            "policy": policy,
            "worktree": { "host": "local", "strategy": "own" },
        }));
    }

    let result = f5_support::send(
        "attempt_fork",
        &json!({
            "request_id": request_id,
            "source_attempt_id": source.attempt_id,
            "provider": request.provider,
            "model": request.model,
            "effort": request.effort,
            "role": request.role,
            "title": request.title,
            "package": package.map(|package| package.raw),
            "confirm": request.confirm,
        }),
        rpc,
    )?;
    let status = result["status"]
        .as_str()
        .filter(|status| matches!(*status, "Requested" | "Replayed"))
        .ok_or_else(|| {
            Failure::Version("El Core devolvió una respuesta de Fork que lxo no reconoce.".into())
        })?;
    let task_id = result["task_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| Failure::Version("El Core no devolvió la Task del Fork.".into()))?;
    let attempt_id = result["attempt_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| Failure::Version("El Core no devolvió el id del Attempt creado.".into()))?;
    let (attempt_status, followed) = if let Some(timeout_ms) = request.wait_ms {
        let followed = follow(rpc, attempt_id, task_id, timeout_ms)?;
        let status = if followed["timed_out"] == true {
            followed["status"].as_str()
        } else {
            followed["attempt"]["status"].as_str()
        }
        .ok_or_else(|| {
            Failure::Version("El Core no devolvió el estado actual del Attempt.".into())
        })?
        .to_string();
        (status, Some(followed))
    } else {
        let attempt = current_attempt(rpc, attempt_id, task_id)?;
        let status = attempt["status"]
            .as_str()
            .expect("current_attempt validates status")
            .to_string();
        (status, None)
    };
    let approval_required = attempt_status == "pending_approval";
    let mut output = json!({
        "v": CONTRACT,
        "status": status,
        "source_attempt_id": source.attempt_id,
        "target": target,
        "run_id": result["run_id"],
        "task_id": task_id,
        "attempt_id": attempt_id,
        "attempt_status": attempt_status,
        "approval_required": approval_required,
        "strategy": result["strategy"],
        "package_id": result["package_id"],
        "provenance": {
            "source_attempt_id": result["source_attempt_id"],
            "strategy": result["strategy"],
            "package_id": result["package_id"],
        },
        "approval": if approval_required { Some("pending_approval") } else { None },
    });
    if let Some(followed) = followed {
        output["follow"] = followed;
    }
    Ok(output)
}

fn current_attempt(rpc: &mut Rpc<'_>, attempt_id: &str, task_id: &str) -> Result<Value, Failure> {
    f5_support::current_attempt(rpc, attempt_id, task_id)
}

fn follow(
    rpc: &mut Rpc<'_>,
    attempt_id: &str,
    task_id: &str,
    timeout_ms: u64,
) -> Result<Value, Failure> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let attempt = current_attempt(rpc, attempt_id, task_id)?;
        let status = attempt["status"]
            .as_str()
            .expect("current_attempt validates status");
        if f5_support::FINAL_STATUSES.contains(&status) {
            return Ok(json!({
                "timed_out": false,
                "attempt": attempt,
            }));
        }
        if Instant::now() >= deadline {
            return Ok(json!({
                "timed_out": true,
                "attempt_id": attempt_id,
                "status": status,
            }));
        }
        std::thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())));
    }
}

fn human(data: &Value) -> String {
    if data["status"] == "dry_run" {
        return format!(
            "Previsualización de fork desde {} → {} / {} · contexto {} · policy fork: {}. No se creó ningún Attempt.",
            data["source"]["attempt_id"].as_str().unwrap_or(""),
            data["target"]["provider"].as_str().unwrap_or(""),
            data["target"]["model"].as_str().unwrap_or("modelo por defecto"),
            data["context"]["strategy"].as_str().unwrap_or(""),
            data["policy"]["category"]["level"].as_str().unwrap_or("desconocida"),
        );
    }
    let mut text = format!(
        "Fork {} desde {} · Task {} · proveedor {} · estado actual en Core: {}.",
        data["attempt_id"].as_str().unwrap_or(""),
        data["source_attempt_id"].as_str().unwrap_or(""),
        data["task_id"].as_str().unwrap_or(""),
        data["target"]["provider"].as_str().unwrap_or(""),
        data["attempt_status"].as_str().unwrap_or("desconocido"),
    );
    if data["approval_required"] == true {
        text.push_str(" Apruébalo o recházalo en Lixbon Desktop.");
    }
    if data["follow"]["timed_out"] == true {
        text.push_str(" La espera terminó antes de alcanzar un estado terminal.");
    }
    text
}

pub(super) fn run(a: &Args) -> ExitCode {
    let json_output = a.b("json");
    let result = match parse(a) {
        Ok(None) => {
            print!("{HELP}");
            return ExitCode::SUCCESS;
        }
        Ok(Some(request)) => {
            let mut rpc = f5_support::live_rpc();
            execute(request, &mut rpc)
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(data) => {
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&data).unwrap_or_default()
                );
            } else {
                println!("{}", human(&data));
            }
            ExitCode::SUCCESS
        }
        Err(error) => projects::finish(Err(error), json_output),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client_auth::RpcFailure;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|value| value.to_string()).collect())
    }

    fn source_attempt() -> Value {
        json!({
            "v": 1,
            "core_model": "task_attempt_v1",
            "attempt": {
                "id": "t1-a1", "task_id": "t1", "provider": "claude", "model": "sonnet",
                "effort": "high", "role": "implementar", "status": "done",
                "worktree": {"branch": "feature", "state": "active", "machine": null}
            }
        })
    }

    fn task() -> Value {
        json!({"v": 2, "core_model": "task_attempt_v1", "task": {
            "id": "t1", "project_id": "p1", "state": "integrated"
        }})
    }

    fn facts(
        calls: Rc<RefCell<Vec<(String, Value)>>>,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        facts_with_state(calls, "Requested", "pending_approval")
    }

    fn facts_with_state(
        calls: Rc<RefCell<Vec<(String, Value)>>>,
        response_status: &str,
        attempt_status: &str,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        let response_status = response_status.to_string();
        let attempt_status = attempt_status.to_string();
        move |cmd, args| {
            calls.borrow_mut().push((cmd.to_string(), args.clone()));
            match cmd {
                "attempt_detail" if args["attempt_id"] == "t1-a1" => Ok(source_attempt()),
                "attempt_detail" => Ok(json!({
                    "v": 1,
                    "core_model": "task_attempt_v1",
                    "attempt": {
                        "id": args["attempt_id"],
                        "task_id": "t2",
                        "status": attempt_status,
                    }
                })),
                "task_detail_v2" => Ok(task()),
                "resource_inspect" => {
                    Ok(json!({"v":1,"task_id":"t1","worktree":{"state":"present","dirty":false}}))
                }
                "policy_effective" => Ok(
                    json!({"v":1,"revision":3,"actor":{"class":"cli_person"},"categories":[{"category":"fork","level":"confirm","source":"global"}]}),
                ),
                "attempt_fork" => Ok(json!({
                    "status":response_status, "source_attempt_id":"t1-a1", "run_id":"r2",
                    "task_id":"t2", "attempt_id":"t2-a1", "strategy":"clean", "package_id":null
                })),
                _ => panic!("RPC inesperado: {cmd}"),
            }
        }
    }

    #[test]
    fn parse_fork_rechaza_host_y_estrategia_no_soportados_por_el_core() {
        for flag in ["--host", "--worktree-strategy"] {
            let raw = ["attempt", "fork", "t1-a1", flag, "remote"];
            assert!(parse(&args(&raw)).is_err(), "{flag}");
        }
    }

    #[test]
    fn fork_conserva_procedencia_y_no_envia_campos_que_el_core_no_acepta() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = facts(calls.clone());
        let request = parse(&args(&["attempt", "fork", "t1-a1"]))
            .unwrap()
            .unwrap();
        let result = execute(request, &mut rpc).unwrap();
        assert_eq!(result["attempt_id"], "t2-a1");
        assert_eq!(result["provenance"]["source_attempt_id"], "t1-a1");
        assert_eq!(result["approval"], "pending_approval");
        assert_eq!(result["status"], "Requested");
        assert_eq!(result["attempt_status"], "pending_approval");
        assert_eq!(result["approval_required"], true);
        let call = calls
            .borrow()
            .iter()
            .find(|(cmd, _)| cmd == "attempt_fork")
            .unwrap()
            .clone();
        assert_eq!(call.0, "attempt_fork");
        assert_eq!(call.1["source_attempt_id"], "t1-a1");
        assert_eq!(call.1["confirm"], false);
        assert!(call.1.get("host").is_none());
        assert!(call.1.get("worktree").is_none());
        assert!(call.1["request_id"]
            .as_str()
            .unwrap()
            .starts_with("lxo-fork-"));
    }

    #[test]
    fn un_replay_muestra_el_estado_actual_aprobado_del_core() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = facts_with_state(calls, "Replayed", "running");
        let request = parse(&args(&["attempt", "fork", "t1-a1"]))
            .unwrap()
            .unwrap();
        let result = execute(request, &mut rpc).unwrap();
        assert_eq!(
            result["status"], "Replayed",
            "status conserva el resultado de la solicitud"
        );
        assert_eq!(
            result["attempt_status"], "running",
            "estado actual viene del Core"
        );
        assert_eq!(result["approval_required"], false);
        assert!(result["approval"].is_null());
        assert!(human(&result).contains("estado actual en Core: running"));
        assert!(!human(&result).contains("Apruébalo"));
    }

    #[test]
    fn wait_en_un_fork_terminal_muestra_el_estado_terminal_del_core() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = facts_with_state(calls, "Requested", "done");
        let request = parse(&args(&[
            "attempt",
            "fork",
            "t1-a1",
            "--wait",
            "--timeout-ms",
            "1000",
        ]))
        .unwrap()
        .unwrap();
        let result = execute(request, &mut rpc).unwrap();
        assert_eq!(result["status"], "Requested");
        assert_eq!(result["attempt_status"], "done");
        assert_eq!(result["approval_required"], false);
        assert!(result["approval"].is_null());
        assert_eq!(result["follow"]["timed_out"], false);
        assert_eq!(result["follow"]["attempt"]["status"], "done");
        assert!(human(&result).contains("estado actual en Core: done"));
        assert!(!human(&result).contains("Apruébalo"));
    }

    #[test]
    fn dry_run_solo_lee_contexto_recursos_y_policy() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = facts(calls.clone());
        let request = parse(&args(&["attempt", "fork", "t1-a1", "--dry-run"]))
            .unwrap()
            .unwrap();
        let result = execute(request, &mut rpc).unwrap();
        assert_eq!(result["status"], "dry_run");
        assert_eq!(result["source"]["attempt_id"], "t1-a1");
        assert_eq!(result["policy"]["category"]["level"], "confirm");
        assert_eq!(result["resource"]["task_id"], "t1");
        assert!(!calls.borrow().iter().any(|(cmd, _)| cmd == "attempt_fork"));
    }

    #[test]
    fn esperar_y_background_son_excluyentes_y_el_timeout_se_acota() {
        assert!(parse(&args(&[
            "attempt",
            "fork",
            "t1-a1",
            "--wait",
            "--background"
        ]))
        .is_err());
        assert!(parse(&args(&[
            "attempt",
            "fork",
            "t1-a1",
            "--wait",
            "--timeout-ms",
            "999999999"
        ]))
        .is_err());
        assert_eq!(
            parse(&args(&["attempt", "fork", "t1-a1", "--wait"]))
                .unwrap()
                .unwrap()
                .wait_ms,
            Some(600_000)
        );
    }
}
