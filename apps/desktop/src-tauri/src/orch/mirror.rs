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
//! `{ "rev": <rev de la fila de SQLite>, "doc_sha256": <SHA-256 del contenido canónico>,
//! "written_at": <ms>, "writer": "..." }`. El contenido canónico es el documento sin
//! `_mirror`, con las claves de los objetos ordenadas y sin espacios: no depende de
//! cómo se imprimió ni del orden de las claves. Documento y metadatos viajan en el
//! mismo archivo, así que una publicación atómica los deja juntos. `State` no usa
//! `deny_unknown_fields`: un binario antiguo ignora la clave y, al reescribir el
//! archivo, la pierde — **su ausencia delata una escritura ajena**.
//!
//! # El `_mirror` no se cree: se comprueba
//! `_mirror` es metadata declarada dentro del propio archivo. Quien modifique
//! `runs/tasks/messages/seq/decisions` conservando `_mirror` no puede hacer pasar el
//! archivo por vigente: se recalcula el hash del contenido y debe coincidir con el
//! declarado (el archivo es coherente consigo mismo), y para ser `Current` además con
//! el documento de SQLite. Un `_mirror` incoherente con su contenido es una
//! modificación ajena, aunque su `rev` sea menor que el de SQLite.
//!
//! # Reconciliación (en cada arranque autoritativo)
//! | `state.json`                                                              | Resultado                                  |
//! |---------------------------------------------------------------------------|--------------------------------------------|
//! | coherente, `_mirror.rev == rev` y el contenido es el de SQLite            | nada                                       |
//! | coherente y `_mirror.rev < rev` (caída entre COMMIT y espejo)             | se regenera, sin copia                     |
//! | `_mirror` que no describe su contenido (editado), `rev` mayor o distinto  | copia `state.json.divergente-<ts>`, se regenera |
//! | sin `_mirror`, o ilegible con contenido                                   | copia `state.json.divergente-<ts>`, se regenera |
//! | ausente o vacío                                                           | se regenera                                |
//! | sin `_mirror` pero idéntico al legado recién promovido                    | se regenera, sin copia                     |
//!
//! Nunca se mezcla contenido: SQLite gana.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::fsio;
use crate::store::{self, sha256_hex};

pub(super) const MIRROR_KEY: &str = "_mirror";
const STATE_FILE: &str = "state.json";

/// Forma canónica de un valor JSON: claves de objeto ordenadas y sin espacios.
fn canonical(v: &Value, out: &mut String) {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(k.clone()).to_string());
                out.push(':');
                canonical(&m[k], out);
            }
            out.push('}');
        }
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical(x, out);
            }
            out.push(']');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

/// SHA-256 del contenido canónico de `v` (sin tocar `_mirror`: quien llama lo quita antes).
pub(super) fn canonical_hash(v: &Value) -> String {
    let mut s = String::new();
    canonical(v, &mut s);
    sha256_hex(s.as_bytes())
}

