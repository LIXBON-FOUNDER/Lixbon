//! Corte de datos Task/Attempt (LXO-117): la orquestación de los pasos 3–5b de la ADR §9 y el rollback de §12.
//! Contrato: `docs/core/CORTE_EJECUCION.md`.
//!
//! ```text
//! run(st, core, data)
//!   3. preflight: base en la última migración publicada, legacy_state doc_schema 0 y legible como State
//!   4. copia `pre-f3-cut` (VACUUM INTO + integrity_check) + state.json + authority.json + sidecar
//!   5. Store::agentic_cut_recorded(SQL del corte, |tablas|
//!   5b.     vista legacy reconstruida == documento (salvo D3)  ->  evento core.agentic_cut
//!      )                                                        <- UNA transacción: o todo, o nada
//! ```
//!
//! **Sin activar**: el arranque no llama a [`run`]. Activarlo (y el paso 6, que pasa a `exited` los Attempts
//! huérfanos) es del slice que mueva el runtime a las tablas.

#![cfg_attr(not(test), allow(dead_code))] // sin activar: solo lo usan las pruebas

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::event_kinds;
use super::events::MutationContext;
use super::fsio::write_atomic_durable;
use super::state::{now_ms, Message, Run, State, Task};
use super::task_ops::finalize_single;
use crate::store::{cut_migration, inspect_copy, lock_path, sha256_hex, CutCounts, CutOutcome, CutView, InstanceLock, RuntimeChanges, Store, StoreError, StoreResult, CUT_NAME};

/// Etiqueta de la copia previa obligatoria.
pub(super) const BACKUP_LABEL: &str = "pre-f3-cut";
const SIDECAR_VERSION: u32 = 1;

/// Lo que había en el documento legacy (el informe «antes»).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct LegacyCounts {
    pub runs: usize,
    pub tasks: usize,
    pub messages: usize,
    pub decisions: usize,
}

/// `…-pre-f3-cut.db.json`: permite verificar la copia sin abrir la base cortada (ADR §10).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Sidecar {
    pub v: u32,
    pub label: String,
    pub db: String,
    pub db_sha256: String,
    pub user_version: i64,
    pub legacy_rev: Option<i64>,
    pub legacy_doc_sha256: Option<String>,
    pub integrity_check: String,
    pub app_version: String,
    pub counts: LegacyCounts,
    /// Copias de `state.json` y `authority.json` del mismo conjunto, si existían.
    pub state_json: Option<String>,
    pub authority_json: Option<String>,
}

/// Informe del corte: antes, después y la copia que permite volver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum CutReport {
    Applied { backup: PathBuf, before: LegacyCounts, after: CutCounts },
    AlreadyCut,
}

fn preflight_err(m: impl Into<String>) -> StoreError {
    StoreError::CutPreflight(m.into())
}

fn check_err(m: impl Into<String>) -> StoreError {
    let cut = cut_migration();
    StoreError::MigrationFailed { version: cut.version, name: CUT_NAME.into(), detail: format!("validación semántica: {}", m.into()) }
}

/// Paso 3 (solo lectura): base en la última migración publicada y documento legible. Sin fila `legacy_state` (una
/// instalación nueva) el documento es un `State` vacío.
fn preflight(st: &Store) -> StoreResult<(Option<(i64, String)>, State)> {
    let expected = cut_migration().version - 1;
    let version = st.schema_version()?;
    if version != expected {
        return Err(preflight_err(format!("la base está en la versión {version}; el corte se aplica sobre la {expected}")));
    }
    let Some(legacy) = st.legacy_state()? else { return Ok((None, State::default())) };
    if legacy.doc_schema != 0 {
        return Err(preflight_err(format!("legacy_state tiene doc_schema {}: el corte solo conoce el 0", legacy.doc_schema)));
    }
    let state: State = serde_json::from_str(&legacy.doc).map_err(|e| preflight_err(format!("legacy_state no se lee como State: {e}")))?;
    Ok((Some((legacy.rev, legacy.doc)), state))
}

fn io(context: &str, e: std::io::Error) -> StoreError {
    StoreError::Backup(format!("{context}: {e}"))
}

