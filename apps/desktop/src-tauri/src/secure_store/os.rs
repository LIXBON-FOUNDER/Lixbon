//! Adaptador del almacén del sistema operativo, sobre el crate `keyring`:
//! Windows Credential Manager, macOS Keychain y Linux Secret Service.
//!
//! El valor se guarda SIEMPRE como bytes UTF-8 (`set_secret`/`get_secret`),
//! igual en los tres SO. No se usa `set_password` porque en Windows convierte
//! a UTF-16 y el tope de 2560 bytes del Credential Manager quedaría en 1280
//! unidades, distinto del de macOS y Linux.

use zeroize::Zeroizing;

use super::error::{brief, SecretError};
use super::key::SecretKey;
use super::store::SecretStore;
use super::value::{SecretValue, MAX_SECRET_BYTES};

/// Almacén real del SO. No guarda estado: cada operación abre su entrada.
#[derive(Debug, Default, Clone, Copy)]
pub struct OsStore;

impl OsStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(key: &SecretKey) -> Result<keyring::Entry, SecretError> {
        #[cfg(windows)]
        let entry = {
            // En Windows el TargetName es el único identificador: fijarlo a
            // `servicio:cuenta` evita el `cuenta.servicio` por defecto del crate.
            keyring::Entry::new_with_target(&key.to_string(), key.service(), key.account())
        };
        #[cfg(not(windows))]
        let entry = keyring::Entry::new(key.service(), key.account());
        entry.map_err(|e| map_error(e, key))
    }
}

impl SecretStore for OsStore {
    fn set(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretError> {
        Self::entry(key)?.set_secret(value.expose().as_bytes()).map_err(|e| map_error(e, key))
    }

    fn get(&self, key: &SecretKey) -> Result<SecretValue, SecretError> {
        let bytes = Zeroizing::new(Self::entry(key)?.get_secret().map_err(|e| map_error(e, key))?);
        SecretValue::from_stored(&bytes)
    }

    fn delete(&self, key: &SecretKey) -> Result<(), SecretError> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_error(e, key)),
        }
    }

    fn backend(&self) -> &'static str {
        if cfg!(windows) {
            "windows-credential-manager"
        } else if cfg!(target_os = "macos") {
            "macos-keychain"
        } else {
            "linux-secret-service"
        }
    }
}

