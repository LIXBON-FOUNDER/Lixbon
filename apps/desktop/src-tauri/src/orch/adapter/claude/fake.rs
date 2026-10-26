//! Proceso falso de `claude` para pruebas (LXO-129): reproduce un guion hecho con capturas REALES de Claude 2.1.296
//! (`orch/testdata/claude-2.1.296-adapter-*.jsonl`) y espera a que el adapter escriba lo que la CLI de verdad esperaría.
//!
//! Un guion es una lista de valores JSON. Cada uno puede ser:
//! * un objeto normal → una línea de stdout;
//! * un texto (`Value::String`) → una línea cruda, para probar líneas malformadas o cortadas;
//! * `{"__gate": "prompt" | "control_response" | "interrupt" | "never"}` → el proceso se detiene hasta que el adapter
//!   escriba el mensaje correspondiente (`never` no se abre: espera a que lo maten);
//! * `{"__echo": "control_response"}` → la respuesta que daría la CLI a la última petición de control recibida.
//!
//! Los marcadores `__gate`/`__echo` son SOLO del arnés: no existen en la salida real de Claude.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::orch::adapter::process::{LaunchSpec, Launcher, Process, Recv};
use crate::orch::adapter::redact::safe_text;
use crate::orch::adapter::AdapterError;

/// Las líneas de una captura como guion.
pub fn script_of(jsonl: &str) -> Vec<Value> {
    jsonl.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).expect("fixture JSONL válido")).collect()
}

fn matches_gate(kind: &str, v: &Value) -> bool {
    match kind {
        "prompt" => v["type"] == "user",
        "control_response" => v["type"] == "control_response",
        "interrupt" => v["type"] == "control_request" && v["request"]["subtype"] == "interrupt",
        _ => false,
    }
}

pub struct FakeProcess {
    out: Mutex<Receiver<Option<String>>>,
    inbox: Sender<String>,
    written: Arc<Mutex<Vec<Value>>>,
    killed: Arc<AtomicBool>,
    closed: AtomicBool,
    stderr: String,
}

impl FakeProcess {
    pub fn start(script: Vec<Value>, stderr: &str) -> Arc<FakeProcess> {
        let (out_tx, out_rx) = channel::<Option<String>>();
        let (in_tx, in_rx) = channel::<String>();
        let written = Arc::new(Mutex::new(Vec::new()));
        let killed = Arc::new(AtomicBool::new(false));
        let k = Arc::clone(&killed);
        thread::spawn(move || {
            let mut pending: VecDeque<Value> = VecDeque::new();
            let mut last_request: Option<String> = None;
            'script: for item in script {
                if k.load(Ordering::SeqCst) {
                    break;
                }
                match &item {
                    Value::Object(o) if o.contains_key("__gate") => {
                        let kind = o["__gate"].as_str().unwrap_or("").to_string();
                        loop {
                            if k.load(Ordering::SeqCst) {
                                break 'script;
                            }
                            if let Some(i) = pending.iter().position(|v| matches_gate(&kind, v)) {
                                let v = pending.remove(i).unwrap();
                                if let Some(id) = v["request_id"].as_str() {
                                    last_request = Some(id.to_string());
                                }
                                break;
                            }
                            match in_rx.recv_timeout(Duration::from_millis(5)) {
                                Ok(l) => {
                                    if let Ok(v) = serde_json::from_str::<Value>(&l) {
                                        pending.push_back(v);
                                    }
                                }
                                Err(RecvTimeoutError::Timeout) => {}
                                Err(RecvTimeoutError::Disconnected) => break 'script,
                            }
                        }
                    }
                    Value::Object(o) if o.contains_key("__echo") => {
                        let id = last_request.clone().unwrap_or_default();
                        let _ = out_tx.send(Some(json!({ "type": "control_response", "response": { "subtype": "success", "request_id": id, "response": { "still_queued": [] } } }).to_string()));
                    }
                    Value::String(raw) => {
                        let _ = out_tx.send(Some(raw.clone()));
                    }
                    other => {
                        let _ = out_tx.send(Some(other.to_string()));
                    }
                }
            }
            let _ = out_tx.send(None);
        });
        Arc::new(FakeProcess { out: Mutex::new(out_rx), inbox: in_tx, written, killed, closed: AtomicBool::new(false), stderr: stderr.to_string() })
    }

    /// Todo lo que el adapter escribió, ya como JSON.
    pub fn written(&self) -> Vec<Value> {
        self.written.lock().unwrap().clone()
    }

    pub fn was_killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }
}

impl Process for FakeProcess {
    fn send(&self, line: &str) -> Result<(), AdapterError> {
        if self.killed.load(Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
            return Err(AdapterError::provider("la entrada del proceso ya está cerrada"));
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            self.written.lock().unwrap().push(v);
        }
        let _ = self.inbox.send(line.to_string());
        Ok(())
    }

    fn recv(&self, timeout: Duration) -> Recv {
        match self.out.lock().unwrap().recv_timeout(timeout) {
            Ok(Some(l)) => Recv::Line(l),
            Ok(None) | Err(RecvTimeoutError::Disconnected) => Recv::Eof,
            Err(RecvTimeoutError::Timeout) => Recv::Timeout,
        }
    }

    fn close_input(&self) {
        self.closed.store(true, Ordering::SeqCst);
    }

    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
    }

    fn stderr_tail(&self) -> String {
        safe_text(&self.stderr, 4096)
    }
}

/// Lanza procesos falsos con el mismo guion y recuerda cada lanzamiento.
pub struct FakeLauncher {
    script: Vec<Value>,
    stderr: String,
    pub launched: Mutex<Vec<(LaunchSpec, Arc<FakeProcess>)>>,
}

impl FakeLauncher {
    pub fn new(script: Vec<Value>) -> Arc<FakeLauncher> {
        FakeLauncher::with_stderr(script, "")
    }

    pub fn with_stderr(script: Vec<Value>, stderr: &str) -> Arc<FakeLauncher> {
        Arc::new(FakeLauncher { script, stderr: stderr.to_string(), launched: Mutex::new(vec![]) })
    }

    pub fn last(&self) -> (LaunchSpec, Arc<FakeProcess>) {
        self.launched.lock().unwrap().last().cloned().expect("se lanzó algún proceso")
    }
}

impl Launcher for FakeLauncher {
    fn launch(&self, spec: &LaunchSpec) -> Result<Arc<dyn Process>, AdapterError> {
        let p = FakeProcess::start(self.script.clone(), &self.stderr);
        self.launched.lock().unwrap().push((spec.clone(), Arc::clone(&p)));
        Ok(p)
    }
}
