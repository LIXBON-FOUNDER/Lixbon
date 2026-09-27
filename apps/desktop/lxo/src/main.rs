//! lxo: la CLI con la que cualquier agente habla con el orquestador de Lixbon.
//! Solo traduce argumentos a peticiones HTTP locales; toda la lógica vive en la app.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use serde_json::{json, Map, Value};

const COORDINATOR: &str = include_str!("../guide/coordinator.md");
const WORKER: &str = include_str!("../guide/worker.md");

const HELP: &str = "lxo · orquestador de agentes de Lixbon

Coordinador:
  lxo run create --objective \"...\" [--agent claude]
  lxo spawn --task \"...\" [--agent claude|codex|opencode|…] [--name \"...\"] [--base <rama>] [--no-worktree]
  lxo wait [--types done,question,phase,exited] [--timeout-ms 900000]
  lxo reply <id-pregunta> \"respuesta\"
  lxo send <tarea> \"mensaje\"
  lxo list | lxo show [<tarea>]
  lxo diff <tarea> | lxo merge <tarea> [--squash] [--force] | lxo pr <tarea>
  lxo stop <tarea> | lxo release <tarea> [--force]

Tarea hija:
  lxo phase \"nombre\" --start | --done [--note \"...\"]
  lxo ask \"pregunta\" [--timeout-ms N]
  lxo check
  lxo done --summary \"...\" [--failed] [--files a,b]

Siempre:
  lxo guide [coordinator|worker]   guía completa (léela antes de empezar)
  lxo status
  Añade --json para salida legible por máquina.";

struct Args {
    pos: Vec<String>,
    flags: Map<String, Value>,
}

fn parse(raw: Vec<String>) -> Args {
    let mut pos = vec![];
    let mut flags = Map::new();
    let mut it = raw.into_iter().peekable();
    while let Some(a) = it.next() {
        if let Some(name) = a.strip_prefix("--") {
            if let Some((k, v)) = name.split_once('=') {
                flags.insert(k.into(), Value::String(v.into()));
            } else if it.peek().is_some_and(|n| !n.starts_with("--")) && !BOOL_FLAGS.contains(&name) {
                flags.insert(name.into(), Value::String(it.next().unwrap_or_default()));
            } else {
                flags.insert(name.into(), Value::Bool(true));
            }
        } else {
            pos.push(a);
        }
    }
    Args { pos, flags }
}

const BOOL_FLAGS: &[&str] = &["json", "start", "done", "failed", "squash", "force", "no-worktree", "stat"];

