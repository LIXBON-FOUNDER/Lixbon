//! LXO-117 · el corte de datos Task/Attempt: fixture pequeña (== `normalizado.after.json`, la misma que comprueba
//! `verificar.py`), base vacía y fixture grande sintética; copia previa con sidecar; validación semántica; un corte que
//! falla no deja nada; idempotencia; Events históricos intactos; restauración; y que el arranque no lo activa.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Map, Value};

use super::agentic_cut::{check_copy, restore, run, verify_legacy_view, CutReport, BACKUP_LABEL};
use super::state::State;
use crate::store::{cut_migration, embedded, sha256_hex, EventQuery, Migration, Store, StoreError, AGENTIC_MODEL, CUT_NAME};

static N: AtomicU64 = AtomicU64::new(0);

const FIXTURE: &str = include_str!("../../../../../docs/core/fixtures/corte-task-attempt/legacy_state.before.json");
const AFTER: &str = include_str!("../../../../../docs/core/fixtures/corte-task-attempt/normalizado.after.json");
/// Checksum de la 014 (el corte), congelado al publicarla (LXO-234).
const CHECKSUM_014: &str = "4c6692565a1eb65a4422e839b43842356d34cfd5eb212529ec1cb1396a582b64";
const TABLAS: [&str; 13] =
    ["runs", "tasks", "attempts", "attempt_phases", "worktrees", "provider_sessions", "threads", "thread_messages", "artifacts", "decisions", "reviews", "env_blocks", "legacy_residue"];

/// Un directorio de datos con `core/` (la base) y el resto (`state.json`).
struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-cut-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(dir.join("core")).unwrap();
        Tmp(dir)
    }
    fn data(&self) -> &Path {
        &self.0
    }
    fn core(&self) -> PathBuf {
        self.0.join("core")
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn sql(s: &mut Store, q: &str) {
    s.write(|tx| Ok(tx.execute_batch(q)?)).unwrap();
}

/// Base anterior al corte (todas las migraciones publicadas), el Project `p-1` y `legacy_state = doc` en la rev 42.
/// Las migraciones de un binario anterior al corte (F2): todas menos el corte.
fn f2() -> Vec<Migration> {
    embedded().into_iter().filter(|m| m.name != CUT_NAME).collect()
}

fn base(t: &Tmp, doc: Option<&str>) -> Store {
    base_with(t, doc, &embedded())
}

fn base_with(t: &Tmp, doc: Option<&str>, migrations: &[Migration]) -> Store {
    let mut s = Store::open_with(&t.core(), migrations, "t").unwrap();
    sql(&mut s, "INSERT INTO projects (id, name, created_at, updated_at, fingerprint) VALUES ('p-1', 'app', 0, 0, '{}')");
    if let Some(doc) = doc {
        s.write(|tx| Ok(tx.execute("INSERT INTO legacy_state (id, rev, doc_schema, doc, updated_at) VALUES (1, 42, 0, ?1, 0)", [doc])?)).unwrap();
    }
    s
}

fn corta(s: &mut Store, t: &Tmp) -> CutReport {
    run(s, &t.core(), t.data(), "t").unwrap()
}

/// Las tablas del modelo como las vuelca `verificar.py` (`SELECT * … ORDER BY 1, 2`, columnas JSON decodificadas).
fn volcar(s: &Store) -> Value {
    s.read(|c| {
        let mut out = Map::new();
        for t in TABLAS {
            let mut q = c.prepare(&format!("SELECT * FROM {t} ORDER BY 1, 2"))?;
            let cols: Vec<String> = q.column_names().iter().map(|s| s.to_string()).collect();
            let filas = q
                .query_map([], |r| {
                    let mut fila = Map::new();
                    for (i, col) in cols.iter().enumerate() {
                        let v = match r.get_ref(i)? {
                            rusqlite::types::ValueRef::Null => Value::Null,
                            rusqlite::types::ValueRef::Integer(n) => json!(n),
                            rusqlite::types::ValueRef::Real(f) => json!(f),
                            rusqlite::types::ValueRef::Text(b) => {
                                let s = String::from_utf8_lossy(b).into_owned();
                                if ["policy", "requested_argv", "delivered", "files", "env_plan", "detail_json", "value"].contains(&col.as_str()) {
                                    serde_json::from_str(&s).unwrap_or(json!(s))
                                } else {
                                    json!(s)
                                }
                            }
                            rusqlite::types::ValueRef::Blob(_) => Value::Null,
                        };
                        fila.insert(col.clone(), v);
                    }
                    Ok(Value::Object(fila))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            out.insert(t.into(), json!(filas));
        }
        let meta: Map<String, Value> = c
            .prepare("SELECT key, value FROM meta WHERE key IN ('id_seq', 'f3_cut_legacy_rev', 'agentic_model') ORDER BY key")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, json!(r.get::<_, String>(1)?))))?
            .collect::<Result<_, _>>()?;
        out.insert("meta".into(), Value::Object(meta));
        Ok(Value::Object(out))
    })
    .unwrap()
}

