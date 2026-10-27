//! Pruebas de la continuidad de un Attempt en el almacén (migración 016, LXO-134).
//!
//! Cubren `docs/core/CONTINUIDAD.md`: resume nativo y paquete, idempotencia por `request_id`, todo-o-nada, el Attempt
//! anterior intacto, la procedencia inmutable y las reglas que repiten los triggers. Los eventos se construyen a mano:
//! su contrato se prueba en `orch/continuity_tests.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::continuity::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-continuity-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

const PKG: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const REF: &str = "6f1c2a9e-0b7d-4d1e-9a51-3c2f8e7d9b10";

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

/// Las migraciones del binario con el CORTE sustituido por una migración vacía: el migrador general no aplica la 014 ni nada
/// posterior (es una barrera), así que la 016 se prueba aislada, sin la maquinaria del corte.
fn con_el_corte_neutro() -> Vec<Migration> {
    embedded().into_iter().map(|m| if m.name == super::cut::CUT_NAME { Migration::new(m.version, "corte_neutro_de_prueba", "SELECT 1;") } else { m }).collect()
}

fn base(dir: &Path, activo: bool) -> Mundo {
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
    if !activo {
        s.write(|tx| Ok(tx.execute("DELETE FROM meta WHERE key = ?1", [AGENTIC_MODEL_KEY])?)).unwrap();
    }
    Mundo { s, hija: hija.id, otra: otra.id }
}

fn mundo(dir: &Path) -> Mundo {
    base(dir, true)
}

fn nuevo(provider: &str) -> NewAttempt {
    NewAttempt { provider: provider.into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false }
}

/// Un Attempt que arrancó y sigue corriendo.
fn corre(w: &mut Mundo, task: &str, provider: &str, at: i64) -> AttemptRow {
    let a = w.s.attempt_create_recorded(task, &nuevo(provider), at, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap();
    w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, at + 1, |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, t))).unwrap();
    a
}

fn termina(w: &mut Mundo, id: &str, at: i64) {
    let r = w.s.attempt_transition_recorded(id, &AttemptAction::Finish { summary: "listo".into() }, at, |a, _, t| Ok(evento("attempt.completed", "attempt", &a.id, t)));
    assert_eq!(r.unwrap(), ChangeOutcome::Changed);
}

/// Un Attempt que terminó, con su sesión resumible ya en espera.
fn con_sesion(w: &mut Mundo, task: &str, provider: &str, referencia: Option<&str>) -> (AttemptRow, ProviderSessionRow) {
    let a = corre(w, task, provider, 100);
    let new = NewProviderSession { resumable: true, external_ref: referencia.map(|r| (r.to_string(), SessionBinding::StreamJson)) };
    let s = w.s.provider_session_open_recorded(&a.id, &new, 110, |s, _, t| Ok(evento("provider_session.opened", "provider_session", &s.id, t))).unwrap();
    termina(w, &a.id, 120);
    let r = w.s.provider_session_transition_recorded(&s.id, SessionStep::Detach, 130, |s, _, t| Ok(evento("provider_session.detached", "provider_session", &s.id, t)));
    assert_eq!(r.unwrap(), ChangeOutcome::Changed);
    (w.s.attempt_row(&a.id).unwrap().unwrap(), w.s.provider_session_row(&s.id).unwrap().unwrap())
}

/// Un Attempt que terminó sin sesión.
fn sin_sesion(w: &mut Mundo, task: &str, provider: &str) -> AttemptRow {
    let a = corre(w, task, provider, 100);
    termina(w, &a.id, 120);
    w.s.attempt_row(&a.id).unwrap().unwrap()
}

fn nativa(request: &str, from: &AttemptRow, session: &ProviderSessionRow) -> NewContinuation {
    NewContinuation { request_id: request.into(), from_attempt_id: from.id.clone(), strategy: Strategy::NativeResume, reason: Reason::Preferred, provider_session_id: Some(session.id.clone()), package_id: None }
}

fn paquete(request: &str, from: &AttemptRow, reason: Reason) -> NewContinuation {
    NewContinuation { request_id: request.into(), from_attempt_id: from.id.clone(), strategy: Strategy::ContextPackage, reason, provider_session_id: None, package_id: Some(PKG.into()) }
}

