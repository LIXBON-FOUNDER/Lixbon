//! `lxo context`: revisar, exportar e importar un ContextPackage v1 sin manipular su JSON a mano (LXO-138).
//!
//! La verificación es del Core: lxo manda el texto del paquete al Core por el RPC autenticado, como Person, y enseña lo que el Core dice:
//! versión, campos, identidad (`package_id` = sha256 del contenido canónico), secretos y adjuntos. lxo no calcula ningún hash ni busca
//! secretos.
//!
//! * `validate` y `show <archivo|->` leen un archivo con `context_package_preview` (de solo lectura: no guardan nada).
//! * `show <package_id|attempt_id>` lee un paquete que el Core ya guardó (`context_package_get`).
//! * `export` (`context_store.rs`) hace que el Core construya el paquete de un Attempt, lo guarde y lo deje en un archivo; `import` se lo da
//!   al Core, que lo valida por la misma puerta que un Attempt y lo guarda **preparado**, sin iniciar nada.
//!
//! Un paquete rechazado no muestra su contenido; lo redactado no se revela; y el contenido del archivo nunca vuelve en un error.

use std::io::Read;
use std::process::ExitCode;

use serde_json::{json, Value};

use crate::client_auth::{self, RpcFailure};
use crate::context_store::{self, ExportOpts, Target};
use crate::events::{clean, timestamp_utc};
use crate::projects::{failure, finish, usage, Failure};
use crate::Args;

pub(super) const HELP: &str = "Uso: lxo context show <archivo|-|package_id|attempt_id> [--json]
     lxo context validate <archivo|-> [--json]
     lxo context export <package_id|attempt_id> --out <archivo> [--stored] [--force] [--json]
     lxo context import <archivo|-> [--json]

Revisa, saca a un archivo y vuelve a meter un ContextPackage v1 (el paquete que lleva el contexto de
una tarea de un proveedor a otro) sin manipular su JSON a mano. La verificación es del Core; lxo no
calcula nada. Ninguna orden inicia un intento ni una transferencia.

`show` enseña el paquete: de dónde viene (proveedor, tarea, intento, proyecto), su identidad, lo redactado
y lo truncado, la revisión de git y lo que no está comprometido, los adjuntos y las pruebas. El argumento
es, por este orden: `-` (entrada estándar), un `package_id` (sha256:…) o un id de intento (<tarea>-a<n>) que
el Core ya guardó (el más reciente), o un archivo. `validate` solo dice si el Core acepta el paquete de un
archivo: versión, formato, identidad (que el contenido coincide con su package_id) y que no lleva secretos.

`export` hace que el Core construya el paquete de un intento con la evidencia de su worktree (revisión,
cambios, lo no comprometido y los commits sin publicar), lo guarde y lo deje en --out. Con un package_id
exporta ese paquete tal cual; con un intento construye uno nuevo, o con --stored el último que ya había.
El archivo lo eliges tú: no se sobrescribe sin --force, no se crea la carpeta que falte y se escribe con
permisos solo del dueño. Los adjuntos (parches, archivos sin seguimiento, el bundle de commits sin
publicar) van en <archivo>.attachments/att-<id>; los que llevaban algo con forma de secreto se omiten.
`import` valida el paquete (y sus adjuntos, de al lado) y lo guarda en el Core como preparado para un
intento futuro. Antes de guardar, el Core comprueba identidad, formato, secretos y el sha256 de cada adjunto.

Lo que `validate` y `show <archivo>` no verifican: los adjuntos (sus bytes no viajan con el paquete: constan
«sin comprobar»). `import` sí. Lo redactado llega ya como [redactado]: no hay forma de verlo.

Un paquete rechazado (alterado, de otra versión, con un secreto, con un adjunto que no coincide…) sale con
7, NO se guarda y NO muestra su contenido. Si la identidad no coincide se dan las dos huellas. El contenido
del archivo nunca aparece en un error. El archivo ha de ser UTF-8 (un BOM se ignora) y de hasta 128 KiB;
los adjuntos, de hasta 1 MiB cada uno y 2 MiB en total (lo que cabe por el RPC del Core).

Salida:
  (por defecto)      texto para personas
  --json             show: la respuesta `valid` del Core tal cual {v, status, verification, package_id,
                     package, summary[, attachments, stored]}. validate e import: la misma sin `package`.
                     export: {v, status: \"exported\", package_id, built, file, attachments, omitted…}.
                     Un paquete rechazado, con --json: {v, status: \"invalid\", error: {code, message},
                     serialized_bytes[, declared_id, recomputed_id]}

Guardar y exportar necesitan el modelo Task/Attempt activo (tras el corte). Solo para personas: dentro de
una tarea del orquestador (agente) el Core lo rechaza.

Códigos de salida: 0 correcto, 1 error interno del Core, 2 uso, archivo ilegible o destino imposible,
3 autenticación, 4 versión o contrato incompatible (también: Core sin el modelo Task/Attempt),
5 Lixbon cerrado o Core no disponible, 6 archivo, intento o paquete inexistente,
7 paquete rechazado por el Core.
";

const CONTRACT: u64 = 1;
/// Versión de `context_package_preview` que entiende lxo.
const API: u64 = 1;
/// Lo máximo que acepta la petición del Core (`MAX_REQUEST_BYTES`): más es un error de petición, no un paquete.
const MAX_BYTES: usize = 128 * 1024;
const FLAGS: [&str; 2] = ["json", "help"];
/// Los códigos de rechazo del Core (`PackageErrorCode`).
const REJECTIONS: [&str; 8] = [
    "invalid_json",
    "unsupported_version",
    "missing_field",
    "invalid_field",
    "id_mismatch",
    "too_large",
    "secret_detected",
    "attachment_mismatch",
];

type Rpc<'a> = &'a mut dyn FnMut(&str, &Value) -> Result<Value, RpcFailure>;

#[derive(Debug, PartialEq, Eq)]
enum Mode {
    Show,
    Validate,
    Import,
}

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Help,
    Review { mode: Mode, source: String },
    Export(ExportOpts),
}

