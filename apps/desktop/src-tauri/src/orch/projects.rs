//! Registro de proyectos del Core (slice D de la Fase 1): identidad lógica de un proyecto frente a
//! su ubicación en esta máquina (`Project` / `ProjectLocation`, modelo §6).
//!
//! # Qué hace y qué NO hace
//! * **Reconoce** un repositorio: ruta normalizada → checkout PRINCIPAL (`git worktree list`, así un
//!   worktree `<repo>.lixbon-wt/…` pertenece al mismo proyecto que su repo) → huella
//!   (commits raíz, remotos sin credenciales, rama por defecto).
//! * **Nunca une en silencio.** Una coincidencia por huella en OTRA ruta se devuelve como
//!   `needs_confirmation`; solo una confirmación explícita (`join`) o la misma ruta unen. Un fork
//!   comparte commits raíz con su origen: si ambos tienen remotos y no coinciden, son proyectos
//!   distintos; un clon sin remoto siempre pregunta.
//! * **Quién registra.** Un repositorio INEQUÍVOCAMENTE nuevo (ninguna coincidencia de huella) se
//!   descubre y registra solo, sin preguntar: en `run_create`, en el relleno de tareas y al volver a
//!   ver la misma ruta. Las decisiones de identidad ambiguas y las operaciones explícitas de gestión
//!   son de la persona: `join`, resolver una ambigüedad, un `project_locate` forzado, archivar o
//!   restaurar y la importación explícita desde la interfaz (`Caller::User`). La garantía central es
//!   que Lixbon **nunca une dos identidades ambiguas en silencio**.
//! * **Cada nacimiento deja su hecho.** Un proyecto que NACE (manual, automático, relleno, importación)
//!   emite `project.registered` en la misma transacción que su fila (`project_ops.rs`). Encontrar uno
//!   existente o una ambigüedad no emiten nada.
//! * **Cada decisión de gestión deja su hecho.** `join` (`project.location_added`), archivar/restaurar
//!   (`project.archived` / `project.restored`) y `project_locate` (`project.relocated`) cambian TODAS sus
//!   filas y escriben su evento en UNA transacción (`Store::project_*_recorded`); solo un cambio real deja
//!   evento. Las toma una persona por la interfaz (`person/ui`).
//! * **No escribe en ningún repositorio.** Solo ejecuta git de lectura; el registro vive en SQLite
//!   (migración 003).
//! * **No decide el modelo definitivo de Task/Attempt:** solo añade `Task.project_id`
//!   (`serde(default)`), que se rellena por la frontera `mutate`.
//!
//! # Fronteras
//! La política (qué es «el mismo proyecto», cuándo se pregunta) vive aquí; el almacén
//! (`store::projects`) solo guarda filas y no conoce git ni `orch`. **Ninguna E/S externa corre con
//! el mutex del almacén tomado** (ni `git`, ni `Path::exists`, ni nada del sistema de archivos): el
//! almacén es uno para todo el Core y también lo usa la persistencia del estado. El ciclo es siempre
//! leer (SQL) → comprobar fuera → persistir (SQL); una prueba escanea este archivo para impedirlo.
//!
//! # Lecturas y escrituras (frontera explícita)
//! * [`Core::registry_read`] / [`Core::registry_read_opt`] reciben un `&Store`: el compilador impide
//!   escribir desde una lectura. **Una lectura nunca escribe**, tampoco el `machine_id` (si aún no
//!   existe, no hay ubicaciones suyas en esta máquina).
//! * [`Core::registry_write`] / [`Core::registry_write_opt`] son el ÚNICO camino de escritura y respetan
//!   `Health`: con el Core en `DegradedReadOnly` rechazan sin tocar el almacén (ninguna creación,
//!   ubicación, marca, relleno ni importación). Las lecturas siguen funcionando.
//! * El nacimiento de un proyecto es siempre Project + primera ubicación + `project.registered` en UNA
//!   transacción: lo hace `project_ops::register_project`, el único que construye esos hechos.

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::events::MutationContext;
use super::mutation::Health;
use super::project_ops::{join_project, register_project, relocate_project, set_archived, Management, ProjectOrigin, Registration};
use super::state::now_ms;
use super::{b, git, s, Core};
use crate::store::{new_uuid, ChangeOutcome, Fingerprint, LocationMark, LocationRow, NewLocation, ProjectRow, Store, StoreResult};

/// Presupuesto de tiempo del relleno de `project_id` al arrancar (se retoma en el siguiente arranque).
pub(super) const BACKFILL_BUDGET: Duration = Duration::from_secs(4);
/// Tope de rutas que acepta la importación de recientes.
const MAX_RECENTS: usize = 32;

