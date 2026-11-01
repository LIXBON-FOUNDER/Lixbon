//! LXO-143 · Command `attempt.queue` y Pending Queue: idle/busy, FIFO, cancelación, fallos del adapter, recuperación,
//! idempotencia, query, Events, Activity y Attention. Contrato: `docs/core/COLA.md`. El almacén (transacción, triggers,
//! orden en la base) se prueba en `store/queue_tests.rs`; aquí, la orquestación con un puerto falso.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::activity_format::item as activity_item;
use super::adapter::{AdapterError, CancelToken, Capability, ErrorCode};
use super::agents::EnvBlock;
use super::attempt_ops;
use super::attention_rules::EventRules;
use super::events::{Actor, Channel, MutationContext};
use super::queue_commands::*;
use super::task_ops::{create_child, create_run};
use crate::store::{
    embedded, ArtifactKind, AttemptRow, AttemptStatus, AttentionProjection, EventQuery, EventRow, Fingerprint, Migration, NewArtifact, NewAttempt, NewLocation, NewRun, NewTaskIntent, QueueConfirmation,
    QueueFailure, QueueItemRow, QueueStatus, Store, AGENTIC_MODEL, AGENTIC_MODEL_KEY, MAX_QUEUE_PENDING,
};

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-queue-ops-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

const PERFIL: &str = "proponer";

fn persona() -> MutationContext {
    MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) }
}

fn agente(task: &str) -> MutationContext {
    MutationContext::agent(task, Channel::Lxo)
}

fn core() -> MutationContext {
    MutationContext::core()
}

fn corte_neutro() -> Vec<Migration> {
    embedded().into_iter().map(|m| if m.name == crate::store::CUT_NAME { Migration::new(m.version, "corte_neutro_de_prueba", "SELECT 1;") } else { m }).collect()
}

struct Mundo {
    s: Store,
    raiz: String,
    hija: String,
    otra: String,
}

fn abre(dir: &Path) -> Store {
    let mut s = Store::open_with(dir, &corte_neutro(), "t").unwrap();
    s.set_event_projector(Arc::new(AttentionProjection::new(Arc::new(EventRules))));
    s
}

fn mundo(dir: &Path) -> Mundo {
    let mut s = abre(dir);
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (_, raiz) = create_run(&mut s, &persona(), &NewRun { objective: "login".into(), project_id: project, root: intencion("coordinar") }).unwrap();
    let hija = create_child(&mut s, &persona(), &raiz.id, &intencion("api")).unwrap();
    let otra = create_child(&mut s, &persona(), &raiz.id, &intencion("ui")).unwrap();
    Mundo { s, raiz: raiz.id, hija: hija.id, otra: otra.id }
}

/// Cierra el almacén y lo vuelve a abrir: un reinicio del Core.
fn reinicia(w: Mundo, dir: &Path) -> Mundo {
    let Mundo { s, raiz, hija, otra } = w;
    drop(s);
    Mundo { s: abre(dir), raiz, hija, otra }
}

fn nuevo(provider: &str) -> NewAttempt {
    NewAttempt { provider: provider.into(), model: None, effort: None, role: None, profile: Some(PERFIL.into()), external: false, requires_approval: false }
}

/// Un Attempt que arrancó y corre.
fn corre(w: &mut Mundo, task: &str) -> AttemptRow {
    let a = attempt_ops::create(&mut w.s, &persona(), task, &nuevo("claude")).unwrap();
    attempt_ops::start(&mut w.s, &core(), &a.id).unwrap();
    w.s.attempt_row(&a.id).unwrap().unwrap()
}

fn estado(w: &Mundo, id: &str) -> AttemptStatus {
    w.s.attempt_row(id).unwrap().unwrap().status
}

// ── El puerto falso ──────────────────────────────────────────────────────────────────────────────────────────────────

/// Un adapter simulado: dice si el run está en un límite de turno, qué capability tiene y cómo responde a cada entrega.
struct Puerto {
    limite: Cell<Boundary>,
    capacidad: RefCell<Result<(), AdapterError>>,
    /// Qué responde a cada entrega, en orden. Vacío: confirma con un evento del adapter.
    respuestas: RefCell<VecDeque<Result<QueueConfirmation, AdapterError>>>,
    /// Lo que el adapter recibió y confirmó: (queue_id, instrucción).
    entregado: RefCell<Vec<(String, String)>>,
    /// Los adjuntos que llegaron con cada entrega confirmada.
    adjuntos: RefCell<Vec<Vec<String>>>,
    /// Cuántas veces se pidió entregar (con éxito o sin él).
    llamadas: Cell<usize>,
}

impl Puerto {
    fn ocupado() -> Puerto {
        Puerto {
            limite: Cell::new(Boundary::Busy),
            capacidad: RefCell::new(Ok(())),
            respuestas: RefCell::new(VecDeque::new()),
            entregado: RefCell::new(vec![]),
            adjuntos: RefCell::new(vec![]),
            llamadas: Cell::new(0),
        }
    }

    fn libre() -> Puerto {
        let p = Puerto::ocupado();
        p.fin_de_turno();
        p
    }

    fn fin_de_turno(&self) {
        self.limite.set(Boundary::TurnEnd);
    }

    fn responde(&self, r: Result<QueueConfirmation, AdapterError>) {
        self.respuestas.borrow_mut().push_back(r);
    }

    fn cuerpos(&self) -> Vec<String> {
        self.entregado.borrow().iter().map(|(_, b)| b.clone()).collect()
    }
}

impl QueuePort for Puerto {
    fn capability(&self, _attempt: &AttemptRow) -> Result<(), AdapterError> {
        self.capacidad.borrow().clone()
    }

    fn boundary(&self, _attempt: &AttemptRow) -> Boundary {
        self.limite.get()
    }

    fn deliver(&self, _attempt: &AttemptRow, request: &DeliveryRequest<'_>, _cancel: &CancelToken) -> Result<QueueConfirmation, AdapterError> {
        self.llamadas.set(self.llamadas.get() + 1);
        let r = self.respuestas.borrow_mut().pop_front().unwrap_or(Ok(QueueConfirmation::AdapterEvent));
        if r.is_ok() {
            self.entregado.borrow_mut().push((request.queue_id.to_string(), request.body.to_string()));
            self.adjuntos.borrow_mut().push(request.attachments.to_vec());
            // Entregarla abre un turno nuevo: el run vuelve a estar ocupado hasta el siguiente límite.
            self.limite.set(Boundary::Busy);
        }
        r
    }
}

fn pide(w: &mut Mundo, p: &Puerto, ctx: &MutationContext, attempt: &str, request: &str, body: &str) -> Result<Queued, QueueError> {
    queue_attempt(&mut w.s, p, ctx, &CancelToken::new(), &QueueRequest { request_id: request, attempt_id: attempt, body, attachments: &[] })
}

