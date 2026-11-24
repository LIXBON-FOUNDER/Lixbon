//! LXO-184 · sesión remota: el contrato de Core para que un cliente (CLI, Mobile, otro Desktop) controle trabajo autorizado a través de un relay.
//!
//! ```text
//!   cliente ──► relay (gateway) ──► Core del host
//!                  │                    │
//!                  │ solo reenvía       ├─ remote_hello  : apretón de manos (versión + capacidades), credencial del DISPOSITIVO → sesión
//!                  │ no decide nada     ├─ remote_call   : comando o consulta con sobre {sesión, seq, request_id}
//!                  ▼                    └─ remote_close  : cierra la sesión
//!             cola acotada · host offline = stale, no failed · reconexión = hello nuevo + cursor de eventos
//! ```
//!
//! # Qué garantiza este módulo (lo que NO puede garantizar un relay)
//! * **El relay nunca decide.** Toda mutación termina aquí y pasa por el mismo `rpc_authenticated_via` que cualquier cliente local, con la
//!   política de su superficie y principal. Ningún estado, Attention ni resultado de un Attempt sale de un relay.
//! * **La credencial se verifica en el Core, no se confía en lo que diga el relay.** `remote_hello` autentica el token del dispositivo contra
//!   el almacén de clientes y devuelve un secreto de SESIÓN de vida corta. Cada llamada vuelve a comprobar que la credencial sigue activa: un
//!   dispositivo revocado deja de funcionar en la siguiente llamada, con la sesión abierta.
//! * **Repetición:** `seq` es estrictamente creciente por sesión; un sobre repetido o más viejo es `remote_replay`.
//! * **Reintento seguro:** un `request_id` ya atendido por ese cliente devuelve la MISMA respuesta (`replayed: true`) sin ejecutar otra vez;
//!   el mismo `request_id` con otro comando o argumentos es `remote_request_conflict`. Cuando el cliente no vio la respuesta, reenvía con otro
//!   `seq` y el mismo `request_id`.
//! * **Versiones:** un cliente que no habla ninguna versión del Core recibe `remote_version_unsupported`; no hay degradación silenciosa.
//! * **Acotado:** sesiones por cliente y en total, llamadas en vuelo por sesión, tamaño del sobre y caducidad por inactividad.
//!
//! # Lo que NO es esto (y dónde sigue)
//! * No abre ningún transporte: el relay Python (`core/gateway`) y el conector de Desktop (`remoteCore.js`) lo usarán en PRs siguientes, y el
//!   daemon (rebanada 5 de la ADR) será quien se conecte. Aquí se prueba contra un relay simulado.
//! * El relay **ve en claro** el secreto de sesión y el contenido (TLS protege el tránsito, no al relay). Por eso el secreto de sesión es de vida
//!   corta, de un solo dispositivo y revocable con él, y nada del relay puede elevar permisos. Cifrado extremo a extremo del contenido no está
//!   hecho: queda marcado para la revisión de seguridad.
//! * La memoria de reintentos (`request_id`) y las sesiones viven en memoria: un reinicio del Core las pierde. Los comandos con
//!   idempotencia durable (p. ej. `task_create`) siguen siéndolo; el resto no se repite por error porque el cliente reconecta con `hello`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta que el relay y el conector (PRs siguientes) lo llamen

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use ring::rand::{SecureRandom, SystemRandom};
use serde_json::{json, Map, Value};

use super::events::Channel;
use super::host_identity::to_hex;
use super::state::now_ms;
use super::Core;
use crate::store::{sha256_hex, AuthenticatedClient, ClientAuthentication, ClientClaims, ClientPrincipal, ClientSurface, CredentialState};

pub(super) const PROTOCOL_MIN: u64 = 1;
pub(super) const PROTOCOL_MAX: u64 = 1;
/// Una sesión sin uso durante este tiempo caduca.
pub(super) const SESSION_IDLE_MS: i64 = 15 * 60 * 1000;
/// Cuánto se recuerda un `request_id` ya atendido.
pub(super) const DEDUP_TTL_MS: i64 = 10 * 60 * 1000;
pub(super) const MAX_SESSIONS_PER_CLIENT: usize = 4;
pub(super) const MAX_SESSIONS: usize = 64;
/// Llamadas simultáneas por sesión; la siguiente recibe `remote_backpressure`.
pub(super) const MAX_IN_FLIGHT: usize = 8;
pub(super) const DEDUP_CAPACITY: usize = 512;
/// Tamaño máximo de un sobre entero, serializado.
pub(super) const MAX_ENVELOPE_BYTES: usize = 256 * 1024;
const MAX_REQUEST_ID: usize = 80;
const MAX_CAPABILITIES: usize = 32;

