//! El espejo `state.json` tras el cambio de autoridad (slice C2b).
//!
//! Desde la promoción, SQLite es la única fuente de verdad. `state.json` pasa a ser
//! un **espejo operativo, de diagnóstico y pieza de recuperación**: se reescribe tras
//! cada confirmación y NUNCA se importa de vuelta. **No es una garantía de
//! compatibilidad descendente**: un binario anterior que lo lea lo tomaría por la
//! verdad (ver `LIXBON-C2-diseno.md` §11.11), así que no se presenta como un modo
//! seguro de volver a una versión anterior.
//!
//! # Formato
//! El `State` serializado más una clave de primer nivel `_mirror`:
//! `{ "rev": <rev de la fila de SQLite>, "doc_sha256": <SHA-256 del documento de
//! SQLite>, "written_at": <ms>, "writer": "..." }`. Documento y metadatos viajan en el
//! mismo archivo, así que una publicación atómica los deja juntos. `State` no usa
//! `deny_unknown_fields`: un binario antiguo ignora la clave y, al reescribir el
//! archivo, la pierde — **su ausencia delata una escritura ajena**.
//!
//! # Reconciliación (en cada arranque autoritativo)
//! | `state.json`                                              | Resultado                                  |
//! |-----------------------------------------------------------|--------------------------------------------|
//! | `_mirror.rev == rev` y el hash coincide                   | nada                                       |
//! | `_mirror.rev < rev` (caída entre COMMIT y espejo)         | se regenera, sin copia                     |
//! | sin `_mirror`, `rev` mayor, o ilegible con contenido      | copia `state.json.divergente-<ts>`, se regenera |
//! | ausente o vacío                                           | se regenera                                |
//! | sin `_mirror` pero idéntico al legado recién promovido    | se regenera, sin copia                     |
//!
//! Nunca se mezcla contenido: SQLite gana.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::fsio;
use crate::store::{self, sha256_hex};

pub(super) const MIRROR_KEY: &str = "_mirror";
const STATE_FILE: &str = "state.json";

/// Bytes del espejo: el documento de SQLite más la clave `_mirror`.
pub(super) fn render(doc: &str, rev: i64) -> std::io::Result<Vec<u8>> {
    let mut value: Value = serde_json::from_str(doc).map_err(std::io::Error::other)?;
    let Some(obj) = value.as_object_mut() else {
        return Err(std::io::Error::other("el documento de estado no es un objeto JSON"));
    };
    obj.insert(
        MIRROR_KEY.into(),
        json!({
            "rev": rev,
            "doc_sha256": sha256_hex(doc.as_bytes()),
            "written_at": super::state::now_ms(),
            "writer": format!("lixbon-core {}", env!("CARGO_PKG_VERSION")),
        }),
    );
    serde_json::to_vec_pretty(&value).map_err(std::io::Error::other)
}

/// Escribe el espejo de forma atómica y durable.
pub(super) fn write_mirror(data: &Path, doc: &str, rev: i64) -> std::io::Result<()> {
    let bytes = render(doc, rev)?;
    let dest = data.join(STATE_FILE);
    let tmp = fsio::stage_durable(&dest, &bytes, false)?;
    store::crash_point("mirror_tmp_written");
    fsio::publish_durable(&tmp, &dest).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    store::crash_point("mirror_published");
    Ok(())
}

/// Qué se hizo con `state.json` al reconciliarlo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Reconciled {
    /// Ya era el espejo vigente: no se tocó.
    Current,
    /// No existía, estaba vacío o era el legado recién promovido: se escribió el espejo.
    Regenerated,
    /// Era un espejo de una revisión anterior (caída entre COMMIT y espejo): se actualizó.
    Stale,
    /// Contenía algo ajeno: se conservó una copia y se escribió el espejo.
    DivergentPreserved(PathBuf),
}

/// Copia diagnóstica de `state.json` como `state.json.<tipo>-<ms>`; nunca sobrescribe.
pub(super) fn preserve_copy(data: &Path, kind: &str) -> std::io::Result<PathBuf> {
    let src = data.join(STATE_FILE);
    let ms = super::state::now_ms();
    let mut n = 0;
    loop {
        let name = if n == 0 { format!("{STATE_FILE}.{kind}-{ms}") } else { format!("{STATE_FILE}.{kind}-{ms}-{n}") };
        let dest = data.join(name);
        if !dest.exists() {
            std::fs::copy(&src, &dest)?;
            fsio::restrict_to_owner(&dest);
            return Ok(dest);
        }
        n += 1;
    }
}

