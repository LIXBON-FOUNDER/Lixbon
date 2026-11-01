//! Pruebas de la Pending Queue de un Attempt en el almacén (migración 018, LXO-143).
//!
//! Cubren `docs/core/COLA.md`: el item durable con su id y su orden FIFO, la idempotencia por `request_id`, el ciclo de vida
//! cerrado (también contra el SQL directo: los triggers), que un item cancelado no se entrega jamás, todo-o-nada con su
//! evento y que sobrevive a reabrir. Los eventos se construyen a mano: su contrato se prueba en
//! `orch/queue_commands_tests.rs`.

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::queue::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-queue-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

/// Las migraciones del binario con el CORTE sustituido por una migración vacía: el migrador general no aplica la 014 ni nada
/// posterior (es una barrera), así que la 018 se prueba aislada, sin la maquinaria del corte.
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

fn nuevo_attempt() -> NewAttempt {
    NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false }
}

/// Un Attempt que arrancó y sigue corriendo.
fn corre(w: &mut Mundo, task: &str) -> AttemptRow {
    let a = w.s.attempt_create_recorded(task, &nuevo_attempt(), 100, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap();
    w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, 101, |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, t))).unwrap();
    a
}

fn termina(w: &mut Mundo, id: &str, at: i64) {
    let r = w.s.attempt_transition_recorded(id, &AttemptAction::Finish { summary: "listo".into() }, at, |a, _, t| Ok(evento("attempt.completed", "attempt", &a.id, t)));
    assert_eq!(r.unwrap(), ChangeOutcome::Changed);
}

fn item(request: &str, body: &str) -> NewQueueItem {
    NewQueueItem { request_id: request.into(), author_kind: ActorKind::Person, author_id: Some("ana".into()), client_id: Some("cli-desktop".into()), body: body.into(), attachments: vec![] }
}

fn encola(s: &mut Store, attempt: &str, new: &NewQueueItem, at: i64) -> StoreResult<Enqueued> {
    s.queue_enqueue_recorded(attempt, new, at, |i, _, a, t| {
        let mut e = evento("attempt.queued", "attempt", &a.id, t);
        e.payload = format!("{{\"queue_id\":\"{}\"}}", i.queue_id);
        Ok(e)
    })
}

fn creado(r: StoreResult<Enqueued>) -> (QueueItemRow, i64) {
    match r {
        Ok(Enqueued::Created { item, position }) => (item, position),
        otro => panic!("debía crearse: {}", variante(&otro)),
    }
}

fn entrega(s: &mut Store, id: &str, at: i64) -> StoreResult<QueueChange> {
    s.queue_delivered_recorded(id, QueueConfirmation::AdapterEvent, at, |_, a, t| Ok(evento("attempt.queue_delivered", "attempt", &a.id, t)))
}

fn cancela(s: &mut Store, id: &str, at: i64) -> StoreResult<QueueChange> {
    s.queue_cancel_recorded(id, at, |_, a, t| Ok(evento("attempt.queue_cancelled", "attempt", &a.id, t)))
}

