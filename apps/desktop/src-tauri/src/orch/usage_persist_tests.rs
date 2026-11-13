//! LXO-249 · El uso que el proveedor declara durante un Attempt queda como hecho durable (`attempt.usage_reported`, uno por turno) y se
//! consulta sumado en `attempt_detail.usage`. Lo no declarado es `null`, nunca cero. Cada prueba entra por `rpc_via(Ui, User)` (el camino
//! de Desktop) con un adapter falso; la de Claude real es manual (`#[ignore]`).

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::attempt_e2e_tests::{world, World};
use super::dispatch_tests::event_count;
use super::event_kinds::ReportedUsage;
use super::initial_approval_tests::e2e::restart_fixture_core;

fn usage(input: Option<u64>, output: Option<u64>, cache_read: Option<u64>, cache_creation: Option<u64>, cost_usd: Option<f64>) -> Step {
    Step::Usage { input, output, cache_read, cache_creation, cost_usd }
}

/// Un Attempt de Claude falso que termina bien tras ejecutar `script`.
fn done_with(script: Vec<Step>) -> (World, String) {
    let mut steps = vec![Step::Bind("sess-usage")];
    steps.extend(script);
    steps.push(Step::Complete(Some("hecho".into())));
    let w = world("claude", Some(steps));
    let attempt = w.create("claude", "e2e-usage");
    w.approve(&attempt);
    w.settled(&attempt, "done");
    (w, attempt)
}

fn detail(w: &World, attempt: &str) -> Value {
    w.desktop("attempt_detail", json!({"attempt_id": attempt})).expect("attempt_detail")["attempt"].clone()
}

/// Los payloads de los Events `attempt.usage_reported` del Attempt, en orden.
fn reported(w: &World, attempt: &str) -> Vec<Value> {
    let rows: Vec<String> = w
        .core
        .storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT payload FROM events WHERE kind = 'attempt.usage_reported' AND entity_id = ?1 ORDER BY seq")?;
                let rows = stmt.query_map([attempt], |r| r.get::<_, String>(0))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
        })
        .unwrap()
        .unwrap();
    rows.iter().map(|p| serde_json::from_str(p).unwrap()).collect()
}

/// Dos turnos que informan uso: dos hechos, y `attempt_detail.usage` los suma. Lo que un turno no declaró no aparece en su hecho, y lo que
/// NINGÚN turno declaró (`cache_creation_tokens`) es `null` en la suma, no cero. La procedencia es la del Attempt.
#[test]
fn el_uso_declarado_deja_un_hecho_por_turno_y_se_consulta_sumado() {
    let (w, a1) = done_with(vec![usage(Some(1200), Some(340), Some(2048), None, Some(0.0123)), usage(Some(300), Some(60), None, None, None)]);

    assert_eq!(event_count(&w.core, &a1, "attempt.usage_reported"), 2);
    let hechos = reported(&w, &a1);
    assert_eq!(hechos[0], json!({"task": hechos[0]["task"], "n": 1, "provider": "claude", "input_tokens": 1200, "output_tokens": 340, "cache_read_tokens": 2048, "cost_usd": 0.0123}));
    assert!(hechos[1].get("cache_read_tokens").is_none() && hechos[1].get("cost_usd").is_none(), "lo no declarado no viaja: {}", hechos[1]);

    let u = &detail(&w, &a1)["usage"];
    assert_eq!(
        *u,
        json!({"turns": 2, "provider": "claude", "source": "provider_declared", "input_tokens": 1500, "output_tokens": 400, "cache_read_tokens": 2048, "cache_creation_tokens": null, "cost_usd": 0.0123})
    );
}

/// Un proveedor que no declara uso (o declara un turno vacío): ausencia explícita, no ceros, y ningún hecho.
#[test]
fn sin_uso_declarado_la_ausencia_es_explicita_y_no_hay_hecho() {
    let (w, a1) = done_with(vec![]);
    assert_eq!(detail(&w, &a1)["usage"], Value::Null);
    assert_eq!(event_count(&w.core, &a1, "attempt.usage_reported"), 0);

    let (w, a2) = done_with(vec![usage(None, None, None, None, None)]);
    assert_eq!(detail(&w, &a2)["usage"], Value::Null, "un turno con todo sin declarar no es «cero»");
    assert_eq!(event_count(&w.core, &a2, "attempt.usage_reported"), 0);
}

/// Un solo campo declarado: los demás son `null` en la consulta, no `0`.
#[test]
fn un_campo_no_declarado_es_null_y_no_cero() {
    let (w, a1) = done_with(vec![usage(None, Some(5), None, None, None)]);
    let u = &detail(&w, &a1)["usage"];
    assert_eq!(u["output_tokens"], 5);
    for campo in ["input_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd"] {
        assert_eq!(u[campo], Value::Null, "{campo} no se declaró: es null, no cero");
    }
    assert_eq!(u["turns"], 1);
}

