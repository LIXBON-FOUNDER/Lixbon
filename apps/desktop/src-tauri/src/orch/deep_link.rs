//! LXO-168 · esquema `lixbon://` con identidad durable: parser, validador y generador canónico.
//!
//! Contrato: `docs/core/DEEP_LINKS.md`. Este módulo es PURO: no lee el almacén ni el disco. Solo dice si un texto es un
//! enlace bien formado y lo normaliza; que el Project/Task/Attempt existan y sean coherentes, que la revisión siga
//! vigente y que el host esté disponible lo decide la resolución (`deep_link_read`), siempre DESPUÉS de autorizar el
//! destino.
//!
//! ```text
//! lixbon://project/<project_id>[/task/<task_id>[/attempt/<attempt_id>]]
//!         [?view=<vista>][&file=<ruta relativa>][&line=<n>][&revision=<sha>][&v=1]
//! ```
//!
//! Invariantes (cada una tiene su prueba):
//! 1. Una ruta absoluta nunca es identidad: `file` es relativo al ProjectLocation/Worktree que se resuelva, y todo lo
//!    que parezca absoluto o suba de directorio se rechaza (`../`, `%2e%2e`, `\`, `C:`, doble codificación).
//! 2. Las claves son estrictas: una clave desconocida o repetida invalida el enlace en vez de ignorarse.
//! 3. Un enlace no otorga permisos: aquí solo se valida la forma.
//! 4. `parse(generate(x)) == x` y `generate(parse(s))` es la forma canónica única del enlace.

/// Versión del esquema que entiende este Core. `v` ausente equivale a 1; la forma canónica no la escribe.
pub(super) const SCHEMA_VERSION: u32 = 1;
const SCHEME: &str = "lixbon";
const MAX_LINK_CHARS: usize = 2048;
const MAX_ID_CHARS: usize = 200;
const MAX_FILE_CHARS: usize = 1024;
const MAX_LINE: u32 = 10_000_000;
const MIN_REVISION_CHARS: usize = 7;
const MAX_REVISION_CHARS: usize = 64;

/// Vistas a las que puede apuntar un enlace. La disponibilidad real (¿hay Review? ¿hay Artifacts?) la dice la resolución.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum View {
    Overview,
    Activity,
    Diff,
    Review,
    Artifact,
}

impl View {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            View::Overview => "overview",
            View::Activity => "activity",
            View::Diff => "diff",
            View::Review => "review",
            View::Artifact => "artifact",
        }
    }

    pub(super) fn from_name(raw: &str) -> Option<View> {
        Some(match raw {
            "overview" => View::Overview,
            "activity" => View::Activity,
            "diff" => View::Diff,
            "review" => View::Review,
            "artifact" => View::Artifact,
            _ => return None,
        })
    }

    /// Las vistas que muestran la ejecución de un intento concreto no tienen sentido sin él.
    pub(super) fn needs_attempt(self) -> bool {
        matches!(self, View::Diff | View::Review | View::Artifact)
    }

    /// Una vista de resumen no abre archivos.
    fn accepts_file(self) -> bool {
        matches!(self, View::Diff | View::Review | View::Artifact)
    }
}

/// Códigos estables de error de enlace. Los dos primeros nacen al leer el texto; el resto, al resolverlo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LinkCode {
    Malformed,
    VersionUnsupported,
    NotFound,
    TargetMismatch,
    Stale,
    Unauthorized,
    HostUnavailable,
}

impl LinkCode {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            LinkCode::Malformed => "link_malformed",
            LinkCode::VersionUnsupported => "link_version_unsupported",
            LinkCode::NotFound => "link_not_found",
            LinkCode::TargetMismatch => "link_target_mismatch",
            LinkCode::Stale => "link_stale",
            LinkCode::Unauthorized => "link_unauthorized",
            LinkCode::HostUnavailable => "link_host_unavailable",
        }
    }
}

/// Error con código estable y mensaje en llano. El mensaje nunca repite el texto recibido: es entrada no confiable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LinkError {
    pub(super) code: LinkCode,
    pub(super) message: String,
}

impl LinkError {
    pub(super) fn new(code: LinkCode, message: impl Into<String>) -> LinkError {
        LinkError { code, message: message.into() }
    }

    /// `código: mensaje`, el formato de error de los RPC del Core.
    pub(super) fn into_rpc(self) -> String {
        format!("{}: {}", self.code.as_str(), self.message)
    }
}

fn malformed(message: &str) -> LinkError {
    LinkError::new(LinkCode::Malformed, message)
}

/// Un enlace ya validado en su forma. Los campos opcionales ausentes no cambian de significado al resolver.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DeepLink {
    pub(super) project_id: String,
    pub(super) task_id: Option<String>,
    pub(super) attempt_id: Option<String>,
    pub(super) view: Option<View>,
    /// Relativo y normalizado (separador `/`); nunca vacío ni absoluto.
    pub(super) file: Option<String>,
    pub(super) line: Option<u32>,
    /// Hexadecimal en minúsculas (7 a 64). Se compara con la revisión del Attempt al resolver.
    pub(super) revision: Option<String>,
}

