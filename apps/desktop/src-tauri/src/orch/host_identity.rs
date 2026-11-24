//! LXO-182 · identidad de host: quién es este Core entre varias máquinas y cómo se acepta a otro.
//!
//! ```text
//!   este Core                                         un par (otra máquina)
//!   ─────────                                         ─────────────────────
//!   host_id = meta.machine_id (ya existía)            host_id + clave pública Ed25519
//!   clave privada: almacén seguro del SO              prueba = firma de {host_id, clave, datos, hora}
//!   fila `hosts` (is_self = 1)                                  │
//!                                                               ▼
//!                  host_peer_register ── verifica ──► fila `hosts` (is_self = 0) + `host.registered`
//! ```
//!
//! # Por qué una firma y no solo un texto
//! Hasta ahora una «máquina» era un texto suelto (`meta.machine_id`) que cualquiera podía declarar. Un `host_id` solo se acepta como par si
//! llega con la firma de la clave que lo identifica, y la PRIMERA clave que se ve para un `host_id` queda fijada: otra clave con ese mismo
//! `host_id` es una suplantación. El `host_id` PROPIO nunca viene de un cliente: sale siempre del almacén.
//!
//! # Garantías
//! * La clave privada no sale del almacén seguro del SO y nunca entra en la base, en un evento ni en un log. Sin almacén seguro el host
//!   existe pero no puede probar quién es (`verified = false`): no se inventa una clave guardada en otro sitio.
//! * Una prueba solo vale dentro de [`PROOF_WINDOW_MS`] y, para un host ya verificado, solo si es MÁS reciente que la última aceptada:
//!   repetir una prueba vieja no hace nada.
//! * Un host parado sigue en el registro: la disponibilidad se calcula (`online` / `stale`), no se borra nada.
//!
//! Este módulo NO abre ningún transporte ni sincroniza archivos: [`Core::host_peer_register`] lo llamará el gateway (LXO-184) cuando haya
//! autenticado la sesión; hoy solo lo ejercitan las pruebas con dos Cores.

#![cfg_attr(not(test), allow(dead_code))]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use serde_json::{json, Value};

use super::events::{Actor, MutationContext};
use super::host_ops::registered_event;
use super::mutation::Health;
use super::state::now_ms;
use super::{Caller, Core};
use crate::secure_store::{SecretKey, SecretStore, SecretValue};
use crate::store::{new_uuid, HostChange, HostInfo, HostRow, Store, StoreError, StoreResult};

/// Margen entre la hora firmada de una prueba y la hora de este Core.
pub(super) const PROOF_WINDOW_MS: i64 = 10 * 60 * 1000;
/// Un par sin señal verificada durante más de esto figura `stale`: se muestra como no disponible, nunca como borrado.
pub(super) const STALE_AFTER_MS: i64 = 15 * 60 * 1000;
const PROOF_DOMAIN: &str = "lixbon-host-proof-v1";
const MAX_CAPABILITIES: usize = 32;
const META_MACHINE: &str = "machine_id";

/// Lo que este Core sabe hacer, para que un par decida qué pedirle. Mínimo a propósito.
const CAPABILITIES: &[&str] = &["core", "projects"];

/// La prueba de que un host posee su clave: sus datos y la firma de todo lo anterior.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct HostProof {
    pub host_id: String,
    /// Ed25519 en hexadecimal.
    pub public_key: String,
    pub info: HostInfo,
    /// ms epoch en que se firmó.
    pub issued_at: i64,
    /// Firma Ed25519 en hexadecimal.
    pub signature: String,
}

// ---------------------------------------------------------------------------------------------
// Lo que firma la prueba
// ---------------------------------------------------------------------------------------------

/// Los bytes EXACTOS que se firman. Cada campo va en su línea: por eso ninguno puede contener saltos de línea (se validan antes).
pub(super) fn proof_message(host_id: &str, public_key: &str, info: &HostInfo, issued_at: i64) -> Vec<u8> {
    format!("{PROOF_DOMAIN}\n{host_id}\n{public_key}\n{}\n{}\n{}\n{}\n{}\n{issued_at}", info.label, info.os, info.arch, info.app_version, info.capabilities.join(",")).into_bytes()
}

