//! Identidad de host (LXO-182, migración `027_hosts`): lado del **almacén**.
//!
//! Guarda y protege lo que `orch::host_identity` ya verificó; no firma ni comprueba firmas. Lo que impone el almacén aunque alguien
//! escriba SQL a mano: un solo host propio, una clave por host y de un solo host, la clave fijada no cambia y un host nunca se borra.
//!
//! Cada alta nueva (o una verificación que fija la clave de un host antes sin verificar) inserta su evento `host.registered` en la MISMA
//! transacción que la fila: o nacen los dos o ninguno. Refrescar `last_seen` o las capacidades no emite evento (no es un hecho nuevo).

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use super::error::{StoreError, StoreResult};
use super::events::{insert_events_projected, Inserted, NewEvent};
use super::Store;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HostRow {
    pub host_id: String,
    pub label: String,
    pub is_self: bool,
    /// Ed25519 en hexadecimal (64 caracteres), o `None` si el host nunca se verificó.
    pub public_key: Option<String>,
    pub os: Option<String>,
    pub arch: Option<String>,
    pub app_version: Option<String>,
    pub capabilities: Vec<String>,
    pub first_seen: i64,
    pub last_seen: i64,
    pub verified_at: Option<i64>,
}

/// Lo que un host cuenta de sí mismo. Nada de esto es secreto ni identifica por sí solo: la identidad es `host_id` + clave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostInfo {
    pub label: String,
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostChange {
    /// La fila nació ahora (y con ella su evento).
    Created,
    /// Un host que existía sin verificar quedó verificado: se fijó su clave (y con ella su evento).
    Verified,
    /// Solo se refrescó lo que el host cuenta de sí mismo. Sin evento.
    Refreshed,
}

const COLS: &str = "host_id, label, is_self, public_key, os, arch, app_version, capabilities, first_seen, last_seen, verified_at";

fn host_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<HostRow> {
    let is_self: i64 = r.get(2)?;
    let caps: String = r.get(7)?;
    Ok(HostRow {
        host_id: r.get(0)?,
        label: r.get(1)?,
        is_self: is_self == 1,
        public_key: r.get(3)?,
        os: r.get(4)?,
        arch: r.get(5)?,
        app_version: r.get(6)?,
        // El CHECK de la tabla garantiza un array JSON; si algo no es texto se descarta, no se inventa.
        capabilities: serde_json::from_str::<Vec<serde_json::Value>>(&caps).unwrap_or_default().into_iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        first_seen: r.get(8)?,
        last_seen: r.get(9)?,
        verified_at: r.get(10)?,
    })
}

fn get_in(c: &Connection, host_id: &str) -> StoreResult<Option<HostRow>> {
    Ok(c.query_row(&format!("SELECT {COLS} FROM hosts WHERE host_id = ?1"), [host_id], host_from_row).optional()?)
}

fn conflict<T>(message: impl Into<String>) -> StoreResult<T> {
    Err(StoreError::HostConflict(message.into()))
}

fn caps_json(info: &HostInfo) -> StoreResult<String> {
    serde_json::to_string(&info.capabilities).map_err(|e| StoreError::HostConflict(format!("capacidades no serializables: {e}")))
}

fn insert_event(tx: &Transaction<'_>, host_id: &str, event: &NewEvent) -> StoreResult<()> {
    if event.entity_kind != "host" || event.entity_id != host_id {
        return Err(StoreError::InvalidEvent(format!("{}: el evento no se refiere al host {host_id}", event.kind)));
    }
    event.check()?;
    match insert_events_projected(tx, std::slice::from_ref(event), None, None)?.first() {
        Some(Inserted::New(_)) => Ok(()),
        _ => conflict(format!("el evento {} de {host_id} ya existía: el cambio no se confirma sin su hecho", event.kind)),
    }
}

