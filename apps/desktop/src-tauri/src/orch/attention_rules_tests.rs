//! LXO-88 · reglas Events → Attention.
//!
//! Los fixtures salen de los caminos REALES del Core (`ask`/`reply`, `spawn`, mutadores de `Tx`, decisiones de
//! integración) sobre un Core con SQLite: se leen del Event Log y se proyectan en un almacén limpio. Los casos de
//! orden, replay y estado previo usan Events sintéticos con la forma exacta de esos payloads.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{json, Value};

use super::attention_rules::{derive, EventRules};
use super::events::{Channel, MutationContext};
use crate::store::{apply_attention_in, project_attention_in, AttentionRules, Derived, ActorKind, AttentionCategory, AttentionStatus, EventClass, EventRow, Intent, ProjectError, Report, Resolution, Severity, Store, StoreError};

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

static N: AtomicUsize = AtomicUsize::new(0);

pub(super) struct Dir(std::path::PathBuf);

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Un almacén limpio e independiente (no toca la carpeta de datos del hilo).
pub(super) fn abre() -> (Dir, Store) {
    let n = N.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("lixbon-attn88-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let store = Store::open(&dir, "t").unwrap();
    (Dir(dir), store)
}

fn fila(seq: i64, kind: &str, entidad: (&str, &str), payload: Value) -> EventRow {
    EventRow {
        seq,
        id: format!("0192f0a0-0000-7000-8000-{seq:012}"),
        at: 1_000 + seq * 10,
        v: 1,
        kind: kind.into(),
        class: EventClass::State,
        actor_kind: ActorKind::Agent,
        actor_id: Some("t1".into()),
        channel: Some("lxo".into()),
        client_id: None,
        project_id: Some("p1".into()),
        run_id: Some("r1".into()),
        entity_kind: entidad.0.into(),
        entity_id: entidad.1.into(),
        correlation_id: None,
        idem_key: None,
        state_rev: None,
        payload: payload.to_string(),
    }
}

fn pregunta(seq: i64, tarea: &str, mensaje: u64) -> EventRow {
    fila(seq, "task.question", ("task", tarea), json!({ "message_id": mensaje, "to": "user" }))
}
fn respuesta(seq: i64, tarea: &str, pregunta: u64) -> EventRow {
    fila(seq, "task.reply", ("task", tarea), json!({ "question_id": pregunta, "message_id": pregunta + 100 }))
}
fn estado(seq: i64, tarea: &str, de: &str, a: &str, causa: Option<&str>) -> EventRow {
    let mut p = json!({ "from": de, "to": a });
    if let Some(c) = causa {
        p["cause"] = json!(c);
    }
    fila(seq, "task.status_changed", ("task", tarea), p)
}
fn solicitud(seq: i64, pid: &str, policy: &str) -> EventRow {
    fila(
        seq,
        "spawn.requested",
        ("spawn_request", pid),
        json!({ "parent_task": "t1", "provider": "claude", "profile": "explorar", "title": "x", "shared": true, "policy_status": policy, "expires_at": 9 }),
    )
}
fn resolucion(seq: i64, pid: &str, outcome: &str) -> EventRow {
    fila(seq, "spawn.resolved", ("spawn_request", pid), json!({ "outcome": outcome, "has_reason": false }))
}
fn integracion(seq: i64, tarea: &str, outcome: &str, conflictos: u64) -> EventRow {
    fila(
        seq,
        "decision.recorded",
        ("task", tarea),
        json!({ "decision_kind": "merge", "decision_id": 1, "outcome": outcome, "branch": "lx/r1/t2", "squash": false, "conflict_count": conflictos }),
    )
}
fn retirada(seq: i64, tarea: &str) -> EventRow {
    fila(seq, "task.removed", ("task", tarea), json!({ "cause": "launch_failed" }))
}

pub(super) fn aplica(s: &mut Store, despues: i64, evs: &[EventRow]) -> Report {
    s.write(|tx| apply_attention_in(tx, &EventRules, despues, evs).map_err(StoreError::from)).unwrap()
}

/// Como `aplica`, conservando el error tipado (deshace la transacción si falla).
fn intenta(s: &mut Store, despues: i64, evs: &[EventRow]) -> Result<Report, ProjectError> {
    let mut salida = None;
    let _ = s.write(|tx| match apply_attention_in(tx, &EventRules, despues, evs) {
        Ok(r) => {
            salida = Some(Ok(r));
            Ok(())
        }
        Err(e) => {
            salida = Some(Err(e));
            Err(StoreError::InvalidEvent("rollback".into()))
        }
    });
    salida.unwrap()
}

fn texto(v: rusqlite::types::Value) -> String {
    match v {
        rusqlite::types::Value::Text(t) => t,
        rusqlite::types::Value::Integer(i) => i.to_string(),
        rusqlite::types::Value::Null => "NULL".into(),
        otro => format!("{otro:?}"),
    }
}

/// Todas las filas de `attention_items`, ordenadas, como texto comparable.
pub(super) fn instantanea(s: &Store) -> Vec<Vec<String>> {
    s.read(|c| {
        let mut st = c
            .prepare(
                "SELECT id, fingerprint, occurrence, category, severity, status, target_kind, target_id, project_id, run_id, subject, source_event_id,
                        correlation_id, facts, created_at, updated_at, resolved_at, resolution
                 FROM attention_items ORDER BY fingerprint, occurrence",
            )
            .unwrap();
        let n = st.column_count();
        let filas = st
            .query_map([], |r| Ok((0..n).map(|i| texto(r.get::<_, rusqlite::types::Value>(i).unwrap())).collect::<Vec<_>>()))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        Ok(filas)
    })
    .unwrap()
}

/// `(kind, entity_id, idem_key)` de los `attention.*` del log, ordenados.
pub(super) fn ciclo_de_vida(s: &Store) -> Vec<(String, String, Option<String>)> {
    s.read(|c| {
        let mut st = c.prepare("SELECT kind, entity_id, idem_key FROM events WHERE kind LIKE 'attention.%' ORDER BY entity_id, kind").unwrap();
        let filas = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        Ok(filas)
    })
    .unwrap()
}

pub(super) fn categorias_activas(s: &Store) -> Vec<String> {
    let mut v: Vec<String> = s
        .read(|c| {
            let mut st = c.prepare("SELECT category FROM attention_items WHERE status = 'active' ORDER BY category").unwrap();
            Ok(st.query_map([], |r| r.get::<_, String>(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap())
        })
        .unwrap();
    v.sort();
    v
}

fn una(r: &Report) -> &crate::store::AttentionRow {
    assert_eq!(r.created.len() + r.updated.len() + r.resolved.len(), 1, "se esperaba un único cambio: {r:?}");
    r.created.first().or(r.updated.first()).or(r.resolved.first()).unwrap()
}

// ---------------------------------------------------------------------------------------------
// Fixtures por categoría (caminos reales del Core)
// ---------------------------------------------------------------------------------------------

mod reales {
    use super::*;
    use crate::orch::spawn_cleanup_tests::{desde, fake, head, setup_con, Env};
    use crate::orch::Caller;

    fn proyecta_todo(e: &Env) -> (Dir, Store, Report) {
        let log = desde(&e.core, 0);
        let (d, mut s) = abre();
        let r = aplica(&mut s, 0, &log);
        (d, s, r)
    }

    fn pide(e: &Env, perfil: &str) -> Result<Value, String> {
        e.core.rpc(Caller::Agent(Some(e.root.clone())), "", "spawn", &json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true, "profile": perfil }))
    }

    #[test]
    fn risk_parte_del_event_que_produce_el_camino_real_de_spawn() {
        let e = setup_con("attn-risk", fake);
        pide(&e, "autonomia_amplia").expect_err("denegación explícita de policy");
        let log = desde(&e.core, 0);
        let solicitud = log.iter().find(|ev| ev.kind == "spawn.requested").expect("el camino real deja el Event");
        assert_eq!(serde_json::from_str::<Value>(&solicitud.payload).unwrap()["policy_status"], "blocked");

        let (_d, s, r) = proyecta_todo(&e);
        let riesgo = r.created.iter().find(|a| a.category == AttentionCategory::Risk).expect("risk");
        assert_eq!((riesgo.severity, riesgo.status), (Severity::High, AttentionStatus::Active));
        assert_eq!((riesgo.target.kind.as_str(), riesgo.target.id.as_str()), ("spawn_request", solicitud.entity_id.as_str()));
        assert_eq!(riesgo.source_event_id.as_deref(), Some(solicitud.id.as_str()));
        assert_eq!(categorias_activas(&s), vec!["risk"], "y nada más: no hay approval de un lanzamiento denegado");
        let facts: Value = serde_json::from_str(&riesgo.facts).unwrap();
        assert!(facts.get("reason").is_none() && facts.get("argv").is_none());
    }

    #[test]
    fn un_bloqueo_del_entorno_no_deja_event_y_por_tanto_no_crea_risk() {
        let e = setup_con("attn-env", |p, prof, role, wt| {
            let mut pol = fake(p, prof, role, wt);
            pol.status = crate::orch::agents::Status::Blocked;
            pol
        });
        pide(&e, "explorar").expect_err("bloqueado por el entorno");
        let (_d, s, r) = proyecta_todo(&e);
        assert!(r.created.is_empty() && categorias_activas(&s).is_empty());
    }

    #[test]
    fn approval_de_un_lanzamiento_pendiente_se_resuelve_al_decidirlo() {
        let e = setup_con("attn-approval", fake);
        let pendiente = pide(&e, "explorar").unwrap();
        let pid = pendiente["pending_id"].as_str().unwrap().to_string();
        let (_d, mut s, r) = proyecta_todo(&e);
        let aprobacion = una(&r).clone();
        assert_eq!((aprobacion.category, aprobacion.severity, aprobacion.target.id.as_str()), (AttentionCategory::Approval, Severity::Medium, pid.as_str()));
        assert_eq!(categorias_activas(&s), vec!["approval"]);

        let antes = head(&e.core);
        e.core.reject_spawn(&pid, true, Some("no")).unwrap();
        let r = aplica(&mut s, 0, &desde(&e.core, antes));
        let resuelta = una(&r);
        assert_eq!((resuelta.id.as_str(), resuelta.status, resuelta.resolution), (aprobacion.id.as_str(), AttentionStatus::Resolved, Some(Resolution::Acted)));
        assert!(categorias_activas(&s).is_empty());
    }

    #[test]
    fn question_se_levanta_con_la_pregunta_y_se_resuelve_con_la_respuesta() {
        let e = setup_con("attn-question", fake);
        // La raíz no tiene a quién preguntar: pregunta una hija.
        let pid = e.spawn(true);
        e.aprobar(&pid);
        let hija = e.hijas().pop().expect("la hija aprobada");
        let id = e.core.rpc(Caller::Agent(Some(hija.clone())), "", "ask", &json!({ "question": "¿rama?" })).unwrap()["question"].as_u64().unwrap();
        let (_d, mut s, r) = proyecta_todo(&e);
        let pregunta = r.created.iter().find(|a| a.category == AttentionCategory::Question).expect("question");
        assert_eq!((pregunta.target.id.as_str(), pregunta.subject.as_deref(), pregunta.severity), (hija.as_str(), Some(id.to_string().as_str()), Severity::Medium));

        let antes = head(&e.core);
        e.core.rpc(Caller::User, "", "reply", &json!({ "question": id, "answer": "sí" })).unwrap();
        let r = aplica(&mut s, 0, &desde(&e.core, antes));
        assert_eq!(r.resolved.iter().filter(|a| a.category == AttentionCategory::Question).count(), 1);
        assert!(!categorias_activas(&s).contains(&"question".to_string()));
    }

    #[test]
    fn approval_en_terminal_failed_y_conflict_salen_de_los_mutadores_reales() {
        let e = setup_con("attn-terminal", fake);
        let ctx = MutationContext::core();
        e.core.mutate_as(&ctx, |tx| tx.await_terminal_approval(&e.root, 123)).unwrap();
        let (_d, mut s, r) = proyecta_todo(&e);
        let terminal = r.created.iter().find(|a| a.category == AttentionCategory::Approval).expect("approval en terminal");
        assert_eq!((terminal.target.id.as_str(), terminal.subject.as_deref()), (e.root.as_str(), Some("terminal")));

        // Vence el plazo: se resuelve la aprobación (`condition_cleared`) y el fallo pide atención.
        let antes = head(&e.core);
        e.core.mutate_as(&ctx, |tx| tx.fail_with(&e.root, "terminal_approval_timeout", "nadie aprobó")).unwrap();
        let r = aplica(&mut s, 0, &desde(&e.core, antes));
        assert_eq!(r.resolved.len(), 1);
        assert_eq!((r.resolved[0].category, r.resolved[0].resolution), (AttentionCategory::Approval, Some(Resolution::ConditionCleared)));
        let fallo = r.created.iter().find(|a| a.category == AttentionCategory::Failed).expect("failed");
        assert_eq!(serde_json::from_str::<Value>(&fallo.facts).unwrap()["failure_reason"], "terminal_approval_timeout");
        assert_eq!(fallo.severity, Severity::High);

        // Una integración con conflicto sobre esa tarea.
        let antes = head(&e.core);
        e.core
            .mutate_as(&MutationContext::person(Channel::Ui), |tx| {
                tx.record_decision(&e.root, "merge", "human", &json!({ "outcome": "conflict", "branch": "lx/r1/t2", "squash": false, "conflicts": ["a.txt", "b.txt"] }))
            })
            .unwrap();
        let r = aplica(&mut s, 0, &desde(&e.core, antes));
        let conflicto = r.created.iter().find(|a| a.category == AttentionCategory::Conflict).expect("conflict");
        assert_eq!(serde_json::from_str::<Value>(&conflicto.facts).unwrap()["conflict_count"], 2);
        assert_eq!(categorias_activas(&s), vec!["conflict", "failed"]);
    }
}

// ---------------------------------------------------------------------------------------------
// Reglas (Events con la forma real de los payloads)
// ---------------------------------------------------------------------------------------------

#[test]
fn question_y_reply_son_por_pregunta_y_el_reply_resuelve_solo_la_suya() {
    let (_d, mut s) = abre();
    let r = aplica(&mut s, 0, &[pregunta(1, "t1", 7), pregunta(2, "t1", 8)]);
    assert_eq!(r.created.len(), 2, "dos preguntas de una misma tarea son dos hechos");
    let r = aplica(&mut s, 2, &[respuesta(3, "t1", 7)]);
    assert_eq!((una(&r).subject.as_deref(), una(&r).resolution), (Some("7"), Some(Resolution::Acted)));
    assert_eq!(categorias_activas(&s), vec!["question"], "la otra sigue activa");
}

#[test]
fn approval_de_spawn_ok_y_unverified_y_sus_resoluciones() {
    let casos = [("approved", Resolution::Acted), ("rejected", Resolution::Acted), ("launch_failed", Resolution::Acted), ("timeout", Resolution::ConditionCleared), ("coordinator_closed", Resolution::ConditionCleared), ("cancelled_run_removed", Resolution::ConditionCleared)];
    for (i, (outcome, esperada)) in casos.into_iter().enumerate() {
        let (_d, mut s) = abre();
        let estado_policy = if i % 2 == 0 { "ok" } else { "unverified" };
        let r = aplica(&mut s, 0, &[solicitud(1, "sp1", estado_policy)]);
        assert_eq!((una(&r).category, una(&r).severity), (AttentionCategory::Approval, Severity::Medium), "{estado_policy}");
        let r = aplica(&mut s, 1, &[resolucion(2, "sp1", outcome)]);
        assert_eq!(una(&r).resolution, Some(esperada), "{outcome}");
    }
}

#[test]
fn approval_en_terminal_se_resuelve_segun_como_se_sale_de_la_espera() {
    for (a, esperada) in [("running", Resolution::Acted), ("waiting", Resolution::Acted), ("failed", Resolution::ConditionCleared), ("stopped", Resolution::ConditionCleared)] {
        let (_d, mut s) = abre();
        aplica(&mut s, 0, &[estado(1, "t1", "running", "awaiting_terminal_approval", Some("terminal_approval"))]);
        let r = aplica(&mut s, 1, &[estado(2, "t1", "awaiting_terminal_approval", a, None)]);
        let resuelta = r.resolved.iter().find(|x| x.category == AttentionCategory::Approval).expect("approval resuelta");
        assert_eq!(resuelta.resolution, Some(esperada), "{a}");
    }
}

#[test]
fn conflict_se_levanta_se_actualiza_sin_duplicar_y_se_resuelve_al_integrar() {
    let (_d, mut s) = abre();
    let r = aplica(&mut s, 0, &[integracion(1, "t2", "conflict", 2)]);
    let id = una(&r).id.clone();
    assert_eq!((una(&r).category, una(&r).severity), (AttentionCategory::Conflict, Severity::High));

    let r = aplica(&mut s, 1, &[integracion(2, "t2", "conflict", 5)]);
    assert!(r.created.is_empty(), "el mismo conflicto no crea otro item");
    assert_eq!((una(&r).id.as_str(), serde_json::from_str::<Value>(&una(&r).facts).unwrap()["conflict_count"].clone()), (id.as_str(), json!(5)));
    assert_eq!(instantanea(&s).len(), 1);
    assert_eq!(ciclo_de_vida(&s).len(), 1, "actualizar no emite eventos: solo existe attention.created");

    let r = aplica(&mut s, 2, &[integracion(3, "t2", "merged", 0)]);
    assert_eq!((una(&r).id.as_str(), una(&r).resolution), (id.as_str(), Some(Resolution::Acted)));
}

#[test]
fn error_y_target_moved_no_son_conflicto() {
    let (_d, mut s) = abre();
    let r = aplica(&mut s, 0, &[integracion(1, "t2", "error", 0), integracion(2, "t2", "target_moved", 0)]);
    assert_eq!(r, Report::default());
}

#[test]
fn failed_recurre_como_otra_ocurrencia_y_el_task_removed_resuelve() {
    let (_d, mut s) = abre();
    let r = aplica(&mut s, 0, &[estado(1, "t1", "running", "failed", Some("agent_idle_timeout"))]);
    let primera = una(&r).clone();
    assert_eq!(primera.occurrence, 1);
    let r = aplica(&mut s, 1, &[estado(2, "t1", "failed", "running", Some("reopened"))]);
    assert_eq!(una(&r).resolution, Some(Resolution::ConditionCleared));
    let r = aplica(&mut s, 2, &[estado(3, "t1", "running", "failed", None)]);
    assert_eq!((una(&r).occurrence, una(&r).id != primera.id), (2, true), "el hecho recurrente es una ocurrencia nueva");
    let r = aplica(&mut s, 3, &[retirada(4, "t1")]);
    assert_eq!(r.resolved.len(), 1);
    assert!(categorias_activas(&s).is_empty());
}

#[test]
fn las_senales_informativas_y_los_estados_ordinarios_no_crean_attention() {
    let (_d, mut s) = abre();
    let ruido = vec![
        fila(1, "task.created", ("task", "t1"), json!({ "agent": "claude", "depth": 0, "external": true, "parent": null, "role": null, "model": null, "title": "x" })),
        fila(2, "task.phase", ("task", "t1"), json!({ "name": "p", "done": false })),
        estado(3, "t1", "starting", "running", None),
        estado(4, "t1", "running", "waiting", Some("question")),
        estado(5, "t1", "running", "done", None),
        estado(6, "t1", "running", "stopped", None),
        fila(7, "run.created", ("run", "r1"), json!({ "root_task": "t1" })),
        fila(8, "run.closed", ("run", "r1"), json!({ "forced": false, "stopped": [], "stopped_total": 0 })),
        fila(9, "effect.observed", ("task", "t1"), json!({ "effect_kind": "git_worktree", "effect_id": "e", "operation": "spawn", "branch": "lx/r1/t2" })),
        fila(10, "effect.observed", ("task", "t1"), json!({ "effect_kind": "git_merge", "effect_id": "e2", "operation": "integrate", "result": "conflict", "branch": "b" })),
        fila(11, "decision.recorded", ("task", "t1"), json!({ "decision_kind": "review", "decision_id": 1, "outcome": "accepted", "head_commit": "abc", "has_comment": false })),
        fila(12, "decision.recorded", ("task", "t1"), json!({ "decision_kind": "pr", "decision_id": 2, "outcome": "created", "branch": "b" })),
        fila(13, "project.registered", ("project", "p1"), json!({ "origin": "manual", "name": "n", "has_remote": false, "root_commit_count": 1 })),
        fila(14, "attention.created", ("attention", "att_x"), json!({ "category": "failed" })),
    ];
    let r = aplica(&mut s, 0, &ruido);
    assert_eq!(r, Report::default());
    assert!(instantanea(&s).is_empty());
}

#[test]
fn review_ready_y_environment_blocked_no_tienen_senal_durable_y_ningun_event_las_infiere() {
    // GAP documentado en ATTENTION.md: no existe un Event que diga «revisión lista» ni «entorno bloqueado». Una tarea
    // `done` con rama, la ausencia de una decisión de revisión o un `failed` con cualquier causa NO son esa señal.
    let causas = ["agent_idle_timeout", "terminal_approval_timeout", "helper_unknown_error", "environment_blocked", "setup refresh had errors"];
    let mut todos: Vec<EventRow> = vec![estado(1, "t1", "running", "done", None), fila(2, "decision.recorded", ("task", "t1"), json!({ "decision_kind": "review", "decision_id": 1, "outcome": "rejected", "head_commit": "abc", "has_comment": true }))];
    for (i, c) in causas.iter().enumerate() {
        todos.push(estado(10 + i as i64, "t9", "running", "failed", Some(c)));
        todos.push(solicitud(30 + i as i64, &format!("sp{i}"), if i % 2 == 0 { "ok" } else { "unverified" }));
    }
    for ev in &todos {
        for intent in derive(ev).intents {
            if let Intent::Raise { key, .. } = intent {
                assert!(
                    !matches!(key.category, AttentionCategory::ReviewReady | AttentionCategory::EnvironmentBlocked | AttentionCategory::Risk),
                    "{} no puede levantar {:?}",
                    ev.kind,
                    key.category
                );
            }
        }
    }
}

#[test]
fn solo_policy_status_blocked_levanta_risk() {
    for policy in ["ok", "unverified", "otro", ""] {
        assert!(derive(&solicitud(1, "sp1", policy)).intents.iter().all(|i| !matches!(i, Intent::Raise { key, .. } if key.category == AttentionCategory::Risk)), "{policy:?}");
    }
    let intents = derive(&solicitud(1, "sp1", "blocked")).intents;
    assert_eq!(intents.len(), 1);
    assert!(matches!(&intents[0], Intent::Raise { key, severity: Severity::High, .. } if key.category == AttentionCategory::Risk));
    // Ni el fallo de un lanzamiento ni su resolución crean risk.
    for ev in [resolucion(2, "sp1", "launch_failed"), resolucion(3, "sp1", "rejected"), estado(4, "t1", "running", "failed", Some("spawn_blocked"))] {
        assert!(derive(&ev).intents.iter().all(|i| !matches!(i, Intent::Raise { key, .. } if key.category == AttentionCategory::Risk)));
    }
}

#[test]
fn risk_no_se_resuelve_sola_ni_por_la_resolucion_de_otro_lanzamiento() {
    let (_d, mut s) = abre();
    aplica(&mut s, 0, &[solicitud(1, "sp1", "blocked")]);
    let r = aplica(&mut s, 1, &[resolucion(2, "sp1", "timeout"), resolucion(3, "sp1", "rejected"), retirada(4, "sp1")]);
    assert!(r.resolved.is_empty());
    assert_eq!(categorias_activas(&s), vec!["risk"]);
}

// ---------------------------------------------------------------------------------------------
// Determinismo, replay, duplicados, orden
// ---------------------------------------------------------------------------------------------

fn escenario() -> Vec<EventRow> {
    vec![
        pregunta(1, "t1", 7),
        estado(2, "t1", "running", "waiting", Some("question")),
        solicitud(3, "sp1", "unverified"),
        solicitud(4, "sp2", "blocked"),
        respuesta(5, "t1", 7),
        estado(6, "t1", "waiting", "running", Some("answered")),
        integracion(7, "t2", "conflict", 1),
        resolucion(8, "sp1", "approved"),
        estado(9, "t2", "running", "failed", Some("agent_idle_timeout")),
        integracion(10, "t2", "conflict", 3),
        estado(11, "t2", "failed", "running", Some("reopened")),
        estado(12, "t2", "running", "awaiting_terminal_approval", Some("terminal_approval")),
        estado(13, "t2", "awaiting_terminal_approval", "failed", Some("terminal_approval_timeout")),
        integracion(14, "t2", "merged", 0),
        pregunta(15, "t3", 9),
        retirada(16, "t2"),
        estado(17, "t3", "running", "failed", None),
    ]
}

#[test]
fn replay_desde_cero_es_igual_al_estado_incremental() {
    let log = escenario();
    let (_a, mut incremental) = abre();
    let mut marca = 0;
    for e in &log {
        aplica(&mut incremental, marca, std::slice::from_ref(e));
        marca = e.seq;
    }
    let (_b, mut de_una) = abre();
    aplica(&mut de_una, 0, &log);
    let (_c, mut por_tramos) = abre();
    for tramo in log.chunks(4) {
        aplica(&mut por_tramos, tramo[0].seq - 1, tramo);
    }
    let foto = instantanea(&incremental);
    assert!(!foto.is_empty());
    assert_eq!(instantanea(&de_una), foto, "replay desde cero = incremental");
    assert_eq!(instantanea(&por_tramos), foto, "los tramos no cambian el resultado");
    assert_eq!(ciclo_de_vida(&de_una), ciclo_de_vida(&incremental));
    assert_eq!(ciclo_de_vida(&por_tramos), ciclo_de_vida(&incremental));
}

#[test]
fn reaplicar_todo_el_log_sobre_un_estado_ya_poblado_no_cambia_nada() {
    let log = escenario();
    let (_a, mut s) = abre();
    aplica(&mut s, 0, &log);
    let (foto, vida) = (instantanea(&s), ciclo_de_vida(&s));
    for _ in 0..3 {
        let r = aplica(&mut s, 0, &log);
        assert!(r.created.is_empty() && r.updated.is_empty() && r.resolved.is_empty(), "un replay no escribe: {r:?}");
        assert_eq!(r.lifecycle_events, 0);
        assert_eq!(instantanea(&s), foto, "ni filas ni ocurrencias nuevas");
        assert_eq!(ciclo_de_vida(&s), vida);
    }
}

#[test]
fn mismos_events_mismos_ids_y_filas_en_una_instalacion_reconstruida() {
    let log = escenario();
    let (_a, mut uno) = abre();
    let (_b, mut otro) = abre();
    aplica(&mut uno, 0, &log);
    aplica(&mut otro, 0, &log);
    assert_eq!(instantanea(&uno), instantanea(&otro));
}

#[test]
fn duplicados_y_reintentos_no_duplican_items() {
    let (_d, mut s) = abre();
    let e = pregunta(1, "t1", 7);
    aplica(&mut s, 0, std::slice::from_ref(&e));
    // El mismo Event otra vez (con y sin marca de agua) y el mismo hecho desde otro Event posterior e igual.
    let r = aplica(&mut s, 0, std::slice::from_ref(&e));
    assert_eq!((r.stale, r.created.len()), (1, 0));
    let r = aplica(&mut s, 1, std::slice::from_ref(&e));
    assert_eq!((r.skipped_old, r.created.len()), (1, 0));
    let repetida = pregunta(2, "t1", 7);
    let r = aplica(&mut s, 1, &[repetida]);
    assert!(r.created.is_empty() && r.resolved.is_empty(), "el mismo hecho activo no crea otro item");
    assert_eq!(instantanea(&s).len(), 1);
    assert_eq!(ciclo_de_vida(&s).len(), 1, "un solo attention.created");
}

#[test]
fn resolver_es_idempotente_y_no_reescribe_la_resolucion() {
    let (_d, mut s) = abre();
    aplica(&mut s, 0, &[pregunta(1, "t1", 7)]);
    aplica(&mut s, 1, &[respuesta(2, "t1", 7)]);
    let foto = instantanea(&s);
    let r = aplica(&mut s, 2, &[respuesta(3, "t1", 7), respuesta(4, "t1", 7)]);
    assert_eq!((r.noop, r.resolved.len()), (2, 0));
    assert_eq!(instantanea(&s), foto, "ni `resolved_at` ni el motivo cambian");
    // Resolver lo que nunca se levantó tampoco escribe.
    let r = aplica(&mut s, 4, &[respuesta(5, "t1", 99)]);
    assert_eq!(r.noop, 1);
    assert_eq!(instantanea(&s), foto);
}

#[test]
fn un_tramo_fuera_de_orden_se_rechaza_entero_y_no_escribe() {
    let (_d, mut s) = abre();
    for tramo in [vec![respuesta(7, "t1", 7), pregunta(5, "t1", 7)], vec![pregunta(5, "t1", 7), pregunta(5, "t1", 8)], vec![pregunta(1, "t1", 1), pregunta(3, "t1", 2), pregunta(2, "t1", 3)]] {
        match intenta(&mut s, 0, &tramo) {
            Err(ProjectError::OutOfOrder { previous, got }) => assert!(got <= previous),
            otro => panic!("se esperaba OutOfOrder, salió {otro:?}"),
        }
        assert!(instantanea(&s).is_empty() && ciclo_de_vida(&s).is_empty(), "no hay efecto parcial");
    }
    // El mismo contenido en orden por `seq` sí se aplica, aunque `at` sea contrario.
    let mut a = pregunta(5, "t1", 7);
    a.at = 9_000;
    let mut b = respuesta(7, "t1", 7);
    b.at = 100;
    let r = aplica(&mut s, 0, &[a, b]);
    assert_eq!((r.created.len(), r.resolved.len()), (1, 1), "manda el seq, no la hora");
    assert!(r.resolved[0].resolved_at >= Some(r.created[0].created_at), "`at` nunca resuelve antes de crear");
}

#[test]
fn una_senal_antigua_no_se_reaplica_sobre_un_hecho_posterior() {
    let (_d, mut s) = abre();
    // Falla (5), se reabre (6), vuelve a fallar (8): segunda ocurrencia.
    aplica(&mut s, 0, &[estado(5, "t1", "running", "failed", None), estado(6, "t1", "failed", "running", None), estado(8, "t1", "running", "failed", None)]);
    let foto = instantanea(&s);
    // Llega tarde la reapertura (6) y el primer fallo (5): ya están superados por el seq 8.
    let r = aplica(&mut s, 0, &[estado(5, "t1", "running", "failed", None), estado(6, "t1", "failed", "running", None)]);
    assert_eq!((r.stale, r.created.len(), r.resolved.len()), (2, 0, 0));
    assert_eq!(instantanea(&s), foto, "la ocurrencia 2 sigue activa");
    assert_eq!(categorias_activas(&s), vec!["failed"]);

    // Una respuesta con seq menor que la pregunta que volvió a hacerse no la resuelve.
    let (_d2, mut s2) = abre();
    aplica(&mut s2, 0, &[pregunta(10, "t1", 7)]);
    let r = aplica(&mut s2, 0, &[respuesta(4, "t1", 7)]);
    assert_eq!((r.stale, r.resolved.len()), (1, 0));
    assert_eq!(categorias_activas(&s2), vec!["question"]);
}

#[test]
fn lo_ya_resuelto_no_se_levanta_de_nuevo_por_un_replay_de_su_event_de_origen() {
    let (_d, mut s) = abre();
    aplica(&mut s, 0, &[pregunta(1, "t1", 7), respuesta(2, "t1", 7)]);
    let foto = instantanea(&s);
    let r = aplica(&mut s, 0, &[pregunta(1, "t1", 7)]);
    assert_eq!((r.stale, r.created.len()), (1, 0));
    assert_eq!(instantanea(&s), foto, "no hay segunda ocurrencia");
}

#[test]
fn una_senal_con_destino_invalido_se_descarta_sin_abortar_el_tramo() {
    let (_d, mut s) = abre();
    let r = aplica(&mut s, 0, &[pregunta(1, "C:\\ruta\\mala", 7), pregunta(2, "t1", 8), estado(3, "../x", "running", "failed", None)]);
    assert_eq!((r.created.len(), r.invalid), (1, 2));
    assert_eq!(categorias_activas(&s), vec!["question"]);
}

// ---------------------------------------------------------------------------------------------
// Ciclo de vida: attention.created / attention.resolved en la misma transacción
// ---------------------------------------------------------------------------------------------

#[test]
fn attention_created_y_resolved_se_emiten_una_vez_con_solo_codigos_e_ids() {
    let (_d, mut s) = abre();
    aplica(&mut s, 0, &[pregunta(1, "t1", 7)]);
    aplica(&mut s, 1, &[respuesta(2, "t1", 7)]);
    let eventos = s.events_page(&crate::store::EventQuery { limit: Some(50), ..Default::default() }).unwrap().events;
    assert_eq!(eventos.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["attention.created", "attention.resolved"]);
    let fila = &instantanea(&s)[0];
    let id = fila[0].clone();
    for e in &eventos {
        assert_eq!((e.entity_kind.as_str(), e.entity_id.as_str(), e.class), ("attention", id.as_str(), EventClass::State));
        assert_eq!((e.actor_kind, e.channel.as_deref()), (ActorKind::System, Some("core")));
        assert_eq!((e.correlation_id.as_deref(), e.idem_key.as_deref()), (Some(id.as_str()), Some(id.as_str())));
        assert_eq!((e.project_id.as_deref(), e.run_id.as_deref()), (Some("p1"), Some("r1")));
        let p: Value = serde_json::from_str(&e.payload).unwrap();
        assert!(p.get("facts").is_none() && p.get("title").is_none() && p.get("message").is_none());
    }
    let creado: Value = serde_json::from_str(&eventos[0].payload).unwrap();
    assert_eq!((creado["category"].as_str(), creado["severity"].as_str(), creado["occurrence"].as_i64(), creado["target_kind"].as_str()), (Some("question"), Some("medium"), Some(1), Some("task")));
    assert_eq!(creado["source_event_id"], "0192f0a0-0000-7000-8000-000000000001");
    let resuelto: Value = serde_json::from_str(&eventos[1].payload).unwrap();
    assert_eq!((resuelto["resolution"].as_str(), resuelto["source_event_id"].as_str()), (Some("acted"), Some("0192f0a0-0000-7000-8000-000000000002")));
}

#[test]
fn la_attention_y_sus_events_se_confirman_o_se_deshacen_juntos() {
    let (_d, mut s) = abre();
    let r: Result<(), StoreError> = s.write(|tx| {
        let (rep, derivados) = project_attention_in(tx, &EventRules, 0, &[pregunta(1, "t1", 7)]).map_err(StoreError::from)?;
        crate::store::insert_derived_in(tx, &derivados, None)?;
        assert_eq!((rep.created.len(), rep.lifecycle_events), (1, 1));
        Err(StoreError::InvalidEvent("se deshace".into()))
    });
    assert!(r.is_err());
    assert!(instantanea(&s).is_empty() && ciclo_de_vida(&s).is_empty(), "ni la fila ni su attention.created");
    aplica(&mut s, 0, &[pregunta(1, "t1", 7)]);
    assert_eq!((instantanea(&s).len(), ciclo_de_vida(&s).len()), (1, 1));
}

// ---------------------------------------------------------------------------------------------
// Invariantes que no dependen del cliente
// ---------------------------------------------------------------------------------------------

#[test]
fn las_reglas_son_funciones_de_los_events_y_no_leen_estado_de_cliente_ni_de_lectura() {
    // Un Event idéntico produce las mismas intenciones sin importar actor, canal, `client_id` ni hora.
    let base = pregunta(1, "t1", 7);
    let mut otro = base.clone();
    otro.actor_kind = ActorKind::Person;
    otro.actor_id = None;
    otro.channel = Some("ui".into());
    otro.client_id = Some("desktop-A".into());
    otro.at = 42;
    assert_eq!(derive(&base), derive(&otro));
    // Y el módulo no menciona lectura/cliente.
    let fuente = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/orch/attention_rules.rs")).unwrap();
    let produccion = fuente.split("#[cfg(test)]").next().unwrap();
    for prohibido in ["unread", "client_id", "disconnect", "std::fs", "git::", "now_ms", "SystemTime"] {
        assert!(!produccion.contains(prohibido), "las reglas no pueden depender de {prohibido}");
    }
}

// ---------------------------------------------------------------------------------------------
// Actualización de severity/metadata sin duplicar (el driver, con reglas inyectadas)
// ---------------------------------------------------------------------------------------------

/// Reglas de prueba: cada Event levanta el MISMO hecho con la severidad que indica `n` (`event_seq % 4`).
#[derive(Debug)]
struct SeveridadVariable;

impl AttentionRules for SeveridadVariable {
    fn derive(&self, e: &EventRow) -> Derived {
        let severidad = [Severity::Low, Severity::Medium, Severity::High, Severity::Critical][(e.seq % 4) as usize];
        let mut d = Derived::default();
        d.raise(AttentionCategory::Failed, crate::store::TargetKind::Task, "t1", None, severidad, json!({ "n": e.seq }));
        d
    }
}

#[test]
fn el_mismo_hecho_con_otra_severidad_actualiza_la_activa_sin_duplicar_ni_cambiar_la_identidad() {
    let (_d, mut s) = abre();
    let evs = |seq: i64| fila(seq, "task.status_changed", ("task", "t1"), json!({}));
    let aplica_con = |s: &mut Store, despues: i64, e: EventRow| s.write(|tx| apply_attention_in(tx, &SeveridadVariable, despues, &[e]).map_err(StoreError::from)).unwrap();

    let r = aplica_con(&mut s, 0, evs(1)); // Medium
    let creada = una(&r).clone();
    assert_eq!((creada.severity, creada.occurrence), (Severity::Medium, 1));
    let r = aplica_con(&mut s, 1, evs(3)); // Critical
    let subida = una(&r);
    assert_eq!((subida.id.as_str(), subida.severity, subida.occurrence, subida.created_at), (creada.id.as_str(), Severity::Critical, 1, creada.created_at));
    assert_eq!(serde_json::from_str::<Value>(&subida.facts).unwrap()["n"], 3, "los facts se reemplazan");
    assert!(subida.updated_at >= creada.created_at);
    let r = aplica_con(&mut s, 3, evs(4)); // Low: baja
    assert_eq!((una(&r).id.as_str(), una(&r).severity), (creada.id.as_str(), Severity::Low));
    assert_eq!(instantanea(&s).len(), 1, "una sola fila para el hecho");
    assert_eq!(ciclo_de_vida(&s).len(), 1, "actualizar no emite eventos: solo el attention.created inicial");
    // Una actualización con un Event antiguo no revierte la severidad.
    let r = aplica_con(&mut s, 0, evs(2));
    assert_eq!((r.stale, r.updated.len()), (1, 0));
}

/// Reglas de prueba: el Event de `kind` `test.levanta` levanta el hecho y el de `kind` `test.resuelve` lo resuelve.
#[derive(Debug)]
struct LevantaYResuelve;

impl AttentionRules for LevantaYResuelve {
    fn derive(&self, e: &EventRow) -> Derived {
        let mut d = Derived::default();
        match e.kind.as_str() {
            "test.levanta" => d.raise(AttentionCategory::Failed, crate::store::TargetKind::Task, "t1", None, Severity::High, json!({})),
            "test.resuelve" => d.resolve(AttentionCategory::Failed, crate::store::TargetKind::Task, "t1", None, Resolution::Acted),
            _ => {}
        }
        d
    }
}

#[test]
fn una_resolucion_con_el_mismo_seq_que_la_ultima_senal_del_hecho_se_descarta_y_una_posterior_resuelve() {
    let (_d, mut s) = abre();
    let aplica_con = |s: &mut Store, despues: i64, e: EventRow| s.write(|tx| apply_attention_in(tx, &LevantaYResuelve, despues, &[e]).map_err(StoreError::from)).unwrap();
    let ev = |seq: i64, kind: &str| fila(seq, kind, ("task", "t1"), json!({}));

    aplica_con(&mut s, 0, ev(5, "test.levanta"));
    // Mismo seq que la señal que tocó el hecho: no es posterior, no resuelve.
    let r = aplica_con(&mut s, 0, ev(5, "test.resuelve"));
    assert_eq!((r.stale, r.resolved.len()), (1, 0));
    assert_eq!(categorias_activas(&s), vec!["failed"]);
    // Una señal posterior sí.
    let r = aplica_con(&mut s, 5, ev(6, "test.resuelve"));
    assert_eq!(r.resolved.len(), 1);
    assert!(categorias_activas(&s).is_empty());
}