fn esquema(s: &Store) -> Vec<String> {
    s.read(|c| Ok(c.prepare("SELECT type || ':' || name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY 1")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap()
}

fn backups(t: &Tmp) -> Vec<PathBuf> {
    let dir = t.core().join("backups");
    let mut v: Vec<PathBuf> = std::fs::read_dir(&dir).map(|d| d.map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|e| e == "db")).collect()).unwrap_or_default();
    v.sort();
    v
}

// ---------------------------------------------------------------------------------------------
// Fixtures: pequeña, vacía y grande
// ---------------------------------------------------------------------------------------------

#[test]
fn la_fixture_pequena_queda_igual_que_normalizado_after_y_el_informe_cuadra() {
    let t = Tmp::new();
    let mut s = base(&t, Some(FIXTURE));
    let CutReport::Applied { backup, before, after } = corta(&mut s, &t) else { panic!("se esperaba el corte") };
    let esperado: Value = serde_json::from_str(AFTER).unwrap();
    let hecho = volcar(&s);
    for tabla in TABLAS {
        assert_eq!(hecho[tabla], esperado[tabla], "tabla {tabla}");
    }
    assert_eq!(hecho["meta"], esperado["meta"]);
    // Antes / después.
    let legacy: Value = serde_json::from_str(FIXTURE).unwrap();
    assert_eq!((before.runs, before.tasks, before.messages, before.decisions), (3, legacy["tasks"].as_object().unwrap().len(), legacy["messages"].as_array().unwrap().len(), 4));
    assert_eq!(after.tasks as usize, before.tasks, "una Task legacy no se duplica");
    assert_eq!(after.attempts, after.tasks, "un Attempt n=1 por Task: no se fabrica historia");
    assert_eq!(after.legacy_residue, esperado["legacy_residue"].as_array().unwrap().len() as i64, "las anomalías van a residuo");
    assert!(backup.file_name().unwrap().to_string_lossy().contains(BACKUP_LABEL));
    // El modelo queda activo, `legacy_state` congelado y el corte registrado como la versión siguiente.
    assert!(s.agentic_model_active().unwrap());
    assert_eq!(s.schema_version().unwrap(), cut_migration().version);
    assert!(s.write(|tx| Ok(tx.execute("UPDATE legacy_state SET rev = rev + 1", [])?)).unwrap_err().to_string().contains("congelado"));
    // Su hecho, en la misma transacción.
    let ev = s.events_page(&EventQuery { kind: Some("core.agentic_cut".into()), limit: Some(10), ..Default::default() }).unwrap().events;
    assert_eq!(ev.len(), 1);
    let p: Value = serde_json::from_str(&ev[0].payload).unwrap();
    assert_eq!((p["model"].as_str(), p["counts"]["tasks"].as_i64()), (Some(AGENTIC_MODEL), Some(after.tasks)));
    assert_eq!(p["backup"].as_str(), backup.file_name().and_then(|n| n.to_str()));
}

#[test]
fn una_base_vacia_se_corta_sin_filas() {
    let t = Tmp::new();
    let mut s = base(&t, None);
    let CutReport::Applied { before, after, .. } = corta(&mut s, &t) else { panic!("se esperaba el corte") };
    assert_eq!(before, Default::default());
    assert_eq!(after, Default::default());
    assert!(s.agentic_model_active().unwrap());
    // Con el documento vacío que deja una instalación nueva, igual.
    let t2 = Tmp::new();
    let vacio = serde_json::to_string(&State::default()).unwrap();
    let mut s2 = base(&t2, Some(&vacio));
    assert!(matches!(corta(&mut s2, &t2), CutReport::Applied { .. }));
}

