//! Errores tipados del almacén seguro. Ningún mensaje contiene el valor del
//! secreto: solo el nombre (servicio:cuenta) y un texto breve del motivo.

use std::fmt;

use super::key::SecretKey;

/// Clasificación estable para quien decide qué hacer (reintentar, pedir
/// desbloqueo, caer a otro mecanismo…).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    /// No existe un secreto con esa clave.
    NotFound,
    /// El almacén del sistema no está (sin Secret Service, sin sesión, sin soporte).
    Unavailable,
    /// El almacén existe pero se negó: bloqueado, permiso o aviso rechazado.
    Denied,
    /// El valor supera el máximo (2560 bytes).
    TooLarge,
    /// Servicio o cuenta con un formato no permitido.
    InvalidKey,
    /// Valor vacío o con NUL.
    InvalidValue,
    /// Lo guardado no se puede interpretar (no es UTF-8, base64 roto…).
    Corrupt,
    /// Fallo del almacén que no encaja en lo anterior.
    Other,
}

#[derive(Debug, Clone)]
pub enum SecretError {
    NotFound(SecretKey),
    Unavailable(String),
    Denied(String),
    TooLarge { max: usize },
    InvalidKey(String),
    InvalidValue(String),
    Corrupt(String),
    Other(String),
}

impl SecretError {
    pub fn kind(&self) -> ErrorKind {
        match self {
            SecretError::NotFound(_) => ErrorKind::NotFound,
            SecretError::Unavailable(_) => ErrorKind::Unavailable,
            SecretError::Denied(_) => ErrorKind::Denied,
            SecretError::TooLarge { .. } => ErrorKind::TooLarge,
            SecretError::InvalidKey(_) => ErrorKind::InvalidKey,
            SecretError::InvalidValue(_) => ErrorKind::InvalidValue,
            SecretError::Corrupt(_) => ErrorKind::Corrupt,
            SecretError::Other(_) => ErrorKind::Other,
        }
    }

    pub fn is_not_found(&self) -> bool {
        self.kind() == ErrorKind::NotFound
    }
}

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecretError::NotFound(k) => write!(f, "secreto no encontrado ({k})"),
            SecretError::Unavailable(m) => write!(f, "almacén de secretos no disponible: {m}"),
            SecretError::Denied(m) => write!(f, "acceso denegado al almacén de secretos: {m}"),
            SecretError::TooLarge { max } => write!(f, "secreto demasiado grande (máximo {max} bytes)"),
            SecretError::InvalidKey(m) => write!(f, "nombre de secreto no válido: {m}"),
            SecretError::InvalidValue(m) => write!(f, "valor de secreto no válido: {m}"),
            SecretError::Corrupt(m) => write!(f, "secreto guardado ilegible: {m}"),
            SecretError::Other(m) => write!(f, "fallo del almacén de secretos: {m}"),
        }
    }
}

impl std::error::Error for SecretError {}

/// Recorta el texto que viene de una biblioteca del sistema para no arrastrar
/// mensajes enormes a los registros.
pub(crate) fn brief(msg: impl fmt::Display) -> String {
    let s = msg.to_string();
    if s.chars().count() <= 200 {
        s
    } else {
        let cut: String = s.chars().take(200).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::{MemoryStore, SecretStore, SecretValue};

    const SECRET: &str = "TOP-SECRET-123456";

    #[test]
    fn ningun_error_ni_su_debug_contiene_el_secreto() {
        let key = SecretKey::new("lixbon-test-err", "cuenta").unwrap();
        let value = SecretValue::new(SECRET).unwrap();
        let store = MemoryStore::new();
        store.set(&key, &value).unwrap();

        let mut errores = vec![
            store.get(&SecretKey::new("lixbon-test-err", "otra").unwrap()).unwrap_err(),
            SecretValue::new("").unwrap_err(),
            SecretValue::new("x".repeat(3000)).unwrap_err(),
            SecretKey::new("MAL", "a").unwrap_err(),
            SecretValue::from_stored(&[0xff]).unwrap_err(),
        ];
        for kind in [ErrorKind::Unavailable, ErrorKind::Denied, ErrorKind::Corrupt, ErrorKind::Other] {
            store.fail_with(Some(kind));
            errores.push(store.get(&key).unwrap_err());
            errores.push(store.set(&key, &value).unwrap_err());
        }
        assert!(errores.len() >= 13);
        for e in &errores {
            let txt = format!("{e} | {e:?}");
            assert!(!txt.contains(SECRET), "{txt}");
        }
    }

    #[test]
    fn la_clasificacion_es_estable() {
        let k = SecretKey::lixbon("a").unwrap();
        assert_eq!(SecretError::NotFound(k).kind(), ErrorKind::NotFound);
        assert_eq!(SecretError::TooLarge { max: 1 }.kind(), ErrorKind::TooLarge);
        assert!(SecretError::Denied("x".into()).to_string().contains("denegado"));
    }

    #[test]
    fn brief_recorta_mensajes_largos() {
        assert_eq!(brief("corto"), "corto");
        let r = brief("x".repeat(500));
        assert_eq!(r.chars().count(), 201);
        assert!(r.ends_with('…'));
    }
}
