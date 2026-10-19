//! Pruebas de la API de lectura del Event Log (LXO-83): cursor, páginas, filtros, reinicio, errores,
//! autorización de solo lectura y el servidor HTTP local real.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::boot_tests::*;
use super::events_read::{parse_query, Code, EventsError};
use super::server;
use super::state::NewTask;
use super::store_boot::StorageStatus;
use super::{Caller, Core, Orch};
use crate::store::{ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity};

fn core_listo() -> (Limpia, PathBuf, PathBuf, Arc<Core>) {
    let (l, data, core_dir) = dirs();
    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(matches!(core.storage_status(), StorageStatus::Ready(_)));
    core.settings.lock().unwrap().enabled = true;
    (l, data, core_dir, core)
}

fn nt(titulo: &str) -> NewTask {
    NewTask {
        agent: "claude".into(), model: None, effort: None, role: None, title: titulo.into(), spec: "s".into(),
        repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: true,
    }
}

struct Escena {
    run: String,
    raiz: String,
    hija: String,
}

fn escena(core: &Core, nombre: &str) -> Escena {
    core.mutate(|tx| {
        let (run, raiz) = tx.create_run(nombre, nt(&format!("raiz-{nombre}")));
        tx.mark_running(&raiz)?;
        let hija = tx.add_child(&raiz, 2, NewTask { external: false, ..nt(&format!("hija-{nombre}")) })?;
        tx.mark_running(&hija)?;
        Ok(Escena { run, raiz, hija })
    })
    .unwrap()
}

fn registra_agente_http(core: &Core, task_id: &str, installation_id: &str, secret: &str) {
    let registration = ClientRegistration::new(
        ClientSurface::Cli,
        DeviceIdentity::new(installation_id, None).unwrap(),
    )
    .unwrap();
    let credential = ClientCredential::new(ClientPrincipal::Agent(task_id.into()), secret).unwrap();
    core.storage
        .with_store(|store| store.register_client(&registration, &credential, super::state::now_ms() as i64))
        .unwrap()
        .unwrap();
}

fn registra_persona_cli_http(core: &Core, installation_id: &str, secret: &str) {
    let registration = ClientRegistration::new(
        ClientSurface::Cli,
        DeviceIdentity::new(installation_id, None).unwrap(),
    )
    .unwrap();
    let credential = ClientCredential::new(ClientPrincipal::Person("user".into()), secret).unwrap();
    core.storage
        .with_store(|store| store.register_client(&registration, &credential, super::state::now_ms() as i64))
        .unwrap()
        .unwrap();
}

fn head(core: &Core) -> i64 {
    core.storage.with_store(|s| s.events_head().unwrap()).unwrap()
}

fn lee(core: &Core, args: Value) -> Value {
    core.events_read(&Caller::User, &args).unwrap_or_else(|e| panic!("{e:?}"))
}

fn falla(core: &Core, caller: &Caller, args: Value) -> EventsError {
    core.events_read(caller, &args).unwrap_err()
}

fn seqs(page: &Value) -> Vec<i64> {
    page["events"].as_array().unwrap().iter().map(|e| e["seq"].as_i64().unwrap()).collect()
}

fn kinds(page: &Value) -> Vec<String> {
    page["events"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap().to_string()).collect()
}

fn recorre(core: &Core, limit: u64, extra: Value) -> (Vec<Value>, usize) {
    let (mut todos, mut cursor, mut paginas) = (vec![], 0i64, 0);
    loop {
        let mut args = extra.clone();
        args["cursor"] = json!(cursor);
        args["limit"] = json!(limit);
        let p = lee(core, args);
        paginas += 1;
        todos.extend(p["events"].as_array().unwrap().clone());
        cursor = p["next_cursor"].as_i64().unwrap();
        if !p["has_more"].as_bool().unwrap() {
            return (todos, paginas);
        }
    }
}

#[test]
fn un_log_vacio_devuelve_una_pagina_vacia_con_cursor_cero() {
    let (_l, _d, _c, core) = core_listo();
    assert_eq!(head(&core), 0, "un arranque limpio no deja eventos");
    let p = lee(&core, json!({}));
    assert_eq!(p, json!({ "v": 1, "events": [], "next_cursor": 0, "has_more": false, "head_seq": 0, "limit": 100 }));
    let p = lee(&core, json!({ "cursor": 0, "kind_prefix": "task." }));
    assert_eq!((seqs(&p), p["next_cursor"].clone()), (vec![], json!(0)));
}

