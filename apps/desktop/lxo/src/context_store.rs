//! `lxo context export` e `import`: sacar un ContextPackage v1 a un archivo y volver a meterlo, sin iniciar nada (LXO-138).
//!
//! El Core construye el paquete a partir de un Attempt, lo guarda y lo valida (`context_package_build`, `context_package_get`,
//! `context_package_import`, `docs/core/QUERIES.md`); lxo solo lo trae y lo deja en un archivo que la persona elige, o lo lee de un archivo
//! y se lo da al Core. lxo no calcula ningún hash ni busca secretos: la identidad, los secretos y los adjuntos los comprueba el Core al
//! importar, por la misma puerta por la que un paquete entra a un Attempt.
//!
//! * **El archivo es explícito y privado**: `--out` es obligatorio, no se sobrescribe sin `--force`, no se crea la carpeta que falta y se
//!   escribe con permisos solo del dueño (0600; 0700 la carpeta de adjuntos) donde el sistema los admite. El paquete sale tal cual lo
//!   guardó el Core (inmutable); los adjuntos, en `<archivo>.attachments/att-<id>`, cada uno con el nombre de su id.
//! * **Importar valida antes de guardar**: un paquete alterado, de otra versión, con un secreto o con un adjunto que no coincide sale con 7
//!   y no se guarda ni se muestra. Importar deja el paquete preparado para un Attempt futuro; no inicia ninguno.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde_json::{json, Map, Value};

use crate::events::clean;
use crate::projects::{usage, Failure};

/// Lo máximo que viaja de adjuntos por el RPC del Core (`MAX_RPC_ATTACHMENT_BYTES`).
pub(super) const MAX_ATTACHMENTS_BYTES: usize = 2 * 1024 * 1024;
/// Un paquete admite como mucho 128 adjuntos (`MAX_ATTACHMENTS`).
const MAX_ATTACHMENTS: usize = 128;
const MAX_ATTACHMENT_BYTES: usize = 1024 * 1024;
const ATTACHMENTS_SUFFIX: &str = ".attachments";

/// Qué se exporta: un paquete ya guardado, el último de un Attempt, o uno construido ahora desde un Attempt.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Target {
    Package(String),
    AttemptStored(String),
    AttemptBuild(String),
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ExportOpts {
    pub target: Target,
    pub out: String,
    pub force: bool,
}

