//! Registro de proyectos (slice D de la Fase 1): lado del **almacén**.
//!
//! Solo sabe guardar y leer las filas de `projects` y `project_locations` (migración
//! `003_projects`). No conoce `orch`, ni git, ni la política de reconocimiento: qué
//! proyecto es «el mismo», cuándo se pregunta y cuándo se crea uno nuevo lo decide
//! `orch::projects`. La dirección sigue siendo `orch -> store`.
//!
//! Todas las escrituras son UNA transacción (`Store::write`). Los identificadores
//! de proyecto son UUID v7 (ordenables por creación).
//!
//! # Project + Event
//! El nacimiento de un proyecto ([`Store::project_register`]) inserta la fila `projects`, su primera
//! ubicación y su evento `project.registered` en UNA transacción (`events.state_rev = NULL`: no toca
//! `legacy_state`). Recibe el evento ya MATERIALIZADO ([`NewEvent`]): no sabe qué hechos existen ni quién
//! los provoca, solo que un fallo en cualquiera de los tres INSERT deshace los tres.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use super::authority::new_uuid_v7;
use super::error::{StoreError, StoreResult};
use super::events::{insert_events_projected, EventProjector, Inserted, NewEvent};
use super::migrate::now_ms;
use super::Store;

/// Huella de un proyecto: sirve para RECONOCERLO en otra ruta, nunca para unirlo en silencio.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fingerprint {
    /// Commits raíz (`git rev-list --max-parents=0`), ordenados.
    #[serde(default)]
    pub root_commits: Vec<String>,
    /// URLs de los remotos, normalizadas y SIN credenciales, ordenadas.
    #[serde(default)]
    pub remotes: Vec<String>,
    #[serde(default)]
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub remote_project_id: Option<String>,
    pub team_project_id: Option<String>,
    pub fingerprint: Fingerprint,
    /// Ajustes por proyecto (JSON). Hoy sin uso: los leerán slices posteriores.
    pub settings: String,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LocationRow {
    pub project_id: String,
    pub machine: String,
    /// Ruta normalizada: la clave de búsqueda.
    pub path: String,
    /// Ruta tal como la resolvió git, para mostrarla.
    pub display_path: String,
    pub last_seen: i64,
    pub primary: bool,
    pub missing: bool,
}

/// Una transición de estado de una ubicación (`missing = true` → desaparecida), ya decidida.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocationMark {
    pub machine: String,
    /// Ruta normalizada (la clave de `project_locations`).
    pub path: String,
    pub missing: bool,
}

/// Qué pasó con un cambio de gestión de un proyecto que ya existe. Solo `Changed` escribe filas y evento.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeOutcome {
    /// El proyecto no existe: no se escribió nada.
    Missing,
    /// El proyecto ya estaba como se pedía: no se escribió nada (ni siquiera `last_seen`).
    Unchanged,
    /// Cambió: filas y evento se confirmaron juntos.
    Changed,
}

/// Un cambio de huella ya DECIDIDO. `from` es la huella que quien llama leyó: la transacción comprueba que
/// sigue siendo la guardada (si no, se deshace todo) para que el hecho no describa un snapshot obsoleto.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FingerprintChange {
    pub from: Fingerprint,
    pub to: Fingerprint,
}

/// Una ubicación que se va a guardar. `path` ya viene normalizada por quien llama.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewLocation {
    pub machine: String,
    pub path: String,
    pub display_path: String,
    pub primary: bool,
}

/// UUID v7: 48 bits de milisegundos + aleatorio. Ordenable por creación.
pub fn new_project_id() -> String {
    new_uuid_v7()
}

fn fingerprint_from(text: &str) -> StoreResult<Fingerprint> {
    serde_json::from_str(text).map_err(|e| StoreError::InvalidDocument(format!("huella de proyecto ilegible: {e}")))
}

fn fingerprint_to(fp: &Fingerprint) -> StoreResult<String> {
    serde_json::to_string(fp).map_err(|e| StoreError::InvalidDocument(e.to_string()))
}

const PROJECT_COLS: &str = "id, name, created_at, updated_at, remote_project_id, team_project_id, fingerprint, settings, state";