fn falla(s: &mut Store, id: &str, why: QueueFailure, at: i64) -> StoreResult<QueueChange> {
    s.queue_failed_recorded(id, why, at, |_, a, t| Ok(evento("attempt.queue_failed", "attempt", &a.id, t)))
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

/// Todo lo que deja rastro.
fn foto(s: &Store) -> Vec<i64> {
    ["attempt_queue", "events", "attempts"].iter().map(|t| cuenta(s, t)).collect()
}

fn tipos_de_eventos(s: &Store) -> Vec<String> {
    s.read(|c| Ok(c.prepare("SELECT kind FROM events ORDER BY rowid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap()
}

/// Cómo salió un resultado, SIN volcar su contenido (las filas llevan la instrucción completa y no deben acabar en un log).
fn variante(r: &StoreResult<Enqueued>) -> String {
    match r {
        Ok(Enqueued::Created { .. }) => "Created".into(),
        Ok(Enqueued::Replayed { .. }) => "Replayed".into(),
        Ok(Enqueued::Refused(why)) => format!("Refused({why:?})"),
        Err(e) => format!("Err({e})"),
    }
}

fn cambio(r: &StoreResult<QueueChange>) -> String {
    match r {
        Ok(QueueChange::Changed(_)) => "Changed".into(),
        Ok(QueueChange::Unchanged(_)) => "Unchanged".into(),
        Ok(QueueChange::Missing) => "Missing".into(),
        Ok(QueueChange::Refused(s)) => format!("Refused({})", s.as_str()),
        Err(e) => format!("Err({e})"),
    }
}

fn estado(s: &Store, id: &str) -> QueueStatus {
    s.queue_item(id).unwrap().unwrap().status
}

fn invalido<T>(r: StoreResult<T>) {
    assert!(matches!(r, Err(StoreError::InvalidAttempt(_))), "se esperaba InvalidAttempt");
}

/// ¿Admite el SQL directo esta sentencia? La ejecuta en una transacción y la deshace SIEMPRE.
fn admite(s: &mut Store, q: &str) -> bool {
    let ok = Cell::new(false);
    let _ = s.write(|tx| -> StoreResult<()> {
        ok.set(tx.execute(q, []).is_ok());
        Err(StoreError::InvalidAttempt("deshacer".into()))
    });
    ok.get()
}

// ---------------------------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------------------------

#[test]
fn la_018_es_una_migracion_hacia_adelante_sin_cascadas() {
    let m = embedded().into_iter().find(|m| m.version == 18).expect("hay migración 018");
    assert_eq!(m.name, "attempt_queue");
    let sin_comentarios: String = m.sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n").to_uppercase();
    for prohibido in ["DROP ", "ALTER TABLE", "ON DELETE", "CASCADE", "BEGIN TRANSACTION", "COMMIT", "ROLLBACK"] {
        assert!(!sin_comentarios.contains(prohibido), "la 018 no puede llevar «{prohibido}»");
    }
    let t = Tmp::new();
    let w = mundo(t.path());
    let fks: Vec<(String, String)> = w
        .s
        .read(|c| Ok(c.prepare("SELECT \"table\", on_delete FROM pragma_foreign_key_list('attempt_queue') ORDER BY \"table\"")?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?))
        .unwrap();
    assert_eq!(fks.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>(), ["attempts", "tasks"]);
    assert!(fks.iter().all(|(_, d)| d == "NO ACTION"), "{fks:?}");
    // La fila no guarda rutas, argv, entorno ni referencias del proveedor.
    let columnas: Vec<String> = w.s.read(|c| Ok(c.prepare("SELECT name FROM pragma_table_info('attempt_queue') ORDER BY cid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert_eq!(
        columnas,
        [
            "queue_id", "attempt_id", "task_id", "seq", "request_id", "request_digest", "author_kind", "author_id", "client_id", "body", "attachments", "status", "failure_reason", "confirmed_by", "created_at",
            "updated_at", "delivered_at", "ended_at"
        ]
    );
}

/// La 018 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_018_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 18).expect("existe la 018");
    assert_eq!(m.checksum(), "4fedbfa43515901393457df95a8ccda1ed805c52ec4a57c5301c2d68ebf395c6", "una migración publicada no se edita");
}

#[test]
fn antes_del_corte_nada_escribe_ni_por_el_almacen_ni_por_sql() {
    let t = Tmp::new();
    let mut w = base(t.path(), false);
    let antes = foto(&w.s);
    let r = w.s.queue_enqueue_recorded("t-a1", &item("r1", "hola"), 1, |_, _, _, _| unreachable!());
    assert!(matches!(r, Err(StoreError::AgenticModelInactive)), "{}", variante(&r));
    let r = w.s.queue_claim_next("t-a1", 1);
    assert!(matches!(r, Err(StoreError::AgenticModelInactive)));
    let q = format!(
        "INSERT INTO attempt_queue (queue_id, attempt_id, task_id, seq, request_id, request_digest, author_kind, body, status, created_at, updated_at)
         VALUES ('t-a1-q1', 't-a1', 't', 1, 'r', '{}', 'person', 'x', 'queued', 1, 1)",
        "a".repeat(64)
    );
    assert!(sql(&mut w.s, &q).unwrap_err().to_string().contains("inerte"));
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Encolar
// ---------------------------------------------------------------------------------------------

#[test]
fn encolar_asigna_id_determinista_orden_fifo_y_deja_su_evento_en_la_misma_transaccion() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let eventos_antes = tipos_de_eventos(&w.s).len();

    let (i1, p1) = creado(encola(&mut w.s, &a.id, &item("r1", "primero"), 200));
    let (i2, p2) = creado(encola(&mut w.s, &a.id, &item("r2", "segundo\ncon salto"), 201));
    let (i3, p3) = creado(encola(&mut w.s, &a.id, &item("r3", "tercero"), 202));
    assert_eq!([i1.queue_id.as_str(), i2.queue_id.as_str(), i3.queue_id.as_str()], [format!("{}-q1", a.id), format!("{}-q2", a.id), format!("{}-q3", a.id)]);
    assert_eq!([i1.seq, i2.seq, i3.seq], [1, 2, 3]);
    assert_eq!([p1, p2, p3], [1, 2, 3], "la posición cuenta los pendientes delante");
    assert_eq!((i1.status, i1.task_id.as_str(), i1.attempt_id.as_str()), (QueueStatus::Queued, hija.as_str(), a.id.as_str()));
    assert_eq!((i1.author_kind.as_str(), i1.author_id.as_deref(), i1.client_id.as_deref()), ("person", Some("ana"), Some("cli-desktop")));
    assert_eq!((i1.failure, i1.confirmed_by, i1.delivered_at, i1.ended_at), (None, None, None, None));
    assert_eq!((i1.created_at, i1.updated_at), (200, 200));
    assert_eq!(w.s.queue_item(&i2.queue_id).unwrap().unwrap().body, "segundo\ncon salto", "el cuerpo se guarda tal cual");
    assert_eq!(tipos_de_eventos(&w.s)[eventos_antes..], ["attempt.queued", "attempt.queued", "attempt.queued"]);
    let pendientes: Vec<String> = w.s.queue_pending_of_attempt(&a.id).unwrap().into_iter().map(|i| i.body).collect();
    assert_eq!(pendientes, ["primero", "segundo\ncon salto", "tercero"]);
}

#[test]
fn cada_attempt_tiene_su_cola_y_su_numeracion() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = corre(&mut w, &hija);
    let b = corre(&mut w, &otra);
    let (ia, _) = creado(encola(&mut w.s, &a.id, &item("r1", "para a"), 200));
    let (ib, pb) = creado(encola(&mut w.s, &b.id, &item("r1", "para b"), 201));
    assert_eq!((ia.seq, ib.seq, pb), (1, 1, 1), "no hay cola cruzada: cada Attempt cuenta desde 1 y `r1` no choca");
    assert_eq!(w.s.queue_pending_of_attempt(&a.id).unwrap().len(), 1);
    assert_eq!(w.s.queue_pending_all().unwrap().len(), 2);
}

#[test]
fn repetir_el_request_id_devuelve_el_item_que_existe_y_no_escribe_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let (i1, _) = creado(encola(&mut w.s, &a.id, &item("r1", "hazlo"), 200));
    let antes = foto(&w.s);
    for _ in 0..3 {
        let r = encola(&mut w.s, &a.id, &item("r1", "hazlo"), 300);
        match r {
            Ok(Enqueued::Replayed { item }) => assert_eq!(item, i1),
            otro => panic!("debía ser una repetición: {}", variante(&otro)),
        }
    }
    assert_eq!(foto(&w.s), antes, "ni item, ni evento");
    // La repetición ve el estado actual del item, sea cual sea: nunca vuelve a encolar.
    cancela(&mut w.s, &i1.queue_id, 400).unwrap();
    let r = encola(&mut w.s, &a.id, &item("r1", "hazlo"), 500);
    assert!(matches!(&r, Ok(Enqueued::Replayed { item }) if item.status == QueueStatus::Cancelled), "{}", variante(&r));
    // Incluso con el Attempt ya terminado: es el item que existe.
    termina(&mut w, &a.id, 600);
    let r = encola(&mut w.s, &a.id, &item("r1", "hazlo"), 700);
    assert!(matches!(r, Ok(Enqueued::Replayed { .. })), "{}", variante(&r));
    assert_eq!(cuenta(&w.s, "attempt_queue"), 1);
}

#[test]
fn el_digest_distingue_repetir_una_peticion_de_reutilizar_su_clave() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let (i1, _) = creado(encola(&mut w.s, &a.id, &item("r1", "hazlo"), 200));
    assert_eq!(i1.request_digest, queue_digest("hazlo", &[]));
    assert_ne!(queue_digest("hazlo", &[]), queue_digest("hazla", &[]));
    assert_ne!(queue_digest("hazlo", &["a".into()]), queue_digest("hazlo", &["b".into()]));
    assert_ne!(queue_digest("hazlo", &["a".into(), "b".into()]), queue_digest("hazlo", &["ab".into()]), "los adjuntos no se pueden fundir");
    assert_ne!(queue_digest("a", &["b".into()]), queue_digest("ab", &[]), "ni el cuerpo con el primer adjunto");
}

#[test]
fn rechaza_sin_escribir_un_attempt_inexistente_o_terminado_y_la_cola_llena() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let antes = foto(&w.s);
    let r = encola(&mut w.s, "no-existe-a1", &item("r1", "x"), 200);
    assert!(matches!(r, Ok(Enqueued::Refused(Refusal::AttemptMissing))), "{}", variante(&r));
    assert_eq!(foto(&w.s), antes);

    for i in 0..MAX_QUEUE_PENDING {
        creado(encola(&mut w.s, &a.id, &item(&format!("r{i}"), "x"), 200 + i));
    }
    let llena = foto(&w.s);
    let r = encola(&mut w.s, &a.id, &item("una-mas", "x"), 999);
    assert!(matches!(r, Ok(Enqueued::Refused(Refusal::QueueFull))), "{}", variante(&r));
    assert_eq!(foto(&w.s), llena);
    // Cancelar libera sitio: lo que cuenta son los pendientes.
    cancela(&mut w.s, &format!("{}-q1", a.id), 1_000).unwrap();
    creado(encola(&mut w.s, &a.id, &item("una-mas", "x"), 1_001));

    termina(&mut w, &a.id, 2_000);
    let r = encola(&mut w.s, &a.id, &item("tarde", "x"), 2_001);
    assert!(matches!(r, Ok(Enqueued::Refused(Refusal::AttemptFinal))), "{}", variante(&r));
    assert_eq!(foto(&w.s)[0], MAX_QUEUE_PENDING + 1);
}

#[test]
fn valida_la_peticion_antes_de_escribir() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let antes = foto(&w.s);
    for id in ["", "con espacio", "ñ", "a/b", &"x".repeat(65)] {
        invalido(encola(&mut w.s, &a.id, &item(id, "x"), 200));
    }
    for body in ["", "   \n\t", "con\u{0}nulo", "con\u{7}campana", &"x".repeat(MAX_QUEUE_BODY_CHARS + 1)] {
        invalido(encola(&mut w.s, &a.id, &item("r1", body), 200));
    }
    let mut con = item("r1", "x");
    con.attachments = (0..=MAX_QUEUE_ATTACHMENTS).map(|i| format!("art-{i}")).collect();
    invalido(encola(&mut w.s, &a.id, &con, 200));
    con.attachments = vec!["a".into(), "a".into()];
    invalido(encola(&mut w.s, &a.id, &con, 200));
    let mut sistema = item("r1", "x");
    sistema.author_kind = ActorKind::System;
    invalido(encola(&mut w.s, &a.id, &sistema, 200));
    assert_eq!(foto(&w.s), antes);
    // Los saltos de línea y los tabuladores son parte de una instrucción.
    creado(encola(&mut w.s, &a.id, &item("r1", "paso 1\r\n\tpaso 2"), 200));
    assert_eq!(MAX_QUEUE_BODY_CHARS, 20_000);
    creado(encola(&mut w.s, &a.id, &item("r2", &"y".repeat(MAX_QUEUE_BODY_CHARS)), 201));
}

