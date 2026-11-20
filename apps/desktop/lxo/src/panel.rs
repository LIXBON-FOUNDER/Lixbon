//! Thin authenticated client; Core owns validation, budgets and synthesis.
use crate::Args;
use serde_json::{json, Value};
use std::process::ExitCode;

fn request(a: &Args) -> Result<(&'static str, Value), String> {
    if a.at(1).as_deref() == Some("status") {
        return Ok((
            "panel_status",
            json!({"panel_id":a.at(2).ok_or("Falta panel_id")?}),
        ));
    }
    let path = a
        .s("config")
        .ok_or("Usa lxo panel --config panel.json --confirm; lxo panel status <panel_id>")?;
    use std::io::Read;
    let mut data = vec![];
    std::fs::File::open(path)
        .map_err(|_| "No se pudo abrir config")?
        .take(16_385)
        .read_to_end(&mut data)
        .map_err(|_| "No se pudo leer config")?;
    if data.len() > 16_384 {
        return Err("Config supera 16 KiB".into());
    }
    let mut args: Value = serde_json::from_slice(&data).map_err(|_| "Config debe ser JSON")?;
    if !args.is_object() {
        return Err("Config debe ser un objeto".into());
    }
    // A config file never carries the human confirmation.
    args["confirm"] = json!(a.b("confirm"));
    Ok(("panel", args))
}
pub(super) fn run(a: &Args) -> ExitCode {
    let (cmd, args) = match request(a) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    match crate::client_auth::rpc(cmd, &args, &crate::cwd()) {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap());
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
    fn status_is_read_only() {
        let a = crate::parse(vec!["panel".into(), "status".into(), "pn-test".into()]);
        let (cmd, body) = request(&a).unwrap();
        assert_eq!(cmd, "panel_status");
        assert_eq!(body, json!({"panel_id":"pn-test"}));
    }
    #[test]
    fn missing_config_never_calls_core() {
        assert!(request(&crate::parse(vec!["panel".into(), "--confirm".into()])).is_err());
    }
}
