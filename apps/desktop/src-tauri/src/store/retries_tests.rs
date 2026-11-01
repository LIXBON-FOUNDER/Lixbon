//! Pruebas del reintento de un Attempt en el almacén (migración 017, LXO-142).
//!
//! Cubren `docs/core/REINTENTO.md`: Attempt nuevo con su procedencia, idempotencia por `request_id`, todo-o-nada, el Attempt
//! anterior intacto y las reglas que repiten los triggers. Los eventos se construyen a mano: su contrato se prueba en
//! `orch/attempt_commands_tests.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::retries::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-retries-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Mundo {
    s: Store,
    hija: String,
    otra: String,
}

fn evento(kind: &str, entity_kind: &str, entity_id: &str, t: &TaskRow) -> NewEvent {
    NewEvent {
        id: new_uuid_v7(),
        at: 1_000,
        v: 1,
        kind: kind.into(),
        class: EventClass::State,
        actor_kind: ActorKind::System,
        actor_id: None,
        channel: Some("core".into()),
        client_id: None,
        project_id: t.project_id.clone(),
        run_id: Some(t.run_id.clone()),
        entity_kind: entity_kind.into(),
        entity_id: entity_id.into(),
        correlation_id: None,
        idem_key: None,
        payload: "{}".into(),
    }
}

/// Las migraciones del binario con el CORTE sustituido por una migración vacía (el migrador general no aplica la 014 ni
/// nada posterior): la 017 se prueba aislada, sin la maquinaria del corte.
fn con_el_corte_neutro() -> Vec<Migration> {
    embedded().into_iter().map(|m| if m.name == super::cut::CUT_NAME { Migration::new(m.version, "corte_neutro_de_prueba", "SELECT 1;") } else { m }).collect()
}