#[test]
fn los_adjuntos_son_artifacts_de_la_misma_task() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = corre(&mut w, &hija);
    let b = corre(&mut w, &otra);
    let art = |w: &mut Mundo, attempt: &str| {
        w.s.artifact_create_recorded(attempt, &NewArtifact { kind: ArtifactKind::File, uri: "informe.md".into(), sha256: None, bytes: None }, 150, |x, _, t| Ok(evento("artifact.created", "artifact", &x.id, t)))
            .unwrap()
            .id
    };
    let (propio, ajeno) = (art(&mut w, &a.id), art(&mut w, &b.id));
    let mut con = item("r1", "mira el informe");
    con.attachments = vec![propio.clone()];
    let (creada, _) = creado(encola(&mut w.s, &a.id, &con, 200));
    assert_eq!(creada.attachments, std::slice::from_ref(&propio));
    con.request_id = "r2".into();
    con.attachments = vec![propio, ajeno.clone()];
    let antes = foto(&w.s);
    let r = encola(&mut w.s, &a.id, &con, 201);
    assert!(matches!(&r, Ok(Enqueued::Refused(Refusal::UnknownAttachment(x))) if *x == ajeno), "{}", variante(&r));
    con.attachments = vec!["no-existe".into()];
    let r = encola(&mut w.s, &a.id, &con, 202);
    assert!(matches!(r, Ok(Enqueued::Refused(Refusal::UnknownAttachment(_)))), "{}", variante(&r));
    assert_eq!(foto(&w.s), antes);
}

