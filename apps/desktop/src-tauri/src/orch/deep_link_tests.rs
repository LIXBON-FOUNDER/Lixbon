//! LXO-168 · pruebas del esquema `lixbon://`: ida y vuelta, rechazo de rutas peligrosas y de formas ambiguas.

use super::deep_link::{parse, DeepLink, LinkCode, View, SCHEMA_VERSION};

fn code_of(raw: &str) -> LinkCode {
    parse(raw).expect_err(raw).code
}

fn full() -> DeepLink {
    DeepLink {
        project_id: "p-1".into(),
        task_id: Some("t2".into()),
        attempt_id: Some("t2-a1".into()),
        view: Some(View::Diff),
        file: Some("src/orch/mod.rs".into()),
        line: Some(42),
        revision: Some("0123abc".into()),
    }
}

#[test]
fn el_contrato_publicado_se_lee_entero() {
    let link = parse("lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file=src/orch/mod.rs&line=42&revision=0123abc").unwrap();
    assert_eq!(link, full());
}

#[test]
fn ida_y_vuelta_de_cada_forma_valida() {
    let mut casos = vec![full()];
    casos.push(DeepLink { project_id: "p-1".into(), task_id: None, attempt_id: None, view: None, file: None, line: None, revision: None });
    casos.push(DeepLink { project_id: "p-1".into(), task_id: Some("t2".into()), attempt_id: None, view: Some(View::Activity), file: None, line: None, revision: None });
    casos.push(DeepLink { project_id: "p.1_x".into(), task_id: Some("t2".into()), attempt_id: Some("t2-a3".into()), view: Some(View::Review), file: None, line: None, revision: Some("a".repeat(64)) });
    casos.push(DeepLink { project_id: "p-1".into(), task_id: None, attempt_id: None, view: None, file: Some("docs/a b/ñandú+1%.md".into()), line: Some(1), revision: None });
    for link in casos {
        let url = link.to_url().unwrap();
        assert_eq!(parse(&url).unwrap(), link, "{url}");
        assert_eq!(parse(&url).unwrap().to_url().unwrap(), url, "la forma canónica es estable: {url}");
    }
}

#[test]
fn la_forma_canonica_ordena_claves_normaliza_y_no_escribe_la_version() {
    let link = parse("  LIXBON://project/p-1/task/t2/attempt/t2-a1?v=1&revision=ABC1234&line=3&file=a%2Fb.rs&view=diff  ").unwrap();
    assert_eq!(link.revision.as_deref(), Some("abc1234"));
    assert_eq!(link.to_url().unwrap(), "lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file=a/b.rs&line=3&revision=abc1234");
}

#[test]
fn la_ruta_se_codifica_una_sola_vez_y_los_caracteres_raros_van_en_hex() {
    let link = DeepLink { file: Some("dir con espacio/ñ+&=#?.rs".into()), line: None, revision: None, view: Some(View::Diff), ..full() };
    let url = link.to_url().unwrap();
    assert!(url.contains("file=dir%20con%20espacio/%C3%B1%2B%26%3D%23%3F.rs"), "{url}");
    assert_eq!(parse(&url).unwrap().file, link.file);
}

#[test]
fn rechaza_rutas_que_suben_o_son_absolutas_en_todas_sus_formas() {
    let base = "lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file=";
    for peligrosa in [
        "../secreto",
        "a/../../secreto",
        "a/./b",
        "%2e%2e/secreto",
        "%2E%2E%2Fsecreto",
        "a%2f..%2fb",
        "..%2fsecreto",
        "/etc/passwd",
        "%2Fetc%2Fpasswd",
        "C:/Windows/system32",
        "c%3A/Windows",
        "a%5Cb",
        "a%5c..%5cb",
        "%252e%252e/secreto",
        "a//b",
        "a/",
        "a%00b",
        "a%0Ab",
        "%",
        "%zz",
        "%e0%80%af",
        "",
    ] {
        assert_eq!(code_of(&format!("{base}{peligrosa}")), LinkCode::Malformed, "{peligrosa}");
    }
}

#[test]
fn rechaza_formas_ambiguas_o_incompletas() {
    for raw in [
        "",
        "   ",
        "lixbon:/project/p-1",
        "https://project/p-1",
        "lixbon://",
        "lixbon://project",
        "lixbon://project/",
        "lixbon://projects/p-1",
        "lixbon://task/t2",
        "lixbon://project/p-1/",
        "lixbon://project/p-1/attempt/t2-a1",
        "lixbon://project/p-1/task",
        "lixbon://project/p-1/task/t2/attempt",
        "lixbon://project/p-1/task/t2/attempt/t2-a1/extra",
        "lixbon://project/p-1/task/t2/otro/x",
        "lixbon://usuario@project/p-1",
        "lixbon://project/p-1#frag",
        "lixbon://project/p-1?",
        "lixbon://project/p-1?view",
        "lixbon://project/p-1?view=",
        "lixbon://project/p-1?view=overview&view=activity",
        "lixbon://project/p-1?cualquiera=1",
        "lixbon://project/p-1?VIEW=overview",
        "lixbon://project/p-1 /task/t2",
        "lixbon://project/p-1\n/task/t2",
        "lixbon://project/..",
        "lixbon://project/p%2F1",
        "lixbon://project/p-1/task/t2/attempt/..",
    ] {
        assert_eq!(code_of(raw), LinkCode::Malformed, "{raw:?}");
    }
}

