//! Contrato del almacén y la implementación en memoria (para pruebas).

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use super::error::{ErrorKind, SecretError};
use super::key::SecretKey;
use super::value::{SecretValue, MAX_SECRET_BYTES};

/// Interfaz única para guardar, leer y borrar secretos. Los adaptadores por SO
/// (`OsStore`) y el falso (`MemoryStore`) la implementan; el resto de la app
/// solo depende de este trait.
pub trait SecretStore: Send + Sync {
    /// Guarda el secreto; si ya existía lo reemplaza.
    fn set(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretError>;

    /// Lee el secreto. `SecretError::NotFound` si no existe.
    fn get(&self, key: &SecretKey) -> Result<SecretValue, SecretError>;

    /// Borra el secreto. Es idempotente: borrar uno que no existe es `Ok`.
    fn delete(&self, key: &SecretKey) -> Result<(), SecretError>;

    /// Nombre corto del adaptador, para diagnóstico (nunca contiene datos).
    fn backend(&self) -> &'static str;

    /// ¿Existe el secreto? Por defecto lo lee y descarta el valor.
    fn exists(&self, key: &SecretKey) -> Result<bool, SecretError> {
        match self.get(key) {
            Ok(_) => Ok(true),
            Err(e) if e.is_not_found() => Ok(false),
            Err(e) => Err(e),
        }
    }
}

/// Almacén falso en memoria. Para pruebas: no toca el almacén del sistema.
#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    secrets: HashMap<SecretKey, SecretValue>,
    /// Si es `Some`, toda operación falla con ese tipo de error.
    fail_with: Option<ErrorKind>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Hace que toda operación posterior falle con `kind` (o deja de fallar
    /// con `None`). Sirve para probar cómo reacciona el código que usa el
    /// almacén cuando este no está disponible o deniega el acceso.
    pub fn fail_with(&self, kind: Option<ErrorKind>) {
        self.lock().fail_with = kind;
    }

    pub fn len(&self) -> usize {
        self.lock().secrets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // Un pánico en otro hilo no invalida los datos: seguimos.
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }
}

fn injected(kind: ErrorKind, key: &SecretKey) -> SecretError {
    match kind {
        ErrorKind::NotFound => SecretError::NotFound(key.clone()),
        ErrorKind::Unavailable => SecretError::Unavailable("fallo simulado".to_string()),
        ErrorKind::Denied => SecretError::Denied("fallo simulado".to_string()),
        ErrorKind::TooLarge => SecretError::TooLarge { max: MAX_SECRET_BYTES },
        ErrorKind::InvalidKey => SecretError::InvalidKey("fallo simulado".to_string()),
        ErrorKind::InvalidValue => SecretError::InvalidValue("fallo simulado".to_string()),
        ErrorKind::Corrupt => SecretError::Corrupt("fallo simulado".to_string()),
        ErrorKind::Other => SecretError::Other("fallo simulado".to_string()),
    }
}

impl SecretStore for MemoryStore {
    fn set(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretError> {
        let mut g = self.lock();
        if let Some(k) = g.fail_with {
            return Err(injected(k, key));
        }
        g.secrets.insert(key.clone(), value.clone());
        Ok(())
    }

    fn get(&self, key: &SecretKey) -> Result<SecretValue, SecretError> {
        let g = self.lock();
        if let Some(k) = g.fail_with {
            return Err(injected(k, key));
        }
        g.secrets.get(key).cloned().ok_or_else(|| SecretError::NotFound(key.clone()))
    }

    fn delete(&self, key: &SecretKey) -> Result<(), SecretError> {
        let mut g = self.lock();
        if let Some(k) = g.fail_with {
            return Err(injected(k, key));
        }
        g.secrets.remove(key);
        Ok(())
    }

    fn backend(&self) -> &'static str {
        "memoria"
    }
}

/// Solo cuenta entradas: ni claves ni valores.
impl fmt::Debug for MemoryStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "MemoryStore({} secretos)", self.len())
    }
}

/// Adaptador para SO sin almacén soportado: todo falla con `Unavailable`.
#[derive(Debug, Default)]
pub struct UnavailableStore;

