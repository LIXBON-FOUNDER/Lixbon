//! LXO-184 · la sesión remota contra un RELAY SIMULADO: el apretón de manos, consultas, eventos con cursor, mandos idempotentes, repetición,
//! revocación, versiones incompatibles, host offline, límites y seguridad. El relay simulado hace lo que debe hacer el real (reenviar, acotar la cola,
//! perder una respuesta, caer) y nada más: la autoridad es siempre el Core.

use std::sync::Arc;

use serde_json::{json, Value};

use super::attempt_e2e_tests::{world, World};
use super::remote_session::{DEDUP_TTL_MS, MAX_ENVELOPE_BYTES, MAX_IN_FLIGHT, MAX_SESSIONS_PER_CLIENT, SESSION_IDLE_MS};
use super::state::now_ms;
use super::Core;
use crate::store::{ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity};

/// El token del dispositivo remoto de las pruebas: una Person de Desktop registrada AHORA (la de la fixture e2e nace en 1970 y figura caducada).
const DEVICE_SECRET: &str = "remote-device-secret-0123456789abcdef-xyz";

fn registra_dispositivo(core: &Core) {
    let registro = ClientRegistration::new(ClientSurface::Desktop, DeviceIdentity::new("remote-device", None).unwrap()).unwrap();
    let credencial = ClientCredential::new(ClientPrincipal::Person("remote-person".into()), DEVICE_SECRET).unwrap();
    core.storage.with_store(|s| s.register_client(&registro, &credencial, now_ms() as i64).unwrap()).unwrap();
}

/// Lo que ve un cliente cuando el relay no puede entregar o no le llega la respuesta: nunca es un fallo del Core.
#[derive(Debug, PartialEq)]
enum RelayError {
    /// El host no está conectado al relay: figura offline, no failed.
    HostOffline,
    /// La cola hacia el host está llena.
    QueueFull,
    /// El Core ejecutó el sobre pero la respuesta no llegó al cliente.
    ReplyLost,
    /// El Core respondió con este error.
    Core(String),
}

struct Relay {
    core: Arc<Core>,
    online: bool,
    queue_cap: usize,
    queued: usize,
    lose_next_reply: bool,
}

impl Relay {
    fn new(core: &Arc<Core>) -> Relay {
        registra_dispositivo(core);
        Relay { core: core.clone(), online: true, queue_cap: 64, queued: 0, lose_next_reply: false }
    }

    fn hello(&mut self, secret: &str, args: Value) -> Result<Value, RelayError> {
        if !self.online {
            return Err(RelayError::HostOffline);
        }
        self.core.remote_hello(secret, &args).map_err(RelayError::Core)
    }

    fn forward(&mut self, envelope: &Value) -> Result<Value, RelayError> {
        if !self.online {
            return Err(RelayError::HostOffline);
        }
        if self.queued >= self.queue_cap {
            return Err(RelayError::QueueFull);
        }
        let result = self.core.remote_call(envelope).map_err(RelayError::Core);
        if std::mem::take(&mut self.lose_next_reply) {
            return Err(RelayError::ReplyLost);
        }
        result
    }
}

struct Cliente {
    session_id: String,
    secret: String,
    seq: u64,
}

impl Cliente {
    fn conecta(relay: &mut Relay) -> Cliente {
        Self::conecta_con(relay, DEVICE_SECRET).expect("hello")
    }

    fn conecta_con(relay: &mut Relay, device: &str) -> Result<Cliente, RelayError> {
        let h = relay.hello(device, json!({ "protocol_min": 1, "protocol_max": 1, "capabilities": ["query", "events"] }))?;
        Ok(Cliente { session_id: h["session_id"].as_str().unwrap().into(), secret: h["session_secret"].as_str().unwrap().into(), seq: 0 })
    }

    fn sobre(&mut self, request_id: &str, cmd: &str, args: Value) -> Value {
        self.seq += 1;
        json!({ "session_id": self.session_id, "session_secret": self.secret, "seq": self.seq, "request_id": request_id, "cmd": cmd, "args": args })
    }

    fn llama(&mut self, relay: &mut Relay, request_id: &str, cmd: &str, args: Value) -> Result<Value, RelayError> {
        let sobre = self.sobre(request_id, cmd, args);
        relay.forward(&sobre)
    }
}

