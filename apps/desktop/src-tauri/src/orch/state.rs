//! Estado del orquestador: runs, árbol de tareas y buzón. Lógica pura (sin
//! procesos ni git) para poder probarla; `mod.rs` la envuelve con el mutex,
//! la persistencia y los efectos.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use super::agents::{self, EnvBlock};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Starting,
    Running,
    Waiting,
    /// La CLI espera una aprobación en su terminal (`approval_deadline`).
    AwaitingTerminalApproval,
    Done,
    Failed,
    Stopped,
    Exited,
}

impl Status {
    pub fn is_final(self) -> bool {
        matches!(self, Status::Done | Status::Failed | Status::Stopped | Status::Exited)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Phase {
    pub name: String,
    pub done: bool,
    #[serde(default)]
    pub note: String,
    pub at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Task {
    pub id: String,
    pub run: String,
    pub parent: Option<String>,
    pub depth: u32,
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Rol de Ajustes → Orquestador con el que se lanzó (explorador, implementador…).
    #[serde(default)]
    pub role: Option<String>,
    pub title: String,
    #[serde(default)]
    pub spec: String,
    pub repo: String,
    /// Proyecto del registro (`orch/projects.rs`) al que pertenece el repositorio de la tarea.
    /// `None` hasta que se asigna: las tareas anteriores a D no lo tienen y el código viejo lo ignora.
    #[serde(default)]
    pub project_id: Option<String>,
    pub cwd: String,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub worktree: Option<String>,
    pub status: Status,
    #[serde(default)]
    pub phases: Vec<Phase>,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub files: Vec<String>,
    /// Informe final de la hija, copiado junto al coordinador.
    #[serde(default)]
    pub report: Option<String>,
    /// Coordinador que corre fuera de Lixbon (una terminal cualquiera).
    #[serde(default)]
    pub external: bool,
    #[serde(default)]
    pub merged: bool,
    #[serde(default)]
    pub pr_url: Option<String>,
    /// Qué se enlazó o copió al crear el worktree (orch/worktree_env.rs); `None` si el repo no tiene reglas.
    #[serde(default)]
    pub env: Option<super::worktree_env::Plan>,
    /// Commit del checkout de destino (el del padre) cuando se creó la rama de la
    /// tarea: referencia para detectar si el destino se movió por fuera.
    #[serde(default)]
    pub base_commit: Option<String>,
    /// Perfil de autonomía pedido al lanzar (id de `agents::Profile`).
    #[serde(default)]
    pub profile: Option<String>,
    /// Quien lanzó confirmó usar una versión de CLI no verificada.
    #[serde(default)]
    pub ack_unverified: bool,
    /// argv que mostró la UI; si no coincide con el que resuelve el host, no se lanza.
    #[serde(default)]
    pub requested_argv: Option<Vec<String>>,
    /// Registro del intento: profile, cli_version, policy_status y ack_unverified.
    #[serde(default)]
    pub policy: Option<super::agents::PolicyRecord>,
    /// Nonce del intento para la entrega por archivo/marcadores (`LXO_REPORT_NONCE`).
    /// `None`: la tarea no tiene activa esa vía.
    #[serde(default)]
    pub report_nonce: Option<String>,
    /// idem_key de los informes ya entregados por archivo/marcadores.
    #[serde(default)]
    pub delivered: Vec<String>,
    /// Por dónde llegó el informe del intento: `exec_o`, `stream_json`,
    /// `report_json`, `stdout` o `lxo_done`. `None`: no llegó nada.
    #[serde(default)]
    pub delivery_channel: Option<String>,
    /// Modelo efectivo que informó la propia CLI (`message.model` de stream-json).
    #[serde(default)]
    pub model_effective: Option<String>,
    /// Modelo pedido tal cual (alias o id) si `--model` va en el argv lanzado; `None` si no se pidió.
    #[serde(default)]
    pub model_requested: Option<String>,
    /// El efectivo no es de la familia del pedido (`haiku` casa con `claude-haiku-*`).
    #[serde(default)]
    pub model_mismatch: bool,
    /// `plan_mode` si hay mismatch y el intento se lanzó con `--permission-mode plan`; si no, `None`.
    #[serde(default)]
    pub model_mismatch_reason: Option<String>,
    /// El intento se lanzó con `--permission-mode plan`.
    #[serde(default)]
    pub plan_mode: bool,
    /// Límite de la espera de aprobación en la terminal (ms epoch) mientras dure.
    #[serde(default)]
    pub approval_deadline: Option<u64>,
    /// Motivo máquina del fallo: `terminal_approval_timeout` o `agent_idle_timeout`.
    #[serde(default)]
    pub failure_reason: Option<String>,
    /// Codex: ruta del rollout de sesión atado a este intento, o `null` si no se
    /// encontró uno solo. Claude: el `session_id` del stream-json.
    #[serde(default)]
    pub session_ref: Option<String>,
    /// De dónde salió `model_effective`: `stream_json` (Claude),
    /// `session_declared` (Codex, `turn_context.model`) o `unknown`. `null`
    /// hasta que termina el intento.
    #[serde(default)]
    pub model_source: Option<String>,
    /// Codex: cómo se ató la sesión al intento, `session_id` o `cwd_time`; `null`
    /// si no se encontró una sola y siempre en Claude.
    #[serde(default)]
    pub session_match: Option<String>,
    /// Inicio del intento actual (ms epoch).
    #[serde(default)]
    pub attempt_started: Option<u64>,
    /// Archivo de `codex exec -o` del intento (perfil read-only de Codex).
    #[serde(default)]
    pub last_message_path: Option<String>,
    /// Lanzada con `claude -p --output-format stream-json`: el informe es el resultado final.
    #[serde(default)]
    pub stream_json: bool,
    pub created: u64,
    pub updated: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Phase,
    Done,
    Question,
    Reply,
    Note,
    Exited,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s.trim() {
            "phase" => Kind::Phase,
            "done" => Kind::Done,
            "question" => Kind::Question,
            "reply" => Kind::Reply,
            "note" => Kind::Note,
            "exited" => Kind::Exited,
            _ => return None,
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Message {
    pub id: u64,
    pub run: String,
    pub from: String,
    pub to: String,
    pub kind: Kind,
    pub body: String,
    #[serde(default)]
    pub reply_to: Option<u64>,
    #[serde(default)]
    pub read: bool,
    pub at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Run {
    pub id: String,
    pub objective: String,
    pub root: String,
    pub created: u64,
    #[serde(default)]
    pub closed: bool,
    #[serde(default)]
    pub last_activity: u64,
}

/// `State.env_blocks` admite el formato anterior (una sola causa por alcance: `"claude/explorar": "cli_missing"`) y el
/// actual (lista de causas); se escribe siempre el actual.
fn de_env_blocks<'de, D: serde::Deserializer<'de>>(d: D) -> Result<BTreeMap<String, BTreeSet<EnvBlock>>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Causas {
        Una(EnvBlock),
        Varias(BTreeSet<EnvBlock>),
    }
    let mapa = BTreeMap::<String, Causas>::deserialize(d)?;
    Ok(mapa
        .into_iter()
        .map(|(k, c)| (k, match c { Causas::Una(c) => BTreeSet::from([c]), Causas::Varias(v) => v }))
        .filter(|(_, v)| !v.is_empty())
        .collect())
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct State {
    pub runs: BTreeMap<String, Run>,
    pub tasks: BTreeMap<String, Task>,
    pub messages: Vec<Message>,
    pub seq: u64,
    /// Decisiones de personas (integraciones), con los campos de la tabla
    /// `decisions` del diseño SQLite para que S1 las importe tal cual.
    #[serde(default)]
    pub decisions: Vec<Decision>,
    /// Bloqueos de ENTORNO vigentes por ALCANCE `proveedor/perfil` (`agents::EnvBlock`, tipado). Un alcance puede tener
    /// VARIAS causas activas a la vez (p. ej. sandbox elevado y flags no soportados): una causa nueva se SUMA y nunca
    /// reemplaza ni levanta a otra; solo la prueba positiva de esa causa concreta la quita. Un bloqueo de banderas o de
    /// sandbox depende del perfil; `CliMissing` es de todo el proveedor. Lo mantiene el host al comprobar la policy antes
    /// de lanzar; permite emitir `environment.blocked` solo al cambiar y `environment.cleared` aunque el Core se haya
    /// reiniciado entre medias. Se lee también el formato anterior (una sola causa por alcance).
    #[serde(default, deserialize_with = "de_env_blocks")]
    pub env_blocks: BTreeMap<String, BTreeSet<EnvBlock>>,
    /// Mayor id de decisión ya usado aunque su Task se retirara (LXO-232): en las tablas las decisiones son historia y
    /// no se reutiliza su id. No se guarda en el documento: lo fija la carga desde las tablas.
    #[serde(skip)]
    pub decision_floor: u64,
}

/// Fila de `decisions`: id, task, kind (merge|pr|release|discard|reopen|stop),
/// actor ('human' o id de tarea), detail_json (texto JSON) y at (ms).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Decision {
    pub id: u64,
    pub task: String,
    pub kind: String,
    pub actor: String,
    pub detail_json: Option<String>,
    pub at: u64,
}

impl State {
    /// Clave de alcance de un bloqueo de entorno.
    pub fn env_scope(provider: &str, profile: &str) -> String {
        format!("{provider}/{profile}")
    }

    /// ¿Hay algún bloqueo de entorno vigente de este proveedor (de cualquier perfil)?
    pub fn has_env_blocks_of(&self, provider: &str) -> bool {
        let prefijo = format!("{provider}/");
        self.env_blocks.iter().any(|(k, causas)| k.starts_with(&prefijo) && !causas.is_empty())
    }

    /// Añade la causa `code` al bloqueo de entorno de `proveedor/perfil`, SIN tocar las otras causas activas del alcance.
    /// `false` = ya estaba (sin cambio).
    pub fn set_env_block(&mut self, provider: &str, profile: &str, code: EnvBlock) -> bool {
        self.env_blocks.entry(State::env_scope(provider, profile)).or_default().insert(code)
    }

    /// Una comprobación POSITIVA de `proveedor/perfil` (`proof`, la evidencia tipada de entorno, no `Policy.status`)
    /// levanta SOLO lo que demuestra: de las causas de ese mismo alcance, las que `proof` desmiente, y los de
    /// `CliMissing` del proveedor si la CLI existe. Una causa que `proof` no desmiente sigue activa aunque otra del mismo
    /// alcance sí caiga, y un bloqueo de otro perfil por banderas o sandbox NO se toca.
    /// Devuelve lo levantado, por orden de alcance y de causa, como `(perfil, causa)`.
    pub fn verify_env(&mut self, provider: &str, profile: &str, proof: agents::EnvProof) -> Vec<(String, EnvBlock)> {
        let prefijo = format!("{provider}/");
        let propio = State::env_scope(provider, profile);
        let mut levantados = vec![];
        for (k, causas) in self.env_blocks.iter_mut().filter(|(k, _)| k.starts_with(&prefijo)) {
            let del_propio = **k == propio;
            let caen: Vec<EnvBlock> = causas.iter().copied().filter(|c| (del_propio || *c == EnvBlock::CliMissing) && proof.demonstrates(*c)).collect();
            for c in caen {
                causas.remove(&c);
                levantados.push((k[prefijo.len()..].to_string(), c));
            }
        }
        self.env_blocks.retain(|_, causas| !causas.is_empty());
        levantados
    }

    pub fn record_decision(&mut self, task: &str, kind: &str, actor: &str, detail: &serde_json::Value) -> u64 {
        let id = self.decisions.iter().map(|d| d.id).max().unwrap_or(0).max(self.decision_floor) + 1;
        self.decision_floor = id;
        self.decisions.push(Decision { id, task: task.into(), kind: kind.into(), actor: actor.into(), detail_json: Some(detail.to_string()), at: now_ms() });
        id
    }
}

pub struct NewTask {
    pub agent: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub role: Option<String>,
    pub title: String,
    pub spec: String,
    pub repo: String,
    pub cwd: String,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub worktree: Option<String>,
    pub external: bool,
}

pub fn slug(text: &str, max: usize) -> String {
    let mut out = String::new();
    for c in text.to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            'ñ' => 'n',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.len() >= max {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() { "tarea".into() } else { out }
}

impl State {
    fn next(&mut self, prefix: &str) -> String {
        self.seq += 1;
        format!("{prefix}{}", self.seq)
    }

    pub fn task(&self, id: &str) -> Result<&Task, String> {
        self.tasks.get(id).ok_or_else(|| format!("No existe la tarea {id}"))
    }

    pub fn task_mut(&mut self, id: &str) -> Result<&mut Task, String> {
        self.tasks.get_mut(id).ok_or_else(|| format!("No existe la tarea {id}"))
    }

    pub fn create_run(&mut self, objective: &str, root: NewTask) -> (String, String) {
        let run = self.next("r");
        let task = self.insert_task(&run, None, 0, root);
        self.runs.insert(run.clone(), Run { id: run.clone(), objective: objective.into(), root: task.clone(), created: now_ms(), closed: false, last_activity: now_ms() });
        (run, task)
    }

    pub fn check_child(&self, parent: &str, max_depth: u32) -> Result<u32, String> {
        let p = self.task(parent)?;
        if p.status.is_final() {
            return Err(format!("La tarea {parent} ya terminó: no puede crear hijos"));
        }
        let depth = p.depth + 1;
        if depth > max_depth {
            return Err(format!(
                "Solo el coordinador reparte tareas: {parent} es una tarea hija. Si necesitas ayuda, díselo con lxo ask o en tu informe."
            ));
        }
        Ok(depth)
    }

    pub fn add_child(&mut self, parent: &str, max_depth: u32, t: NewTask) -> Result<String, String> {
        let depth = self.check_child(parent, max_depth)?;
        let run = self.task(parent)?.run.clone();
        let project_id = self.task(parent)?.project_id.clone();
        let id = self.insert_task(&run, Some(parent.into()), depth, t);
        if let Some(task) = self.tasks.get_mut(&id) {
            task.project_id = project_id;
        }
        Ok(id)
    }

    fn insert_task(&mut self, run: &str, parent: Option<String>, depth: u32, t: NewTask) -> String {
        let id = self.next("t");
        let now = now_ms();
        self.tasks.insert(id.clone(), Task {
            id: id.clone(),
            run: run.into(),
            parent,
            depth,
            agent: t.agent,
            model: t.model,
            effort: t.effort,
            role: t.role,
            title: t.title,
            spec: t.spec,
            repo: t.repo,
            project_id: None,
            cwd: t.cwd,
            branch: t.branch,
            base: t.base,
            worktree: t.worktree,
            status: Status::Starting,
            phases: vec![],
            summary: String::new(),
            files: vec![],
            report: None,
            external: t.external,
            merged: false,
            pr_url: None,
            env: None,
            base_commit: None,
            profile: None,
            ack_unverified: false,
            requested_argv: None,
            policy: None,
            report_nonce: None,
            delivered: vec![],
            delivery_channel: None,
            model_effective: None,
            model_requested: None,
            model_mismatch: false,
            model_mismatch_reason: None,
            plan_mode: false,
            approval_deadline: None,
            failure_reason: None,
            session_ref: None,
            model_source: None,
            session_match: None,
            attempt_started: None,
            last_message_path: None,
            stream_json: false,
            created: now,
            updated: now,
        });
        id
    }

    pub fn post(&mut self, from: &str, to: &str, kind: Kind, body: &str, reply_to: Option<u64>) -> Result<u64, String> {
        let run = self.task(from).or_else(|_| self.task(to))?.run.clone();
        self.seq += 1;
        let id = self.seq;
        self.messages.push(Message { id, run, from: from.into(), to: to.into(), kind, body: body.into(), reply_to, read: false, at: now_ms() });
        Ok(id)
    }

    fn touch(&mut self, id: &str, status: Option<Status>) -> Result<(), String> {
        let t = self.task_mut(id)?;
        if let Some(s) = status {
            t.status = s;
        }
        t.updated = now_ms();
        Ok(())
    }

    /// Una tarea que ya terminó no vuelve a cambiar de estado: un `done` tardío
    /// o un PTY que muere después no deben pisar el resultado.
    fn ensure_open(&self, id: &str) -> Result<(), String> {
        let t = self.task(id)?;
        if t.status.is_final() {
            return Err(format!("La tarea {id} ya terminó ({:?})", t.status).to_lowercase());
        }
        Ok(())
    }

    pub fn mark_running(&mut self, id: &str) -> Result<(), String> {
        self.ensure_open(id)?;
        self.touch(id, Some(Status::Running))
    }

    pub fn phase(&mut self, id: &str, name: &str, done: bool, note: &str) -> Result<Option<u64>, String> {
        self.ensure_open(id)?;
        let t = self.task_mut(id)?;
        t.phases.push(Phase { name: name.into(), done, note: note.into(), at: now_ms() });
        let parent = t.parent.clone();
        let title = t.title.clone();
        self.touch(id, Some(Status::Running))?;
        match parent {
            Some(p) if done => {
                let body = if note.is_empty() { format!("{title}: fase «{name}» terminada") } else { format!("{title}: fase «{name}» terminada. {note}") };
                self.post(id, &p, Kind::Phase, &body, None).map(Some)
            }
            _ => Ok(None),
        }
    }

    pub fn done(&mut self, id: &str, ok: bool, summary: &str, files: Vec<String>, report: Option<String>) -> Result<Option<u64>, String> {
        self.ensure_open(id)?;
        let t = self.task_mut(id)?;
        t.summary = summary.into();
        t.files = files;
        t.report = report.clone();
        let parent = t.parent.clone();
        let title = t.title.clone();
        self.touch(id, Some(if ok { Status::Done } else { Status::Failed }))?;
        match parent {
            Some(p) => {
                let status = if ok { "terminada" } else { "fallida" };
                let body = match &report {
                    Some(r) => format!("{title}: {status}. {summary}
Informe: {r}"),
                    None => format!("{title}: {status}. {summary}"),
                };
                self.post(id, &p, Kind::Done, &body, None).map(Some)
            }
            None => Ok(None),
        }
    }

    pub fn ask(&mut self, id: &str, question: &str) -> Result<u64, String> {
        self.ensure_open(id)?;
        let parent = self.task(id)?.parent.clone().ok_or("La tarea raíz no tiene a quién preguntar: pregunta al usuario directamente")?;
        self.touch(id, Some(Status::Waiting))?;
        self.post(id, &parent, Kind::Question, question, None)
    }

    pub fn reply(&mut self, from: &str, question: u64, answer: &str) -> Result<u64, String> {
        let q = self.messages.iter().find(|m| m.id == question && m.kind == Kind::Question).cloned()
            .ok_or_else(|| format!("No existe la pregunta {question}"))?;
        if q.to != from {
            return Err(format!("La pregunta {question} no va dirigida a {from}"));
        }
        if self.messages.iter().any(|m| m.reply_to == Some(question)) {
            return Err(format!("La pregunta {question} ya tiene respuesta"));
        }
        if !self.task(&q.from)?.status.is_final() {
            self.touch(&q.from, Some(Status::Running))?;
        }
        self.post(from, &q.from, Kind::Reply, answer, Some(question))
    }

    /// Nueva tarea para una hija que ya terminó y sigue con su terminal abierta.
    pub fn reopen(&mut self, id: &str, spec: &str) -> Result<(), String> {
        let t = self.task_mut(id)?;
        if !matches!(t.status, Status::Done | Status::Failed) {
            return Err(format!("{id} no está esperando trabajo nuevo ({:?})", t.status).to_lowercase());
        }
        t.spec = format!("{}

---
Seguimiento:
{spec}", t.spec);
        t.summary.clear();
        t.report = None;
        t.delivery_channel = None;
        t.failure_reason = None;
        t.session_ref = None;
        t.model_source = None;
        t.session_match = None;
        t.approval_deadline = None;
        t.merged = false;
        t.status = Status::Running;
        t.updated = now_ms();
        Ok(())
    }

    pub fn close(&mut self, id: &str, status: Status, why: &str) -> Result<Option<u64>, String> {
        if self.task(id)?.status.is_final() {
            return Ok(None);
        }
        self.touch(id, Some(status))?;
        let t = self.task(id)?;
        match t.parent.clone() {
            Some(p) => {
                let body = format!("{}: {why}", t.title);
                self.post(id, &p, Kind::Exited, &body, None).map(Some)
            }
            None => Ok(None),
        }
    }

    /// La CLI quedó esperando aprobación en su terminal hasta `deadline` (ms epoch).
    pub fn await_terminal_approval(&mut self, id: &str, deadline: u64) -> Result<bool, String> {
        let t = self.task(id)?;
        if t.status.is_final() {
            return Ok(false);
        }
        let t = self.task_mut(id)?;
        t.approval_deadline = Some(deadline);
        self.touch(id, Some(Status::AwaitingTerminalApproval))?;
        Ok(true)
    }

    /// El agente siguió y volvió a escribir: deja de esperar.
    pub fn resume_from_approval(&mut self, id: &str) -> Result<bool, String> {
        if self.task(id)?.status != Status::AwaitingTerminalApproval {
            return Ok(false);
        }
        self.task_mut(id)?.approval_deadline = None;
        self.touch(id, Some(Status::Running))?;
        Ok(true)
    }

    /// Cierra la tarea Failed con un motivo máquina (`failure_reason`) y otro legible.
    pub fn fail_with(&mut self, id: &str, reason: &str, why: &str) -> Result<Option<u64>, String> {
        if self.task(id)?.status.is_final() {
            return Ok(None);
        }
        let t = self.task_mut(id)?;
        t.failure_reason = Some(reason.into());
        t.approval_deadline = None;
        self.close(id, Status::Failed, why)
    }

    pub fn is_ancestor(&self, ancestor: &str, id: &str) -> bool {
        let mut cur = self.tasks.get(id).and_then(|t| t.parent.clone());
        while let Some(p) = cur {
            if p == ancestor {
                return true;
            }
            cur = self.tasks.get(&p).and_then(|t| t.parent.clone());
        }
        false
    }

    /// Lo que un agente puede tocar de otro: solo su propia rama del árbol.
    pub fn ensure_manages(&self, caller: &str, target: &str) -> Result<(), String> {
        if caller == target || self.is_ancestor(caller, target) {
            Ok(())
        } else {
            Err(format!("{caller} no coordina a {target}: solo puedes gestionar tus hijos y sus descendientes"))
        }
    }

    pub fn unread(&self, to: &str, kinds: &[Kind], reply_to: Option<u64>) -> Vec<Message> {
        self.messages.iter()
            .filter(|m| m.to == to && !m.read && (kinds.is_empty() || kinds.contains(&m.kind)))
            .filter(|m| reply_to.is_none() || m.reply_to == reply_to)
            .cloned()
            .collect()
    }

    pub fn mark_read(&mut self, ids: &[u64]) {
        for m in self.messages.iter_mut() {
            if ids.contains(&m.id) {
                m.read = true;
            }
        }
    }

    /// Al arrancar la app no queda ningún PTY vivo de la sesión anterior.
    pub fn orphan_all(&mut self) {
        let open: Vec<String> = self.tasks.values().filter(|t| !t.status.is_final() && !t.external).map(|t| t.id.clone()).collect();
        for id in open {
            let _ = self.close(&id, Status::Exited, "Lixbon se cerró con la tarea en marcha");
        }
    }

    /// Todas las tareas en orden de árbol: cada padre seguido de sus hijas.
    pub fn tree(&self) -> Vec<&Task> {
        fn walk<'a>(st: &'a State, parent: Option<&str>, out: &mut Vec<&'a Task>) {
            let mut kids: Vec<&Task> = st.tasks.values().filter(|t| t.parent.as_deref() == parent).collect();
            kids.sort_by_key(|t| t.created);
            for t in kids {
                out.push(t);
                walk(st, Some(&t.id), out);
            }
        }
        let mut out = vec![];
        walk(self, None, &mut out);
        out
    }

    pub fn children(&self, id: &str) -> Vec<&Task> {
        self.tasks.values().filter(|t| t.parent.as_deref() == Some(id)).collect()
    }

    pub fn run_open_tasks(&self, run: &str) -> Vec<String> {
        let root = self.runs.get(run).map(|r| r.root.as_str());
        self.tasks.values().filter(|t| t.run == run && Some(t.id.as_str()) != root && !t.status.is_final()).map(|t| t.id.clone()).collect()
    }

    pub fn touch_run(&mut self, task: &str) {
        let Some(run) = self.tasks.get(task).map(|t| t.run.clone()) else { return };
        if let Some(r) = self.runs.get_mut(&run) {
            r.last_activity = now_ms();
        }
    }

    fn run_last_activity(&self, run: &Run) -> u64 {
        let tasks = self.tasks.values().filter(|t| t.run == run.id).map(|t| t.updated);
        let messages = self.messages.iter().filter(|m| m.run == run.id).map(|m| m.at);
        tasks.chain(messages).chain([run.created, run.last_activity]).max().unwrap_or(0)
    }

    fn has_unanswered_question(&self, run: &str) -> bool {
        self.messages.iter().any(|q| {
            q.run == run && q.kind == Kind::Question && !self.messages.iter().any(|m| m.reply_to == Some(q.id))
        })
    }

    /// Runs abiertos sin hijas en marcha, sin preguntas por responder, sin terminales
    /// vivas y sin actividad desde hace `idle_ms`.
    pub fn idle_runs(&self, now: u64, idle_ms: u64, live: &[String]) -> Vec<String> {
        self.runs.values()
            .filter(|r| !r.closed)
            .filter(|r| now.saturating_sub(self.run_last_activity(r)) >= idle_ms)
            .filter(|r| self.run_open_tasks(&r.id).is_empty() && !self.has_unanswered_question(&r.id))
            .filter(|r| !live.iter().any(|id| self.tasks.get(id).is_some_and(|t| t.run == r.id)))
            .map(|r| r.id.clone())
            .collect()
    }

    /// Sin hijas en marcha y con todas las ramas propias fusionadas: solo falta cerrar el run.
    pub fn run_wrapped_up(&self, run: &str) -> bool {
        let root = self.runs.get(run).map(|r| r.root.as_str());
        self.tasks.values()
            .filter(|t| t.run == run && Some(t.id.as_str()) != root)
            .all(|t| t.status.is_final() && (t.branch.is_none() || t.merged))
    }

    /// Cierra el run: sin `force` rechaza si quedan hijas en marcha; con `force` las
    /// para. Devuelve las tareas paradas y los avisos generados. Las terminales y
    /// worktrees los limpia `mod.rs`.
    pub fn close_run(&mut self, run: &str, force: bool) -> Result<(Vec<String>, Vec<u64>), String> {
        let root = {
            let r = self.runs.get(run).ok_or_else(|| format!("No existe el run {run}"))?;
            if r.closed {
                return Err(format!("El run {run} ya está cerrado"));
            }
            r.root.clone()
        };
        let open = self.run_open_tasks(run);
        if !open.is_empty() && !force {
            return Err(format!("El run {run} tiene hijas en marcha ({}): espera a que terminen, páralas con lxo stop o usa lxo run close --force", open.join(", ")));
        }
        let mut msgs = vec![];
        for id in &open {
            msgs.extend(self.close(id, Status::Stopped, "detenida al cerrar el run")?);
        }
        if !self.task(&root)?.status.is_final() {
            self.touch(&root, Some(Status::Done))?;
        }
        if let Some(r) = self.runs.get_mut(run) {
            r.closed = true;
        }
        Ok((open, msgs))
    }

    /// `lxo run create` desde una sesión de carpeta: solo se sustituye si la tarea
    /// recordada ya no cuenta (borrada, final o run cerrado). Un run abierto nunca se
    /// cierra por otro chat que comparta carpeta.
    pub fn session_replaceable(&self, id: &str) -> Result<(), String> {
        let Some(t) = self.tasks.get(id) else { return Ok(()) };
        if self.runs.get(&t.run).is_none_or(|r| r.closed) {
            return Ok(());
        }
        Err(format!("Tu run anterior {} sigue abierto: ciérralo con `lxo run close` y vuelve a crear el run", t.run))
    }

    /// Retira UNA tarea que nunca llegó a ser (cleanup de un lanzamiento fallido) con la misma cascada
    /// que `remove_run` aplica a las suyas: sus decisiones legacy y los mensajes que la citan. NO retira
    /// nada si la tarea es la raíz de un run o tiene hijas: una eliminación parcial dejaría referencias
    /// colgando. El historial durable lo conserva el Event Log, no el estado.
    pub fn remove_task(&mut self, id: &str) -> Result<(), String> {
        let t = self.tasks.get(id).ok_or_else(|| format!("La tarea {id} no existe"))?;
        if self.runs.get(&t.run).is_some_and(|r| r.root == id) {
            return Err(format!("{id} es la raíz de su run: no se retira como tarea"));
        }
        if let Some(hija) = self.tasks.values().find(|c| c.parent.as_deref() == Some(id)) {
            return Err(format!("{id} tiene hijas ({}): no se retira una tarea con descendientes", hija.id));
        }
        self.messages.retain(|m| m.from != id && m.to != id);
        self.decisions.retain(|d| d.task != id);
        self.tasks.remove(id);
        Ok(())
    }

    pub fn remove_run(&mut self, run: &str) {
        self.runs.remove(run);
        // Como ON DELETE CASCADE de decisions.task: se van con sus tareas.
        let gone: std::collections::HashSet<String> = self.tasks.values().filter(|t| t.run == run).map(|t| t.id.clone()).collect();
        self.decisions.retain(|d| !gone.contains(&d.task));
        self.tasks.retain(|_, t| t.run != run);
        self.messages.retain(|m| m.run != run);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nt(title: &str) -> NewTask {
        NewTask {
            agent: "claude".into(), model: None, effort: None, role: None, title: title.into(), spec: String::new(), repo: "/r".into(), cwd: "/r".into(),
            branch: None, base: None, worktree: None, external: false,
        }
    }

    #[test]
    fn remove_run_borra_sus_decisiones() {
        let mut s = State::default();
        let (run, root) = s.create_run("obj", nt("raíz"));
        let hija = s.add_child(&root, 1, nt("hija")).unwrap();
        let (otro, otra_raiz) = s.create_run("otro", nt("raíz 2"));
        let ajena = s.add_child(&otra_raiz, 1, nt("ajena")).unwrap();
        s.record_decision(&hija, "merge", "human", &serde_json::json!({ "outcome": "merged" }));
        s.record_decision(&root, "merge", "human", &serde_json::json!({ "outcome": "conflict" }));
        let keep = s.record_decision(&ajena, "merge", "human", &serde_json::json!({ "outcome": "merged" }));
        s.remove_run(&run);
        assert_eq!(s.decisions.iter().map(|d| d.id).collect::<Vec<_>>(), [keep]);
        assert_eq!(s.decisions[0].task, ajena);
        assert!(s.runs.contains_key(&otro));
        let back: State = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.decisions, s.decisions);
    }

    const IDLE: u64 = 30 * 60 * 1000;

    fn aged(s: &mut State, run: &str) {
        s.runs.get_mut(run).unwrap().created = 0;
        s.runs.get_mut(run).unwrap().last_activity = 0;
        s.tasks.values_mut().for_each(|t| t.updated = 0);
        s.messages.iter_mut().for_each(|m| m.at = 0);
    }

    fn idle(s: &State, live: &[String]) -> Vec<String> {
        s.idle_runs(IDLE + 1, IDLE, live)
    }

    #[test]
    fn barrido_cierra_run_inactivo_sin_hijas() {
        let mut s = State::default();
        let (run, root) = s.create_run("obj", nt("raíz"));
        let hijo = s.add_child(&root, 1, nt("hijo")).unwrap();
        s.done(&hijo, true, "ok", vec![], None).unwrap();
        aged(&mut s, &run);
        assert_eq!(idle(&s, &[]), vec![run.clone()]);
        s.close_run(&run, false).unwrap();
        assert!(idle(&s, &[]).is_empty());
    }

    #[test]
    fn barrido_respeta_actividad_hijas_preguntas_y_terminales() {
        let mut s = State::default();
        let (run, root) = s.create_run("obj", nt("raíz"));
        let hijo = s.add_child(&root, 1, nt("hijo")).unwrap();
        aged(&mut s, &run);
        assert!(idle(&s, &[]).is_empty(), "hija en marcha");

        s.done(&hijo, true, "ok", vec![], None).unwrap();
        aged(&mut s, &run);
        s.touch_run(&root);
        assert!(idle(&s, &[]).is_empty(), "actividad reciente del coordinador");

        aged(&mut s, &run);
        assert!(idle(&s, std::slice::from_ref(&hijo)).is_empty(), "terminal viva");
        assert_eq!(idle(&s, &[]).len(), 1);

        let nieto = s.add_child(&root, 1, nt("otra")).unwrap();
        let q = s.ask(&nieto, "¿A o B?").unwrap();
        s.done(&nieto, true, "ok", vec![], None).unwrap();
        aged(&mut s, &run);
        assert!(idle(&s, &[]).is_empty(), "pregunta sin responder");
        s.reply(&root, q, "A").unwrap();
        aged(&mut s, &run);
        assert_eq!(idle(&s, &[]).len(), 1);
    }

    #[test]
    fn run_listo_para_cerrar_exige_ramas_fusionadas() {
        let mut s = State::default();
        let (run, root) = s.create_run("obj", nt("raíz"));
        let hijo = s.add_child(&root, 1, nt("hijo")).unwrap();
        assert!(!s.run_wrapped_up(&run));
        s.done(&hijo, true, "ok", vec![], None).unwrap();
        assert!(s.run_wrapped_up(&run));
        s.task_mut(&hijo).unwrap().branch = Some("lx/x".into());
        assert!(!s.run_wrapped_up(&run));
        s.task_mut(&hijo).unwrap().merged = true;
        assert!(s.run_wrapped_up(&run));
    }

    #[test]
    fn arbol_con_limite_de_profundidad() {
        let mut s = State::default();
        let (_, root) = s.create_run("obj", nt("raíz"));
        let hijo = s.add_child(&root, 1, nt("hijo")).unwrap();
        assert_eq!(s.task(&hijo).unwrap().depth, 1);
        assert!(s.add_child(&hijo, 1, nt("nieto")).is_err());
        assert!(s.is_ancestor(&root, &hijo));
        assert!(s.ensure_manages(&hijo, &root).is_err());
    }

    #[test]
    fn fases_y_fin_avisan_al_padre() {
        let mut s = State::default();
        let (_, root) = s.create_run("obj", nt("raíz"));
        let hijo = s.add_child(&root, 1, nt("api")).unwrap();
        assert!(s.phase(&hijo, "tests", false, "").unwrap().is_none());
        assert!(s.phase(&hijo, "tests", true, "12 ok").unwrap().is_some());
        s.done(&hijo, true, "listo", vec![], Some("informe.md".into())).unwrap();
        let inbox = s.unread(&root, &[Kind::Phase, Kind::Done], None);
        assert_eq!(inbox.len(), 2);
        assert_eq!(s.task(&hijo).unwrap().status, Status::Done);
        assert!(s.done(&hijo, false, "otra vez", vec![], None).is_err());
        s.reopen(&hijo, "corrige el test").unwrap();
        assert_eq!(s.task(&hijo).unwrap().status, Status::Running);
        assert!(s.task(&hijo).unwrap().report.is_none());
        s.done(&hijo, true, "corregido", vec![], None).unwrap();
        assert!(s.close(&hijo, Status::Exited, "pty").unwrap().is_none());
    }

    #[test]
    fn pregunta_y_respuesta() {
        let mut s = State::default();
        let (_, root) = s.create_run("obj", nt("raíz"));
        let hijo = s.add_child(&root, 1, nt("ui")).unwrap();
        let q = s.ask(&hijo, "¿tabs o espacios?").unwrap();
        assert_eq!(s.task(&hijo).unwrap().status, Status::Waiting);
        assert!(s.reply(&hijo, q, "tabs").is_err());
        s.reply(&root, q, "espacios").unwrap();
        assert!(s.reply(&root, q, "otra").is_err());
        assert_eq!(s.task(&hijo).unwrap().status, Status::Running);
        assert_eq!(s.unread(&hijo, &[Kind::Reply], Some(q)).len(), 1);
        assert!(s.ask(&root, "?").is_err());
    }

    #[test]
    fn cerrar_run_rechaza_hijas_en_marcha_salvo_force() {
        let mut s = State::default();
        let (run, root) = s.create_run("obj", nt("raíz"));
        s.mark_running(&root).unwrap();
        let a = s.add_child(&root, 2, nt("a")).unwrap();
        let b = s.add_child(&root, 2, nt("b")).unwrap();
        let nieta = s.add_child(&a, 2, nt("nieta")).unwrap();
        s.done(&b, true, "listo", vec![], None).unwrap();
        let err = s.close_run(&run, false).unwrap_err();
        assert!(err.contains(&a) && err.contains(&nieta) && !s.runs[&run].closed);
        assert_eq!(s.task(&root).unwrap().status, Status::Running);
        let (mut stopped, msgs) = s.close_run(&run, true).unwrap();
        stopped.sort();
        assert_eq!(msgs.len(), 2);
        assert_eq!(stopped, vec![a.clone(), nieta.clone()]);
        assert_eq!(s.task(&a).unwrap().status, Status::Stopped);
        assert_eq!(s.task(&nieta).unwrap().status, Status::Stopped);
        assert_eq!(s.task(&b).unwrap().status, Status::Done);
        assert_eq!(s.task(&root).unwrap().status, Status::Done);
        assert!(s.runs[&run].closed);
        assert!(s.close_run(&run, true).is_err());
    }

    #[test]
    fn cerrar_run_sin_hijas_en_marcha() {
        let mut s = State::default();
        let (run, root) = s.create_run("obj", nt("raíz"));
        let h = s.add_child(&root, 1, nt("h")).unwrap();
        s.done(&h, true, "ok", vec![], None).unwrap();
        assert!(s.close_run(&run, false).unwrap().0.is_empty());
        assert!(s.runs[&run].closed && s.task(&root).unwrap().status.is_final());
        assert!(s.add_child(&root, 1, nt("tarde")).is_err());
    }

    #[test]
    fn sesion_solo_se_sustituye_si_ya_no_cuenta() {
        let mut s = State::default();
        assert!(s.session_replaceable("t26").is_ok());
        let (run, root) = s.create_run("obj", nt("raíz"));
        s.mark_running(&root).unwrap();
        let err = s.session_replaceable(&root).unwrap_err();
        assert!(err.contains(&run) && err.contains("lxo run close"));
        let h = s.add_child(&root, 1, nt("h")).unwrap();
        assert!(s.session_replaceable(&root).is_err());
        s.done(&h, true, "ok", vec![], None).unwrap();
        assert!(s.session_replaceable(&root).is_err());
        s.close_run(&run, false).unwrap();
        assert!(s.session_replaceable(&root).is_ok());
        s.task_mut(&root).unwrap().status = Status::Running;
        assert!(s.session_replaceable(&root).is_ok(), "run cerrado");
        let (run2, root2) = s.create_run("otro", nt("raíz 2"));
        s.mark_running(&root2).unwrap();
        s.remove_run(&run2);
        assert!(s.session_replaceable(&root2).is_ok());
    }

    #[test]
    fn sesion_no_sustituye_raiz_final_con_hijas_abiertas() {
        let mut s = State::default();
        let (run, root) = s.create_run("obj", nt("raíz"));
        let hija = s.add_child(&root, 1, nt("hija")).unwrap();
        s.done(&root, true, "coordinación terminada", vec![], None).unwrap();

        let err = s.session_replaceable(&root).unwrap_err();
        assert!(err.contains(&run) && err.contains("lxo run close"));
        assert!(!s.task(&hija).unwrap().status.is_final(), "la hija sigue abierta cuando se rechaza el reemplazo");
        assert!(!s.runs[&run].closed);

        s.close_run(&run, true).unwrap();
        assert!(s.session_replaceable(&root).is_ok());
    }

    #[test]
    fn continuar_una_hija_invalida_su_fusion() {
        let mut s = State::default();
        let (_, root) = s.create_run("obj", nt("raíz"));
        let h = s.add_child(&root, 1, nt("h")).unwrap();
        s.done(&h, true, "ok", vec![], None).unwrap();
        s.task_mut(&h).unwrap().merged = true;
        s.reopen(&h, "más").unwrap();
        assert!(!s.task(&h).unwrap().merged);
    }

    #[test]
    fn merge_y_release_siguen_con_run_cerrado() {
        let mut s = State::default();
        let (run, root) = s.create_run("obj", nt("raíz"));
        let h = s.add_child(&root, 1, nt("h")).unwrap();
        s.done(&h, true, "ok", vec![], None).unwrap();
        s.close_run(&run, false).unwrap();
        assert!(s.ensure_manages(&root, &h).is_ok());
    }

    #[test]
    fn estado_antiguo_sin_closed_se_lee_abierto() {
        let r: Run = serde_json::from_str(r#"{"id":"r1","objective":"o","root":"t2","created":1}"#).unwrap();
        assert!(!r.closed);
    }

    #[test]
    fn slug_legible() {
        assert_eq!(slug("Añadir API de autenticación!", 40), "anadir-api-de-autenticacion");
        assert_eq!(slug("¿?", 10), "tarea");
    }

    #[test]
    fn espera_de_aprobacion_y_fallo_con_motivo() {
        let mut s = State::default();
        let (_, root) = s.create_run("obj", nt("raíz"));
        let h = s.add_child(&root, 2, nt("hija")).unwrap();
        assert!(s.await_terminal_approval(&h, 123).unwrap());
        let v = serde_json::to_value(s.task(&h).unwrap()).unwrap();
        assert_eq!((v["status"].as_str(), v["approval_deadline"].as_u64()), (Some("awaiting_terminal_approval"), Some(123)));
        assert!(!s.task(&h).unwrap().status.is_final());
        assert!(s.resume_from_approval(&h).unwrap());
        assert_eq!((s.task(&h).unwrap().status, s.task(&h).unwrap().approval_deadline), (Status::Running, None));
        s.await_terminal_approval(&h, 456).unwrap();
        s.fail_with(&h, "terminal_approval_timeout", "nadie aprobó").unwrap();
        let v = serde_json::to_value(s.task(&h).unwrap()).unwrap();
        assert_eq!((v["status"].as_str(), v["failure_reason"].as_str()), (Some("failed"), Some("terminal_approval_timeout")));
        assert!(v["approval_deadline"].is_null());
        // Ya final: ni espera ni otro fallo la cambian.
        assert!(!s.await_terminal_approval(&h, 1).unwrap());
        assert!(s.fail_with(&h, "agent_idle_timeout", "x").unwrap().is_none());
        assert_eq!(s.task(&h).unwrap().failure_reason.as_deref(), Some("terminal_approval_timeout"));
    }

    /// LXO-88: un alcance sin causas no es un bloqueo vigente (no debe disparar la observación del entorno).
    #[test]
    fn un_alcance_vacio_no_cuenta_como_bloqueo_vigente_del_proveedor() {
        let mut s = State::default();
        s.env_blocks.insert("claude/explorar".into(), BTreeSet::new());
        assert!(!s.has_env_blocks_of("claude"), "un conjunto vacío no es un bloqueo");
        assert!(s.set_env_block("claude", "explorar", EnvBlock::CliMissing));
        assert!(s.has_env_blocks_of("claude") && !s.has_env_blocks_of("codex"), "es por proveedor");
        assert!(!s.has_env_blocks_of("clau"), "el proveedor se compara entero");
    }
}