fn continua(w: &mut Mundo, task: &str, provider: &str, c: &NewContinuation, at: i64) -> StoreResult<Continued> {
    w.s.attempt_continue_recorded(
        task,
        &nuevo(provider),
        c,
        at,
        |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t)),
        |a, _, t| Ok(evento("attempt.continued", "attempt", &a.id, t)),
        |s, _, t| Ok(evento("provider_session.resumed", "provider_session", &s.id, t)),
    )
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

/// Todo lo que deja rastro.
fn foto(s: &Store) -> Vec<i64> {
    ["attempt_continuations", "provider_sessions", "events", "attempts"].iter().map(|t| cuenta(s, t)).collect()
}

fn tipos_de_eventos(s: &Store) -> Vec<String> {
    s.read(|c| Ok(c.prepare("SELECT kind FROM events ORDER BY rowid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap()
}

/// Cómo salió un resultado, SIN volcar su contenido: las filas llevan ids de sesión y de paquete y no deben acabar en un log.
fn resumen<T>(r: &StoreResult<T>) -> String {
    match r {
        Ok(_) => "Ok(..)".into(),
        Err(e) => format!("Err({e})"),
    }
}

fn variante(c: &StoreResult<Continued>) -> &'static str {
    match c {
        Ok(Continued::Created { .. }) => "Created",
        Ok(Continued::Replayed { .. }) => "Replayed",
        Err(_) => "Err",
    }
}

fn conflicto<T>(r: StoreResult<T>, contiene: &str) {
    match r {
        Err(StoreError::AttemptConflict(m)) | Err(StoreError::SessionConflict(m)) => assert!(m.contains(contiene), "«{m}» no menciona «{contiene}»"),
        otro => panic!("se esperaba un conflicto ({contiene}): {}", resumen(&otro)),
    }
}

fn invalido<T>(r: StoreResult<T>) {
    assert!(matches!(r, Err(StoreError::InvalidAttempt(_))), "se esperaba InvalidAttempt: {}", resumen(&r));
}

// ---------------------------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------------------------

#[test]
fn la_016_es_una_migracion_hacia_adelante_sin_cascadas() {
    let m = embedded().into_iter().find(|m| m.version == 16).expect("hay migración 016");
    assert_eq!(m.name, "attempt_continuity");
    let sin_comentarios: String = m.sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n").to_uppercase();
    for prohibido in ["DROP ", "ALTER TABLE", "ON DELETE", "CASCADE", "BEGIN TRANSACTION", "COMMIT", "ROLLBACK"] {
        assert!(!sin_comentarios.contains(prohibido), "la 016 no puede llevar «{prohibido}»");
    }
    let t = Tmp::new();
    let w = mundo(t.path());
    let fks: Vec<(String, String)> = w
        .s
        .read(|c| Ok(c.prepare("SELECT \"table\", on_delete FROM pragma_foreign_key_list('attempt_continuations') ORDER BY \"table\"")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?))
        .unwrap();
    assert!(!fks.is_empty() && fks.iter().all(|(_, d)| d == "NO ACTION"), "{fks:?}");
    // La fila no guarda la referencia del proveedor ni el contenido del paquete: solo ids y el hash.
    let columnas: Vec<String> = w.s.read(|c| Ok(c.prepare("SELECT name FROM pragma_table_info('attempt_continuations') ORDER BY cid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert_eq!(columnas, ["attempt_id", "task_id", "request_id", "strategy", "reason", "from_attempt_id", "provider_session_id", "package_id", "created_at"]);
}

/// La 016 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_016_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 16).expect("existe la 016");
    assert_eq!(m.checksum(), "9c961acfe3be6f34331f14e605d3697fda9bdd2830f03c22736a47f665f38306", "una migración publicada no se edita");
}

#[test]
fn antes_del_corte_nada_escribe_ni_por_el_almacen_ni_por_sql() {
    let t = Tmp::new();
    let mut w = base(t.path(), false);
    let antes = foto(&w.s);
    let r = w.s.attempt_continue_recorded(
        "t",
        &nuevo("claude"),
        &NewContinuation { request_id: "r1".into(), from_attempt_id: "t-a1".into(), strategy: Strategy::ContextPackage, reason: Reason::Requested, provider_session_id: None, package_id: Some(PKG.into()) },
        1,
        |_, _| unreachable!(),
        |_, _, _| unreachable!(),
        |_, _, _| unreachable!(),
    );
    assert!(matches!(r, Err(StoreError::AgenticModelInactive)), "{}", resumen(&r));
    let q = format!("INSERT INTO attempt_continuations (attempt_id, task_id, request_id, strategy, reason, from_attempt_id, package_id, created_at) VALUES ('a', 't', 'r', 'context_package', 'requested', 'b', '{PKG}', 1)");
    assert!(sql(&mut w.s, &q).unwrap_err().to_string().contains("inerte"));
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Resume nativo
// ---------------------------------------------------------------------------------------------

#[test]
fn el_resume_nativo_crea_el_attempt_reanuda_la_sesion_y_deja_tres_eventos() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = con_sesion(&mut w, &hija, "claude", Some(REF));
    let antes_a1 = w.s.attempt_row(&a1.id).unwrap().unwrap();
    let eventos_antes = tipos_de_eventos(&w.s).len();

    let Continued::Created { attempt, continuation } = continua(&mut w, &hija, "claude", &nativa("req-1", &a1, &ps), 200).unwrap() else { panic!("debía crearse") };
    assert_eq!((attempt.n, attempt.id.as_str(), attempt.provider.as_str()), (2, format!("{hija}-a2").as_str(), "claude"));
    assert_eq!(attempt.provider_session_id.as_deref(), Some(ps.id.as_str()), "el Attempt nuevo corre en la sesión");
    assert_eq!((continuation.strategy, continuation.reason, continuation.from_attempt_id.as_str()), (Strategy::NativeResume, Reason::Preferred, a1.id.as_str()));
    assert_eq!((continuation.provider_session_id.as_deref(), continuation.package_id.as_deref()), (Some(ps.id.as_str()), None));
    assert_eq!(w.s.provider_session_row(&ps.id).unwrap().unwrap().status, SessionStatus::Open);
    assert_eq!(tipos_de_eventos(&w.s)[eventos_antes..], ["attempt.requested", "attempt.continued", "provider_session.resumed"]);
    // El Attempt anterior no se toca.
    assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), antes_a1);
    // Lecturas.
    assert_eq!(w.s.continuation_of_attempt(&attempt.id).unwrap(), Some(continuation.clone()));
    assert_eq!(w.s.continuation_of_attempt(&a1.id).unwrap(), None, "el primer Attempt no continúa a nadie");
    assert_eq!(w.s.continuations_from(&a1.id).unwrap(), [continuation]);
}

#[test]
fn repetir_la_peticion_no_crea_otro_attempt_ni_escribe_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = con_sesion(&mut w, &hija, "claude", Some(REF));
    let c = nativa("req-1", &a1, &ps);
    let primero = continua(&mut w, &hija, "claude", &c, 200).unwrap();
    let antes = foto(&w.s);
    let otra_vez = continua(&mut w, &hija, "claude", &c, 999).unwrap();
    assert!(matches!(otra_vez, Continued::Replayed { .. }));
    assert_eq!(otra_vez.attempt(), primero.attempt());
    assert_eq!(otra_vez.continuation(), primero.continuation());
    assert_eq!(foto(&w.s), antes, "un reintento no escribe");
    // Ni siquiera con otra estrategia: la petición ya se atendió y quien llama compara lo que obtuvo.
    let cambiada = paquete("req-1", &a1, Reason::Requested);
    assert!(matches!(continua(&mut w, &hija, "claude", &cambiada, 300).unwrap(), Continued::Replayed { .. }));
    assert_eq!(foto(&w.s), antes);
}

#[test]
fn el_request_id_es_de_la_task() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = sin_sesion(&mut w, &hija, "claude");
    let b = sin_sesion(&mut w, &otra, "claude");
    let x = continua(&mut w, &hija, "claude", &paquete("misma", &a, Reason::Requested), 200);
    let y = continua(&mut w, &otra, "claude", &paquete("misma", &b, Reason::Requested), 210);
    assert_eq!((variante(&x), variante(&y)), ("Created", "Created"));
    let (x, y) = (x.unwrap(), y.unwrap());
    assert_ne!(x.attempt().id, y.attempt().id);
}

