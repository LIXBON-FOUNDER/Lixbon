//! HTTP local por el que habla `lxo`. Solo 127.0.0.1 y con credencial registrada;
//! el puerto y la identidad pública se publican en `~/.lixbon/orch.json`, nunca el secreto.
//! `GET /handshake` negocia el contrato; `POST /rpc` despacha comandos; `GET /events` lee el Event Log.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};
use crate::store::{AuthenticatedClient, ClientAction, ClientAuthentication, ClientClaims, ClientPrincipal};

use super::Core;

pub struct Handle {
    pub port: u16,
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
    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    thread::spawn(move || {
        for conn in listener.incoming() {
            if stop_t.load(Ordering::Relaxed) {
                break;
            }
            let Ok(stream) = conn else { continue };
            let core = core.clone();
            thread::spawn(move || {
                let _ = handle(stream, &core);
            });
        }
    });
    Ok(Handle { port, stop })
}

fn authenticate_request(core: &Core, auth: &str) -> Result<AuthenticatedClient, (u16, &'static str, &'static str)> {
    let Some(secret) = auth.strip_prefix("Bearer ").filter(|secret| !secret.is_empty()) else {
        return Err((401, "invalid_credential", "Token inválido: vuelve a abrir la terminal o reinicia Lixbon"));
    };
    match core.authenticate_client_status(secret) {
        Ok(ClientAuthentication::Active(client)) => Ok(client),
        Ok(ClientAuthentication::Invalid) => Err((401, "invalid_credential", "Token inválido: vuelve a abrir la terminal o reinicia Lixbon")),
        Ok(ClientAuthentication::Expired(_)) => Err((401, "credential_expired", "La credencial caducó; vuelve a iniciar Lixbon para rotarla")),
        Ok(ClientAuthentication::Revoked(_)) => Err((401, "credential_revoked", "La credencial fue revocada; crea una nueva instalación desde Lixbon")),
        Err(_) => Err((503, "core_unavailable", "La autenticación de clientes no está disponible")),
    }
}