#[test]
fn si_el_evento_falla_o_no_es_del_attempt_no_queda_ni_el_item() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let antes = foto(&w.s);
    let r = w.s.queue_enqueue_recorded(&a.id, &item("r1", "x"), 200, |_, _, _, _| Err(StoreError::InvalidEvent("falla".into())));
    assert!(r.is_err());
    let r = w.s.queue_enqueue_recorded(&a.id, &item("r1", "x"), 200, |_, _, _, t| Ok(evento("attempt.queued", "attempt", "otro-a9", t)));
    assert!(matches!(r, Err(StoreError::InvalidEvent(_))));
    let r = w.s.queue_enqueue_recorded(&a.id, &item("r1", "x"), 200, |_, _, _, t| Ok(evento("attempt.queued", "task", &t.id, t)));
    assert!(matches!(r, Err(StoreError::InvalidEvent(_))));
    assert_eq!(foto(&w.s), antes, "sin su hecho no hay item");
    // Lo mismo al cambiar de estado: sin su hecho no cambia.
    let (i1, _) = creado(encola(&mut w.s, &a.id, &item("r1", "x"), 200));
    let antes = foto(&w.s);
    let r = w.s.queue_cancel_recorded(&i1.queue_id, 300, |_, _, _| Err(StoreError::InvalidEvent("falla".into())));
    assert!(r.is_err());
    assert_eq!(estado(&w.s, &i1.queue_id), QueueStatus::Queued);
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Entrega: FIFO y ciclo de vida
// ---------------------------------------------------------------------------------------------