/// Lo que ofrece este Core a un cliente remoto.
pub(super) const SERVER_CAPABILITIES: &[&str] = &["query", "command", "events"];

/// Los comandos que se atienden por una sesión remota: lecturas y los pocos mandos que el control remoto necesita. **Ampliar esta lista es una
/// decisión de producto y de seguridad**, no de transporte: el resto responde `remote_command_forbidden` aunque el cliente tenga permiso local.
pub(super) const REMOTE_COMMANDS: &[&str] = &[
    // Lecturas.
    "status", "projects_overview", "hosts_list", "events", "attention_list", "attention_detail", "activity_list", "tasks_by_project", "task_detail",
    "core_model", "task_list_v2", "task_detail_v2", "attempts_by_task", "attempt_detail", "attempt_detail_v2", "provider_capabilities", "usage_report",
    // Mandos.
    "task_create", "attempt_approve", "attempt_stop",
];

struct Session {
    client: AuthenticatedClient,
    secret_hash: String,
    last_seq: u64,
    last_used: i64,
    in_flight: usize,
}

enum Entry {
    /// Se está ejecutando ahora mismo: un reintento concurrente espera, no ejecuta otra vez.
    Running { fingerprint: String },
    Done { fingerprint: String, at: i64, result: Value },
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    dedup: HashMap<(String, String), Entry>,
    order: VecDeque<(String, String)>,
}

/// El estado de las sesiones remotas de un Core (solo memoria).
#[derive(Default)]
pub(super) struct RemoteState {
    inner: Mutex<Inner>,
}

impl RemoteState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn err(code: &str, text: impl std::fmt::Display) -> String {
    format!("{code}: {text}")
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    SystemRandom::new().fill(&mut buf).map_err(|_| err("remote_internal", "no hay aleatoriedad del sistema"))?;
    Ok(to_hex(&buf))
}

