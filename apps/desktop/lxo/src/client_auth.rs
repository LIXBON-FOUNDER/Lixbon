//! Credenciales y negociación del protocolo Core para la CLI.
//!
//! `orch.json` es solo un directorio de conexión: nunca es fuente de secretos.
//! Las personas usan la entrada del Keychain compartida con el escritorio; una
//! tarea agente recibe su credencial por `LXO_CLIENT_TOKEN`.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;
use std::{fmt, io};

use serde_json::{json, Value};
use zeroize::Zeroizing;

const SECRET_SERVICE: &str = "lixbon";
const SUPPORTED_PROTOCOL: u64 = 1;
const MIN_SCHEMA_VERSION: u64 = 6;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const IO_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq)]
struct OrchInfo {
    port: u16,
    client_id: Option<String>,
    installation_id: Option<String>,
    version: String,
}

impl OrchInfo {
    fn parse(value: &Value) -> Result<Self, String> {
        let port = value["port"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .filter(|p| *p > 0)
            .ok_or_else(|| "orch.json sin puerto válido".to_string())?;
        let version = value["version"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "orch.json sin versión del Core".to_string())?
            .to_string();
        Ok(Self {
            port,
            client_id: nonempty_string(&value["client_id"]),
            installation_id: nonempty_string(&value["installation_id"]),
            version,
        })
    }
}

fn nonempty_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

trait CredentialReader {
    /// El error no contiene mensajes del proveedor, que podrían reflejar datos sensibles.
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, ()>;
}

struct OsCredentialReader;

impl CredentialReader for OsCredentialReader {
    fn get(&self, service: &str, account: &str) -> Result<Option<String>, ()> {
        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        {
            let _ = (service, account);
            return Err(());
        }
        #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
        {
            #[cfg(windows)]
            let entry =
                keyring::Entry::new_with_target(&format!("{service}:{account}"), service, account);
            #[cfg(not(windows))]
            let entry = keyring::Entry::new(service, account);
            let entry = entry.map_err(|_| ())?;
            // El escritorio guarda bytes UTF-8 (`set_secret`); `get_password` los leería como
            // UTF-16 en Windows y daría otro secreto.
            match entry.get_secret() {
                Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| ()),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(_) => Err(()),
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CredentialKind {
    Person,
    Agent,
}

struct ResolvedCredential {
    secret: Zeroizing<String>,
    kind: CredentialKind,
}

impl fmt::Debug for ResolvedCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ResolvedCredential")
            .field("secret", &"[REDACTED]")
            .field("kind", &self.kind)
            .finish()
    }
}

fn resolve_credential(
    info: &OrchInfo,
    task_id: Option<&str>,
    agent_token: Option<&str>,
    reader: &dyn CredentialReader,
) -> Result<ResolvedCredential, String> {
    match (
        task_id.filter(|s| !s.trim().is_empty()),
        agent_token.filter(|s| !s.trim().is_empty()),
    ) {
        (Some(_), Some(token)) => Ok(ResolvedCredential {
            secret: Zeroizing::new(token.to_string()),
            kind: CredentialKind::Agent,
        }),
        (Some(_), None) => {
            Err("Falta LXO_CLIENT_TOKEN para esta tarea; no se usarán credenciales Person.".into())
        }
        (None, Some(_)) => {
            Err("LXO_CLIENT_TOKEN requiere LXO_TASK_ID; no se usará como credencial Person.".into())
        }
        (None, None) => {
            if info.client_id.is_none() {
                return Err(
                    "orch.json no incluye la identidad del cliente CLI; vuelve a abrir Lixbon."
                        .into(),
                );
            }
            let installation_id = info.installation_id.as_deref().ok_or_else(|| {
                "orch.json no incluye installation_id; vuelve a abrir Lixbon.".to_string()
            })?;
            if !valid_installation_id(installation_id) {
                return Err("orch.json contiene un installation_id inválido.".into());
            }
            let account = format!("client/cli/{installation_id}");
            let secret = reader.get(SECRET_SERVICE, &account)
                .map_err(|_| "No se pudo acceder a la credencial CLI en el almacén seguro del sistema.".to_string())?
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| "No hay credencial Person de CLI en el almacén seguro; vuelve a autenticar Lixbon.".to_string())?;
            Ok(ResolvedCredential {
                secret: Zeroizing::new(secret),
                kind: CredentialKind::Person,
            })
        }
    }
}

fn valid_installation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

struct HttpResponse {
    status: u16,
    body: Value,
}

#[derive(Debug)]
pub(crate) enum EventRequestFailure {
    Network(String),
    CoreUnavailable(String),
    Authentication(String),
    Version(String),
    Internal(String),
}

impl EventRequestFailure {
    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Network(message)
            | Self::CoreUnavailable(message)
            | Self::Authentication(message)
            | Self::Version(message)
            | Self::Internal(message) => message,
        }
    }
}