fn clean(field: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    let n = value.chars().count();
    if n < min || n > max {
        return Err(format!("host_proof_invalid: `{field}` debe tener entre {min} y {max} caracteres"));
    }
    if value.chars().any(|c| c.is_control()) {
        return Err(format!("host_proof_invalid: `{field}` no admite caracteres de control"));
    }
    Ok(())
}

fn validate_info(host_id: &str, info: &HostInfo) -> Result<(), String> {
    clean("host_id", host_id, 1, 200)?;
    clean("label", info.label.trim(), 1, 120)?;
    clean("os", &info.os, 1, 64)?;
    clean("arch", &info.arch, 1, 64)?;
    clean("app_version", &info.app_version, 1, 64)?;
    if info.capabilities.len() > MAX_CAPABILITIES {
        return Err(format!("host_proof_invalid: como mucho {MAX_CAPABILITIES} capacidades"));
    }
    for c in &info.capabilities {
        if c.is_empty() || c.len() > 64 || !c.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-')) {
            return Err("host_proof_invalid: una capacidad solo admite minúsculas ASCII, dígitos, '.', '_' y '-'".into());
        }
    }
    Ok(())
}

pub(super) fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 || !text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

/// Comprueba la firma de una prueba y devuelve su clave pública. No mira el registro ni el reloj.
fn verify_signature(proof: &HostProof) -> Result<(), String> {
    validate_info(&proof.host_id, &proof.info)?;
    let key = from_hex(&proof.public_key).filter(|k| k.len() == 32).ok_or("host_proof_invalid: la clave pública no es una Ed25519 de 32 bytes en hexadecimal")?;
    let signature = from_hex(&proof.signature).filter(|s| s.len() == 64).ok_or("host_proof_invalid: la firma no es de 64 bytes en hexadecimal")?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(&proof_message(&proof.host_id, &proof.public_key, &proof.info, proof.issued_at), &signature)
        .map_err(|_| "host_proof_invalid: la firma no corresponde a esa clave y esos datos".to_string())
}

// ---------------------------------------------------------------------------------------------
// La clave de este host
// ---------------------------------------------------------------------------------------------

fn key_ref(host_id: &str) -> Option<SecretKey> {
    // La cuenta lleva el `host_id`: dos perfiles de datos en la misma máquina no comparten clave.
    let account: String = host_id.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '-' }).collect();
    SecretKey::lixbon(&format!("host/{account}/ed25519")).ok()
}

fn load_key(secrets: &dyn SecretStore, key: &SecretKey) -> Option<Ed25519KeyPair> {
    let value = secrets.get(key).ok()?;
    let pkcs8 = STANDARD.decode(value.expose()).ok()?;
    Ed25519KeyPair::from_pkcs8(&pkcs8).ok()
}

/// La clave guardada, o una nueva si no hay ninguna. `None` = el almacén seguro no está disponible (el host queda sin verificar): una
/// clave que no se pudo guardar no se usa, porque mañana sería otra distinta.
fn key_for(secrets: &dyn SecretStore, host_id: &str) -> Option<Ed25519KeyPair> {
    let reference = key_ref(host_id)?;
    match secrets.get(&reference) {
        Ok(value) => {
            let pkcs8 = STANDARD.decode(value.expose()).ok()?;
            Ed25519KeyPair::from_pkcs8(&pkcs8).ok()
        }
        Err(e) if e.is_not_found() => {
            let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).ok()?;
            let value = SecretValue::new(STANDARD.encode(document.as_ref())).ok()?;
            secrets.set(&reference, &value).ok()?;
            // Se relee: lo que se usa es lo que quedó guardado.
            load_key(secrets, &reference)
        }
        Err(_) => None,
    }
}

fn local_info() -> HostInfo {
    let label = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).ok().map(|n| n.trim().to_string()).filter(|n| !n.is_empty() && !n.chars().any(|c| c.is_control())).unwrap_or_else(|| "Este equipo".to_string());
    HostInfo {
        label: label.chars().take(120).collect(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        capabilities: CAPABILITIES.iter().map(|c| (*c).to_string()).collect(),
    }
}

