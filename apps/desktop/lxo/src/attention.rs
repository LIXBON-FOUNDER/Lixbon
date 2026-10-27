//! `lxo attention`: inbox global de Attention, de solo lectura (LXO-105).
//!
//! Lista y detalle vienen del Core (`attention_list` y `attention_detail`, LXO-89) por el RPC
//! autenticado. lxo no decide qué necesita atención ni su categoría o severidad: pagina con el
//! cursor opaco del Core, pasa sus filtros y traduce los códigos para leerlos.

use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::events::{clean, timestamp_utc};
use crate::Args;

pub(super) const HELP: &str = "Uso: lxo attention [filtros] [--json]
     lxo attention show <attention_id> [--json]

Lo que necesita atención ahora, según el Core de Lixbon (solo las activas, de la
más antigua a la más reciente). Solo lee: no resuelve, no pospone ni marca nada.

Filtros (se combinan con AND):
  --project ID
  --category question|approval|review_ready|conflict|failed|environment_blocked|risk
  --severity critical|high|medium|low
  --task ID          atajo de --target-kind task --target-id ID
  --attempt ID       atajo de --target-kind attempt --target-id ID (tras el corte
                     Task/Attempt, la Attention de ejecución apunta al intento)
  --target-kind K    --target-id ID

Paginación:
  Sin --limit ni --cursor recorre todas las páginas.
  --limit N          una sola página de N (máximo 500); si hay más, stderr sugiere --cursor
  --cursor C         la página siguiente: mismo --limit y mismos filtros que la anterior

Salida:
  (por defecto)      una línea por Attention: id, severidad, categoría, destino,
                     proyecto, edad y procedencia (run y ocurrencia)
  --json             {v, items, next_cursor, has_more, limit} en una línea; show da el item

Cada Attention se resuelve con el comando de su dominio (responder, aprobar,
revisar…), nunca a mano: `lxo attention show <id>` dice cuál. No hay --unread:
Attention es lo pendiente, no lo no leído.

Códigos de salida: 0 correcto, 1 error del Core o de conexión, 2 uso o filtro
inválido, 3 Attention inexistente o fuera de tu alcance.
";

/// Máximo de página del Core.
const PAGE: u64 = 500;
/// Tope de seguridad al recorrer todas las páginas (100 000 items).
const MAX_PAGES: usize = 200;
const CONTRACT: u64 = 1;

const LIST_FLAGS: [&str; 11] = [
    "project",
    "category",
    "severity",
    "task",
    "attempt",
    "target-kind",
    "target-id",
    "limit",
    "cursor",
    "json",
    "help",
];

#[derive(Debug, PartialEq, Eq)]
enum Failure {
    Usage(String),
    NotFound(String),
    Core(String),
}

impl Failure {
    fn code(&self) -> (&'static str, u8) {
        match self {
            Failure::Core(_) => ("core", 1),
            Failure::Usage(_) => ("usage", 2),
            Failure::NotFound(_) => ("not_found", 3),
        }
    }

    fn message(&self) -> &str {
        match self {
            Failure::Usage(m) | Failure::NotFound(m) | Failure::Core(m) => m,
        }
    }
}

#[derive(Debug, PartialEq)]
struct ListOptions {
    filters: Map<String, Value>,
    limit: Option<u64>,
    cursor: Option<String>,
}

enum Request {
    Help,
    List(ListOptions),
    Show(String),
}

fn usage(message: impl Into<String>) -> Failure {
    Failure::Usage(message.into())
}

fn text_flag(a: &Args, name: &str) -> Result<Option<String>, Failure> {
    match a.flags.get(name) {
        None => Ok(None),
        Some(Value::String(v)) if !v.trim().is_empty() => Ok(Some(v.trim().to_string())),
        _ => Err(usage(format!("--{name} requiere un valor."))),
    }
}

