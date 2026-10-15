//! Pruebas de la frontera de mutación (`mutation.rs`, C2a). Cada una usa su propia
//! carpeta de datos (hilo de prueba) y, cuando hace falta, una persistencia que
//! falla a voluntad.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::events::MutationContext;
use super::host::RecordingHost;
use super::lifecycle::BootProof;
use super::mutation::{Effect, Health, MutateError, PersistError, Persistence, RetryPolicy, StateAccess};
use super::state::{Kind, NewTask, State};
use super::{fsio, review, Core, Orch};
use crate::store::{new_uuid_v7, EventQuery};

static N: AtomicUsize = AtomicUsize::new(0);

/// Borra la carpeta de la prueba al salir (declararla ANTES que los Core).
struct Limpia(PathBuf);

impl Drop for Limpia {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `(limpieza, data, core)`: la carpeta de datos queda fijada para el hilo actual,
/// así que `mutate()` persiste ahí y no en la de otra prueba.
fn carpetas() -> (Limpia, PathBuf, PathBuf) {
    let n = N.fetch_add(1, Ordering::Relaxed);
    let base = std::env::temp_dir().join(format!("lixbon-mut-{}-{n}", std::process::id()));
    let (data, core) = (base.join("orch"), base.join("core"));
    std::fs::create_dir_all(&data).unwrap();
    fsio::set_test_data_dir(&data);
    (Limpia(base), data, core)
}

fn nt() -> NewTask {
    NewTask {
        agent: "coordinador".into(), model: None, effort: None, role: None, title: "t".into(), spec: "s".into(),
        repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: false,
    }
}

/// Persistencia que falla `quedan` veces (transitoria o estructural) y luego
/// funciona; anota los intentos y los documentos que sí persistió.
struct Falla {
    quedan: AtomicUsize,
    transitorio: bool,
    intentos: AtomicUsize,
    persistidos: Mutex<Vec<Value>>,
}

impl Falla {
    fn nueva(quedan: usize, transitorio: bool) -> Arc<Falla> {
        Arc::new(Falla { quedan: AtomicUsize::new(quedan), transitorio, intentos: AtomicUsize::new(0), persistidos: Mutex::new(vec![]) })
    }

    fn siempre(transitorio: bool) -> Arc<Falla> {
        Falla::nueva(usize::MAX / 2, transitorio)
    }