#[test]
fn una_pagina_lleva_el_contrato_cerrado_y_ningun_campo_interno() {
    let (_l, _d, _c, core) = core_listo();
    let e = escena(&core, "uno");
    let p = lee(&core, json!({ "limit": 500 }));
    assert_eq!(p["v"], 1);
    assert_eq!(p["limit"], 500);
    assert_eq!(p["next_cursor"], p["head_seq"]);
    assert_eq!(p["has_more"], false);
    let primero = &p["events"][0];
    let mut campos: Vec<_> = primero.as_object().unwrap().keys().cloned().collect();
    campos.sort();
    assert_eq!(
        campos,
        ["actor", "channel", "class", "client_id", "correlation_id", "entity", "id", "kind", "payload", "project_id", "run_id", "seq", "ts", "v"]
    );
    assert_eq!(primero["kind"], "run.created");
    assert_eq!(primero["class"], "state");
    assert_eq!(primero["entity"], json!({ "kind": "run", "id": e.run }));
    assert_eq!(primero["run_id"], e.run);
    assert_eq!(primero["actor"]["kind"], "system");
    assert!(primero["payload"].is_object(), "el payload viaja como objeto JSON, no como texto");
    assert!(primero["ts"].as_i64().unwrap() > 0 && primero["id"].as_str().unwrap().len() == 36);
    assert!(seqs(&p).windows(2).all(|w| w[0] < w[1]), "orden total ascendente por seq");
}

#[test]
fn varias_paginas_recorren_todo_sin_duplicar_ni_saltar_y_se_puede_reanudar() {
    let (_l, _d, _c, core) = core_listo();
    for n in 0..4 {
        escena(&core, &format!("r{n}"));
    }
    let total = head(&core);
    assert!(total > 10);

    let (todos, paginas) = recorre(&core, 3, json!({}));
    let vistos: Vec<i64> = todos.iter().map(|e| e["seq"].as_i64().unwrap()).collect();
    assert_eq!(vistos, (1..=total).collect::<Vec<_>>());
    assert_eq!(paginas as i64, (total + 2) / 3);

    let p = lee(&core, json!({ "cursor": 0, "limit": 5 }));
    assert_eq!((p["has_more"].clone(), p["next_cursor"].clone()), (json!(true), json!(5)));
    let reanuda = p["next_cursor"].as_i64().unwrap();
    let nueva = escena(&core, "tarde");
    let resto = recorre_desde(&core, reanuda);
    assert_eq!(resto.first(), Some(&(reanuda + 1)), "reanudar empieza justo después del cursor, exclusivo");
    assert_eq!(resto.last(), Some(&head(&core)));
    assert!(resto.contains(&(total + 1)), "los eventos nuevos aparecen tras el cursor: {} {}", nueva.run, nueva.raiz);
    let en_el_final = lee(&core, json!({ "cursor": head(&core) }));
    assert_eq!((seqs(&en_el_final), en_el_final["has_more"].clone()), (vec![], json!(false)));
}

fn recorre_desde(core: &Core, cursor: i64) -> Vec<i64> {
    let mut vistos = vec![];
    let mut c = cursor;
    loop {
        let p = lee(core, json!({ "cursor": c, "limit": 4 }));
        vistos.extend(seqs(&p));
        c = p["next_cursor"].as_i64().unwrap();
        if !p["has_more"].as_bool().unwrap() {
            return vistos;
        }
    }
}

#[test]
fn los_filtros_acotan_y_el_cursor_sigue_siendo_global() {
    let (_l, _d, _c, core) = core_listo();
    let a = escena(&core, "a");
    let b = escena(&core, "b");

    let (de_a, _) = recorre(&core, 2, json!({ "run": a.run }));
    assert!(!de_a.is_empty() && de_a.iter().all(|e| e["run_id"] == a.run));
    let (de_b, _) = recorre(&core, 2, json!({ "run": b.run }));
    assert_eq!(de_a.len() + de_b.len(), head(&core) as usize);

    let creadas = lee(&core, json!({ "kind": "task.created" }));
    assert_eq!(creadas["events"].as_array().unwrap().len(), 4);
    let tareas = lee(&core, json!({ "kind_prefix": "task." }));
    assert!(kinds(&tareas).iter().all(|k| k.starts_with("task.")));
    let de_hija = lee(&core, json!({ "entity_kind": "task", "entity_id": a.hija }));
    assert!(de_hija["events"].as_array().unwrap().iter().all(|e| e["entity"]["id"] == a.hija));
    assert_eq!(kinds(&de_hija), ["task.created", "task.status_changed"]);
    let estado = lee(&core, json!({ "class": "state", "run": b.run, "entity_kind": "run" }));
    assert_eq!(kinds(&estado), ["run.created"]);
    let ninguno = lee(&core, json!({ "class": "decision" }));
    assert_eq!((seqs(&ninguno), ninguno["next_cursor"].clone(), ninguno["head_seq"].clone()), (vec![], json!(head(&core)), json!(head(&core))));
}