#[test]
fn si_falla_cualquier_paso_no_queda_nada_a_medias() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = con_sesion(&mut w, &hija, "claude", Some(REF));
    let antes = foto(&w.s);
    let sesion_antes = w.s.provider_session_row(&ps.id).unwrap().unwrap();
    let c = nativa("req-1", &a1, &ps);
    let falla = || -> StoreResult<NewEvent> { Err(StoreError::InvalidEvent("a propósito".into())) };

    // Falla el evento del Attempt, el de la continuidad o el de la sesión (el último, con todo lo demás ya escrito).
    let r = w.s.attempt_continue_recorded(&hija, &nuevo("claude"), &c, 200, |_, _| falla(), |a, _, t| Ok(evento("attempt.continued", "attempt", &a.id, t)), |s, _, t| Ok(evento("provider_session.resumed", "provider_session", &s.id, t)));
    assert!(r.is_err());
    let r = w.s.attempt_continue_recorded(&hija, &nuevo("claude"), &c, 200, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t)), |_, _, _| falla(), |s, _, t| Ok(evento("provider_session.resumed", "provider_session", &s.id, t)));
    assert!(r.is_err());
    let r = w.s.attempt_continue_recorded(&hija, &nuevo("claude"), &c, 200, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t)), |a, _, t| Ok(evento("attempt.continued", "attempt", &a.id, t)), |_, _, _| falla());
    assert!(r.is_err());

    assert_eq!(foto(&w.s), antes, "ni Attempt, ni continuidad, ni eventos");
    assert_eq!(w.s.provider_session_row(&ps.id).unwrap().unwrap(), sesion_antes, "la sesión sigue en espera");
    // Y la petición se puede repetir después, porque no quedó registrada.
    assert!(matches!(continua(&mut w, &hija, "claude", &c, 300).unwrap(), Continued::Created { .. }));
}

