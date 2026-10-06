use std::collections::HashSet;
#[cfg(windows)]
use std::path::PathBuf;

const USER_ENV: &str = r"HKCU\Environment";
const MACHINE_ENV: &str = r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

pub fn expand_vars(s: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('%') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('%') {
            Some(j) if j > 0 => match lookup(&after[..j]) {
                Some(v) => {
                    out.push_str(&v);
                    rest = &after[j + 1..];
                }
                None => {
                    out.push('%');
                    rest = after;
                }
            },
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn merge_paths(parts: &[&str]) -> String {
    let mut seen = HashSet::new();
    let mut entries: Vec<&str> = Vec::new();
    for part in parts {
        for e in part.split(';') {
            let e = e.trim();
            if e.is_empty() {
                continue;
            }
            let key = e.trim_end_matches(['\\', '/']).to_lowercase();
            if seen.insert(key) {
                entries.push(e);
            }
        }
    }
    entries.join(";")
}

fn parse_reg_value(output: &str, name: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let mut it = line.trim_start().splitn(3, "    ");
        let (n, kind, value) = (it.next()?, it.next()?, it.next()?);
        (n.eq_ignore_ascii_case(name) && kind.starts_with("REG_")).then(|| value.trim().to_string())
    })
}

#[cfg(windows)]
fn read_reg_path(key: &str) -> Option<String> {
    let mut cmd = std::process::Command::new("reg");
    cmd.args(["query", key, "/v", "Path"]);
    crate::hide_console(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = parse_reg_value(&String::from_utf8_lossy(&out.stdout), "Path")?;
    Some(expand_vars(&raw, &|v| std::env::var(v).ok()))
}

// El instalador/updater relanza la app con su propio entorno: el PATH heredado
// no trae las entradas que el registro sí tiene. Orden: actual, máquina, usuario;
// lo ya presente conserva su prioridad y solo se añade lo que falta.
#[cfg(windows)]
pub fn refresh_process_path() {
    let current = std::env::var("PATH").unwrap_or_default();
    let machine = read_reg_path(MACHINE_ENV).unwrap_or_default();
    let user = read_reg_path(USER_ENV).unwrap_or_default();
    let merged = merge_paths(&[&current, &machine, &user]);
    if !merged.is_empty() {
        std::env::set_var("PATH", merged);
    }
}

#[cfg(not(windows))]
pub fn refresh_process_path() {}

#[cfg(windows)]
pub fn claude_fallback() -> Option<PathBuf> {
    let known = [
        ("USERPROFILE", r".local\bin\claude.exe"),
        ("APPDATA", r"npm\claude.cmd"),
        ("LOCALAPPDATA", r"Programs\claude\claude.exe"),
    ];
    known.iter().find_map(|(var, rel)| {
        let p = PathBuf::from(std::env::var_os(var)?).join(rel);
        p.is_file().then_some(p)
    })
}

#[cfg(windows)]
pub fn claude_on_path() -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path)
        .any(|d| ["claude.exe", "claude.cmd"].iter().any(|f| d.join(f).is_file()))
}

pub fn path_with_dir(current: &str, dir: &str) -> String {
    merge_paths(&[current, dir])
}

// No se pasa la ruta absoluta a `cmd /C`: con espacios y argumentos entre
// comillas cmd quita las comillas exteriores y rompe la línea.
#[cfg(windows)]
pub fn ensure_claude_on_path() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    if claude_on_path() {
        return;
    }
    ONCE.call_once(|| {
        let Some(dir) = claude_fallback().and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned())) else {
            return;
        };
        let current = std::env::var("PATH").unwrap_or_default();
        std::env::set_var("PATH", path_with_dir(&current, &dir));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedup_sin_distinguir_mayusculas_ni_barra_final() {
        let m = merge_paths(&[r"C:\A;C:\B\", r"c:\a\;C:\C", r"c:\b;;C:\D"]);
        assert_eq!(m, r"C:\A;C:\B\;C:\C;C:\D");
    }

    #[test]
    fn conserva_el_orden_actual_primero() {
        assert_eq!(merge_paths(&[r"C:\X", r"C:\M", r"C:\U"]), r"C:\X;C:\M;C:\U");
    }

    #[test]
    fn anade_directorio_una_sola_vez() {
        let once = path_with_dir(r"C:\A", r"C:\Users\Ana B\.local\bin");
        assert_eq!(once, r"C:\A;C:\Users\Ana B\.local\bin");
        assert_eq!(path_with_dir(&once, r"c:\users\ana b\.local\bin\"), once);
    }

    #[test]
    fn expande_variables() {
        let l = |v: &str| (v == "USERPROFILE").then(|| r"C:\Users\Ana".to_string());
        assert_eq!(expand_vars(r"%USERPROFILE%\.local\bin;%X%\y;100%", &l), r"C:\Users\Ana\.local\bin;%X%\y;100%");
    }

    #[test]
    fn parsea_salida_de_reg_query() {
        let out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\x\r\n\r\n";
        assert_eq!(parse_reg_value(out, "Path").unwrap(), r"%USERPROFILE%\bin;C:\x");
    }
}
