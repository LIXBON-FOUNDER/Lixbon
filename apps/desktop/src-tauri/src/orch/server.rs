//! HTTP local por el que habla `lxo`. Solo 127.0.0.1 y con token: el puerto y
//! el token se publican en `~/.lixbon/orch.json`, legible solo por el usuario.
//! `POST /rpc` despacha comandos; `GET /events` es la lectura del Event Log (events_read.rs).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use crate::store::{AuthenticatedClient, ClientAction, ClientClaims, ClientPrincipal};

use super::Core;

pub struct Handle {
    pub port: u16,
    pub token: String,
    stop: Arc<AtomicBool>,
}

impl Handle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        // Despierta al accept bloqueado para que el hilo vea la señal y salga.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

const MAX_BODY: usize = 4 * 1024 * 1024;

pub fn start(core: Arc<Core>) -> Result<Handle, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = super::random_token();
    let stop = Arc::new(AtomicBool::new(false));
    let (tok, stop_t) = (token.clone(), stop.clone());
    thread::spawn(move || {
        for conn in listener.incoming() {
            if stop_t.load(Ordering::Relaxed) {
                break;
            }
            let Ok(stream) = conn else { continue };
            let (core, tok) = (core.clone(), tok.clone());
            thread::spawn(move || {
                let _ = handle(stream, &core, &tok);
            });
        }
    });
    Ok(Handle { port, token, stop })
}

enum RequestIdentity {
    LegacyServerToken,
    Client(AuthenticatedClient),
}

fn authenticate_request(core: &Core, auth: &str, server_token: &str) -> Result<RequestIdentity, (u16, &'static str)> {
    if auth == format!("Bearer {server_token}") {
        return Ok(RequestIdentity::LegacyServerToken);
    }
    let Some(secret) = auth.strip_prefix("Bearer ").filter(|secret| !secret.is_empty()) else {
        return Err((401, "Token inválido: vuelve a abrir la terminal o reinicia Lixbon"));
    };
    match core.authenticate_client(secret) {
        Ok(Some(client)) => Ok(RequestIdentity::Client(client)),
        Ok(None) => Err((401, "Token inválido: vuelve a abrir la terminal o reinicia Lixbon")),
        Err(_) => Err((503, "La autenticación de clientes no está disponible")),
    }
}

