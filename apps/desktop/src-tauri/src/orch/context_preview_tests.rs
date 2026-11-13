//! LXO-136 · `context_package_preview`: la vista previa de un ContextPackage refleja exactamente el paquete, reutiliza la
//! verificación de `parse` (identidad y secretos), distingue completo, parcial, truncado, redactado e inválido, y no revela ni
//! devuelve el contenido de un paquete rechazado. Solo lectura y solo de una persona.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::attention_read_tests::{agente, core_listo, persona, rpc};
use super::context_package::{build, contains_secret, parse, Artifact, ArtifactKind, FileChange, NewPackage, Revision, RevisionInput, UncommittedInput, UntrackedInput};
use super::context_preview::preview;
use super::rpc::rpc_action_for_tests;
use crate::store::ClientAction;

const SHA: &str = "0123456789abcdef0123456789abcdef01234567";
const TREE: &str = "89abcdef0123456789abcdef0123456789abcdef";

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../docs/core/fixtures/context-package/v1")
}

fn api_fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../docs/core/fixtures/api")
}

fn leer(archivo: &str) -> String {
    std::fs::read_to_string(fixtures().join(archivo)).unwrap_or_else(|_| panic!("falta {archivo}")).trim_end().to_string()
}

fn nuevo() -> NewPackage {
    NewPackage {
        created_at_ms: 1_800_000_000_000,
        project_id: "p-lixbon".into(),
        task_id: "t-205".into(),
        attempt_id: "a-1".into(),
        provider: "claude".into(),
        provider_session: Some("6f1c2a9e-0b7d-4d1e-9a51-3c2f8e7d9b10".into()),
        host: "DESKTOP-ABC123".into(),
        objective: "Normalizar el uso de cada proveedor.".into(),
        decisions: vec!["Claude se consulta con `claude -p /usage`.".into()],
        constraints: vec!["Sin push.".into()],
        thread_summary: None,
        revision: RevisionInput::Git(Revision {
            base_commit: "e73a74da".into(),
            head_commit: SHA.into(),
            head_tree: TREE.into(),
            branch: Some("feat/x".into()),
            files: vec![FileChange { path: "docs/ADAPTERS.md".into(), added: Some(1), deleted: Some(0) }],
            diff_sha256: None,
            diff_bytes: None,
        }),
        uncommitted: None,
        test_results: None,
        artifacts: vec![Artifact { kind: ArtifactKind::Commit, uri: SHA.into(), sha256: None, bytes: None }],
        bundle: None,
    }
}

fn json_de(p: NewPackage) -> String {
    build(p).unwrap().package.to_json().to_string()
}