fn parse(a: &Args) -> Result<Request, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    if a.at(1).as_deref() == Some("export") {
        return parse_export(a);
    }
    let mode = match a.at(1).as_deref() {
        Some("show") => Mode::Show,
        Some("validate") => Mode::Validate,
        Some("import") => Mode::Import,
        Some(other) => {
            return Err(usage(format!(
                "«{}» no es una orden de lxo context; usa show, validate, export o import.",
                clean(other)
            )))
        }
        None => {
            return Err(usage(
                "Uso: lxo context show|validate|import <archivo> | lxo context export <package_id|attempt_id> --out <archivo>. Mira `lxo context --help`.",
            ))
        }
    };
    if let Some(name) = a.flags.keys().find(|k| !FLAGS.contains(&k.as_str())) {
        return Err(usage(format!(
            "--{name} no es una opción de lxo context. Mira `lxo context --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in FLAGS {
        if a.flags.get(name).is_some_and(|v| !v.is_boolean()) {
            return Err(usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }
    match a.pos.get(2..).unwrap_or_default() {
        [] => Err(usage(
            "Falta el paquete: lxo context show <archivo|-|package_id|attempt_id>. `-` lo lee por la entrada estándar.",
        )),
        [source] if !source.trim().is_empty() => Ok(Request::Review {
            mode,
            source: source.to_string(),
        }),
        _ => Err(usage("lxo context recibe un solo archivo.")),
    }
}

const EXPORT_FLAGS: [&str; 5] = ["out", "stored", "force", "json", "help"];

fn parse_export(a: &Args) -> Result<Request, Failure> {
    if let Some(name) = a.flags.keys().find(|k| !EXPORT_FLAGS.contains(&k.as_str())) {
        return Err(usage(format!(
            "--{name} no es una opción de lxo context export. Mira `lxo context --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["json", "help", "force", "stored"] {
        if a.flags.get(name).is_some_and(|v| !v.is_boolean()) {
            return Err(usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }
    let out = match a.flags.get("out") {
        None => None,
        Some(Value::String(v)) if !v.trim().is_empty() => Some(v.clone()),
        _ => return Err(usage("--out requiere un valor.")),
    };
    let target = match a.pos.get(2..).unwrap_or_default() {
        [] => None,
        [t] => Some(t.as_str()),
        _ => {
            return Err(usage(
                "lxo context export recibe un solo paquete o intento.",
            ))
        }
    };
    context_store::parse_export(target, out, a.b("force"), a.b("stored")).map(Request::Export)
}

fn contract_error() -> Failure {
    Failure::Version(
        "El Core devolvió la revisión del paquete con un formato que este lxo no entiende; actualiza Lixbon."
            .into(),
    )
}

fn context_failure(error: RpcFailure) -> Failure {
    if let RpcFailure::Rejected(m) = &error {
        if m.starts_with("context_preview_auth_required") {
            return Failure::Auth(
                "La revisión de paquetes de contexto es solo para personas: un paquete lleva el objetivo y las decisiones del trabajo y una tarea del orquestador (agente) no puede leerlo."
                    .into(),
            );
        }
        // lxo valida el tamaño y arma la petición: si el Core la rechaza, es que no hablan el mismo contrato.
        if let Some(detail) = m.strip_prefix("context_preview_invalid_request: ") {
            return Failure::Version(format!(
                "El Core rechazó la petición de revisión ({}); actualiza Lixbon.",
                clean(detail)
            ));
        }
        if m.starts_with("Comando desconocido") {
            return Failure::Version(
                "Este Core no ofrece la revisión de paquetes de contexto; actualiza Lixbon.".into(),
            );
        }
        // Construir, guardar, leer e importar (LXO-138): `context_store_*`.
        if m.starts_with("context_store_auth_required") {
            return Failure::Auth(
                "Los paquetes de contexto son solo para personas: un paquete lleva el objetivo y las decisiones del trabajo y una tarea del orquestador (agente) no puede construirlo, leerlo ni importarlo."
                    .into(),
            );
        }
        if m.starts_with("core_model_inactive") {
            return Failure::Version(
                "Este Core aún usa el modelo anterior: los paquetes guardados (export, import y show por id) llegan tras el corte Task/Attempt. Mientras, usa lxo context show|validate <archivo>."
                    .into(),
            );
        }
        if let Some(detail) = m.strip_prefix("context_store_invalid_request: ") {
            return Failure::Version(format!(
                "El Core rechazó la petición de paquetes ({}); actualiza Lixbon.",
                clean(detail)
            ));
        }
        if let Some(detail) = m.strip_prefix("context_store_not_found: ") {
            return Failure::NotFound(clean(detail));
        }
        if let Some(detail) = m.strip_prefix("context_store_attachments_too_large: ") {
            return usage(format!(
                "{}. Publica la rama y exporta sin esos archivos, o reduce lo que no está comprometido.",
                clean(detail)
            ));
        }
        if let Some(detail) = m.strip_prefix("context_store_unavailable: ") {
            return if detail.contains("almacén no está abierto") {
                Failure::Unavailable(
                    "El Core de Lixbon no tiene su almacén abierto; reinicia Lixbon.".into(),
                )
            } else {
                usage(clean(detail))
            };
        }
        if m.starts_with("context_store_corrupt") {
            return Failure::Internal(clean(m));
        }
    }
    failure(error)
}

/// Lee a lo sumo `MAX_BYTES + 1` bytes: lo bastante para saber que se pasa, sin cargar un archivo enorme.
fn read_limited(reader: &mut dyn Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(MAX_BYTES as u64 + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn too_big(what: &str) -> Failure {
    usage(format!(
        "{what} pesa más de {} KiB: un ContextPackage v1 no pasa de 64 KiB (sin adjuntos). Esto no es un paquete.",
        MAX_BYTES / 1024
    ))
}

/// El texto del paquete de un archivo (o de la entrada estándar con `-`). Falla antes de llamar al Core con un mensaje que
/// nunca lleva el contenido del archivo.
fn read_source(source: &str, stdin: &mut dyn Read) -> Result<String, Failure> {
    let bytes = if source == "-" {
        let bytes = read_limited(stdin).map_err(|e| {
            usage(format!(
                "No se pudo leer el paquete de la entrada estándar: {e}."
            ))
        })?;
        if bytes.len() > MAX_BYTES {
            return Err(too_big("La entrada estándar"));
        }
        bytes
    } else {
        let shown = clean(source);
        let meta = std::fs::metadata(source).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Failure::NotFound(format!(
                "No hay ningún archivo «{shown}». lxo context lee un archivo de ContextPackage (o - por la entrada estándar); el Core aún no sirve paquetes por package_id ni por intento."
            )),
            std::io::ErrorKind::PermissionDenied => {
                usage(format!("Sin permiso para leer «{shown}»."))
            }
            _ => usage(format!("No se pudo leer «{shown}»: {e}.")),
        })?;
        if !meta.is_file() {
            return Err(usage(format!(
                "«{shown}» no es un archivo (¿una carpeta?): pasa el archivo del paquete."
            )));
        }
        if meta.len() > MAX_BYTES as u64 {
            return Err(too_big(&format!("«{shown}»")));
        }
        let mut file = std::fs::File::open(source).map_err(|e| match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                usage(format!("Sin permiso para leer «{shown}»."))
            }
            _ => usage(format!("No se pudo abrir «{shown}»: {e}.")),
        })?;
        let bytes = read_limited(&mut file)
            .map_err(|e| usage(format!("No se pudo leer «{shown}»: {e}.")))?;
        // Si creció mientras se leía, ya no es el archivo que se miró.
        if bytes.len() > MAX_BYTES {
            return Err(too_big(&format!("«{shown}»")));
        }
        bytes
    };
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        return Err(usage(
            "El archivo está en UTF-16 (por ejemplo, la salida de `>` en PowerShell 5): guárdalo como UTF-8.",
        ));
    }
    let body = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let text = String::from_utf8(body.to_vec())
        .map_err(|_| usage("El archivo no es UTF-8 válido: un ContextPackage es JSON en UTF-8."))?;
    if text.trim().is_empty() {
        return Err(usage("El archivo está vacío: no es un ContextPackage."));
    }
    Ok(text)
}

/// El veredicto del Core ya validado. `Valid` lleva su respuesta; `Invalid`, solo lo que el Core permite enseñar.
#[derive(Debug)]
enum Verdict {
    Valid(Value),
    Invalid(Value),
}

fn is_hash(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 71 && s.starts_with("sha256:") && s[7..].bytes().all(|b| b.is_ascii_hexdigit())
    })
}

fn review(rpc: Rpc, package_text: &str) -> Result<Verdict, Failure> {
    fetch(
        rpc,
        "context_package_preview",
        &json!({ "package": package_text }),
    )
}

/// Una orden de paquetes al Core y su respuesta ya clasificada: válida (con su forma comprobada) o rechazada.
fn fetch(rpc: Rpc, cmd: &str, args: &Value) -> Result<Verdict, Failure> {
    let data = rpc(cmd, args).map_err(context_failure)?;
    classify(data)
}

fn classify(data: Value) -> Result<Verdict, Failure> {
    if data["v"].as_u64() != Some(API) {
        return Err(contract_error());
    }
    match data["status"].as_str() {
        Some("valid") => {
            let v = &data["verification"];
            if !is_hash(&data["package_id"])
                || !data["package"].is_object()
                || !data["summary"].is_object()
                || !v["identity"].is_string()
                || !v["secrets"].is_string()
                || !v["attachments"].is_string()
            {
                return Err(contract_error());
            }
            Ok(Verdict::Valid(data))
        }
        Some("invalid") => {
            let code = data["error"]["code"]
                .as_str()
                .filter(|c| REJECTIONS.contains(c))
                .ok_or_else(contract_error)?;
            let mut out = json!({
                "v": CONTRACT,
                "status": "invalid",
                "error": {
                    "code": code,
                    "message": data["error"]["message"].as_str().unwrap_or("").chars().take(300).collect::<String>(),
                },
                "serialized_bytes": data["serialized_bytes"].as_u64(),
            });
            // Solo la alteración trae las dos huellas: no son secretos y son lo que la hace visible.
            if code == "id_mismatch" {
                out["declared_id"] = if is_hash(&data["declared_id"]) {
                    data["declared_id"].clone()
                } else {
                    Value::Null
                };
                out["recomputed_id"] = if is_hash(&data["recomputed_id"]) {
                    data["recomputed_id"].clone()
                } else {
                    Value::Null
                };
            }
            Ok(Verdict::Invalid(out))
        }
        _ => Err(contract_error()),
    }
}

fn rejection_text(code: &str) -> &'static str {
    match code {
        "invalid_json" => "el archivo no es JSON válido",
        "unsupported_version" => "la versión del paquete no es una que este Core entienda",
        "missing_field" => "falta un campo obligatorio",
        "invalid_field" => "un campo no es válido",
        "id_mismatch" => "el paquete se alteró: su identidad no coincide con su contenido",
        "too_large" => "el paquete pesa más de lo permitido",
        "secret_detected" => "el paquete lleva algo con forma de secreto",
        "attachment_mismatch" => "un adjunto no coincide con lo que el paquete declara",
        _ => "rechazado",
    }
}

fn invalid_text(v: &Value) -> String {
    let code = v["error"]["code"].as_str().unwrap_or("");
    let mut lines = vec![format!(
        "El paquete no es válido ({code}): {}.",
        rejection_text(code)
    )];
    if let Some(m) = v["error"]["message"].as_str().filter(|m| !m.is_empty()) {
        lines.push(format!("  El Core dice: {}", clean(m)));
    }
    if code == "id_mismatch" {
        for (label, key) in [
            ("declarada ", "declared_id"),
            ("recalculada", "recomputed_id"),
        ] {
            lines.push(format!(
                "  Identidad {label}: {}",
                v[key]
                    .as_str()
                    .map(clean)
                    .unwrap_or_else(|| "sin dato".into())
            ));
        }
    }
    lines.push(
        "  No se muestra su contenido: un paquete rechazado no se presenta como si fuera de fiar."
            .into(),
    );
    lines.join("\n")
}

fn note_text(code: &str) -> String {
    match code {
        "truncated" => "hay campos truncados: el receptor no tendría todo".into(),
        "redacted" => "hay valores redactados ([redactado]); lo original no se puede ver".into(),
        "revision_absent" => {
            "sin revisión de git: el paquete no dice sobre qué código se trabajó".into()
        }
        "attachment_omitted" => "hay adjuntos omitidos: no viajan".into(),
        "attachment_not_scanned" => {
            "hay adjuntos sin escanear (un git bundle va comprimido)".into()
        }
        other => clean(other),
    }
}

pub(super) fn verification_line(v: &Value) -> String {
    verification_text(v)
}

fn verification_text(v: &Value) -> String {
    let identity = match v["identity"].as_str() {
        Some("verified") => {
            "identidad verificada (el contenido coincide con su package_id)".to_string()
        }
        Some(other) => format!("identidad: {}", clean(other)),
        None => "identidad sin dato".into(),
    };
    let secrets = match v["secrets"].as_str() {
        Some("none_found") => "secretos: ninguno hallado".to_string(),
        Some(other) => format!("secretos: {}", clean(other)),
        None => "secretos sin dato".into(),
    };
    let attachments = match v["attachments"].as_str() {
        Some("not_checked") => {
            "adjuntos: sin comprobar (sus bytes no llegan con el paquete)".to_string()
        }
        Some(other) => format!("adjuntos: {}", clean(other)),
        None => "adjuntos sin dato".into(),
    };
    format!("{identity} · {secrets} · {attachments}")
}

fn s(v: &Value) -> Option<String> {
    v.as_str().filter(|x| !x.is_empty()).map(clean)
}

fn dash(v: &Value) -> String {
    s(v).unwrap_or_else(|| "—".into())
}

fn utc(v: &Value) -> String {
    v.as_u64()
        .map(|ms| format!("{} UTC", timestamp_utc(ms as i64)[..19].replace('T', " ")))
        .unwrap_or_else(|| "—".into())
}

/// Un texto del paquete, sin saltos de línea sueltos y con sangría.
fn block(label: &str, value: &Value) -> Vec<String> {
    match s(value) {
        Some(t) => {
            let mut lines = t.lines();
            let mut out = vec![format!("  {label:<14}{}", lines.next().unwrap_or(""))];
            out.extend(lines.map(|l| format!("  {:<14}{l}", "")));
            out
        }
        None => vec![],
    }
}

fn list(label: &str, items: &Value) -> Vec<String> {
    let items: Vec<String> = items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(s)
        .collect();
    if items.is_empty() {
        return vec![];
    }
    let mut out = vec![format!("  {label} ({}):", items.len())];
    out.extend(items.iter().map(|i| format!("    - {i}")));
    out
}

fn summary_lines(data: &Value) -> Vec<String> {
    let sm = &data["summary"];
    let mut lines = vec![format!(
        "  Completitud:  {}",
        match sm["completeness"].as_str() {
            Some("complete") => "completo",
            Some("partial") => "PARCIAL: falta algo que el receptor necesitaría",
            _ => "sin dato",
        }
    )];
    for n in sm["notes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        lines.push(format!("                · {}", note_text(n)));
    }
    let c = &sm["counts"];
    let n = |k: &str| {
        c[k].as_u64()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "?".into())
    };
    lines.push(format!(
        "  Redacciones:  {} · campos truncados: {}",
        n("redactions"),
        n("truncated_fields")
    ));
    for t in data["package"]["truncated"]
        .as_array()
        .into_iter()
        .flatten()
    {
        lines.push(format!(
            "                truncado: {} (había {} {})",
            dash(&t["field"]),
            t["original"]
                .as_u64()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "?".into()),
            match t["unit"].as_str() {
                Some("chars") => "caracteres",
                Some("items") => "elementos",
                _ => "unidades",
            }
        ));
    }
    lines
}

fn show_text(data: &Value) -> String {
    let p = &data["package"];
    let src = &p["source"];
    let mut lines = vec![
        format!("Paquete {} · válido", dash(&data["package_id"])),
        format!(
            "  Verificación: {}",
            verification_text(&data["verification"])
        ),
        format!(
            "  Origen:       proveedor {} · tarea {} · intento {} · proyecto {}",
            dash(&src["provider"]),
            dash(&src["task_id"]),
            dash(&src["attempt_id"]),
            dash(&src["project_id"])
        ),
        format!(
            "                host {} · sesión del proveedor {} (huellas, no ids)",
            dash(&src["host"]),
            dash(&src["provider_session"])
        ),
        format!(
            "  Creado:       {} · {} bytes",
            utc(&p["created_at_ms"]),
            data["summary"]["serialized_bytes"]
                .as_u64()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "?".into())
        ),
    ];
    if data["stored"].is_object() {
        let atts = data["attachments"].as_array().cloned().unwrap_or_default();
        let kept = atts.iter().filter(|a| a["stored"] == true).count();
        lines.push(format!(
            "  Guardado:     {} · adjuntos guardados: {kept} de {}",
            match data["stored"]["origin"].as_str() {
                Some("built") => "construido por este Core",
                Some("imported") => "importado de un archivo",
                _ => "origen desconocido",
            },
            atts.len()
        ));
    }
    lines.extend(summary_lines(data));
    lines.extend(block("Objetivo:", &p["objective"]));
    lines.extend(block("Resumen:", &p["thread_summary"]));
    lines.extend(list("Decisiones", &p["decisions"]));
    lines.extend(list("Restricciones", &p["constraints"]));
    let r = &p["revision"];
    if r.is_object() {
        let files = r["files"].as_array().cloned().unwrap_or_default();
        let added: u64 = files.iter().filter_map(|f| f["added"].as_u64()).sum();
        let deleted: u64 = files.iter().filter_map(|f| f["deleted"].as_u64()).sum();
        lines.push(format!(
            "  Revisión:     rama {} · base {} · HEAD {}",
            dash(&r["branch"]),
            dash(&r["base_commit"]),
            dash(&r["head_commit"])
        ));
        lines.push(format!(
            "                {} archivos (+{added} −{deleted}) · diff de {} bytes · sha256 {}",
            files.len(),
            r["diff_bytes"]
                .as_u64()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "?".into()),
            dash(&r["diff_sha256"])
        ));
        for f in &files {
            lines.push(format!(
                "                {} (+{} −{})",
                dash(&f["path"]),
                f["added"].as_u64().unwrap_or(0),
                f["deleted"].as_u64().unwrap_or(0)
            ));
        }
    } else {
        lines
            .push("  Revisión:     ninguna: el paquete no dice sobre qué código se trabajó".into());
    }
    let u = &p["uncommitted"];
    if u.is_object() {
        let untracked = u["untracked"].as_array().cloned().unwrap_or_default();
        lines.push(format!(
            "  Sin commit:   parche preparado {} · parche sin preparar {} · {} {} sin seguimiento",
            u["staged_patch"]
                .as_str()
                .map(clean)
                .unwrap_or_else(|| "ninguno".into()),
            u["unstaged_patch"]
                .as_str()
                .map(clean)
                .unwrap_or_else(|| "ninguno".into()),
            untracked.len(),
            if untracked.len() == 1 {
                "archivo"
            } else {
                "archivos"
            }
        ));
        for f in &untracked {
            lines.push(format!(
                "                {} ({} bytes)",
                dash(&f["path"]),
                f["bytes"]
                    .as_u64()
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "?".into())
            ));
        }
    }
    let artifacts = p["artifacts"].as_array().cloned().unwrap_or_default();
    if !artifacts.is_empty() {
        lines.push(format!("  Artefactos ({}):", artifacts.len()));
        for a in &artifacts {
            lines.push(format!("    - {}: {}", dash(&a["kind"]), dash(&a["uri"])));
        }
    }
    let attachments = p["attachments"].as_array().cloned().unwrap_or_default();
    if !attachments.is_empty() {
        lines.push(format!("  Adjuntos ({}):", attachments.len()));
        for a in &attachments {
            let state = match (s(&a["omitted"]), a["scanned"].as_bool()) {
                (Some(why), _) => format!("OMITIDO ({why}): no viaja"),
                (None, Some(true)) => "escaneado".into(),
                (None, _) => "sin escanear".into(),
            };
            lines.push(format!(
                "    - {} · {} · {} bytes · {state} · sha256 {}",
                dash(&a["id"]),
                dash(&a["kind"]),
                a["bytes"]
                    .as_u64()
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "?".into()),
                dash(&a["sha256"])
            ));
        }
    }
    let t = &p["test_results"];
    if t.is_object() {
        let n = |k: &str| {
            t[k].as_u64()
                .map(|v| v.to_string())
                .unwrap_or_else(|| "?".into())
        };
        lines.push(format!(
            "  Pruebas:      {} · {} pasan · {} fallan · {} ignoradas",
            dash(&t["command"]),
            n("passed"),
            n("failed"),
            n("ignored")
        ));
    }
    lines.join("\n")
}