#[test]
fn claim_toma_el_primero_uno_a_la_vez_y_en_orden() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    assert_eq!(w.s.queue_claim_next(&a.id, 150).unwrap(), None, "cola vacía");
    for i in 1..=4 {
        creado(encola(&mut w.s, &a.id, &item(&format!("r{i}"), &format!("n{i}")), 200 + i));
    }
    let mut orden = vec![];
    for _ in 1..=4 {
        let c = w.s.queue_claim_next(&a.id, 300).unwrap().expect("hay un siguiente");
        assert_eq!(c.status, QueueStatus::Delivering);
        assert_eq!(w.s.queue_claim_next(&a.id, 301).unwrap(), None, "hay una entrega en vuelo: no se toma otra");
        assert_eq!(w.s.queue_pending_of_attempt(&a.id).unwrap().iter().filter(|i| i.status == QueueStatus::Delivering).count(), 1);
        orden.push(c.body.clone());
        assert!(matches!(entrega(&mut w.s, &c.queue_id, 302), Ok(QueueChange::Changed(_))));
    }
    assert_eq!(orden, ["n1", "n2", "n3", "n4"]);
    assert_eq!(w.s.queue_claim_next(&a.id, 400).unwrap(), None);
    assert!(w.s.queue_pending_of_attempt(&a.id).unwrap().is_empty());
    assert_eq!(w.s.queue_of_attempt(&a.id).unwrap().len(), 4, "la historia queda");
}

#[test]
fn claim_salta_lo_cancelado_y_no_toma_nada_de_un_attempt_terminado() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let q1 = creado(encola(&mut w.s, &a.id, &item("r1", "n1"), 200)).0;
    let q2 = creado(encola(&mut w.s, &a.id, &item("r2", "n2"), 201)).0;
    creado(encola(&mut w.s, &a.id, &item("r3", "n3"), 202));
    cancela(&mut w.s, &q1.queue_id, 210).unwrap();
    cancela(&mut w.s, &q2.queue_id, 211).unwrap();
    let c = w.s.queue_claim_next(&a.id, 300).unwrap().unwrap();
    assert_eq!(c.body, "n3", "lo cancelado no se entrega");
    entrega(&mut w.s, &c.queue_id, 301).unwrap();
    assert_eq!(w.s.queue_claim_next(&a.id, 302).unwrap(), None);
    assert_eq!((estado(&w.s, &q1.queue_id), estado(&w.s, &q2.queue_id)), (QueueStatus::Cancelled, QueueStatus::Cancelled));

    creado(encola(&mut w.s, &a.id, &item("r4", "n4"), 400));
    termina(&mut w, &a.id, 410);
    assert_eq!(w.s.queue_claim_next(&a.id, 420).unwrap(), None, "un Attempt terminado no entrega");
}

#[test]
fn entregar_cancelar_y_fallar_siguen_la_tabla_cerrada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let id = |n: i64| format!("{}-q{n}", a.id);
    for n in 1..=5 {
        creado(encola(&mut w.s, &a.id, &item(&format!("r{n}"), "x"), 200 + n));
    }
    // q1: queued -> cancelled. Repetir es idempotente; entregarla o fallarla es rechazado.
    assert_eq!(cambio(&cancela(&mut w.s, &id(1), 300)), "Changed");
    assert_eq!(cambio(&cancela(&mut w.s, &id(1), 301)), "Unchanged");
    assert_eq!(cambio(&entrega(&mut w.s, &id(1), 302)), "Refused(cancelled)");
    assert_eq!(cambio(&falla(&mut w.s, &id(1), QueueFailure::AdapterError, 303)), "Refused(cancelled)");
    // q2: queued -> delivering -> delivered. Entregar sin haberla tomado, o cancelarla en vuelo, es rechazado.
    assert_eq!(cambio(&entrega(&mut w.s, &id(2), 310)), "Refused(queued)");
    assert_eq!(w.s.queue_claim_next(&a.id, 311).unwrap().unwrap().queue_id, id(2));
    assert_eq!(cambio(&cancela(&mut w.s, &id(2), 312)), "Refused(delivering)", "ya se está entregando");
    assert_eq!(cambio(&entrega(&mut w.s, &id(2), 313)), "Changed");
    assert_eq!(cambio(&entrega(&mut w.s, &id(2), 314)), "Unchanged");
    assert_eq!(cambio(&cancela(&mut w.s, &id(2), 315)), "Refused(delivered)");
    assert_eq!(cambio(&falla(&mut w.s, &id(2), QueueFailure::Interrupted, 316)), "Refused(delivered)");
    let d = w.s.queue_item(&id(2)).unwrap().unwrap();
    assert_eq!((d.confirmed_by, d.delivered_at, d.ended_at), (Some(QueueConfirmation::AdapterEvent), Some(313), Some(313)));
    // q3: queued -> failed (el Attempt no la pudo recibir). q4: delivering -> failed. Repetir es Unchanged.
    assert_eq!(cambio(&falla(&mut w.s, &id(3), QueueFailure::AttemptEnded, 320)), "Changed");
    assert_eq!(cambio(&falla(&mut w.s, &id(3), QueueFailure::AttemptEnded, 321)), "Unchanged");
    assert_eq!(cambio(&cancela(&mut w.s, &id(3), 322)), "Refused(failed)");
    assert_eq!(cambio(&entrega(&mut w.s, &id(3), 323)), "Refused(failed)");
    assert_eq!(w.s.queue_claim_next(&a.id, 330).unwrap().unwrap().queue_id, id(4));
    assert_eq!(cambio(&falla(&mut w.s, &id(4), QueueFailure::AdapterUnavailable, 331)), "Changed");
    let f = w.s.queue_item(&id(4)).unwrap().unwrap();
    assert_eq!((f.failure, f.confirmed_by, f.delivered_at, f.ended_at), (Some(QueueFailure::AdapterUnavailable), None, None, Some(331)));
    assert_eq!(cambio(&cancela(&mut w.s, "no-existe-a1-q1", 340)), "Missing");
    assert_eq!(cambio(&entrega(&mut w.s, "no-existe-a1-q1", 340)), "Missing");
    // q5 sigue en cola, intacto.
    assert_eq!(estado(&w.s, &id(5)), QueueStatus::Queued);
}

