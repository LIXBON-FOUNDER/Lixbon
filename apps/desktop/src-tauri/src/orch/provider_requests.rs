//! Las peticiones del proveedor (un permiso o una pregunta) que esperan a una persona (LXO-247).
//!
//! El bombeo (`run_pump.rs`) las ve pasar como `AdapterEvent::Permission` / `AdapterEvent::Question`; hasta ahora solo dejaba al
//! Attempt en `awaiting_terminal_approval` con un plazo. Este módulo guarda **cuáles** están pendientes, para que una persona pueda
//! verlas (`attempt_pending_requests`) y responderlas (`attempt_answer`, `answer_runtime.rs`), y vigila el plazo.
//!
//! ```text
//! Permission / Question   ->  push (la primera: el Attempt pasa a `awaiting_terminal_approval` y arranca el plazo)
//! attempt_answer          ->  claim (nadie más la responde a la vez) -> Gated::answer -> finish
//!                             finish: sale de las pendientes; si no queda ninguna, el Attempt vuelve a `running` y el plazo se apaga
//! vence el plazo          ->  el vigilante cancela la ejecución (`failed(terminal_approval_timeout)`)
//! ```
//!
//! Todo vive **en memoria**, atado a la ejecución viva: un reinicio del Core mata la ejecución y con ella lo pendiente (el Attempt
//! ya no está esperando nada que se pueda responder).

use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use super::adapter::AdapterEvent;

/// Cuántas respuestas ya dadas recuerda una ejecución para repetirlas sin volver a llamar al proveedor.
const ANSWERED_CAP: usize = 64;
/// Lo máximo que se cuenta de una petición a quien la lee: el proveedor puede mandar textos largos.
const SHOWN_CHARS: usize = 500;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RequestKind {
    /// El proveedor pide permiso para usar una herramienta: se responde `allow` o `deny`.
    Permission,
    /// El proveedor pregunta algo a la persona: se responde con texto libre.
    Question,
}

impl RequestKind {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            RequestKind::Permission => "permission",
            RequestKind::Question => "question",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ProviderRequest {
    pub(super) id: String,
    pub(super) kind: RequestKind,
    /// Permiso: la herramienta. Pregunta: el texto de la pregunta. Acotado; el adapter ya lo redactó.
    pub(super) subject: String,
    /// Permiso: qué haría. Pregunta: vacío.
    pub(super) summary: String,
    pub(super) asked_at_ms: u64,
    /// Alguien la está respondiendo ahora mismo (entre `claim` y `finish`/`release`).
    answering: bool,
}

fn shown(text: &str) -> String {
    text.chars().take(SHOWN_CHARS).collect()
}

impl ProviderRequest {
    /// La petición que describe un evento del proveedor, si es una.
    pub(super) fn from_event(event: &AdapterEvent, now_ms: u64) -> Option<ProviderRequest> {
        match event {
            AdapterEvent::Permission { request_id, tool, summary } => {
                Some(ProviderRequest { id: request_id.clone(), kind: RequestKind::Permission, subject: shown(tool), summary: shown(summary), asked_at_ms: now_ms, answering: false })
            }
            AdapterEvent::Question { question_id, text } => {
                Some(ProviderRequest { id: question_id.clone(), kind: RequestKind::Question, subject: shown(text), summary: String::new(), asked_at_ms: now_ms, answering: false })
            }
            _ => None,
        }
    }
}

/// Lo que dice `claim` de una petición.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Claim {
    /// Es de quien la pidió: nadie más puede responderla hasta `finish` o `release`.
    Taken(ProviderRequest),
    /// Otra llamada la está respondiendo ahora mismo.
    Busy,
    /// Ya se respondió, con esta decisión.
    Answered(String),
    /// Esa ejecución no tiene (ni tuvo) una petición con ese id.
    Unknown,
}

#[derive(Default)]
pub(super) struct AwaitingState {
    requests: Vec<ProviderRequest>,
    /// Cuándo vence la espera de una respuesta humana. `Some` mientras el Attempt está en `awaiting_terminal_approval`.
    until: Option<Instant>,
    /// Las ya respondidas: `(id, decisión)`, acotadas.
    answered: Vec<(String, String)>,
}

impl AwaitingState {
    /// ¿Ya se vio esta petición (pendiente o respondida)? El proveedor puede repetir un evento.
    pub(super) fn knows(&self, id: &str) -> bool {
        self.requests.iter().any(|r| r.id == id) || self.answered.iter().any(|(a, _)| a == id)
    }

    /// ¿Está el Attempt esperando (con el plazo en marcha)?
    pub(super) fn waiting(&self) -> bool {
        self.until.is_some()
    }

    /// La primera petición: el Attempt ya pasó a `awaiting_terminal_approval` y el plazo empieza.
    pub(super) fn begin(&mut self, request: ProviderRequest, until: Instant) {
        self.requests.push(request);
        self.until = Some(until);
    }

    /// Una petición más mientras se espera: comparte el plazo de la primera.
    pub(super) fn push(&mut self, request: ProviderRequest) {
        self.requests.push(request);
    }

    pub(super) fn pending(&self) -> Vec<ProviderRequest> {
        self.requests.clone()
    }

