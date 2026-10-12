//! Protocolo de autoridad del estado (slice C2b de la Fase 1): el marcador
//! externo `authority.json` y la decisión de arranque `decide_boot`.
//!
//! # Qué es y qué NO es el marcador
//! `authority.json` registra **únicamente el estado del protocolo de
//! persistencia**: «esta instalación está promoviendo / ya fue promovida a SQLite».
//! No contiene estado de dominio, no es otra fuente de verdad y no se actualiza
//! por mutación: cambia dos veces en la vida de una instalación (`promoting` →
//! `authoritative`). Existe para el caso en que la propia base no se puede
//! consultar: sin él no habría forma de afirmar que `state.json` ya no manda.
//! La metadata de autoridad **sigue dentro de SQLite** y, mientras la base se
//! puede abrir, es ella la que manda.
//!
//! # Los `rev` son de la fila de SQLite
//! `sqlite_bootstrap_rev` / `sqlite_target_rev` numeran publicaciones de la fila
//! `legacy_state`; **no** son el historial de mutaciones de `state.json`, que no
//! tiene `rev`. La identidad del legado son sus bytes exactos
//! (`source_hash`, `source_bytes`).
//!
//! # `decide_boot` es pura
//! Recibe lo observado (marcador, base, legado, indicios) y devuelve una decisión,
//! sin E/S. Así se prueba de forma exhaustiva que **ningún camino** deja a
//! `state.json` como autoridad de ejecución cuando hay evidencia de promoción, y
//! que añadir un camino nuevo rompe la prueba de propiedad.
//!
//! Estados de la máquina (ver `LIXBON-C2-diseno.md` §11.3):
//! `LEGACY → FENCED → PROMOTING → COMMITTED → AUTHORITATIVE`.

use std::fmt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::fsio;
use super::state::State;
use crate::store::{self, AuthMeta, AuthorityFacts, PromotionPlan, MODE_SQLITE_AUTHORITATIVE};

pub(super) const MARKER_FILE: &str = "authority.json";
/// Versión del esquema del marcador que entiende este binario.
pub(super) const MARKER_VERSION: u32 = 1;
/// `source_hash` de una instalación sin legado.
pub(super) const NO_SOURCE: &str = store::NO_SOURCE;
const MODE_BOOTSTRAP: &str = "bootstrap_snapshot";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(super) enum MarkerState {
    /// Intención publicada ANTES del COMMIT de la promoción.
    Promoting,
    /// Promoción confirmada.
    Authoritative,
}

/// Contenido de `authority.json`. Todos los campos son obligatorios salvo
/// `confirmed_at`; los de identidad no cambian de `promoting` a `authoritative`.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq, Debug)]
pub(super) struct Marker {
    pub v: u32,
    pub state: MarkerState,
    pub promotion_id: String,
    pub db: String,
    pub db_id: String,
    /// SHA-256 de los bytes exactos de `state.json` que se promocionan, o `"none"`.
    pub source_hash: String,
    pub source_bytes: u64,
    pub sqlite_bootstrap_rev: i64,
    pub sqlite_target_rev: i64,
    pub created_at: i64,
    pub writer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_at: Option<i64>,
}

impl Marker {
    pub(super) fn promoting(plan: &PromotionPlan, db_id: &str) -> Marker {
        Marker {
            v: MARKER_VERSION,
            state: MarkerState::Promoting,
            promotion_id: plan.promotion_id.clone(),
            db: "lixbon.db".into(),
            db_id: db_id.to_string(),
            source_hash: plan.source_hash.clone(),
            source_bytes: plan.source_bytes,
            sqlite_bootstrap_rev: plan.sqlite_bootstrap_rev,
            sqlite_target_rev: plan.sqlite_target_rev,
            created_at: super::state::now_ms() as i64,
            writer: writer(),
            confirmed_at: None,
        }
    }

    /// El mismo marcador, ya confirmado.
    pub(super) fn confirmed(&self) -> Marker {
        Marker { state: MarkerState::Authoritative, confirmed_at: Some(super::state::now_ms() as i64), writer: writer(), ..self.clone() }
    }

