//! Journal durable de efectos externos cuyo registro en el Event Log falló.
//!
//! Las líneas v2 llevan la identidad de la ocurrencia, su hora y solo los campos `observed` permitidos
//! para reconstruir `effect.observed`. Las líneas v1 y las corruptas se conservan como diagnóstico.

use std::collections::{BTreeMap, HashSet};
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const FILE_NAME: &str = "unrecorded-effects.jsonl";
const MAX_LINE_BYTES: usize = 64 * 1024;

static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RecordV2 {
    pub(super) v: u8,
    pub(super) effect_id: String,
    pub(super) at: i64,
    pub(super) operation: String,
    pub(super) kind: String,
    pub(super) task: Option<String>,
    pub(super) run: Option<String>,
    pub(super) project: Option<String>,
    /// Instalación autenticada que produjo el efecto. Ausente en journals v2 anteriores a LXO-85.
    #[serde(default)]
    pub(super) client_id: Option<String>,
    pub(super) actor_kind: String,
    pub(super) actor_id: Option<String>,
    pub(super) channel: String,
    pub(super) observed: Value,
}

impl RecordV2 {
    /// `at` no cuenta: dos copias de la misma ocurrencia pueden haberse escrito en momentos distintos.
    fn same_occurrence(&self, other: &RecordV2) -> bool {
        self.v == other.v
            && self.effect_id == other.effect_id
            && self.operation == other.operation
            && self.kind == other.kind
            && self.task == other.task
            && self.run == other.run
            && self.project == other.project
            && self.client_id == other.client_id
            && self.actor_kind == other.actor_kind
            && self.actor_id == other.actor_id
            && self.channel == other.channel
            && self.observed == other.observed
    }
}

/// Qué efecto se recuperó: solo identificadores y vocabulario cerrado, apto para avisar a la persona.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RecoveredEffect {
    pub(super) operation: String,
    pub(super) kind: String,
    pub(super) task: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct RecoveryReport {
    pub(super) recovered: usize,
    pub(super) recovered_effects: Vec<RecoveredEffect>,
    pub(super) pending: usize,
    pub(super) legacy_v1: usize,
    pub(super) malformed: usize,
    pub(super) conflicting_ids: usize,
    /// La compactación (ACK) falló tras confirmar los eventos: las líneas siguen y el siguiente
    /// arranque las reintenta de forma idempotente.
    pub(super) ack_failed: Option<io::ErrorKind>,
}

#[derive(Debug)]
enum ParsedLine {
    V1,
    V2(RecordV2),
    Malformed,
}

#[derive(Debug)]
struct Line {
    raw: Vec<u8>,
    parsed: ParsedLine,
}

fn lock_journal() -> std::sync::MutexGuard<'static, ()> {
    JOURNAL_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn path(data: &Path) -> PathBuf {
    data.join(FILE_NAME)
}

fn temp_path(file_path: &Path) -> PathBuf {
    file_path.with_file_name(format!("{FILE_NAME}.{}.tmp", std::process::id()))
}

fn parse_line(raw: Vec<u8>) -> Option<Line> {
    if raw.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    let parsed = match serde_json::from_slice::<Value>(&raw) {
        Ok(value) if value.get("v").and_then(Value::as_u64) == Some(1) => ParsedLine::V1,
        Ok(value) if value.get("v").and_then(Value::as_u64) == Some(2) => {
            match serde_json::from_value::<RecordV2>(value) {
                Ok(record) if record.v == 2 => ParsedLine::V2(record),
                _ => ParsedLine::Malformed,
            }
        }
        _ => ParsedLine::Malformed,
    };
    Some(Line { raw, parsed })
}

fn read_lines(file: &Path) -> io::Result<Vec<Line>> {
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            if let Some(line) = parse_line(bytes[start..index].to_vec()) {
                lines.push(line);
            }
            start = index + 1;
        }
    }
    if start < bytes.len() {
        if let Some(line) = parse_line(bytes[start..].to_vec()) {
            lines.push(line);
        }
    }
    Ok(lines)
}

pub(super) fn append_v2(data: &Path, record: &RecordV2) -> io::Result<()> {
    append_v2_with(data, record, sync_parent)
}

