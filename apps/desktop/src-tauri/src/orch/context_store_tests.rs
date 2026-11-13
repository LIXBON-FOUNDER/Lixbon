//! LXO-138 · ContextPackage guardado de extremo a extremo: `context_package_build`, `context_package_get` y `context_package_import` sobre
//! Attempts reales (adapters falsos, repositorios y worktrees de verdad). Se comprueba que el Core construye el paquete con la evidencia de
//! git que de verdad hay en el worktree (revisión, cambios, parche sin commit, archivos sin seguimiento), que el paquete guardado es el que
//! se exporta tal cual, que importarlo en OTRO Core lo deja preparado sin iniciar nada, que un paquete alterado o con un adjunto que no
//! coincide no se guarda ni se muestra, que un secreto no entra y que solo una Person lo hace.

use std::collections::BTreeMap;

use base64::Engine;
use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::attempt_e2e_tests::{world, World};
use super::attention_read_tests::agente;
use super::compare_e2e_tests::{commit, event_total, git, worktree};
use super::context_package::sha256_hex;
use super::rpc::rpc_action_for_tests;
use super::{Caller, Core};
use crate::store::ClientAction;

const SECRETO: &str = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxx";

fn b64(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

impl World {
    fn build(&self, attempt: &str) -> Result<Value, String> {
        self.desktop("context_package_build", json!({ "attempt_id": attempt }))
    }

    fn get(&self, args: Value) -> Result<Value, String> {
        self.desktop("context_package_get", args)
    }

    fn import(&self, package: &str, attachments: Option<Value>) -> Result<Value, String> {
        let mut args = json!({ "package": package });
        if let Some(a) = attachments {
            args["attachments"] = a;
        }
        self.desktop("context_package_import", args)
    }
}

/// Un Attempt terminado con un commit, un cambio sin preparar, uno preparado y un archivo sin seguimiento.
fn con_trabajo_a_medias() -> (World, String) {
    let w = world("claude", Some(vec![Step::Output("trabajo".into()), Step::Complete(Some("Dejé el trabajo a medias".into()))]));
    let attempt = w.create("claude", "ctx-origen");
    w.approve(&attempt);
    w.settled(&attempt, "done");
    commit(&w.core, &attempt, &[("README.md", "cambiado\n"), ("src.txt", "nuevo\n")]);
    let dir = worktree(&w.core, &attempt);
    std::fs::write(dir.join("src.txt"), "nuevo\nsin preparar\n").unwrap();
    std::fs::write(dir.join("preparado.txt"), "listo para el commit\n").unwrap();
    git(&dir, &["add", "preparado.txt"]);
    std::fs::write(dir.join("NOTAS.md"), "apuntes sin seguimiento\n").unwrap();
    (w, attempt)
}

fn adjuntos_de(v: &Value) -> BTreeMap<String, Vec<u8>> {
    v["attachment_data"].as_object().unwrap().iter().map(|(id, d)| (id.clone(), base64::engine::general_purpose::STANDARD.decode(d.as_str().unwrap()).unwrap())).collect()
}

fn attempts_total(core: &Core) -> i64 {
    core.storage.with_store(|s| s.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM attempts", [], |r| r.get(0))?))).unwrap().unwrap()
}

fn paquete_guardado(core: &Core, id: &str) -> Option<String> {
    core.storage.with_store(|s| s.context_package(id).unwrap().map(|p| p.json)).unwrap()
}

#[test]
fn construye_el_paquete_con_la_evidencia_de_git_que_hay_en_el_worktree() {
    let (w, attempt) = con_trabajo_a_medias();
    let dir = worktree(&w.core, &attempt);
    let head = git(&dir, &["rev-parse", "HEAD"]);
    let tree = git(&dir, &["rev-parse", "HEAD^{tree}"]);

    let v = w.build(&attempt).expect("el paquete");
    assert_eq!((v["v"].as_u64(), v["status"].as_str()), (Some(1), Some("valid")));
    assert_eq!(v["verification"], json!({ "identity": "verified", "secrets": "none_found", "attachments": "not_checked" }));
    let p = &v["package"];
    // Procedencia: la fija el Core, no el cliente.
    assert_eq!((p["source"]["attempt_id"].as_str(), p["source"]["provider"].as_str(), p["source"]["task_id"].as_str()), (Some(attempt.as_str()), Some("claude"), Some(attempt.rsplit_once("-a").unwrap().0)));
    assert_eq!(p["source"]["project_id"], w.project);
    assert!(p["source"]["host"].as_str().unwrap().starts_with("fp:"), "el host sale como huella, no como nombre");
    assert_eq!(p["objective"], "haz algo");
    assert_eq!(p["thread_summary"], "Dejé el trabajo a medias");
    // La revisión sale de git, no de lo que cuenta el agente.
    let r = &p["revision"];
    assert_eq!((r["head_commit"].as_str(), r["head_tree"].as_str()), (Some(head.as_str()), Some(tree.as_str())));
    let base = r["base_commit"].as_str().unwrap();
    assert_eq!(git(&dir, &["merge-base", "HEAD", "HEAD~1"]), base, "la base es el commit del que parte el trabajo");
    let paths: Vec<&str> = r["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["README.md", "src.txt"], "solo lo comprometido: lo demás es `uncommitted`");
    // El hash del diff es el del diff ORIGINAL base..head.
    let diff = std::process::Command::new("git").args(["diff", "--binary", "--no-renames", base, &head]).current_dir(&dir).output().unwrap().stdout;
    assert_eq!((r["diff_sha256"].as_str(), r["diff_bytes"].as_u64()), (Some(sha256_hex(&diff).as_str()), Some(diff.len() as u64)));
    // Lo que no está comprometido viaja como adjuntos, con su hash.
    let u = &p["uncommitted"];
    assert!(u["staged_patch"].is_string() && u["unstaged_patch"].is_string());
    assert_eq!(u["untracked"][0]["path"], "NOTAS.md");
    assert_eq!(u["untracked"][0]["sha256"].as_str().unwrap(), sha256_hex(b"apuntes sin seguimiento\n"));
    assert!(v["attachments"].as_array().unwrap().iter().all(|a| a["stored"] == true), "todo lo que viaja quedó guardado");
    // Guardado una vez, como construido.
    assert_eq!((v["stored"]["origin"].as_str(), v["stored"]["created"].as_bool()), (Some("built"), Some(true)));
    assert!(paquete_guardado(&w.core, v["package_id"].as_str().unwrap()).is_some());
}

#[test]
fn construir_no_inicia_nada_ni_deja_events_ni_toca_el_worktree() {
    let (w, attempt) = con_trabajo_a_medias();
    let dir = worktree(&w.core, &attempt);
    let estado = git(&dir, &["status", "--porcelain"]);
    let (eventos, intentos) = (event_total(&w.core), attempts_total(&w.core));
    let llamadas = w.adapter.calls().len();
    w.build(&attempt).unwrap();
    assert_eq!(event_total(&w.core), eventos, "el paquete no es un hecho del Event Log");
    assert_eq!(attempts_total(&w.core), intentos, "no crea ningún Attempt");
    assert_eq!(w.adapter.calls().len(), llamadas, "no arranca nada en ningún proveedor");
    assert_eq!(git(&dir, &["status", "--porcelain"]), estado, "construir solo lee el worktree");
}

#[test]
fn el_paquete_guardado_sale_tal_cual_por_id_y_por_attempt_con_sus_adjuntos() {
    let (w, attempt) = con_trabajo_a_medias();
    let built = w.build(&attempt).unwrap();
    let id = built["package_id"].as_str().unwrap();

    let por_id = w.get(json!({ "package_id": id, "include_attachments": true })).unwrap();
    let por_attempt = w.get(json!({ "attempt_id": attempt, "include_attachments": true })).unwrap();
    assert_eq!(por_id["package"], built["package"], "el paquete que se lee es el que se construyó");
    assert_eq!(por_attempt["package_id"], built["package_id"], "por Attempt, el más reciente");
    assert_eq!(por_id["stored"]["origin"], "built");
    // Cada adjunto que se entrega coincide con el sha256 y el tamaño que el paquete declara.
    let datos = adjuntos_de(&por_id);
    // El parche preparado lleva lo preparado y el no preparado, lo no preparado: no se confunden.
    let parche = |campo: &str| String::from_utf8(datos[por_id["package"]["uncommitted"][campo].as_str().unwrap()].clone()).unwrap();
    let (preparado, sin_preparar) = (parche("staged_patch"), parche("unstaged_patch"));
    assert!(preparado.contains("preparado.txt") && !preparado.contains("sin preparar"), "{preparado}");
    assert!(sin_preparar.contains("sin preparar") && !sin_preparar.contains("preparado.txt"), "{sin_preparar}");
    let declarados = por_id["package"]["attachments"].as_array().unwrap();
    assert!(!declarados.is_empty());
    for a in declarados {
        let bytes = datos.get(a["id"].as_str().unwrap()).expect("el adjunto viaja");
        assert_eq!((sha256_hex(bytes).as_str(), bytes.len() as u64), (a["sha256"].as_str().unwrap(), a["bytes"].as_u64().unwrap()));
    }
    // Sin pedirlos no se entregan, pero se dice cuáles hay.
    let sin = w.get(json!({ "package_id": id })).unwrap();
    assert!(sin.get("attachment_data").is_none() && sin["attachments"].as_array().unwrap().len() == declarados.len());
}

#[test]
fn importar_en_otro_core_lo_deja_preparado_sin_iniciar_nada_y_con_el_origen_intacto() {
    let (origen, attempt) = con_trabajo_a_medias();
    let built = origen.build(&attempt).unwrap();
    let id = built["package_id"].as_str().unwrap().to_string();
    let exportado = origen.get(json!({ "package_id": id, "include_attachments": true })).unwrap();
    let json_exacto = serde_json::to_string(&exportado["package"]).unwrap();
    let adjuntos: Value = Value::Object(adjuntos_de(&exportado).into_iter().map(|(k, v)| (k, Value::String(b64(&v)))).collect());

    // Otro Core: otra base, otro host, ni el Attempt ni el Project existen allí.
    let destino = world("claude", None);
    let (eventos, intentos) = (event_total(&destino.core), attempts_total(&destino.core));
    let v = destino.import(&json_exacto, Some(adjuntos)).expect("importar");
    assert_eq!((v["status"].as_str(), v["package_id"].as_str()), (Some("valid"), Some(id.as_str())));
    assert_eq!((v["stored"]["origin"].as_str(), v["stored"]["created"].as_bool()), (Some("imported"), Some(true)));
    assert_eq!(v["package"]["source"], built["package"]["source"], "la procedencia no se reescribe al importar");
    assert_eq!(v["package"], exportado["package"]);
    // Preparado, no iniciado: ningún Attempt nuevo, ningún Event.
    assert_eq!(event_total(&destino.core), eventos);
    assert_eq!(attempts_total(&destino.core), intentos, "importar no crea ningún Attempt");
    // Y se lee de vuelta con sus adjuntos íntegros.
    let leido = destino.get(json!({ "package_id": id, "include_attachments": true })).unwrap();
    assert_eq!(adjuntos_de(&leido), adjuntos_de(&exportado));
    assert_eq!(leido["stored"]["origin"], "imported");
    // Repetir no escribe nada y no cambia el origen.
    let otra_vez = destino.import(&json_exacto, Some(Value::Object(adjuntos_de(&exportado).into_iter().map(|(k, v)| (k, Value::String(b64(&v)))).collect()))).unwrap();
    assert_eq!((otra_vez["stored"]["created"].as_bool(), otra_vez["stored"]["origin"].as_str()), (Some(false), Some("imported")));
}

#[test]
fn un_paquete_alterado_o_con_un_adjunto_que_no_coincide_no_se_guarda_ni_se_muestra() {
    let (w, attempt) = con_trabajo_a_medias();
    let built = w.build(&attempt).unwrap();
    let id = built["package_id"].as_str().unwrap();
    let exportado = w.get(json!({ "package_id": id, "include_attachments": true })).unwrap();
    let buenos = adjuntos_de(&exportado);
    let todos = |m: &BTreeMap<String, Vec<u8>>| Value::Object(m.iter().map(|(k, v)| (k.clone(), Value::String(b64(v)))).collect());
    let destino = world("claude", None);

    // Alterado: el contenido ya no coincide con su identidad.
    let mut alterado = exportado["package"].clone();
    alterado["objective"] = json!("otro objetivo");
    let r = destino.import(&serde_json::to_string(&alterado).unwrap(), Some(todos(&buenos))).unwrap();
    assert_eq!((r["status"].as_str(), r["error"]["code"].as_str()), (Some("invalid"), Some("id_mismatch")));
    assert!(r.get("package").is_none() && r.get("stored").is_none() && r.get("package_id").is_none(), "{r}");
    assert_ne!(r["declared_id"], Value::Null);

    // Adjunto cambiado, que falta y que sobra.
    let intacto = serde_json::to_string(&exportado["package"]).unwrap();
    let primero = buenos.keys().next().unwrap().clone();
    let mut cambiado = buenos.clone();
    cambiado.get_mut(&primero).unwrap().push(b'!');
    let mut sin_uno = buenos.clone();
    sin_uno.remove(&primero);
    let mut de_mas = buenos.clone();
    de_mas.insert("att:0000000000000000".into(), vec![1]);
    for (name, adj) in [("cambiado", Some(todos(&cambiado))), ("falta", Some(todos(&sin_uno))), ("sobra", Some(todos(&de_mas))), ("sin adjuntos", None)] {
        let r = destino.import(&intacto, adj).unwrap();
        assert_eq!((r["status"].as_str(), r["error"]["code"].as_str()), (Some("invalid"), Some("attachment_mismatch")), "{name}: {r}");
        assert!(r.get("package").is_none() && r.get("stored").is_none(), "{name}");
    }
    // Nada quedó guardado en el destino.
    assert!(paquete_guardado(&destino.core, id).is_none());
    assert_eq!(destino.get(json!({ "package_id": id })).unwrap_err().split(':').next(), Some("context_store_not_found"));

    // Version desconocida y JSON que no lo es: respuesta `invalid`, no error de la petición.
    let mut v2 = exportado["package"].clone();
    v2["schema_version"] = json!(2);
    assert_eq!(destino.import(&serde_json::to_string(&v2).unwrap(), None).unwrap()["error"]["code"], "unsupported_version");
    assert_eq!(destino.import("no es json", None).unwrap()["error"]["code"], "invalid_json");
}

#[test]
fn un_secreto_del_worktree_no_entra_en_el_paquete_ni_en_lo_guardado() {
    let w = world("claude", Some(vec![Step::Output("trabajo".into()), Step::Complete(Some("hecho".into()))]));
    let attempt = w.create("claude", "ctx-secreto");
    w.approve(&attempt);
    w.settled(&attempt, "done");
    let dir = worktree(&w.core, &attempt);
    std::fs::write(dir.join("config.txt"), format!("clave = {SECRETO}\n")).unwrap();
    std::fs::write(dir.join("normal.txt"), "nada raro\n").unwrap();
    let v = w.build(&attempt).expect("el paquete se construye igualmente");
    assert_eq!(v["status"], "valid");
    let atts = v["attachments"].as_array().unwrap();
    let omitido = atts.iter().find(|a| !a["omitted"].is_null()).expect("el archivo con secreto consta como omitido");
    assert_eq!((omitido["omitted"].as_str(), omitido["stored"].as_bool()), (Some("secret_detected"), Some(false)));
    assert!(atts.iter().any(|a| a["omitted"].is_null() && a["stored"] == true), "el archivo normal sí viaja");
    let guardado = w.get(json!({ "attempt_id": attempt, "include_attachments": true })).unwrap();
    assert!(!guardado.to_string().contains(SECRETO), "el secreto no sale por ninguna vía");
    for bytes in adjuntos_de(&guardado).values() {
        assert!(!String::from_utf8_lossy(bytes).contains(SECRETO), "ni en los bytes de un adjunto");
    }
    // Y un paquete importado que lo lleve se rechaza.
    let mut p = guardado["package"].clone();
    p["decisions"] = json!([format!("usar {SECRETO}")]);
    let r = w.import(&serde_json::to_string(&p).unwrap(), None).unwrap();
    assert_eq!(r["status"], "invalid");
    assert!(!r.to_string().contains(SECRETO));
}

#[test]
fn los_adjuntos_que_no_caben_por_el_rpc_se_dicen_y_el_resto_se_lee_igual() {
    let w = world("claude", Some(vec![Step::Output("trabajo".into()), Step::Complete(Some("hecho".into()))]));
    let attempt = w.create("claude", "ctx-grande");
    w.approve(&attempt);
    w.settled(&attempt, "done");
    let dir = worktree(&w.core, &attempt);
    // Tres archivos de ~900 KiB (cada uno cabe como adjunto; juntos pasan de lo que viaja por el RPC).
    for n in 0..3 {
        std::fs::write(dir.join(format!("grande{n}.txt")), format!("{n}-abcd
").repeat(130_000)).unwrap();
    }
    let v = w.build(&attempt).unwrap();
    assert_eq!(v["status"], "valid");
    assert!(v["attachments"].as_array().unwrap().iter().all(|a| a["stored"] == true));
    let id = v["package_id"].as_str().unwrap();
    let e = w.get(json!({ "package_id": id, "include_attachments": true })).unwrap_err();
    assert!(e.contains("context_store_attachments_too_large"), "{e}");
    // Sin pedirlos se lee igual, con la lista de lo que hay.
    // Los tres archivos y el bundle de los commits sin publicar.
    assert_eq!(w.get(json!({ "package_id": id })).unwrap()["attachments"].as_array().unwrap().len(), 4);
}

#[test]
fn un_attempt_sin_worktree_da_un_paquete_valido_que_dice_que_no_tiene_revision() {
    let w = world("claude", None);
    let attempt = w.create("claude", "ctx-pendiente");
    let v = w.build(&attempt).expect("un Attempt pendiente tiene paquete");
    assert_eq!(v["status"], "valid");
    assert!(v["package"]["revision"].is_null());
    assert!(v["package"]["revision_absent_reason"].as_str().unwrap().contains("worktree"));
    assert!(v["summary"]["notes"].as_array().unwrap().iter().any(|n| n == "revision_absent"));
    assert_eq!(v["summary"]["completeness"], "partial");
}

#[test]
fn solo_una_persona_construye_lee_o_importa_y_los_argumentos_se_validan() {
    for cmd in ["context_package_build", "context_package_import"] {
        assert_eq!(rpc_action_for_tests(cmd), ClientAction::AgentOrDesktopCommand, "{cmd}");
    }
    assert_eq!(rpc_action_for_tests("context_package_get"), ClientAction::Read);
    let (w, attempt) = con_trabajo_a_medias();
    let built = w.build(&attempt).unwrap();
    w.core.settings.lock().unwrap().enabled = true;
    let ag = agente(&w.core, "t-agente", "install-agent-ctx-store", "agent-ctx-store-secret-0123456789abcdef");
    for (cmd, args) in [
        ("context_package_build", json!({ "attempt_id": attempt })),
        ("context_package_get", json!({ "attempt_id": attempt })),
        ("context_package_import", json!({ "package": serde_json::to_string(&built["package"]).unwrap() })),
    ] {
        let e = super::attention_read_tests::rpc(&w.core, &ag, cmd, args).unwrap_err();
        assert!(e.contains("context_store_auth_required"), "{cmd}: {e}");
    }
    // Argumentos.
    for (cmd, args, contiene) in [
        ("context_package_build", json!({}), "attempt_id"),
        ("context_package_build", json!({ "attempt_id": attempt, "x": 1 }), "parámetro desconocido"),
        ("context_package_build", json!({ "attempt_id": 3 }), "attempt_id"),
        ("context_package_build", json!({ "attempt_id": "no-existe-a9" }), "context_store_not_found"),
        ("context_package_get", json!({}), "package_id"),
        ("context_package_get", json!({ "package_id": "a", "attempt_id": "b" }), "uno solo"),
        ("context_package_get", json!({ "attempt_id": attempt, "include_attachments": "si" }), "booleano"),
        ("context_package_get", json!({ "attempt_id": "t9-a9" }), "context_store_not_found"),
        ("context_package_import", json!({}), "package"),
        ("context_package_import", json!({ "package": 3 }), "package"),
        ("context_package_import", json!({ "package": "{}", "attachments": [] }), "attachments"),
        ("context_package_import", json!({ "package": "{}", "attachments": { "att:0000000000000000": 5 } }), "base64"),
        ("context_package_import", json!({ "package": "{}", "attachments": { "att:0000000000000000": "***" } }), "base64"),
        ("context_package_import", json!({ "package": "x".repeat(140_000) }), "pesa más"),
    ] {
        let e = w.desktop(cmd, args).unwrap_err();
        assert!(e.contains(contiene), "{cmd}: {e}");
    }
    let _ = Caller::User;
}

/// LXO-138 · `lxo context export`, `import` y `show` por id con el binario real, como persona, contra el HTTP de DOS Cores (el de origen, con un
/// Attempt de verdad y su worktree sucio, y otro de destino): exportar construye y guarda el paquete y lo deja en un archivo privado con sus
/// adjuntos; importarlo en el otro Core lo valida y lo deja preparado sin crear ningún Attempt; un paquete alterado, un adjunto que no coincide
/// o la carpeta de adjuntos que falta salen con 7 y no se guardan ni se muestran; y los límites del destino, el agente y el Core cerrado dan sus
/// códigos. Requiere `LXO_BIN`; usa el almacén seguro real.
#[test]
#[ignore = "requiere un binario lxo real (LXO_BIN) y el almacén seguro del sistema; ver apps/desktop/README.md"]
fn lxo_bin_e2e_context_store_person_real_store() {
    use super::projects_overview_tests::{registra_agente, RealStoreServer};
    let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    let tmp = std::env::temp_dir().join(format!("lxo-ctxstore-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    for d in ["origen", "destino", "salida"] {
        std::fs::create_dir_all(tmp.join(d)).unwrap();
    }

    let (origen, attempt) = con_trabajo_a_medias();
    origen.core.settings.lock().unwrap().enabled = true;
    let s_origen = RealStoreServer::start(&origen.core, &tmp.join("origen"), &tmp.join("origen"));
    let destino = world("claude", None);
    destino.core.settings.lock().unwrap().enabled = true;
    let s_destino = RealStoreServer::start(&destino.core, &tmp.join("destino"), &tmp.join("destino"));
    let intentos_destino = attempts_total(&destino.core);

    // Exportar: el Core construye el paquete del intento y lo guarda; lxo lo deja en un archivo y sus adjuntos al lado.
    let out = tmp.join("salida").join("paquete.json");
    let out_s = out.to_string_lossy().into_owned();
    let exportado = s_origen.json(&["context", "export", &attempt, "--out", &out_s, "--json"]);
    assert_eq!((exportado["status"].as_str(), exportado["built"].as_bool()), (Some("exported"), Some(true)), "{exportado}");
    let id = exportado["package_id"].as_str().unwrap().to_string();
    let en_el_core = origen.get(json!({ "package_id": id, "include_attachments": true })).unwrap();
    assert_eq!(en_el_core["stored"]["origin"], "built", "el paquete quedó guardado en el Core de origen");
    let archivo: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
    assert_eq!(archivo, en_el_core["package"], "el archivo es el paquete guardado, tal cual");
    let adjuntos_dir = tmp.join("salida").join("paquete.json.attachments");
    for (idd, bytes) in adjuntos_de(&en_el_core) {
        assert_eq!(std::fs::read(adjuntos_dir.join(idd.replacen("att:", "att-", 1))).unwrap(), bytes, "{idd}");
    }
    // Sin secretos y sin la ruta del worktree.
    let todo = std::fs::read_to_string(&out).unwrap();
    assert!(!todo.contains(SECRETO) && !todo.contains(&worktree(&origen.core, &attempt).to_string_lossy().to_string()), "el archivo no lleva rutas locales");
    // Texto humano de exportar y de mostrar por id y por intento.
    let humano = text(&s_origen.lxo(&["context", "export", &id, "--out", &out_s, "--force"], None).stdout);
    assert!(humano.contains("guardado en el Core") && humano.contains("no se ha iniciado ningún intento"), "{humano}");
    for source in [id.as_str(), attempt.as_str()] {
        let h = text(&s_origen.lxo(&["context", "show", source], None).stdout);
        assert!(h.contains("Guardado:     construido por este Core") && h.contains("Origen:") && h.contains("· válido"), "{source}: {h}");
        let j = s_origen.json(&["context", "show", source, "--json"]);
        assert_eq!(j["package"], en_el_core["package"], "show por {source}: el paquete guardado tal cual");
    }
    // `--stored` no construye otro, y exportar un intento sin `--stored` construye uno nuevo.
    let otra = tmp.join("salida").join("otra.json").to_string_lossy().into_owned();
    let guardado = s_origen.json(&["context", "export", &attempt, "--stored", "--out", &otra, "--json"]);
    assert_eq!((guardado["built"].as_bool(), guardado["package_id"].as_str()), (Some(false), Some(id.as_str())));

    // Destino: no sobrescribe, no crea carpetas, y no pide nada al Core si no cabe.
    let existente = s_origen.lxo(&["context", "export", &attempt, "--out", &out_s], None);
    assert_eq!(existente.status.code(), Some(2), "{}", text(&existente.stderr));
    assert!(text(&existente.stderr).contains("no sobrescribe sin --force"));
    let sin_carpeta = tmp.join("no-existe").join("p.json").to_string_lossy().into_owned();
    assert_eq!(s_origen.lxo(&["context", "export", &attempt, "--out", &sin_carpeta], None).status.code(), Some(2));
    assert_eq!(s_origen.lxo(&["context", "export", &attempt, "--out", &tmp.join("salida").to_string_lossy()], None).status.code(), Some(2), "una carpeta no es el archivo");
    assert_eq!(s_origen.lxo(&["context", "export", &attempt], None).status.code(), Some(2), "--out es obligatorio");

    // Importar en OTRO Core: valida y deja el paquete preparado, sin crear ningún Attempt.
    let importado = s_destino.json(&["context", "import", &out_s, "--json"]);
    assert_eq!((importado["status"].as_str(), importado["package_id"].as_str()), (Some("valid"), Some(id.as_str())), "{importado}");
    assert_eq!((importado["stored"]["origin"].as_str(), importado["stored"]["created"].as_bool()), (Some("imported"), Some(true)));
    assert_eq!(attempts_total(&destino.core), intentos_destino, "importar no inicia ningún intento");
    let leido = destino.get(json!({ "package_id": id, "include_attachments": true })).unwrap();
    assert_eq!(leido["package"], en_el_core["package"], "el paquete importado es el exportado");
    assert_eq!(adjuntos_de(&leido), adjuntos_de(&en_el_core), "con sus adjuntos íntegros");
    assert_eq!(leido["package"]["source"], en_el_core["package"]["source"], "la procedencia no se reescribe");
    let otra_vez = s_destino.json(&["context", "import", &out_s, "--json"]);
    assert_eq!((otra_vez["stored"]["created"].as_bool(), otra_vez["stored"]["origin"].as_str()), (Some(false), Some("imported")));
    let h = text(&s_destino.lxo(&["context", "import", &out_s], None).stdout);
    assert!(h.contains("ya estaba guardado en el Core") && h.contains("no se ha iniciado ninguno"), "{h}");
    assert!(text(&s_destino.lxo(&["context", "show", &id], None).stdout).contains("Guardado:     importado de un archivo"));

    // Rechazos: no se guardan ni se muestran. Un destino nuevo para comprobar que no queda nada.
    let limpio = world("claude", None);
    limpio.core.settings.lock().unwrap().enabled = true;
    std::fs::create_dir_all(tmp.join("limpio")).unwrap();
    let s_limpio = RealStoreServer::start(&limpio.core, &tmp.join("limpio"), &tmp.join("limpio"));
    let copia = |nombre: &str| -> std::path::PathBuf {
        let dir = tmp.join("copias").join(nombre);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("p.json");
        std::fs::copy(&out, &f).unwrap();
        let adj = dir.join("p.json.attachments");
        std::fs::create_dir_all(&adj).unwrap();
        for entry in std::fs::read_dir(&adjuntos_dir).unwrap() {
            let entry = entry.unwrap();
            std::fs::copy(entry.path(), adj.join(entry.file_name())).unwrap();
        }
        f
    };
    let rechazado = |server: &RealStoreServer, f: &std::path::Path, codigo: &str| {
        let out = server.lxo(&["context", "import", &f.to_string_lossy(), "--json"], None);
        assert_eq!(out.status.code(), Some(7), "{codigo}: {}", text(&out.stderr));
        let v: Value = serde_json::from_slice(&out.stdout).unwrap();
        assert_eq!((v["status"].as_str(), v["error"]["code"].as_str()), (Some("invalid"), Some(codigo)), "{v}");
        assert!(v.get("package").is_none() && v.get("stored").is_none() && v.get("package_id").is_none(), "{v}");
        v
    };
    // Alterado.
    let alterado = copia("alterado");
    let mut p: Value = serde_json::from_str(&std::fs::read_to_string(&alterado).unwrap()).unwrap();
    p["objective"] = json!("OBJETIVO-ALTERADO-QUE-NO-DEBE-SALIR");
    std::fs::write(&alterado, serde_json::to_string_pretty(&p).unwrap()).unwrap();
    let v = rechazado(&s_limpio, &alterado, "id_mismatch");
    assert_ne!(v["declared_id"], v["recomputed_id"]);
    let humano = s_limpio.lxo(&["context", "import", &alterado.to_string_lossy()], None);
    assert_eq!(humano.status.code(), Some(7));
    assert!(!text(&humano.stdout).contains("OBJETIVO-ALTERADO") && !text(&humano.stderr).contains("OBJETIVO-ALTERADO"), "el rechazo no enseña el contenido");
    // Adjunto cambiado, que falta y carpeta de adjuntos ausente.
    let cambiado = copia("cambiado");
    let primero = std::fs::read_dir(cambiado.parent().unwrap().join("p.json.attachments")).unwrap().next().unwrap().unwrap().path();
    let mut b = std::fs::read(&primero).unwrap();
    b.push(b'!');
    std::fs::write(&primero, b).unwrap();
    rechazado(&s_limpio, &cambiado, "attachment_mismatch");
    let falta = copia("falta");
    let uno = std::fs::read_dir(falta.parent().unwrap().join("p.json.attachments")).unwrap().next().unwrap().unwrap().path();
    std::fs::remove_file(uno).unwrap();
    rechazado(&s_limpio, &falta, "attachment_mismatch");
    let sin_carpeta = copia("sin-carpeta");
    std::fs::remove_dir_all(sin_carpeta.parent().unwrap().join("p.json.attachments")).unwrap();
    rechazado(&s_limpio, &sin_carpeta, "attachment_mismatch");
    // Un archivo ajeno en la carpeta de adjuntos no llega al Core: es un error de uso.
    let ajeno = copia("ajeno");
    std::fs::write(ajeno.parent().unwrap().join("p.json.attachments").join("notas.txt"), "x").unwrap();
    assert_eq!(s_limpio.lxo(&["context", "import", &ajeno.to_string_lossy()], None).status.code(), Some(2));
    // Nada quedó guardado en el destino limpio.
    assert!(paquete_guardado(&limpio.core, &id).is_none());
    assert_eq!(s_limpio.lxo(&["context", "show", &id], None).status.code(), Some(6));

    // Inexistentes: un intento sin paquete, un intento que no existe, un package_id desconocido, un archivo.
    assert_eq!(s_limpio.lxo(&["context", "show", &attempt], None).status.code(), Some(6));
    assert_eq!(s_origen.lxo(&["context", "export", "t999-a1", "--out", &tmp.join("salida").join("x.json").to_string_lossy()], None).status.code(), Some(6));
    assert_eq!(s_origen.lxo(&["context", "export", "t999-a1", "--stored", "--out", &tmp.join("salida").join("y.json").to_string_lossy()], None).status.code(), Some(6));
    assert_eq!(s_origen.lxo(&["context", "show", "sha256:0000000000000000000000000000000000000000000000000000000000000000"], None).status.code(), Some(6));
    assert_eq!(s_origen.lxo(&["context", "import", &tmp.join("no-existe.json").to_string_lossy()], None).status.code(), Some(6));
    assert!(!tmp.join("salida").join("x.json").exists() && !tmp.join("salida").join("y.json").exists(), "un fallo no deja un archivo a medias");

    // Solo personas: un agente recibe 3. Y con el Core cerrado, 5.
    let token = "agent-lxo-ctxstore-e2e-token-with-32-bytes-minimum";
    registra_agente(&origen.core, "t-agente", "install-agent-lxo-ctxstore-e2e", token);
    let como_agente = s_origen.lxo(&["context", "show", &id], Some(("t-agente", token)));
    assert_eq!(como_agente.status.code(), Some(3), "{}", text(&como_agente.stderr));
    assert!(text(&como_agente.stderr).contains("solo para personas"), "{}", text(&como_agente.stderr));
    let export_agente = s_origen.lxo(&["context", "export", &attempt, "--out", &tmp.join("salida").join("z.json").to_string_lossy()], Some(("t-agente", token)));
    assert_eq!(export_agente.status.code(), Some(3));
    assert!(!tmp.join("salida").join("z.json").exists());
    origen.core.stop_server_with(&s_origen.discovery);
    assert_eq!(s_origen.lxo(&["context", "show", &id], None).status.code(), Some(5), "Lixbon cerrado");
    let _ = std::fs::remove_dir_all(&tmp);
}