fn request(
    port: u16,
    method: &str,
    path: &str,
    token: &str,
    body: Option<&str>,
) -> Result<HttpResponse, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(|_| {
        "No se pudo conectar con el Core de Lixbon; verifica que la aplicación esté abierta."
            .to_string()
    })?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|_| "No se pudo configurar el tiempo de espera de red.".to_string())?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|_| "No se pudo configurar el tiempo de espera de red.".to_string())?;

    let body = body.unwrap_or("");
    if method == "GET" {
        write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n")
    } else {
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())
    }.map_err(|_| "Falló el envío al Core de Lixbon.".to_string())?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).map_err(|e| {
        if matches!(
            e.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ) {
            "El Core de Lixbon no respondió a tiempo.".to_string()
        } else {
            "Se perdió la conexión con el Core de Lixbon.".to_string()
        }
    })?;
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Respuesta HTTP inválida del Core de Lixbon.".to_string())?;
    let headers = std::str::from_utf8(&raw[..split])
        .map_err(|_| "Respuesta HTTP inválida del Core de Lixbon.".to_string())?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|status| status.parse::<u16>().ok())
        .ok_or_else(|| "Respuesta HTTP inválida del Core de Lixbon.".to_string())?;
    let payload = &raw[split + 4..];
    let body = serde_json::from_slice(payload)
        .map_err(|_| format!("Respuesta inválida del Core de Lixbon (HTTP {status})."))?;
    Ok(HttpResponse { status, body })
}