    /// Reconstruye el marcador desde la metadata que SQLite guarda de la promoción.
    pub(super) fn from_database(facts: &AuthorityFacts, auth: &AuthMeta) -> Option<Marker> {
        Some(Marker {
            v: MARKER_VERSION,
            state: MarkerState::Authoritative,
            promotion_id: auth.promotion_id.clone(),
            db: "lixbon.db".into(),
            db_id: facts.db_id.clone()?,
            source_hash: auth.source_hash.clone(),
            source_bytes: auth.source_bytes,
            sqlite_bootstrap_rev: auth.sqlite_bootstrap_rev,
            sqlite_target_rev: auth.sqlite_target_rev,
            created_at: auth.since,
            writer: writer(),
            confirmed_at: Some(super::state::now_ms() as i64),
        })
    }

    pub(super) fn plan(&self) -> PromotionPlan {
        PromotionPlan {
            promotion_id: self.promotion_id.clone(),
            source_hash: self.source_hash.clone(),
            source_bytes: self.source_bytes,
            sqlite_bootstrap_rev: self.sqlite_bootstrap_rev,
            sqlite_target_rev: self.sqlite_target_rev,
        }
    }

    /// ¿La metadata de la base describe esta misma promoción?
    pub(super) fn matches(&self, facts: &AuthorityFacts) -> bool {
        let Some(a) = &facts.auth else { return false };
        facts.db_id.as_deref() == Some(self.db_id.as_str())
            && a.promotion_id == self.promotion_id
            && a.source_hash == self.source_hash
            && a.source_bytes == self.source_bytes
            && a.sqlite_bootstrap_rev == self.sqlite_bootstrap_rev
            && a.sqlite_target_rev == self.sqlite_target_rev
            && facts.row_rev.is_some_and(|r| r >= self.sqlite_target_rev)
    }
}

fn writer() -> String {
    format!("lixbon-core {}", env!("CARGO_PKG_VERSION"))
}

/// Lo que se encontró en `authority.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum MarkerRead {
    /// No existe: la instalación no está promovida (ni promoviéndose).
    Absent,
    Valid(Marker),
    /// Existe pero no se puede dar por bueno (ilegible, JSON inválido, `v` o
    /// `state` desconocidos, campo ausente, incoherente). **Nunca** equivale a `Absent`.
    Invalid(String),
}

pub(super) fn marker_path(core_dir: &Path) -> PathBuf {
    core_dir.join(MARKER_FILE)
}

/// Lee el marcador de forma estricta (fail-closed).
pub(super) fn read_marker(core_dir: &Path) -> MarkerRead {
    let bytes = match std::fs::read(marker_path(core_dir)) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return MarkerRead::Absent,
        Err(e) => return MarkerRead::Invalid(format!("no se pudo leer {MARKER_FILE}: {e}")),
    };
    parse_marker(&bytes)
}

pub(super) fn parse_marker(bytes: &[u8]) -> MarkerRead {
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => return MarkerRead::Invalid(format!("{MARKER_FILE} no es JSON válido: {e}")),
    };
    match value.get("v").and_then(Value::as_u64) {
        None | Some(0) => return MarkerRead::Invalid(format!("{MARKER_FILE} no declara una versión `v` válida")),
        Some(v) if v > MARKER_VERSION as u64 => {
            return MarkerRead::Invalid(format!(
                "{MARKER_FILE} es de la versión {v} del protocolo; este Lixbon entiende hasta la {MARKER_VERSION}: actualiza Lixbon"
            ))
        }
        Some(_) => {}
    }
    let m: Marker = match serde_json::from_value(value) {
        Ok(m) => m,
        Err(e) => return MarkerRead::Invalid(format!("{MARKER_FILE} está incompleto o tiene un valor desconocido: {e}")),
    };
    // Coherencias que se pueden comprobar sin heurística. Todo lo que no cuadre falla
    // cerrado: un marcador así no se interpreta, se bloquea.
    let hash_ok = m.source_hash == NO_SOURCE || (m.source_hash.len() == 64 && m.source_hash.chars().all(|c| c.is_ascii_hexdigit()));
    // Sin legado => cero bytes; con legado => no vacío (un `state.json` vacío no es promocionable).
    let bytes_ok = if m.source_hash == NO_SOURCE { m.source_bytes == 0 } else { m.source_bytes > 0 };
    // `target = bootstrap + 1` en rango (sin desbordar con datos corruptos).
    let revs_ok = m.sqlite_bootstrap_rev >= 0 && m.sqlite_bootstrap_rev.checked_add(1) == Some(m.sqlite_target_rev);
    let confirmed_ok = match m.state {
        MarkerState::Promoting => m.confirmed_at.is_none(),
        MarkerState::Authoritative => m.confirmed_at.is_some(),
    };
    let ids_ok = !m.promotion_id.is_empty() && !m.db_id.is_empty() && m.db == "lixbon.db";
    for (ok, what) in [
        (ids_ok, "identificadores o base"),
        (hash_ok, "source_hash"),
        (bytes_ok, "source_bytes frente a source_hash"),
        (revs_ok, "revisiones (sqlite_target_rev debe ser sqlite_bootstrap_rev + 1, en rango)"),
        (confirmed_ok, "confirmed_at frente a state"),
    ] {
        if !ok {
            return MarkerRead::Invalid(format!("{MARKER_FILE} tiene valores incoherentes: {what}"));
        }
    }
    MarkerRead::Valid(m)
}