#[test]
fn cada_cambio_deja_su_evento_y_los_no_cambios_no_dejan_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let base = tipos_de_eventos(&w.s).len();
    let q1 = creado(encola(&mut w.s, &a.id, &item("r1", "x"), 200)).0;
    creado(encola(&mut w.s, &a.id, &item("r2", "x"), 201));
    creado(encola(&mut w.s, &a.id, &item("r3", "x"), 202));
    cancela(&mut w.s, &q1.queue_id, 210).unwrap();
    cancela(&mut w.s, &q1.queue_id, 211).unwrap();
    let c = w.s.queue_claim_next(&a.id, 220).unwrap().unwrap();
    assert_eq!(tipos_de_eventos(&w.s).len(), base + 4, "tomar el siguiente no es un hecho");
    entrega(&mut w.s, &c.queue_id, 221).unwrap();
    entrega(&mut w.s, &c.queue_id, 222).unwrap();
    let c3 = w.s.queue_claim_next(&a.id, 230).unwrap().unwrap();
    falla(&mut w.s, &c3.queue_id, QueueFailure::Interrupted, 231).unwrap();
    assert_eq!(
        tipos_de_eventos(&w.s)[base..],
        ["attempt.queued", "attempt.queued", "attempt.queued", "attempt.queue_cancelled", "attempt.queue_delivered", "attempt.queue_failed"]
    );
}

// ---------------------------------------------------------------------------------------------
// Los triggers: lo que el almacén garantiza también lo garantiza la base
// ---------------------------------------------------------------------------------------------

/// La tabla de transiciones, comparada contra el SQL directo en las 25 combinaciones. Es la misma que `Step` en Rust.
#[test]
fn la_tabla_de_transiciones_cuadra_con_el_trigger_en_las_25_combinaciones() {
    let permitidas = [
        (QueueStatus::Queued, QueueStatus::Delivering),
        (QueueStatus::Queued, QueueStatus::Cancelled),
        (QueueStatus::Queued, QueueStatus::Failed),
        (QueueStatus::Delivering, QueueStatus::Delivered),
        (QueueStatus::Delivering, QueueStatus::Failed),
    ];
    for desde in QueueStatus::ALL {
        let t = Tmp::new();
        let mut w = mundo(t.path());
        let hija = w.hija.clone();
        let a = corre(&mut w, &hija);
        let (q, _) = creado(encola(&mut w.s, &a.id, &item("r1", "x"), 200));
        match desde {
            QueueStatus::Queued => {}
            QueueStatus::Delivering => {
                w.s.queue_claim_next(&a.id, 210).unwrap().unwrap();
            }
            QueueStatus::Delivered => {
                w.s.queue_claim_next(&a.id, 210).unwrap().unwrap();
                entrega(&mut w.s, &q.queue_id, 211).unwrap();
            }
            QueueStatus::Cancelled => {
                cancela(&mut w.s, &q.queue_id, 210).unwrap();
            }
            QueueStatus::Failed => {
                falla(&mut w.s, &q.queue_id, QueueFailure::AdapterError, 210).unwrap();
            }
        }
        assert_eq!(estado(&w.s, &q.queue_id), desde);
        for hacia in QueueStatus::ALL {
            let set = match hacia {
                QueueStatus::Queued => "status = 'queued'",
                QueueStatus::Delivering => "status = 'delivering'",
                QueueStatus::Delivered => "status = 'delivered', confirmed_by = 'adapter_event', delivered_at = 300, ended_at = 300",
                QueueStatus::Cancelled => "status = 'cancelled', ended_at = 300",
                QueueStatus::Failed => "status = 'failed', failure_reason = 'adapter_error', ended_at = 300",
            };
            let q_sql = format!("UPDATE attempt_queue SET {set}, updated_at = 300 WHERE queue_id = '{}'", q.queue_id);
            let esperado = permitidas.contains(&(desde, hacia));
            assert_eq!(admite(&mut w.s, &q_sql), esperado, "{} -> {}: el trigger y la tabla discrepan", desde.as_str(), hacia.as_str());
        }
    }
}

