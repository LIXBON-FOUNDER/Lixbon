//! Pruebas de ContextPackage v1 (LXO-133): schema válido e inválido, identidad y manipulación, centinelas de redacción,
//! límites y truncado, adjuntos, y el paso entre dos adapters falsos.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::*;
use crate::orch::adapter::{
    AdapterError, AdapterRegistry, CancelToken, CapabilityMatrix, EventSink, ProbeResult, ProviderAdapter, RunHandle, RunOutcome, StartRequest,
};

type Mutacion = Box<dyn Fn(&mut Value)>;

const T0: i64 = 1_800_000_000_000;
const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
const TREE: &str = "89abcdef0123456789abcdef0123456789abcdef";

// ── Material ────────────────────────────────────────────────────────────────────────────────────────────────────────────

fn revision() -> Revision {
    Revision {
        base_commit: "e73a74da".into(),
        head_commit: SHA.into(),
        head_tree: TREE.into(),
        branch: Some("feat/lxo-205-usage-cross-provider".into()),
        files: vec![
            FileChange { path: "docs/core/ADAPTERS.md".into(), added: Some(61), deleted: Some(1) },
            FileChange { path: "apps/desktop/src-tauri/src/orch/adapter/usage.rs".into(), added: Some(400), deleted: Some(0) },
        ],
        diff_sha256: Some(sha256_hex(b"diff original")),
        diff_bytes: Some(99_407),
    }
}

fn nuevo() -> NewPackage {
    NewPackage {
        created_at_ms: T0,
        project_id: "p-lixbon".into(),
        task_id: "t-205".into(),
        attempt_id: "a-1".into(),
        provider: "claude".into(),
        provider_session: Some("6f1c2a9e-0b7d-4d1e-9a51-3c2f8e7d9b10".into()),
        host: "DESKTOP-ABC123".into(),
        objective: "Normalizar el uso de cada proveedor sin fingir métricas.".into(),
        decisions: vec!["Claude se consulta con `claude -p /usage`.".into(), "El informe no suma magnitudes incompatibles.".into()],
        constraints: vec!["Sin push ni PR hasta el PR único del Core F4.".into()],
        thread_summary: Some("La persona pidió la cuota exacta; quedó pendiente la hora de reinicio.".into()),
        revision: RevisionInput::Git(revision()),
        uncommitted: None,
        test_results: Some(TestResults { command: "cargo test --lib".into(), passed: Some(1441), failed: Some(0), ignored: Some(19) }),
        artifacts: vec![Artifact { kind: ArtifactKind::Commit, uri: SHA.into(), sha256: None, bytes: None }],
        bundle: None,
    }
}

fn sucio() -> UncommittedInput {
    UncommittedInput {
        staged_patch: Some(b"diff --git a/x b/x\n+preparado\n".to_vec()),
        unstaged_patch: Some(b"diff --git a/y b/y\n+no preparado\n".to_vec()),
        untracked: vec![UntrackedInput { path: "NOTAS.md".into(), data: b"Siguiente paso: la hora de reinicio.\n".to_vec() }],
    }
}

fn completo() -> NewPackage {
    NewPackage { uncommitted: Some(sucio()), bundle: Some(vec![7u8; 4096]), ..nuevo() }
}

fn json_of(b: &Built) -> Value {
    serde_json::from_str(b.package.to_json()).unwrap()
}

/// Recalcula la identidad de un documento manipulado: simula a quien altera el contenido y vuelve a sellarlo.
fn reseal(v: &mut Value) {
    let id = package_id_of(v);
    v["package_id"] = json!(id);
}

fn rechaza(v: &Value) -> PackageErrorCode {
    parse(&v.to_string()).expect_err("debía rechazarse").code
}

// ── Roundtrip e identidad ───────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn un_paquete_valido_hace_roundtrip_estable() {
    let b = build(completo()).unwrap();
    let p = parse(b.package.to_json()).unwrap();
    assert_eq!(p, b.package, "lo que se exporta es lo que se importa");
    assert_eq!(p.to_json(), b.package.to_json(), "volver a emitirlo da los mismos bytes");
    // Y otra vez: exportar → importar → exportar no cambia nada.
    assert_eq!(parse(p.to_json()).unwrap().to_json(), b.package.to_json());
    assert!(p.id().starts_with("sha256:") && p.id().len() == 71);
}

#[test]
fn construir_dos_veces_lo_mismo_da_la_misma_identidad() {
    assert_eq!(build(completo()).unwrap().package.id(), build(completo()).unwrap().package.id());
    let mut otro = completo();
    otro.objective.push('!');
    assert_ne!(build(otro).unwrap().package.id(), build(completo()).unwrap().package.id());
}