/// Comparación sin salida temprana: no filtra por tiempo cuántos caracteres del secreto coinciden.
fn same_secret(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn fingerprint(cmd: &str, args: &Value) -> String {
    sha256_hex(format!("{cmd}\n{args}").as_bytes())
}

fn only_keys(object: &Map<String, Value>, allowed: &[&str], what: &str) -> Result<(), String> {
    match object.keys().find(|k| !allowed.contains(&k.as_str())) {
        Some(key) => Err(err("remote_invalid_request", format!("`{key}` no es un campo de {what}"))),
        None => Ok(()),
    }
}

/// El canal por el que habla cada superficie: el Core lo exige (`SurfaceChannelMismatch`), no lo elige el relay. Desktop habla por la
/// interfaz, la CLI por `lxo` y Mobile por el relé. Automation y Core no abren sesiones remotas.
fn channel_of(surface: ClientSurface) -> Option<Channel> {
    match surface {
        ClientSurface::Desktop => Some(Channel::Ui),
        ClientSurface::Cli => Some(Channel::Lxo),
        ClientSurface::Mobile => Some(Channel::Mobile),
        ClientSurface::Automation | ClientSurface::Core => None,
    }
}

/// Devuelve la versión que se habla, o el error explícito. Cada extremo declara el rango que soporta.
pub(super) fn negotiate(client_min: u64, client_max: u64) -> Result<u64, String> {
    if client_min > client_max {
        return Err(err("remote_invalid_request", "`protocol_min` no puede superar a `protocol_max`"));
    }
    let top = client_max.min(PROTOCOL_MAX);
    if top < PROTOCOL_MIN.max(client_min) {
        return Err(err("remote_version_unsupported", format!("este Core habla del protocolo {PROTOCOL_MIN} al {PROTOCOL_MAX}; el cliente, del {client_min} al {client_max}")));
    }
    Ok(top)
}

impl Core {
    /// Autentica el token de un DISPOSITIVO y abre una sesión remota. Devuelve la sesión y su secreto (la única vez que viaja).
    pub(super) fn remote_hello(&self, device_secret: &str, args: &Value) -> Result<Value, String> {
        let client = match self.authenticate_client_status(device_secret).map_err(|e| err("remote_internal", e))? {
            ClientAuthentication::Active(client) => client,
            ClientAuthentication::Invalid => return Err(err("remote_unauthorized", "credencial desconocida")),
            ClientAuthentication::Expired(_) => return Err(err("remote_credential_expired", "la credencial del dispositivo caducó")),
            ClientAuthentication::Revoked(_) => return Err(err("remote_credential_revoked", "la credencial del dispositivo está revocada")),
        };
        // Solo una Person controla trabajo a distancia: un Agent es de UNA Task y de este equipo, nunca de un relay.
        if !matches!(client.identity().principal(), ClientPrincipal::Person(_)) {
            return Err(err("remote_unauthorized", "solo una Person puede abrir una sesión remota"));
        }
        if channel_of(client.identity().surface()).is_none() {
            return Err(err("remote_unauthorized", "esta superficie no abre sesiones remotas"));
        }
        let object = args.as_object().ok_or_else(|| err("remote_invalid_request", "los argumentos deben ser un objeto"))?;
        only_keys(object, &["protocol_min", "protocol_max", "capabilities"], "`remote_hello`")?;
        let number = |key: &str| object.get(key).and_then(Value::as_u64).ok_or_else(|| err("remote_invalid_request", format!("`{key}` debe ser un entero positivo")));
        let protocol = negotiate(number("protocol_min")?, number("protocol_max")?)?;
        let client_caps: Vec<&str> = match object.get("capabilities") {
            None => Vec::new(),
            Some(Value::Array(items)) if items.len() <= MAX_CAPABILITIES => items
                .iter()
                .map(|v| v.as_str().filter(|s| !s.is_empty() && s.len() <= 64))
                .collect::<Option<_>>()
                .ok_or_else(|| err("remote_invalid_request", "cada capacidad es un texto de hasta 64 caracteres"))?,
            Some(_) => return Err(err("remote_invalid_request", format!("`capabilities` es una lista de hasta {MAX_CAPABILITIES} textos"))),
        };

        let now = now_ms() as i64;
        let (session_id, secret) = (format!("rs-{}", random_hex(12)?), random_hex(32)?);
        {
            let mut inner = self.remote.lock();
            expire(&mut inner, now);
            if inner.sessions.len() >= MAX_SESSIONS {
                return Err(err("remote_too_many_sessions", "este Core ya atiende el máximo de sesiones remotas"));
            }
            let mine = inner.sessions.values().filter(|s| s.client.identity().client_id() == client.identity().client_id()).count();
            if mine >= MAX_SESSIONS_PER_CLIENT {
                return Err(err("remote_too_many_sessions", format!("este dispositivo ya tiene {MAX_SESSIONS_PER_CLIENT} sesiones abiertas: cierra alguna o espera a que caduque")));
            }
            inner.sessions.insert(session_id.clone(), Session { client, secret_hash: sha256_hex(secret.as_bytes()), last_seq: 0, last_used: now, in_flight: 0 });
        }
        let host_id = self.storage.read_store(|s| s.meta("machine_id")).and_then(Result::ok).flatten();
        let event_head = self.storage.read_store(|s| s.events_head()).and_then(Result::ok);
        Ok(json!({
            "v": 1,
            "session_id": session_id,
            "session_secret": secret,
            "protocol": protocol,
            "host_id": host_id,
            "runtime_instance": self.runtime_instance,
            "capabilities": SERVER_CAPABILITIES,
            // Lo que el cliente declaró y este Core también ofrece: el resto no se promete.
            "shared_capabilities": SERVER_CAPABILITIES.iter().filter(|c| client_caps.contains(c)).collect::<Vec<_>>(),
            "event_head": event_head,
            "limits": { "max_in_flight": MAX_IN_FLIGHT, "max_envelope_bytes": MAX_ENVELOPE_BYTES, "session_idle_ms": SESSION_IDLE_MS, "dedup_ttl_ms": DEDUP_TTL_MS },
        }))
    }

    /// Atiende un sobre `{session_id, session_secret, seq, request_id, cmd, args?}` de una sesión abierta.
    pub(super) fn remote_call(self: &Arc<Self>, envelope: &Value) -> Result<Value, String> {
        let size = envelope.to_string().len();
        if size > MAX_ENVELOPE_BYTES {
            return Err(err("remote_payload_too_large", format!("el sobre mide {size} bytes y el máximo es {MAX_ENVELOPE_BYTES}")));
        }
        let object = envelope.as_object().ok_or_else(|| err("remote_invalid_request", "el sobre debe ser un objeto"))?;
        only_keys(object, &["session_id", "session_secret", "seq", "request_id", "cmd", "args"], "un sobre remoto")?;
        let text = |key: &str| object.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| err("remote_invalid_request", format!("`{key}` es obligatorio")));
        let (session_id, secret, cmd) = (text("session_id")?, text("session_secret")?, text("cmd")?);
        let request_id = text("request_id")?;
        if request_id.len() > MAX_REQUEST_ID || request_id.chars().any(char::is_control) {
            return Err(err("remote_invalid_request", format!("`request_id` mide hasta {MAX_REQUEST_ID} caracteres y no admite control")));
        }
        let seq = object.get("seq").and_then(Value::as_u64).filter(|s| *s >= 1).ok_or_else(|| err("remote_invalid_request", "`seq` debe ser un entero desde 1"))?;
        let args = object.get("args").cloned().unwrap_or_else(|| json!({}));
        if !args.is_object() {
            return Err(err("remote_invalid_request", "`args` debe ser un objeto"));
        }
        let now = now_ms() as i64;

        // 1) La sesión, su secreto, la credencial viva, la repetición y el cupo: todo bajo UN candado, nada de ejecución todavía.
        let (client, key, replay) = {
            let mut inner = self.remote.lock();
            expire(&mut inner, now);
            // El mismo error para «no existe» y «secreto distinto»: no se revela qué sesiones hay.
            let invalid = || err("remote_session_invalid", "la sesión no existe, caducó o el secreto no es el suyo");
            let Some(session) = inner.sessions.get_mut(session_id) else { return Err(invalid()) };
            if !same_secret(&session.secret_hash, &sha256_hex(secret.as_bytes())) {
                return Err(invalid());
            }
            let credential = session.client.credential_id().to_string();
            match self.storage.read_store(|s| s.credential_state(&credential, now)) {
                Some(Ok(CredentialState::Active)) => {}
                Some(Ok(state)) => {
                    inner.sessions.remove(session_id);
                    return Err(match state {
                        CredentialState::Expired => err("remote_credential_expired", "la credencial del dispositivo caducó"),
                        _ => err("remote_credential_revoked", "la credencial del dispositivo está revocada"),
                    });
                }
                _ => return Err(err("remote_internal", "no se pudo comprobar la credencial del dispositivo")),
            }
            let session = inner.sessions.get_mut(session_id).expect("la sesión sigue ahí: el candado no se soltó");
            if seq <= session.last_seq {
                return Err(err("remote_replay", format!("`seq` {seq} no es mayor que el último atendido ({})", session.last_seq)));
            }
            session.last_seq = seq;
            session.last_used = now;
            if !REMOTE_COMMANDS.contains(&cmd) {
                return Err(err("remote_command_forbidden", format!("`{cmd}` no se atiende por una sesión remota")));
            }
            let client = session.client.clone();
            let key = (client.identity().client_id().to_string(), request_id.to_string());
            let fp = fingerprint(cmd, &args);
            match inner.dedup.get(&key) {
                Some(Entry::Done { fingerprint, result, .. }) if *fingerprint == fp => (client, key, Some(result.clone())),
                Some(Entry::Running { fingerprint }) if *fingerprint == fp => return Err(err("remote_request_in_progress", "ese `request_id` se está atendiendo ahora: espera su respuesta")),
                Some(_) => return Err(err("remote_request_conflict", "ese `request_id` ya se usó con otro comando o argumentos")),
                None => {
                    let session = inner.sessions.get_mut(session_id).expect("la sesión sigue ahí");
                    if session.in_flight >= MAX_IN_FLIGHT {
                        return Err(err("remote_backpressure", format!("la sesión ya tiene {MAX_IN_FLIGHT} llamadas en curso: espera a que alguna termine")));
                    }
                    session.in_flight += 1;
                    inner.dedup.insert(key.clone(), Entry::Running { fingerprint: fp });
                    inner.order.push_back(key.clone());
                    (client, key, None)
                }
            }
        };
        if let Some(result) = replay {
            return Ok(reply(session_id, seq, request_id, true, result));
        }

        // 2) La ejecución, SIN el candado: el comando pasa por la misma puerta y la misma política que uno local.
        let Some(channel) = channel_of(client.identity().surface()) else {
            let mut inner = self.remote.lock();
            inner.dedup.remove(&key);
            if let Some(session) = inner.sessions.get_mut(session_id) {
                session.in_flight = session.in_flight.saturating_sub(1);
            }
            return Err(err("remote_unauthorized", "esta superficie no abre sesiones remotas"));
        };
        let outcome = self.rpc_authenticated_via(&client, &ClientClaims::default(), channel, "", cmd, &args);

        // 3) El desenlace. Solo un éxito se recuerda: un fallo se puede reintentar y se vuelve a evaluar.
        let mut inner = self.remote.lock();
        if let Some(session) = inner.sessions.get_mut(session_id) {
            session.in_flight = session.in_flight.saturating_sub(1);
        }
        match outcome {
            Ok(result) => {
                let fp = fingerprint(cmd, &args);
                inner.dedup.insert(key, Entry::Done { fingerprint: fp, at: now, result: result.clone() });
                trim(&mut inner);
                Ok(reply(session_id, seq, request_id, false, result))
            }
            Err(e) => {
                inner.dedup.remove(&key);
                Err(e)
            }
        }
    }

    /// Cierra una sesión remota. Idempotente; con un secreto que no es el suyo no cierra nada.
    pub(super) fn remote_close(&self, session_id: &str, secret: &str) -> bool {
        let mut inner = self.remote.lock();
        match inner.sessions.get(session_id) {
            Some(s) if same_secret(&s.secret_hash, &sha256_hex(secret.as_bytes())) => {
                inner.sessions.remove(session_id);
                true
            }
            _ => false,
        }
    }

    /// Caduca lo inactivo. Lo llama el barrido periódico del Core.
    pub(super) fn remote_sweep(&self) {
        expire(&mut self.remote.lock(), now_ms() as i64);
    }

    /// SOLO pruebas: cuántas sesiones hay abiertas.
    #[cfg(test)]
    pub(super) fn remote_session_count(&self) -> usize {
        self.remote.lock().sessions.len()
    }

    /// SOLO pruebas: ocupa `n` huecos de «en vuelo» de una sesión, como si hubiera `n` llamadas lentas en curso.
    #[cfg(test)]
    pub(super) fn remote_hold_in_flight(&self, session_id: &str, n: usize) {
        if let Some(s) = self.remote.lock().sessions.get_mut(session_id) {
            s.in_flight = n;
        }
    }

    /// SOLO pruebas: envejece lo recordado para los reintentos (el plazo son 10 minutos).
    #[cfg(test)]
    pub(super) fn remote_age_dedup(&self, by_ms: i64) {
        for entry in self.remote.lock().dedup.values_mut() {
            if let Entry::Done { at, .. } = entry {
                *at -= by_ms;
            }
        }
    }

    /// SOLO pruebas: adelanta el último uso de una sesión (la inactividad son 15 minutos).
    #[cfg(test)]
    pub(super) fn remote_age_session(&self, session_id: &str, by_ms: i64) {
        if let Some(s) = self.remote.lock().sessions.get_mut(session_id) {
            s.last_used -= by_ms;
        }
    }
}