#[test]
fn tras_reiniciar_el_cursor_sigue_valido_y_seq_no_se_reutiliza() {
    let (l, data, core_dir, core) = core_listo();
    escena(&core, "antes");
    let antes = recorre(&core, 500, json!({})).0;
    let cursor = antes.last().unwrap()["seq"].as_i64().unwrap();
    assert_eq!(cursor, head(&core));
    suelta(core, &core_dir);

    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    core.settings.lock().unwrap().enabled = true;
    let tras_reinicio = lee(&core, json!({ "cursor": 0, "limit": 500 }));
    let previos: Vec<Value> = tras_reinicio["events"].as_array().unwrap().iter().filter(|e| e["seq"].as_i64().unwrap() <= cursor).cloned().collect();
    assert_eq!(previos, antes, "los eventos previos se conservan idénticos, con los mismos seq e id");
    let tras_arranque = lee(&core, json!({ "cursor": cursor }));
    assert_eq!(seqs(&tras_arranque), (cursor + 1..=head(&core)).collect::<Vec<_>>(), "lo que emite el arranque continúa el orden");
    assert!(kinds(&tras_arranque).iter().all(|k| k == "task.status_changed"), "solo las tareas huérfanas cerradas");
    let cursor = head(&core);
    escena(&core, "despues");
    let p = lee(&core, json!({ "cursor": cursor, "limit": 500 }));
    assert_eq!(seqs(&p), (cursor + 1..=head(&core)).collect::<Vec<_>>(), "seq continúa sin huecos ni reutilización");
    assert_eq!(p["next_cursor"], p["head_seq"]);
    drop(l);
}

#[test]
fn cursor_y_limit_invalidos_se_rechazan_con_su_codigo() {
    let (_l, _d, _c, core) = core_listo();
    escena(&core, "x");
    let h = head(&core);
    for malo in [json!(-1), json!("-1"), json!("abc"), json!(1.5), json!(""), json!("1.5"), json!(" 3"), json!("+3"), json!(true), json!("99999999999999999999"), json!(u64::MAX)] {
        let e = falla(&core, &Caller::User, json!({ "cursor": malo }));
        assert_eq!(e.code, Code::InvalidCursor, "{malo}");
    }
    for malo in [json!(0), json!("0"), json!(-1), json!("x"), json!(2.5), json!("")] {
        let e = falla(&core, &Caller::User, json!({ "limit": malo }));
        assert_eq!(e.code, Code::InvalidLimit, "{malo}");
    }
    let e = falla(&core, &Caller::User, json!({ "cursor": h + 1 }));
    assert_eq!(e.code, Code::CursorAhead);
    assert!(lee(&core, json!({ "cursor": h.to_string(), "limit": "10" }))["limit"] == 10, "los enteros también llegan como texto decimal");
    assert_eq!(lee(&core, json!({ "limit": 100_000 }))["limit"], 500, "el límite se recorta al máximo y se informa");
    for grande in [json!(501), json!(i64::MAX), json!(i64::MAX as u64 + 1), json!(u64::MAX), json!("9223372036854775808"), json!("18446744073709551615"), json!("00000000000000000500")] {
        assert_eq!(lee(&core, json!({ "limit": grande }))["limit"], 500, "{grande}");
    }
    for fuera in [json!("18446744073709551616"), json!("100000000000000000000000"), json!(1e30)] {
        assert_eq!(falla(&core, &Caller::User, json!({ "limit": fuera })).code, Code::InvalidLimit, "{fuera}");
    }
    assert_eq!(falla(&core, &Caller::User, json!({ "cursor": i64::MAX as u64 + 1 })).code, Code::InvalidCursor, "el cursor sigue acotado a i64");
    assert_eq!(falla(&core, &Caller::User, json!({ "cursor": "9223372036854775808" })).code, Code::InvalidCursor);
    assert_eq!(falla(&core, &Caller::User, json!({ "cursor": i64::MAX })).code, Code::CursorAhead);
    for malo in [
        json!({ "nope": 1 }),
        json!({ "session": false }),
        json!({ "session": true }),
        json!({ "class": "otra" }),
        json!({ "project": "" }),
        json!({ "kind": "a", "kind_prefix": "a" }),
        json!({ "entity_id": "t1" }),
        json!({ "run": "x".repeat(129) }),
        json!({ "run": 5 }),
        json!([1]),
    ] {
        let e = falla(&core, &Caller::User, malo.clone());
        assert_eq!(e.code, Code::InvalidFilter, "{malo}");
    }
}

#[test]
fn parse_query_decodifica_y_rechaza_repetidos_y_codificaciones_rotas() {
    assert_eq!(
        parse_query("cursor=5&kind_prefix=task%2E&run=a+b&flag").unwrap(),
        json!({ "cursor": "5", "kind_prefix": "task.", "run": "a b", "flag": "" })
    );
    assert_eq!(parse_query("").unwrap(), json!({}));
    assert_eq!(parse_query("cursor=1&cursor=2").unwrap_err().code, Code::InvalidFilter);
    assert_eq!(parse_query("kind=%zz").unwrap_err().code, Code::InvalidFilter);
    assert_eq!(parse_query("kind=%4").unwrap_err().code, Code::InvalidFilter);
    assert_eq!(parse_query("kind=%ff").unwrap_err().code, Code::InvalidFilter);
}