fn parse(a: &Args) -> Result<Request, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    if a.flags.contains_key("unread") {
        return Err(usage(
            "--unread no existe: el Core no tiene una fuente de no leídos separada, y Attention es lo pendiente, no lo no leído.",
        ));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["json", "help"] {
        if a.flags.get(name).is_some_and(|v| !v.is_boolean()) {
            return Err(usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }
    match a.at(1).as_deref() {
        None => parse_list(a).map(Request::List),
        Some("show") => {
            if let Some(name) = a.flags.keys().find(|k| !["json", "help"].contains(&k.as_str())) {
                return Err(usage(format!("`lxo attention show` no admite --{name}.")));
            }
            match (a.at(2), a.at(3)) {
                (Some(id), None) if !id.trim().is_empty() => Ok(Request::Show(id)),
                (None, _) => Err(usage("Falta el id: lxo attention show <attention_id>.")),
                _ => Err(usage("`lxo attention show` recibe un solo id.")),
            }
        }
        Some("resolve") => Err(usage(
            "`lxo attention resolve` aún no existe: el Core no ofrece una resolución genérica. Cada Attention se resuelve con el comando de su dominio; `lxo attention show <id>` dice cuál.",
        )),
        Some("snooze") => Err(usage(
            "`lxo attention snooze` aún no existe: el Core todavía no define cómo posponer una Attention.",
        )),
        Some(other) => Err(usage(format!(
            "Subcomando desconocido: {other}. Mira `lxo attention --help`."
        ))),
    }
}

fn parse_list(a: &Args) -> Result<ListOptions, Failure> {
    if let Some(name) = a.flags.keys().find(|k| !LIST_FLAGS.contains(&k.as_str())) {
        return Err(usage(format!(
            "--{name} no es un filtro de lxo attention. Mira `lxo attention --help`."
        )));
    }
    let mut filters = Map::new();
    for (flag, param) in [
        ("project", "project_id"),
        ("category", "category"),
        ("severity", "severity"),
        ("target-kind", "target_kind"),
        ("target-id", "target_id"),
    ] {
        if let Some(value) = text_flag(a, flag)? {
            filters.insert(param.into(), Value::String(value));
        }
    }
    for kind in ["task", "attempt"] {
        if let Some(id) = text_flag(a, kind)? {
            if filters.contains_key("target_kind") || filters.contains_key("target_id") {
                return Err(usage(format!(
                    "--{kind} ya fija --target-kind {kind} y --target-id: no se combina con ellos ni con --task/--attempt."
                )));
            }
            filters.insert("target_kind".into(), json!(kind));
            filters.insert("target_id".into(), Value::String(id));
        }
    }
    let limit = match text_flag(a, "limit")? {
        None => None,
        Some(text) => Some(
            text.parse::<u64>()
                .ok()
                .filter(|n| (1..=PAGE).contains(n))
                .ok_or_else(|| usage(format!("--limit debe ser un entero de 1 a {PAGE}.")))?,
        ),
    };
    Ok(ListOptions {
        filters,
        limit,
        cursor: text_flag(a, "cursor")?,
    })
}

/// Traduce los errores del Core a mensajes para la persona y a su código de salida.
fn core_failure(error: String, id: Option<&str>) -> Failure {
    if let Some(detail) = error.strip_prefix("attention_invalid_request: ") {
        return usage(format!("El Core rechazó la consulta: {detail}."));
    }
    if error.starts_with("attention_invalid_cursor") {
        return usage(
            "El cursor no vale para esta consulta (otros filtros o --limit, otra identidad o Lixbon se reinició). Empieza de nuevo sin --cursor.",
        );
    }
    if error.starts_with("attention_not_found") {
        return Failure::NotFound(format!(
            "No existe la Attention {} o no es visible para esta identidad.",
            id.unwrap_or("pedida")
        ));
    }
    if error.starts_with("attention_auth_required") {
        return Failure::Core(
            "Attention solo se lee con una identidad autenticada de Lixbon; vuelve a autenticar el CLI.".into(),
        );
    }
    Failure::Core(error)
}

fn contract_error() -> Failure {
    Failure::Core(
        "El Core devolvió Attention con un contrato que este lxo no entiende; actualiza Lixbon."
            .into(),
    )
}

/// Una página `{v, items, next_cursor, has_more, limit}` del contrato v1.
fn check_page(page: Value) -> Result<Value, Failure> {
    let has_more = page["has_more"].as_bool().ok_or_else(contract_error)?;
    if page["v"].as_u64() != Some(CONTRACT)
        || !page["items"].is_array()
        || (has_more && !page["next_cursor"].is_string())
    {
        return Err(contract_error());
    }
    Ok(page)
}

/// Lee la lista: una página si se pidió `--limit` o `--cursor`; si no, todas.
fn fetch_list(
    opts: &ListOptions,
    send: &mut dyn FnMut(&str, &Value) -> Result<Value, String>,
) -> Result<Value, Failure> {
    let request = |limit: Option<u64>, cursor: Option<&str>| {
        let mut args = opts.filters.clone();
        if let Some(limit) = limit {
            args.insert("limit".into(), json!(limit));
        }
        if let Some(cursor) = cursor {
            args.insert("cursor".into(), json!(cursor));
        }
        Value::Object(args)
    };
    if opts.limit.is_some() || opts.cursor.is_some() {
        let page = send(
            "attention_list",
            &request(opts.limit, opts.cursor.as_deref()),
        )
        .map_err(|e| core_failure(e, None))?;
        return check_page(page);
    }
    let mut items = vec![];
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = send("attention_list", &request(Some(PAGE), cursor.as_deref()))
            .map_err(|e| core_failure(e, None))?;
        let page = check_page(page)?;
        items.extend(page["items"].as_array().cloned().unwrap_or_default());
        if page["has_more"] != json!(true) {
            return Ok(
                json!({ "v": CONTRACT, "items": items, "next_cursor": null, "has_more": false, "limit": PAGE }),
            );
        }
        cursor = page["next_cursor"].as_str().map(String::from);
    }
    Ok(
        json!({ "v": CONTRACT, "items": items, "next_cursor": cursor, "has_more": true, "limit": PAGE }),
    )
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

fn severity_text(code: &str) -> String {
    match code {
        "critical" => "crítica".into(),
        "high" => "alta".into(),
        "medium" => "media".into(),
        "low" => "baja".into(),
        other => clean(other),
    }
}

/// Con qué comando de su dominio se resuelve; Attention no se marca a mano (tabla de LXO-89).
fn resolves_with(category: &str) -> &'static str {
    match category {
        "question" => "respondiendo la pregunta (lxo reply o desde Lixbon); no se marca a mano.",
        "approval" => "aprobando o rechazando desde Lixbon; la decisión la resuelve.",
        "review_ready" => "revisando o integrando el resultado desde Lixbon.",
        "risk" => "atendiéndolo una persona desde Lixbon Desktop.",
        "conflict" | "failed" | "environment_blocked" => {
            "sola, cuando el Core registra que la condición desapareció."
        }
        _ => "con el comando de su dominio; esta versión de lxo no conoce la categoría.",
    }
}

fn age(now_ms: i64, created_ms: i64) -> String {
    let s = (now_ms - created_ms).max(0) / 1000;
    match s {
        0..=59 => format!("hace {s} s"),
        60..=3599 => format!("hace {} min", s / 60),
        3600..=86_399 => format!("hace {} h", s / 3600),
        _ => format!("hace {} d", s / 86_400),
    }
}

fn field(item: &Value, name: &str) -> String {
    item[name].as_str().map(clean).unwrap_or_else(|| "—".into())
}

fn item_line(item: &Value, now_ms: i64) -> String {
    let mut line = format!(
        "{}  {:<7}  {:<18}  {}:{}  proyecto {}  {}",
        field(item, "id"),
        severity_text(item["severity"].as_str().unwrap_or("?")),
        category_text(item["category"].as_str().unwrap_or("?")),
        field(item, "target_kind"),
        field(item, "target_id"),
        field(item, "project_id"),
        age(now_ms, item["created_at"].as_i64().unwrap_or(now_ms)),
    );
    if let Some(run) = item["run_id"].as_str() {
        line.push_str(&format!("  run {}", clean(run)));
    }
    if let Some(n) = item["occurrence"].as_u64().filter(|n| *n > 1) {
        line.push_str(&format!("  ocurrencia {n}"));
    }
    line
}

fn list_text(data: &Value, filtered: bool, now_ms: i64) -> String {
    let items = data["items"].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return if filtered {
            "Nada necesita atención con estos filtros.".into()
        } else {
            "Nada necesita atención ahora.".into()
        };
    }
    items
        .iter()
        .map(|item| item_line(item, now_ms))
        .collect::<Vec<_>>()
        .join("\n")
}