fn ok(r: Result<Queued, QueueError>) -> Queued {
    r.unwrap_or_else(|e| panic!("debía encolar: {e}"))
}

fn err(r: Result<Queued, QueueError>) -> QueueError {
    match r {
        Err(e) => e,
        Ok(q) => panic!("debía fallar: {:?}", q.item.queue_id),
    }
}

fn entrega(w: &mut Mundo, p: &Puerto, attempt: &str) -> DeliveryResult {
    deliver_next(&mut w.s, p, &CancelToken::new(), attempt).unwrap_or_else(|e| panic!("deliver_next: {e}"))
}

fn eventos(s: &Store) -> Vec<EventRow> {
    s.events_page(&EventQuery { limit: Some(1000), ..Default::default() }).unwrap().events
}

fn tipos(s: &Store) -> Vec<String> {
    eventos(s).into_iter().map(|e| e.kind).collect()
}

/// Los eventos de la cola, desde `desde`: `kind@entidad`.
fn de_la_cola(s: &Store, desde: usize) -> Vec<String> {
    tipos(s).into_iter().skip(desde).filter(|k| k.starts_with("attempt.queue")).collect()
}

fn payload(e: &EventRow) -> Value {
    serde_json::from_str(&e.payload).unwrap()
}

/// Todo lo que deja rastro.
fn foto(w: &Mundo) -> Vec<i64> {
    ["attempt_queue", "events", "attempts", "attention_items"].iter().map(|t| w.s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))?)).unwrap()).collect()
}

/// Attention activa: `categoría target_kind target_id subject`.
fn activas(s: &Store) -> Vec<String> {
    s.read(|c| {
        Ok(c.prepare("SELECT category || ' ' || target_kind || ' ' || target_id || ' ' || coalesce(subject, '-') FROM attention_items WHERE status = 'active' ORDER BY 1")?
            .query_map([], |r| r.get(0))?
            .collect::<Result<_, _>>()?)
    })
    .unwrap()
}

fn hechos_de_attention(s: &Store) -> Value {
    let facts: String = s.read(|c| Ok(c.query_row("SELECT facts FROM attention_items WHERE status = 'active' AND subject = 'queue'", [], |r| r.get(0))?)).unwrap();
    serde_json::from_str(&facts).unwrap()
}

fn item_de(w: &Mundo, id: &str) -> QueueItemRow {
    w.s.queue_item(id).unwrap().unwrap()
}

// ── Idle y busy ──────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn con_el_run_en_un_limite_de_turno_se_entrega_en_el_acto_y_lo_confirma_el_adapter() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::libre();
    let antes = tipos(&w.s).len();

    let q = ok(pide(&mut w, &p, &persona(), &a.id, "r1", "añade la prueba del login"));
    assert!(!q.replayed);
    assert_eq!(q.position, Some(1));
    let DeliveryResult::Delivered(entregado) = q.delivery.clone().unwrap() else { panic!("debía entregarse: {:?}", q.delivery) };
    assert_eq!(entregado.queue_id, format!("{}-q1", a.id));
    assert_eq!((q.item.status, q.item.confirmed_by), (QueueStatus::Delivered, Some(QueueConfirmation::AdapterEvent)), "el item que se devuelve es el entregado");
    assert_eq!(p.entregado.borrow().clone(), [(format!("{}-q1", a.id), "añade la prueba del login".to_string())]);
    assert_eq!(de_la_cola(&w.s, antes), ["attempt.queued", "attempt.queue_delivered"]);
    assert_eq!(estado(&w, &a.id), AttemptStatus::Running, "encolar no cambia el estado del Attempt");
    assert!(w.s.queue_pending_of_attempt(&a.id).unwrap().is_empty());
    assert!(activas(&w.s).is_empty());
}

#[test]
fn con_el_run_ocupado_se_encola_sin_tocar_el_adapter_y_se_entrega_en_el_siguiente_limite() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    let antes = tipos(&w.s).len();

    let q = ok(pide(&mut w, &p, &persona(), &a.id, "r1", "cuando acabes, revisa los tipos"));
    assert_eq!((q.item.status, q.position, q.replayed), (QueueStatus::Queued, Some(1), false));
    assert_eq!(q.delivery.clone().unwrap(), DeliveryResult::Nothing);
    assert_eq!(p.llamadas.get(), 0, "el adapter no se toca mientras el run está en un turno");
    assert_eq!(de_la_cola(&w.s, antes), ["attempt.queued"]);
    let cola = pending(&w.s, &persona(), &a.id).unwrap();
    assert_eq!((cola.items.len(), cola.items[0].position, cola.items[0].item.body.as_str()), (1, 1, "cuando acabes, revisa los tipos"));

    // Llega el límite de turno.
    p.fin_de_turno();
    let DeliveryResult::Delivered(i) = entrega(&mut w, &p, &a.id) else { panic!("debía entregarse") };
    assert_eq!(i.queue_id, q.item.queue_id);
    assert_eq!(p.cuerpos(), ["cuando acabes, revisa los tipos"]);
    assert_eq!(de_la_cola(&w.s, antes), ["attempt.queued", "attempt.queue_delivered"]);
    assert!(pending(&w.s, &persona(), &a.id).unwrap().items.is_empty());
    // Sin nada pendiente, otro límite no entrega nada.
    p.fin_de_turno();
    assert_eq!(entrega(&mut w, &p, &a.id), DeliveryResult::Nothing);
}

#[test]
fn solo_un_run_running_en_un_limite_de_turno_recibe_una_entrega() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    // `starting`: aún no hay un turno que terminar.
    let a = attempt_ops::create(&mut w.s, &persona(), &hija, &nuevo("claude")).unwrap();
    let p = Puerto::libre();
    let q = ok(pide(&mut w, &p, &persona(), &a.id, "r1", "primero"));
    assert_eq!((q.item.status, q.delivery.clone().unwrap()), (QueueStatus::Queued, DeliveryResult::Nothing));
    attempt_ops::start(&mut w.s, &core(), &a.id).unwrap();

    // `waiting` espera la respuesta a una pregunta: lo que se le diga entonces es un `answer`, no una cola.
    attempt_ops::wait(&mut w.s, &core(), &a.id).unwrap();
    assert_eq!(entrega(&mut w, &p, &a.id), DeliveryResult::Nothing);
    attempt_ops::await_terminal(&mut w.s, &core(), &a.id).unwrap();
    assert_eq!(entrega(&mut w, &p, &a.id), DeliveryResult::Nothing, "esperar la aprobación en la terminal tampoco es un límite de turno");
    assert_eq!(p.llamadas.get(), 0);
    assert_eq!(estado(&w, &a.id), AttemptStatus::AwaitingTerminalApproval);

    attempt_ops::resume(&mut w.s, &core(), &a.id).unwrap();
    let DeliveryResult::Delivered(i) = entrega(&mut w, &p, &a.id) else { panic!("debía entregarse al volver a running") };
    assert_eq!(i.queue_id, q.item.queue_id);
}

