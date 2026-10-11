//! El CLI de Lixbon como agente hijo (`lixbon worker`): argv por perfil, modelo
//! `modelo@proveedor`, detección de un CLI sin `worker`, perfiles como modelos y roles.

use std::collections::BTreeMap;

use super::agents::{self, Detected, Delivery, Policy, Probe, Profile, Status};
use super::providers;
use super::roles::{self, RoleCfg};

fn policy(profile: Profile, detected: Detected) -> Policy {
    agents::evaluate_for(agents::LIXBON_CLI, profile, Some("implementador"), "wt", detected, false, Delivery::FileOrMarkers)
}

#[test]
fn el_modelo_de_un_rol_lleva_el_proveedor_tras_la_arroba() {
    assert_eq!(agents::split_cli_model("qwen3:8b@ollama"), ("qwen3:8b", Some("ollama")));
    assert_eq!(agents::split_cli_model("meta/llama-3@openrouter"), ("meta/llama-3", Some("openrouter")));
    assert_eq!(agents::split_cli_model("@kilo"), ("", Some("kilo")));
    assert_eq!(agents::split_cli_model("gpt-4o"), ("gpt-4o", None));
    assert_eq!(agents::split_cli_model("raro@"), ("raro@", None));
}

#[test]
fn cada_perfil_lanza_lixbon_worker_sin_interfaz() {
    for profile in [Profile::Explorar, Profile::Proponer, Profile::DelegarConRevision] {
        let p = policy(profile, Detected::Skip);
        assert_eq!(p.argv, ["lixbon", "worker", "--profile", profile.id()], "{profile:?}");
        assert!(!p.interactive, "{profile:?}: corre sin teclado");
        assert!(p.warnings.iter().any(|w| w == agents::WARN_LIXBON_CLI));
    }
    assert!(policy(Profile::Explorar, Detected::Skip).warnings.iter().any(|w| w == agents::WARN_LIXBON_CLI_PLAN));
    assert!(policy(Profile::DelegarConRevision, Detected::Skip).warnings.iter().any(|w| w == agents::WARN_LIXBON_CLI_DELEGAR));
    let amplia = policy(Profile::AutonomiaAmplia, Detected::Skip);
    assert_eq!((amplia.status, amplia.reason.as_deref()), (Status::Blocked, Some(agents::DEFERRED)));
}

#[test]
fn el_lanzamiento_lleva_proveedor_y_modelo_antes_del_encargo() {
    let p = policy(Profile::DelegarConRevision, Detected::Skip);
    let l = agents::launch_with(&p, Some("qwen3:8b@ollama"), None, "Lee la tarea").unwrap();
    assert_eq!(l.command, "lixbon worker --profile delegar_con_revision --provider ollama --model qwen3:8b \"Lee la tarea\"");
    assert!(!l.piped && l.inject.is_none());
    let sin_modelo = agents::launch_with(&p, None, None, "x").unwrap().command;
    assert_eq!(sin_modelo, "lixbon worker --profile delegar_con_revision \"x\"");
    let solo_proveedor = agents::launch_with(&p, Some("@kilo"), None, "x").unwrap().command;
    assert!(solo_proveedor.contains("--provider kilo") && !solo_proveedor.contains("--model"), "{solo_proveedor}");
}

#[test]
fn rechaza_lo_que_no_se_puede_pasar_al_cli() {
    let p = policy(Profile::Explorar, Detected::Skip);
    assert!(agents::launch_with(&p, Some("x@y & del"), None, "x").is_err());
    assert!(agents::launch_with(&p, Some("modelo\"@p"), None, "x").is_err());
    assert!(agents::launch_with(&p, None, Some("high"), "x").err().unwrap().contains("no admite --effort"));
    let bloqueada = policy(Profile::AutonomiaAmplia, Detected::Skip);
    assert!(agents::launch_with(&bloqueada, None, None, "x").is_err());
}

