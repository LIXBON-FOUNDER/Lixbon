//! `lxo task create`: crea una intención con el RPC autenticado del Core.

use serde_json::{json, Value};
use std::borrow::Cow;

use crate::client_auth::{self, RpcFailure};
use crate::events::clean;
use crate::f5_support::{self, selection_text, valid_provider};
use crate::projects::{self, Failure};
use crate::tasks;
use crate::Args;

pub(super) const HELP: &str =
    "Uso: lxo task create --project ID|NOMBRE --objective \"...\" --title \"...\" [opciones]

Opciones:
  --spec TEXTO          encargo; obligatorio si se solicita un Attempt
  --repo RUTA           ruta declarada para la Task; si se omite, el Core usa la ubicación
                        verificada del Project
  --provider P --profile PERFIL
                        solicita también el primer Attempt (admite --model, --effort y --role)
  --request-id ID       clave idempotente explícita; si se omite, se deriva de la petición
  --json                salida estructurada (v1)

`--project` es obligatorio y admite el id o el nombre registrado del Project. Sin
`--provider` y `--profile`, crea solo la intención: no solicita ejecución.
Cuando se solicita un Attempt, queda pendiente de aprobación en Desktop y el
Core no ejecuta el proveedor antes de esa decisión. El host y el Worktree no
son opciones de este comando: los determina el Core.

Códigos de salida: 0 correcto, 1 error interno, 2 uso, 3 autenticación,
4 versión o contrato, 5 Core no disponible, 6 Project inexistente,
7 capability no soportada, 8 entorno bloqueado, 9 policy, 12 conflicto.
";

const CONTRACT: u64 = 1;
const FLAGS: [&str; 13] = [
    "project",
    "objective",
    "title",
    "spec",
    "repo",
    "request-id",
    "provider",
    "profile",
    "model",
    "effort",
    "role",
    "json",
    "help",
];
const ATTEMPT_STATUSES: [&str; 9] = [
    "pending_approval",
    "starting",
    "running",
    "waiting",
    "awaiting_terminal_approval",
    "done",
    "failed",
    "stopped",
    "exited",
];

type Rpc<'a> = dyn FnMut(&str, &Value) -> Result<Value, RpcFailure> + 'a;