#[test]
fn un_item_nuevo_no_se_adelanta_a_los_que_ya_esperaban() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    ok(pide(&mut w, &p, &persona(), &a.id, "r1", "uno"));
    ok(pide(&mut w, &p, &persona(), &a.id, "r2", "dos"));
    p.fin_de_turno();
    // Llega un tercero con el run libre: se entrega el PRIMERO de la cola, no el recién llegado.
    let q3 = ok(pide(&mut w, &p, &persona(), &a.id, "r3", "tres"));
    assert!(matches!(q3.delivery.clone().unwrap(), DeliveryResult::Delivered(i) if i.body == "uno"));
    assert_eq!(q3.item.status, QueueStatus::Queued, "el tercero sigue esperando su turno");
    assert_eq!(q3.position, Some(3), "tenía dos pendientes delante");
    assert_eq!(p.cuerpos(), ["uno"]);
}

// ── FIFO ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn n_items_se_entregan_en_fifo_uno_por_limite_de_turno() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    let antes = tipos(&w.s).len();
    const TOTAL: usize = 7;
    for i in 1..=TOTAL {
        let q = ok(pide(&mut w, &p, &persona(), &a.id, &format!("r{i}"), &format!("instrucción {i}")));
        assert_eq!((q.item.seq, q.position), (i as i64, Some(i as i64)));
    }
    assert_eq!(p.llamadas.get(), 0);
    let cola = pending(&w.s, &persona(), &a.id).unwrap();
    assert_eq!(cola.items.iter().map(|i| (i.position, i.item.body.clone())).collect::<Vec<_>>(), (1..=TOTAL).map(|i| (i, format!("instrucción {i}"))).collect::<Vec<_>>());

    for k in 1..=TOTAL {
        // Mientras el run está en un turno no se entrega nada, por muchas veces que se pregunte.
        for _ in 0..3 {
            assert_eq!(entrega(&mut w, &p, &a.id), DeliveryResult::Nothing);
        }
        p.fin_de_turno();
        let DeliveryResult::Delivered(i) = entrega(&mut w, &p, &a.id) else { panic!("debía entregarse la {k}") };
        assert_eq!(i.body, format!("instrucción {k}"));
        assert_eq!(pending(&w.s, &persona(), &a.id).unwrap().items.len(), TOTAL - k);
    }
    assert_eq!(p.cuerpos(), (1..=TOTAL).map(|i| format!("instrucción {i}")).collect::<Vec<_>>(), "en el orden en que se encolaron");
    let cola_de_eventos = de_la_cola(&w.s, antes);
    assert_eq!(cola_de_eventos.iter().filter(|k| *k == "attempt.queued").count(), TOTAL);
    assert_eq!(cola_de_eventos.iter().filter(|k| *k == "attempt.queue_delivered").count(), TOTAL);
    let posiciones: Vec<i64> = eventos(&w.s).iter().filter(|e| e.kind == "attempt.queued").map(|e| payload(e)["position"].as_i64().unwrap()).collect();
    assert_eq!(posiciones, (1..=TOTAL as i64).collect::<Vec<_>>());
}

#[test]
fn un_fallo_de_entrega_no_bloquea_a_los_siguientes_ni_reordena() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    for i in 1..=3 {
        ok(pide(&mut w, &p, &persona(), &a.id, &format!("r{i}"), &format!("n{i}")));
    }
    p.responde(Err(AdapterError::provider("se cayó")));
    p.fin_de_turno();
    let DeliveryResult::Failed(f) = entrega(&mut w, &p, &a.id) else { panic!("la primera debía fallar") };
    assert_eq!((f.body.as_str(), f.status, f.failure), ("n1", QueueStatus::Failed, Some(QueueFailure::AdapterError)));
    // Fallar no abrió ningún turno: el run sigue en el límite y toca la siguiente, en su orden.
    let DeliveryResult::Delivered(d) = entrega(&mut w, &p, &a.id) else { panic!("la segunda debía entregarse") };
    assert_eq!(d.body, "n2");
    p.fin_de_turno();
    let DeliveryResult::Delivered(d) = entrega(&mut w, &p, &a.id) else { panic!("la tercera debía entregarse") };
    assert_eq!(d.body, "n3");
    assert_eq!(p.cuerpos(), ["n2", "n3"], "la que falló no se reintenta");
    assert_eq!(estado(&w, &a.id), AttemptStatus::Running, "un fallo de entrega no falla el Attempt");
}

// ── Cancelar ─────────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn un_item_cancelado_antes_de_su_entrega_no_se_entrega_nunca() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    let antes = tipos(&w.s).len();
    let q1 = ok(pide(&mut w, &p, &persona(), &a.id, "r1", "uno")).item;
    let q2 = ok(pide(&mut w, &p, &persona(), &a.id, "r2", "dos")).item;
    let q3 = ok(pide(&mut w, &p, &persona(), &a.id, "r3", "tres")).item;

    let Cancelled::Cancelled(c) = cancel_queued(&mut w.s, &persona(), &q2.queue_id).unwrap() else { panic!("debía cancelarse") };
    assert_eq!((c.status, c.ended_at.is_some()), (QueueStatus::Cancelled, true));
    let cola = pending(&w.s, &persona(), &a.id).unwrap();
    assert_eq!(cola.items.iter().map(|i| i.item.body.as_str()).collect::<Vec<_>>(), ["uno", "tres"], "lo cancelado sale de lo pendiente");
    assert_eq!(cola.items[1].position, 2, "y las posiciones se recompactan");

    // Repetir la cancelación no escribe nada.
    let hasta_aqui = foto(&w);
    assert!(matches!(cancel_queued(&mut w.s, &persona(), &q2.queue_id).unwrap(), Cancelled::AlreadyCancelled(_)));
    assert_eq!(foto(&w), hasta_aqui);

    for _ in 0..3 {
        p.fin_de_turno();
        entrega(&mut w, &p, &a.id);
    }
    assert_eq!(p.cuerpos(), ["uno", "tres"], "la cancelada no llegó al adapter");
    assert_eq!(item_de(&w, &q2.queue_id).status, QueueStatus::Cancelled);
    assert_eq!(de_la_cola(&w.s, antes), ["attempt.queued", "attempt.queued", "attempt.queued", "attempt.queue_cancelled", "attempt.queue_delivered", "attempt.queue_delivered"]);
    let _ = (q1, q3);
}