/// MARCA DIAGNÓSTICA: «hubo al menos una pasada de relleno que llegó hasta el final». El relleno NO
/// la consulta ni se salta pasadas por ella: cada arranque vuelve a procesar las tareas que sigan sin
/// proyecto (las ambiguas y los repositorios que reaparezcan después entrarían si no).
const META_BACKFILLED: &str = "projects_backfilled";
const META_RECENTS: &str = "projects_recents_imported";
const META_MACHINE: &str = "machine_id";

// ---------------------------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------------------------

/// Clave de búsqueda de una ruta: separadores `/`, sin `\\?\`, sin barra final y, en Windows (donde
/// el sistema de archivos no distingue mayúsculas), en minúsculas.
pub(super) fn norm_path_for(p: &str, windows: bool) -> String {
    let p = p.trim().trim_start_matches(r"\\?\").replace('\\', "/");
    let p = p.trim_end_matches('/');
    if windows { p.to_ascii_lowercase() } else { p.to_string() }
}

pub(super) fn norm_path(p: &str) -> String {
    norm_path_for(p, cfg!(windows))
}

// ---------------------------------------------------------------------------------------------
// Identidad (usa git; sin tocar el almacén)
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(super) struct Identity {
    /// Raíz del checkout principal, como la dio git (para mostrar).
    pub root: String,
    /// Raíz normalizada: la clave de la ubicación.
    pub key: String,
    pub name: String,
    pub fingerprint: Fingerprint,
}

pub(super) fn identify(path: &str) -> Result<Identity, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("Falta la ruta del proyecto".into());
    }
    if !Path::new(p).is_dir() {
        return Err(format!("La carpeta {p} no existe"));
    }
    let root = git::main_root(p).ok_or_else(|| format!("{p} no está dentro de un repositorio git con checkout: un proyecto de Lixbon es un repositorio"))?;
    let fingerprint = Fingerprint { root_commits: git::root_commits(&root), remotes: git::remotes(&root), default_branch: git::default_branch(&root) };
    let name = Path::new(&root).file_name().map(|n| n.to_string_lossy().into_owned()).filter(|n| !n.is_empty()).unwrap_or_else(|| "proyecto".into());
    Ok(Identity { key: norm_path(&root), root, name, fingerprint })
}

// ---------------------------------------------------------------------------------------------
// Reconocimiento (política pura)
// ---------------------------------------------------------------------------------------------

fn intersects(a: &[String], b: &[String]) -> bool {
    a.iter().any(|x| b.contains(x))
}

/// ¿Puede ser el mismo proyecto? Comparten algún commit raíz Y (los remotos coinciden, o alguno de
/// los dos no tiene remoto: sin remoto no hay forma de distinguir un clon de un fork).
/// Dos huellas con remotos distintos y sin ninguno en común (un fork) NO son candidatas.
pub(super) fn compatible(new: &Fingerprint, old: &Fingerprint) -> bool {
    intersects(&new.root_commits, &old.root_commits) && (new.remotes.is_empty() || old.remotes.is_empty() || intersects(&new.remotes, &old.remotes))
}

#[derive(Debug, Clone)]
pub(super) struct Candidate {
    pub project: ProjectRow,
    pub locations: Vec<LocationRow>,
}

impl Candidate {
    /// Por qué se pregunta: `mismo_remoto`, `sin_remoto` (no se puede distinguir de un fork) o
    /// `ubicacion_desaparecida` (probablemente el repositorio se movió).
    fn reason(&self, new: &Fingerprint) -> &'static str {
        if !self.locations.is_empty() && self.locations.iter().all(|l| l.missing) {
            "ubicacion_desaparecida"
        } else if new.remotes.is_empty() || self.project.fingerprint.remotes.is_empty() {
            "sin_remoto"
        } else {
            "mismo_remoto"
        }
    }

    fn json(&self, new: &Fingerprint) -> Value {
        json!({
            "project_id": self.project.id,
            "name": self.project.name,
            "state": if self.project.archived { "archived" } else { "active" },
            "reason": self.reason(new),
            "locations": self.locations.iter().map(location_json).collect::<Vec<_>>(),
        })
    }
}

enum Lookup {
    /// La ruta ya estaba registrada.
    ByPath(String),
    /// Hay proyectos que podrían ser el mismo: HAY QUE PREGUNTAR.
    Candidates(Vec<Candidate>),
    None,
}

fn lookup(store: &Store, machine: &str, ident: &Identity) -> StoreResult<Lookup> {
    if let Some(id) = store.project_by_location(machine, &ident.key)? {
        return Ok(Lookup::ByPath(id));
    }
    let mut cands = vec![];
    for id in store.projects_sharing_root_commit(&ident.fingerprint.root_commits)? {
        let Some(project) = store.project(&id)? else { continue };
        if compatible(&ident.fingerprint, &project.fingerprint) {
            cands.push(Candidate { locations: store.project_locations(Some(&id))?, project });
        }
    }
    Ok(if cands.is_empty() { Lookup::None } else { Lookup::Candidates(cands) })
}

