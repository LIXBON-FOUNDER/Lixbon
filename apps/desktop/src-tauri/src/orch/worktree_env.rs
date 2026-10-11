//! Entorno del worktree de una tarea. Un checkout nuevo no trae `node_modules` ni
//! `.env`; el repo declara qué llevarse y aquí se hace, sin ejecutar nada suyo:
//!
//! - `.lixbon/worktree.json` → `{"sharedDirectories": ["node_modules"]}`: directorios
//!   ignorados por git que se **enlazan** (junction en Windows, symlink en el resto).
//! - `.worktreeinclude` (una ruta por línea, `#` comenta): ficheros o carpetas ignorados
//!   que se **copian**, para que cada worktree tenga los suyos.
//!
//! Las reglas salen del checkout principal. Solo valen rutas relativas, existentes e
//! ignoradas por git; lo que sea absoluto, suba con `..`, toque `.git` o lleve comodines se
//! descarta. Inspirado en las reglas de `.worktreeinclude` y `worktree.sharedDirectories`
//! de Orca (MIT, stablyai/orca).

use std::fs;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;

use serde::{Deserialize, Serialize};

use super::git;
#[cfg(windows)]
use crate::hide_console;

pub const CONFIG: &str = ".lixbon/worktree.json";
pub const INCLUDE: &str = ".worktreeinclude";
const MARKER: &str = ".lixbon/env-links.json";

const MAX_FILE: u64 = 256 * 1024;
const MAX_PATHS: usize = 1000;
const MAX_SHARED: usize = 100;
const MAX_COPY_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_COPY_ENTRIES: u64 = 50_000;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

/// Lo que se hará (o se hizo) en un worktree.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Plan {
    pub shared: Vec<String>,
    pub copy: Vec<String>,
    pub skipped: Vec<Skipped>,
}

impl Plan {
    pub fn is_empty(&self) -> bool {
        self.shared.is_empty() && self.copy.is_empty() && self.skipped.is_empty()
    }

    /// Solo lo que la persona vio y aprobó: unas reglas editadas después no añaden nada.
    pub fn restricted_to(mut self, approved: &Plan) -> Plan {
        self.shared.retain(|p| approved.shared.contains(p));
        self.copy.retain(|p| approved.copy.contains(p));
        self
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Config {
    #[serde(rename = "sharedDirectories")]
    shared_directories: Vec<String>,
}

/// Ruta relativa y segura, con `/` como separador; `Err` con el motivo si no vale.
pub fn normalize(raw: &str) -> Result<String, &'static str> {
    let mut path = raw.trim().replace('\\', "/");
    while let Some(rest) = path.strip_prefix("./") {
        path = rest.to_string();
    }
    let path = path.trim_end_matches('/');
    if path.is_empty() {
        return Err("vacía");
    }
    if path.contains('\0') || path.len() > 260 {
        return Err("ruta no válida");
    }
    if path.starts_with('/') || path.as_bytes().get(1) == Some(&b':') {
        return Err("las rutas absolutas no valen");
    }
    if path.starts_with('!') || path.contains(['*', '?', '[']) {
        return Err("no se admiten comodines ni negaciones");
    }
    for part in path.split('/') {
        match part {
            "" => return Err("segmento vacío"),
            "." | ".." => return Err("no puede salir de la carpeta del repo"),
            p if p.eq_ignore_ascii_case(".git") => return Err("no puede tocar .git"),
            _ => {}
        }
    }
    Ok(path.to_string())
}

fn read_small(path: &Path) -> Option<String> {
    fs::metadata(path).ok().filter(|m| m.is_file() && m.len() <= MAX_FILE)?;
    fs::read_to_string(path).ok()
}

fn clean(list: impl IntoIterator<Item = String>, limit: usize, skipped: &mut Vec<Skipped>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for raw in list.into_iter().take(limit) {
        match normalize(&raw) {
            Ok(p) if !out.contains(&p) => out.push(p),
            Ok(_) => {}
            Err(reason) => skipped.push(Skipped { path: raw.trim().to_string(), reason: reason.into() }),
        }
    }
    out
}

fn include_lines(repo: &Path) -> Vec<String> {
    read_small(&repo.join(INCLUDE))
        .map(|t| t.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from).collect())
        .unwrap_or_default()
}

