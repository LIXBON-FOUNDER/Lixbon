//! Scope/report transport. The authenticated identity is never supplied in JSON.
use crate::Args;
use serde_json::Value;
use std::io::Read;
use std::process::ExitCode;

fn read_config(reader: impl Read) -> Result<Value, String> {
    let mut bytes = vec![];
    reader
        .take(262145)
        .read_to_end(&mut bytes)
        .map_err(|_| "No se pudo leer config")?;
    if bytes.len() > 262144 {
        return Err("Config supera 256 KiB".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Config JSON inválido")?;
    if !value.is_object() {
        return Err("Config debe ser un objeto".into());
    }
    Ok(value)
}

fn payload(a: &Args) -> Result<(&'static str, Value), String> {
    let report = a.at(0).as_deref() == Some("review-report");
    let path=a.s("config").ok_or("Usa review-scope --config plan.json --confirm o review-report --config report.json; consulta con lxo review <attempt_id>")?;
    let mut value = if path == "-" {
        read_config(std::io::stdin())?
    } else {
        read_config(std::fs::File::open(path).map_err(|_| "No se pudo abrir config")?)?
    };
    if !report {
        value["confirm"] = Value::Bool(a.b("confirm"));
    }
    Ok((
        if report {
            "review_scope_report"
        } else {
            "review_scope"
        },
        value,
    ))
}
pub(super) fn run(a: &Args) -> ExitCode {
    let (cmd, args) = match payload(a) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    match crate::client_auth::rpc(cmd, &args, &crate::cwd()) {
        Ok(value) => {
            println!("{}", serde_json::to_string_pretty(&value).unwrap());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e:?}");
            ExitCode::from(1)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_scope_config_is_a_usage_error() {
        assert!(payload(&crate::parse(vec!["review-scope".into()])).is_err());
    }

    #[test]
    fn stdin_json_is_bounded_and_does_not_need_a_writable_file() {
        assert_eq!(
            read_config(&b"{\"summary\":\"solo lectura\"}"[..]).unwrap()["summary"],
            "solo lectura"
        );
        assert!(read_config(&b"[]"[..]).is_err());
        assert!(read_config(&vec![b' '; 262145][..])
            .unwrap_err()
            .contains("256 KiB"));
    }
}
