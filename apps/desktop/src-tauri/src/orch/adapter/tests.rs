//! Pruebas del contrato de adapters (LXO-128). Cada una nombra el invariante o el criterio de aceptación que demuestra
//! (ver la tabla de `docs/core/ADAPTERS.md`).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use super::fake::{FakeAdapter, MinimalAdapter, Step};
use super::*;
use crate::store::looks_secret;

fn start_req(attempt: &str) -> StartRequest {
    StartRequest { attempt_id: attempt.into(), worktree: PathBuf::from("wt"), prompt: "haz algo".into(), profile: "proponer".into(), model: None, effort: None }
}

fn registry_con(adapters: Vec<Arc<dyn ProviderAdapter>>) -> AdapterRegistry {
    let mut r = AdapterRegistry::new();
    for a in adapters {
        r.register(a).unwrap();
    }
    r
}

/// Todo lo que el sink recibió y cómo terminó la ejecución.
fn corre(g: &Gated, attempt: &str) -> (Vec<AdapterEvent>, RunOutcome) {
    let cancel = CancelToken::new();
    let run = g.start(start_req(attempt), &cancel).unwrap();
    let mut got = vec![];
    let outcome = g.events(&run, &cancel, &mut |e: AdapterEvent| got.push(e)).unwrap();
    (got, outcome)
}

/// Compara con la fixture versionada (`LXO_WRITE_API_FIXTURES=1` la regenera; revísala a mano).
fn fixture(name: &str, got: &Value) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/core/fixtures/api").join(name);
    if std::env::var_os("LXO_WRITE_API_FIXTURES").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(got).unwrap() + "\n").unwrap();
    }
    let want: Value = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|_| panic!("falta {}", path.display()))).unwrap();
    assert_eq!(got, &want, "{name} cambió: si es a propósito, sube la versión del contrato y regenera la fixture");
}

fn parcial() -> ProbeResult {
    let m = CapabilityMatrix::all_available()
        .with(Capability::Steer, CapabilityState::Unsupported)
        .with(Capability::Resume, CapabilityState::unavailable("la sesión nativa no se puede reanudar con esta versión"));
    ProbeResult::ready(Some("1.2.3"), m)
}

// ---- La matriz ---------------------------------------------------------------------------------------------------

#[test]
fn la_matriz_nueva_declara_las_seis_capabilities_como_unsupported() {
    let m = CapabilityMatrix::new();
    assert_eq!(m.version, MATRIX_VERSION);
    assert_eq!(m.capabilities.len(), 6);
    for c in Capability::ALL {
        assert_eq!(m.state(c), &CapabilityState::Unsupported, "{}", c.code());
        assert!(!m.is_available(c));
    }
    // Un código por capability, distinto y que se vuelve a leer.
    for c in Capability::ALL {
        assert_eq!(Capability::parse(c.code()), Some(c));
    }
}

#[test]
fn la_matriz_serializa_estable_y_hace_roundtrip() {
    let m = parcial().matrix;
    let v = serde_json::to_value(&m).unwrap();
    assert_eq!(v["version"], 1);
    assert_eq!(v["capabilities"]["start"], json!({"state": "available"}));
    assert_eq!(v["capabilities"]["steer"], json!({"state": "unsupported"}));
    assert_eq!(v["capabilities"]["resume"]["state"], "unavailable");
    let blocked = serde_json::to_value(CapabilityMatrix::all_blocked(EnvBlock::CliMissing)).unwrap();
    assert_eq!(blocked["capabilities"]["start"], json!({"state": "environment_blocked", "block": "cli_missing"}));
    assert_eq!(serde_json::from_value::<CapabilityMatrix>(v).unwrap(), m);
}

#[test]
fn una_matriz_incompleta_de_otra_version_o_con_nombres_ajenos_no_se_acepta() {
    let ok = serde_json::to_value(CapabilityMatrix::all_available()).unwrap();

    let mut sin_steer = ok.clone();
    sin_steer["capabilities"].as_object_mut().unwrap().remove("steer");
    let e = serde_json::from_value::<CapabilityMatrix>(sin_steer).unwrap_err().to_string();
    assert!(e.contains("falta `steer`"), "{e}");

    let mut v2 = ok.clone();
    v2["version"] = json!(2);
    assert!(serde_json::from_value::<CapabilityMatrix>(v2).unwrap_err().to_string().contains("versión de matriz desconocida"));

    let mut ajena = ok.clone();
    ajena["capabilities"]["teleport"] = json!({"state": "available"});
    assert!(serde_json::from_value::<CapabilityMatrix>(ajena).is_err());

    let mut estado = ok;
    estado["capabilities"]["start"] = json!({"state": "quizas"});
    assert!(serde_json::from_value::<CapabilityMatrix>(estado).is_err());
}