#[test]
fn la_autorizacion_es_de_solo_lectura_y_acota_a_cada_agente_a_su_run() {
    let (_l, data, _c, core) = core_listo();
    let a = escena(&core, "a");
    let b = escena(&core, "b");
    let (rev_antes, head_antes) = (core.storage.confirmed_rev().unwrap(), head(&core));
    let estado_antes = std::fs::read(data.join("state.json")).ok();

    let como = |id: &str| Caller::Agent(Some(id.into()));
    let propios = core.events_read(&como(&a.hija), &json!({ "limit": 500 })).unwrap();
    assert_eq!(propios["events"].as_array().unwrap().len(), recorre(&core, 500, json!({ "run": a.run })).0.len());
    assert!(propios["events"].as_array().unwrap().iter().all(|e| e["run_id"] == a.run));
    assert!(core.events_read(&como(&a.raiz), &json!({ "run": a.run })).is_ok(), "pedir explícitamente el propio run es válido");
    assert_eq!(core.events_read(&como(&b.hija), &json!({})).unwrap()["events"][0]["run_id"], b.run);

    for pide in [json!({ "run": b.run }), json!({ "run": "inexistente" })] {
        assert_eq!(falla(&core, &como(&a.hija), pide).code, Code::Forbidden);
    }
    assert_eq!(falla(&core, &Caller::Agent(None), json!({})).code, Code::Forbidden);
    assert_eq!(falla(&core, &como("t-que-no-existe"), json!({})).code, Code::Forbidden);

    core.settings.lock().unwrap().enabled = false;
    assert_eq!(falla(&core, &como(&a.hija), json!({})).code, Code::Forbidden, "con el orquestador apagado, tampoco");
    assert!(core.events_read(&Caller::User, &json!({})).is_ok(), "la persona sigue leyendo");
    core.settings.lock().unwrap().enabled = true;

    assert_eq!((core.storage.confirmed_rev().unwrap(), head(&core)), (rev_antes, head_antes), "leer no escribe estado ni eventos");
    assert_eq!(std::fs::read(data.join("state.json")).ok(), estado_antes, "ni toca el espejo");
}

#[test]
fn el_comando_rpc_events_aplica_el_mismo_contrato_y_los_errores_llevan_su_codigo() {
    let (_l, _d, _c, core) = core_listo();
    let a = escena(&core, "a");
    let b = escena(&core, "b");
    let data = core.rpc(Caller::User, "", "events", &json!({ "kind_prefix": "run." })).unwrap();
    assert_eq!(data["v"], 1);
    assert_eq!(kinds(&data), ["run.created", "run.created"]);
    let de_agente = core.rpc(Caller::Agent(Some(a.hija.clone())), "", "events", &json!({})).unwrap();
    assert!(de_agente["events"].as_array().unwrap().iter().all(|e| e["run_id"] == a.run));
    let e = core.rpc(Caller::Agent(Some(a.hija)), "", "events", &json!({ "run": b.run })).unwrap_err();
    assert!(e.starts_with("forbidden: "), "{e}");
    let e = core.rpc(Caller::User, "", "events", &json!({ "cursor": "x" })).unwrap_err();
    assert!(e.starts_with("invalid_cursor: "), "{e}");
    for malo in [json!({ "session": false }), json!({ "session": true }), json!({ "nope": 1 }), json!({ "run": 5 }), json!({ "class": "otra" }), json!([1])] {
        for caller in [Caller::User, Caller::Agent(Some(b.hija.clone()))] {
            let e = core.rpc(caller, "", "events", &malo).unwrap_err();
            assert!(e.starts_with("invalid_filter: "), "{malo}: {e}");
        }
    }
}

#[test]
fn sin_almacen_sqlite_el_event_log_no_esta_disponible() {
    let core = Orch::default().0;
    let e = falla(&core, &Caller::User, json!({}));
    assert_eq!(e.code, Code::Unavailable);
    assert_eq!(e.code.http_status(), 503);
}

#[test]
fn el_codigo_de_cada_error_tiene_un_estado_http_estable() {
    let tabla = [
        (Code::InvalidCursor, "invalid_cursor", 400),
        (Code::InvalidLimit, "invalid_limit", 400),
        (Code::InvalidFilter, "invalid_filter", 400),
        (Code::Forbidden, "forbidden", 403),
        (Code::CursorAhead, "cursor_ahead", 409),
        (Code::Internal, "internal", 500),
        (Code::Unavailable, "event_log_unavailable", 503),
    ];
    for (c, nombre, http) in tabla {
        assert_eq!((c.as_str(), c.http_status()), (nombre, http));
    }
}

struct Respuesta {
    status: u16,
    cuerpo: Value,
}

fn http(port: u16, peticion: &str) -> Respuesta {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(peticion.as_bytes()).unwrap();
    let mut crudo = String::new();
    s.read_to_string(&mut crudo).unwrap();
    let status = crudo.split_whitespace().nth(1).unwrap().parse().unwrap();
    let cuerpo = crudo.split_once("\r\n\r\n").map(|(_, b)| serde_json::from_str(b).unwrap()).unwrap();
    Respuesta { status, cuerpo }
}