/// Identificador estable de esta máquina para `project_locations.machine`, SOLO LECTURA: `None` si aún no
/// se creó (entonces esta máquina no tiene ubicaciones registradas). Las lecturas usan esta; así una
/// consulta con el Core degradado no puede crear una fila de `meta`.
pub(super) fn machine_id_read(store: &Store) -> StoreResult<Option<String>> {
    store.meta(META_MACHINE)
}

/// El mismo identificador, creándolo la primera vez. SOLO desde un closure de escritura
/// ([`Core::registry_write`]), que ya respeta `Health`.
fn machine_id_ensure(store: &mut Store) -> StoreResult<String> {
    if let Some(m) = machine_id_read(store)? {
        return Ok(m);
    }
    let m = new_uuid();
    store.meta_set(META_MACHINE, &m)?;
    Ok(m)
}

fn location_json(l: &LocationRow) -> Value {
    json!({ "path": l.display_path, "primary": l.primary, "state": if l.missing { "missing" } else { "ok" }, "last_seen": l.last_seen })
}

fn project_json(p: &ProjectRow, locs: &[LocationRow], tasks: usize) -> Value {
    json!({
        "id": p.id,
        "name": p.name,
        "state": if p.archived { "archived" } else { "active" },
        "created_at": p.created_at,
        "fingerprint": p.fingerprint,
        "locations": locs.iter().map(location_json).collect::<Vec<_>>(),
        "tasks": tasks,
    })
}

/// ¿La ubicación nueva debe ser la principal de ESTA máquina? Sí si el proyecto no tiene ya una principal viva
/// en ella. La principal es por `(project_id, machine)` (índice único de la migración 003): la de otra máquina
/// no cuenta, y la primera ubicación de una máquina nueva es su principal.
fn becomes_primary(existing: &[LocationRow], machine: &str) -> bool {
    !existing.iter().any(|l| l.machine == machine && l.primary && !l.missing)
}

// ---------------------------------------------------------------------------------------------
// Estado de las ubicaciones en disco: leer -> comprobar FUERA del almacén -> persistir
// ---------------------------------------------------------------------------------------------
//
// Mirar el disco puede tardar (una ruta de red, un UNC, un volumen dormido). El almacén es UNO para
// todo el Core: su mutex lo usa también `SqlitePersistence` para guardar el estado. Por eso ninguna
// comprobación de disco, `git` ni proceso externo corre dentro de un closure de `registry`:
//
//   1. `registry`: se LEEN proyectos y ubicaciones (solo SQL) y se suelta el almacén;
//   2. FUERA del almacén: `exists_on_disk` y la función pura `transitions`;
//   3. `registry` de nuevo, solo para PERSISTIR las transiciones `ok <-> missing`.
//
// La prueba `el_registro_no_hace_io_externo_bajo_el_bloqueo_del_almacen` escanea este archivo y
// falla si alguien mete I/O externo dentro de uno de esos closures.

/// ÚNICO sitio donde se mira el disco para decidir si una ubicación existe. Nunca bajo el almacén.
fn exists_on_disk(path: &str) -> bool {
    Path::new(path).exists()
}

/// Transiciones `ok <-> missing` que hay que persistir. Pura: no toca el disco ni el almacén.
fn transitions<'a>(locs: impl IntoIterator<Item = &'a LocationRow>, exists: impl Fn(&str) -> bool) -> Vec<LocationMark> {
    locs.into_iter()
        .filter_map(|l| {
            let missing_now = !exists(&l.display_path);
            (missing_now != l.missing).then(|| LocationMark { machine: l.machine.clone(), path: l.path.clone(), missing: missing_now })
        })
        .collect()
}

/// Refleja en memoria las transiciones ya calculadas (para devolver el estado real al llamador).
fn apply_transitions(locs: &mut [LocationRow], marks: &[LocationMark]) {
    for l in locs.iter_mut() {
        if let Some(m) = marks.iter().find(|m| m.machine == l.machine && m.path == l.path) {
            l.missing = m.missing;
        }
    }
}

type Counts = std::collections::HashMap<String, usize>;

const REGISTRY_CLOSED: &str = "El registro de proyectos no está disponible: el almacén del Core no está abierto";