#[test]
fn cada_estado_de_la_matriz_da_su_error_estable() {
    let m = parcial().matrix.with(Capability::Answer, CapabilityState::EnvironmentBlocked { block: EnvBlock::CliFlagsUnsupported });
    assert!(m.require(Capability::Start).is_ok());

    let e = m.require(Capability::Steer).unwrap_err();
    assert_eq!((e.code, e.kind()), (ErrorCode::UnsupportedCapability, FailureKind::Rejected));

    let e = m.require(Capability::Resume).unwrap_err();
    assert_eq!((e.code, e.kind()), (ErrorCode::CapabilityUnavailable, FailureKind::Rejected));
    assert!(e.message.contains("la sesión nativa"), "{}", e.message);

    let e = m.require(Capability::Answer).unwrap_err();
    assert_eq!((e.code, e.kind(), e.env_block), (ErrorCode::EnvironmentBlocked, FailureKind::EnvironmentBlocked, Some(EnvBlock::CliFlagsUnsupported)));

    // Los códigos públicos no cambian sin querer.
    let codes: Vec<&str> = [
        ErrorCode::UnknownCapability,
        ErrorCode::UnsupportedCapability,
        ErrorCode::CapabilityUnavailable,
        ErrorCode::EnvironmentBlocked,
        ErrorCode::Cancelled,
        ErrorCode::InvalidRequest,
        ErrorCode::UnknownProvider,
        ErrorCode::UnknownRun,
        ErrorCode::Provider,
        ErrorCode::Internal,
    ]
    .into_iter()
    .map(ErrorCode::code)
    .collect();
    assert_eq!(
        codes,
        [
            "unknown_capability", "unsupported_capability", "capability_unavailable", "environment_blocked", "cancelled", "invalid_request",
            "unknown_provider", "unknown_run", "provider", "internal"
        ]
    );
    assert_eq!(serde_json::to_value(ErrorCode::UnsupportedCapability).unwrap(), json!("unsupported_capability"));
}

#[test]
fn un_nombre_de_capability_que_no_existe_es_unknown_capability_y_uno_no_ofrecido_es_unsupported() {
    let reg = registry_con(vec![Arc::new(FakeAdapter::with_probe("p", parcial()))]);
    let g = reg.gated("p").unwrap();

    let e = g.require_named("teleport").unwrap_err();
    assert_eq!((e.code, e.kind()), (ErrorCode::UnknownCapability, FailureKind::Rejected));
    assert_eq!(Capability::parse_or_error("teleport").unwrap_err(), e);

    assert_eq!(g.require_named("steer").unwrap_err().code, ErrorCode::UnsupportedCapability);
    assert_eq!(g.require_named("start").unwrap(), Capability::Start);
}

// ---- Fake adapter y capabilities ---------------------------------------------------------------------------------

#[test]
fn el_fake_cubre_las_seis_capabilities_a_traves_de_gated() {
    let fake = Arc::new(FakeAdapter::full("fake-full"));
    let reg = registry_con(vec![fake.clone()]);
    let g = reg.gated("fake-full").unwrap();
    for c in Capability::ALL {
        assert!(g.matrix().is_available(c), "{}", c.code());
    }

    let cancel = CancelToken::new();
    let run = g.start(start_req("a1"), &cancel).unwrap();
    g.events(&run, &cancel, &mut |_: AdapterEvent| {}).unwrap();
    g.answer(&run, Answer { question_id: "q1".into(), text: "sí".into() }).unwrap();
    g.interrupt(&run).unwrap();
    g.steer(&run, "más corto").unwrap();
    let again = g.resume(ResumeRequest { attempt_id: "a2".into(), provider_ref: ProviderRef::new("sesion-1").unwrap(), worktree: "wt".into(), prompt: None }, &cancel).unwrap();
    assert_eq!(again.attempt_id, "a2");

    let llamadas = fake.calls();
    for esperada in ["start", "events", "answer:q1", "interrupt", "steer:más corto", "resume"] {
        assert!(llamadas.iter().any(|c| c == esperada), "{esperada} no llegó al adapter: {llamadas:?}");
    }
}

