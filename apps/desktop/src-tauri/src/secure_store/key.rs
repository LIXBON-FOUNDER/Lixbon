//! Identificador de un secreto: (servicio, cuenta).
//!
//! Las reglas están fijadas en `docs/secure-store/vectors.json` (vectores
//! dorados) para que un futuro cliente en otro lenguaje, p. ej. el CLI en Go,
//! las replique sin ambigüedad:
//!
//! * servicio: `[a-z0-9][a-z0-9._-]{0,63}`; `lixbon` en producción y
//!   `lixbon-test-…` en pruebas.
//! * cuenta: 1 a 128 caracteres; segmentos separados por `/`, cada uno
//!   `[A-Za-z0-9][A-Za-z0-9._@+-]*`.
//!
//! Solo ASCII y sin `:` en ninguno de los dos: así el `TargetName` de
//! Windows (`servicio:cuenta`) no es ambiguo y no depende de la codificación.

use std::fmt;

use super::error::SecretError;

/// Servicio de producción de los secretos de Lixbon.
pub const DEFAULT_SERVICE: &str = "lixbon";
/// Prefijo OBLIGATORIO del servicio en toda prueba contra un almacén real.
pub const TEST_SERVICE_PREFIX: &str = "lixbon-test-";
pub const MAX_SERVICE_LEN: usize = 64;
pub const MAX_ACCOUNT_LEN: usize = 128;

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct SecretKey {
    service: String,
    account: String,
}

impl SecretKey {
    /// Valida y construye la clave. Ningún nombre inválido llega a un almacén.
    pub fn new(service: &str, account: &str) -> Result<Self, SecretError> {
        validate_service(service).map_err(|w| SecretError::InvalidKey(format!("servicio: {w}")))?;
        validate_account(account).map_err(|w| SecretError::InvalidKey(format!("cuenta: {w}")))?;
        Ok(Self { service: service.to_string(), account: account.to_string() })
    }

    /// Clave en el servicio de producción (`lixbon`).
    pub fn lixbon(account: &str) -> Result<Self, SecretError> {
        Self::new(DEFAULT_SERVICE, account)
    }

    /// Lee una referencia `servicio:cuenta` (la forma en que `config.json`
    /// apuntará a un secreto sin contenerlo). El servicio no admite `:`, así
    /// que el primer `:` separa sin ambigüedad.
    pub fn parse(reference: &str) -> Result<Self, SecretError> {
        match reference.split_once(':') {
            Some((service, account)) => Self::new(service, account),
            None => Err(SecretError::InvalidKey("falta ':' entre servicio y cuenta".to_string())),
        }
    }

    pub fn service(&self) -> &str {
        &self.service
    }

    pub fn account(&self) -> &str {
        &self.account
    }
}

/// `servicio:cuenta` (los nombres no son secretos; el valor jamás se muestra).
impl fmt::Display for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.service, self.account)
    }
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SecretKey({self})")
    }
}

pub(crate) fn validate_service(s: &str) -> Result<(), &'static str> {
    if s.is_empty() {
        return Err("vacío");
    }
    if s.len() > MAX_SERVICE_LEN {
        return Err("demasiado largo (máximo 64)");
    }
    let mut chars = s.chars();
    let first = chars.next().unwrap_or(' ');
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return Err("debe empezar por minúscula o dígito ASCII");
    }
    if !s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-')) {
        return Err("solo minúsculas ASCII, dígitos, '.', '_' y '-'");
    }
    Ok(())
}

pub(crate) fn validate_account(a: &str) -> Result<(), &'static str> {
    if a.is_empty() {
        return Err("vacía");
    }
    if a.len() > MAX_ACCOUNT_LEN {
        return Err("demasiado larga (máximo 128)");
    }
    for seg in a.split('/') {
        let mut chars = seg.chars();
        let Some(first) = chars.next() else {
            return Err("segmento vacío (barra al inicio, al final o doble)");
        };
        if !first.is_ascii_alphanumeric() {
            return Err("cada segmento debe empezar por letra o dígito ASCII");
        }
        if !seg.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '+' | '-')) {
            return Err("solo letras y dígitos ASCII, '.', '_', '@', '+', '-' y '/' entre segmentos");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::error::ErrorKind;
    use crate::secure_store::vectors;

    #[test]
    fn claves_validas_de_los_vectores() {
        let v = vectors();
        assert_eq!(v["default_service"].as_str().unwrap(), DEFAULT_SERVICE);
        assert_eq!(v["test_service_prefix"].as_str().unwrap(), TEST_SERVICE_PREFIX);
        for c in v["valid_keys"].as_array().unwrap() {
            let (s, a) = (c["service"].as_str().unwrap(), c["account"].as_str().unwrap());
            let k = SecretKey::new(s, a).unwrap_or_else(|e| panic!("{s}:{a} debía ser válida: {e}"));
            assert_eq!(k.to_string(), format!("{s}:{a}"));
            assert_eq!(SecretKey::parse(&k.to_string()).unwrap(), k);
        }
    }

    #[test]
    fn servicios_invalidos_de_los_vectores() {
        for c in vectors()["invalid_services"].as_array().unwrap() {
            let s = c["service"].as_str().unwrap();
            let e = SecretKey::new(s, "cuenta").unwrap_err();
            assert_eq!(e.kind(), ErrorKind::InvalidKey, "servicio {s:?}: {}", c["why"]);
        }
    }

    #[test]
    fn cuentas_invalidas_de_los_vectores() {
        for c in vectors()["invalid_accounts"].as_array().unwrap() {
            let a = c["account"].as_str().unwrap();
            let e = SecretKey::new("lixbon", a).unwrap_err();
            assert_eq!(e.kind(), ErrorKind::InvalidKey, "cuenta {a:?}: {}", c["why"]);
        }
    }

    #[test]
    fn longitud_maxima_de_la_cuenta() {
        let v = vectors();
        let ok = v["account_max_ok"]["len"].as_u64().unwrap() as usize;
        let largo = v["account_too_long"]["len"].as_u64().unwrap() as usize;
        assert_eq!(ok, MAX_ACCOUNT_LEN);
        assert!(SecretKey::new("lixbon", &"a".repeat(ok)).is_ok());
        assert!(SecretKey::new("lixbon", &"a".repeat(largo)).is_err());
    }

    #[test]
    fn referencias_mal_formadas() {
        for r in ["", "lixbon", ":cuenta", "lixbon:", "lixbon:a:b", "LIXBON:a"] {
            assert_eq!(SecretKey::parse(r).unwrap_err().kind(), ErrorKind::InvalidKey, "{r:?}");
        }
        let k = SecretKey::parse("lixbon:provider/openai/api-key").unwrap();
        assert_eq!((k.service(), k.account()), ("lixbon", "provider/openai/api-key"));
        assert_eq!(SecretKey::lixbon("a").unwrap().service(), DEFAULT_SERVICE);
    }

    #[test]
    fn el_target_de_windows_es_servicio_dos_puntos_cuenta() {
        for c in vectors()["windows_target"].as_array().unwrap() {
            let k = SecretKey::new(c["service"].as_str().unwrap(), c["account"].as_str().unwrap()).unwrap();
            assert_eq!(k.to_string(), c["target"].as_str().unwrap());
        }
    }
}