/// El uso es un hecho durable: sobrevive a reiniciar el Core.
#[test]
fn el_uso_sobrevive_a_un_reinicio_del_core() {
    let (w, a1) = done_with(vec![usage(Some(10), Some(20), None, None, Some(0.5))]);
    let antes = detail(&w, &a1)["usage"].clone();
    assert_eq!(antes["input_tokens"], 10);

    let World { core, adapter, project: _ } = w;
    drop(adapter);
    let core = restart_fixture_core(core);
    let despues = core
        .rpc_via(super::events::Channel::Ui, super::Caller::User, "", "attempt_detail", &json!({"attempt_id": a1}))
        .expect("attempt_detail tras reiniciar")["attempt"]["usage"]
        .clone();
    assert_eq!(despues, antes, "el uso es el mismo tras el reinicio");
}

/// Lo que el adapter informe mal no se corrige ni se inventa: se descarta (desconocido).
#[test]
fn un_coste_o_un_contador_imposibles_se_descartan_y_no_se_corrigen() {
    let u = ReportedUsage::declared(Some(u64::MAX), Some(7), None, None, Some(f64::NAN));
    assert_eq!((u.input_tokens, u.output_tokens, u.cost_usd), (None, Some(7), None), "no cabe en un entero exacto de JSON / NaN");
    assert_eq!(ReportedUsage::declared(None, None, None, None, Some(-1.0)).cost_usd, None, "un coste negativo no existe");
    assert_eq!(ReportedUsage::declared(None, None, None, None, Some(f64::INFINITY)).cost_usd, None);
    assert!(!ReportedUsage::declared(None, None, None, None, None).any(), "nada declarado: no hay hecho");
    assert_eq!(ReportedUsage::declared(None, None, None, None, Some(0.0)).cost_usd, Some(0.0), "un coste de cero DECLARADO es un dato real");
}

/// `cargo test --lib real_claude_deja_su_uso -- --ignored --nocapture`: la CLI real de Claude (haiku, una línea) y su uso consultable tras
/// terminar. Usa la cuenta del usuario.
#[test]
#[ignore = "validación manual: lanza la CLI real de Claude y usa la cuenta del usuario"]
fn real_claude_deja_su_uso_consultable_tras_terminar() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::adapter::{ClaudeAdapter, ClaudeConfig, ProviderAdapter};
    use super::adapter_launcher::AdapterLauncher;
    use super::adapter_launcher_tests::{registry_of, repo_with_commit};
    use super::dispatch_tests::row;
    use super::events::Channel;
    use super::initial_approval_tests::e2e::core_with_project_at;
    use super::Caller;

    let repo = repo_with_commit();
    let (core, _client, _ctx, project) = core_with_project_at(&repo.to_string_lossy());
    let real = Arc::new(ClaudeAdapter::new(ClaudeConfig::default()));
    assert_eq!(real.probe().environment, super::adapter::Environment::Ready, "claude no está listo en esta máquina");
    core.install_launcher(Arc::new(AdapterLauncher::new(&core, registry_of(real))));
    core.provider_registry.probe_all();
    let desktop = |cmd: &str, args: Value| core.rpc_via(Channel::Ui, Caller::User, "", cmd, &args);

    let created = desktop(
        "task_create",
        json!({"request_id": "smoke-real-usage", "project_id": project, "objective": "smoke LXO-249", "title": "smoke", "spec": "Responde solo la palabra OK.", "attempt": {"provider": "claude", "profile": "explorar", "model": "haiku"}}),
    )
    .expect("task_create");
    let attempt = created["attempt_id"].as_str().unwrap().to_string();
    desktop("attempt_approve", json!({"attempt_id": attempt})).expect("aprobar");

    let end = Instant::now() + Duration::from_secs(180);
    while !matches!(row(&core, &attempt).0.as_str(), "done" | "failed" | "stopped") {
        assert!(Instant::now() < end, "el Attempt no terminó a tiempo (estado {})", row(&core, &attempt).0);
        std::thread::sleep(Duration::from_millis(250));
    }
    assert_eq!(row(&core, &attempt).0, "done");
    let u = desktop("attempt_detail", json!({"attempt_id": attempt})).expect("detalle")["attempt"]["usage"].clone();
    println!("usage: {u}");
    assert!(u.is_object(), "Claude real debe dejar su uso consultable: {u}");
    assert!(u["output_tokens"].as_i64().is_some_and(|n| n > 0), "Claude declara tokens de salida: {u}");
    assert_eq!(u["source"], "provider_declared");
}