fn mundo(dir: &Path) -> Mundo {
    let mut s = Store::open_with(dir, &con_el_corte_neutro(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (_, raiz) = s
        .run_create_recorded(&NewRun { objective: "login".into(), project_id: project.clone(), root: intencion("coordinar") }, 10, |r, t| {
            Ok(vec![evento("run.created", "run", &r.id, t), evento("task.created", "task", &t.id, t)])
        })
        .unwrap();
    let hija = s.task_create_child_recorded(&raiz.id, &intencion("api"), 20, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    let otra = s.task_create_child_recorded(&raiz.id, &intencion("ui"), 21, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    Mundo { s, hija: hija.id, otra: otra.id }
}

fn nuevo(provider: &str) -> NewAttempt {
    NewAttempt { provider: provider.into(), model: Some("modelo-x".into()), effort: None, role: Some("implementador".into()), profile: Some("proponer".into()), external: false, requires_approval: false }
}

/// Cómo termina un Attempt de prueba.
#[derive(Clone, Copy)]
enum Fin {
    Done,
    Failed,
    Stopped,
    Exited,
}

fn accion(f: Fin) -> AttemptAction {
    match f {
        Fin::Done => AttemptAction::Finish { summary: "listo".into() },
        Fin::Failed => AttemptAction::Fail { reason: "agent_reported".into(), summary: "".into() },
        Fin::Stopped => AttemptAction::Cancel,
        Fin::Exited => AttemptAction::Exit,
    }
}

/// Un Attempt que arrancó y sigue corriendo.
fn corre(w: &mut Mundo, task: &str, provider: &str, at: i64) -> AttemptRow {
    let a = w.s.attempt_create_recorded(task, &nuevo(provider), at, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap();
    w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, at + 1, |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, t))).unwrap();
    a
}

/// Un Attempt que arrancó y terminó como `fin`.
fn terminado(w: &mut Mundo, task: &str, provider: &str, fin: Fin, at: i64) -> AttemptRow {
    let a = corre(w, task, provider, at);
    let r = w.s.attempt_transition_recorded(&a.id, &accion(fin), at + 10, |a, _, t| Ok(evento("attempt.ended", "attempt", &a.id, t)));
    assert_eq!(r.unwrap(), ChangeOutcome::Changed);
    w.s.attempt_row(&a.id).unwrap().unwrap()
}

fn reintento(request: &str, from: &AttemptRow, overrides: &[RetryOverride]) -> NewRetry {
    NewRetry { request_id: request.into(), from_attempt_id: from.id.clone(), overrides: overrides.to_vec() }
}

fn reintenta(w: &mut Mundo, task: &str, provider: &str, r: &NewRetry, at: i64) -> StoreResult<Retried> {
    w.s.attempt_retry_recorded(task, &nuevo(provider), r, at, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t)), |a, _, t| Ok(evento("attempt.retried", "attempt", &a.id, t)))
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

/// Todo lo que deja rastro.
fn foto(s: &Store) -> Vec<i64> {
    ["attempt_retries", "attempt_continuations", "events", "attempts"].iter().map(|t| cuenta(s, t)).collect()
}

fn tipos_de_eventos(s: &Store) -> Vec<String> {
    s.read(|c| Ok(c.prepare("SELECT kind FROM events ORDER BY rowid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap()
}

/// Cómo salió un resultado, SIN volcar su contenido.
fn resumen<T>(r: &StoreResult<T>) -> String {
    match r {
        Ok(_) => "Ok(..)".into(),
        Err(e) => format!("Err({e})"),
    }
}

fn conflicto<T>(r: StoreResult<T>, contiene: &str) {
    match r {
        Err(StoreError::AttemptConflict(m)) => assert!(m.contains(contiene), "«{m}» no menciona «{contiene}»"),
        otro => panic!("se esperaba un conflicto ({contiene}): {}", resumen(&otro)),
    }
}

fn creado(r: StoreResult<Retried>) -> (AttemptRow, RetryRow) {
    match r {
        Ok(Retried::Created { attempt, retry }) => (attempt, retry),
        otro => panic!("debía crearse: {}", resumen(&otro)),
    }
}

// ---------------------------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------------------------

#[test]
fn la_017_es_una_migracion_hacia_adelante_sin_cascadas() {
    let m = embedded().into_iter().find(|m| m.version == 17).expect("hay migración 017");
    assert_eq!(m.name, "attempt_retries");
    let sin_comentarios: String = m.sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n").to_uppercase();
    for prohibido in ["DROP ", "ALTER TABLE", "ON DELETE", "CASCADE", "BEGIN TRANSACTION", "COMMIT", "ROLLBACK"] {
        assert!(!sin_comentarios.contains(prohibido), "la 017 no puede llevar «{prohibido}»");
    }
    let t = Tmp::new();
    let w = mundo(t.path());
    let fks: Vec<(String, String)> = w
        .s
        .read(|c| Ok(c.prepare("SELECT \"table\", on_delete FROM pragma_foreign_key_list('attempt_retries') ORDER BY \"table\"")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?))
        .unwrap();
    assert!(!fks.is_empty() && fks.iter().all(|(_, d)| d == "NO ACTION"), "{fks:?}");
    let columnas: Vec<String> = w.s.read(|c| Ok(c.prepare("SELECT name FROM pragma_table_info('attempt_retries') ORDER BY cid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert_eq!(columnas, ["attempt_id", "task_id", "request_id", "from_attempt_id", "overrides", "created_at"], "ni mensaje, ni referencias del proveedor, ni rutas");
}

/// La 017 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_017_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 17).expect("existe la 017");
    assert_eq!(m.checksum(), "227107951bb3cf27f4036189daaa7ac8ef6183c83b677f0f0b4ef77b39fcc819", "una migración publicada no se edita");
}

#[test]
fn antes_del_corte_nada_escribe_ni_por_el_almacen_ni_por_sql() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = terminado(&mut w, &hija, "claude", Fin::Failed, 100);
    w.s.write(|tx| Ok(tx.execute("DELETE FROM meta WHERE key = ?1", [AGENTIC_MODEL_KEY])?)).unwrap();
    let antes = foto(&w.s);
    let r = w.s.attempt_retry_recorded(&hija, &nuevo("claude"), &reintento("r1", &a1, &[]), 1, |_, _| unreachable!(), |_, _, _| unreachable!());
    assert!(matches!(r, Err(StoreError::AgenticModelInactive)), "{}", resumen(&r));
    let q = "INSERT INTO attempt_retries (attempt_id, task_id, request_id, from_attempt_id, overrides, created_at) VALUES ('a', 't', 'r', 'b', '[]', 1)";
    assert!(sql(&mut w.s, q).unwrap_err().to_string().contains("inerte"));
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Reintentar
// ---------------------------------------------------------------------------------------------

#[test]
fn reintentar_crea_el_attempt_siguiente_con_su_procedencia_y_deja_dos_eventos_sin_tocar_el_anterior() {
    for fin in [Fin::Failed, Fin::Stopped, Fin::Exited] {
        let t = Tmp::new();
        let mut w = mundo(t.path());
        let hija = w.hija.clone();
        let a1 = terminado(&mut w, &hija, "claude", fin, 100);
        let eventos_antes = tipos_de_eventos(&w.s).len();

        let (attempt, retry) = creado(reintenta(&mut w, &hija, "claude", &reintento("req-1", &a1, &[RetryOverride::Model]), 200));
        assert_eq!((attempt.n, attempt.id.as_str(), attempt.status), (2, format!("{hija}-a2").as_str(), AttemptStatus::Starting));
        assert_eq!(attempt.provider_session_id, None, "un reintento arranca limpio: sin sesión");
        assert_eq!((retry.attempt_id.as_str(), retry.from_attempt_id.as_str(), retry.from_n, retry.request_id.as_str()), (attempt.id.as_str(), a1.id.as_str(), 1, "req-1"));
        assert_eq!(retry.overrides, [RetryOverride::Model]);
        assert_eq!(tipos_de_eventos(&w.s)[eventos_antes..], ["attempt.requested", "attempt.retried"]);
        assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), a1, "el Attempt anterior no cambia: un retry nunca lo reabre");
        assert_eq!(w.s.retry_of_attempt(&attempt.id).unwrap(), Some(retry.clone()));
        assert_eq!(w.s.retry_by_request(&hija, "req-1").unwrap(), Some(retry.clone()));
        assert_eq!(w.s.retries_from(&a1.id).unwrap(), [retry]);
    }
}

#[test]
fn los_overrides_se_guardan_en_orden_fijo_y_sin_repetir() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = terminado(&mut w, &hija, "claude", Fin::Failed, 100);
    let r = reintento("req-1", &a1, &[RetryOverride::Profile, RetryOverride::Model, RetryOverride::Profile, RetryOverride::Provider]);
    let (_, retry) = creado(reintenta(&mut w, &hija, "codex", &r, 200));
    assert_eq!(retry.overrides, [RetryOverride::Provider, RetryOverride::Model, RetryOverride::Profile]);
    // Sin cambios, una lista vacía: se heredó todo.
    let a2 = terminado_el_ultimo(&mut w, &hija);
    let (_, sin) = creado(reintenta(&mut w, &hija, "claude", &reintento("req-2", &a2, &[]), 400));
    assert!(sin.overrides.is_empty());
}

/// Cierra como `failed` el último Attempt de la Task (el que dejó el reintento anterior).
fn terminado_el_ultimo(w: &mut Mundo, task: &str) -> AttemptRow {
    let ultimo = w.s.attempt_current(task).unwrap().unwrap();
    w.s.attempt_transition_recorded(&ultimo.id, &AttemptAction::Start, 300, |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, t))).unwrap();
    w.s.attempt_transition_recorded(&ultimo.id, &accion(Fin::Failed), 310, |a, _, t| Ok(evento("attempt.failed", "attempt", &a.id, t))).unwrap();
    w.s.attempt_row(&ultimo.id).unwrap().unwrap()
}

#[test]
fn repetir_la_peticion_devuelve_el_mismo_attempt_sin_escribir_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = terminado(&mut w, &hija, "claude", Fin::Failed, 100);
    let r = reintento("req-1", &a1, &[]);
    let (primero, retry) = creado(reintenta(&mut w, &hija, "claude", &r, 200));
    let antes = foto(&w.s);
    match reintenta(&mut w, &hija, "claude", &r, 900) {
        Ok(Retried::Replayed { attempt, retry: otra }) => assert_eq!((attempt.id, otra), (primero.id.clone(), retry)),
        otro => panic!("debía repetirse: {}", resumen(&otro)),
    }
    assert_eq!(foto(&w.s), antes, "no hay Attempts duplicados");
    // Aunque el primero ya terminara: la repetición sigue devolviendo ese, no crea el siguiente.
    let a2 = terminado_el_ultimo(&mut w, &hija);
    assert_eq!(a2.id, primero.id);
    assert!(matches!(reintenta(&mut w, &hija, "claude", &r, 1000), Ok(Retried::Replayed { .. })));
    assert_eq!(cuenta(&w.s, "attempts"), 2);
}