/// Reconcilia `state.json` con la fila de SQLite (`rev`, `doc`) y deja el espejo vigente.
/// `known_legacy_hash`: SHA-256 del legado que se promocionó, para no tratarlo como ajeno.
pub(super) fn reconcile(data: &Path, rev: i64, doc: &str, known_legacy_hash: Option<&str>) -> std::io::Result<Reconciled> {
    let path = data.join(STATE_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            write_mirror(data, doc, rev)?;
            return Ok(Reconciled::Regenerated);
        }
        Err(e) => return Err(e),
    };
    if bytes.is_empty() {
        write_mirror(data, doc, rev)?;
        return Ok(Reconciled::Regenerated);
    }
    let meta = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| v.get(MIRROR_KEY).cloned())
        .and_then(|m| Some((m.get("rev")?.as_i64()?, m.get("doc_sha256")?.as_str()?.to_string())));
    match meta {
        Some((r, h)) if r == rev && h == sha256_hex(doc.as_bytes()) => Ok(Reconciled::Current),
        Some((r, _)) if r < rev => {
            write_mirror(data, doc, rev)?;
            Ok(Reconciled::Stale)
        }
        None if known_legacy_hash == Some(sha256_hex(&bytes).as_str()) => {
            write_mirror(data, doc, rev)?;
            Ok(Reconciled::Regenerated)
        }
        _ => {
            let copy = preserve_copy(data, "divergente")?;
            write_mirror(data, doc, rev)?;
            Ok(Reconciled::DivergentPreserved(copy))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(n: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lixbon-mirror-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const DOC: &str = r#"{"runs":{},"tasks":{},"messages":[],"seq":4,"decisions":[]}"#;

    fn leer(d: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(d.join("state.json")).unwrap()).unwrap()
    }

    #[test]
    fn el_espejo_lleva_el_documento_y_la_revision() {
        let d = dir("formato");
        write_mirror(&d, DOC, 7).unwrap();
        let v = leer(&d);
        assert_eq!(v["seq"], 4);
        assert_eq!(v[MIRROR_KEY]["rev"], 7);
        assert_eq!(v[MIRROR_KEY]["doc_sha256"], sha256_hex(DOC.as_bytes()));
        // Sigue siendo un State válido: lo carga cualquier binario con el modelo actual.
        serde_json::from_value::<super::super::state::State>(v).unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ausente_o_vacio_se_regenera_sin_copia() {
        let d = dir("ausente");
        assert_eq!(reconcile(&d, 1, DOC, None).unwrap(), Reconciled::Regenerated);
        std::fs::write(d.join("state.json"), b"").unwrap();
        assert_eq!(reconcile(&d, 2, DOC, None).unwrap(), Reconciled::Regenerated);
        assert_eq!(leer(&d)[MIRROR_KEY]["rev"], 2);
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "sin copias");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_espejo_vigente_no_se_toca() {
        let d = dir("vigente");
        write_mirror(&d, DOC, 3).unwrap();
        let antes = std::fs::read(d.join("state.json")).unwrap();
        assert_eq!(reconcile(&d, 3, DOC, None).unwrap(), Reconciled::Current);
        assert_eq!(std::fs::read(d.join("state.json")).unwrap(), antes);
    }

    #[test]
    fn un_espejo_de_una_revision_anterior_se_regenera_sin_copia_divergente() {
        let d = dir("anterior");
        write_mirror(&d, DOC, 3).unwrap();
        assert_eq!(reconcile(&d, 4, r#"{"runs":{},"tasks":{},"messages":[],"seq":5}"#, None).unwrap(), Reconciled::Stale);
        assert_eq!(leer(&d)[MIRROR_KEY]["rev"], 4);
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "caída entre COMMIT y espejo: sin copia");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn lo_que_escribio_un_binario_antiguo_se_conserva_y_sqlite_gana() {
        let d = dir("ajeno");
        // Un binario antiguo reescribe sin `_mirror`.
        std::fs::write(d.join("state.json"), br#"{"runs":{},"tasks":{},"messages":[],"seq":99}"#).unwrap();
        let r = reconcile(&d, 5, DOC, None).unwrap();
        let Reconciled::DivergentPreserved(copia) = r else { panic!("{r:?}") };
        assert!(copia.file_name().unwrap().to_string_lossy().starts_with("state.json.divergente-"));
        assert!(std::fs::read_to_string(&copia).unwrap().contains("\"seq\":99"), "la copia conserva lo ajeno");
        assert_eq!(leer(&d)["seq"], 4, "SQLite gana");
        assert_eq!(leer(&d)[MIRROR_KEY]["rev"], 5);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_espejo_de_una_revision_mayor_o_con_otro_hash_es_ajeno() {
        let d = dir("mayor");
        write_mirror(&d, DOC, 9).unwrap();
        assert!(matches!(reconcile(&d, 5, DOC, None).unwrap(), Reconciled::DivergentPreserved(_)));
        let d2 = dir("hash");
        write_mirror(&d2, r#"{"runs":{},"tasks":{},"messages":[],"seq":1}"#, 5).unwrap();
        assert!(matches!(reconcile(&d2, 5, DOC, None).unwrap(), Reconciled::DivergentPreserved(_)), "misma rev, otro documento");
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&d2);
    }

    #[test]
    fn un_archivo_ilegible_con_contenido_se_conserva() {
        let d = dir("ilegible");
        std::fs::write(d.join("state.json"), b"{ truncado").unwrap();
        assert!(matches!(reconcile(&d, 1, DOC, None).unwrap(), Reconciled::DivergentPreserved(_)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn el_legado_recien_promovido_no_es_ajeno() {
        let d = dir("legado");
        let legado = br#"{"runs":{},"tasks":{},"messages":[],"seq":2}"#;
        std::fs::write(d.join("state.json"), legado).unwrap();
        let h = sha256_hex(legado);
        assert_eq!(reconcile(&d, 2, DOC, Some(&h)).unwrap(), Reconciled::Regenerated);
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "sin copia");
        let _ = std::fs::remove_dir_all(&d);
    }
}
