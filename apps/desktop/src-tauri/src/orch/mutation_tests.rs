//! Pruebas de la frontera de mutación (`mutation.rs`, C2a). Cada una usa su propia
//! carpeta de datos (hilo de prueba) y, cuando hace falta, una persistencia que
//! falla a voluntad.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::host::RecordingHost;
use super::lifecycle::BootProof;
use super::mutation::{Effect, Health, MutateError, PersistError, Persistence, RetryPolicy, StateAccess};
use super::state::{Kind, NewTask, State};
use super::{fsio, review, Core, Orch};

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
    fn persist(&self, state: &State) -> Result<(), PersistError> {
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
fn un_efecto_externo_sin_registro_se_anota_se_avisa_y_se_ve_al_arrancar() {
    let (_l, data, core_dir) = carpetas();
    // Una tarea con rama real y una revisión aceptada, como en el flujo de integración.
    let (st, id, dir, _) = review::tests::setup("c2a-efecto");
    let (core, _host) = core_con_host();
    core.adopt_state(&BootProof::for_tests(), st.into_inner().unwrap());
    let head = {
        let o = std::process::Command::new("git").args(["rev-parse", "lx/t"]).current_dir(&dir).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    review::review_task(&*core, &id, "accepted", &head, None, true).unwrap();

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
    assert_eq!(linea["expected"]["merged"], true);
    // Diagnóstico completo: cuándo, dónde, de qué run y por qué falló el registro.
    assert!(linea["at"].as_u64().is_some() && linea["v"] == 1);
    assert!(linea["repo"].as_str().is_some_and(|r| !r.is_empty()) && linea["run"].as_str().is_some());
    assert!(linea["error"].as_str().is_some_and(|e| !e.is_empty()));
    assert_eq!(Core::unrecorded_effects(&data), 1);

    // ...y el siguiente arranque lo avisa en vez de esconderlo.
    let otro = Orch::default().0;
    let host = RecordingHost::new();
    otro.init_in(host.clone(), &data, &core_dir).unwrap();
    assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon: acciones sin registrar"), "{:?}", host.notifications());
}

#[test]
fn un_rechazo_tras_el_efecto_no_se_confunde_con_un_efecto_sin_registrar() {
    let (_l, data, _) = carpetas();
    let (core, _host) = core_con_host();
    // La mutación se rechaza por sí misma (la tarea no existe): no hay nada que reconciliar.
    let r: Result<(), String> = core.mutate_after_effect(Effect::new("prueba", "ninguno"), |st| {
        st.task_mut("t-no-existe")?;
        Ok(())
    });
    assert!(r.is_err());
    assert_eq!(Core::unrecorded_effects(&data), 0);
    assert_eq!(core.health(), Health::Normal);
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
        ("with_store(", &["store_boot.rs", "boot_authority.rs"]),
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
