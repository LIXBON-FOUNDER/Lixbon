//! `lxo projects`: overview multiproyecto de solo lectura (LXO-103).
//!
//! Los datos vienen de `projects_overview` (LXO-90) por el RPC autenticado: Projects por `project_id`,
//! contadores de Tasks y Attention y el estado agregado que fija el Core. La ruta es metadato: lxo no
//! agrupa por carpeta ni mira el cwd.

use std::process::ExitCode;

use serde_json::{json, Map, Value};

use crate::client_auth::{self, EventRequestFailure, RpcFailure};
use crate::events::clean;
use crate::Args;

pub(super) const HELP: &str = "Uso: lxo projects [--archived exclude|include|only] [--machine ID] [--json]

Los proyectos que conoce el Core de Lixbon, con su estado y lo que tienen en
marcha. Solo lee: registrar, unir, relocalizar o archivar lo decide una persona
desde Lixbon.

Filtros:
  --archived M       exclude (defecto) oculta los archivados, include los suma, only solo ellos
  --all              atajo de --archived include
  --machine ID       solo proyectos con alguna ubicación en esa máquina (enseña todas sus ubicaciones)

Salida:
  (por defecto)      por proyecto: nombre y estado, id, contadores de tareas y Attention, y
                     sus ubicaciones; al final, lo que aún no tiene proyecto
  --json             el documento del Core en una línea: {v, filters, total, projects, unassigned}
                     con ids y contadores (códigos, sin textos traducidos)

Es para personas: una tarea del orquestador (agente) no puede leer el overview.

Códigos de salida: 0 correcto, 1 error interno del Core, 2 uso o filtro inválido,
3 autenticación o identidad sin permiso, 4 versión o contrato incompatible,
5 Lixbon cerrado, orquestador desactivado o Core no disponible.
";

const CONTRACT: u64 = 1;
const FLAGS: [&str; 5] = ["archived", "all", "machine", "json", "help"];

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    Internal(String),
    Usage(String),
    Auth(String),
    Version(String),
    Unavailable(String),
}

impl Failure {
    fn code(&self) -> (&'static str, u8) {
        match self {
            Failure::Internal(_) => ("internal", 1),
            Failure::Usage(_) => ("usage", 2),
            Failure::Auth(_) => ("authentication", 3),
            Failure::Version(_) => ("version", 4),
            Failure::Unavailable(_) => ("core_unavailable", 5),
        }
    }

    fn message(&self) -> &str {
        match self {
            Failure::Internal(m)
            | Failure::Usage(m)
            | Failure::Auth(m)
            | Failure::Version(m)
            | Failure::Unavailable(m) => m,
        }
    }
}

enum Request {
    Help,
    Overview(Map<String, Value>),
}

fn usage(message: impl Into<String>) -> Failure {
    Failure::Usage(message.into())
}