fn get(port: u16, ruta: &str, token: Option<&str>, caller: Option<&str>) -> Respuesta {
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let quien = caller.map(|c| format!("X-Lixbon-Caller: {c}\r\n")).unwrap_or_default();
    http(port, &format!("GET {ruta} HTTP/1.1\r\nHost: x\r\n{auth}{quien}\r\n"))
}

#[test]
fn el_endpoint_http_local_sirve_el_mismo_contrato_y_solo_lee() {
    let (_l, _d, _c, core) = core_listo();
    let a = escena(&core, "a");
    let b = escena(&core, "b");
    let token_a = "agent-events-read-a-test-secret-32-bytes";
    registra_agente_http(&core, &a.hija, "install-events-read-agent-a", token_a);
    let h = server::start(core.clone()).unwrap();
    let (rev_antes, head_antes) = (core.storage.confirmed_rev().unwrap(), head(&core));

    let r = get(h.port, "/events?limit=3", Some(token_a), None);
    assert_eq!(r.status, 200);
    assert_eq!(r.cuerpo["ok"], true);
    let d = &r.cuerpo["data"];
    assert_eq!((d["v"].clone(), d["limit"].clone()), (json!(1), json!(3)));
    assert!(d["events"].as_array().unwrap().iter().all(|e| e["run_id"] == a.run));
    let por_rpc = core.events_read(&Caller::Agent(Some(a.hija.clone())), &json!({ "limit": 3 })).unwrap();
    assert_eq!(*d, por_rpc, "HTTP y RPC devuelven el mismo documento");

    let paginado = get(h.port, &format!("/events?cursor={}&kind_prefix=task.&limit=500", d["next_cursor"]), Some(token_a), None);
    assert_eq!(paginado.status, 200);
    assert!(kinds(&paginado.cuerpo["data"]).iter().all(|k| k.starts_with("task.")));

    let r = get(h.port, "/events", Some(token_a), None);
    assert_eq!((r.status, r.cuerpo["ok"].clone()), (200, json!(true)));
    assert!(r.cuerpo["data"]["events"].as_array().unwrap().iter().all(|e| e["run_id"] == a.run));
    let r = get(h.port, &format!("/events?run={}", b.run), Some(token_a), None);
    assert_eq!((r.status, r.cuerpo["code"].clone()), (403, json!("forbidden")));
    let r = get(h.port, "/events?cursor=abc", Some(token_a), None);
    assert_eq!((r.status, r.cuerpo["code"].clone()), (400, json!("invalid_cursor")));
    let r = get(h.port, "/events?limit=0", Some(token_a), None);
    assert_eq!((r.status, r.cuerpo["code"].clone()), (400, json!("invalid_limit")));
    let r = get(h.port, "/events?cursor=1&cursor=2", Some(token_a), None);
    assert_eq!((r.status, r.cuerpo["code"].clone()), (400, json!("invalid_filter")));
    let r = get(h.port, "/events?cursor=999999", Some(token_a), None);
    assert_eq!((r.status, r.cuerpo["code"].clone()), (409, json!("cursor_ahead")));
    for ruta in ["/events?session=false", "/events?session=true", "/events?nope=1", "/events?class=otra", "/events?run="] {
        let r = get(h.port, ruta, Some(token_a), None);
        assert_eq!((r.status, r.cuerpo["code"].clone(), r.cuerpo["ok"].clone()), (400, json!("invalid_filter"), json!(false)), "{ruta}");
    }
    let r = get(h.port, "/events?limit=18446744073709551615", Some(token_a), None);
    assert_eq!((r.status, r.cuerpo["data"]["limit"].clone()), (200, json!(500)));
    let r = get(h.port, "/events?limit=18446744073709551616", Some(token_a), None);
    assert_eq!((r.status, r.cuerpo["code"].clone()), (400, json!("invalid_limit")));
    let r = get(h.port, "/events?cursor=9223372036854775808", Some(token_a), None);
    assert_eq!((r.status, r.cuerpo["code"].clone()), (400, json!("invalid_cursor")));

    assert_eq!(get(h.port, "/events", None, Some(&a.hija)).status, 401);
    assert_eq!(get(h.port, "/events", Some("incorrecto"), Some(&a.hija)).status, 401);
    for metodo in ["POST", "PUT", "DELETE", "PATCH"] {
        let peticion = format!("{metodo} /events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token_a}\r\nContent-Length: 2\r\n\r\n{{}}");
        let r = http(h.port, &peticion);
        assert_eq!(r.status, 405, "{metodo}");
    }
    let sin_token = http(h.port, "POST /events HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}");
    assert_eq!(sin_token.status, 401, "sin token ni siquiera se revela qué métodos admite");

    let cuerpo = json!({ "cmd": "events", "args": { "limit": 2 } }).to_string();
    let r = http(h.port, &format!("POST /rpc HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token_a}\r\nContent-Length: {}\r\n\r\n{cuerpo}", cuerpo.len()));
    assert_eq!((r.status, r.cuerpo["ok"].clone(), r.cuerpo["data"]["limit"].clone()), (200, json!(true), json!(2)));

    assert_eq!((core.storage.confirmed_rev().unwrap(), head(&core)), (rev_antes, head_antes), "el servidor no escribió nada");
    h.stop();
}