#[test]
fn lo_que_no_se_puede_reintentar_se_rechaza_sin_rastro() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let hecho = terminado(&mut w, &hija, "claude", Fin::Done, 100);
    let antes = foto(&w.s);
    conflicto(reintenta(&mut w, &hija, "claude", &reintento("r1", &hecho, &[]), 200), "terminó bien");

    // Con un Attempt activo no se reintenta ni el anterior ni nada.
    let fallido = terminado(&mut w, &otra, "claude", Fin::Failed, 100);
    let activo = corre(&mut w, &otra, "claude", 300);
    let antes_activo = foto(&w.s);
    conflicto(reintenta(&mut w, &otra, "claude", &reintento("r2", &fallido, &[]), 400), "activo");
    conflicto(reintenta(&mut w, &otra, "claude", &reintento("r3", &activo, &[]), 400), "activo");
    assert_eq!(foto(&w.s), antes_activo);

    // Un Attempt de otra Task, uno que no existe.
    w.s.attempt_transition_recorded(&activo.id, &accion(Fin::Failed), 500, |a, _, t| Ok(evento("attempt.failed", "attempt", &a.id, t))).unwrap();
    let fallido_hija = terminado(&mut w, &hija, "claude", Fin::Failed, 600);
    let tras = foto(&w.s);
    conflicto(reintenta(&mut w, &otra, "claude", &reintento("r4", &fallido_hija, &[]), 700), "no es de la Task");
    let fantasma = AttemptRow { id: format!("{hija}-a99"), ..fallido_hija.clone() };
    conflicto(reintenta(&mut w, &hija, "claude", &reintento("r5", &fantasma, &[]), 700), "no existe");

    // Solo el último: reintentar el primero cuando hay uno posterior se rechaza.
    conflicto(reintenta(&mut w, &hija, "claude", &reintento("r6", &hecho, &[]), 700), "terminó bien");
    assert_eq!(foto(&w.s), tras);
    assert_ne!(antes, tras);
}