/// Publica el marcador de forma atómica y durable. `points` = nombres de los
/// puntos de caída (tras escribir el temporal / tras publicar).
pub(super) fn write_marker(core_dir: &Path, m: &Marker, points: (&str, &str)) -> std::io::Result<()> {
    let dest = marker_path(core_dir);
    let bytes = serde_json::to_vec_pretty(m).map_err(std::io::Error::other)?;
    let tmp = fsio::stage_durable(&dest, &bytes, true)?;
    store::crash_point(points.0);
    fsio::publish_durable(&tmp, &dest).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    store::crash_point(points.1);
    Ok(())
}

/// Borra un temporal huérfano de una caída anterior (nunca es el marcador).
pub(super) fn clean_staging(core_dir: &Path) {
    let _ = std::fs::remove_file(fsio::staging_path(&marker_path(core_dir)));
}

// ---------------------------------------------------------------------------
// El legado (`state.json`)
// ---------------------------------------------------------------------------

/// Lo que se encontró en `state.json`, clasificado a partir de UNA lectura.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Legacy {
    Absent,
    /// Presente pero no es un `State` (no UTF-8, JSON inválido, vacío, truncado, otra forma).
    /// **Nunca** se interpreta como estado vacío.
    Unreadable(String),
    Readable {
        hash: String,
        bytes: u64,
        /// ¿Lleva la clave `_mirror`? Entonces lo escribió C2b: no es un legado.
        has_mirror: bool,
    },
}

pub(super) fn classify_legacy(bytes: Option<&[u8]>) -> Legacy {
    let Some(bytes) = bytes else { return Legacy::Absent };
    if bytes.is_empty() {
        return Legacy::Unreadable("el archivo está vacío".into());
    }
    if std::str::from_utf8(bytes).is_err() {
        return Legacy::Unreadable("el archivo no es UTF-8".into());
    }
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(v) => v,
        Err(e) => return Legacy::Unreadable(format!("no es JSON válido: {e}")),
    };
    if let Err(e) = serde_json::from_value::<State>(value.clone()) {
        return Legacy::Unreadable(format!("no tiene la forma de un estado de Lixbon: {e}"));
    }
    Legacy::Readable { hash: store::sha256_hex(bytes), bytes: bytes.len() as u64, has_mirror: value.get("_mirror").is_some() }
}

// ---------------------------------------------------------------------------
// decide_boot
// ---------------------------------------------------------------------------

/// Lo que se pudo averiguar de la base.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum DbProbe {
    /// `lixbon.db` no existe (se comprueba ANTES de abrir: abrir la recrearía vacía).
    FileMissing,
    /// Existe y no se pudo abrir o consultar.
    Unopenable(String),
    Opens(AuthorityFacts),
}

pub(super) struct BootInputs<'a> {
    pub marker: &'a MarkerRead,
    pub probe: &'a DbProbe,
    pub legacy: &'a Legacy,
    /// Hay copias diagnósticas de `state.json` (`.invalido-*`, `.divergente-*`, `.cambiado-*`).
    pub traces: bool,
    /// Existen copias `pre-authority` en `backups/`.
    pub evidence: bool,
}

/// Por qué se bloquea el arranque. Ninguna variante sugiere borrar el marcador.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum BlockReason {
    MarkerInvalid(String),
    LegacyUnreadable(String),
    /// Falta `state.json` pero hay una instalación existente (instantánea de C1 o rastro).
    LegacyMissing,
    /// `state.json` cambió desde que se publicó la intención `promoting`.
    LegacyChangedAfterIntent,
    /// Hay evidencia de promoción o de intención y la base no se puede consultar.
    NotVerifiable,
    /// El marcador y la base se contradicen.
    Inconsistent(String),
    /// `state.json` lleva `_mirror` (lo escribió C2b) pero la base no es autoritativa.
    MirrorWithoutAuthority,
}