/// `sync_dir` se invoca solo cuando esta llamada crea el archivo: es la entrada de directorio la que
/// aún no es durable, el contenido ya se sincroniza con `sync_data`.
fn append_v2_with(
    data: &Path,
    record: &RecordV2,
    sync_dir: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<()> {
    if record.v != 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "el journal solo escribe v2",
        ));
    }
    let mut encoded = serde_json::to_vec(record).map_err(io::Error::other)?;
    if encoded.len() > MAX_LINE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "registro del journal demasiado grande",
        ));
    }
    encoded.push(b'\n');

    let _guard = lock_journal();
    let file_path = path(data);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let created = !file_path.try_exists()?;
    let mut file = OpenOptions::new()
        .create(true)
        .read(true)
        .append(true)
        .open(&file_path)?;
    let len = file.metadata()?.len();
    if len > 0 {
        let mut last = [0u8; 1];
        file.seek(SeekFrom::Start(len - 1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            file.write_all(b"\n")?;
            file.sync_data()?;
        }
    }
    file.write_all(&encoded)?;
    file.sync_data()?;
    if created {
        sync_dir(&file_path)?;
    }
    Ok(())
}

pub(super) fn pending_count(data: &Path) -> io::Result<usize> {
    let _guard = lock_journal();
    Ok(read_lines(&path(data))?.len())
}

pub(super) fn reconcile(
    data: &Path,
    apply: impl FnMut(&RecordV2) -> bool,
) -> io::Result<RecoveryReport> {
    reconcile_with(data, apply, compact)
}

/// `apply` solo agrega hechos al Event Log; devolver `true` es el ACK de esa ocurrencia. El ACK
/// durable es la compactación: si falla, el evento ya está confirmado y el replay es idempotente.
fn reconcile_with(
    data: &Path,
    mut apply: impl FnMut(&RecordV2) -> bool,
    compact: impl FnOnce(&Path, &[Line], &HashSet<String>) -> io::Result<()>,
) -> io::Result<RecoveryReport> {
    let _guard = lock_journal();
    let file_path = path(data);
    let lines = read_lines(&file_path)?;
    if lines.is_empty() {
        return Ok(RecoveryReport::default());
    }

    let mut by_id: BTreeMap<String, Vec<RecordV2>> = BTreeMap::new();
    for line in &lines {
        if let ParsedLine::V2(record) = &line.parsed {
            by_id
                .entry(record.effect_id.clone())
                .or_default()
                .push(record.clone());
        }
    }

    let mut report = RecoveryReport::default();
    let mut acknowledged = HashSet::new();
    for (effect_id, records) in by_id {
        let Some(first) = records.first() else {
            continue;
        };
        if records
            .iter()
            .skip(1)
            .any(|record| !first.same_occurrence(record))
        {
            report.conflicting_ids += 1;
            continue;
        }
        if apply(first) {
            acknowledged.insert(effect_id);
            report.recovered += 1;
            report.recovered_effects.push(RecoveredEffect {
                operation: first.operation.clone(),
                kind: first.kind.clone(),
                task: first.task.clone().unwrap_or_default(),
            });
        }
    }

    if !acknowledged.is_empty() {
        if let Err(error) = compact(&file_path, &lines, &acknowledged) {
            report.ack_failed = Some(error.kind());
        }
    }
    let remaining = read_lines(&file_path)?;
    report.pending = remaining.len();
    report.legacy_v1 = remaining
        .iter()
        .filter(|line| matches!(line.parsed, ParsedLine::V1))
        .count();
    report.malformed = remaining
        .iter()
        .filter(|line| matches!(line.parsed, ParsedLine::Malformed))
        .count();
    Ok(report)
}

fn compact(file_path: &Path, lines: &[Line], acknowledged: &HashSet<String>) -> io::Result<()> {
    compact_with(file_path, lines, acknowledged, |from, to| fs::rename(from, to))
}