/// Un documento grande con todos los casos: raíces e hijas, Worktree activo, rama conservada, checkout compartido de la
/// raíz, los 8 estados, sesiones declaradas (Claude stream-json, Codex session_id) y atadas por carpeta y hora,
/// coordinadores externos, fases, Artifacts, mensajes y revisiones.
fn grande(runs: usize, hijas: usize) -> (String, usize) {
    const ESTADOS: [&str; 8] = ["starting", "running", "waiting", "awaiting_terminal_approval", "done", "failed", "stopped", "exited"];
    let (mut tasks, mut rs, mut msgs, mut decs) = (Map::new(), Map::new(), vec![], vec![]);
    let mut seq = 0u64;
    let mut next = || {
        seq += 1;
        seq
    };
    let mut verificadas = 0;
    for r in 0..runs {
        let rid = format!("r{}", next());
        let root = format!("t{}", next());
        rs.insert(rid.clone(), json!({ "id": rid, "objective": format!("objetivo {r}"), "root": root, "created": 1_000 + r, "closed": r % 3 == 0, "last_activity": 2_000 + r }));
        tasks.insert(
            root.clone(),
            json!({ "id": root, "run": rid, "parent": null, "depth": 0, "agent": "claude", "title": "coordinar", "repo": "/r/app", "project_id": if r % 5 == 0 { json!(null) } else { json!("p-1") },
                    "cwd": "/r/app", "branch": "main", "base": null, "worktree": null, "status": ESTADOS[r % 8], "external": r % 7 == 0, "created": 1_000 + r, "updated": 1_500 + r }),
        );
        for h in 0..hijas {
            let id = format!("t{}", next());
            let n = r * hijas + h;
            let (agent, stream, sref, smatch) = match n % 4 {
                0 => ("claude", true, json!(format!("uuid-{id}")), json!(null)),
                1 => ("codex", false, json!(format!("/home/s/rollout-{id}.jsonl")), json!("session_id")),
                2 => ("codex", false, json!(format!("/home/s/quiza-{id}.jsonl")), json!("cwd_time")),
                _ => ("codex", false, json!(null), json!(null)),
            };
            if n % 4 < 2 {
                verificadas += 1;
            }
            let (wt, branch, base) = match n % 3 {
                0 => (json!(format!("/r/app.wt/{id}")), json!(format!("lx/{rid}/{id}")), json!("main")),
                1 => (json!(null), json!(format!("lx/{rid}/{id}")), json!("main")),
                _ => (json!(null), json!(null), json!(null)),
            };
            let mut t = json!({ "id": id, "run": rid, "parent": root, "depth": 1, "agent": agent, "model": "m", "title": format!("hija {h}"), "spec": "hacer", "repo": "/r/app",
                                "project_id": "p-1", "cwd": "/r/app", "branch": branch, "base": base, "worktree": wt, "status": ESTADOS[n % 8], "stream_json": stream,
                                "session_ref": sref, "session_match": smatch, "model_source": "session_declared", "merged": n % 5 == 0,
                                "phases": [{ "name": "tests", "done": true, "note": "", "at": 3_000 }], "summary": "ok", "files": ["a.rs"],
                                "attempt_started": 2_500, "created": 2_000 + n, "updated": 2_100 + n });
            if n % 6 == 0 {
                t["report"] = json!(format!("/r/app/.lixbon/informes/{rid}/{id}.md"));
                t["pr_url"] = json!(format!("https://github.com/a/app/pull/{n}"));
            }
            tasks.insert(id.clone(), t);
            msgs.push(json!({ "id": next(), "run": rid, "from": id, "to": root, "kind": "question", "body": "¿sigo?", "at": 4_000 }));
            msgs.push(json!({ "id": next(), "run": rid, "from": root, "to": id, "kind": "reply", "body": "sí", "read": true, "at": 4_100 }));
            if n % 10 == 0 {
                let detail = json!({ "decision": "accepted", "head_commit": "c0ffee", "comment": null }).to_string();
                decs.push(json!({ "id": next(), "task": id, "kind": "review", "actor": "human", "detail_json": detail, "at": 5_000 }));
            }
            if n % 20 == 0 {
                let detail = json!({ "decision": "rejected", "head_commit": "d00d00", "comment": "otra vuelta" }).to_string();
                decs.push(json!({ "id": next(), "task": id, "kind": "review", "actor": "human", "detail_json": detail, "at": 6_000 }));
            }
        }
    }
    let doc = json!({ "runs": rs, "tasks": tasks, "messages": msgs, "seq": seq, "decisions": decs, "env_blocks": { "codex/explorar": "windows_sandbox_elevated" } });
    (doc.to_string(), verificadas)
}