fn parse(a: &Args) -> Result<Request, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    if let Some(extra) = a.at(1) {
        return Err(usage(format!(
            "lxo projects no admite argumentos sueltos ({extra}). Mira `lxo projects --help`."
        )));
    }
    if let Some(name) = a.flags.keys().find(|k| !FLAGS.contains(&k.as_str())) {
        return Err(usage(format!(
            "--{name} no es una opción de lxo projects. Mira `lxo projects --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["all", "json", "help"] {
        if a.flags.get(name).is_some_and(|v| !v.is_boolean()) {
            return Err(usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }
    let mut args = Map::new();
    for name in ["archived", "machine"] {
        match a.flags.get(name) {
            None => {}
            Some(Value::String(v)) if !v.trim().is_empty() => {
                args.insert(name.into(), Value::String(v.trim().to_string()));
            }
            _ => return Err(usage(format!("--{name} requiere un valor."))),
        }
    }
    if a.b("all") {
        if args.contains_key("archived") {
            return Err(usage(
                "--all ya es --archived include: usa solo uno de los dos.",
            ));
        }
        args.insert("archived".into(), json!("include"));
    }
    Ok(Request::Overview(args))
}

/// Traduce los fallos del transporte y del Core a mensaje y código de salida.
fn failure(error: RpcFailure) -> Failure {
    match error {
        RpcFailure::Transport(EventRequestFailure::Network(m))
        | RpcFailure::Transport(EventRequestFailure::CoreUnavailable(m)) => Failure::Unavailable(m),
        RpcFailure::Transport(EventRequestFailure::Authentication(m)) => Failure::Auth(m),
        RpcFailure::Transport(EventRequestFailure::Version(m)) => Failure::Version(m),
        RpcFailure::Transport(EventRequestFailure::Internal(m)) => Failure::Internal(m),
        RpcFailure::Rejected(m) => {
            if let Some(detail) = m.strip_prefix("projects_overview_invalid_request: ") {
                usage(format!("El Core rechazó la consulta: {detail}."))
            } else if m.starts_with("projects_overview_auth_required") {
                Failure::Auth(
                    "El overview de proyectos es solo para personas: una tarea del orquestador (agente) no puede leerlo.".into(),
                )
            } else if m.starts_with("projects_overview_unavailable") {
                Failure::Unavailable(
                    "El Core de Lixbon no tiene su almacén abierto; reinicia Lixbon.".into(),
                )
            } else if m.starts_with("Comando desconocido") {
                Failure::Version(
                    "Este Core no ofrece el overview de proyectos; actualiza Lixbon.".into(),
                )
            } else {
                Failure::Internal(m)
            }
        }
    }
}

/// El overview v1: `{v, filters, total, projects, unassigned}`.
fn check(data: Value) -> Result<Value, Failure> {
    if data["v"].as_u64() != Some(CONTRACT)
        || !data["projects"].is_array()
        || !data["unassigned"].is_object()
    {
        return Err(Failure::Version(
            "El Core devolvió un overview de proyectos que este lxo no entiende; actualiza Lixbon."
                .into(),
        ));
    }
    Ok(data)
}

fn status_text(code: &str) -> String {
    match code {
        "failed" => "con fallos".into(),
        "attention" => "necesita atención".into(),
        "active" => "en curso".into(),
        "idle" => "en reposo".into(),
        other => clean(other),
    }
}

fn category_text(code: &str) -> String {
    match code {
        "question" => "pregunta".into(),
        "approval" => "aprobación".into(),
        "review_ready" => "lista para revisar".into(),
        "conflict" => "conflicto".into(),
        "failed" => "fallo".into(),
        "environment_blocked" => "entorno bloqueado".into(),
        "risk" => "riesgo".into(),
        other => clean(other),
    }
}

fn n(value: &Value) -> u64 {
    value.as_u64().unwrap_or(0)
}

/// «4 tareas · 2 activas · 1 fallida · 3 attention (1 pregunta, 2 fallo)»
fn counts_text(counts: &Value) -> String {
    let plural = |n: u64, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut text = [
        plural(n(&counts["tasks"]), "tarea", "tareas"),
        plural(n(&counts["active"]), "activa", "activas"),
        plural(n(&counts["failed"]), "fallida", "fallidas"),
        format!("{} attention", n(&counts["attention"]["total"])),
    ]
    .join(" · ");
    if let Some(by) = counts["attention"]["by_category"].as_object() {
        let parts: Vec<String> = by
            .iter()
            .filter(|(_, v)| n(v) > 0)
            .map(|(k, v)| format!("{} {}", n(v), category_text(k)))
            .collect();
        if !parts.is_empty() {
            text.push_str(&format!(" ({})", parts.join(", ")));
        }
    }
    text
}

fn project_block(p: &Value) -> String {
    let mut head = format!(
        "{} · {}",
        p["name"]
            .as_str()
            .map(clean)
            .unwrap_or_else(|| "(sin nombre)".into()),
        status_text(p["status"].as_str().unwrap_or("?"))
    );
    if p["state"].as_str() == Some("archived") {
        head.push_str(" · archivado");
    }
    let mut lines = vec![
        head,
        format!("  id {}", p["id"].as_str().map(clean).unwrap_or_default()),
        format!("  {}", counts_text(&p["counts"])),
    ];
    let locations = p["locations"].as_array().cloned().unwrap_or_default();
    if locations.is_empty() {
        lines.push("  sin ubicaciones".into());
    }
    for l in &locations {
        let mut line = format!("  {}", l["path"].as_str().map(clean).unwrap_or_default());
        if l["primary"].as_bool() == Some(true) {
            line.push_str(" [principal]");
        }
        if l["state"].as_str() == Some("missing") {
            line.push_str(" (no existe)");
        }
        if let Some(machine) = l["machine"].as_str() {
            line.push_str(&format!(" · máquina {}", clean(machine)));
        }
        lines.push(line);
    }
    lines.join("\n")
}

fn overview_text(data: &Value) -> String {
    let projects = data["projects"].as_array().cloned().unwrap_or_default();
    let mut blocks: Vec<String> = projects.iter().map(project_block).collect();
    if blocks.is_empty() {
        blocks.push(match (data["filters"]["archived"].as_str(), data["filters"]["machine"].as_str()) {
            (_, Some(machine)) => format!("Ningún proyecto tiene ubicaciones en la máquina {}.", clean(machine)),
            (Some("only"), _) => "Sin proyectos archivados.".into(),
            _ => "Sin proyectos registrados. Se registran desde Lixbon (o al lanzar un run en un repositorio).".into(),
        });
    }
    let unassigned = &data["unassigned"];
    if n(&unassigned["tasks"]) > 0 || n(&unassigned["attention"]["total"]) > 0 {
        blocks.push(format!("Sin proyecto: {}", counts_text(unassigned)));
    }
    blocks.join("\n\n")
}

fn execute(request: Request, json: bool) -> Result<(), Failure> {
    match request {
        Request::Help => print!("{HELP}"),
        Request::Overview(args) => {
            let data = client_auth::rpc("projects_overview", &Value::Object(args), &crate::cwd())
                .map_err(failure)
                .and_then(check)?;
            if json {
                println!("{data}");
            } else {
                println!("{}", overview_text(&data));
            }
        }
    }
    Ok(())
}

pub(super) fn run(a: &Args) -> ExitCode {
    let json = a.b("json");
    match parse(a).and_then(|request| execute(request, json)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            let (code, exit) = failure.code();
            if json {
                eprintln!(
                    "{}",
                    json!({ "ok": false, "code": code, "error": failure.message() })
                );
            } else {
                eprintln!("lxo: {}", failure.message());
            }
            ExitCode::from(exit)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|s| s.to_string()).collect())
    }

    fn overview_args(raw: &[&str]) -> Result<Value, Failure> {
        match parse(&args(raw))? {
            Request::Overview(map) => Ok(Value::Object(map)),
            Request::Help => panic!("se esperaba el overview"),
        }
    }

    fn by_category(pairs: &[(&str, u64)]) -> Value {
        let mut by = json!({ "question": 0, "approval": 0, "review_ready": 0, "conflict": 0,
            "failed": 0, "environment_blocked": 0, "risk": 0 });
        for (k, v) in pairs {
            by[*k] = json!(v);
        }
        by
    }

    fn data(projects: Vec<Value>, unassigned_tasks: u64) -> Value {
        json!({
            "v": 1, "filters": { "archived": "exclude", "machine": null }, "total": projects.len(),
            "projects": projects,
            "unassigned": { "tasks": unassigned_tasks, "active": unassigned_tasks, "failed": 0,
                "attention": { "total": 0, "by_category": by_category(&[]) } }
        })
    }

    fn lixbon() -> Value {
        json!({
            "id": "p-1", "name": "lixbon", "state": "active", "status": "failed",
            "counts": { "tasks": 4, "active": 2, "failed": 1,
                "attention": { "total": 3, "by_category": by_category(&[("question", 1), ("failed", 2)]) } },
            "locations": [
                { "machine": "m-casa", "path": "C:/r/lixbon", "primary": true, "state": "ok", "last_seen": 1 },
                { "machine": "m-casa", "path": "D:/viejo/lixbon", "primary": false, "state": "missing", "last_seen": 1 }
            ]
        })
    }

    #[test]
    fn filtros_van_al_core_con_sus_nombres_y_all_es_un_atajo() {
        assert_eq!(overview_args(&["projects"]).unwrap(), json!({}));
        assert_eq!(
            overview_args(&["projects", "--archived", "only", "--machine", "m1"]).unwrap(),
            json!({ "archived": "only", "machine": "m1" })
        );
        assert_eq!(
            overview_args(&["projects", "--all"]).unwrap(),
            json!({ "archived": "include" })
        );
        assert_eq!(
            overview_args(&["projects", "--all", "--json"]).unwrap(),
            json!({ "archived": "include" })
        );
    }

    #[test]
    fn uso_invalido_se_rechaza_antes_de_llamar_al_core() {
        for raw in [
            &["projects", "lixbon"][..],
            &["projects", "--estado", "x"],
            &["projects", "--machine"],
            &["projects", "--archived"],
            &["projects", "--all", "--archived", "only"],
            &["projects", "--machine", "a", "--machine", "b"],
            &["projects", "--json=si"],
        ] {
            let failure = parse(&args(raw))
                .err()
                .unwrap_or_else(|| panic!("{raw:?} debía fallar"));
            assert_eq!(failure.code().1, 2, "{raw:?}: {failure:?}");
        }
    }

    #[test]
    fn cada_fallo_tiene_su_codigo_de_salida() {
        let t = RpcFailure::Transport;
        let cases = [
            (t(EventRequestFailure::Network("cerrado".into())), 5),
            (
                t(EventRequestFailure::CoreUnavailable("sin core".into())),
                5,
            ),
            (
                t(EventRequestFailure::Authentication("credencial".into())),
                3,
            ),
            (t(EventRequestFailure::Version("protocolo".into())), 4),
            (t(EventRequestFailure::Internal("x".into())), 1),
            (
                RpcFailure::Rejected(
                    "projects_overview_invalid_request: `archived` no es válido".into(),
                ),
                2,
            ),
            (
                RpcFailure::Rejected("projects_overview_auth_required: solo Person".into()),
                3,
            ),
            (
                RpcFailure::Rejected("projects_overview_unavailable: sin almacén".into()),
                5,
            ),
            (
                RpcFailure::Rejected("Comando desconocido: projects_overview".into()),
                4,
            ),
            (
                RpcFailure::Rejected("projects_overview_read_failed: sqlite".into()),
                1,
            ),
        ];
        for (error, exit) in cases {
            let label = format!("{error:?}");
            assert_eq!(failure(error).code().1, exit, "{label}");
        }
        let agent = failure(RpcFailure::Rejected(
            "projects_overview_auth_required: x".into(),
        ));
        assert!(agent.message().contains("solo para personas"), "{agent:?}");
        assert_eq!(
            check(json!({ "v": 2, "projects": [] }))
                .unwrap_err()
                .code()
                .1,
            4
        );
    }

    #[test]
    fn snapshot_de_un_proyecto_con_fallos_y_attention() {
        assert_eq!(
            overview_text(&data(vec![lixbon()], 0)),
            "lixbon · con fallos\n  id p-1\n  4 tareas · 2 activas · 1 fallida · 3 attention (2 fallo, 1 pregunta)\n  C:/r/lixbon [principal] · máquina m-casa\n  D:/viejo/lixbon (no existe) · máquina m-casa"
        );
    }

    #[test]
    fn varios_proyectos_archivados_y_lo_que_no_tiene_proyecto() {
        let docs = json!({
            "id": "p-2", "name": "docs", "state": "archived", "status": "idle",
            "counts": { "tasks": 1, "active": 0, "failed": 0, "attention": { "total": 0, "by_category": by_category(&[]) } },
            "locations": []
        });
        let text = overview_text(&data(vec![lixbon(), docs], 2));
        assert!(text.contains("\n\ndocs · en reposo · archivado\n  id p-2\n  1 tarea · 0 activas · 0 fallidas · 0 attention\n  sin ubicaciones"), "{text}");
        assert!(
            text.ends_with("\n\nSin proyecto: 2 tareas · 2 activas · 0 fallidas · 0 attention"),
            "{text}"
        );
    }

    #[test]
    fn estado_vacio_segun_el_filtro() {
        let mut empty = data(vec![], 0);
        assert!(overview_text(&empty).starts_with("Sin proyectos registrados."));
        empty["filters"]["archived"] = json!("only");
        assert_eq!(overview_text(&empty), "Sin proyectos archivados.");
        empty["filters"]["machine"] = json!("m-oficina");
        assert_eq!(
            overview_text(&empty),
            "Ningún proyecto tiene ubicaciones en la máquina m-oficina."
        );
    }

    #[test]
    fn snapshot_json_conserva_ids_y_contadores_sin_textos() {
        let doc = check(data(vec![lixbon()], 0)).unwrap();
        assert_eq!(
            doc.to_string(),
            r#"{"filters":{"archived":"exclude","machine":null},"projects":[{"counts":{"active":2,"attention":{"by_category":{"approval":0,"conflict":0,"environment_blocked":0,"failed":2,"question":1,"review_ready":0,"risk":0},"total":3},"failed":1,"tasks":4},"id":"p-1","locations":[{"last_seen":1,"machine":"m-casa","path":"C:/r/lixbon","primary":true,"state":"ok"},{"last_seen":1,"machine":"m-casa","path":"D:/viejo/lixbon","primary":false,"state":"missing"}],"name":"lixbon","state":"active","status":"failed"}],"total":1,"unassigned":{"active":0,"attention":{"by_category":{"approval":0,"conflict":0,"environment_blocked":0,"failed":0,"question":0,"review_ready":0,"risk":0},"total":0},"failed":0,"tasks":0},"v":1}"#
        );
    }

    #[test]
    fn terminal_estrecha_lineas_cortas_y_sin_caracteres_de_control() {
        let mut raro = lixbon();
        raro["name"] = json!("evil\u{1b}[2J");
        let text = overview_text(&data(vec![raro], 0));
        assert!(text.starts_with("evil?[2J · con fallos"), "{text}");
        // Cada dato va en su propia línea: ninguna pasa de 80 columnas salvo una ruta larga.
        for line in text.lines().filter(|l| !l.contains(":/")) {
            assert!(line.chars().count() <= 80, "{line}");
        }
    }
}
