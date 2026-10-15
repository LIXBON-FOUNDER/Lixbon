//! Durable journal for external effects whose Event Log append failed.
//!
//! V2 records carry the occurrence identity and only the allowlisted `observed` fields
//! needed to rebuild `effect.observed`. V1 rows and malformed rows remain diagnostic.

use std::collections::{BTreeMap, HashSet};
#[cfg(unix)]
use std::fs::File;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
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
    pub(super) actor_kind: String,
    pub(super) actor_id: Option<String>,
    pub(super) channel: String,
    pub(super) observed: Value,
}

impl RecordV2 {
    fn same_occurrence(&self, other: &RecordV2) -> bool {
        self.v == other.v
            && self.effect_id == other.effect_id
            && self.operation == other.operation
            && self.kind == other.kind
            && self.task == other.task
            && self.run == other.run
            && self.project == other.project
            && self.actor_kind == other.actor_kind
            && self.actor_id == other.actor_id
            && self.channel == other.channel
            && self.observed == other.observed
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(super) struct RecoveryReport {
    pub(super) recovered: usize,
    pub(super) pending: usize,
    pub(super) legacy_v1: usize,
    pub(super) malformed: usize,
    pub(super) conflicting_ids: usize,
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

fn path(data: &Path) -> std::path::PathBuf {
    data.join(FILE_NAME)
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
    if record.v != 2 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "el journal solo escribe v2",
        ));
    }
    let encoded = serde_json::to_vec(record).map_err(io::Error::other)?;
    if encoded.len() > MAX_LINE_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "registro del journal demasiado grande",
        ));
    }

    let _guard = lock_journal();
    let file_path = path(data);
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let needs_separator = match fs::read(&file_path) {
        Ok(bytes) => !bytes.is_empty() && !bytes.ends_with(b"\n"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)?;
    if needs_separator {
        file.write_all(b"\n")?;
        file.sync_data()?;
    }
    file.write_all(&encoded)?;
    file.write_all(b"\n")?;
    file.sync_data()
}

pub(super) fn pending_count(data: &Path) -> io::Result<usize> {
    let _guard = lock_journal();
    Ok(read_lines(&path(data))?.len())
}

pub(super) fn reconcile(
    data: &Path,
    mut apply: impl FnMut(&RecordV2) -> bool,
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
        }
    }

    if !acknowledged.is_empty() {
        compact(&file_path, &lines, &acknowledged)?;
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

    let temp = file_path.with_file_name(format!("{FILE_NAME}.{}.tmp", std::process::id()));
    let permissions = fs::metadata(file_path)
        .ok()
        .map(|metadata| metadata.permissions());
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)?;
    if let Some(permissions) = permissions {
        fs::set_permissions(&temp, permissions)?;
    }
    for line in retained {
        file.write_all(&line.raw)?;
        file.write_all(b"\n")?;
    }
    file.sync_all()?;
    drop(file);
    fs::rename(&temp, file_path)?;
    sync_parent(file_path)
}

#[cfg(unix)]
fn sync_parent(file_path: &Path) -> io::Result<()> {
    if let Some(parent) = file_path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent(_file_path: &Path) -> io::Result<()> {
    Ok(())
}

pub(super) fn valid_effect_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36
        || bytes[8] != b'-'
        || bytes[13] != b'-'
        || bytes[18] != b'-'
        || bytes[23] != b'-'
        || bytes[14] != b'7'
    {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| matches!(index, 8 | 13 | 18 | 23) || byte.is_ascii_hexdigit())
    {
        return false;
    }
    matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b')
}