#[test]
fn un_item_cancelado_no_se_entrega_ni_por_sql() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let (q, _) = creado(encola(&mut w.s, &a.id, &item("r1", "x"), 200));
    cancela(&mut w.s, &q.queue_id, 210).unwrap();
    for set in ["status = 'delivering'", "status = 'queued', ended_at = NULL", "status = 'delivered', confirmed_by = 'adapter_result', delivered_at = 300"] {
        assert!(!admite(&mut w.s, &format!("UPDATE attempt_queue SET {set}, updated_at = 300 WHERE queue_id = '{}'", q.queue_id)), "{set}");
    }
    assert_eq!(estado(&w.s, &q.queue_id), QueueStatus::Cancelled);
}

#[test]
fn la_base_impone_fifo_una_entrega_en_vuelo_y_un_orden_sin_huecos() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    for n in 1..=3 {
        creado(encola(&mut w.s, &a.id, &item(&format!("r{n}"), "x"), 200 + n));
    }
    let toma = |n: i64| format!("UPDATE attempt_queue SET status = 'delivering', updated_at = 300 WHERE queue_id = '{}-q{n}'", a.id);
    assert!(!admite(&mut w.s, &toma(2)), "el segundo no se adelanta al primero");
    assert!(!admite(&mut w.s, &toma(3)));
    assert!(admite(&mut w.s, &toma(1)));
    w.s.queue_claim_next(&a.id, 300).unwrap().unwrap();
    let dos = format!("UPDATE attempt_queue SET status = 'delivering', updated_at = 301 WHERE queue_id = '{}-q2'", a.id);
    assert!(!admite(&mut w.s, &dos), "como mucho una entrega en vuelo por Attempt");

    let insert = |seq: i64, request: &str, attempt: &str, task: &str| {
        format!(
            "INSERT INTO attempt_queue (queue_id, attempt_id, task_id, seq, request_id, request_digest, author_kind, body, status, created_at, updated_at)
             VALUES ('{attempt}-q{seq}', '{attempt}', '{task}', {seq}, '{request}', '{}', 'person', 'x', 'queued', 1, 1)",
            "a".repeat(64)
        )
    };
    assert!(admite(&mut w.s, &insert(4, "ok", &a.id, &hija)));
    assert!(!admite(&mut w.s, &insert(6, "hueco", &a.id, &hija)), "el orden es consecutivo: sin huecos");
    assert!(!admite(&mut w.s, &insert(3, "repetido", &a.id, &hija)), "ni repetido");
    assert!(!admite(&mut w.s, &insert(4, "r1", &a.id, &hija)), "la clave de idempotencia es única por Attempt");
    assert!(!admite(&mut w.s, &insert(4, "otra-task", &a.id, &w.otra)), "el Attempt es de su Task");
    let nace_entregada = insert(4, "n", &a.id, &hija).replace("'queued', 1, 1)", "'cancelled', 1, 1)");
    assert!(!admite(&mut w.s, &nace_entregada), "un item nace en cola");
}

#[test]
fn la_base_no_encola_ni_entrega_en_un_attempt_terminado() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    creado(encola(&mut w.s, &a.id, &item("r1", "x"), 200));
    termina(&mut w, &a.id, 300);
    let nuevo = format!(
        "INSERT INTO attempt_queue (queue_id, attempt_id, task_id, seq, request_id, request_digest, author_kind, body, status, created_at, updated_at)
         VALUES ('{0}-q2', '{0}', '{1}', 2, 'r2', '{2}', 'person', 'x', 'queued', 1, 1)",
        a.id,
        hija,
        "a".repeat(64)
    );
    assert!(!admite(&mut w.s, &nuevo));
    let toma = format!("UPDATE attempt_queue SET status = 'delivering', updated_at = 400 WHERE queue_id = '{}-q1'", a.id);
    assert!(!admite(&mut w.s, &toma), "no se entrega en un Attempt terminado");
    // Lo pendiente sí puede fallar o cancelarse: es el cierre de la cola.
    let r = falla(&mut w.s, &format!("{}-q1", a.id), QueueFailure::AttemptEnded, 410);
    assert_eq!(cambio(&r), "Changed");
}