#[test]
fn el_orden_de_las_claves_no_cambia_la_identidad() {
    let b = build(completo()).unwrap();
    let v = json_of(&b);
    // Se reescribe con las claves en otro orden: sigue siendo el mismo paquete.
    let mut inv: Vec<(String, Value)> = v.as_object().unwrap().iter().map(|(k, x)| (k.clone(), x.clone())).collect();
    inv.reverse();
    let texto = format!("{{{}}}", inv.iter().map(|(k, x)| format!("{}:{}", serde_json::to_string(k).unwrap(), x)).collect::<Vec<_>>().join(","));
    assert_eq!(parse(&texto).unwrap().id(), b.package.id());
}

#[test]
fn la_procedencia_la_fija_el_core_y_el_receptor_no_la_reescribe() {
    let p = build(nuevo()).unwrap().package;
    // El receptor registra lo suyo APARTE; el paquete y su origen no cambian.
    let r = p.receipt("codex", T0 + 5);
    assert_eq!((r.package_id.as_str(), r.received_by.as_str(), r.received_at_ms), (p.id(), "codex", T0 + 5));
    assert_eq!(p.source.provider, "claude");
    // Reescribir el origen en el documento rompe la identidad.
    let mut v = serde_json::from_str::<Value>(p.to_json()).unwrap();
    v["source"]["provider"] = json!("codex");
    assert_eq!(rechaza(&v), PackageErrorCode::IdMismatch);
    // Y las huellas, no los identificadores locales, son lo que viaja.
    assert!(p.source.host.starts_with("fp:") && p.source.provider_session.as_deref().unwrap().starts_with("fp:"));
    assert!(!p.to_json().contains("DESKTOP-ABC123") && !p.to_json().contains("6f1c2a9e"));
}

#[test]
fn alterar_cualquier_campo_rompe_la_identidad() {
    let b = build(completo()).unwrap();
    let base = json_of(&b);
    let cambios: Vec<(&str, Mutacion)> = vec![
        ("objective", Box::new(|v| v["objective"] = json!("otro objetivo"))),
        ("decisions", Box::new(|v| v["decisions"][0] = json!("otra decisión"))),
        ("revision.head_tree", Box::new(|v| v["revision"]["head_tree"] = json!("fedcba9876543210fedcba9876543210fedcba98"))),
        ("test_results", Box::new(|v| v["test_results"]["passed"] = json!(9999))),
        ("attachments", Box::new(|v| v["attachments"][0]["bytes"] = json!(1))),
        ("created_at_ms", Box::new(|v| v["created_at_ms"] = json!(1))),
        ("redactions", Box::new(|v| v["redactions"] = json!(5))),
    ];
    for (campo, f) in cambios {
        let mut v = base.clone();
        f(&mut v);
        assert_eq!(rechaza(&v), PackageErrorCode::IdMismatch, "alterar {campo} debe romper la identidad");
    }
}

// ── Schema: versión, requeridos, formatos ───────────────────────────────────────────────────────────────────────────────

#[test]
fn una_version_desconocida_se_rechaza_antes_de_mirar_nada_mas() {
    let mut v = json_of(&build(nuevo()).unwrap());
    v["schema_version"] = json!(2);
    v.as_object_mut().unwrap().remove("objective");
    assert_eq!(rechaza(&v), PackageErrorCode::UnsupportedVersion, "la versión manda sobre cualquier otro defecto");
    v["schema_version"] = json!("1");
    assert_eq!(rechaza(&v), PackageErrorCode::UnsupportedVersion);
    v.as_object_mut().unwrap().remove("schema_version");
    assert_eq!(rechaza(&v), PackageErrorCode::MissingField);
}

#[test]
fn cada_campo_requerido_falta_con_su_error() {
    let base = json_of(&build(nuevo()).unwrap());
    for k in ["package_id", "created_at_ms", "source", "objective", "decisions", "constraints", "revision", "redactions"] {
        let mut v = base.clone();
        v.as_object_mut().unwrap().remove(k);
        let e = parse(&v.to_string()).unwrap_err();
        assert_eq!((e.code, e.message.as_str()), (PackageErrorCode::MissingField, k), "falta {k}");
    }
}

#[test]
fn entradas_que_no_son_un_paquete() {
    assert_eq!(parse("no es json").unwrap_err().code, PackageErrorCode::InvalidJson);
    assert_eq!(parse("[1,2]").unwrap_err().code, PackageErrorCode::InvalidJson);
    assert_eq!(parse("{}").unwrap_err().code, PackageErrorCode::MissingField);
    assert_eq!(parse(&"x".repeat(MAX_PACKAGE_BYTES + 1)).unwrap_err().code, PackageErrorCode::TooLarge);
}