impl Core {
    /// LECTURA del registro. `Ok(None)` = el almacén no está abierto (modo degradado): el registro es
    /// ADITIVO y quien llama decide si eso importa. `Err` = el almacén está abierto y la consulta
    /// falló: eso NO se esconde. El closure corre con el mutex del almacén tomado: solo SQL, y solo
    /// recibe `&Store`: no puede escribir.
    fn registry_read_opt<R>(&self, f: impl FnOnce(&Store) -> StoreResult<R>) -> Result<Option<R>, String> {
        match self.storage.with_store(|st| f(st)) {
            Some(Ok(r)) => Ok(Some(r)),
            Some(Err(e)) => Err(e.to_string()),
            None => Ok(None),
        }
    }

    /// Como [`Core::registry_read_opt`], pero un almacén cerrado es un error claro.
    fn registry_read<R>(&self, f: impl FnOnce(&Store) -> StoreResult<R>) -> Result<R, String> {
        self.registry_read_opt(f)?.ok_or_else(|| REGISTRY_CLOSED.to_string())
    }

    /// El registro admite escrituras solo con el Core en salud normal. Un `DegradedReadOnly` (fallo del
    /// almacenamiento) rechaza toda creación, ubicación, marca, relleno o importación SIN abrir ninguna
    /// transacción; las lecturas no pasan por aquí.
    fn require_registry_writable(&self) -> Result<(), String> {
        match self.health() {
            Health::Normal => Ok(()),
            Health::DegradedReadOnly(why) => Err(format!("El Core está en solo lectura ({why}): el registro de proyectos no admite escrituras hasta que se recupere el almacenamiento")),
        }
    }

    /// ESCRITURA del registro, con las mismas reglas que [`Core::registry_read_opt`] para un almacén
    /// cerrado (`Ok(None)`), pero ANTES de nada comprueba la salud del Core.
    fn registry_write_opt<R>(&self, f: impl FnOnce(&mut Store) -> StoreResult<R>) -> Result<Option<R>, String> {
        self.require_registry_writable()?;
        match self.storage.with_store(f) {
            Some(Ok(r)) => Ok(Some(r)),
            Some(Err(e)) => Err(e.to_string()),
            None => Ok(None),
        }
    }

    /// Como [`Core::registry_write_opt`], pero un almacén cerrado es un error claro.
    fn registry_write<R>(&self, f: impl FnOnce(&mut Store) -> StoreResult<R>) -> Result<R, String> {
        self.registry_write_opt(f)?.ok_or_else(|| REGISTRY_CLOSED.to_string())
    }

    /// Paso 3 del ciclo leer -> comprobar -> persistir: guarda las transiciones, en una transacción. Con
    /// el Core degradado las transiciones solo existen en memoria: el llamador ya las aplicó a lo que
    /// devuelve y no se escribe ninguna marca.
    fn persist_marks(&self, marks: &[LocationMark]) -> Result<(), String> {
        if marks.is_empty() || self.require_registry_writable().is_err() {
            return Ok(());
        }
        self.registry_write(|st| st.locations_mark(marks))
    }

    fn tasks_per_project(&self) -> (Counts, usize) {
        let st = self.lock();
        let mut by: Counts = Default::default();
        let mut sin = 0;
        for t in st.tasks.values() {
            match &t.project_id {
                Some(id) => *by.entry(id.clone()).or_default() += 1,
                None => sin += 1,
            }
        }
        (by, sin)
    }

    // -----------------------------------------------------------------------------------------
    // Lectura
    // -----------------------------------------------------------------------------------------

    /// Lista de proyectos con sus ubicaciones. Al listar se COMPRUEBA el disco: una ubicación cuya
    /// carpeta ya no existe pasa a `missing` (y vuelve a `ok` si reaparece). Ciclo leer -> comprobar
    /// FUERA del almacén -> persistir solo las transiciones.
    pub(super) fn projects_list(&self, include_archived: bool) -> Result<Value, String> {
        let (counts, unassigned) = self.tasks_per_project();
        // 1. Leer (solo SQL).
        let mut rows = self.registry_read(|st| {
            let mut out = vec![];
            for p in st.projects(include_archived)? {
                let locs = st.project_locations(Some(&p.id))?;
                out.push((p, locs));
            }
            Ok(out)
        })?;
        // 2. Comprobar el disco, con el almacén ya suelto.
        let marks = transitions(rows.iter().flat_map(|(_, l)| l.iter()), exists_on_disk);
        // 3. Persistir solo lo que cambió (con el Core degradado, solo en memoria).
        self.persist_marks(&marks)?;
        for (_, locs) in rows.iter_mut() {
            apply_transitions(locs, &marks);
        }
        Ok(json!({
            "projects": rows.iter().map(|(p, l)| project_json(p, l, counts.get(&p.id).copied().unwrap_or(0))).collect::<Vec<_>>(),
            "unassigned_tasks": unassigned,
        }))
    }

    // -----------------------------------------------------------------------------------------
    // Registro
    // -----------------------------------------------------------------------------------------

