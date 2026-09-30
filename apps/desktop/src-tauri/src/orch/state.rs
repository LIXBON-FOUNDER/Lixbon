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
        self.runs.insert(run.clone(), Run { id: run.clone(), objective: objective.into(), root: task.clone(), created: now_ms() });
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
    fn slug_legible() {
        assert_eq!(slug("Añadir API de autenticación!", 40), "anadir-api-de-autenticacion");
        assert_eq!(slug("¿?", 10), "tarea");
    }
}