#[test]
fn un_item_que_ya_se_entregó_o_falló_no_se_cancela() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::libre();
    let entregada = ok(pide(&mut w, &p, &persona(), &a.id, "r1", "uno")).item;
    p.fin_de_turno();
    p.responde(Err(AdapterError::provider("no")));
    let fallada = ok(pide(&mut w, &p, &persona(), &a.id, "r2", "dos")).item;
    let hasta_aqui = foto(&w);
    for id in [&entregada.queue_id, &fallada.queue_id] {
        let e = cancel_queued(&mut w.s, &persona(), id).unwrap_err();
        assert_eq!((e.kind, e.code, e.queue_id.as_deref()), (ErrorKind::Invalid, "not_cancellable", Some(id.as_str())));
    }
    assert_eq!(foto(&w), hasta_aqui);
    assert_eq!(item_de(&w, &entregada.queue_id).status, QueueStatus::Delivered);
    assert_eq!(item_de(&w, &fallada.queue_id).status, QueueStatus::Failed);
    let e = cancel_queued(&mut w.s, &persona(), "no-existe-a1-q1").unwrap_err();
    assert_eq!(e.code, "queue_missing");
}

// ── Adapter no disponible o con fallo ────────────────────────────────────────────────────────────────────────────────

#[test]
fn si_el_proveedor_no_puede_entregar_encolar_es_un_error_y_no_se_escribe_nada_ni_se_cae_a_steer() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::libre();
    let antes = foto(&w);
    let casos = [
        (AdapterError::unsupported(Capability::Steer), ErrorKind::Unsupported, "queue_unsupported"),
        (AdapterError::unavailable(Capability::Resume, "degradado"), ErrorKind::Unsupported, "queue_unsupported"),
        (AdapterError::environment_blocked(EnvBlock::CliMissing), ErrorKind::EnvironmentBlocked, "environment_blocked"),
        (AdapterError::provider("roto"), ErrorKind::Failed, "adapter_error"),
    ];
    for (adapter, kind, code) in casos {
        *p.capacidad.borrow_mut() = Err(adapter);
        let e = err(pide(&mut w, &p, &persona(), &a.id, "r1", "hazlo"));
        assert_eq!((e.kind, e.code), (kind, code));
        assert_eq!(foto(&w), antes, "sin la capability no se promete una entrega que no va a ocurrir");
    }
    assert_eq!(p.llamadas.get(), 0, "ni se intentó entregar, ni se inyectó en el turno en curso");
    // Cuando la capability vuelve, la MISMA petición se atiende: la clave no se gastó.
    *p.capacidad.borrow_mut() = Ok(());
    assert!(matches!(ok(pide(&mut w, &p, &persona(), &a.id, "r1", "hazlo")).delivery.unwrap(), DeliveryResult::Delivered(_)));
}

#[test]
fn si_el_adapter_no_confirma_el_item_falla_con_su_motivo_su_evento_y_su_attention() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    // Cada código del adapter tiene su motivo en la cola, sin rama comodín.
    let tabla = [
        (AdapterError::unsupported(Capability::Steer), QueueFailure::Unsupported),
        (AdapterError::environment_blocked(EnvBlock::CliMissing), QueueFailure::EnvironmentBlocked),
        (AdapterError::unavailable(Capability::Resume, "degradado"), QueueFailure::AdapterUnavailable),
        (AdapterError::unknown_run(), QueueFailure::AdapterUnavailable),
        (AdapterError::unknown_provider("x"), QueueFailure::AdapterUnavailable),
        (AdapterError::session_not_found(), QueueFailure::AdapterUnavailable),
        (AdapterError::unknown_capability("x"), QueueFailure::AdapterUnavailable),
        (AdapterError::provider("el proveedor falló"), QueueFailure::AdapterError),
        (AdapterError::new(ErrorCode::Internal, "interno"), QueueFailure::AdapterError),
        (AdapterError::invalid("mal"), QueueFailure::AdapterError),
        (AdapterError::cancelled(), QueueFailure::AdapterError),
    ];
    for (i, (adapter, esperado)) in tabla.into_iter().enumerate() {
        assert_eq!(failure_of(&adapter), esperado, "{adapter}");
        let antes = tipos(&w.s).len();
        p.fin_de_turno();
        p.responde(Err(adapter));
        let q = ok(pide(&mut w, &p, &persona(), &a.id, &format!("r{i}"), "hazlo"));
        let DeliveryResult::Failed(f) = q.delivery.clone().unwrap() else { panic!("debía fallar la entrega") };
        assert_eq!((f.status, f.failure, f.confirmed_by), (QueueStatus::Failed, Some(esperado), None));
        assert_eq!(q.item.status, QueueStatus::Failed, "el item que se devuelve es el fallado");
        assert_eq!(de_la_cola(&w.s, antes), ["attempt.queued", "attempt.queue_failed"]);
        let e = eventos(&w.s).into_iter().rev().find(|e| e.kind == "attempt.queue_failed").unwrap();
        assert_eq!(payload(&e), json!({ "task": hija, "n": 1, "queue_id": f.queue_id, "reason": esperado.as_str() }));
    }
    assert!(p.cuerpos().is_empty(), "nada se dio por entregado");
    assert_eq!(estado(&w, &a.id), AttemptStatus::Running, "un fallo de entrega no falla el Attempt");
    // Attention: UNA sobre el Attempt, con el último motivo; no se levanta nada sobre la Task.
    assert_eq!(activas(&w.s), [format!("failed attempt {} queue", a.id)]);
    let hechos = hechos_de_attention(&w.s);
    assert_eq!(hechos["failure_reason"], "adapter_error");
    assert_eq!(hechos["task"], json!(hija));
    assert!(hechos["queue_id"].as_str().unwrap().starts_with(&a.id));
    assert!(!hechos.to_string().contains("hazlo"), "ni el texto de la instrucción");
}

#[test]
fn la_attention_de_la_cola_se_cierra_sola_cuando_el_attempt_termina() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::libre();
    p.responde(Err(AdapterError::provider("no")));
    ok(pide(&mut w, &p, &persona(), &a.id, "r1", "hazlo"));
    assert_eq!(activas(&w.s), [format!("failed attempt {} queue", a.id)]);
    attempt_ops::finish(&mut w.s, &core(), &a.id, "listo").unwrap();
    assert!(activas(&w.s).is_empty(), "la condición desapareció con el Attempt");
    let resuelto: (String, String) = w.s.read(|c| Ok(c.query_row("SELECT status, resolution FROM attention_items WHERE subject = 'queue'", [], |r| Ok((r.get(0)?, r.get(1)?)))?)).unwrap();
    assert_eq!(resuelto, ("resolved".to_string(), "condition_cleared".to_string()));
}

