//! Valor de un secreto: texto UTF-8 que no se imprime y se borra al soltarlo.

use std::fmt;

use zeroize::Zeroizing;

use super::error::SecretError;

/// Máximo en bytes UTF-8. Es el tope de Windows Credential Manager
/// (`CRED_MAX_CREDENTIAL_BLOB_SIZE`), el almacén más estricto de los tres: se
/// aplica igual en todos para que un secreto guardado en un SO quepa en otro.
pub const MAX_SECRET_BYTES: usize = 2560;

#[derive(Clone)]
pub struct SecretValue(Zeroizing<String>);

impl SecretValue {
    /// Valida el valor: no vacío, sin NUL y como mucho `MAX_SECRET_BYTES`.
    pub fn new(value: impl Into<String>) -> Result<Self, SecretError> {
        let v: Zeroizing<String> = Zeroizing::new(value.into());
        if v.is_empty() {
            return Err(SecretError::InvalidValue("vacío".to_string()));
        }
        if v.contains('\0') {
            return Err(SecretError::InvalidValue("contiene un carácter NUL".to_string()));
        }
        if v.len() > MAX_SECRET_BYTES {
            return Err(SecretError::TooLarge { max: MAX_SECRET_BYTES });
        }
        Ok(Self(v))
    }

    /// Reconstruye el valor desde los bytes que devolvió el almacén. Lo
    /// guardado que no sea UTF-8 válido, esté vacío o supere el máximo es
    /// `Corrupt`: no lo escribió este módulo.
    pub(crate) fn from_stored(bytes: &[u8]) -> Result<Self, SecretError> {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| SecretError::Corrupt("el valor guardado no es UTF-8".to_string()))?;
        Self::new(text).map_err(|e| SecretError::Corrupt(format!("el valor guardado no es válido ({:?})", e.kind())))
    }

    /// Único punto de acceso al texto. El nombre es a propósito incómodo:
    /// quien lo llama decide que el secreto salga de este tipo.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Nunca imprime el contenido ni su longitud.
impl fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretValue(<redactado>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::error::ErrorKind;
    use crate::secure_store::vectors;

    #[test]
    fn valores_invalidos_de_los_vectores() {
        for c in vectors()["invalid_secrets"].as_array().unwrap() {
            let e = SecretValue::new(c["secret"].as_str().unwrap()).unwrap_err();
            assert_eq!(e.kind(), ErrorKind::InvalidValue, "{}", c["why"]);
        }
    }

    #[test]
    fn el_maximo_es_en_bytes_utf8() {
        let v = vectors();
        assert_eq!(v["max_secret_bytes"].as_u64().unwrap() as usize, MAX_SECRET_BYTES);
        assert!(SecretValue::new("k".repeat(MAX_SECRET_BYTES)).is_ok());
        assert!(SecretValue::new("é".repeat(MAX_SECRET_BYTES / 2)).is_ok());
        assert_eq!(SecretValue::new("k".repeat(MAX_SECRET_BYTES + 1)).unwrap_err().kind(), ErrorKind::TooLarge);
        // 1281 caracteres de 2 bytes = 2562 bytes.
        assert_eq!(SecretValue::new("é".repeat(MAX_SECRET_BYTES / 2 + 1)).unwrap_err().kind(), ErrorKind::TooLarge);
    }

    #[test]
    fn debug_no_muestra_valor_ni_longitud() {
        let v = SecretValue::new("TOP-SECRET-123456").unwrap();
        let d = format!("{v:?}");
        assert!(!d.contains("TOP-SECRET"));
        assert!(!d.contains("17"));
        assert!(format!("{:?}", Some(&v)).contains("redactado"));
        assert_eq!(v.expose(), "TOP-SECRET-123456");
    }

    #[test]
    fn lo_guardado_ilegible_es_corrupt_sin_filtrar() {
        let e = SecretValue::from_stored(&[0x66, 0xff, 0xfe]).unwrap_err();
        assert_eq!(e.kind(), ErrorKind::Corrupt);
        assert_eq!(SecretValue::from_stored(b"").unwrap_err().kind(), ErrorKind::Corrupt);
        assert_eq!(SecretValue::from_stored(b"a\0b").unwrap_err().kind(), ErrorKind::Corrupt);
        assert_eq!(SecretValue::from_stored("ñ".as_bytes()).unwrap().expose(), "ñ");
    }
}