impl Store {
    /// Todos los hosts conocidos: primero el propio, luego por nombre. Un host parado sigue apareciendo.
    pub fn hosts_list(&self) -> StoreResult<Vec<HostRow>> {
        self.read(|c| {
            let mut stmt = c.prepare(&format!("SELECT {COLS} FROM hosts ORDER BY is_self DESC, lower(label), host_id"))?;
            let rows = stmt.query_map([], host_from_row)?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub fn host_get(&self, host_id: &str) -> StoreResult<Option<HostRow>> {
        self.read(|c| get_in(c, host_id))
    }

    pub fn host_self(&self) -> StoreResult<Option<HostRow>> {
        self.read(|c| Ok(c.query_row(&format!("SELECT {COLS} FROM hosts WHERE is_self = 1"), [], host_from_row).optional()?))
    }

    /// Alta o refresco del host PROPIO. `public_key` es la pública del par de claves de este Core (si el almacén seguro no está disponible,
    /// `None`: el host existe pero no puede probar quién es). Una clave ya fijada nunca se sustituye.
    pub fn host_self_record(&mut self, host_id: &str, info: &HostInfo, public_key: Option<&str>, now: i64, created: &NewEvent) -> StoreResult<(HostRow, HostChange)> {
        let caps = caps_json(info)?;
        self.write(|tx| {
            if let Some(me) = tx.query_row(&format!("SELECT {COLS} FROM hosts WHERE is_self = 1"), [], host_from_row).optional()? {
                if me.host_id != host_id {
                    return conflict(format!("este Core ya es el host {}, no {host_id}", me.host_id));
                }
                if let (Some(old), Some(new)) = (&me.public_key, public_key) {
                    if old != new {
                        return conflict(format!("el host {host_id} ya tiene otra clave fijada"));
                    }
                }
                let pin = me.public_key.is_none() && public_key.is_some();
                if let Some(key) = public_key.filter(|_| pin) {
                    check_key_free(tx, key, host_id)?;
                }
                tx.execute(
                    "UPDATE hosts SET label = ?2, os = ?3, arch = ?4, app_version = ?5, capabilities = ?6, last_seen = ?7,
                       public_key = COALESCE(public_key, ?8), verified_at = CASE WHEN ?9 THEN ?7 ELSE verified_at END
                     WHERE host_id = ?1",
                    params![host_id, info.label, info.os, info.arch, info.app_version, caps, now, public_key, pin],
                )?;
                if pin {
                    insert_event(tx, host_id, created)?;
                }
                let row = get_in(tx, host_id)?.expect("la fila acaba de actualizarse");
                return Ok((row, if pin { HostChange::Verified } else { HostChange::Refreshed }));
            }
            if get_in(tx, host_id)?.is_some() {
                return conflict(format!("{host_id} ya existe como host de otra máquina y no puede pasar a ser el propio"));
            }
            if let Some(key) = public_key {
                check_key_free(tx, key, host_id)?;
            }
            tx.execute(
                "INSERT INTO hosts (host_id, label, is_self, public_key, os, arch, app_version, capabilities, first_seen, last_seen, verified_at)
                 VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
                params![host_id, info.label, public_key, info.os, info.arch, info.app_version, caps, now, public_key.map(|_| now)],
            )?;
            insert_event(tx, host_id, created)?;
            Ok((get_in(tx, host_id)?.expect("la fila acaba de insertarse"), HostChange::Created))
        })
    }

    /// Alta o refresco de un host PAR cuya prueba de posesión ya se comprobó (`proof_at` es la hora firmada). Reglas del almacén:
    /// no puede ser el propio host ni usar su clave; un host ya verificado solo se refresca con la MISMA clave y una prueba
    /// ESTRICTAMENTE más reciente (una prueba vieja repetida no vale); una clave no puede pertenecer a dos hosts.
    pub fn host_peer_record(&mut self, host_id: &str, info: &HostInfo, public_key: &str, proof_at: i64, now: i64, created: &NewEvent) -> StoreResult<(HostRow, HostChange)> {
        let caps = caps_json(info)?;
        self.write(|tx| {
            match get_in(tx, host_id)? {
                Some(old) if old.is_self => conflict(format!("{host_id} es el host propio: un par no puede presentarse con su identidad")),
                Some(old) => {
                    match &old.public_key {
                        Some(pinned) if pinned != public_key => return conflict(format!("el host {host_id} ya tiene otra clave fijada: suplantación rechazada")),
                        _ => {}
                    }
                    if old.verified_at.is_some_and(|at| proof_at <= at) {
                        return conflict(format!("la prueba de {host_id} no es más reciente que la ya aceptada"));
                    }
                    let pin = old.public_key.is_none();
                    if pin {
                        check_key_free(tx, public_key, host_id)?;
                    }
                    tx.execute(
                        "UPDATE hosts SET label = ?2, os = ?3, arch = ?4, app_version = ?5, capabilities = ?6, last_seen = ?7,
                           public_key = COALESCE(public_key, ?8), verified_at = ?9 WHERE host_id = ?1",
                        params![host_id, info.label, info.os, info.arch, info.app_version, caps, now, public_key, proof_at],
                    )?;
                    if pin {
                        insert_event(tx, host_id, created)?;
                    }
                    Ok((get_in(tx, host_id)?.expect("la fila acaba de actualizarse"), if pin { HostChange::Verified } else { HostChange::Refreshed }))
                }
                None => {
                    check_key_free(tx, public_key, host_id)?;
                    tx.execute(
                        "INSERT INTO hosts (host_id, label, is_self, public_key, os, arch, app_version, capabilities, first_seen, last_seen, verified_at)
                         VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
                        params![host_id, info.label, public_key, info.os, info.arch, info.app_version, caps, now, proof_at],
                    )?;
                    insert_event(tx, host_id, created)?;
                    Ok((get_in(tx, host_id)?.expect("la fila acaba de insertarse"), HostChange::Created))
                }
            }
        })
    }
}

/// Una clave pública pertenece a un solo host.
fn check_key_free(tx: &Transaction<'_>, key: &str, host_id: &str) -> StoreResult<()> {
    let owner: Option<String> = tx.query_row("SELECT host_id FROM hosts WHERE public_key = ?1", [key], |r| r.get(0)).optional()?;
    match owner {
        Some(other) if other != host_id => conflict(format!("esa clave ya pertenece al host {other}")),
        _ => Ok(()),
    }
}
