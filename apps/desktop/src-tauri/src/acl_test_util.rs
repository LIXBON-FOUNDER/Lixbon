//! Inspección de ACL de Windows SOLO PARA PRUEBAS (`#[cfg(test)]`): no es código de producción.
//!
//! Qué se comprueba y por qué. `restrict`/`restrict_to_owner` ejecutan
//! `icacls <ruta> /inheritance:r /grant:r <usuario>:F`. Eso quita lo heredado y deja al usuario con
//! control total, pero NO borra las ACE explícitas que el objeto ya tuviera: un proceso elevado
//! (administrador) crea los objetos con la DACL por defecto de su token (LocalSystem,
//! Administrators y el usuario), y esas tres entidades siguen ahí. Son cuentas privilegiadas que ya
//! pueden saltarse cualquier ACL, así que no conceden nada a usuarios ordinarios. Por eso la
//! propiedad de seguridad correcta NO es «hay exactamente una ACE», sino:
//!
//! * la DACL está protegida (no hereda) y ninguna ACE es heredada;
//! * toda ACE `Allow` pertenece a un conjunto explícito: el SID del usuario actual, LocalSystem
//!   (`S-1-5-18`) y Builtin Administrators (`S-1-5-32-544`);
//! * ningún principal amplio (Everyone, Authenticated Users, Users, Guests, Anonymous) ni ningún
//!   otro SID tiene un `Allow`;
//! * el usuario actual conserva acceso.
//!
//! Se trabaja con SID y no con nombres para no depender del idioma de Windows: `icacls /save`
//! vuelca la DACL en SDDL (SID o abreviaturas fijas como `SY`, `BA`, `WD`) y `whoami /user` da el
//! SID del usuario. La lista permitida es fija: no se amplía para contentar a un runner.

/// LocalSystem.
pub const SID_SYSTEM: &str = "S-1-5-18";
/// Builtin Administrators.
pub const SID_ADMINISTRADORES: &str = "S-1-5-32-544";
/// Principales amplios o sin privilegios: un `Allow` para cualquiera de ellos es un fallo.
pub const SIDS_AMPLIOS: [(&str, &str); 5] = [
    ("S-1-1-0", "Everyone"),
    ("S-1-5-11", "Authenticated Users"),
    ("S-1-5-32-545", "Builtin Users"),
    ("S-1-5-32-546", "Guests"),
    ("S-1-5-7", "Anonymous"),
];

/// Una ACE de la DACL, ya con el SID normalizado.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ace {
    pub allow: bool,
    /// Marcas de la ACE en SDDL (`OI`, `CI`, `ID`, ...), de dos letras cada una.
    pub flags: Vec<String>,
    pub sid: String,
}

