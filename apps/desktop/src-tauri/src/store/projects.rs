//! Registro de proyectos (slice D de la Fase 1): lado del **almacén**.
//!
//! Solo sabe guardar y leer las filas de `projects` y `project_locations` (migración
//! `003_projects`). No conoce `orch`, ni git, ni la política de reconocimiento: qué
//! proyecto es «el mismo», cuándo se pregunta y cuándo se crea uno nuevo lo decide
//! `orch::projects`. La dirección sigue siendo `orch -> store`.
//!
//! Todas las escrituras son UNA transacción (`Store::write`). Los identificadores
//! de proyecto son UUID v7 (ordenables por creación).

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::authority::new_uuid;
use super::error::{StoreError, StoreResult};
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
    let v4 = new_uuid();
    let ts = now_ms().max(0) as u64;
    format!("{:08x}-{:04x}-7{}-{}-{}", (ts >> 16) & 0xffff_ffff, ts & 0xffff, &v4[15..18], &v4[19..23], &v4[24..])
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

impl Store {
    /// Crea un proyecto con su primera ubicación, en una sola transacción.
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

    /// Archiva o restaura. `false` si el proyecto no existe. Nada se borra: el historial queda intacto.
    pub fn project_set_archived(&mut self, id: &str, archived: bool) -> StoreResult<bool> {
        let now = now_ms();
        self.write(|tx| {
            let n = tx.execute("UPDATE projects SET state = ?2, updated_at = ?3 WHERE id = ?1", params![id, if archived { "archived" } else { "active" }, now])?;
            Ok(n == 1)
        })
    }

    pub fn project_set_fingerprint(&mut self, id: &str, fingerprint: &Fingerprint) -> StoreResult<bool> {
        let fp = fingerprint_to(fingerprint)?;
        let now = now_ms();
        self.write(|tx| Ok(tx.execute("UPDATE projects SET fingerprint = ?2, updated_at = ?3 WHERE id = ?1", params![id, fp, now])? == 1))
    }

    /// Añade o actualiza una ubicación de un proyecto que ya existe (relocalizar, otra copia).
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
        let now = now_ms();
        self.write(|tx| {
            tx.execute(
                "UPDATE project_locations SET state = ?3, last_seen = CASE WHEN ?3 = 'ok' THEN ?4 ELSE last_seen END WHERE machine = ?1 AND path = ?2",
                params![machine, path, if missing { "missing" } else { "ok" }, now],
            )?;
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
