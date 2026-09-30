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

Coordinador (el agente con el que habla el usuario):
  lxo run create --objective \"...\" --agent <tu agente>
  lxo roles                                       roles del equipo y el modelo que les asignó el usuario
  lxo spawn --role <rol> --task \"...\" [--name \"...\"] [--base <rama>]
  lxo agents [--refresh]                          agentes instalados y sus modelos (solo sin --role)
  lxo spawn --agent <id> --task \"...\" [--model <id>] [--effort <nivel>] [--name \"...\"] [--shared] [--base <rama>]
  lxo wait [--types done,question,exited,phase] [--timeout-ms 540000]
  lxo reply <id-pregunta> \"respuesta\"
  lxo send <tarea> \"mensaje\"             instrucciones a una hija en marcha
  lxo continue <tarea> --task \"...\"      nuevo encargo a una hija que ya entregó
  lxo list | lxo show [<tarea>] | lxo diff <tarea>
  lxo merge <tarea> [--squash] | lxo pr <tarea> | lxo stop <tarea> | lxo release <tarea> [--force]

Tarea hija:
  lxo phase \"nombre\" --start | --done [--note \"...\"]
  lxo ask \"pregunta\" [--timeout-ms N]   (lxo ask --resume <id> para seguir esperando)
  lxo check
  lxo done --report <informe.md> --summary \"...\" [--failed] [--files a,b]
  lxo done --report - --summary \"...\" <<'EOF' … EOF   (solo lectura: informe por stdin)

Issues de Lixbon Team (con la cuenta del IDE):
  lxo issue ver <CLAVE>                            título, estado, descripción, subtareas y comentarios
  lxo issue comentar <CLAVE> --texto \"...\"        (--texto - <<'EOF' … EOF para un informe largo)
  lxo issue mover <CLAVE> \"En revisión\"           por nombre del estado o por tipo (en_curso, revision, hecho)
  lxo issue vincular <CLAVE> --rama <rama> | --pr <#n> [--url …] | --commit <sha>

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

const BOOL_FLAGS: &[&str] = &["json", "start", "done", "failed", "squash", "force", "shared", "stat", "refresh"];

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
                "Lixbon {} · orquestador activo\n{who}\nPara ver los roles del equipo y sus modelos: lxo roles",
                data["version"].as_str().unwrap_or("")
            )
        }
        "run_create" => format!("Run {} creado. Eres su coordinador ({}). Ahora lanza hijas con `lxo spawn`.", data["run"].as_str().unwrap_or(""), data["task"].as_str().unwrap_or("")),
        "agents" => {
            let list = data["agents"].as_array().cloned().unwrap_or_default();
            if list.is_empty() {
                return "No hay ningún agente instalado que Lixbon sepa lanzar (claude, codex, cursor-agent, opencode, gemini).".into();
            }
            list.iter().map(|a| {
                let models: Vec<&str> = a["models"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).collect();
                let shown = if models.is_empty() { "(no se pudieron listar; pasa el id igualmente)".to_string() } else if models.len() > 25 {
                    format!("{} … y {} más (lxo agents --json para verlos todos)", models[..25].join(", "), models.len() - 25)
                } else { models.join(", ") };
                let efforts: Vec<&str> = a["efforts"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                format!(
                    "{} ({})\n  Bueno para: {}\n  Modelos: {}\n  {}{}",
                    a["id"].as_str().unwrap_or(""),
                    a["label"].as_str().unwrap_or(""),
                    a["strengths"].as_str().unwrap_or(""),
                    shown,
                    a["model_hint"].as_str().unwrap_or(""),
                    if efforts.is_empty() { String::new() } else { format!("\n  --effort: {}", efforts.join(", ")) }
                )
            }).collect::<Vec<_>>().join("\n\n")
        }
        "roles" => {
            let list = data["roles"].as_array().cloned().unwrap_or_default();
            let rows: Vec<String> = list.iter().map(|r| format!(
                "{} · {}{}{}\n  {}",
                r["id"].as_str().unwrap_or(""),
                r["model"].as_str().unwrap_or(""),
                r["effort"].as_str().map(|e| format!(" · esfuerzo {e}")).unwrap_or_default(),
                if r["read_only"].as_bool() == Some(true) { " · solo lectura (sin rama)" } else { " · rama y worktree propios" },
                r["purpose"].as_str().unwrap_or("")
            )).collect();
            format!("{}\n\nLanza con: lxo spawn --role <rol> --name \"...\" --task \"...\"", rows.join("\n"))
        }
        "continue" => format!("Nuevo encargo enviado a {}: lo verás llegar con lxo wait como otro done.", data["task"].as_str().unwrap_or("")),
        "spawn" => format!(
            "Hija {} lanzada {}con {}{} [{}]{}{}",
            data["task"].as_str().unwrap_or(""),
            data["role"].as_str().map(|r| format!("como {r} ")).unwrap_or_default(),
            data["agent"].as_str().unwrap_or(""),
            data["model"].as_str().map(|m| format!(" · {m}")).unwrap_or_default(),
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
        "done" => format!("Tarea cerrada e informe entregado ({}). No empieces trabajo nuevo: tu coordinador ya está avisado.", data["report"].as_str().unwrap_or("")),
        "reply" => format!("Respuesta enviada (#{}).", data["reply"]),
        "send" => format!("Mensaje enviado (#{}). La hija lo leerá en su próximo lxo check.", data["message"]),
        "stop" => format!("Tarea {} detenida.", data["task"].as_str().unwrap_or("")),
        "release" => format!(
            "Tarea {} liberada.{}{}",
            data["task"].as_str().unwrap_or(""),
            if data["worktree_removed"].as_bool() == Some(true) { " Worktree borrado." } else { "" },
            if data["branch_deleted"].as_bool() == Some(true) { " Rama borrada (ya estaba fusionada)." } else { " La rama se conserva." }
        ),
        "issue" => issue_human(data),
        _ => serde_json::to_string_pretty(data).unwrap_or_default(),
    }
}