fn shared_lines(repo: &Path) -> Vec<String> {
    read_small(&repo.join(CONFIG)).and_then(|t| serde_json::from_str::<Config>(&t).ok()).map(|c| c.shared_directories).unwrap_or_default()
}

fn ignored(repo: &str, rel: &str) -> bool {
    git::run(repo, &["check-ignore", "-q", "--", rel]).is_ok_and(|o| o.ok)
}

fn tracked(repo: &str, rel: &str) -> bool {
    git::run(repo, &["ls-files", "--", rel]).is_ok_and(|o| !o.stdout.trim().is_empty())
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Qué se llevaría un worktree nuevo de `repo`. No escribe nada.
pub fn plan(repo: &str) -> Plan {
    let root = Path::new(repo);
    let mut skipped = vec![];
    let shared_wanted = clean(shared_lines(root), MAX_SHARED, &mut skipped);
    let copy_wanted = clean(include_lines(root), MAX_PATHS, &mut skipped);
    let mut plan = Plan { shared: vec![], copy: vec![], skipped };
    let mut skip = |path: &str, reason: &str| plan.skipped.push(Skipped { path: path.into(), reason: reason.into() });
    let mut shared = vec![];
    let mut copy = vec![];

    for rel in shared_wanted {
        let src = root.join(&rel);
        match fs::symlink_metadata(&src) {
            Err(_) => skip(&rel, "no existe en el checkout principal"),
            Ok(m) if !m.is_dir() || m.file_type().is_symlink() => skip(&rel, "no es un directorio real"),
            Ok(_) if tracked(repo, &rel) => skip(&rel, "está versionado"),
            Ok(_) if !ignored(repo, &rel) => skip(&rel, "git no lo ignora"),
            Ok(_) => shared.push(rel),
        }
    }
    let mut budget = (MAX_COPY_BYTES, MAX_COPY_ENTRIES);
    for rel in copy_wanted {
        if shared.contains(&rel) {
            continue;
        }
        let src = root.join(&rel);
        if fs::symlink_metadata(&src).is_err() {
            skip(&rel, "no existe en el checkout principal");
        } else if tracked(repo, &rel) {
            skip(&rel, "está versionado");
        } else if !ignored(repo, &rel) {
            skip(&rel, "git no lo ignora");
        } else {
            let (bytes, entries) = measure(&src);
            if bytes > budget.0 || entries > budget.1 {
                skip(&rel, "supera el límite de 2 GiB o 50 000 entradas");
            } else {
                budget = (budget.0 - bytes, budget.1 - entries);
                copy.push(rel);
            }
        }
    }
    plan.shared = shared;
    plan.copy = copy;
    plan
}

/// Bytes y entradas de una ruta, sin seguir enlaces.
fn measure(path: &Path) -> (u64, u64) {
    let Ok(meta) = fs::symlink_metadata(path) else { return (0, 0) };
    if meta.file_type().is_symlink() {
        return (0, 1);
    }
    if !meta.is_dir() {
        return (meta.len(), 1);
    }
    let (mut bytes, mut entries) = (0, 1);
    for entry in fs::read_dir(path).into_iter().flatten().flatten() {
        let (b, e) = measure(&entry.path());
        bytes += b;
        entries += e;
        if bytes > MAX_COPY_BYTES || entries > MAX_COPY_ENTRIES {
            break;
        }
    }
    (bytes, entries)
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
        }
        return Ok(());
    }
    fs::copy(src, dst).map(|_| ())
}

#[cfg(windows)]
fn link_dir(src: &Path, dst: &Path) -> Result<(), String> {
    let out = hide_console(Command::new("cmd").args(["/C", "mklink", "/J"]).arg(dst).arg(src)).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

#[cfg(not(windows))]
fn link_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(src, dst).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Default)]
struct Marker {
    links: Vec<String>,
}