fn handle(mut stream: TcpStream, core: &Arc<Core>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));

    let mut len = 0usize;
    let mut auth = String::new();
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h)? == 0 || h.trim().is_empty() {
            break;
        }
        let (k, v) = h.split_once(':').unwrap_or((&h, ""));
        match k.trim().to_ascii_lowercase().as_str() {
            "content-length" => len = v.trim().parse().unwrap_or(0),
            "authorization" => auth = v.trim().to_string(),
            _ => {}
        }
    }
    if len > MAX_BODY {
        return reply(&mut stream, 413, &json!({ "ok": false, "error": "Petición demasiado grande" }));
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;

    let (route, query) = path.split_once('?').unwrap_or((path, ""));
    if route == "/handshake" {
        if method != "GET" {
            return reply(&mut stream, 405, &json!({ "ok": false, "code": "method_not_allowed", "error": "El handshake solo admite GET" }));
        }
        let client = match authenticate_request(core, &auth) {
            Ok(identity) => identity,
            Err((status, code, error)) => return reply(&mut stream, status, &json!({ "ok": false, "code": code, "error": error })),
        };
        if client.identity().surface() != crate::store::ClientSurface::Cli {
            return reply(&mut stream, 403, &json!({ "ok": false, "code": "forbidden", "error": "El handshake requiere una identidad CLI" }));
        }
        let schema_version = match core.storage.read_store(|store| store.schema_version()) {
            Some(Ok(version)) => version,
            _ => return reply(&mut stream, 503, &json!({ "ok": false, "code": "core_unavailable", "error": "El almacén del Core no está disponible" })),
        };
        return reply(&mut stream, 200, &json!({
            "ok": true,
            "data": {
                "core_version": env!("CARGO_PKG_VERSION"),
                "protocol_version": 1,
                "schema_version": schema_version,
                "capabilities": ["rpc", "events.read"],
                "client_id": client.identity().client_id(),
            }
        }));
    }
    if route == "/events" {
        let client = match authenticate_request(core, &auth) {
            Ok(identity) => identity,
            Err((status, code, error)) => return reply(&mut stream, status, &json!({ "ok": false, "code": code, "error": error })),
        };
        if method != "GET" {
            return reply(&mut stream, 405, &json!({ "ok": false, "error": "El Event Log es de solo lectura: usa GET /events" }));
        }
        if client.validate_claims(&ClientClaims::default(), "lxo").is_err() || client.authorize(ClientAction::EventLogRead).is_err() {
            return reply(&mut stream, 403, &json!({ "ok": false, "code": "forbidden", "error": "Identidad no autorizada para este canal" }));
        }
        let caller = match client.identity().principal() {
            ClientPrincipal::Person(_) => super::Caller::User,
            ClientPrincipal::Agent(task) => super::Caller::Agent(Some(task.clone())),
            ClientPrincipal::System => return reply(&mut stream, 403, &json!({ "ok": false, "code": "forbidden", "error": "La identidad Core/System está reservada" })),
        };
        let (code, body) = core.events_http(caller, query);
        return reply(&mut stream, code, &body);
    }
    if method != "POST" || path != "/rpc" {
        return reply(&mut stream, 404, &json!({ "ok": false, "error": "No encontrado" }));
    }
    let client = match authenticate_request(core, &auth) {
        Ok(identity) => identity,
        Err((status, code, error)) => return reply(&mut stream, status, &json!({ "ok": false, "code": code, "error": error })),
    };
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let cwd = req.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
    let cmd = req.get("cmd").and_then(Value::as_str).unwrap_or("");
    let args = req.get("args").cloned().unwrap_or(Value::Null);
    // Las esperas largas (wait, ask) superan el timeout de lectura por diseño.
    stream.set_read_timeout(None)?;
    // Rechazo explícito antes de despachar: decisiones humanas y lecturas cerradas (review.rs).
    if let Some(why) = super::review::closed_to_agents(cmd) {
        return reply(&mut stream, 403, &json!({ "ok": false, "code": "forbidden", "error": why }));
    }
    let claims: ClientClaims = match serde_json::from_value(req.clone()) {
        Ok(claims) => claims,
        Err(_) => return reply(&mut stream, 400, &json!({ "ok": false, "error": "Claims de cliente inválidos" })),
    };
    let res = guarded(cmd, || core.rpc_authenticated_via(&client, &claims, super::events::Channel::Lxo, &cwd, cmd, &args));
    if res["ok"] == false {
        let error = res["error"].as_str().unwrap_or("");
        if error.contains("Identidad de cliente inválida") || error.contains("Acción no permitida para esta identidad") {
            return reply(&mut stream, 403, &json!({ "ok": false, "code": "forbidden", "error": error }));
        }
    }
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
    use crate::store::{ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity};

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
        let (_cleanup, data, core_dir) = crate::orch::boot_tests::dirs();
        let (core, _host, started) = crate::orch::boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        core.settings.lock().unwrap().enabled = true;
        let secret = "large-response-cli-token-test-only-32-bytes";
        let registration = ClientRegistration::new(ClientSurface::Cli, DeviceIdentity::new("install-large-response", None).unwrap()).unwrap();
        let credential = ClientCredential::new(ClientPrincipal::Person("user".into()), secret).unwrap();
        core.storage.with_store(|store| store.register_client(&registration, &credential, super::super::state::now_ms() as i64)).unwrap().unwrap();
        let spec = "x".repeat(3 * 1024 * 1024);
        core.lock_unpersisted().create_run("obj", NewTask {
            agent: "coordinador".into(), model: None, effort: None, role: None, title: "t".into(), spec: spec.clone(),
            repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: true,
        });
        let h = start(core).unwrap();
        let body = r#"{"cmd":"list","args":{}}"#;
        let mut s = TcpStream::connect(("127.0.0.1", h.port)).unwrap();
        // Bytes de más tras el cuerpo: sin leer en el servidor al cerrar, Windows manda un RST.
        write!(s, "POST /rpc HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {secret}\r\nContent-Length: {}\r\n\r\n{}EXTRA-SIN-LEER", body.len(), body).unwrap();
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
    use crate::store::{
        AttentionCategory, AttentionTarget, ClientCredential, ClientPrincipal, ClientRegistration,
        ClientSurface, DeviceIdentity, EventQuery, NewAttention, Raised, Severity, TargetKind,
    };
    use crate::orch::state::NewTask;

    pub(super) fn register(core: &Core, surface: ClientSurface, principal: ClientPrincipal, installation: &str, secret: &str) -> String {
        let registration = ClientRegistration::new(surface, DeviceIdentity::new(installation, None).unwrap()).unwrap();
        let credential = ClientCredential::new(principal, secret).unwrap();
        core.storage.with_store(|store| {
            store.register_client(&registration, &credential, super::super::state::now_ms() as i64).unwrap().identity().client_id().to_string()
        }).expect("almacén abierto")
    }

    pub(super) fn post(port: u16, token: &str, body: &Value) -> (u16, Value) {
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

    #[test]
    fn el_token_compartido_legacy_no_autoriza_rpc_ni_events() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let server = start(core).unwrap();

        let legacy_token = "legacy-shared-server-token-test-only-32-bytes";
        let (rpc_status, rpc) = post(server.port, legacy_token, &json!({ "cmd": "status", "args": {} }));
        assert_eq!((rpc_status, rpc["code"].as_str()), (401, Some("invalid_credential")));
        let (events_status, events) = get(server.port, legacy_token, "/events");
        assert_eq!((events_status, events["code"].as_str()), (401, Some("invalid_credential")));
        server.stop();
    }

    #[test]
    fn cli_handshake_returns_versions_capabilities_and_authenticated_client_id() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let secret = "handshake-cli-secret-lxo86-test-only-32-bytes";
        let client_id = register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("user".into()),
            "install-lxo-handshake-86",
            secret,
        );
        let server = start(core).unwrap();

        let (status, response) = get(server.port, secret, "/handshake");

        assert_eq!(status, 200, "el cliente autenticado debe poder negociar el protocolo: {response}");
        assert_eq!(response["ok"], true);
        assert_eq!(response["data"]["core_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(response["data"]["protocol_version"], 1);
        assert_eq!(response["data"]["schema_version"], 6);
        assert_eq!(response["data"]["capabilities"], json!(["rpc", "events.read"]));
        assert_eq!(response["data"]["client_id"], client_id);
        assert!(!response.to_string().contains(secret), "el handshake no debe devolver la credencial");
        server.stop();
    }

    #[test]
    fn handshake_distinguishes_missing_credential_from_forbidden_surface() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let secret = "desktop-handshake-secret-lxo86-test-only-32-bytes";
        register(
            &core,
            ClientSurface::Desktop,
            ClientPrincipal::Person("user".into()),
            "install-lxo-handshake-desktop-86",
            secret,
        );
        let server = start(core).unwrap();

        let (status, invalid) = get(server.port, "not-a-registered-credential", "/handshake");
        assert_eq!(status, 401);
        assert_eq!(invalid["code"], "invalid_credential");

        let (status, forbidden) = get(server.port, secret, "/handshake");
        assert_eq!(status, 403);
        assert_eq!(forbidden["code"], "forbidden");
        server.stop();
    }

    #[test]
    fn handshake_distingue_credenciales_vencidas_y_revocadas() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let expired_secret = "expired-handshake-secret-lxo86-test-only-32-bytes";
        let revoked_secret = "revoked-handshake-secret-lxo86-test-only-32-bytes";
        let old = super::super::state::now_ms() as i64 - crate::store::CLIENT_CREDENTIAL_TTL_MS - 1;
        let registration = ClientRegistration::new(
            ClientSurface::Cli,
            DeviceIdentity::new("install-lxo-handshake-expiry-86", None).unwrap(),
        ).unwrap();
        let expired = ClientCredential::new(ClientPrincipal::Person("user".into()), expired_secret).unwrap();
        let revoked = ClientCredential::new(ClientPrincipal::Person("user".into()), revoked_secret).unwrap();
        core.storage.with_store(|store| {
            store.register_client(&registration, &expired, old).unwrap();
            let client = store.register_client(&registration, &revoked, super::super::state::now_ms() as i64).unwrap();
            store.revoke_credential(client.credential_id(), super::super::state::now_ms() as i64).unwrap();
        }).unwrap();
        let server = start(core).unwrap();

        let (status, expired) = get(server.port, expired_secret, "/handshake");
        assert_eq!(status, 401);
        assert_eq!(expired["code"], "credential_expired");
        let (status, revoked) = get(server.port, revoked_secret, "/handshake");
        assert_eq!(status, 401);
        assert_eq!(revoked["code"], "credential_revoked");
        server.stop();
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

    fn fake_policy(provider: &str, profile: &str, role: Option<&str>, worktree: &str) -> super::super::agents::Policy {
        let profile = super::super::agents::Profile::parse(profile).expect("perfil válido");
        super::super::agents::evaluate_for(
            provider,
            profile,
            role,
            worktree,
            super::super::agents::Detected::Skip,
            false,
            super::super::agents::Delivery::FileOrMarkers,
        )
    }

    fn arranca_con_resolver_falso() -> (boot_tests::Limpia, Arc<Core>) {
        let (cleanup, data, core_dir) = boot_tests::dirs();
        let mut orch = super::super::Orch::default();
        Arc::get_mut(&mut orch.0).expect("Core sin compartir").resolver = fake_policy;
        let core = orch.0;
        let host = super::super::host::RecordingHost::new();
        core.init_in(host, &data, &core_dir).unwrap();
        core.settings.lock().unwrap().enabled = true;
        (cleanup, core)
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
        assert_eq!(status, 403);
        assert_eq!(response["ok"], false, "los claims no pueden elevar ni cambiar identidad");
        assert_eq!(response["code"], "forbidden");
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
        assert_eq!(status, 403);
        assert_eq!(response["ok"], false, "un Agent no puede ejecutar una decisión humana");
        assert_eq!(response["code"], "forbidden");
        assert_eq!(core.storage.with_store(|s| s.events_head().unwrap()).unwrap(), head_before, "rechazo antes de mutar");
        server.stop();
    }

    #[test]
    fn comando_rpc_sin_clasificar_se_rechaza_en_la_frontera_agent() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let secret = "agent-unknown-command-secret-lxo86-test-only-32-bytes";
        register(&core, ClientSurface::Cli, ClientPrincipal::Agent("task-unknown-86".into()), "install-agent-unknown-86", secret);
        let server = start(core.clone()).unwrap();
        let head_before = core.storage.with_store(|store| store.events_head().unwrap()).unwrap();

        let (status, response) = post(server.port, secret, &json!({
            "cmd": "new_unclassified_rpc",
            "args": {},
            "cwd": std::env::current_dir().unwrap().to_string_lossy()
        }));
        assert_eq!(status, 403);
        assert_eq!(response["code"], "forbidden");
        assert_eq!(core.storage.with_store(|store| store.events_head().unwrap()).unwrap(), head_before);
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

        assert_eq!(status, 403);
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
    fn credencial_person_cli_puede_leer_eventos_globales() {
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

        assert_eq!(status, 200, "Person/Cli coordinador puede leer el diario: {response}");
        assert_eq!(response["ok"], true);
        assert!(response["data"]["events"].as_array().is_some());
        server.stop();
    }

    #[test]
    fn http_rpc_attention_aplica_scope_autenticado_y_comparte_dto() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        core.settings.lock().unwrap().enabled = true;
        let own_task = create_ui_task(&core, "attention HTTP own task");
        let other_task = create_ui_task(&core, "attention HTTP other task");
        let person_secret = "person-attention-http-secret-at-least-32-bytes";
        let agent_secret = "agent-attention-http-secret-at-least-32-bytes";
        register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("person-attention-http".into()),
            "install-person-attention-http",
            person_secret,
        );
        register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Agent(own_task.clone()),
            "install-agent-attention-http",
            agent_secret,
        );
        let make_attention = |target: &str, at| NewAttention {
            category: AttentionCategory::Failed,
            severity: Severity::High,
            target: AttentionTarget::new(TargetKind::Task, target).unwrap(),
            project_id: Some("project-http".into()),
            run_id: None,
            subject: Some(format!("private-{target}")),
            source_event_id: None,
            correlation_id: None,
            facts: "{\"internal\":\"must-not-leak\"}".into(),
            at,
        };
        let add_attention = |new: NewAttention| {
            core.storage
                .with_store(|store| match store.attention_raise(&new).unwrap() {
                    Raised::Created(row) => row.id,
                    other => panic!("se esperaba una fila nueva, salió {other:?}"),
                })
                .unwrap()
        };
        let own_id = add_attention(make_attention(&own_task, 1_000));
        let other_id = add_attention(make_attention(&other_task, 2_000));
        let server = start(core).unwrap();

        let (status, person) = post(server.port, person_secret, &json!({
            "cmd": "attention_list", "args": {"limit": 10}
        }));
        assert_eq!(status, 200);
        assert_eq!(person["ok"], true, "Person CLI puede leer el Core local: {person}");
        let items = person["data"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        let fields: std::collections::BTreeSet<_> = items[0].as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(fields, [
            "category", "created_at", "id", "occurrence", "project_id", "resolution",
            "resolved_at", "run_id", "severity", "status", "target_id", "target_kind",
        ].into_iter().collect());
        let (status, detail) = post(server.port, person_secret, &json!({
            "cmd": "attention_detail", "args": {"attention_id": items[0]["id"]}
        }));
        assert_eq!(status, 200);
        assert_eq!(detail["ok"], true, "detail también pasa por el DTO común: {detail}");
        assert_eq!(detail["data"]["id"], items[0]["id"]);

        let (status, agent) = post(server.port, agent_secret, &json!({
            "cmd": "attention_list", "args": {"limit": 10}
        }));
        assert_eq!(status, 200);
        assert_eq!(agent["ok"], true, "Agent puede leer su Task: {agent}");
        assert_eq!(agent["data"]["items"].as_array().unwrap().len(), 1);
        assert_eq!(agent["data"]["items"][0]["id"], own_id);

        let (status, scoped) = post(server.port, agent_secret, &json!({
            "cmd": "attention_list", "args": {"target_id": other_task}
        }));
        assert_eq!(status, 200);
        assert_eq!(scoped["ok"], true);
        assert_eq!(scoped["data"]["items"].as_array().unwrap().len(), 0, "filtro no amplía scope Agent");

        let (status, detail) = post(server.port, agent_secret, &json!({
            "cmd": "attention_detail", "args": {"attention_id": other_id}
        }));
        assert_eq!(status, 200);
        assert_eq!(detail["ok"], false, "detail ajeno se oculta igual que inexistente");

        let (status, spoofed) = post(server.port, person_secret, &json!({
            "cmd": "attention_list", "caller": own_task, "args": {}
        }));
        assert_eq!(status, 403);
        assert_eq!(spoofed["ok"], false, "claims del request no cambian el principal autenticado");
        assert_eq!(spoofed["code"], "forbidden");

        let (status, legacy) = post(server.port, "legacy-shared-server-token-test-only-32-bytes", &json!({
            "cmd": "attention_list", "caller": own_task, "args": {}
        }));
        assert_eq!(status, 401, "el token legacy del servidor ya no autentica RPC");
        assert_eq!(legacy["code"], "invalid_credential");
        server.stop();
    }

    #[test]
    fn http_rpc_resource_inventory_es_solo_para_person_autenticada() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        core.settings.lock().unwrap().enabled = true;
        let task = create_ui_task(&core, "resource HTTP task");
        let person_secret = "person-resource-http-secret-at-least-32-bytes";
        let agent_secret = "agent-resource-http-secret-at-least-32-bytes";
        register(&core, ClientSurface::Cli, ClientPrincipal::Person("person-resource-http".into()), "install-person-resource-http", person_secret);
        register(&core, ClientSurface::Cli, ClientPrincipal::Agent(task.clone()), "install-agent-resource-http", agent_secret);
        let server = start(core).unwrap();

        // `probe: false`: solo registro de git y disco; no ejecuta `git status` sobre el repo de quien corre la prueba.
        let (status, person) = post(server.port, person_secret, &json!({ "cmd": "resource_inventory", "args": { "probe": false } }));
        assert_eq!(status, 200);
        assert_eq!(person["ok"], true, "Person CLI lee el inventario del Core local");
        let data = &person["data"];
        let fields: std::collections::BTreeSet<_> = data.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(fields, ["filters", "machine", "preserved_branches", "repos", "v", "warnings", "worktrees"].into_iter().collect());
        assert_eq!(data["v"], 1);
        assert_eq!(data["warnings"]["branches_to_review"], serde_json::Value::Null, "sin sondeo no hay cuenta");
        assert!(data["repos"].as_array().unwrap().iter().any(|r| r["scan"] == "ok"), "el repo de la Task se escaneó");

        let (_, invalid) = post(server.port, person_secret, &json!({ "cmd": "resource_inventory", "args": { "path": "/tmp" } }));
        assert_eq!(invalid["ok"], false);
        assert!(invalid["error"].as_str().unwrap().contains("resource_inventory_invalid_request"));

        let (status, agent) = post(server.port, agent_secret, &json!({ "cmd": "resource_inventory", "args": {} }));
        assert_eq!(status, 200);
        assert_eq!(agent["ok"], false, "un Agent no lee el inventario");
        assert!(agent["error"].as_str().unwrap().contains("resource_inventory_auth_required"));

        let (status, legacy) = post(server.port, "legacy-shared-server-token-test-only-32-bytes", &json!({ "cmd": "resource_inventory", "caller": task, "args": {} }));
        assert_eq!(status, 401, "el token legacy ya no autentica RPC");
        assert_eq!(legacy["code"], "invalid_credential");
        server.stop();
    }

    #[test]
    fn http_rpc_activity_list_es_solo_para_person_autenticada() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        core.settings.lock().unwrap().enabled = true;
        let task = create_ui_task(&core, "activity HTTP task");
        let person_secret = "person-activity-http-secret-at-least-32-bytes";
        let agent_secret = "agent-activity-http-secret-at-least-32-bytes";
        register(&core, ClientSurface::Cli, ClientPrincipal::Person("person-activity-http".into()), "install-person-activity-http", person_secret);
        register(&core, ClientSurface::Cli, ClientPrincipal::Agent(task.clone()), "install-agent-activity-http", agent_secret);
        let server = start(core).unwrap();

        let (status, person) = post(server.port, person_secret, &json!({ "cmd": "activity_list", "args": { "limit": 50 } }));
        assert_eq!(status, 200);
        assert_eq!(person["ok"], true, "Person CLI lee Activity del Core local");
        let data = &person["data"];
        assert_eq!((data["v"].as_u64(), data["projection"].as_u64(), data["order"].as_str()), (Some(1), Some(1), Some("asc")));
        let items = data["items"].as_array().unwrap();
        assert!(!items.is_empty(), "crear el run dejó eventos");
        let fields: std::collections::BTreeSet<_> = items[0].as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            fields,
            ["actor", "args", "class", "correlation_id", "event_id", "fallback", "kind", "message_key", "project_id", "provenance", "run_id", "seq", "target", "ts", "v", "visual"]
                .into_iter()
                .collect()
        );
        assert!(items.iter().any(|i| i["message_key"] == "activity.run.created"));
        assert!(items.iter().all(|i| i["fallback"] == false), "los eventos reales no caen al respaldo");

        let cursor = data["next_cursor"].as_i64().unwrap();
        let (_, next) = post(server.port, person_secret, &json!({ "cmd": "activity_list", "args": { "cursor": cursor } }));
        assert_eq!(next["ok"], true);
        assert!(next["data"]["items"].as_array().unwrap().is_empty(), "retomar desde next_cursor no repite nada");
        let (_, invalid) = post(server.port, person_secret, &json!({ "cmd": "activity_list", "args": { "kind": "task.created" } }));
        assert_eq!(invalid["ok"], false);
        assert!(invalid["error"].as_str().unwrap().contains("activity_invalid_request"));

        let (status, agent) = post(server.port, agent_secret, &json!({ "cmd": "activity_list", "args": {} }));
        assert_eq!(status, 200);
        assert_eq!(agent["ok"], false, "un Agent no lee Activity");
        assert!(agent["error"].as_str().unwrap().contains("activity_auth_required"));

        let (status, legacy) = post(server.port, "legacy-shared-server-token-test-only-32-bytes", &json!({ "cmd": "activity_list", "caller": task, "args": {} }));
        assert_eq!(status, 401, "el token legacy ya no autentica RPC");
        assert_eq!(legacy["code"], "invalid_credential");
        server.stop();
    }

    #[test]
    fn http_rpc_projects_overview_es_solo_para_person_autenticada() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        core.settings.lock().unwrap().enabled = true;
        let task = create_ui_task(&core, "overview HTTP task");
        let project_id = core
            .storage
            .with_store(|store| {
                store
                    .project_create(
                        "Overview HTTP",
                        &crate::store::Fingerprint::default(),
                        &crate::store::NewLocation { machine: "machine-http".into(), path: "/repos/http".into(), display_path: "/repos/http".into(), primary: true },
                    )
                    .unwrap()
                    .id
            })
            .unwrap();
        core.mutate(|tx| {
            tx.tasks.get_mut(&task).unwrap().project_id = Some(project_id.clone());
            Ok(())
        })
        .unwrap();
        let person_secret = "person-overview-http-secret-at-least-32-bytes";
        let agent_secret = "agent-overview-http-secret-at-least-32-bytes";
        register(&core, ClientSurface::Cli, ClientPrincipal::Person("person-overview-http".into()), "install-person-overview-http", person_secret);
        register(&core, ClientSurface::Cli, ClientPrincipal::Agent(task.clone()), "install-agent-overview-http", agent_secret);
        let server = start(core).unwrap();

        let (status, person) = post(server.port, person_secret, &json!({ "cmd": "projects_overview", "args": {} }));
        assert_eq!(status, 200);
        assert_eq!(person["ok"], true, "Person CLI no pudo leer el overview del Core local");
        let data = &person["data"];
        assert_eq!(data["v"], 1);
        // `run_create` descubre y registra solo el proyecto del repo en curso: aquí hay ese y el de la prueba.
        assert_eq!(data["total"], 2);
        let project = data["projects"].as_array().unwrap().iter().find(|p| p["id"] == project_id.as_str()).expect("el proyecto de la prueba");
        assert_eq!(project["counts"]["tasks"], 1);
        assert_eq!(project["counts"]["active"], 1);
        let fields: std::collections::BTreeSet<_> = project.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(fields, ["counts", "id", "locations", "name", "state", "status"].into_iter().collect());

        let (_, archived) = post(server.port, person_secret, &json!({ "cmd": "projects_overview", "args": { "archived": "only" } }));
        assert_eq!(archived["data"]["total"], 0, "el filtro viaja por HTTP");
        let (_, invalid) = post(server.port, person_secret, &json!({ "cmd": "projects_overview", "args": { "limit": 5 } }));
        assert_eq!(invalid["ok"], false);
        assert!(invalid["error"].as_str().unwrap().contains("projects_overview_invalid_request"));

        let (status, agent) = post(server.port, agent_secret, &json!({ "cmd": "projects_overview", "args": {} }));
        assert_eq!(status, 200);
        assert_eq!(agent["ok"], false, "un Agent no lee el overview multiproyecto");
        assert!(agent["error"].as_str().unwrap().contains("projects_overview_auth_required"));

        let (status, legacy) = post(server.port, "legacy-shared-server-token-test-only-32-bytes", &json!({ "cmd": "projects_overview", "caller": task, "args": {} }));
        assert_eq!(status, 401, "el token legacy ya no autentica RPC");
        assert_eq!(legacy["code"], "invalid_credential");
        server.stop();
    }

    #[test]
    fn credencial_person_cli_puede_detener_tarea_de_interfaz_como_persona() {
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
        let client_id = register(
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

        assert_eq!(status, 200, "Person/Cli coordinador puede detener una tarea: {response}");
        assert_eq!(response["ok"], true);
        assert_ne!(core.lock().task(&task).unwrap().status, initial_status);
        let events = core.storage.with_store(|store| {
            store.events_page(&EventQuery { after: Some(head_before), limit: Some(100), ..Default::default() }).unwrap().events
        }).unwrap();
        assert!(!events.is_empty(), "stop debe confirmar un cambio de estado");
        assert!(events.iter().all(|event| event.client_id.as_deref() == Some(client_id.as_str())));
        assert!(events.iter().all(|event| event.actor_kind.as_str() == "person"
            && event.actor_id.as_deref() == Some("person-cli-stop-85")
            && event.channel.as_deref() == Some("lxo")), "caller y actor se derivan de la credencial");
        server.stop();
    }

    #[test]
    fn credencial_person_cli_puede_liberar_tarea_de_interfaz_como_persona() {
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
        let client_id = register(
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

        assert_eq!(status, 200, "Person/Cli coordinador puede liberar una tarea: {response}");
        assert_eq!(response["ok"], true);
        assert_ne!(core.lock().task(&task).unwrap().status, initial_status);
        let events = core.storage.with_store(|store| {
            store.events_page(&EventQuery { after: Some(head_before), limit: Some(100), ..Default::default() }).unwrap().events
        }).unwrap();
        assert!(!events.is_empty(), "release debe confirmar un cambio de estado");
        assert!(events.iter().all(|event| event.client_id.as_deref() == Some(client_id.as_str())));
        assert!(events.iter().all(|event| event.actor_kind.as_str() == "person"
            && event.actor_id.as_deref() == Some("person-cli-release-85")
            && event.channel.as_deref() == Some("lxo")), "caller y actor se derivan de la credencial");
        server.stop();
    }

    #[test]
    fn credencial_person_cli_coordinador_puede_consultar_continue_y_diff() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        let task = create_ui_task(&core, "task scoped against CLI Person");
        core.mutate(|tx| {
            let task_state = tx.task_mut(&task)?;
            task_state.branch = Some("HEAD".into());
            task_state.base = Some("HEAD".into());
            Ok(())
        })
        .unwrap();
        let secret = "person-cli-scoped-command-secret-85-32-bytes";
        register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("person-cli-scoped-85".into()),
            "install-cli-scoped-85",
            secret,
        );
        let server = start(core).unwrap();

        let (status, response) = post(server.port, secret, &json!({
            "cmd": "continue",
            "args": { "task": task, "spec": "reopen as CLI Person" }
        }));
        assert_eq!(status, 200, "continue alcanza el coordinador autenticado: {response}");
        assert_eq!(response["ok"], false, "la fixture no tiene terminal para continue: {response}");
        assert!(!response["error"].as_str().unwrap_or("").contains("Acción no permitida"),
            "continue no debe rechazarse por la autorización de superficie: {response}");

        let (status, response) = post(server.port, secret, &json!({
            "cmd": "diff",
            "args": { "task": task }
        }));
        assert_eq!(status, 200, "diff alcanza el coordinador autenticado: {response}");
        assert_eq!(response["ok"], true, "diff debe llegar a la lectura autenticada: {response}");
        assert_eq!(response["data"]["branch"], "HEAD");
        assert_eq!(response["data"]["base"], "HEAD");
        assert_eq!(response["data"]["diff"], "");
        assert!(response["data"]["stat"].is_string());
        server.stop();
    }

    #[test]
    fn person_cli_cierra_el_run_raiz_seleccionado_y_el_evento_conserva_su_actor() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        core.settings.lock().unwrap().enabled = true;
        let root = create_ui_task(&core, "Person CLI selected run close");
        let run = core.lock().task(&root).unwrap().run.clone();
        let secret = "person-run-close-secret-86-at-least-32-bytes";
        let client_id = register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("person-run-close-86".into()),
            "install-person-run-close-86",
            secret,
        );
        let server = start(core.clone()).unwrap();
        let head_before = core.storage.with_store(|store| store.events_head().unwrap()).unwrap();

        let (status, response) = post(server.port, secret, &json!({
            "cmd": "run_close",
            "args": { "root_task": root, "force": false }
        }));

        assert_eq!(status, 200, "Person CLI coordinador puede cerrar su run seleccionado: {response}");
        assert_eq!(response["ok"], true, "la raíz seleccionada debe cerrar correctamente: {response}");
        assert_eq!(response["data"]["run"], run);
        let events = core.storage.with_store(|store| {
            store.events_page(&EventQuery { after: Some(head_before), limit: Some(100), ..Default::default() }).unwrap().events
        }).unwrap();
        let closed = events.iter().find(|event| event.kind == "run.closed").expect("se persiste run.closed");
        assert_eq!(closed.client_id.as_deref(), Some(client_id.as_str()));
        assert_eq!(closed.actor_kind.as_str(), "person");
        assert_eq!(closed.actor_id.as_deref(), Some("person-run-close-86"));
        assert_eq!(closed.channel.as_deref(), Some("lxo"));
        server.stop();
    }

    #[test]
    fn person_cli_rechaza_run_close_cuando_el_selector_no_es_raiz() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        core.settings.lock().unwrap().enabled = true;
        let root = create_ui_task(&core, "Person CLI invalid run close selector");
        let child = core.mutate(|tx| {
            let child = tx.add_child(&root, 2, NewTask {
                agent: "claude".into(), model: None, effort: None, role: None,
                title: "child".into(), spec: "child".into(), repo: "repo".into(), cwd: "cwd".into(),
                branch: None, base: None, worktree: None, external: false,
            })?;
            tx.mark_running(&child)?;
            Ok(child)
        }).unwrap();
        let secret = "person-run-close-invalid-86-at-least-32-bytes";
        register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("person-run-close-invalid-86".into()),
            "install-person-run-close-invalid-86",
            secret,
        );
        let server = start(core.clone()).unwrap();
        let head_before = core.storage.with_store(|store| store.events_head().unwrap()).unwrap();

        let (status, response) = post(server.port, secret, &json!({
            "cmd": "run_close",
            "args": { "root_task": child, "force": true }
        }));

        assert_eq!(status, 200);
        assert_eq!(response["ok"], false, "una tarea hija no puede seleccionar un run para cerrar: {response}");
        assert!(response["error"].as_str().unwrap().contains("raíz"), "{response}");
        assert!(core.lock().runs.values().any(|run| run.root == root && !run.closed), "el run padre permanece abierto");
        assert_eq!(core.storage.with_store(|store| store.events_head().unwrap()).unwrap(), head_before,
            "un selector inválido no emite el cierre ni muta estado");
        server.stop();
    }

    #[test]
    fn agent_cierra_su_run_derivado_y_queda_limitado_a_su_task_y_subarbol() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        core.settings.lock().unwrap().enabled = true;
        let own_root = create_ui_task(&core, "Agent-owned run close");
        let own_run = core.lock().task(&own_root).unwrap().run.clone();
        let outside_root = create_ui_task(&core, "Outside run");
        let outside_run = core.lock().task(&outside_root).unwrap().run.clone();
        let child = core.mutate(|tx| {
            let child = tx.add_child(&own_root, 2, NewTask {
                agent: "claude".into(), model: None, effort: None, role: None,
                title: "Agent child".into(), spec: "child".into(), repo: "repo".into(), cwd: "cwd".into(),
                branch: None, base: None, worktree: None, external: false,
            })?;
            tx.mark_running(&child)?;
            Ok(child)
        }).unwrap();
        let agent_secret = "agent-run-close-scope-86-at-least-32-bytes";
        let person_secret = "person-global-scope-86-at-least-32-bytes";
        let agent_client_id = register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Agent(own_root.clone()),
            "install-agent-run-close-scope-86",
            agent_secret,
        );
        register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Person("person-global-86".into()),
            "install-person-global-scope-86",
            person_secret,
        );
        let server = start(core.clone()).unwrap();
        let head_before = core.storage.with_store(|store| store.events_head().unwrap()).unwrap();

        let (status, in_scope) = post(server.port, agent_secret, &json!({
            "cmd": "send", "args": { "to": child, "body": "within subtree" }
        }));
        assert_eq!(status, 200);
        assert_eq!(in_scope["ok"], true, "el Agent gestiona descendientes de su Task: {in_scope}");

        let (status, outside) = post(server.port, agent_secret, &json!({
            "cmd": "send", "args": { "to": outside_root, "body": "outside subtree" }
        }));
        assert_eq!(status, 200);
        assert_eq!(outside["ok"], false, "el Agent no puede actuar fuera de su Task/subárbol: {outside}");
        assert!(outside["error"].as_str().unwrap().contains("solo puedes gestionar"), "{outside}");

        let (status, person_global) = post(server.port, person_secret, &json!({
            "cmd": "stop", "args": { "task": outside_root }
        }));
        assert_eq!(status, 200);
        assert_eq!(person_global["ok"], true, "Person CLI es operador local global en esta fase: {person_global}");
        assert!(core.lock().runs[&outside_run].closed == false, "detener una tarea externa no cierra el run");

        let (status, spoofed_close) = post(server.port, agent_secret, &json!({
            "cmd": "run_close", "args": { "root_task": outside_root, "force": true }
        }));
        assert_eq!(status, 200);
        assert_eq!(spoofed_close["ok"], false, "Agent no puede seleccionar el run ajeno: {spoofed_close}");
        assert!(spoofed_close["error"].as_str().unwrap().contains("solo puede cerrar"), "{spoofed_close}");
        assert!(!core.lock().runs[&own_run].closed, "un selector Agent inválido no cierra su propio run como efecto colateral");
        assert!(!core.lock().runs[&outside_run].closed, "Agent no puede cerrar un run ajeno usando root_task");

        let (status, close_own) = post(server.port, agent_secret, &json!({
            "cmd": "run_close", "args": { "force": true }
        }));
        assert_eq!(status, 200);
        assert_eq!(close_own["ok"], true, "Agent deriva el run de su identidad autenticada: {close_own}");
        assert_eq!(close_own["data"]["run"], own_run);
        server.stop();
        let events = core.storage.with_store(|store| {
            store.events_page(&EventQuery { after: Some(head_before), limit: Some(100), ..Default::default() }).unwrap().events
        }).unwrap();
        let closed = events.iter().find(|event| event.kind == "run.closed" && event.run_id.as_deref() == Some(own_run.as_str()))
            .expect("el Agent autenticado persiste run.closed para su run");
        assert_eq!(closed.client_id.as_deref(), Some(agent_client_id.as_str()));
        assert_eq!(closed.actor_kind.as_str(), "agent");
        assert_eq!(closed.actor_id.as_deref(), Some(own_root.as_str()));
        assert_eq!(closed.channel.as_deref(), Some("lxo"));
    }

    #[test]
    fn spawn_de_agent_autenticado_persiste_el_client_id_de_la_credencial() {
        let (_cleanup, core) = arranca_con_resolver_falso();
        let task = create_ui_task(&core, "Agent with authenticated spawn identity");
        let secret = "agent-spawn-client-id-secret-85-at-least-32-bytes";
        let client_id = register(
            &core,
            ClientSurface::Cli,
            ClientPrincipal::Agent(task.clone()),
            "install-agent-spawn-85",
            secret,
        );
        let server = start(core.clone()).unwrap();
        let head_before = core.storage.with_store(|store| store.events_head().unwrap()).unwrap();

        let (status, response) = post(
            server.port,
            secret,
            &json!({
                "cmd": "spawn",
                "args": { "agent": "claude", "task": "child task for identity test", "name": "identity child" }
            }),
        );

        assert_eq!(status, 200);
        assert_eq!(response["ok"], true, "spawn debe crear el pendiente sin lanzar hasta aprobación: {response}");
        let events = core
            .storage
            .with_store(|store| {
                store
                    .events_page(&EventQuery { after: Some(head_before), limit: Some(100), ..Default::default() })
                    .unwrap()
                    .events
            })
            .unwrap();
        let requested = events.iter().find(|event| event.kind == "spawn.requested").expect("spawn emite el evento durable");
        assert_eq!(requested.client_id.as_deref(), Some(client_id.as_str()));
        assert_eq!(requested.actor_kind.as_str(), "agent");
        assert_eq!(requested.actor_id.as_deref(), Some(task.as_str()));
        assert_eq!(requested.channel.as_deref(), Some("lxo"));
        server.stop();
    }
}