#[test]
fn solo_se_reintenta_el_ultimo_attempt_de_la_task() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = terminado(&mut w, &hija, "claude", Fin::Failed, 100);
    let _a2 = terminado(&mut w, &hija, "claude", Fin::Stopped, 200);
    let antes = foto(&w.s);
    conflicto(reintenta(&mut w, &hija, "claude", &reintento("r1", &a1, &[]), 300), "no es el último");
    assert_eq!(foto(&w.s), antes);
}

#[test]
fn la_clave_de_una_continuidad_no_se_reutiliza_para_un_reintento_ni_al_reves() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = terminado(&mut w, &hija, "claude", Fin::Failed, 100);
    // Un reintento con la clave `k`…
    let (a2, _) = creado(reintenta(&mut w, &hija, "claude", &reintento("k", &a1, &[]), 200));
    w.s.attempt_transition_recorded(&a2.id, &AttemptAction::Start, 210, |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, t))).unwrap();
    w.s.attempt_transition_recorded(&a2.id, &accion(Fin::Failed), 220, |a, _, t| Ok(evento("attempt.failed", "attempt", &a.id, t))).unwrap();
    let antes = foto(&w.s);
    // …no sirve para una continuidad de la misma Task: ni por el almacén ni por SQL.
    let pkg = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let continuidad = NewContinuation { request_id: "k".into(), from_attempt_id: a2.id.clone(), strategy: ContinuityStrategy::ContextPackage, reason: ContinuationReason::Requested, provider_session_id: None, package_id: Some(pkg.into()) };
    let r = w.s.attempt_continue_recorded(
        &hija,
        &nuevo("claude"),
        &continuidad,
        300,
        |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t)),
        |a, _, t| Ok(evento("attempt.continued", "attempt", &a.id, t)),
        |s, _, t| Ok(evento("provider_session.resumed", "provider_session", &s.id, t)),
    );
    assert!(r.is_err(), "{}", resumen(&r));
    assert_eq!(foto(&w.s), antes, "nada queda a medias");
}