#[test]
fn una_capability_no_ofrecida_no_llega_al_adapter() {
    let fake = Arc::new(FakeAdapter::with_probe("fake-parcial", parcial()));
    let reg = registry_con(vec![fake.clone()]);
    let g = reg.gated("fake-parcial").unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("a1"), &cancel).unwrap();

    assert_eq!(g.steer(&run, "x").unwrap_err().code, ErrorCode::UnsupportedCapability);
    let r = ResumeRequest { attempt_id: "a2".into(), provider_ref: ProviderRef::new("s").unwrap(), worktree: "wt".into(), prompt: None };
    assert_eq!(g.resume(r, &cancel).unwrap_err().code, ErrorCode::CapabilityUnavailable);

    let llamadas = fake.calls();
    assert!(!llamadas.iter().any(|c| c.starts_with("steer") || c == "resume"), "{llamadas:?}");
}

#[test]
fn un_adapter_que_no_implementa_una_capability_la_rechaza_sin_fingirla() {
    let a = MinimalAdapter::new("minimo");
    let run = RunHandle { attempt_id: "a".into(), adapter: "minimo".into(), seq: 1 };
    assert_eq!(a.answer(&run, Answer { question_id: "q".into(), text: "t".into() }).unwrap_err().code, ErrorCode::UnsupportedCapability);
    assert_eq!(a.interrupt(&run).unwrap_err().code, ErrorCode::UnsupportedCapability);
    assert_eq!(a.steer(&run, "x").unwrap_err().code, ErrorCode::UnsupportedCapability);
    let r = ResumeRequest { attempt_id: "a".into(), provider_ref: ProviderRef::new("s").unwrap(), worktree: "wt".into(), prompt: None };
    assert_eq!(a.resume(r, &CancelToken::new()).unwrap_err().code, ErrorCode::UnsupportedCapability);

    // Y su matriz, la que declara, dice lo mismo: solo start y events.
    let m = a.probe().matrix;
    let ofrece: Vec<&str> = Capability::ALL.into_iter().filter(|c| m.is_available(*c)).map(Capability::code).collect();
    assert_eq!(ofrece, ["start", "events"]);
}

// ---- Ciclo de vida y cancelación ---------------------------------------------------------------------------------

#[test]
fn start_events_entrega_los_hechos_en_orden_y_el_resultado() {
    let fake = Arc::new(FakeAdapter::full("f"));
    fake.set_script(vec![
        Step::Bind("sesion-opaca-1"),
        Step::Output("trabajando".into()),
        Step::Question { id: "q1", text: "¿sigo?".into() },
        Step::Complete(Some("listo".into())),
    ]);
    let reg = registry_con(vec![fake]);
    let (got, outcome) = corre(&reg.gated("f").unwrap(), "a1");

    assert_eq!(got.len(), 3);
    assert!(matches!(&got[0], AdapterEvent::SessionBound { provider_ref } if provider_ref.expose() == "sesion-opaca-1"));
    assert_eq!(got[1], AdapterEvent::Output { text: "trabajando".into() });
    assert_eq!(got[2], AdapterEvent::Question { question_id: "q1".into(), text: "¿sigo?".into() });
    assert_eq!(outcome, RunOutcome::Completed { summary: Some("listo".into()) });
}

#[test]
fn cancelar_antes_de_arrancar_no_llega_al_adapter() {
    let fake = Arc::new(FakeAdapter::full("f"));
    let reg = registry_con(vec![fake.clone()]);
    let cancel = CancelToken::new();
    cancel.cancel();
    let e = reg.gated("f").unwrap().start(start_req("a1"), &cancel).unwrap_err();
    assert_eq!((e.code, e.kind()), (ErrorCode::Cancelled, FailureKind::Cancelled));
    assert!(!fake.calls().iter().any(|c| c == "start"));
    // Todos los clones del token ven la cancelación.
    assert!(cancel.clone().is_cancelled());
}

#[test]
fn cancelar_durante_events_termina_cancelled() {
    let fake = Arc::new(FakeAdapter::full("f"));
    fake.set_script(vec![Step::Output("empiezo".into()), Step::Wait, Step::Complete(None)]);
    let reg = registry_con(vec![fake]);
    let g = reg.gated("f").unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("a1"), &cancel).unwrap();

    let outcome = std::thread::scope(|s| {
        let h = s.spawn(|| g.events(&run, &cancel, &mut |_: AdapterEvent| {}));
        std::thread::sleep(std::time::Duration::from_millis(30));
        cancel.cancel();
        h.join().unwrap()
    });
    assert_eq!(outcome.unwrap(), RunOutcome::Cancelled);
}