#[test]
fn un_cli_sin_worker_queda_bloqueado_y_uno_con_worker_se_verifica() {
    let nuevo = Probe {
        version: Some("2.3.0".into()),
        help: Some("Uso: lixbon worker --profile explorar|proponer|delegar_con_revision [--provider PERFIL] [--model MODELO]".into()),
        ..Default::default()
    };
    let p = policy(Profile::DelegarConRevision, Detected::Found(&nuevo));
    assert_eq!((p.status, p.reason), (Status::Ok, None));

    let viejo = Probe {
        version: Some("2.3.0".into()),
        help: Some("lixbon: comando desconocido \"worker\"\n\nComandos:\n  init\n  chat".into()),
        ..Default::default()
    };
    let p = policy(Profile::DelegarConRevision, Detected::Found(&viejo));
    assert_eq!(p.status, Status::Blocked);
    assert!(p.reason.unwrap().contains("--profile"));

    let otra_version = Probe { version: Some("9.9.9".into()), ..nuevo };
    assert_eq!(policy(Profile::Explorar, Detected::Found(&otra_version)).status, Status::Unverified);
    assert_eq!(policy(Profile::Explorar, Detected::Missing).status, Status::Blocked);
}

const PROFILES: &str = r#"[{"name":"lixbon","kind":"gateway","base_url":"https://lixbon.com/v1","model":"qwen3.5:2b","active":true},
    {"name":"ollama","kind":"generic","base_url":"http://localhost:11434/v1","model":"","active":false},
    {"name":"kilo","kind":"generic","base_url":"https://api.kilo.ai/api/gateway","model":"kilo-auto/free","active":false}]"#;
const WORKER_HELP: &str = "Uso: lixbon worker --profile explorar|proponer|delegar_con_revision [--provider PERFIL] [--model MODELO]";

