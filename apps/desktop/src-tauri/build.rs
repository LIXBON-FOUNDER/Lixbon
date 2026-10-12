/// Genera `store_migrations.rs` con las migraciones de `src/store/migrations/`
/// (`NNN_nombre.sql`), para que añadir una sea soltar un archivo, sin tocar el
/// framework ni una lista compartida entre slices.
fn embed_store_migrations() {
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let dir = manifest.join("src").join("store").join("migrations");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut found: Vec<(i64, String, std::path::PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("leer src/store/migrations") {
        let path = entry.expect("entrada de migrations").path();
        if path.extension().and_then(|e| e.to_str()) != Some("sql") {
            continue;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).expect("nombre de migración").to_string();
        let (num, name) = stem.split_once('_').unwrap_or_else(|| panic!("migración «{stem}»: el nombre debe ser NNN_nombre.sql"));
        let version: i64 = num.parse().unwrap_or_else(|_| panic!("migración «{stem}»: «{num}» no es un número"));
        assert!(version > 0, "migración «{stem}»: la versión debe ser > 0");
        assert!(!name.is_empty(), "migración «{stem}»: falta el nombre tras el número");
        found.push((version, name.to_string(), path));
    }
    found.sort_by_key(|f| f.0);
    for w in found.windows(2) {
        assert!(w[0].0 != w[1].0, "versión de migración duplicada: {}", w[0].0);
    }
    let mut out = String::from("pub(crate) static EMBEDDED_MIGRATIONS: &[(i64, &str, &str)] = &[
");
    for (v, n, p) in &found {
        out.push_str(&format!("    ({v}, {n:?}, include_str!({:?})),
", p.display().to_string()));
    }
    out.push_str("];
");
    let dest = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("store_migrations.rs");
    std::fs::write(dest, out).expect("escribir store_migrations.rs");
}

fn main() {
    embed_store_migrations();
    // En Windows el manifiesto (Common Controls v6) no lo pone tauri-build como
    // recurso, sino el enlazador en todo ejecutable del paquete: así lo llevan
    // la app y también los binarios de `cargo test`, que con el feature `test`
    // de tauri morían con STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139).
    let msvc = std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let mut windows = tauri_build::WindowsAttributes::new();
    if msvc {
        windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("tauri-build");
}