/// Aplica `plan` en `worktree`. Lo que no se pueda hacer se devuelve en `skipped`;
/// nunca pisa algo que ya exista en el destino.
pub fn apply(repo: &str, worktree: &Path, plan: &Plan) -> Plan {
    let root = Path::new(repo);
    let mut done = Plan { shared: vec![], copy: vec![], skipped: plan.skipped.clone() };
    let prepare = |rel: &str| -> Result<PathBuf, String> {
        let dst = worktree.join(rel);
        if dst.exists() || is_link(&dst) {
            return Err("ya existe en el worktree".into());
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        Ok(dst)
    };

    for rel in &plan.shared {
        match prepare(rel).and_then(|dst| link_dir(&root.join(rel), &dst)) {
            Ok(()) => done.shared.push(rel.clone()),
            Err(e) => done.skipped.push(Skipped { path: rel.clone(), reason: e }),
        }
    }
    for rel in &plan.copy {
        match prepare(rel).and_then(|dst| copy_tree(&root.join(rel), &dst).map_err(|e| e.to_string())) {
            Ok(()) => done.copy.push(rel.clone()),
            Err(e) => done.skipped.push(Skipped { path: rel.clone(), reason: e }),
        }
    }
    if !done.shared.is_empty() {
        let marker = worktree.join(MARKER);
        if let Some(dir) = marker.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(&marker, serde_json::to_vec(&Marker { links: done.shared.clone() }).unwrap_or_default());
    }
    done
}

/// Enlaces que `apply` creó en este worktree (para no contarlos como cambios).
pub fn links(worktree: &Path) -> Vec<String> {
    fs::read(worktree.join(MARKER)).ok().and_then(|b| serde_json::from_slice::<Marker>(&b).ok()).map(|m| m.links).unwrap_or_default()
}

/// Quita los enlaces antes de borrar el worktree: así ningún borrado recursivo puede
/// atravesarlos y tocar el checkout principal. Solo toca lo que es un enlace.
pub fn unlink(worktree: &Path) {
    for rel in links(worktree) {
        let path = worktree.join(&rel);
        if is_link(&path) {
            let _ = fs::remove_dir(&path).or_else(|_| fs::remove_file(&path));
        }
    }
}

/// Líneas de `git status --porcelain` sin las de los enlaces del entorno.
pub fn without_links(worktree: &Path, lines: &str) -> Vec<String> {
    let links = links(worktree);
    lines
        .lines()
        .filter(|line| {
            let path = line.get(3..).unwrap_or("").trim().trim_matches('"').trim_end_matches('/');
            !links.iter().any(|l| l == path || l.starts_with(&format!("{path}/")))
        })
        .map(String::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git_in(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").args(args).current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t")
            .output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    }

    /// Repo con `node_modules`, `.env` y `build/` ignorados y un `src/app.js` versionado.
    fn repo() -> (tempfile_dir::Dir, String) {
        let dir = tempfile_dir::Dir::new("wtenv-repo");
        let p = dir.path();
        git_in(p, &["init", "-q", "-b", "main"]);
        fs::write(p.join(".gitignore"), "node_modules/\n.env\nbuild/\n").unwrap();
        fs::create_dir_all(p.join("src")).unwrap();
        fs::write(p.join("src/app.js"), "x").unwrap();
        fs::create_dir_all(p.join("node_modules/pkg")).unwrap();
        fs::write(p.join("node_modules/pkg/index.js"), "modulo").unwrap();
        fs::write(p.join(".env"), "TOKEN=1").unwrap();
        fs::create_dir_all(p.join("build")).unwrap();
        fs::write(p.join("build/out.txt"), "salida").unwrap();
        git_in(p, &["add", ".gitignore", "src"]);
        git_in(p, &["commit", "-q", "-m", "init"]);
        let path = p.to_string_lossy().into_owned();
        (dir, path)
    }

    fn rules(repo: &str, config: &str, include: &str) {
        let root = Path::new(repo);
        fs::create_dir_all(root.join(".lixbon")).unwrap();
        fs::write(root.join(CONFIG), config).unwrap();
        fs::write(root.join(INCLUDE), include).unwrap();
    }

    #[test]
    fn normaliza_y_rechaza_rutas_peligrosas() {
        assert_eq!(normalize(".\\node_modules\\"), Ok("node_modules".into()));
        assert_eq!(normalize(" ./a/b/ "), Ok("a/b".into()));
        for bad in ["", "/etc/passwd", "C:/x", "C:\\x", "../fuera", "a/../b", "a//b", ".git", "x/.GIT/config", "*.env", "!x", "a?", "a[1]"] {
            assert!(normalize(bad).is_err(), "{bad:?} debía rechazarse");
        }
    }

    #[test]
    fn el_plan_solo_incluye_lo_existente_e_ignorado() {
        let (_d, repo) = repo();
        rules(&repo, r#"{"sharedDirectories":["node_modules","src","falta","../fuera",".env"]}"#, "# secretos\n.env\nbuild\nsrc/app.js\n*.log\n.env\n");
        let p = plan(&repo);
        assert_eq!(p.shared, ["node_modules"]);
        assert_eq!(p.copy, [".env", "build"]);
        let reasons: Vec<(&str, &str)> = p.skipped.iter().map(|s| (s.path.as_str(), s.reason.as_str())).collect();
        for (path, why) in [("src", "versionado"), (".env", "no es un directorio real"),("falta", "no existe"), ("../fuera", "no puede salir"), ("src/app.js", "versionado"), ("*.log", "comodines")] {
            assert!(reasons.iter().any(|(p, r)| *p == path && r.contains(why)), "{path}: {reasons:?}");
        }
    }

    #[test]
    fn sin_reglas_no_hay_nada_que_hacer() {
        let (_d, repo) = repo();
        assert!(plan(&repo).is_empty());
    }

    #[test]
    fn un_directorio_no_ignorado_no_se_enlaza() {
        let (_d, repo) = repo();
        fs::create_dir_all(Path::new(&repo).join("datos")).unwrap();
        fs::write(Path::new(&repo).join("datos/a.txt"), "a").unwrap();
        rules(&repo, r#"{"sharedDirectories":["datos"]}"#, "");
        let p = plan(&repo);
        assert!(p.shared.is_empty());
        assert!(p.skipped.iter().any(|s| s.path == "datos" && s.reason.contains("no lo ignora")), "{:?}", p.skipped);
    }

    #[test]
    fn aplica_enlaza_copia_y_no_pisa() {
        let (_d, repo) = repo();
        rules(&repo, r#"{"sharedDirectories":["node_modules"]}"#, ".env\nbuild\n");
        let wt = tempfile_dir::Dir::new("wtenv-wt");
        fs::write(wt.path().join(".env"), "PROPIO=1").unwrap();
        let done = apply(&repo, wt.path(), &plan(&repo));

        assert_eq!(done.shared, ["node_modules"]);
        assert_eq!(done.copy, ["build"]);
        assert!(done.skipped.iter().any(|s| s.path == ".env" && s.reason.contains("ya existe")), "{:?}", done.skipped);
        assert_eq!(fs::read_to_string(wt.path().join(".env")).unwrap(), "PROPIO=1", "no pisa lo que ya había");
        assert_eq!(fs::read_to_string(wt.path().join("node_modules/pkg/index.js")).unwrap(), "modulo");
        assert!(is_link(&wt.path().join("node_modules")), "node_modules debe ser un enlace");
        assert_eq!(fs::read_to_string(wt.path().join("build/out.txt")).unwrap(), "salida");
        assert!(!is_link(&wt.path().join("build")), "lo copiado es propio");
        assert_eq!(links(wt.path()), ["node_modules"]);
    }

    #[test]
    fn desenlazar_no_toca_el_checkout_principal() {
        let (_d, repo) = repo();
        rules(&repo, r#"{"sharedDirectories":["node_modules"]}"#, "");
        let wt = tempfile_dir::Dir::new("wtenv-unlink");
        apply(&repo, wt.path(), &plan(&repo));
        assert!(wt.path().join("node_modules/pkg/index.js").exists());

        unlink(wt.path());
        assert!(!wt.path().join("node_modules").exists(), "el enlace se quita");
        assert!(Path::new(&repo).join("node_modules/pkg/index.js").exists(), "el original sigue intacto");
        // Un directorio real con ese nombre no se toca aunque figure en el marcador.
        fs::create_dir_all(wt.path().join("node_modules")).unwrap();
        fs::write(wt.path().join("node_modules/propio.txt"), "mio").unwrap();
        unlink(wt.path());
        assert!(wt.path().join("node_modules/propio.txt").exists());
    }

    #[test]
    fn ciclo_real_crear_trabajar_y_borrar_sin_tocar_el_original() {
        let (_d, repo) = repo();
        rules(&repo, r#"{"sharedDirectories":["node_modules"]}"#, ".env\n");
        let base = tempfile_dir::Dir::new("wtenv-ciclo");
        let wt = base.path().join("tarea");
        git::add_worktree(&repo, &wt, "lx/prueba", "main").unwrap();
        let done = apply(&repo, &wt, &plan(&repo));
        let wt_str = wt.to_string_lossy().into_owned();

        assert_eq!((done.shared.as_slice(), done.copy.as_slice()), (["node_modules".to_string()].as_slice(), [".env".to_string()].as_slice()));
        assert!(!git::is_dirty(&wt_str), "el entorno no cuenta como cambios de la tarea");
        fs::write(wt.join("nuevo.txt"), "trabajo").unwrap();
        assert!(git::is_dirty(&wt_str), "pero el trabajo real sí");
        let (stat, _) = git::diff(&wt_str, "main", "lx/prueba").unwrap();
        assert!(stat.contains("nuevo.txt") && !stat.contains("node_modules"), "{stat}");

        git::remove_worktree(&repo, &wt_str, true).unwrap();
        assert!(!wt.exists(), "el worktree se borra");
        assert_eq!(fs::read_to_string(Path::new(&repo).join("node_modules/pkg/index.js")).unwrap(), "modulo", "el original sobrevive");
        assert_eq!(fs::read_to_string(Path::new(&repo).join(".env")).unwrap(), "TOKEN=1");
    }

    #[test]
    fn solo_se_aplica_lo_que_se_aprobo() {
        let (_d, repo) = repo();
        rules(&repo, r#"{"sharedDirectories":["node_modules"]}"#, ".env\n");
        let approved = plan(&repo);
        // Después de aprobar, alguien añade otra ruta a las reglas.
        rules(&repo, r#"{"sharedDirectories":["node_modules"]}"#, ".env\nbuild\n");
        let wt = tempfile_dir::Dir::new("wtenv-aprobado");
        let done = apply(&repo, wt.path(), &plan(&repo).restricted_to(&approved));
        assert_eq!(done.copy, [".env"]);
        assert!(!wt.path().join("build").exists(), "lo no aprobado no se copia");
    }

    #[test]
    fn los_enlaces_no_cuentan_como_cambios() {
        let wt = tempfile_dir::Dir::new("wtenv-status");
        fs::create_dir_all(wt.path().join(".lixbon")).unwrap();
        fs::write(wt.path().join(MARKER), r#"{"links":["node_modules",".cache/pkg"]}"#).unwrap();
        let status = "?? node_modules\n?? .cache/\n M src/app.js\n?? nuevo.txt";
        assert_eq!(without_links(wt.path(), status), [" M src/app.js", "?? nuevo.txt"]);
    }

    /// Carpeta temporal que se borra sola (el crate `tempfile` no está en las dependencias).
    mod tempfile_dir {
        use std::path::{Path, PathBuf};

        pub struct Dir(PathBuf);

        impl Dir {
            pub fn new(name: &str) -> Dir {
                let path = std::env::temp_dir().join(format!("lixbon-{name}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
                let _ = std::fs::remove_dir_all(&path);
                std::fs::create_dir_all(&path).unwrap();
                Dir(path)
            }

            pub fn path(&self) -> &Path {
                &self.0
            }
        }

        impl Drop for Dir {
            fn drop(&mut self) {
                // Un enlace sin quitar haría que el borrado recursivo tocara el original.
                let _ = std::fs::remove_dir(self.0.join("node_modules"));
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }
}