#[test]
fn una_sesion_que_no_sirve_no_se_reanuda() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();

    // Sin referencia del proveedor: no hay con qué reanudar.
    let (a1, ps) = con_sesion(&mut w, &hija, "claude", None);
    let antes = foto(&w.s);
    conflicto(continua(&mut w, &hija, "claude", &nativa("r1", &a1, &ps), 200), "no se puede reanudar");
    // Otro proveedor: una ProviderSession no se comparte entre proveedores.
    conflicto(continua(&mut w, &hija, "codex", &nativa("r2", &a1, &ps), 200), "y el proveedor");
    assert_eq!(foto(&w.s), antes);

    // Cerrada: es final.
    w.s.provider_session_transition_recorded(&ps.id, SessionStep::Close, 150, |s, _, t| Ok(evento("provider_session.closed", "provider_session", &s.id, t))).unwrap();
    let antes = foto(&w.s);
    conflicto(continua(&mut w, &hija, "claude", &nativa("r3", &a1, &ps), 200), "no se puede reanudar");
    assert_eq!(foto(&w.s), antes);
}

#[test]
fn la_sesion_es_de_la_task_y_la_corrio_el_attempt_anterior() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let (a1, ps) = con_sesion(&mut w, &hija, "claude", Some(REF));
    let b1 = sin_sesion(&mut w, &otra, "claude");
    // La sesión de `hija` no se usa desde `otra`.
    conflicto(continua(&mut w, &otra, "claude", &nativa("r1", &b1, &ps), 200), "no es de la Task");
    // El Attempt anterior tiene que ser uno de los que corrieron en ella.
    let a2 = continua(&mut w, &hija, "claude", &paquete("r2", &a1, Reason::Requested), 200).unwrap();
    termina(&mut w, &a2.attempt().id, 220);
    let antes = foto(&w.s);
    conflicto(continua(&mut w, &hija, "claude", &nativa("r3", a2.attempt(), &ps), 300), "no corrió en la sesión");
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Paquete
// ---------------------------------------------------------------------------------------------

