//! `lxo attempt handoff`: traspasa el trabajo de un Attempt terminado a otro agente (o a otra sesión
//! del mismo) llevando el contexto en un ContextPackage verificado (LXO-179, sobre `attempt_handoff`
//! de LXO-172). El Core decide la policy, valida el paquete y crea el Attempt; lxo solo prepara la
//! petición, enseña lo que se va a transferir y lo que el Core contesta.

use std::process::ExitCode;

use serde_json::{json, Value};

use crate::f5_support::{self, PreparedPackage, Rpc, SourceFacts};
use crate::projects::{self, Failure};
use crate::Args;

pub(super) const HELP: &str = "Uso: lxo attempt handoff <attempt_id> --provider P [opciones]

Traspasa el trabajo de un Attempt terminado a otro agente. Crea el Attempt siguiente de la MISMA
Task, de cero, con el contexto en un ContextPackage verificado: la sesión interna del proveedor
nunca se copia. El Attempt origen no se toca y sigue accesible. El Core decide la policy, valida
el paquete (que salga de ese Attempt y de ese Project) y no amplía lo que el agente puede hacer.

Opciones:
  --provider P               receptor; obligatorio. lxo no elige agente por ti. Puede ser el mismo
                             del origen (sesión nueva)
  --model M                  modelo; se hereda solo si el receptor es el mismo proveedor
  --effort E                 esfuerzo; se hereda solo si el receptor es el mismo proveedor
  --instruction TEXTO        qué quieres que haga el receptor con ese contexto
  --context-package sha256:… ContextPackage ya guardado que revisaste (`lxo context export` /
                             `lxo context import`). Sin él, el Core construye uno del worktree del origen
  --dry-run                  enseña origen, receptor, contexto, recursos y policy sin crear nada
  --json                     salida estructurada (v1)

Solo se traspasa el ÚLTIMO Attempt de la Task y cuando ya terminó (done, failed, stopped, exited);
si sigue en marcha, páralo antes con `lxo attempt stop <attempt_id> --confirm`. El host y la
estrategia del worktree no son opciones: el Core usa el Project de la Task en esta máquina y un
worktree nuevo. El Attempt nuevo queda pending_approval hasta que una persona lo apruebe en Lixbon
Desktop. Repetir la misma petición no crea otro Attempt: lxo muestra el que ya existe.

La respuesta dice qué viajó y qué se quedó fuera (sesión, revisión ausente, campos truncados,
adjuntos omitidos, valores redactados, pruebas sin evidencia). Con --dry-run y --context-package
enseña el resumen del paquete antes de que lo confirmes.

Códigos de salida: 0 correcto, 1 error interno, 2 uso, 3 autenticación o policy, 4 versión o
contrato, 5 Core no disponible, 6 Attempt, Task o paquete inexistente.
";

const CONTRACT: u64 = 1;
const FLAGS: [&str; 7] = [
    "provider",
    "model",
    "effort",
    "instruction",
    "context-package",
    "dry-run",
    "json",
];
const REASONS: [&str; 2] = ["provider_changed", "requested"];

#[derive(Debug, PartialEq, Eq)]
struct Request {
    source_attempt_id: String,
    provider: String,
    model: Option<String>,
    effort: Option<String>,
    instruction: Option<String>,
    context_package: Option<String>,
    dry_run: bool,
}

fn usage(message: impl Into<String>) -> Failure {
    Failure::Usage(message.into())
}