#[test]
fn interrumpir_termina_interrupted_sin_ser_un_fallo() {
    let fake = Arc::new(FakeAdapter::full("f"));
    fake.set_script(vec![Step::Wait, Step::Complete(None)]);
    let reg = registry_con(vec![fake]);
    let g = reg.gated("f").unwrap();
    let cancel = CancelToken::new();
    let run = g.start(start_req("a1"), &cancel).unwrap();
    g.interrupt(&run).unwrap();
    assert_eq!(g.events(&run, &cancel, &mut |_: AdapterEvent| {}).unwrap(), RunOutcome::Interrupted);
}

#[test]
fn una_ejecucion_ajena_es_unknown_run() {
    let reg = registry_con(vec![Arc::new(FakeAdapter::full("f"))]);
    let g = reg.gated("f").unwrap();
    let ajena = RunHandle { attempt_id: "a".into(), adapter: "otro".into(), seq: 1 };
    assert_eq!(g.interrupt(&ajena).unwrap_err().code, ErrorCode::UnknownRun);
}

// ---- Entorno ≠ fallo ---------------------------------------------------------------------------------------------

#[test]
fn entorno_bloqueado_no_es_un_attempt_fallido() {
    let fake = Arc::new(FakeAdapter::with_probe("bloqueado", ProbeResult::blocked(None, vec![EnvBlock::CliMissing])));
    let reg = registry_con(vec![fake.clone()]);
    let g = reg.gated("bloqueado").unwrap();

    let e = g.start(start_req("a1"), &CancelToken::new()).unwrap_err();
    assert_eq!(e.code, ErrorCode::EnvironmentBlocked);
    assert_eq!(e.kind(), FailureKind::EnvironmentBlocked);
    assert_eq!(e.env_block, Some(EnvBlock::CliMissing));
    assert!(!fake.calls().iter().any(|c| c == "start"), "el adapter no arranca nada con el entorno bloqueado");

    // El snapshot lo cuenta como entorno, no como error.
    let snap = reg.snapshot();
    assert_eq!(snap.providers[0].environment, Environment::Blocked { blocks: vec![EnvBlock::CliMissing] });

    // En cambio, un fallo del proveedor mientras corre SÍ es del Attempt.
    let falla = Arc::new(FakeAdapter::full("falla"));
    falla.set_script(vec![Step::Fail(AdapterError::provider("el modelo devolvió un error"))]);
    let reg = registry_con(vec![falla]);
    let (_, outcome) = corre(&reg.gated("falla").unwrap(), "a2");
    let RunOutcome::Failed(err) = outcome else { panic!("{outcome:?}") };
    assert_eq!(err.kind(), FailureKind::AttemptFailure);
}

// ---- Opacidad y secretos -----------------------------------------------------------------------------------------

#[test]
fn la_referencia_del_proveedor_es_opaca() {
    let r = ProviderRef::new("9f2c1d7e-sesion").unwrap();
    assert_eq!(format!("{r:?}"), "ProviderRef(<opaco>)");
    assert!(!format!("{:?}", AdapterEvent::SessionBound { provider_ref: r }).contains("9f2c1d7e"));

    for mala in ["", "   ", "con\nsalto", "sk-live-AAAAAAAAAAAAAAAA", "token=abc123def456"] {
        assert_eq!(ProviderRef::new(mala).unwrap_err().code, ErrorCode::InvalidRequest, "{mala:?}");
    }
    assert!(ProviderRef::new(&"x".repeat(crate::store::MAX_EXTERNAL_REF_CHARS + 1)).is_err());
}