#[test]
fn con_paquete_el_attempt_arranca_limpio_en_cualquier_proveedor_y_la_sesion_no_se_toca() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = con_sesion(&mut w, &hija, "claude", Some(REF));
    let sesion_antes = w.s.provider_session_row(&ps.id).unwrap().unwrap();
    let eventos_antes = tipos_de_eventos(&w.s).len();

    let Continued::Created { attempt, continuation } = continua(&mut w, &hija, "codex", &paquete("req-1", &a1, Reason::ProviderChanged), 200).unwrap() else { panic!("debía crearse") };
    assert_eq!(attempt.provider, "codex");
    assert_eq!(attempt.provider_session_id, None, "no hereda ninguna sesión");
    assert_eq!((continuation.strategy, continuation.reason, continuation.package_id.as_deref(), continuation.provider_session_id), (Strategy::ContextPackage, Reason::ProviderChanged, Some(PKG), None));
    assert_eq!(w.s.provider_session_row(&ps.id).unwrap().unwrap(), sesion_antes, "la sesión del otro proveedor sigue como estaba");
    assert_eq!(tipos_de_eventos(&w.s)[eventos_antes..], ["attempt.requested", "attempt.continued"]);
}

#[test]
fn cada_motivo_de_paquete_se_guarda() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let mut anterior = sin_sesion(&mut w, &hija, "claude");
    for (i, reason) in [Reason::Requested, Reason::ProviderChanged, Reason::ResumeUnsupported, Reason::SessionUnavailable, Reason::SessionExpired].into_iter().enumerate() {
        let c = continua(&mut w, &hija, "claude", &paquete(&format!("r{i}"), &anterior, reason), 200 + i as i64 * 10).unwrap();
        assert_eq!(c.continuation().reason, reason);
        termina(&mut w, &c.attempt().id, 205 + i as i64 * 10);
        anterior = w.s.attempt_row(&c.attempt().id).unwrap().unwrap();
    }
}

// ---------------------------------------------------------------------------------------------
// Reglas de la petición
// ---------------------------------------------------------------------------------------------

#[test]
fn no_se_continua_un_attempt_que_corre_ni_el_de_otra_task() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let activo = corre(&mut w, &hija, "claude", 100);
    conflicto(continua(&mut w, &hija, "claude", &paquete("r1", &activo, Reason::Requested), 200), "sigue activo");
    let b1 = sin_sesion(&mut w, &otra, "claude");
    conflicto(continua(&mut w, &hija, "claude", &paquete("r2", &b1, Reason::Requested), 200), "no es de la Task");
    conflicto(continua(&mut w, &hija, "claude", &NewContinuation { from_attempt_id: "no-existe".into(), ..paquete("r3", &b1, Reason::Requested) }, 200), "no existe el Attempt");
    termina(&mut w, &activo.id, 150);
    // Con otro Attempt ya activo en la Task, tampoco (la regla de un solo Attempt activo).
    let terminado = w.s.attempt_row(&activo.id).unwrap().unwrap();
    let a2 = continua(&mut w, &hija, "claude", &paquete("r4", &terminado, Reason::Requested), 200).unwrap();
    conflicto(continua(&mut w, &hija, "claude", &paquete("r5", &terminado, Reason::Requested), 210), "ya tiene el Attempt activo");
    assert_eq!(a2.attempt().n, 2);
}

#[test]
fn una_peticion_mal_formada_se_rechaza_antes_de_escribir() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = con_sesion(&mut w, &hija, "claude", Some(REF));
    let antes = foto(&w.s);
    let ok = paquete("r", &a1, Reason::Requested);
    for malo in ["", "con espacio", "ñandú", &"x".repeat(65), "a/b"] {
        invalido(continua(&mut w, &hija, "claude", &NewContinuation { request_id: malo.into(), ..ok.clone() }, 200));
    }
    for pkg in ["", "sha256:abc", &format!("sha256:{}", "G".repeat(64)), &format!("md5:{}", "a".repeat(64)), &format!("sha256:{}", "A".repeat(64))] {
        invalido(continua(&mut w, &hija, "claude", &NewContinuation { package_id: Some(pkg.into()), ..ok.clone() }, 200));
    }
    // La estrategia decide qué lleva.
    invalido(continua(&mut w, &hija, "claude", &NewContinuation { provider_session_id: Some(ps.id.clone()), ..ok.clone() }, 200));
    invalido(continua(&mut w, &hija, "claude", &NewContinuation { package_id: None, ..ok.clone() }, 200));
    invalido(continua(&mut w, &hija, "claude", &NewContinuation { reason: Reason::Preferred, ..ok.clone() }, 200));
    let nat = nativa("r", &a1, &ps);
    invalido(continua(&mut w, &hija, "claude", &NewContinuation { provider_session_id: None, ..nat.clone() }, 200));
    invalido(continua(&mut w, &hija, "claude", &NewContinuation { package_id: Some(PKG.into()), ..nat.clone() }, 200));
    invalido(continua(&mut w, &hija, "claude", &NewContinuation { reason: Reason::Requested, ..nat }, 200));
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Triggers (la misma regla, también por SQL)
// ---------------------------------------------------------------------------------------------