fn value_flag(a: &Args, key: &str) -> Result<Option<String>, Failure> {
    match a.flags.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => {
            Ok(Some(value.trim().to_string()))
        }
        _ => Err(usage(format!("--{key} requiere un valor."))),
    }
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
            "--{name} no es una opción de lxo attempt handoff. Mira `lxo attempt handoff --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["dry-run", "json", "help"] {
        if a.flags.get(name).is_some_and(|value| !value.is_boolean()) {
            return Err(usage(format!("--{name} no admite un valor.")));
        }
    }
    let source_attempt_id = match a.pos.get(2..) {
        Some([id]) if !id.trim().is_empty() => id.trim().to_string(),
        Some([]) => {
            return Err(usage(
                "Falta el origen: lxo attempt handoff <attempt_id> --provider P.",
            ))
        }
        _ => return Err(usage("lxo attempt handoff recibe un solo attempt_id.")),
    };
    let provider = value_flag(a, "provider")?
        .ok_or_else(|| usage("Falta --provider: lxo no elige el agente receptor por ti."))?
        .to_ascii_lowercase();
    let model = value_flag(a, "model")?;
    let effort = value_flag(a, "effort")?;
    if !f5_support::valid_provider(&provider)
        || [&model, &effort]
            .into_iter()
            .flatten()
            .any(|value| !f5_support::selection_text(value))
    {
        return Err(usage("La selección del receptor no es válida."));
    }
    let context_package = value_flag(a, "context-package")?;
    if context_package
        .as_deref()
        .is_some_and(|reference| !reference.starts_with("sha256:"))
    {
        return Err(usage(
            "--context-package de un traspaso es el id (sha256:…) de un paquete ya guardado: \
             si tienes un archivo, guárdalo antes con `lxo context import`.",
        ));
    }
    Ok(Some(Request {
        source_attempt_id,
        provider,
        model,
        effort,
        instruction: value_flag(a, "instruction")?,
        context_package,
        dry_run: a.b("dry-run"),
    }))
}

/// A qué receptor irá el trabajo. El modelo y el esfuerzo son del proveedor: con otro receptor no se
/// heredan; con el mismo, sí. Lo decide el Core; esto solo lo enseña en la previsualización.
fn target(source: &SourceFacts, request: &Request) -> Value {
    let same_provider = source.attempt["provider"].as_str() == Some(request.provider.as_str());
    let inherit = |own: &Option<String>, field: &str| match own {
        Some(value) => json!(value),
        None if same_provider => source.attempt[field].clone(),
        None => Value::Null,
    };
    json!({
        "provider": request.provider,
        "model": inherit(&request.model, "model"),
        "effort": inherit(&request.effort, "effort"),
    })
}

fn contract_error(what: &str) -> Failure {
    Failure::Version(format!(
        "El Core devolvió {what} que este lxo no entiende; actualiza Lixbon."
    ))
}