fn validate_text(data: &Value) -> String {
    let mut lines = vec![
        format!("Paquete {} · válido", dash(&data["package_id"])),
        format!(
            "  Verificación: {}",
            verification_text(&data["verification"])
        ),
    ];
    lines.extend(summary_lines(data));
    lines.join("\n")
}

/// `validate --json`: la respuesta del Core sin el paquete.
fn without_package(data: &Value) -> Value {
    let mut v = data.clone();
    if let Some(o) = v.as_object_mut() {
        o.remove("package");
    }
    v
}

fn execute(request: Request, json: bool) -> Result<u8, Failure> {
    match request {
        Request::Help => {
            print!("{HELP}");
            Ok(0)
        }
        Request::Review { mode, source } => {
            let mut rpc = |cmd: &str, args: &Value| client_auth::rpc(cmd, args, &crate::cwd());
            let verdict = acquire(&mut rpc, &mode, &source, &mut std::io::stdin())?;
            let out = render(&mode, json, &verdict);
            if let Some(stdout) = out.stdout {
                println!("{stdout}");
            }
            if let Some(stderr) = out.stderr {
                eprintln!("lxo: {stderr}");
            }
            Ok(out.code)
        }
        Request::Export(opts) => {
            let mut rpc = |cmd: &str, args: &Value| client_auth::rpc(cmd, args, &crate::cwd());
            let result = export(&mut rpc, &opts)?;
            if json {
                println!("{result}");
            } else {
                println!("{}", context_store::export_text(&result));
            }
            Ok(0)
        }
    }
}