impl fmt::Display for BlockReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BlockReason::MarkerInvalid(m) => write!(f, "el marcador de autoridad no es válido: {m}"),
            BlockReason::LegacyUnreadable(m) => write!(
                f,
                "state.json existe pero no se puede leer como estado de Lixbon ({m}); no se interpreta como un estado vacío y no se ha modificado. Se conservó una copia para diagnóstico"
            ),
            BlockReason::LegacyMissing => f.write_str(
                "falta state.json, pero esta instalación ya tenía estado (hay una instantánea de arranque o rastros previos). La instantánea puede estar desfasada y no se promociona sola; recupera un state.json válido",
            ),
            BlockReason::LegacyChangedAfterIntent => f.write_str(
                "state.json cambió después de que Lixbon fijara la promoción a SQLite (otro programa o una edición lo modificó). No se promociona el archivo nuevo ni se descarta el anterior; se conservó una copia del actual",
            ),
            BlockReason::NotVerifiable => f.write_str(
                "esta instalación ya se promovió a SQLite (o estaba en ello) y la base no se puede abrir; no se vuelve a usar state.json como fuente porque puede estar obsoleto",
            ),
            BlockReason::Inconsistent(m) => write!(f, "el marcador de autoridad y la base se contradicen: {m}"),
            BlockReason::MirrorWithoutAuthority => f.write_str(
                "state.json es una copia espejo escrita por una versión que ya promovió SQLite, pero la base no es autoritativa; no se usa como si fuera el estado original",
            ),
        }
    }
}

/// La decisión de arranque.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Boot {
    /// Instalación nueva, sin legado: inicializa con estado vacío y promueve.
    PromoteFresh { fenced: bool },
    /// Promueve desde `state.json` (la fuente de la PROMOCIÓN, no de la ejecución).
    Promote { fenced: bool },
    /// Rehace T2 de una intención ya publicada cuyo legado y fila coinciden.
    Redo,
    /// COMMIT hecho y marcador sin confirmar: confirma (T3).
    Complete,
    /// Base autoritativa válida y marcador ausente: SQLite manda; se reconstruye.
    RebuildMarker,
    /// Instalación ya promovida y coherente.
    Normal,
    /// Política de bootstrap de C1: sin marcador ni indicios y la base no abre.
    DegradeC1,
    Block(BlockReason),
}

pub(super) fn decide_boot(i: &BootInputs<'_>) -> Boot {
    match i.marker {
        MarkerRead::Invalid(why) => Boot::Block(BlockReason::MarkerInvalid(why.clone())),
        MarkerRead::Absent => absent(i),
        MarkerRead::Valid(m) if m.state == MarkerState::Promoting => promoting(i, m),
        MarkerRead::Valid(m) => authoritative(i, m),
    }
}

fn legacy_has_mirror(l: &Legacy) -> bool {
    matches!(l, Legacy::Readable { has_mirror: true, .. })
}

fn inconsistent(m: &str) -> Boot {
    Boot::Block(BlockReason::Inconsistent(m.into()))
}

fn absent(i: &BootInputs<'_>) -> Boot {
    match i.probe {
        DbProbe::Unopenable(_) => {
            // Degradar a `state.json` leería el legado: un legado ilegible NO se toma por vacío.
            if let Legacy::Unreadable(why) = i.legacy {
                return Boot::Block(BlockReason::LegacyUnreadable(why.clone()));
            }
            if i.evidence || legacy_has_mirror(i.legacy) {
                Boot::Block(BlockReason::NotVerifiable)
            } else {
                Boot::DegradeC1
            }
        }
        DbProbe::FileMissing => from_legacy(i, None),
        DbProbe::Opens(f) => match f.mode.as_deref() {
            // SQLite ya es autoritativa y el marcador se perdió: manda SQLite.
            Some(MODE_SQLITE_AUTHORITATIVE) => {
                let complete = f.fenced && f.db_id.is_some() && f.auth.as_ref().is_some_and(|a| f.row_rev.is_some_and(|r| r >= a.sqlite_target_rev));
                if complete {
                    Boot::RebuildMarker
                } else {
                    inconsistent("la base es autoritativa pero su metadata de autoridad está incompleta")
                }
            }
            Some(MODE_BOOTSTRAP) if f.row_rev.is_some() => from_legacy(i, Some(f)),
            None if f.row_rev.is_none() => from_legacy(i, Some(f)),
            _ => inconsistent("el modo de la base y su fila de estado no concuerdan"),
        },
    }
}