/// Junto a la copia: `<copia sin .db>-<nombre>` (mismo prefijo, mismo conjunto).
fn companion(backup: &Path, name: &str) -> PathBuf {
    let stem = backup.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    backup.with_file_name(format!("{stem}-{name}"))
}

fn sidecar_path(backup: &Path) -> PathBuf {
    let name = backup.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    backup.with_file_name(format!("{name}.json"))
}

/// Paso 4: la copia previa obligatoria y su sidecar. Sin copia no hay corte (D13).
fn backup_pre_cut(st: &Store, core: &Path, data: &Path, app_version: &str, legacy: &Option<(i64, String)>, state: &State) -> StoreResult<(PathBuf, Sidecar)> {
    let db = st.backup(BACKUP_LABEL)?;
    let copy = |from: PathBuf, name: &str| -> StoreResult<Option<String>> {
        if !from.exists() {
            return Ok(None);
        }
        let to = companion(&db, name);
        std::fs::copy(&from, &to).map_err(|e| io(&format!("no se pudo copiar {}", from.display()), e))?;
        Ok(Some(to.file_name().unwrap_or_default().to_string_lossy().into_owned()))
    };
    let state_json = copy(data.join("state.json"), "state.json")?;
    let authority_json = copy(core.join(super::authority::MARKER_FILE), "authority.json")?;
    let facts = inspect_copy(&db)?;
    if facts.integrity != "ok" || facts.legacy.as_ref().map(|(r, d)| (*r, sha256_hex(d.as_bytes()))) != legacy.as_ref().map(|(r, d)| (*r, sha256_hex(d.as_bytes()))) {
        return Err(StoreError::Backup("la copia previa no coincide con la base o no pasa integrity_check".into()));
    }
    let sidecar = Sidecar {
        v: SIDECAR_VERSION,
        label: BACKUP_LABEL.into(),
        db: db.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        db_sha256: sha256_hex(&std::fs::read(&db).map_err(|e| io("no se pudo leer la copia", e))?),
        user_version: facts.user_version,
        legacy_rev: legacy.as_ref().map(|(r, _)| *r),
        legacy_doc_sha256: legacy.as_ref().map(|(_, d)| sha256_hex(d.as_bytes())),
        integrity_check: facts.integrity,
        app_version: app_version.into(),
        counts: LegacyCounts { runs: state.runs.len(), tasks: state.tasks.len(), messages: state.messages.len(), decisions: state.decisions.len() },
        state_json,
        authority_json,
    };
    let bytes = serde_json::to_vec_pretty(&sidecar).map_err(|e| StoreError::Backup(format!("sidecar: {e}")))?;
    write_atomic_durable(&sidecar_path(&db), &bytes, true).map_err(|e| io("no se pudo escribir el sidecar", e))?;
    Ok((db, sidecar))
}

/// Lo que la vista debe mostrar de una Task legacy: el documento, salvo D3 (una sesión que el proveedor no declaró no
/// se muestra, y un modelo leído de una sesión atada por carpeta y hora pasa a procedencia `unknown`).
fn expected_task(t: &Task) -> Task {
    let mut e = t.clone();
    let declared = (t.agent == "claude" && t.stream_json) || t.session_match.as_deref() == Some("session_id");
    if t.session_ref.is_some() && !declared {
        e.session_ref = None;
        e.session_match = None;
    }
    if t.session_match.as_deref() == Some("cwd_time") {
        e.session_match = None;
        e.model_source = Some("unknown".into());
    }
    e
}

fn to_value<T: Serialize>(v: &T) -> StoreResult<Value> {
    serde_json::to_value(v).map_err(|e| check_err(e.to_string()))
}