    pub(super) fn is_due(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| now >= until)
    }

    pub(super) fn claim(&mut self, id: &str) -> Claim {
        match self.requests.iter_mut().find(|r| r.id == id) {
            Some(r) if r.answering => Claim::Busy,
            Some(r) => {
                r.answering = true;
                Claim::Taken(r.clone())
            }
            None => match self.answered.iter().find(|(a, _)| a == id) {
                Some((_, decision)) => Claim::Answered(decision.clone()),
                None => Claim::Unknown,
            },
        }
    }

    /// El proveedor no aceptó la respuesta: la petición sigue pendiente y puede intentarse otra vez.
    pub(super) fn release(&mut self, id: &str) {
        if let Some(r) = self.requests.iter_mut().find(|r| r.id == id) {
            r.answering = false;
        }
    }

    /// El proveedor aceptó la respuesta: la petición sale de las pendientes y se recuerda. `true`: ya no queda ninguna.
    pub(super) fn finish(&mut self, id: &str, decision: &str) -> bool {
        self.requests.retain(|r| r.id != id);
        if self.answered.len() >= ANSWERED_CAP {
            self.answered.remove(0);
        }
        self.answered.push((id.to_string(), decision.to_string()));
        self.requests.is_empty()
    }

    /// Ya no se espera nada: se apaga el plazo. Solo después de que el Attempt haya vuelto a `running`.
    pub(super) fn stop_waiting(&mut self) {
        self.until = None;
    }

    /// Turno nuevo (la cola o un Stop & Send reanudaron la sesión): lo pendiente del turno anterior ya no existe.
    pub(super) fn clear(&mut self) {
        self.requests.clear();
        self.answered.clear();
        self.until = None;
    }
}

/// Las peticiones de una ejecución viva, compartidas entre el bombeo, el vigilante y los RPC.
#[derive(Default)]
pub(super) struct Awaiting {
    inner: Mutex<AwaitingState>,
}

impl Awaiting {
    /// Toma el estado. Orden de candados: este ANTES que el del Core (quien muta bajo él lo hace siempre así).
    pub(super) fn lock(&self) -> MutexGuard<'_, AwaitingState> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn permission(id: &str) -> ProviderRequest {
        ProviderRequest::from_event(&AdapterEvent::Permission { request_id: id.into(), tool: "Bash".into(), summary: "usar Bash".into() }, 10).unwrap()
    }

    #[test]
    fn solo_los_permisos_y_las_preguntas_son_peticiones() {
        assert_eq!(permission("p1").kind, RequestKind::Permission);
        let q = ProviderRequest::from_event(&AdapterEvent::Question { question_id: "q1".into(), text: "¿sigo?".into() }, 10).unwrap();
        assert_eq!((q.kind, q.subject.as_str(), q.summary.as_str()), (RequestKind::Question, "¿sigo?", ""));
        assert!(ProviderRequest::from_event(&AdapterEvent::Output { text: "x".into() }, 10).is_none());
    }

    #[test]
    fn lo_que_se_cuenta_de_una_peticion_esta_acotado() {
        let largo = "x".repeat(SHOWN_CHARS * 3);
        let r = ProviderRequest::from_event(&AdapterEvent::Permission { request_id: "p".into(), tool: largo.clone(), summary: largo }, 1).unwrap();
        assert_eq!((r.subject.chars().count(), r.summary.chars().count()), (SHOWN_CHARS, SHOWN_CHARS));
    }

    #[test]
    fn claim_finish_y_release_llevan_cada_peticion_a_un_solo_desenlace() {
        let mut w = AwaitingState::default();
        assert!(!w.waiting() && w.claim("p1") == Claim::Unknown);
        w.begin(permission("p1"), Instant::now() + Duration::from_secs(60));
        w.push(permission("p2"));
        assert!(w.waiting() && w.knows("p1") && w.knows("p2") && !w.knows("p3"));

        assert!(matches!(w.claim("p1"), Claim::Taken(_)));
        assert_eq!(w.claim("p1"), Claim::Busy, "mientras se responde nadie más puede");
        w.release("p1");
        assert!(matches!(w.claim("p1"), Claim::Taken(_)), "rechazada por el proveedor: se puede intentar otra vez");

        assert!(!w.finish("p1", "allow"), "queda p2");
        assert_eq!(w.claim("p1"), Claim::Answered("allow".into()), "repetirla devuelve lo que ya pasó");
        assert!(w.knows("p1"), "un evento repetido del proveedor no la vuelve a levantar");
        assert!(matches!(w.claim("p2"), Claim::Taken(_)));
        assert!(w.finish("p2", "deny"), "ya no queda ninguna");
        assert!(w.waiting(), "el plazo se apaga solo cuando el Attempt vuelve a correr");
        w.stop_waiting();
        assert!(!w.waiting() && !w.is_due(Instant::now() + Duration::from_secs(3600)));
    }

    #[test]
    fn el_plazo_vence_solo_si_se_espera() {
        let mut w = AwaitingState::default();
        assert!(!w.is_due(Instant::now()));
        w.begin(permission("p1"), Instant::now());
        assert!(w.is_due(Instant::now() + Duration::from_millis(1)));
    }

    #[test]
    fn un_turno_nuevo_olvida_lo_pendiente_y_lo_respondido() {
        let mut w = AwaitingState::default();
        w.begin(permission("p1"), Instant::now() + Duration::from_secs(60));
        w.finish("p1", "allow");
        w.push(permission("p2"));
        w.clear();
        assert!(!w.waiting() && !w.knows("p1") && !w.knows("p2") && w.pending().is_empty());
    }

    #[test]
    fn lo_respondido_esta_acotado() {
        let mut w = AwaitingState::default();
        for n in 0..ANSWERED_CAP + 5 {
            w.finish(&format!("p{n}"), "allow");
        }
        assert!(!w.knows("p0") && w.knows(&format!("p{}", ANSWERED_CAP + 4)));
    }
}