fn execute(request: Request, rpc: &mut Rpc<'_>) -> Result<Value, Failure> {
    let source = f5_support::source(rpc, &request.source_attempt_id)?;
    let status = source.attempt["status"].as_str().unwrap_or("desconocido");
    if !f5_support::FINAL_STATUSES.contains(&status) {
        return Err(usage(format!(
            "Solo se traspasa un Attempt terminado y {} está «{status}»: páralo antes con \
             `lxo attempt stop {} --confirm`.",
            source.attempt_id, source.attempt_id
        )));
    }
    let package: Option<PreparedPackage> =
        f5_support::context_package(request.context_package.as_deref(), None, &source, rpc)?;
    let target = target(&source, &request);
    let package_id = package
        .as_ref()
        .map(|package| json!(package.package_id))
        .unwrap_or(Value::Null);

    if request.dry_run {
        let resource = f5_support::resource_facts(rpc, &source)?;
        let policy =
            f5_support::policy_for(rpc, json!({ "attempt_id": source.attempt_id }), "start")?;
        return Ok(json!({
            "v": CONTRACT,
            "command": "handoff",
            "status": "dry_run",
            "source": f5_support::source_preview(&source),
            "target": target,
            "instruction": request.instruction.is_some(),
            "context": {
                "strategy": "context_package",
                "package_id": package_id,
                "built_by": if package.is_some() { "stored" } else { "core" },
                "summary": package.as_ref().map(|package| package.summary.clone()),
            },
            "resource": resource,
            "policy": policy,
            "worktree": { "host": "local", "strategy": "own" },
        }));
    }

    let mut args = json!({
        "task_id": source.task_id,
        "from_attempt_id": source.attempt_id,
        "provider": request.provider,
    });
    for (key, value) in [
        ("model", &request.model),
        ("effort", &request.effort),
        ("instruction", &request.instruction),
    ] {
        if let Some(value) = value {
            args[key] = json!(value);
        }
    }
    if let Some(package) = &package {
        args["package_id"] = json!(package.package_id);
    }
    let result = f5_support::send("attempt_handoff", &args, rpc)?;
    let outcome = result["status"]
        .as_str()
        .filter(|status| matches!(*status, "Requested" | "Replayed"))
        .ok_or_else(|| contract_error("una respuesta de traspaso"))?;
    let attempt_id = result["attempt_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| contract_error("un traspaso sin el Attempt creado"))?;
    let attempt_status = result["attempt_status"]
        .as_str()
        .filter(|status| f5_support::ATTEMPT_STATUSES.contains(status))
        .ok_or_else(|| contract_error("un estado de Attempt desconocido"))?;
    let reason = result["reason"]
        .as_str()
        .filter(|reason| REASONS.contains(reason))
        .ok_or_else(|| contract_error("un motivo de traspaso desconocido"))?;
    let result_package_id = result["package_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| contract_error("un traspaso sin la identidad del paquete"))?;
    if result["task_id"].as_str() != Some(source.task_id.as_str())
        || result["source_attempt_id"].as_str() != Some(source.attempt_id.as_str())
        || result["strategy"].as_str() != Some("context_package")
    {
        return Err(contract_error(
            "un traspaso de otro Attempt o con otra estrategia",
        ));
    }
    if let Some(package) = &package {
        if package.package_id != result_package_id {
            return Err(Failure::Version(
                "El Core usó un ContextPackage distinto del solicitado.".into(),
            ));
        }
    }
    let approval_required = attempt_status == "pending_approval";
    let link = f5_support::attempt_link(rpc, &source.project_id, &source.task_id, attempt_id);
    Ok(json!({
        "v": CONTRACT,
        "command": "handoff",
        "status": outcome,
        "task_id": source.task_id,
        "project_id": source.project_id,
        "source_attempt_id": source.attempt_id,
        "attempt_id": attempt_id,
        "attempt_status": attempt_status,
        "approval_required": approval_required,
        "approval_surface": if approval_required { Some("desktop") } else { None },
        "target": target,
        "strategy": "context_package",
        "reason": reason,
        "package_id": result_package_id,
        "transfer": result["transfer"],
        "provenance": {
            "source_attempt_id": source.attempt_id,
            "strategy": "context_package",
            "reason": reason,
            "package_id": result_package_id,
        },
        "link": link,
    }))
}

/// «provider_session, truncated» a partir de `transfer.left_out`.
fn left_out(transfer: &Value) -> String {
    transfer["left_out"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["code"].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn human(data: &Value) -> String {
    if data["status"] == "dry_run" {
        let context = &data["context"];
        let package = match context["package_id"].as_str() {
            Some(id) => format!("el paquete guardado {id}"),
            None => "un paquete que el Core construirá del worktree del origen".to_string(),
        };
        return format!(
            "Previsualización de traspaso de {} ({}) → {} / {} · contexto: {package} · policy start: {}. \
             No se creó ningún Attempt.",
            data["source"]["attempt_id"].as_str().unwrap_or(""),
            data["source"]["provider"].as_str().unwrap_or(""),
            data["target"]["provider"].as_str().unwrap_or(""),
            data["target"]["model"].as_str().unwrap_or("modelo por defecto"),
            data["policy"]["category"]["level"]
                .as_str()
                .unwrap_or("desconocida"),
        );
    }
    let verb = if data["status"] == "Replayed" {
        "ya existía"
    } else {
        "creado"
    };
    let mut text = format!(
        "Traspaso {} → {} {verb} · Task {} · receptor {} ({}) · estado actual en Core: {}.",
        data["source_attempt_id"].as_str().unwrap_or(""),
        data["attempt_id"].as_str().unwrap_or(""),
        data["task_id"].as_str().unwrap_or(""),
        data["target"]["provider"].as_str().unwrap_or(""),
        if data["reason"] == "provider_changed" {
            "otro proveedor"
        } else {
            "mismo proveedor, sesión nueva"
        },
        data["attempt_status"].as_str().unwrap_or("desconocido"),
    );
    let out = left_out(&data["transfer"]);
    if !out.is_empty() {
        text.push_str(&format!(" Se quedó fuera: {out}."));
    }
    if let Some(link) = data["link"].as_str() {
        text.push_str(&format!(" Enlace: {link}"));
    }
    if data["approval_required"] == true {
        text.push_str(" Apruébalo o recházalo en Lixbon Desktop.");
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

    type Calls = Rc<RefCell<Vec<(String, Value)>>>;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|value| value.to_string()).collect())
    }

    fn request(raw: &[&str]) -> Request {
        parse(&args(raw)).unwrap().unwrap()
    }

    fn source_attempt(status: &str) -> Value {
        json!({
            "v": 1,
            "core_model": "task_attempt_v1",
            "attempt": {
                "id": "t1-a1", "task_id": "t1", "provider": "claude", "model": "sonnet",
                "effort": "high", "role": "implementar", "status": status,
                "worktree": {"branch": "feature", "state": "active", "machine": null}
            }
        })
    }

    fn task() -> Value {
        json!({"v": 2, "core_model": "task_attempt_v1", "task": {
            "id": "t1", "project_id": "p1", "state": "failed"
        }})
    }

    fn summary() -> Value {
        json!({"objective": "arreglar el parser", "decisions": 2, "tests": 0})
    }

    fn package_preview(source_attempt: &str) -> Value {
        json!({
            "v": 1, "status": "valid", "package_id": "sha256:aaa",
            "package": {
                "source": {"attempt_id": source_attempt, "task_id": "t1", "project_id": "p1"},
                "revision": {"base_commit": "b", "head_commit": "h", "head_tree": "t", "branch": "feature"}
            },
            "summary": summary(),
        })
    }

    struct Core {
        source_status: &'static str,
        handoff: Value,
        package_source: &'static str,
        link: Result<Value, String>,
    }

    impl Core {
        fn new() -> Self {
            Self {
                source_status: "failed",
                handoff: json!({
                    "status": "Requested", "task_id": "t1", "attempt_id": "t1-a2",
                    "source_attempt_id": "t1-a1", "attempt_status": "pending_approval",
                    "strategy": "context_package", "reason": "provider_changed",
                    "package_id": "sha256:aaa",
                    "transfer": {
                        "carried": {"objective": true},
                        "left_out": [
                            {"code": "provider_session", "detail": "no se copia"},
                            {"code": "test_results_absent"}
                        ],
                        "summary": summary()
                    }
                }),
                package_source: "t1-a1",
                link: Ok(json!({
                    "status": "ready",
                    "canonical": "lixbon://project/p1/task/t1/attempt/t1-a2"
                })),
            }
        }

        fn rpc(self, calls: Calls) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
            move |cmd, args| {
                calls.borrow_mut().push((cmd.to_string(), args.clone()));
                match cmd {
                    "attempt_detail" => Ok(source_attempt(self.source_status)),
                    "task_detail_v2" => Ok(task()),
                    "context_package_get" => Ok(json!({
                        "status": "valid", "package": {"v": 1, "marker": "stored"}
                    })),
                    "context_package_preview" => Ok(package_preview(self.package_source)),
                    "resource_inspect" => Ok(json!({
                        "v": 1, "task_id": "t1", "worktree": {"state": "present", "dirty": false}
                    })),
                    "policy_effective" => Ok(json!({
                        "v": 1, "revision": 3, "actor": {"class": "cli_person"},
                        "categories": [
                            {"category": "fork", "level": "confirm", "source": "baseline"},
                            {"category": "start", "level": "confirm", "source": "baseline"}
                        ]
                    })),
                    "attempt_handoff" => match &self.handoff {
                        Value::String(message) => Err(RpcFailure::Rejected(message.clone())),
                        other => Ok(other.clone()),
                    },
                    "deep_link_generate" => self.link.clone().map_err(RpcFailure::Rejected),
                    _ => panic!("RPC inesperado: {cmd}"),
                }
            }
        }
    }

    fn calls() -> Calls {
        Rc::new(RefCell::new(Vec::new()))
    }

    fn sent(calls: &Calls, cmd: &str) -> Option<Value> {
        calls
            .borrow()
            .iter()
            .find(|(name, _)| name == cmd)
            .map(|(_, args)| args.clone())
    }

    #[test]
    fn parse_exige_receptor_y_rechaza_lo_que_el_core_no_acepta() {
        assert!(parse(&args(&["attempt", "handoff", "t1-a1"])).is_err());
        for flag in [
            "--host",
            "--worktree-strategy",
            "--profile",
            "--session",
            "--confirm",
            "--request-id",
            "--wait",
        ] {
            let raw = [
                "attempt",
                "handoff",
                "t1-a1",
                "--provider",
                "codex",
                flag,
                "x",
            ];
            assert!(parse(&args(&raw)).is_err(), "{flag}");
        }
        assert!(parse(&args(&["attempt", "handoff", "--provider", "codex"])).is_err());
        assert!(parse(&args(&[
            "attempt",
            "handoff",
            "t1-a1",
            "t1-a2",
            "--provider",
            "codex"
        ]))
        .is_err());
        assert!(parse(&args(&[
            "attempt",
            "handoff",
            "t1-a1",
            "--provider",
            "codex",
            "--provider",
            "claude"
        ]))
        .is_err());
        assert!(parse(&args(&["attempt", "handoff", "t1-a1", "--help"]))
            .unwrap()
            .is_none());
    }

    #[test]
    fn el_paquete_de_un_traspaso_es_un_id_guardado_no_un_archivo() {
        let error = parse(&args(&[
            "attempt",
            "handoff",
            "t1-a1",
            "--provider",
            "codex",
            "--context-package",
            "paquete.json",
        ]))
        .unwrap_err();
        assert!(error.message().contains("lxo context import"));
        let ok = request(&[
            "attempt",
            "handoff",
            "t1-a1",
            "--provider",
            "Codex",
            "--context-package",
            "sha256:aaa",
        ]);
        assert_eq!(ok.provider, "codex", "el proveedor se normaliza");
        assert_eq!(ok.context_package.as_deref(), Some("sha256:aaa"));
    }

    #[test]
    fn traspasar_a_otro_proveedor_envia_solo_lo_pedido_y_conserva_la_procedencia() {
        let calls = calls();
        let mut rpc = Core::new().rpc(calls.clone());
        let result = execute(
            request(&["attempt", "handoff", "t1-a1", "--provider", "codex"]),
            &mut rpc,
        )
        .unwrap();
        let sent = sent(&calls, "attempt_handoff").unwrap();
        assert_eq!(
            sent,
            json!({"task_id": "t1", "from_attempt_id": "t1-a1", "provider": "codex"}),
            "sin modelo, esfuerzo, instrucción, paquete ni confirm: el Core no los acepta"
        );
        assert_eq!(result["status"], "Requested");
        assert_eq!(result["attempt_id"], "t1-a2");
        assert_eq!(result["attempt_status"], "pending_approval");
        assert_eq!(result["approval_required"], true);
        assert_eq!(result["approval_surface"], "desktop");
        assert_eq!(result["reason"], "provider_changed");
        assert_eq!(result["strategy"], "context_package");
        assert_eq!(result["provenance"]["source_attempt_id"], "t1-a1");
        assert_eq!(result["provenance"]["package_id"], "sha256:aaa");
        assert_eq!(
            result["target"],
            json!({"provider": "codex", "model": null, "effort": null}),
            "con otro receptor no se hereda el modelo"
        );
        assert_eq!(result["link"], "lixbon://project/p1/task/t1/attempt/t1-a2");
        assert_eq!(
            result["transfer"]["left_out"][0]["code"],
            "provider_session"
        );
        let text = human(&result);
        assert!(text.contains("otro proveedor"), "{text}");
        assert!(
            text.contains("Se quedó fuera: provider_session, test_results_absent"),
            "{text}"
        );
        assert!(text.contains("Apruébalo"), "{text}");
        assert!(
            text.contains("lixbon://project/p1/task/t1/attempt/t1-a2"),
            "{text}"
        );
    }

    #[test]
    fn el_mismo_proveedor_hereda_modelo_y_esfuerzo_y_envia_instruccion_y_paquete() {
        let calls = calls();
        let mut core = Core::new();
        core.handoff["reason"] = json!("requested");
        let mut rpc = core.rpc(calls.clone());
        let result = execute(
            request(&[
                "attempt",
                "handoff",
                "t1-a1",
                "--provider",
                "claude",
                "--instruction",
                "termina los tests",
                "--context-package",
                "sha256:aaa",
                "--effort",
                "low",
            ]),
            &mut rpc,
        )
        .unwrap();
        let sent = sent(&calls, "attempt_handoff").unwrap();
        assert_eq!(sent["instruction"], "termina los tests");
        assert_eq!(sent["package_id"], "sha256:aaa");
        assert_eq!(sent["effort"], "low");
        assert!(sent.get("model").is_none());
        assert_eq!(
            result["target"],
            json!({"provider": "claude", "model": "sonnet", "effort": "low"}),
            "el mismo proveedor hereda el modelo; el esfuerzo pedido manda"
        );
        assert_eq!(result["reason"], "requested");
        assert!(human(&result).contains("mismo proveedor, sesión nueva"));
        assert!(
            calls
                .borrow()
                .iter()
                .any(|(cmd, _)| cmd == "context_package_get"),
            "el paquete se lee del Core y se verifica antes de enviarlo"
        );
    }

    #[test]
    fn dry_run_enseña_el_resumen_del_paquete_y_no_crea_nada() {
        let calls = calls();
        let mut rpc = Core::new().rpc(calls.clone());
        let result = execute(
            request(&[
                "attempt",
                "handoff",
                "t1-a1",
                "--provider",
                "codex",
                "--context-package",
                "sha256:aaa",
                "--dry-run",
            ]),
            &mut rpc,
        )
        .unwrap();
        assert_eq!(result["status"], "dry_run");
        assert_eq!(result["context"]["package_id"], "sha256:aaa");
        assert_eq!(result["context"]["built_by"], "stored");
        assert_eq!(
            result["context"]["summary"]["objective"],
            "arreglar el parser"
        );
        assert_eq!(result["policy"]["category"]["category"], "start");
        assert_eq!(result["resource"]["task_id"], "t1");
        assert_eq!(result["source"]["attempt_id"], "t1-a1");
        assert!(sent(&calls, "attempt_handoff").is_none());
        assert!(sent(&calls, "deep_link_generate").is_none());
        assert!(human(&result).contains("No se creó ningún Attempt"));
    }

    #[test]
    fn dry_run_sin_paquete_dice_que_lo_construye_el_core() {
        let mut rpc = Core::new().rpc(calls());
        let result = execute(
            request(&[
                "attempt",
                "handoff",
                "t1-a1",
                "--provider",
                "codex",
                "--dry-run",
            ]),
            &mut rpc,
        )
        .unwrap();
        assert!(result["context"]["package_id"].is_null());
        assert_eq!(result["context"]["built_by"], "core");
        assert!(result["context"]["summary"].is_null());
        assert!(human(&result).contains("construirá"));
    }

    #[test]
    fn un_attempt_que_sigue_en_marcha_no_se_traspasa_ni_se_pide_al_core() {
        for status in ["running", "starting", "pending_approval", "waiting"] {
            let calls = calls();
            let mut core = Core::new();
            core.source_status = status;
            let mut rpc = core.rpc(calls.clone());
            let error = execute(
                request(&["attempt", "handoff", "t1-a1", "--provider", "codex"]),
                &mut rpc,
            )
            .unwrap_err();
            assert!(matches!(error, Failure::Usage(_)), "{status}");
            assert!(error.message().contains("lxo attempt stop"), "{status}");
            assert!(sent(&calls, "attempt_handoff").is_none(), "{status}");
        }
    }

    #[test]
    fn un_paquete_de_otro_attempt_se_rechaza_antes_de_enviar() {
        let calls = calls();
        let mut core = Core::new();
        core.package_source = "t9-a1";
        let mut rpc = core.rpc(calls.clone());
        let error = execute(
            request(&[
                "attempt",
                "handoff",
                "t1-a1",
                "--provider",
                "codex",
                "--context-package",
                "sha256:aaa",
            ]),
            &mut rpc,
        )
        .unwrap_err();
        assert!(matches!(error, Failure::Usage(_)));
        assert!(sent(&calls, "attempt_handoff").is_none());
    }

    #[test]
    fn repetir_la_peticion_muestra_el_attempt_que_ya_existe() {
        let mut core = Core::new();
        core.handoff["status"] = json!("Replayed");
        core.handoff["attempt_status"] = json!("running");
        core.handoff["transfer"] = Value::Null;
        let mut rpc = core.rpc(calls());
        let result = execute(
            request(&["attempt", "handoff", "t1-a1", "--provider", "codex"]),
            &mut rpc,
        )
        .unwrap();
        assert_eq!(result["status"], "Replayed");
        assert_eq!(result["approval_required"], false);
        assert!(result["approval_surface"].is_null());
        assert!(result["transfer"].is_null());
        let text = human(&result);
        assert!(text.contains("ya existía"), "{text}");
        assert!(!text.contains("Apruébalo"), "{text}");
        assert!(!text.contains("Se quedó fuera"), "{text}");
    }

    #[test]
    fn un_enlace_que_no_se_puede_generar_no_estropea_un_traspaso_hecho() {
        let mut core = Core::new();
        core.link = Err("Comando desconocido: deep_link_generate".into());
        let mut rpc = core.rpc(calls());
        let result = execute(
            request(&["attempt", "handoff", "t1-a1", "--provider", "codex"]),
            &mut rpc,
        )
        .unwrap();
        assert!(result["link"].is_null());
        assert_eq!(result["attempt_id"], "t1-a2");
        assert!(!human(&result).contains("Enlace"));
    }

    #[test]
    fn las_respuestas_incoherentes_del_core_son_un_error_de_contrato() {
        let cases: [(&str, Value); 6] = [
            ("status", json!("Other")),
            ("attempt_id", json!("")),
            ("attempt_status", json!("raro")),
            ("reason", json!("sin_motivo")),
            ("source_attempt_id", json!("t9-a1")),
            ("strategy", json!("clean")),
        ];
        for (field, value) in cases {
            let mut core = Core::new();
            core.handoff[field] = value;
            let mut rpc = core.rpc(calls());
            let error = execute(
                request(&["attempt", "handoff", "t1-a1", "--provider", "codex"]),
                &mut rpc,
            )
            .unwrap_err();
            assert!(matches!(error, Failure::Version(_)), "{field}: {error:?}");
        }
        let mut core = Core::new();
        core.handoff["package_id"] = json!("sha256:otro");
        let mut rpc = core.rpc(calls());
        let error = execute(
            request(&[
                "attempt",
                "handoff",
                "t1-a1",
                "--provider",
                "codex",
                "--context-package",
                "sha256:aaa",
            ]),
            &mut rpc,
        )
        .unwrap_err();
        assert!(
            matches!(error, Failure::Version(_)),
            "paquete distinto del pedido"
        );
    }

    #[test]
    fn los_rechazos_del_core_salen_con_su_codigo_de_uso_y_policy() {
        let cases = [
            (
                "solo se traspasa el último Attempt de la Task: el actual es t1-a3",
                2,
            ),
            (
                "attempt_handoff_conflict: t1-a2 ya existe con otra intención",
                2,
            ),
            (
                "context_package_source_mismatch: el paquete no es de este Attempt",
                2,
            ),
            ("context_store_not_found: no hay el paquete sha256:aaa", 6),
            ("policy_denied: la policy niega «start» para cli_person", 3),
            (
                "traspasar un Attempt solo está permitido a una Person autenticada",
                3,
            ),
            (
                "model_auth_required: solo una Person autenticada puede leer el modelo Task/Attempt",
                3,
            ),
            ("provider_environment_blocked: falta la credencial", 5),
            ("provider_unknown: nadie se llama así", 2),
            (
                "traspasar un Attempt requiere el lifecycle de lanzamiento verificado",
                5,
            ),
            (
                "la instrucción contiene un delimitador reservado del traspaso",
                2,
            ),
        ];
        for (message, exit) in cases {
            let mut core = Core::new();
            core.handoff = json!(message);
            let mut rpc = core.rpc(calls());
            let error = execute(
                request(&["attempt", "handoff", "t1-a1", "--provider", "codex"]),
                &mut rpc,
            )
            .unwrap_err();
            assert_eq!(error.code().1, exit, "{message}: {error:?}");
        }
    }
}
