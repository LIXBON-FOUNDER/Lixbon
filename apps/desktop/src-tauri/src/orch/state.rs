//! Estado del orquestador: runs, árbol de tareas y buzón. Lógica pura (sin
//! procesos ni git) para poder probarla; `mod.rs` la envuelve con el mutex,
//! la persistencia y los efectos.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
pub struct State {
    pub runs: BTreeMap<String, Run>,
    pub tasks: BTreeMap<String, Task>,
    pub messages: Vec<Message>,
    pub seq: u64,
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
        Ok(self.insert_task(&run, Some(parent.into()), depth, t))
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
        if t.status.is_final() || self.runs.get(&t.run).is_none_or(|r| r.closed) {
            return Ok(());
        }
        Err(format!("Tu run anterior {} sigue abierto: ciérralo con `lxo run close` y vuelve a crear el run", t.run))
    }

    pub fn remove_run(&mut self, run: &str) {
        self.runs.remove(run);
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
}