fn compact_with(
    file_path: &Path,
    lines: &[Line],
    acknowledged: &HashSet<String>,
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let retained = lines
        .iter()
        .filter(|line| !matches!(&line.parsed, ParsedLine::V2(record) if acknowledged.contains(&record.effect_id)))
        .collect::<Vec<_>>();
    if retained.is_empty() {
        match fs::remove_file(file_path) {
            Ok(()) => sync_parent(file_path),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }?;
        return Ok(());
    }

    let temp = temp_path(file_path);
    let written = write_temp(file_path, &temp, &retained)
        .and_then(|()| rename(&temp, file_path))
        .and_then(|()| sync_parent(file_path));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

fn write_temp(file_path: &Path, temp: &Path, retained: &[&Line]) -> io::Result<()> {
    let permissions = fs::metadata(file_path)
        .ok()
        .map(|metadata| metadata.permissions());
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(temp)?;
    if let Some(permissions) = permissions {
        fs::set_permissions(temp, permissions)?;
    }
    for line in retained {
        file.write_all(&line.raw)?;
        file.write_all(b"\n")?;
    }
    file.sync_all()
}

#[cfg(unix)]
fn sync_parent(file_path: &Path) -> io::Result<()> {
    if let Some(parent) = file_path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

// std no ofrece un flush de directorio en Windows (haría falta CreateFileW con
// FILE_FLAG_BACKUP_SEMANTICS y FlushFileBuffers, que además exige permisos de escritura sobre el directorio).
#[cfg(not(unix))]
fn sync_parent(_file_path: &Path) -> io::Result<()> {
    Ok(())
}

/// UUID v7 canónico en minúsculas, el formato exacto que genera `new_uuid_v7`: con mayúsculas el
/// `idem_key` difiriría del original y rompería la deduplicación.
pub(super) fn valid_effect_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
        })
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;
    use crate::store::new_uuid_v7;

    static N: AtomicUsize = AtomicUsize::new(0);

    struct Dir(PathBuf);

    impl Dir {
        fn new() -> Dir {
            let n = N.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!("lixbon-journal-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            Dir(dir)
        }

        fn file(&self) -> PathBuf {
            path(&self.0)
        }

        fn contents(&self) -> String {
            fs::read_to_string(self.file()).unwrap_or_default()
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn record(effect_id: &str) -> RecordV2 {
        RecordV2 {
            v: 2,
            effect_id: effect_id.to_string(),
            at: 1_800_000_000_000,
            operation: "spawn".into(),
            kind: "pty_process".into(),
            task: Some("t1".into()),
            run: Some("r1".into()),
            project: None,
            client_id: None,
            actor_kind: "system".into(),
            actor_id: None,
            channel: "core".into(),
            observed: json!({ "launched": true }),
        }
    }

    fn line_of(record: &RecordV2) -> String {
        serde_json::to_string(record).unwrap()
    }

    #[test]
    fn append_tras_una_ultima_linea_truncada_la_separa_y_conserva() {
        let dir = Dir::new();
        let truncated = r#"{"v":2,"effect_id":"trunc"#;
        fs::write(dir.file(), truncated).unwrap();
        let valid = record(&new_uuid_v7());

        append_v2(&dir.0, &valid).unwrap();

        assert_eq!(dir.contents(), format!("{truncated}\n{}\n", line_of(&valid)));
        let lines = read_lines(&dir.file()).unwrap();
        assert!(matches!(lines[0].parsed, ParsedLine::Malformed));
        assert!(matches!(&lines[1].parsed, ParsedLine::V2(r) if r.effect_id == valid.effect_id));
    }

    #[test]
    fn append_no_duplica_el_salto_de_linea_si_el_archivo_ya_termina_en_uno() {
        let dir = Dir::new();
        let (a, b) = (record(&new_uuid_v7()), record(&new_uuid_v7()));
        append_v2(&dir.0, &a).unwrap();
        append_v2(&dir.0, &b).unwrap();
        assert_eq!(dir.contents(), format!("{}\n{}\n", line_of(&a), line_of(&b)));
    }

    #[test]
    fn append_sincroniza_el_directorio_solo_al_crear_el_archivo_y_propaga_el_fallo() {
        let dir = Dir::new();
        let synced = Cell::new(0);
        let count = |_: &Path| {
            synced.set(synced.get() + 1);
            Ok(())
        };
        append_v2_with(&dir.0, &record(&new_uuid_v7()), count).unwrap();
        assert_eq!(synced.get(), 1, "el archivo se creó en esa llamada");
        append_v2_with(&dir.0, &record(&new_uuid_v7()), |_| panic!("el archivo ya existía")).unwrap();

        let nueva = Dir::new();
        let error = append_v2_with(&nueva.0, &record(&new_uuid_v7()), |_| Err(io::Error::other("sin fsync de directorio"))).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other, "no se afirma durabilidad si el directorio no se pudo sincronizar");
    }

    #[test]
    fn append_rechaza_v1_y_registros_desmedidos_sin_tocar_el_archivo() {
        let dir = Dir::new();
        let mut v1 = record(&new_uuid_v7());
        v1.v = 1;
        assert_eq!(append_v2(&dir.0, &v1).unwrap_err().kind(), io::ErrorKind::InvalidInput);
        let mut enorme = record(&new_uuid_v7());
        enorme.observed = json!({ "branch": "x".repeat(MAX_LINE_BYTES) });
        assert_eq!(append_v2(&dir.0, &enorme).unwrap_err().kind(), io::ErrorKind::InvalidData);
        assert!(!dir.file().exists());
    }

    #[test]
    fn el_ack_compacta_solo_lo_confirmado_y_conserva_v1_corruptas_y_desconocidas() {
        let dir = Dir::new();
        let (ok, rechazada) = (record(&new_uuid_v7()), record(&new_uuid_v7()));
        let v1 = r#"{"v":1,"operation":"manual","kind":"legacy"}"#;
        let corrupta = r#"{"v":2,"effect_id":"trunc"#;
        let futura = r#"{"v":3,"effect_id":"x"}"#;
        let con_campo_extra = r#"{"v":2,"effect_id":"x","futuro":true}"#;
        fs::write(dir.file(), format!("{v1}\n{corrupta}\n{futura}\n{con_campo_extra}\n{}\n{}\n", line_of(&ok), line_of(&rechazada))).unwrap();

        let report = reconcile(&dir.0, |r| r.effect_id == ok.effect_id).unwrap();

        assert_eq!((report.recovered, report.legacy_v1, report.malformed, report.pending), (1, 1, 3, 5));
        assert_eq!(report.recovered_effects, vec![RecoveredEffect { operation: "spawn".into(), kind: "pty_process".into(), task: "t1".into() }]);
        assert_eq!(report.ack_failed, None);
        assert_eq!(dir.contents(), format!("{v1}\n{corrupta}\n{futura}\n{con_campo_extra}\n{}\n", line_of(&rechazada)));
    }

    #[test]
    fn un_fallo_de_compactacion_deja_las_lineas_y_el_replay_aplica_la_misma_identidad() {
        let dir = Dir::new();
        let efecto = record(&new_uuid_v7());
        fs::write(dir.file(), format!("{}\n", line_of(&efecto))).unwrap();
        let confirmados = std::cell::RefCell::new(HashSet::new());
        let aplicar = |r: &RecordV2| {
            confirmados.borrow_mut().insert(r.effect_id.clone());
            true
        };

        let report = reconcile_with(&dir.0, aplicar, |_, _, _| Err(io::Error::from(io::ErrorKind::PermissionDenied))).unwrap();
        assert_eq!((report.recovered, report.pending, report.ack_failed), (1, 1, Some(io::ErrorKind::PermissionDenied)));
        assert_eq!(dir.contents(), format!("{}\n", line_of(&efecto)), "sin ACK la línea sigue");

        let report = reconcile(&dir.0, |r| {
            confirmados.borrow_mut().insert(r.effect_id.clone());
            true
        })
        .unwrap();
        assert_eq!((report.recovered, report.pending, report.ack_failed), (1, 0, None));
        assert_eq!(confirmados.borrow().len(), 1, "las dos pasadas ofrecen la MISMA identidad: el almacén la deduplica");
        assert!(!dir.file().exists());
    }

    #[test]
    fn un_fallo_real_al_crear_el_temporal_no_pierde_la_linea() {
        let dir = Dir::new();
        let (a, b) = (record(&new_uuid_v7()), record(&new_uuid_v7()));
        fs::write(dir.file(), format!("{}\n{}\n", line_of(&a), line_of(&b))).unwrap();
        fs::create_dir(temp_path(&dir.file())).unwrap();

        let report = reconcile(&dir.0, |r| r.effect_id == a.effect_id).unwrap();

        assert!(report.ack_failed.is_some());
        assert_eq!(report.pending, 2);
        assert_eq!(dir.contents(), format!("{}\n{}\n", line_of(&a), line_of(&b)));
    }

    #[test]
    fn si_falla_el_rename_el_temporal_se_borra_y_el_original_queda_intacto() {
        let dir = Dir::new();
        let (a, b) = (record(&new_uuid_v7()), record(&new_uuid_v7()));
        let original = format!("{}\n{}\n", line_of(&a), line_of(&b));
        fs::write(dir.file(), &original).unwrap();
        let lines = read_lines(&dir.file()).unwrap();
        let ack = HashSet::from([a.effect_id.clone()]);

        let error = compact_with(&dir.file(), &lines, &ack, |_, _| Err(io::Error::from(io::ErrorKind::PermissionDenied))).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(dir.contents(), original);
        assert!(!temp_path(&dir.file()).exists(), "no queda un temporal huérfano con datos del journal");
    }

    #[test]
    fn ids_conflictivos_no_se_aplican_ni_se_compactan_pero_no_bloquean_a_los_demas() {
        let dir = Dir::new();
        let id = new_uuid_v7();
        let (original, mut distinta) = (record(&id), record(&id));
        distinta.operation = "release".into();
        let sana = record(&new_uuid_v7());
        fs::write(dir.file(), format!("{}\n{}\n{}\n", line_of(&original), line_of(&distinta), line_of(&sana))).unwrap();
        let mut vistos = Vec::new();

        let report = reconcile(&dir.0, |r| {
            vistos.push(r.effect_id.clone());
            true
        })
        .unwrap();

        assert_eq!(vistos, vec![sana.effect_id.clone()]);
        assert_eq!((report.conflicting_ids, report.recovered, report.pending), (1, 1, 2));
        assert_eq!(dir.contents(), format!("{}\n{}\n", line_of(&original), line_of(&distinta)));
    }

    #[test]
    fn copias_identicas_con_otra_hora_se_aplican_una_vez_y_se_compactan_todas() {
        let dir = Dir::new();
        let mut a = record(&new_uuid_v7());
        let mut b = a.clone();
        a.at = 1_800_000_000_000;
        b.at = 1_800_000_999_000;
        fs::write(dir.file(), format!("{}\n{}\n", line_of(&a), line_of(&b))).unwrap();
        let mut llamadas = 0;

        let report = reconcile(&dir.0, |_| {
            llamadas += 1;
            true
        })
        .unwrap();

        assert_eq!((llamadas, report.recovered, report.conflicting_ids, report.pending), (1, 1, 0, 0));
        assert!(!dir.file().exists());
    }

    #[test]
    fn sin_ack_nada_se_toca_ni_se_reescribe_el_archivo() {
        let dir = Dir::new();
        let a = record(&new_uuid_v7());
        let original = format!("{}\n", line_of(&a));
        fs::write(dir.file(), &original).unwrap();

        let report = reconcile(&dir.0, |_| false).unwrap();

        assert_eq!((report.recovered, report.pending, report.ack_failed), (0, 1, None));
        assert_eq!(dir.contents(), original);
    }

    #[test]
    fn solo_un_uuid_v7_canonico_en_minusculas_es_una_identidad_valida() {
        assert!(valid_effect_id(&new_uuid_v7()));
        assert!(valid_effect_id("01900000-0000-7000-8000-000000000001"));
        for invalido in [
            "",
            "01900000-0000-4000-8000-000000000001",
            "01900000-0000-7000-c000-000000000001",
            "01900000-0000-7000-7000-000000000001",
            "01900000-0000-7000-8000-00000000000g",
            "01900000-0000-7000-8000-00000000000",
            "01900000-0000-7000-8000-0000000000011",
            "01900000_0000-7000-8000-000000000001",
            "01900000-0000-7000-8000-00000000000é",
            "01900000-0000-7000-8000-00000000000A",
            "01900000-0000-7000-8000-000000000001\n",
            " 1900000-0000-7000-8000-000000000001",
        ] {
            assert!(!valid_effect_id(invalido), "{invalido:?}");
        }
    }
}