/// Marcador ausente y la base es de bootstrap (o no tiene fila): ¿se puede promocionar el legado?
fn from_legacy(i: &BootInputs<'_>, facts: Option<&AuthorityFacts>) -> Boot {
    let fenced = facts.is_some_and(|f| f.fenced);
    let has_row = facts.is_some_and(|f| f.row_rev.is_some());
    let traces = i.traces || facts.is_some_and(|f| f.has_import_meta);
    match i.legacy {
        Legacy::Unreadable(why) => Boot::Block(BlockReason::LegacyUnreadable(why.clone())),
        Legacy::Readable { has_mirror: true, .. } => Boot::Block(BlockReason::MirrorWithoutAuthority),
        Legacy::Readable { .. } => Boot::Promote { fenced },
        Legacy::Absent if has_row || traces => Boot::Block(BlockReason::LegacyMissing),
        Legacy::Absent => Boot::PromoteFresh { fenced },
    }
}

fn promoting(i: &BootInputs<'_>, m: &Marker) -> Boot {
    let f = match i.probe {
        DbProbe::FileMissing => return inconsistent("el marcador existe pero la base de datos no (se perdió)"),
        DbProbe::Unopenable(_) => return Boot::Block(BlockReason::NotVerifiable),
        DbProbe::Opens(f) => f,
    };
    if f.db_id.as_deref() != Some(m.db_id.as_str()) {
        return inconsistent("el db_id del marcador no es el de esta base");
    }
    match f.mode.as_deref() {
        Some(MODE_SQLITE_AUTHORITATIVE) => {
            if f.fenced && m.matches(f) {
                Boot::Complete
            } else {
                inconsistent("la base es autoritativa pero de otra promoción distinta de la del marcador")
            }
        }
        mode @ (Some(MODE_BOOTSTRAP) | None) => {
            if !f.fenced {
                return inconsistent("el marcador declara una intención de promoción pero la base no cruzó la valla de compatibilidad");
            }
            let row_ok = match f.row_rev {
                None => mode.is_none() && m.sqlite_bootstrap_rev == 0,
                Some(r) => mode == Some(MODE_BOOTSTRAP) && r == m.sqlite_bootstrap_rev,
            };
            if !row_ok {
                return inconsistent("la fila de estado de la base cambió desde que se fijó la intención de promoción");
            }
            match i.legacy {
                Legacy::Unreadable(why) => Boot::Block(BlockReason::LegacyUnreadable(why.clone())),
                // Un espejo escrito por C2b nunca es el legado que se iba a promocionar.
                Legacy::Readable { has_mirror: true, .. } => Boot::Block(BlockReason::MirrorWithoutAuthority),
                Legacy::Absent if m.source_hash == NO_SOURCE => Boot::Redo,
                Legacy::Readable { hash, bytes, .. } if *hash == m.source_hash && *bytes == m.source_bytes => Boot::Redo,
                _ => Boot::Block(BlockReason::LegacyChangedAfterIntent),
            }
        }
        Some(_) => inconsistent("el modo de la base es desconocido"),
    }
}

fn authoritative(i: &BootInputs<'_>, m: &Marker) -> Boot {
    let f = match i.probe {
        DbProbe::FileMissing => return inconsistent("el marcador declara la instalación promovida pero la base de datos no existe"),
        DbProbe::Unopenable(_) => return Boot::Block(BlockReason::NotVerifiable),
        DbProbe::Opens(f) => f,
    };
    if f.db_id.as_deref() != Some(m.db_id.as_str()) {
        return inconsistent("el db_id del marcador no es el de esta base");
    }
    if f.mode.as_deref() != Some(MODE_SQLITE_AUTHORITATIVE) {
        return inconsistent("el marcador declara la instalación promovida pero la base no es autoritativa (¿se restauró una copia anterior a la promoción?)");
    }
    if !f.fenced {
        return inconsistent("la base no cruzó la valla de compatibilidad");
    }
    if !m.matches(f) {
        return inconsistent("la promoción registrada en la base no es la del marcador, o la base es anterior a ella");
    }
    Boot::Normal
}
