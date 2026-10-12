//! Puntos de caída para el arnés de pruebas de C2b.
//!
//! En una compilación normal [`crash_point`] no hace nada. En las pruebas, si la
//! variable `LIXBON_CRASH_AT` coincide con el nombre del punto, el proceso muere
//! con `abort()` (sin destructores, como un `kill -9`). El arnés relanza el
//! binario de pruebas como subproceso con esa variable y comprueba, desde el
//! proceso padre, qué queda en disco.
//!
//! Prueba **caída de proceso**, no pérdida de energía.

#[cfg(test)]
pub fn crash_point(name: &str) {
    if std::env::var("LIXBON_CRASH_AT").as_deref() == Ok(name) {
        eprintln!("[crash] abortando en «{name}»");
        std::process::abort();
    }
}

#[cfg(not(test))]
#[inline(always)]
pub fn crash_point(_name: &str) {}