fn validate_handshake(info: &OrchInfo, body: &Value, kind: CredentialKind) -> Result<(), String> {
    if body["ok"].as_bool() != Some(true) {
        return Err(remote_error(200, body));
    }
    let data = &body["data"];
    let core_version = data["core_version"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "El Core devolvió un handshake incompleto.".to_string())?;
    if core_version != info.version {
        return Err(format!("Versión del Core incompatible: orch.json indica {} y el servidor informa {core_version}.", info.version));
    }
    if data["protocol_version"].as_u64() != Some(SUPPORTED_PROTOCOL)
        || data["schema_version"]
            .as_u64()
            .is_none_or(|version| version < MIN_SCHEMA_VERSION)
    {
        return Err(
            "Versión del protocolo o esquema incompatible; actualiza Lixbon para continuar.".into(),
        );
    }
    let capabilities = data["capabilities"]
        .as_array()
        .ok_or_else(|| "El Core no anunció capabilities compatibles.".to_string())?;
    for required in ["rpc", "events.read"] {
        if !capabilities
            .iter()
            .any(|capability| capability.as_str() == Some(required))
        {
            return Err(format!(
                "El Core no ofrece la capability requerida: {required}. Actualiza Lixbon."
            ));
        }
    }
    let authenticated_client = data["client_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "El Core no devolvió la identidad autenticada del cliente.".to_string())?;
    if kind == CredentialKind::Person && info.client_id.as_deref() != Some(authenticated_client) {
        return Err(
            "La identidad de la credencial no coincide con orch.json; vuelve a autenticar el CLI."
                .into(),
        );
    }
    Ok(())
}

fn remote_error(status: u16, body: &Value) -> String {
    let code = body["code"].as_str().unwrap_or("");
    match (status, code) {
        (401, "credential_expired") => {
            "La credencial CLI venció; vuelve a autenticar Lixbon.".into()
        }
        (401, "credential_revoked") => {
            "La credencial CLI fue revocada; vuelve a autenticar Lixbon.".into()
        }
        (401, "invalid_credential") | (401, _) => {
            "Lixbon rechazó la credencial CLI; vuelve a autenticar el cliente.".into()
        }
        (403, _) | (_, "forbidden") => {
            "La identidad CLI está autenticada, pero no tiene permiso para esta operación.".into()
        }
        (503, _) | (_, "core_unavailable") => {
            "El Core de Lixbon no está disponible para autenticar el cliente.".into()
        }
        (_, "version_mismatch") => {
            "El protocolo del Core no es compatible; actualiza Lixbon.".into()
        }
        (status, _) => format!("El Core rechazó la solicitud de autenticación (HTTP {status})."),
    }
}

/// Fallo de una llamada RPC: del transporte o la autenticación (con su clase, para
/// el código de salida) o un rechazo del propio comando (`ok: false`).
#[derive(Debug)]
pub(crate) enum RpcFailure {
    Transport(EventRequestFailure),
    Rejected(String),
}

impl RpcFailure {
    pub(crate) fn message(&self) -> &str {
        match self {
            Self::Transport(failure) => failure.message(),
            Self::Rejected(message) => message,
        }
    }
}

fn send_authenticated(
    info: &OrchInfo,
    credential: &ResolvedCredential,
    cmd: &str,
    args: &Value,
    cwd: &str,
) -> Result<Value, String> {
    rpc_authenticated(info, credential, cmd, args, cwd).map_err(|e| e.message().to_string())
}

fn rpc_authenticated(
    info: &OrchInfo,
    credential: &ResolvedCredential,
    cmd: &str,
    args: &Value,
    cwd: &str,
) -> Result<Value, RpcFailure> {
    authenticate(info, credential).map_err(RpcFailure::Transport)?;

    // `caller` se omite intencionalmente: la autoridad proviene de la credencial
    // autenticada; el Core liga las credenciales Agent a su tarea al emitirlas.
    let body = json!({ "cmd": cmd, "args": args, "cwd": cwd }).to_string();
    let response = request(info.port, "POST", "/rpc", &credential.secret, Some(&body))
        .map_err(|e| RpcFailure::Transport(classify_request_error(e)))?;
    if response.status < 200 || response.status >= 300 {
        return Err(RpcFailure::Transport(handshake_failure(
            response.status,
            &response.body,
        )));
    }
    if response.body["ok"].as_bool() == Some(true) {
        Ok(response.body["data"].clone())
    } else {
        let error = response.body["error"]
            .as_str()
            .unwrap_or("Error desconocido");
        Err(RpcFailure::Rejected(redact_secret(
            error,
            &credential.secret,
        )))
    }
}

fn classify_request_error(error: String) -> EventRequestFailure {
    if error.starts_with("No se pudo conectar")
        || error.starts_with("El Core de Lixbon no respondió")
        || error.starts_with("Se perdió la conexión")
        || error.starts_with("Falló el envío")
        || error.starts_with("No se pudo configurar el tiempo de espera de red")
    {
        EventRequestFailure::Network(error)
    } else {
        EventRequestFailure::Version(error)
    }
}

fn authenticate(
    info: &OrchInfo,
    credential: &ResolvedCredential,
) -> Result<(), EventRequestFailure> {
    let handshake = request(info.port, "GET", "/handshake", &credential.secret, None)
        .map_err(classify_request_error)?;
    if handshake.status != 200 {
        return Err(handshake_failure(handshake.status, &handshake.body));
    }
    validate_handshake(info, &handshake.body, credential.kind).map_err(|message| {
        if message.contains("credencial") || message.contains("identidad") {
            EventRequestFailure::Authentication(message)
        } else {
            EventRequestFailure::Version(message)
        }
    })
}

fn handshake_failure(status: u16, body: &Value) -> EventRequestFailure {
    let message = remote_error(status, body);
    match status {
        401 | 403 => EventRequestFailure::Authentication(message),
        503 => EventRequestFailure::CoreUnavailable(message),
        _ => EventRequestFailure::Version(message),
    }
}

fn events_path(params: &[(String, String)]) -> Result<String, String> {
    const ALLOWED: &[&str] = &[
        "cursor",
        "limit",
        "project",
        "run",
        "entity_kind",
        "entity_id",
        "kind",
        "kind_prefix",
        "class",
    ];
    let mut seen = std::collections::HashSet::new();
    let mut query = Vec::with_capacity(params.len());
    for (name, value) in params {
        if !ALLOWED.contains(&name.as_str()) || !seen.insert(name) {
            return Err("Parámetros inválidos para GET /events.".into());
        }
        query.push(format!(
            "{}={}",
            encode_query_component(name),
            encode_query_component(value)
        ));
    }
    query.sort();
    Ok(if query.is_empty() {
        "/events".into()
    } else {
        format!("/events?{}", query.join("&"))
    })
}

fn encode_query_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn client_configuration() -> Result<(OrchInfo, ResolvedCredential), EventRequestFailure> {
    let path = super::home().join(".lixbon").join("orch.json");
    let bytes = std::fs::read(path).map_err(|_| {
        EventRequestFailure::Network(
            "Lixbon no está abierto o el orquestador está desactivado (Lixbon → Ajustes → Orquestador)".into(),
        )
    })?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| EventRequestFailure::Version("orch.json no es válido".into()))?;
    let info = OrchInfo::parse(&value).map_err(EventRequestFailure::Version)?;
    let task_id = std::env::var("LXO_TASK_ID").ok();
    let token = std::env::var("LXO_CLIENT_TOKEN").ok();
    let credential = resolve_credential(
        &info,
        task_id.as_deref(),
        token.as_deref(),
        &OsCredentialReader,
    )
    .map_err(EventRequestFailure::Authentication)?;
    Ok((info, credential))
}