impl Args {
    fn s(&self, k: &str) -> Option<String> {
        self.flags.get(k).and_then(Value::as_str).map(String::from)
    }
    fn b(&self, k: &str) -> bool {
        self.flags.get(k).is_some_and(|v| v.as_bool().unwrap_or(true))
    }
    fn at(&self, i: usize) -> Option<String> {
        self.pos.get(i).cloned()
    }
    fn num(&self, k: &str) -> Option<u64> {
        self.s(k).and_then(|v| v.parse().ok())
    }
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

fn cwd() -> String {
    std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Un coordinador externo no tiene LXO_TASK_ID: su tarea se recuerda por carpeta.
fn session_file() -> PathBuf {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in cwd().to_lowercase().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    home().join(".lixbon").join("orch").join("external").join(format!("{h:016x}"))
}

fn caller() -> Option<String> {
    std::env::var("LXO_TASK_ID").ok().filter(|s| !s.is_empty())
        .or_else(|| std::fs::read_to_string(session_file()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
}

fn call(cmd: &str, args: Value, caller: Option<&str>) -> Result<Value, String> {
    let info: Value = std::fs::read(home().join(".lixbon").join("orch.json")).ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or("Lixbon no está abierto o el orquestador está desactivado (Lixbon → Ajustes → Orquestador)")?;
    let port = info["port"].as_u64().ok_or("orch.json sin puerto")?;
    let token = info["token"].as_str().unwrap_or("");
    let body = json!({ "cmd": cmd, "args": args, "caller": caller, "cwd": cwd() }).to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port as u16))
        .map_err(|_| "Lixbon no está abierto o el orquestador está desactivado (Lixbon → Ajustes → Orquestador)".to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();
    write!(
        stream,
        "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| format!("Se cortó la conexión con Lixbon: {e}"))?;
    let text = String::from_utf8_lossy(&raw);
    let json_part = text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
    let res: Value = serde_json::from_str(json_part).map_err(|_| "Respuesta inválida de Lixbon".to_string())?;
    if res["ok"].as_bool() == Some(true) {
        Ok(res["data"].clone())
    } else {
        Err(res["error"].as_str().unwrap_or("Error desconocido").to_string())
    }
}

fn need(v: Option<String>, what: &str) -> Result<String, String> {
    v.filter(|s| !s.trim().is_empty()).ok_or_else(|| format!("Falta {what}. Ejecuta `lxo help`."))
}

fn msg_line(m: &Value) -> String {
    format!(
        "[{} #{}] {} → {}: {}",
        m["kind"].as_str().unwrap_or("?"),
        m["id"],
        m["from"].as_str().unwrap_or("?"),
        m["to"].as_str().unwrap_or("?"),
        m["body"].as_str().unwrap_or("")
    )
}

fn task_line(t: &Value) -> String {
    let indent = "  ".repeat(t["depth"].as_u64().unwrap_or(0) as usize);
    let phase = t["phases"].as_array().and_then(|p| p.last()).map(|p| {
        format!(" · fase «{}»{}", p["name"].as_str().unwrap_or(""), if p["done"].as_bool() == Some(true) { " ✓" } else { "" })
    }).unwrap_or_default();
    format!(
        "{indent}{} [{}] {} ({}){}{}",
        t["id"].as_str().unwrap_or("?"),
        t["status"].as_str().unwrap_or("?"),
        t["title"].as_str().unwrap_or(""),
        t["agent"].as_str().unwrap_or(""),
        t["branch"].as_str().map(|b| format!(" · {b}")).unwrap_or_default(),
        phase
    )
}

fn human(cmd: &str, data: &Value) -> String {
    match cmd {
        "guide" => data.as_str().unwrap_or("").to_string(),
        "status" => {
            let role = data["role"].as_str().unwrap_or("");
            let who = match role {
                "worker" => format!("Eres la tarea hija {}", data["task"]["id"].as_str().unwrap_or("")),
                "coordinator" => format!("Eres el coordinador {}", data["task"]["id"].as_str().unwrap_or("")),
                _ => "No eres una tarea todavía: si vas a coordinar, empieza con `lxo run create`".into(),
            };
            format!(
                "Lixbon {} · orquestador activo\n{who}\nPuedes crear hijas: {} (profundidad máxima {})\nAgentes: {} (por defecto {})",
                data["version"].as_str().unwrap_or(""),
                if data["can_spawn"].as_bool() == Some(true) { "sí" } else { "no" },
                data["max_depth"],
                data["agents"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default(),
                data["default_agent"].as_str().unwrap_or("")
            )
        }
        "run_create" => format!("Run {} creado. Eres su coordinador ({}). Ahora lanza hijas con `lxo spawn`.", data["run"].as_str().unwrap_or(""), data["task"].as_str().unwrap_or("")),
        "spawn" => format!(
            "Hija {} lanzada con {} [{}]{}{}",
            data["task"].as_str().unwrap_or(""),
            data["agent"].as_str().unwrap_or(""),
            data["status"].as_str().unwrap_or(""),
            data["branch"].as_str().map(|b| format!(" · rama {b}")).unwrap_or_default(),
            data["worktree"].as_str().map(|w| format!(" · {w}")).unwrap_or_default()
        ),
        "wait" | "check" | "inbox" => {
            let msgs = data["messages"].as_array().cloned().unwrap_or_default();
            let mut out: Vec<String> = msgs.iter().map(msg_line).collect();
            if msgs.is_empty() {
                out.push("Sin mensajes nuevos.".into());
            }
            if let Some(open) = data["open_children"].as_array() {
                let ids: Vec<&str> = open.iter().filter_map(Value::as_str).collect();
                out.push(if ids.is_empty() { "No te queda ninguna hija en marcha.".into() } else { format!("Hijas en marcha: {}", ids.join(", ")) });
            }
            out.join("\n")
        }
        "list" => {
            let tasks = data["tasks"].as_array().cloned().unwrap_or_default();
            if tasks.is_empty() { "Sin tareas.".into() } else { tasks.iter().map(task_line).collect::<Vec<_>>().join("\n") }
        }
        "show" => {
            let mut out = vec![task_line(&data["task"])];
            if let Some(s) = data["task"]["summary"].as_str().filter(|s| !s.is_empty()) {
                out.push(format!("Resumen: {s}"));
            }
            for p in data["task"]["phases"].as_array().into_iter().flatten() {
                out.push(format!("  fase «{}» {}{}", p["name"].as_str().unwrap_or(""), if p["done"].as_bool() == Some(true) { "terminada" } else { "empezada" },
                    p["note"].as_str().filter(|n| !n.is_empty()).map(|n| format!(": {n}")).unwrap_or_default()));
            }
            for m in data["messages"].as_array().into_iter().flatten() {
                out.push(format!("  {}", msg_line(m)));
            }
            out.join("\n")
        }
        "diff" => format!("{}...{}\n{}\n\n{}", data["base"].as_str().unwrap_or(""), data["branch"].as_str().unwrap_or(""), data["stat"].as_str().unwrap_or(""), data["diff"].as_str().unwrap_or("")),
        "merge" => format!("Fusionada {} en {}", data["merged"].as_str().unwrap_or(""), data["into"].as_str().unwrap_or("")),
        "pr" => format!("PR abierto: {}", data["url"].as_str().unwrap_or("")),
        "ask" => format!("Respuesta: {}", data["answer"].as_str().unwrap_or("")),
        "phase" => format!("Fase «{}» registrada.", data["phase"].as_str().unwrap_or("")),
        "done" => "Tarea cerrada. No empieces trabajo nuevo: tu coordinador ya está avisado.".into(),
        "reply" => format!("Respuesta enviada (#{}).", data["reply"]),
        "send" => format!("Mensaje enviado (#{}). La hija lo leerá en su próximo lxo check.", data["message"]),
        "stop" => format!("Tarea {} detenida.", data["task"].as_str().unwrap_or("")),
        "release" => format!(
            "Tarea {} liberada.{}{}",
            data["task"].as_str().unwrap_or(""),
            if data["worktree_removed"].as_bool() == Some(true) { " Worktree borrado." } else { "" },
            if data["branch_deleted"].as_bool() == Some(true) { " Rama borrada (ya estaba fusionada)." } else { " La rama se conserva." }
        ),
        _ => serde_json::to_string_pretty(data).unwrap_or_default(),
    }
}

fn run(a: &Args) -> Result<(String, Value), String> {
    let me = caller();
    let me = me.as_deref();
    let cmd = a.at(0).unwrap_or_else(|| "help".into());
    let sub = |i| a.at(i);
    let out = match cmd.as_str() {
        "help" | "-h" | "--help" => return Ok(("help".into(), Value::String(HELP.into()))),
        "guide" => {
            let role = match sub(1).as_deref() {
                Some("coordinator" | "coordinador") => "coordinator".to_string(),
                Some("worker" | "hija") => "worker".to_string(),
                _ => call("status", json!({}), me).ok().and_then(|s| s["role"].as_str().map(String::from)).unwrap_or_else(|| "external".into()),
            };
            let text = match role.as_str() {
                "worker" => {
                    let spawn = call("status", json!({}), me).ok().and_then(|s| s["can_spawn"].as_bool()).unwrap_or(false);
                    if spawn && sub(1).is_none() {
                        format!("{WORKER}\n---\n\nSi tu tarea es grande, puedes repartirla como coordinador de tus propias hijas:\n\n{COORDINATOR}")
                    } else {
                        WORKER.to_string()
                    }
                }
                _ => COORDINATOR.to_string(),
            };
            return Ok(("guide".into(), Value::String(text)));
        }
        "status" => ("status", call("status", json!({}), me)?),
        "run" => {
            if sub(1).as_deref() != Some("create") {
                return Err("Uso: lxo run create --objective \"...\"".into());
            }
            let data = call("run_create", json!({ "objective": need(a.s("objective"), "--objective")?, "agent": a.s("agent") }), me)?;
            if let Some(task) = data["task"].as_str() {
                let f = session_file();
                let _ = std::fs::create_dir_all(f.parent().unwrap_or(&home()));
                let _ = std::fs::write(&f, task);
            }
            ("run_create", data)
        }
        "spawn" => ("spawn", call("spawn", json!({
            "task": need(a.s("task").or_else(|| sub(1)), "--task")?,
            "agent": a.s("agent"), "name": a.s("name"), "base": a.s("base"), "no_worktree": a.b("no-worktree"),
        }), me)?),
        "phase" => {
            let name = need(sub(1).or_else(|| a.s("name")), "el nombre de la fase")?;
            ("phase", call("phase", json!({ "name": name, "done": a.b("done"), "note": a.s("note") }), me)?)
        }
        "done" => {
            let files: Vec<String> = a.s("files").map(|f| f.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
            ("done", call("done", json!({ "summary": need(a.s("summary"), "--summary")?, "failed": a.b("failed"), "files": files }), me)?)
        }
        "ask" => {
            let q = call("ask", json!({ "question": need(sub(1).or_else(|| a.s("question")), "la pregunta")? }), me)?;
            let id = q["question"].clone();
            eprintln!("Pregunta #{id} enviada a tu coordinador. Esperando respuesta…");
            let mut left = a.num("timeout-ms");
            loop {
                let chunk = left.map(|l| l.min(600_000)).unwrap_or(600_000);
                let r = call("await_reply", json!({ "question": id, "timeout_ms": chunk }), me)?;
                if r["timeout"].as_bool() != Some(true) {
                    break ("ask", r);
                }
                if let Some(l) = left.as_mut() {
                    *l = l.saturating_sub(chunk);
                    if *l == 0 {
                        return Err(format!("Sin respuesta a la pregunta #{id} todavía. Sigue con lo que puedas o vuelve a esperar con: lxo ask --resume {id}"));
                    }
                }
            }
        }
        "reply" => ("reply", call("reply", json!({ "question": need(sub(1), "el id de la pregunta")?, "answer": need(sub(2).or_else(|| a.s("answer")), "la respuesta")? }), me)?),
        "send" => ("send", call("send", json!({ "to": need(sub(1), "la tarea")?, "body": need(sub(2).or_else(|| a.s("body")), "el mensaje")? }), me)?),
        "wait" => ("wait", call("wait", json!({ "types": a.s("types"), "timeout_ms": a.num("timeout-ms").unwrap_or(600_000) }), me)?),
        "check" => ("check", call("check", json!({}), me)?),
        "inbox" => ("inbox", call("inbox", json!({}), me)?),
        "list" => ("list", call("list", json!({}), me)?),
        "show" => ("show", call("show", json!({ "task": sub(1) }), me)?),
        "diff" => ("diff", call("diff", json!({ "task": need(sub(1), "la tarea")? }), me)?),
        "merge" => ("merge", call("merge", json!({ "task": need(sub(1), "la tarea")?, "squash": a.b("squash"), "force": a.b("force") }), me)?),
        "pr" => ("pr", call("pr", json!({ "task": need(sub(1), "la tarea")? }), me)?),
        "stop" => ("stop", call("stop", json!({ "task": need(sub(1), "la tarea")? }), me)?),
        "release" => ("release", call("release", json!({ "task": need(sub(1), "la tarea")?, "force": a.b("force") }), me)?),
        other => return Err(format!("Comando desconocido: {other}. Ejecuta `lxo help`.")),
    };
    Ok((out.0.to_string(), out.1))
}

fn main() -> ExitCode {
    let a = parse(std::env::args().skip(1).collect());
    // `lxo ask --resume <id>` reanuda la espera de una pregunta ya enviada.
    if a.at(0).as_deref() == Some("ask") && a.s("resume").is_some() {
        let id = a.s("resume").unwrap_or_default();
        return match call("await_reply", json!({ "question": id, "timeout_ms": a.num("timeout-ms").unwrap_or(600_000) }), caller().as_deref()) {
            Ok(r) if r["timeout"].as_bool() != Some(true) => { println!("Respuesta: {}", r["answer"].as_str().unwrap_or("")); ExitCode::SUCCESS }
            Ok(_) => { eprintln!("Aún sin respuesta a #{id}."); ExitCode::from(3) }
            Err(e) => { eprintln!("lxo: {e}"); ExitCode::FAILURE }
        };
    }
    match run(&a) {
        Ok((cmd, data)) => {
            if a.b("json") && cmd != "help" && cmd != "guide" {
                println!("{}", serde_json::to_string_pretty(&data).unwrap_or_default());
            } else {
                println!("{}", human(&cmd, &data));
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            if a.b("json") {
                println!("{}", json!({ "ok": false, "error": e }));
            } else {
                eprintln!("lxo: {e}");
            }
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &[&str]) -> Args {
        parse(s.iter().map(|x| x.to_string()).collect())
    }

    #[test]
    fn flags_con_y_sin_valor() {
        let a = p(&["phase", "Tests", "--done", "--note", "12 ok"]);
        assert_eq!(a.at(1).as_deref(), Some("Tests"));
        assert!(a.b("done"));
        assert_eq!(a.s("note").as_deref(), Some("12 ok"));
        let a = p(&["spawn", "--agent=codex", "--no-worktree", "--task", "x"]);
        assert_eq!(a.s("agent").as_deref(), Some("codex"));
        assert!(a.b("no-worktree"));
        assert_eq!(a.s("task").as_deref(), Some("x"));
        let a = p(&["merge", "t3", "--squash", "--json"]);
        assert_eq!(a.at(1).as_deref(), Some("t3"));
        assert!(a.b("squash") && a.b("json"));
    }
}
