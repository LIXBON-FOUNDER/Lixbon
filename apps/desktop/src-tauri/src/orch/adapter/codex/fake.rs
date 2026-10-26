//! Servidor falso de Codex para pruebas (LXO-130). Reproduce capturas REALES de `codex app-server` 0.164.0
//! (`orch/testdata/codex-0.164.0-adapter-*.jsonl`) esperando a los mensajes del cliente en el orden en que ocurrieron.
//!
//! Un guion es una lista de valores JSON. Cada paso puede ser:
//! * `{"on": m}`               espera una petición del cliente con método `m` y recuerda su id;
//! * `{"on_notification": m}`  espera una notificación del cliente;
//! * `{"respond": m, "result"|"error": …}`  responde a la última petición `m` con su id;
//! * `{"emit": {…}}`           envía esa línea tal cual (notificación o petición del servidor);
//! * `{"on_response": id}`     espera la respuesta del cliente a una petición del servidor;
//! * `{"gate": "never"}`       no avanza: espera a que lo maten;
//! * cualquier otro objeto o un texto → una línea de stdout tal cual (el respaldo `exec --json`).
//!
//! Los marcadores `on`/`respond`/`emit`/`gate` son SOLO del arnés: no existen en la salida real de Codex.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::orch::adapter::process::{LaunchSpec, Launcher, Process, Recv};
use crate::orch::adapter::redact::safe_text;
use crate::orch::adapter::AdapterError;

pub fn script_of(jsonl: &str) -> Vec<Value> {
    jsonl.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).expect("fixture JSONL válido")).collect()
}

pub struct FakeServer {
    out: Mutex<Receiver<Option<String>>>,
    inbox: Sender<String>,
    written: Arc<Mutex<Vec<Value>>>,
    killed: Arc<AtomicBool>,
    closed: AtomicBool,
    stderr: String,
}

fn espera(inbox: &Receiver<String>, pending: &mut VecDeque<Value>, killed: &AtomicBool, cond: &dyn Fn(&Value) -> bool) -> Option<Value> {
    loop {
        if killed.load(Ordering::SeqCst) {
            return None;
        }
        if let Some(i) = pending.iter().position(cond) {
            return pending.remove(i);
        }
        match inbox.recv_timeout(Duration::from_millis(5)) {
            Ok(l) => pending.push_back(serde_json::from_str(&l).unwrap_or(Value::String(l))),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return None,
        }
    }
}

impl FakeServer {
    pub fn start(script: Vec<Value>, stderr: &str) -> Arc<FakeServer> {
        let (out_tx, out_rx) = channel::<Option<String>>();
        let (in_tx, in_rx) = channel::<String>();
        let written = Arc::new(Mutex::new(Vec::new()));
        let killed = Arc::new(AtomicBool::new(false));
        let k = Arc::clone(&killed);
        thread::spawn(move || {
            let mut pending: VecDeque<Value> = VecDeque::new();
            let mut ids: HashMap<String, Value> = HashMap::new();
            'script: for paso in script {
                if k.load(Ordering::SeqCst) {
                    break;
                }
                let obj = paso.as_object();
                if let Some(m) = obj.and_then(|o| o.get("on")).and_then(Value::as_str) {
                    let Some(msg) = espera(&in_rx, &mut pending, &k, &|v| v["method"] == m && v.get("id").is_some()) else { break 'script };
                    ids.insert(m.to_string(), msg["id"].clone());
                } else if let Some(m) = obj.and_then(|o| o.get("on_notification")).and_then(Value::as_str) {
                    if espera(&in_rx, &mut pending, &k, &|v| v["method"] == m && v.get("id").is_none()).is_none() {
                        break 'script;
                    }
                } else if let Some(id) = obj.and_then(|o| o.get("on_response")) {
                    if espera(&in_rx, &mut pending, &k, &|v| v.get("method").is_none() && v["id"] == *id).is_none() {
                        break 'script;
                    }
                } else if let Some(m) = obj.and_then(|o| o.get("respond")).and_then(Value::as_str) {
                    let id = ids.get(m).cloned().unwrap_or(Value::Null);
                    let mut r = json!({ "id": id });
                    for clave in ["result", "error"] {
                        if let Some(v) = paso.get(clave) {
                            r[clave] = v.clone();
                        }
                    }
                    let _ = out_tx.send(Some(r.to_string()));
                } else if let Some(e) = obj.and_then(|o| o.get("emit")) {
                    let _ = out_tx.send(Some(e.to_string()));
                } else if obj.is_some_and(|o| o.get("gate").is_some()) {
                    while !k.load(Ordering::SeqCst) {
                        thread::sleep(Duration::from_millis(5));
                    }
                    break 'script;
                } else if let Value::String(raw) = &paso {
                    let _ = out_tx.send(Some(raw.clone()));
                } else {
                    let _ = out_tx.send(Some(paso.to_string()));
                }
            }
            let _ = out_tx.send(None);
        });
        Arc::new(FakeServer { out: Mutex::new(out_rx), inbox: in_tx, written, killed, closed: AtomicBool::new(false), stderr: stderr.to_string() })
    }

    /// Todo lo que el cliente escribió (JSON, o texto si no lo es).
    pub fn written(&self) -> Vec<Value> {
        self.written.lock().unwrap().clone()
    }

    pub fn was_killed(&self) -> bool {
        self.killed.load(Ordering::SeqCst)
    }

    pub fn input_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Mensajes del cliente con ese método.
    pub fn sent(&self, method: &str) -> Vec<Value> {
        self.written().into_iter().filter(|v| v["method"] == method).collect()
    }
}

impl Process for FakeServer {
    fn send(&self, line: &str) -> Result<(), AdapterError> {
        if self.killed.load(Ordering::SeqCst) || self.closed.load(Ordering::SeqCst) {
            return Err(AdapterError::provider("la entrada del proceso ya está cerrada"));
        }
        self.written.lock().unwrap().push(serde_json::from_str(line).unwrap_or_else(|_| Value::String(line.to_string())));
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

pub struct FakeLauncher {
    script: Vec<Value>,
    stderr: String,
    pub launched: Mutex<Vec<(LaunchSpec, Arc<FakeServer>)>>,
}

impl FakeLauncher {
    pub fn new(script: Vec<Value>) -> Arc<FakeLauncher> {
        FakeLauncher::with_stderr(script, "")
    }

    pub fn with_stderr(script: Vec<Value>, stderr: &str) -> Arc<FakeLauncher> {
        Arc::new(FakeLauncher { script, stderr: stderr.to_string(), launched: Mutex::new(vec![]) })
    }

    pub fn last(&self) -> (LaunchSpec, Arc<FakeServer>) {
        self.launched.lock().unwrap().last().cloned().expect("se lanzó algún proceso")
    }
}

impl Launcher for FakeLauncher {
    fn launch(&self, spec: &LaunchSpec) -> Result<Arc<dyn Process>, AdapterError> {
        let p = FakeServer::start(self.script.clone(), &self.stderr);
        self.launched.lock().unwrap().push((spec.clone(), Arc::clone(&p)));
        Ok(p)
    }
}