impl DeepLink {
    /// Comprobaciones entre campos que no dependen del almacén. Se aplican al leer y al generar.
    pub(super) fn validate(&self) -> Result<(), LinkError> {
        check_id(&self.project_id, "project")?;
        if let Some(t) = &self.task_id {
            check_id(t, "task")?;
        }
        if let Some(a) = &self.attempt_id {
            check_id(a, "attempt")?;
            if self.task_id.is_none() {
                return Err(malformed("un Attempt va siempre bajo su Task"));
            }
        }
        if let Some(view) = self.view {
            if view.needs_attempt() && self.attempt_id.is_none() {
                return Err(malformed("esa vista necesita un Attempt concreto"));
            }
            if self.file.is_some() && !view.accepts_file() {
                return Err(malformed("esa vista no abre archivos"));
            }
        }
        if let Some(file) = &self.file {
            check_file(file)?;
        }
        match (self.line, &self.file) {
            (Some(_), None) => return Err(malformed("`line` necesita `file`")),
            (Some(n), Some(_)) if !(1..=MAX_LINE).contains(&n) => return Err(malformed("`line` fuera de rango")),
            _ => {}
        }
        if let Some(rev) = &self.revision {
            if self.attempt_id.is_none() {
                return Err(malformed("`revision` se compara con la de un Attempt: falta el Attempt"));
            }
            check_revision(rev)?;
        }
        Ok(())
    }

    /// Forma canónica: segmentos fijos, claves en orden `view, file, line, revision`, valores normalizados y sin `v`.
    /// Falla si el enlace no es válido: un cliente nunca emite un enlace que este mismo Core rechazaría.
    pub(super) fn to_url(&self) -> Result<String, LinkError> {
        self.validate()?;
        let mut url = format!("{SCHEME}://project/{}", self.project_id);
        if let Some(t) = &self.task_id {
            url.push_str(&format!("/task/{t}"));
        }
        if let Some(a) = &self.attempt_id {
            url.push_str(&format!("/attempt/{a}"));
        }
        let mut query: Vec<String> = Vec::new();
        if let Some(v) = self.view {
            query.push(format!("view={}", v.as_str()));
        }
        if let Some(f) = &self.file {
            query.push(format!("file={}", encode_file(f)));
        }
        if let Some(n) = self.line {
            query.push(format!("line={n}"));
        }
        if let Some(r) = &self.revision {
            query.push(format!("revision={r}"));
        }
        if !query.is_empty() {
            url.push('?');
            url.push_str(&query.join("&"));
        }
        Ok(url)
    }
}

/// Lee y valida un enlace. Quita espacios de los extremos (es lo que se arrastra al copiar y pegar); cualquier otro
/// espacio o control dentro invalida el enlace.
pub(super) fn parse(raw: &str) -> Result<DeepLink, LinkError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(malformed("el enlace está vacío"));
    }
    if raw.chars().count() > MAX_LINK_CHARS {
        return Err(malformed("el enlace es demasiado largo"));
    }
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(malformed("el enlace contiene espacios o caracteres de control"));
    }
    let (scheme, rest) = raw.split_once("://").ok_or_else(|| malformed("falta el esquema `lixbon://`"))?;
    if !scheme.eq_ignore_ascii_case(SCHEME) {
        return Err(malformed("el esquema debe ser `lixbon`"));
    }
    if rest.contains('#') {
        return Err(malformed("los enlaces no llevan fragmento"));
    }
    let (path, query) = match rest.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (rest, None),
    };
    let segments: Vec<&str> = path.split('/').collect();
    // `project/<id>` · `/task/<id>` · `/attempt/<id>`: pares clave/valor en un orden fijo, sin barras sobrantes.
    let mut it = segments.iter().copied();
    if it.next() != Some("project") {
        return Err(malformed("el enlace debe empezar por `project/<id>`"));
    }
    let project_id = it.next().ok_or_else(|| malformed("falta el id del Project"))?.to_string();
    let mut task_id = None;
    let mut attempt_id = None;
    match it.next() {
        None => {}
        Some("task") => {
            task_id = Some(it.next().ok_or_else(|| malformed("falta el id de la Task"))?.to_string());
            match it.next() {
                None => {}
                Some("attempt") => {
                    attempt_id = Some(it.next().ok_or_else(|| malformed("falta el id del Attempt"))?.to_string());
                    if it.next().is_some() {
                        return Err(malformed("sobran segmentos tras el Attempt"));
                    }
                }
                Some(_) => return Err(malformed("tras la Task solo puede ir `attempt/<id>`")),
            }
        }
        Some(_) => return Err(malformed("tras el Project solo puede ir `task/<id>`")),
    }

    // La versión se mira antes que el resto de la consulta: un enlace de un esquema futuro puede traer claves nuevas y
    // «versión no soportada» es más útil que «parámetro desconocido». Solo vale si la ruta base ya era válida.
    if let Some(v) = query.and_then(|q| q.split('&').find_map(|p| p.strip_prefix("v="))) {
        if !v.is_empty() && v.len() <= 9 && v.bytes().all(|b| b.is_ascii_digit()) && v.parse::<u32>().is_ok_and(|n| n > SCHEMA_VERSION) {
            return Err(LinkError::new(LinkCode::VersionUnsupported, format!("el enlace usa la versión {v} del esquema y este Core entiende hasta la {SCHEMA_VERSION}")));
        }
    }
    let mut view = None;
    let mut file = None;
    let mut line = None;
    let mut revision = None;
    let mut version = None;
    if let Some(q) = query {
        if q.is_empty() {
            return Err(malformed("la consulta está vacía"));
        }
        for pair in q.split('&') {
            let (key, value) = pair.split_once('=').ok_or_else(|| malformed("cada parámetro es `clave=valor`"))?;
            let seen = match key {
                "view" => view.is_some(),
                "file" => file.is_some(),
                "line" => line.is_some(),
                "revision" => revision.is_some(),
                "v" => version.is_some(),
                _ => return Err(malformed("parámetro desconocido")),
            };
            if seen {
                return Err(malformed("parámetro repetido"));
            }
            match key {
                "view" => view = Some(View::from_name(value).ok_or_else(|| malformed("vista desconocida"))?),
                "file" => file = Some(decode_file(value)?),
                "line" => {
                    if value.is_empty() || value.len() > 8 || !value.bytes().all(|b| b.is_ascii_digit()) {
                        return Err(malformed("`line` es un entero positivo"));
                    }
                    line = Some(value.parse::<u32>().map_err(|_| malformed("`line` fuera de rango"))?);
                }
                "revision" => revision = Some(value.to_ascii_lowercase()),
                _ => {
                    if value.is_empty() || value.len() > 9 || !value.bytes().all(|b| b.is_ascii_digit()) {
                        return Err(malformed("`v` es un entero"));
                    }
                    version = Some(value.parse::<u32>().map_err(|_| malformed("`v` fuera de rango"))?);
                }
            }
        }
    }
    if version == Some(0) {
        return Err(malformed("`v` empieza en 1"));
    }
    let link = DeepLink { project_id, task_id, attempt_id, view, file, line, revision };
    link.validate()?;
    Ok(link)
}