    /// El proyecto ya registrado, para devolverlo. `counts` se calcula ANTES de entrar al registro:
    /// el orden de bloqueo es siempre estado -> almacén (como `mutate`), nunca al revés.
    fn registered(st: &Store, id: &str, created: bool, counts: &Counts) -> StoreResult<Value> {
        let p = st.project(id)?.expect("el proyecto existe");
        let locs = st.project_locations(Some(id))?;
        Ok(json!({ "status": "registered", "created": created, "project": project_json(&p, &locs, counts.get(id).copied().unwrap_or(0)) }))
    }

    /// `project_add {path, name?, join?: <project_id>, new?: bool}`.
    ///
    /// Misma ruta (o un worktree del mismo repo) → ese proyecto. Otra ruta que coincide por huella →
    /// `needs_confirmation` con los candidatos; se resuelve repitiendo con `join` (es el mismo
    /// proyecto: nueva ubicación) o `new` (es otro). Sin coincidencias → proyecto nuevo.
    ///
    /// Un proyecto NUEVO emite `project.registered` (origen `manual`, person/ui) en la misma transacción que su
    /// fila y su ubicación. Un `join` emite `project.location_added` en la misma transacción que la ubicación y
    /// el posible cambio de huella. Misma ruta y ambigüedad no emiten nada.
    pub(super) fn project_add(&self, ctx: &MutationContext, args: &Value) -> Result<Value, String> {
        self.require_registry_writable()?;
        let reg = Registration::new(ProjectOrigin::Manual, ctx)?;
        let mgmt = Management::new(ctx)?;
        let ident = identify(&s(args, "path"))?;
        let name = Some(s(args, "name")).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| ident.name.clone());
        let (join, force_new) = (s(args, "join"), b(args, "new"));
        let counts = self.tasks_per_project().0;
        self.registry_write(|st| {
            let machine = machine_id_ensure(st)?;
            let new_project = |st: &mut Store| -> StoreResult<Value> {
                let loc = NewLocation { machine: machine.clone(), path: ident.key.clone(), display_path: ident.root.clone(), primary: true };
                let p = register_project(st, &name, &ident.fingerprint, &loc, &reg)?;
                Self::registered(st, &p.id, true, &counts)
            };
            match lookup(st, &machine, &ident)? {
                Lookup::ByPath(id) => Self::registered(st, &id, false, &counts),
                Lookup::Candidates(cands) => {
                    if !join.is_empty() {
                        let Some(c) = cands.iter().find(|c| c.project.id == join) else {
                            return Ok(json!({ "status": "error", "error": format!("El proyecto {join} no coincide con este repositorio (commits raíz o remotos distintos). Para forzar otra ubicación usa project_locate") }));
                        };
                        let primary = becomes_primary(&c.locations, &machine);
                        let loc = NewLocation { machine: machine.clone(), path: ident.key.clone(), display_path: ident.root.clone(), primary };
                        // Un proyecto sin remotos adopta los del repositorio que se une.
                        let adopt = (c.project.fingerprint.remotes.is_empty() && !ident.fingerprint.remotes.is_empty())
                            .then(|| Fingerprint { remotes: ident.fingerprint.remotes.clone(), ..c.project.fingerprint.clone() });
                        if join_project(st, &c.project, &loc, adopt, &mgmt)? == ChangeOutcome::Missing {
                            return Ok(json!({ "status": "error", "error": format!("No existe el proyecto {join}") }));
                        }
                        Self::registered(st, &join, false, &counts)
                    } else if force_new {
                        new_project(st)
                    } else {
                        Ok(json!({
                            "status": "needs_confirmation",
                            "path": ident.root,
                            "candidates": cands.iter().map(|c| c.json(&ident.fingerprint)).collect::<Vec<_>>(),
                            "hint": "Este repositorio se parece a un proyecto ya registrado en otra ruta. Repite con `join` (es el mismo proyecto: añade esta ubicación) o con `new` (es otro proyecto, p. ej. un fork).",
                        }))
                    }
                }
                Lookup::None => {
                    if !join.is_empty() {
                        return Ok(json!({ "status": "error", "error": format!("El proyecto {join} no coincide con este repositorio. Para forzar otra ubicación usa project_locate") }));
                    }
                    new_project(st)
                }
            }
        })
        .and_then(|v| match v["status"].as_str() {
            Some("error") => Err(v["error"].as_str().unwrap_or("error").to_string()),
            _ => Ok(v),
        })
    }

    /// `project_archive {project_id, archived?: bool = true}`: oculta (o restaura) sin borrar nada. Solo un
    /// cambio REAL de estado deja `project.archived` / `project.restored`; archivar un archivado o restaurar un
    /// activo no escribe nada.
    pub(super) fn project_archive(&self, ctx: &MutationContext, args: &Value) -> Result<Value, String> {
        self.require_registry_writable()?;
        let mgmt = Management::new(ctx)?;
        let id = s(args, "project_id");
        let archived = args.get("archived").and_then(Value::as_bool).unwrap_or(true);
        let counts = self.tasks_per_project().0;
        self.registry_write(|st| {
            if set_archived(st, &id, archived, &mgmt)? == ChangeOutcome::Missing {
                return Ok(json!({ "status": "error", "error": format!("No existe el proyecto {id}") }));
            }
            Self::registered(st, &id, false, &counts)
        })
        .and_then(|v| if v["status"] == "error" { Err(v["error"].as_str().unwrap_or("error").to_string()) } else { Ok(v) })
    }

    /// `project_locate {project_id, path, confirm?: bool}`: dónde está ahora este proyecto (mismo id,
    /// otra ruta). Si el repositorio de `path` no parece el mismo (commits raíz distintos), pide
    /// confirmación en lugar de aceptarlo.
    ///
    /// Emite `project.relocated` (con `confirmed_mismatch` solo si la persona aceptó con `confirm` un repositorio
    /// de otros commits raíz) en la misma transacción que la ubicación y el posible cambio de huella.
    pub(super) fn project_locate(&self, ctx: &MutationContext, args: &Value) -> Result<Value, String> {
        self.require_registry_writable()?;
        let mgmt = Management::new(ctx)?;
        let id = s(args, "project_id");
        let ident = identify(&s(args, "path"))?;
        let confirm = b(args, "confirm");
        let counts = self.tasks_per_project().0;
        let out = self.registry_write(|st| {
            let Some(p) = st.project(&id)? else { return Ok(json!({ "status": "error", "error": format!("No existe el proyecto {id}") })) };
            let same = p.fingerprint.root_commits.is_empty() || intersects(&ident.fingerprint.root_commits, &p.fingerprint.root_commits);
            if !same && !confirm {
                return Ok(json!({
                    "status": "needs_confirmation",
                    "reason": "El repositorio de esa ruta no comparte commits raíz con el proyecto: no parece el mismo. Si estás seguro, repite con confirm.",
                    "path": ident.root,
                }));
            }
            let machine = machine_id_ensure(st)?;
            // Una ruta que ya es de otro proyecto es un error del almacén (ProjectConflict).
            let loc = NewLocation { machine, path: ident.key.clone(), display_path: ident.root.clone(), primary: true };
            // Un proyecto sin commits raíz adopta la huella del repositorio donde está ahora.
            let adopt = p.fingerprint.root_commits.is_empty().then(|| ident.fingerprint.clone());
            if relocate_project(st, &p, &loc, adopt, !same && confirm, &mgmt)? == ChangeOutcome::Missing {
                return Ok(json!({ "status": "error", "error": format!("No existe el proyecto {id}") }));
            }
            Self::registered(st, &id, false, &counts)
        })?;
        if out["status"] == "error" { Err(out["error"].as_str().unwrap_or("error").to_string()) } else { Ok(out) }
    }

    // -----------------------------------------------------------------------------------------
    // Asignación a tareas: implícita, relleno, importación
    // -----------------------------------------------------------------------------------------

    /// Descubrimiento automático: resuelve (y si hace falta crea) el proyecto de un repositorio SIN
    /// preguntar a nadie. Tres resultados que NO se mezclan:
    ///
    /// * `Ok(Some(id))` — proyecto resuelto: misma ruta, o inequívocamente nuevo (se crea);
    /// * `Ok(None)` — no hay proyecto que asignar, y es legítimo: el repositorio es AMBIGUO (se parece
    ///   a uno registrado en otra ruta: no se une en silencio, la tarea queda sin proyecto hasta que la
    ///   persona confirme), `git` no lo puede identificar, o el registro es opcional y NO está
    ///   disponible (almacén cerrado/degradado: D no es requisito de los flujos legacy);
    /// * `Err(..)` — el registro está ACTIVO y falló de verdad. Se propaga: quien lanza no debe crear
    ///   una tarea sin proyecto como si nada, porque entonces ni el archivado ni la ubicación
    ///   desaparecida podrían protegerla.
    ///
    /// Un proyecto inequívocamente nuevo emite `project.registered` (origen `auto`) en la misma transacción
    /// que su fila. `ctx` es de quien lanza el run: persona, agente (su tarea) o sistema. Con el Core en
    /// solo lectura es un error (no se crea nada), no un `Ok(None)`: el run tampoco se podría crear.
    pub(super) fn project_for_repo(&self, ctx: &MutationContext, repo: &str) -> Result<Option<String>, String> {
        self.require_registry_writable()?;
        let reg = Registration::new(ProjectOrigin::Auto, ctx)?;
        let Ok(ident) = identify(repo) else { return Ok(None) };
        self.registry_write_opt(|st| Self::resolve_in(st, &ident, &reg))
            .map(Option::flatten)
            .map_err(|why| format!("No se pudo comprobar el registro de proyectos para {repo}: {why}. No se crea nada hasta poder comprobarlo."))
    }

    /// Solo SQL: se llama con el mutex del almacén tomado, desde un closure de escritura.
    fn resolve_in(st: &mut Store, ident: &Identity, reg: &Registration<'_>) -> StoreResult<Option<String>> {
        let machine = machine_id_ensure(st)?;
        Ok(match lookup(st, &machine, ident)? {
            Lookup::ByPath(id) => Some(id),
            Lookup::Candidates(_) => None,
            Lookup::None => {
                let loc = NewLocation { machine, path: ident.key.clone(), display_path: ident.root.clone(), primary: true };
                Some(register_project(st, &ident.name, &ident.fingerprint, &loc, reg)?.id)
            }
        })
    }

    /// Como [`Core::project_for_repo`], pero un registro no disponible es un error (relleno e
    /// importación lo necesitan abierto).
    fn resolve_or_create(&self, ident: &Identity, reg: &Registration<'_>) -> Result<Option<String>, String> {
        self.registry_write(|st| Self::resolve_in(st, ident, reg))
    }

    /// Asigna `project_id` a las tareas existentes que no lo tienen (perezoso: se llama tras arrancar,
    /// con presupuesto de tiempo). Idempotente: procesa SIEMPRE las tareas que sigan sin proyecto. Los
    /// repositorios ambiguos o que ya no existen se dejan sin proyecto. `meta.projects_backfilled` es
    /// solo una marca diagnóstica (ver `META_BACKFILLED`): se anota si la pasada terminó y no se usa
    /// para saltarse pasadas futuras.
    ///
    /// Cada proyecto que NACE aquí emite `project.registered` (origen `backfill`, sistema por el canal
    /// `core`) junto a su fila. Con el Core en solo lectura no hace nada y lo dice.
    pub(super) fn backfill_projects(&self, budget: Duration) -> Result<Value, String> {
        self.require_registry_writable()?;
        let ctx = MutationContext::core();
        let reg = Registration::new(ProjectOrigin::Backfill, &ctx)?;
        let started = Instant::now();
        let mut pending: Vec<String> = vec![];
        {
            let st = self.lock();
            for t in st.tasks.values().filter(|t| t.project_id.is_none()) {
                if !pending.contains(&t.repo) {
                    pending.push(t.repo.clone());
                }
            }
        }
        let (mut assigned, mut ambiguous, mut unresolved, mut complete) = (0usize, 0usize, 0usize, true);
        let mut resolved: std::collections::HashMap<String, String> = Default::default();
        for repo in &pending {
            if started.elapsed() >= budget {
                complete = false;
                break;
            }
            match identify(repo) {
                Err(_) => unresolved += 1,
                Ok(ident) => match self.resolve_or_create(&ident, &reg)? {
                    Some(id) => {
                        resolved.insert(repo.clone(), id);
                    }
                    None => ambiguous += 1,
                },
            }
        }
        if !resolved.is_empty() {
            assigned = self
                .mutate(|st| {
                    let mut n = 0;
                    for t in st.tasks.values_mut() {
                        if t.project_id.is_none() {
                            if let Some(id) = resolved.get(&t.repo) {
                                t.project_id = Some(id.clone());
                                n += 1;
                            }
                        }
                    }
                    Ok(n)
                })
                .map_err(String::from)?;
        }
        if complete {
            self.registry_write(|st| st.meta_set(META_BACKFILLED, &now_ms().to_string()))?;
        }
        Ok(json!({ "assigned": assigned, "ambiguous": ambiguous, "unresolved": unresolved, "complete": complete }))
    }

    /// Importa las carpetas recientes de la interfaz (`lixbon_recents`). EL CORE ES LA ÚNICA AUTORIDAD
    /// de esta importación: la interfaz puede llamar en cada arranque y es `meta.projects_recents_imported`
    /// (en SQLite) quien decide; con la marca puesta devuelve `already_done` sin hacer nada. No
    /// pregunta: lo ambiguo se omite y se informa.
    ///
    /// Cada proyecto que NACE aquí emite `project.registered` (origen `import`, sistema por el canal de
    /// `ctx`: la interfaz dispara la importación, pero ninguna persona decide cada proyecto). Con el Core
    /// en solo lectura se rechaza entera, incluida la marca de «ya importado».
    pub(super) fn projects_import_recents(&self, ctx: &MutationContext, args: &Value) -> Result<Value, String> {
        self.require_registry_writable()?;
        let reg = Registration::new(ProjectOrigin::Import, ctx)?;
        if self.registry_read(|st| st.meta(META_RECENTS))?.is_some() {
            return Ok(json!({ "imported": 0, "existing": 0, "skipped": [], "already_done": true }));
        }
        let paths: Vec<String> = args
            .get("paths")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(String::from).take(MAX_RECENTS).collect())
            .unwrap_or_default();
        let (mut imported, mut existing) = (0, 0);
        let mut skipped: Vec<Value> = vec![];
        for path in paths {
            let ident = match identify(&path) {
                Ok(i) => i,
                Err(why) => {
                    skipped.push(json!({ "path": path, "reason": why }));
                    continue;
                }
            };
            let known = self.registry_read(|st| match machine_id_read(st)? {
                Some(machine) => st.project_by_location(&machine, &ident.key),
                None => Ok(None),
            })?;
            match (known, self.resolve_or_create(&ident, &reg)?) {
                (Some(_), _) => existing += 1,
                (None, Some(_)) => imported += 1,
                (None, None) => skipped.push(json!({ "path": path, "reason": "se parece a un proyecto ya registrado en otra ruta: añádelo con project_add para confirmarlo" })),
            }
        }
        self.registry_write(|st| st.meta_set(META_RECENTS, &now_ms().to_string()))?;
        Ok(json!({ "imported": imported, "existing": existing, "skipped": skipped, "already_done": false }))
    }

    // -----------------------------------------------------------------------------------------
    // Guarda de lanzamiento
    // -----------------------------------------------------------------------------------------

    /// ¿Se puede lanzar trabajo nuevo en el proyecto de esta tarea? No si está archivado, ni si
    /// ninguna de sus ubicaciones en esta máquina existe ya (`missing`).
    ///
    /// Compatibilidad: una tarea SIN `project_id` no se bloquea (el registro no es requisito para lo
    /// que nunca lo tuvo) y con el almacén realmente cerrado/degradado tampoco (el registro es
    /// aditivo y no rompe los flujos legacy).
    pub(super) fn check_project_launchable(&self, task_id: &str) -> Result<(), String> {
        let Some(pid) = self.lock().tasks.get(task_id).and_then(|t| t.project_id.clone()) else { return Ok(()) };
        self.check_project_launchable_id(&pid)
    }

    /// Lo mismo a partir del id de proyecto (p. ej. el de un repositorio donde aún no hay tarea).
    ///
    /// Con un `project_id` conocido y el almacén disponible, **ningún error de lectura se convierte
    /// en `Ok`**: una consulta que falla, o un `project_id` que ya no existe en el registro, rechazan
    /// el lanzamiento. Si no, las protecciones de abajo (archivado, ubicación desaparecida) se
    /// podrían saltar justo cuando el registro está en problemas.
    pub(super) fn check_project_launchable_id(&self, pid: &str) -> Result<(), String> {
        let fallo = |why: String| format!("No se pudo comprobar el proyecto {pid} antes de lanzar: {why}. No se lanza hasta poder comprobarlo.");
        // 1. Leer (solo SQL).
        let read = self
            .registry_read_opt(|st| {
                // Solo lectura: sin `machine_id` todavía no hay ubicaciones de esta máquina (y no se crea ahora).
                let machine = machine_id_read(st)?;
                let Some(p) = st.project(pid)? else { return Ok((None, vec![])) };
                let locs: Vec<LocationRow> = match machine {
                    Some(m) => st.project_locations(Some(pid))?.into_iter().filter(|l| l.machine == m).collect(),
                    None => vec![],
                };
                Ok((Some(p), locs))
            })
            .map_err(fallo)?;
        // Almacén no abierto (modo degradado): el registro es aditivo.
        let Some((p, mut locs)) = read else { return Ok(()) };
        let Some(p) = p else {
            return Err(format!(
                "La tarea apunta al proyecto {pid}, que no existe en el registro de proyectos (¿se restauró una copia anterior?). No se lanza: registra el repositorio de nuevo o corrige el proyecto."
            ));
        };
        // 2. Comprobar el disco, con el almacén ya suelto.
        let marks = transitions(&locs, exists_on_disk);
        // 3. Persistir solo lo que cambió.
        self.persist_marks(&marks).map_err(fallo)?;
        apply_transitions(&mut locs, &marks);
        if p.archived {
            return Err(format!("El proyecto «{}» está archivado: restáuralo (project_archive con archived=false) para lanzar trabajo nuevo.", p.name));
        }
        if !locs.is_empty() && locs.iter().all(|l| l.missing) {
            return Err(format!(
                "La ubicación del proyecto «{}» ya no existe ({}): indica dónde está ahora con project_locate antes de lanzar trabajo nuevo.",
                p.name,
                locs.first().map(|l| l.display_path.as_str()).unwrap_or("")
            ));
        }
        Ok(())
    }
}