#[test]
fn la_identidad_el_contenido_y_la_historia_no_se_tocan() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let (q, _) = creado(encola(&mut w.s, &a.id, &item("r1", "original"), 200));
    for set in ["body = 'otro'", "attachments = '[\"x\"]'", "request_id = 'otra'", "seq = 9", "author_id = 'bea'", "client_id = 'otro'", "created_at = 5", "task_id = 'zzz'"] {
        assert!(!admite(&mut w.s, &format!("UPDATE attempt_queue SET {set} WHERE queue_id = '{}'", q.queue_id)), "{set}");
    }
    assert!(!admite(&mut w.s, "DELETE FROM attempt_queue"), "la historia no se borra");
    // Sin su confirmación o su motivo no hay `delivered` ni `failed`.
    w.s.queue_claim_next(&a.id, 210).unwrap().unwrap();
    assert!(!admite(&mut w.s, &format!("UPDATE attempt_queue SET status = 'delivered', delivered_at = 300, ended_at = 300, updated_at = 300 WHERE queue_id = '{}'", q.queue_id)), "delivered exige confirmed_by");
    assert!(!admite(&mut w.s, &format!("UPDATE attempt_queue SET status = 'failed', ended_at = 300, updated_at = 300 WHERE queue_id = '{}'", q.queue_id)), "failed exige su motivo");
    assert!(!admite(&mut w.s, &format!("UPDATE attempt_queue SET status = 'failed', failure_reason = 'por-que-si', ended_at = 300, updated_at = 300 WHERE queue_id = '{}'", q.queue_id)), "el motivo es cerrado");
    assert!(!admite(&mut w.s, &format!("UPDATE attempt_queue SET status = 'delivered', confirmed_by = 'stdin', delivered_at = 300, ended_at = 300, updated_at = 300 WHERE queue_id = '{}'", q.queue_id)), "«se escribió en stdin» no es una confirmación");
    assert_eq!(estado(&w.s, &q.queue_id), QueueStatus::Delivering);
}

// ---------------------------------------------------------------------------------------------
// Durabilidad
// ---------------------------------------------------------------------------------------------

#[test]
fn la_cola_sobrevive_a_reabrir_el_almacen_con_su_orden_y_su_estado() {
    let t = Tmp::new();
    let (id, antes) = {
        let mut w = mundo(t.path());
        let hija = w.hija.clone();
        let a = corre(&mut w, &hija);
        creado(encola(&mut w.s, &a.id, &item("r1", "uno"), 200));
        creado(encola(&mut w.s, &a.id, &item("r2", "dos"), 201));
        creado(encola(&mut w.s, &a.id, &item("r3", "tres"), 202));
        cancela(&mut w.s, &format!("{}-q2", a.id), 210).unwrap();
        w.s.queue_claim_next(&a.id, 220).unwrap().unwrap();
        (a.id.clone(), w.s.queue_of_attempt(&a.id).unwrap())
    };
    let s = Store::open_with(t.path(), &con_el_corte_neutro(), "t").unwrap();
    assert_eq!(s.queue_of_attempt(&id).unwrap(), antes, "las filas son las mismas tras reabrir");
    let estados: Vec<&str> = antes.iter().map(|i| i.status.as_str()).collect();
    assert_eq!(estados, ["delivering", "cancelled", "queued"]);
    let pendientes: Vec<String> = s.queue_pending_of_attempt(&id).unwrap().into_iter().map(|i| i.body).collect();
    assert_eq!(pendientes, ["uno", "tres"], "lo cancelado no figura entre lo pendiente");
    assert_eq!(s.queue_by_request(&id, "r3").unwrap().unwrap().body, "tres");
}

#[test]
fn los_vocabularios_de_estado_motivo_y_confirmacion_son_los_del_contrato() {
    const CONTRATO: &str = include_str!("../../../../../contracts/status-vocabulary.json");
    let json: serde_json::Value = serde_json::from_str(CONTRATO).unwrap();
    let ids = |seccion: &str, clave: &str| -> Vec<String> { json["domain"][seccion][clave].as_array().unwrap_or_else(|| panic!("domain.{seccion}.{clave}")).iter().map(|v| v.as_str().unwrap().to_string()).collect() };
    assert_eq!(ids("queue_state", "ids"), QueueStatus::ALL.map(|s| s.as_str().to_string()).to_vec());
    assert_eq!(ids("queue_state", "final"), QueueStatus::ALL.iter().filter(|s| s.is_final()).map(|s| s.as_str().to_string()).collect::<Vec<_>>());
    assert_eq!(ids("queue_failure", "ids"), QueueFailure::ALL.map(|s| s.as_str().to_string()).to_vec());
    // Y los de la migración: el CHECK de la tabla acepta exactamente esos ids.
    let sql = embedded().into_iter().find(|m| m.version == 18).unwrap().sql;
    for s in QueueStatus::ALL {
        assert!(sql.contains(&format!("'{}'", s.as_str())), "{}", s.as_str());
    }
    for f in QueueFailure::ALL {
        assert!(sql.contains(&format!("'{}'", f.as_str())), "{}", f.as_str());
    }
    for c in QueueConfirmation::ALL {
        assert!(sql.contains(&format!("'{}'", c.as_str())), "{}", c.as_str());
    }
    assert!(!sql.contains("stdin'"), "no hay una confirmación «stdin»");
    // Round trip de los ids.
    for s in QueueStatus::ALL {
        assert_eq!(QueueStatus::parse(s.as_str()).unwrap(), s);
    }
    assert!(QueueStatus::parse("steered").is_err());
    assert!(QueueFailure::parse("otro").is_err());
    assert!(QueueConfirmation::parse("stdin").is_err());
}