const PRIORIDADES: [&str; 5] = ["sin prioridad", "baja", "media", "alta", "urgente"];

fn issue_human(data: &Value) -> String {
    let clave = data["clave"].as_str().unwrap_or("");
    match data["accion"].as_str().unwrap_or("") {
        "comentar" => format!("Comentario publicado en {clave}."),
        "mover" => format!("{clave} está ahora en «{}».", data["estado"].as_str().unwrap_or("")),
        "vincular" => format!("{} {} vinculado a {clave}.", data["tipo"].as_str().unwrap_or(""), data["ref"].as_str().unwrap_or("")),
        _ => {
            let i = &data["issue"];
            let mut out = vec![format!("{} · {}", i["clave"].as_str().unwrap_or(""), i["titulo"].as_str().unwrap_or(""))];
            let prioridad = PRIORIDADES.get(i["prioridad"].as_u64().unwrap_or(0) as usize).copied().unwrap_or("");
            out.push(format!(
                "Estado: {} · prioridad {}{}{}",
                i["estado"]["nombre"].as_str().unwrap_or("?"),
                prioridad,
                i["fecha_limite"].as_str().map(|f| format!(" · vence {f}")).unwrap_or_default(),
                i["rama"].as_str().map(|r| format!(" · rama {r}")).unwrap_or_default(),
            ));
            if let Some(d) = i["descripcion"].as_str().filter(|d| !d.trim().is_empty()) {
                out.push(String::new());
                out.push(d.trim().to_string());
            }
            let estados = i["estados"].as_array().cloned().unwrap_or_default();
            let nombre_estado = |id: &Value| estados.iter().find(|e| &e["id"] == id).and_then(|e| e["nombre"].as_str()).unwrap_or("?").to_string();
            let subt = i["subtareas_lista"].as_array().cloned().unwrap_or_default();
            if !subt.is_empty() {
                out.push(String::new());
                out.push("Subtareas:".into());
                for x in &subt {
                    out.push(format!("  {} · {} [{}]", x["clave"].as_str().unwrap_or(""), x["titulo"].as_str().unwrap_or(""), nombre_estado(&x["estado_id"])));
                }
            }
            let coms = i["comentarios_lista"].as_array().cloned().unwrap_or_default();
            if !coms.is_empty() {
                out.push(String::new());
                out.push(format!("Últimos comentarios ({} en total):", coms.len()));
                for c in coms.iter().rev().take(5).rev() {
                    let quien = c["de_agente"].as_str().map(|r| format!("agente {r}")).unwrap_or_else(|| "persona".into());
                    out.push(format!("  [{quien}] {}", c["texto"].as_str().unwrap_or("").replace('\n', "\n  ")));
                }
            }
            let nombres: Vec<&str> = estados.iter().filter_map(|e| e["nombre"].as_str()).collect();
            out.push(String::new());
            out.push(format!("Estados del equipo: {}", nombres.join(", ")));
            out.join("\n")
        }
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
                _ if std::env::var("LXO_TASK_ID").is_ok_and(|v| !v.is_empty()) => "worker".to_string(),
                _ => "coordinator".to_string(),
            };
            let text = if role == "worker" { WORKER } else { COORDINATOR };
            return Ok(("guide".into(), Value::String(text.to_string())));
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
        "agents" => ("agents", call("agents", json!({ "refresh": a.b("refresh") }), me)?),
        "roles" => ("roles", call("roles", json!({}), me)?),
        "spawn" => ("spawn", call("spawn", json!({
            "task": need(a.s("task").or_else(|| sub(1)), "--task")?,
            "role": a.s("role"),
            "agent": if a.s("role").is_some() { a.s("agent") } else { Some(need(a.s("agent"), "--role (mira `lxo roles`) o --agent (mira `lxo agents`)")?) },
            "model": a.s("model"), "effort": a.s("effort"), "name": a.s("name"), "base": a.s("base"), "shared": a.b("shared"),
        }), me)?),
        "continue" => ("continue", call("continue", json!({
            "task": need(sub(1), "la tarea")?,
            "spec": need(a.s("task").or_else(|| sub(2)), "--task con el nuevo encargo")?,
        }), me)?),
        "phase" => {
            let name = need(sub(1).or_else(|| a.s("name")), "el nombre de la fase")?;
            ("phase", call("phase", json!({ "name": name, "done": a.b("done"), "note": a.s("note") }), me)?)
        }
        "done" => {
            let files: Vec<String> = a.s("files").map(|f| f.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()).unwrap_or_default();
            let mut report = a.s("report").unwrap_or_default();
            let summary = a.s("summary").unwrap_or_default();
            // `--report -`: el informe llega por stdin (las hijas de solo lectura no escriben archivos).
            let mut report_text = String::new();
            if report == "-" {
                std::io::stdin().read_to_string(&mut report_text).map_err(|e| format!("No se pudo leer el informe de stdin: {e}"))?;
                if report_text.trim().is_empty() {
                    return Err("--report - espera el informe por stdin: lxo done --summary \"...\" --report - <<'EOF' … EOF".into());
                }
                report.clear();
            }
            if report.is_empty() && report_text.is_empty() && summary.is_empty() {
                return Err("Falta --report <informe.md> (y --summary con una frase).".into());
            }
            ("done", call("done", json!({ "summary": summary, "report": report, "report_text": report_text, "failed": a.b("failed"), "files": files }), me)?)
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
        "issue" => {
            // `lxo issue LXB-12` es `lxo issue ver LXB-12`.
            let (accion, clave) = match (sub(1), sub(2)) {
                (Some(x), Some(c)) if ["ver", "comentar", "mover", "vincular"].contains(&x.as_str()) => (x, c),
                (Some(c), _) if c.contains('-') => ("ver".to_string(), c),
                _ => return Err("Uso: lxo issue <ver|comentar|mover|vincular> <CLAVE> …  (mira `lxo help`)".into()),
            };
            let mut texto = a.s("texto").or_else(|| sub(3)).unwrap_or_default();
            if accion == "comentar" && texto == "-" {
                texto.clear();
                std::io::stdin().read_to_string(&mut texto).map_err(|e| format!("No se pudo leer el comentario de stdin: {e}"))?;
            }
            let (tipo, referencia) = if let Some(r) = a.s("rama") { ("rama", r) }
                else if let Some(r) = a.s("pr") { ("pr", r) }
                else if let Some(r) = a.s("commit") { ("commit", r) }
                else { ("", String::new()) };
            ("issue", call("issue", json!({
                "accion": accion, "clave": clave, "texto": texto,
                "estado": a.s("estado").or_else(|| sub(3)),
                "tipo": tipo, "ref": referencia, "url": a.s("url"),
            }), me)?)
        }
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
        let a = p(&["spawn", "--agent=codex", "--shared", "--task", "x"]);
        assert_eq!(a.s("agent").as_deref(), Some("codex"));
        assert!(a.b("shared"));
        assert_eq!(a.s("task").as_deref(), Some("x"));
        let a = p(&["merge", "t3", "--squash", "--json"]);
        assert_eq!(a.at(1).as_deref(), Some("t3"));
        assert!(a.b("squash") && a.b("json"));
        let a = p(&["done", "--summary", "ok", "--report", "-"]);
        assert_eq!(a.s("report").as_deref(), Some("-"));
        let a = p(&["spawn", "--role", "explorador", "--task", "x"]);
        assert_eq!(a.s("role").as_deref(), Some("explorador"));
    }

    #[test]
    fn issue_legible() {
        let data = json!({ "accion": "ver", "issue": {
            "clave": "LXB-12", "titulo": "Notarizar macOS", "prioridad": 4, "rama": "lx/lxb-12-macos",
            "estado": { "nombre": "En curso" }, "descripcion": "Firmar y notarizar.",
            "estados": [{ "id": "a", "nombre": "En curso" }, { "id": "b", "nombre": "Hecho" }],
            "subtareas_lista": [{ "clave": "LXB-13", "titulo": "Runner", "estado_id": "b" }],
            "comentarios_lista": [{ "texto": "Listo el runner", "de_agente": "implementador" }],
        }});
        let t = issue_human(&data);
        assert!(t.starts_with("LXB-12 · Notarizar macOS\nEstado: En curso · prioridad urgente · rama lx/lxb-12-macos"));
        assert!(t.contains("  LXB-13 · Runner [Hecho]"));
        assert!(t.contains("[agente implementador] Listo el runner"));
        assert!(t.ends_with("Estados del equipo: En curso, Hecho"));
        assert_eq!(issue_human(&json!({ "accion": "mover", "clave": "LXB-12", "estado": "Hecho" })), "LXB-12 está ahora en «Hecho».");
    }

    #[test]
    fn flags_de_issue() {
        let a = p(&["issue", "comentar", "LXB-12", "--texto", "-"]);
        assert_eq!(a.s("texto").as_deref(), Some("-"));
        let a = p(&["issue", "vincular", "LXB-12", "--pr", "#4", "--url", "https://github.com/x/y/pull/4"]);
        assert_eq!(a.s("pr").as_deref(), Some("#4"));
    }
}