fn project_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(ProjectRow, String)> {
    let fingerprint: String = r.get(6)?;
    let state: String = r.get(8)?;
    Ok((
        ProjectRow {
            id: r.get(0)?,
            name: r.get(1)?,
            created_at: r.get(2)?,
            updated_at: r.get(3)?,
            remote_project_id: r.get(4)?,
            team_project_id: r.get(5)?,
            fingerprint: Fingerprint::default(),
            settings: r.get(7)?,
            archived: state == "archived",
        },
        fingerprint,
    ))
}

fn finish(rows: Vec<(ProjectRow, String)>) -> StoreResult<Vec<ProjectRow>> {
    rows.into_iter()
        .map(|(mut p, fp)| {
            p.fingerprint = fingerprint_from(&fp)?;
            Ok(p)
        })
        .collect()
}

fn location_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<LocationRow> {
    let primary: i64 = r.get(5)?;
    let state: String = r.get(6)?;
    Ok(LocationRow { project_id: r.get(0)?, machine: r.get(1)?, path: r.get(2)?, display_path: r.get(3)?, last_seen: r.get(4)?, primary: primary == 1, missing: state == "missing" })
}

const LOCATION_COLS: &str = "project_id, machine, path, display_path, last_seen, is_primary, state";

/// Inserta o actualiza una ubicación. Si es la principal, quita la marca a las demás
/// del mismo proyecto y máquina. Una ruta ya registrada para OTRO proyecto es un conflicto.
fn put_location(tx: &Connection, project_id: &str, loc: &NewLocation, now: i64) -> StoreResult<()> {
    let owner: Option<String> =
        tx.query_row("SELECT project_id FROM project_locations WHERE machine = ?1 AND path = ?2", params![loc.machine, loc.path], |r| r.get(0)).optional()?;
    if let Some(owner) = owner.filter(|o| o != project_id) {
        return Err(StoreError::ProjectConflict(format!("la ruta {} ya pertenece al proyecto {owner}", loc.display_path)));
    }
    if loc.primary {
        tx.execute("UPDATE project_locations SET is_primary = 0 WHERE project_id = ?1 AND machine = ?2 AND path <> ?3", params![project_id, loc.machine, loc.path])?;
    }
    tx.execute(
        "INSERT INTO project_locations (project_id, machine, path, display_path, last_seen, is_primary, state)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ok')
         ON CONFLICT (machine, path) DO UPDATE SET display_path = excluded.display_path, last_seen = excluded.last_seen, is_primary = excluded.is_primary, state = 'ok'",
        params![project_id, loc.machine, loc.path, loc.display_path, now, loc.primary as i64],
    )?;
    Ok(())
}

/// El evento de un cambio de gestión: se refiere a este proyecto y está bien formado.
fn check_event_for(id: &str, event: &NewEvent) -> StoreResult<()> {
    if event.project_id.as_deref() != Some(id) {
        return Err(StoreError::InvalidEvent(format!("{}: el evento no se refiere al proyecto {id}", event.kind)));
    }
    event.check()
}

/// Inserta el evento del cambio: un duplicado por `(kind, idem_key)` deshace el cambio en lugar de dejarlo sin su hecho.
fn insert_one_event(tx: &Transaction<'_>, id: &str, event: &NewEvent, projector: Option<&dyn EventProjector>) -> StoreResult<()> {
    match insert_events_projected(tx, std::slice::from_ref(event), None, projector)?.first() {
        Some(Inserted::New(_)) => Ok(()),
        _ => Err(StoreError::ProjectConflict(format!("el evento {} de {id} ya existía: el cambio no se confirma sin su hecho", event.kind))),
    }
}