#[test]
fn la_confirmacion_queda_registrada_y_solo_la_da_el_adapter() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    for (i, by) in [QueueConfirmation::AdapterEvent, QueueConfirmation::AdapterResult].into_iter().enumerate() {
        p.fin_de_turno();
        p.responde(Ok(by));
        let q = ok(pide(&mut w, &p, &persona(), &a.id, &format!("r{i}"), "hazlo"));
        assert_eq!(q.item.confirmed_by, Some(by));
        let e = eventos(&w.s).into_iter().rev().find(|e| e.kind == "attempt.queue_delivered").unwrap();
        assert_eq!(payload(&e)["confirmed_by"], by.as_str());
        assert_eq!((e.actor_kind.as_str(), e.channel.as_deref()), ("system", Some("core")), "lo anota el Core al recibir la confirmación");
    }
    // No hay forma de expresar «se escribió en la entrada del proceso» como confirmación.
    assert_eq!(QueueConfirmation::ALL.len(), 2);
}

// ── Attempt terminado ────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn en_un_attempt_terminado_no_se_encola_y_lo_pendiente_falla_con_attempt_ended_sin_attention() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    ok(pide(&mut w, &p, &persona(), &a.id, "r1", "uno"));
    ok(pide(&mut w, &p, &persona(), &a.id, "r2", "dos"));
    let antes = tipos(&w.s).len();
    attempt_ops::finish(&mut w.s, &core(), &a.id, "listo").unwrap();
    // Aún no se ha reconciliado la cola: encolar ya está rechazado.
    let hasta_aqui = foto(&w);
    let e = err(pide(&mut w, &p, &persona(), &a.id, "r3", "tres"));
    assert_eq!((e.kind, e.code), (ErrorKind::Invalid, "attempt_final"));
    assert_eq!(foto(&w), hasta_aqui);

    assert_eq!(settle_attempt_end(&mut w.s, &a.id).unwrap(), 2);
    assert_eq!(settle_attempt_end(&mut w.s, &a.id).unwrap(), 0, "idempotente");
    let items = w.s.queue_of_attempt(&a.id).unwrap();
    assert!(items.iter().all(|i| i.status == QueueStatus::Failed && i.failure == Some(QueueFailure::AttemptEnded)));
    assert_eq!(de_la_cola(&w.s, antes), ["attempt.queue_failed", "attempt.queue_failed"]);
    assert!(activas(&w.s).is_empty(), "el Attempt ya terminó: no hay nada que la persona pueda hacer sobre él");
    assert_eq!(p.llamadas.get(), 0);
}

#[test]
fn deliver_next_sobre_un_attempt_terminado_cierra_la_cola_en_lugar_de_entregar() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    ok(pide(&mut w, &p, &persona(), &a.id, "r1", "uno"));
    attempt_ops::fail(&mut w.s, &core(), &a.id, super::event_kinds::FailureCode::AgentReported, "").unwrap();
    p.fin_de_turno();
    assert_eq!(entrega(&mut w, &p, &a.id), DeliveryResult::Nothing);
    assert_eq!(item_de(&w, &format!("{}-q1", a.id)).failure, Some(QueueFailure::AttemptEnded));
    assert_eq!(p.llamadas.get(), 0, "un Attempt terminado no recibe nada");
    assert_eq!(settle_attempt_end(&mut w.s, "no-existe-a1").unwrap_err().code, "attempt_missing");
    // Sobre un Attempt vivo no hace nada.
    let otra = w.otra.clone();
    let b = corre(&mut w, &otra);
    let ocupado = Puerto::ocupado();
    ok(pide(&mut w, &ocupado, &persona(), &b.id, "r1", "uno"));
    assert_eq!(settle_attempt_end(&mut w.s, &b.id).unwrap(), 0);
    assert_eq!(item_de(&w, &format!("{}-q1", b.id)).status, QueueStatus::Queued);
}

// ── Recuperación ─────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn la_recuperacion_conserva_lo_encolado_de_un_attempt_vivo_y_no_reintenta_lo_que_iba_en_vuelo() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = corre(&mut w, &hija);
    let c = corre(&mut w, &otra);
    let p = Puerto::ocupado();
    // Attempt A: una entrega en vuelo (el Core cayó entre pedirla y anotar el resultado) y una en cola.
    let en_vuelo = ok(pide(&mut w, &p, &persona(), &a.id, "r1", "en vuelo")).item;
    let en_cola = ok(pide(&mut w, &p, &persona(), &a.id, "r2", "en cola")).item;
    assert_eq!(w.s.queue_claim_next(&a.id, 500).unwrap().unwrap().queue_id, en_vuelo.queue_id);
    // Attempt C: algo en cola, y el Attempt terminó sin que nadie reconciliara la cola.
    let huerfana = ok(pide(&mut w, &p, &persona(), &c.id, "r1", "huérfana")).item;
    attempt_ops::exit(&mut w.s, &core(), &c.id).unwrap();

    // El Core se reinicia: la cola es durable.
    let mut w = reinicia(w, t.path());
    assert_eq!(item_de(&w, &en_vuelo.queue_id).status, QueueStatus::Delivering);
    assert_eq!(item_de(&w, &en_cola.queue_id).status, QueueStatus::Queued);
    let antes = tipos(&w.s).len();

    assert_eq!(recover(&mut w.s).unwrap(), Recovery { interrupted: 1, ended: 1, kept: 1 });
    let f = item_de(&w, &en_vuelo.queue_id);
    assert_eq!((f.status, f.failure), (QueueStatus::Failed, Some(QueueFailure::Interrupted)), "no se sabe si llegó: no se reintenta");
    assert_eq!((item_de(&w, &en_cola.queue_id).status, item_de(&w, &huerfana.queue_id).failure), (QueueStatus::Queued, Some(QueueFailure::AttemptEnded)));
    assert_eq!(de_la_cola(&w.s, antes), ["attempt.queue_failed", "attempt.queue_failed"]);
    // Lo interrumpido avisa a la persona (el Attempt sigue vivo); lo del Attempt terminado, no.
    assert_eq!(activas(&w.s), [format!("failed attempt {} queue", a.id)]);
    assert_eq!(hechos_de_attention(&w.s)["failure_reason"], "interrupted");

    // Idempotente.
    assert_eq!(recover(&mut w.s).unwrap(), Recovery { interrupted: 0, ended: 0, kept: 1 });
    assert_eq!(de_la_cola(&w.s, antes).len(), 2);

    // Lo conservado se entrega en el siguiente límite de turno; lo interrumpido, jamás.
    p.fin_de_turno();
    let DeliveryResult::Delivered(d) = entrega(&mut w, &p, &a.id) else { panic!("debía entregarse lo conservado") };
    assert_eq!(d.queue_id, en_cola.queue_id);
    p.fin_de_turno();
    assert_eq!(entrega(&mut w, &p, &a.id), DeliveryResult::Nothing);
    assert_eq!(p.cuerpos(), ["en cola"]);
}