/// Paso 5b: dentro de la transacción del corte, la vista legacy reconstruida desde las tablas es el documento. Cada
/// valor se lee de vuelta como el tipo del documento (`Task`, `Message`, `Run`), así que un campo sin destino aparece
/// como diferencia.
pub(super) fn verify_legacy_view(v: &CutView<'_>, state: &State) -> StoreResult<()> {
    for (id, t) in &state.tasks {
        let task: Task = serde_json::from_value(v.legacy_task(id)?).map_err(|e| check_err(format!("{id}: la vista legacy no es un Task: {e}")))?;
        let (got, want) = (to_value(&task)?, to_value(&expected_task(t))?);
        if got != want {
            let campo = want.as_object().and_then(|w| w.iter().find(|(k, x)| got.get(*k) != Some(*x)).map(|(k, _)| k.clone())).unwrap_or_default();
            return Err(check_err(format!("la Task {id} no se reconstruye igual (campo {campo})")));
        }
    }
    let dangling = v.dangling_messages()?;
    let got: Vec<Message> = serde_json::from_value(Value::Array(v.legacy_messages()?)).map_err(|e| check_err(format!("mensajes: {e}")))?;
    let mut want: Vec<&Message> = state.messages.iter().filter(|m| !dangling.contains(&m.id)).collect();
    want.sort_by_key(|m| m.id);
    if to_value(&got)? != to_value(&want)? {
        return Err(check_err("los mensajes no se reconstruyen igual"));
    }
    let runs: Vec<Run> = serde_json::from_value(Value::Array(v.legacy_runs()?)).map_err(|e| check_err(format!("runs: {e}")))?;
    if to_value(&runs)? != to_value(&state.runs.values().collect::<Vec<_>>())? {
        return Err(check_err("los Runs no se reconstruyen igual"));
    }
    if let Some(t) = v.foreign_key_violation()? {
        return Err(check_err(format!("referencia rota en {t}")));
    }
    Ok(())
}

fn runtime_err(m: impl Into<String>) -> StoreError {
    StoreError::RuntimeMapping(format!("la vista reconstruida no es el estado: {}", m.into()))
}

/// Runtime sobre las tablas (LXO-232): dentro de la transacción de cada mutación, lo que cambió se lee de vuelta de las
/// tablas en la forma del documento y debe ser el estado nuevo, salvo D3 (como en el corte). Así una mutación que las
/// tablas no reproducen no se confirma: nunca hay una memoria que el siguiente arranque no vería.
pub(super) fn verify_runtime_view(v: &CutView<'_>, changes: &RuntimeChanges, state: &State) -> StoreResult<()> {
    for id in &changes.tasks {
        let t = state.tasks.get(id).ok_or_else(|| runtime_err(format!("{id} no está en el estado")))?;
        let task: Task = serde_json::from_value(v.legacy_task(id)?).map_err(|e| runtime_err(format!("{id}: no es un Task: {e}")))?;
        let (got, want) = (to_value(&task)?, to_value(&expected_task(t))?);
        if got != want {
            let campo = want.as_object().and_then(|w| w.iter().find(|(k, x)| got.get(*k) != Some(*x)).map(|(k, _)| k.clone())).unwrap_or_default();
            return Err(runtime_err(format!("la Task {id} no se reconstruye igual (campo {campo})")));
        }
    }
    for id in &changes.removed_tasks {
        if v.task_visible(id)? {
            return Err(runtime_err(format!("la Task retirada {id} sigue a la vista")));
        }
    }
    for id in &changes.messages {
        let m = state.messages.iter().find(|m| m.id as i64 == *id).ok_or_else(|| runtime_err(format!("el mensaje {id} no está en el estado")))?;
        let got = v.legacy_message(*id)?.ok_or_else(|| runtime_err(format!("el mensaje {id} no está en las tablas")))?;
        let got: Message = serde_json::from_value(got).map_err(|e| runtime_err(format!("mensaje {id}: {e}")))?;
        if to_value(&got)? != to_value(m)? {
            return Err(runtime_err(format!("el mensaje {id} no se reconstruye igual")));
        }
    }
    for id in &changes.runs {
        let r = state.runs.get(id).ok_or_else(|| runtime_err(format!("el Run {id} no está en el estado")))?;
        let got = v.legacy_run(id)?.ok_or_else(|| runtime_err(format!("el Run {id} no está en las tablas")))?;
        let got: Run = serde_json::from_value(got).map_err(|e| runtime_err(format!("Run {id}: {e}")))?;
        if to_value(&got)? != to_value(r)? {
            return Err(runtime_err(format!("el Run {id} no se reconstruye igual")));
        }
    }
    Ok(())
}