fn notas(v: &Value) -> Vec<&str> {
    v["summary"]["notes"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect()
}

// ── Reflejo exacto y verificación ───────────────────────────────────────────────────────────────────────────────────────

#[test]
fn un_paquete_valido_se_muestra_tal_cual_con_su_identidad_verificada() {
    let raw = leer("valido-completo.json");
    let v = preview(&raw);
    assert_eq!((v["v"].as_u64(), v["status"].as_str()), (Some(1), Some("valid")));
    // `package` ES el documento: lo mismo que parse produce y lo mismo que viajaría, sin recortar ni reinterpretar.
    let p = parse(&raw).unwrap();
    assert_eq!(v["package"], serde_json::to_value(&*p).unwrap());
    assert_eq!(v["package"], serde_json::from_str::<Value>(&raw).unwrap(), "el JSON publicado y la vista son el mismo documento");
    assert_eq!(v["package_id"], p.id());
    assert_eq!(v["verification"], json!({ "identity": "verified", "secrets": "none_found", "attachments": "not_checked" }));
    assert_eq!(v["summary"]["serialized_bytes"], p.to_json().len());
}

#[test]
fn el_resumen_cuenta_lo_que_trae_el_paquete_y_dice_lo_que_no_se_pudo_comprobar() {
    let v = preview(&leer("valido-completo.json"));
    let c = &v["summary"]["counts"];
    assert_eq!(
        (c["decisions"].as_u64(), c["constraints"].as_u64(), c["files"].as_u64(), c["untracked"].as_u64(), c["artifacts"].as_u64(), c["attachments"].as_u64()),
        (Some(2), Some(1), Some(2), Some(1), Some(1), Some(4))
    );
    assert_eq!(c["attachments_bytes"], 4096 + 30 + 33 + 37);
    // El `git bundle` va comprimido: no se escaneó. Lo dice, no lo da por limpio.
    assert_eq!(c["attachments_not_scanned"], 1);
    assert_eq!(notas(&v), ["attachment_not_scanned"]);
    // No falta nada que el receptor necesite: completo.
    assert_eq!(v["summary"]["completeness"], "complete");
}

#[test]
fn completo_parcial_truncado_y_redactado_se_distinguen() {
    // Sin repositorio: parcial y lo dice.
    let sin_repo = preview(&json_de(NewPackage { revision: RevisionInput::Absent("el Attempt no tiene repositorio".into()), ..nuevo() }));
    assert_eq!((sin_repo["summary"]["completeness"].as_str(), notas(&sin_repo)), (Some("partial"), vec!["revision_absent"]));
    assert_eq!(sin_repo["package"]["revision"], Value::Null);
    assert_eq!(sin_repo["package"]["revision_absent_reason"], "el Attempt no tiene repositorio");

    // Truncado: se muestra EXPLÍCITO, con el original; parcial.
    let largo = "x ".repeat(3000);
    let truncado = preview(&json_de(NewPackage { objective: largo.clone(), ..nuevo() }));
    assert_eq!(truncado["summary"]["completeness"], "partial");
    assert!(notas(&truncado).contains(&"truncated"), "{:?}", notas(&truncado));
    let t = &truncado["package"]["truncated"][0];
    assert_eq!((t["field"].as_str(), t["unit"].as_str(), t["original"].as_u64()), (Some("objective"), Some("chars"), Some(largo.chars().count() as u64)));
    assert_eq!(truncado["summary"]["counts"]["truncated_fields"], 1);

    // Redactado: el valor ya llega como `[redactado]` y se queda así; no hace al paquete parcial.
    let redactado = preview(&json_de(NewPackage { objective: "usa el token ghp_abcdefghijklmnopqrstuvwxyz0123456789 para entrar".into(), ..nuevo() }));
    assert_eq!(redactado["status"], "valid");
    assert!(notas(&redactado).contains(&"redacted"));
    assert_eq!(redactado["summary"]["completeness"], "complete");
    assert!(redactado["package"]["objective"].as_str().unwrap().contains("[redactado]"));
    assert!(!redactado.to_string().contains("ghp_abcdef"), "el secreto no está en la respuesta");
    assert!(redactado["summary"]["counts"]["redactions"].as_u64().unwrap() >= 1);

    // Adjunto omitido por contener un secreto: parcial.
    let con_secreto = preview(&json_de(NewPackage {
        uncommitted: Some(UncommittedInput { staged_patch: Some(b"+ token = ghp_abcdefghijklmnopqrstuvwxyz0123456789\n".to_vec()), unstaged_patch: None, untracked: vec![] }),
        ..nuevo()
    }));
    assert_eq!(con_secreto["summary"]["completeness"], "partial");
    assert!(notas(&con_secreto).contains(&"attachment_omitted"));
    assert_eq!(con_secreto["summary"]["counts"]["attachments_omitted"], 1);
    assert!(!con_secreto.to_string().contains("ghp_abcdef"));
}

// ── Inválido ────────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn cada_fixture_publicada_se_acepta_o_se_rechaza_como_dice_su_manifiesto() {
    let manifest: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(fixtures().join("casos.json")).unwrap()).unwrap();
    assert!(manifest.len() >= 15);
    for c in manifest {
        let (archivo, esperado) = (c["archivo"].as_str().unwrap(), c["esperado"].as_str().unwrap());
        let v = preview(&leer(archivo));
        if esperado == "ok" {
            assert_eq!(v["status"], "valid", "{archivo}: {v}");
        } else {
            assert_eq!((v["status"].as_str(), v["error"]["code"].as_str()), (Some("invalid"), Some(esperado)), "{archivo}: {v}");
            // Un paquete rechazado NO muestra su contenido: ni `package` ni `summary`.
            assert!(v.get("package").is_none() && v.get("summary").is_none() && v.get("package_id").is_none(), "{archivo}: {v}");
        }
        // Y nunca una credencial en la respuesta, valga o no el paquete.
        assert!(!contains_secret(&v.to_string()), "{archivo}: la respuesta lleva algo con forma de credencial");
    }
}