fn store_error(error: StoreError) -> String {
    match error {
        // `hosts` nace con la migración 027, posterior al corte Task/Attempt: antes del corte el registro de hosts no existe.
        StoreError::AgenticModelInactive => "core_model_inactive: el registro de hosts existe tras el corte Task/Attempt".into(),
        StoreError::HostConflict(m) => format!("host_conflict: {m}"),
        other => format!("host_store_failed: {other}"),
    }
}

// ---------------------------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------------------------

impl Core {
    fn require_hosts_writable(&self) -> Result<(), String> {
        match self.health() {
            Health::Normal => Ok(()),
            Health::DegradedReadOnly(why) => Err(format!("El Core está en solo lectura ({why}): el registro de hosts no admite escrituras hasta que se recupere el almacenamiento")),
        }
    }

    /// Da de alta (o refresca) el host de ESTE Core: su `host_id` es el `machine_id` del almacén (se crea la primera vez) y su clave, la del
    /// almacén seguro. Se llama al arrancar y es idempotente. Sin almacén seguro el host queda sin verificar, no falla.
    pub(super) fn host_identity_ensure_with(&self, secrets: &dyn SecretStore) -> Result<HostRow, String> {
        self.require_hosts_writable()?;
        let now = now_ms() as i64;
        let result = self.storage.with_store(|st| -> StoreResult<HostRow> {
            if !st.agentic_model_active()? {
                return Err(StoreError::AgenticModelInactive);
            }
            let host_id = match st.meta(META_MACHINE)? {
                Some(m) => m,
                None => {
                    let m = new_uuid();
                    st.meta_set(META_MACHINE, &m)?;
                    m
                }
            };
            let public_key = key_for(secrets, &host_id).map(|k| to_hex(k.public_key().as_ref()));
            let event = registered_event(&host_id, true, public_key.is_some(), now).map_err(StoreError::InvalidEvent)?;
            let (row, _) = st.host_self_record(&host_id, &local_info(), public_key.as_deref(), now, &event)?;
            Ok(row)
        });
        match result {
            Some(Ok(row)) => Ok(row),
            Some(Err(e)) => Err(store_error(e)),
            None => Err("host_store_failed: el Core no tiene almacén abierto".into()),
        }
    }

    /// La prueba que este host le da a otro para que lo registre. Falla si no tiene clave (sin almacén seguro): no puede probar quién es.
    pub(super) fn host_proof_issue_with(&self, secrets: &dyn SecretStore) -> Result<HostProof, String> {
        let me = self
            .storage
            .read_store(|st| st.host_self())
            .ok_or("host_store_failed: el Core no tiene almacén abierto")?
            .map_err(store_error)?
            .ok_or("host_unknown: este Core todavía no tiene identidad de host")?;
        let public_key = me.public_key.clone().ok_or("host_unverified: este host no tiene clave (¿almacén seguro no disponible?) y no puede probar quién es")?;
        let key = key_ref(&me.host_id).and_then(|r| load_key(secrets, &r)).ok_or("host_unverified: la clave de este host no está en el almacén seguro")?;
        if to_hex(key.public_key().as_ref()) != public_key {
            return Err("host_unverified: la clave del almacén seguro no es la fijada para este host".into());
        }
        let info = HostInfo { label: me.label, os: me.os.unwrap_or_default(), arch: me.arch.unwrap_or_default(), app_version: me.app_version.unwrap_or_default(), capabilities: me.capabilities };
        let issued_at = now_ms() as i64;
        let signature = to_hex(key.sign(&proof_message(&me.host_id, &public_key, &info, issued_at)).as_ref());
        Ok(HostProof { host_id: me.host_id, public_key, info, issued_at, signature })
    }