/// Núcleo común de `join` y `relocate`: ubicación + posible cambio de huella + evento, DENTRO de la transacción
/// de quien llama.
fn apply_location(tx: &Transaction<'_>, id: &str, loc: &NewLocation, fp: Option<&FingerprintChange>, event: &NewEvent, guard_primary: bool, now: i64, projector: Option<&dyn EventProjector>) -> StoreResult<ChangeOutcome> {
    let current: Option<String> = tx.query_row("SELECT fingerprint FROM projects WHERE id = ?1", [id], |r| r.get(0)).optional()?;
    let Some(current) = current else { return Ok(ChangeOutcome::Missing) };
    // Snapshot: la huella que quien llama leyó sigue siendo la guardada.
    if let Some(c) = fp {
        if fingerprint_from(&current)? != c.from {
            return Err(StoreError::ProjectConflict(format!("la huella del proyecto {id} cambió desde que se leyó")));
        }
    }
    // Snapshot: la ubicación nueva es la principal si y solo si el proyecto no tenía ninguna principal viva EN ESA
    // MÁQUINA (la principal es por `(project_id, machine)`; la de otra máquina no cuenta).
    if guard_primary {
        let vivas: i64 = tx.query_row(
            "SELECT COUNT(*) FROM project_locations WHERE project_id = ?1 AND machine = ?2 AND is_primary = 1 AND state <> 'missing'",
            params![id, loc.machine],
            |r| r.get(0),
        )?;
        if loc.primary != (vivas == 0) {
            return Err(StoreError::ProjectConflict(format!("las ubicaciones del proyecto {id} cambiaron desde que se leyeron")));
        }
    }
    let existing: Option<(String, String, i64, String)> = tx
        .query_row(
            "SELECT project_id, display_path, is_primary, state FROM project_locations WHERE machine = ?1 AND path = ?2",
            params![loc.machine, loc.path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    if let Some((owner, display, primary, state)) = &existing {
        if owner != id {
            return Err(StoreError::ProjectConflict(format!("la ruta {} ya pertenece al proyecto {owner}", loc.display_path)));
        }
        if fp.is_none() && *display == loc.display_path && (*primary == 1) == loc.primary && state == "ok" {
            return Ok(ChangeOutcome::Unchanged);
        }
    }
    put_location(tx, id, loc, now)?;
    if let Some(c) = fp {
        let n = tx.execute("UPDATE projects SET fingerprint = ?2, updated_at = ?3 WHERE id = ?1", params![id, fingerprint_to(&c.to)?, now])?;
        if n != 1 {
            return Err(StoreError::ProjectConflict(format!("no se pudo actualizar la huella del proyecto {id}")));
        }
    }
    insert_one_event(tx, id, event, projector)?;
    Ok(ChangeOutcome::Changed)
}

impl Store {
    /// Nace un proyecto: fila + primera ubicación + su evento, en UNA transacción (`BEGIN IMMEDIATE`).
    ///
    /// * `id` lo genera quien llama FUERA de la transacción y es el mismo del evento (`event.project_id`).
    /// * Un fallo en cualquiera de los tres INSERT (la fila, la ubicación —incluida una ruta que ya es de
    ///   otro proyecto— o el evento) lo deshace todo: ni proyecto huérfano de evento ni evento huérfano de
    ///   proyecto.
    /// * El evento de un proyecto que NACE no puede ser un duplicado: si su `(kind, idem_key)` ya existía, es
    ///   una inconsistencia y se deshace en lugar de crear el proyecto sin su hecho.
    pub fn project_register(&mut self, id: &str, name: &str, fingerprint: &Fingerprint, loc: &NewLocation, event: &NewEvent) -> StoreResult<ProjectRow> {
        check_event_for(id, event)?;
        let fp = fingerprint_to(fingerprint)?;
        let now = now_ms();
        let projector = self.projector.clone();
        self.write(|tx| {
            tx.execute("INSERT INTO projects (id, name, created_at, updated_at, fingerprint) VALUES (?1, ?2, ?3, ?3, ?4)", params![id, name, now, fp])?;
            put_location(tx, id, &NewLocation { primary: true, ..loc.clone() }, now)?;
            insert_one_event(tx, id, event, projector.as_deref())
        })?;
        self.project(id)?.ok_or_else(|| StoreError::ProjectConflict(format!("el proyecto recién registrado {id} no existe")))
    }

    /// `join`: añade una ubicación a un proyecto que YA existía, con el cambio de huella que lo acompañe y su
    /// evento, en UNA transacción. Nunca queda «ubicación nueva + huella vieja» ni «cambios sin evento».
    /// `loc.primary` debe ser lo que el proyecto admite (no había otra principal viva); si no, se deshace todo.
    /// Una ruta que ya es de OTRO proyecto es `ProjectConflict`.
    pub fn project_join_recorded(&mut self, id: &str, loc: &NewLocation, fingerprint: Option<&FingerprintChange>, event: &NewEvent) -> StoreResult<ChangeOutcome> {
        check_event_for(id, event)?;
        let now = now_ms();
        let projector = self.projector.clone();
        self.write(|tx| apply_location(tx, id, loc, fingerprint, event, true, now, projector.as_deref()))
    }

    /// `relocate`: la ubicación nueva pasa a ser la principal; igual que [`Store::project_join_recorded`]
    /// (ubicación + posible huella + evento atómicos), sin la guarda de «principal viva».
    pub fn project_relocate_recorded(&mut self, id: &str, loc: &NewLocation, fingerprint: Option<&FingerprintChange>, event: &NewEvent) -> StoreResult<ChangeOutcome> {
        check_event_for(id, event)?;
        if !loc.primary {
            return Err(StoreError::InvalidEvent("relocate: la ubicación nueva es la principal".into()));
        }
        let now = now_ms();
        let projector = self.projector.clone();
        self.write(|tx| apply_location(tx, id, loc, fingerprint, event, false, now, projector.as_deref()))
    }

    /// Archiva o restaura. Distingue `Missing` / `Unchanged` / `Changed` ATÓMICAMENTE (el `UPDATE` solo toca la
    /// fila si el estado cambia) y solo `Changed` escribe el evento. Nada se borra: el historial queda intacto.
    pub fn project_set_archived_recorded(&mut self, id: &str, archived: bool, event: &NewEvent) -> StoreResult<ChangeOutcome> {
        check_event_for(id, event)?;
        let (state, now) = (if archived { "archived" } else { "active" }, now_ms());
        let projector = self.projector.clone();
        self.write(|tx| {
            let n = tx.execute("UPDATE projects SET state = ?2, updated_at = ?3 WHERE id = ?1 AND state <> ?2", params![id, state, now])?;
            if n == 1 {
                insert_one_event(tx, id, event, projector.as_deref())?;
                return Ok(ChangeOutcome::Changed);
            }
            let exists: i64 = tx.query_row("SELECT COUNT(*) FROM projects WHERE id = ?1", [id], |r| r.get(0))?;
            Ok(if exists == 1 { ChangeOutcome::Unchanged } else { ChangeOutcome::Missing })
        })
    }

    /// Prueba: crea un proyecto SIN evento (fixture de las pruebas del almacén). Producción registra con
    /// [`Store::project_register`], que no separa la fila de su hecho.
    #[cfg(test)]
    pub fn project_create(&mut self, name: &str, fingerprint: &Fingerprint, loc: &NewLocation) -> StoreResult<ProjectRow> {
        let id = new_project_id();
        let fp = fingerprint_to(fingerprint)?;
        let now = now_ms();
        self.write(|tx| {
            tx.execute(
                "INSERT INTO projects (id, name, created_at, updated_at, fingerprint) VALUES (?1, ?2, ?3, ?3, ?4)",
                params![id, name, now, fp],
            )?;
            put_location(tx, &id, &NewLocation { primary: true, ..loc.clone() }, now)?;
            Ok(())
        })?;
        Ok(self.project(&id)?.expect("el proyecto recién creado existe"))
    }

    pub fn project(&self, id: &str) -> StoreResult<Option<ProjectRow>> {
        self.read(|c| {
            let row = c.query_row(&format!("SELECT {PROJECT_COLS} FROM projects WHERE id = ?1"), [id], project_from_row).optional()?;
            Ok(finish(row.into_iter().collect())?.pop())
        })
    }

    /// Todos los proyectos, del más antiguo al más nuevo.
    pub fn projects(&self, include_archived: bool) -> StoreResult<Vec<ProjectRow>> {
        self.read(|c| {
            let sql = format!("SELECT {PROJECT_COLS} FROM projects {} ORDER BY created_at, id", if include_archived { "" } else { "WHERE state = 'active'" });
            let rows = c.prepare(&sql)?.query_map([], project_from_row)?.collect::<Result<Vec<_>, _>>()?;
            finish(rows)
        })
    }

    /// Ubicaciones de un proyecto, o de todos si `project_id` es `None`.
    pub fn project_locations(&self, project_id: Option<&str>) -> StoreResult<Vec<LocationRow>> {
        self.read(|c| {
            let rows = match project_id {
                Some(id) => c
                    .prepare(&format!("SELECT {LOCATION_COLS} FROM project_locations WHERE project_id = ?1 ORDER BY is_primary DESC, path"))?
                    .query_map([id], location_from_row)?
                    .collect::<Result<Vec<_>, _>>()?,
                None => c
                    .prepare(&format!("SELECT {LOCATION_COLS} FROM project_locations ORDER BY project_id, is_primary DESC, path"))?
                    .query_map([], location_from_row)?
                    .collect::<Result<Vec<_>, _>>()?,
            };
            Ok(rows)
        })
    }

    /// El proyecto dueño de una ruta (ya normalizada) en esta máquina.
    pub fn project_by_location(&self, machine: &str, path: &str) -> StoreResult<Option<String>> {
        self.read(|c| Ok(c.query_row("SELECT project_id FROM project_locations WHERE machine = ?1 AND path = ?2", params![machine, path], |r| r.get(0)).optional()?))
    }

    /// Proyectos (incluidos los archivados) que comparten al menos un commit raíz con `commits`.
    pub fn projects_sharing_root_commit(&self, commits: &[String]) -> StoreResult<Vec<String>> {
        if commits.is_empty() {
            return Ok(vec![]);
        }
        self.read(|c| {
            let mut found: Vec<String> = Vec::new();
            let mut stmt = c.prepare("SELECT DISTINCT p.id FROM projects p, json_each(p.fingerprint, '$.root_commits') j WHERE j.value = ?1")?;
            for commit in commits {
                for id in stmt.query_map([commit], |r| r.get::<_, String>(0))? {
                    let id = id?;
                    if !found.contains(&id) {
                        found.push(id);
                    }
                }
            }
            found.sort();
            Ok(found)
        })
    }

    /// Prueba: archiva o restaura SIN evento (fixture). Producción usa [`Store::project_set_archived_recorded`].
    #[cfg(test)]
    pub fn project_set_archived(&mut self, id: &str, archived: bool) -> StoreResult<bool> {
        let now = now_ms();
        self.write(|tx| {
            let n = tx.execute("UPDATE projects SET state = ?2, updated_at = ?3 WHERE id = ?1", params![id, if archived { "archived" } else { "active" }, now])?;
            Ok(n == 1)
        })
    }

    /// Prueba: cambia la huella SIN evento (fixture). Producción la cambia dentro de una transacción con su hecho.
    #[cfg(test)]
    pub fn project_set_fingerprint(&mut self, id: &str, fingerprint: &Fingerprint) -> StoreResult<bool> {
        let fp = fingerprint_to(fingerprint)?;
        let now = now_ms();
        self.write(|tx| Ok(tx.execute("UPDATE projects SET fingerprint = ?2, updated_at = ?3 WHERE id = ?1", params![id, fp, now])? == 1))
    }

    /// Prueba: añade o actualiza una ubicación SIN evento (fixture). Producción usa
    /// [`Store::project_join_recorded`] y [`Store::project_relocate_recorded`].
    #[cfg(test)]
    pub fn location_put(&mut self, project_id: &str, loc: &NewLocation) -> StoreResult<()> {
        let now = now_ms();
        self.write(|tx| {
            let exists: i64 = tx.query_row("SELECT COUNT(*) FROM projects WHERE id = ?1", [project_id], |r| r.get(0))?;
            if exists == 0 {
                return Err(StoreError::ProjectConflict(format!("no existe el proyecto {project_id}")));
            }
            put_location(tx, project_id, loc, now)
        })
    }

    /// Marca una ubicación como presente o desaparecida y anota cuándo se comprobó.
    pub fn location_mark(&mut self, machine: &str, path: &str, missing: bool) -> StoreResult<()> {
        self.locations_mark(&[LocationMark { machine: machine.into(), path: path.into(), missing }])
    }

    /// Persiste varias transiciones `ok <-> missing` en UNA transacción. Quien llama las calcula
    /// FUERA del almacén (mirar el disco puede tardar) y entra aquí solo para guardarlas. Si una
    /// ubicación ya no existe en la base (se relocalizó entretanto) esa fila simplemente no cambia.
    pub fn locations_mark(&mut self, marks: &[LocationMark]) -> StoreResult<()> {
        if marks.is_empty() {
            return Ok(());
        }
        let now = now_ms();
        self.write(|tx| {
            for m in marks {
                tx.execute(
                    "UPDATE project_locations SET state = ?3, last_seen = CASE WHEN ?3 = 'ok' THEN ?4 ELSE last_seen END WHERE machine = ?1 AND path = ?2",
                    params![m.machine, m.path, if m.missing { "missing" } else { "ok" }, now],
                )?;
            }
            Ok(())
        })
    }

    /// Escribe una clave de `meta` (marcas de idempotencia del relleno y la importación).
    pub fn meta_set(&mut self, key: &str, value: &str) -> StoreResult<()> {
        self.write(|tx| {
            tx.execute("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])?;
            Ok(())
        })
    }
}