#[test]
fn los_perfiles_del_cli_son_los_modelos_del_rol() {
    let models = providers::lixbon_profile_models(PROFILES);
    let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, ["qwen3.5:2b@lixbon", "kilo-auto/free@kilo"]);
    assert!(models.iter().all(|m| m.verified));
    assert_eq!(models[1].label, "kilo · kilo-auto/free");
    assert!(providers::lixbon_profile_models("no es json").is_empty());
    assert!(providers::lixbon_profile_models(r#"[{"name":"x y","model":"m & del"}]"#).is_empty());
}

#[test]
fn proveedor_disponible_solo_con_el_cli_instalado_y_con_worker() {
    let p = providers::lixbon_cli(true, Some("2.3.0"), Some(WORKER_HELP), Some(PROFILES));
    assert!(p.available && p.disabled_reason.is_none(), "{:?}", p.disabled_reason);
    assert_eq!((p.id.as_str(), p.models_source.as_str(), p.efforts.len()), ("lixbon-cli", "profiles", 0));

    let sin_worker = providers::lixbon_cli(true, Some("2.3.0"), Some("lixbon: comando desconocido"), Some(PROFILES));
    assert!(!sin_worker.available);
    assert!(sin_worker.disabled_reason.unwrap().contains("lixbon update"));

    let ausente = providers::lixbon_cli(false, None, None, None);
    assert!(!ausente.available && ausente.models.is_empty() && ausente.models_source == "none");
    assert!(providers::IDS.contains(&"lixbon-cli"));
}

fn cli_cfg(role: &str, model: &str, effort: &str) -> BTreeMap<String, RoleCfg> {
    let mut cfg = roles::defaults();
    cfg.insert(role.into(), RoleCfg { provider: agents::LIXBON_CLI.into(), model: model.into(), effort: effort.into() });
    cfg
}

#[test]
fn un_rol_puede_usar_un_perfil_del_cli_sin_heredar_alias_de_claude() {
    let r = roles::resolve(&cli_cfg("explorador", "", ""), "explorador").unwrap();
    assert_eq!((r.provider.as_str(), r.model, r.effort), ("lixbon-cli", None, None));
    let r = roles::resolve(&cli_cfg("explorador", "qwen3:8b@ollama", ""), "explorador").unwrap();
    assert_eq!(r.model.as_deref(), Some("qwen3:8b@ollama"));
    let d = roles::describe(&cli_cfg("revisor", "qwen3:8b@ollama", ""));
    let rev = d["roles"].as_array().unwrap().iter().find(|x| x["id"] == "revisor").unwrap();
    assert_eq!((rev["agent"].as_str(), rev["model"].as_str()), (Some("lixbon-cli"), Some("qwen3:8b@ollama")));
}

#[test]
fn guardar_valida_el_lanzamiento_y_avisa_de_un_modelo_que_el_cli_no_lista() {
    let list = vec![providers::lixbon_cli(true, Some("2.3.0"), Some(WORKER_HELP), Some(r#"[{"name":"ollama","model":"qwen3:8b"}]"#))];
    let w = roles::validate_with(&cli_cfg("implementador", "qwen3:8b@ollama", ""), &list).unwrap();
    assert!(!w.contains_key("implementador"), "{w:?}");
    let w = roles::validate_with(&cli_cfg("implementador", "otro:1b@ollama", ""), &list).unwrap();
    assert_eq!(w["implementador"], vec![format!("{} (otro:1b@ollama)", agents::WARN_MODEL_UNVERIFIED)]);
    assert!(roles::validate_with(&cli_cfg("implementador", "qwen3:8b@ollama", "high"), &list).unwrap_err().contains("no admite --effort"));
    assert!(roles::validate_with(&cli_cfg("implementador", "x@y & del", ""), &list).is_err());
}

#[test]
fn el_argv_de_un_rol_de_solo_lectura_es_el_perfil_explorar() {
    let r = roles::resolve(&cli_cfg("explorador", "qwen3:8b@ollama", ""), "explorador").unwrap();
    let p = agents::evaluate_for(&r.provider, Profile::for_role(r.spec.read_only), Some("explorador"), "wt", Detected::Skip, false, Delivery::FileOrMarkers);
    assert_eq!(p.argv, ["lixbon", "worker", "--profile", "explorar"]);
    let l = agents::launch_with(&p, r.model.as_deref(), r.effort.as_deref(), "x").unwrap();
    assert!(l.command.contains("--provider ollama --model qwen3:8b"), "{}", l.command);
}

#[test]
fn which_nunca_devuelve_el_propio_ejecutable_de_lixbon() {
    use super::skill::which_in;
    let base = std::env::temp_dir().join(format!("lixbon-which-{}", std::process::id()));
    let (app, cli) = (base.join("app"), base.join("cli"));
    std::fs::create_dir_all(&app).unwrap();
    std::fs::create_dir_all(&cli).unwrap();
    let exe = if cfg!(windows) { "lixbon.exe" } else { "lixbon" };
    std::fs::write(app.join(exe), "desktop").unwrap();
    std::fs::write(cli.join(exe), "cli").unwrap();
    let me = app.join(exe).canonicalize().unwrap();
    let path = std::env::join_paths([&app, &cli]).unwrap();

    // El desktop va primero en el PATH, pero el agente es el CLI.
    assert_eq!(which_in("lixbon", &path, Some(&me)).unwrap(), cli.join(exe));
    // Sin saber quién es «yo», gana el primero (comportamiento de siempre).
    assert_eq!(which_in("lixbon", &path, None).unwrap(), app.join(exe));
    // Si solo está el propio ejecutable, no hay CLI.
    let solo = std::env::join_paths([&app]).unwrap();
    assert_eq!(which_in("lixbon", &solo, Some(&me)), None);
    // Cargo deja un enlace duro del ejecutable en otra carpeta del PATH: es la misma app.
    let deps = base.join("deps");
    std::fs::create_dir_all(&deps).unwrap();
    std::fs::hard_link(app.join(exe), deps.join(exe)).unwrap();
    let con_enlace = std::env::join_paths([&deps, &cli]).unwrap();
    assert_eq!(which_in("lixbon", &con_enlace, Some(&me)).unwrap(), cli.join(exe));
    let _ = std::fs::remove_dir_all(&base);
}