#[test]
fn rechaza_combinaciones_incoherentes_entre_campos() {
    for raw in [
        "lixbon://project/p-1?view=diff",
        "lixbon://project/p-1/task/t2?view=review",
        "lixbon://project/p-1/task/t2?view=artifact",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?view=overview&file=a.rs",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?view=activity&file=a.rs",
        "lixbon://project/p-1?line=3",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&line=3",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file=a.rs&line=0",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file=a.rs&line=-1",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file=a.rs&line=1.5",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file=a.rs&line=10000001",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file=a.rs&line=99999999999",
        "lixbon://project/p-1/task/t2?revision=abc1234",
        "lixbon://project/p-1?revision=abc1234",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?revision=abc123",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?revision=xyz1234",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?revision=HEAD",
        "lixbon://project/p-1/task/t2/attempt/t2-a1?view=terminal",
    ] {
        assert_eq!(code_of(raw), LinkCode::Malformed, "{raw}");
    }
}

#[test]
fn los_ids_no_admiten_rutas_ni_codificacion_ni_longitud_excesiva() {
    for id in ["", ".", "..", "a/b", "a b", "a%2Fb", "a\\b", "ñ", "a:b", "a@b", "x\u{0}y"] {
        let link = DeepLink { project_id: id.into(), task_id: None, attempt_id: None, view: None, file: None, line: None, revision: None };
        assert!(link.to_url().is_err(), "{id:?}");
    }
    let largo = "a".repeat(201);
    assert_eq!(code_of(&format!("lixbon://project/{largo}")), LinkCode::Malformed);
    assert!(parse(&format!("lixbon://project/{}", "a".repeat(200))).is_ok());
    assert_eq!(code_of(&format!("lixbon://project/p-1?view=diff&file={}", "a".repeat(2100))), LinkCode::Malformed, "enlace demasiado largo");
}

#[test]
fn una_ruta_de_mil_veinticuatro_caracteres_es_el_limite() {
    let ok = format!("lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file={}", "a".repeat(1024));
    assert!(parse(&ok).is_ok());
    let largo = format!("lixbon://project/p-1/task/t2/attempt/t2-a1?view=diff&file={}", "a".repeat(1025));
    assert_eq!(code_of(&largo), LinkCode::Malformed);
}

#[test]
fn una_version_futura_se_distingue_de_un_enlace_mal_formado() {
    assert_eq!(SCHEMA_VERSION, 1);
    assert!(parse("lixbon://project/p-1?v=1").is_ok());
    assert_eq!(code_of("lixbon://project/p-1?v=2"), LinkCode::VersionUnsupported);
    assert_eq!(code_of("lixbon://project/p-1/task/t2?v=7&otra=cosa"), LinkCode::VersionUnsupported, "un esquema futuro puede traer claves nuevas");
    assert_eq!(code_of("lixbon://project/p-1?v=0"), LinkCode::Malformed);
    assert_eq!(code_of("lixbon://project/p-1?v="), LinkCode::Malformed);
    assert_eq!(code_of("lixbon://project/p-1?v=x"), LinkCode::Malformed);
    assert_eq!(code_of("lixbon://project/p-1?v=1&v=1"), LinkCode::Malformed);
    assert_eq!(code_of("https://project/p-1?v=2"), LinkCode::Malformed, "la versión no salva un esquema ajeno");
}

#[test]
fn los_mensajes_de_error_no_repiten_la_entrada() {
    let hostil = "lixbon://project/p-1?view=diff&file=SECRETO/../x";
    let err = parse(hostil).unwrap_err();
    assert!(!err.message.contains("SECRETO"), "{}", err.message);
    let err = parse("lixbon://SECRETO/p-1").unwrap_err();
    assert!(!err.message.contains("SECRETO"), "{}", err.message);
    assert!(err.into_rpc().starts_with("link_malformed: "));
}

#[test]
fn el_generador_no_emite_lo_que_el_parser_rechaza() {
    let mut malo = full();
    malo.file = Some("../x".into());
    assert!(malo.to_url().is_err());
    let mut sin_task = full();
    sin_task.task_id = None;
    assert!(sin_task.to_url().is_err());
    let mut sin_attempt = full();
    sin_attempt.attempt_id = None;
    assert!(sin_attempt.to_url().is_err(), "diff y revision necesitan Attempt");
    let mut linea_sin_archivo = full();
    linea_sin_archivo.file = None;
    assert!(linea_sin_archivo.to_url().is_err());
    let mut rev_mayus = full();
    rev_mayus.revision = Some("ABC1234".into());
    assert!(rev_mayus.to_url().is_err(), "el generador exige la forma normalizada");
}