#[test]
fn revision_null_exige_motivo_y_con_revision_el_motivo_sobra() {
    let p = build(NewPackage { revision: RevisionInput::Absent("el Attempt no tiene repositorio".into()), uncommitted: None, ..nuevo() }).unwrap().package;
    assert!(p.revision.is_none());
    assert_eq!(p.revision_absent_reason.as_deref(), Some("el Attempt no tiene repositorio"));
    parse(p.to_json()).unwrap();

    let mut sin_motivo = serde_json::from_str::<Value>(p.to_json()).unwrap();
    sin_motivo.as_object_mut().unwrap().remove("revision_absent_reason");
    reseal(&mut sin_motivo);
    assert_eq!(rechaza(&sin_motivo), PackageErrorCode::InvalidField);

    let mut ambas = json_of(&build(nuevo()).unwrap());
    ambas["revision_absent_reason"] = json!("sobra");
    reseal(&mut ambas);
    assert_eq!(rechaza(&ambas), PackageErrorCode::InvalidField);
}

#[test]
fn formatos_invalidos_se_rechazan_aunque_el_paquete_este_resellado() {
    let base = json_of(&build(completo()).unwrap());
    let malos: Vec<(&str, Mutacion)> = vec![
        ("commit no hex", Box::new(|v| v["revision"]["head_commit"] = json!("ZZZZZZZZ"))),
        ("commit en mayúsculas", Box::new(|v| v["revision"]["head_tree"] = json!("ABCDEF0123456789ABCDEF0123456789ABCDEF01"))),
        ("sha256 corto", Box::new(|v| v["revision"]["diff_sha256"] = json!("abc"))),
        ("ruta absoluta", Box::new(|v| v["revision"]["files"][0]["path"] = json!("/etc/passwd"))),
        ("ruta con unidad", Box::new(|v| v["revision"]["files"][0]["path"] = json!("C:\\Users\\ana\\x.rs"))),
        ("ruta que sube", Box::new(|v| v["revision"]["files"][0]["path"] = json!("../fuera.rs"))),
        ("huella que es un id", Box::new(|v| v["source"]["host"] = json!("DESKTOP-ABC123"))),
        ("proveedor en mayúsculas", Box::new(|v| v["source"]["provider"] = json!("Claude"))),
        ("campo anidado desconocido", Box::new(|v| v["source"]["extra"] = json!("x"))),
        ("adjunto con id que no es su hash", Box::new(|v| v["attachments"][0]["id"] = json!("att:0000000000000000"))),
        ("adjunto omitido por otro motivo", Box::new(|v| v["attachments"][0]["omitted"] = json!("porque_si"))),
        ("referencia a un adjunto que no existe", Box::new(|v| v["uncommitted"]["staged_patch"] = json!("att:ffffffffffffffff"))),
        ("número no entero", Box::new(|v| v["test_results"]["passed"] = json!(1.5))),
        ("objetivo vacío", Box::new(|v| v["objective"] = json!("   "))),
        ("artifact commit que no es sha", Box::new(|v| v["artifacts"][0]["uri"] = json!("no-es-un-sha"))),
        ("unidad de truncado desconocida", Box::new(|v| v["truncated"] = json!([{ "field": "objective", "original": 9, "unit": "bytes" }]))),
        ("created_at negativo", Box::new(|v| v["created_at_ms"] = json!(-1))),
    ];
    for (nombre, f) in malos {
        let mut v = base.clone();
        f(&mut v);
        reseal(&mut v);
        let e = parse(&v.to_string()).expect_err(nombre);
        assert!(matches!(e.code, PackageErrorCode::InvalidField | PackageErrorCode::TooLarge), "{nombre}: {e}");
    }
}

#[test]
fn un_campo_opcional_desconocido_se_conserva_y_cuenta_para_la_identidad() {
    let mut v = json_of(&build(nuevo()).unwrap());
    v["nota_futura"] = json!({ "a": [1, 2, "tres"] });
    reseal(&mut v);
    let p = parse(&v.to_string()).unwrap();
    assert_eq!(p.extra["nota_futura"]["a"][2], "tres");
    assert!(p.to_json().contains("nota_futura"), "se vuelve a emitir tal cual");
    assert_eq!(parse(p.to_json()).unwrap().id(), p.id());
    // Sin resellar es una alteración como cualquier otra.
    v["nota_futura"] = json!(1);
    assert_eq!(rechaza(&v), PackageErrorCode::IdMismatch);
}