fn handle(mut stream: TcpStream, core: &Arc<Core>, token: &str) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));

    let mut len = 0usize;
    let mut auth = String::new();
    let mut caller_header = String::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        let (k, v) = h.split_once(':').unwrap_or((&h, ""));
        match k.trim().to_ascii_lowercase().as_str() {
            "content-length" => len = v.trim().parse().unwrap_or(0),
            "authorization" => auth = v.trim().to_string(),
            "x-lixbon-caller" => caller_header = v.trim().to_string(),
            _ => {}
        }
    }
    if len > MAX_BODY {
        return reply(&mut stream, 413, &json!({ "ok": false, "error": "Petición demasiado grande" }));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;

    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    if route == "/events" {
        let identity = match authenticate_request(core, &auth, token) {
            Ok(identity) => identity,
            Err((code, error)) => return reply(&mut stream, code, &json!({ "ok": false, "error": error })),
        };
        if method != "GET" {
            return reply(&mut stream, 405, &json!({ "ok": false, "error": "El Event Log es de solo lectura: usa GET /events" }));
        }
        let caller_claim = Some(caller_header).filter(|c| !c.is_empty());
        let caller = match identity {
            RequestIdentity::LegacyServerToken => super::Caller::Agent(caller_claim),
            RequestIdentity::Client(client) => {
                let claims = ClientClaims { caller: caller_claim, ..Default::default() };
                if client.validate_claims(&claims, "lxo").is_err() || client.authorize(ClientAction::EventLogRead).is_err() {
                    return reply(&mut stream, 403, &json!({ "ok": false, "error": "Identidad no autorizada para este canal" }));
                }
                match client.identity().principal() {
                    ClientPrincipal::Person(_) => super::Caller::User,
                    ClientPrincipal::Agent(task) => super::Caller::Agent(Some(task.clone())),
                    ClientPrincipal::System => return reply(&mut stream, 403, &json!({ "ok": false, "error": "La identidad Core/System está reservada" })),
                }
            }
        };
        let (code, body) = core.events_http(caller, query);
        return reply(&mut stream, code, &body);
    }
    if method != "POST" || path != "/rpc" {
        return reply(&mut stream, 404, &json!({ "ok": false, "error": "No encontrado" }));
    }
    let identity = match authenticate_request(core, &auth, token) {
        Ok(identity) => identity,
        Err((code, error)) => return reply(&mut stream, code, &json!({ "ok": false, "error": error })),
    };
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let caller = req.get("caller").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from);
    let cwd = req.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or("");
    let args = req.get("args").cloned().unwrap_or(Value::Null);
    // Las esperas largas (wait, ask) superan el timeout de lectura por diseño.
    stream.set_read_timeout(None)?;
    // Rechazo explícito antes de despachar: decisiones humanas y lecturas cerradas (review.rs).
    if let Some(why) = super::review::closed_to_agents(cmd) {
        return reply(&mut stream, 200, &json!({ "ok": false, "error": why }));
    }
    let res = match identity {
        RequestIdentity::LegacyServerToken => guarded(cmd, || core.rpc_via(super::events::Channel::Lxo, super::Caller::Agent(caller), &cwd, cmd, &args)),
        RequestIdentity::Client(client) => {
            let claims: ClientClaims = match serde_json::from_value(req.clone()) {
                Ok(claims) => claims,
                Err(_) => return reply(&mut stream, 400, &json!({ "ok": false, "error": "Claims de cliente inválidos" })),
            };
            guarded(cmd, || core.rpc_authenticated_via(&client, &claims, super::events::Channel::Lxo, &cwd, cmd, &args))
        }
    };
    reply(&mut stream, 200, &res)
}

fn guarded(cmd: &str, run: impl FnOnce() -> Result<Value, String>) -> Value {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
        Ok(Ok(v)) => json!({ "ok": true, "data": v }),
        Ok(Err(e)) => json!({ "ok": false, "error": e }),
        Err(panic) => {
            let why = panic.downcast_ref::<String>().cloned().or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
            json!({ "ok": false, "error": format!("Error interno de Lixbon en «{cmd}»: {why}") })
        }
    }
}