#[test]
fn recuperar_sin_cola_pendiente_no_hace_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::libre();
    ok(pide(&mut w, &p, &persona(), &a.id, "r1", "uno"));
    let hasta_aqui = foto(&w);
    assert_eq!(recover(&mut w.s).unwrap(), Recovery::default());
    assert_eq!(foto(&w), hasta_aqui);
}

// ── Idempotencia ─────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn repetir_la_peticion_devuelve_el_mismo_item_sin_duplicar_ni_entregar_dos_veces() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    let primera = ok(pide(&mut w, &p, &persona(), &a.id, "clave-1", "hazlo"));
    let hasta_aqui = foto(&w);
    for _ in 0..3 {
        let r = ok(pide(&mut w, &p, &persona(), &a.id, "clave-1", "hazlo"));
        assert!(r.replayed);
        assert_eq!((r.item.queue_id.as_str(), r.position, r.delivery.clone().unwrap()), (primera.item.queue_id.as_str(), None, DeliveryResult::Nothing));
    }
    assert_eq!(foto(&w), hasta_aqui, "ni item, ni evento");

    // Entregada, la repetición ve el item entregado y no vuelve a entregar nada.
    p.fin_de_turno();
    entrega(&mut w, &p, &a.id);
    p.fin_de_turno();
    let r = ok(pide(&mut w, &p, &persona(), &a.id, "clave-1", "hazlo"));
    assert!(r.replayed);
    assert_eq!(r.item.status, QueueStatus::Delivered);
    assert_eq!(p.cuerpos(), ["hazlo"], "entregado una sola vez");

    // Cancelada, la repetición no la resucita.
    p.limite.set(Boundary::Busy);
    let c = ok(pide(&mut w, &p, &persona(), &a.id, "clave-2", "otra")).item;
    cancel_queued(&mut w.s, &persona(), &c.queue_id).unwrap();
    let r = ok(pide(&mut w, &p, &persona(), &a.id, "clave-2", "otra"));
    assert_eq!((r.replayed, r.item.status), (true, QueueStatus::Cancelled));
    p.fin_de_turno();
    entrega(&mut w, &p, &a.id);
    assert_eq!(p.cuerpos(), ["hazlo"], "una cancelada no se entrega por reintentar su petición");
    assert_eq!(w.s.queue_of_attempt(&a.id).unwrap().len(), 2);
}

#[test]
fn reutilizar_la_clave_para_otra_instruccion_es_un_conflicto_y_no_cambia_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    let q = ok(pide(&mut w, &p, &persona(), &a.id, "clave-1", "hazlo")).item;
    let hasta_aqui = foto(&w);
    let e = err(pide(&mut w, &p, &persona(), &a.id, "clave-1", "haz otra cosa"));
    assert_eq!((e.kind, e.code, e.queue_id.as_deref()), (ErrorKind::Invalid, "request_conflict", Some(q.queue_id.as_str())));
    let e = err(queue_attempt(&mut w.s, &p, &persona(), &CancelToken::new(), &QueueRequest { request_id: "clave-1", attempt_id: &a.id, body: "hazlo", attachments: &["x".to_string()] }));
    assert_eq!(e.code, "request_conflict", "los adjuntos también cuentan");
    assert_eq!(foto(&w), hasta_aqui);
    assert_eq!(item_de(&w, &q.queue_id).body, "hazlo");
    // La misma clave en OTRO Attempt es otra petición.
    let otra = w.otra.clone();
    let b = corre(&mut w, &otra);
    let r = ok(pide(&mut w, &p, &persona(), &b.id, "clave-1", "hazlo"));
    assert!(!r.replayed);
}

// ── Quién puede ──────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn encolan_y_cancelan_una_persona_y_el_que_coordina_la_task_y_el_item_recuerda_quien() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra, raiz) = (w.hija.clone(), w.otra.clone(), w.raiz.clone());
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    let persona_q = ok(pide(&mut w, &p, &persona(), &a.id, "r1", "de la persona")).item;
    let coord_q = ok(pide(&mut w, &p, &agente(&raiz), &a.id, "r2", "del coordinador")).item;
    let legacy_q = ok(pide(&mut w, &p, &MutationContext::person(Channel::Ui), &a.id, "r3", "persona sin cuenta")).item;
    assert_eq!((persona_q.author_kind.as_str(), persona_q.author_id.as_deref(), persona_q.client_id.as_deref()), ("person", Some("ana"), Some("cli-desktop")));
    assert_eq!((coord_q.author_kind.as_str(), coord_q.author_id.as_deref(), coord_q.client_id.as_deref()), ("agent", Some(raiz.as_str()), None));
    assert_eq!((legacy_q.author_kind.as_str(), legacy_q.author_id.as_deref()), ("person", None));
    let actores: Vec<(String, Option<String>)> = eventos(&w.s).iter().filter(|e| e.kind == "attempt.queued").map(|e| (e.actor_kind.as_str().to_string(), e.actor_id.clone())).collect();
    assert_eq!(actores, [("person".to_string(), Some("ana".to_string())), ("agent".to_string(), Some(raiz.clone())), ("person".to_string(), None)]);

    // Ni el agente de OTRA Task, ni el propio Core, ni la hermana: nada se escribe.
    let hasta_aqui = foto(&w);
    for ctx in [agente(&otra), core(), MutationContext::system(Channel::Lxo)] {
        let e = err(pide(&mut w, &p, &ctx, &a.id, "rx", "intruso"));
        assert_eq!((e.kind, e.code), (ErrorKind::Invalid, "not_allowed"), "{:?}", ctx.actor);
        assert_eq!(cancel_queued(&mut w.s, &ctx, &persona_q.queue_id).unwrap_err().code, "not_allowed", "{:?}", ctx.actor);
    }
    assert_eq!(pending(&w.s, &agente(&otra), &a.id).unwrap_err().code, "not_allowed");
    assert_eq!(foto(&w), hasta_aqui);
    assert_eq!(err(pide(&mut w, &p, &persona(), "no-existe-a1", "r1", "x")).code, "attempt_missing");
    // El coordinador cancela lo suyo (y lo de la persona: coordina la Task).
    assert!(matches!(cancel_queued(&mut w.s, &agente(&raiz), &coord_q.queue_id).unwrap(), Cancelled::Cancelled(_)));
    // El Core ve la cola (la entrega la conduce él).
    assert_eq!(pending(&w.s, &core(), &a.id).unwrap().items.len(), 2);
}