impl Ace {
    pub fn heredada(&self) -> bool {
        self.flags.iter().any(|f| f == "ID")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dacl {
    /// `P`: la DACL no hereda del padre.
    pub protegida: bool,
    pub aces: Vec<Ace>,
}

/// Abreviatura SDDL -> SID. Lo que no se conoce se devuelve igual: no estará en la lista
/// permitida y hará fallar la comprobación, que es lo que se quiere.
///
/// `LA` es la cuenta Administrador LOCAL (RID 500), que SDDL abrevia en lugar de escribir su SID
/// completo. Solo se resuelve cuando el usuario actual es esa misma cuenta (su SID termina en
/// `-500`, como `runneradmin` en GitHub Actions): entonces `LA` ES el usuario y no concede nada
/// a nadie más. Con cualquier otro usuario se deja sin resolver y falla como SID ajeno.
pub fn sid_normalizado(sid: &str, usuario_sid: &str) -> String {
    let s = sid.trim();
    let usuario = usuario_sid.trim().to_ascii_uppercase();
    match s.to_ascii_uppercase().as_str() {
        "LA" if usuario.starts_with("S-1-5-21-") && usuario.ends_with("-500") => usuario,
        "SY" => SID_SYSTEM.into(),
        "BA" => SID_ADMINISTRADORES.into(),
        "WD" => "S-1-1-0".into(),
        "AU" => "S-1-5-11".into(),
        "BU" => "S-1-5-32-545".into(),
        "BG" => "S-1-5-32-546".into(),
        "AN" => "S-1-5-7".into(),
        _ => s.to_ascii_uppercase(),
    }
}

/// Interpreta una DACL en SDDL (`D:PAI(A;OICI;FA;;;SY)(A;;FA;;;S-1-5-21-...)`).
pub fn parse_dacl(sddl: &str, usuario_sid: &str) -> Result<Dacl, String> {
    let s = sddl.trim();
    let resto = s.strip_prefix("D:").ok_or_else(|| format!("no empieza por «D:»: {s}"))?;
    let inicio = resto.find('(').unwrap_or(resto.len());
    let (marcas, mut cuerpo) = resto.split_at(inicio);
    let protegida = marcas.contains('P');
    let mut aces = Vec::new();
    while !cuerpo.is_empty() {
        if !cuerpo.starts_with('(') {
            return Err(format!("contenido inesperado tras las ACE: «{cuerpo}»"));
        }
        // Cierre del grupo de primer nivel (las ACE condicionales anidan paréntesis).
        let mut profundidad = 0usize;
        let mut fin = None;
        for (i, c) in cuerpo.char_indices() {
            match c {
                '(' => profundidad += 1,
                ')' => {
                    profundidad -= 1;
                    if profundidad == 0 {
                        fin = Some(i);
                        break;
                    }
                }
                _ => {}
            }
        }
        let fin = fin.ok_or_else(|| format!("ACE sin cerrar: «{cuerpo}»"))?;
        let ace = &cuerpo[1..fin];
        cuerpo = &cuerpo[fin + 1..];
        let campos: Vec<&str> = ace.split(';').collect();
        if campos.len() < 6 {
            return Err(format!("ACE con menos de 6 campos: «{ace}»"));
        }
        let allow = match campos[0] {
            "A" | "OA" | "XA" | "ZA" => true,
            "D" | "OD" | "XD" => false,
            otro => return Err(format!("tipo de ACE no contemplado «{otro}»: «{ace}»")),
        };
        let flags = campos[1].as_bytes().chunks(2).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
        aces.push(Ace { allow, flags, sid: sid_normalizado(campos[5], usuario_sid) });
    }
    Ok(Dacl { protegida, aces })
}

/// Comprueba que `descriptor` (DACL en SDDL) es una ACL privada: ver la documentación del módulo.
/// El error incluye el descriptor observado y las ACE interpretadas.
pub fn verifica_privada(descriptor: &str, usuario_sid: &str, que: &str) -> Result<(), String> {
    let fallo = |motivo: String| -> Result<(), String> {
        let detalle = match parse_dacl(descriptor, usuario_sid) {
            Ok(d) => format!("{d:#?}"),
            Err(e) => format!("(no interpretable: {e})"),
        };
        Err(format!("{que}: {motivo}\n  descriptor observado: {descriptor}\n  usuario actual: {usuario_sid}\n  ACE interpretadas: {detalle}"))
    };
    let dacl = match parse_dacl(descriptor, usuario_sid) {
        Ok(d) => d,
        Err(e) => return fallo(format!("DACL no interpretable: {e}")),
    };
    let usuario = usuario_sid.trim().to_ascii_uppercase();
    if !dacl.protegida {
        return fallo("la DACL no está protegida: hereda permisos del padre".into());
    }
    if let Some(ace) = dacl.aces.iter().find(|a| a.heredada()) {
        return fallo(format!("hay una ACE heredada inesperada (SID {})", ace.sid));
    }
    for ace in dacl.aces.iter().filter(|a| a.allow) {
        if let Some((_, nombre)) = SIDS_AMPLIOS.iter().find(|(sid, _)| *sid == ace.sid) {
            return fallo(format!("Allow para un principal amplio: {nombre} ({})", ace.sid));
        }
        let permitido = ace.sid == usuario || ace.sid == SID_SYSTEM || ace.sid == SID_ADMINISTRADORES;
        if !permitido {
            return fallo(format!("Allow para un SID fuera de la lista permitida: {}", ace.sid));
        }
    }
    if !dacl.aces.iter().any(|a| a.allow && a.sid == usuario) {
        return fallo("el usuario actual no conserva acceso".into());
    }
    Ok(())
}

#[cfg(windows)]
mod windows {
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    static N: AtomicU64 = AtomicU64::new(0);

    /// SID del usuario actual, sin depender del idioma (`whoami /user /fo csv /nh`).
    pub fn sid_usuario() -> String {
        let out = std::process::Command::new("whoami").args(["/user", "/fo", "csv", "/nh"]).output().expect("whoami");
        assert!(out.status.success(), "whoami falló: {}", String::from_utf8_lossy(&out.stderr));
        let texto = String::from_utf8_lossy(&out.stdout).into_owned();
        // "DOMINIO\usuario","S-1-5-21-..."
        texto
            .trim()
            .rsplit(',')
            .next()
            .map(|s| s.trim().trim_matches('"').to_string())
            .filter(|s| s.starts_with("S-1-"))
            .unwrap_or_else(|| panic!("no se pudo leer el SID de whoami: {texto}"))
    }

    /// DACL de `path` en SDDL, con `icacls /save` (UTF-16LE: 1.ª línea = ruta, 2.ª = SDDL).
    pub fn descriptor(path: &Path) -> String {
        let salida = std::env::temp_dir().join(format!("lixbon-acl-{}-{}.txt", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let out = std::process::Command::new("icacls").arg(path).arg("/save").arg(&salida).output().expect("icacls");
        let texto = String::from_utf8_lossy(&out.stdout).into_owned();
        // Solo el código de salida: el texto de icacls depende del idioma de Windows.
        assert!(out.status.success(), "icacls /save falló para {} ({}): {texto}", path.display(), out.status);
        let bytes = std::fs::read(&salida).expect("salida de icacls /save");
        let _ = std::fs::remove_file(&salida);
        let unidades: Vec<u16> = bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
        let contenido = String::from_utf16_lossy(&unidades);
        let contenido = contenido.trim_start_matches('\u{feff}');
        contenido
            .lines()
            .map(str::trim)
            .find(|l| l.starts_with("D:"))
            .unwrap_or_else(|| panic!("icacls /save no devolvió una DACL para {}: {contenido:?}", path.display()))
            .to_string()
    }

    /// Falla si `path` no tiene una ACL privada (ver la documentación del módulo).
    pub fn comprueba_privada(path: &Path) {
        let d = descriptor(path);
        if let Err(e) = super::verifica_privada(&d, &sid_usuario(), &path.display().to_string()) {
            panic!("{e}");
        }
    }
}

#[cfg(windows)]
pub use windows::{comprueba_privada, descriptor};

#[cfg(test)]
mod tests {
    use super::*;

    const YO: &str = "S-1-5-21-111-222-333-1001";

    fn ok(d: &str) {
        verifica_privada(d, YO, "t").unwrap_or_else(|e| panic!("debía aceptarse: {e}"));
    }
    fn mal(d: &str, contiene: &str) {
        let e = verifica_privada(d, YO, "t").expect_err("debía rechazarse");
        assert!(e.contains(contiene), "falta «{contiene}» en: {e}");
        assert!(e.contains(d), "el error debe mostrar el descriptor observado: {e}");
    }

    #[test]
    fn solo_el_usuario_y_el_runner_elevado_se_aceptan() {
        ok("D:PAI(A;;FA;;;S-1-5-21-111-222-333-1001)");
        // El runner de GitHub (administrador): SYSTEM, Administrators y el usuario, sin heredar.
        ok("D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;S-1-5-21-111-222-333-1001)");
        // Carpetas: las marcas de herencia hacia hijos (OI/CI) no son ACE heredadas.
        ok("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-21-111-222-333-1001)");
        // La misma identidad dada por SID largo en lugar de abreviatura.
        ok("D:P(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)(A;;FA;;;S-1-5-21-111-222-333-1001)");
    }

    #[test]
    fn un_allow_para_un_principal_amplio_falla_con_abreviatura_o_con_sid() {
        let base = "(A;;FA;;;S-1-5-21-111-222-333-1001)";
        for (abreviatura, sid, nombre) in [
            ("WD", "S-1-1-0", "Everyone"),
            ("AU", "S-1-5-11", "Authenticated Users"),
            ("BU", "S-1-5-32-545", "Builtin Users"),
            ("BG", "S-1-5-32-546", "Guests"),
            ("AN", "S-1-5-7", "Anonymous"),
        ] {
            for quien in [abreviatura, sid] {
                mal(&format!("D:P{base}(A;;FA;;;{quien})"), nombre);
            }
        }
    }

    #[test]
    fn cualquier_otro_sid_allow_falla_y_no_se_amplia_la_lista() {
        mal("D:P(A;;FA;;;S-1-5-21-111-222-333-1001)(A;;FA;;;S-1-5-21-9-9-9-1002)", "S-1-5-21-9-9-9-1002");
        mal("D:P(A;;FA;;;S-1-5-21-111-222-333-1001)(A;;FA;;;LS)", "LS"); // abreviatura desconocida
        mal("D:P(A;;FA;;;S-1-5-21-111-222-333-1001)(A;;FA;;;S-1-5-32-547)", "S-1-5-32-547"); // Power Users
        mal("D:P(A;;FA;;;S-1-5-21-111-222-333-1001)(A;;FA;;;S-1-3-0)", "S-1-3-0"); // Creator Owner
    }

    #[test]
    fn una_ace_heredada_o_una_dacl_sin_proteger_falla() {
        mal("D:PAI(A;ID;FA;;;S-1-5-21-111-222-333-1001)", "heredada");
        mal("D:PAI(A;OICIID;FA;;;SY)(A;;FA;;;S-1-5-21-111-222-333-1001)", "heredada");
        mal("D:AI(A;;FA;;;S-1-5-21-111-222-333-1001)", "no está protegida");
    }

    #[test]
    fn el_usuario_actual_debe_conservar_el_acceso() {
        mal("D:P(A;;FA;;;SY)(A;;FA;;;BA)", "no conserva acceso");
        mal("D:P", "no conserva acceso");
        mal("D:P(D;;FA;;;S-1-5-21-111-222-333-1001)", "no conserva acceso"); // un Deny no es acceso
    }

    #[test]
    fn la_cuenta_administrador_local_abreviada_la_solo_es_el_usuario_si_es_el_rid_500() {
        // Descriptores EXACTOS observados en windows-latest (usuario `runneradmin`, RID 500):
        // SDDL escribe `LA` en lugar del SID del usuario.
        let runner = "S-1-5-21-1643835476-1616584234-1346609752-500";
        for d in [
            "D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)",
            "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)",
        ] {
            verifica_privada(d, runner, "runner").unwrap_or_else(|e| panic!("{e}"));
        }
        // La misma ACE con un usuario que NO es el RID 500: `LA` es otra cuenta y falla.
        let e = verifica_privada("D:PAI(A;;FA;;;S-1-5-21-111-222-333-1001)(A;;FA;;;LA)", YO, "t").unwrap_err();
        assert!(e.contains("fuera de la lista permitida: LA"), "{e}");
        // Y no sustituye a la ACE del usuario: sin ella no se conserva el acceso.
        let e = verifica_privada("D:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;LA)", YO, "t").unwrap_err();
        assert!(e.contains("fuera de la lista permitida: LA"), "{e}");
        // Un SID de dominio con RID 500 distinto del usuario tampoco se acepta por llamarse igual.
        assert_eq!(sid_normalizado("LA", "S-1-5-21-1-2-3-1001"), "LA");
    }

    #[test]
    fn un_deny_a_un_principal_amplio_no_cuenta_como_permiso() {
        ok("D:P(D;;FA;;;WD)(A;;FA;;;S-1-5-21-111-222-333-1001)");
    }

    #[test]
    fn lo_que_no_se_entiende_falla_en_vez_de_aceptarse() {
        mal("O:BAG:BA", "no interpretable");
        mal("D:P(A;;FA;;;SY", "no interpretable");
        mal("D:P(A;;FA)", "no interpretable");
        mal("D:P(Z;;FA;;;SY)", "no interpretable");
        mal("D:P(A;;FA;;;SY)S:(AU;;FA;;;WD)", "no interpretable");
    }

    #[test]
    fn interpreta_la_salida_real_de_icacls() {
        // Capturado con `icacls <archivo> /save` tras `/inheritance:r /grant:r`, y de su carpeta.
        let archivo = parse_dacl("D:PAI(A;;FA;;;S-1-5-21-4214038676-3060931503-1057443485-1001)", YO).unwrap();
        assert!(archivo.protegida && archivo.aces.len() == 1 && !archivo.aces[0].heredada());
        let carpeta = parse_dacl("D:AI(A;OICIID;0x1301bf;;;S-1-5-21-1685149312-3597025893-3609881159-3525561410)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)", YO).unwrap();
        assert!(!carpeta.protegida && carpeta.aces.iter().all(Ace::heredada));
        assert_eq!(carpeta.aces[1].sid, SID_SYSTEM);
        assert_eq!(carpeta.aces[2].sid, SID_ADMINISTRADORES);
    }
}