/// Ejecuta el corte (pasos 3–5b). Idempotente: una base ya cortada es [`CutReport::AlreadyCut`] sin tocar nada.
pub(super) fn run(st: &mut Store, core: &Path, data: &Path, app_version: &str) -> StoreResult<CutReport> {
    if st.agentic_cut_done()? {
        return Ok(CutReport::AlreadyCut);
    }
    let (legacy, state) = preflight(st)?;
    let (backup, sidecar) = backup_pre_cut(st, core, data, app_version, &legacy, &state)?;
    let at = now_ms() as i64;
    let outcome = st.agentic_cut_recorded(&cut_migration(), app_version, |c, counts| {
        verify_legacy_view(c, &state)?;
        finalize_single(event_kinds::agentic_cut(counts, &sidecar.db), &MutationContext::core(), at)
    })?;
    Ok(match outcome {
        CutOutcome::Applied(after) => CutReport::Applied { backup, before: sidecar.counts, after },
        CutOutcome::AlreadyCut => CutReport::AlreadyCut,
    })
}

/// Paso 2 del rollback: la copia coincide con su sidecar (hash, integridad, versión y documento).
pub(super) fn check_copy(backup: &Path) -> StoreResult<Sidecar> {
    let raw = std::fs::read(sidecar_path(backup)).map_err(|e| io("no se pudo leer el sidecar", e))?;
    let s: Sidecar = serde_json::from_slice(&raw).map_err(|e| StoreError::Backup(format!("sidecar ilegible: {e}")))?;
    let bytes = std::fs::read(backup).map_err(|e| io("no se pudo leer la copia", e))?;
    let facts = inspect_copy(backup)?;
    let ok = s.label == BACKUP_LABEL
        && sha256_hex(&bytes) == s.db_sha256
        && facts.integrity == "ok"
        && facts.user_version == s.user_version
        && facts.legacy.as_ref().map(|(r, d)| (*r, sha256_hex(d.as_bytes()))) == s.legacy_rev.zip(s.legacy_doc_sha256.clone());
    if !ok {
        return Err(StoreError::Backup(format!("la copia {} no coincide con su sidecar: no se restaura", backup.display())));
    }
    Ok(s)
}

/// Rollback (ADR §12, pasos 2–4), **offline**: con el bloqueo de instancia libre, verifica la copia, aparta (no
/// borra) la base actual a `core/rollback-<ms>/` y pone en su sitio la copia, `state.json` y `authority.json` del
/// mismo conjunto. Devuelve la carpeta apartada. Fijar la versión del binario (paso 5) es del instalador.
pub(super) fn restore(core: &Path, data: &Path, backup: &Path) -> StoreResult<PathBuf> {
    let _lock = InstanceLock::acquire(&lock_path(core))?;
    let s = check_copy(backup)?;
    let aside = core.join(format!("rollback-{}", now_ms()));
    std::fs::create_dir_all(&aside).map_err(|e| io("no se pudo crear la carpeta de rollback", e))?;
    for ext in ["", "-wal", "-shm"] {
        let f = core.join(format!("lixbon.db{ext}"));
        if f.exists() {
            std::fs::rename(&f, aside.join(format!("lixbon.db{ext}"))).map_err(|e| io("no se pudo apartar la base", e))?;
        }
    }
    std::fs::copy(backup, core.join("lixbon.db")).map_err(|e| io("no se pudo restaurar la base", e))?;
    let dir = backup.parent().unwrap_or(core);
    for (name, dest) in [(&s.state_json, data.join("state.json")), (&s.authority_json, core.join(super::authority::MARKER_FILE))] {
        if let Some(name) = name {
            if dest.exists() {
                let to = aside.join(dest.file_name().unwrap_or_default());
                std::fs::rename(&dest, to).map_err(|e| io("no se pudo apartar el espejo", e))?;
            }
            std::fs::copy(dir.join(name), &dest).map_err(|e| io(&format!("no se pudo restaurar {name}"), e))?;
        }
    }
    Ok(aside)
}