// ── Validación ───────────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn una_peticion_invalida_no_escribe_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::libre();
    let hasta_aqui = foto(&w);
    for id in ["", "con espacio", "ñ", &"x".repeat(65)] {
        assert_eq!(err(pide(&mut w, &p, &persona(), &a.id, id, "x")).code, "invalid_request", "request_id {id:?}");
    }
    for body in ["", "   ", "con\u{0}nulo", &"x".repeat(20_001)] {
        assert_eq!(err(pide(&mut w, &p, &persona(), &a.id, "r1", body)).code, "invalid_request", "cuerpo {:?}", body.chars().take(10).collect::<String>());
    }
    let nueve: Vec<String> = (0..9).map(|i| format!("a{i}")).collect();
    let e = err(queue_attempt(&mut w.s, &p, &persona(), &CancelToken::new(), &QueueRequest { request_id: "r1", attempt_id: &a.id, body: "x", attachments: &nueve }));
    assert_eq!(e.code, "invalid_request");
    let e = err(queue_attempt(&mut w.s, &p, &persona(), &CancelToken::new(), &QueueRequest { request_id: "r1", attempt_id: &a.id, body: "x", attachments: &["no-existe".to_string()] }));
    assert_eq!((e.kind, e.code), (ErrorKind::Invalid, "attachment_unknown"));
    assert_eq!(foto(&w), hasta_aqui);
    assert_eq!(p.llamadas.get(), 0);
}

#[test]
fn los_adjuntos_son_artifacts_de_la_task_y_viajan_hasta_el_adapter_sin_entrar_en_los_eventos() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let art = super::worktree_ops::artifact(&mut w.s, &core(), &a.id, &NewArtifact { kind: ArtifactKind::File, uri: "informe.md".into(), sha256: None, bytes: None }).unwrap();
    let p = Puerto::ocupado();
    let q = queue_attempt(&mut w.s, &p, &persona(), &CancelToken::new(), &QueueRequest { request_id: "r1", attempt_id: &a.id, body: "revisa este informe", attachments: std::slice::from_ref(&art.id) }).unwrap();
    assert_eq!(q.item.attachments, std::slice::from_ref(&art.id));
    let e = eventos(&w.s).into_iter().find(|e| e.kind == "attempt.queued").unwrap();
    assert_eq!(payload(&e)["attachments"], 1);
    assert!(!e.payload.contains(&art.id), "el id del adjunto no viaja en el evento");
    p.fin_de_turno();
    entrega(&mut w, &p, &a.id);
    assert_eq!(p.adjuntos.borrow().clone(), [vec![art.id.clone()]], "el adapter recibe los adjuntos de la instrucción");
}

#[test]
fn la_cola_tiene_un_tope_de_pendientes_por_attempt() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    for i in 0..MAX_QUEUE_PENDING {
        ok(pide(&mut w, &p, &persona(), &a.id, &format!("r{i}"), "x"));
    }
    let hasta_aqui = foto(&w);
    let e = err(pide(&mut w, &p, &persona(), &a.id, "una-mas", "x"));
    assert_eq!((e.kind, e.code), (ErrorKind::Invalid, "queue_full"));
    assert_eq!(foto(&w), hasta_aqui);
}

// ── Cancelación del Core ─────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn con_el_token_cancelado_no_se_entrega_nada_y_el_item_sigue_en_cola() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::libre();
    let cancel = CancelToken::new();
    cancel.cancel();
    let q = queue_attempt(&mut w.s, &p, &persona(), &cancel, &QueueRequest { request_id: "r1", attempt_id: &a.id, body: "hazlo", attachments: &[] }).unwrap();
    assert_eq!((q.item.status, q.delivery.unwrap()), (QueueStatus::Queued, DeliveryResult::Nothing));
    assert_eq!(p.llamadas.get(), 0);
    assert!(matches!(entrega(&mut w, &p, &a.id), DeliveryResult::Delivered(_)), "con un token vivo se entrega");
}

// ── Query y Events ───────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn la_query_de_la_cola_pendiente_muestra_lo_que_sigue_y_en_que_orden() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = corre(&mut w, &hija);
    let b = corre(&mut w, &otra);
    let p = Puerto::ocupado();
    let raiz = w.raiz.clone();
    assert!(pending(&w.s, &persona(), &a.id).unwrap().items.is_empty());
    ok(pide(&mut w, &p, &persona(), &a.id, "r1", "uno"));
    ok(pide(&mut w, &p, &agente(&raiz), &a.id, "r2", "dos"));
    ok(pide(&mut w, &p, &persona(), &b.id, "r1", "de la otra"));
    w.s.queue_claim_next(&a.id, 1).unwrap().unwrap(); // `uno` queda en vuelo

    let cola = pending(&w.s, &persona(), &a.id).unwrap();
    assert_eq!((cola.attempt_id.as_str(), cola.task_id.as_str()), (a.id.as_str(), hija.as_str()));
    let vista: Vec<(usize, &str, QueueStatus, &str)> = cola.items.iter().map(|i| (i.position, i.item.body.as_str(), i.item.status, i.item.author_kind.as_str())).collect();
    assert_eq!(vista, [(1, "uno", QueueStatus::Delivering, "person"), (2, "dos", QueueStatus::Queued, "agent")], "lo que se entrega y lo que espera, en orden y con quién lo envió");
    assert_eq!(pending(&w.s, &persona(), &b.id).unwrap().items.len(), 1, "cada Attempt ve su cola, sin mezclar");
    // Serializa para un cliente: la posición va junto a los campos del item.
    let v = serde_json::to_value(&cola).unwrap();
    assert_eq!((v["items"][0]["position"].clone(), v["items"][0]["queue_id"].clone(), v["items"][0]["status"].clone()), (json!(1), json!(format!("{}-q1", a.id)), json!("delivering")));
    assert_eq!(pending(&w.s, &persona(), "no-existe-a1").unwrap_err().code, "attempt_missing");
}

#[test]
fn los_eventos_llevan_el_hecho_y_nunca_la_instruccion() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    let secreto = "SECRETO-no-debe-viajar-en-un-evento";
    let q = ok(pide(&mut w, &p, &persona(), &a.id, "r1", secreto)).item;
    ok(pide(&mut w, &p, &persona(), &a.id, "r2", "otra"));
    cancel_queued(&mut w.s, &persona(), &format!("{}-q2", a.id)).unwrap();
    p.fin_de_turno();
    entrega(&mut w, &p, &a.id);

    let evs: Vec<EventRow> = eventos(&w.s).into_iter().filter(|e| e.kind.starts_with("attempt.queue")).collect();
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["attempt.queued", "attempt.queued", "attempt.queue_cancelled", "attempt.queue_delivered"]);
    for e in &evs {
        assert_eq!((e.entity_kind.as_str(), e.entity_id.as_str(), e.class.as_str()), ("attempt", a.id.as_str(), "state"));
        assert!(!e.payload.contains(secreto) && !e.payload.contains("otra"), "{}", e.kind);
        assert!(e.run_id.is_some() && e.project_id.is_some());
    }
    assert_eq!(payload(&evs[0]), json!({ "task": hija, "n": 1, "queue_id": q.queue_id, "position": 1, "attachments": 0 }));
    assert_eq!(payload(&evs[2]), json!({ "task": hija, "n": 1, "queue_id": format!("{}-q2", a.id) }));
    assert_eq!(payload(&evs[3]), json!({ "task": hija, "n": 1, "queue_id": q.queue_id, "confirmed_by": "adapter_event" }));
    assert_eq!((evs[0].actor_kind.as_str(), evs[0].actor_id.as_deref(), evs[0].channel.as_deref(), evs[0].client_id.as_deref()), ("person", Some("ana"), Some("ui"), Some("cli-desktop")));
    assert_eq!((evs[3].actor_kind.as_str(), evs[3].channel.as_deref()), ("system", Some("core")));
}

