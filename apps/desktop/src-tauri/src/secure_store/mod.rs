//! Almacén seguro de secretos (slice J1).
//!
//! Interfaz multiplataforma para guardar, leer y borrar secretos (claves de
//! API, tokens, claves de dispositivo) en el almacén del sistema operativo:
//! Windows Credential Manager, macOS Keychain, Linux Secret Service.
//!
//! * [`SecretStore`]: el contrato (`set` / `get` / `delete` / `exists`).
//! * [`OsStore`]: adaptador real por SO (crate `keyring`).
//! * [`MemoryStore`]: falso en memoria con fallos inyectables, para pruebas.
//! * [`SecretKey`] (servicio + cuenta, con referencia `servicio:cuenta`) y
//!   [`SecretValue`] (no se imprime en `Debug`, se borra de memoria al soltarlo).
//! * [`SecretError`]: errores tipados que jamás contienen el valor.
//!
//! Core y el sidecar `lxo` comparten las credenciales CLI Person mediante
//! servicio `lixbon` y cuenta `client/cli/<installation_id>`. Los comandos
//! `secret_*` de `lib.rs` (solo Windows, servicio `com.usuario.app-lixbon`)
//! siguen igual; migrar esas claves API es el slice J2. Contrato y decisiones:
//! `docs/secure-store/README.md`.

#![allow(dead_code)]

mod error;
mod key;
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
mod os;
mod store;
mod value;

#[allow(unused_imports)]
pub use error::{ErrorKind, SecretError};
#[allow(unused_imports)]
pub use key::{SecretKey, DEFAULT_SERVICE, MAX_ACCOUNT_LEN, MAX_SERVICE_LEN, TEST_SERVICE_PREFIX};
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub use os::OsStore;
#[allow(unused_imports)]
pub use store::{MemoryStore, SecretStore, UnavailableStore};
#[allow(unused_imports)]
pub use value::{SecretValue, MAX_SECRET_BYTES};

/// Almacén del SO actual; en un SO sin adaptador, uno que falla con
/// `Unavailable` (la app sigue funcionando, solo sin almacén seguro).
pub fn default_store() -> Box<dyn SecretStore> {
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    {
        Box::new(OsStore::new())
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        Box::new(UnavailableStore)
    }
}

/// Vectores dorados compartidos (`docs/secure-store/vectors.json`).
#[cfg(test)]
pub(crate) fn vectors() -> serde_json::Value {
    serde_json::from_str(include_str!("../../../../../docs/secure-store/vectors.json"))
        .expect("vectors.json es JSON válido")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_api_publica_funciona_de_extremo_a_extremo_con_el_falso() {
        let store: Box<dyn SecretStore> = Box::new(MemoryStore::new());
        let key = SecretKey::parse("lixbon-test-api:provider/openai/api-key").unwrap();
        store.set(&key, &SecretValue::new("sk-ficticio").unwrap()).unwrap();
        assert_eq!(store.get(&key).unwrap().expose(), "sk-ficticio");
        store.delete(&key).unwrap();
        assert!(!store.exists(&key).unwrap());
    }

    #[test]
    fn el_almacen_por_defecto_se_construye_sin_tocar_el_sistema() {
        // Construir no abre ninguna credencial; solo comprobamos el adaptador.
        let s = default_store();
        assert!(!s.backend().is_empty());
    }
}