#[test]
fn sin_su_hecho_no_hay_reintento() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = terminado(&mut w, &hija, "claude", Fin::Failed, 100);
    let antes = foto(&w.s);
    let r = w.s.attempt_retry_recorded(&hija, &nuevo("claude"), &reintento("r1", &a1, &[]), 200, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t)), |_, _, _| Err(StoreError::InvalidEvent("falla".into())));
    assert!(r.is_err());
    assert_eq!(foto(&w.s), antes, "ni Attempt, ni procedencia, ni el primer evento");
    // Un evento que no es del Attempt deshace todo.
    let r = w.s.attempt_retry_recorded(&hija, &nuevo("claude"), &reintento("r1", &a1, &[]), 200, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t)), |_, _, t| Ok(evento("attempt.retried", "attempt", "otro-a1", t)));
    assert!(r.is_err());
    assert_eq!(foto(&w.s), antes);
}

#[test]
fn una_peticion_mal_formada_se_rechaza_antes_de_escribir() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = terminado(&mut w, &hija, "claude", Fin::Failed, 100);
    let antes = foto(&w.s);
    for clave in ["", "con espacio", "ñandú", &"x".repeat(65)] {
        let r = reintenta(&mut w, &hija, "claude", &reintento(clave, &a1, &[]), 200);
        assert!(matches!(r, Err(StoreError::InvalidAttempt(_))), "{}", resumen(&r));
    }
    let mut vacio = nuevo("claude");
    vacio.provider = String::new();
    let r = w.s.attempt_retry_recorded(&hija, &vacio, &reintento("r1", &a1, &[]), 200, |_, _| unreachable!(), |_, _, _| unreachable!());
    assert!(matches!(r, Err(StoreError::InvalidAttempt(_))), "{}", resumen(&r));
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Los triggers repiten las reglas
// ---------------------------------------------------------------------------------------------

#[test]
fn la_procedencia_es_inmutable_y_no_se_borra() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = terminado(&mut w, &hija, "claude", Fin::Failed, 100);
    let (a2, _) = creado(reintenta(&mut w, &hija, "claude", &reintento("r1", &a1, &[]), 200));
    let antes = foto(&w.s);
    assert!(sql(&mut w.s, &format!("UPDATE attempt_retries SET request_id = 'otro' WHERE attempt_id = '{}'", a2.id)).unwrap_err().to_string().contains("inmutable"));
    assert!(sql(&mut w.s, "DELETE FROM attempt_retries").unwrap_err().to_string().contains("no se borra"));
    assert_eq!(foto(&w.s), antes);
}

#[test]
fn la_base_rechaza_un_origen_que_no_es_el_inmediatamente_anterior_ni_terminó_mal() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = terminado(&mut w, &hija, "claude", Fin::Done, 100);
    // `a2` nace por el mutador general (sin procedencia), así que el trigger se prueba por SQL.
    let a2 = w.s.attempt_create_recorded(&hija, &nuevo("claude"), 200, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap();
    let insertar = |s: &mut Store, desde: &str| sql(s, &format!("INSERT INTO attempt_retries (attempt_id, task_id, request_id, from_attempt_id, overrides, created_at) VALUES ('{}', '{hija}', 'k', '{desde}', '[]', 300)", a2.id));
    assert!(insertar(&mut w.s, &a1.id).unwrap_err().to_string().contains("terminó mal"), "un Attempt done no se reintenta");
    assert!(insertar(&mut w.s, &a2.id).is_err(), "no puede ser su propio origen");
    assert!(sql(&mut w.s, &format!("INSERT INTO attempt_retries (attempt_id, task_id, request_id, from_attempt_id, overrides, created_at) VALUES ('{}', '{hija}', 'k', '{}', '{{}}', 300)", a2.id, a1.id)).is_err(), "los overrides son una lista JSON");
    assert_eq!(cuenta(&w.s, "attempt_retries"), 0);
}