/// Bytes del espejo: el documento de SQLite más la clave `_mirror`.
pub(super) fn render(doc: &str, rev: i64) -> std::io::Result<Vec<u8>> {
    let mut value: Value = serde_json::from_str(doc).map_err(std::io::Error::other)?;
    let Some(obj) = value.as_object_mut() else {
        return Err(std::io::Error::other("el documento de estado no es un objeto JSON"));
    };
    obj.remove(MIRROR_KEY);
    let doc_sha256 = canonical_hash(&value);
    let Some(obj) = value.as_object_mut() else { unreachable!("comprobado arriba") };
    obj.insert(
        MIRROR_KEY.into(),
        json!({
            "rev": rev,
            "doc_sha256": doc_sha256,
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
    let mut file = serde_json::from_slice::<Value>(&bytes).ok();
    let meta = file
        .as_ref()
        .and_then(|v| v.get(MIRROR_KEY).cloned())
        .and_then(|m| Some((m.get("rev")?.as_i64()?, m.get("doc_sha256")?.as_str()?.to_string())));
    // Hash del CONTENIDO real del archivo (sin `_mirror`), recalculado: lo declarado no se cree.
    let content_hash = file.as_mut().and_then(|v| {
        v.as_object_mut()?.remove(MIRROR_KEY);
        Some(canonical_hash(v))
    });
    // Hash del documento de SQLite en la misma forma canónica.
    let sqlite_hash = serde_json::from_str::<Value>(doc).map(|mut v| {
        if let Some(o) = v.as_object_mut() {
            o.remove(MIRROR_KEY);
        }
        canonical_hash(&v)
    });
    let sqlite_hash = sqlite_hash.map_err(std::io::Error::other)?;
    match meta {
        // El archivo describe fielmente su propio contenido: sólo entonces vale su `rev`.
        Some((r, h)) if content_hash.as_deref() == Some(h.as_str()) => {
            if r == rev && h == sqlite_hash {
                Ok(Reconciled::Current)
            } else if r < rev {
                // Caída entre COMMIT y espejo: es un espejo anterior íntegro.
                write_mirror(data, doc, rev)?;
                Ok(Reconciled::Stale)
            } else {
                // Misma `rev` con otro contenido, o `rev` mayor que la de SQLite.
                let copy = preserve_copy(data, "divergente")?;
                write_mirror(data, doc, rev)?;
                Ok(Reconciled::DivergentPreserved(copy))
            }
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
        assert_eq!(v[MIRROR_KEY]["doc_sha256"], canonical_hash(&serde_json::from_str(DOC).unwrap()));
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

    /// Documento con tareas, para poder editar «una tarea» además de `seq`.
    const DOC_TAREAS: &str = r#"{"runs":{},"tasks":{"t1":{"id":"t1","title":"original","status":"working"}},"messages":[],"seq":7,"decisions":[]}"#;

    /// Espejo válido en `rev`; devuelve el contenido del archivo ya parseado.
    fn espejo_valido(d: &Path, rev: i64) -> Value {
        write_mirror(d, DOC_TAREAS, rev).unwrap();
        leer(d)
    }

    fn escribe(d: &Path, v: &Value) {
        std::fs::write(d.join("state.json"), serde_json::to_vec_pretty(v).unwrap()).unwrap();
    }

    /// Comprueba que SQLite gana: el archivo vuelve a ser el espejo de `DOC_TAREAS` en `rev`.
    fn restaurado(d: &Path, rev: i64) {
        let v = leer(d);
        assert_eq!(v["seq"], 7);
        assert_eq!(v["tasks"]["t1"]["title"], "original");
        assert_eq!(v[MIRROR_KEY]["rev"], rev);
        assert_eq!(reconcile(d, rev, DOC_TAREAS, None).unwrap(), Reconciled::Current, "el espejo regenerado es vigente");
    }

    #[test]
    fn editar_seq_conservando_el_mirror_no_es_vigente_y_se_restaura() {
        let d = dir("editar-seq");
        let mut v = espejo_valido(&d, 5);
        v["seq"] = serde_json::json!(999);
        escribe(&d, &v);
        // `_mirror.rev == rev` y `_mirror.doc_sha256` coinciden con SQLite, pero el contenido ya no.
        let r = reconcile(&d, 5, DOC_TAREAS, None).unwrap();
        let Reconciled::DivergentPreserved(copia) = r else { panic!("no debe ser vigente: {r:?}") };
        assert!(std::fs::read_to_string(&copia).unwrap().contains("999"), "la copia conserva la edición");
        restaurado(&d, 5);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn editar_una_tarea_conservando_el_mirror_no_es_vigente_y_se_restaura() {
        let d = dir("editar-tarea");
        let mut v = espejo_valido(&d, 5);
        v["tasks"]["t1"]["title"] = serde_json::json!("manipulada");
        v["tasks"]["t2"] = serde_json::json!({"id": "t2"});
        escribe(&d, &v);
        let r = reconcile(&d, 5, DOC_TAREAS, None).unwrap();
        let Reconciled::DivergentPreserved(copia) = r else { panic!("{r:?}") };
        assert!(std::fs::read_to_string(&copia).unwrap().contains("manipulada"));
        restaurado(&d, 5);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_mirror_con_rev_menor_no_oculta_una_edicion_ajena() {
        let d = dir("rev-menor-editada");
        // Espejo íntegro de la rev 3 y SQLite ya en la 4: caída entre COMMIT y espejo, sin copia.
        espejo_valido(&d, 3);
        assert_eq!(reconcile(&d, 4, DOC_TAREAS, None).unwrap(), Reconciled::Stale);
        // Pero si además se EDITÓ el contenido, `_mirror.rev < rev` no basta para darlo por inofensivo.
        let mut v = espejo_valido(&d, 3);
        v["seq"] = serde_json::json!(1234);
        escribe(&d, &v);
        let r = reconcile(&d, 4, DOC_TAREAS, None).unwrap();
        let Reconciled::DivergentPreserved(copia) = r else { panic!("la edición no puede pasar por Stale: {r:?}") };
        assert!(std::fs::read_to_string(&copia).unwrap().contains("1234"));
        restaurado(&d, 4);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_mirror_con_metadata_inventada_no_vale() {
        let d = dir("metadata-inventada");
        // Hash declarado que no corresponde al contenido, con rev igual, menor o mayor.
        for (declarada, rev) in [(5, 5), (2, 5), (9, 5)] {
            let mut v = espejo_valido(&d, 5);
            v[MIRROR_KEY]["rev"] = serde_json::json!(declarada);
            v[MIRROR_KEY]["doc_sha256"] = serde_json::json!("0".repeat(64));
            escribe(&d, &v);
            assert!(matches!(reconcile(&d, rev, DOC_TAREAS, None).unwrap(), Reconciled::DivergentPreserved(_)), "rev declarada {declarada}");
            restaurado(&d, rev);
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_cambio_solo_de_formato_u_orden_de_claves_sigue_siendo_vigente() {
        let d = dir("formato");
        let v = espejo_valido(&d, 5);
        // Otro formato y otro orden de claves: mismo contenido.
        let mut reordenado = serde_json::Map::new();
        for k in ["seq", "decisions", "messages", "tasks", "runs", MIRROR_KEY] {
            reordenado.insert(k.to_string(), v[k].clone());
        }
        std::fs::write(d.join("state.json"), serde_json::to_vec(&Value::Object(reordenado)).unwrap()).unwrap();
        assert_eq!(reconcile(&d, 5, DOC_TAREAS, None).unwrap(), Reconciled::Current);
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "sin copias");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn el_hash_canonico_no_depende_del_orden_de_claves_ni_de_los_espacios() {
        let a: Value = serde_json::from_str(r#"{"b":[1,{"y":2,"x":1}],"a":"x"}"#).unwrap();
        let b: Value = serde_json::from_str("{ \"a\": \"x\",\n \"b\": [1, {\"x\": 1, \"y\": 2}] }").unwrap();
        let c: Value = serde_json::from_str(r#"{"b":[{"y":2,"x":1},1],"a":"x"}"#).unwrap();
        assert_eq!(canonical_hash(&a), canonical_hash(&b));
        assert_ne!(canonical_hash(&a), canonical_hash(&c), "el orden de un array sí importa");
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