#[test]
fn person_cli_lee_event_log_global_sin_claims_ni_caller_header() {
    let (_l, _d, _c, core) = core_listo();
    let a = escena(&core, "person-cli-a");
    let b = escena(&core, "person-cli-b");
    let token = "person-cli-events-read-test-secret-32-bytes";
    registra_persona_cli_http(&core, "install-person-cli-events", token);
    let h = server::start(core.clone()).unwrap();

    let todos = get(h.port, "/events?limit=500", Some(token), Some("task-inventada"));
    assert_eq!(todos.status, 200, "la identidad Person CLI puede leer con su credencial, sin actor declarado");
    let events = todos.cuerpo["data"]["events"].as_array().unwrap();
    assert!(events.iter().any(|event| event["run_id"] == a.run));
    assert!(events.iter().any(|event| event["run_id"] == b.run));

    let run = get(h.port, &format!("/events?run={}", b.run), Some(token), None);
    assert_eq!(run.status, 200, "Person CLI conserva lectura global incluso con filtro de run");
    assert!(run.cuerpo["data"]["events"].as_array().unwrap().iter().all(|event| event["run_id"] == b.run));
    h.stop();
}

#[test]
fn la_identidad_del_agente_viene_de_la_credencial_y_caller_no_amplia_el_scope() {
    let (_l, _d, _c, core) = core_listo();
    let a = escena(&core, "a");
    let b = escena(&core, "b");
    let token_a = "agent-events-scope-a-test-secret-32-bytes";
    let token_b = "agent-events-scope-b-test-secret-32-bytes";
    registra_agente_http(&core, &a.hija, "install-events-scope-agent-a", token_a);
    registra_agente_http(&core, &b.hija, "install-events-scope-agent-b", token_b);
    let h = server::start(core.clone()).unwrap();

    let suplantada = get(h.port, "/events?limit=500", Some(token_a), Some(&b.hija));
    assert_eq!(suplantada.status, 200, "un caller header no cambia el actor de la credencial");
    assert!(suplantada.cuerpo["data"]["events"].as_array().unwrap().iter().all(|e| e["run_id"] == a.run));
    let propio_b = get(h.port, "/events?limit=500", Some(token_b), Some(&a.hija));
    assert_eq!(propio_b.status, 200);
    assert!(propio_b.cuerpo["data"]["events"].as_array().unwrap().iter().all(|e| e["run_id"] == b.run));
    assert_ne!(a.run, b.run);

    let desconocida = get(h.port, "/events", Some(token_a), Some("t-inventada"));
    assert_eq!(desconocida.status, 200);
    assert!(desconocida.cuerpo["data"]["events"].as_array().unwrap().iter().all(|e| e["run_id"] == a.run));
    h.stop();
}

#[test]
fn ninguna_capa_fuera_del_almacen_lee_sqlite_de_eventos() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    for nombre in ["events_read.rs", "server.rs", "rpc.rs"] {
        let texto = std::fs::read_to_string(src.join(nombre)).unwrap();
        let prod = texto.split("mod tests {").next().unwrap();
        for l in prod.lines().filter(|l| !l.trim_start().starts_with("//")) {
            assert!(!l.contains("rusqlite") && !l.contains("FROM events") && !l.contains("INTO events"), "{nombre}: {l}");
        }
    }
}