#[derive(Debug, Clone, PartialEq, Eq)]
struct AttemptSelection {
    provider: String,
    profile: String,
    model: Option<String>,
    effort: Option<String>,
    role: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CreateRequest {
    project: String,
    objective: String,
    title: String,
    spec: String,
    repo: Option<String>,
    request_id: Option<String>,
    attempt: Option<AttemptSelection>,
}

#[derive(Debug)]
enum Request {
    Help,
    Create(CreateRequest),
}

#[derive(Debug)]
struct ActionFailure {
    code: &'static str,
    exit: u8,
    message: String,
}

impl ActionFailure {
    fn new(code: &'static str, exit: u8, message: impl Into<String>) -> Self {
        Self {
            code,
            exit,
            message: message.into(),
        }
    }
}

fn usage(message: impl Into<String>) -> ActionFailure {
    ActionFailure::new("usage", 2, message)
}

fn contract_error() -> ActionFailure {
    ActionFailure::new(
        "version",
        4,
        "El Core devolvió una respuesta de task.create que lxo no reconoce; actualiza Lixbon.",
    )
}

fn text_flag(a: &Args, name: &str) -> Result<Option<String>, ActionFailure> {
    match a.flags.get(name) {
        None => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => {
            Ok(Some(value.trim().to_string()))
        }
        _ => Err(usage(format!("--{name} requiere un valor."))),
    }
}

fn required_flag(a: &Args, name: &str) -> Result<String, ActionFailure> {
    text_flag(a, name)?.ok_or_else(|| usage(format!("Falta --{name}.")))
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn parse(a: &Args) -> Result<Request, ActionFailure> {
    if a.b("help") || a.at(2).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    if a.pos.len() != 2 {
        return Err(usage(
            "Uso: lxo task create --project ID|NOMBRE --objective \"...\" --title \"...\".",
        ));
    }
    if let Some(name) = a.flags.keys().find(|name| !FLAGS.contains(&name.as_str())) {
        return Err(usage(format!(
            "--{name} no es una opción de lxo task create. Mira `lxo task create --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["json", "help"] {
        if a.flags.get(name).is_some_and(|value| !value.is_boolean()) {
            return Err(usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }

    let project = required_flag(a, "project")?;
    let objective = required_flag(a, "objective")?;
    let title = required_flag(a, "title")?;
    let spec = text_flag(a, "spec")?.unwrap_or_default();
    let repo = text_flag(a, "repo")?;
    let request_id = text_flag(a, "request-id")?;
    if objective.chars().count() > 16_384
        || title.chars().count() > 512
        || spec.chars().count() > 16_384
    {
        return Err(usage(
            "El objetivo, título o encargo supera el límite del Core.",
        ));
    }
    if repo
        .as_ref()
        .is_some_and(|value| value.chars().count() > 4096)
    {
        return Err(usage("--repo supera el límite del Core."));
    }
    if request_id
        .as_deref()
        .is_some_and(|value| !valid_request_id(value))
    {
        return Err(usage(
            "--request-id debe ser un token ASCII de hasta 64 caracteres.",
        ));
    }

    let provider = text_flag(a, "provider")?.map(|value| value.to_ascii_lowercase());
    let profile = text_flag(a, "profile")?;
    let model = text_flag(a, "model")?;
    let effort = text_flag(a, "effort")?;
    let role = text_flag(a, "role")?;
    let attempt = match (provider, profile) {
        (Some(provider), Some(profile)) => {
            if !valid_provider(&provider)
                || [&model, &effort, &role]
                    .into_iter()
                    .flatten()
                    .any(|value| !selection_text(value))
            {
                return Err(usage("La selección del Attempt no es válida."));
            }
            if spec.trim().is_empty() {
                return Err(usage(
                    "--spec no puede estar vacío si se solicita un Attempt.",
                ));
            }
            Some(AttemptSelection {
                provider,
                profile,
                model,
                effort,
                role,
            })
        }
        (None, None) if model.is_none() && effort.is_none() && role.is_none() => None,
        (Some(_), None) => return Err(usage("--provider requiere también --profile.")),
        (None, Some(_)) => return Err(usage("--profile requiere también --provider.")),
        (None, None) => {
            return Err(usage(
                "--model, --effort y --role requieren --provider y --profile.",
            ))
        }
    };

    Ok(Request::Create(CreateRequest {
        project,
        objective,
        title,
        spec,
        repo,
        request_id,
        attempt,
    }))
}

fn request_id(request: &CreateRequest, project_id: &str) -> String {
    request.request_id.clone().unwrap_or_else(|| {
        f5_support::stable_request_id(
            "task-create",
            &json!({
                "project_id": project_id,
                "objective": request.objective,
                "title": request.title,
                "spec": request.spec,
                "repo": request.repo,
                "attempt": request.attempt.as_ref().map(|attempt| json!({
                    "provider": attempt.provider,
                    "profile": attempt.profile,
                    "model": attempt.model,
                    "effort": attempt.effort,
                    "role": attempt.role,
                })),
            }),
        )
    })
}

fn rpc_failure(error: RpcFailure) -> ActionFailure {
    if let RpcFailure::Rejected(message) = &error {
        let code: Option<(&str, u8, Cow<'_, str>)> = if message.starts_with("Comando desconocido")
            || message.starts_with("core_model_inactive")
        {
            Some((
                "version",
                4,
                Cow::Borrowed("Este Core no ofrece task.create; actualiza Lixbon."),
            ))
        } else if message.contains("environment_blocked") {
            Some((
                "environment_blocked",
                8,
                Cow::Borrowed("El entorno del proveedor bloquea el lanzamiento solicitado."),
            ))
        } else if message.contains("_unsupported") || message.starts_with("provider_unknown:") {
            Some((
                "unsupported",
                7,
                Cow::Borrowed("El Core no ofrece la capability de lanzamiento solicitada."),
            ))
        } else if message.contains("_capability_unavailable")
            || message.starts_with("provider_probing:")
        {
            Some((
                "capability_unavailable",
                5,
                Cow::Borrowed(
                    "La capability del proveedor todavía no está disponible; inténtalo de nuevo.",
                ),
            ))
        } else if message.starts_with("policy_") {
            Some((
                "policy",
                9,
                Cow::Borrowed("El Core rechazó la solicitud según la policy efectiva."),
            ))
        } else if message.contains("_not_found")
            || message.contains("no existe en el registro de proyectos")
        {
            Some((
                "not_found",
                6,
                Cow::Borrowed("El Core no encontró el Project o recurso solicitado."),
            ))
        } else if message.contains("_conflict") || message.contains("otro payload") {
            Some((
                "conflict",
                12,
                Cow::Borrowed("La clave idempotente ya se usó con otra solicitud."),
            ))
        } else if message.contains("_auth_required")
            || message.starts_with("Acción no permitida")
            || message.contains("solo está permitido a una Person")
            || message.contains("requiere una Person autenticada")
        {
            Some((
                "authentication",
                3,
                Cow::Borrowed("Esta operación requiere una Person autenticada de lxo."),
            ))
        } else if message.starts_with("Solicitud task.create inválida")
            || message.starts_with("request_conflict")
            || message.contains("project_id")
        {
            Some(("usage", 2, Cow::Owned(clean(message))))
        } else if message.contains("_unavailable")
            || message.contains("No se pudo comprobar el proyecto")
            || message.contains("No se pudo resolver la ubicación del proyecto")
            || message.contains("ubicación del proyecto")
            || message.contains("lifecycle de lanzamiento verificado")
        {
            Some((
                "core_unavailable",
                5,
                Cow::Borrowed("El Core no puede verificar el Project o preparar el lanzamiento."),
            ))
        } else {
            None
        };
        if let Some((code, exit, safe_message)) = code {
            return ActionFailure::new(code, exit, safe_message.into_owned());
        }
    }
    let failure = projects::failure(error);
    let (code, exit) = failure.code();
    ActionFailure::new(code, exit, failure.message())
}

fn project_failure(failure: Failure) -> ActionFailure {
    let (code, exit) = failure.code();
    ActionFailure::new(code, exit, failure.message())
}

fn valid_id(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
    })
}

fn execute(request: CreateRequest, rpc: &mut Rpc<'_>) -> Result<(Value, String), ActionFailure> {
    let project_id = tasks::resolve_project(rpc, &request.project).map_err(project_failure)?;
    let request_id = request_id(&request, &project_id);
    let mut args = json!({
        "request_id": request_id,
        "project_id": project_id,
        "objective": request.objective,
        "title": request.title,
        "spec": request.spec,
    });
    if let Some(repo) = &request.repo {
        args["repo"] = json!(repo);
    }
    if let Some(attempt) = &request.attempt {
        args["attempt"] = json!({
            "provider": attempt.provider,
            "profile": attempt.profile,
            "model": attempt.model,
            "effort": attempt.effort,
            "role": attempt.role,
        });
    }

    let result = rpc("task_create", &args).map_err(rpc_failure)?;
    let status = result["status"]
        .as_str()
        .filter(|status| matches!(*status, "Committed" | "Replayed"))
        .ok_or_else(contract_error)?;
    let run_id = result["run_id"]
        .as_str()
        .filter(|_| valid_id(&result["run_id"]))
        .ok_or_else(contract_error)?;
    let task_id = result["task_id"]
        .as_str()
        .filter(|_| valid_id(&result["task_id"]))
        .ok_or_else(contract_error)?;
    let attempt_id = match (&request.attempt, result["attempt_id"].as_str()) {
        (None, None) if result["attempt_id"].is_null() => None,
        (Some(_), Some(id)) if id == format!("{task_id}-a1") => Some(id.to_string()),
        _ => return Err(contract_error()),
    };

    let attempt_status = if let Some(attempt_id) = &attempt_id {
        let detail =
            rpc("attempt_detail", &json!({ "attempt_id": attempt_id })).map_err(rpc_failure)?;
        let attempt = &detail["attempt"];
        let state = attempt["status"]
            .as_str()
            .filter(|status| ATTEMPT_STATUSES.contains(status))
            .ok_or_else(contract_error)?;
        if detail["v"].as_u64() != Some(1)
            || detail["core_model"].as_str() != Some("task_attempt_v1")
            || attempt["id"].as_str() != Some(attempt_id.as_str())
            || attempt["task_id"].as_str() != Some(task_id)
        {
            return Err(contract_error());
        }
        Some(state.to_string())
    } else {
        None
    };
    let approval_required = attempt_status.as_deref() == Some("pending_approval");
    let data = json!({
        "v": CONTRACT,
        "command": "create",
        "status": status,
        "request_id": request_id,
        "project_id": project_id,
        "run_id": run_id,
        "task_id": task_id,
        "attempt_id": attempt_id,
        "attempt_status": attempt_status,
        "approval_required": approval_required,
        "approval_surface": if approval_required { Some("desktop") } else { None },
    });
    let verb = if status == "Committed" {
        "creada"
    } else {
        "ya existía"
    };
    let mut human = format!("Task {task_id} {verb} en el Project {project_id}.");
    match (&attempt_id, attempt_status.as_deref()) {
        (Some(id), Some("pending_approval")) => human.push_str(&format!(
            " El Attempt {id} queda pendiente de aprobación en Desktop; no se ejecutará antes."
        )),
        (Some(id), Some(state)) => human.push_str(&format!(
            " El Attempt {id} tiene estado {state}; la ejecución requiere una decisión previa de Desktop."
        )),
        _ => human.push_str(" No se ha solicitado ejecución."),
    }
    Ok((data, human))
}

fn finish_action(
    result: Result<(Value, String), ActionFailure>,
    json_output: bool,
) -> std::process::ExitCode {
    match result {
        Ok((data, human)) => {
            if json_output {
                println!("{data}");
            } else {
                println!("{human}");
            }
            std::process::ExitCode::SUCCESS
        }
        Err(error) => {
            if json_output {
                eprintln!(
                    "{}",
                    json!({
                        "v": CONTRACT,
                        "ok": false,
                        "code": error.code,
                        "error": error.message,
                    })
                );
            } else {
                eprintln!("lxo: {}", error.message);
            }
            std::process::ExitCode::from(error.exit)
        }
    }
}

pub(super) fn run(a: &Args) -> std::process::ExitCode {
    match parse(a) {
        Ok(Request::Help) => {
            print!("{HELP}");
            std::process::ExitCode::SUCCESS
        }
        Ok(Request::Create(request)) => {
            let mut rpc = |cmd: &str, args: &Value| client_auth::rpc(cmd, args, &crate::cwd());
            finish_action(execute(request, &mut rpc), a.b("json"))
        }
        Err(error) => finish_action(Err(error), a.b("json")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|value| value.to_string()).collect())
    }

    fn request(raw: &[&str]) -> CreateRequest {
        match parse(&args(raw)).unwrap() {
            Request::Create(request) => request,
            Request::Help => panic!("se esperaba una solicitud de creación"),
        }
    }

    fn project_overview() -> Value {
        json!({
            "v": 1,
            "projects": [{"id": "p-1", "name": "Lixbon", "state": "active"}],
            "unassigned": {"tasks": 0}
        })
    }

    #[test]
    fn requiere_project_objetivo_y_titulo_y_no_admite_host_ni_worktree() {
        for raw in [
            &["task", "create", "--objective", "o", "--title", "t"][..],
            &["task", "create", "--project", "p-1", "--title", "t"][..],
            &["task", "create", "--project", "p-1", "--objective", "o"][..],
            &[
                "task",
                "create",
                "--project",
                "p-1",
                "--objective",
                "o",
                "--title",
                "t",
                "--host",
                "local",
            ][..],
            &[
                "task",
                "create",
                "--project",
                "p-1",
                "--objective",
                "o",
                "--title",
                "t",
                "--worktree",
                "new",
            ][..],
        ] {
            assert_eq!(parse(&args(raw)).unwrap_err().exit, 2, "{raw:?}");
        }
    }

    #[test]
    fn el_attempt_es_opcional_pero_su_seleccion_y_encargo_son_completos() {
        let intent = request(&[
            "task",
            "create",
            "--project",
            "p-1",
            "--objective",
            "objetivo",
            "--title",
            "tarea",
        ]);
        assert_eq!(intent.attempt, None);

        let with_attempt = parse(&args(&[
            "task",
            "create",
            "--project",
            "p-1",
            "--objective",
            "o",
            "--title",
            "t",
            "--provider",
            "Claude",
            "--profile",
            "explorar",
            "--spec",
            "hazlo",
        ]))
        .unwrap();
        let Request::Create(with_attempt) = with_attempt else {
            panic!("se esperaba Create")
        };
        assert_eq!(with_attempt.attempt.unwrap().provider, "claude");

        for raw in [
            &[
                "task",
                "create",
                "--project",
                "p-1",
                "--objective",
                "o",
                "--title",
                "t",
                "--provider",
                "claude",
            ][..],
            &[
                "task",
                "create",
                "--project",
                "p-1",
                "--objective",
                "o",
                "--title",
                "t",
                "--profile",
                "explorar",
            ][..],
            &[
                "task",
                "create",
                "--project",
                "p-1",
                "--objective",
                "o",
                "--title",
                "t",
                "--provider",
                "claude",
                "--profile",
                "explorar",
            ][..],
        ] {
            assert_eq!(parse(&args(raw)).unwrap_err().exit, 2, "{raw:?}");
        }
    }

    #[test]
    fn un_request_id_interno_es_estable_por_intencion_y_se_puede_fijar() {
        let create = request(&[
            "task",
            "create",
            "--project",
            "p-1",
            "--objective",
            "o",
            "--title",
            "t",
        ]);
        let first = request_id(&create, "p-1");
        assert_eq!(first, request_id(&create, "p-1"));
        assert!(valid_request_id(&first));

        let explicit = request(&[
            "task",
            "create",
            "--project",
            "p-1",
            "--objective",
            "o",
            "--title",
            "t",
            "--request-id",
            "caller-1",
        ]);
        assert_eq!(request_id(&explicit, "p-1"), "caller-1");
        assert_eq!(
            parse(&args(&[
                "task",
                "create",
                "--project",
                "p-1",
                "--objective",
                "o",
                "--title",
                "t",
                "--request-id",
                "../unsafe",
            ]))
            .unwrap_err()
            .exit,
            2
        );
    }

    #[test]
    fn la_creacion_usa_rpc_real_con_project_resuelto_y_no_envia_host() {
        let calls = Rc::new(RefCell::new(Vec::<(String, Value)>::new()));
        let copy = calls.clone();
        let mut rpc = move |command: &str, args: &Value| {
            copy.borrow_mut().push((command.to_string(), args.clone()));
            match command {
                "projects_overview" => Ok(project_overview()),
                "task_create" => Ok(json!({
                    "status": "Committed", "run_id": "r-1", "task_id": "t-1", "attempt_id": null
                })),
                _ => Err(RpcFailure::Rejected(format!("inesperado: {command}"))),
            }
        };
        let req = request(&[
            "task",
            "create",
            "--project",
            "Lixbon",
            "--objective",
            "objetivo",
            "--title",
            "título",
            "--spec",
            "encargo",
        ]);
        let (data, human) = execute(req, &mut rpc).unwrap();
        assert_eq!(data["v"], 1);
        assert_eq!(data["command"], "create");
        assert_eq!(data["status"], "Committed");
        assert_eq!(data["project_id"], "p-1");
        assert_eq!(data["task_id"], "t-1");
        assert_eq!(data["attempt_id"], Value::Null);
        assert_eq!(data["approval_required"], false);
        assert!(human.contains("No se ha solicitado ejecución"));

        {
            let calls = calls.borrow();
            assert_eq!(calls.len(), 2);
            assert_eq!(calls[0].0, "projects_overview");
            assert_eq!(calls[1].0, "task_create");
            assert_eq!(calls[1].1["project_id"], "p-1");
            assert_eq!(calls[1].1["objective"], "objetivo");
            assert_eq!(calls[1].1["title"], "título");
            assert!(calls[1].1.get("host").is_none());
            assert!(calls[1].1.get("attempt").is_none());
            assert!(
                calls[1].1.get("repo").is_none(),
                "no se inventa una ruta a partir del cwd"
            );
        }

        calls.borrow_mut().clear();
        let req = request(&[
            "task",
            "create",
            "--project",
            "p-1",
            "--objective",
            "objetivo",
            "--title",
            "título",
            "--repo",
            "D:/projects/lixbon",
        ]);
        execute(req, &mut rpc).unwrap();
        assert_eq!(calls.borrow()[1].1["repo"], "D:/projects/lixbon");
    }

    #[test]
    fn la_solicitud_de_attempt_consulta_el_estado_real_y_expone_la_aprobacion_desktop() {
        let calls = Rc::new(RefCell::new(Vec::<(String, Value)>::new()));
        let copy = calls.clone();
        let mut rpc = move |command: &str, args: &Value| {
            copy.borrow_mut().push((command.to_string(), args.clone()));
            match command {
                "projects_overview" => Ok(project_overview()),
                "task_create" => Ok(json!({
                    "status": "Committed", "run_id": "r-1", "task_id": "t-1", "attempt_id": "t-1-a1"
                })),
                "attempt_detail" => Ok(json!({
                    "v": 1, "core_model": "task_attempt_v1",
                    "attempt": {"id": "t-1-a1", "task_id": "t-1", "status": "pending_approval"}
                })),
                _ => Err(RpcFailure::Rejected(format!("inesperado: {command}"))),
            }
        };
        let req = request(&[
            "task",
            "create",
            "--project",
            "p-1",
            "--objective",
            "objetivo",
            "--title",
            "tarea",
            "--spec",
            "encargo",
            "--provider",
            "claude",
            "--profile",
            "explorar",
        ]);
        let (data, human) = execute(req, &mut rpc).unwrap();
        assert_eq!(data["attempt_id"], "t-1-a1");
        assert_eq!(data["attempt_status"], "pending_approval");
        assert_eq!(data["approval_required"], true);
        assert_eq!(data["approval_surface"], "desktop");
        assert!(human.contains("pendiente de aprobación en Desktop"));

        let calls = calls.borrow();
        assert_eq!(
            calls
                .iter()
                .map(|(command, _)| command.as_str())
                .collect::<Vec<_>>(),
            ["projects_overview", "task_create", "attempt_detail"]
        );
        let create = &calls[1].1;
        assert_eq!(create["attempt"]["provider"], "claude");
        assert_eq!(create["attempt"]["profile"], "explorar");
        assert!(create.get("host").is_none());
        assert!(create["attempt"].get("host").is_none());
    }

    #[test]
    fn las_respuestas_de_core_fuera_de_contrato_no_se_presentan_como_creacion_exitosa() {
        let mut rpc = |command: &str, _args: &Value| match command {
            "projects_overview" => Ok(project_overview()),
            "task_create" => Ok(json!({
                "status": "Committed", "run_id": "r-1", "task_id": "t-1", "attempt_id": "t-1-a1"
            })),
            "attempt_detail" => Ok(json!({
                "v": 1, "core_model": "task_attempt_v1",
                "attempt": {"id": "t-1-a1", "task_id": "t-1", "status": "running"}
            })),
            _ => unreachable!(),
        };
        let req = request(&[
            "task",
            "create",
            "--project",
            "p-1",
            "--objective",
            "o",
            "--title",
            "t",
            "--spec",
            "s",
            "--provider",
            "claude",
            "--profile",
            "explorar",
        ]);
        let (data, _) = execute(req, &mut rpc).unwrap();
        assert_eq!(data["attempt_status"], "running");
        assert_eq!(
            data["approval_required"], false,
            "no se presenta como pendiente si Core dice que ya avanzó"
        );
    }
}