/// El veredicto del Core sobre lo que se pidió: un archivo (o la entrada estándar) que se revisa o se importa, o un paquete que el Core ya guardó.
fn acquire(rpc: Rpc, mode: &Mode, source: &str, stdin: &mut dyn Read) -> Result<Verdict, Failure> {
    match (mode, show_target(source)) {
        (Mode::Show, ShowTarget::Package(id)) => {
            fetch(rpc, "context_package_get", &json!({ "package_id": id }))
        }
        (Mode::Show, ShowTarget::Attempt(id)) => {
            fetch(rpc, "context_package_get", &json!({ "attempt_id": id }))
                .map_err(|e| missing_stored(e, &id))
        }
        (Mode::Import, _) => {
            let text = read_source(source, stdin)?;
            // Los adjuntos viven al lado de un archivo; por la entrada estándar no hay carpeta.
            let attachments = if source == "-" {
                None
            } else {
                context_store::read_attachments(source)?
            };
            let mut args = json!({ "package": text });
            if let Some(a) = attachments {
                args["attachments"] = Value::Object(a);
            }
            fetch(rpc, "context_package_import", &args)
        }
        _ => review(rpc, &read_source(source, stdin)?),
    }
}

/// De dónde sale lo que `show` enseña.
#[derive(Debug, PartialEq, Eq)]
enum ShowTarget {
    /// Un archivo o la entrada estándar: el Core solo lo revisa.
    File,
    /// Un paquete que el Core ya guardó, por su `package_id`.
    Package(String),
    /// El paquete guardado más reciente de un intento.
    Attempt(String),
}

fn show_target(source: &str) -> ShowTarget {
    if source == "-" {
        ShowTarget::File
    } else if context_store::is_package_id(source) {
        ShowTarget::Package(source.to_string())
    } else if context_store::looks_like_attempt_id(source) && !std::path::Path::new(source).exists()
    {
        ShowTarget::Attempt(source.to_string())
    } else {
        ShowTarget::File
    }
}

fn missing_stored(error: Failure, id: &str) -> Failure {
    match error {
        Failure::NotFound(_) => Failure::NotFound(format!(
            "No hay ningún archivo ni ningún paquete guardado del intento «{}». Para guardar uno: lxo context export {} --out <archivo>.",
            clean(id),
            clean(id)
        )),
        other => other,
    }
}

/// Trae del Core el paquete a exportar (construyéndolo si hace falta) y lo deja en el archivo.
fn export(rpc: Rpc, opts: &ExportOpts) -> Result<Value, Failure> {
    // El destino se comprueba antes de pedir nada: no se construye un paquete que no cabe donde se pide.
    context_store::check_export_destination(&opts.out, opts.force)?;
    let (get_args, built) = match &opts.target {
        Target::Package(id) => (
            json!({ "package_id": id, "include_attachments": true }),
            false,
        ),
        Target::AttemptStored(id) => (
            json!({ "attempt_id": id, "include_attachments": true }),
            false,
        ),
        Target::AttemptBuild(id) => {
            let built = fetch(rpc, "context_package_build", &json!({ "attempt_id": id }))?;
            let Verdict::Valid(view) = built else {
                return Err(contract_error());
            };
            (
                json!({ "package_id": view["package_id"], "include_attachments": true }),
                true,
            )
        }
    };
    let view = match fetch(rpc, "context_package_get", &get_args).map_err(|e| match (e, &opts.target) {
        (Failure::NotFound(_), Target::AttemptStored(id)) => Failure::NotFound(format!(
            "No hay ningún paquete guardado del intento «{}»: exporta sin --stored para construir uno.",
            clean(id)
        )),
        (other, _) => other,
    })? {
        Verdict::Valid(v) => v,
        Verdict::Invalid(_) => return Err(contract_error()),
    };
    context_store::write_export(&opts.out, opts.force, &view, built)
}

/// Lo que sale por cada canal y el código de salida de un veredicto. Un paquete rechazado sale con 7: con `--json` el veredicto va
/// por la salida estándar (es un resultado, como el de `lxo provider status`); en texto, por el error.
struct Rendered {
    stdout: Option<String>,
    stderr: Option<String>,
    code: u8,
}

fn render(mode: &Mode, json: bool, verdict: &Verdict) -> Rendered {
    match verdict {
        Verdict::Valid(data) => Rendered {
            stdout: Some(match (mode, json) {
                (Mode::Show, true) => data.to_string(),
                (Mode::Validate | Mode::Import, true) => without_package(data).to_string(),
                (Mode::Show, false) => show_text(data),
                (Mode::Validate, false) => validate_text(data),
                (Mode::Import, false) => context_store::import_text(data),
            }),
            stderr: None,
            code: 0,
        },
        Verdict::Invalid(data) => Rendered {
            stdout: json.then(|| data.to_string()),
            stderr: (!json).then(|| invalid_text(data)),
            code: 7,
        },
    }
}