fn check_id(id: &str, what: &str) -> Result<(), LinkError> {
    let ok = !id.is_empty()
        && id.chars().count() <= MAX_ID_CHARS
        && id != "."
        && id != ".."
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(malformed(&format!("el id de {what} tiene caracteres no permitidos o una longitud fuera de rango")))
    }
}

pub(super) fn check_revision(rev: &str) -> Result<(), LinkError> {
    let ok = (MIN_REVISION_CHARS..=MAX_REVISION_CHARS).contains(&rev.len()) && rev.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if ok {
        Ok(())
    } else {
        Err(malformed("`revision` es un hash hexadecimal de 7 a 64 caracteres"))
    }
}

/// Valida una ruta relativa YA decodificada.
pub(super) fn check_file(file: &str) -> Result<(), LinkError> {
    if file.is_empty() || file.chars().count() > MAX_FILE_CHARS {
        return Err(malformed("`file` debe tener de 1 a 1024 caracteres"));
    }
    if file.chars().any(|c| c.is_control() || c == '\\') {
        return Err(malformed("`file` no admite controles ni barras invertidas"));
    }
    if file.starts_with('/') {
        return Err(malformed("`file` es relativo: no puede empezar por `/`"));
    }
    let bytes = file.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(malformed("`file` es relativo: no puede llevar una unidad de disco"));
    }
    for segment in file.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(malformed("`file` no admite segmentos vacíos, `.` ni `..`"));
        }
        // Si tras decodificar queda un `%XX`, alguien codificó dos veces: un consumidor que decodifique otra vez vería otra ruta.
        if has_percent_escape(segment) {
            return Err(malformed("`file` está codificado dos veces"));
        }
    }
    Ok(())
}

fn has_percent_escape(s: &str) -> bool {
    let b = s.as_bytes();
    b.windows(3).any(|w| w[0] == b'%' && w[1].is_ascii_hexdigit() && w[2].is_ascii_hexdigit())
}

/// Decodifica un valor de `file`: UTF-8 percent-encoded estricto, una sola vez. `+` es un `+`.
fn decode_file(value: &str) -> Result<String, LinkError> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = bytes.get(i + 1).and_then(|b| (*b as char).to_digit(16));
            let lo = bytes.get(i + 2).and_then(|b| (*b as char).to_digit(16));
            match (hi, lo) {
                (Some(h), Some(l)) => out.push((h * 16 + l) as u8),
                _ => return Err(malformed("`file` tiene una secuencia `%` incompleta")),
            }
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    let decoded = String::from_utf8(out).map_err(|_| malformed("`file` no es UTF-8 válido"))?;
    check_file(&decoded)?;
    Ok(decoded)
}

/// Codifica una ruta ya validada: se conservan las letras, los dígitos y `-._~/`; todo lo demás va como `%XX`.
fn encode_file(file: &str) -> String {
    let mut out = String::with_capacity(file.len());
    for b in file.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