fn codigo(e: RelayError) -> String {
    match e {
        RelayError::Core(m) => m.split(':').next().unwrap_or_default().to_string(),
        otro => format!("{otro:?}"),
    }
}

fn crea(titulo: &str, w: &World) -> Value {
    json!({ "request_id": format!("task-{titulo}"), "project_id": w.project, "objective": "o", "title": titulo, "spec": "haz algo", "repo": "." })
}

fn tareas_llamadas(core: &Core, titulo: &str) -> i64 {
    core.storage.read_store(|s| s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM tasks WHERE title = ?1", [titulo], |r| r.get(0))?))).unwrap().unwrap()
}

// ---------------------------------------------------------------------------------------------
// Apretón de manos y versiones
// ---------------------------------------------------------------------------------------------

#[test]
fn el_apreton_de_manos_negocia_la_version_y_solo_promete_lo_compartido() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let h = relay.hello(DEVICE_SECRET, json!({ "protocol_min": 1, "protocol_max": 5, "capabilities": ["events", "telepatia"] })).unwrap();
    assert_eq!(h["protocol"], 1, "se habla la mayor versión común");
    assert_eq!(h["shared_capabilities"], json!(["events"]), "lo que el Core no ofrece no se promete");
    assert_eq!(h["runtime_instance"], json!(w.core.runtime_instance));
    assert!(h["session_secret"].as_str().unwrap().len() >= 64 && h["session_id"].as_str().unwrap().starts_with("rs-"));
    assert!(h["event_head"].is_number() && h["limits"]["max_in_flight"] == MAX_IN_FLIGHT);
}

#[test]
fn una_version_incompatible_falla_explicitamente_y_no_abre_sesion() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    for (min, max) in [(2, 3), (7, 9)] {
        let e = relay.hello(DEVICE_SECRET, json!({ "protocol_min": min, "protocol_max": max })).unwrap_err();
        assert_eq!(codigo(e), "remote_version_unsupported", "{min}..{max}");
    }
    assert_eq!(codigo(relay.hello(DEVICE_SECRET, json!({ "protocol_min": 3, "protocol_max": 1 })).unwrap_err()), "remote_invalid_request");
    assert_eq!(codigo(relay.hello(DEVICE_SECRET, json!({ "protocol_max": 1 })).unwrap_err()), "remote_invalid_request");
    assert_eq!(codigo(relay.hello(DEVICE_SECRET, json!({ "protocol_min": 1, "protocol_max": 1, "intruso": true })).unwrap_err()), "remote_invalid_request");
    assert_eq!(w.core.remote_session_count(), 0);
}

#[test]
fn sin_credencial_valida_no_hay_sesion_y_un_agent_nunca_la_abre() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    assert_eq!(codigo(relay.hello("no-es-un-token", json!({ "protocol_min": 1, "protocol_max": 1 })).unwrap_err()), "remote_unauthorized");
    assert_eq!(codigo(relay.hello("", json!({ "protocol_min": 1, "protocol_max": 1 })).unwrap_err()), "remote_unauthorized");

    // Una credencial Agent (de una Task local) es válida, pero no es de un control remoto.
    let registro = ClientRegistration::new(ClientSurface::Cli, DeviceIdentity::new("install-agent-remoto", None).unwrap()).unwrap();
    let agente = ClientCredential::new(ClientPrincipal::Agent("t1".into()), "agent-remote-secret-0123456789abcdef-xyz").unwrap();
    w.core.storage.with_store(|s| s.register_client(&registro, &agente, now_ms() as i64).unwrap()).unwrap();
    let e = relay.hello("agent-remote-secret-0123456789abcdef-xyz", json!({ "protocol_min": 1, "protocol_max": 1 })).unwrap_err();
    assert_eq!(codigo(e), "remote_unauthorized");
    assert_eq!(w.core.remote_session_count(), 0);
}

// ---------------------------------------------------------------------------------------------
// Consultas, eventos y mandos
// ---------------------------------------------------------------------------------------------