/// Traduce el error de `keyring` sin arrastrar `BadEncoding(bytes)` ni
/// `Ambiguous(..)`, que podrían contener el valor guardado.
pub(crate) fn map_error(e: keyring::Error, key: &SecretKey) -> SecretError {
    use keyring::Error as E;
    match e {
        E::NoEntry => SecretError::NotFound(key.clone()),
        E::NoStorageAccess(m) => SecretError::Denied(brief(m)),
        E::PlatformFailure(m) => {
            // En Linux casi todo fallo de plataforma es "no hay Secret Service
            // o no hay sesión de D-Bus"; en Windows/macOS es un fallo genérico.
            if cfg!(target_os = "linux") {
                SecretError::Unavailable(brief(m))
            } else {
                SecretError::Other(brief(m))
            }
        }
        E::BadEncoding(_) => SecretError::Corrupt("el valor guardado no es UTF-8".to_string()),
        E::TooLong(_, _) => SecretError::TooLarge { max: MAX_SECRET_BYTES },
        E::Invalid(attr, why) => SecretError::InvalidKey(format!("{}: {}", brief(attr), brief(why))),
        E::Ambiguous(_) => SecretError::Other("hay varias credenciales para la misma clave".to_string()),
        // `keyring::Error` es no exhaustivo.
        other => SecretError::Other(brief(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secure_store::error::ErrorKind;

    fn key() -> SecretKey {
        SecretKey::new("lixbon-test-os", "k").unwrap()
    }

    #[test]
    fn el_mapeo_de_errores_no_filtra_bytes() {
        let k = key();
        let e = map_error(keyring::Error::BadEncoding(b"TOP-SECRET-123".to_vec()), &k);
        assert_eq!(e.kind(), ErrorKind::Corrupt);
        assert!(!format!("{e} {e:?}").contains("TOP-SECRET"));

        let e = map_error(keyring::Error::NoEntry, &k);
        assert!(e.is_not_found());

        let e = map_error(keyring::Error::TooLong("password".into(), 2560), &k);
        assert_eq!(e.kind(), ErrorKind::TooLarge);

        let e = map_error(keyring::Error::NoStorageAccess("bloqueado".into()), &k);
        assert_eq!(e.kind(), ErrorKind::Denied);

        let e = map_error(keyring::Error::Ambiguous(Vec::new()), &k);
        assert_eq!(e.kind(), ErrorKind::Other);
    }

    #[test]
    fn el_mapeo_de_fallos_de_plataforma_recorta_mensajes_largos() {
        let largo = "x".repeat(5000);
        let e = map_error(keyring::Error::PlatformFailure(largo.into()), &key());
        assert!(e.to_string().chars().count() < 400);
    }
}

/// Pruebas contra el almacén REAL del SO. Van con `#[ignore]` (un CI sin
/// sesión gráfica no tiene Secret Service) y usan un servicio `lixbon-test-…`
/// único por ejecución, que borran al terminar. Se lanzan con:
/// `cargo test secure_store::os -- --ignored`
#[cfg(test)]
mod real_tests {
    use super::*;
    use crate::secure_store::error::ErrorKind;
    use crate::secure_store::key::TEST_SERVICE_PREFIX;

    /// Borra las claves de la prueba al salir, aunque el test falle.
    struct Cleanup(OsStore, Vec<SecretKey>);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for k in &self.1 {
                let _ = self.0.delete(k);
            }
        }
    }

    fn unique_service() -> String {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{TEST_SERVICE_PREFIX}{}-{nanos}-{n}", std::process::id())
    }

    #[test]
    #[ignore = "usa el almacén real del sistema"]
    fn ciclo_completo_en_el_almacen_real() {
        let svc = unique_service();
        let store = OsStore::new();
        let simple = SecretKey::new(&svc, "interop/roundtrip").unwrap();
        let unicode = SecretKey::new(&svc, "interop/unicode").unwrap();
        let max_ascii = SecretKey::new(&svc, "interop/max-ascii").unwrap();
        let max_multi = SecretKey::new(&svc, "interop/max-multibyte").unwrap();
        let multiline = SecretKey::new(&svc, "interop/multiline").unwrap();
        let _cleanup = Cleanup(
            store,
            vec![simple.clone(), unicode.clone(), max_ascii.clone(), max_multi.clone(), multiline.clone()],
        );

        // No existe todavía.
        assert!(store.get(&simple).unwrap_err().is_not_found());
        assert!(!store.exists(&simple).unwrap());

        // Guardar, leer, reemplazar.
        store.set(&simple, &SecretValue::new("uno").unwrap()).unwrap();
        assert_eq!(store.get(&simple).unwrap().expose(), "uno");
        store.set(&simple, &SecretValue::new("dos").unwrap()).unwrap();
        assert_eq!(store.get(&simple).unwrap().expose(), "dos");

        // Unicode, multilínea y los dos máximos (ASCII y multibyte).
        let casos = [
            (&unicode, "ñandú 日本語 ✓ 🔐".to_string()),
            (&multiline, "línea 1\nlínea 2\r\n  con espacios  ".to_string()),
            (&max_ascii, "k".repeat(MAX_SECRET_BYTES)),
            (&max_multi, "é".repeat(MAX_SECRET_BYTES / 2)),
        ];
        for (k, v) in &casos {
            store.set(k, &SecretValue::new(v.clone()).unwrap()).unwrap();
            assert_eq!(store.get(k).unwrap().expose(), v, "{k}");
        }

        // Borrar es idempotente.
        store.delete(&simple).unwrap();
        store.delete(&simple).unwrap();
        assert!(store.get(&simple).unwrap_err().is_not_found());
    }

    #[test]
    #[ignore = "usa el almacén real del sistema"]
    fn los_servicios_no_se_mezclan_en_el_almacen_real() {
        let a = SecretKey::new(&unique_service(), "x").unwrap();
        let b = SecretKey::new(&unique_service(), "x").unwrap();
        let store = OsStore::new();
        let _cleanup = Cleanup(store, vec![a.clone(), b.clone()]);
        store.set(&a, &SecretValue::new("A").unwrap()).unwrap();
        assert_eq!(store.get(&b).unwrap_err().kind(), ErrorKind::NotFound);
    }
}