/// `package_id` = `sha256:` + 64 hex.
pub(super) fn is_package_id(s: &str) -> bool {
    s.len() == 71 && s.starts_with("sha256:") && s[7..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Un id de Attempt (`<task>-a<n>`): lo que NO es una ruta. Sirve para decidir si `lxo context show X` es un archivo o un intento.
pub(super) fn looks_like_attempt_id(s: &str) -> bool {
    let Some((task, n)) = s.rsplit_once("-a") else {
        return false;
    };
    !task.is_empty()
        && !n.is_empty()
        && n.bytes().all(|b| b.is_ascii_digit())
        && task
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

pub(super) fn parse_export(
    target: Option<&str>,
    out: Option<String>,
    force: bool,
    stored: bool,
) -> Result<ExportOpts, Failure> {
    let target = target
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            usage("Falta qué exportar: lxo context export <package_id|attempt_id> --out <archivo>.")
        })?;
    let out = out.ok_or_else(|| {
        usage("Falta --out <archivo>: el archivo de destino se elige siempre, lxo no lo adivina.")
    })?;
    if out == "-" {
        return Err(usage(
            "--out - no vale: el paquete se escribe en un archivo con permisos privados, no en la salida estándar.",
        ));
    }
    let target = if is_package_id(target) {
        if stored {
            return Err(usage(
                "--stored solo vale con un intento: un package_id ya es un paquete guardado.",
            ));
        }
        Target::Package(target.to_string())
    } else if looks_like_attempt_id(target) {
        if stored {
            Target::AttemptStored(target.to_string())
        } else {
            Target::AttemptBuild(target.to_string())
        }
    } else {
        return Err(usage(format!(
            "«{}» no es un package_id (sha256:…) ni un id de intento (<tarea>-a<n>).",
            clean(target)
        )));
    };
    Ok(ExportOpts { target, out, force })
}

fn attachments_dir(out: &str) -> PathBuf {
    PathBuf::from(format!("{out}{ATTACHMENTS_SUFFIX}"))
}

/// El nombre de archivo de un adjunto: su id sin los dos puntos (que Windows no admite en un nombre).
fn attachment_file_name(id: &str) -> String {
    id.replacen("att:", "att-", 1)
}

fn attachment_id_of(file_name: &str) -> Option<String> {
    let hex = file_name.strip_prefix("att-")?;
    (hex.len() == 16 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        .then(|| format!("att:{hex}"))
}

// ── Escritura privada ───────────────────────────────────────────────────────────────────────────────────────────────────

fn private_options(force: bool) -> std::fs::OpenOptions {
    let mut o = std::fs::OpenOptions::new();
    o.write(true);
    if force {
        o.create(true).truncate(true);
    } else {
        // `create_new`: si alguien lo creó entre la comprobación y ahora, falla en vez de pisarlo.
        o.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o
}

fn write_private(path: &Path, bytes: &[u8], force: bool) -> Result<(), Failure> {
    let shown = clean(&path.to_string_lossy());
    let mut file = private_options(force)
        .open(path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => usage(format!(
                "«{shown}» ya existe: lxo no sobrescribe sin --force."
            )),
            std::io::ErrorKind::PermissionDenied => {
                usage(format!("Sin permiso para escribir «{shown}»."))
            }
            std::io::ErrorKind::NotFound => usage(format!(
                "No existe la carpeta de «{shown}»: lxo no la crea; créala o elige otra ruta."
            )),
            _ => usage(format!("No se pudo crear «{shown}»: {e}.")),
        })?;
    let written = file.write_all(bytes).and_then(|_| file.flush());
    if let Err(e) = written {
        drop(file);
        // Un archivo a medias no es un paquete: no se deja.
        let _ = std::fs::remove_file(path);
        return Err(usage(format!("No se pudo escribir «{shown}»: {e}.")));
    }
    // Con --force sobre un archivo que ya existía, `mode` no se aplica: se restringe igualmente donde el sistema lo admite.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn make_private_dir(path: &Path) -> Result<(), Failure> {
    let shown = clean(&path.to_string_lossy());
    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(e) => {
            return Err(usage(format!(
                "No se pudo crear la carpeta «{shown}»: {e}."
            )))
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Lo que se comprueba ANTES de pedir nada al Core: que el destino se pueda escribir, para no construir un paquete que no cabe donde se pide.
pub(super) fn check_export_destination(out: &str, force: bool) -> Result<(), Failure> {
    let shown = clean(out);
    let path = Path::new(out);
    if path.is_dir() {
        return Err(usage(format!(
            "«{shown}» es una carpeta: --out es el archivo del paquete."
        )));
    }
    if path.exists() && !force {
        return Err(usage(format!(
            "«{shown}» ya existe: lxo no sobrescribe sin --force."
        )));
    }
    let dir = attachments_dir(out);
    if dir.exists() && !dir.is_dir() {
        return Err(usage(format!(
            "«{}» existe y no es una carpeta: ahí van los adjuntos.",
            clean(&dir.to_string_lossy())
        )));
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        if !parent.is_dir() {
            return Err(usage(format!(
                "No existe la carpeta de «{shown}»: lxo no la crea; créala o elige otra ruta."
            )));
        }
    }
    Ok(())
}

// ── Exportar ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// El paquete y sus adjuntos, ya validados en su forma (el Core es quien los verificó al guardarlos).
pub(super) fn exportable(view: &Value) -> Result<(String, BTreeMap<String, Vec<u8>>), Failure> {
    let bad = || {
        Failure::Version(
            "El Core devolvió el paquete con un formato que este lxo no entiende; actualiza Lixbon.".into(),
        )
    };
    if view["status"] != "valid" || !view["package"].is_object() {
        return Err(bad());
    }
    let declared: Vec<&Value> = view["package"]["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .collect();
    let data = view["attachment_data"].as_object().ok_or_else(bad)?;
    let mut files = BTreeMap::new();
    for (id, b64) in data {
        attachment_id_of(&attachment_file_name(id)).ok_or_else(bad)?;
        if !declared.iter().any(|a| a["id"] == id.as_str()) {
            return Err(bad());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_str().ok_or_else(bad)?)
            .map_err(|_| bad())?;
        files.insert(id.clone(), bytes);
    }
    // Todo adjunto que viaja (no omitido) tiene que haber llegado: un paquete exportado sin sus bytes no se importaría.
    for a in &declared {
        let id = a["id"].as_str().ok_or_else(bad)?;
        if a["omitted"].is_null() && !files.contains_key(id) {
            return Err(bad());
        }
    }
    let text = serde_json::to_string_pretty(&view["package"]).map_err(|_| bad())? + "\n";
    Ok((text, files))
}

/// Escribe el paquete y sus adjuntos y devuelve el resumen de lo escrito (sin contenido).
pub(super) fn write_export(
    out: &str,
    force: bool,
    view: &Value,
    built: bool,
) -> Result<Value, Failure> {
    let (text, files) = exportable(view)?;
    check_export_destination(out, force)?;
    let dir = attachments_dir(out);
    let mut written = vec![];
    if !files.is_empty() {
        make_private_dir(&dir)?;
        for (id, bytes) in &files {
            let path = dir.join(attachment_file_name(id));
            write_private(&path, bytes, force)?;
            written.push(json!({ "id": id, "bytes": bytes.len(), "file": path.to_string_lossy() }));
        }
    }
    // El paquete al final: si algo falló antes, no queda un paquete sin sus adjuntos.
    write_private(Path::new(out), text.as_bytes(), force)?;
    let omitted: Vec<&str> = view["package"]["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| !a["omitted"].is_null())
        .filter_map(|a| a["id"].as_str())
        .collect();
    Ok(json!({
        "v": 1,
        "status": "exported",
        "package_id": view["package_id"],
        "built": built,
        "file": out,
        "bytes": text.len(),
        "attachments_dir": if files.is_empty() { Value::Null } else { json!(dir.to_string_lossy()) },
        "attachments": written,
        "omitted": omitted,
        "summary": view["summary"],
    }))
}

pub(super) fn export_text(r: &Value) -> String {
    let mut lines = vec![format!(
        "Paquete {} {}.",
        r["package_id"].as_str().map(clean).unwrap_or_default(),
        if r["built"] == true {
            "construido desde el intento y guardado en el Core"
        } else {
            "guardado en el Core"
        }
    )];
    lines.push(format!(
        "  Archivo:      {} ({} bytes)",
        r["file"].as_str().map(clean).unwrap_or_default(),
        r["bytes"].as_u64().unwrap_or(0)
    ));
    match r["attachments_dir"].as_str() {
        Some(dir) => {
            lines.push(format!(
                "  Adjuntos:     {} en {}",
                r["attachments"].as_array().map_or(0, Vec::len),
                clean(dir)
            ));
        }
        None => lines.push("  Adjuntos:     ninguno".into()),
    }
    let omitted = r["omitted"].as_array().map_or(0, Vec::len);
    if omitted > 0 {
        lines.push(format!(
            "  Omitidos:     {omitted} (no viajan: llevaban algo con forma de secreto)"
        ));
    }
    if r["summary"]["completeness"] == "partial" {
        lines.push("  Completitud:  PARCIAL: falta algo que el receptor necesitaría (lxo context show lo detalla)".into());
    }
    lines.push(
        "  El paquete no lleva secretos y es inmutable; no se ha iniciado ningún intento.".into(),
    );
    lines.push("  Para usarlo en otro Core: lxo context import <archivo> (con su carpeta de adjuntos al lado).".into());
    lines.join("\n")
}

// ── Importar ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Los adjuntos de al lado del archivo del paquete (`<archivo>.attachments/att-<id>`) como `{id: base64}`, o nada si no hay carpeta.
pub(super) fn read_attachments(file: &str) -> Result<Option<Map<String, Value>>, Failure> {
    let dir = attachments_dir(file);
    let shown = clean(&dir.to_string_lossy());
    let meta = match std::fs::metadata(&dir) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(usage(format!("No se pudo leer «{shown}»: {e}."))),
    };
    if !meta.is_dir() {
        return Err(usage(format!(
            "«{shown}» existe y no es una carpeta: ahí van los adjuntos."
        )));
    }
    let entries =
        std::fs::read_dir(&dir).map_err(|e| usage(format!("No se pudo leer «{shown}»: {e}.")))?;
    let mut out = Map::new();
    let mut total = 0usize;
    for entry in entries {
        let entry = entry.map_err(|e| usage(format!("No se pudo leer «{shown}»: {e}.")))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let id = attachment_id_of(&name).ok_or_else(|| {
            usage(format!(
                "«{shown}» tiene un archivo que no es un adjunto (att-<16 hex>): «{}».",
                clean(&name)
            ))
        })?;
        if out.len() >= MAX_ATTACHMENTS {
            return Err(usage(format!(
                "«{shown}» tiene más de {MAX_ATTACHMENTS} adjuntos: un paquete no admite más."
            )));
        }
        let path = entry.path();
        let m = std::fs::metadata(&path).map_err(|e| {
            usage(format!(
                "No se pudo leer el adjunto «{}»: {e}.",
                clean(&name)
            ))
        })?;
        if !m.is_file() {
            return Err(usage(format!(
                "El adjunto «{}» no es un archivo.",
                clean(&name)
            )));
        }
        if m.len() as usize > MAX_ATTACHMENT_BYTES {
            return Err(usage(format!(
                "El adjunto «{}» pesa más de {} KiB: un adjunto no pasa de ese tamaño.",
                clean(&name),
                MAX_ATTACHMENT_BYTES / 1024
            )));
        }
        let bytes = std::fs::read(&path).map_err(|e| {
            usage(format!(
                "No se pudo leer el adjunto «{}»: {e}.",
                clean(&name)
            ))
        })?;
        total += bytes.len();
        if total > MAX_ATTACHMENTS_BYTES {
            return Err(usage(format!(
                "Los adjuntos de «{shown}» pesan más de {} KiB: por el RPC del Core no viajan más.",
                MAX_ATTACHMENTS_BYTES / 1024
            )));
        }
        out.insert(
            id,
            Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
        );
    }
    Ok(Some(out))
}

pub(super) fn import_text(data: &Value) -> String {
    let created = data["stored"]["created"].as_bool();
    let mut lines = vec![format!(
        "Paquete {} {}.",
        data["package_id"].as_str().map(clean).unwrap_or_default(),
        match created {
            Some(true) => "importado y guardado en el Core",
            Some(false) => "ya estaba guardado en el Core: no se escribió nada",
            None => "guardado en el Core",
        }
    )];
    lines.push(format!(
        "  Verificación: {}",
        crate::context::verification_line(&data["verification"])
    ));
    let atts = data["attachments"].as_array().map_or(0, Vec::len);
    let kept = data["attachments"]
        .as_array()
        .map_or(0, |a| a.iter().filter(|x| x["stored"] == true).count());
    lines.push(format!(
        "  Adjuntos:     {atts} declarados · {kept} guardados con su sha256 comprobado por el Core"
    ));
    if data["summary"]["completeness"] == "partial" {
        lines.push("  Completitud:  PARCIAL: falta algo que el receptor necesitaría".into());
    }
    lines.push("  Queda preparado para un intento futuro: no se ha iniciado ninguno.".into());
    lines.push("  Para verlo: lxo context show <package_id>.".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lxo-ctxstore-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const ID: &str = "sha256:ed8802df89b2fc0ce7b1535f6233a49548df5bdfd5ffaa984ccb6c2cd213b6a4";

    #[test]
    fn los_ids_se_reconocen_sin_confundirlos_con_rutas() {
        assert!(is_package_id(ID));
        for bad in [
            "sha256:abc",
            "md5:ed8802df89b2fc0ce7b1535f6233a49548df5bdfd5ffaa984ccb6c2cd213b6a4",
            "",
            "sha256:zz02df89b2fc0ce7b1535f6233a49548df5bdfd5ffaa984ccb6c2cd213b6a4",
        ] {
            assert!(!is_package_id(bad), "{bad}");
        }
        for ok in ["t3-a1", "t12-a10", "r1.t3-a2"] {
            assert!(looks_like_attempt_id(ok), "{ok}");
        }
        for bad in [
            "paquete.json",
            "./t3-a1",
            "C:\\t3-a1",
            "t3-a",
            "-a1",
            "t3-a1/x",
            "dir/t3-a1",
            "t3-a1.json",
        ] {
            assert!(!looks_like_attempt_id(bad), "{bad}");
        }
    }

    #[test]
    fn export_pide_destino_y_distingue_que_se_exporta() {
        let p = |t: Option<&str>, out: Option<&str>, stored: bool| {
            parse_export(t, out.map(String::from), false, stored)
        };
        assert_eq!(
            p(Some(ID), Some("a.json"), false).unwrap().target,
            Target::Package(ID.into())
        );
        assert_eq!(
            p(Some("t3-a1"), Some("a.json"), false).unwrap().target,
            Target::AttemptBuild("t3-a1".into())
        );
        assert_eq!(
            p(Some("t3-a1"), Some("a.json"), true).unwrap().target,
            Target::AttemptStored("t3-a1".into())
        );
        for (t, out, stored, wanted) in [
            (None, Some("a.json"), false, "Falta qué exportar"),
            (Some("t3-a1"), None, false, "Falta --out"),
            (Some("t3-a1"), Some("-"), false, "--out - no vale"),
            (
                Some(ID),
                Some("a.json"),
                true,
                "--stored solo vale con un intento",
            ),
            (
                Some("algo raro"),
                Some("a.json"),
                false,
                "no es un package_id",
            ),
        ] {
            match p(t, out, stored) {
                Err(Failure::Usage(m)) => assert!(m.contains(wanted), "{m}"),
                other => panic!("{other:?}"),
            }
        }
    }

    fn view() -> Value {
        json!({
            "v": 1, "status": "valid", "package_id": ID,
            "package": {
                "package_id": ID, "objective": "x",
                "attachments": [
                    { "id": "att:c9ac7b0624824f84", "kind": "git_bundle", "bytes": 6, "sha256": "aa", "scanned": false },
                    { "id": "att:8cc12f351a0a4a4a", "kind": "patch", "bytes": 3, "sha256": "bb", "scanned": true, "omitted": "secret_detected" }
                ]
            },
            "summary": { "completeness": "complete" },
            "attachment_data": { "att:c9ac7b0624824f84": base64::engine::general_purpose::STANDARD.encode(b"bundle") }
        })
    }

    #[test]
    fn exporta_el_paquete_y_sus_adjuntos_con_permisos_privados_y_sin_pisar() {
        let d = dir("export");
        let out = d.join("paquete.json");
        let out_s = out.to_string_lossy().into_owned();
        let r = write_export(&out_s, false, &view(), true).unwrap();
        assert_eq!(
            (
                r["status"].as_str(),
                r["built"].as_bool(),
                r["package_id"].as_str()
            ),
            (Some("exported"), Some(true), Some(ID))
        );
        // El archivo es el paquete (JSON válido con su identidad) y los adjuntos van al lado con el nombre de su id.
        let escrito: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(escrito["package_id"], ID);
        let adj = d
            .join("paquete.json.attachments")
            .join("att-c9ac7b0624824f84");
        assert_eq!(std::fs::read(&adj).unwrap(), b"bundle");
        assert_eq!(
            r["omitted"],
            json!(["att:8cc12f351a0a4a4a"]),
            "el omitido consta y no genera archivo"
        );
        assert!(!d
            .join("paquete.json.attachments")
            .join("att-8cc12f351a0a4a4a")
            .exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&out), 0o600);
            assert_eq!(mode(&adj), 0o600);
            assert_eq!(mode(&d.join("paquete.json.attachments")), 0o700);
        }
        // No se sobrescribe sin --force; con --force sí, y el contenido anterior no se mezcla.
        match write_export(&out_s, false, &view(), true) {
            Err(Failure::Usage(m)) => assert!(m.contains("no sobrescribe sin --force"), "{m}"),
            other => panic!("{other:?}"),
        }
        std::fs::write(&out, "viejo").unwrap();
        write_export(&out_s, true, &view(), true).unwrap();
        assert!(std::fs::read_to_string(&out).unwrap().contains(ID));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn escribir_sin_force_no_pisa_lo_que_alguien_creo_entre_la_comprobacion_y_ahora() {
        let d = dir("carrera");
        let f = d.join("p.json");
        std::fs::write(&f, "de otra persona").unwrap();
        // La comprobación previa ya pasó; aquí `create_new` es la segunda defensa.
        match write_private(&f, b"paquete", false) {
            Err(Failure::Usage(m)) => assert!(m.contains("no sobrescribe sin --force"), "{m}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "de otra persona");
        write_private(&f, b"paquete", true).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "paquete");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_destino_imposible_se_rechaza_sin_dejar_nada() {
        let d = dir("destino");
        let carpeta = d.to_string_lossy().into_owned();
        match write_export(&carpeta, false, &view(), true) {
            Err(Failure::Usage(m)) => assert!(m.contains("es una carpeta"), "{m}"),
            other => panic!("{other:?}"),
        }
        let sin_padre = d
            .join("no-existe")
            .join("p.json")
            .to_string_lossy()
            .into_owned();
        match write_export(&sin_padre, false, &view(), true) {
            Err(Failure::Usage(m)) => assert!(
                m.contains("No existe la carpeta") && m.contains("no la crea"),
                "{m}"
            ),
            other => panic!("{other:?}"),
        }
        // La carpeta de adjuntos ocupada por un archivo.
        let out = d.join("q.json");
        std::fs::write(d.join("q.json.attachments"), "ocupado").unwrap();
        match write_export(&out.to_string_lossy(), false, &view(), true) {
            Err(Failure::Usage(m)) => assert!(m.contains("no es una carpeta"), "{m}"),
            other => panic!("{other:?}"),
        }
        assert!(!out.exists(), "nada se escribió");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_paquete_que_llega_incompleto_del_core_no_se_exporta() {
        let d = dir("incompleto");
        let out = d.join("p.json").to_string_lossy().into_owned();
        let mut sin_datos = view();
        sin_datos.as_object_mut().unwrap().remove("attachment_data");
        let mut falta = view();
        falta["attachment_data"] = json!({});
        let mut ajeno = view();
        ajeno["attachment_data"]["att:0000000000000000"] = json!("AA==");
        let mut raro = view();
        raro["attachment_data"] = json!({ "att:c9ac7b0624824f84": "***" });
        let mut invalido = view();
        invalido["status"] = json!("invalid");
        for (name, v) in [
            ("sin datos", sin_datos),
            ("falta un adjunto", falta),
            ("adjunto no declarado", ajeno),
            ("base64 roto", raro),
            ("inválido", invalido),
        ] {
            assert!(
                matches!(
                    write_export(&out, false, &v, false),
                    Err(Failure::Version(_))
                ),
                "{name}"
            );
        }
        assert!(!Path::new(&out).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn lee_los_adjuntos_de_al_lado_y_rechaza_lo_que_no_es_un_adjunto() {
        let d = dir("lectura");
        let file = d.join("p.json").to_string_lossy().into_owned();
        assert!(
            read_attachments(&file).unwrap().is_none(),
            "sin carpeta no hay adjuntos"
        );
        let adj = d.join("p.json.attachments");
        std::fs::create_dir_all(&adj).unwrap();
        std::fs::write(adj.join("att-c9ac7b0624824f84"), b"bundle").unwrap();
        let leidos = read_attachments(&file).unwrap().unwrap();
        assert_eq!(leidos.len(), 1);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(leidos["att:c9ac7b0624824f84"].as_str().unwrap())
                .unwrap(),
            b"bundle"
        );
        // Un archivo ajeno, un nombre que no es un id, una subcarpeta y un adjunto enorme.
        for (name, content) in [
            ("notas.txt", "x"),
            ("att-ZZZZ", "x"),
            ("att-c9ac7b0624824f8", "x"),
        ] {
            std::fs::write(adj.join(name), content).unwrap();
            match read_attachments(&file) {
                Err(Failure::Usage(m)) => assert!(m.contains("no es un adjunto"), "{name}: {m}"),
                other => panic!("{name}: {other:?}"),
            }
            std::fs::remove_file(adj.join(name)).unwrap();
        }
        std::fs::create_dir_all(adj.join("att-0000000000000000")).unwrap();
        assert!(
            matches!(read_attachments(&file), Err(Failure::Usage(m)) if m.contains("no es un archivo"))
        );
        std::fs::remove_dir_all(adj.join("att-0000000000000000")).unwrap();
        std::fs::write(
            adj.join("att-1111111111111111"),
            vec![0u8; MAX_ATTACHMENT_BYTES + 1],
        )
        .unwrap();
        assert!(
            matches!(read_attachments(&file), Err(Failure::Usage(m)) if m.contains("pesa más"))
        );
        std::fs::remove_file(adj.join("att-1111111111111111")).unwrap();
        for n in 0..3 {
            std::fs::write(adj.join(format!("att-{n:016x}")), vec![1u8; 900 * 1024]).unwrap();
        }
        assert!(
            matches!(read_attachments(&file), Err(Failure::Usage(m)) if m.contains("no viajan más"))
        );
        let _ = std::fs::remove_dir_all(&d);
        // Una carpeta de adjuntos que es un archivo.
        let d = dir("lectura2");
        let file = d.join("p.json").to_string_lossy().into_owned();
        std::fs::write(d.join("p.json.attachments"), "x").unwrap();
        assert!(
            matches!(read_attachments(&file), Err(Failure::Usage(m)) if m.contains("no es una carpeta"))
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn el_texto_de_exportar_e_importar_dice_que_no_se_inicio_nada() {
        let r = json!({ "package_id": ID, "built": true, "file": "p.json", "bytes": 10, "attachments_dir": "p.json.attachments", "attachments": [{}], "omitted": ["att:1"], "summary": { "completeness": "partial" } });
        let t = export_text(&r);
        assert!(
            t.contains("construido desde el intento y guardado en el Core")
                && t.contains("1 en p.json.attachments")
                && t.contains("Omitidos:     1"),
            "{t}"
        );
        assert!(
            t.contains("PARCIAL") && t.contains("no se ha iniciado ningún intento"),
            "{t}"
        );
        let i = import_text(&json!({
            "package_id": ID, "verification": { "identity": "verified", "secrets": "none_found", "attachments": "not_checked" },
            "attachments": [{ "stored": true }, { "stored": false }], "stored": { "created": true }, "summary": { "completeness": "complete" }
        }));
        assert!(
            i.contains("importado y guardado")
                && i.contains("2 declarados · 1 guardados")
                && i.contains("no se ha iniciado ninguno"),
            "{i}"
        );
        let otra = import_text(
            &json!({ "package_id": ID, "verification": {}, "attachments": [], "stored": { "created": false }, "summary": {} }),
        );
        assert!(
            otra.contains("ya estaba guardado en el Core: no se escribió nada"),
            "{otra}"
        );
    }
}