#[test]
fn una_fixture_grande_con_todos_los_casos_se_corta_entera_y_sin_inventar() {
    let (doc, verificadas) = grande(40, 25);
    let t = Tmp::new();
    let mut s = base(&t, Some(&doc));
    let CutReport::Applied { before, after, .. } = corta(&mut s, &t) else { panic!("se esperaba el corte") };
    assert_eq!((before.tasks, after.tasks as usize, after.attempts as usize), (40 * 26, 40 * 26, 40 * 26));
    assert_eq!(after.provider_sessions as usize, verificadas, "solo las sesiones declaradas por el proveedor");
    assert_eq!(after.thread_messages as usize, before.messages);
    let d = volcar(&s);
    let residuo = d["legacy_residue"].as_array().unwrap();
    assert_eq!(residuo.iter().filter(|r| r["reason"] == "session_not_verified").count(), 40 * 25 / 4, "las atadas por carpeta y hora quedan en residuo");
    assert_eq!(residuo.iter().filter(|r| r["reason"] == "project_not_registered").count(), 0, "una Task sin Project no es una anomalía de proyecto");
    assert!(d["tasks"].as_array().unwrap().iter().filter(|t| t["project_id"].is_null()).count() > 0, "Tasks legacy sin Project se permiten (D1)");
    let estados: std::collections::BTreeSet<&str> = d["attempts"].as_array().unwrap().iter().map(|a| a["status"].as_str().unwrap()).collect();
    assert_eq!(estados.len(), 8, "los 8 estados legacy, finales y activos");
    let wts = d["worktrees"].as_array().unwrap();
    assert!(wts.iter().any(|w| w["state"] == "active") && wts.iter().any(|w| w["state"] == "removed" && w["branch_kept"] == 1));
    assert!(d["attempts"].as_array().unwrap().iter().all(|a| a["ended_at"].is_null()), "el legado no registra el fin: no se inventa");
    // Varias revisiones legacy de la misma Task: la última queda activa y las anteriores, sustituidas (LXO-118).
    let reviews = d["reviews"].as_array().unwrap();
    let (activas, sustituidas) = (reviews.iter().filter(|r| r["status"] == "active").count(), reviews.iter().filter(|r| r["status"] == "superseded").count());
    assert_eq!((activas, sustituidas), (40 * 25 / 10, 40 * 25 / 20));
    assert!(reviews.iter().filter(|r| r["status"] == "superseded").all(|r| r["closed_at"] == 6_000));
}

// ---------------------------------------------------------------------------------------------
// Copia previa, fallos e idempotencia
// ---------------------------------------------------------------------------------------------

