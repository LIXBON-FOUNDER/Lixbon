//! Adapter falso para pruebas (LXO-128): cubre las seis capabilities, sigue un guion de pasos y apunta cada llamada que
//! LLEGA a él, de modo que una prueba demuestra que `Gated` no dejó pasar una capability no ofrecida. Lo reutilizan las
//! pruebas de los adapters reales y de ContextPackage (LXO-129/130/133/134).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::{
    Answer, AdapterError, AdapterEvent, CancelToken, CapabilityMatrix, EventSink, ProbeResult, ProviderAdapter, ProviderRef, ResumeRequest, RunHandle,
    RunOutcome, StartRequest,
};

/// Un paso del guion de `events`.
#[derive(Clone, Debug)]
pub enum Step {
    Bind(&'static str),
    Output(String),
    Question { id: &'static str, text: String },
    /// Espera a que llegue una cancelación o una interrupción (con tope, para que una prueba rota no cuelgue).
    Wait,
    Complete(Option<String>),
    Fail(AdapterError),
}

pub struct FakeAdapter {
    id: String,
    probe: Mutex<ProbeResult>,
    script: Mutex<Vec<Step>>,
    calls: Mutex<Vec<String>>,
    seq: AtomicU64,
    interrupted: AtomicBool,
    /// Lo que llegó a `start` y a `resume` (LXO-134): una prueba comprueba QUÉ se lanzó y con qué mensaje.
    starts: Mutex<Vec<StartRequest>>,
    resumes: Mutex<Vec<ResumeRequest>>,
    /// Si está, `start` / `resume` devuelven este error en lugar de lanzar.
    start_error: Mutex<Option<AdapterError>>,
    resume_error: Mutex<Option<AdapterError>>,
}

impl FakeAdapter {
    /// Ofrece todo y termina bien tras un `Output`.
    pub fn full(id: &str) -> FakeAdapter {
        FakeAdapter::with_probe(id, ProbeResult::ready(Some("0.0.0-fake"), CapabilityMatrix::all_available()))
    }

    pub fn with_probe(id: &str, probe: ProbeResult) -> FakeAdapter {
        FakeAdapter {
            id: id.to_string(),
            probe: Mutex::new(probe),
            script: Mutex::new(vec![Step::Output("hecho".into()), Step::Complete(Some("ok".into()))]),
            calls: Mutex::new(vec![]),
            seq: AtomicU64::new(0),
            interrupted: AtomicBool::new(false),
            starts: Mutex::new(vec![]),
            resumes: Mutex::new(vec![]),
            start_error: Mutex::new(None),
            resume_error: Mutex::new(None),
        }
    }

    pub fn starts(&self) -> Vec<StartRequest> {
        self.starts.lock().unwrap().clone()
    }

    pub fn resumes(&self) -> Vec<ResumeRequest> {
        self.resumes.lock().unwrap().clone()
    }

    pub fn fail_start_with(&self, e: Option<AdapterError>) {
        *self.start_error.lock().unwrap() = e;
    }

    pub fn fail_resume_with(&self, e: Option<AdapterError>) {
        *self.resume_error.lock().unwrap() = e;
    }

    pub fn set_probe(&self, probe: ProbeResult) {
        *self.probe.lock().unwrap() = probe;
    }

    pub fn set_script(&self, steps: Vec<Step>) {
        *self.script.lock().unwrap() = steps;
    }

    /// Llamadas que llegaron al adapter, en orden (`start`, `events`, `steer:<texto>`…).
    pub fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn note(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }

    fn handle(&self, attempt: &str) -> RunHandle {
        RunHandle { attempt_id: attempt.to_string(), adapter: self.id.clone(), seq: self.seq.fetch_add(1, Ordering::SeqCst) + 1 }
    }

    fn known(&self, run: &RunHandle) -> Result<(), AdapterError> {
        if run.adapter == self.id && run.seq >= 1 && run.seq <= self.seq.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(AdapterError::unknown_run())
        }
    }
}

impl ProviderAdapter for FakeAdapter {
    fn id(&self) -> &str {
        &self.id
    }