#[test]
fn un_paquete_alterado_hace_visible_la_diferencia_de_identidad() {
    let v = preview(&leer("invalido-alterado.json"));
    assert_eq!((v["status"].as_str(), v["error"]["code"].as_str()), (Some("invalid"), Some("id_mismatch")));
    let (declarado, recalculado) = (v["declared_id"].as_str().unwrap(), v["recomputed_id"].as_str().unwrap());
    assert!(declarado.starts_with("sha256:") && recalculado.starts_with("sha256:"));
    assert_ne!(declarado, recalculado, "el hash que dice no es el de su contenido");
    // Alterar el origen también cambia la identidad: el receptor no puede reescribir de dónde sale.
    assert_eq!(preview(&leer("invalido-origen-reescrito.json"))["error"]["code"], "id_mismatch");
}

#[test]
fn una_entrada_que_no_es_un_paquete_se_rechaza_sin_ecos_ni_panico() {
    for raw in ["", "   ", "no es json", "[]", "null", "{}", "{\"schema_version\": \"uno\"}", &"x".repeat(200_000)] {
        let v = preview(raw);
        assert_eq!(v["status"], "invalid", "{:.30}", raw);
        assert!(v["error"]["code"].is_string());
        assert!(v["error"]["message"].as_str().unwrap().chars().count() <= 301);
        assert!(v.get("package").is_none());
    }
    // Un campo desconocido con forma de secreto en su NOMBRE no vuelve en el mensaje.
    let raw = json_de(nuevo()).replacen('{', "{\"ghp_abcdefghijklmnopqrstuvwxyz0123456789\":1,", 1);
    let v = preview(&raw);
    assert_eq!(v["status"], "invalid");
    assert!(!v.to_string().contains("ghp_abcdef"), "la respuesta lleva el secreto");
}

#[test]
fn un_adjunto_omitido_no_cuenta_como_sin_escanear_ni_un_mensaje_largo_se_devuelve_entero() {
    // Un adjunto omitido no viaja: no hay nada que escanear. Se arma con la identidad recalculada para que `parse` lo acepte.
    let con_id = |editar: &dyn Fn(&mut Value)| {
        let mut v: Value = serde_json::from_str(&leer("valido-completo.json")).unwrap();
        editar(&mut v);
        v["package_id"] = json!(super::context_package::package_id_of(&v));
        serde_json::to_string(&v).unwrap()
    };
    let raw = con_id(&|v| {
        v["attachments"][0]["omitted"] = json!("secret_detected"); // el git bundle, que era el único sin escanear
    });
    let r = preview(&raw);
    assert_eq!(r["status"], "valid", "estado inesperado de context_package_preview");
    assert_eq!(r["summary"]["counts"]["attachments_omitted"], 1);
    assert_eq!(r["summary"]["counts"]["attachments_not_scanned"], 0, "un adjunto omitido no viaja: no cuenta como sin escanear");
    assert_eq!(notas(&r), ["attachment_omitted"]);
    assert_eq!(r["summary"]["completeness"], "partial");

    // Un mensaje de rechazo largo (aquí, un campo desconocido de 600 caracteres dentro de `source`, donde v1 no admite extras) no
    // vuelve entero. (Uno de primer nivel SÍ es válido: v1 conserva los campos opcionales de una versión posterior.)
    let largo = preview(&con_id(&|v| {
        v["source"][&"c".repeat(600)] = json!(1);
    }));
    assert_eq!(largo["status"], "invalid", "{largo}");
    let m = largo["error"]["message"].as_str().unwrap();
    assert!(m.chars().count() <= 301 && m.ends_with('…'), "{}", m.chars().count());
}