pub(super) fn run(a: &Args) -> ExitCode {
    let json = a.b("json");
    match parse(a).and_then(|request| execute(request, json)) {
        Ok(code) => ExitCode::from(code),
        Err(failure) => finish(Err(failure), json),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::io::Cursor;
    use std::path::Path;
    use std::rc::Rc;

    const VALID: &str =
        include_str!("../../../../docs/core/fixtures/api/context_package_preview.v1.json");
    const INVALID: &str =
        include_str!("../../../../docs/core/fixtures/api/context_package_preview_invalid.v1.json");
    /// Texto del archivo que ningún error ni salida debe repetir.
    const LEAK: &str = "centinela-del-archivo-no-debe-salir";

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|s| s.to_string()).collect())
    }

    type Sent = Rc<RefCell<Vec<(String, Value)>>>;

    /// Un Core que responde con la fixture publicada (válida o alterada) y anota lo que le llegó.
    fn core(
        sent: Sent,
        response: &'static str,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        move |cmd, a| {
            sent.borrow_mut().push((cmd.to_string(), a.clone()));
            Ok(serde_json::from_str(response).unwrap())
        }
    }

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("lxo-context-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn read(path: &std::path::Path) -> Result<String, Failure> {
        read_source(path.to_str().unwrap(), &mut Cursor::new(Vec::new()))
    }

    fn usage_msg(r: Result<String, Failure>) -> String {
        match r {
            Err(Failure::Usage(m)) => m,
            other => panic!("se esperaba un error de uso: {other:?}"),
        }
    }

    #[test]
    fn un_paquete_valido_se_muestra_completo_y_con_su_identidad() {
        let sent: Sent = Default::default();
        let verdict = review(&mut core(sent.clone(), VALID), "{\"x\":1}").unwrap();
        let Verdict::Valid(data) = verdict else {
            panic!("se esperaba válido")
        };
        assert_eq!(sent.borrow()[0].0, "context_package_preview");
        assert_eq!(sent.borrow()[0].1, json!({ "package": "{\"x\":1}" }));
        let human = show_text(&data);
        assert!(human.starts_with("Paquete sha256:ed8802df89b2fc0ce7b1535f6233a49548df5bdfd5ffaa984ccb6c2cd213b6a4 · válido"), "{human}");
        assert!(human.contains("identidad verificada (el contenido coincide con su package_id) · secretos: ninguno hallado · adjuntos: sin comprobar"), "{human}");
        // Procedencia, sin reescribir.
        assert!(
            human.contains("proveedor claude · tarea t-205 · intento a-1 · proyecto p-lixbon"),
            "{human}"
        );
        assert!(
            human.contains("host fp:3d5ade31 · sesión del proveedor fp:16e48575 (huellas, no ids)"),
            "{human}"
        );
        assert!(human.contains("Completitud:  completo"), "{human}");
        assert!(human.contains("· hay adjuntos sin escanear"), "{human}");
        assert!(
            human.contains("Redacciones:  0 · campos truncados: 0"),
            "{human}"
        );
        assert!(
            human
                .contains("Objetivo:     Normalizar el uso de cada proveedor sin fingir métricas."),
            "{human}"
        );
        assert!(human.contains("Decisiones (2):"), "{human}");
        assert!(
            human.contains(
                "rama feat/lxo-205-usage-cross-provider · base e73a74da · HEAD 0123456789abcdef"
            ),
            "{human}"
        );
        assert!(
            human.contains(
                "sha256 56057f39ecc0154d987df53cab0e0e22028553fc83bbee6feb7b7bac2a57338c"
            ),
            "{human}"
        );
        assert!(
            human.contains("att:c9ac7b0624824f84 · git_bundle · 4096 bytes · sin escanear"),
            "{human}"
        );
        assert!(
            human.contains("att:8cc12f351a0a4a4a · patch · 30 bytes · escaneado"),
            "{human}"
        );
        assert!(
            human.contains("cargo test --lib · 1441 pasan · 0 fallan · 19 ignoradas"),
            "{human}"
        );
        assert!(
            human.contains("1 archivo sin seguimiento") && human.contains("NOTAS.md (37 bytes)"),
            "{human}"
        );
    }

    #[test]
    fn show_json_es_exactamente_la_respuesta_valida_del_core_y_validate_no_lleva_el_paquete() {
        let Verdict::Valid(data) = review(&mut core(Default::default(), VALID), "{}").unwrap()
        else {
            panic!("se esperaba válido")
        };
        let core_view: Value = serde_json::from_str(VALID).unwrap();
        assert_eq!(
            data, core_view,
            "show --json no reinterpreta nada del paquete"
        );
        crate::snapshot("context_show.v1.json", &data);
        let v = without_package(&data);
        assert!(v.get("package").is_none());
        assert_eq!(v["package_id"], core_view["package_id"]);
        crate::snapshot("context_validate.v1.json", &v);
        let human = validate_text(&data);
        assert!(human.starts_with("Paquete sha256:ed88"), "{human}");
        assert!(
            !human.contains("Normalizar el uso"),
            "validate no enseña el contenido: {human}"
        );
    }

    #[test]
    fn parcial_truncado_y_redactado_se_dicen_sin_ocultar_nada() {
        let mut core_view: Value = serde_json::from_str(VALID).unwrap();
        core_view["summary"]["completeness"] = json!("partial");
        core_view["summary"]["notes"] = json!(["truncated", "redacted", "attachment_omitted"]);
        core_view["summary"]["counts"]["redactions"] = json!(3);
        core_view["summary"]["counts"]["truncated_fields"] = json!(2);
        core_view["package"]["truncated"] = json!([
            { "field": "revision.files", "original": 900, "unit": "items" },
            { "field": "thread_summary", "original": 20000, "unit": "chars" }
        ]);
        core_view["package"]["attachments"][0]["omitted"] = json!("too_large");
        let mut rpc = move |_: &str, _: &Value| Ok(core_view.clone());
        let Verdict::Valid(data) = review(&mut rpc, "{}").unwrap() else {
            panic!()
        };
        let human = show_text(&data);
        assert!(
            human.contains("Completitud:  PARCIAL: falta algo que el receptor necesitaría"),
            "{human}"
        );
        assert!(
            human.contains("hay campos truncados")
                && human.contains("hay valores redactados")
                && human.contains("adjuntos omitidos"),
            "{human}"
        );
        assert!(
            human.contains("Redacciones:  3 · campos truncados: 2"),
            "{human}"
        );
        assert!(
            human.contains("truncado: revision.files (había 900 elementos)"),
            "{human}"
        );
        assert!(
            human.contains("truncado: thread_summary (había 20000 caracteres)"),
            "{human}"
        );
        assert!(human.contains("OMITIDO (too_large): no viaja"), "{human}");
    }

    #[test]
    fn un_paquete_alterado_no_muestra_contenido_y_da_las_dos_huellas() {
        let Verdict::Invalid(data) = review(&mut core(Default::default(), INVALID), "{}").unwrap()
        else {
            panic!("se esperaba inválido")
        };
        assert_eq!(data["error"]["code"], "id_mismatch");
        assert!(data["declared_id"]
            .as_str()
            .unwrap()
            .starts_with("sha256:ed88"));
        assert!(data["recomputed_id"]
            .as_str()
            .unwrap()
            .starts_with("sha256:da2f"));
        assert!(
            data.get("package").is_none()
                && data.get("summary").is_none()
                && data.get("package_id").is_none()
        );
        crate::snapshot("context_invalid.v1.json", &data);
        let human = invalid_text(&data);
        assert!(
            human.contains("(id_mismatch): el paquete se alteró"),
            "{human}"
        );
        assert!(
            human.contains("Identidad declarada : sha256:ed88")
                || human.contains("Identidad declarada: sha256:ed88"),
            "{human}"
        );
        assert!(human.contains("sha256:da2f"), "{human}");
        assert!(human.contains("No se muestra su contenido"), "{human}");
    }

    #[test]
    fn el_rechazo_no_deja_pasar_lo_que_el_core_no_autoriza() {
        let mut core_view: Value = serde_json::from_str(INVALID).unwrap();
        core_view["package"] = json!({ "objective": LEAK });
        core_view["summary"] = json!({ "x": LEAK });
        core_view["package_id"] = json!(LEAK);
        let mut rpc = move |_: &str, _: &Value| Ok(core_view.clone());
        let Verdict::Invalid(data) = review(&mut rpc, "{}").unwrap() else {
            panic!()
        };
        assert!(
            !data.to_string().contains(LEAK),
            "el rechazo dejó pasar contenido"
        );
        // Los demás códigos no traen huellas.
        for code in [
            "invalid_json",
            "unsupported_version",
            "missing_field",
            "invalid_field",
            "too_large",
            "secret_detected",
            "attachment_mismatch",
        ] {
            let mut v: Value = serde_json::from_str(INVALID).unwrap();
            v["error"]["code"] = json!(code);
            let mut rpc = move |_: &str, _: &Value| Ok(v.clone());
            let Verdict::Invalid(d) = review(&mut rpc, "{}").unwrap() else {
                panic!()
            };
            assert!(
                d.get("declared_id").is_none() && d.get("recomputed_id").is_none(),
                "{code}"
            );
            assert_ne!(rejection_text(code), "rechazado", "{code} sin texto propio");
        }
    }

    #[test]
    fn la_salida_y_el_codigo_dependen_del_veredicto_y_del_modo() {
        let Verdict::Valid(valid) = review(&mut core(Default::default(), VALID), "{}").unwrap()
        else {
            panic!()
        };
        let verdict_valid = Verdict::Valid(valid.clone());
        let show_json = render(&Mode::Show, true, &verdict_valid);
        assert_eq!(show_json.code, 0);
        let shown: Value = serde_json::from_str(show_json.stdout.as_deref().unwrap()).unwrap();
        assert_eq!(
            shown, valid,
            "show --json es la respuesta del Core tal cual"
        );
        let validate_json = render(&Mode::Validate, true, &verdict_valid);
        let checked: Value =
            serde_json::from_str(validate_json.stdout.as_deref().unwrap()).unwrap();
        assert!(checked.get("package").is_none() && checked["status"] == "valid");
        let show_human = render(&Mode::Show, false, &verdict_valid);
        assert!(show_human.stdout.unwrap().contains("Objetivo:"));
        let validate_human = render(&Mode::Validate, false, &verdict_valid);
        assert!(!validate_human.stdout.unwrap().contains("Objetivo:"));
        assert!(show_json.stderr.is_none() && validate_human.stderr.is_none());

        let Verdict::Invalid(invalid) =
            review(&mut core(Default::default(), INVALID), "{}").unwrap()
        else {
            panic!()
        };
        let verdict_invalid = Verdict::Invalid(invalid);
        for mode in [Mode::Show, Mode::Validate] {
            let json = render(&mode, true, &verdict_invalid);
            assert_eq!(json.code, 7, "un paquete rechazado sale con 7");
            assert!(json.stderr.is_none());
            let v: Value = serde_json::from_str(json.stdout.as_deref().unwrap()).unwrap();
            assert_eq!(v["status"], "invalid");
            let human = render(&mode, false, &verdict_invalid);
            assert_eq!(human.code, 7);
            assert!(
                human.stdout.is_none(),
                "en texto el rechazo va por el error"
            );
            assert!(human.stderr.unwrap().contains("id_mismatch"));
        }
    }

    #[test]
    fn un_core_con_otro_contrato_no_se_interpreta() {
        let valid: Value = serde_json::from_str(VALID).unwrap();
        let invalid: Value = serde_json::from_str(INVALID).unwrap();
        let edit = |base: &Value, f: fn(&mut Value)| {
            let mut v = base.clone();
            f(&mut v);
            v
        };
        for (name, resp) in [
            ("versión", edit(&valid, |v| v["v"] = json!(2))),
            ("estado", edit(&valid, |v| v["status"] = json!("quizas"))),
            ("sin id", edit(&valid, |v| v["package_id"] = json!("x"))),
            ("sin paquete", edit(&valid, |v| v["package"] = Value::Null)),
            ("sin resumen", edit(&valid, |v| v["summary"] = Value::Null)),
            (
                "sin verificación",
                edit(&valid, |v| v["verification"] = json!({})),
            ),
            (
                "código de rechazo desconocido",
                edit(&invalid, |v| v["error"]["code"] = json!("rara")),
            ),
        ] {
            let mut rpc = move |_: &str, _: &Value| Ok(resp.clone());
            match review(&mut rpc, "{}") {
                Err(Failure::Version(m)) => assert!(m.contains("actualiza Lixbon"), "{name}: {m}"),
                other => panic!("{name}: {other:?}"),
            }
        }
    }

    #[test]
    fn los_errores_del_core_se_traducen_a_codigos() {
        let fails = |m: &str| {
            let m = m.to_string();
            let mut rpc = move |_: &str, _: &Value| Err(RpcFailure::Rejected(m.clone()));
            review(&mut rpc, "{}").unwrap_err()
        };
        assert!(
            matches!(fails("context_preview_auth_required: x"), Failure::Auth(m) if m.contains("solo para personas"))
        );
        assert!(matches!(
            fails("context_preview_invalid_request: `package` es el JSON"),
            Failure::Version(_)
        ));
        assert!(matches!(
            fails("Comando desconocido: context_package_preview"),
            Failure::Version(_)
        ));
        assert!(matches!(fails("algo raro"), Failure::Internal(_)));
        assert_eq!(fails("context_preview_auth_required: x").code().1, 3);
    }

    #[test]
    fn lee_un_archivo_utf8_con_o_sin_bom_y_la_entrada_estandar() {
        let d = dir("lectura");
        let path = d.join("p.json");
        std::fs::write(&path, "{\"a\":1}").unwrap();
        assert_eq!(read(&path).unwrap(), "{\"a\":1}");
        std::fs::write(&path, b"\xef\xbb\xbf{\"a\":1}").unwrap();
        assert_eq!(read(&path).unwrap(), "{\"a\":1}", "el BOM se ignora");
        let mut stdin = Cursor::new(b"{\"b\":2}".to_vec());
        assert_eq!(read_source("-", &mut stdin).unwrap(), "{\"b\":2}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn archivos_imposibles_se_rechazan_antes_de_llamar_al_core_y_sin_repetir_su_contenido() {
        let d = dir("limites");
        let path = d.join("p.json");
        // Inexistente.
        match read(&d.join("no-existe.json")) {
            Err(Failure::NotFound(m)) => assert!(
                m.contains("No hay ningún archivo") && m.contains("package_id ni por intento"),
                "{m}"
            ),
            other => panic!("{other:?}"),
        }
        // Una carpeta no es un archivo.
        assert!(usage_msg(read(&d)).contains("no es un archivo"));
        // Vacío.
        std::fs::write(&path, "  \n").unwrap();
        assert!(usage_msg(read(&path)).contains("vacío"));
        // UTF-16 (PowerShell 5) y bytes que no son UTF-8.
        std::fs::write(&path, b"\xff\xfe{\x00}\x00").unwrap();
        assert!(usage_msg(read(&path)).contains("UTF-16"));
        std::fs::write(&path, b"\xfe\xff\x00{\x00}").unwrap();
        assert!(usage_msg(read(&path)).contains("UTF-16"));
        let mut bad = LEAK.as_bytes().to_vec();
        bad.extend([0xc3, 0x28]);
        std::fs::write(&path, &bad).unwrap();
        let m = usage_msg(read(&path));
        assert!(m.contains("no es UTF-8"), "{m}");
        assert!(
            !m.contains(LEAK),
            "el error repitió el contenido del archivo"
        );
        // Más del tope: por tamaño del archivo y por lo que se lee (entrada estándar).
        std::fs::write(&path, vec![b'a'; MAX_BYTES + 1]).unwrap();
        assert!(usage_msg(read(&path)).contains("pesa más de 128 KiB"));
        std::fs::write(&path, vec![b'a'; MAX_BYTES]).unwrap();
        assert_eq!(
            read(&path).unwrap().len(),
            MAX_BYTES,
            "justo en el tope se acepta"
        );
        let mut big = Cursor::new(vec![b'a'; MAX_BYTES + 1]);
        assert!(usage_msg(read_source("-", &mut big))
            .contains("La entrada estándar pesa más de 128 KiB"));
        let mut vacio = Cursor::new(Vec::new());
        assert!(usage_msg(read_source("-", &mut vacio)).contains("vacío"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn la_ruta_se_muestra_sin_caracteres_de_control() {
        // En Windows un nombre así es inválido (Usage); en Unix, simplemente no existe (NotFound).
        match read_source("a\u{1b}[31mb\n.json", &mut Cursor::new(Vec::new())) {
            Err(Failure::NotFound(m)) | Err(Failure::Usage(m)) => {
                assert!(
                    !m.chars().any(|c| c.is_control()),
                    "caracter de control en el error"
                );
                assert!(m.contains("a?[31mb?.json"), "{m}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn show_decide_si_es_un_archivo_un_paquete_guardado_o_un_intento() {
        let id = "sha256:ed8802df89b2fc0ce7b1535f6233a49548df5bdfd5ffaa984ccb6c2cd213b6a4";
        assert_eq!(show_target("-"), ShowTarget::File);
        assert_eq!(show_target(id), ShowTarget::Package(id.into()));
        assert_eq!(show_target("t3-a1"), ShowTarget::Attempt("t3-a1".into()));
        // Lo que parece una ruta es un archivo, aunque no exista: así un error de tipeo da «archivo inexistente», no «intento».
        for file in [
            "paquete.json",
            "./t3-a1",
            "dir/t3-a1",
            "t3-a1.json",
            "C:\\x\\p.json",
        ] {
            assert_eq!(show_target(file), ShowTarget::File, "{file}");
        }
    }

    #[test]
    fn un_archivo_que_se_llama_como_un_intento_gana_al_intento() {
        let d = std::env::temp_dir().join(format!("lxo-ctx-shadow-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let file = d.join("t3-a1");
        std::fs::write(&file, "{}").unwrap();
        // Con la ruta completa es un archivo; el id a secas, sin archivo en la carpeta actual, es un intento.
        assert_eq!(show_target(&file.to_string_lossy()), ShowTarget::File);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn uso_invalido_se_rechaza_antes_de_leer_nada() {
        for (raw, wanted) in [
            (&["context"][..], "Uso: lxo context show"),
            (
                &["context", "ver", "p.json"][..],
                "no es una orden de lxo context",
            ),
            (&["context", "show"][..], "Falta el paquete"),
            (&["context", "validate"][..], "Falta el paquete"),
            (&["context", "import"][..], "Falta el paquete"),
            (&["context", "export"][..], "Falta qué exportar"),
            (&["context", "export", "t3-a1"][..], "Falta --out"),
            (
                &["context", "export", "t3-a1", "--out", "a", "b"][..],
                "un solo paquete o intento",
            ),
            (
                &["context", "export", "t3-a1", "--out"][..],
                "--out requiere un valor",
            ),
            (
                &["context", "export", "t3-a1", "--out", "a", "--force=1"][..],
                "no admite un valor",
            ),
            (
                &["context", "export", "t3-a1", "--out", "a", "--todo"][..],
                "--todo no es una opción de lxo context export",
            ),
            (
                &["context", "export", "t3-a1", "--out", "a", "--out", "b"][..],
                "aparece más de una vez",
            ),
            (
                &["context", "import", "a.json", "--out", "b"][..],
                "--out no es una opción",
            ),
            (
                &["context", "show", "a.json", "b.json"][..],
                "un solo archivo",
            ),
            (
                &["context", "show", "a.json", "--json=si"][..],
                "no admite un valor",
            ),
            (
                &["context", "show", "a.json", "--out", "b"][..],
                "--out no es una opción",
            ),
            (
                &["context", "show", "a.json", "--json", "--json"][..],
                "aparece más de una vez",
            ),
        ] {
            match parse(&args(raw)) {
                Err(Failure::Usage(m)) => assert!(m.contains(wanted), "{raw:?}: {m}"),
                other => panic!("{raw:?}: {other:?}"),
            }
        }
        assert_eq!(parse(&args(&["context", "help"])).unwrap(), Request::Help);
        assert_eq!(parse(&args(&["context", "--help"])).unwrap(), Request::Help);
        assert_eq!(
            parse(&args(&["context", "show", "-"])).unwrap(),
            Request::Review {
                mode: Mode::Show,
                source: "-".into()
            },
            "- es la entrada estándar, no una opción"
        );
        assert_eq!(
            parse(&args(&["context", "validate", "p.json", "--json"])).unwrap(),
            Request::Review {
                mode: Mode::Validate,
                source: "p.json".into()
            }
        );
        assert_eq!(
            parse(&args(&["context", "import", "p.json"])).unwrap(),
            Request::Review {
                mode: Mode::Import,
                source: "p.json".into()
            }
        );
        // `--stored` es un indicador: no se come el argumento que le sigue.
        assert_eq!(
            parse(&args(&[
                "context", "export", "--stored", "t3-a1", "--out", "p.json"
            ]))
            .unwrap(),
            Request::Export(ExportOpts {
                target: Target::AttemptStored("t3-a1".into()),
                out: "p.json".into(),
                force: false
            })
        );
    }

    #[test]
    fn la_ayuda_documenta_los_cuatro_comandos_y_el_resumen_los_lista() {
        for cmd in [
            "lxo context show",
            "lxo context validate",
            "lxo context export",
            "lxo context import",
        ] {
            assert!(HELP.contains(cmd), "{cmd}");
            assert!(crate::HELP.contains(cmd), "{cmd} en el resumen");
        }
        assert!(HELP.contains("7 paquete rechazado") && HELP.contains("NO se guarda"));
        assert!(
            HELP.contains("no se sobrescribe sin --force")
                && HELP.contains("permisos solo del dueño")
        );
        assert!(!HELP.contains("no existen"), "ya existen");
    }

    // ── export, import y show por id con un Core simulado ──────────────────────────────────────────────────────────────

    /// Un Core que construye, guarda y entrega el paquete de la fixture publicada, con sus adjuntos, y anota lo que se le pidió.
    fn store_core(sent: Sent) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        move |cmd, a| {
            sent.borrow_mut().push((cmd.to_string(), a.clone()));
            let mut v: Value = serde_json::from_str(VALID).unwrap();
            match cmd {
                "context_package_build" | "context_package_import" => {
                    let created = cmd == "context_package_build" || a["attachments"].is_object();
                    v["stored"] = json!({ "origin": if cmd == "context_package_build" { "built" } else { "imported" }, "created_at_ms": 1, "stored_at_ms": 2, "created": created });
                }
                "context_package_get" => {
                    v["stored"] = json!({ "origin": "built", "created_at_ms": 1, "stored_at_ms": 2, "created": null });
                }
                "context_package_preview" => {}
                other => panic!("comando inesperado {other}"),
            }
            let atts: Vec<Value> = v["package"]["attachments"].as_array().unwrap().iter().map(|x| json!({ "id": x["id"], "kind": x["kind"], "bytes": x["bytes"], "sha256": x["sha256"], "scanned": x["scanned"], "omitted": null, "stored": true })).collect();
            v["attachments"] = Value::Array(atts);
            if a["include_attachments"] == true {
                let data: serde_json::Map<String, Value> = v["package"]["attachments"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| {
                        (
                            x["id"].as_str().unwrap().to_string(),
                            Value::String(base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                format!("bytes de {}", x["id"].as_str().unwrap()),
                            )),
                        )
                    })
                    .collect();
                v["attachment_data"] = Value::Object(data);
            }
            Ok(v)
        }
    }

    const PKG_ID: &str = "sha256:ed8802df89b2fc0ce7b1535f6233a49548df5bdfd5ffaa984ccb6c2cd213b6a4";

    fn export_opts(raw: &[&str]) -> ExportOpts {
        match parse(&args(raw)).unwrap() {
            Request::Export(o) => o,
            other => panic!("{other:?}"),
        }
    }

    fn called(sent: &Sent) -> Vec<String> {
        sent.borrow().iter().map(|(c, _)| c.clone()).collect()
    }

    #[test]
    fn exportar_un_intento_construye_lo_trae_por_id_y_lo_escribe_con_sus_adjuntos() {
        let d = dir("export-intento");
        let out = d.join("p.json").to_string_lossy().into_owned();
        let sent: Sent = Default::default();
        let r = export(
            &mut store_core(sent.clone()),
            &export_opts(&["context", "export", "t3-a1", "--out", &out]),
        )
        .unwrap();
        // Primero construye (el Core decide qué evidencia entra) y luego pide ESE paquete con sus adjuntos.
        assert_eq!(
            called(&sent),
            ["context_package_build", "context_package_get"]
        );
        assert_eq!(sent.borrow()[0].1, json!({ "attempt_id": "t3-a1" }));
        assert_eq!(
            sent.borrow()[1].1,
            json!({ "package_id": PKG_ID, "include_attachments": true })
        );
        assert_eq!(
            (
                r["status"].as_str(),
                r["built"].as_bool(),
                r["file"].as_str()
            ),
            (Some("exported"), Some(true), Some(out.as_str()))
        );
        // El archivo es el paquete tal cual el Core lo dio y los adjuntos van al lado.
        let escrito: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        assert_eq!(
            escrito,
            serde_json::from_str::<Value>(VALID).unwrap()["package"]
        );
        let adj = d.join("p.json.attachments");
        assert_eq!(std::fs::read_dir(&adj).unwrap().count(), 4);
        assert_eq!(
            std::fs::read_to_string(adj.join("att-c9ac7b0624824f84")).unwrap(),
            "bytes de att:c9ac7b0624824f84"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn exportar_un_paquete_o_el_ultimo_de_un_intento_no_construye_nada() {
        let d = dir("export-guardado");
        let sent: Sent = Default::default();
        let por_id = d.join("a.json").to_string_lossy().into_owned();
        let r = export(
            &mut store_core(sent.clone()),
            &export_opts(&["context", "export", PKG_ID, "--out", &por_id]),
        )
        .unwrap();
        assert_eq!(
            (called(&sent), r["built"].as_bool()),
            (vec!["context_package_get".to_string()], Some(false))
        );
        assert_eq!(
            sent.borrow()[0].1,
            json!({ "package_id": PKG_ID, "include_attachments": true })
        );
        let sent: Sent = Default::default();
        let por_intento = d.join("b.json").to_string_lossy().into_owned();
        export(
            &mut store_core(sent.clone()),
            &export_opts(&[
                "context",
                "export",
                "t3-a1",
                "--stored",
                "--out",
                &por_intento,
            ]),
        )
        .unwrap();
        assert_eq!(
            called(&sent),
            ["context_package_get"],
            "con --stored no se construye"
        );
        assert_eq!(
            sent.borrow()[0].1,
            json!({ "attempt_id": "t3-a1", "include_attachments": true })
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_destino_imposible_no_llega_a_pedir_nada_al_core() {
        let d = dir("export-destino");
        let existente = d.join("ya.json");
        std::fs::write(&existente, "viejo").unwrap();
        let sent: Sent = Default::default();
        let o = existente.to_string_lossy().into_owned();
        match export(
            &mut store_core(sent.clone()),
            &export_opts(&["context", "export", "t3-a1", "--out", &o]),
        ) {
            Err(Failure::Usage(m)) => assert!(m.contains("no sobrescribe sin --force"), "{m}"),
            other => panic!("{other:?}"),
        }
        assert!(
            sent.borrow().is_empty(),
            "no se construye un paquete que no cabe donde se pide"
        );
        assert_eq!(std::fs::read_to_string(&existente).unwrap(), "viejo");
        // Con --force sí.
        export(
            &mut store_core(sent.clone()),
            &export_opts(&["context", "export", "t3-a1", "--out", &o, "--force"]),
        )
        .unwrap();
        assert_ne!(std::fs::read_to_string(&existente).unwrap(), "viejo");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sin_paquete_guardado_con_stored_lo_dice_y_sin_stored_construye() {
        let d = dir("export-sin-guardado");
        let out = d.join("p.json").to_string_lossy().into_owned();
        let mut sin_paquete = |_: &str, _: &Value| {
            Err(RpcFailure::Rejected("context_store_not_found: no hay ningún paquete del Attempt t3-a1: se construye con `context_package_build` o se importa".into()))
        };
        match export(
            &mut sin_paquete,
            &export_opts(&["context", "export", "t3-a1", "--stored", "--out", &out]),
        ) {
            Err(Failure::NotFound(m)) => {
                assert!(m.contains("exporta sin --stored para construir uno"), "{m}")
            }
            other => panic!("{other:?}"),
        }
        assert!(!Path::new(&out).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn mostrar_un_paquete_guardado_pide_el_id_o_el_intento_y_dice_su_origen() {
        for (source, want) in [
            (PKG_ID, json!({ "package_id": PKG_ID })),
            ("t3-a1", json!({ "attempt_id": "t3-a1" })),
        ] {
            let sent: Sent = Default::default();
            let v = acquire(
                &mut store_core(sent.clone()),
                &Mode::Show,
                source,
                &mut Cursor::new(Vec::new()),
            )
            .unwrap();
            assert_eq!(
                (called(&sent), sent.borrow()[0].1.clone()),
                (vec!["context_package_get".to_string()], want)
            );
            let Verdict::Valid(data) = v else { panic!() };
            let human = show_text(&data);
            assert!(
                human.contains(
                    "Guardado:     construido por este Core · adjuntos guardados: 4 de 4"
                ),
                "{human}"
            );
        }
        // Sin paquete guardado de ese intento: no es un archivo ni un paquete, y dice cómo guardar uno.
        let mut vacio = |_: &str, _: &Value| {
            Err(RpcFailure::Rejected(
                "context_store_not_found: no hay ningún paquete".into(),
            ))
        };
        match acquire(
            &mut vacio,
            &Mode::Show,
            "t9-a1",
            &mut Cursor::new(Vec::new()),
        ) {
            Err(Failure::NotFound(m)) => assert!(
                m.contains("No hay ningún archivo ni ningún paquete guardado del intento «t9-a1»")
                    && m.contains("lxo context export t9-a1 --out"),
                "{m}"
            ),
            other => panic!("{other:?}"),
        }
        // Un archivo sigue revisándose con la vista previa, sin guardar nada.
        let sent: Sent = Default::default();
        acquire(
            &mut store_core(sent.clone()),
            &Mode::Show,
            "-",
            &mut Cursor::new(b"{}".to_vec()),
        )
        .unwrap();
        assert_eq!(called(&sent), ["context_package_preview"]);
    }

    #[test]
    fn importar_manda_el_paquete_y_los_adjuntos_de_al_lado_y_dice_que_no_inicio_nada() {
        let d = dir("import");
        let file = d.join("p.json");
        std::fs::write(&file, "{\"paquete\":true}").unwrap();
        let adj = d.join("p.json.attachments");
        std::fs::create_dir_all(&adj).unwrap();
        std::fs::write(adj.join("att-c9ac7b0624824f84"), b"bundle").unwrap();
        let sent: Sent = Default::default();
        let v = acquire(
            &mut store_core(sent.clone()),
            &Mode::Import,
            &file.to_string_lossy(),
            &mut Cursor::new(Vec::new()),
        )
        .unwrap();
        let args = sent.borrow()[0].1.clone();
        assert_eq!(
            (called(&sent), args["package"].as_str()),
            (
                vec!["context_package_import".to_string()],
                Some("{\"paquete\":true}")
            )
        );
        assert_eq!(
            args["attachments"],
            json!({ "att:c9ac7b0624824f84": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"bundle") })
        );
        let Verdict::Valid(data) = v else { panic!() };
        let out = render(&Mode::Import, false, &Verdict::Valid(data.clone()));
        let text = out.stdout.unwrap();
        assert!(
            text.contains("importado y guardado en el Core")
                && text.contains("no se ha iniciado ninguno"),
            "{text}"
        );
        // --json: la respuesta del Core sin el paquete.
        let json = render(&Mode::Import, true, &Verdict::Valid(data));
        let v: Value = serde_json::from_str(&json.stdout.unwrap()).unwrap();
        assert!(v.get("package").is_none() && v["stored"]["origin"] == "imported");
        // Sin carpeta de adjuntos no manda `attachments`; por la entrada estándar tampoco.
        let sent: Sent = Default::default();
        std::fs::remove_dir_all(&adj).unwrap();
        acquire(
            &mut store_core(sent.clone()),
            &Mode::Import,
            &file.to_string_lossy(),
            &mut Cursor::new(Vec::new()),
        )
        .unwrap();
        assert!(sent.borrow()[0].1.get("attachments").is_none());
        let sent: Sent = Default::default();
        acquire(
            &mut store_core(sent.clone()),
            &Mode::Import,
            "-",
            &mut Cursor::new(b"{}".to_vec()),
        )
        .unwrap();
        assert!(sent.borrow()[0].1.get("attachments").is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_paquete_que_el_core_rechaza_al_importar_sale_con_7_sin_mostrarse() {
        let d = dir("import-malo");
        let file = d.join("p.json");
        std::fs::write(&file, "{}").unwrap();
        let mut rechazo = |_: &str, _: &Value| Ok(serde_json::from_str::<Value>(INVALID).unwrap());
        let v = acquire(
            &mut rechazo,
            &Mode::Import,
            &file.to_string_lossy(),
            &mut Cursor::new(Vec::new()),
        )
        .unwrap();
        let out = render(&Mode::Import, false, &v);
        assert_eq!(out.code, 7);
        assert!(out.stdout.is_none() && out.stderr.unwrap().contains("id_mismatch"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn los_errores_de_paquetes_guardados_se_traducen_a_codigos() {
        let fails = |m: &str| {
            let m = m.to_string();
            let mut rpc = move |_: &str, _: &Value| Err(RpcFailure::Rejected(m.clone()));
            fetch(&mut rpc, "context_package_get", &json!({})).unwrap_err()
        };
        assert!(
            matches!(fails("context_store_auth_required: x"), Failure::Auth(m) if m.contains("solo para personas"))
        );
        assert!(
            matches!(fails("core_model_inactive: legacy"), Failure::Version(m) if m.contains("tras el corte"))
        );
        assert!(
            matches!(fails("context_store_invalid_request: falta"), Failure::Version(m) if m.contains("actualiza Lixbon"))
        );
        assert!(
            matches!(fails("context_store_not_found: no hay el paquete x"), Failure::NotFound(m) if m.contains("no hay el paquete x"))
        );
        assert!(
            matches!(fails("context_store_attachments_too_large: los adjuntos pesan 3 bytes"), Failure::Usage(m) if m.contains("Publica la rama"))
        );
        assert!(matches!(
            fails("context_store_unavailable: el almacén no está abierto"),
            Failure::Unavailable(_)
        ));
        assert!(
            matches!(fails("context_store_unavailable: la Task no tiene proyecto"), Failure::Usage(m) if m.contains("proyecto"))
        );
        assert!(matches!(
            fails("context_store_corrupt: x"),
            Failure::Internal(_)
        ));
        assert_eq!(fails("context_store_auth_required: x").code().1, 3);
        assert_eq!(fails("context_store_not_found: x").code().1, 6);
    }
}