fn detail_text(item: &Value, now_ms: i64) -> String {
    let category = item["category"].as_str().unwrap_or("?");
    let active = item["status"].as_str() == Some("active");
    let created = item["created_at"].as_i64().unwrap_or(now_ms);
    let mut lines = vec![
        field(item, "id"),
        format!(
            "  Qué:          {} · severidad {} · {}",
            category_text(category),
            severity_text(item["severity"].as_str().unwrap_or("?")),
            if active { "activa" } else { "resuelta" }
        ),
        format!(
            "  Destino:      {}:{}",
            field(item, "target_kind"),
            field(item, "target_id")
        ),
        format!("  Proyecto:     {}", field(item, "project_id")),
        format!("  Run:          {}", field(item, "run_id")),
        format!(
            "  Ocurrencia:   {}",
            item["occurrence"].as_u64().unwrap_or(1)
        ),
        format!(
            "  Creada:       {} ({})",
            timestamp_utc(created),
            age(now_ms, created)
        ),
    ];
    if let Some(resolved) = item["resolved_at"].as_i64() {
        let reason = match item["resolution"].as_str() {
            Some("acted") => "atendida".to_string(),
            Some("condition_cleared") => "la condición desapareció".to_string(),
            Some("superseded") => "sustituida por otra".to_string(),
            Some(other) => clean(other),
            None => "—".to_string(),
        };
        lines.push(format!(
            "  Resuelta:     {} · {reason}",
            timestamp_utc(resolved)
        ));
    }
    if active {
        lines.push(format!("  Se resuelve:  {}", resolves_with(category)));
    }
    lines.join("\n")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn send(cmd: &str, args: &Value) -> Result<Value, String> {
    crate::client_auth::send(cmd, args, &crate::cwd())
}

fn execute(request: Request, json: bool) -> Result<(), Failure> {
    match request {
        Request::Help => print!("{HELP}"),
        Request::List(opts) => {
            let data = fetch_list(&opts, &mut send)?;
            if json {
                println!("{data}");
            } else {
                println!("{}", list_text(&data, !opts.filters.is_empty(), now_ms()));
            }
            if data["has_more"] == json!(true) {
                let cursor = data["next_cursor"].as_str().unwrap_or("");
                eprintln!(
                    "Hay más: repite con los mismos filtros y --limit {} --cursor {cursor}",
                    data["limit"]
                );
            }
        }
        Request::Show(id) => {
            let item = send("attention_detail", &json!({ "attention_id": id }))
                .map_err(|e| core_failure(e, Some(&id)))?;
            if !item.is_object() || !item["id"].is_string() {
                return Err(contract_error());
            }
            if json {
                println!("{item}");
            } else {
                println!("{}", detail_text(&item, now_ms()));
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

    fn list(raw: &[&str]) -> Result<ListOptions, Failure> {
        match parse(&args(raw))? {
            Request::List(opts) => Ok(opts),
            _ => panic!("se esperaba la lista"),
        }
    }

    const NOW: i64 = 1_760_000_000_000 + 3 * 3_600_000;

    fn item(id: &str, category: &str, severity: &str) -> Value {
        json!({
            "id": id, "category": category, "severity": severity, "status": "active",
            "target_kind": "task", "target_id": "t-hija", "project_id": "p-api", "run_id": "r1",
            "occurrence": 1, "created_at": 1_760_000_000_000i64, "resolved_at": null, "resolution": null
        })
    }

    #[test]
    fn filtros_van_al_core_con_sus_nombres_y_task_es_un_atajo() {
        let opts = list(&[
            "attention",
            "--project",
            "p1",
            "--category",
            "question",
            "--severity",
            "high",
            "--task",
            "t1",
        ])
        .unwrap();
        assert_eq!(
            Value::Object(opts.filters),
            json!({ "project_id": "p1", "category": "question", "severity": "high", "target_kind": "task", "target_id": "t1" })
        );
        assert_eq!((opts.limit, opts.cursor), (None, None));
        let opts = list(&[
            "attention",
            "--target-kind",
            "run",
            "--target-id",
            "r1",
            "--limit",
            "20",
            "--cursor",
            "abc",
        ])
        .unwrap();
        assert_eq!(
            Value::Object(opts.filters),
            json!({ "target_kind": "run", "target_id": "r1" })
        );
        assert_eq!(
            (opts.limit, opts.cursor.as_deref()),
            (Some(20), Some("abc"))
        );
    }

    #[test]
    fn uso_invalido_se_rechaza_antes_de_llamar_al_core() {
        for raw in [
            &["attention", "--unread"][..],
            &["attention", "--task", "t1", "--target-id", "t2"],
            &["attention", "--limit", "0"],
            &["attention", "--limit", "501"],
            &["attention", "--estado", "x"],
            &["attention", "--project"],
            &["attention", "--project", "a", "--project", "b"],
            &["attention", "--json=si"],
            &["attention", "show"],
            &["attention", "show", "a", "b"],
            &["attention", "show", "a", "--category", "risk"],
            &["attention", "resolve", "a"],
            &["attention", "snooze", "a"],
            &["attention", "otra"],
        ] {
            let failure = parse(&args(raw))
                .err()
                .unwrap_or_else(|| panic!("{raw:?} debía fallar"));
            assert_eq!(failure.code().1, 2, "{raw:?}: {failure:?}");
        }
        let unread = parse(&args(&["attention", "--unread"])).err().unwrap();
        assert!(unread.message().contains("no leído"), "{unread:?}");
        let resolve = parse(&args(&["attention", "resolve", "a"])).err().unwrap();
        assert!(
            resolve.message().contains("comando de su dominio"),
            "{resolve:?}"
        );
    }

    #[test]
    fn sin_limit_recorre_todas_las_paginas_con_el_cursor_del_core() {
        let mut calls = vec![];
        let opts = list(&["attention", "--category", "failed"]).unwrap();
        let data = fetch_list(&opts, &mut |cmd, args| {
            calls.push((cmd.to_string(), args.clone()));
            Ok(match args.get("cursor") {
                None => json!({ "v": 1, "items": [item("a1", "failed", "high")], "next_cursor": "c1", "has_more": true, "limit": 500 }),
                Some(_) => json!({ "v": 1, "items": [item("a2", "failed", "low")], "next_cursor": null, "has_more": false, "limit": 500 }),
            })
        })
        .unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0],
            (
                "attention_list".into(),
                json!({ "category": "failed", "limit": 500 })
            )
        );
        assert_eq!(
            calls[1].1,
            json!({ "category": "failed", "limit": 500, "cursor": "c1" })
        );
        let ids: Vec<_> = data["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["a1", "a2"]);
        assert_eq!(
            (data["has_more"].clone(), data["next_cursor"].clone()),
            (json!(false), Value::Null)
        );
    }

    #[test]
    fn con_limit_lee_una_sola_pagina_y_conserva_el_cursor() {
        let opts = list(&["attention", "--limit", "1"]).unwrap();
        let mut calls = 0;
        let data = fetch_list(&opts, &mut |_, args| {
            calls += 1;
            assert_eq!(args, &json!({ "limit": 1 }));
            Ok(json!({ "v": 1, "items": [item("a1", "question", "medium")], "next_cursor": "c1", "has_more": true, "limit": 1 }))
        })
        .unwrap();
        assert_eq!(calls, 1);
        assert_eq!(data["next_cursor"], "c1");
    }

    #[test]
    fn errores_del_core_tienen_mensaje_y_codigo_propios() {
        let opts = list(&["attention"]).unwrap();
        let fail = |error: &str| fetch_list(&opts, &mut |_, _| Err(error.to_string())).unwrap_err();
        assert_eq!(
            fail("attention_invalid_request: `category` no es una categoría de Attention válida")
                .code()
                .1,
            2
        );
        assert_eq!(
            fail("attention_invalid_cursor: cursor inválido").code().1,
            2
        );
        assert_eq!(
            fail("No se pudo conectar con el Core de Lixbon").code().1,
            1
        );
        let contract = fetch_list(&opts, &mut |_, _| {
            Ok(json!({ "v": 2, "items": [], "has_more": false }))
        })
        .unwrap_err();
        assert!(contract.message().contains("contrato"), "{contract:?}");
        let not_found = core_failure(
            "attention_not_found: Attention inexistente o fuera de scope".into(),
            Some("att_x"),
        );
        assert_eq!(
            not_found,
            Failure::NotFound(
                "No existe la Attention att_x o no es visible para esta identidad.".into()
            )
        );
        assert_eq!(not_found.code().1, 3);
    }

    #[test]
    fn snapshot_de_la_lista_humana_y_estado_vacio() {
        let mut repetida = item("att_2", "environment_blocked", "critical");
        repetida["occurrence"] = json!(3);
        repetida["run_id"] = Value::Null;
        repetida["project_id"] = Value::Null;
        let data = json!({ "v": 1, "items": [item("att_1", "question", "medium"), repetida], "next_cursor": null, "has_more": false, "limit": 500 });
        assert_eq!(
            list_text(&data, false, NOW),
            "att_1  media    pregunta            task:t-hija  proyecto p-api  hace 3 h  run r1\n\
             att_2  crítica  entorno bloqueado   task:t-hija  proyecto —  hace 3 h  ocurrencia 3"
        );
        let empty =
            json!({ "v": 1, "items": [], "next_cursor": null, "has_more": false, "limit": 500 });
        assert_eq!(
            list_text(&empty, false, NOW),
            "Nada necesita atención ahora."
        );
        assert_eq!(
            list_text(&empty, true, NOW),
            "Nada necesita atención con estos filtros."
        );
    }

    #[test]
    fn snapshot_json_conserva_attention_id_y_target_durable() {
        let opts = list(&["attention"]).unwrap();
        let data = fetch_list(&opts, &mut |_, _| {
            Ok(json!({ "v": 1, "items": [item("att_1", "question", "medium")], "next_cursor": null, "has_more": false, "limit": 500 }))
        })
        .unwrap();
        assert_eq!(
            data.to_string(),
            r#"{"has_more":false,"items":[{"category":"question","created_at":1760000000000,"id":"att_1","occurrence":1,"project_id":"p-api","resolution":null,"resolved_at":null,"run_id":"r1","severity":"medium","status":"active","target_id":"t-hija","target_kind":"task"}],"limit":500,"next_cursor":null,"v":1}"#
        );
    }

    #[test]
    fn detalle_dice_como_se_resuelve_y_la_historia_resuelta() {
        let activa = detail_text(&item("att_1", "question", "medium"), NOW);
        assert_eq!(
            activa,
            "att_1\n  Qué:          pregunta · severidad media · activa\n  Destino:      task:t-hija\n  Proyecto:     p-api\n  Run:          r1\n  Ocurrencia:   1\n  Creada:       2025-10-09T08:53:20.000Z (hace 3 h)\n  Se resuelve:  respondiendo la pregunta (lxo reply o desde Lixbon); no se marca a mano."
        );
        let mut resuelta = item("att_1", "question", "medium");
        resuelta["status"] = json!("resolved");
        resuelta["resolved_at"] = json!(1_760_000_060_000i64);
        resuelta["resolution"] = json!("acted");
        let texto = detail_text(&resuelta, NOW);
        assert!(texto.contains("· resuelta"), "{texto}");
        assert!(
            texto.contains("Resuelta:     2025-10-09T08:54:20.000Z · atendida"),
            "{texto}"
        );
        assert!(!texto.contains("Se resuelve"), "{texto}");
        for category in [
            "question",
            "approval",
            "review_ready",
            "conflict",
            "failed",
            "environment_blocked",
            "risk",
        ] {
            assert!(
                !resolves_with(category).contains("no conoce"),
                "{category} sin indicación"
            );
            assert_ne!(
                category_text(category),
                category,
                "{category} sin traducción"
            );
        }
    }

    #[test]
    fn codigos_desconocidos_y_texto_con_control_no_rompen_la_salida() {
        let mut raro = item("att\u{1b}[31m", "nueva_categoria", "urgentisima");
        raro["target_id"] = json!("t\nfalso");
        let line = item_line(&raro, NOW);
        assert!(
            line.starts_with("att?[31m  urgentisima  nueva_categoria"),
            "{line}"
        );
        assert!(line.contains("task:t?falso"), "{line}");
        assert!(detail_text(&raro, NOW).contains("no conoce la categoría"));
    }

    /// LXO-125 · `--attempt` es el atajo de la Attention de un intento; no se combina con --task ni --target-*.
    #[test]
    fn attempt_es_el_atajo_del_target_attempt() {
        let opts = list(&["attention", "--attempt", "t3-a2"]).unwrap();
        assert_eq!(Value::Object(opts.filters), json!({ "target_kind": "attempt", "target_id": "t3-a2" }));
        for raw in [
            &["attention", "--attempt", "t3-a2", "--task", "t3"][..],
            &["attention", "--attempt", "t3-a2", "--target-kind", "task"],
        ] {
            assert!(matches!(list(raw), Err(Failure::Usage(_))), "{raw:?}");
        }
    }
}