#[test]
fn los_secretos_no_salen_del_adapter() {
    const SECRETOS: [&str; 4] = ["token=abc123def456ghi789", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA", "Authorization: Bearer xyz.abc.def", "ghp_AAAAAAAAAAAAAAAAAAAAAAAA"];

    // Los hechos que salen hacia el Core.
    let fake = Arc::new(FakeAdapter::full("f"));
    fake.set_script(
        SECRETOS
            .iter()
            .map(|s| Step::Output(format!("resultado {s} fin")))
            .chain([Step::Question { id: "q", text: format!("usa {}", SECRETOS[1]) }, Step::Complete(None)])
            .collect(),
    );
    let reg = registry_con(vec![fake]);
    let (got, _) = corre(&reg.gated("f").unwrap(), "a1");
    assert_eq!(got.len(), 5);
    for e in &got {
        let text = match e {
            AdapterEvent::Output { text } | AdapterEvent::Question { text, .. } => text,
            other => panic!("{other:?}"),
        };
        assert!(!looks_secret(text), "se coló un secreto: {text}");
        assert!(text.contains(REDACTED), "{text}");
    }
    assert!(matches!(&got[0], AdapterEvent::Output { text } if text == "resultado [redactado] fin"), "el texto normal se conserva");

    // Los errores y la matriz.
    for s in SECRETOS {
        let e = AdapterError::provider(&format!("falló con {s}")).with_diagnostic(&format!("stderr: {s}"));
        let todo = serde_json::to_string(&e).unwrap();
        assert!(!looks_secret(&e.message) && !looks_secret(e.diagnostic.as_deref().unwrap()), "{todo}");
        assert!(!todo.contains("AAAAAAAAAAAA") && !todo.contains("abc123def456") && !todo.contains("xyz.abc.def"), "{todo}");
        let CapabilityState::Unavailable { reason } = CapabilityState::unavailable(&format!("login {s}")) else { unreachable!() };
        assert!(!looks_secret(&reason), "{reason}");
    }
}

#[test]
fn el_diagnostico_se_acota_marcando_el_corte() {
    let e = AdapterError::provider("falló").with_diagnostic(&"x".repeat(5000));
    let d = e.diagnostic.unwrap();
    assert_eq!(d.chars().count(), redact::MAX_DIAGNOSTIC_CHARS + 1);
    assert!(d.ends_with('…'));
    let corto = AdapterError::provider("falló").with_diagnostic("stderr: no such file");
    assert_eq!(corto.diagnostic.as_deref(), Some("stderr: no such file"));
}

// ---- Registro ----------------------------------------------------------------------------------------------------

#[test]
fn el_snapshot_del_registro_coincide_con_la_fixture_versionada() {
    let reg = registry_con(vec![
        Arc::new(FakeAdapter::full("fake-completo")),
        Arc::new(FakeAdapter::with_probe("fake-parcial", parcial())),
        Arc::new(FakeAdapter::with_probe("fake-bloqueado", ProbeResult::blocked(None, vec![EnvBlock::CliMissing]))),
    ]);
    let snap = reg.snapshot();
    assert_eq!((snap.version, snap.providers.len()), (SNAPSHOT_VERSION, 3));
    let v = serde_json::to_value(&snap).unwrap();
    fixture("provider_capabilities.v1.json", &v);
    // Lo que publica el Core se vuelve a leer tal cual (un cliente Rust o una prueba de contrato).
    assert_eq!(serde_json::from_value::<RegistrySnapshot>(v).unwrap(), snap);
}

#[test]
fn refresh_refleja_un_cambio_de_capabilities_sin_reiniciar() {
    let fake = Arc::new(FakeAdapter::full("f"));
    let mut reg = registry_con(vec![fake.clone()]);
    let g0 = reg.generation();
    assert!(reg.snapshot().providers[0].matrix.is_available(Capability::Steer));

    // Nada cambió: no sube la generación.
    assert!(!reg.refresh("f").unwrap());
    assert_eq!(reg.generation(), g0);

    // El proveedor deja de ofrecer steer (otra versión, otro modo): el Core lo ve tras el refresh y Gated lo respeta.
    fake.set_probe(parcial());
    assert!(reg.refresh_all());
    assert_eq!(reg.generation(), g0 + 1);
    let snap = reg.snapshot();
    assert_eq!(snap.generation, g0 + 1);
    assert_eq!(snap.providers[0].matrix.state(Capability::Steer), &CapabilityState::Unsupported);
    assert_eq!(snap.providers[0].cli_version.as_deref(), Some("1.2.3"));
    let cancel = CancelToken::new();
    let run = reg.gated("f").unwrap().start(start_req("a"), &cancel).unwrap();
    assert_eq!(reg.gated("f").unwrap().steer(&run, "x").unwrap_err().code, ErrorCode::UnsupportedCapability);
}

#[test]
fn el_registro_rechaza_ids_invalidos_repetidos_y_proveedores_desconocidos() {
    let mut reg = AdapterRegistry::new();
    for malo in ["", "Con Mayúsculas", "con espacio", "con_guion_bajo"] {
        let e = reg.register(Arc::new(FakeAdapter::full(malo))).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidRequest, "{malo:?}");
    }
    assert!(reg.register(Arc::new(FakeAdapter::full(&"a".repeat(65)))).is_err());
    assert_eq!(reg.generation(), 0, "un rechazo no cambia el registro");

    reg.register(Arc::new(FakeAdapter::full("ok"))).unwrap();
    assert_eq!(reg.register(Arc::new(FakeAdapter::full("ok"))).unwrap_err().code, ErrorCode::InvalidRequest);
    assert_eq!(reg.generation(), 1);

    assert_eq!(reg.gated("nadie").err().map(|e| e.code), Some(ErrorCode::UnknownProvider));
    assert_eq!(reg.refresh("nadie").unwrap_err().code, ErrorCode::UnknownProvider);
}