#[test]
fn una_consulta_un_mando_y_los_eventos_viajan_por_la_misma_sesion() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);

    let estado = c.llama(&mut relay, "q-1", "status", json!({})).unwrap();
    assert_eq!((estado["replayed"].as_bool(), estado["seq"].as_u64(), estado["request_id"].as_str()), (Some(false), Some(1), Some("q-1")));

    let antes = c.llama(&mut relay, "e-0", "events", json!({ "cursor": 0, "limit": 5 })).unwrap();
    let cursor = antes["result"]["head_seq"].as_i64().unwrap();

    let creada = c.llama(&mut relay, "m-1", "task_create", crea("remota", &w)).unwrap();
    assert_eq!(creada["result"]["status"], "Committed", "{creada}");
    assert_eq!(tareas_llamadas(&w.core, "remota"), 1);

    // Los eventos nuevos llegan desde el cursor y solo ellos.
    let nuevos = c.llama(&mut relay, "e-1", "events", json!({ "cursor": cursor, "limit": 50 })).unwrap();
    let eventos = nuevos["result"]["events"].as_array().unwrap();
    assert!(!eventos.is_empty(), "el mando dejó hechos nuevos");
    assert!(eventos.iter().all(|e| e["seq"].as_i64().unwrap() > cursor), "solo después del cursor");
    assert!(eventos.iter().any(|e| e["kind"] == "task.created"));
}

#[test]
fn reconectar_reanuda_los_eventos_desde_el_cursor_sin_repetir_ni_perder() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut a = Cliente::conecta(&mut relay);
    a.llama(&mut relay, "m-a", "task_create", crea("antes", &w)).unwrap();
    let visto = a.llama(&mut relay, "e-a", "events", json!({ "cursor": 0, "limit": 500 })).unwrap();
    let cursor = visto["result"]["next_cursor"].as_i64().unwrap();
    assert!(w.core.remote_close(&a.session_id, &a.secret));

    // Mientras el cliente estaba caído, el Core sigue trabajando.
    let mut b = Cliente::conecta(&mut relay);
    b.llama(&mut relay, "m-b", "task_create", crea("despues", &w)).unwrap();

    let reanuda = b.llama(&mut relay, "e-b", "events", json!({ "cursor": cursor, "limit": 500 })).unwrap();
    let eventos = reanuda["result"]["events"].as_array().unwrap();
    assert!(eventos.iter().all(|e| e["seq"].as_i64().unwrap() > cursor), "nada se repite");
    assert!(eventos.iter().any(|e| e["kind"] == "task.created"), "lo que pasó mientras tanto llega");
    let todos = b.llama(&mut relay, "e-c", "events", json!({ "cursor": 0, "limit": 500 })).unwrap();
    assert_eq!(todos["result"]["head_seq"], reanuda["result"]["head_seq"], "los dos ven el mismo final del log: el Core es la única fuente");
}

// ---------------------------------------------------------------------------------------------
// Idempotencia y repetición
// ---------------------------------------------------------------------------------------------

#[test]
fn si_la_respuesta_se_pierde_el_reintento_devuelve_lo_mismo_sin_ejecutar_dos_veces() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);

    relay.lose_next_reply = true;
    let perdida = c.llama(&mut relay, "m-dup", "task_create", crea("una-vez", &w)).unwrap_err();
    assert_eq!(perdida, RelayError::ReplyLost);
    assert_eq!(tareas_llamadas(&w.core, "una-vez"), 1, "el Core sí lo ejecutó");

    // El cliente no vio la respuesta: reenvía con OTRO seq y el MISMO request_id.
    let reintento = c.llama(&mut relay, "m-dup", "task_create", crea("una-vez", &w)).unwrap();
    assert_eq!(reintento["replayed"], true);
    assert_eq!(reintento["result"]["status"], "Committed");
    assert_eq!(tareas_llamadas(&w.core, "una-vez"), 1, "reintentar no duplica la Task");
    // Y un tercero sigue devolviendo lo mismo.
    let otra = c.llama(&mut relay, "m-dup", "task_create", crea("una-vez", &w)).unwrap();
    assert_eq!((otra["replayed"].as_bool(), &otra["result"]["task_id"]), (Some(true), &reintento["result"]["task_id"]));
}

#[test]
fn el_mismo_request_id_con_otro_comando_o_argumentos_es_un_conflicto() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);
    c.llama(&mut relay, "m-1", "task_create", crea("a", &w)).unwrap();
    assert_eq!(codigo(c.llama(&mut relay, "m-1", "task_create", crea("b", &w)).unwrap_err()), "remote_request_conflict");
    assert_eq!(codigo(c.llama(&mut relay, "m-1", "status", json!({})).unwrap_err()), "remote_request_conflict");
    assert_eq!((tareas_llamadas(&w.core, "a"), tareas_llamadas(&w.core, "b")), (1, 0));
}

