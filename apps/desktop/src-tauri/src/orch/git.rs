//! Ramas y worktrees de las tareas. Cada hija trabaja en su propio checkout,
//! fuera del repo para no ensuciarlo, sobre una rama que parte de la de su padre.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::hide_console;

pub struct Out {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

pub fn run(dir: &str, args: &[&str]) -> Result<Out, String> {
    let out = hide_console(Command::new("git").args(args).current_dir(dir).env("GIT_TERMINAL_PROMPT", "0"))
        .output()
        .map_err(|e| format!("No se pudo ejecutar git: {e}"))?;
    Ok(Out {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).trim_end().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim_end().to_string(),
    })
}

fn ok(dir: &str, args: &[&str]) -> Result<String, String> {
    let o = run(dir, args)?;
    if o.ok { Ok(o.stdout) } else { Err(format!("git {}: {}", args.join(" "), if o.stderr.is_empty() { o.stdout } else { o.stderr })) }
}

pub fn toplevel(dir: &str) -> Option<String> {
    let top = ok(dir, &["rev-parse", "--show-toplevel"]).ok().filter(|s| !s.is_empty())?;
    // git responde con `/` también en Windows; el resto de rutas usan `\`.
    Some(if cfg!(windows) { top.replace('/', "\\") } else { top })
}

pub fn current_branch(dir: &str) -> Option<String> {
    ok(dir, &["rev-parse", "--abbrev-ref", "HEAD"]).ok().filter(|b| b != "HEAD" && !b.is_empty())
}

/// `<padre-del-repo>/<repo>.lixbon-wt/<nombre>`: al lado del repo, nunca dentro.
pub fn worktree_dir(repo: &str, custom_root: Option<&str>, name: &str) -> PathBuf {
    let repo = Path::new(repo);
    let base = match custom_root.filter(|s| !s.trim().is_empty()) {
        Some(r) => PathBuf::from(r),
        None => {
            let repo_name = repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "repo".into());
            repo.parent().unwrap_or(repo).join(format!("{repo_name}.lixbon-wt"))
        }
    };
    base.join(name)
}

pub fn add_worktree(repo: &str, dir: &Path, branch: &str, base: &str) -> Result<(), String> {
    if dir.exists() {
        return Err(format!("Ya existe la carpeta {}", dir.display()));
    }
    let d = dir.to_string_lossy();
    ok(repo, &["worktree", "add", "-b", branch, &d, base]).map(|_| ())
}

/// `.lixbon/` (el task.md de cada hija) no debe acabar en ningún commit.
pub fn exclude_lixbon_dir(dir: &str) {
    let Ok(common) = ok(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]) else { return };
    let path = Path::new(&common).join("info").join("exclude");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    if current.lines().any(|l| l.trim() == ".lixbon/") {
        return;
    }
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(Path::new(".")));
    let sep = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    let _ = std::fs::write(&path, format!("{current}{sep}.lixbon/\n"));
}

const DIFF_CAP: usize = 200 * 1024;

pub fn diff(dir: &str, base: &str, branch: &str) -> Result<(String, String), String> {
    let range = format!("{base}...{branch}");
    let stat = ok(dir, &["diff", "--stat", &range])?;
    let mut full = ok(dir, &["diff", &range])?;
    if full.len() > DIFF_CAP {
        let mut cut = DIFF_CAP;
        while !full.is_char_boundary(cut) {
            cut -= 1;
        }
        full.truncate(cut);
        full.push_str("\n… (diff recortado)");
    }
    let dirty = ok(dir, &["status", "--porcelain"]).unwrap_or_default();
    let stat = if dirty.is_empty() { stat } else { format!("{stat}\n\nSin commit en el worktree de la tarea:\n{dirty}") };
    Ok((stat, full))
}

pub fn is_clean(dir: &str) -> bool {
    ok(dir, &["status", "--porcelain", "--untracked-files=no"]).map(|s| s.is_empty()).unwrap_or(false)
}

/// Fusiona en el checkout del padre. Con conflictos se aborta y se devuelven
/// los archivos: resolverlos es decisión del coordinador, no de Lixbon.
pub fn merge(parent_dir: &str, branch: &str, message: &str, squash: bool) -> Result<String, String> {
    if !is_clean(parent_dir) {
        return Err("El checkout del padre tiene cambios sin commit: haz commit o stash antes de fusionar".into());
    }
    let args: Vec<&str> = if squash { vec!["merge", "--squash", branch] } else { vec!["merge", "--no-ff", "-m", message, branch] };
    let o = run(parent_dir, &args)?;
    if !o.ok {
        let conflicts = ok(parent_dir, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
        let _ = run(parent_dir, &["merge", "--abort"]);
        if squash {
            let _ = run(parent_dir, &["reset", "--merge"]);
        }
        return Err(if conflicts.is_empty() {
            format!("No se pudo fusionar: {}", if o.stderr.is_empty() { o.stdout } else { o.stderr })
        } else {
            format!("Conflictos al fusionar (merge abortado, nada cambió):\n{conflicts}")
        });
    }
    if squash {
        ok(parent_dir, &["commit", "-m", message])?;
    }
    Ok(o.stdout)
}

pub fn push(dir: &str, branch: &str) -> Result<(), String> {
    ok(dir, &["push", "-u", "origin", branch]).map(|_| ())
}

pub fn gh_pr(dir: &str, base: &str, branch: &str, title: &str, body: &str) -> Result<String, String> {
    let out = hide_console(Command::new("gh").args(["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body]).current_dir(dir))
        .output()
        .map_err(|e| format!("No se pudo ejecutar gh (¿está instalado?): {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        Ok(stdout.lines().last().unwrap_or("").to_string())
    } else {
        Err(format!("gh pr create: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

pub fn remove_worktree(repo: &str, dir: &str, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(dir);
    // Windows tarda un momento en soltar la carpeta tras matar al agente que la usaba.
    let mut last = String::new();
    for _ in 0..8 {
        match ok(repo, &args) {
            Ok(_) => return Ok(()),
            Err(e) if e.contains("Permission denied") || e.contains("being used") => {
                last = e;
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            // Un intento anterior quitó el registro pero no pudo borrar la carpeta.
            Err(e) if e.contains("is not a working tree") => {
                let _ = run(repo, &["worktree", "prune"]);
                return std::fs::remove_dir_all(dir).or_else(|e| if Path::new(dir).exists() { Err(e) } else { Ok(()) }).map_err(|e| e.to_string());
            }
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

pub fn delete_branch(repo: &str, branch: &str) -> Result<(), String> {
    ok(repo, &["branch", "-d", branch]).map(|_| ())
}