impl SecretStore for UnavailableStore {
    fn set(&self, _: &SecretKey, _: &SecretValue) -> Result<(), SecretError> {
        Err(unsupported())
    }
    fn get(&self, _: &SecretKey) -> Result<SecretValue, SecretError> {
        Err(unsupported())
    }
    fn delete(&self, _: &SecretKey) -> Result<(), SecretError> {
        Err(unsupported())
    }
    fn backend(&self) -> &'static str {
        "no disponible"
    }
}

fn unsupported() -> SecretError {
    SecretError::Unavailable("este sistema operativo no tiene un almacén soportado".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(a: &str) -> SecretKey {
        SecretKey::new("lixbon-test-mem", a).unwrap()
    }
    fn val(s: &str) -> SecretValue {
        SecretValue::new(s).unwrap()
    }

    #[test]
    fn guardar_leer_reemplazar_borrar() {
        let s = MemoryStore::new();
        let k = key("device/a");
        assert!(matches!(s.get(&k), Err(SecretError::NotFound(_))));
        assert!(!s.exists(&k).unwrap());

        s.set(&k, &val("uno")).unwrap();
        assert_eq!(s.get(&k).unwrap().expose(), "uno");
        assert!(s.exists(&k).unwrap());

        s.set(&k, &val("dos")).unwrap();
        assert_eq!(s.get(&k).unwrap().expose(), "dos");
        assert_eq!(s.len(), 1);

        s.delete(&k).unwrap();
        assert!(s.get(&k).unwrap_err().is_not_found());
        // Idempotente.
        s.delete(&k).unwrap();
        assert!(s.is_empty());
    }

    #[test]
    fn las_claves_no_se_mezclan() {
        let s = MemoryStore::new();
        s.set(&key("a"), &val("A")).unwrap();
        s.set(&key("b"), &val("B")).unwrap();
        let otro = SecretKey::new("lixbon-test-otro", "a").unwrap();
        assert_eq!(s.get(&key("a")).unwrap().expose(), "A");
        assert_eq!(s.get(&key("b")).unwrap().expose(), "B");
        assert!(s.get(&otro).unwrap_err().is_not_found());
    }

    #[test]
    fn fallos_inyectados() {
        let s = MemoryStore::new();
        let k = key("x");
        s.set(&k, &val("v")).unwrap();
        for kind in [ErrorKind::Unavailable, ErrorKind::Denied, ErrorKind::Other] {
            s.fail_with(Some(kind));
            assert_eq!(s.get(&k).unwrap_err().kind(), kind);
            assert_eq!(s.set(&k, &val("w")).unwrap_err().kind(), kind);
            assert_eq!(s.delete(&k).unwrap_err().kind(), kind);
            assert_eq!(s.exists(&k).unwrap_err().kind(), kind);
        }
        s.fail_with(None);
        assert_eq!(s.get(&k).unwrap().expose(), "v");
    }

    #[test]
    fn debug_no_muestra_valores_ni_claves() {
        let s = MemoryStore::new();
        s.set(&key("cuenta-visible"), &val("TOP-SECRET-123")).unwrap();
        let d = format!("{s:?}");
        assert!(!d.contains("TOP-SECRET-123"));
        assert!(!d.contains("cuenta-visible"));
    }

    #[test]
    fn se_usa_como_objeto_de_trait_entre_hilos() {
        let s: std::sync::Arc<dyn SecretStore> = std::sync::Arc::new(MemoryStore::new());
        let hs: Vec<_> = (0..4)
            .map(|i| {
                let s = s.clone();
                std::thread::spawn(move || {
                    let k = key(&format!("t{i}"));
                    s.set(&k, &val(&format!("v{i}"))).unwrap();
                    assert_eq!(s.get(&k).unwrap().expose(), format!("v{i}"));
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
    }

    #[test]
    fn el_adaptador_no_soportado_falla_con_unavailable() {
        let s = UnavailableStore;
        let k = key("x");
        assert_eq!(s.get(&k).unwrap_err().kind(), ErrorKind::Unavailable);
        assert_eq!(s.set(&k, &val("v")).unwrap_err().kind(), ErrorKind::Unavailable);
        assert_eq!(s.delete(&k).unwrap_err().kind(), ErrorKind::Unavailable);
    }
}
