//! Validación manual del cierre de procesos con las CLIs REALES (LXO-242): detener un Attempt que tiene un proceso largo en marcha no deja nada vivo.
//! Todas son `#[ignore]`: lanzan el proveedor de verdad y usan la cuenta de la persona.
//!
//! ```text
//! cargo test --lib real_smoke_custody -- --ignored --nocapture --test-threads=1
//! ```

use std::time::{Duration, Instant};

use serde_json::json;

use super::attempt_e2e_tests::kinds;
use super::real_smoke_tests::{claude, codex, Real, TERMINAL};

// ── Cierre de procesos con las CLIs reales (LXO-242: validación manual en este sistema) ───────────────────────────────────

/// Cuántos procesos del sistema llevan `marker` en su línea de comandos. La consulta parte el literal para no contarse a sí misma.
fn marker_processes(marker: &str) -> usize {
    let (a, b) = marker.split_at(5);
    #[cfg(windows)]
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &format!("@(Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like ('*{a}'+'{b}*') }}).Count")])
        .output();
    #[cfg(not(windows))]
    let out = std::process::Command::new("sh").args(["-c", &format!("ps -eo args | grep -c '{a}[{}]{}'", &b[..1], &b[1..])]).output();
    let out = out.expect("lanzar la consulta de procesos");
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or_else(|_| panic!("la consulta de procesos no devolvió un número: {out:?}"))
}

/// Un Attempt real lanza un proceso largo (un nieto de la CLI, a través de la herramienta de shell del proveedor), se DETIENE por el RPC de Desktop y
/// no queda ningún proceso vivo ni nada en la custodia del supervisor.
fn detener_no_deja_procesos(r: &Real, marker: &str) {
    let task = r.attempt.rsplit_once("-a").unwrap().0.to_string();
    let start = Instant::now();
    loop {
        match r.state().as_str() {
            "awaiting_terminal_approval" => {
                let request = r.first_request();
                let id = request["request_id"].as_str().unwrap();
                r.desktop("attempt_answer", json!({"attempt_id": r.attempt, "request_id": id, "answer": "allow", "confirm": true})).expect("permitir el comando largo");
            }
            s if TERMINAL.contains(&s) => panic!("el Attempt terminó ({s}) antes de dejar el proceso en marcha: no se probó nada"),
            _ => {}
        }
        if marker_processes(marker) > 0 {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(150), "el proveedor no llegó a lanzar el proceso largo");
        std::thread::sleep(Duration::from_millis(500));
    }
    println!("[{:>3}s] el proceso largo corre: {} proceso(s) con la marca", start.elapsed().as_secs(), marker_processes(marker));

    let stopped = r.desktop("stop", json!({"task": task})).expect("stop");
    println!("stop: {stopped}");
    let last = r.wait("el Attempt queda detenido", 60, &|s| TERMINAL.contains(&s));
    println!("estado final: {last}; eventos: {:?}", kinds(&r.core, &r.attempt));
    assert_eq!(last, "stopped", "detener no debe acabar como fallo: el cierre se probó");

    let end = Instant::now() + Duration::from_secs(15);
    while marker_processes(marker) > 0 && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(250));
    }
    assert_eq!(marker_processes(marker), 0, "tras detener no debe quedar ningún proceso del árbol del proveedor");
    assert!(!super::adapter::supervisor::in_custody(&r.attempt), "y nada en la custodia del supervisor: el cierre quedó probado");
}

#[test]
#[ignore = "validación manual: lanza la CLI real de Claude y usa la cuenta del usuario"]
fn real_claude_detener_un_attempt_no_deja_procesos_vivos() {
    let marker = format!("LXOSMOKEMARK{}", std::process::id());
    let r = claude(
        "delegar_con_revision",
        &format!("Usa la herramienta Bash para ejecutar exactamente este comando, sin segundo plano y sin timeout propio: node -e \"setTimeout(function(){{}},600000)\" {marker}"),
    );
    detener_no_deja_procesos(&r, &marker);
}

#[test]
#[ignore = "validación manual: lanza la CLI real de Codex y usa la cuenta del usuario"]
fn real_codex_detener_un_attempt_no_deja_procesos_vivos() {
    let marker = format!("LXOSMOKEMARK{}", std::process::id());
    let r = codex(
        "delegar_con_revision",
        &format!("Ejecuta en la terminal exactamente este comando y espera a que termine, sin segundo plano: node -e \"setTimeout(function(){{}},600000)\" {marker}"),
    );
    detener_no_deja_procesos(&r, &marker);
}