    fn intentos(&self) -> usize {
        self.intentos.load(Ordering::SeqCst)
    }
}

impl Persistence for Falla {
    fn persist(&self, state: &State, _events: &[crate::store::NewEvent]) -> Result<(), PersistError> {
        self.intentos.fetch_add(1, Ordering::SeqCst);
        if self.quedan.load(Ordering::SeqCst) > 0 {
            self.quedan.fetch_sub(1, Ordering::SeqCst);
            return Err(if self.transitorio { PersistError::transient("contención simulada") } else { PersistError::structural("disco simulado") });
        }
        self.persistidos.lock().unwrap().push(serde_json::to_value(state).unwrap());
        Ok(())
    }
}

fn core_con_host() -> (Arc<Core>, Arc<RecordingHost>) {
    let core = Orch::default().0;
    let host = RecordingHost::new();
    core.set_host(host.clone());
    core.set_retry_policy(RetryPolicy::with_backoffs(vec![Duration::from_millis(1); 3]));
    (core, host)
}

fn journal_v2(effect_id: &str, task: &str, run: &str, observed: Value) -> Value {
    serde_json::json!({
        "v": 2,
        "effect_id": effect_id,
        "at": 1_800_000_000_000_i64,
        "operation": "spawn",
        "kind": "pty_process",
        "task": task,
        "run": run,
        "project": null,
        "actor_kind": "system",
        "actor_id": null,
        "channel": "core",
        "observed": observed,
    })
}

fn eventos(core: &Core) -> Vec<crate::store::EventRow> {
    core.storage
        .with_store(|s| s.events_page(&EventQuery { limit: Some(500), ..Default::default() }).unwrap().events)
        .expect("almacén abierto")
}

fn estado(core: &Core) -> Value {
    serde_json::to_value(&*core.lock()).unwrap()
}

#[test]
fn mutate_persiste_en_state_json_actualiza_la_memoria_y_publica() {
    let (_l, data, _) = carpetas();
    let (core, host) = core_con_host();
    let (run, task) = core.mutate(|st| Ok(st.create_run("obj", nt()))).unwrap();
    assert!(core.lock().tasks.contains_key(&task) && core.lock().runs.contains_key(&run), "la memoria tiene la mutación");
    // state.json: los mismos bytes que escribía `commit()` (to_vec_pretty del State).
    let en_disco = std::fs::read(data.join("state.json")).unwrap();
    assert!(en_disco == serde_json::to_vec_pretty(&*core.lock()).unwrap(), "state.json es el estado en memoria, con el formato de siempre");
    assert_eq!(host.events_named("orch:changed").len(), 1);
    assert!(!data.join("state.tmp").exists());
}

#[test]
fn una_mutacion_rechazada_a_medias_no_cambia_nada() {
    let (_l, data, _) = carpetas();
    let (core, host) = core_con_host();
    let antes = estado(&core);
    let r: Result<(), MutateError> = core.mutate(|st| {
        st.create_run("obj", nt()); // muta...
        Err("precondición no cumplida".into()) // ...y falla después
    });
    assert_eq!(r, Err(MutateError::Rejected("precondición no cumplida".into())));
    assert_eq!(estado(&core), antes, "la memoria no conserva la mutación a medias");
    assert!(!data.join("state.json").exists(), "ni se escribió");
    assert!(host.events_named("orch:changed").is_empty());
    assert_eq!(core.health(), Health::Normal, "un rechazo no degrada el Core");
}

#[test]
fn una_mutacion_sin_cambios_no_persiste_ni_publica() {
    let (_l, data, _) = carpetas();
    let (core, host) = core_con_host();
    core.mutate(|st| {
        st.create_run("obj", nt());
        st.no_change();
        Ok(())
    })
    .unwrap();
    assert!(core.lock().tasks.is_empty());
    assert!(!data.join("state.json").exists());
    assert!(host.events_named("orch:changed").is_empty());
}

#[test]
fn si_la_persistencia_falla_la_memoria_no_se_adelanta_y_el_core_pasa_a_solo_lectura() {
    let (_l, _data, _) = carpetas();
    let (core, host) = core_con_host();
    let ok = Falla::nueva(0, false);
    core.set_persistence(ok.clone());
    let (_, task) = core.mutate(|st| Ok(st.create_run("obj", nt()))).unwrap();
    let confirmado = estado(&core);
    assert_eq!(ok.persistidos.lock().unwrap().last(), Some(&confirmado), "memoria == último documento confirmado");

    let rota = Falla::siempre(false);
    core.set_persistence(rota.clone());
    let r = core.mutate(|st| {
        st.add_child(&task, 2, nt())?;
        Ok(())
    });
    assert!(matches!(r, Err(MutateError::Persist(_))), "{r:?}");
    assert_eq!(estado(&core), confirmado, "la memoria sigue en el último estado confirmado");
    assert_eq!(rota.intentos(), 1, "un fallo estructural no se reintenta");
    assert!(matches!(core.health(), Health::DegradedReadOnly(_)));
    assert_eq!(host.events_named("orch:degraded").len(), 1, "se avisa a los clientes");

    // Solo lectura: las lecturas siguen, las mutaciones nuevas se rechazan sin tocar el disco.
    assert!(core.lock().tasks.contains_key(&task));
    let otra = core.mutate(|st| Ok(st.create_run("otro", nt())));
    assert!(matches!(otra, Err(MutateError::ReadOnly(_))), "{otra:?}");
    assert_eq!(rota.intentos(), 1, "en solo lectura ni siquiera se intenta persistir");
    assert_eq!(host.events_named("orch:degraded").len(), 1, "el aviso es único");
    let texto = String::from(otra.unwrap_err());
    assert!(texto.contains("solo lectura"), "{texto}");
}

#[test]
fn un_fallo_transitorio_se_reintenta_y_no_degrada() {
    let (_l, _data, _) = carpetas();
    let (core, host) = core_con_host();
    let f = Falla::nueva(2, true);
    core.set_persistence(f.clone());
    core.mutate(|st| Ok(st.create_run("obj", nt()))).expect("dos fallos transitorios y un éxito");
    assert_eq!(f.intentos(), 3);
    assert_eq!(core.health(), Health::Normal);
    assert_eq!(core.lock().runs.len(), 1);
    assert!(host.events_named("orch:degraded").is_empty());
}

#[test]
fn los_reintentos_son_limitados_y_despues_solo_lectura() {
    let (_l, _data, _) = carpetas();
    let (core, _host) = core_con_host();
    let f = Falla::siempre(true);
    core.set_persistence(f.clone());
    let r = core.mutate(|st| Ok(st.create_run("obj", nt())));
    assert!(matches!(r, Err(MutateError::Persist(_))));
    assert_eq!(f.intentos(), 1 + 3, "el intento inicial más tres reintentos, no infinitos");
    assert!(core.lock().runs.is_empty(), "la memoria no se adelantó");
    assert!(matches!(core.health(), Health::DegradedReadOnly(_)));
}

#[test]
fn mutate_locked_despierta_a_quien_espera_con_condvar() {
    let (_l, _data, _) = carpetas();
    let (core, _host) = core_con_host();
    let (root, child) = {
        let mut st = core.lock_unpersisted();
        let (_, root) = st.create_run("obj", nt());
        let child = st.add_child(&root, 2, nt()).unwrap();
        (root, child)
    };
    let waiter = {
        let (core, child) = (core.clone(), child.clone());
        std::thread::spawn(move || core.wait_for(&child, &[Kind::Note], None, Duration::from_secs(10)))
    };
    std::thread::sleep(Duration::from_millis(150));
    core.mutate(|st| {
        let id = st.post(&root, &child, Kind::Note, "hola", None)?;
        st.notify(&[id]);
        Ok(())
    })
    .unwrap();
    let found = waiter.join().unwrap();
    assert_eq!(found.len(), 1, "el que esperaba se despertó con el mensaje");
    assert!(core.lock().unread(&child, &[Kind::Note], None).is_empty(), "y quedó marcado como leído (mutate_locked)");
}

#[test]
fn un_efecto_externo_sin_registro_se_reconcilia_al_arrancar() {
    let (_l, data, core_dir) = carpetas();
    // Una tarea con rama real y una revisión aceptada, como en el flujo de integración.
    let (st, id, dir, _) = review::tests::setup("c2a-efecto");
    let (core, _host) = core_con_host();
    core.adopt_state(&BootProof::for_tests(), st.into_inner().unwrap());
    let head = {
        let o = std::process::Command::new("git").args(["rev-parse", "lx/t"]).current_dir(&dir).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    review::review_task(&core.acting(MutationContext::person(super::events::Channel::Ui)), &id, "accepted", &head, None, true).unwrap();

    // A partir de aquí no se puede persistir: el git merge ocurre, su registro falla.
    core.set_persistence(Falla::siempre(false));
    let err = core.integrate_from_ui(&id, true, false, None).unwrap_err();
    assert!(err.contains("NO quedó registrada"), "{err}");
    assert!(dir.join("b.txt").exists(), "el merge SÍ ocurrió en git");
    assert!(core.lock().decisions.iter().all(|d| d.kind != "merge"), "pero el estado no lo registró");
    assert!(matches!(core.health(), Health::DegradedReadOnly(_)));

    // Queda constancia para reconciliar...
    let diario = std::fs::read_to_string(data.join("unrecorded-effects.jsonl")).unwrap();
    let linea: Value = serde_json::from_str(diario.lines().next().unwrap()).unwrap();
    assert_eq!((linea["operation"].as_str(), linea["kind"].as_str(), linea["task"].as_str()), (Some("integrate"), Some("git_merge"), Some(id.as_str())));
    assert_eq!(linea["observed"]["outcome"], "merged");
    assert_eq!(linea["v"], 2);
    assert!(linea["at"].as_u64().is_some() && linea["effect_id"].as_str().is_some());
    assert!(linea["run"].as_str().is_some() && linea.get("project").is_some());
    assert!(linea.get("expected").is_none() && linea.get("error").is_none());
    assert!(linea.get("repo").is_none());
    let first_effect_id = linea["effect_id"].as_str().unwrap().to_owned();
    assert_eq!(Core::unrecorded_effects(&data).unwrap(), 1);
    // Ya en solo lectura (`ReadOnly`): otro efecto ocurrido tampoco se pierde, aunque la mutación ni se intente.
    let otro = Effect::new("spawn", "pty_process").task(&id).observed(serde_json::json!({ "launched": true }));
    let second_effect_id = otro.effect_id().to_owned();
    let r = core.acting(MutationContext::core()).mutate_after_effect(otro, |_| Ok(()));
    assert!(matches!(&r, Err(m) if m.contains("NO quedó registrada")), "{r:?}");
    assert_eq!(Core::unrecorded_effects(&data).unwrap(), 2);

    // El journal conserva CUÁNDO ocurrió cada efecto: se retrasa para distinguirlo de la hora de la recuperación.
    let (first_at, second_at) = (1_700_000_000_000_i64, 1_700_000_005_000_i64);
    let atrasado = std::fs::read_to_string(data.join("unrecorded-effects.jsonl")).unwrap().lines().zip([first_at, second_at])
        .map(|(l, at)| { let mut v: Value = serde_json::from_str(l).unwrap(); v["at"] = at.into(); format!("{v}
") }).collect::<String>();
    std::fs::write(data.join("unrecorded-effects.jsonl"), atrasado).unwrap();

    // ...y la promoción al Event Log reconcilia los dos hechos sin repetir los efectos externos.
    let otro = Orch::default().0;
    let host = RecordingHost::new();
    otro.init_in(host.clone(), &data, &core_dir).unwrap();
    assert_eq!(Core::unrecorded_effects(&data).unwrap(), 0);
    let recovered = eventos(&otro).into_iter().filter(|event| event.kind == "effect.observed").collect::<Vec<_>>();
    assert_eq!(recovered.len(), 2);
    let con_id = |id: &str| recovered.iter().find(|event| event.idem_key.as_deref() == Some(id)).unwrap();
    assert_eq!(con_id(&first_effect_id).at, first_at, "el Event conserva la hora original del efecto");
    assert_eq!(con_id(&second_effect_id).at, second_at);

    // La reconciliación demuestra el efecto, pero NO repara el estado: la persona recibe un aviso accionable.
    assert!(otro.lock().decisions.iter().all(|d| d.kind != "merge"), "el estado legacy no se repara");
    let avisos = host.notifications();
    assert!(!avisos.iter().any(|(t, _)| t == "Lixbon: acciones sin registrar"), "no queda nada pendiente de revisión: {avisos:?}");
    let (_, cuerpo) = avisos.iter().find(|(t, _)| t == "Lixbon: acciones recuperadas, estado sin reparar").unwrap_or_else(|| panic!("falta el aviso de recuperación: {avisos:?}"));
    for esperado in ["2 acción(es)", "NO ha reparado el estado", "integrate/git_merge", "spawn/pty_process", id.as_str(), "antes de repetirlas"] {
        assert!(cuerpo.contains(esperado), "el aviso debe contener {esperado:?}: {cuerpo}");
    }
    for secreto in ["merged", "lx/t", data.to_str().unwrap()] {
        assert!(!cuerpo.contains(secreto), "el aviso no filtra datos del efecto: {cuerpo}");
    }
}

#[test]
fn un_rechazo_tras_el_efecto_tambien_se_anota_porque_el_efecto_ya_ocurrio() {
    let (_l, data, _) = carpetas();
    let (core, _host) = core_con_host();
    // Entrar en `mutate_after_effect` significa que el efecto ocurrió: aunque el registro lo rechace el
    // propio cierre (la tarea no existe), queda un efecto sin registrar. «No hubo efecto» = no llamarla.
    let r: Result<(), String> = core.acting(MutationContext::core()).mutate_after_effect(Effect::new("prueba", "ninguno"), |st| {
        st.task_mut("t-no-existe")?;
        Ok(())
    });
    assert!(matches!(&r, Err(m) if m.contains("NO quedó registrada")), "{r:?}");
    assert_eq!(Core::unrecorded_effects(&data).unwrap(), 1);
    // Un rechazo no degrada el almacenamiento: sigue siendo normal.
    assert_eq!(core.health(), Health::Normal);
}

#[test]
fn journal_v2_conserva_identidad_y_filtra_datos_sensibles_del_efecto() {
    let (_l, data, _) = carpetas();
    let (core, _host) = core_con_host();
    let (run, task) = core.lock_unpersisted().create_run("obj", nt());
    let effect = Effect::new("publish_pr", "git_push_pr")
        .task(&task)
        .expected(serde_json::json!({ "diff": "SENTINEL_EXPECTED" }))
        .observed(serde_json::json!({
            "outcome": "created",
            "branch": "lx/safe",
            "pr_url": "https://user:SENTINEL_CREDENTIAL@github.com/org/repo/pull/1?token=SENTINEL_QUERY",
            "argv": ["SENTINEL_ARGV"],
            "env": { "TOKEN": "SENTINEL_ENV" },
            "diff": "SENTINEL_DIFF",
            "body": "SENTINEL_BODY",
        }));
    let effect_id = effect.effect_id().to_owned();
    let result: Result<(), String> = core.acting(MutationContext::person(super::events::Channel::Ui)).mutate_after_effect(effect, |_| {
        Err("SENTINEL_ERROR_TEXT".into())
    });
    let error = result.unwrap_err();
    assert!(error.contains("SENTINEL_ERROR_TEXT") && error.contains("Queda anotada en unrecorded-effects.jsonl"), "{error}");
    assert!(error.contains("el estado NO se repara"), "el mensaje avisa de que la reconciliación no repara el estado: {error}");

    let journal = std::fs::read_to_string(data.join("unrecorded-effects.jsonl")).unwrap();
    let record: Value = serde_json::from_str(journal.lines().next().unwrap()).unwrap();
    assert_eq!(record["effect_id"], effect_id);
    assert_eq!(record["v"], 2);
    assert_eq!(record["operation"], "publish_pr");
    assert_eq!(record["kind"], "git_push_pr");
    assert_eq!(record["task"], task);
    assert_eq!(record["run"], run);
    assert_eq!(record["actor_kind"], "person");
    assert_eq!(record["channel"], "ui");
    assert_eq!(record["observed"]["outcome"], "created");
    assert_eq!(record["observed"]["branch"], "lx/safe");
    assert_eq!(record["observed"]["pr_url"], "https://github.com/org/repo/pull/1");
    for secret in [
        "SENTINEL_EXPECTED",
        "SENTINEL_CREDENTIAL",
        "SENTINEL_QUERY",
        "SENTINEL_ARGV",
        "SENTINEL_ENV",
        "SENTINEL_DIFF",
        "SENTINEL_BODY",
        "SENTINEL_ERROR_TEXT",
    ] {
        assert!(!journal.contains(secret), "el journal filtró {secret}: {journal}");
    }
}

#[test]
fn restart_reconcilia_v2_por_effect_id_sin_repetir_efecto_y_conserva_v1() {
    let (_l, data, core_dir) = carpetas();
    let seed = Orch::default().0;
    let (run, task) = seed.lock_unpersisted().create_run("obj", nt());
    fsio::write_json(&data.join("state.json"), &*seed.lock()).unwrap();
    drop(seed);

    let effect_id = new_uuid_v7();
    let record = journal_v2(&effect_id, &task, &run, serde_json::json!({ "launched": true }));
    let line = serde_json::to_string(&record).unwrap();
    let v1 = r#"{"v":1,"operation":"manual","kind":"legacy","observed":{"outcome":"merged"},"error":"legacy diagnostic"}"#;
    std::fs::write(data.join("unrecorded-effects.jsonl"), format!("{v1}\n{line}\n{line}\n")).unwrap();

    let (core, host, result) = super::boot_tests::arranca(&data, &core_dir);
    result.unwrap();
    let matching = eventos(&core).into_iter().filter(|event| event.kind == "effect.observed" && event.idem_key.as_deref() == Some(&effect_id)).collect::<Vec<_>>();
    assert_eq!(matching.len(), 1, "dos copias del mismo v2 producen un Event");
    let event = &matching[0];
    assert_eq!(event.correlation_id.as_deref(), Some(effect_id.as_str()));
    assert_eq!(event.idem_key.as_deref(), Some(effect_id.as_str()));
    assert_eq!(serde_json::from_str::<Value>(&event.payload).unwrap()["effect_id"], effect_id);
    assert_eq!(event.actor_kind.as_str(), "system");
    assert_eq!(event.channel.as_deref(), Some("core"));
    assert!(event.state_rev.is_none(), "la reconciliación solo agrega el hecho, sin mutar legacy_state");
    assert_eq!(event.at, 1_800_000_000_000, "conserva la hora del journal, no la del arranque");
    let correlated = eventos(&core).into_iter().filter(|e| e.correlation_id.as_deref() == Some(effect_id.as_str())).count();
    assert_eq!(correlated, 1, "la recuperación solo añade el hecho del efecto: ninguna decisión ni transición de estado");
    let avisos = host.notifications();
    assert!(avisos.iter().any(|(title, _)| title == "Lixbon: acciones sin registrar"), "el v1 sigue como diagnóstico manual: {avisos:?}");
    assert!(avisos.iter().any(|(title, body)| title == "Lixbon: acciones recuperadas, estado sin reparar" && body.contains("1 acción(es)")), "{avisos:?}");
    assert_eq!(std::fs::read_to_string(data.join("unrecorded-effects.jsonl")).unwrap(), format!("{v1}\n"), "v1 permanece para revisión manual y los v2 confirmados se compactan");

    // Simula una caída después del commit SQLite pero antes del ACK durable (compactación).
    // Al reintentar tras reiniciar, la clave (effect.observed, effect_id) debe deduplicar el Event.
    std::fs::write(data.join("unrecorded-effects.jsonl"), format!("{line}\n")).unwrap();
    super::boot_tests::suelta(core, &core_dir);
    let (restarted, _host, result) = super::boot_tests::arranca(&data, &core_dir);
    result.unwrap();
    let repeated = eventos(&restarted).into_iter().filter(|event| event.kind == "effect.observed" && event.idem_key.as_deref() == Some(&effect_id)).collect::<Vec<_>>();
    assert_eq!(repeated.len(), 1, "el replay tras commit y antes de ACK no duplica");
    assert_eq!(repeated[0].id, event.id, "el evento confirmado original se conserva");
    assert_eq!(Core::unrecorded_effects(&data).unwrap(), 0, "el v2 repetido queda acknowledged por compactación");
    super::boot_tests::suelta(restarted, &core_dir);
}

#[test]
fn v2_truncado_o_corrupto_no_impide_reconciliar_lineas_validas_posteriores() {
    let (_l, data, core_dir) = carpetas();
    let seed = Orch::default().0;
    let (run, task) = seed.lock_unpersisted().create_run("obj", nt());
    fsio::write_json(&data.join("state.json"), &*seed.lock()).unwrap();
    drop(seed);

    let effect_id = new_uuid_v7();
    let record = journal_v2(&effect_id, &task, &run, serde_json::json!({ "launched": true }));
    let line = serde_json::to_string(&record).unwrap();
    let v1 = r#"{"v":1,"operation":"manual","kind":"legacy"}"#;
    let corrupt = r#"{"v":2,"effect_id":"truncated""#;
    std::fs::write(data.join("unrecorded-effects.jsonl"), format!("{v1}\n{corrupt}\n{line}\n")).unwrap();

    let (core, _host, result) = super::boot_tests::arranca(&data, &core_dir);
    result.unwrap();
    let matching = eventos(&core).into_iter().filter(|event| event.kind == "effect.observed" && event.idem_key.as_deref() == Some(&effect_id)).count();
    assert_eq!(matching, 1, "la línea válida posterior se recupera pese a v1 y JSON truncado previos");
    assert_eq!(std::fs::read_to_string(data.join("unrecorded-effects.jsonl")).unwrap(), format!("{v1}\n{corrupt}\n"), "la compactación conserva diagnósticos v1/corruptos");
    assert_eq!(Core::unrecorded_effects(&data).unwrap(), 2);
    super::boot_tests::suelta(core, &core_dir);
}

#[test]
fn journal_ilegible_se_reporta_sin_inventar_un_conteo_de_efectos() {
    let (_l, data, core_dir) = carpetas();
    std::fs::create_dir(data.join("unrecorded-effects.jsonl")).unwrap();

    let (core, host, result) = super::boot_tests::arranca(&data, &core_dir);
    result.unwrap();
    assert!(host.notifications().iter().any(|(title, _)| title == "Lixbon: journal de efectos no disponible"), "se comunica que no se pudo leer el journal: {:?}", host.notifications());
    assert!(!host.notifications().iter().any(|(title, _)| title == "Lixbon: acciones sin registrar"), "no se presenta como conteo exacto: {:?}", host.notifications());
    super::boot_tests::suelta(core, &core_dir);
}

fn v2_con(effect_id: &str, task: &str, run: &str, (operation, kind): (&str, &str), (actor_kind, actor_id, channel): (&str, Option<&str>, &str), observed: Value) -> Value {
    serde_json::json!({
        "v": 2, "effect_id": effect_id, "at": 1_800_000_000_000_i64, "operation": operation, "kind": kind,
        "task": task, "run": run, "project": null, "actor_kind": actor_kind, "actor_id": actor_id, "channel": channel,
        "observed": observed,
    })
}

fn siembra_estado(data: &std::path::Path) -> (String, String) {
    let seed = Orch::default().0;
    let (run, task) = seed.lock_unpersisted().create_run("obj", nt());
    fsio::write_json(&data.join("state.json"), &*seed.lock()).unwrap();
    (run, task)
}

fn escribe_journal(data: &std::path::Path, lineas: &[String]) {
    std::fs::write(data.join("unrecorded-effects.jsonl"), lineas.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
}

fn evento_de<'a>(eventos: &'a [crate::store::EventRow], effect_id: &str) -> Option<&'a crate::store::EventRow> {
    eventos.iter().find(|e| e.kind == "effect.observed" && e.idem_key.as_deref() == Some(effect_id))
}

#[test]
fn la_recuperacion_conserva_actor_y_canal_de_person_ui_y_agent_lxo() {
    let (_l, data, core_dir) = carpetas();
    let (run, task) = siembra_estado(&data);
    let (persona, agente) = (new_uuid_v7(), new_uuid_v7());
    let merge = serde_json::json!({ "outcome": "merged", "branch": "lx/t" });
    escribe_journal(&data, &[
        v2_con(&persona, &task, &run, ("integrate", "git_merge"), ("person", None, "ui"), merge).to_string(),
        v2_con(&agente, &task, &run, ("spawn", "pty_process"), ("agent", Some(&task), "lxo"), serde_json::json!({ "launched": true })).to_string(),
    ]);

    let (core, _host, result) = super::boot_tests::arranca(&data, &core_dir);
    result.unwrap();

    let todos = eventos(&core);
    let persona = evento_de(&todos, &persona).expect("efecto de la persona");
    assert_eq!((persona.actor_kind.as_str(), persona.actor_id.as_deref(), persona.channel.as_deref()), ("person", None, Some("ui")));
    let agente = evento_de(&todos, &agente).expect("efecto del agente");
    assert_eq!((agente.actor_kind.as_str(), agente.actor_id.as_deref(), agente.channel.as_deref()), ("agent", Some(task.as_str()), Some("lxo")));
    assert_eq!(Core::unrecorded_effects(&data).unwrap(), 0);
    super::boot_tests::suelta(core, &core_dir);
}

#[test]
fn identidad_invalida_actor_incoherente_e_ids_conflictivos_quedan_para_revision_manual() {
    let (_l, data, core_dir) = carpetas();
    let (run, task) = siembra_estado(&data);
    let spawn = ("spawn", "pty_process");
    let launched = serde_json::json!({ "launched": true });
    let (v4, mayusculas, conflicto, sana) = (crate::store::new_uuid(), new_uuid_v7().to_uppercase(), new_uuid_v7(), new_uuid_v7());
    let mut otra_observacion = v2_con(&conflicto, &task, &run, spawn, ("system", None, "core"), launched.clone());
    otra_observacion["observed"] = serde_json::json!({ "launched": false });
    let lineas = [
        v2_con(&v4, &task, &run, spawn, ("system", None, "core"), launched.clone()),
        v2_con(&mayusculas, &task, &run, spawn, ("system", None, "core"), launched.clone()),
        v2_con(&new_uuid_v7(), &task, &run, spawn, ("agent", None, "lxo"), launched.clone()),
        v2_con(&new_uuid_v7(), &task, &run, spawn, ("system", None, "web"), launched.clone()),
        v2_con(&conflicto, &task, &run, spawn, ("system", None, "core"), launched.clone()),
        otra_observacion,
        v2_con(&sana, &task, &run, spawn, ("system", None, "core"), launched),
    ].map(|v| v.to_string());
    escribe_journal(&data, &lineas);

    let (core, host, result) = super::boot_tests::arranca(&data, &core_dir);
    result.unwrap();

    let todos = eventos(&core);
    assert_eq!(todos.iter().filter(|e| e.kind == "effect.observed").count(), 1, "solo la línea sana entra al Event Log");
    assert!(evento_de(&todos, &sana).is_some());
    let esperadas = lineas[..6].iter().map(|l| format!("{l}\n")).collect::<String>();
    assert_eq!(std::fs::read_to_string(data.join("unrecorded-effects.jsonl")).unwrap(), esperadas, "lo no importable se conserva intacto, también los conflictivos");
    assert!(host.notifications().iter().any(|(t, b)| t == "Lixbon: acciones sin registrar" && b.starts_with("6 acción(es)")), "{:?}", host.notifications());
    super::boot_tests::suelta(core, &core_dir);
}

#[test]
fn el_replay_sanea_pr_url_con_las_mismas_reglas_que_el_camino_normal() {
    let (_l, data, core_dir) = carpetas();
    let (run, task) = siembra_estado(&data);
    let casos = [
        ("https://user:SECRETO@github.com/o/r/pull/1?token=SECRETO#SECRETO", Some("https://github.com/o/r/pull/1")),
        ("https://user:pa/ss@github.com/o/r/pull/1", None),
        ("https://github.com/o/r/pull/1;secreto=SECRETO", None),
        ("javascript://github.com/o/r/pull/1", None),
    ];
    let ids = casos.map(|_| new_uuid_v7());
    let lineas = casos.iter().zip(&ids).map(|((url, _), id)| {
        let observed = serde_json::json!({ "outcome": "created", "branch": "lx/t", "pr_url": url });
        v2_con(id, &task, &run, ("publish_pr", "git_push_pr"), ("system", None, "core"), observed).to_string()
    }).collect::<Vec<_>>();
    escribe_journal(&data, &lineas);

    let (core, _host, result) = super::boot_tests::arranca(&data, &core_dir);
    result.unwrap();

    let todos = eventos(&core);
    for ((url, esperada), id) in casos.iter().zip(&ids) {
        let evento = evento_de(&todos, id).unwrap_or_else(|| panic!("falta el evento de {url}"));
        let payload: Value = serde_json::from_str(&evento.payload).unwrap();
        assert_eq!(payload["pr_url"].as_str(), *esperada, "{url}");
        assert!(!payload.to_string().contains("SECRETO") && !payload.to_string().contains("pa/ss"), "{payload}");
    }
    super::boot_tests::suelta(core, &core_dir);
}

#[test]
fn el_journal_v2_en_modo_legacy_se_conserva_sin_reconciliar() {
    let (_l, data, _) = carpetas();
    let (run, task) = siembra_estado(&data);
    let linea = journal_v2(&new_uuid_v7(), &task, &run, serde_json::json!({ "launched": true })).to_string();
    escribe_journal(&data, std::slice::from_ref(&linea));
    let core = Orch::default().0;

    let report = core.reconcile_unrecorded_effects(&data).unwrap();

    assert_eq!((report.recovered, report.pending), (0, 1));
    assert_eq!(std::fs::read_to_string(data.join("unrecorded-effects.jsonl")).unwrap(), format!("{linea}\n"));
}

#[test]
fn si_falla_anotar_el_journal_el_error_lo_dice_y_no_afirma_que_quedo_anotado() {
    let (_l, data, _) = carpetas();
    std::fs::create_dir(data.join("unrecorded-effects.jsonl")).unwrap();
    let (core, _host) = core_con_host();
    let (_run, task) = core.lock_unpersisted().create_run("obj", nt());
    let effect = Effect::new("spawn", "pty_process").task(&task).observed(serde_json::json!({ "launched": true }));
    let effect_id = effect.effect_id().to_owned();

    let result: Result<(), String> = core.acting(MutationContext::core()).mutate_after_effect(effect, |_| Err("rechazo del registro".into()));

    let error = result.unwrap_err();
    assert!(error.contains("NO quedó registrada") && error.contains("TAMPOCO se pudo anotar"), "{error}");
    assert!(error.contains(&effect_id), "el error da la identidad para comprobarlo a mano: {error}");
    assert!(!error.contains("Queda anotada"), "no afirma una anotación que no existe: {error}");
    assert!(error.contains("no la repitas sin comprobarlo"), "{error}");
}

/// Garantía contra escrituras futuras fuera de la frontera: además de que el
/// compilador no deja escribir (el `Mutex<State>` es privado a `mutation.rs` y
/// `Core::lock()` solo lee), el código de producción no puede nombrar los accesos
/// de escritura ni reintroducir `commit()`.
#[test]
fn la_escritura_del_estado_solo_ocurre_en_mutation_rs() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    let mut revisados = 0;
    for entrada in std::fs::read_dir(&dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") || nombre == "mutation.rs" {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        // Lo que sigue a `mod tests {` es código de pruebas, que sí puede preparar estados.
        let produccion = texto.split("mod tests {").next().unwrap();
        for (n, linea) in produccion.lines().enumerate() {
            let l = linea.trim_start();
            if l.starts_with("//") {
                continue;
            }
            // `lock_unpersisted` y `state_is_free` son accesos de prueba (`#[cfg(test)]`).
            for (prohibido, motivo, solo_en) in [
                ("Mutex<State>", "el estado se toca por `StateAccess`, no por su Mutex", ""),
                ("StateCell", "la celda del estado es privada de mutation.rs", "mod.rs"),
                (".commit(", "`commit()` ya no existe: usa `Core::mutate`", ""),
                ("self.state.", "el estado se lee con `lock()` y se escribe con `mutate()`", ""),
                ("core.state.", "el estado se lee con `lock()` y se escribe con `mutate()`", ""),
            ] {
                if nombre == solo_en {
                    continue;
                }
                assert!(!l.contains(prohibido), "{nombre}:{}: {motivo} ({prohibido})", n + 1);
            }
        }
        // `adopt_state` (carga inicial) solo en el arranque; `touch_activity` (latido) solo en el despacho.
        if nombre != "lifecycle.rs" {
            assert!(!produccion.contains("adopt_state("), "{nombre}: adopt_state solo se usa en lifecycle.rs");
        }
        if nombre != "rpc.rs" {
            assert!(!produccion.contains("touch_activity("), "{nombre}: touch_activity solo se usa en rpc.rs");
        }
        revisados += 1;
    }
    assert!(revisados >= 20, "la prueba debe revisar los módulos del dominio, revisó {revisados}");
}

#[test]
fn la_politica_de_reintentos_esta_en_un_solo_sitio() {
    let p = RetryPolicy::default();
    let transitorio = PersistError::transient("busy");
    let estructural = PersistError::structural("esquema incompatible");
    // 50 / 150 / 500 ms y luego se rinde; lo estructural nunca se reintenta.
    let esperas: Vec<_> = (0..4).map(|i| p.delay_for(&transitorio, i)).collect();
    assert_eq!(esperas, vec![Some(Duration::from_millis(50)), Some(Duration::from_millis(150)), Some(Duration::from_millis(500)), None]);
    assert_eq!(p.delay_for(&estructural, 0), None);
    assert_eq!(RetryPolicy::none().delay_for(&transitorio, 0), None);
}

/// C2b: el almacén queda DETRÁS de la frontera de mutación. Ningún módulo de dominio
/// toca el `Store`, la valla, la promoción ni Win32: cada símbolo solo puede aparecer
/// en los archivos que lo poseen. Un uso nuevo fuera de la lista rompe esta prueba.
#[test]
fn el_almacen_la_promocion_y_win32_solo_se_tocan_desde_su_frontera() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    // (símbolo, archivos donde puede aparecer)
    let permitidos: [(&str, &[&str]); 16] = [
        ("with_store(", &["store_boot.rs", "boot_authority.rs", "projects.rs"]),
        ("save_legacy_state", &["store_boot.rs"]),
        ("commit_authoritative", &["store_boot.rs"]),
        ("promote_to_authoritative", &["boot_authority.rs"]),
        ("apply_fence", &["boot_authority.rs"]),
        ("migrate_authoritative(", &["store_boot.rs", "boot_authority.rs"]),
        ("apply_post_fence_migrations(", &["boot_authority.rs"]),
        ("ensure_db_id", &["boot_authority.rs"]),
        ("open_for_boot", &["store_boot.rs", "boot_authority.rs"]),
        ("verify_backup", &["boot_authority.rs"]),
        ("write_marker(", &["authority.rs", "boot_authority.rs"]),
        ("install_persistence(", &["mutation.rs", "lifecycle.rs"]),
        ("mirror_failed_at_boot(", &["mutation.rs", "lifecycle.rs"]),
        ("windows_sys", &["fsio.rs"]),
        ("MoveFileExW", &["fsio.rs"]),
        ("publish_durable(", &["fsio.rs", "authority.rs", "mirror.rs"]),
    ];
    let mut revisados = 0;
    for entrada in std::fs::read_dir(&dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        let produccion = texto.split("mod tests {").next().unwrap().split("mod durable_tests {").next().unwrap();
        for (n, linea) in produccion.lines().enumerate() {
            let l = linea.trim_start();
            if l.starts_with("//") {
                continue;
            }
            for (simbolo, donde) in permitidos {
                assert!(
                    !l.contains(simbolo) || donde.contains(&nombre.as_str()),
                    "{nombre}:{}: «{simbolo}» solo puede usarse en {donde:?}: el almacén y la promoción van detrás de la frontera de mutación",
                    n + 1
                );
            }
        }
        revisados += 1;
    }
    assert!(revisados >= 20, "la prueba debe revisar los módulos del dominio, revisó {revisados}");
}