#[test]
#[ignore = "humo manual: LXO_SMOKE_DIR=<carpeta vacía> cargo test --lib humo_servidor_local -- --ignored"]
fn humo_servidor_local() {
    let dir = PathBuf::from(std::env::var("LXO_SMOKE_DIR").expect("LXO_SMOKE_DIR"));
    let (data, core_dir) = (dir.join("orch"), dir.join("core"));
    std::fs::create_dir_all(&data).unwrap();
    super::fsio::set_test_data_dir(&data);
    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    core.settings.lock().unwrap().enabled = true;
    let a = escena(&core, "humo-a");
    let b = escena(&core, "humo-b");
    let h = server::start(core.clone()).unwrap();
    let info = json!({ "port": h.port, "task_a": a.hija, "run_a": a.run, "task_b": b.hija, "run_b": b.run });
    std::fs::write(dir.join("info.json"), info.to_string()).unwrap();
    while !dir.join("stop").exists() {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    h.stop();
}

/// E2E contra el Core HTTP y el ejecutable real de `lxo`.
///
/// Reproducir en Windows desde `apps/desktop`:
/// `npm ci; npm run build:lxo; npm run build`
/// `$env:LXO_BIN = (Resolve-Path .\src-tauri\binaries\lxo-x86_64-pc-windows-msvc.exe).Path`
/// `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml orch::events_read_tests::lxo_bin_e2e_events_empty_history_pagination_and_follow_resume_no_duplicates -- --ignored --exact --nocapture`
#[test]
#[ignore = "requiere un binario lxo real indicado por LXO_BIN; ver apps/desktop/README.md"]
fn lxo_bin_e2e_events_empty_history_pagination_and_follow_resume_no_duplicates() {
    let binary = PathBuf::from(std::env::var_os("LXO_BIN").expect("define LXO_BIN con el binario lxo"));
    assert!(binary.is_file(), "LXO_BIN no apunta a un archivo: {}", binary.display());

    let (cleanup, _data, _core_dir, core) = core_listo();
    let scene = escena(&core, "lxo-bin-e2e");
    let token = "fixture-agent-lxo-events-token-with-32-bytes-minimum";
    registra_agente_http(&core, &scene.hija, "install-lxo-bin-events-e2e", token);
    let server = ServerParada(server::start(core.clone()).unwrap());

    // El proceso lxo solo puede ver este home temporal, incluido el cursor local.
    let home = cleanup.0.join("lxo-home");
    let lixbon_dir = home.join(".lixbon");
    std::fs::create_dir_all(&lixbon_dir).unwrap();
    std::fs::write(
        lixbon_dir.join("orch.json"),
        json!({
            "port": server.0.port,
            "version": env!("CARGO_PKG_VERSION"),
            "client_id": "client-agent-lxo-events-e2e",
            "installation_id": "install-lxo-bin-events-e2e"
        }).to_string(),
    ).unwrap();

    let head_actual = head(&core);
    assert!(head_actual >= 3, "la escena debe emitir hechos de prueba antes de consultar el cursor");

    // Cursor exclusivo igual al head: el caso vacío actual, con historia previa disponible.
    let head_text = head_actual.to_string();
    let empty = lxo_events_json(&binary, &home, &scene.hija, token,
        &["events", "--json", "--after", &head_text, "--limit", "2"]);
    assert_eq!(seqs(&empty), Vec::<i64>::new());
    assert_eq!(empty["next_cursor"], head_actual);
    assert_eq!(empty["head_seq"], head_actual);
    assert_eq!(empty["has_more"], false);

    // History: el CLI real recupera desde el inicio todos los hechos visibles al Agent.
    let history = lxo_events_json(&binary, &home, &scene.hija, token,
        &["events", "--json", "--after", "0", "--limit", "500"]);
    assert_eq!(seqs(&history), (1..=head_actual).collect::<Vec<_>>(),
        "history debe incluir cada secuencia una vez y en orden");
    assert!(history["events"].as_array().unwrap().iter().all(|event| event["run_id"] == scene.run));

    // Repetir invocaciones con next_cursor no deja huecos ni duplica secuencias.
    let mut page = lxo_events_json(&binary, &home, &scene.hija, token,
        &["events", "--json", "--after", "0", "--limit", "2"]);
    assert_eq!(page["events"].as_array().unwrap().len(), 2);
    assert_eq!(page["has_more"], true);
    let mut paginated = seqs(&page);
    let mut cursor = page["next_cursor"].as_i64().unwrap();
    let mut page_count = 1;
    while page["has_more"].as_bool().unwrap() {
        let cursor_text = cursor.to_string();
        page = lxo_events_json(&binary, &home, &scene.hija, token,
            &["events", "--json", "--after", &cursor_text, "--limit", "2"]);
        let next = page["next_cursor"].as_i64().unwrap();
        assert!(next > cursor, "una página siguiente debe avanzar el cursor");
        paginated.extend(seqs(&page));
        cursor = next;
        page_count += 1;
        assert!(page_count <= head_actual as usize, "el paginado debe terminar");
    }
    assert!(page_count >= 2, "la escena debe forzar más de una página");
    assert_eq!(paginated, (1..=head_actual).collect::<Vec<_>>());

    // Follow guarda el cursor en el home temporal. Cortar y relanzar el proceso
    // equivale a reconectar: los hechos posteriores salen una sola vez.
    assert!(lxo_cursor_values(&home).is_empty(), "el home recién creado no debe traer cursores previos");
    let initial_cursor = head_actual.to_string();
    let initial_args = ["events", "--json", "--follow", "--limit", "2", "--after", &initial_cursor];
    let mut first_follow = FollowProcess::start(&binary, &home, &scene.hija, token, &initial_args);
    wait_for_lxo_cursor(&home, head_actual as u64);
    first_follow.assert_quiet(Duration::from_millis(150));
    first_follow.stop();

    let before_new_facts = head(&core);
    core.mutate(|tx| {
        for n in 0..3 {
            let task = tx.add_child(&scene.raiz, 2, NewTask {
                external: false,
                ..nt(&format!("follow-reconnect-{n}"))
            })?;
            tx.mark_running(&task)?;
        }
        Ok(())
    }).unwrap();
    let head_with_new_facts = head(&core);
    let expected_follow = (before_new_facts + 1..=head_with_new_facts).collect::<Vec<_>>();
    assert!(expected_follow.len() >= 4, "la reconexión necesita hechos posteriores al cursor");

    let mut resumed = FollowProcess::start(&binary, &home, &scene.hija, token,
        &["events", "--json", "--follow", "--limit", "2"]);
    let lines = (0..expected_follow.len())
        .map(|_| resumed.next_line(Duration::from_secs(10)))
        .collect::<Vec<_>>();
    let resumed_seqs = lines.iter().map(|line| {
        serde_json::from_str::<Value>(line).unwrap()["seq"].as_i64().unwrap()
    }).collect::<Vec<_>>();
    assert_eq!(resumed_seqs, expected_follow, "follow debe reanudar desde el cursor confirmado");
    wait_for_lxo_cursor(&home, head_with_new_facts as u64);
    resumed.stop();

    let mut after_reconnect = FollowProcess::start(&binary, &home, &scene.hija, token,
        &["events", "--json", "--follow", "--limit", "2"]);
    after_reconnect.assert_quiet(Duration::from_millis(800));
    after_reconnect.stop();
    server.0.stop();
}

struct ServerParada(server::Handle);

impl Drop for ServerParada {
    fn drop(&mut self) { self.0.stop(); }
}

fn lxo_events_json(binary: &std::path::Path, home: &std::path::Path, task_id: &str,
    token: &str, args: &[&str]) -> Value {
    let output = Command::new(binary).args(args)
        .env("USERPROFILE", home).env("HOME", home)
        .env("LXO_TASK_ID", task_id).env("LXO_CLIENT_TOKEN", token)
        .output().unwrap_or_else(|error| panic!("no se pudo ejecutar lxo en {}: {error}", binary.display()));
    assert!(output.status.success(), "lxo {:?} terminó con {:?}; stdout={} stderr={}", args,
        output.status.code(), String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| panic!(
        "lxo {:?} no devolvió JSON válido ({error}): {}", args, String::from_utf8_lossy(&output.stdout)) )
}

struct FollowProcess { child: Child, lines: mpsc::Receiver<String>, stderr: Arc<Mutex<String>> }

impl FollowProcess {
    fn start(binary: &std::path::Path, home: &std::path::Path, task_id: &str,
        token: &str, args: &[&str]) -> Self {
        let mut child = Command::new(binary).args(args)
            .env("USERPROFILE", home).env("HOME", home)
            .env("LXO_TASK_ID", task_id).env("LXO_CLIENT_TOKEN", token)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().unwrap_or_else(|error| panic!("no se pudo iniciar lxo events --follow: {error}"));
        let stdout = child.stdout.take().expect("stdout canalizado");
        let stderr = child.stderr.take().expect("stderr canalizado");
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => if sender.send(line).is_err() { break; },
                    Err(_) => break,
                }
            }
        });
        let error_text = Arc::new(Mutex::new(String::new()));
        let error_sink = error_text.clone();
        thread::spawn(move || {
            let mut text = String::new();
            let mut reader = BufReader::new(stderr);
            let _ = reader.read_to_string(&mut text);
            *error_sink.lock().unwrap() = text;
        });
        Self { child, lines, stderr: error_text }
    }

    fn next_line(&mut self, timeout: Duration) -> String {
        match self.lines.recv_timeout(timeout) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => panic!("lxo --follow no emitió el evento a tiempo; stderr={}", self.stderr_text()),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let status = self.child.try_wait().ok().flatten();
                panic!("lxo --follow terminó antes de emitir; status={status:?}; stderr={}", self.stderr_text());
            }
        }
    }

    fn assert_quiet(&mut self, duration: Duration) {
        match self.lines.recv_timeout(duration) {
            Err(mpsc::RecvTimeoutError::Timeout) => {},
            Ok(line) => panic!("lxo --follow emitió un evento inesperado: {line}"),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let status = self.child.try_wait().ok().flatten();
                panic!("lxo --follow terminó durante el periodo vacío; status={status:?}; stderr={}", self.stderr_text());
            }
        }
        assert!(self.child.try_wait().unwrap().is_none(), "lxo --follow debe seguir activo mientras espera");
    }

    fn stop(&mut self) {
        if self.child.try_wait().unwrap().is_none() { let _ = self.child.kill(); }
        let _ = self.child.wait();
    }

    fn stderr_text(&self) -> String { self.stderr.lock().map(|text| text.clone()).unwrap_or_default() }
}

impl Drop for FollowProcess { fn drop(&mut self) { self.stop(); } }

fn lxo_cursor_values(home: &std::path::Path) -> Vec<u64> {
    let dir = home.join(".lixbon").join("events");
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries.flatten()
        .filter(|entry| entry.path().extension().and_then(|ext| ext.to_str()) == Some("cursor"))
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok()?.trim().parse().ok())
        .collect()
}

fn wait_for_lxo_cursor(home: &std::path::Path, cursor: u64) {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if lxo_cursor_values(home).contains(&cursor) { return; }
        assert!(Instant::now() < deadline, "lxo --follow no confirmó cursor {cursor}; guardados={:?}", lxo_cursor_values(home));
        thread::sleep(Duration::from_millis(10));
    }
}