#[test]
fn un_sobre_repetido_o_mas_viejo_es_una_repeticion_y_no_se_atiende() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);
    let primero = c.sobre("r-1", "status", json!({}));
    relay.forward(&primero).unwrap();
    // El mismo sobre otra vez (un atacante que lo capturó), y uno anterior al último.
    assert_eq!(codigo(relay.forward(&primero).unwrap_err()), "remote_replay");
    let viejo = json!({ "session_id": c.session_id, "session_secret": c.secret, "seq": 1, "request_id": "r-otro", "cmd": "status", "args": {} });
    assert_eq!(codigo(relay.forward(&viejo).unwrap_err()), "remote_replay");
    // La sesión sigue sana: el siguiente seq vale.
    assert!(c.llama(&mut relay, "r-2", "status", json!({})).is_ok());
}

#[test]
fn un_fallo_no_se_recuerda_y_se_puede_reintentar() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);
    // Un proyecto inexistente falla; el reintento con el MISMO request_id vuelve a evaluarse (y falla otra vez, sin respuesta cacheada).
    let malo = json!({ "request_id": "m-x", "project_id": "no-existe", "objective": "o", "title": "t", "spec": "s", "repo": "." });
    let primero = c.llama(&mut relay, "m-x", "task_create", malo.clone());
    let segundo = c.llama(&mut relay, "m-x", "task_create", malo);
    assert!(matches!(primero, Err(RelayError::Core(_))) && matches!(segundo, Err(RelayError::Core(_))));
    // Un fallo no deja el `request_id` ocupado: con otro comando se atiende (si se hubiera recordado, sería un conflicto).
    assert!(c.llama(&mut relay, "m-x", "status", json!({})).is_ok(), "un fallo no deja un request_id ocupado");
}

// ---------------------------------------------------------------------------------------------
// Revocación, caducidad y secretos
// ---------------------------------------------------------------------------------------------

#[test]
fn un_dispositivo_revocado_deja_de_funcionar_en_la_siguiente_llamada_con_la_sesion_abierta() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);
    assert!(c.llama(&mut relay, "r-1", "status", json!({})).is_ok());

    let client_id = w.core.authenticate_client(DEVICE_SECRET).unwrap().unwrap().identity().client_id().to_string();
    w.core.storage.with_store(|s| assert!(s.revoke_client(&client_id, 20_000_000).unwrap())).unwrap();

    assert_eq!(codigo(c.llama(&mut relay, "r-2", "status", json!({})).unwrap_err()), "remote_credential_revoked");
    assert_eq!(w.core.remote_session_count(), 0, "la sesión se cierra con el dispositivo");
    assert_eq!(codigo(c.llama(&mut relay, "r-3", "status", json!({})).unwrap_err()), "remote_session_invalid");
    assert_eq!(codigo(relay.hello(DEVICE_SECRET, json!({ "protocol_min": 1, "protocol_max": 1 })).unwrap_err()), "remote_credential_revoked");
}

#[test]
fn un_secreto_de_sesion_equivocado_o_una_sesion_ajena_no_se_distinguen() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);
    let mut sobre = c.sobre("s-1", "status", json!({}));
    sobre["session_secret"] = json!("0".repeat(64));
    let e1 = codigo(relay.forward(&sobre).unwrap_err());
    let mut sobre = c.sobre("s-2", "status", json!({}));
    sobre["session_id"] = json!("rs-inexistente");
    let e2 = codigo(relay.forward(&sobre).unwrap_err());
    assert_eq!((e1.as_str(), e2.as_str()), ("remote_session_invalid", "remote_session_invalid"), "no se revela qué sesiones existen");
    // Cerrar con un secreto ajeno no cierra nada; con el suyo sí, y cerrar dos veces es inofensivo.
    assert!(!w.core.remote_close(&c.session_id, "otro"));
    assert!(w.core.remote_close(&c.session_id, &c.secret));
    assert!(!w.core.remote_close(&c.session_id, &c.secret));
}