#[test]
fn la_copia_previa_es_un_conjunto_coherente_con_su_sidecar() {
    let t = Tmp::new();
    std::fs::write(t.data().join("state.json"), FIXTURE).unwrap();
    std::fs::write(t.core().join("authority.json"), br#"{"v":1}"#).unwrap();
    let mut s = base(&t, Some(FIXTURE));
    let antes = esquema(&s);
    let CutReport::Applied { backup, .. } = corta(&mut s, &t) else { panic!("se esperaba el corte") };
    let sc = check_copy(&backup).unwrap();
    assert_eq!((sc.label.as_str(), sc.user_version, sc.legacy_rev, sc.integrity_check.as_str()), (BACKUP_LABEL, cut_migration().version - 1, Some(42), "ok"));
    assert_eq!(sc.legacy_doc_sha256.as_deref(), Some(sha256_hex(FIXTURE.as_bytes()).as_str()));
    assert_eq!(sc.db_sha256, sha256_hex(&std::fs::read(&backup).unwrap()));
    let dir = backup.parent().unwrap();
    assert_eq!(std::fs::read_to_string(dir.join(sc.state_json.unwrap())).unwrap(), FIXTURE);
    assert_eq!(std::fs::read(dir.join(sc.authority_json.unwrap())).unwrap(), br#"{"v":1}"#);
    // La copia es la base de antes del corte.
    let copia = Store::open_with(&{
        let d = t.data().join("copia");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::copy(&backup, d.join("lixbon.db")).unwrap();
        d
    }, &embedded(), "t")
    .unwrap();
    assert_eq!(esquema(&copia), antes);
    assert!(!copia.agentic_model_active().unwrap());
}

#[test]
fn un_documento_que_no_es_un_state_o_una_base_en_otra_version_no_llegan_a_copiarse() {
    let t = Tmp::new();
    let mut s = base(&t, Some(r#"{"runs":{},"tasks":{"t1":{"id":"t1","status":"zombie"}},"messages":[],"seq":1}"#));
    assert!(matches!(run(&mut s, &t.core(), t.data(), "t"), Err(StoreError::CutPreflight(_))));
    let t2 = Tmp::new();
    let viejas: Vec<Migration> = embedded().into_iter().filter(|m| m.version < cut_migration().version - 1).collect();
    let mut s2 = base_with(&t2, Some(FIXTURE), &viejas);
    assert!(matches!(run(&mut s2, &t2.core(), t2.data(), "t"), Err(StoreError::CutPreflight(m)) if m.contains("versión")));
    let t3 = Tmp::new();
    let mut s3 = base(&t3, Some(FIXTURE));
    sql(&mut s3, "UPDATE legacy_state SET doc_schema = 1");
    assert!(matches!(run(&mut s3, &t3.core(), t3.data(), "t"), Err(StoreError::CutPreflight(m)) if m.contains("doc_schema")));
    assert!(backups(&t).is_empty() && backups(&t2).is_empty() && backups(&t3).is_empty(), "sin comprobación previa no hay copia ni corte");
}

#[test]
fn un_corte_que_falla_a_mitad_deja_la_base_exactamente_como_estaba() {
    // Un Run cuya raíz no existe: se lee como State, pero las comprobaciones del corte lo rechazan.
    let mut roto: Value = serde_json::from_str(FIXTURE).unwrap();
    roto["runs"]["r99"] = json!({ "id": "r99", "objective": "x", "root": "t999", "created": 1 });
    let t = Tmp::new();
    let mut s = base(&t, Some(&roto.to_string()));
    let antes = (esquema(&s), s.legacy_state().unwrap(), s.schema_version().unwrap());
    assert!(matches!(run(&mut s, &t.core(), t.data(), "t"), Err(StoreError::MigrationFailed { .. })));
    assert_eq!((esquema(&s), s.legacy_state().unwrap(), s.schema_version().unwrap()), antes);
    assert!(!s.agentic_model_active().unwrap());
    assert_eq!(backups(&t).len(), 1, "la copia previa se hizo antes y se conserva");
}

#[test]
fn si_la_validacion_semantica_falla_se_deshace_todo() {
    let t = Tmp::new();
    let mut s = base(&t, Some(FIXTURE));
    let antes = (esquema(&s), s.legacy_state().unwrap());
    let r = s.agentic_cut_recorded(&cut_migration(), "t", |_, _| Err(StoreError::MigrationFailed { version: 0, name: "x".into(), detail: "a propósito".into() }));
    assert!(r.is_err());
    assert_eq!((esquema(&s), s.legacy_state().unwrap()), antes);
    // Y la comprobación de verdad detecta una vista que no cuadra con el documento.
    let t2 = Tmp::new();
    let mut s2 = base(&t2, Some(FIXTURE));
    corta(&mut s2, &t2);
    let mut otro: State = serde_json::from_str(FIXTURE).unwrap();
    otro.tasks.get_mut("t3").unwrap().title = "otro título".into();
    let e = s2.cut_view(|v| verify_legacy_view(v, &otro)).unwrap_err().to_string();
    assert!(e.contains("t3") && e.contains("title"), "{e}");
    let mut menos: State = serde_json::from_str(FIXTURE).unwrap();
    menos.messages.remove(0);
    assert!(s2.cut_view(|v| verify_legacy_view(v, &menos)).is_err());
}

/// Liberar una tarea integrada borra su rama (`git branch -d`): el documento conserva la base sin worktree ni rama. Esa
/// Task se corta con su Worktree quitado y sin rama, y la vista legacy la reconstruye igual (LXO-232).
#[test]
fn una_tarea_liberada_cuya_rama_se_borro_se_corta_con_su_base() {
    let mut doc: Value = serde_json::from_str(FIXTURE).unwrap();
    doc["tasks"]["t5"]["branch"] = Value::Null;
    doc["tasks"]["t5"]["merged"] = json!(true);
    let t = Tmp::new();
    let mut s = base(&t, Some(&doc.to_string()));
    assert!(matches!(corta(&mut s, &t), CutReport::Applied { .. }), "la validación semántica no la rechaza");
    let fila: (String, i64, Option<String>, Option<String>) = s
        .read(|c| Ok(c.query_row("SELECT state, branch_kept, branch, base_branch FROM worktrees WHERE task_id = 't5'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?))
        .unwrap();
    assert_eq!(fila, ("removed".into(), 0, None, Some("main".into())));
    let vista = s.cut_view(|v| v.legacy_task("t5")).unwrap();
    assert_eq!((vista["branch"].clone(), vista["base"].clone(), vista["worktree"].clone()), (Value::Null, json!("main"), Value::Null));
}

#[test]
fn cortar_dos_veces_no_hace_nada_la_segunda() {
    let t = Tmp::new();
    let mut s = base(&t, Some(FIXTURE));
    corta(&mut s, &t);
    let (filas, eventos) = (volcar(&s), s.events_page(&EventQuery { limit: Some(500), ..Default::default() }).unwrap().events.len());
    assert_eq!(corta(&mut s, &t), CutReport::AlreadyCut);
    assert_eq!(s.agentic_cut_recorded(&cut_migration(), "t", |_, _| unreachable!()).unwrap(), crate::store::CutOutcome::AlreadyCut);
    assert_eq!(volcar(&s), filas);
    assert_eq!(s.events_page(&EventQuery { limit: Some(500), ..Default::default() }).unwrap().events.len(), eventos);
    assert_eq!(backups(&t).len(), 1, "sin una segunda copia");
}

#[test]
fn los_events_historicos_no_se_reescriben() {
    let t = Tmp::new();
    let mut s = base(&t, Some(FIXTURE));
    sql(
        &mut s,
        "INSERT INTO events (id, at, v, kind, class, actor_kind, entity_kind, entity_id, run_id, payload) VALUES
           ('e1', 1, 1, 'task.created', 'state', 'system', 'task', 't3', 'r1', '{\"title\":\"API\"}'),
           ('e2', 2, 1, 'task.status_changed', 'state', 'system', 'task', 't3', 'r1', '{\"from\":\"running\",\"to\":\"done\"}')",
    );
    let antes: Vec<String> = s.read(|c| Ok(c.prepare("SELECT id || kind || entity_kind || entity_id || payload FROM events ORDER BY seq")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    corta(&mut s, &t);
    let despues: Vec<String> = s.read(|c| Ok(c.prepare("SELECT id || kind || entity_kind || entity_id || payload FROM events ORDER BY seq")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert_eq!(despues[..antes.len()], antes[..], "los task.* siguen apuntando a la Task, sin reescribir");
    assert_eq!(despues.len(), antes.len() + 1, "solo se añade core.agentic_cut");
}

// ---------------------------------------------------------------------------------------------
// Rollback y activación
// ---------------------------------------------------------------------------------------------

#[test]
fn restaurar_la_copia_vuelve_a_la_base_anterior_al_corte_y_aparta_la_cortada() {
    let t = Tmp::new();
    std::fs::write(t.data().join("state.json"), FIXTURE).unwrap();
    std::fs::write(t.core().join("authority.json"), br#"{"v":1}"#).unwrap();
    let mut s = base(&t, Some(FIXTURE));
    let antes = esquema(&s);
    let CutReport::Applied { backup, .. } = corta(&mut s, &t) else { panic!("se esperaba el corte") };
    // Mientras el Core está abierto (bloqueo tomado) no se restaura.
    assert!(restore(&t.core(), t.data(), &backup).is_err());
    drop(s);
    // Un binario anterior al corte no toca la base cortada; uno con el corte, sí la abre.
    assert!(matches!(Store::open_with(&t.core(), &f2(), "f2"), Err(StoreError::DatabaseNewer { .. })));
    drop(Store::open_with(&t.core(), &embedded(), "f3").unwrap());
    std::fs::write(t.data().join("state.json"), b"escrito tras el corte").unwrap();

    let apartada = restore(&t.core(), t.data(), &backup).unwrap();
    assert!(apartada.join("lixbon.db").exists(), "la base cortada se aparta, no se borra");
    let mut r = Store::open_with(&t.core(), &f2(), "f2").unwrap();
    assert_eq!(esquema(&r), antes);
    assert_eq!(r.schema_version().unwrap(), cut_migration().version - 1);
    let legacy = r.legacy_state().unwrap().unwrap();
    assert_eq!((legacy.rev, legacy.doc.as_str()), (42, FIXTURE));
    r.save_legacy_state(42, FIXTURE).unwrap();
    assert_eq!(std::fs::read_to_string(t.data().join("state.json")).unwrap(), FIXTURE, "el espejo vuelve al del mismo conjunto");
    assert_eq!(std::fs::read(t.core().join("authority.json")).unwrap(), br#"{"v":1}"#);
}

#[test]
fn una_copia_que_no_cuadra_con_su_sidecar_no_se_restaura() {
    let t = Tmp::new();
    let mut s = base(&t, Some(FIXTURE));
    let CutReport::Applied { backup, .. } = corta(&mut s, &t) else { panic!("se esperaba el corte") };
    drop(s);
    let sidecar = backup.with_file_name(format!("{}.json", backup.file_name().unwrap().to_string_lossy()));
    let mut sc: Value = serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
    sc["db_sha256"] = json!("0".repeat(64));
    std::fs::write(&sidecar, serde_json::to_vec(&sc).unwrap()).unwrap();
    assert!(restore(&t.core(), t.data(), &backup).is_err());
    assert!(Store::open_with(&t.core(), &embedded(), "f3").unwrap().agentic_model_active().unwrap(), "la base cortada sigue en su sitio");
}

/// LXO-234: el corte es la 014, pero el migrador general nunca la aplica (es una barrera): solo `agentic_cut::run`, que
/// llama el arranque con el interruptor. Nadie más ejecuta el corte ni la restauración.
#[test]
fn el_migrador_no_aplica_el_corte_y_solo_el_arranque_con_el_interruptor_lo_ejecuta() {
    let t = Tmp::new();
    let s = Store::open(&t.core(), "t").unwrap();
    assert!(!s.agentic_model_active().unwrap() && !s.agentic_cut_done().unwrap());
    assert_eq!(s.schema_version().unwrap(), cut_migration().version - 1, "todas las publicadas menos el corte");
    assert!(embedded().iter().any(|m| m.name == CUT_NAME), "el corte vive en migrations/");
    assert_eq!(cut_migration().version, 14);
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for dir in ["orch", "store"] {
        for entrada in std::fs::read_dir(src.join(dir)).unwrap() {
            let ruta = entrada.unwrap().path();
            let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
            if !nombre.ends_with(".rs") || nombre.ends_with("_tests.rs") || ["agentic_cut.rs", "cut.rs"].contains(&nombre.as_str()) {
                continue;
            }
            let texto = std::fs::read_to_string(&ruta).unwrap();
            for (sim, donde) in [("agentic_cut::run", "boot_authority.rs"), (".agentic_cut_recorded(", ""), ("agentic_cut::restore(", ""), ("agentic_cut::restore_pending", "lifecycle.rs")] {
                assert!(!texto.contains(sim) || nombre == donde, "{dir}/{nombre} llama a «{sim}»: solo {donde:?} puede");
            }
        }
    }
}

/// La 014 publicada no se edita: su checksum queda congelado desde LXO-234.
#[test]
fn la_014_del_corte_tiene_el_checksum_congelado() {
    assert_eq!(cut_migration().checksum(), CHECKSUM_014, "una migración publicada no se edita: el cambio va en otra");
}
