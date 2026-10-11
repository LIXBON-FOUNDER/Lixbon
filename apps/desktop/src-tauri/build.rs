fn main() {
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