// ── La query ────────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn la_query_es_de_una_persona_de_solo_lectura_y_valida_sus_argumentos() {
    assert_eq!(rpc_action_for_tests("context_package_preview"), ClientAction::Read);
    let (_l, _data, _core_dir, core) = core_listo();
    let me = persona(&core, "person-cp", "install-person-cp", "person-cp-secret-0123456789abcdef");
    let raw = leer("valido-minimo.json");

    let v = rpc(&core, &me, "context_package_preview", json!({ "package": raw })).unwrap();
    assert_eq!(v["status"], "valid");
    // Un paquete inválido es una RESPUESTA (para mostrarlo), no un error de la petición.
    let malo = rpc(&core, &me, "context_package_preview", json!({ "package": "no es json" })).unwrap();
    assert_eq!(malo["status"], "invalid");

    for (args, contiene) in [
        (json!({}), "package"),
        (json!({ "package": 3 }), "package"),
        (json!({ "package": raw, "x": 1 }), "parámetro desconocido"),
        (json!("texto"), "objeto"),
        (Value::Null, "objeto"),
        (json!({ "package": "x".repeat(140_000) }), "pesa más"),
    ] {
        let e = rpc(&core, &me, "context_package_preview", args).unwrap_err();
        assert!(e.contains("context_preview_invalid_request") && e.contains(contiene), "{e}");
    }

    // Un agente no la lee: el paquete lleva el objetivo y las decisiones del trabajo.
    let ag = agente(&core, "t-agente", "install-agent-cp", "agent-cp-secret-0123456789abcdef");
    let e = rpc(&core, &ag, "context_package_preview", json!({ "package": raw })).unwrap_err();
    assert!(e.contains("context_preview_auth_required"), "{e}");
}

#[test]
fn un_paquete_en_el_tope_de_tamano_se_previsualiza_rapido() {
    let files: Vec<FileChange> = (0..500).map(|i| FileChange { path: format!("src/modulo{i}/archivo.rs"), added: Some(i), deleted: Some(1) }).collect();
    let mut p = nuevo();
    p.revision = RevisionInput::Git(Revision { base_commit: "e73a74da".into(), head_commit: SHA.into(), head_tree: TREE.into(), branch: None, files, diff_sha256: None, diff_bytes: None });
    p.uncommitted = Some(UncommittedInput {
        staged_patch: None,
        unstaged_patch: None,
        untracked: (0..100).map(|i| UntrackedInput { path: format!("nuevo/{i}.md"), data: format!("contenido {i}\n").into_bytes() }).collect(),
    });
    let raw = json_de(p);
    let t = std::time::Instant::now();
    let v = preview(&raw);
    // Aislada tarda decenas de ms; con la suite entera en paralelo se estira, así que el tope es holgado: solo atrapa un coste desproporcionado.
    assert!(t.elapsed() < std::time::Duration::from_secs(5), "{:?}", t.elapsed());
    assert_eq!(v["status"], "valid");
    assert_eq!(v["summary"]["counts"]["files"], 500);
    assert_eq!(v["summary"]["counts"]["untracked"], 100);
    assert!(raw.len() < 64 * 1024, "{}", raw.len());
}

// ── Contrato publicado ──────────────────────────────────────────────────────────────────────────────────────────────────

/// La fixture del contrato (`docs/core/fixtures/api/`): `LXO_WRITE_API_FIXTURES=1` la regenera; revísala a mano.
#[test]
fn las_respuestas_de_ejemplo_coinciden_con_las_fixtures_versionadas() {
    let casos = [
        ("context_package_preview.v1.json", preview(&leer("valido-completo.json"))),
        ("context_package_preview_invalid.v1.json", preview(&leer("invalido-alterado.json"))),
    ];
    for (archivo, v) in casos {
        let esperado = serde_json::to_string_pretty(&v).unwrap() + "\n";
        let ruta = api_fixtures().join(archivo);
        if std::env::var("LXO_WRITE_API_FIXTURES").is_ok() {
            std::fs::write(&ruta, &esperado).unwrap();
        }
        let actual = std::fs::read_to_string(&ruta).unwrap_or_else(|_| panic!("falta {archivo}: LXO_WRITE_API_FIXTURES=1")).replace("\r\n", "\n");
        assert_eq!(actual, esperado.replace("\r\n", "\n"), "{archivo} no coincide: regenerar con LXO_WRITE_API_FIXTURES=1 y revisar");
    }
}

