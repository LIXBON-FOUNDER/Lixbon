//! LXO-249 · El uso que el proveedor declara durante un Attempt queda como hecho durable (`attempt.usage_reported`, uno por turno) y se
//! consulta sumado en `attempt_detail.usage`. Lo no declarado es `null`, nunca cero. Cada prueba entra por `rpc_via(Ui, User)` (el camino
//! de Desktop) con un adapter falso; la de Claude real es manual (`#[ignore]`).

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::adapter::UsageWindow;
use super::attempt_e2e_tests::{world, World};
use super::dispatch_tests::event_count;
use super::event_kinds::{ReportedLimit, ReportedUsage};
use super::initial_approval_tests::e2e::restart_fixture_core;

fn usage(input: Option<u64>, output: Option<u64>, cache_read: Option<u64>, cache_creation: Option<u64>, cost_usd: Option<f64>) -> Step {
    Step::Usage { input, output, cache_read, cache_creation, cost_usd, limits: Vec::new() }
}

/// Un turno que declara, además de tokens, las ventanas de cuota de la cuenta: `(id, % usado, reinicio)`.
fn usage_with_limits(output: u64, limits: &[(&str, Option<f64>, Option<i64>)]) -> Step {
    let limits = limits.iter().map(|(id, used_percent, resets_at)| UsageWindow { id: id.to_string(), minutes: None, used_percent: *used_percent, resets_at: *resets_at }).collect();
    Step::Usage { input: None, output: Some(output), cache_read: None, cache_creation: None, cost_usd: None, limits }
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
        json!({"turns": 2, "provider": "claude", "source": "provider_declared", "input_tokens": 1500, "output_tokens": 400, "cache_read_tokens": 2048, "cache_creation_tokens": null, "cost_usd": 0.0123, "limits": null})
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
    let none = Vec::new;
    let u = ReportedUsage::declared(Some(u64::MAX), Some(7), None, None, Some(f64::NAN), none());
    assert_eq!((u.input_tokens, u.output_tokens, u.cost_usd), (None, Some(7), None), "no cabe en un entero exacto de JSON / NaN");
    assert_eq!(ReportedUsage::declared(None, None, None, None, Some(-1.0), none()).cost_usd, None, "un coste negativo no existe");
    assert_eq!(ReportedUsage::declared(None, None, None, None, Some(f64::INFINITY), none()).cost_usd, None);
    assert!(!ReportedUsage::declared(None, None, None, None, None, none()).any(), "nada declarado: no hay hecho");
    assert_eq!(ReportedUsage::declared(None, None, None, None, Some(0.0), none()).cost_usd, Some(0.0), "un coste de cero DECLARADO es un dato real");
}

/// Una ventana de cuota imposible se descarta, no se corrige: un id que no es un identificador corto, un porcentaje fuera de 0..=100 o no finito, un
/// reinicio no positivo, y una ventana sin nada válido que guardar. Y un turno guarda como mucho 8.
#[test]
fn una_ventana_de_cuota_imposible_se_descarta_y_no_se_corrige() {
    let ok = ReportedLimit::declared("five_hour", Some(13.0), Some(1_793_054_400)).expect("una ventana válida");
    assert_eq!((ok.id.as_str(), ok.used_percent, ok.resets_at), ("five_hour", Some(13.0), Some(1_793_054_400)));
    assert_eq!(ReportedLimit::declared("seven_day", Some(0.0), None).unwrap().used_percent, Some(0.0), "un 0 % DECLARADO es un dato real");
    for id in ["", "con espacio", "id/raro", &"x".repeat(41)] {
        assert!(ReportedLimit::declared(id, Some(1.0), None).is_none(), "id imposible: {id:?}");
    }
    assert_eq!(ReportedLimit::declared("a", Some(140.0), Some(5)).unwrap().used_percent, None, "140 % no es un porcentaje: desconocido, no 100");
    assert_eq!(ReportedLimit::declared("a", Some(f64::NAN), Some(5)).unwrap().used_percent, None);
    assert_eq!(ReportedLimit::declared("a", Some(1.0), Some(-5)).unwrap().resets_at, None, "un reinicio no positivo es desconocido");
    assert!(ReportedLimit::declared("a", Some(-1.0), Some(0)).is_none(), "sin porcentaje ni reinicio válidos no hay nada que guardar");
    assert!(ReportedLimit::declared("a", None, None).is_none());
    let many = (0..20).filter_map(|i| ReportedLimit::declared(&format!("w{i}"), Some(1.0), None)).collect();
    assert_eq!(ReportedUsage::declared(None, None, None, None, None, many).limits.len(), 8, "un turno guarda como mucho 8 ventanas");
}