#[test]
fn el_secreto_de_sesion_solo_viaja_en_el_hello_y_nunca_en_un_error() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let h = relay.hello(DEVICE_SECRET, json!({ "protocol_min": 1, "protocol_max": 1 })).unwrap();
    let (id, secreto) = (h["session_id"].as_str().unwrap().to_string(), h["session_secret"].as_str().unwrap().to_string());
    let mut c = Cliente { session_id: id, secret: secreto.clone(), seq: 0 };
    let ok = c.llama(&mut relay, "t-1", "status", json!({})).unwrap();
    assert!(!ok.to_string().contains(&secreto), "una respuesta no repite el secreto");
    let sobre = json!({ "session_id": c.session_id, "session_secret": secreto, "seq": 1, "request_id": "t-2", "cmd": "status", "args": {} });
    let e = relay.forward(&sobre).unwrap_err();
    assert!(!format!("{e:?}").contains(&secreto), "un error tampoco");
    assert!(!format!("{e:?}").contains(DEVICE_SECRET));
}

#[test]
fn una_sesion_inactiva_caduca_y_el_barrido_la_retira() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);
    assert_eq!(w.core.remote_session_count(), 1);
    w.core.remote_age_session(&c.session_id, SESSION_IDLE_MS + 1_000);
    w.core.remote_sweep();
    assert_eq!(w.core.remote_session_count(), 0);
    assert_eq!(codigo(c.llama(&mut relay, "i-1", "status", json!({})).unwrap_err()), "remote_session_invalid");
    // Y una reconexión abre una sesión nueva con otro secreto.
    let nueva = Cliente::conecta(&mut relay);
    assert_ne!(nueva.secret, c.secret);
}

#[test]
fn la_memoria_de_reintentos_caduca() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);
    c.llama(&mut relay, "d-1", "task_create", crea("caduca", &w)).unwrap();
    // Pasado el plazo, el Core ya no recuerda ese request_id: la protección es la idempotencia durable del propio mando (`task_create`).
    w.core.remote_age_dedup(DEDUP_TTL_MS + 1_000);
    let otra = c.llama(&mut relay, "d-1", "task_create", crea("caduca", &w)).unwrap();
    assert_eq!(otra["replayed"], false);
    assert_eq!(tareas_llamadas(&w.core, "caduca"), 1, "el `request_id` durable de task_create sigue evitando el duplicado");
}

// ---------------------------------------------------------------------------------------------
// Relay: host offline, cola y límites
// ---------------------------------------------------------------------------------------------

#[test]
fn un_host_offline_se_ve_como_offline_no_como_fallo_y_al_volver_todo_sigue() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);
    assert!(c.llama(&mut relay, "o-1", "status", json!({})).is_ok());

    relay.online = false;
    assert_eq!(c.llama(&mut relay, "o-2", "status", json!({})).unwrap_err(), RelayError::HostOffline);
    assert_eq!(relay.hello(DEVICE_SECRET, json!({ "protocol_min": 1, "protocol_max": 1 })).unwrap_err(), RelayError::HostOffline);

    // Vuelve: la sesión del Core seguía viva y el sobre que no llegó se reenvía con el mismo request_id.
    relay.online = true;
    let seq_perdido = c.seq;
    c.seq = seq_perdido - 1; // el sobre de `o-2` nunca llegó al Core: su seq no se consumió
    assert!(c.llama(&mut relay, "o-2", "status", json!({})).is_ok());
}

#[test]
fn la_cola_del_relay_llena_y_las_llamadas_en_vuelo_se_acotan_con_backpressure() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);

    relay.queue_cap = 0;
    assert_eq!(c.llama(&mut relay, "b-1", "status", json!({})).unwrap_err(), RelayError::QueueFull);
    relay.queue_cap = 64;

    // Con todos los huecos de «en vuelo» ocupados, la siguiente llamada se rechaza antes de ejecutar nada...
    w.core.remote_hold_in_flight(&c.session_id, MAX_IN_FLIGHT);
    assert_eq!(codigo(c.llama(&mut relay, "b-2", "task_create", crea("no-entra", &w)).unwrap_err()), "remote_backpressure");
    assert_eq!(tareas_llamadas(&w.core, "no-entra"), 0);
    // ...y al liberarse, se atiende.
    w.core.remote_hold_in_flight(&c.session_id, 0);
    assert!(c.llama(&mut relay, "b-3", "status", json!({})).is_ok());
}