/// GET /events usa el mismo materializador de credenciales y handshake que RPC.
/// Solo admite parámetros del contrato; el secreto nunca sale de este módulo.
pub(crate) fn get_events(params: &[(String, String)]) -> Result<(u16, Value), EventRequestFailure> {
    let path = events_path(params).map_err(EventRequestFailure::Internal)?;
    let (info, credential) = client_configuration()?;
    let response = get_events_authenticated(&info, &credential, &path)?;
    Ok((response.status, response.body))
}

fn get_events_authenticated(
    info: &OrchInfo,
    credential: &ResolvedCredential,
    path: &str,
) -> Result<HttpResponse, EventRequestFailure> {
    if !path.starts_with("/events?") && path != "/events" {
        return Err(EventRequestFailure::Internal(
            "La solicitud de eventos debe usar GET /events.".into(),
        ));
    }
    authenticate(info, credential)?;
    let mut response = request(info.port, "GET", path, &credential.secret, None)
        .map_err(classify_request_error)?;
    redact_value(&mut response.body, &credential.secret);
    Ok(response)
}

fn redact_secret(message: &str, secret: &str) -> String {
    if secret.is_empty() {
        message.to_string()
    } else {
        message.replace(secret, "[credencial oculta]")
    }
}

fn redact_value(value: &mut Value, secret: &str) {
    match value {
        Value::String(text) => *text = redact_secret(text, secret),
        Value::Array(items) => items.iter_mut().for_each(|item| redact_value(item, secret)),
        Value::Object(fields) => fields
            .values_mut()
            .for_each(|item| redact_value(item, secret)),
        _ => {}
    }
}

pub(super) fn send(cmd: &str, args: &Value, cwd: &str) -> Result<Value, String> {
    let (info, credential) = client_configuration().map_err(|e| e.message().to_string())?;
    send_authenticated(&info, &credential, cmd, args, cwd)
}