    fn probe(&self) -> ProbeResult {
        self.note("probe".into());
        self.probe.lock().unwrap().clone()
    }

    fn start(&self, req: StartRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        self.note("start".into());
        cancel.check()?;
        if let Some(e) = self.start_error.lock().unwrap().clone() {
            return Err(e);
        }
        self.starts.lock().unwrap().push(req.clone());
        self.interrupted.store(false, Ordering::SeqCst);
        Ok(self.handle(&req.attempt_id))
    }

    fn events(&self, run: &RunHandle, cancel: &CancelToken, sink: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        self.note("events".into());
        self.known(run)?;
        for step in self.script.lock().unwrap().clone() {
            if cancel.is_cancelled() {
                return Ok(RunOutcome::Cancelled);
            }
            match step {
                Step::Bind(r) => sink.push(AdapterEvent::SessionBound { provider_ref: ProviderRef::new(r)? }),
                Step::Output(text) => sink.push(AdapterEvent::Output { text }),
                Step::Question { id, text } => sink.push(AdapterEvent::Question { question_id: id.to_string(), text }),
                Step::Wait => {
                    let until = Instant::now() + Duration::from_secs(5);
                    loop {
                        if cancel.is_cancelled() {
                            return Ok(RunOutcome::Cancelled);
                        }
                        if self.interrupted.load(Ordering::SeqCst) {
                            return Ok(RunOutcome::Interrupted);
                        }
                        if Instant::now() > until {
                            return Err(AdapterError::new(super::ErrorCode::Internal, "el fake esperó una señal que no llegó"));
                        }
                        std::thread::sleep(Duration::from_millis(1));
                    }
                }
                Step::Complete(summary) => return Ok(RunOutcome::Completed { summary }),
                Step::Fail(e) => return Ok(RunOutcome::Failed(e)),
            }
        }
        Ok(RunOutcome::Completed { summary: None })
    }

    fn answer(&self, run: &RunHandle, answer: Answer) -> Result<(), AdapterError> {
        self.note(format!("answer:{}", answer.question_id));
        self.known(run)
    }

    fn interrupt(&self, run: &RunHandle) -> Result<(), AdapterError> {
        self.note("interrupt".into());
        self.known(run)?;
        self.interrupted.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn steer(&self, run: &RunHandle, instruction: &str) -> Result<(), AdapterError> {
        self.note(format!("steer:{instruction}"));
        self.known(run)
    }

    fn resume(&self, req: ResumeRequest, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        self.note("resume".into());
        cancel.check()?;
        if let Some(e) = self.resume_error.lock().unwrap().clone() {
            return Err(e);
        }
        self.resumes.lock().unwrap().push(req.clone());
        Ok(self.handle(&req.attempt_id))
    }
}

/// Un fake que solo ofrece lo que se le pide; lo demás cae en los valores por defecto del trait (`unsupported`).
pub struct MinimalAdapter {
    id: String,
}

impl MinimalAdapter {
    pub fn new(id: &str) -> MinimalAdapter {
        MinimalAdapter { id: id.to_string() }
    }
}

impl ProviderAdapter for MinimalAdapter {
    fn id(&self) -> &str {
        &self.id
    }

    fn probe(&self) -> ProbeResult {
        use super::{Capability, CapabilityState};
        let m = CapabilityMatrix::new().with(Capability::Start, CapabilityState::Available).with(Capability::Events, CapabilityState::Available);
        ProbeResult::ready(None, m)
    }

    fn start(&self, req: StartRequest, _cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        Ok(RunHandle { attempt_id: req.attempt_id, adapter: self.id.clone(), seq: 1 })
    }

    fn events(&self, _run: &RunHandle, _cancel: &CancelToken, _sink: &mut dyn EventSink) -> Result<RunOutcome, AdapterError> {
        Ok(RunOutcome::Completed { summary: None })
    }
}
