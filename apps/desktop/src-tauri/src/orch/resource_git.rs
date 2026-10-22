//! LXO-93 · consultas de git de SOLO LECTURA para el inventario de recursos.
//!
//! A diferencia de `git.rs` (que decide pensando en borrar o integrar y trata un fallo de git como «no»),
//! aquí un fallo es `None` / [`GitFail`]: **desconocido, nunca «no existe»**. Ningún comando de este módulo
//! escribe en el repositorio: nada de `worktree prune`, `fetch`, `gc` ni `branch -d`, y todos corren con
//! `--no-optional-locks` (sin refrescar el índice) y `core.fsmonitor=false` (sin arrancar un demonio).
//! Cada llamada tiene un tope de tiempo: un repo en un disco de red caído no cuelga el inventario.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::hide_console;

/// Tope de una consulta de git.
const TIMEOUT: Duration = Duration::from_secs(15);

/// Por qué no se pudo preguntar a git. Códigos estables para el contrato.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum GitFail {
    /// La carpeta del repositorio no existe en disco.
    PathMissing,
    /// La carpeta existe pero git dice que no es un repositorio.
    NotARepository,
    /// No se pudo ejecutar `git` en este equipo.
    GitNotInstalled,
    /// La consulta superó el tope de tiempo.
    Timeout,
    /// Git respondió con un error que no sabemos interpretar.
    GitFailed,
}

impl GitFail {
    pub(super) fn code(self) -> &'static str {
        match self {
            GitFail::PathMissing => "path_missing",
            GitFail::NotARepository => "not_a_repository",
            GitFail::GitNotInstalled => "git_not_installed",
            GitFail::Timeout => "timeout",
            GitFail::GitFailed => "git_failed",
        }
    }
}

struct Out {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run(dir: &str, args: &[&str]) -> Result<Out, GitFail> {
    if !Path::new(dir).is_dir() {
        return Err(GitFail::PathMissing);
    }
    let mut command = Command::new("git");
    command
        .args(["--no-optional-locks", "-c", "core.fsmonitor=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = hide_console(&mut command).spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            GitFail::GitNotInstalled
        } else {
            GitFail::GitFailed
        }
    })?;
    // Las dos salidas se leen en hilos para que un `stdout` grande no bloquee a git mientras se espera.
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let stdout = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    });
    let stderr = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    });
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GitFail::Timeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => return Err(GitFail::GitFailed),
        }
    };
    let text = |handle: std::thread::JoinHandle<Vec<u8>>| {
        String::from_utf8_lossy(&handle.join().unwrap_or_default())
            .trim_end()
            .to_string()
    };
    Ok(Out {
        code: status.code(),
        stdout: text(stdout),
        stderr: text(stderr),
    })
}

/// Un worktree tal como lo lista `git worktree list --porcelain`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Listed {
    pub path: String,
    /// Rama en forma corta (`lx/run/t1-x`); `None` si está en HEAD desacoplado.
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    pub locked: bool,
    /// Git lo marca como «podable»: está registrado pero su carpeta ya no existe.
    pub prunable: bool,
}

/// Todos los worktrees del repositorio de `repo`; el primero es siempre el checkout principal.
pub(super) fn worktree_list(repo: &str) -> Result<Vec<Listed>, GitFail> {
    let out = run(repo, &["worktree", "list", "--porcelain"])?;
    if out.code != Some(0) {
        return Err(not_a_repo_or_failed(&out));
    }
    let mut list = Vec::new();
    let mut current: Option<Listed> = None;
    for line in out.stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            list.extend(current.take());
            current = Some(Listed {
                path: path.trim().to_string(),
                branch: None,
                detached: false,
                bare: false,
                locked: false,
                prunable: false,
            });
        } else if let Some(entry) = current.as_mut() {
            if let Some(branch) = line.strip_prefix("branch ") {
                entry.branch = Some(
                    branch
                        .trim()
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch.trim())
                        .to_string(),
                );
            } else if line.trim() == "detached" {
                entry.detached = true;
            } else if line.trim() == "bare" {
                entry.bare = true;
            } else if line.starts_with("locked") {
                entry.locked = true;
            } else if line.starts_with("prunable") {
                entry.prunable = true;
            }
        }
    }
    list.extend(current);
    if list.is_empty() {
        return Err(GitFail::GitFailed);
    }
    Ok(list)
}

fn not_a_repo_or_failed(out: &Out) -> GitFail {
    if out.stderr.to_lowercase().contains("not a git repository") {
        GitFail::NotARepository
    } else {
        GitFail::GitFailed
    }
}

/// Ramas locales (`refs/heads/*`) del repositorio.
pub(super) fn local_branches(repo: &str) -> Result<BTreeSet<String>, GitFail> {
    let out = run(
        repo,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )?;
    if out.code != Some(0) {
        return Err(not_a_repo_or_failed(&out));
    }
    Ok(out
        .stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// ¿Tiene el worktree cambios sin guardar? `None` si no se pudo comprobar. Ignora `.lixbon` y los enlaces del
/// entorno, igual que `git::is_dirty`, pero un fallo NO cuenta como «sucio».
pub(super) fn is_dirty(worktree: &str) -> Option<bool> {
    let out = run(worktree, &["status", "--porcelain"]).ok()?;
    if out.code != Some(0) {
        return None;
    }
    Some(
        super::worktree_env::without_links(Path::new(worktree), &out.stdout)
            .iter()
            .any(|l| !l.contains(".lixbon")),
    )
}

/// ¿Es `branch` ancestro de `into`? `git merge-base --is-ancestor` responde 0 (sí), 1 (no) o un error (128: una
/// de las dos refs no existe): el error es `None`, no «no fusionada».
pub(super) fn is_ancestor(repo: &str, branch: &str, into: &str) -> Option<bool> {
    let out = run(repo, &["merge-base", "--is-ancestor", branch, into]).ok()?;
    match out.code {
        Some(0) => Some(true),
        Some(1) => Some(false),
        _ => None,
    }
}

/// Rama por defecto del repositorio (la de `origin/HEAD` o, sin remoto, la rama actual del checkout principal).
pub(super) fn default_branch(repo: &str) -> Option<String> {
    if let Ok(out) = run(
        repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) {
        if let Some(branch) = out
            .stdout
            .strip_prefix("origin/")
            .filter(|b| out.code == Some(0) && !b.is_empty())
        {
            return Some(branch.to_string());
        }
    }
    let out = run(repo, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    (out.code == Some(0) && out.stdout != "HEAD" && !out.stdout.is_empty()).then_some(out.stdout)
}