fn reply(stream: &mut TcpStream, code: u16, body: &Value) -> std::io::Result<()> {
    let text = body.to_string();
    let status = match code {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        503 => "Service Unavailable",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {code} {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    )?;
    stream.flush()?;
    // Cierre ordenado: cerrar de golpe con algo sin leer del otro lado manda un RST en Windows y el
    // cliente pierde el final de la respuesta («conexión forzada»). Se avisa del fin y se espera su cierre.
    let _ = stream.shutdown(std::net::Shutdown::Write);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut sink = [0u8; 512];
    while matches!(stream.read(&mut sink), Ok(n) if n > 0) {}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orch::state::NewTask;
    use crate::orch::Orch;

    #[test]
    fn un_panico_en_un_comando_llega_como_error_con_el_motivo() {
        let r = guarded("show", || panic!("se rompió"));
        assert_eq!(r["ok"], false);
        let e = r["error"].as_str().unwrap();
        assert!(e.contains("«show»") && e.contains("se rompió"), "{e}");
        let propio = String::from("motivo propio");
        let r = guarded("list", move || -> Result<Value, String> { std::panic::panic_any(propio) });
        assert!(r["error"].as_str().unwrap().contains("motivo propio"));
        assert_eq!(guarded("x", || Ok(json!(1)))["data"], 1);
        assert_eq!(guarded("x", || Err("no".into()))["error"], "no");
    }

    #[test]
    fn una_respuesta_grande_llega_completa_aunque_el_cliente_lea_despacio() {
        let core = Orch::default().0;
        core.settings.lock().unwrap().enabled = true;
        let spec = "x".repeat(3 * 1024 * 1024);
        core.lock_unpersisted().create_run("obj", NewTask {
            agent: "coordinador".into(), model: None, effort: None, role: None, title: "t".into(), spec: spec.clone(),
            repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: true,
        });
        let h = start(core).unwrap();
        let body = r#"{"cmd":"list","args":{}}"#;
        let mut s = TcpStream::connect(("127.0.0.1", h.port)).unwrap();
        // Bytes de más tras el cuerpo: sin leer en el servidor al cerrar, Windows manda un RST.
        write!(s, "POST /rpc HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {}\r\nContent-Length: {}\r\n\r\n{}EXTRA-SIN-LEER", h.token, body.len(), body).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let mut raw = Vec::new();
        let mut chunk = [0u8; 32 * 1024];
        loop {
            match s.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    raw.extend_from_slice(&chunk[..n]);
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(e) => panic!("la conexión se cortó a mitad de la respuesta: {e}"),
            }
        }
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let head = String::from_utf8_lossy(&raw[..split]).to_string();
        let len: usize = head.lines().find_map(|l| l.strip_prefix("Content-Length: ")).unwrap().trim().parse().unwrap();
        assert_eq!(raw.len() - split, len, "respuesta truncada");
        let v: Value = serde_json::from_slice(&raw[split..]).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["data"]["tasks"][0]["spec"].as_str().unwrap().len(), spec.len());
        h.stop();
    }

    #[test]
    fn sin_el_token_correcto_no_se_despacha_nada() {
        let (_cleanup, data, core_dir) = crate::orch::boot_tests::dirs();
        let (core, _host, started) = crate::orch::boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let h = start(core).unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", h.port)).unwrap();
        let body = r#"{"cmd":"status"}"#;
        write!(s, "POST /rpc HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer incorrecto\r\nContent-Length: {}\r\n\r\n{}", body.len(), body).unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.starts_with("HTTP/1.1 401"), "{out}");
        h.stop();
    }
}

#[cfg(test)]
mod authenticated_client_tests {
    use super::*;
    use crate::orch::boot_tests;
    use crate::store::{ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity, EventQuery};

    fn register(core: &Core, surface: ClientSurface, principal: ClientPrincipal, installation: &str, secret: &str) -> String {
        let registration = ClientRegistration::new(surface, DeviceIdentity::new(installation, None).unwrap()).unwrap();
        let credential = ClientCredential::new(principal, secret).unwrap();
        core.storage.with_store(|store| {
            store.register_client(&registration, &credential, super::super::state::now_ms() as i64).unwrap().identity().client_id().to_string()
        }).expect("almacén abierto")
    }

    fn post(port: u16, token: &str, body: &Value) -> (u16, Value) {
        let body = body.to_string();
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(stream, "POST /rpc HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, payload) = raw.split_once("\r\n\r\n").unwrap();
        let status = head.lines().next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_str(payload).unwrap())
    }