fn reply(session_id: &str, seq: u64, request_id: &str, replayed: bool, result: Value) -> Value {
    json!({ "v": 1, "session_id": session_id, "seq": seq, "request_id": request_id, "replayed": replayed, "result": result })
}

/// Caduca sesiones inactivas (sin llamadas en vuelo) y respuestas recordadas viejas.
fn expire(inner: &mut Inner, now: i64) {
    inner.sessions.retain(|_, s| s.in_flight > 0 || now.saturating_sub(s.last_used) < SESSION_IDLE_MS);
    inner.dedup.retain(|_, e| match e {
        Entry::Running { .. } => true,
        Entry::Done { at, .. } => now.saturating_sub(*at) < DEDUP_TTL_MS,
    });
    let live: std::collections::HashSet<(String, String)> = inner.dedup.keys().cloned().collect();
    inner.order.retain(|k| live.contains(k));
}

/// Acota la memoria de reintentos: se olvida lo más antiguo ya atendido.
fn trim(inner: &mut Inner) {
    while inner.dedup.len() > DEDUP_CAPACITY {
        let Some(oldest) = inner.order.pop_front() else { break };
        if matches!(inner.dedup.get(&oldest), Some(Entry::Done { .. })) {
            inner.dedup.remove(&oldest);
        }
    }
}