/// LXO-138 · `lxo context show` y `lxo context validate` con el binario real, como persona, contra el HTTP del Core: las 15 fixtures
/// publicadas se aceptan o se rechazan como dice su manifiesto, `show --json` es la vista del propio Core, un paquete rechazado sale con
/// 7 sin contenido ni el secreto, y los límites del archivo, el agente y el Core cerrado dan sus códigos. Requiere `LXO_BIN`; usa el
/// almacén seguro real.
#[test]
#[ignore = "requiere un binario lxo real (LXO_BIN) y el almacén seguro del sistema; ver apps/desktop/README.md"]
fn lxo_bin_e2e_context_person_real_store() {
    use super::projects_overview_tests::RealStoreServer;
    let (cleanup, data, _core_dir, core) = core_listo();
    let server = RealStoreServer::start(&core, &data, &cleanup.0);
    let me = persona(&core, "ana", "install-lxo-context-e2e", "ana-lxo-context-e2e-secret-0123456789");
    let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    let secreto = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxx";
    let manifest: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(fixtures().join("casos.json")).unwrap()).unwrap();
    assert!(manifest.len() >= 15);

    for c in &manifest {
        let (archivo, esperado) = (c["archivo"].as_str().unwrap(), c["esperado"].as_str().unwrap());
        let ruta = fixtures().join(archivo);
        let ruta = ruta.to_str().unwrap();
        let core_view = rpc(&core, &me, "context_package_preview", json!({ "package": leer(archivo) })).unwrap();
        let validate = server.lxo(&["context", "validate", ruta, "--json"], None);
        let show = server.lxo(&["context", "show", ruta, "--json"], None);
        let (v_out, s_out) = (text(&validate.stdout), text(&show.stdout));
        // Nunca el secreto por stderr, ni por stdout si el paquete se rechaza.
        for out in [&validate, &show] {
            assert!(!text(&out.stderr).contains(secreto), "{archivo}: el secreto salió por stderr");
            if esperado != "ok" {
                assert!(!text(&out.stdout).contains(secreto), "{archivo}: el secreto salió por stdout");
            }
        }
        if esperado == "ok" {
            assert_eq!((validate.status.code(), show.status.code()), (Some(0), Some(0)), "{archivo}: {:?}", text(&show.stderr));
            let mut sin_paquete = core_view.clone();
            sin_paquete.as_object_mut().unwrap().remove("package");
            assert_eq!(serde_json::from_str::<Value>(&v_out).unwrap(), sin_paquete, "{archivo}: validate = la vista del Core sin el paquete");
            assert_eq!(serde_json::from_str::<Value>(&s_out).unwrap(), core_view, "{archivo}: show = la vista del Core tal cual");
        } else {
            assert_eq!((validate.status.code(), show.status.code()), (Some(7), Some(7)), "{archivo}");
            for out in [&v_out, &s_out] {
                let v: Value = serde_json::from_str(out).unwrap();
                assert_eq!((v["status"].as_str(), v["error"]["code"].as_str()), (Some("invalid"), Some(esperado)), "{archivo}: {v}");
                assert!(v.get("package").is_none() && v.get("summary").is_none() && v.get("package_id").is_none(), "{archivo}: {v}");
                assert_eq!(v.get("declared_id").is_some(), esperado == "id_mismatch", "{archivo}: solo la alteración trae las huellas");
            }
            // En texto, el rechazo va por el error, con su código, y sin el contenido del paquete.
            let humano = server.lxo(&["context", "show", ruta], None);
            assert_eq!(humano.status.code(), Some(7));
            let (o, e) = (text(&humano.stdout), text(&humano.stderr));
            assert!(o.is_empty() && e.contains(&format!("({esperado})")) && e.contains("No se muestra su contenido"), "{archivo}: {o} / {e}");
            assert!(!e.contains("Normalizar el uso de cada proveedor"), "{archivo}: el rechazo enseñó el contenido");
        }
    }

    // El paquete alterado hace visibles las dos huellas, y el Core las da distintas.
    let alterado = fixtures().join("invalido-alterado.json");
    let alterado: Value = serde_json::from_slice(&server.lxo(&["context", "validate", alterado.to_str().unwrap(), "--json"], None).stdout).unwrap();
    assert_ne!(alterado["declared_id"], alterado["recomputed_id"]);

    // Texto humano de un paquete válido: identidad, procedencia y adjuntos sin comprobar.
    let valido = fixtures().join("valido-completo.json");
    let humano = text(&server.lxo(&["context", "show", valido.to_str().unwrap()], None).stdout);
    assert!(humano.contains("· válido") && humano.contains("identidad verificada") && humano.contains("adjuntos: sin comprobar"), "{humano}");
    assert!(humano.contains("Origen:") && humano.contains("Revisión:") && humano.contains("Adjuntos ("), "{humano}");

    // La entrada estándar, con y sin BOM, da lo mismo que el archivo.
    let bytes = std::fs::read(&valido).unwrap();
    let por_archivo = server.json(&["context", "show", valido.to_str().unwrap(), "--json"]);
    let por_stdin = server.lxo_stdin(&["context", "show", "-", "--json"], &bytes);
    assert_eq!(por_stdin.status.code(), Some(0), "{}", text(&por_stdin.stderr));
    assert_eq!(serde_json::from_slice::<Value>(&por_stdin.stdout).unwrap(), por_archivo);
    let con_bom = [&[0xef, 0xbb, 0xbf][..], &bytes].concat();
    assert_eq!(serde_json::from_slice::<Value>(&server.lxo_stdin(&["context", "show", "-", "--json"], &con_bom).stdout).unwrap(), por_archivo, "el BOM se ignora");

    // Límites: nada de esto llega al Core ni repite el contenido del archivo.
    let carpeta = cleanup.0.join("ctx");
    std::fs::create_dir_all(&carpeta).unwrap();
    let ruta_de = |n: &str| carpeta.join(n).to_string_lossy().into_owned();
    std::fs::write(carpeta.join("enorme.json"), vec![b'a'; 128 * 1024 + 1]).unwrap();
    let utf16: Vec<u8> = [0xff, 0xfe].into_iter().chain("{}".encode_utf16().flat_map(|u| u.to_le_bytes())).collect();
    std::fs::write(carpeta.join("utf16.json"), utf16).unwrap();
    std::fs::write(carpeta.join("vacio.json"), "").unwrap();
    for (nombre, codigo, aviso) in [("enorme.json", 2, "pesa más de 128 KiB"), ("utf16.json", 2, "UTF-16"), ("vacio.json", 2, "vacío"), ("no-existe.json", 6, "No hay ningún archivo")] {
        let out = server.lxo(&["context", "validate", &ruta_de(nombre)], None);
        assert_eq!(out.status.code(), Some(codigo), "{nombre}: {:?}", text(&out.stderr));
        assert!(text(&out.stderr).contains(aviso), "{nombre}: {}", text(&out.stderr));
    }
    let carpeta_str = carpeta.to_string_lossy().into_owned();
    assert_eq!(server.lxo(&["context", "show", &carpeta_str], None).status.code(), Some(2), "una carpeta no es un archivo");
    let falta: Value = serde_json::from_slice(&server.lxo(&["context", "show", &ruta_de("no-existe.json"), "--json"], None).stderr).unwrap();
    assert_eq!(falta["code"], "not_found");
    // Uso inválido: sin destino, sin paquete y con más de un archivo (export e import existen desde LXO-138; ver `context_store_tests.rs`).
    for args in [&["context", "export", "p.json"][..], &["context", "export", "t3-a1"], &["context", "show"], &["context", "validate", &ruta_de("a"), &ruta_de("b")]] {
        assert_eq!(server.lxo(args, None).status.code(), Some(2), "{args:?}");
    }
    // Importar un archivo que no existe: 6, como validar uno.
    assert_eq!(server.lxo(&["context", "import", &ruta_de("no-existe.json")], None).status.code(), Some(6));

    // Solo personas: un agente recibe 3. Y con el Core cerrado, 5.
    let token = "agent-lxo-context-e2e-token-with-32-bytes-minimum";
    super::projects_overview_tests::registra_agente(&core, "t-agente", "install-agent-lxo-context-e2e", token);
    let como_agente = server.lxo(&["context", "validate", valido.to_str().unwrap()], Some(("t-agente", token)));
    assert_eq!(como_agente.status.code(), Some(3), "{}", text(&como_agente.stderr));
    assert!(text(&como_agente.stderr).contains("solo para personas"), "{}", text(&como_agente.stderr));
    core.stop_server_with(&server.discovery);
    assert_eq!(server.lxo(&["context", "validate", valido.to_str().unwrap()], None).status.code(), Some(5), "Lixbon cerrado");
}
