//! Saneado de URLs de PR antes de que lleguen a un payload o al journal de efectos.

const MAX_LEN: usize = 300;

/// Devuelve la URL pública de un PR (`https://host[:puerto]/segmento/...`) o `None` si no es segura.
/// Se descartan usuario y contraseña, query y fragmento; todo lo demás debe encajar en una lista
/// cerrada de caracteres, así que controles, `;`, `%`, `@` en la ruta o barras invertidas la invalidan.
pub(super) fn sanitize_pr_url(raw: &str) -> Option<String> {
    let (scheme, rest) = raw.trim().split_once("://")?;
    if !matches!(scheme, "https" | "http") {
        return None;
    }
    let rest = rest.split(['?', '#']).next()?;
    let (authority, path) = rest.split_at(rest.find('/')?);
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let (host, port) = match host_port.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (host_port, None),
    };
    let host_ok = !host.is_empty()
        && !host.starts_with(['.', '-'])
        && !host.ends_with(['.', '-'])
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'));
    let port_ok = port.is_none_or(|p| (1..=5).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()));
    let path_ok = path[1..]
        .split('/')
        .all(|s| !s.is_empty() && s != "." && s != ".." && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'~' | b'-')));
    if !(host_ok && port_ok && path_ok) {
        return None;
    }
    let clean = format!("{scheme}://{host_port}{path}");
    (clean.len() <= MAX_LEN).then_some(clean)
}

#[cfg(test)]
mod tests {
    use super::sanitize_pr_url;

    #[test]
    fn conserva_las_urls_publicas_validas() {
        for (raw, esperada) in [
            ("https://github.com/o/r/pull/7", "https://github.com/o/r/pull/7"),
            ("http://git.example.com:8080/grupo/sub.grupo/repo/-/merge_requests/3", "http://git.example.com:8080/grupo/sub.grupo/repo/-/merge_requests/3"),
            ("  https://github.com/o/r/pull/7  ", "https://github.com/o/r/pull/7"),
        ] {
            assert_eq!(sanitize_pr_url(raw).as_deref(), Some(esperada), "{raw}");
        }
    }

    #[test]
    fn quita_credenciales_query_y_fragmento() {
        for raw in [
            "https://user:SECRETO@github.com/o/r/pull/1",
            "https://github.com/o/r/pull/1?token=SECRETO",
            "https://github.com/o/r/pull/1#SECRETO",
            "https://user:SECRETO@github.com/o/r/pull/1?token=SECRETO#SECRETO",
            "https://github.com?token=SECRETO/o/r/pull/1",
        ] {
            let limpia = sanitize_pr_url(raw);
            if let Some(url) = &limpia {
                assert_eq!(url, "https://github.com/o/r/pull/1", "{raw}");
            }
            assert!(!limpia.unwrap_or_default().contains("SECRETO"), "{raw}");
        }
        assert_eq!(sanitize_pr_url("https://user:SECRETO@github.com/o/r/pull/1?x=1").as_deref(), Some("https://github.com/o/r/pull/1"));
    }

    #[test]
    fn rechaza_lo_que_no_es_una_url_publica_segura() {
        for raw in [
            "",
            "github.com/o/r/pull/1",
            "ftp://github.com/o/r/pull/1",
            "javascript://github.com/o/r/pull/1",
            "https://",
            "https://github.com",
            "https://github.com/",
            "https:///o/r/pull/1",
            "https://user:pa/ss@github.com/o/r/pull/1",
            "https://github.com/o@r/pull/1",
            "https://github.com/o/r/pull/1;secreto=abc",
            "https://github.com/o/r/pull/1%0Atoken",
            "https://github.com/o/r/pull/1\\..\\x",
            "https://github.com/o/r/pull/1\ntoken",
            "https://github.com/o/r/pull/1\0",
            "https://github.com/o/r//pull/1",
            "https://github.com/o/../pull/1",
            "https://github.com/o/r/pull/ 1",
            "https://github.com:abc/o/r/pull/1",
            "https://github.com:/o/r/pull/1",
            "https://github.com:123456/o/r/pull/1",
            "https://[::1]/o/r/pull/1",
            "https://-github.com/o/r/pull/1",
            "https://gíthub.com/o/r/pull/1",
        ] {
            assert_eq!(sanitize_pr_url(raw), None, "{raw:?}");
        }
        assert_eq!(sanitize_pr_url(&format!("https://github.com/{}", "a".repeat(400))), None, "una URL desmedida se descarta, no se recorta");
    }
}