    fn get(port: u16, token: &str, path: &str) -> (u16, Value) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n").unwrap();
        let mut raw = String::new();
        stream.read_to_string(&mut raw).unwrap();
        let (head, payload) = raw.split_once("\r\n\r\n").unwrap();
        let status = head.lines().next().unwrap().split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, serde_json::from_str(payload).unwrap())
    }

    fn create_ui_task(core: &Arc<Core>, objective: &str) -> String {
        let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        core.rpc_via(
            super::super::events::Channel::Ui,
            super::super::Caller::User,
            &cwd,
            "run_create",
            &json!({ "objective": objective }),
        )
        .unwrap()["task"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn credencial_cli_deriva_actor_y_client_id_y_rechaza_claims_spoof_antes_de_mutar() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let secret = "cli-authenticated-secret-85-at-least-32-bytes";
        let client_id = register(&core, ClientSurface::Cli, ClientPrincipal::Person("person-cli-85".into()), "install-cli-http-85", secret);
        let server = start(core.clone()).unwrap();
        let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        let head_before = core.storage.with_store(|s| s.events_head().unwrap()).unwrap();

        let (status, response) = post(server.port, secret, &json!({
            "cmd": "run_create",
            "cwd": cwd,
            "caller": "task-spoofed",
            "client_id": "client-spoofed",
            "args": {"objective": "claim spoof test"}
        }));
        assert_eq!(status, 200);
        assert_eq!(response["ok"], false, "los claims no pueden elevar ni cambiar identidad");
        assert_eq!(core.storage.with_store(|s| s.events_head().unwrap()).unwrap(), head_before, "rechazo antes de mutar");

        let (status, response) = post(server.port, secret, &json!({
            "cmd": "run_create",
            "cwd": cwd,
            "args": {"objective": "cli authenticated event"}
        }));
        assert_eq!(status, 200);
        assert_eq!(response["ok"], true);
        let events = core.storage.with_store(|s| s.events_page(&EventQuery { after: Some(head_before), limit: Some(100), ..Default::default() }).unwrap().events).unwrap();
        assert!(!events.is_empty(), "run_create debe emitir Events");
        assert!(events.iter().all(|event| event.client_id.as_deref() == Some(client_id.as_str())), "los Events usan client_id autenticado");
        assert!(events.iter().all(|event| event.actor_kind.as_str() == "person" && event.actor_id.as_deref() == Some("person-cli-85") && event.channel.as_deref() == Some("lxo")), "actor y canal derivan de la credencial y el transporte");
        server.stop();
    }

    #[test]
    fn credencial_agent_rechaza_decision_humana_antes_de_mutar() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let secret = "agent-authenticated-secret-85-at-least-32-bytes";
        let _client_id = register(&core, ClientSurface::Cli, ClientPrincipal::Agent("task-agent-85".into()), "install-agent-http-85", secret);
        let server = start(core.clone()).unwrap();
        let head_before = core.storage.with_store(|s| s.events_head().unwrap()).unwrap();

        let (status, response) = post(server.port, secret, &json!({
            "cmd": "review",
            "cwd": std::env::current_dir().unwrap().to_string_lossy(),
            "args": {"task": "task-agent-85", "confirm": true}
        }));
        assert_eq!(status, 200);
        assert_eq!(response["ok"], false, "un Agent no puede ejecutar una decisión humana");
        assert_eq!(core.storage.with_store(|s| s.events_head().unwrap()).unwrap(), head_before, "rechazo antes de mutar");
        server.stop();
    }

    #[test]
    fn credencial_person_cli_no_puede_quitar_un_run() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        let created = core
            .rpc_via(
                super::super::events::Channel::Ui,
                super::super::Caller::User,
                &cwd,
                "run_create",
                &json!({ "objective": "run to protect from CLI Person" }),
            )
            .unwrap();
        let run = created["run"].as_str().unwrap().to_string();

        let secret = "person-cli-remove-run-secret-85-at-least-32-bytes";
        register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("person-cli-remove-85".into()),
            "install-cli-remove-85",
            secret,
        );
        let server = start(core.clone()).unwrap();
        let head_before = core
            .storage
            .with_store(|store| store.events_head().unwrap())
            .unwrap();

        let (status, response) = post(
            server.port,
            secret,
            &json!({ "cmd": "remove_run", "args": { "run": run } }),
        );

        assert_eq!(status, 200);
        assert_eq!(response["ok"], false, "Person/Cli no hereda permisos de la interfaz");
        assert!(core.lock().runs.contains_key(&run), "el run permanece intacto");
        assert_eq!(
            core.storage
                .with_store(|store| store.events_head().unwrap())
                .unwrap(),
            head_before,
            "el rechazo ocurre antes de mutar"
        );
        server.stop();
    }

    #[test]
    fn credencial_person_cli_no_puede_leer_eventos_sin_acotar() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let secret = "person-cli-events-secret-85-at-least-32-bytes";
        register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("person-cli-events-85".into()),
            "install-cli-events-85",
            secret,
        );
        let server = start(core).unwrap();

        let (status, response) = get(server.port, secret, "/events");

        assert_eq!(status, 403, "Person/Cli no hereda la lectura de eventos de Desktop: {response}");
        assert_eq!(response["ok"], false);
        server.stop();
    }

    #[test]
    fn credencial_person_cli_no_puede_detener_tarea_de_interfaz() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        let created = core
            .rpc_via(
                super::super::events::Channel::Ui,
                super::super::Caller::User,
                &cwd,
                "run_create",
                &json!({ "objective": "task to protect from CLI stop" }),
            )
            .unwrap();
        let task = created["task"].as_str().unwrap().to_string();
        let initial_status = core.lock().task(&task).unwrap().status;

        let secret = "person-cli-stop-secret-85-at-least-32-bytes";
        register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("person-cli-stop-85".into()),
            "install-cli-stop-85",
            secret,
        );
        let server = start(core.clone()).unwrap();
        let head_before = core
            .storage
            .with_store(|store| store.events_head().unwrap())
            .unwrap();

        let (status, response) = post(
            server.port,
            secret,
            &json!({ "cmd": "stop", "args": { "task": task } }),
        );

        assert_eq!(status, 200);
        assert_eq!(response["ok"], false, "Person/Cli no hereda stop de Desktop: {response}");
        assert!(response["error"].as_str().unwrap().contains("Acción no permitida"));
        assert_eq!(core.lock().task(&task).unwrap().status, initial_status);
        assert_eq!(
            core.storage
                .with_store(|store| store.events_head().unwrap())
                .unwrap(),
            head_before,
            "el rechazo ocurre antes de mutar"
        );
        server.stop();
    }

    #[test]
    fn credencial_person_cli_no_puede_liberar_tarea_de_interfaz() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        let created = core
            .rpc_via(
                super::super::events::Channel::Ui,
                super::super::Caller::User,
                &cwd,
                "run_create",
                &json!({ "objective": "task to protect from CLI release" }),
            )
            .unwrap();
        let task = created["task"].as_str().unwrap().to_string();
        let initial_status = core.lock().task(&task).unwrap().status;

        let secret = "person-cli-release-secret-85-at-least-32-bytes";
        register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("person-cli-release-85".into()),
            "install-cli-release-85",
            secret,
        );
        let server = start(core.clone()).unwrap();
        let head_before = core
            .storage
            .with_store(|store| store.events_head().unwrap())
            .unwrap();

        let (status, response) = post(
            server.port,
            secret,
            &json!({ "cmd": "release", "args": { "task": task, "force": true } }),
        );

        assert_eq!(status, 200);
        assert_eq!(response["ok"], false, "Person/Cli no hereda release de Desktop: {response}");
        assert!(response["error"].as_str().unwrap().contains("Acción no permitida"));
        assert_eq!(core.lock().task(&task).unwrap().status, initial_status);
        assert_eq!(
            core.storage
                .with_store(|store| store.events_head().unwrap())
                .unwrap(),
            head_before,
            "el rechazo ocurre antes de mutar"
        );
        server.stop();
    }

    #[test]
    fn credencial_person_cli_no_puede_seguir_ni_ver_diff_de_cualquier_tarea() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let task = create_ui_task(&core, "task scoped against CLI Person");
        let secret = "person-cli-scoped-command-secret-85-32-bytes";
        register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("person-cli-scoped-85".into()),
            "install-cli-scoped-85",
            secret,
        );
        let server = start(core).unwrap();

        for (cmd, args) in [
            ("continue", json!({ "task": task, "spec": "reopen as CLI Person" })),
            ("diff", json!({ "task": task })),
        ] {
            let (status, response) = post(server.port, secret, &json!({ "cmd": cmd, "args": args }));
            assert_eq!(status, 200);
            assert_eq!(response["ok"], false, "{cmd} debe rechazarse: {response}");
            assert!(
                response["error"].as_str().unwrap().contains("Acción no permitida"),
                "{cmd} debe rechazarse antes de consultar o mutar tareas: {response}"
            );
        }
        server.stop();
    }
}