/// Como [`send`], pero conserva la clase del fallo para elegir el código de salida.
pub(super) fn rpc(cmd: &str, args: &Value, cwd: &str) -> Result<Value, RpcFailure> {
    let (info, credential) = client_configuration().map_err(RpcFailure::Transport)?;
    rpc_authenticated(&info, &credential, cmd, args, cwd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::sync::{Arc, Mutex};

    const TOKEN: &str = "client-test-secret-never-print-this";

    #[derive(Default)]
    struct FakeReader {
        calls: Mutex<Vec<(String, String)>>,
        value: Mutex<Option<String>>,
        fail: bool,
    }

    impl CredentialReader for FakeReader {
        fn get(&self, service: &str, account: &str) -> Result<Option<String>, ()> {
            self.calls
                .lock()
                .unwrap()
                .push((service.to_string(), account.to_string()));
            if self.fail {
                Err(())
            } else {
                Ok(self.value.lock().unwrap().clone())
            }
        }
    }

    fn info() -> OrchInfo {
        OrchInfo {
            port: 43210,
            client_id: Some("client-person-1".into()),
            installation_id: Some("install-1".into()),
            version: "2.2.0".into(),
        }
    }

    fn handshake() -> Value {
        json!({ "ok": true, "data": {
            "core_version": "2.2.0", "protocol_version": 1, "schema_version": 6,
            "capabilities": ["rpc", "events.read"], "client_id": "client-person-1"
        }})
    }

    #[test]
    fn orch_json_solo_aporta_metadatos_y_no_se_lee_token() {
        let parsed = OrchInfo::parse(&json!({
            "port": 43210, "client_id": "client-person-1", "installation_id": "install-1",
            "version": "2.2.0", "token": "legacy-token-must-be-ignored", "lxo": "C:/lxo"
        }))
        .unwrap();
        assert_eq!(parsed, info());
        assert!(!format!("{parsed:?}").contains("legacy-token"));
    }

    #[test]
    fn persona_usa_la_cuenta_interoperable_del_keyring() {
        let reader = FakeReader {
            value: Mutex::new(Some(TOKEN.into())),
            ..FakeReader::default()
        };
        let credential = resolve_credential(&info(), None, None, &reader).unwrap();
        assert_eq!(credential.kind, CredentialKind::Person);
        assert_eq!(credential.secret.as_str(), TOKEN);
        assert_eq!(
            *reader.calls.lock().unwrap(),
            vec![("lixbon".into(), "client/cli/install-1".into())]
        );
    }

    #[test]
    fn agente_usa_solo_su_token_de_tarea_y_no_consulta_keyring() {
        let reader = FakeReader::default();
        let credential =
            resolve_credential(&info(), Some("task-17"), Some(TOKEN), &reader).unwrap();
        assert_eq!(credential.kind, CredentialKind::Agent);
        assert_eq!(credential.secret.as_str(), TOKEN);
        assert!(reader.calls.lock().unwrap().is_empty());
        assert!(resolve_credential(&info(), Some("task-17"), None, &reader)
            .unwrap_err()
            .contains("LXO_CLIENT_TOKEN"));
        assert!(resolve_credential(&info(), None, Some(TOKEN), &reader)
            .unwrap_err()
            .contains("LXO_TASK_ID"));
    }

    #[test]
    fn fallos_del_keyring_son_genericos_y_no_filtran_el_token() {
        let reader = FakeReader {
            fail: true,
            ..FakeReader::default()
        };
        let error = resolve_credential(&info(), None, None, &reader).unwrap_err();
        assert!(!error.contains(TOKEN));
        assert!(error.contains("almacén seguro"));
    }

    #[test]
    fn handshake_exige_version_esquema_y_capabilities() {
        validate_handshake(&info(), &handshake(), CredentialKind::Person).unwrap();
        for (field, value) in [
            ("protocol_version", json!(2)),
            ("schema_version", json!(5)),
            ("core_version", json!("3.0.0")),
            ("capabilities", json!(["rpc"])),
        ] {
            let mut response = handshake();
            response["data"][field] = value;
            assert!(
                validate_handshake(&info(), &response, CredentialKind::Person).is_err(),
                "{field}"
            );
        }
        let mut mismatched = handshake();
        mismatched["data"]["client_id"] = json!("other-client");
        assert!(
            validate_handshake(&info(), &mismatched, CredentialKind::Person)
                .unwrap_err()
                .contains("identidad")
        );
    }

    #[test]
    fn errores_http_se_distinguen_sin_mostrar_mensajes_del_servidor() {
        for (status, code, expected) in [
            (401, "credential_expired", "venció"),
            (401, "credential_revoked", "revocada"),
            (403, "forbidden", "no tiene permiso"),
            (503, "core_unavailable", "no está disponible"),
        ] {
            let response = json!({ "code": code, "error": TOKEN });
            let error = remote_error(status, &response);
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains(TOKEN));
        }
        assert_eq!(
            redact_secret(&format!("fallo con {TOKEN}"), TOKEN),
            "fallo con [credencial oculta]"
        );
    }

    #[test]
    fn handshake_precede_rpc_y_rpc_no_lleva_claim_caller_ni_token_en_el_body() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let info = OrchInfo { port, ..info() };
        let observed = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed_server = observed.clone();
        let server = std::thread::spawn(move || {
            for response in [
                json!({ "ok": true, "data": handshake()["data"] }),
                json!({ "ok": true, "data": { "accepted": true } }),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    request.push_str(&line);
                    if line == "\r\n" {
                        break;
                    }
                }
                if let Some(length) = request.lines().find_map(|line| {
                    line.strip_prefix("Content-Length: ")
                        .and_then(|s| s.trim().parse::<usize>().ok())
                }) {
                    let mut body = vec![0; length];
                    reader.read_exact(&mut body).unwrap();
                    request.push_str(&String::from_utf8(body).unwrap());
                }
                observed_server.lock().unwrap().push(request);
                let payload = response.to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()).unwrap();
            }
        });
        let credential = ResolvedCredential {
            secret: Zeroizing::new(TOKEN.to_string()),
            kind: CredentialKind::Person,
        };
        let response =
            send_authenticated(&info, &credential, "status", &json!({}), "C:/repo").unwrap();
        assert_eq!(response["accepted"], true);
        server.join().unwrap();
        let requests = observed.lock().unwrap();
        assert!(requests[0].starts_with("GET /handshake HTTP/1.1"));
        assert!(requests[1].starts_with("POST /rpc HTTP/1.1"));
        assert!(requests[0].contains(&format!("Authorization: Bearer {TOKEN}")));
        assert!(requests[1].contains(&format!("Authorization: Bearer {TOKEN}")));
        let body = requests[1].split_once("\r\n\r\n").unwrap().1;
        assert!(body.contains("\"cmd\":\"status\""));
        assert!(!body.contains("caller"));
        assert!(!body.contains(TOKEN));
    }

    #[test]
    fn events_get_reutiliza_handshake_credencial_y_redacta_errores() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let info = OrchInfo { port, ..info() };
        let observed = Arc::new(Mutex::new(Vec::<String>::new()));
        let observed_server = observed.clone();
        let server = std::thread::spawn(move || {
            for response in [
                json!({ "ok": true, "data": handshake()["data"] }),
                json!({ "ok": false, "code": "forbidden", "error": TOKEN, "detail": TOKEN }),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    request.push_str(&line);
                    if line == "\r\n" {
                        break;
                    }
                }
                observed_server.lock().unwrap().push(request);
                let payload = response.to_string();
                let status = if response["ok"].as_bool() == Some(true) {
                    200
                } else {
                    403
                };
                write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()).unwrap();
            }
        });
        let credential = ResolvedCredential {
            secret: Zeroizing::new(TOKEN.to_string()),
            kind: CredentialKind::Person,
        };
        let response =
            get_events_authenticated(&info, &credential, "/events?class=state&cursor=0").unwrap();
        assert_eq!(response.status, 403);
        assert_eq!(response.body["error"], "[credencial oculta]");
        assert_eq!(response.body["detail"], "[credencial oculta]");
        server.join().unwrap();
        let requests = observed.lock().unwrap();
        assert!(requests[0].starts_with("GET /handshake HTTP/1.1"));
        assert!(requests[1].starts_with("GET /events?class=state&cursor=0 HTTP/1.1"));
        assert!(requests[1].contains(&format!("Authorization: Bearer {TOKEN}")));
        assert!(!requests[1].contains("X-Lixbon-Caller"));
    }

    #[test]
    fn events_path_cierra_nombres_y_codifica_valores() {
        assert_eq!(
            events_path(&[
                ("entity_id".into(), "t/17 a".into()),
                ("cursor".into(), "42".into())
            ])
            .unwrap(),
            "/events?cursor=42&entity_id=t%2F17%20a"
        );
        assert!(events_path(&[("token".into(), TOKEN.into())]).is_err());
        assert!(
            events_path(&[("cursor".into(), "1".into()), ("cursor".into(), "2".into())]).is_err()
        );
    }

    #[test]
    fn handshake_core_unavailable_no_se_confunde_con_version_incompatible() {
        match handshake_failure(503, &json!({ "code": "core_unavailable" })) {
            EventRequestFailure::CoreUnavailable(message) => {
                assert!(message.contains("no está disponible"))
            }
            _ => panic!("HTTP 503 debe conservar la categoría core_unavailable"),
        }
        assert!(matches!(
            handshake_failure(426, &json!({ "code": "version_mismatch" })),
            EventRequestFailure::Version(_)
        ));
    }
}