// ── Redacción ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Las 13 formas de secreto del experimento de LXO-132. La red anterior veía 6.
const SECRETOS: [(&str, &str); 13] = [
    ("clave Anthropic", "sk-ant-api03-xxxxxxxxxxxxxxxxxxxx"),
    ("token GitHub", "ghp_abcdefghijklmnopqrstuvwx"),
    ("AWS access key", "AKIAABCDEFGHIJKLMNOP"),
    ("password=", "password=hunter2"),
    ("Bearer", "Authorization: Bearer abc.def.ghi"),
    ("clave privada", "-----BEGIN PRIVATE KEY-----"),
    ("JWT", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789"),
    ("URL con credenciales", "postgres://admin:S3cr3tPass@db.internal:5432/app"),
    ("token npm", "npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"),
    ("token Google OAuth", "ya29.a0AfH6SMBx1234567890abcdefghij"),
    ("AWS secret key", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
    ("Stripe", "sk_live_abcdefghijklmnop"),
    ("variable .env", "STRIPE_SECRET_VALUE=rk_live_51abcdefghijklmno"),
];

/// Lo que NO es un secreto y no debe tocarse.
const NO_SECRETOS: [&str; 10] = [
    "0123456789abcdef0123456789abcdef01234567",
    "6f1c2a9e-0b7d-4d1e-9a51-3c2f8e7d9b10",
    "/home/ana/.codex/sessions/rollout-t3.jsonl",
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "token de acceso (texto)",
    "let token = get(&endpoint.token_env);",
    "NOMBRE_TOKEN=$VALOR_DEL_ENTORNO",
    "API_TOKEN=<tu-token-aqui>",
    "MAX_TOKENS=4096",
    "https://github.com/LIXBON-FOUNDER/Lixbon/pull/168",
];

#[test]
fn el_detector_ampliado_ve_los_13_secretos_y_ningun_falso_positivo() {
    for (nombre, s) in SECRETOS {
        assert!(contains_secret(s), "{nombre} debe detectarse: {s}");
        let (red, n) = redact(s);
        assert!(n > 0 && !red.contains(&s[s.len().saturating_sub(12)..]), "{nombre} debe redactarse: {red}");
    }
    for s in NO_SECRETOS {
        assert!(!contains_secret(s), "no es un secreto: {s}");
        assert_eq!(redact(s), (s.to_string(), 0), "{s}");
    }
}

#[test]
fn una_clave_privada_se_oculta_con_su_cuerpo_no_solo_con_la_cabecera() {
    let pem = "-----BEGIN RSA PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj
abcdefghijklmnopqrstuvwxyz0123456789ABCD
-----END RSA PRIVATE KEY-----";
    let (red, n) = redact(&format!("antes
{pem}
después"));
    assert_eq!((red.as_str(), n), ("antes
[redactado]
después", 1));
    // Un bloque sin pie (cortado) se oculta hasta el final: no se deja nada del cuerpo.
    assert_eq!(redact("x
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBg").0, "x
[redactado]");
}

#[test]
fn centinelas_ningun_secreto_sale_en_ningun_campo_de_texto() {
    for (nombre, s) in SECRETOS {
        let b = build(NewPackage {
            objective: format!("Objetivo con {s} dentro."),
            decisions: vec![format!("Decisión: {s}")],
            constraints: vec![format!("Restricción {s}")],
            thread_summary: Some(format!("Resumen {s}")),
            test_results: Some(TestResults { command: format!("curl {s}"), passed: Some(1), failed: None, ignored: None }),
            revision: RevisionInput::Absent(format!("sin repo; ver {s}")),
            uncommitted: None,
            ..nuevo()
        })
        .unwrap();
        let json = b.package.to_json();
        let parte_secreta = s.rsplit([' ', '=']).next().unwrap();
        assert!(!json.contains(parte_secreta), "{nombre}: el secreto salió en el paquete");
        assert!(json.contains(REDACTED) && b.package.redactions >= 5, "{nombre}: debía contar las redacciones ({})", b.package.redactions);
        // Y el paquete resultante es válido: llega ya redactado.
        parse(json).unwrap_or_else(|e| panic!("{nombre}: {e}"));
    }
}

#[test]
fn un_secreto_en_un_identificador_no_se_redacta_se_rechaza() {
    let e = build(NewPackage { task_id: "sk-ant-api03-xxxxxxxxxxxxxxxxxxxx".into(), ..nuevo() }).unwrap_err();
    assert_eq!(e.code, PackageErrorCode::SecretDetected);
    let mut r = revision();
    r.files[0].path = "src/npm_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789.rs".into();
    assert_eq!(build(NewPackage { revision: RevisionInput::Git(r), ..nuevo() }).unwrap_err().code, PackageErrorCode::SecretDetected);
    let art = Artifact { kind: ArtifactKind::PullRequest, uri: "https://usuario:clave@github.com/x/y/pull/1".into(), sha256: None, bytes: None };
    assert!(build(NewPackage { artifacts: vec![art], ..nuevo() }).is_err());
}

#[test]
fn un_paquete_con_un_secreto_que_llega_resellado_no_se_acepta() {
    for (nombre, s) in SECRETOS {
        let mut v = json_of(&build(nuevo()).unwrap());
        v["decisions"][0] = json!(format!("Usar {s}"));
        reseal(&mut v);
        assert_eq!(rechaza(&v), PackageErrorCode::SecretDetected, "{nombre}");
    }
}

#[test]
fn el_secreto_partido_por_el_tope_no_deja_un_prefijo() {
    let relleno = "a ".repeat(MAX_OBJECTIVE_CHARS / 2 - 2);
    let secreto = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let p = build(NewPackage { objective: format!("{relleno}{secreto}"), ..nuevo() }).unwrap().package;
    assert!(!p.objective.contains("sk-ant"), "primero se redacta y después se corta");
    assert!(p.truncated.is_empty() || p.objective.chars().count() <= MAX_OBJECTIVE_CHARS);
}

// ── Límites y truncado ──────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn el_truncado_es_explicito_nunca_en_silencio() {
    let p = build(NewPackage {
        objective: "o".repeat(5000),
        decisions: (0..100).map(|i| format!("decisión {i}")).collect(),
        constraints: vec!["c".repeat(900)],
        thread_summary: Some("t".repeat(3000)),
        ..nuevo()
    })
    .unwrap()
    .package;
    assert_eq!(p.objective.chars().count(), MAX_OBJECTIVE_CHARS);
    assert_eq!(p.decisions.len(), MAX_LIST_ITEMS);
    assert_eq!(p.constraints[0].chars().count(), MAX_ITEM_CHARS);
    assert_eq!(p.thread_summary.as_deref().unwrap().chars().count(), MAX_THREAD_SUMMARY_CHARS);
    let marca = |campo: &str| p.truncated.iter().find(|t| t.field == campo).map(|t| (t.original, t.unit.clone()));
    assert_eq!(marca("objective"), Some((5000, "chars".into())));
    assert_eq!(marca("decisions"), Some((100, "items".into())));
    assert_eq!(marca("constraints"), Some((900, "chars".into())));
    assert_eq!(marca("thread_summary"), Some((3000, "chars".into())));
    parse(p.to_json()).unwrap();
}

#[test]
fn una_lista_enorme_de_archivos_se_recorta_hasta_caber_y_consta() {
    let mut r = revision();
    r.files = (0..2000).map(|i| FileChange { path: format!("apps/desktop/src-tauri/src/orch/modulo_{i:04}/{}.rs", "x".repeat(150)), added: Some(1), deleted: Some(0) }).collect();
    let p = build(NewPackage { revision: RevisionInput::Git(r), ..nuevo() }).unwrap().package;
    let n = p.revision.as_ref().unwrap().files.len();
    assert!(n > 0 && n <= MAX_FILES, "{n}");
    assert!(p.to_json().len() <= MAX_PACKAGE_BYTES, "{}", p.to_json().len());
    let t = p.truncated.iter().find(|t| t.field == "revision.files").expect("consta el recorte");
    assert_eq!((t.original, t.unit.as_str()), (2000, "items"));
    parse(p.to_json()).unwrap();
}

#[test]
fn lo_que_ocupa_un_paquete_normal_deja_mucho_margen() {
    let b = build(completo()).unwrap();
    assert!(b.package.to_json().len() < 4096, "el completo del experimento pesaba 3,7 KiB: {}", b.package.to_json().len());
    assert!(b.package.truncated.is_empty() && b.package.redactions == 0);
}

#[test]
fn un_documento_que_se_pasa_de_tamano_o_de_listas_no_se_acepta() {
    let mut v = json_of(&build(nuevo()).unwrap());
    v["decisions"] = json!((0..33).map(|i| format!("d{i}")).collect::<Vec<_>>());
    reseal(&mut v);
    assert_eq!(rechaza(&v), PackageErrorCode::TooLarge);
}

// ── Adjuntos ────────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn los_adjuntos_viajan_por_hash_y_se_verifican() {
    let b = build(completo()).unwrap();
    let a = &b.package.attachments;
    assert_eq!(a.len(), 4, "bundle + parche preparado + parche no preparado + 1 archivo sin seguimiento, y nada más");
    assert!(a.iter().all(|x| x.id == format!("att:{}", &x.sha256[..16])));
    b.package.verify_attachments(&b.blobs).unwrap();

    let bundle = a.iter().find(|x| x.kind == AttachmentKind::GitBundle).unwrap();
    assert!(!bundle.scanned, "un bundle va comprimido y no se escanea: consta");
    assert!(a.iter().filter(|x| x.kind != AttachmentKind::GitBundle).all(|x| x.scanned));

    let u = b.package.uncommitted.as_ref().unwrap();
    assert_eq!(u.untracked[0].sha256, sha256_hex(b"Siguiente paso: la hora de reinicio.\n"));
    assert!(b.blobs.contains_key(u.staged_patch.as_ref().unwrap()));
}

#[test]
fn un_adjunto_manipulado_ausente_o_ajeno_no_pasa_la_verificacion() {
    let b = build(completo()).unwrap();
    let id = b.package.attachments[0].id.clone();

    let mut alterado = b.blobs.clone();
    alterado.get_mut(&id).unwrap().push(0);
    assert_eq!(b.package.verify_attachments(&alterado).unwrap_err().code, PackageErrorCode::AttachmentMismatch);

    let mut mismo_tamano = b.blobs.clone();
    mismo_tamano.get_mut(&id).unwrap()[0] ^= 0xff;
    assert_eq!(b.package.verify_attachments(&mismo_tamano).unwrap_err().code, PackageErrorCode::AttachmentMismatch, "mismo tamaño, otro contenido");

    let mut falta = b.blobs.clone();
    falta.remove(&id);
    assert_eq!(b.package.verify_attachments(&falta).unwrap_err().code, PackageErrorCode::AttachmentMismatch);

    let mut ajeno = b.blobs.clone();
    ajeno.insert("att:ffffffffffffffff".into(), vec![1]);
    assert_eq!(b.package.verify_attachments(&ajeno).unwrap_err().code, PackageErrorCode::AttachmentMismatch);
}

#[test]
fn un_adjunto_de_texto_con_secreto_no_viaja_se_omite() {
    let con_secreto = format!("diff --git a/t b/t\n+const K: &str = \"{}\";\n", SECRETOS[0].1);
    let b = build(NewPackage {
        uncommitted: Some(UncommittedInput { staged_patch: Some(con_secreto.clone().into_bytes()), unstaged_patch: Some(b"+limpio\n".to_vec()), untracked: vec![] }),
        ..nuevo()
    })
    .unwrap();
    let u = b.package.uncommitted.as_ref().unwrap();
    let omitido = b.package.attachments.iter().find(|a| &a.id == u.staged_patch.as_ref().unwrap()).unwrap();
    assert_eq!(omitido.omitted.as_deref(), Some("secret_detected"));
    assert_eq!((omitido.sha256.as_str(), omitido.bytes), (sha256_hex(con_secreto.as_bytes()).as_str(), con_secreto.len() as u64), "consta qué falta");
    assert!(!b.blobs.contains_key(&omitido.id), "los bytes no salen");
    assert!(!b.package.to_json().contains("sk-ant"), "ni el paquete ni los blobs lo llevan");
    assert!(b.blobs.values().all(|v| !String::from_utf8_lossy(v).contains("sk-ant")));
    b.package.verify_attachments(&b.blobs).unwrap();
    // Si alguien lo manda igualmente, se rechaza: no debía viajar.
    let mut ajenos = b.blobs.clone();
    ajenos.insert(omitido.id.clone(), con_secreto.into_bytes());
    assert_eq!(b.package.verify_attachments(&ajenos).unwrap_err().code, PackageErrorCode::AttachmentMismatch);
}

#[test]
fn los_topes_de_adjuntos() {
    let enorme = build(NewPackage { bundle: Some(vec![1u8; MAX_ATTACHMENT_BYTES + 1]), ..nuevo() });
    assert_eq!(enorme.err().unwrap().code, PackageErrorCode::TooLarge);
    // Distintos y de 1 MiB cada uno: al noveno se pasa de 8 MiB.
    let muchos = UncommittedInput {
        staged_patch: None,
        unstaged_patch: None,
        untracked: (0..9).map(|i| UntrackedInput { path: format!("f{i}.bin"), data: vec![i as u8 + 1; MAX_ATTACHMENT_BYTES] }).collect(),
    };
    let e = build(NewPackage { uncommitted: Some(muchos), ..nuevo() });
    assert_eq!(e.err().unwrap().code, PackageErrorCode::TooLarge);
}

#[test]
fn el_mismo_contenido_es_un_solo_adjunto() {
    let dos = UncommittedInput {
        staged_patch: Some(b"+igual\n".to_vec()),
        unstaged_patch: Some(b"+igual\n".to_vec()),
        untracked: vec![UntrackedInput { path: "a.txt".into(), data: b"+igual\n".to_vec() }],
    };
    let b = build(NewPackage { uncommitted: Some(dos), ..nuevo() }).unwrap();
    assert_eq!(b.package.attachments.len(), 1);
    b.package.verify_attachments(&b.blobs).unwrap();
}

// ── Export / import entre adapters falsos ───────────────────────────────────────────────────────────────────────────────

/// Un adapter que apunta los mensajes con que arranca, para ver qué recibe el siguiente Attempt.
struct Receptor {
    id: String,
    prompts: Mutex<Vec<String>>,
}

impl Receptor {
    fn new(id: &str) -> Arc<Receptor> {
        Arc::new(Receptor { id: id.into(), prompts: Mutex::new(vec![]) })
    }
}

impl ProviderAdapter for Receptor {
    fn id(&self) -> &str {
        &self.id
    }

    fn probe(&self) -> ProbeResult {
        ProbeResult::ready(None, CapabilityMatrix::all_available())
    }

    fn start(&self, req: StartRequest, _cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        self.prompts.lock().unwrap().push(req.prompt);
        Ok(RunHandle { attempt_id: req.attempt_id, adapter: self.id.clone(), seq: 1 })
    }

    fn events(&self, _run: &RunHandle, _cancel: &CancelToken, _sink: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        Ok(RunOutcome::Completed { summary: None })
    }
}

/// Lo que cruza entre dos hosts: el JSON del paquete y los bytes de sus adjuntos.
struct Envio {
    json: String,
    blobs: BTreeMap<String, Vec<u8>>,
}

fn exporta(b: &Built) -> Envio {
    Envio { json: b.package.to_json().to_string(), blobs: b.blobs.clone() }
}

/// El lado receptor: acepta el envío y arranca el siguiente Attempt solo si es válido.
fn importa_y_arranca(e: &Envio, reg: &AdapterRegistry, destino: &str) -> Result<ContextPackage, PackageError> {
    let p = parse(&e.json)?;
    p.verify_attachments(&e.blobs)?;
    let g = reg.gated(destino).expect("el destino está registrado");
    let req = StartRequest { attempt_id: "a-2".into(), worktree: PathBuf::from("wt"), prompt: p.continuation_prompt(), profile: "proponer".into(), model: None, effort: None };
    g.start(req, &CancelToken::new()).expect("arranca");
    Ok(p)
}

fn registro(destino: &Arc<Receptor>) -> AdapterRegistry {
    let mut reg = AdapterRegistry::new();
    reg.register(Arc::clone(destino) as Arc<dyn ProviderAdapter>).unwrap();
    reg
}

#[test]
fn un_paquete_cruza_de_un_adapter_a_otro_y_el_destino_lo_recibe_entero() {
    let origen = completo();
    let b = build(NewPackage { provider: "claude".into(), ..origen }).unwrap();
    let destino = Receptor::new("codex");
    let p = importa_y_arranca(&exporta(&b), &registro(&destino), "codex").unwrap();

    let prompts = destino.prompts.lock().unwrap();
    assert_eq!(prompts.len(), 1);
    assert!(prompts[0].contains(p.id()) && prompts[0].contains("Normalizar el uso"));
    assert!(prompts[0].contains("head_tree") && prompts[0].contains("`claude`"), "el destino sabe de quién viene y cómo verificar");
    assert!(!prompts[0].contains("DESKTOP-ABC123") && !prompts[0].contains("6f1c2a9e"), "ni el host ni la sesión del origen");
    assert_eq!(p.source.provider, "claude", "el origen no cambia al cruzar");
    assert_eq!(p.receipt("codex", T0 + 1).package_id, b.package.id());
}

#[test]
fn un_paquete_invalido_no_inicia_ningun_attempt() {
    let b = build(completo()).unwrap();
    let casos: Vec<(&str, Envio)> = vec![
        ("alterado", Envio { json: b.package.to_json().replace("Normalizar", "Destruir"), blobs: b.blobs.clone() }),
        ("versión desconocida", Envio { json: b.package.to_json().replace("\"schema_version\":1", "\"schema_version\":2"), blobs: b.blobs.clone() }),
        ("adjunto alterado", {
            let mut e = exporta(&b);
            e.blobs.values_mut().next().unwrap().push(1);
            e
        }),
        ("adjunto ausente", {
            let mut e = exporta(&b);
            let k = e.blobs.keys().next().unwrap().clone();
            e.blobs.remove(&k);
            e
        }),
        ("basura", Envio { json: "{".into(), blobs: BTreeMap::new() }),
    ];
    for (nombre, e) in casos {
        let destino = Receptor::new("codex");
        assert!(importa_y_arranca(&e, &registro(&destino), "codex").is_err(), "{nombre}");
        assert!(destino.prompts.lock().unwrap().is_empty(), "{nombre}: el destino no debió arrancar nada");
    }
}

// ── Fixtures publicadas ─────────────────────────────────────────────────────────────────────────────────────────────────

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/core/fixtures/context-package/v1")
}

/// (archivo, esperado): `ok` o el código del error. Generados desde `completo()`; los inválidos son manipulaciones resellables.
fn casos() -> Vec<(&'static str, &'static str, String)> {
    let base = build(completo()).unwrap();
    let minimo = build(NewPackage { revision: RevisionInput::Absent("el Attempt no tiene repositorio".into()), uncommitted: None, bundle: None, decisions: vec![], constraints: vec![], thread_summary: None, test_results: None, artifacts: vec![], ..nuevo() }).unwrap();
    let v = json_of(&base);
    let con = |f: &dyn Fn(&mut Value), resellar: bool| {
        let mut x = v.clone();
        f(&mut x);
        if resellar {
            reseal(&mut x);
        }
        x.to_string()
    };
    let mut extra = v.clone();
    extra["nota_futura"] = json!({ "a": 1 });
    reseal(&mut extra);
    vec![
        ("valido-minimo.json", "ok", minimo.package.to_json().to_string()),
        ("valido-completo.json", "ok", base.package.to_json().to_string()),
        ("valido-con-campo-extra.json", "ok", extra.to_string()),
        ("invalido-version-desconocida.json", "unsupported_version", con(&|x| x["schema_version"] = json!(2), false)),
        ("invalido-falta-objective.json", "missing_field", con(&|x| drop(x.as_object_mut().unwrap().remove("objective")), false)),
        ("invalido-alterado.json", "id_mismatch", con(&|x| x["objective"] = json!("otro"), false)),
        ("invalido-origen-reescrito.json", "id_mismatch", con(&|x| x["source"]["provider"] = json!("codex"), false)),
        ("invalido-revision-sin-motivo.json", "invalid_field", con(&|x| x["revision"] = Value::Null, true)),
        ("invalido-campo-anidado-desconocido.json", "invalid_field", con(&|x| x["source"]["nombre"] = json!("x"), true)),
        ("invalido-ruta-absoluta.json", "invalid_field", con(&|x| x["revision"]["files"][0]["path"] = json!("/etc/passwd"), true)),
        ("invalido-adjunto-no-declarado.json", "invalid_field", con(&|x| x["uncommitted"]["staged_patch"] = json!("att:ffffffffffffffff"), true)),
        ("invalido-numero-no-entero.json", "invalid_field", con(&|x| x["test_results"]["passed"] = json!(1.5), true)),
        ("invalido-secreto.json", "secret_detected", con(&|x| x["decisions"][0] = json!("Usar sk-ant-api03-xxxxxxxxxxxxxxxxxxxx"), true)),
        ("invalido-demasiadas-decisiones.json", "too_large", con(&|x| x["decisions"] = json!((0..33).map(|i| format!("d{i}")).collect::<Vec<_>>()), true)),
        ("invalido-json.json", "invalid_json", "{\"schema_version\": 1,".to_string()),
    ]
}

#[test]
fn las_fixtures_publicadas_se_aceptan_o_se_rechazan_como_dicen() {
    let dir = fixtures_dir();
    let casos = casos();
    if std::env::var("LXO_WRITE_API_FIXTURES").is_ok() {
        std::fs::create_dir_all(&dir).unwrap();
        for (f, _, contenido) in &casos {
            std::fs::write(dir.join(f), format!("{contenido}\n")).unwrap();
        }
        let manifest: Vec<Value> = casos.iter().map(|(f, e, _)| json!({ "archivo": f, "esperado": e })).collect();
        std::fs::write(dir.join("casos.json"), serde_json::to_string_pretty(&manifest).unwrap() + "\n").unwrap();
    }
    let manifest: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(dir.join("casos.json")).expect("falta casos.json: LXO_WRITE_API_FIXTURES=1")).unwrap();
    assert_eq!(manifest.len(), casos.len());
    for c in manifest {
        let (archivo, esperado) = (c["archivo"].as_str().unwrap(), c["esperado"].as_str().unwrap());
        let texto = std::fs::read_to_string(dir.join(archivo)).unwrap_or_else(|_| panic!("falta {archivo}"));
        let r = parse(texto.trim_end());
        match esperado {
            "ok" => {
                let p = r.unwrap_or_else(|e| panic!("{archivo}: {e}"));
                assert_eq!(parse(p.to_json()).unwrap().id(), p.id(), "{archivo}");
            }
            code => assert_eq!(r.expect_err(archivo).code.code(), code, "{archivo}"),
        }
    }
}

/// Validación manual: cuántas líneas de un diff REAL marca el detector ampliado (el de LXO-132 marcaba 1 de 1996).
#[test]
#[ignore = "validación manual: lee el diff real de LXO-205 con git"]
fn real_diff_de_lxo_205_falsos_positivos_del_detector() {
    let salida = std::process::Command::new("git").args(["diff", "e73a74da", "b1cc12e3"]).output().expect("git");
    let diff = String::from_utf8_lossy(&salida.stdout);
    let marcadas: Vec<&str> = diff.lines().filter(|l| contains_secret(l)).collect();
    println!("{} líneas marcadas de {}", marcadas.len(), diff.lines().count());
    for l in &marcadas {
        println!("  {}", &l[..l.len().min(120)]);
    }
    assert!(!marcadas.is_empty() && marcadas.len() < 20);
}