#[test]
fn las_sesiones_por_dispositivo_el_tamano_del_sobre_y_los_campos_estan_acotados() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut sesiones: Vec<Cliente> = (0..MAX_SESSIONS_PER_CLIENT).map(|_| Cliente::conecta(&mut relay)).collect();
    assert_eq!(codigo(relay.hello(DEVICE_SECRET, json!({ "protocol_min": 1, "protocol_max": 1 })).unwrap_err()), "remote_too_many_sessions");
    // Cerrar una libera un hueco.
    let primera = sesiones.remove(0);
    assert!(w.core.remote_close(&primera.session_id, &primera.secret));
    let mut c = Cliente::conecta(&mut relay);

    let grande = json!({ "relleno": "x".repeat(MAX_ENVELOPE_BYTES) });
    assert_eq!(codigo(c.llama(&mut relay, "g-1", "status", grande).unwrap_err()), "remote_payload_too_large");
    assert_eq!(codigo(c.llama(&mut relay, &"i".repeat(200), "status", json!({})).unwrap_err()), "remote_invalid_request");
    assert_eq!(codigo(c.llama(&mut relay, "g-3", "status", json!([1, 2])).unwrap_err()), "remote_invalid_request");
    let mut con_campo_ajeno = c.sobre("g-4", "status", json!({}));
    con_campo_ajeno["intruso"] = json!(1);
    assert_eq!(codigo(relay.forward(&con_campo_ajeno).unwrap_err()), "remote_invalid_request");
    let mut sin_seq = c.sobre("g-5", "status", json!({}));
    sin_seq["seq"] = json!(0);
    assert_eq!(codigo(relay.forward(&sin_seq).unwrap_err()), "remote_invalid_request");
}

#[test]
fn por_una_sesion_remota_solo_pasan_los_comandos_permitidos() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);
    for (i, cmd) in ["attempt_integrate", "project_add", "remove_run", "spawn", "policy_set", "attempt_handoff", "no_existe"].iter().enumerate() {
        let e = c.llama(&mut relay, &format!("f-{i}"), cmd, json!({})).unwrap_err();
        assert_eq!(codigo(e), "remote_command_forbidden", "{cmd}");
    }
    // Un comando permitido sigue sujeto a la política del Core: el relay no concede nada.
    let sin_permiso = c.llama(&mut relay, "f-ok", "attempt_stop", json!({ "attempt_id": "fantasma-a1" }));
    assert!(matches!(sin_permiso, Err(RelayError::Core(m)) if !m.starts_with("remote_command_forbidden")));
}

#[test]
fn el_estado_de_una_credencial_distingue_activa_vencida_revocada_y_desconocida() {
    use crate::store::CredentialState;
    let w = world("claude", None);
    registra_dispositivo(&w.core);
    let cred = w.core.authenticate_client(DEVICE_SECRET).unwrap().unwrap();
    let (id, client) = (cred.credential_id().to_string(), cred.identity().client_id().to_string());
    let ahora = now_ms() as i64;
    let estado = |id: &str, now: i64| w.core.storage.read_store(|s| s.credential_state(id, now)).unwrap().unwrap();
    assert_eq!(estado(&id, ahora), CredentialState::Active);
    assert_eq!(estado(&id, ahora + crate::store::CLIENT_CREDENTIAL_TTL_MS + 1), CredentialState::Expired, "pasado el TTL");
    assert_eq!(estado("no-existe", ahora), CredentialState::Unknown);
    // Revocar la INSTALACIÓN revoca también lo que cuelga de ella.
    w.core.storage.with_store(|s| assert!(s.revoke_client(&client, ahora).unwrap())).unwrap();
    assert_eq!(estado(&id, ahora), CredentialState::Revoked);
}

#[test]
fn una_sesion_que_se_usa_no_caduca_aunque_pase_el_tiempo_desde_que_se_abrio() {
    let w = world("claude", None);
    let mut relay = Relay::new(&w.core);
    let mut c = Cliente::conecta(&mut relay);
    // Casi la inactividad máxima desde que se abrió; una llamada la renueva y el mismo margen después sigue viva.
    w.core.remote_age_session(&c.session_id, SESSION_IDLE_MS - 1_000);
    assert!(c.llama(&mut relay, "u-1", "status", json!({})).is_ok());
    w.core.remote_age_session(&c.session_id, SESSION_IDLE_MS - 1_000);
    assert!(c.llama(&mut relay, "u-2", "status", json!({})).is_ok(), "usar la sesión renueva su plazo");
}