/// La cuota que declara el proveedor queda en el hecho de su turno y `attempt_detail.usage.limits` da la del ÚLTIMO turno que las declaró (una
/// foto de la cuenta, no una suma: la cuota es de la cuenta y la comparten todos los Attempts). Un turno posterior sin ventanas no la borra, y un
/// Attempt cuyo proveedor nunca las declaró tiene `limits: null`, no una lista vacía ni ceros.
#[test]
fn la_cuota_declarada_queda_en_el_hecho_del_turno_y_se_consulta_la_del_ultimo_turno_que_la_declaro() {
    let (w, a1) = done_with(vec![
        usage_with_limits(10, &[("five_hour", Some(13.0), Some(1_793_054_400)), ("seven_day", Some(2.0), Some(1_793_613_600))]),
        usage_with_limits(20, &[("five_hour", Some(21.5), Some(1_793_054_400))]),
        usage(None, Some(30), None, None, None),
    ]);
    let hechos = reported(&w, &a1);
    assert_eq!(hechos.len(), 3);
    assert_eq!(hechos[0]["limits"], json!([{"id": "five_hour", "used_percent": 13.0, "resets_at": 1_793_054_400}, {"id": "seven_day", "used_percent": 2.0, "resets_at": 1_793_613_600}]));
    assert!(hechos[2].get("limits").is_none(), "un turno que no declaró ventanas no lleva `limits`: {}", hechos[2]);

    let u = detail(&w, &a1)["usage"].clone();
    assert_eq!(u["limits"], json!([{"id": "five_hour", "used_percent": 21.5, "resets_at": 1_793_054_400}]), "la foto del último turno que las declaró: {u}");
    assert_eq!(u["output_tokens"], 60, "los tokens siguen siendo la suma de los turnos");

    let (w2, a2) = done_with(vec![usage(Some(5), Some(5), None, None, None)]);
    assert!(detail(&w2, &a2)["usage"]["limits"].is_null(), "el proveedor nunca declaró ventanas: null, no [] ni ceros");
}

/// Solo las ventanas, sin un solo token, también dejan hecho: lo declarado es la cuota.
#[test]
fn un_turno_que_solo_declara_cuota_deja_hecho() {
    let solo_cuota = Step::Usage {
        input: None,
        output: None,
        cache_read: None,
        cache_creation: None,
        cost_usd: None,
        limits: vec![UsageWindow { id: "five_hour".into(), minutes: None, used_percent: Some(50.0), resets_at: None }],
    };
    let (w, a1) = done_with(vec![solo_cuota]);
    assert_eq!(event_count(&w.core, &a1, "attempt.usage_reported"), 1);
    assert_eq!(detail(&w, &a1)["usage"]["limits"], json!([{"id": "five_hour", "used_percent": 50.0}]));
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
    // La cuota de la cuenta que Claude declaró durante el turno (`rate_limit_event`): ventanas con porcentaje y reinicio, no el consumo del Attempt.
    let limits = u["limits"].as_array().unwrap_or_else(|| panic!("Claude real declara las ventanas de cuota de la cuenta: {u}"));
    assert!(limits.iter().any(|w| w["id"] == "five_hour" && w["used_percent"].as_f64().is_some_and(|p| (0.0..=100.0).contains(&p)) && w["resets_at"].as_i64().is_some_and(|t| t > 0)), "{limits:?}");
}