/// LXO-98 · `tasks_by_project` y `task_detail` de punta a punta por `POST /rpc`.
#[cfg(test)]
mod tasks_http_tests {
    use super::*;
    use super::authenticated_client_tests::{post, register};
    use crate::orch::boot_tests;
    use crate::orch::tasks_read_tests::{proyecto, tarea};
    use crate::store::{ClientPrincipal, ClientSurface};

    const PERSON: &str = "tasks-http-person-secret-lxo98-test-only-32b";
    const AGENT: &str = "tasks-http-agent-secret-lxo98-test-only-32by";

    fn call(port: u16, token: &str, cmd: &str, args: Value) -> (u16, Value) {
        post(port, token, &json!({ "cmd": cmd, "args": args, "cwd": std::env::current_dir().unwrap().to_string_lossy() }))
    }

    fn error_code(r: &Value) -> String {
        r["error"].as_str().unwrap_or("").split(':').next().unwrap_or("").trim().to_string()
    }

    #[test]
    fn consultas_de_tasks_por_post_rpc() {
        let (_cleanup, data, core_dir) = boot_tests::dirs();
        let (core, _host, started) = boot_tests::arranca(&data, &core_dir);
        started.unwrap();
        core.settings.lock().unwrap().enabled = true;
        register(&core, ClientSurface::Cli, ClientPrincipal::Person("person-tasks-http".into()), "install-tasks-http-person", PERSON);
        register(&core, ClientSurface::Cli, ClientPrincipal::Agent("task-tasks-http".into()), "install-tasks-http-agent", AGENT);
        let a = proyecto(&core, "alfa-http");
        let b = proyecto(&core, "beta-http");
        let mut ids: Vec<String> = (0..3).map(|i| tarea(&core, &format!("A{i}"), Some(&a))).collect();
        let tb = tarea(&core, "B0", Some(&b));
        let server = start(core.clone()).unwrap();
        let port = server.port;

        // Límites de `limit`: 0 y 101 se rechazan, 1 y 100 se aceptan.
        for bad in [0, 101] {
            let (st, r) = call(port, PERSON, "tasks_by_project", json!({ "project_id": a, "status": "all", "limit": bad }));
            assert_eq!((st, r["ok"].clone()), (200, json!(false)), "limit {bad}: {r}");
            assert_eq!(error_code(&r), "tasks_invalid_request", "limit {bad}: {r}");
        }
        for good in [1, 100] {
            let (st, r) = call(port, PERSON, "tasks_by_project", json!({ "project_id": a, "status": "all", "limit": good }));
            assert_eq!((st, r["ok"].clone()), (200, json!(true)), "limit {good}: {r}");
            assert_eq!(r["data"]["limit"], good);
            assert_eq!(r["data"]["tasks"].as_array().unwrap().len(), (good as usize).min(3));
        }

        // Paginación con una Task creada entre páginas: sin repetidas ni saltadas de las existentes.
        let (_, p1) = call(port, PERSON, "tasks_by_project", json!({ "project_id": a, "status": "all", "limit": 2 }));
        assert_eq!(p1["data"]["has_more"], true, "{p1}");
        let cursor = p1["data"]["next_cursor"].as_str().unwrap().to_string();
        let nueva = tarea(&core, "A-nueva", Some(&a));
        let (_, p2) = call(port, PERSON, "tasks_by_project", json!({ "project_id": a, "status": "all", "limit": 2, "cursor": cursor }));
        assert_eq!(p2["ok"], true, "{p2}");
        let mut vistos: Vec<String> = p1["data"]["tasks"].as_array().unwrap().iter()
            .chain(p2["data"]["tasks"].as_array().unwrap())
            .map(|t| t["id"].as_str().unwrap().to_string()).collect();
        let total = vistos.len();
        vistos.sort();
        vistos.dedup();
        assert_eq!(vistos.len(), total, "Task repetida entre páginas: {p1} {p2}");
        ids.sort();
        assert_eq!(vistos, ids, "las Tasks previas aparecen una vez cada una");
        assert!(!vistos.contains(&nueva), "la Task nueva no se cuela en la página siguiente");
        let (_, fresh) = call(port, PERSON, "tasks_by_project", json!({ "project_id": a, "status": "all", "limit": 1 }));
        assert_eq!(fresh["data"]["tasks"][0]["id"], json!(nueva), "una lectura nueva la muestra primero");

        // Cursor inválido y filtro `status`.
        let (_, r) = call(port, PERSON, "tasks_by_project", json!({ "project_id": a, "cursor": "nope" }));
        assert_eq!(error_code(&r), "tasks_invalid_request", "{r}");
        let (_, r) = call(port, PERSON, "tasks_by_project", json!({ "project_id": a, "status": "final" }));
        assert_eq!(r["data"]["tasks"].as_array().unwrap().len(), 0, "{r}");
        let (_, r) = call(port, PERSON, "tasks_by_project", json!({ "project_id": "no-existe" }));
        assert_eq!(error_code(&r), "tasks_project_not_found", "{r}");

        // task_detail: propia, inexistente y de otro Project.
        let (_, r) = call(port, PERSON, "task_detail", json!({ "project_id": a, "task_id": ids[0] }));
        assert_eq!(r["data"]["task"]["id"], json!(ids[0]), "{r}");
        let (_, r) = call(port, PERSON, "task_detail", json!({ "project_id": a, "task_id": "no-existe" }));
        assert_eq!(error_code(&r), "tasks_not_found", "{r}");
        let (_, r) = call(port, PERSON, "task_detail", json!({ "project_id": a, "task_id": tb }));
        assert_eq!(error_code(&r), "tasks_not_found", "Task de otro Project no se filtra: {r}");

        // Un agente no lee.
        for (cmd, args) in [("tasks_by_project", json!({ "project_id": a })), ("task_detail", json!({ "project_id": a, "task_id": ids[0] }))] {
            let (st, r) = call(port, AGENT, cmd, args);
            assert_eq!(r["ok"], false, "{cmd} con agente: {st} {r}");
            assert!(st == 403 || error_code(&r) == "tasks_auth_required", "{cmd} con agente: {st} {r}");
        }
        server.stop();
    }
}