#[test]
fn cada_evento_de_la_cola_tiene_su_activity_sin_la_instruccion() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    ok(pide(&mut w, &p, &persona(), &a.id, "r1", "una instrucción privada"));
    ok(pide(&mut w, &p, &persona(), &a.id, "r2", "otra privada"));
    ok(pide(&mut w, &p, &persona(), &a.id, "r3", "y otra"));
    cancel_queued(&mut w.s, &persona(), &format!("{}-q3", a.id)).unwrap();
    p.fin_de_turno();
    p.responde(Err(AdapterError::unknown_run()));
    entrega(&mut w, &p, &a.id);
    p.fin_de_turno();
    entrega(&mut w, &p, &a.id);
    let items: Vec<Value> = eventos(&w.s).iter().filter(|e| e.kind.starts_with("attempt.queue")).map(activity_item).collect();
    let claves: Vec<&str> = items.iter().map(|i| i["message_key"].as_str().unwrap()).collect();
    assert_eq!(
        claves,
        ["activity.attempt.queued", "activity.attempt.queued", "activity.attempt.queued", "activity.attempt.queue_cancelled", "activity.attempt.queue_failed", "activity.attempt.queue_delivered"]
    );
    assert!(items.iter().all(|i| i["fallback"] == false), "ninguno cae al texto de respaldo");
    assert_eq!(items[0]["args"], json!({ "task": hija, "n": 1, "position": 1, "attachments": 0 }));
    assert_eq!(items[4]["args"], json!({ "task": hija, "n": 1, "reason": "adapter_unavailable" }));
    assert_eq!((items[0]["visual"].clone(), items[3]["visual"].clone(), items[4]["visual"].clone(), items[5]["visual"].clone()), (json!("info"), json!("warning"), json!("error"), json!("success")));
    for i in &items {
        assert!(!i["args"].to_string().contains("privada"), "la Activity no lleva la instrucción");
    }
}

// ── Arquitectura ─────────────────────────────────────────────────────────────────────────────────────────────────────

fn produccion(dir: &Path) -> Vec<(String, Vec<(usize, String)>)> {
    let mut out = vec![];
    for entrada in std::fs::read_dir(dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        let prod = texto.split("mod tests {").next().unwrap().to_string();
        out.push((nombre, prod.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")).map(|(n, l)| (n + 1, l.to_string())).collect()));
    }
    out
}

/// Queue nunca es Steer: ni el comando ni el almacén de la cola llaman a `steer`, a `Capability::Steer` ni escriben en el
/// proceso; los hechos de la cola los construye solo `attempt_ops` (que los llama `queue_commands`), y solo `store/queue.rs`
/// escribe `attempt_queue`.
#[test]
fn queue_no_llama_a_steer_y_solo_queue_commands_construye_sus_hechos() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let orch = produccion(&src.join("orch"));
    for (nombre, lineas) in &orch {
        if nombre == "queue_commands.rs" || nombre == "queue_rules.rs" {
            for (n, l) in lineas {
                for prohibido in [".steer(", "Capability::Steer", "stdin", "write_all"] {
                    assert!(!l.contains(prohibido), "orch/{nombre}:{n}: la cola no usa «{prohibido}» (Queue nunca es Steer)");
                }
            }
        }
        for (n, l) in lineas {
            for simbolo in ["attempt_queued(", "attempt_queue_delivered(", "attempt_queue_cancelled(", "attempt_queue_failed("] {
                let permitido = ["event_kinds.rs", "attempt_ops.rs"].contains(&nombre.as_str());
                assert!(!l.contains(simbolo) || permitido, "orch/{nombre}:{n}: «{simbolo}» solo puede aparecer en event_kinds.rs y attempt_ops.rs");
            }
            for simbolo in ["queued_fact(", "queue_delivered_fact(", "queue_cancelled_fact(", "queue_failed_fact("] {
                let permitido = ["attempt_ops.rs", "queue_commands.rs"].contains(&nombre.as_str());
                assert!(!l.contains(simbolo) || permitido, "orch/{nombre}:{n}: «{simbolo}» solo puede aparecer en attempt_ops.rs y queue_commands.rs");
            }
            for metodo in [".queue_enqueue_recorded(", ".queue_claim_next(", ".queue_delivered_recorded(", ".queue_cancel_recorded(", ".queue_failed_recorded("] {
                assert!(!l.contains(metodo) || nombre == "queue_commands.rs", "orch/{nombre}:{n}: «{metodo}» solo puede llamarlo queue_commands.rs");
            }
            assert!(!l.contains("INTO attempt_queue") && !l.contains("UPDATE attempt_queue"), "orch/{nombre}:{n}: orch no escribe SQL de la cola");
        }
    }
    let mut escriben = BTreeSet::new();
    for (nombre, lineas) in produccion(&src.join("store")) {
        for (_, l) in &lineas {
            assert!(!l.contains(".steer(") && !l.contains("Capability::Steer"), "store/{nombre}: el almacén no sabe de Steer");
        }
        if lineas.iter().any(|(_, l)| ["INTO attempt_queue", "UPDATE attempt_queue", "DELETE FROM attempt_queue"].iter().any(|q| l.contains(q))) {
            escriben.insert(nombre);
        }
    }
    assert_eq!(escriben, BTreeSet::from(["queue.rs".to_string()]), "solo store/queue.rs escribe attempt_queue");
}

#[test]
fn los_ids_de_la_cola_no_se_confunden_con_los_del_attempt() {
    // `<attempt>-q<seq>` no puede coincidir con ningún `<task>-a<n>`: la q va tras la a.
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = corre(&mut w, &hija);
    let p = Puerto::ocupado();
    let q = ok(pide(&mut w, &p, &persona(), &a.id, "r1", "x")).item;
    assert_eq!(q.queue_id, format!("{}-q1", a.id));
    assert!(w.s.attempt_row(&q.queue_id).unwrap().is_none());
}