#[test]
fn la_procedencia_no_se_reescribe_ni_se_borra() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = sin_sesion(&mut w, &hija, "claude");
    let c = continua(&mut w, &hija, "claude", &paquete("r1", &a1, Reason::Requested), 200).unwrap();
    let id = c.attempt().id.clone();
    for q in [
        format!("UPDATE attempt_continuations SET reason = 'session_expired' WHERE attempt_id = '{id}'"),
        format!("UPDATE attempt_continuations SET package_id = '{}' WHERE attempt_id = '{id}'", "sha256:".to_string() + &"b".repeat(64)),
        format!("DELETE FROM attempt_continuations WHERE attempt_id = '{id}'"),
    ] {
        let e = sql(&mut w.s, &q).unwrap_err().to_string();
        assert!(e.contains("inmutable") || e.contains("no se borra"), "{q}: {e}");
    }
    assert_eq!(w.s.continuation_of_attempt(&id).unwrap(), Some(c.continuation().clone()));
}

#[test]
fn por_sql_tampoco_se_inserta_una_continuidad_incoherente() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a1 = sin_sesion(&mut w, &hija, "claude");
    let b1 = sin_sesion(&mut w, &otra, "claude");
    let a2 = w.s.attempt_create_recorded(&hija, &nuevo("claude"), 300, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap();
    let insert = |attempt: &str, task: &str, from: &str, strategy: &str, reason: &str, session: &str, pkg: &str| {
        format!(
            "INSERT INTO attempt_continuations (attempt_id, task_id, request_id, strategy, reason, from_attempt_id, provider_session_id, package_id, created_at)
             VALUES ('{attempt}', '{task}', 'x', '{strategy}', '{reason}', '{from}', {session}, {pkg}, 1)"
        )
    };
    let pkg = format!("'{PKG}'");
    let casos = [
        // El anterior es de otra Task.
        (insert(&a2.id, &hija, &b1.id, "context_package", "requested", "NULL", &pkg), "no es de la misma Task"),
        // El Attempt no es de la Task indicada.
        (insert(&a2.id, &otra, &a1.id, "context_package", "requested", "NULL", &pkg), "no es de la Task indicada"),
        // Se continúa a sí mismo.
        (insert(&a2.id, &hija, &a2.id, "context_package", "requested", "NULL", &pkg), "no es anterior"),
        // Con paquete y con sesión a la vez, o con ninguno.
        (insert(&a2.id, &hija, &a1.id, "context_package", "requested", "'ps-x'", &pkg), "la sesión no es de la Task"),
        (insert(&a2.id, &hija, &a1.id, "context_package", "requested", "NULL", "NULL"), "CHECK"),
        // Un paquete que no es un hash.
        (insert(&a2.id, &hija, &a1.id, "context_package", "requested", "NULL", "'sha256:cualquiera'"), "CHECK"),
        // Un motivo que no existe.
        (insert(&a2.id, &hija, &a1.id, "context_package", "porque_si", "NULL", &pkg), "CHECK"),
    ];
    for (q, esperado) in casos {
        let e = sql(&mut w.s, &q).unwrap_err().to_string();
        assert!(e.contains(esperado), "{q}\n→ {e}");
    }
    assert_eq!(cuenta(&w.s, "attempt_continuations"), 0);
}