    /// Registra (o refresca) un host PAR a partir de su prueba de posesión. NO autentica el canal: quien llama (el gateway, LXO-184) ya lo hizo.
    ///
    /// Rechaza: una firma que no cuadra, una hora fuera de [`PROOF_WINDOW_MS`], el `host_id` o la clave de ESTE host, otra clave para un
    /// `host_id` ya fijado, una clave de otro host y una prueba que no es más reciente que la ya aceptada.
    pub(super) fn host_peer_register(&self, proof: &HostProof) -> Result<HostRow, String> {
        self.require_hosts_writable()?;
        verify_signature(proof)?;
        let now = now_ms() as i64;
        if (now - proof.issued_at).abs() > PROOF_WINDOW_MS {
            return Err("host_proof_expired: la hora de la prueba está fuera de la ventana permitida".into());
        }
        let event = registered_event(&proof.host_id, false, true, now)?;
        let result = self.storage.with_store(|st| -> StoreResult<(HostRow, HostChange)> {
            if !st.agentic_model_active()? {
                return Err(StoreError::AgenticModelInactive);
            }
            if let Some(me) = st.host_self()? {
                if me.host_id == proof.host_id || me.public_key.as_deref() == Some(proof.public_key.as_str()) {
                    return Err(StoreError::HostConflict(format!("{}: un par no puede presentarse con la identidad de este host", proof.host_id)));
                }
            }
            st.host_peer_record(&proof.host_id, &proof.info, &proof.public_key, proof.issued_at, now, &event)
        });
        match result {
            Some(Ok((row, _))) => Ok(row),
            Some(Err(e)) => Err(store_error(e)),
            None => Err("host_store_failed: el Core no tiene almacén abierto".into()),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Query `hosts_list`
// ---------------------------------------------------------------------------------------------

fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    let context = context.ok_or_else(|| "hosts_list_auth_required: la lectura requiere un cliente autenticado".to_string())?;
    match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("hosts_list_auth_required: solo una Person autenticada puede leer los hosts".into()),
    }
}

fn availability(row: &HostRow, now: i64) -> &'static str {
    if row.is_self || now - row.last_seen <= STALE_AFTER_MS {
        "online"
    } else {
        "stale"
    }
}

fn read_hosts(st: &Store) -> StoreResult<(Vec<HostRow>, Vec<crate::store::LocationRow>)> {
    if !st.agentic_model_active()? {
        return Err(StoreError::AgenticModelInactive);
    }
    st.read_snapshot(|s| Ok((s.hosts_list()?, s.project_locations(None)?)))
}

/// `hosts_list`: los hosts conocidos con las ubicaciones de proyecto que se conocen en cada uno. Solo lectura y sin argumentos.
///
/// La identidad es `host_id`; la ruta de una ubicación solo tiene sentido DENTRO de su host (la misma ruta en dos hosts son dos
/// ubicaciones). Un host parado figura `stale`, nunca desaparece.
pub(super) fn list(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    if let Some(object) = args.as_object() {
        if let Some(key) = object.keys().next() {
            return Err(format!("hosts_list_invalid_request: `{key}` no es un parámetro conocido (esta consulta no tiene)"));
        }
    } else if !args.is_null() {
        return Err("hosts_list_invalid_request: los argumentos deben ser un objeto".into());
    }
    let (hosts, locations) = core
        .storage
        .read_store(read_hosts)
        .ok_or_else(|| "hosts_list_unavailable: el Core no tiene un almacén autoritativo disponible".to_string())?
        .map_err(|e| match e {
            StoreError::AgenticModelInactive => store_error(e),
            _ => "hosts_list_read_failed: no se pudo consultar el registro de hosts".to_string(),
        })?;
    let now = now_ms() as i64;
    let self_id = hosts.iter().find(|h| h.is_self).map(|h| h.host_id.clone());
    let hosts: Vec<Value> = hosts
        .iter()
        .map(|h| {
            let locs: Vec<Value> = locations
                .iter()
                .filter(|l| l.machine == h.host_id)
                .map(|l| json!({ "project_id": l.project_id, "path": l.display_path, "primary": l.primary, "state": if l.missing { "missing" } else { "ok" }, "last_seen": l.last_seen }))
                .collect();
            json!({
                "host_id": h.host_id,
                "label": h.label,
                "self": h.is_self,
                "verified": h.verified_at.is_some() && h.public_key.is_some(),
                "public_key": h.public_key,
                "os": h.os,
                "arch": h.arch,
                "app_version": h.app_version,
                "capabilities": h.capabilities,
                "first_seen": h.first_seen,
                "last_seen": h.last_seen,
                "verified_at": h.verified_at,
                "availability": availability(h, now),
                "locations": locs,
            })
        })
        .collect();
    Ok(json!({ "self": self_id, "hosts": hosts }))
}
