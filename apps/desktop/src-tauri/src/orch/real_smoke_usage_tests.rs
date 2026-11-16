//! Validación manual del uso persistido con la CLI REAL de Codex (LXO-249; la de Claude vive en `usage_persist_tests.rs`). `#[ignore]`: lanza el
//! proveedor de verdad y usa la cuenta de la persona.
//!
//! ```text
//! cargo test --lib real_smoke_usage -- --ignored --nocapture --test-threads=1
//! ```

use serde_json::json;

use super::real_smoke_tests::{codex, TERMINAL};

/// USO con Codex real (LXO-249): tokens declarados y consultables; Codex no declara coste, así que `cost_usd` es `null` (ausencia, no cero).
#[test]
#[ignore = "validación manual: lanza la CLI real de Codex y usa la cuenta del usuario"]
fn real_codex_deja_su_uso_consultable_tras_terminar() {
    let r = codex("explorar", "Responde solo la palabra OK.");
    let last = r.wait("el Attempt termina", 240, &|s| TERMINAL.contains(&s));
    assert_eq!(last, "done");
    let u = r.desktop("attempt_detail", json!({"attempt_id": r.attempt})).expect("detalle")["attempt"]["usage"].clone();
    println!("usage: {u}");
    assert!(u.is_object(), "Codex real debe dejar su uso consultable: {u}");
    assert!(u["output_tokens"].as_i64().is_some_and(|n| n > 0), "Codex declara tokens de salida: {u}");
    assert!(u["cost_usd"].is_null(), "Codex no declara coste: ausencia, no cero: {u}");
    assert_eq!(u["source"], "provider_declared");
    assert_eq!(u["provider"], "codex");
}
