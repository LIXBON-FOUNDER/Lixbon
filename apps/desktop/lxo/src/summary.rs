//! `lxo summary`: resumen corto del trabajo activo y la Attention para el arranque del CLI (LXO-106).
//!
//! Lee la snapshot compacta del Core (`compact_snapshot`, LXO-94) por el RPC autenticado como Person. Solo
//! cuenta: no imprime nombres de Project, títulos de Task ni ids, para que el resumen del arranque no
//! enseñe contenido de nadie en una terminal compartida o en una grabación.

use std::process::ExitCode;

use serde_json::{json, Map, Value};

use crate::client_auth::{self, RpcFailure};
use crate::projects::{self, finish, usage, Failure};
use crate::Args;

pub(super) const HELP: &str = "Uso: lxo summary [--json]

Resumen del trabajo activo y de lo que pide atención, tal y como lo ve el Core
de Lixbon: proyectos con trabajo, tareas activas, Attention por categoría y
versión del Core. Solo lee y solo cuenta: no enseña nombres, títulos ni ids.

Salida:
  (por defecto)      una línea de resumen y, si hay algo que mirar, a qué comando ir
  --json             {v, core, cursor, projects, active_tasks, attention} en una línea

El CLI de Lixbon lo muestra al abrir el chat (se desactiva con
\"startup_summary\": false en ~/.lixbon/config.json).

Códigos de salida: 0 correcto, 1 error interno del Core, 2 uso inválido,
3 autenticación o identidad sin permiso, 4 versión o contrato incompatible,
5 Lixbon cerrado, orquestador desactivado o Core no disponible.
";

/// Versión del `--json` de `lxo summary` (independiente de `snapshot_version`).
const CONTRACT: u64 = 1;
const SNAPSHOT_VERSION: u64 = 1;
const FLAGS: [&str; 2] = ["json", "help"];
const CATEGORIES: [&str; 7] = [
    "question",
    "approval",
    "review_ready",
    "conflict",
    "failed",
    "environment_blocked",
    "risk",
];

fn parse(a: &Args) -> Result<bool, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(true);
    }
    if let Some(extra) = a.at(1) {
        return Err(usage(format!(
            "lxo summary no admite argumentos sueltos ({extra}). Mira `lxo summary --help`."
        )));
    }
    if let Some(name) = a.flags.keys().find(|k| !FLAGS.contains(&k.as_str())) {
        return Err(usage(format!(
            "--{name} no es una opción de lxo summary. Mira `lxo summary --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    if a.flags.get("json").is_some_and(|v| !v.is_boolean()) {
        return Err(usage("--json no admite un valor; úsalo como indicador."));
    }
    Ok(false)
}

fn failure(error: RpcFailure) -> Failure {
    match error {
        RpcFailure::Rejected(m) if m.starts_with("compact_snapshot_auth_required") => Failure::Auth(
            "El resumen es solo para personas: una tarea del orquestador (agente) no puede leerlo."
                .into(),
        ),
        RpcFailure::Rejected(m) if m.starts_with("compact_snapshot_unavailable") => {
            Failure::Unavailable(
                "El Core de Lixbon no tiene su almacén abierto; reinicia Lixbon.".into(),
            )
        }
        RpcFailure::Rejected(m) if m.starts_with("Comando desconocido") => {
            Failure::Version("Este Core no ofrece la snapshot compacta; actualiza Lixbon.".into())
        }
        RpcFailure::Rejected(m) if m.starts_with("compact_snapshot_read_failed") => {
            Failure::Internal("El Core no pudo leer su estado.".into())
        }
        other => projects::failure(other),
    }
}

fn n(v: &Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

/// Del documento del Core se queda solo con contadores y códigos (allowlist).
fn summarize(snapshot: Value) -> Result<Value, Failure> {
    let version = || {
        Failure::Version(
            "El Core devolvió una snapshot que este lxo no entiende; actualiza Lixbon.".into(),
        )
    };
    if snapshot["snapshot_version"].as_u64() != Some(SNAPSHOT_VERSION) {
        return Err(version());
    }
    let projects = snapshot["projects"]["items"]
        .as_array()
        .ok_or_else(version)?;
    if !snapshot["active_tasks"].is_object() || !snapshot["attention"]["by_category"].is_object() {
        return Err(version());
    }
    // Los Projects llegan ordenados por lo que piden (failed > attention > active > idle): si la lista viene
    // recortada y todos los que caben tienen trabajo, el número es un mínimo.
    let with_work = projects
        .iter()
        .filter(|p| p["status"].as_str() != Some("idle"))
        .count() as u64;
    let truncated = snapshot["projects"]["truncated"].as_bool() == Some(true);
    let complete = !truncated || with_work < projects.len() as u64;
    let mut by_category = Map::new();
    for c in CATEGORIES {
        by_category.insert(c.into(), json!(n(&snapshot["attention"]["by_category"][c])));
    }
    let health = match snapshot["core"]["health"].as_str() {
        Some("read_only") => "read_only",
        _ => "ok",
    };
    Ok(json!({
        "v": CONTRACT,
        "core": {
            "version": snapshot["core"]["version"].as_str().map(crate::events::clean),
            "health": health,
        },
        "cursor": n(&snapshot["cursor"]["events"]),
        "projects": { "total": n(&snapshot["projects"]["total"]), "with_work": with_work, "with_work_complete": complete },
        "active_tasks": n(&snapshot["active_tasks"]["total"]),
        "attention": { "total": n(&snapshot["attention"]["total"]), "by_category": by_category },
    }))
}

fn category_text(code: &str, count: u64) -> String {
    let (one, many) = match code {
        "question" => ("pregunta", "preguntas"),
        "approval" => ("aprobación", "aprobaciones"),
        "review_ready" => ("revisión", "revisiones"),
        "conflict" => ("conflicto", "conflictos"),
        "failed" => ("fallo", "fallos"),
        "environment_blocked" => ("entorno bloqueado", "entornos bloqueados"),
        _ => ("riesgo", "riesgos"),
    };
    format!("{count} {}", if count == 1 { one } else { many })
}

/// Texto para la terminal. Cada parte es corta y va separada por « · »: cabe en 80 columnas salvo con
/// muchas categorías, y entonces la pista va en su propia línea.
pub(super) fn summary_text(s: &Value) -> String {
    let plural = |n: u64, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let with_work = n(&s["projects"]["with_work"]);
    let projects = if with_work == 0 {
        "sin proyectos con trabajo".to_string()
    } else {
        let prefix = if s["projects"]["with_work_complete"].as_bool() == Some(false) {
            "≥"
        } else {
            ""
        };
        format!(
            "{prefix}{}",
            plural(with_work, "proyecto con trabajo", "proyectos con trabajo")
        )
    };
    let tasks = plural(n(&s["active_tasks"]), "tarea activa", "tareas activas");
    let total = n(&s["attention"]["total"]);
    let attention = if total == 0 {
        "nada pide atención".to_string()
    } else {
        let parts: Vec<String> = CATEGORIES
            .iter()
            .filter_map(|c| {
                let count = n(&s["attention"]["by_category"][*c]);
                (count > 0).then(|| category_text(c, count))
            })
            .collect();
        format!(
            "{} ({})",
            plural(total, "pide atención", "piden atención"),
            parts.join(", ")
        )
    };
    let mut head = format!("Lixbon · {projects} · {tasks} · {attention}");
    if s["core"]["health"].as_str() == Some("read_only") {
        head.push_str(" · Core en solo lectura");
    }
    let hint = match (total > 0, n(&s["active_tasks"]) > 0) {
        (true, _) => Some("→ lxo attention para verla"),
        (false, true) => Some("→ lxo tasks --active para verlas"),
        _ => None,
    };
    match hint {
        Some(h) => format!("{head}\n  {h}"),
        None => head,
    }
}

fn execute(help: bool, json: bool) -> Result<(), Failure> {
    if help {
        print!("{HELP}");
        return Ok(());
    }
    let snapshot = client_auth::rpc(
        "compact_snapshot",
        &json!({ "attention_items": 0 }),
        &crate::cwd(),
    )
    .map_err(failure)?;
    let summary = summarize(snapshot)?;
    if json {
        println!("{summary}");
    } else {
        println!("{}", summary_text(&summary));
    }
    Ok(())
}

pub(super) fn run(a: &Args) -> ExitCode {
    let json = a.b("json");
    finish(parse(a).and_then(|help| execute(help, json)), json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client_auth::EventRequestFailure;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|s| s.to_string()).collect())
    }

    fn snapshot(
        projects: Vec<Value>,
        truncated: bool,
        tasks: u64,
        attention: &[(&str, u64)],
    ) -> Value {
        let mut by = Map::new();
        for c in CATEGORIES {
            by.insert(c.into(), json!(0));
        }
        let mut total = 0;
        for (c, k) in attention {
            by.insert((*c).into(), json!(k));
            total += k;
        }
        json!({
            "snapshot_version": 1,
            "generated_at": 1,
            "core": { "version": "2.2.0", "health": "ok", "machine_id": "SENTINEL-MACHINE" },
            "cursor": { "events": 42 },
            "projects": { "total": projects.len() + if truncated { 10 } else { 0 }, "truncated": truncated, "items": projects },
            "active_tasks": { "total": tasks, "truncated": false, "items": [{ "id": "t-SENTINEL", "title": "SENTINEL-TITLE" }] },
            "attention": { "total": total, "by_category": by, "truncated": total > 0, "items": [] },
            "unassigned": { "active": 0, "failed": 0, "attention": 0 },
            "limits": {}
        })
    }

    fn project(status: &str) -> Value {
        json!({ "id": "p-SENTINEL", "name": "SENTINEL-PROJECT", "status": status, "active": 1, "failed": 0, "attention": 0 })
    }

    #[test]
    fn sin_attention_ni_trabajo() {
        let s = summarize(snapshot(vec![project("idle")], false, 0, &[])).unwrap();
        assert_eq!(
            summary_text(&s),
            "Lixbon · sin proyectos con trabajo · 0 tareas activas · nada pide atención"
        );
    }

    #[test]
    fn n_attention_por_categoria_y_pista() {
        let s = summarize(snapshot(
            vec![project("failed"), project("active"), project("idle")],
            false,
            3,
            &[("question", 1), ("failed", 2)],
        ))
        .unwrap();
        assert_eq!(
            summary_text(&s),
            "Lixbon · 2 proyectos con trabajo · 3 tareas activas · 3 piden atención (1 pregunta, 2 fallos)\n  → lxo attention para verla"
        );
        let s = summarize(snapshot(vec![project("active")], false, 1, &[])).unwrap();
        assert!(summary_text(&s)
            .ends_with("1 tarea activa · nada pide atención\n  → lxo tasks --active para verlas"));
    }

    #[test]
    fn lista_recortada_es_un_minimo() {
        let s = summarize(snapshot(
            vec![project("active"), project("active")],
            true,
            2,
            &[],
        ))
        .unwrap();
        assert_eq!(s["projects"]["with_work_complete"], false);
        assert!(summary_text(&s).contains("≥2 proyectos con trabajo"));
        let s = summarize(snapshot(
            vec![project("active"), project("idle")],
            true,
            2,
            &[],
        ))
        .unwrap();
        assert_eq!(
            s["projects"]["with_work_complete"], true,
            "si cabe uno en reposo, ya están todos los que tienen trabajo"
        );
    }

    #[test]
    fn json_solo_lleva_contadores_y_codigos() {
        let s = summarize(snapshot(
            vec![project("attention")],
            false,
            1,
            &[("approval", 1)],
        ))
        .unwrap();
        let text = s.to_string();
        assert_eq!(
            text,
            r#"{"active_tasks":1,"attention":{"by_category":{"approval":1,"conflict":0,"environment_blocked":0,"failed":0,"question":0,"review_ready":0,"risk":0},"total":1},"core":{"health":"ok","version":"2.2.0"},"cursor":42,"projects":{"total":1,"with_work":1,"with_work_complete":true},"v":1}"#
        );
        assert!(!text.contains("SENTINEL"), "{text}");
        assert!(!summary_text(&s).contains("SENTINEL"));
    }

    #[test]
    fn solo_lectura_y_terminal_estrecha() {
        let mut snap = snapshot(vec![project("active")], false, 1, &[]);
        snap["core"]["health"] = json!("read_only");
        let text = summary_text(&summarize(snap).unwrap());
        assert!(text.contains("· Core en solo lectura"), "{text}");
        for line in text.lines() {
            assert!(line.chars().count() <= 100, "{line}");
            assert!(!line.chars().any(char::is_control), "{line:?}");
        }
    }

    #[test]
    fn version_desconocida_y_errores_del_core() {
        let mut snap = snapshot(vec![], false, 0, &[]);
        snap["snapshot_version"] = json!(2);
        assert_eq!(summarize(snap).unwrap_err().code().1, 4);
        let t = RpcFailure::Transport;
        for (error, exit) in [
            (t(EventRequestFailure::Network("cerrado".into())), 5),
            (t(EventRequestFailure::Authentication("x".into())), 3),
            (
                RpcFailure::Rejected("compact_snapshot_auth_required: solo Person".into()),
                3,
            ),
            (
                RpcFailure::Rejected("compact_snapshot_unavailable: x".into()),
                5,
            ),
            (
                RpcFailure::Rejected("Comando desconocido: compact_snapshot".into()),
                4,
            ),
            (
                RpcFailure::Rejected("compact_snapshot_read_failed: x".into()),
                1,
            ),
        ] {
            let label = format!("{error:?}");
            assert_eq!(failure(error).code().1, exit, "{label}");
        }
    }

    #[test]
    fn uso_invalido() {
        for raw in [
            &["summary", "x"][..],
            &["summary", "--all"],
            &["summary", "--json=si"],
        ] {
            assert_eq!(parse(&args(raw)).unwrap_err().code().1, 2, "{raw:?}");
        }
        assert_eq!(parse(&args(&["summary", "--help"])).unwrap(), true);
    }
}
